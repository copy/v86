// Assemble an independent debug ramdisk from the owner's 10B329 restore
// volume. Keep launchd's existing catalog record, allocation and resource
// map. Its type-4 decmpfs resource has ample space for the static shell.
import assert from "node:assert/strict";
import fs from "node:fs";
import { deflateSync } from "node:zlib";
import { HFSPlus } from "../../src/ios/hfsplus.js";
import { macho_parse, CPU_TYPE_ARM } from "../../src/apple/macho.js";

const [source, program, output] = process.argv.slice(2);
if(!output) throw new Error("usage: recovery-ramdisk.mjs restore.dmg recovery-shell new-output.dmg");
const image = fs.readFileSync(source), shell = fs.readFileSync(program);
const executable = macho_parse(shell);
if(executable.is64 || executable.cputype !== CPU_TYPE_ARM || !executable.entry || shell.length > 65536)
    throw new Error("expected a static ARM shell of at most 64 KiB");
const open = () => new HFSPlus((at, size) => image.subarray(at, at + size)).open();
const volume = await open();
const file = await volume.lookup("/sbin/launchd");
if(!file?.compressed) throw new Error("missing compressed launchd");
const attr = Buffer.from(await volume.attribute(file.id, "com.apple.decmpfs"));
assert.equal(attr.readUInt32LE(4), 4, "resource-fork compression");
assert.equal(attr.length, 16);
function forkBytes(fork)
{
    assert.equal(fork.extents.length, 1, "expected a contiguous 10B329 fork");
    const e = fork.extents[0], start = e.start * volume.block_size;
    assert.ok(e.count * volume.block_size >= fork.size && start + fork.size <= image.length);
    return image.subarray(start, start + fork.size);
}
// Locate this file's inline attribute record within the attributes B-tree.
// Match the catalog ID, start block and UTF-16BE name as well as the value.
const name = Buffer.from("com.apple.decmpfs", "utf16le").swap16();
const record = Buffer.alloc(14 + name.length + 16 + attr.length);
record.writeUInt16BE(12 + name.length);
record.writeUInt32BE(file.id, 4);
record.writeUInt16BE(name.length / 2, 12);
name.copy(record, 14);
record.writeUInt32BE(0x10, 14 + name.length);
record.writeUInt32BE(attr.length, 26 + name.length);
attr.copy(record, 30 + name.length);
const attributes = forkBytes(volume.forks[8]), index = attributes.indexOf(record);
assert.ok(index >= 0 && attributes.indexOf(record, index + 1) < 0, "unique launchd attribute");
const resource = forkBytes(file.resource);
const data = resource.readUInt32BE(0), table = data + 4;
const capacity = resource.readUInt32BE(data);
const compressed = deflateSync(shell);
assert.ok(table + capacity <= resource.length && compressed.length + 12 <= capacity);
resource.fill(0, table, table + capacity);
resource.writeUInt32LE(1, table);
resource.writeUInt32LE(12, table + 4);
resource.writeUInt32LE(compressed.length, table + 8);
compressed.copy(resource, table + 12);
attributes.writeBigUInt64LE(BigInt(shell.length), index + record.length - 8);
const check = await open();
assert.deepEqual(Buffer.from(await check.contents(await check.lookup("/sbin/launchd"))), shell);
fs.writeFileSync(output, image, { flag: "wx" });
console.log("Verified recovery shell in " + output);
