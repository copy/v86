// N90's N1 SPI endpoint. The guest supplies its own firmware; only the
// wire protocol is modelled here. Uploaded ARM code is not retained.
const word = (bytes, at) => (bytes[at + 2] << 24 | bytes[at + 3] << 16 | bytes[at] << 8 | bytes[at + 1]) >>> 0;
const wire_word = value => [value >>> 8 & 255, value & 255, value >>> 24, value >>> 16 & 255];
const sum = bytes => bytes.reduce((total, byte) => total + byte, 0) >>> 0;
const reports = new Map([
    [0xD1, [0x55, 0, 0, 0]], // N1F55 family
    [0xD3, [1, 15, 10, 1, 0, 0, 0, 0]], // little endian, rows, columns, BCD version
    [0xD0, [0, 0, 0, 0]],
    [0xA1, [0, 0, 0, 0]],
    // Simulated 50 by 75 mm sensor, in hundredths of a millimetre.
    [0xD9, [0x88, 0x13, 0, 0, 0x4C, 0x1D, 0, 0]],
]);

// Active coordinate bounds selected by the N90 profile for the simulated
// D9 geometry, in hundredths of a millimetre. The wire origin is bottom-left.
const SENSOR_X = [-83, 4664], SENSOR_Y = [-84, 7284];

export class AppleMultitouch
{
    constructor(interrupt = () => {}, ready = () => {}, timestamp = () => 0)
    {
        this.interrupt = interrupt;
        this.ready = ready;
        this.timestamp = timestamp;
        this.pointer = [0, 0, false];
        this.host_ids = new Map();
        this.frames = [];
        this.contacts = new Map();
        this.frame_number = 0;
        this.last_frame = null;
        this.last_sequence = 0;
        this.frame = null;
        this.frame_replay = false;
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
        this.pointer = [0, 0, false];
        this.host_ids.clear();
        this.ready(false);
        this.frames = [];
        this.contacts.clear();
        this.frame_number = 0;
        this.last_frame = null;
        this.last_sequence = 0;
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
        this.frame = null;
        this.frame_replay = false;
    }

    reply()
    {
        const command = this.packet[0], id = this.packet[1];
        if(this.running && command === 0xEB)
        {
            const frame = this.frame, size = frame ? frame.length + 2 : 0;
            if(this.length !== 16)
            {
                const bytes = new Array(this.length).fill(0);
                bytes[0] = command; bytes[1] = id || 1;
                bytes[2] = size & 255; bytes[3] = size >>> 8;
                bytes[4] = -sum(bytes.slice(0, 4)) & 255;
                if(frame && bytes.length === size + 5)
                {
                    bytes.splice(5, frame.length, ...frame);
                    const check = sum(frame);
                    bytes[bytes.length - 2] = check & 255; bytes[bytes.length - 1] = check >>> 8;
                }
                return bytes;
            }
            const bytes = new Array(16).fill(0);
            bytes[0] = command; bytes[1] = size & 255; bytes[2] = size >>> 8;
            const check = sum(bytes.slice(0, 14));
            bytes[14] = check & 255; bytes[15] = check >>> 8;
            return bytes;
        }
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
        if(at === 0 && byte === 0xEB) this.frame = this.frames[0] || null;
        if(at === 1 && this.packet[0] === 0xEB && byte === this.last_sequence)
        {
            this.frame = this.last_frame;
            this.frame_replay = true;
        }
        else if(at === 1 && this.packet[0] === 0xEB && this.length === 16)
        {
            this.last_frame = null;
            this.last_sequence = 0;
        }
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
        if(this.running && packet[0] === 0xEB && packet[2] === 1 && this.frame &&
            this.length === this.frame.length + 7)
        {
            const check = sum(packet.slice(0, 14));
            if((packet[packet.length - 2] | packet[packet.length - 1] << 8) === check)
            {
                if(!this.frame_replay)
                {
                    this.last_frame = this.frames.shift();
                    this.last_sequence = packet[1];
                }
                if(this.frames.length) this.interrupt();
            }
            return;
        }
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
            this.ready(true);
        }
    }

    absolute(data)
    {
        if(!this.running || !data.every(Number.isFinite) || data[2] <= 0 || data[3] <= 0) return;
        const x = data[0] * 640 / data[2], y = data[1] * 960 / data[3];
        if(x === this.pointer[0] && y === this.pointer[1]) return;
        this.pointer[0] = x; this.pointer[1] = y;
        if(this.pointer[2] && !this.host_ids.size) this.pointer_contacts();
    }

    click(data)
    {
        if(!this.running || this.host_ids.size || !!data[0] === this.pointer[2]) return;
        this.pointer[2] = !!data[0];
        this.pointer[3] = !!(data[0] && data[3]);
        this.pointer_contacts();
    }

    pointer_contacts()
    {
        const [x, y, down, pinch] = this.pointer;
        // The N90 input stack drops path zero. Keep path one for the
        // mirrored finger so old snapshots can finish an active pinch.
        const points = down ? [[2, x, y]] : [];
        if(pinch) points.push([1, 639 - x, 959 - y]);
        this.set_contacts(points, this.timestamp());
    }

    touch_input(event)
    {
        const width = event["width"], height = event["height"];
        if(!this.running || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
        const points = (event["touches"] || []).slice(0, 5), next = new Map(), contacts = [];
        for(const [id, x, y] of points)
        {
            if(!Number.isFinite(x) || !Number.isFinite(y) || next.has(id)) continue;
            let wire_id = this.host_ids.get(id);
            if(wire_id === undefined)
            {
                // N1 reports contact IDs as one-based, then the driver
                // subtracts one for the HID path. UIKit ignores path zero.
                wire_id = 2;
                while([...this.host_ids.values(), ...next.values()].includes(wire_id)) wire_id++;
            }
            next.set(id, wire_id); contacts.push([wire_id, x * 640 / width, y * 960 / height]);
        }
        this.host_ids = next;
        this.set_contacts(contacts, this.timestamp());
    }

    // Host coordinates use 640 by 960 pixels; wire coordinates use sensor units.
    set_contacts(contacts, timestamp)
    {
        if(!this.running) return;
        const next = new Map(), points = [];
        for(const contact of contacts.slice(0, 5))
        {
            const id = contact[0];
            if(next.has(id) || !Number.isInteger(id) || id < 1 || id > 255 ||
                !Number.isFinite(contact[1]) || !Number.isFinite(contact[2])) continue;
            const x = Math.max(0, Math.min(639, Math.round(contact[1])));
            const y = Math.max(0, Math.min(959, Math.round(contact[2])));
            const old = this.contacts.get(id);
            next.set(id, [x, y]);
            points.push([id, old ? 4 : 3, x, y]);
        }
        for(const [id, xy] of this.contacts)
            if(!next.has(id)) points.push([id, 7, ...xy]);
        if(!points.length) return;
        this.contacts = next;
        const frame = new Array(24 + 28 * points.length).fill(0);
        frame[0] = 0x44; frame[1] = this.frame_number++ & 255; frame[2] = 24; frame[3] = 1;
        for(let i = 0; i < 4; i++) frame[4 + i] = timestamp >>> (8 * i) & 255;
        frame[16] = points.length; frame[17] = 28;
        points.forEach(([id, event, x, y], i) => {
            const at = 24 + i * 28;
            frame[at] = id; frame[at + 1] = event;
            frame[at + 2] = 1; // finger identity (zero is unclassified)
            const sensor_x = Math.round(SENSOR_X[0] + x / 640 * (SENSOR_X[1] - SENSOR_X[0]));
            const sensor_y = Math.round(SENSOR_Y[1] - y / 960 * (SENSOR_Y[1] - SENSOR_Y[0]));
            frame[at + 4] = sensor_x & 255; frame[at + 5] = sensor_x >>> 8 & 255;
            frame[at + 6] = sensor_y & 255; frame[at + 7] = sensor_y >>> 8 & 255;
            for(const offset of [12, 14, 18, 20])
            {
                const value = event === 7 ? 0 : offset === 20 ? 200 : 300;
                frame[at + offset] = value & 255; frame[at + offset + 1] = value >>> 8;
            }
        });
        this.frames.push(frame);
        this.interrupt();
    }

    get_state()
    {
        return [this.running, this.loaded, this.status, Array.from(this.registers), this.pending_read,
            this.length, this.position, this.packet.slice(), this.bulk, this.payload_sum, this.footer.slice(),
            this.frames.map(frame => frame.slice()), Array.from(this.contacts, ([id, xy]) => [id, xy.slice()]), this.frame_number,
            this.last_frame?.slice() || null, this.last_sequence, this.frame?.slice() || null, this.frame_replay,
            this.pointer.slice(), Array.from(this.host_ids)];
    }
    set_state(state)
    {
        this.running = state[0]; this.loaded = state[1]; this.status = state[2];
        this.registers = new Map(state[3]); this.pending_read = state[4];
        this.length = state[5]; this.position = state[6]; this.packet = state[7].slice();
        this.bulk = state[8]; this.payload_sum = state[9]; this.footer = state[10].slice();
        this.frames = (state[11] || []).map(frame => frame.slice());
        this.contacts = new Map(state[12] || []); this.frame_number = state[13] || 0;
        this.contacts.delete(0);
        this.contacts.delete(1);
        this.last_frame = state[14]?.slice() || null; this.last_sequence = state[15] || 0;
        this.frame = state[16]?.slice() || null; this.frame_replay = !!state[17];
        this.pointer = state[18]?.slice() || [0, 0, false];
        this.host_ids = new Map((state[19] || []).filter(([, id]) => id > 1));
        this.ready(this.running);
    }
}
