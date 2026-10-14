import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-system-stack/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-system-stack/${i}-${opt}.wasm`))));
const vm=new V86({graphics_adapter: "bochs_vga", wasm_path:"build/v86-ir-test.wasm",memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer);
    const view=new DataView(mem.buffer,mem.byteOffset),set32=(a,v)=>view.setUint32(a,v,true),get32=a=>view.getUint32(a,true);
    vm.run();const deadline=performance.now()+10000;while(view.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
    const PC=0x8000,BASE=0x310000,STACK=0x90000,HANDLER=0x180000,cr0=cpu.cr[0];let reads=0,writes=0,events=[],data_address=BASE,windows=[],check_calls=0,exit_calls=0;
    const imports={...e,m:e.memory,ir_memory_read:(...a)=>{reads++;return e.ir_memory_read(...a);},ir_memory_write:(...a)=>{writes++;return e.ir_memory_write(...a);},ir_flags_stack_check:()=>{check_calls++;return e.ir_flags_stack_check();},ir_pop_flags:(...a)=>{exit_calls++;return e.ir_pop_flags(...a);},ir_pop_segment:(...a)=>{exit_calls++;return e.ir_pop_segment(...a);}};
    const instances=modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:imports})));
    function descriptor(index,base,limit,access,flags){set32(0x3000+index*8,(limit&65535)|base<<16);set32(0x3004+index*8,(base&0xFF000000)|(base>>>16&255)|access<<8|(limit&0xF0000)|flags<<20);}
    function reset(i,ss32,value=0x20,offset=0x80,hot=false,flags=0x8D7){
        const [bytes,mode,width,op]=cases[i];e.ir_test_set_cr0(cr0|0x10000);
        descriptor(0,0,0,0,0);descriptor(1,0,0xFFFFF,0x9B,12);descriptor(2,0,0xFFFFF,0x93,12);
        descriptor(3,0x330000,65535,0x93,0);descriptor(4,0x340000,0xFFFFF,0x93,12);
        descriptor(5,0,0xFFFFF,0xFB,12);descriptor(6,BASE,0xFFFFF,0xF3,12);descriptor(7,0x4000,0x67,0x89,0);
        descriptor(8,0,0xFFFFF,0x13,12);descriptor(9,0,0xFFFFF,0x99,12);descriptor(10,0x4000,0x67,0x89,0);
        cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=87;
        cpu.segment_offsets.fill(0,0,6);cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.segment_is_null.fill(0,0,6);cpu.segment_offsets[2]=ss32?0:BASE;
        cpu.sreg.set([0x18,8,16,0x20,0x18,0x20]);cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);cpu.stack_size_32[0]=+ss32;cpu.is_32[0]=+mode;words[612>>2]=0;
        cpu.reg32.set([0x7FFFFFFF,0x10203040,0x89ABCDEF,0x55667788,ss32?BASE+offset:(0xABCD0000|offset)>>>0,0x11223344,0xAA55CC33,0xFFEEDDCC]);
        cpu.flags[0]=flags;cpu.flags_changed[0]=0;words[104>>2]=0x12345678;cpu.instruction_pointer[0]=PC;cpu.in_hlt[0]=0;words[664>>2]=100;
        cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;for(const vector of [11,12,13,14,32]){set32(0x2000+vector*8,8<<16|HANDLER&65535);set32(0x2004+vector*8,HANDLER&0xFFFF0000|0x8E00);}
        set32(0x12000,0x13003);for(const p of [3,8,0x18])set32(0x13000+p*4,p*4096|3);for(let p=0x30F;p<=0x340;p++)set32(0x13000+p*4,p*4096|3);
        mem.fill(0x5A,0x30F000,0x331000);mem.fill(0xCC,STACK-64,STACK+16);mem.set(bytes,PC);data_address=BASE+offset;set32(data_address,value);windows=[[0x30F000,0x22000],[STACK-64,80],[0x3000,88]];
        e.full_clear_tlb();e.update_state_flags();
        if(hot){const next=ss32?BASE+offset-width/8:BASE+(offset-width/8&65535);for(const a of [data_address,next])e.ir_memory_write(a,mem[a],1);}
        reads=writes=check_calls=exit_calls=0;events=[];
    }
    const state=()=>({regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,last:words[104>>2],ip:cpu.instruction_pointer[0]>>>0,previous:words[560>>2],cr2:cpu.cr[2]>>>0,
        sreg:Array.from(cpu.sreg.slice(0,6)),base:Array.from(cpu.segment_offsets.slice(0,6),x=>x>>>0),limit:Array.from(cpu.segment_limits.slice(0,6),x=>x>>>0),access:Array.from(cpu.segment_access_bytes.slice(0,6)),null:Array.from(cpu.segment_is_null.slice(0,6)),ss32:cpu.stack_size_32[0],mode:cpu.is_32[0],cpl:words[612>>2]&255,data:windows.map(([a,n])=>Buffer.from(mem.slice(a,a+n)))});
    const find=(op,mode,width)=>cases.findIndex(c=>c[3]===op&&c[1]===mode&&c[2]===width);
    let ordinary=0,native=0,wraps=0;
    for(let i=0;i<cases.length;i++) for(const ss32 of [false,true]) for(const opt of [0,1]) for(const hot of [false,true]) for(const value of cases[i][3]===0x9D?[2,0xFD7,0x3F7FD7]:[0x18,0x20]){
        reset(i,ss32,value,0x80,hot);instances[i][opt].exports.f(0);const actual=state();assert.equal(words[664>>2],102);assert.equal(actual.ip,PC+cases[i][0].length-(cases[i][3]&1?0:1));
        if(hot){assert.equal(reads+writes,0);native++;}assert.equal(exit_calls,cases[i][3]&1?1:0);assert.equal(check_calls,[0x9C,0x9D].includes(cases[i][3])?1:0);
        reset(i,ss32,value,0x80,hot);e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`system stack ${i} SS32=${ss32} value=${value}`);ordinary++;
    }
    for(let i=0;i<cases.length;i++) for(const ss32 of [false,true]) for(const opt of [0,1]) for(const offset of [1,0xFFFE]){
        reset(i,ss32,cases[i][3]===0x9D?2:0x18,offset);instances[i][opt].exports.f(0);const actual=state();
        reset(i,ss32,cases[i][3]===0x9D?2:0x18,offset);e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`system stack wrap ${i}/${ss32}/${offset}`);wraps++;
    }
    console.log(`PASS: ${ordinary} FLAGS/segment stack comparisons, ${native} native data paths, ${wraps} stack-width wraps`);
    const observe=(kind,a,value)=>events.push({kind,a,value,regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0,ss32:cpu.stack_size_32[0]});
    cpu.io.mmap_register(0xA0000,0x20000,a=>{observe("r8",a);return a>=0xA1000&&a<0xA2000?mem[0x3000+(a&4095)]:a&1?0:0x20;},(a,v)=>observe("w8",a,v),a=>{observe("r32",a);return a>=0xA1000&&a<0xA2000?get32(0x3000+(a&4095)):0x20;},(a,v)=>observe("w32",a,v>>>0));
    let devices=0,selector_faults=0;
    for(let i=0;i<cases.length;i++) for(const ss32 of [false,true]) for(const opt of [0,1]){
        const configure=()=>{reset(i,ss32);set32(0x13000+0x310*4,0xA0003);if(cases[i][3]&1&&cases[i][3]!==0x9D)set32(0x13000+3*4,0xA1003);e.full_clear_tlb();events=[];};
        configure();instances[i][opt].exports.f(0);const actual=state(),observed=events.slice();assert(events.length>0);
        if(!(cases[i][3]&1)&&cases[i][3]!==0x9C)assert.equal(events.filter(x=>x.kind.startsWith("w")).length,2,"segment PUSH writes exactly one word at either operand width");
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state());assert.deepEqual(observed,events,`system stack MMIO ${i}/${ss32}`);devices++;
        if(cases[i][3]&1&&cases[i][3]!==0x9D) for(const selector of [0,0x40,0x48,0x50,0x100,0x1B]){
            const configure=()=>reset(i,ss32,selector);configure();instances[i][opt].exports.f(0);const actual=state();const fault=selector!==0||cases[i][3]===0x17;
            assert.equal(words[664>>2],fault?101:102);if(fault)assert.equal(actual.ip,HANDLER);
            configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`selector fault ${i}/${selector}/${ss32}`);selector_faults++;
        }
    }
    console.log(`PASS: ${devices} stack/descriptor MMIO cases and ${selector_faults} selector validity/#GP/#SS/#NP cases`);
    function user(){
        cpu.segment_offsets[6]=0x4000;cpu.segment_limits[6]=0x67;cpu.sreg[6]=0x38;cpu.tss_size_32[0]=1;set32(0x4004,STACK);set32(0x4008,16);
        cpu.sreg.set([0x33,0x2B,0x33,0x33,0x33,0x33]);cpu.segment_access_bytes.set([0xF3,0xFB,0xF3,0xF3,0xF3,0xF3]);words[612>>2]=3;
        set32(0x12000,0x13007);for(const p of [8,0x18])set32(0x13000+p*4,p*4096|7);for(let p=0x30F;p<=0x340;p++)set32(0x13000+p*4,p*4096|7);e.full_clear_tlb();e.update_state_flags();
    }
    let page_faults=0,privilege=0;
    for(let i=0;i<cases.length;i++) for(const opt of [0,1]){
        const configure=()=>{reset(i,true,0x20,0x1000+(cases[i][3]&1?0:cases[i][2]/8));user();set32(0x13000+0x311*4,0);e.full_clear_tlb();};
        configure();instances[i][opt].exports.f(0);const actual=state();assert.equal(actual.ip,HANDLER);assert.equal(actual.cpl,0);assert.equal(words[664>>2],101);assert.equal(exit_calls,0);
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`system stack page fault ${i}`);page_faults++;
    }
    for(const mode of [false,true]) for(const width of [16,32]) for(const opt of [0,1]) for(const iopl of [0,3]) for(const requested of [0,0x200,0x3000,0x3F7FD7]){
        const i=find(0x9D,mode,width),configure=()=>{reset(i,true,requested,0x80,false,2|iopl<<12);user();};
        configure();instances[i][opt].exports.f(0);const actual=state();assert.equal(words[664>>2],102);assert.equal(actual.flags>>12&3,iopl);if(iopl===0)assert.equal(actual.flags&0x200,0);
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state());privilege++;
    }
    console.log(`PASS: ${page_faults} ring3 stack #PF cases and ${privilege} POPF CPL/IOPL masks`);
    let word_boundaries=0;
    for(let i=0;i<cases.length;i++) if(cases[i][2]===32&&![0x9C,0x9D].includes(cases[i][3])) for(const opt of [0,1]){
        const pop=cases[i][3]&1,configure=()=>{reset(i,true,0x20,pop?0xFFE:0x1002);set32(0x13000+0x311*4,0);e.full_clear_tlb();};
        configure();instances[i][opt].exports.f(0);const actual=state();assert.equal(words[664>>2],pop?101:102);assert.equal(actual.ip,pop?HANDLER:PC+cases[i][0].length-1);
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),"segment dword reservation versus actual access width");word_boundaries++;
    }
    console.log(`PASS: ${word_boundaries} segment stack page boundaries: word-only PUSH and full-width POP`);
    // Both faults are ordinary #PFs, without a host trap. Until 8d7a3927 the
    // accessed-bit store unwrapped its translation, so it panicked after
    // delivering the #PF, and this loop pinned that trap. The store is a
    // supervisor write, so under CR0.WP the read-only GDT page faults with
    // error code 3 and CR2 at the access byte. POP commits nothing: the frame
    // sits directly below the old ESP, and no segment register changes.
    let descriptor_faults=0;
    for(let i=0;i<cases.length;i++) if(cases[i][3]&1&&cases[i][3]!==0x9D) for(const opt of [0,1]) for(const write_fault of [false,true]){
        const configure=()=>{reset(i,true,0x1000);mem.copyWithin(0x5000,0x3000,0x3058);cpu.gdtr_offset[0]=0x5000;cpu.gdtr_size[0]=0x10FF;set32(0x6000,0xFFFF);set32(0x6004,0x00CF9200);set32(0x13000+5*4,0x5003);set32(0x13000+6*4,write_fault?0x6001:0);windows.push([0x5000,0x1100]);e.full_clear_tlb();};
        configure();instances[i][opt].exports.f(0);const actual=state();assert.equal(actual.ip,HANDLER);assert.equal(words[664>>2],101);
        assert.equal(actual.cr2,write_fault?0x6005:0x6000);assert.equal(actual.regs[4],BASE+0x80-16);assert.equal(get32(BASE+0x80-16),write_fault?3:0);assert.equal(get32(BASE+0x80-12),PC+1,"saved EIP: the POP after INC EAX");
        assert.deepEqual(actual.sreg,[0x18,8,16,0x20,0x18,0x20]);assert.equal(mem[0x6005],0x92);
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`descriptor lookup/accessed-bit fault ${i}/${write_fault}`);descriptor_faults++;
    }
    console.log(`PASS: ${descriptor_faults} descriptor read/accessed-bit #PF cases without host traps`);
    let real_mode=0;
    for(let i=0;i<cases.length;i++) if(!cases[i][1]) for(const opt of [0,1]) for(const value of [0,0xA000,0xFFFF]){
        const configure=()=>{reset(i,false,value);e.ir_test_set_cr0(cr0&~0x80000001);cpu.segment_offsets[2]=0x70000;cpu.reg32[4]=0xABCD1000;cpu.sreg[2]=0x7000;set32(0x71000,value);mem.fill(0x5A,0x70FC0,0x71000);windows.push([0x70FC0,0x80]);e.full_clear_tlb();e.update_state_flags();};
        configure();instances[i][opt].exports.f(0);const actual=state();assert.equal(words[664>>2],102);
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`real-mode system stack ${i}/${value}`);real_mode++;
    }
    console.log(`PASS: ${real_mode} real-mode FLAGS/segment stack cases`);
    let vm_cases=0;
    for(const op of [0x9C,0x9D]) for(const width of [16,32]) for(const opt of [0,1]) for(const iopl of [0,3]) for(const extra of [0,0x190000]){
        const i=find(op,false,width),configure=()=>{reset(i,false,0x3202);user();cpu.segment_offsets[1]=0x10000;cpu.segment_offsets[2]=0x70000;cpu.reg32[4]=0x1000;cpu.stack_size_32[0]=0;cpu.sreg.set([0x2000,0x1000,0x7000,0x3000,0x4000,0x5000]);cpu.flags[0]=0x20002|iopl<<12|extra;cpu.instruction_pointer[0]=0x18000;mem.set(cases[i][0],0x18000);set32(0x71000,0x3202);windows.push([0x70FC0,0x80]);mem.fill(0x5A,0x70FC0,0x71000);set32(0x13000+0x70*4,iopl===0?0:0x70007);set32(0x13000+0x71*4,iopl===0?0:0x71007);e.full_clear_tlb();e.update_state_flags();events=[];};
        configure();instances[i][opt].exports.f(0);const actual=state();assert.equal(words[664>>2],iopl===0?101:102);
        if(iopl===0){assert.equal(actual.ip,HANDLER);assert.equal(actual.cpl,0);assert.equal(reads+writes,0,"VM86 permission check precedes stack data access");}
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`VM86 stack ${op}/${width}/${iopl}`);vm_cases++;
    }
    console.log(`PASS: ${vm_cases} VM86 PUSHF/POPF permission-priority and IOPL3 cases`);
    const port_write=(port,value)=>{const eax=cpu.reg32[0];cpu.reg32[0]=(eax&~255)|value;e.instr_E6(port);cpu.reg32[0]=eax;};
    let interrupts=0;
    for(const mode of [false,true]) for(const width of [16,32]) for(const opt of [0,1]) for(const ring3 of [false,true]){
        const i=find(0x9D,mode,width),configure=()=>{
            reset(i,true,0x202,0x80,false,ring3?0x3002:2);if(ring3)user();
            for(const [port,value] of [[0x20,0x11],[0x21,0x20],[0x21,4],[0x21,1],[0x21,0xFE]])port_write(port,value);
            cpu.device_lower_irq(0);cpu.device_raise_irq(0);
        };
        configure();instances[i][opt].exports.f(0);const actual=state();assert.equal(actual.ip,HANDLER);assert.equal(words[664>>2],102);assert.equal(actual.cpl,0);
        if(ring3){assert.equal(actual.regs[4],STACK-20);assert.equal(get32(STACK-8),BASE+0x80+width/8,"IRQ saves post-POPF ESP");}
        else assert.equal(actual.regs[4],BASE+0x80+width/8-12);
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`POPF pending IRQ width=${width} ring3=${ring3}`);interrupts++;
        cpu.device_lower_irq(0);port_write(0x21,0xFF);
    }
    console.log(`PASS: ${interrupts} immediate POPF IF-enable IRQ deliveries, with commit before transfer`);
    let abi=0;
    for(const op of [0x9D,0x1F]) for(const opt of [0,1]) for(const outcome of [0,1,2,3,4,99]){
        const i=find(op,true,32),name=op===0x9D?"ir_pop_flags":"ir_pop_segment";
        const custom={...imports,[name]:()=>{cpu.reg32[3]=0xC0FFEE;words[664>>2]=123;return outcome;}};
        const instance=new WebAssembly.Instance(modules[i][opt],{e:custom});reset(i,true);
        if(outcome===2||outcome===4)instance.exports.f(0);else assert.throws(()=>instance.exports.f(0),WebAssembly.RuntimeError);
        assert.equal(cpu.reg32[3]>>>0,0xC0FFEE);assert.equal(words[664>>2],123);abi++;
    }
    console.log(`PASS: ${abi} terminal CPU helper outcomes: authoritative state retained, Normal/invalid outcomes rejected`);
} finally {await vm.destroy();}
