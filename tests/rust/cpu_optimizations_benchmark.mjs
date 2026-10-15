import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
// cpu_optimizations_benchmark.mjs [baseline.wasm candidate.wasm]: two cores in
// their default JIT configuration; without paths, the interpreter against the
// default (32-bit code in the x64 page tier) on one core. (The region tiers,
// the reference until then, were deleted in M11.)
const baseline = process.argv[2];
const candidate = process.argv[3] || "build/v86.wasm";
const arms = baseline ? [{ label: baseline, wasm: baseline, options: {} }, { label: candidate, wasm: candidate, options: {} }] :
    [{ label: "interpreter", wasm: candidate, options: { disable_jit: true } }, { label: "pages", wasm: candidate, options: {} }];
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const median = a => a.toSorted((x, y) => x - y)[a.length >> 1];
const machines = [];
const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
try {
    for(const { wasm, options } of arms) {
        const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path: wasm, ...options, bios: { buffer: bios.slice(0) }, memory_size: 32 << 20,
            disable_keyboard: true, disable_mouse: true, disable_speaker: true,
            net_device: { type: "none" }, autostart: false });
        machines.push(vm);
        await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
        vm.run();
        const end = performance.now() + 10000;
        while(word(vm, 0x500) !== 0xCAFE) { assert(performance.now() < end); await sleep(1); }
        await vm.stop();
    }
    const address = 0x100000;
    const kinds = ["stack-burst", "rmw-straight", "flags-mixed-read", "flags-linear-region", "sse-scalar-double", "bulk-add-array", "bulk-xor-array", "helper-mul16", "helper-xadd16", "sse-float-nan", "ram-relative-read-lea", "ram-relative-read-alu", "copy-byte-loop", "copy-dword-loop", "ram-relative-writes", "ram-write-pages", "fill-word-pattern", "fill-dword-pattern", "fill-dword-zero", "ram-relative-reads", "ram-relative-pages", "ram-pointer-chase", "flags-mov-setcc", "flags-lea-cmov", "flags-alias-setcc", "flags-mov-jcc", "sse3-duplicate-chain", "sse3-addsub", "sse-register-logic", "integer-flags", "indirect-call-ret", "short-cross-page",
        "x87-add-hit", "x87-add-fallback", "x87-f32-load-store", "x87-f32-rounded-store", "x87-f32-subnormal-store",
        "mmx-movq", "mmx-paddd", "mmx-pmaddwd", "mmx-packed", "sse-packed", "sse-float", "sse-scalar-float", "x87-f64-load-store", "x87-f64-rounded-store", "x87-f64-subnormal-store", "integer-flags-separated", "ram-reads", "rep-overlap", "x87-round", "x87-scale"];
    for(const kind of kinds.filter(kind => !process.env.BENCH_KINDS || process.env.BENCH_KINDS.split(",").includes(kind))) {
        const program = [0xB8, ...u32(1), 0xBB, ...u32(kind === "indirect-call-ret" ? address + 512 : 17)];
        if(kind === "sse-register-logic") {
            for(let r = 0; r < 8; r++) program.push(0x66, 0x0F, 0x6E, 0xC0 | r << 3);
        }
        if(kind === "sse-float" || kind === "sse-float-nan" || kind === "sse-scalar-float" || kind === "sse-scalar-double") {
            for(let r = 0; r < 8; r++) program.push(0x0F,0x10,0x05 | r << 3,...u32(0x220000));
        }
        if(kind.startsWith("x87")) program.push(0xDB, 0xE3);
        if(kind.startsWith("sse3")) {
            for(let r = 0; r < 8; r++) program.push(0xF3,0x0F,0x6F,5 | r << 3,...u32(0x220000));
        }
        if(kind.startsWith("ram-relative") || kind === "ram-write-pages" || kind === "ram-pointer-chase") program.push(0xBE, ...u32(0x220000));
        const loop = program.length;
        if(kind === "stack-burst") {
            for(let i=0;i<32;i++) program.push(0x50);
            for(let i=0;i<32;i++) program.push(0x58);
        } else if(kind === "rmw-straight") {
            program.push(0xBE,...u32(0x220000));
            for(let i=0;i<32;i++) program.push(0x01,0x5E,i*4);
        } else if(kind === "flags-mixed-read" || kind === "flags-linear-region") {
            program.push(0xBE,...u32(0x220000));
            for(let i=0;i<24;i++) {
                program.push(...[[0x39,0xD8],[0x85,0xD8],[0x30,0xD8],[0x66,0x39,0xD8]][i%4]);
                if(kind === "flags-linear-region") program.push(0xEB,0);
                program.push(0x8B,0x56,i*4,0x8D,0x1C,0x13);
            }
        } else if(kind.startsWith("bulk-")) {
            program.push(0xBF,...u32(0x220000),0xB9,...u32(1024),0xB8,...u32(17),
                kind === "bulk-add-array" ? 0x01 : 0x31,0x07,0x83,0xC7,4,0x49,0x75,0xF8);
        } else if(kind.startsWith("helper-")) {
            for(let i=0;i<32;i++) program.push(...(kind === "helper-mul16" ? [0x66,0xF7,0xE3] : [0x66,0x0F,0xC1,0xD8]));
        } else if(kind.startsWith("copy-")) {
            program.push(0xBE,...u32(0x220000),0xBF,...u32(0x230000),0xB9,...u32(1024),
                ...(kind === "copy-byte-loop" ? [0x8A,0x06,0x88,0x07,0x46,0x47,0x49,0x75,0xF7] :
                [0x8B,0x06,0x89,0x07,0x83,0xC6,4,0x83,0xC7,4,0x49,0x75,0xF3]));
        } else if(kind.startsWith("fill-")) {
            program.push(0xFC, 0xBF, ...u32(0x220000), 0xB9, ...u32(1024),
                0xB8, ...u32(kind.endsWith("zero") ? 0 : 0x12345678),
                0xF3, ...(kind === "fill-word-pattern" ? [0x66] : []), 0xAB);
        } else if(kind === "ram-relative-writes" || kind === "ram-write-pages") {
            for(let i=0;i<32;i++) program.push(0x89,0x86 | (i&3)<<3,
                ...u32(kind === "ram-write-pages" ? (i&1)*4096 : i*4));
        } else if(kind.startsWith("flags-")) {
            for(let i = 0; i < 32; i++) {
                // Keep a data dependency through the conditions, rather than
                // timing comparisons whose results can be discarded by Wasm.
                program.push(0x39, 0xD8); // cmp eax, ebx
                if(kind === "flags-lea-cmov") {
                    program.push(0x8D, 0x48, 1, 0x0F, 0x4C, 0xC1); // lea ecx,[eax+1]; cmovl eax,ecx
                } else if(kind === "flags-mov-jcc") {
                    program.push(0xB9, ...u32(1), 0x7D, 3, 0x8D, 0x04, 0x08); // mov ecx,1; jge +3; lea eax,[eax+ecx]
                } else {
                    program.push(0xB9, ...u32(1), 0xBA, ...u32(0));
                    if(kind === "flags-alias-setcc") program.push(0x89, 0xC8); // overwrite cmp destination
                    program.push(0x0F, 0x9C, 0xC2, 0x01, 0xD0); // setl dl; add eax,edx
                }
                program.push(0x01, 0xCB); // add ebx,ecx
            }
        } else if(kind.startsWith("sse3")) {
            for(let i = 0; i < 32; i++) {
                const [prefix,op] = kind === "sse3-addsub" ? [i&1 ? 0xF2 : 0x66,0xD0] :
                    [[0xF2,0x12],[0xF3,0x12],[0xF3,0x16],[0xF2,0x7D]][i&3];
                program.push(prefix,0x0F,op,0xC0 | (i&7)<<3 | ((i+1)&7));
            }
        } else if(kind === "sse-register-logic") {
            for(let i = 0; i < 32; i++) program.push(0x0F, [0x54, 0x55, 0x56, 0x57][i & 3], 0xC0 | (i & 7) << 3 | ((i + 1) & 7));
        } else if(kind === "sse-packed" || kind === "mmx-packed") {
            for(let i = 0; i < 32; i++) program.push(...(kind === "sse-packed" ? [0x66] : []),
                0x0F, [0xEC,0xD5,0xE4,0xF6][i & 3], 0xC0 | (i & 7) << 3 | ((i + 1) & 7));
        } else if(kind === "sse-float" || kind === "sse-float-nan" || kind === "sse-scalar-float" || kind === "sse-scalar-double") {
            for(let i = 0; i < 32; i++) program.push(...(kind === "sse-scalar-float" ? [0xF3] : kind === "sse-scalar-double" ? [0xF2] : []),
                0x0F, [0x5D,0x5F,0x59,0x51][i & 3], 0xC0 | (i & 7) << 3 | ((i + 1) & 7));
        } else if(kind === "x87-f64-load-store") {
            for(let i = 0; i < 16; i++) program.push(0xDD,0x05,...u32(0x220030),0xDD,0x1D,...u32(0x220020));
        } else if(kind === "x87-f64-rounded-store" || kind === "x87-f64-subnormal-store") {
            for(let i = 0; i < 16; i++) program.push(0xDB,0x2D,...u32(0x220000),0xDD,0x1D,...u32(0x220020));
        } else if(kind === "integer-flags-separated") {
            for(let i = 0; i < 16; i++) program.push(0x01, 0xD8, 0x89, 0xDA, 0x90, 0x29, 0xD8);
        } else if(kind === "ram-relative-read-alu" || kind === "ram-relative-read-lea") {
            for(let i=0;i<32;i++) program.push(0x8B,0x86,...u32(i*4),
                ...(kind.endsWith("lea") ? [0x8D,0x1C,0x03] : [0x01,0xC3]));
        } else if(kind.startsWith("ram-relative")) {
            for(let i = 0; i < 32; i++) program.push(0x8B, 0x86 | (i & 3) << 3,
                ...u32(kind === "ram-relative-pages" ? (i & 1) * 4096 : i * 4));
        } else if(kind === "ram-pointer-chase") {
            for(let i = 0; i < 32; i++) program.push(0x8B, 0x36);
        } else if(kind === "ram-reads") {
            for(let i = 0; i < 32; i++) program.push(0x8B, 5 | (i & 3) << 3, ...u32(0x220000 + i * 4));
        } else if(kind === "rep-overlap") {
            program.push(0xFC, 0xBE, ...u32(0x220000), 0xBF, ...u32(0x220001), 0xB9, ...u32(1024), 0xF3, 0xA4);
        } else if(kind === "x87-scale") {
            for(let i = 0; i < 16; i++) program.push(0xD9, 0x05, ...u32(0x220030),
                0xD9, 0x05, ...u32(0x220030), 0xD9, 0xFD, 0xD9, 0x1D, ...u32(0x220020), 0xDD, 0xD8);
        } else if(kind === "x87-round") {
            for(let i = 0; i < 16; i++) program.push(0xD9, 0x05, ...u32(0x220030), 0xD9, 0xFC, 0xD9, 0x1D, ...u32(0x220020));
        } else if(kind === "integer-flags") {
            for(let i = 0; i < 16; i++) program.push(0x01, 0xD8, 0x29, 0xD8);
        } else if(kind === "x87-f32-load-store") {
            for(let i = 0; i < 16; i++) program.push(0xD9, 0x05, ...u32(0x220030), 0xD9, 0x1D, ...u32(0x220020));
        } else if(kind === "x87-f32-rounded-store" || kind === "x87-f32-subnormal-store") {
            for(let i = 0; i < 16; i++) program.push(0xDB, 0x2D, ...u32(0x220000), 0xD9, 0x1D, ...u32(0x220020));
        } else if(kind.startsWith("mmx")) {
            for(let i = 0; i < 32; i++) program.push(0x0F,
                kind === "mmx-movq" ? 0x6F : kind === "mmx-paddd" ? 0xFE : 0xF5,
                0xC0 | (i & 7) << 3 | ((i + 1) & 7));
        } else if(kind === "short-cross-page") {
            // Indirect exits force independently compiled pages through the
            // core dispatcher, unlike a long loop inside one generated module.
        } else if(kind.startsWith("x87")) {
            for(let i = 0; i < 16; i++) program.push(0xDB, 0x2D, ...u32(0x220000),
                0xDB, 0x2D, ...u32(0x220010), 0xDE, 0xC1, 0xDB, 0x3D, ...u32(0x220020));
        } else {
            for(let i = 0; i < 8; i++) program.push(0xFF, 0xD3);
        }
        program.push(0xFF, 0x05, ...u32(0x600));
        if(kind === "short-cross-page") {
            program.push(0xB8, ...u32(address + 4096), 0xFF, 0xE0);
            while(program.length < 4096) program.push(0x90);
            program.push(0xB8, ...u32(address), 0xFF, 0xE0);
        } else program.push(0xE9, ...u32(loop - program.length - 5));
        if(kind === "indirect-call-ret") {
            while(program.length < 512) program.push(0x90);
            program.push(0x83, 0xC0, 1, 0xC3);
        }
        for(const vm of machines) {
            const operands = new Uint8Array(64), view = new DataView(operands.buffer);
            const low = kind === "x87-add-fallback" || kind === "x87-f32-rounded-store" || kind === "x87-f64-rounded-store" ? 0x8000000001n : 0n;
            view.setBigUint64(0, 0x9000000000000000n | low, true); view.setUint16(8, kind === "x87-f32-subnormal-store" ? 0x3F70 : kind === "x87-f64-subnormal-store" ? 0x3BFF : 0x4000, true);
            view.setBigUint64(16, 0x8800000000000000n | low, true); view.setUint16(24, 0x3FFF, true);
            view.setUint32(48, 0x3FC12345, true);
            if(kind === "x87-f64-load-store") view.setFloat64(48, 1.23456789, true);
            if(kind === "sse-float" || kind === "sse-float-nan" || kind === "sse-scalar-float" || kind === "sse-scalar-double" || kind.startsWith("sse3")) {
                for(let j = 0; j < 4; j++) view.setFloat32(j * 4, 1, true);
            }
            if(kind === "sse-scalar-double") for(let j=0;j<2;j++) view.setFloat64(j*8,1,true);
            if(kind === "sse-float-nan") for(let j=0;j<4;j++) view.setUint32(j*4,0x7FC12345,true);
            if(kind === "ram-pointer-chase") view.setUint32(0, 0x220000, true);
            vm.write_memory(operands, 0x220000);
            vm.write_memory(Uint8Array.from(program), address);
            vm.v86.cpu.instruction_pointer[0] = address;
            vm.v86.cpu.in_hlt[0] = 0;
            vm.run(); await sleep(500); await vm.stop();
        }
        if(kind.startsWith("x87-f64")) {
            assert.deepEqual(Uint8Array.from(machines[1].read_memory(0x220020, 8)),
                Uint8Array.from(machines[0].read_memory(0x220020, 8)), "binary64 store bits must match");
        }
        const times = [[], []];
        for(let round = 0; round < 9; round++) for(const index of round & 1 ? [1, 0] : [0, 1]) {
            const vm = machines[index], before = word(vm, 0x600), start = performance.now();
            while(performance.now() - start < 120) vm.v86.cpu.main_loop();
            const elapsed = performance.now() - start;
            const iterations = (word(vm, 0x600) - before) >>> 0;
            assert(iterations > 0);
            if(round >= 2) times[index].push(iterations / elapsed);
        }
        const old_rate = median(times[0]), new_rate = median(times[1]);
        console.log(JSON.stringify({ kind, reference: arms[0].label, candidate: arms[1].label,
            reference_iterations_per_ms: old_rate, candidate_iterations_per_ms: new_rate,
            speedup: new_rate / old_rate, rounds: 7, reference_samples: times[0], candidate_samples: times[1] }));
    }
} finally { for(const vm of machines) await vm.destroy(); }
