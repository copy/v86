#!/usr/bin/env node
// Test-only expectations: independent SDK geometry and frozen frontend ranges.
import fs from "node:fs";
const r = JSON.parse(fs.readFileSync(new URL("../tests/glbridge/fixtures/d3d_format_layout_reference.json", import.meta.url)));
const lines = ["/* Independent test facts; never generated from production layout data. */", "struct FormatLayoutReference {DWORD format;UINT width,height,bytes,apis;};", "static const struct FormatLayoutReference format_layout_reference[] = {"];
for (const row of r.geometry) { const mask = [7, 8, 9].reduce((n, api) => n | (r.frontendFormats[api].includes(row[0]) ? 1 << (api - 7) : 0), 0); lines.push("    {" + [...row, mask].map(n => n + "u").join(", ") + "},"); }
lines.push("};", ""); const text = lines.join("\n"); if (process.argv[2]) fs.writeFileSync(process.argv[2], text); else process.stdout.write(text);
