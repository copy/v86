#!/usr/bin/env node

// End-to-end test for #GP delivery on a malformed IDT entry (issue #636).
//
// Boots the hand-crafted boot sector at repro-636-malformed-idt.bin, which
// builds a protected-mode IDT with a deliberately malformed entry at
// vector 0x80 (access byte 0x9E -- bit 4 of the type field set, violating
// the reserved-zeros invariant), then INT 0x80s into it.
//
// The descriptor walk in call_interrupt_vector must reject the malformed
// entry and deliver #GP (vector 13) to the guest with the error code
// specified by Intel SDM Vol 3 Section 6.13 for an IDT-related fault
// raised while delivering a software interrupt:
//   (vector << 3) | IDT(2) | EXT(0) = (0x80 << 3) | 2 = 0x402.
//
// The in-guest #GP handler echoes the error code over COM1 as
// "gp=00000402 OK". Anything else (silence, panic, "BAD\n", or a
// different error code) fails the test.

import url from "node:url";
import { readFile } from "node:fs/promises";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

process.on("unhandledRejection", exn => { throw exn; });

const EXPECTED = "gp=00000402 OK";

const boot_sector = await readFile(__dirname + "/repro-636-malformed-idt.bin");
// Pad the 512-byte boot sector out to a 1.44MB floppy. SeaBIOS doesn't
// boot a 512-byte hda buffer, but it boots a floppy of any standard size
// happily.
const FLOPPY_SIZE = 1474560;
const floppy = new Uint8Array(FLOPPY_SIZE);
floppy.set(boot_sector, 0);

const config = {
    bios:     { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    fda:      { buffer: floppy.buffer },
    boot_order: 0x321,             // FD first
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT,
};

const emulator = new V86(config);

let serial_text = "";
let test_done = false;

function finish(code, msg) {
    if (test_done) return;
    test_done = true;
    if (code !== 0) {
        console.log("---SERIAL---");
        console.log(serial_text);
        console.log("---END---");
    }
    console.log(msg);
    try { emulator.destroy(); } catch (_) {}
    process.exit(code);
}

const timeout = setTimeout(() => {
    finish(1, `Timeout: serial output never produced "${EXPECTED}"`);
}, 30 * 1000);

// A wasm panic surfaces as an uncaughtException; treat it as a hard test
// failure so future regressions of the #GP-delivery path are loud.
const orig_uncaught = process.listeners("uncaughtException").slice();
process.on("uncaughtException", (err) => {
    const msg = String(err && (err.message || err));
    if (/Unimplemented: #GP handler|panicked|unreachable/.test(msg)) {
        clearTimeout(timeout);
        finish(1, `Wasm panic during #GP delivery: ${msg.slice(0, 200)}`);
        return;
    }
    for (const fn of orig_uncaught) fn(err);
    throw err;
});

emulator.add_listener("serial0-output-byte", (byte) => {
    const ch = String.fromCharCode(byte);
    process.stdout.write(ch);
    serial_text += ch;

    if (test_done) return;
    if (serial_text.includes(EXPECTED)) {
        clearTimeout(timeout);
        finish(0, "Ok");
        return;
    }
    if (serial_text.includes("BAD\n")) {
        clearTimeout(timeout);
        finish(1, "Guest INT 0x80 returned without faulting -- malformed descriptor was not detected");
    }
});
