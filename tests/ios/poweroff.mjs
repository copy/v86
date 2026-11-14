// A guest MMIO write removes power before its following UDF can execute.
import assert from "node:assert/strict";
import path from "node:path";
import { V86 } from "../../src/main.js";
const directory=process.argv[2];
if(!directory)throw Error("usage: poweroff.mjs owner-provided-10B329-directory");
const emulator=new V86({machine_type:"s5l8930",graphics_adapter:"none",autostart:false,log_level:0,
    wasm_path:path.resolve("build/v86-arm64.wasm"),jit_switches:{a64_page:1},
    ios:{kernelcache:{url:path.resolve(directory,"kernelcache.n90.macho")},
        devicetree:{url:path.resolve(directory,"DeviceTree.n90ap.bin")}}});
try
{
    await new Promise((resolve,reject)=>{emulator.add_listener("emulator-loaded",resolve);emulator.add_listener("emulator-error",reject);});
    const cpu=emulator.v86.cpu,pmu=cpu.devices.apple_i2c0;
    pmu.write(0,0x74);pmu.write(0x10,0x12);pmu.write(0x18,1);pmu.write(0x20,0x11);
    const code=new Uint32Array([0xE3000024,0xE3480320,0xE3A01005,0xE5801000,0xE7F0DEF0]);
    cpu.write_blob_physical(new Uint8Array(code.buffer),0x41000000);
    cpu.wm.exports.a32_boot(0x41000000,0);
    cpu.run_cores();
    assert.equal(cpu.powered_off(),true);
    assert.equal(await emulator.power_state(),"S5");
    assert.equal(cpu.undefined_instructions().el1,0,"the instruction after D1815 power removal never runs");
    const pc=cpu.read_pc();cpu.run_cores();assert.equal(cpu.read_pc(),pc);
    await emulator.restart("power-on");
    assert.equal(cpu.powered_off(),false);assert.equal(pmu.pmu[0x12]&1,0);
    console.log("PASS: native D1815 power removal stops the guest before its next instruction; a power cycle resets the controller");
}
finally{await emulator.destroy();}
