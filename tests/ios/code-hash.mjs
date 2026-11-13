import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sign_macho } from "../../src/ios/codesign.js";
import { cdhashes } from "../../src/ios/guest_load.js";

test("guest code identity verifies every page and rejects invalid signature bounds",{skip:process.platform!=="darwin"&&"native helper check requires CommonCrypto on the macOS build host"},()=>{
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),"v86-ipa-signature-"));
    try{
        const checker=path.join(temp,"check"),file=path.join(temp,"image");
        execFileSync(process.env.CC||"cc",["-O2","tests/ios/code-hash.c","-o",checker,...process.platform==="darwin"?[]:["-lcrypto"]],{stdio:"pipe"});
        const bytes=new Uint8Array(20000),v=new DataView(bytes.buffer),put=(a,n)=>v.setUint32(a,n,true);
        put(0,0xFEEDFACE);put(4,12);put(8,9);put(12,2);put(16,2);put(20,180);
        put(28,1);put(32,124);bytes.set(new TextEncoder().encode("__TEXT"),36);
        put(52,0x1000);put(56,20480);put(64,16384);put(76,1);put(124,0x400);
        put(152,1);put(156,56);bytes.set(new TextEncoder().encode("__LINKEDIT"),160);
        put(176,0x6000);put(180,4096);put(184,16384);put(188,3616);
        bytes.fill(0x71,1024);
        const signed=sign_macho(bytes,{identifier:"org.v86.NativeSignature",entitlements:{"application-identifier":"org.v86.NativeSignature"}});
        fs.writeFileSync(file,signed);
        assert.equal(execFileSync(checker,[file],{encoding:"utf8"}).trim(),Buffer.from(cdhashes(signed)[0]).toString("hex"));
        for(const at of [1024,8192,19999]){
            const broken=signed.slice();broken[at]^=1;fs.writeFileSync(file,broken);
            assert.throws(()=>execFileSync(checker,[file],{stdio:"pipe"}),"mutation in each signed page must fail");
        }
        const broken=signed.slice(),b=new DataView(broken.buffer);
        const signature=b.getUint32(28+180+8,true),directory=signature+b.getUint32(signature+16);
        b.setUint32(directory+16,0xFFFFFFF0);fs.writeFileSync(file,broken);
        assert.throws(()=>execFileSync(checker,[file],{stdio:"pipe"}));
    }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
