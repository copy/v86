#!/usr/bin/env node

// The UEFI firmware's variable store kept (docs/uefi.md): firmware.vars with
// disk_option "read_write" is written back as a disk is (src/pflash.js, a
// local file here: src/disk_writeback.js). A copy of bios/ovmf-vars.fd: a
// machine sets a non-volatile variable in the Shell and is destroyed; the
// file has the variable and OVMF's boot entries; a second machine of the
// same file reads the variable. Snapshots hold a reference to the store: one
// of the second machine restores, one of the first does not (the store
// has been written since). The same file read only: the changes stay in
// memory, the file as it was.
//
// TEST_RELEASE_BUILD=1, MACHINE=i440fx.

import assert from "node:assert/strict";
import fs from "node:fs";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const ROOT = __dirname + "../../";
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const MACHINE = process.env.MACHINE || "q35";
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const directory = ROOT + "build/uefi/";
fs.mkdirSync(directory, { recursive: true });
const store = directory + "vars-test.fd";
fs.copyFileSync(ROOT + "bios/ovmf-vars.fd", store);
const template = fs.readFileSync(ROOT + "bios/ovmf-vars.fd");

const VARIABLE = "V86Test -guid 2c94c1ab-37b4-4d11-9a3f-5fd77b0d5e8a";
const PROMPT = /Shell> $/;
const plain = text => text.replace(/\x1b\[[0-9;=?]*[A-Za-z]/g, "").replace(/\r/g, "");

/** A machine of the store, at its Shell: { emulator, command } */
async function machine(disk_option)
{
    const emulator = new V86({
        firmware: {
            type: "uefi",
            code: { url: ROOT + "bios/ovmf-code.fd" },
            vars: { url: store, disk_option },
        },
        memory_size: 512 * 1024 * 1024,
        graphics_adapter: "bochs_vga",
        cpu_type: "x86_64",
        machine_type: MACHINE,
        qemu_compatible: MACHINE === "i440fx",
        acpi: true,
        net_device: { type: "none" },
        autostart: true,
        log_level: 0,
    });
    let serial = "", waiter = null;
    emulator.add_listener("serial0-output-byte", byte => {
        serial += String.fromCharCode(byte);
        if(waiter && PROMPT.test(plain(serial))) { const resolve = waiter; waiter = null; resolve(plain(serial)); }
    });
    const prompt = (what, timeout_ms) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for " + what + ":\n" + plain(serial).slice(-2000))), timeout_ms);
        waiter = text => { clearTimeout(timer); resolve(text); };
        if(PROMPT.test(plain(serial))) { waiter = null; clearTimeout(timer); resolve(plain(serial)); }
    });
    await prompt("the Shell", 180000);
    const command = async cmd => {
        serial = "";
        for(const chr of cmd + "\r")
        {
            emulator.serial0_send(chr);
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        const output = await prompt(JSON.stringify(cmd), 60000);
        return output.slice(output.indexOf(cmd) + cmd.length).replace(PROMPT, "");
    };
    return { emulator, command };
}

let passed = 0;
async function step(name, f)
{
    const start = Date.now();
    await f();
    passed++;
    console.log("ok - " + name + " (" + ((Date.now() - start) / 1000).toFixed(1) + " s)");
}

/** Whether the store has a UCS-2 name */
const has_name = (bytes, name) => Buffer.from(bytes).includes(Buffer.from(name, "utf16le"));

let first_state;
await step("a machine writes the store: a variable set in the Shell, then destroyed", async () => {
    const { emulator, command } = await machine("read_write");
    await command("setvar " + VARIABLE + " -nv -bs -rt =L\"v86\"");
    assert.match(await command("setvar " + VARIABLE), /76 00 38 00 36 00/);
    first_state = await emulator.save_state();
    await emulator.destroy();
    const bytes = fs.readFileSync(store);
    assert.equal(bytes.length, template.length);
    assert.ok(!bytes.equals(template), "the file written");
    assert.ok(has_name(bytes, "V86Test"), "the variable in the file");
    assert.ok(has_name(bytes, "BootOrder"), "OVMF's boot entries in the file");
});

await step("a second machine of the file: the variable there; its own snapshot restores, the first machine's not", async () => {
    const { emulator, command } = await machine("read_write");
    assert.match(await command("setvar " + VARIABLE), /76 00 38 00 36 00/);
    await command("setvar " + VARIABLE + " =L\"v64\"");
    const state = await emulator.save_state();
    await emulator.restore_state(state);
    assert.match(await command("setvar " + VARIABLE), /76 00 36 00 34 00/);
    await assert.rejects(emulator.restore_state(first_state), /firmware_vars/);
    await emulator.destroy();
});

await step("read only: the changes in memory, the file as it was", async () => {
    const before = fs.readFileSync(store);
    const { emulator, command } = await machine("read_only");
    assert.match(await command("setvar " + VARIABLE), /76 00 36 00 34 00/);
    await command("setvar " + VARIABLE + " =L\"x86\"");
    assert.match(await command("setvar " + VARIABLE), /78 00 38 00 36 00/);
    await emulator.destroy();
    assert.ok(fs.readFileSync(store).equals(before), "the file unchanged");
});

console.log("PASS: " + passed + " steps");
process.exit(0);
