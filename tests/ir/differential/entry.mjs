import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const wasm=process.argv[2]||"build/v86-ir-test.wasm";
const cases=JSON.parse(fs.readFileSync("build/ir-entry/cases.json"));
const modules=cases.map((_,i)=>new WebAssembly.Module(fs.readFileSync(`build/ir-entry/${i}.wasm`)));
const vm=new V86({graphics_adapter: "bochs_vga", wasm_path:wasm,memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false,jit_switches:{x64_page_legacy32:0}});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));
    const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer),raw=new Uint8Array(e.memory.buffer);
    const view=new DataView(mem.buffer,mem.byteOffset),set32=(a,n)=>view.setUint32(a,n,true);
    vm.run();const deadline=performance.now()+10000;
    while(view.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();await sleep(20);cpu.jit_clear_cache();
    const DATA=0x110000,STACK=0x90000,HANDLER=0x180000;
    let calls=[];
    const instances=modules.map(module=>{
        const imports={...e,m:e.memory};
        for(const {name,kind} of WebAssembly.Module.imports(module)) if(kind==="function"){
            assert.equal(typeof e[name],"function",name);
            imports[name]=(...args)=>{calls.push(name);return e[name](...args);};
        }
        return new WebAssembly.Instance(module,{e:imports});
    });
    function reset(c,absent=false){
        const [kind,mode,pc,linear]=c;
        cpu.segment_offsets.fill(0,0,6);cpu.segment_offsets[1]=(linear-pc)>>>0;
        cpu.segment_is_null.fill(0,0,6);cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.sreg.set([16,8,16,16,16,16]);
        cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);
        // Stack width, DS base and flags remain runtime inputs, not key fields.
        cpu.stack_size_32[0]=+mode;cpu.segment_offsets[3]=mode?0:4096;
        cpu.is_32[0]=+mode;words[612>>2]=0;cpu.in_hlt[0]=0;raw[648]=0;
        cpu.reg32.set([kind===3?0:0x7FFFFFFF,3,0x12345678,0x89ABCDEF,STACK,0xFEDCBA98,DATA,0x76543210]);
        cpu.flags[0]=0x8D7;cpu.flags_changed[0]=0x8D5;words[96>>2]=31;words[104>>2]=0x7FFFFFFF;words[112>>2]=0;
        cpu.instruction_pointer[0]=linear;words[560>>2]=0x12345678;words[664>>2]=0xFFFFFFFC;
        e.ir_test_set_cr0(cpu.cr[0]&~12);cpu.cr[4]|=512;cpu.cr[2]=0xBADF000;
        for(let j=0;j<32;j++)words[(832>>2)+j]=Math.imul(j+1,0x1234567)>>>0;
        for(let page=DATA;page<=DATA+4096;page+=4096)set32(0x13000+(page>>>12)*4,absent?0:page|3);
        set32(DATA,0x1234ABCD);set32(DATA+4096,0xABCD1234);mem.fill(0xCC,STACK-32,STACK);
        cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;
        set32(0x2000+14*8,8<<16|HANDLER&65535);set32(0x2004+14*8,HANDLER&0xFFFF0000|0x8E00);
        mem.set(c[6],0x100000);e.full_clear_tlb();e.update_state_flags();
        assert.equal(e.ir_rep_movs(1,1,3,0,0),3);assert.equal(e.ir_rep_result(),3n);
        // A yielded REP restores its old instruction PC; seed metadata, then
        // establish this entry's CPU context before testing its guard.
        cpu.instruction_pointer[0]=linear;words[560>>2]=0x12345678;
        assert.equal(e.ir_entry_matches(linear,(linear-pc)>>>0,+mode),1);
        calls=[];
    }
    const untouched=()=>({globals:Buffer.from(raw.slice(64,1200)),data:Buffer.from(mem.slice(DATA,DATA+8192)),rep:e.ir_rep_result()});
    const state=()=>({regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,last:words[104>>2],ip:cpu.instruction_pointer[0]>>>0,
        xmm:Array.from(words.slice(832>>2,960>>2)),data:[view.getUint32(DATA,true),view.getUint32(DATA+4096,true)],cr2:cpu.cr[2]>>>0,
        frame:Buffer.from(mem.slice(STACK-32,STACK))});
    let rejected=0,executed=0,faults=0;
    for(let i=0;i<cases.length;i++){
        const c=cases[i], f=instances[i].exports.f;
        for(const mismatch of ["linear","cs","mode","alias","prefix","halt","index","negative-index","high-index"]){
            reset(c,c[0]===1||c[0]===2);let entry=0;
            if(mismatch==="linear")cpu.instruction_pointer[0]+=16;
            if(mismatch==="cs")cpu.segment_offsets[1]+=4096;
            if(mismatch==="mode")cpu.is_32[0]^=1;
            if(mismatch==="alias"){const linear=c[3]===0x100000?0x800000:0x100000;cpu.instruction_pointer[0]=linear;cpu.segment_offsets[1]=(linear-c[2])>>>0;}
            if(mismatch==="prefix")raw[648]=1;
            if(mismatch==="halt")cpu.in_hlt[0]=1;
            if(mismatch==="index")entry=1;
            if(mismatch==="negative-index")entry=-1;
            if(mismatch==="high-index")entry=65536;
            const before=untouched();f(entry);assert.deepEqual(untouched(),before,`entry ${i}: ${mismatch} must not change state`);
            assert.deepEqual(calls,mismatch.includes("index")?[]:["ir_enter_checked"],"reject before all state/access/helper imports");
            rejected++;
        }
        reset(c);assert.equal(e.ir_entry_matches(c[3],(c[3]-c[2])>>>0,+c[1]+256),0,"mode field is full width");
        const before_rejected=untouched();
        assert.equal(e.ir_enter_checked(c[3],(c[3]-c[2])>>>0,+c[1]+256),0);
        assert.deepEqual(untouched(),before_rejected,"full-width mode rejection leaves REP metadata and CPU untouched");
        f(0);assert.equal(calls[0],"ir_enter_checked");assert(!calls.includes("ir_enter"),"no duplicate initialization import");
        assert.equal(e.ir_rep_result(),0n);const actual=state(),count=(words[664>>2]-0xFFFFFFFC)>>>0;
        assert(count>0&&count<=32,`valid entry ${i} makes bounded progress`);
        reset(c);for(let n=0;n<count;n++)e.ir_test_step();assert.deepEqual(actual,state(),`matching entry ${i} vs interpreter`);executed++;
        if(c[0]===1||c[0]===7){
            reset(c,true);f(0);const fault={...state(),previous:words[560>>2]};
            const retired=c[0]===7?1:0;
            assert.equal(fault.ip,HANDLER);assert.equal(words[664>>2],(0xFFFFFFFC+retired)>>>0);assert.equal(fault.cr2,DATA+(c[1]?0:4096));
            reset(c,true);for(let n=0;n<=retired;n++)e.ir_test_step();assert.deepEqual(fault,{...state(),previous:words[560>>2]},`matching entry ${i}: fault ownership`);faults++;
        }
    }
    console.log(`PASS: ${wasm}: ${rejected} CPU entry rejections without guest/REP/helper effects, ${executed} actual CPU comparisons, ${faults} precise page faults; physical aliases, CS wrap, width, active prefixes, HLT and entry-index boundaries`);
    let active_counts;
    cpu.io.register_write(0x501,null,()=>{
        assert.equal(raw[648],0);assert.equal(cpu.in_hlt[0],0);
        const admitted=e.ir_entry_matches(cpu.instruction_pointer[0],cpu.segment_offsets[1],cpu.is_32[0]);
        active_counts[admitted]++;
    });
    for(const recording of [0,1]){
        reset([0,true,0x100000,0x100000,false,false,[0x90]]);cpu.jit_clear_cache();
        // OUT/LOOP run long enough to become hot and run through compiled IR
        // (page functions of the x64 page tier or regions). Every callback must see committed
        // state: no prefix, not halted, and an admissible entry key.
        vm.write_memory(Uint8Array.from([0xBA,1,5,0,0,0xB9,0x40,0x0D,3,0,0xEE,0xE2,0xFD,0xF4]),0x100000);
        const compiled_before=(e.x64_page_stat(13)+e.ir_cache_stat(2))>>>0;
        e.performance_recording_enable(recording);active_counts=[0,0];vm.run();const until=performance.now()+10000;
        while(!cpu.in_hlt[0]){assert(performance.now()<until,"IR callback loop timed out");await sleep(5);} await vm.stop();
        e.performance_recording_enable(0);
        assert.equal(active_counts[0]+active_counts[1],200000);
        assert.equal(active_counts[0],0,"I/O callbacks from compiled IR see admissible entry keys");
        assert(((e.x64_page_stat(13)+e.ir_cache_stat(2))>>>0)!==compiled_before,"the OUT loop ran through compiled IR");
        cpu.in_hlt[0]=0;assert.equal(e.ir_entry_matches(cpu.instruction_pointer[0],cpu.segment_offsets[1],cpu.is_32[0]),1,"entry key is admissible after the loop");
    }
    console.log(`PASS: ${wasm}: I/O callbacks from compiled IR see admissible CPU entry keys, with recording disabled/enabled`);
} finally {await vm.destroy();}
