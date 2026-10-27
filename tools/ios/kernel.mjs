#!/usr/bin/env node
// A decompressed kernelcache, described (docs/iphone4-plan.md S0;
// src/apple/macho.js):
//
//   node tools/ios/kernel.mjs <kernelcache.macho> info          segments, entry point, UUID
//   node tools/ios/kernel.mjs <kernelcache.macho> kexts         the prelinked kexts
//   node tools/ios/kernel.mjs <kernelcache.macho> personalities what each kext's drivers match
//   node tools/ios/kernel.mjs <kernelcache.macho> strings <re>  C strings matching a pattern, with addresses

import fs from "node:fs";
import { macho_parse, macho_section } from "../../src/apple/macho.js";
import { plist_parse } from "../../src/ios/plist.js";

const [file, command = "info", pattern] = process.argv.slice(2);
if(!file || !["info", "kexts", "personalities", "strings"].includes(command)) throw new Error("node tools/ios/kernel.mjs <kernelcache.macho> info|kexts|personalities|strings [<re>]");
const bytes = new Uint8Array(fs.readFileSync(file));
const kernel = macho_parse(bytes);
const hex = x => "0x" + (x >>> 0).toString(16).padStart(8, "0");

const prelink = () =>
{
    const info = macho_section(bytes, kernel, "__PRELINK_INFO", "__info");
    if(!info) throw new Error("no __PRELINK_INFO,__info");
    const end = info.indexOf(0);
    return plist_parse(info.subarray(0, end < 0 ? info.length : end))._PrelinkInfoDictionary;
};

if(command === "info")
{
    console.log(`cputype ${kernel.cputype} subtype ${kernel.cpusubtype} filetype ${kernel.filetype} flags ${hex(kernel.flags)} uuid ${kernel.uuid}`);
    console.log(`entry ${hex(kernel.entry)}; thread state ${kernel.thread?.state.map(hex).join(" ")}`);
    for(const s of kernel.segments)
    {
        console.log(`${s.name.padEnd(16)} vm ${hex(s.vmaddr)}+${hex(s.vmsize)} file ${hex(s.fileoff)}+${hex(s.filesize)} prot ${s.initprot}/${s.maxprot}`);
        for(const c of s.sections) console.log(`    ${c.name.padEnd(18)} ${hex(c.addr)}+${hex(c.size)} offset ${hex(c.offset)}`);
    }
}
else if(command === "kexts")
{
    for(const k of prelink())
    {
        console.log(`${(k.CFBundleIdentifier || "?").padEnd(56)} ${String(k.CFBundleVersion || "").padEnd(12)} ` +
            (k._PrelinkExecutableLoadAddr !== undefined ? `${hex(Number(k._PrelinkExecutableLoadAddr))}+${hex(Number(k._PrelinkExecutableSize))}` : "(no executable)"));
    }
}
else if(command === "personalities")
{
    for(const k of prelink())
    {
        for(const [name, p] of Object.entries(k.IOKitPersonalities || {}))
        {
            const match = ["IONameMatch", "IOProviderClass", "IOPropertyMatch", "IOResourceMatch", "IOClass", "IOProbeScore"]
                .filter(key => p[key] !== undefined).map(key => `${key}=${JSON.stringify(p[key], (_, v) => typeof v === "bigint" ? String(v) : v)}`).join(" ");
            console.log(`${k.CFBundleIdentifier}: ${name}: ${match}`);
        }
    }
}
else
{
    const re = new RegExp(pattern || ".");
    for(const s of kernel.segments)
    {
        for(let at = s.fileoff, end = s.fileoff + s.filesize; at < end; at++)
        {
            if(bytes[at] < 0x20 || bytes[at] >= 0x7F) continue;
            let e = at;
            while(e < end && bytes[e] >= 0x20 && bytes[e] < 0x7F || bytes[e] === 9 || bytes[e] === 10) e++;
            if(e - at >= 4 && bytes[e] === 0)
            {
                const text = String.fromCharCode(...bytes.subarray(at, e));
                if(re.test(text)) console.log(`${hex(s.vmaddr + at - s.fileoff)} ${JSON.stringify(text)}`);
            }
            at = e;
        }
    }
}
