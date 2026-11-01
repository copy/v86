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
for(const api of ["d3d9", "d3d8", "ddraw"]) run("sh", [site + "/glbridge/" + api + "proxy/build.sh", out + api.toUpperCase() + ".DLL"], { stdio: "inherit" });
const commands = {
    WAR3: ["copy /y %~d0\\D3D8.DLL \"D:\\Warcraft III\\d3d8.dll\"", "copy /y %~d0\\D3D9.DLL \"D:\\Warcraft III\\d3d9.dll\"", "cd /d \"D:\\Warcraft III\"", "War3.exe -window -loadfile \"Maps\\(2)PlunderIsle.w3m\""],
    GTASA: ["copy /y %~d0\\D3D9.DLL \"D:\\GTA San Andreas\\d3d9.dll\"", "cd /d \"D:\\GTA San Andreas\"", "start gta_sa.exe"],
};
const files = ["D3D9.DLL", "D3D8.DLL", "DDRAW.DLL"].map(name => ({ name, contents: fs.readFileSync(out + name) }));
for(const [name, command] of Object.entries(commands)) files.push({ name: name + ".CMD", contents: Buffer.from(["@echo off", "sc start v86gl", ...command, ""].join("\r\n")) });
fs.writeFileSync(out + "tools.iso", Buffer.from(generate(files)));
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
fs.writeFileSync(out + "inputs.json", JSON.stringify({ images: Object.fromEntries(["windowsxp/windowsxp_multidisk_C_4G.img", "game/warcraft3.img", "game/gtasa.img"].map(name => {
    const stat = fs.statSync(site + "/" + name);return [name, { size: stat.size, mtimeMs: stat.mtimeMs }];
})), files: files.map(f => ({ name: f.name, bytes: f.contents.length, sha256: hash(f.contents) })) }, null, 2) + "\n");
console.log("Prepared " + path.relative(root, out) + " with current guest DLLs; image writes remain RAM overlays");
