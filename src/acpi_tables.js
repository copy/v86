// ACPI tables of the v86 platform, installed by SeaBIOS through the fw_cfg
// files etc/table-loader, etc/acpi/tables and etc/acpi/rsdp (the QEMU
// "linker/loader" interface, SeaBIOS src/fw/romfile_loader.h).
//
// Everything here is derived from src/platform.js and describes hardware that
// v86 implements. AML encoding: ACPI 6.6, chapter 20
// https://uefi.org/specs/ACPI/6.6/20_AML_Specification.html
// Table layouts: ACPI 6.6, chapter 5; the FADT is revision 3 (ACPI 2.0) and
// the DSDT uses 32-bit integers (revision 1), which Windows 2000/XP accept.

import { dbg_assert } from "./log.js";
import {
    ACPI_SCI_IRQ, ACPI_SMI_CMD_PORT, FW_CFG_PORT, ICH9_RCBA_ADDRESS, ICH9_RCBA_SIZE,
    IOAPIC_ADDRESS, IOAPIC_ID, LAPIC_ADDRESS, PCI_LINK_IRQS, RESET_PORT, RESET_VALUE,
    gpe0_block, pci_memory_windows,
} from "./platform.js";
import { CMOS_CENTURY } from "./rtc.js";
import { HPET_ADDRESS, HPET_BLOCK_ID, HPET_SIZE } from "./hpet.js";

// For Types Only
import { Platform } from "./platform.js";

const OEM_ID = "V86   ";
const CREATOR_ID = "V86 ";

export const ACPI_TABLES_FILE = "etc/acpi/tables";
export const ACPI_RSDP_FILE = "etc/acpi/rsdp";
export const ACPI_LOADER_FILE = "etc/table-loader";

// ---------------------------------------------------------------------------
// AML encoding. Every helper returns an array of bytes.

const ZERO_OP = 0x00;
const ONE_OP = 0x01;
const NAME_OP = 0x08;
const BYTE_PREFIX = 0x0A;
const WORD_PREFIX = 0x0B;
const DWORD_PREFIX = 0x0C;
const SCOPE_OP = 0x10;
const BUFFER_OP = 0x11;
const PACKAGE_OP = 0x12;
const METHOD_OP = 0x14;
const DUAL_NAME_PREFIX = 0x2E;
const MULTI_NAME_PREFIX = 0x2F;
const EXT_OP = 0x5B;
const OP_REGION_OP = 0x80;
const FIELD_OP = 0x81;
const DEVICE_OP = 0x82;
const PROCESSOR_OP = 0x83;
const LOCAL0_OP = 0x60;
const ARG0_OP = 0x68;
const STORE_OP = 0x70;
const AND_OP = 0x7B;
const OR_OP = 0x7D;
const CREATE_DWORD_FIELD_OP = 0x8A;
const LNOT_OP = 0x92;
const LEQUAL_OP = 0x93;
const LLESS_OP = 0x95;
const IF_OP = 0xA0;
const ELSE_OP = 0xA1;
const RETURN_OP = 0xA4;
const NOOP_OP = 0xA3;

const REGION_SYSTEM_IO = 0x01;
const REGION_PCI_CONFIG = 0x02;

/**
 * A length as encoded in PkgLength and in field lists (not including itself)
 * @param {number} value
 * @return {!Array<number>}
 */
function aml_length(value)
{
    if(value < 0x40)
    {
        return [value];
    }
    const follow = value < 1 << 12 ? 1 : value < 1 << 20 ? 2 : 3;
    dbg_assert(value < 1 << 28);
    const bytes = [follow << 6 | value & 0xF];
    for(let i = 0; i < follow; i++)
    {
        bytes.push(value >>> (4 + 8 * i) & 0xFF);
    }
    return bytes;
}

/**
 * PkgLength followed by the contents; PkgLength counts its own bytes
 * @param {!Array<number>} contents
 * @return {!Array<number>}
 */
function with_pkg_length(contents)
{
    for(let size = 1; size <= 4; size++)
    {
        const encoded = aml_length(contents.length + size);
        if(encoded.length === size)
        {
            return encoded.concat(contents);
        }
    }
    throw new Error("AML package too large");
}

/** @param {!Array<!Array<number>>} terms */
const flat = terms => [].concat(...terms);

/**
 * @param {string} seg
 * @return {!Array<number>}
 */
function name_seg(seg)
{
    dbg_assert(seg.length >= 1 && seg.length <= 4 && /^[A-Z_][A-Z0-9_]*$/.test(seg), "bad name segment " + seg);
    seg = seg.padEnd(4, "_");
    return Array.from(seg, c => c.charCodeAt(0));
}

/**
 * NameString: "\\_SB.PCI0", "^PRQ0", "_HID"
 * @param {string} path
 * @return {!Array<number>}
 */
function aml_name(path)
{
    const prefix = [];
    while(path[0] === "\\" || path[0] === "^")
    {
        prefix.push(path.charCodeAt(0));
        path = path.slice(1);
    }
    const segments = path === "" ? [] : path.split(".");
    let body;
    if(segments.length === 0)
    {
        body = [0x00];
    }
    else if(segments.length === 1)
    {
        body = name_seg(segments[0]);
    }
    else if(segments.length === 2)
    {
        body = [DUAL_NAME_PREFIX].concat(name_seg(segments[0]), name_seg(segments[1]));
    }
    else
    {
        body = [MULTI_NAME_PREFIX, segments.length].concat(flat(segments.map(name_seg)));
    }
    return prefix.concat(body);
}

/**
 * @param {number} value unsigned, at most 32 bits (DSDT revision 1)
 * @return {!Array<number>}
 */
function aml_int(value)
{
    dbg_assert(value >= 0 && value <= 0xFFFFFFFF && Number.isInteger(value));
    if(value === 0) return [ZERO_OP];
    if(value === 1) return [ONE_OP];
    if(value <= 0xFF) return [BYTE_PREFIX, value];
    if(value <= 0xFFFF) return [WORD_PREFIX, value & 0xFF, value >> 8];
    return [DWORD_PREFIX].concat(le(value, 4));
}

/**
 * Compressed EISA id, e.g. "PNP0A03"
 * @param {string} id
 * @return {!Array<number>}
 */
function aml_eisa_id(id)
{
    dbg_assert(/^[A-Z]{3}[0-9A-F]{4}$/.test(id));
    const c = i => id.charCodeAt(i) - 0x40;
    const product = parseInt(id.slice(3), 16);
    const bytes = [c(0) << 2 | c(1) >> 3, (c(1) & 7) << 5 | c(2), product >> 8, product & 0xFF];
    return aml_int((bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0);
}

const aml_arg = n => [ARG0_OP + n];
const aml_local = n => [LOCAL0_OP + n];
const aml_name_decl = (path, value) => [NAME_OP].concat(aml_name(path), value);
const aml_scope = (path, ...terms) => [SCOPE_OP].concat(with_pkg_length(aml_name(path).concat(flat(terms))));
const aml_device = (path, ...terms) => [EXT_OP, DEVICE_OP].concat(with_pkg_length(aml_name(path).concat(flat(terms))));
const aml_package = (...elements) => [PACKAGE_OP].concat(with_pkg_length([elements.length].concat(flat(elements))));
const aml_buffer = bytes => [BUFFER_OP].concat(with_pkg_length(aml_int(bytes.length).concat(bytes)));
const aml_return = value => [RETURN_OP].concat(value);
const aml_store = (source, target) => [STORE_OP].concat(source, target);
const aml_and = (a, b, target = [0]) => [AND_OP].concat(a, b, target);
const aml_or = (a, b, target = [0]) => [OR_OP].concat(a, b, target);
const aml_lless = (a, b) => [LLESS_OP].concat(a, b);
const aml_lequal = (a, b) => [LEQUAL_OP].concat(a, b);
const aml_lnot = a => [LNOT_OP].concat(a);
const aml_if = (predicate, ...terms) => [IF_OP].concat(with_pkg_length(predicate.concat(flat(terms))));
/** (right after the aml_if it belongs to) */
const aml_else = (...terms) => [ELSE_OP].concat(with_pkg_length(flat(terms)));
const aml_create_dword_field = (buffer, index, name) => [CREATE_DWORD_FIELD_OP].concat(buffer, aml_int(index), aml_name(name));

/**
 * @param {string} path
 * @param {number} arg_count
 * @param {boolean} serialized
 * @param {...!Array<number>} terms
 */
function aml_method(path, arg_count, serialized, ...terms)
{
    return [METHOD_OP].concat(with_pkg_length(aml_name(path).concat([arg_count | (serialized ? 8 : 0)], flat(terms))));
}

/**
 * Processor object. Deprecated since ACPI 6.0 in favour of Device(ACPI0007),
 * which Windows 2000/XP don't understand; every OS in the target list
 * accepts Processor().
 * @param {string} path
 * @param {number} id
 * @param {...!Array<number>} terms
 */
function aml_processor(path, id, ...terms)
{
    // no P_BLK: C2/C3 are not supported
    return [EXT_OP, PROCESSOR_OP].concat(with_pkg_length(aml_name(path).concat([id], le(0, 4), [0], flat(terms))));
}

const aml_op_region = (path, space, offset, length) =>
    [EXT_OP, OP_REGION_OP].concat(aml_name(path), [space], aml_int(offset), aml_int(length));

/**
 * @param {string} region
 * @param {number} flags access type | lock rule | update rule
 * @param {!Array<{name: (string|undefined), bits: number}>} fields unnamed entries are reserved space
 */
function aml_field(region, flags, fields)
{
    const list = flat(fields.map(({ name, bits }) => (name ? name_seg(name) : [0x00]).concat(aml_length(bits))));
    return [EXT_OP, FIELD_OP].concat(with_pkg_length(aml_name(region).concat([flags], list)));
}

const FIELD_BYTE_ACC = 0x01;
const FIELD_PRESERVE = 0x00;

// Resource descriptors (ACPI 6.6, section 6.4)

/** Fixed 16-bit decoded I/O range */
const res_io = (base, length) => [0x47, 0x01, base & 0xFF, base >> 8, base & 0xFF, base >> 8, 0x01, length];
/** @param {!Array<number>} irqs */
const res_irq_noflags = irqs => { const mask = irqs.reduce((m, irq) => m | 1 << irq, 0); return [0x22, mask & 0xFF, mask >> 8]; };
/** 8-bit ISA compatibility DMA, not a bus master */
const res_dma = channels => [0x2A, channels.reduce((m, c) => m | 1 << c, 0), 0x00];
/**
 * Level-triggered, active-high, shared interrupt consumer; the first IRQ is at byte 5
 * @param {!Array<number>} irqs
 */
const res_interrupt_shared_level = irqs => [0x89].concat(le(2 + 4 * irqs.length, 2), [0x09, irqs.length], flat(irqs.map(irq => le(irq, 4))));

/** Word address space producer with fixed min/max; type 1 = I/O, 2 = bus numbers */
function res_word_space(type, type_flags, min, max)
{
    return [0x88, 13, 0, type, 0x0C, type_flags].concat(le(0, 2), le(min, 2), le(max, 2), le(0, 2), le(max - min + 1, 2));
}
const res_word_bus = (min, max) => res_word_space(2, 0, min, max);
const res_word_io = (min, max) => res_word_space(1, 0x03, min, max);
/** 32-bit fixed memory range, read/write (reserved by a motherboard device) */
const res_memory32_fixed = (base, length) => [0x86, 9, 0, 1].concat(le(base, 4), le(length, 4));
/** Cacheable read/write memory window */
const res_dword_memory = (min, max) =>
    [0x87, 23, 0, 0, 0x0C, 0x03].concat(le(0, 4), le(min, 4), le(max, 4), le(0, 4), le(max - min + 1 >>> 0, 4));

/** @param {...!Array<number>} descriptors */
const aml_resources = (...descriptors) => aml_buffer(flat(descriptors).concat([0x79, 0x00]));

/**
 * @param {number} value
 * @param {number} size
 * @return {!Array<number>}
 */
function le(value, size)
{
    const bytes = [];
    for(let i = 0; i < size; i++)
    {
        // Numbers up to 2**53 (8-byte fields hold at most 32-bit values here)
        bytes.push(i < 4 ? value >>> (8 * i) & 0xFF : Math.floor(value / 2 ** (8 * i)) & 0xFF);
    }
    return bytes;
}

// ---------------------------------------------------------------------------
// DSDT

/**
 * @param {string} name
 * @param {string} hid
 * @param {!Array<number>} resources
 * @param {number=} uid
 * @return {!Array<number>}
 */
const isa_device = (name, hid, resources, uid) => aml_device(name,
    aml_name_decl("_HID", aml_eisa_id(hid)),
    uid === undefined ? [] : aml_name_decl("_UID", aml_int(uid)),
    aml_name_decl("_CRS", resources));

/**
 * The devices behind the ISA (PIIX3) or LPC (ICH9) bridge
 * @param {Platform} platform
 * @return {!Array<!Array<number>>}
 */
function isa_devices_of(platform)
{
    const isa_devices = [
        isa_device("RTC", "PNP0B00", aml_resources(res_io(0x70, 2), res_irq_noflags([8]))),
        // SeaBIOS looks for PNP0303 to enable its PS/2 support
        isa_device("KBD", "PNP0303", aml_resources(res_io(0x60, 1), res_io(0x64, 1), res_irq_noflags([1]))),
        isa_device("MOU", "PNP0F13", aml_resources(res_irq_noflags([12]))),
        isa_device("FDC0", "PNP0700", aml_resources(res_io(0x3F2, 4), res_io(0x3F7, 1), res_irq_noflags([6]), res_dma([2]))),
        // (QEMU's PC does not describe these: with platform.qemu_compatible
        // a guest installed there sees no new devices)
        ...platform.qemu_compatible ? [] : [
            isa_device("PIC", "PNP0000", aml_resources(res_io(0x20, 2), res_io(0xA0, 2), res_io(0x4D0, 2), res_irq_noflags([2]))),
            isa_device("TMR", "PNP0100", aml_resources(res_io(0x40, 4), res_irq_noflags([0]))),
            isa_device("DMAC", "PNP0200", aml_resources(res_io(0x00, 0x10), res_io(0x80, 0x10), res_io(0xC0, 0x20), res_dma([4]))),
            isa_device("SPKR", "PNP0800", aml_resources(res_io(0x61, 1))),
            isa_device("FPU", "PNP0C04", aml_resources(res_io(0xF0, 0x10), res_irq_noflags([13]))),
        ],
    ];
    for(const { index, port, irq } of platform.uarts)
    {
        isa_devices.push(isa_device("COM" + (index + 1), "PNP0501", aml_resources(res_io(port, 8), res_irq_noflags([irq])), index + 1));
    }
    for(const { index, port, irq } of platform.parallel_ports)
    {
        isa_devices.push(isa_device(index === 0 ? "LPT" : "LPT" + (index + 1), "PNP0400", aml_resources(res_io(port, 8), res_irq_noflags([irq])), index + 1));
    }
    return isa_devices;
}

/**
 * \_Sx packages of the sleep states the machine advertises
 * @param {Platform} platform
 * @return {!Array<!Array<number>>}
 */
function sleep_state_packages(platform)
{
    return platform.sleep_states.filter(s => s.supported).map(({ state, slp_typ }) =>
        aml_name_decl("\\_S" + state, aml_package(aml_int(slp_typ), aml_int(slp_typ), aml_int(0), aml_int(0))));
}

/**
 * @param {Platform} platform
 * @param {number} pm_base
 * @return {!Array<number>} the DSDT body (after the table header)
 */
function build_dsdt_body(platform, pm_base)
{
    if(platform.machine === "q35")
    {
        return build_q35_dsdt_body(platform, pm_base);
    }

    const LINKS = ["LNKA", "LNKB", "LNKC", "LNKD"];
    const PIRQ_FIELDS = ["PRQ0", "PRQ1", "PRQ2", "PRQ3"];

    // Interrupt pin p (0 = INTA) of slot s reaches PIRQ (s + p - 1) & 3; the same
    // swizzle as PCI.prototype.get_irq_line
    const prt = [];
    for(let slot = 0; slot < 32; slot++)
    {
        for(let pin = 0; pin < 4; pin++)
        {
            prt.push(aml_package(aml_int((slot << 16 | 0xFFFF) >>> 0), aml_int(pin), aml_name(LINKS[slot + pin - 1 & 3]), aml_int(0)));
        }
    }

    const links = LINKS.map((link, i) => aml_device(link,
        aml_name_decl("_HID", aml_eisa_id("PNP0C0F")),
        aml_name_decl("_UID", aml_int(i)),
        aml_name_decl("_PRS", aml_resources(res_interrupt_shared_level(PCI_LINK_IRQS))),
        // IQST and IQCR are defined before the links: a method call can only be
        // parsed once the method (and its argument count) is known
        aml_method("_STA", 0, false, aml_return(aml_name("IQST").concat(aml_name(PIRQ_FIELDS[i])))),
        aml_method("_DIS", 0, false, aml_or(aml_name(PIRQ_FIELDS[i]), aml_int(0x80), aml_name(PIRQ_FIELDS[i]))),
        aml_method("_CRS", 0, false, aml_return(aml_name("IQCR").concat(aml_name(PIRQ_FIELDS[i])))),
        aml_method("_SRS", 1, false,
            aml_create_dword_field(aml_arg(0), 5, "PRRI"),
            aml_store(aml_name("PRRI"), aml_name(PIRQ_FIELDS[i])))));

    const isa_devices = isa_devices_of(platform);
    const gpe0 = gpe0_block(platform, pm_base);

    // Ports that belong to the chipset but no device above: ACPI PM and GPE
    // blocks, SMI_CMD/APM, fw_cfg, port 0x92 and the PIIX reset register
    const motherboard = aml_device("MBRS",
        aml_name_decl("_HID", aml_eisa_id("PNP0C02")),
        aml_name_decl("_UID", aml_int(1)),
        aml_name_decl("_CRS", aml_resources(
            res_io(pm_base, platform.pm.length),
            res_io(gpe0.base, gpe0.length),
            res_io(ACPI_SMI_CMD_PORT, 2),
            res_io(FW_CFG_PORT, 2),
            res_io(0x92, 1))));

    const pci_crs = aml_resources(
        res_word_bus(0x00, 0xFF),
        res_io(0xCF8, 8),
        res_word_io(0x0000, 0x0CF7),
        res_word_io(0x0D00, 0xFFFF),
        res_dword_memory(0xA0000, 0xBFFFF),
        ...pci_memory_windows(platform).map(([first, last]) => res_dword_memory(first, last)));

    const sleep_states = sleep_state_packages(platform);

    // ProcID i matches the ACPI processor id of the i-th MADT entry
    const processors = platform.apic_ids.map((_, i) => aml_processor("CP" + i.toString(16).toUpperCase().padStart(2, "0"), i));

    return flat([
        aml_scope("\\_SB",
            // a device has either _HID or _ADR; the root bridge is identified by _HID
            aml_device("PCI0",
                aml_name_decl("_HID", aml_eisa_id("PNP0A03")),
                // (QEMU's PC: 0; the instance ids of all devices below derive from it)
                aml_name_decl("_UID", aml_int(platform.qemu_compatible ? 0 : 1)),
                aml_name_decl("_CRS", pci_crs),
                aml_name_decl("_PRT", aml_package(...prt)),
                aml_device("ISA",
                    aml_name_decl("_ADR", aml_int(0x00010000)),
                    // PIIX PIRQ route control registers
                    aml_op_region("P40C", REGION_PCI_CONFIG, 0x60, 4),
                    ...isa_devices,
                    motherboard)),
            aml_field("PCI0.ISA.P40C", FIELD_BYTE_ACC | FIELD_PRESERVE, PIRQ_FIELDS.map(name => ({ name, bits: 8 }))),
            // _STA of a link: disabled (bit 7 set) or enabled
            aml_method("IQST", 1, false,
                aml_if(aml_and(aml_int(0x80), aml_arg(0)), aml_return(aml_int(0x09))),
                aml_return(aml_int(0x0B))),
            // _CRS of a link: its current IRQ, or none
            aml_method("IQCR", 1, true,
                aml_name_decl("PRR0", aml_resources(res_interrupt_shared_level([0]))),
                aml_create_dword_field(aml_name("PRR0"), 5, "PRRI"),
                aml_if(aml_lless(aml_arg(0), aml_int(0x80)), aml_store(aml_arg(0), aml_name("PRRI"))),
                aml_return(aml_name("PRR0"))),
            ...links,
            ...processors),
        ...sleep_states,
    ]);
}

/**
 * Q35: the PCI Express root bridge with the devices of the ICH9 LPC bridge,
 * the eight PIRQ links in PIC mode and their GSIs 16-23 in APIC mode (the
 * wiring of src/q35.js, which is QEMU's)
 * @param {Platform} platform
 * @param {number} pm_base
 * @return {!Array<number>} the DSDT body (after the table header)
 */
function build_q35_dsdt_body(platform, pm_base)
{
    const PIRQS = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const PIRQ_FIELDS = PIRQS.map(p => "PRQ" + p);

    // PIRQ of interrupt pin p (0 = INTA) of device d on bus 0; the defaults of
    // the device 25-31 route registers (INTA..D -> PIRQA..D)
    const pirq_of = (d, p) => d <= 24 ? 4 + (d + p) % 4 : d === 30 ? 4 + p : p;
    const routing_table = prefix => {
        const entries = [];
        for(let d = 0; d < 32; d++)
        {
            for(let p = 0; p < 4; p++)
            {
                entries.push(aml_package(aml_int((d << 16 | 0xFFFF) >>> 0), aml_int(p), aml_name(prefix + PIRQS[pirq_of(d, p)]), aml_int(0)));
            }
        }
        return aml_package(...entries);
    };

    // PIC mode: link devices over the LPC's PIRQ route registers
    const links = PIRQS.map((pirq, i) => aml_device("LNK" + pirq,
        aml_name_decl("_HID", aml_eisa_id("PNP0C0F")),
        aml_name_decl("_UID", aml_int(i)),
        aml_name_decl("_PRS", aml_resources(res_interrupt_shared_level(PCI_LINK_IRQS))),
        aml_method("_STA", 0, false, aml_return(aml_name("IQST").concat(aml_name(PIRQ_FIELDS[i])))),
        aml_method("_DIS", 0, false, aml_or(aml_name(PIRQ_FIELDS[i]), aml_int(0x80), aml_name(PIRQ_FIELDS[i]))),
        aml_method("_CRS", 0, false, aml_return(aml_name("IQCR").concat(aml_name(PIRQ_FIELDS[i])))),
        aml_method("_SRS", 1, false,
            aml_create_dword_field(aml_arg(0), 5, "PRRI"),
            aml_store(aml_name("PRRI"), aml_name(PIRQ_FIELDS[i])))));

    // APIC mode: PIRQx is IOAPIC input 16 + x, always connected
    const gsi_links = PIRQS.map((pirq, i) => {
        const resources = aml_resources(res_interrupt_shared_level([16 + i]));
        return aml_device("GSI" + pirq,
            aml_name_decl("_HID", aml_eisa_id("PNP0C0F")),
            aml_name_decl("_UID", aml_int(8 + i)),
            aml_name_decl("_PRS", resources),
            aml_name_decl("_CRS", resources),
            aml_method("_STA", 0, false, aml_return(aml_int(0x0B))),
            aml_method("_DIS", 0, false, [NOOP_OP]),
            aml_method("_SRS", 1, false, [NOOP_OP]));
    });

    // Chipset resources no device above claims: the PM block (GPE0 is part of
    // it), SMI_CMD/APM, fw_cfg, port 0x92, and the root complex register block
    const motherboard = aml_device("MBRS",
        aml_name_decl("_HID", aml_eisa_id("PNP0C02")),
        aml_name_decl("_UID", aml_int(1)),
        aml_name_decl("_CRS", aml_resources(
            res_io(pm_base, platform.pm.length),
            res_io(ACPI_SMI_CMD_PORT, 2),
            res_io(FW_CFG_PORT, 2),
            res_io(0x92, 1),
            res_memory32_fixed(ICH9_RCBA_ADDRESS, ICH9_RCBA_SIZE))));

    const pci_crs = aml_resources(
        res_word_bus(0x00, platform.ecam.size / 0x100000 - 1),
        res_io(0xCF8, 8),
        res_word_io(0x0000, 0x0CF7),
        res_word_io(0x0D00, 0xFFFF),
        res_dword_memory(0xA0000, 0xBFFFF),
        // (without the ECAM window: above it with SeaBIOS, around it with OVMF)
        ...pci_memory_windows(platform).map(([first, last]) => res_dword_memory(first, last)));

    const processors = platform.apic_ids.map((_, i) => aml_processor("CP" + i.toString(16).toUpperCase().padStart(2, "0"), i));

    return flat([
        // OSPM tells the interrupt model through \_PIC: 0 PIC, 1 APIC
        aml_name_decl("\\PICF", aml_int(0)),
        aml_method("\\_PIC", 1, false, aml_store(aml_arg(0), aml_name("\\PICF"))),
        aml_scope("\\_SB",
            aml_device("PCI0",
                aml_name_decl("_HID", aml_eisa_id("PNP0A08")),
                aml_name_decl("_CID", aml_eisa_id("PNP0A03")),
                // (a device has either _HID or _ADR; the root bridge is identified by _HID)
                aml_name_decl("_UID", aml_int(0)),
                aml_name_decl("_SEG", aml_int(0)),
                aml_name_decl("_BBN", aml_int(0)),
                aml_name_decl("_CRS", pci_crs),
                aml_name_decl("PRTP", routing_table("LNK")),
                aml_name_decl("PRTA", routing_table("GSI")),
                aml_method("_PRT", 0, false,
                    aml_if(aml_name("\\PICF"), aml_return(aml_name("PRTA"))),
                    aml_return(aml_name("PRTP"))),
                pci_host_bridge_osc(),
                aml_device("ISA",
                    aml_name_decl("_ADR", aml_int(0x001F0000)),
                    // ICH9 PIRQ route control registers (PIRQA..D, SIRQ_CNTL and reserved, PIRQE..H)
                    aml_op_region("PIRQ", REGION_PCI_CONFIG, 0x60, 0x0C),
                    ...isa_devices_of(platform),
                    ...platform.hpet ? [aml_device("HPET",
                        aml_name_decl("_HID", aml_eisa_id("PNP0103")),
                        aml_name_decl("_UID", aml_int(0)),
                        aml_name_decl("_CRS", aml_resources(res_memory32_fixed(HPET_ADDRESS, HPET_SIZE))))] : [],
                    motherboard)),
            aml_field("PCI0.ISA.PIRQ", FIELD_BYTE_ACC | FIELD_PRESERVE, [
                ...PIRQ_FIELDS.slice(0, 4).map(name => ({ name, bits: 8 })),
                { name: undefined, bits: 32 },
                ...PIRQ_FIELDS.slice(4).map(name => ({ name, bits: 8 })),
            ]),
            // _STA of a link: disabled (bit 7 set) or enabled
            aml_method("IQST", 1, false,
                aml_if(aml_and(aml_int(0x80), aml_arg(0)), aml_return(aml_int(0x09))),
                aml_return(aml_int(0x0B))),
            // _CRS of a link: its current IRQ, or none
            aml_method("IQCR", 1, true,
                aml_name_decl("PRR0", aml_resources(res_interrupt_shared_level([0]))),
                aml_create_dword_field(aml_name("PRR0"), 5, "PRRI"),
                aml_if(aml_lless(aml_arg(0), aml_int(0x80)), aml_store(aml_arg(0), aml_name("PRRI"))),
                aml_return(aml_name("PRR0"))),
            ...links,
            ...gsi_links,
            // the ECAM window, which the root bridge's _CRS leaves out (PCI
            // Firmware 3.3, 4.1.2: reserved by a motherboard resource; QEMU's DRAC)
            aml_device("DRAC",
                aml_name_decl("_HID", aml_eisa_id("PNP0C01")),
                aml_name_decl("_UID", aml_int(2)),
                aml_name_decl("_CRS", aml_resources(res_memory32_fixed(platform.ecam.base, platform.ecam.size)))),
            ...processors),
        ...sleep_state_packages(platform),
    ]);
}

// ---------------------------------------------------------------------------
// Tables

/**
 * @param {string} signature
 * @param {number} revision
 * @param {string} table_id
 * @param {!Array<number>} body
 * @return {!Uint8Array} table with length set and checksum 0
 */
function table(signature, revision, table_id, body)
{
    const length = 36 + body.length;
    const header = Array.from(signature, c => c.charCodeAt(0)).concat(
        le(length, 4), [revision, 0],
        Array.from(OEM_ID, c => c.charCodeAt(0)),
        Array.from(table_id.padEnd(8, " "), c => c.charCodeAt(0)),
        le(1, 4),
        Array.from(CREATOR_ID, c => c.charCodeAt(0)),
        le(1, 4));
    return Uint8Array.from(header.concat(body));
}

/** Generic address structure (12 bytes); space 1 = system I/O */
const gas_io = (address, bits) => [REGION_SYSTEM_IO, bits, 0, 0].concat(le(address, 8));
const GAS_NONE = new Array(12).fill(0);

function build_facs()
{
    const facs = new Uint8Array(64);
    facs.set([0x46, 0x41, 0x43, 0x53]); // "FACS"
    facs.set(le(64, 4), 4);
    facs[32] = 1; // version
    return facs;
}

// FADT field offsets (ACPI 6.6, table 5.9)
const FADT_FIRMWARE_CTRL = 36;
const FADT_DSDT = 40;
const FADT_X_FIRMWARE_CTRL = 132;
const FADT_X_DSDT = 140;
const FADT_LENGTH = 244;

// FADT flags
const WBINVD = 1 << 0;
const PROC_C1 = 1 << 2;
const SLP_BUTTON = 1 << 5; // no sleep button
const FIX_RTC = 1 << 6; // RTC wake status is not in the fixed registers
const RESET_REG_SUP = 1 << 10;
const USE_PLATFORM_CLOCK = 1 << 15;

// IAPC_BOOT_ARCH
const LEGACY_DEVICES = 1 << 0;
const HAS_8042 = 1 << 1;

/**
 * @param {Platform} platform
 * @param {number} pm_base
 */
function build_fadt(platform, pm_base)
{
    const gpe0 = gpe0_block(platform, pm_base);
    const body = [].concat(
        le(0, 4), // FIRMWARE_CTRL (patched by the loader)
        le(0, 4), // DSDT (patched by the loader)
        [0], // reserved (INT_MODEL in ACPI 1.0)
        [0], // Preferred_PM_Profile: unspecified
        le(ACPI_SCI_IRQ, 2),
        le(ACPI_SMI_CMD_PORT, 4),
        [platform.pm.acpi_enable, platform.pm.acpi_disable, 0, 0], // S4BIOS_REQ, PSTATE_CNT
        le(pm_base, 4), le(0, 4), // PM1a/b_EVT_BLK
        le(pm_base + 4, 4), le(0, 4), // PM1a/b_CNT_BLK
        le(0, 4), // PM2_CNT_BLK
        le(pm_base + 8, 4), // PM_TMR_BLK
        le(gpe0.base, 4), le(0, 4), // GPE0/1_BLK
        [4, 2, 0, 4, gpe0.length, 0, 0, 0], // lengths, GPE1_BASE, CST_CNT
        le(101, 2), // P_LVL2_LAT > 100: no C2
        le(1001, 2), // P_LVL3_LAT > 1000: no C3
        le(0, 4), // FLUSH_SIZE, FLUSH_STRIDE
        [0, 0], // DUTY_OFFSET, DUTY_WIDTH
        [0, 0, CMOS_CENTURY], // DAY_ALRM, MON_ALRM (not supported), CENTURY
        le(LEGACY_DEVICES | HAS_8042, 2),
        [0], // reserved
        le(WBINVD | PROC_C1 | SLP_BUTTON | FIX_RTC | RESET_REG_SUP | USE_PLATFORM_CLOCK, 4),
        gas_io(RESET_PORT, 8), [RESET_VALUE, 0, 0, 0],
        le(0, 8), // X_FIRMWARE_CTRL (patched)
        le(0, 8), // X_DSDT (patched)
        gas_io(pm_base, 32), GAS_NONE, // X_PM1a/b_EVT_BLK
        gas_io(pm_base + 4, 16), GAS_NONE, // X_PM1a/b_CNT_BLK
        GAS_NONE, // X_PM2_CNT_BLK
        gas_io(pm_base + 8, 32), // X_PM_TMR_BLK
        gas_io(gpe0.base, gpe0.length * 8), GAS_NONE); // X_GPE0/1_BLK

    const fadt = table("FACP", 3, "V86FACP", body);
    dbg_assert(fadt.length === FADT_LENGTH);
    return fadt;
}

/**
 * _OSC of the PCI Express host bridge (PCI Firmware Specification 3.0, 4.5),
 * as QEMU's Q35 has it with native hot plug: the OS gets the control it asks
 * for among native PCI Express hot plug (the root ports' slots,
 * pcie_root_port.js), SHPC hot plug, PME, AER and the PCI Express capability
 * structure; other control bits are masked (and reported so). An unknown
 * UUID or revision is reported in the first dword too.
 * @return {!Array<number>}
 */
function pci_host_bridge_osc()
{
    // ToUUID ("33db4d5b-1ff7-401c-9657-7441c03dd766"), the PCI host bridge
    const PCI_HOST_BRIDGE_UUID = [0x5B, 0x4D, 0xDB, 0x33, 0xF7, 0x1F, 0x1C, 0x40, 0x96, 0x57, 0x74, 0x41, 0xC0, 0x3D, 0xD7, 0x66];
    const OSC_UNRECOGNIZED_UUID = 0x04;
    const OSC_UNRECOGNIZED_REVISION = 0x08;
    const OSC_CAPABILITIES_MASKED = 0x10;
    const GRANTED = 0x1F;
    const cdw1 = aml_name("CDW1"), cdw3 = aml_name("CDW3"), local0 = aml_local(0);
    return aml_method("_OSC", 4, false,
        aml_create_dword_field(aml_arg(3), 0, "CDW1"),
        aml_if(aml_lequal(aml_arg(0), aml_buffer(PCI_HOST_BRIDGE_UUID)),
            aml_create_dword_field(aml_arg(3), 4, "CDW2"),
            aml_create_dword_field(aml_arg(3), 8, "CDW3"),
            aml_store(cdw3, local0),
            aml_and(local0, aml_int(GRANTED), local0),
            aml_if(aml_lnot(aml_lequal(aml_arg(1), aml_int(1))),
                aml_or(cdw1, aml_int(OSC_UNRECOGNIZED_REVISION), cdw1)),
            aml_if(aml_lnot(aml_lequal(cdw3, local0)),
                aml_or(cdw1, aml_int(OSC_CAPABILITIES_MASKED), cdw1)),
            aml_store(local0, cdw3)),
        aml_else(
            aml_or(cdw1, aml_int(OSC_UNRECOGNIZED_UUID), cdw1)),
        aml_return(aml_arg(3)));
}

/** @param {Platform} platform */
function build_madt(platform)
{
    const PCAT_COMPAT = 1;
    const LEVEL_ACTIVE_HIGH = 0x0D; // polarity active high (1), trigger level (3 << 2)

    const entries = [];
    platform.apic_ids.forEach((apic_id, i) => {
        entries.push([0, 8, i, apic_id].concat(le(1, 4))); // processor local APIC, enabled
    });
    entries.push([1, 12, IOAPIC_ID, 0].concat(le(IOAPIC_ADDRESS, 4), le(0, 4)));
    // The SCI and the PCI interrupt links are level-triggered, active high.
    // Other ISA IRQs keep the default (edge, active high, GSI = IRQ).
    for(const irq of [ACPI_SCI_IRQ].concat(PCI_LINK_IRQS))
    {
        entries.push([2, 10, 0, irq].concat(le(irq, 4), le(LEVEL_ACTIVE_HIGH, 2)));
    }
    entries.push([4, 6, 0xFF, 0, 0, 1]); // local APIC NMI on LINT1 of every processor

    return table("APIC", 1, "V86APIC", le(LAPIC_ADDRESS, 4).concat(le(PCAT_COMPAT, 4), flat(entries)));
}

/**
 * The HPET description table (IA-PC HPET 1.0a, 3.2.4): the event timer
 * block's ID, its address (system memory), HPET number 0, no minimum clock
 * tick, no page protection (QEMU's values)
 */
function build_hpet()
{
    return table("HPET", 1, "V86HPET", le(HPET_BLOCK_ID, 4).concat(
        [0, 0, 0, 0], le(HPET_ADDRESS, 8), [0], le(0, 2), [0]));
}

/**
 * PCI Express memory-mapped configuration space (PCI Firmware 3.3, 4.1.2):
 * one allocation, segment 0, buses 0 to the last one of the ECAM window
 * @param {Platform} platform
 */
function build_mcfg(platform)
{
    const ecam = platform.ecam;
    return table("MCFG", 1, "V86MCFG", le(0, 8).concat(
        le(ecam.base, 8), le(0, 2), [0, ecam.size / 0x100000 - 1], le(0, 4)));
}

// ---------------------------------------------------------------------------
// Linker/loader script (SeaBIOS src/fw/romfile_loader.h)

const LOADER_ENTRY_SIZE = 128;
const LOADER_FILE_NAME_SIZE = 56;
const COMMAND_ALLOCATE = 1;
const COMMAND_ADD_POINTER = 2;
const COMMAND_ADD_CHECKSUM = 3;
export const ZONE_HIGH = 1;
export const ZONE_FSEG = 2;

function loader_name(name)
{
    dbg_assert(name.length < LOADER_FILE_NAME_SIZE);
    const bytes = new Array(LOADER_FILE_NAME_SIZE).fill(0);
    for(let i = 0; i < name.length; i++) bytes[i] = name.charCodeAt(i);
    return bytes;
}

function loader_entry(bytes)
{
    const entry = new Array(LOADER_ENTRY_SIZE).fill(0);
    bytes.forEach((b, i) => entry[i] = b);
    return entry;
}

const loader_allocate = (file, align, zone) =>
    loader_entry(le(COMMAND_ALLOCATE, 4).concat(loader_name(file), le(align, 4), [zone]));
const loader_add_pointer = (dest_file, src_file, offset, size) =>
    loader_entry(le(COMMAND_ADD_POINTER, 4).concat(loader_name(dest_file), loader_name(src_file), le(offset, 4), [size]));
const loader_add_checksum = (file, offset, start, length) =>
    loader_entry(le(COMMAND_ADD_CHECKSUM, 4).concat(loader_name(file), le(offset, 4), le(start, 4), le(length, 4)));

/**
 * Build all tables. Pointers inside the files hold offsets into
 * etc/acpi/tables; the loader script turns them into addresses and fills in
 * the checksums.
 * @param {Platform} platform
 * @param {number} pm_base PM I/O base as programmed in PMBA
 * @return {{ tables: !Uint8Array, rsdp: !Uint8Array, loader: !Uint8Array,
 *            layout: !Object<string, {offset: number, length: number}> }}
 */
export function build_acpi_tables(platform, pm_base)
{
    const parts = [
        ["FACS", build_facs()],
        ["DSDT", table("DSDT", 1, "V86DSDT", build_dsdt_body(platform, pm_base))],
        ["FACP", build_fadt(platform, pm_base)],
        ["APIC", build_madt(platform)],
        ...platform.ecam ? [["MCFG", build_mcfg(platform)]] : [],
        ...platform.hpet ? [["HPET", build_hpet()]] : [],
    ];

    // RSDT and XSDT list every table except FACS and DSDT (the FADT points to those)
    const listed = parts.filter(([name]) => name !== "FACS" && name !== "DSDT").map(([name]) => name);

    const layout = {};
    let offset = 0;
    for(const [name, data] of parts)
    {
        layout[name] = { offset, length: data.length };
        offset += data.length;
    }
    const rsdt_offset = offset;
    const rsdt = table("RSDT", 1, "V86RSDT", flat(listed.map(name => le(layout[name].offset, 4))));
    layout["RSDT"] = { offset: rsdt_offset, length: rsdt.length };
    const xsdt_offset = rsdt_offset + rsdt.length;
    const xsdt = table("XSDT", 1, "V86XSDT", flat(listed.map(name => le(layout[name].offset, 8))));
    layout["XSDT"] = { offset: xsdt_offset, length: xsdt.length };
    parts.push(["RSDT", rsdt], ["XSDT", xsdt]);

    const tables = new Uint8Array(xsdt_offset + xsdt.length);
    for(const [name, data] of parts)
    {
        tables.set(data, layout[name].offset);
    }

    // FADT pointers to FACS and DSDT (32 and 64 bit)
    const fadt = layout["FACP"].offset;
    tables.set(le(layout["FACS"].offset, 4), fadt + FADT_FIRMWARE_CTRL);
    tables.set(le(layout["DSDT"].offset, 4), fadt + FADT_DSDT);
    tables.set(le(layout["FACS"].offset, 8), fadt + FADT_X_FIRMWARE_CTRL);
    tables.set(le(layout["DSDT"].offset, 8), fadt + FADT_X_DSDT);

    const rsdp = Uint8Array.from([].concat(
        Array.from("RSD PTR ", c => c.charCodeAt(0)), [0],
        Array.from(OEM_ID, c => c.charCodeAt(0)), [2],
        le(rsdt_offset, 4), le(36, 4), le(xsdt_offset, 8), [0, 0, 0, 0]));
    dbg_assert(rsdp.length === 36);

    const T = ACPI_TABLES_FILE;
    const commands = [
        loader_allocate(ACPI_RSDP_FILE, 16, ZONE_FSEG),
        // 64-byte alignment is required by the FACS at offset 0
        loader_allocate(T, 64, ZONE_HIGH),
        loader_add_pointer(T, T, fadt + FADT_FIRMWARE_CTRL, 4),
        loader_add_pointer(T, T, fadt + FADT_DSDT, 4),
        loader_add_pointer(T, T, fadt + FADT_X_FIRMWARE_CTRL, 8),
        loader_add_pointer(T, T, fadt + FADT_X_DSDT, 8),
        ...listed.map((_, i) => loader_add_pointer(T, T, rsdt_offset + 36 + 4 * i, 4)),
        ...listed.map((_, i) => loader_add_pointer(T, T, xsdt_offset + 36 + 8 * i, 8)),
        loader_add_pointer(ACPI_RSDP_FILE, T, 16, 4),
        loader_add_pointer(ACPI_RSDP_FILE, T, 24, 8),
        // Checksums last: they cover the patched pointers
        ...parts.filter(([name]) => name !== "FACS").map(([name]) =>
            loader_add_checksum(T, layout[name].offset + 9, layout[name].offset, layout[name].length)),
        loader_add_checksum(ACPI_RSDP_FILE, 8, 0, 20),
        loader_add_checksum(ACPI_RSDP_FILE, 32, 0, 36),
    ];

    return { tables, rsdp, loader: Uint8Array.from(flat(commands)), layout };
}

/**
 * Find the ACPI tables in guest memory the way an OS does (RSDP in the BIOS
 * area, then XSDT or RSDT), for diagnostics and tests
 * @param {!Uint8Array} mem8
 * @return {?{rsdp: number, revision: number, oem_id: string,
 *            tables: !Array<{signature: string, address: number, length: number, checksum_ok: boolean}>}}
 */
export function locate_acpi_tables(mem8)
{
    const u32 = a => (mem8[a] | mem8[a + 1] << 8 | mem8[a + 2] << 16 | mem8[a + 3] << 24) >>> 0;
    const text = (a, n) => String.fromCharCode(...mem8.subarray(a, a + n));
    const sum = (a, n) => mem8.subarray(a, a + n).reduce((x, y) => x + y, 0) & 0xFF;
    const in_ram = (a, n) => a + n <= mem8.length;

    let rsdp = -1;
    for(let a = 0xE0000; a < 0x100000; a += 16)
    {
        if(text(a, 8) === "RSD PTR " && sum(a, 20) === 0)
        {
            rsdp = a;
            break;
        }
    }
    if(rsdp === -1)
    {
        return null;
    }

    const revision = mem8[rsdp + 15];
    const table = address => {
        if(!in_ram(address, 36)) return { signature: "????", address, length: 0, checksum_ok: false };
        const length = u32(address + 4);
        const signature = text(address, 4);
        const checksum_ok = signature === "FACS" || in_ram(address, length) && sum(address, length) === 0;
        return { signature, address, length, checksum_ok };
    };

    // XSDT entries above 4 GiB can't be in v86's RAM; use the low half
    const use_xsdt = revision >= 2 && u32(rsdp + 28) === 0 && u32(rsdp + 24) !== 0;
    const root = table(use_xsdt ? u32(rsdp + 24) : u32(rsdp + 16));
    const entry_size = use_xsdt ? 8 : 4;
    const tables = [root];
    for(let p = root.address + 36; p + entry_size <= root.address + root.length && in_ram(p, entry_size); p += entry_size)
    {
        const t = table(u32(p));
        tables.push(t);
        if(t.signature === "FACP" && t.length >= 44)
        {
            tables.push(table(u32(t.address + 36)), table(u32(t.address + 40))); // FACS, DSDT
        }
    }

    return { rsdp, revision, oem_id: text(rsdp + 9, 6), tables };
}
