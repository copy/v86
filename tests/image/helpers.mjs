// What the format tests share: reading through a reader, comparing with the
// RAW of qemu-img (whole, 1 MiB at a time, and in random ranges) or with a
// sample's writes, expecting errors.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SAMPLES_DIR, random_generator, expected_from_writes, zstd_decompress } from "./samples.mjs";
import { open_image } from "../../src/image/factory.js";

export const settings = { zstd_decompress };
export const sample_file = name => path.join(SAMPLES_DIR, name);

export function read(reader, offset, length)
{
    return new Promise((resolve, reject) => reader.read(offset, length, (data, error) => error ? reject(error) : resolve(data)));
}

/** open a sample as a local file read in ranges (as an async URL in Node) or from memory */
export function open_sample(name, format, how, extra = {})
{
    const descriptor = how === "memory" ?
        { buffer: new Uint8Array(fs.readFileSync(sample_file(name))).buffer, format, ...extra } :
        { url: sample_file(name), async: true, format, ...extra };
    return open_image("hda", descriptor, settings);
}

/** open bytes from memory (a damaged copy) */
export function open_bytes(bytes, format, extra = {})
{
    return open_image("hda", { buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), format, ...extra }, settings);
}

export async function rejects(promise, pattern, kind)
{
    try
    {
        await promise;
    }
    catch(error)
    {
        assert.match(error.message, pattern);
        if(kind) assert.equal(error.kind, kind, error.message);
        return error;
    }
    assert.fail("expected an error matching " + pattern);
}

export function compare(actual, expected, what)
{
    if(actual.length !== expected.length || Buffer.compare(Buffer.from(actual.buffer, actual.byteOffset, actual.length), Buffer.from(expected)) !== 0)
    {
        let i = 0;
        while(i < actual.length && actual[i] === expected[i]) i++;
        assert.fail(what + ": differs at byte " + i + " (" + actual[i] + " instead of " + expected[i] + ", lengths " +
            actual.length + "/" + expected.length + ")");
    }
}

/**
 * A sample against its RAW reference: whole and in random ranges, as a
 * file and from memory (synchronous); the bytes compared
 */
export async function check_against_reference(manifest, name, format, extra = {})
{
    const sample = manifest.samples[name];
    const reference = fs.readFileSync(sample_file(sample.reference));
    let compared = 0;
    for(const how of ["url", "memory"])
    {
        const reader = await open_sample(name, format, how, extra);
        assert.equal(reader.virtual_size, reference.length, name + ": the virtual size");
        assert.equal(reader.format, format);
        const step = 1 << 20;
        for(let offset = 0; offset < reference.length; offset += step)
        {
            const length = Math.min(step, reference.length - offset);
            compare(await read(reader, offset, length), reference.subarray(offset, offset + length), name + " at " + offset);
            compared += length;
        }
        const next = random_generator(name.length * 77 + (how === "memory" ? 1 : 2));
        const ranges = [[0, 512], [reference.length - 512, 512], [reference.length - 3 * 65536 - 512, 3 * 65536]];
        for(let i = 0; i < 200; i++)
        {
            const length = (1 + next() % 512) * 512;
            const offset = Math.floor(next() / 2 ** 32 * (reference.length - length) / 512) * 512;
            ranges.push([offset, length]);
        }
        for(const [offset, length] of ranges)
        {
            compare(await read(reader, offset, length), reference.subarray(offset, offset + length), name + " range " + offset + "+" + length);
        }
        if(how === "memory")
        {
            let done = false;
            reader.read(0, 4096, () => { done = true; });
            assert.ok(done, name + ": a read from memory is synchronous");
        }
    }
    return compared;
}

/** a large sparse sample: at and around its writes, and zeros elsewhere */
export async function check_writes(manifest, name, format)
{
    const sample = manifest.samples[name];
    const reader = await open_sample(name, format, "url");
    assert.equal(reader.virtual_size, sample.size, name + ": the virtual size");
    for(const [offset, length] of sample.writes)
    {
        for(const [start, size] of [[offset - 4096, length + 8192], [offset + 512, 1024], [offset + length - 512, 512]])
        {
            const from = Math.max(0, start), to = Math.min(sample.size, start + size);
            compare(await read(reader, from, to - from), expected_from_writes(sample, from, to - from), name + " at " + from);
        }
    }
    compare(await read(reader, 1024 ** 3, 65536), new Uint8Array(65536), name + ": unallocated, zeros");
    return reader;
}
