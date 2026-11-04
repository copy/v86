// Add a weak dependency to a private copy of a 10B329 daemon. Existing
// dependency ordinals, file offsets, entitlements and segment sizes stay valid.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { macho_parse, CPU_TYPE_ARM } from "../../src/apple/macho.js";

export const GUEST_GL_LIBRARY = "/private/var/v86/libv86gles.dylib";

// Validate the signed pages before trusting a supplied development binary.
function code_directories(bytes)
{
    const ncmds = bytes.readUInt32LE(16), dirs = [];
    let signature = 0, length = 0;
    for(let i = 0, at = 28; i < ncmds; i++)
    {
        if(bytes.readUInt32LE(at) === 29)
        {
            signature = bytes.readUInt32LE(at + 8);
            length = bytes.readUInt32LE(at + 12);
        }
        at += bytes.readUInt32LE(at + 4);
    }
    const end = signature + length;
    assert.ok(signature && end <= bytes.length && bytes.readUInt32BE(signature) === 0xFADE0CC0, "missing embedded signature");
    const count = bytes.readUInt32BE(signature + 8);
    assert.ok(12 + count * 8 <= length);
    for(let i = 0; i < count; i++)
    {
        const dir = signature + bytes.readUInt32BE(signature + 16 + i * 8);
        if(bytes.readUInt32BE(dir) !== 0xFADE0C02) continue;
        const stop = dir + bytes.readUInt32BE(dir + 4), limit = bytes.readUInt32BE(dir + 32);
        const slots = bytes.readUInt32BE(dir + 28), hashes = dir + bytes.readUInt32BE(dir + 16);
        const hashSize = bytes[dir + 36], kind = bytes[dir + 37], page = 2 ** bytes[dir + 39];
        const algorithm = kind === 1 && hashSize === 20 ? "sha1" : kind === 2 && hashSize === 32 ? "sha256" : null;
        assert.ok(algorithm && stop <= end && limit === signature && slots === Math.ceil(limit / page) &&
            hashes + slots * hashSize <= stop, "unexpected CodeDirectory layout");
        for(let n = 0; n < slots; n++)
        {
            const start = n * page;
            const digest = createHash(algorithm).update(bytes.subarray(start, Math.min(start + page, limit))).digest();
            assert.deepEqual(bytes.subarray(hashes + n * hashSize, hashes + (n + 1) * hashSize), digest, "invalid signed page");
        }
        dirs.push({ dir, stop, limit, page, hashes, hashSize, algorithm });
    }
    assert.ok(dirs.length, "missing CodeDirectory");
    return dirs;
}

export function cdhashes(bytes)
{
    return code_directories(bytes).map(({ dir, stop, algorithm }) =>
        createHash(algorithm).update(bytes.subarray(dir, stop)).digest().subarray(0, 20));
}

export function link_guest_gles(original)
{
    const macho = macho_parse(original);
    assert.ok(!macho.is64 && macho.cputype === CPU_TYPE_ARM && macho.filetype === 2, "expected an ARM executable");
    assert.ok(!macho.dylibs.includes(GUEST_GL_LIBRARY), "guest GLES dependency already exists");
    const bytes = Buffer.from(original);
    const ncmds = bytes.readUInt32LE(16), size = bytes.readUInt32LE(20), end = 28 + size;
    const first = Math.min(...macho.segments.flatMap(s => s.sections).map(s => s.offset).filter(Boolean));
    const cmd = Buffer.alloc((24 + GUEST_GL_LIBRARY.length + 1 + 3) & ~3);
    assert.ok(end + cmd.length <= first && bytes.subarray(end, end + cmd.length).every(b => !b), "insufficient Mach-O header padding");
    cmd.writeUInt32LE(0x80000018); // LC_LOAD_WEAK_DYLIB
    cmd.writeUInt32LE(cmd.length, 4);
    cmd.writeUInt32LE(24, 8);
    cmd.write(GUEST_GL_LIBRARY, 24);
    cmd.copy(bytes, end);
    bytes.writeUInt32LE(ncmds + 1, 16);
    bytes.writeUInt32LE(size + cmd.length, 20);

    for(const { dir, limit, page, hashes, hashSize, algorithm } of code_directories(original))
    {
        assert.ok(original.readUInt32BE(dir + 12) & 2, "expected ad-hoc CodeDirectory");
        for(let start = 0; start < end + cmd.length; start += page)
            createHash(algorithm).update(bytes.subarray(start, Math.min(start + page, limit))).digest().copy(bytes, hashes + start / page * hashSize);
    }
    assert.ok(macho_parse(bytes).dylibs.includes(GUEST_GL_LIBRARY));
    return bytes;
}
