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
