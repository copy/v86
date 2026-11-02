#!/usr/bin/env node
// Actual proxy COM draw calls on XP, captured for separate real-GPU replay.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync as run } from "node:child_process";
import { fileURLToPath as file_url_to_path } from "node:url";
import { site_directory } from "../lib/site.mjs";
import { run_xp_ram_probe } from "../lib/xp_ram_probe.mjs";
const root = file_url_to_path(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D9WG_CLIP_DRAW_OUT || root + "build/d3d-review/clip-draw-xp");
fs.mkdirSync(out, { recursive: true });
run("sh", [site + "/glbridge/ddrawproxy/build.sh", out + "/DDRAW.DLL"], { stdio: "pipe" });
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror",
    "-DD9WG_PROXY_CAPTURE", "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/CLIP.EXE",
    site + "/glbridge/sample/d3d7_native_clip_draw_reference.c", "-luser32", "-lkernel32", "-ldxguid"], { stdio: "pipe" });
const files = { "CLIP.EXE": fs.readFileSync(out + "/CLIP.EXE"), "DDRAW.DLL": fs.readFileSync(out + "/DDRAW.DLL"),
    "V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys"),
    "PROBE.CMD": Buffer.from(["@echo off", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys",
        "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "%~d0\\CLIP.EXE", ""].join("\r\n")) };
const result = await run_xp_ram_probe({ root, out, files,
    image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img",
    result_file: "CLIP.TXT", success: "PASS guest clipped primitive commands", log_files: ["CLIP.TXT"], capture_graphics: true,
    inspect(result) {
        assert.equal(result.owners.length, 1);assert.equal(result.releases.length, 1);
        assert.equal(result.text.split(/\r?\n/).filter(line => line.startsWith("VERTEX ")).length, 18);
        assert.equal(result.text.split(/\r?\n/).filter(line => line.startsWith("IMAGE ")).length, 18);
        assert(result.artifacts["graphics.bin"].bytes > 10000);
    } });
console.log(JSON.stringify({ status: result.status, seconds: result.seconds, batches: result.batches, artifacts: result.artifacts }));
