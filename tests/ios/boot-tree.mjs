// Direct-boot metadata on a tiny independently constructed ARM Mach-O and
// device tree. No Apple code or images are part of this test.
import assert from "node:assert/strict";
import { load_n90_kernel } from "../../src/apple/boot.js";
import { dt_parse, dt_serialize, dt_find, dt_property, dt_cells } from "../../src/apple/devicetree.js";

const kernel = new Uint8Array(4096), k = new DataView(kernel.buffer);
const set = (at, ...words) => words.forEach((word, i) => k.setUint32(at + i * 4, word, true));
set(0, 0xfeedface, 12, 9, 2, 2, 56 + 84, 0);
set(28, 1, 56);
kernel.set(new TextEncoder().encode("__TEXT"), 36);
set(52, 0x80001000, 4096, 0, 4096, 7, 5, 0, 0);
set(84, 5, 84, 1, 17);
set(100 + 15 * 4, 0x80001800, 0x13);
const ascii = text => new TextEncoder().encode(text + "\0");
const cells = (...words) => {
    const bytes = new Uint8Array(words.length * 4), view = new DataView(bytes.buffer);
    words.forEach((word, i) => view.setUint32(i * 4, word, true)); return bytes;
};
const node = (name, properties = {}, children = []) => ({
    properties: Object.entries({ name: ascii(name), ...properties }).map(([name, value]) => ({ name, value, placeholder: false })), children,
});
function handoff(scale, clock = 0, calibration = new Uint8Array(40), install = false)
{
    const frequencies = new Uint8Array(256);
    new DataView(frequencies.buffer).setUint32(0x22 * 4, clock, true);
    const tree = node("device-tree", { compatible: ascii("N90AP") }, [
        node("chosen", scale === undefined ? {} : { "display-scale": cells(scale) }),
        node("cpus", {}, [node("cpu0")]), node("memory"), node("vram"), node("pram"),
        node("arm-io", { "clock-frequencies": frequencies }, [node("mipi-dsim", {}, [node("lcd", { "lcd-panel-id": cells(0) })]), node("spi2"),
            node("i2c2", {}, [node("accelerometer", { "accel-sensitivity-calibration": calibration }), node("inv-gyro")])]),
    ]);
    const ram = new Uint8Array(1 << 20), result = load_n90_kernel(ram, kernel, dt_serialize(tree), null, undefined, false, false, install);
    const args = result.r0 - 0x40000000, view = new DataView(ram.buffer);
    const start = view.getUint32(args + 0x30, true) - 0x80000000, length = view.getUint32(args + 0x34, true);
    assert.equal(result.entry, 0x40001800);
    if(install)
    {
        const arena = result.install_arena;
        assert.equal(arena.size, 128 << 10);
        assert.ok(view.getUint32(args + 16, true) >= arena.physical + arena.size);
        assert.equal(result.memory_end, view.getUint32(args + 16, true));
        assert.ok(ram.subarray(arena.physical - 0x40000000, arena.physical - 0x40000000 + arena.size).every(b => b === 0));
    }
    else assert.equal(result.install_arena, null);
    return dt_parse(ram.subarray(start, start + length));
}
for(const input of [undefined, 0, 1, 2, 3])
{
    const tree = handoff(input);
    assert.deepEqual(dt_cells(dt_property(dt_find(tree, "/chosen"), "display-scale").value), [input || 2]);
    assert.deepEqual(dt_cells(dt_property(dt_find(tree, "/arm-io/mipi-dsim/lcd"), "lcd-panel-id").value), [1]);
    assert.equal(dt_find(tree, "/arm-io/spi2"), null);
    const clocks = dt_cells(dt_property(dt_find(tree, "/arm-io"), "clock-frequencies").value);
    assert.equal(clocks[0x22], 100000000);
    assert.equal(clocks[0x2f], 24000000);
    assert.equal(clocks[0x30], 24000000);
    assert.deepEqual(dt_cells(dt_property(dt_find(tree, "/arm-io/i2c2/accelerometer"), "accel-sensitivity-calibration").value),
        [65536, 0, 0, 0, 65536, 0, 0, 0, 65536, 0]);
    assert.deepEqual(dt_cells(dt_property(dt_find(tree, "/arm-io/i2c2/inv-gyro"), "gyro-sensitivity-calibration").value),
        [65536, 0, 0, 0, 65536, 0, 0, 0, 65536, 0]);
}
const preserved = handoff(2, 123456789);
const installer = handoff(2, 0, undefined, true);
assert.deepEqual(dt_cells(dt_property(dt_find(installer, "/chosen"), "v86,install-service").value), [1]);
assert.equal(dt_property(dt_find(installer, "/chosen"), "v86,gles-backdoor"), null);
assert.equal(dt_cells(dt_property(dt_find(preserved, "/arm-io"), "clock-frequencies").value)[0x22], 123456789);
const calibration = cells(65537, 1, 0, -1, 65535, 0, 0, 0, 65536, 0);
assert.deepEqual(dt_property(dt_find(handoff(2, 0, calibration), "/arm-io/i2c2/accelerometer"),
    "accel-sensitivity-calibration").value, calibration);
console.log("PASS: N90 Retina scale, panel, SPI clocks and sensor calibration fill zero placeholders and preserve configured values");
