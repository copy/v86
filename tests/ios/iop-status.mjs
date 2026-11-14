// A private ARM7 firmware reads the real privileged CPSR through the JIT.
import assert from "node:assert/strict";
import path from "node:path";
import { V86 } from "../../src/main.js";
const directory = process.argv[2];
if(!directory) throw Error("usage: iop-status.mjs owner-provided-10B329-directory");
const emulator = new V86({machine_type:"s5l8930",graphics_adapter:"none",autostart:false,log_level:0,
    wasm_path:path.resolve("build/v86-arm64.wasm"),jit_switches:{a64_page:1},
    ios:{kernelcache:{url:path.resolve(directory,"kernelcache.n90.macho")},
        devicetree:{url:path.resolve(directory,"DeviceTree.n90ap.bin")}}});
try
{
    await new Promise((resolve,reject)=>{emulator.add_listener("emulator-loaded",resolve);emulator.add_listener("emulator-error",reject);});
    const cpu=emulator.v86.cpu,iop=cpu.devices.apple_iop,base=0x41000000;
    // MOVW/MOVT; MSR CPSR_fsxc; MOV r2,#4096; MRS r1,CPSR; STR; B MRS.
    const code=new Uint32Array([0xE30001D3,0xE34A080F,0xE12FF000,0xE3A02A01,0xE10F1000,0xE5821000,0xEAFFFFFC]);
    cpu.write_blob_physical(new Uint8Array(code.buffer),base);
    iop.write(0x110,base);iop.write(0x114,8192);iop.write(0x100,1);
    for(let n=0;n<60;n++){iop.run();await new Promise(resolve=>setImmediate(resolve));}
    const data=new DataView(cpu.mem8.buffer,cpu.mem8.byteOffset+cpu.ram_offset(base+4096,4),4);
    assert.equal(data.getUint32(0,true),0xA80F01D3,"NZCVQ, GE, A/I/F masks and supervisor mode are live");
    const before=cpu.wm.exports.a32_iop_native();
    const helpers=cpu.page_tier_stats().helpers;
    iop.run();
    assert.ok(cpu.wm.exports.a32_iop_native()>before);
    assert.equal(cpu.page_tier_stats().helpers,helpers,"compiled MRS does not save/reload GPRs through the interpreter");
    const diagnostics=await emulator.get_diagnostics(true);
    assert.ok(Number.isInteger(diagnostics.cores[0].fpcr));
    assert.ok(Number.isInteger(diagnostics.cores[0].fpsr));
    assert.ok(Array.isArray(diagnostics.steps.helped_words));
    assert.equal((await emulator.get_diagnostics()).steps,undefined,"instruction counters are opt-in");
    console.log("PASS: privileged native IOP MRS preserves flags, GE and interrupt masks without interpreter helpers");
}
finally{await emulator.destroy();}
