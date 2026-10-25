#!/usr/bin/env node
// Android 16 boot materials for the virt machine
// (docs/arm64-virt-android16-plan.md P10.1, P10.5): the pinned Cuttlefish
// arm64-only phone build (aosp_cf_arm64_only_phone-userdebug 15581820 from
// ci.android.com's aosp-android-latest-release branch: BP4A.251205.006,
// the build of the android-16.0.0_r4 tag, source android16-qpr2-release)
// made into what a direct kernel boot needs, as Cuttlefish's bootloader and
// launcher would:
// - Image: the GKI kernel from boot.img (header version 4, raw Image);
// - initrd.img: the vendor ramdisk, then the generic ramdisk of init_boot.img
//   (both lz4 legacy, which the kernel takes concatenated), then bootconfig
//   (the vendor_boot's own section and ours, with its length, checksum and
//   trailer). The vendor ramdisk is the build's debug one by default
//   (vendor_ramdisk-debug.img: /force_debuggable, adb_debug.prop with
//   ro.adb.secure=0, which init only honours on an unlocked device) so that
//   adbd takes a connection without a key; --release takes vendor_boot.img's;
//   SELinux enforcing (P11.3; --selinux permissive for debugging);
// - disk.img: one GPT disk with Cuttlefish's partitions (misc, boot, init_boot,
//   vendor_boot and the four vbmeta in slots a and b, super, userdata,
//   metadata, frp), the sparse super and userdata made raw, a sparse file;
// - with the Venus driver (P11.4 V3; build/a64-android/venus/vulkan.virtio.so,
//   from `make android-venus`): the driver in odm, /odm/lib64, and
//   initrd-venus.img, initrd.img with androidboot.hardware.vulkan=virtio and
//   androidboot.hardware.hwcomposer.mode=client (as Cuttlefish's drm_virgl:
//   SurfaceFlinger composes on the GPU, the ranchu HWC only scans out; it
//   takes a Vulkan other than "pastel" for gfxstream's host composition),
//   and androidboot.opengles.version=196608: ANGLE on Venus gives OpenGL ES
//   3.0 (the plan's appendix F2 and docs/gpu-deviations.md's G-45 to G-57:
//   transform feedback, uniform buffers past WebGPU's 12, GL's provoking
//   vertex, std140, swizzles and the rest), not SwiftShader's 3.1.
//   libvulkan tries the Vulkan APEX's namespace first (ro.vulkan.apex, set by
//   the APEX), which has SwiftShader's vulkan.pastel.so but no vulkan.virtio.so,
//   then its built-in path, the sphal namespace, whose search path starts
//   with /odm/lib64 (not .../hw); initrd.img keeps SwiftShader. odm's erofs
//   gets the file in blocks after its own (erofs_add_file), labelled
//   same_process_hal_file; its hash tree is made again and vbmeta's odm
//   descriptor gets the new size and root digest, without FEC (vbmeta's
//   signature no longer matches: the device is unlocked, and first stage
//   init checks the digest passed in bootconfig); odm_a moves to free space
//   in super, every metadata copy rewritten;
// - with --page-size 16k (P12.1; build/a64-android/out-16k/): the GKI kernel
//   of a 16K kernel build (KERNEL_16K) and its modules where the 4K ones
//   are, the same userspace (page-size agnostic: P10.4 found 4 KiB-aligned
//   ELFs only in the VNDK APEXes): the vendor ramdisk's in a ramdisk after
//   it (literal-only LZ4, the same names: the kernel's unpacking overwrites
//   them), system_dlkm's (the 16K build's system_dlkm image's, signed for
//   it) and vendor_dlkm's in their erofs images (erofs_replace_files), with
//   modules.dep and modules.alias made again as the 4K ones are; those
//   partitions moved in super with their hash trees and vbmeta descriptors
//   (as odm's); userdata blank and fstab.cf.ext4.hctr2 (f2fs's block is the
//   page: the image's 4 KiB-block f2fs does not mount on a 16K kernel, so
//   first boot makes ext4 there);
// - with --gsi <zip> (docs/android-images-plan.md I0.2, I5): a Generic
//   System Image's system.img (from ci.android.com's or the GSI release
//   page's aosp_arm64 zip, raw ext4) as system_a, in free space in super,
//   every metadata copy's extent changed; its vbmeta.img (verification
//   disabled) the top-level vbmeta, so the bootconfig's digest is that
//   struct's alone and nothing is verified (the device is unlocked, as
//   flashing a GSI needs); no Venus (--no-venus is implied), and
//   build/a64-android/out-gsi/ by default;
// - manifest.json: the artifacts' and results' hashes, the partitions, the
//   kernel command line and bootconfig (bootconfig.txt, cmdline.txt too);
// - modules/: the vendor ramdisk's virtual-device modules (virtio_pci,
//   virtio_blk, ...) with modules.load and modules.options, for P10.6's
//   bridge (tests/a64/linux_boot.mjs A64_KERNEL=gki).
// The device is unlocked (androidboot.verifiedbootstate=orange,
// vbmeta.device_state=unlocked), the vbmeta digest is computed as a
// bootloader does (the vbmeta structs of vbmeta and its chained partitions,
// in the order libavb loads them). The host services Cuttlefish provides
// through virtio-console ports are replaced by the guest's own: KeyMint and
// Gatekeeper from the vendor's nonsecure APEXes, chosen by bootconfig.
//
// The kernel's console is hvc0 (the first virtio-console port, as
// Cuttlefish's) after earlycon on the PL011; Android's console, a shell, is
// on the PL011 (androidboot.console=ttyAMA0).
//
// The image formats, the device model (partitions, bootconfig, GPU modes)
// and the bootloader's work are src/android/'s (docs/android-images-plan.md
// I1), which v64's own bootloader and importer use too; this tool keeps the
// files, the downloads and the 16K modules.
//
//   node tools/a64_android.mjs [--download] [--release] [--no-venus] [--gsi <zip>] [--shrink-super] [--userdata-mb <n>] [--selinux enforcing|permissive]
//       [--memory-mb 1536] [--out build/a64-android/out] [--extract] [--fresh-disk] [--page-size 4k|16k] [--build a16|a14] [--zygote64-32]
//   (--build a14: Android 14's Cuttlefish phone with 32-bit apps, BUILDS
//   below, into build/a64-android/out-a14/: its own system, SwiftShader;
//   it does not boot here: its KeyMint and Gatekeeper are Cuttlefish's
//   remote ones, whose trusted side is the host's secure_env.
//   --zygote64-32, with --gsi: the GSI's 32-bit half run, see above)
//   (--release --no-venus: Cuttlefish's images as they are, I0.2's official
//   reference: vendor_boot's own ramdisk, SwiftShader, super unchanged;
//   --shrink-super: super to its partitions and 64 MiB; --userdata-mb <n>:
//   userdata blank, n MiB, formatted at first boot: docs/android-images-plan.md
//   I4.3's disk)
//   (--download: fetch the missing artifacts into build/a64-android/dl/ first;
//   --extract: then boot them on QEMU with HVF, the host's CPU, and write the
//   mounted read-only partitions and active APEXes as build/a64-android/rootfs.tar
//   for tools/a64_isa_scan.mjs --android, P10.4)
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash as create_hash } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import net from "node:net";
import { android_qemu_args, AndroidConsole } from "../tests/a64/android_qemu.mjs";
import { qemu_binary } from "../tests/a64/guest_runner.mjs";
import { u16, u32, latin1, bytes_of, equals, index_of } from "../src/android/bytes.js";
import { parse_boot_image, parse_vendor_boot_image } from "../src/android/bootimg.js";
import { lz4_legacy_decompress, lz4_legacy_store } from "../src/android/lz4.js";
import { cpio_files, cpio_newc } from "../src/android/cpio.js";
import { unsparse, sparse_read, sparse_size } from "../src/android/sparse.js";
import { lp_metadata, lp_end, lp_place, lp_resize, super_replace, super_footer_struct, super_partition } from "../src/android/lp.js";
import { vbmeta_struct, AVB_FLAG_VERIFICATION_DISABLED } from "../src/android/avb.js";
import { zip_entries, zip_stream, zip_read } from "../src/android/zip.js";
import { erofs_data, erofs_list, erofs_lookup, erofs_add_file, erofs_replace_files } from "../src/android/erofs.js";
import { SECTOR, gpt_layout, gpt_writes } from "../src/android/gpt.js";
import { CF_ARM64_ONLY_PHONE, CF_ARM64_PHONE_A14, device_partitions } from "../src/android/devices.js";
import { android_boot } from "../src/android/boot.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") + "/";
/** the Cuttlefish builds (--build): Android 16's arm64-only phone (the
 * default, the plan's), and Android 14's phone with a 32-bit second
 * architecture (aosp_cf_arm64_phone-userdebug from the aosp-android14-gsi
 * branch: zygote64_32, armeabi-v7a in ro.product.cpu.abilist; for 32-bit
 * apps on arm64, docs/aarch32-plan.md Q5.2); each with its artifacts (sizes
 * and sha256, the server's MD5 checked at download time) and directories */
const BUILDS = {
    a16: {
        id: "15581820", target: "aosp_cf_arm64_only_phone-userdebug", product: "aosp_cf_arm64_only_phone",
        branch: "aosp-android-latest-release", source: "android16-qpr2-release",
        fingerprint: "generic/aosp_cf_arm64_only_phone/vsoc_arm64_only:16/BP4A.251205.006/15581820:userdebug/test-keys",
        artifacts: {
            "aosp_cf_arm64_only_phone-img-15581820.zip": { size: 1046288463, sha256: "d56b75f00cd4a0005d54175fdf9bafb48c4b4f8c1a20ee4ac062b019080ef506" },
            "vendor_ramdisk-debug.img": { size: 18797343, sha256: "b9a00cd701d93acdb7fe3787d6674741e5373e0137777e0b3b68e5812ba65665" },
            "manifest_15581820.xml": { size: 156408, sha256: "d36c615a2210772946ba6d8a18165ac79faaa16c2ae17685adb47e4ec460cc1b" },
        },
        dl: "dl/", img: "img/", out: "out", device: CF_ARM64_ONLY_PHONE,
    },
    a14: {
        id: "16571446", target: "aosp_cf_arm64_phone-userdebug", product: "aosp_cf_arm64_phone",
        branch: "aosp-android14-gsi", source: "android14-gsi",
        fingerprint: "generic/aosp_cf_arm64_phone/vsoc_arm64:14/UP1A.231105.001/16571446:userdebug/test-keys",
        artifacts: {
            "aosp_cf_arm64_phone-img-16571446.zip": { size: 1010205638, sha256: "dbf9771d92cc3af9499d37fcfd4cb824926d82060298af21d2c7876f1446b7d5" },
            "vendor_ramdisk-debug.img": { size: 16047885, sha256: "746a9d292368ee1bc4d0874d5ebc72b16abdc98bc08d5b3a5dd1c76339ecd482" },
            "manifest_16571446.xml": { size: 179926, sha256: "71ae846868ed4df6309e11d0575559ea49d4c8fcb8f7d2a5eca25253f5837950" },
        },
        dl: "dl-a14/", img: "img-a14/", out: "out-a14", device: CF_ARM64_PHONE_A14,
    },
};
/** (--zygote64-32) vendor's and odm's build.prop as artifacts of the build */
const BUILD_PROPS = {
    "build.prop-vendor": { size: 5258, sha256: "a56578e5b38216a5899937b057041789d54588099a21e44c3c3979898f1fba2f" },
    "build.prop-odm": { size: 1066, sha256: "946796d2bebdf29b145c465c263bf15e78084e304cae5e3d69377511c8de7570" },
};
/** the build of this run (main's --build) */
let B = BUILDS.a16;
const artifact_url = b => `https://ci.android.com/builds/submitted/${b.id}/${b.target}/latest/raw/`;
export const ARTIFACTS = BUILDS.a16.artifacts;
export const FINGERPRINT = BUILDS.a16.fingerprint;
const DL = ROOT + "build/a64-android/dl/";
const dl = () => ROOT + "build/a64-android/" + B.dl;
const img = () => ROOT + "build/a64-android/" + B.img;
/** --page-size 16k (P12.1): the GKI kernel and the virtual device's modules
 * of a 16K kernel build (ci.android.com's aosp_kernel-common-android16-6.12,
 * the newest build of kernel_virt_aarch64_16k on 2026-10-19) */
const KERNEL_16K = { build: "16637892", target: "kernel_virt_aarch64_16k", branch: "aosp_kernel-common-android16-6.12",
    release: "6.12.93-android16-6-g49f96790cc76-ab16637892" };
const KERNEL_16K_URL = `https://ci.android.com/builds/submitted/${KERNEL_16K.build}/${KERNEL_16K.target}/latest/raw/`;
export const ARTIFACTS_16K = {
    "Image": { size: 42699264, sha256: "123c0605a610df1d512675a5532e77d6f3a2797a95b2e535f86584d7fb787269" },
    "initramfs.img": { size: 10649329, sha256: "c9afd452c7414de93a603f0838d5c3bd0da8912f3f6086880a75a7e61bec2c02" },
    "system_dlkm.erofs.img": { size: 16314368, sha256: "915bf4a4d80ed7912c2b46b38f2dac35e19fd019d05f6c65be625496f855d2d0" },
};
const DL_16K = DL + `16k-${KERNEL_16K.build}/`;

/** the guest's Venus driver (tools/a64_venus/build.mjs) */
const VENUS_DRIVER = ROOT + "build/a64-android/venus/vulkan.virtio.so";

function parse_args(argv)
{
    const args = { download: false, release: false, selinux: "enforcing", memory_mb: 1536, extract: false, fresh_disk: false,
        out: null, page_size: 4096, venus: true, gsi: null, shrink_super: false, userdata_mb: 0, build: "a16", zygote64_32: false };
    for(let i = 0; i < argv.length; i++)
    {
        const arg = argv[i];
        if(arg === "--download") args.download = true;
        else if(arg === "--release") args.release = true;
        else if(arg === "--no-venus") args.venus = false;
        else if(arg === "--gsi") { args.gsi = path.resolve(argv[++i]); args.venus = false; }
        else if(arg === "--shrink-super") args.shrink_super = true;
        else if(arg === "--userdata-mb") args.userdata_mb = +argv[++i];
        else if(arg === "--selinux") args.selinux = argv[++i];
        else if(arg === "--memory-mb") args.memory_mb = +argv[++i];
        else if(arg === "--extract") args.extract = true;
        else if(arg === "--fresh-disk") args.fresh_disk = true;
        else if(arg === "--out") args.out = path.resolve(argv[++i]) + "/";
        else if(arg === "--page-size") args.page_size = { "4k": 4096, "16k": 16384 }[argv[++i]];
        else if(arg === "--build") args.build = argv[++i];
        else if(arg === "--zygote64-32") args.zygote64_32 = true;
        else throw new Error("unknown argument " + arg);
    }
    if(!["enforcing", "permissive"].includes(args.selinux)) throw new Error("--selinux enforcing|permissive");
    if(!args.page_size) throw new Error("--page-size 4k|16k");
    if(args.extract && args.page_size !== 4096) throw new Error("--extract: 4k only");
    if(args.gsi && args.page_size !== 4096) throw new Error("--gsi: 4k only");
    if(!BUILDS[args.build]) throw new Error("--build " + Object.keys(BUILDS).join("|"));
    if(args.zygote64_32 && (!args.gsi || args.build !== "a16")) throw new Error("--zygote64-32: with --gsi, on --build a16");
    // (Android 14's build: its own system, SwiftShader, 4 KiB pages)
    if(args.build !== "a16" && (args.gsi || args.page_size !== 4096)) throw new Error(`--build ${args.build}: no --gsi, no --page-size 16k`);
    if(args.build !== "a16") args.venus = false;
    args.out ||= ROOT + (args.gsi ? "build/a64-android/out-gsi/" : args.page_size === 4096 ? `build/a64-android/${BUILDS[args.build].out}/` : "build/a64-android/out-16k/");
    return args;
}

function sha256_file(file)
{
    const hash = create_hash("sha256");
    const fd = fs.openSync(file, "r");
    const chunk = Buffer.alloc(16 << 20);
    for(let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0;) hash.update(chunk.subarray(0, n));
    fs.closeSync(fd);
    return hash.digest("hex");
}

async function download(url, dir, name)
{
    const response = await fetch(url + name, { redirect: "follow" });
    if(!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const expected_md5 = (response.headers.get("x-goog-hash") || "").split(/,\s*/).find(h => h.startsWith("md5="));
    const temporary = dir + name + ".part";
    const fd = fs.openSync(temporary, "w");
    const md5 = create_hash("md5");
    for await (const chunk of response.body)
    {
        md5.update(chunk);
        fs.writeSync(fd, chunk);
    }
    fs.closeSync(fd);
    if(expected_md5 && expected_md5.slice(4) !== md5.digest("base64")) throw new Error(name + ": MD5 differs from the server's");
    fs.renameSync(temporary, dir + name);
}

async function fetch_artifacts(allow_download, artifacts = B.artifacts, url = artifact_url(B), dir = dl())
{
    fs.mkdirSync(dir, { recursive: true });
    const hashes = {};
    for(const [name, { size, sha256 }] of Object.entries(artifacts))
    {
        const file = dir + name;
        if(!fs.existsSync(file))
        {
            if(!allow_download) throw new Error(`${file} is missing (${size} bytes from ${url}): run with --download`);
            console.log(`downloading ${name} (${size} bytes) from ci.android.com`);
            await download(url, dir, name);
        }
        if(fs.statSync(file).size !== size) throw new Error(`${file}: ${fs.statSync(file).size} bytes, expected ${size}`);
        hashes[name] = sha256_file(file);
        if(sha256 && hashes[name] !== sha256) throw new Error(`${file}: sha256 ${hashes[name]}, expected ${sha256}`);
    }
    return hashes;
}

/** the image zip's files, unpacked once into build/a64-android/img/ */
function unpack_images()
{
    const zip = dl() + `${B.product}-img-${B.id}.zip`, IMG = img();
    const stamp = IMG + ".unpacked";
    if(fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === String(fs.statSync(zip).mtimeMs)) return;
    fs.rmSync(IMG, { recursive: true, force: true });
    fs.mkdirSync(IMG, { recursive: true });
    const result = spawnSync("unzip", ["-o", "-q", zip, "-d", IMG], { stdio: "inherit" });
    if(result.status !== 0) throw new Error("unzip failed");
    fs.writeFileSync(stamp, String(fs.statSync(zip).mtimeMs));
}

// the image library (src/android/, docs/android-images-plan.md I1) over
// files: reads through a descriptor kept open
const readers = new Map();
function file_reader(file)
{
    if(!readers.has(file))
    {
        const fd = fs.openSync(file, "r");
        readers.set(file, (offset, length) =>
        {
            const out = Buffer.allocUnsafe(length);
            return out.subarray(0, fs.readSync(fd, out, 0, length, offset));
        });
    }
    return readers.get(file);
}

/** Android sparse image -> raw, written into fd at offset; returns the raw
 * size. Writes from limit on (a partition smaller than the image: super
 * shrunk) are left out, and must be zeros; so are those in skip's ranges
 * [from, to) (a replaced partition's old data) */
function unsparse_into(file, fd, offset, limit = Infinity, skip = [])
{
    return unsparse(file_reader(file), (at, bytes) =>
    {
        let pieces = [[at, bytes]];
        for(const [from, to] of skip)
        {
            pieces = pieces.flatMap(([a, b]) => a >= to || a + b.length <= from ? [[a, b]] :
                [[a, b.subarray(0, Math.max(0, from - a))], [to, b.subarray(Math.min(b.length, to - a))]].filter(([, x]) => x.length));
        }
        for(const [a, b] of pieces)
        {
            const n = Math.max(0, Math.min(b.length, limit - a));
            if(n) fs.writeSync(fd, b, 0, n, offset + a);
            if(n < b.length && b.subarray(n).some(x => x)) throw new Error(`${file}: data at ${a + n}, past its partition's ${limit} bytes`);
        }
    });
}

/** the Venus driver on odm (docs/arm64-virt-android16-plan.md P11.4 V3; see
 * the top): odm's image with the driver, read back */
function odm_with_driver(odm, driver)
{
    const labels = { dir: "u:object_r:vendor_file:s0", file: "u:object_r:same_process_hal_file:s0" };
    const image = erofs_add_file(odm, "lib64/vulkan.virtio.so", driver, labels);
    // (read back)
    const added = erofs_lookup(image, "lib64/vulkan.virtio.so");
    if(!added || !equals(erofs_data(image, added), driver) ||
        index_of(image.subarray(added.xattrs, added.xattrs + added.xattr_size), bytes_of("selinux" + labels.file)) < 0 ||
        !erofs_lookup(image, "etc/build.prop")) throw new Error("erofs: odm with the driver does not read back");
    return image;
}

// 16 KiB pages (P12.1; see the top)

/** modules.dep's lines: Map path -> dependency paths */
function parse_modules_dep(text)
{
    return new Map(text.split("\n").filter(Boolean).map(line =>
    {
        const [module, deps] = line.split(":");
        return [module.trim(), deps.trim().split(/\s+/).filter(Boolean)];
    }));
}

const module_name = file => file.replace(/^.*\//, "");

/** the 16K kernel build's modules: name -> { data, deps (names) }, and the
 * modules.alias lines. The virtual device's from initramfs.img, the GKI
 * ones from system_dlkm.erofs.img (signed again for it, as the 4K
 * system_dlkm's) */
function kernel_16k_modules()
{
    const modules = new Map(), aliases = [];
    const add = (files, version_dir) =>
    {
        const dep = parse_modules_dep(latin1(files.get(version_dir + "modules.dep")));
        for(const [file, deps] of dep)
        {
            const data = files.get(version_dir + file);
            if(!data) throw new Error(`16K: ${file} of modules.dep is missing`);
            modules.set(module_name(file), { data, deps: deps.map(module_name) });
        }
        aliases.push(...latin1(files.get(version_dir + "modules.alias")).split("\n").filter(line => line.startsWith("alias ")));
    };
    const version_dir = `lib/modules/${KERNEL_16K.release}/`;
    add(cpio_files(lz4_legacy_decompress(fs.readFileSync(DL_16K + "initramfs.img"))), version_dir);
    const system_dlkm = fs.readFileSync(DL_16K + "system_dlkm.erofs.img");
    add(new Map(erofs_list(system_dlkm).filter(e => e.type === 1).map(e => [e.path, erofs_data(system_dlkm, e.inode)])), version_dir);
    return { modules, aliases };
}

/** a 4K modules directory's files (names) for the 16K kernel: each .ko
 * the 16K build's; modules.dep the 16K dependencies of the modules in lines
 * (name -> path on the device: the directory's and those of the directories
 * its modules may depend on, as the 4K files list them; a dependency first
 * stage init has loaded, the ramdisk's, left out as the 4K files do),
 * modules.alias their 16K aliases (both made again: the dlkm images keep
 * them compressed); the rest (modules.load, .blocklist, .options, .softdep)
 * as they were. A module the 16K build does not have stays as it was, out of
 * modules.dep (missing) */
function modules_for_16k(names, lines, loaded, k16, missing)
{
    const out = new Map();
    for(const name of names)
    {
        if(!name.endsWith(".ko")) continue;
        if(k16.modules.has(name)) out.set(name, k16.modules.get(name).data);
        else missing.add(lines.get(name));
    }
    const present = [...lines].filter(([name]) => k16.modules.has(name));
    if(names.includes("modules.dep"))
    {
        out.set("modules.dep", Buffer.from(present.map(([name, file]) => `${file}: ${k16.modules.get(name).deps.filter(d =>
        {
            if(!lines.has(d) && !loaded.has(d)) throw new Error(`16K: ${name} needs ${d}, which is not where it may load from`);
            return lines.has(d);
        }).map(d => lines.get(d)).join(" ")}`.trimEnd() + "\n").join("")));
    }
    if(names.includes("modules.alias"))
    {
        const named = new Set(present.map(([name]) => name.replace(/\.ko$/, "").replace(/-/g, "_")));
        out.set("modules.alias", Buffer.from("# Aliases extracted from modules themselves.\n" +
            k16.aliases.filter(line => named.has(line.split(" ")[2])).map(line => line + "\n").join("")));
    }
    return out;
}


async function main()
{
    const args = parse_args(process.argv.slice(2));
    B = BUILDS[args.build];
    const IMG = img(), DEVICE = B.device;
    const hashes = await fetch_artifacts(args.download);
    const hashes_16k = args.page_size === 16384 ? await fetch_artifacts(args.download, ARTIFACTS_16K, KERNEL_16K_URL, DL_16K) : null;
    unpack_images();
    fs.mkdirSync(args.out, { recursive: true });

    const files = new Map();
    const read = name => files.get(name) || files.set(name, fs.readFileSync(IMG + name)).get(name);
    const boot = parse_boot_image(read("boot.img"));
    const vendor_boot = parse_vendor_boot_image(read("vendor_boot.img"));
    const kernel = hashes_16k ? fs.readFileSync(DL_16K + "Image") : boot.kernel;
    if(latin1(kernel, 56, 60) !== "ARMd") throw new Error("the kernel is not a raw arm64 Image");
    if(hashes_16k && !kernel.includes(KERNEL_16K.release)) throw new Error("the 16K Image is not " + KERNEL_16K.release);
    fs.writeFileSync(args.out + "Image", kernel);

    const partition_file = {
        vbmeta: "vbmeta.img", vbmeta_system: "vbmeta_system.img", vbmeta_vendor_dlkm: "vbmeta_vendor_dlkm.img",
        vbmeta_system_dlkm: "vbmeta_system_dlkm.img", boot: "boot.img", init_boot: "init_boot.img", vendor_boot: "vendor_boot.img",
    };
    // super's partitions made again: odm with the Venus driver (see the top),
    // when tools/a64_venus/build.mjs has made it, and with 16 KiB pages
    // system_dlkm and vendor_dlkm with the 16K modules; each to free space
    // after super's partitions, its vbmeta image's descriptor changed
    const super_read = (offset, length) => sparse_read(file_reader(IMG + "super.img"), offset, length);
    const lp = lp_metadata(super_read);
    const space = { sector: lp_end(lp) };
    const vbmeta_images = new Map(), super_patches = [];
    const vbmeta_of = name => vbmeta_images.get(name) || read(partition_file[name]);
    const replace = (name, vbmeta_name, image, footer = null) =>
    {
        const result = super_replace(lp, vbmeta_of(vbmeta_name), name, image, space, footer);
        vbmeta_images.set(vbmeta_name, result.vbmeta);
        super_patches.push(result.data);
        return result.record;
    };
    const driver = args.venus && fs.existsSync(VENUS_DRIVER) ? fs.readFileSync(VENUS_DRIVER) : null;
    const venus = driver && { record: replace("odm", "vbmeta", odm_with_driver(super_partition(super_read, lp, vbmeta_of("vbmeta"), "odm"), driver)) };
    // (--zygote64-32, with --gsi: a 32-bit second architecture for 32-bit
    // apps, docs/aarch32-plan.md Q5.2: vendor's build.prop with ro.zygote
    // zygote64_32, vendor's and odm's with the 32-bit ABIs, from which init
    // makes ro.product.cpu.abilist32 (the first of product, odm, vendor,
    // system that has a list: odm's); the GSI brings app_process32, the
    // 32-bit libraries and init.zygote64_32.rc. With the GSI's vbmeta
    // nothing is verified: the new images are only placed in free space.
    // The images' build.prop files are LZ4-compressed, which
    // src/android/erofs.js does not read: the build's own build.prop
    // artifacts, of their sizes)
    let zygote64_32 = null;
    if(args.zygote64_32)
    {
        await fetch_artifacts(args.download, BUILD_PROPS);
        zygote64_32 = {};
        for(const [name, file] of [["vendor", "build.prop"], ["odm", "etc/build.prop"]])
        {
            const image = super_partition(super_read, lp, vbmeta_of("vbmeta"), name);
            const prop = latin1(fs.readFileSync(dl() + "build.prop-" + name));
            const inode = erofs_lookup(image, file);
            if(!inode || inode.size !== prop.length) throw new Error(`build.prop-${name} is not ${name}'s /${file}`);
            let patched = prop.replace(new RegExp(`^ro\\.${name}\\.product\\.cpu\\.abilist=.*$`, "m"), `ro.${name}.product.cpu.abilist=arm64-v8a,armeabi-v7a,armeabi`)
                .replace(new RegExp(`^ro\\.${name}\\.product\\.cpu\\.abilist32=.*$`, "m"), `ro.${name}.product.cpu.abilist32=armeabi-v7a,armeabi`);
            if(name === "vendor") patched = patched.replace(/^ro\.zygote=.*$/m, "ro.zygote=zygote64_32");
            if(!patched.includes(`ro.${name}.product.cpu.abilist32=armeabi-v7a`) || name === "vendor" && !/^ro\.zygote=zygote64_32$/m.test(patched))
            {
                throw new Error(`${name}'s build.prop: no ro.${name}.product.cpu.abilist32${name === "vendor" ? " or ro.zygote" : ""} to change`);
            }
            const files = [[file, bytes_of(patched)]];
            // (vendor's boringssl self test for zygote64_32 runs a 32-bit
            // binary this arm64-only vendor does not have, and reboots when
            // it fails: its 64-bit file instead; the system's own 32-bit
            // self test runs)
            const SELF_TEST = "etc/boringssl_self_test.zygote64";
            if(name === "vendor" && erofs_lookup(image, SELF_TEST + "_32.rc"))
            {
                if(!erofs_lookup(image, SELF_TEST + ".rc")) throw new Error(`vendor: no /${SELF_TEST}.rc`);
                files.push([SELF_TEST + "_32.rc", bytes_of(`import /vendor/${SELF_TEST}.rc\n`)]);
            }
            const changed = erofs_replace_files(image, files);
            for(const [path, data] of files)
            {
                if(latin1(erofs_data(changed, erofs_lookup(changed, path))) !== latin1(data)) throw new Error(`erofs: ${name}'s /${path} does not read back`);
            }
            const result = super_replace(lp, vbmeta_of("vbmeta"), name, changed, space);
            super_patches.push(result.data);
            zygote64_32[name] = { record: result.record, build_prop_sha256: create_hash("sha256").update(patched).digest("hex") };
        }
    }
    // the GSI (see the top): system_a in free space, streamed from the zip
    // as the disk is written; the GSI's vbmeta the top-level one
    let gsi = null, super_skip = [];
    if(args.gsi)
    {
        const zip_read_at = file_reader(args.gsi);
        const entries = await zip_entries(zip_read_at, fs.statSync(args.gsi).size);
        const member = name => entries.find(e => e.name === name) || (() => { throw new Error(`${args.gsi}: no ${name}`); })();
        const system = member("system.img"), gsi_vbmeta = await zip_read(zip_read_at, member("vbmeta.img"));
        if(!(vbmeta_struct(gsi_vbmeta).flags & AVB_FLAG_VERIFICATION_DISABLED)) throw new Error("the GSI's vbmeta.img does not disable verification");
        // (ext4's magic at 1024 + 56, erofs's at 1024)
        const head = await zip_read(zip_read_at, system, 1082);
        if(u16(head, 1080) !== 0xEF53 && u32(head, 1024) !== 0xE0F5E1E2) throw new Error("the GSI's system.img is neither ext4 nor erofs (sparse?)");
        if(system.size % SECTOR) throw new Error("the GSI's system.img is not whole sectors");
        const align = lp.alignment / SECTOR, sector = Math.ceil(space.sector / align) * align;
        // (the old system_a's data not written, as the importer does: src/android/assemble.js)
        super_skip = lp.copies[0].partitions.find(p => p.name === "system_a").extents.map(e => [e.sector * SECTOR, (e.sector + e.sectors) * SECTOR]);
        super_patches.push(...lp_place(lp, "system_a", sector, system.size / SECTOR), { offset: sector * SECTOR, zip: { read: zip_read_at, entry: system } });
        space.sector = sector + Math.ceil(system.size / lp.alignment) * align;
        vbmeta_images.set("vbmeta", gsi_vbmeta);
        const build_prop = entries.find(e => e.name === "build.prop");
        gsi = { zip: path.basename(args.gsi), sha256: sha256_file(args.gsi), system: { size: system.size, crc32: system.crc32, sector },
            vbmeta_sha256: create_hash("sha256").update(gsi_vbmeta).digest("hex"),
            fingerprint: build_prop ? (/^ro\.(?:system\.)?build\.fingerprint=(.*)$/m.exec(latin1(await zip_read(zip_read_at, build_prop))) || [])[1] || null : null };
    }

    const vendor_ramdisk = args.release ? vendor_boot.ramdisk : fs.readFileSync(dl() + "vendor_ramdisk-debug.img");
    const lib_modules = ramdisk => new Map([...cpio_files(lz4_legacy_decompress(ramdisk))].flatMap(([name, data]) =>
    {
        const m = /^lib\/modules\/([^/]+)$/.exec(name);
        return m ? [[m[1], data]] : [];
    }));
    // the 16K modules (see the top): the vendor ramdisk's in a ramdisk after
    // it (the same files, which the kernel's unpacking overwrites),
    // system_dlkm's and vendor_dlkm's in their images
    let ramdisk_16k = Buffer.alloc(0), modules_16k = null;
    if(hashes_16k)
    {
        const k16 = kernel_16k_modules();
        const images = Object.fromEntries(["system_dlkm", "vendor_dlkm"].map(name => [name, super_partition(super_read, lp, vbmeta_of("vbmeta_" + name), name)]));
        const listing = image => erofs_list(image).filter(e => e.type === 1 && /^lib\/modules\/[^/]+$/.test(e.path)).map(e => module_name(e.path));
        const names = { ramdisk: [...lib_modules(vendor_ramdisk).keys()], system_dlkm: listing(images.system_dlkm), vendor_dlkm: listing(images.vendor_dlkm) };
        // (where each directory's modules may load theirs from, and its modules.dep lists:
        // vendor_dlkm's has system_dlkm's modules too)
        const dirs = { ramdisk: "/lib/modules/", system_dlkm: "/system/lib/modules/", vendor_dlkm: "/vendor/lib/modules/" };
        const from = { ramdisk: ["ramdisk"], system_dlkm: ["system_dlkm"], vendor_dlkm: ["system_dlkm", "vendor_dlkm"] };
        const missing = new Set(), replaced = {};
        for(const key of Object.keys(dirs))
        {
            const lines = new Map(from[key].flatMap(k => names[k].filter(n => n.endsWith(".ko")).map(n => [n, dirs[k] + n])));
            const loaded = new Set(key === "ramdisk" ? [] : names.ramdisk.filter(n => n.endsWith(".ko")));
            replaced[key] = modules_for_16k(names[key], lines, loaded, k16, missing);
        }
        const dlkm = {};
        for(const name of ["system_dlkm", "vendor_dlkm"])
        {
            const image = erofs_replace_files(images[name], [...replaced[name]].map(([file, data]) => ["lib/modules/" + file, data]));
            // (read back)
            for(const [file, data] of replaced[name])
            {
                if(!equals(erofs_data(image, erofs_lookup(image, "lib/modules/" + file)), data)) throw new Error(`erofs: ${name}'s ${file} does not read back`);
            }
            // (with an AVB footer again, as the partition had: fs_mgr's offline vbmeta)
            dlkm[name] = replace(name, "vbmeta_" + name, image, super_footer_struct(super_read, lp, name));
        }
        ramdisk_16k = lz4_legacy_store(cpio_newc([...replaced.ramdisk].map(([file, data]) => ["lib/modules/" + file, data])));
        const back = cpio_files(lz4_legacy_decompress(ramdisk_16k));
        for(const [file, data] of replaced.ramdisk) if(!back.has("lib/modules/" + file) || !equals(back.get("lib/modules/" + file), data)) throw new Error(`16K ramdisk: ${file} does not read back`);
        modules_16k = { replaced: Object.fromEntries(Object.entries(replaced).map(([key, files]) => [key, [...files.keys()].filter(f => f.endsWith(".ko")).length])),
            missing: [...missing].sort(), dlkm,
            // (the 16K build's modules no 4K directory has: built in there, or new; loaded by nothing here either)
            not_placed: [...k16.modules.keys()].filter(n => !Object.values(names).some(list => list.includes(n))).sort(), ramdisk_sha256: create_hash("sha256").update(ramdisk_16k).digest("hex") };
        for(const file of modules_16k.missing) console.log(`16K: ${file} has no 16K module (left as it was, not in modules.dep)`);
    }
    // (--shrink-super: super to its partitions' end and 64 MiB, its block
    // device's size in every metadata copy; docs/android-images-plan.md I4.3)
    if(args.shrink_super) super_patches.push(...lp_resize(lp, lp_end(lp) * SECTOR + (64 << 20)));
    // the bootloader's work (src/android/boot.js): the vbmeta digest,
    // bootconfig, the initrd and the command line
    const materials = gpu_mode => android_boot(name => vbmeta_of(name), DEVICE, { memory_mb: args.memory_mb, selinux: args.selinux,
        page_size: args.page_size, gpu_mode, vendor_ramdisk, extra_ramdisk: ramdisk_16k });
    const { initrd, cmdline, bootconfig, vbmeta } = materials("swiftshader");
    // (the virtual-device modules, for the GKI bridge)
    const modules = args.out + "modules/";
    fs.rmSync(modules, { recursive: true, force: true });
    fs.mkdirSync(modules);
    let module_count = 0;
    const module_files = new Map([...lib_modules(vendor_boot.ramdisk), ...(ramdisk_16k.length ? lib_modules(ramdisk_16k) : [])]);
    for(const [name, data] of module_files)
    {
        if(!/\.ko$|^modules\.(load|options|dep|softdep)$/.test(name)) continue;
        fs.writeFileSync(modules + name, data);
        if(name.endsWith(".ko")) module_count++;
    }
    if(!fs.existsSync(modules + "modules.load")) throw new Error("no lib/modules/modules.load in the vendor ramdisk");
    fs.writeFileSync(args.out + "initrd.img", initrd);
    // (and with libvulkan's driver odm's, Venus)
    const initrd_venus = venus && materials("venus").initrd;
    if(initrd_venus) fs.writeFileSync(args.out + "initrd-venus.img", initrd_venus);
    else fs.rmSync(args.out + "initrd-venus.img", { force: true });
    fs.writeFileSync(args.out + "cmdline.txt", cmdline + "\n");
    fs.writeFileSync(args.out + "bootconfig.txt", [...bootconfig].map(([k, v]) => `${k}=${v}\n`).join(""));

    // the disk: the device's partitions (Cuttlefish's order), the slotted
    // ones in both slots; userdata with 16 KiB pages blank, for first boot to
    // make ext4 there (see the top), and with --userdata-mb blank of that
    // size (first boot formats it, fs_mgr's formattable)
    const sources = {
        super: { sparse: IMG + "super.img", limit: args.shrink_super ? lp.size : undefined, skip: super_skip,
            patches: super_patches.length ? [...lp.copies.map(c => ({ offset: c.offset, bytes: c.bytes })), ...super_patches] : [] },
        userdata: args.userdata_mb ? { blank: args.userdata_mb * 1048576 } :
            hashes_16k ? { blank: sparse_size(file_reader(IMG + "userdata.img")) } : { sparse: IMG + "userdata.img" },
    };
    const layout = device_partitions(DEVICE).map(({ name, base, blank }) =>
    {
        const source = blank ? { blank } : sources[base] ||
            (vbmeta_images.has(base) ? { bytes: vbmeta_images.get(base) } : { file: IMG + partition_file[base] });
        const size = source.blank || source.bytes?.length || source.limit || (source.file ? fs.statSync(source.file).size : sparse_size(file_reader(source.sparse)));
        return { name, size, source };
    });
    const { partitions, disk_size } = gpt_layout(layout);
    const disk = args.out + "disk.img";
    // (kept when made from the same artifacts with the same layout, unless
    // --fresh-disk: the runs keep their writes in memory, the image stays
    // as made, and a guest still reading it is not disturbed)
    const disk_key = JSON.stringify({ artifacts: hashes, partitions: partitions.map(p => [p.name, p.start, p.size]),
        venus: venus ? venus.record : null, ...(hashes_16k ? { kernel_16k: hashes_16k, modules_16k } : {}), ...(gsi ? { gsi } : {}),
        ...(zygote64_32 ? { zygote64_32 } : {}) });
    const key_file = args.out + "disk.key";
    if(args.fresh_disk || !fs.existsSync(disk) || fs.statSync(disk).size !== disk_size ||
        !fs.existsSync(key_file) || fs.readFileSync(key_file, "utf8") !== disk_key)
    {
        fs.rmSync(key_file, { force: true });
        fs.rmSync(disk, { force: true });
        const fd = fs.openSync(disk, "w");
        fs.ftruncateSync(fd, disk_size);
        for(const { offset, bytes } of gpt_writes(disk_size, partitions)) fs.writeSync(fd, bytes, 0, bytes.length, offset);
        for(const p of partitions)
        {
            if(p.source.file || p.source.bytes)
            {
                const bytes = p.source.bytes || fs.readFileSync(p.source.file);
                fs.writeSync(fd, bytes, 0, bytes.length, p.start);
            }
            else if(p.source.sparse)
            {
                console.log(`${p.name}: unsparsing ${path.basename(p.source.sparse)} (${p.size} bytes)`);
                unsparse_into(p.source.sparse, fd, p.start, p.size, p.source.skip || []);
                for(const patch of p.source.patches || [])
                {
                    if(patch.bytes) fs.writeSync(fd, patch.bytes, 0, patch.bytes.length, p.start + patch.offset);
                    else
                    {
                        // (a zip member, as it inflates)
                        console.log(`${p.name}: ${patch.zip.entry.name} (${patch.zip.entry.size} bytes) at ${patch.offset}`);
                        let at = p.start + patch.offset;
                        await zip_stream(patch.zip.read, patch.zip.entry, bytes => { fs.writeSync(fd, bytes, 0, bytes.length, at); at += bytes.length; });
                    }
                }
            }
        }
        fs.closeSync(fd);
        fs.writeFileSync(key_file, disk_key);
    }
    else console.log("disk.img: kept (the same artifacts and layout; --fresh-disk makes it again)");

    const manifest = {
        build: { id: B.id, target: B.target, branch: B.branch, fingerprint: B.fingerprint, source: B.source, url: artifact_url(B) },
        kernel: hashes_16k ? { release: KERNEL_16K.release, page_size: 16384, build: KERNEL_16K.build, target: KERNEL_16K.target,
            branch: KERNEL_16K.branch, url: KERNEL_16K_URL, artifacts: hashes_16k } :
            { release: boot.kernel.includes("6.12.38-android16-5") ? "6.12.38-android16-5-g501f58f107ab-ab13974591-4k" : null,
                page_size: 4096, os_version: boot.os_version.toString(16) },
        artifacts: hashes,
        vendor_ramdisk: args.release ? "vendor_boot.img" : "vendor_ramdisk-debug.img",
        vbmeta,
        venus: venus ? { driver: { file: path.relative(ROOT, VENUS_DRIVER), sha256: create_hash("sha256").update(driver).digest("hex") },
            odm: venus.record, bootconfig: Object.fromEntries(DEVICE.gpu_modes.venus) } : null,
        ...(gsi ? { gsi } : {}),
        ...(zygote64_32 ? { zygote64_32 } : {}),
        cmdline,
        bootconfig: Object.fromEntries(bootconfig),
        disk: { size: disk_size, sector: SECTOR, boot_devices: DEVICE.boot_devices,
            partitions: partitions.map(p => ({ name: p.name, start: p.start, size: p.size })) },
        modules: module_count,
        modules_16k,
        results: { "Image": create_hash("sha256").update(kernel).digest("hex"),
            "initrd.img": create_hash("sha256").update(initrd).digest("hex"),
            ...(initrd_venus ? { "initrd-venus.img": create_hash("sha256").update(initrd_venus).digest("hex") } : {}) },
    };
    fs.writeFileSync(args.out + "manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    console.log(`${args.out}: Image, initrd.img (${initrd.length} bytes), disk.img (${disk_size} bytes, ${partitions.length} partitions), manifest.json`);
    if(args.extract) await extract(args);
}

/** what the booted guest has mounted read-only, as a tar (see the top) */
async function extract(args)
{
    const tar = ROOT + "build/a64-android/rootfs.tar";
    const work = ROOT + "build/a64-android/extract/";
    fs.mkdirSync(work, { recursive: true });
    fs.rmSync(tar, { force: true });
    const socket = path.join(os.tmpdir(), `v86-a64-android-${process.pid}.sock`);
    const extract_socket = path.join(os.tmpdir(), `v86-a64-android-${process.pid}-x.sock`);
    const qemu = spawn(qemu_binary(), android_qemu_args(args.out, { accel: "hvf", memory_mb: args.memory_mb, cores: 4,
        console_socket: socket, kernel_log: work + "kernel.log", logcat: work + "logcat.log", extract: extract_socket }), { stdio: "inherit" });
    const exited = new Promise(resolve => qemu.on("exit", resolve));
    const terminal = new AndroidConsole(socket);
    let output;
    try
    {
        await terminal.open();
        const deadline = Date.now() + 600000;
        for(;;)
        {
            const r = await terminal.run("getprop sys.boot_completed", 10000);
            if(r && r.output.trim() === "1") break;
            if(Date.now() > deadline) throw new Error("no sys.boot_completed=1 in 10 minutes (build/a64-android/extract/)");
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
        console.log("booted; writing " + tar);
        // (the port's data into the tar; connecting opens the port for the
        // guest, only once its driver runs: QEMU drops the event before)
        output = fs.createWriteStream(tar);
        const receiver = await new Promise((resolve, reject) => {
            const s = net.connect(extract_socket);
            s.once("connect", () => resolve(s));
            s.once("error", reject);
        });
        receiver.pipe(output);
        const port = (await terminal.run("for p in /sys/class/virtio-ports/*; do [ \"$(cat $p/name 2>/dev/null)\" = org.v86.extract ] && echo ${p##*/}; done")).output.trim();
        if(!/^vport\d+p\d+$/.test(port)) throw new Error("no org.v86.extract port: " + port);
        // (in system_server's mount namespace: the console's, init's
        // bootstrap one, has only the bootstrap APEXes)
        const roots = "system system_ext product vendor odm vendor_dlkm odm_dlkm system_dlkm $(ls -d /apex/*@* | cut -c2-)";
        const r = await terminal.run(`su 0 nsenter -t $(pidof system_server) -m -- sh -c ` +
            `'cd / && tar --exclude="*.apex" --exclude="*.capex" -cf /dev/${port} ${roots}'`, 1800000);
        console.log("tar: " + JSON.stringify(r));
        if(!r || r.status !== 0) throw new Error("tar failed: " + JSON.stringify(r));
        // (what is still on its way from the port)
        for(let last = -1; output.bytesWritten !== last;)
        {
            last = output.bytesWritten;
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    finally
    {
        terminal.close();
        qemu.kill("SIGKILL");
        await exited;
        if(output) await new Promise(resolve => output.end(resolve));
    }
    console.log(`${tar}: ${fs.statSync(tar).size} bytes`);
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main().catch(e => { console.error(e); process.exit(1); });
}
