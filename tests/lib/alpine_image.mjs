// The pinned Alpine Linux 3.24.0 images of the tests
// (docs/arm64-virt-android16-plan.md P0.1): each ISO's name and SHA-256, the
// directory it is cached in, and its kernel and initramfs (and for aarch64
// the modloop and the kernel configuration) unpacked with bsdtar. An ISO is
// downloaded once from dl-cdn.alpinelinux.org (or copied from
// ALPINE_CACHE=<dir>, where another worktree keeps it) and checked against
// its SHA-256 on every use.
//
// Alpine aarch64's vmlinuz-* is an EFI zboot image (a PE/COFF stub with a
// gzip payload): unzboot() gives the arm64 Image inside, whose header it
// checks.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { createHash as create_hash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RELEASES = "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/";

/** The images, by architecture and flavour */
export const IMAGES = {
    "x86_64-virt": { arch: "x86_64", name: "alpine-virt-3.24.0-x86_64.iso",
        sha256: "6cd1a38ae05cf96a5d0cbb2ddd6c630834babfeca1ecc5d1f05ec0b06b886102", flavor: "virt" },
    "x86_64-lts": { arch: "x86_64", name: "alpine-standard-3.24.0-x86_64.iso",
        sha256: "9f8bf67c1604381bf056f907d77adaf301fad9cc7b9e1fb73660c1b66f3ebd9f", flavor: "lts" },
    // (checked against the published alpine-virt-3.24.0-aarch64.iso.sha256 on 2026-10-15)
    "aarch64-virt": { arch: "aarch64", name: "alpine-virt-3.24.0-aarch64.iso",
        sha256: "834469887c99227230e981cc8a5b66571f5eab98f12c6a675f9ea0dd640b7866", flavor: "virt" },
};

/** Where an architecture's images and their unpacked files are kept */
export function directory_of(arch)
{
    return ROOT + (arch === "x86_64" ? "build/x64-linux/" : "build/a64-linux/");
}

export const sha256 = bytes => create_hash("sha256").update(bytes).digest("hex");

/**
 * The image `key` of IMAGES, downloaded and checked, with `files` (paths in
 * the ISO; by default its kernel and initramfs) unpacked next to it:
 * { directory, iso, kernel, initrd, image, source }
 */
export async function prepare(key, files)
{
    const image = IMAGES[key];
    assert.ok(image, "no Alpine image " + key);
    const directory = directory_of(image.arch);
    const iso = directory + image.name;
    const source = RELEASES + image.arch + "/" + image.name;
    fs.mkdirSync(directory, { recursive: true });
    if(!fs.existsSync(iso))
    {
        const cached = process.env.ALPINE_CACHE && path.join(process.env.ALPINE_CACHE, image.name);
        let bytes;
        if(cached && fs.existsSync(cached))
        {
            bytes = fs.readFileSync(cached);
        }
        else
        {
            const response = await fetch(source);
            assert.ok(response.ok, `Alpine ISO ${image.name}: HTTP ${response.status}`);
            bytes = Buffer.from(await response.arrayBuffer());
        }
        assert.equal(sha256(bytes), image.sha256, "the pinned Alpine ISO's SHA-256: " + image.name);
        fs.writeFileSync(iso, bytes);
    }
    assert.equal(sha256(fs.readFileSync(iso)), image.sha256, "the pinned Alpine ISO's SHA-256: " + image.name);
    const kernel = `boot/vmlinuz-${image.flavor}`, initrd = `boot/initramfs-${image.flavor}`;
    for(const file of files || [kernel, initrd])
    {
        if(fs.existsSync(directory + file)) continue;
        const unpack = spawnSync("bsdtar", ["-xf", iso, "-C", directory, file], { encoding: "utf8" });
        assert.equal(unpack.status, 0, unpack.stderr);
    }
    return { directory, iso, kernel: directory + kernel, initrd: directory + initrd, image, source };
}

/**
 * The arm64 Image inside an EFI zboot image (Linux
 * drivers/firmware/efi/libstub/zboot-header.S: "MZ", "zimg" at 4, the
 * payload's offset at 8 and size at 12, the compression's name at 24), or
 * the bytes themselves when they are an Image already
 */
export function unzboot(bytes)
{
    const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const is_image = b => b.length >= 64 && b.readUInt32LE(56) === 0x644D5241; // "ARM\x64"
    if(is_image(view)) return view;
    assert.equal(view.toString("latin1", 0, 2), "MZ", "zboot: no MZ header");
    assert.equal(view.toString("latin1", 4, 8), "zimg", "zboot: no zimg magic");
    const offset = view.readUInt32LE(8), size = view.readUInt32LE(12);
    const compression = view.toString("latin1", 24, 56).replace(/\0.*$/s, "");
    assert.equal(compression, "gzip", "zboot: payload compression " + compression);
    const image = zlib.gunzipSync(view.subarray(offset, offset + size));
    assert.ok(is_image(image), "zboot: the payload is not an arm64 Image");
    return image;
}
