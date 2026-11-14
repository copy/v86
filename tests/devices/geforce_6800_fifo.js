#!/usr/bin/env node
import assert from "node:assert/strict";
import { NVDMA } from "../../src/graphics_adapters/geforce_6800/nv_dma.js";
import { NVFIFO } from "../../src/graphics_adapters/geforce_6800/nv_fifo.js";
import { NVTrace } from "../../src/graphics_adapters/geforce_6800/nv_trace.js";

function fixture()
{
    const vram = new Uint8Array(2 << 20), ram = new Uint8Array(64 << 10);
    const ramin = new DataView(vram.buffer, 1 << 20), push = new DataView(ram.buffer, 0x1000);
    const calls = [], regs = new Map([[0x200, 0x100], [0x2220, 0x30002], [0x2210, 0x4000100],
        [0x2500, 1], [0x2504, 3], [0x3200, 1], [0x3250, 1]]);
    const device = { vram: () => vram, vram_size: vram.length, registers: regs, trace: new NVTrace(),
        vga: { lfb_region: 1 }, update_irq() {},
        machine: { wake() {}, is_bus_master: () => true, mmio_ram_mark_dirty() {},
            validate_physical_range(at, size) { if(at < 0 || at + size > ram.length) throw new RangeError("RAM"); },
            read_physical: (at, size) => ram.slice(at, at + size), write_physical: (b, at) => ram.set(b, at) },
        graph: { bind: (...args) => { device.bound=args; }, method: (...args) => { calls.push(args); return true; } } };
    device.dma = new NVDMA(device);
    const fifo = new NVFIFO(device);
    function word(at, value) { ramin.setUint32(at, value >>> 0, true); }
    function object(at, flags, limit, pte) { word(at, flags); word(at + 4, limit); word(at + 8, pte); }
    object(0x40000, 0x2303D, 4095, 0x1002);
    object(0x41000, 0x2303D, 4095, 0x5002);
    for(let id = 0; id < 2; id++) word(0x20000 + id * 128 + 0xC, 0x4000 + id * 0x100);
    function handle(value, instance, engine = 1, id = 0)
    {
        let hash = 0, x = value >>> 0;
        while(x) { hash ^= x & 511; x >>>= 9; }
        hash ^= id << 5;
        let at = 0x10000 + (hash & 511) * 8;
        while(ramin.getUint32(at + 4, true)) at = 0x10000 + ((at - 0x10000 + 8) & 4095);
        word(at, value); word(at + 4, id << 23 | engine << 20 | instance / 16);
    }
    function submit(words, budget)
    {
        words.forEach((value, i) => push.setUint32(i * 4, value >>> 0, true));
        if(budget !== undefined)
        {
            fifo.store(fifo.ramfc(0), words.length * 4); regs.set(0x2508, 1); fifo.run(budget);
        }
        else fifo.write(0xC00040, words.length * 4);
    }
    return { fifo, regs, ram, ramin, push, calls, device, word, object, handle, submit };
}
const header = (method, count = 1, subc = 0, ni = false) => method | count << 18 | subc << 13 | (ni ? 0x40000000 : 0);

{
    const f = fixture(); f.fifo.select(0); f.regs.set(0x3224, 0x80000000);
    f.push.setUint32(0, header(0x50), false); f.push.setUint32(4, 0x89ABCDEF, false);
    f.fifo.write(0xC00040, 8);
    assert.equal(f.fifo.read(0xC00048), 0x89ABCDEF, "big-endian DMA fetch decodes both header and data");
    assert.equal(f.fifo.read(0xC00044), 8);
    assert.equal(f.fifo.faults.length, 0);
}
{
    const f = fixture(); f.submit([header(0x50, 2, 0, true), 17, 23]);
    assert.equal(f.fifo.read(0xC00044), 12); assert.equal(f.fifo.read(0x800048), 23);
    assert.equal(f.ramin.getUint32(0x20004, true), 12, "GET saved to RAMFC");
    assert.equal(f.fifo.read(0x3214), 0x10, "CACHE1 empty after pull");
    assert.equal(f.fifo.read(0x3220) & 0x100, 0x100, "DMA queue empty");
    assert.equal(f.regs.get(0x2508), 0);
    new DataView(f.ram.buffer).setUint32(0x5000, header(0x50), true);
    new DataView(f.ram.buffer).setUint32(0x5004, 91, true);
    f.fifo.write(0xC01040, 8);
    assert.equal(f.fifo.read(0xC01048), 91); assert.equal(f.fifo.read(0xC00048), 23, "per-channel REF");
    assert.equal(f.fifo.read(0xC00044), 12, "inactive channel read from RAMFC");
}
{
    const f = fixture();
    f.submit([0x12, header(0x50), 90, 0x2000001C, header(0x50), 7, 0x20000]);
    assert.equal(f.fifo.read(0xC00048), 90, "CALL/RETURN followed by old JUMP");
    assert.equal(f.fifo.read(0xC00054), 28); assert.equal(f.regs.get(0x3228) & 0x20000, 0);
    const j = fixture(); j.submit([9, 0xFFFFFFFF, header(0x50), 31]);
    assert.equal(j.fifo.read(0xC00048), 31, "new JUMP skips invalid command");
}
{
    const f = fixture(); f.word(0x44000, 0x3062); f.handle(0xDEADBEEF, 0x44000);
    f.submit([header(0, 1, 3), 0xDEADBEEF, header(0x300, 2, 3), 0x11, 0x22]);
    assert.deepEqual(f.calls, [[0, 3, 0x44000, 0x300, 0x11], [0, 3, 0x44000, 0x304, 0x22]]);
    assert.deepEqual(f.device.bound,[0,3,0x44000],"SET_OBJECT loads the PGRAPH subchannel cache");
    const g = fixture(); g.submit([header(0), 0x1234]);
    assert(g.regs.get(0x2100) & 1, "missing RAMHT object raises CACHE_ERROR");
    assert.notEqual(g.regs.get(0x3270) || 0, g.regs.get(0x3210), "failed method stays in cache for kernel recovery");
    const sw = fixture(); sw.handle(0x8807C000, 0x40, 0);
    sw.submit([header(0, 1, 7), 0x8807C000]);
    assert(sw.regs.get(0x2100) & 1, "software object binding traps to miniport");
    sw.regs.set(0x2100, 0); sw.regs.set(0x3250, 1);
    sw.regs.set(0x3270, sw.regs.get(0x3210)); // kernel consumes trapped bind
    assert.equal(sw.fifo.method(7, 0x340, 0x2580320), false);
    assert.equal(sw.calls.length, 0, "software DAC timing methods never reach PGRAPH");
    assert(sw.regs.get(0x3250) & 0x100);
}
{
    const f = fixture(); f.object(0x45000, 0x2303D, 4095, 0x8002); f.handle(0x77, 0x45000, 0);
    f.submit([header(0x60, 4), 0x77, 12, 42, 77, header(0x50), 99]);
    assert.equal(f.fifo.read(0xC00048), 0, "REF cannot pass an unsatisfied acquire");
    assert(f.regs.get(0x3254) & 0x10);
    const saved = f.fifo.get_state(), restored = new NVFIFO(f.device); restored.set_state(saved);
    new DataView(f.ram.buffer).setUint32(0x800C, 42, true); restored.run();
    assert.equal(restored.read(0xC00048), 99, "acquire resumes after snapshot and CPU release");
    assert.equal(new DataView(f.ram.buffer).getUint32(0x800C, true), 77, "semaphore release writes DMA memory");
    assert.equal(f.regs.get(0x3254) & 0x10, 0);
}
{
    const f = fixture(); f.object(0x45000, 0x2303D, 4095, 0x8002);
    f.handle(0x77, 0x45000, 0, 0); f.handle(0x77, 0x45000, 0, 1);
    f.submit([header(0x60, 3), 0x77, 12, 42, header(0x50), 99]);
    const other = [header(0x60, 2), 0x77, 12, header(0x6C), 42, header(0x50), 17];
    other.forEach((w, i) => new DataView(f.ram.buffer).setUint32(0x5000 + i * 4, w >>> 0, true));
    f.fifo.write(0xC01040, other.length * 4); f.fifo.run();
    assert.equal(f.fifo.read(0xC00048), 99, "another channel can release a waiting channel's semaphore");
    assert.equal(f.fifo.read(0xC01048), 17);
}
for(const [words, code] of [[[0x20000], 3], [[2, 2], 1], [[0xE0000000], 4], [[header(0x40), 1], 2]])
{
    const f = fixture(); f.submit(words);
    assert.equal(f.regs.get(0x3228) >>> 29, code);
    assert(f.regs.get(0x2100) & 0x1000); assert(f.regs.get(0x3220) & 0x1000);
}
{
    const f = fixture(); f.regs.set(0x3250, 0);
    f.submit([header(0x50, 600, 0, true), ...Array.from({ length: 600 }, (_, i) => i + 1)]);
    for(let i = 0; i < 600; i++) f.fifo.run();
    assert.equal(f.fifo.read(0x3214), 0x100, "disabled puller fills cache and stops pusher");
    assert(f.fifo.read(0xC00044) < 601 * 4); assert.equal(f.fifo.read(0xC00048), 0);
    assert.equal(f.fifo.read(0x90004),1);assert.equal(f.fifo.read(0x90FFC),512,"NV40 upper cache entries do not alias the lower half");
    f.regs.set(0x3250, 1); f.fifo.run();
    assert.equal(f.fifo.read(0xC00048), 600); assert.equal(f.fifo.read(0xC00044), 601 * 4);
}
{
    const f = fixture(); f.submit([0x20000000], 32);
    assert.equal(f.fifo.read(0xC00044), 0, "self-jump yields at budget");
    assert.equal((f.regs.get(0x3228) || 0) >>> 29, 0);
    const m = fixture(); m.word(0x40004, 2); m.submit([header(0x50), 3]);
    assert.equal(m.regs.get(0x3228) >>> 29, 6, "pushbuffer DMA limit fault");
    assert.match(m.fifo.faults.at(-1).reason,/limit exceeded/);
    assert.equal(m.fifo.faults.at(-1).dma,0x40000);
}
console.log("PASS: NV40 RAMFC channels, DMA pusher flow/error/budget, RAMHT, REF and semaphore snapshot/resume");

{
    const f=fixture();f.fifo.write(0x90000,0x50);f.fifo.write(0x90004,202);
    f.fifo.write(0x907F8,0x50);f.fifo.write(0x907FC,101);
    f.regs.set(0x3270,0x3FC);f.regs.set(0x3210,0x404);
    f.fifo.set_state([1,0,[]]);
    assert.equal(f.fifo.read(0x90804),202,"old snapshot queue crossing the 256-entry wrap is relocated");
    f.fifo.drain();assert.equal(f.fifo.read(0xC00048),202);assert.equal(f.regs.get(0x3270),0x404);
    const g=fixture();g.regs.set(0x3210,0xFFC);g.regs.set(0x3270,0xFFC);
    g.submit([header(0x50,2,0,true),17,31]);
    assert.equal(g.regs.get(0x3210),4);assert.equal(g.regs.get(0x3270),4);assert.equal(g.regs.get(0x3248),31);
    g.fifo.write(0x90004,123);assert.equal(g.fifo.read(0x91004),123,"upper cache aperture is the whole-array alias");
}

{
    const {fifo}=fixture();for(let i=0;i<70;i++)fifo.fault(i&7);
    assert.equal(fifo.faults.length,64);assert.equal(fifo.faults[0].flags,6);
    assert.equal(fifo.faults.at(-1).kind,"dma");fifo.cache_error(0x100);
    assert.equal(fifo.faults.length,64);assert.equal(fifo.faults.at(-1).kind,"cache");
    const state=fifo.get_state();fifo.set_state(state);assert.equal(fifo.faults.length,64,"diagnostics survive guest resets but are not hardware snapshot fields");
}

{
    const f=fixture();f.submit([0x82],1); // CALL to byte 128, budget stops before the callee.
    assert.equal(f.fifo.read(0xC00044),128);assert.equal(f.fifo.read(0xC00054),4);
    const other=new DataView(f.ram.buffer);other.setUint32(0x5000,header(0x50),true);other.setUint32(0x5004,7,true);
    f.regs.set(0x2504,2);f.fifo.write(0xC01040,8);
    assert.equal(f.fifo.active,1);assert.equal(f.fifo.read(0xC00044),128);
    assert.equal(f.fifo.read(0xC00054),4,"inactive CGET reports the saved main-buffer return address, not the callee GET");
    const saved=f.fifo.get_state();f.fifo.set_state(saved);assert.equal(f.fifo.read(0xC00054),4);
}
