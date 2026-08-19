"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebSocketClient = void 0;
const ws_1 = __importDefault(require("ws"));
const Defaults_1 = require("../../Defaults");
const abstract_socket_client_1 = require("./abstract-socket-client");
class WebSocketClient extends abstract_socket_client_1.AbstractSocketClient {
    constructor() {
        super(...arguments);
        this.socket = null;
    }
    get isOpen() {
        var _a;
        return ((_a = this.socket) === null || _a === void 0 ? void 0 : _a.readyState) === ws_1.default.OPEN;
    }
    get isClosed() {
        var _a;
        return this.socket === null || ((_a = this.socket) === null || _a === void 0 ? void 0 : _a.readyState) === ws_1.default.CLOSED;
    }
    get isClosing() {
        var _a;
        return this.socket === null || ((_a = this.socket) === null || _a === void 0 ? void 0 : _a.readyState) === ws_1.default.CLOSING;
    }
    get isConnecting() {
        var _a;
        return ((_a = this.socket) === null || _a === void 0 ? void 0 : _a.readyState) === ws_1.default.CONNECTING;
    }
    get bufferedAmount() {
        var _a;
        return Number((_a = this.socket) === null || _a === void 0 ? void 0 : _a.bufferedAmount) || 0;
    }
    async connect() {
        var _a, _b;
        if (this.socket) {
            return;
        }
        try {
            this.socket = new ws_1.default(this.url, {
                origin: Defaults_1.DEFAULT_ORIGIN,
                headers: (_a = this.config.options) === null || _a === void 0 ? void 0 : _a.headers,
                handshakeTimeout: this.config.connectTimeoutMs,
                timeout: this.config.connectTimeoutMs,
                agent: this.config.agent,
            });
            this.socket.setMaxListeners(64);
            const events = ['close', 'error', 'upgrade', 'message', 'open', 'ping', 'pong', 'unexpected-response'];
            for (const event of events) {
                (_b = this.socket) === null || _b === void 0 ? void 0 : _b.on(event, (...args) => this.emit(event, ...args));
            }
        }
        catch (error) {
            try {
                this.socket === null || this.socket === void 0 ? void 0 : this.socket.terminate();
            }
            catch (_c) { }
            this.socket = null;
            throw error;
        }
    }
    async close() {
        if (!this.socket) {
            return;
        }
        this.socket.close();
        this.socket = null;
    }
    async waitForBackpressure(options = {}) {
        var _a, _b, _c;
        const configuredHighWaterMark = Number((_a = options.highWaterMark) !== null && _a !== void 0 ? _a : this.config.wsHighWaterMark);
        const configuredLowWaterMark = Number((_b = options.lowWaterMark) !== null && _b !== void 0 ? _b : this.config.wsLowWaterMark);
        const configuredTimeoutMs = Number((_c = options.timeoutMs) !== null && _c !== void 0 ? _c : this.config.wsBackpressureTimeoutMs);
        const highWaterMark = Math.max(1, Number.isFinite(configuredHighWaterMark) ? configuredHighWaterMark : 4 * 1024 * 1024);
        const lowWaterMark = Math.max(0, Math.min(highWaterMark, Number.isFinite(configuredLowWaterMark) ? configuredLowWaterMark : 1024 * 1024));
        const timeoutMs = Math.max(1, Number.isFinite(configuredTimeoutMs) ? configuredTimeoutMs : 15000);
        if (!this.isOpen) {
            throw new Error('WebSocket is not open');
        }
        if (this.bufferedAmount < highWaterMark) {
            return;
        }
        const deadline = Date.now() + timeoutMs;
        while (this.bufferedAmount > lowWaterMark) {
            if (!this.isOpen) {
                throw new Error('WebSocket closed while waiting for backpressure');
            }
            if (Date.now() >= deadline) {
                const error = new Error('WebSocket backpressure timeout');
                error.code = 'WS_BACKPRESSURE_TIMEOUT';
                error.statusCode = 408;
                error.wolfOperationScope = 'transport';
                throw error;
            }
            await new Promise((resolve, reject) => {
                let timer;
                const cleanup = () => {
                    clearTimeout(timer);
                    this.off('close', onClose);
                    this.off('error', onError);
                };
                const onClose = () => {
                    cleanup();
                    reject(new Error('WebSocket closed while waiting for backpressure'));
                };
                const onError = (error) => {
                    cleanup();
                    reject(error);
                };
                timer = setTimeout(() => {
                    cleanup();
                    resolve();
                }, 20);
                this.once('close', onClose);
                this.once('error', onError);
            });
        }
    }
    send(str, cb) {
        var _a;
        (_a = this.socket) === null || _a === void 0 ? void 0 : _a.send(str, cb);
        return Boolean(this.socket);
    }
}
exports.WebSocketClient = WebSocketClient;
