#!/usr/bin/env node
// Fresh D3D7/8/9 processed user-plane commands, one RAM-backed XP boot.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync as run } from "node:child_process";
import { createHash as create_hash } from "node:crypto";
import { fileURLToPath as file_url_to_path } from "node:url";
import { site_directory } from "../lib/site.mjs";
import { run_xp_ram_probe } from "../lib/xp_ram_probe.mjs";
const root = file_url_to_path(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D9WG_STATUS_APIS_OUT || root + "build/d3d-review/clip-status-apis-xp");
fs.mkdirSync(out, { recursive: true });
const hash = bytes => create_hash("sha256").update(bytes).digest("hex");
const files = { "V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys") }, builds = {};
for(const api of [7, 8, 9])
{
    const name = api === 7 ? "ddraw" : "d3d" + api;
    run("sh", [site + "/glbridge/" + name + "proxy/build.sh", out + "/" + name + ".dll"], { stdio: "pipe" });
    const source = site + "/glbridge/sample/" + (api === 7 ? "d3d7_native_clip_status_reference.c" : "d3d_processed_clip_draw_test.c");
    run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror",
        ...(api === 7 ? ["-DD9WG_PROXY_CAPTURE", "-DD9WG_STATUS_DRAW_CASES"] : ["-DD9WG_CLIP_API=" + api, "-DD9WG_CLIP_STATUS_ONLY"]),
        "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/CLP" + api + ".EXE", source,
        "-luser32", "-lkernel32", "-ldxguid"], { stdio: "pipe" });
    files[name.toUpperCase() + ".DLL"] = fs.readFileSync(out + "/" + name + ".dll");
    files["CLP" + api + ".EXE"] = fs.readFileSync(out + "/CLP" + api + ".EXE");
    builds[api] = { dllSha256: hash(files[name.toUpperCase() + ".DLL"]), executableSha256: hash(files["CLP" + api + ".EXE"]), sourceSha256: {} };
    for(const relative of ["glbridge/" + name + "proxy/" + (api === 7 ? "d3d7_proxy.inc" : name + "_proxy.c"),
        "glbridge/sample/d3d_user_clip_scenes.h", ...["clip.c", "clip.h", "clip_draw.c", "clip_draw.h", "vertex.c", "vertex.h", "vertex_windows.h", "blend.c", "blend.h"].map(n => "glbridge/runtime/d9wg_" + n)])
        builds[api].sourceSha256[relative] = hash(fs.readFileSync(site + "/" + relative));
}
const commands = ["@echo off", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys",
    "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed"];
for(const api of [7, 8, 9]) commands.push("%~d0\\CLP" + api + ".EXE", "copy /y %~d0\\CLIP.TXT %~d0\\CLIP" + api + ".TXT", "if errorlevel 1 goto failed");
commands.push("echo PASS fresh D3D7/8/9 clip status >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL fresh clip-status probe >%~d0\\OWNER.TXT", "");
files["PROBE.CMD"] = Buffer.from(commands.join("\r\n"));
const result = await run_xp_ram_probe({ root, out, files, expected_releases: 3,
    image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img",
    success: "PASS fresh D3D7/8/9 clip status", log_files: ["CLIP7.TXT", "CLIP8.TXT", "CLIP9.TXT"],
    inspect(result) {
        assert.equal(result.owners.length, 3);assert(result.owners.every(owner => owner > 0));
        assert.deepEqual([...result.releases].sort((a, b) => a - b), [...result.owners].sort((a, b) => a - b));
        for(const api of [7, 8, 9]) {
            const log = result.logs["CLIP" + api + ".TXT"];
            assert(log.includes(api === 7 ? "PASS native clip-status reference available" : "PASS real XP D3D8/9 clip status cases"));
            if(api === 7) {
                const reference = JSON.parse(fs.readFileSync(root + "docs/fixtures/d3d-review/d3d7-native-clip-status-reference.json"));
                const expected = reference.rows.map(r => "STATUS label=" + r.label + " test=" + r.test + " query=" + r.query + " hr=" + r.hr.toString(16).padStart(8, "0") + " words=" + r.words.map(x => x.toString(16).padStart(8, "0")).join(","));
                assert.deepEqual(log.split(/\r?\n/).filter(line => line.startsWith("STATUS ")), expected);
            }
        }
    } });
fs.writeFileSync(out + "/builds.json", JSON.stringify(builds, null, 2) + "\n");
console.log(JSON.stringify({ status: result.status, seconds: result.seconds, batches: result.batches,
    owners: result.owners, releases: result.releases, nativeD3D7Comparisons: 100 }));
