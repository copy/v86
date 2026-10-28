import { state_stream_server } from "./state_stream_transport.js";
// Browser-side ownership boundary. Guest RAM and synchronous devices live only
// in the worker; this side owns DOM adapters and asynchronous GPU execution.
import { DISPLAY_SINK_REPLAY } from "../display.js";
import { default_graphics_adapter_path } from "../graphics_adapter.js";
import { default_glslang_wasm_path, default_plugin_path, default_tpm_wasm_path } from "../device_plugin.js";
import { is_arm, AUDIO_DEVICE_PLUGINS, NET_DEVICE_PLUGINS } from "../machine_options.js";

/**
 * @param {*} f
 * @param {number=} depth (a disk image's parents, backing)
 */
export function encode_worker_file(f, depth = 0)
{
    if(!f) return undefined;
    if(f.get || f.set || f.load) throw new Error("CPU Worker requires a URL, File or buffer disk descriptor");
    // (MAX_CHAIN_DEPTH of src/image/factory.js)
    if(depth > 16) throw new Error("CPU Worker: the backing images of a disk are nested too deeply (or circular)");
    return { "url": f.url && new URL(f.url, location.href).href,
        "buffer": f.buffer, "async": f.async, "size": f.size,
        "fixed_chunk_size": f.fixed_chunk_size, "use_parts": f.use_parts,
        // disk images (docs/disk-image-formats-plan.md): the worker opens them
        "format": f.format, "disk_option": f.disk_option, "image_id": f.image_id,
        // the disk's policy (docs/disk-persistence-plan.md): the worker builds its backend
        "disk_error": f.disk_error, "token": f.token,
        "overlay_limit": f.overlay_limit, "backing": f.backing ? encode_worker_file(f.backing, depth + 1) : undefined,
        "archive_member": f.archive_member, "logical_sector_size": f["logical_sector_size"],
        "files": f.files ? Object.fromEntries(Object.entries(f.files).map(([name, file]) => [name, encode_worker_file(file, depth + 1)])) : undefined };
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
    // (the defaults of src/browser/starter.js: an NE2000 and an SB16 on the PC machines)
    const net_type = o.net_device?.type || (is_arm(o["cpu_type"]) ? "virtio" : "ne2k");
    const audio_device = is_arm(o["cpu_type"]) ? o["audio_device"] : o["audio_device"] || "sb16";
    return {
        "device_plugins": plugins.map(plugin => {
            if(!plugin["worker_script"]) throw new Error("CPU Worker: " + plugin["name"] + " has no worker_script for its device");
            return { "name": plugin["name"], "script": new URL(plugin["worker_script"], location.href).href };
        }),
        // (the core of the CPU's family: docs/arm64-virt-android16-plan.md P1.3)
        "wasm_path": new URL(o.wasm_path || (is_arm(o["cpu_type"]) ? "build/v86-arm64.wasm" : "build/v86.wasm"), location.href).href,
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
        "jit_backend": o["jit_backend"], "ir_tier0": o["ir_tier0"], "jit_switches": o["jit_switches"], "cpu_profile": o["cpu_profile"],
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
        "net_device": { "type": net_type, "count": o.net_device?.count,
            // (a plugin card, like the display adapter: the worker loads it
            // from an absolute URL, the default NE2000's too)
            "plugin_path": NET_DEVICE_PLUGINS.includes(net_type) ?
                new URL(o.net_device?.plugin_path || default_plugin_path(net_type), location.href).href : undefined,
            "mtu": o.net_device?.mtu,
            ...placement(o.net_device) },
        // (a plugin card, as the network card's; the default SB16 on the PC machines)
        "audio_device": audio_device,
        "audio_device_path": AUDIO_DEVICE_PLUGINS.includes(audio_device) ?
            new URL(o["audio_device_path"] || default_plugin_path(audio_device), location.href).href : undefined,
        // (USB's plugin, likewise)
        "usb": o["usb"] ? { "controller": o["usb"]["controller"], "tablet": o["usb"]["tablet"],
            "plugin_path": new URL(o["usb"]["plugin_path"] || default_plugin_path("usb"), location.href).href,
            "mass_storage": o["usb"]["mass_storage"] && o["usb"]["mass_storage"].map(disk =>
                ({ "id": disk["id"], "image": file(disk["image"]), "read_only": disk["read_only"] })) } : undefined,
        "bios": file(o.bios), "vga_bios": file(o.vga_bios), "hda": file(o.hda), "hdb": file(o.hdb),
        "firmware": o.firmware && { "type": o.firmware.type, "debug_console": o.firmware.debug_console, "secure_boot": o.firmware.secure_boot,
            "code": file(o.firmware.code), "vars": file(o.firmware.vars) },
        // (the TPM's plugin and module: absolute URLs, as the other plugins')
        "tpm": o.tpm && { "version": o.tpm.version, "interface": o.tpm.interface, "state": file(o.tpm.state),
            "plugin_path": new URL(o.tpm.plugin_path || default_plugin_path("tpm"), location.href).href,
            "wasm_path": new URL(o.tpm.wasm_path || default_tpm_wasm_path(), location.href).href },
        "fda": file(o.fda), "fdb": file(o.fdb), "cdrom": file(o.cdrom),
        "multiboot": file(o.multiboot), "bzimage": file(o.bzimage), "initrd": file(o.initrd),
        // (machine_type "virt": docs/arm64-virt-android16-plan.md P1.1)
        "kernel": file(o.kernel), "dtb": file(o.dtb),
        // (docs/android-images-plan.md I2: the bootloader runs in the worker, beside the disk)
        "android": o.android && { "device": o.android.device, "gpu_mode": o.android.gpu_mode, "selinux": o.android.selinux,
            "vendor_ramdisk": file(o.android.vendor_ramdisk) },
        // (the ranchu machine's GPU mode; the GLES host's plugin by an absolute URL, as the other plugins')
        "ranchu_gpu": o.ranchu_gpu,
        "ranchu_gpu_path": new URL(o.ranchu_gpu_path || default_plugin_path("gles"), location.href).href,
        "gles_glslang_path": new URL(o.gles_glslang_path || default_glslang_wasm_path(), location.href).href,
        "ranchu_gles_version": o.ranchu_gles_version,
        "gles_backdoor": o.gles_backdoor,
        "virtio_disks": o.virtio_disks && o.virtio_disks.map(disk => Object.assign({}, file(disk), { "readonly": disk.readonly, "id": disk.id })),
        "virtio_rng": o.virtio_rng, "virtio_input": o.virtio_input, "virtio_transport": o.virtio_transport,
        "virtio_vsock": o.virtio_vsock, "virtio_sound": o.virtio_sound, "virtio_console_ports": o.virtio_console_ports, "virtio_gpu_pci_slot": o.virtio_gpu_pci_slot,
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
        this.direct_audio = false;
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
        }
    }

    flush_screen()
    {
        const s = this.emulator.screen_adapter;
        const bus = this.emulator.emulator_bus;
        for(const [name, args] of this.screen_queue.splice(0))
        {
            DISPLAY_SINK_REPLAY[name](s, args);
            // (the worker does not send this event: here it comes after the
            // screen has the character, as with the CPU in the page)
            if(name === "put_char") bus.send("screen-put-char", [args[0], args[1], args[2]]);
        }
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

    /**
     * V86.export_disk_image: the worker writes the chunks to a port, one at a
     * time, and each waits for the page's write to finish (backpressure);
     * after the signal aborts, the next chunk's write fails the export
     * @param {string} name
     * @param {!Object} options write, progress, signal
     * @return {!Promise<number>}
     */
    export_disk(name, options)
    {
        return this.serialize(async () => {
            const info = await this.rpc("disk-info", [name]);
            // (a QCOW2 image's size is known once the disk was read)
            const total = options.format === "qcow2" ? undefined : info["size"];
            const channel = new globalThis.MessageChannel();
            let loaded = 0;
            const port = channel.port1;
            const receive = async event => {
                const message = event.data, id = message["id"];
                try
                {
                    if(options.signal && options.signal.aborted) throw new Error("The export was cancelled at " + loaded + " of " + total + " bytes");
                    const bytes = message["bytes"];
                    if(message["kind"] !== "write" || !(bytes instanceof Uint8Array)) throw new Error("Invalid export chunk");
                    await options.write(bytes);
                    loaded += bytes.length;
                    options.progress && options.progress({ loaded, total });
                    port.postMessage({ "id": id });
                }
                catch(error)
                {
                    port.postMessage({ "id": id, "error": String(error && error.message || error) });
                }
            };
            port.onmessage = event => { receive(event); };
            options.progress && options.progress({ loaded: 0, total });
            try
            {
                return await this.rpc("export-disk", [name, channel.port2, { "format": options.format }], [channel.port2]);
            }
            finally
            {
                port.close();
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
