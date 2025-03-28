import * as lsp from "vscode-languageserver/node";
import {TokenObject} from "../compiler_tokenizer/tokenObject";
import {NodeScript} from "../compiler_parser/nodes";
import {DelayedTask} from "../utils/delayedTask";
import {PublishDiagnosticsParams} from "vscode-languageserver-protocol";
import {getGlobalSettings} from "../core/settings";
import {PreprocessedOutput} from "../compiler_parser/parserPreprocess";
import {getParentDirectoryList, readFileContent, resolveUri} from "./fileUtils";
import {diagnostic} from "../core/diagnostic";
import {analyzerDiagnostic} from "../compiler_analyzer/analyzerDiagnostic";
import {Profiler} from "../core/profiler";
import {hoistAfterParsed} from "../compiler_analyzer/hoist";
import {analyzeAfterHoisted} from "../compiler_analyzer/analyzer";
import {logger} from "../core/logger";
import {inspectFile} from "./inspector";
import {fileURLToPath} from "node:url";
import * as fs from "fs";
import {AnalyzerScope, createGlobalScope} from "../compiler_analyzer/analyzerScope";
import {AnalysisQueue} from "./analysisQueue";

interface PartialInspectRecord {
    uri: string;
    isOpen: boolean;
    diagnosticsInParser: lsp.Diagnostic[];
    diagnosticsInAnalyzer: lsp.Diagnostic[];
    rawTokens: TokenObject[];
    preprocessedOutput: PreprocessedOutput;
    ast: NodeScript;
    analyzerTask: DelayedTask;
    analyzerScope: AnalyzerScope;
}

export type DiagnosticsCallback = (params: PublishDiagnosticsParams) => void;

const predefinedFileName = 'as.predefined';

const profilerDescriptionLength = 12;

const mediumWaitTime = 500; // ms

const shortWaitTime = 100; // ms

const veryShortWaitTime = 10; // ms

export class AnalysisResolver {
    private readonly _analyzerTask: DelayedTask = new DelayedTask();

    private readonly _analysisQueue: AnalysisQueue<PartialInspectRecord> = new AnalysisQueue();

    private readonly _resolvedPredefinedFilepaths: Set<string> = new Set();

    public constructor(
        public readonly recordList: Map<string, PartialInspectRecord>,
        private readonly diagnosticsCallback: DiagnosticsCallback,
    ) {
    }

    /**
     * Request to analyze the file specified by the URI at a later time.
     */
    public request(record: PartialInspectRecord) {
        this._analysisQueue.pushDirect({record: record!, shouldReanalyze: true});

        this.rescheduleAnalyze();
    }

    private rescheduleAnalyze() {
        let waitTime;
        if (this._analysisQueue.hasDirect()) {
            waitTime = veryShortWaitTime;
        } else if (this._analysisQueue.hasIndirect()) {
            waitTime = shortWaitTime;
        } else if (this._analysisQueue.hasLazyIndirect()) {
            waitTime = mediumWaitTime;
        } else {
            return;
        }

        this._analyzerTask.reschedule(() => {
            this.handleAnalyze();
        }, waitTime);
    }

    // Pop and analyze the file in the queue
    private popAndAnalyze() {
        const element = this._analysisQueue.frontPop();
        if (element === undefined) return;

        this.analyzeFile(element.record);

        if (element.shouldReanalyze) {
            this.reanalyzeFilesWithDependency(element.record.uri);
        }
    }

    /**
     * Processes any queued files for analysis immediately if they exist.
     */
    public flush(uri: string | undefined) {
        // Analyze until the direct queue is empty
        while (this._analysisQueue.hasDirect()) {
            this.popAndAnalyze();
        }

        if (uri === undefined) {
            // If the uri is not specified, reanalyze all files in the reanalysis queue
            while (this._analysisQueue.hasIndirect() && this._analysisQueue.hasLazyIndirect()) {
                this.popAndAnalyze();
            }
        } else if (this._analysisQueue.isInQueue(uri)) {
            // If the file is in the reanalysis queue, move it to the front of the direct queue and reanalyze it.
            const frontRecord = this.recordList.get(uri);
            if (frontRecord === undefined) return;

            this._analysisQueue.frontPushDirect({record: frontRecord, shouldReanalyze: false});

            this.popAndAnalyze();
        }
    }

    private handleAnalyze() {
        // Analyze the file in the queue
        this.popAndAnalyze();

        this.rescheduleAnalyze();
    }

    private analyzeFile(record: PartialInspectRecord) {
        const predefinedUri = this.findPredefinedUri(record.uri);

        logger.message(`[Analyzer]\n${record.uri}`);

        // Collect scopes in included files
        const includeScopes = this.collectIncludeScope(record, predefinedUri);

        // -----------------------------------------------
        analyzerDiagnostic.reset();

        const profiler = new Profiler();

        // Execute the hoist
        const hoistResult = hoistAfterParsed(record.ast, createGlobalScope(record.uri, includeScopes));
        profiler.mark('Hoist'.padEnd(profilerDescriptionLength));

        // Execute the analyzer
        record.analyzerScope = analyzeAfterHoisted(record.uri, hoistResult);
        profiler.mark('Analyzer'.padEnd(profilerDescriptionLength));

        record.diagnosticsInAnalyzer = analyzerDiagnostic.flush();
        // -----------------------------------------------

        this.diagnosticsCallback({
            uri: record.uri,
            diagnostics: [...record.diagnosticsInParser, ...record.diagnosticsInAnalyzer]
        });

        logger.message(`(${process.memoryUsage().heapUsed / 1024 / 1024} MB used)`);
    }

    // We will reanalyze the files that include the file specified by the given URI.
    private reanalyzeFilesWithDependency(targetUri: string) {
        const dependedFiles = Array.from(this.recordList.values()).filter(r =>
            this.resolveIncludePaths(r, this.findPredefinedUri(r.uri))
                .some(relativePath => resolveUri(r.uri, relativePath) === targetUri));

        for (const dependedFile of dependedFiles) {
            if (dependedFile.isOpen) {
                this._analysisQueue.pushIndirect({record: dependedFile});
            } else {
                this._analysisQueue.pushLazyIndirect({record: dependedFile});
            }
        }
    }

    private resolveIncludePaths(record: PartialInspectRecord, predefinedUri: string | undefined): string[] {
        // Add include paths from include directives
        let includePaths =
            record.preprocessedOutput.includePathTokens.map(token => token.getStringContent());

        if (getGlobalSettings().implicitMutualInclusion) {
            // If implicit mutual inclusion is enabled, include all files under the directory where 'as.predefined' is located.
            if (record.uri.endsWith(predefinedFileName) === false && predefinedUri !== undefined) {
                const predefinedDirectory = resolveUri(predefinedUri, '.');
                includePaths =
                    Array.from(this.recordList.keys())
                        .filter(uri => uri.startsWith(predefinedDirectory))
                        .filter(uri => uri.endsWith('.as') && uri !== record.uri);
            }
        }

        if (record.uri !== predefinedUri && predefinedUri !== undefined) {
            // Add 'as.predefined' to the include path
            includePaths.push(predefinedUri);
        }

        return includePaths;
    }

    private findPredefinedUri(targetUri: string): string | undefined {
        const dirs = getParentDirectoryList(targetUri);

        // Search for nearest 'as.predefined'
        for (const dir of dirs) {
            const predefinedUri = dir + `/${predefinedFileName}`;

            if (this.recordList.get(predefinedUri) !== undefined && this._resolvedPredefinedFilepaths.has(predefinedUri)) {
                // Return the record if the file has already been analyzed
                return predefinedUri;
            }

            if (targetUri !== predefinedUri) {
                const content = readFileContent(predefinedUri);
                if (content === undefined) continue;

                // If the file is found, inspect it
                inspectFile(predefinedUri, content);
            }

            // Inspect all files under the directory where 'as.predefined' is located
            this.inspectUnderDirectory(resolveUri(predefinedUri, '.'));

            this._resolvedPredefinedFilepaths.add(predefinedUri);

            return predefinedUri;
        }

        return undefined;
    }

    private inspectUnderDirectory(dirUri: string) {
        const entries = fs.readdirSync(fileURLToPath(dirUri), {withFileTypes: true});
        for (const entry of entries) {
            const fileUri = resolveUri(dirUri, entry.name);
            if (entry.isDirectory()) {
                this.inspectUnderDirectory(`${fileUri}/`);
            } else if (entry.isFile() && fileUri.endsWith('.as')) {
                const content = readFileContent(fileUri);
                if (content !== undefined) inspectFile(fileUri, content);
            }
        }
    }

    private collectIncludeScope(
        record: PartialInspectRecord, predefinedUri: string | undefined
    ): AnalyzerScope[] {
        const preprocessOutput = record.preprocessedOutput;
        const targetUri = record.uri;

        // Collect scopes in included files
        const includePaths = this.resolveIncludePaths(record, predefinedUri);

        const includedScopes = [];

        // Get the analyzed scope of included files
        for (const relativeOrAbsolute of includePaths) {
            const uri = resolveUri(targetUri, relativeOrAbsolute);

            const includedRecord = this.recordList.get(uri);
            if (includedRecord !== undefined) {
                includedScopes.push(includedRecord.analyzerScope);
                continue;
            }

            // If the file has not been analyzed, start inspecting it
            const content = readFileContent(uri);
            if (content !== undefined) {
                inspectFile(uri, content);
                continue;
            }

            // If the file is not found, notify the error
            const includePathToken =
                preprocessOutput.includePathTokens.find(token => token.getStringContent() === relativeOrAbsolute)!;
            diagnostic.addError(includePathToken.location, `File not found: ${relativeOrAbsolute}`);
        }

        return includedScopes;
    }
}
