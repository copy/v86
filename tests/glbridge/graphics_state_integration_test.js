"use strict";
const assert = require("node:assert/strict");
(async () => {
    global.DEBUG = false;
    const { PCI } = await import("../../src/pci.js");
    const { V86 } = await import("../../src/browser/starter.js");
    // A device plugin's host state travels in the snapshot with its device
    // (docs/graphics-proxy-plugin-plan.md): V86 asks the plugin before saving
    // and hands the state back after restoring
    const checkpoint = new Uint8Array([1, 2, 3]);
    const calls = [];
    const device = { name: "v86gl", host_state: undefined, restored_host_state: undefined };
    const plugin = {
        name: "v86gl",
        async prepare_save() { calls.push("prepare"); return checkpoint; },
        release_save() { calls.push("release"); },
        async before_restore() { calls.push("begin"); },
        async after_restore(value) { calls.push(value); await Promise.resolve(); calls.push("finish"); },
        cancel_restore() { calls.push("cancel"); },
    };
    const lifecycle = {
        plugin_device: V86.prototype.plugin_device,
        save_with_plugins: V86.prototype.save_with_plugins,
        restore_with_plugins: V86.prototype.restore_with_plugins,
        with_device_state: V86.prototype.with_device_state,
        // (no display adapter or GLES host here: nothing of them on the GPU)
        adapter_host_state: V86.prototype.adapter_host_state,
        prepare_host_state: V86.prototype.prepare_host_state,
    };
    const emulator = { ...lifecycle, device_plugins: [plugin],
        is_running() { return false; }, async stop() {},
        v86: {
            cpu: { devices: { virtio_devices: [device] } },
            save_state() { calls.push("save"); return [device.host_state]; },
            restore_state(state) { calls.push("restore"); device.restored_host_state = state[0]; },
        } };
    const saved = await V86.prototype.save_state.call(emulator);
    assert.deepEqual(calls, ["prepare", "save", "release"]);
    assert.equal(saved[0], checkpoint);
    assert.equal(device.host_state, undefined, "the host state is only there while saving");
    calls.length = 0;
    await V86.prototype.restore_state.call(emulator, saved);
    assert.deepEqual(calls, ["begin", "restore", checkpoint, "finish"]);
    assert.equal(device.restored_host_state, undefined);
    calls.length = 0;
    await V86.prototype.restore_state.call(emulator, [undefined]);
    assert.deepEqual(calls, ["begin", "restore", undefined, "finish"], "snapshots without graphics data clear replay state");
    emulator.v86.restore_state = () => { throw new Error("bad state"); };
    calls.length = 0;
    await assert.rejects(V86.prototype.restore_state.call(emulator, saved), /bad state/);
    assert.deepEqual(calls, ["begin", "cancel"]);
    // The public API must stop the CPU before awaiting host work, serialize
    // concurrent requests, and resume only after the snapshot is consistent.
    const sequence = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const live = {
        ...lifecycle,
        running: true, value: 0,
        is_running() { return this.running; },
        async stop() { this.running = false; sequence.push("stop"); },
        run() { this.running = true; sequence.push("run"); },
        device_plugins: [{
            name: "v86gl",
            async prepare_save() {
                sequence.push("prepare");
                assert.equal(live.running, false);
                await gate;
                live.value = 42; // an accepted GPU readback completes here
            },
            async before_restore() {}, async after_restore() {}, cancel_restore() {},
        }],
        v86: {
            cpu: { devices: { virtio_devices: [{ name: "v86gl" }] } },
            save_state() { sequence.push("save"); return live.value; },
            restore_state() { throw new Error("invalid checkpoint"); },
        },
    };
    const first = V86.prototype.save_state.call(live);
    const second = V86.prototype.save_state.call(live);
    for (let i = 0; i < 5; ++i) await Promise.resolve();
    assert.deepEqual(sequence, ["stop", "prepare"]);
    release();
    assert.deepEqual(await Promise.all([first, second]), [42, 42]);
    assert.deepEqual(sequence, ["stop", "prepare", "save", "run", "stop", "prepare", "save", "run"]);
    await assert.rejects(V86.prototype.restore_state.call(live, new ArrayBuffer(0)), /invalid checkpoint/);
    assert.equal(live.running, false, "a failed restore cannot resume a partially restored guest");

    const bus = Object.create(PCI.prototype);
    const config = new Int32Array(64);
    config[4] = 1;
    const fixed = { fixed: true, original_bar: 0xf101 };
    bus.devices = [{ name: "sparse BARs", pci_bars: [undefined, fixed] }];
    bus.device_spaces = [new Int32Array(64)];
    const pciState = [];
    pciState[0] = config;
    for (const [i, key] of ["pci_addr", "pci_value", "pci_response", "pci_status"].entries()) {
        bus[key] = new Uint8Array(4);
        pciState[256 + i] = new Uint8Array(4);
    }
    bus.set_state(pciState);
    assert.equal(bus.device_spaces[0][5], 0xf101, "restore skips absent BARs and preserves the fixed graphics port");
    console.log("graphics_state_integration_test: ok");
})().catch(error => { console.error(error); process.exitCode = 1; });
