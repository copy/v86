#!/usr/bin/env node
"use strict";

var TIMEOUT_EXTRA_FACTOR = +process.env.TIMEOUT_EXTRA_FACTOR || 1;
var MAX_PARALLEL_TESTS = +process.env.MAX_PARALLEL_TESTS || 4;

try
{
    var V86 = require("../../build/libv86.js").V86Starter;
}
catch(e)
{
    console.error("Failed to import build/libv86.js. Run `make build/libv86.js first.");
    process.exit(1);
}

var cluster = require("cluster");
var os = require("os");
var fs = require("fs");
var root_path = __dirname + "/../..";

var SCREEN_WIDTH = 80;

function readfile(path)
{
    return new Uint8Array(fs.readFileSync(path)).buffer;
}

function line_to_text(screen, y)
{
    return String.fromCharCode.apply(String, screen.subarray(y * SCREEN_WIDTH, (y + 1) * SCREEN_WIDTH));
}

function screen_to_text(s)
{
    var result = [];
    result.push("+==================================== SCREEN ====================================+");

    for(var i = 0; i < 25; i++)
    {
        var line = line_to_text(s, i);
        result.push("|" + line + "|");
    }

    result.push("+================================================================================+");

    return result.join("\n");
}


if(cluster.isMaster)
{
    var tests = [
        {
            name: "FreeDOS boot",
            fda: root_path + "/images/freedos722.img",
            timeout: 10,
            expected_texts: [
                "Welcome to FreeDOS",
            ],
        },
        {
            name: "FreeDOS boot with Bochs BIOS",
            fda: root_path + "/images/freedos722.img",
            timeout: 10,
            alternative_bios: true,
            expected_texts: [
                "Welcome to FreeDOS",
            ],
        },
        {
            name: "Windows 1.01 boot",
            fda: root_path + "/images/windows101.img",
            timeout: 10,
            expect_graphical_mode: true,
            expect_mouse_registered: true,
        },
        {
            name: "Sol OS",
            fda: root_path + "/images/os8.dsk",
            timeout: 20,
            expect_graphical_mode: true,
            expect_mouse_registered: true,
            actions: [
                {
                    after: 5,
                    run: "\n"
                },
            ],
        },
        {
            name: "Linux",
            cdrom: root_path + "/images/linux.iso",
            timeout: 75,
            expected_texts: [
                "/root%",
                "test passed",
            ],
            actions: [
                {
                    on_text: "/root%",
                    run: "cd tests; ./test-i386 > emu.test; diff emu.test reference.test > /dev/null && echo test pas''sed || echo failed\n",
                },
            ],
        },
        {
            name: "Linux with Bochs BIOS",
            cdrom: root_path + "/images/linux.iso",
            timeout: 75,
            expected_texts: [
                "/root%",
                "test passed",
            ],
            alternative_bios: true,
            actions: [
                {
                    on_text: "/root%",
                    run: "cd tests; ./test-i386 > emu.test; diff emu.test reference.test > /dev/null && echo test pas''sed || echo failed\n",
                },
            ],
        },
        {
            name: "Linux 3",
            cdrom: root_path + "/images/linux3.iso",
            timeout: 200,
            expected_texts: [
                "test passed",
            ],
            actions: [
                {
                    on_text: "~%",
                    run: "echo test pas''sed\n"
                },
            ],
        },
        {
            name: "KolibriOS",
            fda: root_path + "/images/kolibri.img",
            timeout: 120,
            expect_graphical_mode: true,
            expect_mouse_registered: true,
        },
        {
            name: "OpenBSD",
            fda: root_path + "/images/openbsd.img",
            timeout: 180,
            expected_texts: ["(I)nstall, (U)pgrade or (S)hell"],
        },
    ];

    var nr_of_cpus = Math.min(Math.round(os.cpus().length / 2) || 1, tests.length, MAX_PARALLEL_TESTS);
    console.log("Using %d cpus", nr_of_cpus);

    var current_test = 0;

    function send_work_to_worker(worker, message)
    {
        if(current_test < tests.length)
        {
            worker.send(tests[current_test]);
            current_test++;
        }
        else
        {
            worker.disconnect();
        }
    }

    for(var i = 0; i < nr_of_cpus; i++)
    {
        var worker = cluster.fork();

        worker.on("message", send_work_to_worker.bind(this, worker));
        worker.on("online", send_work_to_worker.bind(this, worker));

        worker.on("exit", function(code, signal)
        {
            if(code !== 0)
            {
                process.exit(code);
            }
        });

        worker.on("error", function(error)
        {
            console.error("Worker error: ", error.toString(), error);
            process.exit(1);
        });
    }
}
else
{
    cluster.worker.on("message", function(test_case)
    {
        run_test(test_case, function()
        {
            process.send("I'm done");
        });
    });
}

function run_test(test, done)
{
    console.log("Starting test: %s", test.name);

    if(test.alternative_bios)
    {
        var bios = readfile(root_path + "/bios/bochs-bios.bin");
        var vga_bios = readfile(root_path + "/bios/bochs-vgabios.bin");
    }
    else
    {
        var bios = readfile(root_path + "/bios/seabios.bin");
        var vga_bios = readfile(root_path + "/bios/vgabios.bin");
    }

    var settings = {
        bios: { buffer: bios },
        vga_bios: { buffer: vga_bios },
        autostart: true,
    };

    console.assert(test.cdrom || test.fda, "Bootable drive expected");

    if(test.cdrom)
    {
        settings.cdrom = { buffer: readfile(test.cdrom) };
    }

    if(test.fda)
    {
        settings.fda = { buffer: readfile(test.fda) };
    }

    if(!test.expected_texts)
    {
        test.expected_texts = [];
    }

    var emulator = new V86(settings);
    var screen = new Uint8Array(SCREEN_WIDTH * 25);

    function check_text_test_done()
    {
        return test.expected_texts.length === 0;
    }

    var mouse_test_done = false;
    function check_mouse_test_done()
    {
        return !test.expect_mouse_registered || mouse_test_done;
    }

    var graphical_test_done = false;
    function check_grapical_test_done()
    {
        return !test.expect_graphical_mode || graphical_test_done;
    }

    var test_start = Date.now();

    var timeout_seconds = test.timeout * TIMEOUT_EXTRA_FACTOR;
    var timeout = setTimeout(check_test_done, (timeout_seconds + 1) * 1000);

    var on_text = [];
    var stopped = false;

    function check_test_done()
    {
        if(stopped)
        {
            return;
        }

        if(check_text_test_done() && check_mouse_test_done() && check_grapical_test_done())
        {
            clearTimeout(timeout);
            stopped = true;

            emulator.stop();

            console.warn("Passed test: %s (took %ds)", test.name, (Date.now() - test_start) / 1000);
            console.warn();

            done();
        }
        else if(Date.now() >= test_start + timeout_seconds * 1000)
        {
            clearTimeout(timeout);
            stopped = true;

            emulator.stop();
            emulator.destroy();

            console.warn(screen_to_text(screen));
            console.warn("Test failed: %s\n", test.name);

            if(!check_text_test_done())
            {
                console.warn('Expected text "%s" after %d seconds.', test.expected_texts[0], timeout_seconds);
            }

            if(!check_grapical_test_done())
            {
                console.warn("Expected graphical mode after %d seconds.", timeout_seconds);
            }

            if(!check_mouse_test_done())
            {
                console.warn("Expected mouse activation after %d seconds.", timeout_seconds);
            }

            process.exit(1);
        }
    }

    emulator.add_listener("mouse-enable", function()
    {
        mouse_test_done = true;
        check_test_done();
    });

    emulator.add_listener("screen-set-mode", function(is_graphical)
    {
        graphical_test_done = is_graphical;
        check_test_done();
    });

    emulator.add_listener("screen-put-char", function(chr)
    {
        var y = chr[0];
        var x = chr[1];
        var code = chr[2];
        screen[x + SCREEN_WIDTH * y] = code;

        var line = line_to_text(screen, y);

        if(!check_text_test_done())
        {
            var expected = test.expected_texts[0];

            if(line.indexOf(expected) >= 0)
            {
                test.expected_texts.shift();
                check_test_done();
            }
        }

        if(on_text.length)
        {
            if(line.indexOf(on_text[0].text) >= 0)
            {
                var action = on_text.shift();
                emulator.keyboard_send_text(action.run);
            }
        }
    });

    test.actions && test.actions.forEach(function(action)
    {
        if(action.on_text)
        {
            on_text.push({ text: action.on_text, run: action.run, });
        }

        if(action.after !== undefined)
        {
            setTimeout(function() {
                emulator.keyboard_send_text(action.run);
            }, action.after * 1000 * TIMEOUT_EXTRA_FACTOR);
        }
    });
}
