// An independent reader for the N90 media written by nand_build. Without
// arguments, build a pair of sparse test volumes. With private inputs,
// verify every HFS allocation block against the supplied source volumes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { crc32 } from "node:zlib";

function check(image, sources, synthetic = false)
{
    const fd = fs.openSync(image, "r"), zero = Buffer.alloc(8192);
    try
    {
        const whitening = new Uint32Array(256), sequences = new Map();
        let seed = 0x50F4546A;
        for(let i = 0; i < 256; i++)
        {
            for(let j = 0; j < 763; j++) seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            whitening[i] = seed;
        }
        function physical(chip, row)
        {
            const bytes = Buffer.alloc(8628);
            assert.equal(fs.readSync(fd, bytes, 0, bytes.length, (chip * 4152 * 128 + row) * 8704), bytes.length);
            for(let i = 0; i < bytes.length; i++) bytes[i] ^= 255;
            return bytes;
        }
        const maps = [];
        for(let chip = 0; chip < 4; chip++)
        {
            const context = physical(chip, 15 * 128);
            const start = context.readUInt16LE(0x698), map = new Map();
            for(let i = 0; i < 4152 - start; i++)
            {
                const block = context.readUInt16LE(0x26 + i * 2);
                if(block < 4152) map.set(block, start + i);
            }
            assert.equal(context[0x16], 19);
            for(let block = 0; block < 19; block++)
                assert.equal(map.get(block), 4016 + block, "YAFTL must not share a physical block with the raw boot area");
            maps.push(map);
        }
        function virtual(vpn)
        {
            const chip = (vpn & 1) * 2 + (vpn >>> 1 & 1);
            const block = Math.floor(vpn / 512);
            const row = (maps[chip].get(block) ?? block) * 128 + ((vpn & 511) >>> 2);
            const bytes = physical(chip, row);
            if(block >= 22 && block < 3997 && !bytes.subarray(8192).every(b => b === 255))
            {
                const sequence = (bytes.readUInt32LE(8196) ^ whitening[(row + 1) & 255]) >>> 0;
                assert.equal(sequence, block + 1, "each initial YAFTL block has its own weave sequence");
                assert.ok(!sequences.has(sequence) || sequences.get(sequence) === block);
                sequences.set(sequence, block);
                if((vpn & 511) === 511)
                    assert.ok((bytes[8201] ^ (whitening[(row + 2) & 255] >>> 8)) & 8,
                        "the block TOC must be marked closed for native recovery");
            }
            return bytes;
        }
        const context = physical(0, 15 * 128), control = context.readUInt16LE(0x69A) * 512;
        const state = virtual(control);
        assert.equal(state.toString("ascii", 0, 4), "CX01");
        for(const [blockOffset, cursorOffset, tocPart] of [[12, 0x66, 1], [20, 0x68, 2]])
        {
            const block = state.readUInt32LE(blockOffset), cursor = state.readUInt16LE(cursorOffset);
            assert.equal(state.readUInt32LE(blockOffset + 4), block + 1);
            const toc = virtual(control + tocPart);
            assert.ok(cursor >= 1 && cursor <= 511);
            assert.notEqual(toc.readUInt32LE((cursor - 1) * 4), 0xFFFFFFFF);
            assert.equal(toc.readUInt32LE(cursor * 4), 0xFFFFFFFF);
            assert.ok(virtual(block * 512 + cursor).every(b => b === 255), "next program must target an erased row");
        }
        const directory = virtual(control + 4), cache = new Map();
        function mappedPage(lpn)
        {
            const dir = lpn >>> 11, index = directory.readUInt32LE(dir * 4);
            if(index === 0xFFFFFFFF) return null;
            if(!cache.has(index)) cache.set(index, virtual(index));
            const vpn = cache.get(index).readUInt32LE((lpn & 2047) * 4);
            return vpn === 0xFFFFFFFF ? null : virtual(vpn);
        }
        const head = mappedPage(0).subarray(0, 4096);
        assert.equal(head.toString("hex", 0, 16), "6a9088cf8afd630ae351e24887e0b98b");
        const checksum = head.readUInt32LE(44);
        head.writeUInt32LE(0, 44);
        assert.equal(crc32(head), checksum);
        assert.equal(head.readUInt32LE(40), 2);
        const mediaSize = Number(head.readBigUInt64LE(32));
        const chunk = 2 ** Math.ceil(Math.log2(mediaSize / 1024)), chunks = new Map();
        assert.equal(head.readUInt16LE(2048), 0xF000);
        for(let i = 1; i < 1024; i++)
        {
            const tag = head.readUInt16LE(2048 + 2 * i);
            if(tag >= 0xF000) continue;
            assert.ok(!chunks.has(tag));
            chunks.set(tag, i);
        }
        for(const [part, source] of sources.entries())
        {
            const input = fs.openSync(source, "r");
            try
            {
                const src = Buffer.alloc(8192);
                assert.equal(fs.readSync(input, src, 0, 512, 1024), 512);
                const length = src.readUInt32BE(40) * src.readUInt32BE(44);
                const record = 512 + part * 128;
                assert.ok(Number(head.readBigUInt64LE(record + 40) - head.readBigUInt64LE(record + 32)) >= length);
                for(let off = 0; off < length; off += src.length)
                {
                    const n = Math.min(length - off, src.length);
                    assert.equal(fs.readSync(input, src, 0, n, off), n);
                    const tag = (part << 12) + Math.floor(off / chunk);
                    assert.ok(chunks.has(tag));
                    const mapped = mappedPage((chunks.get(tag) * chunk + off % chunk) / 8192);
                    if(part === 0) assert.ok(mapped, "unmapped system page at " + off);
                    if(synthetic && part === 1 && off === 4 * 8192)
                        assert.ok(mapped, "allocated zero data block must have a NAND mapping");
                    if(synthetic && part === 1 && off === 5 * 8192)
                        assert.equal(mapped, null, "free zero data page can be trimmed");
                    const data = mapped || zero;
                    assert.ok(data.subarray(0, n).equals(src.subarray(0, n)), "volume " + part + " mismatch at " + off);
                }
            }
            finally { fs.closeSync(input); }
        }
        assert.ok(sequences.size >= 2);
        for(const block of sequences.values()) virtual(block * 512 + 511);
        assert.ok(state.readUInt32LE(44) > Math.max(...sequences.keys()), "future writes start after every populated weave sequence");
    }
    finally { fs.closeSync(fd); }
}

const args = process.argv.slice(2);
if(args.length)
{
    assert.equal(args.length, 3, "usage: nand-volumes.mjs flash.img system.hfs data.hfs");
    check(args[0], args.slice(1));
}
else
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "n90-volumes-"));
    try
    {
        const sources = ["System", "Data"].map((name, i) => {
            const file = path.join(temp, name), fd = fs.openSync(file, "wx");
            try
            {
                const size = (i ? 1 : 17) * 1024 * 1024, header = Buffer.alloc(512);
                fs.ftruncateSync(fd, size);
                header.write("HX");
                header.writeUInt32BE(4096, 40);
                header.writeUInt32BE(size / 4096, 44);
                if(i)
                {
                    header.writeBigUInt64BE(BigInt(size / 4096 / 8), 112);
                    header.writeUInt32BE(1, 124);
                    header.writeUInt32BE(2, 128);
                    header.writeUInt32BE(1, 132);
                    fs.writeSync(fd, Buffer.from([0xA0, 0x40]), 0, 2, 8192);
                }
                fs.writeSync(fd, header, 0, header.length, 1024);
                const mark = Buffer.alloc(32, i + 13);
                fs.writeSync(fd, mark, 0, mark.length, size - 512);
            }
            finally { fs.closeSync(fd); }
            return file;
        });
        const image = path.join(temp, "flash.img");
        execFileSync(process.execPath, [fileURLToPath(new URL("../../tools/ios/nand_build.mjs", import.meta.url)),
            "volumes", image, ...sources]);
        check(image, sources, true);
    }
    finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
console.log("PASS: both source volumes match every byte read through LwVM and the YAFTL page indices");
