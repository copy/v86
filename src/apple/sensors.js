// LIS331DLH on N90 I2C2 (0x19). Register semantics follow ST's LIS331DLH
// datasheet, Doc ID 15094: 12-bit left-aligned acceleration, in sensor axes.
export class AppleLIS331DLH
{
    constructor(interrupt = () => {})
    {
        this.interrupt = interrupt;
        this.regs = new Uint8Array(64);
        this.gravity = [1, 0, 0];
        this.next_sample = 0;
        this.lines = [false, false];
        this.read_mask = 0;
        this.motion_samples = [0, 0];
        this.motion_zone = [0, 0];
        this.reset();
    }

    reset()
    {
        this.regs.fill(0);
        this.regs[0x0F] = 0x32;
        this.regs[0x20] = 7;
        this.gravity = [1, 0, 0]; // N90's device-tree matrix maps this to upright portrait.
        this.next_sample = 0;
        this.lines = [false, false];
        this.read_mask = 0;
        this.motion_samples = [0, 0];
        this.motion_zone = [0, 0];
    }

    read(address)
    {
        const reg = address & 63, value = this.regs[reg];
        if(reg === 0x31 || reg === 0x35)
        {
            if(value & 0x40 && this.regs[0x22] & (reg === 0x31 ? 4 : 32))
            {
                this.regs[reg] &= 0x3F;
                if(this.regs[reg - 1] >>> 6 !== 1) this.motion_samples[(reg - 0x31) >>> 2] = 0;
                this.update_irq();
            }
        }
        if(reg >= 0x28 && reg <= 0x2D)
        {
            const axis = (reg - 0x28) >>> 1;
            this.read_mask |= 1 << (reg - 0x28);
            if((this.read_mask >>> (axis * 2) & 3) === 3) this.regs[0x27] &= ~(0x11 << axis);
            if(!(this.regs[0x27] & 7)) this.regs[0x27] &= ~8;
            if(!(this.regs[0x27] & 0x70)) this.regs[0x27] &= ~0x80;
            this.update_irq();
        }
        return value;
    }

    write(address, value)
    {
        const reg = address & 63;
        if(reg >= 0x20 && reg <= 0x24 || reg === 0x26 || reg >= 0x30 && reg <= 0x37 && (reg & 3) !== 1)
            this.regs[reg] = value & 255;
        if(reg === 0x20)
        {
            this.next_sample = 0;
            if(!(value & 0xE0))
            {
                this.regs[0x27] = this.regs[0x31] = this.regs[0x35] = 0;
                this.motion_samples.fill(0);
                this.motion_zone.fill(0);
            }
        }
        if(reg === 0x21) this.regs[reg] &= ~0x80; // factory trimming reload completes synchronously
        if(reg >= 0x30 && reg < 0x38 && (reg & 3) === 0)
        {
            this.regs[reg + 1] = 0;
            this.motion_samples[(reg - 0x30) >>> 2] = 0;
            this.motion_zone[(reg - 0x30) >>> 2] = 0;
        }
        this.update_irq();
    }

    set_gravity(x, y, z)
    {
        if(![x, y, z].every(Number.isFinite)) return false;
        this.gravity = [x, y, z].map(g => Math.max(-8, Math.min(8, g)));
        return true;
    }

    set_orientation(angle)
    {
        if(![0, 90, 180, 270].includes(angle)) return false;
        const axes = [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]][angle / 90];
        return this.set_gravity(...axes);
    }

    period()
    {
        const control = this.regs[0x20], mode = control >>> 5;
        const rate = mode === 1 ? [50, 100, 400, 1000][control >>> 3 & 3] :
            [0, 0, 0.5, 1, 2, 5, 10, 0][mode];
        return rate && (control & 7) ? 1000 / rate : 0;
    }

    update_irq()
    {
        const ready = !!(this.regs[0x27] & 8);
        const a = !!(this.regs[0x31] & 0x40), b = !!(this.regs[0x35] & 0x40);
        for(let i = 0; i < 2; i++)
        {
            const source = this.regs[0x22] >>> (i ? 3 : 0) & 3;
            const level = source === 0 ? (i ? b : a) : source === 1 ? a || b : source === 2 && ready;
            if(level !== this.lines[i])
            {
                this.lines[i] = level;
                this.interrupt(i, level);
            }
        }
    }

    sample_motion(axes, scale)
    {
        for(let i = 0; i < 2; i++)
        {
            const base = 0x30 + i * 4, config = this.regs[base], old = this.regs[base + 1];
            if(old & 0x40 && this.regs[0x22] & (i ? 32 : 4)) continue;
            const threshold = (this.regs[base + 2] & 127) * scale / 128;
            let event = 0;
            for(let axis = 0; axis < 3; axis++)
            {
                if(axes[axis] > threshold) event |= 2 << (2 * axis);
                else if(axes[axis] < -threshold) event |= 1 << (2 * axis);
            }
            const enabled = config & 63;
            event &= enabled;
            if(event !== this.motion_zone[i]) this.motion_samples[i] = 0;
            this.motion_zone[i] = event;
            const samples = this.motion_samples[i] = Math.min(this.motion_samples[i] + 1, 129);
            const mode = config >>> 6, duration = (this.regs[base + 3] & 127) + 1;
            const matched = event && (mode !== 2 || event === enabled);
            const triggered = matched && (mode === 1 ? samples === duration : samples >= duration);
            this.regs[base + 1] = event | (triggered ? 0x40 : 0);
        }
    }

    timer(now)
    {
        const period = this.period();
        if(!period) { this.next_sample = 0; return 100; }
        if(!this.next_sample) this.next_sample = now + period;
        if(now < this.next_sample) return Math.min(100, this.next_sample - now);
        this.next_sample = now + period;
        const active = this.regs[0x20] & 7, old = this.regs[0x27] & 7;
        const range = this.regs[0x23] >>> 4 & 3;
        const scale = [1, 2, 3.9, 3.9][range]; // mg per digit
        const axes = this.gravity.map((g, i) => active & 1 << i ? g : 0);
        const big = !!(this.regs[0x23] & 0x40);
        if(!(this.regs[0x23] & 0x80) || !old)
        {
            for(let i = 0; i < 3; i++)
            {
                let g = axes[i];
                if((active & 1 << i) && (this.regs[0x23] & 2))
                    g += (this.regs[0x23] & 8 ? -1 : 1) * (i === 2 ? 0.35 : 0.3);
                const digits = Math.max(-2048, Math.min(2047, Math.round(g * 1000 / scale)));
                const value = digits << 4, at = 0x28 + 2 * i;
                this.regs[at + (big ? 1 : 0)] = value & 255;
                this.regs[at + (big ? 0 : 1)] = value >>> 8 & 255;
            }
            this.read_mask = 0;
        }
        this.regs[0x27] |= active | 8;
        if(old & active) this.regs[0x27] |= (old & active) << 4 | 0x80;
        this.sample_motion(axes, [2, 4, 8, 8][range]);
        this.update_irq();
        return Math.min(100, period);
    }

    get_state()
    {
        return [this.regs.slice(), this.gravity.slice(), this.next_sample, this.lines.slice(), this.read_mask,
            this.motion_samples.slice(), this.motion_zone.slice()];
    }
    set_state(state)
    {
        if(!state) { this.reset(); return; }
        this.regs.set(state[0]); this.gravity = Array.from(state[1]);
        this.next_sample = state[2]; this.lines = Array.from(state[3]);
        this.read_mask = state[4] || 0;
        this.motion_samples = Array.from(state[5] || [0, 0]);
        this.motion_zone = Array.from(state[6] || [0, 0]);
    }
}

// N90 has one InvenSense gyro at I2C2 0x68. The other device-tree
// personality at this address is an alternative part. Model the raw sensor
// and FIFO used by AppleMPU3100; the embedded motion processor is unused.
export class AppleMPU3100
{
    constructor(interrupt, accelerometer)
    {
        this.interrupt = interrupt;
        this.accelerometer = accelerometer;
        this.regs = new Uint8Array(64);
        this.fifo = new Uint8Array(512);
        this.head = 0;
        this.count = 0;
        this.next_sample = 0;
        this.reset();
    }

    reset()
    {
        this.regs.fill(0);
        this.regs[0] = 0x68;
        this.regs[0x3E] = 0x40;
        this.head = this.count = this.next_sample = 0;
    }

    transfer_register(start, i) { return start === 0x3C ? start : (start + i) & 63; }

    read(reg)
    {
        const value = reg === 0x3A ? this.count >>> 8 : reg === 0x3B ? this.count & 255 :
            reg === 0x3C ? this.pop() : this.regs[reg];
        if(reg === 0x1A || this.regs[0x17] & 0x10) this.regs[0x1A] = 0;
        return value;
    }

    write(reg, byte)
    {
        if(reg === 0x3E && byte & 0x80) { this.reset(); return; }
        if(reg === 0x3D)
        {
            if(byte & 2) this.head = this.count = 0;
            this.regs[reg] = byte & 0x60;
        }
        else if(reg >= 0x0C && reg <= 0x0E || reg >= 0x12 && reg <= 0x18 || reg === 0x3E)
            this.regs[reg] = byte;
        if(reg === 0x15 || reg === 0x16 || reg === 0x3E) this.next_sample = 0;
        if(reg === 0x3E)
        {
            this.regs[0x1A] = byte & 0x40 ? 0 : 4;
            if(this.regs[0x1A] & this.regs[0x17]) this.interrupt();
        }
    }

    pop()
    {
        if(!this.count) return 0;
        const byte = this.fifo[this.head];
        this.head = (this.head + 1) & 511;
        this.count--;
        return byte;
    }

    push(byte)
    {
        if(this.count === 512) this.pop();
        this.fifo[(this.head + this.count++) & 511] = byte;
    }

    timer(now)
    {
        const power = this.regs[0x3E];
        if(power & 0x40 || (power & 7) === 7) return 100;
        const period = (1 + this.regs[0x15]) / ((this.regs[0x16] & 7) ? 1 : 8);
        if(!this.next_sample) this.next_sample = now + period;
        if(now < this.next_sample) return Math.min(100, this.next_sample - now);
        const samples = Math.min(256, 1 + Math.floor((now - this.next_sample) / period));
        this.next_sample = now + period;
        const temp = -13200; // 35 C; the simulated phone is stationary.
        this.regs[0x1B] = temp >>> 8;
        this.regs[0x1C] = temp;
        if(this.regs[0x3D] & 0x20 && (this.regs[0x14] & 127) === 0x19)
        {
            const start = this.regs[0x18] & 0x3F;
            for(let i = 0; i < 6; i++)
                this.regs[0x23 + i] = this.accelerometer.regs[(start + i) & 63];
        }
        if(this.regs[0x3D] & 0x40)
        {
            const route = this.regs[0x12];
            for(let n = 0; route && n < samples; n++)
            {
                for(let i = 0; i < 7; i++)
                    if(route & 128 >>> i)
                    {
                        this.push(this.regs[0x1B + 2 * i]);
                        this.push(this.regs[0x1C + 2 * i]);
                    }
                if(route & 1) { this.push(0); this.push(0); } // footer
            }
        }
        const prior = this.regs[0x1A];
        this.regs[0x1A] |= 1;
        if(this.regs[0x17] & 1 && (!(this.regs[0x17] & 0x20) || !(prior & 1))) this.interrupt();
        return Math.min(100, period);
    }

    get_state() { return [this.regs.slice(), this.fifo.slice(), this.head, this.count, this.next_sample]; }
    set_state(state)
    {
        if(!state) { this.reset(); return; }
        this.regs.set(state[0]); this.fifo.set(state[1]);
        [this.head, this.count, this.next_sample] = state.slice(2);
    }
}

// One AK8975B at I2C0 0x0C. Give the stationary guest a stable magnetic
// field, nominal factory sensitivity and the native single-shot handshake.
export class AppleAK8975B
{
    constructor(interrupt, now)
    {
        this.interrupt = interrupt;
        this.now = now;
        this.regs = new Uint8Array(19);
        this.ready_at = 0;
        this.reset();
    }

    reset() { this.regs.fill(0); this.regs[0] = 0x48; this.ready_at = 0; }
    transfer_register(start, i) { return start + i; }

    read(reg)
    {
        if(reg >= 0x10 && reg <= 0x12) return this.regs[0x0A] === 15 ? 128 : 0;
        const value = this.regs[reg] || 0;
        if(reg >= 3 && reg <= 9) this.regs[2] = 0;
        return value;
    }

    write(reg, byte)
    {
        if(reg === 0x0C) this.regs[reg] = byte & 0x40; // ASTC.SELF
        if(reg !== 0x0A || ![0, 1, 8, 15].includes(byte & 15)) return;
        const mode = this.regs[reg] = byte & 15;
        this.regs.fill(0, 2, 10);
        this.ready_at = mode === 1 || mode === 8 ? this.now() + 9 : 0;
    }

    timer(now)
    {
        if(!this.ready_at) return 100;
        if(now < this.ready_at) return this.ready_at - now;
        const values = this.regs[0x0A] === 8 && this.regs[0x0C] ? [0, 0, -500] : [90, 0, 130];
        const v = new DataView(this.regs.buffer);
        values.forEach((value, i) => v.setInt16(3 + 2 * i, value, true));
        this.regs[2] = 1;
        this.regs[0x0A] = this.ready_at = 0;
        this.interrupt();
        return 100;
    }

    get_state() { return [this.regs.slice(), this.ready_at]; }
    set_state(state)
    {
        if(!state) { this.reset(); return; }
        this.regs.set(state[0]); this.ready_at = state[1];
    }
}

// CT700 on I2C0 0x29. The 10B329 driver reads four ADC words followed
// by proximity, and clears the two causes with separate I2C commands.
export class AppleCT700
{
    constructor(interrupt)
    {
        this.interrupt = interrupt;
        this.regs = new Uint8Array(32);
        this.next_sample = 0;
        this.reset();
    }

    reset()
    {
        this.regs.fill(0);
        this.regs[0x11] = 1; // revision; native probe only requires an acknowledgement
        this.next_sample = 0;
    }

    transfer_register(start, i)
    {
        if((start & 0x60) === 0x60) return start;
        return (start + (start & 0x20 ? i : 0)) & 31;
    }

    clear(command)
    {
        if(command === 0xE5 || command === 0xE7) this.regs[0x13] &= ~0x20;
        if(command === 0xE6 || command === 0xE7) this.regs[0x13] &= ~0x10;
    }

    read(reg)
    {
        this.clear(reg);
        return this.regs[reg] || 0;
    }

    write(reg, value)
    {
        if(reg >= 0xE0) { this.clear(reg); return; }
        if(reg >= 0x11) return;
        this.regs[reg] = value;
        if(reg === 0)
        {
            if((value & 3) !== 3) this.regs[0x13] &= ~0x11;
            if((value & 5) !== 5) this.regs[0x13] &= ~0x22;
        }
        if(reg <= 2) this.next_sample = 0;
    }

    asserted()
    {
        return !!(this.regs[0x13] & this.regs[0] & 0x30);
    }

    timer(now)
    {
        const enable = this.regs[0];
        if(!(enable & 1) || !(enable & 6)) return 100;
        const period = 2.72 * (256 - this.regs[enable & 2 ? 1 : 2]);
        if(!this.next_sample) this.next_sample = now + period;
        if(now < this.next_sample) return Math.min(100, this.next_sample - now);
        this.next_sample = now + period;
        const previous = this.asserted(), v = new DataView(this.regs.buffer);
        if(enable & 2)
        {
            // Steady room light on the clear, visible and IR channels.
            const light = 240;
            for(const [i, value] of [light, 170, 155, 65].entries()) v.setUint16(0x14 + 2 * i, value, true);
            this.regs[0x13] |= 1;
            if(enable & 16 && (light < v.getUint16(4, true) || light > v.getUint16(6, true))) this.regs[0x13] |= 16;
        }
        if(enable & 4)
        {
            const far = 8;
            v.setUint16(0x1C, far, true);
            this.regs[0x13] |= 2;
            if(enable & 32 && (far < v.getUint16(8, true) || far > v.getUint16(10, true))) this.regs[0x13] |= 32;
        }
        if(!previous && this.asserted()) this.interrupt();
        return Math.min(100, period);
    }

    get_state() { return [this.regs.slice(), this.next_sample]; }
    set_state(state)
    {
        if(!state) { this.reset(); return; }
        this.regs.set(state[0]); this.next_sample = state[1];
    }
}
