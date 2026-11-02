#!/usr/bin/env node
// Test-only SDK COM expectations, sourced from the independent frozen reference.
import fs from "node:fs";
const r=JSON.parse(fs.readFileSync(new URL("../tests/glbridge/fixtures/d3d_render_defaults_reference.json",import.meta.url)));
const extra={8:[[47,0],[154,0x3f800000],[172,3],[173,1]],9:[[154,0x3f800000]]};
const out=["/* Test-only Wine/SDK facts; never generated from the production defaults. */","struct RenderDefaultReference {UINT state;DWORD value;UINT context;};","static const struct RenderDefaultReference render_default_reference[] = {"];
for(const api of [8,9]){out.push((api===8?"#if":"#elif")+" D9WG_DEFAULTS_API == "+api);for(const row of r.apis[api])out.push("    {"+row.state+", "+(typeof row.value==="number"?"0x"+row.value.toString(16)+"u":"0u")+", "+(row.value==="autoDepth"?1:row.value==="pointMax"?2:0)+"}, /* "+row.name+" */");for(const [id,value] of extra[api])out.push("    {"+id+", 0x"+value.toString(16)+"u, 0}, /* DirectX SDK */");}out.push("#endif","};","");
const texture=JSON.parse(fs.readFileSync(new URL("../tests/glbridge/fixtures/d3d_texture_defaults_reference.json",import.meta.url)));
out.push("struct TextureDefaultReference {UINT state;DWORD value;UINT context;};","static const struct TextureDefaultReference texture_default_reference[] = {");
for(const [id,name,word] of texture.texture) out.push("    {"+id+", "+(typeof word==="number"?word:0)+"u, "+(word==="stage"?1:word==="colorOp"?2:word==="alphaOp"?3:0)+"}, /* "+name+" */");
out.push("#if D9WG_DEFAULTS_API == 9");for(const [id,name,word] of texture.d3d9OnlyTexture)out.push("    {"+id+", "+word+"u, 0}, /* "+name+" */");out.push("#endif","};","struct SamplerDefaultReference {UINT state;DWORD value;UINT legacy;};","static const struct SamplerDefaultReference sampler_default_reference[] = {");
for(const [id,name,word,legacy] of texture.sampler)out.push("    {"+id+", "+word+"u, "+(legacy===null?0:legacy)+"}, /* "+name+" */");out.push("};","");
const objects=JSON.parse(fs.readFileSync(new URL("../tests/glbridge/fixtures/d3d_object_defaults_reference.json",import.meta.url)));
out.push("static const DWORD material_default_reference[17] = {");
for(const api of [8,9])out.push((api===8?"#if":"#elif")+" D9WG_DEFAULTS_API == "+api,"    "+objects.materialWords[api].map(v=>"0x"+v.toString(16)+"u").join(", "));
out.push("#endif","};","");const text=out.join("\n");if(process.argv[2])fs.writeFileSync(process.argv[2],text);else process.stdout.write(text);
