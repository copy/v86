#!/usr/bin/env node
// Preserve actual Microsoft software raster images for clipped processed VBs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync as run } from "node:child_process";
import { fileURLToPath as file_url_to_path } from "node:url";
import { site_directory } from "../lib/site.mjs";
import { run_xp_ram_probe } from "../lib/xp_ram_probe.mjs";
const root = file_url_to_path(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D9WG_NATIVE_CLIP_DRAW_OUT || root + "build/d3d-review/native-clip-draw");
fs.mkdirSync(out, { recursive: true });
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror",
    "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/CLIP.EXE",
    site + "/glbridge/sample/d3d7_native_clip_draw_reference.c", "-luser32", "-lkernel32", "-ldxguid"], { stdio: "pipe" });
const binary_files = Array.from({ length: 6 }, (_, scene) => [0, 1, 2].map(processed => "S" + scene + "P" + processed + ".BIN")).flat();
const result = await run_xp_ram_probe({ root, out,
    files: { "CLIP.EXE": fs.readFileSync(out + "/CLIP.EXE"), "PROBE.CMD": Buffer.from("@echo off\r\n%~d0\\CLIP.EXE\r\n"),
        ...Object.fromEntries(binary_files.map(name => [name, Buffer.alloc(128*128*4)])) },
    image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img",
    result_file: "CLIP.TXT", success: "PASS native clipped primitive images", log_files: ["CLIP.TXT"], binary_files,
    rendering: "original Microsoft DDraw7 RGB software rasterizer; full surface images saved",
    inspect(result) {
        assert.equal(result.batches, 0);assert.equal(result.owners.length, 0);
        assert.equal(result.text.split(/\r?\n/).filter(line => line.startsWith("VERTEX ")).length, 18);
        assert.equal(result.text.split(/\r?\n/).filter(line => line.startsWith("IMAGE ")).length, 18);
        for(const item of Object.values(result.artifacts)) assert.equal(item.bytes, 128*128*4);
    } });
const comparisons = [];
for(let scene = 0; scene < 6; scene++)
{
    const direct = fs.readFileSync(out + "/S" + scene + "P0.BIN"), processed = fs.readFileSync(out + "/S" + scene + "P1.BIN");
    let differing_pixels = 0, maximum_byte_error = 0, direct_coverage = 0, processed_coverage = 0;
    for(let y = 11; y < 91; y++) for(let x = 7; x < 107; x++)
    {
        const at = (y*128 + x)*4;let different = false;
        for(let c = 0; c < 3; c++)
        {
            const error = Math.abs(direct[at + c] - processed[at + c]);
            maximum_byte_error = Math.max(maximum_byte_error, error);different ||= error !== 0;
        }
        differing_pixels += different;
        const covered = bytes => bytes[at] !== 0x30 || bytes[at + 1] !== 0x20 || bytes[at + 2] !== 0x10;
        direct_coverage += covered(direct);processed_coverage += covered(processed);
    }
    assert(direct_coverage > 100 && processed_coverage > 100, "empty native scene " + scene);
    assert.deepEqual(fs.readFileSync(out + "/S" + scene + "P2.BIN"), processed,
        "indexed and ordinary native VB drawing differ in scene " + scene);
    comparisons.push({ scene, differing_pixels, maximum_byte_error, direct_coverage, processed_coverage });
}
fs.writeFileSync(out + "/comparisons.json", JSON.stringify(comparisons, null, 2) + "\n");
console.log(JSON.stringify({ status: result.status, seconds: result.seconds, comparisons }));
