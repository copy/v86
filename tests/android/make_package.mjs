#!/usr/bin/env node
// A small Cuttlefish-like images zip (tests/android/fixtures.mjs) for the
// wizard's browser test (tests/app/wizard_test.html part=android):
// build/android-test-package.zip
//
//   node tests/android/make_package.mjs [out.zip]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { make_cuttlefish_package } from "./fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") + "/";
const out = process.argv[2] ? path.resolve(process.argv[2]) : ROOT + "build/android-test-package.zip";
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, make_cuttlefish_package().zip);
console.log(out + ": " + fs.statSync(out).size + " bytes");
