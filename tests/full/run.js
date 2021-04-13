#!/usr/bin/env node
"use strict";

process.on("unhandledRejection", exn => { throw exn; });

var TIMEOUT_EXTRA_FACTOR = +process.env.TIMEOUT_EXTRA_FACTOR || 1;
var MAX_PARALLEL_TESTS = +process.env.MAX_PARALLEL_TESTS || 4;
var TEST_NAME = process.env.TEST_NAME;
const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;

const VERBOSE = false;
const RUN_SLOW_TESTS = false;
const LOG_SCREEN = false;

try
{
    var V86 = require(`../../build/${TEST_RELEASE_BUILD ? "libv86" : "libv86-debug"}.js`).V86;
}
catch(e)
{
    console.error("Failed to import build/libv86-debug.js. Run `make build/libv86-debug.js first.");
    process.exit(1);
}

const assert = require("assert").strict || require("assert"); // Strict mode added in: V8.13.0
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
            fda: root_path + "/images/os8.img",
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
            name: "Snowdrop",
            skip_if_disk_image_missing: true,
            fda: root_path + "/images/snowdrop.img",
            timeout: 30,
            expect_graphical_mode: true,
            expect_mouse_registered: true,
            actions: [
                {
                    on_text: "[Snowdrop OS snowshell]:",
                    run: "desktop\n"
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
                    run: "cd tests; ./test-i386 > emu.test; diff emu.test reference.test && echo test pas''sed || echo failed\n",
                },
            ],
        },
        {
            name: "Windows 2000",
            skip_if_disk_image_missing: true,
            hda: root_path + "/images/windows2k.img",
            memory_size: 512 * 1024 * 1024,
            timeout: 300,
            expect_graphical_mode: true,
            expect_graphical_size: [1024, 768],
            expect_mouse_registered: true,
        },
        //{
        //    name: "Windows 98",
        //    skip_if_disk_image_missing: true,
        //    hda: root_path + "/images/windows98.img",
        //    timeout: 60,
        //    expect_graphical_mode: true,
        //    expect_graphical_size: [800, 600],
        //    expect_mouse_registered: true,
        //    failure_allowed: true,
        //},
        {
            name: "Windows 95",
            skip_if_disk_image_missing: true,
            hda: root_path + "/images/w95.img",
            timeout: 60,
            expect_graphical_mode: true,
            expect_graphical_size: [1024, 768],
            expect_mouse_registered: true,
            failure_allowed: true,
        },
        {
            name: "Oberon",
            skip_if_disk_image_missing: true,
            hda: root_path + "/images/oberon.img",
            timeout: 30,
            expect_graphical_mode: true,
            expect_mouse_registered: true,
        },
        {
            name: "Linux 3",
            skip_if_disk_image_missing: true,
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
            name: "Linux 3 reboot",
            cdrom: root_path + "/images/linux3.iso",
            timeout: 90,
            expected_texts: [
                "~%",
                "SeaBIOS ",
                "~%",
            ],
            actions: [
                {
                    on_text: "~%",
                    run: "reboot\n",
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
                    run: "cd tests; ./test-i386 > emu.test; diff emu.test reference.test && echo test pas''sed || echo failed\n",
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
            expected_texts: [
                "~%",
            ],
            expected_serial_text: [
                "Files send via emulator appear in",
            ],
            expect_mouse_registered: true,
        },
        {
            name: "Linux bzImage",
            bzimage: root_path + "/images/buildroot-bzimage.bin",
            cmdline: "auto",
            timeout: 200,
            expected_texts: [
                "~%",
            ],
            expected_serial_text: [
                "Files send via emulator appear in",
            ],
            expect_mouse_registered: true,
        },
        {
            name: "Linux with bzImage from filesystem",
            bzimage_initrd_from_filesystem: true,
            filesystem: {
                basefs: root_path + "/build/integration-test-fs/fs.json",
                baseurl: root_path + "/build/integration-test-fs/flat/",
            },
            cmdline: "auto",
            timeout: 200,
            expected_texts: [
                "~%",
            ],
            expected_serial_text: [
                "Files send via emulator appear in",
            ],
            expect_mouse_registered: true,
        },
        {
            name: "QNX",
            skip_if_disk_image_missing: true,
            fda: root_path + "/images/qnx-demo-network-4.05.img",
            timeout: 300,
            expect_mouse_registered: true,
            expect_graphical_mode: true,
            expect_graphical_size: [640, 480],
            actions: [
                { run: " ", after: 30 * 1000 },
                { run: " ", after: 15 * 1000 },
                { run: " ", after: 15 * 1000 },
                { run: " ", after: 15 * 1000 },
                { run: " ", after: 15 * 1000 },
                { run: " ", after: 15 * 1000 },
                { run: " ", after: 15 * 1000 },
            ],
        },
        {
            name: "OpenBSD Floppy",
            fda: root_path + "/images/openbsd-floppy.img",
            timeout: 180,
            expected_texts: ["(I)nstall, (U)pgrade or (S)hell"],
        },
        {
            name: "OpenBSD",
            skip_if_disk_image_missing: true,
            hda: root_path + "/images/openbsd.img",
            timeout: 300,
            actions: [
                {
                    on_text: "boot>",
                    run: "boot -c\n",
                },
                {
                    on_text: "UKC>",
                    run: "disable mpbios\nexit\n",
                },
                {
                    on_text: "login:",
                    run: "root\n",
                },
                {
                    on_text: "Password:",
                    run: "root\n",
                },
            ],
            expected_texts: ["nyu# "],
        },
        {
            name: "Windows 3.0",
            slow: 1,
            skip_if_disk_image_missing: true,
            timeout: 10 * 60,
            cdrom: root_path + "/images/Win30.iso",
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
            name: "Windows 3.1",
            skip_if_disk_image_missing: true,
            timeout: 2 * 60,
            hda: root_path + "/images/win31.img",
            expect_graphical_mode: true,
            expect_graphical_size: [1024, 768],
            expect_mouse_registered: true,
            expected_texts: [
                "MODE prepare code page function completed",
            ],
        },
        {
            name: "FreeBSD",
            skip_if_disk_image_missing: true,
            timeout: 15 * 60,
            hda: root_path + "/images/internal/freebsd/freebsd.img",
            expected_texts: [
                "FreeBSD/i386 (nyu) (ttyv0)",
                "root@nyu:~ #",
            ],
            actions: [
                {
                    on_text: "   Autoboot in",
                    run: "\n",
                },
                {
                    // workaround for freebsd not accepting key inputs just before the boot prompt
                    // (probably needs delay between keydown and keyup)
                    on_text: "FreeBSD/i386 (nyu) (ttyv0)",
                    run: "\x08", // backspace to avoid messing with login prompt
                },
                {
                    on_text: "login:",
                    after: 1000,
                    run: "root\n",
                },
                {
                    on_text: "Password:",
                    after: 1000,
                    run: "\n",
                },
            ],
        },
        {
            name: "FreeBSD cdrom",
            skip_if_disk_image_missing: true,
            slow: 1,
            timeout: 10 * 60,
            cdrom: root_path + "/images/experimental/os/FreeBSD-11.0-RELEASE-i386-bootonly.iso",
            expected_texts: ["Welcome to FreeBSD!"],
            actions: [
                {
                    on_text: "   Autoboot in ",
                    run: "\n",
                }
            ],
        },
        {
            name: "Arch Linux",
            skip_if_disk_image_missing: true,
            timeout: 20 * 60,
            bzimage_initrd_from_filesystem: true,
            cmdline: [
                "rw apm=off vga=0x344 video=vesafb:ypan,vremap:8",
                "root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose mitigations=off",
                "audit=0 init=/usr/bin/init-openrc net.ifnames=0 biosdevname=0",
            ].join(" "),
            filesystem: {
                basefs: "images/fs.json",
                baseurl: "images/arch-nongz/",
            },
            expected_texts: [
                "root@localhost",
                "aaaaaaaaaaaaaaaaaaaa",
                "Hello, world",
                "Hello from JS",
                "Hello from OCaml",
                "Compress okay",
            ],
            actions: [
                {
                    on_text: "root@localhost",
                    run: `python -c 'print(100 * "a")'\n`,
                },
                {
                    on_text: "aaaaaaaaaaaaaaaaaaaa",
                    run: `gcc hello.c && ./a.out\n`,
                },
                {
                    on_text: "Hello, world",
                    run: `echo 'console.log("Hello from JS")' | node\n`,
                },
                {
                    on_text: "Hello from JS",
                    run: `echo 'print_endline "Hello from OCaml"' > hello.ml && ocamlopt hello.ml && ./a.out\n`,
                },
                {
                    on_text: "Hello from OCaml",
                    run:
                        "zstd hello.c && gzip -k hello.c && bzip2 -k hello.c && xz -k hello.c && lzma -k hello.c && " +
                        "zstdcat hello.c.zst && zcat hello.c.gz && bzcat hello.c.bz2 && xzcat hello.c.xz && lzmadec hello.c.lzma && " +
                        "echo Compress okay\n",
                },
                {
                    on_text: "Compress okay",
                    run: "./startx.sh\n",
                },
            ],
            expect_graphical_mode: true,
            expect_graphical_size: [1024, 768],
            expect_mouse_registered: true,
        },
        {
            name: "FreeGEM",
            skip_if_disk_image_missing: true,
            timeout: 60,
            hda: root_path + "/images/experimental/os/freegem.bin",
            expect_graphical_mode: true,
            expect_mouse_registered: true,
            actions: [
                {
                    on_text: "   Select from Menu",
                    run: "3",
                }
            ],
        },
        {
            name: "Haiku",
            skip_if_disk_image_missing: true,
            timeout: 15 * 60,
            memory_size: 512 * 1024 * 1024,
            hda: root_path + "/images/haiku-r1beta2-hrev54154_111-x86_gcc2h-anyboot.iso",
            expected_serial_text: [
                "init_hardware()",
                "Running post install script /boot/system/boot/post-install/sshd_keymaker.sh",
                // After pressing enter in the boot dialog:
                "Running first login script /boot/system/boot/first-login/default_deskbar_items.sh",
            ],
            expect_graphical_mode: true,
            expect_graphical_size: [1024, 768],
            expect_mouse_registered: true,
            actions: [
                { after: 1 * 60 * 1000, run: "\n" },
                { after: 2 * 60 * 1000, run: "\n" },
                { after: 3 * 60 * 1000, run: "\n" },
                { after: 4 * 60 * 1000, run: "\n" },
                { after: 5 * 60 * 1000, run: "\n" },
                { after: 6 * 60 * 1000, run: "\n" },
                { after: 7 * 60 * 1000, run: "\n" },
                { after: 8 * 60 * 1000, run: "\n" },
            ],
        },
        {
            name: "9front",
            skip_if_disk_image_missing: true,
            acpi: true,
            timeout: 5 * 60,
            hda: root_path + "/images/9front-7781.38dcaeaa222c.386.iso",
            expect_graphical_mode: true,
            expect_graphical_size: [1024, 768],
            expect_mouse_registered: true,
            actions: [
                { after: 60 * 1000, run: "\n" },
                { after: 70 * 1000, run: "\n" },
                { after: 80 * 1000, run: "\n" },
                { after: 90 * 1000, run: "\n" },
                { after: 100 * 1000, run: "\n" },
                { after: 110 * 1000, run: "\n" },
                { after: 120 * 1000, run: "\n" },
                { after: 130 * 1000, run: "\n" },
                { after: 140 * 1000, run: "\n" },
                { after: 150 * 1000, run: "\n" },
                { after: 160 * 1000, run: "\n" },
                { after: 170 * 1000, run: "\n" },
                { after: 180 * 1000, run: "\n" },
            ],
        },
        {
            name: "ReactOS",
            skip_if_disk_image_missing: true,
            timeout: 10 * 60,
            hda: root_path + "/images/reactos-livecd-0.4.15-dev-73-g03c09c9-x86-gcc-lin-dbg.iso",
            expect_graphical_mode: true,
            expect_graphical_size: [800, 600],
            expect_mouse_registered: true,
            actions: [
                { after: 1 * 60 * 1000, run: "\n" },
                { after: 2 * 60 * 1000, run: "\n" },
                { after: 3 * 60 * 1000, run: "\n" },
                { after: 4 * 60 * 1000, run: "\n" },
                { after: 5 * 60 * 1000, run: "\n" },
                { after: 6 * 60 * 1000, run: "\n" },
                { after: 7 * 60 * 1000, run: "\n" },
                { after: 8 * 60 * 1000, run: "\n" },
            ],
            expected_serial_text: [
                "DnsIntCacheInitialize()",
                // when desktop is rendered:
                "err: Attempted to close thread desktop",
            ],
        },
        {
            name: "ReactOS CD",
            skip_if_disk_image_missing: true,
            timeout: 10 * 60,
            cdrom: root_path + "/images/reactos-livecd-0.4.15-dev-73-g03c09c9-x86-gcc-lin-dbg.iso",
            expect_graphical_mode: true,
            expect_graphical_size: [800, 600],
            expect_mouse_registered: true,
            expected_serial_text: ["DnsIntCacheInitialize()"],
        },
        {
            name: "HelenOS",
            skip_if_disk_image_missing: true,
            timeout: 3 * 60,
            cdrom: root_path + "/images/experimental/os/HelenOS-0.5.0-ia32.iso",
            expect_graphical_mode: true,
            expect_mouse_registered: true,
        },
        {
            name: "Minix",
            skip_if_disk_image_missing: true,
            timeout: 60,
            hda: root_path + "/images/experimental/os/minix2hd.img",
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
            name: "Minix CD",
            skip_if_disk_image_missing: true,
            timeout: 3 * 60,
            cdrom: root_path + "/images/minix-3.3.0.iso",
            actions: [
                {
                    on_text: "login:",
                    run: "root\n",
                },
            ],
            expected_texts: ["login:", "We'd like your feedback", "# "],
        },
        {
            name: "Mobius",
            skip_if_disk_image_missing: true,
            timeout: 2 * 60,
            fda: root_path + "/images/mobius-fd-release5.img",
            expect_graphical_mode: true,
            actions: [
                {
                    on_text: "   The highlighted entry will be booted automatically",
                    run: "\n",
                },
            ],
        },
        {
            name: "Tiny Core 11 CD",
            skip_if_disk_image_missing: 1,
            timeout: 5 * 60,
            cdrom: root_path + "/images/TinyCore-11.0.iso",
            expect_graphical_mode: true,
            expect_mouse_registered: true,
            actions: [{ on_text: "                   BIOS default device boot in", run: "\n", after: 5000 }],
        },
        {
            name: "Tiny Core 11 HD",
            skip_if_disk_image_missing: 1,
            timeout: 5 * 60,
            cdrom: root_path + "/images/TinyCore-11.0.iso",
            expect_graphical_mode: true,
            expect_mouse_registered: true,
            actions: [{ on_text: "                   BIOS default device boot in", run: "\n", after: 5000 }],
        },
        {
            name: "Core 9",
            skip_if_disk_image_missing: 1,
            timeout: 5 * 60,
            cdrom: root_path + "/images/experimental/os/Core-9.0.iso",
            expected_texts: ["tc@box"],
            actions: [{ on_text: "boot:", run: "\n" }],
        },
        {
            name: "Core 8",
            skip_if_disk_image_missing: 1,
            timeout: 5 * 60,
            cdrom: root_path + "/images/experimental/os/Core-8.0.iso",
            expected_texts: ["tc@box"],
            actions: [{ on_text: "boot:", run: "\n" }],
        },
        {
            name: "Core 7",
            skip_if_disk_image_missing: 1,
            timeout: 5 * 60,
            cdrom: root_path + "/images/experimental/os/Core-7.2.iso",
            expected_texts: ["tc@box"],
            actions: [{ on_text: "boot:", run: "\n" }],
        },
        {
            name: "Core 6",
            skip_if_disk_image_missing: 1,
            timeout: 5 * 60,
            cdrom: root_path + "/images/experimental/os/Core-6.4.1.iso",
            expected_texts: ["tc@box"],
            actions: [{ on_text: "boot:", run: "\n" }],
        },
        {
            name: "Core 5",
            skip_if_disk_image_missing: 1,
            timeout: 5 * 60,
            cdrom: root_path + "/images/experimental/os/Core-5.4.iso",
            expected_texts: ["tc@box"],
            actions: [{ on_text: "boot:", run: "\n" }],
        },
        {
            name: "Core 4",
            skip_if_disk_image_missing: 1,
            timeout: 5 * 60,
            cdrom: root_path + "/images/experimental/os/Core-4.7.7.iso",
            expected_texts: ["tc@box"],
            actions: [{ on_text: "boot:", run: "\n" }],
        },
        {
            name: "Damn Small Linux",
            skip_if_disk_image_missing: 1,
            timeout: 5 * 60,
            cdrom: root_path + "/images/dsl-4.11.rc2.iso",
            expect_graphical_mode: true,
            expect_graphical_size: [1024, 768],
            expect_mouse_registered: true,
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
            if(signal)
            {
                console.warn("Worker killed by signal " + signal);
                process.exit(1);
            }
            else if(code !== 0)
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

    let image = test.fda || test.hda || test.cdrom || test.bzimage || test.filesystem && test.filesystem.basefs;
    assert(image, "Bootable drive expected");

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
    else if(TEST_RELEASE_BUILD)
    {
        var bios = root_path + "/bios/seabios.bin";
        var vga_bios = root_path + "/bios/vgabios.bin";
    }
    else
    {
        var bios = root_path + "/bios/seabios-debug.bin";
        var vga_bios = root_path + "/bios/vgabios-debug.bin";
    }

    var settings = {
        bios: { url: bios },
        vga_bios: { url: vga_bios },
        autostart: true,
        memory_size: test.memory_size || 128 * 1024 * 1024,
        log_level: 0,
        cmdline: test.cmdline,
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
    settings.acpi = test.acpi;

    if(test.expected_texts)
    {
        test.expected_texts = test.expected_texts.map(string_to_bytearray);
    }
    else
    {
        test.expected_texts = [];
    }

    if(!test.expected_serial_text)
    {
        test.expected_serial_text = [];
    }

    var emulator = new V86(settings);
    var screen = new Uint8Array(SCREEN_WIDTH * 25);

    function check_text_test_done()
    {
        return test.expected_texts.length === 0;
    }

    function check_serial_test_done()
    {
        return test.expected_serial_text.length === 0;
    }

    var mouse_test_done = false;
    function check_mouse_test_done()
    {
        return !test.expect_mouse_registered || mouse_test_done;
    }

    var graphical_test_done = false;
    var size_test_done = false;
    function check_graphical_test_done()
    {
        return !test.expect_graphical_mode || (graphical_test_done && (!test.expect_graphical_size || size_test_done));
    }

    var test_start = Date.now();

    var timeout_seconds = test.timeout * TIMEOUT_EXTRA_FACTOR;
    var timeout = setTimeout(check_test_done, (timeout_seconds + 1) * 1000);
    var timeouts = [timeout];

    var on_text = [];
    var stopped = false;

    var screen_interval = null;

    function check_test_done()
    {
        if(stopped)
        {
            return;
        }

        if(check_text_test_done() &&
            check_mouse_test_done() &&
            check_graphical_test_done() &&
            check_serial_test_done())
        {
            var end = Date.now();

            for(let timeout of timeouts) clearTimeout(timeout);
            stopped = true;

            emulator.stop();

            if(screen_interval !== null)
            {
                clearInterval(screen_interval);
            }

            console.warn("Passed test: %s (took %ds)", test.name, (end - test_start) / 1000);
            console.warn();

            done();
        }
        else if(Date.now() >= test_start + timeout_seconds * 1000)
        {
            for(let timeout of timeouts) clearTimeout(timeout);
            stopped = true;

            if(screen_interval !== null)
            {
                clearInterval(screen_interval);
            }

            emulator.stop();
            emulator.destroy();

            if(test.failure_allowed)
            {
                console.warn("Test failed: %s (failure allowed)\n", test.name);
            }
            else
            {
                console.warn(screen_to_text(screen));
                console.warn("Test failed: %s\n", test.name);
            }

            if(!check_text_test_done())
            {
                console.warn('Expected text "%s" after %d seconds.', bytearray_to_string(test.expected_texts[0]), timeout_seconds);
            }

            if(!check_graphical_test_done())
            {
                console.warn("Expected graphical mode after %d seconds.", timeout_seconds);
            }

            if(!check_mouse_test_done())
            {
                console.warn("Expected mouse activation after %d seconds.", timeout_seconds);
            }

            if(!check_serial_test_done())
            {
                console.warn('Expected serial text "%s" after %d seconds.', test.expected_serial_text, timeout_seconds);
            }

            if(on_text.length)
            {
                console.warn(`Note: Expected text "${bytearray_to_string(on_text[0].text)}" to run "${on_text[0].run}"`);
            }

            if(!test.failure_allowed)
            {
                process.exit(1);
            }
            else
            {
                done();
            }
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
                if(VERBOSE) console.log(`Passed: "${bytearray_to_string(expected)}" on screen (${test.name})`);
                check_test_done();
            }
        }

        if(on_text.length)
        {
            let expected = on_text[0].text;

            if(x < expected.length && bytearray_starts_with(line, expected))
            {
                var action = on_text.shift();

                timeouts.push(
                    setTimeout(() => {
                        if(VERBOSE) console.error("Sending '%s'", action.run);
                        emulator.keyboard_send_text(action.run);
                    }, action.after || 0)
                );
            }
        }
    });

    if(LOG_SCREEN)
    {
        screen_interval = setInterval(() => {
            console.warn(screen_to_text(screen));
        }, 10000);
    }

    let serial_line = "";
    emulator.add_listener("serial0-output-char", function(c)
        {
            if(c === "\n")
            {
                if(VERBOSE)
                {
                    console.log(`Serial (${test.name}):`, serial_line);
                }

                if(test.expected_serial_text.length)
                {
                    const expected = test.expected_serial_text[0];
                    if(serial_line.includes(expected))
                    {
                        test.expected_serial_text.shift();
                        if(VERBOSE) console.log(`Passed: "${expected}" on serial (${test.name})`);
                        check_test_done();
                    }
                }

                serial_line = "";
            }
            else if(c >= " " && c <= "~")
            {
                serial_line += c;
            }
        });

    test.actions && test.actions.forEach(function(action)
    {
        if(action.on_text)
        {
            on_text.push({ text: string_to_bytearray(action.on_text), run: action.run, after: action.after });
        }
        else
        {
            timeouts.push(
                setTimeout(() => {
                    if(VERBOSE) console.error("Sending '%s'", action.run);
                    emulator.keyboard_send_text(action.run);
                }, action.after || 0)
            );
        }
    });
}
