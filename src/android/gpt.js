// GPT disks (UEFI 2.10 §5.3) as Android's partitions need them: a layout
// of named partitions, the protective MBR and both GPTs as writes, and a
// reader (docs/android-images-plan.md I1, I2)

import { u32, u64, put16, put32, put64, latin1, bytes_of, utf8, copy, crc32, sha256_hex } from "./bytes.js";

export const SECTOR = 512;
const LINUX_FILESYSTEM = "0FC63DAF-8483-4772-8E79-3D69D8477DE4";
const ENTRIES = 128, ENTRY_SIZE = 128;

/**
 * A GUID's bytes (the first three fields little-endian)
 * @param {string} text
 * @return {!Uint8Array}
 */
export function guid_bytes(text)
{
    const h = text.replace(/-/g, "");
    const b = new Uint8Array(16);
    for(let i = 0; i < 16; i++) b[i] = parseInt(h.substr(2 * i, 2), 16);
    return new Uint8Array([b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6], ...b.subarray(8)]);
}

/**
 * A GUID's text from its bytes
 * @param {!Uint8Array} b
 * @return {string}
 */
export function guid_text(b)
{
    const h = [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15].map(i => b[i].toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase();
}

/**
 * A stable GUID from a name (version 4 layout, from sha256)
 * @param {string} name
 * @return {string}
 */
export function name_guid(name)
{
    const h = sha256_hex(utf8("v86-a64-android:" + name));
    const v = h.slice(0, 12) + "4" + h.slice(13, 16) + "8" + h.slice(17, 32);
    return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`.toUpperCase();
}

/**
 * Partitions placed one after another from align, each start aligned, and
 * the disk's size (one more align at its end, for the backup GPT)
 * @param {!Array<{name: string, size: number}>} list
 * @param {number=} align
 * @return {{partitions: !Array<{name: string, start: number, size: number}>, disk_size: number}}
 */
export function gpt_layout(list, align = 1 << 20)
{
    const partitions = [];
    let at = align;
    for(const p of list)
    {
        partitions.push({ ...p, start: at });
        at += Math.ceil(p.size / align) * align;
    }
    return { partitions, disk_size: at + align };
}

/**
 * The protective MBR, primary and backup GPT for partitions [{ name,
 * start, size }] (bytes) as writes
 * @param {number} disk_size
 * @param {!Array<{name: string, start: number, size: number}>} partitions
 * @return {!Array<{offset: number, bytes: !Uint8Array}>}
 */
export function gpt_writes(disk_size, partitions)
{
    if(partitions.length > ENTRIES) throw new Error("GPT: more than 128 partitions");
    const entries = new Uint8Array(ENTRIES * ENTRY_SIZE);
    partitions.forEach((p, i) =>
    {
        const e = i * ENTRY_SIZE;
        entries.set(guid_bytes(LINUX_FILESYSTEM), e);
        entries.set(guid_bytes(name_guid(p.name)), e + 16);
        // (whole sectors: a size that is not ends in its last sector)
        if(p.start % SECTOR) throw new Error("GPT: " + p.name + " starts within a sector");
        put64(entries, e + 32, p.start / SECTOR);
        put64(entries, e + 40, Math.ceil((p.start + p.size) / SECTOR) - 1);
        if(p.name.length > 36) throw new Error("GPT: a name beyond 36 characters: " + p.name);
        for(let c = 0; c < p.name.length; c++) put16(entries, e + 56 + 2 * c, p.name.charCodeAt(c));
    });
    const sectors = disk_size / SECTOR;
    const header = (current, backup, entries_lba) =>
    {
        const h = new Uint8Array(SECTOR);
        h.set(bytes_of("EFI PART"), 0);
        put32(h, 8, 0x10000);
        put32(h, 12, 92);
        put64(h, 24, current);
        put64(h, 32, backup);
        put64(h, 40, 34);
        put64(h, 48, sectors - 34);
        h.set(guid_bytes(name_guid("disk")), 56);
        put64(h, 72, entries_lba);
        put32(h, 80, ENTRIES);
        put32(h, 84, ENTRY_SIZE);
        put32(h, 88, crc32(entries));
        put32(h, 16, crc32(h.subarray(0, 92)));
        return h;
    };
    const mbr = new Uint8Array(SECTOR);
    mbr[446 + 4] = 0xEE;
    put32(mbr, 446 + 8, 1);
    put32(mbr, 446 + 12, Math.min(sectors - 1, 0xFFFFFFFF));
    mbr[446 + 1] = 0; mbr[446 + 2] = 2; // CHS of LBA 1
    mbr[446 + 5] = 0xFF; mbr[446 + 6] = 0xFF; mbr[446 + 7] = 0xFF;
    put16(mbr, 510, 0xAA55);
    return [
        { offset: 0, bytes: mbr },
        { offset: SECTOR, bytes: header(1, sectors - 1, 2) },
        { offset: 2 * SECTOR, bytes: entries },
        { offset: (sectors - 33) * SECTOR, bytes: entries },
        { offset: (sectors - 1) * SECTOR, bytes: header(sectors - 1, 1, sectors - 33) },
    ];
}

/**
 * A disk's GPT partitions, from the primary GPT (else the backup), through
 * read(offset, length)
 * @param {function(number, number): !Uint8Array} read
 * @param {number=} disk_size for the backup
 * @return {!Array<{name: string, start: number, size: number, type: string, guid: string}>}
 */
export function gpt_partitions(read, disk_size = 0)
{
    const valid = h =>
    {
        if(h.length < 92 || latin1(h, 0, 8) !== "EFI PART") return false;
        const size = u32(h, 12);
        if(size < 92 || size > SECTOR) return false;
        const header = copy(h, 0, size);
        put32(header, 16, 0);
        return crc32(header) === u32(h, 16);
    };
    let h = read(SECTOR, SECTOR);
    if(!valid(h) && disk_size) h = read(disk_size - SECTOR, SECTOR);
    if(!valid(h)) throw new Error("GPT: no valid header");
    const count = u32(h, 80), size = u32(h, 84);
    if(size < 128 || count * size > 1 << 20) throw new Error("GPT: entries of " + size + " bytes");
    const entries = read(u64(h, 72) * SECTOR, count * size);
    if(crc32(entries) !== u32(h, 88)) throw new Error("GPT: the entries' CRC differs");
    const partitions = [];
    for(let i = 0; i < count; i++)
    {
        const e = entries.subarray(i * size, (i + 1) * size);
        if(e.subarray(0, 16).every(b => b === 0)) continue;
        let name = "";
        for(let c = 56; c + 1 < 128; c += 2)
        {
            const code = e[c] | e[c + 1] << 8;
            if(!code) break;
            name += String.fromCharCode(code);
        }
        const first = u64(e, 32), last = u64(e, 40);
        partitions.push({ name, start: first * SECTOR, size: (last - first + 1) * SECTOR,
            type: guid_text(e.subarray(0, 16)), guid: guid_text(e.subarray(16, 32)) });
    }
    return partitions;
}
