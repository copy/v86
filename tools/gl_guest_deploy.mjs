#!/usr/bin/env node
// F6: Windows performs filesystem edits in a RAM overlay. After clean shutdown,
// apply its bounded block patch to an APFS clone, verify files, then swap it in.
import fs from "node:fs";
import path from "node:path";
import { execFileSync as exec_file_sync } from "node:child_process";
import { createHash as create_hash } from "node:crypto";
import { gunzipSync as gunzip_sync } from "node:zlib";
import { fileURLToPath as file_url_to_path } from "node:url";
import { generate } from "../src/iso9660.js";
import { site_directory } from "../tests/lib/site.mjs";
const root = file_url_to_path(new URL("../", import.meta.url));
const hash_bytes = bytes => create_hash("sha256").update(bytes).digest("hex");
export function hash_file(file)
{
    const hash = create_hash("sha256"), buffer = Buffer.alloc(1024 * 1024), fd = fs.openSync(file, "r");
    try { for(;;) { const count = fs.readSync(fd, buffer, 0, buffer.length, null);if(!count) break;hash.update(buffer.subarray(0, count)); } }
    finally { fs.closeSync(fd); }
    return hash.digest("hex");
}
export function parse_patch(raw, size)
{
    if(raw.length < 24 || raw.subarray(0, 8).toString() !== "V86GLDP1" || raw.readUInt32LE(8) !== 256 || raw.readBigUInt64LE(16) !== BigInt(size)) throw new Error("Invalid disk patch header");
    const count = raw.readUInt32LE(12), data_at = 24 + count * 8;
    if(count > size / 256 || raw.length !== data_at + count * 256) throw new Error("Invalid disk patch length");
    const indices = [], seen = new Set();
    for(let i = 0; i < count; i++) {
        const value = raw.readBigUInt64LE(24 + i * 8);
        if(value >= BigInt(size / 256)) throw new Error("Patch block outside disk");
        const index = Number(value);if(seen.has(index)) throw new Error("Duplicate patch block");seen.add(index);indices.push(index);
    }
    return { indices, data: raw.subarray(data_at) };
}
function image_file_hash(image, name)
{
    return hash_bytes(exec_file_sync("7zz", ["x", "-so", image, name], { maxBuffer: 16 * 1024 * 1024 }));
}
export function ntfs_volume_flags(image)
{
    const fd = fs.openSync(image, "r"), read = (at, size) => { const b = Buffer.alloc(size);if(fs.readSync(fd, b, 0, size, at) !== size) throw new Error("Short NTFS metadata read");return b; };
    try {
        let base = 0, boot = read(0, 512);
        if(boot.subarray(3, 11).toString() !== "NTFS    ") {
            for(let i = 0; i < 4; i++) if(boot[446 + 16 * i + 4] === 7) { base = boot.readUInt32LE(446 + 16 * i + 8) * 512;break; }
            if(!base) return null;boot = read(base, 512);
            if(boot.subarray(3, 11).toString() !== "NTFS    ") return null;
        }
        const sector = boot.readUInt16LE(11), cluster = sector * boot[13], encoded = boot.readInt8(64), record_size = encoded < 0 ? 2 ** -encoded : encoded * cluster;
        if(sector < 512 || sector > 4096 || record_size < 512 || record_size > 65536) throw new Error("Invalid NTFS geometry");
        const record = read(base + Number(boot.readBigUInt64LE(48)) * cluster + 3 * record_size, record_size);
        if(record.subarray(0, 4).toString() !== "FILE") throw new Error("Invalid NTFS volume record");
        const fixup = record.readUInt16LE(4), count = record.readUInt16LE(6), sequence = record.readUInt16LE(fixup);
        if(fixup + count * 2 > record.length) throw new Error("Invalid NTFS fixups");
        for(let i = 1; i < count; i++) { const at = i * sector - 2;if(at + 2 > record.length || record.readUInt16LE(at) !== sequence) throw new Error("NTFS fixup mismatch");record.writeUInt16LE(record.readUInt16LE(fixup + 2 * i), at); }
        for(let at = record.readUInt16LE(20); at + 24 <= record.length;) {
            const type = record.readUInt32LE(at);if(type === 0xFFFFFFFF) break;const length = record.readUInt32LE(at + 4);if(length < 24 || at + length > record.length) throw new Error("Invalid NTFS attribute");
            if(type === 0x70 && !record[at + 8]) { const value = record.readUInt16LE(at + 20);if(value + 12 > length) throw new Error("Invalid NTFS volume information");return record.readUInt16LE(at + value + 10); }
            at += length;
        }
        throw new Error("NTFS volume flags missing");
    } finally { fs.closeSync(fd); }
}
export function apply_patch_clone({ image, expected_hash, raw, files = [], protected_files = [] })
{
    if(hash_file(image) !== expected_hash) throw new Error("Source image changed since preparation: " + image);
    const size = fs.statSync(image).size, patch = parse_patch(raw, size), suffix = ".opengl-webgpu-F6-" + Date.now() + "-" + process.pid;
    const staging = image + suffix + ".staging", backup = image + suffix + ".backup";
    if(fs.existsSync(staging) || fs.existsSync(backup)) throw new Error("Deployment staging path already exists");
    let moved = false;
    try {
        exec_file_sync("cp", [process.platform === "darwin" ? "-c" : "--reflink=auto", image, staging]);
        const fd = fs.openSync(staging, "r+");
        try {
            for(let i = 0; i < patch.indices.length;) {
                let end = i + 1;while(end < patch.indices.length && patch.indices[end] === patch.indices[end - 1] + 1) end++;
                const bytes = patch.data.subarray(i * 256, end * 256);let written = 0;
                while(written < bytes.length) { const n = fs.writeSync(fd, bytes, written, bytes.length - written, patch.indices[i] * 256 + written);if(!n) throw new Error("Short disk patch write");written += n; }
                i = end;
            }
            fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        const verified = [];
        for(const file of [...files, ...protected_files]) { const actual = image_file_hash(staging, file.path);if(actual !== file.sha256) throw new Error("Image file verification failed: " + file.path);verified.push({ ...file, sha256: actual }); }
        const ntfs_flags = ntfs_volume_flags(staging);if(ntfs_flags !== null && ntfs_flags & 1) throw new Error("Guest NTFS volume did not shut down cleanly");
        const after = hash_file(staging);fs.renameSync(image, backup);moved = true;
        try { fs.renameSync(staging, image); } catch(error) { fs.renameSync(backup, image);moved = false;throw error; }
        return { image, backup, before: expected_hash, after, size, blocks: patch.indices.length, ntfsFlags: ntfs_flags, verified };
    } finally { if(fs.existsSync(staging)) fs.unlinkSync(staging);if(moved && !fs.existsSync(image)) fs.renameSync(backup, image); }
}
function prepare(game)
{
    const site = site_directory(root), out = root + "build/gl-deploy-" + game + "/";fs.mkdirSync(out, { recursive: true });
    const dll = site + "/glbridge/openglproxy/opengl32.dll", sys = site + "/glbridge/v86gl_driver/v86gl.sys";
    const payloads = { dll: { source: dll, sha256: hash_file(dll) }, driver: { source: sys, sha256: hash_file(sys) } };
    const images = { hda: { path: site + "/windowsxp/windowsxp_multidisk_C_4G.img" }, hdb: { path: site + "/game/" + game + ".img" } };
    for(const image of Object.values(images)) { const stat = fs.statSync(image.path);Object.assign(image, { size: stat.size, mtimeMs: stat.mtimeMs, sha256: hash_file(image.path) }); }
    images.hda.files = [{ path: "v86gl/v86gl.sys", sha256: payloads.driver.sha256 }, { path: "winproxy/opengl32.dll", sha256: payloads.dll.sha256 }];
    images.hda.protected_files = ["WINDOWS/system32/opengl32.dll", "WINDOWS/system32/dllcache/opengl32.dll"].map(name => ({ path: name, sha256: image_file_hash(images.hda.path, name) }));
    const target = game === "cube2" ? "SauerbratenPortable/App/Sauerbraten/bin/opengl32.dll" : "Warcraft III/opengl32.dll";
    images.hdb.files = [{ path: target, sha256: payloads.dll.sha256 }];
    exec_file_sync("i686-w64-mingw32-gcc", ["-Os", "-Wall", "-Wextra", "-Werror", "-nostdlib", "-Wl,--subsystem,console:5.01", "-Wl,--entry,_entry@0", "-Wl,--no-insert-timestamp", "-o", out + "MARKER.EXE", root + "tests/glbridge/gl_guest_deploy_marker.c", "-lopengl32", "-lgdi32", "-luser32", "-lkernel32"], { stdio: "inherit" });
    exec_file_sync("i686-w64-mingw32-gcc", ["-Os", "-Wall", "-Wextra", "-Werror", "-nostdlib", "-Wl,--subsystem,console:5.01", "-Wl,--entry,_entry@0", "-Wl,--no-insert-timestamp", "-o", out + "PROBE.EXE", root + "tests/glbridge/gl_guest_probe.c", "-lopengl32", "-lgdi32", "-luser32", "-lkernel32"], { stdio: "inherit" });
    const setup = ["@echo off", "sc stop v86gl", "if not exist C:\\v86gl mkdir C:\\v86gl", "if not exist C:\\winproxy mkdir C:\\winproxy",
        "copy /y %~d0\\V86GL.SYS C:\\v86gl\\v86gl.sys", "if errorlevel 1 goto fail", "sc config v86gl type= kernel start= demand binPath= C:\\v86gl\\v86gl.sys",
        "sc create v86gl type= kernel start= demand binPath= C:\\v86gl\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto fail", "%~d0\\PROBE.EXE", "if errorlevel 1 goto fail",
        "copy /y %~d0\\OPENGL32.DLL C:\\winproxy\\opengl32.dll", "if errorlevel 1 goto fail", "copy /y %~d0\\OPENGL32.DLL \"D:\\" + target.replaceAll("/", "\\") + "\"", "if errorlevel 1 goto fail",
        "%~d0\\MARKER.EXE", "if errorlevel 1 goto fail", "shutdown -s -f -t 0", "goto end", ":fail", "echo GL_DEPLOY_FAILED_%ERRORLEVEL%", ":end", ""].join("\r\n");
    fs.writeFileSync(out + "DEPLOY.CMD", setup);
    const files = ["DEPLOY.CMD", "MARKER.EXE", "PROBE.EXE"].map(name => ({ name, contents: fs.readFileSync(out + name) }));
    files.push({ name: "OPENGL32.DLL", contents: fs.readFileSync(dll) }, { name: "V86GL.SYS", contents: fs.readFileSync(sys) });fs.writeFileSync(out + "tools.iso", Buffer.from(generate(files)));
    if(!fs.existsSync(out + "site")) fs.symlinkSync(site, out + "site");
    fs.writeFileSync(out + "inputs.json", JSON.stringify({ version: 1, game, site, payloads, images }, null, 2));console.log("Prepared deployment CD: " + out);
}
async function main()
{
    const game = process.argv.includes("--game=warcraft3") ? "warcraft3" : "cube2", out = root + "build/gl-deploy-" + game + "/";
    if(process.argv.includes("--prepare")) return prepare(game);
    if(!process.argv.includes("--apply")) throw new Error("Use --prepare or --apply [--game=warcraft3] [--game-only]");
    const input = JSON.parse(fs.readFileSync(out + "inputs.json", "utf8")), evidence = JSON.parse(fs.readFileSync(root + "build/browser-test-output/gl-deploy-" + game + ".json", "utf8"));
    if(!evidence.deployed || evidence.game !== game || evidence.errors.length) throw new Error("Guest deployment did not pass");
    const records = [];
    for(const [name, image] of Object.entries(input.images)) {
        if(name === "hda" && process.argv.includes("--game-only")) continue;
        const patch = evidence.disks.find(d => d.name === name);if(!patch) throw new Error("Missing exported disk patch");
        const packed = fs.readFileSync(root + "build/browser-test-output/" + patch.file);if(hash_bytes(packed) !== patch.sha256) throw new Error("Disk patch digest mismatch");
        records.push(apply_patch_clone({ image: image.path, expected_hash: image.sha256, raw: gunzip_sync(packed), files: image.files, protected_files: image.protected_files || [] }));
    }
    fs.writeFileSync(out + "deployment.json", JSON.stringify({ version: 1, game, payloads: input.payloads, records, evidence }, null, 2));console.log(JSON.stringify(records, null, 2));
}
if(process.argv[1] && path.resolve(process.argv[1]) === file_url_to_path(import.meta.url)) await main();
