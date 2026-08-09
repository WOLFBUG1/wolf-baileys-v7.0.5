"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LIDMappingStore = void 0;
const WABinary_1 = require("../WABinary/jid-utils");
class LIDMappingStore {
    constructor(keys, logger, pnToLIDFunc) {
        this.keys = keys;
        this.logger = logger;
        this.pnToLIDFunc = pnToLIDFunc;
        this.mappingCache = new Map();
        this.inflightLIDLookups = new Map();
        this.inflightPNLookups = new Map();
    }
    async storeLIDPNMappings(pairs) {
        if (!Array.isArray(pairs) || pairs.length === 0) {
            return;
        }
        const batchData = {};
        for (const pair of pairs) {
            const lid = pair === null || pair === void 0 ? void 0 : pair.lid;
            const pn = pair === null || pair === void 0 ? void 0 : pair.pn;
            if (!(((0, WABinary_1.isLidUser)(lid) && (0, WABinary_1.isPnUser)(pn)) || ((0, WABinary_1.isPnUser)(lid) && (0, WABinary_1.isLidUser)(pn)))) {
                this.logger === null || this.logger === void 0 ? void 0 : this.logger.warn({ lid, pn }, 'invalid LID-PN mapping');
                continue;
            }
            const normalizedLid = (0, WABinary_1.isLidUser)(lid) ? lid : pn;
            const normalizedPn = (0, WABinary_1.isPnUser)(pn) ? pn : lid;
            const lidDecoded = (0, WABinary_1.jidDecode)(normalizedLid);
            const pnDecoded = (0, WABinary_1.jidDecode)(normalizedPn);
            if (!(lidDecoded === null || lidDecoded === void 0 ? void 0 : lidDecoded.user) || !(pnDecoded === null || pnDecoded === void 0 ? void 0 : pnDecoded.user)) {
                continue;
            }
            batchData[pnDecoded.user] = lidDecoded.user;
            batchData[`${lidDecoded.user}_reverse`] = pnDecoded.user;
            this.mappingCache.set(`pn:${pnDecoded.user}`, lidDecoded.user);
            this.mappingCache.set(`lid:${lidDecoded.user}`, pnDecoded.user);
        }
        if (!Object.keys(batchData).length) {
            return;
        }
        if (typeof this.keys.transaction === 'function') {
            await this.keys.transaction(async () => {
                await this.keys.set({ 'lid-mapping': batchData });
            }, 'lid-mapping');
        }
        else {
            await this.keys.set({ 'lid-mapping': batchData });
        }
    }
    async getLIDForPN(pn) {
        const result = await this.getLIDsForPNs([pn]);
        return (result === null || result === void 0 ? void 0 : result[0]) ? result[0].lid : null;
    }
    async getLIDsForPNs(pns) {
        const unique = [...new Set((pns || []).filter(jid => (0, WABinary_1.isPnUser)(jid)))];
        if (!unique.length) {
            return null;
        }
        const cacheKey = unique.slice().sort().join(',');
        const inflight = this.inflightLIDLookups.get(cacheKey);
        if (inflight) {
            return inflight;
        }
        const promise = this._getLIDsForPNs(unique);
        this.inflightLIDLookups.set(cacheKey, promise);
        try {
            return await promise;
        }
        finally {
            this.inflightLIDLookups.delete(cacheKey);
        }
    }
    async _getLIDsForPNs(pns) {
        const successfulPairs = {};
        const missing = [];
        for (const pn of pns) {
            const decoded = (0, WABinary_1.jidDecode)(pn);
            if (!(decoded === null || decoded === void 0 ? void 0 : decoded.user)) {
                continue;
            }
            let lidUser = this.mappingCache.get(`pn:${decoded.user}`);
            if (!lidUser) {
                const stored = await this.keys.get('lid-mapping', [decoded.user]);
                lidUser = stored[decoded.user];
                if (lidUser) {
                    this.mappingCache.set(`pn:${decoded.user}`, lidUser);
                    this.mappingCache.set(`lid:${lidUser}`, decoded.user);
                }
            }
            if (lidUser) {
                successfulPairs[pn] = {
                    lid: (0, WABinary_1.jidEncode)(lidUser, decoded.server === 'hosted' ? 'hosted.lid' : 'lid', decoded.device),
                    pn
                };
            }
            else {
                missing.push(pn);
            }
        }
        if (missing.length && this.pnToLIDFunc) {
            const fetched = await this.pnToLIDFunc(missing);
            if (fetched === null || fetched === void 0 ? void 0 : fetched.length) {
                await this.storeLIDPNMappings(fetched);
                for (const pair of fetched) {
                    if (pair === null || pair === void 0 ? void 0 : pair.pn) {
                        successfulPairs[pair.pn] = pair;
                    }
                }
            }
        }
        const values = Object.values(successfulPairs);
        return values.length ? values : null;
    }
    async getPNForLID(lid) {
        const result = await this.getPNsForLIDs([lid]);
        return (result === null || result === void 0 ? void 0 : result[0]) ? result[0].pn : null;
    }
    async getPNsForLIDs(lids) {
        const unique = [...new Set((lids || []).filter(jid => (0, WABinary_1.isLidUser)(jid)))];
        if (!unique.length) {
            return null;
        }
        const cacheKey = unique.slice().sort().join(',');
        const inflight = this.inflightPNLookups.get(cacheKey);
        if (inflight) {
            return inflight;
        }
        const promise = this._getPNsForLIDs(unique);
        this.inflightPNLookups.set(cacheKey, promise);
        try {
            return await promise;
        }
        finally {
            this.inflightPNLookups.delete(cacheKey);
        }
    }
    async _getPNsForLIDs(lids) {
        const successfulPairs = {};
        for (const lid of lids) {
            const decoded = (0, WABinary_1.jidDecode)(lid);
            if (!(decoded === null || decoded === void 0 ? void 0 : decoded.user)) {
                continue;
            }
            let pnUser = this.mappingCache.get(`lid:${decoded.user}`);
            if (!pnUser) {
                const reverseKey = `${decoded.user}_reverse`;
                const stored = await this.keys.get('lid-mapping', [reverseKey]);
                pnUser = stored[reverseKey];
                if (pnUser) {
                    this.mappingCache.set(`lid:${decoded.user}`, pnUser);
                    this.mappingCache.set(`pn:${pnUser}`, decoded.user);
                }
            }
            if (pnUser) {
                successfulPairs[lid] = {
                    lid,
                    pn: (0, WABinary_1.jidEncode)(pnUser, decoded.server === 'hosted.lid' ? 'hosted' : 's.whatsapp.net', decoded.device)
                };
            }
        }
        const values = Object.values(successfulPairs);
        return values.length ? values : null;
    }
    close() {
        this.mappingCache.clear();
        this.inflightLIDLookups.clear();
        this.inflightPNLookups.clear();
    }
}
exports.LIDMappingStore = LIDMappingStore;
