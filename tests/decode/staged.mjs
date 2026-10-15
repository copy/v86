import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../build/libv86.mjs";
const vm = new V86({graphics_adapter: "bochs_vga", wasm_path:process.argv[2]||"build/v86-ir-test.wasm",memory_size:32<<20,
    bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
    disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));
    const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,w=new Uint32Array(e.memory.buffer);
    const v=new DataView(mem.buffer,mem.byteOffset), put=(a,x)=>v.setUint32(a,x,true);
    vm.run();const deadline=performance.now()+10000;
    while(v.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await new Promise(r=>setTimeout(r,1));}
    await vm.stop();
    const cr0=cpu.cr[0],PC=0x8000,SP=0x90000,GP=0x180000,PF=0x180100;
    function reset(size,prefix,bytes,ip=PC,absent=false,nulls=false){
        e.ir_test_set_cr0(cr0|0x10000);cpu.cr[2]=0xBADF000;cpu.flags[0]=2;cpu.flags_changed[0]=0;
        cpu.sreg.set([16,8,16,16,16,16]);cpu.segment_offsets.set([0x100,0,0,0x300,0x400,0x500]);
        cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.segment_is_null.fill(+nulls,0,6);
        cpu.segment_is_null[1]=cpu.segment_is_null[2]=0;
        cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);
        cpu.is_32[0]=+(size===32);cpu.stack_size_32[0]=1;w[612>>2]=0;
        cpu.reg32.set([0xFFFF1234,0xABCDEF01,0x12345678,0x87654321,SP,0xFFFFFFFC,0xFFFF,5]);
        cpu.instruction_pointer[0]=ip;w[560>>2]=PC-2;cpu.in_hlt[0]=0;
        cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=23;
        put(0x3008,65535);put(0x300C,0xCF9B00);put(0x3010,65535);put(0x3014,0xCF9300);
        cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;
        for(const [n,handler] of [[13,GP],[14,PF]]){put(0x2000+n*8,8<<16|handler&65535);put(0x2004+n*8,handler&0xFFFF0000|0x8E00);}
        put(0x12000,0x13023);
        for(const page of [2,3,8,9,0x8F,0x90,0x180])put(0x13000+page*4,page*4096|0x23);
        if(absent)put(0x13000+9*4,0);
        mem.fill(0xCC,SP-64,SP);mem.set(bytes,ip);
        e.full_clear_tlb();e.update_state_flags();
        new Uint8Array(e.memory.buffer)[648]=prefix;
    }
    function state(result){return {result,ip:cpu.instruction_pointer[0],previous:w[560>>2],cr2:cpu.cr[2],
        regs:Array.from(cpu.reg32),flags:e.get_eflags(),segments:Array.from(cpu.segment_offsets),
        frame:Buffer.from(mem.slice(SP-64,SP))};}
    let comparisons=0;
    for(const size of [16,32]) for(let m=0;m<192;m++) {
        const sibs=size===32&&(m&7)===4?256:1;
        for(let sib=0;sib<sibs;sib++) for(const prefix of [0,1,2,3,4,5,6,7]) {
            const bytes=size===32&&(m&7)===4?[sib,0x80,0xFE,0xFF,0x12]:[0x80,0xFE,0xFF,0x12];
            reset(size,prefix,bytes);const old=state(e.ir_test_resolve_modrm(m,size,1));
            reset(size,prefix,bytes);assert.deepEqual(state(e.ir_test_resolve_modrm(m,size,0)),old,`EA ${size}/${m}/${sib}/${prefix}`);
            comparisons++;
        }
    }
    // With SIB, a null segment precedes a trailing displacement fetch; without
    // SIB, that fetch precedes the null-segment check. Keep the baseline priority.
    for(const size of [16,32]) for(const m of [0x05,0x06,0x40,0x44,0x45,0x84,0x85]) {
        for(const prefix of [0,1,4,5,7]) for(const nulls of [false,true]) for(const cut of [0,1,2,3]){
            const bytes=[0,0x80,0xFF,0xFF,0xFF];const ip=0x9000-cut;
            reset(size,prefix,bytes,ip,true,nulls);const old=state(e.ir_test_resolve_modrm(m,size,1));
            reset(size,prefix,bytes,ip,true,nulls);assert.deepEqual(state(e.ir_test_resolve_modrm(m,size,0)),old,`fetch ordering ${size}/${m}/${prefix}/${nulls}/${cut}`);
            comparisons++;
        }
    }
    console.log(`PASS: ${comparisons} staged interpreter EA comparisons against pinned resolver, including cross-page fetch/segment fault priority`);
} finally {await vm.destroy();}
