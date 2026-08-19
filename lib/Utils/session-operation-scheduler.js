"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionOperationScheduler = exports.SessionSchedulerError = void 0;
const async_hooks_1 = require("async_hooks");

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finiteInteger = (value, fallback, minimum = 1) => {
    const numeric = Number(value);
    return Number.isFinite(numeric)
        ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(minimum, Math.floor(numeric)))
        : fallback;
};
const numericStatusCode = (error) => {
    var _a, _b, _c;
    const value = (_c = (_b = (_a = error === null || error === void 0 ? void 0 : error.output) === null || _a === void 0 ? void 0 : _a.statusCode) !== null && _b !== void 0 ? _b : error === null || error === void 0 ? void 0 : error.statusCode) !== null && _c !== void 0 ? _c : error === null || error === void 0 ? void 0 : error.code;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
};

class SessionSchedulerError extends Error {
    constructor(message, statusCode, code) {
        super(message);
        this.name = 'SessionSchedulerError';
        this.code = code;
        this.statusCode = statusCode;
        this.output = {
            statusCode,
            payload: { statusCode, error: code, message },
            headers: {}
        };
        this.wolfOperationScope = 'scheduler';
    }
}
exports.SessionSchedulerError = SessionSchedulerError;

class SessionOperationScheduler {
    constructor(options = {}) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
        this.minConcurrency = finiteInteger((_a = options.minConcurrency) !== null && _a !== void 0 ? _a : 2, 2);
        this.maxConcurrency = Math.max(this.minConcurrency, finiteInteger((_b = options.maxConcurrency) !== null && _b !== void 0 ? _b : 16, 16));
        this.currentConcurrency = clamp(finiteInteger((_c = options.initialConcurrency) !== null && _c !== void 0 ? _c : 4, 4), this.minConcurrency, this.maxConcurrency);
        this.queryMinConcurrency = finiteInteger((_d = options.queryMinConcurrency) !== null && _d !== void 0 ? _d : 1, 1);
        this.queryMaxConcurrency = Math.max(this.queryMinConcurrency, finiteInteger((_e = options.queryMaxConcurrency) !== null && _e !== void 0 ? _e : 4, 4));
        this.currentQueryConcurrency = clamp(finiteInteger((_f = options.queryInitialConcurrency) !== null && _f !== void 0 ? _f : 2, 2), this.queryMinConcurrency, this.queryMaxConcurrency);
        this.maxQueueSize = finiteInteger((_g = options.maxQueueSize) !== null && _g !== void 0 ? _g : 1000, 1000);
        this.queueTimeoutMs = finiteInteger((_h = options.queueTimeoutMs) !== null && _h !== void 0 ? _h : 30000, 30000);
        this.adaptiveIntervalMs = finiteInteger((_j = options.adaptiveIntervalMs) !== null && _j !== void 0 ? _j : 2000, 2000, 500);
        this.adjustmentCooldownMs = Math.max(this.adaptiveIntervalMs, finiteInteger((_k = options.adjustmentCooldownMs) !== null && _k !== void 0 ? _k : 4000, 4000));
        this.slowOperationMs = finiteInteger((_l = options.slowOperationMs) !== null && _l !== void 0 ? _l : 2500, 2500);
        this.slowQueryMs = finiteInteger((_m = options.slowQueryMs) !== null && _m !== void 0 ? _m : 5000, 5000);
        this.highWaterMark = finiteInteger((_o = options.highWaterMark) !== null && _o !== void 0 ? _o : 4 * 1024 * 1024, 4 * 1024 * 1024);
        this.logger = options.logger;
        this.eventLoopDelayProvider = typeof options.eventLoopDelayProvider === 'function' ? options.eventLoopDelayProvider : null;
        this.queue = [];
        this.activeOperations = 0;
        this.activeQueries = 0;
        this.paused = false;
        this.pauseReason = null;
        this.closed = false;
        this.transport = null;
        this.context = new async_hooks_1.AsyncLocalStorage();
        this.deadlineTimer = null;
        this.drainScheduled = false;
        this.lastAdjustmentAt = 0;
        this.healthyIntervals = 0;
        this.samples = [];
        this.metrics = {
            submitted: 0,
            completed: 0,
            failed: 0,
            rejected: 0,
            timedOut: 0,
            retries: 0,
            overloads: 0,
            totalLatencyMs: 0,
            maxLatencyMs: 0,
            lastErrorAt: 0,
            lifecycle: 'CONNECTING'
        };
        this.adaptiveTimer = setInterval(() => this.adjustConcurrency(), this.adaptiveIntervalMs);
        if (typeof this.adaptiveTimer.unref === 'function') {
            this.adaptiveTimer.unref();
        }
    }
    setTransport(transport) {
        this.transport = transport || null;
        return this;
    }
    setLifecycle(lifecycle) {
        this.metrics.lifecycle = lifecycle || 'UNKNOWN';
        if (lifecycle === 'OPEN' || lifecycle === 'CONNECTED') {
            this.resume();
        }
        else if (lifecycle === 'RECOVERING' || lifecycle === 'RECONNECTING') {
            this.pause(lifecycle);
        }
    }
    pause(reason = 'paused') {
        if (this.closed) {
            return false;
        }
        this.paused = true;
        this.pauseReason = reason;
        return true;
    }
    resume() {
        if (this.closed) {
            return false;
        }
        this.paused = false;
        this.pauseReason = null;
        this.scheduleDrain();
        return true;
    }
    recordRetry(count = 1) {
        this.metrics.retries += Math.max(0, Number(count) || 0);
    }
    schedule(kind, task, options = {}) {
        if (typeof task !== 'function') {
            return Promise.reject(new TypeError('Scheduled operation must be a function'));
        }
        if (this.closed) {
            return Promise.reject(new SessionSchedulerError('WhatsApp session scheduler is closed', 428, 'SCHEDULER_CLOSED'));
        }
        const isQuery = kind === 'query';
        const parent = this.context.getStore();
        const ownsOperationSlot = Boolean(
            parent &&
            parent.scheduler === this &&
            parent.operationLease &&
            parent.operationLease.active === true
        );
        const ownsQuerySlot = Boolean(
            parent &&
            parent.scheduler === this &&
            parent.queryLease &&
            parent.queryLease.active === true
        );
        const needsOperationSlot = !ownsOperationSlot;
        const needsQuerySlot = isQuery && !ownsQuerySlot;
        if (!needsOperationSlot && !needsQuerySlot) {
            const nestedTask = Promise.resolve().then(task);
            this.trackLeaseChild(parent.operationLease, nestedTask);
            if (isQuery) this.trackLeaseChild(parent.queryLease, nestedTask);
            return nestedTask;
        }
        if (this.queue.length >= this.maxQueueSize) {
            this.metrics.rejected += 1;
            this.metrics.overloads += 1;
            return Promise.reject(new SessionSchedulerError('WhatsApp session operation queue is full', 429, 'SCHEDULER_OVERLOADED'));
        }
        const now = Date.now();
        const timeoutMs = finiteInteger(options.timeoutMs, this.queueTimeoutMs);
        this.metrics.submitted += 1;
        return new Promise((resolve, reject) => {
            this.queue.push({
                kind: isQuery ? 'query' : 'operation',
                task,
                label: options.label || kind || 'operation',
                enqueuedAt: now,
                deadline: now + timeoutMs,
                needsOperationSlot,
                needsQuerySlot,
                parent,
                resolve,
                reject
            });
            this.scheduleDeadlineCheck();
            this.scheduleDrain();
        });
    }
    scheduleDrain() {
        if (this.drainScheduled || this.closed || this.paused) {
            return;
        }
        this.drainScheduled = true;
        setImmediate(() => {
            this.drainScheduled = false;
            this.drain();
        });
    }
    drain() {
        if (this.closed || this.paused) {
            return;
        }
        this.expireQueuedEntries();
        let started = false;
        do {
            started = false;
            for (let index = 0; index < this.queue.length; index += 1) {
                const entry = this.queue[index];
                if (!this.canStart(entry)) {
                    continue;
                }
                this.queue.splice(index, 1);
                this.startEntry(entry);
                started = true;
                break;
            }
        } while (started && !this.closed && !this.paused);
        this.scheduleDeadlineCheck();
    }
    canStart(entry) {
        if (entry.needsOperationSlot && this.activeOperations >= this.currentConcurrency) {
            return false;
        }
        if (entry.needsQuerySlot && this.activeQueries >= this.currentQueryConcurrency) {
            return false;
        }
        return true;
    }
    startEntry(entry) {
        if (entry.needsOperationSlot) {
            this.activeOperations += 1;
        }
        if (entry.needsQuerySlot) {
            this.activeQueries += 1;
        }
        const startedAt = Date.now();
        const operationLease = entry.needsOperationSlot
            ? { active: true, children: new Set(), childFailures: [] }
            : (entry.parent === null || entry.parent === void 0 ? void 0 : entry.parent.operationLease) || null;
        const queryLease = entry.needsQuerySlot
            ? { active: true, children: new Set(), childFailures: [] }
            : (entry.parent === null || entry.parent === void 0 ? void 0 : entry.parent.queryLease) || null;
        const context = {
            scheduler: this,
            operationLease,
            queryLease
        };
        this.context.run(context, async () => {
            let result;
            let failure = null;
            try {
                await this.waitForTransportPressure();
                result = await entry.task();
            }
            catch (error) {
                failure = error;
            }
            try {
                const ownedLeases = [];
                if (entry.needsOperationSlot && operationLease) ownedLeases.push(operationLease);
                if (entry.needsQuerySlot && queryLease && queryLease !== operationLease) ownedLeases.push(queryLease);
                for (const lease of ownedLeases) {
                    await this.waitForLeaseChildren(lease);
                    if (!failure && lease.childFailures.length) {
                        failure = lease.childFailures.length === 1
                            ? lease.childFailures[0]
                            : new AggregateError(lease.childFailures, 'Nested WhatsApp scheduler work failed');
                    }
                }
                this.recordCompletion(entry.kind, Date.now() - startedAt, failure);
                if (failure) entry.reject(failure);
                else entry.resolve(result);
            }
            finally {
                if (entry.needsOperationSlot && operationLease) {
                    operationLease.active = false;
                }
                if (entry.needsQuerySlot && queryLease) {
                    queryLease.active = false;
                }
                if (entry.needsOperationSlot) {
                    this.activeOperations -= 1;
                }
                if (entry.needsQuerySlot) {
                    this.activeQueries -= 1;
                }
                this.scheduleDrain();
            }
        });
    }
    trackLeaseChild(lease, taskPromise) {
        if (!lease || lease.active !== true) return;
        const outcome = taskPromise.then(
            () => ({ ok: true }),
            error => ({ ok: false, error })
        );
        lease.children.add(outcome);
        outcome.then(result => {
            lease.children.delete(outcome);
            if (!result.ok) lease.childFailures.push(result.error);
        });
    }
    async waitForLeaseChildren(lease) {
        while (lease.children.size) {
            await Promise.all([...lease.children]);
        }
    }
    async waitForTransportPressure() {
        if (!this.transport || typeof this.transport.waitForBackpressure !== 'function') {
            return;
        }
        await this.transport.waitForBackpressure();
    }
    recordCompletion(kind, latencyMs, error) {
        const failed = Boolean(error);
        this.metrics.completed += failed ? 0 : 1;
        this.metrics.failed += failed ? 1 : 0;
        this.metrics.totalLatencyMs += latencyMs;
        this.metrics.maxLatencyMs = Math.max(this.metrics.maxLatencyMs, latencyMs);
        if (failed) {
            this.metrics.lastErrorAt = Date.now();
        }
        this.samples.push({
            at: Date.now(),
            kind,
            latencyMs,
            failed,
            statusCode: numericStatusCode(error)
        });
        if (this.samples.length > 256) {
            this.samples.splice(0, this.samples.length - 256);
        }
    }
    expireQueuedEntries() {
        const now = Date.now();
        const remaining = [];
        for (const entry of this.queue) {
            if (entry.deadline <= now) {
                this.metrics.rejected += 1;
                this.metrics.timedOut += 1;
                entry.reject(new SessionSchedulerError(`WhatsApp ${entry.label} expired in the session queue`, 408, 'SCHEDULER_QUEUE_TIMEOUT'));
            }
            else {
                remaining.push(entry);
            }
        }
        this.queue = remaining;
    }
    scheduleDeadlineCheck() {
        if (this.deadlineTimer) {
            clearTimeout(this.deadlineTimer);
            this.deadlineTimer = null;
        }
        if (!this.queue.length || this.closed) {
            return;
        }
        const earliest = this.queue.reduce((deadline, entry) => Math.min(deadline, entry.deadline), Infinity);
        this.deadlineTimer = setTimeout(() => {
            this.deadlineTimer = null;
            this.expireQueuedEntries();
            this.scheduleDrain();
        }, Math.max(1, earliest - Date.now()));
        if (typeof this.deadlineTimer.unref === 'function') {
            this.deadlineTimer.unref();
        }
    }
    adjustConcurrency() {
        if (this.closed) {
            return;
        }
        const now = Date.now();
        const cutoff = now - Math.max(this.adaptiveIntervalMs * 3, 6000);
        this.samples = this.samples.filter(sample => sample.at >= cutoff);
        if (this.samples.length < 8) {
            return;
        }
        const errorRate = this.samples.filter(sample => sample.failed).length / this.samples.length;
        const operationSamples = this.samples.filter(sample => sample.kind !== 'query');
        const querySamples = this.samples.filter(sample => sample.kind === 'query');
        const average = samples => samples.length ? samples.reduce((total, sample) => total + sample.latencyMs, 0) / samples.length : 0;
        const operationLatency = average(operationSamples);
        const queryLatency = average(querySamples);
        const bufferedAmount = Number(this.transport === null || this.transport === void 0 ? void 0 : this.transport.bufferedAmount) || 0;
        const eventLoopDelayMs = Number(this.eventLoopDelayProvider === null || this.eventLoopDelayProvider === void 0 ? void 0 : this.eventLoopDelayProvider()) || 0;
        const underPressure = errorRate >= 0.12 || operationLatency > this.slowOperationMs || bufferedAmount >= this.highWaterMark || eventLoopDelayMs > 100;
        const queryPressure = querySamples.length >= 4 && (queryLatency > this.slowQueryMs || querySamples.filter(sample => sample.failed).length / querySamples.length >= 0.12);
        const cooldownElapsed = now - this.lastAdjustmentAt >= this.adjustmentCooldownMs;
        if ((underPressure || queryPressure) && cooldownElapsed) {
            this.currentConcurrency = Math.max(this.minConcurrency, Math.floor(this.currentConcurrency * 0.7));
            if (queryPressure || underPressure) {
                this.currentQueryConcurrency = Math.max(this.queryMinConcurrency, this.currentQueryConcurrency - 1);
            }
            this.healthyIntervals = 0;
            this.lastAdjustmentAt = now;
            return;
        }
        const healthy = errorRate <= 0.03 && operationLatency <= this.slowOperationMs * 0.5 && bufferedAmount < this.highWaterMark * 0.5 && eventLoopDelayMs < 50;
        if (!healthy) {
            this.healthyIntervals = 0;
            return;
        }
        this.healthyIntervals += 1;
        if (this.healthyIntervals < 2 || !cooldownElapsed) {
            return;
        }
        if (this.queue.length > 0 && this.currentConcurrency < this.maxConcurrency) {
            this.currentConcurrency += 1;
        }
        if (querySamples.length && this.activeQueries >= this.currentQueryConcurrency && this.currentQueryConcurrency < this.queryMaxConcurrency) {
            this.currentQueryConcurrency += 1;
        }
        this.healthyIntervals = 0;
        this.lastAdjustmentAt = now;
        this.scheduleDrain();
    }
    getMetrics() {
        const bufferedAmount = Number(this.transport === null || this.transport === void 0 ? void 0 : this.transport.bufferedAmount) || 0;
        const attempted = this.metrics.completed + this.metrics.failed;
        const recentErrors = this.samples.filter(sample => sample.failed).length;
        const recentOperationSamples = this.samples.filter(sample => sample.kind !== 'query');
        const recentQuerySamples = this.samples.filter(sample => sample.kind === 'query');
        const averageLatency = samples => samples.length ? samples.reduce((total, sample) => total + sample.latencyMs, 0) / samples.length : 0;
        return {
            ...this.metrics,
            queueDepth: this.queue.length,
            activeOperations: this.activeOperations,
            activeQueries: this.activeQueries,
            operationConcurrency: this.currentConcurrency,
            queryConcurrency: this.currentQueryConcurrency,
            averageLatencyMs: attempted ? this.metrics.totalLatencyMs / attempted : 0,
            recentErrorRate: this.samples.length ? recentErrors / this.samples.length : 0,
            recentOperationLatencyMs: averageLatency(recentOperationSamples),
            recentQueryLatencyMs: averageLatency(recentQuerySamples),
            bufferedAmount,
            paused: this.paused,
            pauseReason: this.pauseReason,
            closed: this.closed
        };
    }
    async waitForIdle(timeoutMs = 10000) {
        const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 10000);
        while (this.queue.length || this.activeOperations || this.activeQueries) {
            if (Date.now() >= deadline) {
                throw new SessionSchedulerError('Timed out waiting for WhatsApp scheduler to become idle', 408, 'SCHEDULER_IDLE_TIMEOUT');
            }
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }
    close(error = null) {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.paused = true;
        this.metrics.lifecycle = 'CLOSED';
        clearInterval(this.adaptiveTimer);
        if (this.deadlineTimer) {
            clearTimeout(this.deadlineTimer);
            this.deadlineTimer = null;
        }
        const closeError = error instanceof Error
            ? error
            : new SessionSchedulerError('WhatsApp session scheduler closed', 428, 'SCHEDULER_CLOSED');
        for (const entry of this.queue.splice(0)) {
            entry.reject(closeError);
        }
    }
}
exports.SessionOperationScheduler = SessionOperationScheduler;
