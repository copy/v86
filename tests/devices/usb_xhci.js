#!/usr/bin/env node

// xHCI (usb.controller "xhci", src/usb/xhci.js, docs/usb.md): QEMU's
// qemu-xhci, driven through its registers and its rings and contexts in
// guest memory, no guest code; the test moves the machine clock
// (docs/modern-pc-devices-plan.md U4). The PCI function and its
// capabilities, the capability registers and the extended capabilities
// (legacy support, the two supported protocols), the ports (the SuperSpeed
// USB disk on a USB 3 root port, enabled at once; the full-speed tablet on
// a USB 2 one, enabled by a reset), the command ring (slots, Address Device
// with and without BSR, Configure Endpoint, Evaluate Context, Stop and Reset
// Endpoint, Set TR Dequeue Pointer, Reset Device, no-op, errors), the
// transfer rings (control transfers at SuperSpeed: the device and BOS
// descriptors; BOT on bulk endpoints of 1024 bytes over TDs of several
// TRBs, a short packet with ISP, Event Data, STALL; the tablet's interrupt
// endpoint), the event ring (cycle bits, its wrap, EHB, INTx and MSI),
// Port Status Change Events, hot plug, snapshots, HCRST.

import assert from "node:assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const SECTORS = 8192;
const pattern = i => (i * 13 + (i >> 9)) & 0xFF;
const image = new Uint8Array(SECTORS * 512).map((_, i) => pattern(i));

let host = 1000;
const options = machine_type => ({
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    memory_size: 64 * 1024 * 1024,
    machine_type,
    acpi: machine_type === "q35",
    usb: { controller: "xhci", tablet: true, mass_storage: [{ id: "stick", image: { buffer: image.buffer } }] },
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
const XHCI = 0x14 << 3;
const BAR = 0xC0000000;

const r32 = offset => cpu.mmap_read32(BAR + offset) >>> 0;
const r8 = offset => cpu.mmap_read8(BAR + offset);
const w32 = (offset, value) => cpu.mmap_write32(BAR + offset, value | 0);
const u32 = a => (mem[a] | mem[a + 1] << 8 | mem[a + 2] << 16 | mem[a + 3] << 24) >>> 0;
const put32 = (a, v) => { mem[a] = v; mem[a + 1] = v >> 8; mem[a + 2] = v >> 16; mem[a + 3] = v >>> 24; };
const irq = () => !!pci.intx_levels[XHCI];

const OP = 0x40, USBCMD = OP, USBSTS = OP + 4, CRCR = OP + 0x18, DCBAAP = OP + 0x30, CONFIG = OP + 0x38;
const PORTSC = port => OP + 0x400 + 0x10 * (port - 1);
const RT = 0x1000, IMAN = RT + 0x20, ERSTSZ = RT + 0x28, ERSTBA = RT + 0x30, ERDP = RT + 0x38;
const DB = target => 0x2000 + 4 * target;
const RS = 1, HCRST = 2, INTE = 4;
const HCH = 1, EINT = 8, PCD = 16;
const CCS = 1, PED = 2, PR = 1 << 4, PLS = 0xF << 5, SPEED = 0xF << 10, CSC = 1 << 17, PRC = 1 << 21;
const NORMAL = 1, SETUP = 2, DATA = 3, STATUS = 4, LINK = 6, EVENT_DATA = 7, ENABLE_SLOT = 9, DISABLE_SLOT = 10, ADDRESS_DEVICE = 11,
    CONFIGURE_ENDPOINT = 12, EVALUATE_CONTEXT = 13, RESET_ENDPOINT = 14, STOP_ENDPOINT = 15, SET_TR_DEQUEUE = 16, RESET_DEVICE = 17,
    NOOP_COMMAND = 23, TRANSFER_EVENT = 32, COMMAND_EVENT = 33, PORT_EVENT = 34;
const CYCLE = 1, TC = 2, ISP = 4, CH = 16, IOC = 32, IDT = 64, DIR_IN = 1 << 16;
const SUCCESS = 1, STALL_ERROR = 6, SHORT_PACKET = 13, CONTEXT_STATE = 19, TRB_ERROR = 5, STOPPED = 26;

/** Move the machine clock on and run the machine's timers */
function advance(ms)
{
    for(let i = 0; i < ms; i++)
    {
        host += 1;
        cpu.run_hardware_timers(false, cpu.clock.now());
    }
}

// guest memory: the DCBAA, the command ring, the event ring and its ERST,
// input contexts, output contexts, transfer rings, data
const DCBAA = 0x100000, COMMANDS = 0x101000, EVENTS = 0x102000, ERST = 0x103000, INPUT = 0x104000, OUTPUT = 0x110000,
    RINGS = 0x200000, BUFFER = 0x800000;
const EVENT_TRBS = 32;

/** A ring the test writes: TRBs, a Link TRB (toggle cycle) at its end */
class Ring
{
    constructor(base, size) { this.base = base; this.size = size; this.index = 0; this.cycle = 1; }
    push(low, high, status, control)
    {
        if(this.index === this.size - 1)
        {
            // (a Link TRB back to the start, toggling the cycle)
            this.write(this.base + 16 * this.index, this.base, 0, 0, LINK << 10 | TC);
            this.index = 0;
            this.cycle ^= 1;
        }
        const at = this.base + 16 * this.index;
        this.write(at, low, high, status, control);
        this.index++;
        return at;
    }
    write(target, low, high, status, control)
    {
        put32(target, low);
        put32(target + 4, high);
        put32(target + 8, status || 0);
        put32(target + 12, (control & ~CYCLE | this.cycle) >>> 0);
    }
}

let commands, events_index = 0, events_cycle = 1;
/** The events the controller wrote since, the dequeue pointer moved past them (EHB cleared) */
function events()
{
    const list = [];
    for(;;)
    {
        const at = EVENTS + 16 * events_index;
        const control = u32(at + 12);
        if((control & 1) !== events_cycle) break;
        list.push({ at, low: u32(at), high: u32(at + 4), status: u32(at + 8), control, type: control >> 10 & 0x3F, code: u32(at + 8) >>> 24,
            slot: control >>> 24, dci: control >> 16 & 0x1F, length: u32(at + 8) & 0xFFFFFF });
        events_index++;
        if(events_index === EVENT_TRBS) { events_index = 0; events_cycle ^= 1; }
    }
    w32(ERDP, EVENTS + 16 * events_index | 8);
    w32(ERDP + 4, 0);
    return list;
}
/** A command: its completion event */
function command(type, low = 0, high = 0, control = 0)
{
    const at = commands.push(low, high, 0, type << 10 | control);
    w32(DB(0), 0);
    const list = events().filter(e => e.type === COMMAND_EVENT);
    assert.equal(list.length, 1, "one completion");
    assert.equal(list[0].low, at, "for the command");
    return list[0];
}

// --- PCI, the registers -------------------------------------------------------------

await test("PCI: QEMU's qemu-xhci (1B36:000D, 0C/03/30) at 00:14.0, INTA; BAR0 16 KiB of memory; PM and MSI; SBRN 3.0", () => {
    const space = pci.space_bytes(XHCI);
    assert.equal(space[0] | space[1] << 8, 0x1B36);
    assert.equal(space[2] | space[3] << 8, 0x000D);
    assert.deepEqual([space[0x0B], space[0x0A], space[0x09]], [0x0C, 0x03, 0x30]);
    assert.equal(space[0x3D], 1);
    assert.equal(space[0x60], 0x30);
    assert.deepEqual([space[0x34], space[0x50], space[0x51], space[0x70]], [0x50, 0x01, 0x70, 0x05]);
    pci.config_write(XHCI, 0x10, 4, -1);
    assert.equal((space[0x10] | space[0x11] << 8 | space[0x12] << 16 | space[0x13] << 24) >>> 0, 0xFFFFC000);
    pci.config_write(XHCI, 0x10, 4, BAR);
    pci.config_write(XHCI, 0x04, 2, 0x0006);
});

await test("capability registers: CAPLENGTH 0x40, 1.0, 32 slots, 1 interrupter, 8 ports; 64-bit; doorbells, runtime; extended capabilities", () => {
    assert.equal(r8(0), 0x40);
    assert.equal(r32(0) >>> 16, 0x0100);
    assert.equal(r32(4), 32 | 1 << 8 | 8 << 24);
    assert.equal(r32(0x10) & 1, 1);
    assert.equal(r32(0x14), 0x2000);
    assert.equal(r32(0x18), 0x1000);
    const xecp = (r32(0x10) >>> 16) * 4;
    // legacy support, then the supported protocols: USB 3 ports 1-4, USB 2 ports 5-8
    assert.equal(r32(xecp) & 0xFF, 1);
    const usb3 = xecp + 4 * (r32(xecp) >> 8 & 0xFF);
    assert.deepEqual([r32(usb3) & 0xFF, r32(usb3) >>> 24, r32(usb3 + 4), r32(usb3 + 8) & 0xFFFF], [2, 3, 0x20425355, 1 | 4 << 8]);
    const usb2 = usb3 + 4 * (r32(usb3) >> 8 & 0xFF);
    assert.deepEqual([r32(usb2) & 0xFF, r32(usb2) >>> 24, r32(usb2 + 8) & 0xFFFF], [2, 2, 5 | 4 << 8]);
    assert.equal(r32(usb2) >> 8 & 0xFF, 0, "the last");
    // the OS taking the controller: the BIOS lets go at once
    w32(xecp, 1 << 24);
    assert.equal(r32(xecp) & (1 << 16 | 1 << 24), 1 << 24);
});

await test("ports: the SuperSpeed disk on USB 3 port 2, enabled (U0, speed 4); the full-speed tablet on USB 2 port 5, polling", () => {
    assert.equal(r32(USBSTS) & HCH, HCH);
    assert.equal(r32(PORTSC(2)) & (CCS | PED | PLS | SPEED), CCS | PED | 0 << 5 | 4 << 10);
    assert.equal(r32(PORTSC(5)) & (CCS | PED | PLS | SPEED), CCS | 7 << 5 | 1 << 10);
    assert.equal(r32(PORTSC(1)) & CCS, 0);
    assert.equal(r32(PORTSC(6)) & CCS, 0, "the disk not on its USB 2 port");
    assert.equal(r32(PORTSC(2)) & CSC, CSC);
});

await test("running: the command ring, the event ring (one segment), interrupts on; a no-op command completes (an event, IP, EINT, INTA)", () => {
    for(let i = 0; i < 33; i++) { put32(DCBAA + 8 * i, 0); put32(DCBAA + 8 * i + 4, 0); }
    w32(DCBAAP, DCBAA);
    w32(DCBAAP + 4, 0);
    w32(CONFIG, 32);
    commands = new Ring(COMMANDS, 16);
    w32(CRCR, COMMANDS | 1);
    w32(CRCR + 4, 0);
    put32(ERST, EVENTS);
    put32(ERST + 4, 0);
    put32(ERST + 8, EVENT_TRBS);
    mem.fill(0, EVENTS, EVENTS + 16 * EVENT_TRBS);
    w32(ERSTSZ, 1);
    w32(ERDP, EVENTS);
    w32(ERDP + 4, 0);
    w32(ERSTBA, ERST);
    w32(ERSTBA + 4, 0);
    w32(IMAN, 2);
    w32(USBCMD, RS | INTE);
    assert.equal(r32(USBSTS) & HCH, 0);
    const done = command(NOOP_COMMAND);
    assert.equal(done.code, SUCCESS);
    assert.ok(irq());
    assert.equal(r32(USBSTS) & EINT, EINT);
    w32(IMAN, 3);
    w32(USBSTS, EINT);
    assert.ok(!irq());
});

await test("a port change while running: its Port Status Change Event (port, PCD); a USB 2 reset enables the tablet's port (PRC)", () => {
    w32(PORTSC(5), PR);
    const list = events();
    assert.deepEqual(list.map(e => [e.type, e.low >>> 24]), [[PORT_EVENT, 5]]);
    assert.equal(r32(PORTSC(5)) & (PED | PLS | PRC), PED | PRC);
    assert.equal(r32(USBSTS) & PCD, PCD);
    w32(PORTSC(5), PRC | CSC);
    w32(PORTSC(2), CSC);
    assert.equal(r32(PORTSC(5)) & (PRC | CSC), 0);
    w32(USBSTS, PCD);
});

// slots, contexts, transfer rings
const ring_of = new Map();
/** The transfer ring of a slot's endpoint */
function ring(slot, dci)
{
    const key = slot + ":" + dci;
    if(!ring_of.has(key)) ring_of.set(key, new Ring(RINGS + (slot * 32 + dci) * 0x400, 64));
    return ring_of.get(key);
}
/** An input context: the add flags, the slot context, endpoint contexts by DCI ([type, max packet, interval]) */
function input(add, slot_words, endpoints = {})
{
    mem.fill(0, INPUT, INPUT + 32 * 33);
    put32(INPUT + 4, add);
    slot_words.forEach((w, i) => put32(INPUT + 32 + 4 * i, w));
    for(const [dci, [type, max_packet, interval]] of Object.entries(endpoints))
    {
        const at = INPUT + 32 * (+dci + 1);
        const r = ring(current_slot, +dci);
        put32(at, interval << 16);
        put32(at + 4, 3 << 1 | type << 3 | max_packet << 16);
        put32(at + 8, r.base + 16 * r.index | r.cycle);
        put32(at + 12, 0);
        put32(at + 16, 8);
    }
    return INPUT;
}
let current_slot = 0;
const output = slot => OUTPUT + 0x1000 * slot;
const slot_state = slot => u32(output(slot) + 12) >>> 27;
const endpoint_state = (slot, dci) => u32(output(slot) + 32 * dci) & 7;
/** Enable a slot for a root port and address its device */
function new_device(port, speed, bsr = false)
{
    const enabled = command(ENABLE_SLOT);
    assert.equal(enabled.code, SUCCESS);
    const slot = current_slot = enabled.slot;
    mem.fill(0, output(slot), output(slot) + 0x400);
    put32(DCBAA + 8 * slot, output(slot));
    const address = command(ADDRESS_DEVICE, input(3, [speed << 20 | 1 << 27, port << 16, 0, 0], { 1: [4, speed === 4 ? 512 : 64, 0] }), 0,
        slot << 24 | (bsr ? 1 << 9 : 0));
    return { slot, code: address.code };
}
/** A control transfer on endpoint 0: Setup, Data (IN), Status; the data and the events */
function control(slot, setup_bytes, length, extra = 0)
{
    const r = ring(slot, 1);
    const low = setup_bytes[0] | setup_bytes[1] << 8 | setup_bytes[2] << 16 | setup_bytes[3] << 24;
    const high = setup_bytes[4] | setup_bytes[5] << 8 | setup_bytes[6] << 16 | setup_bytes[7] << 24;
    const into = setup_bytes[0] & 0x80;
    r.push(low, high, 8, SETUP << 10 | IDT | (length ? (into ? 3 : 2) << 16 : 0));
    if(length) r.push(BUFFER, 0, length, DATA << 10 | ISP | (into ? DIR_IN : 0) | extra);
    r.push(0, 0, 0, STATUS << 10 | IOC | (into && length ? 0 : DIR_IN));
    w32(DB(slot), 1);
    advance(2);
    const list = events().filter(e => e.type === TRANSFER_EVENT);
    const short = list.find(e => e.code === SHORT_PACKET);
    return { data: mem.slice(BUFFER, BUFFER + length - (short ? short.length : 0)), events: list };
}
const setup = (type, request, value, index, length) => [type, request, value & 0xFF, value >> 8, index & 0xFF, index >> 8, length & 0xFF, length >> 8];

let disk;
await test("Enable Slot, Address Device (the USB 3 port): the slot Addressed at its ID, endpoint 0 running; GET_DESCRIPTOR: USB 3, 2^9", () => {
    disk = new_device(2, 4);
    assert.equal(disk.code, SUCCESS);
    assert.equal(slot_state(disk.slot), 2);
    assert.equal(u32(output(disk.slot) + 12) & 0xFF, disk.slot, "the device's address");
    assert.equal(endpoint_state(disk.slot, 1), 1);
    const device = control(disk.slot, setup(0x80, 6, 0x0100, 0, 18), 18);
    assert.deepEqual([device.data[2] | device.data[3] << 8, device.data[7], device.data[8] | device.data[9] << 8], [0x0300, 9, 0x46F4]);
    assert.deepEqual(device.events.map(e => [e.code, e.slot, e.dci]), [[SUCCESS, disk.slot, 1]]);
});

await test("SuperSpeed descriptors: the BOS (USB 2.0 extension, SuperSpeed capability), the configuration (bulk 1024, companions); no device qualifier", () => {
    const bos = control(disk.slot, setup(0x80, 6, 0x0F00, 0, 22), 22).data;
    assert.deepEqual([bos[1], bos[2], bos[4], bos[7], bos[14]], [0x0F, 22, 2, 2, 3]);
    const config = control(disk.slot, setup(0x80, 6, 0x0200, 0, 44), 44).data;
    assert.equal(config.length, 44);
    assert.deepEqual([config[18 + 4] | config[18 + 5] << 8, config[25 + 1], config[31 + 4] | config[31 + 5] << 8, config[38 + 1]], [1024, 0x30, 1024, 0x30]);
    const qualifier = control(disk.slot, setup(0x80, 6, 0x0600, 0, 10), 10);
    assert.deepEqual(qualifier.events.map(e => e.code), [STALL_ERROR], "STALL");
    assert.equal(endpoint_state(disk.slot, 1), 2, "endpoint 0 halted");
    assert.equal(command(RESET_ENDPOINT, 0, 0, disk.slot << 24 | 1 << 16).code, SUCCESS);
    assert.equal(endpoint_state(disk.slot, 1), 3, "stopped");
    // (the ring on past the failed TD: Set TR Dequeue Pointer)
    const r = ring(disk.slot, 1);
    assert.equal(command(SET_TR_DEQUEUE, r.base + 16 * r.index | r.cycle, 0, disk.slot << 24 | 1 << 16).code, SUCCESS);
    // SET_ISOCH_DELAY and SET_CONFIGURATION
    assert.deepEqual(control(disk.slot, setup(0x00, 0x31, 40, 0, 0), 0).events.map(e => e.code), [SUCCESS]);
    assert.deepEqual(control(disk.slot, setup(0x00, 9, 1, 0, 0), 0).events.map(e => e.code), [SUCCESS]);
});

await test("Configure Endpoint: bulk IN (DCI 3) and OUT (DCI 4) running, the slot Configured; Evaluate Context: endpoint 0's max packet", () => {
    const done = command(CONFIGURE_ENDPOINT, input(1 | 1 << 3 | 1 << 4, [4 << 20 | 4 << 27, 2 << 16, 0, 0], { 3: [6, 1024, 0], 4: [2, 1024, 0] }), 0,
        disk.slot << 24);
    assert.equal(done.code, SUCCESS);
    assert.equal(slot_state(disk.slot), 3);
    assert.deepEqual([endpoint_state(disk.slot, 3), endpoint_state(disk.slot, 4)], [1, 1]);
    assert.equal(u32(output(disk.slot)) >>> 27, 4, "context entries");
    mem.fill(0, INPUT, INPUT + 96);
    put32(INPUT + 4, 2);
    put32(INPUT + 64 + 4, 512 << 16);
    assert.equal(command(EVALUATE_CONTEXT, INPUT, 0, disk.slot << 24).code, SUCCESS);
    assert.equal(u32(output(disk.slot) + 32 + 4) >>> 16, 512);
});

let tags = 0;
/** A bulk transfer in Normal TRBs of up to 16 KiB (ISP; IOC on the last): its events */
function bulk(dci, length, out = null, event_data = false)
{
    if(out) mem.set(out, BUFFER);
    const r = ring(disk.slot, dci);
    for(let at = 0; at < length || at === 0 && length === 0; at += 16384)
    {
        const n = Math.min(16384, length - at), last = at + 16384 >= length;
        r.push(BUFFER + at, 0, n, NORMAL << 10 | ISP | (last && !event_data ? IOC : CH));
        if(length === 0) break;
    }
    if(event_data) r.push(0x12345678, 0x9ABC, 0, EVENT_DATA << 10 | IOC);
    w32(DB(disk.slot), dci);
    for(let i = 0; i < 100 && !events_pending(); i++) advance(1);
    return events().filter(e => e.type === TRANSFER_EVENT);
}
function events_pending()
{
    return (u32(EVENTS + 16 * events_index + 12) & 1) === events_cycle;
}
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
    assert.deepEqual(bulk(4, 31, cbw).map(e => e.code), [SUCCESS], "the CBW");
    let data = null;
    if(length)
    {
        const list = bulk(direction_in ? 3 : 4, length, out);
        assert.ok(list.length && list.every(e => e.code === SUCCESS || e.code === SHORT_PACKET), JSON.stringify(list));
        data = mem.slice(BUFFER, BUFFER + length);
    }
    const csw = bulk(3, 13);
    assert.deepEqual(csw.map(e => e.code), [SUCCESS]);
    return { data, status: mem[BUFFER + 12], tag: u32(BUFFER + 4) };
}
const read10 = (lba, count) => [0x28, 0, lba >>> 24, lba >> 16 & 0xFF, lba >> 8 & 0xFF, lba & 0xFF, 0, count >> 8, count & 0xFF, 0];
const write10 = (lba, count) => [0x2A, 0, lba >>> 24, lba >> 16 & 0xFF, lba >> 8 & 0xFF, lba & 0xFF, 0, count >> 8, count & 0xFF, 0];

await test("the USB disk at SuperSpeed: INQUIRY, READ(10) of 96 sectors (TDs of several TRBs), WRITE(10) of 100 sectors", () => {
    const inquiry = scsi([0x12, 0, 0, 0, 36, 0], 36);
    assert.equal(inquiry.tag, tags);
    assert.equal(new TextDecoder().decode(inquiry.data.subarray(8, 16)), "v86     ");
    const read = scsi(read10(9, 96), 96 * 512);
    assert.equal(read.status, 0);
    assert.deepEqual(read.data, image.slice(9 * 512, 105 * 512));
    const data = new Uint8Array(100 * 512).map((_, i) => i * 3 + 1 & 0xFF);
    assert.equal(scsi(write10(300, 100), data.length, false, data).status, 0);
    assert.deepEqual(image.slice(300 * 512, 400 * 512), data);
});

await test("a short packet: the CSW into a TRB of 512 (ISP): Short Packet, the bytes left; Event Data: its parameter and the bytes so far (ED)", () => {
    const cbw = new Uint8Array(31);
    new DataView(cbw.buffer).setUint32(0, 0x43425355, true);
    new DataView(cbw.buffer).setUint32(4, 77, true);
    cbw[14] = 6;
    assert.deepEqual(bulk(4, 31, cbw).map(e => e.code), [SUCCESS]);
    const short = bulk(3, 512);
    assert.deepEqual(short.map(e => [e.code, e.length]), [[SHORT_PACKET, 512 - 13]]);
    // INQUIRY's data with an Event Data TRB after its Normal TRB
    const inquiry = new Uint8Array(31);
    new DataView(inquiry.buffer).setUint32(0, 0x43425355, true);
    new DataView(inquiry.buffer).setUint32(4, 78, true);
    new DataView(inquiry.buffer).setUint32(8, 36, true);
    inquiry[12] = 0x80;
    inquiry[14] = 6;
    inquiry.set([0x12, 0, 0, 0, 36, 0], 15);
    bulk(4, 31, inquiry);
    const list = bulk(3, 36, null, true);
    assert.deepEqual(list.map(e => [e.code, e.low, e.high, e.length, e.control >> 2 & 1]), [[SUCCESS, 0x12345678, 0x9ABC, 36, 1]]);
    assert.deepEqual(bulk(3, 13).map(e => e.code), [SUCCESS]);
});

await test("STALL on bulk (a command past the end... with a CBW that is not one): the endpoint halts; Reset Endpoint, Set TR Dequeue; on", () => {
    // an invalid CBW: both bulk endpoints STALL until the reset recovery
    const bad = new Uint8Array(31);
    bulk(4, 31, bad);
    const stalled = bulk(3, 13);
    assert.deepEqual(stalled.map(e => e.code), [STALL_ERROR]);
    assert.equal(endpoint_state(disk.slot, 3), 2);
    assert.equal(command(RESET_ENDPOINT, 0, 0, disk.slot << 24 | 3 << 16).code, SUCCESS);
    assert.equal(command(RESET_ENDPOINT, 0, 0, disk.slot << 24 | 3 << 16).code, CONTEXT_STATE, "only a halted one");
    const r = ring(disk.slot, 3);
    assert.equal(command(SET_TR_DEQUEUE, r.base + 16 * r.index | r.cycle, 0, disk.slot << 24 | 3 << 16).code, SUCCESS);
    // the reset recovery: BOT reset, CLEAR_FEATURE(ENDPOINT_HALT) of both
    control(disk.slot, setup(0x21, 0xFF, 0, 0, 0), 0);
    control(disk.slot, setup(0x02, 1, 0, 0x81, 0), 0);
    control(disk.slot, setup(0x02, 1, 0, 0x02, 0), 0);
    assert.equal(endpoint_state(disk.slot, 4), 1, "OUT running");
    assert.equal(scsi([0x00, 0, 0, 0, 0, 0]).status, 0);
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
let slow;
await test("Stop Endpoint with a TD the device NAKs: a Transfer Event (Stopped) at its TRB, the endpoint stopped; the ring from there again", async () => {
    await emulator.usb_attach_disk("slow", new SlowBuffer());
    // (the next free port: physical port 2, USB 3 root port 3)
    assert.equal(r32(PORTSC(3)) & (CCS | PED), CCS | PED);
    events();
    slow = new_device(3, 4);
    assert.equal(slow.code, SUCCESS);
    control(slow.slot, setup(0x00, 9, 1, 0, 0), 0);
    command(CONFIGURE_ENDPOINT, input(1 | 1 << 3 | 1 << 4, [4 << 20 | 4 << 27, 3 << 16, 0, 0], { 3: [6, 1024, 0], 4: [2, 1024, 0] }), 0, slow.slot << 24);
    const cbw = new Uint8Array(31);
    const view = new DataView(cbw.buffer);
    view.setUint32(0, 0x43425355, true);
    view.setUint32(4, 5, true);
    view.setUint32(8, 4096, true);
    cbw[12] = 0x80;
    cbw[14] = 10;
    cbw.set(read10(2, 8), 15);
    mem.set(cbw, BUFFER);
    ring(slow.slot, 4).push(BUFFER, 0, 31, NORMAL << 10 | IOC);
    w32(DB(slow.slot), 4);
    advance(2);
    assert.deepEqual(events().map(e => e.code), [SUCCESS]);
    const trb = ring(slow.slot, 3).push(BUFFER, 0, 4096, NORMAL << 10 | ISP | IOC);
    w32(DB(slow.slot), 3);
    advance(5);
    assert.deepEqual(events(), [], "waiting: NAK");
    const stopped = command(STOP_ENDPOINT, 0, 0, slow.slot << 24 | 3 << 16);
    assert.equal(stopped.code, SUCCESS);
    // (the Transfer Event came before the command's completion)
    assert.equal(endpoint_state(slow.slot, 3), 3);
    assert.equal(u32(output(slow.slot) + 32 * 3 + 8) & ~0xF, trb, "the dequeue pointer at its TRB");
    // started again: the data, once it is there
    w32(DB(slow.slot), 3);
    pending.shift()();
    advance(3);
    const list = events();
    assert.deepEqual(list.map(e => e.code), [SUCCESS]);
});

await test("a command for a slot not enabled, an unknown command: their completion codes", () => {
    assert.equal(command(RESET_DEVICE, 0, 0, 31 << 24).code, 11);
    assert.equal(command(50).code, TRB_ERROR);
});

let tablet;
await test("the tablet on its USB 2 port: Address Device with BSR, then without; its interrupt endpoint's reports from the page's pointer", () => {
    tablet = new_device(5, 1, true);
    assert.equal(tablet.code, SUCCESS);
    assert.equal(slot_state(tablet.slot), 1, "Default (BSR)");
    const again = command(ADDRESS_DEVICE, input(3, [1 << 20 | 1 << 27, 5 << 16, 0, 0], { 1: [4, 8, 0] }), 0, tablet.slot << 24);
    assert.equal(again.code, SUCCESS);
    assert.equal(slot_state(tablet.slot), 2);
    const device = control(tablet.slot, setup(0x80, 6, 0x0100, 0, 18), 18);
    assert.equal(device.data[8] | device.data[9] << 8, 0x0627);
    control(tablet.slot, setup(0x00, 9, 1, 0, 0), 0);
    command(CONFIGURE_ENDPOINT, input(1 | 1 << 3, [1 << 20 | 3 << 27, 5 << 16, 0, 0], { 3: [7, 8, 3] }), 0, tablet.slot << 24);
    events();
    // a report: the pointer moved
    ring(tablet.slot, 3).push(BUFFER, 0, 8, NORMAL << 10 | ISP | IOC);
    w32(DB(tablet.slot), 3);
    advance(2);
    events();
    emulator.bus.send("mouse-absolute", [100, 50, 400, 200]);
    ring(tablet.slot, 3).push(BUFFER, 0, 8, NORMAL << 10 | ISP | IOC);
    w32(DB(tablet.slot), 3);
    advance(3);
    const list = events();
    assert.deepEqual(list.map(e => [e.code, e.length]), [[SHORT_PACKET, 2]], "six bytes into eight");
    assert.equal(mem[BUFFER + 1] | mem[BUFFER + 2] << 8, Math.round(100.5 / 400 * 32767));
});

await test("usb_devices: the tablet at 12 Mbit/s, the disks at 5000, all on the xHCI", async () => {
    assert.deepEqual((await emulator.usb_devices()).map(d => [d.id, d.controller, d.speed]), [["tablet", "xhci", 12], ["stick", "xhci", 5000],
        ["slow", "xhci", 5000]]);
});

await test("hot plug: the disk out (CSC, a Port Status Change Event; its transfers fail), back in", async () => {
    await emulator.usb_plug("stick", false);
    const list = events();
    assert.deepEqual(list.map(e => [e.type, e.low >>> 24]), [[PORT_EVENT, 2]]);
    assert.equal(r32(PORTSC(2)) & (CCS | CSC), CSC);
    await emulator.usb_plug("stick", true);
    assert.equal(r32(PORTSC(2)) & (CCS | PED), CCS | PED);
    assert.deepEqual(events().map(e => e.type), [PORT_EVENT]);
    w32(PORTSC(2), CSC);
    // a new slot for it
    assert.equal(command(DISABLE_SLOT, 0, 0, disk.slot << 24).code, SUCCESS);
    disk = new_device(2, 4);
    assert.equal(disk.code, SUCCESS);
    control(disk.slot, setup(0x00, 9, 1, 0, 0), 0);
    command(CONFIGURE_ENDPOINT, input(1 | 1 << 3 | 1 << 4, [4 << 20 | 4 << 27, 2 << 16, 0, 0], { 3: [6, 1024, 0], 4: [2, 1024, 0] }), 0, disk.slot << 24);
    assert.deepEqual(scsi(read10(1, 1), 512).data, image.slice(512, 1024));
});

await test("a snapshot: the registers, rings, slots and endpoints; the disk goes on reading after it", async () => {
    const state = await emulator.save_state();
    const saved = [events_index, events_cycle, new Map(Array.from(ring_of, ([k, r]) => [k, [r.index, r.cycle]])), commands.index, commands.cycle, tags];
    assert.deepEqual(scsi(read10(20, 2), 1024).data, image.slice(20 * 512, 22 * 512));
    await emulator.restore_state(state);
    [events_index, events_cycle] = saved;
    for(const [k, [index, cycle]] of saved[2]) Object.assign(ring_of.get(k), { index, cycle });
    commands.index = saved[3];
    commands.cycle = saved[4];
    tags = saved[5];
    assert.equal(r32(USBSTS) & HCH, 0);
    assert.deepEqual(scsi(read10(30, 2), 1024).data, image.slice(30 * 512, 32 * 512));
});

await test("the event ring wraps (its cycle bit); a full ring drops events", () => {
    // more completions than the ring has entries, read as they come
    for(let i = 0; i < EVENT_TRBS + 5; i++) assert.equal(command(NOOP_COMMAND).code, SUCCESS);
    // the driver not reading: the ring fills, the last entry an Event Ring Full Error, then nothing
    for(let i = 0; i < EVENT_TRBS + 4; i++)
    {
        commands.push(0, 0, 0, NOOP_COMMAND << 10);
        w32(DB(0), 0);
    }
    const list = events();
    assert.equal(list.length, EVENT_TRBS - 1);
    assert.equal(list[list.length - 1].code, 21);
});

await test("MSI: a message for an event (no INTA), IP cleared once it is sent", () => {
    const space = pci.space_bytes(XHCI);
    pci.config_write(XHCI, 0x70 + 4, 4, 0xFEE00000);
    pci.config_write(XHCI, 0x70 + 12, 2, 0x45);
    pci.config_write(XHCI, 0x70 + 2, 2, 1);
    assert.equal(space[0x72] & 1, 1);
    let sent = 0;
    const apic_msi = cpu.apic_msi;
    cpu.apic_msi = () => { sent++; return true; };
    command(NOOP_COMMAND);
    cpu.apic_msi = apic_msi;
    assert.equal(sent, 1);
    assert.ok(!irq());
    assert.equal(r32(IMAN) & 1, 0);
    pci.config_write(XHCI, 0x70 + 2, 2, 0);
});

await test("HCRST: halted, the slots gone, the ports as their devices are", () => {
    w32(USBCMD, 0);
    assert.equal(r32(USBSTS) & HCH, HCH);
    w32(USBCMD, HCRST);
    assert.equal(r32(USBCMD), 0);
    assert.equal(r32(PORTSC(2)) & (CCS | PED), CCS | PED);
    assert.equal(r32(PORTSC(5)) & (CCS | PED), CCS, "the USB 2 port to be reset again");
});

{
    const pc = await machine("i440fx");
    await test("i440FX: at 00:14.0 too", () => {
        const space = pc.v86.cpu.devices.pci.space_bytes(0x14 << 3);
        assert.equal(space[2] | space[3] << 8, 0x000D);
    });
    await pc.destroy();
}

await emulator.destroy();
console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
