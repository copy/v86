#!/usr/bin/env node
// Original system Microsoft DDraw7 RGB processing/raster reference in real XP.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync as run } from "node:child_process";
import { fileURLToPath as file_url_to_path } from "node:url";
import { site_directory } from "../lib/site.mjs";
import { run_xp_ram_probe } from "../lib/xp_ram_probe.mjs";
const root = file_url_to_path(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D9WG_NATIVE_PROCESS_OUT || root + "build/d3d-review/native-process-reference");
fs.mkdirSync(out, { recursive: true });
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror",
    "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/CLIP.EXE",
    site + "/glbridge/sample/d3d7_native_process_reference.c", "-luser32", "-lkernel32", "-ldxguid"], { stdio: "pipe" });
const files = { "CLIP.EXE": fs.readFileSync(out + "/CLIP.EXE"),
    "PROBE.CMD": Buffer.from("@echo off\r\n%~d0\\CLIP.EXE\r\n") };
const result = await run_xp_ram_probe({ root, out, files,
    image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img",
    result_file: "CLIP.TXT", success: "PASS native clipping reference finished", log_files: ["CLIP.TXT"],
    inspect(result) {
        assert(result.text.includes("PASS native clipping reference available"));
        assert.equal(result.batches, 0);assert.equal(result.owners.length, 0);
        const results = result.text.split(/\r?\n/).filter(line => line.startsWith("RESULT "));
        const depths = result.text.split(/\r?\n/).filter(line => line.startsWith("DEPTH "));
        assert.equal(results.length, 252);assert.equal(depths.length, 10);
        for(const line of depths) assert.equal(parseInt(line.split("pixel=")[1], 16) & 0xffffff, 0xff00, line);
        assert(results.includes("RESULT projection=0 clipping=1 op=1 vertex=5 words=3f000000,3f000000,bf000000,3f800000"));
        assert(results.includes("RESULT projection=1 clipping=1 op=1 vertex=5 words=3f800000,3f800000,bf000000,40000000"));
        assert(results.includes("RESULT projection=2 clipping=1 op=1 vertex=0 words=bf800000,bf800000,3f000000,c0000000"));
    } });
result.rendering = "Microsoft system DDraw7 RGB software rasterizer; ten depth comparisons read from its surface";
fs.writeFileSync(out + "/probe-result.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ status: result.status, seconds: result.seconds, vertexResults: 252, depthResults: 10 }));
