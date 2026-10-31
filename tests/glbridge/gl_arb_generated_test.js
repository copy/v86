"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),{execFileSync}=require("node:child_process"),
 {createHash}=require("node:crypto"),arb=require("../../src/browser/glbridge/gl-webgpu/gl_arb_program.js"),corpus=require("./arb_corpus/programs.json"),
 reference=require("./gl_conformance/arb_corpus_reference.json"),rectangle=require("./gl_conformance/rectangle_reference.json"),
 mesa=JSON.parse(require("node:zlib").gunzipSync(fs.readFileSync(path.join(__dirname,"gl_conformance/mesa_reference.json.gz")))).fixtures,
 naga=require("./naga.js").requireNaga("Wine/cgc corpus"),dir=fs.mkdtempSync(path.join(os.tmpdir(),"arb-corpus-"));
assert.equal(corpus.records.length,20);assert.match(corpus.compiler_sha256,/^[0-9a-f]{64}$/);assert.match(corpus.wine_sha256,/^[0-9a-f]{64}$/);
execFileSync(process.execPath,[path.join(__dirname,"gl_conformance/reference/gen_arb_corpus_c.js"),"--check"]);
for (const row of corpus.records){
 if (row.input)assert.equal(createHash("sha256").update(row.input).digest("hex"),row.input_sha256,row.name);
 const compiled=arb.compileARBProgram(row.source);assert.ok(compiled.ok,row.name+": "+compiled.log);const file=path.join(dir,row.name+".wgsl");fs.writeFileSync(file,compiled.wgsl);execFileSync(naga,[file],{stdio:"pipe"});
 const apple=reference.cases.find(c=>c.name===row.name),other=mesa.arb_corpus.cases.find(c=>c.name===row.name);assert.equal(apple.compileError,0);assert.equal(other.compileError,0);assert.equal(apple.position,-1);assert.equal(other.position,-1);assert.equal(apple.error,0);assert.equal(other.error,0);assert.equal(apple.rgba,other.rgba,row.name+" independent native pixels");
}
for (const row of rectangle.cases){const other=mesa.rectangle.cases.find(c=>c.name===row.name);assert.equal(row.error,0);assert.equal(other.error,0);assert.equal(row.rgba,other.rgba,row.name+" independent native pixels");}
for (const bad of ["2DA","NOTCUBE","RECTBAD","SHADOW0","rect","2d"])assert.equal(arb.compileARBProgram("!!ARBfp1.0\nTEX result.color,fragment.texcoord[0],texture[0],"+bad+";\nEND").ok,false,bad);
console.log("PASS 20 genuine Wine/cgc programs: source provenance, Naga, independent native compilation/pixels; RECT native pixels/target grammar");
