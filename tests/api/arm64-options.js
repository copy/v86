#!/usr/bin/env node

// The guest CPU and machine combinations of new V86()
// (docs/arm64-virt-android16-plan.md P1.1, src/machine_options.js):
// - cpu_type x86 and x86_64 run on machine_type i440fx (their default) and
//   q35, cpu_type arm64 and arm32 on virt (their default) and ranchu (the
//   Android emulator's board); every other combination fails
//   in the constructor, and the x86 CPU's init refuses virt again;
// - an option of the other family is an error, never ignored: the PC
//   machines' firmware, disks and chipset options on virt, kernel, dtb,
//   virtio_disks, virtio_rng, virtio_transport and virtio_input on the PC machines;
// - virt has no VGA (graphics_adapter "none" or "virtio_gpu"), virtio-net
//   only, and no ACPI; ranchu has the emulator's framebuffer (graphics_adapter
//   "none") and no PCIe (virtio_transport "mmio").

import assert from "node:assert/strict";
import { CPU_TYPES, DEFAULT_CPU_PROFILES, MACHINE_TYPES, check_machine_options } from "../../src/machine_options.js";

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

assert.deepEqual(CPU_TYPES, ["x86", "x86_64", "arm64", "arm32"]);
assert.deepEqual(MACHINE_TYPES, ["i440fx", "q35", "virt", "ranchu"]);

// the matrix
const runs = { x86: ["i440fx", "q35"], x86_64: ["i440fx", "q35"], arm64: ["virt", "ranchu"], arm32: ["virt", "ranchu"] };
for(const cpu_type of CPU_TYPES)
{
    for(const machine_type of MACHINE_TYPES)
    {
        const options = { cpu_type, machine_type };
        if(runs[cpu_type].includes(machine_type))
        {
            assert.deepEqual(check_machine_options(options), { ...options, cpu_profile: DEFAULT_CPU_PROFILES[cpu_type] });
        }
        else
        {
            assert.throws(() => check_machine_options(options), /does not run on machine_type/, JSON.stringify(options));
            assert.throws(() => new V86({ graphics_adapter: "none", cpu_type, machine_type, autostart: false }),
                /does not run on machine_type/, "constructor: " + JSON.stringify(options));
        }
    }
}
console.log("PASS the cpu_type and machine_type matrix");

// defaults
assert.deepEqual(check_machine_options({}), { cpu_type: "x86", machine_type: "i440fx", cpu_profile: "generic-x86" });
assert.deepEqual(check_machine_options({ cpu_type: "x86_64" }), { cpu_type: "x86_64", machine_type: "i440fx", cpu_profile: "generic-x86-64" });
assert.deepEqual(check_machine_options({ cpu_type: "arm64" }), { cpu_type: "arm64", machine_type: "virt", cpu_profile: "generic-arm64" });
assert.deepEqual(check_machine_options({ cpu_type: "arm32" }), { cpu_type: "arm32", machine_type: "virt", cpu_profile: "cortex-a15" });
console.log("PASS defaults: i440fx with x86, virt with arm64 and arm32");

// unknown names
for(const cpu_type of ["aarch64", "arm", "x86-64", ""])
{
    assert.throws(() => check_machine_options({ cpu_type }), /Unknown cpu_type .*supported: "x86", "x86_64", "arm64", "arm32"/);
}
assert.throws(() => check_machine_options({ machine_type: "pc" }), /machine_type must be one of "i440fx", "q35", "virt", "ranchu"/);
assert.throws(() => check_machine_options({ experimental_x64: true }), /experimental_x64 was replaced/);
console.log("PASS unknown cpu_type and machine_type");

// the CPU model (cpu_profile, docs/iphone4-plan.md "CPU 型号"; the arm64 profiles of docs/aarch32-plan.md Q7.2)
for(const cpu_profile of ["generic-arm64-v1", "generic-arm64-v1.1", "generic-arm64", "generic-arm64-compat32"])
{
    assert.equal(check_machine_options({ cpu_type: "arm64", cpu_profile }).cpu_profile, cpu_profile);
}
assert.equal(check_machine_options({ cpu_type: "arm64" }).cpu_profile, "generic-arm64", "arm64's default");
assert.equal(check_machine_options({ cpu_type: "arm32" }).cpu_profile, "cortex-a15", "arm32's default");
assert.equal(check_machine_options({}).cpu_profile, "generic-x86", "the PC's default");
assert.equal(check_machine_options({ cpu_type: "x86_64" }).cpu_profile, "generic-x86-64");
// (a model alone picks its CPU type)
assert.deepEqual(check_machine_options({ cpu_profile: "cortex-a15" }), { cpu_type: "arm32", machine_type: "virt", cpu_profile: "cortex-a15" });
assert.deepEqual(check_machine_options({ cpu_profile: "generic-x86-64" }), { cpu_type: "x86_64", machine_type: "i440fx", cpu_profile: "generic-x86-64" });
assert.throws(() => check_machine_options({ cpu_type: "arm32", cpu_profile: "generic-arm64-compat32" }),
    /cpu_profile "generic-arm64-compat32" is a CPU of cpu_type "arm64", not "arm32"; cpu_type "arm32" has "cortex-a15"/);
assert.throws(() => check_machine_options({ cpu_type: "x86_64", cpu_profile: "generic-arm64" }), /is a CPU of cpu_type "arm64", not "x86_64"/);
assert.throws(() => check_machine_options({ cpu_profile: "v3" }), /Unknown cpu_profile "v3"; supported: "generic-x86"/);
assert.throws(() => check_machine_options({ cpu_type: "arm64", a64_profile: "v3" }), /a64_profile was replaced by cpu_profile/);
assert.equal(check_machine_options({ cpu_type: "arm32", machine_type: "ranchu", cpu_profile: "cortex-a15" }).cpu_profile, "cortex-a15");
console.log("PASS cpu_profile");

// PC options on virt
const pc_options = {
    bzimage: { url: "bzImage" }, multiboot: { url: "x" }, bios: { url: "seabios.bin" }, vga_bios: { url: "vgabios.bin" },
    fda: { url: "a" }, fdb: { url: "b" }, cdrom: { url: "c" }, hpet: true, smbus: true, pcie_root_ports: 2, qemu_compatible: true,
    uart1: true, uart2: true, uart3: true, parallel1: true, modem: { uart: 1 }, cpuid_level: 0xD, x87_fast_math: true,
    x87_jit_cache: true, high_memory_size: 1 << 30, cpu_features: ["XSAVE"],
};
for(const [name, value] of Object.entries(pc_options))
{
    assert.throws(() => check_machine_options({ cpu_type: "arm64", [name]: value }),
        new RegExp("^Error: " + name + " is an option of the PC machines"), name);
    assert.doesNotThrow(() => check_machine_options({ cpu_type: "x86", [name]: value }), name);
}
// (false and undefined are no options)
assert.doesNotThrow(() => check_machine_options({ cpu_type: "arm64", hpet: false, uart1: false, acpi: false, bios: undefined }));
assert.throws(() => check_machine_options({ cpu_type: "arm64", acpi: true }), /acpi: true is an option of the PC machines/);
// (extended RAM is the 64-bit CPUs': at 4 GiB on virt, P8.5)
assert.doesNotThrow(() => check_machine_options({ cpu_type: "arm64", extended_memory_size: 1 << 30 }));
console.log(`PASS ${Object.keys(pc_options).length + 1} PC options refused on virt`);

// virt options on the PC machines
for(const [name, value] of Object.entries({ kernel: { url: "Image" }, dtb: { url: "virt.dtb" }, virtio_disks: [{ url: "disk.img" }],
    virtio_rng: true, virtio_transport: "pci", virtio_input: true }))
{
    for(const cpu_type of ["x86", "x86_64"])
    {
        assert.throws(() => check_machine_options({ cpu_type, [name]: value }), new RegExp(name + " is an option of machine_type \"virt\""));
    }
    assert.doesNotThrow(() => check_machine_options({ cpu_type: "arm64", [name]: value }));
}
console.log("PASS kernel, dtb, virtio_disks, virtio_rng, virtio_transport and virtio_input refused on the PC machines");

// virt's devices
for(const adapter of ["none", "virtio_gpu"])
{
    assert.doesNotThrow(() => check_machine_options({ cpu_type: "arm64", graphics_adapter: adapter }));
}
for(const adapter of ["bochs_vga", "vmware_svga"])
{
    assert.throws(() => check_machine_options({ cpu_type: "arm64", graphics_adapter: adapter }), /is not on machine_type "virt" \(no VGA\)/);
}
assert.doesNotThrow(() => check_machine_options({ cpu_type: "arm64", net_device: { type: "virtio" } }));
assert.throws(() => check_machine_options({ cpu_type: "arm64", net_device: { type: "ne2k" } }), /it has virtio-net/);
assert.throws(() => check_machine_options({ cpu_type: "arm64", hda: { url: "a" }, virtio_disks: [{ url: "b" }] }), /give one of them/);
assert.doesNotThrow(() => check_machine_options({ cpu_type: "arm64", hda: { url: "a" }, hdb: { url: "b" } }));
assert.doesNotThrow(() => check_machine_options({ cpu_type: "arm64", cpu_cores: 4 }));
// (the virtio devices' transport, P5.7; the input devices, P5.8, P7.4)
for(const transport of ["mmio", "pci"]) assert.doesNotThrow(() => check_machine_options({ cpu_type: "arm64", virtio_transport: transport }));
assert.throws(() => check_machine_options({ cpu_type: "arm64", virtio_transport: "isa" }), /virtio_transport is "mmio" \(the default\) or "pci"/);
assert.doesNotThrow(() => check_machine_options({ cpu_type: "arm64", virtio_input: ["keyboard", "tablet", "multitouch"] }));
assert.throws(() => check_machine_options({ cpu_type: "arm64", virtio_input: ["joystick"] }), /virtio_input is true or a list/);
// (ranchu: the emulator's framebuffer, virtio-mmio only)
assert.doesNotThrow(() => check_machine_options({ cpu_type: "arm32", machine_type: "ranchu", graphics_adapter: "none", virtio_transport: "mmio" }));
assert.throws(() => check_machine_options({ cpu_type: "arm32", machine_type: "ranchu", graphics_adapter: "virtio_gpu" }),
    /"virtio_gpu" is not on machine_type "ranchu"/);
assert.throws(() => check_machine_options({ cpu_type: "arm64", machine_type: "ranchu", virtio_transport: "pci" }), /no PCIe host/);
assert.doesNotThrow(() => check_machine_options({ cpu_type: "arm32", machine_type: "ranchu", ranchu_display: { width: 320, height: 480, dpi: 160 } }));
assert.throws(() => check_machine_options({ cpu_type: "arm32", ranchu_properties: { a: "b" } }), /ranchu_properties is an option of machine_type "ranchu"/);
assert.doesNotThrow(() => check_machine_options({ cpu_type: "arm32", machine_type: "ranchu", ranchu_gpu: "host" }));
assert.throws(() => check_machine_options({ cpu_type: "arm32", machine_type: "ranchu", ranchu_gpu: "angle" }), /ranchu_gpu must be "guest" or "host"/);
assert.throws(() => check_machine_options({ cpu_type: "arm64", ranchu_gpu: "host" }), /ranchu_gpu is an option of machine_type "ranchu"/);
console.log("PASS virt's display, network, disks, cores, virtio transport and input devices; ranchu's");

// the constructor checks, before it loads anything
assert.throws(() => new V86({ graphics_adapter: "bochs_vga", cpu_type: "arm64", autostart: false }), /"bochs_vga" is not on machine_type "virt"/);
assert.throws(() => new V86({ graphics_adapter: "none", cpu_type: "arm64", bios: { url: "seabios.bin" }, autostart: false }),
    /bios is an option of the PC machines/);
assert.throws(() => new V86({ graphics_adapter: "bochs_vga", kernel: { url: "Image" }, autostart: false }), /kernel is an option of machine_type "virt"/);
console.log("PASS the constructor refuses them");
