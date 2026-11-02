#!/usr/bin/env node
import fs from "node:fs";
import {createHash} from "node:crypto";
const input=fs.readFileSync(new URL("../tests/glbridge/fixtures/d3d_buffer_lock_reference.json",import.meta.url)),r=JSON.parse(input);
const lines=["/* Frozen XP HRESULT and independent Wine access-policy facts; not production metadata."," * Source SHA-256: "+createHash("sha256").update(input).digest("hex")+" */","struct BufferLockReferenceContext {uint32_t pool,usage,effective[8];};","static const struct BufferLockReferenceContext contexts[] = {"];
for(const row of r.contexts)lines.push("    {"+row.pool+"u, "+row.usage+"u, {"+row.effective.map(x=>x+"u").join(", ")+"}},");
lines.push("};");for(const [name,values]of [["flags",r.flags],["advisory",r.ignoredBits],["nativeFlags",r.windowsXP.map(c=>c.flags)]])lines.push("static const uint32_t "+name+"[] = {"+values.map(x=>x+"u").join(", ")+"};");
const output=lines.join("\n")+"\n";if(process.argv[2])fs.writeFileSync(process.argv[2],output);else process.stdout.write(output);
