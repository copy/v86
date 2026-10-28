// The arm64 CPU of the virt machine (docs/arm64-virt-android16-plan.md P1.2):
// the JavaScript side of the ARM core (build/v86-arm64.wasm), with the
// interface src/main.js, src/browser/starter.js and src/state.js use of a CPU
// (init, run_cores, the clock, devices, snapshots, guest memory). Cores in
// vCPU workers (parallel) come with P8.2; until then the parallel members are
// empty. The x86 CPU is src/cpu.js.

import { dbg_assert, dbg_log } from "../log.js";
import { LOG_CPU, WASM_TABLE_OFFSET } from "../const.js";
import { set_jit_switches } from "../jit_switches.js";
import { relaxed_fma_fused } from "../cpu.js";
import { view, Bitmap } from "../lib.js";
import { v86 } from "../main.js";
import { MachineClock } from "../machine_clock.js";
import { check_machine_options } from "../machine_options.js";
import { CORE_STATE_RANGES, STATE_OFFSETS } from "./state_layout.js";
import { VirtDeviceSpace } from "../virt/io.js";
import {
    A64_PROFILES, ARM32_PROFILES, VIRT_LAYOUT_VERSION, VIRT_MMIO, VIRT_MMIO_COUNT, VIRT_MMIO_SIZE, VIRT_PCIE_ECAM_HIGH, VIRT_PCIE_ECAM_SIZE,
    VIRT_PCIE_MMIO, VIRT_PCIE_MMIO_HIGH, VIRT_PCIE_MMIO_HIGH_SIZE, VIRT_PCIE_MMIO_SIZE, VIRT_RAM_BASE, virt_machine,
    VIRT_EXTENDED_RAM_BASE, VIRT_EXTENDED_RAM_END,
} from "../virt/platform.js";
import { PCI } from "../pci.js";
import { ExtendedStore } from "../extended_memory.js";
import { PL011 } from "../virt/pl011.js";
import { PL031 } from "../virt/pl031.js";
import { GoldfishFb, GoldfishEvents, GoldfishBattery, GoldfishAudio, GoldfishPipe } from "../virt/goldfish.js";
import { BackdoorA32, BACKDOOR_NOT_HANDLED } from "./backdoor_a32.js";
import {
    RANCHU_DISPLAY, RANCHU_GOLDFISH_AUDIO, RANCHU_GOLDFISH_BATTERY, RANCHU_GOLDFISH_EVENTS, RANCHU_GOLDFISH_FB, RANCHU_GOLDFISH_PIPE,
    RANCHU_LAYOUT_VERSION, RANCHU_RTC, RANCHU_SPI, ranchu_framebuffer,
} from "../virt/ranchu.js";
import { load_linux } from "../virt/loader.js";
import { VirtioMmio } from "../virtio_mmio.js";
import { VirtioBlk } from "../virtio_blk.js";
import { drop_disk_holds } from "../block_backend.js";
import { VirtioRng } from "../virtio_rng.js";
import { VirtioNet } from "../virtio_net.js";
import { VirtioConsole } from "../virtio_console.js";
import { VirtioInput } from "../virtio_input.js";
import { VirtioVsock } from "../virtio_vsock.js";
import { VirtioSnd } from "../virtio_snd.js";
import { DisplayHub } from "../display.js";
import { GraphicsAdapter, graphics_adapter_of_state } from "../graphics_adapter.js";
import { GLES_PLUGINS, PluginDevice, plugin_of_state } from "../device_plugin.js";
import { ParallelMachine } from "../parallel/machine.js";
import { COMMAND_RELOAD, COMMAND_RESET } from "../parallel/control.js";

/** The devices in a snapshot's state[4], in this order */
const DEVICE_ORDER = ["pl011", "pl031", "goldfish_fb", "goldfish_events", "goldfish_battery", "goldfish_audio", "goldfish_pipe"];

/** (src/state.js: one buffer holds at most 2 GiB) */
const STATE_MAX_SINGLE_BUFFER = 0x7FFFFFFF;

/**
 * Device memory after RAM, with a display adapter (virtio-gpu's host
 * visible memory, P7.1: 128 MiB, Venus's; more when the adapter's level
 * asks for it, its descriptor's device_memory_size: gfxstream's 256 MiB)
 */
const DEVICE_MEMORY_SIZE = 128 << 20;
/** Device memory regions start at multiples of this (src/rust/aarch64/bus.rs, a64_device_take_dirty) */
const DEVICE_MEMORY_ALIGN = 256 << 10;

/**
 * @constructor
 * @param {Object} bus
 * @param {Object} wm the ARM core: {exports, wasm_table}
 * @param {function()} stop_idling
 */
export function A64CPU(bus, wm, stop_idling)
{
    dbg_assert(wm.exports["isa_aarch64"], "A64CPU needs the ARM core (v86-arm64.wasm)");
    this.stop_idling = stop_idling;
    this.wm = wm;
    this.bus = bus;
    this.clock = new MachineClock({ now: v86.microtick });
    this.in_cpu = false;
    this.cpu_type = "arm64";
    this.machine_type = "virt";

    const memory = this.wm.exports.memory;
    this.wasm_memory = memory;
    const state_base = this.state_base = this.wm.exports["state_base"]() >>> 0;
    this.instruction_counter = view(Uint32Array, memory, state_base + STATE_OFFSETS.instruction_counter, 1);

    /** cores in vCPU workers: P8.2 */
    this.parallel = null;
    this.parallel_fallback = "";
    // extended RAM (configure_extended_memory)
    this.extended_pages = 0;
    this.extended_base = 0;
    /** @type {ExtendedStore} */
    this.extended_store = null;

    // (src/state.js reads memory_size[0])
    this.memory_size = new Uint32Array(1);
    this.mem8 = new Uint8Array(0);
    this.cores = 1;

    /** @type {!Object} */
    this.devices = {};
    /** @type {?VirtioSnd} the sound device (virtio_sound), its timer the machine's */
    this.virtio_sound = null;
    // (src/main.js: a snapshot waits while host I/O a device started is in
    // flight, the virtio disks' reads and writes; src/state_io.js counts it)
    this["snapshot_io_pending"] = 0;
    /** the device registers (src/virt/io.js) */
    this.io = new VirtDeviceSpace(this.wm.exports);
    /** (the A64 page tier, docs/jit-unification-plan.md J2) publications of an older machine are dropped */
    this.execution_epoch = 0;
    this.ir_sync_publication = false;
    this.create_jit_imports();
}

/** What generated page functions import (module "e"): the core's exports, its memory and, with tail calls, its table */
A64CPU.prototype.create_jit_imports = function()
{
    const jit_imports = Object.create(null);
    jit_imports["m"] = this.wm.exports["memory"];
    for(const name of Object.keys(this.wm.exports))
    {
        if(name.startsWith("_") || name.startsWith("zstd") || name.endsWith("_js")) continue;
        jit_imports[name] = this.wm.exports[name];
    }
    const table = this.wm.wasm_table;
    if(table && this.wm.exports["a64_page_set_chaining"])
    {
        // (module (func (return_call 0)))
        const probe = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 6, 1, 4, 0, 18, 0, 11]);
        const supported = WebAssembly.validate(probe);
        if(supported) jit_imports["t"] = table;
        this.wm.exports["a64_page_set_chaining"](supported ? 1 : 0);
    }
    // (the multiply-adds through relaxed SIMD where they fuse: a64_relaxed_fma)
    this.wm.exports["a64_page_set_relaxed_fma_fused"]?.(relaxed_fma_fused() ? 1 : 0);
    this.jit_imports = jit_imports;
};

/**
 * (env.jit_publish, jitrt::publish) the module of a page function: instantiated
 * (at once with ir_sync_publication), then its table slot set if the core still wants it
 */
A64CPU.prototype.jit_publish = function(client, id, slot, pointer, length)
{
    const wasm = this.wm, exports = wasm.exports, table = wasm.wasm_table;
    const epoch = this.execution_epoch;
    const code = new Uint8Array(exports["memory"].buffer, pointer >>> 0, length >>> 0).slice();
    const current = () => this.execution_epoch === epoch && this.wm === wasm;
    const cancel = () => exports["jit_cancel"](client, id, slot);
    const set = instance => {
        if(!current()) return false;
        const f = instance.exports["f"];
        if(typeof f !== "function" || !exports["jit_install"](client, id, slot))
        {
            cancel();
            return false;
        }
        table.set(slot + WASM_TABLE_OFFSET, f);
        exports["jit_ready"](client, id, slot);
        return true;
    };
    if(this.ir_sync_publication)
    {
        try
        {
            return Promise.resolve(set(new WebAssembly.Instance(new WebAssembly.Module(code), { "e": this.jit_imports })));
        }
        catch(error)
        {
            if(error instanceof WebAssembly.CompileError || error instanceof WebAssembly.LinkError)
            {
                dbg_log("page function rejected: " + error, LOG_CPU);
                if(current()) cancel();
                return Promise.resolve(false);
            }
            this.ir_sync_publication = false;
        }
    }
    return WebAssembly.instantiate(code, { "e": this.jit_imports }).then(result => set(result.instance), error => {
        dbg_log("page function rejected: " + error, LOG_CPU);
        if(current()) cancel();
        return false;
    });
};

/** (env.jit_clear_func) a slot of a retired function */
A64CPU.prototype.jit_clear_func = function(index)
{
    this.wm.wasm_table.set(index + WASM_TABLE_OFFSET, null);
};

/** The shared imports the ARM core needs besides those of src/browser/starter.js */
A64CPU.prototype.imports = function()
{
    return {
        "a64_mmio_read": (owner, offset, width) => this.io.mmio_read(owner, offset, width),
        "a64_mmio_write": (owner, offset, width, value) => this.io.mmio_write(owner, offset, width, value),
        "a32_backdoor": (r0, r1, r2, r3) => this.backdoor_call(r0, r1, r2, r3),
    };
};

/**
 * (env.a32_backdoor) A GLES backdoor call of user code (src/arm/backdoor_a32.js):
 * r0's answer, or BACKDOOR_NOT_HANDLED without the backdoor
 * @return {number}
 */
A64CPU.prototype.backdoor_call = function(r0, r1, r2, r3)
{
    return this.devices.backdoor ? this.devices.backdoor.call(r0 >>> 0, r1 >>> 0, r2 >>> 0, r3 >>> 0) : BACKDOOR_NOT_HANDLED;
};

/**
 * The physical address of a user address for a read or a write, as the
 * running core translates it; -1: not mapped for that access
 * @param {number} address
 * @param {boolean} write
 * @return {number}
 */
A64CPU.prototype.translate_user = function(address, write)
{
    return this.wm.exports["a32_backdoor_translate"](address >>> 0, write);
};

A64CPU.prototype.init = function(settings, device_bus)
{
    const { machine_type, cpu_profile } = check_machine_options(settings);
    if(machine_type !== "virt" && machine_type !== "ranchu")
    {
        throw new Error("The ARM CPU runs machine_type \"virt\" or \"ranchu\"");
    }
    /** "virt", or "ranchu": the Android emulator's board (src/virt/ranchu.js) */
    this.machine_type = machine_type;
    const ranchu = machine_type === "ranchu";
    const { cores, memory_size } = virt_machine(settings);
    this.cores = cores;
    // (cpu_type "arm32": AArch32 throughout, docs/aarch32-plan.md part 2)
    this.cpu_type = settings["cpu_type"] === "arm32" ? "arm32" : "arm64";
    // the CPU model's profile (cpu_profile; docs/arm64-virt-android16-plan.md,
    // "CPU profile"): generic-arm64 is v2 (v1.1 and FEAT_PAN, the default
    // since 2026-10-20), -v1.1 the 4, 16 and 64 KiB granules (P8.6), -v1
    // 4 KiB only, -compat32 v3 (AArch32 at EL0); arm32's own
    this.set_profile((this.cpu_type === "arm32" ? ARM32_PROFILES : A64_PROFILES)[cpu_profile][0]);
    // the A64 page tier (J2): synchronous publication (tests), the JIT switches by name
    this.ir_sync_publication = settings["ir_sync_publication"] === true;
    set_jit_switches(this.wm.exports, this.wasm_memory, settings["jit_switches"]);
    // (the GIC's distributor and redistributors: decoded in the core, P4.2;
    // ranchu's with a 32-bit kernel a GICv2's distributor and CPU interface)
    /** whether the GIC is a GICv2 (ranchu with a 32-bit kernel) */
    this.gic_v2 = ranchu && this.cpu_type === "arm32";
    this.wm.exports["a64_gic_set_version"]?.(this.gic_v2 ? 2 : 3);
    if(!this.wm.exports["a64_set_cores"](cores)) throw new Error("the GIC's frames overlap a device");
    if(settings.cpu_clock) this.clock = new MachineClock(Object.assign({ now: v86.microtick }, settings.cpu_clock));
    // The display adapter's plugin descriptor (P7.1: virtio-gpu without VGA); none with graphics_adapter: "none"
    this.graphics_adapter_descriptor = settings.graphics_adapter;
    const adapter = this.graphics_adapter_descriptor;
    this.create_memory(memory_size, adapter ? Math.max(DEVICE_MEMORY_SIZE,
        adapter["device_memory_size"]?.({ "test": settings.graphics_adapter_test }) || 0) : 0);
    this.configure_extended_memory(settings.extended_memory_size || 0, settings.extended_memory_cache);
    this.device_bus = device_bus;
    this.devices = {
        "pl011": new PL011(this, device_bus),
        "pl031": ranchu ? new PL031(this, RANCHU_RTC, 32 + RANCHU_SPI.rtc) : new PL031(this),
    };
    // The generic PCIe host bridge (P5.6, P5.10): its configuration through
    // the high ECAM, the BARs in its 32- and 64-bit windows (where no BAR
    // is, reads are all ones, as on the reference); INTx are SPIs that the
    // functions share (set_shared_gsi_level)
    /** @type {!Map<number, !Set<number>>} the functions asserting each shared SPI, by INTID */
    this.shared_spi_sources = new Map();
    // (ranchu: no PCIe host)
    /** @type {!Array<{base: number, size: number, owners: !Array<number>}>} */
    this.pcie_windows = [];
    if(!ranchu)
    {
        const pci = new PCI(/** @type {?} */ (this), { generic: true });
        this.devices["pci"] = pci;
        this.io.register_mmio(VIRT_PCIE_ECAM_HIGH, VIRT_PCIE_ECAM_SIZE, pci.ecam_handler());
        // (the windows: around device memory mapped into them, update_windows)
        this.pcie_windows = [
            { base: VIRT_PCIE_MMIO, size: VIRT_PCIE_MMIO_SIZE, owners: [] },
            { base: VIRT_PCIE_MMIO_HIGH[1] * 0x100000000 + VIRT_PCIE_MMIO_HIGH[0], size: VIRT_PCIE_MMIO_HIGH_SIZE, owners: [] },
        ];
        this.update_windows();
    }
    // The virtio-mmio slots (P5.3): a slot without a device reads as the
    // reference's empty one ("virt", version 2, device ID 0, "QEMU"), which
    // Linux skips; devices take the slots from the last one down, in the
    // order of the reference's -device options: the disks, then net, rng,
    // console (tests/a64/linux_boot.mjs)
    /** @type {!Array<VirtioMmio>} by slot */
    this.virtio_mmio = new Array(VIRT_MMIO_COUNT).fill(null);
    /** @type {!Array<number>} the slots' owners (src/virt/io.js) */
    this.virtio_mmio_slots = [];
    for(let n = 0; n < VIRT_MMIO_COUNT; n++)
    {
        const slot = n;
        this.virtio_mmio_slots.push(this.io.register_mmio(VIRT_MMIO + n * VIRT_MMIO_SIZE, VIRT_MMIO_SIZE, {
            name: "virtio-mmio",
            read: (offset, width) => this.virtio_mmio[slot] ? this.virtio_mmio[slot].read(offset, width) :
                width === 4 ? [0x74726976, ranchu ? 1 : 2, 0, 0x554D4551][offset >> 2] ?? 0 : 0,
            write: (offset, width, value) => { this.virtio_mmio[slot]?.write(offset, width, value); },
        }));
    }
    // The virtio devices' transport (P5.7): virtio-mmio, or virtio-pci on the
    // PCIe host, where they take slot 1 on (00:01.0, 00:02.0, ...) in the same
    // order, as the reference's -device virtio-*-pci options do
    /** @type {string} */
    this.virtio_transport = settings.virtio_transport || "mmio";
    /** @type {!Array<{slot: number, name: string, device: !Object}>} in order: from the last virtio-mmio slot, or from PCI slot 1 */
    this.virtio_devices = [];
    // (on the PCIe host the display adapter may take a slot of its own, which
    // the others skip: Cuttlefish's sepolicy expects its GPU at 00:02.0, P10.7)
    const gpu_slot = this.virtio_transport === "pci" && this.graphics_adapter_descriptor && settings.virtio_gpu_pci_slot || 0;
    const pci_slot = n => 1 + n + (gpu_slot && 1 + n >= gpu_slot ? 1 : 0);
    const add = (name, create) =>
    {
        let device, slot;
        if(this.virtio_transport === "pci")
        {
            slot = pci_slot(this.virtio_devices.length);
            device = create(null, slot << 3);
        }
        else
        {
            slot = VIRT_MMIO_COUNT - 1 - this.virtio_devices.length;
            // (SPI 16 + slot, as the reference's)
            const transport = new VirtioMmio(this, slot, 32 + 16 + slot, ranchu);
            this.virtio_mmio[slot] = transport;
            device = create(transport, undefined);
        }
        this.virtio_devices.push({ slot, name, device });
        return device;
    };
    // (hda and hdb, given instead, are the first two; the disks' names, as
    // export_disk_image takes them: virtio_disk<n>, or hda and hdb)
    const disks = settings.virtio_disks && settings.virtio_disks.length ?
        settings.virtio_disks.map((disk, i) => ({ buffer: disk.buffer, id: disk.id, readonly: disk.readonly, name: "virtio_disk" + i })) :
        [["hda", settings.hda], ["hdb", settings.hdb]].filter(([, buffer]) => buffer)
            .map(([name, buffer]) => ({ buffer, id: undefined, readonly: false, name }));
    for(const disk of disks)
    {
        add("virtio-blk", (transport, pci_id) => new VirtioBlk(this, disk.buffer, disk, transport, pci_id));
    }
    if(settings.net_device && settings.net_device.type === "virtio")
    {
        // (the PC's devices take a CPU: what they use of it, the ARM CPU has)
        // (net_device.count: that many functions, net0, net1, ... on the bus:
        // Android's three, as Cuttlefish's, P11.2; the relay takes net_device.id's)
        for(let id = 0; id < (settings.net_device.count || 1); id++)
        {
            add("virtio-net", (transport, pci_id) => new VirtioNet(/** @type {?} */ (this), device_bus, settings.preserve_mac_from_state_image,
                settings.net_device.mtu, pci_id, transport || undefined, id));
        }
    }
    if(settings.virtio_rng) add("virtio-rng", (transport, pci_id) => new VirtioRng(this, transport, pci_id));
    if(settings.virtio_console)
    {
        // (ports 1-3 generic: the host service channels, P9.1; or
        // virtio_console_ports consoles, P10.7)
        const ports = settings.virtio_console_ports;
        add("virtio-console", (transport, pci_id) => new VirtioConsole(/** @type {?} */ (this), device_bus, pci_id, transport || undefined,
            !ports, ports || undefined));
    }
    // (P5.8, P7.4: a keyboard and a tablet, or the kinds listed, as the
    // reference's virtio-keyboard, virtio-tablet and virtio-multitouch)
    if(settings.virtio_input)
    {
        const kinds = Array.isArray(settings.virtio_input) ? settings.virtio_input : ["keyboard", "tablet"];
        // (a touch screen without a tablet beside it takes the mouse as a finger: Android's preset has no tablet)
        const mouse_as_touch = !kinds.includes("tablet");
        for(const kind of kinds)
        {
            add("virtio-" + kind, (transport, pci_id) => new VirtioInput(this, device_bus, kind, transport, pci_id, mouse_as_touch));
        }
    }
    // (P10.7: stream sockets to the guest, its adbd's vsock:5555)
    if(settings.virtio_vsock) add("virtio-vsock", (transport, pci_id) => new VirtioVsock(this, device_bus, transport, pci_id));
    // (P7.5, P12.5: sound, one output stream, played on the machine's clock)
    this.virtio_sound = settings.virtio_sound ? add("virtio-snd", (transport, pci_id) => new VirtioSnd(this, device_bus, transport, pci_id)) : null;
    // The display adapter (P7.1): virtio-gpu without VGA, after the virtio
    // devices (the next PCI slot, or virtio-mmio slot), on the display hub
    if(this.graphics_adapter_descriptor)
    {
        this.devices.display = new DisplayHub(device_bus, settings.screen);
        const slot = this.virtio_transport === "pci" ? gpu_slot || pci_slot(this.virtio_devices.length) :
            VIRT_MMIO_COUNT - 1 - this.virtio_devices.length;
        const transport = this.virtio_transport === "pci" ? null : new VirtioMmio(this, slot, 32 + 16 + slot, ranchu);
        if(transport) this.virtio_mmio[slot] = transport;
        this.graphics_adapter_slot = slot;
        this.devices.graphics_adapter = new GraphicsAdapter(/** @type {?} */ (this), this.graphics_adapter_descriptor, {
            vram_size: settings.vram_size, test: settings.graphics_adapter_test, renderer: settings.graphics_adapter_renderer,
            pci_id: transport ? undefined : slot << 3, transport,
        });
        if(transport)
        {
            // (on virtio-mmio its memory has no BAR: at the top of the 64-bit
            // window, which nothing else uses then; the SHM registers say where)
            const virtio = this.devices.graphics_adapter.pci_device;
            const window = this.pcie_windows[1];
            let top = window.base + window.size;
            const bases = [];
            virtio.pci_bars.forEach((bar, i) => {
                if(!bar || !bar.on_move) return;
                top = Math.floor((top - bar.size) / bar.size) * bar.size;
                bases[i] = top;
                bar.on_move(top);
            });
            for(const region of transport.shared_memory_regions())
            {
                transport.set_shared_memory_base(region.id, bases[region.bar] + region.offset);
            }
        }
    }
    // The ranchu machine's goldfish devices (src/virt/goldfish.js): the
    // framebuffer on a display hub of its own, the events, the battery, the
    // audio output and the pipe with the boot properties, and with
    // ranchu_gpu "host" the GLES host's services (src/gles/plugin.js)
    if(ranchu)
    {
        this.devices.display = new DisplayHub(device_bus, settings.screen);
        const display = /** @type {{width: number, height: number, dpi: number}} */ (Object.assign({}, RANCHU_DISPLAY, settings.ranchu_display));
        // (arm32: a simple-framebuffer, src/virt/goldfish.js)
        /** @type {?{base: number, size: number, width: number, height: number}} */
        this.ranchu_framebuffer = this.cpu_type === "arm32" ? ranchu_framebuffer(memory_size, display) : null;
        this.devices["goldfish_fb"] = new GoldfishFb(this, RANCHU_GOLDFISH_FB, 32 + RANCHU_SPI.fb, display,
            this.ranchu_framebuffer ? this.ranchu_framebuffer.base : 0);
        this.devices["goldfish_events"] = new GoldfishEvents(this, device_bus, RANCHU_GOLDFISH_EVENTS, 32 + RANCHU_SPI.events);
        this.devices["goldfish_battery"] = new GoldfishBattery(this, RANCHU_GOLDFISH_BATTERY);
        this.devices["goldfish_audio"] = new GoldfishAudio(this, RANCHU_GOLDFISH_AUDIO, 32 + RANCHU_SPI.audio);
        if(settings.gles_plugin)
        {
            this.devices.gles = new PluginDevice(/** @type {?} */ (this), GLES_PLUGINS, settings.gles_plugin, -1, {}, {
                "display": { "width": display.width, "height": display.height, "dpi": display.dpi },
                // (the page's renderer: graphics_adapter is "none" on ranchu, so the channel is the GLES host's)
                "renderer": settings.graphics_adapter_renderer || null,
                // (the posted frames the page read back: the framebuffer device shows them)
                "present": (rgba, width, height) => this.devices["goldfish_fb"].present(rgba, width, height),
                // (its plugin's prepare: glslang, docs/gles3-plan.md)
                "prepared": settings.gles_prepared || null,
                "max_version": settings.ranchu_gles_version || "2.0",
            });
        }
        const gles = this.devices.gles;
        this.devices["goldfish_pipe"] = new GoldfishPipe(this, RANCHU_GOLDFISH_PIPE, 32 + RANCHU_SPI.pipe, Object.assign({
            "qemu.sf.lcd_density": String(display.dpi), "qemu.hw.mainkeys": "0",
        }, settings.ranchu_properties), gles ? (name, wake, ...saved) => gles.device["service"](name, wake, ...saved) : undefined);
    }
    // arm32's GLES backdoor (gles_backdoor: docs/gles-proxy-plan.md "iOS 传输"):
    // the GLES host's services for user code, no screen of its own (its
    // posts are not shown; the test reads its pixels back)
    if(settings.gles_backdoor && settings.gles_plugin)
    {
        this.devices.gles = this.devices.gles || new PluginDevice(/** @type {?} */ (this), GLES_PLUGINS, settings.gles_plugin, -1, {}, {
            "display": { "width": 800, "height": 600, "dpi": 160 },
            "renderer": settings.graphics_adapter_renderer || null,
            "present": () => {},
            "prepared": settings.gles_prepared || null,
            "max_version": settings.ranchu_gles_version || "2.0",
        });
        const gles = this.devices.gles;
        this.devices.backdoor = new BackdoorA32(this, (name, wake, ...saved) => gles.device["service"](name, wake, ...saved));
    }
    // the boot core starts at the kernel (P4.6: the device tree in x0, P4.2)
    this.booted = false;
    /** @type {Object} what the machine boots, loaded again at a reset */
    this.boot_files = null;
    if(settings.kernel)
    {
        // (kept: a reset loads them again, P4.6)
        this.boot_files = { kernel: settings.kernel, initrd: settings.initrd, cmdline: settings.cmdline, dtb: settings.dtb, cores };
        const { entry, x0 } = load_linux(this, this.boot_files);
        this.boot(entry, x0);
    }
};

/**
 * Reset the cores; core 0 starts at `entry` with x0 = `x0`
 * @param {number} entry
 * @param {number} x0
 */
A64CPU.prototype.boot = function(entry, x0)
{
    if(this.cpu_type === "arm32")
    {
        // (a 32-bit kernel: SVC mode, r0 0, r1 ~0 (a device tree, not a board), r2 the device tree)
        this.wm.exports["a32_boot"](entry >>> 0, x0 >>> 0);
    }
    else
    {
        this.wm.exports["a64_boot"](entry >>> 0, Math.floor(entry / 0x100000000), x0 >>> 0, Math.floor(x0 / 0x100000000));
    }
    this.boot_entry = entry;
    this.boot_x0 = x0;
    this.booted = true;
};

/**
 * Guest RAM of `size` bytes at 0x4000_0000, and after it in guest memory
 * `device_size` bytes of device memory (mmio_ram_allocate)
 * @param {number} size
 * @param {number=} device_size
 */
A64CPU.prototype.create_memory = function(size, device_size = 0)
{
    const exports = this.wm.exports;
    // (one allocation in the 32-bit Wasm memory: below 2 GiB; more RAM is
    // docs/arm64-virt-android16-plan.md P8)
    if(size + device_size >= 0x80000000)
    {
        throw new Error("memory_size: the arm64 core takes less than 2 GiB of RAM (" + size + " bytes" +
            (device_size ? ", and " + device_size + " bytes of the display adapter's device memory" : "") + ")");
    }
    const pointer = exports["a64_allocate_memory"](size + device_size) >>> 0;
    if(!exports["a64_bus_set_ram"](size)) throw new Error("create_memory: RAM of " + size + " bytes does not fit");
    this.mem8 = view(Uint8Array, this.wasm_memory, pointer, size);
    this.memory_size[0] = size;
    /** device memory: [start, end) in guest memory's backing, and its regions */
    this.device_memory = { start: size, end: size + device_size, next: size };
    /** @type {!Array<{backing: number, size: number, base: number}>} */
    this.device_regions = [];
    if(device_size && !exports["a64_device_memory"](size)) throw new Error("create_memory: no device memory");
};

// ---- device memory (P7.1): the interface of the x86 core's mmio_ram (src/rust/cpu/mmio_ram.rs)

/**
 * A region of device memory (virtio-gpu's host visible memory)
 * @param {number} size
 * @return {number} the region, or -1
 */
A64CPU.prototype.mmio_ram_allocate = function(size)
{
    const memory = this.device_memory;
    const at = Math.ceil(memory.next / DEVICE_MEMORY_ALIGN) * DEVICE_MEMORY_ALIGN;
    size = Math.ceil(size / 4096) * 4096;
    if(!size || at + size > memory.end) return -1;
    memory.next = at + size;
    this.device_regions.push({ backing: at, size, base: -1 });
    return this.device_regions.length - 1;
};

/** @return {number} the address of the region's memory in the Wasm memory */
A64CPU.prototype.mmio_ram_backing = function(region)
{
    return this.mem8.byteOffset + this.device_regions[region].backing;
};

/**
 * Decode the region at `address` (a BAR's), when all of it is in one of the
 * PCIe host's windows; elsewhere (an unassigned BAR) nowhere
 * @param {number} region
 * @param {number} address
 */
A64CPU.prototype.mmio_ram_map = function(region, address)
{
    const r = this.device_regions[region];
    const inside = this.pcie_windows.some(w => address >= w.base && address + r.size <= w.base + w.size);
    const base = inside ? address : -1;
    if(base === r.base) return;
    if(r.base !== -1) this.wm.exports["a64_bus_unmap"](r.base >>> 0, Math.floor(r.base / 0x100000000));
    r.base = base;
    this.update_windows();
    if(base !== -1 && !this.wm.exports["a64_bus_map_device"](base >>> 0, Math.floor(base / 0x100000000), r.size >>> 0, 0, r.backing))
    {
        dbg_log("device memory at 0x" + base.toString(16) + " overlaps a region", LOG_CPU);
        r.base = -1;
        this.update_windows();
    }
};

A64CPU.prototype.mmio_ram_unmap = function(region)
{
    this.mmio_ram_map(region, -1);
};

/** @return {number} the address of the words marking the pages the cores wrote (0: none) */
A64CPU.prototype.mmio_ram_take_dirty = function(region)
{
    const r = this.device_regions[region];
    return this.wm.exports["a64_device_take_dirty"](r.backing, r.size);
};

A64CPU.prototype.mmio_ram_mark_dirty = function(region)
{
    const r = this.device_regions[region];
    this.wm.exports["a64_device_mark_dirty"](r.backing, r.size);
};

A64CPU.prototype.mmio_ram_read8 = function(region, offset)
{
    return new Uint8Array(this.wasm_memory.buffer)[this.mmio_ram_backing(region) + offset];
};

A64CPU.prototype.mmio_ram_write8 = function(region, offset, value)
{
    new Uint8Array(this.wasm_memory.buffer)[this.mmio_ram_backing(region) + offset] = value;
};

/**
 * The PCIe host's windows as ranges of the core's address space: each one
 * around the device memory mapped into it (window_handler, src/pci.js)
 */
A64CPU.prototype.update_windows = function()
{
    const pci = this.devices["pci"];
    for(const window of this.pcie_windows)
    {
        for(const owner of window.owners) this.io.unregister_mmio(owner);
        window.owners = [];
        const holes = this.device_regions.filter(r => r.base !== -1 && r.base >= window.base && r.base < window.base + window.size)
            .sort((a, b) => a.base - b.base);
        let at = window.base;
        for(const hole of [...holes, { base: window.base + window.size, size: 0 }])
        {
            if(hole.base > at) window.owners.push(this.io.register_mmio(at, hole.base - at, pci.window_handler(at)));
            at = hole.base + hole.size;
        }
    }
};

/**
 * One turn of the machine: the cores' slices and the timers. Returns the
 * milliseconds until something is due (0: run again at once).
 * @return {number}
 */
A64CPU.prototype.run_cores = function()
{
    if(this.parallel) return this.run_parallel();
    return this.run_machine_core();
};

/** One slice of the cores this instance runs (all, or with cores in workers core 0): milliseconds until it needs to run again */
A64CPU.prototype.run_machine_core = function()
{
    const run = this.wm.exports["a64_run_slice"];
    if(!run || !this.booted) return 100;
    this.in_cpu = true;
    try
    {
        const devices = this.run_hardware_timers(null, this.clock.now());
        const next = Math.min(run(this.clock.now()), devices);
        // (PSCI SYSTEM_RESET: the machine resets and boots again, P4.8)
        if(this.wm.exports["a64_take_reset_request"]()) this.reboot_internal("restart");
        return next;
    }
    finally
    {
        this.in_cpu = false;
    }
};

// ---- cores in vCPU workers (P8.2: src/parallel/machine.js, src/parallel/vcpu_arm.js)

/**
 * Cores 1 and up run in vCPU workers; this thread runs core 0 and the
 * devices, serves the workers' device accesses and stops them at safe
 * points for snapshots, resets and pauses
 * @param {{bytes: Uint8Array, settings: Object, worker_url: (string|URL)}} options
 */
A64CPU.prototype.start_parallel = async function(options)
{
    dbg_assert(this.cores > 1);
    this.parallel = new ParallelMachine(this, options);
    await this.parallel.start();
};

/** @return {number} milliseconds until the machine needs to run again */
A64CPU.prototype.run_parallel = function()
{
    const machine = this.parallel, exports = this.wm.exports;
    // (a failed vCPU stops the machine: v86.prototype.do_tick)
    if(machine.check_failure()) return 0;
    machine.service();
    if(machine.pending_reset)
    {
        machine.request_stop();
        if(!machine.all_parked()) return 0;
        const { reason } = machine.pending_reset;
        machine.pending_reset = null;
        this.reboot_internal(reason);
        return 0;
    }
    if(machine.stopping()) machine.resume();
    // (core 0 takes the other cores' code writes and TLB maintenance; while it
    // waits it counts as idle, crate::parallel::code, crate::aarch64::tlb)
    exports["parallel_idle"](false);
    const t = this.run_machine_core();
    machine.service();
    if(t > 0) exports["parallel_idle"](true);
    return t;
};

/** (src/main.js) the parked workers' cores are read where they are (save_core_state) */
A64CPU.prototype.parallel_capture = function()
{
    dbg_assert(this.parallel.all_parked());
};

/** (src/main.js) after a restore into the workers' state blocks: they drop what derived from the old state */
A64CPU.prototype.parallel_install = function()
{
    dbg_assert(this.parallel.all_parked());
    this.parallel.schedule(COMMAND_RELOAD);
};

/** The state block of core `core`: the running core's, or with cores in workers a worker's (parked) */
A64CPU.prototype.state_block_of = function(core)
{
    const base = this.parallel && core !== 0 ? this.parallel.state_base(core) : this.state_base;
    return new Uint8Array(this.wasm_memory.buffer, base, 4096);
};

/** (env.run_hardware_timers) the virt machine's device timers (the PL031's alarm, the display's); the cores' timers are their own */
A64CPU.prototype.run_hardware_timers = function(acpi, now)
{
    const display = this.devices.display ? this.devices.display.timer(now) : 100;
    const sound = this.virtio_sound ? this.virtio_sound.timer(now) : 100;
    const audio = this.devices["goldfish_audio"] ? this.devices["goldfish_audio"].timer(now) : 100;
    return Math.min(100, display, sound, audio, this.devices["pl031"] ? this.devices["pl031"].timer() : 100);
};

/**
 * A device's interrupt line, an SPI of the GIC (P4.2)
 * @param {number} intid
 * @param {boolean} level
 */
A64CPU.prototype.set_irq = function(intid, level)
{
    this.wm.exports["a64_gic_set_spi"](intid, level);
};

/**
 * A function on the PCIe host drives the SPI its INTx pin is routed to
 * (src/pci.js): the line is high while any function asserts it
 * @param {number} intid
 * @param {number} source the function's pci_id
 * @param {boolean} level
 */
A64CPU.prototype.set_shared_gsi_level = function(intid, source, level)
{
    let sources = this.shared_spi_sources.get(intid);
    if(!sources)
    {
        sources = new Set();
        this.shared_spi_sources.set(intid, sources);
    }
    if(level) sources.add(source);
    else sources.delete(source);
    this.set_irq(intid, sources.size > 0);
};

/**
 * (snapshots) a view of the machine state `which` the core keeps (0 the GIC, 1 PSCI)
 * @param {number} which
 * @return {!Uint8Array}
 */
A64CPU.prototype.machine_state_bytes = function(which)
{
    const exports = this.wm.exports;
    return new Uint8Array(this.wasm_memory.buffer, exports["a64_machine_state"](which, false) >>> 0, exports["a64_machine_state"](which, true));
};

/** Whether the guest turned the machine off (PSCI SYSTEM_OFF, P4.4) */
A64CPU.prototype.powered_off = function()
{
    return !!this.wm.exports["a64_powered_off"]?.();
};

/**
 * A reset (PSCI SYSTEM_RESET, V86.restart), or with reason "power-on" the
 * machine powered on again after SYSTEM_OFF (V86.power_button)
 * @param {string=} reason
 */
A64CPU.prototype.reboot_internal = function(reason)
{
    if(!this.booted) return;
    // (cores in workers: they stop first, run_parallel resets then, and they wait for CPU_ON again)
    if(this.parallel && !this.parallel.all_parked())
    {
        this.parallel.pending_reset = { reason };
        this.parallel.request_stop();
        return;
    }
    if(this.parallel) this.parallel.schedule(COMMAND_RESET);
    if(reason === "power-on")
    {
        // (after PSCI SYSTEM_OFF, P8.1: RAM and device memory do not keep their contents)
        this.mem8.fill(0);
        this.wm.exports["a64_bus_written"](0, this.memory_size[0]);
        new Uint8Array(this.wasm_memory.buffer, this.mem8.byteOffset + this.device_memory.start,
            this.device_memory.end - this.device_memory.start).fill(0);
        this.clear_extended_memory();
    }
    for(const device of Object.values(this.devices)) device.reset?.();
    for(const { device } of this.virtio_devices) device.reset();
    if(this.boot_files)
    {
        const { entry, x0 } = load_linux(this, this.boot_files);
        this.boot(entry, x0);
    }
    else
    {
        this.boot(this.boot_entry, this.boot_x0);
    }
};

// ---- guest memory (P1.6: the machine's DMA facade)

/** @return {boolean} whether [offset, offset + length) of guest memory is zero */
A64CPU.prototype.is_memory_zeroed = function(offset, length)
{
    dbg_assert((offset & 3) === 0 && (length & 3) === 0);
    const words = new Int32Array(this.mem8.buffer, this.mem8.byteOffset + offset, length >> 2);
    for(let i = 0; i < words.length; i++)
    {
        if(words[i] !== 0) return false;
    }
    return true;
};

A64CPU.prototype.zero_memory = function(offset, length)
{
    this.mem8.fill(0, offset, offset + length);
    this.wm.exports["a64_bus_written"](offset, length);
};

/**
 * The guest-memory offset of the physical range [address, address + length)
 * of RAM, or -1 when it is not all RAM
 * @param {number} address a physical address below 2^53
 * @param {number} length
 */
A64CPU.prototype.ram_offset = function(address, length)
{
    const offset = address - VIRT_RAM_BASE;
    return offset >= 0 && offset + length <= this.memory_size[0] ? offset : -1;
};

/** The end of the physical address space: profile v1's 40 bits */
A64CPU.prototype.physical_limit = 0x10000000000;

/** Whether the physical range [address, address + length) is all extended RAM (P8.5) */
A64CPU.prototype.is_extended = function(address, length)
{
    const offset = address - this.extended_base;
    return this.extended_pages !== 0 && offset >= 0 && offset + length <= this.extended_pages * 4096;
};

/**
 * Where a device's DMA to [address, address + length) goes (the machine's
 * DMA facade, P1.6): RAM is one contiguous backing, extended RAM is copied
 * a page at a time
 * @param {number} address
 * @param {number} length
 * @return {number} the offset in guest memory, -1 for extended RAM, or -2 when it is not all RAM
 */
A64CPU.prototype.dma_classify = function(address, length)
{
    if(!Number.isSafeInteger(address) || !Number.isSafeInteger(length) || length <= 0) return -2;
    const offset = this.ram_offset(address, length);
    return offset >= 0 ? offset : this.is_extended(address, length) ? -1 : -2;
};

/**
 * Read guest RAM at a physical address (V86.read_memory)
 * @param {number} address
 * @param {number} length
 * @return {!Uint8Array}
 */
A64CPU.prototype.read_blob_physical = function(address, length)
{
    const offset = this.ram_offset(address, length);
    if(offset >= 0) return this.mem8.slice(offset, offset + length);
    if(!this.is_extended(address, length))
    {
        throw new RangeError("read_blob_physical: [0x" + address.toString(16) + ", +" + length + ") is not RAM");
    }
    const result = new Uint8Array(length);
    for(let done = 0; done < length;)
    {
        const count = Math.min(length - done, 4096 - (address + done) % 4096);
        result.set(this.extended_page_bytes(address + done, count, false), done);
        done += count;
    }
    return result;
};

/**
 * Write guest RAM at a physical address (V86.write_memory, the loaders,
 * devices' DMA): code compiled from it retires
 * @param {!Uint8Array|!Array<number>} blob
 * @param {number} address
 */
A64CPU.prototype.write_blob_physical = function(blob, address)
{
    const offset = this.ram_offset(address, blob.length);
    if(offset >= 0)
    {
        this.mem8.set(blob, offset);
        this.wm.exports["a64_bus_written"](offset, blob.length);
        return;
    }
    if(!this.is_extended(address, blob.length))
    {
        throw new RangeError("write_blob_physical: [0x" + address.toString(16) + ", +" + blob.length + ") is not RAM");
    }
    const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
    for(let done = 0; done < bytes.length;)
    {
        const count = Math.min(bytes.length - done, 4096 - (address + done) % 4096);
        this.extended_page_bytes(address + done, count, bytes.subarray(done, done + count));
        done += count;
    }
};

/**
 * Copy bytes of one page of extended RAM (DMA, debugging): its frame is
 * pinned meanwhile; a write retires code compiled from the page and clears
 * every core's reservations in it (src/rust/aarch64/extended.rs)
 * @param {number} address guest physical, in extended RAM
 * @param {number} count bytes within the page
 * @param {Uint8Array|boolean} write the bytes to write, or false to read
 * @return {!Uint8Array} the bytes read
 */
A64CPU.prototype.extended_page_bytes = function(address, count, write)
{
    const page = Math.floor((address - this.extended_base) / 4096);
    // (an i32: the frame pool may lie above 2 GiB)
    const frame = this.wm.exports["a64_ext_pin"](page, !!write) >>> 0;
    dbg_assert(frame !== 0 && address % 4096 + count <= 4096);
    const bytes = new Uint8Array(this.wasm_memory.buffer, frame + address % 4096, count);
    let result = bytes;
    if(write) bytes.set(/** @type {!Uint8Array} */ (write));
    else result = bytes.slice();
    this.wm.exports["a64_ext_unpin"](page);
    return result;
};

/** @throws {RangeError} unless [address, address + length) is all RAM (VirtQueue) */
A64CPU.prototype.validate_physical_range = function(address, length)
{
    // (RAM or extended RAM, which the facade copies a page at a time: a
    // virtqueue or a buffer above 4 GiB with 4 GiB of RAM)
    if(length && this.dma_classify(address, length) === -2)
    {
        throw new RangeError("[0x" + address.toString(16) + ", +" + length + ") is not RAM");
    }
};

/** The guest-memory offset of a scalar's RAM, -1 in extended RAM, or a RangeError (devices' DMA) */
A64CPU.prototype.scalar_offset = function(address, bytes)
{
    const offset = this.dma_classify(address, bytes);
    if(offset === -2) throw new RangeError("0x" + address.toString(16) + " is not RAM");
    return offset;
};
/** A scalar of `bytes` bytes at `address` (devices' DMA) */
A64CPU.prototype.read_scalar_physical = function(address, bytes)
{
    const o = this.scalar_offset(address, bytes);
    const b = o >= 0 ? this.mem8.subarray(o, o + bytes) : this.read_blob_physical(address, bytes);
    let value = 0;
    for(let i = 0; i < bytes; i++) value |= b[i] << 8 * i;
    return value >>> 0;
};
A64CPU.prototype.read8_physical = function(address) { return this.read_scalar_physical(address, 1); };
A64CPU.prototype.read16_physical = function(address) { return this.read_scalar_physical(address, 2); };
A64CPU.prototype.read32_physical = function(address) { return this.read_scalar_physical(address, 4); };
/** A scalar's bytes at `address`: code compiled from them retires, other cores' reservations clear */
A64CPU.prototype.write_scalar_physical = function(address, value, bytes)
{
    const o = this.scalar_offset(address, bytes);
    const b = new Uint8Array(bytes);
    for(let i = 0; i < bytes; i++) b[i] = value >>> 8 * i & 0xFF;
    if(o < 0)
    {
        this.write_blob_physical(b, address);
        return;
    }
    this.mem8.set(b, o);
    this.wm.exports["a64_bus_written"](o, bytes);
};
A64CPU.prototype.write8_physical = function(address, value) { this.write_scalar_physical(address, value, 1); };
A64CPU.prototype.write16_physical = function(address, value) { this.write_scalar_physical(address, value, 2); };
A64CPU.prototype.write32_physical = function(address, value) { this.write_scalar_physical(address, value, 4); };

// ---- extended RAM (P8.5)

/**
 * RAM beyond guest memory (extended RAM): `size` bytes at guest physical
 * 4 GiB (the device tree's second memory range), kept in an ExtendedStore
 * (src/extended_memory.js) and cached in `cache_size` bytes of frames
 * (src/rust/aarch64/extended.rs)
 * @param {number} size
 * @param {number=} cache_size
 */
A64CPU.prototype.configure_extended_memory = function(size, cache_size)
{
    this.extended_pages = 0;
    this.extended_base = 0;
    this.extended_store = null;
    if(!size) return;
    if(!Number.isSafeInteger(size) || size < 0 || size % (2 << 20))
    {
        throw new Error("extended_memory_size must be a multiple of 2 MiB");
    }
    const base = VIRT_EXTENDED_RAM_BASE;
    if(base + size > VIRT_EXTENDED_RAM_END)
    {
        throw new Error("extended_memory_size: the virt machine's RAM ends at 256 GiB (at most " + (VIRT_EXTENDED_RAM_END - base) + " bytes)");
    }
    const cache = Math.min(size, cache_size || 512 << 20);
    if(!Number.isSafeInteger(cache) || cache < 1 << 20 || cache % 4096)
    {
        throw new Error("extended_memory_cache must be a multiple of 4 KiB and at least 1 MiB");
    }
    let store;
    try
    {
        store = new ExtendedStore(size / 4096);
    }
    catch(e)
    {
        throw new Error("extended_memory_size: the host cannot allocate " + size + " bytes (" + e.message + ")");
    }
    // (before the first access: extended_load reads the store)
    this.extended_store = store;
    if(!this.wm.exports["a64_ext_configure"](base >>> 0, Math.floor(base / 0x100000000), size / 4096, cache / 4096))
    {
        this.extended_store = null;
        throw new Error("extended_memory_size: cannot allocate the frame cache");
    }
    this.extended_pages = size / 4096;
    this.extended_base = base;
};

/** Extended RAM reads as zero again (power-on, a restore); every core is stopped */
A64CPU.prototype.clear_extended_memory = function()
{
    if(!this.extended_store) return;
    this.wm.exports["a64_ext_discard"]();
    this.extended_store.clear();
    // (code compiled from it)
    this.wm.exports["jit_clear_cache_js"]();
};

/** Every dirty frame back into the store (src/state.js: a snapshot stream) */
A64CPU.prototype.flush_extended_memory = function()
{
    this.wm.exports["a64_ext_flush"]();
};

// ---- snapshots (P1.9): ["virt", VIRT_LAYOUT_VERSION, profile] in state[103]

/** The ARM core's state block of the current core, its per-core ranges */
/** @param {number=} core with cores in workers, a parked worker's core */
A64CPU.prototype.save_core_state = function(core = 0)
{
    const block = this.parallel ? this.state_block_of(core) : new Uint8Array(this.wasm_memory.buffer, this.state_base, 4096);
    const saved = new Uint8Array(CORE_STATE_RANGES.reduce((n, [a, b]) => n + b - a, 0));
    let at = 0;
    for(const [a, b] of CORE_STATE_RANGES)
    {
        saved.set(block.subarray(a, b), at);
        at += b - a;
    }
    return saved;
};

/** @param {!Uint8Array} saved @param {number=} core with cores in workers, a parked worker's core */
A64CPU.prototype.load_core_state = function(saved, core = 0)
{
    const block = this.parallel ? this.state_block_of(core) : new Uint8Array(this.wasm_memory.buffer, this.state_base, 4096);
    let at = 0;
    for(const [a, b] of CORE_STATE_RANGES)
    {
        block.set(saved.subarray(at, at + b - a), a);
        at += b - a;
    }
};

/**
 * Run `f` with each core (or only `only`) switched in, between slices; the
 * running core is the same afterwards
 * @param {function(number):*} f
 * @param {number=} only
 * @return {!Array<*>}
 */
A64CPU.prototype.each_core = function(f, only)
{
    const exports = this.wm.exports;
    // (cores in workers: each core's state is in its own block, state_block_of)
    if(this.parallel)
    {
        const results = [];
        for(let core = 0; core < this.cores; core++)
        {
            if(only === undefined || core === only) results.push(f(core));
        }
        return results;
    }
    const running = exports["a64_current_core"]();
    const results = [];
    for(let core = 0; core < this.cores; core++)
    {
        if(only !== undefined && core !== only) continue;
        exports["a64_switch_core"](core);
        results.push(f(core));
    }
    exports["a64_switch_core"](running);
    return results;
};

A64CPU.prototype.get_state = function(skip_memory = false)
{
    const state = [];
    state[0] = this.memory_size[0];
    state[1] = this.cores;
    // (every core's state block, P3.9: each switched in for a moment; then the running one again)
    state[2] = this.each_core(core => this.save_core_state(core));
    state[3] = this.wm.exports["a64_current_core"]();
    // the machine (P3.10): the devices, the GIC and the cores' power states (bytes of the core), the boot
    state[4] = DEVICE_ORDER.map(name => this.devices[name] ? this.devices[name].get_state() : null);
    state[5] = this.machine_state_bytes(0).slice();
    state[6] = this.machine_state_bytes(1).slice();
    state[7] = [this.booted, this.boot_entry || 0, this.boot_x0 || 0];
    // the virtio devices (P5.9): slot, kind, state; their transport
    state[8] = this.virtio_devices.map(({ slot, name, device }) => [slot, name, device]);
    state[9] = this.virtio_transport;
    // the PCIe host (P5.6): its functions' configuration, the shared SPIs' sources
    state[10] = this.devices["pci"] ? this.devices["pci"].get_state() : null;
    state[11] = Array.from(this.shared_spi_sources, ([intid, sources]) => [intid, Array.from(sources)]);
    // the display adapter (P7.1; nothing with graphics_adapter: "none")
    state[12] = this.devices.graphics_adapter;
    // (a GICv2's own state: ranchu with arm32)
    state[13] = this.gic_v2 ? this.machine_state_bytes(2).slice() : null;
    // the GLES host (ranchu_gpu "host"; a plugin's slot)
    state[14] = this.devices.gles ? this.devices.gles.get_state() : null;
    // the GLES backdoor's connections (gles_backdoor)
    state[15] = this.devices.backdoor ? this.devices.backdoor.get_state() : null;
    // (the machine clock: the system counter goes on from where it was, as on x86, src/cpu.js)
    state[95] = this.clock.get_state();
    // extended RAM's pages (P8.5: its contents are records of the snapshot stream)
    state[98] = this.extended_pages;
    if(skip_memory)
    {
        state[77] = null;
        state[78] = null;
    }
    else
    {
        // (a single-buffer snapshot does not hold extended RAM: the stream does)
        if(this.extended_store)
        {
            this.flush_extended_memory();
            if(this.extended_store.touched.some(byte => byte !== 0))
            {
                throw new Error("A snapshot of extended RAM needs save_state_stream");
            }
        }
        const { packed_memory, bitmap } = this.pack_memory();
        state[77] = packed_memory;
        state[78] = new Uint8Array(bitmap.get_buffer());
    }
    state[99] = null;
    state[103] = [this.machine_type, this.machine_type === "ranchu" ? RANCHU_LAYOUT_VERSION : VIRT_LAYOUT_VERSION, this.profile];
    return state;
};

/**
 * Take on a CPU profile by its name (A64_PROFILES): its granules and optional
 * features; a restore takes the snapshot's
 * @param {string} name
 */
A64CPU.prototype.set_profile = function(name)
{
    const entry = [...Object.values(A64_PROFILES), ...Object.values(ARM32_PROFILES)].find(p => p[0] === name);
    dbg_assert(!!entry, "unknown profile " + name);
    this.profile = name;
    this.wm.exports["a64_set_granules"](entry[1]);
    this.wm.exports["a64_set_features"](entry[2]);
};

/** Refuse a snapshot of another machine (an x86 one in either direction) or layout */
A64CPU.prototype.validate_state = function(state)
{
    const identity = state[103];
    const machine = identity ? identity[0] : "i440fx";
    if(machine !== this.machine_type)
    {
        throw new Error("The snapshot is from a machine with machine_type: \"" + machine + "\", this one has \"" + this.machine_type + "\"");
    }
    // (a snapshot of another profile restores as that profile, set_state)
    // (arm32's and arm64's profiles are of different CPUs)
    const profiles = Object.values(this.cpu_type === "arm32" ? ARM32_PROFILES : A64_PROFILES);
    const layout = this.machine_type === "ranchu" ? RANCHU_LAYOUT_VERSION : VIRT_LAYOUT_VERSION;
    if(identity[1] !== layout || !profiles.some(p => p[0] === identity[2]))
    {
        throw new Error("The snapshot is from " + machine + " layout " + identity[1] + " with CPU profile " + identity[2] +
            "; this machine is layout " + layout + ", " + this.profile);
    }
    if(state[0] !== this.memory_size[0])
    {
        throw new Error("The snapshot has " + state[0] + " bytes of RAM, this machine " + this.memory_size[0]);
    }
    if(state[1] !== this.cores)
    {
        throw new Error("The snapshot has " + state[1] + " cores, this machine " + this.cores);
    }
    if((state[98] || 0) !== this.extended_pages)
    {
        throw new Error("The snapshot has " + (state[98] || 0) * 4096 + " bytes of extended RAM, this machine " + this.extended_pages * 4096);
    }
    // (a disk's changes only onto the same image: docs/disk-image-formats-plan.md
    // P1; a different layout of the devices is refused in set_state)
    (state[8] || []).forEach(([, name, device_state], i) =>
    {
        const own = this.virtio_devices[i];
        if(own && name === "virtio-blk" && own.name === name && device_state) own.device.check_state(device_state);
    });
    if(this.devices.graphics_adapter)
    {
        this.devices.graphics_adapter.check_state(state[12]);
    }
    else if(graphics_adapter_of_state(state[12]) !== "none")
    {
        throw new Error("The snapshot is from a machine with graphics_adapter: \"" + graphics_adapter_of_state(state[12]) + "\", this one has \"none\"");
    }
    if(this.devices.gles)
    {
        this.devices.gles.check_state(state[14]);
    }
    else if(plugin_of_state(GLES_PLUGINS, state[14]) !== null)
    {
        throw new Error("The snapshot is from a machine with ranchu_gpu \"host\", this one has \"guest\"");
    }
};

A64CPU.prototype.set_state = function(state, skip_memory = false)
{
    this.validate_state(state);
    if(state[103][2] !== this.profile) this.set_profile(state[103][2]);
    // (disk requests held after an I/O error belong to the machine left behind)
    drop_disk_holds(this);
    if(state[95]) this.clock.set_state(state[95]);
    state[2].forEach((saved, core) => this.each_core(() => this.load_core_state(saved, core), core));
    if(!this.parallel) this.wm.exports["a64_switch_core"](state[3] || 0);
    (state[4] || []).forEach((device_state, i) => { if(device_state && this.devices[DEVICE_ORDER[i]]) this.devices[DEVICE_ORDER[i]].set_state(device_state); });
    if(state[5]) this.machine_state_bytes(0).set(state[5]);
    if(state[6]) { this.machine_state_bytes(1).set(state[6]); this.wm.exports["a64_psci_restored"](); }
    if(state[7]) [this.booted, this.boot_entry, this.boot_x0] = state[7];
    // (the same devices in the same slots, or the snapshot is refused)
    const devices = state[8] || [];
    const layout = list => list.map(([slot, name]) => slot + ":" + name).join(",");
    const own = layout(this.virtio_devices.map(({ slot, name }) => [slot, name]));
    if(layout(devices) !== own || state[9] !== this.virtio_transport)
    {
        throw new Error("The snapshot has the virtio devices [" + layout(devices) + "] on " + state[9] +
            ", this machine [" + own + "] on " + this.virtio_transport);
    }
    devices.forEach(([, , device_state], i) => this.virtio_devices[i].device.set_state(device_state));
    if(this.devices["pci"]) this.devices["pci"].set_state(state[10]);
    if(this.gic_v2 && state[13]) this.machine_state_bytes(2).set(state[13]);
    this.shared_spi_sources = new Map((state[11] || []).map(([intid, sources]) => [intid, new Set(sources)]));
    this.devices.graphics_adapter && this.devices.graphics_adapter.set_state(state[12]);
    // (the backdoor's connections before the GLES host's state, as the pipe's channels)
    if(this.devices.backdoor) this.devices.backdoor.set_state(state[15] || [1, []]);
    this.devices.gles && this.devices.gles.set_state(state[14]);
    this.wm.exports["a64_restored"]();
    if(!skip_memory && state[77])
    {
        this.unpack_memory(new Bitmap(state[78].buffer), state[77]);
    }
    // (cached translations and compiled code knew the old memory)
    this.wm.exports["jit_clear_cache_js"]?.();
};

/**
 * The disks by name, as CPU.prototype.disk_devices (export_disk_image,
 * disk_image_info): the virtio-blk disks, each with its image as `buffer`
 * @return {!Array<!Array<?>>}
 */
A64CPU.prototype.disk_devices = function()
{
    return this.virtio_devices.filter(({ name }) => name === "virtio-blk")
        .map(({ device }) => [device.name, { buffer: device.backend.buffer }]);
};

A64CPU.prototype.pack_memory = function()
{
    const page_count = this.memory_size[0] >>> 12;
    const nonzero = [];
    for(let page = 0; page < page_count; page++)
    {
        if(!this.is_memory_zeroed(page << 12, 0x1000)) nonzero.push(page);
    }
    if(nonzero.length * 0x1000 > STATE_MAX_SINGLE_BUFFER)
    {
        throw new RangeError("The state is larger than a single-buffer snapshot can be (2 GiB): use save_state_stream");
    }
    const bitmap = new Bitmap(page_count);
    const packed_memory = new Uint8Array(nonzero.length * 0x1000);
    for(const [i, page] of nonzero.entries())
    {
        bitmap.set(page, 1);
        packed_memory.set(this.mem8.subarray(page << 12, (page << 12) + 0x1000), i << 12);
    }
    return { bitmap, packed_memory };
};

A64CPU.prototype.unpack_memory = function(bitmap, packed_memory)
{
    this.mem8.fill(0);
    const page_count = this.memory_size[0] >>> 12;
    let packed = 0;
    for(let page = 0; page < page_count; page++)
    {
        if(bitmap.get(page))
        {
            this.mem8.set(packed_memory.subarray(packed << 12, (packed << 12) + 0x1000), page << 12);
            packed++;
        }
    }
    this.wm.exports["a64_bus_written"](0, this.memory_size[0]);
};

// ---- zstd for snapshots (src/state.js), the shared module's exports

A64CPU.prototype.zstd_create_ctx = function(n) { return this.wm.exports["zstd_create_ctx"](n); };
A64CPU.prototype.zstd_get_src_ptr = function(ctx) { return this.wm.exports["zstd_get_src_ptr"](ctx); };
A64CPU.prototype.zstd_free_ctx = function(ctx) { return this.wm.exports["zstd_free_ctx"](ctx); };
A64CPU.prototype.zstd_read = function(ctx, length) { return this.wm.exports["zstd_read"](ctx, length); };
A64CPU.prototype.zstd_read_free = function(ptr, length) { return this.wm.exports["zstd_read_free"](ptr, length); };

A64CPU.prototype.get_diagnostics = function()
{
    const exports = this.wm.exports;
    const power = ["on", "off", "on-pending"];
    const psci = this.machine_state_bytes(1);
    const cores = this.each_core(core => {
        const block = this.parallel ? this.state_block_of(core) : new Uint8Array(this.wasm_memory.buffer, this.state_base, 4096);
        const word = offset => new Int32Array(block.buffer, block.byteOffset + offset, 1)[0];
        const waiting = word(STATE_OFFSETS.waiting);
        const worker = this.parallel && core !== 0;
        return {
            "pc": worker ? "0x" + (new BigUint64Array(block.buffer, block.byteOffset + STATE_OFFSETS.pc, 1)[0]).toString(16) : this.read_pc(),
            "state": power[psci[core]] === "on" ? ["runnable", "wfi", "wfe", "off"][waiting] : power[psci[core]],
            // (AArch32's modes: User is EL0, the others PL1)
            "el": word(STATE_OFFSETS.pstate) & 0x10 ? +((word(STATE_OFFSETS.pstate) & 0xF) !== 0) : word(STATE_OFFSETS.pstate) >> 2 & 3,
            "retired_instructions": this.retired_instructions(core),
            "halt_count": worker ? this.parallel.core_counters(core).waits :
                exports["core_statistics_get"] ? exports["core_statistics_get"](core, 3) : 0,
        };
    });
    return {
        "cpu_type": this.cpu_type,
        "machine_type": this.machine_type,
        "active_core": exports["a64_current_core"](),
        "parallel": this.parallel ? Object.assign(this.parallel.status(), { "machine_core": {
            "tlbi_posted": exports["a64_tlb_ring_stat"](0), "dsb_waits": exports["a64_tlb_ring_stat"](1),
            "tlbi_taken": exports["a64_tlb_ring_stat"](2), "kicked": exports["a64_kicked"]() } }) : null,
        "execution": { "mode": this.parallel ? "parallel" : "cooperative", "fallback": this.parallel_fallback || null },
        "cores": cores,
        "pc": this.read_pc(),
        "retired": exports["core_statistics_get"] ? exports["core_statistics_get"](0, 0) : 0,
        "undefined": this.undefined_instructions(),
        "page_tier": this.page_tier_stats(),
    };
};

/** The instructions core `core` retired (with cores in workers, as its worker counts them) */
A64CPU.prototype.retired_instructions = function(core)
{
    if(this.parallel && core !== 0) return this.parallel.core_retired(core);
    const get = this.wm.exports["core_statistics_get"];
    return get ? get(core, 0) : 0;
};

/** The A64 page tier's counters (src/rust/aarch64/jit/pages.rs), or null without it */
A64CPU.prototype.page_tier_stats = function()
{
    // (the A64 page tier is jitrt's client 1: jit_stat, src/rust/jitrt/stat.rs)
    const jit_stat = this.wm.exports["jit_stat"];
    if(!jit_stat || Number.isNaN(jit_stat(1, 0))) return null;
    const stat = field => jit_stat(1, field);
    const names = ["compiled", "activations", "retired", "steps", "retries", "unknown", "retired_functions",
        "access_fills", "access_refused", "failed", "chained", "instructions", "templated"];
    const result = { "live": stat(100), "code_page_writes": stat(101), "resets": stat(102), "pages_compiled": stat(103),
        "most_compiles": stat(104), "helpers": stat(106), "evictions": stat(107), "compile_ms": stat(108),
        "asid_tag_switches": stat(109), "asid_tag": stat(110), "live_code_bytes": stat(111),
        "table_free_low": this.wm.exports["jit_wasm_table_free_low"](),
        // (diagnostics: why the access cache refused fills, pages.rs REFUSED_*)
        "refused": { "crossing": stat(120), "translation": stat(121), "not_writable": stat(122), "watched": stat(123),
            "reserved": stat(124), "extended": stat(125), "not_ram": stat(126), "unaligned": stat(127) } };
    names.forEach((name, i) => { result[name] = stat(i); });
    return result;
};

/**
 * The page tier's steps (diagnostics, pages.rs a64_step_stat): the
 * instruction classes (decode.rs Op << 4 | sub & 15) most often stepped, that
 * ended an activation by changing what compiled code depends on, and that ran
 * as helpers, with a word of each; every core's
 * @param {number=} top
 * @return {Object} null without the counters
 */
A64CPU.prototype.step_stats = function(top = 20)
{
    const stat = this.wm.exports["a64_step_stat"];
    if(!stat) return null;
    const result = {};
    // (AArch32's helper calls by instruction word)
    const helper_word = this.wm.exports["a32_helper_word"];
    if(helper_word)
    {
        const words = [];
        for(let i = 0; i < 4096; i++)
        {
            const count = helper_word(i, true);
            if(count) words.push({ "word": "0x" + (helper_word(i, false) >>> 0).toString(16).padStart(8, "0"), "count": count });
        }
        words.sort((a, b) => b["count"] - a["count"]);
        result["helped_words"] = words.slice(0, top);
    }
    ["stepped", "changed_context", "helped"].forEach((name, kind) => {
        const rows = [];
        for(let key = 0; key < 1024; key++)
        {
            const count = stat(kind, key);
            if(count) rows.push({ "op": key >> 4, "sub": key & 15, "word": "0x" + (stat(3, key) >>> 0).toString(16).padStart(8, "0"), "count": count });
        }
        rows.sort((a, b) => b["count"] - a["count"]);
        result[name] = rows.slice(0, top);
        // (MRS and MSR (register) by register: S<op0>_<op1>_C<CRn>_C<CRm>_<op2>)
        const sysreg = this.wm.exports["a64_sysreg_stat"];
        if(!sysreg) return;
        const regs = [];
        for(let reg = 0; reg < 1 << 16; reg++)
        {
            const count = sysreg(kind, reg);
            if(!count) continue;
            const r = reg & 0x7FFF;
            regs.push({ "msr": reg >> 15, "reg": `S${2 + (r >> 14)}_${r >> 11 & 7}_C${r >> 7 & 15}_C${r >> 3 & 15}_${r & 7}`, "count": count });
        }
        regs.sort((a, b) => b["count"] - a["count"]);
        result[name + "_sysregs"] = regs.slice(0, top);
        // (SYS by operation: op1, CRn, CRm, op2, as "SYS #op1, Cn, Cm, #op2")
        const ops = [];
        for(let op = 0; op < 1 << 14; op++)
        {
            const count = sysreg(4 + kind, op);
            if(count) ops.push({ "sys": `#${op >> 11 & 7}, C${op >> 7 & 15}, C${op >> 3 & 15}, #${op & 7}`, "count": count });
        }
        ops.sort((a, b) => b["count"] - a["count"]);
        result[name + "_sys"] = ops.slice(0, top);
    });
    return result;
};

/**
 * UNDEF telemetry (P2.3): counts at EL0 and EL1, and the most recent ones
 * (PC, word, EL)
 */
A64CPU.prototype.undefined_instructions = function()
{
    const exports = this.wm.exports;
    if(!exports["a64_undef_count"]) return null;
    const last = [];
    for(let i = 0; i < 16; i++)
    {
        const word = exports["a64_undef_last"](i, 2) >>> 0;
        const pc = (exports["a64_undef_last"](i, 1) >>> 0) * 0x100000000 + (exports["a64_undef_last"](i, 0) >>> 0);
        if(!pc && !word) break;
        last.push({ "pc": "0x" + pc.toString(16), "word": "0x" + word.toString(16).padStart(8, "0"), "el": exports["a64_undef_last"](i, 3) });
    }
    return { "el0": exports["a64_undef_count"](0, 16), "el1": exports["a64_undef_count"](1, 16), "last": last };
};

/** The current core's PC, as a hexadecimal string */
A64CPU.prototype.read_pc = function()
{
    const words = view(Uint32Array, this.wasm_memory, this.state_base + STATE_OFFSETS.pc, 2);
    return "0x" + (words[1] * 0x100000000 + words[0]).toString(16);
};

A64CPU.prototype.get_jit_info = function()
{
    return { "enabled": false };
};
