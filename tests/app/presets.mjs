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
import { choices, change, fitted } from "../../src/app/vm_model.js";
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
    assert.deepEqual(unverified, ["windows11", "windows7", "android_x86_64", "android_x86", "other"]);
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
    assert.deepEqual(row("windows81"), ["x86_64", "i440fx", 2048, 2, "vmware_svga", 16, "e1000", "hd_audio", true]);
    assert.deepEqual(row("windows7"), row("windows81"), "Vista, 7 and 10: Windows 8.1's hardware");
    // (Windows 11: Q35 with UEFI, Secure Boot with Microsoft's keys, a TPM 2.0, 4 GiB)
    assert.deepEqual(row("windows11"), ["x86_64", "q35", 4096, 2, "vmware_svga", 16, "e1000", "hd_audio", true]);
    const w11 = preset_config(preset("windows11"));
    assert.deepEqual([w11.machine.firmware, w11.machine.secure_boot, w11.machine.secure_boot_keys, w11.tpm, w11.usb.controller],
        ["uefi", true, "microsoft", { state: null }, "xhci"]);
    assert.equal(preset("windows11").disk_mb, 64 * 1024, "Windows 11's 64 GB");
    assert.deepEqual(row("linux"), ["x86", "i440fx", 512, 1, "bochs_vga", 8, "ne2k", "sb16", true]);
    assert.deepEqual(row("linux64"), ["x86_64", "i440fx", 1024, 2, "virtio_gpu", 8, "virtio", "sb16", true]);
    assert.deepEqual(row("linux_arm64"), ["arm64", "virt", 1024, 4, "virtio_gpu", 8, "virtio", "none", false]);
    assert.deepEqual(row("android16"), ["arm64", "virt", 1536, 4, "virtio_gpu", 8, "virtio+virtio+virtio", "virtio", false]);
    assert.deepEqual(row("linux_arm32"), ["arm32", "virt", 512, 2, "none", 8, "virtio", "none", false]);
    assert.deepEqual(row("android7_arm32"), ["arm32", "ranchu", 1024, 2, "none", 8, "virtio", "none", false]);
    assert.deepEqual(row("android_x86_64"), ["x86_64", "i440fx", 2048, 2, "virtio_gpu", 8, "virtio", "hd_audio", true]);
    assert.deepEqual(row("android_x86"), ["x86", "i440fx", 2048, 2, "virtio_gpu", 8, "virtio", "hd_audio", true]);
    assert.equal(preset_config(preset("windowsnt4")).advanced.cpuid_level, 2);
    // the USB tablet: XP, Vista to 8.1, Linux, Android-x86; not DOS, Windows 3.x, 9x, NT 4, 2000 or the ARM machines
    const tablet = PRESETS.filter(p => preset_config(p).usb).map(p => p.id);
    assert.deepEqual(tablet, ["windowsxp", "windows81", "windows11", "windows7", "linux", "linux64", "android_x86_64", "android_x86"]);
    assert.deepEqual(preset_config(preset("windows81")).usb, { controller: "xhci", tablet: true, disks: [] });
    // (xHCI for the systems with its driver; EHCI for XP to 7, whose drivers have none)
    assert.deepEqual(["windowsxp", "windows7", "windows81", "linux", "linux64"].map(id => preset_config(preset(id)).usb.controller),
        ["ehci", "ehci", "xhci", "xhci", "xhci"]);
});

test("Android's options: those of tests/a64/android_boot.mjs (A64_ANDROID_BOOTLOADER=1)", () =>
{
    const c = preset_config(preset("android16"));
    c.disks = [{ slot: "hda", image: { kind: "url", url: "disk.img", async: true }, disk_option: "read_only", disk_error: "stop" }];
    let o = config_to_options(c, ENV);
    assert.equal(o.cpu_type, "arm64");
    assert.equal(o.cpu_cores, 4);
    assert.equal(o.memory_size, 1536 << 20);
    // (the bootloader: no kernel, initrd or command line of the page's)
    assert.deepEqual(o.android, { device: "cf_arm64_only_phone", gpu_mode: "gfxstream", selinux: "enforcing", vendor_ramdisk: undefined, gles_version: undefined });
    assert.equal("kernel" in o || "initrd" in o, false);
    assert.equal(o.cmdline, undefined);
    assert.equal(o.virtio_transport, "pci");
    assert.deepEqual(o.virtio_disks, [{ url: "disk.img", async: true }]);
    assert.equal(o.graphics_adapter, "virtio_gpu");
    assert.deepEqual(o.graphics_adapter_test, { level: "gfxstream" });
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
    // (the debug vendor ramdisk, and a command line after the device's)
    c.android = Object.assign({}, c.android, { vendor_ramdisk: "debug", debug_ramdisk: { kind: "url", url: "vendor_ramdisk-debug.img" } });
    c.kernel = { bzimage: null, initrd: null, cmdline: "androidboot.x=1", multiboot: null, from_filesystem: false };
    o = config_to_options(c, ENV);
    assert.deepEqual(o.android.vendor_ramdisk, { url: "vendor_ramdisk-debug.img" });
    assert.equal(o.cmdline, "androidboot.x=1");
    assert.deepEqual(check_config(c), []);
});

test("Android 7.1's emulator image: the options of tests/a32/android_boot.mjs (A32_ANDROID_DISK=1)", () =>
{
    const c = preset_config(preset("android7_arm32"));
    c.disks = [{ slot: "hda", image: { kind: "url", url: "disk.img", async: true }, disk_option: "read_write", disk_error: "stop" }];
    const o = config_to_options(c, ENV);
    assert.equal(o.cpu_type, "arm32");
    assert.equal(o.machine_type, "ranchu");
    assert.equal(o.cpu_cores, 2);
    assert.equal(o.memory_size, 1024 << 20);
    assert.deepEqual(o.android, { device: "ranchu_25_armeabi_v7a", gpu_mode: "host", selinux: "enforcing", vendor_ramdisk: undefined, gles_version: "3.1" });
    assert.equal("kernel" in o || "initrd" in o, false);
    assert.equal(o.graphics_adapter, "none");
    assert.deepEqual(o.virtio_disks, [{ url: "disk.img", async: true, disk_option: "read_write" }]);
    assert.equal(o.net_device.type, "virtio");
    assert.equal(o.net_device.relay_url, "fetch");
    assert.equal(o.virtio_transport, undefined);
    assert.equal(o.virtio_input, undefined);
    assert.equal(o.cpu_profile, undefined);
    assert.deepEqual(o.jit_switches, { a64_page: 1 });
    assert.deepEqual(check_config(c), []);
    // (its device model is ranchu's: Cuttlefish's on ranchu is refused, ranchu's on virt too)
    assert.ok(problems(Object.assign({}, c, { android: Object.assign({}, c.android, { device: "cf_arm64_only_phone" }) }))
        .some(p => /boots on the virt machine with the arm64 CPU/.test(p)));
    let { config, notes } = change(c, "machine.type", "virt");
    assert.equal(config.android, null);
    assert.ok(notes.some(n => /ranchu_25_armeabi_v7a boots on the ranchu machine/.test(n)), JSON.stringify(notes));
    ({ config, notes } = change(c, "cpu.type", "arm64"));
    assert.equal(config.machine.type, "ranchu");
    assert.equal(config.android, null);
    assert.deepEqual(problems(config), []);
    // (its GPU modes, docs/gles-proxy-plan.md E5: the host's GPU or the
    // guest's CPU, "swiftshader" the guest's as before; not Cuttlefish's)
    for(const gpu_mode of ["host", "guest", "swiftshader"])
    {
        const d = Object.assign({}, c, { android: Object.assign({}, c.android, { gpu_mode }) });
        assert.deepEqual(problems(d), [], gpu_mode);
        assert.equal(config_to_options(d, ENV).android.gpu_mode, gpu_mode);
        assert.equal(fitted(d).config.android.gpu_mode, gpu_mode);
    }
    const gfxstream = Object.assign({}, c, { android: Object.assign({}, c.android, { gpu_mode: "gfxstream" }) });
    assert.ok(problems(gfxstream).some(p => /android.gpu_mode/.test(p)), JSON.stringify(problems(gfxstream)));
    ({ config, notes } = fitted(gfxstream));
    assert.equal(config.android.gpu_mode, "guest");
    assert.ok(notes.some(n => /Android's GPU: the guest's CPU \(ranchu_25_armeabi_v7a has no gfxstream\)/.test(n)), JSON.stringify(notes));
    // (and Cuttlefish has neither)
    const host = Object.assign(preset_config(preset("android16")), {});
    host.android = Object.assign({}, host.android, { gpu_mode: "host" });
    assert.ok(problems(host).some(p => /android.gpu_mode/.test(p)), JSON.stringify(problems(host)));
    assert.equal(fitted(host).config.android.gpu_mode, "swiftshader");
});

test("arm32 and ranchu: what a choice implies", () =>
{
    let { config, notes } = change(new_config(), "cpu.type", "arm32");
    assert.equal(config.machine.type, "virt");
    assert.ok(notes.some(n => /Machine: virt \(the arm32 CPU's\)/.test(n)), JSON.stringify(notes));
    ({ config, notes } = change(config, "machine.type", "ranchu"));
    assert.equal(config.cpu.type, "arm32");
    assert.equal(config.display.adapter, "none");
    assert.equal(config.sound.device, "none");
    assert.ok(notes.some(n => /the emulator's framebuffer/.test(n)), JSON.stringify(notes));
    assert.deepEqual(problems(config), []);
    assert.deepEqual(choices(config).graphics_adapters, ["none"]);
    assert.deepEqual(choices(config).sound_devices, ["none"]);
    ({ config, notes } = change(config, "memory.mb", 4096));
    assert.equal(config.memory.mb, 2048);
    ({ config, notes } = change(config, "cpu.type", "x86"));
    assert.equal(config.machine.type, "i440fx");
    ({ config, notes } = change(new_config(), "machine.type", "ranchu"));
    assert.equal(config.cpu.type, "arm64");
    assert.deepEqual(problems(config), []);
});

test("change: Android's bootloader follows the machine and Vulkan", () =>
{
    let { config, notes } = change(preset_config(preset("android16")), "display.proxy", false);
    assert.equal(config.display.vulkan, "none");
    assert.equal(config.android.gpu_mode, "swiftshader");
    assert.ok(notes.some(n => /SwiftShader/.test(n)), JSON.stringify(notes));
    assert.equal(fitted(config).config.android.gpu_mode, "swiftshader");
    ({ config, notes } = change(preset_config(preset("android16")), "cpu.type", "x86"));
    assert.equal(config.android, null);
    assert.ok(notes.some(n => /Android's bootloader off/.test(n)), JSON.stringify(notes));
    // (Venus for the display: Android's GPU follows)
    ({ config, notes } = change(preset_config(preset("android16")), "display.vulkan", "venus"));
    assert.equal(config.android.gpu_mode, "venus");
    assert.ok(notes.some(n => /Android's GPU: Venus/.test(n)), JSON.stringify(notes));
    assert.deepEqual(problems(config), []);
    assert.deepEqual(config_to_options(config, ENV).graphics_adapter_test, { level: "venus" });
    assert.equal(config_to_options(config, ENV).android.gpu_mode, "venus");
});

test("the summary's rows: Android's display and sound", () =>
{
    const rows = Object.fromEntries(hardware_rows(preset_config(preset("android16"))));
    assert.equal(rows["Display"], "virtio-gpu, 8 MB, Vulkan (gfxstream)");
    assert.equal(rows["Sound"], "virtio-snd");
    assert.equal(rows["Android boot"], "from the first disk (cf_arm64_only_phone), gfxstream");
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

test("change: UEFI keeps the x86_64 CPU and ACPI, or goes", () =>
{
    const uefi = new_config();
    uefi.cpu.type = "x86_64";
    uefi.machine.acpi = true;
    uefi.machine.firmware = "uefi";
    let { config, notes } = change(uefi, "machine.acpi", false);
    assert.equal(config.machine.acpi, true);
    assert.equal(config.machine.firmware, "uefi");
    assert(notes.some(n => /ACPI on: UEFI needs it/.test(n)), notes.join("; "));
    ({ config, notes } = change(config, "cpu.type", "x86"));
    assert.equal(config.machine.firmware, "seabios");
    assert(notes.some(n => /Firmware: SeaBIOS/.test(n)), notes.join("; "));
    ({ config } = change(uefi, "cpu.type", "arm64"));
    assert.equal(config.machine.firmware, "seabios");
});

test("change: Secure Boot keeps UEFI on Q35, or goes", () =>
{
    const c = new_config();
    c.cpu.type = "x86_64";
    Object.assign(c.machine, { type: "q35", acpi: true, firmware: "uefi", secure_boot: true });
    let { config, notes } = change(c, "machine.type", "i440fx");
    assert.equal(config.machine.secure_boot, false);
    assert(notes.some(n => /Secure Boot off/.test(n)), notes.join("; "));
    ({ config, notes } = change(c, "cpu.type", "x86"));
    assert.equal(config.machine.firmware, "seabios");
    assert.equal(config.machine.secure_boot, false);
    ({ config } = change(c, "machine.secure_boot_keys", "none"));
    assert.equal(config.machine.secure_boot, true);
    assert.equal(config.machine.secure_boot_keys, "none");
});

test("change: the TPM keeps ACPI, or goes with an ARM CPU", () =>
{
    const c = new_config();
    c.machine.acpi = true;
    c.tpm = { state: null };
    let { config, notes } = change(c, "machine.acpi", false);
    assert.equal(config.machine.acpi, true);
    assert(notes.some(n => /ACPI on: the TPM needs it/.test(n)), notes.join("; "));
    ({ config, notes } = change(config, "cpu.type", "arm64"));
    assert.equal(config.tpm, null);
    assert(notes.some(n => /TPM removed/.test(n)), notes.join("; "));
});

test("change: Vulkan and the graphics proxy", () =>
{
    let { config, notes } = change(change(new_config(), "cpu.type", "arm64").config, "display.vulkan", "venus");
    assert.equal(config.display.proxy, true);
    assert(notes.some(n => /Graphics proxy: on/.test(n)), notes.join("; "));
    assert.deepEqual(problems(config), []);
    assert.deepEqual(config_to_options(config, ENV).graphics_adapter_test, { level: "venus" });
    ({ config, notes } = change(config, "display.proxy", false));
    assert.equal(config.display.vulkan, "none");
    assert(notes.some(n => /Vulkan: off/.test(n)), notes.join("; "));
    // (a PC keeps virtio-gpu and its Vulkan; another adapter drops it)
    ({ config } = change(change(config, "display.vulkan", "gfxstream").config, "cpu.type", "x86"));
    assert.equal(config.display.vulkan, "gfxstream");
    assert.deepEqual(config_to_options(config, ENV).graphics_adapter_test, { level: "gfxstream" });
    ({ config } = change(config, "display.adapter", "bochs_vga"));
    assert.equal(config.display.vulkan, "none");
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
            () => ["display.vulkan", config.display.adapter === "virtio_gpu" ? pick(["none", "venus", "gfxstream"]) : "none"],
            () => ["network.0.device", pick(ch.net_devices)],
            () => ["network.0.backend", pick(["none", "inbrowser", "fetch"])],
            () => ["sound.device", pick(ch.sound_devices)],
            () => ["cpu.cores", 1 + random(ch.max_cores)],
            () => ["memory.mb", pick([16, 64, 512, 2048, 2050, 4096, ch.max_memory])],
            () => ["machine.boot_order", pick(ch.boot_orders)],
            () => ch.acpi_fixed ? ["machine.acpi", ch.acpi_fixed.value] : ["machine.acpi", pick([true, false])],
            () => config.machine.type === "q35" ? [pick(["machine.hpet", "machine.smbus"]), pick([true, false])] : ["cpu.jit", pick([true, false])],
            () => config.machine.type === "q35" ? ["machine.pcie_root_ports", random(7)] : ["cpu.parallel", pick([true, false])],
            () => ["machine.firmware", pick(["seabios", "uefi"])],
            () => config.machine.firmware === "uefi" ? ["machine.secure_boot", pick([true, false])] : ["machine.secure_boot_keys", pick(["microsoft", "none"])],
        ];
        const [path, value] = pick(moves)();
        config = change(config, path, value).config;
        const p = problems(config);
        assert.deepEqual(p, [], "after " + path + " = " + JSON.stringify(value) + " (change " + i + ")");
    }
});

console.log(passed + " tests passed");
