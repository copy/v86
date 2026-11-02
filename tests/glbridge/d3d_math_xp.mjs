#!/usr/bin/env node
// Frozen software-vertex C operations on actual XP x87 at three precisions.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync as run } from "node:child_process";
import { createRequire as create_require } from "node:module";
import { fileURLToPath as file_url_to_path } from "node:url";
import { site_directory } from "../lib/site.mjs";
import { run_xp_ram_probe } from "../lib/xp_ram_probe.mjs";
const root = file_url_to_path(new URL("../../", import.meta.url)), site = site_directory(root), require = create_require(import.meta.url);
const out = path.resolve(process.env.D9WG_MATH_OUT || root + "build/d3d-review/stage4d2b-xp");
fs.mkdirSync(out, { recursive: true });
const lighting_math = process.argv.includes("--lighting-math");
const vertex_math = process.argv.includes("--vertex-math");
const fog_math = process.argv.includes("--fog-math");
const texture_math = process.argv.includes("--texture-math");
const blend_math = process.argv.includes("--blend-math");
const typed_clip_math = process.argv.includes("--typed-clipping-math");
const vertex_stream_math = process.argv.includes("--vertex-streams-math") || typed_clip_math;
const vertex_color_math = process.argv.includes("--vertex-colors-math") || vertex_stream_math;
const vertex_format_math = process.argv.includes("--vertex-formats-math") || vertex_color_math;
const legacy_output_math = process.argv.includes("--legacy-output-math") || vertex_format_math;
const clip_status_math = process.argv.includes("--clip-status-math") || legacy_output_math;
const clip_user_math = process.argv.includes("--clip-user-math") || clip_status_math;
const clip_pipeline_math = process.argv.includes("--clip-pipeline-math") || clip_user_math;
const clip_math = process.argv.includes("--clip-math") || clip_pipeline_math;
const { source } = require(site + "/glbridge/tests/d9wg_math_harness.js");
if(clip_status_math) run(process.execPath, [site + "/glbridge/tests/d9wg_clip_status_test.js"],
    { stdio: "pipe", env: { ...process.env, D9WG_STATUS_HEADER_OUT: out + "/clip-status-cases.h" } });
if(legacy_output_math) run(process.execPath, [site + "/glbridge/tests/d9wg_legacy_output_test.js"],
    { stdio: "pipe", env: { ...process.env, D9WG_LEGACY_OUTPUT_HEADER_OUT: out + "/legacy-output-cases.h" } });
if(vertex_format_math) run(process.execPath, [site + "/glbridge/tests/d9wg_vertex_format_test.js"],
    { stdio: "pipe", env: { ...process.env, D9WG_VERTEX_FORMAT_HEADER_OUT: out + "/vertex-format-cases.h" } });
if(vertex_color_math) run(process.execPath, [site + "/glbridge/tests/d9wg_vertex_color_test.js"],
    { stdio: "pipe", env: { ...process.env, D9WG_VERTEX_COLOR_HEADER_OUT: out + "/vertex-color-cases.h" } });
if(typed_clip_math) run(process.execPath,[site+"/glbridge/tests/d9wg_typed_clip_test.js"],
    {stdio:"pipe",env:{...process.env,D9WG_TYPED_CLIP_HEADER_OUT:out+"/typed-clip-cases.h"}});
const code = (typed_clip_math ? "\n#include " + JSON.stringify(out+"/typed-clip-cases.h") + "\n" : "") + (vertex_stream_math ? '#include "tests/native/d9wg_vertex_stream_cases.h"\n#include "tests/native/d9wg_vertex_stream_clip_cases.h"\n#include "tests/native/d9wg_vertex_stream_draw_cases.h"\n' : "") + `#define WIN32_LEAN_AND_MEAN
#include <windows.h>
` + source() + (lighting_math ? '\n#include "tests/native/d9wg_tnl_math_cases.h"\n' : "") + (vertex_math ? '\n#include "tests/native/d9wg_vertex_cases.h"\n' : "") + (fog_math ? '\n#include "tests/native/d9wg_fog_cases.h"\n' : "") + (texture_math ? '\n#include "tests/native/d9wg_texcoord_cases.h"\n' : "") + (blend_math ? '\n#include "tests/native/d9wg_blend_cases.h"\n' : "") + (clip_math ? '\n#include "tests/native/d9wg_clip_cases.h"\n' : "") + (clip_pipeline_math ? '\n#include "tests/native/d9wg_clip_triangle_cases.h"\n#include "tests/native/d9wg_clip_buffer_cases.h"\n#include "tests/native/d9wg_clip_draw_cases.h"\n' : "") + (clip_user_math ? '\n#include "tests/native/d9wg_clip_user_cases.h"\n' : "") + (clip_status_math ? "\n#include " + JSON.stringify(out + "/clip-status-cases.h") + "\n" : "") + (legacy_output_math ? "\n#include " + JSON.stringify(out + "/legacy-output-cases.h") + "\n" : "") + (vertex_format_math ? "\n#include " + JSON.stringify(out + "/vertex-format-cases.h") + "\n" : "") + (vertex_color_math ? "\n#include " + JSON.stringify(out + "/vertex-color-cases.h") + "\n" : "") + `
static HANDLE log_file;
static void report(const char *text) {
    DWORD written;WriteFile(log_file,text,(DWORD)lstrlenA(text),&written,NULL);
    WriteFile(log_file,"\\r\\n",2,&written,NULL);FlushFileBuffers(log_file);
}
void WINAPI WinMainCRTStartup(void) {
    char path[MAX_PATH],text[128];unsigned at;WORD saved;
    const WORD modes[]={0x7f,0x27f,0x37f};
    GetModuleFileNameA(NULL,path,sizeof(path));at=(unsigned)lstrlenA(path);
    while(at&&path[at-1]!='\\\\')--at;
    path[at]=0;lstrcatA(path,"MATH.TXT");
    log_file=CreateFileA(path,GENERIC_WRITE,FILE_SHARE_READ,NULL,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,NULL);
    if(log_file==INVALID_HANDLE_VALUE)ExitProcess(2);
    __asm__ volatile("fnstcw %0":"=m"(saved)::"memory");
    report("READY real XP frozen C math probe");
    for(unsigned i=0;i<3;i++) {
        __asm__ volatile("fnclex\\n\\tfldcw %0"::"m"(modes[i]):"memory");
        int error=math_cases(20000);
        ${lighting_math ? "double errors[2];if(!error)error=tnl_math_cases(20000,errors);" : ""}
        ${vertex_math ? "if(!error)error=vertex_cases(20000);" : ""}
        ${fog_math ? "if(!error)error=fog_cases(20000);" : ""}
        ${texture_math ? "if(!error)error=texcoord_cases(20000);" : ""}
        ${blend_math ? "if(!error)error=blend_cases(20000);" : ""}
        ${clip_math ? "if(!error)error=clip_cases(20000);" : ""}
        ${clip_pipeline_math ? "if(!error)error=clip_triangle_cases(20000);\n        if(!error)error=clip_buffer_cases();\n        if(!error)error=clip_draw_cases();" : ""}
        ${clip_user_math ? "if(!error)error=clip_user_cases(20000);" : ""}
        ${clip_status_math ? "if(!error)error=clip_status_cases();" : ""}
        ${legacy_output_math ? "if(!error)error=legacy_output_cases();" : ""}
        ${vertex_format_math ? "if(!error)error=vertex_format_cases();" : ""}
        ${vertex_color_math ? "if(!error)error=vertex_color_cases();" : ""}
        ${vertex_stream_math ? "if(!error)error=vertex_stream_cases(100000);\n        if(!error)error=vertex_stream_clip_cases();\n        if(!error)error=vertex_stream_draw_cases();" : ""}
        ${typed_clip_math ? "if(!error)error=typed_clip_cases();" : ""}
        WORD observed;__asm__ volatile("fnstcw %0":"=m"(observed)::"memory");
        if(observed!=modes[i])error=9999;
        __asm__ volatile("fnclex\\n\\tfldcw %0"::"m"(saved):"memory");
        if(error) { wsprintfA(text,"FAIL x87 control=%04x generated line=%d",modes[i],error);report(text);ExitProcess(1); }
        wsprintfA(text,"PASS x87 control=%04x operations=%u",modes[i],math_comparisons);report(text);
        ${lighting_math ? 'wsprintfA(text,"PASS lighting math control=%04x checks=60000",modes[i]);report(text);' : ""}
        ${vertex_math ? 'wsprintfA(text,"PASS vertex math control=%04x ranges=20000",modes[i]);report(text);' : ""}
        ${fog_math ? 'wsprintfA(text,"PASS fog math control=%04x cases=20000",modes[i]);report(text);' : ""}
        ${texture_math ? 'wsprintfA(text,"PASS texture math control=%04x cases=20000",modes[i]);report(text);' : ""}
        ${blend_math ? 'wsprintfA(text,"PASS blend math control=%04x cases=20000",modes[i]);report(text);' : ""}
        ${clip_math ? 'wsprintfA(text,"PASS clip math control=%04x cases=20000",modes[i]);report(text);' : ""}
        ${clip_pipeline_math ? 'wsprintfA(text,"PASS clip pipeline control=%04x triangles=20000 buffers=1 draws=1",modes[i]);report(text);' : ""}
        ${clip_user_math ? 'wsprintfA(text,"PASS clip user control=%04x cases=20000 world-blend=1",modes[i]);report(text);' : ""}
        ${clip_status_math ? 'wsprintfA(text,"PASS clip status control=%04x native=100 histories=100000",modes[i]);report(text);' : ""}
    }
        ${legacy_output_math ? 'report("PASS legacy output control words=3 native=252");' : ""}
    ${vertex_format_math ? 'report("PASS typed vertex inputs control words=3 vectors=3264 halfPatterns=196608");' : ""}
    ${vertex_color_math ? 'report("PASS typed vertex colors control words=3 inputs=3276 colorModes=19656");' : ""}
    ${vertex_stream_math ? 'report("PASS multi-stream math control words=3 ranges=300000 rotations=48");' : ""}
    ${vertex_stream_math ? 'report("PASS multi-stream clip math control words=3 full-ranges=1 atomic-palette=1 POSITIONT=1");' : ""}
    ${vertex_stream_math ? 'report("PASS multi-stream clipped draws control words=3 exact-packed-attributes=1 constant-overflow=1");' : ""}
    ${typed_clip_math ? 'report("PASS typed clipping control words=3 inputs=3246 roleCases=16230");' : ""}
    report("PASS all real XP math checks");CloseHandle(log_file);ExitProcess(0);
}
`;
fs.writeFileSync(out + "/math.c", code);
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu11", "-Os", "-ffp-contract=off", "-ffreestanding", "-fno-builtin", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror",
    "-I", site + "/glbridge", "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/MATH.EXE", out + "/math.c",
    site + "/glbridge/runtime/d9wg_math.c", ...new Set([...(lighting_math || fog_math ? [site + "/glbridge/runtime/d9wg_tnl_math.c", "-lmsvcrt"] : []), ...(vertex_math || fog_math || texture_math || blend_math || clip_math ? ["clip", ...(clip_pipeline_math ? ["clip_draw"] : []), "blend", "vertex", "fvf", "lighting", "tnl_math"].map(name => site + "/glbridge/runtime/d9wg_" + name + ".c") : [])]), "-luser32", "-lkernel32"], { stdio: "pipe" });
const files = { "MATH.EXE": fs.readFileSync(out + "/MATH.EXE"),
    "PROBE.CMD": Buffer.from("@echo off\r\necho READY math >%~d0\\OWNER.TXT\r\n%~d0\\MATH.EXE\r\ntype %~d0\\MATH.TXT >>%~d0\\OWNER.TXT\r\n") };
const result = await run_xp_ram_probe({ root, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", out, files,
    success: "PASS all real XP math checks", log_files: ["MATH.TXT"], inspect(result) {
        if(typed_clip_math) assert(result.text.includes("PASS typed clipping control words=3 inputs=3246 roleCases=16230"));
        if(vertex_stream_math) {
            assert(result.text.includes("PASS multi-stream math control words=3 ranges=300000 rotations=48"));
            assert(result.text.includes("PASS multi-stream clip math control words=3 full-ranges=1 atomic-palette=1 POSITIONT=1"));
            assert(result.text.includes("PASS multi-stream clipped draws control words=3 exact-packed-attributes=1 constant-overflow=1"));
        }
        if(vertex_color_math) assert(result.text.includes("PASS typed vertex colors control words=3 inputs=3276 colorModes=19656"));
        if(vertex_format_math) assert(result.text.includes("PASS typed vertex inputs control words=3 vectors=3264 halfPatterns=196608"));
        if(legacy_output_math) assert(result.text.includes("PASS legacy output control words=3 native=252"));
        assert.equal(result.batches, 0);assert.equal(result.releases.length, 0);
        for(const mode of ["007f", "027f", "037f"]) {
            assert(result.text.includes("PASS x87 control=" + mode + " operations=240000"));
            if(lighting_math) assert(result.text.includes("PASS lighting math control=" + mode + " checks=60000"));
            if(vertex_math) assert(result.text.includes("PASS vertex math control=" + mode + " ranges=20000"));
            if(fog_math) assert(result.text.includes("PASS fog math control=" + mode + " cases=20000"));
            if(texture_math) assert(result.text.includes("PASS texture math control=" + mode + " cases=20000"));
            if(blend_math) assert(result.text.includes("PASS blend math control=" + mode + " cases=20000"));
            if(clip_math) assert(result.text.includes("PASS clip math control=" + mode + " cases=20000"));
            if(clip_pipeline_math) assert(result.text.includes("PASS clip pipeline control=" + mode + " triangles=20000 buffers=1 draws=1"));
            if(clip_user_math) assert(result.text.includes("PASS clip user control=" + mode + " cases=20000 world-blend=1"));
            if(clip_status_math) assert(result.text.includes("PASS clip status control=" + mode + " native=100 histories=100000"));
        }
    } });
console.log(JSON.stringify(result));
