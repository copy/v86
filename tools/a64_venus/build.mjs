#!/usr/bin/env node
// Mesa's venus Vulkan driver for Android (docs/arm64-virt-android16-plan.md
// P11.4): the prebuilt Cuttlefish image has no Mesa, so the guest's driver
// is built here with the Android NDK. Mesa 26.1.6 is the version
// src/graphics_adapters/virtio_gpu/venus_protocol.js was generated from, so
// the guest and v86 speak the same protocol. Only the venus driver is built
// (against Mesa's android stubs, API 34); libdrm is linked in statically; this
// directory's patch makes the driver open the render node by path where
// Android's SELinux policy hides /dev/dri from drmGetDevices2, and reads
// minigbm's buffer handles for AHardwareBuffers (venus-android.patch).
// Everything is linked for 16 KiB pages (-z max-page-size=16384, NDK r26b's
// default is 4 KiB): a 16K kernel's linker loads no library whose segments
// are aligned to less than its page size (P12.1), a 4K one takes both.
//
// Outputs in build/a64-android/venus/: vulkan.virtio.so (the HAL module,
// installed as a Vulkan driver), vkprobe (tests/a64/android/vkprobe.c: the
// devices the system's loader finds), vkahb (tests/a64/android/vkahb.c: a
// gralloc buffer drawn by Vulkan and read by the CPU) and manifest.json
// (versions, hashes).
//
// usage: node tools/a64_venus/build.mjs [--download] [--ndk <dir>]
//   The tarballs are build/a64-venus/dl-mesa/ and dl-libdrm/ (checked against
//   the SHA-256 below); with --download they are fetched from
//   archive.mesa3d.org and dri.freedesktop.org, and meson, mako and PyYAML
//   from PyPI into build/a64-venus/pyenv. The NDK is --ndk, $ANDROID_NDK_HOME
//   or r26b under ~/Library/Android/sdk/ndk.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash as create_hash } from "node:crypto";
import { execFileSync as exec_file_sync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORK = ROOT + "/build/a64-venus";
const OUT = ROOT + "/build/a64-android/venus";

const MESA = { version: "26.1.6", url: "https://archive.mesa3d.org/mesa-26.1.6.tar.xz",
    // (as Mesa's release notes for 26.1.6 give it)
    sha256: "5296b88a0f1e012e2cb9ada150a2bbadf728ca81e5a4fb2ab43c83a4d2158606" };
const LIBDRM = { version: "2.4.125", url: "https://dri.freedesktop.org/libdrm/libdrm-2.4.125.tar.xz",
    // (computed at the first download, 2026-10-18: the release page gives none)
    sha256: "d4bae92797a50f81a93524762e0410a49cd84cfa0f997795bc0172ac8fb1d96a" };
const PYTHON_PACKAGES = ["meson==1.12.1", "mako==1.4.3", "PyYAML==6.0.3", "packaging==26.3"];
const NDK_DEFAULT = os.homedir() + "/Library/Android/sdk/ndk/26.1.10909125";
const API = 34;

const args = process.argv.slice(2);
const download = args.includes("--download");
const ndk = args.includes("--ndk") ? args[args.indexOf("--ndk") + 1] : process.env.ANDROID_NDK_HOME || NDK_DEFAULT;
const bin = ndk + "/toolchains/llvm/prebuilt/darwin-x86_64/bin";

const run = (command, argv, options = {}) => exec_file_sync(command, argv, { stdio: "inherit", ...options });
const sha256 = file => create_hash("sha256").update(fs.readFileSync(file)).digest("hex");

function fail(message)
{
    console.error("a64_venus: " + message);
    process.exit(1);
}

/** a pinned tarball in its own directory, fetched only with --download */
function tarball(name, pin)
{
    const dir = `${WORK}/dl-${name}`;
    const file = `${dir}/${path.basename(pin.url)}`;
    if(!fs.existsSync(file))
    {
        if(!download) fail(`${file} is missing: download ${pin.url} (or pass --download)`);
        fs.mkdirSync(dir, { recursive: true });
        run("curl", ["-sSfL", "--max-time", "900", "-o", file, pin.url]);
    }
    const hash = sha256(file);
    if(hash !== pin.sha256) fail(`${file}: SHA-256 ${hash}, expected ${pin.sha256}`);
    return file;
}

if(!fs.existsSync(bin + `/aarch64-linux-android${API}-clang`)) fail(`no NDK with API ${API} at ${ndk} (--ndk or ANDROID_NDK_HOME)`);

// the build's Python: meson and Mesa's code generators
const python = WORK + "/pyenv/bin/python";
if(!fs.existsSync(WORK + "/pyenv/bin/meson"))
{
    if(!download) fail(`${WORK}/pyenv is missing (pass --download to make it with pip)`);
    run("python3", ["-m", "venv", WORK + "/pyenv"]);
    run(WORK + "/pyenv/bin/pip", ["install", "-q", ...PYTHON_PACKAGES]);
}
const env = { ...process.env, PATH: `${WORK}/pyenv/bin:${process.env.PATH}` };

// fresh sources: Mesa with libdrm as its subproject, and the patch
const mesa_tarball = tarball("mesa", MESA), libdrm_tarball = tarball("libdrm", LIBDRM);
const src = `${WORK}/src`;
fs.rmSync(src, { recursive: true, force: true });
fs.mkdirSync(src, { recursive: true });
run("tar", ["-xJf", mesa_tarball, "-C", src]);
run("tar", ["-xJf", libdrm_tarball, "-C", src]);
const mesa = `${src}/mesa-${MESA.version}`;
fs.renameSync(`${src}/libdrm-${LIBDRM.version}`, `${mesa}/subprojects/libdrm-${LIBDRM.version}`);
fs.writeFileSync(`${mesa}/subprojects/libdrm.wrap`, `[wrap-file]\ndirectory = libdrm-${LIBDRM.version}\n`);
const patch = path.dirname(fileURLToPath(import.meta.url)) + "/venus-android.patch";
run("patch", ["-p1", "-d", mesa, "-i", patch]);

// the NDK as meson's cross compiler
const cross = `${WORK}/android-aarch64.ini`;
fs.writeFileSync(cross, `[binaries]
c = ['${bin}/aarch64-linux-android${API}-clang']
cpp = ['${bin}/aarch64-linux-android${API}-clang++', '-fno-exceptions', '-fno-unwind-tables', '-fno-asynchronous-unwind-tables', '-static-libstdc++']
c_ld = 'lld'
cpp_ld = 'lld'
ar = '${bin}/llvm-ar'
strip = '${bin}/llvm-strip'
pkg-config = ['/usr/bin/false']

[built-in options]
c_link_args = ['-Wl,-z,max-page-size=16384']
cpp_link_args = ['-Wl,-z,max-page-size=16384']

[host_machine]
system = 'android'
cpu_family = 'aarch64'
cpu = 'armv8-a'
endian = 'little'
`);

const build = `${WORK}/build-android`;
fs.rmSync(build, { recursive: true, force: true });
run(WORK + "/pyenv/bin/meson", ["setup", build, mesa, "--cross-file", cross,
    "--wrap-mode=nodownload", "--force-fallback-for=libdrm", "-Dallow-fallback-for=libdrm",
    "-Dbuildtype=release", "-Dplatforms=android", `-Dplatform-sdk-version=${API}`, "-Dandroid-stub=true",
    "-Dandroid-libbacktrace=disabled", "-Dgallium-drivers=", "-Dvulkan-drivers=virtio", "-Dvulkan-layers=",
    "-Dllvm=disabled", "-Dopengl=false", "-Dgles1=disabled", "-Dgles2=disabled", "-Degl=disabled", "-Dgbm=disabled",
    "-Dglx=disabled", "-Dzstd=disabled", "-Dexpat=disabled", "-Dxmlconfig=disabled", "-Dvalgrind=disabled",
    "-Dlibunwind=disabled", "-Dlmsensors=disabled", "-Dbuild-tests=false", "-Dtools=", "-Dvideo-codecs=",
    "-Dspirv-tools=disabled", "-Dlibdrm:default_library=static",
    ...["intel", "radeon", "amdgpu", "nouveau", "vmwgfx", "man-pages", "cairo-tests", "valgrind"].map(o => `-Dlibdrm:${o}=disabled`),
    "-Dlibdrm:tests=false"], { env, stdio: ["ignore", "ignore", "inherit"] });
run("ninja", ["-C", build], { env, stdio: ["ignore", "ignore", "inherit"] });

// the outputs
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(`${build}/src/virtio/vulkan/libvulkan_virtio.so`, OUT + "/vulkan.virtio.so");
for(const [name, libraries] of [["vkprobe", ["-lvulkan"]], ["vkahb", ["-lvulkan", "-lnativewindow"]]])
{
    run(`${bin}/aarch64-linux-android${API}-clang`, ["-O2", "-Wall", "-Wl,-z,max-page-size=16384", `${ROOT}/tests/a64/android/${name}.c`, ...libraries,
        "-o", `${OUT}/${name}`]);
}
const needed = exec_file_sync(`${bin}/llvm-readelf`, ["-d", OUT + "/vulkan.virtio.so"], { encoding: "utf8" })
    .split("\n").map(line => /NEEDED.*\[(.+)\]/.exec(line)?.[1]).filter(Boolean);
if(needed.includes("libdrm.so")) fail("vulkan.virtio.so needs libdrm.so: libdrm was not linked in");
const manifest = {
    mesa: MESA, libdrm: LIBDRM, ndk: fs.readFileSync(ndk + "/source.properties", "utf8").match(/Pkg\.Revision = (\S+)/)?.[1],
    api: API, patch: { file: path.relative(ROOT, patch), sha256: sha256(patch) }, needed,
    outputs: Object.fromEntries(["vulkan.virtio.so", "vkprobe", "vkahb"].map(name => [name, sha256(`${OUT}/${name}`)])),
};
fs.writeFileSync(OUT + "/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log(`a64_venus: ${OUT}/vulkan.virtio.so, vkprobe, vkahb (${needed.join(", ")})`);
