#!/usr/bin/env node
// Prepare a read-only test CD with this checkout's XP driver, diagnostic
// proxy and CPU-query/GLSL probe. The browser writes only in-memory disks.
import fs from "node:fs";
import path from "node:path";
import { execFileSync as run } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generate } from "../src/iso9660.js";
import { site_directory } from "../tests/lib/site.mjs";
const game = process.argv.includes("--game=warcraft3") ? "warcraft3" : "cube2";
const root = fileURLToPath(new URL("../", import.meta.url)), site = site_directory(root), out = root + (game === "cube2" ? "build/gl-guest/" : "build/gl-guest-warcraft3/");
fs.mkdirSync(out, { recursive: true });
const images = [site + "/windowsxp/windowsxp_multidisk_C_4G.img", site + "/game/" + game + ".img"];
const before = images.map(name => ({ name, size: fs.statSync(name).size, mtimeMs: fs.statSync(name).mtimeMs }));
run("sh", [site + "/glbridge/v86gl_driver/build.sh", out + "V86GL.SYS"], { stdio: "inherit" });
run("sh", [site + "/glbridge/openglproxy/build.sh", "--diagnostic", out + "OPENGL32.DLL"], { stdio: "inherit" });
run(process.env.CC_GUEST || "i686-w64-mingw32-gcc", ["-Os", "-Wall", "-Wextra", "-Werror", "-nostdlib", "-Wl,--subsystem,console:5.01", "-Wl,--entry,_entry@0",
    "-o", out + "PROBE.EXE", root + "tests/glbridge/gl_guest_probe.c", "-lopengl32", "-lgdi32", "-luser32", "-lkernel32"], { stdio: "inherit" });
const launch = game === "cube2" ? ["copy /y %~d0\\OPENGL32.DLL D:\\SauerbratenPortable\\App\\Sauerbraten\\bin\\opengl32.dll",
    "if errorlevel 1 goto fail", "cd /d D:\\SauerbratenPortable\\App\\Sauerbraten", "echo CUBE2_LAUNCH", "bin\\sauerbraten.exe -w640 -h480 -z24 -a0 -f0", "echo CUBE2_EXIT_%ERRORLEVEL%"] :
    ["copy /y %~d0\\OPENGL32.DLL \"D:\\Warcraft III\\opengl32.dll\"", "if errorlevel 1 goto fail", "cd /d \"D:\\Warcraft III\"",
        "echo WARCRAFT3_OPENGL_LAUNCH", "War3.exe -opengl -window -loadfile \"Maps\\(2)PlunderIsle.w3m\"", "echo WARCRAFT3_EXIT_%ERRORLEVEL%"];
const setup = ["@echo off", "echo GL_ACCEPT_SETUP_BEGIN", "sc stop v86gl", "if not exist C:\\v86gl mkdir C:\\v86gl",
    "copy /y %~d0\\V86GL.SYS C:\\v86gl\\v86gl.sys", "sc config v86gl type= kernel start= demand binPath= C:\\v86gl\\v86gl.sys",
    "sc create v86gl type= kernel start= demand binPath= C:\\v86gl\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto fail",
    "%~d0\\PROBE.EXE", "if errorlevel 1 goto fail", ...launch, "goto end", ":fail", "echo GL_ACCEPT_SETUP_FAILED_%ERRORLEVEL%", ":end", ""].join("\r\n");
fs.writeFileSync(out + "SETUP.CMD", setup);
const files = ["SETUP.CMD", "V86GL.SYS", "OPENGL32.DLL", "PROBE.EXE"].map(name => ({ name, contents: fs.readFileSync(out + name) }));
fs.writeFileSync(out + "tools.iso", Buffer.from(generate(files)));
if(fs.existsSync(out + "site") && fs.realpathSync(out + "site") !== fs.realpathSync(site)) throw new Error("Unexpected site link");
if(!fs.existsSync(out + "site")) fs.symlinkSync(site, out + "site");
fs.writeFileSync(out + "inputs.json", JSON.stringify({ game, images: before, files: files.map(f => ({ name: f.name, size: f.contents.length })) }, null, 2));
for(const image of before) if(fs.statSync(image.name).mtimeMs !== image.mtimeMs) throw new Error("Source image changed");
console.log("Prepared " + path.relative(root, out + "tools.iso") + "; cold boot with tests/glbridge/gl_guest_acceptance.html (worker=0 or 1)");
