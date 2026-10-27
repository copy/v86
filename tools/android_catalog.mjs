#!/usr/bin/env node
// The Android catalog's entries checked (docs/android-images-plan.md I7.1,
// src/app/android_catalog.js): each part's size and SHA-256 against a local
// copy where there is one (build/a64-android/dl/ and dl/gsi/, or --dir),
// else its size against the server (HEAD, redirects followed); nothing is
// downloaded.
//
//   node tools/android_catalog.mjs [--dir <directory>]...

import fs from "node:fs";
import path from "node:path";
import { createHash as create_hash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ANDROID_CATALOG } from "../src/app/android_catalog.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") + "/";
const args = process.argv.slice(2);
const dirs = [ROOT + "build/a64-android/dl/", ROOT + "build/a64-android/dl/gsi/", ROOT + "build/a32-android/"];
for(let i = 0; i < args.length; i++)
{
    if(args[i] === "--dir") dirs.push(path.resolve(args[++i]) + "/");
    else throw new Error("node tools/android_catalog.mjs [--dir <directory>]...");
}

function sha256_file(file)
{
    const hash = create_hash("sha256");
    const fd = fs.openSync(file, "r");
    const chunk = Buffer.alloc(16 << 20);
    for(let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0;) hash.update(chunk.subarray(0, n));
    fs.closeSync(fd);
    return hash.digest("hex");
}

const checked = new Map();
let failed = 0;
for(const entry of ANDROID_CATALOG.entries)
{
    console.log(entry.id + ": " + entry.title);
    for(const part of entry.parts)
    {
        if(!checked.has(part.sha256))
        {
            const local = dirs.map(d => d + part.name).find(f => fs.existsSync(f));
            let result;
            if(local)
            {
                const size = fs.statSync(local).size, sha256 = size === part.size ? sha256_file(local) : "";
                result = size !== part.size ? `local ${size} bytes, the catalog says ${part.size}` : sha256 !== part.sha256 ? "local SHA-256 " + sha256 : "";
                result = result ? "FAIL: " + result : "ok (local copy: size and SHA-256)";
            }
            else
            {
                try
                {
                    const response = await fetch(part.url, { method: "HEAD", redirect: "follow" });
                    const size = +response.headers.get("content-length");
                    result = !response.ok ? "FAIL: HTTP " + response.status : size !== part.size ? `FAIL: the server's ${size} bytes` : "ok (the server's size)";
                }
                catch(e)
                {
                    result = "FAIL: " + e.message;
                }
            }
            checked.set(part.sha256, result);
        }
        const result = checked.get(part.sha256);
        if(result.startsWith("FAIL")) failed++;
        console.log(`  ${part.role}${part.optional ? " (optional)" : ""} ${part.name}: ${result}`);
    }
}
console.log(failed ? failed + " parts failed" : "every part checked");
process.exit(failed ? 1 : 0);
