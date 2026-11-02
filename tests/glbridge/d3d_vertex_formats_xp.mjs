#!/usr/bin/env node
// Actual D3D9 COM typed-input processing on a RAM-backed XP boot.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash as create_hash } from "node:crypto";
import { execFileSync as run } from "node:child_process";
import { fileURLToPath as file_url_to_path } from "node:url";
import { site_directory } from "../lib/site.mjs";
import { run_xp_ram_probe } from "../lib/xp_ram_probe.mjs";
const root = file_url_to_path(new URL("../../", import.meta.url)), site = site_directory(root);
const api = 9, colors = process.argv.includes("--colors"), streams = process.argv.includes("--streams"), stream_draws = process.argv.includes("--stream-draws"), stream_clipping = process.argv.includes("--stream-clipping"), typed_clipping = process.argv.includes("--typed-clipping");
const capture_frames=(stream_clipping?12:0)+(typed_clipping?76:0);
const out = path.resolve(process.env.D9WG_VERTEX_FORMAT_OUT || root + "build/d3d-review/vertex-formats-xp-" + api);
fs.mkdirSync(out, { recursive: true });
run("sh", [site + "/glbridge/d3d" + api + "proxy/build.sh", out + "/D3D" + api + ".DLL"], { stdio: "pipe" });
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror",
    "-DD9WG_CLIP_API=" + api, "-DD9WG_VERTEX_FORMAT_ONLY", ...(colors ? ["-DD9WG_VERTEX_COLOR_CASES"] : []), ...(streams ? ["-DD9WG_VERTEX_STREAM_CASES"] : []), ...(stream_draws ? ["-DD9WG_VERTEX_STREAM_DRAW_CASES"] : []), ...(stream_clipping ? ["-DD9WG_VERTEX_STREAM_CLIPPING_CASES"] : []), ...(typed_clipping ? ["-DD9WG_TYPED_VERTEX_CLIP_CASES"] : []), "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/CLIP.EXE",
    site + "/glbridge/sample/d3d_processed_clip_draw_test.c", "-luser32", "-lkernel32", "-ldxguid"], { stdio: "pipe" });
const files = { "CLIP.EXE": fs.readFileSync(out + "/CLIP.EXE"), ["D3D" + api + ".DLL"]: fs.readFileSync(out + "/D3D" + api + ".DLL"),
    "V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys"),
    "PROBE.CMD": Buffer.from(["@echo off", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys",
        "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "%~d0\\CLIP.EXE", ""].join("\r\n")) };
const hash = data => create_hash("sha256").update(data).digest("hex");
const capture_build = capture_frames ? {api, dllSha256:hash(files["D3D9.DLL"]), executableSha256:hash(files["CLIP.EXE"]), driverSha256:hash(files["V86GL.SYS"]),testArgs:process.argv.slice(2),sourceSha256:{}} : null;
if(capture_build) for(const relative of ["glbridge/d3d9proxy/d3d9_proxy.c","glbridge/d3d9proxy/d3d9_protocol.h",
    ...["d3d_processed_clip_draw_test.c","d3d9_vertex_format_cases.h","d3d9_vertex_color_cases.h","d3d9_vertex_stream_cases.h","d3d9_vertex_stream_draw_cases.h","d3d9_vertex_stream_clipping_cases.h","d3d9_typed_clip_cases.h"].map(n=>"glbridge/sample/"+n),
    ...["clip.c","clip.h","clip_draw.c","clip_draw.h","vertex.c","vertex.h","vertex_windows.h","vertex_format.h","blend.c","blend.h","lighting.c","lighting.h","math.c","math.h","tnl_math.c","tnl_math.h"].map(n=>"glbridge/runtime/d9wg_"+n)]) capture_build.sourceSha256[relative]=hash(fs.readFileSync(site+"/"+relative));
const result = await run_xp_ram_probe({ root, out, files, capture_graphics: capture_frames>0,
    image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img",
    result_file: "CLIP.TXT", success: "PASS real XP typed input:", log_files: ["CLIP.TXT"], expected_releases: 1,
    inspect(result) {
        if(typed_clipping) {
            assert(result.text.includes("PASS real XP typed clipping:"));
            assert.equal(result.text.split(/\r?\n/).filter(line=>line.startsWith("IMAGE typed ")).length,76);
        }
        if(stream_clipping) {
            assert(result.text.includes("PASS real XP multi-stream clipping:"));
            assert.equal(result.text.split(/\r?\n/).filter(line=>line.startsWith("IMAGE stream ")).length,12);
        }
        if(stream_draws) assert(result.text.includes("PASS real XP multi-stream draws:"));
        if(streams) assert(result.text.includes("PASS real XP multi-stream:"));
        if(colors) assert(result.text.includes("PASS real XP floating color precision, specular source, fog, half/integer colors and copy flags"));
        assert.equal(result.owners.length, 1);assert.equal(result.releases.length, 1);
        assert(result.text.includes("PASS real XP typed input:"));
    } });
if(capture_build) {
    const trace=fs.readFileSync(out+"/graphics.bin");
    fs.writeFileSync(out+"/capture.json",JSON.stringify({...capture_build,bytes:trace.length,sha256:hash(trace),frames:capture_frames,owners:result.owners},null,2)+"\n");
}
console.log(JSON.stringify({ api, status: result.status, seconds: result.seconds, batches: result.batches, artifacts: result.artifacts }));
