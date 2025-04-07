#!/usr/bin/env node

import assert from "assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const SHOW_LOGS = false;

function wait(time) {
    return new Promise((res) => setTimeout(res, time));
}

let s1;
const tests =
[
    {
        name: "Use space",
        start: async () =>
        {
            emulator.serial0_send("udhcpc\n");
            emulator.serial0_send("free -h\n");
            emulator.serial0_send("lspci -k\n");
            emulator.serial0_send("dd if=/dev/urandom of=/tmp/file bs=1M count=64\n");
            emulator.serial0_send("du -h /tmp/file\n");
            emulator.serial0_send("free -h\n");
            emulator.serial0_send("rm /tmp/file\n");
            emulator.serial0_send("free -h\n");
            emulator.serial0_send("echo done\n");
        },
        end_trigger: "done",
        end: (capture) =>
        {
        },
    },
    {
        name: "Delete space",
        start: async () =>
        {
            emulator.serial0_send("echo 3 > /proc/sys/vm/drop_caches\n");
            emulator.serial0_send("df -h; echo done\n");
        },
        end_trigger: "done",
        end: (capture) =>
        {
        },
    },
    {
        name: "Reclaim space",
        start: async () =>
        {
            s1 = await emulator.save_state();
            emulator.v86.cpu.devices.virtio_balloon.GetStats(s => { console.log(s); });
            emulator.v86.cpu.devices.virtio_balloon.Cleanup(async (zeroed) => {
                console.log("Zeroed ", zeroed / 1024 / 1024, "MB of pages");
                await wait(2000);
                emulator.serial0_send("echo done\n");
            });
        },
        end_trigger: "done",
        end: async (capture) =>
        {
            let s2 = await emulator.save_state();
            let saved = s1.byteLength - s2.byteLength;
            console.log(`Saved ${saved>>20}MB of ${s1.byteLength>>20}MB (${saved/s1.byteLength*100}%)`);
            assert(saved > 1000000, "not enough space saved");
            emulator.serial0_send("echo done\n");
        },
    },
    {
        name: "Wait",
        start: async () =>
        {
        },
        end_trigger: "done",
        end: async (capture) =>
        {
        },
    },
    {
        name: "Get Memory",
        start: async () =>
        {
            emulator.serial0_send("free -m; echo done\n");
        },
        end_trigger: "done",
        end: async (capture) =>
        {
        },
    },
    {
        name: "Inflate Balloon",
        start: async () =>
        {
            emulator.v86.cpu.devices.virtio_balloon.Inflate(30000);
            await wait(1000);
            emulator.serial0_send("free -m; echo done\n");
        },
        end_trigger: "done",
        end: async (capture) =>
        {
            assert(emulator.v86.cpu.devices.virtio_balloon.actual === 30000, "Got 30000 pages from vm");
        },
    },
];


const emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    bzimage: { url: __dirname + "/../../images/buildroot-bzimage68.bin" },
    autostart: true,
    memory_size: 200 * 1024 * 1024,
    disable_jit: +process.env.DISABLE_JIT,
    virtio_console: true,
    virtio_balloon: true,
    uart0: true,
    net_device: {
        relay_url: "fetch",
        type: "virtio",
    },
    log_level: SHOW_LOGS ? 0x400000 : 0,
    cmdline: "console=/dev/ttyS0"
});

let test_num = 0;
let booted = false;
let line = "";
let capture = "";
let end_trigger;

emulator.bus.register("emulator-started", function()
{
    console.log("Booting now, please stand by");
});

emulator.add_listener("serial0-output-byte", function(byte)
{
    const chr = String.fromCharCode(byte);
    if(chr < " " && chr !== "\n" && chr !== "\t" || chr > "~")
    {
        return;
    }

    let new_line = "";
    if(chr === "\n")
    {
        console.log("    Captured: %s", line);
        new_line = line;
        capture += line + "\n";
        line = "";
    }
    else
    {
        line += chr;
    }

    if(new_line === end_trigger)
    {
        let test_has_failed = false;

        try {
            tests[test_num].end(capture);
        } catch(e) {
            console.log(e);
            test_has_failed = true;
        }

        if(!test_has_failed)
        {
            console.log("[+] Test #%d passed: %s", test_num, tests[test_num].name);
        }
        else
        {
            if(tests[test_num].allow_failure)
            {
                console.warn("[!] Test #%d failed: %s (failure allowed)", test_num, tests[test_num].name);
            }
            else
            {
                console.error("[-] Test #%d failed: %s", test_num, tests[test_num].name);
                process.exit(1);
            }
        }

        test_num++;

    }

    if(!booted && line.endsWith("~% ") || new_line === end_trigger)
    {
        booted = true;

        if(test_num >= tests.length)
        {
            emulator.destroy();

            console.log("Tests finished.");
        }
        else
        {
            console.log("Starting test #%d: %s", test_num, tests[test_num].name);

            capture = "";
            end_trigger = tests[test_num].end_trigger;

            tests[test_num].start();
        }
    }
});
