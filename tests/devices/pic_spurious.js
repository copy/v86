#!/usr/bin/env node
// Real INTA/IRET regression: a withdrawn or masked slave request must deliver
// IRQ15, so its guest handler can EOI the master's cascade before the next IRQ.
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const root = new URL("../../", import.meta.url).pathname;
const file = root + "build/pic-spurious.bin";
const assembled = spawnSync("nasm", ["-f", "bin", root + "tests/devices/pic_spurious.asm", "-o", file], {encoding:"utf8"});
assert.equal(assembled.status, 0, assembled.stderr);
for(const masked of [false, true])
{
    const floppy = new Uint8Array(1440 * 1024); floppy.set(fs.readFileSync(file));
    const vm = new V86({graphics_adapter:"bochs_vga", wasm_path:root+(+process.env.TEST_RELEASE_BUILD ? "build/v86.wasm" : "build/v86-debug.wasm"), memory_size:16<<20, bios:{url:root+"bios/seabios.bin"},
        vga_bios:{url:root+"bios/vgabios.bin"}, fda:{buffer:floppy.buffer}, boot_order:0x321,
        autostart:false, net_device:{type:"none"}, disable_speaker:true, log_level:0});
    try
    {
        await new Promise((resolve,reject)=>{vm.add_listener("emulator-ready",resolve);vm.add_listener("emulator-error",reject);});
        const cpu = vm.v86.cpu;
        cpu.io.register_read(0xEE, null, () => +masked);
        cpu.io.register_write(0xEE, null, value => {
            if(value === 0)
            {
                cpu.device_raise_irq(10);
                if(!masked) cpu.device_lower_irq(10);
            }
            else if(value === 1) cpu.device_raise_irq(10);
            else cpu.device_lower_irq(10);
        });
        vm.run();
        const start=performance.now();
        while(cpu.read16(0x600A)!==0xBEEF && performance.now()-start<15000) await delay(10);
        await vm.stop();
        assert.equal(cpu.read16(0x600A),0xBEEF,"guest completed after "+(masked?"mask":"withdrawal"));
        assert.deepEqual([...cpu.read_blob(0x6000,3)],[4,0,1],"spurious IRQ15 sets only master ISR2");
        assert.deepEqual([...cpu.read_blob(0x6004,3)],[4,4,1],"subsequent IRQ10 reaches both controllers");
        const pic=cpu.get_state_pic();assert.equal(pic[2],0);assert.equal(pic[5][2],0);
    }
    finally { await vm.destroy(); }
}
console.log("PASS: withdrawn/masked slave IRQ delivers spurious IRQ15 and leaves the cascade usable");
