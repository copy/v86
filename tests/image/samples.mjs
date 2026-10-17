// Disk image samples for the format tests (docs/disk-image-formats-plan.md,
// "验收矩阵"), made by an independent tool: qemu-img and qemu-io (QEMU_IMG,
// QEMU_IO; Homebrew's by default). A RAW image of 64 MiB with random, zero
// and patterned regions is converted to each format; others are written
// with qemu-io (zero clusters, snapshots, a disk of 3 TiB). Each sample has
// a RAW reference converted back by qemu-img (or, for the 3 TiB one, the
// list of its writes). The samples are made once in build/disk-image-samples
// (DISK_IMAGE_SAMPLES), the commands and the tool's version in manifest.json.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash as create_hash } from "node:crypto";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const SAMPLES_DIR = process.env.DISK_IMAGE_SAMPLES || path.join(root, "build/disk-image-samples");
const QEMU_IMG = process.env.QEMU_IMG || (fs.existsSync("/opt/homebrew/bin/qemu-img") ? "/opt/homebrew/bin/qemu-img" : "qemu-img");
const QEMU_IO = process.env.QEMU_IO || (fs.existsSync("/opt/homebrew/bin/qemu-io") ? "/opt/homebrew/bin/qemu-io" : "qemu-io");

// changing a sample: change this, and the samples are made again
const SAMPLES_VERSION = 6;

export const BASE_SIZE = 64 * 1024 * 1024;
export const TB3 = 3 * 1024 ** 4;

/**
 * A reproducible pseudo-random generator (xorshift32)
 * @param {number} seed
 */
export function random_generator(seed)
{
    let x = seed >>> 0 || 1;
    return () =>
    {
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5; x >>>= 0;
        return x;
    };
}

/**
 * Bytes from the generator
 * @param {function():number} next
 * @param {number} length
 */
export function random_bytes(next, length)
{
    const bytes = new Uint8Array(length);
    for(let i = 0; i < length; i += 4)
    {
        const value = next();
        bytes[i] = value; bytes[i + 1] = value >>> 8; bytes[i + 2] = value >>> 16; bytes[i + 3] = value >>> 24;
    }
    return bytes;
}

/**
 * The RAW base: 64 KiB regions, random, zero, a few sectors, 0xFF; the first
 * and last regions random
 */
function make_base()
{
    const next = random_generator(0x86);
    const disk = new Uint8Array(BASE_SIZE);
    const region = 64 * 1024;
    for(let i = 0; i < BASE_SIZE / region; i++)
    {
        const kind = i === 0 || i === BASE_SIZE / region - 1 ? 0 : next() % 8;
        const start = i * region;
        if(kind <= 2) disk.set(random_bytes(next, region), start);
        else if(kind === 5)
        {
            for(let s = 0; s < 4; s++)
            {
                const sector = next() % (region / 512);
                disk.set(random_bytes(next, 512), start + sector * 512);
            }
        }
        else if(kind === 6) disk.fill(0xFF, start, start + region);
    }
    return disk;
}

function run(tool, args, log)
{
    log.push([path.basename(tool), ...args.map(a => a.startsWith(SAMPLES_DIR) ? path.relative(SAMPLES_DIR, a) : a)].join(" "));
    return execFileSync(tool, args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function sha256_file(file)
{
    const hash = create_hash("sha256");
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(1 << 20);
    for(;;)
    {
        const n = fs.readSync(fd, buffer, 0, buffer.length, null);
        if(!n) break;
        hash.update(buffer.subarray(0, n));
    }
    fs.closeSync(fd);
    return hash.digest("hex");
}

/**
 * Make the samples (if needed) and describe them
 * @return {{dir: string, version: string, samples: Object}}
 */
export function make_samples()
{
    const manifest_path = path.join(SAMPLES_DIR, "manifest.json");
    if(fs.existsSync(manifest_path))
    {
        const manifest = JSON.parse(fs.readFileSync(manifest_path, "utf8"));
        if(manifest.samples_version === SAMPLES_VERSION) return manifest;
    }
    let version;
    try
    {
        version = execFileSync(QEMU_IMG, ["--version"]).toString().split("\n")[0];
    }
    catch(e)
    {
        throw new Error("The disk image tests need qemu-img and qemu-io (QEMU_IMG, QEMU_IO): " + e.message);
    }
    fs.rmSync(SAMPLES_DIR, { recursive: true, force: true });
    fs.mkdirSync(SAMPLES_DIR, { recursive: true });
    const log = [];
    const file = name => path.join(SAMPLES_DIR, name);
    const samples = {};
    const add = (name, format, reference, extra = {}) =>
    {
        samples[name] = { file: name, format, reference, ...extra };
    };

    fs.writeFileSync(file("base.raw"), make_base());
    log.push("base.raw: 64 MiB from tests/image/samples.mjs (make_base, seed 0x86)");

    // QCOW2 from the RAW base: versions, cluster sizes
    const convert = (name, options) =>
    {
        run(QEMU_IMG, ["convert", "-f", "raw", "-O", "qcow2", ...options, file("base.raw"), file(name)], log);
        add(name, "qcow2", "base.raw");
    };
    convert("v3.qcow2", ["-o", "compat=1.1"]);
    convert("v2.qcow2", ["-o", "compat=0.10"]);
    convert("v3-512.qcow2", ["-o", "compat=1.1,cluster_size=512"]);
    convert("v3-2m.qcow2", ["-o", "compat=1.1,cluster_size=2M"]);
    convert("v2-4k.qcow2", ["-o", "compat=0.10,cluster_size=4096"]);
    convert("v3-zlib.qcow2", ["-c", "-o", "compat=1.1"]);
    convert("v3-zstd.qcow2", ["-c", "-o", "compat=1.1,compression_type=zstd"]);
    convert("v2-zlib.qcow2", ["-c", "-o", "compat=0.10"]);

    // written with qemu-io: data, zero clusters (with and without the
    // cluster's allocation kept), discarded clusters, a compressed write;
    // an internal snapshot of the state before the last writes
    const pattern = file("pattern.bin");
    fs.writeFileSync(pattern, random_bytes(random_generator(0x1234), 1 << 20));
    run(QEMU_IMG, ["convert", "-f", "raw", "-O", "qcow2", "-o", "compat=1.1", file("base.raw"), file("io.qcow2")], log);
    run(QEMU_IMG, ["snapshot", "-c", "before", file("io.qcow2")], log);
    run(QEMU_IO, ["-f", "qcow2",
        "-c", "write -q -z 0 65536",                  // a zero cluster, its allocation kept
        "-c", "write -q -z -u 131072 131072",         // zero clusters, unmapped
        "-c", "write -q -s " + pattern + " 1048576 196608",
        "-c", "write -q -P 0x5a 4194816 1024",        // part of a cluster
        "-c", "write -q -z 8389120 512",              // part of a cluster: zeroes written
        "-c", "discard -q 16777216 1048576",
        // compressed (a pattern that compresses), in the discarded part: a
        // compressed write needs an unallocated cluster
        "-c", "write -q -c -P 0x33 16842752 65536",
        file("io.qcow2")], log);
    run(QEMU_IMG, ["convert", "-O", "raw", file("io.qcow2"), file("io.raw")], log);
    add("io.qcow2", "qcow2", "io.raw", { snapshots: 1 });

    // a parent and a child: the child's zero clusters hide the parent's data
    run(QEMU_IMG, ["convert", "-f", "raw", "-O", "qcow2", "-o", "compat=1.1", file("base.raw"), file("parent.qcow2")], log);
    run(QEMU_IMG, ["create", "-q", "-f", "qcow2", "-o", "compat=1.1", "-b", "parent.qcow2", "-F", "qcow2", file("child.qcow2")], log);
    run(QEMU_IO, ["-f", "qcow2",
        "-c", "write -q -z 0 131072",
        "-c", "write -q -s " + pattern + " 524288 262144",
        "-c", "write -q -P 0xc3 3145728 4096",
        file("child.qcow2")], log);
    run(QEMU_IMG, ["convert", "-O", "raw", file("child.qcow2"), file("child.raw")], log);
    add("child.qcow2", "qcow2", "child.raw", { backing: "parent.qcow2" });
    // compression and parents: a child of a compressed parent, a compressed
    // child (convert -c -B: only what differs from the parent)
    run(QEMU_IMG, ["create", "-q", "-f", "qcow2", "-o", "compat=1.1", "-b", "v3-zlib.qcow2", "-F", "qcow2", file("child-of-zlib.qcow2")], log);
    run(QEMU_IO, ["-f", "qcow2", "-c", "write -q -z 65536 65536", "-c", "write -q -s " + pattern + " 2097152 131072",
        file("child-of-zlib.qcow2")], log);
    run(QEMU_IMG, ["convert", "-O", "raw", file("child-of-zlib.qcow2"), file("child-of-zlib.raw")], log);
    add("child-of-zlib.qcow2", "qcow2", "child-of-zlib.raw", { backing: "v3-zlib.qcow2" });
    run(QEMU_IMG, ["convert", "-c", "-O", "qcow2", "-o", "compat=1.1", "-B", "parent.qcow2", "-F", "qcow2",
        file("child.qcow2"), file("child-zlib.qcow2")], log);
    add("child-zlib.qcow2", "qcow2", "child.raw", { backing: "parent.qcow2" });
    // a child of a RAW parent, smaller than the child
    run(QEMU_IMG, ["create", "-q", "-f", "qcow2", "-o", "compat=1.1", "-b", "base.raw", "-F", "raw", file("child-raw.qcow2"), "80M"], log);
    run(QEMU_IO, ["-f", "qcow2", "-c", "write -q -P 0x77 66060288 1048576", "-c", "write -q -P 0x11 4096 4096",
        file("child-raw.qcow2")], log);
    run(QEMU_IMG, ["convert", "-O", "raw", file("child-raw.qcow2"), file("child-raw.raw")], log);
    add("child-raw.qcow2", "qcow2", "child-raw.raw", { backing: "base.raw", backing_format: "raw" });

    // 3 TiB: writes around 4 GiB and 2^32 sectors (2 TiB), and at the end
    const big_writes = [
        [4 * 1024 ** 3 - 4096, 8192],
        [2 * 1024 ** 4 - 65536 - 512, 131072],
        [TB3 - 65536, 65536],
    ];
    run(QEMU_IMG, ["create", "-q", "-f", "qcow2", "-o", "compat=1.1", file("3t.qcow2"), String(TB3)], log);
    run(QEMU_IO, ["-f", "qcow2", ...big_writes.flatMap(([offset, length], i) =>
        ["-c", "write -q -s " + pattern + " " + offset + " " + length]), file("3t.qcow2")], log);
    add("3t.qcow2", "qcow2", null, { size: TB3, writes: big_writes, pattern: "pattern.bin" });

    // VHD (qemu-img's "vpc"; P3): dynamic and fixed, the size from the CHS
    // geometry (creator "qemu") or exact (force_size: "qem2"); the
    // references converted back with -f vpc (qemu-img does not probe a fixed
    // VHD: its footer is at the end)
    const vhd = (name, options) =>
    {
        run(QEMU_IMG, ["convert", "-f", "raw", "-O", "vpc", ...options, file("base.raw"), file(name)], log);
        run(QEMU_IMG, ["convert", "-f", "vpc", "-O", "raw", file(name), file(name + ".raw")], log);
        add(name, "vhd", name + ".raw");
    };
    vhd("dynamic.vhd", []);
    vhd("dynamic-force.vhd", ["-o", "force_size=on"]);
    vhd("fixed.vhd", ["-o", "subformat=fixed"]);
    vhd("fixed-force.vhd", ["-o", "subformat=fixed,force_size=on"]);
    // a sparse dynamic VHD of 100 GiB, written beyond 4 GiB and at its end
    const vhd_writes = [[5 * 1024 ** 3 - 4096, 8192], [100 * 1024 ** 3 - 65536, 65536]];
    run(QEMU_IMG, ["create", "-q", "-f", "vpc", "-o", "force_size=on", file("100g.vhd"), "100G"], log);
    run(QEMU_IO, ["-f", "vpc", ...vhd_writes.flatMap(([offset, length]) => ["-c", "write -q -s " + pattern + " " + offset + " " + length]),
        file("100g.vhd")], log);
    add("100g.vhd", "vhd", null, { size: 100 * 1024 ** 3, writes: vhd_writes, pattern: "pattern.bin" });

    // VDI (P3): dynamic and fixed ("static"), and 3 TiB dynamic written
    // across 2^32 sectors
    const vdi = (name, options) =>
    {
        run(QEMU_IMG, ["convert", "-f", "raw", "-O", "vdi", ...options, file("base.raw"), file(name)], log);
        add(name, "vdi", "base.raw");
    };
    vdi("dynamic.vdi", []);
    vdi("static.vdi", ["-o", "static=on"]);
    run(QEMU_IMG, ["create", "-q", "-f", "vdi", file("3t.vdi"), String(TB3)], log);
    run(QEMU_IO, ["-f", "vdi", ...big_writes.flatMap(([offset, length]) => ["-c", "write -q -s " + pattern + " " + offset + " " + length]),
        file("3t.vdi")], log);
    add("3t.vdi", "vdi", null, { size: TB3, writes: big_writes, pattern: "pattern.bin" });

    // VMDK (P4): the subformats qemu-img makes; zeroed grains; a child with
    // its parent (parentCID); 100 GiB sparse, 5 GiB in 2 GiB extents (sparse
    // and flat) written across an extent's end
    const vmdk = (name, options, extra = {}) =>
    {
        run(QEMU_IMG, ["convert", "-f", "raw", "-O", "vmdk", ...options, file("base.raw"), file(name)], log);
        add(name, "vmdk", "base.raw", extra);
    };
    vmdk("sparse.vmdk", []);
    vmdk("stream.vmdk", ["-o", "subformat=streamOptimized"]);
    vmdk("flat.vmdk", ["-o", "subformat=monolithicFlat"], { files: ["flat-flat.vmdk"] });
    vmdk("2gbsparse.vmdk", ["-o", "subformat=twoGbMaxExtentSparse"], { files: ["2gbsparse-s001.vmdk"] });
    vmdk("2gbflat.vmdk", ["-o", "subformat=twoGbMaxExtentFlat"], { files: ["2gbflat-f001.vmdk"] });
    run(QEMU_IMG, ["convert", "-f", "raw", "-O", "vmdk", "-o", "zeroed_grain=on", file("base.raw"), file("zeroed.vmdk")], log);
    run(QEMU_IO, ["-f", "vmdk", "-c", "write -q -z 0 131072", "-c", "write -q -z 1048576 65536", file("zeroed.vmdk")], log);
    run(QEMU_IMG, ["convert", "-f", "vmdk", "-O", "raw", file("zeroed.vmdk"), file("zeroed.vmdk.raw")], log);
    add("zeroed.vmdk", "vmdk", "zeroed.vmdk.raw");
    run(QEMU_IMG, ["create", "-q", "-f", "vmdk", "-b", "sparse.vmdk", "-F", "vmdk", file("child.vmdk")], log);
    run(QEMU_IO, ["-f", "vmdk", "-c", "write -q -s " + pattern + " 524288 262144", "-c", "write -q -P 0xc3 3145728 4096",
        file("child.vmdk")], log);
    run(QEMU_IMG, ["convert", "-f", "vmdk", "-O", "raw", file("child.vmdk"), file("child.vmdk.raw")], log);
    add("child.vmdk", "vmdk", "child.vmdk.raw", { backing: "sparse.vmdk" });
    const vmdk_writes = [[5 * 1024 ** 3 - 4096, 8192], [100 * 1024 ** 3 - 65536, 65536]];
    run(QEMU_IMG, ["create", "-q", "-f", "vmdk", file("100g.vmdk"), "100G"], log);
    run(QEMU_IO, ["-f", "vmdk", ...vmdk_writes.flatMap(([offset, length]) => ["-c", "write -q -s " + pattern + " " + offset + " " + length]),
        file("100g.vmdk")], log);
    add("100g.vmdk", "vmdk", null, { size: 100 * 1024 ** 3, writes: vmdk_writes, pattern: "pattern.bin" });
    const extent_writes = [[2 * 1024 ** 3 - 65536 - 512, 131072], [5 * 1024 ** 3 - 4096, 4096]];
    for(const [name, subformat] of [["5g-sparse.vmdk", "twoGbMaxExtentSparse"], ["5g-flat.vmdk", "twoGbMaxExtentFlat"]])
    {
        run(QEMU_IMG, ["create", "-q", "-f", "vmdk", "-o", "subformat=" + subformat, file(name), "5G"], log);
        run(QEMU_IO, ["-f", "vmdk", ...extent_writes.flatMap(([offset, length]) => ["-c", "write -q -s " + pattern + " " + offset + " " + length]),
            file(name)], log);
        const stem = name.replace(/\.vmdk$/, "");
        const letter = subformat.endsWith("Sparse") ? "s" : "f";
        add(name, "vmdk", null, { size: 5 * 1024 ** 3, writes: extent_writes, pattern: "pattern.bin",
            files: [1, 2, 3].map(i => stem + "-" + letter + String(i).padStart(3, "0") + ".vmdk") });
    }

    // features that are refused
    run(QEMU_IMG, ["create", "-q", "-f", "qcow2", "-o", "compat=1.1,extended_l2=on", file("extl2.qcow2"), "16M"], log);
    // (the data file's name relative to the working directory: the image
    // records the path given)
    run(QEMU_IMG, ["create", "-q", "-f", "qcow2", "-o", "compat=1.1,data_file=" + file("data-file.raw"), file("data-file.qcow2"), "16M"], log);
    // (a test key, nothing secret)
    run(QEMU_IMG, ["create", "-q", "--object", "secret,id=sec0,data=v86test", "-f", "qcow2",
        "-o", "encrypt.format=luks,encrypt.key-secret=sec0,encrypt.iter-time=10", file("luks.qcow2"), "16M"], log);
    add("extl2.qcow2", "qcow2", null, { refused: "extended L2" });
    add("data-file.qcow2", "qcow2", null, { refused: "external data file" });
    add("luks.qcow2", "qcow2", null, { refused: "encrypted" });

    // (QEMU's names of the formats: a fixed VHD is not probed)
    const qemu_format = format => format === "vhd" ? "vpc" : format;
    for(const sample of Object.values(samples))
    {
        sample.sha256 = sha256_file(file(sample.file));
        sample.length = fs.statSync(file(sample.file)).size;
        if(!sample.size)
        {
            sample.size = Number(JSON.parse(run(QEMU_IMG, ["info", "--output=json", "-U", "-f", qemu_format(sample.format),
                file(sample.file)], []))["virtual-size"]);
        }
    }
    for(const sample of Object.values(samples))
    {
        // (qemu-img has no check of VHD)
        if(!sample.refused && sample.format !== "vhd") run(QEMU_IMG, ["check", "-q", "-U", "-f", qemu_format(sample.format), file(sample.file)], log);
    }
    const manifest = { samples_version: SAMPLES_VERSION, tool: version, dir: SAMPLES_DIR, commands: log, samples };
    fs.writeFileSync(manifest_path, JSON.stringify(manifest, null, 2));
    return manifest;
}

/**
 * Zstandard for the readers in Node (v86 itself uses its core's decoder):
 * the first frame of the data (a QCOW2 cluster's bytes end in a sector, the
 * rest is not the frame's), found by walking its blocks, decoded by zlib
 * @param {number} size
 * @param {Uint8Array} bytes
 */
export function zstd_decompress(size, bytes)
{
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if(view.getUint32(0, true) !== 0xFD2FB528) throw new Error("not a Zstandard frame");
    const descriptor = bytes[4];
    const single_segment = descriptor >> 5 & 1;
    const fcs = [single_segment ? 1 : 0, 2, 4, 8][descriptor >> 6];
    let position = 5 + (single_segment ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + fcs;
    for(;;)
    {
        const header = bytes[position] | bytes[position + 1] << 8 | bytes[position + 2] << 16;
        const type = header >> 1 & 3, block_size = header >> 3;
        position += 3 + (type === 1 ? 1 : block_size);
        if(header & 1) break;
    }
    if(descriptor & 4) position += 4;
    const output = zlib.zstdDecompressSync(bytes.subarray(0, position));
    return new Uint8Array(output.buffer, output.byteOffset, Math.min(size, output.length));
}

/**
 * The expected bytes of [offset, offset + length) of a sample without a RAW
 * reference: its writes (from the pattern file) and zeros
 */
export function expected_from_writes(sample, offset, length)
{
    const pattern = fs.readFileSync(path.join(SAMPLES_DIR, sample.pattern));
    const result = new Uint8Array(length);
    for(const [start, size] of sample.writes)
    {
        const from = Math.max(start, offset), to = Math.min(start + size, offset + length);
        if(from < to) result.set(pattern.subarray(from - start, to - start), from - offset);
    }
    return result;
}

if(process.argv[1] === fileURLToPath(import.meta.url))
{
    const manifest = make_samples();
    console.log(manifest.tool);
    for(const [name, sample] of Object.entries(manifest.samples))
    {
        console.log(name.padEnd(20), String(sample.length).padStart(10), sample.sha256);
    }
}
