#!/usr/bin/env node

// The AHCI controller of the Q35 machine, driven through its registers and
// command structures in guest memory; no guest code runs. Covers the
// behaviour SeaBIOS and Linux depend on (docs/ahci.md):
// presence and signatures, the initial D2H FIS, PIO, DMA and ATAPI commands,
// PRDTs, error completion and recovery, native command queuing and its error
// log, link power management, interrupts, resets, hot plug and snapshots.

import assert from "node:assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

// hda: 8 MiB with a pattern; hdb: 3 TiB, never allocated (reads return
// their byte offset); the CD: 2 MiB, each sector filled with its number
const HDA_SIZE = 8 << 20;
const hda = new Uint8Array(HDA_SIZE);
for(let i = 0; i < HDA_SIZE; i++) hda[i] = i * 7 + (i >> 9) & 0xFF;
const hda_original = hda.slice();

const HDB_SECTORS = 6 * 2 ** 30;
const hdb_reads = [];
// (a class: state images take no plain objects)
class SparseDisk
{
    constructor(byte_length) { this.byteLength = byte_length; }
    load() { this.onload?.({}); }
    get(start, length, done)
    {
        hdb_reads.push(start);
        const data = new Uint8Array(length);
        for(let s = 0; s < length; s += 512) new DataView(data.buffer).setFloat64(s, start + s, true);
        done(data);
    }
    get_and_cache(start, length, done) { this.get(start, length, done); }
    get_from_cache() { return undefined; }
    set(start, data, done) { done(); }
    get_buffer(done) { done(undefined); }
    get_state() { return []; }
    set_state() {}
}
const hdb = new SparseDisk(HDB_SECTORS * 512);

const CD_SIZE = 2 << 20;
const cd = new Uint8Array(CD_SIZE);
for(let s = 0; s < CD_SIZE / 2048; s++) cd.fill(s & 0xFF, s * 2048, s * 2048 + 2048);

class CDImage
{
    constructor() { this.byteLength = CD_SIZE; }
    get(start, length, done) { done(cd.slice(start, start + length)); }
    set(start, data, done) { done(); }
    get_buffer(done) { done(undefined); }
    get_state() { return []; }
    set_state() {}
}

const emulator = new V86({
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    machine_type: "q35",
    memory_size: 64 * 1024 * 1024,
    // the top 16 MiB of RAM at 4 GiB: DMA above 4 GiB
    high_memory_size: 16 * 1024 * 1024,
    hda: { buffer: hda.buffer },
    hdb,
    cdrom: { buffer: cd.buffer },
    autostart: false,
    log_level: 0,
});
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));

const cpu = emulator.v86.cpu;
const pci = cpu.devices.pci;
const mem = cpu.mem8;
const AHCI = 0x1F << 3 | 2;
const ABAR = 0xC0000000;

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

// --- helpers ---------------------------------------------------------------

const r32 = offset => cpu.mmap_read32(ABAR + offset) >>> 0;
const w32 = (offset, value) => cpu.mmap_write32(ABAR + offset, value | 0);
const pr = (port, reg) => r32(0x100 + port * 0x80 + reg);
const pw = (port, reg, value) => w32(0x100 + port * 0x80 + reg, value);
const u32 = a => (mem[a] | mem[a + 1] << 8 | mem[a + 2] << 16 | mem[a + 3] << 24) >>> 0;
const put32 = (a, v) => { mem[a] = v; mem[a + 1] = v >> 8; mem[a + 2] = v >> 16; mem[a + 3] = v >>> 24; };

const PX = { CLB: 0x00, FB: 0x08, IS: 0x10, IE: 0x14, CMD: 0x18, TFD: 0x20, SIG: 0x24, SSTS: 0x28, SCTL: 0x2C, SERR: 0x30, SACT: 0x34, CI: 0x38 };
const ST = 1, FRE = 1 << 4, CR = 1 << 15, FR = 1 << 14;
const DHRS = 1, PSS = 2, OFS = 1 << 24, TFES = 1 << 30;
const PCS = 1 << 6, PRCS = 1 << 22, DIAG_N = 1 << 16, DIAG_X = 1 << 26, HPCP = 1 << 18;

/** Per port: command list, received FISes, command tables, data */
const clb = port => 0x200000 + port * 0x10000;
const fb = port => clb(port) + 0x400;
const ctba = (port, slot) => clb(port) + 0x1000 + slot * 0x100;
const DATA = 0x400000;

function program_pci(command = 0x0006)
{
    pci.config_write(AHCI, 0x24, 4, ABAR);
    pci.config_write(AHCI, 0x04, 2, command);
}

function start_port(port)
{
    pw(port, PX.CMD, 0);
    pw(port, PX.CLB, clb(port));
    pw(port, PX.FB, fb(port));
    mem.fill(0, clb(port), clb(port) + 0x10000);
    pw(port, PX.CMD, FRE);
    pw(port, PX.IS, -1);
    pw(port, PX.SERR, -1);
    pw(port, PX.CMD, FRE | ST);
}

/**
 * Build a command in a slot and issue it
 * @param {number} port
 * @param {number} slot
 * @param {{command: number, features?: number, lba?: number, count?: number, device?: number,
 *          prdt?: Array<[number, number]>, write?: boolean, atapi?: Array<number>, control?: number,
 *          queued?: boolean}} c
 */
function issue(port, slot, c)
{
    const table = ctba(port, slot);
    mem.fill(0, table, table + 0x100);
    const lba = c.lba || 0, count = c.count || 0, features = c.features || 0;
    const fis = c.control !== undefined ?
        [0x27, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, c.control] :
        [0x27, 0x80, c.command, features & 0xFF,
            lba & 0xFF, lba >> 8 & 0xFF, lba >> 16 & 0xFF, c.device === undefined ? 0x40 : c.device,
            Math.floor(lba / 2 ** 24) & 0xFF, Math.floor(lba / 2 ** 32) & 0xFF, Math.floor(lba / 2 ** 40) & 0xFF, features >> 8,
            count & 0xFF, count >> 8, 0, 0];
    mem.set(fis, table);
    if(c.atapi) mem.set(c.atapi, table + 0x40);
    const prdt = c.prdt || [];
    prdt.forEach(([address, length], i) => {
        put32(table + 0x80 + i * 16, address);
        put32(table + 0x80 + i * 16 + 12, length - 1 | (c.prd_interrupt ? 1 << 31 : 0));
    });
    const header = clb(port) + slot * 32;
    put32(header, 5 | (c.atapi ? 1 << 5 : 0) | (c.write ? 1 << 6 : 0) | prdt.length << 16);
    put32(header + 4, 0xDEADBEEF); // PRDBC: must be rewritten
    put32(header + 8, table);
    pw(port, PX.IS, -1);
    if(c.queued) pw(port, PX.SACT, 1 << slot);
    pw(port, PX.CI, 1 << slot);
}

/**
 * READ/WRITE FPDMA QUEUED: the sector count in the features fields, the tag
 * (the slot, as AHCI wants it) in bits 7:3 of the sector count
 */
const ncq = (port, slot, write, lba, count, prdt) =>
    issue(port, slot, { command: write ? 0x61 : 0x60, features: count, lba, count: slot << 3, prdt, write, queued: true });

const prdbc = (port, slot) => u32(clb(port) + slot * 32 + 4);
const sdb = port => mem.subarray(fb(port) + 0x58, fb(port) + 0x60);
const SDBS = 1 << 3;
const d2h = port => mem.subarray(fb(port) + 0x40, fb(port) + 0x54);
const pio_setup = port => mem.subarray(fb(port) + 0x20, fb(port) + 0x34);
const words = (address, n) => Array.from({ length: n }, (_, i) => mem[address + 2 * i] | mem[address + 2 * i + 1] << 8);

// --- tests -----------------------------------------------------------------

program_pci();

test("generic host control: CAP, PI, VS, GHC", () => {
    const cap = r32(0x00);
    assert.equal(cap & 0x1F, 5, "six ports");
    assert.equal(cap >> 8 & 0x1F, 31, "32 command slots");
    assert.ok(cap & 1 << 18, "AHCI only (SAM)");
    assert.equal(cap >> 20 & 0xF, 1, "Gen 1");
    assert.ok(cap & 1 << 31, "64-bit addressing");
    assert.equal(r32(0x0C), 0x3F, "ports implemented");
    assert.equal(r32(0x10), 0x00010000, "AHCI 1.0");
    assert.equal(r32(0x04) >>> 31, 1, "AE reads as one");
    w32(0x04, 0);
    assert.equal(r32(0x04) >>> 31, 1, "AE stays set");
});

test("ports: link up with a device, nothing without; signature after FIS reception starts", () => {
    assert.equal(pr(0, PX.SSTS), 0x113, "hda: present, Gen 1, active");
    assert.equal(pr(1, PX.SSTS), 0x113, "hdb");
    assert.equal(pr(2, PX.SSTS), 0x113, "the CD drive");
    for(const port of [3, 4, 5]) assert.equal(pr(port, PX.SSTS), 0, "port " + port + " empty");
    assert.equal(pr(0, PX.TFD), 0x7F, "no D2H FIS before FRE");
    assert.equal(pr(0, PX.SIG), 0xFFFFFFFF);
    assert.equal(pr(0, PX.CMD) & 6, 6, "SUD and POD read as one");

    pw(0, PX.CLB, clb(0));
    pw(0, PX.FB, fb(0));
    pw(0, PX.CMD, FRE);
    assert.equal(pr(0, PX.CMD) & FR, FR, "FR follows FRE");
    assert.equal(pr(0, PX.SIG), 0x00000101, "ATA signature");
    assert.equal(pr(0, PX.TFD) & 0xFF, 0x50, "ready, no BSY/DRQ (SeaBIOS waits for this)");
    assert.equal(d2h(0)[0], 0x34, "the D2H FIS was posted");
    assert.ok(pr(0, PX.IS) & DHRS);

    pw(2, PX.CLB, clb(2));
    pw(2, PX.FB, fb(2));
    pw(2, PX.CMD, FRE);
    assert.equal(pr(2, PX.SIG), 0xEB140101, "ATAPI signature");
    assert.equal(pr(2, PX.TFD) & 0x88, 0);
});

test("IDENTIFY DEVICE: PIO data in, PIO setup FIS with E_Status, SATA words, PRDBC", () => {
    start_port(0);
    mem.fill(0xEE, DATA, DATA + 1024);
    issue(0, 3, { command: 0xEC, prdt: [[DATA, 512]] });
    assert.equal(pr(0, PX.CI), 0, "completed");
    const is = pr(0, PX.IS);
    assert.ok(is & PSS, "PSS (the PIO setup FIS has the interrupt bit)");
    assert.ok(is & DHRS);
    assert.equal(is & TFES, 0);
    const ps = pio_setup(0);
    assert.equal(ps[0], 0x5F);
    assert.equal(ps[1] & 0x60, 0x60, "interrupt bit, device to host");
    assert.equal(ps[2] & 0xC9, 0x48, "status during the block: DRDY|DRQ, no BSY/ERR (SeaBIOS reads it)");
    assert.equal(ps[15] & 0xC9, 0x40, "E_Status: DRDY, no DRQ (Linux reads it)");
    assert.equal(ps[16] | ps[17] << 8, 512, "transfer count");
    assert.equal(prdbc(0, 3), 512);
    const id = words(DATA, 256);
    assert.equal(id[76] & 2, 2, "word 76: Gen 1");
    assert.equal(id[80], 0x0070, "word 80: ATA-4 to -6 (Linux: SATA)");
    assert.equal(id[93], 0, "word 93: no PATA cable detection");
    assert.equal(id[60] | id[61] << 16, HDA_SIZE / 512);
    assert.equal(mem[DATA + 512], 0xEE, "nothing beyond the PRDT");
    assert.equal(pr(0, PX.TFD) & 0xFF, 0x50);
});

test("IDENTIFY PACKET DEVICE on a disk: error with DHRS and TFES, slot kept, list halted until ST is cleared", () => {
    start_port(0);
    issue(0, 0, { command: 0xA1, prdt: [[DATA, 512]] });
    const is = pr(0, PX.IS);
    assert.ok(is & DHRS, "DHRS: SeaBIOS 1.16.2 only sees DHRS and PSS");
    assert.ok(is & TFES);
    assert.equal(d2h(0)[2] & 0x01, 1, "ERR in the D2H FIS");
    assert.equal(d2h(0)[3], 0x04, "ABRT");
    assert.equal(pr(0, PX.TFD), 0x0441, "PxTFD: error 04, status 41");
    assert.equal(pr(0, PX.CI), 1, "the failed slot stays issued");

    // further commands wait
    issue(0, 1, { command: 0xEC, prdt: [[DATA, 512]] });
    assert.equal(pr(0, PX.CI), 3);

    // SeaBIOS's recovery: clear ST, wait for CR, clear SERR and IS, set ST
    pw(0, PX.CMD, FRE);
    assert.equal(pr(0, PX.CMD) & CR, 0, "CR clears");
    assert.equal(pr(0, PX.CI), 0, "clearing ST clears PxCI");
    pw(0, PX.SERR, pr(0, PX.SERR));
    pw(0, PX.IS, pr(0, PX.IS));
    assert.equal(pr(0, PX.TFD) & 0x88, 0, "no BSY/DRQ: no COMRESET needed");
    pw(0, PX.CMD, FRE | ST);
    issue(0, 1, { command: 0xEC, prdt: [[DATA, 512]] });
    assert.equal(pr(0, PX.CI), 0, "works again");
    assert.equal(pr(0, PX.IS) & TFES, 0);
});

test("SET FEATURES with W=1 and a bogus PRDT (bsize 0) moves no data", () => {
    start_port(0);
    const ivt = mem.slice(0, 0x400);
    mem.fill(0x5A, 0, 0x400);
    issue(0, 0, { command: 0xEF, features: 0x03, count: 0x46, write: true, prdt: [[0, 0x400000]], prd_interrupt: true });
    assert.equal(pr(0, PX.CI), 0);
    assert.ok(mem.subarray(0, 0x400).every(b => b === 0x5A), "the memory at the PRDT's address 0 is untouched");
    assert.equal(prdbc(0, 0), 0);
    mem.set(ivt, 0);
});

test("READ DMA EXT over several PRDT entries, LBA48 beyond 2^32 sectors (hdb)", () => {
    start_port(0);
    issue(0, 5, { command: 0x25, lba: 100, count: 3, prdt: [[DATA, 1000], [DATA + 0x2000, 24], [DATA + 0x3000, 512]] });
    assert.equal(pr(0, PX.CI), 0);
    assert.equal(pr(0, PX.IS) & (TFES | DHRS), DHRS);
    const expect = hda.subarray(100 * 512, 103 * 512);
    assert.deepEqual(mem.subarray(DATA, DATA + 1000), expect.subarray(0, 1000));
    assert.deepEqual(mem.subarray(DATA + 0x2000, DATA + 0x2000 + 24), expect.subarray(1000, 1024));
    assert.deepEqual(mem.subarray(DATA + 0x3000, DATA + 0x3200), expect.subarray(1024, 1536));
    assert.equal(prdbc(0, 5), 1536);

    start_port(1);
    for(const lba of [0x1_2345_6789, HDB_SECTORS - 1])
    {
        hdb_reads.length = 0;
        issue(1, 0, { command: 0x25, lba, count: 1, prdt: [[DATA, 512]] });
        assert.equal(pr(1, PX.CI), 0);
        assert.equal(new DataView(mem.buffer, mem.byteOffset + DATA, 8).getFloat64(0, true), lba * 512);
        assert.deepEqual(hdb_reads, [lba * 512]);
    }
});

test("WRITE DMA, read back; FLUSH CACHE EXT; PIO WRITE SECTORS", () => {
    start_port(0);
    for(let i = 0; i < 1024; i++) mem[DATA + i] = 255 - (i & 0xFF);
    issue(0, 0, { command: 0x35, lba: 2000, count: 2, write: true, prdt: [[DATA, 1024]] });
    assert.equal(pr(0, PX.CI), 0);
    assert.equal(prdbc(0, 0), 1024);
    assert.ok(hda.subarray(2000 * 512, 2002 * 512).every((b, i) => b === 255 - (i & 0xFF)), "on the disk");

    issue(0, 1, { command: 0xEA });
    assert.equal(pr(0, PX.CI), 0, "flush completes");

    mem.fill(0x77, DATA + 0x8000, DATA + 0x8200);
    issue(0, 2, { command: 0x30, lba: 10, count: 1, write: true, prdt: [[DATA + 0x8000, 512]] });
    assert.equal(pr(0, PX.CI), 0);
    assert.equal(pr(0, PX.IS) & PSS, 0, "the first PIO-out block has no interrupt bit");
    assert.ok(hda.subarray(5120, 5632).every(b => b === 0x77));

    hda.set(hda_original);
});

test("reads beyond the end: IDNF error", () => {
    start_port(0);
    issue(0, 0, { command: 0x25, lba: HDA_SIZE / 512 - 1, count: 2, prdt: [[DATA, 1024]] });
    assert.equal(pr(0, PX.TFD), 0x1041, "IDNF, DRDY|ERR (not 0xFF, which reads as BSY)");
    assert.ok(pr(0, PX.IS) & TFES);
});

test("a PRDT shorter than the transfer: error and overflow, no memory beyond it", () => {
    start_port(0);
    mem.fill(0x33, DATA, DATA + 1024);
    issue(0, 0, { command: 0xEC, prdt: [[DATA, 256]] });
    assert.ok(pr(0, PX.IS) & TFES);
    assert.ok(pr(0, PX.IS) & OFS);
    assert.equal(mem[DATA + 300], 0x33);
    issue(0, 0, { command: 0x25, lba: 0, count: 2, prdt: [[DATA, 512]] });
});

test("64-bit addressing: command list, received FISes, command table and data above 4 GiB", () => {
    const HIGH = 0x1_0000_0000;
    pw(0, PX.CMD, 0);
    pw(0, PX.CLB, 0x10000);
    pw(0, 0x04, 1);              // CLBU: 4 GiB + 64 KiB
    pw(0, PX.FB, 0x11000);
    pw(0, 0x0C, 1);              // FBU
    pw(0, PX.CMD, FRE);
    pw(0, PX.IS, -1);
    pw(0, PX.CMD, FRE | ST);
    const list = HIGH + 0x10000, received = HIGH + 0x11000, table = HIGH + 0x12000, data = HIGH + 0x20000;
    const put = (address, bytes) => cpu.write_blob_physical(Uint8Array.from(bytes), address);
    const dword = v => [v & 0xFF, v >> 8 & 0xFF, v >> 16 & 0xFF, v >>> 24];
    put(table, [0x27, 0x80, 0x25, 0, 33, 0, 0, 0x40, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]);
    // PRD: DBA/DBAU above 4 GiB, 1024 bytes
    put(table + 0x80, [...dword(data & 0xFFFFFFFF), ...dword(1), 0, 0, 0, 0, ...dword(1023)]);
    // header: CFL 5, PRDTL 1, CTBA/CTBAU
    put(list, [...dword(5 | 1 << 16), 0, 0, 0, 0, ...dword(table & 0xFFFFFFFF), ...dword(1)]);
    pw(0, PX.CI, 1);
    assert.equal(pr(0, PX.CI), 0);
    assert.equal(pr(0, PX.IS) & TFES, 0);
    assert.deepEqual(cpu.read_blob_physical(data, 1024), hda.subarray(33 * 512, 35 * 512), "data above 4 GiB");
    assert.equal(cpu.read_blob_physical(received + 0x40, 1)[0], 0x34, "D2H FIS above 4 GiB");
    assert.deepEqual(Array.from(cpu.read_blob_physical(list + 4, 4)), dword(1024), "PRDBC");

    // beyond the 36-bit bus: the transfer fails, nothing is written
    put(table + 0x80, [...dword(0), ...dword(0x10), 0, 0, 0, 0, ...dword(1023)]);
    pw(0, PX.IS, -1);
    pw(0, PX.CI, 1);
    assert.ok(pr(0, PX.IS) & TFES, "error");
    pw(0, PX.CMD, FRE);
    pw(0, 0x04, 0);
    pw(0, 0x0C, 0);
});

test("ATAPI: IDENTIFY PACKET, TEST UNIT READY with a bogus PRDT, INQUIRY and READ(10) by DMA", () => {
    start_port(2);
    issue(2, 0, { command: 0xA1, prdt: [[DATA, 512]] });
    assert.equal(pr(2, PX.CI), 0);
    assert.ok(pr(2, PX.IS) & PSS);
    const ps = pio_setup(2);
    assert.equal(ps[2] & 0x41, 0x40, "DRDY (SeaBIOS's success condition holds for ATAPI too)");
    assert.equal(words(DATA, 1)[0] >> 8 & 0x1F, 5, "CD-ROM");

    // SeaBIOS: features = DMA for every packet, buffer NULL and bsize 0 for TUR
    issue(2, 0, { command: 0xA0, features: 1, lba: 0, prdt: [[0, 0x400000]], atapi: [0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    assert.equal(pr(2, PX.CI), 0, "TEST UNIT READY succeeds");
    assert.equal(pr(2, PX.IS) & (TFES | PSS), 0, "no PIO setup interrupt for the command packet");

    issue(2, 1, { command: 0xA0, features: 1, prdt: [[DATA, 36]], atapi: [0x12, 0, 0, 0, 36, 0, 0, 0, 0, 0, 0, 0] });
    assert.equal(pr(2, PX.CI), 0);
    assert.equal(mem[DATA], 0x05, "INQUIRY: CD-ROM");
    assert.equal(prdbc(2, 1), 36);

    issue(2, 2, { command: 0xA0, features: 1, prdt: [[DATA, 4096]], atapi: [0x28, 0, 0, 0, 0, 7, 0, 0, 2, 0, 0, 0] });
    assert.equal(pr(2, PX.CI), 0);
    assert.ok(mem.subarray(DATA, DATA + 2048).every(b => b === 7) && mem.subarray(DATA + 2048, DATA + 4096).every(b => b === 8), "sectors 7 and 8");
    assert.equal(prdbc(2, 2), 4096);
});

test("ATAPI PIO READ(10) in byte-count-limited blocks", () => {
    start_port(2);
    // byte count limit 2048 in LBA mid/high: two DRQ blocks of one sector
    issue(2, 0, { command: 0xA0, features: 0, lba: 2048 << 8, prdt: [[DATA, 4096]], atapi: [0x28, 0, 0, 0, 0, 3, 0, 0, 2, 0, 0, 0] });
    assert.equal(pr(2, PX.CI), 0);
    assert.ok(mem.subarray(DATA, DATA + 2048).every(b => b === 3) && mem.subarray(DATA + 2048, DATA + 4096).every(b => b === 4));
    assert.equal(prdbc(2, 0), 4096);
    assert.ok(pr(2, PX.IS) & PSS);
});

test("ATAPI media change: eject -> NOT READY; insert -> NOT READY, UNIT ATTENTION, ready", () => {
    start_port(2);
    const tur = () => {
        pw(2, PX.CMD, FRE);
        pw(2, PX.CMD, FRE | ST);
        issue(2, 0, { command: 0xA0, features: 1, prdt: [[0, 0x400000]], atapi: [0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
        return pr(2, PX.IS) & TFES ? pr(2, PX.TFD) >> 12 & 0xF : 0; // sense key
    };
    const drive = cpu.devices.cdrom;
    drive.eject();
    assert.equal(tur(), 2, "NOT READY");
    drive.set_cdrom(new CDImage());
    assert.equal(tur(), 2, "NOT READY (medium changed)");
    assert.equal(tur(), 6, "UNIT ATTENTION");
    assert.equal(tur(), 0, "ready");
});

test("NCQ: CAP.SNCQ, IDENTIFY queue depth 32, general purpose logging", () => {
    assert.ok(r32(0x00) & 1 << 30, "SNCQ");
    start_port(0);
    issue(0, 0, { command: 0xEC, prdt: [[DATA, 512]] });
    const id = words(DATA, 256);
    assert.equal(id[75], 31, "word 75: queue depth - 1");
    assert.ok(id[76] & 1 << 8, "word 76: NCQ");
    assert.ok(id[84] & 1 << 5 && id[87] & 1 << 5, "words 84/87: GPL (READ LOG EXT)");
    start_port(2);
    issue(2, 0, { command: 0xA1, prdt: [[DATA, 512]] });
    assert.equal(words(DATA, 256)[76] & 1 << 8, 0, "not on the CD drive");
});

test("NCQ: queued reads and writes complete with set device bits FISes", () => {
    start_port(0);
    ncq(0, 3, false, 40, 2, [[DATA, 1024]]);
    assert.equal(pr(0, PX.CI), 0);
    assert.equal(pr(0, PX.SACT), 0, "the tag completed");
    const is = pr(0, PX.IS);
    assert.ok(is & SDBS, "SDBS");
    assert.equal(is & (DHRS | TFES), 0, "the register FIS accepting the command has no interrupt bit");
    assert.deepEqual(Array.from(sdb(0)), [0xA1, 0x40, 0x50, 0, 1 << 3, 0, 0, 0], "SDB FIS: I, status, SActive = tag 3");
    assert.deepEqual(mem.subarray(DATA, DATA + 1024), hda.subarray(40 * 512, 42 * 512));
    assert.equal(pr(0, PX.TFD) & 0xFF, 0x50);

    // a write over two PRDT entries, tag 31, and read back with tag 0
    for(let i = 0; i < 1536; i++) mem[DATA + 0x10000 + i] = i * 13 & 0xFF;
    ncq(0, 31, true, 3000, 3, [[DATA + 0x10000, 1000], [DATA + 0x10000 + 1000, 536]]);
    assert.equal(pr(0, PX.SACT), 0);
    assert.deepEqual(Array.from(sdb(0).subarray(4, 8)), [0, 0, 0, 0x80], "SActive = tag 31");
    assert.deepEqual(hda.subarray(3000 * 512, 3003 * 512), mem.subarray(DATA + 0x10000, DATA + 0x10000 + 1536));
    mem.fill(0, DATA, DATA + 1536);
    ncq(0, 0, false, 3000, 3, [[DATA, 1536]]);
    assert.deepEqual(mem.subarray(DATA, DATA + 1536), mem.subarray(DATA + 0x10000, DATA + 0x10000 + 1536));
    hda.set(hda_original);
});

test("NCQ errors: SDB FIS with ERR, TFES, the tag stays active; READ LOG EXT 10h; recovery", () => {
    start_port(0);
    const read_log = (slot, log) => issue(0, slot, { command: 0x2F, lba: log, count: 1, prdt: [[DATA + 0x8000, 512]] });

    ncq(0, 6, false, HDA_SIZE / 512 - 1, 2, [[DATA, 1024]]);
    assert.equal(pr(0, PX.CI), 0, "accepted");
    assert.equal(pr(0, PX.SACT), 1 << 6, "never completed");
    assert.ok(pr(0, PX.IS) & TFES, "TFES");
    assert.equal(pr(0, PX.TFD), 0x1041, "IDNF, DRDY|ERR");
    assert.deepEqual(Array.from(sdb(0)), [0xA1, 0x40, 0x41, 0x10, 0, 0, 0, 0]);
    ncq(0, 7, false, 0, 1, [[DATA, 512]]);
    assert.equal(pr(0, PX.CI), 1 << 7, "the list is halted");

    // Linux: stop and restart the engine, then read the NCQ error log
    pw(0, PX.CMD, FRE);
    assert.equal(pr(0, PX.SACT) | pr(0, PX.CI), 0, "clearing ST clears PxSACT and PxCI");
    pw(0, PX.CMD, FRE | ST);
    ncq(0, 1, false, 0, 1, [[DATA, 512]]);
    assert.ok(pr(0, PX.IS) & TFES, "queued commands are aborted until the log was read");
    assert.equal(pr(0, PX.TFD) >> 8, 0x04);
    pw(0, PX.CMD, FRE);
    pw(0, PX.CMD, FRE | ST);

    read_log(0, 0x00);
    assert.equal(pr(0, PX.CI), 0);
    assert.equal(pr(0, PX.IS) & TFES, 0);
    assert.deepEqual(words(DATA + 0x8000, 0x11).filter((w, i) => w), [1, 1], "the log directory: version 1, log 10h");
    assert.equal(words(DATA + 0x8000, 0x11)[0x10], 1);
    read_log(0, 0x10);
    assert.ok(pr(0, PX.IS) & PSS, "PIO data in");
    const log = mem.subarray(DATA + 0x8000, DATA + 0x8200);
    const lba = HDA_SIZE / 512 - 1;
    assert.deepEqual(Array.from(log.subarray(0, 14)),
        [6, 0, 0x41, 0x10, lba & 0xFF, lba >> 8 & 0xFF, lba >> 16 & 0xFF, 0x40, lba >>> 24, 0, 0, 0, 2, 0],
        "tag 6, status, error, LBA, count");
    assert.equal(log.reduce((a, b) => a + b, 0) & 0xFF, 0, "checksum");
    read_log(0, 0x10);
    assert.equal(log[0], 0x80, "read again: no queued command failed (NQ)");
    assert.equal(log.reduce((a, b) => a + b, 0) & 0xFF, 0);
    read_log(0, 0x30);
    assert.equal(pr(0, PX.TFD), 0x0441, "other logs: aborted");
    pw(0, PX.CMD, FRE);
    pw(0, PX.CMD, FRE | ST);

    ncq(0, 2, false, 9, 1, [[DATA, 512]]);
    assert.equal(pr(0, PX.SACT) | pr(0, PX.IS) & TFES, 0, "queued commands work again");
    assert.deepEqual(mem.subarray(DATA, DATA + 512), hda.subarray(9 * 512, 10 * 512));

    // a PRDT shorter than the transfer: overflow
    ncq(0, 3, false, 0, 2, [[DATA, 512]]);
    assert.ok(pr(0, PX.IS) & OFS);
    assert.ok(pr(0, PX.IS) & TFES);
    pw(0, PX.CMD, FRE);
    pw(0, PX.CMD, FRE | ST);
    read_log(0, 0x10);
    assert.equal(mem[DATA + 0x8000], 3, "tag 3 in the log");

    // a COMRESET also clears the error
    ncq(0, 4, false, HDA_SIZE / 512, 1, [[DATA, 512]]);
    pw(0, PX.SCTL, 1);
    pw(0, PX.SCTL, 0);
    start_port(0);
    ncq(0, 5, false, 0, 1, [[DATA, 512]]);
    assert.equal(pr(0, PX.SACT) | pr(0, PX.IS) & TFES, 0);

    // ATAPI devices have no queued commands
    start_port(2);
    issue(2, 0, { command: 0x60, features: 1, count: 0, prdt: [[DATA, 2048]], queued: true });
    assert.ok(pr(2, PX.IS) & TFES);
    assert.equal(pr(2, PX.TFD) >> 8, 0x04);
});

// a disk to hot plug: 1 MiB, each sector filled with its number + 0x40
const extra = new Uint8Array(1 << 20);
for(let s = 0; s < extra.length / 512; s++) extra.fill(s + 0x40 & 0xFF, s * 512, s * 512 + 512);

test("hot plug: HPCP on the ports without a drive at power-on", () => {
    for(const port of [0, 1, 2]) assert.equal(pr(port, PX.CMD) & HPCP, 0, "port " + port);
    for(const port of [3, 4, 5]) assert.equal(pr(port, PX.CMD) & HPCP, HPCP, "port " + port);
});

await emulator.attach_sata_drive(3, { buffer: extra.buffer });
test("hot plug: attaching a disk: DIAG.X and DIAG.N (PCS, PRCS), the link comes up, the signature; INTA", () => {
    // (attached above, before FIS reception was on: no D2H FIS yet)
    assert.equal(pr(3, PX.SERR), DIAG_X | DIAG_N);
    assert.equal(pr(3, PX.IS) & (PCS | PRCS), PCS | PRCS);
    assert.equal(pr(3, PX.SSTS), 0x113);
    assert.equal(pr(3, PX.TFD), 0x7F);

    pw(3, PX.CLB, clb(3));
    pw(3, PX.FB, fb(3));
    pw(3, PX.IE, PCS | PRCS);
    w32(0x04, 2);
    assert.ok(cpu.shared_irq_sources[16].has(AHCI), "PCS/PRCS interrupt");
    pw(3, PX.IS, -1);
    assert.equal(pr(3, PX.IS) & (PCS | PRCS), PCS | PRCS, "writing PxIS does not clear PCS and PRCS");
    pw(3, PX.SERR, DIAG_X | DIAG_N);
    assert.equal(pr(3, PX.IS), 0, "clearing PxSERR does");
    assert.ok(!cpu.shared_irq_sources[16].has(AHCI));
    w32(0x04, 0);

    start_port(3);
    assert.equal(pr(3, PX.SIG), 0x101, "the signature once FIS reception is on");
    issue(3, 0, { command: 0xEC, prdt: [[DATA, 512]] });
    const id = words(DATA, 256);
    assert.equal(id[60] | id[61] << 16, 2048, "IDENTIFY: 1 MiB");
    issue(3, 1, { command: 0x25, lba: 5, count: 2, prdt: [[DATA, 1024]] });
    assert.deepEqual(mem.subarray(DATA, DATA + 1024), extra.subarray(5 * 512, 7 * 512));
    ncq(3, 2, false, 9, 1, [[DATA, 512]]);
    assert.ok(mem.subarray(DATA, DATA + 512).every(b => b === 0x49), "NCQ too");
    assert.deepEqual(cpu.disk_devices().map(([name]) => name), ["hda", "hdb", "cdrom", "sata3"]);
});

test("hot plug: detaching: DIAG.N (PRCS), no link, PxTFD 7Fh; commands stay issued until ST is cleared", () => {
    start_port(3);
    pw(3, PX.IE, PRCS);
    w32(0x04, 2);
    emulator.detach_sata_drive(3);
    assert.equal(pr(3, PX.SERR), DIAG_N);
    assert.equal(pr(3, PX.IS), PRCS);
    assert.ok(cpu.shared_irq_sources[16].has(AHCI));
    assert.equal(pr(3, PX.SSTS), 0);
    assert.equal(pr(3, PX.TFD), 0x7F);
    assert.equal(pr(3, PX.SIG), 0xFFFFFFFF);
    issue(3, 0, { command: 0xEC, prdt: [[DATA, 512]] });
    assert.equal(pr(3, PX.CI), 1, "nothing executes it");
    pw(3, PX.CMD, FRE);
    assert.equal(pr(3, PX.CI), 0);
    pw(3, PX.SERR, -1);
    pw(3, PX.IE, 0);
    w32(0x04, 0);
    assert.ok(!cpu.shared_irq_sources[16].has(AHCI));
    assert.throws(() => emulator.detach_sata_drive(3), /no drive/);
    assert.throws(() => cpu.devices.ahci.attach(0, { buffer: undefined, is_cdrom: true }), /already has a drive/);
});

test("hot plug: the CD drive on port 2 out and an empty one in: cdrom follows", () => {
    const drive = cpu.devices.cdrom;
    emulator.detach_sata_drive(2);
    assert.equal(cpu.devices.cdrom, undefined);
    assert.equal(pr(2, PX.SSTS), 0);
    cpu.devices.ahci.attach(2, { buffer: undefined, is_cdrom: true });
    assert.notEqual(cpu.devices.cdrom, drive);
    assert.ok(cpu.devices.cdrom.is_atapi && !cpu.devices.cdrom.has_disk());
    start_port(2);
    assert.equal(pr(2, PX.SIG), 0xEB140101);
    cpu.devices.cdrom.set_cdrom(new CDImage());
    assert.ok(cpu.devices.cdrom.has_disk());
});

await emulator.attach_sata_drive(4, { buffer: extra.buffer });
const hot_state = await emulator.save_state();
emulator.detach_sata_drive(4);
await emulator.attach_sata_drive(5, { buffer: extra.buffer });
pw(5, PX.SERR, -1);
await emulator.restore_state(hot_state);
test("hot plug and snapshots: a drive on one side only is a hot plug event for the restored guest", () => {
    assert.equal(pr(4, PX.SSTS), 0, "port 4: in the snapshot, not in the machine: removed");
    assert.equal(pr(4, PX.SERR) & DIAG_N, DIAG_N);
    assert.equal(pr(5, PX.SSTS), 0x113, "port 5: in the machine only: plugged in");
    assert.equal(pr(5, PX.SERR) & (DIAG_X | DIAG_N), DIAG_X | DIAG_N);
    start_port(5);
    issue(5, 0, { command: 0x25, lba: 1, count: 1, prdt: [[DATA, 512]] });
    assert.ok(mem.subarray(DATA, DATA + 512).every(b => b === 0x41));
    emulator.detach_sata_drive(5);
    for(const port of [3, 4, 5]) pw(port, PX.SERR, -1);
});

// a disk image (docs/disk-image-formats-plan.md P0): a QCOW2 disk of 1 MiB,
// its second cluster damaged
const { build_qcow2 } = await import("../image/tiny_qcow2.mjs");
await emulator.attach_sata_drive(3, { buffer: build_qcow2({ size: 1 << 20, data: [[0, extra.subarray(0, 65536)]], damaged: [65536] }).buffer, format: "qcow2", disk_error: "report" });
pw(3, PX.SERR, -1);
test("a QCOW2 disk: reads; a failed read or write ends a queued or DMA command with ABRT (TFES), the port goes on", () => {
    start_port(3);
    const read_log = slot => issue(3, slot, { command: 0x2F, lba: 0x10, count: 1, prdt: [[DATA + 0x8000, 512]] });
    const restart = () => { pw(3, PX.CMD, FRE); pw(3, PX.CMD, FRE | ST); };
    issue(3, 0, { command: 0x25, lba: 5, count: 2, prdt: [[DATA, 1024]] });
    assert.deepEqual(mem.subarray(DATA, DATA + 1024), extra.subarray(5 * 512, 7 * 512), "DMA read");
    ncq(3, 1, false, 128, 1, [[DATA, 512]]);
    assert.ok(pr(3, PX.IS) & TFES, "queued read of the damaged cluster: TFES");
    assert.equal(pr(3, PX.TFD), 0x0441, "ABRT, DRDY|ERR");
    restart();
    read_log(2);
    assert.equal(mem[DATA + 0x8000], 1, "tag 1 in the NCQ error log");
    issue(3, 3, { command: 0x25, lba: 129, count: 1, prdt: [[DATA, 512]] });
    assert.ok(pr(3, PX.IS) & TFES, "DMA read of the damaged cluster: TFES");
    assert.equal(pr(3, PX.TFD) >> 8, 0x04, "ABRT");
    restart();
    const disk = cpu.devices.ahci.ports[3].device.buffer;
    disk.overlay.limit = disk.overlay.size();
    ncq(3, 4, true, 7, 1, [[DATA, 512]]);
    assert.ok(pr(3, PX.IS) & TFES, "queued write past the memory budget: TFES");
    assert.equal(pr(3, PX.TFD), 0x0441);
    disk.overlay.limit = Infinity;
    restart();
    read_log(5);
    ncq(3, 6, false, 1, 1, [[DATA, 512]]);
    assert.equal(pr(3, PX.SACT) | pr(3, PX.IS) & TFES, 0, "queued commands work again");
    assert.deepEqual(mem.subarray(DATA, DATA + 512), extra.subarray(512, 1024));
});
emulator.detach_sata_drive(3);
pw(3, PX.SERR, -1);

// the drive's disk_error policy (docs/disk-persistence-plan.md D0): sata3
// with the default ("stop"), sata4 with "report"; their reads and writes
// fail on request
class FlakyDrive
{
    constructor(policy)
    {
        this.byteLength = 1 << 20;
        this.data = new Uint8Array(this.byteLength).map((_, i) => i * 3 + (i >> 9) & 0xFF);
        this.fail_reads = 0;
        this.fail_writes = 0;
        if(policy) this.disk_error = policy;
    }
    load() { this.onload?.({}); }
    get(start, length, done)
    {
        if(this.fail_reads) { this.fail_reads--; done(undefined, new Error("the test's drive failed the read")); return; }
        done(this.data.slice(start, start + length));
    }
    get_and_cache(start, length, done) { this.get(start, length, done); }
    get_from_cache() { return undefined; }
    set(start, data, done)
    {
        if(this.fail_writes) { this.fail_writes--; done(new Error("the test's drive failed the write")); return; }
        this.data.set(data, start);
        done();
    }
    get_buffer(done) { done(undefined); }
    get_state() { return []; }
    set_state() {}
}
const stopping = new FlakyDrive(), reporting = new FlakyDrive("report");
await emulator.attach_sata_drive(3, stopping);
await emulator.attach_sata_drive(4, reporting);
const disk_errors = [];
emulator.add_listener("disk-error", event => disk_errors.push(event));
pw(3, PX.SERR, -1);
pw(4, PX.SERR, -1);
test("disk_error: stop holds a failed queued read until run() retries it; report ends a queued write with ABRT (TFES)", () => {
    start_port(3);
    stopping.fail_reads = 1;
    ncq(3, 1, false, 10, 2, [[DATA, 1024]]);
    assert.equal(pr(3, PX.SACT), 1 << 1, "tag 1 is still in flight");
    assert.equal(cpu.disk_holds.length, 1, "held");
    assert.deepEqual(disk_errors[0], { disk: "sata3", operation: "read", offset: 10 * 512, length: 1024,
        reason: "the test's drive failed the read", retryable: true, policy: "stop" });
    // (run() retries it; the machine is stopped again before it runs)
    emulator.v86.run();
    emulator.v86.stop();
    assert.equal(cpu.disk_holds.length, 0);
    assert.equal(pr(3, PX.SACT) | pr(3, PX.IS) & TFES, 0, "the read completed");
    assert.deepEqual(mem.subarray(DATA, DATA + 1024), stopping.data.subarray(10 * 512, 12 * 512));
    start_port(4);
    reporting.fail_writes = 1;
    ncq(4, 2, true, 7, 1, [[DATA, 512]]);
    assert.ok(pr(4, PX.IS) & TFES, "TFES at once");
    assert.equal(pr(4, PX.TFD), 0x0441, "ABRT, DRDY|ERR");
    assert.equal(disk_errors[1].policy, "report");
    assert.equal(disk_errors[1].operation, "write");
    assert.equal(cpu.disk_holds.length, 0, "nothing held");
});
emulator.detach_sata_drive(3);
emulator.detach_sata_drive(4);
pw(3, PX.SERR, -1);
pw(4, PX.SERR, -1);

// a drive written back (docs/disk-persistence-plan.md D1): a buffer object
// of one's own with the backend contract, recording what the controller
// asks of it
class RecordingDrive extends FlakyDrive
{
    constructor()
    {
        super();
        this.disk_option = "read_write";
        this.log = [];
    }
    set(start, data, done) { this.log.push("write " + start / 512); super.set(start, data, done); }
    flush(done) { this.log.push("flush"); done(); }
    close(done) { this.log.push("close"); done(); }
    mark() { return "1"; }
    generation() { return "1"; }
    check_state() {}
}
const recording = new RecordingDrive();
await emulator.attach_sata_drive(3, recording);
pw(3, PX.SERR, -1);
test("a drive written back: IDENTIFY reports its write cache; an NCQ write with FUA is flushed before it completes", () => {
    start_port(3);
    issue(3, 0, { command: 0xEC, prdt: [[DATA, 512]] });
    const id = words(DATA, 256);
    assert.equal(id[82] & 1 << 5, 1 << 5, "word 82: write cache");
    assert.equal(id[85] & 1 << 5, 1 << 5, "word 85: enabled");
    ncq(3, 1, true, 8, 1, [[DATA, 512]]);
    assert.equal(pr(3, PX.SACT), 0);
    assert.deepEqual(recording.log, ["write 8"], "no FUA: no flush");
    issue(3, 2, { command: 0x61, features: 1, lba: 9, count: 2 << 3, device: 0xC0, prdt: [[DATA, 512]], write: true, queued: true });
    assert.equal(pr(3, PX.SACT) | pr(3, PX.IS) & TFES, 0, "completed");
    assert.deepEqual(recording.log, ["write 8", "write 9", "flush"], "FUA: the write, then the flush, then the completion");
    issue(3, 3, { command: 0xEF, features: 0x82 });
    issue(3, 4, { command: 0xEC, prdt: [[DATA, 512]] });
    assert.equal(words(DATA, 256)[85] & 1 << 5, 0, "SET FEATURES 82h: off");
    ncq(3, 5, true, 10, 1, [[DATA, 512]]);
    assert.deepEqual(recording.log.slice(3), ["write 10", "flush"], "write cache off: each write flushed");
    issue(3, 6, { command: 0xEF, features: 0x02 });
});
emulator.detach_sata_drive(3);
pw(3, PX.SERR, -1);

test("link power management: CAP, ICC requests, PxSCTL.IPM, commands wake the link, ALPE/ASP when idle", () => {
    const cap = r32(0x00);
    assert.ok(cap & 1 << 26 && cap & 1 << 14 && cap & 1 << 13, "SALP, SSC, PSC");
    start_port(0);
    issue(0, 0, { command: 0xEC, prdt: [[DATA, 512]] });
    assert.ok(words(DATA, 256)[76] & 1 << 9, "IDENTIFY word 76: host-initiated power management");
    const ipm = () => pr(0, PX.SSTS) >> 8 & 0xF;
    assert.equal(ipm(), 1, "active");
    pw(0, PX.CMD, FRE | ST | 2 << 28);
    assert.equal(ipm(), 2, "ICC: partial");
    assert.equal(pr(0, PX.CMD) >>> 28, 0, "ICC reads as idle");
    pw(0, PX.CMD, FRE | ST | 6 << 28);
    assert.equal(ipm(), 6, "ICC: slumber");
    issue(0, 1, { command: 0x25, lba: 1, count: 1, prdt: [[DATA, 512]] });
    assert.equal(pr(0, PX.CI), 0, "the command ran");
    assert.equal(ipm(), 1, "and woke the link");
    pw(0, PX.SCTL, 3 << 8);
    pw(0, PX.CMD, FRE | ST | 2 << 28);
    pw(0, PX.CMD, FRE | ST | 6 << 28);
    assert.equal(ipm(), 1, "PxSCTL.IPM: neither partial nor slumber allowed");
    pw(0, PX.SCTL, 0);
    pw(0, PX.CMD, FRE | ST | 1 << 26);
    assert.equal(ipm(), 2, "ALPE without ASP: an idle port goes to partial");
    pw(0, PX.CMD, FRE | ST | 3 << 26);
    issue(0, 2, { command: 0x25, lba: 2, count: 1, prdt: [[DATA, 512]] });
    assert.equal(ipm(), 6, "ALPE with ASP: slumber again after the command");
    assert.deepEqual(mem.subarray(DATA, DATA + 512), hda.subarray(2 * 512, 3 * 512));
    pw(0, PX.SCTL, 2 << 8);
    pw(0, PX.CMD, FRE | ST | 1 << 28);
    issue(0, 3, { command: 0x25, lba: 3, count: 1, prdt: [[DATA, 512]] });
    assert.equal(ipm(), 1, "slumber not allowed: stays active");
    pw(0, PX.SCTL, 0);
    pw(0, PX.CMD, FRE | ST | 1 << 28);
    assert.equal(ipm(), 1);
    pw(3, PX.CMD, 6 << 28);
    assert.equal(pr(3, PX.SSTS), 0, "no link, no state");
});

test("interrupts: GHC.IE and PxIE gate INTA (Q35: PIRQA, GSI 16); clearing PxIS lowers it", () => {
    start_port(0);
    const gsi = cpu.shared_irq_sources[16];
    w32(0x04, 0);
    pw(0, PX.IE, DHRS);
    issue(0, 0, { command: 0xEC, prdt: [[DATA, 512]] });
    assert.ok(!gsi.has(AHCI), "GHC.IE clear");
    assert.equal(r32(0x08), 1, "IS shows port 0");
    w32(0x04, 2);
    assert.ok(gsi.has(AHCI), "asserted");
    pw(0, PX.IS, DHRS | PSS);
    assert.ok(!gsi.has(AHCI), "deasserted");
    pw(0, PX.IE, 0);
    w32(0x04, 0);
});

test("MSI: the capability, INTA released, a message to the local APIC per event", () => {
    const LAPIC = 0xFEE00000;
    const irr = vector => !!((cpu.read32s(LAPIC + 0x200 + (vector >> 5) * 16) >>> 0) & 1 << (vector & 31));
    cpu.write32(LAPIC + 0xF0, 0x1FF); // software enabled
    assert.equal(pci.config_read(AHCI, 0x34, 1), 0x80, "capability list");
    assert.equal(pci.config_read(AHCI, 0x80, 2), 0x0005, "MSI, last capability");
    assert.equal(pci.config_read(AHCI, 0x82, 2), 0x0080, "64-bit address, one message, disabled");
    pci.config_write(AHCI, 0x84, 4, 0xFEE00000 | 3); // destination 0, physical (the low bits are reserved)
    pci.config_write(AHCI, 0x88, 4, 0);
    pci.config_write(AHCI, 0x8C, 2, 0x0045);         // vector 0x45, fixed
    pci.config_write(AHCI, 0x80, 4, 0xFFFF0105);     // enable; read-only bits stay
    assert.equal(pci.config_read(AHCI, 0x80, 4) >>> 0, 0x00810005);
    assert.equal(pci.config_read(AHCI, 0x84, 4) >>> 0, 0xFEE00000);

    start_port(0);
    w32(0x04, 2);
    pw(0, PX.IE, DHRS);
    issue(0, 0, { command: 0xEC, prdt: [[DATA, 512]] });
    assert.ok(irr(0x45), "the message reached the local APIC");
    assert.ok(!cpu.shared_irq_sources[16].has(AHCI), "INTA is not used with MSI");
    // disabling MSI with an interrupt pending: INTA again
    pci.config_write(AHCI, 0x82, 2, 0);
    assert.ok(cpu.shared_irq_sources[16].has(AHCI));
    pw(0, PX.IS, -1);
    assert.ok(!cpu.shared_irq_sources[16].has(AHCI));
    pw(0, PX.IE, 0);
    w32(0x04, 0);
});

test("COMRESET and HBA reset: the device sends its signature again", () => {
    start_port(0);
    pw(0, PX.SCTL, 1);
    assert.equal(pr(0, PX.SSTS) & 0xF, 0, "no link while COMRESET is asserted");
    pw(0, PX.IS, -1);
    pw(0, PX.SCTL, 0);
    assert.equal(pr(0, PX.SSTS), 0x113);
    assert.equal(pr(0, PX.SIG), 0x101);
    assert.ok(pr(0, PX.IS) & DHRS, "D2H FIS (FIS reception is on)");

    w32(0x04, 1);
    assert.equal(r32(0x04) & 1, 0, "HR self-clears");
    assert.equal(pr(0, PX.CMD) & (ST | FRE), 0);
    assert.equal(pr(0, PX.TFD), 0x7F);
    assert.equal(pr(0, PX.CLB), clb(0), "CLB survives an HBA reset");
    pw(0, PX.CMD, FRE);
    assert.equal(pr(0, PX.SIG), 0x101);
});

test("software reset: a control FIS with SRST, then without", () => {
    start_port(2);
    issue(2, 0, { control: 0x04 });
    assert.equal(pr(2, PX.CI), 0, "completes without a D2H FIS");
    assert.ok(pr(2, PX.TFD) & 0x80, "BSY while SRST is set");
    issue(2, 0, { control: 0x00 });
    assert.equal(pr(2, PX.SIG), 0xEB140101);
    assert.equal(pr(2, PX.TFD) & 0x88, 0);
    assert.ok(pr(2, PX.IS) & DHRS);
});

test("memory space and bus mastering: no decode without MSE, no commands without BME", () => {
    program_pci(0x0000);
    assert.equal(r32(0x0C), 0xFFFFFFFF, "ABAR not decoded");
    program_pci(0x0002);
    assert.equal(r32(0x0C), 0x3F);
    start_port(0);
    issue(0, 0, { command: 0xEC, prdt: [[DATA, 512]] });
    assert.equal(pr(0, PX.CI), 1, "waits for bus mastering");
    program_pci(0x0006);
    assert.equal(pr(0, PX.CI), 0, "runs once BME is set");
});

test("byte accesses to the port registers", () => {
    start_port(0);
    issue(0, 0, { command: 0xEC, prdt: [[DATA, 512]] });
    assert.equal(pr(0, PX.IS) & 3, 3);
    cpu.mmap_write8(ABAR + 0x100 + PX.IS, DHRS);
    assert.equal(pr(0, PX.IS) & 3, PSS, "a byte write clears only its bits");
    assert.equal(cpu.mmap_read8(ABAR + 0x100 + PX.SSTS), 0x13);
});

const state = await emulator.save_state();
await emulator.restore_state(state);
test("snapshot: registers and the drives survive, commands work after the restore", () => {
    assert.equal(pr(0, PX.CLB), clb(0));
    assert.equal(pr(0, PX.SIG), 0x101);
    assert.equal(pr(2, PX.SIG), 0xEB140101);
    start_port(0);
    issue(0, 0, { command: 0x25, lba: 7, count: 1, prdt: [[DATA, 512]] });
    assert.deepEqual(mem.subarray(DATA, DATA + 512), hda_original.subarray(7 * 512, 8 * 512));
});

// the streamed snapshot format too (its slots must not collide with the machine's)
const chunks = [];
await emulator.save_state_stream(chunk => { chunks.push(chunk.slice()); });
const stream = Buffer.concat(chunks);
await emulator.restore_state_stream({ size: stream.length, read: async (offset, length) => stream.subarray(offset, offset + length) });
test("streamed snapshot: a Q35 machine restores, the disks work", () => {
    assert.equal(cpu.platform.machine, "q35");
    assert.equal(pr(0, PX.SIG), 0x101);
    start_port(0);
    issue(0, 0, { command: 0x25, lba: 11, count: 1, prdt: [[DATA, 512]] });
    assert.deepEqual(mem.subarray(DATA, DATA + 512), hda_original.subarray(11 * 512, 12 * 512));
});

emulator.destroy();
console.log((failed ? "FAIL" : "PASS") + ": " + passed + " AHCI tests passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
