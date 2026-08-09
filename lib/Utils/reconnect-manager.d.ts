export declare const DisconnectStatusCode: {
    readonly connectionClosed: 428;
    readonly connectionLost: 408;
    readonly timedOut: 408;
    readonly loggedOut: 401;
    readonly badSession: 500;
    readonly restartRequired: 515;
    readonly multideviceMismatch: 411;
    readonly forbidden: 403;
    readonly connectionReplaced: 440;
    readonly unavailableService: 503;
};
export declare const FATAL_DISCONNECT_STATUS_CODES: Set<number>;
export declare const RECONNECTABLE_STATUS_CODES: Set<number>;
export type ReconnectDecision = {
    reconnect: boolean;
    fatal: boolean;
    resetSession: boolean;
    statusCode?: number;
    delayMs: number;
    reason: string;
};
export type ReconnectManagerOptions = {
    logger?: any;
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    restartDelayMs?: number;
    randomizationFactor?: number;
    initialAttempt?: number;
    reconnect?: (decision: ReconnectDecision) => void | Promise<void>;
    onDecision?: (decision: ReconnectDecision) => void;
};
export declare const getDisconnectStatusCode: (input: any) => number | undefined;
export declare const isFatalDisconnect: (input: any, fatalStatusCodes?: Set<number>) => boolean;
export declare const isRestartRequiredDisconnect: (input: any) => boolean;
export declare const isRecoverableDisconnect: (input: any, reconnectableStatusCodes?: Set<number>) => boolean;
export declare const getReconnectDecision: (input: any, options?: ReconnectManagerOptions & {
    attempt?: number;
}) => ReconnectDecision;
export declare const makeReconnectManager: (options?: ReconnectManagerOptions) => {
    readonly attempts: number;
    reset(): void;
    clear(): void;
    decide(input: any): ReconnectDecision;
    schedule(input: any): ReconnectDecision;
    bind(ev: {
        on(event: 'connection.update', listener: (update: any) => void): any;
        off(event: 'connection.update', listener: (update: any) => void): any;
    }, connect: (decision: ReconnectDecision) => void | Promise<void>): () => void;
};
