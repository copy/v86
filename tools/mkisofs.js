#!/usr/bin/env node

import fs from "node:fs";
import cp from "node:child_process";

import * as iso9660 from "../src/iso9660.js";

// this tool is for testing, v86 in browser already has this built-in
// usage: mkisofs.js [files...]

const files = process.argv.slice(2);
const iso = iso9660.generate(files.map(name => ({ name, contents: fs.readFileSync(name) })));

fs.writeFileSync("test.iso", iso);
console.log("test.iso written");

//cp.spawnSync("mkisofs", ["-o", "reference.iso"].concat(files), { stdio: "inherit" });
cp.spawnSync("7z", ["l", "test.iso"], { stdio: "inherit" });
//cp.spawnSync("diff", ["<(hexdump reference.iso)", "<(hexdump test.iso)"], { stdio: "inherit", shell: true });
