// Raw N90 NAND medium. Four Samsung EC D7 94 72 chips, two per FMI.
// Each sector-aligned slot holds the complemented data and OOB. Host
// filesystem holes thus read as erased flash without allocating 17 GiB.
import { restore_disk_state } from "../disk_writeback.js";
import { BlockBackend } from "../block_backend.js";
import { begin_state_io } from "../state_io.js";
import { dt_find, dt_property, dt_set } from "./devicetree.js";
import { NAND_DATA, NAND_SPARE, NAND_PAGE, NAND_SLOT, NAND_BLOCK_PAGES, NAND_BLOCKS, NAND_BYTES,
    NAND_NVRAM_ENTRY, NAND_PARTITION_BLOCK_MAPPED, nand_offset } from "./nand_geometry.js";
export { NAND_DATA, NAND_SPARE, NAND_PAGE, NAND_SLOT, NAND_BLOCK_PAGES, NAND_BLOCKS, NAND_ROWS, NAND_BYTES, nand_offset } from "./nand_geometry.js";

const READ_SPAN = 16 * NAND_SLOT;

function all_zero(bytes)
{
    // YAFTL recovery can erase thousands of already empty 1 MiB blocks.
    // Scan machine words and avoid a callback for every byte of every block.
    let at = 0;
    if(!(bytes.byteOffset & 3))
    {
        const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length >>> 2);
        for(let i = 0; i < words.length; i++) if(words[i]) return false;
        at = words.length * 4;
    }
    for(; at < bytes.length; at++) if(bytes[at]) return false;
    return true;
}

export function configure_nand_tree(tree)
{
    const flash = dt_find(tree, "/arm-io/flash-controller0/disk"), io = dt_find(tree, "/arm-io");
    if(!flash || !io) throw new Error("missing N90 flash device-tree nodes");
    const ids = new Uint8Array(256);
    for(let bus = 0; bus < 2; bus++)
        for(let ce = 0; ce < 2; ce++) ids.set([0xEC, 0xD7, 0x94, 0x72], 8 * (16 * bus + ce));
    dt_set(flash, "dbg-chipids", ids);
    // dbg-chipids reserves sixteen IDs per bus, but AppleIOPFMI uses eight
    // bits per bus in ce-bitmap when enumerating its logical chips.
    const properties = { "#ce": 4, "#databus": 2, "ce-bitmap": 0x303, "#ce-blocks": NAND_BLOCKS,
        "#block-pages": NAND_BLOCK_PAGES, "#page-bytes": NAND_DATA, "#spare-bytes": NAND_SPARE, "#die-ce": 1,
        "logical-page-size": 4096, "meta-per-logical-page": 12, "valid-meta-per-logical-page": 12,
        "ecc-correctable": 8, "ecc-threshold": 8, "block-bits": 13, "page-bits": 7,
        "bbt-format": 8, "vendor-type": 0x10001, "max-transaction-size": 65536 };
    for(const [name, value] of Object.entries(properties))
    {
        const cell = new Uint8Array(4);
        new DataView(cell.buffer).setUint32(0, value, true);
        dt_set(flash, name, cell);
    }
    const source = dt_property(io, "clock-frequencies");
    if(!source || source.value.length < 0x22 * 4) throw new Error("missing NAND clock slot");
    const clocks = source.value.slice();
    new DataView(clocks.buffer, clocks.byteOffset).setUint32(0x21 * 4, 100000000, true);
    dt_set(io, "clock-frequencies", clocks);
}

export class AppleNAND
{
    constructor(cpu, buffer)
    {
        if(buffer.byteLength !== NAND_BYTES) throw new Error("N90 NAND image size must be " + NAND_BYTES);
        this.buffer = buffer;
        this.cpu = cpu;
        this.backend = new BlockBackend(cpu, buffer);
        this.read_cache = new Array(4).fill(null);
        this.queues = Array.from({ length: 4 }, () => []);
    }

    // Program and erase are read/modify/write host operations. A native
    // verify read can arrive as soon as the sequencer has sent the command.
    // Once a mutation is issued, order subsequent operations on that chip
    // behind it so verify never reads an old range or the erased base.
    enqueue(chip, start, done, fail)
    {
        const queue = this.queues[chip], release = begin_state_io(this.cpu);
        const finish = (callback, result) => {
            if(queue[0] !== task) return;
            try { callback(result); }
            finally
            {
                release();
                if(queue[0] === task) { queue.shift(); queue[0]?.start(); }
            }
        };
        const task = { release, start: () => start(value => finish(done, value), error => finish(fail, error)) };
        queue.push(task);
        if(queue.length === 1) task.start();
    }

    read(bus, ce, row, done, fail)
    {
        const offset = nand_offset(bus, ce, row);
        if(offset < 0) { fail(new Error("NAND page outside medium")); return; }
        const chip = bus * 2 + ce;
        if(this.queues[chip].length) this.enqueue(chip, (ok, err) => this.read_page(chip, offset, ok, err), done, fail);
        else this.read_page(chip, offset, done, fail);
    }

    read_page(chip, offset, done, fail)
    {
        const start = offset - offset % READ_SPAN, at = offset - start;
        const deliver = bytes => {
            if(bytes.length < NAND_SLOT) { fail(new Error("short NAND page")); return; }
            const page = new Uint8Array(NAND_PAGE);
            for(let i = 0; i < page.length; i++) page[i] = ~bytes[i];
            if(offset <= NAND_SLOT)
            {
                // Earlier v86 images described these two NVRAM blocks as
                // boot pages. Supply the block geometry to IOFlashNVRAM
                // on either Grdn copy without rewriting an existing disk.
                const table = new DataView(page.buffer), entry = NAND_NVRAM_ENTRY;
                if(table.getUint32(0, true) === 0x4772646E &&
                    table.getUint32(0x224, true) === 0xDEADCAFE &&
                    table.getUint32(entry, true) === 0x6E76726D &&
                    table.getUint32(entry + 4, true) === 5 &&
                    table.getUint32(entry + 8, true) === 2 &&
                    table.getUint32(entry + 12, true) === 0)
                {
                    table.setUint32(entry + 12, NAND_PARTITION_BLOCK_MAPPED, true);
                }
            }
            done(page);
        };
        // A native scattered read streams adjacent rows from all four
        // chips. Keep just one raw range per chip, outside the snapshot.
        const hit = this.read_cache[chip];
        if(hit?.start === start && hit.bytes && at + NAND_SLOT <= hit.bytes.length)
        {
            deliver(hit.bytes.subarray(at));
            return;
        }
        const entry = { start, bytes: null };
        this.read_cache[chip] = entry;
        const exact = () => this.backend.read(offset, NAND_SLOT, deliver, fail);
        this.backend.read_ahead(start, READ_SPAN, bytes => {
            if(at + NAND_SLOT > bytes.length) { exact(); return; }
            entry.bytes = new Uint8Array(bytes);
            deliver(entry.bytes.subarray(at));
        }, exact);
    }

    write(bus, ce, offset, bytes, done, fail)
    {
        const chip = bus * 2 + ce;
        this.read_cache[chip] = null;
        this.backend.write(offset, bytes, () => {
            // An overlapping read may have populated a range during the write.
            this.read_cache[chip] = null;
            done();
        }, fail);
    }

    program(bus, ce, row, page, done, fail)
    {
        const offset = nand_offset(bus, ce, row);
        if(offset < 0 || page.length !== NAND_PAGE) { fail(new Error("invalid NAND program")); return; }
        // Physical programming only clears bits. The file stores their
        // complement, so reprogramming an existing page ORs its slot.
        this.enqueue(bus * 2 + ce, (ok, err) => this.backend.read(offset, NAND_SLOT, old => {
            if(old.length !== NAND_SLOT) { err(new Error("short NAND page")); return; }
            const slot = new Uint8Array(old);
            for(let i = 0; i < page.length; i++) slot[i] |= ~page[i];
            this.write(bus, ce, offset, slot, ok, err);
        }, err), done, fail);
    }

    erase(bus, ce, row, done, fail)
    {
        const offset = nand_offset(bus, ce, row - row % NAND_BLOCK_PAGES);
        if(!Number.isInteger(row) || row < 0 || offset < 0) { fail(new Error("invalid NAND erase")); return; }
        const length = NAND_BLOCK_PAGES * NAND_SLOT;
        this.enqueue(bus * 2 + ce, (ok, err) => this.backend.read(offset, length, bytes => {
            if(bytes.length !== length) { err(new Error("short NAND block")); return; }
            // Sparse holes already contain complemented erased flash. Native
            // recovery may erase thousands of free blocks: don't materialize
            // gigabytes of identical zeroes in the disk overlay.
            if(all_zero(bytes))
            {
                this.read_cache[bus * 2 + ce] = null;
                ok();
            }
            else this.write(bus, ce, offset, new Uint8Array(length), ok, err);
        }, err), done, fail);
    }

    reset()
    {
        for(const queue of this.queues)
        {
            for(const task of queue) task.release();
            queue.length = 0;
        }
        this.read_cache.fill(null);
        this.backend.reset();
    }
    get_state() { return [this.buffer]; }
    set_state(state) { this.reset(); restore_disk_state(this.buffer, state[0]); }
}
