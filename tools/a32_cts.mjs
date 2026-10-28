#!/usr/bin/env node
// CTS 7.1 for the Android 7.1 image on ranchu (docs/gles-proxy-plan.md E4,
// dEQP): android-cts-7.1_r29-linux_x86-arm.zip is 713 MB, so, as
// tools/a64_cts.mjs does for Android 16, only what is used comes over: the
// zip's central directory (an ordinary end record: no zip64 below 4 GB),
// then the named files of android-cts/testcases/ (flat in CTS 7: the
// module's APK and its case lists beside every other module's), each
// checked against its CRC-32, into build/a32-android/cts/.
//
//   node tools/a32_cts.mjs [--download] [--list [pattern]] [file ...]
//   (default files: CtsDeqpTestCases.apk and its case lists)
import fs from "node:fs";
import path from "node:path";
import { crc32, inflateRawSync as inflate_raw_sync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { zip_entries } from "./a64_cts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") + "/";
export const CTS7 = { version: "7.1_r29", url: "https://dl.google.com/dl/android/cts/android-cts-7.1_r29-linux_x86-arm.zip", size: 713919691 };
export const CTS7_DIR = ROOT + "build/a32-android/cts/";
const PREFIX = "android-cts/testcases/";
/** dEQP's module: its APK (com.drawelements.deqp), the GLES 2 and EGL case lists, its configuration */
export const DEQP_FILES = ["com.drawelements.deqp.apk", "gles2-master.txt", "egl-master.txt", "CtsDeqpTestCases.config"];

async function range(start, end)
{
    for(let attempt = 1; ; attempt++)
    {
        try
        {
            const response = await fetch(CTS7.url, { headers: { Range: `bytes=${start}-${end - 1}` } });
            if(response.status !== 206) throw new Error(`HTTP ${response.status}`);
            const bytes = Buffer.from(await response.arrayBuffer());
            if(bytes.length !== end - start) throw new Error(`${bytes.length} bytes, expected ${end - start}`);
            return bytes;
        }
        catch(e)
        {
            if(attempt === 5) throw new Error(`${CTS7.url} ${start}-${end}: ${e.message}`);
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
    }
}

/** the central directory (central-<version>.bin, fetched once) */
async function central_directory(allow_download)
{
    const file = CTS7_DIR + `central-${CTS7.version}.bin`;
    if(fs.existsSync(file)) return fs.readFileSync(file);
    if(!allow_download) throw new Error(`${file} is missing: run with --download (byte ranges of ${CTS7.url})`);
    const tail = await range(CTS7.size - 65536, CTS7.size);
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4B, 0x05, 0x06]));
    if(end < 0) throw new Error("CTS zip: no end of central directory record");
    const size = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    const directory = await range(offset, offset + size);
    fs.mkdirSync(CTS7_DIR, { recursive: true });
    fs.writeFileSync(file, directory);
    return directory;
}

/** an entry's bytes, through its local header, checked against its CRC-32 */
async function entry_data(e)
{
    const slack = 30 + Buffer.byteLength(e.name) + 1024;
    const bytes = await range(e.offset, Math.min(CTS7.size, e.offset + slack + e.compressed));
    if(bytes.readUInt32LE(0) !== 0x04034B50) throw new Error(`CTS zip: no local header for ${e.name}`);
    const start = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
    const raw = bytes.subarray(start, start + e.compressed);
    const data = e.method === 0 ? raw : e.method === 8 ? inflate_raw_sync(raw) : null;
    if(!data || data.length !== e.size || (crc32(data) >>> 0) !== e.crc) throw new Error(`CTS zip: ${e.name} does not match its CRC-32`);
    return data;
}

/**
 * testcases/ files into CTS7_DIR (kept once fetched)
 * @param {!Array<string>} names
 * @param {boolean} allow_download
 * @return {!Promise<!Array<string>>} their paths
 */
export async function fetch_files(names, allow_download)
{
    const missing = names.filter(name => !fs.existsSync(CTS7_DIR + name));
    if(missing.length)
    {
        const entries = zip_entries(await central_directory(allow_download));
        for(const name of missing)
        {
            const e = entries.find(x => x.name === PREFIX + name);
            if(!e) throw new Error(`CTS ${CTS7.version} has no testcases/${name}`);
            if(!allow_download) throw new Error(`${CTS7_DIR + name} is missing: run with --download`);
            console.log(`${name}: ${(e.compressed / 1048576).toFixed(1)} MiB from ${CTS7.url}`);
            fs.mkdirSync(CTS7_DIR, { recursive: true });
            fs.writeFileSync(CTS7_DIR + name + ".part", await entry_data(e));
            fs.renameSync(CTS7_DIR + name + ".part", CTS7_DIR + name);
        }
    }
    return names.map(name => CTS7_DIR + name);
}

async function main()
{
    const argv = process.argv.slice(2);
    const allow_download = argv.includes("--download");
    if(argv.includes("--list"))
    {
        const pattern = new RegExp(argv[argv.indexOf("--list") + 1] || ".", "i");
        for(const e of zip_entries(await central_directory(allow_download)))
        {
            if(e.name.startsWith(PREFIX) && pattern.test(e.name)) console.log(`${(e.compressed / 1048576).toFixed(1).padStart(8)} MiB  ${e.name.slice(PREFIX.length)}`);
        }
        return;
    }
    const names = argv.filter(a => !a.startsWith("--") && a !== argv[argv.indexOf("--list") + 1]);
    for(const file of await fetch_files(names.length ? names : DEQP_FILES, allow_download)) console.log(file);
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
