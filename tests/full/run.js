#!/usr/bin/env node

import assert from "node:assert/strict";
import cluster from "node:cluster";
import os from "node:os";
import fs from "node:fs";
import url from "node:url";

// config variables
const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const TIMEOUT_EXTRA_FACTOR = +process.env.TIMEOUT_EXTRA_FACTOR || 1;
const MAX_PARALLEL_TESTS = +process.env.MAX_PARALLEL_TESTS || 4;
const TEST_NAME = process.env.TEST_NAME;
const RUN_SLOW_TESTS = +process.env.RUN_SLOW_TESTS;
const LOG_LEVEL = +process.env.LOG_LEVEL || 0;
const DISABLE_JIT = +process.env.DISABLE_JIT;
const TEST_ACPI = +process.env.TEST_ACPI;

const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

process.on("unhandledRejection", exn => { throw exn; });

const VERBOSE = false;
const LOG_SCREEN = false;


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
    return String.fromCharCode.apply(String, arr).replace(/[\x00-\x08\x0b-\x1f\x7f\x80-\xff]/g, " ");
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

if(cluster.isPrimary)
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
            name: "Windows XP CD",
            skip_if_disk_image_missing: true,
            cdrom: root_path + "/images/experimental/VirtualXP.iso",
            memory_size: 512 * 1024 * 1024,
            timeout: 600,
            expect_graphical_mode: true,
            expect_graphical_size: [800, 600],
            expect_mouse_registered: true,
            acpi: false, // XXX: fails with acpi on
        },
        {
            name: "Windows XP HD",
            skip_if_disk_image_missing: true,
            hda: root_path + "/images/experimental/copy_winxp_lite-from-pixelsuft.img",
            memory_size: 512 * 1024 * 1024,
            timeout: 300,
            expect_graphical_mode: true,
            expect_graphical_size: [800, 600],
            expect_mouse_registered: true,
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
        {
            name: "Windows NT 4.0",
            skip_if_disk_image_missing: true,
            hda: root_path + "/images/winnt4_noacpi.img",
            memory_size: 512 * 1024 * 1024,
            timeout: 60,
            expect_graphical_mode: true,
            expect_graphical_size: [1024, 768],
            expect_mouse_registered: true,
            cpuid_level: 2,
        },
        {
            name: "Windows NT 3.1",
            skip_if_disk_image_missing: true,
            hda: root_path + "/images/winnt31.img",
            memory_size: 256 * 1024 * 1024,
            timeout: 60,
            expect_graphical_mode: true,
            expect_graphical_size: [640, 480],
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
            timeout: 120,
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
            hda: root_path + "/images/msdos.img",
            timeout: 90,
            expected_texts: [
                "C:\\>",
            ],
        },
        {
            name: "MS-DOS (hard disk + floppy disk)",
            hda: root_path + "/images/msdos.img",
            fda: root_path + "/images/kolibri.img",
            boot_order: 0x132,
            timeout: 90,
            actions: [
                { on_text: "C:\\>", run: "a:\n" },
            ],
            expected_texts: [
                "A:\\>",
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
            bzimage: root_path + "/images/buildroot-bzimage68.bin",
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
            name: "OpenBSD state image",
            timeout: 60,
            memory_size: 256 * 1024 * 1024,
            skip_if_disk_image_missing: true,
            hda: root_path + "/images/openbsd.img",
            state: root_path + "/images/openbsd_state-v2.bin.zst",
            actions: [
                {
                    after: 1 * 1000,
                    run: `echo 'main(){printf("it");puts(" works");}' > a.c; clang a.c; ./a.out\n`,
                }
            ],
            expected_texts: [
                "it works",
            ],
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
            hda: root_path + "/images/freebsd.img",
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
            memory_size: 512 * 1024 * 1024,
            cmdline: [
                "rw apm=off vga=0x344 video=vesafb:ypan,vremap:8",
                "root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose mitigations=off",
                "audit=0 init=/usr/bin/init-openrc net.ifnames=0 biosdevname=0",
            ].join(" "),
            filesystem: {
                basefs: "images/fs.json",
                baseurl: "images/arch/",
            },
            expected_texts: [
                "root@localhost",
                "aaaaaaaaaaaaaaaaaaaa",
                "Hello, world",
                "Hello from JS",
                "Hello from OCaml",
                "Compress okay",
                "v86-in-v86 okay",
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
                    run:
                        RUN_SLOW_TESTS ?
                            "./v86-in-v86.js | tee /dev/stderr | grep -m1 'Files send via emulator appear in' ; sleep 2; echo; echo v86-in-v86 okay\n"
                        :
                            "./v86-in-v86.js | tee /dev/stderr | grep -m1 'Kernel command line:' ; sleep 2; echo; echo v86-in-v86 okay\n",
                },
                {
                    on_text: "v86-in-v86 okay",
                    run: "./startx.sh\n",
                },
            ],
            expect_graphical_mode: true,
            expect_graphical_size: [1024, 768],
            expect_mouse_registered: true,
        },
        {
            name: "Arch Linux state image",
            skip_if_disk_image_missing: true,
            timeout: 60,
            memory_size: 512 * 1024 * 1024,
            filesystem: {
                basefs: "images/fs.json",
                baseurl: "images/arch/",
            },
            state: "images/arch_state-v3.bin.zst",
            net_device: { type: "virtio" },
            actions: [
                { after: 1000, run: "ls --color=never /dev/ /usr/bin/ > /dev/ttyS0\n" },
                { after: 2000, run: `python -c 'print(100 * "a")' > /dev/ttyS0\n` },
            ],
            expected_serial_text: [
                "ttyS0",
                "syslinux-install_update",
                "aaaaaaaaaaaaaaaaaaaa",
            ],
        },
        {
            name: "Arch Linux (with fda, cdrom, hda and hdb)",
            skip_if_disk_image_missing: true,
            timeout: 5 * 60,
            bzimage_initrd_from_filesystem: true,
            memory_size: 512 * 1024 * 1024,
            cmdline: [
                "rw apm=off vga=0x344 video=vesafb:ypan,vremap:8",
                "root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose mitigations=off",
                "audit=0 init=/usr/bin/init-openrc net.ifnames=0 biosdevname=0",
            ].join(" "),
            filesystem: {
                basefs: "images/fs.json",
                baseurl: "images/arch/",
            },
            hda: root_path + "/images/w95.img",
            hdb: root_path + "/images/FiwixOS-3.4-i386.img",
            cdrom: root_path + "/images/dsl-4.11.rc2.iso",
            fda: root_path + "/images/freedos722.img",
            actions: [
                {
                    on_text: "root@localhost",
                    run: "modprobe floppy && mkdir /mnt/{a,b,c,f} && mount /dev/sda1 /mnt/a && mount /dev/sdb2 /mnt/b && mount /dev/sr0 /mnt/c && mount /dev/fd0 /mnt/f && ls /mnt/*\n",
                },
            ],
            expected_texts: [
                "bin   dev  home",                          // fiwix
                " AUTOEXEC.BAT   CONFIG.WIN   MSDOS.SYS",   // w95
                "KNOPPIX  boot  index.html",                // DSL
                "FDOS          README      debug.com",      // freedos
            ],
        },
        {
            name: "FreeGEM",
            skip_if_disk_image_missing: true,
            timeout: 60,
            hda: root_path + "/images/freegem.bin",
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
            acpi: true,
        },
        {
            name: "Haiku state image",
            skip_if_disk_image_missing: true,
            timeout: 60,
            memory_size: 512 * 1024 * 1024,
            hda: root_path + "/images/haiku-v5.img",
            state: root_path + "/images/haiku_state-v5.bin.zst",
            actions: [
                {
                    after: 2 * 1000,
                    run: `echo 'let rec f=function 0|1->1|x->f(x-1)+f(x-2)in Printf.printf"%d\n"(f 25)' | ocaml -stdin > /dev/ports/pc_serial0\n`
                },
            ],
            expected_serial_text: [
                "121393",
            ],
            acpi: true,
        },
        {
            name: "9front",
            use_small_bios: true, // has issues with 256k bios
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
            name: "ReactOS state image",
            skip_if_disk_image_missing: true,
            memory_size: 512 * 1024 * 1024,
            acpi: true,
            net_device: { type: "virtio" },
            timeout: 60,
            hda: root_path + "/images/reactos-v3.img",
            state: root_path + "/images/reactos_state-v3.bin.zst",
            actions: [
                { after: 5 * 1000, run: [0xE0, 0x5B, 0x13, 0x93, 0xE0, 0xDB] }, // meta+r
                { after: 10 * 1000, run: "cmd\n" },
                { after: 15 * 1000, run: "echo it works > COM1\n" },
            ],
            expected_serial_text: [
                "it works",
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
            cdrom: root_path + "/images/HelenOS-0.11.2-ia32.iso",
            expect_graphical_mode: true,
            expect_mouse_registered: true,
            expected_serial_text: ["init: Spawning"],
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
            name: "Mojo OS",
            skip_if_disk_image_missing: true,
            timeout: 60,
            cdrom: root_path + "/images/mojo-0.2.2.iso",
            actions: [
                {
                    on_text: "/> ",
                    run: "help\n",
                },
            ],
            expected_texts: ["Mojo test shell", "See manual pages for more information"],
            expected_serial_text: [" ===> Shell loaded"],
            expect_mouse_registered: true,
        },
        {
            name: "Vanadium OS",
            skip_if_disk_image_missing: true,
            timeout: 60,
            cdrom: root_path + "/images/vanadiumos.iso",
            actions: [
                { after: 2000, run: " " },
                { after: 2100, run: " " },
                { after: 2200, run: " " },
                { after: 2300, run: " " },
                { after: 2400, run: " " },
                { after: 2500, run: " " },
                { after: 2600, run: " " },
                { after: 2700, run: " " },
                { after: 2800, run: "c" },
            ],
            expect_mouse_registered: true,
            expect_graphical_mode: true,
        },
        {
            name: "Asuro",
            skip_if_disk_image_missing: true,
            timeout: 60,
            cdrom: root_path + "/images/asuro.iso",
            expect_mouse_registered: true,
            expect_graphical_mode: true,
            expected_serial_text: ["Asuro Booted Correctly!"],
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
            acpi: false, // segfaults with acpi on (also in other emulators)
        },
        {
            name: "FreeNOS",
            skip_if_disk_image_missing: true,
            timeout: 2 * 60,
            cdrom: root_path + "/images/FreeNOS-1.0.3.iso",
            acpi: true,
            actions: [
                {
                    on_text: "login:",
                    run: "root\n",
                },
            ],
            expected_texts: ["login:", "(localhost)"],
            expected_serial_text: ["FreeNOS 1.0.3"],
        },
        {
            name: "SerenityOS",
            skip_if_disk_image_missing: true,
            timeout: 2 * 60,
            hda: root_path + "/images/serenity.img",
            expect_graphical_mode: true,
            expect_graphical_size: [1024, 768],
            expect_mouse_registered: true,
        },
        {
            name: "Redox",
            skip_if_disk_image_missing: true,
            timeout: 5 * 60,
            memory_size: 512 * 1024 * 1024,
            acpi: true,
            hda: root_path + "/images/redox_demo_i686_2022-11-26_643_harddrive.img",
            actions: [
                { on_text: "Arrow keys and enter select mode", run: "\n" },
            ],
            expect_graphical_mode: true,
            expect_mouse_registered: true,
            expected_serial_text: ["# Login with the following:"],
        },
        {
            name: "Android 1.6",
            skip_if_disk_image_missing: true,
            timeout: 2 * 60,
            cdrom: root_path + "/images/android-x86-1.6-r2.iso",
            expect_graphical_mode: true,
            expect_graphical_size: [800, 600],
            expect_mouse_registered: true,
        },
        {
            name: "Android 4.4",
            skip_if_disk_image_missing: true,
            timeout: 5 * 60,
            hda: root_path + "/images/android_x86_nonsse3_4.4r1_20140904.iso",
            expect_graphical_mode: true,
            expect_graphical_size: [800, 600],
            expect_mouse_registered: true,
        },
        {
            name: "Syllable",
            skip_if_disk_image_missing: true,
            timeout: 60,
            memory_size: 512 * 1024 * 1024,
            hda: root_path + "/images/syllable-destop-0.6.7.img",
            expect_graphical_mode: true,
            expect_mouse_registered: true,
        },
        {
            name: "Mu",
            skip_if_disk_image_missing: true,
            timeout: 60,
            memory_size: 256 * 1024 * 1024,
            hda: root_path + "/images/mu-shell.img",
            expect_graphical_mode: true,
            expect_mouse_registered: true,
        },
        {
            name: "FreeDOS boot floppy 160K", // source: https://github.com/codercowboy/freedosbootdisks/tree/master/bootdisks
            skip_if_disk_image_missing: true,
            fda: root_path + "/images/experimental/freedos-fds/freedos.boot.disk.160K.img",
            timeout: 10,
            expected_texts: [
                "A:\\>",
            ],
        },
        {
            name: "FreeDOS boot floppy 180K",
            skip_if_disk_image_missing: true,
            fda: root_path + "/image/experimentals/freedos-fds/freedos.boot.disk.180K.img",
            timeout: 10,
            expected_texts: [
                "A:\\>",
            ],
        },
        {
            name: "FreeDOS boot floppy 320K",
            skip_if_disk_image_missing: true,
            fda: root_path + "/image/experimentals/freedos-fds/freedos.boot.disk.320K.img",
            timeout: 10,
            expected_texts: [
                "A:\\>",
            ],
        },
        {
            name: "FreeDOS boot floppy 360K",
            skip_if_disk_image_missing: true,
            fda: root_path + "/image/experimentals/freedos-fds/freedos.boot.disk.360K.img",
            timeout: 10,
            expected_texts: [
                "A:\\>",
            ],
        },
        {
            name: "FreeDOS boot floppy 640K",
            skip_if_disk_image_missing: true,
            fda: root_path + "/image/experimentals/freedos-fds/freedos.boot.disk.640K.img",
            timeout: 10,
            expected_texts: [
                "A:\\>",
            ],
        },
        {
            name: "FreeDOS boot floppy 1200K",
            skip_if_disk_image_missing: true,
            fda: root_path + "/image/experimentals/freedos-fds/freedos.boot.disk.1200K.img",
            timeout: 10,
            expected_texts: [
                "A:\\>",
            ],
        },
        {
            name: "ASM Space Invaders",
            skip_if_disk_image_missing: true,
            timeout: 10,
            fda: root_path + "/images/space-invaders.img", // non-standard floppy disk size, reads past end of original image
            expected_texts: [
                "                             #   SPACE INVADERS   # ",
            ],
        },
        {
            name: "NetBSD multiboot",
            skip_if_disk_image_missing: true,
            timeout: 15,
            memory_size: 256 * 1024 * 1024,
            multiboot: root_path + "/images/netbsd9.3-kernel-multiboot.img",
            expected_texts: [
                // NOTE: doesn't success booting yet, just testing the multiboot boot
                "[   1.0000000] multiboot:",
            ],
        },
        {
            name: "Crazierl",
            skip_if_disk_image_missing: true,
            timeout: 60,
            memory_size: 256 * 1024 * 1024,
            multiboot: root_path + "/images/crazierl-elf.img",
            initrd: root_path + "/images/crazierl-initrd.img",
            cmdline: "kernel /libexec/ld-elf32.so.1",
            acpi: true,
            expected_serial_text: [
                "Welcome to Crazierl:",
            ],
        },
        {
            name: "Fiwix",
            skip_if_disk_image_missing: true,
            timeout: 2 * 60,
            memory_size: 512 * 1024 * 1024,
            hda: root_path + "/images/FiwixOS-3.4-i386.img",
            expect_graphical_mode: true,
            expect_mouse_registered: true,
            expected_texts: [
                "(root):~#",
            ],
            actions: [
                { on_text: "(root):~#", run: "/usr/games/lsdoom\n" },
            ],
        },
        {
            name: "9legacy",
            use_small_bios: true, // has issues with 256k bios
            skip_if_disk_image_missing: true,
            net_device: { type: "none" }, // if netdevice is found, waits for dhcp before starting desktop
            timeout: 5 * 60,
            memory_size: 512 * 1024 * 1024,
            hda: root_path + "/images/9legacy.img",
            expect_graphical_mode: true,
            expect_mouse_registered: true,
            expected_texts: [
                "Selection:",
            ],
            actions: [
                { on_text: "Selection:", run: "1\n" },
            ],
            expected_serial_text: [
                "init: starting",
            ],
        },
        {
            name: "BSD/OS 3",
            skip_if_disk_image_missing: true,
            net_device: { type: "none" }, // executes 16-bit io instructions
            timeout: 5 * 60,
            memory_size: 512 * 1024 * 1024,
            cdrom: root_path + "/images/experimental/bsdos-3.0-binary.iso",
            fda: root_path + "/images/experimental/bsdos3-install-floppy.img",
            expected_texts: ["\xc9\xcd BSD/OS Installation"],
            boot_order: 0x321,
        },
        {
            name: "BSD/OS 4",
            skip_if_disk_image_missing: true,
            net_device: { type: "none" }, // executes 16-bit io instructions
            timeout: 5 * 60,
            memory_size: 512 * 1024 * 1024,
            cdrom: root_path + "/images/experimental/bsdos-4.3-x86-binary.iso",
            expected_texts: ["\xc9\xcd BSD/OS Installation"],
        },
        {
            name: "Arch Hurd",
            skip_if_disk_image_missing: true,
            net_device: { type: "none" }, // executes 16-bit io instructions
            timeout: 5 * 60,
            memory_size: 512 * 1024 * 1024,
            hda: root_path + "/images/archhurd-2018.09.28.img",
            expected_texts: ["sh-4.4# "],
        },
        {
            name: "Linux with Postgres",
            skip_if_disk_image_missing: true,
            timeout: 5 * 60,
            memory_size: 512 * 1024 * 1024,
            cdrom: root_path + "/images/experimental/linux-postgres.iso",
            expected_texts: [
                "performing post-bootstrap initialization",
                "syncing data to disk",
                "Success. You can now start the database server using",
            ],
        },
        {
            name: "Tiny Core 11 CD",
            skip_if_disk_image_missing: 1,
            timeout: 10 * 60,
            cdrom: root_path + "/images/TinyCore-11.0.iso",
            expect_graphical_mode: true,
            expect_mouse_registered: true,
            actions: [{ on_text: "                   BIOS default device boot in", run: "\n", after: 5000 }],
        },
        {
            name: "Tiny Core 11 HD",
            skip_if_disk_image_missing: 1,
            timeout: 10 * 60,
            hda: root_path + "/images/TinyCore-11.0.iso",
            expect_graphical_mode: true,
            expect_mouse_registered: true,
            actions: [{ on_text: "                   BIOS default device boot in", run: "\n", after: 5000 }],
        },
        {
            name: "Core 9 (with hard disk)",
            skip_if_disk_image_missing: 1,
            timeout: 5 * 60,
            cdrom: root_path + "/images/experimental/os/Core-9.0.iso",
            fda: root_path + "/images/freedos722.img",
            boot_order: 0x213,
            actions: [
                { on_text: "boot:", run: "\n" },
                { on_text: "tc@box", run: "sudo mount /dev/fd0 /mnt && ls /mnt\n" },
            ],
            expected_texts: ["AUTOEXEC.BAT"],
        },
        {
            name: "Core 9 (with hard disk)",
            skip_if_disk_image_missing: 1,
            timeout: 5 * 60,
            cdrom: root_path + "/images/experimental/os/Core-9.0.iso",
            hda: root_path + "/images/TinyCore-11.0.iso",
            boot_order: 0x213,
            actions: [
                { on_text: "boot:", run: "\n" },
                { on_text: "tc@box", run: "sudo mount /dev/sda1 /mnt && ls /mnt\n" },
            ],
            expected_texts: ["boot/ cde/"],
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
    process.send("up");
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

    const images = [test.fda, test.hda, test.cdrom, test.bzimage, test.multiboot, test.filesystem && test.filesystem.basefs].filter(x => x);
    assert(images.length, "Bootable drive expected");

    const missing_images = images.filter(i => !fs.existsSync(i));
    if(missing_images.length)
    {
        if(test.skip_if_disk_image_missing)
        {
            console.warn("Missing disk image: " + missing_images.join(", ") + ", test skipped");
            console.warn();

            done();
            return;
        }
        else
        {
            console.warn("Missing disk image: " + missing_images.join(", "));
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
    else if(test.use_small_bios || TEST_RELEASE_BUILD)
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
        log_level: LOG_LEVEL,
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
    if(test.hdb)
    {
        settings.hdb = { url: test.hdb, async: true };
    }
    if(test.state)
    {
        settings.initial_state = { url: test.state };
    }
    if(test.bzimage)
    {
        settings.bzimage = { url: test.bzimage };
    }
    if(test.multiboot)
    {
        settings.multiboot = { url: test.multiboot };
    }
    if(test.initrd)
    {
        settings.initrd = { url: test.initrd };
    }
    if(test.filesystem)
    {
        settings.filesystem = test.filesystem;
    }
    settings.cmdline = test.cmdline;
    settings.bzimage_initrd_from_filesystem = test.bzimage_initrd_from_filesystem;
    settings.acpi = test.acpi === undefined && !test.state ? TEST_ACPI : test.acpi;
    settings.boot_order = test.boot_order;
    settings.cpuid_level = test.cpuid_level;
    settings.net_device = test.net_device;
    settings.disable_jit = DISABLE_JIT;

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

    emulator.add_listener("screen-set-size", function(args)
    {
        const [w, h, bpp] = args;
        graphical_test_done = bpp !== 0;

        if(test.expect_graphical_size)
        {
            size_test_done = w === test.expect_graphical_size[0] && h === test.expect_graphical_size[1];
        }

        check_test_done();
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
                        if(typeof action.run[0] === "string") emulator.keyboard_send_text(action.run, 10);
                        else emulator.keyboard_send_scancodes(action.run, 10);
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
    emulator.add_listener("serial0-output-byte", function(byte)
        {
            var c = String.fromCharCode(byte);
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
                    if(typeof action.run[0] === "string") emulator.keyboard_send_text(action.run, 10);
                    else emulator.keyboard_send_scancodes(action.run, 10);
                }, action.after || 0)
            );
        }
    });
}
