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
    require_layout(new SHA256().update(original).hex() ===
        "82127c1ea84dbc1b55f423a4d60cdfe6a3baaabc117d4a891af0b502e57a2c47", "Expected the stock N90 10B329 kernel");
    const hashes = trusted.flatMap(cdhashes);
    hashes.sort((a, b) => {
        for(let i = 0; i < a.length; i++) if(a[i] !== b[i]) return a[i] - b[i];
        return 0;
    });
    const node = new Uint8Array(24 + hashes.length * 20);
    for(const [i, hash] of hashes.entries()) node.set(hash, 24 + i * 20);
    node.set(new SHA256().update(node.subarray(24)).digest().subarray(0, 16), 4);
    view(node).setUint32(20, hashes.length, true);

    const kernel = new Uint8Array(original), v = view(kernel), macho = macho_parse(kernel);
    const head = macho_offset(macho, 0x80423B3C), address = 0x80424120, at = macho_offset(macho, address);
    const clear = macho_offset(macho, 0x80413142);
    require_layout(head >= 0 && v.getUint32(head, true) === 0 && at >= 0 && address + node.length <= 0x80425000 &&
        kernel.subarray(at, at + node.length).every(b => b === 0) && clear >= 0 && v.getUint16(clear, true) === 0x60E5,
        "Unexpected N90 AMFI trust cache layout");
    // Keep AMFI's native checks and trust only the validated local binaries.
    v.setUint16(clear, 0xBF00, true);
    v.setUint32(head, address, true);
    kernel.set(node, at);
    return kernel;
}
