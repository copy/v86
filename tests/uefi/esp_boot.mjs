#!/usr/bin/env node

// A cold boot from a fixed disk under UEFI (docs/uefi.md, the plan's F1):
// OVMF's boot manager finds no boot entries, starts the removable-media
// loader of the GPT disk's EFI System Partition (tests/lib/uefi_disk.mjs:
// GRUB, then Alpine 3.24 x86_64 from the ESP alone), on Q35's AHCI or
// i440FX's IDE. In Linux: booted through UEFI (64-bit firmware, EFI runtime
// variables with OVMF's Boot####), the ESP mounted as the boot media, v86's
// SMBIOS, the ACPI tables with Q35's ECAM where OVMF put it and every BAR in
// the root bridge's windows, S0 and S5 only. A snapshot; "reboot" through
// the firmware back to the login; "poweroff" through ACPI S5.
//
// MACHINE=i440fx, CPU_CORES=2, SHOW_LOGS=1, TEST_RELEASE_BUILD=1. macOS (hdiutil).

import assert from "node:assert/strict";
import url from "node:url";
import { prepare_esp_disk } from "../lib/uefi_disk.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const ROOT = __dirname + "../../";
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const SHOW_LOGS = +process.env.SHOW_LOGS;
const CPU_CORES = +process.env.CPU_CORES || 1;
const MACHINE = process.env.MACHINE || "q35";
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const disk = await prepare_esp_disk();
const emulator = new V86({
    firmware: {
        type: "uefi",
        code: { url: ROOT + "bios/ovmf-code.fd" },
        vars: { url: ROOT + "bios/ovmf-vars.fd" },
        debug_console: true,
    },
    hda: { url: disk },
    memory_size: 512 * 1024 * 1024,
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
    console.log("\nTimeout. Serial output since the last command:\n" + plain(serial).slice(-3000));
    process.exit(1);
}, 900 * 1000);

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

/** Serial output without the terminal's escape sequences and carriage returns */
function plain(text)
{
    return text.replace(/\x1b\[[0-9;=?]*[A-Za-z]/g, "").replace(/\r/g, "");
}

const PROMPT = /:~# (\x1b\[6n)?$/;
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
/** A shell command's output: between markers that its echo (which a long command wraps) does not have */
async function command(cmd, timeout_ms = 120000)
{
    serial = "";
    emulator.serial0_send("echo BE''GIN; " + cmd + "; echo EN''D\n");
    const output = await wait_serial(/^END\n[^]*:~# (\x1b\[6n)?$/m, JSON.stringify(cmd), timeout_ms);
    return output.match(/^BEGIN\n([^]*?)^END$/m)[1];
}
async function login()
{
    await wait_serial(/login: $/, "the login prompt", 600000);
    serial = "";
    emulator.serial0_send("root\n");
    await wait_serial(PROMPT, "the shell", 120000);
}
let passed = 0;
async function step(name, f)
{
    const start = Date.now();
    await f();
    passed++;
    console.log("ok - " + name + " (" + ((Date.now() - start) / 1000).toFixed(1) + " s)");
}

console.log("Booting the ESP disk under UEFI (" + MACHINE + ", " + CPU_CORES + " core" + (CPU_CORES > 1 ? "s" : "") + ")");

await step("the boot manager starts the disk's removable-media loader: GRUB, Linux, Alpine's login", async () => {
    await wait_serial(/BdsDxe: starting Boot\d+ "[^"]*" from \S+\n/, "the boot manager", 180000);
    const boot = plain(serial).match(/BdsDxe: starting Boot\d+ "([^"]*)" from (\S+)/);
    assert.ok(boot, plain(serial).slice(-1000));
    assert.match(boot[2], MACHINE === "q35" ? /^PciRoot\(0x0\)\/Pci\(0x1F,0x2\)\/Sata\(0x0,0xFFFF,0x0\)$/ : /^PciRoot\(0x0\)\/Pci\(0x1,0x1\)\/Ata\(/,
        "the disk: " + boot[2]);
    await wait_serial(/Booting `Alpine virt \(UEFI, from the ESP\)'/, "GRUB's entry", 120000);
    await login();
});

await step("Linux: booted through 64-bit UEFI, EDK II's runtime variables with the boot entries", async () => {
    assert.match(await command("cat /sys/firmware/efi/fw_platform_size"), /^64$/m);
    assert.match(await command("dmesg | grep 'efi: EFI v'"), /EFI v2\.7\d? by EDK II/);
    const variables = await command("ls /sys/firmware/efi/efivars");
    assert.match(variables, /BootOrder-8be4df61-93ca-11d2-aa0d-00e098032b8c/);
    assert.match(variables, /Boot0001-8be4df61-93ca-11d2-aa0d-00e098032b8c/);
});

await step("the ESP: the GPT partition's name, mounted as the boot media", async () => {
    assert.match(await command("cat /sys/block/sda/sda1/uevent"), /PARTNAME=ESP/);
    assert.match(await command("grep sda1 /proc/mounts"), /^\/dev\/sda1 \/media\/sda1 vfat /m);
});

await step("SMBIOS, the ACPI tables, the PCI windows, the sleep states", async () => {
    assert.match(await command("cat /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/product_name"),
        MACHINE === "q35" ? /^v86\nv86 PC \(Q35 \+ ICH9\)$/m : /^v86\nv86 PC \(i440FX \+ PIIX\)$/m);
    const tables = await command("ls /sys/firmware/acpi/tables");
    for(const table of ["DSDT", "FACP", "APIC", ...(MACHINE === "q35" ? ["MCFG"] : [])])
    {
        assert.match(tables, new RegExp("\\b" + table + "\\b"), table);
    }
    if(MACHINE === "q35")
    {
        assert.match(await command("dmesg | grep -i ecam"), /\[mem 0xe0000000-0xefffffff\]/);
    }
    assert.doesNotMatch(await command("dmesg | grep -iE \"can't claim|no compatible bridge window|failed to assign\""), /\S/,
        "every BAR where the root bridge's windows have it");
    assert.match(await command("dmesg | grep 'ACPI: PM: (supports'"), /\(supports S0 S5\)/);
});

await step("a snapshot: Linux goes on after restoring", async () => {
    const state = await emulator.save_state();
    await emulator.restore_state(state);
    assert.match(await command("echo RE''STORED"), /^RESTORED$/m);
});

await step("reboot: through the firmware and the ESP to the login again", async () => {
    debug_log = "";
    serial = "";
    emulator.serial0_send("reboot\n");
    await wait_serial(/BdsDxe: starting Boot\d+ /, "the boot manager after rebooting", 300000);
    assert.match(debug_log, /SecCoreStartupWithStack/);
    await login();
});

await step("poweroff: ACPI S5 turns the machine off", async () => {
    emulator.serial0_send("poweroff\n");
    const start = Date.now();
    while(!emulator.v86.cpu.powered_off())
    {
        assert.ok(Date.now() - start < 120000, "powered off within 2 minutes");
        await new Promise(resolve => setTimeout(resolve, 500));
    }
});

clearTimeout(overall_timeout);
await emulator.destroy();
console.log("PASS: " + passed + " steps");
process.exit(0);
