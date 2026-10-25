// The virt machine's device tree (docs/arm64-virt-android16-plan.md P4.1): a
// flattened device tree (devicetree specification v0.4, version 17) of what
// the machine has, laid out as the reference's (QEMU 9.2 virt, dumpdtb): the
// same nodes, properties and phandle numbering (the clock 0x8000, the cores
// from the last one up, then the GIC), so the two compare node for node.
// v86 has no flash, fw-cfg, PL061 and gpio-keys, or platform bus; those
// nodes are absent (allowed differences, tests/platform/a64-profile.json).
// The PCIe host bridge (P5.6) is the reference's: its ECAM, windows and
// interrupt map.

import {
    VIRT_GIC_DIST, VIRT_GIC_DIST_SIZE, VIRT_GIC_REDIST, VIRT_MMIO, VIRT_MMIO_COUNT, VIRT_MMIO_SIZE, VIRT_PCIE_ECAM_HIGH,
    VIRT_PCIE_ECAM_SIZE, VIRT_PCIE_MMIO, VIRT_PCIE_MMIO_HIGH, VIRT_PCIE_MMIO_HIGH_SIZE, VIRT_PCIE_MMIO_SIZE, VIRT_PCIE_PIO,
    VIRT_PCIE_PIO_SIZE, VIRT_RAM_BASE, VIRT_RTC, VIRT_UART,
} from "./platform.js";

const FDT_MAGIC = 0xD00DFEED;
const FDT_BEGIN_NODE = 1, FDT_END_NODE = 2, FDT_PROP = 3, FDT_END = 9;

/** The size of the low redistributor region in the reference's map (room for 123 cores) */
const GIC_REDIST_REGION_SIZE = 0xF60000;
/** The reference's PCLK for the PrimeCells: 24 MHz */
const APB_PCLK_HZ = 24000000;

/**
 * A node: its name, properties in order ([name, value]: a string, an array
 * of strings, an array of 32-bit cells, true for an empty property, or a
 * Uint8Array), and its children
 * @typedef {{name: string, props: !Array, children: !Array}}
 */
export var DtNode;

/**
 * @param {string} name
 * @param {!Array} props
 * @param {!Array=} children
 * @return {DtNode}
 */
export function node(name, props, children = [])
{
    return { name, props, children };
}

/** Cells of a 64-bit value: high, low */
const u64 = value => [Math.floor(value / 0x100000000), value >>> 0];

function encode_value(value)
{
    if(value === true) return new Uint8Array(0);
    if(value instanceof Uint8Array) return value;
    if(typeof value === "string") value = [value];
    if(typeof value[0] === "string")
    {
        const parts = value.map(s => new TextEncoder().encode(s + "\0"));
        const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for(const p of parts) { bytes.set(p, at); at += p.length; }
        return bytes;
    }
    const bytes = new Uint8Array(4 * value.length);
    const view = new DataView(bytes.buffer);
    value.forEach((cell, i) => view.setUint32(4 * i, cell >>> 0));
    return bytes;
}

/**
 * The flattened device tree of `root`
 * @param {DtNode} root
 * @param {number=} boot_cpu
 * @return {!Uint8Array}
 */
export function flatten(root, boot_cpu = 0)
{
    const structure = [];
    const strings = [];
    const string_offsets = new Map();
    let strings_size = 0;
    const word = w => structure.push(w >>> 0);
    const bytes_padded = bytes => {
        for(let i = 0; i < bytes.length; i += 4)
        {
            word((bytes[i] << 24 | (bytes[i + 1] || 0) << 16 | (bytes[i + 2] || 0) << 8 | (bytes[i + 3] || 0)) >>> 0);
        }
    };
    const string_offset = name => {
        if(!string_offsets.has(name))
        {
            string_offsets.set(name, strings_size);
            const bytes = new TextEncoder().encode(name + "\0");
            strings.push(bytes);
            strings_size += bytes.length;
        }
        return string_offsets.get(name);
    };
    const emit = n => {
        word(FDT_BEGIN_NODE);
        bytes_padded(new TextEncoder().encode(n.name + "\0"));
        for(const [name, value] of n.props)
        {
            const bytes = encode_value(value);
            word(FDT_PROP);
            word(bytes.length);
            word(string_offset(name));
            bytes_padded(bytes);
        }
        for(const child of n.children) emit(child);
        word(FDT_END_NODE);
    };
    emit(root);
    word(FDT_END);
    const header_size = 40, rsvmap_size = 16;
    const off_struct = header_size + rsvmap_size;
    const size_struct = 4 * structure.length;
    const off_strings = off_struct + size_struct;
    const total = off_strings + strings_size;
    const out = new Uint8Array((total + 7) & ~7);
    const view = new DataView(out.buffer);
    [FDT_MAGIC, out.length, off_struct, off_strings, header_size, 17, 16, boot_cpu, strings_size, size_struct]
        .forEach((value, i) => view.setUint32(4 * i, value >>> 0));
    // (the memory reservation block: empty, its terminating entry)
    structure.forEach((w, i) => view.setUint32(off_struct + 4 * i, w));
    let at = off_strings;
    for(const s of strings) { out.set(s, at); at += s.length; }
    return out;
}

/**
 * The virt machine's tree
 * (`arm32`: cpu_type "arm32"'s: PSCI's 32-bit function numbers, Cortex-A15
 * cores, no PCIe, whose ECAM and window are above 4 GiB)
 * @param {{cores: number, memory_size: number, bootargs: (string|undefined),
 *          initrd: ({start: number, end: number}|undefined), rng_seed: (Uint8Array|undefined),
 *          extended: ({base: number, size: number}|undefined), arm32: (boolean|undefined)}} m
 * @return {DtNode}
 */
export function virt_tree(m)
{
    const clock = 0x8000;
    const cpu_phandle = i => 0x8000 + m.cores - i;
    const gic = 0x8000 + m.cores + 1;
    const spi = (n, type) => [0, n, type];
    const children = [];
    // (SMC64's function numbers, SMC32's for a 32-bit kernel)
    const smc = m.arm32 ? 0x84000000 : 0xC4000000;
    children.push(node("psci", [
        ["migrate", [smc | 5]], ["cpu_on", [smc | 3]], ["cpu_off", [0x84000002]], ["cpu_suspend", [smc | 1]],
        ["method", "hvc"], ["compatible", ["arm,psci-1.0", "arm,psci-0.2", "arm,psci"]],
    ]));
    children.push(node("memory@" + VIRT_RAM_BASE.toString(16), [
        ["reg", [...u64(VIRT_RAM_BASE), ...u64(m.memory_size)]], ["device_type", "memory"],
    ]));
    // (extended RAM, P8.5: a second range from 4 GiB; the reference has one)
    if(m.extended)
    {
        children.push(node("memory@" + m.extended.base.toString(16), [
            ["reg", [...u64(m.extended.base), ...u64(m.extended.size)]], ["device_type", "memory"],
        ]));
    }
    for(let n = 0; n < VIRT_MMIO_COUNT; n++)
    {
        const base = VIRT_MMIO + n * VIRT_MMIO_SIZE;
        children.push(node("virtio_mmio@" + base.toString(16), [
            ["dma-coherent", true], ["interrupts", spi(16 + n, 1)], ["reg", [...u64(base), ...u64(VIRT_MMIO_SIZE)]],
            ["compatible", "virtio,mmio"],
        ]));
    }
    // (the PCIe host: pin p (1-4) of slot s is SPI 3 + (s + p - 1) % 4, level-triggered,
    // for the slots modulo 4; the windows: I/O, 32-bit memory, 64-bit memory)
    const interrupt_map = [];
    for(let slot = 0; slot < 4; slot++)
    {
        for(let pin = 1; pin <= 4; pin++)
        {
            interrupt_map.push(slot << 11, 0, 0, pin, gic, 0, 0, ...spi(3 + (slot + pin - 1) % 4, 4));
        }
    }
    const high = ([low, high_half]) => high_half * 0x100000000 + low;
    if(!m.arm32) children.push(node("pcie@" + VIRT_PCIE_MMIO.toString(16), [
        ["interrupt-map-mask", [0x1800, 0, 0, 7]], ["interrupt-map", interrupt_map], ["#interrupt-cells", [1]],
        ["ranges", [
            0x1000000, 0, 0, ...u64(VIRT_PCIE_PIO), ...u64(VIRT_PCIE_PIO_SIZE),
            0x2000000, ...u64(VIRT_PCIE_MMIO), ...u64(VIRT_PCIE_MMIO), ...u64(VIRT_PCIE_MMIO_SIZE),
            0x3000000, ...u64(high(VIRT_PCIE_MMIO_HIGH)), ...u64(high(VIRT_PCIE_MMIO_HIGH)), ...u64(VIRT_PCIE_MMIO_HIGH_SIZE),
        ]],
        ["reg", [...u64(high(VIRT_PCIE_ECAM_HIGH)), ...u64(VIRT_PCIE_ECAM_SIZE)]], ["dma-coherent", true],
        ["bus-range", [0, 0xFF]], ["linux,pci-domain", [0]], ["#size-cells", [2]], ["#address-cells", [3]],
        ["device_type", "pci"], ["compatible", "pci-host-ecam-generic"],
    ]));
    children.push(node("pl031@" + VIRT_RTC.toString(16), [
        ["clock-names", "apb_pclk"], ["clocks", [clock]], ["interrupts", spi(2, 4)], ["reg", [...u64(VIRT_RTC), ...u64(0x1000)]],
        ["compatible", ["arm,pl031", "arm,primecell"]],
    ]));
    children.push(node("pl011@" + VIRT_UART.toString(16), [
        ["clock-names", ["uartclk", "apb_pclk"]], ["clocks", [clock, clock]], ["interrupts", spi(1, 4)],
        ["reg", [...u64(VIRT_UART), ...u64(0x1000)]], ["compatible", ["arm,pl011", "arm,primecell"]],
    ]));
    children.push(node("intc@" + VIRT_GIC_DIST.toString(16), [
        ["phandle", [gic]],
        ["reg", [...u64(VIRT_GIC_DIST), ...u64(VIRT_GIC_DIST_SIZE), ...u64(VIRT_GIC_REDIST), ...u64(GIC_REDIST_REGION_SIZE)]],
        ["#redistributor-regions", [1]], ["compatible", "arm,gic-v3"], ["ranges", true], ["#size-cells", [2]],
        ["#address-cells", [2]], ["interrupt-controller", true], ["#interrupt-cells", [3]],
    ]));
    const cores = [], map = [];
    for(let i = 0; i < m.cores; i++)
    {
        map.push(node("core" + i, [["cpu", [cpu_phandle(i)]]]));
        // (enable-method only with secondary cores to start, as the reference writes it)
        cores.push(node("cpu@" + i, [
            ["phandle", [cpu_phandle(i)]], ["reg", [i]], ...(m.cores > 1 ? [["enable-method", "psci"]] : []),
            ["compatible", m.arm32 ? "arm,cortex-a15" : "arm,armv8"], ["device_type", "cpu"],
        ]));
    }
    children.push(node("cpus", [["#size-cells", [0]], ["#address-cells", [1]]], [
        node("cpu-map", [], [node("socket0", [], [node("cluster0", [], map)])]),
        ...cores,
    ]));
    // (the timers' PPIs in Linux's order: secure physical 29, non-secure physical 30, virtual 27, hypervisor 26)
    children.push(node("timer", [
        ["interrupts", [1, 13, 4, 1, 14, 4, 1, 11, 4, 1, 10, 4]], ["always-on", true],
        ["compatible", ["arm,armv8-timer", "arm,armv7-timer"]],
    ]));
    children.push(node("apb-pclk", [
        ["phandle", [clock]], ["clock-output-names", "clk24mhz"], ["clock-frequency", [APB_PCLK_HZ]], ["#clock-cells", [0]],
        ["compatible", "fixed-clock"],
    ]));
    children.push(node("aliases", [["serial0", "/pl011@" + VIRT_UART.toString(16)]]));
    const chosen = [["stdout-path", "/pl011@" + VIRT_UART.toString(16)]];
    if(m.bootargs !== undefined) chosen.push(["bootargs", m.bootargs]);
    if(m.initrd)
    {
        chosen.push(["linux,initrd-end", u64(m.initrd.end)], ["linux,initrd-start", u64(m.initrd.start)]);
    }
    if(m.rng_seed) chosen.push(["rng-seed", m.rng_seed]);
    children.push(node("chosen", chosen));
    return node("", [
        ["interrupt-parent", [gic]], ["dma-coherent", true], ["model", "linux,dummy-virt"], ["#size-cells", [2]],
        ["#address-cells", [2]], ["compatible", "linux,dummy-virt"],
    ], children);
}
