// @ts-check
// The settings dialog's panels of the machine itself (docs/vm-manager-plan.md
// "设置对话框"): general, memory, processor, machine and firmware, advanced.

import { confirm, h } from "../dom.js";
import { image_picker } from "../image_picker.js";
import { ARM_MACHINE_TYPES, DEFAULT_CPU_PROFILES } from "../../../machine_options.js";
import { disk_id, reset_disk } from "../../browser_disks.js";
import { uefi_vars_template } from "../../vm_config.js";

/** @typedef {import("../settings.js").PanelContext} PanelContext */

export const CPU_LABELS = { x86: "x86 (32-bit, up to SSE3)", x86_64: "x86_64 (64-bit, every instruction set)", arm64: "arm64 (64-bit ARM)",
    arm32: "ARM (32-bit, ARMv7-A)" };
/**
 * The CPU models (cpu.profile; docs/iphone4-plan.md "CPU 型号"): the name the
 * panel shows, and what the model is for
 */
export const CPU_PROFILE_LABELS = {
    "generic-x86": ["Generic 32-bit x86 (recommended)", "DOS, Windows 3.x to XP, 32-bit Linux"],
    "generic-x86-64": ["Generic 64-bit x86 (recommended)", "64-bit Windows 8.1 to 11, 64-bit Linux"],
    "generic-arm64": ["Generic 64-bit ARM (recommended)", "64-bit Linux, Android 16"],
    "generic-arm64-compat32": ["Generic 64-bit ARM that runs 32-bit programs",
        "A 64-bit system that runs 32-bit programs too (armhf, armeabi-v7a); their code is interpreted, slower than 64-bit code"],
    "cortex-a15": ["ARM Cortex-A15 (2011)", "32-bit Linux, Android 7.1"],
};
export const MACHINE_LABELS = { i440fx: "i440FX (IDE, PCI)", q35: "Q35 (AHCI, PCI Express)", virt: "virt (ARM, virtio devices)",
    ranchu: "ranchu (the Android Emulator's board)" };
const FIRMWARE_LABELS = { seabios: "SeaBIOS (the default)", bochs: "Bochs BIOS", custom: "An image of your own", uefi: "UEFI (OVMF)" };
const BOOT_ORDER_LABELS = { 0: "Automatic (floppy, then hard disk, then CD)", 0x213: "CD, floppy, hard disk", 0x123: "CD, hard disk, floppy",
    0x231: "Floppy, CD, hard disk", 0x321: "Floppy, hard disk, CD", 0x312: "Hard disk, floppy, CD", 0x132: "Hard disk, CD, floppy" };

/**
 * A select of values
 * @param {string} label
 * @param {Array<any>} values
 * @param {any} value
 * @param {(value: any) => void} on_change
 * @param {(value: any) => string} [text]
 * @param {{disabled?: boolean, title?: string}} [options]
 */
export function select_field(label, values, value, on_change, text = String, options = {})
{
    const select = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": label, disabled: !!options.disabled, title: options.title || "" },
        values.map((v, i) => h("option", { value: String(i), selected: v === value }, text(v)))));
    select.addEventListener("change", () => on_change(values[+select.value]));
    return h("label.field", null, h("span", null, label), select, options.disabled && options.title ? h("small.reason", null, options.title) : null);
}

/**
 * A checkbox; disabled with its reason when the value is fixed
 * @param {string} label
 * @param {boolean} value
 * @param {(value: boolean) => void} on_change
 * @param {string} [fixed_reason]
 */
export function check_field(label, value, on_change, fixed_reason)
{
    const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: value, disabled: !!fixed_reason }));
    box.addEventListener("change", () => on_change(box.checked));
    return h("label.check", { title: fixed_reason || "" }, box, " " + label, fixed_reason ? h("small.reason", null, " (" + fixed_reason + ")") : null);
}

/**
 * A number field, applied when it is left or Enter is pressed
 * @param {string} label
 * @param {number} value
 * @param {{min: number, max: number, step?: number}} range
 * @param {(value: number) => void} on_change
 */
export function number_field(label, value, range, on_change)
{
    const input = /** @type {HTMLInputElement} */ (h("input", { type: "number", value, min: range.min, max: range.max, step: range.step || 1, "aria-label": label }));
    input.addEventListener("change", () =>
    {
        const n = Math.round(+input.value);
        on_change(Number.isFinite(n) ? Math.min(range.max, Math.max(range.min, n)) : value);
    });
    return h("label.field", null, h("span", null, label), input);
}

/**
 * A text field, applied when it is left or Enter is pressed
 * @param {string} label
 * @param {string} value
 * @param {(value: string) => void} on_change
 * @param {{multiline?: boolean, placeholder?: string}} [options]
 */
export function text_field(label, value, on_change, options = {})
{
    const input = /** @type {HTMLInputElement} */ (h(options.multiline ? "textarea" : "input",
        { type: "text", value, placeholder: options.placeholder || "", "aria-label": label, rows: 4 }));
    if(options.multiline) input.value = value;
    input.addEventListener("change", () => on_change(input.value));
    return h("label.field", null, h("span", null, label), input);
}

/** @param {PanelContext} ctx */
export function general_panel(ctx)
{
    return [
        text_field("Name", ctx.config.name, value => ctx.set("name", value.trim())),
        text_field("Notes", ctx.config.notes, value => ctx.set("notes", value), { multiline: true }),
    ];
}

/** @param {PanelContext} ctx */
export function memory_panel(ctx)
{
    const c = ctx.config;
    return [
        number_field("Memory in MB", c.memory.mb, { min: 16, max: ctx.choices.max_memory, step: 16 }, mb => ctx.set("memory.mb", mb)),
        h("p.note", null, c.cpu.type === "x86" ? "The 32-bit CPU reaches 2048 MB; more chooses x86_64." :
            c.cpu.type === "arm32" ? "The 32-bit ARM CPU reaches 2048 MB (its kernels' high memory above 768 MB)." :
            "Up to 2048 MB live in the WebAssembly heap, the rest in extended RAM above 4 GiB (64-bit guests only)."),
    ];
}

/** @param {PanelContext} ctx */
export function processor_panel(ctx)
{
    const c = ctx.config;
    const cores = Array.from({ length: ctx.choices.max_cores }, (_, i) => i + 1);
    return [
        select_field("CPU", ctx.choices.cpu_types, c.cpu.type, value => ctx.set("cpu.type", value), v => CPU_LABELS[v] || v),
        select_field("Cores", cores, c.cpu.cores, value => ctx.set("cpu.cores", value)),
        check_field("Run the cores in host threads where the page allows it (otherwise they take turns)", c.cpu.parallel, value => ctx.set("cpu.parallel", value),
            c.cpu.cores === 1 ? "one core" : undefined),
        check_field("JIT compiler", c.cpu.jit, value => ctx.set("cpu.jit", value)),
        // (the CPU model: automatic is the CPU type's default; a real chip only where software checks which CPU it is)
        select_field("CPU model", ctx.choices.cpu_profiles, c.cpu.profile, value => ctx.set("cpu.profile", value),
            v => v === null ? "Automatic (the system decides)" : CPU_PROFILE_LABELS[v]?.[0] || v),
        h("p.note", null, CPU_PROFILE_LABELS[c.cpu.profile || DEFAULT_CPU_PROFILES[c.cpu.type]]?.[1] || ""),
    ];
}

/** @param {PanelContext} ctx */
export function machine_panel(ctx)
{
    const c = ctx.config, ch = ctx.choices;
    // (an ARM board, virt or ranchu: no PC firmware)
    const arm = ARM_MACHINE_TYPES.includes(c.machine.type);
    const q35 = c.machine.type === "q35";
    const bochs = !!(c.machine.bios && c.machine.bios.kind === "url" && c.machine.bios.url === "bios/bochs-bios.bin");
    const firmware = c.machine.firmware === "uefi" ? "uefi" : c.machine.bios === null ? "seabios" : bochs ? "bochs" : "custom";
    const firmware_field = select_field("Firmware", ["seabios", "bochs", "custom", "uefi"], firmware, value =>
    {
        ctx.edit(next =>
        {
            next.machine.firmware = value === "uefi" ? "uefi" : "seabios";
            next.machine.bios = value === "seabios" || value === "uefi" ? null : value === "bochs" ? { kind: "url", url: "bios/bochs-bios.bin" } :
                { kind: "url", url: "", async: false };
            next.machine.vga_bios = value === "bochs" ? { kind: "url", url: "bios/bochs-vgabios.bin" } : value === "seabios" || value === "uefi" ? null :
                next.machine.vga_bios;
            // (OVMF is the X64 build: the 64-bit CPU, with ACPI)
            if(value === "uefi")
            {
                next.cpu.type = "x86_64";
                next.machine.acpi = true;
            }
        });
    }, v => FIRMWARE_LABELS[v], arm ? { disabled: true, title: ch.unavailable["bios"] } : {});
    return [
        select_field("Machine", ch.machine_types, c.machine.type, value => ctx.set("machine.type", value), v => MACHINE_LABELS[v] || v),
        firmware_field,
        !arm && firmware === "uefi" ? uefi_fields(ctx) : null,
        !arm && firmware === "custom" ? [
            image_picker({ label: "BIOS image", role: "file", image: c.machine.bios, store: ctx.store, on_change: image => ctx.set("machine.bios", image) }),
            image_picker({ label: "VGA BIOS image", role: "file", optional: true, image: c.machine.vga_bios, store: ctx.store,
                on_change: image => ctx.set("machine.vga_bios", image) }),
        ] : null,
        check_field("ACPI", c.machine.acpi, value => ctx.set("machine.acpi", value), ch.acpi_fixed ? ch.acpi_fixed.reason : undefined),
        check_field("HPET (high precision event timer)", c.machine.hpet, value => ctx.set("machine.hpet", value), q35 ? undefined : ch.unavailable["hpet"]),
        check_field("SMBus controller", c.machine.smbus, value => ctx.set("machine.smbus", value), q35 ? undefined : ch.unavailable["smbus"]),
        q35 ? number_field("PCI Express root ports", c.machine.pcie_root_ports, { min: 0, max: 6 }, value => ctx.set("machine.pcie_root_ports", value)) :
            h("p.note", null, "PCI Express root ports: " + ch.unavailable["pcie_root_ports"]),
        select_field("Boot order", ch.boot_orders, c.machine.boot_order, value => ctx.set("machine.boot_order", value), v => BOOT_ORDER_LABELS[v],
            arm ? { disabled: true, title: "the " + c.machine.type + " machine boots its kernel" } : {}),
        check_field("Fast boot (no boot menu delay)", c.machine.fastboot, value => ctx.set("machine.fastboot", value), arm ? "no PC firmware" : undefined),
        check_field("Boot menu", c.machine.bootmenu, value => ctx.set("machine.bootmenu", value), arm ? "no PC firmware" : undefined),
    ];
}

const SECURE_BOOT_KEY_LABELS = {
    microsoft: "Microsoft's (Windows; Linux through shim)",
    none: "None: Setup Mode (enroll your own)",
};

/**
 * The UEFI firmware's note, Secure Boot and the variable store's reset
 * @param {PanelContext} ctx
 */
function uefi_fields(ctx)
{
    const c = ctx.config;
    const vars = c.machine.uefi_vars;
    const q35 = c.machine.type === "q35";
    const status = h("small.reason", { role: "status" });
    const reset = /** @type {HTMLButtonElement} */ (h("button", { type: "button", disabled: !vars || vars.kind !== "browser",
        title: vars ? "" : "The variable store is made at the first power-on" }, "Reset UEFI variables…"));
    reset.addEventListener("click", async () =>
    {
        if(!vars || vars.kind !== "browser") return;
        const keys = c.machine.secure_boot && c.machine.secure_boot_keys === "microsoft" ? "Microsoft's Secure Boot keys" : "no Secure Boot keys";
        if(!await confirm("Reset UEFI variables?", "The firmware's variables (its boot entries, its settings) go back to the template's, " +
            "with " + keys + "; the firmware makes its boot entries again at the next power-on.", "Reset", true)) return;
        reset.disabled = true;
        status.textContent = "Resetting…";
        try
        {
            await reset_disk(disk_id(vars.path), uefi_vars_template(c.machine));
            status.textContent = "Reset: the template's variables, " + keys + ".";
        }
        catch(e)
        {
            status.textContent = "Not reset: " + e.message;
        }
        reset.disabled = false;
    });
    return [
        h("p.note", null, "UEFI is OVMF (edk2-stable202408, as QEMU ships it) on the x86_64 CPU; on i440FX the devices take QEMU's places. " +
            "Its variables (boot entries, settings) are kept in a browser disk of the machine's, made at the first power-on " +
            "(with the CPU in a Worker; otherwise they last until the machine is turned off)."),
        check_field("Secure Boot", c.machine.secure_boot, value => ctx.set("machine.secure_boot", value),
            q35 ? undefined : "Secure Boot needs the Q35 machine (its firmware runs in SMM)"),
        c.machine.secure_boot ? [
            select_field("Secure Boot keys", Object.keys(SECURE_BOOT_KEY_LABELS), c.machine.secure_boot_keys,
                value => ctx.set("machine.secure_boot_keys", value), v => SECURE_BOOT_KEY_LABELS[v]),
            h("p.note", null, "The firmware loads only what the keys allow, and only its own code in SMM changes them. " +
                "The keys are enrolled when the variable store is made (the first power-on) or reset: after changing Secure Boot " +
                "or its keys, Reset UEFI variables… enrolls them."),
        ] : null,
        h("div.field", null, reset, " ", status),
    ];
}

/** @param {PanelContext} ctx */
export function advanced_panel(ctx)
{
    const c = ctx.config, a = c.advanced;
    const virt = ARM_MACHINE_TYPES.includes(c.machine.type);
    return [
        check_field("Run the CPU in a Worker (the page stays responsive)", a.cpu_worker, value => ctx.set("advanced.cpu_worker", value)),
        check_field("Compile 32-bit code in the x64 page tier (ir_tier0)", a.ir_tier0, value => ctx.set("advanced.ir_tier0", value), virt ? "x86 only" : undefined),
        check_field("x87: fast arithmetic in 64-bit floats", a.x87_fast_math, value => ctx.set("advanced.x87_fast_math", value), virt ? "x86 only" : undefined),
        check_field("x87: cached compiled regions", a.x87_jit_cache, value => ctx.set("advanced.x87_jit_cache", value), virt ? "x86 only" : undefined),
        virt ? h("p.note", null, "CPUID level: " + ctx.choices.unavailable["cpuid_level"]) :
            select_field("CPUID level", [null, 1, 2, 4, 7, 0xd], a.cpuid_level, value => ctx.set("advanced.cpuid_level", value),
                v => v === null ? "The CPU's own" : "Level " + v + (v === 2 ? " (Windows NT 4)" : "")),
        check_field("Mouse off at the start", a.mouse_disabled, value => ctx.set("advanced.mouse_disabled", value)),
        image_picker({ label: "Start from a saved state", role: "file", optional: true, image: c.initial_state, store: ctx.store,
            on_change: image => ctx.edit(next => { next.initial_state = image; if(image === null && next.display.vram_mb === null) next.display.vram_mb = 8; }) }),
    ];
}
