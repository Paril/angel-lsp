import {
    createAnonymousIdentifier, getActiveGlobalScope, SymbolGlobalScope,
    SymbolScope, tryResolveActiveScope
} from "./symbolScope";
import {
    AccessModifier,
    funcHeadDestructor,
    isFuncHeadReturnValue,
    NodeClass,
    NodeEnum,
    NodeFunc,
    NodeFuncDef,
    NodeInterface,
    NodeIntfMethod,
    NodeMixin,
    NodeName,
    NodeNamespace,
    NodeParamList,
    NodeScript,
    NodeType,
    NodeTypeDef,
    NodeVar,
    NodeVirtualProp,
    ParsedEnumMember
} from "../compiler_parser/nodes";
import {SymbolFunction, SymbolType, SymbolVariable} from "./symbolObject";
import {findSymbolWithParent} from "./symbolUtils";
import {ResolvedType} from "./resolvedType";
import {getGlobalSettings} from "../core/settings";
import {builtinSetterValueToken, builtinThisToken, tryGetBuiltinType} from "./builtinType";
import {TokenIdentifier, TokenObject} from "../compiler_tokenizer/tokenObject";
import {getIdentifierInNodeType} from "../compiler_parser/nodesUtils";
import {
    analyzeFunc,
    AnalyzeQueue,
    analyzeStatBlock,
    analyzeType,
    analyzeVarInitializer,
    HoistQueue,
    HoistResult,
    insertVariables, pushScopeRegionInfo
} from "./analyzer";
import {analyzerDiagnostic} from "./analyzerDiagnostic";
import {AnalyzerScope} from "./analyzerScope";
import {TokenRange} from "../compiler_tokenizer/tokenRange";
import {findConstructorOfType} from "./constrcutorCall";

// BNF: SCRIPT        ::= {IMPORT | ENUM | TYPEDEF | CLASS | MIXIN | INTERFACE | FUNCDEF | VIRTPROP | VAR | FUNC | NAMESPACE | ';'}
function hoistScript(parentScope: SymbolScope, ast: NodeScript, analyzeQueue: AnalyzeQueue, hoistQueue: HoistQueue) {
    for (const statement of ast) {
        const nodeName = statement.nodeName;
        if (nodeName === NodeName.Enum) {
            hoistEnum(parentScope, statement);
        } else if (nodeName === NodeName.TypeDef) {
            hoistTypeDef(parentScope, statement);
        } else if (nodeName === NodeName.Class) {
            hoistClass(parentScope, statement, analyzeQueue, hoistQueue);
        } else if (nodeName === NodeName.Mixin) {
            hoistMixin(parentScope, statement, analyzeQueue, hoistQueue);
        } else if (nodeName === NodeName.Interface) {
            hoistInterface(parentScope, statement, analyzeQueue, hoistQueue);
        } else if (nodeName === NodeName.FuncDef) {
            hoistFuncDef(parentScope, statement, analyzeQueue, hoistQueue);
        } else if (nodeName === NodeName.VirtualProp) {
            hoistVirtualProp(parentScope, statement, analyzeQueue, hoistQueue, false);
        } else if (nodeName === NodeName.Var) {
            hoistVar(parentScope, statement, analyzeQueue, false);
        } else if (nodeName === NodeName.Func) {
            hoistFunc(parentScope, statement, analyzeQueue, hoistQueue, false);
        } else if (nodeName === NodeName.Namespace) {
            hoistNamespace(parentScope, statement, analyzeQueue);
        }
    }
}

// BNF: NAMESPACE     ::= 'namespace' IDENTIFIER {'::' IDENTIFIER} '{' SCRIPT '}'
function hoistNamespace(parentScope: SymbolScope, nodeNamespace: NodeNamespace, queue: AnalyzeQueue) {
    if (nodeNamespace.namespaceList.length === 0) return;

    let scopeIterator = parentScope;
    for (let i = 0; i < nodeNamespace.namespaceList.length; i++) {
        const namespaceToken = nodeNamespace.namespaceList[i];
        scopeIterator = scopeIterator.insertScopeAndCheck(namespaceToken, undefined);
        scopeIterator.pushNamespaceNode(nodeNamespace, namespaceToken);
    }

    hoistScript(
        scopeIterator, nodeNamespace.script, queue,
        queue // TODO: Is this correct? Check
    );

    pushScopeRegionInfo(scopeIterator, nodeNamespace.nodeRange);
}

// BNF: ENUM          ::= {'shared' | 'external'} 'enum' IDENTIFIER [ ':' ('int' | 'int8' | 'int16' | 'int32' | 'int64' | 'uint' | 'uint8' | 'uint16' | 'uint32' | 'uint64') ] (';' | ('{' IDENTIFIER ['=' EXPR] {',' IDENTIFIER ['=' EXPR]} '}'))
function hoistEnum(parentScope: SymbolScope, nodeEnum: NodeEnum) {
    const symbol: SymbolType = SymbolType.create({
        identifierToken: nodeEnum.identifier,
        scopePath: parentScope.scopePath,
        linkedNode: nodeEnum,
        membersScopePath: undefined,
    });

    if (parentScope.insertSymbolAndCheck(symbol) === false) return;

    const scope = parentScope.insertScopeAndCheck(nodeEnum.identifier, nodeEnum);
    symbol.assignMembersScopePath(scope.scopePath);

    hoistEnumMembers(scope, nodeEnum.memberList, new ResolvedType(symbol));
}

function hoistEnumMembers(parentScope: SymbolScope, memberList: ParsedEnumMember[], type: ResolvedType) {
    for (const member of memberList) {
        parentScope.insertSymbolAndCheck(
            SymbolVariable.create({
                identifierToken: member.identifier,
                scopePath: parentScope.scopePath,
                type: type,
                isInstanceMember: false,
                accessRestriction: undefined,
            })
        );
    }
}

// BNF: CLASS         ::= {'shared' | 'abstract' | 'final' | 'external'} 'class' IDENTIFIER (';' | ([':' IDENTIFIER {',' IDENTIFIER}] '{' {VIRTPROP | FUNC | VAR | FUNCDEF} '}'))
function hoistClass(parentScope: SymbolScope, nodeClass: NodeClass, analyzeQueue: AnalyzeQueue, hoistQueue: HoistQueue) {
    const symbol: SymbolType = SymbolType.create({
        identifierToken: nodeClass.identifier,
        scopePath: parentScope.scopePath,
        linkedNode: nodeClass,
        membersScopePath: undefined,
    });
    if (parentScope.insertSymbolAndCheck(symbol) === false) return;

    const scope: SymbolScope = parentScope.insertScopeAndCheck(nodeClass.identifier, nodeClass);
    symbol.assignMembersScopePath(scope.scopePath);

    const thisVariable: SymbolVariable = SymbolVariable.create({
        identifierToken: builtinThisToken,
        scopePath: parentScope.scopePath,
        type: new ResolvedType(symbol),
        isInstanceMember: false,
        accessRestriction: AccessModifier.Private,
    });
    scope.insertSymbolAndCheck(thisVariable);

    const templateTypes = hoistClassTemplateTypes(scope, nodeClass.typeTemplates);
    if (templateTypes.length > 0) symbol.assignTemplateTypes(templateTypes);

    symbol.assignBaseList(hoistBaseList(scope, nodeClass));

    hoistQueue.push(() => {
        hoistClassMembers(scope, nodeClass, analyzeQueue, hoistQueue);

        hoistQueue.push(() => {
            if (symbol.baseList === undefined) return;

            // Copy the members of the base class
            copyBaseMembers(scope, symbol.baseList);

            // Insert the super constructor
            const primeBase = symbol.baseList.length >= 1 ? symbol.baseList[0] : undefined;
            const baseConstructorHolder = findConstructorOfType(primeBase);
            if (baseConstructorHolder?.isFunctionHolder()) {
                for (const baseConstructor of baseConstructorHolder.toList()) {
                    const superConstructor = baseConstructor.clone({
                        identifierToken: TokenIdentifier.createVirtual(
                            'super',
                            new TokenRange(baseConstructor.identifierToken, baseConstructor.identifierToken)
                        ),
                        accessRestriction: AccessModifier.Private,
                    });

                    scope.insertSymbol(superConstructor);
                }
            }
        });
    });

    pushScopeRegionInfo(scope, nodeClass.nodeRange);
}

function hoistClassTemplateTypes(scope: SymbolScope, types: NodeType[] | undefined) {
    const templateTypes: TokenObject[] = [];
    for (const type of types ?? []) {
        scope.insertSymbolAndCheck(SymbolType.create({
            identifierToken: getIdentifierInNodeType(type),
            scopePath: scope.scopePath,
            linkedNode: undefined,
            membersScopePath: undefined,
            isTypeParameter: true,
        }));

        templateTypes.push(getIdentifierInNodeType(type));
    }
    return templateTypes;
}

function hoistBaseList(scope: SymbolScope, nodeClass: NodeClass | NodeInterface): (ResolvedType | undefined)[] | undefined {
    if (nodeClass.baseList.length === 0) return undefined;

    const baseList: (ResolvedType | undefined)[] = [];
    for (const baseIdentifier of nodeClass.baseList) {
        const baseType = findSymbolWithParent(scope, baseIdentifier.text);

        if (baseType === undefined) {
            analyzerDiagnostic.error(baseIdentifier.location, `'${baseIdentifier.text}' is not defined type`);
            baseList.push(undefined);
        } else if (baseType.symbol instanceof SymbolType === false) {
            analyzerDiagnostic.error(baseIdentifier.location, `'${baseIdentifier.text}' is not class or interface`);
            baseList.push(undefined);
        } else {
            // Found the base class
            baseList.push(new ResolvedType(baseType.symbol));

            getActiveGlobalScope().info.reference.push({
                toSymbol: baseType.symbol,
                fromToken: baseIdentifier
            });
        }
    }
    return baseList;
}

function copyBaseMembers(scope: SymbolScope, baseList: (ResolvedType | undefined)[]) {
    // Iterate over each base class
    for (const baseType of baseList) {
        if (baseType === undefined) continue;
        if (baseType.typeOrFunc.isFunction()) continue;

        const baseScope = tryResolveActiveScope(baseType.typeOrFunc.membersScopePath);
        if (baseScope === undefined) continue;

        // Insert each base class member if possible
        for (const [key, symbolHolder] of baseScope.symbolTable) {
            if (key === 'this') continue;

            for (const symbol of symbolHolder.toList()) {
                if (symbol.isFunction() || symbol.isVariable()) {
                    if (symbol.accessRestriction === AccessModifier.Private) continue;
                }

                const alreadyExists = scope.insertSymbol(symbol);
                if (alreadyExists !== undefined) {
                    analyzerDiagnostic.error(
                        alreadyExists.toList()[0].identifierToken.location,
                        `Duplicated symbol '${key}'`
                    );
                }
            }
        }
    }
}

// '{' {VIRTPROP | FUNC | VAR | FUNCDEF} '}'
function hoistClassMembers(scope: SymbolScope, nodeClass: NodeClass, analyzeQueue: AnalyzeQueue, hoistQueue: HoistQueue) {
    for (const member of nodeClass.memberList) {
        if (member.nodeName === NodeName.VirtualProp) {
            hoistVirtualProp(scope, member, analyzeQueue, hoistQueue, true);
        } else if (member.nodeName === NodeName.Func) {
            hoistFunc(scope, member, analyzeQueue, hoistQueue, true);
        } else if (member.nodeName === NodeName.Var) {
            hoistVar(scope, member, analyzeQueue, true);
        } else if (member.nodeName === NodeName.FuncDef) {
            hoistFuncDef(scope, member, analyzeQueue, hoistQueue);
        }
    }
}

// BNF: TYPEDEF       ::= 'typedef' PRIMTYPE IDENTIFIER ';'
function hoistTypeDef(parentScope: SymbolScope, typeDef: NodeTypeDef) {
    const builtInType = tryGetBuiltinType(typeDef.type);
    if (builtInType === undefined) return;

    const symbol: SymbolType = SymbolType.create({
        identifierToken: typeDef.identifier,
        scopePath: parentScope.scopePath,
        linkedNode: builtInType.linkedNode,
        membersScopePath: undefined,
    });
    parentScope.insertSymbolAndCheck(symbol);
}

// BNF: FUNC          ::= {'shared' | 'external'} ['private' | 'protected'] [((TYPE ['&']) | '~')] IDENTIFIER PARAMLIST ['const'] FUNCATTR (';' | STATBLOCK)
function hoistFunc(
    parentScope: SymbolScope, nodeFunc: NodeFunc, analyzeQueue: AnalyzeQueue, hoistQueue: HoistQueue, isInstanceMember: boolean
) {
    if (nodeFunc.head === funcHeadDestructor) return;

    // Function holder scope (with no node)
    // |-- Anonymous scope of one of the overloads (with NodeFunc)
    //     |-- ...

    // Create a new scope for the function
    const funcionHolderScope: SymbolScope =
        // This doesn't have a linked node because the function may be overloaded.
        parentScope.insertScope(nodeFunc.identifier.text, undefined);
    const functionScope = funcionHolderScope.insertScope(createAnonymousIdentifier(), nodeFunc);

    const symbol: SymbolFunction = SymbolFunction.create({
        identifierToken: nodeFunc.identifier,
        scopePath: parentScope.scopePath,
        returnType: undefined, // set below
        parameterTypes: [],
        linkedNode: nodeFunc,
        functionScopePath: functionScope.scopePath,
        isInstanceMember: isInstanceMember,
        accessRestriction: nodeFunc.accessor
    });

    const templateTypes = hoistClassTemplateTypes(functionScope, nodeFunc.typeTemplates);
    if (templateTypes.length > 0) symbol.assignTemplateTypes(templateTypes);

    const returnType = isFuncHeadReturnValue(nodeFunc.head) ? analyzeType(
        functionScope,
        nodeFunc.head.returnType) : undefined;
    symbol.assignReturnType(returnType);

    if (parentScope.insertSymbolAndCheck(symbol) === false) return;

    // Check if the function is a virtual property setter or getter
    if (nodeFunc.identifier.text.startsWith('get_') || nodeFunc.identifier.text.startsWith('set_')) {
        if (nodeFunc.funcAttr?.isProperty === true || getGlobalSettings().explicitPropertyAccessor === false) {
            const identifier: TokenObject = TokenIdentifier.createVirtual(
                nodeFunc.identifier.text.substring(4),
                new TokenRange(nodeFunc.identifier, nodeFunc.identifier)
            );

            const symbol: SymbolVariable = SymbolVariable.create({
                identifierToken: identifier, // FIXME?
                scopePath: parentScope.scopePath,
                type: returnType,
                isInstanceMember: isInstanceMember,
                accessRestriction: nodeFunc.accessor,
            });
            parentScope.insertSymbol(symbol);
        }
    } else if (nodeFunc.funcAttr?.isProperty === true) {
        analyzerDiagnostic.error(nodeFunc.identifier.location, 'Property accessor must start with "get_" or "set_"');
    }

    hoistQueue.push(() => {
        symbol.assignParameterTypes(hoistParamList(functionScope, nodeFunc.paramList));
    });

    analyzeQueue.push(() => {
        analyzeFunc(functionScope, nodeFunc);
    });
}

// BNF: INTERFACE     ::= {'external' | 'shared'} 'interface' IDENTIFIER (';' | ([':' IDENTIFIER {',' IDENTIFIER}] '{' {VIRTPROP | INTFMTHD} '}'))
function hoistInterface(parentScope: SymbolScope, nodeInterface: NodeInterface, analyzeQueue: AnalyzeQueue, hoistQueue: HoistQueue) {
    const symbol: SymbolType = SymbolType.create({
        identifierToken: nodeInterface.identifier,
        scopePath: parentScope.scopePath,
        linkedNode: nodeInterface,
        membersScopePath: undefined,
    });
    if (parentScope.insertSymbolAndCheck(symbol) === false) return;

    const scope: SymbolScope = parentScope.insertScopeAndCheck(nodeInterface.identifier, nodeInterface);
    symbol.assignMembersScopePath(scope.scopePath);

    const baseList = hoistBaseList(scope, nodeInterface);
    if (baseList !== undefined) symbol.assignBaseList(baseList);

    hoistQueue.push(() => {
        hoistInterfaceMembers(scope, nodeInterface, analyzeQueue, hoistQueue);
        if (baseList !== undefined) copyBaseMembers(scope, baseList);
    });

    pushScopeRegionInfo(scope, nodeInterface.nodeRange);
}

function hoistInterfaceMembers(scope: SymbolScope, nodeInterface: NodeInterface, analyzeQueue: AnalyzeQueue, hoistQueue: HoistQueue) {
    for (const member of nodeInterface.memberList) {
        if (member.nodeName === NodeName.VirtualProp) {
            hoistVirtualProp(scope, member, analyzeQueue, hoistQueue, true);
        } else if (member.nodeName === NodeName.IntfMethod) {
            hoistIntfMethod(scope, member);
        }
    }
}

// BNF: VAR           ::= ['private' | 'protected'] TYPE IDENTIFIER [( '=' (INITLIST | ASSIGN)) | ARGLIST] {',' IDENTIFIER [( '=' (INITLIST | ASSIGN)) | ARGLIST]} ';'
function hoistVar(scope: SymbolScope, nodeVar: NodeVar, analyzeQueue: AnalyzeQueue, isInstanceMember: boolean) {
    const varType = analyzeType(scope, nodeVar.type);

    analyzeQueue.push(() => {
        for (const declaredVar of nodeVar.variables) {
            const initializer = declaredVar.initializer;
            if (initializer === undefined) continue;
            analyzeVarInitializer(scope, varType, declaredVar.identifier, initializer);
        }
    });

    insertVariables(scope, varType, nodeVar, isInstanceMember);
}

// BNF: IMPORT        ::= 'import' TYPE ['&'] IDENTIFIER PARAMLIST FUNCATTR 'from' STRING ';'

// BNF: FUNCDEF       ::= {'external' | 'shared'} 'funcdef' TYPE ['&'] IDENTIFIER PARAMLIST ';'
function hoistFuncDef(parentScope: SymbolScope, funcDef: NodeFuncDef, analyzeQueue: AnalyzeQueue, hoistQueue: HoistQueue) {
    const symbol: SymbolFunction = SymbolFunction.create({
        identifierToken: funcDef.identifier,
        scopePath: parentScope.scopePath,
        returnType: undefined,
        parameterTypes: [],
        linkedNode: funcDef,
        functionScopePath: undefined,
        isInstanceMember: false,
        accessRestriction: undefined,
    });
    if (parentScope.insertSymbolAndCheck(symbol) === false) return;

    hoistQueue.push(() => {
        symbol.assignReturnType(analyzeType(parentScope, funcDef.returnType));
    });

    hoistQueue.push(() => {
        symbol.assignParameterTypes(funcDef.paramList.map(param => analyzeType(parentScope, param.type)));
    });
}

// BNF: VIRTPROP      ::= ['private' | 'protected'] TYPE ['&'] IDENTIFIER '{' {('get' | 'set') ['const'] FUNCATTR (STATBLOCK | ';')} '}'
function hoistVirtualProp(
    parentScope: SymbolScope, virtualProp: NodeVirtualProp, analyzeQueue: AnalyzeQueue, hoistQueue: HoistQueue, isInstanceMember: boolean
) {
    const type = analyzeType(parentScope, virtualProp.type);

    const identifier = virtualProp.identifier;
    const symbol: SymbolVariable = SymbolVariable.create({
        identifierToken: identifier,
        scopePath: parentScope.scopePath,
        type: type,
        isInstanceMember: isInstanceMember,
        accessRestriction: virtualProp.accessor,
    });
    parentScope.insertSymbolAndCheck(symbol);

    const getter = virtualProp.getter;
    if (getter !== undefined && getter.statBlock !== undefined) {
        const getterScope = parentScope.insertScope(`get_${identifier.text}`, virtualProp);

        const statBlock = getter.statBlock;
        analyzeQueue.push(() => {
            analyzeStatBlock(getterScope, statBlock);
        });
    }

    const setter = virtualProp.setter;
    if (setter !== undefined && setter.statBlock !== undefined) {
        const setterScope = parentScope.insertScope(`set_${identifier.text}`, virtualProp);

        if (type !== undefined) {
            const valueVariable: SymbolVariable = SymbolVariable.create({
                identifierToken: builtinSetterValueToken,
                scopePath: parentScope.scopePath,
                type: new ResolvedType(type.typeOrFunc),
                isInstanceMember: false,
                accessRestriction: virtualProp.accessor,
            });
            setterScope.insertSymbolAndCheck(valueVariable);
        }

        const statBlock = setter.statBlock;
        analyzeQueue.push(() => {
            analyzeStatBlock(setterScope, statBlock);
        });
    }
}

// BNF: MIXIN         ::= 'mixin' CLASS
function hoistMixin(parentScope: SymbolScope, mixin: NodeMixin, analyzeQueue: AnalyzeQueue, hoistQueue: HoistQueue) {
    hoistClass(parentScope, mixin.mixinClass, analyzeQueue, hoistQueue);
}

// BNF: INTFMTHD      ::= TYPE ['&'] IDENTIFIER PARAMLIST ['const'] ';'
function hoistIntfMethod(parentScope: SymbolScope, intfMethod: NodeIntfMethod) {
    const symbol: SymbolFunction = SymbolFunction.create({
        identifierToken: intfMethod.identifier,
        scopePath: parentScope.scopePath,
        returnType: analyzeType(parentScope, intfMethod.returnType),
        parameterTypes: [],
        linkedNode: intfMethod,
        functionScopePath: undefined, // TODO: Create a dummy function scope for the interface method because named arguments give reference
        isInstanceMember: true,
        accessRestriction: undefined,
    });
    if (parentScope.insertSymbolAndCheck(symbol) === false) return;
}

// BNF: STATBLOCK     ::= '{' {VAR | STATEMENT} '}'

// BNF: PARAMLIST     ::= '(' ['void' | (TYPE TYPEMOD [IDENTIFIER] ['=' [EXPR | 'void']] {',' TYPE TYPEMOD [IDENTIFIER] ['...' | ('=' [EXPR | 'void']])})] ')'
function hoistParamList(scope: SymbolScope, paramList: NodeParamList) {
    const resolvedTypes: (ResolvedType | undefined)[] = [];
    for (const param of paramList) {
        const type = analyzeType(scope, param.type);
        if (type === undefined) resolvedTypes.push(undefined);
        else resolvedTypes.push(type);

        if (param.identifier === undefined) continue;
        scope.insertSymbolAndCheck(SymbolVariable.create({
            identifierToken: param.identifier,
            scopePath: scope.scopePath,
            type: type,
            isInstanceMember: false,
            accessRestriction: undefined,
        }));
    }
    return resolvedTypes;
}

// BNF: TYPEMOD       ::= ['&' ['in' | 'out' | 'inout'] ['+'] ['if_handle_then_const']]
// BNF: TYPE          ::= ['const'] SCOPE DATATYPE ['<' TYPE {',' TYPE} '>'] { ('[' ']') | ('@' ['const']) }
// BNF: INITLIST      ::= '{' [ASSIGN | INITLIST] {',' [ASSIGN | INITLIST]} '}'
// BNF: SCOPE         ::= ['::'] {IDENTIFIER '::'} [IDENTIFIER ['<' TYPE {',' TYPE} '>'] '::']
// BNF: DATATYPE      ::= (IDENTIFIER | PRIMTYPE | '?' | 'auto')
// BNF: PRIMTYPE      ::= 'void' | 'int' | 'int8' | 'int16' | 'int32' | 'int64' | 'uint' | 'uint8' | 'uint16' | 'uint32' | 'uint64' | 'float' | 'double' | 'bool'
// BNF: FUNCATTR      ::= {'override' | 'final' | 'explicit' | 'property' | 'delete' | 'nodiscard'}
// BNF: STATEMENT     ::= (IF | FOR | FOREACH | WHILE | RETURN | STATBLOCK | BREAK | CONTINUE | DOWHILE | SWITCH | EXPRSTAT | TRY)
// BNF: SWITCH        ::= 'switch' '(' ASSIGN ')' '{' {CASE} '}'
// BNF: BREAK         ::= 'break' ';'
// BNF: FOR           ::= 'for' '(' (VAR | EXPRSTAT) EXPRSTAT [ASSIGN {',' ASSIGN}] ')' STATEMENT
// BNF: WHILE         ::= 'while' '(' ASSIGN ')' STATEMENT
// BNF: DOWHILE       ::= 'do' STATEMENT 'while' '(' ASSIGN ')' ';'
// BNF: IF            ::= 'if' '(' ASSIGN ')' STATEMENT ['else' STATEMENT]
// BNF: CONTINUE      ::= 'continue' ';'
// BNF: EXPRSTAT      ::= [ASSIGN] ';'
// BNF: TRY           ::= 'try' STATBLOCK 'catch' STATBLOCK
// BNF: RETURN        ::= 'return' [ASSIGN] ';'
// BNF: CASE          ::= (('case' EXPR) | 'default') ':' {STATEMENT}
// BNF: EXPR          ::= EXPRTERM {EXPROP EXPRTERM}
// BNF: EXPRTERM      ::= ([TYPE '='] INITLIST) | ({EXPRPREOP} EXPRVALUE {EXPRPOSTOP})
// BNF: EXPRVALUE     ::= 'void' | CONSTRUCTCALL | FUNCCALL | VARACCESS | CAST | LITERAL | '(' ASSIGN ')' | LAMBDA
// BNF: CONSTRUCTCALL ::= TYPE ARGLIST
// BNF: EXPRPREOP     ::= '-' | '+' | '!' | '++' | '--' | '~' | '@'
// BNF: EXPRPOSTOP    ::= ('.' (FUNCCALL | IDENTIFIER)) | ('[' [IDENTIFIER ':'] ASSIGN {',' [IDENTIFIER ':' ASSIGN} ']') | ARGLIST | '++' | '--'
// BNF: CAST          ::= 'cast' '<' TYPE '>' '(' ASSIGN ')'
// BNF: LAMBDA        ::= 'function' '(' [[TYPE TYPEMOD] [IDENTIFIER] {',' [TYPE TYPEMOD] [IDENTIFIER]}] ')' STATBLOCK
// BNF: LITERAL       ::= NUMBER | STRING | BITS | 'true' | 'false' | 'null'
// BNF: FUNCCALL      ::= SCOPE IDENTIFIER ARGLIST
// BNF: VARACCESS     ::= SCOPE IDENTIFIER
// BNF: ARGLIST       ::= '(' [IDENTIFIER ':'] ASSIGN {',' [IDENTIFIER ':'] ASSIGN} ')'
// BNF: ASSIGN        ::= CONDITION [ ASSIGNOP ASSIGN ]
// BNF: CONDITION     ::= EXPR ['?' ASSIGN ':' ASSIGN]
// BNF: EXPROP        ::= MATHOP | COMPOP | LOGICOP | BITOP
// BNF: BITOP         ::= '&' | '|' | '^' | '<<' | '>>' | '>>>'
// BNF: MATHOP        ::= '+' | '-' | '*' | '/' | '%' | '**'
// BNF: COMPOP        ::= '==' | '!=' | '<' | '<=' | '>' | '>=' | 'is' | '!is'
// BNF: LOGICOP       ::= '&&' | '||' | '^^' | 'and' | 'or' | 'xor'
// BNF: ASSIGNOP      ::= '=' | '+=' | '-=' | '*=' | '/=' | '|=' | '&=' | '^=' | '%=' | '**=' | '<<=' | '>>=' | '>>>='

export function hoistAfterParsed(ast: NodeScript, globalScope: SymbolGlobalScope): HoistResult {
    const analyzeQueue: AnalyzeQueue = [];
    const hoistQueue: HoistQueue = [];

    // Hoist the declared symbols.
    hoistScript(globalScope, ast, analyzeQueue, hoistQueue);
    while (hoistQueue.length > 0) {
        const next = hoistQueue.shift();
        if (next !== undefined) next();
    }

    return {globalScope, analyzeQueue};
}
