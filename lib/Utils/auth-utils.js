"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initAuthCreds = exports.addTransactionCapability = exports.makeCacheableSignalKeyStore = void 0;
const crypto_1 = require("crypto");
const async_hooks_1 = require("async_hooks");
const node_cache_1 = __importDefault(require("node-cache"));
const uuid_1 = require("uuid");
const Defaults_1 = require("../Defaults");
const crypto_2 = require("./crypto");
const generics_1 = require("./generics");
/**
 * Adds caching capability to a SignalKeyStore
 * @param store the store to add caching to
 * @param logger to log trace events
 * @param _cache cache store to use
 */
function makeCacheableSignalKeyStore(store, logger, _cache) {
    const cache = _cache || new node_cache_1.default({
        stdTTL: Defaults_1.DEFAULT_CACHE_TTLS.SIGNAL_STORE,
        useClones: false,
        deleteOnExpire: true,
    });
    function getUniqueId(type, id) {
        return `${type}.${id}`;
    }
    return {
        async get(type, ids) {
            const data = {};
            const idsToFetch = [];
            for (const id of ids) {
                const item = cache.get(getUniqueId(type, id));
                if (typeof item !== 'undefined') {
                    data[id] = item;
                }
                else {
                    idsToFetch.push(id);
                }
            }
            if (idsToFetch.length) {
                logger.trace({ items: idsToFetch.length }, 'loading from store');
                const fetched = await store.get(type, idsToFetch);
                for (const id of idsToFetch) {
                    const item = fetched[id];
                    if (item) {
                        data[id] = item;
                        cache.set(getUniqueId(type, id), item);
                    }
                }
            }
            return data;
        },
        async set(data) {
            let keys = 0;
            for (const type in data) {
                for (const id in data[type]) {
                    cache.set(getUniqueId(type, id), data[type][id]);
                    keys += 1;
                }
            }
            logger.trace({ keys }, 'updated cache');
            await store.set(data);
        },
        async clear() {
            var _a;
            cache.flushAll();
            await ((_a = store.clear) === null || _a === void 0 ? void 0 : _a.call(store));
        }
    };
}
exports.makeCacheableSignalKeyStore = makeCacheableSignalKeyStore;
/**
 * Adds DB like transaction capability (https://en.wikipedia.org/wiki/Database_transaction) to the SignalKeyStore,
 * this allows batch read & write operations & improves the performance of the lib
 * @param state the key store to apply this capability to
 * @param logger logger to log events
 * @returns SignalKeyStore with transaction capability
 */
const addTransactionCapability = (state, logger, { maxCommitRetries, delayBetweenTriesMs }) => {
    const transactionContext = new async_hooks_1.AsyncLocalStorage();
    let transactionQueue = Promise.resolve();
    const getActiveContext = () => {
        const context = transactionContext.getStore();
        return context && context.active === true ? context : null;
    };
    const createStaleTransactionError = () => {
        const error = new Error('Stale WhatsApp auth transaction operation');
        error.code = 'WA_AUTH_TRANSACTION_STALE';
        return error;
    };
    const trackContextOperation = (context, work) => {
        const operation = Promise.resolve().then(async () => {
            if (!context.active || transactionContext.getStore() !== context) {
                throw createStaleTransactionError();
            }
            return work();
        });
        context.pending.add(operation);
        operation.then(
            () => context.pending.delete(operation),
            error => {
                context.pending.delete(operation);
                context.failures.push(error);
            }
        );
        return operation;
    };
    const drainContextOperations = async context => {
        while (context.pending.size) {
            await Promise.allSettled([...context.pending]);
        }
        if (context.failures.length) {
            throw context.failures.length === 1
                ? context.failures[0]
                : new AggregateError(context.failures, 'WhatsApp auth transaction operations failed');
        }
    };
    return {
        get: async (type, ids) => {
            const context = getActiveContext();
            if (context) {
                return trackContextOperation(context, async () => {
                const dict = context.cache[type];
                const idsRequiringFetch = dict
                    ? ids.filter(item => typeof dict[item] === 'undefined')
                    : ids;
                if (idsRequiringFetch.length) {
                    context.dbQueries += 1;
                    const result = await state.get(type, idsRequiringFetch);
                    if (!context.active || transactionContext.getStore() !== context) {
                        throw createStaleTransactionError();
                    }
                    context.cache[type] || (context.cache[type] = {});
                    Object.assign(context.cache[type], result);
                }
                return ids.reduce((dict, id) => {
                    var _a;
                    const value = (_a = context.cache[type]) === null || _a === void 0 ? void 0 : _a[id];
                    if (value) {
                        dict[id] = value;
                    }
                    return dict;
                }, {});
                });
            }
            else {
                return state.get(type, ids);
            }
        },
        set: data => {
            const context = getActiveContext();
            if (context) {
                logger.trace({ types: Object.keys(data) }, 'caching in transaction');
                for (const key in data) {
                    context.cache[key] = context.cache[key] || {};
                    Object.assign(context.cache[key], data[key]);
                    context.mutations[key] = context.mutations[key] || {};
                    Object.assign(context.mutations[key], data[key]);
                }
            }
            else {
                return state.set(data);
            }
        },
        isInTransaction,
        async transaction(work) {
            if (isInTransaction()) {
                return work();
            }
            let releaseQueue;
            const previousTransaction = transactionQueue;
            transactionQueue = new Promise(resolve => {
                releaseQueue = resolve;
            });
            await previousTransaction.catch(() => { });
            logger.trace('entering transaction');
            const transactionLease = {
                active: true,
                cache: {},
                mutations: {},
                dbQueries: 0,
                pending: new Set(),
                failures: []
            };
            try {
                return await transactionContext.run(transactionLease, async () => {
                    let result;
                    let workError;
                    try {
                        result = await work();
                    }
                    catch (error) {
                        workError = error;
                    }
                    let pendingError;
                    try {
                        await drainContextOperations(transactionLease);
                    }
                    catch (error) {
                        pendingError = error;
                    }
                    if (workError) throw workError;
                    if (pendingError) throw pendingError;
                    if (Object.keys(transactionLease.mutations).length) {
                        logger.trace('committing transaction');
                        // retry mechanism to ensure we've some recovery
                        // in case a transaction fails in the first attempt
                        let tries = maxCommitRetries;
                        let lastError;
                        while (tries) {
                            tries -= 1;
                            try {
                                await state.set(transactionLease.mutations);
                                logger.trace({ dbQueriesInTransaction: transactionLease.dbQueries }, 'committed transaction');
                                lastError = undefined;
                                break;
                            }
                            catch (error) {
                                lastError = error;
                                logger.warn(`failed to commit ${Object.keys(transactionLease.mutations).length} mutations, tries left=${tries}`);
                                if (tries) {
                                    await (0, generics_1.delay)(delayBetweenTriesMs);
                                }
                            }
                        }
                        if (lastError) {
                            throw lastError;
                        }
                    }
                    else {
                        logger.trace('no mutations in transaction');
                    }
                    return result;
                });
            }
            finally {
                transactionLease.active = false;
                releaseQueue();
            }
        }
    };
    function isInTransaction() {
        return Boolean(getActiveContext());
    }
};
exports.addTransactionCapability = addTransactionCapability;
const initAuthCreds = () => {
    const identityKey = crypto_2.Curve.generateKeyPair();
    return {
        noiseKey: crypto_2.Curve.generateKeyPair(),
        pairingEphemeralKeyPair: crypto_2.Curve.generateKeyPair(),
        signedIdentityKey: identityKey,
        signedPreKey: (0, crypto_2.signedKeyPair)(identityKey, 1),
        registrationId: (0, generics_1.generateRegistrationId)(),
        advSecretKey: (0, crypto_1.randomBytes)(32).toString('base64'),
        processedHistoryMessages: [],
        nextPreKeyId: 1,
        firstUnuploadedPreKeyId: 1,
        accountSyncCounter: 0,
        accountSettings: {
            unarchiveChats: false
        },
        // mobile creds
        deviceId: Buffer.from((0, uuid_1.v4)().replace(/-/g, ''), 'hex').toString('base64url'),
        phoneId: (0, uuid_1.v4)(),
        identityId: (0, crypto_1.randomBytes)(20),
        registered: false,
        backupToken: (0, crypto_1.randomBytes)(20),
        registration: {},
        pairingCode: undefined,
        lastPropHash: undefined,
        routingInfo: undefined,
    };
};
exports.initAuthCreds = initAuthCreds;
