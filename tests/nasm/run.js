#!/usr/bin/env node
'use strict';

// Mapping between signals and x86 exceptions:
// "Program received signal SIGILL, Illegal instruction." -> #UD
// "Program received signal SIGFPE, Arithmetic exception." -> #GP
// to be determined -> #GP
// to be determined -> #NM
// to be determined -> #TS
// to be determined -> #NP
// to be determined -> #SS
// to be determined -> #PF

// A #UD might indicate a bug in the test generation

const fs = require('fs');
const path = require('path');
const os = require('os');
const cluster = require('cluster');

const MAX_PARALLEL_TESTS = +process.env.MAX_PARALLEL_TESTS || 99;
const TEST_DIR = __dirname + "/build/";
const DONE_MSG = 'DONE';

const MASK_ARITH = 1 | 1 << 2 | 1 << 4 | 1 << 6 | 1 << 7 | 1 << 11;

try {
    var V86 = require('../../build/libv86.js').V86Starter;
}
catch(e) {
    console.error('Failed to import build/libv86.js. Run ' +
                  '`make build/libv86.js` first.');
    process.exit(1);
}

function h(n, len)
{
    // pad string with zeros on the left
    function pad0(str, len)
    {
        str = str ? str + "" : "";

        while(str.length < len)
        {
            str = "0" + str;
        }

        return str;
    }

    if(!n)
    {
        var str = "";
    }
    else
    {
        var str = n.toString(16);
    }

    return "0x" + pad0(str.toUpperCase(), len || 1);
}

if (cluster.isMaster) {

    function extract_json(name, fixture_text) {
        if(fixture_text.includes("SIGFPE, Arithmetic exception"))
        {
            return { exception: "DE", };
        }

        if(fixture_text.includes("SIGILL, Illegal instruction"))
        {
            return { exception: "UD", };
        }

        if(fixture_text.includes("Program received signal") || fixture_text.includes("SIGILL"))
        {
            throw new Error("Test was killed during execution by gdb: " + name);
        }

        const json_regex = /---BEGIN JSON---([\s\[\]\w":\-,]*)---END JSON---/;
        const regex_match = json_regex.exec(fixture_text);
        if (!regex_match || regex_match.length < 2) {
            throw new Error('Could not find JSON in fixture text: ' + fixture_text + "\nTest: " + name);
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
        if(current_test < files.length) {
            let name = files[current_test];
            let fixture_name = name + ".fixture";
            let img_name = name + ".img";
            let fixture_text = fs.readFileSync(TEST_DIR + fixture_name);
            let fixture = extract_json(name, fixture_text);

            worker.send({
                img_name: img_name,
                fixture: fixture,
            });

            current_test++;
        }
        else {
            worker.disconnect();

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
    });

    const nr_of_cpus = Math.min(
        os.cpus().length || 1,
        files.length,
        MAX_PARALLEL_TESTS
    );
    console.log('Using %d cpus', nr_of_cpus);

    let current_test = 0;

    let failed_tests = [];
    let finished_workers = 0;

    for (let i = 0; i < nr_of_cpus; i++) {
        let worker = cluster.fork();

        worker.on('message', function(message) {
            if (message !== DONE_MSG) {
                failed_tests.push(message);
            }
            send_work_to_worker(this);
        });

        worker.on('online', send_work_to_worker.bind(null, worker));

        worker.on('exit', function(code, signal) {
            if(code !== 0) {
                console.log('Worker error code:', code);
                process.exit(code);
            }
        });

        worker.on('error', function(error) {
            console.error('Worker error: ', error.toString(), error);
            process.exit(1);
        });
    }

    function test_finished()
    {
        console.log(
            '\n[+] Passed %d/%d tests.',
            files.length - failed_tests.length,
            files.length
        );
        if (failed_tests.length > 0) {
            console.log('[-] Failed %d test(s).', failed_tests.length);
            failed_tests.forEach(function(test_failure) {

                console.error('\n[-] %s:', test_failure.img_name);

                test_failure.failures.forEach(function(individual_failure) {
                    console.error("\n\t" + individual_failure.name);
                    console.error("\tActual: 0x" + (individual_failure.actual >>> 0).toString(16));
                    console.error("\tExpected: 0x" + (individual_failure.expected >>> 0).toString(16));
                });
            });
            process.exit(1);
        }
    }
}
else {
    function run_test(test, done) {
        console.info('Testing', test.img_name);

        let emulator = new V86({
            multiboot: {
                url: TEST_DIR + test.img_name
            },
            autostart: false
        });

        //emulator.v86.cpu.debug.show = () => {};

        emulator.bus.register('cpu-event-halt', function() {
            var cpu = emulator.v86.cpu;

            const filename = TEST_DIR + test.img_name;
            const evaluated_mmxs = cpu.reg_mmxs;
            const evaluated_xmms = cpu.reg_xmm32s;
            const esp = cpu.reg32s[4];
            const evaluated_memory = new Int32Array(cpu.mem8.slice(esp, esp + 16).buffer);
            let individual_failures = [];

            if(test.exception)
            {
                throw "TODO: Handle exceptions";
            }

            if(test.fixture.array)
            {
                let offset = 0;
                const expected_reg32s = test.fixture.array.slice(offset, offset += 8);
                const expected_mmx_registers = test.fixture.array.slice(offset, offset += 16);
                const expected_xmm_registers = test.fixture.array.slice(offset, offset += 32);
                const expected_memory = test.fixture.array.slice(offset, offset += 4);
                const expected_eflags = test.fixture.array[offset] & MASK_ARITH;

                for (let i = 0; i < cpu.reg32s.length; i++) {
                    if(i === 4) continue; // TODO: Same stack for elf and multiboot
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

            if (individual_failures.length > 0) {
                done({
                    failures: individual_failures,
                    img_name: test.img_name
                });
            }
            else {
                done();
            }

        });

        emulator.bus.register('emulator-ready', function() {
            try {
                emulator.run();
            }
            catch(e) {
                console.log(e);
            }
        });
    }

    // To silence logs from emulator in the worker
    console.log = () => {};

    process.on('uncaughtException', (err) => {
        if (err !== 'HALT') {
            console.error(err);
            throw err;
        }
    });

    cluster.worker.on('message', function(test) {
        run_test(test, function(test_failure) {
            if (test_failure) {
                process.send(test_failure);
            }
            else {
                process.send(DONE_MSG);
            }
        });
    });
}
