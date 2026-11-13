// Real-driver G0 investigation, shared by XP and Win98. Images are opened O_RDONLY.
// Never treats an absent probe, installer failure or stalled guest as acceptance.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { serialize, deserialize } from "node:v8";
import { MemoryDisk, ReadOnlyOverlayDisk, read_fat16 } from "../smp/disk_fixture.mjs";
import { make_esp } from "../lib/fat.mjs";
import { PictureSink, save_png } from "../lib/picture_sink.mjs";
import { site_directory } from "../lib/site.mjs";
import { V86 } from "../../src/main.js";

// A canvas clips transient layers during VGA mode switches. Keep the headless
// screenshot sink equally bounded when an old layer arrives after a resize.
class ProbeSink extends PictureSink
{
    update_buffer(layers)
    {
        for(const l of layers) for(let y = 0; y < l.buffer_height; y++)
        {
            const sy = l.buffer_y + y, dy = l.screen_y + y;
            if(sy < 0 || sy >= l.pixels.height || dy < 0 || dy >= this.height) continue;
            const left = Math.max(0, -l.screen_x, -l.buffer_x);
            const right = Math.min(l.buffer_width, this.width - l.screen_x, l.pixels.width - l.buffer_x);
            if(right <= left) continue;
            const from = (sy * l.pixels.width + l.buffer_x + left) * 4;
            const to = (dy * this.width + l.screen_x + left) * 4;
            this.rgba.set(l.pixels.data.subarray(from, from + (right - left) * 4), to);
        }
    }
}

// Warm diagnostic snapshots reserve a fixed-size executable. Replace only its
// data clusters while the CPU is stopped; FAT/directory geometry stays intact.
function replace_probe(bytes, replacement)
{
    const old = read_fat16(bytes, "NVPROBE.EXE");
    assert.equal(old?.length, 65536, "probe replacement needs a snapshot made with a reserved 64 KiB executable");
    const view = new DataView(bytes.buffer, bytes.byteOffset), word = at => view.getUint16(at, true);
    const boot = view.getUint32(454, true) * 512, cluster_bytes = bytes[boot + 13] * 512;
    const fat = boot + word(boot + 14) * 512, root = fat + bytes[boot + 16] * word(boot + 22) * 512;
    const data = root + Math.ceil(word(boot + 17) * 32 / 512) * 512;
    let entry = root;
    for(; entry < data; entry += 32) if(Buffer.from(bytes.subarray(entry, entry + 11)).toString("ascii") === "NVPROBE EXE") break;
    assert(entry < data);
    let cluster = word(entry + 26), offset = 0;
    while(offset < replacement.length)
    {
        assert(cluster >= 2 && cluster < 0xFFF8);
        const count = Math.min(cluster_bytes, replacement.length - offset);
        bytes.set(replacement.subarray(offset, offset + count), data + (cluster - 2) * cluster_bytes);
        offset += count; cluster = word(fat + cluster * 2);
    }
}

export async function run_geforce_guest(win98)
{
    const root = new URL("../../", import.meta.url).pathname;
    const image = process.env[win98 ? "W98_IMAGE" : "XP_IMAGE"] || path.join(site_directory(root),
        win98 ? "windows98/windows98hdd.img" : "windowsxp/windowsxp_multidisk_C_4G.img");
    const out = path.resolve(process.env.NV_OUT || path.join(root, "build/nv40-" + (win98 ? "win98" : "xp")));
    fs.mkdirSync(out, { recursive: true });
    // NV_DRIVER may name either an installer or its extracted directory.
    const driver = path.resolve(process.env.NV_DRIVER || path.join(root, "build/nv40-fixtures", win98 ?
        "81.98_forceware_win9x_english.exe" : "93.71_forceware_winxp2k_english_whql.exe"));
    const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr || String(r.error)); return r; };
    const driver_dir = path.join(out, "driver");
    if(fs.statSync(driver).isFile())
    {
        fs.mkdirSync(driver_dir, { recursive: true });
        run("bsdtar", ["-xf", driver, "-C", driver_dir]);
    }
    const source = fs.statSync(driver).isDirectory() ? driver : driver_dir;
    const expected = fs.readdirSync(source).filter(n => /\.inf$/i.test(n)).flatMap(n =>
        Array.from(fs.readFileSync(path.join(source, n), "latin1").matchAll(/^([a-z0-9_]+\.[a-z0-9]{3})\s*=/gim), m => m[1]));
    const sevenzip = process.env.SEVENZIP || (fs.existsSync("/opt/homebrew/opt/sevenzip/bin/7zz") ? "/opt/homebrew/opt/sevenzip/bin/7zz" : "7z");
    const files = {};
    if(win98)
    {
        const iso = process.env.NV_WIN98_ISO || path.join(site_directory(root), "windows98/windows98se.iso");
        const cabs = path.join(out, "windows98-cabs"), pci = path.join(out, "pci");
        fs.mkdirSync(cabs, { recursive: true }); fs.mkdirSync(pci, { recursive: true });
        run(sevenzip, ["e", "-y", "-o" + cabs, iso, "win98/*.CAB"]);
        run(sevenzip, ["e", "-y", "-o" + pci, path.join(cabs, "BASE4.CAB"), "pci.vxd", "pcimp.pci"]);
        for(const name of ["pci.vxd", "pcimp.pci"]) files["PCIBUS/" + name] = fs.readFileSync(path.join(pci, name));
    }
    for(const entry of fs.readdirSync(source))
    {
        if(!fs.statSync(path.join(source, entry)).isFile()) continue;
        if(entry.endsWith("_"))
        {
            const unpack = path.join(out, "expanded", entry);
            fs.mkdirSync(unpack, { recursive: true });
            run(sevenzip, ["x", "-y", "-o" + unpack, path.join(source, entry)]);
            for(const name of fs.readdirSync(unpack))
            {
                // SZDD archives can omit the last extension letter (7z reports
                // NVCPL.HL for NVCPL.HL_); the unmodified INF supplies the name.
                const destination = expected.find(n => n.slice(0, -1).toUpperCase() === entry.slice(0, -1).toUpperCase()) || name;
                files["DRIVER/" + destination] = fs.readFileSync(path.join(unpack, name));
            }
        }
        else if(!/\.(cab|hdr|bmp|skin|ibt|iss|inx|bin)$/i.test(entry)) files["DRIVER/" + entry] = fs.readFileSync(path.join(source, entry));
    }
    const binary = path.join(out, "NVPROBE.EXE");
    run("i686-w64-mingw32-gcc", ["-Os", "-nostdlib", "-fno-builtin", "-fno-stack-protector", "-mno-stack-arg-probe",
        "-Wl,--entry,_entry@0", "-Wl,--subsystem,console", ...(win98 ? ["-DNV_WIN98"] : []),
        ...(process.env.NV_MODE_TEST ? ["-DNV_MODE_TEST"] : []),
        ...(process.env.NV_SKIP_INSTALL ? ["-DNV_SKIP_INSTALL"] : []),
        ...(process.env.NV_REBOOT ? ["-DNV_REBOOT"] : []), "-o", binary,
        ...(process.env.NV_PROBE_ID ? ["-DNV_PROBE_ID=" + Number(process.env.NV_PROBE_ID)] : []),
        ...(process.env.NV_GDI_TEST ? ["-DNV_GDI_TEST"] : []),
        ...(process.env.NV_DDRAW_TEST ? ["-DNV_DDRAW_TEST"] : []),
        ...(process.env.NV_GDI_TEST || process.env.NV_DDRAW_TEST ? [path.join(root, "tests/devices/geforce_draw.c")] : []),
        path.join(root, "tests/devices/geforce_probe.c"), "-lkernel32", "-luser32", "-lsetupapi", "-ladvapi32", "-lgdi32", "-ldxguid"]);
    const probe = new Uint8Array(65536), executable = fs.readFileSync(binary);
    assert(executable.length <= probe.length); probe.set(executable);
    files["NVPROBE.EXE"] = probe;
    const tools_bytes = make_esp(files, 120);
    tools_bytes[450] = 0x0E; // normal FAT16, visible to Win9x/XP rather than an ESP
    new DataView(tools_bytes.buffer).setUint32(440, 0x4E563430, true);
    const tools = new MemoryDisk(tools_bytes), before = fs.statSync(image), disk = new ReadOnlyOverlayDisk(image);
    if(process.env.NV_OVERLAY_LOAD) disk.set_state(deserialize(fs.readFileSync(process.env.NV_OVERLAY_LOAD)));
    const sink = new ProbeSink();
    const vm = new V86({ graphics_adapter: "geforce_6800", vram_size: 128 << 20,
        bios: { url: root + "bios/seabios.bin" },
        ...(process.env.NV_ROM ? { vga_bios: { url: path.resolve(process.env.NV_ROM) } } : {}),
        hda: disk, hdb: tools, boot_order: 0x213, memory_size: (win98 ? 256 : 1024) << 20,
        ...(win98 ? { cdrom: { url: process.env.NV_WIN98_ISO || path.join(site_directory(root), "windows98/windows98se.iso"), async: true }, boot_order: 0x132 } : {}),
        screen_adapter: sink, acpi: false, net_device: { type: "none" }, disable_speaker: true,
        autostart: !process.env.NV_STATE_LOAD, log_level: 0 });
    const seconds = Number(process.env.NV_SECONDS || 360);
    const launch = Number(process.env.NV_LAUNCH_SECONDS || (process.env.NV_STATE_LOAD ? 10 : 90));
    assert(Number.isFinite(seconds) && seconds > 0 && seconds <= 3600);
    let nv, error = null, launches = 0, next_launch = launch, cancelled = false, checkpoint = false;
    const cancel = () => { cancelled = true; };
    process.on("SIGINT", cancel);
    vm.add_listener("emulator-error", e => { error = String(e); });
    const started = performance.now(), elapsed = () => (performance.now() - started) / 1000;
    let control_time = 0, next_report = 30, reboot_seen = false;
    const result_text = () => Buffer.from(read_fat16(tools.bytes, "NV.TXT") || []).toString("ascii");
    const trace_report = () => ({ ...nv.trace.report(),
        registers: Array.from(nv.registers, ([offset, value]) => [offset.toString(16), value >>> 0]),
        pci: Array.from(nv.machine.pci_config()),
        display: { crtc: Array.from(nv.display.crtc), front: nv.display.front, mode: nv.display.mode() },
        graph: nv.graph.get_state(), graphFaults: nv.graph.faults, fifo: nv.fifo.get_state() });
    try
    {
        await new Promise((resolve, reject) => { vm.add_listener("emulator-ready", resolve); vm.add_listener("emulator-error", reject); });
        if(process.env.NV_STATE_LOAD)
        {
            await vm.restore_state(fs.readFileSync(process.env.NV_STATE_LOAD));
            if(process.env.NV_PROBE_REPLACE) replace_probe(tools.bytes, probe);
            await vm.run();
        }
        const cpu = vm.v86.cpu;
        nv = cpu.devices.graphics_adapter.device["nv"];
        nv.trace.enabled = true;
        for(; elapsed() < seconds && !error && !cancelled;)
        {
            await delay(1000);
            cpu.devices.display.request_frame(true);
            if(!reboot_seen && result_text().includes("REBOOT_REQUEST"))
            {
                reboot_seen = true; launches = 0; next_launch = elapsed() + 100;
            }
            if(process.env.NV_CONTROL && fs.existsSync(process.env.NV_CONTROL))
            {
                const modified = fs.statSync(process.env.NV_CONTROL).mtimeMs;
                if(modified > control_time)
                {
                    control_time = modified;
                    const input = fs.readFileSync(process.env.NV_CONTROL, "utf8").trim();
                    const command = input.startsWith("{") ? JSON.parse(input) : { run: input };
                    if(command.keys) await vm.keyboard_send_scancodes(command.keys, 30);
                    if(command.run)
                    {
                        await vm.keyboard_send_scancodes([0xE0, 0x5B, 0x13, 0x93, 0xE0, 0xDB], 30);
                        await delay(1000);
                        await vm.keyboard_send_text(command.run, 30);
                        await vm.keyboard_send_scancodes([28, 156], 30);
                    }
                }
            }
            if(process.env.NV_STATE_SAVE && !checkpoint && process.env.NV_STATE_SAVE_AT &&
                elapsed() >= Number(process.env.NV_STATE_SAVE_AT))
            {
                await vm.stop();
                fs.writeFileSync(process.env.NV_STATE_SAVE, new Uint8Array(await vm.save_state()));
                checkpoint = true;
                await vm.run();
            }
            if(!process.env.NV_HOLD && launches < 3 && elapsed() >= next_launch && (!result_text() || reboot_seen))
            {
                launches++; next_launch = elapsed() + 45;
                for(let i = 0; i < 3; i++) { await vm.keyboard_send_scancodes([1, 129], 30); await delay(500); }
                await vm.keyboard_send_scancodes([0xE0, 0x5B, 0x13, 0x93, 0xE0, 0xDB], 30); await delay(1500);
                if(win98) await vm.keyboard_send_text("d:\\nvprobe.exe", 30);
                else await vm.keyboard_send_text("cmd /c for %d in (d e f g h i j k) do @if exist %d:\\nvprobe.exe %d:\\nvprobe.exe", 30);
                await vm.keyboard_send_scancodes([28, 156], 30);
            }
            if(elapsed() >= next_report)
            {
                next_report = elapsed() + 30;
                console.log("NV40", win98 ? "98" : "XP", Math.floor(elapsed()), "s", result_text().trim(), "registers", nv.trace.counts.size);
                save_png(sink, out, "progress");
                fs.writeFileSync(path.join(out, "progress-trace.json"), JSON.stringify(trace_report()));
            }
            if(!process.env.NV_HOLD && result_text().includes("END\r\n"))
            {
                await delay(Number(process.env.NV_GRACE_SECONDS || 5) * 1000);
                cpu.devices.display.request_frame(true);
                await delay(100);
                break;
            }
        }
    }
    catch(e) { error = e.stack || String(e); }
    finally
    {
        await vm.stop();
        if(process.env.NV_STATE_SAVE && !checkpoint)
            fs.writeFileSync(process.env.NV_STATE_SAVE, new Uint8Array(await vm.save_state()));
        if(nv)
        {
            fs.writeFileSync(path.join(out, "trace.json"), JSON.stringify(trace_report(), null, 2) + "\n");
            fs.writeFileSync(path.join(out, "ramin.bin"), nv.vram().subarray(nv.vram_size - (1 << 20)));
        }
        save_png(sink, out, "final");
        fs.writeFileSync(path.join(out, "screen.txt"), sink.text.join("\n"));
        for(const name of ["MACHINE.INF"])
        {
            const bytes = read_fat16(tools.bytes, name);
            if(bytes) fs.writeFileSync(path.join(out, name), bytes);
        }
        if(process.env.NV_OVERLAY_SAVE) fs.writeFileSync(process.env.NV_OVERLAY_SAVE, serialize(disk.get_state()));
        await vm.destroy(); disk.close();
        process.off("SIGINT", cancel);
        assert.equal(fs.statSync(image).mtimeMs, before.mtimeMs);
        assert.equal(fs.statSync(image).size, before.size);
    }
    const text = result_text();
    // A successful install API alone is insufficient: the device must be started by nv.
    const initialized = win98 ? /DEVICE .* problem=0 cm=0 started=1 .*driver=\S+ description=NVIDIA GeForce 6800/m.test(text) :
        /DEVICE .* problem=0 cm=0 started=1 service=nv(?:\s|$)/m.test(text);
    const result = { status: initialized ? "INITIALIZED" : "BLOCKED", seconds: Math.round(elapsed()),
        guest: win98 ? "win98" : "xp", driver, rom: process.env.NV_ROM || "v86 G0 SeaVGABIOS",
        error, probe: text, trace: "trace.json", imageUnchanged: true,
        reason: initialized ? "FIFO-channel creation still needs trace review" : text ? "driver install/initialization did not complete" : "guest probe did not start" };
    fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
    if(!initialized) process.exitCode = 1;
    return result;
}
