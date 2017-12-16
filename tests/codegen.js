"use strict";

const fs = require("fs");

const Codegen = require("../src/codegen.js");
console.assert(typeof Codegen === "function");

const codegen_module_buffer = fs.readFileSync(__dirname + "/../build/codegen-test.wasm");

const vals = {
    imm8: 1,
    imm8s: 1,
    imm16: 2,
    imm32s: 3,
    asize_32: false,
    reg16: 0,
    reg32s: 0,
    instruction_pointer: 0,
    previous_ip: 0,
};

load_wasm(codegen_module_buffer, {
        env: {
            _read_imm8() { return vals.imm8; },
            _read_imm8s() { return vals.imm8s; },
            _read_imm16() { return vals.imm16; },
            _read_imm32s() { return vals.imm32s; },
            _is_asize_32() { return vals.asize_32; },

            // static pointer imports
            g$_reg16() { return vals.reg16; },
            g$_reg32s() { return vals.reg32s; },
            g$_instruction_pointer() { return vals.instruction_pointer; },
            g$_previous_ip() { return vals.previous_ip; },
        }
    })
    .then(function(wm) {
        return new Codegen(wm);
    })
    .then(test);

function test(gen)
{
    gen.reset();
    gen.finish();

    let buf = gen.get_module_code();

    gen.reset();
    gen.fn0("fn0");
    gen.fn1("fn1", 0);
    gen.fn2("fn2", 0, 1);
    gen.increment_instruction_pointer(10);
    gen.set_previous_eip();
    gen.finish();

    buf = gen.get_module_code();
    fs.writeFileSync(__dirname + "/../build/codegen-test-output.wasm", buf);

    const module = new WebAssembly.Module(buf);

    const expected = [
        ["fn0"],
        ["fn1", 0],
        ["fn2", 0, 1],
    ];

    const store = [];

    const imports = {
        e: {
            fn0() { store.push(["fn0"]); },
            fn1(arg0) { store.push(["fn1", arg0]); },
            fn2(arg0, arg1) { store.push(["fn2", arg0, arg1]); },
            get_seg_prefix_ds() {},
            get_seg_prefix_ss() {},
            get_seg_prefix() {},
            m: new WebAssembly.Memory({ initial: 256 * 1024 * 1024 / 64 / 1024 }),
        },
    };
    const o = new WebAssembly.Instance(module, imports);
    o.exports.f();
    const view = new Uint32Array(imports.e.m.buffer);
    console.assert(view[vals.instruction_pointer] === 10);
    console.assert(view[vals.previous_ip] === 10);
    if (JSON.stringify(store) === JSON.stringify(expected))
    {
        console.log("Test passed");
    }
    else
    {
        console.error("Test failed");
        console.log("Expected:", expected);
        console.log("Got:", store);
    }
}

function load_wasm(buffer, imports, cb)
{
    if (!imports) {
        imports = {};
    }

    // XXX: These should not be fixed in M
    const STATIC_MEMORY_BASE = 256 - 32;
    const WASM_MEMORY_SIZE = 256;

    return WebAssembly.compile(buffer)
        .then(module => {
            if (!imports["env"]) {
                imports["env"] = {};
            }
            imports["env"]["___assert_fail"] = (a, b, c, d) => {
                console.error("Assertion Failed", a, b, c, d);
                dbg_assert(false);
            };
            imports["env"]["memoryBase"] = STATIC_MEMORY_BASE * 1024 * 1024;
            imports["env"]["tableBase"] = 0;
            imports["env"]["memory"] = new WebAssembly.Memory({ ["initial"]: WASM_MEMORY_SIZE * 1024 * 1024 / 64 / 1024, });
            imports["env"]["table"] = new WebAssembly.Table({ ["initial"]: 18, ["element"]: "anyfunc" });
            return WebAssembly.instantiate(module, imports).then(instance => ({ instance, module }));
        })
        .then(({ instance, module }) => {
            const ret = {
                mem: imports["env"]["memory"],
                funcs: instance["exports"],
                instance,
                imports,
            };
            if (typeof cb === "function")
            {
                cb(ret);
            }
            else
            {
                return ret;
            }
        });
}

