import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
import {WASM_TABLE_SIZE} from "../../../src/const.js";
const wasm=process.argv[2]||"build/v86-ir-cache-test.wasm";
let clock_mutation=null;
const vm=new V86({jit_switches:{x64_page_legacy32:0},graphics_adapter: "bochs_vga", wasm_fn:async imports=>{
    const tick=imports.env.microtick;
    imports.env.microtick=()=>{if(clock_mutation)clock_mutation();return tick();};
    return (await WebAssembly.instantiate(fs.readFileSync(wasm),imports)).instance.exports;
},memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),u32=n=>[n&255,n>>>8&255,n>>>16&255,n>>>24];
const PC=0x100000, DATA=0x200000, OFFSET=1024;
// Every table slot but 0 is free once IR and x64 page functions are released.
const POOL=WASM_TABLE_SIZE-1;
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));const cpu=vm.v86.cpu,e=cpu.wm.exports,table=cpu.wm.wasm_table;
    // These cases exercise the strict (byte-validating) admission contract and
    // its slow-path machinery; notified_validation.mjs covers the default.
    assert.equal(e.ir_cache_set_strict_validation(1), 1);
    const word=a=>new DataView(cpu.mem8.buffer,cpu.mem8.byteOffset).getUint32(a,true);
    const set=(a,n)=>new DataView(cpu.mem8.buffer,cpu.mem8.byteOffset).setUint32(a,n,true);
    const count=()=>new Uint32Array(e.memory.buffer)[664>>2];
    vm.run();let deadline=performance.now()+10000;while((word(0x500)&65535)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();await sleep(20);
    const clear=()=>{cpu.jit_clear_cache();e.ir_cache_collect();assert.equal(e.ir_cache_stat(1),0);};
    const prepare=(code,pc=PC)=>{
        clear();cpu.in_hlt[0]=0;cpu.flags[0]=2;cpu.flags_changed[0]=0;cpu.is_32[0]=1;cpu.stack_size_32[0]=1;
        cpu.segment_offsets.fill(0,0,6);cpu.instruction_pointer[0]=pc;cpu.reg32.set([0x7FFFFFFF,3,0,0,0x90000,0,DATA,0]);
        cpu.cr[0]=0x80010011|0;cpu.cr[3]=0x12000;cpu.cr[4]=512;
        set(0x12000,0x13003);set(0x12004,0x14003);set(0x12008,0x15003);
        for(let p=0;p<1024;p++){set(0x13000+p*4,(p<<12)|3);set(0x14000+p*4,0x400000+(p<<12)|3);}
        set(0x15000,PC|3);set(0x15004,PC+4096|3);
        e.full_clear_tlb();e.update_state_flags();vm.write_memory(Uint8Array.from(code),pc);
        new Uint32Array(e.memory.buffer)[664>>2]=0xFFFFFFFC;
    };
    const run=async(address=PC)=>{
        cpu.instruction_pointer[0]=address;cpu.in_hlt[0]=0;vm.run();const end=performance.now()+10000;
        while(!cpu.in_hlt[0]){assert(performance.now()<end,"guest halt timeout");await sleep(1);} await vm.stop();
    };
    const request=(length,tier=1,opt=1,cfg=1,budget=64,rep=8)=>cpu.ir_compile_cached(length,tier,opt,cfg,budget,rep);
    const reserve=(length=1)=>{
        const id=e.ir_compile_live(length,1,1,1,64,8);assert(id,`compile error ${e.ir_live_error()}`);
        const code=new Uint8Array(e.memory.buffer,e.ir_live_info(id,0)>>>0,e.ir_live_info(id,1)>>>0).slice();
        const slot=e.ir_cache_reserve(id);assert(slot);return {id,slot,code};
    };
    const install=async r=>{
        const {instance}=await WebAssembly.instantiate(r.code,{e:cpu.jit_imports});
        assert.equal(e.ir_cache_validate(r.id,r.slot),1);table.set(r.slot+OFFSET,instance.exports.f);assert.equal(e.ir_cache_finish(r.id,r.slot),1);
    };
    let programs=0;
    for(const recording of [0,1]) for(const tier of [1,2]) for(const opt of [0,1]){
        const code=[0x40,0x49,0x75,0xFC,0xA3,...u32(DATA),0xF4];prepare(code);
        e.performance_recording_enable(recording);const hits=e.ir_cache_stat(2);
        assert.equal(await request(code.length,tier,opt),true);assert.equal(e.ir_cache_stat(0),1);
        await run();assert.equal(e.ir_cache_stat(2)-hits,1);assert.equal(cpu.reg32[0]>>>0,0x80000002);assert.equal(word(DATA),0x80000002);assert.equal(count(),7);
        assert.equal(cpu.instruction_pointer[0],PC+code.length);programs++;
    }
    e.performance_recording_enable(0);
    console.log(`PASS: ${wasm}: ${programs} published CFG/store modules executed by normal CPU dispatch, both tier requests, optimization and recording modes`);
    for(const hint of [0,1]) {
        prepare([0x40,0xF4]);
        assert.equal(e.ir_cache_set_missing_hint(hint),1);
        const field=hint?37:28,negatives=e.ir_cache_stat(field);
        for(let n=0;n<3;n++) await run();
        assert(e.ir_cache_stat(field)>negatives,"repeated unpublished entry uses the selected negative witness");
        cpu.instruction_pointer[0]=PC;cpu.in_hlt[0]=0;assert(await request(1));
        const after_missing=e.ir_cache_stat(2);await run();
        assert.equal(e.ir_cache_stat(2)-after_missing,1,"publication invalidates a previous negative lookup");
        clear();const after_retire=e.ir_cache_stat(2);await run();
        assert.equal(e.ir_cache_stat(2),after_retire,"retired owners cannot survive in positive hints");
    }
    console.log(`PASS: ${wasm}: both negative-witness paths, publication invalidation and retirement`);
    // Only completed ordinary exits may bypass the outer dispatcher. Budget,
    // slow memory exits yield. Completed observer calls may request cold admission.
    for(const spec of [
        {name:"ordinary",code:[0x40,0x43,0xF4],length:1,next:1,budget:64,links:1},
        {name:"budget",code:[0x40,0x43,0xF4],length:2,next:1,budget:1,links:0},
        {name:"cold store",code:[0xA3,...u32(DATA),0x43,0xF4],length:5,next:5,budget:64,links:0},
        {name:"I/O",code:[0xE6,0x80,0x43,0xF4],length:2,next:2,budget:64,links:1},
        {name:"TSC",code:[0x0F,0x31,0x43,0xF4],length:2,next:2,budget:64,links:1},
    ]) {
        prepare(spec.code);
        assert(await request(spec.length,1,1,1,spec.budget));
        cpu.instruction_pointer[0]=PC+spec.next;
        assert(await request(1));
        const links=e.ir_cache_stat(6),before_count=count();
        await run();
        assert.equal(e.ir_cache_stat(6)-links,spec.links,`${spec.name} continuation policy`);
        assert.equal((count()-before_count)>>>0,3,`${spec.name} exact retirement`);
        assert.equal(cpu.reg32[3],1);
    }
    console.log(`PASS: ${wasm}: ordinary and completed I/O/TSC successors chain; budget and cold-store exits yield with exact retirement`);
    for(const mutation of ["bytes","mapping","context"]) {
        prepare([0xE4,0x93,0x43,0xF4]);
        const alternate=PC+0x4000;
        vm.write_memory(Uint8Array.of(0xE4,0x93,0x4B,0xF4),alternate);
        cpu.io.register_read(0x93,null,()=>{
            if(mutation==="bytes") cpu.mem8[PC+2]=0x4B;
            else if(mutation==="mapping") {set(0x13000+(PC>>>12)*4,alternate|3);e.full_clear_tlb();}
            else cpu.instruction_pointer[0]=alternate+2;
            return 0x7A;
        });
        assert(await request(2));cpu.instruction_pointer[0]=PC+2;assert(await request(1));
        const before=count();await run();
        assert.equal(cpu.reg32[3],-1,`${mutation}: observer successor must use the changed instruction`);
        assert.equal(cpu.reg32[0]&255,0x7A);assert.equal((count()-before)>>>0,3);
    }
    console.log(`PASS: ${wasm}: I/O cold continuation revalidates raw code writes, remapping and changed control flow`);
    for(const mutation of ["bytes","mapping","context"]) {
        prepare([0x43,0x0F,0x31,0x43,0xF4]);
        const alternate=PC+0x4000;
        vm.write_memory(Uint8Array.of(0x43,0x0F,0x31,0x4B,0xF4),alternate);
        assert(await request(3));cpu.instruction_pointer[0]=PC+3;assert(await request(1));
        let observed=false;
        clock_mutation=()=>{
            if(cpu.instruction_pointer[0]!==PC+3) return;
            clock_mutation=null;observed=true;
            assert.equal(cpu.reg32[3],1,"timestamp observer sees the preceding dirty GPR");
            if(mutation==="bytes")cpu.mem8[PC+3]=0x4B;
            else if(mutation==="mapping"){set(0x13000+(PC>>>12)*4,alternate|3);e.full_clear_tlb();}
            else cpu.instruction_pointer[0]=alternate+3;
        };
        const before=count();await run();assert(observed);
        assert.equal(cpu.reg32[3],0);assert.equal((count()-before)>>>0,4);
    }
    console.log(`PASS: ${wasm}: TSC observer sees precise state and rejects stale code, remappings and changed targets`);
    // Unlike the preceding cold-link cases, the tail is in the *same* owner.
    // No timer callback is needed to boot these straight-line cases once set up.
    for(const kind of ["port","clock"]) for(const mutation of ["none","bytes","mapping","context","xmm","irq"]) {
        const op=kind==="port"?[0xE4,0x93]:[0x0F,0x31];
        prepare([0x43,...op,0x43,0xF4]);
        const raw=new Uint8Array(e.memory.buffer);
        // Quiescent test setup: clear both PIC IRRs, not a production bypass.
        raw[e.get_pic_addr_master()+3]=0;raw[e.get_pic_addr_slave()+3]=0;
        const alternate=PC+0x4000;
        vm.write_memory(Uint8Array.of(0x43,...op,0x4B,0xF4),alternate);
        let observations=0;
        const observe=()=>{
            observations++;assert.equal(cpu.reg32[3],1,"observer sees preceding dirty SSA value");
            if(mutation==="bytes")cpu.mem8[PC+3]=0x4B;
            if(mutation==="mapping"){set(0x13000+(PC>>>12)*4,alternate|3);e.full_clear_tlb();}
            if(mutation==="context")cpu.instruction_pointer[0]=alternate+3;
            if(mutation==="xmm")cpu.reg_xmm32s[0]=0x12345678;
            if(mutation==="irq")raw[e.get_pic_addr_master()+3]=1;
            return 0x7A;
        };
        cpu.io.register_read(0x93,null,observe);
        if(kind==="clock")clock_mutation=()=>{if(cpu.instruction_pointer[0]===PC+3){clock_mutation=null;observe();}};
        assert(await request(4));const before=count(),checked=e.ir_cache_stat(32),rejected=e.ir_cache_stat(33);
        await run();clock_mutation=null;
        assert.equal(observations,1,`${kind}/${mutation}: never replay completed observer`);
        assert.equal((count()-before)>>>0,4);
        assert.equal(cpu.reg32[3],["bytes","mapping","context"].includes(mutation)?0:2);
        if(mutation==="xmm")assert.equal(cpu.reg_xmm32s[0],0x12345678,"failed reload cannot overwrite host XMM mutation");
        if(mutation==="none"){
            assert(e.ir_cache_stat(32)>checked,"owner bytes/mappings actually checked");
            assert.equal(e.ir_cache_stat(33),rejected);
            assert.equal(e.ir_cache_entry_stat(PC,0,1,3),3,"observer and tail execute in one activation");
        }
    }
    clock_mutation=null;
    console.log(`PASS: ${wasm}: in-owner scalar port/TSC continuation, exact retirement and raw-code/mapping/context/XMM/IRQ barriers`);
    // A pending bit alone must not break an owner. Compare the read-only query
    // against controller masking/priority, and check re-evaluation after a host
    // callback unmasks the same request. IF stays clear so the cold tail halts.
    for(const kind of ["port","clock"]) for(const policy of ["masked","in-service","unmask"]) {
        const op=kind==="port"?[0xE4,0x93]:[0x0F,0x31];
        prepare([0x43,...op,0x43,0xF4]);
        const raw=new Uint8Array(e.memory.buffer),master=e.get_pic_addr_master(),slave=e.get_pic_addr_slave();
        const saved=raw.slice(master,master+13),saved_slave=raw.slice(slave,slave+13);
        raw[master]=policy==="in-service"?1:0;raw[master+2]=policy==="in-service"?1:0;
        raw[master+3]=1;raw[master+12]=0;raw[slave+3]=0;
        assert.equal(e.ir_sti_no_pending_irq(),1);
        assert.equal(raw[master+3],1,"query does not acknowledge masked/in-service IRQ");
        let observations=0;
        const observe=()=>{observations++;if(policy==="unmask")raw[master]=1;return 0x7A;};
        cpu.io.register_read(0x93,null,observe);
        if(kind==="clock")clock_mutation=()=>{if(cpu.instruction_pointer[0]===PC+3){clock_mutation=null;observe();}};
        assert(await request(4));const before=count();await run();clock_mutation=null;
        assert.equal(observations,1);assert.equal((count()-before)>>>0,4);assert.equal(cpu.reg32[3],2);
        assert.equal(e.ir_cache_entry_stat(PC,0,1,3),policy==="unmask"?2:3);
        assert.equal(raw[master+3],1,"continuation preserves outstanding request");
        raw.set(saved,master);raw.set(saved_slave,slave);
    }
    console.log(`PASS: ${wasm}: masked/in-service IRQ continuation and callback unmask recheck`);
    for(const depth of [1,2]) for(const masked of [false,true]) {
        const code=[0x43,...Array(depth).fill(0xFB),0x90,0x43,0xF4];prepare(code);
        const raw=new Uint8Array(e.memory.buffer);
        const master=e.get_pic_addr_master(),slave=e.get_pic_addr_slave();
        const saved=raw.slice(master,master+13),saved_slave_local=raw.slice(slave,slave+13);
        raw[master]=0;raw[master+3]=+masked;raw[slave+3]=0;
        assert(await request(code.length-1));const before=count();await run();
        assert.equal(cpu.reg32[3],2);assert.equal((count()-before)>>>0,depth+4);
        assert.equal(e.ir_cache_entry_stat(PC,0,1,3),depth+3,"STI shadow retains SSA into its following block");
        assert.equal(raw[master+3],+masked,"STI leaves masked request pending");
        raw.set(saved,master);raw.set(saved_slave_local,slave);
    }
    console.log(`PASS: ${wasm}: no-pending single/nested STI shadow keeps following arithmetic in the same activation`);
    for(const enabled of [false,true]) {
        prepare([0xFB,0x90,0x43,0xF4]);cpu.flags[0]=enabled?0x202:2;
        assert(await request(2));cpu.instruction_pointer[0]=PC+2;assert(await request(1));
        const links=e.ir_cache_stat(6),before=count();await run();
        assert.equal(cpu.reg32[3],1);assert.equal((count()-before)>>>0,4);
        assert.equal(e.ir_cache_stat(6)-links,enabled?1:0,"STI observes IRQs and respects changed control flags before chaining");
    }
    prepare([0x40,0xF4]);assert(await request(1));await run();
    let cached_checks=e.ir_cache_stat(8),capture_fallbacks=e.ir_cache_stat(9),warm_hits=e.ir_cache_stat(2);
    let guest_steps=e.ir_cache_stat(10),zero_step_exits=e.ir_cache_stat(12);
    const entry_hits=e.ir_cache_entry_stat(PC,0,1,1),entry_steps=e.ir_cache_entry_stat(PC,0,1,2);
    const entry_zero=e.ir_cache_entry_stat(PC,0,1,4);
    assert.equal(e.ir_cache_entry_stat(PC,0,1,0),1);
    assert.equal(e.ir_cache_entry_stat(PC,0,1,5),1);
    await run();assert.equal(e.ir_cache_stat(2)-warm_hits,1);
    assert(e.ir_cache_stat(8)-cached_checks>=2,"warm admission uses cached pre/post source validation");
    assert.equal(e.ir_cache_stat(9),capture_fallbacks,"warm admission avoids read-only snapshot fallback");
    assert.equal((e.ir_cache_stat(10)-guest_steps)>>>0,1,"activation diagnostics count the retired INC");
    assert(e.ir_cache_stat(11)>=1,"activation diagnostics retain the maximum retired work");
    assert.equal(e.ir_cache_stat(12),zero_step_exits,"normal activation is not a zero-step exit");
    assert.equal((e.ir_cache_entry_stat(PC,0,1,1)-entry_hits)>>>0,1,"entry-scoped hit count isolates the selected region");
    assert.equal((e.ir_cache_entry_stat(PC,0,1,2)-entry_steps)>>>0,1,"entry-scoped guest steps isolate the selected region");
    assert(e.ir_cache_entry_stat(PC,0,1,3)>=1,"entry-scoped maximum records retired work");
    assert.equal(e.ir_cache_entry_stat(PC,0,1,4),entry_zero,"normal entry activation is not a zero-step exit");
    assert.equal(e.ir_cache_entry_stat(PC+1,0,1,0),0,"entry diagnostics require an exact entry key");
    assert.equal(e.ir_cache_set_fast_validation(2),0);
    for(const recording of [0,1]) {
        const checks=[];
        for(const fast of [0,1]) {
            const other=PC+0x2000,iterations=128;
            prepare([0x43,0xFF,0xE1]);
            vm.write_memory(Uint8Array.from([0x4A,0x0F,0x85,...u32(PC-other-7),0xF4]),other);
            cpu.reg32[1]=other;cpu.reg32[2]=iterations;
            assert(await request(3));cpu.instruction_pointer[0]=other;assert(await request(7));
            assert.equal(e.ir_cache_set_fast_validation(fast),1);e.performance_recording_enable(recording);
            const full=e.ir_cache_stat(19),reuse=e.ir_cache_stat(18),post=e.ir_cache_stat(20),targets=e.ir_cache_stat(21),start=count();
            const successors=e.ir_cache_stat(29),warm_admissions=e.ir_cache_stat(34);
            await run();
            assert.equal(cpu.reg32[3],iterations);assert.equal(cpu.reg32[2],0);
            assert.equal((count()-start)>>>0,iterations*4+1);
            checks.push(e.ir_cache_stat(19)-full);
            assert.equal(e.ir_cache_stat(18)>reuse,!!fast);
            assert.equal(e.ir_cache_stat(20)>post,!!fast);
            assert.equal(e.ir_cache_stat(34)>warm_admissions,!!fast,
                "single-guard admission is used only when actual fetch translations are warm");
            assert(e.ir_cache_stat(21)>targets,"warm targets hit the bounded entry cache");
            assert(e.ir_cache_stat(29)>successors,"repeated normal edges reuse an owner-checked successor");
        }
        assert(checks[1]<checks[0]/2,"fast admission eliminates most repeated byte checks");
    }
    e.performance_recording_enable(0);assert.equal(e.ir_cache_set_fast_validation(1),1);
    // A continuing MMIO read may mutate code without notifying the JIT. The
    // emitted observer barrier must revoke an earlier entry's byte certificate.
    for(const mutation of ["bytes","mapping"]) {
        const other=PC+0x2000,alternate=PC+0x1000;
        prepare([0x43,0xFF,0xE1]);
        vm.write_memory(Uint8Array.of(0x45,0xFF,0xE1),alternate);
        vm.write_memory(Uint8Array.from([0x8B,0x06,0x4A,0x0F,0x85,...u32(PC-other-9),0xF4]),other);
        cpu.reg32[1]=other;cpu.reg32[2]=4;cpu.reg32[6]=0xA0040;
        let reads=0;
        cpu.io.mmap_register(0xA0000,0x20000,()=>0,()=>{},()=>{
            reads++;
            assert.equal(e.ir_cache_set_fast_validation(0),0,"active guest cannot change admission policy");
            if(reads===3) {
                if(mutation==="bytes") cpu.mem8[PC]=0x45;
                else {set(0x13000+(PC>>>12)*4,alternate|3);e.full_clear_tlb();}
            }
            return 0;
        },()=>{});
        assert(await request(3));cpu.instruction_pointer[0]=other;assert(await request(9));
        const start=count();await run();
        assert.equal(reads,4);assert.equal(cpu.reg32[3],3);assert.equal(cpu.reg32[5],1);
        assert.equal((count()-start)>>>0,21,`${mutation}: stale successor must never execute`);
        assert.equal(e.ir_cache_entry_stat(PC,0,1,0),0);
    }
    console.log(`PASS: ${wasm}: fast/full admission A/B with recording off/on, exact retirement, fewer byte checks, raw MMIO code writes and callback remapping`);
    console.log(`PASS: ${wasm}: warm one-page IR admission validates cached mapping/source bytes without recapture and records entry-scoped activation work`);
    const structured_publications=e.ir_cache_stat(13),generic_publications=e.ir_cache_stat(14);
    prepare([0xEB,0xFE]);assert(await request(2));
    assert.equal(e.ir_cache_stat(13)-structured_publications,1,"structured publication counter advances");
    assert.equal(e.ir_cache_stat(14),generic_publications,"structured loop does not count as generic publication");
    assert.equal(e.ir_cache_entry_stat(PC,0,1,6),1,"self-loop publication uses structured CFG");
    assert.equal(e.ir_cache_entry_stat(PC,0,1,7),1,"structured self-loop records one backedge");
    assert.equal(e.ir_cache_entry_stat(PC,0,1,8),0,"structured self-loop bypasses generic dispatch edges");
    assert(e.ir_cache_entry_stat(PC,0,1,9)>0,"structured self-loop records directly emitted edges");
    clear();
    console.log(`PASS: ${wasm}: simple published self-loop selects direct structured Wasm control flow`);
    // Entry fetch has architectural A-bit effects. A cold secondary page is not
    // eagerly fetched just because it belongs to the immutable request window.
    prepare([0xB8,...u32(0x12345678),0xF4],PC+4094);assert(await request(5));
    let fetch_hits=e.ir_cache_stat(2);assert.equal(word(0x13000+(PC>>>12)*4)&32,0);
    await run(PC+4094);assert.equal(e.ir_cache_stat(2),fetch_hits);assert.equal(word(0x13000+(PC>>>12)*4)&32,32);
    assert.equal(word(0x13000+(PC>>>12)*4+4)&32,32);assert.equal(cpu.reg32[0],0x12345678);
    await run(PC+4094);assert.equal(e.ir_cache_stat(2)-fetch_hits,1);
    prepare([0xEB,0xFA,0x90,0x90,0x90,0x90],PC+4094);vm.write_memory(Uint8Array.of(0xF4),PC+4090);assert(await request(6));
    fetch_hits=e.ir_cache_stat(2);await run(PC+4094);assert.equal(e.ir_cache_stat(2),fetch_hits);
    assert.equal(word(0x13000+(PC>>>12)*4+4)&32,0,"unreachable secondary page retains clear A bit");
    e.ir_memory_read(PC+4096,1);await run(PC+4094);assert.equal(e.ir_cache_stat(2)-fetch_hits,1);
    console.log(`PASS: ${wasm}: cold entry fetch sets A bits, cross-page code waits for visible translations, unreachable pages are not eagerly accessed`);
    // Code aliases its own PTE: initial translation changes ADD's opcode (03)
    // into AND (23). Revalidation must reject the pre-fetch artifact.
    prepare([0x90],PC+0x400);cpu.reg32[0]=DATA;cpu.reg32[6]=-1;set(DATA,0x12345678);
    set(0x13400,0x13003);vm.write_memory(Uint8Array.of(0xF4),0x13404);e.full_clear_tlb();
    assert(await request(2));fetch_hits=e.ir_cache_stat(2);await run(PC+0x400);
    assert.equal(e.ir_cache_stat(2),fetch_hits);assert.equal(cpu.reg32[6],0x12345678);assert.equal(e.ir_cache_stat(0),0);
    prepare([0x8B,0x06,0xF4]);set(0x13000+(DATA>>>12)*4,0);
    cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;set(0x2000+14*8,8<<16);set(0x2004+14*8,0x180000|0x8E00);
    vm.write_memory(Uint8Array.of(0xF4),0x180000);assert(await request(2));fetch_hits=e.ir_cache_stat(2);await run();
    assert.equal(e.ir_cache_stat(2)-fetch_hits,1);assert.equal(cpu.cr[2]>>>0,DATA);assert.equal(cpu.instruction_pointer[0],0x180001);
    assert.deepEqual([0,4,8,12].map(n=>word(0x8FFF0+n)),[0,PC,8,2]);assert.equal(count(),0xFFFFFFFD);assert.equal(e.ir_cache_stat(0),0);
    console.log(`PASS: ${wasm}: fetch A-bit writes invalidate code/PTE aliases and an admitted data #PF preserves the exact exception frame without retiring the faulting instruction`);
    // Pending slots cannot execute; identity and phase validation precede installation.
    prepare([0x40,0xF4]);let r=reserve();const empty=table.get(r.slot+OFFSET);assert.equal(empty,null);
    assert.equal(e.ir_cache_finish(r.id,r.slot),0);assert.equal(e.ir_cache_validate(r.id,r.slot+65536),0);
    assert.equal(e.ir_cache_validate(r.id+1n,r.slot),0);let hits=e.ir_cache_stat(2);await run();assert.equal(e.ir_cache_stat(2),hits);
    // Publication is valid after the CPU moves; admission still needs the saved entry.
    await install(r);cpu.reg32[0]=5;await run();assert.equal(cpu.reg32[0],6);assert.equal(e.ir_cache_stat(2)-hits,1);
    assert.equal(e.ir_cache_validate(r.id,r.slot),0);assert.equal(e.ir_cache_finish(r.id,r.slot),0);
    // Same-byte host writes invalidate, and a pending cancellation can reuse the slot.
    prepare([0x40,0xF4]);r=reserve();vm.write_memory(Uint8Array.of(0x40),PC);assert.equal(e.ir_cache_validate(r.id,r.slot),0);e.ir_cache_collect();
    let newer=reserve();assert.equal(newer.slot,r.slot);assert.equal(e.ir_cache_validate(r.id,r.slot),0);assert.equal(e.ir_cache_cancel(r.id,r.slot),0);await install(newer);
    hits=e.ir_cache_stat(2);await run();assert.equal(e.ir_cache_stat(2)-hits,1);
    // Read-only byte/mapping re-observation catches unnotified writes and stale TLB semantics.
    prepare([0x40,0xF4]);assert(await request(1));cpu.mem8[PC]=0x48;hits=e.ir_cache_stat(2);await run();assert.equal(cpu.reg32[0],0x7FFFFFFE);assert.equal(e.ir_cache_stat(2),hits);
    prepare([0x40,0xF4]);assert(await request(1));vm.write_memory(Uint8Array.of(0x40,0xF4),PC+4096);
    set(0x13000+(PC>>>12)*4,PC+4096|3);e.full_clear_tlb();hits=e.ir_cache_stat(2);await run();assert.equal(e.ir_cache_stat(2),hits);
    // Cross-page dependency watch must reject even a same-byte guest write on page two.
    prepare([0xB8,...u32(0x12345678),0xF4],PC+4094);assert(await request(5));
    vm.write_memory(Uint8Array.from([0xC6,0x05,...u32(PC+4096),0x56,0xF4]),PC+0x2000);hits=e.ir_cache_stat(2);await run(PC+0x2000);
    assert.equal(e.ir_cache_stat(0),0);await run(PC+4094);assert.equal(e.ir_cache_stat(2),hits);assert.equal(cpu.reg32[0],0x12345678);
    // A store into the currently executing region exits before stale trailing bytes.
    prepare([0xC6,0x05,...u32(PC+7),0x48,0x40,0xF4]);assert(await request(9));hits=e.ir_cache_stat(2);await run();
    assert.equal(e.ir_cache_stat(2)-hits,1);assert.equal(cpu.reg32[0],0x7FFFFFFE);assert.equal(e.ir_cache_stat(1),0);
    // A failed replacement must retain the existing published entry.
    prepare([0x40,0xF4]);assert(await request(1));r=reserve();assert.equal(e.ir_cache_cancel(r.id,r.slot),1);e.ir_cache_collect();
    hits=e.ir_cache_stat(2);await run();assert.equal(e.ir_cache_stat(2)-hits,1);
    // Reset/restore drop entries; an old pending browser completion cannot reinstall them.
    prepare([0x40,0xF4]);r=reserve();const snapshot=await vm.save_state();await vm.restore_state(snapshot);
    assert.equal(e.ir_cache_validate(r.id,r.slot),0);e.ir_cache_collect();assert.equal(e.ir_cache_stat(1),0);
    console.log(`PASS: ${wasm}: pending/duplicate/forged/ABA publication, moved IP, raw and same-byte guest/host writes, physical remapping, secondary dependencies, active SMC and restore`);
    // IR-12 link lookup is a validated graph hint, never an unchecked call.
    prepare([0x40,0xF4]);assert(await request(1));cpu.instruction_pointer[0]=PC;
    const link_before=e.ir_cache_stat(6),miss_before=e.ir_cache_stat(7);
    let packed=e.ir_cache_link_target();assert.notEqual(packed,0n);assert.equal(e.ir_cache_stat(6)-link_before,1);
    assert.notEqual(Number(packed&0xFFFFFFFFn),0);
    cpu.instruction_pointer[0]=PC+0x1000;assert.equal(e.ir_cache_link_target(),0n);assert.equal(e.ir_cache_stat(7)-miss_before,1);
    cpu.instruction_pointer[0]=PC;vm.write_memory(Uint8Array.of(0x40),PC);assert.equal(e.ir_cache_link_target(),0n);
    e.ir_cache_collect();assert.equal(e.ir_cache_stat(0),0);
    console.log(`PASS: ${wasm}: validated IR link lookup rejects absent/stale targets without unchecked table dispatch`);
    // Keep the actual running function/reservation alive through a synchronous I/O callback.
    for(const reset of [false,true]){
        prepare([0xEE,0xF4]);cpu.reg32[2]=0x502;r=reserve();await install(r);let callbacks=0;
        const f=table.get(r.slot+OFFSET);
        cpu.io.register_write(0x502,null,()=>{
            callbacks++;if(reset)cpu.jit_clear_cache();else vm.write_memory(Uint8Array.of(0xEE),PC);
            assert.equal(e.ir_cache_stat(0),0);assert.equal(e.ir_cache_stat(1),1);
            assert.equal(e.ir_cache_collect(),0);assert.equal(table.get(r.slot+OFFSET),f);
            assert.equal(e.ir_compile_live(1,1,1,1,64,8),0n);assert.equal(e.ir_live_error(),2);
            assert.equal(e.ir_cache_reserve(r.id),0);
        });
        await run();assert.equal(callbacks,1);assert.equal(e.ir_cache_stat(1),0);assert.equal(table.get(r.slot+OFFSET),null);
    }
    prepare([0xF3,0xA4,0xF4]);cpu.reg32[7]=DATA+16;vm.write_memory(Uint8Array.of(11,22,33),DATA);
    assert(await request(2,1,1,1,64,0));hits=e.ir_cache_stat(2);await run();
    assert.equal(e.ir_cache_stat(2)-hits,1);assert.equal(cpu.reg32[1],0);assert.deepEqual(Array.from(vm.read_memory(DATA+16,3)),[11,22,33]);
    assert.equal(e.ir_cache_stat(1),0);
    console.log(`PASS: ${wasm}: active I/O write/reset retains its table slot until return, rejects nested compilation, and zero-retirement REP exits resume interpretation`);
    // Table capacity accounting includes IR reservations.
    prepare([0x40,0xF4]);const free=e.jit_get_wasm_table_index_free_list_count();assert.equal(e.ir_cache_capacity(),768);assert.equal(e.ir_cache_set_capacity(255),0);assert.equal(e.ir_cache_set_capacity(769),0);assert.equal(e.ir_cache_set_capacity(256),1);const capacity=e.ir_cache_capacity();assert.equal(capacity,256);
    for(let i=0;i<capacity;i++){const address=PC+i*4096;vm.write_memory(Uint8Array.of(0x40,0xF4),address);cpu.instruction_pointer[0]=address;assert(await request(1));}
    assert.equal(e.ir_cache_stat(0),capacity);assert.equal(e.jit_get_wasm_table_index_free_list_count(),free-capacity);
    cpu.instruction_pointer[0]=PC+capacity*4096;vm.write_memory(Uint8Array.of(0x40,0xF4),PC+capacity*4096);assert.equal(await request(1),false);
    clear();assert.equal(e.jit_get_wasm_table_index_free_list_count(),POOL);
    console.log(`PASS: ${wasm}: ${capacity} IR entries share the bounded ${POOL}-slot pool, capacity rejection and complete reclamation`);
    // Browser failures and out-of-order completion use the production JS bridge.
    const original=WebAssembly.instantiate;
    try {
        for(const kind of ["sync","async","missing","table"]){
            prepare([0x40,0xF4]);
            WebAssembly.instantiate=kind==="sync"?()=>{throw new WebAssembly.CompileError("controlled");}:kind==="async"?()=>Promise.reject(new WebAssembly.CompileError("controlled")):kind==="missing"?()=>Promise.resolve({instance:{exports:{}}}):original;
            const old_set=table.set;
            if(kind==="table")table.set=(index,f)=>{if(f!==null) throw new TypeError("controlled table failure");return old_set.call(table,index,f);};
            try {assert.equal(await request(1),false);} finally {table.set=old_set;}
            e.ir_cache_collect();assert.equal(e.ir_cache_stat(1),0);assert.equal(e.jit_get_wasm_table_index_free_list_count(),POOL);
        }
        prepare([0x40,0xF4]);const queued=[];WebAssembly.instantiate=(code,imports)=>new Promise((resolve,reject)=>queued.push({code,imports,resolve,reject}));
        const old=request(1);assert.equal(queued.length,1);clear();const replacement=request(1);assert.equal(queued.length,2);
        queued[1].resolve(await original(queued[1].code,queued[1].imports));assert.equal(await replacement,true);
        queued[0].resolve(await original(queued[0].code,queued[0].imports));assert.equal(await old,false);
        hits=e.ir_cache_stat(2);await run();assert.equal(e.ir_cache_stat(2)-hits,1);
        for(const changed of ["wasm","exports","table"]){
            prepare([0x40,0xF4]);const pending=request(1),job=queued.at(-1);
            const result=await original(job.code,job.imports),owner=cpu.wm,owner_exports=owner.exports,owner_table=owner.wasm_table;
            try {
                if(changed==="wasm")cpu.wm={...owner};else if(changed==="exports")owner.exports={...owner_exports};else owner.wasm_table={};
                job.resolve(result);assert.equal(await pending,false);assert.equal(e.ir_cache_stat(0),0);
            } finally {cpu.wm=owner;owner.exports=owner_exports;owner.wasm_table=owner_table;}
            clear();assert.equal(e.jit_get_wasm_table_index_free_list_count(),POOL);
        }
    } finally {WebAssembly.instantiate=original;}
    console.log(`PASS: ${wasm}: synchronous/asynchronous browser failures, missing exports, table failure, changed VM/export/table identities and late completion through the actual publication bridge`);
} finally { await vm.destroy(); }
