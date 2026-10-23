// newc cpio archives, Android's ramdisks (docs/android-images-plan.md I1)

import { latin1, bytes_of, concat } from "./bytes.js";

/**
 * The regular files of newc cpio archives
 * @param {!Uint8Array} bytes
 * @return {!Map<string, !Uint8Array>} name -> data
 */
export function cpio_files(bytes)
{
    const files = new Map();
    for(let at = 0; at + 110 <= bytes.length;)
    {
        if(latin1(bytes, at, at + 6) !== "070701") { at += 4; continue; }
        const field = i => parseInt(latin1(bytes, at + 6 + i * 8, at + 14 + i * 8), 16);
        const mode = field(1), size = field(6), name_size = field(11);
        const name = latin1(bytes, at + 110, at + 110 + name_size - 1);
        const data_at = Math.ceil((at + 110 + name_size) / 4) * 4;
        if((mode & 0o170000) === 0o100000) files.set(name, bytes.subarray(data_at, data_at + size));
        at = Math.ceil((data_at + size) / 4) * 4;
    }
    return files;
}

/**
 * A newc cpio archive of regular files [name, data] (mode 0644)
 * @param {!Array<!Array>} files
 * @return {!Uint8Array}
 */
export function cpio_newc(files)
{
    const parts = [];
    let ino = 0x7000;
    const entry = (name, data, mode, nlink) =>
    {
        const fields = [ino++, mode, 0, 0, nlink, 0, data.length, 0, 0, 0, 0, name.length + 1, 0];
        const header = bytes_of("070701" + fields.map(f => f.toString(16).toUpperCase().padStart(8, "0")).join("") + name + "\0");
        parts.push(header, new Uint8Array((4 - header.length % 4) % 4), data, new Uint8Array((4 - data.length % 4) % 4));
    };
    for(const [name, data] of files) entry(name, data, 0o100644, 1);
    entry("TRAILER!!!", new Uint8Array(0), 0, 1);
    return concat(parts);
}
