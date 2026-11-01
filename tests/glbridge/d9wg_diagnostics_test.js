"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { makeExecutor, command, OP } = require("./d3d9_webgpu_executor_test.js");
const { frameCommands, batch } = require("./d3d9_webgpu_perf_test.js");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
const modulePath = require.resolve("../../src/browser/glbridge/d3d9-webgpu/d9wg_diagnostics.js");
const directory = "src/browser/glbridge/d3d9-webgpu/";

(async () => {
    assert.equal(require.cache[modulePath], undefined, "ordinary imports must not load diagnostics");
    const { executor, find } = makeExecutor({ diagnostics: false });
    const texture = (color, create = false) => Buffer.from(P.encodeBatch([
        ...(create ? [command(OP.CREATE_TEXTURE_2D, P.encode("CreateTexture2D", {
            device_handle: 0x100002, resource_handle: 0x123, width: 1, height: 1,
            level_count: 1, format: 21,
        }))] : []),
        { opcode: OP.UPDATE_TEXTURE, payload: P.encode("UpdateTexture", {
            resource_handle: 0x123, width: 1, height: 1, depth: 1, row_pitch: 4, data_bytes: 4,
        }), blobs: [{ field: "data_offset", data: new Uint8Array([color, 2, 3, 255]) }] },
    ]));
    await executor.submit(batch(frameCommands(true, 2), true));
    await executor.submit(texture(1, true));executor.finishFrame(false);await executor.idle();
    assert.equal(require.cache[modulePath], undefined);
    assert.equal(executor.lastDraws, null);
    assert.equal(executor.resources.get(0x123).preview, undefined);
    assert([...executor.pipelineCache.values()].every(p => !p._d9wgDiagnostic));
    const uploads = find("copyBufferToTexture").length;
    const requested = executor.enableDiagnostics();
    assert.equal(executor.diagnosticsEnabled, true, "CommonJS opt-in installs synchronously");
    await requested;await executor.enableDiagnostics();
    assert(require.cache[modulePath]);
    await executor.submit(batch(frameCommands(false, 2), true));
    await executor.submit(texture(9));executor.finishFrame(false);await executor.idle();
    assert.equal(find("copyBufferToTexture").length, uploads + 1);
    assert.deepEqual([...executor.resources.get(0x123).preview.rgba], [3, 2, 9, 255]);
    assert(executor.lastDraws.fixed);
    assert(executor.debug.dumpPipelineStates().every(p => p.state));
    assert.equal(executor.debug.dumpShaders({ log: false }).length, 0);
    assert.equal(executor.hostErrors.length, 0);
    assert.equal(executor.gpuErrors.errors.length, 0);

    // Evaluate the browser loader with a failing first request. No GPU or
    // network mocks participate in the separate real-browser pixel test.
    let requests = 0, pending;
    const context = vm.createContext({ console, URL, setTimeout, clearTimeout,
        document: { currentScript: { src: "https://local.invalid/glbridge/libv86-webgpu.js?v=revision" },
            createElement() { return { remove() {} }; },
            head: { appendChild(script) { requests++;pending = script; } } },
    });
    for (const file of ["d3d9_shader_pipeline.js", "d9wg_protocol.js", "d9wg_wire.js", "d9wg_state.js",
        "d9wg_formats.js", "d9wg_uploads.js", "d9wg_resources.js", "d9wg_surface_ops.js", "d9wg_ffp.js",
        "d9wg_pipeline_state.js", "d9wg_draw_recorder.js", "d9wg_frame_replayer.js", "d9wg_present.js", "d3d9_executor.js"])
        vm.runInContext(fs.readFileSync(directory + file, "utf8"), context);
    const browser = vm.runInContext("new D3D9WebGPUExecutor({ getContext() {} }, {})", context);
    const first = browser.enableDiagnostics();
    assert.equal(browser.enableDiagnostics(), first, "simultaneous requests share one load");
    assert.equal(pending.src, "https://local.invalid/glbridge/d9wg_diagnostics.js?v=revision");
    pending.onerror();await assert.rejects(first, /Could not load/);
    assert.equal(browser.diagnosticsEnabled, false);
    const retry = browser.enableDiagnostics();
    vm.runInContext(fs.readFileSync(directory + "d9wg_diagnostics.js", "utf8"), context);
    pending.onload();await retry;
    assert.equal(requests, 2);assert.equal(browser.diagnosticsEnabled, true);
    assert.equal(browser.debug.dumpPipelineStates().length, 0);
    console.log("D9WG diagnostics: no default load/capture, late opt-in preserves uploads, shared browser load and failure retry pass");
})().catch(error => { console.error(error);process.exitCode = 1; });
