#!/usr/bin/env node

// The e1000 network card (net_device.type "e1000", an Intel 82540EM, the
// plugin of src/net_adapters/e1000/), driven through its registers and
// descriptor rings in guest memory; no guest code runs, the test moves the
// machine clock (docs/modern-pc-devices-plan.md, N1): PCI identity, the
// EEPROM (EERD and Microwire), the PHY over MDIC and auto-negotiation,
// transmit (legacy, context and data descriptors, checksum offload, TSO,
// VLAN, ring wrap), receive (filters, buffers across descriptors, FCS, the
// FIFO without descriptors, checksums, VLAN), interrupts and their
// moderation, statistics, resets and snapshots.

import assert from "node:assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

let host = 1000;
const options = {
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    memory_size: 32 * 1024 * 1024,
    net_device: { type: "e1000" },
    cpu_clock: { mode: "normal", now: () => host },
    autostart: false,
    log_level: 0,
};
const emulator = new V86(options);
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));

const cpu = emulator.v86.cpu;
const pci = cpu.devices.pci;
const mem = cpu.mem8;
// (the v86 layout: the NE2000's slot)
const E1000 = 0x05 << 3;
const BAR = 0xC0000000;
cpu.clock.resume();

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

const R = {
    CTRL: 0x0000, STATUS: 0x0008, EECD: 0x0010, EERD: 0x0014, MDIC: 0x0020, VET: 0x0038,
    ICR: 0x00C0, ITR: 0x00C4, ICS: 0x00C8, IMS: 0x00D0, IMC: 0x00D8, RCTL: 0x0100, TCTL: 0x0400, PBA: 0x1000,
    RDBAL: 0x2800, RDBAH: 0x2804, RDLEN: 0x2808, RDH: 0x2810, RDT: 0x2818, RDTR: 0x2820, RADV: 0x282C,
    TDBAL: 0x3800, TDBAH: 0x3804, TDLEN: 0x3808, TDH: 0x3810, TDT: 0x3818, TIDV: 0x3820, TADV: 0x382C,
    MPC: 0x4010, GPRC: 0x4074, GPTC: 0x4080, GORCL: 0x4088, GORCH: 0x408C, RNBC: 0x40A0, ROC: 0x40AC, TPR: 0x40D0,
    TPT: 0x40D4, TSCTC: 0x40F8,
    RXCSUM: 0x5000, MTA: 0x5200, RA: 0x5400, VFTA: 0x5600,
};
const ICR_TXDW = 1, ICR_TXQE = 2, ICR_LSC = 4, ICR_RXDMT0 = 1 << 4, ICR_RXO = 1 << 6, ICR_RXT0 = 1 << 7, ICR_MDAC = 1 << 9;
const RCTL_EN = 2, RCTL_UPE = 8, RCTL_MPE = 16, RCTL_LPE = 32, RCTL_BAM = 1 << 15, RCTL_VFE = 1 << 18, RCTL_SECRC = 1 << 26;
const BSIZE_256 = 3 << 16;
const TCTL_EN = 2;
const CTRL_RST = 1 << 26, CTRL_VME = 1 << 30;
const STATUS_LU = 2;
// transmit descriptor commands (second dword)
const EOP = 1 << 24, IFCS = 1 << 25, IC = 1 << 26, TSE = 1 << 26, RS = 1 << 27, DEXT = 1 << 29, VLE = 1 << 30, IDE = 1 << 31,
    DTYP_D = 1 << 20, CMD_TCP = 1 << 24, CMD_IP = 1 << 25;
const IXSM = 1, TXSM = 2;
// receive status and errors
const DD = 1, RX_EOP = 2, RX_IXSM = 4, VP = 8, TCPCS = 1 << 5, IPCS = 1 << 6;
const TCPE = 1 << 5;

const r32 = offset => cpu.mmap_read32(BAR + offset) >>> 0;
const w32 = (offset, value) => cpu.mmap_write32(BAR + offset, value | 0);
const u16 = a => mem[a] | mem[a + 1] << 8;
const u32 = a => (mem[a] | mem[a + 1] << 8 | mem[a + 2] << 16 | mem[a + 3] << 24) >>> 0;
const put32 = (a, v) => { mem[a] = v; mem[a + 1] = v >> 8; mem[a + 2] = v >> 16; mem[a + 3] = v >>> 24; };
const be16 = (b, o) => b[o] << 8 | b[o + 1];
const be32 = (b, o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
const irq = () => !!pci.intx_levels[E1000];

/** The card (the plugin's device object) */
const card = () => cpu.devices.net.device["card"];

/** Move the machine clock on and run the machine's timers */
function advance(ms)
{
    host += ms;
    cpu.run_hardware_timers(false, cpu.clock.now());
}

/** Frames the card sent */
let sent = [];
emulator.add_listener("net0-send", frame => sent.push(new Uint8Array(frame)));
const receive = frame => emulator.bus.send("net0-receive", frame);

// An independent RFC 1071 checksum
function csum(bytes, start = 0, end = bytes.length, sum = 0)
{
    for(let i = start; i < end; i += 2) sum += bytes[i] << 8 | (i + 1 < end ? bytes[i + 1] : 0);
    while(sum > 0xFFFF) sum = (sum & 0xFFFF) + Math.floor(sum / 0x10000);
    return sum;
}
const valid = (bytes, start, end, sum = 0) => csum(bytes, start, end, sum) === 0xFFFF;

const MAC = () => Array.from(card().mac);
const OTHER = [0x52, 0x54, 0x00, 0x12, 0x34, 0x56];

function eth(dst, src, type, payload)
{
    const f = new Uint8Array(14 + payload.length);
    f.set(dst); f.set(src, 6); f[12] = type >> 8; f[13] = type; f.set(payload, 14);
    return f;
}
/** An IPv4 header (no options) and payload; checksum filled unless zero_sum */
function ipv4(protocol, payload, { id = 0x1234, zero_sum = false, length } = {})
{
    const p = new Uint8Array(20 + payload.length);
    p[0] = 0x45; p[8] = 64; p[9] = protocol;
    const total = length === undefined ? p.length : length;
    p[2] = total >> 8; p[3] = total; p[4] = id >> 8; p[5] = id;
    p.set([10, 0, 2, 15], 12); p.set([10, 0, 2, 2], 16);
    if(!zero_sum) { const s = ~csum(p, 0, 20) & 0xFFFF; p[10] = s >> 8; p[11] = s; }
    p.set(payload, 20);
    return p;
}
/** TCP or UDP over IPv4 with a valid checksum (pseudo-header from ipv4's addresses) */
function l4(protocol, data, { seq = 1000, flags = 0x18 } = {})
{
    const header = protocol === 6 ? 20 : 8;
    const s = new Uint8Array(header + data.length);
    s[0] = 0x30; s[1] = 0x39; s[2] = 0x00; s[3] = 0x50;
    if(protocol === 6)
    {
        s[4] = seq >>> 24; s[5] = seq >> 16; s[6] = seq >> 8; s[7] = seq;
        s[12] = 0x50; s[13] = flags; s[14] = 0xFF; s[15] = 0xFF;
    }
    else
    {
        s[4] = s.length >> 8; s[5] = s.length;
    }
    s.set(data, header);
    const at = protocol === 6 ? 16 : 6;
    const sum = ~csum(s, 0, s.length, pseudo(protocol, s.length)) & 0xFFFF || 0xFFFF;
    s[at] = sum >> 8; s[at + 1] = sum;
    return s;
}
const pseudo = (protocol, length) => csum(Uint8Array.of(10, 0, 2, 15, 10, 0, 2, 2)) + protocol + length;
const bytes = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => i * seed + 7 & 0xFF);

/** Check an IPv4 TCP/UDP frame's checksums */
function check_frame(f, what)
{
    assert.ok(valid(f, 14, 34), what + ": IP header checksum");
    const total = be16(f, 16), protocol = f[23];
    assert.ok(valid(f, 34, 14 + total, pseudo(protocol, total - 20)), what + ": " + (protocol === 6 ? "TCP" : "UDP") + " checksum");
}

// rings in guest memory
const TX_RING = 0x100000, TX_BUF = 0x110000, RX_RING = 0x200000, RX_BUF = 0x210000;
const TX_COUNT = 8, RX_COUNT = 8;
let tx_buf_next = TX_BUF;

function tx_buffer(data)
{
    const at = tx_buf_next;
    mem.set(data, at);
    tx_buf_next += data.length + 15 & ~15;
    if(tx_buf_next > TX_BUF + 0x80000) tx_buf_next = TX_BUF;
    return at;
}
function tx_desc(i, lower_low, lower_high, upper_low, upper_high)
{
    const a = TX_RING + 16 * i;
    put32(a, lower_low); put32(a + 4, lower_high); put32(a + 8, upper_low); put32(a + 12, upper_high);
}
/** legacy: buffer, length | CSO << 16 | CMD; STA | CSS << 8 | special << 16 */
const legacy = (i, data, cmd, { cso = 0, css = 0, special = 0 } = {}) =>
    tx_desc(i, tx_buffer(data), 0, data.length | cso << 16 | cmd, css << 8 | special << 16);
const context = (i, { ipcss = 14, ipcso = 24, ipcse = 33, tucss = 34, tucso, tucse = 0, paylen = 0, tucmd, hdrlen = 0, mss = 0 }) =>
    tx_desc(i, ipcss | ipcso << 8 | ipcse << 16, tucss | tucso << 8 | tucse << 16, paylen | DEXT | tucmd, hdrlen << 8 | mss << 16);
const data_desc = (i, data, dcmd, popts = 0, special = 0) =>
    tx_desc(i, tx_buffer(data), 0, data.length | DEXT | DTYP_D | dcmd, popts << 8 | special << 16);
const tx_status = i => mem[TX_RING + 16 * i + 12] & 0xF;

function setup_tx()
{
    w32(R.TDBAL, TX_RING); w32(R.TDBAH, 0); w32(R.TDLEN, TX_COUNT * 16);
    w32(R.TDH, 0); w32(R.TDT, 0);
    mem.fill(0, TX_RING, TX_RING + TX_COUNT * 16);
    w32(R.TCTL, TCTL_EN);
    sent = [];
}

const rx_buffer = i => RX_BUF + i * 0x4000;
/** (a ring is a multiple of eight descriptors, RDLEN of 128 bytes) */
function setup_rx(rctl, count = RX_COUNT)
{
    w32(R.RCTL, 0);
    for(let i = 0; i < RX_COUNT; i++)
    {
        const a = RX_RING + 16 * i;
        mem.fill(0, a, a + 16);
        put32(a, rx_buffer(i));
        mem.fill(0xCC, rx_buffer(i), rx_buffer(i) + 0x4000);
    }
    w32(R.RDBAL, RX_RING); w32(R.RDBAH, 0); w32(R.RDLEN, count * 16);
    w32(R.RDH, 0); w32(R.RDT, count - 1);
    w32(R.RCTL, rctl);
}
const rx = i => {
    const a = RX_RING + 16 * i;
    return { length: u16(a + 8), csum: u16(a + 10), status: mem[a + 12], errors: mem[a + 13], special: u16(a + 14),
        data: mem.slice(rx_buffer(i), rx_buffer(i) + u16(a + 8)) };
};

/** A reference FCS (bitwise CRC-32) */
function fcs(f)
{
    let c = ~0;
    for(const b of f) { c ^= b; for(let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ c >>> 1 : c >>> 1; }
    return ~c >>> 0;
}

// --- PCI ---------------------------------------------------------------------

test("PCI: 8086:100E, subsystem 8086:001E, Ethernet, INTA, power management, no MSI", () => {
    const space = pci.space_bytes(E1000);
    const word = o => space[o] | space[o + 1] << 8;
    assert.equal(word(0), 0x8086);
    assert.equal(word(2), 0x100E);
    assert.equal(word(0x2C), 0x8086);
    assert.equal(word(0x2E), 0x001E);
    assert.deepEqual([space[0x0B], space[0x0A], space[0x09]], [2, 0, 0], "class 02/00/00");
    assert.equal(space[0x3D], 1, "INTA");
    assert.ok(word(6) & 0x10, "capabilities list");
    assert.equal(space[0x34], 0xDC);
    assert.equal(space[0xDC], 0x01, "power management");
    assert.equal(space[0xDD], 0, "the only capability (no MSI)");
    assert.equal(word(0xDE), 0xC822);
});

test("PCI: BAR0 is 128 KiB of memory, BAR1 64 I/O ports", () => {
    pci.config_write(E1000, 0x10, 4, -1);
    const space = pci.space_bytes(E1000);
    const dword = o => (space[o] | space[o + 1] << 8 | space[o + 2] << 16 | space[o + 3] << 24) >>> 0;
    assert.equal(dword(0x10), 0xFFFE0000, "BAR0 size");
    const io = dword(0x14);
    assert.equal(io & 1, 1, "BAR1: I/O");
    pci.config_write(E1000, 0x14, 4, -1);
    assert.equal(dword(0x14), 0xFFFFFFC1, "BAR1 size");
    pci.config_write(E1000, 0x14, 4, io);
    pci.config_write(E1000, 0x10, 4, BAR);
    assert.equal(r32(R.STATUS), 0xFFFFFFFF, "not decoded while memory space is off");
    pci.config_write(E1000, 0x04, 2, 0x0007);
    assert.ok(r32(R.STATUS) & STATUS_LU, "decoded: link up");
});

test("PCI: the power management capability keeps its read-only bytes; PMCSR takes D3 and back", () => {
    pci.config_write(E1000, 0xDC, 4, 0);
    pci.config_write(E1000, 0xE0, 2, 0x8103);
    const space = pci.space_bytes(E1000);
    assert.deepEqual(Array.from(space.subarray(0xDC, 0xE2)), [0x01, 0x00, 0x22, 0xC8, 0x03, 0x01]);
    pci.config_write(E1000, 0xE0, 2, 0);
    assert.equal(space[0xE0], 0);
});

test("I/O BAR: IOADDR selects a register, IODATA reaches it", () => {
    const space = pci.space_bytes(E1000);
    const io = (space[0x14] | space[0x15] << 8) & ~3;
    cpu.io.port_write32(io, R.STATUS);
    assert.equal(cpu.io.port_read32(io + 4) >>> 0, r32(R.STATUS));
    cpu.io.port_write32(io, R.VET);
    cpu.io.port_write32(io + 4, 0x8100);
    assert.equal(r32(R.VET), 0x8100);
});

// --- EEPROM and PHY ------------------------------------------------------------

function eerd(word)
{
    w32(R.EERD, word << 8 | 1);
    const value = r32(R.EERD);
    assert.ok(value & 0x10, "EERD: done");
    return value >>> 16;
}
function microwire(word)
{
    const CS = 2, SK = 1, DI = 4, DO = 8;
    let eecd = r32(R.EECD) & ~0xF;
    const write = v => { eecd = v; w32(R.EECD, v); };
    write(eecd | CS);
    const shift_out = (value, bits) => {
        for(let i = bits - 1; i >= 0; i--)
        {
            const di = value >> i & 1 ? DI : 0;
            write(eecd & ~DI | di);
            write(eecd | SK);
            write(eecd & ~SK);
        }
    };
    shift_out(6, 3);
    shift_out(word, 6);
    let value = 0;
    for(let i = 0; i < 16; i++)
    {
        write(eecd | SK);
        value = value << 1 | (r32(R.EECD) & DO ? 1 : 0);
        write(eecd & ~SK);
    }
    write(eecd & ~CS);
    return value;
}

test("EEPROM: 64 words summing to 0xBABA, the address and IDs (EERD)", () => {
    let sum = 0;
    const words = [];
    for(let i = 0; i < 64; i++) { words.push(eerd(i)); sum += words[i]; }
    assert.equal(sum & 0xFFFF, 0xBABA, "checksum");
    const mac = MAC();
    assert.deepEqual(words.slice(0, 3), [mac[0] | mac[1] << 8, mac[2] | mac[3] << 8, mac[4] | mac[5] << 8]);
    assert.deepEqual(words.slice(0x0B, 0x0F), [0x001E, 0x8086, 0x100E, 0x8086], "subsystem and device");
    assert.equal(r32(R.RA), (mac[0] | mac[1] << 8 | mac[2] << 16 | mac[3] << 24) >>> 0, "RAL0");
    assert.equal(r32(R.RA + 4), (mac[4] | mac[5] << 8 | 1 << 31) >>> 0, "RAH0: address valid");
    assert.deepEqual([0, 1, 2, 0x0B, 0x3F].map(microwire), [0, 1, 2, 0x0B, 0x3F].map(eerd), "Microwire reads the same words");
    assert.equal(r32(R.EECD) & 0x380, 0x180, "present, granted, 64 words");
});

function mdic(op, reg, data = 0, phy = 1)
{
    w32(R.MDIC, op << 26 | phy << 21 | reg << 16 | data);
    const value = r32(R.MDIC);
    assert.ok(value & 1 << 28, "MDIC: ready");
    return value;
}

test("PHY: an 88E1011 at address 1 (the ID Intel's driver checks), 1000 Mb/s full duplex", () => {
    assert.equal(mdic(2, 2) & 0xFFFF, 0x0141);
    assert.equal(mdic(2, 3) & 0xFFFF, 0x0C20);
    assert.ok(mdic(2, 1) & 0x24, "BMSR: link, auto-negotiation complete");
    assert.ok(mdic(2, 3, 0, 2) & 1 << 30, "no PHY at address 2");
    const status = r32(R.STATUS);
    assert.equal(status & 0xC3, 0x83, "STATUS: full duplex, link up, 1000 Mb/s");
    mdic(1, 4, 0x01E1);
    assert.equal(mdic(2, 4) & 0xFFFF, 0x01E1, "ANAR is writable");
    mdic(1, 2, 0x1234);
    assert.equal(mdic(2, 2) & 0xFFFF, 0x0141, "the ID is read-only");
});

test("PHY: restarting auto-negotiation takes the link down, LSC when it is back; MDAC", () => {
    w32(R.IMS, ICR_LSC | ICR_MDAC);
    r32(R.ICR);
    mdic(1, 0, 0x1340);
    assert.equal(r32(R.STATUS) & STATUS_LU, 0, "link down");
    assert.equal(mdic(2, 1) & 4, 0);
    advance(50);
    assert.equal(r32(R.STATUS) & STATUS_LU, 0, "still negotiating");
    advance(60);
    assert.ok(r32(R.STATUS) & STATUS_LU, "link up again");
    assert.ok(irq());
    assert.equal(r32(R.ICR) & ICR_LSC, ICR_LSC);
    assert.ok(!irq(), "ICR read: INTA released");
    w32(R.MDIC, 2 << 26 | 1 << 21 | 1 << 16 | 1 << 29);
    assert.equal(r32(R.ICR) & ICR_MDAC, ICR_MDAC, "MDIC with interrupt enable: MDAC");
    w32(R.IMC, -1);
});

// --- interrupts ---------------------------------------------------------------

test("interrupts: ICS sets causes, IMS/IMC mask, ICR reads to clear and writes one to clear", () => {
    w32(R.IMC, -1);
    r32(R.ICR);
    w32(R.ICS, ICR_RXT0 | ICR_TXDW);
    assert.ok(!irq(), "masked");
    assert.equal(r32(R.IMS), 0);
    w32(R.IMS, ICR_RXT0);
    assert.ok(irq(), "unmasked: INTA");
    assert.equal(r32(R.IMS), ICR_RXT0);
    w32(R.IMC, ICR_RXT0);
    assert.ok(!irq());
    w32(R.IMS, ICR_RXT0);
    w32(R.ICR, ICR_RXT0);
    assert.ok(!irq(), "write one to clear");
    assert.equal(r32(R.ICR), ICR_TXDW, "the rest stays until read");
    assert.equal(r32(R.ICR), 0, "read to clear");
    w32(R.IMC, -1);
});

test("interrupts: ITR spaces rising edges by its interval (256 ns units)", () => {
    w32(R.ITR, 1000);
    w32(R.IMS, ICR_RXT0);
    w32(R.ICS, ICR_RXT0);
    assert.ok(irq(), "the first at once");
    r32(R.ICR);
    w32(R.ICS, ICR_RXT0);
    assert.ok(!irq(), "the next waits (256 us)");
    advance(0.1);
    assert.ok(!irq());
    advance(0.2);
    assert.ok(irq(), "after the interval");
    r32(R.ICR);
    w32(R.ITR, 0);
    w32(R.IMC, -1);
});

// --- transmit -----------------------------------------------------------------

test("transmit: legacy descriptors, a frame in two buffers, RS writes DD, TXDW and TXQE", () => {
    setup_tx();
    w32(R.IMS, ICR_TXDW);
    r32(R.ICR);
    const frame = eth(OTHER, MAC(), 0x0800, bytes(100));
    legacy(0, frame.subarray(0, 20), 0);
    legacy(1, frame.subarray(20), EOP | IFCS | RS);
    w32(R.TDT, 2);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], frame);
    assert.equal(r32(R.TDH), 2);
    assert.equal(tx_status(0), 0, "no RS: not written back");
    assert.equal(tx_status(1), DD);
    assert.ok(irq(), "TXDW");
    assert.equal(r32(R.ICR), ICR_TXDW | ICR_TXQE);
    assert.equal(r32(R.TPT), 1);
    assert.equal(r32(R.GPTC), 1);
    w32(R.IMC, -1);
});

test("transmit: the ring wraps; TCTL.EN off holds the queue", () => {
    sent = [];
    for(let n = 0; n < 7; n++) legacy((2 + n) % TX_COUNT, eth(OTHER, MAC(), 0x88B5, bytes(50, n + 1)), EOP | RS);
    w32(R.TCTL, 0);
    w32(R.TDT, 1);
    assert.equal(sent.length, 0, "transmitter off");
    w32(R.TCTL, TCTL_EN);
    assert.equal(sent.length, 7);
    assert.equal(r32(R.TDH), 1);
    sent.forEach((f, n) => assert.equal(f[14 + 1], 7 + n + 1 & 0xFF, "in ring order"));
    r32(R.ICR);
});

test("transmit: bus mastering off holds the queue until it is on", () => {
    sent = [];
    legacy(1, eth(OTHER, MAC(), 0x88B5, bytes(50)), EOP | RS);
    pci.config_write(E1000, 0x04, 2, 0x0003);
    w32(R.TDT, 2);
    assert.equal(sent.length, 0);
    pci.config_write(E1000, 0x04, 2, 0x0007);
    assert.equal(sent.length, 1);
    r32(R.ICR);
});

test("transmit: IP and UDP checksums inserted (context + data descriptors)", () => {
    setup_tx();
    const udp = l4(17, bytes(301, 3));
    // the driver leaves the pseudo header's sum in the UDP checksum
    const ps = csum(new Uint8Array(0), 0, 0, pseudo(17, udp.length));
    udp[6] = ps >> 8; udp[7] = ps;
    const frame = eth(OTHER, MAC(), 0x0800, ipv4(17, udp, { zero_sum: true }));
    context(0, { tucso: 34 + 6, tucmd: CMD_IP });
    data_desc(1, frame.subarray(0, 34), 0, IXSM | TXSM);
    data_desc(2, frame.subarray(34), EOP | RS);
    w32(R.TDT, 3);
    assert.equal(sent.length, 1);
    check_frame(sent[0], "UDP");
    assert.equal(tx_status(2), DD);
    r32(R.ICR);
});

test("transmit: a legacy descriptor's checksum (IC, CSO, CSS)", () => {
    sent = [];
    const payload = bytes(77);
    const frame = eth(OTHER, MAC(), 0x88B5, new Uint8Array(2 + payload.length));
    frame.set(payload, 16);
    legacy(3, frame, EOP | IC | RS, { cso: 14, css: 16 });
    w32(R.TDT, 4);
    assert.equal(be16(sent[0], 14), ~csum(payload) & 0xFFFF);
    r32(R.ICR);
});

test("transmit: TSO cuts a TCP stream into MSS segments (lengths, IDs, sequence, PSH, checksums)", () => {
    setup_tx();
    const payload = bytes(2500, 5);
    const tcp = l4(6, new Uint8Array(0), { seq: 0x10000000, flags: 0x18 });
    // what drivers leave for TSO: no IP length and checksum, the pseudo header's sum without length
    const ps = csum(new Uint8Array(0), 0, 0, pseudo(6, 0));
    tcp[16] = ps >> 8; tcp[17] = ps;
    const header = eth(OTHER, MAC(), 0x0800, ipv4(6, tcp, { zero_sum: true, length: 0, id: 0x4000 }));
    assert.equal(header.length, 54);
    context(0, { tucso: 34 + 16, tucmd: CMD_IP | CMD_TCP | TSE, paylen: 2500, hdrlen: 54, mss: 1000 });
    data_desc(1, header, TSE, IXSM | TXSM);
    data_desc(2, payload.subarray(0, 1200), TSE);
    data_desc(3, payload.subarray(1200), TSE | EOP | RS);
    r32(R.TSCTC);
    w32(R.TDT, 4);
    assert.equal(sent.length, 3);
    sent.forEach((f, n) => {
        const size = n < 2 ? 1000 : 500;
        assert.equal(f.length, 54 + size, "segment " + n);
        assert.equal(be16(f, 16), 40 + size, "IP total length");
        assert.equal(be16(f, 18), 0x4000 + n, "IP identification");
        assert.equal(be32(f, 38), 0x10000000 + 1000 * n, "sequence number");
        assert.equal(f[47] & 8, n < 2 ? 0 : 8, "PSH on the last segment only");
        assert.deepEqual(f.subarray(54), payload.subarray(1000 * n, 1000 * n + size));
        check_frame(f, "segment " + n);
    });
    assert.equal(r32(R.TSCTC), 1);
    r32(R.ICR);
});

test("transmit: VLAN tag inserted (CTRL.VME, VLE)", () => {
    setup_tx();
    w32(R.CTRL, r32(R.CTRL) | CTRL_VME);
    w32(R.VET, 0x8100);
    const frame = eth(OTHER, MAC(), 0x0800, bytes(60));
    legacy(0, frame, EOP | RS | VLE, { special: 0x2123 });
    w32(R.TDT, 1);
    assert.deepEqual(Array.from(sent[0].subarray(12, 16)), [0x81, 0x00, 0x21, 0x23]);
    assert.deepEqual(sent[0].subarray(16), frame.subarray(12));
    w32(R.CTRL, r32(R.CTRL) & ~CTRL_VME);
    r32(R.ICR);
});

test("transmit: IDE delays TXDW by TIDV, at most TADV after the first", () => {
    setup_tx();
    w32(R.TIDV, 100);
    w32(R.TADV, 150);
    w32(R.IMS, ICR_TXDW);
    r32(R.ICR);
    legacy(0, eth(OTHER, MAC(), 0x88B5, bytes(50)), EOP | RS | IDE);
    w32(R.TDT, 1);
    assert.ok(!irq(), "delayed");
    advance(0.07);
    legacy(1, eth(OTHER, MAC(), 0x88B5, bytes(50)), EOP | RS | IDE);
    w32(R.TDT, 2);
    advance(0.07);
    assert.ok(!irq(), "TIDV restarted by the second");
    advance(0.02);
    assert.ok(irq(), "TADV (153.6 us) after the first");
    r32(R.ICR);
    w32(R.TIDV, 0); w32(R.TADV, 0);
    w32(R.IMC, -1);
});

// --- receive ------------------------------------------------------------------

test("receive: unicast to RA[0] into a descriptor, FCS kept (SECRC off), RXT0", () => {
    setup_rx(RCTL_EN | RCTL_BAM);
    w32(R.IMS, ICR_RXT0);
    r32(R.ICR);
    const frame = eth(MAC(), OTHER, 0x88B5, bytes(100));
    receive(frame);
    const d = rx(0);
    assert.equal(d.length, frame.length + 4);
    assert.equal(d.status & (DD | RX_EOP), DD | RX_EOP);
    assert.deepEqual(d.data.subarray(0, frame.length), frame);
    const crc = fcs(frame);
    assert.deepEqual(Array.from(d.data.subarray(frame.length)), [crc & 0xFF, crc >>> 8 & 0xFF, crc >>> 16 & 0xFF, crc >>> 24]);
    assert.equal(r32(R.RDH), 1);
    assert.ok(irq());
    assert.equal(r32(R.ICR) & ICR_RXT0, ICR_RXT0);
    assert.equal(r32(R.GPRC), 1);
    assert.equal(r32(R.GORCL), frame.length + 4);
});

test("receive: short frames padded to 60 bytes", () => {
    receive(eth(MAC(), OTHER, 0x88B5, bytes(10)));
    assert.equal(rx(1).length, 64);
    assert.equal(r32(R.RDH), 2);
});

test("receive filter: other unicast, broadcast (BAM), multicast (MTA, MPE), promiscuous (UPE)", () => {
    setup_rx(RCTL_EN | RCTL_SECRC);
    const head = () => r32(R.RDH);
    receive(eth(OTHER, [2, 0, 0, 0, 0, 1], 0x88B5, bytes(50)));
    assert.equal(head(), 0, "another card's address");
    receive(eth([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF], OTHER, 0x0806, bytes(46)));
    assert.equal(head(), 0, "broadcast without BAM");
    w32(R.RCTL, RCTL_EN | RCTL_SECRC | RCTL_BAM);
    receive(eth([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF], OTHER, 0x0806, bytes(46)));
    assert.equal(head(), 1, "broadcast with BAM");
    const group = [0x01, 0x00, 0x5E, 0x00, 0x00, 0xFB];
    receive(eth(group, OTHER, 0x0800, bytes(46)));
    assert.equal(head(), 1, "multicast not in the table");
    const hash = (group[5] << 8 | group[4]) >> 4 & 0xFFF;
    w32(R.MTA + (hash >> 5) * 4, 1 << (hash & 31));
    receive(eth(group, OTHER, 0x0800, bytes(46)));
    assert.equal(head(), 2, "multicast in the table (MO 0)");
    receive(eth([0x01, 0x00, 0x5E, 0x00, 0x00, 0x01], OTHER, 0x0800, bytes(46)));
    assert.equal(head(), 2);
    w32(R.RCTL, RCTL_EN | RCTL_SECRC | RCTL_BAM | RCTL_MPE);
    receive(eth([0x01, 0x00, 0x5E, 0x00, 0x00, 0x01], OTHER, 0x0800, bytes(46)));
    assert.equal(head(), 3, "multicast promiscuous");
    w32(R.RCTL, RCTL_EN | RCTL_SECRC | RCTL_UPE);
    receive(eth(OTHER, [2, 0, 0, 0, 0, 1], 0x88B5, bytes(50)));
    assert.equal(head(), 4, "unicast promiscuous");
    w32(R.RA + 8, 0x00544152); w32(R.RA + 12, 1 << 31 | 0x5634);
    w32(R.RCTL, RCTL_EN | RCTL_SECRC);
    receive(eth([0x52, 0x41, 0x54, 0x00, 0x34, 0x56], OTHER, 0x88B5, bytes(50)));
    assert.equal(head(), 5, "a second receive address");
    w32(R.RA + 12, 0);
    w32(R.MTA + (hash >> 5) * 4, 0);
    r32(R.ICR);
});

test("receive: a frame across 256-byte buffers, EOP on the last; RXDMT0", () => {
    setup_rx(RCTL_EN | RCTL_SECRC | BSIZE_256);
    w32(R.IMS, ICR_RXDMT0 | ICR_RXT0);
    r32(R.ICR);
    const frame = eth(MAC(), OTHER, 0x88B5, bytes(586));
    receive(frame);
    assert.deepEqual([0, 1, 2].map(i => rx(i).length), [256, 256, 88]);
    assert.deepEqual([0, 1, 2].map(i => rx(i).status & (DD | RX_EOP)), [DD, DD, DD | RX_EOP]);
    const data = new Uint8Array([...rx(0).data, ...rx(1).data, ...rx(2).data]);
    assert.deepEqual(data, frame);
    assert.equal(r32(R.RDH), 3);
    receive(frame);
    assert.equal(r32(R.RDH), 6);
    assert.equal(r32(R.ICR) & ICR_RXDMT0, ICR_RXDMT0, "one free descriptor of eight: below half");
    w32(R.IMC, -1);
});

test("receive: without free descriptors frames wait in the FIFO (RNBC); a full FIFO drops (MPC, RXO)", () => {
    setup_rx(RCTL_EN | RCTL_SECRC);
    r32(R.RNBC); r32(R.MPC);
    w32(R.RDT, 0);
    w32(R.IMS, ICR_RXO);
    r32(R.ICR);
    const frame = n => eth(MAC(), OTHER, 0x88B5, bytes(1000, n));
    for(let n = 0; n < 3; n++) receive(frame(n));
    assert.equal(r32(R.RDH), 0);
    assert.equal(r32(R.RNBC), 3);
    w32(R.RDT, 2);
    assert.equal(r32(R.RDH), 2, "two delivered when the guest gives two");
    assert.deepEqual(rx(1).data, frame(1));
    w32(R.RDT, 3);
    assert.deepEqual(rx(2).data, frame(2), "in order");
    assert.ok(!irq());
    // PBA's 48 KiB
    for(let n = 0; n < 60; n++) receive(frame(n));
    assert.ok(r32(R.MPC) > 0, "missed packets");
    assert.ok(irq(), "RXO");
    assert.equal(r32(R.ICR) & ICR_RXO, ICR_RXO);
    // (the FIFO's frames go with a reset)
    w32(R.CTRL, r32(R.CTRL) | CTRL_RST);
    assert.equal(card().rx_fifo.length, 0);
});

test("receive: IPv4 and TCP/UDP checksums checked (RXCSUM), IXSM without", () => {
    setup_rx(RCTL_EN | RCTL_SECRC);
    w32(R.RXCSUM, 0x300);
    const good = eth(MAC(), OTHER, 0x0800, ipv4(6, l4(6, bytes(200))));
    receive(good);
    assert.equal(rx(0).status & (IPCS | TCPCS | RX_IXSM), IPCS | TCPCS);
    assert.equal(rx(0).errors, 0);
    const bad = good.slice();
    bad[60] ^= 1;
    receive(bad);
    assert.equal(rx(1).errors & TCPE, TCPE, "TCP checksum error");
    receive(eth(MAC(), OTHER, 0x0800, ipv4(17, l4(17, bytes(31)))));
    assert.equal(rx(2).status & (IPCS | TCPCS), IPCS | TCPCS, "UDP");
    assert.equal(rx(2).errors, 0);
    receive(eth(MAC(), OTHER, 0x86DD, bytes(60)));
    assert.equal(rx(3).status & (IPCS | TCPCS | RX_IXSM), RX_IXSM, "not IPv4: nothing checked");
    w32(R.RXCSUM, 0);
    receive(good);
    assert.equal(rx(4).status & (IPCS | TCPCS | RX_IXSM), RX_IXSM, "offload off");
});

test("receive: VLAN tag stripped into the descriptor (CTRL.VME), VFTA filter (VFE)", () => {
    setup_rx(RCTL_EN | RCTL_SECRC);
    w32(R.CTRL, r32(R.CTRL) | CTRL_VME);
    w32(R.VET, 0x8100);
    const inner = eth(MAC(), OTHER, 0x0800, bytes(60));
    const tagged = new Uint8Array(inner.length + 4);
    tagged.set(inner.subarray(0, 12));
    tagged.set([0x81, 0x00, 0x20, 0x05], 12);
    tagged.set(inner.subarray(12), 16);
    receive(tagged);
    assert.equal(rx(0).status & VP, VP);
    assert.equal(rx(0).special, 0x2005);
    assert.deepEqual(rx(0).data, inner);
    w32(R.RCTL, RCTL_EN | RCTL_SECRC | RCTL_VFE);
    receive(tagged);
    assert.equal(r32(R.RDH), 1, "VLAN 5 not in VFTA");
    w32(R.VFTA, 1 << 5);
    receive(tagged);
    assert.equal(r32(R.RDH), 2);
    w32(R.VFTA, 0);
    w32(R.CTRL, r32(R.CTRL) & ~CTRL_VME);
});

test("receive: frames over 1518 bytes need LPE (ROC)", () => {
    setup_rx(RCTL_EN | RCTL_SECRC);
    r32(R.ROC);
    const long = eth(MAC(), OTHER, 0x88B5, bytes(1600));
    receive(long);
    assert.equal(r32(R.RDH), 0);
    assert.equal(r32(R.ROC), 1);
    w32(R.RCTL, RCTL_EN | RCTL_SECRC | RCTL_LPE);
    receive(long);
    assert.equal(r32(R.RDH), 1);
    assert.equal(rx(0).length, long.length);
});

test("receive: RDTR delays RXT0, RADV bounds the delay", () => {
    setup_rx(RCTL_EN | RCTL_SECRC);
    w32(R.RDTR, 100);
    w32(R.RADV, 200);
    w32(R.IMS, ICR_RXT0);
    r32(R.ICR);
    const frame = eth(MAC(), OTHER, 0x88B5, bytes(50));
    receive(frame);
    assert.ok(!irq(), "delayed");
    advance(0.11);
    assert.ok(irq(), "RDTR (102.4 us) without another frame");
    r32(R.ICR);
    for(let n = 0; n < 3; n++) { receive(frame); advance(0.06); }
    assert.ok(!irq(), "each frame restarts RDTR");
    advance(0.04);
    assert.ok(irq(), "RADV (204.8 us) after the first");
    r32(R.ICR);
    w32(R.RDTR, 0x80000000 | 100);
    receive(frame);
    w32(R.RDTR, 1 << 31 | 100);
    assert.ok(irq(), "FPD ends the delay");
    r32(R.ICR);
    w32(R.RDTR, 0); w32(R.RADV, 0);
    w32(R.IMC, -1);
});

test("statistics read to clear; a 64-bit counter clears with its high half", () => {
    setup_rx(RCTL_EN | RCTL_SECRC);
    r32(R.GPRC); r32(R.GORCH);
    receive(eth(MAC(), OTHER, 0x88B5, bytes(100)));
    assert.equal(r32(R.GPRC), 1);
    assert.equal(r32(R.GPRC), 0);
    assert.equal(r32(R.TPR) > 0, true);
    assert.equal(r32(R.GORCL), 118);
    assert.equal(r32(R.GORCL), 118, "the low half alone does not clear");
    assert.equal(r32(R.GORCH), 0);
    assert.equal(r32(R.GORCL), 0);
});

test("loopback: a frame sent in PHY loopback comes back", () => {
    setup_rx(RCTL_EN | RCTL_SECRC);
    setup_tx();
    mdic(1, 0, 0x4140);
    const frame = eth(MAC(), MAC(), 0x88B5, bytes(64));
    legacy(0, frame, EOP | RS);
    w32(R.TDT, 1);
    assert.equal(sent.length, 0, "not to the network");
    assert.deepEqual(rx(0).data, frame);
    mdic(1, 0, 0x1140);
    r32(R.ICR);
});

// --- resets and snapshots -------------------------------------------------------

test("CTRL.RST: registers to their defaults, RA[0] from the EEPROM, the PHY kept", () => {
    w32(R.RA, 0x11223344);
    w32(R.IMS, ICR_RXT0);
    w32(R.ICS, ICR_RXT0);
    w32(R.RCTL, RCTL_EN);
    assert.ok(irq());
    mdic(1, 4, 0x01E1);
    w32(R.CTRL, r32(R.CTRL) | CTRL_RST);
    assert.equal(r32(R.CTRL) & CTRL_RST, 0, "self-clearing");
    assert.equal(r32(R.RCTL), 0);
    assert.equal(r32(R.IMS), 0);
    assert.ok(!irq());
    assert.equal(r32(R.RA), (eerd(0) | eerd(1) << 16) >>> 0);
    assert.equal(r32(R.PBA), 0x00100030);
    assert.equal(mdic(2, 4) & 0xFFFF, 0x01E1);
    assert.ok(r32(R.STATUS) & STATUS_LU);
});

const saved = { rdh: 0, tdh: 0, mac: [] };
let state;
{
    setup_rx(RCTL_EN | RCTL_SECRC);
    setup_tx();
    w32(R.RDT, 0);
    w32(R.ITR, 777);
    w32(R.IMS, ICR_RXT0 | ICR_TXDW);
    const waiting = eth(MAC(), OTHER, 0x88B5, bytes(333));
    receive(waiting);
    legacy(0, eth(OTHER, MAC(), 0x88B5, bytes(50)), EOP | RS);
    w32(R.TDT, 1);
    saved.mac = MAC();
    saved.tdh = r32(R.TDH);
    state = await emulator.save_state();
    w32(R.CTRL, CTRL_RST);
    w32(R.MTA, 0x55);
    await emulator.restore_state(state);
    test("snapshot: registers, rings, the FIFO and the address survive", () => {
        assert.equal(r32(R.ITR), 777);
        assert.equal(r32(R.IMS), ICR_RXT0 | ICR_TXDW);
        assert.equal(r32(R.MTA), 0);
        assert.equal(r32(R.TDH), saved.tdh);
        assert.equal(r32(R.RCTL), RCTL_EN | RCTL_SECRC);
        assert.deepEqual(MAC(), saved.mac);
        w32(R.RDT, 2);
        assert.deepEqual(rx(0).data, waiting, "the frame from the FIFO");
        assert.ok(r32(R.STATUS) & STATUS_LU);
    });
}

// Another machine restores the snapshot: its card keeps its own address
// (preserve_mac_from_state_image off), unless asked to translate
for(const mode of ["own", "translation", "preserve", "ne2k"])
{
    const other = new V86({ ...options,
        net_device: { type: mode === "ne2k" ? "ne2k" : "e1000" },
        mac_address_translation: mode === "translation",
        preserve_mac_from_state_image: mode === "preserve" });
    await new Promise(resolve => other.add_listener("emulator-loaded", resolve));
    if(mode === "ne2k")
    {
        let error;
        await other.restore_state(state).catch(e => { error = e; });
        test("snapshot: a machine with another network card refuses it", () => {
            assert.match(String(error && error.message), /net_device: "e1000", this one has "ne2k"/);
        });
        await other.destroy();
        continue;
    }
    await other.restore_state(state);
    const c = other.v86.cpu.devices.net.device["card"];
    const frames = [];
    other.add_listener("net0-send", f => frames.push(new Uint8Array(f)));
    const ra = c.guest_mac();
    test("snapshot restored with the address " + mode, () => {
        if(mode === "preserve")
        {
            assert.deepEqual(Array.from(c.mac), saved.mac);
            assert.deepEqual(Array.from(ra), saved.mac);
        }
        else if(mode === "own")
        {
            assert.notDeepEqual(Array.from(c.mac), saved.mac);
            assert.deepEqual(Array.from(ra), Array.from(c.mac), "RA[0] has the card's own address");
            assert.deepEqual(Array.from(c.eeprom_mac()), Array.from(c.mac));
        }
        else
        {
            assert.deepEqual(Array.from(ra), saved.mac, "the guest keeps its address");
            assert.notDeepEqual(Array.from(c.mac), saved.mac);
            // a frame the guest sends goes out with the card's address
            const cpu2 = other.v86.cpu;
            const f = eth(OTHER, saved.mac, 0x88B5, bytes(50));
            cpu2.mem8.set(f, 0x180000);
            const a = 0x100000 + 16;
            cpu2.mem8.fill(0, a, a + 16);
            new DataView(cpu2.mem8.buffer, cpu2.mem8.byteOffset).setUint32(a, 0x180000, true);
            new DataView(cpu2.mem8.buffer, cpu2.mem8.byteOffset).setUint32(a + 8, f.length | EOP | RS, true);
            cpu2.mmap_write32(BAR + R.TDT, 2);
            assert.equal(frames.length, 1);
            assert.deepEqual(Array.from(frames[0].subarray(6, 12)), Array.from(c.mac), "translated source");
        }
    });
    await other.destroy();
}

await emulator.destroy();
console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
