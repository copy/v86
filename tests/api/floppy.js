#!/usr/bin/env node

import { setTimeout as pause } from "timers/promises";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

process.on("unhandledRejection", exn => { throw exn; });

const CONFIG_MSDOS622_HD = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    hda: { url: __dirname + "/../../images/msdos622.img" },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    filesystem: {},
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT
};

const CONFIG_CORE477_CD = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/Core-4.7.7.iso" },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    filesystem: {},
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT
};

async function send_text(emulator, text)
{
    for(const c of text)
    {
        emulator.keyboard_send_text(c);
        await pause(10);
    }
}

async function run_floppy_test(test_name, v86_config, timeout_sec, test_function)
{
    console.log("Starting: " + test_name);

    const emulator = new V86(v86_config);
    await pause(1000);

    const timeout = setTimeout(() => {
        console.warn(emulator.screen_adapter.get_text_screen());
        emulator.destroy();
        throw new Error("Timeout in test " + test_name);
    }, timeout_sec * 1000);

    await test_function(emulator);

    clearTimeout(timeout);
    emulator.destroy();
    console.log("Done: " + test_name);
}

// ---------------------------------------------------------------------------

await run_floppy_test("floppy-insert-eject", CONFIG_MSDOS622_HD, 60, async emulator =>
{
    console.log("Waiting for C:\\>");
    await emulator.wait_until_vga_screen_contains("C:\\> ");
    await pause(1000);

    console.log("Reading A:");
    send_text(emulator, "dir A:\n");
    await emulator.wait_until_vga_screen_contains("Abort, Retry, Fail?");
    send_text(emulator, "A");

    console.log("Inserting disk freedos722.img into drive A:");
    emulator.set_fda({ url: __dirname + "/../../images/freedos722.img" });
    await pause(1000);

    console.log("Reading A:");
    send_text(emulator, "dir A:\n");
    await emulator.wait_until_vga_screen_contains("FDOS         <DIR>");

    console.log("Ejecting disk from drive A:");
    emulator.eject_fda();
    await pause(1000);

    console.log("Reading A:");
    send_text(emulator, "dir A:\n");
    await emulator.wait_until_vga_screen_contains("Abort, Retry, Fail?");
});

await run_floppy_test("floppy-insert-fdb", CONFIG_MSDOS622_HD, 60, async emulator =>
{
    console.log("Waiting for C:\\>");
    await emulator.wait_until_vga_screen_contains("C:\\> ");
    await pause(1000);

    console.log("Inserting disk freedos722.img into drive B:");
    emulator.set_fdb({ url: __dirname + "/../../images/freedos722.img" });
    await pause(1000);

    console.log("Reading B:");
    send_text(emulator, "dir B:\n");
    await emulator.wait_until_vga_screen_contains("FDOS         <DIR>");
});

await run_floppy_test("floppy-core-linux", CONFIG_CORE477_CD, 60, async emulator =>
{
    console.log("Waiting for boot:");
    await emulator.wait_until_vga_screen_contains("boot: ");
    emulator.keyboard_send_text("\n");

    console.log("Waiting for tc@box:~$");
    await emulator.wait_until_vga_screen_contains("tc@box:~$ ");

    console.log("Inserting disk freedos722.img into drive A:");
    emulator.set_fda({ url: __dirname + "/../../images/freedos722.img" });
    await pause(1000);

    console.log("Mounting /dev/fd0 into /mnt/fda");
    emulator.keyboard_send_text("mkdir /mnt/fda\n");
    await emulator.wait_until_vga_screen_contains("tc@box:~$ ");
    emulator.keyboard_send_text("sudo mount /dev/fd0 /mnt/fda\n");
    await emulator.wait_until_vga_screen_contains("tc@box:~$ ");

    console.log("Reading /mnt/fda");
    emulator.keyboard_send_text("ls -la /mnt/fda\n");
    await emulator.wait_until_vga_screen_contains("x86test.asm");
});

await run_floppy_test("floppy-state-snapshot", CONFIG_MSDOS622_HD, 60, async emulator =>
{
    console.log("Waiting for C:\\>");
    await emulator.wait_until_vga_screen_contains("C:\\> ");
    await pause(1000);

    console.log("Inserting disk freedos722.img into drive A:");
    emulator.set_fda({ url: __dirname + "/../../images/freedos722.img" });
    await pause(1000);

    console.log("Saving initial state");
    const initial_state = await emulator.save_state();

    console.log("Creating file A:\\V86TEST.TXT");
    send_text(emulator, "echo v86test > A:\\V86TEST.TXT\n");
    await pause(1000);

    console.log("Saving modified state");
    const modified_state = await emulator.save_state();
    await pause(1000);

    console.log("Restoring initial state");
    await emulator.restore_state(initial_state);
    await pause(1000);
    await emulator.wait_until_vga_screen_contains("C:\\> ");

    console.log("Reading file A:\\V86TEST.TXT");
    send_text(emulator, "more < A:\\V86TEST.TXT\n");
    await emulator.wait_until_vga_screen_contains("File not found");

    console.log("Restoring modified state");
    await emulator.restore_state(modified_state);
    await emulator.wait_until_vga_screen_contains("C:\\> ");

    console.log("Reading file A:\\V86TEST.TXT");
    send_text(emulator, "more < A:\\V86TEST.TXT\n");
    await emulator.wait_until_vga_screen_contains("v86test");
});
