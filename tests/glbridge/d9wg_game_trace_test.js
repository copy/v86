"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const trace = require("./d9wg_game_trace.js");
(async () => {
    // Interoperate with the pre-existing x64 recorder, independently of this
    // browser codec's encoder. Then reject partial/ambiguous archive records.
    const { create_trace_renderer, read_trace } = await import("../x64/gpu_trace.mjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d9wg-trace-")), file = path.join(dir, "trace.bin");
    try {
        const note = { game: "format-fixture" }, packet = new Uint8Array(32);
        new DataView(packet.buffer).setUint32(0, 0x47573944, true);
        const writer = create_trace_renderer(file, note);writer.renderer.listen(() => {});
        writer.renderer.post({ type: "submit", seq: 1, bytes: packet });writer.close();
        const bytes = new Uint8Array(fs.readFileSync(file)), decoded = trace.decode(bytes);
        assert.deepEqual(decoded.note, note);assert.deepEqual(decoded.packets, [packet]);
        const encoded = new Uint8Array(await trace.encode([packet], note).arrayBuffer());
        assert.deepEqual(encoded, bytes);assert.deepEqual(read_trace(encoded), { note, batches: [packet] });
        for (const length of [0, 7, 9, 15, bytes.length - 1]) assert.throws(() => trace.decode(bytes.slice(0, length)));
        const unknown = bytes.slice();new DataView(unknown.buffer).setUint32(8, 7, true);assert.throws(() => trace.decode(unknown), /Unknown/);
        const tail = new Uint8Array(bytes.length + 1);tail.set(bytes);assert.throws(() => trace.decode(tail), /Truncated/);
        assert.throws(() => trace.encode([new Uint8Array(0)], note), /Invalid/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    console.log("PASS D9WG trace agrees with x64 recorder and rejects corrupt archives");
})().catch(error => { console.error(error);process.exitCode = 1; });
