#!/usr/bin/env node
// The XMM registers the x64 page tier keeps in v128 locals within a block
// (docs/jit-unification-plan.md P4.17, x64_xmm_locals) are what the guest
// sees wherever it leaves compiled code: a hot SSE loop, whose block holds
// XMM registers it wrote, loads from a 2 MiB page that is not present until
// the #PF handler maps it (the fault leaves mid-block and the load retries);
// then SSE instructions run single-stepped (TF, a #DB each); a snapshot is
// saved in the middle of the hot loop and restored in another emulator,
// which finishes the run. Every XMM register, the stored results and the
// fault and step counts must equal the interpreter's.
//
// JIT_SWITCHES as usual; the compiled runs set x64_xmm_locals=1 (and the
// other code-quality switches of M5) unless it says otherwise.
import assert from "node:assert/strict";
import { assemble } from "./guest_runner.mjs";
import { long_mode_guest } from "./guest_builder.mjs";
import { with_jit_switches } from "../lib/jit_switches.mjs";

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const RESULTS = 0x300200, PROGRESS = 0x300100, FAULTS = 0x300320, STEPS = 0x300310, IDT = 0x380000;
const SOURCE = 0x5F0000, TARGET = 0x480000, ITERATIONS = 0x2000, PASSES = 64;
const M5 = "x64_xmm_locals=1,x64_hot_inline=1,x64_hot_count=4096,x64_loops=1,x64_sse_fast_check=1,x64_i32_ops=1,x64_fast_lookup=1";

const gate = (vector, label) => `
lea rax, [rel ${label}]
mov [${IDT + vector * 16}], ax
mov word [${IDT + vector * 16 + 2}], 24
mov word [${IDT + vector * 16 + 4}], 0x8E00
shr rax, 16
mov [${IDT + vector * 16 + 6}], ax
shr rax, 16
mov [${IDT + vector * 16 + 8}], eax
mov dword [${IDT + vector * 16 + 12}], 0`;
const body = `
${gate(1, "debug")}
${gate(14, "page_fault")}
lidt [rel idtr]
mov rax, cr4
or eax, 0x600
mov cr4, rax
; the 2 MiB page at 0x600000 (PD entry 3) not present until the #PF handler
and qword [0x202018], ~1
mov rax, cr3
mov cr3, rax
mov eax, 0x01234567
movd xmm1, eax
pshufd xmm1, xmm1, 0
mov eax, 0x00FF00FF
movd xmm2, eax
pshufd xmm2, xmm2, 0x44
pcmpeqd xmm5, xmm5
pxor xmm6, xmm6
pxor xmm7, xmm7
mov r8d, ${PASSES}
pass:
mov rsi, ${SOURCE}
mov rdi, ${TARGET}
mov ecx, ${ITERATIONS}
hot:
movdqa xmm0, [rsi]
paddd xmm0, xmm1
pxor xmm2, xmm0
movdqa xmm3, xmm2
pshufd xmm4, xmm3, 0x1B
paddq xmm5, xmm4
psubw xmm6, xmm0
pand xmm7, xmm6
por xmm7, xmm3
movdqa [rdi], xmm5
add rsi, 16
add rdi, 16
dec ecx
jnz hot
mov [${PROGRESS}], r8d
dec r8d
jnz pass
; single-stepped SSE: a #DB after each instruction
pushfq
or qword [rsp], 0x100
popfq
paddd xmm1, xmm2
pxor xmm3, xmm1
movdqa xmm7, xmm3
pshufd xmm6, xmm7, 0x4E
pushfq
and qword [rsp], ~0x100
popfq
${[0, 1, 2, 3, 4, 5, 6, 7].map(r => `movdqu [${RESULTS + r * 16}], xmm${r}`).join("\n")}
`;
const data = `
debug:
inc dword [${STEPS}]
iretq
page_fault:
inc dword [${FAULTS}]
or qword [0x202018], 1
push rax
mov rax, cr3
mov cr3, rax
pop rax
add rsp, 8
iretq
align 8
idtr: dw 4095
dq ${IDT}
`;
const directory = assemble("xmm-state", long_mode_guest(body, data));

const pattern = Uint8Array.from({ length: ITERATIONS * 16 }, (_, i) => (i * 37 + (i >> 9) * 11) & 255);
const MAGIC = 0x300000;
const done = cpu => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(MAGIC, true) === 0xC064C064;
const outcome = cpu => ({
    xmm: Buffer.from(cpu.mem8.slice(RESULTS, RESULTS + 128)).toString("hex"),
    stores: Buffer.from(cpu.mem8.slice(TARGET, TARGET + ITERATIONS * 16)).toString("base64"),
    faults: new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(FAULTS, true),
    steps: new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(STEPS, true),
});
async function machine(jit)
{
    const options = { graphics_adapter: "bochs_vga", multiboot: { url: directory + "guest.bin" }, memory_size: 32 << 20, acpi: true,
        disable_jit: !jit, autostart: false, log_level: 0, net_device: { type: "none" },
        ...(jit ? { ir_sync_publication: true, jit_switches: Object.fromEntries((process.env.JIT_SWITCHES || M5).split(",").filter(Boolean).map(kv => { const [k, v] = kv.split("="); return [k, +v]; })) } : {}) };
    const emulator = new V86(jit ? options : with_jit_switches(options));
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    return emulator;
}
/** Run until `until` (or the end), within `timeout` ms */
function run(emulator, until, timeout = 120000)
{
    const cpu = emulator.v86.cpu, deadline = performance.now() + timeout;
    while(!done(cpu) && !until(cpu))
    {
        assert.ok(performance.now() < deadline, "guest timed out");
        cpu.run_cores();
    }
}

const reference = await machine(false);
reference.v86.cpu.mem8.set(pattern, SOURCE);
run(reference, () => false);
const expected = outcome(reference.v86.cpu);
await reference.destroy();
assert.equal(expected.faults, 1, "the interpreter took the one #PF");
assert.ok(expected.steps >= 4, "the interpreter single-stepped the SSE instructions: " + expected.steps);

// compiled: a snapshot in the middle of the passes, after the fault
const compiled = await machine(true);
const cpu = compiled.v86.cpu;
cpu.mem8.set(pattern, SOURCE);
const progress = cpu => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(PROGRESS, true);
run(compiled, cpu => progress(cpu) !== 0 && progress(cpu) < PASSES / 2);
assert.ok(!done(cpu), "the snapshot is taken before the end");
const native = cpu.wm.exports.x64_page_stat(1);
assert.ok(native > ITERATIONS * 10 * PASSES / 4, `the page tier ran the hot loop (${native} native instructions)`);
const snapshot = await compiled.save_state();
run(compiled, () => false);
const finished = outcome(cpu);
await compiled.destroy();
assert.deepEqual(finished, expected, "the page tier's run equals the interpreter's");

const restored = await machine(true);
await restored.restore_state(snapshot);
run(restored, () => false);
const resumed = outcome(restored.v86.cpu);
await restored.destroy();
assert.deepEqual(resumed, expected, "the run from the snapshot equals the interpreter's");
console.log(`PASS xmm_state: XMM registers across a #PF mid-block, ${expected.steps} single steps and a snapshot restore (${native} native instructions before it)`);
