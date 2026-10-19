#!/usr/bin/env node

// Hard disks with logical sectors of 4096 bytes (docs/disk-image-formats-plan.md,
// the appendix's "4K 逻辑扇区"), driven through the ports and AHCI's
// command structures; no guest code runs.
// - IDE (i440FX), a RAW disk with logical_sector_size 4096 next to a
//   512-byte one: IDENTIFY words 106 and 117-118 (none for the 512-byte
//   disk) and the capacity in 4096-byte sectors; READ/WRITE SECTORS with a
//   DRQ block (and an interrupt) per 4096-byte sector, READ/WRITE MULTIPLE
//   with blocks of the multiple count, READ/WRITE DMA through the bus
//   master, IDNF past the end;
// - AHCI (Q35), a VHDX image with 4096-byte sectors: IDENTIFY, DMA, PIO
//   (the PIO setup FIS's count: a sector) and NCQ reads and writes;
// - snapshots: restored onto the same disks; refused before anything is
//   restored where a disk's sector size is another;
// - options: a size that is not a multiple of the sector size, a value
//   other than 512 or 4096: emulator-error;
// - SeaBIOS does not boot from such a disk (images/msdos622.img's data):
//   it reports that it cannot read it and goes on.

import assert from "node:assert/strict";
import fs from "node:fs";
import url from "node:url";
import { build_vhdx } from "../image/tiny_vhdx.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const S = 4096;
const SIZE = 8 << 20;
const pattern = new Uint8Array(SIZE).map((_, i) => i * 7 + (i >> 12) & 0xFF);

function config(extra)
{
    return {
        graphics_adapter: "bochs_vga",
        bios: { url: __dirname + "/../../bios/seabios.bin" },
        vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
        autostart: false,
        memory_size: 32 * 1024 * 1024,
        log_level: 0,
        ...extra,
    };
}

async function start(extra)
{
    const emulator = new V86(config(extra));
    await new Promise((resolve, reject) =>
    {
        emulator.add_listener("emulator-loaded", resolve);
        emulator.add_listener("emulator-error", reject);
    });
    return emulator;
}

// ---- IDE ------------------------------------------------------------------

const hda_bytes = pattern.slice();
const hdb_bytes = new Uint8Array(1 << 20).map((_, i) => i & 0xFF);
const ide_config = () => ({ hda: { buffer: hda_bytes.buffer, logical_sector_size: 4096 }, hdb: { buffer: hdb_bytes.buffer } });
let emulator = await start(ide_config());
let cpu = emulator.v86.cpu, io = cpu.io;
const channel = cpu.devices.ide.primary;

const DATA = 0x1F0, ERROR = 0x1F1, COUNT = 0x1F2, LBA_LOW = 0x1F3, LBA_MID = 0x1F4, LBA_HIGH = 0x1F5, DEVICE = 0x1F6, COMMAND = 0x1F7, CONTROL = 0x3F6;
const BM_COMMAND = 0xB400, BM_STATUS = 0xB402, BM_PRDT = 0xB404;
const DRQ = 0x08, ERR = 0x01, BSY = 0x80, IDNF = 0x10;
// (interrupts on: the test counts the channel's)
io.port_write8(CONTROL, 0);
let pushes = 0;
{
    const raise = cpu.device_raise_irq.bind(cpu);
    cpu.device_raise_irq = irq => { if(irq === channel.irq) pushes++; raise(irq); };
}

const status = () => io.port_read8(COMMAND);
async function until_ready()
{
    for(let i = 0; i < 1000 && status() & BSY; i++) await new Promise(resolve => setTimeout(resolve, 1));
}

function read_words(count)
{
    assert.equal(status() & (DRQ | ERR), DRQ, "data ready");
    return Array.from({ length: count }, () => io.port_read16(DATA));
}

function identify(device)
{
    io.port_write8(DEVICE, device);
    io.port_write8(COMMAND, 0xEC);
    return read_words(256);
}

/** a command of 28-bit LBA (device: 0xE0 master, 0xF0 slave) */
function command28(lba, count, command, device = 0xE0)
{
    io.port_write8(DEVICE, device | lba >> 24 & 0xF);
    io.port_write8(COUNT, count & 0xFF);
    io.port_write8(LBA_LOW, lba & 0xFF);
    io.port_write8(LBA_MID, lba >> 8 & 0xFF);
    io.port_write8(LBA_HIGH, lba >> 16 & 0xFF);
    io.port_write8(COMMAND, command);
}

function command48(lba, count, command)
{
    io.port_write8(DEVICE, 0x40);
    io.port_write8(COUNT, count >> 8);
    io.port_write8(LBA_LOW, Math.floor(lba / 2 ** 24) & 0xFF);
    io.port_write8(LBA_MID, Math.floor(lba / 2 ** 32) & 0xFF);
    io.port_write8(LBA_HIGH, Math.floor(lba / 2 ** 40) & 0xFF);
    io.port_write8(COUNT, count & 0xFF);
    io.port_write8(LBA_LOW, lba & 0xFF);
    io.port_write8(LBA_MID, lba >> 8 & 0xFF);
    io.port_write8(LBA_HIGH, lba >> 16 & 0xFF);
    io.port_write8(COMMAND, command);
}

/**
 * The data of a PIO read in DRQ blocks of `block` bytes: the device asks
 * for each block with an interrupt and DRQ, and keeps DRQ within it
 */
async function pio_in(total, block)
{
    await until_ready();
    const bytes = new Uint8Array(total);
    for(let at = 0; at < total; at += block)
    {
        const before = pushes;
        const n = Math.min(block, total - at);
        for(let i = 0; i < n; i += 2)
        {
            assert.equal(status() & (DRQ | ERR), DRQ, "DRQ within the block at " + (at + i));
            const word = io.port_read16(DATA);
            bytes[at + i] = word;
            bytes[at + i + 1] = word >> 8;
            if(i + 2 < n) assert.equal(pushes, before, "no interrupt within a block");
        }
        assert.equal(pushes, before + (at + n < total ? 1 : 0), "an interrupt for the next block");
    }
    assert.equal(status() & (DRQ | ERR | BSY), 0, "done");
    return bytes;
}

async function pio_out(bytes, block)
{
    for(let at = 0; at < bytes.length; at += block)
    {
        assert.equal(status() & (DRQ | ERR), DRQ, "ready for the block at " + at);
        const before = pushes;
        const n = Math.min(block, bytes.length - at);
        for(let i = 0; i < n; i += 2)
        {
            io.port_write16(DATA, bytes[at + i] | bytes[at + i + 1] << 8);
            if(i + 2 < n) assert.equal(pushes, before, "no interrupt within a block");
        }
        assert.equal(pushes, before + 1, "an interrupt after the block");
    }
    await until_ready();
    assert.equal(status() & (DRQ | ERR | BSY), 0, "done");
}

const PRDT = 0x10000, DMA_BUFFER = 0x100000;
async function dma(command, lba, count, out)
{
    const length = count * S;
    // two PRD entries, 8 KiB and the rest
    const prd = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset + PRDT, 16);
    prd.setUint32(0, DMA_BUFFER, true); prd.setUint16(4, 8192, true); prd.setUint16(6, 0, true);
    prd.setUint32(8, DMA_BUFFER + 8192, true); prd.setUint16(12, length - 8192, true); prd.setUint16(14, 0x8000, true);
    if(out) cpu.mem8.set(out, DMA_BUFFER);
    else cpu.mem8.fill(0xEE, DMA_BUFFER, DMA_BUFFER + length + 512);
    io.port_write8(BM_STATUS, 6);
    io.port_write32(BM_PRDT, PRDT);
    command28(lba, count, command);
    io.port_write8(BM_COMMAND, out ? 0x01 : 0x09);
    await until_ready();
    assert.equal(io.port_read8(BM_STATUS) & 3, 0, "the bus master is done, no error");
    io.port_write8(BM_COMMAND, 0);
    assert.equal(status() & (ERR | DRQ | BSY), 0, "the command is done");
    return cpu.mem8.slice(DMA_BUFFER, DMA_BUFFER + length + 512);
}

{
    const words = identify(0xE0);
    assert.equal(words[106], 0x5000, "word 106: valid, logical sectors longer than 256 words, one per physical sector");
    assert.deepEqual(words.slice(117, 119), [2048, 0], "words 117-118: 2048 words per logical sector");
    assert.equal(words[60] | words[61] << 16, SIZE / S, "words 60-61: the capacity in 4096-byte sectors");
    assert.equal(words[100] | words[101] << 16, SIZE / S, "words 100-103: likewise");
    const words_512 = identify(0xF0);
    assert.equal(words_512[106], 0, "the 512-byte disk: no word 106");
    assert.deepEqual(words_512.slice(117, 119), [0, 0]);
    assert.equal(words_512[60] | words_512[61] << 16, hdb_bytes.length / 512);
    assert.equal((await emulator.disk_image_info("hda")).logical_sector_size, 4096, "disk_image_info");
    assert.equal((await emulator.disk_image_info("hdb")).logical_sector_size, 512);
    console.log("ok - IDENTIFY: words 106 and 117-118, the capacity in 4096-byte sectors; the 512-byte disk unchanged; disk_image_info");
}

{
    command28(1, 2, 0x20);
    assert.deepEqual(await pio_in(2 * S, S), pattern.subarray(S, 3 * S), "READ SECTORS: LBA 1, two sectors");
    command48(SIZE / S - 3, 3, 0x24);
    assert.deepEqual(await pio_in(3 * S, S), pattern.subarray(SIZE - 3 * S), "READ SECTORS EXT: the last three");
    // the 512-byte disk on the same channel
    command28(3, 2, 0x20, 0xF0);
    assert.deepEqual(await pio_in(1024, 512), hdb_bytes.subarray(1536, 2560), "the 512-byte disk: blocks of 512 bytes");
    // READ MULTIPLE with 4 sectors a block
    command28(0, 4, 0xC6);
    await until_ready();
    command28(8, 6, 0xC4);
    assert.deepEqual(await pio_in(6 * S, 4 * S), pattern.subarray(8 * S, 14 * S), "READ MULTIPLE: blocks of 4 sectors");
    console.log("ok - PIO reads: a DRQ block per 4096-byte sector, READ MULTIPLE in blocks of 4 sectors");
}

{
    const data = new Uint8Array(3 * S).map((_, i) => 255 - (i * 3 & 0xFF));
    command28(20, 2, 0x30);
    await pio_out(data.subarray(0, 2 * S), S);
    assert.deepEqual(hda_bytes.subarray(20 * S, 22 * S), data.subarray(0, 2 * S), "WRITE SECTORS: in the image at LBA 20 * 4096");
    command28(0, 2, 0xC6);
    await until_ready();
    command28(30, 3, 0xC5);
    await pio_out(data, 2 * S);
    assert.deepEqual(hda_bytes.subarray(30 * S, 33 * S), data, "WRITE MULTIPLE: blocks of 2 sectors");
    command28(30, 3, 0x20);
    assert.deepEqual(await pio_in(3 * S, S), data, "read back");
    assert.deepEqual(hda_bytes.subarray(33 * S, 34 * S), pattern.subarray(33 * S, 34 * S), "the next sector unchanged");
    console.log("ok - PIO writes: WRITE SECTORS, WRITE MULTIPLE, read back");
}

{
    const read = await dma(0xC8, 40, 3);
    assert.deepEqual(read.subarray(0, 3 * S), hda_bytes.subarray(40 * S, 43 * S), "READ DMA: 3 sectors through two PRD entries");
    assert.ok(read.subarray(3 * S).every(b => b === 0xEE), "nothing beyond");
    const data = new Uint8Array(2 * S).map((_, i) => i * 13 & 0xFF);
    await dma(0xCA, 50, 2, data);
    assert.deepEqual(hda_bytes.subarray(50 * S, 52 * S), data, "WRITE DMA: in the image");
    console.log("ok - DMA: READ DMA and WRITE DMA of 4096-byte sectors through the bus master");
}

{
    command28(SIZE / S - 1, 2, 0x20);
    await until_ready();
    assert.equal(status() & (ERR | DRQ), ERR, "past the end");
    assert.equal(io.port_read8(ERROR), IDNF, "IDNF");
    command28(SIZE / S - 1, 1, 0x20);
    assert.deepEqual(await pio_in(S, S), hda_bytes.subarray(SIZE - S), "the last sector");
    console.log("ok - past the end of the disk (in 4096-byte sectors): IDNF");
}

// snapshots: the same disks, then one whose sector size is another
const state = await emulator.save_state();
const words_before = identify(0xE0);
await emulator.destroy();
{
    const same = await start(ide_config());
    await same.restore_state(state);
    cpu = same.v86.cpu; io = cpu.io;
    assert.deepEqual(identify(0xE0), words_before, "restored: the same IDENTIFY");
    await same.destroy();
    const other = await start({ hda: { buffer: hda_bytes.slice().buffer }, hdb: { buffer: hdb_bytes.slice().buffer } });
    const memory_before = other.v86.cpu.mem8.slice(0, 1 << 20);
    await assert.rejects(other.restore_state(state), /sector/, "a 512-byte disk refuses the 4096-byte disk's state");
    assert.deepEqual(other.v86.cpu.mem8.slice(0, 1 << 20), memory_before, "nothing was restored");
    assert.equal(other.v86.cpu.devices.ide.primary.master.sector_size, 512);
    await other.destroy();
    console.log("ok - snapshots: restored onto the same disks, refused where a disk's sector size differs");
}

// ---- AHCI -----------------------------------------------------------------

const vhdx_data = [[0, pattern.slice(0, 1 << 20)]];
const vhdx = build_vhdx({ size: 16 << 20, logical_sector_size: 4096, data: vhdx_data });
emulator = await start({ machine_type: "q35", memory_size: 64 << 20, hda: { buffer: vhdx.image.buffer, format: "vhdx" } });
cpu = emulator.v86.cpu;
const pci = cpu.devices.pci;
const mem = cpu.mem8;
const AHCI = 0x1F << 3 | 2;
const ABAR = 0xC0000000;
const r32 = offset => cpu.mmap_read32(ABAR + offset) >>> 0;
const w32 = (offset, value) => cpu.mmap_write32(ABAR + offset, value | 0);
const pr = (port, reg) => r32(0x100 + port * 0x80 + reg);
const pw = (port, reg, value) => w32(0x100 + port * 0x80 + reg, value);
const u32 = a => (mem[a] | mem[a + 1] << 8 | mem[a + 2] << 16 | mem[a + 3] << 24) >>> 0;
const put32 = (a, v) => { mem[a] = v; mem[a + 1] = v >> 8; mem[a + 2] = v >> 16; mem[a + 3] = v >>> 24; };
const PX = { CLB: 0x00, FB: 0x08, IS: 0x10, CMD: 0x18, TFD: 0x20, SERR: 0x30, SACT: 0x34, CI: 0x38 };
const clb = 0x200000, fb = clb + 0x400, table = clb + 0x1000, BUFFER = 0x400000;
pci.config_write(AHCI, 0x24, 4, ABAR);
pci.config_write(AHCI, 0x04, 2, 0x0006);
w32(0x04, 1 << 31);
pw(0, PX.CMD, 0);
pw(0, PX.CLB, clb);
pw(0, PX.FB, fb);
mem.fill(0, clb, clb + 0x10000);
pw(0, PX.CMD, 1 << 4);
pw(0, PX.SERR, -1);
pw(0, PX.IS, -1);
pw(0, PX.CMD, 1 << 4 | 1);

/** a command in slot `slot` (its table at table + slot * 0x100) */
async function ahci(c)
{
    const slot = c.slot || 0, at = table + slot * 0x100;
    mem.fill(0, at, at + 0x100);
    const lba = c.lba || 0, count = c.count || 0, features = c.features || 0;
    mem.set([0x27, 0x80, c.command, features & 0xFF, lba & 0xFF, lba >> 8 & 0xFF, lba >> 16 & 0xFF, 0x40,
        Math.floor(lba / 2 ** 24) & 0xFF, 0, 0, features >> 8, count & 0xFF, count >> 8, 0, 0], at);
    const length = c.length;
    put32(at + 0x80, BUFFER);
    put32(at + 0x80 + 12, length - 1);
    const header = clb + slot * 32;
    put32(header, 5 | (c.write ? 1 << 6 : 0) | 1 << 16);
    put32(header + 4, 0xDEADBEEF);
    put32(header + 8, at);
    if(c.write) mem.set(c.data, BUFFER);
    else mem.fill(0xEE, BUFFER, BUFFER + length);
    pw(0, PX.IS, -1);
    if(c.queued) pw(0, PX.SACT, 1 << slot);
    pw(0, PX.CI, 1 << slot);
    for(let i = 0; i < 1000 && (pr(0, PX.CI) | pr(0, PX.SACT)) & 1 << slot; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal((pr(0, PX.CI) | pr(0, PX.SACT)) & 1 << slot, 0, "the command completed");
    assert.equal(pr(0, PX.TFD) & 1, 0, "no error");
    return { data: mem.slice(BUFFER, BUFFER + length), prdbc: u32(header + 4) };
}

const disk = cpu.devices.ahci.ports[0].device;
assert.equal(disk.sector_size, 4096, "the VHDX disk's sectors");
assert.equal((await emulator.disk_image_info("hda")).logical_sector_size, 4096, "disk_image_info");
{
    const words = Array.from({ length: 256 }, (_, i) => 0);
    const { data } = await ahci({ command: 0xEC, length: 512 });
    for(let i = 0; i < 256; i++) words[i] = data[2 * i] | data[2 * i + 1] << 8;
    assert.equal(words[106], 0x5000);
    assert.deepEqual(words.slice(117, 119), [2048, 0]);
    assert.equal(words[100] | words[101] << 16, (16 << 20) / S);
    console.log("ok - AHCI: IDENTIFY of the VHDX disk with 4096-byte sectors");
}
{
    let r = await ahci({ command: 0x25, lba: 2, count: 3, length: 3 * S });
    assert.equal(r.prdbc, 3 * S);
    assert.deepEqual(r.data, pattern.subarray(2 * S, 5 * S), "READ DMA EXT");
    r = await ahci({ command: 0x20, lba: 1, count: 2, length: 2 * S });
    assert.equal(r.prdbc, 2 * S);
    assert.deepEqual(r.data, pattern.subarray(S, 3 * S), "READ SECTORS (PIO)");
    const pio_setup = mem.subarray(fb + 0x20, fb + 0x34);
    assert.equal(pio_setup[16] | pio_setup[17] << 8, S, "the PIO setup FIS: a block of one sector");
    const data = new Uint8Array(2 * S).map((_, i) => i * 5 + 1 & 0xFF);
    await ahci({ command: 0x35, lba: 300, count: 2, length: 2 * S, write: true, data });
    r = await ahci({ command: 0x25, lba: 300, count: 2, length: 2 * S });
    assert.deepEqual(r.data, data, "WRITE DMA EXT, read back (past the VHDX's data: a block not present)");
    // native command queuing: the count in the features
    const queued = new Uint8Array(S).map((_, i) => i * 11 & 0xFF);
    await ahci({ command: 0x61, features: 1, lba: 7, count: 3 << 3, slot: 3, length: S, write: true, data: queued, queued: true });
    r = await ahci({ command: 0x60, features: 3, lba: 6, count: 4 << 3, slot: 4, length: 3 * S, queued: true });
    assert.deepEqual(r.data, Uint8Array.from([...pattern.subarray(6 * S, 7 * S), ...queued, ...pattern.subarray(8 * S, 9 * S)]),
        "WRITE FPDMA QUEUED, READ FPDMA QUEUED");
    console.log("ok - AHCI: DMA, PIO (a block per sector) and NCQ reads and writes of 4096-byte sectors");
}
await emulator.destroy();

// ---- options ----------------------------------------------------------------

for(const [hda, pattern_message] of [
    [{ buffer: new ArrayBuffer(SIZE + 512), logical_sector_size: 4096 }, /not a multiple/],
    [{ buffer: new ArrayBuffer(SIZE), logical_sector_size: 2048 }, /logical_sector_size/],
])
{
    await assert.rejects(start({ hda }), error => pattern_message.test(String(error && error.message || error)));
}
console.log("ok - a size that is not a multiple of 4096, a sector size other than 512 or 4096: emulator-error");

// SeaBIOS reads disks in 512-byte sectors: it does not boot MS-DOS's disk
// as one of 4096-byte sectors, says so and goes on with the next device
{
    const image = fs.readFileSync(__dirname + "/../../images/msdos622.img");
    const machine = new V86({ ...config({ hda: { buffer: new Uint8Array(image).buffer, logical_sector_size: 4096 } }), autostart: true });
    const text = () => machine.screen_adapter ? machine.screen_adapter.get_text_screen().join("\n") : "";
    const start = Date.now();
    while(!/No bootable device/.test(text()))
    {
        assert.ok(Date.now() - start < 60000, "SeaBIOS goes on: " + text());
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.match(text(), /Booting from Hard Disk\.\.\.\s+Boot failed: could not read the boot disk/);
    await machine.destroy();
    console.log("ok - SeaBIOS does not boot a disk of 4096-byte sectors: it says so and tries the next device");
}
console.log("disk sector size tests passed");
