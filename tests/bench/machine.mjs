// The benchmark machines (tests/bench/run.mjs, tools/replay_record.mjs): PE
// images, a machine booted for an arm's ISA, and one timed run.
import fs from "node:fs";
import assert from "node:assert/strict";
import { V86 } from "../../build/libv86.mjs";
import { STATE_OFFSETS as OWN_STATE_OFFSETS } from "../../src/state_layout.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Minimal PE loader: sections at ImageBase + VirtualAddress, zero-filled to
// VirtualSize. Writable sections are restored before every run. PE32 and
// PE32+ (linked below 4 GiB).
export function load_pe(file) {
    const b = fs.readFileSync(file), pe = b.readUInt32LE(0x3C);
    assert.equal(b.readUInt32LE(pe), 0x4550, `${file}: not a PE image`);
    const sections = b.readUInt16LE(pe + 6), optional = pe + 24, table = optional + b.readUInt16LE(pe + 20);
    const pe32plus = b.readUInt16LE(optional) === 0x20B;
    const base = pe32plus ? Number(b.readBigUInt64LE(optional + 24)) : b.readUInt32LE(optional + 28);
    assert(base < 2 ** 32 - 0x1000000, `${file}: image base above 4 GiB`);
    const entry = base + b.readUInt32LE(optional + 16);
    const parts = [];
    for(let i = 0; i < sections; i++) {
        const s = table + 40 * i;
        const virtual_size = b.readUInt32LE(s + 8), address = base + b.readUInt32LE(s + 12);
        const raw_size = b.readUInt32LE(s + 16), raw = b.readUInt32LE(s + 20), flags = b.readUInt32LE(s + 36);
        const bytes = new Uint8Array(Math.max(virtual_size, raw_size));
        bytes.set(b.subarray(raw, raw + Math.min(raw_size, bytes.length)));
        parts.push({ name: b.toString("latin1", s, s + 8).replace(/\0+$/, ""), address, bytes, writable: !!(flags & 0x80000000) });
    }
    return { entry, parts };
}

/**
 * The boot images of the manifest (build/bench/manifest.json) by ISA: the
 * benchmark BIOS for i686, the long-mode boot for x86_64 (with 4 KiB pages
 * if `small_pages`) and its compatibility-mode variant for compat32
 */
export function boot_images(manifest, small_pages = false) {
    const read = file => file && fs.readFileSync(file);
    return {
        i686: read(manifest.boot),
        x86_64: read(small_pages ? manifest.boot64_small_pages : manifest.boot64),
        compat32: read(manifest.boot_compat),
    };
}

// (a benchmark's cpu_features: the optional CPU features its guest uses;
// cpu_type: the x86-64 profile for its own ones, such as LZCNT. An x86_64
// arm boots the long-mode boot with the x86-64 profile. `extra`: JIT
// switches over the arm's; `ir_setup`: [export, value] calls after boot.)
export async function create(arm, bench, boots, { extra = {}, ir_setup = [] } = {}) {
    const jit_switches = { ...arm.switches, ...extra };
    const boot = boots[arm.isa];
    assert(boot, `no boot image for ${arm.isa}`);
    // (an arm of another tree brings its own V86 and state layout: run.mjs
    // --baseline-root)
    const vm = new (arm.V86 || V86)({
        graphics_adapter: "bochs_vga",
        wasm_path: arm.wasm, memory_size: 128 << 20,
        ...bench.cpu_features ? { cpu_features: bench.cpu_features, cpu_features_unreleased: !!bench.cpu_features_unreleased } : {},
        ...arm.isa === "i686" ? { ...bench.cpu_type ? { cpu_type: bench.cpu_type } : {}, bios: { buffer: Uint8Array.from(boot).buffer } } :
            { cpu_type: "x86_64", multiboot: { buffer: Uint8Array.from(boot).buffer } },
        ...arm.interpreted ? { disable_jit: true } : {},
        disable_keyboard: true, disable_mouse: true,
        disable_speaker: true, net_device: { type: "none" }, autostart: false,
        ...Object.keys(jit_switches).length ? { jit_switches } : {},
    });
    await new Promise((resolve, reject) => { vm.add_listener("emulator-loaded", resolve); vm.add_listener("emulator-error", reject); });
    const cpu = vm.v86.cpu;
    const view = () => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
    vm.run();
    const end = performance.now() + 15000;
    while(view().getUint32(0x500, true) !== 0xCAFE) { assert(performance.now() < end, "benchmark BIOS did not start"); await sleep(1); }
    await vm.stop();
    for(const [name, value] of ir_setup) {
        assert.equal(typeof cpu.wm.exports[name], "function", `--ir-setup: no export ${name}`);
        assert(cpu.wm.exports[name](Number(value)), `--ir-setup: ${name}(${value}) refused`);
    }
    return { vm, cpu, e: cpu.wm.exports, view, arm };
}

/** One run of `image` with `iterations`: { ms, instructions (the budget counter), checksum } */
export async function execute(machine, image, iterations) {
    const { vm, cpu, e, view } = machine;
    const STATE_OFFSETS = machine.arm.state_offsets || OWN_STATE_OFFSETS;
    for(const part of image.parts) if(part.writable || !machine.loaded) cpu.mem8.set(part.bytes, part.address);
    machine.loaded = true;
    const v = view();
    v.setUint32(0x600, iterations, true); v.setUint32(0x604, 0, true); v.setUint32(0x608, 0, true);
    cpu.reg32.fill(0);
    if(machine.arm.isa !== "i686") {
        // (the upper halves, R8-R15 and RIP's upper half: the 64-bit register file)
        const words = (offset, n) => new Uint32Array(cpu.wasm_memory.buffer, cpu.state_base + offset, n);
        words(STATE_OFFSETS.x64_gpr_hi, 16).fill(0);
        words(STATE_OFFSETS.x64_gpr_ext_lo, 8).fill(0);
        words(STATE_OFFSETS.x64_rip_hi, 1)[0] = 0;
    }
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0; cpu.in_hlt[0] = 0; cpu.instruction_pointer[0] = image.entry;
    e.fpu_discard_cache(); cpu.fpu_st.fill(0); cpu.fpu_stack_empty[0] = 255; cpu.fpu_stack_ptr[0] = 0;
    e.set_control_word(0x37F); cpu.fpu_status_word[0] = 0; cpu.mxcsr[0] = 0x1F80;
    e.update_state_flags();
    const counter = new Uint32Array(e.memory.buffer);
    counter[664 >> 2] = 0;
    const started = performance.now();
    vm.run();
    const limit = started + 120000;
    while(!cpu.in_hlt[0]) { assert(performance.now() < limit, "benchmark timeout"); await sleep(0); }
    const ms = performance.now() - started;
    await vm.stop();
    const status = view().getUint32(0x608, true);
    if(status !== 1) throw new Error(status >>> 31 ? `guest exception ${status & 31} at ${view().getUint32(0x60C, true).toString(16)}` : `guest did not finish (${status})`);
    return { ms, instructions: new Uint32Array(e.memory.buffer)[664 >> 2] >>> 0, checksum: view().getUint32(0x604, true) };
}
