// UDIF disk images, the DMG format of the root filesystem (docs/iphone4-plan.md
// S0): the data fork (the partitions' chunks, each raw, zero-filled or
// compressed), an XML plist whose resource fork's "blkx" entries describe
// one partition each (a "mish" block: its first sector and size, then its
// chunks: type, sectors, where the bytes are in the data fork), and a
// 512-byte "koly" trailer at the very end (big-endian) that says where the
// data fork and the plist are. The root filesystem's DMG is an Apple
// partition map whose "Apple_HFSX" partition is the system volume.

import { u32be, u64be, latin1 } from "../android/bytes.js";
import { plist_parse } from "./plist.js";

export const CHUNK = { ZERO: 0, RAW: 1, IGNORE: 2, ADC: 0x80000004, ZLIB: 0x80000005, BZIP2: 0x80000006, LZFSE: 0x80000007,
    COMMENT: 0x7FFFFFFE, END: 0xFFFFFFFF };

/**
 * @param {!Uint8Array} bytes the image's last 512 bytes
 * @return {{data_fork_offset: number, data_fork_length: number, xml_offset: number, xml_length: number, sectors: number}}
 */
export function udif_trailer(bytes)
{
    if(bytes.length !== 512 || latin1(bytes, 0, 4) !== "koly") throw new Error("DMG: no koly trailer");
    return {
        data_fork_offset: u64be(bytes, 0x18), data_fork_length: u64be(bytes, 0x20),
        xml_offset: u64be(bytes, 0xD8), xml_length: u64be(bytes, 0xE0),
        sectors: u64be(bytes, 0x1EC),
    };
}

/**
 * A partition's "mish" block
 * @param {!Uint8Array} b
 * @return {{first_sector: number, sectors: number, data_offset: number, chunks: !Array<{type: number, sector: number, sectors: number, offset: number, length: number}>}}
 */
export function udif_mish(b)
{
    if(b.length < 0xCC || latin1(b, 0, 4) !== "mish") throw new Error("DMG: a blkx entry without its mish block");
    const count = u32be(b, 0xC8);
    if(0xCC + 40 * count > b.length) throw new Error("DMG: a mish block cut short");
    const chunks = [];
    for(let i = 0; i < count; i++)
    {
        const at = 0xCC + 40 * i;
        chunks.push({ type: u32be(b, at), sector: u64be(b, at + 8), sectors: u64be(b, at + 16), offset: u64be(b, at + 24), length: u64be(b, at + 32) });
    }
    return { first_sector: u64be(b, 8), sectors: u64be(b, 0x10), data_offset: u64be(b, 0x18), chunks };
}

/**
 * The image's partitions, from its plist
 * @param {!Uint8Array} xml
 * @return {!Array<{name: string, id: number, first_sector: number, sectors: number, data_offset: number, chunks: !Array<Object>}>}
 */
export function udif_partitions(xml)
{
    const blkx = plist_parse(xml)?.["resource-fork"]?.blkx;
    if(!Array.isArray(blkx)) throw new Error("DMG: no blkx entries in the plist");
    return blkx.map(entry => ({ name: entry.Name || entry.CFName || "", id: +entry.ID, ...udif_mish(entry.Data) }));
}

/**
 * zlib (RFC 1950) inflated
 * @param {!Uint8Array} bytes
 * @return {!Promise<!Uint8Array>}
 */
export async function inflate_zlib(bytes)
{
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * A partition's sectors out of the image's bytes written in order from the
 * start (a stream, as the root filesystem's decryption gives them):
 * out(offset, bytes) gets each data chunk's bytes at its offset in the
 * partition, in order (awaited); zero-filled and free chunks are left out
 * (the target reads as zeros there). end() checks every chunk came
 * @param {{first_sector: number, sectors: number, data_offset: number, chunks: !Array<Object>}} partition
 * @param {function(number, !Uint8Array): (Promise|undefined)} out
 * @param {number=} data_fork_offset the trailer's
 * @return {{write: function(!Uint8Array): !Promise, end: function(): !Promise}}
 */
export function udif_partition_stream(partition, out, data_fork_offset = 0)
{
    const chunks = partition.chunks.filter(c => c.type !== CHUNK.ZERO && c.type !== CHUNK.IGNORE &&
        c.type !== CHUNK.COMMENT && c.type !== CHUNK.END).sort((a, b) => a.offset - b.offset);
    for(const c of chunks)
    {
        if(c.type !== CHUNK.RAW && c.type !== CHUNK.ZLIB) throw new Error(`DMG: chunks of type 0x${c.type.toString(16)} are not supported`);
    }
    const base = data_fork_offset + partition.data_offset;
    let index = 0, position = 0, buffer = null, filled = 0;
    const finish = async () =>
    {
        const c = chunks[index++];
        const data = c.type === CHUNK.ZLIB ? await inflate_zlib(buffer) : buffer;
        if(data.length !== c.sectors * 512) throw new Error(`DMG: a chunk at sector ${c.sector} gives ${data.length} bytes, not ${c.sectors * 512}`);
        await out(c.sector * 512, data);
        buffer = null;
        filled = 0;
    };
    return {
        async write(bytes)
        {
            for(let at = 0; at < bytes.length && index < chunks.length;)
            {
                const c = chunks[index], start = base + c.offset;
                if(position < start)
                {
                    const skip = Math.min(bytes.length - at, start - position);
                    at += skip;
                    position += skip;
                    continue;
                }
                if(position > start) throw new Error("DMG: chunks overlap");
                if(!buffer) buffer = new Uint8Array(c.length);
                const n = Math.min(bytes.length - at, c.length - filled);
                buffer.set(bytes.subarray(at, at + n), filled);
                filled += n;
                at += n;
                if(filled === c.length)
                {
                    position += c.length;
                    await finish();
                }
            }
            if(index >= chunks.length) position += bytes.length;
        },
        async end()
        {
            if(index < chunks.length) throw new Error(`DMG: ${chunks.length - index} chunks missing, the image is cut short`);
        },
    };
}
