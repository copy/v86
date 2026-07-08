#!/usr/bin/env node

// Regression test for the bounded, write-back-capable block_cache added to
// AsyncXHRBuffer (src/buffer.js). Unlike the other tests in this directory,
// this does not boot a VM — it exercises the disk-buffer layer directly,
// so it's fast and has no image/kernel dependencies.
//
// Covers:
//  - default (no max_cache_bytes) behaviour is unchanged: block_cache
//    grows unbounded, exactly like upstream.
//  - with max_cache_bytes set, block_cache is kept near the configured
//    cap once enough distinct blocks have been written.
//  - every byte ever written is durably present in the backing file after
//    eviction and/or an explicit flush() — i.e. bounding the cache never
//    loses data, it only relocates it from memory to disk.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { buffer_from_object } = await import(
    TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/buffer.js"
);

function write(buf, start, byte, len)
{
    return new Promise(resolve => buf.set(start, new Uint8Array(len).fill(byte), resolve));
}

function read(buf, start, len)
{
    return new Promise(resolve => buf.get(start, len, block => resolve(Uint8Array.from(block))));
}

async function settle(buf)
{
    while(buf.flush_in_progress)
    {
        await buf.flush_in_progress;
    }
}

async function test_default_is_unbounded()
{
    const name = "default (no max_cache_bytes) is unbounded";
    const file = path.join(os.tmpdir(), "v86-test-unbounded-" + process.pid + ".img");
    const DISK_SIZE = 4096;

    fs.writeFileSync(file, Buffer.alloc(DISK_SIZE));

    try
    {
        const buf = buffer_from_object({ url: file, size: DISK_SIZE, async: true });

        for(let i = 0; i < DISK_SIZE / 256; i++)
        {
            await write(buf, i * 256, i, 256);
        }

        if(buf.block_cache.size !== DISK_SIZE / 256)
        {
            throw new Error("expected all " + (DISK_SIZE / 256) + " blocks cached, got " + buf.block_cache.size);
        }

        console.log("Done: " + name);
    }
    finally
    {
        fs.unlinkSync(file);
    }
}

async function test_bounded_cache_evicts_and_persists()
{
    const name = "bounded cache evicts and persists writes to disk";
    const file = path.join(os.tmpdir(), "v86-test-bounded-" + process.pid + ".img");
    const DISK_SIZE = 4096; // 16 blocks of BLOCK_SIZE (256 bytes)
    const MAX_CACHE_BYTES = 2048; // 8 blocks

    fs.writeFileSync(file, Buffer.alloc(DISK_SIZE));

    try
    {
        const buf = buffer_from_object({
            url: file,
            size: DISK_SIZE,
            async: true,
            max_cache_bytes: MAX_CACHE_BYTES,
        });

        // Write every block with a distinct, identifiable pattern.
        for(let i = 0; i < DISK_SIZE / 256; i++)
        {
            await write(buf, i * 256, i, 256);
        }

        await settle(buf);

        const cache_bytes = buf.block_cache.size * 256;
        if(cache_bytes > MAX_CACHE_BYTES)
        {
            throw new Error("cache grew past its bound: " + cache_bytes + " > " + MAX_CACHE_BYTES);
        }

        // Reads through the *same* buffer must still return correct data,
        // whether the block happens to still be cached or was evicted and
        // needs to be re-read from disk.
        for(let i = 0; i < DISK_SIZE / 256; i++)
        {
            const block = await read(buf, i * 256, 256);
            for(const byte of block)
            {
                if(byte !== i)
                {
                    throw new Error("block " + i + " corrupted after eviction (same buffer)");
                }
            }
        }

        // A full flush() must drain the cache entirely.
        await buf.flush();
        if(buf.block_cache.size !== 0)
        {
            throw new Error("flush() left " + buf.block_cache.size + " entries cached");
        }

        // Simulate a process restart: a brand new buffer instance backed
        // by the same file must see every write that was ever made,
        // proving eviction persisted data rather than discarding it.
        const buf2 = buffer_from_object({ url: file, size: DISK_SIZE, async: true });
        for(let i = 0; i < DISK_SIZE / 256; i++)
        {
            const block = await read(buf2, i * 256, 256);
            for(const byte of block)
            {
                if(byte !== i)
                {
                    throw new Error("block " + i + " lost/corrupted on disk after eviction+flush");
                }
            }
        }

        console.log("Done: " + name);
    }
    finally
    {
        fs.unlinkSync(file);
    }
}

async function test_large_flush_is_fast()
{
    // Regression test: writing/evicting many BLOCK_SIZE-granularity entries
    // must not issue one fs write syscall per 256-byte block — that does
    // not scale (e.g. hydrating a real workspace onto hdb can touch
    // hundreds of thousands of blocks) and made an early version of this
    // patch's flush() take 20+ seconds for a 200MB write burst instead of
    // a few hundred milliseconds. Writes are coalesced into contiguous
    // ranges (see coalesce_writes in buffer.js) wherever possible.
    const name = "large sequential write + flush completes quickly (writes are coalesced)";
    const file = path.join(os.tmpdir(), "v86-test-perf-" + process.pid + ".img");
    const DISK_SIZE = 8 * 1024 * 1024; // 8 MiB
    const MAX_CACHE_BYTES = 1 * 1024 * 1024;

    const fd = fs.openSync(file, "w");
    fs.ftruncateSync(fd, DISK_SIZE);
    fs.closeSync(fd);

    try
    {
        const buf = buffer_from_object({
            url: file,
            size: DISK_SIZE,
            async: true,
            max_cache_bytes: MAX_CACHE_BYTES,
        });

        const CHUNK = 64 * 1024;
        const t0 = Date.now();
        for(let off = 0; off < DISK_SIZE; off += CHUNK)
        {
            await write(buf, off, (off / CHUNK) & 0xff, CHUNK);
        }
        await settle(buf);
        await buf.flush();
        const elapsed_ms = Date.now() - t0;

        // Generous bound: this should take well under a second; 5s gives
        // ample headroom on slow/loaded CI machines while still catching
        // an accidental regression back to per-block syscalls (which took
        // >20s for a 200MB write in manual testing, i.e. orders of
        // magnitude slower than this bound for even this smaller size).
        if(elapsed_ms > 5000)
        {
            throw new Error("write+evict+flush of " + (DISK_SIZE / 1024 / 1024) +
                "MB took " + elapsed_ms + "ms — coalescing regression?");
        }

        if(buf.block_cache.size !== 0)
        {
            throw new Error("flush() left " + buf.block_cache.size + " entries cached");
        }

        console.log("Done: " + name + " (" + elapsed_ms + "ms)");
    }
    finally
    {
        fs.unlinkSync(file);
    }
}

(async function()
{
    await test_default_is_unbounded();
    await test_bounded_cache_evicts_and_persists();
    await test_large_flush_is_fast();
    console.log("All bounded-disk-cache tests passed.");
})().catch(e =>
{
    console.error(e);
    process.exit(1);
});
