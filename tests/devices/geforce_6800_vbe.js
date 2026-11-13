#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { V86 } from "../../src/main.js";
const root=new URL("../../",import.meta.url).pathname;
const file=path.join(root,"build/nv40-vbe-boot.bin");
const result=spawnSync("nasm",["-f","bin",path.join(root,"tests/devices/geforce_vbe.asm"),"-o",file],{encoding:"utf8"});
assert.equal(result.status,0,result.stderr);
const floppy=new Uint8Array(1440*1024);floppy.set(fs.readFileSync(file));
const vm=new V86({graphics_adapter:"geforce_6800",vram_size:128<<20,memory_size:32<<20,
    bios:{url:root+"bios/seabios.bin"},fda:{buffer:floppy.buffer},boot_order:0x321,
    net_device:{type:"none"},disable_speaker:true,autostart:true,log_level:0});
try
{
    await new Promise((resolve,reject)=>{vm.add_listener("emulator-ready",resolve);vm.add_listener("emulator-error",reject);});
    const cpu=vm.v86.cpu,nv=cpu.devices.graphics_adapter.device["nv"];
    const word=at=>cpu.read8(at)|cpu.read8(at+1)<<8;
    const start=performance.now();
    while(word(0x600A)!==0xBEEF && performance.now()-start<30000) await delay(20);
    await vm.stop();
    assert.equal(word(0x600A),0xBEEF,"VBE guest reached completion");
    for(let at=0x6000;at<=0x6008;at+=2) assert.equal(word(at),0x4F,"VBE service "+at.toString(16));
    assert.equal(word(0x600C),0x4F,"banked mode selection");
    assert.equal(word(0x600E),0x4F,"VBE save state");assert.equal(word(0x6010),0x4F,"800x600x16 mode");
    assert.equal(word(0x6012),0,"mode switch clears visible VRAM");assert.equal(word(0x6014),0x4F,"VBE restore through DOS text mode");
    assert.equal(String.fromCharCode(...Array.from({length:4},(_,i)=>cpu.read8(0x5000+i))),"VESA");
    assert.equal(word(0x5200+18),1024);assert.equal(word(0x5200+20),768);assert.equal(cpu.read8(0x5200+25),32);
    assert.equal(word(0x5200+16),4096,"VBE mode pitch");
    assert.equal(nv.display.mode().width,1024);assert.equal(nv.display.mode().height,768);
    assert.deepEqual([...nv.vram().subarray(0x20000,0x20004)],[0x33,0x22,0x11,0],"INT 10h bank maps A0000 to real VRAM");
    nv.display.on_vblank();nv.display.render();
    assert.equal(nv.display.front,0x20000);assert.deepEqual([...nv.display.pixels.data.subarray(0,4)],[17,34,51,255]);
    console.log("PASS: real NV40 VBE controller/mode query, 1024x768x32, banked VRAM and display start");
}
finally {await vm.destroy();}
