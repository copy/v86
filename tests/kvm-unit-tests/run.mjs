#!/usr/bin/env node

// Run one kvm-unit-tests binary (a multiboot .flat file) in v86 and classify
// the result.
//
// usage: run.mjs [options] TEST.flat
//   --acpi            enable ACPI (in v86 this also enables the local APIC and IOAPIC)
//   --cores N         cores of the processor (N > 1 implies --acpi)
//   --memory MIB      guest memory (default 64)
//   --timeout SEC     give up after SEC seconds (default 60)
//   --expect-pass N   require at least N "PASS:" reports: a test that exits 0
//                     without reaching its checks does not count as passed
//   --cpu-features L  CPU features of docs/simd-xsave-plan.md, comma-separated
//   --cpu-type T      x86 (default) or x86_64, for the x86_64 builds
//   --quiet           don't echo the serial output
// Environment: TEST_RELEASE_BUILD=1 uses build/libv86.mjs, DISABLE_JIT=1 the interpreter,
// JIT_SWITCHES the JIT switches (tests/lib/jit_switches.mjs).
//
// Exit status: 0 passed, 1 failed, 2 crashed (the emulator threw), 3 timed out,
// 4 test file missing. The last line is machine readable:
//   RESULT <passed|failed|crashed|timeout|missing> <test> code=<exit code> passes=<n> failures=<n> skips=<n>

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const options = { acpi: false, cores: 1, memory: 64, timeout: 60, expect_pass: 0, quiet: false, cpu_features: undefined, cpu_type: undefined };
let test_file;
for(let i = 2; i < process.argv.length; i++)
{
    const arg = process.argv[i];
    if(arg === "--acpi") options.acpi = true;
    else if(arg === "--quiet") options.quiet = true;
    else if(arg === "--memory") options.memory = +process.argv[++i];
    else if(arg === "--cores") { options.cores = +process.argv[++i]; options.acpi ||= options.cores > 1; }
    else if(arg === "--timeout") options.timeout = +process.argv[++i];
    else if(arg === "--expect-pass") options.expect_pass = +process.argv[++i];
    else if(arg === "--cpu-features") options.cpu_features = process.argv[++i].split(",");
    else if(arg === "--cpu-type") options.cpu_type = process.argv[++i];
    else if(arg.startsWith("--")) { console.error("unknown option " + arg); process.exit(4); }
    else test_file = arg;
}

const STATUS = { passed: 0, failed: 1, crashed: 2, timeout: 3, missing: 4 };
const name = test_file ? path.basename(test_file) : "(none)";
let serial = "";

function finish(status, code, detail)
{
    const count = prefix => (serial.match(new RegExp("^" + prefix + ":", "gm")) || []).length;
    const passes = count("PASS");
    const failures = count("FAIL");
    const skips = count("SKIP");

    if(status === "passed" && (failures > 0 || passes < options.expect_pass))
    {
        detail = failures > 0 ? failures + " FAIL report(s) despite exit code 0" :
            "only " + passes + " PASS report(s), expected at least " + options.expect_pass;
        status = "failed";
    }
    if(detail) console.log("\n" + detail);
    console.log(`\nRESULT ${status} ${name} code=${code} passes=${passes} failures=${failures} skips=${skips}`);
    process.exit(STATUS[status]);
}

if(!test_file || !fs.existsSync(test_file))
{
    finish("missing", -1, "test file not found: " + test_file);
}

process.on("uncaughtException", e => finish("crashed", -1, "emulator exception: " + (e && e.stack || e)));
process.on("unhandledRejection", e => finish("crashed", -1, "emulator exception: " + (e && e.stack || e)));

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { with_jit_switches } = await import("../lib/jit_switches.mjs");
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const emulator = new V86(with_jit_switches({
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    multiboot: { url: test_file },
    autostart: true,
    memory_size: options.memory * 1024 * 1024,
    acpi: options.acpi,
    cpu_cores: options.cores,
    cpu_features: options.cpu_features,
    cpu_features_unreleased: true,
    cpu_type: options.cpu_type,
    disable_jit: +process.env.DISABLE_JIT,
    log_level: 0,
}));

setTimeout(async () => {
    const diagnostics = await emulator.get_diagnostics();
    finish("timeout", -1, "no exit after " + options.timeout + " s\n" + JSON.stringify(diagnostics, null, 1));
}, options.timeout * 1000);

emulator.bus.register("emulator-started", function()
{
    // kvm-unit-tests' exit(): the status goes to the isa-debug-exit port
    const exit = value => finish(value === 0 ? "passed" : "failed", value);
    emulator.v86.cpu.io.register_write(0xF4, {}, exit, exit, exit);
});

emulator.add_listener("serial0-output-byte", function(byte)
{
    const chr = String.fromCharCode(byte);
    serial += chr;
    if(!options.quiet) process.stdout.write(chr);
});
