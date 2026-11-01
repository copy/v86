// Pure D9WG framing. No devices, resources, GPU objects or diagnostics live
// here: consumers decide how to report a rejected stream before dispatch.
(function(global) {
    "use strict";
    const P = global.D9WGProtocol ||
        (typeof require === "function" ? require("./d9wg_protocol.js") : null);
    if (!P) throw new Error("d9wg_wire.js requires d9wg_protocol.js");
    const BATCH_BYTES = P.STRUCTS.BatchHeader.size, COMMAND_BYTES = P.STRUCTS.CommandHeader.size;
    const B = P.F.BatchHeader, H = P.F.CommandHeader;
    const MIN_PAYLOAD = Object.fromEntries(Object.keys(P.COMMANDS)
        .map(name => [P.OP[name], P.minBytes(P.commandStruct(P.OP[name]))]));

    // Framing disagreement abandons the batch. An ordinary host exception
    // still belongs to one command and is reported separately by dispatch.
    class D9WGStreamError extends Error {}

    // Keep the deployed 1.3–1.7 contract: later fields have schema defaults,
    // and bytes outside command_bytes may belong to the transport's carrier.
    function readHeader(bytes) {
        if (bytes.byteLength < BATCH_BYTES)
            throw new D9WGStreamError("D9WG batch shorter than its header");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint32(B.magic, true) !== P.C.D9WG_MAGIC)
            throw new D9WGStreamError("D9WG batch has the wrong magic");
        const major = view.getUint16(B.version_major, true), minor = view.getUint16(B.version_minor, true);
        if (major !== P.VERSION_MAJOR || minor < P.MIN_MINOR || minor > P.VERSION_MINOR)
            throw new D9WGStreamError("unsupported D9WG version " + major + "." + minor);
        const commandBytes = view.getUint32(B.command_bytes, true);
        if (commandBytes > bytes.byteLength - BATCH_BYTES)
            throw new D9WGStreamError("D9WG batch command_bytes overruns the record");
        const low = view.getUint32(B.session_id_low, true), high = view.getUint32(B.session_id_high, true);
        return { view, end: BATCH_BYTES + commandBytes,
            commandCount: view.getUint32(B.command_count, true),
            sessionKey: high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0"),
            present: (view.getUint32(B.flags, true) & P.C.D9WG_BATCH_FLAG_PRESENT) !== 0 };
    }

    // No command objects or per-command arrays: the hot dispatcher can read
    // the validated view directly. The first sequence can start anywhere,
    // and subsequent uint32 sequence numbers must be consecutive, including
    // wraparound. Payload semantics remain the dispatcher's responsibility.
    function checkStream(view, end, commandCount) {
        const fail = message => { throw new D9WGStreamError("D9WG " + message); };
        let offset = BATCH_BYTES, count = 0, first = 0;
        while (offset < end) {
            if (offset + COMMAND_BYTES > end) fail("command header overruns command_bytes");
            const size = view.getUint32(offset + H.size, true);
            if (size < COMMAND_BYTES || offset + size > end) fail("command size is invalid");
            const sequence = view.getUint32(offset + H.sequence, true);
            if (count === 0) first = sequence;
            else if (sequence !== (first + count) >>> 0)
                fail("command " + count + " has sequence " + sequence + ", the batch's numbering expects " + ((first + count) >>> 0));
            offset += size;++count;
        }
        if (count !== commandCount) fail("command_count does not match the decoded stream");
    }

    const api = { D9WGStreamError, readHeader, checkStream, MIN_PAYLOAD };
    global.D9WGWire = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
