#!/usr/bin/env node

import path from "node:path";
import url from "node:url";
const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const BENCH_COLLECT_STATS = +process.env.BENCH_COLLECT_STATS;
const { V86 } = await import(BENCH_COLLECT_STATS ? "../../src/main.js" : "../../build/libv86.mjs");

const V86_ROOT = path.join(__dirname, "../..");

const emulator = new V86({
    bios: { url: path.join(V86_ROOT, "/bios/seabios.bin") },
    vga_bios: { url: path.join(V86_ROOT, "/bios/vgabios.bin") },
    autostart: true,
    memory_size: 512 * 1024 * 1024,
    vga_memory_size: 8 * 1024 * 1024,
    net_device: {
        type: "virtio",
        relay_url: "<UNUSED>",
    },
    initial_state: { url: path.join(V86_ROOT, "/images/arch_state-v2.bin.zst") },
    filesystem: { baseurl: path.join(V86_ROOT, "/images/arch/") },
    disable_jit: +process.env.DISABLE_JIT,
    log_level: 0,
});

emulator.bus.register("emulator-started", function()
{
    let exclude_tests = [];

    if(process.argv.length > 2)
    {
        exclude_tests = [
            "DONUMSORT",
            "DOSTRINGSORT",
            "DOBITFIELD",
            "DOEMF",
            "DOFOUR",
            "DOASSIGN",
            "DOIDEA",
            "DOHUFF",
            "DONNET",
            "DOLU",
        ].filter(name => !process.argv.includes(name));
    }

    setTimeout(() => {
        const set = exclude_tests.map(name => `echo ${name}=0 >> CMD`).join(" && ");
        emulator.serial0_send(`echo 0 > /sys/class/graphics/fbcon/cursor_blink && cd nbench && touch CMD && ${set || "echo"} && ./nbench -cCMD\n`);
    }, 1000);
});

var line = "";

emulator.add_listener("serial0-output-byte", function(byte)
{
    var chr = String.fromCharCode(byte);
    if(chr < " " && chr !== "\n" && chr !== "\t" || chr > "~")
    {
        return;
    }

    if(chr === "\n")
    {
        console.log("%s", line);
        line = "";
    }
    else
    {
        line += chr;
    }

    if(line === "* Trademarks are property of their respective holder.")
    {
        emulator.destroy();

        if(BENCH_COLLECT_STATS)
        {
            console.log(emulator.get_instruction_stats());
        }
    }
});
