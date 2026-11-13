import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { prepare_ipa } from "../../src/ios/ipa_prepare.js";
import { inspect_ipa } from "../../src/ios/ipa.js";
import { sign_macho, macho_entitlements, macho_link_library, macho_embed_info } from "../../src/ios/codesign.js";
import { cdhashes, SYSTEM_GL_LIBRARY } from "../../src/ios/guest_load.js";
import { plist_encode, plist_parse } from "../../src/ios/plist.js";
import { zip_read } from "../../src/android/zip.js";
import { make_zip } from "../android/fixtures.mjs";

function image()
{
    const b = new Uint8Array(0x900), v = new DataView(b.buffer), put = (a, n) => v.setUint32(a, n, true);
    put(0, 0xFEEDFACE); put(4, 12); put(8, 9); put(12, 2); put(16, 2); put(20, 180);
    put(28, 1); put(32, 124); b.set(new TextEncoder().encode("__TEXT"), 36);
    put(52, 0x1000); put(56, 0x1000); put(64, 0x800); put(76, 1);
    b.set(new TextEncoder().encode("__text"), 84); put(116, 0x1400); put(120, 0x100); put(124, 0x400);
    put(152, 1); put(156, 56); b.set(new TextEncoder().encode("__LINKEDIT"), 160);
    put(176, 0x2000); put(180, 0x1000); put(184, 0x800); put(188, 0x100);
    b.fill(0x42, 0x400, 0x500); return b;
}
test("ad-hoc signatures preserve entitlements, seal pages, and detect code mutation", () => {
    const entitlements = { "application-identifier": "org.v86.Test", "get-task-allow": true };
    const signed = sign_macho(image(), { identifier: "org.v86.Test", entitlements });
    const buffer = Buffer.from(signed), original = Buffer.from(buffer);
    sign_macho(buffer, { identifier: "org.v86.Replacement", entitlements });
    assert.deepEqual(buffer, original, "Node Buffer inputs must not be modified through Buffer.slice()");
    assert.deepEqual(macho_entitlements(signed), entitlements);
    assert.equal(cdhashes(signed).length, 1);
    const linked = macho_link_library(signed, SYSTEM_GL_LIBRARY);
    const final = sign_macho(linked, { identifier: "org.v86.Test", entitlements });
    assert.notDeepEqual(cdhashes(final), cdhashes(signed));
    const broken = final.slice(); broken[0x401] ^= 1;
    assert.throws(() => cdhashes(broken), /Invalid signed page/);
});
test("preparation produces an inspectable IPA, final hashes, graphics dependency and resource seal", async () => {
    const info = plist_encode({ CFBundleIdentifier: "org.v86.Test", CFBundleExecutable: "Test", CFBundleVersion: "1", MinimumOSVersion: "6.0" });
    const b = make_zip([{ name: "Payload/Test.app/Info.plist", data: info },
        { name: "Payload/Test.app/Test", data: image() },
        { name: "Payload/Test.app/texture.bin", data: Uint8Array.of(1, 2, 3) },
        { name: "Payload/Test.app/embedded.mobileprovision", data: Uint8Array.of(9) }]);
    const original = b.slice(), parts = [];
    const manifest = await prepare_ipa((a, n) => b.subarray(a, a + n), b.length, data => parts.push(data.slice()));
    const out = Buffer.concat(parts), read = (a, n) => out.subarray(a, a + n), app = await inspect_ipa(read, out.length);
    assert.deepEqual(b, original); assert.equal(manifest.prepared_size, out.length);
    assert.equal(manifest.prepared_sha256, createHash("sha256").update(out).digest("hex"));
    assert.ok(app.main.parsed.dylibs.includes(SYSTEM_GL_LIBRARY));
    const embedded=app.main.parsed.segments.flatMap(s=>s.sections).find(s=>s.name==="__info_plist");
    assert.ok(embedded,"the binary-path native validator must see the signed Info component");
    assert.deepEqual(app.main.bytes.subarray(embedded.offset,embedded.offset+embedded.size),info);
    assert.equal(manifest.trusted[0].cdhashes[0], Buffer.from(cdhashes(app.main.bytes)[0]).toString("hex"));
    assert.ok(!app.entries.some(e => e.name.endsWith("embedded.mobileprovision")));
    const seal = plist_parse(await zip_read(read, app.entries.find(e => e.name.endsWith("_CodeSignature/CodeResources"))));
    assert.deepEqual(Buffer.from(seal.files["texture.bin"]), createHash("sha1").update(Uint8Array.of(1, 2, 3)).digest());
    assert.equal(app.entries.find(e => e.name.endsWith("/Test")).unix_mode, 0o100755);
});
test("preparation reports unsupported header layout instead of modifying it", () => {
    const b = image(), v = new DataView(b.buffer); v.setUint32(124, 212, true);
    assert.throws(() => macho_link_library(b, SYSTEM_GL_LIBRARY), /header padding/);
    const original=image(),copy=original.slice();
    assert.throws(()=>macho_embed_info(original,new Uint8Array(5000)),/padding.*Info.plist/);
    assert.deepEqual(original,copy);
});
