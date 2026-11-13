import { inspect_ipa } from "./ipa.js";
import { plist_encode, plist_parse } from "./plist.js";
import { macho_entitlements, macho_link_library, sign_macho } from "./codesign.js";
import { cdhashes, SYSTEM_GL_LIBRARY } from "./guest_load.js";
import { zip_read, zip_stream } from "../android/zip.js";
import { SHA1 } from "./crypto.js";
import { SHA256 } from "../image/sha256.js";
import { write_ipa_zip } from "./ipa_zip.js";

const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");

export async function prepare_ipa(read, size, sink, { graphics = true, progress = () => {} } = {})
{
    const app = await inspect_ipa(read, size, progress), replacements = new Map(), removed = new Set();
    const entries = new Map(app.entries.map(e => [e.name, e])), prefix = app.root + "/";
    const bundles = [{ root: app.root, info: app.info, executable: app.main.path }];
    for(const entry of app.entries)
    {
        if(entry.name.startsWith(prefix) && /\/(?:_CodeSignature\/|embedded\.mobileprovision$)/.test(entry.name)) removed.add(entry.name);
        if(entry.name !== prefix + "Info.plist" && /\.(?:app|framework|bundle)\/Info\.plist$/.test(entry.name))
        {
            const info = plist_parse(await zip_read(read, entry)), root = entry.name.slice(0, -11);
            if(typeof info?.CFBundleExecutable === "string" && app.code.some(c => c.path === root + "/" + info.CFBundleExecutable))
                bundles.push({ root, info, executable: root + "/" + info.CFBundleExecutable });
        }
    }
    const trusted = [];
    const readMember = async path => replacements.get(path) || zip_read(read, entries.get(path));
    // Leaf code first; containing bundles seal the final bytes of their children.
    for(const code of [...app.code].sort((a, b) => b.path.split("/").length - a.path.split("/").length))
    {
        let bytes = code.bytes;
        const bundle = bundles.find(b => b.executable === code.path);
        if(graphics && code.path === app.main.path) bytes = macho_link_library(bytes, SYSTEM_GL_LIBRARY);
        let resources = null, info = null;
        if(bundle)
        {
            const files = Object.create(null), files2 = Object.create(null), rules = { "^.*": true };
            const members = [...app.entries, ...[...replacements.keys()].filter(p => !entries.has(p)).map(name => ({ name, unix_mode: 0o100644 }))];
            for(const entry of members)
            {
                if(!entry.name.startsWith(bundle.root + "/") || entry.name.endsWith("/") || removed.has(entry.name) || entry.name === code.path) continue;
                const relative = entry.name.slice(bundle.root.length + 1);
                if((entry.unix_mode & 0o170000) === 0o120000)
                {
                    files2[relative] = { symlink: new TextDecoder().decode(await readMember(entry.name)) };
                    rules["^" + relative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"] = { omit: true, weight: 2000 };
                    continue;
                }
                const one = new SHA1(), two = new SHA256();
                if(replacements.has(entry.name)) { const data = replacements.get(entry.name); one.update(data); two.update(data); }
                else await zip_stream(read, entry, data => { one.update(data); two.update(data); });
                files[relative] = one.digest();
                if(relative !== "Info.plist" && relative !== "PkgInfo") files2[relative] = { hash: files[relative], hash2: two.digest() };
            }
            resources = plist_encode({ files, files2, rules, rules2: { "^.*": true,
                "^Info\\.plist$": { omit: true, weight: 20 }, "^PkgInfo$": { omit: true, weight: 20 } } });
            replacements.set(bundle.root + "/_CodeSignature/CodeResources", resources);
            removed.delete(bundle.root + "/_CodeSignature/CodeResources");
            info = await readMember(bundle.root + "/Info.plist");
        }
        const entitlements = macho_entitlements(code.bytes);
        const identifier = bundle?.info.CFBundleIdentifier || code.path.slice(prefix.length).replaceAll("/", ".");
        bytes = sign_macho(bytes, { identifier, info, resources, entitlements });
        replacements.set(code.path, bytes);
        trusted.push({ path: code.path.slice(prefix.length), cdhashes: cdhashes(bytes).map(hex) });
        progress("Preparing application", trusted.length, app.code.length);
    }
    const digest = new SHA256();
    const preparedSize = await write_ipa_zip(read, app.entries, replacements, removed, async bytes => { digest.update(bytes); await sink(bytes); },
        new Set(app.code.map(c => c.path)));
    return { format: "v86-ios-install", version: 1, ...app.report, prepared_size: preparedSize,
        prepared_sha256: digest.hex(), graphics, trusted };
}
