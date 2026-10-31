"use strict";
(function(global) {
    const magic = "GLTRACE1", limit = 512 * 1024 * 1024;
    function word(value) {const bytes = new Uint8Array(4);new DataView(bytes.buffer).setUint32(0, value, true);return bytes;}
    function encode(frames) {
        if (!Array.isArray(frames) || !frames.length || frames.length > 1024) throw new Error("invalid GL trace frame count");
        let total = 12;const parts = [new TextEncoder().encode(magic), word(frames.length)];
        for (const frame of frames) {
            if (!Array.isArray(frame) || frame.length > 100000) throw new Error("invalid GL trace packet count");
            parts.push(word(frame.length));total += 4;
            for (const packet of frame) {
                if (!(packet instanceof Uint8Array) || !packet.byteLength) throw new Error("invalid GL trace packet");
                total += 4 + packet.byteLength;if (total > limit) throw new Error("GL trace exceeds limit");parts.push(word(packet.byteLength), packet);
            }
        }
        return new Blob(parts);
    }
    function decode(bytes) {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > limit || bytes.byteLength < 12 || new TextDecoder().decode(bytes.subarray(0, 8)) !== magic) throw new Error("invalid GL trace header");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);let at = 8;
        const read = () => {if (at + 4 > bytes.length) throw new Error("truncated GL trace");const value = view.getUint32(at, true);at += 4;return value;};
        const count = read(), frames = [];if (!count || count > 1024) throw new Error("invalid GL trace frame count");
        for (let f = 0; f < count; ++f) {
            const count = read(), frame = [];if (count > 100000) throw new Error("invalid GL trace packet count");
            for (let p = 0; p < count; ++p) {const size = read();if (!size || at + size > bytes.length) throw new Error("truncated GL trace packet");frame.push(bytes.subarray(at, at + size));at += size;}
            frames.push(frame);
        }
        if (at !== bytes.length) throw new Error("GL trace has trailing bytes");return frames;
    }
    const api = { encode, decode };global.GLGameTrace = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
