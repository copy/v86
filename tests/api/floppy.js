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
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT
};

/*
const CONFIG_CORE477_CD = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/Core-4.7.7.iso" },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT
};
*/

const CONFIG_CORE11_CD = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/TinyCore-11.0.iso" },
    autostart: true,
    memory_size: 128 * 1024 * 1024,
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT
};

async function exec_test(test_name, v86_config, timeout_sec, test_function)
{
    console.log("Starting: " + test_name);
    const tm_start = performance.now();

    const emulator = new V86(v86_config);
    await pause(1000);

    const timeout = setTimeout(() => {
        console.warn(emulator.screen_adapter.get_text_screen());
        emulator.destroy();
        throw new Error("Timeout error in test " + test_name);
    }, timeout_sec * 1000);

    try
    {
        await test_function(emulator);
    }
    catch(err)
    {
        clearTimeout(timeout);
        console.warn(emulator.screen_adapter.get_text_screen());
        emulator.destroy();
        throw new Error("Error in test " + test_name, { cause: err });
    }

    clearTimeout(timeout);
    emulator.destroy();
    console.log("Done: " + test_name + " (" + ((performance.now() - tm_start) / 1000).toFixed(2) + " sec)");
}

/**
 * Make the guest execute given CLI command and wait for the command and the
 * expected response lines to show at the bottom of the VGA screen.
 *
 * Throws an Error if the given timeout elapses before the expected response
 * is printed by the guest.
 *
 * If command is empty then no command is executed and only the response
 * lines are checked.
 *
 * @param {V86} emulator
 * @param {string} command
 * @param {Array[string]} response_lines
 * @param {number} response_timeout_msec
 */
async function expect(emulator, command, response_lines, response_timeout_msec)
{
    if(command)
    {
        // inject command characters into guest's keyboard buffer
        for(const ch of command)
        {
            emulator.keyboard_send_text(ch);
            await pause(10);
        }

        const trimmed_command = command.trimRight();
        if(trimmed_command)
        {
            // prepend command to expected response lines
            response_lines = Array.from(response_lines);
            response_lines.unshift(trimmed_command);
        }
    }

    const changed_rows = new Set();
    function put_char(args)
    {
        changed_rows.add(args[0]);
    }

    emulator.add_listener("screen-put-char", put_char);
    try
    {
        const screen_lines = [];
        for(const line of emulator.screen_adapter.get_text_screen())
        {
            screen_lines.push(line.trimRight());
        }

        const tm_end = performance.now() + response_timeout_msec;
        while(performance.now() < tm_end)
        {
            await pause(100);

            for(const row of changed_rows)
            {
                screen_lines[row] = emulator.screen_adapter.get_text_row(row).trimRight();
            }
            changed_rows.clear();

            let last_ln = screen_lines.length - 1;
            while(last_ln >= 0 && screen_lines[last_ln] === "")
            {
                last_ln--;
            }

            const screen_ofs = last_ln - response_lines.length + 1;
            if(screen_ofs < 0)
            {
                continue;
            }

            let matches = true;
            for(let i = 0; i < response_lines.length && matches; i++)
            {
                matches = screen_lines[screen_ofs + i].endsWith(response_lines[i]);
            }
            if(matches)
            {
                return;
            }
        }

        throw new Error("Timeout in command \"" + command + "\"");
    }
    finally
    {
        emulator.remove_listener("screen-put-char", put_char);
    }
}

// ---------------------------------------------------------------------------

/*
// TODO: this needs the 8 FreeDOS images in images/freedos-fds/ from:
// https://github.com/codercowboy/freedosbootdisks/tree/master/bootdisks
//
for(const fd_size of ["160K", "180K", "320K", "360K", "640K", "720K", "1200K", "1.4MB"])
{
    const img_filename = "freedos.boot.disk." + fd_size + ".img";
    const v86_config = {
        bios: { url: __dirname + "/../../bios/seabios.bin" },
        vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
        fda: { url: __dirname + "/../../images/freedos-fds/" + img_filename },
        autostart: true,
        memory_size: 32 * 1024 * 1024,
        log_level: 0,
        disable_jit: +process.env.DISABLE_JIT
    };

    await exec_test("floppy-freedos-fda-" + fd_size, v86_config, 60, async emulator =>
    {
        console.log("Waiting for A:\\>");
        await expect(emulator, "", ["A:\\>"], 10000);
    });
}
*/

await exec_test("floppy-insert-eject", CONFIG_MSDOS622_HD, 60, async emulator =>
{
    console.log("Waiting for C:\\>");
    await expect(emulator, "", ["C:\\>"], 10000);

    console.log("Reading A:");
    await expect(emulator, "dir A:\n", ["", "", "General failure reading drive A", "Abort, Retry, Fail?"], 5000);
    await expect(emulator, "A", ["", "C:\\>"], 1000);

    console.log("Inserting disk freedos722.img into drive fda");
    emulator.set_fda({ url: __dirname + "/../../images/freedos722.img" });
    await pause(1000);

    console.log("Reading A:X86TEST.ASM");
    await expect(emulator, "dir /B A:X86TEST.ASM\n", ["X86TEST.ASM", "", "C:\\>"], 3000);

    console.log("Ejecting disk from drive A:");
    emulator.eject_fda();
    await pause(1000);

    console.log("Reading A:");
    await expect(emulator, "dir A:\n", ["", " Volume in drive A is FREEDOS", "", "General failure reading drive A", "Abort, Retry, Fail?"], 5000);
});

await exec_test("floppy-insert-fdb", CONFIG_MSDOS622_HD, 60, async emulator =>
{
    console.log("Waiting for C:\\>");
    await expect(emulator, "", ["C:\\>"], 10000);

    console.log("Inserting disk freedos722.img into drive fdb");
    emulator.set_fdb({ url: __dirname + "/../../images/freedos722.img" });
    await pause(1000);

    console.log("Reading B:X86TEST.ASM");
    await expect(emulator, "dir /B B:X86TEST.ASM\n", ["X86TEST.ASM", "", "C:\\>"], 5000);
});

/*
await exec_test("floppy-core477-linux", CONFIG_CORE477_CD, 60, async emulator =>
{
    console.log("Waiting for boot:");
    await expect(emulator, "", ["boot:"], 5000);

    console.log("Waiting for tc@box:~$");
    await expect(emulator, "\n", ["tc@box:~$"], 10000);

    console.log("Inserting disk freedos722.img into drive fda");
    emulator.set_fda({ url: __dirname + "/../../images/freedos722.img" });
    await pause(1000);

    console.log("Mounting /dev/fd0 into /mnt/fda");
    await expect(emulator, "mkdir /mnt/fda\n", ["tc@box:~$"], 3000);
    await expect(emulator, "sudo mount /dev/fd0 /mnt/fda\n", ["tc@box:~$"], 3000);

    console.log("Reading /mnt/fda/x86test.asm");
    await expect(emulator, "ls /mnt/fda/x86test.asm\n", ["/mnt/fda/x86test.asm", "tc@box:~$"], 3000);
});
*/

await exec_test("floppy-core11-linux", CONFIG_CORE11_CD, 60, async emulator =>
{
    console.log("Waiting for boot menu");
    await expect(emulator, "", [" seconds..."], 10000);

    // press arrow down key 3 times
    for(let i = 0; i < 3; i++)
    {
        emulator.keyboard_send_scancodes([
            0xe0, 0x50,        // press
            0xe0, 0x50 | 0x80, // release
        ]);
        await pause(600);
    }

    console.log("Waiting for tc@box:~$");
    await expect(emulator, "\n", ["tc@box:~$"], 30000);

    console.log("Inserting disk freedos722.img into drive fda");
    emulator.set_fda({ url: __dirname + "/../../images/freedos722.img" });
    await pause(1000);

    console.log("Mounting /dev/fd0 into /mnt/fda");
    await expect(emulator, "mkdir /mnt/fda\n", ["tc@box:~$"], 3000);
    await expect(emulator, "sudo mount /dev/fd0 /mnt/fda\n", ["tc@box:~$"], 3000);

    console.log("Reading /mnt/fda/x86test.asm");
    await expect(emulator, "ls /mnt/fda/x86test.asm\n", ["/mnt/fda/x86test.asm", "tc@box:~$"], 3000);
});

await exec_test("floppy-state-snapshot", CONFIG_MSDOS622_HD, 60, async emulator =>
{
    console.log("Waiting for C:\\>");
    await expect(emulator, "", ["C:\\>"], 10000);

    console.log("Inserting disk freedos722.img into drive fda");
    emulator.set_fda({ url: __dirname + "/../../images/freedos722.img" });
    await pause(1000);

    console.log("Saving initial state");
    const initial_state = await emulator.save_state();

    console.log("Creating file A:V86TEST.TXT");
    await expect(emulator, "echo v86test > A:V86TEST.TXT\n", ["", "C:\\>"], 3000);
    await pause(1000);

    console.log("Saving modified state");
    const modified_state = await emulator.save_state();

    console.log("Restoring initial state");
    await emulator.restore_state(initial_state);
    await pause(1000);

    console.log("Reading A:V86TEST.TXT");
    await expect(emulator, "dir /B A:V86TEST.TXT\n", ["", "C:\\>"], 3000);

    console.log("Restoring modified state");
    await emulator.restore_state(modified_state);
    await pause(1000);

    console.log("Reading A:V86TEST.TXT");
    await expect(emulator, "dir /B A:V86TEST.TXT\n", ["V86TEST.TXT", "", "C:\\>"], 3000);
});
