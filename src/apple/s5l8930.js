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
    constructor(cpu)
    {
        this.pins = new Uint32Array(22 * 8);
        cpu.io.register_mmio(0xBFA00000, 0x1000, {
            name: "gpio",
            read: offset => this.pins[offset >>> 2] || 0,
            write: (offset, width, value) => {
                if(offset < this.pins.byteLength) this.pins[offset >>> 2] = Number(value);
            },
        });
    }

    reset() { this.pins.fill(0); }
    get_state() { return [this.pins.slice()]; }
    set_state(state) { this.pins.set(state[0]); }
}
