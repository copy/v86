// A CTS subset on a booted Android 16 (docs/arm64-virt-android16-plan.md
// P12.3), over adb, the same on the QEMU reference and on v86
// (tests/a64/android_boot.mjs A64_ANDROID_SCENARIO=cts): native gtest
// modules of CTS 16.1_r1 (tools/a64_cts.mjs fetches them), their arm64 files
// pushed where the module's configuration has Tradefed's FilePusher put
// them, the binary run as its GTest runner runs it, without Tradefed (the
// test host here is macOS and the guest's adb is this harness's). A module
// passes when gtest reports no failed test; a filter, when it has one, is
// part of the subset (see CTS_SUBSET).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fetch_module, CTS, CTS_DIR } from "../../tools/a64_cts.mjs";

/**
 * The subset, frozen with P10.3's budget (A10). Native gtest modules that
 * exercise what v86 emulates: the CPU and MMU through bionic (libc, the
 * dynamic linker, threads, signals, memory mappings, floating point), the
 * kernel's ABI and configuration, file-based encryption's ciphers, ASLR.
 * device: the configuration's native-test-device-path (with the module's
 * own directory when FilePusher pushes one); binary: under it.
 */
export const CTS_SUBSET = [
    { module: "CtsKernelConfigTestCases", device: "/data/local/tmp", binary: "CtsKernelConfigTestCases64" },
    { module: "CtsNativeEncryptionTestCases", device: "/data/local/tmp", binary: "CtsNativeEncryptionTestCases64" },
    { module: "CtsAslrMallocTestCases", device: "/data/local/tmp", binary: "CtsAslrMallocTestCases64" },
    { module: "CtsFsMgrTestCases", device: "/data/local/tmp", binary: "CtsFsMgrTestCases64" },
    { module: "CtsBionicTestCases", device: "/data/local/tests/unrestricted/CtsBionicTestCases", binary: "CtsBionicTestCases" },
];

/** a ustar archive of [name, data, mode] (directories implied) */
export function ustar(files)
{
    const blocks = [];
    for(const [name, data, mode = 0o644] of files)
    {
        const header = Buffer.alloc(512);
        let prefix = "", base = name;
        if(Buffer.byteLength(name) > 100)
        {
            const cut = name.lastIndexOf("/", 155);
            prefix = name.slice(0, cut);
            base = name.slice(cut + 1);
            assert.ok(cut > 0 && Buffer.byteLength(base) <= 100, "ustar: " + name);
        }
        header.write(base, 0, "utf8");
        header.write(mode.toString(8).padStart(7, "0"), 100, "latin1");
        header.write("0000000", 108, "latin1");
        header.write("0000000", 116, "latin1");
        header.write(data.length.toString(8).padStart(11, "0"), 124, "latin1");
        header.write("00000000000", 136, "latin1");
        header.write("        ", 148, "latin1");
        header.write("0", 156, "latin1");
        header.write("ustar\0" + "00", 257, "latin1");
        header.write(prefix, 345, "utf8");
        header.write(header.reduce((sum, b) => sum + b, 0).toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
        blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
}

/** gtest's summary in a run's output: passed, failed (names), skipped, the count it ran */
export function gtest_summary(output)
{
    const count = (label) => +(new RegExp(`^\\[ +${label} +\\] (\\d+) tests?`, "m").exec(output)?.[1] ?? 0);
    const ran = /^\[==========\] (\d+) tests? from \d+ test (?:suites?|cases?) ran/m.exec(output);
    const failed = [...output.matchAll(/^\[ +FAILED +\] ([\w/.]+)(?:, where|\s*$| \()/gm)].map(m => m[1]).filter(n => n.includes("."));
    return { ran: ran ? +ran[1] : null, passed: count("PASSED"), skipped: count("SKIPPED"), failed: [...new Set(failed)] };
}

/**
 * The subset on the device.
 * @param {!Object} env as android_scenario.mjs's (adb, push, log)
 * @param {{modules: (Array<string>|undefined), filter: (Object<string, string>|undefined), timeout_ms: (number|undefined)}=} options
 *     modules: some of CTS_SUBSET's only; filter: a gtest filter by module, to time a module's suites
 * @return {!Promise<!Object>} by module: gtest's summary, ms, the run's exit status
 */
export async function cts_scenario(env, options = {})
{
    const { adb, log } = env;
    const result = { cts: CTS.version, modules: {} };
    for(const m of CTS_SUBSET)
    {
        if(options.modules && !options.modules.includes(m.module)) continue;
        const dir = await fetch_module(m.module, false);
        const files = [];
        const walk = (at, relative) =>
        {
            for(const name of fs.readdirSync(at).sort())
            {
                const file = path.join(at, name);
                if(fs.statSync(file).isDirectory()) walk(file, relative + name + "/");
                else files.push([relative + name, fs.readFileSync(file), fs.statSync(file).mode & 0o777 | (name === m.binary && !relative ? 0o755 : 0)]);
            }
        };
        walk(dir + "arm64", "");
        assert.ok(files.some(([name]) => name === m.binary), `${m.module}: no arm64/${m.binary}`);
        const tar = `/data/local/tmp/${m.module}.tar`;
        await env.push(tar, ustar(files));
        await adb(`mkdir -p ${m.device} && tar -xf ${tar} -C ${m.device} && rm ${tar}`, 600000);
        const filter = options.filter?.[m.module] || m.filter;
        const log_file = `/data/local/tmp/${m.module}.log`;
        const started = Date.now();
        const status = (await adb(`cd ${m.device} && ./${m.binary}${filter ? ` --gtest_filter='${filter}'` : ""} > ${log_file} 2>&1; echo EXIT=$?`,
            options.timeout_ms || 14400000)).trim();
        const ms = Date.now() - started;
        const output = await adb(`grep -E '^\\[(==========| +(PASSED|FAILED|SKIPPED) +)\\]' ${log_file}`, 600000);
        const summary = gtest_summary(output);
        result.modules[m.module] = { ...summary, ms, exit: +(/EXIT=(\d+)/.exec(status)?.[1] ?? -1), ...(filter ? { filter } : {}) };
        log(`${m.module}: ${JSON.stringify(result.modules[m.module]).slice(0, 1500)}`);
    }
    result.passed = Object.values(result.modules).every(r => r.ran && !r.failed.length && r.exit === 0);
    return result;
}
