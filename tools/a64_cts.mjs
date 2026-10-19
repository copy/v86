#!/usr/bin/env node
// CTS modules for Android 16 on the virt machine (docs/arm64-virt-android16-plan.md
// P12.3): the CTS of the image's release, android-cts-16.1_r1 (Android 16
// QPR2, 2025-12-02; the image is BP4A.251205.006), is one zip of 23.8 GB,
// more than this machine keeps, so only what is used comes over: the zip's
// central directory once (byte ranges from its end), then each chosen
// module's files (android-cts/testcases/<module>/), each checked against
// its CRC-32, into build/a64-android/cts/<module>/ with its Unix mode.
// tests/a64/android_cts.mjs
// runs them on the guest without Tradefed.
//
//   node tools/a64_cts.mjs [--download] [--list [pattern]] [--subset] [module ...]
//   (--download: allow the network; --list: the modules, their sizes;
//   --subset: tests/a64/android_cts.mjs's modules)
import fs from "node:fs";
import path from "node:path";
import { crc32, inflateRawSync as inflate_raw_sync } from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") + "/";
export const CTS = { version: "16.1_r1", url: "https://dl.google.com/dl/android/cts/android-cts-16.1_r1-linux_x86-arm.zip",
    size: 23762616637 };
export const CTS_DIR = ROOT + "build/a64-android/cts/";
const PREFIX = "android-cts/testcases/";

async function range(start, end)
{
    for(let attempt = 1; ; attempt++)
    {
        try
        {
            const response = await fetch(CTS.url, { headers: { Range: `bytes=${start}-${end - 1}` } });
            if(response.status !== 206) throw new Error(`HTTP ${response.status}`);
            const bytes = Buffer.from(await response.arrayBuffer());
            if(bytes.length !== end - start) throw new Error(`${bytes.length} bytes, expected ${end - start}`);
            return bytes;
        }
        catch(e)
        {
            if(attempt === 5) throw new Error(`${CTS.url} ${start}-${end}: ${e.message}`);
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
    }
}

/** the zip's central directory, fetched once (central-<version>.bin) */
async function central_directory(allow_download)
{
    const file = CTS_DIR + `central-${CTS.version}.bin`;
    if(fs.existsSync(file)) return fs.readFileSync(file);
    if(!allow_download) throw new Error(`${file} is missing: run with --download (byte ranges of ${CTS.url})`);
    const tail = await range(CTS.size - 65536, CTS.size);
    const locator = tail.lastIndexOf(Buffer.from([0x50, 0x4B, 0x06, 0x07]));
    if(locator < 0) throw new Error("CTS zip: no zip64 end of central directory locator");
    const record = Number(tail.readBigUInt64LE(locator + 8));
    const r = record >= CTS.size - 65536 ? tail.subarray(record - (CTS.size - 65536)) : await range(record, record + 56);
    if(r.readUInt32LE(0) !== 0x06064B50) throw new Error("CTS zip: no zip64 end of central directory record");
    const size = Number(r.readBigUInt64LE(40)), offset = Number(r.readBigUInt64LE(48));
    const directory = await range(offset, offset + size);
    fs.mkdirSync(CTS_DIR, { recursive: true });
    fs.writeFileSync(file, directory);
    return directory;
}

/** the central directory's entries: { name, method, crc, compressed, size, offset, mode (Unix, 0 if none) } */
export function zip_entries(directory)
{
    const entries = [];
    for(let at = 0; at + 46 <= directory.length && directory.readUInt32LE(at) === 0x02014B50;)
    {
        const name_length = directory.readUInt16LE(at + 28), extra_length = directory.readUInt16LE(at + 30), comment = directory.readUInt16LE(at + 32);
        const e = { name: directory.toString("utf8", at + 46, at + 46 + name_length), method: directory.readUInt16LE(at + 10),
            crc: directory.readUInt32LE(at + 16), compressed: directory.readUInt32LE(at + 20), size: directory.readUInt32LE(at + 24),
            offset: directory.readUInt32LE(at + 42),
            mode: directory.readUInt16LE(at + 4) >> 8 === 3 ? directory.readUInt32LE(at + 38) >>> 16 & 0o777 : 0 };
        // (zip64: the fields that are 0xFFFFFFFF follow in the extra field 1, in this order)
        for(let x = at + 46 + name_length; x + 4 <= at + 46 + name_length + extra_length;)
        {
            const id = directory.readUInt16LE(x), length = directory.readUInt16LE(x + 2);
            if(id === 1)
            {
                let y = x + 4;
                for(const key of ["size", "compressed", "offset"])
                {
                    if(e[key] === 0xFFFFFFFF) { e[key] = Number(directory.readBigUInt64LE(y)); y += 8; }
                }
            }
            x += 4 + length;
        }
        entries.push(e);
        at += 46 + name_length + extra_length + comment;
    }
    return entries;
}

/** an entry's bytes, through its local header, checked against its CRC-32 */
async function entry_data(e)
{
    // (the local header's extra field may be longer than the central one's: read some more)
    const slack = 30 + Buffer.byteLength(e.name) + 1024;
    const bytes = await range(e.offset, Math.min(CTS.size, e.offset + slack + e.compressed));
    if(bytes.readUInt32LE(0) !== 0x04034B50) throw new Error(`CTS zip: no local header for ${e.name}`);
    const start = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
    if(start + e.compressed > bytes.length) throw new Error(`CTS zip: ${e.name}'s local header is longer than expected`);
    const raw = bytes.subarray(start, start + e.compressed);
    const data = e.method === 0 ? raw : e.method === 8 ? inflate_raw_sync(raw) : null;
    if(!data) throw new Error(`CTS zip: ${e.name}: compression method ${e.method}`);
    if(data.length !== e.size || (crc32(data) >>> 0) !== e.crc) throw new Error(`CTS zip: ${e.name} does not match its CRC-32`);
    return data;
}

/** a module's files in CTS_DIR/<module>/ (kept when complete: <module>/.complete) */
export async function fetch_module(module, allow_download)
{
    const dir = CTS_DIR + module + "/";
    if(fs.existsSync(dir + ".complete")) return dir;
    const entries = zip_entries(await central_directory(allow_download)).filter(e => e.name.startsWith(PREFIX + module + "/") && !e.name.endsWith("/"));
    if(!entries.length) throw new Error(`CTS ${CTS.version} has no module ${module}`);
    if(!allow_download) throw new Error(`${dir} is missing: run with --download`);
    const bytes = entries.reduce((sum, e) => sum + e.compressed, 0);
    console.log(`${module}: ${entries.length} files, ${(bytes / 1048576).toFixed(1)} MiB from ${CTS.url}`);
    fs.rmSync(dir, { recursive: true, force: true });
    for(const e of entries)
    {
        const file = CTS_DIR + e.name.slice(PREFIX.length);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // (the zip's Unix modes: the modules' helper programs are executables)
        fs.writeFileSync(file, await entry_data(e), { mode: e.mode || 0o644 });
        if(e.mode) fs.chmodSync(file, e.mode);
    }
    fs.writeFileSync(dir + ".complete", JSON.stringify({ cts: CTS, files: entries.length, bytes }) + "\n");
    return dir;
}

async function main()
{
    const argv = process.argv.slice(2);
    const allow_download = argv.includes("--download");
    if(argv.includes("--list"))
    {
        const pattern = new RegExp(argv[argv.indexOf("--list") + 1] || ".", "i");
        const modules = new Map();
        for(const e of zip_entries(await central_directory(allow_download)))
        {
            if(!e.name.startsWith(PREFIX)) continue;
            const name = e.name.slice(PREFIX.length).split("/")[0];
            if(pattern.test(name)) modules.set(name, (modules.get(name) || 0) + e.compressed);
        }
        for(const [name, bytes] of [...modules].sort()) console.log(`${(bytes / 1048576).toFixed(1).padStart(9)} MiB  ${name}`);
        return;
    }
    const modules = argv.filter(a => !a.startsWith("--"));
    if(argv.includes("--subset")) modules.push(...(await import("../tests/a64/android_cts.mjs")).CTS_SUBSET.map(m => m.module));
    for(const module of modules) console.log(await fetch_module(module, allow_download));
}

// (not awaited at the top: --subset imports tests/a64/android_cts.mjs, which imports this module)
if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
