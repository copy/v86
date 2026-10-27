#!/usr/bin/env node

// The UEFI firmware (docs/uefi.md, docs/modern-pc-devices-plan.md F1): the
// pinned OVMF (bios/ovmf-code.fd, bios/ovmf-vars.fd) as flash at the top of
// 4 GiB boots to its Shell on the serial port. Its debug log (QEMU's debug
// console at 0x402) shows the fw_cfg contract met: revision 1 without DMA,
// etc/e820, the SMBIOS tables, no ASSERT; its graphics driver (QemuVideoDxe)
// sets a mode on the Bochs VGA (GOP); the variable store is writable CFI
// flash (src/pflash.js). Shell commands see the PCI devices, v86's SMBIOS
// and the memory map, and set a non-volatile variable; "reset" goes through
// the reset vector again, to the Shell, the variable kept; a snapshot taken
// at the Shell goes on after restoring.
//
// MACHINE=i440fx (with qemu_compatible: OVMF's layout), CPU_CORES=2,
// MEMORY_MB=5120 (RAM above 4 GiB: extended RAM, in etc/e820 and SMBIOS),
// SHOW_LOGS=1 (the serial port), TEST_RELEASE_BUILD=1.

import assert from "node:assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const ROOT = __dirname + "../../";
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const SHOW_LOGS = +process.env.SHOW_LOGS;
const CPU_CORES = +process.env.CPU_CORES || 1;
const MACHINE = process.env.MACHINE || "q35";
const MEMORY_MB = +process.env.MEMORY_MB || 512;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const emulator = new V86({
    firmware: {
        type: "uefi",
        code: { url: ROOT + "bios/ovmf-code.fd" },
        vars: { url: ROOT + "bios/ovmf-vars.fd" },
        debug_console: true,
    },
    // (beyond the 2 GiB heap: extended RAM above 4 GiB, as the VM manager makes it)
    memory_size: Math.min(MEMORY_MB, 2048) * 1024 * 1024,
    extended_memory_size: Math.max(MEMORY_MB - 2048, 0) * 1024 * 1024 || undefined,
    graphics_adapter: "bochs_vga",
    cpu_type: "x86_64",
    cpu_cores: CPU_CORES,
    experimental_smp_jit: CPU_CORES > 1,
    machine_type: MACHINE,
    qemu_compatible: MACHINE === "i440fx",
    acpi: true,
    net_device: { type: "none" },
    autostart: true,
    log_level: 0,
});

const overall_timeout = setTimeout(() => {
    console.log("\nTimeout. Serial output since the last command:\n" + serial + "\nDebug log tail:\n" + debug_log.slice(-3000));
    process.exit(1);
}, 300 * 1000);

let serial = "";
let debug_log = "";
let waiter = null;
emulator.add_listener("serial0-output-byte", byte =>
{
    const chr = String.fromCharCode(byte);
    if(SHOW_LOGS) process.stdout.write(chr);
    serial += chr;
    if(waiter && waiter.pattern.test(plain(serial)))
    {
        const { resolve } = waiter;
        waiter = null;
        resolve(plain(serial));
    }
});
emulator.add_listener("debug-console-output-byte", byte => { debug_log += String.fromCharCode(byte); });
const sizes = [];
emulator.add_listener("screen-set-size", size => { sizes.push(size); });

/** Serial output without the terminal's escape sequences and carriage returns */
function plain(text)
{
    return text.replace(/\x1b\[[0-9;=?]*[A-Za-z]/g, "").replace(/\r/g, "");
}

const PROMPT = /Shell> $/;
// a non-volatile variable of a GUID of our own: L"v86"
const VARIABLE = "V86Test -guid 2c94c1ab-37b4-4d11-9a3f-5fd77b0d5e8a";
const SET_VARIABLE = "setvar " + VARIABLE + " -nv -bs -rt =L\"v86\"";
const GET_VARIABLE = "setvar " + VARIABLE;
function wait_serial(pattern, what, timeout_ms)
{
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for " + what + ":\n" + plain(serial).slice(-3000))), timeout_ms);
        waiter = { pattern, resolve: text => { clearTimeout(timer); resolve(text); } };
        if(pattern.test(plain(serial)))
        {
            waiter = null;
            clearTimeout(timer);
            resolve(plain(serial));
        }
    });
}
/** Type a Shell command and wait for the next prompt: its output */
async function command(cmd, timeout_ms = 60000)
{
    serial = "";
    // (the terminal reads keys one at a time: give it each)
    for(const chr of cmd + "\r")
    {
        emulator.serial0_send(chr);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    const output = await wait_serial(PROMPT, JSON.stringify(cmd), timeout_ms);
    return output.slice(output.indexOf(cmd) + cmd.length).replace(PROMPT, "");
}
let passed = 0;
async function step(name, f)
{
    const start = Date.now();
    await f();
    passed++;
    console.log("ok - " + name + " (" + ((Date.now() - start) / 1000).toFixed(1) + " s)");
}

console.log("Booting OVMF (" + MACHINE + ", " + CPU_CORES + " core" + (CPU_CORES > 1 ? "s" : "") + ")");

await step("the reset vector, SEC, PEI and DXE in place: the Shell on the serial port", async () => {
    await wait_serial(PROMPT, "the Shell", 180000);
    assert.match(plain(serial), /UEFI Interactive Shell v2\.2/);
    assert.match(plain(serial), /UEFI v2\.70 \(EDK II, 0x00010000\)/);
});

await step("the debug log: fw_cfg revision 1 over I/O ports, etc/e820, SMBIOS 2.8, no ASSERT", async () => {
    assert.match(debug_log, /^SecCoreStartupWithStack\(0xFFFCC000, 0x820000\)/);
    assert.match(debug_log, /QemuFwCfgProbe: Supported 1, DMA 0/);
    assert.match(debug_log, /FW CFG Revision: 0x1/);
    assert.match(debug_log, MEMORY_MB === 512 ? /PlatformGetLowMemoryCB: LowMemory=0x20000000/ : /PlatformGetLowMemoryCB: LowMemory=0x/);
    assert.match(debug_log, /DetectSmbiosVersion: SMBIOS version from QEMU: 0x0208/);
    for(const type of [1, 3, 4, 16, 17, 19, 32, 0])
    {
        assert.match(debug_log, new RegExp("SmbiosAdd: Smbios type " + type + " with size"), "SMBIOS type " + type);
    }
    assert.match(debug_log, /S3SaveStateDxe: Skip S3BootScript because ACPI S3 disabled/);
    assert.doesNotMatch(debug_log, /ASSERT /);
});

await step("the variable store: CFI flash, writable; the fault tolerant write on it", async () => {
    assert.match(debug_log, /QemuFlashDetected => FD behaves as FLASH, writable/);
    assert.match(debug_log, /Disabling EMU Variable FVB since flash variables appear to be supported/);
    assert.match(debug_log, /Ftw: FtwWorkSpaceLba - 0x41, WorkBlockSize {2}- 0x1000/);
});

await step("GOP: QemuVideoDxe drives the Bochs VGA and sets a graphics mode", async () => {
    assert.match(debug_log, /QemuVideo: QEMU Standard VGA detected/);
    assert.match(debug_log, /Adding Bochs Internal Mode \d+: 1024x768, 32-bit/);
    assert.doesNotMatch(debug_log, /BochsID mismatch/);
    const graphical = sizes.filter(([width, height, bpp]) => bpp === 32 && width >= 640 && height >= 480);
    assert.ok(graphical.length, "a 32-bit graphics mode among " + JSON.stringify(sizes));
});

await step("Shell commands: pci, smbiosview, memmap; setvar of a non-volatile variable", async () => {
    const pci = await command("pci");
    assert.match(pci, MACHINE === "q35" ? /Vendor 8086 Device 29C0/ : /Vendor 8086 Device 1237/, "the host bridge");
    assert.match(pci, /Vendor 1234 Device 1111/, "the Bochs VGA");
    const system = await command("smbiosview -t 1");
    assert.match(system, /Manufacturer: v86/);
    assert.match(system, MACHINE === "q35" ? /ProductName: v86 PC \(Q35 \+ ICH9\)/ : /ProductName: v86 PC \(i440FX \+ PIIX\)/);
    const processor = await command("smbiosview -t 4");
    assert.match(processor, /GenuineIntel/);
    const memmap = await command("memmap");
    const total = memmap.match(/Total Memory: +([\d,]+) MB/);
    const mb = total && +total[1].replace(/,/g, "");
    assert.ok(mb >= MEMORY_MB - 12 && mb <= MEMORY_MB, "total memory: " + memmap.slice(-400));
    await command(SET_VARIABLE);
    assert.match(await command(GET_VARIABLE), /76 00 38 00 36 00/);
});

await step("reset: through the reset vector to the Shell again, the variable kept", async () => {
    debug_log = "";
    serial = "";
    for(const chr of "reset\r")
    {
        emulator.serial0_send(chr);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    await wait_serial(/UEFI Interactive Shell v2\.2[^]*Shell> $/, "the Shell after reset", 180000);
    assert.match(debug_log, /SecCoreStartupWithStack/);
    assert.doesNotMatch(debug_log, /ASSERT /);
    assert.match(await command(GET_VARIABLE), /76 00 38 00 36 00/, "the non-volatile variable");
});

await step("a snapshot at the Shell goes on after restoring", async () => {
    const state = await emulator.save_state();
    await emulator.restore_state(state);
    const output = await command("ver");
    assert.match(output, /UEFI Interactive Shell v2\.2/);
});

clearTimeout(overall_timeout);
await emulator.destroy();
console.log("PASS: " + passed + " steps");
process.exit(0);
