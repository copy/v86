// Mach-O, the format of XNU's kernelcache and of iOS's binaries
// (docs/iphone4-plan.md S0, S1): the header, the load commands v86 needs
// (segments and their sections, the symbol table, LC_UNIXTHREAD's entry
// point, the UUID, the dylibs) and the symbols. 32- and 64-bit, little-endian.

const LC_SEGMENT = 0x1, LC_SYMTAB = 0x2, LC_UNIXTHREAD = 0x5, LC_LOAD_DYLIB = 0xC, LC_ID_DYLIB = 0xD,
    LC_SEGMENT_64 = 0x19, LC_UUID = 0x1B, LC_VERSION_MIN_IPHONEOS = 0x25, LC_LOAD_WEAK_DYLIB = 0x80000018,
    LC_REEXPORT_DYLIB = 0x8000001F;

export const CPU_TYPE_ARM = 12;

/** @param {!Uint8Array} b @param {number} at @param {number} n @return {string} */
function fixed_string(b, at, n)
{
    const raw = b.subarray(at, at + n), end = raw.indexOf(0);
    return String.fromCharCode(...raw.subarray(0, end < 0 ? n : end));
}

/** @param {!Uint8Array} b @param {number} at @return {string} */
function c_string(b, at)
{
    let end = at;
    while(end < b.length && b[end]) end++;
    return String.fromCharCode(...b.subarray(at, end));
}

/**
 * @param {!Uint8Array} bytes
 * @return {Object}
 */
export function macho_parse(bytes)
{
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = view.getUint32(0, true);
    const is64 = magic === 0xFEEDFACF;
    if(magic !== 0xFEEDFACE && !is64) throw new Error(`Mach-O: magic 0x${magic.toString(16)}`);
    const result = {
        is64, cputype: view.getUint32(4, true), cpusubtype: view.getUint32(8, true), filetype: view.getUint32(12, true),
        flags: view.getUint32(24, true), segments: [], dylibs: [], entry: null, thread: null, symtab: null, uuid: null, id: null,
        min_ios: null,
    };
    const count = view.getUint32(16, true);
    let at = is64 ? 32 : 28;
    for(let i = 0; i < count; i++)
    {
        const cmd = view.getUint32(at, true), size = view.getUint32(at + 4, true);
        if(size < 8 || at + size > bytes.length) throw new Error(`Mach-O: load command ${i} is broken`);
        if(cmd === LC_SEGMENT || cmd === LC_SEGMENT_64)
        {
            const w = cmd === LC_SEGMENT_64 ? 8 : 4;
            const get = off => w === 8 ? Number(view.getBigUint64(off, true)) : view.getUint32(off, true);
            const segment = {
                name: fixed_string(bytes, at + 8, 16), vmaddr: get(at + 24), vmsize: get(at + 24 + w),
                fileoff: get(at + 24 + 2 * w), filesize: get(at + 24 + 3 * w),
                maxprot: view.getUint32(at + 24 + 4 * w, true), initprot: view.getUint32(at + 28 + 4 * w, true),
                flags: view.getUint32(at + 36 + 4 * w, true), sections: [],
            };
            const nsects = view.getUint32(at + 32 + 4 * w, true);
            for(let s = 0, p = at + 40 + 4 * w; s < nsects; s++, p += w === 8 ? 80 : 68)
            {
                segment.sections.push({
                    name: fixed_string(bytes, p, 16), segment: fixed_string(bytes, p + 16, 16),
                    addr: get(p + 32), size: get(p + 32 + w), offset: view.getUint32(p + 32 + 2 * w, true),
                    align: view.getUint32(p + 36 + 2 * w, true), flags: view.getUint32(p + 48 + 2 * w, true),
                });
            }
            result.segments.push(segment);
        }
        else if(cmd === LC_SYMTAB)
        {
            result.symtab = { symoff: view.getUint32(at + 8, true), nsyms: view.getUint32(at + 12, true),
                stroff: view.getUint32(at + 16, true), strsize: view.getUint32(at + 20, true) };
        }
        else if(cmd === LC_UNIXTHREAD)
        {
            const flavor = view.getUint32(at + 8, true), words = view.getUint32(at + 12, true);
            const state = Array.from({ length: words }, (_, k) => view.getUint32(at + 16 + 4 * k, true));
            result.thread = { flavor, state };
            // (ARM_THREAD_STATE: r0–r12, sp, lr, pc, cpsr)
            if(result.cputype === CPU_TYPE_ARM && flavor === 1) result.entry = state[15];
        }
        else if(cmd === LC_UUID)
        {
            result.uuid = Array.from(bytes.subarray(at + 8, at + 24), x => x.toString(16).padStart(2, "0")).join("");
        }
        else if(cmd === LC_LOAD_DYLIB || cmd === LC_LOAD_WEAK_DYLIB || cmd === LC_REEXPORT_DYLIB || cmd === LC_ID_DYLIB)
        {
            const name = c_string(bytes, at + view.getUint32(at + 8, true));
            if(cmd === LC_ID_DYLIB) result.id = name;
            else result.dylibs.push(name);
        }
        else if(cmd === LC_VERSION_MIN_IPHONEOS)
        {
            const v = view.getUint32(at + 8, true);
            result.min_ios = `${v >>> 16}.${v >> 8 & 0xFF}.${v & 0xFF}`;
        }
        at += size;
    }
    return result;
}

/**
 * The symbol table's entries (file offsets as given: for a binary on its
 * own, offsets in it)
 * @param {!Uint8Array} bytes
 * @param {Object} parsed macho_parse's
 * @return {!Array<{name: string, value: number, type: number, sect: number, desc: number}>}
 */
export function macho_symbols(bytes, parsed)
{
    const t = parsed.symtab;
    if(!t) return [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = parsed.is64 ? 16 : 12, out = [];
    for(let i = 0; i < t.nsyms; i++)
    {
        const at = t.symoff + i * size;
        const strx = view.getUint32(at, true);
        out.push({
            name: strx ? c_string(bytes, t.stroff + strx) : "", type: bytes[at + 4], sect: bytes[at + 5], desc: view.getUint16(at + 6, true),
            value: parsed.is64 ? Number(view.getBigUint64(at + 8, true)) : view.getUint32(at + 8, true),
        });
    }
    return out;
}

/**
 * A section's bytes, by segment and section name
 * @param {!Uint8Array} bytes
 * @param {Object} parsed
 * @param {string} segment
 * @param {string} section
 * @return {?Uint8Array}
 */
export function macho_section(bytes, parsed, segment, section)
{
    for(const s of parsed.segments)
    {
        if(s.name !== segment) continue;
        const sect = s.sections.find(x => x.name === section);
        if(sect) return bytes.subarray(sect.offset, sect.offset + sect.size);
    }
    return null;
}

/**
 * The file offset of a virtual address (in a segment's file-backed part)
 * @param {Object} parsed
 * @param {number} address
 * @return {number} -1 when none
 */
export function macho_offset(parsed, address)
{
    for(const s of parsed.segments)
    {
        if(address >= s.vmaddr && address < s.vmaddr + s.filesize) return s.fileoff + (address - s.vmaddr);
    }
    return -1;
}
