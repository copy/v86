#!/usr/bin/env node
// Independent checks of the pointer/layout rules consumed by nouveau's BIOS parser.
import assert from "node:assert/strict";
import fs from "node:fs";
const rom = fs.readFileSync(new URL("../../bios/vgabios-geforce6800.bin", import.meta.url));
const word = n => rom.readUInt16LE(n), dword = n => rom.readUInt32LE(n);
const sum = bytes => bytes.reduce((a, b) => a + b, 0) & 255;
assert.equal(word(0), 0xAA55);
assert.equal(rom.length, rom[2] * 512);
assert.equal(sum(rom), 0);
const pcir = word(0x18);
assert.equal(rom.toString("ascii", pcir, pcir + 4), "PCIR");
assert.equal(word(pcir + 4), 0x10DE);
assert.equal(word(pcir + 6), 0x0045);
assert.equal(word(pcir + 16) * 512, rom.length);
const bit = rom.indexOf(Buffer.from([255, 184, 66, 73, 84, 0]));
assert(bit > 0);
assert.equal(word(bit + 6), 0x100);
assert.equal(rom[bit + 8], 12);
assert.equal(rom[bit + 9], 6);
assert.equal(sum(rom.subarray(bit, bit + rom[bit + 8])), 0);
const entries = new Map();
for(let i = 0; i < rom[bit + 10]; i++)
{
    const at = bit + 12 + i * rom[bit + 9], size = word(at + 2), offset = word(at + 4);
    assert(offset > 0 && offset + size <= rom.length);
    entries.set(String.fromCharCode(rom[at]), { version: rom[at + 1], size, offset });
}
assert.equal(rom[entries.get("i").offset + 3], 5);
assert.equal(rom[word(word(entries.get("I").offset))], 0x71, "terminating initialization script");
const limits = word(entries.get("C").offset + 8);
assert.equal(rom[limits], 0x20); assert.equal(rom[limits + 1], 4); assert.equal(rom[limits + 2], 35); assert.equal(rom[limits + 3], 4);
for(const [i, address] of [0x4000, 0x4020, 0x680508, 0x680520].entries())
{
    const at = limits + 4 + i * 35;
    assert.equal(dword(at), address); assert.equal(word(at + 4), 100); assert.equal(word(at + 6), 500);
    assert.equal(rom[at + 22], 1); assert.equal(rom[at + 23], 31); assert.equal(dword(at + 31), 13500);
}
const dcb = word(0x36);
assert.equal(rom[dcb], 0x30);
assert.equal(rom[dcb + 1], 10);
assert.equal(rom[dcb + 2], 1);
assert.equal(rom[dcb + 3], 8);
assert.equal(dword(dcb + 6), 0x4EDCBDCB);
const connection = dword(dcb + 10);
assert.equal(connection & 15, 0, "analog CRT");
assert.equal(connection >>> 8 & 15, 1, "head 0 only");
assert.equal(connection >>> 4 & 15, 0, "DDC bus 0");
const i2c = word(dcb + 4);
assert.deepEqual([...rom.subarray(i2c, i2c + 8)], [0x30, 4, 1, 4, 0x3E, 0x3E, 0, 0]);
console.log("PASS: NV40 ROM and BIT checksums, PCI ID, initialization, DCB and I2C pointers");
