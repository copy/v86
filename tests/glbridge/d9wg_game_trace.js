// V86GTRC1, shared with tests/x64/gpu_trace.mjs. No game assets in the repo.
"use strict";
(function(global) {
    const magic = "V86GTRC1", limit = 512 * 1024 * 1024;
    function encode(packets, note) {
        const parts = [new TextEncoder().encode(magic)];let total = 8;
        const record = (type, bytes) => {
            total += 8 + bytes.length;if (total > limit) throw new Error("D9WG trace exceeds 512 MiB");
            const head = new Uint8Array(8), view = new DataView(head.buffer);view.setUint32(0, type, true);view.setUint32(4, bytes.length, true);parts.push(head, bytes);
        };
        record(2, new TextEncoder().encode(JSON.stringify(note)));
        for (const packet of packets) { if (!(packet instanceof Uint8Array) || !packet.length) throw new Error("Invalid D9WG trace packet");record(1, packet); }
        return new Blob(parts);
    }
    function decode(bytes) {
        if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > limit || new TextDecoder().decode(bytes.subarray(0, 8)) !== magic) throw new Error("Invalid D9WG trace header");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), packets = [];let at = 8, note;
        while (at < bytes.length) {
            if (at + 8 > bytes.length) throw new Error("Truncated D9WG trace record");
            const type = view.getUint32(at, true), length = view.getUint32(at + 4, true);at += 8;
            if (length > bytes.length - at) throw new Error("Truncated D9WG trace payload");
            const value = bytes.subarray(at, at + length);at += length;
            if (type === 1) { if (!length) throw new Error("Empty D9WG trace packet");packets.push(value); }
            else if (type === 2) { if (note) throw new Error("Duplicate D9WG trace note");note = JSON.parse(new TextDecoder().decode(value)); }
            else throw new Error("Unknown D9WG trace record " + type);
        }
        if (!note || !packets.length) throw new Error("Incomplete D9WG trace");return { packets, note };
    }
    const api = { encode, decode };global.D9WGGameTrace = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
