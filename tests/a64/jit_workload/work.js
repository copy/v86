// The guest JIT workload's V8 part (tests/a64/linux_boot.mjs, A64_WORKLOAD=jit;
// docs/arm64-virt-android16-plan.md P6.7): calls, numbers, objects, strings,
// regular expressions and typed arrays, hot enough for V8's tiers; a
// checksum that only depends on exact arithmetic
let h = 0x811c9dc5;
const mix = x => { h = Math.imul(h ^ (x | 0), 16777619) >>> 0; };
function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
mix(fib(24));
let s = 0;
for(let i = 1; i < 3000000; i++) s = (s * 31 + i) % 1000000007;
mix(s);
const counts = {};
for(let i = 0; i < 100000; i++) counts["k" + i % 997] = (counts["k" + i % 997] | 0) + i;
const json = JSON.stringify(counts);
mix(json.length);
for(let i = 0; i < json.length; i += 7) mix(json.charCodeAt(i));
const words = [];
for(let i = 0; i < 20000; i++) words.push((Math.imul(i, 2654435761) >>> 0).toString(16) + "-" + i);
let matches = 0;
for(const m of words.join(" ").matchAll(/([a-f]+)\d*-(\d+)/g)) matches += m[1].length + Number(m[2]) % 7;
mix(matches);
const a = new Float64Array(50000);
for(let i = 0; i < a.length; i++) a[i] = Math.sqrt(i) / (1 + i % 13);
let f = 0;
for(let k = 0; k < 20; k++) for(let i = 0; i < a.length; i++) f += a[i] * (k + 1);
console.log(`node ${h.toString(16)} ${s} ${json.length} ${matches} ${f.toPrecision(15)}`);
