import assert from "node:assert/strict";
import { AppleDART } from "../../src/apple/dart.js";
import { AppleCLCD, N90_VIDEO } from "../../src/apple/clcd.js";

const length = N90_VIDEO.stride * N90_VIDEO.height, count = length / 4096;
const ram = new Uint8Array(length + 0x2000), view = new DataView(ram.buffer), ports = new Map();
const cpu = {
    mem8: ram,
    ram_offset: (address, size) => address >= 0x40000000 && address + size <= 0x40000000 + ram.length ? address - 0x40000000 : -1,
    write_blob_physical: (bytes, address) => ram.set(bytes, address - 0x40000000),
    io: { register_mmio: (address, size, port) => ports.set(address, port) },
};
const dart = new AppleDART(cpu, "dart2", 0x89D00000);
const physical = page => 0x40002000 + (count - page - 1) * 4096;
for(let i = 0; i < count; i++) view.setUint32((i + 1) * 4, physical(i) | 1, true);
dart.write(8, 0x40000001); dart.write(0, 0x105);
assert.equal(dart.translate(0x1000, 1), physical(0));
assert.equal(dart.translate(0x1000 + length - 1, 1), physical(count - 1) + 4095);
assert.equal(dart.translate(0x1000, 0), -1, "streams have separate tables");
assert.equal(dart.translate(0, 1), -1, "an invalid page is not DMA memory");
assert.equal(dart.translate(0x10000000, 1), -1);
view.setUint32(0x1000, physical(0) | 1, true);
dart.write(8, 0x40001001); dart.write(0, 0x400105);
assert.equal(dart.translate(0x400000, 1), physical(0));
dart.write(0, 0x104); assert.equal(dart.regs[2], 0x40000001);
const saved = dart.get_state(); dart.reset(); dart.set_state(saved);
assert.equal(dart.translate(0x400000, 1), physical(0));
console.log("PASS: DART stream/segment table programming, readback, page validity and snapshots");

let pixels;
const panel = new AppleCLCD(cpu, { add_source() {}, set_mode() {}, set_size_graphical() {},
    update_buffer: updates => pixels = updates[0].pixels.data }, { set_line() {} });
panel.translate = address => dart.translate(address, 1);
ports.get(0x89000000).write(0x4044, 4, 0x1000);
view.setUint32(physical(0) - 0x40000000, 0x00112233, true);
view.setUint32(physical(count - 1) - 0x40000000 + 4092, 0x00445566, true);
panel.render();
assert.deepEqual([...pixels.slice(0, 4)], [0x11, 0x22, 0x33, 255]);
assert.deepEqual([...pixels.slice(-4)], [0x44, 0x55, 0x66, 255]);
const rgba = new Uint8Array(length); rgba.set([1, 2, 3, 255]); rgba.set([4, 5, 6, 255], length - 4);
panel.present(rgba, 640, 960);
assert.deepEqual([...ram.slice(physical(0) - 0x40000000, physical(0) - 0x40000000 + 4)], [3, 2, 1, 0]);
assert.deepEqual([...ram.slice(0x2FFC, 0x3000)], [6, 5, 4, 0]);
view.setUint32(count * 4, 4, true);
rgba.set([9, 9, 9, 255]); panel.present(rgba, 640, 960);
assert.equal(ram[physical(0) - 0x40000000], 3, "unmapped scanout rejects publication before writing any page");
dart.set_state(saved.slice(0, 1)); assert.equal(dart.translate(0x1000, 1), -1);
console.log("PASS: CLCD reads and publishes complete pixels through noncontiguous DART pages; invalid mappings reject writes");
