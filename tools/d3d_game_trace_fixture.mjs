#!/usr/bin/env node
// A public, specification-derived clear/readback fixture for the same replay
// path used by private real-game traces. The expected BGRA is not rendered.
import fs from "node:fs";
import { createRequire as create_require } from "node:module";
import { gzipSync as gzip_sync } from "node:zlib";
const require = create_require(import.meta.url), root = new URL("../", import.meta.url);
globalThis.D3D9ShaderPipeline = require("../src/browser/glbridge/d3d9-webgpu/d3d9_shader_pipeline.js");
globalThis.D9WGProtocol = require("../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
require("../tests/glbridge/d3d9_conformance.js");
const trace = require("../tests/glbridge/d9wg_game_trace.js"), cases = globalThis.D3D9Conformance;
const scene = cases.caseBatch(0, { body: () => [], clear: 0xFF00FF00, backBuffer: true });
const expected = Buffer.alloc(64 * 64 * 4);for(let at = 0; at < expected.length; at += 4) { expected[at + 1] = 255;expected[at + 3] = 255; }
const note = { game: "public-clear-fixture", worker: false, width: 64, height: 64,
    readbacks: [{ request: 1, first: 0, count: 64, responseOffset: globalThis.D9WGProtocol.C.D9WG_READBACK_REGION_OFFSET }] };
const directory = new URL("build/browser-test-output/", root);fs.mkdirSync(directory, { recursive: true });
const bytes = await trace.encode([scene.bytes, cases.readbackBatch(1, scene.dev, 0)], note).arrayBuffer();
fs.writeFileSync(new URL("d9wg-fixture-trace.bin.gz", directory), gzip_sync(new Uint8Array(bytes)));
fs.writeFileSync(new URL("d9wg-fixture-golden.bgra.gz", directory), gzip_sync(expected));
const { GraphicsJournal } = require("../src/browser/glbridge/graphics_journal.js");
require("../src/browser/glbridge/v86_network_bridge.js");
const journal = new GraphicsJournal({ worker: false, store: null });
journal.append({}, globalThis.V86GLNetworkBridge.ownerReleasedRecord());
for(const packet of [scene.bytes, cases.readbackBatch(1, scene.dev, 0)])
{
    const envelope = new Uint8Array(8 + packet.length), view = new DataView(envelope.buffer);
    view.setUint16(0, globalThis.D9WGProtocol.C.V86GL_CTRL_D3D9_BATCH, true);view.setUint16(2, 0xFFFF, true);view.setUint32(4, packet.length, true);envelope.set(packet, 8);
    journal.append({}, envelope);journal.append({ barrier: true }, new Uint8Array(0));
}
fs.writeFileSync(new URL("d9wg-journal-fixture-journal.bin", directory), await journal.snapshot());await journal.destroy();
fs.writeFileSync(new URL("d9wg-journal-fixture.json", directory), JSON.stringify({ ...note, format: "paged-d9wg-journal" }));
fs.writeFileSync(new URL("d9wg-journal-fixture-golden.bgra.gz", directory), gzip_sync(expected));
console.log("Prepared public D9WG clear/readback replay fixture");
