import fs from "node:fs";
import assert from "node:assert/strict";
import { V86 } from "../../../build/libv86.mjs";
const wasm = process.argv[2] || "build/v86-ir-runtime.wasm";
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const delta=(a,b)=>(a-b)>>>0;
// Synthetic cold-start diagnostic of the IR region tiers (ir_tier0 off), not an
// XP or application benchmark. Compare cores by running this once per core,
// alternating, on an otherwise idle host.
const duration=Number(process.env.IR_BENCH_MS || 1200);
assert(Number.isFinite(duration) && duration >= 100 && duration <= 10000);
const recording=process.env.IR_BENCH_RECORD === "1";
const results=[];
for(const size of [2,256,1024]) {
 const vm = new V86({graphics_adapter: "bochs_vga", wasm_path:wasm,bios:{buffer:Uint8Array.from(fs.readFileSync("build/cpu-worker-test.bin")).buffer},memory_size:32<<20,disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false,ir_tier0:false});
 try {
 await new Promise((resolve,reject)=>{vm.add_listener("emulator-loaded",resolve);vm.add_listener("emulator-error",reject);});
 const cpu=vm.v86.cpu, e=cpu.wm.exports;
 vm.run(); let end=performance.now()+15000;
 while(new DataView(cpu.mem8.buffer,cpu.mem8.byteOffset).getUint32(0x500,true)!==0xCAFE){assert(performance.now()<end);await sleep(5);}
 await vm.stop(); cpu.jit_clear_cache();e.ir_cache_collect();
 const PC=0x1200000;
 const code=new Uint8Array(size+4);code.fill(0x40,0,size-1);code[size-1]=0xE9;new DataView(code.buffer).setInt32(size,-code.length,true);
 vm.write_memory(code,PC);cpu.instruction_pointer[0]=PC;cpu.in_hlt[0]=0;cpu.reg32[0]=0;cpu.flags[0]=2;cpu.flags_changed[0]=0;
 const start=performance.now(), count0=vm.get_instruction_counter()>>>0;
 const b=vm.get_jit_info(); if(recording)e.performance_recording_enable(1); vm.run(); await sleep(duration);
 await vm.stop();const elapsed=performance.now()-start;const a=vm.get_jit_info();
 const steps=delta(vm.get_instruction_counter()>>>0,count0);
 const row={wasm,size,ms:elapsed,mips:steps/elapsed/1000,ir_guest_steps:delta(a.ir.cache_guest_steps,b.ir.cache_guest_steps),tier1:a.ir.tier1_published-b.ir.tier1_published,tier2:a.ir.tier2_published-b.ir.tier2_published,stops:a.ir.compile_stops-b.ir.compile_stops,visits:delta(a.ir.visits,b.ir.visits),hot:a.ir.hot_entries,budget_retries:a.ir.budget_retries,cache_capacity:a.ir.cache_capacity,recording,sync_codegen_ms:recording?e.performance_recording_get(5):null,sync_codegen_calls:recording?e.performance_recording_get(7):null};
 const offset=cpu.instruction_pointer[0]-PC;
 assert(offset>=0 && offset<size);
 const expected=((cpu.reg32[0]>>>0)-offset)/(size-1)*size+offset;
 assert(Number.isInteger(expected));assert.equal(steps,expected>>>0,"exact guest retirement across interpreted and compiled fragments");
 results.push(row);console.log(JSON.stringify(row));
 } finally {await vm.destroy();}
}
