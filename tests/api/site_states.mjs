#!/usr/bin/env node

// The retro-gaming-site's saved states across the move of the NE2000 and the
// SB16 into plugins (docs/modern-pc-devices-plan.md M1). Each state of the
// site's game table (app.js GAMES: Windows 98 and XP machines with an NE2000
// and an SB16, saved before M1 with untagged state[59] and state[61]) is
// restored as the site's page does (the same options, the site's BIOS):
// - with this build: the plugins read the old slots; the cards' states equal
//   what the build before M1 (OLD_LIB) restores, field for field (the
//   NE2000's own address is random each time: its address in the state,
//   which the guest uses through mac_address_translation, is compared)
// - both builds run it for SECONDS: the guest goes on (instructions, no
//   reset), the SB16 plays (samples to a speaker that takes them at the
//   sampling rate, how many are not silent), the NE2000 sends what it sends;
//   the two builds' figures side by side
// - this build saves it again (format 8, tagged slots): the save restores in
//   this build and goes on; the build before M1 refuses it ("Version
//   mismatch") instead of reading tagged slots as registers
//
// A local test: the site's checkout beside the v86 checkout (SITE=<dir>),
// its states and game disks there (the XP system disk, which the site keeps
// only in parts on its R2 bucket, read from there as the page reads it, the
// parts kept in build/site-parts). The
// GL bridge's device is there for the states that have it, without a renderer.
// OLD_LIB=<libv86.mjs of the build before M1>, STATES=<game ids, comma
// separated>, SECONDS=20, REPORT=<file.json>.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire as create_require } from "node:module";
import zlib from "node:zlib";
import { ReadOnlyOverlayDisk } from "../smp/disk_fixture.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
process.on("unhandledRejection", exn => { throw exn; });

const SITE = path.resolve(process.env.SITE || ["../retro-gaming-site", "../../../retro-gaming-site"].map(up => path.join(ROOT, up))
    .find(candidate => fs.existsSync(candidate)) || "retro-gaming-site");
if(!fs.existsSync(path.join(SITE, "app.js")))
{
    console.log("Skipped: no retro-gaming-site checkout at " + SITE + " (SITE)");
    process.exit(0);
}
const SECONDS = +process.env.SECONDS || 20;
const { V86 } = await import(path.join(ROOT, "build/libv86.mjs"));
const OLD = process.env.OLD_LIB ? (await import(path.resolve(process.env.OLD_LIB))).V86 : null;

// the GL bridge's virtio device (the site's graphics_proxy: true; some of its
// states have it), on a channel that does not answer: no renderer here
const { createV86GLDevice: create_v86gl_device } = create_require(import.meta.url)("../../src/browser/glbridge/v86gl_device.js");

// the site's game table: its data, evaluated with its bucket URLs
const app = fs.readFileSync(path.join(SITE, "app.js"), "utf8");
const constant = name => app.match(new RegExp("const " + name + " = \"([^\"]+)\""))[1];
const table = app.match(/^const GAMES = (\{[^]*?^\});/m)[1];
const GAMES = new Function("R2_URL_1", "R2_URL_2", "return " + table)(constant("R2_URL_1"), constant("R2_URL_2"));
const wanted = process.env.STATES ? process.env.STATES.split(",") : Object.keys(GAMES);

const PART = 1024 * 1024, BLOCK = 256;
const PART_CACHE = path.join(ROOT, "build/site-parts");
const parts_in_memory = new Map();
let fetching = 0;
const waiting = [];

/** A part of the bucket, unpacked: from PART_CACHE or fetched (a few at a time), the last 256 kept in memory */
function bucket_part(url)
{
    let part = parts_in_memory.get(url);
    if(part)
    {
        parts_in_memory.delete(url);
        parts_in_memory.set(url, part);
        return part;
    }
    part = (async () => {
        const file = path.join(PART_CACHE, new URL(url).pathname.replace(/\//g, "_"));
        let packed;
        if(fs.existsSync(file)) packed = fs.readFileSync(file);
        else
        {
            if(fetching >= 8) await new Promise(resolve => waiting.push(resolve));
            fetching++;
            try
            {
                for(let attempt = 1; ; attempt++)
                {
                    try
                    {
                        const response = await fetch(url);
                        if(!response.ok) throw new Error("HTTP " + response.status);
                        packed = Buffer.from(await response.arrayBuffer());
                        break;
                    }
                    catch(error)
                    {
                        if(attempt === 3) throw new Error(url + ": " + error.message);
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                    }
                }
            }
            finally
            {
                fetching--;
                waiting.shift()?.();
            }
            fs.mkdirSync(PART_CACHE, { recursive: true });
            fs.writeFileSync(file, packed);
        }
        const bytes = new Uint8Array(url.endsWith(".zst") ? zlib.zstdDecompressSync(packed) : packed);
        assert.equal(bytes.length, PART, url);
        return bytes;
    })();
    part.catch(() => parts_in_memory.delete(url));
    parts_in_memory.set(url, part);
    if(parts_in_memory.size > 256) parts_in_memory.delete(parts_in_memory.keys().next().value);
    return part;
}

/**
 * A disk the site keeps only on its bucket, in 1 MiB parts (fixed_chunk_size,
 * use_parts), read-only: the library in node reads files only, so the parts
 * are fetched and unpacked here. The guest's writes stay in an overlay of
 * 256-byte blocks, in the state the page's disk has (src/buffer.js), so the
 * site's states restore into it.
 */
class BucketDisk
{
    constructor(url, size)
    {
        const extension = url.match(/\.[^.]+(\.zst)?$/)[0];
        this.part_url = index => url.slice(0, -extension.length) + "-" + index * PART + "-" + (index + 1) * PART + extension;
        this.byteLength = size;
        this.overlay = new Map();
    }
    load() { this.onload?.({}); }
    get(start, length, done)
    {
        const first = Math.floor(start / PART), last = Math.floor((start + length - 1) / PART);
        const parts = [];
        for(let index = first; index <= last; index++) parts.push(bucket_part(this.part_url(index)));
        Promise.all(parts).then(parts => {
            const data = new Uint8Array(length);
            parts.forEach((part, i) => {
                const at = (first + i) * PART, from = Math.max(start, at), to = Math.min(start + length, at + PART);
                data.set(part.subarray(from - at, to - at), from - start);
            });
            for(let block = Math.floor(start / BLOCK); block * BLOCK < start + length; block++)
            {
                const written = this.overlay.get(block);
                if(!written) continue;
                const from = Math.max(start, block * BLOCK), to = Math.min(start + length, (block + 1) * BLOCK);
                data.set(written.subarray(from - block * BLOCK, to - block * BLOCK), from - start);
            }
            done(data);
        }, error => done(undefined, error));
    }
    get_and_cache(start, length, done) { this.get(start, length, done); }
    get_from_cache() { return undefined; }
    set(start, data, done)
    {
        assert.ok(start % BLOCK === 0 && data.length % BLOCK === 0 && start + data.length <= this.byteLength);
        for(let at = 0; at < data.length; at += BLOCK) this.overlay.set((start + at) / BLOCK, data.slice(at, at + BLOCK));
        done?.();
    }
    get_buffer(done) { done(undefined); }
    get_state()
    {
        const blocks = [...this.overlay.keys()];
        const bytes = new Uint8Array(blocks.length * BLOCK);
        blocks.forEach((block, i) => bytes.set(this.overlay.get(block), i * BLOCK));
        return [null, Float64Array.from(blocks), [bytes]];
    }
    set_state(state)
    {
        this.overlay.clear();
        if(state[0])
        {
            for(const [block, bytes] of state[0]) this.overlay.set(block, bytes.slice());
            return;
        }
        let i = 0;
        for(const chunk of state[2])
            for(let at = 0; at < chunk.length; at += BLOCK) this.overlay.set(state[1][i++], chunk.slice(at, at + BLOCK));
        assert.equal(i, state[1].length, "the disk's written blocks");
    }
}

/** A disk of the site: the local file of the same name if there is one, else the bucket's parts, as the page reads them */
function disk(location, size)
{
    const name = path.basename(location).replace(/\.zst$/, "");
    for(const candidate of [path.join(SITE, "game", name), path.join(SITE, "windows98/windows98multidisk", name)])
    {
        if(fs.existsSync(candidate) && fs.statSync(candidate).size === size) return new ReadOnlyOverlayDisk(candidate);
    }
    return new BucketDisk(location.startsWith("http") ? location : constant("R2_URL_1") + location, size);
}

/** A machine as the site's page makes it (startEmulator9xMultiDisk), not running yet */
async function machine(Lib, game, gl)
{
    const emulator = new Lib({
        memory_size: game.memorySize,
        vram_size: 16 * 1024 * 1024,
        graphics_adapter: "bochs_vga",
        bios: { url: path.join(SITE, "bios/seabios.bin") },
        vga_bios: { url: path.join(SITE, "bios/vgabios.bin") },
        hda: disk(game.systemDisk, game.systemDiskSize),
        hdb: disk(game.disk, game.size),
        acpi: false,
        net_device: { type: "ne2k" },
        preserve_mac_from_state_image: false,
        mac_address_translation: true,
        boot_order: 0x213,
        virtio_devices: gl ? [create_v86gl_device({ remote: false, post() {}, listen() {} })] : undefined,
        disable_keyboard: true, disable_mouse: true, disable_speaker: true,
        autostart: false,
        log_level: 0,
    });
    await new Promise((resolve, reject) => {
        emulator.add_listener("emulator-loaded", resolve);
        emulator.add_listener("emulator-error", reject);
    });
    return emulator;
}

/** The cards of a machine: before M1 the core's devices, since then the plugins' */
function cards(emulator)
{
    const devices = emulator.v86.cpu.devices;
    return {
        ne2k: devices.net && (devices.net.device ? devices.net.device["card"] : devices.net),
        sb16: devices.sb16 || devices.audio && devices.audio.device["card"],
    };
}

/** A state as plain values (typed arrays as arrays), for comparing */
const plain = state => JSON.parse(JSON.stringify(state, (key, value) => ArrayBuffer.isView(value) ? Array.from(value) : value));

/** The cards' states, the NE2000's own random address left out (its address in the state is) */
function card_states(emulator)
{
    const { ne2k, sb16 } = cards(emulator);
    const net = plain(ne2k.get_state());
    net[15] = "own address";
    return { ne2k: net, mac_in_state: plain(ne2k.mac_address_in_state), sb16: plain(sb16.get_state()) };
}

/** Run for SECONDS with a speaker that takes the SB16's samples at its rate: what happened */
async function run(emulator, seconds)
{
    const cpu = emulator.v86.cpu;
    const resets_before = cpu.last_reset ? cpu.last_reset["count"] : 0;
    let rate = 22050, queued = 0, last = performance.now(), samples = 0, loud = 0, frames = 0;
    emulator.bus.register("dac-tell-sampling-rate", r => { rate = r; });
    emulator.bus.register("dac-send-data", data => {
        queued += data[0].length;
        samples += data[0].length;
        for(const channel of data) for(const sample of channel) if(Math.abs(sample) > 1e-3) loud++;
    });
    emulator.bus.register("net0-send", () => { frames++; });
    const speaker = setInterval(() => {
        const now = performance.now();
        queued = Math.max(0, queued - rate * (now - last) / 1000);
        last = now;
        if(queued < rate * 0.2) emulator.bus.send("dac-request-data");
    }, 5);
    const before = emulator.get_instruction_counter() >>> 0;
    let instructions = 0, previous = before;
    await emulator.run();
    const end = Date.now() + seconds * 1000;
    while(Date.now() < end)
    {
        await new Promise(resolve => setTimeout(resolve, 250));
        const now = emulator.get_instruction_counter() >>> 0;
        instructions += (now - previous) >>> 0;
        previous = now;
    }
    await emulator.stop();
    clearInterval(speaker);
    return {
        instructions,
        reset: (cpu.last_reset ? cpu.last_reset["count"] : 0) !== resets_before,
        samples, loud, frames,
    };
}

const report = {};
let failed = 0;
for(const id of wanted)
{
    const game = GAMES[id];
    const file = path.join(SITE, game.stateurl.replace(/^https?:\/\/[^/]+\//, ""));
    if(!fs.existsSync(file))
    {
        console.log("skip " + id + ": no local " + file);
        continue;
    }
    const raw = execFileSync("zstd", ["-dc", file], { maxBuffer: 2 ** 31 });
    const version = raw.readInt32LE(4);
    const state = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length);
    const gl = raw.subarray(16, 16 + raw.readInt32LE(12)).includes("\"v86gl\"");
    const entry = report[id] = { version };
    try
    {
        // this build: the old slots through the plugins
        let emulator = await machine(V86, game, gl);
        await emulator.restore_state(state);
        assert.equal(emulator.v86.cpu.devices.net.name, "ne2k");
        assert.equal(emulator.v86.cpu.devices.audio.name, "sb16");
        const restored = card_states(emulator);
        entry.new = await run(emulator, SECONDS);
        const resaved = await emulator.save_state();
        await emulator.destroy();
        assert.equal(new Int32Array(resaved, 0, 2)[1], 8, "saved again: format 8");

        // its own save (the slots tagged), back in this build
        const header = new Int32Array(resaved, 0, 4);
        const tagged = JSON.parse(Buffer.from(resaved, 16, header[3]).toString("utf8")).state;
        assert.deepEqual([tagged[59][0], tagged[59][2], tagged[61][0], tagged[61][2]], ["net_adapter", "ne2k", "audio_device", "sb16"]);
        emulator = await machine(V86, game, gl);
        await emulator.restore_state(resaved);
        entry.resaved = await run(emulator, Math.min(SECONDS, 5));
        await emulator.destroy();
        assert.ok(entry.resaved.instructions > 0 && !entry.resaved.reset, "the new save goes on");

        if(OLD)
        {
            // the build before M1: the same cards' states, its own run
            emulator = await machine(OLD, game, gl);
            await emulator.restore_state(state);
            assert.deepEqual(restored, card_states(emulator), "the cards' states as the build before M1 restores them");
            entry.old = await run(emulator, SECONDS);
            // and this build's new save: refused
            await assert.rejects(emulator.restore_state(resaved), /Version mismatch/);
            await emulator.destroy();
        }
        assert.ok(entry.new.instructions > 0 && !entry.new.reset, "the guest goes on");
        if(entry.old) assert.equal(entry.new.reset, entry.old.reset);
        console.log("ok - " + id + " (format " + version + "): " + JSON.stringify(entry));
    }
    catch(error)
    {
        failed++;
        entry.error = String(error && error.stack || error);
        console.log("FAIL - " + id + ": " + entry.error.split("\n").slice(0, 4).join(" | ") + " " + JSON.stringify(entry));
    }
}
if(process.env.REPORT) fs.writeFileSync(process.env.REPORT, JSON.stringify(report, null, 1));
console.log((failed ? "FAIL" : "PASS") + ": " + (Object.keys(report).length - failed) + " of " + Object.keys(report).length + " states");
process.exit(failed ? 1 : 0);
