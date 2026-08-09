"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storeTcTokensFromIqResult = exports.buildTcTokenFromJid = exports.resolveIssuanceJid = exports.resolveTcTokenJid = exports.shouldSendNewTcToken = exports.isTcTokenExpired = exports.buildMergedTcTokenIndexWrite = exports.readTcTokenIndex = exports.TC_TOKEN_INDEX_KEY = void 0;
const WABinary_1 = require("../WABinary");
const BOT_PHONE_REGEX = /^1313555\d{4}$|^131655500\d{2}$/;
const TC_TOKEN_BUCKET_DURATION = 604800;
const TC_TOKEN_NUM_BUCKETS = 4;
exports.TC_TOKEN_INDEX_KEY = '__index';
const isJidMetaAI = (jid) => (jid === null || jid === void 0 ? void 0 : jid.endsWith('@bot')) || false;
const isRegularUser = (jid) => {
    if (!jid) {
        return false;
    }
    const user = (jid.split('@')[0]) || '';
    if (user === '0' || BOT_PHONE_REGEX.test(user) || isJidMetaAI(jid)) {
        return false;
    }
    return !!((0, WABinary_1.isPnUser)(jid) || (0, WABinary_1.isLidUser)(jid) || (0, WABinary_1.isHostedPnUser)(jid) || (0, WABinary_1.isHostedLidUser)(jid) || jid.endsWith('@c.us'));
};
const readTcTokenIndex = async (keys) => {
    var _a;
    const data = await keys.get('tctoken', [exports.TC_TOKEN_INDEX_KEY]);
    const entry = data[exports.TC_TOKEN_INDEX_KEY];
    if (!((_a = entry === null || entry === void 0 ? void 0 : entry.token) === null || _a === void 0 ? void 0 : _a.length)) {
        return [];
    }
    try {
        const parsed = JSON.parse(Buffer.from(entry.token).toString());
        return Array.isArray(parsed)
            ? parsed.filter(jid => typeof jid === 'string' && jid.length > 0 && jid !== exports.TC_TOKEN_INDEX_KEY)
            : [];
    }
    catch (_b) {
        return [];
    }
};
exports.readTcTokenIndex = readTcTokenIndex;
const buildMergedTcTokenIndexWrite = async (keys, addedJids) => {
    const persisted = await (0, exports.readTcTokenIndex)(keys);
    const merged = new Set(persisted);
    for (const jid of addedJids) {
        if (jid && jid !== exports.TC_TOKEN_INDEX_KEY) {
            merged.add(jid);
        }
    }
    return {
        [exports.TC_TOKEN_INDEX_KEY]: { token: Buffer.from(JSON.stringify([...merged])) }
    };
};
exports.buildMergedTcTokenIndexWrite = buildMergedTcTokenIndexWrite;
const isTcTokenExpired = (timestamp) => {
    if (timestamp === null || timestamp === undefined) {
        return true;
    }
    const ts = typeof timestamp === 'string' ? parseInt(timestamp) : timestamp;
    if (Number.isNaN(ts)) {
        return true;
    }
    const now = Math.floor(Date.now() / 1000);
    const currentBucket = Math.floor(now / TC_TOKEN_BUCKET_DURATION);
    const cutoffBucket = currentBucket - (TC_TOKEN_NUM_BUCKETS - 1);
    return ts < cutoffBucket * TC_TOKEN_BUCKET_DURATION;
};
exports.isTcTokenExpired = isTcTokenExpired;
const shouldSendNewTcToken = (senderTimestamp) => {
    if (senderTimestamp === undefined) {
        return true;
    }
    const now = Math.floor(Date.now() / 1000);
    return Math.floor(now / TC_TOKEN_BUCKET_DURATION) > Math.floor(Number(senderTimestamp) / TC_TOKEN_BUCKET_DURATION);
};
exports.shouldSendNewTcToken = shouldSendNewTcToken;
const resolveTcTokenJid = async (jid, getLIDForPN) => {
    if ((0, WABinary_1.isLidUser)(jid)) {
        return jid;
    }
    const lid = await (getLIDForPN === null || getLIDForPN === void 0 ? void 0 : getLIDForPN(jid));
    return lid !== null && lid !== void 0 ? lid : jid;
};
exports.resolveTcTokenJid = resolveTcTokenJid;
const resolveIssuanceJid = async (jid, issueToLid, getLIDForPN, getPNForLID) => {
    if (issueToLid) {
        if ((0, WABinary_1.isLidUser)(jid)) {
            return jid;
        }
        const lid = await (getLIDForPN === null || getLIDForPN === void 0 ? void 0 : getLIDForPN(jid));
        return lid !== null && lid !== void 0 ? lid : jid;
    }
    if (!(0, WABinary_1.isLidUser)(jid)) {
        return jid;
    }
    const pn = await (getPNForLID === null || getPNForLID === void 0 ? void 0 : getPNForLID(jid));
    return pn !== null && pn !== void 0 ? pn : jid;
};
exports.resolveIssuanceJid = resolveIssuanceJid;
const buildTcTokenFromJid = async ({ authState, jid, baseContent = [], getLIDForPN }) => {
    var _a;
    try {
        const storageJid = await (0, exports.resolveTcTokenJid)(jid, getLIDForPN);
        const tcTokenData = await authState.keys.get('tctoken', [storageJid]);
        const entry = tcTokenData === null || tcTokenData === void 0 ? void 0 : tcTokenData[storageJid];
        const tcTokenBuffer = entry === null || entry === void 0 ? void 0 : entry.token;
        if (!((_a = tcTokenBuffer) === null || _a === void 0 ? void 0 : _a.length) || (0, exports.isTcTokenExpired)(entry === null || entry === void 0 ? void 0 : entry.timestamp)) {
            if (tcTokenBuffer) {
                const cleared = (entry === null || entry === void 0 ? void 0 : entry.senderTimestamp) !== undefined
                    ? { token: Buffer.alloc(0), senderTimestamp: entry.senderTimestamp }
                    : null;
                await authState.keys.set({ tctoken: { [storageJid]: cleared } });
            }
            return baseContent.length > 0 ? baseContent : undefined;
        }
        baseContent.push({ tag: 'tctoken', attrs: {}, content: tcTokenBuffer });
        return baseContent;
    }
    catch (_b) {
        return baseContent.length > 0 ? baseContent : undefined;
    }
};
exports.buildTcTokenFromJid = buildTcTokenFromJid;
const storeTcTokensFromIqResult = async ({ result, fallbackJid, keys, getLIDForPN, onNewJidStored }) => {
    const tokensNode = (0, WABinary_1.getBinaryNodeChild)(result, 'tokens');
    if (!tokensNode) {
        return;
    }
    const tokenNodes = (0, WABinary_1.getBinaryNodeChildren)(tokensNode, 'token');
    for (const tokenNode of tokenNodes) {
        if (tokenNode.attrs.type !== 'trusted_contact' || !(tokenNode.content instanceof Uint8Array)) {
            continue;
        }
        const rawJid = (0, WABinary_1.jidNormalizedUser)(fallbackJid || tokenNode.attrs.jid);
        if (!isRegularUser(rawJid)) {
            continue;
        }
        const storageJid = await (0, exports.resolveTcTokenJid)(rawJid, getLIDForPN);
        const existingTcData = await keys.get('tctoken', [storageJid]);
        const existingEntry = existingTcData[storageJid];
        const existingTs = (existingEntry === null || existingEntry === void 0 ? void 0 : existingEntry.timestamp) ? Number(existingEntry.timestamp) : 0;
        const incomingTs = tokenNode.attrs.t ? Number(tokenNode.attrs.t) : 0;
        if (!incomingTs || (existingTs > 0 && existingTs > incomingTs)) {
            continue;
        }
        await keys.set({
            tctoken: {
                [storageJid]: {
                    ...existingEntry,
                    token: Buffer.from(tokenNode.content),
                    timestamp: tokenNode.attrs.t
                }
            }
        });
        onNewJidStored === null || onNewJidStored === void 0 ? void 0 : onNewJidStored(storageJid);
    }
};
exports.storeTcTokensFromIqResult = storeTcTokensFromIqResult;
