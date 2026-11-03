#!/usr/bin/env node
import fs from "node:fs";
import {createHash} from "node:crypto";
const bytes=fs.readFileSync(new URL("../tests/glbridge/fixtures/d3d_mapped_draw_reference.json",import.meta.url)),reference=JSON.parse(bytes),lines=["/* Independent mapped-write inputs/geometry; source SHA-256: "+createHash("sha256").update(bytes).digest("hex")+" */","struct MappedDrawCase {uint32_t usage,flags,partial,index32,mixed,readonly,rewrite,index_mode,initial_left,initial_right,next_left,next_right,left[3],right[3];};","static const struct MappedDrawCase mapped_cases[] = {"];
for(const s of reference.scenes)lines.push("    {"+[s.usage,s.flags,s.partial,s.index32,s.mixed,s.readonly,s.rewrite,s.indexMode,s.initialLeft,s.initialRight,s.nextLeft,s.nextRight].map(n=>n+"u").join(", ")+", {"+s.frames.map(f=>f.leftARGB+"u").join(", ")+"}, {"+s.frames.map(f=>f.rightARGB+"u").join(", ")+"}},");
lines.push("};");const output=lines.join("\n")+"\n";if(process.argv[2])fs.writeFileSync(process.argv[2],output);else process.stdout.write(output);
