#!/usr/bin/env node

// The disks' disk_option, disk_error and token (docs/disk-persistence-plan.md
// "启动校验"): each rule refuses the machine when it is created, with the
// disk and the reason; the CPU Worker gets the options with the descriptor.

import assert from "node:assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const { check_disk_bindings, check_disk_policy } = await import("../../src/disk_options.js");
const { encode_worker_file } = await import("../../src/browser/cpu_worker.js");

const bios = { url: __dirname + "/../../bios/seabios.bin" };
const vga_bios = { url: __dirname + "/../../bios/vgabios.bin" };
const image = () => new ArrayBuffer(1 << 20);
const refused = (options, pattern, what) =>
    assert.throws(() => new V86({ bios, vga_bios, graphics_adapter: "none", autostart: false, ...options }), pattern, what);

// not in the V86 options themselves
refused({ hda: { buffer: image() }, disk_option: "read_write" }, /disk_option is an option of each disk/, "disk_option at the top");
refused({ hda: { buffer: image() }, disk_error: "report" }, /disk_error is an option of each disk/, "disk_error at the top");
refused({ hda: { buffer: image() }, token: "x" }, /token is an option of each disk/, "token at the top");
console.log("ok - disk_option, disk_error and token are refused in the V86 options");

// values
refused({ hda: { buffer: image(), disk_option: "rw" } }, /hda: disk_option "rw" is not one of read_only, read_write/);
refused({ hda: { buffer: image(), disk_error: "ignore" } }, /hda: disk_error "ignore" is not one of stop, report/);
refused({ hda: { buffer: image(), token: 42 } }, /hda: token must be a string/);
console.log("ok - unknown values are refused");

// where they apply
refused({ cdrom: { buffer: image(), disk_option: "read_only" } }, /cdrom: disk_option is for disks/);
refused({ hda: { buffer: image() }, bios: { ...bios, disk_option: "read_only" } }, /bios: disk_option is for disks/);
refused({ hda: { buffer: image() }, initial_state: { url: "x", disk_error: "stop" } }, /initial_state: disk_error is for disks and CD drives/);
refused({ hda: { buffer: image() }, bzimage: { url: "x", token: "t" } }, /bzimage: token is for disks/);
refused({ fda: { buffer: image(), disk_option: "read_write" } }, /fda: an ArrayBuffer is an image in memory/, "read_write on a floppy: as for disks");
assert.deepEqual(check_disk_policy("fda", { buffer: image(), disk_option: "read_only" }), { disk_option: "read_only", disk_error: "stop" },
    "read_only on a floppy: as without it; a floppy's errors stop the machine, as a disk's");
assert.deepEqual(check_disk_policy("fdb", { buffer: image(), disk_error: "stop" }), { disk_option: "read_only", disk_error: "stop" },
    "disk_error on a floppy");
assert.deepEqual(check_disk_policy("fdb", { url: "/images/a.img", disk_option: "read_write", disk_error: "report" }), { disk_option: "read_write", disk_error: "report" },
    "a floppy written back (D3)");
assert.deepEqual(check_disk_policy("cdrom", { buffer: image(), disk_error: "report" }), { disk_option: "read_only", disk_error: "report" },
    "disk_error on a CD drive");
console.log("ok - disk_option is for hard disks and floppies, disk_error for hard disks, floppies and CD drives, neither for the other files");

// read_write: the sources that cannot be written back
refused({ hda: { buffer: image(), disk_option: "read_write" } }, /hda: an ArrayBuffer is an image in memory, with no persistent source/);
refused({ hda: { buffer: new File([new Uint8Array(512)], "disk.img"), disk_option: "read_write" } }, /hda: a File cannot be written back/);
refused({ hda: { url: "disk.img", use_parts: true, fixed_chunk_size: 512, size: 1 << 20, disk_option: "read_write" } },
    /hda: an image in parts \(use_parts, \.zst\) can only be read/);
refused({ hda: { url: "/nonexistent/disk.img", async: true, size: 1 << 20, disk_option: "read_write", format: "qcow2" } },
    /hda: disk_option "read_write" is for RAW images/);
assert.throws(() => new V86({ cpu_type: "arm64", graphics_adapter: "none", autostart: false, wasm_path: "x",
    virtio_disks: [{ buffer: image(), readonly: true, disk_option: "read_write" }] }),
    /virtio_disk0: disk_option "read_write" and readonly: the guest cannot write the disk/);
class OwnBuffer
{
    constructor() { this.byteLength = 1 << 20; this.disk_option = "read_write"; }
    load() {}
    get() {}
    set() {}
}
refused({ hda: new OwnBuffer() }, /hda: a buffer object of one's own is written back only when it implements the backend contract .*; it has no flush, close, mark, generation, get_state, set_state, check_state/);
console.log("ok - read_write: an ArrayBuffer, a File, an image in parts, a container format, a write-protected disk, a buffer object without the backend contract are refused");

// an image bound twice, one of them read_write
const rw = { disk_option: "read_write", disk_error: "stop" }, ro = { disk_option: "read_only", disk_error: "stop" };
assert.throws(() => check_disk_bindings([["hda", { url: "/images/a.img" }, rw], ["hdb", { url: "/images/a.img" }, ro]]),
    /hda and hdb are the same image, and one of them has disk_option "read_write"/);
assert.throws(() => check_disk_bindings([["sata3", { url: "/images/a.img" }, rw]], [["hda", { url: "/images/a.img" }]]),
    /hda and sata3 are the same image/, "with a disk attached before");
const shared = image();
assert.doesNotThrow(() => check_disk_bindings([["hda", { buffer: shared }, ro], ["hdb", { buffer: shared }, ro]]), "read_only twice");
assert.doesNotThrow(() => check_disk_bindings([["hda", { url: "/images/a.img" }, rw], ["hdb", { url: "/images/b.img" }, ro]]));
console.log("ok - an image bound to two disks with one of them read_write is refused");

// a browser disk (docs/vm-manager-plan.md U6) is in a browser's private storage: not in Node, read only or read write
refused({ hda: { url: "opfs:v86/disks/x.img", disk_option: "read_write" } }, /hda: a browser disk \(opfs:v86\/disks\/x\.img\) is in a browser's private storage \(OPFS\), not in Node/);
refused({ cdrom: { url: "opfs:v86/disks/x.img" } }, /cdrom: a browser disk .* not in Node/);
assert.throws(() => check_disk_policy("fda", { url: "opfs:v86/disks/f.img" }), /fda: a browser disk .* not in Node/);
console.log("ok - a browser disk (opfs:) is refused in Node");

// the CPU Worker gets them
assert.deepEqual((({ disk_option, disk_error, token }) => ({ disk_option, disk_error, token }))(
    encode_worker_file({ buffer: image(), disk_option: "read_only", disk_error: "report", token: "secret" })),
    { disk_option: "read_only", disk_error: "report", token: "secret" });
console.log("ok - the CPU Worker's descriptor has disk_option, disk_error and token");

// and a disk whose options are fine starts, its policy on its buffer
const emulator = new V86({ bios, vga_bios, graphics_adapter: "bochs_vga", autostart: false, log_level: 0, hda: { buffer: image(), disk_error: "report" }, cdrom: { buffer: image() } });
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
const ide = emulator.v86.cpu.devices.ide;
assert.equal(ide.primary.master.buffer.disk_name, "hda");
assert.equal(ide.primary.master.buffer.disk_error, "report");
assert.equal(ide.secondary.master.buffer.disk_name, "cdrom");
assert.equal(ide.secondary.master.buffer.disk_error, "stop", "the default");
await emulator.destroy();
console.log("ok - the policy reaches the disk");
console.log("disk option tests passed");
