"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeAutoRestartingWASocket = exports.makeWASocket = void 0;
const events_1 = require("events");
const Defaults_1 = require("../Defaults");
const Utils_1 = require("../Utils");
const registration_1 = require("./registration");
// export the last socket layer
const makeWASocket = (config) => ((0, registration_1.makeRegistrationSocket)({
    ...Defaults_1.DEFAULT_CONNECTION_CONFIG,
    ...config
}));
exports.makeWASocket = makeWASocket;
const makeAutoRestartingWASocket = (config, options = {}) => {
    const ev = new events_1.EventEmitter();
    const logger = config === null || config === void 0 ? void 0 : config.logger;
    let current;
    let stopped = false;
    let unbindCurrent;
    const manager = (0, Utils_1.makeReconnectManager)({
        logger,
        maxRetries: options.maxRetries || 3,
        restartDelayMs: options.restartDelayMs || 500,
        initialDelayMs: options.initialDelayMs || 1000,
        maxDelayMs: options.maxDelayMs || 5000,
        reconnect: () => connect(true),
        onDecision: decision => {
            ev.emit('connection.update', {
                connection: 'connecting',
                restartRequired: decision.statusCode === Utils_1.DisconnectStatusCode.restartRequired,
                restartAttempt: manager.attempts,
                restartDelayMs: decision.delayMs,
                restartReason: decision.reason
            });
        }
    });
    const attachSharedEventForwarder = (sock) => {
        const originalEmit = sock.ev.emit.bind(sock.ev);
        sock.ev.emit = (event, ...args) => {
            ev.emit(event, ...args);
            return originalEmit(event, ...args);
        };
    };
    const connect = (isRestart = false) => {
        if (stopped) {
            return current;
        }
        if (unbindCurrent) {
            unbindCurrent();
            unbindCurrent = undefined;
        }
        current = (0, exports.makeWASocket)(config);
        attachSharedEventForwarder(current);
        const onUpdate = (update) => {
            if ((update === null || update === void 0 ? void 0 : update.connection) === 'open') {
                manager.reset();
                return;
            }
            if ((update === null || update === void 0 ? void 0 : update.connection) !== 'close') {
                return;
            }
            if ((0, Utils_1.isRestartRequiredDisconnect)(update)) {
                manager.schedule(update);
            }
        };
        current.ev.on('connection.update', onUpdate);
        unbindCurrent = () => current === null || current === void 0 ? void 0 : current.ev.off('connection.update', onUpdate);
        if (isRestart) {
            ev.emit('connection.update', { connection: 'connecting', restarted: true });
        }
        return current;
    };
    connect(false);
    ev.process = (handler) => {
        const listener = events => handler(events);
        ev.on('event', listener);
        return () => ev.off('event', listener);
    };
    ev.buffer = () => { var _a; return (_a = current === null || current === void 0 ? void 0 : current.ev) === null || _a === void 0 ? void 0 : _a.buffer(); };
    ev.flush = (force) => { var _a; return (_a = current === null || current === void 0 ? void 0 : current.ev) === null || _a === void 0 ? void 0 : _a.flush(force); };
    ev.isBuffering = () => { var _a; return !!((_a = current === null || current === void 0 ? void 0 : current.ev) === null || _a === void 0 ? void 0 : _a.isBuffering()); };
    ev.createBufferedFunction = (work) => { var _a; return ((_a = current === null || current === void 0 ? void 0 : current.ev) === null || _a === void 0 ? void 0 : _a.createBufferedFunction(work)) || work; };
    return new Proxy({
        ev,
        get current() {
            return current;
        },
        restart: () => connect(true),
        stop: () => {
            stopped = true;
            manager.clear();
            if (unbindCurrent) {
                unbindCurrent();
            }
        }
    }, {
        get(target, prop) {
            if (prop in target) {
                return target[prop];
            }
            const value = current === null || current === void 0 ? void 0 : current[prop];
            return typeof value === 'function' ? value.bind(current) : value;
        },
        set(_target, prop, value) {
            if (current) {
                current[prop] = value;
            }
            return true;
        }
    });
};
exports.makeAutoRestartingWASocket = makeAutoRestartingWASocket;
exports.default = makeWASocket;
