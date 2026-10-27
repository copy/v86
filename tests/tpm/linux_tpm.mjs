#!/usr/bin/env node

// The TPM 2.0 with a real driver (docs/tpm.md; the plan's T1, "Linux 的
// tpm_crb 验证命令通路"): Alpine 3.24 x86_64 (the pinned standard ISO, its LTS
// kernel: the virt kernel has no TPM drivers; tests/lib/alpine_image.mjs)
// with tpm: { version: "2.0" } under SeaBIOS.
// SeaBIOS finds the TPM, starts it and measures the boot into the log area
// the TPM2 table gives (etc/tpm/log); Linux binds tpm_crb to the DSDT's
// MSFT0101 through the TPM2 table, registers /dev/tpm0 (TPM 2.0) and reads
// SeaBIOS's event log, which replayed gives the PCRs the TPM has; its hwrng
// draws from it. A command through /dev/tpm0 (GetRandom); PCR_Extend there
// and the PCR as Linux's sysfs reads it (pcr-sha256/16): SHA-256 of the
// old value and the data; a snapshot keeps it.
//
// MACHINE=q35, CPU_CORES=2, SHOW_LOGS=1, TEST_RELEASE_BUILD=1.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import url from "node:url";
import { prepare as prepare_alpine } from "../lib/alpine_image.mjs";
import { replay } from "../lib/tpm_event_log.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const ROOT = __dirname + "../../";
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const SHOW_LOGS = +process.env.SHOW_LOGS;
const CPU_CORES = +process.env.CPU_CORES || 1;
const MACHINE = process.env.MACHINE || "i440fx";
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const prepared = await prepare_alpine("x86_64-lts");
const emulator = new V86({
    graphics_adapter: "bochs_vga",
    bios: { url: ROOT + "bios/seabios.bin" },
    vga_bios: { url: ROOT + "bios/vgabios.bin" },
    bzimage: { url: prepared.kernel },
    initrd: { url: prepared.initrd },
    cdrom: { url: prepared.iso },
    cmdline: "console=ttyS0,115200 loglevel=4 nokaslr modules=loop,squashfs,sd-mod",
    memory_size: 512 * 1024 * 1024,
    cpu_type: "x86_64",
    cpu_cores: CPU_CORES,
    experimental_smp_jit: CPU_CORES > 1,
    machine_type: MACHINE,
    acpi: true,
    net_device: { type: "none" },
    tpm: { version: "2.0" },
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

/** A TPM command through /dev/tpm0 (one file descriptor, written then read): the response's hex */
async function tpm(hex)
{
    const bytes = Buffer.from(hex.replace(/ /g, ""), "hex");
    bytes.writeUInt32BE(bytes.length, 2);
    const escaped = Array.from(bytes, b => "\\" + b.toString(8).padStart(3, "0")).join("");
    const output = await command("exec 3<>/dev/tpm0; printf '" + escaped + "' >&3; dd bs=4096 count=1 <&3 2>/dev/null | od -An -v -tx1 | tr -d ' \\n'; echo; exec 3>&-");
    return output.trim();
}

console.log("Booting Alpine x86_64 with a TPM 2.0 (" + MACHINE + ", " + CPU_CORES + " core" + (CPU_CORES > 1 ? "s" : "") + ")");
await wait_serial(/login: $/, "the login prompt", 600000);
serial = "";
emulator.serial0_send("root\n");
await wait_serial(PROMPT, "the shell", 120000);

await step("tpm_crb on MSFT0101: /dev/tpm0, a TPM 2.0, the hwrng", async () => {
    const output = await command("for i in $(seq 20); do [ -e /dev/tpm0 ] && break; modprobe tpm_crb 2>/dev/null; sleep 1; done; " +
        "basename $(readlink /sys/class/tpm/tpm0/device/driver); cat /sys/class/tpm/tpm0/tpm_version_major; " +
        "cat /sys/class/tpm/tpm0/device/hid 2>/dev/null; cat /sys/class/misc/hw_random/rng_available");
    assert.match(output, /^tpm_crb$/m);
    assert.match(output, /^2$/m);
    assert.match(output, /^MSFT0101$/m);
    assert.match(output, /tpm-rng-0/);
});

await step("SeaBIOS started the TPM and measured the boot: the TPM2 table's log replayed", async () => {
    const encoded = await command("base64 -w0 /sys/kernel/security/tpm0/binary_bios_measurements; echo", 300000);
    const { pcrs, events } = replay(Buffer.from(encoded.trim(), "base64"));
    // (its separators end PCRs 0 to 7 before the boot)
    for(const pcr of [0, 1, 2, 3, 4, 5, 6, 7]) assert.ok(pcrs.has(pcr), "PCR " + pcr + " in the log");
    const reads = await command("for p in " + [...pcrs.keys()].join(" ") + "; do echo $p $(cat /sys/class/tpm/tpm0/pcr-sha256/$p); done");
    for(const line of reads.trim().split("\n"))
    {
        const [pcr, value] = line.split(" ");
        assert.equal(value.toLowerCase(), pcrs.get(+pcr).toString("hex"), "PCR " + pcr);
    }
    console.log("    " + events + " events, PCRs " + [...pcrs.keys()].sort((a, b) => a - b).join(", "));
});

await step("a command through /dev/tpm0: GetRandom", async () => {
    const response = await tpm("8001 00000000 0000017b 0010");
    assert.match(response, /^80010000001c00000000(0010)[0-9a-f]{32}$/);
});

let expected;
await step("PCR_Extend through /dev/tpm0; Linux's sysfs reads the PCR: SHA-256 of the old value and the data", async () => {
    const before = (await command("cat /sys/class/tpm/tpm0/pcr-sha256/16")).trim().toLowerCase();
    const data = crypto.randomBytes(32);
    const response = await tpm("8002 00000000 00000182 00000010 00000009 40000009 0000 00 0000 00000001 000b " + data.toString("hex"));
    assert.match(response, /^80020000001300000000/);
    expected = crypto.createHash("sha256").update(Buffer.concat([Buffer.from(before, "hex"), data])).digest("hex");
    assert.equal((await command("cat /sys/class/tpm/tpm0/pcr-sha256/16")).trim().toLowerCase(), expected);
});

await step("a snapshot: the PCR after restoring", async () => {
    const state = await emulator.save_state();
    await emulator.restore_state(state);
    serial = "";
    emulator.serial0_send("\n");
    await wait_serial(PROMPT, "the shell after restoring", 30000);
    assert.equal((await command("cat /sys/class/tpm/tpm0/pcr-sha256/16")).trim().toLowerCase(), expected);
});

clearTimeout(overall_timeout);
await emulator.destroy();
console.log("PASS: " + passed + " steps");
process.exit(0);
