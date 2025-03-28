import {Position} from "vscode-languageserver";
import {isSymbolInstanceMember, SymbolObjectHolder} from "../compiler_analyzer/symbolObject";
import {CompletionItem, CompletionItemKind} from "vscode-languageserver/node";
import {NodeName} from "../compiler_parser/nodes";
import {
    collectParentScopeList,
    isAnonymousIdentifier,
    SymbolGlobalScope,
    SymbolScope
} from "../compiler_analyzer/symbolScope";
import {ComplementHint, ComplementKind, isAutocompleteHint} from "../compiler_analyzer/complementHint";
import {findScopeContainingPosition} from "./utils";
import {TextPosition} from "../compiler_tokenizer/textLocation";
import {canAccessInstanceMember} from "../compiler_analyzer/symbolUtils";

export interface CompletionItemWrapper {
    item: CompletionItem;
    symbol?: SymbolObjectHolder;
}

/**
 * Returns the completion candidates for the specified position.
 */
export function provideCompletion(
    globalScope: SymbolGlobalScope, caret: TextPosition
): CompletionItemWrapper[] {
    const items: CompletionItemWrapper[] = [];

    const uri = globalScope.getContext().filepath;
    const caretScope = findScopeContainingPosition(globalScope, caret, uri);

    // If there is a completion target within the scope that should be prioritized, return the completion candidates for it.
    // e.g. Methods of the instance object.
    const prioritizedCompletion = checkMissingCompletionInScope(globalScope, caretScope, caret);
    if (prioritizedCompletion !== undefined) return prioritizedCompletion;

    // Return the completion candidates for the symbols in the scope itself and its parent scope.
    // e.g. Defined classes or functions in the scope.
    for (const scope of [...collectParentScopeList(caretScope), caretScope]) {
        items.push(...getCompletionSymbolsInScope(scope, true));
    }

    return items;
}

function getCompletionSymbolsInScope(scope: SymbolScope, includeInstanceMember: boolean): CompletionItemWrapper[] {
    const items: CompletionItemWrapper[] = [];

    // Completion of symbols in the scope
    for (const [symbolName, symbol] of scope.symbolTable) {
        if (includeInstanceMember === false) {
            // Skip instance members
            if (isSymbolInstanceMember(symbol)) continue;

            if (symbol.isVariable() && symbol.identifierToken.isVirtual() && symbol.identifierText === 'this') {
                // FIXME: Probably something is wrong
                continue;
            }
        }

        items.push(makeCompletionItem(symbolName, symbol));
    }

    // Completion of namespace
    for (const [childName, childScope] of scope.childScopeTable) {
        if (childScope.isPureNamespaceScope() === false) continue;

        items.push({
            item: {
                label: childName,
                kind: CompletionItemKind.Module,
            }
        });
    }

    return items;
}

function getCompletionMembersInScope(globalScope: SymbolScope, caretScope: SymbolScope, symbolScope: SymbolScope): CompletionItemWrapper[] {
    const items: CompletionItemWrapper[] = [];

    // Completion of symbols in the scope
    for (const [symbolName, symbol] of symbolScope.symbolTable) {
        if (isSymbolInstanceMember(symbol) === false) continue;
        if (canAccessInstanceMember(caretScope, symbol) === false) continue;

        items.push(makeCompletionItem(symbolName, symbol));
    }

    return items;
}

function checkMissingCompletionInScope(globalScope: SymbolGlobalScope, caretScope: SymbolScope, caret: Position) {
    if (globalScope.completionHints.length === 0) return;

    for (const hint of globalScope.completionHints) {
        if (isAutocompleteHint(hint) === false) continue;

        // Check if the completion target to be prioritized is at the cursor position in the scope.
        const location = hint.autocompleteLocation;
        if (location.positionInRange(caret)) {
            // Return the completion target to be prioritized.
            const result = searchMissingCompletion(globalScope, caretScope, hint);
            if (result !== undefined && result.length > 0) return result;
        }
    }

    return undefined;
}

function searchMissingCompletion(globalScope: SymbolScope, caretScope: SymbolScope, completion: ComplementHint) {
    if (completion.complement === ComplementKind.AutocompleteInstanceMember) {
        // Find the scope to which the type to be completed belongs.
        if (completion.targetType.membersScope === undefined) return [];

        const typeScope = globalScope.getGlobalScope().resolveScope(completion.targetType.scopePath)?.lookupScope(
            completion.targetType.identifierToken.text);
        if (typeScope === undefined) return [];

        // Return the completion candidates in the scope.
        return getCompletionMembersInScope(globalScope, caretScope, typeScope);
    } else if (completion.complement === ComplementKind.AutocompleteNamespaceAccess) {
        // Return the completion candidates in the scope.
        return getCompletionSymbolsInScope(completion.accessScope, false);
    }

    return undefined;
}

function makeCompletionItem(symbolName: string, symbol: SymbolObjectHolder): CompletionItemWrapper {
    const item: CompletionItem = {label: symbolName};

    // FIXME: We should classify the completion items more precisely.

    if (symbol.isType()) {
        if (symbol.isPrimitiveType() || symbol.linkedNode === undefined) {
            item.kind = CompletionItemKind.Keyword;
        } else if (symbol.isEnumType()) {
            item.kind = CompletionItemKind.Enum;
        } else if (symbol.linkedNode.nodeName === NodeName.Interface) {
            item.kind = CompletionItemKind.Interface;
        } else {
            item.kind = CompletionItemKind.Class;
        }
    } else if (symbol.isFunctionHolder()) {
        item.kind = CompletionItemKind.Function;
    } else { // Variable
        item.kind = CompletionItemKind.Variable;
    }

    return {item, symbol};
}

// -----------------------------------------------

// TODO: Autocomplete for built-in keywords? 'true', 'opAdd', etc.
