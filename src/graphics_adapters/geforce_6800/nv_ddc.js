// Open-drain I2C EDID slave at address 0x50. No host timers: all state follows
// the guest's GPIO edges, including repeated START, ACK/NACK and snapshots.
export class NVDDC
{
    constructor(edid)
    {
        this.edid = edid;
        this.scl = this.master_sda = this.slave_sda = 1;
        this.pointer = this.bits = this.value = 0;
        this.phase = this.next_phase = "idle";
        this.ack = false;
        this.reset();
    }

    reset()
    {
        this.scl = this.master_sda = this.slave_sda = 1;
        this.pointer = this.bits = this.value = 0;
        this.phase = "idle";
        this.next_phase = "idle";
        this.ack = false;
    }

    data()
    {
        return this.master_sda & this.slave_sda;
    }

    drive(scl, sda)
    {
        scl = +!!scl; sda = +!!sda;
        if(this.scl && scl && this.master_sda !== sda)
        {
            this.phase = sda ? "idle" : "address";
            this.bits = this.value = 0;
            this.slave_sda = 1;
        }
        else if(!this.scl && scl) this.rising(sda);
        else if(this.scl && !scl) this.falling();
        this.scl = scl; this.master_sda = sda;
    }

    rising(sda)
    {
        if(this.phase === "address" || this.phase === "offset" || this.phase === "ignore")
        {
            this.value = this.value << 1 | sda;
            if(++this.bits === 8)
            {
                if(this.phase === "address")
                {
                    this.ack = this.value >> 1 === 0x50;
                    this.next_phase = !this.ack ? "idle" : this.value & 1 ? "send" : "offset";
                }
                else
                {
                    this.ack = this.phase === "offset";
                    if(this.ack) this.pointer = this.value & 127;
                    this.next_phase = "ignore";
                }
                this.phase = "ack_setup";
            }
        }
        else if(this.phase === "ack") this.phase = "ack_done";
        else if(this.phase === "send")
        {
            if(++this.bits === 8) this.phase = "send_done";
        }
        else if(this.phase === "master_ack")
        {
            this.ack = !sda;
            this.phase = "master_ack_done";
        }
    }

    falling()
    {
        if(this.phase === "ack_setup")
        {
            this.slave_sda = +!this.ack;
            this.phase = "ack";
        }
        else if(this.phase === "ack_done")
        {
            this.slave_sda = 1;
            this.phase = this.next_phase;
            this.bits = this.value = 0;
            if(this.phase === "send") this.slave_sda = this.edid[this.pointer] >>> 7 & 1;
        }
        else if(this.phase === "send") this.slave_sda = this.edid[this.pointer] >>> (7 - this.bits) & 1;
        else if(this.phase === "send_done")
        {
            this.slave_sda = 1;
            this.phase = "master_ack";
        }
        else if(this.phase === "master_ack_done")
        {
            this.pointer = this.pointer + 1 & 127;
            this.bits = 0;
            this.phase = this.ack ? "send" : "idle";
            this.slave_sda = this.ack ? this.edid[this.pointer] >>> 7 & 1 : 1;
        }
    }

    get_state()
    {
        return [this.scl, this.master_sda, this.slave_sda, this.pointer, this.bits,
            this.value, this.phase, this.next_phase, this.ack];
    }

    set_state(state)
    {
        [this.scl, this.master_sda, this.slave_sda, this.pointer, this.bits,
            this.value, this.phase, this.next_phase, this.ack] = state;
    }
}
