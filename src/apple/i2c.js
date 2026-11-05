// A4 I2C controllers. The command couples a register-address phase to
// a FIFO transfer. The status is latched until the guest acknowledges it.
import { AppleCS42L61, AppleMikey } from "./audio.js";

const D1815_RTC = 0x4C, D1815_RTC_OFFSET = 0x84;

export class AppleI2C
{
    constructor(cpu, base, irq, vic, pmu, backlight = null, pmu_irq = null, slaves = null)
    {
        this.backlight = backlight;
        this.pmu_irq = pmu_irq;
        this.slaves = slaves;
        this.irq = irq;
        this.vic = vic;
        this.clock = cpu.clock;
        this.pmu = pmu ? new Uint8Array(256) : null;
        this.mikey = pmu ? new AppleMikey() : null;
        this.codec = pmu ? new AppleCS42L61() : null;
        this.regs = new Uint32Array(10);
        this.fifo = [];
        this.reset();
        cpu.io.register_mmio(base, 0x1000, {
            name: "i2c",
            read: offset => offset === 0x20 ? this.fifo.shift() || 0 : this.regs[offset >>> 2] || 0,
            write: (offset, width, value) => this.write(offset, Number(value)),
        });
    }

    reset()
    {
        this.regs.fill(0);
        this.fifo = [];
        this.mikey?.reset();
        this.codec?.reset();
        if(this.pmu)
        {
            const offset = this.pmu.slice(D1815_RTC_OFFSET, D1815_RTC_OFFSET + 4);
            this.pmu.fill(0);
            this.pmu.set(offset, D1815_RTC_OFFSET);
            this.pmu[0x66] = 255;
            this.pmu[0x67] = 7;
            this.pmu[0x68] = 0x15;
            this.update_backlight();
            this.pmu[7] = 8; // USB supply present
        }
        this.vic.set_line(this.irq, false);
    }

    update_backlight()
    {
        if(this.backlight) this.backlight(this.pmu[0x68] & 1 ? (this.pmu[0x66] << 3) | (this.pmu[0x67] & 7) : 0);
    }

    write(offset, value)
    {
        if(offset === 0x20)
        {
            if(this.fifo.length < 256) this.fifo.push(value & 255);
            return;
        }
        if(offset === 0x0C) this.regs[3] &= ~value;
        else if(offset < 40) this.regs[offset >>> 2] = value;
        if(offset === 0x24 && (value & 4))
        {
            const count = this.regs[6];
            const device = this.slaves?.get(this.regs[0]) ||
                (this.regs[0] === 0x39 ? this.mikey : this.regs[0] === 0x4a ? this.codec : null);
            if(this.pmu && this.regs[0] === 0x74 && count <= 256)
            {
                const subaddress = this.regs[4];
                if(value & 1)
                {
                    for(let i = 0; i < Math.min(count, this.fifo.length); i++)
                    {
                        const reg = subaddress + i & 255;
                        if(reg >= D1815_RTC && reg < D1815_RTC + 4) continue;
                        const before = this.pmu[reg];
                        this.pmu[reg] = this.fifo[i];
                        // D1815 software-start conversion. Unconnected analog
                        // inputs read zero; signal completion to the native PMU driver.
                        if(reg === 0x30 && (this.pmu[reg] & 0x10) && !(before & 0x10))
                        {
                            this.pmu[0x31] = this.pmu[0x32] = 0;
                            const pending = this.pmu[2] & 0x20;
                            this.pmu[2] |= 0x20;
                            if(!pending) this.pmu_irq?.();
                        }
                    }
                    this.update_backlight();
                    this.fifo = [];
                }
                else
                {
                    // A single burst is one little-endian seconds sample.
                    // The native driver applies its persistent offset itself.
                    const seconds = Math.floor((this.clock?.wall_time?.() ?? 0) / 1000) >>> 0;
                    this.fifo = Array.from({ length: count }, (_, i) => {
                        const reg = subaddress + i & 255;
                        if(reg >= D1815_RTC && reg < D1815_RTC + 4)
                            return seconds >>> ((reg - D1815_RTC) * 8) & 255;
                        const byte = this.pmu[reg];
                        if(reg === 2) this.pmu[reg] &= ~0x20; // read-to-clear conversion event
                        return byte;
                    });
                }
                this.regs[3] |= 0x10;
            }
            else if(device && count <= 256)
            {
                const address = this.regs[4], start = address & 0x7f;
                const reg = i => device.transfer_register ? device.transfer_register(address & 255, i) :
                    address & 0x80 ? start + i & 0x7f : start;
                if(value & 1)
                {
                    for(let i = 0; i < Math.min(count, this.fifo.length); i++) device.write(reg(i), this.fifo[i]);
                    this.fifo = [];
                }
                else this.fifo = Array.from({ length: count }, (_, i) => device.read(reg(i)));
                this.regs[3] |= 0x10;
            }
            else
            {
                this.fifo = [];
                this.regs[3] |= 0x20;
            }
        }
        this.vic.set_line(this.irq, !!(this.regs[2] & this.regs[3]));
    }

    get_state()
    {
        return [this.regs.slice(), this.fifo.slice(), this.pmu?.slice() || null, this.mikey?.get_state() || null,
            this.codec?.get_state() || null];
    }
    set_state(state)
    {
        this.regs.set(state[0]);
        this.fifo = Array.from(state[1]);
        if(this.pmu) { this.pmu.set(state[2]); this.update_backlight(); }
        this.mikey?.set_state(state[3]);
        this.codec?.set_state(state[4]);
        this.vic.set_line(this.irq, !!(this.regs[2] & this.regs[3]));
    }
}
