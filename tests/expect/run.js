#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const libwabt = require("../../build/libwabt.js");

try {
    var V86 = require("../../build/libv86-debug.js").V86;
}
catch(e) {
    console.error(e);
    console.error("Failed to import build/libv86-debug.js. Run " +
                  "`make build/libv86-debug.js` first.");
    process.exit(1);
}

const LOG_LEVEL = 0;

const GIT_DIFF_FLAGS = [ "--no-index", "--patience", "--color=always"];

const TEST_DIR = path.join(__dirname, "tests");
const BUILD_DIR = path.join(TEST_DIR, "build");

function run_all()
{
    const asm_files = fs.readdirSync(TEST_DIR).filter(filename => filename.endsWith(".asm"));

    const files = asm_files.map(asm_file => {
        const name = asm_file.slice(0, -4);
        return {
            name,
            expect_file: path.relative(".", path.join(TEST_DIR, name + ".wast")),
            actual_file: path.relative(".", path.join(BUILD_DIR, name + ".actual.wast")),
            actual_wasm: path.relative(".", path.join(BUILD_DIR, name + ".wasm")),
            asm_file: path.join(TEST_DIR, name + ".asm"),
            executable_file: path.join(BUILD_DIR, name + ".bin"),
        };
    });

    files.forEach(run_test);
}

function run_test({ name, executable_file, expect_file, actual_file, actual_wasm, asm_file })
{
    const emulator = new V86({
        autostart: false,
        memory_size: 2 * 1024 * 1024,
        log_level: LOG_LEVEL,
    });

    const executable = fs.readFileSync(executable_file);
    const asm = fs.readFileSync(asm_file);

    const is_32 = asm.includes("BITS 32\n");

    emulator.add_listener("emulator-loaded", function()
        {
            const cpu = emulator.v86.cpu;

            const hook_not_called_timeout = setTimeout(() => {
                throw new Error("Hook for code generation not called");
            }, 1000);

            cpu.test_hook_did_generate_wasm = function(wasm)
            {
                const wast = disassemble_wasm(wasm);

                clearTimeout(hook_not_called_timeout);
                fs.writeFileSync(actual_file, wast);
                fs.writeFileSync(actual_wasm, wasm);

                cpu.test_hook_did_generate_wasm = function()
                {
                    cpu.test_hook_did_generate_wasm = function() {};
                    throw new Error("Hook for wasm generation called multiple times");
                };

                if(!fs.existsSync(expect_file))
                {
                    // enhanced workflow: If file doesn't exist yet print full diff
                    var expect_file_for_diff = "/dev/null";
                }
                else
                {
                    expect_file_for_diff = expect_file;
                }

                const result = spawnSync("git",
                    [].concat(
                        "diff",
                        GIT_DIFF_FLAGS,
                        expect_file_for_diff,
                        actual_file
                    ),
                    { encoding: "utf8" });

                if(result.status)
                {
                    console.log(result.stdout);
                    console.log(result.stderr);
                    const fail_str = `%s.asm failed:
The code generator produced different code. If you believe this change is intentional,
verify the diff above and run the following command to accept the change:

    cp %s %s

When done, re-run this test to confirm that all expect-tests pass.
`;

                    console.log(fail_str, name, actual_file, expect_file);

                    process.exit(1);
                }
                else
                {
                    console.log("%s ok", name);
                    console.assert(!result.stdout);
                    console.assert(!result.stderr);
                }
            };

            if(is_32)
            {
                cpu.is_32[0] = true;
                cpu.stack_size_32[0] = true;
            }

            const START_ADDRESS = 0x1000;

            cpu.mem8.set(executable, START_ADDRESS);
            cpu.jit_force_generate_unsafe(START_ADDRESS);
        });
}

function disassemble_wasm(wasm)
{
    // Need to make a small copy otherwise libwabt goes nuts trying to copy
    // the whole underlying buffer
    wasm = wasm.slice();

    try
    {
        var module = libwabt.readWasm(wasm, { readDebugNames: false });
        module.generateNames();
        module.applyNames();
        return module.toText({ foldExprs: true, inlineExport: true });
    }
    finally
    {
        module && module.destroy();
    }
}

run_all();
