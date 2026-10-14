import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
import {WASM_TABLE_SIZE} from "../../../src/const.js";
const wasm=process.argv[2]||"build/v86-ir-cache-test.wasm",PC=0x100000;
// Every table slot but 0 is free once IR and x64 page functions are released.
const POOL=WASM_TABLE_SIZE-1;
// disable_jit: IR starts idle (no scheduler, no page tier); each case enables it.
const vm=new V86({graphics_adapter: "bochs_vga", wasm_path:wasm,disable_jit:true,memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),u32=n=>[n&255,n>>>8&255,n>>>16&255,n>>>24];
const until=async(test,label)=>{const end=performance.now()+15000;while(!test()){assert(performance.now()<end,label);await sleep(1);}};
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));const cpu=vm.v86.cpu,e=cpu.wm.exports;
    const word=a=>new DataView(cpu.mem8.buffer,cpu.mem8.byteOffset).getUint32(a,true);
    vm.run();await until(()=>(word(0x500)&65535)===0xCAFE,"boot");await vm.stop();await sleep(20);
    if(process.env.IR_DIAGNOSTICS) assert.equal(await vm.configure_ir_diagnostics(Number(process.env.IR_DIAGNOSTICS)),true);
    assert.equal(e.ir_auto_set_hot_filter(2),0);
    // Hot-region fusion is off by default; these cases cover its automatic pipeline.
    assert.equal(e.ir_cache_stat(26),0);assert.equal(e.ir_cache_set_fusion(1),1);
    if(process.env.IR_HOT_FILTER !== undefined) assert.equal(e.ir_auto_set_hot_filter(Number(process.env.IR_HOT_FILTER)),1);
    const configure=(enabled=1,threshold=2,promote=4)=>assert.equal(e.ir_auto_config(enabled,threshold,promote,192,256,64),1);
    const stats=()=>Array.from({length:12},(_,i)=>e.ir_auto_stat(i));
    const publisher=cpu.ir_auto_publish;let cold_publications=0;
    cpu.ir_auto_publish=function(id,slot,ptr,len){
        assert.equal(e.ir_entry_matches(cpu.instruction_pointer[0],cpu.segment_offsets[1],cpu.is_32[0]),1,"publication starts outside JIT frames");
        assert.equal(e.ir_auto_stat(10),1);e.ir_auto_complete(id,1);assert.equal(e.ir_auto_stat(10),1,"premature completion cannot consume a pending task");
        cold_publications++;return publisher.call(this,id,slot,ptr,len);
    };
    const prepare=async(code=[0x40,0xEB,0xFD],address=PC)=>{
        await vm.stop();configure(0);cpu.jit_clear_cache();e.ir_cache_collect();
        cpu.in_hlt[0]=0;cpu.flags[0]=2;cpu.flags_changed[0]=0;cpu.segment_offsets.fill(0,0,6);cpu.is_32[0]=1;cpu.stack_size_32[0]=1;
        cpu.reg32.fill(0);cpu.reg32[4]=0x90000;cpu.instruction_pointer[0]=address;e.update_state_flags();
        vm.write_memory(Uint8Array.from(code),address);new Uint32Array(e.memory.buffer)[664>>2]=0;
    };
    assert.equal(e.ir_auto_stat(11),0);assert.equal(e.ir_auto_config(2,1,1,192,256,64),0);assert.equal(e.ir_auto_config(1,0,1,192,256,64),0);
    assert.equal(e.ir_auto_optimizations(3,0),0);assert.equal(e.ir_auto_optimizations(2,0xFFFFFFFF),0);
    for(const recording of [0,1]){
        await prepare();e.performance_recording_enable(recording);const before=stats(),hits=e.ir_cache_stat(2);configure();vm.run();
        await until(()=>e.ir_auto_stat(5)>before[5]&&e.ir_cache_stat(2)>hits,"automatic Tier 1/2 publication");await vm.stop();
        const count=new Uint32Array(e.memory.buffer)[664>>2],eax=cpu.reg32[0]>>>0,at_jump=cpu.instruction_pointer[0]===PC+1;
        assert.equal(count,(eax*2-(at_jump?1:0))>>>0);assert([PC,PC+1].includes(cpu.instruction_pointer[0]));
        assert(e.ir_auto_stat(2)>before[2]&&e.ir_auto_stat(3)>before[3]&&e.ir_auto_stat(4)>before[4]);
        const level=e.ir_auto_optimization_stat(0),mask=e.ir_auto_optimization_stat(1);
        assert.equal(e.ir_auto_optimizations(0,0),0,"enabled scheduler/cached code refuses policy mutation");
        assert.equal(e.ir_auto_optimization_stat(0),level);assert.equal(e.ir_auto_optimization_stat(1),mask);
    }
    e.performance_recording_enable(0);
    console.log(`PASS: ${wasm}: automatic Tier 1 compilation, safe optimized promotion and actual CPU execution with exact loop counts, recording off/on`);
    await prepare();
    try {
        const independent=stats(),independent_hits=e.ir_cache_stat(2);configure();vm.run();await until(()=>e.ir_auto_stat(5)>independent[5]&&e.ir_cache_stat(2)>independent_hits,"IR compilation");await vm.stop();
        const n=new Uint32Array(e.memory.buffer)[664>>2];assert.equal(n,(cpu.reg32[0]*2-(cpu.instruction_pointer[0]===PC+1?1:0))>>>0);
    } finally {await vm.stop();}
    console.log(`PASS: ${wasm}: automatic IR compilation from an empty cache preserves exact retirement`);
    await prepare();cpu.is_32[0]=0;cpu.segment_offsets[1]=PC-0x1000;cpu.reg32[0]=0x76540000;e.update_state_flags();let mode_before=stats();configure();vm.run();
    await until(()=>e.ir_auto_stat(5)>mode_before[5],"16-bit automatic promotion");await vm.stop();
    const mode_count=new Uint32Array(e.memory.buffer)[664>>2];assert([PC,PC+1].includes(cpu.instruction_pointer[0]));
    assert.equal(cpu.reg32[0]>>>0,(0x76540000|((mode_count+(cpu.instruction_pointer[0]===PC+1?1:0))/2&65535))>>>0);
    console.log(`PASS: ${wasm}: 16-bit automatic compilation/promotion retains CS-relative entry and AX partial-register semantics`);
    await prepare([0x40,...Array(40).fill(0x90),0xE9,...u32(-46)]);let long_before=stats();configure();vm.run();
    await until(()=>e.ir_auto_stat(5)>long_before[5],"larger Tier 2 region");await vm.stop();
    const offset=cpu.instruction_pointer[0]-PC;assert(offset>=0&&offset<=41);
    assert.equal(new Uint32Array(e.memory.buffer)[664>>2],((cpu.reg32[0]-(offset?1:0))*42+offset)>>>0);
    console.log(`PASS: ${wasm}: a 42-instruction loop spans lightweight regions and preserves exact retirement through the larger optimized region`);
    await prepare([0x40,...Array(254).fill(0x90),0xE9,...u32(-260)]);
    const bounded_before=stats();
    configure();vm.run();
    try {
        await until(()=>e.ir_auto_stat(5)>bounded_before[5],"budget-limited Tier 2 prefix publishes");
        await vm.stop();
        const offset=cpu.instruction_pointer[0]-PC;
        assert(offset>=0&&offset<=255);
        assert.equal(new Uint32Array(e.memory.buffer)[664>>2],((cpu.reg32[0]-(offset?1:0))*256+offset)>>>0);
    } finally {await vm.stop();}
    console.log(`PASS: ${wasm}: a 256-instruction loop promotes a bounded Tier 2 prefix without legacy compilation and preserves exact retirement`);
    const ram=0x80000,rmw=Array.from({length:48},()=>[0xFF,0x05,...u32(ram)]).flat();
    await prepare([...rmw,0xE9,...u32(-rmw.length-5)]);vm.write_memory(Uint8Array.of(0,0,0,0),ram);
    const memory_before=stats();configure();vm.run();
    try {
        await until(()=>e.ir_auto_stat(5)>memory_before[5],"fallthrough RAM region promotes");await vm.stop();
        const offset=cpu.instruction_pointer[0]-PC,position=offset/6;
        assert(Number.isInteger(position)&&position>=0&&position<=48);
        const increments=word(ram);assert(increments>=position);
        assert.equal(new Uint32Array(e.memory.buffer)[664>>2],((increments-position)/48*49+position)>>>0);
    } finally {await vm.stop();}
    console.log(`PASS: ${wasm}: automatic linear RAM/RMW regions preserve memory commits and exact instruction retirement`);
    // PUSH/POP used to split every CFG activation at the store, including warm
    // ordinary stack RAM. Require the guarded continuation to reach a backedge.
    await prepare([0x50,0x5A,0x40,0xEB,0xFB]);
    configure();vm.run();
    try {
        await until(()=>e.ir_cache_entry_stat(PC,0,1,5)===2 && e.ir_cache_entry_stat(PC,0,1,3)>4,"stack store CFG loop continues");
        await vm.stop();
        const offset=cpu.instruction_pointer[0]-PC,eax=cpu.reg32[0]>>>0;
        assert(offset>=0&&offset<=3);
        assert.equal(new Uint32Array(e.memory.buffer)[664>>2],(eax*4+offset-(offset===3?4:0))>>>0);
        assert.equal(cpu.reg32[4]>>>0,0x90000-(offset===1?4:0));
        assert.equal(cpu.reg32[2]>>>0,(eax-(offset<2||offset===3?1:0))>>>0);
    } finally {await vm.stop();}
    console.log(`PASS: ${wasm}: guarded stack stores continue through the CFG backedge with exact ESP/register/retirement state`);
    {
        const other=PC+0x2000;
        await prepare([0x43,0xFF,0xE1]);
        vm.write_memory(Uint8Array.of(0xE6,0x80,0xFF,0xE2),other);
        cpu.reg32[1]=other;cpu.reg32[2]=PC;
        configure();vm.run();
        try {
            await until(()=>[PC,other].some(at=>e.ir_cache_entry_stat(at,0,1,10)>=2 && e.ir_cache_entry_stat(at,0,1,3)>=3),
                "an observed I/O cycle executes inside one fused owner");
            await vm.stop();
            const ip=cpu.instruction_pointer[0];
            const pending=new Map([[PC,0],[PC+1,3],[other,2],[other+2,1]]);
            assert(pending.has(ip));
            assert.equal(new Uint32Array(e.memory.buffer)[664>>2],(cpu.reg32[3]*4-pending.get(ip))>>>0);
            const active=[PC,other].filter(at=>e.ir_cache_entry_stat(at,0,1,10)>=2 && e.ir_cache_entry_stat(at,0,1,3)>=3);
            assert(active.length>0);
            vm.write_memory(cpu.mem8.slice(other,other+1),other);
            for(const at of active) assert.equal(e.ir_cache_entry_stat(at,0,1,0),0,"peer code invalidates every executing fused owner");
        } finally {await vm.stop();}
    }
    console.log(`PASS: ${wasm}: observed successor fusion preserves I/O state, retirement and source invalidation`);
    {
        const addresses=[PC,PC+0x2000,PC+0x4000,PC+0x6000];
        await prepare([0x40,0xFF,0xE2]);
        [[0x41,0xFF,0xE3],[0x45,0xFF,0xE6],[0x40,0xFF,0xE7]].forEach((code,i)=>vm.write_memory(Uint8Array.from(code),addresses[i+1]));
        cpu.reg32[2]=addresses[1];cpu.reg32[3]=addresses[2];cpu.reg32[6]=addresses[3];cpu.reg32[7]=PC;
        configure();vm.run();
        try {
            await until(()=>addresses.some(p=>e.ir_cache_entry_stat(p,0,1,10)===4&&e.ir_cache_entry_stat(p,0,1,3)>16),"four witnessed hot sources fuse progressively");
            await vm.stop();const ip=cpu.instruction_pointer[0];
            assert(addresses.some(p=>ip===p||ip===p+1));
            assert.equal(new Uint32Array(e.memory.buffer)[664>>2],((cpu.reg32[0]+cpu.reg32[1]+cpu.reg32[5])*2-(addresses.some(p=>ip===p+1)?1:0))>>>0);
            const root=addresses.find(p=>e.ir_cache_entry_stat(p,0,1,10)===4);
            vm.write_memory(cpu.mem8.slice(addresses[3],addresses[3]+1),addresses[3]);
            assert.equal(e.ir_cache_entry_stat(root,0,1,0),0,"fourth source write retires extended fusion");
        } finally {await vm.stop();}
    }
    console.log(`PASS: ${wasm}: closed four-source fusion, exact carried state/count and fourth-source invalidation`);
    for(const recording of [0,1]) {
        await prepare([0x40,0xFF,0xE2]);
        const other=PC+0x2000;
        vm.write_memory(Uint8Array.of(0x41,0xFF,0xE3),other);
        cpu.reg32[2]=other;cpu.reg32[3]=PC;
        const linked=e.ir_auto_stat(1),fused=e.ir_cache_stat(23),fused_hits=e.ir_cache_stat(24);
        e.performance_recording_enable(recording);configure();vm.run();
        try {
            await until(()=>e.ir_cache_entry_stat(PC,0,1,5)===2 && e.ir_cache_entry_stat(other,0,1,5)===2 && e.ir_auto_stat(1)>linked,"IR-to-IR successors execute and promote");
            await until(()=>e.ir_cache_stat(23)>fused && e.ir_cache_stat(24)>fused_hits,"hot indirect regions fuse and execute with retained state");
            await until(()=>[PC,other].some(p=>e.ir_cache_entry_stat(p,0,1,10)===2 && e.ir_cache_entry_stat(p,0,1,3)>8),"fused activation crosses repeated edges");
            await vm.stop();
            const ip=cpu.instruction_pointer[0];assert([PC,PC+1,other,other+1].includes(ip));
            assert.equal(new Uint32Array(e.memory.buffer)[664>>2],((cpu.reg32[0]+cpu.reg32[1])*2-([PC+1,other+1].includes(ip)?1:0))>>>0);
            const root=[PC,other].find(p=>e.ir_cache_entry_stat(p,0,1,10)===2);
            const peer=root===PC?other:PC;
            if(recording) {
                const saved=await vm.save_state();await vm.restore_state(saved);
                assert.equal(e.ir_cache_stat(0),0,"restore drops fused artifacts and their code dependencies");
            } else {
                vm.write_memory(cpu.mem8.slice(peer,peer+1),peer);
                assert.equal(e.ir_cache_entry_stat(root,0,1,0),0,"same-byte write to peer invalidates fused root");
            }
        } finally {await vm.stop();e.performance_recording_enable(0);}
    }
    console.log(`PASS: ${wasm}: automatic hot-region fusion retains state over repeated indirect edges, preserves exact retirement with recording off/on, and invalidates on peer writes and restore`);
    {
        const other=PC+0x2000, peer=PC+12;
        await prepare([0x40,0xA9,...u32(1),0x0F,0x85,...u32(other-PC-12),0x41,0xE9,...u32(other-PC-18)]);
        vm.write_memory(Uint8Array.of(0x46,0x83,0xF2,12,0xFF,0xE2),other);
        cpu.reg32[2]=PC;
        // Seed both siblings at the same tier; wall-clock frame endings must
        // not decide whether one sibling races ahead to Tier 2 alone.
        for(const [at,length] of [[PC,18],[peer,6],[other,6]]) {
            cpu.instruction_pointer[0]=at;assert(await cpu.ir_compile_cached(length,1,1,1,256,64));
        }
        cpu.instruction_pointer[0]=PC;
        // Isolate alias ownership from independent trace promotion, which can
        // legitimately replace only one alias while preserving the other owner.
        assert.equal(e.ir_cache_set_fusion(0),1);
        const batches=e.ir_auto_stat(25);
        configure();vm.run();
        try {
            await until(()=>e.ir_auto_stat(25)>batches && e.ir_cache_entry_stat(PC,0,1,11)>=2 && e.ir_cache_entry_stat(PC,0,1,12)===e.ir_cache_entry_stat(peer,0,1,12),"hot entries share one automatically published body");
            await vm.stop();
            const ip=cpu.instruction_pointer[0];
            const pending=new Map([[PC,0],[PC+1,2],[PC+6,1],[peer,0],[peer+1,1],[other,0],[other+1,2],[other+4,1]]);
            assert(pending.has(ip));
            assert.equal(new Uint32Array(e.memory.buffer)[664>>2],(3*cpu.reg32[0]+2*cpu.reg32[1]+3*cpu.reg32[6]-pending.get(ip))>>>0);
            assert(e.ir_cache_entry_stat(PC,0,1,11) >= 2);
            assert.equal(e.ir_cache_entry_stat(PC,0,1,12),e.ir_cache_entry_stat(peer,0,1,12),"aliases use the same table slot");
            configure(0);assert.equal(e.ir_auto_stat(17),0,"shared artifact has no queued duplicate body");
        } finally {await vm.stop();assert.equal(e.ir_cache_set_fusion(1),1);}
    }
    console.log(`PASS: ${wasm}: automatic shared-body hot entries, one table slot, cancellation and independently checked retirement`);
    await prepare([0xEB,0x02,0xCC,0xCC,0x40,0xEB,0xF9]);let before=stats();let reachable_hits=e.ir_cache_stat(2);configure();vm.run();
    await until(()=>e.ir_cache_entry_stat(PC,0,1,5)===2&&e.ir_cache_stat(2)>reachable_hits,"reachable forward-edge Tier 1/2 region");await vm.stop();
    assert([PC,PC+4,PC+5].includes(cpu.instruction_pointer[0]),"forward target and loop header remain inside the compiled region");
    assert(cpu.reg32[0]>>>0>0,"reachable loop executes after the forward jump");
    assert.equal(e.ir_cache_entry_stat(PC,0,1,0),1,"hot entry publishes an exact cache record");
    assert.equal(e.ir_cache_entry_stat(PC,0,1,6),1,"entry region uses structured backend");
    assert(e.ir_cache_entry_stat(PC,0,1,7)>=1,"entry region records the loop backedge");
    assert(e.ir_cache_entry_stat(PC,0,1,9)>=2,"entry region contains multiple directly structured edges");
    assert.equal(e.ir_cache_entry_stat(PC,0,1,8),0,"reachable reducible region avoids generic dispatcher edges");
    console.log(`PASS: ${wasm}: Tier-aware region formation follows a forward jump over dead bytes and publishes the hot reducible loop entry`);
    // The legacy 82 /0 alias is valid in 32-bit mode, but its LOCK form remains
    // a region compile stop. Illegal LOCK NOP now correctly delivers #UD.
    // Exercise failure suppression without depending on that old CPU bug.
    await prepare([0xF0,0x82,0x05,...u32(0x80000),1,0xEB,0xF6]);before=stats();configure();vm.run();
    await until(()=>e.ir_auto_stat(6)>before[6]&&e.ir_auto_stat(8)>before[8],"compile-stop suppression");await sleep(80);
    const attempts=e.ir_auto_stat(2)+e.ir_auto_stat(3);await sleep(100);assert.equal(e.ir_auto_stat(2)+e.ir_auto_stat(3),attempts);
    vm.write_memory(Uint8Array.of(0x40,0xEB,0xFD),PC);await until(()=>e.ir_auto_stat(4)>before[4],"recompile changed code");await vm.stop();
    console.log(`PASS: ${wasm}: unchanged unsupported lowering is not repeatedly compiled; host code writes enable recompilation`);
    // Browser rejection of an upgrade retains the working Tier 1 entry.
    const original=WebAssembly.instantiate;
    const is_ir=code=>WebAssembly.Module.imports(new WebAssembly.Module(code)).some(i=>i.module==="e" && ["ir_entry_matches","ir_enter_checked"].includes(i.name));
    for(const invalidate of ["peer-write","disabled"]) {
        let held;
        const other=PC+0x2000;
        await prepare([0x40,0xFF,0xE2]);vm.write_memory(Uint8Array.of(0x41,0xFF,0xE3),other);
        cpu.reg32[2]=other;cpu.reg32[3]=PC;
        const published=e.ir_cache_stat(23);
        try {
            WebAssembly.instantiate=(code,imports)=>WebAssembly.Module.imports(new WebAssembly.Module(code)).some(i=>i.name==="ir_admission_epoch_address")
                ?new Promise((resolve,reject)=>{held={code,imports,resolve,reject};}):original(code,imports);
            configure();vm.run();await until(()=>held,"hold fused publication");await vm.stop();
            if(invalidate==="disabled")assert.equal(e.ir_cache_set_fusion(0),1);
            else {vm.write_memory(cpu.mem8.slice(PC,PC+1),PC);vm.write_memory(cpu.mem8.slice(other,other+1),other);}
            held.resolve(await original(held.code,held.imports));await sleep(20);
            assert.equal(e.ir_cache_stat(23),published,"stale or disabled fusion cannot publish");
            assert.equal(e.ir_auto_stat(10),0);
        } finally {await vm.stop();WebAssembly.instantiate=original;assert.equal(e.ir_cache_set_fusion(1),1);}
    }
    console.log(`PASS: ${wasm}: held fused publication rejects writes to its sources and fusion disable`);
    for(const invalidate of ["configure","SMC"]) {
        let held;
        const other=PC+0x2000,peer=PC+12;
        await prepare([0x40,0xA9,...u32(1),0x0F,0x85,...u32(other-PC-12),0x41,0xE9,...u32(other-PC-18)]);
        vm.write_memory(Uint8Array.of(0x46,0x83,0xF2,12,0xFF,0xE2),other);cpu.reg32[2]=PC;
        for(const [at,length] of [[PC,18],[peer,6],[other,6]]) {
            cpu.instruction_pointer[0]=at;assert(await cpu.ir_compile_cached(length,1,1,1,256,64));
        }
        cpu.instruction_pointer[0]=PC;
        const shared=e.ir_auto_stat(25),published=e.ir_cache_stat(31);
        assert.equal(e.ir_cache_set_fusion(0),1);
        try {
            WebAssembly.instantiate=(code,imports)=>is_ir(code)&&e.ir_auto_stat(25)>shared
                ?new Promise((resolve,reject)=>{held={code,imports,resolve,reject};})
                :original(code,imports);
            configure();vm.run();await until(()=>held,"hold shared-body publication before either alias installs");await vm.stop();
            assert.equal(e.ir_auto_stat(17),0,"shared body does not compile duplicate siblings");
            if(invalidate==="configure") configure(0);
            else vm.write_memory(Uint8Array.of(0x41),peer);
            assert.equal(e.ir_auto_stat(17),0,`${invalidate} leaves no queued stale duplicate`);
            held.resolve(await original(held.code,held.imports));await sleep(20);
            assert.equal(e.ir_auto_stat(10),0);
            assert.equal(e.ir_cache_stat(31),published,"a cancelled shared owner never publishes");
            assert(e.ir_cache_entry_stat(peer,0,1,11)<=1,"only a prior independent owner may survive cancellation");
        } finally {await vm.stop();WebAssembly.instantiate=original;assert.equal(e.ir_cache_set_fusion(1),1);}
    }
    console.log(`PASS: ${wasm}: held shared-body publication rejects all aliases after configuration changes and same-byte SMC`);
    try {
        await prepare();before=stats();configure(1,2,1000000);vm.run();await until(()=>e.ir_auto_stat(4)>before[4],"Tier 1 before rejected upgrade");await vm.stop();
        WebAssembly.instantiate=(code,imports)=>is_ir(code)?Promise.reject(new WebAssembly.CompileError("controlled auto failure")):original(code,imports);
        before=stats();let hits=e.ir_cache_stat(2);configure(1,2,2);vm.run();await until(()=>e.ir_auto_stat(7)>before[7]&&e.ir_auto_stat(8)>before[8],"failed promotion suppression");
        const failed_attempts=e.ir_auto_stat(3);await sleep(100);assert.equal(e.ir_auto_stat(3),failed_attempts);assert(e.ir_cache_stat(2)>hits);await vm.stop();
    } finally {WebAssembly.instantiate=original;}
    console.log(`PASS: ${wasm}: browser upgrade failure is suppressed while the existing Tier 1 entry keeps executing`);
    // One in-flight automatic task; restore/reset can supersede its owner.
    try {
        await prepare();before=stats();const queued=[];
        WebAssembly.instantiate=(code,imports)=>is_ir(code)?new Promise((resolve,reject)=>queued.push({code,imports,resolve,reject})):original(code,imports);
        configure();vm.run();await until(()=>queued.length===1,"pending auto task");await sleep(70);assert.equal(queued.length,1);assert.equal(e.ir_auto_stat(10),1);
        cpu.jit_clear_cache();await until(()=>queued.length===2,"new generation auto task");
        queued[1].resolve(await original(queued[1].code,queued[1].imports));await until(()=>e.ir_auto_stat(4)>before[4],"replacement publication");
        configure(0);queued[0].resolve(await original(queued[0].code,queued[0].imports));await sleep(30);assert.equal(e.ir_auto_stat(10),0);assert.equal(e.ir_cache_stat(0),1);await vm.stop();
    } finally {WebAssembly.instantiate=original;}
    console.log(`PASS: ${wasm}: one pending automatic task, reset supersession and stale out-of-order completion`);
    await prepare();before=stats();configure();vm.run();await until(()=>e.ir_auto_stat(4)>before[4],"before save");await vm.stop();
    const saved=await vm.save_state();await vm.restore_state(saved);assert.equal(e.ir_auto_stat(11),1);assert.equal(e.ir_cache_stat(0),0);before=stats();vm.run();
    await until(()=>e.ir_auto_stat(4)>before[4],"automatic rebuild after snapshot restore");await vm.stop();
    console.log(`PASS: ${wasm}: snapshot restore drops runtime entries and automatic compilation rebuilds them`);
    // Automatic eviction preserves manually published entries and the shared pool bound.
    await prepare([0x40,0xF4]);assert(await cpu.ir_compile_cached(1,1,1,1,64,8));configure(1,1,1000000);
    // The default holds a whole XP working set; bound the smallest pool here.
    assert.equal(e.ir_cache_capacity(),768);assert.equal(e.ir_cache_set_capacity(256),1);
    const capacity=e.ir_cache_capacity();assert.equal(capacity,256);
    for(let i=1;i<=capacity+8;i++){
        await vm.stop();const address=PC+i*4096;vm.write_memory(Uint8Array.of(0x40,0xEB,0xFD),address);cpu.instruction_pointer[0]=address;cpu.in_hlt[0]=0;
        before=stats();const entry_hits=e.ir_cache_stat(2);vm.run();await until(()=>e.ir_auto_stat(4)>before[4]&&e.ir_cache_stat(2)>entry_hits,`automatic capacity entry ${i}`);assert(e.ir_cache_stat(1)<=capacity);
    }
    await sleep(40);await until(()=>e.ir_auto_stat(10)===0,"capacity publications settle");
    const stationary=e.ir_auto_stat(2);await sleep(80);assert.equal(e.ir_auto_stat(2),stationary,"evicted inactive entries do not recompile from historical heat");
    await vm.stop();configure(0);assert.equal(e.ir_cache_stat(0),capacity);cpu.instruction_pointer[0]=PC;cpu.in_hlt[0]=0;let hits=e.ir_cache_stat(2);vm.run();await until(()=>cpu.in_hlt[0],"retained explicit entry");await vm.stop();assert.equal(e.ir_cache_stat(2)-hits,1);
    assert(e.ir_auto_stat(9)<=128);cpu.jit_clear_cache();e.ir_cache_collect();assert.equal(e.jit_get_wasm_table_index_free_list_count(),POOL);
    assert(e.ir_auto_stat(27)>0,"exhausted frame credit takes the idle negative hint");
    assert(e.ir_auto_stat(28)>0,"work-bearing visits still reach cold publication checks");
    console.log(`PASS: ${wasm}: ${capacity+8} automatically compiled entries use bounded eviction while preserving an explicit entry; premature completion and cold publication guards (${cold_publications} publications)`);
    if(process.env.IR_DIAGNOSTICS) {
        const d=vm.get_jit_info().ir.diagnostics;
        assert.equal(d.totals.instrumentation_errors,0);
        assert.equal(Object.values(d.exits).reduce((n,r)=>n+r.count,0),d.totals.ir_activations);
        assert(d.exits.budget.count>0 && d.exits.normal.count>0);
        assert(d.discovery_latency.tier1.count>0 && d.discovery_latency.tier1.ms>0);
        assert.equal(Object.values(d.missing_entries).reduce((a,b)=>a+b,0),d.admission.missing);
    }
} finally {await vm.destroy();}
