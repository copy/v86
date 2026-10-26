#!/usr/bin/env node

// The HD Audio controller with real drivers: Alpine 3.24 x86_64's
// snd-hda-intel and snd-hda-codec-generic (the pinned virt ISO,
// tests/lib/alpine_image.mjs) on audio_device "hd_audio"
// (docs/modern-pc-devices-plan.md, H1, "验收"). The drivers bind the
// controller and the codec (card "HDA Intel", codec "QEMU Generic", a PCM
// device and the Master controls); tests/devices/hd_audio_play.c, a
// freestanding ALSA player built here with clang and rust-lld, plays a
// pattern at 48 and 44.1 kHz: the stream's bytes as the controller read them
// ("hd-audio-pcm") are the pattern, in the format asked for, and take their
// time on the machine clock; the controller's interrupts drive the player.
//
// MACHINE=q35 (ICH9's controller), CPU_CORES=2, SHOW_LOGS=1.

import assert from "node:assert/strict";
import fs from "node:fs";
import url from "node:url";
import { spawnSync } from "node:child_process";
import { prepare as prepare_alpine } from "../lib/alpine_image.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const ROOT = __dirname + "../../";
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const SHOW_LOGS = +process.env.SHOW_LOGS;
const CPU_CORES = +process.env.CPU_CORES || 1;
const MACHINE = process.env.MACHINE || "i440fx";
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const out = ROOT + "build/hd-audio/";
fs.mkdirSync(out, { recursive: true });
function run(program, args)
{
    const result = spawnSync(program, args, { encoding: "utf8" });
    assert.equal(result.status, 0, program + ": " + (result.stderr || result.error));
    return result.stdout.trim();
}
// the player: x86-64 Linux, static, no libc
const host = run("rustc", ["-vV"]).match(/host: (.+)/)[1];
const lld = process.env.LD_LLD || `${run("rustc", ["--print", "sysroot"])}/lib/rustlib/${host}/bin/rust-lld`;
run(process.env.CLANG || "clang", ["--target=x86_64-unknown-linux-gnu", "-O2", "-ffreestanding", "-fno-stack-protector", "-fno-pic",
    "-fno-builtin", "-mno-red-zone", "-c", __dirname + "hd_audio_play.c", "-o", out + "hd_audio_play.o"]);
run(lld, ["-flavor", "gnu", "-m", "elf_x86_64", "-static", "-e", "_start", "-o", out + "hd_audio_play", out + "hd_audio_play.o"]);
run("bsdtar", ["--format", "ustar", "--no-xattrs", "--no-mac-metadata", "--uid", "0", "--gid", "0", "-cf", out + "player.tar", "-C", out, "hd_audio_play"]);
const tar = fs.readFileSync(out + "player.tar");
const disk = new Uint8Array(1 << 20);
disk.set(tar);

const prepared = await prepare_alpine("x86_64-virt");
const directory = ROOT + "build/x64-linux/";
const emulator = new V86({
    graphics_adapter: "bochs_vga",
    bios: { url: ROOT + "bios/seabios.bin" },
    vga_bios: { url: ROOT + "bios/vgabios.bin" },
    bzimage: { url: directory + "boot/vmlinuz-virt" },
    initrd: { url: directory + "boot/initramfs-virt" },
    cdrom: { url: directory + prepared.image.name },
    hda: { buffer: disk.buffer },
    cmdline: "console=ttyS0,115200 loglevel=4 nokaslr modules=loop,squashfs,sd-mod,usb-storage",
    memory_size: 512 * 1024 * 1024,
    cpu_type: "x86_64",
    cpu_cores: CPU_CORES,
    experimental_smp_jit: CPU_CORES > 1,
    machine_type: MACHINE,
    acpi: true,
    net_device: { type: "none" },
    audio_device: "hd_audio",
    autostart: true,
    log_level: 0,
});

const overall_timeout = setTimeout(() => {
    console.log("\nTimeout. Serial output since the last command:\n" + serial);
    process.exit(1);
}, 900 * 1000);

let serial = "";
let waiter = null;
emulator.add_listener("serial0-output-byte", byte =>
{
    const chr = String.fromCharCode(byte);
    if(SHOW_LOGS) process.stdout.write(chr);
    serial += chr;
    if(waiter && waiter.pattern.test(serial))
    {
        const { resolve } = waiter;
        waiter = null;
        resolve(serial);
    }
});
/** The speaker's samples (after the codec's amplifier) */
let speaker = [];
emulator.add_listener("dac-send-data", data => speaker.push(data[0].slice()));
/** The stream's bytes by format, and when they came (machine time) */
let pcm = [];
emulator.add_listener("hd-audio-pcm", info => pcm.push({ format: info["format"], chunks: info["chunks"].map(c => new Uint8Array(c)),
    at: emulator.v86.cpu.clock.now() }));

// (Alpine's shell asks the terminal for the cursor position after its prompt)
const PROMPT = /:~# (\x1b\[6n)?$/;
function wait_serial(pattern, what, timeout_ms)
{
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for " + what + ":\n" + serial.slice(-3000))), timeout_ms);
        waiter = { pattern, resolve: text => { clearTimeout(timer); resolve(text); } };
        if(pattern.test(serial))
        {
            waiter = null;
            clearTimeout(timer);
            resolve(serial);
        }
    });
}
async function command(cmd, timeout_ms = 120000)
{
    serial = "";
    emulator.serial0_send(cmd + "\n");
    const output = await wait_serial(PROMPT, JSON.stringify(cmd), timeout_ms);
    return output.slice(cmd.length).replace(PROMPT, "");
}
let passed = 0;
async function step(name, f)
{
    const start = Date.now();
    await f();
    passed++;
    console.log("ok - " + name + " (" + ((Date.now() - start) / 1000).toFixed(1) + " s)");
}

console.log("Booting Alpine x86_64 with HD Audio (" + MACHINE + ", " + CPU_CORES + " core" + (CPU_CORES > 1 ? "s" : "") + ")");
await wait_serial(/login: $/, "the login prompt", 600000);
serial = "";
emulator.serial0_send("root\n");
await wait_serial(PROMPT, "the shell", 120000);

await step("the drivers: snd-hda-intel binds the controller, the generic parser the codec", async () => {
    // (mdev loads the modules by their modaliases)
    const cards = await command("for i in $(seq 30); do [ -e /dev/snd/pcmC0D0p ] && break; sleep 1; done; cat /proc/asound/cards");
    assert.match(cards, /0 \[Intel\s*\]: HDA-Intel - HDA Intel/);
    const codec = await command("cat '/proc/asound/card0/codec#0'");
    assert.match(codec, /Codec: QEMU Generic/);
    assert.match(codec, /Vendor Id: 0x1af40012/);
    assert.match(codec, /Node 0x02 \[Audio Output\][^\n]*Stereo Amp-Out/);
    assert.match(codec, /Control: name="Master Playback Volume"/);
    assert.match(codec, /Node 0x03 \[Pin Complex\][\s\S]*Line Out[\s\S]*Connection: 1\s+0x02/);
    const lspci = await command("cat /sys/bus/pci/devices/0000:00:1b.0/vendor /sys/bus/pci/devices/0000:00:1b.0/device; " +
        "basename $(readlink /sys/bus/pci/devices/0000:00:1b.0/driver)");
    assert.match(lspci, new RegExp("0x8086\\s+" + (MACHINE === "q35" ? "0x293e" : "0x2668") + "\\s+snd_hda_intel"));
});

await step("the player arrives", async () => {
    const output = await command("tar -xf /dev/sda -C /tmp && ls -l /tmp/hd_audio_play");
    assert.match(output, /hd_audio_play/);
});

for(const [rate, fmt, seconds] of [[48000, 0x0011, 2], [44100, 0x4011, 1]])
{
    await step(`${seconds} s at ${rate} Hz: the pattern, in its format and time`, async () => {
        pcm = [];
        const before = await command("grep snd_hda_intel /proc/interrupts");
        const output = await command(`/tmp/hd_audio_play ${rate} ${seconds}`, 120000);
        const done = output.match(/PCM_DONE rate=(\d+) frames=(\d+) ms=(\d+)/);
        assert.ok(done, "the player: " + output);
        assert.equal(+done[2], rate * seconds);
        const after = await command("grep snd_hda_intel /proc/interrupts");
        // (the line "<irq>: <count per CPU> ... snd_hda_intel:card0")
        const count = text =>
        {
            const line = text.split("\n").find(l => /^\s*\d+:.*snd_hda_intel/.test(l));
            assert.ok(line, "the controller's interrupt line: " + JSON.stringify(text));
            return line.trim().split(/\s+/).slice(1, 1 + CPU_CORES).reduce((sum, n) => sum + +n, 0);
        };
        const interrupts = count(after) - count(before);
        assert.ok(pcm.length, "the stream played");
        assert.ok(pcm.every(p => p.format === fmt), "the format: " + pcm.map(p => p.format.toString(16)).join());
        const bytes = new Uint8Array(pcm.reduce((n, p) => n + p.chunks.reduce((m, c) => m + c.length, 0), 0));
        let at = 0;
        for(const p of pcm) for(const c of p.chunks) { bytes.set(c, at); at += c.length; }
        // the pattern from its first frame: left = frame * 7, right = ~left
        const view = new DataView(bytes.buffer);
        const first = Array.from({ length: bytes.length / 4 }, (_, i) => i).find(i => view.getInt16(4 * i, true) === 7 && view.getInt16(4 * i - 4, true) === 0);
        assert.ok(first !== undefined, "the pattern's start");
        let frames = 0;
        for(let i = first - 1; i < bytes.length / 4 && frames < rate * seconds; i++, frames++)
        {
            const left = view.getInt16(4 * i, true), expected = frames * 7 << 16 >> 16;
            if(left !== expected || view.getInt16(4 * i + 2, true) !== ~expected)
            {
                assert.fail("frame " + frames + ": " + left + ", " + view.getInt16(4 * i + 2, true) + " instead of " + expected);
            }
        }
        assert.equal(frames, rate * seconds, "every frame of the pattern");
        // (the stream's time: a second of samples takes a second of the machine's clock)
        const span = pcm[pcm.length - 1].at - pcm[0].at;
        assert.ok(span > seconds * 1000 * 0.9 && span < seconds * 1000 + 500, "played in " + span.toFixed(0) + " ms of machine time");
        console.log(`    ${frames} frames in ${span.toFixed(0)} ms (machine), the player ${done[3]} ms (guest), ${interrupts} interrupts`);
        assert.ok(interrupts >= seconds * rate / 960 / 2, "period interrupts");
    });
}

await step("the driver's Master controls: muted at first, on at their top the 1 kHz tone reaches the speaker", async () => {
    speaker = [];
    const output = await command("/tmp/hd_audio_play 48000 1 tone", 120000);
    assert.match(output, /PCM_DONE rate=48000 frames=48000/, output);
    const samples = new Float32Array(speaker.reduce((n, s) => n + s.length, 0));
    let at = 0;
    for(const s of speaker) { samples.set(s, at); at += s.length; }
    const loud = samples.filter(v => Math.abs(Math.abs(v) - 8000 / 32768) < 1e-6).length;
    assert.ok(loud >= 47000, "the square wave at 0 dB: " + loud + " of " + samples.length);
    let changes = 0;
    for(let i = 1; i < samples.length; i++) if(samples[i] !== samples[i - 1]) changes++;
    assert.ok(changes > 1900 && changes < 2100, "1 kHz: " + changes + " edges");
    const codec = await command("grep -A1 'Amp-Out vals' '/proc/asound/card0/codec#0'");
    assert.match(codec, /\[0x4a 0x4a\]/);
});

clearTimeout(overall_timeout);
await emulator.destroy();
console.log("PASS: " + passed + " steps");
process.exit(0);
