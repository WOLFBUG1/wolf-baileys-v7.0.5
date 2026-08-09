export declare enum RetryReason {
    UnknownError = 0,
    SignalErrorNoSession = 1,
    SignalErrorInvalidKey = 2,
    SignalErrorInvalidKeyId = 3,
    SignalErrorInvalidMessage = 4,
    SignalErrorInvalidSignature = 5,
    SignalErrorFutureMessage = 6,
    SignalErrorBadMac = 7,
    SignalErrorInvalidSession = 8,
    SignalErrorInvalidMsgKey = 9,
    BadBroadcastEphemeralSetting = 10,
    UnknownCompanionNoPrekey = 11,
    AdvFailure = 12,
    StatusRevokeDelay = 13
}
export declare class MessageRetryManager {
    constructor(logger: any, maxMsgRetryCount?: number);
    statistics: {
        totalRetries: number;
        successfulRetries: number;
        failedRetries: number;
        mediaRetries: number;
        sessionRecreations: number;
        phoneRequests: number;
    };
    addRecentMessage(to: string, id: string, message: any): void;
    getRecentMessage(to: string, id: string): {
        message: any;
        timestamp: number;
    } | undefined;
    getRecentMessageById(id: string): {
        message: any;
        timestamp: number;
    } | undefined;
    shouldRecreateSession(jid: string, hasSession: boolean, errorCode?: RetryReason): {
        reason: string;
        recreate: boolean;
    };
    parseRetryErrorCode(errorAttr?: string): RetryReason | undefined;
    isMacError(errorCode?: RetryReason): boolean;
    incrementRetryCount(messageId: string): number;
    getRetryCount(messageId: string): number;
    hasExceededMaxRetries(messageId: string): boolean;
    markRetrySuccess(messageId: string): void;
    markRetryFailed(messageId: string): void;
    schedulePhoneRequest(messageId: string, callback: () => void, delay?: number): void;
    cancelPendingPhoneRequest(messageId: string): void;
    saveBaseKey(addr: string, msgId: string, baseKey: Uint8Array): void;
    hasSameBaseKey(addr: string, msgId: string, baseKey: Uint8Array): boolean;
    deleteBaseKey(addr: string, msgId: string): void;
    clear(): void;
}
