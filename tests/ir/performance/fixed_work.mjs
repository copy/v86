// Equal guest work, warmed code, fresh VM for each core. No timer-limited loops.
// Measures the IR region tiers (ir_tier0 off). An interpreter-only arm is the
// architectural reference. Correctness and warmup failures fail the process;
// speed is reported against an optional baseline core.
import assert from "node:assert/strict";
import fs from "node:fs";
import { finish_halted_timing } from "./timing.mjs";
import {V86} from "../../../build/libv86.mjs";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const repetitions=Number(process.env.IR_COMPARE_RUNS||3);
assert(Number.isInteger(repetitions)&&repetitions>=3);
const PC=0x100000,PEER=0x102000,DATA=0x110000;
const suite=process.env.IR_FIXED_SUITE||"core";
assert(["core","vector","fp_helpers","game"].includes(suite),"IR_FIXED_SUITE must be core, vector, fp_helpers or game");
// Promotion normally waits for 65536 record hits (XP boot policy). Warm runs
// here execute each entry far fewer times, so measure Tier-2 explicitly.
const promotion_threshold=Number(process.env.IR_PROMOTION_THRESHOLD||256);
const fpu_suite=suite==="fp_helpers"||suite==="game";
// Shapes of 2004-era game inner loops: x87 dot products with memory operands
// (no FNINIT), and near CALL/RET pairs that cross region boundaries.
const workloads=suite==="game"?[
 {name:"x87_dot_f32",code:[0xD9,0x06,0xD8,0x0F,0xD9,0x46,0x04,0xD8,0x4F,0x04,0xDE,0xC1,0xD9,0x46,0x08,0xD8,0x4F,0x08,0xDE,0xC1,0xD9,0x5E,0x0C,0x49,0x75,0xE6,0xF4],iterations:1000000,per:11,edi:DATA+0x40},
 {name:"x87_dot_f64",code:[0xDD,0x46,0x10,0xDC,0x4F,0x10,0xDD,0x46,0x18,0xDC,0x4F,0x18,0xDE,0xC1,0xD8,0xC0,0xDD,0x5E,0x20,0x49,0x75,0xEA,0xF4],iterations:1000000,per:9,edi:DATA+0x40},
 {name:"x87_mixed",code:[0xD9,0x06,0xD8,0xC8,0xD9,0xC0,0xDE,0xC9,0xD9,0xE1,0xD8,0x07,0xD9,0x5E,0x30,0x49,0x75,0xEE,0xF4],iterations:1000000,per:9,edi:DATA+0x40},
 {name:"call_ret",code:[0xE8,0x04,0,0,0,0x49,0x75,0xF8,0xF4,0x01,0xD8,0xC3],iterations:3000000,per:5},
]:suite==="fp_helpers"?[
 {name:"x87_register",code:[0xDB,0xE3,0xD9,0xE8,0xDD,0xD8,0x49,0x75,0xF7,0xF4],iterations:1000000,per:5},
 {name:"mmx_register",code:[0x0F,0x6E,0xC0,0x0F,0x73,0xF0,0x01,0x0F,0x7E,0xC0,0x40,0x0F,0x77,0x49,0x75,0xF0,0xF4],iterations:1000000,per:7},
]:suite==="vector"?[
 {name:"sse_packed_double",code:[0x66,0x0F,0x58,0xC1,0x49,0x75,0xF9,0xF4],iterations:2000000,per:3,source:[0,0x3FF00000,0,0x3FF00000]},
 {name:"sse_scalar_single",code:[0xF3,0x0F,0x58,0xC1,0x49,0x75,0xF9,0xF4],iterations:2000000,per:3,destination:[0,0x7F812345,0xDEADBEEF,0x81234567]},
 {name:"sse_scalar_double",code:[0xF2,0x0F,0x58,0xC1,0x49,0x75,0xF9,0xF4],iterations:2000000,per:3,source:[0,0x3FF00000,0x7FF12345,0xDEADBEEF],destination:[0,0,0x7FF12345,0xDEADBEEF]},
 {name:"xmm_store",code:[0x0F,0x11,0x06,0x49,0x75,0xFA,0xF4],iterations:1000000,per:3,destination:[0x12345678,0x9ABCDEF0,0x3456789A,0xBCDEF012]},
 {name:"xmm_high_store",code:[0x0F,0x17,0x06,0x49,0x75,0xFA,0xF4],iterations:1000000,per:3,destination:[0x12345678,0x9ABCDEF0,0x3456789A,0xBCDEF012]},
 {name:"xmm_masked_store",code:[0x66,0x0F,0xF7,0xC1,0x49,0x75,0xF9,0xF4],iterations:1000000,per:3,edi:DATA,source:[0x80808080,0x80808080,0x80808080,0x80808080],destination:[0x12345678,0x9ABCDEF0,0x3456789A,0xBCDEF012]},
]:[
 {name:"integer",code:[0x01,0xD8,0x31,0xD0,0x43,0x49,0x75,0xF8,0xF4],iterations:5000000,per:5},
 {name:"ram_rmw",code:[0xFF,0x06,0x8B,0x06,0x01,0xC3,0x49,0x75,0xF7,0xF4],iterations:3000000,per:5},
 {name:"indirect_regions",code:[0x40,0xFF,0xE2],peer:[0x49,0x74,0x02,0xFF,0xE3,0xF4],iterations:3000000,per:5},
 {name:"sse_register",code:[0x0F,0x58,0xC1,0x49,0x75,0xFA,0xF4],iterations:2000000,per:3},
];
// Development filter: IR_FIXED_ONLY=name[,name].
if(process.env.IR_FIXED_ONLY){const only=process.env.IR_FIXED_ONLY.split(",");workloads.splice(0,workloads.length,...workloads.filter(w=>only.includes(w.name)));assert(workloads.length,"IR_FIXED_ONLY matched no workload");}
const [wasmPath="build/v86-ir-runtime.wasm",baselineWasm,...extra]=process.argv.slice(2);
assert.equal(extra.length,0,"usage: fixed_work.mjs [current.wasm] [baseline.wasm]");
const variants=[{label:"current",wasm:wasmPath}];
if(baselineWasm) variants.push({label:"baseline",wasm:baselineWasm});
variants.push({label:"interpreter",wasm:wasmPath,interpreter:true});
const scale=Number(process.env.IR_FIXED_SCALE||1);
assert(Number.isInteger(scale)&&scale>=1&&scale<=50,"IR_FIXED_SCALE must be an integer 1..50");
for(const work of workloads) work.iterations*=scale;
const results=[];
const arms=variants;
for(const work of workloads) for(let round=0;round<repetitions;round++) for(const {label,wasm,interpreter} of round%2?[...arms].reverse():arms) {
 const vm=new V86({graphics_adapter: "bochs_vga", wasm_path:wasm,memory_size:32<<20,...interpreter?{disable_jit:true}:{ir_tier0:false,ir_region_budget:{promotion_threshold}},
  bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
 try {
  await new Promise((r,j)=>{vm.add_listener("emulator-loaded",r);vm.add_listener("emulator-error",j);});
  const cpu=vm.v86.cpu,e=cpu.wm.exports;
  const counter=()=>new Uint32Array(e.memory.buffer)[664>>2];
  const data=()=>new DataView(cpu.mem8.buffer,cpu.mem8.byteOffset);
  vm.run();let end=performance.now()+15000;
  while(data().getUint16(0x500,true)!==0xCAFE){assert(performance.now()<end);await sleep(1);} await vm.stop();
  vm.write_memory(Uint8Array.from(work.code),PC);if(work.peer)vm.write_memory(Uint8Array.from(work.peer),PEER);
  const prepare=n=>{
   cpu.segment_offsets.fill(0,0,6);cpu.segment_is_null.fill(0,0,6);cpu.is_32[0]=1;cpu.stack_size_32[0]=1;
   cpu.reg32.set([0,n,work.peer?PEER:0x31415926,work.peer?PC:7,0x90000,0,DATA,work.edi||0]);
   cpu.reg_xmm32s.fill(0);for(let lane=0;lane<4;lane++)cpu.reg_xmm32s[4+lane]=0x3F800000;
   if(work.source)cpu.reg_xmm32s.set(work.source,4);
   if(work.destination)cpu.reg_xmm32s.set(work.destination);
   cpu.flags[0]=2;cpu.flags_changed[0]=0;cpu.in_hlt[0]=0;cpu.instruction_pointer[0]=PC;
   if(fpu_suite) {
    e.fpu_discard_cache();cpu.fpu_st.fill(0);
    cpu.fpu_stack_empty[0]=255;cpu.fpu_stack_ptr[0]=0;
    cpu.fpu_control_word[0]=0x37F;cpu.fpu_status_word[0]=0;cpu.mxcsr[0]=0x1F80;
    for(const field of ["fpu_opcode","fpu_ip","fpu_ip_selector","fpu_dp","fpu_dp_selector"])cpu[field][0]=0;
   }
   data().setUint32(DATA,0,true);
   if(suite==="game") {
    // Stable operands: 1.0/0.5/0.25 f32 vectors and f64 values near 1.
    const d=data();[1,0.5,0.25].forEach((v,i)=>{d.setFloat32(DATA+4*i,v,true);d.setFloat32(DATA+0x40+4*i,2-v,true);});
    d.setFloat64(DATA+0x10,1.25,true);d.setFloat64(DATA+0x18,0.75,true);d.setFloat64(DATA+0x50,0.5,true);d.setFloat64(DATA+0x58,1.5,true);
   } new Uint32Array(e.memory.buffer)[664>>2]=0;e.update_state_flags();
  };
  const run=async n=>{prepare(n);const start=performance.now();vm.run();const until=start+30000;
   while(!cpu.in_hlt[0]){assert(performance.now()<until,`${work.name}/${label} timeout`);await sleep(1);}
   const timing=await finish_halted_timing(vm,start),ms=timing.ms,steps=counter();
   assert.equal(steps,n*work.per+(work.peer?0:1),"identical exact retired guest work");
   const state={gpr:Array.from(cpu.reg32),flags:e.get_eflags(),xmm:Array.from(cpu.reg_xmm32s),data:data().getUint32(DATA,true),data16:Array.from(cpu.mem8.slice(DATA,DATA+16)),pc:cpu.instruction_pointer[0]};
   if(fpu_suite) {
    // Synchronize cached F80 values only after timing has stopped. Compare
    // all physical F80 registers, including empty slots, excluding ABI padding.
    e.fpu_sync_all();
    const bytes=new Uint8Array(cpu.fpu_st.buffer,cpu.fpu_st.byteOffset,cpu.fpu_st.byteLength);
    state.fpu={st:Array.from({length:8},(_,i)=>Array.from(bytes.slice(i*16,i*16+10)))};
    for(const field of ["fpu_stack_empty","fpu_stack_ptr","fpu_control_word","fpu_status_word","fpu_opcode","fpu_ip","fpu_ip_selector","fpu_dp","fpu_dp_selector","mxcsr"])state.fpu[field]=cpu[field][0];
   }
   return {...timing,steps,mips:steps/ms/1000,state};
  };
  // Yield between bounded warm runs so asynchronous publications can finish.
  for(let n=0;n<20;n++){await run(20000);await sleep(1);}
  if(!interpreter) assert.equal(e.ir_cache_entry_stat(PC,0,1,5),2,"fixed work must warm the measured entry to Tier 2");
  const ir_before=e.ir_cache_stat(10);
  const row={workload:work.name,suite,label,round,wasm,scale,...await run(work.iterations)};
  row.budget_batch_blocks=e.ir_cache_entry_stat(PC,0,1,13);
  row.ir_steps=(e.ir_cache_stat(10)-ir_before)>>>0;
  row.ir_coverage=row.ir_steps/row.steps;
  if(!interpreter) assert(row.ir_coverage>=0.95,"fixed work must actually execute through cached IR");
  const paired=results.find(r=>r.workload===work.name&&r.round===round&&r.label!==label);
  if(paired)assert.deepEqual(row.state,paired.state,`${work.name}: final architectural state differs`);
  results.push(row);if(!process.env.IR_FIXED_QUIET)console.log(JSON.stringify(row));else console.log(`${row.workload} ${label} r${round}: ${row.mips.toFixed(1)} MIPS`);
 } finally {await vm.destroy();}
}
const median=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
const matrix_for=label=>workloads.map(({name})=>({name,mips:median(results.filter(r=>r.label===label&&r.workload===name).map(r=>r.mips))}));
const matrix=matrix_for("current");
const baseline=baselineWasm?matrix_for("baseline"):null;
const comparison=baseline?matrix.map((r,i)=>({name:r.name,current_over_baseline:r.mips/baseline[i].mips})):null;
const geomean=comparison?Math.exp(comparison.reduce((sum,r)=>sum+Math.log(r.current_over_baseline),0)/comparison.length):null;
console.log(JSON.stringify({event:"summary",suite,timing_scope:"start-to-observed-halt",wasm:wasmPath,baseline_wasm:baselineWasm||null,scale,repetitions,matrix,baseline,comparison,geomean}));
