import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { install_hashes, install_allowlist, validate_install_state, initial_install_state, stage_install_trust,
    finish_install_trust, reset_install_trust } from "../../src/ios/install_trust.js";
import { n90_kernel_baseline, n90_kernel_hashes, n90_trust_kernel, N90_TRUST_CAPACITY } from "../../src/ios/guest_load.js";
import { write_nand_boot, read_nand_boot } from "../../src/ios/nand_boot.js";
import { NAND_SLOT, nand_offset } from "../../src/apple/nand_geometry.js";

const hash = n => n.toString(16).padStart(40, "0");
const state = () => ({ format: "v86-ios-install-state", version: 1, build: "10B329", generation: 1, token: "b".repeat(64),
    system_hashes: [hash(1)], apps: [{ bundle_id: "org.v86.Old", version: "1", hashes: [hash(2)] }],
    pending: { install_id: "fixture-1", bundle_id: "org.v86.New", version: "1", prepared_sha256: "a".repeat(64), hashes: [hash(3)] } });
test("application trust scopes native installation separately from system code", () => {
    const s = state(); assert.deepEqual(install_hashes(s), [hash(1), hash(2), hash(3)]);
    const list = install_allowlist(s), v = new DataView(list.buffer);
    assert.equal(v.getUint32(8, true), 2); assert.equal(list.length, 52);
    const installed = finish_install_trust(s, true); assert.equal(installed.apps.length, 2); assert.equal(installed.pending, null);
    assert.deepEqual(finish_install_trust(s, false).apps, s.apps);
    assert.ok(s.pending, "finishing must not mutate the persisted input");
});
test("application trust rejects unsupported states, duplicates and capacity overflow", () => {
    assert.throws(() => validate_install_state({ ...state(), generation: 0 }), /invalid/);
    assert.throws(() => validate_install_state({ ...state(), build: "other" }), /unsupported/);
    assert.throws(() => validate_install_state({ ...state(), apps: [state().apps[0], state().apps[0]] }), /duplicate/);
    assert.throws(() => validate_install_state({ ...state(), system_hashes: ["not a hash"] }), /hashes/);
    const s = state(); s.system_hashes = Array.from({ length: N90_TRUST_CAPACITY }, (_, i) => hash(i + 10));
    assert.throws(() => install_hashes(s), /capacity/);
});

test("local 10B329 kernel: reversible trust, immutable Buffer input, atomic boot banks and reset", {
    skip: !process.env.IPHONE4_TRUST_KERNEL,
}, async () => {
    const kernel = fs.readFileSync(process.env.IPHONE4_TRUST_KERNEL), original = Buffer.from(kernel);
    const base = n90_kernel_baseline(kernel), hashes = n90_kernel_hashes(kernel);
    assert.deepEqual(kernel, original); assert.ok(hashes.length);
    assert.deepEqual(n90_kernel_baseline(n90_trust_kernel(kernel, hashes)), base);
    const initial = initial_install_state(kernel);
    const manifest = { format: "v86-ios-install", format_version: 1, architecture: "armv7", bundle_id: "org.v86.New", version: "1",
        prepared_sha256: "a".repeat(64), trusted: [{ cdhashes: [hash(9)] }] };
    const staged = stage_install_trust(kernel, initial, manifest, "fixture-1");
    assert.equal(staged.state.generation, 2); assert.equal(n90_kernel_hashes(staged.kernel).length, hashes.length + 1);
    const slots = new Map(), puts = [];
    const put = (bus, ce, row, bytes) => {
        const slot = new Uint8Array(NAND_SLOT); slot.set(bytes.map(b => ~b));
        const at = nand_offset(bus, ce, row); slots.set(at, slot); puts.push(at);
    };
    const read = (at, n) => {
        const result = new Uint8Array(n);
        for(let i = 0; i < n; i += NAND_SLOT) if(slots.has(at + i)) result.set(slots.get(at + i), i);
        return result;
    };
    write_nand_boot(put, kernel, Uint8Array.of(1), undefined, undefined, initial);
    const oldCommit = puts.at(-1);
    assert.equal((await read_nand_boot(read)).install.generation, 1);
    let count = 0;
    assert.throws(() => write_nand_boot((...args) => { if(++count === 10) throw new Error("power loss"); put(...args); },
        staged.kernel, Uint8Array.of(1), undefined, undefined, staged.state), /power loss/);
    assert.equal((await read_nand_boot(read)).install.generation, 1, "torn inactive bank preserves the previous commit");
    write_nand_boot(put, staged.kernel, Uint8Array.of(1), undefined, undefined, staged.state);
    assert.notEqual(puts.at(-1), oldCommit);
    assert.equal((await read_nand_boot(read)).install.generation, 2);
    slots.get(puts.at(-1))[192] ^= 1;
    assert.equal((await read_nand_boot(read)).install.generation, 1, "corrupt commit falls back");
    const reset = reset_install_trust(staged.kernel, staged.state);
    assert.deepEqual(n90_kernel_hashes(reset.kernel), hashes);
    assert.equal(reset.state.apps.length, 0); assert.equal(reset.state.pending, null);
});
