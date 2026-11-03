#!/usr/bin/env node
import fs from "node:fs";
import {createHash} from "node:crypto";
const bytes=fs.readFileSync(new URL("../tests/glbridge/fixtures/d3d_draw_hints_reference.json",import.meta.url)),reference=JSON.parse(bytes);
const lines=["/* Independent draw input/geometry facts; source SHA-256: "+createHash("sha256").update(bytes).digest("hex")+" */","struct DrawHintCase {int32_t base;uint32_t first,count,start,primitives,left,right,mode;};","static const struct DrawHintCase draw_cases[] = {"];
for(const s of reference.scenes)lines.push("    {"+[s.baseVertex===-2147483648?"(-2147483647 - 1)":String(s.baseVertex),...[s.minVertex,s.numVertices,s.startIndex,s.primitiveCount,s.leftARGB,s.rightARGB,s.mode].map(v=>v+"u")].join(", ")+"},");
lines.push("};");const output=lines.join("\n")+"\n";if(process.argv[2])fs.writeFileSync(process.argv[2],output);else process.stdout.write(output);
