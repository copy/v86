#!/usr/bin/env node
"use strict";

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

const fs = require("fs");
const path = require("path");
const os = require("os");
const cluster = require("cluster");

const MAX_PARALLEL_TESTS = +process.env.MAX_PARALLEL_TESTS || 99;
const TEST_NAME = process.env.TEST_NAME;
const SINGLE_TEST_TIMEOUT = 10000;

const TEST_DIR = __dirname + "/build/";
const DONE_MSG = "DONE";
const TERMINATE_MSG = "DONE";

const FORCE_JIT = process.argv.includes("--force-jit");

const MASK_ARITH = 1 | 1 << 2 | 1 << 4 | 1 << 6 | 1 << 7 | 1 << 11;

try {
    var V86 = require("../../build/libv86-debug.js").V86;
}
catch(e) {
    console.error(e);
    console.error("Failed to import build/libv86-debug.js. Run " +
                  "`make build/libv86-debug.js` first.");
    process.exit(1);
}

if(cluster.isMaster)
{
    function extract_json(name, fixture_text)
    {
        if(fixture_text.includes("(signal SIGFPE)"))
        {
            return { exception: "DE", };
        }

        if(fixture_text.includes("(signal SIGILL)"))
        {
            return { exception: "UD", };
        }

        if(fixture_text.includes("(signal SIGSEGV)"))
        {
            return { exception: "GP", };
        }

        if(fixture_text.includes("Program received signal") || fixture_text.includes("SIGILL"))
        {
            throw new Error("Test was killed during execution by gdb: " + name + "\n" + fixture_text);
        }

        const json_regex = /---BEGIN JSON---([\s\[\]\w":\-,]*)---END JSON---/;
        const regex_match = json_regex.exec(fixture_text);
        if (!regex_match || regex_match.length < 2) {
            throw new Error("Could not find JSON in fixture text: " + fixture_text + "\nTest: " + name);
        }

        try {
            let array = JSON.parse(regex_match[1]);
            return { array: array };
        }
        catch (e) {
            throw e;
        }
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
        return name.endsWith(".asm");
    }).map(name => {
        return name.slice(0, -4);
    }).filter(name => {
        return !TEST_NAME || name === TEST_NAME;
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
            if (message !== DONE_MSG) {
                failed_tests.push(message);
            }
            send_work_to_worker(this);
        });

        worker.on("online", send_work_to_worker.bind(null, worker));

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
        if (failed_tests.length > 0) {
            console.log("[-] Failed %d test(s).", failed_tests.length);
            failed_tests.forEach(function(test_failure) {

                console.error("\n[-] %s:", test_failure.img_name);

                test_failure.failures.forEach(function(failure) {
                    function format_value(v) {
                        if(typeof v === "number")
                            return "0x" + (v >>> 0).toString(16);
                        else
                            return String(v);
                    }
                    console.error("\n\t" + failure.name);
                    console.error("\tActual:   " + format_value(failure.actual));
                    console.error("\tExpected: " + format_value(failure.expected));
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

        console.assert(!emulator.running);

        cpu.reset();
        cpu.reset_memory();
        cpu.load_multiboot(fs.readFileSync(TEST_DIR + current_test.img_name).buffer);

        test_timeout = setTimeout(() => {
            console.error("Test " + test.img_name + " timed out after " + (SINGLE_TEST_TIMEOUT / 1000) + " seconds.");
            process.exit(2);
        }, SINGLE_TEST_TIMEOUT);

        if(FORCE_JIT)
        {
            cpu.jit_force_generate(cpu.instruction_pointer[0]);

            cpu.test_hook_did_finalize_wasm = function()
            {
                cpu.test_hook_did_finalize_wasm = null;

                // don't synchronously call into the emulator from this callback
                setTimeout(() => {
                    emulator.run();
                }, 0);
            };
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

        // XXX: On gdb execution is stopped at this point. On v86 we
        // currently don't have this ability, so we record the exception
        // and continue execution
        console.log("recorded", exception);
        recorded_exceptions.push(exception);
        return true;
    };

    emulator.bus.register("cpu-event-halt", function() {
        console.assert(!waiting_to_receive_next_test);
        waiting_to_receive_next_test = true;
        clearTimeout(test_timeout);

        emulator.stop();
        var cpu = emulator.v86.cpu;

        const filename = TEST_DIR + current_test.img_name;
        const evaluated_mmxs = cpu.reg_mmxs;
        const evaluated_xmms = cpu.reg_xmm32s;
        const esp = cpu.reg32s[4];
        const evaluated_memory = new Int32Array(cpu.mem8.slice(0x120000 - 16 * 4, 0x120000).buffer);
        let individual_failures = [];

        console.assert(current_test.fixture.array || current_test.fixture.exception);

        if(current_test.fixture.array)
        {
            let offset = 0;
            const expected_reg32s = current_test.fixture.array.slice(offset, offset += 8);
            const expected_mmx_registers = current_test.fixture.array.slice(offset, offset += 16);
            const expected_xmm_registers = current_test.fixture.array.slice(offset, offset += 32);
            const expected_memory = current_test.fixture.array.slice(offset, offset += 16);
            const expected_eflags = current_test.fixture.array[offset] & MASK_ARITH;

            for (let i = 0; i < cpu.reg32s.length; i++) {
                let reg = cpu.reg32s[i];
                if (reg !== expected_reg32s[i]) {
                    individual_failures.push({
                        name: "cpu.reg32s[" + i + "]",
                        expected: expected_reg32s[i],
                        actual: reg,
                    });
                }
            }

            for (let i = 0; i < evaluated_mmxs.length; i++) {
                if (evaluated_mmxs[i] !== expected_mmx_registers[i]) {
                    individual_failures.push({
                        name: "mm" + (i >> 1) + ".int32[" + (i & 1) + "] (cpu.reg_mmx[" + i + "])",
                        expected: expected_mmx_registers[i],
                        actual: evaluated_mmxs[i],
                    });
                }
            }

            for (let i = 0; i < evaluated_xmms.length; i++) {
                if (evaluated_xmms[i] !== expected_xmm_registers[i]) {
                    individual_failures.push({
                        name: "xmm" + (i >> 2) + ".int32[" + (i & 3) + "] (cpu.reg_xmm[" + i + "])",
                        expected: expected_xmm_registers[i],
                        actual: evaluated_xmms[i],
                    });
                }
            }

            for (let i = 0; i < evaluated_memory.length; i++) {
                if (evaluated_memory[i] !== expected_memory[i]) {
                    individual_failures.push({
                        name: "mem[" + i + "]",
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

        if(current_test.fixture.exception !== recorded_exceptions[0])
        {
            individual_failures.push({
                name: "Exception",
                actual: recorded_exceptions[0] || "(none)",
                expected: current_test.fixture.exception,
            });
        }

        recorded_exceptions = [];

        if (individual_failures.length > 0) {
            process.send({
                failures: individual_failures,
                img_name: current_test.img_name
            });
        }
        else {
            process.send(DONE_MSG);
        }
    });

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
}
