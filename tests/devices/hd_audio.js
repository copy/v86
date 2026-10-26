#!/usr/bin/env node

// The HD Audio controller (audio_device "hd_audio", the plugin of
// src/audio_devices/hd_audio/), driven through its registers, rings and
// buffer descriptor lists in guest memory; no guest code runs, the test moves
// the machine clock (docs/modern-pc-devices-plan.md, H1): PCI identity on
// i440FX and Q35, the controller reset and the codec's presence, CORB/RIRB
// and immediate commands, the codec's nodes and verbs, an output stream
// (rate, LPIB, the DMA position buffer, completion interrupts, wrap, SSYNC,
// the amplifier), descriptor errors, the wall clock and snapshots.

import assert from "node:assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

let host = 1000;
const options = machine_type => ({
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    memory_size: 32 * 1024 * 1024,
    machine_type,
    acpi: machine_type === "q35",
    audio_device: "hd_audio",
    net_device: { type: "none" },
    cpu_clock: { mode: "normal", now: () => host },
    autostart: false,
    log_level: 0,
});

async function machine(machine_type)
{
    const emulator = new V86(options(machine_type));
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    emulator.v86.cpu.clock.resume();
    return emulator;
}

let failed = 0, passed = 0;
function test(name, f)
{
    try
    {
        f();
        passed++;
        console.log("ok - " + name);
    }
    catch(e)
    {
        failed++;
        console.log("FAIL - " + name);
        console.log(e);
    }
}

const emulator = await machine("i440fx");
const cpu = emulator.v86.cpu;
const pci = cpu.devices.pci;
const mem = cpu.mem8;
const HDA = 0x1B << 3;
const BAR = 0xC0000000;

const r8 = offset => cpu.mmap_read8(BAR + offset);
// (v86 splits 16-bit MMIO accesses into bytes, as the guest's would be)
const r16 = offset => r8(offset) | r8(offset + 1) << 8;
const r32 = offset => cpu.mmap_read32(BAR + offset) >>> 0;
const w8 = (offset, value) => cpu.mmap_write8(BAR + offset, value);
const w16 = (offset, value) => cpu.mmap_write16(BAR + offset, value);
const w32 = (offset, value) => cpu.mmap_write32(BAR + offset, value | 0);
const u32 = a => (mem[a] | mem[a + 1] << 8 | mem[a + 2] << 16 | mem[a + 3] << 24) >>> 0;
const put32 = (a, v) => { mem[a] = v; mem[a + 1] = v >> 8; mem[a + 2] = v >> 16; mem[a + 3] = v >>> 24; };
const irq = () => !!pci.intx_levels[HDA];
const controller = () => cpu.devices.audio.device["controller"];

function advance(ms)
{
    host += ms;
    cpu.run_hardware_timers(false, cpu.clock.now());
}

const R = {
    GCAP: 0x00, VMIN: 0x02, VMAJ: 0x03, GCTL: 0x08, WAKEEN: 0x0C, STATESTS: 0x0E, INTCTL: 0x20, INTSTS: 0x24, WALCLK: 0x30,
    SSYNC: 0x38, CORBLBASE: 0x40, CORBUBASE: 0x44, CORBWP: 0x48, CORBRP: 0x4A, CORBCTL: 0x4C, CORBSIZE: 0x4E,
    RIRBLBASE: 0x50, RIRBUBASE: 0x54, RIRBWP: 0x58, RINTCNT: 0x5A, RIRBCTL: 0x5C, RIRBSTS: 0x5D, ICOI: 0x60, ICII: 0x64,
    ICIS: 0x68, DPLBASE: 0x70, DPUBASE: 0x74,
};
const SD = 0x80;
const SD_CTL = SD, SD_STS = SD + 3, SD_LPIB = SD + 4, SD_CBL = SD + 8, SD_LVI = SD + 0xC, SD_FIFOS = SD + 0x10, SD_FMT = SD + 0x12,
    SD_BDPL = SD + 0x18, SD_BDPU = SD + 0x1C;
const CORB = 0x100000, RIRB = 0x101000, BDL = 0x102000, POSITIONS = 0x103000, PCM = 0x200000;

/** The PCM (raw bytes) and the speaker's samples the controller sent */
let pcm = [], speaker = [], rates = [];
emulator.add_listener("hd-audio-pcm", info => pcm.push(...info["chunks"].map(chunk => new Uint8Array(chunk))));
emulator.add_listener("dac-send-data", data => speaker.push(data));
emulator.add_listener("dac-tell-sampling-rate", rate => rates.push(rate));
const pcm_bytes = () => { const all = new Uint8Array(pcm.reduce((n, c) => n + c.length, 0)); let at = 0; for(const c of pcm) { all.set(c, at); at += c.length; } return all; };

// --- PCI ---------------------------------------------------------------------

test("PCI: ICH6 HD Audio (8086:2668) at 00:1b.0 on i440FX, class 04/03/00, INTA, 16 KiB BAR0", () => {
    const space = pci.space_bytes(HDA);
    const word = o => space[o] | space[o + 1] << 8;
    assert.equal(word(0), 0x8086);
    assert.equal(word(2), 0x2668);
    assert.deepEqual([space[0x0B], space[0x0A], space[0x09]], [4, 3, 0]);
    assert.equal(space[0x3D], 1);
    pci.config_write(HDA, 0x10, 4, -1);
    assert.equal((space[0x10] | space[0x11] << 8 | space[0x12] << 16 | space[0x13] << 24) >>> 0, 0xFFFFC000);
    pci.config_write(HDA, 0x10, 4, BAR);
    pci.config_write(HDA, 0x04, 2, 0x0006);
    assert.equal(r16(R.GCAP), 0x1001, "one output stream, no input, 64-bit");
    assert.deepEqual([r8(R.VMAJ), r8(R.VMIN)], [1, 0]);
});

// --- reset and commands --------------------------------------------------------

test("GCTL.CRST: in reset nothing else is written; leaving it, the codec at address 0 (STATESTS)", () => {
    w32(R.GCTL, 0);
    assert.equal(r32(R.GCTL) & 1, 0);
    w32(R.INTCTL, -1);
    assert.equal(r32(R.INTCTL), 0, "in reset");
    w32(R.GCTL, 1);
    assert.equal(r32(R.GCTL) & 1, 1);
    assert.equal(r16(R.STATESTS), 1);
    w16(R.STATESTS, 1);
    assert.equal(r16(R.STATESTS), 0, "write one to clear");
});

let corb_wp = 0, rirb_rp = 0;
function setup_rings()
{
    w8(R.CORBCTL, 0);
    w8(R.RIRBCTL, 0);
    w32(R.CORBLBASE, CORB); w32(R.CORBUBASE, 0);
    w32(R.RIRBLBASE, RIRB); w32(R.RIRBUBASE, 0);
    assert.equal(r8(R.CORBSIZE), 0x42, "256 entries");
    // (the read pointer's reset handshake, as Linux does it)
    w16(R.CORBRP, 0x8000);
    assert.equal(r16(R.CORBRP), 0x8000);
    w16(R.CORBRP, 0);
    assert.equal(r16(R.CORBRP), 0);
    w16(R.CORBWP, 0);
    w16(R.RIRBWP, 0x8000);
    assert.equal(r16(R.RIRBWP), 0);
    w16(R.RINTCNT, 1);
    w8(R.RIRBCTL, 3);
    w8(R.CORBCTL, 2);
    corb_wp = 0; rirb_rp = 0;
}
/** Commands through the CORB; their responses from the RIRB */
function commands(...verbs)
{
    for(const verb of verbs)
    {
        corb_wp = corb_wp + 1 & 0xFF;
        put32(CORB + 4 * corb_wp, verb);
    }
    w16(R.CORBWP, corb_wp);
    const responses = [];
    while(rirb_rp !== r16(R.RIRBWP))
    {
        rirb_rp = rirb_rp + 1 & 0xFF;
        responses.push(u32(RIRB + 8 * rirb_rp));
        assert.equal(u32(RIRB + 8 * rirb_rp + 4), 0, "solicited, codec 0");
    }
    w8(R.RIRBSTS, 1);
    return responses;
}
const verb = (nid, verb12, payload = 0) => nid << 20 | verb12 << 8 | payload;
const verb4 = (nid, verb, payload) => nid << 20 | verb << 16 | payload;
const param = (nid, id) => verb(nid, 0xF00, id);

test("CORB and RIRB: responses in order, RINTFL and the controller interrupt (CIE, GIE)", () => {
    setup_rings();
    w32(R.INTCTL, 1 << 31 | 1 << 30);
    corb_wp = corb_wp + 1 & 0xFF;
    put32(CORB + 4 * corb_wp, param(0, 0));
    w16(R.CORBWP, corb_wp);
    assert.equal(r16(R.CORBRP), corb_wp, "read up to the write pointer");
    assert.equal(r16(R.RIRBWP), 1);
    assert.equal(u32(RIRB + 8), 0x1AF40012, "vendor ID");
    assert.equal(r8(R.RIRBSTS) & 1, 1, "RINTFL");
    assert.ok(irq());
    assert.equal(r32(R.INTSTS), (1 << 31 | 1 << 30) >>> 0);
    w8(R.RIRBSTS, 1);
    assert.ok(!irq());
    rirb_rp = 1;
    w16(R.RINTCNT, 2);
    assert.deepEqual(commands(param(0, 2), param(0, 4), param(1, 5)), [0x00100101, 0x00010001, 0x01]);
});

test("the codec: the function group, a DAC and a line out pin connected to it", () => {
    const [nodes, fg_nodes, dac, pin, pcm_formats, streams, conn_len, conn, config, pin_cap, amp] = commands(
        param(0, 4), param(1, 4), param(2, 9), param(3, 9), param(1, 0xA), param(2, 0xB), param(3, 0xE), verb(3, 0xF02),
        verb(3, 0xF1C), param(3, 0xC), param(2, 0x12));
    assert.equal(nodes, 0x00010001);
    assert.equal(fg_nodes, 0x00020002);
    assert.equal(dac >>> 20 & 0xF, 0, "an audio output");
    assert.equal(dac & 0x15, 0x15, "stereo, output amp, format override");
    assert.equal(pin >>> 20 & 0xF, 4, "a pin");
    assert.ok(pin & 1 << 8, "with a connection list");
    assert.equal(pcm_formats, 1 << 17 | 1 << 5 | 1 << 6, "16 bits, 44.1 and 48 kHz");
    assert.equal(streams, 1, "PCM");
    assert.deepEqual([conn_len, conn], [1, 2]);
    assert.equal(config, 0x00004010, "line out, green");
    assert.equal(pin_cap, 1 << 4, "output");
    assert.equal(amp >>> 31, 1, "a mute");
    assert.equal(amp >> 8 & 0x7F, 0x4A);
});

test("the codec's verbs: format, stream and channel, amplifier, pin control, power, config bytes, reset", () => {
    commands(verb4(2, 0x2, 0x0011), verb(2, 0x706, 0x10), verb4(2, 0x3, 0xB000 | 0x40), verb(3, 0x707, 0x40),
        verb(1, 0x705, 3), verb(3, 0x71F, 0x90));
    const [format, conv, left, right, pinctl, power, config] = commands(verb4(2, 0xA, 0), verb(2, 0xF06), verb4(2, 0xB, 0xA000),
        verb4(2, 0xB, 0x8000), verb(3, 0xF07), verb(1, 0xF05), verb(3, 0xF1C));
    assert.deepEqual([format, conv, left, right, pinctl, power, config], [0x0011, 0x10, 0x40, 0x40, 0x40, 0x33, 0x90004010]);
    commands(verb(1, 0x7FF));
    assert.deepEqual(commands(verb(2, 0xF06), verb4(2, 0xB, 0xA000), verb(3, 0xF1C)), [0, 0x4A, 0x00004010]);
});

test("the immediate command: ICOI, ICIS.ICB, the response in ICII with IRV", () => {
    w32(R.ICOI, param(0, 0));
    w16(R.ICIS, 1);
    assert.equal(r16(R.ICIS) & 3, 2, "not busy, valid");
    assert.equal(r32(R.ICII), 0x1AF40012);
    w16(R.ICIS, 2);
    assert.equal(r16(R.ICIS) & 3, 0);
    w32(R.ICOI, 1 << 28 | param(0, 0));
    w16(R.ICIS, 1);
    assert.equal(r16(R.ICIS) & 1, 1, "no codec at address 1: busy (the driver times out)");
    w32(R.GCTL, 0);
    w32(R.GCTL, 1);
    setup_rings();
});

test("the wall clock: 24 MHz", () => {
    const before = r32(R.WALCLK);
    advance(1);
    assert.equal(r32(R.WALCLK) - before, 24000);
});

// --- an output stream ---------------------------------------------------------

const FMT_48K_16_STEREO = 0x0011, FMT_44K_16_STEREO = 0x4011;
const PERIOD = 1920;
/** Four descriptors of 1920 bytes (10 ms at 48 kHz), IOC on each second */
function setup_stream(fmt = FMT_48K_16_STEREO, ioc = [false, true, false, true])
{
    w32(SD_CTL, 1);
    assert.equal(r32(SD_CTL) & 1, 1, "in reset");
    w32(SD_CTL, 0);
    for(let i = 0; i < 4; i++)
    {
        put32(BDL + 16 * i, PCM + i * PERIOD); put32(BDL + 16 * i + 4, 0);
        put32(BDL + 16 * i + 8, PERIOD); put32(BDL + 16 * i + 12, ioc[i] ? 1 : 0);
    }
    for(let i = 0; i < 4 * PERIOD; i++) mem[PCM + i] = i * 7 + (i >> 8) & 0xFF;
    w32(SD_BDPL, BDL); w32(SD_BDPU, 0);
    w32(SD_CBL, 4 * PERIOD);
    w16(SD_LVI, 3);
    w16(SD_FMT, fmt);
    commands(verb4(2, 0x2, fmt), verb(2, 0x706, 0x10), verb(3, 0x707, 0x40), verb4(2, 0x3, 0xB000 | 0x4A));
    pcm = []; speaker = []; rates = [];
}

test("a stream plays at its rate: LPIB, the PCM in order, the speaker told 48000 Hz", () => {
    setup_stream();
    assert.equal(r16(SD_FIFOS), 0xFF);
    w32(R.INTCTL, 1 << 31 | 1);
    w32(SD_CTL, 1 << 20 | 1 << 2 | 2);
    assert.deepEqual(rates, [48000]);
    advance(5);
    assert.equal(r32(SD_LPIB), 960, "5 ms: 240 frames of 4 bytes");
    assert.ok(!irq());
    advance(6);
    assert.equal(r32(SD_LPIB), 2112);
    assert.equal(r8(SD_STS) & 4, 0, "the first descriptor has no IOC");
    advance(10);
    assert.equal(r32(SD_LPIB), 4032);
    assert.equal(r8(SD_STS) & 4, 4, "BCIS: the second descriptor done");
    assert.ok(irq(), "the stream's interrupt");
    assert.equal(r32(R.INTSTS) & 1, 1);
    w8(SD_STS, 4);
    assert.ok(!irq());
    assert.deepEqual(pcm_bytes(), mem.slice(PCM, PCM + 4032));
    const samples = speaker.reduce((n, [left]) => n + left.length, 0);
    assert.equal(samples, 1008);
    const view = new DataView(mem.buffer, mem.byteOffset);
    assert.equal(speaker[0][0][0], view.getInt16(PCM, true) / 32768, "0 dB: the samples as they are");
    assert.equal(speaker[0][1][0], view.getInt16(PCM + 2, true) / 32768);
});

test("the cyclic buffer wraps at CBL, the DMA position buffer follows LPIB", () => {
    w32(R.DPLBASE, POSITIONS | 1); w32(R.DPUBASE, 0);
    advance(25);
    assert.equal(r32(SD_LPIB), (4032 + 4800) % (4 * PERIOD));
    assert.equal(u32(POSITIONS), r32(SD_LPIB));
    assert.equal(pcm_bytes().length, 4032 + 4800);
    assert.deepEqual(pcm_bytes().slice(4 * PERIOD), mem.slice(PCM, PCM + 4032 + 4800 - 4 * PERIOD), "from the start again");
});

test("RUN cleared: the position stays; set again: it goes on from there", () => {
    w32(SD_CTL, 1 << 20 | 1 << 2);
    const lpib = r32(SD_LPIB);
    advance(20);
    assert.equal(r32(SD_LPIB), lpib);
    w32(SD_CTL, 1 << 20 | 1 << 2 | 2);
    advance(1);
    assert.equal(r32(SD_LPIB), (lpib + 192) % (4 * PERIOD));
    w32(SD_CTL, 1 << 20 | 1 << 2);
});

test("SSYNC holds a running stream until it is cleared", () => {
    setup_stream();
    w32(R.SSYNC, 1);
    w32(SD_CTL, 1 << 20 | 2);
    advance(10);
    assert.equal(r32(SD_LPIB), 0);
    w32(R.SSYNC, 0);
    advance(10);
    assert.equal(r32(SD_LPIB), 1920);
    w32(SD_CTL, 1 << 20);
});

test("44.1 kHz; the amplifier's gain and mute; a stream the DAC does not take is silent", () => {
    setup_stream(FMT_44K_16_STEREO);
    commands(verb4(2, 0x3, 0xA000 | 0x4A - 6), verb4(2, 0x3, 0x9000 | 0x80));
    w32(SD_CTL, 1 << 20 | 2);
    assert.deepEqual(rates, [44100]);
    advance(10);
    assert.equal(r32(SD_LPIB), 441 * 4);
    const view = new DataView(mem.buffer, mem.byteOffset);
    assert.ok(Math.abs(speaker[0][0][1] - view.getInt16(PCM + 4, true) / 32768 * Math.pow(10, -6 / 20)) < 1e-6, "left: -6 dB");
    assert.equal(speaker[0][1][1], 0, "right: muted");
    w32(SD_CTL, 1 << 20);
    setup_stream();
    commands(verb(2, 0x706, 0x20));
    w32(SD_CTL, 1 << 20 | 2);
    advance(5);
    assert.ok(speaker.every(([left, right]) => left.every(v => v === 0) && right.every(v => v === 0)), "tag 1, DAC on 2");
    assert.equal(r32(SD_LPIB), 960, "the stream runs nevertheless");
    w32(SD_CTL, 1 << 20);
});

test("a bad descriptor list: DESE, the stream stops (DEIE: an interrupt)", () => {
    setup_stream();
    put32(BDL + 8, 0);
    w32(R.INTCTL, 1 << 31 | 1);
    w32(SD_CTL, 1 << 20 | 1 << 4 | 2);
    advance(5);
    assert.equal(r8(SD_STS) & 0x10, 0x10);
    assert.equal(r32(SD_CTL) & 2, 0, "stopped");
    assert.ok(irq());
    w8(SD_STS, 0x10);
    assert.ok(!irq());
});

test("SRST: the descriptor to its defaults", () => {
    w32(SD_CTL, 1);
    assert.deepEqual([r32(SD_CTL) & 0xFFFFFF, r32(SD_LPIB), r32(SD_CBL), r16(SD_LVI), r16(SD_FMT), r32(SD_BDPL)], [1, 0, 0, 0, 0, 0]);
    w32(SD_CTL, 0);
});

// --- snapshots ------------------------------------------------------------------

{
    setup_stream();
    w32(R.INTCTL, 1 << 31 | 1);
    w32(SD_CTL, 1 << 20 | 1 << 2 | 2);
    advance(15);
    const lpib = r32(SD_LPIB);
    const state = await emulator.save_state();
    advance(100);
    w32(R.GCTL, 0);
    await emulator.restore_state(state);
    test("snapshot: the stream goes on from where it was, the rings and the codec as they were", () => {
        assert.equal(r32(R.GCTL) & 1, 1);
        assert.equal(r32(SD_LPIB), lpib);
        assert.equal(r32(SD_CTL) & 2, 2);
        advance(5);
        assert.equal(r32(SD_LPIB), lpib + 960);
        assert.deepEqual(commands(verb(2, 0xF06)), [0x10]);
    });
    w32(SD_CTL, 1 << 20);

    const other = new V86({ ...options("i440fx"), audio_device: "sb16" });
    await new Promise(resolve => other.add_listener("emulator-loaded", resolve));
    let error;
    await other.restore_state(state).catch(e => { error = e; });
    test("snapshot: a machine with another sound card refuses it", () => {
        assert.match(String(error && error.message), /audio_device: "hd_audio", this one has "sb16"/);
    });
    await other.destroy();
}

// --- Q35 -------------------------------------------------------------------------

{
    const q35 = await machine("q35");
    const space = q35.v86.cpu.devices.pci.space_bytes(HDA);
    test("Q35: ICH9 HD Audio (8086:293E) at 00:1b.0", () => {
        assert.equal(space[2] | space[3] << 8, 0x293E);
        assert.equal(space[8], 3, "revision 3");
    });
    await q35.destroy();
}

await emulator.destroy();
console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
