#!/usr/bin/env node

// USB disks (usb.mass_storage, src/usb/mass_storage.js, docs/usb.md): a
// disk image as a USB stick behind the UHCI controller, driven through the
// controller's registers and a schedule in guest memory, no guest code; the
// test moves the machine clock (docs/modern-pc-devices-plan.md U2).
// Enumeration, GET_MAX_LUN, Bulk-Only Transport (CBW, data, CSW, tags,
// residues, the cases where host and device disagree, an invalid CBW and the
// reset recovery), the SCSI commands (INQUIRY, TEST UNIT READY, READ
// CAPACITY, READ and WRITE across pieces of the image, MODE SENSE, REQUEST
// SENSE, SYNCHRONIZE CACHE, eject and PREVENT), a read-only disk, a disk
// whose reads complete later (NAK meanwhile), usb_attach_disk and
// usb_detach_disk, usb_plug, snapshots.

import assert from "node:assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const SECTORS = 8192;
const pattern = i => (i * 7 + (i >> 9)) & 0xFF;
const image = new Uint8Array(SECTORS * 512).map((_, i) => pattern(i));

let host = 1000;
const emulator = new V86({
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    memory_size: 32 * 1024 * 1024,
    usb: { controller: "uhci", tablet: false, mass_storage: [{ id: "stick", image: { buffer: image.buffer } }] },
    net_device: { type: "none" },
    cpu_clock: { mode: "normal", now: () => host },
    autostart: false,
    log_level: 0,
});
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
const cpu = emulator.v86.cpu;
cpu.clock.resume();
const pci = cpu.devices.pci;
const mem = cpu.mem8;

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

const UHCI = 0x01 << 3 | 2, IO = 0xC000;
const r16 = offset => cpu.io.port_read16(IO + offset);
const w16 = (offset, value) => cpu.io.port_write16(IO + offset, value);
const w32 = (offset, value) => cpu.io.port_write32(IO + offset, value | 0);
const u32 = a => (mem[a] | mem[a + 1] << 8 | mem[a + 2] << 16 | mem[a + 3] << 24) >>> 0;
const put32 = (a, v) => { mem[a] = v; mem[a + 1] = v >> 8; mem[a + 2] = v >> 16; mem[a + 3] = v >>> 24; };

const USBCMD = 0x00, USBSTS = 0x02, FLBASEADD = 0x08, PORTSC1 = 0x10, PORTSC2 = 0x12;
const RS = 1;
const CCS = 1, CSC = 2, PE = 4, PR = 1 << 9;
const T = 1, Q = 2, VF = 4;
const ACTIVE = 1 << 23, SPD = 1 << 29, STALLED = 1 << 22, ERRORS3 = 3 << 27;
const PID_SETUP = 0x2D, PID_IN = 0x69, PID_OUT = 0xE1;

/** Move the machine clock on and run the machine's timers */
function advance(ms)
{
    for(let i = 0; i < ms; i++)
    {
        host += 1;
        cpu.run_hardware_timers(false, cpu.clock.now());
    }
}

// the schedule: every frame list entry to one queue head; room for 64 KiB
// transfers (1024 TDs of 64 bytes)
const FRAME_LIST = 0x100000, QH = 0x101000, TDS = 0x200000, DATA = 0x400000;
const token = (pid, address, endpoint, toggle, length) => pid | address << 8 | endpoint << 15 | toggle << 19 | (length - 1 & 0x7FF) << 21;
/** Write TDs (each [control, token, buffer]) linked depth first; the queue head's element the first */
function queue(tds)
{
    tds.forEach(([control, tok, buffer], i) =>
    {
        const at = TDS + 32 * i;
        put32(at, i + 1 < tds.length ? TDS + 32 * (i + 1) | VF : T);
        put32(at + 4, control);
        put32(at + 8, tok);
        put32(at + 12, buffer);
    });
    put32(QH + 4, TDS);
}
const td_control = i => u32(TDS + 32 * i + 4);

/** A control transfer (8-byte packets): the data read, whether it stalled */
function control(address, setup, length = setup[6] | setup[7] << 8)
{
    mem.set(setup, DATA);
    const tds = [[ACTIVE | ERRORS3, token(PID_SETUP, address, 0, 0, 8), DATA]];
    const into = !(setup[0] & 0x80);
    let toggle = 1;
    for(let done = 0; done < length; done += 8)
    {
        tds.push([ACTIVE | ERRORS3, token(into ? PID_OUT : PID_IN, address, 0, toggle, Math.min(8, length - done)), DATA + 0x100 + done]);
        toggle ^= 1;
    }
    tds.push([ACTIVE | ERRORS3, token(into ? PID_IN : PID_OUT, address, 0, 1, 0), 0]);
    queue(tds);
    advance(3);
    let read = 0;
    for(let i = 1; i < tds.length - 1; i++)
    {
        const c = td_control(i);
        if(c & ACTIVE || c & STALLED) break;
        read += (c + 1) & 0x7FF;
    }
    const stalled = tds.some((_, i) => td_control(i) & STALLED);
    return { data: mem.slice(DATA + 0x100, DATA + 0x100 + read), stalled, done: !(td_control(tds.length - 1) & ACTIVE) };
}
const setup = (type, request, value, index, length) => Uint8Array.of(type, request, value & 0xFF, value >> 8, index & 0xFF, index >> 8, length & 0xFF, length >> 8);

// bulk transfers: the endpoints' data toggles
const toggles = new Map();
/**
 * A bulk transfer of 64-byte packets: run frames until its TDs are done (a
 * NAKed TD stays active), at most `frames`
 * @return {{data: Uint8Array, stalled: boolean, done: boolean, length: number}}
 */
function bulk(address, endpoint, pid, length, out = null, frames = 50)
{
    if(out) mem.set(out, DATA);
    const key = address << 8 | endpoint | (pid === PID_IN ? 0x80 : 0);
    let toggle = toggles.get(key) || 0;
    const tds = [];
    for(let done = 0; done < length || done === 0 && length === 0; done += 64)
    {
        tds.push([ACTIVE | ERRORS3 | (pid === PID_IN ? SPD : 0), token(pid, address, endpoint, toggle, Math.min(64, length - done)), DATA + done]);
        toggle ^= 1;
    }
    queue(tds);
    let moved = 0, stalled = false, finished = false;
    for(let frame = 0; frame < frames && !finished; frame++)
    {
        advance(1);
        moved = 0;
        finished = true;
        for(let i = 0; i < tds.length; i++)
        {
            const c = td_control(i);
            if(c & STALLED) { stalled = true; break; }
            if(c & ACTIVE) { finished = false; break; }
            const n = (c + 1) & 0x7FF;
            moved += n;
            // (a short packet ends the transfer)
            if(n < 64) break;
        }
        if(stalled) break;
    }
    toggles.set(key, toggle);
    return { data: mem.slice(DATA, DATA + moved), stalled, done: finished && !stalled, length: moved };
}

let tags = 0;
/** A command block wrapper */
function cbw(length, direction_in, cb, tag = ++tags)
{
    const bytes = new Uint8Array(31);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x43425355, true);
    view.setUint32(4, tag, true);
    view.setUint32(8, length, true);
    bytes[12] = direction_in ? 0x80 : 0;
    bytes[14] = cb.length;
    bytes.set(cb, 15);
    return bytes;
}
/** The command status wrapper */
function csw(address)
{
    const r = bulk(address, 1, PID_IN, 13);
    assert.ok(r.done && r.length === 13, "a CSW: " + JSON.stringify({ stalled: r.stalled, length: r.length }));
    const view = new DataView(r.data.buffer);
    assert.equal(view.getUint32(0, true), 0x53425355, "dCSWSignature");
    return { tag: view.getUint32(4, true), residue: view.getUint32(8, true), status: r.data[12] };
}
/**
 * A SCSI command: CBW, data (IN: `length` bytes; OUT: `out`), CSW
 * @return {{data: ?Uint8Array, status: number, residue: number}}
 */
function scsi(address, cb, length = 0, direction_in = true, out = null)
{
    const tag = tags + 1;
    assert.ok(bulk(address, 2, PID_OUT, 31, cbw(length, direction_in, Uint8Array.from(cb))).done, "the CBW taken");
    let data = null;
    if(length)
    {
        const r = bulk(address, direction_in ? 1 : 2, direction_in ? PID_IN : PID_OUT, length, out, 200);
        assert.ok(r.done, "the data stage done");
        data = r.data;
    }
    const status = csw(address);
    assert.equal(status.tag, tag, "the CSW's tag is the CBW's");
    return { data, status: status.status, residue: status.residue };
}
/** REQUEST SENSE: [key, ASC, ASCQ] */
function request_sense(address)
{
    const data = scsi(address, [0x03, 0, 0, 0, 18, 0], 18).data;
    assert.equal(data[0], 0x70, "fixed format, current");
    return [data[2] & 0xF, data[12], data[13]];
}
const be32 = (bytes, at) => (bytes[at] << 24 | bytes[at + 1] << 16 | bytes[at + 2] << 8 | bytes[at + 3]) >>> 0;
const read10 = (lba, count) => [0x28, 0, lba >>> 24, lba >> 16 & 0xFF, lba >> 8 & 0xFF, lba & 0xFF, 0, count >> 8, count & 0xFF, 0];
const write10 = (lba, count) => [0x2A, 0, lba >>> 24, lba >> 16 & 0xFF, lba >> 8 & 0xFF, lba & 0xFF, 0, count >> 8, count & 0xFF, 0];

/** Reset and enable a port, give the device an address and its configuration */
function enumerate(portsc, address)
{
    w16(portsc, CSC);
    w16(portsc, PR);
    w16(portsc, 0);
    w16(portsc, PE);
    assert.equal(control(0, setup(0x00, 5, address, 0, 0)).done, true, "SET_ADDRESS");
    assert.equal(control(address, setup(0x00, 9, 1, 0, 0)).done, true, "SET_CONFIGURATION");
    for(const key of Array.from(toggles.keys())) if(key >> 8 === address) toggles.delete(key);
}

// --- the controller, the port, enumeration ----------------------------------------

await test("the USB disk on port 1 (no tablet), port 2 empty", () => {
    pci.config_write(UHCI, 0x20, 4, IO | 1);
    pci.config_write(UHCI, 0x04, 2, 0x0005);
    assert.equal(r16(PORTSC1) & (CCS | CSC), CCS | CSC);
    assert.equal(r16(PORTSC2) & CCS, 0);
    for(let i = 0; i < 1024; i++) put32(FRAME_LIST + 4 * i, QH | Q);
    put32(QH, T);
    put32(QH + 4, T);
    w32(FLBASEADD, FRAME_LIST);
    w16(USBCMD, RS);
    w16(PORTSC1, CSC);
    w16(PORTSC1, PR);
    w16(PORTSC1, 0);
    w16(PORTSC1, PE);
    assert.equal(r16(PORTSC1) & (CCS | PE), CCS | PE);
});

await test("descriptors: QEMU's USB disk IDs, USB 2.0, 64-byte packets; mass storage, SCSI, Bulk-Only; bulk IN 0x81, OUT 0x02; a serial number", () => {
    const device = control(0, setup(0x80, 6, 0x0100, 0, 18)).data;
    assert.equal(device.length, 18);
    assert.equal(device[2] | device[3] << 8, 0x0200);
    assert.equal(device[7], 64);
    assert.equal(device[8] | device[9] << 8, 0x46F4);
    assert.equal(device[10] | device[11] << 8, 0x0001);
    assert.equal(control(0, setup(0x00, 5, 3, 0, 0)).done, true);
    const config = control(3, setup(0x80, 6, 0x0200, 0, 32)).data;
    assert.equal(config.length, 32);
    assert.deepEqual(Array.from(config.subarray(9, 18)), [9, 4, 0, 0, 2, 8, 6, 0x50, 0]);
    assert.deepEqual(Array.from(config.subarray(18, 25)), [7, 5, 0x81, 2, 64, 0, 0]);
    assert.deepEqual(Array.from(config.subarray(25, 32)), [7, 5, 0x02, 2, 64, 0, 0]);
    const serial = new TextDecoder("utf-16le").decode(control(3, setup(0x80, 6, 0x0303, 0x0409, 255), 255).data.subarray(2));
    assert.match(serial, /^[0-9A-F]{16}$/);
    const product = new TextDecoder("utf-16le").decode(control(3, setup(0x80, 6, 0x0302, 0x0409, 255), 255).data.subarray(2));
    assert.equal(product, "v86 USB Disk");
    assert.ok(control(3, setup(0x80, 6, 0x0600, 0, 10)).stalled, "no device qualifier: a full-speed device");
    assert.equal(control(3, setup(0x00, 9, 1, 0, 0)).done, true);
});

await test("GET_MAX_LUN: 0 (one LUN)", () => {
    assert.deepEqual(Array.from(control(3, setup(0xA1, 0xFE, 0, 0, 1)).data), [0]);
});

// --- SCSI ---------------------------------------------------------------------------

await test("INQUIRY: a removable direct access device, SPC-3, \"v86\" \"USB Disk\"; VPD pages 0x00 and 0x80 (the serial number)", () => {
    const r = scsi(3, [0x12, 0, 0, 0, 36, 0], 36);
    assert.equal(r.status, 0);
    assert.deepEqual(Array.from(r.data.subarray(0, 5)), [0, 0x80, 5, 2, 31]);
    assert.equal(new TextDecoder().decode(r.data.subarray(8, 32)), "v86     USB Disk        ");
    assert.deepEqual(Array.from(scsi(3, [0x12, 1, 0x00, 0, 255, 0], 255).data.subarray(0, 6)), [0, 0, 0, 2, 0, 0x80]);
    const serial = scsi(3, [0x12, 1, 0x80, 0, 255, 0], 255);
    assert.match(new TextDecoder().decode(serial.data.subarray(4, 4 + serial.data[3])), /^[0-9A-F]{16}$/);
    assert.equal(serial.residue, 255 - 20);
});

await test("TEST UNIT READY: ready; READ CAPACITY(10) and (16): 8192 sectors of 512 bytes; READ FORMAT CAPACITIES", () => {
    assert.equal(scsi(3, [0x00, 0, 0, 0, 0, 0]).status, 0);
    const capacity = scsi(3, [0x25, 0, 0, 0, 0, 0, 0, 0, 0, 0], 8).data;
    assert.deepEqual([be32(capacity, 0), be32(capacity, 4)], [SECTORS - 1, 512]);
    const capacity16 = scsi(3, [0x9E, 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0], 32).data;
    assert.deepEqual([be32(capacity16, 0), be32(capacity16, 4), be32(capacity16, 8)], [0, SECTORS - 1, 512]);
    // (the list, then zeros up to the host's length: the residue says how many)
    const formats = scsi(3, [0x23, 0, 0, 0, 0, 0, 0, 0, 252, 0], 252);
    assert.equal(formats.data[3], 8);
    assert.deepEqual([be32(formats.data, 4), formats.data[8]], [SECTORS, 2]);
    assert.equal(formats.residue, 240);
});

await test("READ(10): 70 sectors over several frames, the image's bytes", () => {
    const r = scsi(3, read10(3, 70), 70 * 512);
    assert.equal(r.status, 0);
    assert.equal(r.residue, 0);
    assert.deepEqual(r.data, image.slice(3 * 512, 73 * 512));
});

const written = new Uint8Array(130 * 512).map((_, i) => (i * 13 + 5) & 0xFF);
await test("WRITE(10): 130 sectors (more than one piece of the image), into the image; read back", () => {
    const r = scsi(3, write10(100, 130), written.length, false, written);
    assert.equal(r.status, 0);
    assert.deepEqual(image.slice(100 * 512, 230 * 512), written, "the image has the guest's data");
    assert.deepEqual(image.slice(99 * 512, 100 * 512), new Uint8Array(512).map((_, i) => pattern(99 * 512 + i)), "nothing before it");
    assert.deepEqual(image.slice(230 * 512, 231 * 512), new Uint8Array(512).map((_, i) => pattern(230 * 512 + i)), "nothing after it");
    assert.deepEqual(scsi(3, read10(100, 130), written.length).data, written);
});

await test("READ(6), READ(16), WRITE(6): the same sectors", () => {
    assert.deepEqual(scsi(3, [0x08, 0, 0, 100, 2, 0], 1024).data, written.slice(0, 1024));
    assert.deepEqual(scsi(3, [0x88, 0, 0, 0, 0, 0, 0, 0, 0, 101, 0, 0, 0, 1, 0, 0], 512).data, written.slice(512, 1024));
    const sector = new Uint8Array(512).fill(0xA5);
    assert.equal(scsi(3, [0x0A, 0, 0, 7, 1, 0], 512, false, sector).status, 0);
    assert.deepEqual(image.slice(7 * 512, 8 * 512), sector);
});

await test("errors: past the end (ILLEGAL REQUEST, LBA out of range), an unknown command; the sense once", () => {
    const r = scsi(3, read10(SECTORS - 2, 4), 2048);
    assert.equal(r.status, 1);
    assert.equal(r.residue, 2048, "no data: all of it residue");
    assert.deepEqual(request_sense(3), [5, 0x21, 0]);
    assert.deepEqual(request_sense(3), [0, 0, 0], "reported, then gone");
    assert.equal(scsi(3, [0xC5, 0, 0, 0, 0, 0]).status, 1);
    assert.deepEqual(request_sense(3), [5, 0x20, 0]);
    assert.equal(scsi(3, [0x12, 0, 0x80, 0, 36, 0], 36).status, 1, "INQUIRY: a page without EVPD");
    assert.deepEqual(request_sense(3), [5, 0x24, 0]);
});

await test("BOT: more expected than the device has (padded, the residue), less (phase error), the other direction (phase error)", () => {
    const more = scsi(3, [0x12, 0, 0, 0, 36, 0], 64);
    assert.equal(more.status, 0);
    assert.equal(more.data.length, 64);
    assert.deepEqual(Array.from(more.data.subarray(36)), new Array(28).fill(0));
    assert.equal(more.residue, 28);
    assert.equal(scsi(3, read10(0, 2), 512).status, 2);
    assert.equal(scsi(3, read10(0, 2), 1024, false, new Uint8Array(1024)).status, 2);
    assert.equal(scsi(3, [0x00, 0, 0, 0, 0, 0], 512).status, 0, "no data for a command without: padded");
    assert.deepEqual(scsi(3, read10(0, 1), 512).data, image.slice(0, 512), "and on");
});

await test("MODE SENSE(6) and (10): all pages (caching with the write cache, informational exceptions), not write protected", () => {
    const six = scsi(3, [0x1A, 0, 0x3F, 0, 192, 0], 192).data;
    assert.equal(six[0], 4 + 20 + 12 - 1, "the header and two pages");
    assert.equal(six[2] & 0x80, 0);
    assert.deepEqual([six[4], six[5], six[6] & 4], [0x08, 0x12, 4]);
    assert.deepEqual([six[24], six[25]], [0x1C, 0x0A]);
    const ten = scsi(3, [0x5A, 0, 0x08, 0, 0, 0, 0, 0, 255, 0], 255).data;
    assert.equal(ten[0] << 8 | ten[1], 8 + 20 - 2);
    assert.equal(ten[8], 0x08);
    assert.equal(scsi(3, [0x1A, 0, 0x05, 0, 192, 0], 192).status, 1, "a page it has not");
    assert.deepEqual(request_sense(3), [5, 0x24, 0]);
});

await test("SYNCHRONIZE CACHE, VERIFY: good", () => {
    assert.equal(scsi(3, [0x35, 0, 0, 0, 0, 0, 0, 0, 0, 0]).status, 0);
    assert.equal(scsi(3, [0x2F, 0, 0, 0, 0, 10, 0, 0, 8, 0]).status, 0);
});

let ejected = [];
emulator.add_listener("usb-disk-ejected", id => ejected.push(id));
await test("eject: refused while PREVENT, then the medium gone (NOT READY, MEDIUM NOT PRESENT, \"usb-disk-ejected\"); loaded again: UNIT ATTENTION once", () => {
    assert.equal(scsi(3, [0x1E, 0, 0, 0, 1, 0]).status, 0);
    assert.equal(scsi(3, [0x1B, 0, 0, 0, 2, 0]).status, 1);
    assert.deepEqual(request_sense(3), [5, 0x53, 2]);
    assert.equal(scsi(3, [0x1E, 0, 0, 0, 0, 0]).status, 0);
    assert.equal(scsi(3, [0x1B, 0, 0, 0, 2, 0]).status, 0);
    assert.deepEqual(ejected, ["stick"]);
    assert.equal(scsi(3, [0x00, 0, 0, 0, 0, 0]).status, 1);
    assert.deepEqual(request_sense(3), [2, 0x3A, 0]);
    assert.equal(scsi(3, read10(0, 1), 512).status, 1);
    assert.equal(scsi(3, [0x1B, 0, 0, 0, 3, 0]).status, 0);
    assert.equal(scsi(3, [0x00, 0, 0, 0, 0, 0]).status, 1);
    assert.deepEqual(request_sense(3), [6, 0x28, 0]);
    assert.equal(scsi(3, [0x00, 0, 0, 0, 0, 0]).status, 0);
});

await test("an invalid CBW: both bulk endpoints STALL until the reset recovery (BOT reset, CLEAR_FEATURE of both)", () => {
    const bad = cbw(0, false, [0]);
    bad[0] = 0;
    assert.ok(bulk(3, 2, PID_OUT, 31, bad).done, "taken");
    assert.ok(bulk(3, 1, PID_IN, 13).stalled);
    assert.ok(bulk(3, 2, PID_OUT, 31, cbw(0, false, [0, 0, 0, 0, 0, 0])).stalled);
    assert.equal(control(3, setup(0x21, 0xFF, 0, 0, 0)).done, true, "BOT reset");
    assert.ok(bulk(3, 1, PID_IN, 13).stalled, "halted until cleared");
    assert.equal(control(3, setup(0x02, 1, 0, 0x81, 0)).done, true);
    assert.equal(control(3, setup(0x02, 1, 0, 0x02, 0)).done, true);
    toggles.clear();
    assert.equal(scsi(3, [0x00, 0, 0, 0, 0, 0]).status, 0);
});

await test("a snapshot in the middle of a READ: the data goes on where it was", async () => {
    assert.ok(bulk(3, 2, PID_OUT, 31, cbw(8 * 512, true, read10(40, 8))).done);
    const first = bulk(3, 1, PID_IN, 1024).data;
    const toggles_saved = new Map(toggles);
    const state = await emulator.save_state();
    const rest = bulk(3, 1, PID_IN, 3072).data;
    await emulator.restore_state(state);
    toggles.clear();
    for(const [key, value] of toggles_saved) toggles.set(key, value);
    const again = bulk(3, 1, PID_IN, 3072).data;
    assert.deepEqual(again, rest);
    const all = new Uint8Array(4096);
    all.set(first);
    all.set(again, 1024);
    assert.deepEqual(all, image.slice(40 * 512, 48 * 512));
    assert.equal(csw(3).status, 0);
});

// --- a second disk: read only; then one whose reads come later ---------------------

const read_only = new Uint8Array(512 * 64).fill(0x5A);
await test("usb_attach_disk(read_only): in port 2; writes refused (DATA PROTECT), MODE SENSE's write protect bit; the image unchanged", async () => {
    await emulator.usb_attach_disk("ro", { buffer: read_only.buffer }, { read_only: true });
    assert.equal(r16(PORTSC2) & (CCS | CSC), CCS | CSC);
    enumerate(PORTSC2, 4);
    const r = scsi(4, write10(0, 1), 512, false, new Uint8Array(512));
    assert.equal(r.status, 1);
    assert.deepEqual(request_sense(4), [7, 0x27, 0]);
    assert.equal(scsi(4, [0x1A, 0, 0x3F, 0, 192, 0], 192).data[2] & 0x80, 0x80);
    assert.deepEqual(read_only, new Uint8Array(512 * 64).fill(0x5A));
    assert.deepEqual(scsi(4, read10(0, 1), 512).data, read_only.slice(0, 512));
});

await test("usb_detach_disk: out of its port (the guest sees it leave); an unknown id refused", async () => {
    await emulator.usb_detach_disk("ro");
    assert.equal(r16(PORTSC2) & (CCS | CSC | PE), CSC);
    await assert.rejects(emulator.usb_detach_disk("ro"));
    await assert.rejects(emulator.usb_attach_disk("stick", { buffer: new ArrayBuffer(512) }), /already/);
});

// a buffer object of one's own whose reads come back later
const slow_bytes = new Uint8Array(512 * 256).map((_, i) => i * 3 & 0xFF);
const pending = [];
class SlowBuffer
{
    constructor() { this.byteLength = slow_bytes.length; this.onload = undefined; }
    load() { this.onload && this.onload({}); }
    get(start, length, fn) { pending.push(() => fn(slow_bytes.slice(start, start + length))); }
    set(start, data, fn) { slow_bytes.set(data, start); fn(); }
    get_state() { return []; }
    set_state() {}
}
const slow = new SlowBuffer();
await test("a disk whose reads complete later: IN NAKs (the TD stays active) until the data is there", async () => {
    await emulator.usb_attach_disk("slow", slow);
    enumerate(PORTSC2, 5);
    assert.ok(bulk(5, 2, PID_OUT, 31, cbw(4096, true, read10(10, 8))).done);
    const waiting = bulk(5, 1, PID_IN, 4096, null, 5);
    assert.equal(waiting.done, false);
    assert.equal(waiting.length, 0, "nothing yet: NAK");
    assert.equal(pending.length, 1, "one read");
    pending.shift()();
    const r = bulk(5, 1, PID_IN, 4096);
    assert.ok(r.done);
    assert.deepEqual(r.data, slow_bytes.slice(10 * 512, 18 * 512));
    assert.equal(csw(5).status, 0);
});

await test("a bus reset in the middle of a READ: the read is dropped; the device starts afresh", async () => {
    assert.ok(bulk(5, 2, PID_OUT, 31, cbw(512, true, read10(0, 1))).done);
    enumerate(PORTSC2, 5);
    pending.shift()();
    assert.equal(pending.length, 0);
    const r = scsi(5, [0x00, 0, 0, 0, 0, 0]);
    assert.equal(r.status, 0);
});

await test("usb_plug: the disk out and back in (enumerated again), its image kept", async () => {
    await emulator.usb_plug("stick", false);
    assert.equal(r16(PORTSC1) & (CCS | CSC), CSC);
    await emulator.usb_plug("stick", true);
    assert.equal(r16(PORTSC1) & (CCS | CSC), CCS | CSC);
    enumerate(PORTSC1, 3);
    assert.deepEqual(scsi(3, read10(100, 1), 512).data, written.slice(0, 512));
});

await test("a snapshot with a disk this machine has no more: restored, it leaves (its port disconnected)", async () => {
    const state = await emulator.save_state();
    await emulator.usb_detach_disk("slow");
    await emulator.restore_state(state);
    assert.equal(r16(PORTSC2) & (CCS | CSC), CSC);
    assert.equal(r16(PORTSC1) & CCS, CCS, "the other disk still there");
    assert.equal(scsi(3, [0x00, 0, 0, 0, 0, 0]).status, 0);
});

// an image that fails its reads and writes (sectors 16 to 31), whose disk reports them
class FailingBuffer
{
    constructor() { this.bytes = new Uint8Array(512 * 64); this.byteLength = this.bytes.length; this.onload = undefined; this.disk_error = "report"; }
    load() { this.onload && this.onload({}); }
    bad(start, length) { return start < 32 * 512 && start + length > 16 * 512; }
    get(start, length, fn) { this.bad(start, length) ? fn(undefined, new Error("bad sector")) : fn(this.bytes.slice(start, start + length)); }
    set(start, data, fn) { if(this.bad(start, data.length)) fn(new Error("bad sector")); else { this.bytes.set(data, start); fn(); } }
    get_state() { return []; }
    set_state() {}
}
await test("an image's read and write errors (disk_error \"report\"): MEDIUM ERROR, the host's disk-error event; the disk goes on", async () => {
    const errors = [];
    const listener = e => errors.push(e.operation + " " + e.disk);
    emulator.add_listener("disk-error", listener);
    await emulator.usb_attach_disk("bad", new FailingBuffer());
    enumerate(PORTSC2, 6);
    const read = scsi(6, read10(14, 4), 2048);
    assert.equal(read.status, 1);
    assert.deepEqual(request_sense(6), [3, 0x11, 0]);
    const write = scsi(6, write10(20, 1), 512, false, new Uint8Array(512).fill(1));
    assert.equal(write.status, 1);
    assert.deepEqual(request_sense(6), [3, 0x0C, 0]);
    assert.deepEqual(scsi(6, read10(40, 1), 512).data, new Uint8Array(512), "elsewhere it reads");
    assert.deepEqual(errors, ["read usb:bad", "write usb:bad"]);
    emulator.remove_listener("disk-error", listener);
    await emulator.usb_detach_disk("bad");
});

await test("USB disks are disks: disk_buffer(\"usb:stick\"), disk_image_info", async () => {
    assert.equal(emulator.disk_buffer("usb:stick").byteLength, image.length);
    const info = await emulator.disk_image_info("usb:stick");
    assert.equal(info.size, image.length);
    assert.equal(info.logical_sector_size, 512);
});

await test("options: an id taken twice, too many disks for the ports", () => {
    const base = { graphics_adapter: "none", usb: { controller: "uhci", tablet: true, mass_storage: [] }, autostart: false };
    assert.throws(() => new V86({ ...base, usb: { ...base.usb, mass_storage: [{ id: "a", image: { buffer: new ArrayBuffer(512) } },
        { id: "a", image: { buffer: new ArrayBuffer(512) } }] } }), /taken/);
    assert.throws(() => new V86({ ...base, usb: { ...base.usb, mass_storage: [{ id: "a", image: { buffer: new ArrayBuffer(512) } },
        { id: "b", image: { buffer: new ArrayBuffer(512) } }] } }), /2 ports/);
    assert.throws(() => new V86({ ...base, usb: { ...base.usb, mass_storage: [{ id: "tablet", image: { buffer: new ArrayBuffer(512) } }] } }), /taken/);
});

await emulator.destroy();
console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
