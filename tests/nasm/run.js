#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const cluster = require('cluster');

const MAX_PARALLEL_TESTS = +process.env.MAX_PARALLEL_TESTS || 4;
const TEST_DIR = './tests/nasm/';
const DONE_MSG = 'DONE';

let fixture_files = [];
let img_files = [];

let failed_tests = [];
let current_test = 0;

try {
    var V86 = require('../../build/libv86.js').V86Starter;
}
catch(e) {
    console.error('Failed to import build/libv86.js. Run ' +
                  '`make build/libv86.js` first.');
    process.exit(1);
}

if (cluster.isMaster) {

    function extract_json(fixture_text) {
        const json_regex = /---BEGIN JSON---([\s\[\]\w":\-,]*)---END JSON---/;
        const regex_match = json_regex.exec(fixture_text);
        if (!regex_match || regex_match.length < 2) {
            throw new Error('Could not find JSON in fixture text: ' + fixture_text);
        }

        try {
            return JSON.parse(regex_match[1]);
        }
        catch (e) {
            throw e;
        }
    }


    function send_work_to_worker(worker, message) {
        if(current_test + failed_tests.length < fixture_files.length) {
            let img_name = img_files[current_test];
            let fixture_text = fs.readFileSync(
                TEST_DIR + fixture_files[current_test]
            );
            let fixture_array = extract_json(fixture_text);

            worker.send({
                img_name: img_name,
                fixture_array: fixture_array
            });

            current_test++;
        }
        else {
            worker.disconnect();
        }
    }

    const dir_files = fs.readdirSync(TEST_DIR);
    fixture_files = dir_files.filter((name) => {
        return /.*\.fixture$/.test(name);
    });
    img_files = dir_files.filter((name) => {
        return /.*\.img$/.test(name);
    });

    if (fixture_files.length !== img_files.length) {
        console.log(
            '%d .fixture files, but %d .img files found. Run `make nasmtests` '
                + 'in the root directory again.',
            fixture_files.length,
            img_files.length
        );
        process.exit(1);
    }

    const nr_of_cpus = Math.min(
        Math.round(os.cpus().length / 2) || 1,
        fixture_files.length,
        MAX_PARALLEL_TESTS
    );
    console.log('Using %d cpus', nr_of_cpus);

    current_test = 0;

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

    process.on('exit', function() {
        console.log(
            '\n[+] Passed %d/%d tests.',
            current_test,
            fixture_files.length
        );
        if (failed_tests.length > 0) {
            console.log('[-] Failed %d test(s).', failed_tests.length);
            failed_tests.forEach(function(test_failure) {
                console.error('\n[-] %s:', test_failure.img_name);

                test_failure.failures.forEach(function(individual_failure) {
                    console.error(
                        '\n\tcpu.reg_mmxs[%d]',
                        individual_failure.index
                    );
                    console.error('\tActual:', individual_failure.actual);
                    console.error('\tExpected:', individual_failure.expected);
                });
            });
        }
    });
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

        emulator.v86.cpu.debug.show = () => {};

        emulator.v86.bus.register('cpu-halt', function() {
            const filename = TEST_DIR + test.img_name;
            const evaluated_mmxs = this.cpu.reg_mmxs;
            let individual_failures = [];

            for (let i = 0; i < evaluated_mmxs.length; i++) {
                if (evaluated_mmxs[i] !== test.fixture_array[i]) {
                    individual_failures.push({
                        index: i,
                        actual: evaluated_mmxs[i],
                        expected: test.fixture_array[i]
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

        }, emulator.v86);

        emulator.v86.bus.pair.register('emulator-ready', function() {
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
