// Add a weak dependency to a private copy of a 10B329 executable. Existing
// dependency ordinals, file offsets, entitlements and segment sizes stay valid.
import { SHA1 } from "./crypto.js";
import { SHA256 } from "../image/sha256.js";
import { macho_parse, CPU_TYPE_ARM, macho_offset } from "../apple/macho.js";

const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const require_layout = (condition, message = "Unexpected N90 Mach-O layout") => { if(!condition) throw new Error(message); };
const hash = (algorithm, bytes) => (algorithm === "sha1" ? new SHA1() : new SHA256()).update(bytes).digest();
const equal = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
export const DISPLAY_DAEMONS = ["/usr/libexec/backboardd", "/System/Library/CoreServices/SpringBoard.app/SpringBoard"];
export const LOCKDOWN_DAEMON = "/usr/libexec/lockdownd";

export const GUEST_GL_LIBRARY = "/private/var/v86/libv86gles.dylib";
export const SYSTEM_GL_LIBRARY = "/usr/lib/libv86gles.dylib";
export const SYSTEM_GL_APPLICATIONS = ["/Applications/MobileSafari.app/MobileSafari", "/Applications/MobileSlideShow.app/MobileSlideShow"];

// Validate the signed pages before trusting a supplied development binary.
function code_directories(bytes)
{
    const v = view(bytes), ncmds = v.getUint32(16, true), dirs = [];
    let signature = 0, length = 0;
    for(let i = 0, at = 28; i < ncmds; i++)
    {
        if(v.getUint32(at, true) === 29)
        {
            signature = v.getUint32(at + 8, true);
            length = v.getUint32(at + 12, true);
        }
        at += v.getUint32(at + 4, true);
    }
    const end = signature + length;
    require_layout(signature && end <= bytes.length && v.getUint32(signature) === 0xFADE0CC0, "missing embedded signature");
    const count = v.getUint32(signature + 8);
    require_layout(12 + count * 8 <= length);
    for(let i = 0; i < count; i++)
    {
        const dir = signature + v.getUint32(signature + 16 + i * 8);
        if(v.getUint32(dir) !== 0xFADE0C02) continue;
        const stop = dir + v.getUint32(dir + 4), limit = v.getUint32(dir + 32);
        const slots = v.getUint32(dir + 28), hashes = dir + v.getUint32(dir + 16);
        const hashSize = bytes[dir + 36], kind = bytes[dir + 37], page = 2 ** bytes[dir + 39];
        const algorithm = kind === 1 && hashSize === 20 ? "sha1" : kind === 2 && hashSize === 32 ? "sha256" : null;
        require_layout(algorithm && stop <= end && limit === signature && slots === Math.ceil(limit / page) &&
            hashes + slots * hashSize <= stop, "unexpected CodeDirectory layout");
        for(let n = 0; n < slots; n++)
        {
            const start = n * page;
            const digest = hash(algorithm, bytes.subarray(start, Math.min(start + page, limit)));
            require_layout(equal(bytes.subarray(hashes + n * hashSize, hashes + (n + 1) * hashSize), digest), "Invalid signed page");
        }
        dirs.push({ dir, stop, limit, page, hashes, hashSize, algorithm });
    }
    require_layout(dirs.length, "missing CodeDirectory");
    return dirs;
}

export function cdhashes(bytes)
{
    return code_directories(bytes).map(({ dir, stop, algorithm }) =>
        hash(algorithm, bytes.subarray(dir, stop)).subarray(0, 20));
}

function resign_pages(original, bytes, first, last)
{
    for(const { dir, limit, page, hashes, hashSize, algorithm } of code_directories(original))
    {
        require_layout(view(original).getUint32(dir + 12) & 2, "expected ad-hoc CodeDirectory");
        for(let start = Math.floor(first / page) * page; start < last; start += page)
            bytes.set(hash(algorithm, bytes.subarray(start, Math.min(start + page, limit))), hashes + start / page * hashSize);
    }
}

export function patch_guest_code(original, offset, expected, replacement)
{
    require_layout(Number.isSafeInteger(offset) && offset >= 0 && expected.length === replacement.length &&
        offset + expected.length <= original.length && equal(original.subarray(offset, offset + expected.length), expected),
        "Unexpected N90 signed instruction sequence");
    const bytes = new Uint8Array(original);
    bytes.set(replacement, offset);
    resign_pages(original, bytes, offset, offset + replacement.length);
    cdhashes(bytes);
    return bytes;
}

const LOCKDOWN_BRANCH = 0xE22C; // Thumb code at 0xF22C in 10B329 lockdownd

export function offline_lockdown(original)
{
    const bytes = new Uint8Array(original), v = view(bytes), at = LOCKDOWN_BRANCH;
    require_layout(new SHA256().update(original).hex() ===
        "04d029e707cae62d09029a87ac9051b911a484870a0dc172d070bb42e631433f" &&
        v.getUint32(at, true) === 0x8128F000, "Expected stock N90 10B329 lockdownd");
    // dealwith_activation: use the existing local Activated path, while
    // preserving the separate DisableHactivation preference check.
    v.setUint16(at, 0xE128, true); // b 0xF480
    v.setUint16(at + 2, 0xBF00, true);
    resign_pages(original, bytes, at, at + 4);
    return bytes;
}

export function has_offline_lockdown(bytes)
{
    return bytes.length === 583136 && view(bytes).getUint32(LOCKDOWN_BRANCH, true) === 0xBF00E128 &&
        new SHA256().update(bytes).hex() === "78bdb383289ce3e44077bdad28481d4ab8bd674661380cf96daca5e047024090";
}

export function link_guest_gles(original, libraryPath = GUEST_GL_LIBRARY)
{
    const macho = macho_parse(original);
    require_layout(!macho.is64 && macho.cputype === CPU_TYPE_ARM && macho.filetype === 2, "expected an ARM executable");
    require_layout(!macho.dylibs.includes(libraryPath), "guest GLES dependency already exists");
    const bytes = new Uint8Array(original), v = view(bytes);
    const ncmds = v.getUint32(16, true), size = v.getUint32(20, true), end = 28 + size;
    const first = Math.min(...macho.segments.flatMap(s => s.sections).map(s => s.offset).filter(Boolean));
    const path = new TextEncoder().encode(libraryPath);
    const cmd = new Uint8Array((24 + path.length + 1 + 3) & ~3);
    require_layout(end + cmd.length <= first && bytes.subarray(end, end + cmd.length).every(b => !b), "insufficient Mach-O header padding");
    view(cmd).setUint32(0, 0x80000018, true); // LC_LOAD_WEAK_DYLIB
    view(cmd).setUint32(4, cmd.length, true);
    view(cmd).setUint32(8, 24, true);
    cmd.set(path, 24);
    bytes.set(cmd, end);
    view(bytes).setUint32(16, ncmds + 1, true);
    view(bytes).setUint32(20, size + cmd.length, true);

    resign_pages(original, bytes, 0, end + cmd.length);
    require_layout(macho_parse(bytes).dylibs.includes(libraryPath));
    return bytes;
}

export function check_guest_library(library)
{
    const info = macho_parse(library);
    require_layout(!info.is64 && info.cputype === CPU_TYPE_ARM && info.filetype === 6 &&
        info.id === GUEST_GL_LIBRARY, "Expected the N90 guest GLES library");
}

export function graphics_kernel(original, linkedExecutables, library, lockdown = null, extraTrusted = [])
{
    const trusted = [...extraTrusted];
    if(library)
    {
        check_guest_library(library);
        for(const bytes of linkedExecutables)
        {
            const paths = macho_parse(bytes).dylibs;
            require_layout(paths.includes(GUEST_GL_LIBRARY) || paths.includes(SYSTEM_GL_LIBRARY));
        }
        trusted.push(...linkedExecutables, library);
    }
    if(lockdown)
    {
        require_layout(has_offline_lockdown(lockdown), "Expected local offline lockdownd");
        trusted.push(lockdown);
    }
    if(!trusted.length) return original;
    return n90_trust_kernel(original, trusted.flatMap(cdhashes));
}

export const N90_TRUST_CAPACITY = Math.floor((0x80425000 - 0x80424120 - 24) / 20);
const STOCK_KERNEL_SHA256 = "82127c1ea84dbc1b55f423a4d60cdfe6a3baaabc117d4a891af0b502e57a2c47";

function trust_offsets(kernel)
{
    const macho = macho_parse(kernel);
    const head = macho_offset(macho, 0x80423B3C), at = macho_offset(macho, 0x80424120), clear = macho_offset(macho, 0x80413142);
    require_layout(head >= 0 && at >= 0 && clear >= 0 && at + 24 + N90_TRUST_CAPACITY * 20 <= kernel.length,
        "Unexpected N90 trust cache addresses");
    return { head, at, clear };
}

// A recognized local trust node is reversible. Recover the exact original
// kernel and check its full fingerprint before rebuilding from a new list.
export function n90_kernel_baseline(input)
{
    const kernel = new Uint8Array(input instanceof Uint8Array ? input : new Uint8Array(input));
    if(new SHA256().update(kernel).hex() === STOCK_KERNEL_SHA256) return kernel;
    const { head, at, clear } = trust_offsets(kernel), v = view(kernel), count = v.getUint32(at + 20, true);
    require_layout(v.getUint32(head, true) === 0x80424120 && v.getUint16(clear, true) === 0xBF00 &&
        v.getUint32(at, true) === 0 && count <= N90_TRUST_CAPACITY, "Unrecognized N90 kernel trust modifications");
    kernel.fill(0, at, at + 24 + count * 20);
    v.setUint32(head, 0, true); v.setUint16(clear, 0x60E5, true);
    require_layout(new SHA256().update(kernel).hex() === STOCK_KERNEL_SHA256, "Expected the stock N90 10B329 kernel baseline");
    return kernel;
}

export function n90_kernel_hashes(kernel)
{
    if(!(kernel instanceof Uint8Array)) kernel = new Uint8Array(kernel);
    n90_kernel_baseline(kernel);
    const { head, at } = trust_offsets(kernel), v = view(kernel);
    if(!v.getUint32(head, true)) return [];
    return Array.from({ length: v.getUint32(at + 20, true) }, (_, i) => new Uint8Array(kernel.subarray(at + 24 + i * 20, at + 44 + i * 20)));
}

export function n90_trust_kernel(input, supplied)
{
    const original = n90_kernel_baseline(input), unique = new Map();
    for(const hash of supplied)
    {
        require_layout(hash instanceof Uint8Array && hash.length === 20, "Invalid N90 CDHash");
        unique.set([...hash].map(b => b.toString(16).padStart(2, "0")).join(""), new Uint8Array(hash));
    }
    require_layout(unique.size <= N90_TRUST_CAPACITY, "iPhone application trust cache is full (" + N90_TRUST_CAPACITY + " code hashes maximum)");
    const hashes = [...unique.values()];
    hashes.sort((a, b) => {
        for(let i = 0; i < a.length; i++) if(a[i] !== b[i]) return a[i] - b[i];
        return 0;
    });
    const node = new Uint8Array(24 + hashes.length * 20);
    for(const [i, hash] of hashes.entries()) node.set(hash, 24 + i * 20);
    node.set(new SHA256().update(node.subarray(24)).digest().subarray(0, 16), 4);
    view(node).setUint32(20, hashes.length, true);

    const kernel = new Uint8Array(original), v = view(kernel), { head, at, clear } = trust_offsets(kernel), address = 0x80424120;
    require_layout(v.getUint32(head, true) === 0 && address + node.length <= 0x80425000 &&
        kernel.subarray(at, at + node.length).every(b => b === 0) && clear >= 0 && v.getUint16(clear, true) === 0x60E5,
        "Unexpected N90 AMFI trust cache layout");
    // Keep AMFI's native checks and trust only the validated local binaries.
    v.setUint16(clear, 0xBF00, true);
    v.setUint32(head, address, true);
    kernel.set(node, at);
    return kernel;
}
