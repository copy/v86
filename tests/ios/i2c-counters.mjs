import assert from "node:assert/strict";
import fs from "node:fs";
import { n90_i2c_counters } from "../../src/apple/n90_compat.js";
import { build32, actual32, root } from "../a32/runner.mjs";

const ram = new Uint8Array(8 << 20), kernel = { uuid: "3bfc23e42eb53dad9d909e79ac235537" };
ram.set([0x05,0x22,0xe8,0xb2,0x88,0x42,0xf1,0xd3], 0x74ef8a);
ram.set([0x48,0x55,0xf5,0xb2,0xd4,0xf8,0x98,0], 0x74f038);
const original = ram.slice();
assert.equal(n90_i2c_counters(ram, { uuid: "unknown" }), 0);
assert.deepEqual(ram, original);
const broken = ram.slice(); broken[0x74f03c] ^= 1;
const before = broken.slice();
assert.throws(() => n90_i2c_counters(broken, kernel), /Unexpected/);
assert.deepEqual(broken, before, "all sites checked before mutation");
assert.equal(n90_i2c_counters(ram, kernel), 2);
assert.equal(n90_i2c_counters(ram, kernel), 2, "idempotent RAM application");
assert.equal(new DataView(ram.buffer).getUint16(0x74ef8c, true), 0x4628);
assert.equal(new DataView(ram.buffer).getUint16(0x74f03a, true), 0x4635);

// Run the replacement instruction in a real Thumb loop in the ARM core.
// Bound the old byte counter to demonstrate its wrap without hanging a test.
const dir = root + "build/ios/i2c-counters/"; fs.mkdirSync(dir, { recursive: true });
const source = dir + "counter.c";
fs.writeFileSync(source, `#include <stdio.h>
static unsigned loop(unsigned length, int byte) {
    unsigned index=0, iterations=0;
    while(index<length && iterations<600) {
        unsigned next=index+1;
        if(byte) __asm__("uxtb %0,%1" : "=r"(index) : "r"(next));
        else __asm__("mov %0,%1" : "=r"(index) : "r"(next));
        iterations++;
    }
    return iterations;
}
int main(void) {
    if(loop(255,1)!=255 || loop(256,1)!=600) return 1;
    if(loop(1,0)!=1 || loop(255,0)!=255 || loop(256,0)!=256 || loop(512,0)!=512) return 2;
    puts("full FIFO counters terminate without dropping bytes"); return 0;
}`);
const elf = build32("ios-i2c-counter", [source], { cflags: ["-mthumb"] });
const result = await actual32(elf, { timeout: 30000 });
assert.equal(result.status, "ok", result.text);
assert.match(result.text, /without dropping bytes/);
console.log("PASS: guarded 10B329 FIFO counter repair, atomic rejection and actual Thumb 255/256/512-byte loops");
