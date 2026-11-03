#!/usr/bin/env node
import fs from "node:fs";
import {createHash} from "node:crypto";
const bytes=fs.readFileSync(new URL("../tests/glbridge/fixtures/d3d_texture_copy_reference.json",import.meta.url)),r=JSON.parse(bytes),lines=["/* Independent UpdateTexture inputs/geometry; source SHA-256: "+createHash("sha256").update(bytes).digest("hex")+" */","struct TextureCopySample {uint32_t mip,face,slice,color;};","struct TextureCopyCase {uint32_t kind,sw,sh,sd,sl,dw,dh,dd,dl,usage,first,count;};","static const uint32_t copy_palette[] = {"+r.paletteARGB.map(n=>n+"u").join(", ")+"};","static const uint32_t copy_sentinel = "+r.sentinelARGB+"u;","static const struct TextureCopySample copy_samples[] = {"];
for(const s of r.scenes)for(const f of s.frames)lines.push("    {"+[f.mip,f.face,f.slice,f.expectedARGB].map(n=>n+"u").join(", ")+"},");lines.push("};","static const struct TextureCopyCase copy_cases[] = {");let first=0;
for(const s of r.scenes){const a=s.source,b=s.destination;lines.push("    {"+[s.kind,a.width,a.height,a.depth,a.levels,b.width,b.height,b.depth,b.levels,s.usage,first,s.frames.length].map(n=>n+"u").join(", ")+"},");first+=s.frames.length;}
lines.push("};");const output=lines.join("\n")+"\n";if(process.argv[2])fs.writeFileSync(process.argv[2],output);else process.stdout.write(output);
