"use strict";
// The graphics proxy's host side (graphics_proxy.js): one screen canvas, owned
// by the WebGPU compositor, with each API's output a window layer placed in
// guest desktop pixels; WebGPU failing hands the screen back to the 2D canvas.
// As a device plugin it takes batches from its device over a channel, answers
// readbacks through it, and tells the device whether a renderer is there.
const assert = require("node:assert/strict");
require("../../src/browser/glbridge/v86_network_bridge.js");
require("../../src/browser/glbridge/webgpu_compositor.js");
require("../../src/browser/glbridge/v86gl_device.js");
const { V86GraphicsProxy, createGraphicsBridge } = require("../../src/browser/glbridge/graphics_proxy.js");

function fixture({ webgpu = true } = {}) {
    const screen = { width: 640, height: 480, toDataURL: () => "data:image/png;base64,",
        ownerDocument: { defaultView: { Image: class { } } } };
    let graphical = true, terminated = 0;
    const hosts = [], resets = [], backend = [], errors = [];
    const makeHost = () => {
        const host = { format: "bgra8unorm", destroyed: false, deviceLostHandlers: new Set(),
            context: { configure() {}, unconfigure() {} },
            device: { destroyed: 0, destroy() { this.destroyed++; },
                createShaderModule: () => ({}), createRenderPipeline: () => ({}), createSampler: () => ({}) },
            initialize: () => webgpu ? Promise.resolve() : Promise.reject(new Error("no WebGPU")),
            onDeviceLost(fn) { this.deviceLostHandlers.add(fn); } };
        hosts.push(host);
        return host;
    };
    let current = null;
    global.V86GPUHost = {
        acquire(canvas) { assert.equal(canvas, screen); return current || (current = makeHost()); },
        reset(canvas) { resets.push(canvas); current = null; },
    };
    const executor = () => ({ initialize() { return Promise.resolve(); }, work: Promise.resolve() });
    const emulator = {};
    const options = { screenCanvas: screen,
        screenBackend: { set: value => backend.push(["set", value]), fallback: () => backend.push(["fallback"]) },
        onError: error => errors.push(error),
        isGraphical: () => graphical, glExecutor: executor(), d3d9Executor: executor() };
    options.d3d9Executor.shaderWorker = { terminate() { terminated++; } };
    return { emulator, options, screen, hosts, resets, backend, errors,
        setGraphical(value) { graphical = value; }, terminated: () => terminated };
}

const placed = layer => [layer.x, layer.y, layer.width, layer.height, layer.visible];

(async () => {
    const f = fixture();
    assert.throws(() => createGraphicsBridge(f.emulator, { ...f.options, screenBackend: undefined }),
        /screen canvas/, "the adapter draws through the emulator's screen, nothing else");
    const bridge = createGraphicsBridge(f.emulator, f.options);
    const compositor = bridge.compositor;
    assert.equal(compositor.canvas, f.screen, "the compositor owns the screen canvas");
    assert.equal(compositor.host, f.hosts[0], "executors created before WebGPU is up already share its host");
    await bridge.ready;
    assert.ok(compositor.attached);
    assert.deepEqual(f.backend, [["set", compositor]], "the screen draws through the compositor once WebGPU is up");
    assert.deepEqual(compositor.layers.map(layer => layer.name), ["gl", "d3d9"]);
    const gl = bridge.glCanvas.layer, d3d9 = bridge.d3d9Canvas.layer;
    assert.ok(compositor.layers.every(layer => !layer.visible), "boot shows only the guest desktop");

    bridge.glSurface = { x: 50, y: 60, width: 200, height: 100 };
    bridge.showOwner("gl");
    assert.deepEqual(placed(gl), [50, 60, 200, 100, true], "placed in guest desktop pixels");
    assert.deepEqual(gl.clip, { left: 0, top: 0, right: 1, bottom: 1 });
    bridge.glSurface = { x: -20, y: -10, width: 200, height: 100 };
    bridge.placeLayers();
    assert.deepEqual(gl.clip, { left: 0.1, top: 0.1, right: 1, bottom: 1 }, "off-desktop pixels are clipped");
    bridge.glSurface = { x: 400, y: 300, width: 640, height: 480, ddDesktopPrimary: true,
        clipRect: { left: 32, top: 24, right: 608, bottom: 456, baseWidth: 640, baseHeight: 480 } };
    bridge.placeLayers();
    assert.deepEqual(placed(gl), [0, 0, 640, 480, true], "a DirectDraw primary stays aligned to the desktop");
    assert.deepEqual(gl.clip, { left: 0.05, top: 0.05, right: 0.95, bottom: 0.95 });

    bridge.showOwner("d3d9");
    assert.equal(gl.visible, false, "one API's window at a time");
    assert.equal(d3d9.visible, true);

    const extra = compositor.createLayer("d3d9 swap chain 7").canvas;
    bridge.d3d9SwapChainCanvases.set(7, extra);
    bridge.placeD3D9SwapChain({ swapChain: 7, x: 10, y: 20, width: 100, height: 80 });
    assert.deepEqual(placed(extra.layer), [10, 20, 100, 80, true]);
    bridge.hideLayers();
    assert.equal(extra.layer.visible, true, "hiding a primary window preserves independent swap-chain windows");

    f.setGraphical(false);
    bridge.screenChanged();
    assert.ok(compositor.layers.every(layer => !layer.visible), "text mode shows no window layers");
    f.setGraphical(true);
    bridge.screenChanged();
    assert.ok(compositor.layers.every(layer => !layer.visible), "return to graphics waits for a fresh Present");

    // A reset starts over on a fresh device; the compositor moves with it
    const first = f.hosts[0];
    await bridge.reset();
    assert.equal(first.device.destroyed, 1, "the old device is destroyed");
    assert.deepEqual(f.resets, [f.screen]);
    assert.equal(compositor.host, f.hosts[1]);
    assert.ok(compositor.attached);
    assert.equal(f.backend.length, 1, "the screen stays with the compositor");
    assert.equal(f.terminated(), 1, "the executors' workers are stopped");

    const promise = bridge.destroy();
    assert.equal(bridge.destroy(), promise, "destroy is idempotent");
    await promise;
    assert.ok(compositor.attached, "the compositor keeps drawing the screen");
    bridge.showOwner("gl");
    assert.equal(gl.visible, false, "late callbacks cannot resurrect a destroyed window");

    // Without WebGPU, the screen goes back to its 2D canvas
    const g = fixture({ webgpu: false });
    const failed = createGraphicsBridge(g.emulator, g.options);
    await failed.ready;
    assert.deepEqual(g.backend, [["fallback"]]);
    assert.equal(g.errors.length, 1);
    assert.ok(failed.failed);
    assert.equal(failed.makeScreenshot(), null, "no composed screenshot without WebGPU");
    await failed.destroy();

    // The plugin: its device on one end of a channel, the renderer on the other
    const p = fixture();
    const toDevice = [];
    let toHost = null;
    const channel = { remote: false, post: message => toDevice.push(message), listen: handler => { toHost = handler; } };
    const plugin = V86GraphicsProxy({ onError: p.options.onError, glExecutor: p.options.glExecutor,
        d3d9Executor: p.options.d3d9Executor });
    assert.equal(plugin.name, "v86gl");
    assert.ok(plugin.wants_screen);
    assert.equal(typeof plugin.create_device({ remote: false, post() {}, listen() {} }).notify, "function",
        "the device comes from v86gl_device.js");
    const started = plugin.start({ emulator: p.emulator, channel, screen: {
        canvas: p.screen, set_backend: value => p.backend.push(["set", value]),
        fallback: () => p.backend.push(["fallback"]), is_graphical: () => true } });
    assert.deepEqual(toDevice, [{ type: "initializing", value: true }], "startup batches wait for the CPU front end and capabilities");
    await started;
    assert.deepEqual(toDevice.filter(m => m.type === "available"), [{ type: "available", value: true }]);
    assert.equal(toDevice.at(-1).type, "initializing");
    assert.equal(toDevice.at(-1).value, false);
    assert.ok(toDevice.some(m => m.type === "glslang" && m.error), "a missing compiler reaches the CPU as a terminal failure");
    assert.equal(p.backend[0][0], "set");
    const pushed = [];
    plugin.bridge.pushPCIBatch = event => pushed.push(event);
    const bytes = new Uint8Array([1, 2, 3]);
    toHost({ type: "batch", id: 7, generation: 3, frameId: 9, flags: 1, commandCount: 1, descAddr: 0x1000,
        descLen: 35, batchAddr: 0x1020, responseBase: 0, submitCount: 1, bytes });
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].bytes, bytes, "on one thread the batch is not copied");
    assert.equal(pushed[0].frameId, 9);
    assert.deepEqual(toDevice.at(-1), { type: "done", id: 7 }, "on one thread done follows at once");
    pushed[0].writeGuestMemory(0x40, new Uint8Array([5]));
    assert.deepEqual(toDevice.at(-1), { type: "write", generation: 3, offset: 0x40, bytes: new Uint8Array([5]) },
        "a readback goes to the arena generation of its batch");
    assert.ok(pushed[0].isMemoryValid());
    toHost({ type: "batch", id: 8, generation: 3, frameId: 10, bytes });
    assert.ok(!pushed[0].isInlineMemoryValid(), "the next submission expires the inline arena");
    assert.ok(pushed[0].isMemoryValid(), "dedicated response slots retain their arena lifetime");
    const beforeLate = toDevice.length;
    pushed[0].writeGuestMemory(0x40, new Uint8Array([6]), true);
    assert.equal(toDevice.length, beforeLate, "an expired inline response is dropped on the local path too");
    pushed[1].writeGuestMemory(0x40, new Uint8Array([7]), true);
    assert.equal(toDevice.at(-1).inlineId, 8, "the device can also reject stale responses across threads");
    const waitForSpace = plugin.bridge.graphicsJournal.waitForSpace;
    let releaseHistory;
    const historyPressure = new Promise(resolve => { releaseHistory = resolve; });
    plugin.bridge.graphicsJournal.waitForSpace = () => historyPressure;
    toHost({ type: "batch", id: 9, generation: 3, frameId: 11, bytes });
    assert.notDeepEqual(toDevice.at(-1), { type: "done", id: 9 }, "local ACK waits for raw journal space");
    releaseHistory();await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(toDevice.at(-1), { type: "done", id: 9 });
    plugin.bridge.graphicsJournal.waitForSpace = waitForSpace;
    plugin.bridge.beginStateRestore = () => {};
    plugin.bridge.waitForIdle = async () => {};
    await plugin.before_restore();
    const sent = toDevice.length;
    pushed[0].writeGuestMemory(0x40, new Uint8Array([6]));
    assert.equal(toDevice.length, sent, "readbacks from before a restore are dropped");
    assert.ok(!pushed[0].isMemoryValid());
    plugin.bridge.prepareSaveState = async () => {};
    plugin.bridge.serializeCheckpoint = () => bytes;
    assert.equal(await plugin.prepare_save(), bytes, "the checkpoint is the device's host state");
    await plugin.destroy();
    assert.deepEqual(toDevice.at(-1), { type: "available", value: false });

    // Across threads: one batch at a time, acknowledged when the renderer is done
    const r = fixture();
    const toRemote = [];
    let fromRemote = null;
    const remote = V86GraphicsProxy({ glExecutor: r.options.glExecutor, d3d9Executor: r.options.d3d9Executor });
    await remote.start({ emulator: r.emulator, channel: { remote: true, post: (m, transfer) => toRemote.push([m, transfer]),
        listen: handler => { fromRemote = handler; } }, screen: { canvas: r.screen, set_backend() {}, fallback() {}, is_graphical: () => true } });
    const order = [];
    let finish;
    remote.bridge.pushPCIBatch = event => { order.push("push " + event.frameId); remote.lastEvent = event; };
    remote.bridge.waitForSubmittedBatches = () => new Promise(resolve => { finish = resolve; });
    const batch = (id, frameId) => fromRemote({ type: "batch", id, generation: 1, frameId, flags: 0, commandCount: 1,
        descAddr: 0, descLen: 33, batchAddr: 32, responseBase: 0, submitCount: id, bytes: new Uint8Array([id]) });
    batch(1, 10);
    batch(2, 11);
    assert.deepEqual(remote.stats, { graphics_batches: 2, graphics_bytes: 2, graphics_pending: 2, graphics_peak_pending: 2 });
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(order, ["push 10"], "the second batch waits for the first");
    const buffer = new Uint8Array([9, 9]);
    remote.lastEvent.writeGuestMemory(8, buffer);
    const [write, transfer] = toRemote.at(-1);
    assert.notEqual(write.bytes.buffer, buffer.buffer, "a readback crosses the thread as a copy");
    assert.deepEqual(transfer, [write.bytes.buffer]);
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(toRemote.some(([m]) => m.type === "done" && m.id === 1));
    assert.deepEqual(order, ["push 10", "push 11"]);
    finish();
    await remote.idle();
    assert.ok(toRemote.some(([m]) => m.type === "done" && m.id === 2));
    assert.equal(remote.stats.graphics_pending, 0);
    // A completed GPU job can append its CPU continuation during draining.
    // A save must include the appended work before preparing its checkpoint.
    let prepared = false, saved = false, continuation;
    const oldPrepare = remote.bridge.prepareSaveState, oldSerialize = remote.bridge.serializeCheckpoint;
    remote.bridge.prepareSaveState = async () => { prepared = true; };
    remote.bridge.serializeCheckpoint = () => new Uint8Array([42]);
    remote.bridge.waitForSubmittedBatches = () => {
        if (remote.lastEvent.frameId === 20) { batch(5, 21); return Promise.resolve(); }
        return new Promise(resolve => { continuation = resolve; });
    };
    batch(4, 20);
    const saving = remote.prepare_save().then(value => { saved = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(prepared, false); assert.equal(saved, false, "save waits for work appended by a completing GPU job");
    continuation(); assert.deepEqual(await saving, new Uint8Array([42])); assert.equal(prepared, true);
    remote.bridge.prepareSaveState = oldPrepare; remote.bridge.serializeCheckpoint = oldSerialize;
    // A batch that fails loses only itself: acknowledged, renderer still available
    remote.bridge.waitForSubmittedBatches = () => Promise.reject(new Error("a host bug"));
    batch(3, 12);
    await remote.idle();
    assert.ok(toRemote.some(([m]) => m.type === "done" && m.id === 3));
    assert.ok(!toRemote.some(([m]) => m.type === "available" && m.value === false),
        "one failed batch does not take graphics away for the session");
    // The arena's owner is gone: a record behind its batches ends its sessions
    remote.bridge.waitForSubmittedBatches = () => Promise.resolve();
    fromRemote({ type: "released" });
    await remote.idle();
    assert.ok(remote.lastEvent.released, "the release reaches the bridge in order");
    assert.equal(remote.lastEvent.bytes[0] | remote.lastEvent.bytes[1] << 8, 0xffe2);
    await remote.destroy();

    // Without WebGPU the device hears that nothing renders
    const q = fixture({ webgpu: false });
    const toFailedDevice = [];
    const failedPlugin = V86GraphicsProxy({ onError: q.options.onError, glExecutor: q.options.glExecutor,
        d3d9Executor: q.options.d3d9Executor });
    await failedPlugin.start({ emulator: q.emulator, channel: { remote: false, post: m => toFailedDevice.push(m), listen() {} },
        screen: { canvas: q.screen, set_backend() {}, fallback() {}, is_graphical: () => true } });
    assert.deepEqual(toFailedDevice.filter(m => m.type === "initializing").map(m => m.value), [true, false]);
    assert.ok(!toFailedDevice.some(m => m.type === "available" && m.value));
    await failedPlugin.destroy();

    // A slow compiler cannot expose a window where CPU queries accidentally
    // fall back to the renderer. WebGPU being ready is insufficient.
    const slow = fixture(), startupMessages = [], oldFetch = global.fetch;
    let finishFetch;
    global.fetch = () => new Promise(resolve => { finishFetch = resolve; });
    const slowPlugin = V86GraphicsProxy({ onError: slow.options.onError, glExecutor: slow.options.glExecutor,
        d3d9Executor: slow.options.d3d9Executor, glslang: "https://compiler.invalid/glslang.wasm" });
    try {
        const startup = slowPlugin.start({ emulator: slow.emulator,
            channel: { remote: true, post: m => startupMessages.push(m), listen() {} },
            screen: { canvas: slow.screen, set_backend() {}, fallback() {}, is_graphical: () => true } });
        await slowPlugin.bridge.ready;
        assert.ok(!startupMessages.some(m => m.type === "available"));
        assert.deepEqual(startupMessages.filter(m => m.type === "initializing").map(m => m.value), [true]);
        finishFetch({ arrayBuffer: async () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer });
        await startup;
        const compilerAt = startupMessages.findIndex(m => m.type === "glslang" && m.module);
        const releasedAt = startupMessages.findIndex(m => m.type === "initializing" && !m.value);
        assert.ok(compilerAt > 0 && releasedAt > compilerAt, "release startup only after sending the CPU compiler");
    } finally { global.fetch = oldFetch; await slowPlugin.destroy(); }

    console.log("graphics_proxy_test: ok");
})().catch(error => { console.error(error); process.exitCode = 1; });
