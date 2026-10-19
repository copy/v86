// dEQP on a booted Android 16 (docs/arm64-virt-android16-plan.md appendix
// F6), over adb, the same on the QEMU reference (SwiftShader) and on v86
// (Venus through WebGPU, ANGLE above it for GL ES): CTS 16.1_r1's
// CtsDeqpTestCases (tools/a64_cts.mjs fetches it), its APK installed and run
// as Tradefed's DeqpTestRunner runs it, the instrumentation with a case list
// and a command line per package, without Tradefed; the log (.qpa) read back
// and each case's status counted. The subset (DEQP_SUBSET): dEQP-VK's API
// smoke tests, dEQP-EGL's info, and GLES 2's prerequisites, implementation
// limits, info, clears, buffer writes and constant expressions;
// A64_ANDROID_DEQP=<package>=<prefix>,...;... replaces it.
import assert from "node:assert/strict";
import fs from "node:fs";
import { fetch_module } from "../../tools/a64_cts.mjs";
import { prepare_device } from "./android_scenario.mjs";

const MODULE = "CtsDeqpTestCases";
const APK = "com.drawelements.deqp";
const INSTRUMENTATION = APK + "/com.drawelements.deqp.testercore.DeqpInstrumentation";

/** package -> [case list file of the module, the case prefixes] */
export const DEQP_SUBSET = {
    "dEQP-VK": ["vk-main-2019-03-01.txt", ["dEQP-VK.api.smoke."]],
    "dEQP-EGL": ["egl-main-2020-03-01.txt", ["dEQP-EGL.info."]],
    "dEQP-GLES2": ["gles2-main-2020-03-01.txt", ["dEQP-GLES2.info.", "dEQP-GLES2.functional.prerequisite.",
        "dEQP-GLES2.functional.implementation_limits.", "dEQP-GLES2.functional.color_clear.single_rgb",
        "dEQP-GLES2.functional.color_clear.single_rgba", "dEQP-GLES2.functional.depth_stencil_clear.depth",
        "dEQP-GLES2.functional.buffer.write.basic.", "dEQP-GLES2.functional.shaders.constant_expressions.trivial."]],
};

/** Cases in dEQP's trie format ({a{b,c{d}}}: a.b and a.c.d) */
export function case_trie(cases)
{
    const root = new Map();
    for(const c of cases)
    {
        let node = root;
        for(const part of c.split(".")) node = node.get(part) || node.set(part, new Map()).get(part);
    }
    const write = node => [...node].map(([name, children]) => children.size ? name + "{" + write(children) + "}" : name).join(",");
    return "{" + write(root) + "}";
}

/**
 * A package's command line (DeqpTestRunner's: GL ones with the module's GL
 * configuration and a window); the cases inline (the app reads no file the
 * shell writes: scoped storage)
 */
function command_line(name, cases)
{
    const gl = name === "dEQP-VK" ? "" : " --deqp-gl-config-name=rgba8888d24s8ms0 --deqp-surface-type=window --deqp-screen-rotation=unspecified";
    return `--deqp-caselist=${case_trie(cases)}${gl} --deqp-watchdog=enable`;
}

/** The cases of a .qpa log: name -> status code (Pass, Fail, NotSupported, QualityWarning, ...; Crash when it did not end) */
export function qpa_results(text)
{
    const results = {};
    for(const block of text.split("#beginTestCaseResult ").slice(1))
    {
        const name = block.slice(0, block.indexOf("\n")).trim();
        const status = /<Result StatusCode="([^"]+)"/.exec(block)?.[1];
        results[name] = block.includes("#terminateTestCaseResult") ? "Crash" : status || "Crash";
    }
    return results;
}

/**
 * @param {!Object} env as the other scenarios' (adb, push, log)
 * @return {!Promise<!Object>} per package the cases, their statuses and counts
 */
export async function deqp_scenario(env)
{
    const { adb, log } = env;
    const dir = await fetch_module(MODULE, false);
    // (the test activity must come to the front: user 0 unlocked, awake, no keyguard)
    await prepare_device(adb);
    for(let deadline = Date.now() + 3600000; !/RUNNING_UNLOCKED/.test(await adb("am get-started-user-state 0 2>&1")); )
    {
        assert.ok(Date.now() < deadline, "user 0 unlocked");
        await new Promise(resolve => setTimeout(resolve, 15000));
    }
    await adb("settings put system screen_off_timeout 2147483647; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard");
    const subset = process.env.A64_ANDROID_DEQP ? Object.fromEntries(process.env.A64_ANDROID_DEQP.split(";").map(p => {
        const [name, prefixes] = p.split("=");
        return [name, [DEQP_SUBSET[name][0], prefixes.split(",")]];
    })) : DEQP_SUBSET;
    await env.push("/data/local/tmp/deqp.apk", fs.readFileSync(dir + "com.drawelements.deqp.apk"));
    assert.match(await adb("pm install -r -g /data/local/tmp/deqp.apk 2>&1", 1800000), /^Success/m, "pm install the dEQP APK");
    const result = { module: MODULE, packages: {} };
    for(const [name, [list, prefixes]] of Object.entries(subset))
    {
        // (a list is cases, or the lists it is made of: vk-main-2019-03-01.txt names vk-main-2019-03-01/*.txt)
        const lines = file => fs.readFileSync(dir + file, "utf8").split("\n").map(c => c.trim()).filter(Boolean)
            .flatMap(c => c.endsWith(".txt") ? lines(c) : [c]);
        const cases = lines(list).filter(c => prefixes.some(p => c.startsWith(p)));
        assert.ok(cases.length, `${name}: no case of ${prefixes} in ${list}`);
        // (the log in the app's own external directory: scoped storage gives it nothing else of /sdcard, and the shell reads it)
        const files = `/sdcard/Android/data/${APK}/files`, qpa = `${files}/${name}.qpa`;
        await adb(`mkdir -p ${files}; rm -f ${qpa}`);
        const started = Date.now();
        // (DeqpTestRunner's: deqpLogFilename, the log's path)
        const out = await adb(`am instrument -w -r -e deqpLogFilename ${qpa} -e deqpCmdLine "${command_line(name, cases)}" ` +
            `-e deqpLogData false ${INSTRUMENTATION} 2>&1 | tail -5`, 4 * 3600000);
        const ms = Date.now() - started;
        const results = qpa_results(await adb(`cat ${qpa}`, 600000));
        const logcat = (await adb("logcat -d -s dEQP:* DeqpInstrumentation:* AndroidRuntime:E 2>&1 | tail -25", 600000)).trim();
        await adb("logcat -c");
        const counts = {};
        for(const status of Object.values(results)) counts[status] = (counts[status] || 0) + 1;
        const missing = cases.filter(c => !(c in results));
        const failed = Object.entries(results).filter(([, s]) => !["Pass", "NotSupported", "QualityWarning", "CompatibilityWarning"].includes(s));
        result.packages[name] = { cases: cases.length, ran: Object.keys(results).length, counts, ms,
            failed: failed.slice(0, 50).map(([c, s]) => c + ": " + s), missing: missing.slice(0, 20), instrumentation: out.trim().slice(-300),
            ...(Object.keys(results).length ? {} : { logcat: logcat.slice(-3000) }) };
        if(env.directory) fs.writeFileSync(env.directory + `deqp-${name}.json`, JSON.stringify(results, null, 1));
        log(`${name}: ${JSON.stringify(result.packages[name]).slice(0, 2000)}`);
    }
    await adb(`pm uninstall ${APK} >/dev/null 2>&1`);
    result.passed = Object.values(result.packages).every(p => p.ran === p.cases && !p.failed.length);
    return result;
}
