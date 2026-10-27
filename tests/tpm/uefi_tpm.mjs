#!/usr/bin/env node

// The TPM with the UEFI firmware (docs/tpm.md; the plan's T2): OVMF finds the
// TPM 2.0 behind the CRB, starts it and measures the boot into its SHA-256
// PCRs (the firmware volumes, its configuration, the boot loader, GRUB and
// Linux's own measurements through the TCG2 protocol); Linux (Alpine 3.24's
// LTS kernel from a GPT disk's ESP, tests/lib/uefi_disk.mjs) finds the event
// log through the EFI configuration table. The log replayed (each event's
// SHA-256 digest extended into its PCR) gives what the TPM reads for every
// PCR it names: the measurements are the TPM's, the log describes them.
//
// MACHINE=i440fx, CPU_CORES=2, SHOW_LOGS=1, TEST_RELEASE_BUILD=1. macOS (hdiutil).

import assert from "node:assert/strict";
import url from "node:url";
import { replay } from "../lib/tpm_event_log.mjs";
import { prepare_esp_disk } from "../lib/uefi_disk.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const ROOT = __dirname + "../../";
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const SHOW_LOGS = +process.env.SHOW_LOGS;
const CPU_CORES = +process.env.CPU_CORES || 1;
const MACHINE = process.env.MACHINE || "q35";
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const disk = await prepare_esp_disk("lts");
const emulator = new V86({
    firmware: {
        type: "uefi",
        code: { url: ROOT + "bios/ovmf-code.fd" },
        vars: { url: ROOT + "bios/ovmf-vars.fd" },
        debug_console: true,
    },
    hda: { url: disk },
    memory_size: 768 * 1024 * 1024,
    graphics_adapter: "bochs_vga",
    cpu_type: "x86_64",
    cpu_cores: CPU_CORES,
    experimental_smp_jit: CPU_CORES > 1,
    machine_type: MACHINE,
    qemu_compatible: MACHINE === "i440fx",
    acpi: true,
    net_device: { type: "none" },
    tpm: { version: "2.0" },
    autostart: true,
    log_level: 0,
});

const overall_timeout = setTimeout(() => {
    console.log("\nTimeout. Serial output since the last command:\n" + serial.slice(-3000));
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
    if(waiter && waiter.pattern.test(serial))
    {
        const { resolve } = waiter;
        waiter = null;
        resolve(serial);
    }
});
emulator.add_listener("debug-console-output-byte", byte => { debug_log += String.fromCharCode(byte); });

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
/** A command's output: between markers its echo does not have */
async function command(cmd, timeout_ms = 120000)
{
    serial = "";
    emulator.serial0_send("echo BE''GIN; " + cmd + "; echo EN''D\n");
    const output = await wait_serial(/^END\r?\n[^]*:~# (\x1b\[6n)?$/m, JSON.stringify(cmd), timeout_ms);
    return output.replace(/\r/g, "").match(/^BEGIN\n([^]*?)^END$/m)[1];
}
let passed = 0;
async function step(name, f)
{
    const start = Date.now();
    await f();
    passed++;
    console.log("ok - " + name + " (" + ((Date.now() - start) / 1000).toFixed(1) + " s)");
}

console.log("Booting the LTS ESP disk under UEFI with a TPM (" + MACHINE + ", " + CPU_CORES + " core" + (CPU_CORES > 1 ? "s" : "") + ")");

await step("OVMF: the TPM 2.0 found, started, its SHA-256 bank active; Linux's login", async () => {
    await wait_serial(/login: $/, "the login prompt", 600000);
    assert.match(debug_log, /Tcg2ConfigPeimEntryPoint: TPM2 detected/);
    assert.match(debug_log, /TPM2Startup: TPM_RC_SUCCESS/);
    assert.match(debug_log, /Tpm2GetCapabilitySupportedAndActivePcrs - TpmActivePcrBanks 0x00000002/);
    assert.doesNotMatch(debug_log, /ASSERT /);
    serial = "";
    emulator.serial0_send("root\n");
    await wait_serial(PROMPT, "the shell", 120000);
});

await step("Linux: tpm_crb, the event log from the EFI configuration table", async () => {
    const output = await command("for i in $(seq 20); do [ -e /dev/tpm0 ] && break; sleep 1; done; " +
        "basename $(readlink /sys/class/tpm/tpm0/device/driver); dmesg | grep -o 'TPMFinalLog=0x[0-9a-f]*\\|TPMEventLog=0x[0-9a-f]*' | sort -u; " +
        "ls -l /sys/kernel/security/tpm0/binary_bios_measurements");
    assert.match(output, /^tpm_crb$/m);
    assert.match(output, /TPMEventLog=0x/);
    assert.match(output, /binary_bios_measurements/);
});

await step("the event log replayed: each PCR it names reads as the TPM has it", async () => {
    const encoded = await command("base64 -w0 /sys/kernel/security/tpm0/binary_bios_measurements; echo", 300000);
    const { pcrs, events } = replay(Buffer.from(encoded.trim(), "base64"));
    assert.ok(events > 20, events + " events");
    for(const pcr of [0, 1, 2, 3, 4, 5, 6, 7]) assert.ok(pcrs.has(pcr), "PCR " + pcr + " in the log");
    const reads = await command("for p in " + [...pcrs.keys()].join(" ") + "; do echo $p $(cat /sys/class/tpm/tpm0/pcr-sha256/$p); done");
    for(const line of reads.trim().split("\n"))
    {
        const [pcr, value] = line.split(" ");
        assert.equal(value.toLowerCase(), pcrs.get(+pcr).toString("hex"), "PCR " + pcr);
    }
    console.log("    " + events + " events, PCRs " + [...pcrs.keys()].sort((a, b) => a - b).join(", "));
});

clearTimeout(overall_timeout);
await emulator.destroy();
console.log("PASS: " + passed + " steps");
process.exit(0);
