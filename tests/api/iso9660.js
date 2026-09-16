#!/usr/bin/env node

import url from "node:url";
import crypto from "node:crypto";
import { setTimeout as pause } from "timers/promises";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const { generate } = await import("../../src/iso9660.js");

process.on("unhandledRejection", exn => { throw exn; });

const TEXT_FILE_NAME = "Hello World, this is a Long FileName.txt";
const TEXT_FILE_CONTENTS = "iso9660 joliet content marker 133769\n";

const binary_file_contents = new Uint8Array(2 * 2048 + 1337);
for(let i = 0; i < binary_file_contents.length; i++) binary_file_contents[i] = (i * 7 + 13) & 0xFF;
const binary_file_md5 = crypto.createHash("md5").update(binary_file_contents).digest("hex");

const iso = generate([
    { name: TEXT_FILE_NAME, contents: new TextEncoder().encode(TEXT_FILE_CONTENTS) },
    { name: "data.bin", contents: binary_file_contents },
]);

const emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux4.iso" },
    autostart: true,
    memory_size: 128 * 1024 * 1024,
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT,
});

let serial_text = "";
let search_offset = 0;
let pending = null;

const timeout = setTimeout(() => {
    console.warn(serial_text);
    throw new Error("Timeout");
}, 5 * 60 * 1000);

emulator.add_listener("serial0-output-byte", byte => {
    const chr = String.fromCharCode(byte);
    process.stdout.write(chr);
    serial_text += chr;
    if(pending)
    {
        const index = serial_text.indexOf(pending.str, search_offset);
        if(index !== -1)
        {
            search_offset = index + pending.str.length;
            const resolve = pending.resolve;
            pending = null;
            resolve();
        }
    }
});

function wait_for(str)
{
    return new Promise(resolve => {
        const index = serial_text.indexOf(str, search_offset);
        if(index !== -1)
        {
            search_offset = index + str.length;
            resolve();
            return;
        }
        pending = { str, resolve };
    });
}

await wait_for("~%");
console.log("\nBooted, inserting generated iso");
await emulator.set_cdrom({ buffer: iso.buffer });
await pause(1000);

emulator.serial0_send("mkdir -p /tmp/cd && mount -t iso9660 /dev/sr0 /tmp/cd && ls /tmp/cd\n");
await wait_for(TEXT_FILE_NAME);
await wait_for("~%");
console.log("\nJoliet filename found");

emulator.serial0_send("cat /tmp/cd/*.txt\n");
await wait_for(TEXT_FILE_CONTENTS.trim());
await wait_for("~%");
console.log("\nFile contents found");

emulator.serial0_send("md5sum /tmp/cd/data.bin\n");
await wait_for(binary_file_md5);
console.log("\nBinary file checksum matches");

console.log("Test passed");
emulator.destroy();
clearTimeout(timeout);
