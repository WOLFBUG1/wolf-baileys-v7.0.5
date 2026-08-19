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
    proto: {
        Message: {
            AppStateSyncKeyData: { fromObject: value => value }
        }
    }
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
const { WebSocketClient } = require('../lib/Socket/Client/web-socket-client')
const { useMultiFileAuthState } = require('../lib/Utils/use-multi-file-auth-state')
const { addTransactionCapability } = require('../lib/Utils/auth-utils')
const { MessageRetryManager } = require('../lib/Utils/message-retry-manager')
const { getReconnectDecision } = require('../lib/Utils/reconnect-manager')

jest.setTimeout(30000)

const immediate = () => new Promise(resolve => setImmediate(resolve))

describe('per-session operation scheduler', () => {
    test.each([10, 50, 100, 500, 1000])('bounds active work at %i submitted operations', async count => {
        const scheduler = new SessionOperationScheduler({
            minConcurrency: 8,
            maxConcurrency: 8,
            initialConcurrency: 8,
            queryMinConcurrency: 3,
            queryMaxConcurrency: 3,
            queryInitialConcurrency: 3,
            maxQueueSize: 1100,
            queueTimeoutMs: 10000,
            adaptiveIntervalMs: 60000
        })
        let active = 0
        let maximum = 0
        await Promise.all(Array.from({ length: count }, (_, index) => scheduler.schedule(
            index % 4 === 0 ? 'query' : 'operation',
            async () => {
                active += 1
                maximum = Math.max(maximum, active)
                await immediate()
                active -= 1
            }
        )))
        expect(maximum).toBeLessThanOrEqual(8)
        expect(scheduler.getMetrics().activeOperations).toBe(0)
        expect(scheduler.getMetrics().activeQueries).toBe(0)
        scheduler.close()
    })

    test('enforces a separate lower query budget', async () => {
        const scheduler = new SessionOperationScheduler({
            minConcurrency: 10,
            maxConcurrency: 10,
            initialConcurrency: 10,
            queryMinConcurrency: 2,
            queryMaxConcurrency: 2,
            queryInitialConcurrency: 2,
            maxQueueSize: 100,
            adaptiveIntervalMs: 60000
        })
        let activeQueries = 0
        let maximumQueries = 0
        await Promise.all(Array.from({ length: 50 }, () => scheduler.schedule('query', async () => {
            activeQueries += 1
            maximumQueries = Math.max(maximumQueries, activeQueries)
            await immediate()
            activeQueries -= 1
        })))
        expect(maximumQueries).toBe(2)
        scheduler.close()
    })

    test('rejects queue overflow and expires paused work', async () => {
        const scheduler = new SessionOperationScheduler({
            minConcurrency: 1,
            maxConcurrency: 1,
            initialConcurrency: 1,
            maxQueueSize: 3,
            queueTimeoutMs: 25,
            adaptiveIntervalMs: 60000
        })
        scheduler.pause('test')
        const queued = Array.from({ length: 3 }, () => scheduler.schedule('operation', async () => true))
        const queuedOutcomes = queued.map(promise => promise.then(
            value => ({ ok: true, value }),
            error => ({ ok: false, error })
        ))
        await expect(scheduler.schedule('operation', async () => true)).rejects.toMatchObject({
            code: 'SCHEDULER_OVERLOADED',
            statusCode: 429
        })
        await expect(queuedOutcomes[0]).resolves.toMatchObject({ ok: false, error: { code: 'SCHEDULER_QUEUE_TIMEOUT' } })
        await Promise.all(queuedOutcomes.slice(1))
        expect(scheduler.getMetrics().queueDepth).toBe(0)
        scheduler.close()
    })

    test('backpressure blocks draining without creating unbounded active work', async () => {
        let releasePressure
        const pressureGate = new Promise(resolve => { releasePressure = resolve })
        let pressured = true
        const transport = {
            bufferedAmount: 8 * 1024 * 1024,
            waitForBackpressure: async () => {
                if (pressured) await pressureGate
            }
        }
        const scheduler = new SessionOperationScheduler({
            minConcurrency: 4,
            maxConcurrency: 4,
            initialConcurrency: 4,
            maxQueueSize: 100,
            adaptiveIntervalMs: 60000
        }).setTransport(transport)
        let executed = 0
        const work = Array.from({ length: 50 }, () => scheduler.schedule('operation', async () => { executed += 1 }))
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(executed).toBe(0)
        expect(scheduler.getMetrics().activeOperations).toBeLessThanOrEqual(4)
        pressured = false
        transport.bufferedAmount = 0
        releasePressure()
        await Promise.all(work)
        expect(executed).toBe(50)
        scheduler.close()
    })

    test('hundreds of post-recovery retries re-enter bounded scheduling', async () => {
        const scheduler = new SessionOperationScheduler({
            minConcurrency: 5,
            maxConcurrency: 5,
            initialConcurrency: 5,
            maxQueueSize: 600,
            adaptiveIntervalMs: 60000
        })
        let active = 0
        let maximum = 0
        const retries = Array.from({ length: 500 }, () => {
            scheduler.recordRetry()
            return scheduler.schedule('operation', async () => {
                active += 1
                maximum = Math.max(maximum, active)
                await immediate()
                active -= 1
            })
        })
        await Promise.all(retries)
        expect(maximum).toBe(5)
        expect(scheduler.getMetrics().retries).toBe(500)
        scheduler.close()
    })

    test('many independent sessions do not share one global operation queue', async () => {
        const schedulers = Array.from({ length: 25 }, () => new SessionOperationScheduler({
            minConcurrency: 2,
            maxConcurrency: 2,
            initialConcurrency: 2,
            maxQueueSize: 50,
            adaptiveIntervalMs: 60000
        }))
        const work = schedulers.flatMap((scheduler, sessionIndex) =>
            Array.from({ length: 40 }, () => scheduler.schedule('operation', async () => sessionIndex))
        )
        await Promise.all(work)
        expect(schedulers.every(scheduler => scheduler.getMetrics().completed === 40)).toBe(true)
        schedulers.forEach(scheduler => scheduler.close())
    })

    test('adaptive controller grows slowly when healthy and decreases under pressure', () => {
        const scheduler = new SessionOperationScheduler({
            minConcurrency: 2,
            maxConcurrency: 8,
            initialConcurrency: 4,
            queryMinConcurrency: 1,
            queryMaxConcurrency: 4,
            queryInitialConcurrency: 2,
            adaptiveIntervalMs: 500,
            adjustmentCooldownMs: 500,
            slowOperationMs: 100,
            highWaterMark: 1000
        })
        scheduler.paused = true
        scheduler.queue = [{}]
        scheduler.samples = Array.from({ length: 16 }, () => ({
            at: Date.now(), kind: 'operation', latencyMs: 10, failed: false, statusCode: 0
        }))
        scheduler.adjustConcurrency()
        scheduler.adjustConcurrency()
        expect(scheduler.currentConcurrency).toBe(5)
        scheduler.samples = Array.from({ length: 16 }, () => ({
            at: Date.now(), kind: 'operation', latencyMs: 500, failed: true, statusCode: 503
        }))
        scheduler.lastAdjustmentAt = 0
        scheduler.adjustConcurrency()
        expect(scheduler.currentConcurrency).toBe(3)
        scheduler.queue = []
        scheduler.close()
    })

    test('detached ALS work cannot reuse an expired scheduler lease', async () => {
        const scheduler = new SessionOperationScheduler({
            minConcurrency: 1,
            maxConcurrency: 1,
            initialConcurrency: 1,
            maxQueueSize: 10,
            queueTimeoutMs: 1000,
            adaptiveIntervalMs: 60000
        })
        let detachedPromise
        let detachedRan = false
        await scheduler.schedule('operation', async () => {
            setTimeout(() => {
                detachedPromise = scheduler.schedule('operation', async () => { detachedRan = true })
            }, 20)
        })
        scheduler.pause('replacement')
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(detachedPromise).toBeDefined()
        expect(detachedRan).toBe(false)
        expect(scheduler.getMetrics().queueDepth).toBe(1)
        scheduler.resume()
        await detachedPromise
        expect(detachedRan).toBe(true)
        scheduler.close()
    })
})

describe('websocket backpressure and listener lifecycle', () => {
    test('waits for bufferedAmount to fall below the low-water mark', async () => {
        const client = new WebSocketClient(new URL('wss://example.invalid'), {
            wsHighWaterMark: 100,
            wsLowWaterMark: 20,
            wsBackpressureTimeoutMs: 1000
        })
        const socket = new EventEmitter()
        socket.readyState = 1
        socket.bufferedAmount = 200
        client.socket = socket
        const wait = client.waitForBackpressure()
        setTimeout(() => { socket.bufferedAmount = 10 }, 30)
        await wait
        expect(client.listenerCount('close')).toBe(0)
        expect(client.listenerCount('error')).toBe(0)
    })

    test('active waitForMessage registers and cleans an error listener', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'Socket', 'socket.js'), 'utf8')
        const waiterStart = source.indexOf('const createMessageWaiter')
        const waiterEnd = source.indexOf('const waitForMessage', waiterStart)
        const waiterSource = source.slice(waiterStart, waiterEnd)
        expect(waiterSource).toContain("ws.on('error', onErr)")
        expect(waiterSource).toContain("ws.off('error', onErr)")
        expect(waiterSource).not.toContain("ws.off('error', onErr);\n            });")
    })

    test('numeric zero is retained as a valid websocket low-water mark', () => {
        const client = new WebSocketClient(new URL('wss://example.invalid'), {
            wsHighWaterMark: 100,
            wsLowWaterMark: 0,
            wsBackpressureTimeoutMs: 1000
        })
        const socket = new EventEmitter()
        socket.readyState = 1
        socket.bufferedAmount = 0
        client.socket = socket
        expect(client.config.wsLowWaterMark).toBe(0)
    })

    test.each(['timeout', 'error', 'close'])('query %s during a slow send creates no transient unhandled rejection', async scenario => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'Socket', 'socket.js'), 'utf8')
        expect(source).toContain(".then(value => ({ ok: true, value }), error => ({ ok: false, error }))")
        const waiterStart = source.indexOf('const createMessageWaiter')
        const waiterEnd = source.indexOf('/** connection handshake */', waiterStart)
        const waiterAndQuerySource = source.slice(waiterStart, waiterEnd)
        const ws = new EventEmitter()
        const promiseTimeout = (timeoutMs, executor) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('response timeout')), timeoutMs)
            executor(
                value => { clearTimeout(timer); resolve(value) },
                error => { clearTimeout(timer); reject(error) }
            )
        })
        const query = new Function(
            'ws', 'Utils_1', 'boom_1', 'Types_1', 'defaultQueryTimeoutMs',
            'pendingMessageWaiters', 'generateMessageTag', 'sendNodeUnscheduled',
            'WABinary_1', 'operationScheduler',
            `${waiterAndQuerySource}; return queryUnscheduled;`
        )(
            ws,
            { promiseTimeout },
            { Boom: class Boom extends Error {} },
            { DisconnectReason: { connectionClosed: 428 } },
            5,
            new Set(),
            () => 'query-id',
            async () => { await new Promise(resolve => setTimeout(resolve, 30)) },
            { assertNodeErrorFree: () => {} },
            null
        )
        const unhandled = []
        const onUnhandled = reason => unhandled.push(reason)
        process.on('unhandledRejection', onUnhandled)
        try {
            const call = query({ tag: 'iq', attrs: {} }, 5)
            if (scenario !== 'timeout') {
                setTimeout(() => ws.emit(scenario, new Error(`socket ${scenario}`)), 2)
            }
            await expect(call).rejects.toThrow()
            await immediate()
            expect(unhandled).toHaveLength(0)
        } finally {
            process.off('unhandledRejection', onUnhandled)
        }
    })
})

describe('credential and retry-state safety', () => {
    test('does not silently replace corrupted creds.json with a fresh identity', async () => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-auth-corrupt-'))
        try {
            fs.writeFileSync(path.join(folder, 'creds.json'), '{not-json')
            await expect(useMultiFileAuthState(folder)).rejects.toMatchObject({ code: 'WA_AUTH_FILE_CORRUPTED' })
        } finally {
            fs.rmSync(folder, { recursive: true, force: true })
        }
    })

    test('serializes atomic credential writes and leaves no temporary file', async () => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-auth-atomic-'))
        try {
            const auth = await useMultiFileAuthState(folder)
            auth.state.creds.registered = true
            await Promise.all(Array.from({ length: 50 }, () => auth.saveCreds()))
            expect(() => JSON.parse(fs.readFileSync(path.join(folder, 'creds.json'), 'utf8'))).not.toThrow()
            expect(fs.readdirSync(folder).some(file => file.endsWith('.tmp'))).toBe(false)
        } finally {
            fs.rmSync(folder, { recursive: true, force: true })
        }
    })

    test('serializes concurrent signal-key transactions', async () => {
        const stored = { counter: { value: 0 } }
        const state = {
            get: async (type, ids) => Object.fromEntries(ids.map(id => [id, stored[type]?.[id]])),
            set: async data => {
                await immediate()
                for (const [type, values] of Object.entries(data)) {
                    stored[type] = { ...(stored[type] || {}), ...values }
                }
            }
        }
        const logger = { trace: () => {}, warn: () => {} }
        const transactional = addTransactionCapability(state, logger, { maxCommitRetries: 3, delayBetweenTriesMs: 1 })
        await Promise.all(Array.from({ length: 50 }, () => transactional.transaction(async () => {
            const current = await transactional.get('counter', ['value'])
            transactional.set({ counter: { value: (current.value || 0) + 1 } })
        })))
        expect(stored.counter.value).toBe(50)
    })

    test('detached auth work cannot contaminate a later transaction cache', async () => {
        const stored = {}
        const committedBatches = []
        const state = {
            get: async (type, ids) => Object.fromEntries(ids.map(id => [id, stored[type]?.[id]])),
            set: async data => {
                committedBatches.push(JSON.parse(JSON.stringify(data)))
                for (const [type, values] of Object.entries(data)) {
                    stored[type] = { ...(stored[type] || {}), ...values }
                }
            }
        }
        const transactional = addTransactionCapability(state, { trace: () => {}, warn: () => {} }, {
            maxCommitRetries: 2,
            delayBetweenTriesMs: 1
        })
        let detachedDone
        await transactional.transaction(async () => {
            transactional.set({ keys: { first: 1 } })
            detachedDone = new Promise(resolve => setTimeout(async () => {
                await transactional.set({ keys: { detached: 3 } })
                resolve()
            }, 25))
        })
        await transactional.transaction(async () => {
            transactional.set({ keys: { second: 2 } })
        })
        await detachedDone
        expect(stored.keys).toEqual({ first: 1, second: 2, detached: 3 })
        expect(committedBatches).toEqual([
            { keys: { first: 1 } },
            { keys: { second: 2 } },
            { keys: { detached: 3 } }
        ])
    })

    test('retired auth generation cannot overwrite the active generation', async () => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-auth-generation-'))
        try {
            const generationA = await useMultiFileAuthState(folder)
            const acceptedWrites = Array.from({ length: 40 }, (_, index) => generationA.state.keys.set({
                session: { shared: { owner: 'A', index } }
            }))
            const generationBPromise = useMultiFileAuthState(folder)
            await Promise.all(acceptedWrites)
            const generationB = await generationBPromise
            expect(generationA.authStoreController.active).toBe(false)
            const loaded = await generationB.state.keys.get('session', ['shared'])
            expect(loaded.shared.owner).toBe('A')
            await generationB.state.keys.set({ session: { shared: { owner: 'B' } } })
            await expect(generationA.state.keys.set({ session: { shared: { owner: 'STALE_A' } } }))
                .rejects.toMatchObject({ code: 'WA_AUTH_STORE_RETIRED' })
            const finalValue = await generationB.state.keys.get('session', ['shared'])
            expect(finalValue.shared).toEqual({ owner: 'B' })
        } finally {
            fs.rmSync(folder, { recursive: true, force: true })
        }
    })

    test('auth retry maps remain bounded after churn', () => {
        const manager = new MessageRetryManager(null, 5)
        for (let index = 0; index < 10000; index += 1) {
            manager.incrementRetryCount(`message-${index}`)
            manager.shouldRecreateSession(`user-${index}@s.whatsapp.net`, false, 0)
        }
        expect(manager.retryCounters.map.size).toBeLessThanOrEqual(2048)
        expect(manager.sessionRecreateHistory.map.size).toBeLessThanOrEqual(2048)
        manager.clear()
        expect(manager.retryCounters.map.size).toBe(0)
        expect(manager.sessionRecreateHistory.map.size).toBe(0)
    })

    test('cleans only clearly stale auth temp files', async () => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-auth-temp-'))
        try {
            const stale = path.join(folder, `creds.json.${process.pid}.1.tmp`)
            const recent = path.join(folder, `creds.json.${process.pid}.2.tmp`)
            const unrelated = path.join(folder, 'do-not-delete.tmp')
            fs.writeFileSync(stale, 'stale')
            fs.writeFileSync(recent, 'recent')
            fs.writeFileSync(unrelated, 'keep')
            const old = new Date(Date.now() - (2 * 60 * 60 * 1000))
            fs.utimesSync(stale, old, old)
            await useMultiFileAuthState(folder)
            expect(fs.existsSync(stale)).toBe(false)
            expect(fs.existsSync(recent)).toBe(true)
            expect(fs.existsSync(unrelated)).toBe(true)
        } finally {
            fs.rmSync(folder, { recursive: true, force: true })
        }
    })

    test('bounds the secondary recent-message ID index', () => {
        const manager = new MessageRetryManager(null, 5)
        for (let index = 0; index < 5000; index += 1) {
            manager.addRecentMessage('user@s.whatsapp.net', `id-${index}`, { index })
        }
        expect(manager.recentMessagesMap.map.size).toBeLessThanOrEqual(512)
        expect(manager.messageKeyIndex.map.size).toBeLessThanOrEqual(512)
        manager.clear()
    })
})

describe('disconnect decision safety', () => {
    test('does not reset credentials for a numeric 500 disconnect', () => {
        const decision = getReconnectDecision({ error: { output: { statusCode: 500 } } })
        expect(decision.resetSession).toBe(false)
        expect(decision.reconnect).toBe(true)
    })

    test('confirmed logout remains permanent and resets the invalid session', () => {
        const decision = getReconnectDecision({ error: { output: { statusCode: 401 } } })
        expect(decision.fatal).toBe(true)
        expect(decision.resetSession).toBe(true)
        expect(decision.reconnect).toBe(false)
    })

    test('connection replacement suppresses automatic reconnect oscillation', () => {
        const decision = getReconnectDecision({ error: { output: { statusCode: 440 } } })
        expect(decision.fatal).toBe(false)
        expect(decision.resetSession).toBe(false)
        expect(decision.reconnect).toBe(false)
    })
})

describe('active bot session policy', () => {
    const botIndexPath = path.resolve(__dirname, '..', '..', '..', '..', 'Bot', '9-8-2026', 'index.js')
    const botSource = fs.readFileSync(botIndexPath, 'utf8')
    const failureClasses = {
        TERMINATED: 'TERMINATED',
        BAD_SESSION: 'BAD_SESSION',
        BAD_SESSION_SUSPECT: 'BAD_SESSION_SUSPECT',
        AUTH_SUSPECT: 'AUTH_SUSPECT',
        TEMPORARY: 'TEMPORARY',
        REPLACED: 'REPLACED',
        RESTART_REQUIRED: 'RESTART_REQUIRED',
        UNKNOWN: 'UNKNOWN'
    }
    const classifierStart = botSource.indexOf('function classifyWhatsappFailure')
    const classifierEnd = botSource.indexOf('\nfunction reserveWhatsappConnectionSlot', classifierStart)
    const classifierSource = botSource.slice(classifierStart, classifierEnd)
    const classifyWhatsappFailure = new Function(
        'DisconnectReason',
        'WHATSAPP_FAILURE_CLASS',
        `${classifierSource}; return classifyWhatsappFailure;`
    )({ loggedOut: 401, multideviceMismatch: 411, badSession: 500 }, failureClasses)

    test('numeric operation 500 is temporary and cannot prove invalid credentials', () => {
        expect(classifyWhatsappFailure({ output: { statusCode: 500 } }, { scope: 'operation' })).toMatchObject({
            type: 'TEMPORARY',
            explicitPermanent: false
        })
    })

    test('healthy query timeout remains operation-scoped and temporary', () => {
        expect(classifyWhatsappFailure({
            output: { statusCode: 408, payload: { message: 'Request Time-out' } },
            wolfOperationScope: 'query'
        }, { scope: 'operation' })).toMatchObject({ type: 'TEMPORARY', explicitPermanent: false })
        const policyStart = botSource.indexOf('async function executeWhatsappOperationWithPolicy')
        const policyEnd = botSource.indexOf('\nfunction installSmartSessionRecovery', policyStart)
        const policy = botSource.slice(policyStart, policyEnd)
        expect(policy).toContain('transportOpen &&')
        expect(policy).toContain('socket retained')
        expect(policy.indexOf('transportOpen &&')).toBeLessThan(policy.indexOf('await scheduleSmartWhatsappReconnect'))
    })

    test('numeric operation 401 is auth-suspect, while connection logout is permanent', () => {
        expect(classifyWhatsappFailure({ output: { statusCode: 401 } }, { scope: 'operation' }).type).toBe('AUTH_SUSPECT')
        expect(classifyWhatsappFailure({ error: { output: { statusCode: 401 } } }, { scope: 'connection' }).type).toBe('TERMINATED')
    })

    test('explicit revocation remains permanent in every scope', () => {
        expect(classifyWhatsappFailure(new Error('device removed by account owner'), { scope: 'operation' })).toMatchObject({
            type: 'TERMINATED',
            explicitPermanent: true
        })
    })

    test('global reconnect handshakes are bounded and generation-cancellable', () => {
        expect(botSource).toContain('const WHATSAPP_GLOBAL_RECONNECT_CONCURRENCY = 4')
        expect(botSource).toContain('acquireGlobalWhatsappReconnectSlot(number')
        expect(botSource).toContain('cancelGlobalWhatsappReconnectWaiters(normalizedNumber)')
        expect(botSource).toContain('expectedReconnectGeneration != null && whatsappRecoveryStates.get(number)?.reconnectGeneration !== expectedReconnectGeneration')
    })

    test('global reconnect gate bounds simultaneous mocked handshakes', async () => {
        const gateStart = botSource.indexOf('function releaseGlobalWhatsappReconnectSlot')
        const gateEnd = botSource.indexOf('\nfunction sampleWhatsappProcessMetrics', gateStart)
        const gateSource = botSource.slice(gateStart, gateEnd)
        const state = { active: 0, queue: [], started: 0, rejected: 0 }
        const gate = new Function(
            'whatsappGlobalReconnectState',
            'WHATSAPP_GLOBAL_RECONNECT_CONCURRENCY',
            'WHATSAPP_GLOBAL_RECONNECT_MAX_PENDING',
            'WHATSAPP_GLOBAL_RECONNECT_QUEUE_TIMEOUT_MS',
            'createWhatsappCommandAbortError',
            'createWhatsappTransientError',
            'getWhatsappRecoveryState',
            'whatsappShuttingDown',
            `${gateSource}; return { acquireGlobalWhatsappReconnectSlot, cancelGlobalWhatsappReconnectWaiters };`
        )(
            state,
            4,
            1000,
            5000,
            message => Object.assign(new Error(message), { statusCode: 428 }),
            (message, statusCode) => Object.assign(new Error(message), { statusCode }),
            (() => {
                const recovery = new Map()
                return number => {
                    if (!recovery.has(number)) recovery.set(number, { reconnectCount: 0 })
                    return recovery.get(number)
                }
            })(),
            false
        )
        let active = 0
        let maximum = 0
        const startedOrder = []
        await Promise.all(Array.from({ length: 1000 }, (_, index) => (async () => {
            const release = await gate.acquireGlobalWhatsappReconnectSlot(`session-${index}`)
            startedOrder.push(index)
            active += 1
            maximum = Math.max(maximum, active)
            await immediate()
            active -= 1
            release()
        })()))
        expect(maximum).toBe(4)
        expect(state.active).toBe(0)
        expect(state.queue).toHaveLength(0)
        expect(startedOrder).toEqual(Array.from({ length: 1000 }, (_, index) => index))
    })

    test('queued reconnect waiters are promptly abortable', async () => {
        const gateStart = botSource.indexOf('function releaseGlobalWhatsappReconnectSlot')
        const gateEnd = botSource.indexOf('\nfunction sampleWhatsappProcessMetrics', gateStart)
        const gateSource = botSource.slice(gateStart, gateEnd)
        const state = { active: 0, queue: [], started: 0, rejected: 0 }
        const recovery = new Map()
        const gate = new Function(
            'whatsappGlobalReconnectState',
            'WHATSAPP_GLOBAL_RECONNECT_CONCURRENCY',
            'WHATSAPP_GLOBAL_RECONNECT_MAX_PENDING',
            'WHATSAPP_GLOBAL_RECONNECT_QUEUE_TIMEOUT_MS',
            'createWhatsappCommandAbortError',
            'createWhatsappTransientError',
            'getWhatsappRecoveryState',
            'whatsappShuttingDown',
            `${gateSource}; return { acquireGlobalWhatsappReconnectSlot, cancelAllGlobalWhatsappReconnectWaiters };`
        )(
            state, 1, 1000, 5000,
            message => Object.assign(new Error(message), { statusCode: 428 }),
            (message, statusCode) => Object.assign(new Error(message), { statusCode }),
            number => {
                if (!recovery.has(number)) recovery.set(number, { reconnectCount: 0 })
                return recovery.get(number)
            },
            false
        )
        const release = await gate.acquireGlobalWhatsappReconnectSlot('active')
        const controller = new AbortController()
        const queued = gate.acquireGlobalWhatsappReconnectSlot('queued', null, controller.signal)
        expect(state.queue).toHaveLength(1)
        controller.abort()
        await expect(queued).rejects.toMatchObject({ statusCode: 428 })
        expect(state.queue).toHaveLength(0)
        release()
        expect(state.active).toBe(0)
    })

    test.each([
        [408, 'TEMPORARY'],
        [428, 'TEMPORARY'],
        [429, 'TEMPORARY'],
        [500, 'TEMPORARY'],
        [502, 'TEMPORARY'],
        [503, 'TEMPORARY'],
        [504, 'TEMPORARY'],
        [515, 'RESTART_REQUIRED'],
        [440, 'REPLACED'],
        [403, 'AUTH_SUSPECT']
    ])('classifies operation status %i as %s without credential deletion', (statusCode, expectedType) => {
        expect(classifyWhatsappFailure({ output: { statusCode } }, { scope: 'operation' })).toMatchObject({
            type: expectedType,
            explicitPermanent: false
        })
    })

    test('retry path records and re-enters the library scheduler', () => {
        expect(botSource).toContain('activeSock.__wolfOperationScheduler?.recordRetry?.()')
        const socketIndex = fs.readFileSync(path.join(__dirname, '..', 'lib', 'Socket', 'index.js'), 'utf8')
        expect(socketIndex).toContain("scheduler.schedule('operation', () => original(...args)")
        expect(botSource).toContain('retryAllowed: false')
        expect(botSource).toContain('return executeWhatsappOperationWithPolicy({')
        expect(botSource).not.toContain('return retryOriginal(...args)')
    })

    test('second-attempt explicit logout still reaches permanent cleanup policy', () => {
        const policyStart = botSource.indexOf('async function executeWhatsappOperationWithPolicy')
        const policyEnd = botSource.indexOf('\nfunction installSmartSessionRecovery', policyStart)
        const policy = botSource.slice(policyStart, policyEnd)
        expect(policy).toContain('retryAllowed: false')
        expect(policy).toContain('await clearTerminatedWhatsappSession({')
        expect(policy.indexOf('await clearTerminatedWhatsappSession({')).toBeLessThan(policy.indexOf('if (!retryAllowed)'))
        expect(classifyWhatsappFailure(new Error('logged out'), { scope: 'operation' }).type).toBe('TERMINATED')
    })

    test('ambiguous connection 500 is quarantined, while trusted permanent evidence remains destructive', () => {
        expect(classifyWhatsappFailure({ error: { output: { statusCode: 500 } } }, { scope: 'connection' }).type)
            .toBe('BAD_SESSION_SUSPECT')
        expect(classifyWhatsappFailure({ error: { output: { statusCode: 411 } } }, { scope: 'connection' }).type)
            .toBe('BAD_SESSION')
        expect(classifyWhatsappFailure(new Error('device revoked'), { scope: 'connection' }).type)
            .toBe('TERMINATED')
        expect(botSource).toContain('update?.registered === false')
    })

    test('replacement order retires and flushes auth before loading a new store', () => {
        const prepareStart = botSource.indexOf('async function prepareWhatsappSessionReplacement')
        const prepareEnd = botSource.indexOf('\nasync function retireWhatsappRuntimeSocket', prepareStart)
        const prepare = botSource.slice(prepareStart, prepareEnd)
        expect(prepare.indexOf('lifecycle.retiring = true')).toBeLessThan(prepare.indexOf('beginRetirement'))
        expect(prepare.indexOf('beginRetirement')).toBeLessThan(prepare.indexOf('flushWhatsappLifecycleCredentialWrites'))
        expect(prepare.indexOf('flushWhatsappLifecycleCredentialWrites')).toBeLessThan(prepare.indexOf('retireAndFlush'))
        expect(prepare.indexOf('retireAndFlush')).toBeLessThan(prepare.indexOf('detachAndCloseWhatsappSocket'))
        const reconnectStart = botSource.indexOf('async function reconnectSession')
        const reconnectEnd = botSource.indexOf('\nasync function startWhatsapp', reconnectStart)
        const reconnect = botSource.slice(reconnectStart, reconnectEnd)
        expect(reconnect.indexOf('await prepareWhatsappSessionReplacement')).toBeLessThan(reconnect.indexOf('await useMultiFileAuthState'))
    })

    test('deferred connect protects early connection and credential events', () => {
        const socketSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'Socket', 'socket.js'), 'utf8')
        expect(socketSource).toContain('connectImmediately = true')
        expect(socketSource).toContain('if (connectImmediately !== false)')
        expect(socketSource.indexOf('const connect = () =>')).toBeLessThan(socketSource.indexOf('if (connectImmediately !== false)'))
        const runtimePaths = [
            ['async function reconnectSession', '\nasync function startWhatsapp'],
            ['async function startWhatsapp', '\nasync function getSessions'],
            ['async function getSessions', '\nfunction registerCommandHandlers']
        ]
        for (const [startMarker, endMarker] of runtimePaths) {
            const start = botSource.indexOf(startMarker)
            const end = botSource.indexOf(endMarker, start)
            const runtimePath = botSource.slice(start, end)
            const connectIndex = runtimePath.indexOf('sock.connect?.()')
            expect(runtimePath).toContain('connectImmediately: false')
            expect(runtimePath.indexOf('registerWhatsappConnectionHandler(sock, {')).toBeLessThan(connectIndex)
            expect(runtimePath.indexOf('registerWhatsappCredsWriter(sock, { number, generation, saveCreds')).toBeLessThan(connectIndex)
        }
    })

    test('100 listener migrations remain constant and preserve once semantics', () => {
        const preserveStart = botSource.indexOf('function preserveWhatsappApplicationListeners')
        const preserveEnd = botSource.indexOf('\nfunction setWhatsappSessionState', preserveStart)
        const listenerSource = botSource.slice(preserveStart, preserveEnd)
        const lifecycle = { applicationMessageListeners: [] }
        const helpers = new Function(
            'getWhatsappSessionLifecycle',
            `${listenerSource}; return { preserveWhatsappApplicationListeners, restoreWhatsappApplicationListeners };`
        )(() => lifecycle)
        let hits = 0
        let emitter = new EventEmitter()
        emitter.once('messages.upsert', () => { hits += 1 })
        for (let index = 0; index < 100; index += 1) {
            helpers.preserveWhatsappApplicationListeners('session', { ev: emitter })
            const next = new EventEmitter()
            helpers.restoreWhatsappApplicationListeners('session', { ev: next })
            expect(next.listenerCount('messages.upsert')).toBe(1)
            emitter = next
        }
        emitter.emit('messages.upsert', {})
        emitter.emit('messages.upsert', {})
        expect(hits).toBe(1)
        expect(emitter.listenerCount('messages.upsert')).toBe(0)
    })

    test('reconnect releases its global slot before backoff and shutdown cancels every wait class', () => {
        const reconnectStart = botSource.indexOf('async function reconnectSession')
        const reconnectEnd = botSource.indexOf('\nasync function startWhatsapp', reconnectStart)
        const reconnect = botSource.slice(reconnectStart, reconnectEnd)
        expect(reconnect.indexOf('await useMultiFileAuthState')).toBeLessThan(reconnect.indexOf('await acquireGlobalWhatsappReconnectSlot'))
        expect(reconnect.indexOf('await acquireGlobalWhatsappReconnectSlot')).toBeLessThan(reconnect.indexOf('await createWhatsappSocketWithAuthCleanup'))
        expect(reconnect.indexOf('await createWhatsappSocketWithAuthCleanup')).toBeLessThan(reconnect.indexOf('await waitForWhatsappSessionOpen'))
        const backoffIndex = reconnect.indexOf('const boundedBackoff')
        expect(reconnect.lastIndexOf('releaseGlobalReconnect?.()', backoffIndex)).toBeGreaterThan(-1)
        expect(reconnect.lastIndexOf('releaseGlobalReconnect?.()', backoffIndex)).toBeLessThan(backoffIndex)
        const shutdownStart = botSource.indexOf('function beginWhatsappGracefulShutdown')
        const shutdownEnd = botSource.indexOf("\nfor (const signal of ['SIGINT', 'SIGTERM'])", shutdownStart)
        const shutdown = botSource.slice(shutdownStart, shutdownEnd)
        expect(shutdown).toContain('whatsappShuttingDown = true')
        expect(shutdown).toContain('cancelAllGlobalWhatsappReconnectWaiters')
        expect(shutdown).toContain('recovery.reconnectAbortController?.abort()')
        expect(shutdown).toContain('cancelDelayedWhatsappRecovery')
    })

    test('permanent cleanup removes runtime lifecycle and termination metadata', () => {
        const cleanupStart = botSource.indexOf('async function clearTerminatedWhatsappSession')
        const cleanupEnd = botSource.indexOf('\nfunction registerWhatsappCredsWriter', cleanupStart)
        const cleanup = botSource.slice(cleanupStart, cleanupEnd)
        expect(cleanup).toContain('whatsappRecoveryStates.delete(normalizedNumber)')
        expect(cleanup).toContain('whatsappStatusMap.delete(normalizedNumber)')
        expect(cleanup).toContain('whatsappTerminatedSessions.delete(normalizedNumber)')
        expect(cleanup).toContain('whatsappSessionLifecycles.delete(normalizedNumber)')
    })

    test('stale socket state and credential writes remain generation guarded', () => {
        expect(botSource).toContain('if (!isCurrentWhatsappSocket(number, sock, generation))')
        expect(botSource).toContain('if (!isCurrentWhatsappSocket(number, sock, generation) || lifecycle?.cleanupInProgress || lifecycle?.authInvalid || lifecycle?.retiring) return')
        expect(botSource).toContain('if (socket && !isCurrentWhatsappSocket(normalizedNumber, socket, generation))')
    })

    test('socket replacement preserves existing application message listeners without rewriting them', () => {
        expect(botSource).toContain('preserveWhatsappApplicationListeners(normalizedNumber, existingSocket)')
        expect(botSource).toContain('restoreWhatsappApplicationListeners(normalizedNumber, sock)')
        expect(botSource).toContain('sock.ev.once(event, listener)')
        expect(botSource).toContain('else sock.ev.on(event, listener)')
    })

    test('graceful shutdown waits for pending credential persistence', async () => {
        const flushStart = botSource.indexOf('async function flushPendingWhatsappCredentialWrites')
        const flushEnd = botSource.indexOf('\nfunction beginWhatsappGracefulShutdown', flushStart)
        const flushSource = botSource.slice(flushStart, flushEnd)
        let resolveWrite
        let closed = false
        const pendingWrite = new Promise(resolve => { resolveWrite = resolve })
        const lifecycles = new Map([['session', {
            credsWritePromise: pendingWrite,
            socket: { __wolfOperationScheduler: { close: () => { closed = true } } }
        }]])
        const flush = new Function(
            'whatsappSessionLifecycles',
            'flushWhatsappLifecycleCredentialWrites',
            'createWhatsappCommandAbortError',
            `${flushSource}; return flushPendingWhatsappCredentialWrites;`
        )(lifecycles, async lifecycle => lifecycle.credsWritePromise, message => new Error(message))
        let completed = false
        const flushing = flush(1000).then(() => { completed = true })
        await immediate()
        expect(closed).toBe(true)
        expect(completed).toBe(false)
        resolveWrite()
        await flushing
        expect(completed).toBe(true)
    })
})
