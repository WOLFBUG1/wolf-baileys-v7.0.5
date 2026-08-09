"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LANGUAGE_KEYWORDS = exports.PYTHON_KEYWORDS = exports.JS_KEYWORDS = exports.generateRichMessageContent = exports.generateUnifiedResponseContent = exports.captureUnifiedResponse = exports.generateLatexInlineImageContent = exports.generateLatexImageContent = exports.generateLatexContent = exports.generateCodeBlockContent = exports.generateListContent = exports.generateTableContent = exports.buildBotForwardedMessage = exports.buildRichContextInfo = exports.tokenizeCode = exports.RichSubMessageType = exports.CodeHighlightType = void 0;
const crypto_1 = require("crypto");
const JS_KEYWORDS = new Set([
    'import', 'export', 'from', 'default', 'as', 'const', 'let', 'var',
    'function', 'class', 'extends', 'new', 'return', 'if', 'else', 'for',
    'while', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch',
    'finally', 'throw', 'async', 'await', 'yield', 'typeof', 'instanceof',
    'in', 'of', 'delete', 'void', 'true', 'false', 'null', 'undefined',
    'NaN', 'Infinity', 'this', 'super', 'static', 'get', 'set', 'debugger', 'with'
]);
exports.JS_KEYWORDS = JS_KEYWORDS;
const PYTHON_KEYWORDS = new Set([
    'import', 'from', 'as', 'def', 'class', 'return', 'if', 'elif', 'else',
    'for', 'while', 'break', 'continue', 'try', 'except', 'finally', 'raise',
    'with', 'yield', 'lambda', 'pass', 'del', 'global', 'nonlocal', 'assert',
    'True', 'False', 'None', 'and', 'or', 'not', 'in', 'is', 'async', 'await',
    'self', 'print'
]);
exports.PYTHON_KEYWORDS = PYTHON_KEYWORDS;
const LANGUAGE_KEYWORDS = {
    javascript: JS_KEYWORDS,
    typescript: JS_KEYWORDS,
    js: JS_KEYWORDS,
    ts: JS_KEYWORDS,
    python: PYTHON_KEYWORDS,
    py: PYTHON_KEYWORDS
};
exports.LANGUAGE_KEYWORDS = LANGUAGE_KEYWORDS;
const generateComposerMessageID = () => {
    const data = Buffer.alloc(44);
    data.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
    (0, crypto_1.randomBytes)(16).copy(data, 28);
    const hash = (0, crypto_1.createHash)('sha256').update(data).digest();
    return '3EB0' + hash.toString('hex').toUpperCase().substring(0, 18);
};
var CodeHighlightType;
(function (CodeHighlightType) {
    CodeHighlightType[CodeHighlightType["DEFAULT"] = 0] = "DEFAULT";
    CodeHighlightType[CodeHighlightType["KEYWORD"] = 1] = "KEYWORD";
    CodeHighlightType[CodeHighlightType["METHOD"] = 2] = "METHOD";
    CodeHighlightType[CodeHighlightType["STRING"] = 3] = "STRING";
    CodeHighlightType[CodeHighlightType["NUMBER"] = 4] = "NUMBER";
    CodeHighlightType[CodeHighlightType["COMMENT"] = 5] = "COMMENT";
})(CodeHighlightType || (exports.CodeHighlightType = CodeHighlightType = {}));
var RichSubMessageType;
(function (RichSubMessageType) {
    RichSubMessageType[RichSubMessageType["UNKNOWN"] = 0] = "UNKNOWN";
    RichSubMessageType[RichSubMessageType["GRID_IMAGE"] = 1] = "GRID_IMAGE";
    RichSubMessageType[RichSubMessageType["TEXT"] = 2] = "TEXT";
    RichSubMessageType[RichSubMessageType["INLINE_IMAGE"] = 3] = "INLINE_IMAGE";
    RichSubMessageType[RichSubMessageType["TABLE"] = 4] = "TABLE";
    RichSubMessageType[RichSubMessageType["CODE"] = 5] = "CODE";
    RichSubMessageType[RichSubMessageType["DYNAMIC"] = 6] = "DYNAMIC";
    RichSubMessageType[RichSubMessageType["MAP"] = 7] = "MAP";
    RichSubMessageType[RichSubMessageType["LATEX"] = 8] = "LATEX";
    RichSubMessageType[RichSubMessageType["CONTENT_ITEMS"] = 9] = "CONTENT_ITEMS";
})(RichSubMessageType || (exports.RichSubMessageType = RichSubMessageType = {}));
const tokenizeCode = (codeStr, language = 'javascript') => {
    const keywords = LANGUAGE_KEYWORDS[language] || JS_KEYWORDS;
    const blocks = [];
    const lines = String(codeStr).split('\n');
    for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const isLast = li === lines.length - 1;
        const nl = isLast ? '' : '\n';
        if (!line.trim()) {
            blocks.push({ highlightType: CodeHighlightType.DEFAULT, codeContent: line + nl });
            continue;
        }
        if (line.trim().startsWith('//') || line.trim().startsWith('#')) {
            blocks.push({ highlightType: CodeHighlightType.COMMENT, codeContent: line + nl });
            continue;
        }
        const regex = /(\/\/.*$|#.*$)|(["'`](?:[^"'`\\]|\\.)*["'`])|(\b\d+(?:\.\d+)?\b)|(\b[a-zA-Z_$][\w$]*\b)|([^\s\w$"'`]+)|(\s+)/g;
        let match;
        const tokens = [];
        while ((match = regex.exec(line)) !== null) {
            const val = match[0];
            if (match[1]) {
                tokens.push({ highlightType: CodeHighlightType.COMMENT, codeContent: val });
            }
            else if (match[2]) {
                tokens.push({ highlightType: CodeHighlightType.STRING, codeContent: val });
            }
            else if (match[3]) {
                tokens.push({ highlightType: CodeHighlightType.NUMBER, codeContent: val });
            }
            else if (match[4]) {
                if (keywords.has(val)) {
                    tokens.push({ highlightType: CodeHighlightType.KEYWORD, codeContent: val });
                }
                else {
                    const after = line.slice(regex.lastIndex).trimStart();
                    tokens.push({ highlightType: after.startsWith('(') ? CodeHighlightType.METHOD : CodeHighlightType.DEFAULT, codeContent: val });
                }
            }
            else {
                tokens.push({ highlightType: CodeHighlightType.DEFAULT, codeContent: val });
            }
        }
        if (!tokens.length) {
            blocks.push({ highlightType: CodeHighlightType.DEFAULT, codeContent: line + nl });
            continue;
        }
        const merged = [];
        for (const token of tokens) {
            const prev = merged.length ? merged[merged.length - 1] : undefined;
            if (prev && prev.highlightType === token.highlightType) {
                prev.codeContent += token.codeContent;
            }
            else {
                merged.push({ ...token });
            }
        }
        merged[merged.length - 1].codeContent += nl;
        blocks.push(...merged);
    }
    return blocks;
};
exports.tokenizeCode = tokenizeCode;
const buildRichContextInfo = (quoted, options = {}) => {
    const ctxInfo = {
        forwardingScore: 1,
        isForwarded: true,
        forwardedAiBotMessageInfo: { botJid: options.botJid || '867051314767696@bot' },
        forwardOrigin: 4,
        ...(options.mentions ? { mentionedJid: options.mentions } : {})
    };
    if (quoted === null || quoted === void 0 ? void 0 : quoted.key) {
        ctxInfo.stanzaId = quoted.key.id;
        ctxInfo.participant = quoted.key.participant || quoted.sender || quoted.key.remoteJid;
        ctxInfo.quotedMessage = quoted.message;
    }
    return ctxInfo;
};
exports.buildRichContextInfo = buildRichContextInfo;
const buildBotForwardedMessage = (submessages, contextInfo, unifiedResponse) => {
    const richResponse = { messageType: 1, submessages, contextInfo };
    if (unifiedResponse) {
        richResponse.unifiedResponse = unifiedResponse;
    }
    return {
        botForwardedMessage: {
            message: { richResponseMessage: richResponse }
        }
    };
};
exports.buildBotForwardedMessage = buildBotForwardedMessage;
const generateTableContent = (title, headers, rows, quoted, options = {}) => {
    const tableRows = [{ items: headers.map(String), isHeading: true }, ...rows.map(row => ({ items: row.map(String) }))];
    const submessages = [];
    if (options.headerText) {
        submessages.push({ messageType: RichSubMessageType.TEXT, messageText: options.headerText });
    }
    submessages.push({ messageType: RichSubMessageType.TABLE, tableMetadata: { title, rows: tableRows } });
    if (options.footer) {
        submessages.push({ messageType: RichSubMessageType.TEXT, messageText: options.footer });
    }
    return { message: (0, exports.buildBotForwardedMessage)(submessages, (0, exports.buildRichContextInfo)(quoted, options)), messageId: generateComposerMessageID() };
};
exports.generateTableContent = generateTableContent;
const generateListContent = (title, items, quoted, options = {}) => {
    const tableRows = items.map(item => ({ items: Array.isArray(item) ? item.map(String) : [String(item)] }));
    const submessages = [];
    if (options.headerText) {
        submessages.push({ messageType: RichSubMessageType.TEXT, messageText: options.headerText });
    }
    submessages.push({ messageType: RichSubMessageType.TABLE, tableMetadata: { title, rows: tableRows } });
    if (options.footer) {
        submessages.push({ messageType: RichSubMessageType.TEXT, messageText: options.footer });
    }
    return { message: (0, exports.buildBotForwardedMessage)(submessages, (0, exports.buildRichContextInfo)(quoted, options)), messageId: generateComposerMessageID() };
};
exports.generateListContent = generateListContent;
const generateCodeBlockContent = (code, quoted, options = {}) => {
    const submessages = [];
    const language = options.language || 'javascript';
    if (options.title) {
        submessages.push({ messageType: RichSubMessageType.TEXT, messageText: options.title });
    }
    submessages.push({
        messageType: RichSubMessageType.CODE,
        codeMetadata: { codeLanguage: language, codeBlocks: (0, exports.tokenizeCode)(code, language) }
    });
    if (options.footer) {
        submessages.push({ messageType: RichSubMessageType.TEXT, messageText: options.footer });
    }
    return { message: (0, exports.buildBotForwardedMessage)(submessages, (0, exports.buildRichContextInfo)(quoted, options)), messageId: generateComposerMessageID() };
};
exports.generateCodeBlockContent = generateCodeBlockContent;
const generateLatexContent = (quoted, options = {}) => {
    const submessages = [];
    if (options.headerText) {
        submessages.push({ messageType: RichSubMessageType.TEXT, messageText: options.headerText });
    }
    const expressions = (options.expressions || []).map(expr => {
        const entry = {
            latexExpression: expr.latexExpression,
            url: expr.url,
            width: expr.width,
            height: expr.height
        };
        for (const key of ['fontHeight', 'imageTopPadding', 'imageLeadingPadding', 'imageBottomPadding', 'imageTrailingPadding']) {
            if (expr[key] !== undefined) {
                entry[key] = expr[key];
            }
        }
        return entry;
    });
    submessages.push({ messageType: RichSubMessageType.LATEX, latexMetadata: { text: options.text || '', expressions } });
    if (options.footer) {
        submessages.push({ messageType: RichSubMessageType.TEXT, messageText: options.footer });
    }
    return { message: (0, exports.buildBotForwardedMessage)(submessages, (0, exports.buildRichContextInfo)(quoted, options)), messageId: generateComposerMessageID() };
};
exports.generateLatexContent = generateLatexContent;
const generateLatexImageContent = async (quoted, options, uploadFn, renderLatexToPng) => {
    const submessages = [];
    if (options.headerText) {
        submessages.push({ messageType: RichSubMessageType.TEXT, messageText: options.headerText });
    }
    const expressions = await Promise.all((options.expressions || []).map(async (expr) => {
        const { buffer, width, height } = await renderLatexToPng(expr.latexExpression);
        const uploadResult = await uploadFn(buffer, 'image');
        const imageUrl = uploadResult.url || uploadResult.directPath;
        return { latexExpression: expr.latexExpression, url: imageUrl, width, height };
    }));
    submessages.push({ messageType: RichSubMessageType.LATEX, latexMetadata: { text: options.text || '', expressions } });
    if (options.footer) {
        submessages.push({ messageType: RichSubMessageType.TEXT, messageText: options.footer });
    }
    return { message: (0, exports.buildBotForwardedMessage)(submessages, (0, exports.buildRichContextInfo)(quoted, options)), messageId: generateComposerMessageID() };
};
exports.generateLatexImageContent = generateLatexImageContent;
const generateLatexInlineImageContent = async (quoted, options, uploadFn, renderLatexToPng) => {
    const submessages = [];
    if (options.headerText) {
        submessages.push({ messageType: RichSubMessageType.TEXT, messageText: options.headerText });
    }
    if (options.text) {
        submessages.push({ messageType: RichSubMessageType.TEXT, messageText: options.text });
    }
    for (const expr of options.expressions || []) {
        const { buffer, width, height } = await renderLatexToPng(expr.latexExpression);
        const uploadResult = await uploadFn(buffer, 'image');
        const imageUrl = uploadResult.url || uploadResult.directPath;
        submessages.push({
            messageType: RichSubMessageType.INLINE_IMAGE,
            imageMetadata: {
                imageUrl: { imagePreviewUrl: imageUrl, imageHighResUrl: imageUrl },
                imageText: expr.latexExpression,
                width,
                height,
                alignment: 2
            }
        });
    }
    if (options.footer) {
        submessages.push({ messageType: RichSubMessageType.TEXT, messageText: options.footer });
    }
    return { message: (0, exports.buildBotForwardedMessage)(submessages, (0, exports.buildRichContextInfo)(quoted, options)), messageId: generateComposerMessageID() };
};
exports.generateLatexInlineImageContent = generateLatexInlineImageContent;
const captureUnifiedResponse = (msg) => {
    var _a, _b, _c;
    const botFwd = (_a = msg === null || msg === void 0 ? void 0 : msg.botForwardedMessage) === null || _a === void 0 ? void 0 : _a.message;
    if (!botFwd) {
        return null;
    }
    const rich = botFwd.richResponseMessage;
    if (!((_b = rich === null || rich === void 0 ? void 0 : rich.unifiedResponse) === null || _b === void 0 ? void 0 : _b.data)) {
        return null;
    }
    return {
        unifiedResponse: { data: rich.unifiedResponse.data },
        submessages: rich.submessages || [],
        contextInfo: (_c = rich.contextInfo) !== null && _c !== void 0 ? _c : {}
    };
};
exports.captureUnifiedResponse = captureUnifiedResponse;
const generateUnifiedResponseContent = (quoted, captured, options = {}) => {
    return { message: (0, exports.buildBotForwardedMessage)(captured.submessages, (0, exports.buildRichContextInfo)(quoted, options), captured.unifiedResponse), messageId: generateComposerMessageID() };
};
exports.generateUnifiedResponseContent = generateUnifiedResponseContent;
const generateRichMessageContent = (submessages, quoted, options = {}) => {
    return { message: (0, exports.buildBotForwardedMessage)(submessages, (0, exports.buildRichContextInfo)(quoted, options)), messageId: generateComposerMessageID() };
};
exports.generateRichMessageContent = generateRichMessageContent;
