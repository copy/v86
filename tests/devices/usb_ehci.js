#!/usr/bin/env node

// EHCI (usb.controller "ehci", src/usb/ehci.js, docs/usb.md): ICH9's EHCI1
// with its three UHCI companions, driven through the registers and the
// schedules in guest memory, no guest code; the test moves the machine
// clock (docs/modern-pc-devices-plan.md U3). The PCI functions and the
// legacy support handoff, the capability registers, the ports' owners
// (CONFIGFLAG, Port Owner: the high-speed USB disk stays, the full-speed
// tablet goes to its companion), the asynchronous schedule (control
// transfers, BOT on bulk endpoints of 512 bytes, qTDs over pages, short
// packets and the alternate next qTD, STALL, no device, NAK), Interrupt on
// Async Advance, FRINDEX and the periodic schedule, hot plug, snapshots,
// HCRESET, the i440FX place.

import assert from "node:assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const SECTORS = 8192;
const pattern = i => (i * 11 + (i >> 9)) & 0xFF;
const image = new Uint8Array(SECTORS * 512).map((_, i) => pattern(i));

let host = 1000;
const options = machine_type => ({
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    memory_size: 64 * 1024 * 1024,
    machine_type,
    acpi: machine_type === "q35",
    usb: { controller: "ehci", tablet: true, mass_storage: [{ id: "stick", image: { buffer: image.buffer } }] },
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
async function test(name, f)
{
    try
    {
        await f();
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

const emulator = await machine("q35");
const cpu = emulator.v86.cpu;
const pci = cpu.devices.pci;
const mem = cpu.mem8;
const EHCI = 0x1D << 3 | 7, UHCI = [0x1D << 3, 0x1D << 3 | 1, 0x1D << 3 | 2];
const BAR = 0xC0000000, IO = 0xC000;

const r32 = offset => cpu.mmap_read32(BAR + offset) >>> 0;
const r8 = offset => cpu.mmap_read8(BAR + offset);
const w32 = (offset, value) => cpu.mmap_write32(BAR + offset, value | 0);
const u32 = a => (mem[a] | mem[a + 1] << 8 | mem[a + 2] << 16 | mem[a + 3] << 24) >>> 0;
const put32 = (a, v) => { mem[a] = v; mem[a + 1] = v >> 8; mem[a + 2] = v >> 16; mem[a + 3] = v >>> 24; };
const uhci_r16 = offset => cpu.io.port_read16(IO + offset);
const uhci_w16 = (offset, value) => cpu.io.port_write16(IO + offset, value);

// operational registers (after CAPLENGTH 0x20)
const USBCMD = 0x20, USBSTS = 0x24, USBINTR = 0x28, FRINDEX = 0x2C, PERIODICLISTBASE = 0x34, ASYNCLISTADDR = 0x38,
    CONFIGFLAG = 0x60, PORTSC = port => 0x64 + 4 * port;
const RS = 1, HCRESET = 2, PSE = 1 << 4, ASE = 1 << 5, IAAD = 1 << 6;
const USBINT = 1, USBERRINT = 2, PCD = 4, IAA = 1 << 5, HALTED = 1 << 12, PSS = 1 << 14, ASS = 1 << 15;
const CCS = 1, CSC = 2, PED = 4, PEDC = 8, PR = 1 << 8, PP = 1 << 12, PO = 1 << 13, LS = 3 << 10;
const UHCI_PORTSC1 = 0x10, UHCI_CCS = 1, UHCI_CSC = 2;
const TOKEN_ACTIVE = 1 << 7, TOKEN_HALTED = 1 << 6, TOKEN_XACTERR = 1 << 3, TOKEN_IOC = 1 << 15;
const OUT = 0, IN = 1, SETUP = 2;

/** Move the machine clock on and run the machine's timers */
function advance(ms)
{
    for(let i = 0; i < ms; i++)
    {
        host += 1;
        cpu.run_hardware_timers(false, cpu.clock.now());
    }
}

// --- PCI and the capability registers ----------------------------------------------

await test("PCI: UHCI companions 2934/2935/2936 at 00:1d.0-2 (INTA-C, function 0 multifunction), EHCI 293A at 00:1d.7 (0C/03/20, INTD, BAR0 4 KiB of memory, SBRN 2.0)", () => {
    [0x2934, 0x2935, 0x2936].forEach((device, i) => {
        const space = pci.space_bytes(UHCI[i]);
        assert.equal(space[2] | space[3] << 8, device);
        assert.equal(space[0x3D], i + 1);
    });
    assert.equal(pci.space_bytes(UHCI[0])[0x0E] & 0x80, 0x80);
    const space = pci.space_bytes(EHCI);
    assert.equal(space[2] | space[3] << 8, 0x293A);
    assert.deepEqual([space[0x0B], space[0x0A], space[0x09]], [0x0C, 0x03, 0x20]);
    assert.equal(space[0x3D], 4);
    assert.equal(space[0x60], 0x20);
    pci.config_write(EHCI, 0x10, 4, -1);
    assert.equal((space[0x10] | space[0x11] << 8 | space[0x12] << 16 | space[0x13] << 24) >>> 0, 0xFFFFF000);
    pci.config_write(EHCI, 0x10, 4, BAR);
    pci.config_write(EHCI, 0x04, 2, 0x0006);
    pci.config_write(UHCI[0], 0x20, 4, IO | 1);
    pci.config_write(UHCI[0], 0x04, 2, 0x0005);
});

await test("legacy support: USBLEGSUP at 0x68 (EECP); the OS taking ownership gets it at once", () => {
    const space = pci.space_bytes(EHCI);
    assert.equal(space[0x68], 0x01);
    pci.config_write(EHCI, 0x68, 4, 1 << 16);
    assert.equal(space[0x6A] & 1, 1, "the BIOS owns it");
    pci.config_write(EHCI, 0x68, 4, 1 << 16 | 1 << 24);
    assert.deepEqual([space[0x6A] & 1, space[0x6B] & 1], [0, 1]);
});

await test("capability registers: CAPLENGTH 0x20, HCIVERSION 1.0, 6 ports, 2 per companion, 3 companions; 64-bit, EECP 0x68", () => {
    assert.equal(r8(0), 0x20);
    assert.equal(r32(0) >>> 16, 0x0100);
    assert.equal(r32(4) & 0xFFFF, 6 | 2 << 8 | 3 << 12);
    assert.equal(r32(8) & 1, 1);
    assert.equal(r32(8) >> 8 & 0xFF, 0x68);
    assert.equal(r32(USBSTS) & HALTED, HALTED);
});

await test("before CONFIGFLAG every port is a companion's: the tablet and the disk on 00:1d.0's two ports", () => {
    assert.equal(uhci_r16(UHCI_PORTSC1) & UHCI_CCS, UHCI_CCS);
    assert.equal(uhci_r16(UHCI_PORTSC1 + 2) & UHCI_CCS, UHCI_CCS);
    assert.equal(r32(PORTSC(0)) & (CCS | PO | PP), PO | PP);
});

await test("CONFIGFLAG: the ports to the EHCI (the companion sees its devices leave), connected with J, a port change", () => {
    w32(USBINTR, USBINT | USBERRINT | PCD | IAA);
    w32(CONFIGFLAG, 1);
    assert.equal(uhci_r16(UHCI_PORTSC1) & (UHCI_CCS | UHCI_CSC), UHCI_CSC);
    for(const port of [0, 1]) assert.equal(r32(PORTSC(port)) & (CCS | CSC | PED | PO | LS), CCS | CSC | 2 << 10);
    assert.equal(r32(PORTSC(2)) & CCS, 0);
    assert.equal(r32(USBSTS) & PCD, PCD);
    assert.ok(pci.intx_levels[EHCI]);
    w32(USBSTS, PCD);
    assert.ok(!pci.intx_levels[EHCI]);
});

await test("port reset: the high-speed disk's port enabled; the full-speed tablet's not, then Port Owner gives it to its companion", () => {
    w32(PORTSC(1), CSC | PR);
    w32(PORTSC(1), 0);
    assert.equal(r32(PORTSC(1)) & (CCS | PED | PR), CCS | PED);
    w32(PORTSC(0), CSC | PR);
    w32(PORTSC(0), 0);
    assert.equal(r32(PORTSC(0)) & (CCS | PED), CCS);
    w32(PORTSC(0), PO);
    assert.equal(r32(PORTSC(0)) & (CCS | PO), PO);
    assert.equal(uhci_r16(UHCI_PORTSC1) & UHCI_CCS, UHCI_CCS, "the tablet on the companion");
    assert.equal(uhci_r16(UHCI_PORTSC1 + 2) & UHCI_CCS, 0, "the disk not");
});

await test("usb_devices: the tablet on a companion at 12 Mbit/s, the disk on the EHCI at 480", async () => {
    assert.deepEqual(await emulator.usb_devices(), [
        { id: "tablet", port: 0, plugged: true, controller: "uhci", speed: 12 },
        { id: "stick", port: 1, plugged: true, controller: "ehci", speed: 480 },
    ]);
});

// --- the asynchronous schedule ------------------------------------------------------

// queue heads, qTDs, buffers
const QH = 0x100000, QTDS = 0x101000, DATA = 0x200000;
/** A queue head of the ring of one: the endpoint, its speed (high), max packet */
function queue_head(address, endpoint, max_packet, control)
{
    put32(QH, QH | 2);
    put32(QH + 4, address | endpoint << 8 | 2 << 12 | (control ? 1 << 14 : 0) | 1 << 15 | max_packet << 16);
    put32(QH + 8, 1 << 30);
    for(let i = 3; i < 17; i++) put32(QH + 4 * i, 0);
    put32(QH + 16, 1);
}
/** qTDs (each [pid, length, buffer, toggle, ioc]) linked; the queue head's next the first */
function qtds(list, alternate = 1)
{
    list.forEach(([pid, length, buffer, toggle, ioc], i) =>
    {
        const at = QTDS + 64 * i;
        put32(at, i + 1 < list.length ? QTDS + 64 * (i + 1) : 1);
        put32(at + 4, alternate);
        put32(at + 8, (toggle ? 1 << 31 : 0) | length << 16 | (ioc ? TOKEN_IOC : 0) | 3 << 10 | pid << 8 | TOKEN_ACTIVE);
        for(let page = 0; page < 5; page++) put32(at + 12 + 4 * page, page ? (buffer & ~0xFFF) + 0x1000 * page : buffer);
        for(let page = 0; page < 5; page++) put32(at + 32 + 4 * page, 0);
    });
    put32(QH + 16, QTDS);
    put32(QH + 24, 0);
}
const token = i => u32(QTDS + 64 * i + 8);
const left = i => token(i) >>> 16 & 0x7FFF;
/** Run until the last qTD is done (or `ms`) */
function run(count, ms = 20)
{
    for(let i = 0; i < ms && token(count - 1) & TOKEN_ACTIVE && !(token(count - 1) & TOKEN_HALTED); i++)
    {
        advance(1);
        if(Array.from({ length: count }, (_, j) => token(j)).some(t => t & TOKEN_HALTED)) break;
    }
}
const setup = (type, request, value, index, length) => Uint8Array.of(type, request, value & 0xFF, value >> 8, index & 0xFF, index >> 8, length & 0xFF, length >> 8);
/** A control transfer: SETUP, the data stage in one qTD, the status stage */
function control(address, bytes)
{
    const length = bytes[6] | bytes[7] << 8, into = bytes[0] & 0x80;
    mem.set(bytes, DATA);
    queue_head(address, 0, 64, true);
    const list = [[SETUP, 8, DATA, 0, false]];
    if(length) list.push([into ? IN : OUT, length, DATA + 0x1000, 1, false]);
    list.push([into ? OUT : IN, 0, 0, 1, true]);
    qtds(list);
    run(list.length);
    const data_qtd = length ? 1 : -1;
    const moved = data_qtd > 0 ? length - left(1) : 0;
    return { data: mem.slice(DATA + 0x1000, DATA + 0x1000 + moved), tokens: list.map((_, i) => token(i)) };
}

await test("a control transfer on the asynchronous schedule: GET_DESCRIPTOR at address 0 (SETUP, IN, OUT); IOC: USBINT", () => {
    w32(ASYNCLISTADDR, QH);
    w32(USBCMD, RS | ASE | 8 << 16);
    assert.equal(r32(USBSTS) & (HALTED | ASS), ASS);
    const r = control(0, setup(0x80, 6, 0x0100, 0, 18));
    assert.equal(r.data.length, 18);
    assert.deepEqual([r.data[1], r.data[7], r.data[8] | r.data[9] << 8], [1, 64, 0x46F4]);
    assert.ok(r.tokens.every(t => !(t & (TOKEN_ACTIVE | TOKEN_HALTED))), r.tokens.map(t => t.toString(16)).join(" "));
    assert.equal(r32(USBSTS) & USBINT, USBINT);
    w32(USBSTS, USBINT);
});

await test("SET_ADDRESS, SET_CONFIGURATION; at high speed: bulk packets of 512 bytes, the qualifier the full speed's", () => {
    control(0, setup(0x00, 5, 5, 0, 0));
    const config = control(5, setup(0x80, 6, 0x0200, 0, 32)).data;
    assert.deepEqual([config[22] | config[23] << 8, config[29] | config[30] << 8], [512, 512]);
    assert.deepEqual(Array.from(control(5, setup(0x80, 6, 0x0600, 0, 10)).data), [10, 6, 0x00, 0x02, 0, 0, 0, 64, 1, 0]);
    const other = control(5, setup(0x80, 6, 0x0700, 0, 32)).data;
    assert.deepEqual([other[1], other[22] | other[23] << 8], [7, 64]);
    control(5, setup(0x00, 9, 1, 0, 0));
    assert.deepEqual(Array.from(control(5, setup(0x80, 8, 0, 0, 1)).data), [1]);
});

/** A bulk transfer in qTDs of up to 16 KiB */
function bulk(endpoint, pid, length, out = null)
{
    if(out) mem.set(out, DATA);
    queue_head(5, endpoint, 512, false);
    const list = [];
    for(let at = 0; at < length || !list.length; at += 16384) list.push([pid, Math.min(16384, length - at), DATA + at, 0, at + 16384 >= length]);
    qtds(list);
    run(list.length, 50);
    let moved = 0;
    list.forEach(([, n], i) => { moved += n - left(i); });
    return { data: mem.slice(DATA, DATA + moved), tokens: list.map((_, i) => token(i)) };
}
let tags = 0;
function scsi(cb, length = 0, direction_in = true, out = null)
{
    const cbw = new Uint8Array(31);
    const view = new DataView(cbw.buffer);
    view.setUint32(0, 0x43425355, true);
    view.setUint32(4, ++tags, true);
    view.setUint32(8, length, true);
    cbw[12] = direction_in ? 0x80 : 0;
    cbw[14] = cb.length;
    cbw.set(cb, 15);
    bulk(2, OUT, 31, cbw);
    const data = length ? bulk(direction_in ? 1 : 2, direction_in ? IN : OUT, length, out).data : null;
    const csw = bulk(1, IN, 13).data;
    const csw_view = new DataView(csw.buffer);
    assert.equal(csw_view.getUint32(4, true), tags);
    return { data, status: csw[12], residue: csw_view.getUint32(8, true) };
}
const read10 = (lba, count) => [0x28, 0, lba >>> 24, lba >> 16 & 0xFF, lba >> 8 & 0xFF, lba & 0xFF, 0, count >> 8, count & 0xFF, 0];
const write10 = (lba, count) => [0x2A, 0, lba >>> 24, lba >> 16 & 0xFF, lba >> 8 & 0xFF, lba & 0xFF, 0, count >> 8, count & 0xFF, 0];

await test("the USB disk on bulk endpoints: INQUIRY, READ(10) of 64 sectors (qTDs over pages), WRITE(10) of 100 sectors", () => {
    const inquiry = scsi([0x12, 0, 0, 0, 36, 0], 36);
    assert.equal(new TextDecoder().decode(inquiry.data.subarray(8, 16)), "v86     ");
    const read = scsi(read10(5, 64), 64 * 512);
    assert.equal(read.status, 0);
    assert.deepEqual(read.data, image.slice(5 * 512, 69 * 512));
    const data = new Uint8Array(100 * 512).map((_, i) => i * 7 + 3 & 0xFF);
    assert.equal(scsi(write10(200, 100), data.length, false, data).status, 0);
    assert.deepEqual(image.slice(200 * 512, 300 * 512), data);
});

await test("a short packet: the qTD ends with its bytes left, USBINT; the alternate next qTD goes on from it", () => {
    const cbw = new Uint8Array(31);
    new DataView(cbw.buffer).setUint32(0, 0x43425355, true);
    new DataView(cbw.buffer).setUint32(4, 99, true);
    cbw[12] = 0x80;
    cbw[14] = 6;
    cbw.set([0x00, 0, 0, 0, 0, 0], 15);
    bulk(2, OUT, 31, cbw);
    // the CSW into a qTD of 512: 13 bytes; its alternate next (index 2) taken, not its next (index 1)
    queue_head(5, 1, 512, false);
    w32(USBSTS, 0x3F);
    qtds([[IN, 512, DATA, 0, false], [IN, 512, DATA + 0x1000, 0, false], [IN, 0, DATA + 0x2000, 0, true]], QTDS + 128);
    advance(3);
    assert.equal(left(0), 512 - 13);
    assert.equal(token(0) & TOKEN_ACTIVE, 0);
    assert.equal(r32(USBSTS) & USBINT, USBINT);
    assert.equal(token(1) & TOKEN_ACTIVE, TOKEN_ACTIVE, "the next qTD not taken");
    assert.equal(u32(QH + 12), QTDS + 128, "the queue head's current qTD: the alternate one");
});

await test("STALL: an unknown descriptor halts the qTD (USBERRINT); a new SETUP goes on", () => {
    w32(USBSTS, 0x3F);
    const r = control(5, setup(0x80, 6, 0x5500, 0, 8));
    assert.ok(r.tokens.some(t => t & TOKEN_HALTED));
    assert.equal(r32(USBSTS) & USBERRINT, USBERRINT);
    assert.equal(control(5, setup(0x80, 8, 0, 0, 1)).data[0], 1);
});

await test("no device at the address: a transaction error, CERR down to 0, then halted", () => {
    const r = control(9, setup(0x80, 6, 0x0100, 0, 18));
    assert.equal(r.tokens[0] & (TOKEN_HALTED | TOKEN_XACTERR), TOKEN_HALTED | TOKEN_XACTERR);
});

await test("Interrupt on Async Advance: the doorbell answered at once (IAA, IAAD cleared)", () => {
    w32(USBSTS, 0x3F);
    w32(USBCMD, r32(USBCMD) | IAAD);
    assert.equal(r32(USBCMD) & IAAD, 0);
    assert.equal(r32(USBSTS) & IAA, IAA);
    w32(USBSTS, IAA);
});

await test("FRINDEX: 8 micro-frames a millisecond; the periodic schedule: an iTD skipped, a queue head by its S-mask", () => {
    const before = r32(FRINDEX);
    advance(4);
    assert.equal(r32(FRINDEX) - before & 0x3FFF, 32);
    // every frame: an iTD, then a queue head for address 9 (none there) in micro-frame 0
    const LIST = 0x300000, ITD = 0x301000, PQH = 0x302000;
    for(let i = 0; i < 1024; i++) put32(LIST + 4 * i, ITD);
    put32(ITD, PQH | 2);
    put32(PQH, 1);
    put32(PQH + 4, 9 | 1 << 8 | 2 << 12 | 8 << 16);
    put32(PQH + 8, 1 << 30 | 1);
    for(let i = 3; i < 17; i++) put32(PQH + 4 * i, 0);
    put32(PQH + 16, QTDS + 0x800);
    put32(QTDS + 0x800, 1);
    put32(QTDS + 0x804, 1);
    put32(QTDS + 0x808, 8 << 16 | 3 << 10 | IN << 8 | TOKEN_ACTIVE);
    w32(PERIODICLISTBASE, LIST);
    w32(USBCMD, r32(USBCMD) | PSE);
    assert.equal(r32(USBSTS) & PSS, PSS);
    advance(4);
    assert.equal(u32(QTDS + 0x808) & (TOKEN_ACTIVE | TOKEN_HALTED | TOKEN_XACTERR), TOKEN_HALTED | TOKEN_XACTERR, "three micro-frames' errors");
    w32(USBCMD, r32(USBCMD) & ~PSE);
});

// a disk whose reads come back later
const pending = [];
class SlowBuffer
{
    constructor() { this.bytes = new Uint8Array(512 * 256).map((_, i) => i * 5 & 0xFF); this.byteLength = this.bytes.length; this.onload = undefined; }
    load() { this.onload && this.onload({}); }
    get(start, length, fn) { pending.push(() => fn(this.bytes.slice(start, start + length))); }
    set(start, data, fn) { this.bytes.set(data, start); fn(); }
    get_state() { return []; }
    set_state() {}
}
await test("usb_attach_disk: the next free port (2), the EHCI's; a READ whose data comes later NAKs (the qTD stays active)", async () => {
    const slow = new SlowBuffer();
    await emulator.usb_attach_disk("slow", slow);
    assert.equal(r32(PORTSC(2)) & (CCS | CSC), CCS | CSC);
    w32(PORTSC(2), CSC | PR);
    w32(PORTSC(2), 0);
    assert.equal(r32(PORTSC(2)) & PED, PED);
    control(0, setup(0x00, 5, 6, 0, 0));
    control(6, setup(0x00, 9, 1, 0, 0));
    const cbw = new Uint8Array(31);
    const view = new DataView(cbw.buffer);
    view.setUint32(0, 0x43425355, true);
    view.setUint32(4, 7, true);
    view.setUint32(8, 4096, true);
    cbw[12] = 0x80;
    cbw[14] = 10;
    cbw.set(read10(3, 8), 15);
    mem.set(cbw, DATA);
    queue_head(6, 2, 512, false);
    qtds([[OUT, 31, DATA, 0, true]]);
    run(1);
    queue_head(6, 1, 512, false);
    qtds([[IN, 4096, DATA, 0, true]]);
    advance(5);
    assert.equal(token(0) & TOKEN_ACTIVE, TOKEN_ACTIVE, "waiting");
    assert.equal(left(0), 4096);
    pending.shift()();
    run(1);
    assert.equal(left(0), 0);
    assert.deepEqual(mem.slice(DATA, DATA + 4096), slow.bytes.slice(3 * 512, 11 * 512));
    queue_head(6, 1, 512, false);
    qtds([[IN, 13, DATA, 0, true]]);
    run(1);
    assert.equal(mem[DATA + 12], 0, "CSW: passed");
});

await test("usb_plug: the EHCI's disk out (CSC, PEDC) and back; the companion's tablet out gives the port back to the EHCI", async () => {
    await emulator.usb_plug("stick", false);
    assert.equal(r32(PORTSC(1)) & (CCS | CSC | PED | PEDC), CSC | PEDC);
    await emulator.usb_plug("stick", true);
    assert.equal(r32(PORTSC(1)) & (CCS | CSC), CCS | CSC);
    await emulator.usb_plug("tablet", false);
    assert.equal(uhci_r16(UHCI_PORTSC1) & UHCI_CCS, 0);
    assert.equal(r32(PORTSC(0)) & PO, 0, "the EHCI's again");
    await emulator.usb_plug("tablet", true);
    assert.equal(r32(PORTSC(0)) & (CCS | CSC), CCS | CSC, "seen by the EHCI first");
});

await test("a snapshot: the registers, the ports and their owners, the companions; the disk goes on reading", async () => {
    // the tablet to its companion again; the disk enabled again at address 5
    w32(PORTSC(0), CSC | PR);
    w32(PORTSC(0), 0);
    w32(PORTSC(0), PO);
    w32(PORTSC(1), CSC | PR);
    w32(PORTSC(1), 0);
    control(0, setup(0x00, 5, 5, 0, 0));
    control(5, setup(0x00, 9, 1, 0, 0));
    const state = await emulator.save_state();
    w32(CONFIGFLAG, 0);
    await emulator.restore_state(state);
    assert.equal(r32(CONFIGFLAG), 1);
    assert.equal(r32(PORTSC(0)) & PO, PO);
    assert.equal(r32(PORTSC(1)) & (CCS | PED), CCS | PED);
    assert.equal(uhci_r16(UHCI_PORTSC1) & UHCI_CCS, UHCI_CCS, "the tablet on its companion");
    assert.deepEqual(scsi(read10(5, 1), 512).data, image.slice(5 * 512, 6 * 512));
});

await test("CONFIGFLAG cleared: every device to the companions; HCRESET: halted, the ports the companions'", () => {
    w32(CONFIGFLAG, 0);
    assert.equal(r32(PORTSC(1)) & (CCS | PO), PO);
    assert.equal(uhci_r16(UHCI_PORTSC1 + 2) & UHCI_CCS, UHCI_CCS, "the disk on the companion");
    w32(USBCMD, HCRESET);
    assert.equal(r32(USBSTS) & HALTED, HALTED);
    assert.equal(r32(USBCMD) & RS, 0);
    assert.equal(r32(PORTSC(1)) & PO, PO);
});

{
    const pc = await machine("i440fx");
    const space = n => pc.v86.cpu.devices.pci.space_bytes(0x06 << 3 | n);
    await test("i440FX: the EHCI at 00:06.7, its companions at 00:06.0-2", () => {
        assert.equal(space(7)[2] | space(7)[3] << 8, 0x293A);
        assert.equal(space(0)[2] | space(0)[3] << 8, 0x2934);
        assert.equal(space(2)[2] | space(2)[3] << 8, 0x2936);
    });
    await pc.destroy();
}

await emulator.destroy();
console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
