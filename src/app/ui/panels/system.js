// @ts-check
// The settings dialog's panels of the machine itself (docs/vm-manager-plan.md
// "设置对话框"): general, memory, processor, machine and firmware, advanced.

import { h } from "../dom.js";
import { image_picker } from "../image_picker.js";

/** @typedef {import("../settings.js").PanelContext} PanelContext */

export const CPU_LABELS = { x86: "x86 (32-bit, up to SSE3)", x86_64: "x86_64 (64-bit, every instruction set)", arm64: "arm64 (the virt machine)" };
/** The arm64 CPU's profiles the panel offers (cpu.profile; null is v2, the library's default) */
export const A64_PROFILE_LABELS = { v2: "Armv8.0-A: 64-bit programs", v3: "Armv8.0-A and 32-bit programs (AArch32 at EL0)" };
export const MACHINE_LABELS = { i440fx: "i440FX (IDE, PCI)", q35: "Q35 (AHCI, PCI Express)", virt: "virt (arm64, virtio devices)" };
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
        ...(c.cpu.type === "arm64" ? [
            select_field("Instruction sets", Object.keys(A64_PROFILE_LABELS), c.cpu.profile || "v2", value => ctx.set("cpu.profile", value === "v2" ? null : value),
                v => A64_PROFILE_LABELS[v] || v),
            h("p.note", null, "32-bit programs (armhf, armeabi-v7a) run on a 64-bit kernel with COMPAT; their code is interpreted, slower than 64-bit code."),
        ] : []),
    ];
}

/** @param {PanelContext} ctx */
export function machine_panel(ctx)
{
    const c = ctx.config, ch = ctx.choices;
    const virt = c.machine.type === "virt";
    const q35 = c.machine.type === "q35";
    const bochs = !!(c.machine.bios && c.machine.bios.kind === "url" && c.machine.bios.url === "bios/bochs-bios.bin");
    const firmware = c.machine.bios === null ? "seabios" : bochs ? "bochs" : "custom";
    const firmware_field = select_field("Firmware", ["seabios", "bochs", "custom"], firmware, value =>
    {
        ctx.edit(next =>
        {
            next.machine.bios = value === "seabios" ? null : value === "bochs" ? { kind: "url", url: "bios/bochs-bios.bin" } : { kind: "url", url: "", async: false };
            next.machine.vga_bios = value === "bochs" ? { kind: "url", url: "bios/bochs-vgabios.bin" } : value === "seabios" ? null : next.machine.vga_bios;
        });
    }, v => ({ seabios: "SeaBIOS (the default)", bochs: "Bochs BIOS", custom: "An image of your own" })[v], virt ? { disabled: true, title: ch.unavailable["bios"] } : {});
    return [
        select_field("Machine", ch.machine_types, c.machine.type, value => ctx.set("machine.type", value), v => MACHINE_LABELS[v] || v),
        firmware_field,
        !virt && firmware === "custom" ? [
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
            virt ? { disabled: true, title: "the virt machine boots its kernel" } : {}),
        check_field("Fast boot (no boot menu delay)", c.machine.fastboot, value => ctx.set("machine.fastboot", value), virt ? "no PC firmware" : undefined),
        check_field("Boot menu", c.machine.bootmenu, value => ctx.set("machine.bootmenu", value), virt ? "no PC firmware" : undefined),
    ];
}

/** @param {PanelContext} ctx */
export function advanced_panel(ctx)
{
    const c = ctx.config, a = c.advanced;
    const virt = c.machine.type === "virt";
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
