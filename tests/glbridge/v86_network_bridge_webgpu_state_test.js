#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { GLStream, GL } = require("./gl_stream_builder.js");
require("../../src/browser/glbridge/v86_network_bridge.js");
const { V86WebGPUCompositor } = require("../../src/browser/glbridge/webgpu_compositor.js");

function recordOpcodes(bytes) {
    const result = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    while (offset < bytes.byteLength) {
        const fn = view.getUint16(offset, true);
        let size = view.getUint16(offset + 2, true);
        offset += 4;
        if (size === 0xffff) {
            size = view.getUint32(offset, true);
            offset += 4;
        }
        result.push(fn);
        offset += size;
    }
    return result;
}

(async () => {
    const calls = [];
    const executor = {
        submit(bytes, metadata) {
            calls.push(["submit", bytes.slice(), metadata]);
        },
        onSwapBuffers() { calls.push(["swap"]); },
        resetForReplay() { calls.push(["reset"]); },
    };
    const bridge = globalThis.installV86GLNetworkBridge(null, null, {
        compositor: new V86WebGPUCompositor({ width: 64, height: 64 }),
        glExecutor: executor,
    });

    const authored = new GLStream().makeCurrent(1, 0, 0, 64, 64)
        .call("CLEAR_COLOR", 0.25, 0.5, 0.75, 1)
        .call("CLEAR", GL.COLOR_BUFFER_BIT);
    authored.queryError();
    bridge.pushPCIBatch({ bytes: authored.bytes(), frameId: 1,
        submitCount: 1, commandCount: 4, flags: 1 });

    const summary = await bridge.prepareSaveState();
    assert.ok(summary.entries >= 2);
    // What graphics_proxy.js stores as the device's host state
    const checkpoint = bridge.serializeCheckpoint();
    assert.ok(checkpoint instanceof Uint8Array);
    const parsed = bridge.parseCheckpoint(checkpoint);
    const { GraphicsJournal } = require("../../src/browser/glbridge/graphics_journal.js");
    const glBytes = (await GraphicsJournal.records(parsed).next()).value.bytes;
    assert.ok(recordOpcodes(glBytes).includes(211),
        "query commands replay locally without writing restored guest RAM");

    bridge.beginStateRestore();
    bridge.onPCIStateRestored(checkpoint);
    const queued = new GLStream().makeCurrent(2, 0, 0, 32, 32).bytes();
    bridge.pushPCIBatch({ bytes: queued, frameId: 2,
        submitCount: 2, commandCount: 1, flags: 0 });
    await bridge.finishStateRestore();

    const resetAt = calls.findIndex(call => call[0] === "reset");
    const replayAt = calls.findIndex((call, index) => index > resetAt &&
        call[0] === "submit" && call[2].replay === true);
    const queuedAt = calls.findIndex((call, index) => index > replayAt &&
        call[0] === "submit" && call[2].pciFrameId === 2);
    assert.ok(resetAt >= 0 && replayAt > resetAt && queuedAt > replayAt,
        "restore resets, replays, then drains newly arriving guest work");
    assert.equal(bridge.glJournalBytes, glBytes.byteLength + queued.byteLength);

    // Version 2 stored raw records; keep existing saves loadable after moving
    // new saves to the paged compressed format.
    const version2 = new Uint8Array(32 + 32 + glBytes.length + 32);
    const v2 = new DataView(version2.buffer);
    v2.setUint32(0, 0x32534756, true);
    v2.setUint16(4, 2, true);
    v2.setUint16(6, 32, true);
    v2.setUint32(8, version2.length, true);
    v2.setUint32(16, 2, true);
    v2.setUint32(32, glBytes.length, true);
    v2.setUint32(36, 1, true);
    version2.set(glBytes, 64);
    v2.setUint32(64 + glBytes.length + 24, 1, true);
    await bridge.restoreCheckpoint(version2);
    assert.equal(bridge.glJournalBytes, glBytes.length);
    await bridge.prepareSaveState();
    const migrated = bridge.parseCheckpoint(bridge.serializeCheckpoint());
    assert.equal(migrated.version, 4);
    assert.deepEqual((await GraphicsJournal.records(migrated).next()).value.bytes, glBytes);
    await bridge.graphicsJournal.destroy();
    console.log("v86_network_bridge_webgpu_state_test: ok");
})().catch(error => {
    console.error(error);
    process.exit(1);
});
