#!/usr/bin/env node
"use strict";

const fs = require("fs");

global.v86util = {};

// copied from const.js
global.WASM_TABLE_SIZE = 0x10000;
// The space we need for misc internal state before the beginning of mem8; see global_pointers.h
global.GUEST_MEMORY_START = 0x10000 + 0x100000 * 6;
global.WASM_PAGE_SIZE = 64 * 1024;

global.dbg_assert = x => console.assert(x);

require("../../src/browser/lib.js");

const Codegen = require("../../src/codegen.js");

const codegen_module_buffer = fs.readFileSync(__dirname + "/../../build/codegen-test.wasm");

const vals = {
    imm8: 1,
    imm8s: 1,
    imm16: 2,
    imm32s: 3,
    asize_32: false,
    reg16: 4,
    reg32s: 4,
    instruction_pointer: 556,
    previous_ip: 560,
    prefixes: 0,
    timestamp_counter: 0,
};

const wasm_test_funcs = {
    env: {
        _read_imm8() { return vals.imm8; },
        _read_imm8s() { return vals.imm8s; },
        _read_imm16() { return vals.imm16; },
        _read_imm32s() { return vals.imm32s; },
        _is_asize_32() { return vals.asize_32; },
        _printf(...args) { console.log(...args); },
        ___assert_fail(...args) { console.error(...args); console.assert(false); },
        abort() { console.assert(false); },
    },
};

const memory_size = 256 * 1024 * 1024;

v86util.load_wasm(
    "build/codegen-test.wasm",
    wasm_test_funcs,
    memory_size + GUEST_MEMORY_START,
    WASM_TABLE_SIZE,
    wm => {
        try {
            test(new Codegen(wm));
        } catch(er) {
            console.error(er);
            process.exit(1);
        }
    }
);

function test(gen)
{
    gen.reset();
    gen.scratch_fn0("fn0");
    gen.scratch_fn0("fn0_test_eip_order");
    gen.scratch_fn1("fn1", 0);
    gen.scratch_fn2("fn2", 0, 1);
    gen.increment_instruction_pointer(10);
    gen.set_previous_eip();

    gen.commit_scratch_to_cs();

    gen.scratch_modrm_fn0("fn1r");
    gen.scratch_modrm_fn1("fn2r", 2);
    vals.asize_32 = !vals.asize_32;
    gen.scratch_modrm_fn0("fn1r");
    gen.scratch_modrm_fn1("fn2r", 2);

    gen.commit_scratch_to_cs();
    // Never written:
    gen.scratch_fn0("fn0");
    gen.finish();

    let buf = gen.get_module_code();
    fs.writeFileSync(__dirname + "/../../build/codegen-test-output.wasm", buf);

    const module = new WebAssembly.Module(buf);

    const expected = [
        ["fn0"],
        ["fn0_test_eip_order"],
        ["fn1", 0],
        ["fn2", 0, 1],
        ["fn1r", 0],
        ["fn2r", 0, 0],
        ["fn1r", 0],
        ["fn2r", 0, 0],
    ];

    const store = [];

    const imports = {
        e: {
            fn0() { store.push(["fn0"]); },
            fn1(arg0) { store.push(["fn1", arg0]); },
            fn2(arg0, arg1) { store.push(["fn2", arg0, arg1]); },
            fn1r(arg0) { store.push(["fn1r", arg0]); },
            fn2r(arg0, arg1) { store.push(["fn2r", arg0, arg1]); },
            get_seg_prefix_ds() {},
            get_seg_prefix_ss() {},
            get_seg_prefix() {},
            m: new WebAssembly.Memory({ initial: memory_size / 64 / 1024 }),
        },
    };
    const view = new Uint32Array(imports.e.m.buffer);
    imports.e.fn0_test_eip_order = function()
    {
        store.push(["fn0_test_eip_order"]);
        // Since fn0 was commited from the scratch buffer _after_ the instruction pointer updates
        console.assert(view[vals.instruction_pointer >> 2] === 10);
        console.assert(view[vals.previous_ip >> 2] === 10);
    };

    const o = new WebAssembly.Instance(module, imports);
    o.exports.f();
    console.log(store);
    console.assert(JSON.stringify(store) === JSON.stringify(expected));
}
