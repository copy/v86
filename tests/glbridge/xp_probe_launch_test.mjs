import assert from "node:assert/strict";
import { probe_launch_activity, probe_screen_changed, probe_run_scancodes } from "../lib/xp_probe_launch.mjs";
const frame = (width = 800, height = 600) => ({width, height, raw: new Uint8Array(height * (width * 3 + 1))});
const before = frame(), same = frame(), clock = frame(), consolePicture = frame();
clock.raw.fill(255, 560 * (800 * 3 + 1));
for (let y = 120; y < 420; ++y) consolePicture.raw.fill(255, y * 2401 + 301, y * 2401 + 1801);
assert.equal(probe_screen_changed(before, same), false);
assert.equal(probe_screen_changed(before, clock), false);
assert.equal(probe_screen_changed(before, consolePicture), true);
assert.equal(probe_screen_changed(before, frame(640, 480)), true);
assert.equal(probe_screen_changed(null, before), true);
assert.equal(probe_screen_changed(before, null), false);
const base = {launchBatches: 0, batches: 0, launchWrites: 4, writes: 4,
    result: "", logs: {"START.TXT": ""}, before, after: same};
assert(Object.values(probe_launch_activity(base)).every(v => !v));
for (const change of [{batches: 1}, {writes: 5}, {result: "START"},
    {logs: {"START.TXT": "START"}}, {after: consolePicture}])
    assert(Object.values(probe_launch_activity({...base, ...change})).some(Boolean));
assert.deepEqual(probe_run_scancodes("cmd /c"), [46,174,50,178,32,160,57,185,53,181,46,174]);
assert.deepEqual(probe_run_scancodes("%d:\\"), [42,6,134,170,32,160,42,39,167,170,43,171]);
assert.deepEqual(probe_run_scancodes("A"), [42,30,158,170]);
assert.deepEqual(probe_run_scancodes("()"), [42,10,138,170,42,11,139,170]);
assert.throws(() => probe_run_scancodes("cmd\n"), /US keyboard ASCII/);
assert.throws(() => probe_run_scancodes("中文"), /US keyboard ASCII/);
for (const text of ["cmd /c for %d in (d e f g h i j k) do @if exist %d:\\probe.cmd %d:\\probe.cmd",
    Array.from({length:95}, (_, i) => String.fromCharCode(i+32)).join("")])
{
    const pressed = new Set();
    for (const code of probe_run_scancodes(text))
    {
        if (code & 128) { assert(pressed.delete(code & 127)); }
        else { assert(!pressed.has(code)); pressed.add(code); }
    }
    assert.equal(pressed.size, 0);
}
console.log("PASS XP launch activity and paced Run scan codes: idle/window/disk/log guards, exact command punctuation, separate make/break and modifier release, unsupported input refusal");
