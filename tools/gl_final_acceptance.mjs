#!/usr/bin/env node
// Read-only CD for the final XP application matrix. In particular Cube and
// Warcraft use the F6-installed DLL/driver, never a replacement from this CD.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync as run } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generate } from "../src/iso9660.js";
import { prepare_scene } from "./gl_q3_scene.mjs";
import { site_directory } from "../tests/lib/site.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)), site = site_directory(root);
const out = root + "build/gl-final/", assets = root + "build/gl-acceptance-assets/";
fs.mkdirSync(out, { recursive: true });
if(!fs.existsSync(out + "site")) fs.symlinkSync(site, out + "site");
// A frozen, actually shipped pre-G host, rather than a fabricated timing
// baseline. Core CPU/guest DLLs are identical; G changes presentation saves.
fs.mkdirSync(out + "baseline", { recursive: true });
for(const name of ["libv86-webgpu.js", "v86gl-device.js", "graphics_journal_worker.js", "d3d9_shader_worker.js", "d3d9_shader_pipeline.js", "glslang.wasm", "vx_naga.wasm"])
    fs.writeFileSync(out + "baseline/" + name, run("git", ["show", "e0b52c0:vendor/v86/glbridge/" + name], { cwd: site, maxBuffer: 64 << 20 }));
if(process.argv.includes("--baseline-only")) process.exit(0);
const files = [], add = (name, file) => files.push({ name, contents: fs.readFileSync(file) });
const cmd = (name, lines) => files.push({ name, contents: Buffer.from(["@echo off", ...lines, ""].join("\r\n")) });
run("i686-w64-mingw32-gcc", ["-Os", "-Wall", "-Wextra", "-Werror", "-nostdlib", "-Wl,--subsystem,windows:5.01", "-Wl,--entry,_WinMainCRTStartup@0", "-Wl,--no-insert-timestamp", "-o", out + "WINECUBE.EXE", site + "/glbridge/sample/d3d8_textured_cube_test.c", "-ld3d8", "-lgdi32", "-luser32", "-lkernel32"], { stdio: "inherit" });
add("WINECUBE.EXE", out + "WINECUBE.EXE");
run("i686-w64-mingw32-gcc", ["-Os", "-Wall", "-Wextra", "-Werror", "-nostdlib", "-Wl,--subsystem,windows:5.01", "-Wl,--entry,_entry@0", "-Wl,--no-insert-timestamp", "-o", out + "GLVIEWUI.EXE", root + "tests/glbridge/gl_guest_glview_ui.c", "-luser32", "-lkernel32"], { stdio: "inherit" });
add("GLVIEWUI.EXE", out + "GLVIEWUI.EXE");
add("OPENGL32.DLL", site + "/glbridge/openglproxy/opengl32.dll");
for(const name of ["d3d8.dll", "wined3d.dll", "libwine.dll"]) add(name.toUpperCase(), assets + "wined3d/" + name);
const glview = ["glview.exe", "infogl.dll", "glview.ini", "en.lng", "simple.frag", "simple.vert", "simple_arb.vp", "bump.frag", "bump.vert", "bump_arb.vp", "tweak.xml"];
const glview_fixes = [];
for(const name of glview) {
    const original = fs.readFileSync(assets + "glview/" + name);
    if(["simple.vert", "simple.frag"].includes(name)) {
        const source = original.toString("utf8");
        if(!/}\s*;\s*$/.test(source)) throw new Error("Unexpected upstream GLView shader " + name);
        const contents = Buffer.from(source.replace(/}(\s*);(\s*)$/, "}$1$2"));files.push({ name, contents });
        glview_fixes.push({ name, original: crypto.createHash("sha256").update(original).digest("hex"), corrected: crypto.createHash("sha256").update(contents).digest("hex"), change: "Remove one extraneous function-ending semicolon; original GLSL 1.10 is rejected by Apple OpenGL and glslang. EXE/DLL unchanged." });
    } else files.push({ name, contents: original });
}
// Stock GPP enables BSP flare surfaces. ATCS gets a separate deterministic
// test-map override; downloaded packages and engine binaries stay untouched.
const q3 = { application: "Tremulous GPP1 (Quake 3 engine)", scene: prepare_scene(assets + "tremulous/base/map-atcs-1.1.0.pk3", out + "TFLARE.PK3") };
for(const [name, source] of [["TREM.EXE", "tremulous-gpp/tremulous-gpp.exe"], ["SDL.DLL", "tremulous-gpp/SDL.dll"],
    ["TBASE.PK3", "tremulous/base/data-1.1.0.pk3"], ["TMAP.PK3", "tremulous/base/map-atcs-1.1.0.pk3"], ["TVMS.PK3", "tremulous/base/vms-1.1.0.pk3"],
    ["GPDATA.PK3", "tremulous-gpp/gpp/data-gpp1.pk3"], ["GPVMS.PK3", "tremulous-gpp/gpp/vms-gpp1.pk3"]]) add(name, assets + source);
add("TFLARE.PK3", out + "TFLARE.PK3");
const camera = q3.scene.camera.join(" ");
files.push({ name: "GLSCENE.CFG", contents: Buffer.from(["wait 250", "team humans", "wait 30", "class rifle", "wait 150", "noclip", "setviewpos " + camera, "wait 180", "set cg_thirdPerson 0"].join("\n") + "\n") });
cmd("CUBE2.CMD", ["sc start v86gl", "cd /d D:\\SauerbratenPortable\\App\\Sauerbraten", "bin\\sauerbraten.exe -w640 -h480 -z24 -a0 -f0"]);
cmd("WAR3.CMD", ["sc start v86gl", "cd /d \"D:\\Warcraft III\"", "War3.exe -opengl -window -loadfile \"Maps\\(2)PlunderIsle.w3m\""]);
cmd("WINE.CMD", ["sc start v86gl", "mkdir C:\\GLTEST\\Wine", ...["WINECUBE.EXE", "D3D8.DLL", "WINED3D.DLL", "LIBWINE.DLL", "OPENGL32.DLL"].map(name => "copy /y %~d0\\" + name + " C:\\GLTEST\\Wine\\" + name), "cd /d C:\\GLTEST\\Wine", "WINECUBE.EXE"]);
cmd("GLVIEW.CMD", ["sc start v86gl", "mkdir C:\\GLTEST\\GLView", ...[...glview, "OPENGL32.DLL"].map(name => "copy /y %~d0\\" + name + " C:\\GLTEST\\GLView\\" + name), "cd /d C:\\GLTEST\\GLView", "start glview.exe", "%~d0\\GLVIEWUI.EXE"]);
const q3_root = "C:\\GLTEST\\Q3ENGINE";
const q3_copies = [["TREM.EXE", "TREM.EXE"], ["SDL.DLL", "SDL.DLL"], ["OPENGL32.DLL", "opengl32.dll"],
    ["TBASE.PK3", "base\\data-1.1.0.pk3"], ["TMAP.PK3", "base\\map-atcs-1.1.0.pk3"], ["TVMS.PK3", "base\\vms-1.1.0.pk3"],
    ["GPDATA.PK3", "gpp\\data-gpp1.pk3"], ["GPVMS.PK3", "gpp\\vms-gpp1.pk3"], ["TFLARE.PK3", "gpp\\zz-gl-acceptance.pk3"], ["GLSCENE.CFG", "gpp\\glscene.cfg"]];
cmd("QUAKE3.CMD", ["sc start v86gl", "mkdir " + q3_root + "\\base", "mkdir " + q3_root + "\\gpp",
    ...q3_copies.map(([from, to]) => "copy /y %~d0\\" + from + " " + q3_root + "\\" + to), "cd /d " + q3_root,
    "TREM.EXE +set fs_game gpp +set r_fullscreen 0 +set r_mode 3 +set r_stencilbits 8 +set cg_shadows 2 +set cg_thirdPerson 1 +set cg_draw2D 0 +set r_flares 1 +set s_initsound 0 +set net_enabled 0 +set sv_pure 0 +devmap atcs +exec glscene.cfg"]);
fs.writeFileSync(out + "tools.iso", Buffer.from(generate(files)));
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
fs.writeFileSync(out + "inputs.json", JSON.stringify({ q3, glview_fixes, images: { xp: fs.statSync(site + "/windowsxp/windowsxp_multidisk_C_4G.img").size, cube2: fs.statSync(site + "/game/cube2.img").size, warcraft3: fs.statSync(site + "/game/warcraft3.img").size }, files: files.map(f => ({ name: f.name, size: f.contents.length, sha256: crypto.createHash("sha256").update(f.contents).digest("hex") })), sourceImages: ["windowsxp/windowsxp_multidisk_C_4G.img", "game/cube2.img", "game/warcraft3.img"].map(name => ({ name, mtimeMs: fs.statSync(site + "/" + name).mtimeMs })), proxy: digest(site + "/glbridge/openglproxy/opengl32.dll") }, null, 2));
console.log("Prepared " + path.relative(root, out) + ": " + files.length + " files, Quake 3 application=" + q3.application);
