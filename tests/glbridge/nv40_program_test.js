#!/usr/bin/env node
const assert = require("node:assert/strict");
(async () => {
const {decode_vertex_instruction,decode_vertex_program,decode_fragment_program} = await import("../../src/graphics_adapters/geforce_6800/nv40_program.js");
// Hand-encoded MOV oPos.xyzw, v0, with LAST. Unused scalar operands are invalid
// selectors and must not turn a valid vector-only instruction into an error.
const mov=Uint32Array.of(0x401F9C6C,0x0040000D,0x81000000,0x0001EF81);
const vertex=decode_vertex_program(mov),v=vertex.instructions[0];
assert.equal(v.vector.name,"MOV");assert.equal(v.vector.type,"output");assert.equal(v.vector.index,0);assert.equal(v.vector.mask,15);
assert.deepEqual(v.sources[0],{type:"input",index:0,swizzle:[0,1,2,3],negate:false,absolute:false});
assert.equal(v.scalar.name,"NOP");assert.equal(vertex.word_count,4);assert.equal(v.end,true);
const dual=decode_vertex_instruction(Uint32Array.of(0x06E11C6C,0x0880730D,0x8106C0E3,0x60AB427D));
assert.equal(dual.vector.name,"MUL");assert.equal(dual.scalar.name,"MOV");assert.equal(dual.sources[1].type,"constant");
assert.equal(dual.sources[1].index,7);assert.equal(dual.sources[0].index,3);assert.equal(dual.sources[2].negate,true);
assert.equal(dual.saturate,true);assert.equal(dual.predicate.register,1);assert.equal(dual.sources[0].absolute,true);
assert.throws(()=>decode_vertex_program(Uint32Array.of(0,0,0,0)),/no end/);
assert.throws(()=>decode_vertex_program(Uint32Array.of(0,0,0)),/size/);
// MOV H0, inline_constant. Data resembling opcodes must stay out of the decoder
// and out of the cache key; different constants share the normalized program.
const fp=Uint32Array.of(0x01001E81,0x001DC802,0,0,0x3F800000,0x3F000000,0,0x3F800000);
const fragment=decode_fragment_program(fp);assert.equal(fragment.instructions.length,1);
assert.equal(fragment.instructions[0].name,"MOV");assert.equal(fragment.instructions[0].destination.half,true);
assert.equal(fragment.instructions[0].destination.mask,15);assert.equal(fragment.word_count,8);
assert.deepEqual(fragment.constants[0],[0x3F800000,0x3F000000,0,0x3F800000]);
const changed=fp.slice();changed[4]=0x40000000;
assert.deepEqual(decode_fragment_program(changed).normalized,fragment.normalized);
assert.throws(()=>decode_fragment_program(fp.subarray(0,6)),/truncated/);
// A branch's offsets may have low bits 2. They are control data, not a literal.
const branch=decode_fragment_program(Uint32Array.of(0x02000001,0,0x80000002,6));
assert.equal(branch.instructions[0].name,"IF");assert.equal(branch.constants.length,0);assert.equal(branch.word_count,4);
console.log("PASS: NV40 VP/FP decoding, VLIW fields, swizzles, inline constants and constant-independent keys");

})().catch(error=>{console.error(error);process.exitCode=1;});
