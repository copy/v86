// Android sparse images (system/core/libsparse: sparse_format.h)
// (docs/android-images-plan.md I1). The image is read through
// read(offset, length), which returns the bytes (fewer at its end).

import { u16, u32, copy, concat } from "./bytes.js";

const SPARSE_MAGIC = 0xED26FF3A;
const CHUNK_RAW = 0xCAC1, CHUNK_FILL = 0xCAC2, CHUNK_DONT_CARE = 0xCAC3, CHUNK_CRC32 = 0xCAC4;

/**
 * @param {function(number, number): !Uint8Array} read
 * @return {boolean}
 */
export function is_sparse(read)
{
    const head = read(0, 4);
    return head.length === 4 && u32(head, 0) === SPARSE_MAGIC;
}

/**
 * The sparse header
 * @param {function(number, number): !Uint8Array} read
 * @return {{file_header_size: number, chunk_header_size: number, block_size: number, total_blocks: number, total_chunks: number}}
 */
export function sparse_header(read)
{
    const header = read(0, 28);
    if(u32(header, 0) !== SPARSE_MAGIC) throw new Error("not a sparse image");
    return { file_header_size: u16(header, 8), chunk_header_size: u16(header, 10), block_size: u32(header, 12),
        total_blocks: u32(header, 16), total_chunks: u32(header, 20) };
}

/**
 * The raw size of a sparse image
 * @param {function(number, number): !Uint8Array} read
 * @return {number}
 */
export function sparse_size(read)
{
    const h = sparse_header(read);
    return h.block_size * h.total_blocks;
}

/**
 * A sparse image's raw contents as writes: write(offset, bytes) for data
 * and non-zero fills (zero fills and "don't care" are left out: the target
 * reads as zero there); returns the raw size
 * @param {function(number, number): !Uint8Array} read
 * @param {function(number, !Uint8Array)} write
 * @param {number=} piece the largest write
 * @return {number}
 */
export function unsparse(read, write, piece = 64 << 20)
{
    const h = sparse_header(read);
    let position = h.file_header_size, block = 0;
    for(let i = 0; i < h.total_chunks; i++)
    {
        const chunk_header = read(position, h.chunk_header_size);
        const type = u16(chunk_header, 0), blocks = u32(chunk_header, 4), total = u32(chunk_header, 8);
        const data_position = position + h.chunk_header_size, bytes = blocks * h.block_size;
        const at = block * h.block_size;
        if(type === CHUNK_RAW)
        {
            for(let done = 0; done < bytes;)
            {
                const n = Math.min(piece, bytes - done);
                write(at + done, read(data_position + done, n));
                done += n;
            }
        }
        else if(type === CHUNK_FILL)
        {
            const fill = read(data_position, 4);
            if(u32(fill, 0) !== 0)
            {
                const pattern = new Uint8Array(Math.min(piece, bytes));
                for(let j = 0; j < pattern.length; j += 4) pattern.set(fill, j);
                for(let done = 0; done < bytes; done += pattern.length) write(at + done, pattern.subarray(0, Math.min(pattern.length, bytes - done)));
            }
        }
        else if(type !== CHUNK_DONT_CARE && type !== CHUNK_CRC32) throw new Error(`sparse image: chunk type ${type.toString(16)}`);
        block += type === CHUNK_CRC32 ? 0 : blocks;
        position += total;
    }
    if(block !== h.total_blocks) throw new Error(`sparse image: ${block} of ${h.total_blocks} blocks`);
    return h.total_blocks * h.block_size;
}

/**
 * Bytes [offset, offset + length) of a sparse image's raw contents
 * @param {function(number, number): !Uint8Array} read
 * @param {number} offset
 * @param {number} length
 * @return {!Uint8Array}
 */
export function sparse_read(read, offset, length)
{
    const out = new Uint8Array(length);
    const h = sparse_header(read);
    for(let i = 0, position = h.file_header_size, at = 0; i < h.total_chunks && at < offset + length; i++)
    {
        const chunk_header = read(position, h.chunk_header_size);
        const type = u16(chunk_header, 0), bytes = type === CHUNK_CRC32 ? 0 : u32(chunk_header, 4) * h.block_size;
        const data = position + h.chunk_header_size, from = Math.max(at, offset), to = Math.min(at + bytes, offset + length);
        if(from < to && type === CHUNK_RAW) out.set(read(data + from - at, to - from), from - offset);
        else if(from < to && type === CHUNK_FILL)
        {
            const fill = read(data, 4);
            for(let j = from; j < to; j++) out[j - offset] = fill[(j - at) % 4];
        }
        at += bytes;
        position += u32(chunk_header, 8);
    }
    return out;
}

/**
 * A sparse image's raw contents from its bytes in order (a stream: a zip
 * member as it inflates): push(bytes) as they come, end() when they are all
 * there (returns the raw size). As unsparse, write(offset, bytes) for data
 * and non-zero fills, synchronously (bytes may be a view of push's);
 * size(): the raw size once the header is in (else -1)
 * @param {function(number, !Uint8Array)} write
 * @param {number=} piece the largest fill write
 * @return {{push: function(!Uint8Array), end: function(): number, size: function(): number}}
 */
export function sparse_decoder(write, piece = 16 << 20)
{
    // states: "file" (the header), "skip" (bytes to pass over), "chunk" (a
    // chunk's header), "raw" (its data), "fill" (its pattern), "done"
    let state = "file", need = 28, held = [], held_length = 0, left = 0;
    let h = null, chunks_left = 0, block = 0, type = 0, blocks = 0, data_size = 0;
    const next_chunk = () =>
    {
        if(chunks_left) { state = "chunk"; need = h.chunk_header_size; }
        else state = "done";
    };
    const skip = n =>
    {
        if(n) { state = "skip"; left = n; }
        else next_chunk();
    };
    const header = b =>
    {
        if(state === "file")
        {
            if(u32(b, 0) !== SPARSE_MAGIC) throw new Error("not a sparse image");
            h = { file_header_size: u16(b, 8), chunk_header_size: u16(b, 10), block_size: u32(b, 12),
                total_blocks: u32(b, 16), total_chunks: u32(b, 20) };
            if(h.file_header_size < 28 || h.chunk_header_size < 12) throw new Error("sparse image: header sizes");
            chunks_left = h.total_chunks;
            skip(h.file_header_size - 28);
        }
        else if(state === "chunk")
        {
            type = u16(b, 0); blocks = u32(b, 4); data_size = u32(b, 8) - h.chunk_header_size;
            chunks_left--;
            if(type === CHUNK_RAW)
            {
                if(data_size !== blocks * h.block_size) throw new Error("sparse image: a raw chunk's size");
                left = data_size;
                if(left) state = "raw";
                else next_chunk();
            }
            else if(type === CHUNK_FILL)
            {
                if(data_size < 4) throw new Error("sparse image: a fill chunk's size");
                state = "fill"; need = 4;
            }
            else if(type === CHUNK_DONT_CARE)
            {
                block += blocks;
                skip(data_size);
            }
            else if(type === CHUNK_CRC32) skip(data_size);
            else throw new Error(`sparse image: chunk type ${type.toString(16)}`);
        }
        else if(state === "fill")
        {
            const bytes = blocks * h.block_size, at = block * h.block_size;
            if(u32(b, 0) !== 0)
            {
                const pattern = new Uint8Array(Math.min(piece, bytes));
                for(let j = 0; j < pattern.length; j += 4) pattern.set(b, j);
                for(let done = 0; done < bytes; done += pattern.length) write(at + done, pattern.subarray(0, Math.min(pattern.length, bytes - done)));
            }
            block += blocks;
            skip(data_size - 4);
        }
    };
    const push = data =>
    {
        for(let i = 0; i < data.length;)
        {
            if(state === "done") throw new Error("sparse image: bytes after its last chunk");
            if(state === "raw" || state === "skip")
            {
                const n = Math.min(left, data.length - i);
                if(state === "raw")
                {
                    write(block * h.block_size + data_size - left, data.subarray(i, i + n));
                    if(n === left) block += blocks;
                }
                left -= n; i += n;
                if(!left) next_chunk();
                continue;
            }
            const n = Math.min(need - held_length, data.length - i);
            held.push(copy(data, i, i + n));
            held_length += n; i += n;
            if(held_length < need) continue;
            const b = held.length === 1 ? held[0] : concat(held);
            held = []; held_length = 0;
            header(b);
        }
    };
    const end = () =>
    {
        if(state !== "done" || block !== h.total_blocks) throw new Error(`sparse image: cut short (${block} of ${h ? h.total_blocks : "?"} blocks)`);
        return h.total_blocks * h.block_size;
    };
    return { push, end, size: () => h ? h.total_blocks * h.block_size : -1 };
}
