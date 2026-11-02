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
const out = path.resolve(process.env.D9WG_STATUS_OUT || root + "build/d3d-review/proxy-status-reference");
fs.mkdirSync(out, { recursive: true });
const draw_cases = process.argv.includes("--draw-cases");
run("sh", [site + "/glbridge/ddrawproxy/build.sh", out + "/DDRAW.DLL"], { stdio: "pipe" });
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror",
    "-DD9WG_PROXY_CAPTURE", ...(draw_cases ? ["-DD9WG_STATUS_DRAW_CASES"] : []), "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/CLIP.EXE",
    site + "/glbridge/sample/d3d7_native_clip_status_reference.c", "-luser32", "-lkernel32", "-ldxguid"], { stdio: "pipe" });
const files = { "CLIP.EXE": fs.readFileSync(out + "/CLIP.EXE"), "DDRAW.DLL": fs.readFileSync(out + "/DDRAW.DLL"),
    "V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys"),
    "PROBE.CMD": Buffer.from(["@echo off", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys",
        "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "%~d0\\CLIP.EXE", ""].join("\r\n")) };
const result = await run_xp_ram_probe({ root, out, files,
    image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img",
    result_file: "CLIP.TXT", success: "PASS native clip-status reference finished", log_files: ["CLIP.TXT"], expected_releases: 1,
    inspect(result) {
        assert(result.text.includes("PASS native clip-status reference available"));
        assert(result.batches > 0);assert.equal(result.owners.length, 1);assert.equal(result.releases.length, 1);
        const results = result.text.split(/\r?\n/).filter(line => line.startsWith("STATUS "));
        assert.equal(results.length, draw_cases ? 100 : 85);
        const reference = JSON.parse(fs.readFileSync(root + "docs/fixtures/d3d-review/d3d7-native-clip-status-reference.json"));
        const expected = reference.rows.map(r => "STATUS label=" + r.label + " test=" + r.test + " query=" + r.query + " hr=" + r.hr.toString(16).padStart(8, "0") + " words=" + r.words.map(x => x.toString(16).padStart(8, "0")).join(","));
        assert.deepEqual(results, expected.slice(0, results.length));


    } });
result.rendering = "App-local proxy D3D7 CPU clip status and extents compared to 85 original Microsoft results; host commands acknowledged without rendering";
fs.writeFileSync(out + "/probe-result.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ status: result.status, seconds: result.seconds, statusResults: draw_cases ? 100 : 85 }));
