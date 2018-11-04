#!/usr/bin/env node
"use strict";

process.on("unhandledRejection", exn => { throw exn; });

var TIMEOUT_EXTRA_FACTOR = +process.env.TIMEOUT_EXTRA_FACTOR || 1;
var MAX_PARALLEL_TESTS = +process.env.MAX_PARALLEL_TESTS || 4;
var TEST_NAME = process.env.TEST_NAME;

const VERBOSE = false;
const RUN_SLOW_TESTS = false;

try
{
    var V86 = require("../../build/libv86-debug.js").V86;
}
catch(e)
{
    console.error("Failed to import build/libv86-debug.js. Run `make build/libv86-debug.js first.");
    process.exit(1);
}

var cluster = require("cluster");
var os = require("os");
var fs = require("fs");
var root_path = __dirname + "/../..";

var SCREEN_WIDTH = 80;

function get_line(screen, y)
{
    return screen.subarray(y * SCREEN_WIDTH, (y + 1) * SCREEN_WIDTH);
}

function line_to_text(screen, y)
{
    return bytearray_to_string(get_line(screen, y));
}

function string_to_bytearray(str)
{
    return new Uint8Array(str.split("").map(chr => chr.charCodeAt(0)));
}

function bytearray_to_string(arr)
{
    return String.fromCharCode.apply(String, arr);
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

if(cluster.isMaster)
{
    var tests = [
        {
            name: "FreeDOS boot",
            fda: root_path + "/images/freedos722.img",
            timeout: 20,
            expected_texts: [
                "Welcome to FreeDOS",
            ],
        },
        {
            name: "FreeDOS boot with Bochs BIOS",
            fda: root_path + "/images/freedos722.img",
            timeout: 20,
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
                    on_text: " or press",
                    run: "\n"
                },
            ],
        },
        {
            name: "Linux",
            cdrom: root_path + "/images/linux.iso",
            timeout: 90,
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
        //{
        //    name: "Windows 98",
        //    hda: root_path + "/images/windows98.img",
        //    timeout: 60,
        //    expect_graphical_mode: true,
        //    expect_graphical_size: [800, 600],
        //    expect_mouse_registered: true,
        //    skip_if_disk_image_missing: true,
        //},
        //{
        //    name: "Windows 95",
        //    hda: root_path + "/images/windows95.img",
        //    timeout: 60,
        //    expect_graphical_mode: true,
        //    expect_graphical_size: [800, 600],
        //    expect_mouse_registered: true,
        //    skip_if_disk_image_missing: true,
        //},
        //{
        //    name: "Oberon",
        //    hda: root_path + "/images/oberon.dsk",
        //    fda: root_path + "/images/oberon-boot.dsk",
        //    timeout: 30,
        //    expect_graphical_mode: true,
        //    expect_mouse_registered: true,
        //},
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
                    run: "head -c 10000 /dev/urandom > rand; echo test pas''sed\n",
                    after: 1000,
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
            name: "Linux with Bochs BIOS",
            cdrom: root_path + "/images/linux.iso",
            timeout: 90,
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
            name: "MS-DOS",
            skip_if_disk_image_missing: true,
            hda: root_path + "/images/msdos.img",
            timeout: 90,
            expected_texts: [
                "C:\\>",
            ],
        },
        {
            name: "Linux 4",
            skip_if_disk_image_missing: true,
            cdrom: root_path + "/images/linux4.iso",
            timeout: 200,
            // TODO: Check serial
            expected_texts: [
                "~%",
                "Files send via emulator appear in",
            ],
            expect_mouse_registered: true,
        },
        {
            name: "Linux 4 bzImage",
            bzimage: root_path + "/images/bzImage",
            cmdline: "auto",
            timeout: 200,
            expected_texts: [
                "~%",
                "Files send via emulator appear in",
            ],
            expect_mouse_registered: true,
        },
        {
            name: "Linux 4 with bzImage from filesystem",
            bzimage_initrd_from_filesystem: true,
            filesystem: {
                basefs: "./images/integration-test-fs/fs.json",
                baseurl: "./images/integration-test-fs/flat/",
            },
            cmdline: "auto",
            timeout: 200,
            expected_texts: [
                "~%",
                "Files send via emulator appear in",
            ],
            expect_mouse_registered: true,
        },
        {
            name: "OpenBSD",
            fda: root_path + "/images/openbsd.img",
            timeout: 180,
            expected_texts: ["(I)nstall, (U)pgrade or (S)hell"],
        },
        {
            name: "Windows 3.0",
            skip_if_disk_image_missing: true,
            timeout: 10 * 60,
            cdrom: root_path + "/../v86-images/os/Win30.iso",
            expected_texts: [
                "Press any key to continue",
                "              **************************************************",
            ],
            expect_graphical_mode: true,
            expect_mouse_registered: true,
            actions: [
                {
                    on_text: "Press any key to continue . . .",
                    after: 1000,
                    run: "x",
                },
                {
                    on_text: "              **************************************************",
                    after: 1000,
                    run: "x",
                },
                {
                    on_text: "C> ",
                    after: 1000,
                    run: "win\n",
                },
            ],
        },
        {
            name: "FreeBSD",
            skip_if_disk_image_missing: true,
            timeout: 5 * 60,
            hda: root_path + "/../v86-images/os/freebsd.img",
            expected_texts: ["FreeBSD/i386 (nyu) (ttyv0)"],
            actions: [
                {
                    on_text: "   Autoboot in ",
                    run: "\n",
                }
            ],
        },
        {
            name: "FreeBSD cdrom",
            skip_if_disk_image_missing: true,
            slow: 1,
            timeout: 10 * 60,
            cdrom: root_path + "/../v86-images/os/FreeBSD-11.0-RELEASE-i386-bootonly.iso",
            expected_texts: ["Welcome to FreeBSD!"],
            actions: [
                {
                    on_text: "   Autoboot in ",
                    run: "\n",
                }
            ],
        },
        {
            name: "FreeGEM",
            skip_if_disk_image_missing: true,
            timeout: 60,
            hda: root_path + "/../v86-images/os/freegem.bin",
            expect_graphical_mode: true,
            expect_mouse_registered: true,
            actions: [
                {
                    on_text: "   Select from Menu",
                    run: "3",
                }
            ],
        },
        // TODO: Check serial text
        {
            name: "Haiku",
            skip_if_disk_image_missing: true,
            timeout: 60 * 15,
            hda: root_path + "/../v86-images/os/haiku-nightly-anyboot.image",
            expected_serial_text: ["cx23882: init_hardware()"],
            expect_graphical_mode: true,
            expect_mouse_registered: true,
        },
        {
            name: "HelenOS",
            skip_if_disk_image_missing: true,
            timeout: 3 * 60,
            cdrom: root_path + "/../v86-images/os/HelenOS-0.5.0-ia32.iso",
            expect_graphical_mode: true,
            expect_mouse_registered: true,
        },
        {
            name: "Minix",
            skip_if_disk_image_missing: true,
            timeout: 60,
            hda: root_path + "/../v86-images/os/minix2hd.img",
            actions: [
                {
                    on_text: "    =  Start Minix",
                    run: "=",
                },
                {
                    on_text: "noname login:",
                    run: "root\n",
                },
            ],
            expected_texts: ["noname login:", "# "],
        },
        {
            name: "Mobius",
            skip_if_disk_image_missing: true,
            timeout: 2 * 60,
            fda: root_path + "/../v86-images/os/mobius-fd-release5.img",
            expect_graphical_mode: true,
            actions: [
                {
                    on_text: "   The highlighted entry will be booted automatically",
                    run: "\n",
                },
            ],
        },
        {
            name: "Core 9",
            skip_if_disk_image_missing: 1,
            timeout: 5 * 60,
            cdrom: root_path + "/../v86-images/os/Core-9.0.iso",
            expected_texts: ["tc@box"],
            actions: [{ on_text: "boot:", run: "\n" }],
        },
        {
            name: "Core 8",
            skip_if_disk_image_missing: 1,
            timeout: 5 * 60,
            cdrom: root_path + "/../v86-images/os/Core-8.0.iso",
            expected_texts: ["tc@box"],
            actions: [{ on_text: "boot:", run: "\n" }],
        },
        {
            name: "Core 7",
            skip_if_disk_image_missing: 1,
            timeout: 5 * 60,
            cdrom: root_path + "/../v86-images/os/Core-7.2.iso",
            expected_texts: ["tc@box"],
            actions: [{ on_text: "boot:", run: "\n" }],
        },
        {
            name: "Core 6",
            skip_if_disk_image_missing: 1,
            timeout: 5 * 60,
            cdrom: root_path + "/../v86-images/os/Core-6.4.1.iso",
            expected_texts: ["tc@box"],
            actions: [{ on_text: "boot:", run: "\n" }],
        },
        {
            name: "Core 5",
            skip_if_disk_image_missing: 1,
            timeout: 5 * 60,
            cdrom: root_path + "/../v86-images/os/Core-5.4.iso",
            expected_texts: ["tc@box"],
            actions: [{ on_text: "boot:", run: "\n" }],
        },
        {
            name: "Core 4",
            skip_if_disk_image_missing: 1,
            timeout: 5 * 60,
            cdrom: root_path + "/../v86-images/os/Core-4.7.7.iso",
            expected_texts: ["tc@box"],
            actions: [{ on_text: "boot:", run: "\n" }],
        },
    ];

    if(TEST_NAME)
    {
        tests = tests.filter(test => test.name === TEST_NAME);
    }

    var nr_of_cpus = Math.min(Math.round(os.cpus().length / 2) || 1, tests.length, MAX_PARALLEL_TESTS);
    console.log("Using %d cpus", nr_of_cpus);

    var current_test = 0;

    for(var i = 0; i < nr_of_cpus; i++)
    {
        var worker = cluster.fork();

        worker.on("message", send_work_to_worker.bind(null, worker));
        worker.on("online", send_work_to_worker.bind(null, worker));

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

function bytearray_starts_with(arr, search)
{
    for(var i = 0; i < search.length; i++)
    {
        if(arr[i] !== search[i])
        {
            return false;
        }
    }
    return true;
}

function run_test(test, done)
{
    console.log("Starting test: %s", test.name);

    let image = test.fda || test.hda || test.cdrom || test.bzimage || test.filesystem.basefs;
    console.assert(image, "Bootable drive expected");

    if(!fs.existsSync(image))
    {
        if(test.skip_if_disk_image_missing)
        {
            console.warn("Missing disk image: " + image + ", test skipped");
            console.warn();

            done();
            return;
        }
        else
        {
            console.warn("Missing disk image: " + image);
            process.exit(1);
        }
    }

    if(test.slow && !RUN_SLOW_TESTS)
    {
        console.warn("Slow test: " + test.name + ", skipped");
        console.warn();
        done();
        return;
    }

    if(test.alternative_bios)
    {
        var bios = root_path + "/bios/bochs-bios.bin";
        var vga_bios = root_path + "/bios/bochs-vgabios.bin";
    }
    else
    {
        var bios = root_path + "/bios/seabios.bin";
        var vga_bios = root_path + "/bios/vgabios.bin";
    }

    var settings = {
        bios: { url: bios },
        vga_bios: { url: vga_bios },
        autostart: true,
        memory_size: 128 * 1024 * 1024,
        log_level: 0,
    };

    if(test.cdrom)
    {
        settings.cdrom = { url: test.cdrom };
    }
    if(test.fda)
    {
        settings.fda = { url: test.fda };
    }
    if(test.hda)
    {
        settings.hda = { url: test.hda, async: true };
    }
    if(test.bzimage)
    {
        settings.bzimage = { url: test.bzimage };
    }
    if(test.filesystem)
    {
        settings.filesystem = test.filesystem;
    }
    settings.cmdline = test.cmdline;
    settings.bzimage_initrd_from_filesystem = test.bzimage_initrd_from_filesystem;

    if(test.expected_texts)
    {
        test.expected_texts = test.expected_texts.map(string_to_bytearray);
    }
    else
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
    var size_test_done = false;
    function check_grapical_test_done()
    {
        return !test.expect_graphical_mode || (graphical_test_done && (!test.expect_graphical_size ||  size_test_done));
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
            var end = Date.now();

            clearTimeout(timeout);
            stopped = true;

            emulator.stop();

            console.warn("Passed test: %s (took %ds)", test.name, (end - test_start) / 1000);
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
                console.warn('Expected text "%s" after %d seconds.', bytearray_to_string(test.expected_texts[0]), timeout_seconds);
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

    emulator.add_listener("screen-set-size-graphical", function(size)
    {
        if(test.expect_graphical_size)
        {
            size_test_done = size[0] === test.expect_graphical_size[0] &&
                             size[1] === test.expect_graphical_size[1];
            check_test_done();
        }
    });

    emulator.add_listener("screen-put-char", function(chr)
    {
        var y = chr[0];
        var x = chr[1];
        var code = chr[2];
        screen[x + SCREEN_WIDTH * y] = code;

        var line = get_line(screen, y);

        if(!check_text_test_done())
        {
            let expected = test.expected_texts[0];
            if(x < expected.length && bytearray_starts_with(line, expected))
            {
                test.expected_texts.shift();
                check_test_done();
            }
        }

        if(on_text.length)
        {
            let expected = on_text[0].text;

            if(x < expected.length && bytearray_starts_with(line, expected))
            {
                var action = on_text.shift();

                if(action.after)
                {
                    setTimeout(() => emulator.keyboard_send_text(action.run), action.after);
                }
                else
                {
                    if(VERBOSE) console.error("Sending '%s'", action.run);
                    emulator.keyboard_send_text(action.run);
                }
            }
        }
    });

    test.actions && test.actions.forEach(function(action)
    {
        if(action.on_text)
        {
            on_text.push({ text: string_to_bytearray(action.on_text), run: action.run, after: action.after, });
        }
    });
}
