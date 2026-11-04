import { DisplayHub } from "../display.js";
import { AppleCDMA } from "./cdma.js";
import { AppleCLCD } from "./clcd.js";
import { AppleNAND } from "./nand.js";
import { AppleH2FMI } from "./h2fmi.js";
import { AppleIOP } from "./iop.js";
import { AppleI2C } from "./i2c.js";
import { AppleTimer } from "./timer.js";
import { AppleUART } from "./uart.js";
import { AppleVIC } from "./vic.js";

const auxiliary_uarts = ["apple_uart1", "apple_uart2", "apple_uart3", "apple_uart4", "apple_uart5", "apple_uart6"];

// Append new devices to preserve the order in snapshots.
export const N90_DEVICE_ORDER = [
    "apple_uart", "apple_vectors", "apple_vic", "apple_timer", "apple_gpio", "apple_cdma", "apple_miu", "apple_clcd",
    "apple_i2c0", "apple_i2c2", "apple_swi", "apple_dart1", "apple_dart2", "apple_sgx", "apple_iop", "apple_fmi0", "apple_fmi1", "apple_nand", ...auxiliary_uarts,
];

export function create_n90_devices(cpu, bus, screen, buffer)
{
    const display = new DisplayHub(bus, screen);
    const vic = new AppleVIC(cpu);
    const gpio = new AppleGPIO(cpu, vic);
    const clcd = new AppleCLCD(cpu, display, vic);
    const nand = buffer ? new AppleNAND(cpu, buffer) : null;
    const iop = new AppleIOP(cpu);
    const dma = new AppleCDMA(cpu, (n, level) => (n <= 2 ? vic : iop.vic).set_line(0x30 + n, level));
    const devices = {
        display,
        apple_fmi0: new AppleH2FMI(cpu, 0x81200000, 0, nand, level => iop.vic.set_line(34, level), dma),
        apple_fmi1: new AppleH2FMI(cpu, 0x81300000, 1, nand, level => iop.vic.set_line(35, level), dma),
        apple_iop: iop,
        apple_uart: new AppleUART(cpu, bus),
        apple_vectors: new AppleVectors(cpu),
        apple_vic: vic,
        apple_timer: new AppleTimer(cpu, vic),
        apple_gpio: gpio,
        apple_cdma: dma,
        apple_miu: new AppleRegisterWindow(cpu, "miu", 0xBFC00000, 0x1000),
        apple_clcd: clcd,
        apple_i2c0: new AppleI2C(cpu, 0x83200000, 19, vic, true, level => clcd.set_backlight(level), () => gpio.pulse(13)),
        apple_i2c2: new AppleI2C(cpu, 0x83400000, 21, vic, false),
        apple_swi: new AppleSWI(cpu),
        apple_dart1: new AppleRegisterWindow(cpu, "dart1", 0x88D00000, 0x2000),
        apple_dart2: new AppleRegisterWindow(cpu, "dart2", 0x89D00000, 0x2000),
        apple_sgx: new AppleRegisterWindow(cpu, "sgx", 0x85100000, 0x1000),
    };
    auxiliary_uarts.forEach((name, i) => { devices[name] = new AppleUART(cpu, bus, i + 1); });
    if(nand) devices.apple_nand = nand;
    return devices;
}

// The N90 board's writable low exception vectors. XNU maps physical zero
// during CPU bootstrap and copies the reset vector and its handler here.
export class AppleVectors
{
    constructor(cpu)
    {
        this.cpu = cpu;
        this.region = cpu.mmio_ram_allocate(4096);
        if(this.region < 0 || !cpu.wm.exports["a64_bus_map_device"](0, 0, 4096, 0, cpu.device_regions[this.region].backing))
        {
            throw new Error("cannot map A4 reset vectors");
        }
    }

    bytes() { return new Uint8Array(this.cpu.wasm_memory.buffer, this.cpu.mmio_ram_backing(this.region), 4096); }
    get_state() { return [this.bytes().slice()]; }
    set_state(state) { this.bytes().set(state[0]); }
}

// The N90 GPIO bank has 22 eight-pin ports. A pin's low bit is the
// sampled/driven value; its mode and pull configuration share the word.
export class AppleGPIO
{
    constructor(cpu, vic)
    {
        this.vic = vic;
        this.pins = new Uint32Array(22 * 8);
        this.mask = new Uint32Array(6);
        this.pending = new Uint32Array(6);
        this.reset();
        cpu.io.register_mmio(0xBFA00000, 0x1000, {
            name: "gpio",
            read: offset => this.read(offset),
            write: (offset, width, value) => this.write(offset, Number(value)),
        });
    }

    groups()
    {
        let groups = 0;
        for(let i = 0; i < this.pending.length; i++) if(this.pending[i] & ~this.mask[i]) groups |= 1 << i;
        return groups;
    }

    update_irq() { this.vic.set_line(0x74, !!this.groups()); }

    // Latch an interrupt from an edge-triggered peripheral.
    pulse(pin)
    {
        this.pending[pin >>> 5] |= 1 << (pin & 31);
        this.update_irq();
    }

    read(offset)
    {
        if(offset < this.pins.byteLength) return this.pins[offset >>> 2];
        if(offset === 0xC00) return this.groups();
        const bank = (offset & 63) >>> 2;
        if(bank >= this.mask.length) return 0;
        if((offset & ~63) === 0x800) return this.mask[bank];
        if((offset & ~63) === 0x880) return (this.pending[bank] & ~this.mask[bank]) >>> 0;
        return 0;
    }

    write(offset, value)
    {
        if(offset < this.pins.byteLength) { this.pins[offset >>> 2] = value; return; }
        const bank = (offset & 63) >>> 2;
        if(bank >= this.mask.length) return;
        switch(offset & ~63)
        {
            case 0x800: this.mask[bank] |= value; break;
            case 0x840: this.mask[bank] &= ~value; break;
            case 0x880: this.pending[bank] &= ~value; break;
            default: return;
        }
        this.update_irq();
    }

    reset() { this.pins.fill(0); this.mask.fill(0xFFFFFFFF); this.pending.fill(0); this.update_irq(); }
    get_state() { return [this.pins.slice(), this.mask.slice(), this.pending.slice()]; }
    set_state(state)
    {
        this.pins.set(state[0]);
        this.mask.fill(0xFFFFFFFF);
        this.pending.fill(0);
        if(state[1]) this.mask.set(state[1]);
        if(state[2]) this.pending.set(state[2]);
        this.update_irq();
    }
}

// Configuration latches for the MIU and the single-wire voltage controller.
// The platform driver programs the bus timeout and SWI timings at probe.
export class AppleRegisterWindow
{
    constructor(cpu, name, base, size)
    {
        this.regs = new Uint32Array(size / 4);
        cpu.io.register_mmio(base, size, {
            name,
            read: offset => this.regs[offset >>> 2],
            write: (offset, width, value) => this.write(offset, Number(value)),
        });
    }

    write(offset, value) { this.regs[offset >>> 2] = value; }
    reset() { this.regs.fill(0); }
    get_state() { return [this.regs.slice()]; }
    set_state(state) { this.regs.set(state[0]); }
}


// SWI's voltage transactions complete synchronously. AppleSamsungSWI polls
// the busy bit at +0x14 before issuing the next PMU voltage command.
class AppleSWI extends AppleRegisterWindow
{
    constructor(cpu) { super(cpu, "swi", 0xBF600000, 0x1000); }
    write(offset, value) { super.write(offset, offset === 0x14 ? value & ~1 : value); }
}
