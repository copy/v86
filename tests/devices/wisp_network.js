#!/usr/bin/env -S node --experimental-websocket

import assert from "assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const SHOW_LOGS = false;

const tests =
[
    {
        name: "DHCP",
        start: () =>
        {
            emulator.serial0_send("udhcpc\n");
            emulator.serial0_send("echo -e done\\\\tudhcpc\n");
        },
        end_trigger: "done\tudhcpc",
        end: (capture) =>
        {
            assert(/lease of 192.168.86.100 obtained/.test(capture), "lease of 192.168.86.100 obtained");
        },
    },
    {
        name: "ifconfig",
        start: () =>
        {
            emulator.serial0_send("ifconfig\n");
            emulator.serial0_send("echo -e done\\\\tifconfig\n");
        },
        end_trigger: "done\tifconfig",
        end: (capture) =>
        {
            assert(/192.168.86.100/.test(capture), "192.168.86.100");
        },
    },
    {
        name: "route",
        start: () =>
        {
            emulator.serial0_send("ip route\n");
            emulator.serial0_send("echo -e done\\\\troute\n");
        },
        end_trigger: "done\troute",
        end: (capture) =>
        {
            assert(/192.168.86.1/.test(capture), "192.168.86.100");
        },
    },
    //{
    //    name: "arp -a",
    //    start: () =>
    //    {
    //        emulator.serial0_send("arp -a\n");
    //        emulator.serial0_send("echo -e done\\\\tarp\n");
    //    },
    //    end_trigger: "done\tarp",
    //    end: (capture) =>
    //    {
    //        assert(/.192.168.86.1. at 52:54:00:01:02:03 \[ether\] {2}on eth0/.test(capture), "(192.168.86.1) at 52:54:00:01:02:03 [ether]  on eth0");
    //    },
    //},
    {
        name: "Curl example.org",
        allow_failure: true,
        start: () =>
        {
            emulator.serial0_send("wget -T 10 -O - example.org\n");
            emulator.serial0_send("echo -e done\\\\texample.org\n");
        },
        end_trigger: "done\texample.org",
        end: (capture) =>
        {
            assert(/This domain is for use in illustrative examples in documents/.test(capture), "got example.org text");
        },
    },

];

const emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux4.iso" },
    autostart: true,
    memory_size: 64 * 1024 * 1024,
    disable_jit: +process.env.DISABLE_JIT,
    network_relay_url: "wisps://wisp.mercurywork.shop/",
    log_level: SHOW_LOGS ? 0x400000 : 0,
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
