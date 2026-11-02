#!/usr/bin/env node
import fs from "node:fs";
const r = JSON.parse(fs.readFileSync(new URL("../tests/glbridge/fixtures/d3d_format_query_reference.json", import.meta.url))), layout = JSON.parse(fs.readFileSync(new URL("../tests/glbridge/fixtures/d3d_format_layout_reference.json", import.meta.url)));
const colors = layout.frontendFormats[9], formats = [...colors, ...r.comparisonDepthFormats, ...r.rawDepthFormats, 0x4c4c554e, 0xffffffff];
const lines = ["/* Independent test facts, not production query metadata. */", "struct FormatQueryReference {DWORD format;UINT color,depth,raw,srgb,float32,target,bc;};", "static const struct FormatQueryReference format_query_reference[] = {"];
for (const format of formats) lines.push("    {" + [format, Number(colors.includes(format)), Number(r.comparisonDepthFormats.includes(format)), Number(r.rawDepthFormats.includes(format)), Number(r.srgbStorageFormats.includes(format)), Number(r.float32Formats.includes(format)), Number(r.renderTargetFormats.includes(format)), Number(r.nativeBCFormats.includes(format))].map(n => n + "u").join(", ") + "},");
lines.push("};", "static const DWORD query_bit_reference[] = {" + Object.values(r.queryBits).map(n => n + "u").join(", ") + "};", "");
const text = lines.join("\n"); if (process.argv[2]) fs.writeFileSync(process.argv[2], text); else process.stdout.write(text);
