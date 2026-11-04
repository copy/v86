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

function check(image, sources)
{
    const fd = fs.openSync(image, "r"), zero = Buffer.alloc(8192);
    try
    {
        function physical(vpn)
        {
            const chip = (vpn & 1) * 2 + (vpn >>> 1 & 1);
            const row = Math.floor(vpn / 512) * 128 + ((vpn & 511) >>> 2);
            const bytes = Buffer.alloc(8192);
            assert.equal(fs.readSync(fd, bytes, 0, bytes.length, (chip * 4152 * 128 + row) * 8704), bytes.length);
            for(let i = 0; i < bytes.length; i++) bytes[i] ^= 255;
            return bytes;
        }
        const context = physical(15 * 512), control = context.readUInt16LE(0x69A) * 512;
        const state = physical(control);
        assert.equal(state.toString("ascii", 0, 4), "CX01");
        for(const [blockOffset, cursorOffset, tocPart] of [[12, 0x66, 1], [20, 0x68, 2]])
        {
            const block = state.readUInt32LE(blockOffset), cursor = state.readUInt16LE(cursorOffset);
            const toc = physical(control + tocPart);
            assert.ok(cursor >= 1 && cursor <= 511);
            assert.notEqual(toc.readUInt32LE((cursor - 1) * 4), 0xFFFFFFFF);
            assert.equal(toc.readUInt32LE(cursor * 4), 0xFFFFFFFF);
            assert.ok(physical(block * 512 + cursor).every(b => b === 255), "next program must target an erased row");
        }
        const directory = physical(control + 4), cache = new Map();
        function logical(lpn)
        {
            const dir = lpn >>> 11, index = directory.readUInt32LE(dir * 4);
            if(index === 0xFFFFFFFF) return zero;
            if(!cache.has(index)) cache.set(index, physical(index));
            const vpn = cache.get(index).readUInt32LE((lpn & 2047) * 4);
            return vpn === 0xFFFFFFFF ? zero : physical(vpn);
        }
        const head = logical(0).subarray(0, 4096);
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
                    const data = logical((chunks.get(tag) * chunk + off % chunk) / 8192);
                    assert.ok(data.subarray(0, n).equals(src.subarray(0, n)), "volume " + part + " mismatch at " + off);
                }
            }
            finally { fs.closeSync(input); }
        }
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
        check(image, sources);
    }
    finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
console.log("PASS: both source volumes match every byte read through LwVM and the YAFTL page indices");
