import { state_stream_client } from "./state_stream_transport.js";
import { wasm_fallback_path } from "./wasm_paths.js";
import { instantiate_v86 } from "../parallel/relocate.js";
// Dedicated-worker entry. Never transfer the WebAssembly.Memory buffer.
import { V86 } from "./starter.js";
import { DisplaySinkRecorder } from "../display.js";

export function start_cpu_worker()
{
    let emulator, epoch = 1;
    let screen_commands = [], screen_scheduled = false, frame_layers = [];
    let timer, command_chain = Promise.resolve();
    let audio_port = null, audio_reset_done = null, audio_enabled = false, audio_rate = 22050;
    let audio_sequence = 0;
    const audio_stats = { "pcm_buffers": 0, "pcm_samples": 0, "pump_requests": 0 };
    const audio_send = (type, value, transfer = []) => audio_port?.postMessage({ "cpu_audio": type, "epoch": epoch, "value": value, "sequence": audio_sequence }, transfer);
    const audio_reset = () => {
        if(!audio_port) return Promise.resolve();
        return new Promise(resolve => { ++audio_sequence; audio_reset_done = resolve; audio_send("reset", null); });
    };
    const send = (type, value = {}, transfer = []) =>
        globalThis.postMessage({ "type": type, "epoch": epoch, ...value }, transfer);
    const fatal = error => {
        if(emulator) emulator.stop();
        send("fatal", { "error": String(error?.stack || error) });
    };
    globalThis.addEventListener("unhandledrejection", e => { e.preventDefault(); fatal(e.reason); });
    const flush_screen = () => {
        screen_scheduled = false;
        if(screen_commands.length) send("screen", { "commands": screen_commands });
        screen_commands = [];
    };
    const screen_call = (name, args) => {
        screen_commands.push([name, args]);
        if(!screen_scheduled) { screen_scheduled = true; globalThis.queueMicrotask(flush_screen); }
    };
    const screen = new DisplaySinkRecorder(screen_call, layers => {
        for(const l of layers)
        {
            const w = l.buffer_width, h = l.buffer_height;
            if(!(w > 0 && h > 0)) continue;
            const pixels = new Uint8ClampedArray(w * h * 4);
            for(let y = 0; y < h; y++)
            {
                const offset = ((l.buffer_y + y) * l.pixels.width + l.buffer_x) * 4;
                pixels.set(l.pixels.data.subarray(offset, offset + w * 4), y * w * 4);
            }
            frame_layers.push({ "pixels": pixels, "width": w, "height": h, "x": l.screen_x, "y": l.screen_y });
        }
    });
    const stats = () => {
        if(!emulator?.v86?.cpu) return;
        const cpu = emulator.v86.cpu;
        send("stats", { "value": { "instructions": emulator.get_instruction_counter(),
            "memory_size": cpu.memory_size[0], "cdrom": !!cpu.devices.cdrom,
            "cdrom_present": !!cpu.devices.cdrom?.has_disk() } });
    };
    // The devices of device plugins (docs/graphics-proxy-plugin-plan.md): each
    // talks to its host side on the page over these messages
    const device_handlers = new Map();
    const device_channel = name => ({
        "remote": true,
        "post": (message, transfer) => send("device", { "name": name, "message": message }, transfer || []),
        "listen": handler => { device_handlers.set(name, handler); },
    });
    const virtio_devices = () => emulator?.v86?.cpu?.devices?.virtio_devices || [];
    // What the devices still wait for from the page; a snapshot needs none
    const busy = () => virtio_devices().reduce((n, device) => n + device.busy(), 0);
    // Host states travel in the snapshot with their devices
    const set_host_states = states => {
        for(const device of virtio_devices()) device.host_state = states ? states[device.name] : undefined;
    };
    const take_host_states = () => {
        const states = {};
        for(const device of virtio_devices())
        {
            if(device.restored_host_state !== undefined) states[device.name] = device.restored_host_state;
            device.restored_host_state = undefined;
        }
        return states;
    };
    const change_epoch = async () => {
        ++epoch;
        screen_commands = [];
        send("epoch");
        await audio_reset();
    };
    const disk = name => {
        const d = emulator.v86.cpu.devices;
        switch(name)
        {
            case "hda": case "hdb": case "cdrom": return emulator.v86.cpu.disk_device(name).buffer;
            case "fda": return d.fdc.drives[0].buffer;
            case "fdb": return d.fdc.drives[1].buffer;
        }
        throw new Error("Unknown disk");
    };
    const methods = {
        "init": async options => {
            if(emulator) throw new Error("CPU Worker already initialized");
            options["screen_adapter"] = screen;
            // Fail a missing/invalid core explicitly. The legacy XHR loader can
            // otherwise leave startup pending indefinitely after a 404.
            options.wasm_fn = async env => {
                const primary = options.wasm_path;
                const fallback = options["wasm_fallback_path"] || wasm_fallback_path(primary);
                // (cores in vCPU workers: the relocatable build; "auto" falls
                // back to the cooperative one, and the emulator says why)
                const parallel = emulator && emulator.parallel_requested && options["parallel_wasm_path"];
                const urls = parallel ? [parallel].concat(emulator.parallel_forced ? [] : [primary, fallback]) : [primary, fallback];
                let last_error;
                for(const url of new Set(urls))
                {
                    try
                    {
                        const response = await fetch(url);
                        if(!response.ok) throw new Error("CPU core fetch failed: HTTP " + response.status);
                        const bytes = await response.arrayBuffer();
                        const result = await instantiate_v86(bytes, env);
                        emulator.wasm_source = bytes;
                        return result.instance.exports;
                    }
                    catch(error) { last_error = error; }
                }
                throw last_error;
            };
            // No network or DOM adapters here. Those connect through the bus.
            options.modem = undefined;
            const plugins = options["device_plugins"] || [];
            for(const plugin of plugins) globalThis.importScripts(plugin["script"]);
            options["virtio_devices"] = plugins.map(plugin => {
                const factories = globalThis["V86VirtioDeviceFactories"];
                const create = factories && factories[plugin["name"]];
                if(typeof create !== "function")
                {
                    throw new Error("CPU Worker: " + plugin["script"] + " defines no device " + plugin["name"]);
                }
                return create(device_channel(plugin["name"]));
            });
            // the display adapter's 3D renderer, on the page
            if(options["graphics_adapter_renderer"]) options["graphics_adapter_renderer_channel"] = device_channel("graphics_adapter_renderer");
            options["worker_bus_setup"] = instance => {
                emulator = instance;
                const original = instance.emulator_bus.send.bind(instance.emulator_bus);
                instance.emulator_bus.send = (name, value, transfer) => {
                    if(name === "emulator-ready") stats();
                    original(name, value, undefined);
                    if(name === "dac-send-data") { ++audio_stats["pcm_buffers"]; audio_stats["pcm_samples"] += value[0].length; }
                    if(name === "dac-tell-sampling-rate") audio_rate = value;
                    if(name === "dac-enable") audio_enabled = true;
                    if(name === "dac-disable") audio_enabled = false;
                    if(audio_port)
                    {
                        if(name === "dac-send-data")
                        {
                            audio_send("queue", value, value.map(channel => channel.buffer));
                            return;
                        }
                        if(name === "dac-tell-sampling-rate") { audio_send("rate", value); return; }
                        if(name === "dac-reset") { audio_send("reset", null); return; }
                        if(name === "emulator-started" || name === "emulator-stopped" || name === "dac-enable" || name === "dac-disable")
                            audio_send("enabled", audio_enabled && emulator.is_running());
                    }
                    if(name === "emulator-loaded") return;
                    // The page sends each character's event itself, once its
                    // screen has the character (CPUWorkerController.flush_screen)
                    if(name === "screen-put-char") return;
                    // The screen's changes before an event reach the page before it
                    if(screen_commands.length) flush_screen();
                    if(name === "download-error") value = { "file_name": value.file_name };
                    // Structured clone snapshots buffers before synchronous guest
                    // execution resumes. PCM buffers are independently owned.
                    if(name === "dac-send-data")
                    {
                        const pcm = value.map(channel => channel.slice());
                        send("event", { "name": name, "value": pcm }, pcm.map(channel => channel.buffer));
                    }
                    else send("event", { "name": name, "value": value });
                };
            };
            await new Promise((resolve, reject) => {
                new V86(options);
                emulator.add_listener("emulator-loaded", resolve);
                emulator.add_listener("emulator-error", reject);
            });
            flush_screen();
            stats();
            timer = setInterval(stats, 250);
            // from initial_state
            return take_host_states();
        },
        "audio-attach": async port => {
            audio_port = port;
            audio_port.onmessage = e => {
                const m = e.data;
                if(m["epoch"] !== epoch) return;
                if(m["cpu_audio"] === "reset-done" && m["sequence"] === audio_sequence && audio_reset_done)
                {
                    const done = audio_reset_done; audio_reset_done = null; done();
                }
                if(m["cpu_audio"] === "pump" && audio_enabled && emulator.is_running())
                {
                    ++audio_stats["pump_requests"];
                    emulator.bus.send("dac-request-data");
                }
            };
            await audio_reset();
            audio_send("rate", audio_rate);
            audio_send("enabled", audio_enabled && emulator.is_running());
        },
        "run": () => emulator.run(),
        // (the page goes away: src/disk_service.js)
        "pagehide": () => emulator.pagehide_disks(),
        "stop": async () => { await emulator.stop(); flush_screen(); stats(); },
        "barrier": () => busy(),
        "save": async host_states => {
            if(emulator.is_running() || busy()) throw new Error("Save requires a drained, stopped CPU");
            set_host_states(host_states);
            try { return await emulator.save_state(); }
            finally { set_host_states(null); }
        },
        "restore": async state => {
            if(emulator.is_running() || busy()) throw new Error("Restore requires a drained, stopped CPU");
            await change_epoch();
            await emulator.restore_state(state);
            await audio_reset();
            flush_screen(); stats();
            return take_host_states();
        },
        "save-stream": async (host_states, port) => {
            if(emulator.is_running() || busy()) throw new Error("Save requires a drained, stopped CPU");
            const stream = state_stream_client(port);
            set_host_states(host_states);
            try { await emulator.save_state_stream(stream["write"]); }
            finally { set_host_states(null); stream["close"](); }
        },
        "restore-stream": async (size, port) => {
            if(emulator.is_running() || busy()) throw new Error("Restore requires a drained, stopped CPU");
            const stream = state_stream_client(port);
            try
            {
                await change_epoch();
                await emulator.restore_state_stream({ "size": size, "read": stream["read"] });
                await audio_reset();
                flush_screen(); stats();
                return take_host_states();
            }
            finally { stream["close"](); }
        },
        "restart": async reason => { await change_epoch(); await emulator.restart(reason); await audio_reset(); flush_screen(); stats(); },
        "power_button": () => emulator.power_button(),
        "power_state": () => emulator.power_state(),
        "get_diagnostics": () => emulator.get_diagnostics(),
        "destroy": async () => { clearInterval(timer); await emulator.destroy(); audio_port?.close(); },
        "read_memory": (offset, length) => emulator.read_memory(offset, length).slice(),
        "write_memory": (bytes, offset) => emulator.write_memory(bytes, offset),
        "memory_dump": () => emulator.v86.cpu.mem8.slice(),
        "disk-info": name => emulator.disk_image_info(name),
        "export-disk": async (name, port, options) => {
            const stream = state_stream_client(port);
            try { return await emulator.export_disk_image(name, { write: stream["write"], format: options && options["format"] }); }
            finally { stream["close"](); }
        },
        "disk": name => {
            const buffer = disk(name);
            // (a local file read in parts, which has no buffer: the file with
            // the blocks written, a File the page gets without a copy)
            if(buffer.get_as_file) return buffer.get_as_file(buffer.file.name);
            return new Promise(resolve => buffer.get_buffer(bytes => resolve(bytes?.slice(0))));
        },
        "set_fda": file => emulator.set_fda(file), "set_fdb": file => emulator.set_fdb(file),
        "set_cdrom": file => emulator.set_cdrom(file),
        "eject_fda": () => emulator.eject_fda(), "eject_fdb": () => emulator.eject_fdb(),
        "eject_cdrom": () => emulator.eject_cdrom(),
        "get_cdrom_state": () => emulator.get_cdrom_state(),
        "attach_sata_drive": (port, file, options) => emulator.attach_sata_drive(port, file || null, options),
        "detach_sata_drive": port => emulator.detach_sata_drive(port),
        "attach_pcie_device": port => emulator.attach_pcie_device(port),
        // (answered once the removal started: one through the attention
        // button waits for the guest, and the commands after it must not;
        // its end comes as the result for done_id)
        "detach_pcie_device": (port, options, done_id) => {
            emulator.detach_pcie_device(port, options).then(
                () => send("result", { "id": done_id, "value": undefined }),
                error => send("result", { "id": done_id, "error": String(error?.stack || error) }));
        },
        "get_disk_fda": () => emulator.get_disk_fda()?.slice() || null, "get_disk_fdb": () => emulator.get_disk_fdb()?.slice() || null,
        "create_file": (name, bytes) => emulator.create_file(name, bytes),
        "read_file": async name => (await emulator.read_file(name))?.slice(),
        "audio-info": () => ({ ...audio_stats, "direct": !!audio_port, "sample_rate": audio_rate }),
        "get_instruction_stats": () => emulator.get_instruction_stats(),
        "get_jit_info": () => emulator.get_jit_info(),
    };
    globalThis.onmessage = e => {
        const m = e.data;
        if(m["type"] === "rpc")
        {
            const work = command_chain.then(async () => {
                const fn = methods[m["method"]];
                if(!fn || !Object.prototype.hasOwnProperty.call(methods, m["method"])) throw new Error("Unknown worker method");
                return fn(...m["args"]);
            });
            command_chain = work.then(value => {
                const transfer = value instanceof ArrayBuffer ? [value] :
                    ArrayBuffer.isView(value) ? [value.buffer] : [];
                send("result", { "id": m["id"], "value": value }, transfer);
            }, error => send("result", { "id": m["id"], "error": String(error?.stack || error) }));
            return;
        }
        if(m["epoch"] !== epoch || !emulator?.v86) return;
        try
        {
            switch(m["type"])
            {
                case "event":
                    if(m["name"] !== "dac-request-data" || !audio_port) emulator.bus.send(m["name"], m["value"]);
                    break;
                case "frame":
                    frame_layers = [];
                    emulator.v86.cpu.devices.display?.request_frame(!!m["full"]);
                    send("frame", { "layers": frame_layers }, frame_layers.map(l => l["pixels"].buffer));
                    frame_layers = [];
                    break;
                case "device": {
                    const handler = device_handlers.get(m["name"]);
                    if(handler) handler(m["message"]);
                    break;
                }
            }
        }
        catch(error) { fatal(error); }
    };
}
