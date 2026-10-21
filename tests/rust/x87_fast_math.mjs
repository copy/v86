import assert from "node:assert/strict";
import fs from "node:fs";
const { instance } = await WebAssembly.instantiate(fs.readFileSync("build/softfloat-fast-test.wasm"));
const e = instance.exports;
const view = new DataView(new ArrayBuffer(8));
const bits = x => { view.setFloat64(0, x, true); return view.getBigUint64(0, true); };
const number = x => { view.setBigUint64(0, x, true); return view.getFloat64(0, true); };
const ops = [(a,b) => a+b, (a,b) => a-b, (a,b) => a*b, (a,b) => a/b];
const inputs = [0, -0, 1, -1, 1.5, 2 ** -53, 1 + 2 ** -52, Number.MIN_VALUE,
    2 ** -1022, Number.MAX_VALUE, Infinity, -Infinity, NaN];
e.set_x87_fast_math(1);
for(const precision of [32, 64, 80]) for(let rounding = 0; rounding < 4; rounding++) {
    for(let op = 0; op < 4; op++) {
        for(const a of inputs) for(const b of inputs) {
            const expected = ops[op](a, b);
            const actual = BigInt.asUintN(64, e.fast_math_result(op, bits(a), bits(b), precision, rounding));
            if(Number.isNaN(expected)) assert(Number.isNaN(number(actual)));
            else assert.equal(actual, bits(expected), `op=${op}, p=${precision}, r=${rounding}, a=${a}, b=${b}`);
        }
    }
}
e.set_x87_fast_math(0);
assert.notEqual(e.fast_math_result(0, bits(1), bits(2 ** -53), 64, 3), bits(1),
    "compatible mode still honors upward arithmetic rounding");
e.set_x87_fast_math(1);
assert.equal(e.fast_math_result(0, bits(1), bits(2 ** -53), 64, 3), bits(1));
console.log("PASS: native f64 results for all four operators/all 12 modes, specials and mode switching");
const times = [[], []], checksums = [null, null];
for(let round = 0; round < 7; round++) for(const fast of round & 1 ? [1, 0] : [0, 1]) {
    const start = performance.now();
    checksums[fast] = e.benchmark_fast_math(fast, 8192);
    const ms = performance.now() - start;
    if(round >= 2) times[fast].push(ms);
}
assert.equal(checksums[0], checksums[1], "bounded recurrence has identical final values");
const median = a => a.sort((a,b) => a-b)[a.length >> 1];
const compatible = median(times[0]), fast = median(times[1]);
console.log(JSON.stringify({ benchmark: "bounded F80 Mandelbrot-style recurrence",
    points: 8192, iterations_per_point: 32, compatible_ms: compatible, fast_f64_ms: fast, speedup: compatible / fast }));
