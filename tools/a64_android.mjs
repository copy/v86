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
//   and androidboot.opengles.version=131072: ANGLE on Venus gives OpenGL ES
//   2.0 (WebGPU's 12 uniform buffers a stage are fewer than ES 3's blocks
//   and ANGLE's own; no transform feedback), so apps are not told 3.1.
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
//   node tools/a64_android.mjs [--download] [--release] [--selinux enforcing|permissive]
//       [--memory-mb 1536] [--out build/a64-android/out] [--extract] [--fresh-disk]
//   (--download: fetch the missing artifacts into build/a64-android/dl/ first;
//   --extract: then boot them on QEMU with HVF, the host's CPU, and write the
//   mounted read-only partitions and active APEXes as build/a64-android/rootfs.tar
//   for tools/a64_isa_scan.mjs --android, P10.4)
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash as create_hash } from "node:crypto";
import { crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";
import os from "node:os";
import net from "node:net";
import { android_qemu_args, AndroidConsole } from "../tests/a64/android_qemu.mjs";
import { qemu_binary } from "../tests/a64/guest_runner.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") + "/";
const BUILD = "15581820";
const TARGET = "aosp_cf_arm64_only_phone-userdebug";
const ARTIFACT_URL = `https://ci.android.com/builds/submitted/${BUILD}/${TARGET}/latest/raw/`;
/** the build's artifacts used, with their sizes and sha256 (the server's MD5 checked at download time) */
export const ARTIFACTS = {
    [`aosp_cf_arm64_only_phone-img-${BUILD}.zip`]: { size: 1046288463, sha256: "d56b75f00cd4a0005d54175fdf9bafb48c4b4f8c1a20ee4ac062b019080ef506" },
    "vendor_ramdisk-debug.img": { size: 18797343, sha256: "b9a00cd701d93acdb7fe3787d6674741e5373e0137777e0b3b68e5812ba65665" },
    [`manifest_${BUILD}.xml`]: { size: 156408, sha256: "d36c615a2210772946ba6d8a18165ac79faaa16c2ae17685adb47e4ec460cc1b" },
};
export const FINGERPRINT = `generic/aosp_cf_arm64_only_phone/vsoc_arm64_only:16/BP4A.251205.006/${BUILD}:userdebug/test-keys`;
const DL = ROOT + "build/a64-android/dl/";
const IMG = ROOT + "build/a64-android/img/";

const SECTOR = 512;
const ALIGN = 1 << 20;
/** the virt machine's PCIe host bridge (high ECAM), under which first stage
 * init looks for the partitions */
const BOOT_DEVICES = "4010000000.pcie";
/** the guest's Venus driver (tools/a64_venus/build.mjs), and what initrd-venus.img's bootconfig changes */
const VENUS_DRIVER = ROOT + "build/a64-android/venus/vulkan.virtio.so";
const VENUS_BOOTCONFIG = { "androidboot.hardware.vulkan": "virtio", "androidboot.hardware.hwcomposer.mode": "client",
    "androidboot.opengles.version": "131072" };

function parse_args(argv)
{
    const args = { download: false, release: false, selinux: "enforcing", memory_mb: 1536, extract: false, fresh_disk: false,
        out: ROOT + "build/a64-android/out/" };
    for(let i = 0; i < argv.length; i++)
    {
        const arg = argv[i];
        if(arg === "--download") args.download = true;
        else if(arg === "--release") args.release = true;
        else if(arg === "--selinux") args.selinux = argv[++i];
        else if(arg === "--memory-mb") args.memory_mb = +argv[++i];
        else if(arg === "--extract") args.extract = true;
        else if(arg === "--fresh-disk") args.fresh_disk = true;
        else if(arg === "--out") args.out = path.resolve(argv[++i]) + "/";
        else throw new Error("unknown argument " + arg);
    }
    if(!["enforcing", "permissive"].includes(args.selinux)) throw new Error("--selinux enforcing|permissive");
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

async function download(name)
{
    const response = await fetch(ARTIFACT_URL + name, { redirect: "follow" });
    if(!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const expected_md5 = (response.headers.get("x-goog-hash") || "").split(/,\s*/).find(h => h.startsWith("md5="));
    const temporary = DL + name + ".part";
    const fd = fs.openSync(temporary, "w");
    const md5 = create_hash("md5");
    for await (const chunk of response.body)
    {
        md5.update(chunk);
        fs.writeSync(fd, chunk);
    }
    fs.closeSync(fd);
    if(expected_md5 && expected_md5.slice(4) !== md5.digest("base64")) throw new Error(name + ": MD5 differs from the server's");
    fs.renameSync(temporary, DL + name);
}

async function fetch_artifacts(allow_download)
{
    fs.mkdirSync(DL, { recursive: true });
    const hashes = {};
    for(const [name, { size, sha256 }] of Object.entries(ARTIFACTS))
    {
        const file = DL + name;
        if(!fs.existsSync(file))
        {
            if(!allow_download) throw new Error(`${file} is missing (${size} bytes from ${ARTIFACT_URL}): run with --download`);
            console.log(`downloading ${name} (${size} bytes) from ci.android.com`);
            await download(name);
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
    const zip = DL + `aosp_cf_arm64_only_phone-img-${BUILD}.zip`;
    const stamp = IMG + ".unpacked";
    if(fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === String(fs.statSync(zip).mtimeMs)) return;
    fs.rmSync(IMG, { recursive: true, force: true });
    fs.mkdirSync(IMG, { recursive: true });
    const result = spawnSync("unzip", ["-o", "-q", zip, "-d", IMG], { stdio: "inherit" });
    if(result.status !== 0) throw new Error("unzip failed");
    fs.writeFileSync(stamp, String(fs.statSync(zip).mtimeMs));
}

const c_string = (bytes, offset, length) => bytes.subarray(offset, offset + length).toString("latin1").replace(/\0.*$/s, "");

/** boot.img and init_boot.img, header version 3 or 4: kernel and ramdisk (pages of 4096) */
export function parse_boot_image(bytes)
{
    if(bytes.toString("latin1", 0, 8) !== "ANDROID!") throw new Error("not a boot image");
    const version = bytes.readUInt32LE(40);
    if(version < 3) throw new Error("boot image header version " + version);
    const kernel_size = bytes.readUInt32LE(8), ramdisk_size = bytes.readUInt32LE(12);
    const page = 4096, align = x => Math.ceil(x / page) * page;
    const kernel = bytes.subarray(page, page + kernel_size);
    const ramdisk_offset = page + align(kernel_size);
    return { version, kernel, ramdisk: bytes.subarray(ramdisk_offset, ramdisk_offset + ramdisk_size),
        os_version: bytes.readUInt32LE(16), cmdline: c_string(bytes, 44, 1536) };
}

/** vendor_boot.img, header version 4: vendor ramdisks, cmdline, bootconfig */
export function parse_vendor_boot_image(bytes)
{
    if(bytes.toString("latin1", 0, 8) !== "VNDRBOOT") throw new Error("not a vendor boot image");
    const version = bytes.readUInt32LE(8);
    if(version !== 4) throw new Error("vendor boot image header version " + version);
    const page = bytes.readUInt32LE(12), align = x => Math.ceil(x / page) * page;
    const header_size = bytes.readUInt32LE(2096), ramdisk_size = bytes.readUInt32LE(24), dtb_size = bytes.readUInt32LE(2100);
    const table_size = bytes.readUInt32LE(2112), table_entries = bytes.readUInt32LE(2116), entry_size = bytes.readUInt32LE(2120);
    const bootconfig_size = bytes.readUInt32LE(2124);
    const ramdisk_offset = align(header_size);
    const table_offset = ramdisk_offset + align(ramdisk_size) + align(dtb_size);
    const bootconfig_offset = table_offset + align(table_size);
    const ramdisks = [];
    for(let i = 0; i < table_entries; i++)
    {
        const entry = table_offset + i * entry_size;
        const size = bytes.readUInt32LE(entry), offset = bytes.readUInt32LE(entry + 4);
        ramdisks.push({ type: bytes.readUInt32LE(entry + 8), name: c_string(bytes, entry + 12, 32),
            bytes: bytes.subarray(ramdisk_offset + offset, ramdisk_offset + offset + size) });
    }
    return { cmdline: c_string(bytes, 28, 2048), ramdisks, ramdisk: bytes.subarray(ramdisk_offset, ramdisk_offset + ramdisk_size),
        bootconfig: bytes.subarray(bootconfig_offset, bootconfig_offset + bootconfig_size).toString("latin1") };
}

/** LZ4's legacy frame (Android's ramdisks): its blocks, one after another */
export function lz4_legacy_decompress(input)
{
    if(input.readUInt32LE(0) !== 0x184C2102) throw new Error("not an LZ4 legacy frame");
    const chunks = [];
    for(let at = 4; at + 4 <= input.length;)
    {
        const size = input.readUInt32LE(at);
        // (another frame's magic: concatenated archives)
        if(size === 0x184C2102) { at += 4; continue; }
        const src = input.subarray(at + 4, at + 4 + size);
        at += 4 + size;
        const out = Buffer.alloc(8 << 20);
        let ip = 0, op = 0;
        while(ip < src.length)
        {
            const token = src[ip++];
            let literals = token >> 4;
            if(literals === 15) for(let b = 255; b === 255;) literals += b = src[ip++];
            src.copy(out, op, ip, ip + literals);
            ip += literals; op += literals;
            if(ip >= src.length) break;
            const offset = src[ip] | src[ip + 1] << 8;
            ip += 2;
            let length = token & 15;
            if(length === 15) for(let b = 255; b === 255;) length += b = src[ip++];
            length += 4;
            for(let i = 0; i < length; i++, op++) out[op] = out[op - offset];
        }
        chunks.push(out.subarray(0, op));
    }
    return Buffer.concat(chunks);
}

/** the regular files of newc cpio archives: Map name -> data */
export function cpio_files(bytes)
{
    const files = new Map();
    for(let at = 0; at + 110 <= bytes.length;)
    {
        if(bytes.toString("latin1", at, at + 6) !== "070701") { at += 4; continue; }
        const field = i => parseInt(bytes.toString("latin1", at + 6 + i * 8, at + 14 + i * 8), 16);
        const mode = field(1), size = field(6), name_size = field(11);
        const name = bytes.toString("latin1", at + 110, at + 110 + name_size - 1);
        const data_at = Math.ceil((at + 110 + name_size) / 4) * 4;
        if((mode & 0o170000) === 0o100000) files.set(name, bytes.subarray(data_at, data_at + size));
        at = Math.ceil((data_at + size) / 4) * 4;
    }
    return files;
}

/** key=value lines (bootconfig as the vendor_boot carries it) as a Map */
function parse_bootconfig(text)
{
    const map = new Map();
    for(const line of text.split("\n"))
    {
        const m = /^\s*([^#=\s][^=\s]*)\s*=\s*(.*?)\s*$/.exec(line);
        if(m) map.set(m[1], m[2].replace(/^"(.*)"$/, "$1"));
    }
    return map;
}

/** bootconfig appended to an initrd: the text, padded so the whole stays
 * 4-aligned, its size and checksum (the sum of its bytes), "#BOOTCONFIG\n" */
export function append_bootconfig(initrd, map)
{
    const text = Buffer.from([...map].map(([key, value]) => `${key} = "${value}"\n`).join("") + "\0");
    const pad = (4 - (initrd.length + text.length + 8 + 12) % 4) % 4;
    const data = Buffer.concat([text, Buffer.alloc(pad)]);
    const footer = Buffer.alloc(8);
    footer.writeUInt32LE(data.length, 0);
    footer.writeUInt32LE(data.reduce((sum, byte) => sum + byte, 0) >>> 0, 4);
    return Buffer.concat([initrd, data, footer, Buffer.from("#BOOTCONFIG\n")]);
}

/** Android sparse image -> raw, written into fd at offset; returns the raw size */
export function unsparse_into(file, fd, offset)
{
    const input = fs.openSync(file, "r");
    const header = Buffer.alloc(28);
    fs.readSync(input, header, 0, 28, 0);
    if(header.readUInt32LE(0) !== 0xED26FF3A) throw new Error(file + ": not a sparse image");
    const file_header_size = header.readUInt16LE(8), chunk_header_size = header.readUInt16LE(10);
    const block_size = header.readUInt32LE(12), total_blocks = header.readUInt32LE(16), total_chunks = header.readUInt32LE(20);
    let position = file_header_size, block = 0;
    const chunk_header = Buffer.alloc(chunk_header_size);
    const buffer = Buffer.alloc(64 << 20);
    for(let i = 0; i < total_chunks; i++)
    {
        fs.readSync(input, chunk_header, 0, chunk_header_size, position);
        const type = chunk_header.readUInt16LE(0), blocks = chunk_header.readUInt32LE(4), total = chunk_header.readUInt32LE(8);
        const data_position = position + chunk_header_size, bytes = blocks * block_size;
        const at = offset + block * block_size;
        if(type === 0xCAC1)
        {
            for(let done = 0; done < bytes;)
            {
                const n = Math.min(buffer.length, bytes - done);
                fs.readSync(input, buffer, 0, n, data_position + done);
                fs.writeSync(fd, buffer, 0, n, at + done);
                done += n;
            }
        }
        else if(type === 0xCAC2)
        {
            const fill = Buffer.alloc(4);
            fs.readSync(input, fill, 0, 4, data_position);
            if(fill.readUInt32LE(0) !== 0)
            {
                const pattern = Buffer.alloc(Math.min(buffer.length, bytes));
                for(let j = 0; j < pattern.length; j += 4) fill.copy(pattern, j);
                for(let done = 0; done < bytes; done += pattern.length) fs.writeSync(fd, pattern, 0, Math.min(pattern.length, bytes - done), at + done);
            }
        }
        else if(type !== 0xCAC3 && type !== 0xCAC4) throw new Error(`${file}: chunk type ${type.toString(16)}`);
        block += type === 0xCAC4 ? 0 : blocks;
        position += total;
    }
    fs.closeSync(input);
    if(block !== total_blocks) throw new Error(`${file}: ${block} of ${total_blocks} blocks`);
    return total_blocks * block_size;
}

/** bytes [offset, offset + length) of a sparse image's raw contents */
function sparse_read(file, offset, length)
{
    const out = Buffer.alloc(length);
    const input = fs.openSync(file, "r");
    const header = Buffer.alloc(28);
    fs.readSync(input, header, 0, 28, 0);
    if(header.readUInt32LE(0) !== 0xED26FF3A) throw new Error(file + ": not a sparse image");
    const chunk_header = Buffer.alloc(header.readUInt16LE(10));
    const block_size = header.readUInt32LE(12), total_chunks = header.readUInt32LE(20);
    for(let i = 0, position = header.readUInt16LE(8), at = 0; i < total_chunks && at < offset + length; i++)
    {
        fs.readSync(input, chunk_header, 0, chunk_header.length, position);
        const type = chunk_header.readUInt16LE(0), bytes = type === 0xCAC4 ? 0 : chunk_header.readUInt32LE(4) * block_size;
        const data = position + chunk_header.length, from = Math.max(at, offset), to = Math.min(at + bytes, offset + length);
        if(from < to && type === 0xCAC1) fs.readSync(input, out, from - offset, to - from, data + from - at);
        else if(from < to && type === 0xCAC2)
        {
            const fill = Buffer.alloc(4);
            fs.readSync(input, fill, 0, 4, data);
            for(let j = from; j < to; j++) out[j - offset] = fill[(j - at) % 4];
        }
        at += bytes;
        position += chunk_header.readUInt32LE(8);
    }
    fs.closeSync(input);
    return out;
}

/** the raw size of a sparse image */
function sparse_size(file)
{
    const header = Buffer.alloc(28);
    const fd = fs.openSync(file, "r");
    fs.readSync(fd, header, 0, 28, 0);
    fs.closeSync(fd);
    return header.readUInt32LE(12) * header.readUInt32LE(16);
}

// AVB (external/avb/libavb): big-endian structures
const AVB_HEADER_SIZE = 256;

/** a vbmeta struct (header, authentication and auxiliary blocks) at offset */
function vbmeta_struct(bytes, offset = 0)
{
    if(bytes.toString("latin1", offset, offset + 4) !== "AVB0") throw new Error("no vbmeta");
    const auth = Number(bytes.readBigUInt64BE(offset + 12)), aux = Number(bytes.readBigUInt64BE(offset + 20));
    const struct = bytes.subarray(offset, offset + AVB_HEADER_SIZE + auth + aux);
    const descriptors = [];
    const start = AVB_HEADER_SIZE + auth + Number(struct.readBigUInt64BE(96)), end = start + Number(struct.readBigUInt64BE(104));
    for(let at = start; at < end;)
    {
        const tag = Number(struct.readBigUInt64BE(at)), following = Number(struct.readBigUInt64BE(at + 8));
        if(tag === 4)
        {
            // chain partition: rollback_index_location, partition_name_len, public_key_len, flags, reserved[60]
            const name_length = struct.readUInt32BE(at + 20);
            descriptors.push({ tag, partition: struct.toString("latin1", at + 92, at + 92 + name_length) });
        }
        else if(tag === 1 || tag === 2)
        {
            // hashtree (1) / hash (2): the partition name follows the fixed part
            const fixed = tag === 1 ? 180 : 132, name_length = struct.readUInt32BE(at + (tag === 1 ? 104 : 56));
            descriptors.push({ tag, partition: struct.toString("latin1", at + fixed, at + fixed + name_length) });
        }
        else descriptors.push({ tag });
        at += 16 + following;
    }
    return { struct, descriptors, flags: struct.readUInt32BE(120) };
}

/** a partition image's vbmeta: through its footer, else at its start */
function partition_vbmeta(bytes)
{
    const footer = bytes.length - 64;
    if(footer >= 0 && bytes.toString("latin1", footer, footer + 4) === "AVBf")
    {
        return vbmeta_struct(bytes, Number(bytes.readBigUInt64BE(footer + 20)));
    }
    return vbmeta_struct(bytes);
}

/** the digest a bootloader passes as androidboot.vbmeta.digest: sha256 of
 * the vbmeta structs in libavb's load order (depth first) */
export function vbmeta_digest(read_partition)
{
    const structs = [];
    const visit = (vbmeta) =>
    {
        structs.push(vbmeta.struct);
        for(const d of vbmeta.descriptors)
        {
            if(d.tag === 4) visit(partition_vbmeta(read_partition(d.partition)));
        }
    };
    const root = vbmeta_struct(read_partition("vbmeta"));
    visit(root);
    const all = Buffer.concat(structs);
    return { digest: create_hash("sha256").update(all).digest("hex"), size: all.length, chained: root.descriptors.filter(d => d.tag === 4).map(d => d.partition) };
}

/** a hashtree descriptor's fields in a vbmeta struct (offsets into bytes) */
function hashtree_descriptor(bytes, partition)
{
    const auth = Number(bytes.readBigUInt64BE(12));
    const start = AVB_HEADER_SIZE + auth + Number(bytes.readBigUInt64BE(96)), end = start + Number(bytes.readBigUInt64BE(104));
    for(let at = start; at < end; at += 16 + Number(bytes.readBigUInt64BE(at + 8)))
    {
        if(Number(bytes.readBigUInt64BE(at)) !== 1) continue;
        const name_length = bytes.readUInt32BE(at + 104), salt_length = bytes.readUInt32BE(at + 108);
        if(bytes.toString("latin1", at + 180, at + 180 + name_length) !== partition) continue;
        const salt = at + 180 + name_length;
        return { at, image_size: Number(bytes.readBigUInt64BE(at + 20)), data_block: bytes.readUInt32BE(at + 44),
            hash_block: bytes.readUInt32BE(at + 48), algorithm: c_string(bytes, at + 72, 32),
            salt: bytes.subarray(salt, salt + salt_length), digest: salt + salt_length, digest_length: bytes.readUInt32BE(at + 112) };
    }
    throw new Error("vbmeta: no hashtree descriptor for " + partition);
}

/** dm-verity's hash tree of image as avbtool makes it (the top level first)
 * and its root digest */
export function avb_hashtree(image, salt, block = 4096)
{
    const levels = [];
    let level = image;
    while(level.length > block)
    {
        const count = Math.ceil(level.length / block);
        const next = Buffer.alloc(Math.ceil(count * 32 / block) * block);
        for(let i = 0; i < count; i++)
        {
            const data = Buffer.alloc(block);
            level.copy(data, 0, i * block, Math.min(level.length, (i + 1) * block));
            create_hash("sha256").update(salt).update(data).digest().copy(next, i * 32);
        }
        levels.unshift(next);
        level = next;
    }
    return { root: create_hash("sha256").update(salt).update(level).digest(), tree: Buffer.concat(levels) };
}

// liblp (system/core/fs_mgr/liblp/include/liblp/metadata_format.h): the
// super partition's geometry and metadata, little-endian
const LP_RESERVED_BYTES = 4096, LP_GEOMETRY_SIZE = 4096;

/** every copy of super's metadata (each slot's primary and backup), read
 * through read(offset, length) */
function lp_metadata(read)
{
    const geometry = read(LP_RESERVED_BYTES, 52);
    if(geometry.readUInt32LE(0) !== 0x616C4467) throw new Error("super: no liblp geometry");
    const max = geometry.readUInt32LE(40), slots = geometry.readUInt32LE(44);
    const copies = [];
    for(let i = 0; i < 2 * slots; i++)
    {
        const offset = LP_RESERVED_BYTES + 2 * LP_GEOMETRY_SIZE + max * i;
        const head = read(offset, 48);
        if(head.readUInt32LE(0) !== 0x414C5030) throw new Error(`super: no metadata at ${offset}`);
        const bytes = read(offset, head.readUInt32LE(8) + head.readUInt32LE(44));
        const header_size = bytes.readUInt32LE(8);
        const table = at => ({ offset: header_size + bytes.readUInt32LE(at), count: bytes.readUInt32LE(at + 4), size: bytes.readUInt32LE(at + 8) });
        const partitions = [], extents = table(92);
        const t = table(80);
        for(let p = 0; p < t.count; p++)
        {
            const at = t.offset + p * t.size;
            const first = bytes.readUInt32LE(at + 40), count = bytes.readUInt32LE(at + 44);
            partitions.push({ name: c_string(bytes, at, 36), extents: Array.from({ length: count }, (_, e) =>
            {
                const x = extents.offset + (first + e) * extents.size;
                return { at: x, sectors: Number(bytes.readBigUInt64LE(x)), type: bytes.readUInt32LE(x + 8), sector: Number(bytes.readBigUInt64LE(x + 12)) };
            }) });
        }
        copies.push({ offset, bytes, partitions });
    }
    // (the block device: super itself)
    const bytes = copies[0].bytes, device = bytes.readUInt32LE(8) + bytes.readUInt32LE(116);
    return { copies, alignment: bytes.readUInt32LE(device + 8), size: Number(bytes.readBigUInt64LE(device + 16)) };
}

/** a metadata copy's checksums (sha256 of the tables, then of the header
 * with its own checksum zero) */
function lp_checksum(bytes)
{
    const header_size = bytes.readUInt32LE(8);
    create_hash("sha256").update(bytes.subarray(header_size)).digest().copy(bytes, 48);
    bytes.fill(0, 12, 44);
    create_hash("sha256").update(bytes.subarray(0, header_size)).digest().copy(bytes, 12);
}

// erofs (fs/erofs/erofs_fs.h), little-endian
const EROFS_SUPER_OFFSET = 1024;

const CRC32C = Uint32Array.from({ length: 256 }, (_, i) =>
{
    for(let k = 0; k < 8; k++) i = i & 1 ? (i >>> 1) ^ 0x82F63B78 : i >>> 1;
    return i;
});
const crc32c = (crc, bytes) => bytes.reduce((c, b) => CRC32C[(c ^ b) & 0xFF] ^ (c >>> 8), crc) >>> 0;

/** an inode of a 4 KiB erofs image */
function erofs_inode(image, nid)
{
    const sb = EROFS_SUPER_OFFSET;
    if(image.readUInt32LE(sb) !== 0xE0F5E1E2 || image[sb + 12] !== 12) throw new Error("erofs: not a 4 KiB erofs image");
    const at = image.readUInt32LE(sb + 40) * 4096 + nid * 32, extended = image.readUInt16LE(at) & 1, xattr_count = image.readUInt16LE(at + 2);
    return { at, extended, layout: image.readUInt16LE(at) >> 1 & 7, mode: image.readUInt16LE(at + 4),
        size: extended ? Number(image.readBigUInt64LE(at + 8)) : image.readUInt32LE(at + 8),
        block: image.readUInt32LE(at + 16), xattrs: at + (extended ? 64 : 32), xattr_size: xattr_count ? 12 + 4 * (xattr_count - 1) : 0 };
}

/** an uncompressed (flat) inode's data, its last block inline or not */
function erofs_data(image, inode)
{
    if(inode.layout !== 0 && inode.layout !== 2) throw new Error("erofs: not a flat inode");
    const inline = inode.layout === 2 ? inode.size % 4096 : 0, blocks = inode.size - inline;
    return Buffer.concat([image.subarray(inode.block * 4096, inode.block * 4096 + blocks),
        image.subarray(inode.xattrs + inode.xattr_size, inode.xattrs + inode.xattr_size + inline)]);
}

/** a flat directory's entries */
function erofs_entries(image, inode)
{
    const data = erofs_data(image, inode), entries = [];
    for(let base = 0; base < data.length; base += 4096)
    {
        const length = Math.min(4096, data.length - base), count = data.readUInt16LE(base + 8) / 12;
        for(let i = 0; i < count; i++)
        {
            const end = base + (i + 1 < count ? data.readUInt16LE(base + (i + 1) * 12 + 8) : length);
            entries.push({ nid: Number(data.readBigUInt64LE(base + i * 12)), type: data[base + i * 12 + 10],
                name: data.toString("latin1", base + data.readUInt16LE(base + i * 12 + 8), end).replace(/\0.*$/s, "") });
        }
    }
    return entries;
}

/** the inode at path, through flat directories */
export function erofs_lookup(image, file_path)
{
    let inode = erofs_inode(image, image.readUInt16LE(EROFS_SUPER_OFFSET + 14));
    for(const name of file_path.split("/"))
    {
        const entry = erofs_entries(image, inode).find(e => e.name === name);
        if(!entry) return null;
        inode = erofs_inode(image, entry.nid);
    }
    return inode;
}

/** image (mkfs.erofs's) with a file at file_path, its directories new under
 * the root: the new inodes, directories and the file's data (uncompressed)
 * in blocks after the image's; the root's entries move into a block of
 * their own. labels: the SELinux label of the directories and of the file */
export function erofs_add_file(image, file_path, data, labels)
{
    const sb = EROFS_SUPER_OFFSET;
    const B = 4096, blocks = image.readUInt32LE(sb + 36), meta = image.readUInt32LE(sb + 40) * B;
    const root_nid = image.readUInt16LE(sb + 14), inos = Number(image.readBigUInt64LE(sb + 16));
    const root = erofs_inode(image, root_nid);
    const entries = erofs_entries(image, root);
    const names = file_path.split("/");
    if(entries.some(e => e.name === names[0])) throw new Error(`erofs: /${names[0]} exists`);
    // (the name filter of the root's xattrs, with security.selinux as ours)
    if(!root.xattr_size) throw new Error("erofs: the root has no xattrs");
    const filter = image.readUInt32LE(root.xattrs);
    const xattrs = label =>
    {
        const entry = Buffer.concat([Buffer.from([7, 6, label.length & 0xFF, label.length >> 8]), Buffer.from("selinux" + label, "latin1")]);
        const body = Buffer.alloc(12 + Math.ceil(entry.length / 4) * 4);
        body.writeUInt32LE(filter, 0);
        entry.copy(body, 12);
        return body;
    };
    const dirent_block = list =>
    {
        list.sort((a, b) => Buffer.compare(Buffer.from(a.name, "latin1"), Buffer.from(b.name, "latin1")));
        const block = Buffer.alloc(B);
        let name_at = list.length * 12;
        list.forEach((e, i) =>
        {
            block.writeBigUInt64LE(BigInt(e.nid), i * 12);
            block.writeUInt16LE(name_at, i * 12 + 8);
            block[i * 12 + 10] = e.type;
            name_at += block.write(e.name, name_at, "latin1");
        });
        if(name_at > B) throw new Error("erofs: a directory beyond one block");
        return { block, size: name_at };
    };
    // the layout after the image: one block of inodes, the directories' blocks, the data
    const new_dirs = names.length - 1;
    const inode_block = blocks, dir_block = blocks + 1, data_block = dir_block + 1 + new_dirs;
    const total = data_block + Math.ceil(data.length / B);
    const out = Buffer.alloc(total * B);
    image.copy(out, 0, 0, blocks * B);
    const nids = [];
    let at = inode_block * B;
    for(let i = 0; i < names.length; i++)
    {
        nids.push((at - meta) / 32);
        at += Math.ceil((32 + xattrs(labels[i + 1 === names.length ? "file" : "dir"]).length) / 32) * 32;
    }
    if(at > dir_block * B) throw new Error("erofs: the inodes beyond one block");
    const write_inode = (index, mode, nlink, size, block, label) =>
    {
        const i = (nids[index] * 32) + meta, x = xattrs(label);
        out.writeUInt16LE(0, i); // compact, flat plain
        out.writeUInt16LE((x.length - 12) / 4 + 1, i + 2);
        out.writeUInt16LE(mode, i + 4);
        out.writeUInt16LE(nlink, i + 6);
        out.writeUInt32LE(size, i + 8);
        out.writeUInt32LE(block, i + 16);
        out.writeUInt32LE(inos + 1 + index, i + 20);
        x.copy(out, i + 32);
    };
    const EROFS_FT_REG_FILE = 1, EROFS_FT_DIR = 2;
    for(let d = 0; d < new_dirs; d++)
    {
        const parent = d ? nids[d - 1] : root_nid;
        const child = { nid: nids[d + 1], type: d + 1 < new_dirs ? EROFS_FT_DIR : EROFS_FT_REG_FILE, name: names[d + 1] };
        const { block, size } = dirent_block([{ nid: nids[d], type: EROFS_FT_DIR, name: "." }, { nid: parent, type: EROFS_FT_DIR, name: ".." }, child]);
        block.copy(out, (dir_block + 1 + d) * B);
        write_inode(d, 0o40755, d + 1 < new_dirs ? 3 : 2, size, dir_block + 1 + d, labels.dir);
    }
    write_inode(new_dirs, 0o100644, 1, data.length, data_block, labels.file);
    data.copy(out, data_block * B);
    // the root: its entries and the new directory in a block of its own
    const { block, size } = dirent_block([...entries, { nid: nids[0], type: EROFS_FT_DIR, name: names[0] }]);
    block.copy(out, dir_block * B);
    out.writeUInt16LE(out.readUInt16LE(root.at) & ~0xE, root.at);
    if(root.extended)
    {
        out.writeBigUInt64LE(BigInt(size), root.at + 8);
        out.writeUInt32LE(out.readUInt32LE(root.at + 44) + 1, root.at + 44);
    }
    else
    {
        out.writeUInt32LE(size, root.at + 8);
        out.writeUInt16LE(out.readUInt16LE(root.at + 6) + 1, root.at + 6);
    }
    out.writeUInt32LE(dir_block, root.at + 16);
    // the superblock: its counts and checksum
    out.writeBigUInt64LE(BigInt(inos + names.length), sb + 16);
    out.writeUInt32LE(total, sb + 36);
    if(out.readUInt32LE(sb + 8) & 1)
    {
        out.writeUInt32LE(0, sb + 4);
        out.writeUInt32LE(crc32c(0xFFFFFFFF, out.subarray(sb, B)), sb + 4);
    }
    return out;
}

/** the Venus driver on odm (docs/arm64-virt-android16-plan.md P11.4 V3; see
 * the top): odm's image with the driver, its hash tree, the vbmeta with the
 * new descriptor, super's metadata copies with odm_a moved */
function odm_with_driver(super_read, vbmeta, driver)
{
    const lp = lp_metadata(super_read);
    const odm = lp.copies[0].partitions.find(p => p.name === "odm_a");
    if(!odm || odm.extents.length !== 1 || odm.extents[0].type !== 0) throw new Error("super: odm_a is not one linear extent");
    const descriptor = hashtree_descriptor(vbmeta, "odm");
    if(descriptor.algorithm !== "sha256" || descriptor.data_block !== 4096 || descriptor.hash_block !== 4096) throw new Error("vbmeta: odm's hash tree is not sha256 over 4 KiB blocks");
    const labels = { dir: "u:object_r:vendor_file:s0", file: "u:object_r:same_process_hal_file:s0" };
    const image = erofs_add_file(super_read(odm.extents[0].sector * SECTOR, descriptor.image_size), "lib64/vulkan.virtio.so", driver, labels);
    // (read back)
    const added = erofs_lookup(image, "lib64/vulkan.virtio.so");
    if(!added || !erofs_data(image, added).equals(driver) || !image.subarray(added.xattrs, added.xattrs + added.xattr_size).includes("selinux" + labels.file, 0, "latin1") ||
        !erofs_lookup(image, "etc/build.prop")) throw new Error("erofs: odm with the driver does not read back");
    const { root, tree } = avb_hashtree(image, descriptor.salt);
    const new_vbmeta = Buffer.from(vbmeta);
    const d = descriptor.at;
    new_vbmeta.writeBigUInt64BE(BigInt(image.length), d + 20);
    new_vbmeta.writeBigUInt64BE(BigInt(image.length), d + 28);
    new_vbmeta.writeBigUInt64BE(BigInt(tree.length), d + 36);
    // (no FEC)
    new_vbmeta.writeUInt32BE(0, d + 52);
    new_vbmeta.writeBigUInt64BE(0n, d + 56);
    new_vbmeta.writeBigUInt64BE(0n, d + 64);
    root.copy(new_vbmeta, descriptor.digest);
    // odm_a: in the free space after every partition's extents
    const align = lp.alignment / SECTOR;
    const end = Math.max(...lp.copies.flatMap(c => c.partitions.flatMap(p => p.extents.map(e => e.sector + e.sectors))));
    const sector = Math.ceil(end / align) * align, sectors = Math.ceil((image.length + tree.length) / lp.alignment) * align;
    if((sector + sectors) * SECTOR > lp.size) throw new Error("super: no room for odm_a");
    const metadata = [];
    for(const copy of lp.copies)
    {
        const p = copy.partitions.find(p => p.name === "odm_a");
        if(!p || p.extents.length !== 1 || p.extents[0].sector !== odm.extents[0].sector) throw new Error("super: the metadata copies differ in odm_a");
        copy.bytes.writeBigUInt64LE(BigInt(sectors), p.extents[0].at);
        copy.bytes.writeBigUInt64LE(BigInt(sector), p.extents[0].at + 12);
        lp_checksum(copy.bytes);
        metadata.push({ offset: copy.offset, bytes: copy.bytes });
    }
    return { vbmeta: new_vbmeta, odm: { offset: sector * SECTOR, bytes: Buffer.concat([image, tree]) }, metadata,
        record: { sector, sectors, image_blocks: image.length / 4096, root_digest: root.toString("hex") } };
}

// GPT
const LINUX_FILESYSTEM = "0FC63DAF-8483-4772-8E79-3D69D8477DE4";

function guid_bytes(text)
{
    const hex = text.replace(/-/g, "");
    const b = Buffer.from(hex, "hex");
    // the first three fields are little-endian
    return Buffer.concat([Buffer.from(b.subarray(0, 4)).reverse(), Buffer.from(b.subarray(4, 6)).reverse(),
        Buffer.from(b.subarray(6, 8)).reverse(), b.subarray(8)]);
}

/** a stable GUID from a name (version 4 layout, from sha256) */
function name_guid(name)
{
    const h = create_hash("sha256").update("v86-a64-android:" + name).digest("hex");
    const v = h.slice(0, 12) + "4" + h.slice(13, 16) + "8" + h.slice(17, 32);
    return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`.toUpperCase();
}

/** protective MBR, primary and backup GPT for partitions [{ name, start, size }] (bytes) */
export function write_gpt(fd, disk_size, partitions)
{
    const entries = Buffer.alloc(128 * 128);
    partitions.forEach((p, i) =>
    {
        const e = i * 128;
        guid_bytes(LINUX_FILESYSTEM).copy(entries, e);
        guid_bytes(name_guid(p.name)).copy(entries, e + 16);
        entries.writeBigUInt64LE(BigInt(p.start / SECTOR), e + 32);
        entries.writeBigUInt64LE(BigInt((p.start + p.size) / SECTOR - 1), e + 40);
        Buffer.from(p.name, "utf16le").copy(entries, e + 56);
    });
    const sectors = disk_size / SECTOR;
    const header = (current, backup, entries_lba) =>
    {
        const h = Buffer.alloc(SECTOR);
        h.write("EFI PART", 0, "latin1");
        h.writeUInt32LE(0x10000, 8);
        h.writeUInt32LE(92, 12);
        h.writeBigUInt64LE(BigInt(current), 24);
        h.writeBigUInt64LE(BigInt(backup), 32);
        h.writeBigUInt64LE(34n, 40);
        h.writeBigUInt64LE(BigInt(sectors - 34), 48);
        guid_bytes(name_guid("disk")).copy(h, 56);
        h.writeBigUInt64LE(BigInt(entries_lba), 72);
        h.writeUInt32LE(128, 80);
        h.writeUInt32LE(128, 84);
        h.writeUInt32LE(crc32(entries), 88);
        h.writeUInt32LE(crc32(h.subarray(0, 92)), 16);
        return h;
    };
    const mbr = Buffer.alloc(SECTOR);
    mbr[446 + 4] = 0xEE;
    mbr.writeUInt32LE(1, 446 + 8);
    mbr.writeUInt32LE(Math.min(sectors - 1, 0xFFFFFFFF), 446 + 12);
    mbr[446 + 1] = 0; mbr[446 + 2] = 2; // CHS of LBA 1
    mbr[446 + 5] = 0xFF; mbr[446 + 6] = 0xFF; mbr[446 + 7] = 0xFF;
    mbr.writeUInt16LE(0xAA55, 510);
    fs.writeSync(fd, mbr, 0, SECTOR, 0);
    fs.writeSync(fd, header(1, sectors - 1, 2), 0, SECTOR, SECTOR);
    fs.writeSync(fd, entries, 0, entries.length, 2 * SECTOR);
    fs.writeSync(fd, entries, 0, entries.length, (sectors - 33) * SECTOR);
    fs.writeSync(fd, header(sectors - 1, 1, sectors - 33), 0, SECTOR, (sectors - 1) * SECTOR);
}

/** what Cuttlefish's launcher puts into bootconfig (host/commands/assemble_cvd/
 * bootconfig_args.cpp, QEMU, gpu_mode guest_swiftshader, no host services)
 * and its bootloader (slot, normal boot, verified boot state) */
function launcher_bootconfig(args, vbmeta)
{
    return new Map([
        ["androidboot.slot_suffix", "_a"],
        ["androidboot.force_normal_boot", "1"],
        ["androidboot.verifiedbootstate", "orange"],
        ["androidboot.vbmeta.device_state", "unlocked"],
        ["androidboot.vbmeta.hash_alg", "sha256"],
        ["androidboot.vbmeta.size", String(vbmeta.size)],
        ["androidboot.vbmeta.digest", vbmeta.digest],
        ["androidboot.vbmeta.avb_version", "1.3"],
        ["androidboot.vbmeta.invalidate_on_error", "yes"],
        ["androidboot.veritymode", "enforcing"],
        ["androidboot.boot_devices", BOOT_DEVICES],
        ["androidboot.serialno", "V86A64ANDROID01"],
        ["androidboot.ddr_size", args.memory_mb + "MB"],
        ["androidboot.console", "ttyAMA0"],
        ["androidboot.serialconsole", "1"],
        ["androidboot.lcd_density", "320"],
        ["androidboot.setupwizard_mode", "DISABLED"],
        ["androidboot.enable_bootanimation", "1"],
        ...(args.selinux === "permissive" ? [["androidboot.selinux", "permissive"]] : []),
        ["androidboot.enable_confirmationui", "0"],
        ["androidboot.audio.tinyalsa.ignore_output", "true"],
        ["androidboot.audio.tinyalsa.simulate_input", "true"],
        ["androidboot.fstab_suffix", "cf.f2fs.hctr2"],
        ["androidboot.wifi_mac_prefix", "5554"],
        ["androidboot.hw_timeout_multiplier", "50"],
        ["androidboot.hypervisor.vm.supported", "0"],
        ["androidboot.hypervisor.protected_vm.supported", "0"],
        ["androidboot.vendor.apex.com.android.hardware.keymint", "com.android.hardware.keymint.rust_nonsecure"],
        ["androidboot.vendor.apex.com.android.hardware.gatekeeper", "com.android.hardware.gatekeeper.nonsecure"],
        ["androidboot.vendor.apex.com.android.hardware.secure_element", "com.android.hardware.secure_element"],
        ["androidboot.vendor.apex.com.android.hardware.strongbox", "none"],
        ["androidboot.vendor.apex.com.android.hardware.graphics.composer", "com.android.hardware.graphics.composer.ranchu"],
        ["androidboot.wifi_impl", "virt_wifi"],
        // the lights HAL listens on this vsock port (a privileged port 0
        // without it: EACCES, and system_server waits for the HAL forever);
        // the Thread network HAL needs a node id above 0
        ["androidboot.vsock_lights_port", "6900"],
        ["androidboot.vsock_lights_cid", "3"],
        ["androidboot.openthread_node_id", "1"],
        // gpu_mode guest_swiftshader (VK_API_VERSION_1_2, OpenGL ES 3.1)
        ["androidboot.cpuvulkan.version", String((1 << 22) | (2 << 12))],
        ["androidboot.hardware.gralloc", "minigbm"],
        ["androidboot.hardware.hwcomposer", "ranchu"],
        ["androidboot.hardware.hwcomposer.display_finder_mode", "drm"],
        ["androidboot.hardware.hwcomposer.display_framebuffer_format", "rgba"],
        ["androidboot.hardware.egl", "angle"],
        ["androidboot.hardware.vulkan", "pastel"],
        ["androidboot.opengles.version", "196609"],
    ]);
}

async function main()
{
    const args = parse_args(process.argv.slice(2));
    const hashes = await fetch_artifacts(args.download);
    unpack_images();
    fs.mkdirSync(args.out, { recursive: true });

    const read = name => fs.readFileSync(IMG + name);
    const boot = parse_boot_image(read("boot.img"));
    const init_boot = parse_boot_image(read("init_boot.img"));
    const vendor_boot = parse_vendor_boot_image(read("vendor_boot.img"));
    if(boot.kernel.toString("latin1", 56, 60) !== "ARMd") throw new Error("boot.img's kernel is not a raw arm64 Image");
    fs.writeFileSync(args.out + "Image", boot.kernel);

    const partition_file = {
        vbmeta: "vbmeta.img", vbmeta_system: "vbmeta_system.img", vbmeta_vendor_dlkm: "vbmeta_vendor_dlkm.img",
        vbmeta_system_dlkm: "vbmeta_system_dlkm.img", boot: "boot.img", init_boot: "init_boot.img", vendor_boot: "vendor_boot.img",
    };
    // the Venus driver on odm (see the top), when tools/a64_venus/build.mjs has made it
    const driver = fs.existsSync(VENUS_DRIVER) ? fs.readFileSync(VENUS_DRIVER) : null;
    const venus = driver && odm_with_driver((offset, length) => sparse_read(IMG + "super.img", offset, length), read("vbmeta.img"), driver);
    const vbmeta = vbmeta_digest(name => name === "vbmeta" && venus ? venus.vbmeta : read(partition_file[name]));

    const bootconfig = parse_bootconfig(vendor_boot.bootconfig);
    for(const [key, value] of launcher_bootconfig(args, vbmeta)) bootconfig.set(key, value);
    const vendor_ramdisk = args.release ? vendor_boot.ramdisk : fs.readFileSync(DL + "vendor_ramdisk-debug.img");
    // (the virtual-device modules, for the GKI bridge)
    const modules = args.out + "modules/";
    fs.rmSync(modules, { recursive: true, force: true });
    fs.mkdirSync(modules);
    let module_count = 0;
    for(const [name, data] of cpio_files(lz4_legacy_decompress(vendor_boot.ramdisk)))
    {
        const m = /^lib\/modules\/([^/]+)$/.exec(name);
        if(!m || !/\.ko$|^modules\.(load|options|dep|softdep)$/.test(m[1])) continue;
        fs.writeFileSync(modules + m[1], data);
        if(m[1].endsWith(".ko")) module_count++;
    }
    if(!fs.existsSync(modules + "modules.load")) throw new Error("no lib/modules/modules.load in the vendor ramdisk");
    const initrd = append_bootconfig(Buffer.concat([vendor_ramdisk, init_boot.ramdisk]), bootconfig);
    fs.writeFileSync(args.out + "initrd.img", initrd);
    // (and with libvulkan's driver odm's, Venus)
    const initrd_venus = venus && append_bootconfig(Buffer.concat([vendor_ramdisk, init_boot.ramdisk]),
        new Map([...bootconfig, ...Object.entries(VENUS_BOOTCONFIG)]));
    if(initrd_venus) fs.writeFileSync(args.out + "initrd-venus.img", initrd_venus);
    else fs.rmSync(args.out + "initrd-venus.img", { force: true });
    const cmdline = [vendor_boot.cmdline, boot.cmdline, "console=hvc0 earlycon=pl011,mmio32,0x9000000"].filter(Boolean).join(" ");
    fs.writeFileSync(args.out + "cmdline.txt", cmdline + "\n");
    fs.writeFileSync(args.out + "bootconfig.txt", [...bootconfig].map(([k, v]) => `${k}=${v}\n`).join(""));

    // the disk: Cuttlefish's partition order (host/commands/assemble_cvd/disk_flags.cc)
    const layout = [["misc", { blank: 1 << 20 }]];
    for(const name of ["boot", "init_boot", "vendor_boot", "vbmeta", "vbmeta_system", "vbmeta_vendor_dlkm", "vbmeta_system_dlkm"])
    {
        for(const slot of ["_a", "_b"]) layout.push([name + slot, name === "vbmeta" && venus ? { bytes: venus.vbmeta } : { file: IMG + partition_file[name] }]);
    }
    layout.push(["super", { sparse: IMG + "super.img", patches: venus ? [...venus.metadata, venus.odm] : [] }],
        ["userdata", { sparse: IMG + "userdata.img" }], ["metadata", { blank: 64 << 20 }]);
    // (and from Cuttlefish's second, persistent disk the one the guest
    // needs: frp, PersistentDataBlockService's, without which system_server
    // dies at boot phase 500)
    layout.push(["frp", { blank: 1 << 20 }]);
    const partitions = [];
    let at = ALIGN;
    for(const [name, source] of layout)
    {
        const size = source.blank || source.bytes?.length || (source.file ? fs.statSync(source.file).size : sparse_size(source.sparse));
        partitions.push({ name, start: at, size, source });
        at += Math.ceil(size / ALIGN) * ALIGN;
    }
    const disk_size = at + ALIGN;
    const disk = args.out + "disk.img";
    // (kept when made from the same artifacts with the same layout, unless
    // --fresh-disk: the runs keep their writes in memory, the image stays
    // as made, and a guest still reading it is not disturbed)
    const disk_key = JSON.stringify({ artifacts: hashes, partitions: partitions.map(p => [p.name, p.start, p.size]),
        venus: venus ? venus.record : null });
    const key_file = args.out + "disk.key";
    if(args.fresh_disk || !fs.existsSync(disk) || fs.statSync(disk).size !== disk_size ||
        !fs.existsSync(key_file) || fs.readFileSync(key_file, "utf8") !== disk_key)
    {
        fs.rmSync(key_file, { force: true });
        fs.rmSync(disk, { force: true });
        const fd = fs.openSync(disk, "w");
        fs.ftruncateSync(fd, disk_size);
        write_gpt(fd, disk_size, partitions);
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
                unsparse_into(p.source.sparse, fd, p.start);
                for(const patch of p.source.patches || []) fs.writeSync(fd, patch.bytes, 0, patch.bytes.length, p.start + patch.offset);
            }
        }
        fs.closeSync(fd);
        fs.writeFileSync(key_file, disk_key);
    }
    else console.log("disk.img: kept (the same artifacts and layout; --fresh-disk makes it again)");

    const manifest = {
        build: { id: BUILD, target: TARGET, branch: "aosp-android-latest-release", fingerprint: FINGERPRINT, source: "android16-qpr2-release",
            url: ARTIFACT_URL },
        kernel: { release: boot.kernel.includes("6.12.38-android16-5") ? "6.12.38-android16-5-g501f58f107ab-ab13974591-4k" : null,
            os_version: boot.os_version.toString(16) },
        artifacts: hashes,
        vendor_ramdisk: args.release ? "vendor_boot.img" : "vendor_ramdisk-debug.img",
        vbmeta,
        venus: venus ? { driver: { file: path.relative(ROOT, VENUS_DRIVER), sha256: create_hash("sha256").update(driver).digest("hex") },
            odm: venus.record, bootconfig: VENUS_BOOTCONFIG } : null,
        cmdline,
        bootconfig: Object.fromEntries(bootconfig),
        disk: { size: disk_size, sector: SECTOR, boot_devices: BOOT_DEVICES,
            partitions: partitions.map(p => ({ name: p.name, start: p.start, size: p.size })) },
        modules: module_count,
        results: { "Image": create_hash("sha256").update(boot.kernel).digest("hex"),
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
