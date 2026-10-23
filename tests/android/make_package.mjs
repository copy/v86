#!/usr/bin/env node
// A small Cuttlefish-like images zip (tests/android/fixtures.mjs) for the
// wizard's browser test (tests/app/wizard_test.html part=android and
// android_gsi): build/android-test-package.zip, and GSIs of the vendor's
// version and older, build/android-test-gsi.zip and android-test-gsi-old.zip
//
//   node tests/android/make_package.mjs [out directory]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { make_cuttlefish_package, make_gsi_package } from "./fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") + "/";
const dir = (process.argv[2] ? path.resolve(process.argv[2]) : ROOT + "build") + "/";
fs.mkdirSync(dir, { recursive: true });
for(const [name, zip] of [["android-test-package.zip", make_cuttlefish_package().zip], ["android-test-gsi.zip", make_gsi_package("36.1").zip],
    ["android-test-gsi-old.zip", make_gsi_package("36.0").zip]])
{
    fs.writeFileSync(dir + name, zip);
    console.log(dir + name + ": " + zip.length + " bytes");
}
