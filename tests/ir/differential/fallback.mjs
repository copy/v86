import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
import {wasm_fallback_path} from "../../../src/browser/wasm_paths.js";
import {encode_worker_options} from "../../../src/browser/cpu_worker.js";
for(const [primary,expected] of [
    ["build/v86.wasm","build/v86-fallback.wasm"],
    ["build/v86-ir-runtime.wasm?v=2#core","build/v86-ir-runtime-fallback.wasm?v=2#core"],
    ["/v86-ir-runtime-fallback.wasm","/v86-ir-runtime-fallback.wasm"],
])assert.equal(wasm_fallback_path(primary),expected);
globalThis.location={href:"https://example.test/demo/"};
// The encoder sees options new V86() has validated: graphics_adapter is required.
assert.equal(encode_worker_options({graphics_adapter:"bochs_vga",wasm_path:"custom.wasm",wasm_fallback_path:"portable.wasm"}).wasm_fallback_path,"https://example.test/demo/portable.wasm");
const primary=fs.readFileSync("build/v86-ir-test.wasm");
const instantiate=WebAssembly.instantiate;let primary_rejected=0;
// Exercise the loader's capability-rejection path even on SIMD-capable CI hosts.
WebAssembly.instantiate=(bytes,imports)=>{
    if(!(bytes instanceof WebAssembly.Module)&&Buffer.from(bytes).equals(primary)) {
        primary_rejected++;return Promise.reject(new WebAssembly.CompileError("test host rejects SIMD core"));
    }
    return instantiate(bytes,imports);
};
// Region-tier publication on the portable core: ir_tier0 (32-bit code in the x64 page tier, on by default) is off.
const vm=new V86({graphics_adapter: "bochs_vga", wasm_path:"build/v86-ir-test.wasm",ir_tier0:false,memory_size:32<<20,
    bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
    disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test,label){const end=performance.now()+10000;while(!test()){assert(performance.now()<end,label);await sleep(1);}}
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));
    WebAssembly.instantiate=instantiate;
    assert.equal(primary_rejected,1);
    const cpu=vm.v86.cpu,e=cpu.wm.exports,PC=0x100000;
    // Online compilation can grow Wasm memory and detach an old typed view.
    const words=()=>new Uint32Array(e.memory.buffer);
    assert.equal(e.ir_wasm_simd_supported(),0);
    vm.run();await until(()=>new DataView(cpu.mem8.buffer,cpu.mem8.byteOffset).getUint16(0x500,true)===0xCAFE,"portable boot");await vm.stop();
    function prepare(bytes){
        e.ir_auto_config(0,2,4,192,128,8);cpu.jit_clear_cache();e.ir_cache_collect();
        cpu.in_hlt[0]=0;cpu.flags[0]=2;cpu.flags_changed[0]=0;cpu.segment_offsets.fill(0,0,6);cpu.segment_is_null.fill(0,0,6);
        cpu.is_32[0]=cpu.stack_size_32[0]=1;cpu.reg32.fill(0);cpu.reg32[4]=0x90000;cpu.instruction_pointer[0]=PC;words()[664>>2]=0;
        // (CR4.OSFXSR: SSE forms are #UD without it since the SIMD/XSAVE plan's P4a)
        e.ir_test_set_cr0(cpu.cr[0]&~12);cpu.cr[4]|=0x200;e.update_state_flags();vm.write_memory(Uint8Array.from(bytes),PC);
    }
    prepare([0x40,0xEB,0xFD]);const published=e.ir_auto_stat(4),hits=e.ir_cache_stat(2);
    e.ir_auto_config(1,2,4,192,128,8);vm.run();await until(()=>e.ir_auto_stat(4)>published&&e.ir_cache_stat(2)>hits,"portable scalar IR");await vm.stop();
    assert.equal(words()[664>>2],(cpu.reg32[0]*2-(cpu.instruction_pointer[0]===PC+1?1:0))>>>0);
    // PADDd XMM0,XMM1 in an endless loop must execute using scalar CPU semantics.
    prepare([0x66,0x0F,0xFE,0xC1,0xEB,0xFA]);cpu.reg_xmm32s.fill(0);cpu.reg_xmm32s.set([1,2,3,4],4);
    const failed=e.ir_auto_stat(6);let publications=0;const publish=cpu.ir_auto_publish;
    cpu.ir_auto_publish=function(...args){publications++;return publish.apply(this,args);};
    e.ir_auto_config(1,2,4,192,128,8);vm.run();await until(()=>e.ir_auto_stat(6)>failed&&e.ir_auto_stat(8)>0,"vector compile-stop suppression");await vm.stop();
    assert.equal(publications,0,"portable core must not publish unsupported vector modules");
    const iterations=(words()[664>>2]+(cpu.instruction_pointer[0]===PC+4?1:0))/2;
    assert(iterations>0&&Number.isInteger(iterations));
    assert.deepEqual(Array.from(cpu.reg_xmm32s.slice(0,4),n=>n>>>0),[1,2,3,4].map(n=>n*iterations>>>0));
    const attempts=e.ir_auto_stat(2)+e.ir_auto_stat(3);vm.run();await sleep(30);await vm.stop();
    assert.equal(e.ir_auto_stat(2)+e.ir_auto_stat(3),attempts);
    console.log("PASS: custom/Worker fallback paths, portable core loading, scalar IR publication, exact SIMD interpreter fallback, and failed-compile suppression");
} finally {WebAssembly.instantiate=instantiate;await vm.destroy();}
