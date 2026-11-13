// Rebuild a verified IPA without buffering or recompressing its resources.
// Unchanged deflate payloads are copied; replacement members are stored.
import { zip_data_offset } from "../android/zip.js";
import { crc32 } from "../android/bytes.js";

export async function write_ipa_zip(read, entries, replacements, removed, sink, executablePaths = new Set())
{
    const all = entries.filter(e => !removed.has(e.name)), existing = new Set(all.map(e => e.name));
    for(const name of replacements.keys()) if(!existing.has(name)) all.push({ name, unix_mode: 0o100644 });
    if(all.length > 65535) throw new Error("IPA output has too many ZIP members");
    let position = 0; const records = [];
    const write = async bytes => { if(position + bytes.length > 0xFFFFFFFF) throw new Error("IPA output exceeds ZIP32 capacity"); await sink(bytes); position += bytes.length; };
    for(const entry of all)
    {
        const bytes = replacements.get(entry.name), name = new TextEncoder().encode(entry.name), offset = position;
        if(name.length > 65535) throw new Error("IPA member name is too long");
        const method = bytes ? 0 : entry.method, size = bytes ? bytes.length : entry.size;
        const compressed = bytes ? bytes.length : entry.compressed_size, crc = bytes ? crc32(bytes) : entry.crc32;
        const local = new Uint8Array(30 + name.length), v = new DataView(local.buffer);
        v.setUint32(0, 0x04034B50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x800, true); v.setUint16(8, method, true);
        v.setUint16(12, 0x21, true); v.setUint32(14, crc, true); v.setUint32(18, compressed, true); v.setUint32(22, size, true);
        v.setUint16(26, name.length, true); local.set(name, 30); await write(local);
        if(bytes) await write(bytes);
        else
        {
            const start = await zip_data_offset(read, entry);
            for(let at = 0; at < compressed; at += 1 << 20)
            {
                const count = Math.min(1 << 20, compressed - at), part = await read(start + at, count);
                if(part.length !== count) throw new Error("Short IPA member read");
                await write(part);
            }
        }
        let mode = entry.unix_mode || (entry.name.endsWith("/") ? 0o40755 : 0o100644);
        if(executablePaths.has(entry.name)) mode = 0o100755;
        const central = new Uint8Array(46 + name.length), c = new DataView(central.buffer);
        c.setUint32(0, 0x02014B50, true); c.setUint16(4, 0x314, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true);
        c.setUint16(10, method, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true);
        c.setUint32(20, compressed, true); c.setUint32(24, size, true); c.setUint16(28, name.length, true);
        c.setUint32(38, (mode << 16) >>> 0, true); c.setUint32(42, offset, true); central.set(name, 46); records.push(central);
    }
    const directory = position;
    for(const bytes of records) await write(bytes);
    const end = new Uint8Array(22), v = new DataView(end.buffer);
    v.setUint32(0, 0x06054B50, true); v.setUint16(8, records.length, true); v.setUint16(10, records.length, true);
    v.setUint32(12, position - directory, true); v.setUint32(16, directory, true); await write(end);
    return position;
}
