#!/usr/bin/env node
// Records of real compilations for tools/replay_check.mjs
// (docs/jit-unification-plan.md P2.0): runs benchmark images
// (tests/bench) on a test core (ir-test-hooks) with recording on, and saves
// what Tier-0 and the x64 page tier compiled: build/replay/bench-<isa>.t0r
// and .x6r, each record a u32 length and its bytes. The i686 images exercise
// Tier-0, the x86-64 ones the page tier (and Tier-0 for the boot's 32-bit
// part).
//
// Usage: node tools/replay_record.mjs [--wasm build/v86-ir-test-release.wasm]
//        [--isa i686,x86_64] [--filter re] [--out build/replay]
//        [--switches name=value,...]   (JIT switches for every machine: with
//            --isa compat32 and x64_page_compat32=1, or --isa i686 and
//            x64_page_legacy32=1, the page tier's 32-bit compilations)

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { load_pe, boot_images, create, execute } from "../tests/bench/machine.mjs";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf("--" + name); return i < 0 ? fallback : args[i + 1]; };
const wasm = option("wasm", "build/v86-ir-test-release.wasm");
const isas = option("isa", "i686,x86_64").split(",");
const switches = Object.fromEntries(option("switches", "").split(",").filter(Boolean).map(kv => { const [k, v] = kv.split("="); return [k, +v]; }));
const filter = option("filter") ? new RegExp(option("filter")) : null;
const out = option("out", "build/replay");
const manifest = JSON.parse(fs.readFileSync("build/bench/manifest.json", "utf8"));
const boots = boot_images(manifest);
const ENGINES = [{ prefix: "ir_t0_", extension: ".t0r" }, { prefix: "x64_page_", extension: ".x6r" }];

fs.mkdirSync(out, { recursive: true });
for(const isa of isas)
{
    const chunks = Object.fromEntries(ENGINES.map(e => [e.extension, []]));
    let count = 0;
    for(const bench of manifest.benchmarks)
    {
        const file = isa === "x86_64" ? bench.image64 : bench.image;
        if(!file || filter && !filter.test(bench.name)) continue;
        const machine = await create({ label: "record", isa, wasm, switches }, bench, boots);
        try
        {
            const e = machine.e;
            if(!e["ir_t0_record_start"]) throw new Error(`${wasm} has no replay hooks (build/v86-ir-test-release.wasm, ir-test-hooks)`);
            for(const engine of ENGINES) e[engine.prefix + "record_start"]();
            // (warm runs compile what the cold one leaves interpreted)
            const iterations = Math.max(1, Math.round(bench.iterations / 4));
            for(let run = 0; run < 3; run++) await execute(machine, load_pe(file), iterations);
            for(const engine of ENGINES)
            {
                const p = engine.prefix;
                for(let i = 0, n = e[p + "record_count"](); i < n; i++)
                {
                    const bytes = new Uint8Array(e["memory"].buffer, e[p + "record_address"](i), e[p + "record_length"](i));
                    const length = Buffer.alloc(4);
                    length.writeUInt32LE(bytes.length);
                    chunks[engine.extension].push(length, Buffer.from(bytes));
                    count++;
                }
                e[p + "record_stop"]();
            }
        }
        finally
        {
            await machine.vm.destroy();
        }
        process.stdout.write(`${bench.name} `);
    }
    for(const engine of ENGINES)
    {
        if(!chunks[engine.extension].length) continue;
        const target = path.join(out, `bench-${isa}${engine.extension}`);
        fs.writeFileSync(target, Buffer.concat(chunks[engine.extension]));
        console.log(`\n${target}: ${chunks[engine.extension].length / 2} records`);
    }
    if(!count) console.log(`\n${isa}: nothing compiled`);
}
