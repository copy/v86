// Android sparse images (system/core/libsparse: sparse_format.h)
// (docs/android-images-plan.md I1). The image is read through
// read(offset, length), which returns the bytes (fewer at its end).

import { u16, u32 } from "./bytes.js";

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
