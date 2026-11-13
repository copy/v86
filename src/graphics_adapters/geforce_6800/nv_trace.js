// Bounded access tracing for G0. Diagnostic data is deliberately not snapshot state.
export class NVTrace
{
    constructor(limit = 16384)
    {
        this.limit = limit;
        this.enabled = false;
        this.events = [];
        this.dropped = 0;
        this.counts = new Map();
    }

    record(space, offset, size, write, value, implemented)
    {
        if(!this.enabled) return;
        const key = space + ":" + offset.toString(16) + ":" + (write ? "w" : "r");
        this.counts.set(key, (this.counts.get(key) || 0) + 1);
        if(this.events.length === this.limit) { this.dropped++; return; }
        this.events.push({ "space": space, "offset": offset, "size": size,
            "write": write, "value": value >>> 0, "implemented": implemented });
    }

    clear()
    {
        this.events = [];
        this.counts.clear();
        this.dropped = 0;
    }

    report()
    {
        return { "events": this.events.slice(), "dropped": this.dropped, "counts": Array.from(this.counts) };
    }
}
