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
    emulator.create_file("/bench.py", Buffer.from(`
def fib(n):
    if n < 2:
        return n
    return fib(n-2) + fib(n-1)

n = 30
print("fib(", n, ")= ", fib(n))
`));

    setTimeout(() => {
        emulator.serial0_send(`python3 /bench.py > /dev/null && python /bench.py > /dev/null && time python /bench.py\n`);
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

        if(line.startsWith("sys"))
        {
            emulator.destroy();

            if(BENCH_COLLECT_STATS)
            {
                console.log(emulator.get_instruction_stats());
            }
        }

        line = "";
    }
    else
    {
        line += chr;
    }
});
