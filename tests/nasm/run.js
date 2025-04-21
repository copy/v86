#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import assert from "node:assert/strict";
import os from "node:os";
import cluster from "node:cluster";

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

process.on("unhandledRejection", exn => { throw exn; });

// Mapping between signals and x86 exceptions:
// "Program received signal SIGILL, Illegal instruction." -> #UD (6)
// "Program received signal SIGFPE, Arithmetic exception." -> #DE (0)
// to be determined -> #GP
// to be determined -> #NM
// to be determined -> #TS
// to be determined -> #NP
// to be determined -> #SS
// to be determined -> #PF

// A #UD might indicate a bug in the test generation

const MAX_PARALLEL_TESTS = +process.env.MAX_PARALLEL_TESTS || 99;
const TEST_NAME = new RegExp(process.env.TEST_NAME || "", "i");
const SINGLE_TEST_TIMEOUT = 10000;

const TEST_DIR = __dirname + "/build/";
const DONE_MSG = "DONE";
const TERMINATE_MSG = "DONE";
const READY_MSG = "READY";

const BSS = 0x100000;
const STACK_TOP = 0x102000;

const FORCE_JIT = process.argv.includes("--force-jit");

// alternative representation for infinity for json
const JSON_POS_INFINITY = "+INFINITY";
const JSON_NEG_INFINITY = "-INFINITY";
const JSON_POS_NAN = "+NAN";
const JSON_NEG_NAN = "-NAN";

const MASK_ARITH = 1 | 1 << 2 | 1 << 4 | 1 << 6 | 1 << 7 | 1 << 11;
const FPU_TAG_ALL_INVALID = 0xAAAA;
const FPU_STATUS_MASK = 0xFFFF & ~(1 << 9 | 1 << 5 | 1 << 3 | 1 << 1); // bits that are not correctly implemented by v86
const FP_COMPARISON_SIGNIFICANT_DIGITS = 7;

function float_equal(x, y)
{
    assert(typeof x === "number");
    assert(typeof y === "number");

    if(x === Infinity && y === Infinity || x === -Infinity && y === -Infinity || isNaN(x) && isNaN(y))
    {
        return true;
    }

    const epsilon = Math.pow(10, -FP_COMPARISON_SIGNIFICANT_DIGITS);
    return Math.abs(x - y) < epsilon;
}

function format_value(v)
{
    if(typeof v === "number")
    {
        if((v >>> 0) !== v && (v | 0) !== v)
        {
            return String(v);
        }
        else
        {
            return "0x" + (v >>> 0).toString(16);
        }
    }
    else
    {
        return String(v);
    }
}

if(cluster.isMaster)
{
    function extract_json(name, fixture_text)
    {
        let exception;

        if(fixture_text.includes("(signal SIGFPE)"))
        {
            exception = "DE";
        }

        if(fixture_text.includes("(signal SIGILL)"))
        {
            exception = "UD";
        }

        if(fixture_text.includes("(signal SIGSEGV)"))
        {
            exception = "GP";
        }

        if(fixture_text.includes("(signal SIGBUS)"))
        {
            exception = "PF";
        }

        if(!exception && fixture_text.includes("Program received signal"))
        {
            throw new Error("Test was killed during execution by gdb: " + name + "\n" + fixture_text);
        }

        fixture_text = fixture_text.toString()
            .replace(/-inf\b/g, JSON.stringify(JSON_NEG_INFINITY))
            .replace(/\binf\b/g, JSON.stringify(JSON_POS_INFINITY))
            .replace(/-nan\b/g, JSON.stringify(JSON_NEG_NAN))
            .replace(/\bnan\b/g, JSON.stringify(JSON_POS_NAN));

        const json_regex = /---BEGIN JSON---([\s\[\]\.\+\w":\-,]*)---END JSON---/;
        const regex_match = json_regex.exec(fixture_text);
        if(!regex_match || regex_match.length < 2) {
            throw new Error("Could not find JSON in fixture text: " + fixture_text + "\nTest: " + name);
        }

        let array = JSON.parse(regex_match[1]);
        return {
            array: array,
            exception,
        };
    }


    function send_work_to_worker(worker, message) {
        if(current_test < tests.length) {
            const test = tests[current_test];
            worker.send(test);
            current_test++;
        }
        else {
            worker.send(TERMINATE_MSG);
            worker.disconnect();

            setTimeout(() => {
                // The emulator currently doesn't cleanly exit, so this is necessary
                console.log("Worker killed");
                worker.kill();
            }, 100);

            finished_workers++;
            if(finished_workers === nr_of_cpus)
            {
                test_finished();
            }
        }
    }

    const dir_files = fs.readdirSync(TEST_DIR);
    const files = dir_files.filter((name) => {
        return name.endsWith(".img");
    }).map(name => {
        return name.slice(0, -4);
    }).filter(name => {
        return TEST_NAME.test(name + ".img");
    });

    const tests = files.map(name => {
        let fixture_name = name + ".fixture";
        let img_name = name + ".img";
        let fixture_text = fs.readFileSync(TEST_DIR + fixture_name);
        let fixture = extract_json(name, fixture_text);

        return {
            img_name: img_name,
            fixture: fixture,
        };
    });

    const nr_of_cpus = Math.min(
        os.cpus().length || 1,
        tests.length,
        MAX_PARALLEL_TESTS
    );
    console.log("Using %d cpus", nr_of_cpus);

    let current_test = 0;

    let failed_tests = [];
    let finished_workers = 0;

    for(let i = 0; i < nr_of_cpus; i++)
    {
        let worker = cluster.fork();

        worker.on("message", function(message) {
            if(message !== DONE_MSG && message !== READY_MSG) {
                failed_tests.push(message);
            }
            send_work_to_worker(this);
        });

        worker.on("exit", function(code, signal) {
            if(code !== 0 &&  code !== null) {
                console.log("Worker error code:", code);
                process.exit(code);
            }
        });

        worker.on("error", function(error) {
            console.error("Worker error: ", error.toString(), error);
            process.exit(1);
        });
    }

    function test_finished()
    {
        console.log(
            "\n[+] Passed %d/%d tests.",
            tests.length - failed_tests.length,
            tests.length
        );
        if(failed_tests.length > 0) {
            console.log("[-] Failed %d test(s).", failed_tests.length);
            failed_tests.forEach(function(test_failure) {

                console.error("\n[-] %s:", test_failure.img_name);

                test_failure.failures.forEach(function(failure) {
                    console.error("\n\t" + failure.name);
                    console.error("\tActual:   " + failure.actual);
                    console.error("\tExpected: " + failure.expected);
                });
            });
            process.exit(1);
        }
    }
}
else {
    function run_test(test)
    {
        if(!loaded)
        {
            first_test = test;
            return;
        }

        waiting_to_receive_next_test = false;
        current_test = test;
        console.info("Testing", test.img_name);

        var cpu = emulator.v86.cpu;

        assert(!emulator.running);

        cpu.reboot_internal();
        cpu.reset_memory();
        cpu.load_multiboot(fs.readFileSync(TEST_DIR + current_test.img_name).buffer);

        test_timeout = setTimeout(() => {
            console.error("Test " + test.img_name + " timed out after " + (SINGLE_TEST_TIMEOUT / 1000) + " seconds.");
            process.exit(2);
        }, SINGLE_TEST_TIMEOUT);

        if(FORCE_JIT)
        {
            let eip = cpu.instruction_pointer[0];

            cpu.test_hook_did_finalize_wasm = function()
            {
                eip += 4096;
                const last_word = cpu.mem32s[eip - 4 >> 2];

                if(last_word === 0 || last_word === undefined)
                {
                    cpu.test_hook_did_finalize_wasm = null;

                    // don't synchronously call into the emulator from this callback
                    setTimeout(() => {
                        emulator.run();
                    }, 0);
                }
                else
                {
                    cpu.jit_force_generate(eip);
                }
            };

            cpu.jit_force_generate(eip);
        }
        else
        {
            emulator.run();
        }
    }

    let loaded = false;
    let current_test = undefined;
    let first_test = undefined;
    let waiting_to_receive_next_test = false;
    let recorded_exceptions = [];
    let test_timeout;

    let emulator = new V86({
        autostart: false,
        memory_size: 2 * 1024 * 1024,
        disable_jit: +process.env.DISABLE_JIT,
        log_level: 0,
    });

    emulator.add_listener("emulator-loaded", function()
        {
            loaded = true;

            if(first_test)
            {
                run_test(first_test);
            }
        });

    emulator.cpu_exception_hook = function(n)
    {
        emulator.v86.cpu.instruction_counter[0] += 100000; // always make progress

        if(waiting_to_receive_next_test)
        {
            return true;
        }

        const exceptions = {
            0: "DE",
            6: "UD",
            13: "GP",
        };

        const exception = exceptions[n];

        if(exception === undefined)
        {
            console.error("Unexpected CPU exception: " + n);
            process.exit(1);
        }

        const eip = emulator.v86.cpu.instruction_pointer[0];
        emulator.v86.cpu.write32(emulator.v86.cpu.translate_address_system_read(eip), 0xF4F4F4F4); // hlt

        // XXX: On gdb execution is stopped at this point. On v86 we
        // currently don't have this ability, so we record the exception
        // and continue execution
        recorded_exceptions.push({ exception, eip });
        finish_test();
        return true;
    };

    emulator.bus.register("cpu-event-halt", function() {
        finish_test();
    });

    function finish_test()
    {
        if(waiting_to_receive_next_test)
        {
            return;
        }

        waiting_to_receive_next_test = true;
        clearTimeout(test_timeout);

        emulator.stop();
        var cpu = emulator.v86.cpu;

        const evaluated_fpu_regs = new Float64Array(8).map((_, i) => cpu.fpu_get_sti_f64(i));
        const evaluated_mmxs = new Int32Array(16).map((_, i) => cpu.fpu_st[(i & ~1) << 1 | (i & 1)]);
        const evaluated_xmms = cpu.reg_xmm32s;
        const evaluated_memory = new Int32Array(cpu.mem8.buffer, cpu.mem8.byteOffset + BSS, STACK_TOP - BSS >> 2);
        const evaluated_fpu_tag = cpu.fpu_load_tag_word();
        const evaluated_fpu_status = cpu.fpu_load_status_word() & FPU_STATUS_MASK;

        let individual_failures = [];

        assert(current_test.fixture.array);

        const FLOAT_TRANSLATION = {
            [JSON_POS_INFINITY]: Infinity,
            [JSON_NEG_INFINITY]: -Infinity,
            [JSON_POS_NAN]: NaN,
            [JSON_NEG_NAN]: NaN, // XXX: Ignore sign of NaN
        };

        let offset = 0;
        const expected_reg32 = current_test.fixture.array.slice(offset, offset += 8);
        const expected_eip = current_test.fixture.array[offset++];
        const expected_fpu_regs =
            current_test.fixture.array.slice(offset, offset += 8) .map(x => x in FLOAT_TRANSLATION ? FLOAT_TRANSLATION[x] : x);
        const expected_mmx_registers = current_test.fixture.array.slice(offset, offset += 16);
        const expected_xmm_registers = current_test.fixture.array.slice(offset, offset += 32);
        const expected_memory = current_test.fixture.array.slice(offset, offset += 8192 / 4);
        const expected_eflags = current_test.fixture.array[offset++] & MASK_ARITH;
        const fpu_tag = current_test.fixture.array[offset++];
        const fpu_status = current_test.fixture.array[offset++] & FPU_STATUS_MASK;

        if(offset !== current_test.fixture.array.length)
        {
            throw new Error("Bad fixture length in test " + current_test.img_name);
        }

        if(!current_test.fixture.exception)
        {
            for(let i = 0; i < cpu.reg32.length; i++) {
                let reg = cpu.reg32[i];
                if(reg !== expected_reg32[i]) {
                    individual_failures.push({
                        name: "cpu.reg32[" + i + "]",
                        expected: expected_reg32[i],
                        actual: reg,
                    });
                }
            }

            if(fpu_tag !== FPU_TAG_ALL_INVALID)
            {
                for(let i = 0; i < evaluated_fpu_regs.length; i++) {
                    if(expected_fpu_regs[i] !== "invalid" &&
                            !float_equal(evaluated_fpu_regs[i], expected_fpu_regs[i])) {
                        individual_failures.push({
                            name: "st" + i,
                            expected: expected_fpu_regs[i],
                            actual: evaluated_fpu_regs[i],
                        });
                    }
                }

                if(fpu_status !== evaluated_fpu_status)
                {
                    individual_failures.push({
                        name: "fpu status word",
                        expected: fpu_status,
                        actual: evaluated_fpu_status,
                    });
                }
            }
            else
            {
                for(let i = 0; i < evaluated_mmxs.length; i++) {
                    if(evaluated_mmxs[i] !== expected_mmx_registers[i]) {
                        individual_failures.push({
                            name: "mm" + (i >> 1) + ".int32[" + (i & 1) + "]",
                            expected: expected_mmx_registers[i],
                            actual: evaluated_mmxs[i],
                        });
                    }
                }
            }

            for(let i = 0; i < evaluated_xmms.length; i++) {
                if(evaluated_xmms[i] !== expected_xmm_registers[i]) {
                    individual_failures.push({
                        name: "xmm" + (i >> 2) + ".int32[" + (i & 3) + "] (cpu.reg_xmm[" + i + "])",
                        expected: expected_xmm_registers[i],
                        actual: evaluated_xmms[i],
                    });
                }
            }

            for(let i = 0; i < evaluated_memory.length; i++) {
                if(evaluated_memory[i] !== expected_memory[i]) {
                    individual_failures.push({
                        name: "mem[" + (BSS + 4 * i).toString(16).toUpperCase() + "]",
                        expected: expected_memory[i],
                        actual: evaluated_memory[i],
                    });
                }
            }

            const seen_eflags = cpu.get_eflags() & MASK_ARITH;
            if(seen_eflags !== expected_eflags)
            {
                individual_failures.push({
                    name: "eflags",
                    expected: expected_eflags,
                    actual: seen_eflags,
                });
            }
        }

        if(current_test.fixture.exception)
        {
            const seen_eip = (recorded_exceptions[0] || {}).eip;
            if(seen_eip !== expected_eip)
            {
                individual_failures.push({
                    name: "exception eip",
                    expected: expected_eip,
                    actual: seen_eip === undefined ? "(none)" : seen_eip,
                });
            }
        }

        const seen_exception = (recorded_exceptions[0] || {}).exception;
        if(current_test.fixture.exception !== seen_exception)
        {
            individual_failures.push({
                name: "Exception",
                actual: seen_exception || "(none)",
                expected: current_test.fixture.exception,
            });
        }

        individual_failures = individual_failures.map(({ name, actual, expected }) => {
            return {
                name,
                actual: format_value(actual),
                expected: format_value(expected),
            };
        });

        recorded_exceptions = [];

        if(individual_failures.length > 0) {
            process.send({
                failures: individual_failures,
                img_name: current_test.img_name
            });
        }
        else {
            process.send(DONE_MSG);
        }
    }

    cluster.worker.on("message", function(message) {
        if(message === TERMINATE_MSG)
        {
            emulator.stop();
            emulator = null;
        }
        else
        {
            run_test(message);
        }
    });

    process.send(READY_MSG);
}
