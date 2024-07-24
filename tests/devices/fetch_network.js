#!/usr/bin/env node
"use strict";

process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;

const V86 = require(`../../build/${TEST_RELEASE_BUILD ? "libv86" : "libv86-debug"}.js`).V86;

const assert = require("assert").strict;
const SHOW_LOGS = false;
const STOP_ON_FIRST_FAILURE = false;

function log_pass(msg, ...args)
{
    console.log(`\x1b[92m[+] ${msg}\x1b[0m`, ...args);
}

function log_warn(msg, ...args)
{
    console.error(`\x1b[93m[!] ${msg}\x1b[0m`, ...args);
}

function log_fail(msg, ...args)
{
    console.error(`\x1b[91m[-] ${msg}\x1b[0m`, ...args);
}

const tests =
[
    {
        name: "DHCP",
        timeout: 60,
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
        timeout: 60,
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
        timeout: 60,
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
    {
        name: "ping 1.2.3.4",
        timeout: 60,
        start: () =>
        {
            emulator.serial0_send("ping -c 2 1.2.3.4\n");
            emulator.serial0_send("echo -e done\\\\tping\n");
        },
        end_trigger: "done\tping",
        end: (capture) =>
        {
            assert(/2 packets transmitted, 2 packets received, 0% packet loss/.test(capture), "2 packets transmitted, 2 packets received, 0% packet loss");
        },
    },
    {
        name: "arp -a",
        timeout: 60,
        start: () =>
        {
            emulator.serial0_send("arp -a\n");
            emulator.serial0_send("echo -e done\\\\tarp\n");
        },
        end_trigger: "done\tarp",
        end: (capture) =>
        {
            assert(/.192.168.86.1. at 52:54:00:01:02:03 \[ether\] {2}on eth0/.test(capture), "(192.168.86.1) at 52:54:00:01:02:03 [ether]  on eth0");
        },
    },
    {
        name: "Curl mocked.example.org",
        timeout: 60,
        allow_failure: true,
        start: () =>
        {
            emulator.serial0_send("wget -T 10 -O - mocked.example.org\n");
            emulator.serial0_send("echo -e done\\\\tmocked.example.org\n");
        },
        end_trigger: "done\tmocked.example.org",
        end: (capture) =>
        {
            assert(/This text is from the mock/.test(capture), "got mocked.example.org text");
        },
    },
    {
        name: "Curl example.org",
        timeout: 60,
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

let test_num = 0;
let test_timeout = 0;
const failed_tests = [];

const emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux4.iso" },
    autostart: true,
    memory_size: 64 * 1024 * 1024,
    disable_jit: +process.env.DISABLE_JIT,
    network_relay_url: "fetch",
    log_level: SHOW_LOGS ? 0x400000 : 0,
});

emulator.add_listener("emulator-ready", function () {
    let network_adapter = emulator.network_adapter;
    let original_fetch = network_adapter.fetch;
    network_adapter.fetch = (url, opts) => {
        if(/^http:\/\/mocked.example.org\/?/.test(url)) {
            let contents = new TextEncoder().encode("This text is from the mock");
            let headers = new Headers();
            return new Promise(res => setTimeout(() => res([
                {status: 200, statusText: "OK", headers: headers},
                contents.buffer
            ]), 50));
        }
        return original_fetch.call(network_adapter, url, opts);
    };
});

let ran_command = false;
let line = "";
let capturing = false;
let capture = "";
let next_trigger;
let next_trigger_handler;

function start_timeout()
{
    if(tests[test_num].timeout)
    {
        test_timeout = setTimeout(() =>
        {
            log_fail("Test #%d (%s) took longer than %s sec. Timing out and terminating.", test_num, tests[test_num].name, tests[test_num].timeout);
            process.exit(1);
        }, tests[test_num].timeout * 1000);
    }
}

function begin()
{
    start_timeout();

    console.log("\nPreparing test #%d: %s", test_num, tests[test_num].name);
    start_test();
}

function start_test()
{
    console.log("Starting test #%d: %s", test_num, tests[test_num].name);

    capture = "";

    tests[test_num].start();

    if(tests[test_num].capture_trigger)
    {
        next_trigger = tests[test_num].capture_trigger;
        next_trigger_handler = start_capture;
    }
    else
    {
        next_trigger = tests[test_num].end_trigger;
        next_trigger_handler = end_test;
    }
    start_capture();
}

function start_capture()
{
    console.log("Capturing...");
    capture = "";
    capturing = true;

    next_trigger = tests[test_num].end_trigger;
    next_trigger_handler = end_test;
}

function end_test()
{
    capturing = false;

    if(tests[test_num].timeout)
    {
        clearTimeout(test_timeout);
    }

    let test_has_failed = false;

    try {
        tests[test_num].end(capture);
    } catch(e) {
        console.log(e);
        test_has_failed = true;
    }

    if(!test_has_failed)
    {
        log_pass("Test #%d passed: %s", test_num, tests[test_num].name);
    }
    else
    {
        if(tests[test_num].allow_failure)
        {
            log_warn("Test #%d failed: %s (failure allowed)", test_num, tests[test_num].name);
        }
        else
        {
            log_fail("Test #%d failed: %s", test_num, tests[test_num].name);

            if(STOP_ON_FIRST_FAILURE)
            {
                finish_tests();
            }
        }
        test_has_failed = false;
    }

    test_num++;

    if(test_num < tests.length)
    {
        begin();
    }
    else
    {
        finish_tests();
    }
}

function finish_tests()
{
    emulator.stop();

    console.log("\nTests finished.");
    if(failed_tests.length === 0)
    {
        console.log("All tests passed");
    }
    else
    {
        let unallowed_failure = false;

        console.error("Failed %d out of %d tests:", failed_tests.length, tests.length);
        for(const num of failed_tests)
        {
            if(tests[num].allow_failure)
            {
                log_warn("#%d %s (failure allowed)", num, tests[num].name);
            }
            else
            {
                unallowed_failure = true;
                log_fail("#%d %s", num, tests[num].name);
            }
        }
        if(unallowed_failure)
        {
            process.exit(1);
        }
    }
}

emulator.bus.register("emulator-started", function()
{
    console.error("Booting now, please stand by");
});

emulator.add_listener("serial0-output-byte", function(byte)
{
    const chr = String.fromCharCode(byte);
    if(chr < " " && chr !== "\n" && chr !== "\t" || chr > "~")
    {
        return;
    }

    let new_line = "";
    let is_new_line = false;
    if(chr === "\n")
    {
        is_new_line = true;
        new_line = line;
        line = "";
    }
    else
    {
        line += chr;
    }

    if(!ran_command && line.endsWith("~% "))
    {
        ran_command = true;
        begin();
    }
    else if(new_line === next_trigger)
    {
        next_trigger_handler();
    }
    else if(is_new_line && capturing)
    {
        capture += new_line + "\n";
        console.log("    Captured: %s", new_line);
    }
    else if(is_new_line)
    {
        console.log("    Serial: %s", new_line);
    }
});
