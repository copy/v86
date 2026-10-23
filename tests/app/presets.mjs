#!/usr/bin/env node
// The wizard's guest presets (src/app/guest_presets.js) and the settings
// dialog's rules (src/app/vm_model.js), docs/vm-manager-plan.md U3: every
// preset's configuration passes validate_config and the library's checks
// (check_machine_options, check_disk_options), the verified ones name their
// basis; Android's gives the options the Android test starts with; and no
// sequence of the dialog's choices (the CPU, machine, display, network,
// sound, cores, memory, ACPI, Q35's devices) makes a configuration the
// library refuses.
//   node tests/app/presets.mjs

import assert from "node:assert/strict";
import { PRESETS, preset, preset_config } from "../../src/app/guest_presets.js";
import { choices, change } from "../../src/app/vm_model.js";
import { new_config, validate_config, check_config, config_to_options } from "../../src/app/vm_config.js";
import { hardware_rows } from "../../src/app/ui/describe.js";

let passed = 0;
function test(name, fn)
{
    fn();
    passed++;
    console.log("ok - " + name);
}
const ENV = { debug: false, query_append: "", graphics_proxy: false, screen_container: undefined, file: () => new Blob([]) };
const problems = c => check_config(c).map(p => p.path + ": " + p.message);

test("every preset: a valid configuration the library accepts, with its new disk", () =>
{
    assert.equal(new Set(PRESETS.map(p => p.id)).size, PRESETS.length);
    for(const p of PRESETS)
    {
        const config = preset_config(p, { name: "x" });
        assert.equal(config.template, p.id);
        assert.equal(config.guest, p.guest);
        assert.deepEqual(problems(config), [], p.id);
        // (its new empty disk where the wizard puts it by default: in memory up to 2000 MB, else a URL stands in)
        config.disks = [{ slot: "hda", image: p.disk_mb <= 2000 && p.disk_location === "memory" ?
            { kind: "empty", size: p.disk_mb << 20 } : { kind: "url", url: "http://127.0.0.1:8471/x.img", size: p.disk_mb * 1048576 },
        disk_option: p.disk_location === "memory" ? "read_only" : "read_write", disk_error: "stop" }];
        assert.deepEqual(problems(config), [], p.id + " with its disk");
        assert(p.install.length && p.install_text && p.basis, p.id);
        assert(p.verified || p.id === "other" || /never|only starts|not verified/i.test(p.basis), p.id + ": an unverified preset says so");
    }
    const unverified = PRESETS.filter(p => !p.verified).map(p => p.id);
    assert.deepEqual(unverified, ["windows7", "other"]);
    console.log("    " + PRESETS.length + " presets, not verified: " + unverified.join(", "));
});

test("the presets' hardware (the plan's table)", () =>
{
    const row = id =>
    {
        const c = preset_config(preset(id));
        return [c.cpu.type, c.machine.type, c.memory.mb, c.cpu.cores, c.display.adapter, c.display.vram_mb, c.network.map(n => n.device).join("+"),
            c.sound.device, c.machine.acpi];
    };
    assert.deepEqual(row("dos"), ["x86", "i440fx", 64, 1, "bochs_vga", 8, "ne2k", "sb16", false]);
    assert.deepEqual(row("windows98"), ["x86", "i440fx", 256, 1, "bochs_vga", 16, "ne2k", "sb16", false]);
    assert.deepEqual(row("windows95"), ["x86", "i440fx", 64, 1, "bochs_vga", 16, "ne2k", "sb16", false]);
    assert.deepEqual(row("windowsxp"), ["x86", "i440fx", 2048, 1, "bochs_vga", 16, "ne2k", "sb16", false]);
    assert.deepEqual(row("windows81"), ["x86_64", "i440fx", 2048, 2, "vmware_svga", 16, "none", "none", true]);
    assert.deepEqual(row("linux"), ["x86", "i440fx", 512, 1, "bochs_vga", 8, "ne2k", "sb16", true]);
    assert.deepEqual(row("linux64"), ["x86_64", "i440fx", 1024, 2, "virtio_gpu", 8, "virtio", "sb16", true]);
    assert.deepEqual(row("linux_arm64"), ["arm64", "virt", 1024, 4, "virtio_gpu", 8, "virtio", "none", false]);
    assert.deepEqual(row("android16"), ["arm64", "virt", 1536, 4, "virtio_gpu", 8, "virtio+virtio+virtio", "virtio", false]);
    assert.equal(preset_config(preset("windowsnt4")).advanced.cpuid_level, 2);
});

test("Android's options: those of tests/a64/android_boot.mjs", () =>
{
    const c = preset_config(preset("android16"));
    c.kernel = { bzimage: { kind: "url", url: "Image" }, initrd: { kind: "url", url: "initrd.img" }, cmdline: "console=hvc0", multiboot: null, from_filesystem: false };
    c.disks = [{ slot: "hda", image: { kind: "url", url: "disk.img", async: true }, disk_option: "read_only", disk_error: "stop" }];
    const o = config_to_options(c, ENV);
    assert.equal(o.cpu_type, "arm64");
    assert.equal(o.cpu_cores, 4);
    assert.equal(o.memory_size, 1536 << 20);
    assert.deepEqual(o.kernel, { url: "Image" });
    assert.deepEqual(o.initrd, { url: "initrd.img" });
    assert.equal(o.cmdline, "console=hvc0");
    assert.equal(o.virtio_transport, "pci");
    assert.deepEqual(o.virtio_disks, [{ url: "disk.img", async: true }]);
    assert.equal(o.graphics_adapter, "virtio_gpu");
    assert.deepEqual(o.graphics_adapter_test, { level: "venus" });
    assert.equal(o.virtio_gpu_pci_slot, 2);
    assert.deepEqual(o.net_device, { type: "virtio", relay_url: "fetch", cors_proxy: undefined, mtu: 1500, count: 3, id: 2 });
    assert.equal(o.virtio_console, true);
    assert.equal(o.virtio_console_ports, 18);
    assert.equal(o.virtio_rng, true);
    assert.deepEqual(o.virtio_input, ["keyboard", "multitouch"]);
    assert.equal(o.virtio_vsock, true);
    assert.equal(o.virtio_sound, true);
    assert.deepEqual(o.jit_switches, { a64_page: 1 });
    assert.deepEqual(check_config(c), []);
});

test("the summary's rows: Android's display and sound", () =>
{
    const rows = Object.fromEntries(hardware_rows(preset_config(preset("android16"))));
    assert.equal(rows["Display"], "virtio-gpu, 8 MB, Vulkan");
    assert.equal(rows["Sound"], "virtio-snd");
    assert.equal(Object.fromEntries(hardware_rows(preset_config(preset("dos"))))["Sound"], "Sound Blaster 16");
});

test("change: what a choice implies, and says", () =>
{
    let { config, notes } = change(new_config(), "cpu.type", "arm64");
    assert.equal(config.machine.type, "virt");
    assert.equal(config.display.adapter, "virtio_gpu");
    assert.equal(config.network[0].device, "virtio");
    assert.equal(config.sound.device, "none");
    assert(notes.some(n => /Machine: virt/.test(n)) && notes.some(n => /Display: virtio_gpu/.test(n)), notes.join("; "));
    ({ config, notes } = change(config, "machine.type", "q35"));
    assert.equal(config.cpu.type, "x86");
    assert.equal(config.machine.acpi, true);
    assert.equal(config.machine.hpet, true);
    assert.equal(config.machine.smbus, true);
    ({ config } = change(config, "machine.type", "i440fx"));
    assert.equal(config.machine.hpet, false);
    assert.equal(config.machine.acpi, true, "ACPI stays on when it may");
    ({ config } = change(config, "machine.acpi", false));
    ({ config, notes } = change(config, "cpu.cores", 2));
    assert.equal(config.machine.acpi, true);
    assert(notes.some(n => /more than one core/.test(n)), notes.join("; "));
    ({ config, notes } = change(config, "memory.mb", 4096));
    assert.equal(config.cpu.type, "x86_64");
    ({ config, notes } = change(config, "cpu.type", "x86"));
    assert.equal(config.memory.mb, 2048);
    const floppy = new_config();
    floppy.floppies = [{ slot: "fda", image: { kind: "url", url: "f.img" }, disk_option: "read_only" }];
    floppy.serial = [{ port: 1, attach: "modem" }];
    ({ config, notes } = change(floppy, "cpu.type", "arm64"));
    assert.deepEqual(config.floppies, []);
    assert.equal(config.serial[0].attach, "terminal");
    assert(notes.some(n => /Floppy drives removed/.test(n)) && notes.some(n => /Modem removed/.test(n)), notes.join("; "));
    const choice = choices(config);
    assert.deepEqual(choice.graphics_adapters, ["none", "virtio_gpu"]);
    assert.deepEqual(choice.acpi_fixed && choice.acpi_fixed.value, false);
});

test("change: Vulkan and the graphics proxy", () =>
{
    let { config, notes } = change(change(new_config(), "cpu.type", "arm64").config, "display.vulkan", true);
    assert.equal(config.display.proxy, true);
    assert(notes.some(n => /Graphics proxy: on/.test(n)), notes.join("; "));
    assert.deepEqual(problems(config), []);
    assert.deepEqual(config_to_options(config, ENV).graphics_adapter_test, { level: "venus" });
    ({ config, notes } = change(config, "display.proxy", false));
    assert.equal(config.display.vulkan, false);
    assert(notes.some(n => /Vulkan: off/.test(n)), notes.join("; "));
    // (a PC keeps virtio-gpu and its Vulkan; another adapter drops it)
    ({ config } = change(change(config, "display.vulkan", true).config, "cpu.type", "x86"));
    assert.equal(config.display.vulkan, true);
    ({ config } = change(config, "display.adapter", "bochs_vga"));
    assert.equal(config.display.vulkan, false);
    assert.deepEqual(problems(config), []);
});

test("every combination of the dialog's choices: CPU, machine, display, network, sound, cores", () =>
{
    let count = 0;
    for(const cpu of choices(new_config()).cpu_types)
    {
        let a = change(new_config(), "cpu.type", cpu).config;
        for(const machine of choices(a).machine_types)
        {
            const b = change(a, "machine.type", machine).config;
            for(const adapter of choices(b).graphics_adapters)
            {
                const c = change(b, "display.adapter", adapter).config;
                for(const nic of choices(c).net_devices)
                {
                    const d = change(c, "network.0.device", nic).config;
                    for(const sound of choices(d).sound_devices)
                    {
                        for(const cores of [1, 2, choices(d).max_cores])
                        {
                            const e = change(change(d, "sound.device", sound).config, "cpu.cores", cores).config;
                            assert.deepEqual(problems(e), [], [cpu, machine, adapter, nic, sound, cores].join(" "));
                            count++;
                        }
                    }
                }
            }
        }
    }
    console.log("    " + count + " combinations");
});

test("random sequences of the dialog's choices (5000 changes): every configuration accepted", () =>
{
    let seed = 1;
    const random = n => { seed = seed * 1103515245 + 12345 & 0x7FFFFFFF; return seed % n; };
    const pick = list => list[random(list.length)];
    let config = new_config();
    for(let i = 0; i < 5000; i++)
    {
        const ch = choices(config);
        const moves = [
            () => ["cpu.type", pick(ch.cpu_types)],
            () => ["machine.type", pick(ch.machine_types)],
            () => ["display.adapter", pick(ch.graphics_adapters)],
            () => ["display.vram_mb", pick([1, 8, 16, 64, ch.max_vram])],
            () => ["display.displays", config.display.adapter === "virtio_gpu" ? pick([1, 2, 4]) : 1],
            () => ["display.proxy", pick([true, false])],
            () => ["display.vulkan", config.display.adapter === "virtio_gpu" && pick([true, false])],
            () => ["network.0.device", pick(ch.net_devices)],
            () => ["network.0.backend", pick(["none", "inbrowser", "fetch"])],
            () => ["sound.device", pick(ch.sound_devices)],
            () => ["cpu.cores", 1 + random(ch.max_cores)],
            () => ["memory.mb", pick([16, 64, 512, 2048, 2050, 4096, ch.max_memory])],
            () => ["machine.boot_order", pick(ch.boot_orders)],
            () => ch.acpi_fixed ? ["machine.acpi", ch.acpi_fixed.value] : ["machine.acpi", pick([true, false])],
            () => config.machine.type === "q35" ? [pick(["machine.hpet", "machine.smbus"]), pick([true, false])] : ["cpu.jit", pick([true, false])],
            () => config.machine.type === "q35" ? ["machine.pcie_root_ports", random(7)] : ["cpu.parallel", pick([true, false])],
        ];
        const [path, value] = pick(moves)();
        config = change(config, path, value).config;
        const p = problems(config);
        assert.deepEqual(p, [], "after " + path + " = " + JSON.stringify(value) + " (change " + i + ")");
    }
});

console.log(passed + " tests passed");
