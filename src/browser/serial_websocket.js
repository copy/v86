import { LOG_SERIAL } from "../const.js";
import { dbg_log } from "../log.js";

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
    this.bufferInterval = null;

    this.init();
}

SerialAdapterWebSocket.prototype.init = function() {
    this.connect();

    this.bus.register("serial0-output-byte", (byte) => {
        this.byteBuffer.push(byte);
        if (this.byteBuffer.length >= 500) {
            this.flushBuffer();
        }
    }, this);
};

SerialAdapterWebSocket.prototype.flushBuffer = function() {
    if (this.byteBuffer.length > 0 && this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(new Uint8Array(this.byteBuffer));
        this.byteBuffer = [];
    }
};

SerialAdapterWebSocket.prototype.connect = function() {
    this.socket = new WebSocket(this.url);
    this.socket.binaryType = "arraybuffer";

    this.socket.onopen = () => {
        dbg_log("WebSocket serial adapter connected", LOG_SERIAL);
        this.bufferInterval = setInterval(() => this.flushBuffer(), 10);
    };

    this.socket.onmessage = async (event) => {
        const data = new Uint8Array(event.data);
        for (let i = 0; i < data.length; i++) {
            this.bus.send("serial0-input", data[i]);
        }
    };

    this.socket.onclose = () => {
        dbg_log("WebSocket serial adapter disconnected, reconnecting...", LOG_SERIAL);
        if (this.bufferInterval) {
            clearInterval(this.bufferInterval);
            this.bufferInterval = null;
        }
        setTimeout(() => this.connect(), 5000);
    };

    this.socket.onerror = (error) => {
        dbg_log("WebSocket serial adapter error: " + error, LOG_SERIAL);
    };
};

SerialAdapterWebSocket.prototype.destroy = function() {
    if (this.bufferInterval) {
        clearInterval(this.bufferInterval);
    }
    if (this.socket) {
        this.socket.onclose = null; // Don't reconnect
        this.socket.close();
    }
};
