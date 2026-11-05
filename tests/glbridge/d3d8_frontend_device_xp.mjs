#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {create_d3d_live_renderer} from "../lib/d3d_live_renderer.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const site = site_directory(root);
const public_entry = process.env.D8WG_PUBLIC_DEVICE === "1";
const out = path.resolve(process.env.D8WG_FRONTEND_DEVICE_OUT || root + "build/d3d-review/" + (public_entry ? "stage4-public-device8" : "stage4-device8"));
const require = createRequire(import.meta.url);
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
const W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
fs.mkdirSync(out, {recursive:true});
const run = (command, args) => execFileSync(command, args, {stdio:"pipe"});
if (!process.env.D8WG_FRONTEND_DEVICE_PREBUILT) {
    run("sh", [site + "/glbridge/d3d8proxy/build.sh", out + "/d3d8.dll"]);
    run("sh", [site + "/glbridge/d3d9proxy/build.sh", "--static", out + "/libd9wg_d3d9.a"]);
    const common = ["-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-Wl,--subsystem,windows:5.01"];
    const sources = ["device", "surface", "texture", "cube_texture", "volume", "volume_texture", "buffer", "swap_chain"];
    const cc = process.env.D9WG_CC || "i686-w64-mingw32-gcc";
    run(cc, ["-shared", ...common, "-Wl,-e,_DllMain@12", "-Wl,--kill-at", "-Wl,--exclude-all-symbols", "-o", out + "/CORE8.DLL",
        site + "/glbridge/sample/d3d8_frontend_device_consumer.c", site + "/glbridge/sample/d3d8_frontend_device_consumer.def",
        ...sources.map(name => site + "/glbridge/d3d8proxy/d3d8_core_" + name + ".c"), out + "/libd9wg_d3d9.a", "-luser32", "-lgdi32", "-lkernel32"]);
    run(cc, ["-mwindows", ...common, ...(public_entry ? ["-DD8WG_PUBLIC_DEVICE=1"] : []), "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/DEVICE8.EXE",
        site + "/glbridge/sample/d3d8_frontend_device_test.c", "-ldxguid", "-luser32", "-lkernel32"]);
}
const files = {"V86GL.SYS":fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys")};
for (const name of ["d3d8.dll", "CORE8.DLL", "DEVICE8.EXE"]) files[name.toUpperCase()] = fs.readFileSync(out + "/" + name);
files["PROBE.CMD"] = Buffer.from(["@echo off", "set D9WG_GDI_CURSOR=0", "sc stop v86gl",
    "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys",
    "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl",
    "if errorlevel 1 goto failed", "%~d0\\DEVICE8.EXE", "if errorlevel 1 goto failed",
    "echo PASS Device8 frontend >%~d0\\OWNER.TXT", "exit /b", ":failed",
    "echo FAIL Device8 frontend >%~d0\\OWNER.TXT", ""].join("\r\n"));
const scenes = Array.from({length:4}, () => [
    {size:4,color:0xff336699}, {size:4,color:0xff995522},
    ...[0xffff0000,0xffff0000,0xff00ff00,0xff00ff00,0xff00ff00].map(color => ({size:8,color})),
]).flat();
let replies = 0;
const live = process.env.D8WG_LIVE_GPU === "1" ? await create_d3d_live_renderer() : null;
try {
const result = await run_xp_ram_probe({root, out, files,
    image:process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img",
    success:"PASS Device8 frontend", log_files:["DEVICE8.TXT"], capture_graphics:true,
    expected_releases:1, simulated_host_features:live ? null : 0, graphics_renderer:live,
    rendering:live ? "Actual live GPU replies are written back to XP before batch completion. SDK8 checks every returned pixel; no analytic reply injection." : "Actual 97-method Device8 facade, SDK120/220 normal/PURE, API8 scopes and deleted shader retention, Reset/cancel, child GetDevice revival. CPU readback replies are analytic; captured commands are independently replayed on GPU.",
    observe_batch:live ? null : function(message, read, write) {
        const h = W.readHeader(message.bytes.subarray(8));
        W.checkStream(h.view, h.end, h.commandCount);
        for (let offset = P.STRUCTS.BatchHeader.size; offset < h.end;) {
            const op = h.view.getUint16(offset, true), size = h.view.getUint32(offset + P.F.CommandHeader.size, true);
            if (op === P.OP.READBACK_SURFACE) {
                const q = P.decode("ReadbackSurface", h.view, offset + 16, size - 16);
                const scene = scenes[replies++]; assert(scene, "unexpected readback");
                assert.deepEqual([q.width,q.height,q.format,q.destination_pitch,q.destination_bytes], [scene.size,scene.size,21,scene.size*4,scene.size*scene.size*4]);
                const payload = Buffer.alloc(16 + q.destination_bytes);
                Buffer.from(P.encode("ReadbackResponse", {request_id:q.request_id,byte_count:q.destination_bytes,status:P.C.D9WG_RESPONSE_OK})).copy(payload);
                for (let i = 16; i < payload.length; i += 4) payload.writeUInt32LE(scene.color, i);
                write((16<<20)-P.C.D9WG_RESPONSE_REGION_BYTES+q.response_offset, payload);
            }
            offset += size;
        }
    },
    inspect(r) {
        if (live) {
            assert.equal(live.stats.snapshot.stats.readbackRequests,28);
            assert.equal(live.stats.snapshot.cleanup.length,1);
            assert(live.stats.snapshot.cleanup.every(v=>!v.devices&&!v.resources));
        } else assert.equal(replies, 28);
        if (public_entry) assert.match(r.logs["DEVICE8.TXT"], /PUBLIC Direct3DCreate8\/CreateDevice entry/);
        assert.match(r.logs["DEVICE8.TXT"], /PASS Device8 frontend methods=97 devices=4 images=28 checks=\d+ finalRefs=0/);
        assert.equal(r.owners.length, 1); assert.deepEqual(r.releases, r.owners);
    },
});
console.log(JSON.stringify(result));
} finally {
    if (live) {fs.writeFileSync(out + "/live-gpu.json",JSON.stringify(live.stats,null,2)+"\n");live.close();}
}
