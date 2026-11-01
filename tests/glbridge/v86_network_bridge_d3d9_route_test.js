"use strict";

const assert = require("node:assert/strict");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");

require("../../src/browser/glbridge/v86_network_bridge.js");
const { V86WebGPUCompositor } = require("../../src/browser/glbridge/webgpu_compositor.js");

const listeners = Object.create(null);
const routed = [];
let d3d9Options;
const compositor = new V86WebGPUCompositor({ width: 1024, height: 768 });
/*
 * write_memory is modelled on v86's real one rather than just recording its
 * arguments, because the bug this guards against is invisible to a recorder:
 * v86 spells it write_memory(blob, address) -- the opposite order to
 * read_memory(address, length) -- and it bottoms out in mem8.set(blob, addr).
 * Called the other way round, TypedArray.set() gets a number as its source,
 * copies nothing and throws nothing. Every readback response and query answer
 * was being dropped exactly that way, and the guest could only report a
 * timeout.
 */
const guestMemory = new Uint8Array(4096);
const bridge = globalThis.installV86GLNetworkBridge({
    add_listener(name, callback) { listeners[name] = callback; },
    write_memory(blob, address) { guestMemory.set(blob, address); },
}, null, {
    compositor,
    glExecutor: { submit() {}, onSwapBuffers() {} },
    installD3D9WebGPUExecutor(installedCanvas, options) {
        assert.equal(installedCanvas.layer.name, "d3d9", "D3D9 draws into its own window layer");
        assert.equal(options.host, installedCanvas.layer.host);
        d3d9Options = options;
        return {
            submit(bytes, metadata) { routed.push({ bytes: Buffer.from(bytes), metadata }); },
        };
    },
});

const d3d9Layer = bridge.d3d9Canvas.layer, glLayer = bridge.glCanvas.layer;
const placed = layer => [layer.x, layer.y, layer.width, layer.height, layer.visible];

bridge.lastPresentedFrameId = 999;
const d9wg = Buffer.from(P.encodeBatch([], { version_minor: 3, session_id_low: 0xA0010001, session_id_high: 0x20260806 }));
const envelope = Buffer.alloc(8 + d9wg.length);
envelope.writeUInt16LE(0xFFE1, 0);
envelope.writeUInt16LE(0xFFFF, 2);
envelope.writeUInt32LE(d9wg.length, 4);
d9wg.copy(envelope, 8);

bridge.pushPCIBatch({
    bytes: envelope,
    frameId: 1,
    submitCount: 7,
    commandCount: 1,
    flags: 0,
});

assert.equal(routed.length, 1,
    "D9WG routing must not be rejected by the OpenGL stale-frame counter");
assert.deepEqual(routed[0].bytes, d9wg);
assert.equal(routed[0].metadata.pciFrameId, 1);
assert.equal(routed[0].metadata.submitCount, 7);
assert.equal(routed[0].metadata.descriptorCommandCount, 1);
assert.equal(routed[0].metadata.descriptorBase, 0);
assert.equal(typeof routed[0].metadata.writeGuestMemory, "function");

// The bytes have to actually land, at the address asked for.
routed[0].metadata.writeGuestMemory(64, Uint8Array.from([1, 2, 3, 4]));
assert.deepEqual([...guestMemory.subarray(64, 68)], [1, 2, 3, 4],
    "a host->guest write must reach guest memory at the requested offset");
assert.deepEqual([...guestMemory.subarray(0, 4)], [0, 0, 0, 0],
    "and must not land at offset 0 instead");
// The arena bound is still enforced.
assert.throws(() => routed[0].metadata.writeGuestMemory(16 * 1024 * 1024,
    Uint8Array.from([9])), RangeError);

d3d9Options.onSurface({ hwnd: 0x1234, x: 10, y: 20, width: 640,
    height: 480, displayWidth: 640, displayHeight: 480, visible: true }, "create");
d3d9Options.onPresent({ hwnd: 0x1234, x: 10, y: 20, width: 640,
    height: 480, displayWidth: 640, displayHeight: 480, visible: true }, {});
assert.deepEqual(placed(d3d9Layer), [10, 20, 640, 480, true]);
assert.equal(glLayer.visible, false);

// A DDSCL_NORMAL primary is the whole desktop even when the application that
// presents it is a small splash HWND. The dirty rectangle clips the layer;
// the HWND must not resize and stretch the desktop texture into 420x170.
d3d9Options.onPresent({ hwnd: 0x1234, x: 302, y: 299, width: 420,
    height: 170, displayWidth: 1024, displayHeight: 768,
    ddDesktopPrimary: true, visible: true,
    clipRect: { left: 302, top: 299, right: 722, bottom: 469,
        baseWidth: 1024, baseHeight: 768 } }, {});
assert.deepEqual(placed(d3d9Layer), [0, 0, 1024, 768, true]);
assert.deepEqual(d3d9Layer.clip, { left: 302 / 1024, top: 299 / 768, right: 722 / 1024, bottom: 469 / 768 },
    "the desktop layer must expose only the splash dirty rectangle");

d3d9Options.onSurface({ hwnd: 0x1234, x: 30, y: 40, width: 640,
    height: 480, displayWidth: 800, displayHeight: 600,
    ddDesktopPrimary: false, clipRect: null, visible: true }, "move");
assert.deepEqual(placed(d3d9Layer).slice(0, 4), [30, 40, 800, 600]);

d3d9Options.onSurface({ hwnd: 0x1234, x: 0, y: 0, width: 640,
    height: 480, displayWidth: 800, displayHeight: 600, visible: false }, "hide");
assert.equal(d3d9Layer.visible, false);
d3d9Options.onPresent({ sessionKey: "new-session", hwnd: 0x1234,
    x: 30, y: 40, width: 640, height: 480, displayWidth: 800,
    displayHeight: 600, visible: true }, {});
assert.deepEqual(placed(d3d9Layer), [30, 40, 800, 600, true]);

d3d9Options.onSurface({ sessionKey: "pending-session", hwnd: 0x5678,
    x: 500, y: 600, width: 320, height: 200, visible: true }, "create");
assert.deepEqual(placed(d3d9Layer), [30, 40, 800, 600, true],
    "a helper session's CreateDevice must not hide or move the presenting owner");
d3d9Options.onDestroy({ sessionKey: "pending-session", hwnd: 0x5678,
    x: 500, y: 600, width: 320, height: 200, visible: false }, "session-end");
assert.equal(d3d9Layer.visible, true,
    "tearing down a non-owner session must leave the owner visible");

d3d9Options.onDestroy({ sessionKey: "old-session", hwnd: 0x1234,
    x: 30, y: 40, width: 640, height: 480, displayWidth: 800,
    displayHeight: 600, visible: true }, "device");
assert.equal(d3d9Layer.visible, true,
    "late teardown from an old process session must not hide the new owner");
d3d9Options.onDestroy({ sessionKey: "new-session", hwnd: 0x1234,
    x: 30, y: 40, width: 640, height: 480, displayWidth: 800,
    displayHeight: 600, visible: true }, "device");
assert.equal(d3d9Layer.visible, false);

d3d9Options.onSurface({ sessionKey: "next-session", hwnd: 0x9999,
    x: 5, y: 6, width: 320, height: 200, visible: true }, "create");
assert.equal(d3d9Layer.visible, false,
    "a new session stays hidden until its own first Present");
d3d9Options.onPresent({ sessionKey: "next-session", hwnd: 0x9999,
    x: 5, y: 6, width: 320, height: 200, displayWidth: 320, displayHeight: 200, visible: true }, {});
assert.deepEqual(placed(d3d9Layer), [5, 6, 320, 200, true]);

// Covered by other guest windows: hidden, whatever is presented meanwhile,
// until the guest says it is uncovered
const next = { sessionKey: "next-session", hwnd: 0x9999, x: 5, y: 6, width: 320, height: 200,
    displayWidth: 320, displayHeight: 200, visible: true };
d3d9Options.onSurface({ ...next, occluded: true, visibleRegion: null }, "window-state");
assert.equal(d3d9Layer.visible, false, "a covered window's picture is not drawn");
assert.equal(bridge.activeOwner, "d3d9", "it is still the one on screen");
d3d9Options.onPresent({ ...next }, {});
assert.equal(d3d9Layer.visible, false, "a Present behind the popup does not uncover it");
// A message box over the right half: only the left half shows
d3d9Options.onSurface({ ...next, occluded: false, visibleRegion: { rects: [{ left: 0, top: 0, right: 160, bottom: 200 }],
    baseWidth: 320, baseHeight: 200, originX: 5, originY: 6 } }, "window-state");
assert.equal(d3d9Layer.visible, true, "uncovered: shown again right away");
assert.deepEqual(d3d9Layer.visibleRegion, [{ left: 0, top: 0, right: 0.5, bottom: 1 }]);
d3d9Options.onPresent({ ...next }, {});
assert.deepEqual(d3d9Layer.visibleRegion, [{ left: 0, top: 0, right: 0.5, bottom: 1 }],
    "the region holds across Presents");
d3d9Options.onSurface({ ...next, visibleRegion: null }, "window-state");
assert.equal(d3d9Layer.visibleRegion, null, "all of it shows once the box closes");

// A DirectDraw desktop primary is the whole desktop: the region is placed
// where the presenting window's client area is on it
d3d9Options.onPresent({ ...next, x: 302, y: 299, width: 420, height: 170, displayWidth: 1024,
    displayHeight: 768, ddDesktopPrimary: true,
    visibleRegion: { rects: [{ left: 0, top: 0, right: 210, bottom: 170 }],
        baseWidth: 420, baseHeight: 170, originX: 302, originY: 299 } }, {});
assert.deepEqual(placed(d3d9Layer), [0, 0, 1024, 768, true]);
assert.deepEqual(d3d9Layer.visibleRegion, [{ left: 302 / 1024, top: 299 / 768, right: 512 / 1024, bottom: 469 / 768 }]);
d3d9Options.onPresent({ ...next, ddDesktopPrimary: false, clipRect: null, visibleRegion: null }, {});

bridge.showOwner("gl");
assert.equal(d3d9Layer.visible, false);
assert.equal(glLayer.visible, true);

// Additional swap chains are layers of their own, placed like the owner's
const swapChainCanvas = d3d9Options.createSwapChainCanvas({ swapChain: 7, width: 100, height: 80 });
assert.equal(swapChainCanvas.layer.name, "d3d9 swap chain 7");
bridge.placeD3D9SwapChain({ swapChain: 7, x: 10, y: 20, width: 100, height: 80, visible: true });
assert.deepEqual(placed(swapChainCanvas.layer), [10, 20, 100, 80, true]);
bridge.hideLayers();
assert.equal(swapChainCanvas.layer.visible, true, "hiding the primary window keeps other swap chains");
bridge.hideLayers(true);
assert.equal(swapChainCanvas.layer.visible, false);
bridge.removeD3D9SwapChain(7);
assert.ok(!compositor.layers.includes(swapChainCanvas.layer), "a destroyed swap chain's layer goes");

const beforeReset = guestMemory.slice();
++bridge.memoryGeneration;
routed[0].metadata.writeGuestMemory(0, new Uint8Array([123]));
assert.deepEqual(guestMemory, beforeReset, "a late GPU readback cannot overwrite memory after restore/restart");
console.log("v86_network_bridge_d3d9_route_test: ok");
