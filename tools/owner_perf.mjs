#!/usr/bin/env node
// The owner's workloads, one core against another (docs/jit-unification-plan.md:
// the risk "Windows images and Win98 states are only on the owner's machine",
// P0.12, P0.15): sessions alternate the arms (A B B A ...), and the report has
// the revision, the host, the JIT switches and each workload's samples and
// medians per arm.
//
//   node tools/owner_perf.mjs [--arms a.wasm[,b.wasm]] [--workloads list]
//        [--sessions 3] [--seconds 60] [--site ../retro-gaming-site]
//        [--out build/owner-perf/<time>.json] [--keep-states]
//
// An arm is a core, run with this tree's scripts and build/libv86.mjs, or a
// tree (a directory: a worktree at another revision, built), run with its own
// scripts, libv86.mjs and build/v86.wasm: a core and the JavaScript of another
// revision do not always agree (M9's 0.02x, and M11 removed the region exports
// the JavaScript before it configures).
//
// Workloads (default: xp,win98-diablo1,win98-ra2,win98-themehospital,win98-boot):
//   xp             Windows XP to the desktop, the owner's configuration (i440FX
//                  and IDE, PIC, no PAE), synchronous disk
//                  (tests/ir/performance/xp_boot.mjs): seconds
//   win81          Windows 8.1 x64, first boot to the desktop, one core
//                  (tests/x64/windows_boot.mjs, release build): seconds
//   cpuload32      Windows 8.1, then CPULOAD32 under WOW64 (P0.12,
//                  tests/x64/windows_cpuload32.c): the fastest warm round, ms
//   win98-<game>   the site's Windows 98 state of <game>
//                  (tests/ir/performance/game_state.mjs --win98 --modes): MIPS
//                  over the second half, CPU mode shares
//   win98-boot     Windows 98 cold boot (windows98/windows98hdd.img): seconds
//                  to the desktop's display mode, mode shares
// JIT_SWITCHES applies to every arm. States are decompressed with zstd into
// build/owner-perf/ and deleted at the end unless --keep-states.
import { spawnSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { site_directory } from "../tests/lib/site.mjs";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf("--" + name); return i < 0 ? fallback : args[i + 1]; };
const arms = (option("arms", "build/v86.wasm")).split(",").map(w => path.resolve(ROOT, w)).map(w =>
    fs.statSync(w).isDirectory() ? { root: w, wasm: path.join(w, "build/v86.wasm") } : { root: ROOT, wasm: w });
const workloads = option("workloads", "xp,win98-diablo1,win98-ra2,win98-themehospital,win98-boot").split(",");
const sessions = Number(option("sessions", 3));
const seconds = Number(option("seconds", 60));
// (the default: retro-gaming-site next to the main checkout, also from a worktree)
const site = option("site") ? path.resolve(ROOT, option("site")) : site_directory(ROOT);
// (the Windows workloads get the image explicitly: a tree arm's own
// windows_boot.mjs may look for it relative to that tree)
const win_image = process.env.WIN_IMAGE || path.join(site, "windows8/windows8.img");
const work = path.join(ROOT, "build/owner-perf");
const out = option("out", path.join(work, new Date().toISOString().replace(/[:.]/g, "-") + ".json"));
fs.mkdirSync(work, { recursive: true });

const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
const lines = (text, prefix) => text.split("\n").filter(l => l.startsWith(prefix)).map(l => l.slice(prefix.length));
const json_lines = text => text.split("\n").filter(l => l.startsWith("{")).map(l => { try { return JSON.parse(l); } catch{ return null; } }).filter(Boolean);

/** node `script` of tree `root` with `argv` and environment `env`: the output */
function node(root, script, argv, env, timeout = 3600000)
{
    const r = spawnSync(process.execPath, [script, ...argv], { cwd: root, env: { ...process.env, ...env }, encoding: "utf8", timeout, maxBuffer: 1 << 30 });
    return { status: r.status, output: (r.stdout || "") + (r.stderr || "") };
}
/** The decompressed state of a Windows 98 game */
function win98_state(game)
{
    const file = path.join(work, `win98-${game}.bin`);
    if(!fs.existsSync(file))
    {
        const source = path.join(site, `windows98/states/windows98_audio_vga_2d_multidisk_${game}.bin.zst`);
        execSync(`zstd -q -d -f ${JSON.stringify(source)} -o ${JSON.stringify(file)}`);
    }
    return file;
}
const WIN98_HDA = () => path.join(site, "windows98/windows98multidisk/windows98hdd_C_512MB.img");

const WORKLOADS = {
    xp: ({ root, wasm }) => {
        const r = node(root, "tests/ir/performance/xp_boot.mjs", [path.join(site, "windowsxp/windowsxp_multidisk_C_4G.img"), wasm],
            { IR_SYNC_DISK: "1", IR_BOOT_TARGET: "desktop", IR_BOOT_MS: "900000" });
        const result = json_lines(r.output).find(l => l.event === "result");
        return result?.milestone ? { value: result.milestone.ms / 1000, unit: "s", mips: result.milestone.instructions / result.milestone.ms / 1000 } : { error: "no desktop" };
    },
    win81: ({ root, wasm }) => {
        const r = node(root, "tests/x64/windows_boot.mjs", [], { TEST_RELEASE_BUILD: "1", WASM_PATH: wasm, WIN_IMAGE: win_image, WIN_STOP_AT_DESKTOP: "1", WIN_TIMEOUT_MS: "1800000",
            WIN_OUT: path.join(work, "win81") });
        const desktop = lines(r.output, "X64_WIN_EVENT ").map(l => JSON.parse(l)).find(e => e.kind === "desktop");
        return desktop ? { value: desktop.s, unit: "s" } : { error: "no desktop" };
    },
    cpuload32: ({ root, wasm }) => {
        const r = node(root, "tests/x64/windows_boot.mjs", [], { TEST_RELEASE_BUILD: "1", WASM_PATH: wasm, WIN_IMAGE: win_image, WIN_CPULOAD32: "5", WIN_TIMEOUT_MS: "2400000",
            WIN_OUT: path.join(work, "cpuload32") });
        const load = lines(r.output, "X64_WIN_CPULOAD32 ").map(l => JSON.parse(l))[0];
        // (the fastest warm round: the desktop's background work slows others)
        return load ? { value: load.min_ms, unit: "ms", median_ms: load.median_ms, rounds: load.rounds } : { error: "CPULOAD32 did not finish" };
    },
    // (windows98/windows98hdd.img: the games' 512 MB system disk restarts
    // into MS-DOS mode and waits for a key)
    "win98-boot": ({ root, wasm }) => {
        const r = node(root, "tests/ir/performance/game_state.mjs", ["--win98", "--modes", "--hda", path.join(site, "windows98/windows98hdd.img"), "--wasm", wasm,
            "--seconds", String(seconds)], {});
        const summary = json_lines(r.output).find(l => l.event === "summary");
        return summary?.desktop_s ? { value: summary.desktop_s, unit: "s", modes: summary.modes } : { error: "no desktop", modes: summary?.modes };
    },
};
const win98_game = game => ({ root, wasm }) => {
    const r = node(root, "tests/ir/performance/game_state.mjs", ["--win98", "--modes", "--state", win98_state(game), "--hda", WIN98_HDA(),
        "--hdb", path.join(site, `game/${game}.img`), "--wasm", wasm, "--seconds", String(seconds)], {});
    const summary = json_lines(r.output).find(l => l.event === "summary");
    return summary ? { value: summary.second_half.mips, unit: "MIPS", higher_is_better: true, modes: summary.modes_second_half } : { error: r.output.slice(-400) };
};

const report = { version: 1, date: new Date().toISOString(), host: { platform: process.platform, cpus: os.cpus().length, model: os.cpus()[0]?.model, load: os.loadavg(), node: process.version },
    revision: (() => { try { return execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim(); } catch{ return null; } })(),
    switches: process.env.JIT_SWITCHES || "", arms: arms.map(a => a.root === ROOT ? a.wasm : a.root), sessions, seconds, workloads: {} };
for(const name of workloads)
{
    const run = WORKLOADS[name] || (name.startsWith("win98-") ? win98_game(name.slice(6)) : null);
    if(!run) throw new Error(`unknown workload ${name}`);
    const samples = arms.map(() => []);
    for(let s = 0; s < sessions; s++)
    {
        const order = s % 2 ? [...arms.keys()].reverse() : [...arms.keys()];
        for(const a of order)
        {
            const result = run(arms[a]);
            samples[a].push(result);
            console.log(`[owner-perf] ${name} session ${s + 1} arm ${a}: ${JSON.stringify({ value: result.value, unit: result.unit, error: result.error })}`);
        }
    }
    const medians = samples.map(list => median(list.filter(r => r.value !== undefined).map(r => r.value)));
    const unit = samples.flat().find(r => r.unit)?.unit, higher = samples.flat().some(r => r.higher_is_better);
    report.workloads[name] = { unit, higher_is_better: higher, medians, samples,
        ...arms.length === 2 && medians.every(m => m) ? { ratio: higher ? medians[1] / medians[0] : medians[0] / medians[1] } : {} };
    console.log(`[owner-perf] ${name}: ${medians.map((m, a) => `arm ${a} ${m ?? "-"} ${unit ?? ""}`).join(", ")}` +
        (report.workloads[name].ratio ? `, arm 1 relative to arm 0: ${report.workloads[name].ratio.toFixed(3)}` : ""));
}
fs.writeFileSync(out, JSON.stringify(report, null, 1));
if(!args.includes("--keep-states")) for(const f of fs.readdirSync(work).filter(f => f.startsWith("win98-") && f.endsWith(".bin"))) fs.unlinkSync(path.join(work, f));
console.log(`[owner-perf] report: ${path.relative(ROOT, out)}`);
