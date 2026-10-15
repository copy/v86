#!/usr/bin/env node

// PCI Express native hot plug on the Q35 machine's root ports
// (src/pcie_root_port.js) with an unmodified Linux: Alpine's x86_64 virt
// kernel (6.18, pciehp built in) booted directly, the pinned Alpine ISO as
// the CD (downloaded on first use, as tests/x64/linux_boot.mjs does). Three
// root ports:
//   port 0 (slot 1): the virtio NIC (net_device), plugged in at boot
//   port 1 (slot 2): a virtio function Linux has no driver for (device type
//     21, signal distribution), plugged in at boot
//   port 2 (slot 3): a virtio entropy device, not plugged in (pcie_plugged: false)
// Linux takes the slots over (_OSC); the empty one is off. The entropy
// device is hot added (/dev/hwrng reads it) and taken out by the attention
// button (Linux releases it and switches the slot off); the NIC goes the
// same way and comes back (eth0 sends again); the driverless function is
// pulled out without notice (a surprise removal) and plugged in again. (A
// surprise removal of a virtio device that has a driver hangs Linux's
// pciehp thread: vp_reset waits for device_status to read 0, and a card
// that is gone reads as all ones.)
// SHOW_LOGS=1 shows the serial console, TEST_RELEASE_BUILD=1 tests the
// release build, DISABLE_JIT=1 the interpreter (several minutes to boot).

import assert from "node:assert/strict";
import fs from "node:fs";
import url from "node:url";
import { prepare as prepare_alpine } from "../lib/alpine_image.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const SHOW_LOGS = +process.env.SHOW_LOGS;
const DISABLE_JIT = +process.env.DISABLE_JIT;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const ROOT = __dirname + "/../../";
// (the pinned ISO, downloaded, checked and unpacked: tests/lib/alpine_image.mjs)
const { directory: DIRECTORY, image: { name: ISO } } = await prepare_alpine("x86_64-virt");
const KERNEL = "boot/vmlinuz-virt";
const INITRD = "boot/initramfs-virt";

/** What the entropy device hands out, from the start of each buffer */
const rng_byte = i => i * 37 + 11 & 0xFF;
let rng;

const emulator = new V86({
    graphics_adapter: "bochs_vga",
    bios: { url: ROOT + "bios/seabios.bin" },
    vga_bios: { url: ROOT + "bios/vgabios.bin" },
    machine_type: "q35",
    cpu_type: "x86_64",
    memory_size: 512 * 1024 * 1024,
    bzimage: { url: DIRECTORY + KERNEL },
    initrd: { url: DIRECTORY + INITRD },
    cdrom: { url: DIRECTORY + ISO },
    cmdline: "console=ttyS0,115200 loglevel=7 nokaslr panic=-1 modules=loop,squashfs,sd-mod,usb-storage",
    pcie_root_ports: 3,
    net_device: { type: "virtio", pcie_root_port: 0 },
    virtio_devices: [
        {
            "name": "signal-distribution",
            "device_id": 0x1040 + 21,
            "subsystem_device_id": 21,
            "queues": [{ "size": 8 }],
            "pcie_root_port": 1,
            "notify": () => {},
        },
        {
            "name": "rng",
            "device_id": 0x1040 + 4,
            "subsystem_device_id": 4,
            "queues": [{ "size": 8 }],
            "pcie_root_port": 2,
            "pcie_plugged": false,
            "init": handle => { rng = handle; },
            "notify": queue => {
                for(let request; (request = rng["pop_request"](queue)); )
                {
                    const bytes = new Uint8Array(request["writable"]);
                    for(let i = 0; i < bytes.length; i++) bytes[i] = rng_byte(i);
                    request["write"](bytes);
                    request["complete"]();
                }
                rng["flush"](queue);
            },
        },
    ],
    autostart: true,
    screen_dummy: true,
    log_level: 0,
    disable_jit: !!DISABLE_JIT,
    experimental_smp_jit: !DISABLE_JIT,
    ir_sync_publication: true,
});

let serial = "";
emulator.add_listener("serial0-output-byte", byte => {
    const c = String.fromCharCode(byte);
    if(SHOW_LOGS) process.stdout.write(c);
    serial += c;
});
let frames_sent = 0;
emulator.bus.register("net0-send", () => { frames_sent++; });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function wait_for(what, predicate, timeout_ms)
{
    const start = Date.now();
    while(!predicate())
    {
        if(Date.now() - start > timeout_ms) throw new Error("timed out waiting for " + what + "\n" + serial.slice(-2000));
        await sleep(100);
    }
}

let commands = 0;

/**
 * Run a shell command, return its output: what comes between two markers,
 * each echoed as two quoted halves, so that the command line the shell
 * echoes (wrapped at 80 columns) has neither
 */
async function command(cmd, timeout_ms = 60000)
{
    const n = ++commands;
    serial = "";
    emulator.serial0_send("echo \"BEGIN\"\"_" + n + "\"; " + cmd + "; echo \"END\"\"_" + n + "\"\n");
    const output = new RegExp("BEGIN_" + n + "\\r?\\n([^]*?)END_" + n + "\\r?\\n");
    await wait_for(JSON.stringify(cmd), () => output.test(serial), timeout_ms);
    return output.exec(serial)[1];
}

/** Run a command until its output satisfies predicate */
async function wait_for_command(cmd, predicate, what, timeout_ms = 30000)
{
    const start = Date.now();
    for(;;)
    {
        const output = await command(cmd);
        if(predicate(output)) return output;
        if(Date.now() - start > timeout_ms) throw new Error("timed out waiting for " + what + ": " + output);
        await sleep(500);
    }
}

const slot_power = async slot => (await command("cat /sys/bus/pci/slots/" + slot + "/power")).trim();
const pci_function = async bus => (await command("cat /sys/bus/pci/devices/0000:0" + bus + ":00.0/device 2>/dev/null || echo none")).trim();

const start = Date.now();
await wait_for("the login prompt", () => /localhost login:/.test(serial), DISABLE_JIT ? 1800000 : 600000);
emulator.serial0_send("root\n");
await wait_for("the shell", () => /localhost:~# /.test(serial), 60000);
console.log("Booted in " + Math.round((Date.now() - start) / 1000) + " s");

// The slots: Linux has them through _OSC
const dmesg = await command("dmesg | grep -e _OSC -e pciehp");
assert.match(dmesg, /_OSC: OS now controls \[PCIeHotplug PME PCIeCapability\]/, "_OSC grants native hot plug");
for(const slot of [1, 2, 3])
{
    assert.match(dmesg, new RegExp("pciehp: Slot #" + slot + " AttnBtn\\+ PwrCtrl\\+ MRL- AttnInd\\+ PwrInd\\+ HotPlug\\+ Surprise\\+ .*LLActRep\\+"),
        "pciehp drives slot " + slot);
}
assert.equal(await slot_power(1), "1", "slot 1 (the NIC) is on");
assert.equal(await slot_power(2), "1", "slot 2 (the driverless function) is on");
assert.equal(await slot_power(3), "0", "the empty slot 3 is off");
assert.equal(await pci_function(1), "0x1041", "the NIC behind port 0");
assert.equal(await pci_function(3), "none", "slot 3 empty");
console.log("_OSC, three hot plug slots, the empty one off: ok");

// The entropy device: hot added, read, taken out by the attention button
assert.equal(await emulator.attach_pcie_device(2), undefined);
await wait_for_command("cat /sys/class/misc/hw_random/rng_available", output => /virtio_rng/.test(output), "virtio_rng");
const random = (await command("head -c 16 /dev/hwrng | od -An -tx1")).trim().split(/\s+/).map(x => parseInt(x, 16));
assert.equal(random.length, 16);
// (each buffer starts the sequence afresh)
assert.ok(random.every((x, i) => i === 0 || x === (random[i - 1] + 37 & 0xFF) || x === rng_byte(0)),
    "/dev/hwrng reads the device: " + random.map(x => x.toString(16)).join(" "));
assert.equal(await slot_power(3), "1", "Linux switched slot 3 on");
console.log("Entropy device hot added, /dev/hwrng: ok");

let removal_start = Date.now();
await emulator.detach_pcie_device(2);
const rng_removal = Date.now() - removal_start;
assert.equal(await pci_function(3), "none", "the entropy device is gone");
assert.equal(await slot_power(3), "0", "Linux switched slot 3 off");
assert.match(await command("dmesg | grep 'Slot(3)'"), /Slot\(3\): Button press: will power off in 5 sec/);
console.log("Entropy device taken out by the attention button after " + (rng_removal / 1000).toFixed(1) + " s: ok");

// The NIC: out by the attention button, in again
await command("ip link set eth0 up");
await wait_for("eth0 sending", () => frames_sent > 0, 30000);
removal_start = Date.now();
await emulator.detach_pcie_device(0);
const nic_removal = Date.now() - removal_start;
assert.match(await command("ip link show eth0 2>&1"), /can't find device|does not exist/, "eth0 is gone");
assert.equal(await slot_power(1), "0", "Linux switched slot 1 off");
assert.equal(await pci_function(1), "none", "the NIC is gone");

await emulator.attach_pcie_device(0);
await wait_for_command("ls /sys/class/net", output => /eth0/.test(output), "eth0 back");
assert.equal(await pci_function(1), "0x1041", "the NIC is back");
assert.equal(await slot_power(1), "1", "Linux switched slot 1 on");
const sent_before = frames_sent;
await command("ip link set eth0 up");
await wait_for("eth0 sending again", () => frames_sent > sent_before, 30000);
console.log("NIC taken out by the attention button after " + (nic_removal / 1000).toFixed(1) + " s, plugged in again, eth0 sends: ok");

// The driverless function: pulled out without notice, plugged in again
await emulator.detach_pcie_device(1, { surprise: true });
await wait_for_command("dmesg | grep 'Slot(2)'", output => /Slot\(2\): Card not present/.test(output), "Linux noticing");
assert.match(await command("dmesg | grep 'Slot(2)'"), /Slot\(2\): Link Down/);
await wait_for_command("cat /sys/bus/pci/slots/2/power", output => output.trim() === "0", "Linux switching slot 2 off");
assert.equal(await pci_function(2), "none", "the driverless function is gone");

await emulator.attach_pcie_device(1);
await wait_for_command("cat /sys/bus/pci/devices/0000:02:00.0/device 2>/dev/null", output => output.trim() === "0x1055", "the function back");
assert.equal(await slot_power(2), "1", "Linux switched slot 2 on");
console.log("Driverless function pulled out without notice, plugged in again: ok");

// Nothing of Linux's waits on a card that is gone
assert.equal((await command("for p in /proc/[0-9]*; do [ \"$(cut -d' ' -f3 $p/stat)\" = D ] && cat $p/comm; done")).trim(), "",
    "no task in uninterruptible sleep");

emulator.destroy();
console.log("PCI Express hot plug with Linux: ok");
