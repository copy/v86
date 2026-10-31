#!/usr/bin/env node
// A2: build and run the unchanged desktop GL oracle scenes with Mesa
// llvmpipe, in an offline Alpine aarch64 VM. No guest disk is modified.
// node tools/alpine_repo.mjs --arch aarch64 --set glref
// ALPINE_CACHE=<cached ISO directory> node tools/gl_mesa_reference.mjs
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire as create_require } from "node:module";
import { createHash as create_hash } from "node:crypto";
import { gzipSync as gzip_sync } from "node:zlib";
import { prepare, ROOT } from "../tests/lib/alpine_image.mjs";
import { GLREF_PACKAGES } from "./alpine_repo.mjs";
const require = create_require(import.meta.url), reference = ROOT + "tests/glbridge/gl_conformance/reference/",
    out = ROOT + "build/gl-reference/", work = out + "mesa-work/", repo = ROOT + "build/a64-linux/glref-repo.tar";
const native = process.argv.includes("--native");
if(!native && !fs.existsSync(repo)) throw new Error("Prepare the glref repository first (tools/alpine_repo.mjs --arch aarch64 --set glref)");
fs.mkdirSync(work + "reference", { recursive: true });
for(const file of fs.readdirSync(reference)) if(file.endsWith(".c")) fs.copyFileSync(reference + file, work + "reference/" + file);
fs.cpSync(reference + "mesa", work + "mesa", { recursive: true });
execFileSync(process.execPath, [reference + "gen_c.js", work + "reference"], { stdio: "inherit" });
// libGL exports only a subset of extension aliases. Load each original EXT/
// ARB name through EGL, as a desktop application's extension loader does.
const extensions = new Set();
for(const file of fs.readdirSync(work + "reference")) if(file.endsWith(".c"))
    for(const [, name] of fs.readFileSync(work + "reference/" + file, "utf8").matchAll(/\b(gl[A-Z][A-Za-z0-9_]+(?:ARB|EXT))\s*\(/g)) extensions.add(name);
fs.writeFileSync(work + "mesa/OpenGL/dispatch.h", [...extensions].sort().map(name =>
    `#define ${name} ((PFN${name.toUpperCase()}PROC)eglGetProcAddress("${name}"))`).join("\n") + "\n");
const jobs = [], sources = new Set();
const only = process.env.GLREF_ONLY?.split(",");
function job(source, name, args = []) {
    if(!/^[a-z0-9_/-]+$/.test(name)) throw new Error("Invalid oracle name");
    if(only && name !== "pixels" && !only.includes(name)) return;
    sources.add(source); jobs.push({ source, name, args });
}
for(const file of fs.readdirSync(reference)) if(file.endsWith(".c") && !["ref.c", "shader_units.c", "shader_mixed.c"].includes(file)) job(file.slice(0, -2), file.slice(0, -2));
job("ref", "pixels", ["hw", "/results/pixels.json"]);
for(const [i, entry] of require(ROOT + "tests/glbridge/gl_shader_units_cases.js").entries()) {
    const files = [...entry.vertex, ...entry.fragment].map((source, k) => { const name = `unit_${i}_${k}.glsl`;fs.writeFileSync(work + name, source);return "/work/" + name; });
    job("shader_units", "shader_units/" + entry.name, [String(entry.vertex.length), String(entry.fragment.length), ...files]);
}
for(const [i, entry] of require(ROOT + "tests/glbridge/gl_shader_mixed_cases.js").entries()) {
    const name = "mixed_" + i + ".glsl";fs.writeFileSync(work + name, entry.source);
    job("shader_mixed", "shader_mixed/" + entry.name, [String(i), entry.stage === "vertex" ? "35633" : "35632", "/work/" + name]);
}
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
if(!native) {
    const target = work + "native-repo/", files = ["tools/gl_mesa_reference.mjs", "tools/alpine_repo.mjs", "tests/lib/alpine_image.mjs",
        "tests/glbridge/gl_shader_units_cases.js", "tests/glbridge/gl_shader_mixed_cases.js", "tests/glbridge/gl_stream_builder.js",
        "tests/glbridge/gl_conformance/scenes.js", "src/browser/glbridge/gl-webgpu/gl_protocol.js", "src/browser/glbridge/gl-webgpu/gl_constants.js"];
    for(const file of files) { fs.mkdirSync(path.dirname(target + file), { recursive: true });fs.copyFileSync(ROOT + file, target + file); }
    fs.cpSync(reference, target + "tests/glbridge/gl_conformance/reference", { recursive: true });
}
const script = `#!/bin/sh
set -eu
disk() { for d in /sys/block/vd*; do [ "$(cat $d/serial 2>/dev/null)" = "$1" ] && { echo /dev/\${d##*/}; return; }; done; return 1; }
mkdir -p /repo /results/shader_units /results/shader_mixed /work/bin
tar -xf $(disk glrefrepo) -C /repo
apk add --no-network --quiet --repository /repo/main --repository /repo/community ${GLREF_PACKAGES.join(" ")}
export EGL_PLATFORM=surfaceless LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe MESA_GL_VERSION_OVERRIDE=2.1 MESA_GLSL_VERSION_OVERRIDE=120 GLREF_TRACE=${quote(process.env.GLREF_TRACE || "")}
cd /work
${[...sources].map(source => `cc -w -O1 -Imesa reference/${source}.c -lEGL -lGL -lm -o bin/${source}`).join("\n")}
${jobs.map(({ source, name, args }) => `echo GLREF_CASE=${name}\nif ./bin/${source} ${args.map(quote).join(" ")} > /results/${name === "pixels" ? "pixels.stdout" : name + ".json"}; then echo '${name} 0' >> /results/jobs.txt; else echo "${name} $?" >> /results/jobs.txt; fi`).join("\n")}
GLREF_ONLY='render_errors,shader_units/shared_globals_separate_macros,shader_mixed/vs_sampler_lod' node /work/native-repo/tools/gl_mesa_reference.mjs --native
tar -cf $(disk glrefout) -C /results .
`;
const results = out + (only ? "mesa-selected/" : "mesa/");fs.mkdirSync(results, { recursive: true });
if(native) {
    fs.mkdirSync(work + "bin", { recursive: true });
    for(const source of sources) execFileSync(process.env.CC_HOST || "cc", ["-w", "-O1", "-I" + work + "mesa", work + "reference/" + source + ".c", "-lEGL", "-lGL", "-lm", "-o", work + "bin/" + source], { stdio: "inherit" });
    const env = { ...process.env, EGL_PLATFORM: "surfaceless", LIBGL_ALWAYS_SOFTWARE: "1", GALLIUM_DRIVER: "llvmpipe", MESA_GL_VERSION_OVERRIDE: "2.1", MESA_GLSL_VERSION_OVERRIDE: "120" }, statuses = [];
    for(const { source, name, args } of jobs) {
        fs.mkdirSync(path.dirname(results + name), { recursive: true });
        const arguments_ = args.map(arg => arg.startsWith("/work/") ? work + arg.slice(6) : arg === "/results/pixels.json" ? results + "pixels.json" : arg);
        try {
            const stdout = execFileSync(work + "bin/" + source, arguments_, { env, encoding: "utf8", maxBuffer: 32 * 2 ** 20 });
            fs.writeFileSync(results + (name === "pixels" ? "pixels.stdout" : name + ".json"), stdout);statuses.push(name + " 0");
        } catch(error) {
            fs.writeFileSync(results + name + ".stdout", error.stdout || "");statuses.push(name + " " + (error.status || -1));
        }
    }
    fs.writeFileSync(results + "jobs.txt", statuses.join("\n") + "\n");
} else {
    fs.writeFileSync(work + "run.sh", script);fs.writeFileSync(out + "mesa-jobs.json", JSON.stringify(jobs, null, 2));
    execFileSync("bsdtar", ["--format", "ustar", "--no-xattrs", "--no-mac-metadata", "--uid", "0", "--gid", "0", "-cf", out + "mesa-work.tar", "-C", work, "."]);
    const output = out + "mesa-results.raw";fs.closeSync(fs.openSync(output, "w"));fs.truncateSync(output, 256 * 2 ** 20);
    const prepared = await prepare("aarch64-virt"), disk = (file, serial, readonly) => ["-drive", `file=${file},if=none,id=${serial},format=raw${readonly ? ",readonly=on" : ""}`,
        "-device", `virtio-blk-pci,drive=${serial}${serial === "iso" ? "" : ",serial=" + serial}`];
    const args = ["-machine", "virt,highmem=on", "-accel", "hvf", "-cpu", "host", "-smp", "4", "-m", "4096",
        "-kernel", prepared.directory + "boot/vmlinuz-virt", "-initrd", prepared.directory + "boot/initramfs-virt", "-append", "console=ttyAMA0 modules=loop,squashfs,sd-mod,usb-storage",
        ...disk(prepared.iso, "iso", true), ...disk(repo, "glrefrepo", true), ...disk(out + "mesa-work.tar", "glrefwork", true), ...disk(output, "glrefout", false),
        "-nic", "none", "-display", "none", "-serial", "stdio", "-monitor", "none", "-no-reboot"];
    const vm = spawn(process.env.QEMU_HVF || "/opt/homebrew/bin/qemu-system-aarch64", args, { stdio: ["pipe", "pipe", "pipe"] }), log = fs.openSync(out + "mesa-vm.log", "w");
    let transcript = "", exited = false;
    vm.stdout.on("data", bytes => { transcript += bytes.toString("latin1");fs.writeSync(log, bytes); });vm.stderr.on("data", bytes => fs.writeSync(log, bytes));
    const exit = new Promise(resolve => vm.once("exit", () => { exited = true;resolve(); }));
    function wait(pattern, timeout) {
        return new Promise((resolve, reject) => {
            const started = Date.now(), timer = setInterval(() => {
                const match = transcript.match(pattern);
                if(match) { clearInterval(timer);resolve(match); }
                else if(exited || Date.now() - started > timeout) { clearInterval(timer);reject(new Error("Mesa VM: " + (exited ? "exited" : "timeout") + " waiting for " + pattern + "; see build/gl-reference/mesa-vm.log")); }
            }, 100);
        });
    }
    try {
        await wait(/login: ?$/m, 180000);vm.stdin.write("root\n");await wait(/# ?(\x1b\[[0-9;]*[A-Za-z])*$/m, 60000);
        vm.stdin.write("W=; for d in /sys/block/vd*; do [ \"$(cat $d/serial 2>/dev/null)\" = glrefwork ] && W=/dev/${d##*/}; done; mkdir -p /work; tar -xf $W -C /work; sh /work/run.sh; echo GLREF_EXIT=$?\n");
        const [, status] = await wait(/GLREF_EXIT=(\d+)/, 600000);if(status !== "0") throw new Error("Mesa oracle failed: " + status + "; see build/gl-reference/mesa-vm.log");
        vm.stdin.write("poweroff\n");await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 10000))]);
    } finally { vm.kill("SIGKILL");fs.closeSync(log); }
    execFileSync("bsdtar", ["-xf", output, "-C", results]);
}
const failures = fs.readFileSync(results + "jobs.txt", "utf8").trim().split("\n").filter(line => !line.endsWith(" 0"));
if(failures.length) throw new Error("Mesa oracle jobs failed (results retained in build/gl-reference/mesa): " + failures.join(", "));
for(const { name } of jobs) JSON.parse(fs.readFileSync(results + name + ".json", "utf8"));
const pixels = JSON.parse(fs.readFileSync(results + "pixels.json", "utf8"));
if(!pixels.renderer.toLowerCase().includes("llvmpipe")) throw new Error("Expected llvmpipe, got " + pixels.renderer);
const invalid = pixels.scenes.filter(scene => scene.error && scene.name !== "accum");
if(invalid.length) throw new Error("Invalid native pixel scenes: " + invalid.map(scene => scene.name + ": " + scene.log).join("; "));
if(process.argv.includes("--update")) {
    if(only) throw new Error("--update requires the complete oracle run");
    const fixtures = Object.fromEntries(jobs.filter(job => job.name !== "pixels").map(({ name }) => [name, JSON.parse(fs.readFileSync(results + name + ".json", "utf8"))]));
    for(const scene of pixels.scenes) {
        scene.rgba = Buffer.from(scene.rgba, "hex").toString("base64");
        for(const extra of scene.extra) extra.bytes = Buffer.from(extra.bytes, "hex").toString("base64");
    }
    const hash = file => create_hash("sha256").update(fs.readFileSync(file)).digest("hex");
    const source_hashes = Object.fromEntries([...sources].sort().map(name => [name + ".c", hash(reference + name + ".c")]));
    for(const name of ["scenes.js", "gl_shader_units_cases.js", "gl_shader_mixed_cases.js"])
        source_hashes[name] = hash(ROOT + "tests/glbridge/" + (name === "scenes.js" ? "gl_conformance/" : "") + name);
    for(const name of fs.readdirSync(reference + "mesa/OpenGL")) source_hashes["mesa/OpenGL/" + name] = hash(reference + "mesa/OpenGL/" + name);
    const artifact = { version: 1, environment: { arch: process.arch === "arm64" ? "aarch64" : process.arch, renderer: pixels.renderer, version: pixels.version, packages: GLREF_PACKAGES, repository: native ? null : hash(repo) }, sourceHashes: source_hashes, pixels, fixtures };
    fs.writeFileSync(ROOT + "tests/glbridge/gl_conformance/mesa_reference.json.gz", gzip_sync(JSON.stringify(artifact), { level: 9 }));
}
console.log("Mesa oracle generated:", jobs.length, "jobs,", pixels.scenes.length, "pixel scenes;", pixels.renderer, pixels.version);
