#!/usr/bin/env node
// The virt machine's device tree against the reference's
// (docs/arm64-virt-android16-plan.md P4.1): src/virt/dtb.js's tree and
// QEMU 9.2's dumpdtb for the same machine (1, 2 and 4 cores, a kernel
// command line and an initrd), both decompiled by dtc with sorted nodes and
// properties, must differ only by the allowed differences of
// tests/platform/a64-profile.json: the nodes of devices v86 does not have
// (flash, fw-cfg, PL061 and gpio-keys, the platform bus), the cores'
// compatible (v86 is no Cortex part) and /chosen/rng-seed (v86 writes one).
// The PCIe host bridge's node (P5.6) is the reference's.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { QEMU_MACHINE, QEMU_CPU, qemu_binary, smp, root } from "./guest_runner.mjs";
import { flatten, virt_tree } from "../../src/virt/dtb.js";

const directory = root + "build/a64-dtb/";
fs.mkdirSync(directory, { recursive: true });
const dts = file => execFileSync("dtc", ["-q", "-s", "-I", "dtb", "-O", "dts", file], { encoding: "utf8" });

/** Remove a node block (by its name's start) or a property line from dtc's output */
function without(text, { nodes = [], props = [] })
{
    const lines = text.split("\n");
    const out = [];
    for(let i = 0; i < lines.length; i++)
    {
        const line = lines[i];
        const name = line.trim().replace(/ \{$/, "");
        if(line.trim().endsWith("{") && nodes.some(n => name === n || name.startsWith(n + "@")))
        {
            let depth = 1;
            while(depth) { i++; depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length; }
            continue;
        }
        if(props.some(p => line.trim().startsWith(p + " =") || line.trim() === p + ";")) continue;
        out.push(line);
    }
    return out.join("\n").replace(/\n\n+/g, "\n\n");
}

const kernel = directory + "kernel.bin", initrd = directory + "initrd.bin";
// (a minimal Image the reference loads: the header and a branch to itself)
const image = Buffer.alloc(4096);
image.writeUInt32LE(0x14000000, 0);
image.writeUInt32LE(0x80000, 8);
image.writeUInt32LE(4096, 16);
image.writeUInt32LE(0x644D5241, 56);
fs.writeFileSync(kernel, image);
fs.writeFileSync(initrd, Buffer.alloc(300000, 7));
const memory = 512;
const bootargs = "console=ttyAMA0 earlycon rdinit=/a64-init";
let failed = 0;
for(const cores of [1, 2, 4])
{
    const reference = directory + `qemu-${cores}.dtb`;
    const r = spawnSync(qemu_binary(), ["-machine", QEMU_MACHINE + ",dumpdtb=" + reference, "-cpu", QEMU_CPU, "-m", memory + "M",
        "-smp", smp(cores), "-nodefaults", "-display", "none", "-kernel", kernel, "-initrd", initrd, "-append", bootargs], { encoding: "utf8" });
    assert.ok(fs.existsSync(reference), "QEMU dumpdtb: " + r.stderr);
    // (the reference's initrd: at RAM + min(RAM / 2, 128 MiB))
    const start = 0x40000000 + Math.min(memory / 2, 128) * 1024 * 1024;
    const ours = directory + `v86-${cores}.dtb`;
    fs.writeFileSync(ours, flatten(virt_tree({ cores, memory_size: memory << 20, bootargs, initrd: { start, end: start + 300000 },
        rng_seed: new Uint8Array(32) })));
    const allowed = { nodes: ["flash", "fw-cfg", "pl061", "gpio-keys", "platform-bus"], props: ["rng-seed", "compatible = \"arm,cortex-a35\"", "compatible = \"arm,armv8\""] };
    const want = without(dts(reference), allowed), have = without(dts(ours), allowed);
    fs.writeFileSync(directory + `qemu-${cores}.dts`, want);
    fs.writeFileSync(directory + `v86-${cores}.dts`, have);
    if(want === have)
    {
        console.log(`PASS ${cores} core(s): the device trees agree but for the allowed differences`);
    }
    else
    {
        failed++;
        const diff = spawnSync("diff", ["-u", directory + `qemu-${cores}.dts`, directory + `v86-${cores}.dts`], { encoding: "utf8" });
        console.log(`FAIL ${cores} core(s):\n${diff.stdout.slice(0, 3000)}`);
    }
}
process.exit(failed ? 1 : 0);
