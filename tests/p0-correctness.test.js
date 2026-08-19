const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')

jest.mock('../lib/Utils/crypto', () => ({
    Curve: {
        generateKeyPair: () => ({ private: Buffer.alloc(32), public: Buffer.alloc(32) })
    },
    signedKeyPair: keyPair => ({ keyPair, signature: Buffer.alloc(64), keyId: 1 })
}))
jest.mock('../lib/Defaults', () => ({ DEFAULT_ORIGIN: 'https://web.whatsapp.com' }))
jest.mock('../WAProto', () => ({
    proto: { Message: { AppStateSyncKeyData: { fromObject: value => value } } }
}))
jest.mock('../lib/Utils/generics', () => ({
    BufferJSON: {
        replacer: (_key, value) => value,
        reviver: (_key, value) => value
    },
    delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
    generateRegistrationId: () => 1
}))

const { SessionOperationScheduler } = require('../lib/Utils/session-operation-scheduler')
const { addTransactionCapability } = require('../lib/Utils/auth-utils')
const { useMultiFileAuthState } = require('../lib/Utils/use-multi-file-auth-state')
const { WebSocketClient } = require('../lib/Socket/Client/web-socket-client')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const immediate = () => new Promise(resolve => setImmediate(resolve))
const logger = { trace: () => {}, warn: () => {} }
const botIndexPath = path.resolve(__dirname, '..', '..', '..', '..', 'Bot', '9-8-2026', 'index.js')
const botSource = fs.readFileSync(botIndexPath, 'utf8')

jest.setTimeout(30000)

describe('P0 auth persistence correctness', () => {
    test.each([
        ['credentials', 'creds.json', auth => auth.saveCreds()],
        ['signal key / rename', 'session-broken.json', auth => auth.state.keys.set({ session: { broken: { value: 1 } } })]
    ])('%s write rejection remains observable and blocks replacement', async (_label, destination, write) => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-p0-auth-'))
        try {
            fs.writeFileSync(path.join(folder, 'sentinel.txt'), 'preserve')
            const auth = await useMultiFileAuthState(folder)
            fs.mkdirSync(path.join(folder, destination))

            await expect(write(auth)).rejects.toMatchObject({ code: expect.any(String) })
            await expect(auth.authStoreController.flush()).rejects.toMatchObject({
                code: 'WA_AUTH_PERSISTENCE_FAILED'
            })
            expect(auth.authStoreController.accepting).toBe(false)

            let replacementStarted = false
            await expect(useMultiFileAuthState(folder).then(value => {
                replacementStarted = true
                return value
            })).rejects.toMatchObject({ code: 'WA_AUTH_PERSISTENCE_FAILED' })
            expect(replacementStarted).toBe(false)
            expect(fs.readFileSync(path.join(folder, 'sentinel.txt'), 'utf8')).toBe('preserve')
            expect(fs.existsSync(folder)).toBe(true)
        } finally {
            fs.rmSync(folder, { recursive: true, force: true })
        }
    })

    test('permanent controller disposal removes the coordinator after a clean retirement', async () => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-p0-dispose-'))
        try {
            const first = await useMultiFileAuthState(folder)
            expect(first.authStoreController.generation).toBe(1)
            await first.authStoreController.dispose()
            const second = await useMultiFileAuthState(folder)
            expect(second.authStoreController.generation).toBe(1)
            await second.authStoreController.dispose()
        } finally {
            fs.rmSync(folder, { recursive: true, force: true })
        }
    })
})

describe('P0 scheduler child ownership', () => {
    test.each(['pause', 'close'])('%s keeps a fire-and-forget nested child accounted until it finishes', async action => {
        const scheduler = new SessionOperationScheduler({
            minConcurrency: 1,
            maxConcurrency: 1,
            initialConcurrency: 1,
            queryMinConcurrency: 1,
            queryMaxConcurrency: 1,
            queryInitialConcurrency: 1,
            adaptiveIntervalMs: 60000
        })
        let releaseChild
        const childGate = new Promise(resolve => { releaseChild = resolve })
        let childRunning = false
        let childFinished = false
        const outer = scheduler.schedule('operation', async () => {
            scheduler.schedule('operation', async () => {
                childRunning = true
                await childGate
                childFinished = true
            })
            await immediate()
        })

        while (!childRunning) await immediate()
        if (action === 'pause') scheduler.pause('test')
        else scheduler.close()

        expect(childFinished).toBe(false)
        expect(scheduler.getMetrics().activeOperations).toBe(1)
        releaseChild()
        await outer
        expect(childFinished).toBe(true)
        expect(scheduler.getMetrics().activeOperations).toBe(0)
        scheduler.close()
    })

    test('awaited nested operation and query remain reentrant without deadlock', async () => {
        const scheduler = new SessionOperationScheduler({
            minConcurrency: 1,
            maxConcurrency: 1,
            initialConcurrency: 1,
            queryMinConcurrency: 1,
            queryMaxConcurrency: 1,
            queryInitialConcurrency: 1,
            adaptiveIntervalMs: 60000
        })
        await expect(scheduler.schedule('operation', async () => {
            await scheduler.schedule('operation', async () => true)
            return scheduler.schedule('query', async () => 'ok')
        })).resolves.toBe('ok')
        expect(scheduler.getMetrics().activeOperations).toBe(0)
        scheduler.close()
    })

    test('invalid scheduler limits normalize to finite safe integers', () => {
        const scheduler = new SessionOperationScheduler({
            minConcurrency: NaN,
            maxConcurrency: 1e100,
            initialConcurrency: -4.5,
            queryMinConcurrency: -2,
            queryMaxConcurrency: 3.9,
            queryInitialConcurrency: Infinity,
            maxQueueSize: -10.2
        })
        for (const value of [
            scheduler.minConcurrency,
            scheduler.maxConcurrency,
            scheduler.currentConcurrency,
            scheduler.queryMinConcurrency,
            scheduler.queryMaxConcurrency,
            scheduler.currentQueryConcurrency,
            scheduler.maxQueueSize
        ]) {
            expect(Number.isSafeInteger(value)).toBe(true)
            expect(value).toBeGreaterThan(0)
        }
        scheduler.close()
    })
})

describe('P0 auth transaction ownership', () => {
    test('unawaited delayed get is owned by A and cannot populate B cache', async () => {
        let releaseRead
        const readGate = new Promise(resolve => { releaseRead = resolve })
        let reads = 0
        const state = {
            get: async (_type, ids) => {
                reads += 1
                if (reads === 1) await readGate
                return Object.fromEntries(ids.map(id => [id, reads === 1 ? 'A' : 'B']))
            },
            set: async () => {}
        }
        const store = addTransactionCapability(state, logger, { maxCommitRetries: 2, delayBetweenTriesMs: 1 })
        let aFinished = false
        const a = store.transaction(async () => {
            store.get('session', ['key'])
        }).then(() => { aFinished = true })
        await immediate()
        const b = store.transaction(() => store.get('session', ['key']))
        await immediate()
        expect(aFinished).toBe(false)
        expect(reads).toBe(1)
        releaseRead()
        await a
        await expect(b).resolves.toEqual({ key: 'B' })
        expect(reads).toBe(2)
    })

    test('expired callbacks never write into a later transaction context', async () => {
        const committed = []
        const state = {
            get: async () => ({}),
            set: async data => { committed.push(JSON.parse(JSON.stringify(data))) }
        }
        const store = addTransactionCapability(state, logger, { maxCommitRetries: 2, delayBetweenTriesMs: 1 })
        const emitter = new EventEmitter()
        const delayed = []
        await store.transaction(async () => {
            store.set({ session: { fromA: true } })
            delayed.push(new Promise(resolve => setTimeout(() => {
                Promise.resolve(store.set({ session: { timer: true } })).then(resolve)
            }, 10)))
            delayed.push(new Promise(resolve => setImmediate(() => {
                Promise.resolve(store.set({ session: { immediate: true } })).then(resolve)
            })))
            delayed.push(new Promise(resolve => {
                queueMicrotask(() => Promise.resolve(store.set({ session: { microtask: true } })).then(resolve))
            }))
            delayed.push(Promise.resolve().then(() => store.set({ session: { promise: true } })))
            delayed.push(new Promise(resolve => emitter.once('write', () => {
                Promise.resolve(store.set({ session: { event: true } })).then(resolve)
            })))
            setTimeout(() => emitter.emit('write'), 10)
        })
        let releaseB
        const bGate = new Promise(resolve => { releaseB = resolve })
        const b = store.transaction(async () => {
            store.set({ session: { fromB: true } })
            await bGate
        })
        await delay(20)
        releaseB()
        await Promise.all([b, ...delayed])

        const transactionBCommit = committed.find(batch => batch.session?.fromB)
        expect(transactionBCommit).toEqual({ session: { fromB: true } })
        expect(transactionBCommit.session).not.toHaveProperty('timer')
        expect(transactionBCommit.session).not.toHaveProperty('immediate')
        expect(transactionBCommit.session).not.toHaveProperty('event')
    })

    test('nested transactions share only their owning outer context', async () => {
        const committed = []
        const store = addTransactionCapability({
            get: async () => ({}),
            set: async data => committed.push(data)
        }, logger, { maxCommitRetries: 2, delayBetweenTriesMs: 1 })
        await store.transaction(async () => {
            store.set({ session: { outer: true } })
            await store.transaction(async () => store.set({ session: { inner: true } }))
        })
        expect(committed).toEqual([{ session: { outer: true, inner: true } }])
    })
})

describe('P0 socket connect semantics', () => {
    test('connect rejection is awaitable, handled, and a second connect can retry', async () => {
        const unhandled = []
        const onUnhandled = reason => unhandled.push(reason)
        process.on('unhandledRejection', onUnhandled)
        const client = new WebSocketClient(new URL('wss://example.invalid'), {})
        const connectSpy = jest.spyOn(client, 'connect')
            .mockRejectedValueOnce(new Error('transport setup failed'))
            .mockResolvedValueOnce(undefined)
        try {
            const socketSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'Socket', 'socket.js'), 'utf8')
            const blockStart = socketSource.indexOf('let connectionStarted = false;')
            const blockEnd = socketSource.indexOf('    // called when all offline notifs are handled', blockStart)
            const connectBlock = socketSource.slice(blockStart, blockEnd)
            const buildConnect = new Function('ws', 'ev', 'creds', `
                let closed = false;
                let didStartBuffer = false;
                ${connectBlock}
                return { connect, close: () => { closed = true; } };
            `)
            const ev = { buffer: jest.fn(), emit: jest.fn() }
            const socket = buildConnect(client, ev, {})
            await expect(socket.connect()).rejects.toThrow('transport setup failed')
            await immediate()
            expect(unhandled).toHaveLength(0)
            await expect(socket.connect()).resolves.toBe(true)
            expect(connectSpy).toHaveBeenCalledTimes(2)
            await expect(socket.connect()).resolves.toBe(true)
            expect(connectSpy).toHaveBeenCalledTimes(2)
        } finally {
            connectSpy.mockRestore()
            process.off('unhandledRejection', onUnhandled)
        }
    })
})

describe('P0 active application persistence and shutdown policy', () => {
    test('replacement preparation rejects persistence failure before any Socket B can start', async () => {
        const start = botSource.indexOf('async function prepareWhatsappSessionReplacement')
        const end = botSource.indexOf('\nasync function retireWhatsappRuntimeSocket', start)
        const source = botSource.slice(start, end)
        const number = '201000000000'
        const oldSocket = { __wolfOperationScheduler: { pause: jest.fn() } }
        const lifecycle = {
            generation: 7,
            socket: oldSocket,
            authStoreController: { beginRetirement: jest.fn(), retireAndFlush: jest.fn() },
            applicationMessageListeners: []
        }
        const sessions = new Map([[number, oldSocket]])
        const status = new Map([[number, true]])
        const prepare = new Function(
            'normalizeWhatsappNumberValue', 'whatsappRecoveryStates', 'createWhatsappCommandAbortError',
            'getWhatsappSessionLifecycle', 'sessions', 'WHATSAPP_SESSION_STATE', 'whatsappStatusMap',
            'clearOwnerSelectedWhatsappSessionNumber', 'preserveWhatsappApplicationListeners',
            'flushWhatsappLifecycleCredentialWrites', 'whatsappSessionProxies',
            'whatsappSessionConnectedAt', 'detachAndCloseWhatsappSocket', 'makeWASocket',
            'whatsappSessionLifecycles', 'getErrorMessage',
            `${source}; return prepareWhatsappSessionReplacement;`
        )(
            value => value, new Map(), message => new Error(message), () => lifecycle, sessions,
            { RETIRING: 'RETIRING', OFFLINE: 'OFFLINE' }, status, () => {}, () => {},
            async () => { const error = new Error('disk failed'); error.code = 'WA_AUTH_PERSISTENCE_FAILED'; throw error },
            new Map(), new Map(), jest.fn(), jest.fn(), new Map([[number, lifecycle]]), error => error.message
        )
        let socketBStarted = false
        await expect((async () => {
            await prepare(number)
            socketBStarted = true
        })()).rejects.toMatchObject({ code: 'WA_AUTH_PERSISTENCE_FAILED' })
        expect(socketBStarted).toBe(false)
        expect(sessions.get(number)).toBe(oldSocket)
        expect(status.get(number)).toBe(false)
        expect(lifecycle.state).toBe('OFFLINE')
        expect(lifecycle.lastFailure.type).toBe('AUTH_PERSISTENCE_FAILED')
        expect(lifecycle.authStoreController.retireAndFlush).not.toHaveBeenCalled()
    })

    test('socket-construction failure permanently releases its accepting auth generation', async () => {
        const start = botSource.indexOf('async function createWhatsappSocketWithAuthCleanup')
        const end = botSource.indexOf('\nasync function retireWhatsappRuntimeSocket', start)
        const source = botSource.slice(start, end)
        const controller = {
            accepting: true,
            beginRetirement: jest.fn(function () { this.accepting = false }),
            dispose: jest.fn(async function () { this.accepting = false })
        }
        const lifecycles = new Map([['number', { authStoreController: controller }]])
        const createSocket = new Function(
            'makeWASocket', 'whatsappSessionLifecycles',
            `${source}; return createWhatsappSocketWithAuthCleanup;`
        )(() => { throw new Error('socket setup failed') }, lifecycles)
        await expect(createSocket('number', controller, {})).rejects.toThrow('socket setup failed')
        expect(controller.beginRetirement).toHaveBeenCalled()
        expect(controller.dispose).toHaveBeenCalled()
        expect(controller.accepting).toBe(false)
        expect(lifecycles.get('number').authStoreController).toBeNull()
    })

    test('shutdown closes schedulers, rejects new work, and reports credential flush failure', async () => {
        const start = botSource.indexOf('async function flushPendingWhatsappCredentialWrites')
        const end = botSource.indexOf('\nfunction beginWhatsappGracefulShutdown', start)
        const source = botSource.slice(start, end)
        const scheduler = new SessionOperationScheduler({ adaptiveIntervalMs: 60000 })
        const persistenceFailure = new Error('credential disk failure')
        const lifecycle = {
            socket: { __wolfOperationScheduler: scheduler },
            authStoreController: { beginRetirement: jest.fn(), flush: jest.fn().mockRejectedValue(persistenceFailure) }
        }
        const flush = new Function(
            'whatsappSessionLifecycles', 'flushWhatsappLifecycleCredentialWrites',
            'createWhatsappCommandAbortError',
            `${source}; return flushPendingWhatsappCredentialWrites;`
        )(
            new Map([['number', lifecycle]]), async () => {},
            message => Object.assign(new Error(message), { code: 'WHATSAPP_COMMAND_ABORTED' })
        )
        await expect(flush(1000)).rejects.toMatchObject({ code: 'WA_AUTH_PERSISTENCE_FAILED' })
        expect(scheduler.getMetrics().closed).toBe(true)
        await expect(scheduler.schedule('operation', async () => true)).rejects.toMatchObject({
            code: 'SCHEDULER_CLOSED'
        })
    })
})
