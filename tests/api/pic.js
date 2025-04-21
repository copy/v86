#!/usr/bin/env node

import url from "node:url";
import fs from "node:fs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const root_path = __dirname + "/../..";

process.on("unhandledRejection", exn => { throw exn; });

if(!fs.existsSync(root_path + "/images/fs.json"))
{
    console.log("Missing images/fs.json, test skipped");
    process.exit(0);
}

const config = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    bzimage_initrd_from_filesystem: true,
    cmdline: [
        "rw apm=off vga=0x344 video=vesafb:ypan,vremap:8",
        "root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose mitigations=off",
        "audit=0 init=/usr/bin/init-openrc net.ifnames=0 biosdevname=0",
    ].join(" "),
    filesystem: {
        basefs: root_path + "/images/fs.json",
        baseurl: root_path + "/images/arch/",
    },
    network_relay_url: "<UNUSED>",
    autostart: true,
    memory_size: 512 * 1024 * 1024,
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT,
};

const emulator = new V86(config);

emulator.bus.register("emulator-started", function()
{
    console.log("Booting now, please stand by");

    // Trigger a lot of interrupts
    // There have been bugs in the pic in the past, e.g. #1203
    const interval = setInterval(() =>
    {
        emulator.bus.send("mouse-delta", [1, 0]);
    }, 0);

    const timeout = setTimeout(() => {
        console.warn(emulator.screen_adapter.get_text_screen());
        throw new Error("Timeout");
    }, 120 * 1000);

    let line = "";
    emulator.add_listener("serial0-output-byte", async function(byte)
    {
        const chr = String.fromCharCode(byte);

        if(chr < " " && chr !== "\n" && chr !== "\t" || chr > "~")
        {
            return;
        }

        if(chr === "\n")
        {
            console.error("Serial: %s", line);

            if(line.startsWith("localhost login:"))
            {
                console.log("Test passed");
                clearTimeout(timeout);
                clearInterval(interval);
                emulator.destroy();
            }

            line = "";
        }
        else
        {
            line += chr;
        }
    });
});
