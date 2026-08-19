"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageRetryManager = exports.RetryReason = void 0;
const RECENT_MESSAGES_SIZE = 512;
const MESSAGE_KEY_SEPARATOR = '\u0000';
const RECREATE_SESSION_TIMEOUT = 60 * 60 * 1000;
const RECENT_MESSAGES_TTL = 5 * 60 * 1000;
const RETRY_COUNTER_TTL = 15 * 60 * 1000;
const PHONE_REQUEST_DELAY = 3000;
const RETRY_STATE_MAX_SIZE = 2048;
const PENDING_PHONE_REQUEST_MAX_SIZE = 2048;
var RetryReason;
(function (RetryReason) {
    RetryReason[RetryReason["UnknownError"] = 0] = "UnknownError";
    RetryReason[RetryReason["SignalErrorNoSession"] = 1] = "SignalErrorNoSession";
    RetryReason[RetryReason["SignalErrorInvalidKey"] = 2] = "SignalErrorInvalidKey";
    RetryReason[RetryReason["SignalErrorInvalidKeyId"] = 3] = "SignalErrorInvalidKeyId";
    RetryReason[RetryReason["SignalErrorInvalidMessage"] = 4] = "SignalErrorInvalidMessage";
    RetryReason[RetryReason["SignalErrorInvalidSignature"] = 5] = "SignalErrorInvalidSignature";
    RetryReason[RetryReason["SignalErrorFutureMessage"] = 6] = "SignalErrorFutureMessage";
    RetryReason[RetryReason["SignalErrorBadMac"] = 7] = "SignalErrorBadMac";
    RetryReason[RetryReason["SignalErrorInvalidSession"] = 8] = "SignalErrorInvalidSession";
    RetryReason[RetryReason["SignalErrorInvalidMsgKey"] = 9] = "SignalErrorInvalidMsgKey";
    RetryReason[RetryReason["BadBroadcastEphemeralSetting"] = 10] = "BadBroadcastEphemeralSetting";
    RetryReason[RetryReason["UnknownCompanionNoPrekey"] = 11] = "UnknownCompanionNoPrekey";
    RetryReason[RetryReason["AdvFailure"] = 12] = "AdvFailure";
    RetryReason[RetryReason["StatusRevokeDelay"] = 13] = "StatusRevokeDelay";
})(RetryReason || (exports.RetryReason = RetryReason = {}));
const MAC_ERROR_CODES = new Set([RetryReason.SignalErrorInvalidMessage, RetryReason.SignalErrorBadMac]);
class TimedCache {
    constructor({ max = Infinity, ttl = 0 } = {}) {
        this.max = max;
        this.ttl = ttl;
        this.map = new Map();
        this.writesSinceSweep = 0;
    }
    get(key) {
        const entry = this.map.get(key);
        if (!entry) {
            return undefined;
        }
        if (entry.expiresAt && entry.expiresAt <= Date.now()) {
            this.map.delete(key);
            return undefined;
        }
        return entry.value;
    }
    set(key, value) {
        this.writesSinceSweep += 1;
        if (this.writesSinceSweep >= 64) {
            this.sweepExpired();
            this.writesSinceSweep = 0;
        }
        if (this.map.has(key)) {
            this.map.delete(key);
        }
        this.map.set(key, {
            value,
            expiresAt: this.ttl ? Date.now() + this.ttl : 0
        });
        while (this.map.size > this.max) {
            const oldestKey = this.map.keys().next().value;
            this.map.delete(oldestKey);
        }
    }
    delete(key) {
        this.map.delete(key);
    }
    sweepExpired(now = Date.now()) {
        if (!this.ttl) {
            return 0;
        }
        let removed = 0;
        for (const [key, entry] of this.map) {
            if (entry.expiresAt && entry.expiresAt <= now) {
                this.map.delete(key);
                removed += 1;
            }
        }
        return removed;
    }
    clear() {
        this.map.clear();
        this.writesSinceSweep = 0;
    }
}
class MessageRetryManager {
    constructor(logger, maxMsgRetryCount = 5) {
        this.logger = logger;
        this.maxMsgRetryCount = maxMsgRetryCount;
        this.recentMessagesMap = new TimedCache({ max: RECENT_MESSAGES_SIZE, ttl: RECENT_MESSAGES_TTL });
        this.messageKeyIndex = new TimedCache({ max: RECENT_MESSAGES_SIZE, ttl: RECENT_MESSAGES_TTL });
        this.sessionRecreateHistory = new TimedCache({ max: RETRY_STATE_MAX_SIZE, ttl: RECREATE_SESSION_TIMEOUT * 2 });
        this.retryCounters = new TimedCache({ max: RETRY_STATE_MAX_SIZE, ttl: RETRY_COUNTER_TTL });
        this.baseKeys = new TimedCache({ max: 1024, ttl: RETRY_COUNTER_TTL });
        this.pendingPhoneRequests = {};
        this.statistics = this.makeStatistics();
    }
    makeStatistics() {
        return {
            totalRetries: 0,
            successfulRetries: 0,
            failedRetries: 0,
            mediaRetries: 0,
            sessionRecreations: 0,
            phoneRequests: 0
        };
    }
    addRecentMessage(to, id, message) {
        if (!to || !id || !message) {
            return;
        }
        const keyStr = this.keyToString({ to, id });
        this.recentMessagesMap.set(keyStr, { message, timestamp: Date.now() });
        this.messageKeyIndex.set(id, keyStr);
        this.logger === null || this.logger === void 0 ? void 0 : this.logger.debug({ to, id }, 'added message to retry cache');
    }
    getRecentMessage(to, id) {
        return this.recentMessagesMap.get(this.keyToString({ to, id }));
    }
    getRecentMessageById(id) {
        const keyStr = this.messageKeyIndex.get(id);
        return keyStr ? this.recentMessagesMap.get(keyStr) : undefined;
    }
    shouldRecreateSession(jid, hasSession, errorCode) {
        if (!hasSession) {
            this.sessionRecreateHistory.set(jid, Date.now());
            this.statistics.sessionRecreations++;
            return { reason: "we don't have a Signal session with them", recreate: true };
        }
        if (this.isMacError(errorCode)) {
            this.sessionRecreateHistory.set(jid, Date.now());
            this.statistics.sessionRecreations++;
            this.logger === null || this.logger === void 0 ? void 0 : this.logger.warn({ jid, errorCode }, 'MAC error detected, forcing session recreation');
            return { reason: `MAC error (${errorCode}), immediate session recreation`, recreate: true };
        }
        const now = Date.now();
        const prevTime = this.sessionRecreateHistory.get(jid);
        if (!prevTime || now - prevTime > RECREATE_SESSION_TIMEOUT) {
            this.sessionRecreateHistory.set(jid, now);
            this.statistics.sessionRecreations++;
            return { reason: 'retry count > 1 and over an hour since last recreation', recreate: true };
        }
        return { reason: '', recreate: false };
    }
    parseRetryErrorCode(errorAttr) {
        if (errorAttr === undefined || errorAttr === '') {
            return undefined;
        }
        const code = parseInt(errorAttr, 10);
        if (Number.isNaN(code)) {
            return undefined;
        }
        return code >= RetryReason.UnknownError && code <= RetryReason.StatusRevokeDelay ? code : RetryReason.UnknownError;
    }
    isMacError(errorCode) {
        return errorCode !== undefined && MAC_ERROR_CODES.has(errorCode);
    }
    incrementRetryCount(messageId) {
        this.retryCounters.set(messageId, (this.retryCounters.get(messageId) || 0) + 1);
        this.statistics.totalRetries++;
        return this.retryCounters.get(messageId);
    }
    getRetryCount(messageId) {
        return this.retryCounters.get(messageId) || 0;
    }
    hasExceededMaxRetries(messageId) {
        return this.getRetryCount(messageId) >= this.maxMsgRetryCount;
    }
    markRetrySuccess(messageId) {
        this.statistics.successfulRetries++;
        this.retryCounters.delete(messageId);
        this.cancelPendingPhoneRequest(messageId);
        this.removeRecentMessage(messageId);
    }
    markRetryFailed(messageId) {
        this.statistics.failedRetries++;
        this.retryCounters.delete(messageId);
        this.cancelPendingPhoneRequest(messageId);
        this.removeRecentMessage(messageId);
    }
    schedulePhoneRequest(messageId, callback, delay = PHONE_REQUEST_DELAY) {
        this.cancelPendingPhoneRequest(messageId);
        const pendingIds = Object.keys(this.pendingPhoneRequests);
        if (pendingIds.length >= PENDING_PHONE_REQUEST_MAX_SIZE) {
            this.cancelPendingPhoneRequest(pendingIds[0]);
        }
        this.pendingPhoneRequests[messageId] = setTimeout(() => {
            delete this.pendingPhoneRequests[messageId];
            this.statistics.phoneRequests++;
            callback();
        }, delay);
    }
    cancelPendingPhoneRequest(messageId) {
        const timeout = this.pendingPhoneRequests[messageId];
        if (timeout) {
            clearTimeout(timeout);
            delete this.pendingPhoneRequests[messageId];
        }
    }
    saveBaseKey(addr, msgId, baseKey) {
        this.baseKeys.set(`${addr}:${msgId}`, baseKey);
    }
    hasSameBaseKey(addr, msgId, baseKey) {
        const stored = this.baseKeys.get(`${addr}:${msgId}`);
        if (!stored || stored.length !== baseKey.length) {
            return false;
        }
        for (let i = 0; i < stored.length; i++) {
            if (stored[i] !== baseKey[i]) {
                return false;
            }
        }
        return true;
    }
    deleteBaseKey(addr, msgId) {
        this.baseKeys.delete(`${addr}:${msgId}`);
    }
    keyToString(key) {
        return `${key.to}${MESSAGE_KEY_SEPARATOR}${key.id}`;
    }
    removeRecentMessage(messageId) {
        const keyStr = this.messageKeyIndex.get(messageId);
        if (!keyStr) {
            return;
        }
        this.recentMessagesMap.delete(keyStr);
        this.messageKeyIndex.delete(messageId);
    }
    clear() {
        this.recentMessagesMap.clear();
        this.messageKeyIndex.clear();
        this.sessionRecreateHistory.clear();
        this.retryCounters.clear();
        this.baseKeys.clear();
        for (const messageId of Object.keys(this.pendingPhoneRequests)) {
            this.cancelPendingPhoneRequest(messageId);
        }
        this.statistics = this.makeStatistics();
    }
}
exports.MessageRetryManager = MessageRetryManager;
