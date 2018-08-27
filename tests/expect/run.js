#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const process = require("process");
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

const TEST_NAME = process.env.TEST_NAME;

const LOG_LEVEL = 0;

const GIT_DIFF_FLAGS = ["--no-index", "--patience", "--color=always"];

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
    }).filter(({ name }) => !TEST_NAME || name === TEST_NAME);

    next_test(0);

    function next_test(i)
    {
        if(files[i])
        {
            run_test(files[i], () => next_test(i + 1));
        }
    }
}

let stdin_data = "";
let stdin_buffer = Buffer.alloc(100);
const stdin = fs.openSync("/dev/stdin", "r");

function readline()
{
    const bytesRead = fs.readSync(stdin, stdin_buffer, 0, stdin_buffer.length, null);
    stdin_data += stdin_buffer.slice(0, bytesRead).toString();

    const nl = stdin_data.indexOf("\n");

    if(nl === -1)
    {
        return readline();
    }

    const line = stdin_data.slice(0, nl);
    stdin_data = stdin_data.slice(nl + 1);
    return line;
}

function run_test({ name, executable_file, expect_file, actual_file, actual_wasm, asm_file }, onfinished)
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

                    if(process.argv.includes("--interactive"))
                    {
                        while(true)
                        {
                            console.log("Pick: [y] Accept this change and overwrite, [n] Don't accept this change, [q] Quit");
                            const choice = readline();

                            if(choice === "y")
                            {
                                console.log(`Running: cp ${actual_file} ${expect_file}`);
                                fs.copyFileSync(actual_file, expect_file);
                                break;
                            }
                            else if(choice === "n")
                            {
                                break;
                            }
                            else if(choice === "q")
                            {
                                process.exit(1);
                            }
                        }
                    }
                    else
                    {
                        const failure_message = `${name}.asm failed:
The code generator produced different code. If you believe this change is intentional,
verify the diff above and run the following command to accept the change:

    cp ${actual_file} ${expect_file}

When done, re-run this test to confirm that all expect-tests pass.

Hint: Use tests/expect/run.js --interactive to interactively accept changes.
`;

                        console.log(failure_message);

                        process.exit(1);
                    }
                }
                else
                {
                    console.log("%s ok", name);
                    console.assert(!result.stdout);
                    console.assert(!result.stderr);
                }

                onfinished();
            };

            if(is_32)
            {
                cpu.is_32[0] = true;
                cpu.stack_size_32[0] = true;
            }

            const START_ADDRESS = 0x1000;

            cpu.mem8.set(executable, START_ADDRESS);
            cpu.jit_force_generate(START_ADDRESS);
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
    catch(e)
    {
        console.error("Error while running libwabt: " + e.toString());
        console.error("Did you forget an ending hlt instruction?\n");
        throw e;
    }
    finally
    {
        module && module.destroy();
    }
}

run_all();
