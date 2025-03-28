import {SymbolFunction} from "../compiler_analyzer/symbolObject";
import {Position, SignatureHelp, URI} from "vscode-languageserver";
import {ParameterInformation, SignatureInformation} from "vscode-languageserver-types";
import {ComplementKind, ComplementFunctionCall} from "../compiler_analyzer/complementHint";
import {stringifyResolvedType} from "../compiler_analyzer/symbolUtils";
import {SymbolGlobalScope, SymbolScope} from "../compiler_analyzer/symbolScope";
import {TextPosition} from "../compiler_tokenizer/textLocation";
import {applyTemplateTranslator} from "../compiler_analyzer/resolvedType";
import {getDocumentCommentOfSymbol} from "./utils";

export function provideSignatureHelp(
    globalScope: SymbolGlobalScope, caret: Position, uri: URI
): SignatureHelp {
    const signatures: SignatureInformation[] = [];

    for (let i = 0; i < globalScope.completionHints.length; i++) {
        const hint = globalScope.completionHints[i];
        if (hint.complement !== ComplementKind.FunctionCall) continue;

        // Check if the caller location is at the cursor position in the scope.
        const shouldExtend = hint.callerArgumentsNode.nodeRange.end.location.end.character > caret.character;
        const location = hint.callerArgumentsNode.nodeRange.extendForward(shouldExtend ? 1 : 0); // Extend to the next token of ')'
        if (location.getBoundingLocation().positionInRange(caret)) {
            const callee = hint.calleeFuncHolder.first; // FIXME?
            const expectedCallee =
                globalScope.resolveScope(callee.scopePath)?.lookupSymbolWithParent(callee.identifierToken.text);
            if (expectedCallee?.isFunctionHolder() === false) continue;

            for (const callee of expectedCallee.overloadList) {
                signatures.push(getFunctionSignature(hint, callee, new TextPosition(caret.line, caret.character)));
            }

            break;
        }
    }

    return {
        signatures: signatures,
        // activeSignature: 0,
    };
}

function getFunctionSignature(hint: ComplementFunctionCall, expectedCallee: SymbolFunction, caret: TextPosition) {
    const parameters: ParameterInformation[] = [];

    let activeIndex = 0;

    let signatureLabel = expectedCallee.linkedNode.identifier.text + '(';
    for (let i = 0; i < expectedCallee.linkedNode.paramList.length; i++) {
        const paramIdentifier = expectedCallee.linkedNode.paramList[i];
        const paramType = expectedCallee.parameterTypes[i];

        let label = stringifyResolvedType(applyTemplateTranslator(paramType, hint.calleeTemplateTranslator));
        if (paramIdentifier.identifier !== undefined) label += ' ' + paramIdentifier.identifier?.text;
        const parameter: ParameterInformation = {label: label};

        if (i > 0) signatureLabel += ', ';
        signatureLabel += label;

        const passingRanges = hint.callerArgumentsNode.argList.map(arg => arg.assign.nodeRange);
        if (i < passingRanges.length && caret.isLessThan(passingRanges[i].start.location.start) === false) {
            activeIndex = i;
            if (passingRanges[i].end.next?.text === ',') activeIndex++;
        }

        parameters.push(parameter);
    }

    signatureLabel += ')';

    const signature: SignatureInformation = {
        label: signatureLabel,
        parameters: parameters,
        activeParameter: activeIndex,
        documentation: getDocumentCommentOfSymbol(expectedCallee)
    };

    return signature;
}