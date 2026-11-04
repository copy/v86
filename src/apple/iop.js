// AppleARM7M programs a physical DRAM base and length, then starts the
// bundled IOP firmware at its local address zero. Both processors see
// the same RAM, with separate register banks and interrupt controllers.
import { AppleVIC } from "./vic.js";

export class AppleIOP
{
    constructor(cpu)
    {
        this.cpu = cpu;
        this.core = cpu.wm.exports;
        this.regs = new Uint32Array(0x1000 / 4);
        this.irq = false;
        this.fiq = false;
        this.pending_reset = false;
        this.running = false;
        this.vic = new AppleVIC(cpu, 0xBF300000, (irq, fiq) => { this.irq = irq; this.fiq = fiq; });
        cpu.io.register_mmio(0x86300000, 0x1000, {
            name: "arm7m",
            read: offset => this.regs[offset >>> 2],
            write: (offset, width, value) => this.write(offset, Number(value)),
        });
        this.reset();
    }

    reset()
    {
        this.regs.fill(0);
        this.regs[0x100 >>> 2] = 2;
        this.running = false;
        this.pending_reset = false;
        this.vic.reset();
        this.core["a32_iop_remap"](0, 0);
    }

    write(offset, value)
    {
        if(offset === 0x100)
        {
            if(value & 0x10) { this.running = false; value = 2; }
            else if(value & 1)
            {
                this.running = this.core["a32_iop_remap"](this.regs[0x110 >>> 2], this.regs[0x114 >>> 2]) &&
                    !!this.regs[0x114 >>> 2];
                this.pending_reset = this.running;
                value = this.running ? 1 : 2;
            }
        }
        this.regs[offset >>> 2] = value;
    }

    run()
    {
        if(!this.running) return;
        if(this.pending_reset)
        {
            this.core["a32_iop_reset"]();
            this.pending_reset = false;
        }
        this.core["a32_iop_slice"](4096, this.irq, this.fiq);
    }

    get_state()
    {
        let registers = null;
        if(this.running && !this.pending_reset)
        {
            this.core["a32_iop_select"](true);
            try { registers = this.cpu.save_core_state(); }
            finally { this.core["a32_iop_select"](false); }
        }
        return [this.regs.slice(), this.running, this.pending_reset, this.vic.get_state(), registers];
    }

    set_state(state)
    {
        this.regs.set(state[0]);
        this.running = state[1];
        this.pending_reset = state[2];
        this.vic.set_state(state[3]);
        if(!this.core["a32_iop_remap"](this.regs[0x110 >>> 2], this.running ? this.regs[0x114 >>> 2] : 0))
            throw new Error("invalid ARM7M window in snapshot");
        if(state[4])
        {
            this.core["a32_iop_select"](true);
            try { this.cpu.load_core_state(state[4]); }
            finally { this.core["a32_iop_select"](false); }
        }
    }
}
