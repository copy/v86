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
import { read_fat32_file } from "../lib/fat32_reader.mjs";
const release_build = !!+process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(release_build ? "../../build/libv86.mjs" : "../../src/main.js");

// A canvas clips transient layers during VGA mode switches. Keep the headless
// screenshot sink equally bounded when an old layer arrives after a resize.
class ProbeSink extends PictureSink
{
    constructor() { super(); this.transitions = []; }
    set_size_graphical(width, height)
    {
        super.set_size_graphical(width, height);
        const last = this.transitions[this.transitions.length - 1];
        if(!last || last[0] !== width || last[1] !== height)
        {
            if(this.transitions.length === 256) this.transitions.shift();
            this.transitions.push([width, height]);
        }
    }

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

// Legacy Win9x can lose the immediate make/break pairs from simulate_char
// while opening Run under load. Hold each scan code through a normal delay,
// like the manual keyboard controls, including separate Shift transitions.
function run_scancodes(text)
{
    const keys=new Map();
    for(const [row,start]of [["1234567890-=",2],["qwertyuiop[]",16],["asdfghjkl;'",30],
        ["`",41],["\\",43],["zxcvbnm,./",44],[" ",57]])
        Array.from(row).forEach((character,index)=>keys.set(character,start+index));
    const shifted="!@#$%^&*()_+{}:\"~|<>?",plain="1234567890-=[];'`\\,./",result=[];
    for(const character of text)
    {
        const index=shifted.indexOf(character),base=index<0?character.toLowerCase():plain[index];
        const shift=index>=0 || character!==base,key=keys.get(base);
        assert(key!==undefined,"Run commands require US keyboard ASCII: "+character);
        if(shift)result.push(42);
        result.push(key,key|128);
        if(shift)result.push(170);
    }
    return result;
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
    if(process.env.NV_DX9) files["DX9.EXE"]=fs.readFileSync(process.env.NV_DX9);
    if(process.env.NV_BENCH_LAUNCH)
    {
        assert(!win98,"catalog priming launcher is an XP compatibility helper");
        const launcher=path.join(out,"NVLAUNCH.EXE");
        run("i686-w64-mingw32-gcc",["-Os","-nostdlib","-fno-builtin","-fno-stack-protector","-mno-stack-arg-probe",
            "-Wall","-Wextra","-Werror","-Wl,--entry,_entry@0","-Wl,--subsystem,console",
            path.join(root,"tests/devices/geforce_benchmark.c"),"-lkernel32","-luser32","-o",launcher]);
        files["NVLAUNCH.EXE"]=fs.readFileSync(launcher);
    }
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
    if(process.env.NV_DOS_TEST)
    {
        const dos=path.join(out,"NVDOS.COM");
        run("nasm",["-f","bin",path.join(root,"tests/devices/geforce_dos.asm"),"-o",dos]);
        files["NVDOS.COM"]=fs.readFileSync(dos);
    }
    const binary = path.join(out, "NVPROBE.EXE");
    run("i686-w64-mingw32-gcc", ["-Os", "-nostdlib", "-fno-builtin", "-fno-stack-protector", "-mno-stack-arg-probe",
        "-Wl,--entry,_entry@0", "-Wl,--subsystem,console", ...(win98 ? ["-DNV_WIN98"] : []),
        ...(process.env.NV_MODE_TEST ? ["-DNV_MODE_TEST"] : []),
        ...(process.env.NV_MODE_MATRIX ? ["-DNV_MODE_MATRIX"] : []),
        ...(process.env.NV_DOS_TEST ? ["-DNV_DOS_TEST"] : []),
        ...(process.env.NV_SKIP_INSTALL ? ["-DNV_SKIP_INSTALL"] : []),
        ...(process.env.NV_AUTOSTART ? ["-DNV_AUTOSTART"] : []),
        ...(process.env.NV_REBOOT ? ["-DNV_REBOOT"] : []), "-o", binary,
        ...(process.env.NV_PROBE_ID ? ["-DNV_PROBE_ID=" + Number(process.env.NV_PROBE_ID)] : []),
        ...(process.env.NV_GDI_TEST || process.env.NV_GDI_FONT_TEST ? ["-DNV_GDI_TEST"] : []),
        ...(process.env.NV_GDI_FONT_TEST ? ["-DNV_GDI_FONT_TEST"] : []),
        ...(process.env.NV_DDRAW_TEST ? ["-DNV_DDRAW_TEST"] : []),
        ...(process.env.NV_D3D_TEST ? ["-DNV_D3D_TEST",path.join(root,"tests/devices/geforce_d3d.c")] : []),
        ...(process.env.NV_D3D_TEXTURE_TEST ? ["-DNV_D3D_TEXTURE_TEST"] : []),
        ...(process.env.NV_DX9_INSTALL ? ["-DNV_DX9_INSTALL"] : []),
        ...(process.env.NV_GDI_TEST || process.env.NV_GDI_FONT_TEST || process.env.NV_DDRAW_TEST ? [path.join(root, "tests/devices/geforce_draw.c")] : []),
        path.join(root, "tests/devices/geforce_probe.c"), "-lkernel32", "-luser32", "-lsetupapi", "-ladvapi32", "-lgdi32"]);
    const probe = new Uint8Array(65536), executable = fs.readFileSync(process.env.NV_PROBE_BINARY || binary);
    assert(executable.length <= probe.length); probe.set(executable);
    files["NVPROBE.EXE"] = probe;
    const tools_bytes = make_esp(files, 120);
    tools_bytes[450] = 0x0E; // normal FAT16, visible to Win9x/XP rather than an ESP
    new DataView(tools_bytes.buffer).setUint32(440, 0x4E563430, true);
    const tools = new MemoryDisk(tools_bytes), before = fs.statSync(image), disk = new ReadOnlyOverlayDisk(image);
    if(process.env.NV_OVERLAY_LOAD) disk.set_state(deserialize(fs.readFileSync(process.env.NV_OVERLAY_LOAD)));
    // Keep the existing writable RAM tools disk at primary-slave. Benchmarks
    // use secondary-slave, with the same read-only host backing as the OS.
    const game_path=process.env.NV_HDB && path.resolve(process.env.NV_HDB);
    const game=game_path?new ReadOnlyOverlayDisk(game_path):null,game_before=game_path?fs.statSync(game_path):null;
    if(game && process.env.NV_GAME_OVERLAY_LOAD)game.set_state(deserialize(fs.readFileSync(process.env.NV_GAME_OVERLAY_LOAD)));
    const sink = new ProbeSink();
    let remote=null;
    if(process.env.NV_GPU_RENDERER==="chrome")
    {
        const {create_remote_renderer}=await import("../x64/gpu_remote_renderer.mjs");
        remote=await create_remote_renderer({on_log:line=>console.log("NV40 GPU:",line)});
    }
    const vram_mb=Number(process.env.NV_VRAM_MB || 128);assert([128,256].includes(vram_mb));
    const wasm_path=path.resolve(process.env.NV_WASM || path.join(root,"build",release_build?"v86.wasm":"v86-debug.wasm"));
    const vm = new V86({ ...(remote?{graphics_adapter_renderer_channel:remote.renderer}:{}), disable_jit:!!process.env.NV_DISABLE_JIT, wasm_path, graphics_adapter: "geforce_6800", vram_size: vram_mb << 20,
        bios: { url: root + "bios/seabios.bin" },
        ...(process.env.NV_ROM ? { vga_bios: { url: path.resolve(process.env.NV_ROM) } } : {}),
        hda: disk, hdb: tools, boot_order: 0x213, memory_size: (win98 ? 256 : 1024) << 20,
        ...(win98 || process.env.NV_CDROM ? { cdrom: { url: process.env.NV_CDROM || process.env.NV_WIN98_ISO || path.join(site_directory(root), "windows98/windows98se.iso"), async: true }, boot_order: 0x132 } : {}),
        screen_adapter: sink, acpi: false, net_device: { type: "none" }, disable_speaker: true,
        autostart: !process.env.NV_STATE_LOAD && !game, log_level: 0 });
    const seconds = Number(process.env.NV_SECONDS || 360);
    const launch = Number(process.env.NV_LAUNCH_SECONDS || (process.env.NV_STATE_LOAD ? 10 : 90));
    assert(Number.isFinite(seconds) && seconds > 0 && seconds <= 3600);
    let nv, error = null, launches = 0, next_launch = launch, cancelled = false, checkpoint = false, clock_start = 0;
    let profiler=null;
    const cancel = () => { cancelled = true; };
    process.on("SIGINT", cancel);
    vm.add_listener("emulator-error", e => { error = String(e); });
    const started = performance.now(), elapsed = () => (performance.now() - started) / 1000;
    let control_time = 0, next_report = 30, reboot_seen = false;
    let next_capture=0,capture_index=0;
    const capture_interval=Number(process.env.NV_CAPTURE_SECONDS || 0),capture_limit=Number(process.env.NV_CAPTURE_LIMIT || 180);
    assert(Number.isFinite(capture_interval) && capture_interval>=0 && capture_limit>0 && capture_limit<=2000);
    const control_file = process.env.NV_CONTROL || path.join(out, "control.json");
    const result_text = () => Buffer.from(read_fat16(tools.bytes, "NV.TXT") || []).toString("ascii");
    const trace_report = () => ({ ...nv.trace.report(),
        clock: {mode:vm.v86.cpu.clock.mode, elapsedMs:vm.v86.cpu.clock.now()-clock_start,
            hostElapsedMs:elapsed()*1000, ...vm.v86.cpu.clock.get_diagnostics()},
        pit: {mode:Array.from(vm.v86.cpu.devices.pit.counter_mode),enabled:Array.from(vm.v86.cpu.devices.pit.counter_enabled),
            reload:Array.from(vm.v86.cpu.devices.pit.counter_reload),startTime:Array.from(vm.v86.cpu.devices.pit.counter_start_time),
            startValue:Array.from(vm.v86.cpu.devices.pit.counter_start_value)},
        registers: Array.from(nv.registers, ([offset, value]) => [offset.toString(16), value >>> 0]),
        pci: Array.from(nv.machine.pci_config()),
        cpu: {eip: vm.v86.cpu.instruction_pointer[0] >>> 0, regs: Array.from(vm.v86.cpu.reg32), halted: vm.v86.cpu.in_hlt[0], flags:vm.v86.cpu.get_eflags(),
            segments:Array.from(vm.v86.cpu.segment_offsets),romHeader:Array.from(vm.v86.cpu.mem8.subarray(0xC0000,0xC0040)),romCode:Array.from(vm.v86.cpu.mem8.subarray(0xC1700,0xC1740))},
        pic:vm.v86.cpu.get_state_pic(),pirq:Array.from(vm.v86.cpu.devices.pci.isa_bridge_space8.slice(0x60,0x64)),
        gpu: nv.graph.engine3d.backend ? nv.graph.engine3d.backend.stats : null,
        shaderTranslation:{...nv.graph.engine3d.translation_stats,entries:nv.graph.engine3d.translated.size,bytes:nv.graph.engine3d.translation_bytes},
        scanout: sink.transitions,
        display: { crtc: Array.from(nv.display.crtc), front: nv.display.front, mode: nv.display.mode() },
        graph: nv.graph.get_state(), graphFaults: nv.graph.faults, fifo: nv.fifo.get_state(), fifoFaults:nv.fifo.faults });
    try
    {
        await new Promise((resolve, reject) => { vm.add_listener("emulator-ready", resolve); vm.add_listener("emulator-error", reject); });
        if(game)
        {
            const channel=vm.v86.cpu.devices.ide.secondary;
            // Use the active core's IDE implementation in both source and
            // release runs, rather than injecting a source/debug device.
            const Interface=channel.slave.constructor;
            channel.slave=new Interface(channel,1,game,false);
        }
        if(process.env.NV_STATE_LOAD)
        {
            await vm.restore_state(fs.readFileSync(process.env.NV_STATE_LOAD));
            if(process.env.NV_PROBE_REPLACE) replace_probe(tools.bytes, probe);
            if(process.env.NV_DISABLE_JIT) vm.v86.cpu.configure_jit_backend({disable_jit:true});
            await vm.run();
        }
        else if(game)await vm.run();
        if(process.env.NV_FDA)await vm.set_fda({url:path.resolve(process.env.NV_FDA),disk_option:"read_only"});
        const cpu = vm.v86.cpu;
        nv = cpu.devices.graphics_adapter.device["nv"];
        nv.trace.enabled = process.env.NV_TRACE !== "0";
        clock_start = cpu.clock.now();
        if(process.env.NV_DRAW_FAULTS && nv.graph.engine3d.backend)
        {
            const backend=nv.graph.engine3d.backend,draw=backend.draw.bind(backend),faults=[],seen=new Set();
            backend.draw=(object,mode,words,indices,subc)=>{
                try {return draw(object,mode,words,indices,subc);}
                catch(error)
                {
                    const reason=String(error.message || error),key=JSON.stringify([reason,object.methods.get(0x220),object.methods.get(0x208)]);
                    if(!seen.has(key) && faults.length<16)
                    {
                        seen.add(key);faults.push({elapsed:elapsed(),reason,channel:object.channel,instance:object.instance,
                            mode,subc,words:words?.length||0,indices:indices?.length||0,methods:Array.from(object.methods)});
                        fs.writeFileSync(path.join(out,"draw-faults.json"),JSON.stringify(faults,null,2));
                    }
                    throw error;
                }
            };
        }
        if(process.env.NV_CPU_PROFILE)
        {
            const {Session}=await import("node:inspector"),session=new Session();session.connect();
            const post=(method)=>new Promise((resolve,reject)=>session.post(method,(error,result)=>error?reject(error):resolve(result)));
            profiler={session,post};await post("Profiler.enable");await post("Profiler.start");
        }
        if(process.env.NV_WATCH_FLIP)
        {
            const original=nv.trace.record.bind(nv.trace),captures=[];
            nv.trace.record=(space,offset,size,write,value,implemented)=>{
                original(space,offset,size,write,value,implemented);
                const graphMethod=space==="graph" && offset>=0x4097*0x2000+0x120 && offset<=0x4097*0x2000+0x130;
                if(!write || !graphMethod && !(space==="mmio" && [0x400304,0x400310,0x40032C,0x400710,0x40071C,0x400720,0x600800].includes(offset)))return;
                const position=nv.graph.flip_context_offset();
                captures.push({elapsed:elapsed(),sequence:nv.trace.sequence,space,offset,value,eip:cpu.instruction_pointer[0]>>>0,
                    current:nv.registers.get(0x40032C)||0,context:nv.graph.context,flips:nv.graph.flips.map(f=>f.slice()),
                    ramin:position===null?[]:[...nv.graph.flip_contexts.keys()].map(instance=>[instance,nv.dma.word(instance*16+position)])});
                if(captures.length>512)captures.shift();
                fs.writeFileSync(path.join(out,"flip-watch.json"),JSON.stringify(captures,null,2));
            };
        }
        if(process.env.NV_WATCH_RAMIN)
        {
            const address=Number.parseInt(process.env.NV_WATCH_RAMIN,16);assert(address>=0 && address+4<=1<<20 && !(address&3));
            const original=nv.ramin_write.bind(nv),captures=[];
            nv.ramin_write=(offset,value)=>{
                original(offset,value);
                if(offset!==address+3 || captures.length>=8)return;
                const word=nv.dma.word(address);if(word&1)return;
                const stack=cpu.reg32[4]>>>0,read=at=>{
                    try{return cpu.mem8[cpu.translate_address_system_read(at)>>>0];}catch{return 0;}
                };
                captures.push({elapsed:elapsed(),sequence:nv.trace.sequence,address,word,
                    eip:cpu.instruction_pointer[0]>>>0,regs:Array.from(cpu.reg32,v=>v>>>0),
                    stack:Array.from({length:48},(_,i)=>{
                        const at=(stack+i*4)>>>0;return (read(at)|read(at+1)<<8|read(at+2)<<16|read(at+3)<<24)>>>0;
                    }),fifo:nv.fifo.get_state(),graph:nv.graph.get_state(),gpu:{...nv.graph.engine3d.backend?.stats}});
                fs.writeFileSync(path.join(out,"ramin-watch.json"),JSON.stringify(captures,null,2));
            };
        }

        for(; elapsed() < seconds && !error && !cancelled;)
        {
            await delay(capture_interval?Math.min(1000,Math.max(100,capture_interval*1000)):1000);
            cpu.devices.display.request_frame(true);
            if(capture_interval && elapsed()>=next_capture && capture_index<capture_limit)
            {
                next_capture=elapsed()+capture_interval;
                save_png(sink,out,"capture-"+String(capture_index++).padStart(4,"0"));
            }
            if(process.env.NV_DOS_TEST && sink.graphical && (sink.width === 320 || sink.width === 640 && sink.height === 400))
                save_png(sink, out, "dos");
            if(!reboot_seen && result_text().includes("REBOOT_REQUEST"))
            {
                reboot_seen = true; launches = 0; next_launch = elapsed() + 100;
            }
            if(fs.existsSync(control_file))
            {
                const modified = fs.statSync(control_file).mtimeMs;
                if(modified > control_time)
                {
                    control_time = modified;
                    const input = fs.readFileSync(control_file, "utf8").trim();
                    const command = input.startsWith("{") ? JSON.parse(input) : { run: input };
                    if(command.stop) {cancelled=true;break;}
                    if(command.checkpoint)
                    {
                        const tag=String(command.checkpoint);assert(/^[a-zA-Z0-9_-]{1,64}$/.test(tag),"invalid checkpoint label");
                        await vm.stop();
                        try {fs.writeFileSync(path.join(out,"checkpoint-"+tag+".state"),new Uint8Array(await vm.save_state()));}
                        finally {await vm.run();}
                        console.log("NV40 checkpoint",tag,"at",Math.round(elapsed()),"seconds");
                    }
                    if(command.pointer)
                    {
                        assert(Array.isArray(command.pointer) && command.pointer.length===2 &&
                            command.pointer.every(value=>Number.isFinite(value) && Math.abs(value)<=2048),"invalid relative mouse counts");
                        vm.bus.send("mouse-delta",command.pointer);await delay(300);
                    }
                    if(command.click)
                    {
                        vm.bus.send("mouse-click",[true,false,false]);await delay(100);
                        vm.bus.send("mouse-click",[false,false,false]);
                    }
                    if(command.keys) await vm.keyboard_send_scancodes(command.keys, 30);
                    if(command.run)
                    {
                        const codes=run_scancodes(command.run);
                        await vm.keyboard_send_scancodes([184,157,170,182,0xE0,0xDB,0xE0,0xDC],30);
                        await vm.keyboard_send_scancodes([0xE0, 0x5B, 0x13, 0x93, 0xE0, 0xDB], 30);
                        await delay(5000);
                        await vm.keyboard_send_scancodes([29,30,158,157],30);
                        await vm.keyboard_send_scancodes(codes,30);
                        await vm.keyboard_send_scancodes([28, 156], 30);
                    }
                }
            }
            if(process.env.NV_STATE_SAVE && !checkpoint &&
                (process.env.NV_STATE_SAVE_AT && elapsed() >= Number(process.env.NV_STATE_SAVE_AT) ||
                process.env.NV_STATE_SAVE_DRAWS && nv.graph.engine3d.backend &&
                    nv.graph.engine3d.backend.stats.draws >= Number(process.env.NV_STATE_SAVE_DRAWS)))
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
        if(profiler)
        {
            try
            {
                const {profile}=await profiler.post("Profiler.stop");
                fs.writeFileSync(path.join(out,"cpu-profile.cpuprofile"),JSON.stringify(profile));
            }
            catch(e) {error=error || e.stack || String(e);}
            finally {profiler.session.disconnect();}
        }
        await vm.stop();
        if(process.env.NV_FDA)fs.writeFileSync(path.join(out,"fda-final.img"),vm.get_disk_fda());
        if(process.env.NV_STATE_SAVE && !checkpoint)
            fs.writeFileSync(process.env.NV_STATE_SAVE, new Uint8Array(await vm.save_state()));
        if(nv)
        {
            fs.writeFileSync(path.join(out, "trace.json"), JSON.stringify(trace_report(), null, 2) + "\n");
            if(process.env.NV_DUMP_PROGRAMS) fs.writeFileSync(path.join(out, "programs.json"),JSON.stringify(nv.graph.engine3d.programs(),null,2)+"\n");
            fs.writeFileSync(path.join(out, "ramin.bin"), nv.vram().subarray(nv.vram_size - (1 << 20)));
        }
        save_png(sink, out, "final");
        fs.writeFileSync(path.join(out, "screen.txt"), sink.text.join("\n"));
        for(const name of new Set(["MACHINE.INF", "NVDOS.TXT", "DXDIAG.TXT", "DDXP.TXT", "NVLAUNCH.TXT",
            ...(process.env.NV_TOOLS_ARTIFACTS||"").split(";").filter(Boolean)]))
        {
            assert(/^[a-zA-Z0-9_.-]+$/.test(name),"tool artifacts must be root filenames");
            const bytes = read_fat16(tools.bytes, name);
            if(bytes) fs.writeFileSync(path.join(out, name), bytes);
        }
        if(process.env.NV_OVERLAY_SAVE) fs.writeFileSync(process.env.NV_OVERLAY_SAVE, serialize(disk.get_state()));
        if(game)
        {
            if(process.env.NV_GAME_OVERLAY_SAVE)fs.writeFileSync(process.env.NV_GAME_OVERLAY_SAVE,serialize(game.get_state()));
            for(const name of (process.env.NV_GAME_ARTIFACTS || "").split(";").filter(Boolean))
            {
                const bytes=await read_fat32_file(game,name);
                if(bytes)fs.writeFileSync(path.join(out,path.basename(name.replaceAll("\\","/"))),bytes);
            }
        }
        await vm.destroy(); if(remote) await remote.close(); disk.close();
        if(game)
        {
            game.close();const after=fs.statSync(game_path);
            assert.equal(after.mtimeMs,game_before.mtimeMs);assert.equal(after.size,game_before.size);
        }
        process.off("SIGINT", cancel);
        assert.equal(fs.statSync(image).mtimeMs, before.mtimeMs);
        assert.equal(fs.statSync(image).size, before.size);
    }
    const text = result_text();
    // A successful install API alone is insufficient: the device must be started by nv.
    const initialized = win98 ? /DEVICE .* problem=0 cm=0 started=1 .*driver=\S+ description=NVIDIA GeForce 6800/m.test(text) :
        /DEVICE .* problem=0 cm=0 started=1 service=nv(?:\s|$)/m.test(text);
    const result = { status: initialized ? "INITIALIZED" : "BLOCKED", seconds: Math.round(elapsed()),
        build: {javascript:release_build?"release":"source",wasm:wasm_path},
        guest: win98 ? "win98" : "xp", driver, rom: process.env.NV_ROM || "v86 G0 SeaVGABIOS",
        error, probe: text, trace: "trace.json", imageUnchanged: true,
        ...(game_path?{game:{path:game_path,slot:"secondary-slave",imageUnchanged:true}}:{}),
        reason: initialized ? "native device started; rendering acceptance is recorded separately" : text ? "driver install/initialization did not complete" : "guest probe did not start" };
    fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
    if(!initialized) process.exitCode = 1;
    return result;
}
