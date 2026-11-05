#!/usr/bin/env node
// Read-only XP/game images with app-local current DLLs in RAM overlays.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync as run } from "node:child_process";
import { fileURLToPath as file_url_to_path } from "node:url";
import { generate } from "../src/iso9660.js";
import { site_directory } from "../tests/lib/site.mjs";
const root = file_url_to_path(new URL("../", import.meta.url)), site = site_directory(root), out = root + "build/d3d-review/";
fs.mkdirSync(out, { recursive: true });
if(!fs.existsSync(out + "site")) fs.symlinkSync(site, out + "site");
for(const api of ["d3d9", "d3d8", "ddraw"]) {
    if(process.env.D3D_REVIEW_USE_SHIPPING === "1")
        fs.copyFileSync(site + "/glbridge/" + api + "proxy/" + api + ".dll", out + api.toUpperCase() + ".DLL");
    else run("sh", [site + "/glbridge/" + api + "proxy/build.sh", out + api.toUpperCase() + ".DLL"], { stdio: "inherit" });
}
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-Os", "-Wall", "-Wextra", "-Werror", root + "tests/glbridge/d3d_game_input.c", "-o", out + "GINPUT.EXE", "-luser32"], {stdio:"inherit"});
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-Os", "-Wall", "-Wextra", "-Werror", root + "tests/glbridge/d3d_benchmark_ui.c", "-o", out + "BENCHUI.EXE", "-luser32"], {stdio:"inherit"});
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-Os", "-Wall", "-Wextra", "-Werror", root + "tests/glbridge/d3d_sound_caps.c", "-o", out + "SOUNDCAP.EXE", "-ldsound", "-lwinmm", "-ldxguid"], {stdio:"inherit"});
const commands = {
    WAR3: ["copy /y %~d0\\D3D8.DLL \"D:\\Warcraft III\\d3d8.dll\"", "copy /y %~d0\\D3D9.DLL \"D:\\Warcraft III\\d3d9.dll\"", "cd /d \"D:\\Warcraft III\"", "War3.exe -window -loadfile \"Maps\\(2)PlunderIsle.w3m\""],
    GTASA: ["copy /y %~d0\\D3D9.DLL \"D:\\GTA San Andreas\\d3d9.dll\"", "cd /d \"D:\\GTA San Andreas\"", "start gta_sa.exe"],
    MARK99: ['for %%g in (d e f g h i j k) do @if exist "%%g:\\3DMark 99 Max\\3dmark.exe" set GAME=%%g:\\3DMark 99 Max', 'if not defined GAME goto fail', 'copy /y %~d0\\DDRAW.DLL "%GAME%\\ddraw.dll"', 'if errorlevel 1 goto fail', 'cd /d "%GAME%"', '"%GAME%\\3dmark.exe"'],
    MARK00: ['for %%g in (d e f g h i j k) do @if exist %%g:\\3dmark2000\\3DMark2000.exe set GAME=%%g:\\3dmark2000', 'if not defined GAME goto fail', 'copy /y %~d0\\DDRAW.DLL "%GAME%\\ddraw.dll"', 'if errorlevel 1 goto fail', 'cd /d "%GAME%"', '"%GAME%\\3DMark2000.exe"'],
    MARK01: ["for %%g in (d e f g h i j k) do @if exist %%g:\\3DMARK01\\3DMark2001SE.exe set GAME=%%g:\\3DMARK01", "if not defined GAME goto fail", "copy /y %~d0\\D3D8.DLL %GAME%\\d3d8.dll", "if errorlevel 1 goto fail", "cd /d %GAME%", "3DMark2001SE.exe"],
    MAPLE: ["copy /y %~d0\\D3D8.DLL C:\\WINDOWS\\system32\\dllcache\\d3d8.dll", "if errorlevel 1 goto fail", "copy /y %~d0\\D3D8.DLL C:\\WINDOWS\\system32\\d3d8.dll", "if errorlevel 1 goto fail", "for %%g in (d e f g h i j k) do @if exist %%g:\\maplestory\\mapleStory-client\\HeavenMS-localhost-WINDOW.exe set GAME=%%g:\\maplestory\\mapleStory-client", "if not defined GAME goto fail", "cd /d %GAME%", "HeavenMS-localhost-WINDOW.exe"],
};
for(const version of ["03", "05", "06"]) {
    const folder = "MARK" + version;
    commands[folder] = [
        "set GAME=",
        `for %%g in (d e f g h i j k) do @if exist %%g:\\3DMark${version}.exe set GAME=%%g:`,
        `for %%g in (d e f g h i j k) do @if exist %%g:\\${folder}\\3DMark${version}.exe set GAME=%%g:\\${folder}`,
        "if not defined GAME goto fail",
        // 05's bundled Boost rejects its own executable path when CWD is a
        // drive root. Rename only benchmark files/directories within the RAM
        // overlay: no multi-GB copy and no original image modification.
        ...(version === "03" ? [] : [
            `if /i "%GAME:~-6%"=="${folder}" goto ready${version}`,
            `if not exist "%GAME%\\${folder}" mkdir "%GAME%\\${folder}"`,
            "if errorlevel 1 goto fail",
            `for %%f in (3DMark${version}.exe 3DMark${version}.dat 3DMark${version}.ico demo.dat patch1.dat patch2.dat sponsored.dat Exporter.dll MFC71.dll msvcp71.dll msvcr71.dll NxCharacter.dll NxCooking.dll PhysXCore.dll PhysXLoader.dll SI3.dll) do @if exist "%GAME%\\%%f" (move /y "%GAME%\\%%f" "%GAME%\\${folder}\\" >nul || goto fail)`,
            `for %%f in (Help systeminfo) do @if exist "%GAME%\\%%f" (move "%GAME%\\%%f" "%GAME%\\${folder}\\" >nul || goto fail)`,
            `set GAME=%GAME%\\${folder}`,
            `:ready${version}`,
        ]),
        'copy /y %~d0\\D3D9.DLL "%GAME%\\d3d9.dll"',
        "if errorlevel 1 goto fail", 'cd /d "%GAME%\\"', `"%GAME%\\3DMark${version}.exe"`,
    ];
}
const files = ["D3D9.DLL", "D3D8.DLL", "DDRAW.DLL", "GINPUT.EXE", "BENCHUI.EXE", "SOUNDCAP.EXE"].map(name => ({ name, contents: fs.readFileSync(out + name) }));
files.push({name:"V86GL.SYS",contents:fs.readFileSync(site+"/glbridge/v86gl_driver/v86gl.sys")});
for(const [name, command] of Object.entries(commands)) files.push({ name: name + ".CMD", contents: Buffer.from(["@echo off", "sc stop v86gl", "copy /y %~d0\\V86GL.SYS C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto fail", ...command, "goto end", ":fail", "echo FAIL game setup", ":end", ""].join("\r\n")) });
fs.writeFileSync(out + "tools.iso", Buffer.from(generate(files)));
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
fs.writeFileSync(out + "inputs.json", JSON.stringify({ images: Object.fromEntries(["windowsxp/windowsxp_multidisk_C_4G.img", "game/warcraft3.img", "game/gtasa.img", "game/3dmarklegacy.img", "game/3dmark03.img", "game/3dmark05.img", "game/3dmark06.img", "game/maplestory.img"].map(name => {
    const stat = fs.statSync(site + "/" + name);return [name, { size: stat.size, mtimeMs: stat.mtimeMs }];
})), files: files.map(f => ({ name: f.name, bytes: f.contents.length, sha256: hash(f.contents) })) }, null, 2) + "\n");
console.log("Prepared " + path.relative(root, out) + " with current guest DLLs; image writes remain RAM overlays");
