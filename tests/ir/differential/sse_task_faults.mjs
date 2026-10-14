// The SIMD task checks in cached region IR against the interpreter (docs/
// simd-xsave-plan.md 3.3, P4a): XMM forms raise #UD with CR0.EM or without
// CR4.OSFXSR, then #NM with CR0.TS; MMX forms ignore OSFXSR. SSE, MMX, native
// SIMD, LDMXCSR/STMXCSR, invalid and reserved forms, after an STI too, with
// and without diagnostics; the fault reaches its handler with the
// interpreter's state.
import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";

const wasm=process.argv[2]||"build/v86-ir-cache-test.wasm";
const release=process.argv.includes("--release");
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const little=value=>Array.from({length:4},(_,i)=>value>>>(i*8)&255);
// The region scheduler is under test: ir_tier0 (32-bit code in the x64 page tier, on by default) is off.
const vm=new V86({graphics_adapter: "bochs_vga", ir_tier0:false,
    wasm_fn:async imports=>(await WebAssembly.instantiate(fs.readFileSync(wasm),imports)).instance.exports,
    memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
    disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});

try {
    await new Promise(resolve=>vm.add_listener("emulator-loaded",resolve));
    const cpu=vm.v86.cpu,e=cpu.wm.exports,PC=0x100000,DATA=0x200000;
    const HANDLERS={6:0x180100,7:0x180200,13:0x180300};
    const words=()=>new Uint32Array(e.memory.buffer);
    const view=()=>new DataView(cpu.mem8.buffer,cpu.mem8.byteOffset);
    const set32=(address,value)=>view().setUint32(address,value,true);
    vm.run();let deadline=performance.now()+10000;
    while(view().getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);}
    await vm.stop();
    const snapshot=()=>{
        e.fpu_sync_all?.();
        return {gpr:Array.from(cpu.reg32),flags:e.get_eflags(),xmm:Array.from(cpu.reg_xmm32s),
            fpu:Array.from(cpu.fpu_st),empty:cpu.fpu_stack_empty[0],top:cpu.fpu_stack_ptr[0],
            control:cpu.fpu_control_word[0],status:cpu.fpu_status_word[0],mxcsr:cpu.mxcsr[0],
            pc:cpu.instruction_pointer[0],count:words()[664>>2],cr0:cpu.cr[0],
            data:Array.from(cpu.mem8.slice(DATA,DATA+32)),
            frame:Array.from(cpu.mem8.slice(0x8FFE0,0x90000))};
    };
    // [name, bytes, XMM form (the OSFXSR check), invalid or reserved (#UD after the checks)]
    const cases=[
        ["sse_reg",[0x0F,0x58,0xC1],true],
        ["sse_mem",[0x0F,0x58,0x05,...little(DATA)],true],
        ["mmx_immediate",[0x0F,0x71,0xF0,1],false],
        ["mmx_mem",[0x0F,0x6F,0x05,...little(DATA)],false],
        ["sti_mmx_immediate",[0x0F,0x71,0xF0,1],false],
        ["native_move_reg",[0x0F,0x10,0xC1],true],
        ["native_move_mem",[0x0F,0x10,0x05,...little(DATA)],true],
        ["native_aligned_mem",[0x0F,0x28,0x05,...little(DATA)],true],
        ["native_integer",[0x66,0x0F,0xFE,0xC1],true],
        ["native_immediate",[0x66,0x0F,0x71,0xF0,1],true],
        ["sti_native_immediate",[0x66,0x0F,0x71,0xF0,1],true],
        ["ldmxcsr",[0x0F,0xAE,0x15,...little(DATA)],true],
        ["stmxcsr",[0x0F,0xAE,0x1D,...little(DATA)],true],
        ["invalid_sse_mem",[0x0F,0x50,0x05,...little(DATA)],true,true],
        ["reserved_sse_mem",[0x0F,0x6C,0x05,...little(DATA)],false,true],
        ["integer_control",[0x90]],
        ["reserved_control",[0x0F,0xAE,0xE8]],
        ["invalid_control",[0x0F,0xC3,0xC0],undefined,true],
    ];
    // [scenario, CR4.OSFXSR, CR0 task bits, diagnostics]
    const scenarios=[["ordinary",true,0,0],["no_osfxsr",false,0,0],["em",true,4,0],["ts",true,8,0],
        ["no_osfxsr_ts",false,8,0],["diagnostics",true,0,1],["no_osfxsr_diagnostics",false,0,1]];
    let comparisons=0;
    for(const [name,instruction,xmm,invalid=false] of cases)
    for(const tier of [1,2]) for(const opt of [0,1])
    for(const [scenario,osfxsr,task,diagnostics] of scenarios) {
        const shadow=name.startsWith("sti_");
        const code=[...(shadow?[0xFB]:[]),...instruction,0x40,0xF4];
        const results=[];
        for(const cached of [false,true]) {
            assert.equal(e.ir_auto_config(0,16,64,192,256,64),1);
            cpu.jit_clear_cache();e.ir_cache_collect();
            assert.equal(await vm.configure_ir_diagnostics(diagnostics),true);
            cpu.in_hlt[0]=0;cpu.flags[0]=2;cpu.flags_changed[0]=0;
            cpu.is_32[0]=1;cpu.stack_size_32[0]=1;cpu.segment_offsets.fill(0,0,6);
            cpu.segment_is_null.fill(0,0,6);cpu.instruction_pointer[0]=PC;
            cpu.reg32.set([5,0,0,0,0x90000,0,DATA,DATA]);
            cpu.cr[0]=0x80010011;cpu.cr[3]=0x12000;cpu.cr[4]=512;
            words()[612>>2]=0;cpu.sreg.set([16,8,16,16,16,16]);
            cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);
            cpu.segment_limits.fill(0xFFFFFFFF,0,6);
            cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=23;
            set32(0x3008,0xFFFF);set32(0x300C,0xCF9B00);
            set32(0x3010,0xFFFF);set32(0x3014,0xCF9300);
            cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;
            for(const [vector,handler] of Object.entries(HANDLERS)) {
                set32(0x2000+vector*8,8<<16|handler&0xFFFF);
                set32(0x2004+vector*8,handler&0xFFFF0000|0x8E00);
                cpu.mem8[handler]=0xF4;
            }
            cpu.mem8.fill(0xCC,0x8FFE0,0x90000);
            set32(0x12000,0x13003);
            for(let p=0;p<1024;p++)set32(0x13000+p*4,p*4096|3);
            e.full_clear_tlb();e.update_state_flags();
            e.fpu_discard_cache?.();cpu.fpu_st.fill(0);cpu.fpu_st[0]=1;
            cpu.fpu_stack_empty[0]=0;cpu.fpu_stack_ptr[0]=0;
            cpu.fpu_control_word[0]=0x37F;cpu.fpu_status_word[0]=0;
            cpu.reg_xmm32s.fill(0x3F800000);cpu.mxcsr[0]=0x1F80;
            for(let i=0;i<4;i++){set32(DATA+i*4,0x3F800000);set32(DATA+16+i*4,0x40000000);}
            if(name.includes("native_immediate"))cpu.reg_xmm32s[0]=0x00010001;
            if(name==="ldmxcsr")set32(DATA,0x3F80);
            vm.write_memory(Uint8Array.from(code),PC);words()[664>>2]=0xFFFFFFFC;
            // (an invalid form ends its region)
            if(cached)assert(await cpu.ir_compile_cached(invalid?Number(shadow)+instruction.length:code.length,tier,opt,1,64,8),name);
            assert.equal(e.ir_auto_config(1,16,64,192,256,64),1);
            cpu.cr[4]=osfxsr?512:0;cpu.cr[0]=0x80010011|task;
            const before={hits:e.ir_cache_stat(2),attempts:e.ir_auto_stat(2)+e.ir_auto_stat(3)};
            vm.run();deadline=performance.now()+5000;
            while(!cpu.in_hlt[0]){assert(performance.now()<deadline,`${name}/${scenario}: HLT`);await sleep(1);}
            await vm.stop();
            assert.equal(e.ir_cache_stat(2)-before.hits,Number(cached),`${name}/${scenario}: the cached region runs`);
            assert.equal(e.ir_auto_stat(2)+e.ir_auto_stat(3),before.attempts,"no recompilation");
            results.push(snapshot());
        }
        const [interpreted,compiled]=results;
        // the fault the checks give: #UD (EM, or no OSFXSR for XMM forms), #NM (TS), or none
        const guarded=xmm!==undefined;
        const fault=guarded&&(task&4||xmm&&!osfxsr)?6:guarded&&task&8?7:invalid?6:0;
        assert.equal(interpreted.pc,fault?HANDLERS[fault]+1:PC+code.length,
            `${name}/${scenario}: the interpreter ${fault?"faults #"+fault:"completes"}`);
        if(fault) {
            // (the interpreter also charges the faulting decode attempt)
            assert.deepEqual({...compiled,count:interpreted.count},interpreted,`${name}/${tier}/${opt}/${scenario}: fault state`);
            assert.equal(compiled.count,(interpreted.count-1)>>>0,"the compiled fault retires the instruction once less");
        }
        else assert.deepEqual(compiled,interpreted,`${name}/${tier}/${opt}/${scenario}: state and counts`);
        comparisons++;
    }
    console.log(`PASS (${release?"release":"debug"}): ${wasm}: ${comparisons} SIMD task check comparisons (EM, TS, OSFXSR for XMM forms only), SSE/MMX/native/MXCSR/invalid/reserved forms, STI shadows and diagnostics`);
} finally {
    await vm.destroy();
}
