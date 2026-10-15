import { state_stream_server } from "./state_stream_transport.js";
// Browser-side ownership boundary. Guest RAM and synchronous devices live only
// in the worker; this side owns DOM adapters and asynchronous GPU execution.
import { GraphicsPerformance } from "./graphics_performance.js";
import { DISPLAY_SINK_REPLAY } from "../display.js";
import { default_graphics_adapter_path } from "../graphics_adapter.js";

export function encode_worker_file(f)
{
    if(!f) return undefined;
    if(f.get || f.set || f.load) throw new Error("CPU Worker requires a URL, File or buffer disk descriptor");
    return { "url": f.url && new URL(f.url, location.href).href,
        "buffer": f.buffer, "async": f.async, "size": f.size,
        "fixed_chunk_size": f.fixed_chunk_size, "use_parts": f.use_parts };
}

/**
 * @param {!Object} o
 * @param {!Array<!Object>=} plugins device plugins: the worker loads their devices' scripts
 */
export function encode_worker_options(o, plugins = [], adapter_renderer = false)
{
    const file = encode_worker_file;
    const fs = o.filesystem;
    // (a built-in device's place behind a root port)
    const placement = device => device && typeof device === "object" && device.pcie_root_port !== undefined ?
        { "pcie_root_port": device.pcie_root_port, "pcie_plugged": device.pcie_plugged } : {};
    if(o.wasm_fn || fs?.handle9p) throw new Error("CPU Worker cannot transfer wasm_fn or handle9p callbacks");
    if(o["virtio_devices"]?.length) throw new Error("CPU Worker cannot transfer virtio_devices; their descriptors run on the CPU's thread");
    return {
        "device_plugins": plugins.map(plugin => {
            if(!plugin["worker_script"]) throw new Error("CPU Worker: " + plugin["name"] + " has no worker_script for its device");
            return { "name": plugin["name"], "script": new URL(plugin["worker_script"], location.href).href };
        }),
        "wasm_path": new URL(o.wasm_path || "build/v86.wasm", location.href).href,
        "wasm_fallback_path": o["wasm_fallback_path"] && new URL(o["wasm_fallback_path"], location.href).href,
        // (cores in vCPU workers, which this worker starts: absolute URLs)
        "parallel": o["parallel"],
        "parallel_wasm_path": o["parallel_wasm_path"] && new URL(o["parallel_wasm_path"], location.href).href,
        "vcpu_worker_url": o["vcpu_worker_url"] && new URL(o["vcpu_worker_url"], location.href).href,
        "memory_size": o.memory_size,
        // The worker loads the display adapter's plugin itself, from an absolute URL
        "graphics_adapter": o["graphics_adapter"], "vram_size": o["vram_size"],
        "graphics_adapter_test": o["graphics_adapter_test"],
        // whether the display adapter's 3D renderer is on the page (its channel is "graphics_adapter_renderer")
        "graphics_adapter_renderer": adapter_renderer,
        "graphics_adapter_path": o["graphics_adapter"] === "none" ? undefined :
            new URL(o["graphics_adapter_path"] || default_graphics_adapter_path(o["graphics_adapter"]), location.href).href,
        "extended_memory_size": o.extended_memory_size, "extended_memory_cache": o.extended_memory_cache,
        "high_memory_size": o.high_memory_size,
        "boot_order": o.boot_order, "acpi": o.acpi, "machine_type": o.machine_type, "pcie_root_ports": o.pcie_root_ports, "hpet": o.hpet, "smbus": o.smbus, "cpu_cores": o.cpu_cores,
        "cpu_clock": o.cpu_clock, "cpu_quantum": o.cpu_quantum, "cpu_schedule_seed": o.cpu_schedule_seed,
        "experimental_smp_jit": o.experimental_smp_jit, "disable_jit": o.disable_jit,
        "cpu_type": o["cpu_type"], "cpu_features": o["cpu_features"], "cpu_features_unreleased": o["cpu_features_unreleased"],
        "jit_backend": o["jit_backend"], "ir_tier0": o["ir_tier0"],
        "x87_fast_math": o["x87_fast_math"],
        "x87_jit_cache": o["x87_jit_cache"],
        "fastboot": o.fastboot, "bootmenu": o.bootmenu, "cmdline": o.cmdline,
        "cpuid_level": o.cpuid_level, "uart1": o.uart1, "uart2": o.uart2, "uart3": o.uart3,
        "parallel1": o.parallel1, "qemu_compatible": o.qemu_compatible,
        "virtio_balloon": o.virtio_balloon && (typeof o.virtio_balloon === "object" ? placement(o.virtio_balloon) : true),
        "virtio_console": o.virtio_console && (typeof o.virtio_console === "object" ? placement(o.virtio_console) : true),
        "modem": o.modem && { "uart": o.modem.uart },
        "preserve_mac_from_state_image": o.preserve_mac_from_state_image,
        "mac_address_translation": o.mac_address_translation,
        "net_device": { "type": o.net_device?.type || "ne2k", ...placement(o.net_device) },
        "bios": file(o.bios), "vga_bios": file(o.vga_bios), "hda": file(o.hda), "hdb": file(o.hdb),
        "fda": file(o.fda), "fdb": file(o.fdb), "cdrom": file(o.cdrom),
        "multiboot": file(o.multiboot), "bzimage": file(o.bzimage), "initrd": file(o.initrd),
        "initial_state": file(o.initial_state),
        "filesystem": fs && { "baseurl": fs.baseurl && new URL(fs.baseurl, location.href).href,
            "basefs": typeof fs.basefs === "string" ? new URL(fs.basefs, location.href).href : file(fs.basefs),
            "proxy_url": fs.proxy_url, ...placement(fs) },
        "bzimage_initrd_from_filesystem": o.bzimage_initrd_from_filesystem,
        "disable_keyboard": true, "disable_mouse": true, "disable_speaker": true,
        "autostart": false,
    };
}

export class CPUWorkerController
{
    constructor(emulator, options)
    {
        this.emulator = emulator;
        this.options = options;
        /** whether the display adapter's 3D renderer is on this page (starter.js) */
        this.adapter_renderer = false;
        this.pending = new Map();
        this.next_id = 0;
        this.epoch = 1;
        this.failed = null;
        this.closed = false;
        this.startup_resolve = null;
        this.startup_reject = null;
        this.startup = new Promise((resolve, reject) => {
            this.startup_resolve = resolve;
            this.startup_reject = reject;
        });
        this.startup.catch(() => {});
        this.operations = this.startup;
        this.instructions = 0;
        this.frame_pending = false;
        this.full_frame_wanted = false;
        this.input_queue = [];
        this.ready = false;
        this.screen_queue = [];
        this.device_info = {};
        this.recording_report = null;
        this.direct_audio = false;
        this.stats = { "mode": "worker" };
        // Device plugins: the host side here, the device in the worker
        this.device_handlers = new Map();
        // (sent before the worker has made the devices)
        this.device_queue = [];
        this.devices_ready = false;
        const url = options["cpu_worker_url"] || "build/cpu-worker.js";
        this.worker = new Worker(url, { "name": "v86 CPU" });
        this.worker.onmessage = e => this.receive(e.data);
        this.worker.onerror = e => this.fail(new Error(e.message || "CPU Worker failed to start"));
        this.worker.onmessageerror = () => this.fail(new Error("CPU Worker message could not be decoded"));
        emulator.bus.send = (name, value) => {
            if(this.closed || this.failed) return;
            if(!this.ready) this.input_queue.push([name, value]);
            else this.post({ "type": "event", "epoch": this.epoch, "name": name, "value": value });
        };
    }

    post(message, transfer = []) { this.worker.postMessage(message, transfer); }

    /**
     * The host side's end of the channel to a plugin's device in the worker
     * @param {string} name
     */
    device_channel(name)
    {
        return {
            "remote": true,
            "post": (message, transfer) => {
                if(this.closed || this.failed) return;
                if(!this.devices_ready) this.device_queue.push([name, message, transfer]);
                else this.post({ "type": "device", "epoch": this.epoch, "name": name, "message": message }, transfer || []);
            },
            "listen": handler => { this.device_handlers.set(name, handler); },
        };
    }

    rpc(method, args = [], transfer = [])
    {
        if(this.closed || this.failed) return Promise.reject(this.failed || new Error("CPU Worker is closed"));
        const id = ++this.next_id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try { this.post({ "type": "rpc", "id": id, "method": method, "args": args }, transfer); }
            catch(error) { this.pending.delete(id); reject(error); }
        });
    }

    /**
     * V86.detach_pcie_device: the worker answers once the removal started
     * (one through the attention button waits for the guest, and the worker
     * does not hold the commands after it back), and reports its end as the
     * result for a second id
     * @param {number} port
     * @param {boolean} surprise
     * @return {!Promise<void>}
     */
    detach_pcie_device(port, surprise)
    {
        if(this.closed || this.failed) return Promise.reject(this.failed || new Error("CPU Worker is closed"));
        const done_id = ++this.next_id;
        const done = new Promise((resolve, reject) => this.pending.set(done_id, { resolve, reject }));
        // (its end may come before the answer)
        done.catch(() => {});
        return this.rpc("detach_pcie_device", [port, { "surprise": surprise }, done_id]).then(() => done, error => {
            this.pending.delete(done_id);
            throw error;
        });
    }

    fail(error)
    {
        if(this.failed || this.closed) return;
        this.failed = error;
        this.startup_reject(error);
        this.emulator.cpu_is_running = false;
        for(const p of this.pending.values()) p.reject(error);
        this.pending.clear();
        this.worker.terminate();
        this.emulator.screen_adapter?.pause();
        this.emulator.speaker_adapter?.pause();
        this.emulator.emulator_bus.send("emulator-error", error);
        console.error("[v86 CPU Worker]", error);
    }

    async start()
    {
        const plugins = this.emulator.device_plugins;
        await Promise.all(this.emulator.plugins_ready);
        const host_states = await this.rpc("init", [encode_worker_options(this.options, plugins, this.adapter_renderer)]);
        this.devices_ready = true;
        for(const [name, message, transfer] of this.device_queue.splice(0))
        {
            this.post({ "type": "device", "epoch": this.epoch, "name": name, "message": message }, transfer || []);
        }
        // initial_state
        for(const plugin of plugins)
        {
            const host_state = host_states[plugin["name"]];
            if(host_state === undefined) continue;
            plugin["before_restore"] && await plugin["before_restore"]();
            plugin["after_restore"] && await plugin["after_restore"](host_state);
        }
        const dac = this.emulator.speaker_adapter?.dac;
        if(dac?.connect_cpu_worker)
        {
            const port = await dac.connect_cpu_worker();
            await this.rpc("audio-attach", [port], [port]);
            this.direct_audio = true;
        }
        this.ready = true;
        for(const [name, value] of this.input_queue) this.emulator.bus.send(name, value);
        this.input_queue = [];
        if(this.options.autostart && !this.emulator.destroyed) await this.rpc("run");
        this.startup_resolve();
        this.emulator.emulator_bus.send("emulator-loaded");
        this.options = null;
    }

    receive(m)
    {
        if(this.closed || this.failed) return;
        if(m["type"] === "result")
        {
            const p = this.pending.get(m["id"]);
            if(!p) return;
            this.pending.delete(m["id"]);
            if(m["error"]) p.reject(new Error(m["error"])); else p.resolve(m["value"]);
            return;
        }
        if(m["type"] === "fatal") { this.fail(new Error(m["error"])); return; }
        if(m["type"] === "epoch")
        {
            this.epoch = m["epoch"];
            this.screen_queue = [];
            this.frame_pending = false;
            if(!this.direct_audio) this.emulator.emulator_bus.send("dac-reset");
            return;
        }
        if(m["epoch"] !== this.epoch) return;
        switch(m["type"])
        {
            case "event":
                if(m["name"] === "download-progress" || m["name"] === "download-error")
                {
                    const v = m["value"];
                    this.emulator.emulator_bus.send(m["name"], { file_name: v["file_name"],
                        file_index: v["file_index"], file_count: v["file_count"],
                        loaded: v["loaded"], total: v["total"], lengthComputable: v["lengthComputable"] });
                }
                else this.emulator.emulator_bus.send(m["name"], m["value"]);
                break;
            case "screen":
                // Guest text redraws can exceed the host's argument limit.
                // Append individually so even large bursts remain lossless.
                for(const command of m["commands"]) this.screen_queue.push(command);
                this.flush_screen();
                break;
            case "frame": this.frame_pending = false; this.draw_frame(m["layers"]); break;
            case "stats":
                this.instructions = m["value"]["instructions"];
                this.device_info = m["value"];
                break;
            case "device": {
                const handler = this.device_handlers.get(m["name"]);
                if(handler) handler(m["message"]);
                break;
            }
            case "recording": this.recording_report?.(m["value"]); break;
        }
    }

    flush_screen()
    {
        const s = this.emulator.screen_adapter;
        for(const [name, args] of this.screen_queue.splice(0)) DISPLAY_SINK_REPLAY[name](s, args);
    }

    request_frame(full)
    {
        if(full) this.full_frame_wanted = true;
        if(!this.ready || this.frame_pending || this.closed || this.failed) return;
        this.frame_pending = true;
        this.post({ "type": "frame", "epoch": this.epoch, "full": !!this.full_frame_wanted });
        this.full_frame_wanted = false;
    }

    draw_frame(layers)
    {
        this.emulator.screen_adapter.update_buffer(layers.map(l => ({
            pixels: { data: l["pixels"], width: l["width"], height: l["height"] },
            screen_x: l["x"], screen_y: l["y"], buffer_x: 0, buffer_y: 0,
            buffer_width: l["width"], buffer_height: l["height"],
        })));
    }

    serialize(operation)
    {
        const next = this.operations.catch(() => {}).then(operation);
        this.operations = next.then(() => {}, () => {});
        return next;
    }

    async stop()
    {
        await this.rpc("stop");
        // Acknowledging a batch can release another pending virtqueue request.
        // Drain to a fixed point, not just the work observed at stop time.
        let pending;
        do {
            await Promise.all(this.emulator.device_plugins.map(plugin => plugin["idle"] && plugin["idle"]()));
            pending = await this.rpc("barrier");
        } while(pending);
        await this.emulator.speaker_adapter?.pause();
    }

    /** @return {!Promise<!Object>} each plugin's host state, by name */
    async prepare_plugins_save()
    {
        const host_states = {};
        for(const plugin of this.emulator.device_plugins)
        {
            if(plugin["prepare_save"]) host_states[plugin["name"]] = await plugin["prepare_save"]();
        }
        return host_states;
    }

    release_plugins_save()
    {
        for(const plugin of this.emulator.device_plugins)
        {
            plugin["release_save"] && plugin["release_save"]();
        }
    }

    async before_plugins_restore()
    {
        for(const plugin of this.emulator.device_plugins)
        {
            plugin["before_restore"] && await plugin["before_restore"]();
        }
    }

    async after_plugins_restore(host_states)
    {
        for(const plugin of this.emulator.device_plugins)
        {
            plugin["after_restore"] && await plugin["after_restore"](host_states[plugin["name"]]);
        }
    }

    cancel_plugins_restore()
    {
        for(const plugin of this.emulator.device_plugins)
        {
            plugin["cancel_restore"] && plugin["cancel_restore"]();
        }
    }

    state(kind, state = null)
    {
        return this.serialize(async () => {
            const running = this.emulator.is_running();
            await this.stop();
            let ok = false;
            try
            {
                if(kind === "save")
                {
                    const result = await this.rpc("save", [await this.prepare_plugins_save()]);
                    ok = true;
                    return result;
                }
                if(kind === "restart")
                {
                    await this.rpc("restart", state ? [state] : []);
                    for(const plugin of this.emulator.device_plugins)
                    {
                        plugin["reset"] && await plugin["reset"]();
                    }
                    ok = true;
                    return;
                }
                await this.before_plugins_restore();
                await this.after_plugins_restore(await this.rpc(kind, state ? [state] : []));
                ok = true;
            }
            catch(error)
            {
                if(kind !== "save") this.cancel_plugins_restore();
                throw error;
            }
            finally
            {
                if(kind === "save") this.release_plugins_save();
                if(running && !this.emulator.destroyed && (ok || kind === "save")) await this.rpc("run");
            }
        });
    }

    state_stream(kind, value)
    {
        return this.serialize(async () => {
            const running = this.emulator.is_running();
            await this.stop();
            const channel = new globalThis.MessageChannel();
            const server = state_stream_server(channel.port1, kind, value);
            let success = false;
            try
            {
                if(kind === "save")
                {
                    await this.rpc("save-stream", [await this.prepare_plugins_save(), channel.port2], [channel.port2]);
                }
                else
                {
                    await this.before_plugins_restore();
                    await this.after_plugins_restore(
                        await this.rpc("restore-stream", [server["size"], channel.port2], [channel.port2]));
                }
                success = true;
            }
            catch(error)
            {
                if(kind !== "save") this.cancel_plugins_restore();
                throw error;
            }
            finally
            {
                server["close"]();
                if(kind === "save") this.release_plugins_save();
                if(running && !this.emulator.destroyed && (success || kind === "save")) await this.rpc("run");
            }
        });
    }

    async destroy()
    {
        if(this.closed) return;
        await this.operations.catch(() => {});
        if(!this.failed)
        {
            try { await this.stop(); await this.rpc("destroy"); }
            finally { this.close(); }
        }
        else this.close();
    }

    close()
    {
        this.closed = true;
        this.startup_reject(new Error("CPU Worker destroyed"));
        this.worker.terminate();
        for(const p of this.pending.values()) p.reject(new Error("CPU Worker destroyed"));
        this.pending.clear();
        this.input_queue = [];
        this.screen_queue = [];
    }
}

export class WorkerPerformanceRecorder
{
    constructor(emulator, options)
    {
        this.emulator = emulator;
        this.options = options;
        this.active = false;
        this.report = null;
        this.graphics = null;
    }
    async start()
    {
        if(this.active) throw new Error("Performance recording is already active");
        this.active = true;
        this.graphics = new GraphicsPerformance(this.emulator);
        this.emulator.worker_controller.recording_report = report => this.finish(report);
        try {
            await this.emulator.worker_controller.startup;
            await this.emulator.worker_controller.rpc("record-start", [this.options.metadata || {}]);
        }
        catch(error) { this.active = false; this.graphics.stop(); throw error; }
    }
    finish(report)
    {
        if(!this.active) return;
        report["graphics"] = this.graphics.stop();
        report["worker_transport"] = { ...this.emulator.worker_controller.stats,
            ...(this.emulator["graphics_proxy"] ? this.emulator["graphics_proxy"]["stats"] : {}) };
        report["metadata"]["cpu_thread"] = "dedicated-worker";
        this.report = report;
        this.active = false;
        this.options.on_stop?.(report);
    }
    async stop()
    {
        if(this.active) this.finish(await this.emulator.worker_controller.rpc("record-stop"));
        return this.report;
    }
}
