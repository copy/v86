#!/usr/bin/env node

// USB (usb: { controller: "uhci", tablet: true }, the plugin of src/usb/):
// the UHCI controller driven through its I/O registers and a schedule in
// guest memory (frame list, queue heads, transfer descriptors), no guest
// code; the test moves the machine clock (docs/modern-pc-devices-plan.md U1).
// PCI identity on i440FX and Q35, registers, port reset and enable, frames
// at 1 ms, control transfers (descriptors, SET_ADDRESS, SET_CONFIGURATION,
// HID requests), STALL, timeouts, short packets, the interrupt endpoint's
// reports from the page's pointer, NAK, the routing of the pointer away from
// PS/2, snapshots.

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
    usb: { controller: "uhci", tablet: true },
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
// (PIIX3's function 2 on i440FX, ICH9's 00:1d.0 on Q35)
const UHCI = 0x01 << 3 | 2, ICH9_UHCI = 0x1D << 3;
const IO = 0xC000;

const r16 = offset => cpu.io.port_read16(IO + offset);
const r32 = offset => cpu.io.port_read32(IO + offset) >>> 0;
const w16 = (offset, value) => cpu.io.port_write16(IO + offset, value);
const w32 = (offset, value) => cpu.io.port_write32(IO + offset, value | 0);
const u32 = a => (mem[a] | mem[a + 1] << 8 | mem[a + 2] << 16 | mem[a + 3] << 24) >>> 0;
const put32 = (a, v) => { mem[a] = v; mem[a + 1] = v >> 8; mem[a + 2] = v >> 16; mem[a + 3] = v >>> 24; };
const irq = () => !!pci.intx_levels[UHCI];

const USBCMD = 0x00, USBSTS = 0x02, USBINTR = 0x04, FRNUM = 0x06, FLBASEADD = 0x08, PORTSC1 = 0x10, PORTSC2 = 0x12;
const RS = 1, HCRESET = 2, HALTED = 1 << 5, USBINT = 1, ERROR = 2;
const CCS = 1, CSC = 2, PE = 4, PR = 1 << 9;
const T = 1, Q = 2, VF = 4;
const ACTIVE = 1 << 23, IOC = 1 << 24, SPD = 1 << 29, STALLED = 1 << 22, CRC_TIMEOUT = 1 << 18, ERRORS3 = 3 << 27;
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

// the schedule: every frame list entry to one queue head
const FRAME_LIST = 0x100000, QH = 0x101000, TDS = 0x102000, BUFFERS = 0x103000;
let tablet_active = null;
emulator.add_listener("usb-tablet-active", value => { tablet_active = value; });

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

/**
 * A control transfer: SETUP, the data stage (IN packets of 8 bytes), the status stage
 * @return {{data: Uint8Array, status: number}} the data read, the last TD's control
 */
function control(address, setup, length = setup[6] | setup[7] << 8, out = null)
{
    mem.set(setup, BUFFERS);
    const tds = [[ACTIVE | ERRORS3, token(PID_SETUP, address, 0, 0, 8), BUFFERS]];
    const into = !(setup[0] & 0x80);
    let toggle = 1;
    for(let done = 0; done < length; done += 8)
    {
        const n = Math.min(8, length - done);
        if(out) mem.set(out.subarray(done, done + n), BUFFERS + 0x100 + done);
        tds.push([ACTIVE | ERRORS3, token(into ? PID_OUT : PID_IN, address, 0, toggle, n), BUFFERS + 0x100 + done]);
        toggle ^= 1;
    }
    tds.push([ACTIVE | ERRORS3 | IOC, token(into ? PID_IN : PID_OUT, address, 0, 1, 0), 0]);
    queue(tds);
    advance(3);
    let read = 0;
    for(let i = 1; i < tds.length - 1; i++)
    {
        const c = td_control(i);
        if(c & ACTIVE || c & STALLED) break;
        read += (c + 1) & 0x7FF;
    }
    return { data: mem.slice(BUFFERS + 0x100, BUFFERS + 0x100 + read), status: td_control(tds.length - 1), first: td_control(0), tds: tds.length };
}
const setup = (type, request, value, index, length) => Uint8Array.of(type, request, value & 0xFF, value >> 8, index & 0xFF, index >> 8, length & 0xFF, length >> 8);

// --- PCI and registers --------------------------------------------------------

test("PCI: PIIX3 UHCI (8086:7020) at 00:01.2, class 0C/03/00, BAR4 32 I/O ports, SBRN 1.0, INTD", () => {
    const space = pci.space_bytes(UHCI);
    const word = o => space[o] | space[o + 1] << 8;
    assert.equal(word(0), 0x8086);
    assert.equal(word(2), 0x7020);
    assert.deepEqual([space[0x0B], space[0x0A], space[0x09]], [0x0C, 0x03, 0x00]);
    assert.equal(space[0x60], 0x10);
    assert.equal(space[0x3D], 4);
    pci.config_write(UHCI, 0x20, 4, -1);
    assert.equal((space[0x20] | space[0x21] << 8 | space[0x22] << 16 | space[0x23] << 24) >>> 0, 0xFFFFFFE1);
    pci.config_write(UHCI, 0x20, 4, IO | 1);
    pci.config_write(UHCI, 0x04, 2, 0x0005);
});

test("registers after reset: halted, the tablet on port 1 (connected, changed), bit 7 of PORTSC reads 1", () => {
    w16(USBCMD, HCRESET);
    assert.equal(r16(USBCMD) & HCRESET, 0, "self-clearing");
    assert.equal(r16(USBSTS) & HALTED, HALTED);
    assert.equal(r16(PORTSC1) & 0x8B, 0x80 | CCS | CSC, "port 1: the tablet");
    assert.equal(r16(PORTSC2) & 0x8F, 0x80, "port 2: empty");
    assert.equal(cpu.io.port_read8(IO + 0x0C), 64, "SOFMOD");
});

test("frames: FRNUM counts milliseconds while running, not while halted; HCHalted follows RS", () => {
    for(let i = 0; i < 1024; i++) put32(FRAME_LIST + 4 * i, QH | Q);
    put32(QH, T);
    put32(QH + 4, T);
    w32(FLBASEADD, FRAME_LIST);
    w16(FRNUM, 0x3FE);
    w16(USBCMD, RS);
    assert.equal(r16(USBSTS) & HALTED, 0);
    advance(5);
    assert.equal(r16(FRNUM), 0x403, "five frames, past the frame list's end");
    w16(USBCMD, 0);
    assert.equal(r16(USBSTS) & HALTED, HALTED);
    advance(5);
    assert.equal(r16(FRNUM), 0x403);
    w16(USBCMD, RS);
});

test("port reset and enable: CSC cleared by writing it, PR resets the device, PE enables the port", () => {
    w16(PORTSC1, CSC);
    assert.equal(r16(PORTSC1) & CSC, 0);
    w16(PORTSC1, PR);
    assert.equal(r16(PORTSC1) & (PR | PE), PR);
    w16(PORTSC1, 0);
    w16(PORTSC1, PE);
    assert.equal(r16(PORTSC1) & (CCS | PE), CCS | PE);
});

let device_descriptor;
test("GET_DESCRIPTOR(device) at address 0: QEMU's tablet IDs, 8-byte packets; IOC: USBINT and INTD", () => {
    w16(USBINTR, 0xF);
    const r = control(0, setup(0x80, 6, 0x0100, 0, 18));
    device_descriptor = r.data;
    assert.equal(r.data.length, 18);
    assert.equal(r.data[1], 1);
    assert.equal(r.data[7], 8, "bMaxPacketSize0");
    assert.equal(r.data[8] | r.data[9] << 8, 0x0627);
    assert.equal(r.data[10] | r.data[11] << 8, 0x0001);
    assert.equal(r.status & ACTIVE, 0, "the status stage done");
    assert.equal(r16(USBSTS) & USBINT, USBINT);
    assert.ok(irq());
    w16(USBSTS, USBINT);
    assert.ok(!irq());
});

test("SET_ADDRESS: the device answers at its new address after the status stage, not at 0", () => {
    const r = control(0, setup(0x00, 5, 7, 0, 0));
    assert.equal(r.status & (ACTIVE | STALLED), 0);
    assert.deepEqual(control(7, setup(0x80, 6, 0x0100, 0, 18)).data, device_descriptor);
    mem.set(setup(0x80, 6, 0x0100, 0, 18), BUFFERS);
    queue([[ACTIVE | ERRORS3, token(PID_SETUP, 0, 0, 0, 8), BUFFERS]]);
    advance(1);
    assert.equal(td_control(0) & (ACTIVE | CRC_TIMEOUT | 3 << 27), ACTIVE | CRC_TIMEOUT | 2 << 27, "no answer at 0: a timeout, retried");
    advance(2);
    assert.equal(td_control(0) & (ACTIVE | CRC_TIMEOUT | 3 << 27), CRC_TIMEOUT, "three errors: retired");
    assert.equal(r16(USBSTS) & ERROR, ERROR);
    w16(USBSTS, 0xFF);
});

test("GET_DESCRIPTOR: the configuration (HID interface, interrupt IN endpoint), strings", () => {
    const config = control(7, setup(0x80, 6, 0x0200, 0, 34)).data;
    assert.equal(config.length, 34);
    assert.equal(config[2] | config[3] << 8, 34, "wTotalLength");
    assert.deepEqual(Array.from(config.subarray(9, 18)), [9, 4, 0, 0, 1, 3, 0, 0, 0], "interface: HID, not a boot device");
    assert.deepEqual(Array.from(config.subarray(18, 21)), [9, 0x21, 0x11]);
    assert.deepEqual(Array.from(config.subarray(27, 34)), [7, 5, 0x81, 3, 8, 0, 10], "endpoint 0x81, interrupt, 8 bytes, 10 ms");
    const name = control(7, setup(0x80, 6, 0x0302, 0x0409, 255), 255).data;
    assert.equal(new TextDecoder("utf-16le").decode(name.subarray(2)), "v86 USB Tablet");
});

test("a short packet: SPD stops the queue at it, USBINT for the short packet", () => {
    mem.set(setup(0x80, 6, 0x0100, 0, 18), BUFFERS);
    queue([[ACTIVE | ERRORS3, token(PID_SETUP, 7, 0, 0, 8), BUFFERS],
        [ACTIVE | ERRORS3 | SPD, token(PID_IN, 7, 0, 1, 64), BUFFERS + 0x100],
        [ACTIVE | ERRORS3, token(PID_OUT, 7, 0, 1, 0), 0]]);
    w16(USBSTS, 0xFF);
    advance(2);
    assert.equal(td_control(1) & 0x7FF, 7, "8 bytes (the first packet)");
    assert.equal(r16(USBSTS) & USBINT, USBINT);
    assert.equal(u32(QH + 4), TDS + 32 | VF, "the queue head still at the short TD");
    assert.equal(td_control(2) & ACTIVE, ACTIVE, "the status stage not done");
    w16(USBSTS, 0xFF);
});

test("STALL: an unknown descriptor (device qualifier: a full-speed device has none)", () => {
    const r = control(7, setup(0x80, 6, 0x0600, 0, 10));
    assert.equal(td_control(1) & (STALLED | ACTIVE), STALLED);
    assert.equal(r16(USBSTS) & ERROR, ERROR);
    w16(USBSTS, 0xFF);
    assert.equal(control(7, setup(0x80, 6, 0x0100, 0, 18)).data.length, 18, "the next SETUP goes on");
});

test("SET_CONFIGURATION: the tablet configured, announced as the pointer's device", () => {
    tablet_active = null;
    control(7, setup(0x00, 9, 1, 0, 0));
    assert.deepEqual(Array.from(control(7, setup(0x80, 8, 0, 0, 1)).data), [1]);
    assert.equal(tablet_active, true);
    const report = control(7, setup(0x81, 6, 0x2200, 0, 74), 74).data;
    assert.equal(report.length, 74, "the report descriptor");
    assert.deepEqual(Array.from(report.subarray(0, 4)), [0x05, 0x01, 0x09, 0x02]);
    control(7, setup(0x21, 0x0A, 0, 0, 0));
    assert.deepEqual(Array.from(control(7, setup(0xA1, 0x02, 0, 0, 1)).data), [0], "GET_IDLE");
});

/** The interrupt endpoint's TD: active again, polled for a frame */
function poll()
{
    queue([[ACTIVE | ERRORS3 | IOC, token(PID_IN, 7, 1, 0, 8), BUFFERS + 0x200]]);
    advance(1);
    const c = td_control(0);
    return c & ACTIVE ? null : mem.slice(BUFFERS + 0x200, BUFFERS + 0x200 + ((c + 1) & 0x7FF));
}
const view = bytes => ({ buttons: bytes[0], x: bytes[1] | bytes[2] << 8, y: bytes[3] | bytes[4] << 8, wheel: bytes[5] << 24 >> 24 });

test("the interrupt endpoint: a report after configuring, then NAK until the pointer moves", () => {
    const first = poll();
    assert.equal(first.length, 6);
    assert.deepEqual(view(first), { buttons: 0, x: 0x3FFF, y: 0x3FFF, wheel: 0 });
    assert.equal(poll(), null, "nothing new: NAK, the TD still active");
    emulator.bus.send("mouse-absolute", [100, 50, 400, 200]);
    // (the middle of the page's pixel)
    assert.deepEqual(view(poll()), { buttons: 0, x: Math.round(100.5 / 400 * 32767), y: Math.round(50.5 / 200 * 32767), wheel: 0 });
    emulator.bus.send("mouse-click", [true, false, true]);
    assert.equal(view(poll()).buttons, 3, "left and right");
    emulator.bus.send("mouse-wheel", [1, 0]);
    const r = view(poll());
    assert.deepEqual([r.buttons, r.wheel], [3, 1]);
    emulator.bus.send("mouse-click", [false, false, false]);
    emulator.bus.send("mouse-absolute", [400, 200, 400, 200]);
    assert.deepEqual(view(poll()), { buttons: 0, x: 32767, y: 32767, wheel: 0 });
});

test("the pointer: PS/2 leaves it to the tablet; with the pointer locked, PS/2 has it", () => {
    const ps2 = cpu.devices.ps2;
    assert.equal(ps2.pointer_elsewhere, true);
    emulator.bus.send("mouse-pointer-lock", true);
    assert.equal(ps2.pointer_elsewhere, false);
    poll();
    emulator.bus.send("mouse-absolute", [0, 0, 400, 200]);
    assert.equal(poll(), null, "locked: the tablet does not move");
    emulator.bus.send("mouse-pointer-lock", false);
    assert.equal(ps2.pointer_elsewhere, true);
});

{
    const state = await emulator.save_state();
    control(7, setup(0x00, 9, 0, 0, 0));
    tablet_active = null;
    await emulator.restore_state(state);
    test("snapshot: the controller, the port, the configured tablet at its address (announced again)", () => {
        assert.equal(r16(PORTSC1) & (CCS | PE), CCS | PE);
        assert.equal(r16(USBCMD) & RS, RS);
        assert.equal(tablet_active, true);
        assert.deepEqual(Array.from(control(7, setup(0x80, 8, 0, 0, 1)).data), [1]);
        emulator.bus.send("mouse-absolute", [200, 100, 400, 200]);
        assert.deepEqual(view(poll()).x, Math.round(200.5 / 400 * 32767));
    });
}

{
    tablet_active = null;
    await emulator.usb_plug("tablet", false);
    test("usb_plug: out of its port, the port says so (CCS, CSC, disabled), the pointer back to PS/2", () => {
        assert.equal(r16(PORTSC1) & (CCS | CSC | PE), CSC);
        assert.equal(tablet_active, false);
        assert.equal(cpu.devices.ps2.pointer_elsewhere, false);
        assert.equal(control(7, setup(0x80, 6, 0x0100, 0, 18)).data.length, 0, "no answer");
    });
    await emulator.usb_plug("tablet", true);
    test("usb_plug: back in, enumerated again from address 0", () => {
        assert.equal(r16(PORTSC1) & (CCS | CSC), CCS | CSC);
        w16(PORTSC1, CSC | PR);
        w16(PORTSC1, 0);
        w16(PORTSC1, PE);
        assert.equal(control(0, setup(0x80, 6, 0x0100, 0, 18)).data.length, 18);
    });
    let error;
    await emulator.usb_plug("disk", true).catch(e => { error = e; });
    test("usb_plug: a device the machine does not have", () => assert.match(String(error), /no USB device "disk"/));
}

{
    const q35 = await machine("q35");
    const space = q35.v86.cpu.devices.pci.space_bytes(ICH9_UHCI);
    test("Q35: ICH9's UHCI (8086:2934) at 00:1d.0, INTA", () => {
        assert.equal(space[2] | space[3] << 8, 0x2934);
        assert.equal(space[0x3D], 1);
    });
    await q35.destroy();
}

await emulator.destroy();
console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
