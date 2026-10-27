#!/usr/bin/env node

// The UEFI variable store under failure (docs/uefi.md, the plan's F2: store
// exhaustion and consistency across power loss). The firmware's variable
// driver and its fault tolerant writes (edk2's FTW) keep the store
// consistent on real flash; what v86 has to give them is flash that behaves
// as flash (src/pflash.js). tests/uefi/vars_app.c, the ESP's boot loader,
// writes and checks variables (\MODE.TXT says what); between machines the
// store is the flash's bytes.
// - A 4 KiB variable rewritten (generation 1 to 2), the power cut at points
//   through the write (the store as the flash holds it after that many
//   programs and erases): the next boot finds generation 1 or 2, never a
//   mix, the other variables intact.
// - The store filled with 1 KiB variables until the firmware says it is full
//   (EFI_OUT_OF_RESOURCES); half of them deleted; the rewrite then needs the
//   space of the deleted ones (the firmware reclaims it), and the power cut
//   at points through that too.
//
// SECURE_BOOT=1: the Secure Boot firmware (its variable driver and FTW in
// SMM, the store written only in SMM) with a store of test keys, the app
// signed. TEST_RELEASE_BUILD=1. Needs x86_64-w64-mingw32-gcc (and openssl
// with SECURE_BOOT).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { spawnSync } from "node:child_process";
import { make_esp } from "../lib/fat.mjs";
import { test_key, sign_pe } from "../lib/authenticode.mjs";
import { write_variables, secure_boot_variables, x509_list, signature_list, CERT_SHA256 } from "../../tools/uefi_vars.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const ROOT = __dirname + "../../";
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const SECURE_BOOT = +process.env.SECURE_BOOT;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const OUT = ROOT + "build/vars-resilience-test/";
fs.mkdirSync(OUT, { recursive: true });
const OWNER = "86b00f5e-5b57-4c1a-9e2d-763836534201";

const build = spawnSync("x86_64-w64-mingw32-gcc", ["-std=gnu11", "-O2", "-ffreestanding", "-fno-builtin", "-fno-tree-loop-distribute-patterns",
    "-fno-stack-protector", "-mno-stack-arg-probe", "-mno-red-zone", "-Wall", "-Werror", "-nostdlib", "-shared", "-Wl,-dll",
    "-Wl,--subsystem,10", "-Wl,--entry,efi_main", "-Wl,--dynamicbase", "-o", OUT + "vars.efi", path.join(__dirname, "vars_app.c")], { encoding: "utf8" });
assert.equal(build.status, 0, build.stderr);
let app = new Uint8Array(fs.readFileSync(OUT + "vars.efi"));
let template = new Uint8Array(fs.readFileSync(ROOT + "bios/ovmf-vars.fd"));
if(SECURE_BOOT)
{
    const keys = Object.fromEntries(["PK", "KEK", "DB"].map(name => [name, test_key(ROOT + "build/secure-boot-test/keys", name)]));
    app = sign_pe(app, keys.DB);
    template = write_variables(template, secure_boot_variables({
        pk: x509_list(keys.PK.certificate, OWNER),
        kek: x509_list(keys.KEK.certificate, OWNER),
        db: x509_list(keys.DB.certificate, OWNER),
        dbx: signature_list(CERT_SHA256, [new Uint8Array(32)], OWNER),
    }));
}

/**
 * A machine of the store, the app in a mode, until it is done: its report,
 * the store after, and the store after each of the given numbers of
 * programs and erases (cuts)
 * @param {!Uint8Array} store
 * @param {string} mode
 * @param {!Array<number>=} cuts
 */
async function run(store, mode, cuts = [])
{
    const emulator = new V86({
        firmware: {
            type: "uefi",
            code: { url: ROOT + (SECURE_BOOT ? "bios/ovmf-secure-code.fd" : "bios/ovmf-code.fd") },
            vars: { buffer: store.slice().buffer },
            secure_boot: !!SECURE_BOOT,
            debug_console: true,
        },
        hda: { buffer: make_esp({ "EFI/BOOT/BOOTX64.EFI": app, "MODE.TXT": Buffer.from(mode + "\n") }, 16).buffer },
        memory_size: 512 * 1024 * 1024,
        graphics_adapter: "bochs_vga",
        cpu_type: "x86_64",
        machine_type: "q35",
        acpi: true,
        net_device: { type: "none" },
        autostart: false,
        log_level: 0,
    });
    await new Promise(resolve => emulator.add_listener("emulator-ready", resolve));
    let serial = "", debug_log = "";
    emulator.add_listener("serial0-output-byte", byte => { serial += String.fromCharCode(byte); });
    emulator.add_listener("debug-console-output-byte", byte => { debug_log += String.fromCharCode(byte); });
    // (each program and erase: the store's bytes then, at the cuts)
    const pflash = emulator.v86.cpu.firmware.pflash;
    const bytes = () => read(pflash);
    const store_op = pflash.store.bind(pflash);
    const captured = new Map();
    let operations = 0;
    pflash.store = (offset, data) => {
        store_op(offset, data);
        operations++;
        if(cuts.includes(operations)) captured.set(operations, bytes());
    };
    emulator.run();
    const deadline = Date.now() + 300000;
    while(!/V86VARS done/.test(serial))
    {
        assert.ok(Date.now() < deadline, "the app did not finish (" + mode + "):\n" + serial.slice(-1500));
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.doesNotMatch(debug_log, /ASSERT /, "an assertion in the firmware");
    const report = serial.replace(/\x1b\[[0-9;=?]*[A-Za-z]/g, "").replace(/\r/g, "").split("\n")
        .filter(l => l.startsWith("V86VARS ")).map(l => l.slice(8).trim());
    const after = bytes();
    await emulator.destroy();
    return { report, store: after, operations, captured, debug_log };
}
/** @param {!Object} pflash */
function read(pflash)
{
    let result;
    pflash.buffer.get(0, pflash.size, data => { result = data.slice(); });
    return result;
}
/** A report line's words after its key */
const field = (report, key) =>
{
    const line = report.find(l => l.startsWith(key + " "));
    assert.ok(line, "no " + key + " in:\n" + report.join("\n"));
    return line.slice(key.length + 1).split(" ");
};

let passed = 0;
async function step(name, f)
{
    const start = Date.now();
    await f();
    passed++;
    console.log("ok - " + name + " (" + ((Date.now() - start) / 1000).toFixed(1) + " s)");
}
/** Cut points through a write of n operations: the first few, then spread */
const cut_points = n => [...new Set([1, 2, 3, 8, Math.floor(n / 4), Math.floor(n / 2), Math.floor(n * 3 / 4), n - 2, n - 1])].filter(k => k > 0 && k < n);

/**
 * Stores cut short: each boots, V86Big one of the generations whole, the
 * marks and fills as they were; how often each generation was seen
 * @param {!Map<number, !Uint8Array>} captured
 * @param {!Array<string>} generations
 * @param {number} fills
 */
async function check_cuts(captured, generations, fills)
{
    const seen = {};
    for(const [k, store] of captured)
    {
        const { report } = await run(store, "check");
        const [status, , generation] = field(report, "big");
        assert.equal(status, "0", "V86Big after a cut at " + k);
        assert.ok(generations.includes(generation), "V86Big a whole generation after a cut at " + k + ": " + generation);
        assert.deepEqual(field(report, "marks"), ["8"], "the marks after a cut at " + k);
        assert.deepEqual(field(report, "fills"), [fills.toString(16), "bad", "0"], "the fills after a cut at " + k);
        seen[generation] = (seen[generation] || 0) + 1;
    }
    return seen;
}

console.log("The variable store under failure (" + (SECURE_BOOT ? "the Secure Boot firmware, SMM" : "OVMF") + ", Q35)");
let initial, rewrite;
await step("the variables written: eight marks and a 4 KiB variable (generation 1)", async () => {
    initial = await run(template, "setup 1");
    assert.deepEqual(field(initial.report, "setup"), ["0"]);
    assert.deepEqual(field(initial.report, "big"), ["0", "1000", "1"]);
    assert.deepEqual(field(initial.report, "marks"), ["8"]);
});

await step("the power cut through a rewrite (generation 2): each store boots with generation 1 or 2 whole, the marks intact", async () => {
    // (how many programs and erases the rewrite makes, then the cuts through it)
    rewrite = await run(initial.store, "write 2");
    assert.deepEqual(field(rewrite.report, "write"), ["0"]);
    assert.deepEqual(field(rewrite.report, "big"), ["0", "1000", "2"]);
    const cuts = cut_points(rewrite.operations);
    const { captured } = await run(initial.store, "write 2", cuts);
    assert.equal(captured.size, cuts.length);
    const seen = await check_cuts(captured, ["1", "2"], 0);
    console.log("    " + rewrite.operations + " operations; cut at " + cuts.join(", ") + ": generation " + JSON.stringify(seen));
    assert.ok(seen["1"] && seen["2"], "both generations among the cuts");
});

let full, holes;
await step("the store filled until the firmware says it is full; half the fills deleted", async () => {
    full = await run(rewrite.store, "fill");
    const [count, status] = field(full.report, "fill");
    assert.equal(status, "8000000000000009", "EFI_OUT_OF_RESOURCES");
    assert.ok(parseInt(count, 16) > 100, count + " variables of 1 KiB");
    assert.deepEqual(field(full.report, "fills"), [count, "bad", "0"]);
    holes = await run(full.store, "delete");
    const deleted = parseInt(field(holes.report, "deleted")[0], 16);
    assert.equal(deleted, Math.ceil(parseInt(count, 16) / 2));
    assert.deepEqual(field(holes.report, "fills"), [(parseInt(count, 16) - deleted).toString(16), "bad", "0"]);
    assert.deepEqual(field(holes.report, "marks"), ["8"]);
    console.log("    " + parseInt(count, 16) + " fills, " + deleted + " deleted");
});

await step("a rewrite into the reclaimed space, the power cut through it: each store consistent", async () => {
    const remaining = parseInt(field(holes.report, "fills")[0], 16);
    const whole = await run(holes.store, "write 3");
    assert.deepEqual(field(whole.report, "write"), ["0"], "the rewrite after the reclaim");
    assert.deepEqual(field(whole.report, "big"), ["0", "1000", "3"]);
    assert.ok(whole.operations > rewrite.operations * 4, "a reclaim on the way: " + whole.operations + " operations");
    const cuts = cut_points(whole.operations);
    const { captured } = await run(holes.store, "write 3", cuts);
    const seen = await check_cuts(captured, ["2", "3"], remaining);
    console.log("    " + whole.operations + " operations; cut at " + cuts.join(", ") + ": generation " + JSON.stringify(seen));
});

console.log("PASS: " + passed + " steps");
process.exit(0);
