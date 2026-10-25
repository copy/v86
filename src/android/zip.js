// zip archives (APPNOTE.TXT 6.3.10) as Android's images come: the central
// directory (zip64 too), members stored or deflated, inflated as a stream
// (DecompressionStream "deflate-raw") with their CRC-32 checked
// (docs/android-images-plan.md I1, I3). The archive is read through
// read(offset, length), which returns the bytes or a promise of them: a
// File's slices, an OPFS file's or a URL's ranges.

import { u16, u32, u64, latin1, copy, concat, crc32 } from "./bytes.js";

const EOCD = 0x06054B50, EOCD64 = 0x06064B50, EOCD64_LOCATOR = 0x07064B50, CENTRAL = 0x02014B50, LOCAL = 0x04034B50;
const STORED = 0, DEFLATED = 8;

/**
 * The archive's members, in the central directory's order
 * @param {function(number, number): (!Uint8Array|!Promise<!Uint8Array>)} read
 * @param {number} size the archive's
 * @return {!Promise<!Array<{name: string, method: number, flags: number, crc32: number, compressed_size: number, size: number, offset: number}>>}
 */
export async function zip_entries(read, size)
{
    const tail_length = Math.min(size, 22 + 0xFFFF);
    const tail = await read(size - tail_length, tail_length);
    let e = -1;
    for(let i = tail.length - 22; i >= 0; i--) if(u32(tail, i) === EOCD) { e = i; break; }
    if(e < 0) throw new Error("zip: no end of central directory");
    let count = u16(tail, e + 10), directory_size = u32(tail, e + 12), directory = u32(tail, e + 16);
    if(count === 0xFFFF || directory_size === 0xFFFFFFFF || directory === 0xFFFFFFFF)
    {
        const at = size - tail_length + e - 20;
        const locator = at >= 0 ? await read(at, 20) : new Uint8Array(20);
        if(u32(locator, 0) !== EOCD64_LOCATOR) throw new Error("zip: no zip64 end of central directory locator");
        const z = await read(u64(locator, 8), 56);
        if(u32(z, 0) !== EOCD64) throw new Error("zip: no zip64 end of central directory");
        count = u64(z, 32); directory_size = u64(z, 40); directory = u64(z, 48);
    }
    if(directory + directory_size > size) throw new Error("zip: the central directory is beyond the archive");
    const cd = await read(directory, directory_size);
    const entries = [];
    for(let at = 0, i = 0; i < count; i++)
    {
        if(at + 46 > cd.length || u32(cd, at) !== CENTRAL) throw new Error("zip: a broken central directory");
        const flags = u16(cd, at + 8), method = u16(cd, at + 10), crc = u32(cd, at + 16);
        let compressed_size = u32(cd, at + 20), uncompressed_size = u32(cd, at + 24), offset = u32(cd, at + 42);
        const name_length = u16(cd, at + 28), extra_length = u16(cd, at + 30), comment_length = u16(cd, at + 32);
        const name_bytes = cd.subarray(at + 46, at + 46 + name_length);
        const name = flags & 0x800 ? new TextDecoder().decode(name_bytes) : latin1(name_bytes);
        // (zip64's extra field: the fields at their maximum, in this order)
        for(let p = at + 46 + name_length, end = p + extra_length; p + 4 <= end;)
        {
            const id = u16(cd, p), length = u16(cd, p + 2);
            if(id === 1)
            {
                let q = p + 4;
                if(uncompressed_size === 0xFFFFFFFF) { uncompressed_size = u64(cd, q); q += 8; }
                if(compressed_size === 0xFFFFFFFF) { compressed_size = u64(cd, q); q += 8; }
                if(offset === 0xFFFFFFFF) { offset = u64(cd, q); q += 8; }
            }
            p += 4 + length;
        }
        entries.push({ name, method, flags, crc32: crc, compressed_size, size: uncompressed_size, offset });
        at += 46 + name_length + extra_length + comment_length;
    }
    return entries;
}

/**
 * A member's data: where it starts after its local header
 * @param {function(number, number): (!Uint8Array|!Promise<!Uint8Array>)} read
 * @param {!Object} entry zip_entries'
 * @return {!Promise<number>}
 */
async function data_offset(read, entry)
{
    const h = await read(entry.offset, 30);
    if(u32(h, 0) !== LOCAL) throw new Error(`zip: no local header for ${entry.name}`);
    return entry.offset + 30 + u16(h, 26) + u16(h, 28);
}

/**
 * A member's contents in order: sink(bytes) for each piece (awaited); its
 * size and CRC-32 checked against the central directory's. With limit,
 * stops once that many bytes are out (unchecked then). Returns the bytes
 * given to sink
 * @param {function(number, number): (!Uint8Array|!Promise<!Uint8Array>)} read
 * @param {!Object} entry
 * @param {function(!Uint8Array): (Promise|undefined)} sink
 * @param {{chunk: (number|undefined), limit: (number|undefined)}=} options
 * @return {!Promise<number>}
 */
export async function zip_stream(read, entry, sink, options = {})
{
    const chunk = options.chunk || 4 << 20, limit = options.limit === undefined ? Infinity : options.limit;
    if(entry.flags & 1) throw new Error(`zip: ${entry.name} is encrypted`);
    if(entry.method !== STORED && entry.method !== DEFLATED) throw new Error(`zip: ${entry.name}'s method ${entry.method}`);
    const start = await data_offset(read, entry);
    let crc = 0, produced = 0;
    const emit = async bytes =>
    {
        crc = crc32(bytes, crc);
        produced += bytes.length;
        await sink(bytes);
    };
    if(entry.method === STORED)
    {
        for(let done = 0; done < entry.compressed_size && produced < limit;)
        {
            const n = Math.min(chunk, entry.compressed_size - done);
            const bytes = await read(start + done, n);
            if(bytes.length !== n) throw new Error(`zip: ${entry.name} is cut short`);
            await emit(bytes);
            done += n;
        }
    }
    else
    {
        const inflate = new DecompressionStream("deflate-raw");
        const writer = inflate.writable.getWriter(), reader = inflate.readable.getReader();
        let stopped = false, feed_error = null;
        const feeding = (async () =>
        {
            for(let done = 0; done < entry.compressed_size && !stopped;)
            {
                const n = Math.min(chunk, entry.compressed_size - done);
                const bytes = await read(start + done, n);
                if(bytes.length !== n) throw new Error(`zip: ${entry.name} is cut short`);
                await writer.write(bytes);
                done += n;
            }
            if(!stopped) await writer.close();
        })().catch(e =>
        {
            if(!stopped) feed_error = e;
            return writer.abort(e).catch(() => {});
        });
        try
        {
            for(;;)
            {
                const { value, done } = await reader.read();
                if(done) break;
                await emit(value);
                if(produced >= limit)
                {
                    stopped = true;
                    await reader.cancel();
                    break;
                }
            }
        }
        catch(e)
        {
            // (a broken stream, a failed read (the writer aborted with it)
            // or sink's error: the feeding stops at its next write)
            stopped = true;
            await reader.cancel(e).catch(() => {});
            await feeding;
            throw e;
        }
        await feeding;
        if(feed_error) throw feed_error;
    }
    if(limit === Infinity)
    {
        if(produced !== entry.size) throw new Error(`zip: ${entry.name} is ${produced} bytes, the directory says ${entry.size}`);
        if(crc !== entry.crc32) throw new Error(`zip: ${entry.name}'s CRC-32 differs`);
    }
    return produced;
}

/**
 * A member's contents whole (a small one), or its first limit bytes
 * @param {function(number, number): (!Uint8Array|!Promise<!Uint8Array>)} read
 * @param {!Object} entry
 * @param {number=} limit
 * @return {!Promise<!Uint8Array>}
 */
export async function zip_read(read, entry, limit)
{
    const parts = [];
    await zip_stream(read, entry, bytes => { parts.push(copy(bytes)); }, { limit });
    const all = concat(parts);
    return limit === undefined ? all : all.subarray(0, limit);
}
