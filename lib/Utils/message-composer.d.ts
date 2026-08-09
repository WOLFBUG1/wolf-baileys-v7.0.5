export declare enum CodeHighlightType {
    DEFAULT = 0,
    KEYWORD = 1,
    METHOD = 2,
    STRING = 3,
    NUMBER = 4,
    COMMENT = 5
}
export declare enum RichSubMessageType {
    UNKNOWN = 0,
    GRID_IMAGE = 1,
    TEXT = 2,
    INLINE_IMAGE = 3,
    TABLE = 4,
    CODE = 5,
    DYNAMIC = 6,
    MAP = 7,
    LATEX = 8,
    CONTENT_ITEMS = 9
}
export declare const tokenizeCode: (codeStr: string, language?: string) => Array<{
    highlightType: CodeHighlightType;
    codeContent: string;
}>;
export declare const buildRichContextInfo: (quoted?: any, options?: any) => any;
export declare const buildBotForwardedMessage: (submessages: any[], contextInfo: any, unifiedResponse?: any) => any;
export declare const generateTableContent: (title: string, headers: string[], rows: any[][], quoted?: any, options?: any) => {
    message: any;
    messageId: string;
};
export declare const generateListContent: (title: string, items: any[], quoted?: any, options?: any) => {
    message: any;
    messageId: string;
};
export declare const generateCodeBlockContent: (code: string, quoted?: any, options?: any) => {
    message: any;
    messageId: string;
};
export declare const generateLatexContent: (quoted: any, options?: any) => {
    message: any;
    messageId: string;
};
export declare const renderLatexToPng: (latexExpression: string, options?: any) => Promise<{
    buffer: Buffer;
    width: number;
    height: number;
}>;
export declare const generateLatexImageContent: (quoted: any, options: any, uploadFn: Function, renderLatexToPng?: Function) => Promise<{
    message: any;
    messageId: string;
}>;
export declare const generateLatexInlineImageContent: (quoted: any, options: any, uploadFn: Function, renderLatexToPng?: Function) => Promise<{
    message: any;
    messageId: string;
}>;
export declare const captureUnifiedResponse: (msg: any) => any;
export declare const generateUnifiedResponseContent: (quoted: any, captured: any, options?: any) => {
    message: any;
    messageId: string;
};
export declare const generateRichMessageContent: (submessages: any[], quoted?: any, options?: any) => {
    message: any;
    messageId: string;
};
export declare const JS_KEYWORDS: Set<string>;
export declare const PYTHON_KEYWORDS: Set<string>;
export declare const LANGUAGE_KEYWORDS: Record<string, Set<string>>;
