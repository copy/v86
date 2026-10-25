// bootconfig (Documentation/admin-guide/bootconfig.rst) as Android's
// bootloaders append it to the initrd (docs/android-images-plan.md I1)

import { put32, bytes_of, utf8, concat } from "./bytes.js";

/**
 * key=value lines (bootconfig as the vendor_boot carries it) as a Map
 * @param {string} text
 * @return {!Map<string, string>}
 */
export function parse_bootconfig(text)
{
    const map = new Map();
    for(const line of text.split("\n"))
    {
        const m = /^\s*([^#=\s][^=\s]*)\s*=\s*(.*?)\s*$/.exec(line);
        if(m) map.set(m[1], m[2].replace(/^"(.*)"$/, "$1"));
    }
    return map;
}

/**
 * bootconfig appended to an initrd: the text, padded so the whole stays
 * 4-aligned, its size and checksum (the sum of its bytes), "#BOOTCONFIG\n"
 * @param {!Uint8Array} initrd
 * @param {!Map<string, string>} map
 * @return {!Uint8Array}
 */
export function append_bootconfig(initrd, map)
{
    const text = utf8([...map].map(([key, value]) => `${key} = "${value}"\n`).join("") + "\0");
    const pad = (4 - (initrd.length + text.length + 8 + 12) % 4) % 4;
    const data = concat([text, new Uint8Array(pad)]);
    const footer = new Uint8Array(8);
    put32(footer, 0, data.length);
    put32(footer, 4, data.reduce((sum, byte) => sum + byte, 0) >>> 0);
    return concat([initrd, data, footer, bytes_of("#BOOTCONFIG\n")]);
}
