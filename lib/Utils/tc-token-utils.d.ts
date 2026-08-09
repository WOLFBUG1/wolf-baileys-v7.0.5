/// <reference types="node" />
import { BinaryNode } from '../WABinary';
export declare const TC_TOKEN_INDEX_KEY = "__index";
export declare const readTcTokenIndex: (keys: any) => Promise<string[]>;
export declare const buildMergedTcTokenIndexWrite: (keys: any, addedJids: string[]) => Promise<{
    [x: string]: {
        token: Buffer;
    };
}>;
export declare const isTcTokenExpired: (timestamp: string | number | undefined | null) => boolean;
export declare const shouldSendNewTcToken: (senderTimestamp?: string | number) => boolean;
export declare const resolveTcTokenJid: (jid: string, getLIDForPN?: (jid: string) => Promise<string | null>) => Promise<string>;
export declare const resolveIssuanceJid: (jid: string, issueToLid: boolean | undefined, getLIDForPN?: (jid: string) => Promise<string | null>, getPNForLID?: (jid: string) => Promise<string | null>) => Promise<string>;
export declare const buildTcTokenFromJid: ({ authState, jid, baseContent, getLIDForPN }: {
    authState: any;
    jid: string;
    baseContent?: BinaryNode[];
    getLIDForPN?: (jid: string) => Promise<string | null>;
}) => Promise<BinaryNode[] | undefined>;
export declare const storeTcTokensFromIqResult: ({ result, fallbackJid, keys, getLIDForPN, onNewJidStored }: {
    result: BinaryNode;
    fallbackJid?: string;
    keys: any;
    getLIDForPN?: (jid: string) => Promise<string | null>;
    onNewJidStored?: (jid: string) => void;
}) => Promise<void>;
