// Synthetic browser fixture, no SDK, Apple code, signing tools or firmware.
import fs from "node:fs";
import { make_zip } from "../android/fixtures.mjs";
import { plist_encode } from "../../src/ios/plist.js";
const b=new Uint8Array(0x900),v=new DataView(b.buffer),put=(a,n)=>v.setUint32(a,n,true);
put(0,0xFEEDFACE);put(4,12);put(8,9);put(12,2);put(16,2);put(20,180);
put(28,1);put(32,124);b.set(new TextEncoder().encode("__TEXT"),36);
put(52,0x1000);put(56,0x1000);put(64,0x800);put(76,1);
b.set(new TextEncoder().encode("__text"),84);put(116,0x1400);put(120,0x100);put(124,0x400);
put(152,1);put(156,56);b.set(new TextEncoder().encode("__LINKEDIT"),160);put(176,0x2000);put(180,0x1000);put(184,0x800);put(188,0x100);
b.fill(0x42,0x400,0x500);
const info=plist_encode({CFBundleIdentifier:"org.v86.BrowserTest",CFBundleExecutable:"Test",CFBundleVersion:"1",CFBundleName:"Browser IPA Test",MinimumOSVersion:"6.0"});
fs.mkdirSync("build/ipa-tests",{recursive:true});
fs.writeFileSync("build/ipa-tests/test.ipa",make_zip([{name:"Payload/Test.app/Info.plist",data:info},{name:"Payload/Test.app/Test",data:b},
 {name:"Payload/Test.app/resource.dat",store:true,data:new Uint8Array(200000).map((_,i)=>i%251)}]));
console.log("Prepared synthetic browser IPA fixture");
