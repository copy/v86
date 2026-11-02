#!/usr/bin/env node
import fs from "node:fs";
const r=JSON.parse(fs.readFileSync(new URL("../tests/glbridge/fixtures/d3d_autogen_reference.json",import.meta.url))),l=JSON.parse(fs.readFileSync(new URL("../tests/glbridge/fixtures/d3d_format_layout_reference.json",import.meta.url)));
const lines=["/* Independent SDK/Wine probe facts, not production metadata. */","struct AutoGenReference {DWORD format;UINT generates,float32;};","static const struct AutoGenReference autogen_reference[] = {"];
for(const format of l.frontendFormats[9])lines.push("    {"+[format,Number(r.generationFormats.includes(format)),Number(r.float32Formats.includes(format))].map(n=>n+"u").join(", ")+"},");
lines.push("};","");const text=lines.join("\n");if(process.argv[2])fs.writeFileSync(process.argv[2],text);else process.stdout.write(text);
