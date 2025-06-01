#!/usr/bin/env node

import url from "node:url";
import { createServer } from "node:http";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const __filename = url.fileURLToPath(import.meta.url);

const USE_VIRTIO = !!process.env.USE_VIRTIO;
const BENCHFILE_SIZE = (parseInt(process.env.BENCHFILE_SIZE_MB, 10) || 32) * 1024 * 1024;

const { V86 } = await import("../../build/libv86.mjs");

const LOG_SERIAL = true;

if(isMainThread)
{
    const emulator = new V86({
        bios: { url: __dirname + "/../../bios/seabios.bin" },
        vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
        bzimage: { url: __dirname + "/../../images/buildroot-bzimage68.bin" },
        autostart: false,
        memory_size: 64 * 1024 * 1024,
        net_device: {
            relay_url: "fetch",
            type: USE_VIRTIO ? "virtio" : "ne2k",
        }
    });

    const server = new Worker(__filename, { workerData: BENCHFILE_SIZE });
    server.on("error", (e) => { throw new Error("server: " + e); });
    server.on("message", function(msg) {
        SERVER_PORT = msg;
        console.log("Server started on port " + SERVER_PORT);
        emulator.run();
    });

    let SERVER_PORT = 0;
    let serial_text = "";
    let booted = false;

    emulator.bus.register("emulator-started", function()
    {
        console.log("Booting now, please stand by");
    });

    emulator.add_listener("serial0-output-byte", function(byte)
    {
        var chr = String.fromCharCode(byte);

        if(LOG_SERIAL) process.stdout.write(chr);

        serial_text += chr;

        if(!booted && serial_text.endsWith("~% "))
        {
            booted = true;
            emulator.serial0_send(`udhcpc;curl --fail --connect-timeout 10 -s -o /dev/null -w '<%{exitcode}><%{speed_download}>\\t<DONE>' http://${SERVER_PORT}.external\n`);
        }

        if(serial_text.endsWith("\t<DONE>"))
        {
            console.log("\n---\n");
            emulator.destroy();
            server.terminate();
            parse_console(serial_text);
        }
    });
}
else
{
    const benchsize = workerData;
    const benchfile = Buffer.alloc(benchsize);

    const server = createServer(function(_, response) {
        response.setHeader("content-type", "application/octet-stream");
        response.setHeader("content-length", benchsize.toString(10));
        response.write(benchfile);
        response.end();
    });

    server.listen(0, () => parentPort.postMessage(server.address().port));
}

function parse_console(output) {
    const regex = /<(\d+)><(\d+)>\t<DONE>/.exec(output);

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
