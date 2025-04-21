#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import assert from "node:assert/strict";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

process.on("unhandledRejection", exn => { throw exn; });

const DUMMY_MODULE_PATH = path.resolve(__dirname, "../../build/dummy_output.wasm");
const dummy_module = fs.readFileSync(DUMMY_MODULE_PATH);

const wm = new WebAssembly.Module(dummy_module);
const mem = new WebAssembly.Memory({ initial: 256 });

// These tests have to be kept in sync with src/rust/wasmgen/module_init.rs' tests
// XXX: make the test more complex, involving locals, conditionals and stuff

let baz_recd_arg;
function baz(arg) {
    baz_recd_arg = arg;
    return 456;
}

let foo_recd_arg;
function foo(arg) {
    foo_recd_arg = arg;
}

const i = new WebAssembly.Instance(wm, { "e": { m: mem, baz, foo } });
i.exports.f();

assert(baz_recd_arg === 2, `baz returned: "${baz_recd_arg}"`);
assert(foo_recd_arg === 456, `foo returned: "${foo_recd_arg}"`);
