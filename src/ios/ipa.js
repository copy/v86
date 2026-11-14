// Local, bounded inspection of device IPA archives. The returned report is
// serializable; code and archive entries stay in the preparation worker.
import { zip_entries, zip_read, zip_stream } from "../android/zip.js";
import { plist_parse } from "./plist.js";
import { macho_armv7 } from "../apple/macho.js";
import { SHA256 } from "../image/sha256.js";

export const IPA_LIMITS = Object.freeze({ archive: 2 * 1024 ** 3, expanded: 4 * 1024 ** 3,
    member: 512 * 1024 ** 2, code: 128 * 1024 ** 2, entries: 100000, plist: 4 * 1024 ** 2 });
const fail = message => { throw new Error("IPA: " + message); };
const decode = bytes => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

export function ios_version(value)
{
    if(typeof value !== "string" || !/^\d{1,4}(\.\d{1,4}){0,2}$/.test(value)) fail("invalid iOS version");
    const [a, b = 0, c = 0] = value.split(".").map(Number);
    return a * 100000000 + b * 10000 + c;
}

function archive_path(name)
{
    if(!name || name.startsWith("/") || name.includes("\\") || /[\x00-\x1F\x7F]/.test(name) || name.length > 1024)
        fail("invalid archive path");
    const parts = name.replace(/\/$/, "").split("/");
    if(parts.some(p => !p || p === "." || p === ".." || p.length > 255)) fail("unsafe archive path: " + name);
    return parts.join("/").normalize("NFC");
}

export async function inspect_ipa(read, size, progress = () => {})
{
    if(!Number.isSafeInteger(size) || size > IPA_LIMITS.archive) fail("archive exceeds the 2 GiB limit");
    const entries = await zip_entries(read, size, { max_entries: IPA_LIMITS.entries, max_directory_bytes: 32 << 20 });
    const names = new Map(); let expanded = 0;
    for(const entry of entries)
    {
        const key = archive_path(entry.name);
        if(names.has(key)) fail("duplicate archive path: " + entry.name);
        names.set(key, entry);
        if(!Number.isSafeInteger(entry.size) || entry.size > IPA_LIMITS.member || entry.size < 0 ||
            !Number.isSafeInteger(entry.offset + entry.compressed_size) || entry.offset + entry.compressed_size > size)
            fail("invalid or oversized member: " + entry.name);
        expanded += entry.size;
        if(expanded > IPA_LIMITS.expanded) fail("expanded archive exceeds the 4 GiB limit");
        if(entry.flags & 1 || ![0, 8].includes(entry.method)) fail("unsupported ZIP member: " + entry.name);
        const type = entry.unix_mode & 0o170000;
        if(type && ![0o100000, 0o040000, 0o120000].includes(type)) fail("unsupported file type: " + entry.name);
    }
    for(const key of names.keys())
    {
        const parts = key.split("/");
        while(parts.length > 1)
        {
            parts.pop(); const parent = names.get(parts.join("/"));
            if(parent && (parent.unix_mode & 0o170000) === 0o120000) fail("symbolic link used as a parent directory: " + parent.name);
            if(parent && !parent.name.endsWith("/") && (parent.unix_mode & 0o170000) !== 0o040000)
                fail("file used as a parent directory: " + parent.name);
        }
    }
    const roots = new Set(entries.map(e => /^Payload\/([^/]+\.app)(?:\/|$)/.exec(e.name)?.[1]).filter(Boolean));
    if(roots.size !== 1) fail("expected exactly one Payload/*.app application");
    const root = "Payload/" + [...roots][0], prefix = root + "/";
    if(entries.some(e => (e.unix_mode & 0o170000) === 0o120000 && (!e.name.startsWith(prefix) || e.name.endsWith("/"))))
        fail("symbolic link outside the application or with a directory entry name");
    const payloadDirectory = e => e.name === "Payload/" && e.size === 0 &&
        [0, 0o040000].includes(e.unix_mode & 0o170000);
    if(entries.some(e => e.name.startsWith("Payload/") && !payloadDirectory(e) && e.name !== root && !e.name.startsWith(prefix)))
        fail("unexpected entry beside the main application");
    const plistEntry = names.get(prefix + "Info.plist");
    if(!plistEntry || plistEntry.size > IPA_LIMITS.plist) fail("missing or oversized Info.plist");
    const info = plist_parse(await zip_read(read, plistEntry));
    if(!info || typeof info !== "object" || Array.isArray(info)) fail("Info.plist must be a dictionary");
    if(typeof info.CFBundleIdentifier !== "string" || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(info.CFBundleIdentifier))
        fail("invalid CFBundleIdentifier");
    const executable = info.CFBundleExecutable;
    if(typeof executable !== "string" || !executable || executable.includes("/") || archive_path(executable) !== executable)
        fail("invalid CFBundleExecutable");
    const minimum = info.MinimumOSVersion || "0";
    if(ios_version(minimum) > ios_version("6.1.3")) fail("application requires iOS " + minimum);
    if(info.UIDeviceFamily && (!Array.isArray(info.UIDeviceFamily) || !info.UIDeviceFamily.includes(1)))
        fail("application does not support iPhone");
    if(info.CFBundleSupportedPlatforms && (!Array.isArray(info.CFBundleSupportedPlatforms) ||
        !info.CFBundleSupportedPlatforms.includes("iPhoneOS"))) fail("not an iPhoneOS device application");
    const required = info.UIRequiredDeviceCapabilities;
    if(Array.isArray(required) && required.some(x => ["arm64", "armv7s", "opengles-3", "metal"].includes(x)))
        fail("application requires hardware newer than iPhone 4");
    if(required && !Array.isArray(required) && typeof required === "object" &&
        ["arm64", "armv7s", "opengles-3", "metal"].some(k => required[k] === true))
        fail("application requires hardware newer than iPhone 4");
    const code = [], links = new Map(); let checked = 0;
    for(const entry of entries)
    {
        // Verify every ZIP member before modifying any data, including resources.
        let produced = 0;
        await zip_stream(read, entry, bytes => {
            produced += bytes.length;
            if(produced > entry.size || produced > IPA_LIMITS.member) fail("member exceeds declared size");
        });
        if(entry.name.startsWith(prefix) && !entry.name.endsWith("/"))
        {
            if((entry.unix_mode & 0o170000) === 0o120000)
            {
                if(entry.size > 4096) fail("oversized symbolic link");
                const target = decode(await zip_read(read, entry));
                if(target.startsWith("/") || target.includes("\\") || /[\x00-\x1F]/.test(target)) fail("unsafe symbolic link");
                const stack = entry.name.slice(prefix.length).split("/").slice(0, -1);
                for(const part of target.split("/")) {
                    if(part === "..") { if(!stack.length) fail("symbolic link escapes application"); stack.pop(); }
                    else if(part && part !== ".") stack.push(part);
                }
                links.set(entry.name.slice(prefix.length).normalize("NFC"), target.normalize("NFC"));
            }
            else
            {
                const head = await zip_read(read, entry, 4);
                const magic = head.length === 4 ? new DataView(head.buffer, head.byteOffset, 4).getUint32(0) : 0;
                if([0xCEFAEDFE, 0xCFFAEDFE, 0xCAFEBABE, 0xBEBAFECA].includes(magic))
                {
                    if(entry.size > IPA_LIMITS.code) fail("code exceeds the 128 MiB limit");
                    const slice = macho_armv7(await zip_read(read, entry));
                    if(slice.parsed.min_ios && ios_version(slice.parsed.min_ios) > ios_version("6.1.3"))
                        fail(entry.name + " requires iOS " + slice.parsed.min_ios);
                    code.push({ path: entry.name, ...slice });
                }
            }
        }
        progress("Checking IPA", ++checked, entries.length);
    }
    // Lexical ".." checks alone miss a/.. when a itself points at ".".
    // Resolve the whole link graph, preserving Unix traversal semantics.
    for(const [name, target] of links)
    {
        const pending = [...name.split("/").slice(0, -1), ...target.split("/")], path = [];
        let followed = 0;
        while(pending.length)
        {
            const part = pending.shift();
            if(!part || part === ".") continue;
            if(part === "..") { if(!path.length) fail("symbolic link chain escapes application"); path.pop(); continue; }
            path.push(part);
            const alias = links.get(path.join("/"));
            if(alias !== undefined)
            {
                if(++followed > 40) fail("symbolic link cycle or excessive indirection");
                path.pop(); pending.unshift(...alias.split("/"));
            }
        }
    }
    const main = code.find(c => c.path === prefix + executable);
    if(!main || main.parsed.filetype !== 2) fail("missing ARMv7 application executable");
    const digest = new SHA256();
    for(let at = 0; at < size; at += 1 << 20)
    {
        const length = Math.min(1 << 20, size - at), bytes = await read(at, length);
        if(bytes.length !== length) fail("short archive read");
        digest.update(bytes);
    }
    const report = { name: String(info.CFBundleDisplayName || info.CFBundleName || [...roots][0].slice(0, -4)),
        bundle_id: info.CFBundleIdentifier, executable, version: String(info.CFBundleShortVersionString || info.CFBundleVersion || ""),
        build: String(info.CFBundleVersion || ""), minimum_ios: minimum, architecture: "armv7", size, expanded_size: expanded,
        original_sha256: digest.hex(), code_count: code.length };
    return { report, entries, info, root, main, code };
}
