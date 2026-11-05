import assert from "node:assert/strict";
import pipeline from "../../src/browser/glbridge/d3d9-webgpu/d3d9_shader_pipeline.js";
import {execute_shader} from "../lib/d3d_shader_reference.mjs";
import {shader,src,dst,numerical_cases,numerical_inputs} from "../lib/d3d_shader_cases.mjs";
const run=(tokens,input)=>execute_shader(pipeline.parseShader(tokens),input).read(0,0);
assert.deepEqual(run(shader("vertex",2,[[2,dst(0,0),src(2,0),src(2,1)]]),{f:[[1,2,3,4],[5,6,7,8]]}),[6,8,10,12]);
assert.deepEqual(run(shader("pixel",1,[[1,dst(0,0),src(2,0)]]),{f:[[-2,-0.5,0.5,2]]}),[-1,-0.5,0.5,1]);
assert.deepEqual(run(shader("vertex",2,[[1,dst(0,0),src(2,1)],[1,dst(0,0,5),src(2,0,0x1b,1)]]),{f:[[1,2,3,4],[10,20,30,40]]}),[-4,20,-2,40]);
// Independent closed-form result: outer contributes twice (1+2+3), inner
// contributes (5+6) three times. r0 begins at constant c3 = 4.
for(const test of numerical_cases().filter(x=>x.name.includes("nested-loop"))) {
    const early=test.name.endsWith("true");
    assert.deepEqual(run(test.tokens,{f:Array.from({length:8},(_,i)=>[i+1,i+1,i+1,i+1]),i:[[3,0,1,0],[2,4,1,0]]}),Array(4).fill(4+12+(early?15:33)),test.name);
}
let executions=0;
for(const test of numerical_cases())for(const input of numerical_inputs()) {run(test.tokens,input);executions++;}
console.log(`PASS independent shader arithmetic/flow reference: ${executions} executions and hand-calculated contracts`);
