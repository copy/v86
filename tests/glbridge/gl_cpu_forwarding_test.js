"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_state.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_buffers.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_lists.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_select.js");
require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_glsl.js");
require("../../src/browser/glbridge/v86_network_bridge.js");
const { V86WebGPUCompositor } = require("../../src/browser/glbridge/webgpu_compositor.js");
const { createV86GLDevice } = require("../../src/browser/glbridge/v86gl_device.js");
const { V86GraphicsProxy } = require("../../src/browser/glbridge/graphics_proxy.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js"), { GLStream, GL } = require("./gl_stream_builder.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const selectionCases = require("./gl_selection_cases.js");
const programCases = require("./gl_selection_program_cases.js");
const wasm = new WebAssembly.Module(fs.readFileSync(path.join(__dirname, "../../bios/glslang.wasm")));
// Exercise the expansion boundary independently of a particular list/evaluator
// implementation: generated commands must still pass normal CPU validation.
GLShadow.part({ routeRecord(shadow, fn, bytes, view, offset) {
    if (fn !== P.GLFN.LINE_WIDTH || view.getFloat32(offset, true) !== 17) return;
    return { commands: shadow.expand(new GLStream().call("LINE_WIDTH", 5).call("LINE_WIDTH", -3).call("POINT_SIZE", 4).bytes()) };
} });
function opcodes(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), result = [];
    for (let at = 0; at < bytes.length;) {
        result.push(view.getUint16(at, true)); let size = view.getUint16(at + 2, true); at += 4;
        if (size === 0xFFFF) { size = view.getUint32(at, true); at += 4; } at += size;
    }
    return result;
}
(async () => {
    for (const remote of [false, true]) {
        const { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize();
        const bridge = global.installV86GLNetworkBridge(null, null, { managedState: true, glExecutor: gpu,
            d3d9Executor: { options: {}, work: Promise.resolve() }, compositor: new V86WebGPUCompositor({ width: 64, height: 64 }) });
        bridge.ready = Promise.resolve();
        bridge.destroy = async () => { bridge.destroyed = true; await bridge.graphicsJournal.destroy(); };
        const executed = [], execute = bridge.executePCIBatch.bind(bridge);
        bridge.executePCIBatch = (event, bytes) => { executed.push(bytes.slice()); return execute(event, bytes); };
        const memory = new Uint8Array(16 * 1024 * 1024), arena = 0x100000, queue = [], messages = [];
        let cpuListener, hostListener, reply;
        const device = createV86GLDevice({ remote, listen: fn => { cpuListener = fn; }, post: message => { messages.push(message); hostListener(message); } });
        device.init({ is_feature_negotiated: () => true, has_request: () => !!queue.length, pop_request: () => queue.shift(),
            flush() {}, needs_reset() { throw new Error("unexpected reset"); }, is_ram: () => true,
            read_memory: (at, count) => memory.subarray(at - arena, at - arena + count),
            write_memory: (bytes, at) => memory.set(bytes, at - arena) });
        const proxy = V86GraphicsProxy({ createBridge: () => bridge, glslang: wasm });
        await proxy.start({ emulator: {}, screen: { canvas: {}, set_backend() {}, fallback() {}, is_graphical: () => true },
            channel: { remote, listen: fn => { hostListener = fn; }, post: message => cpuListener(message) } });
        function request(words) {
            queue.push({ readable: 24, writable: 16, read: () => new Uint8Array(new Uint32Array(words).buffer),
                write: bytes => { reply = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true); }, complete() {} });
            device.notify(); assert.equal(reply, 0);
        }
        request([1, arena, 0, memory.length, 0, 0]);
        async function submit(stream) {
            const bytes = stream.bytes(), header = new DataView(memory.buffer);
            header.setUint32(0, 0x324C4756, true); header.setUint32(4, 1, true); header.setUint32(20, bytes.length, true);
            memory.set(bytes, 32); request([2, 0, 0, 32 + bytes.length, 0, 0]);
            await proxy.idle(); await gpu.idle(); stream.buffer.set(memory.subarray(32, 32 + bytes.length));
        }
        const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1).call("LINE_WIDTH", -1).call("LINE_WIDTH", 3);
        const badHeader = P.encodeRecord("BUFFER_DATA", { target: 0, size: 131072, data_size: 131072 }), bad = new Uint8Array(badHeader.length + 131072);
        bad.set(badHeader); stream.record(P.GLFN.BUFFER_DATA, bad).call("CLEAR_COLOR", 0.25, 0.5, 0.75, 1).call("CLEAR", GL.COLOR_BUFFER_BIT);
        stream.queryError(); const firstError = stream.payloadView();
        const pixel = stream.readPixels(0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, 4);
        await submit(stream);
        assert.equal(firstError.view.getUint32(P.F.QUERY_ERROR.status, true), 1);
        assert.equal(firstError.view.getUint32(P.F.QUERY_ERROR.value, true), GL.INVALID_VALUE);
        assert.equal(pixel.view.getUint32(P.F.READ_PIXELS.status, true), 1, "asynchronous response keeps the original offset after a large rejected record");
        assert.equal(gpu.current.lineWidth, 3); assert.equal(gpu.stats.refusals, 0); assert.equal(gpu.hostErrors.length, 0);
        assert.ok(messages.find(m => m.type === "batch").segments.length > 1);
        assert.ok(executed.flatMap(opcodes).every(fn => !P.isRejected(fn)), "only accepted commands reach the renderer and journal");
        const count = executed.length, commands = gpu.stats.commands, journal = bridge.glJournalBytes;
        await submit(new GLStream().call("LINE_WIDTH", -2));
        assert.deepEqual(messages.at(-1).segments, []); assert.equal(executed.length, count);
        assert.equal(gpu.stats.commands, commands); assert.equal(bridge.glJournalBytes, journal);
        const error = async expected => {
            const s = new GLStream(); s.queryError(); const q = s.payloadView(); await submit(s);
            assert.equal(q.view.getUint32(P.F.QUERY_ERROR.status, true), 1);
            assert.equal(q.view.getUint32(P.F.QUERY_ERROR.value, true), expected);
        };
        await error(GL.INVALID_VALUE); await error(GL.NO_ERROR);
        const selecting = selectionCases.selection(), drawCount = gpu.stats.draws;
        await submit(selecting.stream); assert.equal(selecting.result.view.getInt32(P.F.QUERY_RENDER_MODE.result, true), selecting.expectedResult);
        assert.equal(gpu.stats.draws, drawCount, "selection expands lists on CPU without rendering their geometry");
        assert.deepEqual(Array.from(gpu.current.current.rasterPos), [16, 16, 0.5, 1]);
        assert.deepEqual(Array.from(gpu.current.current.rasterColor), [1, 0, 0, 1]);
        let selected = selectionCases.read(selecting.result); await submit(selected.stream);
        assert.deepEqual(selecting.expected, Array.from({ length: 8 }, (_, i) => selected.response.view.getUint32(44 + i * 4, true)));
        const feeding = selectionCases.feedback(); await submit(feeding.stream);
        assert.equal(feeding.result.view.getInt32(P.F.QUERY_RENDER_MODE.result, true), feeding.expectedResult);
        selected = selectionCases.read(feeding.result); await submit(selected.stream);
        assert.deepEqual(feeding.expected, Array.from({ length: 5 }, (_, i) => selected.response.view.getFloat32(44 + i * 4, true)));
        assert.deepEqual(Array.from(gpu.current.current.rasterPos), [4, 6, 0.5, 1]);
        // Keep the real device/proxy/bridge, replacing only GPU execution:
        // real compute output is checked by gl_validation_browser_test.html.
        const nativeCapture = gpu.captureVertices, callbacks = [];
        let holdCapture = false;
        gpu.captureVertices = function(bytes, view, offset, size, metadata, raster = false) {
            const r = P.decodeRecord(raster ? "CAPTURE_RASTER_VERTEX" : "CAPTURE_VERTICES", view, offset), header = raster ? 8 : 16;
            if (raster) Object.assign(r, { first: 0, count: 1 });
            const values = new Float32Array(r.count * (raster ? 56 : 20));
            for (let i = 0; i < r.count; ++i) {
                const at = offset + header + i * 256, position = Array.from({ length: 4 }, (_, k) => view.getFloat32(at + k * 4, true));
                values.set([position[0] * 2, ...position.slice(1), 1, 0, 0.5, 1, 0.25, 0.5, 0.75, 1, 5, 5, 5, 5, ...position], i * 20);
            }
            const done = () => metadata.onVertexCapture({ job: r.job, first: r.first, values });
            if (holdCapture) callbacks.push(done); else this.trackReadback(Promise.resolve().then(done));
        };
        const setupProgram = programCases.setup(); await submit(setupProgram.stream);
        const scale = setupProgram.location.view.getInt32(P.F.QUERY_LOCATION.result, true), programmed = programCases.draw("glsl_vertex_feedback", scale);
        await submit(programmed.stream);
        assert.equal(programmed.response.view.getUint32(P.F.QUERY_RENDER_MODE.status, true), 1, "CPU receives GPU output through the actual result channel");
        assert.equal(programmed.response.view.getInt32(P.F.QUERY_RENDER_MODE.result, true), 13);
        selected = programCases.read(programmed.response); await submit(selected.stream);
        assert.deepEqual(Array.from({ length: 13 }, (_, i) => selected.response.view.getFloat32(44 + i * 4, true)), [1793, 48, 32, 0.5, 1, 1, 0, 0.5, 1, 5, 5, 5, 5]);
        holdCapture = true;
        const expired = programCases.draw("glsl_vertex_feedback", scale); await submit(expired.stream);
        assert.equal(expired.response.view.getUint32(P.F.QUERY_RENDER_MODE.status, true), 0);
        await submit(new GLStream().call("LINE_WIDTH", 3)); const newerMemory = memory.slice(0, 1024);
        callbacks.shift()(); assert.deepEqual(memory.subarray(0, 1024), newerMemory, "expired CPU result cannot overwrite a later arena submission");
        holdCapture = false;
        const raster = new GLStream().call("RASTER_POS4F", 0.25, 0, 0, 1), rasterReply = new Uint8Array(56);
        rasterReply.set(P.encodeRecord("QUERY_STATE", { pname: GL.CURRENT_RASTER_POSITION, value_kind: P.C.V86GL_STATE_FLOAT, data_size: 32 }));
        raster.record(P.GLFN.QUERY_STATE, rasterReply); const rasterState = raster.payloadView(); await submit(raster);
        assert.equal(rasterState.view.getUint32(P.F.QUERY_STATE.status, true), 1, "state query after programmable RasterPos is ready at IOCTL completion");
        assert.deepEqual(Array.from({ length: 4 }, (_, i) => rasterState.view.getFloat64(24 + i * 8, true)), [48, 32, 0.5, 1]);
        assert.deepEqual(Array.from(gpu.current.current.rasterPos), [48, 32, 0.5, 1]);
        gpu.captureVertices = nativeCapture; await submit(new GLStream().call("USE_PROGRAM", 0).makeCurrent(1300, 0, 0, 32, 32, 1300, 1300).call("CLEAR", GL.COLOR_BUFFER_BIT));
        gpu.current.error = GL.INVALID_ENUM; await error(GL.NO_ERROR); await error(GL.NO_ERROR);
        assert.equal(gpu.current.error, GL.INVALID_ENUM, "renderer flags cannot change CPU GL answers");
        gpu.current.error = GL.INVALID_ENUM;
        await submit(new GLStream().call("LINE_WIDTH", -2));
        await error(GL.INVALID_VALUE); await error(GL.NO_ERROR); await error(GL.NO_ERROR);
        assert.equal(gpu.stats.refusals, 0);
        const generated = new GLStream().call("LINE_WIDTH", 17).call("LINE_WIDTH", 7);
        const generatedPixel = generated.readPixels(0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, 4);
        await submit(generated);
        const generatedMessage = messages.filter(m => m.type === "batch").at(-1);
        assert.ok(generatedMessage.segments.some(segment => segment.bytes instanceof Uint8Array));
        assert.equal(gpu.current.lineWidth, 7); assert.equal(gpu.current.pointSize, 4);
        assert.equal(generatedPixel.view.getUint32(P.F.READ_PIXELS.status, true), 1);
        assert.ok(executed.flatMap(opcodes).every(fn => !P.isRejected(fn)));
        await error(GL.INVALID_VALUE); await error(GL.NO_ERROR);
        const last = messages.filter(m => m.type === "batch").at(-1), beforeInvalid = executed.length;
        const invalidRanges = [[{ offset: 0, length: 4 }, { offset: 2, length: 4 }],
            [{ offset: -1, length: 4 }], [{ offset: 0, length: last.bytes.length + 1 }],
            [{ bytes: [] }], [{ bytes: new Uint8Array() }], [{ offset: 0, length: 4, bytes: new Uint8Array([1]) }]];
        const originalError = console.error, errors = []; console.error = (...args) => errors.push(args);
        try {
            for (const segments of invalidRanges) {
                const message = { ...last, id: last.id + 10000, segments };
                if (remote) { hostListener(message); await proxy.idle(); }
                else assert.throws(() => hostListener(message), /invalid CPU-(validated|generated) graphics segment/);
            }
        } finally { console.error = originalError; }
        assert.equal(executed.length, beforeInvalid, "validate all segment ranges before executing any prefix");
        assert.equal(errors.length, remote ? invalidRanges.length : 0);
        await proxy.destroy();
    }
    console.log("gl_cpu_forwarding_test: actual device/proxy/bridge filter rejections, execute CPU expansions, keep readback offsets and preserve errors in both modes (passed)");
})().catch(error => { console.error(error); process.exitCode = 1; });
