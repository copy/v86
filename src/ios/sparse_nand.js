// Packed N90 NAND for browser storage. The logical medium still has the
// four raw chips. Only written ranges occupy space in the host file, so
// OPFS quotas do not charge for the factory-erased capacity.
import { NAND_BYTES, NAND_SLOT } from "../apple/nand_geometry.js";

const MAGIC = new TextEncoder().encode("V86N90S1");
const CHUNK = NAND_SLOT * 16, COUNT = NAND_BYTES / CHUNK;
const HEADER = 512, INDEX = COUNT * 4, DATA = Math.ceil((HEADER + INDEX) / 512) * 512;

export function open_sparse_nand(access, create = false)
{
    function read(at, bytes)
    {
        if(access["read"](bytes, { "at": at }) !== bytes.length) throw new Error("Short read from sparse iPhone NAND");
    }
    function write(at, bytes)
    {
        for(let n = 0; n < bytes.length;)
        {
            const done = access["write"](bytes.subarray(n), { "at": at + n });
            if(!done) throw new Error("Short write to sparse iPhone NAND");
            n += done;
        }
    }

    const header = new Uint8Array(HEADER), index = new Uint8Array(INDEX);
    const hv = new DataView(header.buffer), map = new DataView(index.buffer);
    let allocated = 0;
    if(create)
    {
        access["truncate"](0);
        header.set(MAGIC);
        hv.setUint32(8, CHUNK, true);
        hv.setUint32(12, COUNT, true);
        access["truncate"](DATA);
        write(0, header);
    }
    else
    {
        const size = access["getSize"]();
        if(size < HEADER) return null;
        read(0, header);
        if(!MAGIC.every((byte, i) => header[i] === byte)) return null;
        allocated = (size - DATA) / CHUNK;
        if(hv.getUint32(8, true) !== CHUNK || hv.getUint32(12, true) !== COUNT ||
            !Number.isInteger(allocated) || allocated < 0 || allocated > COUNT)
            throw new Error("Invalid sparse iPhone NAND geometry");
        read(HEADER, index);
        const used = new Set();
        for(let i = 0; i < COUNT; i++)
        {
            const slot = map.getUint32(i * 4, true);
            if(slot > allocated || slot && used.has(slot)) throw new Error("Invalid sparse iPhone NAND index");
            if(slot) used.add(slot);
        }
    }
    const slot_offset = (slot, within) => DATA + (slot - 1) * CHUNK + within;
    const update = new Uint8Array(4), uv = new DataView(update.buffer);
    function visit(at, bytes, step)
    {
        if(!Number.isSafeInteger(at) || at < 0 || at + bytes.length > NAND_BYTES) throw new Error("Outside iPhone NAND");
        for(let done = 0; done < bytes.length;)
        {
            const start = at + done, n = Math.floor(start / CHUNK), within = start % CHUNK;
            const length = Math.min(bytes.length - done, CHUNK - within);
            step(n, within, bytes.subarray(done, done + length));
            done += length;
        }
    }
    return {
        size: NAND_BYTES,
        read(at, length) {
            const bytes = new Uint8Array(length);
            visit(at, bytes, (n, within, part) => {
                const slot = map.getUint32(n * 4, true);
                if(slot) read(slot_offset(slot, within), part);
            });
            return bytes;
        },
        write(at, bytes) {
            visit(at, bytes, (n, within, part) => {
                let slot = map.getUint32(n * 4, true);
                if(slot) { write(slot_offset(slot, within), part); return; }
                if(part.every(byte => !byte)) return; // untouched NAND reads as complemented erase
                if(allocated >= COUNT) throw new Error("The sparse iPhone NAND index is full");
                slot = allocated + 1;
                access["truncate"](DATA + slot * CHUNK);
                try
                {
                    write(slot_offset(slot, within), part);
                    uv.setUint32(0, slot, true);
                    write(HEADER + n * 4, update);
                    map.setUint32(n * 4, slot, true);
                    allocated = slot;
                }
                catch(error)
                {
                    // Restore the unused slot if a host write was incomplete.
                    uv.setUint32(0, 0, true);
                    write(HEADER + n * 4, update);
                    access["truncate"](DATA + allocated * CHUNK);
                    throw error;
                }
            });
        },
    };
}
