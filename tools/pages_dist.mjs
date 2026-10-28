#!/usr/bin/env node
// The VM manager (index.html) as a static site, for Cloudflare Pages
// (docs/vm-manager.md, "Deployment"; .github/workflows/pages.yml): the page
// and every file it loads, at the paths it uses, in build/pages/.
// - The page's version (the query of the files it loads, the app's
//   query_append) is a hash of the files: a deployment never mixes cached
//   files of another;
// - the footer's links to the debug pages go (they are not deployed); its
//   version links the commit;
// - _headers makes the site cross-origin isolated (COOP/COEP, as
//   tools/dev-server.py): the cores in host threads need SharedArrayBuffer;
// - 404.html: a missing file is a 404 (without it Cloudflare Pages answers
//   any path with index.html and 200, and a wrong image URL becomes a disk of
//   HTML).
// Run by `make pages`, which builds the files first.
//   node tools/pages_dist.mjs [output directory]

import { mkdir, readFile as read_file, rename, rm, writeFile as write_file } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash as create_hash } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.argv[2] || join(root, "build/pages");
const graphics = JSON.parse(await read_file(join(root, "build/glbridge/manifest.json"), "utf8"));

// (Makefile, PAGES_BUILD)
const FILES = [
    "index.html", "manifest.json", "192.png", "src/app/app.css",
    "build/v86_app.js", "build/v86_app.js.map", "build/android-import-worker.js", "build/android-import-worker.js.map", "build/libv86.mjs", "build/cpu-worker.js", "build/vcpu-worker.js", "build/xterm.js",
    "build/v86.wasm", "build/v86-fallback.wasm", "build/v86-parallel.wasm",
    "build/v86-arm64.wasm", "build/v86-arm64-fallback.wasm", "build/v86-arm64-parallel.wasm",
    "build/v86-bochs-vga.js", "build/v86-vmware-svga.js", "build/v86-virtio-gpu.js", "build/v86-ne2k.js", "build/v86-e1000.js", "build/v86-sb16.js", "build/v86-hd-audio.js", "build/v86-usb.js",
    "build/v86-tpm.js", "build/libtpms.wasm", "bios/LIBTPMS-LICENSES.txt", "build/v86-gles.js", "build/glslang.wasm", "bios/GLSLANG-LICENSES.txt",
    "bios/seabios.bin", "bios/vgabios.bin", "bios/bochs-bios.bin", "bios/bochs-vgabios.bin",
    // (the UEFI firmware, docs/uefi.md, with its licenses)
    "bios/ovmf-code.fd", "bios/ovmf-vars.fd", "bios/OVMF-LICENSES.txt",
    "bios/ovmf-secure-code.fd", "bios/ovmf-vars-ms.fd", "bios/SECUREBOOT-OBJECTS-LICENSE.txt",
    ...graphics.files.map(name => "build/glbridge/" + name), "build/glbridge/manifest.json",
];

const files = new Map();
for(const name of FILES)
{
    try
    {
        files.set(name, await read_file(join(root, name)));
    }
    catch(error)
    {
        throw new Error(name + " is missing (make pages builds it): " + error.message);
    }
}

const hash = create_hash("sha256");
for(const [name, data] of files) hash.update(name).update(data);
const version = hash.digest("hex").slice(0, 20);

/** The commit's page on GitHub, or null */
function commit_url()
{
    try
    {
        const commit = process.env.GITHUB_SHA || execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        let repository = process.env.GITHUB_REPOSITORY;
        if(!repository)
        {
            const origin = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
            const match = origin.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
            repository = match && match[1];
        }
        return repository ? "https://github.com/" + repository + "/commit/" + commit : null;
    }
    catch(error)
    {
        return null;
    }
}

let page = files.get("index.html").toString("utf8");
const stamp = page.match(/<a id="version" href="([^"]*)">([^<]+)<\/a>(?: \([^)]*\))?/);
if(!stamp) throw new Error("index.html has no version stamp (<a id=\"version\">)");
page = page.split("?" + stamp[2] + "\"").join("?" + version + "\"")
    .replace(stamp[0], `<a id="version" href="${commit_url() || stamp[1]}">${version}</a>`)
    .replace(/\s*<a href="(?:app_)?debug\.html">[^<]*<\/a>\s*&mdash;/g, "");
if(page.includes("?" + stamp[2] + "\"")) throw new Error("index.html: the old version is still in it");
files.set("index.html", Buffer.from(page));

const app_manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
app_manifest["start_url"] = "./";
files.set("manifest.json", Buffer.from(JSON.stringify(app_manifest, null, 4) + "\n"));

files.set("_headers", Buffer.from([
    "# Cross-origin isolated, as tools/dev-server.py: the cores in host threads need SharedArrayBuffer",
    "/*",
    "  Cross-Origin-Opener-Policy: same-origin",
    "  Cross-Origin-Embedder-Policy: require-corp",
    "",
].join("\n")));

files.set("404.html", Buffer.from([
    "<!doctype html>",
    "<meta charset=\"utf-8\">",
    "<title>Not found</title>",
    "<p>Not found. <a href=\"/\">The virtual machines</a></p>",
    "",
].join("\n")));

// (written beside, then swapped in)
const next = output + ".next";
await rm(next, { recursive: true, force: true });
for(const [name, data] of files)
{
    await mkdir(dirname(join(next, name)), { recursive: true });
    await write_file(join(next, name), data);
}
await rm(output, { recursive: true, force: true });
await rename(next, output);
const bytes = [...files.values()].reduce((sum, data) => sum + data.length, 0);
console.log("pages: " + files.size + " files (" + (bytes / 1048576).toFixed(1) + " MiB), version " + version + ", in " + output);
