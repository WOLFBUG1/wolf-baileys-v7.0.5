export declare const S_WHATSAPP_NET = "@s.whatsapp.net";
export declare const OFFICIAL_BIZ_JID = "16505361212@c.us";
export declare const SERVER_JID = "server@c.us";
export declare const PSA_WID = "0@c.us";
export declare const STORIES_JID = "status@broadcast";
export declare const WAJIDDomains: {
    readonly WHATSAPP: 0;
    readonly LID: 1;
    readonly HOSTED: 2;
    readonly HOSTED_LID: 3;
};
export type JidServer = 'c.us' | 'g.us' | 'broadcast' | 's.whatsapp.net' | 'call' | 'lid' | 'hosted' | 'hosted.lid' | 'newsletter';
export declare const getServerFromDomainType: (initialServer: string, domainType?: number) => string;
export type JidWithDevice = {
    user: string;
    device?: number;
    server?: JidServer | string;
    domainType?: number;
};
export type FullJid = JidWithDevice & {
    server: JidServer | string;
    domainType?: number;
};
export declare const jidEncode: (user: string | number | null, server: JidServer, device?: number, agent?: number) => string;
export declare const jidDecode: (jid: string | undefined) => FullJid | undefined;
/** is the jid a user */
export declare const areJidsSameUser: (jid1: string | undefined, jid2: string | undefined) => boolean;
/** is the jid a user */
export declare const isJidUser: (jid: string | undefined) => boolean | undefined;
/** is the jid a group */
export declare const isLidUser: (jid: string | undefined) => boolean | undefined;
export declare const isPnUser: (jid: string | undefined) => boolean | undefined;
export declare const isHostedPnUser: (jid: string | undefined) => boolean | undefined;
export declare const isHostedLidUser: (jid: string | undefined) => boolean | undefined;
/** is the jid a broadcast */
export declare const isJidBroadcast: (jid: string | undefined) => boolean | undefined;
/** is the jid a group */
export declare const isJidGroup: (jid: string | undefined) => boolean | undefined;
/** is the jid the status broadcast */
export declare const isJidStatusBroadcast: (jid: string) => boolean;
/** is the jid the newsletter */
export declare const isJidNewsLetter: (jid: string | undefined) => boolean | undefined;
export declare const jidNormalizedUser: (jid: string | undefined) => string;
export declare const transferDevice: (from: string, to: string) => string;
