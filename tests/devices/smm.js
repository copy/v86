#!/usr/bin/env node

// System management mode on the Q35 machine (docs/q35.md), with
// SeaBIOS: its SMM setup (SMBASE relocated to 0xA0000, SMRAM
// closed with G_SMRAME), the state save area in QEMU's 32-bit layout, SMRAM
// visibility (the VGA window outside SMM, RAM in SMM and with D_OPEN), an SMI
// with a handler of the test's own that only executes RSM (the state comes
// back), an SMI in SMM (latched until RSM), SMIs from the local APIC (an IPI,
// an MSI), snapshots (also in SMM), TSEG (all ones outside SMM, RAM in it;
// QEMU's extended TSEG), high SMRAM (H_SMRAME, also with SMBASE there),
// D_CLS, the auto HALT restart field, D_LCK and the LPC's SMI_LOCK. Then the x86-64 CPU profile:
// SeaBIOS with QEMU's 64-bit save area. (An SMI in long mode:
// tests/x64/smm_long_mode.mjs.)

import assert from "node:assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const { STATE_OFFSETS } = await import("../../src/state_layout.js");

let failed = 0, passed = 0;
function test(name, f)
{
    try
    {
        f();
        passed++;
        console.log("ok - " + name);
    }
    catch(e)
    {
        failed++;
        console.log("FAIL - " + name);
        console.log(e);
    }
}

/** A Q35 machine with SeaBIOS, stopped once SeaBIOS found nothing to boot */
async function boot(options = {})
{
    const emulator = new V86({
        graphics_adapter: "bochs_vga",
        bios: { url: __dirname + "/../../bios/seabios.bin" },
        vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
        machine_type: "q35",
        memory_size: 32 * 1024 * 1024,
        autostart: true,
        screen_dummy: true,
        log_level: 0,
        ...options,
    });
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    const deadline = Date.now() + 60000;
    while(!/No bootable device/.test(emulator.screen_adapter.get_text_screen().join("\n")))
    {
        assert.ok(Date.now() < deadline, "SeaBIOS boots");
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    await emulator.stop();
    return emulator;
}

let emulator = await boot();
let cpu = emulator.v86.cpu;
const pci = () => cpu.devices.pci;

const state32 = offset => new Uint32Array(cpu.wasm_memory.buffer, cpu.state_base + offset, 1);
const smbase = () => state32(STATE_OFFSETS.smbase)[0] >>> 0;
const in_smm = () => !!cpu.smm_active();
const smi_pending = () => !!cpu.apic_core_smi_pending(0);
const ram32 = address => (cpu.mem8[address] | cpu.mem8[address + 1] << 8 | cpu.mem8[address + 2] << 16 | cpu.mem8[address + 3] << 24) >>> 0;
const ram64 = address => BigInt(ram32(address)) | BigInt(ram32(address + 4)) << 32n;
const MCH_SMRAM = 0x9D, MCH_ESMRAMC = 0x9E, MCH_EXT_TSEG_MBYTES = 0x50;

// One instruction (the handler's RSM, after an SMI the slice takes first). A
// slice ends before its first instruction when the IR scheduler submits a
// compile at its start (src/rust/cpu/cpu.rs run_cpu_slice), so that the host
// can install the code: then the next slice runs it. (After a boot a code page
// may just have reached its threshold.)
function step()
{
    if(cpu.run_cpu_slice(1)) return;
    assert.equal(cpu.get_jit_info().ir?.pending, 1, "the slice yielded to a compile");
    assert.equal(cpu.run_cpu_slice(1), 1, "the next slice runs the instruction");
}

test("SeaBIOS's SMM setup: SMBASE relocated to 0xA0000, SMI_EN.APMC_EN, SMRAM closed with G_SMRAME", () => {
    assert.equal(smbase(), 0xA0000);
    assert.ok(!in_smm());
    assert.equal(pci().config_read(0, MCH_SMRAM, 1), 0x0A, "G_SMRAME, C_BASE_SEG; D_OPEN clear");
    assert.ok(cpu.devices.acpi.smi_en & 1 << 5, "APMC_EN");
    assert.deepEqual(Array.from(cpu.mem8.subarray(0xA8000, 0xA8003)), [0x8C, 0xC8, 0xEA], "SeaBIOS's entry_smi in SMRAM");
});

test("the state save area of the last SMI (call32_smm's return): QEMU's 32-bit layout", () => {
    // (SeaBIOS's handler put the 16-bit state there that RSM went back to)
    const area = 0xA8000;
    assert.equal(ram32(area + 0x7EFC), 0x00020000, "revision: SMBASE relocation, 32-bit layout");
    assert.equal(ram32(area + 0x7EF8), 0xA0000, "SMBASE");
    assert.equal(ram32(area + 0x7FFC) & 1, 0, "CR0: back to real mode");
    assert.equal(ram32(area + 0x7FAC), 0xF000, "CS selector: SeaBIOS's 16-bit code");
    assert.equal(ram32(area + 0x7F84 + 12 + 8), 0xF0000, "CS base");
});

test("SMRAM visibility: outside SMM the VGA window, with D_OPEN RAM", () => {
    assert.notEqual(cpu.read32s(0xAFEFC) >>> 0, 0x00020000, "closed: the guest sees the VGA window");
    pci().config_write(0, MCH_SMRAM, 1, 0x4A);
    assert.equal(cpu.read32s(0xAFEFC) >>> 0, 0x00020000, "D_OPEN: RAM");
    pci().config_write(0, MCH_SMRAM, 1, 0x0A);
    assert.notEqual(cpu.read32s(0xAFEFC) >>> 0, 0x00020000);
});

// an SMI with a handler that only executes RSM
const saved_handler = cpu.mem8.slice(0xA8000, 0xA8002);
cpu.mem8.set([0x0F, 0xAA], 0xA8000);
cpu.reg32[3] = 0x12345678; // EBX
const before = { eip: cpu.instruction_pointer[0], eflags: cpu.get_eflags(), cr0: cpu.cr[0], cs: cpu.sreg[1], cs_base: cpu.segment_offsets[1] };
test("an SMI: the core enters SMM at SMBASE + 0x8000, in real mode with 4 GiB segments; SMRAM is RAM there", () => {
    cpu.smi();
    assert.ok(in_smm(), "taken at once (between instructions)");
    assert.ok(!smi_pending());
    assert.equal(cpu.instruction_pointer[0] >>> 0, 0xA8000);
    assert.equal(cpu.segment_offsets[1] >>> 0, 0xA0000, "CS base: SMBASE");
    assert.equal(cpu.sreg[1], 0xA000, "CS selector");
    assert.equal(cpu.segment_limits[3] >>> 0, 0xFFFFFFFF, "DS: 4 GiB");
    assert.equal(cpu.cr[0] & 0x80000001, 0, "no protected mode, no paging");
    assert.equal(cpu.get_eflags() & 0x200, 0, "interrupts off");
    assert.equal(cpu.read32s(0xA8000) & 0xFFFF, 0xAA0F, "in SMM the CPU sees SMRAM");
    assert.equal(ram32(0xAFFF0), before.eip - before.cs_base >>> 0, "EIP saved");
    assert.equal(ram32(0xAFFDC), 0x12345678, "EBX saved");
});
test("an SMI in SMM is latched, not nested", () => {
    cpu.smi();
    assert.ok(in_smm());
    assert.ok(smi_pending(), "pending until RSM");
    assert.equal(cpu.instruction_pointer[0] >>> 0, 0xA8000, "the handler did not restart");
});
// (one instruction: the RSM)
step();
test("RSM: out of SMM, the state back (registers, EFLAGS, CR0), SMBASE kept", () => {
    assert.ok(!in_smm());
    assert.equal(cpu.reg32[3] >>> 0, 0x12345678, "EBX");
    assert.equal(cpu.instruction_pointer[0], before.eip, "EIP: where the SMI came");
    assert.equal(cpu.get_eflags(), before.eflags, "EFLAGS");
    assert.equal(cpu.cr[0] >>> 0, before.cr0 >>> 0, "CR0");
    assert.equal(cpu.sreg[1], before.cs, "CS");
    assert.equal(smbase(), 0xA0000);
    assert.notEqual(cpu.read32s(0xA8000) & 0xFFFF, 0xAA0F, "the VGA window again");
    assert.ok(smi_pending(), "the latched SMI waits for the next instruction boundary");
});
cpu.reg32[3] = 0x87654321;
// the latched SMI at the start of the slice, then its handler's RSM
step();
test("the latched SMI is taken after RSM", () => {
    assert.ok(!smi_pending());
    assert.ok(!in_smm(), "(and its handler returned)");
    assert.equal(ram32(0xAFFDC), 0x87654321, "EBX saved by the second SMI");
    assert.equal(cpu.instruction_pointer[0], before.eip);
});

test("SMIs from the local APIC: an IPI to self, an MSI (delivery mode SMI)", () => {
    // ICR: delivery mode SMI, shorthand self
    cpu.write32(0xFEE00310, 0);
    cpu.write32(0xFEE00300, 2 << 8 | 1 << 18);
    assert.ok(in_smm(), "IPI");
    assert.equal(cpu.instruction_pointer[0] >>> 0, 0xA8000);
    step();
    assert.ok(!in_smm());
    assert.ok(cpu.apic_msi(0xFEE00000, 2 << 8), "MSI accepted");
    assert.ok(in_smm(), "MSI");
    step();
    assert.ok(!in_smm());
    assert.equal(cpu.instruction_pointer[0], before.eip);
});

// a snapshot in SMM, with an SMI latched
cpu.smi();
cpu.smi();
const in_smm_state = await emulator.save_state();
step();
step();
assert.ok(!in_smm() && !smi_pending());
await emulator.restore_state(in_smm_state);
test("snapshot in SMM: SMM and the latched SMI come back", () => {
    assert.ok(in_smm());
    assert.ok(smi_pending());
    step();
    assert.ok(!in_smm(), "RSM");
    assert.ok(smi_pending());
    step();
    assert.ok(!in_smm() && !smi_pending(), "the latched SMI, and its RSM");
    assert.equal(cpu.instruction_pointer[0], before.eip);
});

// TSEG: the top of the 32 MiB of RAM
const TOP = 32 << 20;
test("ESMRAMC: H_SMRAME, TSEG_SZ, T_EN writable, the cache bits read as one; extended TSEG: 16 MiB", () => {
    assert.equal(pci().config_read(0, MCH_ESMRAMC, 1), 0x38);
    pci().config_write(0, MCH_ESMRAMC, 1, 0x00);
    assert.equal(pci().config_read(0, MCH_ESMRAMC, 1), 0x38);
    pci().config_write(0, MCH_ESMRAMC, 1, 0xFF);
    assert.equal(pci().config_read(0, MCH_ESMRAMC, 1), 0xBF);
    pci().config_write(0, MCH_ESMRAMC, 1, 0x38);
    assert.equal(pci().config_read(0, MCH_EXT_TSEG_MBYTES, 2), 0xFFFF, "before the query");
    pci().config_write(0, MCH_EXT_TSEG_MBYTES, 2, 0xFFFF);
    assert.equal(pci().config_read(0, MCH_EXT_TSEG_MBYTES, 2), 16, "the size in MiB");
});
test("TSEG (T_EN, 1 MiB): outside SMM all ones and writes dropped, in SMM RAM", () => {
    const base = TOP - (1 << 20);
    cpu.mem8.set([0x11, 0x22, 0x33, 0x44], base);
    cpu.mem8.set([0x55, 0x66, 0x77, 0x88], TOP - 4);
    cpu.mem8.set([0x99, 0xAA], base - 2);
    pci().config_write(0, MCH_ESMRAMC, 1, 0x39);
    assert.equal(cpu.read32s(base) >>> 0, 0xFFFFFFFF, "all ones");
    assert.equal(cpu.read8(TOP - 1), 0xFF, "to the top");
    assert.equal(cpu.read32s(base - 2) >>> 0, 0xFFFFAA99, "across its start: RAM below");
    cpu.write32(base, 0xDEADBEEF);
    cpu.write16(base - 1, 0x5A5A);
    assert.equal(ram32(base), 0x44332211, "a write is dropped");
    assert.equal(cpu.mem8[base - 1], 0x5A, "(the byte below it is written)");
    // (the handler of the test: RSM)
    cpu.smi();
    assert.ok(in_smm());
    assert.equal(cpu.read32s(base) >>> 0, 0x44332211, "RAM in SMM");
    assert.equal(cpu.read32s(TOP - 4) >>> 0, 0x88776655);
    assert.equal(cpu.read32s(base - 2) >>> 0, 0x22115A99, "across its start");
    cpu.write32(base, 0xCAFEF00D);
    cpu.write16(base - 1, 0xA5A5);
    assert.equal(ram32(base), 0xCAFEF0A5, "written in SMM");
    step();
    assert.ok(!in_smm());
    assert.equal(cpu.read32s(base) >>> 0, 0xFFFFFFFF, "hidden again");
});
test("TSEG: G_SMRAME clear: no TSEG; TSEG_SZ 11: the extended size", () => {
    pci().config_write(0, MCH_SMRAM, 1, 0x02);
    assert.equal(cpu.read32s(TOP - (1 << 20)) >>> 0, 0xCAFEF0A5, "without G_SMRAME: RAM");
    pci().config_write(0, MCH_SMRAM, 1, 0x0A);
    pci().config_write(0, MCH_ESMRAMC, 1, 0x3F);
    assert.equal(cpu.read32s(TOP - (16 << 20)) >>> 0, 0xFFFFFFFF, "16 MiB");
    assert.notEqual(cpu.read32s(TOP - (16 << 20) - 4) >>> 0, 0xFFFFFFFF);
    pci().config_write(0, MCH_ESMRAMC, 1, 0x38);
    assert.equal(cpu.read32s(TOP - (1 << 20)) >>> 0, 0xCAFEF0A5, "T_EN clear: RAM");
});

const HIGH_SMRAM = 0xFEDA0000;
test("H_SMRAME: the RAM at 0xFEDA0000 instead (with D_OPEN for everyone, in SMM), the VGA window at 0xA0000", () => {
    pci().config_write(0, MCH_ESMRAMC, 1, 0xB8);
    assert.equal(pci().config_read(0, MCH_ESMRAMC, 1), 0xB8);
    assert.notEqual(cpu.read32s(HIGH_SMRAM + 0x8000) & 0xFFFF, 0xAA0F, "outside SMM: not SMRAM");
    pci().config_write(0, MCH_SMRAM, 1, 0x4A);
    assert.equal(cpu.read32s(HIGH_SMRAM + 0x8000) & 0xFFFF, 0xAA0F, "D_OPEN: high SMRAM is the RAM of 0xA0000");
    assert.notEqual(cpu.read32s(0xA8000) & 0xFFFF, 0xAA0F, "and 0xA0000 the VGA window");
    cpu.write8(HIGH_SMRAM + 0x10, 0x5C);
    assert.equal(cpu.mem8[0xA0010], 0x5C, "a write reaches that RAM");
    pci().config_write(0, MCH_SMRAM, 1, 0x0A);
    assert.notEqual(cpu.read32s(HIGH_SMRAM + 0x8000) & 0xFFFF, 0xAA0F, "closed");
});
test("H_SMRAME: SMBASE in high SMRAM, the save area and the handler through it", () => {
    state32(STATE_OFFSETS.smbase)[0] = HIGH_SMRAM;
    cpu.reg32[3] = 0x13579BDF;
    cpu.smi();
    assert.ok(in_smm());
    assert.equal(cpu.segment_offsets[1] >>> 0, HIGH_SMRAM, "CS base: SMBASE");
    assert.equal(cpu.instruction_pointer[0] >>> 0, HIGH_SMRAM + 0x8000);
    assert.equal(cpu.read32s(HIGH_SMRAM + 0x8000) & 0xFFFF, 0xAA0F, "in SMM: high SMRAM");
    assert.notEqual(cpu.read32s(0xA8000) & 0xFFFF, 0xAA0F, "in SMM with H_SMRAME: 0xA0000 is the VGA window");
    assert.equal(ram32(0xAFFDC), 0x13579BDF, "EBX in the save area, in the RAM of 0xA0000");
    assert.equal(ram32(0xAFEF8), HIGH_SMRAM, "SMBASE in the save area");
    // (the RSM, fetched from high SMRAM)
    step();
    assert.ok(!in_smm());
    assert.equal(cpu.instruction_pointer[0], before.eip);
    assert.equal(cpu.reg32[3] >>> 0, 0x13579BDF);
    assert.equal(smbase(), HIGH_SMRAM);
    pci().config_write(0, MCH_ESMRAMC, 1, 0x38);
    cpu.smi();
    assert.ok(!in_smm(), "high SMRAM off: the save area is nowhere, the SMI is dropped");
    state32(STATE_OFFSETS.smbase)[0] = 0xA0000;
});
test("D_CLS: in SMM, data accesses to the VGA window, instruction fetches to compatible SMRAM", () => {
    pci().config_write(0, MCH_SMRAM, 1, 0x2A);
    assert.equal(pci().config_read(0, MCH_SMRAM, 1), 0x2A);
    cpu.smi();
    assert.ok(in_smm());
    assert.notEqual(cpu.read32s(0xA8000) & 0xFFFF, 0xAA0F, "data: the VGA window");
    step();
    assert.ok(!in_smm(), "the handler's RSM came from SMRAM");
    assert.equal(cpu.instruction_pointer[0], before.eip);
    pci().config_write(0, MCH_SMRAM, 1, 0x0A);
});
test("auto HALT restart (0x7F02): RSM halts again after an SMI in HLT, unless the handler clears it", () => {
    cpu.in_hlt[0] = 1;
    cpu.smi();
    assert.ok(in_smm());
    assert.ok(!cpu.in_hlt[0], "the handler runs");
    assert.equal(ram32(0xAFF00), 0x00010000, "auto HALT restart set, I/O instruction restart (0x7F00) clear");
    step();
    assert.ok(!in_smm());
    assert.ok(cpu.in_hlt[0], "halted again");
    assert.equal(cpu.instruction_pointer[0], before.eip);
    cpu.smi();
    assert.equal(ram32(0xAFF00), 0x00010000);
    cpu.mem8[0xAFF02] = 0;
    step();
    assert.ok(!in_smm() && !cpu.in_hlt[0], "cleared by the handler: on after the HLT");
    cpu.smi();
    assert.equal(ram32(0xAFF00), 0, "an SMI outside HLT: clear");
    cpu.mem8[0xAFF02] = 1;
    step();
    assert.ok(!in_smm() && !cpu.in_hlt[0], "set by the handler without HLT: ignored");
    assert.equal(cpu.instruction_pointer[0], before.eip);
});
cpu.mem8.set(saved_handler, 0xA8000);

pci().config_write(0, MCH_ESMRAMC, 1, 0x39);
const state = await emulator.save_state();
pci().config_write(0, MCH_SMRAM, 1, 0x4A);
pci().config_write(0, MCH_ESMRAMC, 1, 0x38);
state32(STATE_OFFSETS.smbase)[0] = 0x30000;
await emulator.restore_state(state);
test("snapshot: SMBASE, SMRAM closed and TSEG (the MCH's SMRAM controls)", () => {
    assert.equal(smbase(), 0xA0000);
    assert.equal(pci().config_read(0, MCH_SMRAM, 1), 0x0A);
    assert.notEqual(cpu.read32s(0xAFEFC) >>> 0, 0x00020000, "closed again");
    assert.equal(pci().config_read(0, MCH_ESMRAMC, 1), 0x39);
    assert.equal(cpu.read32s(TOP - (1 << 20)) >>> 0, 0xFFFFFFFF, "TSEG");
});

test("D_LCK: D_OPEN, G_SMRAME, D_LCK and ESMRAMC locked until a reset", () => {
    pci().config_write(0, MCH_SMRAM, 1, 0x1A);
    pci().config_write(0, MCH_SMRAM, 1, 0x42);
    assert.equal(pci().config_read(0, MCH_SMRAM, 1), 0x1A, "locked: G_SMRAME stays, D_OPEN stays clear");
    assert.notEqual(cpu.read32s(0xAFEFC) >>> 0, 0x00020000);
    pci().config_write(0, MCH_ESMRAMC, 1, 0x38);
    assert.equal(pci().config_read(0, MCH_ESMRAMC, 1), 0x39, "ESMRAMC");
    assert.equal(cpu.read32s(TOP - (1 << 20)) >>> 0, 0xFFFFFFFF, "TSEG stays");
    cpu.devices.q35.reset();
    assert.equal(pci().config_read(0, MCH_SMRAM, 1), 0x02, "a reset unlocks it");
    assert.equal(pci().config_read(0, MCH_ESMRAMC, 1), 0x38);
    assert.equal(cpu.read32s(TOP - (1 << 20)) >>> 0, 0xCAFEF0A5, "no TSEG");
});

test("GEN_PMCON_1.SMI_LOCK: set until a reset; under it SMI_EN.GBL_SMI_EN does not clear", () => {
    // (the LPC bridge 00:1f.0; SMI_EN at PMBASE + 0x30: OVMF's SmmControl2Dxe checks this)
    const LPC = 0x1F << 3, GEN_PMCON_1 = 0xA0, SMI_LOCK = 0x10;
    // (the PM block decoded at SeaBIOS's PMBASE: a reset turns it off)
    const decode = () => { pci().config_write(LPC, 0x40, 4, 0x601); pci().config_write(LPC, 0x44, 1, 0x80); };
    decode();
    const smi_en_port = 0x600 + 0x30;
    const smi_en = () => cpu.io.port_read32(smi_en_port) >>> 0;
    const before = smi_en();
    cpu.io.port_write32(smi_en_port, before & ~1);
    assert.equal(smi_en() & 1, 0, "without the lock GBL_SMI_EN clears");
    cpu.io.port_write32(smi_en_port, before | 1);
    pci().config_write(LPC, GEN_PMCON_1, 2, SMI_LOCK);
    cpu.io.port_write32(smi_en_port, (before | 1) & ~(1 | 1 << 5));
    assert.equal(smi_en() & 1, 1, "GBL_SMI_EN stays");
    assert.equal(smi_en() & 1 << 5, 0, "the other bits are written (APMC_EN)");
    pci().config_write(LPC, GEN_PMCON_1, 2, 0);
    assert.equal(pci().config_read(LPC, GEN_PMCON_1, 2) & SMI_LOCK, SMI_LOCK, "SMI_LOCK stays");
    cpu.devices.q35.reset();
    assert.equal(pci().config_read(LPC, GEN_PMCON_1, 2) & SMI_LOCK, 0, "a reset clears it");
    decode();
    cpu.io.port_write32(smi_en_port, before & ~1);
    assert.equal(smi_en() & 1, 0, "and GBL_SMI_EN clears again");
    cpu.io.port_write32(smi_en_port, before);
});

emulator.destroy();

// The x86-64 profile: QEMU's 64-bit save area (revision 0x20064), which
// SeaBIOS's handler reads and edits as well
emulator = await boot({ cpu_type: "x86_64" });
cpu = emulator.v86.cpu;
test("x86-64: SeaBIOS's SMM setup and call32_smm with the 64-bit save area", () => {
    const area = 0xA8000;
    assert.equal(smbase(), 0xA0000, "relocated");
    assert.equal(ram32(area + 0x7EFC), 0x00020064, "revision: SMBASE relocation, 64-bit layout");
    assert.equal(ram32(area + 0x7F00), 0xA0000, "SMBASE");
    assert.equal(ram32(area + 0x7F58) & 1, 0, "CR0: back to real mode");
    assert.equal(ram32(area + 0x7E10) & 0xFFFF, 0xF000, "CS selector");
    assert.equal(ram64(area + 0x7E18), 0xF0000n, "CS base");
    assert.equal(ram64(area + 0x7ED0), 0n, "EFER");
});
cpu.mem8.set([0x0F, 0xAA], 0xA8000);
const wide = { rbx: 0x0123456789ABCDEFn, r9: 0xFEDCBA9876543210n, eip: cpu.instruction_pointer[0], cs_base: cpu.segment_offsets[1],
    eflags: cpu.get_eflags(), ds: cpu.sreg[3] };
const gpr_high = new Uint32Array(cpu.wasm_memory.buffer, cpu.state_base + STATE_OFFSETS.x64_gpr_hi, 16);
const gpr_ext = new Uint32Array(cpu.wasm_memory.buffer, cpu.state_base + STATE_OFFSETS.x64_gpr_ext_lo, 8);
cpu.reg32[3] = Number(wide.rbx & 0xFFFFFFFFn);
gpr_high[3] = Number(wide.rbx >> 32n);
gpr_ext[1] = Number(wide.r9 & 0xFFFFFFFFn);
gpr_high[9] = Number(wide.r9 >> 32n);
test("x86-64: an SMI saves the full registers in the 64-bit layout", () => {
    cpu.smi();
    assert.ok(in_smm());
    const area = 0xA8000;
    assert.equal(ram32(area + 0x7EFC), 0x00020064);
    assert.equal(ram64(area + 0x7FE0), wide.rbx, "RBX");
    assert.equal(ram64(area + 0x7FF8 - 9 * 8), wide.r9, "R9");
    assert.equal(ram64(area + 0x7F78), BigInt(wide.eip - wide.cs_base >>> 0), "RIP");
    assert.equal(ram32(area + 0x7F70), wide.eflags >>> 0, "RFLAGS");
    assert.equal(ram32(area + 0x7E30) & 0xFFFF, wide.ds, "DS selector");
    // the handler changes the low byte of RBX's high half
    cpu.mem8[area + 0x7FE4] = 0x5A;
});
step();
test("x86-64: RSM restores the 64-bit registers (and what the handler changed)", () => {
    assert.ok(!in_smm());
    assert.equal(cpu.instruction_pointer[0], wide.eip);
    assert.equal(cpu.get_eflags(), wide.eflags);
    assert.equal(cpu.reg32[3] >>> 0, Number(wide.rbx & 0xFFFFFFFFn));
    assert.equal(gpr_high[3] >>> 0, Number(wide.rbx >> 32n) & ~0xFF | 0x5A, "RBX's high half, as the handler left it");
    assert.equal(gpr_ext[1] >>> 0, Number(wide.r9 & 0xFFFFFFFFn));
    assert.equal(gpr_high[9] >>> 0, Number(wide.r9 >> 32n), "R9's high half");
    assert.equal(cpu.sreg[3], wide.ds);
});
test("x86-64: the auto HALT restart byte (0x7EC9)", () => {
    cpu.in_hlt[0] = 1;
    cpu.smi();
    assert.ok(in_smm());
    assert.equal(cpu.mem8[0xA8000 + 0x7EC9], 1, "auto HALT restart");
    assert.equal(cpu.mem8[0xA8000 + 0x7EC8], 0, "I/O instruction restart");
    step();
    assert.ok(!in_smm() && cpu.in_hlt[0], "halted again");
    cpu.in_hlt[0] = 0;
});
emulator.destroy();

// XSAVE (docs/simd-xsave-plan.md 6.1): an SMI clears CR4, so the handler runs
// with CR4.OSXSAVE 0; XCR0 is not in the save area and stays; RSM restores a
// valid CR4 and shuts down for a reserved bit
emulator = await boot({ cpu_features: ["XSAVE"] });
cpu = emulator.v86.cpu;
{
    const xcr0 = new Uint32Array(cpu.wasm_memory.buffer, cpu.state_base + STATE_OFFSETS.xcr0, 2);
    cpu.cr[4] |= 1 << 18;
    xcr0.set([3, 0]);
    cpu.mem8.set([0x0F, 0xAA], 0xA8000);
    test("XSAVE: in SMM CR4.OSXSAVE is 0, XCR0 stays", () => {
        cpu.smi();
        assert.ok(in_smm());
        assert.equal(cpu.cr[4], 0);
        assert.deepEqual(Array.from(xcr0), [3, 0]);
    });
    step();
    test("XSAVE: RSM restores CR4.OSXSAVE; XCR0 stays", () => {
        assert.ok(!in_smm());
        assert.equal(cpu.cr[4] & 1 << 18, 1 << 18);
        assert.deepEqual(Array.from(xcr0), [3, 0]);
    });
    test("RSM to a reserved CR4 bit: shutdown (here a board reset)", () => {
        const resets = cpu.last_reset ? cpu.last_reset.count : 0;
        cpu.smi();
        assert.ok(in_smm());
        cpu.mem8[0xAFF14 + 2] |= 1 << 6; // CR4 in the 32-bit save area: bit 22
        step();
        assert.equal(cpu.last_reset && cpu.last_reset.count, resets + 1);
        assert.equal(cpu.last_reset.reason, "triple-fault");
    });
}
emulator.destroy();

console.log((failed ? "FAIL" : "PASS") + ": " + passed + " SMM tests passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
