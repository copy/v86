// Bounded access tracing for G0. Diagnostic data is deliberately not snapshot state.
export class NVTrace
{
    constructor(limit = 16384)
    {
        this.limit = limit;
        this.enabled = false;
        this.events = [];
        this.dropped = 0;
        this.next = 0;
        this.sequence = 0;
        this.untracked = 0;
        this.counts = new Map();
    }

    record(space, offset, size, write, value, implemented)
    {
        if(!this.enabled) return;
        // Byte apertures are summarized by 256-byte region, MMIO by register.
        const key = space + ":" + (space === "mmio" ? offset : offset & ~255).toString(16) + ":" + (write ? "w" : "r");
        if(this.counts.has(key) || this.counts.size < this.limit) this.counts.set(key, (this.counts.get(key) || 0) + 1);
        else this.untracked++;
        const event = { "sequence": this.sequence++, "space": space, "offset": offset, "size": size,
            "write": write, "value": value >>> 0, "implemented": implemented };
        if(this.events.length < this.limit) this.events.push(event);
        else
        {
            this.events[this.next] = event;
            this.next = (this.next + 1) % this.limit;
            this.dropped++;
        }
    }

    clear()
    {
        this.events = [];
        this.counts.clear();
        this.dropped = 0;
        this.next = this.sequence = this.untracked = 0;
    }

    report()
    {
        return { "events": this.events.slice(this.next).concat(this.events.slice(0, this.next)),
            "dropped": this.dropped, "untracked": this.untracked, "counts": Array.from(this.counts) };
    }
}
