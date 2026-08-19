"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useMultiFileAuthState = void 0;
const async_mutex_1 = require("async-mutex");
const promises_1 = require("fs/promises");
const path_1 = require("path");
const WAProto_1 = require("../../WAProto");
const auth_utils_1 = require("./auth-utils");
const generics_1 = require("./generics");
const fileLocks = new Map();
const authStoreCoordinators = new Map();
let atomicWriteCounter = 0;
const STALE_AUTH_TEMP_FILE_MS = 60 * 60 * 1000;
const withFileLock = async (path, work) => {
    let entry = fileLocks.get(path);
    if (!entry) {
        entry = { mutex: new async_mutex_1.Mutex(), users: 0 };
        fileLocks.set(path, entry);
    }
    entry.users += 1;
    const release = await entry.mutex.acquire();
    try {
        return await work();
    }
    finally {
        release();
        entry.users -= 1;
        if (entry.users === 0 && fileLocks.get(path) === entry) {
            fileLocks.delete(path);
        }
    }
};
const mapWithConcurrency = async (items, concurrency, worker) => {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
};
const getAuthStoreCoordinator = (folder) => {
    let coordinator = authStoreCoordinators.get(folder);
    if (!coordinator) {
        coordinator = {
            activationMutex: new async_mutex_1.Mutex(),
            currentLease: null,
            nextGeneration: 0,
            users: 0
        };
        authStoreCoordinators.set(folder, coordinator);
    }
    return coordinator;
};
const createAuthPersistenceError = (folder, generation, failures) => {
    const uniqueFailures = [...new Set(failures.filter(Boolean))];
    const error = new AggregateError(uniqueFailures, `Failed to persist WhatsApp auth store generation ${generation}: ${folder}`);
    error.code = 'WA_AUTH_PERSISTENCE_FAILED';
    error.statusCode = 500;
    error.failureCount = uniqueFailures.length;
    return error;
};
const createRetiredAuthStoreError = (folder, generation) => {
    const error = new Error(`WhatsApp auth store generation ${generation} is retired: ${folder}`);
    error.code = 'WA_AUTH_STORE_RETIRED';
    error.statusCode = 428;
    return error;
};
const flushAuthLease = async (lease) => {
    while (lease.pending.size) {
        const results = await Promise.allSettled([...lease.pending]);
        for (const result of results) {
            if (result.status === 'rejected' && !lease.failures.includes(result.reason)) {
                lease.failures.push(result.reason);
            }
        }
    }
    if (lease.failures.length) {
        throw createAuthPersistenceError(lease.folder, lease.generation, lease.failures);
    }
};
const retireAuthLease = async (coordinator, lease) => {
    if (!lease) {
        return;
    }
    lease.accepting = false;
    await flushAuthLease(lease);
    lease.active = false;
    if (coordinator.currentLease === lease) {
        coordinator.currentLease = null;
    }
};
const cleanupStaleAuthTempFiles = async (folder) => {
    const names = await (0, promises_1.readdir)(folder).catch(error => {
        if ((error === null || error === void 0 ? void 0 : error.code) === 'ENOENT') {
            return [];
        }
        throw error;
    });
    const now = Date.now();
    await mapWithConcurrency(names.filter(name => /\.json\.\d+\.\d+\.tmp$/.test(name)), 8, async (name) => {
        const temporaryPath = (0, path_1.join)(folder, name);
        const info = await (0, promises_1.stat)(temporaryPath).catch(error => {
            if ((error === null || error === void 0 ? void 0 : error.code) === 'ENOENT') {
                return null;
            }
            throw error;
        });
        if (!info || now - info.mtimeMs < STALE_AUTH_TEMP_FILE_MS) {
            return;
        }
        await (0, promises_1.unlink)(temporaryPath).catch(error => {
            if ((error === null || error === void 0 ? void 0 : error.code) !== 'ENOENT') {
                throw error;
            }
        });
    });
};
/**
 * stores the full authentication state in a single folder.
 * Far more efficient than singlefileauthstate
 *
 * Again, I wouldn't endorse this for any production level use other than perhaps a bot.
 * Would recommend writing an auth state for use with a proper SQL or No-SQL DB
 * */
const useMultiFileAuthState = async (folder) => {
    folder = (0, path_1.resolve)(folder);
    const coordinator = getAuthStoreCoordinator(folder);
    coordinator.users += 1;
    const releaseActivation = await coordinator.activationMutex.acquire();
    let activationReleased = false;
    const releaseStoreActivation = () => {
        if (activationReleased) {
            return;
        }
        activationReleased = true;
        releaseActivation();
        coordinator.users -= 1;
        if (coordinator.users === 0 && !coordinator.currentLease && authStoreCoordinators.get(folder) === coordinator) {
            authStoreCoordinators.delete(folder);
        }
    };
    let lease;
    try {
        if (coordinator.currentLease) {
            await retireAuthLease(coordinator, coordinator.currentLease);
        }
        lease = {
            generation: ++coordinator.nextGeneration,
            active: true,
            accepting: true,
            pending: new Set(),
            failures: [],
            folder
        };
        coordinator.currentLease = lease;
    }
    catch (error) {
        releaseStoreActivation();
        throw error;
    }
    const runMutation = (work) => {
        if (!lease.active || !lease.accepting || coordinator.currentLease !== lease) {
            return Promise.reject(createRetiredAuthStoreError(folder, lease.generation));
        }
        const mutation = (async () => work())();
        lease.pending.add(mutation);
        mutation.then(
            () => lease.pending.delete(mutation),
            error => {
                lease.pending.delete(mutation);
                lease.accepting = false;
                if (!lease.failures.includes(error)) lease.failures.push(error);
            }
        );
        return mutation;
    };
    const fixFileName = (file) => { var _a; return (_a = file === null || file === void 0 ? void 0 : file.replace(/\//g, '__')) === null || _a === void 0 ? void 0 : _a.replace(/:/g, '-'); };
    const writeData = async (data, file) => {
        const filePath = (0, path_1.join)(folder, fixFileName(file));
        return withFileLock(filePath, async () => {
            const temporaryPath = `${filePath}.${process.pid}.${++atomicWriteCounter}.tmp`;
            try {
                const serialized = JSON.stringify(data, generics_1.BufferJSON.replacer);
                await (0, promises_1.writeFile)(temporaryPath, serialized);
                await (0, promises_1.rename)(temporaryPath, filePath);
            }
            finally {
                await (0, promises_1.unlink)(temporaryPath).catch(error => {
                    if ((error === null || error === void 0 ? void 0 : error.code) !== 'ENOENT') {
                        throw error;
                    }
                });
            }
        });
    };
    const readData = async (file) => {
        const filePath = (0, path_1.join)(folder, fixFileName(file));
        try {
            return await withFileLock(filePath, async () => {
                const data = await (0, promises_1.readFile)(filePath, { encoding: 'utf-8' });
                try {
                    return JSON.parse(data, generics_1.BufferJSON.reviver);
                }
                catch (error) {
                    const parseError = new Error(`Corrupted WhatsApp auth file: ${filePath}`);
                    parseError.code = 'WA_AUTH_FILE_CORRUPTED';
                    parseError.cause = error;
                    throw parseError;
                }
            });
        }
        catch (error) {
            if ((error === null || error === void 0 ? void 0 : error.code) === 'ENOENT') {
                return null;
            }
            throw error;
        }
    };
    const removeData = async (file) => {
        const filePath = (0, path_1.join)(folder, fixFileName(file));
        return withFileLock(filePath, async () => {
            try {
                await (0, promises_1.unlink)(filePath);
            }
            catch (error) {
                if ((error === null || error === void 0 ? void 0 : error.code) !== 'ENOENT') {
                    throw error;
                }
            }
        });
    };
    try {
        const folderInfo = await (0, promises_1.stat)(folder).catch(error => {
            if ((error === null || error === void 0 ? void 0 : error.code) === 'ENOENT') {
                return null;
            }
            throw error;
        });
        if (folderInfo) {
            if (!folderInfo.isDirectory()) {
                throw new Error(`found something that is not a directory at ${folder}, either delete it or specify a different location`);
            }
        }
        else {
            await (0, promises_1.mkdir)(folder, { recursive: true });
        }
        await cleanupStaleAuthTempFiles(folder);
        const creds = await readData('creds.json') || (0, auth_utils_1.initAuthCreds)();
        const result = {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await mapWithConcurrency(ids, 32, async (id) => {
                        let value = await readData(`${type}-${id}.json`);
                        if (type === 'app-state-sync-key' && value) {
                            value = WAProto_1.proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    });
                    return data;
                },
                set: async (data) => runMutation(async () => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const file = `${category}-${id}.json`;
                            tasks.push({ value, file });
                        }
                    }
                    await mapWithConcurrency(tasks, 32, ({ value, file }) => value ? writeData(value, file) : removeData(file));
                })
            }
        },
        saveCreds: async () => runMutation(() => writeData(creds, 'creds.json')),
        authStoreController: {
            generation: lease.generation,
            get active() {
                return lease.active;
            },
            get accepting() {
                return lease.accepting;
            },
            beginRetirement() {
                lease.accepting = false;
            },
            async flush() {
                await flushAuthLease(lease);
            },
            async retireAndFlush() {
                const release = await coordinator.activationMutex.acquire();
                try {
                    await retireAuthLease(coordinator, lease);
                }
                finally {
                    release();
                }
            },
            async dispose() {
                const release = await coordinator.activationMutex.acquire();
                try {
                    await retireAuthLease(coordinator, lease);
                    if (coordinator.users === 0 && !coordinator.currentLease && authStoreCoordinators.get(folder) === coordinator) {
                        authStoreCoordinators.delete(folder);
                    }
                }
                finally {
                    release();
                }
            },
            getPendingWriteCount() {
                return lease.pending.size;
            }
        }
        };
        releaseStoreActivation();
        return result;
    }
    catch (error) {
        lease.accepting = false;
        await flushAuthLease(lease);
        lease.active = false;
        if (coordinator.currentLease === lease) {
            coordinator.currentLease = null;
        }
        releaseStoreActivation();
        throw error;
    }
};
exports.useMultiFileAuthState = useMultiFileAuthState;
