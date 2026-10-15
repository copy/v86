#!/usr/bin/env node
// Build a local Alpine 3.24 package repository, as a ustar image, for the
// Linux guest tests: the dependency closure of a set of packages from
// Alpine's mirror, with Alpine's own signed APKINDEX, so the guest installs
// from it with
//
//     tar -xf /dev/sda -C /mnt/repo
//     apk add --no-network --repository /mnt/repo/main --repository /mnt/repo/community <packages>
//
//     node tools/alpine_repo.mjs [--arch x86_64|aarch64] [--set gpu|jit]
//
// --set gpu (the default): Mesa and the GPU test programs, for the display
// adapters' tests (tests/x64/linux_gpu.mjs). Alpine 3.24's Mesa (26.1) has
// no virgl driver, so v3.23/ holds 3.23's Mesa (25.2, which has it) and what
// it needs, for virtio_gpu's 3D:
//
//     apk add --no-network --repository /mnt/repo/v3.23/main --repository /mnt/repo/v3.23/community 'mesa-dri-gallium<26' ...
//
// --set jit: the guest JIT workloads of docs/arm64-virt-android16-plan.md
// P6.7 (V8 in nodejs, HotSpot in openjdk21, luajit, pcre2's JIT).
//
// The image is build/x64-linux/<set>-repo.tar for x86_64 and
// build/a64-linux/<set>-repo.tar for aarch64 (the unpacked repository next
// to it). (Before P6.7 this was tools/alpine_gpu_repo.mjs, x86_64 and gpu only.)

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
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
/** The guest JIT workloads (P6.7): `node`, `java Hello.java`, `luajit -jon`/`-joff`, `pcre2test -jit` */
export const JIT_PACKAGES = ["nodejs", "openjdk21-jdk", "luajit", "pcre2-tools"];
/** Where a set's repository and image go */
export const output_directory = arch => path.join(ROOT, arch === "aarch64" ? "build/a64-linux" : "build/x64-linux");

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
    const args = process.argv.slice(2);
    const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
    const arch = option("--arch", "x86_64");
    const set = option("--set", "gpu");
    if(!["x86_64", "aarch64"].includes(arch)) throw new Error("--arch: x86_64 or aarch64");
    if(!["gpu", "jit"].includes(set)) throw new Error("--set: gpu or jit");
    const out = path.join(output_directory(arch), set + "-repo");
    await build_repo("v3.24", out, set === "gpu" ? PACKAGES : JIT_PACKAGES, arch);
    if(set === "gpu") await build_repo("v3.23", path.join(out, "v3.23"), VIRGL_PACKAGES, arch);

    // A ustar image on the disk (as for tests/x64/linux_boot.mjs's probes):
    // the guest unpacks it with `tar -xf /dev/sda`, names intact
    const image = out + ".tar";
    const result = spawnSync("bsdtar", ["--format", "ustar", "--no-xattrs", "--no-mac-metadata", "--uid", "0", "--gid", "0",
        "-cf", image, "-C", out, ...REPOS, ...(set === "gpu" ? ["v3.23"] : [])], { encoding: "utf8" });
    if(result.status !== 0) throw new Error("bsdtar: " + result.stderr);
    console.log("Wrote " + path.relative(ROOT, image));
}
