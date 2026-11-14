import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { inspect_ipa } from "../../src/ios/ipa.js";
import { plist_parse, plist_encode } from "../../src/ios/plist.js";
import { macho_armv7 } from "../../src/apple/macho.js";
import { make_zip } from "../android/fixtures.mjs";

const enc = s => new TextEncoder().encode(s);
function executable({ subtype = 9, encrypted = false, minimum = 0x60000 } = {})
{
    const b = new Uint8Array(512), v = new DataView(b.buffer);
    const put = (a, n) => v.setUint32(a, n, true);
    put(0, 0xFEEDFACE); put(4, 12); put(8, subtype); put(12, 2); put(16, 3); put(20, 92);
    put(28, 1); put(32, 56); b.set(enc("__TEXT"), 36);
    put(52, 0x1000); put(56, 4096); put(64, 512);
    put(84, 0x25); put(88, 16); put(92, minimum);
    put(100, 0x21); put(104, 20); put(108, 256); put(112, 256); put(116, +encrypted);
    return b;
}
function info(extra = "")
{
    return enc(`<plist><dict><key>CFBundleIdentifier</key><string>org.v86.Fixture</string>
<key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleVersion</key><string>1</string>
<key>MinimumOSVersion</key><string>6.0</string><key>UIDeviceFamily</key><array><integer>1</integer></array>${extra}</dict></plist>`);
}
function archive({ main = executable(), plist = info(), extra = [] } = {})
{
    return make_zip([{ name: "Payload/Fixture.app/Info.plist", data: plist, store: true },
        { name: "Payload/Fixture.app/Fixture", data: main, store: true }, ...extra]);
}
const inspect = b => inspect_ipa((at, n) => b.subarray(at, at + n), b.length);

test("binary plist: Python plistlib interoperability, UTF-16, data and safe dictionary keys", () => {
    const b = Buffer.from("YnBsaXN0MDDWAQIDBAUGBwgLDA0OWV9fcHJvdG9fX1VhcnJheVVjb3VudFRkYXRhVGZsYWdUbmFtZVRzYWZlogkKEAEQAhAqQ2FiYwlibUuL1QgVHyUrMDU6P0JERkhMTQAAAAAAAAEBAAAAAAAAAA8AAAAAAAAAAAAAAAAAAABS", "base64");
    const p = plist_parse(b);
    assert.equal(p.name, "测试"); assert.equal(p.count, 42); assert.equal(p.flag, true);
    assert.deepEqual([...p.data], [97, 98, 99]); assert.deepEqual(p.array, [1, 2]);
    assert.equal(Object.getPrototypeOf(p), Object.prototype); assert.equal(p.__proto__, "safe");
    const broken = b.slice(); broken.fill(255, broken.length - 8);
    assert.throws(() => plist_parse(broken), /binary plist/);
});
test("binary plist: truncated data and cyclic references are rejected", () => {
    const b = new Uint8Array(43); b.set(enc("bplist00")); b.set([0xA1, 0], 8);
    b[10] = 8; b[17] = 1; b[18] = 1; b[26] = 1; b[42] = 10;
    assert.throws(() => plist_parse(b), /cyclic/);
    assert.throws(() => plist_parse(b.subarray(0, 34)), /binary plist/);
});
test("XML plist encoding preserves entitlements and binary resource hashes", () => {
    const value = { "application-identifier": "org.v86.Fixture", enabled: true, count: 9,
        hash: Uint8Array.of(0, 127, 255), names: ["<&>\"'", "测试"] };
    assert.deepEqual(plist_parse(plist_encode(value)), value);
});
test("IPA: valid ARMv7 metadata, resource integrity and original identity", async () => {
    const b = archive({ extra: [{ name: "Payload/Fixture.app/asset.txt", data: enc("hello") }] });
    const p = await inspect(b);
    assert.equal(p.report.bundle_id, "org.v86.Fixture"); assert.equal(p.report.architecture, "armv7");
    assert.equal(p.report.original_sha256, createHash("sha256").update(b).digest("hex"));
    assert.equal(p.main.parsed.filetype, 2);
});
test("IPA: accepts an explicit empty Payload directory, rejecting data and file masquerades", async () => {
    const directory = () => archive({ extra: [{ name: "Payload/", data: new Uint8Array(), store: true },
        { name: "Payload/Fixture.app/", data: new Uint8Array(), store: true }] });
    await inspect(directory());
    const mode = (b, value) => {
        const v = new DataView(b.buffer, b.byteOffset, b.byteLength); let at = v.getUint32(b.length - 6, true);
        while(v.getUint32(at, true) === 0x02014B50) {
            const n = v.getUint16(at + 28, true);
            if(new TextDecoder().decode(b.subarray(at + 46, at + 46 + n)) === "Payload/") {
                v.setUint16(at + 4, 3 << 8 | 20, true); v.setUint32(at + 38, value << 16, true); return b;
            }
            at += 46 + n + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
        }
        throw Error("Missing directory fixture");
    };
    await inspect(mode(directory(), 0o040755));
    await assert.rejects(inspect(mode(directory(), 0o100644)), /unexpected entry/);
    await assert.rejects(inspect(archive({ extra: [{ name: "Payload/", data: enc("data"), store: true }] })), /unexpected entry/);
});
test("IPA: rejects encrypted code, ARMv7s and newer OS versions", async () => {
    await assert.rejects(inspect(archive({ main: executable({ encrypted: true }) })), /encrypted/);
    await assert.rejects(inspect(archive({ main: executable({ subtype: 11 }) })), /ARMv7/);
    await assert.rejects(inspect(archive({ main: executable({ minimum: 0x70000 }) })), /requires iOS 7/);
    await assert.rejects(inspect(archive({ plist: info("<key>MinimumOSVersion</key><string>7.0</string>") })), /requires iOS 7/);
});
test("IPA: rejects traversal, duplicate paths, extra payloads and missing executable", async () => {
    for(const name of ["../bad", "Payload/Fixture.app/../bad", "/absolute", "Payload/Fixture.app/Info.plist", "Payload/Other.app/Info.plist"])
        await assert.rejects(inspect(archive({ extra: [{ name, data: enc("bad") }] })), /IPA:/);
    await assert.rejects(inspect(archive({ main: enc("not Mach-O") })), /missing ARMv7/);
});
test("IPA: CRC failure in resources is detected before preparation", async () => {
    const b = archive({ extra: [{ name: "Payload/Fixture.app/asset.txt", data: enc("known-resource"), store: true }] });
    const at = Buffer.from(b).indexOf("known-resource"); b[at] ^= 1;
    await assert.rejects(inspect(b), /CRC-32/);
});
test("Mach-O: selects ARMv7 Fat slice and validates slice bounds", () => {
    const b = new Uint8Array(1536), v = new DataView(b.buffer), arm = executable(), v7s = executable({ subtype: 11 });
    v.setUint32(0, 0xCAFEBABE); v.setUint32(4, 2);
    for(const [i, subtype] of [9, 11].entries()) {
        const at = 8 + 20 * i;
        [12, subtype, 512 + 512 * i, 512, 9].forEach((n, j) => v.setUint32(at + j * 4, n));
    }
    b.set(arm, 512); b.set(v7s, 1024);
    assert.deepEqual(macho_armv7(b).bytes, arm);
    v.setUint32(36, 512); assert.throws(() => macho_armv7(b), /bounds/);
    const malformed = executable(); new DataView(malformed.buffer).setUint32(20, 0, true);
    assert.throws(() => macho_armv7(malformed), /load command/);
});

test("IPA: resolves framework links and rejects indirect escapes, cycles and link parents", async()=>{
    const packageWithLinks=(links,regular=[])=>{
        const b=archive({extra:[...Object.entries(links).map(([name,target])=>({name:"Payload/Fixture.app/"+name,data:enc(target),store:true})),...regular]});
        const v=new DataView(b.buffer,b.byteOffset,b.byteLength);let at=v.getUint32(b.length-6,true);
        while(at+46<b.length && v.getUint32(at,true)===0x02014B50){
            const length=v.getUint16(at+28,true),name=new TextDecoder().decode(b.subarray(at+46,at+46+length));
            if(Object.hasOwn(links,name.slice("Payload/Fixture.app/".length))){v.setUint16(at+4,3<<8|20,true);v.setUint32(at+38,0o120777<<16,true);}
            at+=46+length+v.getUint16(at+30,true)+v.getUint16(at+32,true);
        }return b;
    };
    await inspect(packageWithLinks({"Versions/Current":"A",alias:"Versions/Current/asset.bin"},
        [{name:"Payload/Fixture.app/Versions/A/asset.bin",data:enc("asset")}])) ;
    await assert.rejects(inspect(packageWithLinks({a:".",b:"a/.."})),/chain escapes/);
    await assert.rejects(inspect(packageWithLinks({a:"b",b:"a"})),/cycle/);
    await assert.rejects(inspect(packageWithLinks({a:"."},[{name:"Payload/Fixture.app/a/child",data:enc("bad")}])),/parent directory/);
});
