// C4 and C5 in the 32-bit interpreter by mode (docs/simd-xsave-plan.md P1c):
// a VEX prefix in protected mode when the next byte would be a register
// ModRM byte, otherwise LES/LDS; real and virtual-8086 mode have no VEX, and
// there the register form of LES/LDS is #UD. Prefixes before VEX are #UD at
// the first VEX byte, and fetch faults on the bytes the decoder needs come
// before #UD (decode::tests and x64::decode::tests check the other decoders).
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";

const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path: process.argv[2] || "build/v86-ir-test.wasm", memory_size: 32 << 20,
    bios: { buffer: Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer },
    disable_keyboard: true, disable_mouse: true, disable_speaker: true, net_device: { type: "none" }, autostart: false });
try
{
    await new Promise(r => vm.add_listener("emulator-loaded", r));
    const cpu = vm.v86.cpu, e = cpu.wm.exports, mem = cpu.mem8, words = new Uint32Array(e.memory.buffer);
    const view = new DataView(mem.buffer, mem.byteOffset), set32 = (a, x) => view.setUint32(a, x, true), get32 = a => view.getUint32(a, true);
    vm.run();
    const deadline = performance.now() + 10000;
    while(view.getUint16(0x500, true) !== 0xCAFE) { assert(performance.now() < deadline); await new Promise(r => setTimeout(r, 1)); }
    await vm.stop();
    const cr0 = cpu.cr[0], STACK = 0x90000, DATA = 0x7000, ABSENT = 0x9000;
    // a handler per vector: #UD, #GP, #PF
    const HANDLERS = { 6: 0x18000, 13: 0x18100, 14: 0x18200 };
    const descriptor = (index, base, limit, access, flags) => {
        set32(0x3000 + index * 8, limit & 65535 | base << 16);
        set32(0x3004 + index * 8, base & 0xFF000000 | base >>> 16 & 255 | access << 8 | limit & 0xF0000 | flags << 20);
    };
    /** `bytes` at `pc` in `mode`: "real", "vm86", "protected16" or "protected32" */
    function reset(mode, bytes, pc)
    {
        e.ir_test_set_cr0(mode === "real" ? cr0 & ~0x80000001 : cr0 | 0x10000);
        cpu.cr[2] = 0xBADF000; cpu.cr[3] = 0x12000;
        descriptor(0, 0, 0, 0, 0); descriptor(1, 0, 0xFFFFF, 0x9B, 12); descriptor(2, 0, 0xFFFFF, 0x93, 12);
        descriptor(3, 0, 0xFFFF, 0x9B, 0); descriptor(7, 0x4000, 0x67, 0x89, 0);
        cpu.gdtr_offset[0] = 0x3000; cpu.gdtr_size[0] = 63;
        const real = mode === "real" || mode === "vm86";
        cpu.sreg.set(real ? [0, 0, 0, 0, 0, 0] : [16, mode === "protected16" ? 0x18 : 8, 16, 16, 16, 16]);
        cpu.segment_offsets.fill(0, 0, 6); cpu.segment_is_null.fill(0, 0, 6);
        cpu.segment_limits.fill(real ? 0xFFFF : 0xFFFFFFFF, 0, 6);
        cpu.segment_access_bytes.set(real && mode === "vm86" ? [0xF3, 0xFB, 0xF3, 0xF3, 0xF3, 0xF3] : [0x93, 0x9B, 0x93, 0x93, 0x93, 0x93]);
        cpu.is_32[0] = +(mode === "protected32"); cpu.stack_size_32[0] = +!real;
        words[612 >> 2] = mode === "vm86" ? 3 : 0;
        cpu.reg32.set([0x11111111, 0x22222222, 0x33333333, 0x44444444, STACK, 0x55555555, 0x66666666, 0x77777777]);
        cpu.flags[0] = mode === "vm86" ? 0x20002 | 3 << 12 : 2; cpu.flags_changed[0] = 0;
        // the IDT, or the real-mode vector table, and the TSS's ring-0 stack
        if(real && mode === "real")
        {
            cpu.idtr_offset[0] = 0; cpu.idtr_size[0] = 0x3FF;
            for(const [vector, handler] of Object.entries(HANDLERS)) set32(vector * 4, handler >>> 4 << 16);
        }
        else
        {
            cpu.idtr_offset[0] = 0x2000; cpu.idtr_size[0] = 0x7FF;
            for(const [vector, handler] of Object.entries(HANDLERS))
            {
                set32(0x2000 + vector * 8, 8 << 16 | handler & 65535); set32(0x2004 + vector * 8, handler & 0xFFFF0000 | 0x8E00);
            }
            // (TR)
            cpu.segment_offsets[6] = 0x4000; cpu.segment_limits[6] = 0x67; cpu.sreg[6] = 0x38; cpu.tss_size_32[0] = 1;
            set32(0x4004, STACK); set32(0x4008, 16);
        }
        // the first 4 MiB mapped for user and supervisor, but ABSENT
        set32(0x12000, 0x13007);
        for(let page = 0; page < 1024; page++) set32(0x13000 + page * 4, page === ABSENT >>> 12 ? 0 : page * 4096 | 7);
        mem.fill(0xCC, STACK - 64, STACK + 16);
        // far pointers: 32-bit at DATA, 16-bit at DATA + 16
        set32(DATA, 0x12345678); set32(DATA + 4, 0x10); set32(DATA + 16, 0x105678);
        mem.fill(0x90, pc - 16, pc + 32);
        mem.set(bytes, pc);
        cpu.instruction_pointer[0] = pc; cpu.in_hlt[0] = 0;
        e.full_clear_tlb(); e.update_state_flags();
    }
    /** Step once: the vector delivered and the address it reports, or "done" and the next address */
    function step(mode, bytes, pc = 0x8000)
    {
        reset(mode, bytes, pc);
        e.ir_test_step();
        const ip = cpu.instruction_pointer[0] >>> 0;
        const vector = Object.keys(HANDLERS).find(v => HANDLERS[v] === ip);
        if(vector === undefined) return { done: ip };
        // (#GP and #PF push an error code; the real-mode frame is 16-bit)
        const frame = mode === "real" ? (cpu.reg32[4] & 0xFFFF) : cpu.reg32[4] >>> 0;
        const eip = mode === "real" ? view.getUint16(frame, true) : get32(frame + (vector === "6" ? 0 : 4));
        return { vector: +vector, eip, cr2: cpu.cr[2] >>> 0 };
    }
    const ud = pc => ({ vector: 6, eip: pc });
    let count = 0;
    const expect = (mode, bytes, expected, pc = 0x8000) => {
        const result = step(mode, bytes, pc);
        if(expected.vector !== 14) delete result.cr2;
        assert.deepEqual(result, expected, `${mode} ${bytes.map(b => b.toString(16)).join(" ")} at ${pc.toString(16)}`);
        count++;
    };

    for(const mode of ["protected32", "protected16"])
    {
        // VEX forms without their features (this machine's default: no AVX,
        // AVX2 or BMI1), a reserved map, an opcode without rows
        for(const bytes of [[0xC5, 0xF8, 0x77], [0xC4, 0xE2, 0x79, 0x18, 0xC1], [0xC4, 0xE2, 0x78, 0xF2, 0xC1],
            [0xC4, 0xC0, 0x78, 0x77], [0xC5, 0xF8, 0x00]])
        {
            expect(mode, bytes, ud(0x8000));
        }
        // 66, F2, F3 and LOCK before VEX
        for(const prefix of [0x66, 0xF2, 0xF3, 0xF0]) expect(mode, [prefix, 0xC5, 0xF8, 0x77], ud(0x8000));
        // a memory ModRM byte: LES/LDS
        const les = mode === "protected32" ? [0xC4, 0x05, 0, 0x70, 0, 0] : [0xC4, 0x06, 0x10, 0x70];
        expect(mode, les, { done: 0x8000 + les.length });
        assert.equal(cpu.sreg[0], 0x10);
        assert.equal(cpu.reg32[0] >>> 0, mode === "protected32" ? 0x12345678 : 0x11115678);
        // fetch faults on the bytes the decoder reads come first: VEX's
        // second byte and opcode, and its ModRM byte, but not where a
        // prefix makes it #UD at the first VEX byte
        expect(mode, [0xC4, 0xE2, 0x79, 0x18, 0xC1], { vector: 14, eip: ABSENT - 2, cr2: ABSENT }, ABSENT - 2);
        expect(mode, [0xC4, 0xE2, 0x79, 0x18, 0xC1], { vector: 14, eip: ABSENT - 4, cr2: ABSENT }, ABSENT - 4);
        expect(mode, [0x66, 0xC4, 0xE2, 0x79, 0x18], ud(ABSENT - 3), ABSENT - 3);
        expect(mode, [0xC5, 0xF8, 0x77], ud(ABSENT - 3), ABSENT - 3);
    }
    for(const mode of ["real", "vm86"])
    {
        // the register forms of LES and LDS, after the ModRM byte
        expect(mode, [0xC4, 0xC0, 0x78, 0x77], ud(0x8000));
        expect(mode, [0xC5, 0xF8, 0x77], ud(0x8000));
        expect(mode, [0xC4, 0xE2, 0x79, 0x18, 0xC1], ud(0x8000));
        expect(mode, [0xC4, 0x06, 0x10, 0x70], { done: 0x8004 });
        assert.equal(cpu.sreg[0], 0x10);
        assert.equal(cpu.segment_offsets[0], 0x100);
    }
    // ... and only two bytes are read in virtual-8086 mode, which pages
    expect("vm86", [0xC5, 0xF8, 0x77], ud(ABSENT - 2), ABSENT - 2);
    console.log(`PASS: ${count} C4/C5 decodes by mode: VEX or LES/LDS, prefixes before VEX, fetch faults before #UD`);
}
finally
{
    await vm.destroy();
}
