#!/usr/bin/env node

import { setTimeout as pause } from "timers/promises";
import url from "node:url";
import fs from "node:fs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

process.on("unhandledRejection", exn => { throw exn; });

async function exec_test(test_name, v86_config, timeout_sec, test_function)
{
    console.log("Starting: " + test_name);
    const tm_start = performance.now();
    const emulator = new V86(v86_config);
    try
    {
        const timeout = setTimeout(async () =>
        {
            console.warn(emulator.screen_adapter.get_text_screen());
            await emulator.destroy();
            throw new Error("Timeout error in test " + test_name);
        }, timeout_sec * 1000);
        try
        {
            await new Promise(resolve => { emulator.bus.register("emulator-started", () => { resolve(); }); });
            await test_function(emulator);
            console.log("Done: " + test_name + " (" + ((performance.now() - tm_start) / 1000).toFixed(2) + " sec)");
        }
        finally
        {
            clearTimeout(timeout);
        }
    }
    catch(err)
    {
        console.warn(emulator.screen_adapter.get_text_screen());
        throw new Error("Error in test " + test_name, { cause: err });
    }
    finally
    {
        await emulator.destroy();
    }
}

/**
 * Execute given CLI command and wait for its completion.
 *
 * Injects command into the guest's keyboard buffer, then waits for both the
 * command and the expected response lines to show at "the bottom" of the
 * VGA screen. The "bottom" line is the first non-empty line from the VGA
 * text screen's bottom.
 *
 * If command is empty then no command is executed and only the expected
 * response lines are waited for. If command contains only whitespace and/or
 * newline characters then it is send to the guest, but it does not become
 * part of the expected response.
 *
 * Items in response_lines must be of type string or RegExp. A regular
 * expression is matched against the complete screen line, whereas a string
 * is matched against the entire screen line. Expected response lines should
 * not contain any trailing whitespace and/or newline characters. Expecting
 * an empty line is valid.
 *
 * Allowed character set for command and response_lines is the printable
 * subset of 7-bit ASCII, use newline character "\n" to encode ENTER key.
 *
 * Returns the matched response lines. Throws an Error if the given timeout
 * elapsed before the expected response could be detected.
 *
 * @param {V86} emulator
 * @param {string} command
 * @param {Array[string|RegExp]} response_lines
 * @param {number} response_timeout_msec
 * @return {Array[string]}
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

        // trim trailing newline (and/or whitespace) from command
        command = command.trimRight();
        if(command)
        {
            // prepend command to expected response lines
            response_lines = [command, ...response_lines];
        }
    }

    const changed_rows = new Set();
    const screen_put_char = args => { changed_rows.add(args[0]); };
    emulator.add_listener("screen-put-char", screen_put_char);
    try
    {
        // initialize VGA screen buffer
        const screen_lines = [];
        for(const line of emulator.screen_adapter.get_text_screen())
        {
            screen_lines.push(line.trimRight());
        }

        const tm_end = performance.now() + response_timeout_msec;
        while(performance.now() < tm_end)
        {
            await pause(100);

            // update VGA screen buffer
            for(const row of changed_rows)
            {
                screen_lines[row] = emulator.screen_adapter.get_text_row(row).trimRight();
            }
            changed_rows.clear();

            let screen_bottom = screen_lines.length;
            while(screen_bottom > 0 && screen_lines[screen_bottom - 1] === "")
            {
                screen_bottom--;
            }
            const screen_offset = screen_bottom - response_lines.length;
            if(screen_offset < 0)
            {
                continue;
            }

            let matches = true;
            for(let i = 0; i < response_lines.length && matches; i++)
            {
                if(i === 0 && command)
                {
                    // match raw command against end of screen line
                    matches = screen_lines[screen_offset + i].endsWith(response_lines[i]);
                }
                else if(response_lines[i].test)
                {
                    // match screen line against anything that implements test(), for example a RegExp
                    matches = response_lines[i].test(screen_lines[screen_offset + i]);
                }
                else
                {
                    // match exact
                    matches = screen_lines[screen_offset + i] === response_lines[i];
                }
            }
            if(matches)
            {
                return screen_lines.slice(screen_offset, screen_bottom);
            }
        }

        throw new Error("Timeout in command \"" + command + "\"");
    }
    finally
    {
        emulator.remove_listener("screen-put-char", screen_put_char);
    }
}

// ---------------------------------------------------------------------------

const CONFIG_MSDOS622_HD = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    hda: { url: __dirname + "/../../images/msdos622.img" },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT
};

const CONFIG_TINYCORE_CD = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/TinyCore-11.0.iso" },
    autostart: true,
    memory_size: 128 * 1024 * 1024,
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT
};

for(const fd_size of ["160K", "180K", "320K", "360K", "640K", "720K", "1200K", "1.4MB"])
{
    // Image file source:
    // https://github.com/codercowboy/freedosbootdisks/tree/master/bootdisks
    const img_filename = __dirname + "/../../images/freedos-fds/freedos.boot.disk." + fd_size + ".img";
    if(fs.existsSync(img_filename))
    {
        const v86_config = {
            bios: { url: __dirname + "/../../bios/seabios.bin" },
            vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
            fda: { url: img_filename },
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
    else
    {
        console.log("Skipped floppy test due to missing image file " + img_filename);
    }
}

await exec_test("floppy-insert-eject", CONFIG_MSDOS622_HD, 60, async emulator =>
{
    console.log("Waiting for C:\\>");
    await expect(emulator, "", ["C:\\>"], 10000);

    console.log("Reading A:");
    await expect(emulator, "dir A:\n", ["", "", "General failure reading drive A", "Abort, Retry, Fail?"], 5000);
    await expect(emulator, "A", ["", "C:\\>"], 1000);

    console.log("Inserting disk freedos722.img into drive fda");
    await emulator.set_fda({ url: __dirname + "/../../images/freedos722.img" });

    console.log("Reading A:X86TEST.ASM");
    await expect(emulator, "dir /B A:X86TEST.ASM\n", ["X86TEST.ASM", "", "C:\\>"], 3000);

    console.log("Ejecting disk from drive A:");
    emulator.eject_fda();

    console.log("Reading A:");
    await expect(emulator, "dir A:\n", ["", " Volume in drive A is FREEDOS", "", "General failure reading drive A", "Abort, Retry, Fail?"], 5000);
});

await exec_test("floppy-insert-fdb", CONFIG_MSDOS622_HD, 60, async emulator =>
{
    console.log("Waiting for C:\\>");
    await expect(emulator, "", ["C:\\>"], 10000);

    console.log("Inserting disk freedos722.img into drive fdb");
    await emulator.set_fdb({ url: __dirname + "/../../images/freedos722.img" });

    console.log("Reading B:X86TEST.ASM");
    await expect(emulator, "dir /B B:X86TEST.ASM\n", ["X86TEST.ASM", "", "C:\\>"], 3000);

    console.log("Formatting B:");
    await expect(emulator, "format /V:V86 /U B:\n", ["Insert new diskette for drive B:", "and press ENTER when ready..."], 3000);
    await expect(emulator, "\n", [/Volume Serial Number is [0-9A-F-]+/, "", "Format another (Y/N)?"], 3000);
    await expect(emulator, "N\n", ["", "", "C:\\>"], 3000);
});

await exec_test("floppy-tinycore-linux", CONFIG_TINYCORE_CD, 60, async emulator =>
{
    console.log("Waiting for boot menu");
    await expect(emulator, "", [/BIOS default device boot in \d+ seconds\.\.\./], 10000);

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

    console.log("Inserting disk windows101.img into drive fda");
    await emulator.set_fda({ url: __dirname + "/../../images/windows101.img" });

    console.log("Mounting /dev/fd0 into /mnt/fd0");
    await expect(emulator, "mkdir /mnt/fd0\n", ["tc@box:~$"], 3000);
    await expect(emulator, "sudo mount /dev/fd0 /mnt/fd0\n", ["tc@box:~$"], 3000);

    console.log("Reading /mnt/fd0/COMMAND.COM");
    await expect(emulator, "ls /mnt/fd0/COMMAND.COM\n", ["/mnt/fd0/COMMAND.COM", "tc@box:~$"], 3000);

    console.log("Unmounting fda");
    await expect(emulator, "sudo umount /dev/fd0\n", ["tc@box:~$"], 3000);

    console.log("Formatting /dev/fd0");
    await expect(emulator, "sudo mke2fs -q /dev/fd0\n", ["/dev/fd0 contains a vfat file system labelled 'WIN101'", "Proceed anyway? (y,N)"], 3000);
    await expect(emulator, "y\n", ["tc@box:~$"], 5000);

    console.log("Reading /mnt/fd0");
    await expect(emulator, "sudo mount /dev/fd0 /mnt/fd0\n", ["tc@box:~$"], 3000);
    await expect(emulator, "ls /mnt/fd0\n", ["lost+found/", "tc@box:~$"], 3000);
});

await exec_test("floppy-state-snapshot", CONFIG_MSDOS622_HD, 60, async emulator =>
{
    console.log("Waiting for C:\\>");
    await expect(emulator, "", ["C:\\>"], 10000);

    console.log("Inserting disk freedos722.img into drive fda");
    await emulator.set_fda({ url: __dirname + "/../../images/freedos722.img" });

    console.log("Saving initial state");
    const initial_state = await emulator.save_state();

    console.log("Creating file A:V86TEST.TXT");
    await expect(emulator, "echo v86test > A:V86TEST.TXT\n", ["", "C:\\>"], 3000);

    console.log("Saving modified state");
    const modified_state = await emulator.save_state();

    console.log("Restoring initial state");
    await emulator.restore_state(initial_state);

    console.log("Reading A:V86TEST.TXT");
    await expect(emulator, "dir /B A:V86TEST.TXT\n", ["", "C:\\>"], 3000);

    console.log("Restoring modified state");
    await emulator.restore_state(modified_state);

    console.log("Reading A:V86TEST.TXT");
    await expect(emulator, "dir /B A:V86TEST.TXT\n", ["V86TEST.TXT", "", "C:\\>"], 3000);
});
