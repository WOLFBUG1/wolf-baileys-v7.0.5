"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeReconnectManager = exports.getReconnectDecision = exports.isRecoverableDisconnect = exports.isRestartRequiredDisconnect = exports.isFatalDisconnect = exports.getDisconnectStatusCode = exports.RECONNECTABLE_STATUS_CODES = exports.FATAL_DISCONNECT_STATUS_CODES = exports.DisconnectStatusCode = void 0;
exports.DisconnectStatusCode = {
    connectionClosed: 428,
    connectionLost: 408,
    timedOut: 408,
    loggedOut: 401,
    badSession: 500,
    restartRequired: 515,
    multideviceMismatch: 411,
    forbidden: 403,
    connectionReplaced: 440,
    unavailableService: 503
};
exports.FATAL_DISCONNECT_STATUS_CODES = new Set([
    exports.DisconnectStatusCode.loggedOut,
    exports.DisconnectStatusCode.forbidden,
    exports.DisconnectStatusCode.multideviceMismatch,
    exports.DisconnectStatusCode.connectionReplaced
]);
exports.RECONNECTABLE_STATUS_CODES = new Set([
    exports.DisconnectStatusCode.restartRequired,
    exports.DisconnectStatusCode.connectionLost,
    exports.DisconnectStatusCode.timedOut,
    exports.DisconnectStatusCode.connectionClosed,
    exports.DisconnectStatusCode.badSession,
    exports.DisconnectStatusCode.unavailableService
]);
const getDisconnectStatusCode = (input) => {
    var _a, _b, _c, _d, _e, _f;
    if (!input) {
        return undefined;
    }
    const error = (_b = (_a = input.lastDisconnect) === null || _a === void 0 ? void 0 : _a.error) !== null && _b !== void 0 ? _b : input.error;
    const code = (_f = (_e = (_d = (_c = error === null || error === void 0 ? void 0 : error.output) === null || _c === void 0 ? void 0 : _c.statusCode) !== null && _d !== void 0 ? _d : error === null || error === void 0 ? void 0 : error.statusCode) !== null && _e !== void 0 ? _e : input.statusCode) !== null && _f !== void 0 ? _f : input.code;
    const numeric = Number(code);
    return Number.isFinite(numeric) ? numeric : undefined;
};
exports.getDisconnectStatusCode = getDisconnectStatusCode;
const isFatalDisconnect = (input, fatalStatusCodes = exports.FATAL_DISCONNECT_STATUS_CODES) => {
    const statusCode = (0, exports.getDisconnectStatusCode)(input);
    return statusCode !== undefined && fatalStatusCodes.has(statusCode);
};
exports.isFatalDisconnect = isFatalDisconnect;
const isRestartRequiredDisconnect = (input) => {
    return (0, exports.getDisconnectStatusCode)(input) === exports.DisconnectStatusCode.restartRequired;
};
exports.isRestartRequiredDisconnect = isRestartRequiredDisconnect;
const isRecoverableDisconnect = (input, reconnectableStatusCodes = exports.RECONNECTABLE_STATUS_CODES) => {
    const statusCode = (0, exports.getDisconnectStatusCode)(input);
    return statusCode === undefined || reconnectableStatusCodes.has(statusCode);
};
exports.isRecoverableDisconnect = isRecoverableDisconnect;
const withJitter = (delayMs, randomizationFactor) => {
    if (!delayMs || !randomizationFactor) {
        return delayMs;
    }
    const variance = delayMs * randomizationFactor;
    return Math.max(0, Math.round(delayMs - variance + Math.random() * variance * 2));
};
const getReconnectDecision = (input, options = {}) => {
    var _a, _b, _c, _d, _e, _f;
    const statusCode = (0, exports.getDisconnectStatusCode)(input);
    const attempt = (_a = options.attempt) !== null && _a !== void 0 ? _a : 0;
    const maxRetries = (_b = options.maxRetries) !== null && _b !== void 0 ? _b : 10;
    const initialDelayMs = (_c = options.initialDelayMs) !== null && _c !== void 0 ? _c : 1000;
    const maxDelayMs = (_d = options.maxDelayMs) !== null && _d !== void 0 ? _d : 30000;
    const restartDelayMs = (_e = options.restartDelayMs) !== null && _e !== void 0 ? _e : 500;
    const randomizationFactor = (_f = options.randomizationFactor) !== null && _f !== void 0 ? _f : 0.2;
    if (statusCode !== undefined && exports.FATAL_DISCONNECT_STATUS_CODES.has(statusCode)) {
        return {
            reconnect: false,
            fatal: true,
            resetSession: statusCode === exports.DisconnectStatusCode.loggedOut,
            statusCode,
            delayMs: 0,
            reason: 'fatal disconnect; do not reconnect automatically'
        };
    }
    if (attempt >= maxRetries) {
        return {
            reconnect: false,
            fatal: false,
            resetSession: false,
            statusCode,
            delayMs: 0,
            reason: `max reconnect attempts reached (${maxRetries})`
        };
    }
    if ((0, exports.isRestartRequiredDisconnect)(input)) {
        return {
            reconnect: true,
            fatal: false,
            resetSession: false,
            statusCode,
            delayMs: restartDelayMs,
            reason: 'restart required; reconnect using the same auth state'
        };
    }
    if (statusCode === undefined || exports.RECONNECTABLE_STATUS_CODES.has(statusCode)) {
        const delayMs = withJitter(Math.min(maxDelayMs, initialDelayMs * Math.pow(2, attempt)), randomizationFactor);
        return {
            reconnect: true,
            fatal: false,
            resetSession: false,
            statusCode,
            delayMs,
            reason: statusCode === undefined ? 'unknown close; reconnect with backoff' : 'recoverable disconnect; reconnect with backoff'
        };
    }
    return {
        reconnect: false,
        fatal: false,
        resetSession: false,
        statusCode,
        delayMs: 0,
        reason: 'disconnect code is not marked reconnectable'
    };
};
exports.getReconnectDecision = getReconnectDecision;
const makeReconnectManager = (options = {}) => {
    var _a;
    let attempt = 0;
    let timer;
    const logger = options.logger;
    const onDecision = options.onDecision;
    const manager = {
        get attempts() {
            return attempt;
        },
        reset() {
            attempt = 0;
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
        },
        clear() {
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
        },
        decide(input) {
            return (0, exports.getReconnectDecision)(input, { ...options, attempt });
        },
        schedule(input) {
            const decision = manager.decide(input);
            const reconnect = options.reconnect;
            onDecision === null || onDecision === void 0 ? void 0 : onDecision(decision);
            logger === null || logger === void 0 ? void 0 : logger.debug === null || logger === void 0 ? void 0 : logger.debug({ decision, attempt }, 'reconnect decision');
            if (!decision.reconnect) {
                return decision;
            }
            attempt++;
            if (timer) {
                clearTimeout(timer);
            }
            if (reconnect) {
                timer = setTimeout(() => {
                    timer = undefined;
                    reconnect(decision);
                }, decision.delayMs);
            }
            return decision;
        },
        bind(ev, connect) {
            const listener = (update) => {
                if ((update === null || update === void 0 ? void 0 : update.connection) === 'open') {
                    manager.reset();
                    return;
                }
                if ((update === null || update === void 0 ? void 0 : update.connection) !== 'close') {
                    return;
                }
                const previousReconnect = options.reconnect;
                options.reconnect = connect;
                manager.schedule(update);
                options.reconnect = previousReconnect;
            };
            ev.on('connection.update', listener);
            return () => {
                ev.off('connection.update', listener);
                manager.clear();
            };
        }
    };
    attempt = (_a = options.initialAttempt) !== null && _a !== void 0 ? _a : 0;
    return manager;
};
exports.makeReconnectManager = makeReconnectManager;
