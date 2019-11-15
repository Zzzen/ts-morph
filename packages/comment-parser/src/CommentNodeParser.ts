import { errors, getSyntaxKindName, StringUtils, ts, SyntaxKind } from "@ts-morph/common";
import { CompilerCommentNode, CompilerCommentList, CompilerCommentListStatement, CompilerCommentListClassElement, CompilerCommentListTypeElement, CompilerCommentListObjectLiteralElement,
    CompilerCommentListEnumMember, CommentListKind } from "./CompilerComments";
import { createCommentScanner, CommentScanner } from "./createCommentScanner";

export type StatementContainerNodes = ts.SourceFile
    | ts.Block
    | ts.ModuleBlock
    | ts.CaseClause
    | ts.DefaultClause;

export type ContainerNodes = StatementContainerNodes
    | ts.ClassDeclaration
    | ts.InterfaceDeclaration
    | ts.EnumDeclaration
    | ts.ClassExpression
    | ts.TypeLiteralNode
    | ts.ObjectLiteralExpression;

const childrenSaver = new WeakMap<ContainerNodes, (ts.Node | CompilerCommentList)[]>();
const tokenSaver = new WeakMap<ts.Node, (ts.Node | CompilerCommentList)[]>();
const commentNodeParserKinds = new Set<SyntaxKind>([
    SyntaxKind.SourceFile,
    SyntaxKind.Block,
    SyntaxKind.ModuleBlock,
    SyntaxKind.CaseClause,
    SyntaxKind.DefaultClause,
    SyntaxKind.ClassDeclaration,
    SyntaxKind.InterfaceDeclaration,
    SyntaxKind.EnumDeclaration,
    SyntaxKind.ClassExpression,
    SyntaxKind.TypeLiteral,
    SyntaxKind.ObjectLiteralExpression
]);

export class CommentNodeParser {
    private constructor() {
    }

    static getOrParseTokens(node: ts.Node, sourceFile: ts.SourceFile) {
        let tokens = tokenSaver.get(node);
        if (tokens == null) {
            tokens = getTokens();
            tokenSaver.set(node, tokens);
        }
        return tokens;

        function getTokens() {
            if (CommentNodeParser.isCommentList(node))
                return node.comments;
            if (isSyntaxList(node) && isChildSyntaxList(node, sourceFile))
                return parseChildSyntaxList(node);
            return parseNode();
        }

        function parseChildSyntaxList(syntaxList: ts.SyntaxList) {
            const result: ts.Node[] = [];
            const children = CommentNodeParser.getOrParseChildren(syntaxList, sourceFile)
            const commentScanner = getScannerForSourceFile(sourceFile);
            const searchEnd = getSearchEnd();

            commentScanner.setParent(syntaxList.parent); // not the syntax list (similar to other nodes)
            commentScanner.setFullStartAndPos(syntaxList.pos);

            for (const child of children) {
                // getStart(sourceFile, true) is broken in ts <= 3.7.2 (see PR #35029 in typescript repo)
                const childStart = ((child as any).jsDoc?.[0] || child).getStart(sourceFile);
                for (const comment of commentScanner.scanUntilToken()) {
                    // we stumbled upon the comment list or jsdoc... break
                    if (comment.pos === childStart)
                        break;
                    result.push(comment);
                }

                result.push(child);

                commentScanner.setFullStartAndPos(child.end);
            }

            for (const comment of commentScanner.scanUntilToken()) {
                if (comment.pos > searchEnd)
                    break;

                result.push(comment);
            }

            return result;

            function getSearchEnd() {
                const parent = syntaxList.parent;
                if (ts.isSourceFile(parent)) {
                    return parent.end;
                }
                else {
                    const children = parent.getChildren(sourceFile);
                    const nextChild = children[children.indexOf(syntaxList) + 1];
                    if (nextChild != null && nextChild.kind === ts.SyntaxKind.CloseBraceToken)
                        return nextChild.end - 1; // start position
                    return sourceFile.end;
                }
            }
        }

        function parseNode() {
            const children = node.getChildren(sourceFile);
            if (children.length <= 1)
                return children;
            const result: ts.Node[] = [children[0]];
            const commentScanner = getScannerForSourceFile(sourceFile);
            let lastEnd = children[0].end;

            commentScanner.setParent(node);

            for (let i = 1; i < children.length; i++) {
                const child = children[i];
                const childIsSyntaxList = isSyntaxList(child) && isChildSyntaxList(child, sourceFile);
                // Skip checking for comments before an EndOfFileToken since that may accidentally capture comments.
                // It will always be: (SourceFile -> [SyntaxList, EndOfFileToken])
                if (child.kind !== ts.SyntaxKind.EndOfFileToken) {
                    // Use the past end because the current pos might be before the
                    // last child (ex. if the previous child was a JSDocComment and the
                    // current child is not).
                    commentScanner.setFullStartAndPos(lastEnd);

                    const stopPos = childIsSyntaxList ? child.pos : child.getStart(sourceFile);
                    for (const comment of commentScanner.scanUntilToken()) {
                        if (comment.pos > stopPos)
                            break;

                        result.push(comment);
                    }
                }

                result.push(child);

                // Child syntax lists will have an end at the last token, but we don't want
                // to include comments that may come afterwards as part of this node's children.
                const nextChild = children[i + 1];
                if (nextChild != null && childIsSyntaxList)
                    lastEnd = nextChild.getStart(sourceFile);
                else
                    lastEnd = child.end;
            }

            return result;
        }
    }

    static getOrParseChildren(container: ContainerNodes | ts.SyntaxList, sourceFile: ts.SourceFile) {
        // always store the syntax list result on the parent so that a second array isn't created
        if (isSyntaxList(container))
            container = container.parent as ContainerNodes;

        // cache the result
        let children = childrenSaver.get(container);
        if (children == null) {
            children = Array.from(getNodes(container, sourceFile));
            childrenSaver.set(container, children);
        }

        return children;
    }

    static shouldParseChildren(container: ts.Node): container is ContainerNodes {
        // this needs to be really fast because it's used whenever getting the children, so use a map
        return commentNodeParserKinds.has(container.kind)
            // Ignore zero length nodes... for some reason this might happen when parsing
            // jsx in non-jsx files.
            && container.pos !== container.end;
    }

    static hasParsedChildren(container: ContainerNodes | ts.SyntaxList) {
        if (isSyntaxList(container))
            container = container.parent as ContainerNodes;

        return childrenSaver.has(container);
    }

    static hasParsedTokens(node: ts.Node) {
        return tokenSaver.has(node);
    }

    static isCommentListStatement(node: ts.Node): node is CompilerCommentListStatement {
        return (node as CompilerCommentList).commentListKind === CommentListKind.Statement;
    }

    static isCommentListClassElement(node: ts.Node): node is CompilerCommentListClassElement {
        return (node as CompilerCommentList).commentListKind === CommentListKind.ClassElement;
    }

    static isCommentListTypeElement(node: ts.Node): node is CompilerCommentListTypeElement {
        return (node as CompilerCommentList).commentListKind === CommentListKind.TypeElement;
    }

    static isCommentListObjectLiteralElement(node: ts.Node): node is CompilerCommentListObjectLiteralElement {
        return (node as CompilerCommentList).commentListKind === CommentListKind.ObjectLiteralElement;
    }

    static isCommentListEnumMember(node: ts.Node): node is CompilerCommentListEnumMember {
        return (node as CompilerCommentList).commentListKind === CommentListKind.EnumMember;
    }

    static isCommentList(node: ts.Node): node is CompilerCommentList {
        return typeof (node as CompilerCommentList).commentListKind === "number";
    }

    static getContainerBodyPos(container: ContainerNodes, sourceFile: ts.SourceFile) {
        if (ts.isSourceFile(container))
            return 0;

        if (ts.isClassDeclaration(container)
            || ts.isEnumDeclaration(container)
            || ts.isInterfaceDeclaration(container)
            || ts.isTypeLiteralNode(container)
            || ts.isClassExpression(container)
            || ts.isObjectLiteralExpression(container))
        {
            // this function is only used when there are no statements or members, so only do this
            return getTokenEnd(container, SyntaxKind.OpenBraceToken) ?? getLastSyntaxListPos(container);
        }

        if (ts.isModuleBlock(container) || ts.isBlock(container)) {
            // skip the open brace token
            return Math.min(container.getStart(sourceFile) + 1, sourceFile.end);
        }

        if (ts.isCaseClause(container) || ts.isDefaultClause(container))
            return getTokenEnd(container, SyntaxKind.ColonToken) ?? getLastSyntaxListPos(container);

        return errors.throwNotImplementedForNeverValueError(container);

        function getTokenEnd(node: ts.Node, kind: SyntaxKind.OpenBraceToken | SyntaxKind.ColonToken) {
            const token = node.getChildren(sourceFile).find(c => c.kind === kind);
            if (token == null)
                return undefined;
            return token.end;
        }

        function getLastSyntaxListPos(node: ts.Node) {
            const syntaxList = findLastSyntaxList();
            if (syntaxList == null)
                throw new Error("Unexpected scenario where a syntax list could not be found.");
            return syntaxList.pos;

            function findLastSyntaxList() {
                const children = node.getChildren(sourceFile);
                for (let i = children.length - 1; i >= 0; i--) {
                    if (children[i].kind === ts.SyntaxKind.SyntaxList)
                        return children[i];
                }
                return undefined;
            }
        }
    }
}

function* getNodes(container: ContainerNodes, sourceFile: ts.SourceFile): IterableIterator<ts.Node | CompilerCommentList> {
    const scanner = getScannerForSourceFile(sourceFile);
    const sourceFileText = sourceFile.text;
    const childNodes = getContainerChildren();
    const createCommentList = getCreationFunction();

    scanner.setParent(container);

    if (childNodes.length === 0) {
        const bodyStartPos = CommentNodeParser.getContainerBodyPos(container, sourceFile);
        scanner.setFullStartAndPos(bodyStartPos);
        yield* getCommentNodes(false); // do not skip js docs because they won't have a node to be attached to
    }
    else {
        for (const childNode of childNodes) {
            scanner.setFullStartAndPos(childNode.pos);
            yield* getCommentNodes(true);
            yield childNode;
        }

        // get the comments on a newline after the last node
        const lastChild = childNodes[childNodes.length - 1];
        scanner.setFullStartAndPos(lastChild.end);
        yield* getCommentNodes(false); // parse any jsdocs afterwards
    }

    function* getCommentNodes(stopAtJsDoc: boolean) {
        skipTrailingLine();

        const leadingComments = Array.from(getLeadingComments());
        // `pos` will be at the first significant token of the next node or at the source file length.
        // At this point, allow comments that end at the end of the source file or on the same line as the close brace token
        const pos = scanner.getPos();
        const maxEnd = sourceFileText.length === pos || sourceFileText[pos] === "}" ? pos : StringUtils.getLineStartFromPos(sourceFileText, pos);

        for (const leadingComment of leadingComments) {
            if (leadingComment.end <= maxEnd)
                yield leadingComment;
        }

        function skipTrailingLine() {
            // skip first line of the block as the comment there is likely to describe the header
            if (scanner.getPos() === 0)
                return;

            // todo: clean this up
            while (true) {
                for (const _ of scanner.scanUntilNewLineOrToken()) {
                    // do nothing, drain the iterator
                }

                // skip any trailing commas too
                if (sourceFileText[scanner.getPos()] !== ",")
                    return;
                scanner.setPos(scanner.getPos() + 1);
            }
        }

        function* getLeadingComments() {
            while (true) {
                const comments = Array.from(scanner.scanForNewLines());
                if (comments.length === 0)
                    return;

                if (stopAtJsDoc && comments.some(isJsDocComment))
                    return;

                const firstComment = comments[0];
                const lastComment = comments[comments.length - 1];
                yield createCommentList(firstComment.getFullStart(), firstComment.pos, lastComment.end, comments);
            }
        }

        function isJsDocComment(comment: CompilerCommentNode | ts.JSDoc) {
            if (comment.kind === ts.SyntaxKind.JSDocComment)
                return true;

            const text = comment.getText();
            return text.startsWith("/**") && text !== "/***/";
        }
    }

    function getContainerChildren() {
        if (ts.isSourceFile(container) || ts.isBlock(container) || ts.isModuleBlock(container) || ts.isCaseClause(container) || ts.isDefaultClause(container))
            return container.statements;

        if (ts.isClassDeclaration(container)
            || ts.isClassExpression(container)
            || ts.isEnumDeclaration(container)
            || ts.isInterfaceDeclaration(container)
            || ts.isTypeLiteralNode(container)
            || ts.isClassExpression(container))
        {
            return container.members;
        }

        if (ts.isObjectLiteralExpression(container))
            return container.properties;

        return errors.throwNotImplementedForNeverValueError(container);
    }

    function getCreationFunction(): (
        fullStart: number,
        pos: number,
        end: number,
        comments: (CompilerCommentNode | ts.JSDoc)[]
    ) => CompilerCommentList {
        const ctor = getCtor();
        return (fullStart: number, pos: number, end: number, comments: (CompilerCommentNode | ts.JSDoc)[]) => {
            return new ctor(fullStart, pos, end, sourceFile, container, comments);
        }

        function getCtor() {
            if (isStatementContainerNode(container))
                return CompilerCommentListStatement;
            if (ts.isClassLike(container))
                return CompilerCommentListClassElement;
            if (ts.isInterfaceDeclaration(container) || ts.isTypeLiteralNode(container))
                return CompilerCommentListTypeElement;
            if (ts.isObjectLiteralExpression(container))
                return CompilerCommentListObjectLiteralElement;
            if (ts.isEnumDeclaration(container))
                return CompilerCommentListEnumMember;

            throw new errors.NotImplementedError(`Not implemented comment node container type: ${getSyntaxKindName(container.kind)}`);
        }
    }
}

function isSyntaxList(node: ts.Node): node is ts.SyntaxList {
    return node.kind === SyntaxKind.SyntaxList;
}

const singleSyntaxListParents = new Set<SyntaxKind>([
    SyntaxKind.SourceFile,
    SyntaxKind.Block,
    SyntaxKind.ModuleBlock,
    SyntaxKind.CaseClause,
    SyntaxKind.DefaultClause
]);
const openBraceSyntaxListParents = new Set<SyntaxKind>([
    SyntaxKind.ClassDeclaration,
    SyntaxKind.InterfaceDeclaration,
    SyntaxKind.EnumDeclaration,
    SyntaxKind.ClassExpression,
    SyntaxKind.TypeLiteral,
    SyntaxKind.ObjectLiteralExpression
]);
function isChildSyntaxList(node: ts.SyntaxList, sourceFile: ts.SourceFile) {
    const parent = node.parent;
    if (singleSyntaxListParents.has(parent.kind))
        return true;
    if (!openBraceSyntaxListParents.has(parent.kind))
        return false;

    // search for the syntax list after the open brace token
    let passedBrace = false;
    for (const child of parent.getChildren(sourceFile)) {
        if (passedBrace)
            return child === node;
        if (child.kind === SyntaxKind.OpenBraceToken)
            passedBrace = true;
    }

    return false;
}

function isStatementContainerNode(node: ts.Node) {
    return getStatementContainerNode() != null;

    function getStatementContainerNode(): StatementContainerNodes | undefined {
        // this is a bit of a hack so the type checker ensures this is correct
        const container = node as any as StatementContainerNodes;
        if (ts.isSourceFile(container)
            || ts.isBlock(container)
            || ts.isModuleBlock(container)
            || ts.isCaseClause(container)
            || ts.isDefaultClause(container))
        {
            return container;
        }

        const assertNever: never = container;
        return undefined;
    }
}

const cachedScanners = new WeakMap<ts.SourceFile, CommentScanner>();
function getScannerForSourceFile(sourceFile: ts.SourceFile) {
    let scanner = cachedScanners.get(sourceFile);
    if (scanner == null) {
        scanner = createCommentScanner(sourceFile);
        cachedScanners.set(sourceFile, scanner);
    }
    return scanner;
}