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
for(let unit=0;unit<4;unit++)
{
    const instruction=mov.slice();instruction[1]=(instruction[1]&~(31<<22))|25<<22;instruction[2]|=unit<<8;
    const decoded=decode_vertex_instruction(instruction);assert.equal(decoded.vector.name,"TXL");assert.equal(decoded.texture,unit);
    assert.deepEqual(decoded.sources[0],v.sources[0],"texture selection does not alter the coordinate operand");
}
const dual=decode_vertex_instruction(Uint32Array.of(0x06E11C6C,0x0880730D,0x8106C0E3,0x60AB427D));
assert.equal(dual.vector.name,"MUL");assert.equal(dual.scalar.name,"MOV");assert.equal(dual.sources[1].type,"constant");
assert.equal(dual.sources[1].index,7);assert.equal(dual.sources[0].index,3);assert.equal(dual.sources[2].negate,true);
assert.equal(dual.saturate,true);assert.equal(dual.predicate.register,1);assert.equal(dual.sources[0].absolute,true);
assert.throws(()=>decode_vertex_program(Uint32Array.of(0,0,0,0)),/no end/);
assert.throws(()=>decode_vertex_program(Uint32Array.of(0,0,0)),/size/);
const jump=Uint32Array.of(7<<10,9<<27,0,2<<29);
const jumped=decode_vertex_program(Uint32Array.from([...jump,0,0,0,0,...mov]));
assert.deepEqual(jumped.instructions.map(i=>i.pc),[0,2],"decoder follows branches over unreachable storage");
const call=Uint32Array.of(7<<10,11<<27,0,3<<29),ret=Uint32Array.of(7<<10,12<<27,0,0);
const called=decode_vertex_program(Uint32Array.from([...call,...mov,0,0,0,0,...ret]));
assert.deepEqual(called.instructions.map(i=>i.pc),[0,1,3],"call targets after the main END remain reachable");
assert.equal(decode_vertex_program(ret).instructions[0].scalar.name,"RET","an empty-stack return is a normal terminal instruction");
// MOV H0, inline_constant. Data resembling opcodes must stay out of the decoder
// and out of the cache key; different constants share the normalized program.
const fp=Uint32Array.of(0x01001E81,0x001DC802,0,0,0x3F800000,0x3F000000,0,0x3F800000);
const fragment=decode_fragment_program(fp);assert.equal(fragment.instructions.length,1);
assert.equal(fragment.instructions[0].name,"MOV");assert.equal(fragment.instructions[0].destination.half,true);
assert.equal(fragment.instructions[0].destination.mask,15);assert.equal(fragment.word_count,8);
assert.deepEqual(fragment.constants[0],[0x3F800000,0x3F000000,0,0x3F800000]);
const changed=fp.slice();changed[4]=0x40000000;
assert.deepEqual(decode_fragment_program(changed).normalized,fragment.normalized);
const dp2=fp.slice();dp2[0]=(dp2[0]&0xFFFFFF)|0x38000000;
assert.equal(decode_fragment_program(dp2).instructions[0].name,"DP2");
assert.throws(()=>decode_fragment_program(fp.subarray(0,6)),/truncated/);
// A branch's offsets may have low bits 2. They are control data, not a literal.
const branch=decode_fragment_program(Uint32Array.of(0x02000001,0,0x80000002,6));
assert.equal(branch.instructions[0].name,"IF");assert.equal(branch.constants.length,0);assert.equal(branch.word_count,4);
const repeat=decode_fragment_program(Uint32Array.of(0x04000001,7<<18,0x80000000|3<<2|4<<10|2<<19,4));
assert.deepEqual(repeat.instructions[0].loop,{count:3,initial:4,increment:2});
const banks=fp.slice();banks[1]|=0xC0000000;
assert.equal(decode_fragment_program(banks).instructions[0].predicate.register,1);
assert.equal(decode_fragment_program(banks).instructions[0].predicate.destination,1);
const fpRet=[5<<24,7<<18,0x80000000,0];
const fpCall=Uint32Array.from([1<<24,7<<18,0x80000000|12,0,...fp,
    ...[fp[0]&~1,...fp.slice(1)],...fpRet]);
const fpCalled=decode_fragment_program(fpCall);
assert.deepEqual(fpCalled.instructions.map(i=>i.pc),[0,4,12,20]);assert.equal(fpCalled.constants.length,2);
assert.equal(fpCalled.word_count,24);assert.equal(decode_fragment_program(Uint32Array.from(fpRet)).instructions.length,1);
const fetches=[];
assert.deepEqual(decode_fragment_program([],at=>{fetches.push(at);return fpCall.slice(at,at+4);}),fpCalled);
assert.deepEqual(fetches,[0,4,8,12,16,20],"the guest fetch stops after the reachable callee's RET");
const badTarget=fpCall.slice();badTarget[2]=0x80000000|8;
assert.throws(()=>decode_fragment_program(badTarget),/inline constant|outside program|truncated/);

const selectOnly=decode_vertex_instruction(Uint32Array.of(0x20000000,0,0,1));
assert.equal(selectOnly.predicate.update,false,"CDST_IS_VEC selects a slot, without enabling a condition write");
assert.equal(selectOnly.predicate.vector,true);
const scalarCC=decode_vertex_instruction(Uint32Array.of(0x4000,0,0,1));
assert.equal(scalarCC.predicate.update,true);assert.equal(scalarCC.predicate.vector,false);

console.log("PASS: NV40 VP/FP decoding, VLIW fields, swizzles, inline constants and constant-independent keys");

})().catch(error=>{console.error(error);process.exitCode=1;});
