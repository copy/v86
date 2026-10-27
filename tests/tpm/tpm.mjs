#!/usr/bin/env node

// The TPM 2.0 device (docs/tpm.md) without a guest: a machine with tpm, the
// CRB driven through the machine's memory map as a driver drives it
// (locality, command ready, the command in the data buffer, start, the
// response). The interface identifier; TPM2_Startup, GetRandom (bytes that
// differ), the PCR banks (SHA-256 only, as made), PCR_Extend and PCR_Read
// (the digest SHA-256 of the old value and the data); the ACPI tables
// (TPM2: CRB, the control area, the log area; the DSDT's MSFT0101). The state kept
// (tpm.state written back): an NV index defined and written in one machine
// is read in the next; a damaged store is refused, a store of zeros is a new
// TPM. Snapshots: the PCRs (volatile) come back, a snapshot of a store
// written since does not restore. A machine reset is the TPM's (Startup
// needed again).
//
// TEST_RELEASE_BUILD=1, MACHINE=q35.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const ROOT = __dirname + "../../";
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const MACHINE = process.env.MACHINE || "i440fx";
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const directory = ROOT + "build/tpm-test/";
fs.mkdirSync(directory, { recursive: true });
const STORE = directory + "tpm-state.img";
fs.writeFileSync(STORE, Buffer.alloc(512 * 1024));

const BASE = 0xFED40000;

/** A machine with a TPM, not running: { emulator, cpu } */
async function machine(state)
{
    const emulator = new V86({
        bios: { url: ROOT + "bios/seabios.bin" },
        vga_bios: { url: ROOT + "bios/vgabios.bin" },
        memory_size: 64 * 1024 * 1024,
        graphics_adapter: "bochs_vga",
        machine_type: MACHINE,
        acpi: true,
        net_device: { type: "none" },
        tpm: { version: "2.0", state },
        autostart: false,
        log_level: 0,
    });
    await new Promise((resolve, reject) => {
        emulator.add_listener("emulator-ready", resolve);
        emulator.add_listener("emulator-error", reject);
    });
    return { emulator, cpu: emulator.v86.cpu };
}

/** The CRB through the memory map, as a driver: { read, write, command } */
function crb(cpu)
{
    const block = address => address >>> 17;
    const read = offset => cpu.memory_map_read32[block(BASE + offset)](BASE + offset | 0) >>> 0;
    const write = (offset, value) => cpu.memory_map_write32[block(BASE + offset)](BASE + offset | 0, value | 0);
    const command = (hex, locality = 0) =>
    {
        const window = locality * 0x1000;
        const bytes = Buffer.from(hex.replace(/ /g, ""), "hex");
        bytes.writeUInt32BE(bytes.length, 2);
        write(window + 0x08, 1);                        // LOC_CTRL: request access
        assert.equal(read(window + 0x0C) & 1, 1, "the locality granted");
        assert.equal(read(window + 0x00) >> 2 & 7, locality, "the active locality");
        write(window + 0x40, 1);                        // CTRL_REQ: command ready
        assert.equal(read(window + 0x44) & 2, 0, "not idle");
        const buffer = read(window + 0x5C);             // CMD_LADDR
        assert.equal(buffer, BASE + 0x80);
        const padded = Buffer.concat([bytes, Buffer.alloc(-bytes.length & 3)]);
        for(let i = 0; i < padded.length; i += 4) write(buffer - BASE + i, padded.readInt32LE(i));
        write(window + 0x4C, 1);                        // CTRL_START
        assert.equal(read(window + 0x4C), 0, "the command done");
        const header = Buffer.alloc(8);
        header.writeUInt32LE(read(0x80), 0);
        header.writeUInt32LE(read(0x84), 4);
        const length = header.readUInt32BE(2);
        const response = Buffer.alloc(length + 3 & ~3);
        for(let i = 0; i < response.length; i += 4) response.writeUInt32LE(read(0x80 + i), i);
        write(window + 0x40, 2);                        // go idle
        write(window + 0x08, 2);                        // relinquish
        return response.subarray(0, length);
    };
    return { read, write, command };
}

const code = response => response.readUInt32BE(6);
const STARTUP = "8001 00000000 00000144 0000";
// a password session with an empty password
const PW = "00000009 40000009 0000 00 0000";
const NV_INDEX = "01500016";

let passed = 0;
async function step(name, f)
{
    await f();
    passed++;
    console.log("ok - " + name);
}

let first = await machine({ url: STORE, disk_option: "read_write" });
let tpm = crb(first.cpu);

await step("the interface identifier: CRB, version 1, five localities; QEMU's vendor and device", async () => {
    const low = tpm.read(0x30), high = tpm.read(0x34);
    assert.equal(low & 0xF, 1, "interface type CRB");
    assert.equal(low >> 4 & 0xF, 1, "CRB version 1");
    assert.equal(low >> 8 & 1, 1, "five localities");
    assert.equal(high, 0x00011014);
    assert.equal(tpm.read(0x00) & 0x80, 0x80, "the registers valid");
    assert.equal(tpm.read(0x58), 0xF80, "the buffer's size");
});

await step("Startup, GetRandom (bytes from the host's randomness)", async () => {
    assert.equal(code(tpm.command(STARTUP)), 0);
    const a = tpm.command("8001 00000000 0000017b 0020"), b = tpm.command("8001 00000000 0000017b 0020");
    assert.equal(code(a), 0);
    assert.equal(a.readUInt16BE(10), 32);
    assert.notDeepEqual(a.subarray(12), b.subarray(12));
});

let pcr16;
await step("the PCR banks: SHA-256 only; PCR_Extend and PCR_Read agree with SHA-256", async () => {
    const banks = tpm.command("8001 00000000 0000017a 00000005 00000000 00000001");
    assert.equal(code(banks), 0);
    // (count 4: SHA-1, SHA-256, SHA-384, SHA-512; selected PCRs only in SHA-256's)
    assert.equal(banks.subarray(19).toString("hex"), "000403000000000b03ffffff000c03000000000d03000000");
    const data = crypto.randomBytes(32);
    assert.equal(code(tpm.command("8002 00000000 00000182 00000010 " + PW + " 00000001 000b " + data.toString("hex"))), 0);
    const read = tpm.command("8001 00000000 0000017e 00000001 000b 03 000001");
    assert.equal(code(read), 0);
    pcr16 = crypto.createHash("sha256").update(Buffer.concat([Buffer.alloc(32), data])).digest();
    assert.deepEqual(read.subarray(read.length - 32), pcr16);
});

await step("the ACPI tables: TPM2 (CRB, its control area, the log area) and the DSDT's MSFT0101", async () => {
    const fw = first.cpu.option_roms.find(file => file.name === "etc/acpi/tables");
    const bytes = Buffer.from(fw.get_data ? fw.get_data() : fw.data);
    const at = bytes.indexOf("TPM2");
    assert.ok(at >= 0, "a TPM2 table");
    assert.equal(bytes.readUInt32LE(at + 4), 76);
    assert.equal(bytes[at + 8], 4, "revision 4");
    assert.equal(Number(bytes.readBigUInt64LE(at + 40)), BASE + 0x40, "the control area");
    assert.equal(bytes.readUInt32LE(at + 48), 7, "start method CRB");
    assert.equal(bytes.readUInt32LE(at + 64), 0x10000, "a log area of 64 KiB");
    const log = first.cpu.option_roms.find(file => file.name === "etc/tpm/log");
    assert.equal(log && log.data.length, 0x10000, "etc/tpm/log, which the table loader allocates");
    assert.ok(bytes.indexOf("MSFT0101") > 0, "the DSDT's MSFT0101");
});

await step("the state kept: an NV index written in one machine, read in the next", async () => {
    // NV_DefineSpace(owner): AUTHWRITE | AUTHREAD | NO_DA, 8 bytes; NV_Write
    assert.equal(code(tpm.command("8002 00000000 0000012a 40000001 " + PW + " 0000 000e " + NV_INDEX + " 000b 02040004 0000 0008")), 0);
    assert.equal(code(tpm.command("8002 00000000 00000137 " + NV_INDEX + " " + NV_INDEX + " " + PW + " 0008 7638362074706d21 0000")), 0);
    await first.emulator.destroy();
    const second = await machine({ url: STORE, disk_option: "read_write" });
    tpm = crb(second.cpu);
    assert.equal(code(tpm.command(STARTUP)), 0);
    const read = tpm.command("8002 00000000 0000014e " + NV_INDEX + " " + NV_INDEX + " " + PW + " 0008 0000");
    assert.equal(code(read), 0);
    assert.equal(read.subarray(read.length - 13, read.length - 5).toString(), "v86 tpm!");
    first = second;
});

await step("a snapshot: the PCRs come back; a reset is the TPM's", async () => {
    const data = crypto.randomBytes(32);
    assert.equal(code(tpm.command("8002 00000000 00000182 00000010 " + PW + " 00000001 000b " + data.toString("hex"))), 0);
    const state = await first.emulator.save_state();
    // (the platform reset: the TPM wants Startup again)
    first.emulator.restart();
    assert.equal(code(tpm.command("8001 00000000 0000017e 00000001 000b 03 000001")), 0x100, "TPM_RC_INITIALIZE");
    await first.emulator.restore_state(state);
    const read = tpm.command("8001 00000000 0000017e 00000001 000b 03 000001");
    assert.equal(code(read), 0);
    assert.deepEqual(read.subarray(read.length - 32), crypto.createHash("sha256").update(Buffer.concat([Buffer.alloc(32), data])).digest());
    // (a change to the store since: the snapshot no longer fits it)
    assert.equal(code(tpm.command("8002 00000000 00000137 " + NV_INDEX + " " + NV_INDEX + " " + PW + " 0008 6368616e67656421 0000")), 0);
    await assert.rejects(first.emulator.restore_state(state), /tpm_state/);
    await first.emulator.destroy();
});

await step("a damaged store is refused; a store of zeros is a new TPM", async () => {
    const damaged = Buffer.alloc(512 * 1024);
    damaged.write("garbage", 100);
    fs.writeFileSync(directory + "damaged.img", damaged);
    const emulator = new V86({
        bios: { url: ROOT + "bios/seabios.bin" },
        vga_bios: { url: ROOT + "bios/vgabios.bin" },
        memory_size: 64 * 1024 * 1024, graphics_adapter: "bochs_vga", machine_type: MACHINE, acpi: true, net_device: { type: "none" },
        tpm: { version: "2.0", state: { url: directory + "damaged.img", disk_option: "read_write" } },
        autostart: false, log_level: 0,
    });
    const error = await new Promise(resolve => {
        emulator.add_listener("emulator-error", resolve);
        emulator.add_listener("emulator-ready", () => resolve(null));
    });
    assert.match(String(error && error.message), /damaged/);
    // (in memory: a new TPM, without the NV index)
    const fresh = await machine(undefined);
    tpm = crb(fresh.cpu);
    assert.equal(code(tpm.command(STARTUP)), 0);
    assert.notEqual(code(tpm.command("8002 00000000 0000014e " + NV_INDEX + " " + NV_INDEX + " " + PW + " 0008 0000")), 0);
    await fresh.emulator.destroy();
});

console.log("PASS: " + passed + " steps");
process.exit(0);
