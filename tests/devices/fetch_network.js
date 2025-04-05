#!/usr/bin/env node
"use strict";

import assert from "assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const USE_VIRTIO = !!process.env.USE_VIRTIO;

const { V86 } = await import(`../../build/${TEST_RELEASE_BUILD ? "libv86" : "libv86-debug"}.mjs`);
const SHOW_LOGS = false;

function wait(time) {
    return new Promise((res) => setTimeout(res, time));
}

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
        name: "lspci",
        timeout: 60,
        start: () =>
        {
            emulator.serial0_send("lspci -k\n");
            emulator.serial0_send("echo -e done\\\\tlspci\n");
        },
        end_trigger: "done\tlspci",
        end: (capture) =>
        {
            if(!USE_VIRTIO) {
                assert(/ne2k/.test(capture), "ne2k missing from lspci");
            } else {
                assert(!/ne2k/.test(capture), "ne2k in lspci");
            }
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
    {
        name: "ping 1.2.3.4",
        start: () =>
        {
            emulator.serial0_send("ping -c 2 1.2.3.4\n");
            emulator.serial0_send("echo -e done\\\\tping\n");
        },
        end_trigger: "done\tping",
        end: (capture) =>
        {
            assert(/2 packets transmitted, 2 (packets )?received, 0% packet loss/.test(capture), "2 packets transmitted, 2 packets received, 0% packet loss");
            assert(/from 1\.2\.3\.4:/.test(capture), "got correct source ip");
        },
    },
    {
        name: "arp -a",
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
        name: "Accept incoming connection",
        timeout: 60,
        allow_failure: true,
        start: async () =>
        {
            let open = await emulator.network_adapter.tcp_probe(80);
            assert(!open, "Probe shows port not open");
            emulator.serial0_send("echo -n hello | socat TCP4-LISTEN:80 - && echo -e done\\\\tlisten\n");
            await wait(1000);
            open = await emulator.network_adapter.tcp_probe(80);
            assert(open, "Probe shows port open, but does not show as a connection");
            await wait(1000);
            let h = emulator.network_adapter.connect(80);
            h.on("connect", () => {
                h.write(new TextEncoder().encode("From VM: "));
                h.on("data", (d) => {
                    d.reverse();
                    h.write(d);
                    h.write(new TextEncoder().encode("\n"));
                    h.close();
                });
            });
        },
        end_trigger: "done\tlisten",
        end: (capture) =>
        {
            assert(/From VM: olleh/.test(capture), "got From VM");
        },
    },
    {
        name: "Curl mocked.example.org",
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
    {
        name: "Forbidden character in header name",
        start: () =>
        {
            emulator.serial0_send("wget --header='test.v86: 123' -T 10 -O - test.domain\n");
            emulator.serial0_send("echo -e done\\\\tincorrect header name\n");
        },
        end_trigger: "done\tincorrect header name",
        end: (capture) =>
        {
            assert(/400 Bad Request/.test(capture), "got error 400");
        },
    },
    {
        name: "Empty header value",
        start: () =>
        {
            emulator.serial0_send("wget --header='test:' -T 10 -O - test.domain\n");
            emulator.serial0_send("echo -e done\\\\tempty header value\n");
        },
        end_trigger: "done\tempty header value",
        end: (capture) =>
        {
            assert(/400 Bad Request/.test(capture), "got error 400");
        },
    },
    {
        name: "Header without separator",
        start: () =>
        {
            emulator.serial0_send("wget --spider --header='testheader' -T 10 -O - test.domain\n");
            emulator.serial0_send("echo -e done\\\\theader without colon\n");
        },
        end_trigger: "done\theader without colon",
        end: (capture) =>
        {
            assert(/400 Bad Request/.test(capture), "got error 400");
        },
    },
];

const emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    bzimage: { url: __dirname + "/../../images/buildroot-bzimage68.bin" },
    autostart: true,
    memory_size: 64 * 1024 * 1024,
    disable_jit: +process.env.DISABLE_JIT,
    net_device: {
        relay_url: "fetch",
        type: USE_VIRTIO ? "virtio" : "ne2k",
    },
    log_level: SHOW_LOGS ? 0x400000 : 0,
});

emulator.add_listener("emulator-ready", function () {
    let network_adapter = emulator.network_adapter;
    let original_fetch = network_adapter.fetch;
    network_adapter.fetch = (url, opts) => {
        if(/^http:\/\/mocked.example.org\/?/.test(url)) {
            let contents = new TextEncoder().encode("This text is from the mock");
            let headers = new Headers();
            headers.append("Content-Type", "text/plain");
            headers.append("Content-Length", contents.length);
            return new Promise(res => setTimeout(() => res(new Response(contents, {
                headers
            })), 50));
        }
        return original_fetch(url, opts);
    };
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
