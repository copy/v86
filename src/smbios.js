// SMBIOS for the UEFI firmware (docs/uefi.md): QEMU's fw_cfg files
// etc/smbios/smbios-tables (the structures, the last of type 127) and
// etc/smbios/smbios-anchor (an SMBIOS 2.8 entry point whose table length is
// the structures'), which OVMF validates (DetectSmbiosVersionLib) and installs
// (SmbiosPlatformDxe), adding its own type 0. SeaBIOS builds its own tables.
//
// The structures are those QEMU's machines have: system (1), chassis (3),
// processor (4), memory array (16), memory devices (17, one per 16 GiB),
// mapped address ranges (19), boot information (32).

import { dbg_assert } from "./log.js";

// For Types Only
import { Platform } from "./platform.js";

const SMBIOS_MAJOR = 2;
const SMBIOS_MINOR = 8;
/** The largest memory device a type 17 describes */
const DIMM_MAX = 16 * 2 ** 30;

/**
 * A structure: its formatted part (type, length and handle first) and its
 * strings, which string fields number from 1 (0: no string)
 * @param {number} type
 * @param {number} handle
 * @param {!Array<number>} formatted the bytes after the header
 * @param {!Array<string>} strings
 * @return {!Array<number>}
 */
function structure(type, handle, formatted, strings)
{
    const bytes = [type, 4 + formatted.length, handle & 0xFF, handle >> 8, ...formatted];
    for(const text of strings)
    {
        dbg_assert(text.length > 0 && /^[\x20-\x7E]*$/.test(text));
        for(let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i));
        bytes.push(0);
    }
    // (the string set ends with a second NUL; without strings, two)
    bytes.push(0);
    if(!strings.length) bytes.push(0);
    return bytes;
}

/** @param {number} value @param {number} bytes */
function le(value, bytes)
{
    const result = [];
    for(let i = 0; i < bytes; i++)
    {
        result.push(Number(BigInt(value) >> BigInt(8 * i) & 0xFFn));
    }
    return result;
}

/**
 * The two files
 * @param {Platform} platform
 * @param {{low_memory: number, high_memory: number, cpuid: function(number, number):!Array<number>}} machine
 *     RAM below 4 GiB and from 4 GiB on, in bytes; CPUID of the boot core (EAX, EBX, ECX, EDX)
 * @return {{tables: !Uint8Array, anchor: !Uint8Array}}
 */
export function build_smbios(platform, machine)
{
    const q35 = platform.machine === "q35";
    const total = machine.low_memory + machine.high_memory;
    const structures = [];

    // type 1: system; no serial number or UUID (all zero: not present)
    structures.push(structure(1, 0x0100, [
        1, 2, 3, 0,             // manufacturer, product, version, serial number
        ...new Array(16).fill(0), // UUID
        0x06,                   // wake-up type: power switch
        0, 0,                   // SKU number, family
    ], ["v86", q35 ? "v86 PC (Q35 + ICH9)" : "v86 PC (i440FX + PIIX)", "1.0"]));

    // type 3: chassis
    structures.push(structure(3, 0x0300, [
        1, 0x01, 0, 0, 0,       // manufacturer, type (other), version, serial number, asset tag
        0x03, 0x03, 0x03, 0x02, // boot-up, power supply and thermal state (safe), security (unknown)
        ...le(0, 4),            // OEM-defined
        0, 0, 0, 0,             // height, power cords, contained elements, their record length
        0,                      // SKU number
    ], ["v86"]));

    // type 4: the processor (one socket)
    const [signature, , , features] = machine.cpuid(1, 0);
    const vendor = machine.cpuid(0, 0);
    const vendor_name = String.fromCharCode(...[vendor[1], vendor[3], vendor[2]].flatMap(word => le(word, 4)));
    const long_mode = (machine.cpuid(0x80000000, 0)[0] >>> 0) >= 0x80000001 && (machine.cpuid(0x80000001, 0)[3] >>> 29 & 1) === 1;
    const cores = platform.topology.cores_per_socket;
    const threads = platform.topology.logical_processors;
    structures.push(structure(4, 0x0400, [
        1, 0x03, 0x01, 2,       // socket designation, type (central), family (other), manufacturer
        ...le(signature, 4), ...le(features, 4), // processor ID: CPUID 1's EAX and EDX
        3, 0,                   // version, voltage
        ...le(0, 2),            // external clock (unknown)
        ...le(2000, 2), ...le(2000, 2), // maximum and current speed in MHz
        0x41,                   // status: socket populated, enabled
        0x01,                   // upgrade: other
        ...le(0xFFFF, 2), ...le(0xFFFF, 2), ...le(0xFFFF, 2), // no L1, L2, L3 cache information
        0, 0, 0,                // serial number, asset tag, part number
        Math.min(cores, 0xFF), Math.min(cores, 0xFF), Math.min(threads, 0xFF),
        ...le(long_mode ? 0x0004 : 0x0002, 2), // characteristics: 64-bit capable, or unknown
        ...le(0x0001, 2),       // family 2: other
    ], ["CPU 0", vendor_name, "v86"]));

    // type 16: the memory array; type 17: its devices
    const dimms = Math.max(1, Math.ceil(total / DIMM_MAX));
    const total_kib = Math.ceil(total / 1024);
    structures.push(structure(16, 0x1000, [
        0x01, 0x03, 0x06,       // location (other), use (system memory), error correction (multi-bit ECC, as QEMU)
        ...le(total_kib < 0x80000000 ? total_kib : 0x80000000, 4), // maximum capacity in KiB, or see below
        ...le(0xFFFE, 2),       // no memory error information
        ...le(dimms, 2),
        ...le(total_kib < 0x80000000 ? 0 : total, 8), // extended maximum capacity in bytes
    ], []));
    for(let i = 0; i < dimms; i++)
    {
        // (in whole MiB: a 2048 MB x86_64 machine has 2 GiB less 128 KiB of heap RAM)
        const size_mib = Math.ceil(Math.min(DIMM_MAX, total - i * DIMM_MAX) / 2 ** 20);
        structures.push(structure(17, 0x1100 + i, [
            ...le(0x1000, 2),   // the memory array
            ...le(0xFFFE, 2),   // no memory error information
            ...le(64, 2), ...le(64, 2), // total and data width
            ...le(size_mib < 0x7FFF ? size_mib : 0x7FFF, 2), // size in MiB, or see the extended size
            0x09, 0,            // form factor (DIMM), device set
            1, 0,               // device locator, bank locator
            0x07,               // type: RAM
            ...le(0x0002, 2),   // type detail: other
            ...le(0, 2),        // speed (unknown)
            2, 0, 0, 0,         // manufacturer, serial number, asset tag, part number
            0,                  // attributes
            ...le(size_mib < 0x7FFF ? 0 : size_mib, 4), // extended size in MiB
            ...le(0, 2),        // configured speed (unknown)
            ...le(0, 2), ...le(0, 2), ...le(0, 2), // minimum, maximum, configured voltage (unknown)
        ], ["DIMM " + i, "v86"]));
    }

    // type 19: the address ranges of RAM
    const ranges = [[0, machine.low_memory]];
    if(machine.high_memory) ranges.push([2 ** 32, machine.high_memory]);
    ranges.forEach(([start, length], i) => {
        const end = start + length - 1;
        const fits = end / 1024 < 0xFFFFFFFF;
        structures.push(structure(19, 0x1300 + i, [
            ...le(fits ? start / 1024 : 0xFFFFFFFF, 4), // starting address in KiB, or see the extended one
            ...le(fits ? Math.floor(end / 1024) : 0xFFFFFFFF, 4), // ending address in KiB
            ...le(0x1000, 2),   // the memory array
            dimms,              // partition width
            ...le(fits ? 0 : start, 8), ...le(fits ? 0 : end, 8), // extended starting and ending address
        ], []));
    });

    // type 32: boot information: no errors
    structures.push(structure(32, 0x2000, [0, 0, 0, 0, 0, 0, 0], []));
    // type 127: the end
    structures.push(structure(127, 0x7F00, [], []));

    const tables = new Uint8Array(structures.flat());
    const largest = Math.max(...structures.map(s => s.length));

    const anchor = new Uint8Array(0x1F);
    anchor.set([0x5F, 0x53, 0x4D, 0x5F]);       // "_SM_"
    anchor[5] = 0x1F;
    anchor[6] = SMBIOS_MAJOR;
    anchor[7] = SMBIOS_MINOR;
    anchor.set(le(largest, 2), 8);
    anchor.set([0x5F, 0x44, 0x4D, 0x49, 0x5F], 0x10); // "_DMI_"
    anchor.set(le(tables.length, 2), 0x16);
    // (the table's address, at 0x18, is the firmware's to fill in)
    anchor.set(le(structures.length, 2), 0x1C);
    anchor[0x1E] = SMBIOS_MAJOR << 4 | SMBIOS_MINOR;
    anchor[0x15] = -anchor.subarray(0x10, 0x1F).reduce((a, b) => a + b, 0) & 0xFF;
    anchor[4] = -anchor.reduce((a, b) => a + b, 0) & 0xFF;
    dbg_assert(tables.length < 0x10000);

    return { tables, anchor };
}

/**
 * The fw_cfg file etc/e820: RAM below and above 4 GiB, as QEMU's (each entry
 * a 64-bit address and length and a 32-bit type, 1: RAM)
 * @param {number} low_memory
 * @param {number} high_memory
 * @return {!Uint8Array}
 */
export function build_e820(low_memory, high_memory)
{
    const entries = [[0, low_memory]];
    if(high_memory) entries.push([2 ** 32, high_memory]);
    return new Uint8Array(entries.flatMap(([address, length]) => [...le(address, 8), ...le(length, 8), ...le(1, 4)]));
}
