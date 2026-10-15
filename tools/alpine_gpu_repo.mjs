#!/usr/bin/env node
// Build build/x64-linux/gpu-repo.tar: a local Alpine 3.24 x86_64 package
// repository with Mesa and the GPU test programs, for the x86_64 Linux guest
// tests of the display adapters (tests/x64/linux_gpu.mjs). The repository
// keeps Alpine's own signed APKINDEX, so the guest installs from it with
//
//     tar -xf /dev/sda -C /mnt/repo
//     apk add --no-network --repository /mnt/repo/main --repository /mnt/repo/community <packages>
//
// Alpine 3.24's Mesa (26.1) has no virgl driver, so v3.23/ holds 3.23's Mesa
// (25.2, which has it) and what it needs, for virtio_gpu's 3D:
//
//     apk add --no-network --repository /mnt/repo/v3.23/main --repository /mnt/repo/v3.23/community 'mesa-dri-gallium<26' ...
//
//     node tools/alpine_gpu_repo.mjs

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "build/x64-linux/gpu-repo");
const MIRROR = "https://dl-cdn.alpinelinux.org/alpine/";
const REPOS = ["main", "community"];

export const PACKAGES = [
    "mesa-dri-gallium", "mesa-gbm", "mesa-egl", "mesa-gl", "mesa-gles",
    "kmscube", "mesa-demos", "mesa-utils", "libdrm-tests",
    "weston", "weston-backend-drm", "weston-shell-desktop", "weston-terminal", "weston-clients",
    "seatd", "vulkan-tools",
    // Vulkan: Venus (virtio_gpu's) and lavapipe (the reference to compare it with)
    "mesa-vulkan-virtio", "mesa-vulkan-swrast",
];
/** The Mesa with virgl (Alpine 3.23's), under v3.23/ */
export const VIRGL_PACKAGES = ["mesa-dri-gallium", "mesa-gbm", "mesa-egl", "mesa-gl", "mesa-gles"];

/** Extract the APKINDEX member of a gzipped tar */
export function apkindex(tar_gz)
{
    const tar = zlib.gunzipSync(tar_gz);
    for(let offset = 0; offset + 512 <= tar.length;)
    {
        const name = tar.subarray(offset, offset + 100).toString("latin1").replace(/\0.*$/s, "");
        const size = parseInt(tar.subarray(offset + 124, offset + 136).toString("latin1"), 8) || 0;
        if(name === "APKINDEX") return tar.subarray(offset + 512, offset + 512 + size).toString("utf8");
        offset += 512 + Math.ceil(size / 512) * 512;
        if(!name) break;
    }
    throw new Error("no APKINDEX in the index archive");
}

/**
 * An APKINDEX's records (Alpine's apk spec: one "X:value" line per field, a
 * blank line between packages), the first record of each package name
 * @param {string} text
 * @return {!Map<string, !Object<string, string>>}
 */
export function parse_apkindex(text)
{
    const records = new Map();
    for(const record of text.split("\n\n"))
    {
        const fields = {};
        for(const line of record.split("\n"))
        {
            if(line[1] === ":") fields[line[0]] = line.slice(2);
        }
        if(fields.P && !records.has(fields.P)) records.set(fields.P, fields);
    }
    return records;
}

async function fetch_bytes(location)
{
    const response = await fetch(location);
    if(!response.ok) throw new Error(location + ": HTTP " + response.status);
    return Buffer.from(await response.arrayBuffer());
}

/**
 * A branch's packages and everything they depend on, with the branch's index
 * @param {string} branch e.g. "v3.24"
 * @param {string} out
 * @param {!Array<string>} names
 * @param {string=} arch
 */
async function build_repo(branch, out, names, arch = "x86_64")
{
    const packages = new Map();     // name -> { repo, version, deps, provides }
    const providers = new Map();    // provided name -> package name

    for(const repo of REPOS)
    {
        const directory = path.join(out, repo, arch);
        fs.mkdirSync(directory, { recursive: true });
        const index_path = path.join(directory, "APKINDEX.tar.gz");
        if(!fs.existsSync(index_path)) fs.writeFileSync(index_path, await fetch_bytes(`${MIRROR}${branch}/${repo}/${arch}/APKINDEX.tar.gz`));
        for(const fields of parse_apkindex(apkindex(fs.readFileSync(index_path))).values())
        {
            if(packages.has(fields.P)) continue;
            const entry = { repo, version: fields.V, deps: (fields.D || "").split(" ").filter(Boolean), provides: [] };
            packages.set(fields.P, entry);
            for(const provided of (fields.p || "").split(" ").filter(Boolean))
            {
                const name = provided.replace(/[<>=~].*$/, "");
                if(!providers.has(name)) providers.set(name, fields.P);
            }
        }
    }

    const wanted = new Set();
    const missing = [];
    function want(dependency)
    {
        if(dependency.startsWith("!")) return;
        const name = dependency.replace(/[<>=~].*$/, "");
        const package_name = packages.has(name) ? name : providers.get(name);
        if(!package_name) { missing.push(dependency); return; }
        if(wanted.has(package_name)) return;
        wanted.add(package_name);
        for(const next of packages.get(package_name).deps) want(next);
    }
    for(const name of names)
    {
        if(!packages.has(name)) throw new Error("no package " + name + " in Alpine " + branch);
        want(name);
    }

    let bytes = 0;
    for(const name of [...wanted].sort())
    {
        const { repo, version } = packages.get(name);
        const file = path.join(out, repo, arch, `${name}-${version}.apk`);
        if(!fs.existsSync(file)) fs.writeFileSync(file, await fetch_bytes(`${MIRROR}${branch}/${repo}/${arch}/${name}-${version}.apk`));
        bytes += fs.statSync(file).size;
    }
    console.log(`${branch}: ${wanted.size} packages, ${(bytes / 1048576).toFixed(1)} MiB` +
        (missing.length ? `; unresolved (provided by the base system): ${[...new Set(missing)].join(" ")}` : ""));
}

// (run as a script, not when imported for its APKINDEX helpers)
if(process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url))
{
    await build_repo("v3.24", OUT, PACKAGES);
    await build_repo("v3.23", path.join(OUT, "v3.23"), VIRGL_PACKAGES);

    // A ustar image on the IDE disk (as for tests/x64/linux_boot.mjs's probes):
    // the guest unpacks it with `tar -xf /dev/sda`, names intact
    const image = path.join(ROOT, "build/x64-linux/gpu-repo.tar");
    const result = spawnSync("bsdtar", ["--format", "ustar", "--no-xattrs", "--no-mac-metadata", "--uid", "0", "--gid", "0",
        "-cf", image, "-C", OUT, ...REPOS, "v3.23"], { encoding: "utf8" });
    if(result.status !== 0) throw new Error("bsdtar: " + result.stderr);
    console.log("Wrote " + path.relative(ROOT, image));
}
