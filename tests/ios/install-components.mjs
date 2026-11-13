import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { link_install_policy,INSTALL_POLICY } from "../../src/ios/install_components.js";
import { cdhashes } from "../../src/ios/guest_load.js";
import { macho_parse } from "../../src/apple/macho.js";

test("native adapter rejects an unknown installation daemon",()=>{
    assert.throws(()=>link_install_policy(new Uint8Array(1024)),/stock N90/);
});
test("10B329 ad-hoc metadata keeps native checks and permits an absent certificate",{skip:!process.env.IPHONE4_INSTALLD&&"set IPHONE4_INSTALLD to the owner's stock installd"},()=>{
    const original=fs.readFileSync(process.env.IPHONE4_INSTALLD),copy=Buffer.from(original),patched=link_install_policy(original);
    assert.deepEqual(original,copy);
    assert.deepEqual(patched.subarray(0x1057c,0x10582),Uint8Array.of(0,0x29,0x5c,0xd0,0x14,0xe0));
    assert.ok(macho_parse(patched).dylibs.includes(INSTALL_POLICY));
    assert.ok(cdhashes(patched).length);
    const changed=Buffer.from(original);changed[0x1057c]^=1;
    assert.throws(()=>link_install_policy(changed),/stock N90/);
});
