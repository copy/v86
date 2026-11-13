#!/usr/bin/env node
// Real PCI configuration writes, generated stores and interpreter stores must
// all respect the i440FX shadow write enables; readonly writes do not fault.
import assert from "node:assert/strict";
import fs from "node:fs";
import {spawnSync} from "node:child_process";
import {setTimeout as delay} from "node:timers/promises";
const release=!!+process.env.TEST_RELEASE_BUILD;
const {V86}=await import(release?"../../build/libv86.mjs":"../../src/main.js");
const root=new URL("../../",import.meta.url).pathname,file=root+"build/pam-shadow.bin";
const assembled=spawnSync("nasm",["-f","bin",root+"tests/devices/pam_shadow.asm","-o",file],{encoding:"utf8"});
assert.equal(assembled.status,0,assembled.stderr);
for(const interpreter of [false,true])
{
    const floppy=new Uint8Array(1440*1024);floppy.set(fs.readFileSync(file));
    const vm=new V86({graphics_adapter:"bochs_vga",wasm_path:root+(release?"build/v86.wasm":"build/v86-debug.wasm"),disable_jit:interpreter,memory_size:16<<20,
        bios:{url:root+"bios/seabios.bin"},vga_bios:{url:root+"bios/vgabios.bin"},fda:{buffer:floppy.buffer},boot_order:0x321,
        autostart:false,net_device:{type:"none"},disable_speaker:true,log_level:0});
    try
    {
        await new Promise((resolve,reject)=>{vm.add_listener("emulator-ready",resolve);vm.add_listener("emulator-error",reject);});
        await vm.run();const cpu=vm.v86.cpu,start=performance.now();
        while(![0xBEEF,0xDEAD].includes(cpu.read32s(0x6000)) && performance.now()-start<20000)await delay(10);
        await vm.stop();assert.equal(cpu.read32s(0x6000),0xBEEF,"PAM guest check "+cpu.read32s(0x6004)+", interpreter="+interpreter);
        const state=await vm.save_state();
        cpu.devices.pci.config_write(0,0x5B,1,0x33);cpu.write32(0xC8000,0x12345678);assert.equal(cpu.read32s(0xC8000),0x12345678);
        await vm.restore_state(state);cpu.write32(0xC8000,0);assert.equal(cpu.read32s(0xC8000)>>>0,0x99AABBCC,"snapshot restores PAM protection from PCI state");
    }
    finally {await vm.destroy();}
}
console.log("PASS: i440FX PAM byte/word/dword/SIMD/locked/string stores, JIT relock, paging and snapshot protection");
