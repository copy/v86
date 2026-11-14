import assert from "node:assert/strict";
import { AppleCDMA } from "../../src/apple/cdma.js";

const ports = new Map(), signals = [];
const dma = new AppleCDMA({ io: { register_mmio: (base, size, port) => ports.set(base, port) } },
    (channel, level) => signals.push([channel, level]));
const port = ports.get(0x87000000), base = 26 * 0x1000, index = 26 * 8;
let kicks = 0;
dma.ports.set(0x84500410, () => kicks++);
port.write(base + 8, 4, 0x84500410);
port.write(base + 12, 4, 0x40000000);
port.write(base + 20, 4, 0x41000000);
port.write(base + 16, 4, 0x42000080);
port.write(base, 4, 0x19);
const position = [[[0x42000000, 8192]], 0, 128];
dma.progress.set(26, position);

// AppleCDMA's native stop: set PAUSE, wait for bit 21, then reset.
port.write(base, 4, Number(port.read(base)) | 4);
assert.ok(port.read(base) & 0x200000, "native stop loop observes PAUSED");
assert.equal(port.read(base) & 0x1c0000, 0, "pause fabricates no success/error completion");
assert.equal(port.read(base + 12), 0x40000000, "unconsumed data remains pending");
assert.equal(port.read(base + 20), 0x41000000);
assert.equal(port.read(base) & 1, 0, "stopped channel cannot consume further peripheral data");
assert.equal(dma.progress.get(26), position);
assert.equal(kicks, 1, "pause starts no new peripheral work");
assert.ok(signals.every(([, level]) => !level), "pause raises no transfer completion interrupt");

port.write(base, 4, 0x19);
assert.equal(port.read(base) & 0x200000, 0);
assert.equal(dma.progress.get(26), position, "resume keeps a partially consumed descriptor");
assert.equal(kicks, 2);
port.write(base, 4, 0x1d);
port.write(base, 4, 2);
assert.equal(port.read(base), 0);
assert.equal(port.read(base + 12), 0);
assert.equal(port.read(base + 16), 0x42000080, "native abort retirement retains MAR after reset");
assert.equal(port.read(base + 20), 0x41000000, "native abort retirement retains its descriptor after reset");
assert.equal(dma.progress.has(26), false);
console.log("PASS: native audio CDMA pause/reset and lossless descriptor resume");
