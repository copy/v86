// N90's N1 SPI endpoint. The guest supplies its own firmware; only the
// wire protocol is modelled here. Uploaded ARM code is not retained.
const word = (bytes, at) => (bytes[at + 2] << 24 | bytes[at + 3] << 16 | bytes[at] << 8 | bytes[at + 1]) >>> 0;
const wire_word = value => [value >>> 8 & 255, value & 255, value >>> 24, value >>> 16 & 255];
const sum = bytes => bytes.reduce((total, byte) => total + byte, 0) >>> 0;
const reports = new Map([
    [0xD1, [1, 0, 0, 0]],
    [0xD3, [1, 32, 20, 1, 0, 0, 0, 0]],
    [0xD0, [0, 0, 0, 0]],
    [0xA1, [0, 0, 0, 0]],
    // Coordinate units of the simulated panel, independent of UIKit points.
    [0xD9, [0x80, 2, 0, 0, 0xC0, 3, 0, 0]],
]);

export class AppleMultitouch
{
    constructor()
    {
        this.running = false;
        this.loaded = false;
        this.status = 0x18E1;
        this.registers = new Map();
        this.pending_read = null;
        this.length = 0;
        this.position = 0;
        this.packet = [];
        this.bulk = false;
        this.payload_sum = 0;
        this.footer = [];
        this.reset();
    }

    reset()
    {
        this.running = false;
        this.loaded = false;
        this.status = 0x18E1;
        this.registers = new Map([[0x10008FFC, 0x5A020028]]);
        this.pending_read = null;
        this.begin(0);
    }

    begin(length)
    {
        this.length = length;
        this.position = 0;
        this.packet = [];
        this.bulk = false;
        this.payload_sum = 0;
        this.footer = [];
    }

    reply()
    {
        const command = this.packet[0], id = this.packet[1];
        if(this.running && (command === 0xE2 || command === 0xE3 || command === 0xE6))
        {
            const bytes = new Array(16).fill(0);
            bytes[0] = command;
            if(command === 0xE2) { bytes[2] = 2; bytes[4] = 2; } // interface 2, 512-byte maximum
            else
            {
                bytes[1] = id || 0;
                const report = reports.get(id);
                if(command === 0xE3)
                {
                    bytes[2] = report ? 0 : 1;
                    bytes[3] = report?.length || 0;
                }
                else
                {
                    bytes[2] = this.packet[2] || 0;
                    if(report) bytes.splice(3, report.length, ...report);
                }
            }
            const check = sum(bytes.slice(0, 14));
            bytes[14] = check & 255; bytes[15] = check >>> 8;
            return bytes;
        }
        if(this.pending_read !== null && this.length === 8 && command === 0x1A)
        {
            const data = wire_word(this.pending_read), check = sum(data);
            return [0x1A, 0xA1, ...data, check >>> 8, check & 255];
        }
        return [this.status >>> 8, this.status & 255];
    }

    exchange(byte, first, length)
    {
        if(first) this.begin(length);
        if(this.position >= this.length) return 0xFF;
        const at = this.position;
        if(!this.bulk || at < 12) this.packet.push(byte & 255);
        if(at === 3 && this.packet[0] === 0x18 && this.packet[1] === 0xE1 &&
            this.packet[2] === 0x30 && this.packet[3] === 1) this.bulk = true;
        if(this.bulk)
        {
            if(at >= 12 && at < this.length - 4) this.payload_sum += byte;
            if(at >= this.length - 4) this.footer.push(byte);
        }
        const reply = this.reply();
        const value = reply[at % reply.length];
        if(++this.position === this.length) this.finish();
        return value;
    }

    finish()
    {
        const packet = this.packet;
        if(this.bulk)
        {
            const size = (packet[4] << 8 | packet[5]) * 4;
            const header = sum(packet.slice(4, 10));
            const valid = this.length === size + 16 && header === (packet[10] << 8 | packet[11]) &&
                this.footer.length === 4 && word(this.footer, 0) === (this.payload_sum >>> 0);
            this.status = valid ? 0x4BC1 : 0x18E1;
            if(valid) this.loaded = true;
            return;
        }
        const command = packet[0] << 8 | packet[1];
        const check = packet.length >= 4 && sum(packet.slice(2, -2)) % 65536 ===
            (packet[packet.length - 2] << 8 | packet[packet.length - 1]);
        if(command === 0x1C73 && packet.length === 8 && check)
            this.pending_read = this.registers.get(word(packet, 2)) || 0;
        else if(command === 0x1E33 && packet.length === 16 && check)
        {
            const address = word(packet, 2), mask = word(packet, 6), value = word(packet, 10);
            if(address !== 0x10008FFC)
                this.registers.set(address, ((this.registers.get(address) || 0) & ~mask | value & mask) >>> 0);
            this.pending_read = null;
            this.status = 0x4AD1;
        }
        else if(command === 0x1AA1 && packet.length === 8) this.pending_read = null;
        else if(command === 0x1F01 && packet.length === 2 && this.loaded)
        {
            this.running = true;
            this.status = 0x1AA1;
            this.pending_read = null;
        }
    }

    get_state()
    {
        return [this.running, this.loaded, this.status, Array.from(this.registers), this.pending_read,
            this.length, this.position, this.packet.slice(), this.bulk, this.payload_sum, this.footer.slice()];
    }
    set_state(state)
    {
        this.running = state[0]; this.loaded = state[1]; this.status = state[2];
        this.registers = new Map(state[3]); this.pending_read = state[4];
        this.length = state[5]; this.position = state[6]; this.packet = state[7].slice();
        this.bulk = state[8]; this.payload_sum = state[9]; this.footer = state[10].slice();
    }
}
