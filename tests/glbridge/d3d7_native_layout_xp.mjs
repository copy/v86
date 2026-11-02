#!/usr/bin/env node
// System Microsoft RGB output reference, or the same calls against app-local DDraw.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync as run } from "node:child_process";
import { createHash as create_hash } from "node:crypto";
import { fileURLToPath as file_url_to_path } from "node:url";
import { site_directory } from "../lib/site.mjs";
import { run_xp_ram_probe } from "../lib/xp_ram_probe.mjs";
import { parse_layout_rows, compare_layout_rows } from "../lib/d3d_layout_reference.mjs";
const root = file_url_to_path(new URL("../../", import.meta.url)), site = site_directory(root);
const proxy = process.argv.includes("--proxy"), write_reference = process.argv.includes("--write-reference");
assert(!(proxy && write_reference), "only original Microsoft results may freeze a reference");
const out = path.resolve(process.env.D9WG_NATIVE_LAYOUT_OUT || root + "build/d3d-review/" + (proxy ? "proxy" : "native") + "-layout-reference");
fs.mkdirSync(out, { recursive: true });
const hash = bytes => create_hash("sha256").update(bytes).digest("hex");
const source = site + "/glbridge/sample/" + (proxy ? "d3d7_legacy_output_proxy_test.c" : "d3d7_native_layout_reference.c");
const build = { sourceSha256: hash(fs.readFileSync(source)), referenceSourceSha256: hash(fs.readFileSync(site + "/glbridge/sample/d3d7_native_layout_reference.c")) };
if(proxy) run("sh", [site + "/glbridge/ddrawproxy/build.sh", out + "/DDRAW.DLL"], { stdio: "pipe" });
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror",
    "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/LAYOUT.EXE", source,
    "-luser32", "-lkernel32", "-ldxguid"], { stdio: "pipe" });
const files = { "LAYOUT.EXE": fs.readFileSync(out + "/LAYOUT.EXE") };
build.exeSha256 = hash(files["LAYOUT.EXE"]);
const commands = ["@echo off"];
if(proxy)
{
    files["DDRAW.DLL"] = fs.readFileSync(out + "/DDRAW.DLL");build.dllSha256 = hash(files["DDRAW.DLL"]);
    files["V86GL.SYS"] = fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys");
    commands.push("sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys",
        "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl");
}
commands.push("%~d0\\LAYOUT.EXE", "");files["PROBE.CMD"] = Buffer.from(commands.join("\r\n"));
let rows, compared = 0;
const result = await run_xp_ram_probe({ root, out, files,
    image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img",
    result_file: "LAYOUT.TXT", success: "PASS native output-layout reference finished", log_files: ["LAYOUT.TXT"], expected_releases: proxy ? 1 : 0,
    inspect(result) {
        assert(result.text.includes("PASS native output-layout reference available"));
        assert.equal(result.owners.length, proxy ? 1 : 0);
        if(proxy) assert(result.batches > 0);else assert.equal(result.batches, 0);
        rows = parse_layout_rows(result.text);
        if(proxy) { assert(result.text.includes("PASS proxy XYZ aliases, final buffer boundary and temporary clip/extents records"));compared = compare_layout_rows(rows, JSON.parse(fs.readFileSync(root + "docs/fixtures/d3d-review/d3d7-native-layout-reference.json")).rows); }
        else assert.equal(rows.filter(row => row.hr === 0).length, 84);
    } });
result.rendering = proxy ? "App-local proxy software ProcessVertices; host commands acknowledged without rendering" : "Original Microsoft D3D7 RGB software ProcessVertices; no host rendering";
result.build = build;
fs.writeFileSync(out + "/probe-result.json", JSON.stringify(result, null, 2) + "\n");
if(write_reference)
{
    const reference = { provenance: { description: result.rendering, ...build, batches: result.batches, owners: result.owners,
        seconds: result.seconds, skipped: "OP_CLIP with XYZ output hangs in the original RGB runtime; native probes keep one spare destination vertex to contain spill writes" }, rows };
    for(const file of [root + "docs/fixtures/d3d-review/d3d7-native-layout-reference.json", site + "/glbridge/tests/fixtures/d9wg_d3d7_native_layout_reference.json"])
        fs.writeFileSync(file, JSON.stringify(reference, null, 2) + "\n");
}
console.log(JSON.stringify({ status: result.status, seconds: result.seconds, layoutResults: rows.length, nativeComparisons: compared, proxy }));
