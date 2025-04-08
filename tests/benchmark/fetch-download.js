#!/usr/bin/env node
"use strict";

import url from "node:url";
import { Worker } from "node:worker_threads";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const USE_VIRTIO = !!process.env.USE_VIRTIO;
const SERVER_PORT = parseInt(process.env.SERVER_PORT, 10) || 8686;
const BENCHFILE_SIZE = (parseInt(process.env.BENCHFILE_SIZE_MB, 10) || 32) * 1024 * 1024;

const { V86 } = await import(`../../build/${TEST_RELEASE_BUILD ? "libv86" : "libv86-debug"}.mjs`);

const LOG_SERIAL = true;
const SHOW_LOGS = false;

const server = new Worker(__dirname + "../devices/fetch_testserver.js", { workerData: { port: SERVER_PORT, benchsize: BENCHFILE_SIZE } });

const emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    bzimage: { url: __dirname + "/../../images/buildroot-bzimage68.bin" },
    autostart: true,
    memory_size: 64 * 1024 * 1024,
    net_device: {
        relay_url: "fetch",
        type: USE_VIRTIO ? "virtio" : "ne2k",
        local_http: true
    },
    log_level: SHOW_LOGS ? 0x400000 : 0,
});

emulator.bus.register("emulator-started", function()
{
    console.log("Booting now, please stand by");
});

var serial_text = "";
var booted = false;

emulator.add_listener("serial0-output-byte", function(byte)
{
    var chr = String.fromCharCode(byte);

    if(LOG_SERIAL) process.stdout.write(chr);

    serial_text += chr;

    if(!booted && serial_text.endsWith("~% "))
    {
        booted = true;

        emulator.serial0_send(`udhcpc;curl -o /dev/null -w '<%{speed_download}>%{exitcode}' ${SERVER_PORT}.v86local.http/bench\n`);
    }

    if(serial_text.endsWith(">0"))
    {
        emulator.destroy();
        server.terminate();
        const speed = parseInt(/<([0-9]+)>0/.exec(serial_text)[1], 10); // in bytes

        if(isNaN(speed))
        {
            console.error("Can't parse console log");
            process.exit(1);
        }

        console.log();
        console.log("Average download speed: %s kB/s", (speed / 1024).toFixed(2));
        process.exit(0);
    }
});
