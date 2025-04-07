import { h } from "./lib.js";
import { dbg_assert, dbg_log } from "./log.js";


// https://www.kernel.org/doc/Documentation/x86/boot.txt

const LINUX_BOOT_HDR_SETUP_SECTS = 0x1F1;
const LINUX_BOOT_HDR_SYSSIZE = 0x1F4;
const LINUX_BOOT_HDR_VIDMODE = 0x1FA;
const LINUX_BOOT_HDR_BOOT_FLAG = 0x1FE;
const LINUX_BOOT_HDR_HEADER = 0x202;
const LINUX_BOOT_HDR_VERSION = 0x206;
const LINUX_BOOT_HDR_TYPE_OF_LOADER = 0x210;
const LINUX_BOOT_HDR_LOADFLAGS = 0x211;
const LINUX_BOOT_HDR_CODE32_START = 0x214;
const LINUX_BOOT_HDR_RAMDISK_IMAGE = 0x218;
const LINUX_BOOT_HDR_RAMDISK_SIZE = 0x21C;
const LINUX_BOOT_HDR_HEAP_END_PTR = 0x224;
const LINUX_BOOT_HDR_CMD_LINE_PTR = 0x228;
const LINUX_BOOT_HDR_INITRD_ADDR_MAX = 0x22C;
const LINUX_BOOT_HDR_KERNEL_ALIGNMENT = 0x230;
const LINUX_BOOT_HDR_RELOCATABLE_KERNEL = 0x234;
const LINUX_BOOT_HDR_MIN_ALIGNMENT = 0x235;
const LINUX_BOOT_HDR_XLOADFLAGS = 0x236;
const LINUX_BOOT_HDR_CMDLINE_SIZE = 0x238;
const LINUX_BOOT_HDR_PAYLOAD_OFFSET = 0x248;
const LINUX_BOOT_HDR_PAYLOAD_LENGTH = 0x24C;
const LINUX_BOOT_HDR_PREF_ADDRESS = 0x258;
const LINUX_BOOT_HDR_INIT_SIZE = 0x260;

const LINUX_BOOT_HDR_CHECKSUM1 = 0xAA55;
const LINUX_BOOT_HDR_CHECKSUM2 = 0x53726448;

const LINUX_BOOT_HDR_TYPE_OF_LOADER_NOT_ASSIGNED = 0xFF;

const LINUX_BOOT_HDR_LOADFLAGS_LOADED_HIGH = 1 << 0;
const LINUX_BOOT_HDR_LOADFLAGS_QUIET_FLAG = 1 << 5;
const LINUX_BOOT_HDR_LOADFLAGS_KEEP_SEGMENTS = 1 << 6;
const LINUX_BOOT_HDR_LOADFLAGS_CAN_USE_HEAPS = 1 << 7;


export function load_kernel(mem8, bzimage, initrd, cmdline)
{
    dbg_log("Trying to load kernel of size " + bzimage.byteLength);

    const KERNEL_HIGH_ADDRESS = 0x100000;

    // Put the initrd at the 64 MB boundary. This means the minimum memory size
    // is 64 MB plus the size of the initrd.
    // Note: If set too low, kernel may fail to load the initrd with "invalid magic at start of compressed archive"
    const INITRD_ADDRESS = 64 << 20;

    const quiet = false;

    const bzimage8 = new Uint8Array(bzimage);
    const bzimage16 = new Uint16Array(bzimage);
    const bzimage32 = new Uint32Array(bzimage);

    const setup_sects = bzimage8[LINUX_BOOT_HDR_SETUP_SECTS] || 4;
    const syssize = bzimage32[LINUX_BOOT_HDR_SYSSIZE >> 2] << 4;

    const vidmode = bzimage16[LINUX_BOOT_HDR_VIDMODE >> 1];

    const checksum1 = bzimage16[LINUX_BOOT_HDR_BOOT_FLAG >> 1];
    if(checksum1 !== LINUX_BOOT_HDR_CHECKSUM1)
    {
        dbg_log("Bad checksum1: " + h(checksum1));
        return;
    }

    // Not aligned, so split into two 16-bit reads
    const checksum2 =
        bzimage16[LINUX_BOOT_HDR_HEADER >> 1] |
        bzimage16[LINUX_BOOT_HDR_HEADER + 2 >> 1] << 16;
    if(checksum2 !== LINUX_BOOT_HDR_CHECKSUM2)
    {
        dbg_log("Bad checksum2: " + h(checksum2));
        return;
    }

    const protocol = bzimage16[LINUX_BOOT_HDR_VERSION >> 1];
    dbg_assert(protocol >= 0x202); // older not supported by us

    const flags = bzimage8[LINUX_BOOT_HDR_LOADFLAGS];
    dbg_assert(flags & LINUX_BOOT_HDR_LOADFLAGS_LOADED_HIGH); // low kernels not supported by us

    // we don't relocate the kernel, so we don't care much about most of these

    const flags2 = bzimage16[LINUX_BOOT_HDR_XLOADFLAGS >> 1];
    const initrd_addr_max = bzimage32[LINUX_BOOT_HDR_INITRD_ADDR_MAX >> 2];
    const kernel_alignment = bzimage32[LINUX_BOOT_HDR_KERNEL_ALIGNMENT >> 2];
    const relocatable_kernel = bzimage8[LINUX_BOOT_HDR_RELOCATABLE_KERNEL];
    const min_alignment = bzimage8[LINUX_BOOT_HDR_MIN_ALIGNMENT];
    const cmdline_size = protocol >= 0x206 ? bzimage32[LINUX_BOOT_HDR_CMDLINE_SIZE >> 2] : 255;
    const payload_offset = bzimage32[LINUX_BOOT_HDR_PAYLOAD_OFFSET >> 2];
    const payload_length = bzimage32[LINUX_BOOT_HDR_PAYLOAD_LENGTH >> 2];
    const pref_address = bzimage32[LINUX_BOOT_HDR_PREF_ADDRESS >> 2];
    const pref_address_high = bzimage32[LINUX_BOOT_HDR_PREF_ADDRESS + 4 >> 2];
    const init_size = bzimage32[LINUX_BOOT_HDR_INIT_SIZE >> 2];

    dbg_log("kernel boot protocol version: " + h(protocol));
    dbg_log("flags=" + h(flags) + " xflags=" + h(flags2));
    dbg_log("code32_start=" + h(bzimage32[LINUX_BOOT_HDR_CODE32_START >> 2]));
    dbg_log("initrd_addr_max=" + h(initrd_addr_max));
    dbg_log("kernel_alignment=" + h(kernel_alignment));
    dbg_log("relocatable=" + relocatable_kernel);
    dbg_log("min_alignment=" + h(min_alignment));
    dbg_log("cmdline max=" + h(cmdline_size));
    dbg_log("payload offset=" + h(payload_offset) + " size=" + h(payload_length));
    dbg_log("pref_address=" + h(pref_address_high) + ":" + h(pref_address));
    dbg_log("init_size=" + h(init_size));

    const real_mode_segment = 0x8000;
    const base_ptr = real_mode_segment << 4;

    const heap_end = 0xE000;
    const heap_end_ptr = heap_end - 0x200;

    // fill in the kernel boot header with infos the kernel needs to know

    bzimage8[LINUX_BOOT_HDR_TYPE_OF_LOADER] = LINUX_BOOT_HDR_TYPE_OF_LOADER_NOT_ASSIGNED;

    const new_flags =
        (quiet ? flags | LINUX_BOOT_HDR_LOADFLAGS_QUIET_FLAG : flags & ~LINUX_BOOT_HDR_LOADFLAGS_QUIET_FLAG)
        & ~LINUX_BOOT_HDR_LOADFLAGS_KEEP_SEGMENTS
        | LINUX_BOOT_HDR_LOADFLAGS_CAN_USE_HEAPS;
    bzimage8[LINUX_BOOT_HDR_LOADFLAGS] = new_flags;

    bzimage16[LINUX_BOOT_HDR_HEAP_END_PTR >> 1] = heap_end_ptr;

    // should parse the vga=... paramter from cmdline here, but we don't really care
    bzimage16[LINUX_BOOT_HDR_VIDMODE >> 1] = 0xFFFF; // normal

    dbg_log("heap_end_ptr=" + h(heap_end_ptr));

    cmdline += "\x00";
    dbg_assert(cmdline.length < cmdline_size);

    const cmd_line_ptr = base_ptr + heap_end;
    dbg_log("cmd_line_ptr=" + h(cmd_line_ptr));

    bzimage32[LINUX_BOOT_HDR_CMD_LINE_PTR >> 2] = cmd_line_ptr;
    for(let i = 0; i < cmdline.length; i++)
    {
        mem8[cmd_line_ptr + i] = cmdline.charCodeAt(i);
    }

    const prot_mode_kernel_start = (setup_sects + 1) * 512;
    dbg_log("prot_mode_kernel_start=" + h(prot_mode_kernel_start));

    const real_mode_kernel = new Uint8Array(bzimage, 0, prot_mode_kernel_start);
    const protected_mode_kernel = new Uint8Array(bzimage, prot_mode_kernel_start);

    let ramdisk_address = 0;
    let ramdisk_size = 0;

    if(initrd)
    {
        ramdisk_address = INITRD_ADDRESS;
        ramdisk_size = initrd.byteLength;

        dbg_assert(KERNEL_HIGH_ADDRESS + protected_mode_kernel.length < ramdisk_address);

        mem8.set(new Uint8Array(initrd), ramdisk_address);
    }

    bzimage32[LINUX_BOOT_HDR_RAMDISK_IMAGE >> 2] = ramdisk_address;
    bzimage32[LINUX_BOOT_HDR_RAMDISK_SIZE >> 2] = ramdisk_size;

    dbg_assert(base_ptr + real_mode_kernel.length < 0xA0000);

    mem8.set(real_mode_kernel, base_ptr);
    mem8.set(protected_mode_kernel, KERNEL_HIGH_ADDRESS);

    return {
        name: "genroms/kernel.bin",
        data: make_linux_boot_rom(real_mode_segment, heap_end),
    };
}

function make_linux_boot_rom(real_mode_segment, heap_end)
{
    // This rom will be executed by seabios after its initialisation
    // It sets up segment registers, the stack and calls the kernel real mode entry point

    const SIZE = 0x200;

    const data8 = new Uint8Array(SIZE);
    const data16 = new Uint16Array(data8.buffer);

    data16[0] = 0xAA55;
    data8[2] = SIZE / 0x200;

    let i = 3;

    data8[i++] = 0xFA; // cli
    data8[i++] = 0xB8; // mov ax, real_mode_segment
    data8[i++] = real_mode_segment >> 0;
    data8[i++] = real_mode_segment >> 8;
    data8[i++] = 0x8E; // mov es, ax
    data8[i++] = 0xC0;
    data8[i++] = 0x8E; // mov ds, ax
    data8[i++] = 0xD8;
    data8[i++] = 0x8E; // mov fs, ax
    data8[i++] = 0xE0;
    data8[i++] = 0x8E; // mov gs, ax
    data8[i++] = 0xE8;
    data8[i++] = 0x8E; // mov ss, ax
    data8[i++] = 0xD0;
    data8[i++] = 0xBC; // mov sp, heap_end
    data8[i++] = heap_end >> 0;
    data8[i++] = heap_end >> 8;
    data8[i++] = 0xEA; // jmp (real_mode_segment+0x20):0x0
    data8[i++] = 0x00;
    data8[i++] = 0x00;
    data8[i++] = real_mode_segment + 0x20 >> 0;
    data8[i++] = real_mode_segment + 0x20 >> 8;

    dbg_assert(i < SIZE);

    const checksum_index = i;
    data8[checksum_index] = 0;

    let checksum = 0;

    for(let i = 0; i < data8.length; i++)
    {
        checksum += data8[i];
    }

    data8[checksum_index] = -checksum;

    return data8;
}
