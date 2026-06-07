#!/usr/bin/env node

import url from "node:url";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

process.on("unhandledRejection", exn => { throw exn; });

const config = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux.iso" },
    network_relay_url: "<UNUSED>",
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    filesystem: {},
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT,
};

const emulator = new V86(config);

let serial_data = [];

setTimeout(async () =>
{
    await emulator.wait_until_vga_screen_contains("/root% ");
    console.log("Booted, sending file to ttyS0");
    emulator.keyboard_send_text("cat /bin/busybox > /dev/ttyS0\n");
}, 1000);

const timeout = setTimeout(() => {
    console.log(serial_data);
    throw new Error("Timeout");
}, 60 * 1000);

emulator.add_listener("serial0-output-byte", function(byte)
{
    serial_data.push(byte);

    if(serial_data.length === 510277)
    {
        const hash = crypto.createHash("sha256");
        hash.update(new Uint8Array(serial_data));
        assert("da1fb5b421123c58080a59832675632505b8c139a8d7ecd1c31591ca5c65cea6" === hash.digest("hex"));
        console.log("ok");
        clearTimeout(timeout);
        emulator.destroy();
    }
});
