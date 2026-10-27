#!/usr/bin/env node
// allowed_options (src/machine_options.js, docs/vm-manager-plan.md U0): what
// it allows is what the library accepts, for every CPU, machine, display
// adapter and network card, and the options it marks unavailable are
// rejected (check_machine_options, and the PC platform's own checks).
//   node tests/app/machine_rules.mjs

import assert from "node:assert/strict";
import { ARM_MACHINE_TYPES, CPU_TYPES, MACHINE_TYPES, GRAPHICS_ADAPTERS, NET_DEVICE_TYPES, MAX_CORES, PC_ONLY, VIRT_ONLY, Q35_ONLY,
    allowed_options, check_machine_options } from "../../src/machine_options.js";
import { create_platform } from "../../src/platform.js";
import { VIRT_MAX_CORES } from "../../src/virt/platform.js";

const accepts = options => { try { check_machine_options(options); return true; } catch(e) { return false; } };
let checks = 0;
// (a valid value of the options that are not booleans)
const VALUES = { virtio_input: ["keyboard"], virtio_transport: "pci", audio_device: "hd_audio",
    audio_device_path: "build/v86-hd-audio.js", usb: { controller: "uhci", tablet: true }, firmware: { type: "seabios" }, tpm: { version: "2.0" } };

assert.equal(VIRT_MAX_CORES, MAX_CORES, "the virt machine's cores");
for(const cpu_type of CPU_TYPES)
{
    for(const machine_type of MACHINE_TYPES)
    {
        const allowed = allowed_options(cpu_type, machine_type);
        const valid = allowed.machine_types.includes(machine_type);
        assert.equal(accepts({ cpu_type, machine_type }), valid, cpu_type + " on " + machine_type);
        checks++;
        if(!valid) continue;
        for(const adapter of GRAPHICS_ADAPTERS)
        {
            assert.equal(accepts({ cpu_type, machine_type, graphics_adapter: adapter }), allowed.graphics_adapters.includes(adapter),
                cpu_type + " on " + machine_type + " with " + adapter);
            checks++;
        }
        for(const type of NET_DEVICE_TYPES)
        {
            assert.equal(accepts({ cpu_type, machine_type, net_device: { type } }), allowed.net_device_types.includes(type),
                cpu_type + " on " + machine_type + " with " + type);
            checks++;
        }
        for(const name of [...PC_ONLY, ...VIRT_ONLY, "acpi"])
        {
            const rejected = !accepts({ cpu_type, machine_type, [name]: VALUES[name] === undefined ? true : VALUES[name] });
            if(name in allowed.unavailable)
            {
                assert(rejected || Q35_ONLY.includes(name), name + " on " + machine_type + " is unavailable but accepted");
            }
            else
            {
                assert(!rejected, name + " on " + machine_type + " is available but rejected");
            }
            checks++;
        }
        if(!ARM_MACHINE_TYPES.includes(machine_type))
        {
            // (the PC platform's checks: Q35's devices, ACPI)
            const platform = settings => { try { create_platform(Object.assign({ machine_type, acpi: true }, settings), 128 << 20); return true; } catch(e) { return false; } };
            for(const name of Q35_ONLY)
            {
                assert.equal(platform({ [name]: name === "pcie_root_ports" ? 1 : true }), !(name in allowed.unavailable), name + " on " + machine_type);
                checks++;
            }
            assert.equal(platform({ acpi: false }), allowed.acpi === "with_cores", "acpi: false on " + machine_type);
            assert.equal(platform({ acpi: false, cpu_cores: 2 }), false, "two cores without ACPI on " + machine_type);
            assert.equal(platform({ cpu_cores: allowed.max_cores }), true, allowed.max_cores + " cores on " + machine_type);
            assert.equal(platform({ cpu_cores: allowed.max_cores + 1 }), false, allowed.max_cores + 1 + " cores on " + machine_type);
            checks += 4;
        }
        else
        {
            assert.equal(allowed.acpi, "none");
        }
    }
}
// UEFI (docs/uefi.md): the x86_64 CPU with ACPI, its code image, no BIOS
// images; on i440FX QEMU's layout
const uefi = { type: "uefi", code: { url: "c.fd" } };
for(const [options, accepted] of [
    [{ cpu_type: "x86_64", machine_type: "q35", acpi: true, firmware: uefi }, true],
    [{ cpu_type: "x86_64", machine_type: "i440fx", acpi: true, qemu_compatible: true, firmware: uefi }, true],
    [{ cpu_type: "x86_64", machine_type: "i440fx", acpi: true, firmware: uefi }, false],
    [{ cpu_type: "x86", machine_type: "q35", acpi: true, firmware: uefi }, false],
    [{ cpu_type: "x86_64", machine_type: "q35", firmware: uefi }, false],
    [{ cpu_type: "x86_64", machine_type: "q35", acpi: true, firmware: { type: "uefi" } }, false],
    [{ cpu_type: "x86_64", machine_type: "q35", acpi: true, firmware: uefi, bios: { url: "b.bin" } }, false],
    [{ cpu_type: "arm64", machine_type: "virt", firmware: uefi }, false],
])
{
    assert.equal(accepts(options), accepted, JSON.stringify(options));
    checks++;
}
console.log("PASS: " + checks + " checks of allowed_options");
