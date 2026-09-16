#!/usr/bin/env node

import assert from "node:assert/strict";
import { setTimeout as pause } from "timers/promises";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

process.on("unhandledRejection", exn => { throw exn; });

const STATUS_ERROR = 0x08;
const STATUS_SELECT = 0x10;
const STATUS_ACK = 0x40;
const STATUS_NOT_BUSY = 0x80;
const STATUS_IDLE = STATUS_NOT_BUSY | STATUS_ACK | STATUS_SELECT | STATUS_ERROR;
const STATUS_ACK_LOW = STATUS_NOT_BUSY | STATUS_SELECT | STATUS_ERROR;

function escape_regexp(text)
{
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function expect(emulator, command, expected, timeout_msec)
{
    if(command)
    {
        for(const ch of command)
        {
            emulator.keyboard_send_text(ch);
            await pause(10);
        }
        expected = [new RegExp(escape_regexp(command.trimRight()) + "$"), ...expected];
        await pause(100);
    }
    if(!await emulator.wait_until_vga_screen_contains(expected, {timeout_msec: timeout_msec}))
    {
        throw new Error("Timeout of " + timeout_msec + " msec expired");
    }
}

const base_config = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    hda: { url: __dirname + "/../../images/msdos622.img" },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT,
};

async function destroy_emulator(emulator)
{
    if(emulator.v86)
    {
        await emulator.destroy();
    }
}

function dump_screen(emulator)
{
    if(emulator.screen_adapter)
    {
        console.warn(emulator.screen_adapter.get_text_screen());
    }
}

async function test_parallel_port(lpt, enable_lpt2)
{
    const emulator = new V86({
        ...base_config,
        parallel1: enable_lpt2,
    });
    const parallel_data = [];
    const parallel_control = [];
    const dos_device = "LPT" + (lpt + 1);
    const event_prefix = "parallel" + lpt;
    const expected_text = "V86-PARALLEL-" + dos_device + "-OK";

    emulator.add_listener(event_prefix + "-data-output", byte =>
    {
        parallel_data.push(byte);
    });

    emulator.add_listener(event_prefix + "-control-output", value =>
    {
        parallel_control.push(value);

        // Acknowledge the guest's strobe so BIOS/DOS see an online printer.
        emulator.bus.send(event_prefix + "-status-input", STATUS_ACK_LOW);
        emulator.bus.send(event_prefix + "-status-input", STATUS_IDLE);
    });

    const timeout = setTimeout(async () =>
    {
        dump_screen(emulator);
        console.warn(dos_device + " data:", Buffer.from(parallel_data).toString("ascii"));
        await destroy_emulator(emulator);
        throw new Error("Timeout");
    }, 60 * 1000);

    try
    {
        await new Promise(resolve => emulator.bus.register("emulator-started", () => resolve()));
        assert(!!emulator.v86.cpu.devices.parallel0, "expected LPT1 to be enabled");
        assert.equal(
            !!emulator.v86.cpu.devices.parallel1,
            enable_lpt2,
            "expected LPT2 to " + (enable_lpt2 ? "be enabled when requested" : "stay disabled by default")
        );

        emulator.bus.send(event_prefix + "-status-input", STATUS_IDLE);

        console.log("Waiting for C:\\>");
        await expect(emulator, "", ["C:\\>"], 10000);

        console.log("Printing to " + dos_device);
        await expect(emulator, "echo " + expected_text + ">" + dos_device + "\n", ["", "C:\\>"], 5000);

        const printed = Buffer.from(parallel_data).toString("ascii");
        assert(
            printed.includes(expected_text),
            "expected " + dos_device + " output to include " + JSON.stringify(expected_text) + ", got " + JSON.stringify(printed)
        );
        assert(
            parallel_control.length > 0,
            "expected DOS " + dos_device + " write to drive the parallel control lines"
        );
    }
    catch(err)
    {
        dump_screen(emulator);
        throw err;
    }
    finally
    {
        clearTimeout(timeout);
        await destroy_emulator(emulator);
    }
}

await test_parallel_port(0, false);
await test_parallel_port(1, true);

console.log("ok");
