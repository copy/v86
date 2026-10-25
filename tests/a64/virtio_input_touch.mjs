#!/usr/bin/env node
// The virt machine's multi-touch screen and the mouse (src/virtio_input.js):
// with no tablet beside it (Android's preset: a keyboard and a touch screen)
// the mouse is one finger, the left button down a touch where the mouse is,
// moves while down a drag, up the finger lifted; with a tablet the tablet
// takes the mouse and the touch screen only touches. The events stay in the
// device's pending list (no driver takes them here).
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const EV_SYN = 0, EV_KEY = 1, EV_ABS = 3, BTN_TOUCH = 0x14A;
const ABS_MT_SLOT = 0x2F, ABS_MT_POSITION_X = 0x35, ABS_MT_POSITION_Y = 0x36, ABS_MT_TRACKING_ID = 0x39;

async function machine(inputs)
{
    const emulator = new V86({
        cpu_type: "arm64", graphics_adapter: "none", memory_size: 16 << 20, autostart: false, log_level: 0,
        wasm_path: process.env.A64_WASM || root + "build/v86-arm64.wasm", virtio_input: inputs,
    });
    await new Promise((resolve, reject) => {
        emulator.add_listener("emulator-loaded", resolve);
        emulator.add_listener("emulator-error", reject);
    });
    const device = kind => emulator.v86.cpu.virtio_devices.find(d => d.name === "virtio-" + kind).device;
    return { emulator, device };
}
// (the events since the last call, without the SYN_REPORTs)
const take = device => device.pending.splice(0).filter(([type]) => type !== EV_SYN);

// a keyboard and a touch screen: the mouse is a finger
{
    const { emulator, device } = await machine(["keyboard", "multitouch"]);
    const touch = device("multitouch");
    // (the screen 720x1280 on the page: x, y, width, height; 0x7FFF is the axes' maximum)
    emulator.bus.send("mouse-absolute", [360, 640, 720, 1280]);
    assert.deepEqual(take(touch), [], "a move with no button: nothing");
    emulator.bus.send("mouse-click", [true, false, false]);
    assert.deepEqual(take(touch), [[EV_ABS, ABS_MT_SLOT, 0], [EV_ABS, ABS_MT_TRACKING_ID, 0], [EV_ABS, ABS_MT_POSITION_X, 16384],
        [EV_ABS, ABS_MT_POSITION_Y, 16384], [EV_KEY, BTN_TOUCH, 1]], "the left button down: a touch where the mouse is");
    emulator.bus.send("mouse-absolute", [360, 320, 720, 1280]);
    assert.deepEqual(take(touch), [[EV_ABS, ABS_MT_SLOT, 0], [EV_ABS, ABS_MT_POSITION_Y, 8192]], "a move while down: a drag");
    emulator.bus.send("mouse-click", [true, false, true]);
    assert.deepEqual(take(touch), [], "another button: the finger stays");
    emulator.bus.send("mouse-click", [false, false, false]);
    assert.deepEqual(take(touch), [[EV_ABS, ABS_MT_SLOT, 0], [EV_ABS, ABS_MT_TRACKING_ID, -1], [EV_KEY, BTN_TOUCH, 0]], "up: the finger lifted");
    emulator.bus.send("mouse-absolute", [100, 100, 720, 1280]);
    assert.deepEqual(take(touch), [], "a move after: nothing");
    // (a touch screen's own touches as before)
    emulator.bus.send("touch", { "touches": [[7, 72, 128]], "width": 720, "height": 1280 });
    assert.deepEqual(take(touch), [[EV_ABS, ABS_MT_SLOT, 0], [EV_ABS, ABS_MT_TRACKING_ID, 0], [EV_ABS, ABS_MT_POSITION_X, 3277],
        [EV_ABS, ABS_MT_POSITION_Y, 3277], [EV_KEY, BTN_TOUCH, 1]], "a touch of the page's touch screen");
    await emulator.destroy();
    console.log("PASS: a touch screen with no tablet takes the mouse as a finger (a tap, a drag, lifted)");
}

// with a tablet beside it: the tablet takes the mouse, the touch screen does not
{
    const { emulator, device } = await machine(["keyboard", "tablet", "multitouch"]);
    emulator.bus.send("mouse-absolute", [360, 640, 720, 1280]);
    emulator.bus.send("mouse-click", [true, false, false]);
    assert.deepEqual(take(device("multitouch")), [], "the touch screen leaves the mouse to the tablet");
    assert.ok(take(device("tablet")).length > 0, "the tablet takes it");
    await emulator.destroy();
    console.log("PASS: with a tablet, the tablet takes the mouse");
}
