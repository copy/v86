#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const cluster = require('cluster');

const MAX_PARALLEL_TESTS = +process.env.MAX_PARALLEL_TESTS || 99;
const TEST_DIR = __dirname + "/";
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
        if(current_test < files.length) {
            let name = files[current_test];
            let fixture_name = name + ".fixture";
            let img_name = name + ".img";
            let fixture_text = fs.readFileSync(TEST_DIR + fixture_name);
            let fixture_array = extract_json(fixture_text);

            worker.send({
                img_name: img_name,
                fixture_array: fixture_array
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
                    console.error(individual_failure);
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

        emulator.v86.cpu.debug.show = () => {};

        emulator.bus.register('cpu-event-halt', function() {
            const filename = TEST_DIR + test.img_name;
            const evaluated_mmxs = this.cpu.reg_mmxs;
            const evaluated_xmm32s = this.cpu.reg_xmm32s;
            let individual_failures = [];
            let json_index = 0 ;

            for (let i = 0; i < evaluated_mmxs.length; i++) {
                if (evaluated_mmxs[i] !== test.fixture_array[i]) {
                    individual_failures.push({
                        reg: `mmx${ i>>1 }[${ i%2 }]`,
                        index: i,
                        actual: evaluated_mmxs[i],
                        expected: test.fixture_array[i]
                    });
                }
                json_index++;
            }

            for (let i = 0; i < evaluated_xmm32s.length; i++) {
                if (evaluated_xmm32s[i] !== test.fixture_array[json_index]) {
                    individual_failures.push({
                        reg: `xmm${ i>>2 }[${ i%4 }]`,
                        index: i,
                        actual: evaluated_xmm32s[i],
                        expected: test.fixture_array[json_index]
                    });
                }
                json_index++;
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
