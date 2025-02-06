import {TokenizedToken} from "../compile/tokens";
import {Profiler} from "../code/profiler";
import {tokenize} from "../compile/tokenizer";
import {parseFromTokenized} from "../compile/parser";
import {analyzeFromParsed} from "../compile/analyzer";
import {diagnostic} from '../code/diagnostic';
import {Diagnostic} from "vscode-languageserver/node";
import {AnalyzedScope, createSymbolScope} from "../compile/symbolScopes";
import {tracer} from "../code/tracer";
import {NodeScript} from "../compile/nodes";
import {URI} from "vscode-languageserver";
import * as url from "url";
import {URL} from "url";
import * as path from "node:path";
import * as fs from "fs";
import {fileURLToPath, pathToFileURL} from "node:url";
import {preprocessTokensForParser} from "../compile/parserPreprocess";
import {getGlobalSettings} from "../code/settings";

interface InspectResult {
    content: string;
    diagnosticsInParser: Diagnostic[]; // A diagnosed messages occurred in the parser or tokenizer
    diagnosticsInAnalyzer: Diagnostic[];
    tokenizedTokens: TokenizedToken[];
    parsedAst: NodeScript;
    analyzedScope: AnalyzedScope;
    includedScopes: AnalyzedScope[];
}

const s_inspectedResults: { [uri: string]: InspectResult } = {};

function createEmptyResult(): InspectResult {
    return {
        content: '',
        diagnosticsInParser: [],
        diagnosticsInAnalyzer: [],
        tokenizedTokens: [],
        parsedAst: [],
        analyzedScope: new AnalyzedScope('', createSymbolScope(undefined, undefined, '')),
        includedScopes: [],
    } as const;
}

const predefinedFileName = 'as.predefined';

/**
 * Get the analyzed result of the specified file.
 */
export function getInspectedResult(uri: URI): InspectResult {
    const result = s_inspectedResults[uri];
    if (result === undefined) return createEmptyResult();
    return result;
}

/**
 * Get the list of all analyzed results as a list.
 */
export function getInspectedResultList(): InspectResult[] {
    return Object.values(s_inspectedResults);
}

/**
 * Compile the specified file and cache the result.
 */
export function inspectFile(content: string, targetUri: URI, dependencies: boolean) {
    // Load as.predefined file
    const predefinedUri = checkInspectPredefined(targetUri);

    // Cache the inspected result
    inspectInternal(content, targetUri, predefinedUri);

	if (dependencies)
	{
		// Re-analyze the files that includes the current file
		reanalyzeFilesWithDependency(targetUri);
	}
}

/**
 * Re-inspect all files that have already been inspected.
 * This method is used to fully apply the configuration settings.
 */
export function reinspectAllFiles() {
    for (const uri of Object.keys(s_inspectedResults)) {
        inspectFile(s_inspectedResults[uri].content, uri, !getGlobalSettings().implicitMutualInclusion);
    }
}

function checkInspectPredefined(targetUri: URI) {
    const dirs = splitUriIntoDirectories(targetUri);

    // If as.predefined has already been analyzed, return its URI | as.predefined が解析済みの場合、その URI を返す
    for (const dir of dirs) {
        const predefinedUri = dir + `/${predefinedFileName}`;

        const predefinedResult = s_inspectedResults[predefinedUri];
        if (predefinedResult !== undefined) return predefinedUri;
    }

    // If as.predefined has not been analyzed, search for the file and start analyzing.
    for (const dir of dirs) {
        const predefinedUri = dir + `/${predefinedFileName}`;

        const content = readFileFromUri(predefinedUri);
        if (content === undefined) continue;

        // Inspect found as.predefined
        inspectInternal(content, predefinedUri, undefined);

        // Inspect all files under the directory where as.predefined is located, as we may need to reference them.
        if (predefinedUri !== undefined) {
            inspectAllFilesUnderDirectory(resolveUri(predefinedUri, '.'));
        }

        return predefinedUri;
    }

    return undefined;
}

function inspectAllFilesUnderDirectory(dirUri: string) {
    const entries = fs.readdirSync(fileURLToPath(dirUri), {withFileTypes: true, recursive: true});
    for (const entry of entries) {
        let fileUri = pathToFileURL(path.join(entry.path, entry.name)).toString();
		fileUri = 'file:///' + fileUri.substring(8).replace(':', '%3A');
        if (entry.isFile() && fileUri.endsWith('.as')) {
            const content = readFileFromUri(fileUri);
            if (content !== undefined) inspectFile(content, fileUri, false);
        }
    }
}

function readFileFromUri(uri: string): string | undefined {
    try {
        const path = fileURLToPath(uri);
        if (fs.existsSync(path) === false) return undefined;

        return fs.readFileSync(path, 'utf8');
    } catch (error) {
        return undefined;
    }
}

function splitUriIntoDirectories(fileUri: string): string[] {
    const parsedUrl = url.parse(fileUri);
    const currentPath = parsedUrl.pathname;
    if (currentPath === null) return [];

    const directories: string[] = [];
    let parentPath = currentPath;

    // Repeat until the directory reaches the root
    while (parentPath !== path.dirname(parentPath)) {
        parentPath = path.dirname(parentPath);
        directories.push(url.format({
            protocol: parsedUrl.protocol,
            slashes: true,
            hostname: parsedUrl.hostname,
            pathname: parentPath
        }));
    }

    return directories;
}

function inspectInternal(content: string, targetUri: URI, predefinedUri: URI | undefined): void {
    tracer.message(`🔬 Inspect "${targetUri}"`);

    diagnostic.beginSession();

    const profiler = new Profiler("Inspector");

    // Tokenizer-phase
    const tokenizedTokens = tokenize(content, targetUri);
    profiler.stamp("Tokenizer");

    // Preprocess tokens for parser
    const preprocessedTokens = preprocessTokensForParser(tokenizedTokens);
    profiler.stamp("Preprocess");

    // Parser-phase
    const parsedAst = parseFromTokenized(preprocessedTokens.parsingTokens);
    profiler.stamp("Parser");

    // Collect scopes in included files
    let includePaths = preprocessedTokens.includeFiles.map(getIncludePathFromToken);
    if (getGlobalSettings().implicitMutualInclusion) {
        // If implicit mutual inclusion is enabled, include all files under the directory where as.predefined is located.
        if (targetUri.endsWith(predefinedFileName) === false && predefinedUri !== undefined) {
            includePaths = listPathsOfInspectedFilesUnder(resolveUri(predefinedUri, '.'));
            includePaths = includePaths.filter(uri => uri.endsWith('.as') && uri !== targetUri);
        }
    }

    const missingFileHandler = (path: string) => addErrorOfMissingIncludingFile(path, preprocessedTokens.includeFiles.find(token => getIncludePathFromToken(token) === path)!);
    const includedScopes = collectIncludedScope(targetUri, predefinedUri, includePaths, missingFileHandler);

    // Store the diagnostics that occurred before the analyzer phase.
    const diagnosticsInParser = diagnostic.endSession();
    diagnostic.beginSession();

    // Analyzer-phase
    const analyzedScope = analyzeFromParsed(parsedAst, targetUri, includedScopes);
    profiler.stamp("Analyzer");

    const diagnosticsInAnalyzer = diagnostic.endSession();

	if (!(targetUri in s_inspectedResults))
	{
		s_inspectedResults[targetUri] = {
			content: content,
			diagnosticsInParser,
			diagnosticsInAnalyzer,
			tokenizedTokens: tokenizedTokens,
			parsedAst: parsedAst,
			analyzedScope: analyzedScope,
			includedScopes: includedScopes,
		};

		return;
	}

	const result = s_inspectedResults[targetUri];
	result.content = content;
	result.diagnosticsInParser = diagnosticsInParser;
	result.diagnosticsInAnalyzer = diagnosticsInAnalyzer;
	result.tokenizedTokens = tokenizedTokens;
	result.parsedAst = parsedAst;
	result.analyzedScope.fullScope = analyzedScope.fullScope;
	result.analyzedScope.path = analyzedScope.path;
	delete result.analyzedScope.pureBuffer;
	result.includedScopes = includedScopes;
}

function getIncludePathFromToken(token: TokenizedToken): string {
    return token.text.substring(1, token.text.length - 1);
}

// We will reanalyze the files that include the file specified by the given URI.
// Since this does not involve executing the tokenizer or parser steps, it should be faster than a straightforward reanalysis.
function reanalyzeFilesWithDependency(includedFile: URI) {
    const dependedFiles = Object.values(s_inspectedResults).filter(r => isContainInIncludedScopes(r.includedScopes, includedFile));
    for (const dependedFile of dependedFiles) {
        diagnostic.beginSession();

        dependedFile.includedScopes = refreshScopeInIncludedScopes(dependedFile.includedScopes);
        dependedFile.analyzedScope = analyzeFromParsed(dependedFile.parsedAst, dependedFile.analyzedScope.path, dependedFile.includedScopes);

        dependedFile.diagnosticsInAnalyzer = diagnostic.endSession();
    }
}

function isContainInIncludedScopes(includedScopes: AnalyzedScope[], targetUri: URI): boolean {
    for (const scope of includedScopes) {
        if (scope.path === targetUri) return true;
    }
    return false;
}

function refreshScopeInIncludedScopes(includedScopes: AnalyzedScope[]): AnalyzedScope[] {
    return includedScopes.map(scope => {
        return s_inspectedResults[scope.path].analyzedScope;
    });
}

function addErrorOfMissingIncludingFile(relativePath: string, includeFileTokens: TokenizedToken) {
    diagnostic.addError(includeFileTokens.location, `File not found: "${relativePath}"`);
}

function resolveUri(dir: string, relativeUri: string): string {
    const u = new URL(dir);
    return url.format(new URL(relativeUri, u));
}

function listPathsOfInspectedFilesUnder(dirUri: string): string[] {
    let keys = Object.keys(s_inspectedResults);
	keys = keys.filter(uri => uri.startsWith(dirUri));
	return keys;
}

function collectIncludedScope(
    target: URI, predefinedUri: URI | undefined, includedUris: string[], onMissingFile?: (uri: string) => void
): AnalyzedScope[] {
    const includedScopes = [];

    // Load as.predefined
    if (target !== predefinedUri && predefinedUri !== undefined) {
        const predefinedResult = s_inspectedResults[predefinedUri];
        if (predefinedResult !== undefined) includedScopes.push(predefinedResult.analyzedScope);
    }

    // Get the analyzed scope of included files
    for (const relativeUri of includedUris) {
        const uri = resolveUri(target, relativeUri);

        if (s_inspectedResults[uri] === undefined) {
            const content = readFileFromUri(uri);
            if (content === undefined) {
                if (onMissingFile) onMissingFile(relativeUri);
                continue;
            }

            inspectInternal(content, uri, predefinedUri);
        }

        const result = s_inspectedResults[uri];
        if (result !== undefined) includedScopes.push(result.analyzedScope);
    }

    return includedScopes;
}