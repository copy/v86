import { LOG_SERIAL } from "../const.js";
import { dbg_log } from "../log.js";

import { BusConnector } from "../bus.js";

/**
 * @constructor
 * @param {string} url
 * @param {BusConnector} bus
 */
export function SerialAdapterWebSocket(url, bus) {
    this.url = url;
    this.bus = bus;
    this.socket = null;

    this.byteBuffer = [];

    this.pendingFlushTimeout = null;
    this.flushDelayMs = 10;
    this.lastFlushTime = performance.now();

    this.init();
}

SerialAdapterWebSocket.prototype.init = function() {
    this.connect();

    this.bus.register("serial0-output-byte", (byte) => {
        this.byteBuffer.push(byte);

        const now = performance.now();

        // If we already have a pending trailing flush, let it fire; don't force immediate flush
        if (this.pendingFlushTimeout !== null) {
            return;
        }

        // If this is the first byte in the buffer, prefer scheduling a trailing flush
        if (this.byteBuffer.length === 1) {
            this.maybeScheduleFlush(now, { deferIfDue: true });
            return;
        }

        // If enough time has passed since last flush, flush immediately
        if (now - this.lastFlushTime >= this.flushDelayMs) {
            this.flushBuffer();
        } else {
            // Otherwise, schedule a trailing flush
            this.maybeScheduleFlush(now, {});
        }
    }, this);
};

SerialAdapterWebSocket.prototype.maybeScheduleFlush = function(now, opts) {
    if (this.pendingFlushTimeout !== null) return;

    const options = opts || {};
    const elapsed = now - this.lastFlushTime;
    let remaining = this.flushDelayMs - elapsed;

    if (remaining <= 0) {
        if (options.deferIfDue) {
            // Defer slightly to allow more bytes to join, but keep latency tiny
            remaining = 2;
        } else {
            this.flushBuffer();
            return;
        }
    }

    this.pendingFlushTimeout = setTimeout(() => {
        this.pendingFlushTimeout = null;
        this.flushBuffer();
    }, remaining);
};

SerialAdapterWebSocket.prototype.flushBuffer = function() {
    if (this.pendingFlushTimeout !== null) {
        clearTimeout(this.pendingFlushTimeout);
        this.pendingFlushTimeout = null;
    }

    if (this.byteBuffer.length > 0 && this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(new Uint8Array(this.byteBuffer));
        this.byteBuffer = [];
        this.lastFlushTime = performance.now();
    }
};

SerialAdapterWebSocket.prototype.connect = function() {
    this.socket = new WebSocket(this.url);
    this.socket.binaryType = "arraybuffer";

    this.socket.onopen = () => {
        dbg_log("WebSocket serial adapter connected", LOG_SERIAL);
        this.lastFlushTime = performance.now();
    };

    this.socket.onmessage = (event) => {
        const data = new Uint8Array(/** @type {ArrayBuffer} */ (event.data));
        for (let i = 0; i < data.length; i++) {
            this.bus.send("serial0-input", data[i]);
        }
    };

    this.socket.onclose = () => {
        dbg_log("WebSocket serial adapter disconnected, reconnecting...", LOG_SERIAL);
        if (this.pendingFlushTimeout !== null) {
            clearTimeout(this.pendingFlushTimeout);
            this.pendingFlushTimeout = null;
        }
        setTimeout(() => this.connect(), 5000);
    };

    this.socket.onerror = (error) => {
        dbg_log("WebSocket serial adapter error: " + error, LOG_SERIAL);
    };
};

SerialAdapterWebSocket.prototype.destroy = function() {
    if (this.pendingFlushTimeout !== null) {
        clearTimeout(this.pendingFlushTimeout);
        this.pendingFlushTimeout = null;
    }

    this.flushBuffer();

    if (this.socket) {
        this.socket.onclose = null; // Don't reconnect
        this.socket.close();
    }
};
