#!/usr/bin/env node
// The VM manager's configuration (src/app/vm_config.js, docs/vm-manager-plan.md
// U1): the defaults, the migration, every check of validate_config, and
// config_to_options: each of the old page's
// profiles as a configuration gives the options the old page gives it
// (?profile=<id>), and the configuration's own fields reach the options.
//   node tests/app/vm_config.mjs

import assert from "node:assert/strict";
import { get_profiles } from "../../src/browser/profiles.js";
import { DEFAULT_FORM, settings_to_options } from "../../src/browser/vm_options.js";
import { start_settings } from "../../src/browser/query_compat.js";
import { FORMAT, VERSION, new_config, with_defaults, migrate, validate_config, check_config, profile_to_config, config_to_options } from "../../src/app/vm_config.js";

let passed = 0;
function test(name, fn)
{
    fn();
    passed++;
    console.log("ok - " + name);
}

const ENV = { debug: false, query_append: "?v", graphics_proxy: false, screen_container: "screen", file: image => new Blob([image.name]) };
const log = console.log;

/**
 * The options as they behave: undefined and false the same (absent) except
 * for the options whose default is true; ArrayBuffers by their size
 */
function behaviour(value)
{
    const TRUE_BY_DEFAULT = ["cpu_worker", "ir_tier0", "x87_fast_math", "x87_jit_cache", "autostart"];
    if(value instanceof ArrayBuffer) return { ArrayBuffer: value.byteLength };
    if(Array.isArray(value)) return value.map(behaviour);
    if(value && typeof value === "object")
    {
        return Object.fromEntries(Object.keys(value).sort()
            .filter(k => value[k] !== undefined && (value[k] !== false || TRUE_BY_DEFAULT.includes(k)))
            .map(k => [k, behaviour(value[k])]));
    }
    return value;
}

test("the defaults: a valid configuration, the old page's machine before its form is changed", () =>
{
    const config = new_config();
    assert.equal(config.format, FORMAT);
    assert.equal(config.version, VERSION);
    assert.match(config.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(validate_config(config), []);
    assert.deepEqual(check_config(config), []);
    // (the old page's start from the form without changes: start_settings with DEFAULT_FORM)
    console.log = () => {};
    const start = start_settings(null, null, DEFAULT_FORM, { location_args: new URLSearchParams(), origin: "", debug: false, graphics_proxy: false });
    console.log = log;
    assert.deepEqual(behaviour(config_to_options(config, ENV)), behaviour(settings_to_options(start.settings, Object.assign({ cpu_worker: start.cpu_worker }, ENV))));
});

test("each of the 137 profiles as a configuration: the old page's options of ?profile=<id>", () =>
{
    const profiles = get_profiles("images/", true);
    assert.equal(profiles.length, 137);
    for(const profile of profiles)
    {
        const config = profile_to_config(profile);
        assert.deepEqual(validate_config(config), [], profile.id);
        const query_args = new URLSearchParams("profile=" + profile.id);
        console.log = () => {};
        const start = start_settings(profile, query_args, DEFAULT_FORM, { location_args: query_args, origin: "", debug: false, graphics_proxy: false });
        const expected = settings_to_options(start.settings, Object.assign({ cpu_worker: start.cpu_worker }, ENV));
        const actual = config_to_options(config, ENV);
        console.log = log;
        assert.deepEqual(behaviour(actual), behaviour(expected), profile.id);
    }
});

test("JSON and back: the same configuration", () =>
{
    for(const profile of get_profiles("//i.copy.sh/", false).slice(0, 40))
    {
        const config = profile_to_config(profile);
        assert.deepEqual(migrate(JSON.parse(JSON.stringify(config))), config, profile.id);
    }
});

test("migrate: not a configuration, a bad or newer version", () =>
{
    assert.throws(() => migrate(null), /not a v86 virtual machine/);
    assert.throws(() => migrate({ format: "other", version: 1 }), /not a v86 virtual machine/);
    assert.throws(() => migrate({ format: FORMAT, version: 0 }), /format version 0 is not valid/);
    assert.throws(() => migrate({ format: FORMAT, version: "1" }), /format version "1" is not valid/);
    assert.throws(() => migrate({ format: FORMAT, version: VERSION + 1 }), /newer v86/);
});

test("migrate: missing fields get their defaults, the given ones stay", () =>
{
    const config = migrate({ format: FORMAT, version: 1, id: "x", name: "Mine", memory: { mb: 512 }, cpu: { cores: 2 }, machine: { acpi: true } });
    assert.equal(config.name, "Mine");
    assert.equal(config.memory.mb, 512);
    assert.equal(config.cpu.cores, 2);
    assert.equal(config.cpu.type, "x86");
    assert.equal(config.machine.type, "i440fx");
    assert.deepEqual(config.network, [{ device: "ne2k", backend: "relay", relay_url: "wss://relay.widgetry.org/", mtu: 1500, mac_address_translation: false }]);
    assert.deepEqual(validate_config(config), []);
    assert.deepEqual(with_defaults(config), config, "with_defaults keeps a whole configuration");
});

/** Every check: a change of a valid configuration and the field it is reported on */
const RULES = [
    ["format", c => { c.format = "x"; }, "format"],
    ["version", c => { c.version = 2; }, "version"],
    ["no id", c => { c.id = ""; }, "id"],
    ["no name", c => { c.name = "  "; }, "name"],
    ["a long name", c => { c.name = "x".repeat(201); }, "name"],
    ["notes", c => { c.notes = 1; }, "notes"],
    ["cpu type", c => { c.cpu.type = "z80"; }, "cpu.type"],
    ["machine type", c => { c.machine.type = "isa"; }, "machine.type"],
    ["arm64 on a PC", c => { c.cpu.type = "arm64"; }, "machine.type"],
    ["x86 on virt", c => { c.machine.type = "virt"; }, "machine.type"],
    ["no cores", c => { c.cpu.cores = 0; }, "cpu.cores"],
    ["9 cores", c => { c.cpu.cores = 9; c.machine.acpi = true; }, "cpu.cores"],
    ["parallel", c => { c.cpu.parallel = "yes"; }, "cpu.parallel"],
    ["jit", c => { c.cpu.jit = 1; }, "cpu.jit"],
    ["too little memory", c => { c.memory.mb = 8; }, "memory.mb"],
    ["too much memory", c => { c.memory.mb = 70000; c.cpu.type = "x86_64"; }, "memory.mb"],
    ["4 GB on x86", c => { c.memory.mb = 4096; }, "memory.mb"],
    ["acpi", c => { c.machine.acpi = "on"; }, "machine.acpi"],
    ["ACPI on virt", c => { c.cpu.type = "arm64"; c.machine.type = "virt"; c.machine.acpi = true; c.display.adapter = "none";
        c.network[0].device = "virtio"; c.sound.device = "none"; }, "machine.acpi"],
    ["Q35 without ACPI", c => { c.machine.type = "q35"; }, "machine.acpi"],
    ["two cores without ACPI", c => { c.cpu.cores = 2; }, "machine.acpi"],
    ["an HPET on i440FX", c => { c.machine.hpet = true; }, "machine.hpet"],
    ["an SMBus on i440FX", c => { c.machine.smbus = true; }, "machine.smbus"],
    ["root ports on i440FX", c => { c.machine.pcie_root_ports = 1; }, "machine.pcie_root_ports"],
    ["7 root ports", c => { c.machine.type = "q35"; c.machine.acpi = true; c.machine.pcie_root_ports = 7; }, "machine.pcie_root_ports"],
    ["a boot order", c => { c.machine.boot_order = 0x111; }, "machine.boot_order"],
    ["fastboot", c => { c.machine.fastboot = null; }, "machine.fastboot"],
    ["bootmenu", c => { c.machine.bootmenu = "x"; }, "machine.bootmenu"],
    ["a BIOS image", c => { c.machine.bios = { kind: "url", url: "" }; }, "machine.bios"],
    ["a BIOS on virt", c => { Object.assign(c, arm64()); c.machine.bios = { kind: "url", url: "b.bin" }; }, "machine.bios"],
    ["a disk's slot", c => { c.disks = [disk({ slot: "hdc" })]; }, "disks.0.slot"],
    ["a slot twice", c => { c.disks = [disk(), disk()]; }, "disks.1.slot"],
    ["an image's kind", c => { c.disks = [disk({ image: { kind: "ftp" } })]; }, "disks.0.image"],
    ["a URL without a URL", c => { c.disks = [disk({ image: { kind: "url", url: "" } })]; }, "disks.0.image"],
    ["a URL's size", c => { c.disks = [disk({ image: { kind: "url", url: "a.img", size: -1 } })]; }, "disks.0.image"],
    ["a file without a name", c => { c.disks = [disk({ image: { kind: "file", name: "", size: 1, last_modified: 0 } })]; }, "disks.0.image"],
    ["an empty disk's size", c => { c.disks = [disk({ image: { kind: "empty", size: 0 } })]; }, "disks.0.image"],
    ["an empty disk too large", c => { c.disks = [disk({ image: { kind: "empty", size: 2001 * 1024 * 1024 } })]; }, "disks.0.image"],
    ["a browser disk's path", c => { c.disks = [disk({ image: { kind: "browser", path: "../x.img", size: 512 } })]; }, "disks.0.image"],
    ["disk_option", c => { c.disks = [disk({ disk_option: "rw" })]; }, "disks.0.disk_option"],
    ["disk_error", c => { c.disks = [disk({ disk_error: "ignore" })]; }, "disks.0.disk_error"],
    ["read write of a file", c => { c.disks = [disk({ image: { kind: "file", name: "a.img", size: 512, last_modified: 0 }, disk_option: "read_write" })]; },
        "disks.0.disk_option"],
    ["read write of an empty disk", c => { c.disks = [disk({ image: { kind: "empty", size: 512 }, disk_option: "read_write" })]; }, "disks.0.disk_option"],
    ["an empty CD", c => { c.cdrom.image = { kind: "empty", size: 2048 }; }, "cdrom.image"],
    ["the CD's disk_error", c => { c.cdrom.disk_error = "x"; }, "cdrom.disk_error"],
    ["a floppy on virt", c => { Object.assign(c, arm64()); c.floppies = [{ slot: "fda", image: null, disk_option: "read_only" }]; }, "floppies.0"],
    ["a floppy's slot", c => { c.floppies = [{ slot: "fdc", image: null, disk_option: "read_only" }]; }, "floppies.0.slot"],
    ["a floppy slot twice", c => { c.floppies = [floppy(), floppy()]; }, "floppies.1.slot"],
    ["an empty floppy's size", c => { c.floppies = [floppy({ image: { kind: "empty", size: 1000 * 512 } })]; }, "floppies.0.image"],
    ["a floppy's disk_option", c => { c.floppies = [floppy({ disk_option: "x" })]; }, "floppies.0.disk_option"],
    ["a kernel's image", c => { c.kernel = kernel({ bzimage: { kind: "url" } }); }, "kernel.bzimage"],
    ["multiboot on virt", c => { Object.assign(c, arm64()); c.kernel = kernel({ multiboot: { kind: "url", url: "m.bin" } }); }, "kernel.multiboot"],
    ["a command line", c => { c.kernel = kernel({ cmdline: 1 }); }, "kernel.cmdline"],
    ["from_filesystem", c => { c.kernel = kernel({ from_filesystem: "yes" }); }, "kernel.from_filesystem"],
    ["a display adapter", c => { c.display.adapter = "cga"; }, "display.adapter"],
    ["VGA on virt", c => { Object.assign(c, arm64()); c.display.adapter = "bochs_vga"; }, "display.adapter"],
    ["video memory", c => { c.display.vram_mb = 12; }, "display.vram_mb"],
    ["512 MB of video memory", c => { c.display.vram_mb = 512; }, "display.vram_mb"],
    ["the state's video memory without a state", c => { c.display.vram_mb = null; }, "display.vram_mb"],
    ["the proxy", c => { c.display.proxy = 1; }, "display.proxy"],
    ["5 displays", c => { c.display.adapter = "virtio_gpu"; c.display.displays = 5; }, "display.displays"],
    ["2 displays on Bochs VGA", c => { c.display.displays = 2; }, "display.displays"],
    ["two network cards", c => { c.network.push(c.network[0]); }, "network"],
    ["a network card", c => { c.network[0].device = "e1000"; }, "network.0.device"],
    ["ne2k on virt", c => { Object.assign(c, arm64()); c.network[0].device = "ne2k"; }, "network.0.device"],
    ["a backend", c => { c.network[0].backend = "slirp"; }, "network.0.backend"],
    ["a relay's URL", c => { c.network[0].relay_url = "http://relay"; }, "network.0.relay_url"],
    ["a wisp server's URL", c => { c.network[0].backend = "wisp"; c.network[0].relay_url = "wss://x/"; }, "network.0.relay_url"],
    ["a CORS proxy's URL", c => { c.network[0].backend = "fetch"; c.network[0].relay_url = "proxy"; }, "network.0.relay_url"],
    ["the MTU", c => { c.network[0].mtu = 67; }, "network.0.mtu"],
    ["MAC address translation", c => { c.network[0].mac_address_translation = "x"; }, "network.0.mac_address_translation"],
    ["a sound card", c => { c.sound.device = "gus"; }, "sound.device"],
    ["a Sound Blaster on virt", c => { Object.assign(c, arm64()); c.sound.device = "sb16"; }, "sound.device"],
    ["a UART", c => { c.serial = [{ port: 4, attach: "none" }]; }, "serial.0.port"],
    ["a UART twice", c => { c.serial = [{ port: 1, attach: "none" }, { port: 1, attach: "none" }]; }, "serial.1.port"],
    ["what a UART has", c => { c.serial = [{ port: 1, attach: "printer" }]; }, "serial.0.attach"],
    ["two modems", c => { c.serial = [{ port: 1, attach: "modem" }, { port: 2, attach: "modem" }]; }, "serial"],
    ["a modem on virt", c => { Object.assign(c, arm64()); c.serial = [{ port: 1, attach: "modem" }]; }, "serial.0.attach"],
    ["the file system's URL", c => { c.filesystem = { baseurl: 1 }; }, "filesystem.baseurl"],
    ["the file system's description", c => { c.filesystem = { basefs: "fs.json" }; }, "filesystem.basefs"],
    ["an empty state", c => { c.initial_state = { kind: "empty", size: 1 }; }, "initial_state"],
    ["virtio sound on a PC", c => { c.sound.device = "virtio"; }, "sound.device"],
    ["the virt section on a PC", c => { c.virt.vsock = true; }, "virt"],
    ["a transport", c => { Object.assign(c, arm64()); c.virt.transport = "isa"; }, "virt.transport"],
    ["input devices", c => { Object.assign(c, arm64()); c.virt.input = ["mouse"]; }, "virt.input"],
    ["console ports", c => { Object.assign(c, arm64()); c.virt.console_ports = 31; }, "virt.console_ports"],
    ["vsock", c => { Object.assign(c, arm64()); c.virt.vsock = 1; }, "virt.vsock"],
    ["a GPU slot without pci", c => { Object.assign(c, arm64()); c.virt.gpu_pci_slot = 2; }, "virt.gpu_pci_slot"],
    ["five virtio cards", c => { Object.assign(c, arm64()); c.network = Array(5).fill(c.network[0]); }, "network"],
    ["two cards served", c => { Object.assign(c, arm64()); c.network = [c.network[0], c.network[0]]; }, "network"],
    ["the CPU worker", c => { c.advanced.cpu_worker = "1"; }, "advanced.cpu_worker"],
    ["the mouse", c => { c.advanced.mouse_disabled = 0; }, "advanced.mouse_disabled"],
    ["cpuid_level", c => { c.advanced.cpuid_level = 0; }, "advanced.cpuid_level"],
    ["cpuid_level on virt", c => { Object.assign(c, arm64()); c.advanced.cpuid_level = 2; }, "advanced.cpuid_level"],
];

function disk(fields) { return Object.assign({ slot: "hda", image: { kind: "url", url: "a.img" }, disk_option: "read_only", disk_error: "stop" }, fields); }
function floppy(fields) { return Object.assign({ slot: "fda", image: null, disk_option: "read_only" }, fields); }
function kernel(fields) { return Object.assign({ bzimage: null, initrd: null, cmdline: null, multiboot: null, from_filesystem: false }, fields); }
/** The sections of a valid arm64 machine */
function arm64()
{
    const c = new_config();
    c.cpu.type = "arm64";
    c.machine.type = "virt";
    c.display.adapter = "virtio_gpu";
    c.network[0].device = "virtio";
    c.sound.device = "none";
    return { cpu: c.cpu, machine: c.machine, display: c.display, network: c.network, sound: c.sound };
}

test("arm64's sections are valid", () => assert.deepEqual(validate_config(new_config(arm64())), []));

test("a problem does not hide the others (only a bad CPU or machine type does)", () =>
{
    const config = new_config({ id: "", name: "" });
    config.cpu.cores = 99;
    config.display.vram_mb = 3;
    assert.deepEqual(validate_config(config).map(p => p.path), ["id", "name", "cpu.cores", "machine.acpi", "display.vram_mb"]);
});

test("every check reports its field (" + RULES.length + " rules)", () =>
{
    for(const [name, change, path] of RULES)
    {
        const config = new_config();
        change(config);
        const problems = validate_config(config);
        assert(problems.some(p => p.path === path), name + ": expected a problem at " + path + ", got " + JSON.stringify(problems));
    }
});

test("config_to_options: the configuration's fields", () =>
{
    const c = new_config({ name: "x" });
    c.machine.type = "q35";
    c.machine.acpi = true;
    c.machine.hpet = false;
    c.machine.pcie_root_ports = 2;
    c.machine.boot_order = 0x213;
    c.machine.fastboot = true;
    c.machine.bootmenu = true;
    c.machine.bios = { kind: "url", url: "bios/bochs-bios.bin" };
    c.cpu = { type: "x86_64", cores: 4, parallel: false, jit: false };
    c.memory.mb = 3000;
    c.disks = [disk({ image: { kind: "url", url: "http://127.0.0.1:8471/a.img", async: true }, disk_option: "read_write", disk_error: "report" }),
        disk({ slot: "hdb", image: { kind: "file", name: "b.img", size: 512, last_modified: 1 } })];
    c.cdrom.image = { kind: "browser", path: "v86/disks/cd.img", size: 2048 };
    c.floppies = [floppy({ image: { kind: "empty", size: 1474560 } })];
    c.kernel = kernel({ bzimage: { kind: "url", url: "k.bin", async: false }, cmdline: "quiet" });
    c.display = { adapter: "virtio_gpu", vram_mb: 32, proxy: false, displays: 2 };
    c.network = [{ device: "virtio", backend: "fetch", relay_url: "https://cors.invalid/", mtu: 9000, mac_address_translation: true }];
    c.sound.device = "none";
    c.serial = [{ port: 0, attach: "terminal" }, { port: 2, attach: "modem" }];
    c.filesystem = { baseurl: "fs/" };
    c.advanced = { cpu_worker: false, ir_tier0: false, x87_fast_math: true, x87_jit_cache: false, cpuid_level: 7, mouse_disabled: false };
    assert.deepEqual(validate_config(c), []);
    const o = config_to_options(c, ENV);
    assert.equal(o.machine_type, "q35");
    assert.equal(o.acpi, true);
    assert.equal(o.hpet, false);
    assert.equal(o.smbus, false);
    assert.equal(o.pcie_root_ports, 2);
    assert.equal(o.boot_order, 0x213);
    assert.equal(o.fastboot, true);
    assert.equal(o.bootmenu, true);
    assert.deepEqual(o.bios, { url: "bios/bochs-bios.bin" });
    assert.deepEqual(o.vga_bios, { url: "bios/vgabios.bin" });
    assert.equal(o.cpu_type, "x86_64");
    assert.equal(o.cpu_cores, 4);
    assert.equal(o.parallel, false);
    assert.equal(o.disable_jit, true);
    assert.equal(o.experimental_smp_jit, false);
    assert.equal(o.memory_size, 2048 * 1024 * 1024);
    assert.equal(o.extended_memory_size, 952 * 1024 * 1024);
    assert.deepEqual(o.hda, { url: "http://127.0.0.1:8471/a.img", async: true, disk_option: "read_write", disk_error: "report" });
    assert(o.hdb.buffer instanceof Blob && o.hdb.buffer.size === 5, "a file's image is the picked File");
    assert.deepEqual(o.cdrom, { url: "opfs:v86/disks/cd.img", size: 2048 });
    assert.equal(o.fda.buffer.byteLength, 1474560);
    assert.deepEqual(o.bzimage, { url: "k.bin", async: false });
    assert.equal(o.cmdline, "quiet");
    assert.equal(o.graphics_adapter, "virtio_gpu");
    assert.equal(o.vram_size, 32 * 1024 * 1024);
    assert.deepEqual(o.graphics_adapter_test, { scanouts: 2 });
    assert.deepEqual(o.net_device, { type: "virtio", relay_url: "fetch", cors_proxy: "https://cors.invalid/", mtu: 9000 });
    assert.equal(o.mac_address_translation, true);
    assert.equal(o.disable_speaker, true);
    assert.deepEqual(o.modem, { uart: 2 });
    assert.deepEqual(o.filesystem, { baseurl: "fs/" });
    assert.equal(o.cpu_worker, false);
    assert.equal(o.ir_tier0, false);
    assert.equal(o.x87_fast_math, true);
    assert.equal(o.x87_jit_cache, false);
    assert.equal(o.cpuid_level, 7);
    assert.deepEqual(check_config(c), []);
});

test("config_to_options: the backends, arm64, a file not chosen yet", () =>
{
    const relay = backend => { const c = new_config(); c.network[0].backend = backend[0]; c.network[0].relay_url = backend[1]; return config_to_options(c, ENV).net_device.relay_url; };
    assert.equal(relay(["none", ""]), "");
    assert.equal(relay(["inbrowser", ""]), "inbrowser");
    assert.equal(relay(["fetch", ""]), "fetch");
    assert.equal(relay(["wisp", "wisps://w.invalid/"]), "wisps://w.invalid/");
    const a = new_config(arm64());
    a.memory.mb = 2048;
    a.cdrom.image = { kind: "url", url: "alpine.iso" };
    a.disks = [disk()];
    const o = config_to_options(a, ENV);
    assert.equal(o.machine_type, "virt");
    assert.deepEqual(o.virtio_disks, [{ url: "alpine.iso", readonly: true }, { url: "a.img" }]);
    assert.deepEqual(o.virtio_input, ["keyboard", "tablet", "multitouch"]);
    assert.deepEqual(o.jit_switches, { a64_page: 1 });
    assert.equal(o.memory_size, 1792 * 1024 * 1024);
    assert.equal(o.extended_memory_size, 256 * 1024 * 1024);
    assert.equal(o.acpi, false);
    assert.deepEqual(check_config(a), []);
    const f = new_config();
    f.disks = [disk({ image: { kind: "file", name: "c.img", size: 512, last_modified: 0 } })];
    assert.throws(() => config_to_options(f, Object.assign({}, ENV, { file: () => undefined })), /c\.img needs to be chosen again/);
});

test("check_config: the library's own checks after validate_config's", () =>
{
    const c = new_config();
    c.disks = [disk({ image: { kind: "url", url: "parts/.img.zst", use_parts: true }, disk_option: "read_write" })];
    assert.deepEqual(validate_config(c), []);
    const problems = check_config(c);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].path, "disks");
    assert.match(problems[0].message, /in parts .* can only be read/);
});

console.log(passed + " tests passed");
