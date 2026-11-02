#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath as file_url_to_path} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root = file_url_to_path(new URL("../../", import.meta.url)), site = site_directory(root), mask = Number(process.env.D9WG_QUERY_HOST_MASK || 0), out = path.resolve(process.env.D9WG_QUERY_OUT || root + "build/d3d-review/stage4f2b-query-" + mask + "-xp"); assert([0, 3, 12, 15].includes(mask)); fs.mkdirSync(out, {recursive: true});
run("sh", [site + "/glbridge/d3d9proxy/build.sh", out + "/D3D9.DLL"], {stdio: "pipe"});
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-DD9WG_QUERY_HOST_MASK=" + mask, "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/QUERY.EXE", site + "/glbridge/sample/d3d9_format_query_test.c", "-luser32", "-lkernel32"], {stdio: "pipe"});
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys"), "D3D9.DLL": fs.readFileSync(out + "/D3D9.DLL"), "QUERY.EXE": fs.readFileSync(out + "/QUERY.EXE")};
const commands = ["@echo off", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl"];
for (const profile of ["ffp", "sm2", "sm3"]) commands.push("set D9WG_CAPS_PROFILE=" + profile, "%~d0\\QUERY.EXE", "if errorlevel 1 goto failed", "type %~d0\\QUERY.TXT >%~d0\\Q" + profile.toUpperCase() + ".TXT");
commands.push("echo PASS format query probes >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL format query probes >%~d0\\OWNER.TXT", ""); files["PROBE.CMD"] = Buffer.from(commands.join("\r\n"));
const result = await run_xp_ram_probe({root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS format query probes", log_files: ["QUERY.TXT", "QFFP.TXT", "QSM2.TXT", "QSM3.TXT"], capture_graphics: true, expected_releases: 3, simulated_host_features: mask, rendering: "not exercised; explicitly simulated host feature mask", inspect(r) {
    for (const [name, major] of [["FFP", 0], ["SM2", 2], ["SM3", 3]]) assert(r.logs["Q" + name + ".TXT"].includes("PASS D3D9 format queries: simulatedHost=" + mask + " profile=" + major + " queries=1920")); assert.equal(r.owners.length, 3); assert.equal(r.releases.length, 3);
}});
console.log(JSON.stringify({status: result.status, seconds: result.seconds, simulatedHostFeatures: mask, owners: result.owners.length, queries: 5760}));
