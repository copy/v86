#!/usr/bin/env node

// USB with real drivers: Alpine 3.24 x86_64's uhci-hcd and usbhid on usb:
// { controller: "uhci", tablet: true } (docs/modern-pc-devices-plan.md U1,
// "验收"; the pinned virt ISO, tests/lib/alpine_image.mjs). The tablet is
// enumerated (sysfs: its IDs, its product, a HID input device); the page's
// pointer arrives as absolute events (/dev/input/event*: ABS_X, ABS_Y over
// 0 to 32767, the buttons, the wheel) at the corners, the centre and a 5x5
// grid; out of its port and back in, it is enumerated again; a snapshot.
//
// MACHINE=q35 (ICH9's UHCI), CPU_CORES=2, SHOW_LOGS=1, USB_CONTROLLER=ehci
// (EHCI, ehci-pci: the full-speed tablet on its UHCI companion, at 12M) or
// xhci (xhci-pci: the tablet on a USB 2 root port, at 12M).

import assert from "node:assert/strict";
import url from "node:url";
import { prepare as prepare_alpine } from "../lib/alpine_image.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const ROOT = __dirname + "../../";
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const SHOW_LOGS = +process.env.SHOW_LOGS;
const CPU_CORES = +process.env.CPU_CORES || 1;
const MACHINE = process.env.MACHINE || "i440fx";
const CONTROLLER = process.env.USB_CONTROLLER || "uhci";
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const prepared = await prepare_alpine("x86_64-virt");
const directory = ROOT + "build/x64-linux/";
const emulator = new V86({
    graphics_adapter: "bochs_vga",
    bios: { url: ROOT + "bios/seabios.bin" },
    vga_bios: { url: ROOT + "bios/vgabios.bin" },
    bzimage: { url: directory + "boot/vmlinuz-virt" },
    initrd: { url: directory + "boot/initramfs-virt" },
    cdrom: { url: directory + prepared.image.name },
    cmdline: "console=ttyS0,115200 loglevel=4 nokaslr modules=loop,squashfs,sd-mod,usb-storage",
    memory_size: 512 * 1024 * 1024,
    cpu_type: "x86_64",
    cpu_cores: CPU_CORES,
    experimental_smp_jit: CPU_CORES > 1,
    machine_type: MACHINE,
    acpi: true,
    net_device: { type: "none" },
    usb: { controller: CONTROLLER, tablet: true },
    autostart: true,
    log_level: 0,
});

const overall_timeout = setTimeout(() => {
    console.log("\nTimeout. Serial output since the last command:\n" + serial);
    process.exit(1);
}, 900 * 1000);

let serial = "";
let waiter = null;
emulator.add_listener("serial0-output-byte", byte =>
{
    const chr = String.fromCharCode(byte);
    if(SHOW_LOGS) process.stdout.write(chr);
    serial += chr;
    if(waiter && waiter.pattern.test(serial))
    {
        const { resolve } = waiter;
        waiter = null;
        resolve(serial);
    }
});
let tablet_active = false;
emulator.add_listener("usb-tablet-active", value => { tablet_active = value; });

const PROMPT = /:~# (\x1b\[6n)?$/;
function wait_serial(pattern, what, timeout_ms)
{
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for " + what + ":\n" + serial.slice(-3000))), timeout_ms);
        waiter = { pattern, resolve: text => { clearTimeout(timer); resolve(text); } };
        if(pattern.test(serial))
        {
            waiter = null;
            clearTimeout(timer);
            resolve(serial);
        }
    });
}
async function command(cmd, timeout_ms = 120000)
{
    serial = "";
    emulator.serial0_send(cmd + "\n");
    const output = await wait_serial(PROMPT, JSON.stringify(cmd), timeout_ms);
    return output.slice(cmd.length).replace(PROMPT, "");
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0;
async function step(name, f)
{
    const start = Date.now();
    await f();
    passed++;
    console.log("ok - " + name + " (" + ((Date.now() - start) / 1000).toFixed(1) + " s)");
}

console.log("Booting Alpine x86_64 with a USB tablet (" + CONTROLLER + ", " + MACHINE + ", " + CPU_CORES + " core" + (CPU_CORES > 1 ? "s" : "") + ")");
await wait_serial(/login: $/, "the login prompt", 600000);
serial = "";
emulator.serial0_send("root\n");
await wait_serial(PROMPT, "the shell", 120000);

/** The tablet's event device (/proc/bus/input/devices), once it is there */
async function event_device()
{
    const output = await command("for i in $(seq 30); do grep -q 'v86 USB Tablet' /proc/bus/input/devices && break; sleep 1; done; " +
        "grep -A6 'v86 USB Tablet' /proc/bus/input/devices | grep Handlers");
    const match = output.match(/event(\d+)/);
    assert.ok(match, "the tablet's input device: " + output);
    return "/dev/input/event" + match[1];
}

let device;
await step("the controller's driver and usbhid: the tablet enumerated (its IDs and product), an input device, the pointer the tablet's", async () => {
    device = await event_device();
    const ids = await command("cat /sys/bus/usb/devices/*/idVendor /sys/bus/usb/devices/*/idProduct /sys/bus/usb/devices/*/product 2>/dev/null | tr '\\n' ' '");
    assert.match(ids, /0627/);
    assert.match(ids, /v86 USB Tablet/);
    // (PIIX3's function 2 on i440FX, ICH9's 00:1d.0 on Q35; EHCI's first
    // companion at 00:1d.0 or v86's 00:06.0, the EHCI at function 7; xHCI at 00:14.0)
    const slot = CONTROLLER === "ehci" ? (MACHINE === "q35" ? "1d" : "06") : MACHINE === "q35" ? "1d.0" : "01.2";
    const driver = await command("basename $(readlink /sys/bus/pci/devices/0000:00:" + (CONTROLLER === "xhci" ? "14.0" :
        CONTROLLER === "ehci" ? slot + ".0" : slot) + "/driver)");
    assert.match(driver, CONTROLLER === "xhci" ? /xhci_hcd/ : /uhci_hcd/);
    if(CONTROLLER === "xhci")
    {
        assert.match(await command("for d in /sys/bus/usb/devices/*; do [ \"$(cat $d/idVendor 2>/dev/null)\" = 0627 ] && echo SPE''ED $(cat $d/speed); done"),
            /^SPEED 12$/m);
    }
    if(CONTROLLER === "ehci")
    {
        assert.match(await command("basename $(readlink /sys/bus/pci/devices/0000:00:" + slot + ".7/driver)"), /ehci-pci/);
        // (the tablet's speed: full, on the companion)
        assert.match(await command("for d in /sys/bus/usb/devices/*; do [ \"$(cat $d/idVendor 2>/dev/null)\" = 0627 ] && echo SPE''ED $(cat $d/speed); done"),
            /^SPEED 12$/m);
    }
    assert.ok(tablet_active, "announced: the PS/2 mouse leaves the pointer to it");
});

/**
 * The tablet's value for a position of the page's pointer: the middle of its pixel
 * @param {number} position
 * @param {number} size
 */
const tablet_value = (position, size) => Math.min(32767, Math.round((position + 0.5) / size * 32767));

/**
 * The events the guest reads while the page's pointer goes through `points`
 * (each [x, y] over a screen of 1024x768), with a click at the end
 * @return {Promise<!Array<{type: number, code: number, value: number}>>}
 */
async function events_for(points)
{
    // (cat writes what it reads at once; hexdump would buffer it)
    await command("rm -f /tmp/ev; (cat " + device + " > /tmp/ev &) ; sleep 1");
    for(const [x, y] of points)
    {
        emulator.bus.send("mouse-absolute", [x, y, 1024, 768]);
        await sleep(60);
    }
    emulator.bus.send("mouse-click", [true, false, false]);
    await sleep(60);
    emulator.bus.send("mouse-click", [false, false, false]);
    emulator.bus.send("mouse-wheel", [1, 0]);
    await sleep(300);
    const output = await command("sleep 1; killall cat; hexdump -v -e '6/4 \"%d \" \"\\n\"' /tmp/ev");
    return output.split("\n").map(line => line.trim().split(/\s+/).map(Number)).filter(w => w.length === 6 && !w.some(isNaN))
        .map(w => ({ type: w[4] & 0xFFFF, code: w[4] >>> 16, value: w[5] }));
}

await step("the pointer: corners, centre and a 5x5 grid as absolute positions, the buttons, the wheel", async () => {
    const points = [[0, 0], [1023, 0], [0, 767], [1023, 767], [512, 384]];
    for(let i = 0; i < 5; i++) for(let j = 0; j < 5; j++) points.push([Math.round(i * 1023 / 4), Math.round(j * 767 / 4)]);
    const events = await events_for(points);
    // (each report's X and Y; a value the same as the last is not sent again)
    let x = -1, y = -1;
    const seen = [];
    for(const e of events)
    {
        if(e.type === 3 && e.code === 0) x = e.value;
        if(e.type === 3 && e.code === 1) y = e.value;
        if(e.type === 0 && e.code === 0 && x >= 0 && y >= 0) seen.push([x, y]);
    }
    const expected = points.map(([px, py]) => [tablet_value(px, 1024), tablet_value(py, 768)]);
    for(const [ex, ey] of expected)
    {
        assert.ok(seen.some(([sx, sy]) => sx === ex && sy === ey), "the position " + ex + "," + ey + " among " + JSON.stringify(seen.slice(0, 40)));
    }
    // (and no position the page's pointer never had)
    const stray = seen.filter(([sx, sy]) => !expected.some(([ex, ey]) => sx === ex && sy === ey));
    assert.deepEqual(stray, [], "positions not the pointer's");
    assert.ok(events.some(e => e.type === 1 && e.code === 0x110 && e.value === 1), "BTN_LEFT down");
    assert.ok(events.some(e => e.type === 1 && e.code === 0x110 && e.value === 0), "BTN_LEFT up");
    assert.ok(events.some(e => e.type === 2 && e.code === 8 && e.value === 1), "REL_WHEEL up");
});

await step("out of its port and back in: gone from the guest, enumerated again", async () => {
    await emulator.usb_plug("tablet", false);
    const gone = await command("sleep 3; grep -c 'v86 USB Tablet' /proc/bus/input/devices");
    assert.match(gone, /^\s*0\s*$/m, "gone: " + gone);
    assert.ok(!tablet_active);
    await emulator.usb_plug("tablet", true);
    device = await event_device();
    assert.ok(tablet_active);
    const events = await events_for([[100, 100], [900, 700]]);
    assert.ok(events.some(e => e.type === 3 && e.code === 0 && e.value === tablet_value(900, 1024)), "the pointer again");
});

await step("a snapshot: the tablet goes on after restoring it", async () => {
    const state = await emulator.save_state();
    await emulator.restore_state(state);
    serial = "";
    emulator.serial0_send("\n");
    await wait_serial(PROMPT, "the shell after restoring", 30000);
    const events = await events_for([[300, 200]]);
    assert.ok(events.some(e => e.type === 3 && e.code === 0 && e.value === tablet_value(300, 1024)));
});

clearTimeout(overall_timeout);
await emulator.destroy();
console.log("PASS: " + passed + " steps");
process.exit(0);
