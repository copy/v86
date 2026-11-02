#!/usr/bin/env node
// Test-only SDK COM expectations, sourced from the independent frozen reference.
import fs from "node:fs";
const r=JSON.parse(fs.readFileSync(new URL("../tests/glbridge/fixtures/d3d_render_defaults_reference.json",import.meta.url)));
const extra={8:[[47,0],[154,0x3f800000],[172,3],[173,1]],9:[[154,0x3f800000]]};
const out=["/* Test-only Wine/SDK facts; never generated from the production defaults. */","struct RenderDefaultReference {UINT state;DWORD value;UINT context;};","static const struct RenderDefaultReference render_default_reference[] = {"];
for(const api of [8,9]){out.push((api===8?"#if":"#elif")+" D9WG_DEFAULTS_API == "+api);for(const row of r.apis[api])out.push("    {"+row.state+", "+(typeof row.value==="number"?"0x"+row.value.toString(16)+"u":"0u")+", "+(row.value==="autoDepth"?1:row.value==="pointMax"?2:0)+"}, /* "+row.name+" */");for(const [id,value] of extra[api])out.push("    {"+id+", 0x"+value.toString(16)+"u, 0}, /* DirectX SDK */");}out.push("#endif","};","");const text=out.join("\n");if(process.argv[2])fs.writeFileSync(process.argv[2],text);else process.stdout.write(text);
