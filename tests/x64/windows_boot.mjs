#!/usr/bin/env node
// Windows x64 qualification on a user-supplied disk (64-bit and WOW64 probes, topology).
// The image is opened read-only; every guest write stays in a RAM overlay.
// A FAT16 tools disk carries PROBE64.EXE (native) and PROBE32.EXE (WOW64,
// compatibility mode); after sign-in they run through Win+R and write their
// results next to themselves.
//
// Env: WIN_IMAGE, WIN_CORES (1), WIN_MEMORY_MB (2048), X64_JIT (1),
// X64_IR_TIER0, WIN_PARALLEL, WIN_USER_PASSWORD (the image's test account password),
// WIN_TIMEOUT_MS, WIN_OUT (output directory), WIN_STOP_AT_DESKTOP=1 (stop once
// the desktop shows after sign-in; for boot timing), WIN_CPU_PROFILE=<seconds>
// (host CPU profiles, one <out>/prof-<end>s.cpuprofile per window),
// WIN_OVERLAY_SAVE=<file> (after the desktop: a full shutdown, then the disk
// overlay, i.e. every sector the guest wrote, is saved), WIN_OVERLAY_LOAD=<file>
// (boot with such an overlay: the state after Windows installed the drivers
// for this machine; the image itself is never written), WIN_IDLE=1 (after the
// desktop: host and in-guest CPU load of the idle desktop, see host_window),
// WIN_CPULOAD32=<rounds> (after the desktop: the timed WOW64 workload
// tests/x64/windows_cpuload32.c as LOAD32.EXE, an X64_WIN_CPULOAD32 line with
// each round's time; docs/jit-unification-plan.md P0.12). While it runs, a line written to
// <out>/command.txt is executed: "key <scancodes hex>", "type <text>",
// "run <command line>", "enter", "space", "password", "shot", "rips",
// "trace on|off" (WIN_USER_TRACE=1 enables it from the start), "jitstats
// <phase>" (a JIT_STATS record, tools/bench/jit_stats.mjs, named <phase>;
// with JIT_STATS=1 the harness also writes one at the desktop and one at
// the end, phases "desktop" and "end"), "runadmin
// <cmd /c line>" (elevated through PowerShell, Alt+Y for UAC), "wait <s>",
// "launch <command line>" (run by the launcher with cmd /c, see WIN_LAUNCHER),
// "display <width> <height> [index]" (V86.set_display_size), "mouse <dx> <dy>",
// "pointer <x> <y> <screen width> <screen height>",
// "snapshot" (saved
// and restored in place),
// "svgalog on|off" (the SVGA3D commands other than DX and the frequent GB
// ones, with their first words, as "svga3d-command" events; "svgalog
// 1101,1267" logs only those command ids), "svgashaders"
// (the GB shaders' bytecode, as "svga3d-shader" events).
// WIN_GRAPHICS_ADAPTER: the display adapter (bochs_vga; virtio_gpu; vmware_svga, whose
// level WIN_SVGA_LEVEL pins; WIN_GPU_RENDERER=chrome gives it a 3D renderer, in
// a headless Chrome, and the device its highest level, dx11);
// WIN_CDROM=<iso>: a CD-ROM, e.g. with drivers to install; WIN_HDB=<image>: a
// second disk in place of the tools disk, read-only like the first.
// WIN_LAUNCHER=<guest path of LAUNCH.EXE>: started from the Run dialog once
// the desktop shows; then "launch" runs programs as the user without typing
// (WIN_LAUNCHER_ADMIN=1: elevated, through UAC once, so they are too).
// WIN_NO_PROBE=1: no qualification probe (its Run dialog takes the focus from
// full-screen programs), and no signing in again unless a password box shows.
// WIN_CPU_FEATURES=<features>: cpu_features (cpu_type x86_64), e.g. the
// x86-64-v3 set; the probes then check the YMM state (X64_WIN_AVX, see
// windows_probe.c); WIN_PROBE_SNAPSHOT=1: the machine saved and restored in
// place once each probe's AVX part has started.
// "savestate <file>": the machine saved to <file>.state, with what the guest
// wrote to its disks (<file>.hda.ovl, <file>.hdb.ovl) and the harness's own
// (<file>.json); WIN_STATE_LOAD=<file> starts from there instead of booting
// (same WIN_* machine settings; the session is signed in, the launcher runs).
// WIN_RATES=<s>: every <s> seconds, the SVGA3D commands per second
// ("svga3d-rates": presents among them, for frame rates).
// WIN_MACHINE=q35: the Q35 machine (AHCI; a Windows installed on IDE may need
// its storahci driver enabled first, see docs/ahci.md), with WIN_HPET=1 the
// HPET, WIN_ROOT_PORTS=<n> PCI Express root ports, WIN_SMBUS=1 the SMBus.
// WIN_PCIE_DEVICE=<port>: a virtio device (Windows 8.1 has no driver for it)
// behind that root port, its hot plug slot empty at boot; "pcieattach <port>"
// plugs it in, "pciedetach <port> [surprise]" takes it out (by the attention
// button: "pcie-detached" once the guest switched the slot and its power
// indicator off), "pcieslot <port>" reports the slot's registers;
// WIN_PCIE_TRACE=1: every slot control write of the guest and every slot
// event, as "pcie-sltctl" and "pcie-event". WIN_PCIE_AHCI=<port>: instead, a
// second AHCI controller (Windows has its driver) with a 16 MiB FAT16 disk,
// in that root port's slot from boot; WIN_AHCI_TRACE=1: its global and port
// control writes and its configuration writes, as "ahci-write", "ahci-config".
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createHash as create_hash} from "node:crypto";
import {deflateSync as deflate_sync} from "node:zlib";
import {spawnSync} from "node:child_process";
import {setTimeout as delay} from "node:timers/promises";
import {fileURLToPath} from "node:url";
import {MemoryDisk, ReadOnlyOverlayDisk, make_fat16, read_fat16} from "../smp/disk_fixture.mjs";
import {jit_switches_from_env} from "../lib/jit_switches.mjs";
import {jit_stats_enabled, print_jit_stats} from "../../tools/bench/jit_stats.mjs";
import {CPU_FEATURE_PRESETS} from "../../src/cpu_features.js";
// WIN_CPU_FEATURES: feature names, comma separated, or a preset ("x86-64-v3")
const win_cpu_features = process.env.WIN_CPU_FEATURES ?
    CPU_FEATURE_PRESETS[process.env.WIN_CPU_FEATURES] || process.env.WIN_CPU_FEATURES.split(",") : null;

const root = fileURLToPath(new URL("../../", import.meta.url));
const image_path = path.resolve(process.env.WIN_IMAGE || path.join(root, "../retro-gaming-site/windows8/windows8.img"));
const out = path.resolve(process.env.WIN_OUT || path.join(root, "build/x64-windows"));
fs.mkdirSync(out, {recursive: true});
const cores = +(process.env.WIN_CORES || 1), jit = process.env.X64_JIT !== "0";
const password = process.env.WIN_USER_PASSWORD || "admin1";
// (not `<< 20`: 2048 << 20 overflows int32; v86 caps RAM just below 2 GiB)
const memory_mb = +(process.env.WIN_MEMORY_MB || 2048);
const source_stat = fs.statSync(image_path);

function build(compiler, entry, output, source = "tests/x64/windows_probe.c")
{
    const result = spawnSync(compiler, ["-Os", "-nostdlib", "-fno-builtin", "-fno-stack-protector", "-mno-stack-arg-probe",
        `-Wl,--entry,${entry}`, "-Wl,--subsystem,console", "-o", output, path.join(root, source), "-lkernel32"], {encoding: "utf8"});
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(output);
}
const probe64 = build("x86_64-w64-mingw32-gcc", "entry", path.join(out, "PROBE64.EXE"));
const probe32 = build("i686-w64-mingw32-gcc", "_entry@0", path.join(out, "PROBE32.EXE"));
const cpuload = build("x86_64-w64-mingw32-gcc", "entry", path.join(out, "CPULOAD.EXE"), "tests/x64/windows_cpuload.c");
const cpuload32 = build("i686-w64-mingw32-gcc", "_entry@0", path.join(out, "LOAD32.EXE"), "tests/x64/windows_cpuload32.c");
const tools = new MemoryDisk(make_fat16({"PROBE64.EXE": probe64, "PROBE32.EXE": probe32, "CPULOAD.EXE": cpuload, "LOAD32.EXE": cpuload32}));
const source = new ReadOnlyOverlayDisk(image_path);
// WIN_HDB=<image>: that disk (e.g. retro-gaming-site/game/3dmark06.img) in
// place of the tools disk, never written either (its writes stay in memory)
const hdb_path = process.env.WIN_HDB && path.resolve(process.env.WIN_HDB);
const hdb_stat = hdb_path && fs.statSync(hdb_path);
const hdb = hdb_path ? new ReadOnlyOverlayDisk(hdb_path) : tools;
// Overlay file: "V86OVL1\0", image size (u64), sector count (u32), the
// sector numbers (u32 each), then their contents
function load_overlay(disk, filename)
{
    const file = fs.readFileSync(filename);
    assert.equal(file.toString("latin1", 0, 8), "V86OVL1\0", "overlay file");
    assert.equal(Number(file.readBigUInt64LE(8)), disk.byteLength, "overlay of this image");
    const count = file.readUInt32LE(16);
    const sectors = new Uint32Array(file.buffer.slice(file.byteOffset + 20, file.byteOffset + 20 + count * 4));
    const bytes = new Uint8Array(file.buffer, file.byteOffset + 20 + count * 4, count * 512);
    disk.set_state([1, disk.byteLength, sectors, bytes]);
}
const state_load = process.env.WIN_STATE_LOAD && path.resolve(process.env.WIN_STATE_LOAD);
if(state_load) load_overlay(source, state_load + ".hda.ovl");
else if(process.env.WIN_OVERLAY_LOAD) load_overlay(source, process.env.WIN_OVERLAY_LOAD);
if(state_load && hdb_path && fs.existsSync(state_load + ".hdb.ovl")) load_overlay(hdb, state_load + ".hdb.ovl");
function save_overlay(filename, disk = source)
{
    const [, size, sectors, bytes] = disk.get_state();
    const header = Buffer.alloc(20);
    header.write("V86OVL1\0", 0, "latin1");
    header.writeBigUInt64LE(BigInt(size), 8);
    header.writeUInt32LE(sectors.length, 16);
    fs.writeFileSync(filename, Buffer.concat([header, Buffer.from(sectors.buffer, sectors.byteOffset, sectors.byteLength), Buffer.from(bytes)]));
}

const {V86} = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
// WIN_PCIE_AHCI's disk: FAT16 like the tools disk, with a disk signature of
// its own (Windows takes a disk whose signature collides with another offline)
function hot_plug_disk()
{
    const bytes = make_fat16({"HOTPLUG.TXT": Buffer.from("v86 PCI Express hot plug\r\n")});
    new DataView(bytes.buffer).setUint32(440, 0x76386870, true);
    return bytes;
}
// WIN_GPU_RENDERER=chrome: vmware_svga's 3D drawn by a headless Chrome (the default level, dx11-full)
const remote_renderer = process.env.WIN_GPU_RENDERER === "chrome" ?
    await (await import("./gpu_remote_renderer.mjs")).create_remote_renderer() : null;
const vm = new V86({
    graphics_adapter: process.env.WIN_GRAPHICS_ADAPTER || "bochs_vga",
    // WIN_SVGA_LEVEL: pin what vmware_svga declares (2d, 2d-full, ...)
    ...(process.env.WIN_SVGA_LEVEL || remote_renderer ? {graphics_adapter_test: {level: process.env.WIN_SVGA_LEVEL || undefined,
        renderer: remote_renderer && remote_renderer.renderer}} : {}),
    wasm_path: process.env.WASM_PATH,
    ...(process.env.WIN_CDROM ? {cdrom: {url: path.resolve(process.env.WIN_CDROM)}} : {}),
    bios: {url: root + "bios/seabios.bin"}, vga_bios: {url: root + "bios/vgabios.bin"},
    hda: source, hdb, memory_size: memory_mb * 1048576, vram_size: 16 << 20,
    acpi: true, cpu_cores: cores, net_device: {type: "ne2k"}, autostart: false, log_level: 0,
    // WIN_QEMU_COMPATIBLE=1: devices where QEMU, which the image was installed with, had them
    qemu_compatible: !!+process.env.WIN_QEMU_COMPATIBLE,
    // JIT_SWITCHES (tests/lib/jit_switches.mjs)
    ...(Object.keys(jit_switches_from_env()).length ? {jit_switches: jit_switches_from_env()} : {}),
    ...(process.env.WIN_MACHINE ? {machine_type: process.env.WIN_MACHINE, hpet: !!+process.env.WIN_HPET,
        pcie_root_ports: +process.env.WIN_ROOT_PORTS || 0, smbus: !!+process.env.WIN_SMBUS} : {}),
    ...(process.env.WIN_PCIE_DEVICE ? {virtio_devices: [{"name": "hotplug", "device_id": 0x1044, "subsystem_device_id": 4,
        "queues": [{"size": 8}], "pcie_root_port": +process.env.WIN_PCIE_DEVICE, "pcie_plugged": false, "notify": () => {}}]} : {}),
    // (behind root port n is the bus that pci_ids number n + 1)
    ...(process.env.WIN_PCIE_AHCI ? {ahci_test_drives: [{buffer: new MemoryDisk(hot_plug_disk())}], ahci_test_pci_id: +process.env.WIN_PCIE_AHCI + 1 << 8} : {}),
    // WIN_QUANTUM: instructions per core slice when cores take turns
    ...(process.env.WIN_QUANTUM ? {cpu_quantum: +process.env.WIN_QUANTUM} : {}),
    // WIN_ASYNC_PUBLICATION=1: compile generated modules asynchronously, as
    // the browser does by default
    disable_jit: !jit, experimental_smp_jit: jit, ir_sync_publication: !+process.env.WIN_ASYNC_PUBLICATION,
    ...(process.env.X64_IR_TIER0 === "0" ? {ir_tier0: false} : {}),
    ...(win_cpu_features ? {cpu_type: "x86_64", cpu_features: win_cpu_features} : {}),
    // WIN_PARALLEL=1: the application processors run in vCPU workers
    // (WIN_PARALLEL_WASM: another build of it)
    ...(+process.env.WIN_PARALLEL ? {parallel: true, wasm_path: process.env.WIN_PARALLEL_WASM || root + "build/v86-parallel.wasm"} : {}),
});

// Rolling host profiles of this process (node:inspector), so that each boot
// phase can be read separately
let profiler = null;
if(+process.env.WIN_CPU_PROFILE)
{
    const inspector = await import("node:inspector/promises");
    profiler = new inspector.Session();
    profiler.connect();
    await profiler.post("Profiler.enable");
    await profiler.post("Profiler.setSamplingInterval", {interval: 2000});
    await profiler.post("Profiler.start");
}
async function profile_window()
{
    const {profile} = await profiler.post("Profiler.stop");
    fs.writeFileSync(path.join(out, `prof-${String(elapsed()).padStart(4, "0")}s.cpuprofile`), JSON.stringify(profile));
    await profiler.post("Profiler.start");
    // page functions are named x64_page_<linear page>: name the guest module
    // of each (<out>/modules.json, for offline profiles by guest module)
    // (compatibility-mode code too since M9; t0_<linear page> was IR
    // Tier-0's, before P7.5)
    if(!cpu) return;
    const self = new Map(), by_id = new Map(profile.nodes.map(node => [node.id, node]));
    let total = 0;
    profile.samples.forEach((id, i) => {
        const d = profile.timeDeltas[i] || 0, name = by_id.get(id).callFrame.functionName;
        total += d;
        const match = name.match(/^(?:x64_page_|t0_)([0-9a-f]+)$/);
        if(match) self.set(match[1], (self.get(match[1]) || 0) + d);
    });
    const limit = performance.now() + 2000;
    for(const [page] of [...self].sort((a, b) => b[1] - a[1]))
    {
        if(page_modules[page] === undefined && performance.now() < limit) page_modules[page] = guest_module(BigInt("0x" + page));
    }
    fs.writeFileSync(path.join(out, "modules.json"), JSON.stringify(page_modules, null, 1));
    // the generated code's time by guest module (% of the window)
    const modules = new Map();
    for(const [page, t] of self)
    {
        const m = page_modules[page], name = m ? m.replace(/\+0x[0-9a-f]+$/, "") : BigInt("0x" + page) >= 0xFFFF800000000000n ? "kernel ?" : "user ?";
        modules.set(name, (modules.get(name) || 0) + t);
    }
    console.log("X64_WIN_PROFILE_MODULES " + JSON.stringify([...modules].sort((a, b) => b[1] - a[1]).slice(0, 20)
        .map(([name, t]) => [name, +(100 * t / total).toFixed(2)])));
}
// (the most recent address spaces first)
const page_modules = {}, seen_cr3 = new Set(), module_headers = new Map();
// The PE image containing a linear address, as "name+0xoffset": scan down to
// its MZ header, name it by the PDB of its CodeView debug entry (or its
// export name); user addresses under each address space seen so far
function guest_module(address)
{
    const spaces = [current_cr3(), ...[...seen_cr3].reverse().slice(0, 16)];
    for(const cr3 of address >= 0xFFFF800000000000n ? spaces.slice(0, 1) : spaces)
    {
        const u8 = va => { const at = physical(cr3, va); return at === null ? null : cpu.mem8[at]; };
        // (a cached header scan: the image base of the page, or none)
        const cached = module_headers.get(cr3 + ":" + address.toString(16));
        if(cached === null) continue;
        const u16 = va => { const a = u8(va), b = u8(va + 1n); return a === null || b === null ? null : a | b << 8; };
        const u32 = va => { const a = u16(va), b = u16(va + 2n); return a === null || b === null ? null : (a | b << 16) >>> 0; };
        const string = va => { let text = ""; for(let c; text.length < 64 && (c = u8(va)) && c >= 32 && c < 127; va++) text += String.fromCharCode(c); return text; };
        for(let page = address & ~0xFFFn, n = 0; n < 4096; n++, page -= 0x1000n)
        {
            if(u16(page) !== 0x5A4D) continue;
            const pe = page + BigInt(u32(page + 0x3Cn) ?? 0);
            if(u32(pe) !== 0x4550) continue;
            const optional = pe + 24n, wide = u16(optional) === 0x20B;
            if(address - page >= BigInt(u32(optional + 56n) ?? 0)) break;
            const directories = optional + (wide ? 112n : 96n);
            let name = "";
            const debug = u32(directories + 6n * 8n), debug_size = u32(directories + 6n * 8n + 4n);
            for(let i = 0; debug && i < debug_size / 28 && !name; i++)
            {
                const entry = page + BigInt(debug) + BigInt(i * 28);
                const data = u32(entry + 20n);
                if(u32(entry + 12n) === 2 && data && u32(page + BigInt(data)) === 0x53445352)
                    name = string(page + BigInt(data) + 24n).split("\\").pop().replace(/\.pdb$/i, "");
            }
            const exports = u32(directories);
            if(!name && exports) name = string(page + BigInt(u32(page + BigInt(exports) + 12n) ?? 0));
            return (name || "0x" + page.toString(16)) + "+0x" + (address - page).toString(16);
        }
        module_headers.set(cr3 + ":" + address.toString(16), null);
    }
    return null;
}
function current_cr3()
{
    return BigInt(cpu.cr[3] >>> 0) & ~0xFFFn | BigInt(new Uint32Array(cpu.wasm_memory.buffer, 1612, 1)[0]) << 32n;
}
const started = performance.now();
const elapsed = () => Math.round((performance.now() - started) / 1000);
let powered_off = null;
vm.add_listener("acpi-power-off", state => { powered_off = state; });
// the guest drivers' logs through the VMware backdoor (vm3d's release log)
vm.add_listener("vmware-log", text => event("guest-log", {text: String(text).slice(0, 400)}));
vm.add_listener("vmware-rpci", text => {
    // (the launcher asks once a second)
    if(String(text) !== "info-get guestinfo.v86.run") event("rpci", {text: String(text).slice(0, 200)});
});
// the launcher (tools/windows/launch.c) in the user's session, once it said so
let launcher_ready = false, launch_serial = 0;
vm.add_listener("vmware-log", text => { if(String(text) === "launch: ready") launcher_ready = true; });
const backdoor_seen = new Set();
vm.add_listener("vmware-backdoor-unknown", command => { if(!backdoor_seen.has(command)) { backdoor_seen.add(command); event("backdoor-unknown", {command}); } });
const report = {image: {path: image_path, size: source_stat.size, mtime_ms: source_stat.mtimeMs}, cores, jit,
    parallel: !!+process.env.WIN_PARALLEL, memory_mb, modes: [], events: [], results: {}};
const event = (kind, detail = {}) => { const e = {s: elapsed(), kind, ...detail}; report.events.push(e); console.log("X64_WIN_EVENT " + JSON.stringify(e)); };
let cpu, graphics_since = 0, last_mode = null, execution_error;
vm.add_listener("screen-set-size", size => {
    report.modes.push({s: elapsed(), size});
    last_mode = size; graphics_since = performance.now();
    event("mode", {size});
});

// Set 1 scan codes
const scans = {};
for(const [letters, codes] of [["1234567890", [2,3,4,5,6,7,8,9,10,11]], ["qwertyuiop", [16,17,18,19,20,21,22,23,24,25]],
    ["asdfghjkl", [30,31,32,33,34,35,36,37,38]], ["zxcvbnm", [44,45,46,47,48,49,50]]])
    [...letters].forEach((letter, i) => { scans[letter] = codes[i]; });
Object.assign(scans, {" ": 57, ".": 52, "/": 53, "\\": 43, "-": 12, ";": 39, "=": 13, ",": 51, "'": 40});
const shifted = {":": 39, "%": 6, "(": 10, ")": 11, "@": 3, "&": 8, "\"": 40, ">": 52, "<": 51, "_": 12, "|": 43};
async function type(text)
{
    for(const ch of text)
    {
        const upper = ch >= "A" && ch <= "Z";
        const code = shifted[ch] || scans[ch.toLowerCase()];
        assert.ok(code, `scan code for ${JSON.stringify(ch)}`);
        const shift = upper || shifted[ch];
        await vm.keyboard_send_scancodes(shift ? [42, code, code | 128, 170] : [code, code | 128], 30);
        await delay(40);
    }
}
const press = async codes => { await vm.keyboard_send_scancodes(codes, 30); await delay(100); };
const enter = () => press([28, 156]);
// The sign-in screen of this image at 1024x768: the password box is a white
// field right of the user tile. Keys pressed before it appears are lost
// (the lock screen fades out slowly on an emulated core).
// vga.svga_memory is a lib.js view (a Proxy that builds a typed array on
// every element access): read the frame buffer through one plain array
const svga_bytes = () => new Uint8Array(cpu.wasm_memory.buffer, cpu.devices.vga.svga_memory.byteOffset, cpu.devices.vga.vga_memory_size);
// The picture on screen: vmware_svga's first screen object (RGBA), its
// register mode, virtio_gpu's first display (RGBA), or the VGA core's VBE
// mode (BGR in the frame buffer); null in text and planar modes
function frame_buffer()
{
    const gpu = cpu.devices.graphics_adapter && cpu.devices.graphics_adapter.device["virtio_gpu"];
    const scanout = gpu && gpu.active && gpu.scanouts[0];
    if(scanout && scanout.rgba) return {width: scanout.width, height: scanout.height, bpp: 32, pitch: scanout.width * 4, offset: 0, rgba: scanout.rgba};
    const svga = cpu.devices.graphics_adapter && cpu.devices.graphics_adapter.device["svga"];
    const screen = svga && svga.svga_active() && svga.screens.screens.get(0);
    if(screen) return {width: screen.width, height: screen.height, bpp: 32, pitch: screen.width * 4, offset: 0, rgba: screen.rgba};
    if(svga && svga.svga_active()) return {width: svga.width, height: svga.height, bpp: svga.bpp, pitch: svga.pitch(), offset: 0};
    const vga = cpu.devices.vga;
    if(!vga.svga_enabled) return null;
    const bytes = vga.svga_bpp / 8;
    return {width: vga.svga_width, height: vga.svga_height, bpp: vga.svga_bpp, pitch: vga.svga_width * bytes, offset: vga.svga_offset * bytes};
}
// 1024x768 at 16/24/32 bpp, as the pixel heuristics below expect
function desktop_mode()
{
    const fb = frame_buffer();
    return fb && fb.width === 1024 && fb.height === 768 && [32, 24, 16].includes(fb.bpp) ? fb : null;
}
let pixel_memory = null, pixel_memory_at = -1;
function pixel(x, y)
{
    const fb = frame_buffer(), bytes_per = fb.bpp / 8;
    // (one array per polling round: the wasm memory may grow in between)
    if(pixel_memory_at !== Math.floor(performance.now() / 50) || pixel_memory.buffer !== cpu.wasm_memory.buffer)
    {
        pixel_memory = svga_bytes();
        pixel_memory_at = Math.floor(performance.now() / 50);
    }
    const at = fb.offset + y * fb.pitch + x * bytes_per, m = fb.rgba || pixel_memory;
    if(fb.rgba) return [m[at], m[at + 1], m[at + 2]];
    return bytes_per === 2 ? [(m[at + 1] >> 3) << 3, (m[at] >> 5 | (m[at + 1] & 7) << 3) << 2, (m[at] & 31) << 3] : [m[at + 2], m[at + 1], m[at]];
}
function password_box_visible()
{
    if(!desktop_mode()) return false;
    const background = pixel(100, 100), tile = pixel(260, 190);
    return [[620, 248], [680, 248], [720, 256], [735, 240]].every(([x, y]) => pixel(x, y).every(c => c > 230)) &&
        // a plain background, not white, around the gray user tile
        !background.every(c => c > 230) && [[900, 100], [100, 600], [900, 600]].every(([x, y]) => pixel(x, y).every((c, i) => c === background[i])) &&
        tile.every(c => c >= 40 && c <= 110 && Math.abs(c - tile[0]) < 8);
}
// The desktop: the white Start logo at the left end of the taskbar (four
// panes split by a vertical gap)
function desktop_visible()
{
    if(!desktop_mode()) return false;
    const white = (x, y) => pixel(x, y).every(c => c > 220);
    return [[16, 744], [30, 744], [16, 752], [30, 752]].every(([x, y]) => white(x, y)) && !white(23, 746) && !white(10, 745) && !white(40, 745);
}
let last_sign_in = -Infinity;
// A key wakes the display or dismisses the lock screen; repeat until the
// password box shows, clear anything typed into it, then sign in.
async function sign_in()
{
    event("sign-in");
    last_sign_in = performance.now();
    for(let i = 0; i < 12 && !password_box_visible() && !desktop_visible(); i++)
    {
        await press([57, 185]);
        for(const limit = performance.now() + 10000; performance.now() < limit && !password_box_visible() && !desktop_visible();) await delay(250);
    }
    // never type the password blind (it could reach the desktop); the caller
    // retries while the session is not up
    if(!password_box_visible()) { event("sign-in-no-password-box"); return; }
    event("password-box");
    for(let i = 0; i < 4; i++) await press([14, 142]);
    await type(password);
    await enter();
}
// The Run dialog of this image at 1024x768 (bottom left), open with the
// input focused: white body, the grey button strip and the edit box's blue
// focus border
function run_dialog_ready()
{
    if(!desktop_mode()) return false;
    const white = (x, y) => pixel(x, y).every(c => c > 245);
    const [r, , b] = pixel(398, 622);
    return white(300, 555) && white(300, 600) && white(100, 650) && pixel(60, 700).every(c => Math.abs(c - 240) <= 6) && b > 200 && r < 120;
}
// Keys typed before the dialog has focus are lost (it takes seconds to tens
// of seconds to appear on a loaded host); returns whether the line was typed
async function run_command(line)
{
    event("run", {line});
    const asked = performance.now();
    await press([0xE0, 0x5B, 0x13, 0x93, 0xE0, 0xDB]); // Win+R
    for(const limit = performance.now() + 60000; performance.now() < limit && !run_dialog_ready();) await delay(100);
    if(!run_dialog_ready()) { event("run-dialog-missing"); return false; }
    // responsiveness: Win+R until the dialog is up with its input focused
    event("run-dialog", {ms: Math.round(performance.now() - asked)});
    await delay(1000);
    // the previous command is preselected; typing replaces it
    await type(line);
    await enter();
    return true;
}

// A command line for cmd /c, elevated: PowerShell's Start-Process -Verb
// RunAs from the Run dialog, then Alt+Y on the UAC prompt (the line must not
// contain quotes)
async function run_admin(line)
{
    event("runadmin", {line});
    if(!await run_command(`powershell -c "start-process cmd -verb runas -argumentlist '/c ${line}'"`)) return false;
    // The UAC prompt dims the desktop (its Start logo is gone): wait for it,
    // answer Yes, and wait for the desktop to come back
    for(const limit = performance.now() + 600000; performance.now() < limit && desktop_visible();)
    {
        await delay(1000);
        screenshot(false);
    }
    if(desktop_visible()) { event("uac-missing"); return false; }
    await delay(5000);
    screenshot(true);
    event("uac");
    for(let i = 0; i < 5 && !desktop_visible(); i++)
    {
        await press([0x38, 0x15, 0x95, 0xB8]); // Alt+Y
        for(const limit = performance.now() + 30000; performance.now() < limit && !desktop_visible();) await delay(500);
    }
    event(desktop_visible() ? "uac-accepted" : "uac-stuck");
    return desktop_visible();
}

function text_screen()
{
    const vga = cpu.devices.vga;
    if(vga.graphical_mode) return "";
    return Array.from({length: 25}, (_, row) => Array.from({length: 80}, (_, col) => {
        const c = vga.vga_memory[(row * 80 + col) * 2];
        return c >= 32 && c < 127 ? String.fromCharCode(c) : " ";
    }).join("").trimEnd()).join("\n").trim();
}
let last_hash = "", shots = 0, last_saved = 0, last_change = 0, dark_fraction = 1, colors = 0;
let svga_seen = "";
// The SVGA II registers as the guest's driver sets them, logged on change
function observe_svga()
{
    // virtio_gpu: whether its displays are on screen, what they show, what the driver sent
    const gpu = cpu.devices.graphics_adapter && cpu.devices.graphics_adapter.device["virtio_gpu"];
    if(gpu)
    {
        // (the transport: v86's VirtIO object, from the source tree)
        const t = cpu.devices.graphics_adapter.pci_device;
        const state = {active: gpu.active, scanouts: gpu.scanouts.map(sc => [sc.enabled, sc.host_width, sc.host_height, sc.resource_id, sc.width, sc.height]),
            resources: gpu.resources.size, errors: gpu.stats.errors, last_error: gpu.stats.last_error.toString(16), commands: gpu.stats.commands,
            cursor: [gpu.stats.cursor_updates, gpu.stats.cursor_moves, gpu.cursor.width, gpu.cursor.height, gpu.cursor.visible],
            status: t && t.device_status, features: t && Array.from(t.driver_feature || [], f => (f >>> 0).toString(16)),
            queues: t && t.queues && t.queues.map(q => [q.size, q.enabled, (q.desc_addr || 0).toString(16), q.avail_last_idx]),
            isr: t && t.isr_status, irq_line: cpu.devices.pci.device_spaces[cpu.devices.graphics_adapter.pci_id][15] & 0xFF};
        const key = JSON.stringify(state);
        if(key !== svga_seen && performance.now() >= svga3d_next) { svga_seen = key; svga3d_next = performance.now() + 5000; event("virtio-gpu", state); }
        return;
    }
    const svga = cpu.devices.graphics_adapter && cpu.devices.graphics_adapter.device["svga"];
    if(!svga) return;
    const state = {level: svga.level, enable: svga.enable, mode: `${svga.width}x${svga.height}x${svga.bpp}`, pitch: svga.pitch(),
        guest_id: svga.guest_id, config_done: svga.config_done, irq_mask: svga.irq_mask, id: svga.id.toString(16),
        screens: [...svga.screens.screens.values()].map(sc => [sc.id, sc.x, sc.y, sc.width, sc.height, sc.backing ? sc.backing.gmr : -1]),
        unknown: svga.stats ? svga.stats.last_unknown : 0, errors: svga.stats ? svga.stats.errors : 0};
    const key = JSON.stringify(state);
    if(key !== svga_seen) { svga_seen = key; event("svga", state); }
    // the 3D commands so far, every 30 s while they change
    if(svga.svga3d && performance.now() >= svga3d_next)
    {
        svga3d_next = performance.now() + 30000;
        const counts = JSON.stringify(svga.svga3d.counts);
        const activity = counts + JSON.stringify(svga.stats);
        if(activity !== svga3d_seen) { svga3d_seen = activity; event("svga3d", {counts: svga.svga3d.counts, bytes: svga.svga3d.bytes, surfaces: svga.svga3d.surfaces.size, contexts: svga.svga3d.contexts.size, device: svga.stats, warnings: svga.svga3d.warnings}); }
    }
}
let svga3d_next = 0, svga3d_seen = "";
function screenshot(force)
{
    const fb = frame_buffer();
    if(!fb || !fb.width || !fb.height || ![32, 24, 16].includes(fb.bpp)) return null;
    const width = fb.width, height = fb.height;
    const bytes_per = fb.bpp / 8, stride = width * 3 + 1, raw = Buffer.alloc(stride * height), memory = fb.rgba || svga_bytes();
    for(let y = 0; y < height; y++) for(let x = 0; x < width; x++)
    {
        const from = fb.offset + y * fb.pitch + x * bytes_per, to = y * stride + 1 + x * 3;
        if(fb.rgba) { raw[to] = memory[from]; raw[to + 1] = memory[from + 1]; raw[to + 2] = memory[from + 2]; }
        else if(bytes_per === 2)
        {
            const v = memory[from] | memory[from + 1] << 8;
            raw[to] = (v >> 11 & 31) << 3; raw[to + 1] = (v >> 5 & 63) << 2; raw[to + 2] = (v & 31) << 3;
        }
        else { raw[to] = memory[from + 2]; raw[to + 1] = memory[from + 1]; raw[to + 2] = memory[from]; }
    }
    const hash = create_hash("sha1").update(raw).digest("hex").slice(0, 12);
    if(hash === last_hash && !force) return hash;
    last_hash = hash;
    last_change = performance.now();
    let dark = 0, samples = 0;
    const palette = new Set();
    for(let at = 1; at < raw.length; at += 3 * 97)
    {
        samples++;
        if(raw[at] + raw[at + 1] + raw[at + 2] < 48) dark++;
        palette.add(raw[at] >> 5 | raw[at + 1] >> 5 << 3 | raw[at + 2] >> 5 << 6);
    }
    dark_fraction = dark / samples;
    colors = palette.size;
    const crc = data => { let c = 0xFFFFFFFF; for(const byte of data) { c ^= byte; for(let i = 0; i < 8; i++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xFFFFFFFF) >>> 0; };
    const chunk = (name, data) => { const tag = Buffer.from(name), body = Buffer.concat([tag, data]), b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); body.copy(b, 4); b.writeUInt32BE(crc(body), b.length - 4); return b; };
    const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflate_sync(raw)), chunk("IEND", Buffer.alloc(0))]);
    fs.writeFileSync(path.join(out, "screen.png"), png);
    // numbered history: at most one per 20 s (a console cursor blinks)
    if(force || performance.now() - last_saved > 20000)
    {
        last_saved = performance.now();
        fs.writeFileSync(path.join(out, `screen-${String(++shots).padStart(3, "0")}-${elapsed()}s.png`), png);
    }
    return hash;
}
function stats()
{
    const ex = cpu.wm.exports;
    const tier = ex.x64_page_stat ? Object.fromEntries([["compiled", 0], ["native", 1], ["retries", 2], ["unknown", 3], ["steps", 4], ["invalidated", 5],
        ["failed", 7], ["recompiled", 8], ["evicted", 11], ["live", 12], ["activations", 13], ["invlpg", 14], ["cr_writes", 15], ["access_misses", 16], ["lfb_fills", 17], ["cr3_keep_global", 18], ["jac_large_flush", 19], ["unaligned_reads", 25], ["distinct", 21], ["ms_in_calls", 20], ["ms_in_execute", 22], ["ms_first_calls", 23], ["bytes_compiled", 24], ["cr0_writes", 26], ["cr3_writes", 27], ["cr4_writes", 28], ["full_flushes", 29], ["walks", 30], ["compat_fills", 31], ["compat_refills", 32], ["hot_recompiles", 33], ["jac_fills", 34], ["jac_conflicts", 35]]
        .map(([name, i]) => [name, ex.x64_page_stat(i)])) : null;
    const d = cpu.get_diagnostics();
    return {page_tier: tier, cores: d.cores.map(core => ({state: core.state, ip: core.linear_ip, cs: core.cs, retired: core.retired_instructions, halted: core.halted})),
        mode: d.cpu.mode, overlay_sectors: source.overlay.size, execution: d.execution,
        workers: d.parallel ? d.parallel.cores.map(core => ({steps: core.steps, slices: core.slices, waits: core.waits, io: core.io, refused: core.refused})) : undefined,
        kicks: cpu.wm.exports.parallel_kick_count ? cpu.wm.exports.parallel_kick_count() : undefined};
}
// Read-only 4-level walk (no A/D updates), for diagnostics only.
function physical(cr3, address)
{
    const ram = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset, cpu.mem8.length);
    let table = cr3;
    for(const shift of [39n, 30n, 21n, 12n])
    {
        const at = Number(table & 0xFFFFFF000n) + Number(address >> shift & 511n) * 8;
        if(at + 8 > ram.byteLength) return null;
        const entry = ram.getBigUint64(at, true);
        if(!(entry & 1n)) return null;
        if(shift === 12n || shift < 39n && entry & 128n)
        {
            const mask = (1n << shift) - 1n;
            return Number(entry & 0xFFFFFF000n & ~mask | address & mask);
        }
        table = entry;
    }
    return null;
}
// RIP sampling between slices: which kernel code is hot (offline
// symbolization against ntoskrnl.exe; the base is found from LSTAR, which
// points into ntoskrnl)
const rip_samples = new Map();
let kernel_base = null;
function sample_rip()
{
    const view = new DataView(cpu.wasm_memory.buffer);
    const rip = BigInt(view.getUint32(1584, true)) << 32n | BigInt(cpu.instruction_pointer[0] >>> 0);
    if(kernel_base === null && view.getBigUint64(1720, true) !== 0n)
    {
        const lstar = view.getBigUint64(1720, true);
        const cr3 = BigInt(cpu.cr[3] >>> 0) | BigInt(view.getUint32(1612, true)) << 32n;
        for(let page = lstar & ~0xFFFn, n = 0; n < 8192; n++, page -= 0x1000n)
        {
            const at = physical(cr3, page);
            if(at !== null && cpu.mem8[at] === 0x4D && cpu.mem8[at + 1] === 0x5A) { kernel_base = page; event("kernel-base", {base: "0x" + page.toString(16)}); break; }
        }
    }
    const compat = view.getUint8(1744) === 0 && (view.getBigUint64(1696, true) & 0x400n) !== 0n;
    const key = compat ? "compat:0x" + rip.toString(16) :
        kernel_base !== null && rip >= kernel_base && rip < kernel_base + 0x1000000n ? "nt+0x" + (rip - kernel_base).toString(16) : "0x" + rip.toString(16);
    rip_samples.set(key, (rip_samples.get(key) || 0) + 1);
    if(!rip_raw.has(key)) rip_raw.set(key, rip);
}
// (a sampled key's RIP, for its code bytes in the report)
const rip_raw = new Map();
function rip_bytes(key)
{
    const rip = rip_raw.get(key);
    if(rip === undefined) return null;
    const at = physical(current_cr3(), rip - 16n);
    return at === null ? null : Buffer.from(cpu.mem8.subarray(at, at + 32)).toString("hex");
}
// WIN_USER_TRACE=1: exceptions taken from user mode (compatibility mode: all;
// 64-bit: all but #PF), with the code at the faulting RIP, read while the
// process is (most likely) still current
let trace_seen = 0;
function poll_user_trace()
{
    const ex = cpu.wm.exports, count = ex.x64_user_trace_count();
    if(count === trace_seen) return;
    const first = Math.max(0, count - 1024);
    const u64 = (i, f) => BigInt(ex.x64_user_trace(i - first, f, 1) >>> 0) << 32n | BigInt(ex.x64_user_trace(i - first, f, 0) >>> 0);
    for(let i = Math.max(trace_seen, first); i < count; i++)
    {
        const [vector, error, rip, address, rsp, cs, cr3] = [0, 1, 2, 3, 4, 5, 6].map(f => u64(i, f));
        const at = physical(cr3, rip);
        const none = 0xFFFFFFFFFFFFFFFFn, hex = v => "0x" + v.toString(16);
        console.log("X64_WIN_TRACE " + JSON.stringify({n: i, vector: Number(vector), error: error === none ? null : hex(error), rip: hex(rip),
            cr2: address === none ? null : hex(address), rsp: hex(rsp), cs: hex(cs), cr3: hex(cr3),
            code: at === null ? null : Buffer.from(cpu.mem8.subarray(at, at + 16)).toString("hex")}));
    }
    trace_seen = count;
}
// WIN_IDLE=1: after the desktop, how busy the idle guest is. Host windows
// of 10 s (per core: share of the wall clock spent executing, MIPS, HLTs),
// and CPULOAD.EXE (tests/x64/windows_cpuload.c): Windows' own accounting,
// the numbers Task Manager shows, over WIN_IDLE_ROUNDS windows of 10 s,
// started WIN_IDLE_SETTLE_S (20) seconds after the desktop appeared.
let host_last = null;
function host_window()
{
    const ex = cpu.wm.exports, now = performance.now(), usage = process.cpuUsage();
    const sample = {at: now, usage, cores: Array.from({length: cores}, (_, core) => [0, 3, 4].map(f => ex.core_statistics_get(core, f)))};
    if(host_last)
    {
        const wall = now - host_last.at;
        event("host-window", {wall_ms: Math.round(wall),
            host_cpu: +((usage.user + usage.system - host_last.usage.user - host_last.usage.system) / 1000 / wall).toFixed(2),
            cores: sample.cores.map(([retired, halts, runtime], core) => {
                const [retired0, halts0, runtime0] = host_last.cores[core];
                return {busy: +((runtime - runtime0) / wall).toFixed(3), mips: Math.round((retired - retired0) / wall / 1000), halts: halts - halts0};
            })});
    }
    host_last = sample;
}
const port_counts = new Map();
const snapshots_taken = [];
const result_text = name => { const bytes = read_fat16(tools.bytes, name); return bytes ? Buffer.from(bytes).toString("ascii") : ""; };

try
{
    await new Promise((resolve, reject) => { vm.add_listener("emulator-loaded", resolve); vm.add_listener("emulator-error", reject); });
    cpu = vm.v86.cpu;
    if(+process.env.WIN_AHCI_TRACE && cpu.devices.ahci_test)
    {
        // GHC, and each port's PxIE, PxCMD, PxSCTL; and its configuration
        // space writes (command, power management, MSI)
        const ahci = cpu.devices.ahci_test, write32 = ahci.write32.bind(ahci);
        ahci.write32 = (offset, value, mask) => {
            if(offset === 4 || offset >= 0x100 && [0x14, 0x18, 0x2C].includes(offset & 0x7F))
                event("ahci-write", {offset: offset.toString(16), value: (value >>> 0).toString(16)});
            write32(offset, value, mask);
        };
        const pci = cpu.devices.pci, function_write = pci.function_write.bind(pci);
        pci.function_write = (pci_id, offset, size, value) => {
            if(pci_id === ahci.pci_id && offset >= 4) event("ahci-config", {offset: offset.toString(16), size, value: (value >>> 0).toString(16)});
            function_write(pci_id, offset, size, value);
        };
    }
    if(+process.env.WIN_PCIE_TRACE)
    {
        for(const port of cpu.devices.pcie_root_ports || [])
        {
            const written = port.slot_control_written.bind(port), raised = port.event.bind(port);
            port.slot_control_written = value => { event("pcie-sltctl", {port: port.number, value: value.toString(16)}); written(value); };
            port.event = events => { if(events !== 0x10) event("pcie-event", {port: port.number, events: events.toString(16)}); raised(events); };
        }
    }
    // virtio_gpu: every device status the driver writes, every control
    // command and every reset of the transport, as they happen
    const virtio = cpu.devices.graphics_adapter && cpu.devices.graphics_adapter.device["virtio_gpu"] &&
        cpu.devices.graphics_adapter.pci_device;
    if(virtio)
    {
        const status_field = virtio.mmio_fields.find(field => field.offset === 20);
        const write_status = status_field.write;
        status_field.write = value => { event("virtio-status", {value, before: virtio.device_status}); write_status(value); };
        const gpu = cpu.devices.graphics_adapter.device["virtio_gpu"];
        const control = gpu.control.bind(gpu);
        let logged = 0;
        gpu.control = bytes => {
            const response = control(bytes);
            const type = bytes[0] | bytes[1] << 8, result = response[0] | response[1] << 8;
            if(logged++ < 200 || result >= 0x1200) event("virtio-command", {type: type.toString(16), result: result.toString(16), length: bytes.length});
            return response;
        };
        const needs_reset = virtio.needs_reset.bind(virtio);
        virtio.needs_reset = () => { event("virtio-needs-reset"); needs_reset(); };
    }
    // WIN_GUESTINFO=key=value;...: what the VMware backdoor answers for
    // guestinfo.<key> (VMware's drivers read their settings so, e.g.
    // loglevel.vm3d.all=10 or svga.wddm.miniportLogging=TRUE)
    for(const entry of (process.env.WIN_GUESTINFO || "").split(";").filter(Boolean))
    {
        const at = entry.indexOf("=");
        cpu.devices.vmware.guestinfo.set(entry.slice(0, at), entry.slice(at + 1));
    }
    if(process.env.WIN_X64_PROFILE !== "0") cpu.wm.exports.set_x64_test_capabilities(1);
    if(process.env.WIN_PAGE_TIER === "0") cpu.wm.exports.x64_page_set_enabled(0);
    if(process.env.WIN_STEP_PROFILE) cpu.wm.exports.x64_page_profile(1);
    if(process.env.WIN_RECOMPILE_MISSES) cpu.wm.exports.x64_page_set_recompile_misses(+process.env.WIN_RECOMPILE_MISSES);
    // WIN_OUTLINE=0: inline the access cache lookup at every access
    if(process.env.WIN_OUTLINE === "0") cpu.wm.exports.x64_page_set_outline(0);
    // WIN_SIZE_STATS=1: Wasm bytes per template kind, printed at the end
    if(process.env.WIN_SIZE_STATS) cpu.wm.exports.x64_pagegen_size_stats(1);
    // WIN_PAGE_TIMING=1: time spent inside page function calls (stats)
    if(process.env.WIN_PAGE_TIMING) cpu.wm.exports.x64_page_timing(1);
    // WIN_DUMP_MODULES=<n>: save every 64th published page function module
    // (up to n) to <out>/modules/ for offline size analysis
    if(+process.env.WIN_DUMP_MODULES)
    {
        fs.mkdirSync(path.join(out, "modules"), {recursive: true});
        const publish = cpu.x64_page_publish.bind(cpu);
        let published = 0, dumped = 0;
        cpu.x64_page_publish = (id, slot, pointer, length) => {
            if(published++ % 64 === 0 && dumped < +process.env.WIN_DUMP_MODULES)
                fs.writeFileSync(path.join(out, "modules", `m${String(dumped++).padStart(4, "0")}.wasm`),
                    new Uint8Array(cpu.wasm_memory.buffer, pointer >>> 0, length >>> 0));
            return publish(id, slot, pointer, length);
        };
    }
    // WIN_RECORD=<file>: the inputs of the page tier's compilations, saved at
    // the end as tools/replay_record.mjs saves them (a test core's replay
    // hooks: WASM_PATH=build/v86-ir-test-release.wasm), e.g. to replay a
    // boot's pages under other JIT switches
    if(process.env.WIN_RECORD)
    {
        if(!cpu.wm.exports.x64_page_record_start) throw new Error("WIN_RECORD: the core has no replay hooks (WASM_PATH=build/v86-ir-test-release.wasm)");
        cpu.wm.exports.x64_page_record_start();
    }
    // WIN_LPT_STATUS=<hex>: the status register of the unconnected LPT1
    if(process.env.WIN_LPT_STATUS) cpu.devices.parallel0.status = parseInt(process.env.WIN_LPT_STATUS, 16);
    // WIN_PORT_STATS=1: port accesses by port and size, printed each minute
    if(process.env.WIN_PORT_STATS)
    {
        for(const [name, kind] of [["port_read8", "in8"], ["port_read16", "in16"], ["port_read32", "in32"],
            ["port_write8", "out8"], ["port_write16", "out16"], ["port_write32", "out32"]])
        {
            const f = cpu.io[name].bind(cpu.io);
            cpu.io[name] = (port, ...rest) => {
                const key = kind + ":" + port.toString(16);
                port_counts.set(key, (port_counts.get(key) || 0) + 1);
                return f(port, ...rest);
            };
        }
    }
    if(process.env.WIN_USER_TRACE) cpu.wm.exports.x64_user_trace_enable(1);
    // The reset is noted before any state is replaced: record the code at
    // each faulting RIP and the descriptor tables while they are intact.
    const note_reset = cpu.note_reset.bind(cpu);
    cpu.note_reset = reason => {
        note_reset(reason);
        const info = cpu.last_reset, cr3 = BigInt(cpu.cr[3] >>> 0) | BigInt(new Uint32Array(cpu.wasm_memory.buffer, 1612, 1)[0]) << 32n;
        const bytes = (address, length) => {
            const at = physical(cr3, BigInt(address));
            return at === null ? null : Buffer.from(cpu.mem8.subarray(at, at + length)).toString("hex");
        };
        for(const fault of info.x64_faults || []) fault.bytes = bytes(fault.rip, 24);
        // The image containing the first faulting RIP (scan down for its MZ
        // header), plus the stack, for offline symbolization
        const first = info.x64_faults?.[info.x64_faults.length - 1];
        if(first)
        {
            for(let page = BigInt(first.rip) & ~0xFFFn, n = 0; n < 4096; n++, page -= 0x1000n)
            {
                const header = bytes(page, 2);
                if(header === "4d5a") { info.image_base = "0x" + page.toString(16); break; }
            }
            info.stack = "";
            for(let at = BigInt(first.rsp), end = at + 0x40000n; at < end;)
            {
                const length = 0x1000 - Number(at & 0xFFFn), part = bytes(at, length);
                if(part === null) break;
                info.stack += part;
                at += BigInt(length);
            }
            for(const rva of (process.env.WIN_DUMP_RVAS || "").split(",").filter(Boolean))
                (info.dumps ||= {})[rva] = info.image_base && bytes(BigInt(info.image_base) + BigInt(rva), 64);
        }
        info.gdt = bytes(info.gdtr[0], Math.min(info.gdtr[1] + 1, 0x80));
        info.idt_3_8_13 = [3, 8, 13].map(v => bytes(BigInt(info.idtr[0]) + BigInt(v * 16), 16));
    };
    const run_cores = cpu.run_cores.bind(cpu);
    cpu.run_cores = () => { try { return run_cores(); } catch(error) { execution_error = error; vm.stop(); return 100; } };
    let resumed = null;
    if(state_load)
    {
        const fd = fs.openSync(state_load + ".state", "r"), size = fs.fstatSync(fd).size;
        await vm.restore_state_stream({size, read: async (offset, length) => {
            const bytes = new Uint8Array(length);
            for(let done = 0; done < length;) done += fs.readSync(fd, bytes, done, length - done, offset + done);
            return bytes;
        }});
        fs.closeSync(fd);
        resumed = JSON.parse(fs.readFileSync(state_load + ".json", "utf8"));
        launch_serial = resumed.launch_serial;
        launcher_ready = resumed.launcher_ready;
        event("state-loaded", {file: state_load, bytes: size});
    }
    vm.run();
    const deadline = performance.now() + +(process.env.WIN_TIMEOUT_MS || 3600000);
    let next_profile = performance.now() + 1000 * +(process.env.WIN_CPU_PROFILE || 0);
    let next_report = 0, next_samples = performance.now() + 60000, next_shot = 0, resets = 0, signed_in = false, probe_sent = 0, text_seen = "";
    let shutdown_at = 0, shutdown_sent = false, shutdown_deadline = 0;
    // (a loaded state is signed in, past the desktop)
    if(resumed) { signed_in = true; probe_sent = Infinity; report.desktop_s = elapsed(); }
    let next_rates = performance.now() + 1000 * +(process.env.WIN_RATES || 0), rates_counts = null, rates_at = performance.now(), rates_retired = 0;
    let rate_samples = {n: 0, halted: 0, backlog: 0, waiting: 0};
    // a line of command.txt (see the top of this file), or of WIN_SETUP
    // (a bad line is reported, not fatal: the guest's state is worth more)
    const command = line => run_one(line).catch(error => {
        if(error === execution_error) throw error;
        event("command-failed", {line, error: String(error && error.message || error)});
    });
    const run_one = async line => {
        const [verb, ...rest] = line.split(" "), argument = rest.join(" ");
        event("command", {line});
        if(verb === "key") await press(argument.split(/\s+/).map(v => parseInt(v, 16)));
        else if(verb === "type") await type(argument);
        else if(verb === "run") await run_command(argument);
        else if(verb === "runadmin") await run_admin(argument);
        else if(verb === "enter") await enter();
        else if(verb === "space") await press([57, 185]);
        else if(verb === "password") { await type(password); await enter(); }
        else if(verb === "shot") screenshot(true);
        // the page's size for a display (V86.set_display_size; virtio_gpu tells the guest)
        else if(verb === "display") vm.set_display_size(...argument.split(/\s+/).map(Number));
        // a relative mouse movement (PS/2), in pixels, y up
        else if(verb === "mouse") vm.bus.send("mouse-delta", argument.split(/\s+/).map(Number));
        // an absolute position on a screen of the given size (the VMware
        // backdoor's mouse, which takes over from PS/2 once its driver runs)
        else if(verb === "pointer") vm.bus.send("mouse-absolute", argument.split(/\s+/).map(Number));
        // the machine into files, to start from later (WIN_STATE_LOAD)
        // (streamed: with the GPU's contents a state passes 4 GiB)
        else if(verb === "savestate")
        {
            const file = path.resolve(argument);
            await vm.stop();
            let bytes = 0;
            try
            {
                const fd = fs.openSync(file + ".state", "w");
                try { await vm.save_state_stream(chunk => { fs.writeSync(fd, chunk); bytes += chunk.length; }); }
                finally { fs.closeSync(fd); }
                save_overlay(file + ".hda.ovl");
                if(hdb_path) save_overlay(file + ".hdb.ovl", hdb);
                fs.writeFileSync(file + ".json", JSON.stringify({launch_serial, launcher_ready, signed_in: true}));
            }
            finally { vm.run(); }
            event("savestate", {file, bytes});
        }
        // a snapshot saved and restored in place (the disks are not in it, and unchanged)
        else if(verb === "snapshot")
        {
            await vm.stop();
            const state = await vm.save_state();
            await vm.restore_state(state);
            vm.run();
            event("snapshot", {bytes: state.byteLength});
        }
        else if(verb === "rips") next_samples = 0;
        else if(verb === "jitstats") print_jit_stats(vm, {script: "windows_boot", phase: argument || "command", s: elapsed(), wasm: process.env.WASM_PATH || null, cores});
        // PCI Express hot plug (WIN_PCIE_DEVICE)
        else if(verb === "pcieattach") await vm.attach_pcie_device(+argument);
        else if(verb === "pciedetach")
        {
            const [port, how] = argument.split(/\s+/);
            const asked = performance.now();
            vm.detach_pcie_device(+port, {surprise: how === "surprise"}).then(
                () => event("pcie-detached", {port: +port, after_s: Math.round((performance.now() - asked) / 100) / 10}),
                error => event("pcie-detach-failed", {port: +port, error: String(error && error.message || error)}));
        }
        else if(verb === "pcieslot")
        {
            const port = cpu.devices.pcie_root_ports[+argument];
            const read = (offset, size) => cpu.devices.pci.function_read(port.pci_id, offset, size).toString(16);
            event("pcie-slot", {port: +argument, card: port.card, slot_control: read(0x58, 2), slot_status: read(0x5A, 2),
                link_status: read(0x52, 2), msi_control: read(0x82, 2), command: read(0x04, 2)});
        }
        else if(verb === "trace") { cpu.wm.exports.x64_user_trace_enable(argument !== "off"); trace_seen = 0; }
        else if(verb === "launch")
        {
            if(!launcher_ready) event("launcher-missing");
            cpu.devices.vmware.guestinfo.set("v86.run", ++launch_serial + " " + argument);
        }
        else if(verb === "svgashaders")
        {
            // the legacy (GB) shaders' bytecode, as "svga3d-shader" events
            const svga = cpu.devices.graphics_adapter && cpu.devices.graphics_adapter.device["svga"];
            for(const [shid, sh] of svga && svga.svga3d ? svga.svga3d.gb_shaders : [])
            {
                const code = sh.code ? new Uint32Array(sh.code.buffer, sh.code.byteOffset, sh.code.byteLength >> 2) : [];
                event("svga3d-shader", {shid, type: sh.type, code: Array.from(code, v => (v >>> 0).toString(16)).join(" ")});
            }
        }
        else if(verb === "dxshaders")
        {
            // the DX shaders' tokens as they are bound, as "dx-shader" events
            const svga = cpu.devices.graphics_adapter && cpu.devices.graphics_adapter.device["svga"];
            if(svga && svga.svga3d) svga.svga3d.shader_log = argument === "off" ? null : (shid, type, bytes) => {
                const code = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
                event("dx-shader", {shid, type, code: Array.from(code, v => (v >>> 0).toString(16)).join(" ")});
            };
        }
        else if(verb === "svgalog")
        {
            const svga = cpu.devices.graphics_adapter && cpu.devices.graphics_adapter.device["svga"];
            const quiet = new Set([1094, 1098, 1119, 1126, 1127, 1135]);
            // "svgalog 1101,1267": only those commands (any range)
            const only = /^\d+(,\d+)*$/.test(argument) ? new Set(argument.split(",").map(Number)) : null;
            if(svga && svga.svga3d) svga.svga3d.command_log = argument === "off" ? null : (id, p) => {
                if(only ? !only.has(id) : id >= 1143 && id < 1300 || quiet.has(id)) return;
                event("svga3d-command", {id, n: p.length, body: Array.from(p.subarray(0, 24), v => (v >>> 0).toString(16)).join(" ")});
            };
        }
        else if(verb === "wait")
        {
            // (the main loop is not running: keep watching the screen, and
            // take commands from command.txt)
            for(const limit = performance.now() + 1000 * +argument; performance.now() < limit;)
            {
                await delay(2000);
                if(execution_error) throw execution_error;
                screenshot(false);
                observe_svga();
                const file = path.join(out, "command.txt");
                if(fs.existsSync(file))
                {
                    const lines = fs.readFileSync(file, "utf8").split("\n").map(line => line.trim()).filter(Boolean);
                    fs.unlinkSync(file);
                    for(const next of lines) await command(next);
                }
            }
        }
    };
    let idle_at = 0, idle_sent = false, next_host_window = 0;
    let load32_at = 0, load32_sent = false;
    while(performance.now() < deadline)
    {
        await delay(200);
        if(execution_error) throw execution_error;
        const command_file = path.join(out, "command.txt");
        if(fs.existsSync(command_file))
        {
            const lines = fs.readFileSync(command_file, "utf8").split("\n").map(line => line.trim()).filter(Boolean);
            fs.unlinkSync(command_file);
            for(const line of lines) await command(line);
        }
        poll_user_trace();
        observe_svga();
        // WIN_RATES: the SVGA3D commands per second since the last time;
        // the guest's MIPS, how often its core was halted (sampled each
        // loop) and the renderer's backlog (batches sent, not yet done)
        const svga_rates = cpu.devices.graphics_adapter && cpu.devices.graphics_adapter.device["svga"];
        if(+process.env.WIN_RATES && svga_rates && svga_rates.svga3d)
        {
            const s3 = svga_rates.svga3d, cores_now = cpu.get_diagnostics().cores, core = cores_now[0];
            rate_samples.n++;
            if(core.halted) rate_samples.halted++;
            rate_samples.backlog += s3.submitted - s3.completed;
            if(s3.completions.length) rate_samples.waiting++;
            if(performance.now() >= next_rates)
            {
                const now = performance.now(), counts = {...s3.counts}, seconds = (now - rates_at) / 1000;
                const retired = cores_now.reduce((sum, c) => sum + Number(c.retired_instructions), 0);
                if(rates_counts)
                {
                    const rates = Object.entries(counts).map(([id, n]) => [id, (n - (rates_counts[id] || 0)) / seconds]).filter(r => r[1] > 0)
                        .sort((a, b) => b[1] - a[1]).slice(0, 16).map(([id, r]) => [+id, +r.toFixed(2)]);
                    const frames = ((counts[1127] || 0) - (rates_counts[1127] || 0)) / seconds;
                    event("svga3d-rates", {s: +seconds.toFixed(1), frames: +frames.toFixed(2), mips: +((retired - rates_retired) / seconds / 1e6).toFixed(1),
                        halted: +(rate_samples.halted / rate_samples.n).toFixed(2), completions_pending: +(rate_samples.waiting / rate_samples.n).toFixed(2),
                        backlog: +(rate_samples.backlog / rate_samples.n).toFixed(1), rates});
                }
                rates_counts = counts;
                rates_retired = retired;
                rates_at = now;
                rate_samples = {n: 0, halted: 0, backlog: 0, waiting: 0};
                next_rates = now + 1000 * +process.env.WIN_RATES;
            }
        }
        if(profiler && performance.now() >= next_profile)
        {
            next_profile = performance.now() + 1000 * +process.env.WIN_CPU_PROFILE;
            await profile_window();
        }
        const text = text_screen();
        if(text && text !== text_seen) { text_seen = text; event("text", {text}); }
        // (WIN_SHOT_MS: how often; a screenshot of 1280x1024 costs the host a few per cent at 2 s)
        if(performance.now() >= next_shot)
        {
            next_shot = performance.now() + +(process.env.WIN_SHOT_MS || 2000);
            screenshot(false);
        }
        if(cpu.last_reset && cpu.last_reset.count !== resets)
        {
            resets = cpu.last_reset.count;
            event("reset", cpu.last_reset);
        }
        sample_rip();
        if(cpu.cr[4] & 1 << 5) { const cr3 = current_cr3(); seen_cr3.delete(cr3); seen_cr3.add(cr3); }
        if(performance.now() >= next_samples)
        {
            next_samples = performance.now() + 60000;
            const top = [...rip_samples].sort((a, b) => b[1] - a[1]).slice(0, 12);
            console.log("X64_WIN_RIPS " + JSON.stringify(top));
            // the code around the three most sampled RIPs (16 bytes before, 16 from)
            console.log("X64_WIN_RIP_BYTES " + JSON.stringify(top.slice(0, 3).map(([key]) => [key, rip_bytes(key)])));
            // the samples by guest module (image name and the offset of the hottest RIP in it)
            const modules = new Map();
            for(const [key, n] of rip_samples)
            {
                const rip = rip_raw.get(key);
                let name = "?";
                try { const m = rip === undefined ? null : guest_module(rip); name = m ? m.replace(/\+0x[0-9a-f]+$/, "") : key.startsWith("nt+") ? "nt" : "?"; } catch(e) {}
                modules.set(name, (modules.get(name) || 0) + n);
            }
            console.log("X64_WIN_RIP_MODULES " + JSON.stringify([...modules].sort((a, b) => b[1] - a[1]).slice(0, 16)));
            rip_raw.clear();
            if(port_counts.size)
            {
                console.log("X64_WIN_PORTS " + JSON.stringify([...port_counts].sort((a, b) => b[1] - a[1]).slice(0, 16)));
                port_counts.clear();
            }
            rip_samples.clear();
            if(process.env.WIN_STEP_PROFILE)
            {
                // interpreter steps inside page functions, by opcode (see pages.rs)
                const get = cpu.wm.exports.x64_page_profile_get;
                const name = key => (key & 0x10000 ? "rep " : "") + ["", "0F ", "0F38 ", "0F3A "][key >> 8 & 3] + (key & 0xFF).toString(16).padStart(2, "0");
                const rows = [];
                for(let key = 0; key < 0x20000; key++) { const n = get(key); if(n) rows.push([n, key]); }
                rows.sort((a, b) => b[0] - a[0]);
                console.log("X64_WIN_STEPS " + rows.slice(0, 40).map(([n, key]) => `${name(key)}:${n}`).join(" "));
                // retried instructions by opcode, and why accesses were refused
                const retries = [];
                for(let key = 0; key < 0x20000; key++) { const n = get(0x20000 + key); if(n) retries.push([n, key]); }
                retries.sort((a, b) => b[0] - a[0]);
                // the most stepped instructions: where, and their bytes
                const step_rip = cpu.wm.exports.x64_page_step_rip, hot = [];
                for(let n = 0; n < 24; n++)
                {
                    const low = step_rip(n, false, false);
                    if(low < 0) break;
                    const rip = BigInt(step_rip(n, true, false)) << 32n | BigInt(low);
                    const at = physical(current_cr3(), rip);
                    hot.push({rip: "0x" + rip.toString(16), n: step_rip(n, false, true), at: guest_module(rip),
                        bytes: at === null ? null : Buffer.from(cpu.mem8.subarray(at, at + 12)).toString("hex")});
                }
                console.log("X64_WIN_STEP_RIPS " + JSON.stringify(hot));
                console.log("X64_WIN_RETRIES " + retries.slice(0, 30).map(([n, key]) => `${name(key)}:${n}`).join(" ") +
                    " refused(cross,fault,device,code)=" + [0, 1, 2, 3].map(i => get(0x40000 + i)).join(",") + " unserved_steps=" + get(0x40004) + " retries_pe_clear=" + get(0x40005) + " late_entries(call,aligned,other)=" + [6, 7, 8].map(i => get(0x40000 + i)).join(","));
            }
        }
        if(performance.now() >= next_report)
        {
            next_report = performance.now() + 15000;
            console.log("X64_WIN_PROGRESS " + JSON.stringify({s: elapsed(), screen: last_hash, dark: +dark_fraction.toFixed(2), colors, mode: last_mode, ...stats()}));
        }
        // Sign in once the graphical session has settled. Boot screens are
        // almost entirely black; the lock screen is a full-screen picture,
        // shown first as a plain colour while it loads (keys pressed then
        // are lost). Sign in once a many-coloured screen has been stable.
        if(!signed_in && last_mode && last_mode[0] >= 800 && dark_fraction < 0.6 && colors >= 12 && performance.now() - last_change > 3000 && !process.env.WIN_MANUAL)
        {
            await sign_in();
            signed_in = true;
            probe_sent = performance.now() + 60000;
        }
        if(signed_in && performance.now() > probe_sent && !process.env.WIN_MANUAL)
        {
            if(!desktop_visible())
            {
                // lock screen (sign-in lost, or locked after idling with the
                // display off), password box, or still signing in
                // (WIN_NO_PROBE: a full-screen program hides the desktop for
                // long; only a password box means the session is locked)
                if(password_box_visible() || !process.env.WIN_NO_PROBE && performance.now() - last_sign_in > 180000) await sign_in();
                probe_sent = performance.now() + 20000;
            }
            else if(!process.env.WIN_OVERLAY_SAVE && !process.env.WIN_STOP_AT_DESKTOP && !process.env.WIN_IDLE && !process.env.WIN_CPULOAD32 && !process.env.WIN_NO_PROBE)
            {
                const arch = report.results[64] ? 32 : 64;
                const started = await run_command(`cmd /c for %d in (d e f g h) do @if exist %d:\\probe${arch}.exe %d:\\probe${arch}.exe`);
                // WOW64 start-up is slow; one attempt at a time
                probe_sent = performance.now() + (started ? 600000 : 20000);
            }
        }
        for(const arch of [64, 32])
        {
            const text = result_text(`RESULT${arch}.TXT`);
            // WIN_PROBE_SNAPSHOT: once the AVX part runs (threads with their
            // YMM fingerprints), save and restore the machine in place
            if(+process.env.WIN_PROBE_SNAPSHOT && text.includes(`X64_WIN_AVX_START arch=${arch}`) && !snapshots_taken.includes(arch))
            {
                snapshots_taken.push(arch);
                await vm.stop();
                const state = await vm.save_state();
                await vm.restore_state(state);
                vm.run();
                event("probe-snapshot", {arch, bytes: state.byteLength});
            }
            const match = text.match(/X64_WIN_DONE arch=(\d+) processors=(\d+) packages=(\d+) cores=(\d+) smt_cores=(\d+) progress=(\d+) failures=(\d+) apic_ids=(\w+) high_block=(\w+) checks=([\d,]+)\r?\n/);
            if(match && !report.results[arch])
            {
                const avx = text.match(/X64_WIN_AVX arch=\d+ avx=(\d)(?: avx2=(\d) fma=(\d) threads=(\d+) steps=(\d+) faults=(\d+) xstate=(\d+) compute_bad=(\d+) bad=(\d+))?/);
                // (QueryPerformanceFrequency: the HPET's 14318180 Hz, the ACPI
                // PM timer's 3579545 Hz, else the TSC; docs/jit-unification-plan.md
                // open question 4)
                const qpf = text.match(/X64_WIN_BEGIN arch=\d+ processors=\d+ architecture=\d+ qpf=(\w+)/);
                report.results[arch] = {qpf: qpf ? parseInt(qpf[1], 16) : null,
                    qpc_source: qpf ? {14318180: "hpet", 3579545: "acpi-pm-timer"}[parseInt(qpf[1], 16)] ?? "tsc" : null,
                    processors: +match[2], packages: +match[3], cores: +match[4], smt_cores: +match[5],
                    progress: +match[6], failures: +match[7], apic_ids: match[8], high_block: match[9],
                    avx: avx && (avx[2] === undefined ? {avx: 0} : {avx: 1, avx2: +avx[2], fma: +avx[3], threads: +avx[4], steps: +avx[5],
                        faults: +avx[6], xstate: +avx[7], compute_bad: +avx[8], bad: +avx[9]}), text};
                event("probe", {arch, result: report.results[arch]});
                probe_sent = performance.now() + 2000;
            }
        }
        if(report.results[64] && report.results[32]) break;
        if(signed_in && !report.desktop_s && desktop_visible())
        {
            report.desktop_s = elapsed();
            event("desktop");
            // (tools/bench/jit_stats.mjs, docs/jit-unification-plan.md P0.7)
            if(jit_stats_enabled()) print_jit_stats(vm, {script: "windows_boot", phase: "desktop", wasm: process.env.WASM_PATH || null, desktop_s: report.desktop_s, cores});
            for(let attempt = 0; process.env.WIN_LAUNCHER && !launcher_ready && attempt < 4; attempt++)
            {
                if(process.env.WIN_LAUNCHER_ADMIN) await run_admin(process.env.WIN_LAUNCHER);
                else await run_command(process.env.WIN_LAUNCHER);
                for(const limit = performance.now() + 60000; performance.now() < limit && !launcher_ready;) await delay(500);
                event(launcher_ready ? "launcher" : "launcher-retry");
            }
            // WIN_SETUP: commands separated by ";;" once the desktop shows
            // (e.g. "runadmin E:\\INSTVM3D.CMD;;wait 300;;shot"), before
            // WIN_OVERLAY_SAVE shuts down and keeps what they did
            for(const line of (process.env.WIN_SETUP || "").split(";;").map(line => line.trim()).filter(Boolean))
            {
                await command(line);
            }
            if(process.env.WIN_SETUP && !process.env.WIN_OVERLAY_SAVE) break;
            if(process.env.WIN_OVERLAY_SAVE) shutdown_at = performance.now() + 30000;
            else if(process.env.WIN_IDLE) idle_at = performance.now() + 1000 * +(process.env.WIN_IDLE_SETTLE_S || 20);
            else if(process.env.WIN_CPULOAD32) load32_at = performance.now() + 1000 * +(process.env.WIN_IDLE_SETTLE_S || 20);
            else if(process.env.WIN_DESKTOP_TEST)
            {
                // desktop responsiveness: open programs one after another
                // (Win+R latency each time), screenshots after each
                await delay(15000);
                for(const program of ["notepad", "calc", "control", "explorer", "notepad"])
                {
                    await run_command(program);
                    await delay(12000);
                    screenshot(true);
                }
                break;
            }
            else if(process.env.WIN_STOP_AT_DESKTOP) break;
        }
        if(idle_at && performance.now() >= idle_at && !idle_sent)
        {
            host_window();
            next_host_window = performance.now() + 10000;
            idle_sent = await run_command(`cmd /c for %d in (d e f g h) do @if exist %d:\\cpuload.exe %d:\\cpuload.exe ${+process.env.WIN_IDLE_ROUNDS || 6}`);
            if(!idle_sent) idle_at = performance.now() + 20000;
        }
        if(load32_at && performance.now() >= load32_at && !load32_sent)
        {
            load32_sent = await run_command(`cmd /c for %d in (d e f g h) do @if exist %d:\\load32.exe %d:\\load32.exe ${+process.env.WIN_CPULOAD32 || 5}`);
            if(!load32_sent) load32_at = performance.now() + 20000;
        }
        if(load32_sent)
        {
            const load = result_text("LOAD32.TXT");
            if(load.includes("CPULOAD32_DONE"))
            {
                const rounds = [...load.matchAll(/round (\d+) ms=(\d+) checksum=([0-9a-f]+)/g)].map(m => ({ms: +m[2], checksum: m[3]}));
                // (the median and the fastest leave out the first round, which
                // also compiles; the fastest is what the gate compares: a
                // fresh desktop's background work slows other rounds)
                const warm = rounds.slice(1).map(r => r.ms).sort((a, b) => a - b);
                report.cpuload32 = {wow64: /wow64=1/.test(load), rounds, median_ms: warm[warm.length >> 1] ?? rounds[0]?.ms, min_ms: warm[0] ?? rounds[0]?.ms};
                console.log("X64_WIN_CPULOAD32 " + JSON.stringify(report.cpuload32));
                break;
            }
        }
        if(idle_sent && performance.now() >= next_host_window)
        {
            host_window();
            next_host_window += 10000;
        }
        if(idle_sent)
        {
            const load = result_text("CPULOAD.TXT");
            if(load.includes("CPULOAD_DONE"))
            {
                report.cpuload = load;
                console.log(load);
                break;
            }
        }
        // WIN_OVERLAY_SAVE: after the desktop has settled, a full (not
        // hybrid) shutdown; the overlay is saved once the guest is off
        if(shutdown_at && performance.now() >= shutdown_at && !shutdown_sent)
        {
            shutdown_sent = await run_command(process.env.WIN_SHUTDOWN_COMMAND || "shutdown /s /t 0");
            if(!shutdown_sent) shutdown_at = performance.now() + 20000;
            else shutdown_deadline = performance.now() + 900000;
        }
        if(shutdown_sent && powered_off)
        {
            event("power-off", {state: powered_off});
            save_overlay(process.env.WIN_OVERLAY_SAVE);
            event("overlay-saved", {sectors: source.overlay.size});
            break;
        }
        assert.ok(!shutdown_deadline || performance.now() < shutdown_deadline, "the guest powered off");
    }
    // (the probes run in plain qualification runs, not in setup sessions)
    for(const arch of process.env.WIN_STOP_AT_DESKTOP || process.env.WIN_IDLE || process.env.WIN_CPULOAD32 || process.env.WIN_SETUP || process.env.WIN_HDB ? [] : [64, 32])
    {
        const r = report.results[arch];
        assert.ok(r, `probe ${arch} completed`);
        assert.equal(r.failures, 0, `probe ${arch} failures`);
        assert.equal(r.processors, cores);
        assert.equal(r.packages, 1); assert.equal(r.cores, cores); assert.equal(r.smt_cores, 0);
        assert.equal(r.progress, cores * 64);
        if(arch === 64) assert.ok(BigInt("0x" + r.high_block) >> 32n > 0n, "x64 top-down allocation above 4 GiB");
        // the YMM state (docs/simd-xsave-plan.md 11.3): 8 rounds of 3 steps
        // (one migrates, one faults) on 2N threads; x64 GetThreadContext
        const features = win_cpu_features || [];
        assert.ok(r.avx, `probe ${arch}: AVX line`);
        if(features.includes("AVX"))
        {
            assert.deepEqual(r.avx, {avx: 1, avx2: +features.includes("AVX2"), fma: +features.includes("FMA"), threads: 2 * cores,
                steps: 48 * cores, faults: 16 * cores, xstate: arch === 64 ? 1 : 0, compute_bad: 0, bad: 0}, `probe ${arch}: YMM state`);
            if(+process.env.WIN_PROBE_SNAPSHOT) assert.ok(snapshots_taken.includes(arch), `probe ${arch}: snapshot during the AVX part`);
        }
        else assert.equal(r.avx.avx, 0, `probe ${arch}: no AVX without the feature`);
    }
    if(process.env.WIN_STOP_AT_DESKTOP) assert.ok(report.desktop_s, "desktop reached");
    if(process.env.WIN_IDLE) assert.ok(report.cpuload, "CPULOAD.EXE completed");
    if(process.env.WIN_CPULOAD32) assert.ok(report.cpuload32?.wow64 && report.cpuload32.rounds.length, "LOAD32.EXE (CPULOAD32) completed under WOW64");
    report.passed = true;
    console.log("X64_WIN_PASS " + JSON.stringify(report.results));
}
catch(error)
{
    report.passed = false;
    report.error = String(error?.stack || error);
    console.error("X64_WIN_FAILURE " + report.error);
    process.exitCode = 1;
}
finally
{
    if(remote_renderer)
    {
        console.log("X64_WIN_RENDERER " + JSON.stringify(remote_renderer.stats));
        remote_renderer.close();
    }
    if(profiler) await profile_window();
    if(cpu && jit_stats_enabled()) print_jit_stats(vm, {script: "windows_boot", phase: "end", s: elapsed(), wasm: process.env.WASM_PATH || null, desktop_s: report.desktop_s ?? null, cores});
    if(cpu && process.env.WIN_SIZE_STATS) cpu.wm.exports.x64_pagegen_size_dump();
    if(cpu && process.env.WIN_RECORD)
    {
        const e = cpu.wm.exports, chunks = [];
        for(let i = 0, n = e.x64_page_record_count(); i < n; i++)
        {
            const length = Buffer.alloc(4);
            length.writeUInt32LE(e.x64_page_record_length(i));
            chunks.push(length, Buffer.from(new Uint8Array(cpu.wasm_memory.buffer, e.x64_page_record_address(i) >>> 0, e.x64_page_record_length(i))));
        }
        fs.writeFileSync(process.env.WIN_RECORD, Buffer.concat(chunks));
        console.log(`X64_WIN_RECORD ${chunks.length / 2} records`);
    }
    // WIN_DUMP_OVERLAY=<file>: the sectors written so far (no shutdown: what
    // the guest had flushed), e.g. to read setupapi.dev.log
    if(process.env.WIN_DUMP_OVERLAY) save_overlay(process.env.WIN_DUMP_OVERLAY);
    // WIN_DUMP_IMAGES=ci,ntkrnlmp: those guest modules (named as in
    // modules.json) as mapped in memory, to <out>/<name>@<base>.bin
    for(const name of cpu ? (process.env.WIN_DUMP_IMAGES || "").split(",").filter(Boolean) : [])
    {
        const entry = Object.entries(page_modules).find(([, where]) => where && where.split("+")[0] === name);
        if(!entry) continue;
        const base = BigInt("0x" + entry[0]) - BigInt(entry[1].split("+")[1]);
        const cr3 = current_cr3(), at = physical(cr3, base);
        if(at === null) continue;
        const pe = base + BigInt(cpu.mem8[at + 0x3C] | cpu.mem8[at + 0x3D] << 8);
        const size_at = physical(cr3, pe + 24n + 56n);
        const size = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset + size_at, 4).getUint32(0, true);
        const image = Buffer.alloc(size);
        for(let offset = 0; offset < size; offset += 4096)
        {
            const page = physical(cr3, base + BigInt(offset));
            if(page !== null) image.set(cpu.mem8.subarray(page, page + Math.min(4096, size - offset)), offset);
        }
        fs.writeFileSync(path.join(out, `${name}@${base.toString(16)}.bin`), image);
    }
    if(cpu) { report.final = stats(); screenshot(true); report.text_screen = text_screen(); }
    await vm.stop();
    const final_stat = fs.statSync(image_path);
    assert.equal(final_stat.mtimeMs, source_stat.mtimeMs, "the source image was never written");
    if(hdb_path) assert.equal(fs.statSync(hdb_path).mtimeMs, hdb_stat.mtimeMs, "the second disk's image was never written");
    report.wall_s = elapsed();
    fs.writeFileSync(path.join(out, `result-${jit ? "page" : "interpreter"}-${cores}c${report.parallel ? "-parallel" : ""}.json`),
        JSON.stringify(report, null, 1));
    fs.writeFileSync(path.join(out, "tools-final.img"), tools.bytes);
    await vm.destroy();
    source.close();
    if(hdb_path) hdb.close();
}
