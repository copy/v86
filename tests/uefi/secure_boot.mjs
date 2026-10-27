#!/usr/bin/env node

// Secure Boot (docs/uefi.md, the plan's F2): the Secure Boot firmware
// (bios/ovmf-secure-code.fd: its variable services in SMM, its store written
// only in SMM) on Q35 with a variable store of test keys (tools/uefi_vars.mjs:
// PK, KEK, db with key DB, dbx with one image's hash), the keys made for the
// test (tests/lib/authenticode.mjs; build/secure-boot-test/keys, never part
// of the repository). An ESP (tests/lib/fat.mjs) holds tests/uefi/sb_app.c
// signed with DB as \EFI\BOOT\BOOTX64.EFI, the probes, the updates and
// Alpine's virt kernel signed with DB. What has to hold:
// - Secure Boot on (User Mode); the app itself verified and run
// - LoadImage: signed with DB passes; unsigned, changed after signing, signed
//   with a key not enrolled, revoked by its hash in dbx, and signed with a
//   key not in db yet are refused (the firmware's log says why)
// - SetVariable: db without a signature, PK signed by KEK (it needs PK), dbx
//   signed by a key not in KEK are refused; db appended with DB2 (signed by
//   KEK) is taken, and DB2's probe then passes; db replaced (time T2), the
//   same update again and an older one (T1) are refused: no replay
// - a direct write to the store's flash outside SMM does nothing
// - after a cold reset: the store as left (DB2 in db, in the flash's bytes
//   too), the probes as before; Linux (signed) boots and sees Secure Boot on
//
// CPU_CORES=2, SHOW_LOGS=1, TEST_RELEASE_BUILD=1. Needs x86_64-w64-mingw32-gcc
// and openssl.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { make_esp } from "../lib/fat.mjs";
import { test_key, sign_pe, pe_hash, signed_update } from "../lib/authenticode.mjs";
import { prepare as prepare_alpine } from "../lib/alpine_image.mjs";
import {
    write_variables, read_variables, secure_boot_variables, x509_list, signature_list,
    CERT_SHA256, GLOBAL_VARIABLE, IMAGE_SECURITY_DATABASE, SECURE_BOOT_ATTRIBUTES, APPEND,
} from "../../tools/uefi_vars.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const ROOT = __dirname + "../../";
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const SHOW_LOGS = +process.env.SHOW_LOGS;
const CPU_CORES = +process.env.CPU_CORES || 1;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const OUT = ROOT + "build/secure-boot-test/";
fs.mkdirSync(OUT, { recursive: true });
const OWNER = "86b00f5e-5b57-4c1a-9e2d-763836534201";

// --- the keys, the images, the updates
const keys = Object.fromEntries(["PK", "KEK", "DB", "DB2", "OTHER"].map(name => [name, test_key(OUT + "keys", name)]));

function compile(output, defines = [])
{
    const result = spawnSync("x86_64-w64-mingw32-gcc", ["-std=gnu11", "-O2", "-ffreestanding", "-fno-builtin", "-fno-tree-loop-distribute-patterns",
        "-fno-stack-protector", "-mno-stack-arg-probe", "-mno-red-zone", "-Wall", "-Werror", "-nostdlib", "-shared", "-Wl,-dll",
        "-Wl,--subsystem,10", "-Wl,--entry,efi_main", "-Wl,--dynamicbase", ...defines, "-o", output, path.join(__dirname, "sb_app.c")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return new Uint8Array(fs.readFileSync(output));
}
const app = compile(OUT + "app.efi");
const probe = n => compile(OUT + "probe" + n + ".efi", ["-DPROBE=" + n]);
const signed_db = sign_pe(probe(1), keys.DB);
// (changed after signing: a byte of its code, far from the headers)
const changed = signed_db.slice();
changed[0x400 + 0x10] ^= 0xFF;
const revoked = sign_pe(probe(2), keys.DB);

const T1 = new Date(Date.UTC(2026, 0, 1)), T2 = new Date(Date.UTC(2026, 6, 1));
const db_lists = [x509_list(keys.DB.certificate, OWNER), x509_list(keys.DB2.certificate, OWNER)];
const db_both = new Uint8Array(Buffer.concat(db_lists));
const update = (name, guid, attributes, time, data, signer) => signed_update({ name, guid, attributes, time, data, signer });

const prepared = await prepare_alpine("x86_64-virt");
const esp = make_esp({
    "EFI/BOOT/BOOTX64.EFI": sign_pe(app, keys.DB),
    "PROBE/DB.EFI": signed_db,
    "PROBE/UNSIGNED.EFI": probe(1),
    "PROBE/CHANGED.EFI": changed,
    "PROBE/OTHER.EFI": sign_pe(probe(1), keys.OTHER),
    "PROBE/REVOKED.EFI": revoked,
    "PROBE/DB2.EFI": sign_pe(probe(3), keys.DB2),
    "UPDATE/UNSIGNED.BIN": db_lists[1],
    "UPDATE/PKBYKEK.BIN": update("PK", GLOBAL_VARIABLE, SECURE_BOOT_ATTRIBUTES, T1, x509_list(keys.OTHER.certificate, OWNER), keys.KEK),
    "UPDATE/DBXOTHER.BIN": update("dbx", IMAGE_SECURITY_DATABASE, SECURE_BOOT_ATTRIBUTES | APPEND, T1,
        signature_list(CERT_SHA256, [crypto.randomBytes(32)], OWNER), keys.OTHER),
    "UPDATE/DBADD.BIN": update("db", IMAGE_SECURITY_DATABASE, SECURE_BOOT_ATTRIBUTES | APPEND, T1, db_lists[1], keys.KEK),
    "UPDATE/DBSET2.BIN": update("db", IMAGE_SECURITY_DATABASE, SECURE_BOOT_ATTRIBUTES, T2, db_both, keys.KEK),
    "UPDATE/DBSET1.BIN": update("db", IMAGE_SECURITY_DATABASE, SECURE_BOOT_ATTRIBUTES, T1, db_both, keys.KEK),
    "LINUX/VMLINUZ.EFI": sign_pe(new Uint8Array(fs.readFileSync(prepared.kernel)), keys.DB),
    "LINUX/INITRD.IMG": new Uint8Array(fs.readFileSync(prepared.initrd)),
    "LINUX/CMDLINE.TXT": Buffer.from("initrd=\\LINUX\\INITRD.IMG console=ttyS0,115200 loglevel=4 modules=loop,squashfs,sd-mod\n"),
});

// the store: test keys, REVOKED's hash in dbx
const vars = write_variables(new Uint8Array(fs.readFileSync(ROOT + "bios/ovmf-vars.fd")), secure_boot_variables({
    pk: x509_list(keys.PK.certificate, OWNER),
    kek: x509_list(keys.KEK.certificate, OWNER),
    db: db_lists[0],
    dbx: signature_list(CERT_SHA256, [pe_hash(revoked)], OWNER),
}));

const emulator = new V86({
    firmware: {
        type: "uefi",
        code: { url: ROOT + "bios/ovmf-secure-code.fd" },
        vars: { buffer: vars.buffer },
        secure_boot: true,
        debug_console: true,
    },
    hda: { buffer: esp.buffer },
    cdrom: { url: prepared.iso },
    memory_size: 768 * 1024 * 1024,
    graphics_adapter: "bochs_vga",
    cpu_type: "x86_64",
    cpu_cores: CPU_CORES,
    experimental_smp_jit: CPU_CORES > 1,
    machine_type: "q35",
    acpi: true,
    net_device: { type: "none" },
    autostart: true,
    log_level: 0,
});

const overall_timeout = setTimeout(() => {
    console.log("\nTimeout. Serial output:\n" + serial.slice(-3000));
    process.exit(1);
}, 900 * 1000);

let serial = "", debug_log = "";
emulator.add_listener("serial0-output-byte", byte => {
    const chr = String.fromCharCode(byte);
    if(SHOW_LOGS) process.stdout.write(chr);
    serial += chr;
});
emulator.add_listener("debug-console-output-byte", byte => { debug_log += String.fromCharCode(byte); });
// (the firmware's log and the serial console, for a failure)
process.on("exit", () => {
    fs.writeFileSync(OUT + "firmware.log", debug_log);
    fs.writeFileSync(OUT + "serial.log", serial);
});
const plain = () => serial.replace(/\x1b\[[0-9;=?]*[A-Za-z]/g, "").replace(/\r/g, "");
async function until(pattern, what, timeout_ms)
{
    const deadline = Date.now() + timeout_ms;
    while(!pattern.test(plain()))
    {
        assert.ok(Date.now() < deadline, "timed out waiting for " + what + ":\n" + plain().slice(-2500));
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}
/** The app's report: "V86SB key ..." lines from the given point */
const reports = from => plain().slice(from).split("\n").filter(line => line.startsWith("V86SB ")).map(line => line.slice(6).trim());
const status_of = (lines, prefix) =>
{
    const line = lines.find(l => l.startsWith(prefix + " "));
    assert.ok(line, "no report of " + prefix + " in:\n" + lines.join("\n"));
    return BigInt("0x" + line.slice(prefix.length + 1).split(" ")[0]);
};
let passed = 0;
async function step(name, f)
{
    const start = Date.now();
    await f();
    passed++;
    console.log("ok - " + name + " (" + ((Date.now() - start) / 1000).toFixed(1) + " s)");
}
const SECURITY_VIOLATION = 0x800000000000001An;
const refused = s => s === SECURITY_VIOLATION || s === 0x800000000000000Fn || s === 0x8000000000000002n;
const PROBES = ["DB", "UNSIGNED", "CHANGED", "OTHER", "REVOKED", "DB2"].map(name => "load \\PROBE\\" + name + ".EFI");

console.log("Booting the Secure Boot firmware with test keys (Q35, " + CPU_CORES + " core" + (CPU_CORES > 1 ? "s" : "") + ")");
let first;
await step("Secure Boot on, User Mode; the signed app runs", async () => {
    await until(/V86SB reset/, "the app's first run", 300000);
    first = reports(0);
    assert.match(first[0], /^boot 0 SecureBoot 1 SetupMode 0$/);
    assert.match(debug_log, /Variable SetupMode is 0\r?\nVariable SecureBoot is 1/);
});

await step("LoadImage: signed with DB passes; unsigned, changed, other key, revoked by dbx, DB2 not yet in db refused", async () => {
    const [db, unsigned, changed, other, revoked, db2] = PROBES.map(p => status_of(first, p));
    assert.equal(db, 0n, "DB");
    for(const [name, status] of Object.entries({ unsigned, changed, other, revoked, db2 })) assert.ok(refused(status), name + ": " + status.toString(16));
    assert.match(debug_log, /DxeImageVerificationLib: Image is not signed and SHA\d+ hash of image is not found in DB\/DBX/);
    assert.match(debug_log, /DxeImageVerificationLib: Image is signed but signature is not allowed by DB and SHA256 hash of image is not found in DB\/DBX/);
    assert.match(debug_log, /DxeImageVerificationLib: Image is signed but SHA256 hash of image is found in DBX/);
});

await step("SetVariable: unsigned db, PK signed by KEK, dbx signed by an unknown key refused", async () => {
    for(const label of ["db-unsigned", "PK-signed-by-KEK", "dbx-signed-by-other"])
    {
        assert.ok(refused(status_of(first, "set " + label)), label);
    }
});

await step("the store's flash outside SMM: a program command does nothing", async () => {
    const [before, after] = first.find(l => l.startsWith("flash ")).split(" ").slice(1);
    assert.equal(after, before);
    assert.equal(before, "aa", "the first variable's header");
    assert.ok(emulator.v86.cpu.firmware.pflash.refused_writes >= 2, "writes refused");
});

await step("db appended with DB2 (signed by KEK): taken, DB2's probe passes; replaced at T2, then that again and T1: refused", async () => {
    assert.equal(status_of(first, "set db-append-db2"), 0n);
    const loads = first.filter(l => l.startsWith("load \\PROBE\\DB2.EFI "));
    assert.equal(loads.length, 2);
    assert.equal(BigInt("0x" + loads[1].split(" ")[2]), 0n, "DB2 after the update");
    assert.equal(status_of(first, "set db-set-t2"), 0n);
    assert.ok(refused(status_of(first, "set db-set-t2-replayed")), "replayed");
    assert.ok(refused(status_of(first, "set db-set-t1-older")), "older");
});

await step("after a cold reset: the store as left (DB2 in db, also in the flash), the probes as before", async () => {
    const from = plain().lastIndexOf("V86SB reset");
    await until(/V86SB linux next/, "the app's second run", 300000);
    const second = reports(from).filter(l => l !== "reset");
    assert.match(second[0], /^boot 1 SecureBoot 1 SetupMode 0$/);
    const [db, unsigned, changed, other, revoked, db2] = PROBES.map(p => status_of(second, p));
    assert.equal(db, 0n);
    assert.equal(db2, 0n, "DB2: in db since the update");
    for(const [name, status] of Object.entries({ unsigned, changed, other, revoked })) assert.ok(refused(status), name);
    // (the bytes of the flash: what the machine writes back)
    const store = new Uint8Array(await new Promise(resolve => emulator.v86.cpu.firmware.pflash.buffer.get(0, vars.length, resolve)));
    const variables = read_variables(store);
    const db_variable = variables.find(v => v.name === "db");
    assert.ok(Buffer.from(db_variable.data).includes(Buffer.from(keys.DB2.certificate)), "DB2's certificate in db");
    assert.deepEqual(variables.filter(v => v.name === "PK").map(v => Buffer.from(v.data).includes(Buffer.from(keys.PK.certificate))), [true], "PK unchanged");
});

await step("Linux, signed with DB, boots and sees Secure Boot on", async () => {
    await until(/V86SB linux 0/, "the kernel loaded", 60000);
    await until(/login: $/, "Linux's login prompt", 600000);
    emulator.serial0_send("root\n");
    await until(/:~# (\x1b\[6n)?$/, "the shell", 60000);
    // (the variable through efivarfs: its attributes, then its byte; the
    // firmware's GetVariable in SMM under Linux)
    serial = "";
    emulator.serial0_send("F=/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c; " +
        "for i in $(seq 20); do [ -e $F ] && break; sleep 1; done; echo BE''GIN; od -An -tu1 $F; echo rc=$?; dmesg | grep -i 'secure boot'; echo EN''D\n");
    await until(/^END$/m, "the command", 60000);
    const output = plain().match(/^BEGIN\n([^]*?)^END$/m)[1];
    if(!/^\s*(\d+\s+){4}1\s*$/m.test(output))
    {
        serial = "";
        emulator.serial0_send("echo BE''GIN; ls -l /sys/firmware/efi/efivars | head; mount | grep efivar; dmesg | grep -i efi; echo EN''D\n");
        await until(/^END$/m, "the diagnostics", 60000);
        assert.fail("the SecureBoot variable: 1\n" + output + "\n" + plain());
    }
    assert.match(output, /Secure boot enabled/i);
});

clearTimeout(overall_timeout);
await emulator.destroy();
console.log("PASS: " + passed + " steps");
process.exit(0);
