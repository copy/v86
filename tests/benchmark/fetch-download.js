#!/usr/bin/env node

import url from "node:url";
import { Worker } from "node:worker_threads";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const USE_VIRTIO = !!process.env.USE_VIRTIO;
const BENCHFILE_SIZE = (parseInt(process.env.BENCHFILE_SIZE_MB, 10) || 32) * 1024 * 1024;

const { V86 } = await import("../../build/libv86.mjs");

const LOG_SERIAL = true;
const SHOW_LOGS = false;

var SERVER_PORT = parseInt(process.env.SERVER_PORT, 10) || 0;
var server = null;

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
    }
});

emulator.bus.register("emulator-ready", function()
{
    server = new Worker(__dirname + "../devices/fetch_testserver.js", { workerData: { port: SERVER_PORT, benchsize: BENCHFILE_SIZE } });
    server.on("error", (e) => { throw new Error("server: " + e); });
    server.on("message", function(msg) {
        if(msg.port)
        {
            SERVER_PORT = msg.port;
            console.log("Server started on port " + SERVER_PORT);
        }
    });
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

        emulator.serial0_send(`udhcpc;curl --fail --connect-timeout 10 -s -o /dev/null -w '<%{exitcode}><%{speed_download}>\\t<DONE>' http://${SERVER_PORT}.v86local.http/bench\n`);
    }

    if(serial_text.endsWith("\t<DONE>"))
    {
        console.log("\n---\n");
        emulator.destroy();
        server.terminate();

        const regex = /<(\d+)><(\d+)>\t<DONE>/.exec(serial_text);

        if(!regex)
        {
            console.error("Can't parse console log");
            process.exit(1);
        }

        const exitcode = parseInt(regex[1], 10);
        const speed = parseInt(regex[2], 10); // in bytes

        if(exitcode !== 0)
        {
            console.error("Bench failed, curl returned non-zero exit code %s", exitcode);
            process.exit(exitcode);
        }

        console.log("Average download speed: %s kB/s", (speed / 1024).toFixed(2));
    }
});
