import { check_disk_state, is_writeback_state } from "./disk_writeback.js";
import { drop_disk_holds } from "./block_backend.js";
import {
    LOG_CPU, LOG_BIOS,
    FW_CFG_SIGNATURE, FW_CFG_SIGNATURE_QEMU,
    WASM_TABLE_SIZE, WASM_TABLE_OFFSET, FW_CFG_ID,
    FW_CFG_RAM_SIZE, FW_CFG_NB_CPUS, FW_CFG_MAX_CPUS, FW_CFG_BOOT_MENU,
    FW_CFG_NUMA, FW_CFG_FILE_DIR, FW_CFG_FILE_START,
    FW_CFG_CUSTOM_START, FLAGS_DEFAULT,
    MMAP_BLOCK_BITS, MMAP_BLOCK_SIZE, MMAP_MAX,
    REG_ESP, REG_EBP, REG_ESI, REG_EAX, REG_EBX, REG_ECX, REG_EDX, REG_EDI,
    REG_CS, REG_DS, REG_ES, REG_FS, REG_GS, REG_SS, CR0_PG, CR4_PAE, REG_LDTR,
    FLAG_VM, FLAG_INTERRUPT, FLAG_CARRY, FLAG_ADJUST, FLAG_ZERO, FLAG_SIGN, FLAG_TRAP,
    FLAG_DIRECTION, FLAG_OVERFLOW, FLAG_PARITY, STATE_MAX_SINGLE_BUFFER,
} from "./const.js";
import { h, view, Bitmap } from "./lib.js";
import { dbg_assert, dbg_log } from "./log.js";
import { v86 } from "./main.js";
import { MachineClock } from "./machine_clock.js";

import { SB16 } from "./sb16.js";
import { ACPI, acpi_system_states_file } from "./acpi.js";
import { ACPI_LOADER_FILE, ACPI_RSDP_FILE, ACPI_TABLES_FILE, build_acpi_tables, locate_acpi_tables } from "./acpi_tables.js";
import { ACPI_PM_BASE_DEFAULT, MACHINE_LAYOUT_VERSION, Platform, check_platform, create_platform } from "./platform.js";
import { CORE_STATE_RANGES, INIT_PRESERVED, STATE_OFFSETS } from "./state_layout.js";
import { CPU_FEATURES, CPU_FEATURE_PRESETS } from "./cpu_features.js";
import { build_jit_defaults, set_jit_switches } from "./jit_switches.js";
import { ParallelMachine } from "./parallel/machine.js";
import { ExtendedStore } from "./extended_memory.js";
import { COMMAND_RELOAD, COMMAND_RESET } from "./parallel/control.js";
import { PIT } from "./pit.js";
import { DMA } from "./dma.js";
import { UART } from "./uart.js";
import { ParallelPort } from "./parallel.js";
import { Ne2k } from "./ne2k.js";
import { IO } from "./io.js";
import { VirtioConsole } from "./virtio_console.js";
import { PCI } from "./pci.js";
import { Q35 } from "./q35.js";
import { PS2 } from "./ps2.js";
import { VMwareMouse } from "./vmware.js";
import { read_elf, elf_unsupported_reason } from "./elf.js";

import { FloppyController } from "./floppy.js";
import { IDEController } from "./ide.js";
import { AHCIController } from "./ahci.js";
import { PCIeRootPort } from "./pcie_root_port.js";
import { HPET } from "./hpet.js";
import { SMBus } from "./smbus.js";
import { VirtioNet } from "./virtio_net.js";
import { GraphicsAdapter, graphics_adapter_of_state, patch_vga_bios_ids } from "./graphics_adapter.js";
import { DisplayHub } from "./display.js";
import { VirtioBalloon } from "./virtio_balloon.js";
import { create_virtio_devices, get_virtio_devices_state, resolve_virtio_devices_state, set_virtio_devices_state } from "./virtio_devices.js";
import { Virtio9p, Virtio9pHandler, Virtio9pProxy } from "../lib/9p.js";

import { load_kernel } from "./kernel.js";
import { check_machine_options } from "./machine_options.js";

import {
    RTC,
    CMOS_EQUIPMENT_INFO, CMOS_BIOS_SMP_COUNT,
    CMOS_MEM_HIGHMEM_HIGH, CMOS_MEM_HIGHMEM_MID, CMOS_MEM_HIGHMEM_LOW,
    CMOS_DISK_DATA, CMOS_BIOS_DISKTRANSFLAG, CMOS_FLOPPY_DRIVE_TYPE,
    BOOT_ORDER_CD_FIRST, CMOS_BIOS_BOOTFLAG1, CMOS_BIOS_BOOTFLAG2,
    CMOS_MEM_BASE_LOW, CMOS_MEM_BASE_HIGH,
    CMOS_MEM_OLD_EXT_LOW, CMOS_MEM_OLD_EXT_HIGH, CMOS_MEM_EXTMEM_LOW,
    CMOS_MEM_EXTMEM_HIGH, CMOS_MEM_EXTMEM2_LOW, CMOS_MEM_EXTMEM2_HIGH
} from "./rtc.js";


// For Types Only

import { BusConnector } from "./bus.js";

// Resources:
// https://pdos.csail.mit.edu/6.828/2006/readings/i386/toc.htm
// https://www-ssl.intel.com/content/www/us/en/processors/architectures-software-developer-manuals.html
// http://ref.x86asm.net/geek32.html


/** @constructor */
export function CPU(bus, wm, stop_idling)
{
    this.stop_idling = stop_idling;
    this.wm = wm;
    this.clock = new MachineClock({ now: v86.microtick });
    this.execution_epoch = 0;
    this.in_cpu = false;
    this.reset_pending = false;
    this.scheduler_quantum = 4096;
    this.scheduler_seed = 0;
    this.scheduler_round = 0;
    this.jit_backend = "ir";
    this.wasm_patch();
    this.create_jit_imports();

    const memory = this.wm.exports.memory;

    this.wasm_memory = memory;

    // Address of offset 0 of the state layout (src/state_layout.js): 0 in
    // v86.wasm; the state block of this instance in v86-parallel.wasm, where
    // each vCPU worker has its own (src/parallel/relocate.js)
    // (an i32: a vCPU's instance may lie above 2 GiB when guest RAM is large)
    const state_base = this.state_base = this.wm.exports["state_base"] ? this.wm.exports["state_base"]() >>> 0 : 0;

    /** @type {ParallelMachine} application processors in vCPU workers (start_parallel) */
    this.parallel = null;
    /** why the cores run cooperatively although parallel execution was requested ("" if not) */
    this.parallel_fallback = "";

    /** the CPU features (src/cpu_features.js) and whether cpu_features chose them (init) */
    this.cpu_features = 0;
    this.cpu_features_explicit = false;

    // extended RAM (configure_extended_memory)
    this.extended_pages = 0;
    this.extended_base = 0;
    /** @type {ExtendedStore} */
    this.extended_store = null;

    this.memory_size = view(Uint32Array, memory, state_base + STATE_OFFSETS.memory_size, 1);
    // RAM below 4 GiB; less than memory_size when high_memory_size is set
    this.low_memory_size = 0;

    this.mem8 = new Uint8Array(0);
    this.mem32s = new Int32Array(this.mem8.buffer);

    this.segment_is_null = view(Uint8Array, memory, state_base + STATE_OFFSETS.segment_is_null, 8);
    this.segment_offsets = view(Int32Array, memory, state_base + STATE_OFFSETS.segment_offsets, 8);
    this.segment_limits = view(Uint32Array, memory, state_base + STATE_OFFSETS.segment_limits, 8);
    this.segment_access_bytes = view(Uint8Array, memory, state_base + STATE_OFFSETS.segment_access_bytes, 8);

    /**
     * Wheter or not in protected mode
     */
    this.protected_mode = view(Int32Array, memory, state_base + STATE_OFFSETS.protected_mode, 1);

    this.idtr_size = view(Int32Array, memory, state_base + STATE_OFFSETS.idtr_size, 1);
    this.idtr_offset = view(Int32Array, memory, state_base + STATE_OFFSETS.idtr_offset, 1);

    /**
     * global descriptor table register
     */
    this.gdtr_size = view(Int32Array, memory, state_base + STATE_OFFSETS.gdtr_size, 1);
    this.gdtr_offset = view(Int32Array, memory, state_base + STATE_OFFSETS.gdtr_offset, 1);

    this.tss_size_32 = view(Int32Array, memory, state_base + STATE_OFFSETS.tss_size_32, 1);

    this.cr = view(Int32Array, memory, state_base + STATE_OFFSETS.cr, 8);

    // current privilege level
    this.cpl = view(Uint8Array, memory, state_base + STATE_OFFSETS.cpl, 1);

    // current operand/address size
    this.is_32 = view(Int32Array, memory, state_base + STATE_OFFSETS.is_32, 1);

    this.stack_size_32 = view(Int32Array, memory, state_base + STATE_OFFSETS.stack_size_32, 1);

    /**
     * Was the last instruction a hlt?
     */
    this.in_hlt = view(Uint8Array, memory, state_base + STATE_OFFSETS.in_hlt, 1);

    this.last_virt_eip = view(Int32Array, memory, state_base + STATE_OFFSETS.last_virt_eip, 1);
    this.eip_phys = view(Int32Array, memory, state_base + STATE_OFFSETS.eip_phys, 1);


    this.sysenter_cs = view(Int32Array, memory, state_base + STATE_OFFSETS.sysenter_cs, 1);

    this.sysenter_esp = view(Int32Array, memory, state_base + STATE_OFFSETS.sysenter_esp, 1);

    this.sysenter_eip = view(Int32Array, memory, state_base + STATE_OFFSETS.sysenter_eip, 1);

    this.prefixes = view(Int32Array, memory, state_base + STATE_OFFSETS.prefixes, 1);

    this.flags = view(Int32Array, memory, state_base + STATE_OFFSETS.flags, 1);

    /**
     * bitmap of flags which are not updated in the flags variable
     * changed by arithmetic instructions, so only relevant to arithmetic flags
     */
    this.flags_changed = view(Int32Array, memory, state_base + STATE_OFFSETS.flags_changed, 1);

    /**
     * enough infos about the last arithmetic operation to compute eflags
     */
    this.last_op_size = view(Int32Array, memory, state_base + STATE_OFFSETS.last_op_size, 1);
    this.last_op1 = view(Int32Array, memory, state_base + STATE_OFFSETS.last_op1, 1);
    this.last_result = view(Int32Array, memory, state_base + STATE_OFFSETS.last_result, 1);

    this.current_tsc = view(Uint32Array, memory, state_base + STATE_OFFSETS.current_tsc, 2); // 64 bit

    /** @type {!Object} */
    this.devices = {};

    this.instruction_pointer = view(Int32Array, memory, state_base + STATE_OFFSETS.instruction_pointer, 1);
    this.previous_ip = view(Int32Array, memory, state_base + STATE_OFFSETS.previous_ip, 1);

    // configured by guest
    this.apic_enabled = view(Uint8Array, memory, state_base + STATE_OFFSETS.apic_enabled, 1);
    // configured when the emulator starts (changes bios initialisation)
    this.acpi_enabled = view(Uint8Array, memory, state_base + STATE_OFFSETS.acpi_enabled, 1);

    // managed in io.js
    /** @const */ this.memory_map_read8 = [];
    /** @const */ this.memory_map_write8 = [];
    /** @const */ this.memory_map_read32 = [];
    /** @const */ this.memory_map_write32 = [];

    /**
     * @const
     * @type {{main: ArrayBuffer, vga: ArrayBuffer}}
     */
    this.bios = {
        main: null,
        vga: null,
    };

    this.instruction_counter = view(Uint32Array, memory, state_base + STATE_OFFSETS.instruction_counter, 1);

    // registers
    this.reg32 = view(Int32Array, memory, state_base + STATE_OFFSETS.reg32, 8);

    this.fpu_st = view(Int32Array, memory, state_base + STATE_OFFSETS.fpu_st, 4 * 8);

    this.fpu_stack_empty = view(Uint8Array, memory, state_base + STATE_OFFSETS.fpu_stack_empty, 1);
    this.fpu_stack_empty[0] = 0xFF;
    this.fpu_stack_ptr = view(Uint8Array, memory, state_base + STATE_OFFSETS.fpu_stack_ptr, 1);
    this.fpu_stack_ptr[0] = 0;

    this.fpu_control_word = view(Uint16Array, memory, state_base + STATE_OFFSETS.fpu_control_word, 1);
    this.fpu_control_word[0] = 0x37F;
    this.fpu_status_word = view(Uint16Array, memory, state_base + STATE_OFFSETS.fpu_status_word, 1);
    this.fpu_status_word[0] = 0;
    this.fpu_ip = view(Int32Array, memory, state_base + STATE_OFFSETS.fpu_ip, 1);
    this.fpu_ip[0] = 0;
    this.fpu_ip_selector = view(Int32Array, memory, state_base + STATE_OFFSETS.fpu_ip_selector, 1);
    this.fpu_ip_selector[0] = 0;
    this.fpu_opcode = view(Int32Array, memory, state_base + STATE_OFFSETS.fpu_opcode, 1);
    this.fpu_opcode[0] = 0;
    this.fpu_dp = view(Int32Array, memory, state_base + STATE_OFFSETS.fpu_dp, 1);
    this.fpu_dp[0] = 0;
    this.fpu_dp_selector = view(Int32Array, memory, state_base + STATE_OFFSETS.fpu_dp_selector, 1);
    this.fpu_dp_selector[0] = 0;

    this.reg_xmm32s = view(Int32Array, memory, state_base + STATE_OFFSETS.reg_xmm, 8 * 4);

    this.mxcsr = view(Int32Array, memory, state_base + STATE_OFFSETS.mxcsr, 1);

    // segment registers, tr and ldtr
    this.sreg = view(Uint16Array, memory, state_base + STATE_OFFSETS.sreg, 8);

    // debug registers
    this.dreg = view(Int32Array, memory, state_base + STATE_OFFSETS.dreg, 8);

    this.reg_pdpte = view(Int32Array, memory, state_base + STATE_OFFSETS.reg_pdpte, 8);

    this.svga_dirty_bitmap_min_offset = view(Uint32Array, memory, state_base + STATE_OFFSETS.svga_dirty_bitmap_min_offset, 1);
    this.svga_dirty_bitmap_max_offset = view(Uint32Array, memory, state_base + STATE_OFFSETS.svga_dirty_bitmap_max_offset, 1);

    this.fw_value = [];
    this.fw_pointer = 0;
    /**
     * Files of the fw_cfg file directory (option ROMs, ACPI tables, ...).
     * get_data, if present, produces the contents when the firmware selects
     * the file; it must return as many bytes as data, which gives the size.
     * @type {!Array<{name: string, data: !Uint8Array, get_data: (function():!Uint8Array|undefined)}>}
     */
    this.option_roms = [];

    /** @type {?Platform} description of the emulated platform */
    this.platform = null;

    /**
     * The cores of the machine (setup_cores). One runs at a time: its state is
     * in the fixed state block and `saved` is null; the others keep theirs in
     * `saved`. `running` is false for an AP waiting for a start-up IPI.
     * @type {!Array<{running: boolean, saved: ?Array<!Uint8Array>, slices: number, steps: number}>}
     */
    this.cores = [];
    this.active_core = 0;
    /** The core in a worker whose port or MMIO access is being performed
     * (src/parallel/machine.js), or -1: the active core's */
    this.io_core = -1;
    /** State of a core after reset_cpu, used for INIT @type {!Array<!Uint8Array>} */
    this.core_reset_state = [];

    /** @type {?function()} */
    this.reload_direct_boot_kernel = null;

    /**
     * Asserted level-triggered sources (ACPI SCI, PCI INTx) per IRQ line, see
     * set_shared_irq_level
     * @type {!Array<!Set<number>>}
     */
    this.shared_irq_sources = Array.from({ length: 24 }, () => new Set());

    this.io = undefined;

    this.bus = bus;

    this.set_tsc(0, 0);

    //Object.seal(this);
}

CPU.prototype.mmap_read8 = function(addr)
{
    const value = this.memory_map_read8[addr >>> MMAP_BLOCK_BITS](addr);
    dbg_assert(value >= 0 && value <= 0xFF);
    return value;
};

CPU.prototype.mmap_write8 = function(addr, value)
{
    dbg_assert(value >= 0 && value <= 0xFF);
    this.memory_map_write8[addr >>> MMAP_BLOCK_BITS](addr, value);
};

CPU.prototype.mmap_write16 = function(addr, value)
{
    var fn = this.memory_map_write8[addr >>> MMAP_BLOCK_BITS];

    dbg_assert(value >= 0 && value <= 0xFFFF);
    fn(addr, value & 0xFF);
    fn(addr + 1 | 0, value >> 8);
};

CPU.prototype.mmap_read32 = function(addr)
{
    var aligned_addr = addr >>> MMAP_BLOCK_BITS;

    return this.memory_map_read32[aligned_addr](addr);
};

CPU.prototype.mmap_write32 = function(addr, value)
{
    var aligned_addr = addr >>> MMAP_BLOCK_BITS;

    this.memory_map_write32[aligned_addr](addr, value);
};

CPU.prototype.mmap_write64 = function(addr, value0, value1)
{
    var aligned_addr = addr >>> MMAP_BLOCK_BITS;
    // This should hold since writes across pages are split up
    dbg_assert(aligned_addr === (addr + 7) >>> MMAP_BLOCK_BITS);

    var write_func32 = this.memory_map_write32[aligned_addr];
    write_func32(addr, value0);
    write_func32(addr + 4, value1);
};

CPU.prototype.mmap_write128 = function(addr, value0, value1, value2, value3)
{
    var aligned_addr = addr >>> MMAP_BLOCK_BITS;
    // This should hold since writes across pages are split up
    dbg_assert(aligned_addr === (addr + 12) >>> MMAP_BLOCK_BITS);

    var write_func32 = this.memory_map_write32[aligned_addr];
    write_func32(addr, value0);
    write_func32(addr + 4, value1);
    write_func32(addr + 8, value2);
    write_func32(addr + 12, value3);
};

/**
 * @param {Array.<number>|Uint8Array} blob
 * @param {number} offset
 */
CPU.prototype.write_blob = function(blob, offset)
{
    dbg_assert(blob && blob.length >= 0);

    if(blob.length)
    {
        dbg_assert(!this.in_mapped_range(offset));
        dbg_assert(!this.in_mapped_range(offset + blob.length - 1));

        this.jit_dirty_cache(offset, offset + blob.length);
        this.mem8.set(blob, offset);
    }
};

CPU.prototype.read_blob = function(offset, length)
{
    if(length)
    {
        dbg_assert(!this.in_mapped_range(offset));
        dbg_assert(!this.in_mapped_range(offset + length - 1));
    }
    return this.mem8.subarray(offset, offset + length);
};

// Legacy VGA memory and the BIOS ROMs, never RAM for a device
const LEGACY_HOLE_START = 0xA0000;
const LEGACY_HOLE_END = 0x100000;
const PAGE_SIZE = 4096;
// x64_phys_kind
const PHYS_KIND_RAM = 1;
const PHYS_KIND_EXTENDED = 3;

/** The end of the physical address space: the 36-bit bus */
CPU.prototype.physical_limit = 0x1000000000;

/**
 * Where a device's DMA to [address, address + length) goes (the machine's
 * DMA facade, docs/arm64-virt-android16-plan.md P1.6)
 * @param {number} address
 * @param {number} length
 * @return {number} the offset of one contiguous plain-RAM backing,
 *     -1 for other RAM, -2 for anything that is not RAM
 */
CPU.prototype.dma_classify = function(address, length)
{
    if(!Number.isSafeInteger(address) || !Number.isSafeInteger(length) || address < 0 || length <= 0 ||
        address + length > this.physical_limit ||
        address < LEGACY_HOLE_END && address + length > LEGACY_HOLE_START)
    {
        return -2;
    }

    const kind = this.wm.exports["x64_phys_kind"];
    const resolve = this.wm.exports["x64_phys_resolve"];
    const first = resolve(address >>> 0, Math.floor(address / 0x100000000));
    let contiguous = first >= 0;

    for(let page = address - address % PAGE_SIZE; page < address + length; page += PAGE_SIZE)
    {
        const low = page >>> 0;
        const high = Math.floor(page / 0x100000000);
        const page_kind = kind(low, high);
        if(page_kind !== PHYS_KIND_RAM && page_kind !== PHYS_KIND_EXTENDED) return -2;
        // (extended RAM frames are cached, never a view)
        if(contiguous && (page_kind !== PHYS_KIND_RAM ||
            page > address && resolve(low, high) !== first + (page - address)))
        {
            contiguous = false;
        }
    }

    return contiguous ? first : -1;
};

/** Validate a complete 36-bit DMA range without reading any device. */
CPU.prototype.validate_physical_range = function(address, length)
{
    if(!Number.isSafeInteger(address) || !Number.isSafeInteger(length) || address < 0 || address >= 0x1000000000 || length < 0 ||
        address + length > 0x1000000000) throw new RangeError("Physical address exceeds the 36-bit bus");
    const resolve = this.wm.exports["x64_phys_resolve"];
    for(let at = address; at < address + length;)
    {
        const end = Math.min(address + length, Math.floor(at / 4096 + 1) * 4096);
        if(resolve(at >>> 0, Math.floor(at / 0x100000000)) < 0 ||
            resolve((end - 1) >>> 0, Math.floor((end - 1) / 0x100000000)) < 0)
            throw new RangeError("Physical range is not mapped");
        at = end;
    }
};

/** @param {number} address @param {number} width @return {number} */
CPU.prototype.read_physical_scalar = function(address, width)
{
    this.validate_physical_range(address, width / 8);
    const value = this.wm.exports["x64_phys_read" + width](address >>> 0, Math.floor(address / 0x100000000));
    if(value < 0) throw new RangeError("Physical range is not mapped");
    return value;
};
CPU.prototype.read8_physical = function(address) { return this.read_physical_scalar(address, 8); };
CPU.prototype.read16_physical = function(address) { return this.read_physical_scalar(address, 16); };
CPU.prototype.read32_physical = function(address) { return this.read_physical_scalar(address, 32); };
CPU.prototype.write_physical_scalar = function(address, value, width)
{
    this.validate_physical_range(address, width / 8);
    if(!this.wm.exports["x64_phys_write" + width](address >>> 0, Math.floor(address / 0x100000000), value >>> 0))
        throw new RangeError("Physical range is not mapped");
};
CPU.prototype.write8_physical = function(address, value) { this.write_physical_scalar(address, value, 8); };
CPU.prototype.write16_physical = function(address, value) { this.write_physical_scalar(address, value, 16); };
CPU.prototype.write32_physical = function(address, value) { this.write_physical_scalar(address, value, 32); };

/** Copy one requested chunk; never allocate based on a physical address. */
CPU.prototype.read_blob_physical = function(address, length)
{
    this.validate_physical_range(address, length);
    const result = new Uint8Array(length);
    for(let done = 0; done < length;)
    {
        const at = address + done;
        const count = Math.min(length - done, 4096 - at % 4096);
        const kind = this.wm.exports["x64_phys_kind"](at >>> 0, Math.floor(at / 0x100000000));
        if(kind === 1)
        {
            const backing = this.wm.exports["x64_phys_resolve"](at >>> 0, Math.floor(at / 0x100000000));
            result.set(this.mem8.subarray(backing, backing + count), done);
        }
        else if(kind === 3) result.set(this.extended_page_bytes(at, count, false), done);
        else for(let i = 0; i < count; i++) result[done + i] = this.read8_physical(at + i);
        done += count;
    }
    return result;
};
CPU.prototype.write_blob_physical = function(blob, address)
{
    this.validate_physical_range(address, blob.length);
    for(let done = 0; done < blob.length;)
    {
        const at = address + done;
        const count = Math.min(blob.length - done, 4096 - at % 4096);
        const kind = this.wm.exports["x64_phys_kind"](at >>> 0, Math.floor(at / 0x100000000));
        if(kind === 1)
        {
            const backing = this.wm.exports["x64_phys_resolve"](at >>> 0, Math.floor(at / 0x100000000));
            this.jit_dirty_cache(backing, backing + count);
            this.mem8.set(blob.slice(done, done + count), backing);
        }
        else if(kind === 3) this.extended_page_bytes(at, count, blob.subarray(done, done + count));
        else for(let i = 0; i < count; i++) this.write8_physical(at + i, blob[done + i]);
        done += count;
    }
};

/**
 * Copy bytes of one extended RAM page (DMA, debugging): its frame is pinned
 * meanwhile (src/rust/x64/extended.rs)
 * @param {number} address guest physical, in extended RAM
 * @param {number} count bytes within the page
 * @param {Uint8Array|boolean} write the bytes to write, or false to read
 * @return {!Uint8Array} the bytes read
 */
CPU.prototype.extended_page_bytes = function(address, count, write)
{
    const page = Math.floor((address - this.extended_base) / 4096);
    // (an i32: the frame pool may lie above 2 GiB)
    const frame = this.wm.exports["x64_ext_pin"](page, !!write) >>> 0;
    dbg_assert(frame !== 0 && address % 4096 + count <= 4096);
    const bytes = new Uint8Array(this.wasm_memory.buffer, frame + address % 4096, count);
    let result = bytes;
    if(write) bytes.set(/** @type {!Uint8Array} */ (write));
    else result = bytes.slice();
    this.wm.exports["x64_ext_unpin"](page);
    return result;
};

CPU.prototype.clear_stats = function()
{
    this.wm.exports["profiler_init"]();
};

// Compiled code of the page tiers (src/rust/jitrt/publish.rs: the x64
// page tier is client 0). Installed synchronously when the host allows it:
// the core is at a scheduling point with no Rust lock held, so the function
// is callable before the guest continues. Resolves to whether the function
// was installed (the performance recorder times it).
CPU.prototype.jit_publish = function(client, id, slot, pointer, length)
{
    const exports = this.wm.exports;
    return this.publish_code(slot, pointer, length, () => exports["jit_install"](client, id, slot),
        () => exports["jit_ready"](client, id, slot), () => exports["jit_cancel"](client, id, slot));
};

CPU.prototype.publish_code = function(slot, pointer, length, install, ready, cancel)
{
    const wasm = this.wm, exports = wasm.exports, table = wasm.wasm_table;
    const epoch = this.execution_epoch;
    const code = new Uint8Array(exports["memory"].buffer, pointer >>> 0, length >>> 0).slice();
    const current = () => this.execution_epoch === epoch && this.wm === wasm;
    const set = instance => {
        if(!current()) return false;
        const f = instance.exports["f"];
        if(typeof f !== "function" || !install())
        {
            cancel();
            return false;
        }
        table.set(slot + WASM_TABLE_OFFSET, f);
        ready();
        return true;
    };
    if(this.ir_sync_publication)
    {
        try
        {
            return Promise.resolve(set(new WebAssembly.Instance(new WebAssembly.Module(code), { "e": this.jit_imports })));
        }
        catch(error)
        {
            if(error instanceof WebAssembly.CompileError || error instanceof WebAssembly.LinkError)
            {
                dbg_log("page function rejected: " + error, LOG_CPU);
                if(current()) cancel();
                return Promise.resolve(false);
            }
            this.ir_sync_publication = false;
        }
    }
    return WebAssembly.instantiate(code, { "e": this.jit_imports }).then(result => set(result.instance), error => {
        dbg_log("page function rejected: " + error, LOG_CPU);
        if(current()) cancel();
        return false;
    });
};

CPU.prototype.create_jit_imports = function()
{
    // Set this.jit_imports as generated WASM modules will expect

    const jit_imports = Object.create(null);

    jit_imports["m"] = this.wm.exports["memory"];

    for(const name of Object.keys(this.wm.exports))
    {
        if(name.startsWith("_") || name.startsWith("zstd") || name.endsWith("_js"))
        {
            continue;
        }

        jit_imports[name] = this.wm.exports[name];
    }

    // With Wasm tail calls, x64 page functions continue in the next page's
    // function directly, through the shared function table (x64::pages CHAIN).
    const table = this.wm.wasm_table;
    if(table && this.wm.exports["jit_set_tail_calls"])
    {
        // (module (func (return_call 0)))
        const probe = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 6, 1, 4, 0, 18, 0, 11]);
        const supported = WebAssembly.validate(probe);
        if(supported) jit_imports["t"] = table;
        this.wm.exports["jit_set_tail_calls"](supported ? 1 : 0);
        this.wm.exports["x64_page_set_chaining"]?.(supported ? 1 : 0);
    }
    // FMA with relaxed SIMD's multiply-adds where they fuse (ir::native_fp)
    this.wm.exports["ir_relaxed_fma_fused"]?.(relaxed_fma_fused() ? 1 : 0);

    this.jit_imports = jit_imports;
};

let relaxed_fma_result;
/**
 * Whether the engine has Wasm relaxed SIMD and its f32x4/f64x2 relaxed_madd
 * and relaxed_nmadd fuse, rounding once like x86's FMA (an engine may choose
 * either, and keeps its choice). Each is given (1 + ulp) * (1 + ulp) and an
 * addend that cancels all but the product's last bit, 2^-104 or 2^-46, which
 * only a fused operation keeps.
 * @return {boolean}
 */
export function relaxed_fma_fused()
{
    if(relaxed_fma_result !== undefined) return relaxed_fma_result;
    const leb = n => {
        const out = [];
        do { out.push(n > 127 ? n & 127 | 128 : n); n >>>= 7; } while(n);
        return out;
    };
    const simd = op => [0xFD, ...leb(op)];
    // v128.const of a double's 32-bit halves or a single in every lane
    const lanes = (double, ...words) => [...simd(0x0C), ...(double ? [...words, ...words] : [words[0], words[0], words[0], words[0]])
        .flatMap(w => [w & 255, w >>> 8 & 255, w >>> 16 & 255, w >>> 24 & 255])];
    // op(a, a, c) === expected in every lane (i64x2/i32x4 eq, all_true)
    const check = (op, double, a, c, expected) => [...lanes(double, ...a), ...lanes(double, ...a), ...lanes(double, ...c),
        ...simd(op), ...lanes(double, ...expected), ...simd(double ? 0xD6 : 0x37), ...simd(double ? 0xC3 : 0xA3)];
    const body = [0,
        ...check(0x107, true, [1, 0x3FF00000], [2, 0xBFF00000], [0, 0x39700000]), // f64x2.relaxed_madd
        ...check(0x108, true, [1, 0x3FF00000], [2, 0x3FF00000], [0, 0xB9700000]), 0x71, // f64x2.relaxed_nmadd, i32.and
        ...check(0x105, false, [0x3F800001], [0xBF800002], [0x28800000]), 0x71, // f32x4.relaxed_madd
        ...check(0x106, false, [0x3F800001], [0x3F800002], [0xA8800000]), 0x71, // f32x4.relaxed_nmadd
        0x0B];
    const code = [1, ...leb(body.length), ...body];
    // (module (func (export "f") (result i32) ...))
    const bytes = new Uint8Array([0, 0x61, 0x73, 0x6D, 1, 0, 0, 0, 1, 5, 1, 0x60, 0, 1, 0x7F, 3, 2, 1, 0, 7, 5, 1, 1, 0x66, 0, 0,
        10, ...leb(code.length), ...code]);
    relaxed_fma_result = false;
    try
    {
        relaxed_fma_result = WebAssembly.validate(bytes) &&
            new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports["f"]() === 1;
    }
    catch(e) {}
    return relaxed_fma_result;
}

CPU.prototype.wasm_patch = function()
{
    const get_optional_import = name => this.wm.exports[name];

    const get_import = name =>
    {
        const f = get_optional_import(name);
        console.assert(f, "Missing import: " + name);
        return f;
    };
    // An address in the wasm memory, returned as an i32: above 2 GiB (a vCPU's
    // instance when guest RAM is large) it would read as negative
    const get_address_import = name =>
    {
        const f = get_import(name);
        return (...args) => f(...args) >>> 0;
    };

    this.reset_cpu = get_import("reset_cpu");

    this.getiopl = get_import("getiopl");
    this.get_eflags = get_import("get_eflags");

    this.handle_irqs = get_import("handle_irqs");

    const main_loop = get_import("main_loop");
    const run_cpu_slice = get_import("run_cpu_slice");
    this.main_loop = () => this.execute_cpu(() => main_loop());
    this.run_cpu_slice = budget => this.execute_cpu(() => run_cpu_slice(budget));

    this.read8 = get_import("read8");
    this.read16 = get_import("read16");
    this.read32s = get_import("read32s");
    this.write8 = get_import("write8");
    this.write16 = get_import("write16");
    this.write32 = get_import("write32");
    this.in_mapped_range = get_import("in_mapped_range");

    // used by nasmtests
    this.fpu_load_tag_word = get_import("fpu_load_tag_word");
    this.fpu_load_status_word = get_import("fpu_load_status_word");
    this.fpu_get_sti_f64 = get_import("fpu_get_sti_f64");

    this.translate_address_system_read = get_import("translate_address_system_read_js");

    this.get_seg_cs = get_import("get_seg_cs");
    this.get_real_eip = get_import("get_real_eip");

    this.clear_tlb = get_import("clear_tlb");
    this.full_clear_tlb = get_import("full_clear_tlb");

    this.apic_set_core_count = get_import("apic_set_core_count");
    this.apic_set_current_core = get_import("apic_set_current_core");
    this.apic_take_core_events = get_import("apic_take_core_events");
    this.apic_peek_core_events = get_import("apic_peek_core_events");
    this.apic_restore_core_events = get_import("apic_restore_core_events");
    this.apic_init_core = get_import("apic_init_core");
    this.apic_core_interrupt_pending = get_import("apic_core_interrupt_pending");
    this.apic_addr = get_address_import("apic_addr");
    this.apic_core_nmi_pending = get_import("apic_core_nmi_pending");
    this.apic_raise_smi = get_import("apic_raise_smi");
    this.apic_core_smi_pending = get_import("apic_core_smi_pending");
    this.apic_restore_smi = get_import("apic_restore_smi");
    this.update_state_flags = get_import("update_state_flags");

    this.set_tsc = get_import("set_tsc");
    this.store_current_tsc = get_import("store_current_tsc");

    this.set_cpuid_level = get_import("set_cpuid_level");

    this.device_raise_irq = get_import("device_raise_irq");
    this.device_lower_irq = get_import("device_lower_irq");
    // (IOAPIC inputs 16-23 of the Q35 PIRQs; missing in older builds)
    this.ioapic_raise_irq = get_optional_import("ioapic_raise_irq");
    this.ioapic_lower_irq = get_optional_import("ioapic_lower_irq");
    // (PCI message signalled interrupts; missing in older builds)
    this.apic_msi = get_optional_import("apic_msi");
    // (system management mode, src/rust/cpu/smm.rs; missing in older builds)
    this.smm_enter = get_optional_import("smm_enter");
    this.smm_active = get_optional_import("smm_active");
    this.smram_set_control = get_optional_import("smram_set_control");
    this.smram_set_tseg = get_optional_import("smram_set_tseg");

    this.apic_timer = get_import("apic_timer");

    this.jit_clear_cache = get_import("jit_clear_cache_js");
    this.jit_dirty_cache = get_import("jit_dirty_cache");

    this.allocate_memory = get_import("allocate_memory");
    this.zero_memory = get_import("zero_memory");
    this.is_memory_zeroed = get_import("is_memory_zeroed");

    // Device memory behind PCI memory BARs (src/rust/cpu/mmio_ram.rs)
    this.mmio_ram_allocate = get_import("mmio_ram_allocate");
    this.mmio_ram_backing = get_import("mmio_ram_backing");
    this.mmio_ram_map = get_import("mmio_ram_map");
    this.mmio_ram_unmap = get_import("mmio_ram_unmap");
    this.mmio_ram_read8 = get_import("mmio_ram_read8");
    this.mmio_ram_write8 = get_import("mmio_ram_write8");
    this.mmio_ram_mark_dirty = get_import("mmio_ram_mark_dirty");
    this.mmio_ram_take_dirty = get_import("mmio_ram_take_dirty");
    this.mmio_ram_allocate_pixels = get_import("mmio_ram_allocate_pixels");
    this.mmio_ram_fill_pixels = get_import("mmio_ram_fill_pixels");

    this.get_pic_addr_master = get_address_import("get_pic_addr_master");
    this.get_pic_addr_slave = get_address_import("get_pic_addr_slave");
    this.get_apic_addr = get_address_import("get_apic_addr");
    this.get_ioapic_addr = get_address_import("get_ioapic_addr");

    this.zstd_create_ctx = get_import("zstd_create_ctx");
    this.zstd_get_src_ptr = get_import("zstd_get_src_ptr");
    this.zstd_free_ctx = get_import("zstd_free_ctx");
    this.zstd_read = get_import("zstd_read");
    this.zstd_read_free = get_import("zstd_read_free");
};

CPU.prototype.jit_clear_func = function(index)
{
    dbg_assert(index >= 0 && index < WASM_TABLE_SIZE);
    this.wm.wasm_table.set(index + WASM_TABLE_OFFSET, null);
};

CPU.prototype.get_state = function(skip_memory = false)
{
    // Capture one machine time before collecting devices or per-core TSC offsets.
    const clock_state = this.clock.get_state();
    this.wm.exports["fpu_sync_all"]?.();
    var state = [];

    state[0] = this.memory_size[0];
    state[1] = new Uint8Array([...this.segment_is_null, ...this.segment_access_bytes]);
    state[2] = this.segment_offsets;
    state[3] = this.segment_limits;
    state[4] = this.protected_mode[0];
    state[5] = this.idtr_offset[0];
    state[6] = this.idtr_size[0];
    state[7] = this.gdtr_offset[0];
    state[8] = this.gdtr_size[0];
    // 9 (formerly page_fault)
    state[10] = this.cr;
    state[11] = this.cpl[0];

    state[13] = this.is_32[0];

    state[16] = this.stack_size_32[0];
    state[17] = this.in_hlt[0];
    state[18] = this.last_virt_eip[0];
    state[19] = this.eip_phys[0];

    state[22] = this.sysenter_cs[0];
    state[23] = this.sysenter_eip[0];
    state[24] = this.sysenter_esp[0];
    state[25] = this.prefixes[0];
    state[26] = this.flags[0];
    state[27] = this.flags_changed[0];
    state[28] = this.last_op1[0];

    state[30] = this.last_op_size[0];

    state[37] = this.instruction_pointer[0];
    state[38] = this.previous_ip[0];
    state[39] = this.reg32;
    state[40] = this.sreg;
    state[41] = this.dreg;
    state[42] = this.reg_pdpte;

    this.store_current_tsc();
    state[43] = this.current_tsc;

    state[45] = this.devices.virtio_9p;
    state[46] = this.get_state_apic();
    state[47] = this.devices.rtc;
    state[48] = this.devices.pci;
    state[49] = this.devices.dma;
    state[50] = this.devices.acpi;
    // 51 (formerly hpet)
    // the display adapter (nothing with graphics_adapter: "none")
    state[52] = this.devices.graphics_adapter;
    state[53] = this.devices.ps2;
    state[54] = this.devices.uart0;
    state[55] = this.devices.fdc;

    if(!this.devices.ide)
    {
        // (Q35: the drives are on the AHCI ports, state[101])
    }
    else if(!this.devices.ide.secondary)
    {
        if(this.devices.ide.primary?.master.is_atapi)
        {
            state[56] = this.devices.ide.primary;
        }
        else
        {
            state[57] = this.devices.ide.primary;
        }
    }
    else
    {
        state[85] = this.devices.ide;
    }

    state[58] = this.devices.pit;
    state[59] = this.devices.net;
    state[60] = this.get_state_pic();
    state[61] = this.devices.sb16;

    state[62] = this.fw_value;

    state[63] = this.get_state_ioapic();

    state[64] = this.tss_size_32[0];

    state[66] = this.reg_xmm32s;

    state[67] = this.fpu_st;
    state[68] = this.fpu_stack_empty[0];
    state[69] = this.fpu_stack_ptr[0];
    state[70] = this.fpu_control_word[0];
    state[71] = this.fpu_ip[0];
    state[72] = this.fpu_ip_selector[0];
    state[73] = this.fpu_dp[0];
    state[74] = this.fpu_dp_selector[0];
    state[75] = this.fpu_opcode[0];

    if(skip_memory) { state[77] = null; state[78] = null; }
    else
    {
        // (a single-buffer snapshot does not hold extended RAM: the stream
        // does; pages written only in their frames count too)
        if(this.extended_store)
        {
            this.flush_extended_memory();
            if(this.extended_store.touched.some(byte => byte !== 0))
            {
                throw new Error("A snapshot of extended RAM needs save_state_stream");
            }
        }
        const { packed_memory, bitmap } = this.pack_memory();
        state[77] = packed_memory;
        state[78] = new Uint8Array(bitmap.get_buffer());
    }

    state[79] = this.devices.uart1;
    state[80] = this.devices.uart2;
    state[81] = this.devices.uart3;
    state[82] = this.devices.virtio_console;
    state[83] = this.devices.virtio_net;
    state[84] = this.devices.virtio_balloon;

    // state[85] new ide set above

    state[86] = this.last_result;
    state[87] = this.fpu_status_word;
    state[88] = this.mxcsr;
    state[89] = this.devices.vmware;
    state[90] = this.devices.parallel0;
    state[91] = this.devices.parallel1;
    state[92] = get_virtio_devices_state(this.devices.virtio_devices);
    state[93] = this.shared_irq_sources.map(sources => Array.from(sources));
    state[94] = [this.apic_enabled[0],
        new Uint8Array(this.wasm_memory.buffer)[this.state_base + STATE_OFFSETS.nmi_blocked],
        +this.apic_core_nmi_pending(0), this.apic_peek_core_events(0)];

    state[95] = clock_state;
    state[96] = this.get_machine_core_state();
    state[97] = [1, this.get_physical_windows()];
    // extended RAM pages (its contents are records of the snapshot stream)
    state[98] = this.extended_pages;
    // the machine type and the version of its device layout
    // (99: the extended RAM bitmap of streamed snapshots, src/state.js)
    state[100] = this.devices.q35;
    state[101] = this.devices.ahci;
    state[102] = this.devices.hpet;
    state[103] = [this.platform.machine, MACHINE_LAYOUT_VERSION];
    state[104] = this.devices.smbus;
    // the root ports' hot plug slots
    state[105] = (this.devices.pcie_root_ports || []).map(port => port.get_state());
    // the CPU features (settings cpu_features, CPU_FEATURES)
    state[106] = this.cpu_features;
    return state;
};

/** A temporary host buffer never aliases guest RAM or survives its callback. */
CPU.prototype.with_wide_state_buffer = function(words, operation)
{
    const ex = this.wm.exports;
    // Above 2 GiB (large guest RAM), the i32 result reads as negative.
    const pointer = ex["v86_malloc"](Math.max(4, words.byteLength)) >>> 0;
    try
    {
        new Uint32Array(this.wasm_memory.buffer, pointer, words.length).set(words);
        return operation(pointer, words.length);
    }
    finally { ex["v86_free"](pointer); }
};

CPU.prototype.get_physical_windows = function()
{
    const words = new Uint32Array(80);
    for(let slot = 0; slot < 16; slot++) for(let field = 0; field < 5; field++)
        words[slot * 5 + field] = this.wm.exports["x64_phys_get_window"](slot, field);
    return words;
};

CPU.prototype.get_wide_tlb = function(id)
{
    const ex = this.wm.exports;
    const words = new Uint32Array(ex["x64_tlb_snapshot_dwords"](id));
    this.with_wide_state_buffer(words, (pointer, count) => {
        if(ex["x64_tlb_snapshot_write"](id, pointer, count) !== count) throw new Error("Cannot capture wide TLB");
        words.set(new Uint32Array(this.wasm_memory.buffer, pointer, count));
    });
    return words;
};

CPU.prototype.validate_physical_state = function(state)
{
    if(state === undefined) return;
    if(!Array.isArray(state) || state[0] !== 1 || !(state[1] instanceof Uint32Array) || state[1].length !== 80 ||
        !this.with_wide_state_buffer(state[1], (pointer, count) => this.wm.exports["x64_phys_validate_windows"](pointer, count)))
        throw new Error("Invalid physical memory map in snapshot");
};

/**
 * The features cpu_type "x86_64" has when cpu_features is not given: every
 * released one of its profile (the owner's decision of 2026-10-17, which
 * replaced docs/simd-xsave-plan.md Q1's "the old CPU unless asked")
 */
const X86_64_DEFAULT_FEATURES = Object.keys(CPU_FEATURES).filter(name =>
    CPU_FEATURES[name]["released"] && CPU_FEATURES[name]["profiles"].includes("x86_64"));

/**
 * The feature set (src/rust/cpu/features.rs) of the setting cpu_features: an
 * array of the names of src/cpu_features.js, or the name of a preset; not
 * given, every released feature for x86_64 and none for x86 ([]: none). A
 * feature that cpuid_level cannot report is left out, with the features that
 * require it (docs/simd-xsave-plan.md 6.1); an unknown feature, one the CPU
 * profile cannot have or one without its requirements is an error.
 * @param {Array<string>|string|undefined} requested
 * @param {boolean} x86_64
 * @param {number} cpuid_level
 * @return {number}
 */
export function resolve_cpu_features(requested, x86_64, cpuid_level)
{
    if(requested === undefined)
    {
        if(!x86_64) return 0;
        requested = X86_64_DEFAULT_FEATURES;
    }
    const names = typeof requested === "string" ? CPU_FEATURE_PRESETS[requested] : requested;
    if(!Array.isArray(names))
    {
        throw new Error("cpu_features: unknown preset " + JSON.stringify(requested));
    }
    const profile = x86_64 ? "x86_64" : "x86";
    for(const name of names)
    {
        const feature = CPU_FEATURES[name];
        if(!feature) throw new Error("cpu_features: unknown feature " + JSON.stringify(name));
        if(!feature["profiles"].includes(profile)) throw new Error("cpu_features: " + name + " needs cpu_type: \"x86_64\"");
        for(const required of feature["requires"])
        {
            if(!names.includes(required)) throw new Error("cpu_features: " + name + " requires " + required);
        }
    }
    let kept = names.filter(name => CPU_FEATURES[name]["min_cpuid_level"] <= cpuid_level);
    for(let count = -1; count !== kept.length;)
    {
        count = kept.length;
        kept = kept.filter(name => CPU_FEATURES[name]["requires"].every(required => kept.includes(required)));
    }
    return kept.reduce((set, name) => set | 1 << CPU_FEATURES[name]["bit"], 0);
}

/**
 * The features of the setting cpu_features whose milestone is not released
 * yet (docs/simd-xsave-plan.md 4.1): they are for tests and development, and
 * their instructions may still be #UD
 * @param {Array<string>|string|undefined} requested
 * @return {Array<string>}
 */
export function unreleased_cpu_features(requested)
{
    const names = typeof requested === "string" ? CPU_FEATURE_PRESETS[requested] || [] : requested || [];
    return names.filter(name => CPU_FEATURES[name] && !CPU_FEATURES[name]["released"]);
}

// Version 1 predates the x64 extension banks. Keep exact byte ranges for import.
const CORE_STATE_RANGES_V1 = [[64, 108], [112, 552], [556, 620], [628, 652], [668, 716],
    [724, 812], [816, 960], [968, 1132], [1152, 1280]];

/** All cores at a scheduler boundary; versioned independently of legacy single-core slots. */
CPU.prototype.get_machine_core_state = function()
{
    const ex = this.wm.exports;
    ex["context_capture"]();
    const cores = this.cores.map((core, id) => {
        const tlb = new Uint32Array(ex["context_tlb_len"](id) * 2);
        for(let i = 0; i < tlb.length; i++) tlb[i] = ex["context_tlb_get"](id, i >> 1, i & 1);
        return [core.running, id === this.active_core ? this.save_core_state() : core.saved,
            new Uint8Array(this.wasm_memory.buffer, this.apic_addr(id), 184).slice(),
            new Uint8Array(this.wasm_memory.buffer, ex["apic_aux_addr"](id) >>> 0, ex["apic_aux_size"]()).slice(),
            this.apic_peek_core_events(id), !!this.apic_core_nmi_pending(id),
            [ex["context_tsc_get"](id, false) >>> 0, ex["context_tsc_get"](id, true) >>> 0],
            tlb, core.slices, core.steps,
            new Uint8Array(this.wasm_memory.buffer, ex["core_statistics_addr"](id) >>> 0, ex["core_statistics_size"]()).slice(), ex["exception_shutdown"](id), this.get_wide_tlb(id),
            !!this.apic_core_smi_pending(id)];
    });
    return [2, this.cores.length, this.active_core, this.scheduler_quantum,
        this.scheduler_seed, this.scheduler_round, cores, CORE_STATE_RANGES.map(range => range.slice())];
};

CPU.prototype.validate_machine_core_state = function(state)
{
    if(!state)
    {
        if(this.cores.length !== 1) throw new Error("Snapshot topology mismatch: legacy snapshot has one core");
        return;
    }
    const fail = () => { throw new Error("Invalid multicore snapshot or topology mismatch"); };
    // Version 2 lists its ranges; a snapshot from before a range was added
    // restores that range to its reset value (set_machine_core_state)
    if(state[0] === 2 && !(Array.isArray(state[7]) && state[7].every(range => Array.isArray(range) &&
        CORE_STATE_RANGES.some(([start, end]) => range[0] === start && range[1] === end)))) fail();
    const ranges = state[0] === 1 ? CORE_STATE_RANGES_V1 : state[7];
    if(state[0] !== 1 && state[0] !== 2 || state[1] !== this.cores.length || !Array.isArray(state[6]) || state[6].length !== state[1] ||
        !Number.isInteger(state[2]) || state[2] < 0 || state[2] >= state[1] ||
        !Number.isInteger(state[3]) || state[3] < 1 || state[3] > 100000 ||
        !Number.isSafeInteger(state[4]) || state[4] < 0 || state[4] > 0xFFFFFFFF ||
        !Number.isSafeInteger(state[5]) || state[5] < 0) fail();
    for(const core of state[6])
    {
        if(!Array.isArray(core) || typeof core[0] !== "boolean" || !Array.isArray(core[1]) ||
            core[1].length !== ranges.length || !(core[2] instanceof Uint8Array) || core[2].length !== 184 ||
            !(core[3] instanceof Uint8Array) || core[3].length !== this.wm.exports["apic_aux_size"]() ||
            !Array.isArray(core[6]) || core[6].length !== 2 ||
            core[11] !== undefined && (!Number.isInteger(core[11]) || core[11] < 0 || core[11] > 2) ||
            core[10] !== undefined && (!(core[10] instanceof Uint8Array) || core[10].length !== this.wm.exports["core_statistics_size"]()) ||
            !(core[7] instanceof Uint32Array) || core[7].length % 2 || core[7].length > 20000) fail();
        ranges.forEach(([start, end], i) => {
            if(!(core[1][i] instanceof Uint8Array) || core[1][i].length !== end - start) fail();
        });
        if(core[12] !== undefined && (!(core[12] instanceof Uint32Array) || core[12].length > 256 * 18 ||
            !this.with_wide_state_buffer(core[12], (pointer, count) => this.wm.exports["x64_tlb_snapshot_validate"](pointer, count)))) fail();
        const pages = new Set();
        for(let i = 0; i < core[7].length; i += 2)
        {
            if(core[7][i] >= 0x100000 || !(core[7][i + 1] & 1) || pages.has(core[7][i])) fail();
            pages.add(core[7][i]);
        }
    }
};

CPU.prototype.set_machine_core_state = function(state)
{
    const ex = this.wm.exports;
    ex["context_reset_all"]();
    ex["core_statistics_reset"]();
    state[6].forEach((saved, id) => {
        const ranges = state[0] === 1 ? CORE_STATE_RANGES_V1 : state[7];
        const fixed = CORE_STATE_RANGES.map(([start, end]) => {
            const index = ranges.findIndex(range => range[0] === start && range[1] === end);
            if(index !== -1) return saved[1][index].slice();
            const bytes = new Uint8Array(end - start);
            if(start <= STATE_OFFSETS.x64_pat && end >= STATE_OFFSETS.x64_pat + 8)
            {
                const view = new DataView(bytes.buffer);
                view.setUint32(STATE_OFFSETS.x64_pat - start, 0x00070406, true);
                view.setUint32(STATE_OFFSETS.x64_pat - start + 4, 0x00070406, true);
            }
            if(start <= STATE_OFFSETS.smbase && end >= STATE_OFFSETS.smbase + 4)
            {
                // (SMBASE's reset value)
                new DataView(bytes.buffer).setUint32(STATE_OFFSETS.smbase - start, 0x30000, true);
            }
            if(start <= STATE_OFFSETS.xcr0 && end >= STATE_OFFSETS.xcr0 + 8)
            {
                // (XCR0's reset value: x87 state only)
                new DataView(bytes.buffer).setUint32(STATE_OFFSETS.xcr0 - start, 1, true);
            }
            return bytes;
        });
        this.cores[id] = { running: saved[0], saved: fixed, slices: saved[8], steps: saved[9] };
        new Uint8Array(this.wasm_memory.buffer, this.apic_addr(id), 184).set(saved[2]);
        new Uint8Array(this.wasm_memory.buffer, ex["apic_aux_addr"](id) >>> 0, ex["apic_aux_size"]()).set(saved[3]);
        this.apic_restore_core_events(id, saved[4], saved[5]);
        this.apic_restore_smi(id, !!saved[13]);
        ex["exception_restore"](id, saved[11] || 0);
        ex["context_tsc_set"](id, saved[6][0], saved[6][1]);
        if(saved[10]) new Uint8Array(this.wasm_memory.buffer, ex["core_statistics_addr"](id) >>> 0, ex["core_statistics_size"]()).set(saved[10]);
        for(let i = 0; i < saved[7].length; i += 2) ex["context_tlb_push"](id, saved[7][i], saved[7][i + 1]);
        if(saved[12]) this.with_wide_state_buffer(saved[12], (pointer, count) => {
            if(!ex["x64_tlb_snapshot_restore"](id, pointer, count)) throw new Error("Cannot restore wide TLB");
        });
    });
    this.active_core = state[2];
    this.apic_set_current_core(this.active_core);
    this.load_core_state(/** @type {!Array<!Uint8Array>} */ (this.cores[this.active_core].saved), true);
    this.cores[this.active_core].saved = null;
    ex["context_install"](this.active_core);
    this.scheduler_quantum = state[3];
    this.scheduler_seed = state[4];
    this.scheduler_round = state[5];
};

CPU.prototype.get_state_pic = function()
{
    const pic_size = 13;
    const pic = new Uint8Array(this.wasm_memory.buffer, this.get_pic_addr_master(), pic_size);
    const pic_slave = new Uint8Array(this.wasm_memory.buffer, this.get_pic_addr_slave(), pic_size);

    const state = [];
    const state_slave = [];

    state[0] = pic[0]; // irq_mask
    state[1] = pic[1]; // irq_map
    state[2] = pic[2]; // isr
    state[3] = pic[3]; // irr
    state[4] = pic[4]; // is_master
    state[5] = state_slave;
    state[6] = pic[6]; // expect_icw4
    state[7] = pic[7]; // state
    state[8] = pic[8]; // read_isr
    state[9] = pic[9]; // auto_eoi
    state[10] = pic[10]; // elcr
    state[11] = pic[11]; // irq_value
    state[12] = pic[12]; // special_mask_mode

    state_slave[0] = pic_slave[0]; // irq_mask
    state_slave[1] = pic_slave[1]; // irq_map
    state_slave[2] = pic_slave[2]; // isr
    state_slave[3] = pic_slave[3]; // irr
    state_slave[4] = pic_slave[4]; // is_master
    state_slave[5] = null;
    state_slave[6] = pic_slave[6]; // expect_icw4
    state_slave[7] = pic_slave[7]; // state
    state_slave[8] = pic_slave[8]; // read_isr
    state_slave[9] = pic_slave[9]; // auto_eoi
    state_slave[10] = pic_slave[10]; // elcr
    state_slave[11] = pic_slave[11]; // irq_value
    state_slave[12] = pic_slave[12]; // special_mask_mode

    return state;
};

CPU.prototype.get_state_apic = function()
{
    const APIC_STRUCT_SIZE = 4 * 46; // keep in sync with apic.rs
    return new Uint8Array(this.wasm_memory.buffer, this.get_apic_addr(), APIC_STRUCT_SIZE);
};

CPU.prototype.get_state_ioapic = function()
{
    const IOAPIC_STRUCT_SIZE = 4 * 52; // keep in sync with ioapic.rs
    return new Uint8Array(this.wasm_memory.buffer, this.get_ioapic_addr(), IOAPIC_STRUCT_SIZE);
};

CPU.prototype.validate_state = function(state)
{
    // (snapshots from before machine_type are of i440FX machines)
    const machine = state[103] ? state[103][0] : "i440fx";
    if(machine !== this.platform.machine)
    {
        throw new Error("The snapshot is from a machine with machine_type: \"" + machine +
            "\", this one has \"" + this.platform.machine + "\"");
    }
    this.validate_machine_core_state(state[96]);
    this.validate_physical_state(state[97]);
    this.validate_disk_states(state);
    resolve_virtio_devices_state(this.devices.virtio_devices, state[92]);
    if(this.devices.graphics_adapter)
    {
        this.devices.graphics_adapter.check_state(state[52]);
    }
    else if(this.devices.display && graphics_adapter_of_state(state[52]) !== "none")
    {
        throw new Error("The snapshot is from a machine with graphics_adapter: \"" +
            graphics_adapter_of_state(state[52]) + "\", this one has \"none\"");
    }
    // A remapped snapshot must retain the RAM/MMIO split used when validating
    // its windows. Reject this before changing clocks, RAM, or CPU state.
    if(state[97] && state[0] !== this.memory_size[0] &&
        state[97][1].some((word, index) => index % 5 === 4 && word !== 0))
        throw new Error("Snapshot RAM size differs from its physical memory map");
    if(!Number.isSafeInteger(state[0]) || state[0] <= 0 || state[0] > this.mem8.length || state[0] % 4096)
        throw new Error("Invalid snapshot RAM size");
    if((state[98] || 0) !== this.extended_pages)
        throw new Error("Snapshot extended RAM size differs from this machine's");
    // The guest has seen these in CPUID and may use them (snapshots from
    // before them have none): a machine whose features were not chosen
    // (cpu_features not given) takes the snapshot's, set_state
    const features = state[106] || 0;
    if(features !== this.cpu_features && this.cpu_features_explicit)
    {
        const names = mask => Object.keys(CPU_FEATURES).filter(name => mask & 1 << CPU_FEATURES[name].bit).join(" ") || "none";
        throw new Error("The snapshot is from a machine with the CPU features " + names(features) +
            " (cpu_features), this one has " + names(this.cpu_features));
    }
};

/**
 * A snapshot's hard disks must be the images this machine has: the changes
 * of a disk image in a container format are not applied to another image
 * (docs/disk-image-formats-plan.md P1). Checked before anything is restored.
 * @param {!Array<*>} state
 */
CPU.prototype.validate_disk_states = function(state)
{
    // (and a disk written back takes only a reference of its image in the
    // same generation: src/disk_writeback.js)
    const check = (device, saved) =>
    {
        if(!device || !device.buffer || !saved) return;
        // (a hard disk's logical sectors, IDEInterface state 20: its LBAs
        // and the guest's view of it are in them)
        if(!device.is_atapi && !saved[13] && saved[20] !== undefined && saved[20] !== device.sector_size)
        {
            throw new Error("The snapshot's disk " + device.name + " has " + saved[20] + "-byte sectors, this machine's " +
                device.sector_size + "-byte ones: its state cannot be restored onto it");
        }
        check_disk_state(device.buffer.disk_name || device.name, device.buffer, saved[28]);
    };
    const ide = this.devices.ide;
    if(ide)
    {
        const saved = state[85] || [state[56] || state[57]];
        [ide.primary, ide.secondary].forEach((channel, i) =>
        {
            if(!channel || !saved[i]) return;
            check(channel.master, saved[i][0]);
            check(channel.slave, saved[i][1]);
        });
    }
    const ahci = this.devices.ahci;
    if(ahci && state[101])
    {
        ahci.ports.forEach((port, i) => check(port.device, state[101][3][i] && state[101][3][i][17]));
    }
    // (the floppy drives' disks: written back, a reference)
    const fdc = this.devices.fdc;
    if(fdc && state[55])
    {
        fdc.drives.forEach((drive, i) =>
        {
            const saved = state[55][44 + i];
            if(!saved) return;
            if(drive.buffer) check_disk_state(drive.buffer.disk_name || (i ? "fdb" : "fda"), drive.buffer, saved[10]);
            else if(is_writeback_state(saved[10])) throw new Error("The snapshot's floppy " + (i ? "fdb" : "fda") + " was written back; this machine has no disk in that drive");
        });
    }
};

CPU.prototype.set_state = function(state, skip_memory = false)
{
    this.validate_state(state);
    // (disk requests held after an I/O error belong to the machine left behind)
    drop_disk_holds(this);
    // (the snapshot's CPU features, where this machine's were the default)
    if((state[106] || 0) !== this.cpu_features)
    {
        this.cpu_features = state[106] || 0;
        this.wm.exports["set_cpu_features"](this.cpu_features);
    }
    if(state[95]) this.clock.set_state(state[95]);
    this.wm.exports["take_clock_progress"]();
    this.wm.exports["set_deterministic_execution"](this.clock.mode === "deterministic");
    this.execution_epoch++;
    this.wm.exports["fpu_discard_cache"]?.();
    this.memory_size[0] = state[0];

    if(this.mem8.length !== this.memory_size[0])
    {
        console.warn("Note: Memory size mismatch. we=" + this.mem8.length + " state=" + this.memory_size[0]);
    }

    if(state[1].length === 8)
    {
        // NOTE: support for old state images; delete this when bumping STATE_VERSION
        this.segment_is_null.set(state[1]);
        this.segment_access_bytes.fill(0x80 | (3 << 5) | 0x10 | 0x02);
        this.segment_access_bytes[REG_CS] = 0x80 | (3 << 5) | 0x10 | 0x08 | 0x02;
    }
    else if(state[1].length === 16)
    {
        this.segment_is_null.set(state[1].subarray(0, 8));
        this.segment_access_bytes.set(state[1].subarray(8, 16));
    }
    else
    {
        dbg_assert("Unexpected cpu segment state length:" + state[1].length);
    }
    this.segment_offsets.set(state[2]);
    this.segment_limits.set(state[3]);

    this.protected_mode[0] = state[4];
    this.idtr_offset[0] = state[5];
    this.idtr_size[0] = state[6];
    this.gdtr_offset[0] = state[7];
    this.gdtr_size[0] = state[8];
    this.cr.set(state[10]);
    this.cpl[0] = state[11];

    this.is_32[0] = state[13];

    this.stack_size_32[0] = state[16];

    this.in_hlt[0] = state[17];
    this.last_virt_eip[0] = state[18];
    this.eip_phys[0] = state[19];

    this.sysenter_cs[0] = state[22];
    this.sysenter_eip[0] = state[23];
    this.sysenter_esp[0] = state[24];
    this.prefixes[0] = state[25];

    this.flags[0] = state[26];
    this.flags_changed[0] = state[27];
    this.last_op1[0] = state[28];

    this.last_op_size[0] = state[30];

    this.instruction_pointer[0] = state[37];
    this.previous_ip[0] = state[38];
    this.reg32.set(state[39]);
    this.sreg.set(state[40]);
    this.dreg.set(state[41]);
    state[42] && this.reg_pdpte.set(state[42]);

    this.set_tsc(state[43][0], state[43][1]);

    this.devices.virtio_9p && this.devices.virtio_9p.set_state(state[45]);
    state[46] && this.set_state_apic(state[46]);
    this.devices.rtc && this.devices.rtc.set_state(state[47]);
    this.devices.dma && this.devices.dma.set_state(state[49]);
    this.devices.acpi && this.devices.acpi.set_state(state[50]);
    // 51 (formerly hpet)
    this.devices.graphics_adapter && this.devices.graphics_adapter.set_state(state[52]);
    this.devices.ps2 && this.devices.ps2.set_state(state[53]);
    this.devices.uart0 && this.devices.uart0.set_state(state[54]);
    this.devices.fdc && this.devices.fdc.set_state(state[55]);

    if((state[56] || state[57]) && this.devices.ide)
    {
        // ide device from older version of v86, only primary: state[56] contains cdrom, state[57] contains hard drive

        const ide_config = [[undefined, undefined], [undefined, undefined]];
        if(state[56])
        {
            ide_config[0][0] = { is_cdrom: true, buffer: this.devices.cdrom.buffer };
        }
        else
        {
            ide_config[0][0] = { is_cdrom: false, buffer: this.devices.ide.primary.master.buffer };

        }
        this.devices.ide = new IDEController(this, this.devices.ide.bus, ide_config);
        this.devices.cdrom = state[56] ? this.devices.ide.primary.master : undefined;
        this.devices.ide.primary.set_state(state[56] || state[57]);
    }
    else if(state[85] && this.devices.ide)
    {
        this.devices.ide.set_state(state[85]);
    }

    this.devices.q35 && state[100] && this.devices.q35.set_state(state[100]);
    this.devices.ahci && state[101] && this.devices.ahci.set_state(state[101]);
    this.devices.hpet && state[102] && this.devices.hpet.set_state(state[102]);
    this.devices.smbus && state[104] && this.devices.smbus.set_state(state[104]);
    this.devices.pci && this.devices.pci.set_state(state[48]);
    // (after the root ports' registers: snapshots from before hot plug have
    // every card in)
    (this.devices.pcie_root_ports || []).forEach((port, i) => {
        port.set_state(state[105] && state[105][i] || [1, port.has_card(), false, false]);
    });

    this.devices.pit && this.devices.pit.set_state(state[58]);
    this.devices.net && this.devices.net.set_state(state[59]);
    this.set_state_pic(state[60]);
    this.devices.sb16 && this.devices.sb16.set_state(state[61]);

    this.devices.uart1 && this.devices.uart1.set_state(state[79]);
    this.devices.uart2 && this.devices.uart2.set_state(state[80]);
    this.devices.uart3 && this.devices.uart3.set_state(state[81]);
    this.devices.virtio_console && this.devices.virtio_console.set_state(state[82]);
    this.devices.virtio_net && this.devices.virtio_net.set_state(state[83]);
    this.devices.virtio_balloon && this.devices.virtio_balloon.set_state(state[84]);
    this.devices.vmware && state[89] && this.devices.vmware.set_state(state[89]);
    this.devices.parallel0 && state[90] && this.devices.parallel0.set_state(state[90]);
    this.devices.parallel1 && state[91] && this.devices.parallel1.set_state(state[91]);
    set_virtio_devices_state(this.devices.virtio_devices,
        resolve_virtio_devices_state(this.devices.virtio_devices, state[92]));

    this.fw_value = state[62];

    state[63] && this.set_state_ioapic(state[63]);

    this.tss_size_32[0] = state[64];

    this.reg_xmm32s.set(state[66]);

    this.fpu_st.set(state[67]);
    this.fpu_stack_empty[0] = state[68];
    this.fpu_stack_ptr[0] = state[69];
    this.fpu_control_word[0] = state[70];
    this.fpu_ip[0] = state[71];
    this.fpu_ip_selector[0] = state[72];
    this.fpu_dp[0] = state[73];
    this.fpu_dp_selector[0] = state[74];
    this.fpu_opcode[0] = state[75];

    // (into the views of the Wasm memory, which must not be replaced)
    if(state[86] !== undefined) this.last_result[0] = state[86][0];
    if(state[87] !== undefined) this.fpu_status_word[0] = state[87][0];
    if(state[88] !== undefined) this.mxcsr[0] = state[88][0];

    if(!skip_memory)
    {
        const bitmap = new Bitmap(state[78].buffer);
        this.unpack_memory(bitmap, state[77]);
        this.clear_extended_memory();
    }

    this.update_state_flags();

    this.full_clear_tlb();

    this.jit_clear_cache();
    this.with_wide_state_buffer(state[97] ? state[97][1] : new Uint32Array(80), (pointer, count) => {
        if(!this.wm.exports["x64_phys_restore_windows"](pointer, count)) throw new Error("Cannot restore physical memory map");
    });
    // configure_high_memory uses slot 0 for the relocated top of RAM
    this.low_memory_size = this.wm.exports["x64_phys_get_window"](0, 4) === 1 &&
        this.wm.exports["x64_phys_get_window"](0, 2) + this.wm.exports["x64_phys_get_window"](0, 3) === this.memory_size[0] ?
        this.wm.exports["x64_phys_get_window"](0, 2) : this.memory_size[0];

    // Older single-core snapshots predate NMI state and APIC enable storage.
    this.apic_enabled[0] = state[94] ? state[94][0] : this.acpi_enabled[0];
    new Uint8Array(this.wasm_memory.buffer)[this.state_base + STATE_OFFSETS.nmi_blocked] = state[94]?.[1] || 0;
    this.apic_restore_core_events(0, state[94]?.[3] || 0, !!state[94]?.[2]);
    this.apic_restore_smi(0, false);
    this.wm.exports["apic_restore_legacy_aux"](0, !!this.apic_enabled[0]);
    new Uint8Array(this.wasm_memory.buffer)[this.state_base + STATE_OFFSETS.interrupt_shadow] = 0;
    if(state[96]) this.set_machine_core_state(state[96]);
    else
    {
        this.wm.exports["core_statistics_reset"]();
        const bytes = new Uint8Array(this.wasm_memory.buffer);
        for(const [start, end] of CORE_STATE_RANGES) if(start >= 1360) bytes.fill(0, this.state_base + start, this.state_base + end);
        new Uint32Array(this.wasm_memory.buffer, this.state_base + STATE_OFFSETS.x64_pat, 2).fill(0x00070406);
        new Uint32Array(this.wasm_memory.buffer, this.state_base + STATE_OFFSETS.smbase, 1)[0] = 0x30000;
        new Uint32Array(this.wasm_memory.buffer, this.state_base + STATE_OFFSETS.xcr0, 2).set([1, 0]);
        this.with_wide_state_buffer(new Uint32Array(0), (pointer, count) => this.wm.exports["x64_tlb_snapshot_restore"](0, pointer, count));
        this.wm.exports["exception_restore"](0, 0);
        this.cores[0].slices = this.cores[0].steps = 0;
    }
    if(!state[95])
    {
        // Legacy snapshots stored host-absolute deadlines without a shared
        // clock anchor. Preserve counts/calendar and restart their phase at
        // restore time, rather than waiting for the old host's uptime.
        const now = this.clock.now();
        this.devices.pit.counter_start_time.fill(now);
        new Float64Array(this.wasm_memory.buffer, this.apic_addr(0) + 24, 1)[0] = now;
        this.clock.wall_epoch_ms = this.devices.rtc.rtc_time - now;
    }

    // Older state images don't record the sources; devices then lower their
    // lines unconditionally, as they used to. Done last: re-deriving the SCI
    // may deliver an interrupt, which needs the complete machine state.
    this.shared_irq_sources.forEach((sources, irq) => {
        sources.clear();
        state[93]?.[irq]?.forEach(source => sources.add(source));
    });
    this.devices.acpi && this.devices.acpi.sync_sci();
    // (a drive present in the snapshot or in this machine only is a hot
    // plug event for the restored guest)
    this.devices.ahci && this.devices.ahci.update_irq();
};

CPU.prototype.set_state_pic = function(state)
{
    // Note: This could exists for compatibility with old state images
    // It should be deleted when the state version changes

    const pic_size = 13;
    const pic = new Uint8Array(this.wasm_memory.buffer, this.get_pic_addr_master(), pic_size);
    const pic_slave = new Uint8Array(this.wasm_memory.buffer, this.get_pic_addr_slave(), pic_size);

    pic[0] = state[0]; // irq_mask
    pic[1] = state[1]; // irq_map
    pic[2] = state[2]; // isr
    pic[3] = state[3]; // irr
    pic[4] = state[4]; // is_master
    const state_slave = state[5];
    pic[6] = state[6]; // expect_icw4
    pic[7] = state[7]; // state
    pic[8] = state[8]; // read_isr
    pic[9] = state[9]; // auto_eoi
    pic[10] = state[10]; // elcr
    pic[11] = state[11]; // irq_value (undefined in old state images)
    pic[12] = state[12]; // special_mask_mode (undefined in old state images)

    pic_slave[0] = state_slave[0]; // irq_mask
    pic_slave[1] = state_slave[1]; // irq_map
    pic_slave[2] = state_slave[2]; // isr
    pic_slave[3] = state_slave[3]; // irr
    pic_slave[4] = state_slave[4]; // is_master
    // dummy
    pic_slave[6] = state_slave[6]; // expect_icw4
    pic_slave[7] = state_slave[7]; // state
    pic_slave[8] = state_slave[8]; // read_isr
    pic_slave[9] = state_slave[9]; // auto_eoi
    pic_slave[10] = state_slave[10]; // elcr
    pic_slave[11] = state_slave[11]; // irq_value (undefined in old state images)
    pic_slave[12] = state_slave[12]; // special_mask_mode (undefined in old state images)
};

// keep in sync with apic.rs
const CORE_EVENT_INIT = 1;
const CORE_EVENT_SIPI = 2;

/**
 * Cores of a single-socket machine (docs/multicore.md).
 * They run one at a time on this Wasm instance: the scheduler
 * (run_cores) switches the active core at main-loop boundaries with
 * save_core_state/load_core_state; each core has its own local APIC.
 */
CPU.prototype.setup_cores = function()
{
    const count = this.platform.cores;
    this.apic_set_core_count(count);
    this.wm.exports["context_reset_all"]();
    this.wm.exports["core_statistics_reset"]();
    this.core_reset_state = this.save_core_state();
    this.active_core = 0;
    // the BSP runs from reset; the APs wait for INIT and a start-up IPI
    this.cores = Array.from({ length: count }, (_, i) => ({ running: i === 0, saved: i === 0 ? null : this.core_reset_state,
        slices: 0, steps: 0 }));
};

/** Machine reset: the BSP becomes the active core and the APs wait for a start-up IPI again */
CPU.prototype.reset_cores = function()
{
    this.switch_core(0);
    this.apic_set_core_count(this.cores.length);
    this.wm.exports["context_reset_all"]();
    this.wm.exports["core_statistics_reset"]();
    this.execution_epoch++;
    this.scheduler_round = 0;
    this.cores.forEach((core, i) => {
        core.running = i === 0;
        core.saved = i === 0 ? null : this.core_reset_state;
        core.slices = 0;
        core.steps = 0;
    });
};

/** @param {number} core */
CPU.prototype.switch_core = function(core)
{
    if(core === this.active_core)
    {
        return;
    }
    this.cores[this.active_core].saved = this.save_core_state();
    this.wm.exports["context_switch"](this.active_core, core);
    this.load_core_state(/** @type {!Array<!Uint8Array>} */ (this.cores[core].saved), true);
    this.cores[core].saved = null;
    this.active_core = core;
    this.apic_set_current_core(core);
};

/**
 * INIT and start-up IPIs sent to a core since it was last scheduled
 * @param {number} core
 */
CPU.prototype.take_core_events = function(core)
{
    const events = this.apic_take_core_events(core);
    if(!events)
    {
        return;
    }
    const state = this.cores[core];

    if(events & CORE_EVENT_INIT)
    {
        if(this.wm.exports["exception_shutdown"](core) === 2) return;
        dbg_log("core " + core + ": INIT", LOG_CPU);
        this.apic_init_core(core);
        this.wm.exports["context_reset"](core);
        // INIT leaves the x87, SSE and XSAVE state, the PAT, the MTRRs, the
        // machine-check banks and SMBASE alone (SDM Vol.3A, "Processor States
        // Following Power-up, Reset, or INIT"; INIT_PRESERVED); everything
        // else takes its reset value
        const next = this.core_reset_state.map(bytes => bytes.slice());
        const current = core === this.active_core ? this.save_core_state() : state.saved;
        if(current) for(const [offset, size] of INIT_PRESERVED)
        {
            const index = CORE_STATE_RANGES.findIndex(([start, end]) => offset >= start && offset + size <= end);
            const at = offset - CORE_STATE_RANGES[index][0];
            next[index].set(current[index].subarray(at, at + size), at);
        }
        if(core === this.active_core)
        {
            this.load_core_state(next);
        }
        else
        {
            state.saved = next;
        }
        // an AP waits for a start-up IPI; the BSP restarts at the reset vector
        state.running = core === 0;
    }

    if((events & CORE_EVENT_SIPI) && !state.running)
    {
        // real mode at vector * 0x1000
        const vector = events >> 8 & 0xFF;
        dbg_log("core " + core + ": start-up IPI, vector " + h(vector, 2), LOG_CPU);
        this.switch_core(core);
        this.sreg[REG_CS] = vector << 8;
        this.segment_offsets[REG_CS] = vector << 12;
        this.instruction_pointer[0] = vector << 12;
        this.previous_ip[0] = vector << 12;
        this.update_state_flags();
        state.running = true;
    }
};

/**
 * Whether a core that is not the active one can make progress: it is not
 * halted, or it is halted with interrupts enabled and one pending
 * @param {number} core
 */
CPU.prototype.core_runnable = function(core)
{
    const state = this.cores[core];
    if(!state.running)
    {
        return false;
    }
    // Read a field of the live or saved core without switching it in.
    const field = (offset, size) => {
        if(core === this.active_core)
        {
            const view = new DataView(this.wasm_memory.buffer, this.state_base + offset, size);
            return size === 1 ? view.getUint8(0) : view.getInt32(0, true);
        }
        const index = CORE_STATE_RANGES.findIndex(([start, end]) => offset >= start && offset + size <= end);
        dbg_assert(index !== -1);
        const view = new DataView(state.saved[index].buffer, offset - CORE_STATE_RANGES[index][0], size);
        return size === 1 ? view.getUint8(0) : view.getInt32(0, true);
    };
    const nmi = !!this.apic_core_nmi_pending(core) && !field(STATE_OFFSETS.nmi_blocked, 1);
    // (an SMI waits while the core is in SMM: smm_state bit 0)
    const smi = !!this.apic_core_smi_pending(core) && !(field(STATE_OFFSETS.smm_state, 4) & 1);
    const shutdown = this.wm.exports["exception_shutdown"](core);
    if(shutdown) return shutdown === 1 && (nmi || smi);
    const halted = field(STATE_OFFSETS.in_hlt, 1) !== 0;
    if(!halted)
    {
        return true;
    }
    const interrupts_enabled = (field(STATE_OFFSETS.flags, 4) & FLAG_INTERRUPT) !== 0;
    // The BSP also accepts the legacy PIC, which is checked in run_cpu_slice.
    return nmi || smi || interrupts_enabled && this.apic_core_interrupt_pending(core);
};

/**
 * Run each core for a bounded slice, rotating or seeded round robin. Dispatch
 * budgets bound host work; deterministic time separately counts committed work.
 * @return {number} milliseconds until the machine needs to run again
 */
/**
 * Whether the guest turned the machine off (ACPI S5 or S4): the machine's
 * power hook (src/main.js; docs/arm64-virt-android16-plan.md P1.8)
 * @return {boolean}
 */
CPU.prototype.powered_off = function()
{
    return !!this.devices?.acpi?.soft_off;
};

CPU.prototype.run_cores = function()
{
    if(this.parallel)
    {
        return this.run_parallel();
    }
    if(this.devices.acpi?.sleeping)
    {
        // S3: no core runs; the device timers do (an RTC alarm may wake us)
        const now = this.clock.now();
        const next = this.run_hardware_timers(!!this.acpi_enabled[0], now);
        if(!this.devices.acpi.sleeping) return 0;
        if(this.clock.mode === "deterministic")
        {
            this.clock.advance_to(Math.max(this.clock.now(), now + Math.min(next, 100)));
            return 0;
        }
        return Math.min(next, 100);
    }
    if(this.cores.length === 1 && this.clock.mode !== "deterministic")
    {
        this.take_core_events(0);
        return this.main_loop();
    }
    // Always service the shared devices, even if every core is in CLI/HLT.
    // AP execution never advances the machine's timers a second time.
    const now = this.clock.now();
    let next = this.run_hardware_timers(!!this.acpi_enabled[0], now);
    let ran = false;
    let start = this.scheduler_round++ % this.cores.length;
    if(this.scheduler_seed)
    {
        let seed = this.scheduler_seed | 0;
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        this.scheduler_seed = seed >>> 0;
        start = this.scheduler_seed % this.cores.length;
    }
    for(let turn = 0; turn < this.cores.length; turn++)
    {
        const core = (start + turn) % this.cores.length;
        this.take_core_events(core);
        if(!this.core_runnable(core))
        {
            continue;
        }
        this.switch_core(core);
        const state = this.cores[core];
        const epoch = this.execution_epoch;
        const steps = this.run_cpu_slice(this.scheduler_quantum);
        if(epoch !== this.execution_epoch) return 0;
        state.steps += steps;
        state.slices++;
        ran = true;
        if(!this.in_hlt[0]) next = 0;
    }
    // An AP may have just interrupted a core whose turn was earlier in this
    // round. Do not sleep until a device timer before scheduling that core.
    if(this.cores.some((_, core) => this.apic_peek_core_events(core) ||
        this.core_runnable(core) && (this.apic_core_interrupt_pending(core) ||
            this.apic_core_nmi_pending(core) || this.apic_core_smi_pending(core)))) next = 0;
    this.clock.now();
    // The guest may have reprogrammed a timer before HLT. Recompute its
    // deadline next round before sleeping or advancing deterministic time.
    if(ran) next = 0;
    if(this.clock.mode === "deterministic" && next > 0 && Number.isFinite(next))
    {
        this.clock.advance_to(Math.max(this.clock.now(), now + next));
        return 0;
    }
    return next;
};

/**
 * Host-parallel execution (src/parallel/machine.js): the application
 * processors run in vCPU workers; this thread runs the BSP and the devices,
 * serves the workers' I/O and stops them at safe points when the machine
 * pauses, sleeps, resets or takes a snapshot.
 * @param {{bytes: Uint8Array, settings: Object, worker_url: (string|URL)}} options
 */
CPU.prototype.start_parallel = async function(options)
{
    dbg_assert(this.cores.length > 1 && this.clock.mode !== "deterministic");
    this.parallel = new ParallelMachine(this, options);
    await this.parallel.start();
};

/** @return {number} milliseconds until the machine needs to run again */
CPU.prototype.run_parallel = function()
{
    const machine = this.parallel;
    // (a failed vCPU stops the machine: see v86.prototype.do_tick)
    if(machine.check_failure()) return 0;
    machine.service();
    if(machine.pending_reset)
    {
        machine.request_stop();
        if(!machine.all_parked()) return 0;
        const { reason, keep_memory } = machine.pending_reset;
        machine.pending_reset = null;
        this.reboot_internal(reason, keep_memory);
        return 0;
    }
    if(this.devices.acpi?.sleeping)
    {
        // S3: every core stops; the device timers run (an RTC alarm may wake us)
        machine.request_stop();
        const now = this.clock.now();
        const next = this.run_hardware_timers(!!this.acpi_enabled[0], now);
        return this.devices.acpi.sleeping ? Math.min(next, 100) : 0;
    }
    if(machine.stopping())
    {
        machine.resume();
    }
    // (this core takes other cores' code publications and writes, see
    // crate::parallel::code; while it is halted between ticks it counts as idle)
    this.wm.exports["parallel_idle"](false);
    this.take_core_events(0);
    const t = this.main_loop();
    machine.service();
    if(this.in_hlt[0] && t > 0) this.wm.exports["parallel_idle"](true);
    return t;
};

/** Copy the parked workers' cores into this.cores, the format of a cooperative machine */
CPU.prototype.parallel_capture = function()
{
    const machine = this.parallel, ex = this.wm.exports;
    dbg_assert(machine.all_parked() && this.active_core === 0);
    for(let core = 1; core < this.cores.length; core++)
    {
        const counters = machine.core_counters(core);
        this.cores[core] = { running: machine.core_running(core), saved: machine.read_core(core),
            slices: counters.slices, steps: counters.steps };
        const [low, high] = machine.core_tsc_offset(core);
        ex["context_tsc_set"](core, low, high);
    }
};

/** Hand restored cores (this.cores) to the parked workers */
CPU.prototype.parallel_install = function()
{
    const machine = this.parallel, ex = this.wm.exports;
    dbg_assert(machine.all_parked());
    this.switch_core(0);
    for(let core = 1; core < this.cores.length; core++)
    {
        machine.write_core(core, this.cores[core].saved);
        machine.set_core_running(core, this.cores[core].running);
        machine.set_core_tsc_offset(core, [ex["context_tsc_get"](core, false) >>> 0, ex["context_tsc_get"](core, true) >>> 0]);
    }
    machine.schedule(COMMAND_RELOAD);
};

/**
 * The per-core part of the CPU state (CORE_STATE_RANGES, from
 * gen/state_layout.js), for switching the active core. Only valid at a
 * main-loop safe point, when no generated code or helper is running.
 * Local APIC, TSC and TLB state are saved separately by the machine scheduler.
 * @return {!Array<!Uint8Array>}
 */
CPU.prototype.save_core_state = function()
{
    // The x87 shadow cache is not core state: write it back into fpu_st
    this.wm.exports["fpu_cache_barrier"]();
    const memory = new Uint8Array(this.wasm_memory.buffer);
    return CORE_STATE_RANGES.map(([start, end]) => memory.slice(this.state_base + start, this.state_base + end));
};

/**
 * Make a core saved by save_core_state the active one. State derived from
 * the previous core is dropped: the TLB (which also resets the EIP
 * translation cache), the cached state flags and the x87 shadow cache.
 * Compiled code stays valid: it reads the state at the fixed addresses and
 * re-checks the TLB and mode on entry.
 * @param {!Array<!Uint8Array>} saved
 * @param {boolean=} preserve_tlb
 */
CPU.prototype.load_core_state = function(saved, preserve_tlb)
{
    dbg_assert(saved.length === CORE_STATE_RANGES.length);
    this.wm.exports["fpu_discard_cache"]();
    const memory = new Uint8Array(this.wasm_memory.buffer);
    CORE_STATE_RANGES.forEach(([start], i) => memory.set(saved[i], this.state_base + start));
    if(!preserve_tlb) this.full_clear_tlb();
    this.update_state_flags();
};

/**
 * A snapshot of the machine for diagnosing hangs and failed tests: CPU mode
 * and registers, interrupt controllers, ACPI device and tables. Plain data
 * (JSON-serializable); the format may grow (per-core entries with SMP).
 * @return {!Object}
 */
CPU.prototype.get_diagnostics = function()
{
    const hex = x => "0x" + (x >>> 0).toString(16);
    const eflags = this.get_eflags();
    const cr0 = this.cr[0];
    const cs_base = this.segment_offsets[1];
    const mode = !this.protected_mode[0] ? "real" : eflags & 1 << 17 ? "vm86" : this.is_32[0] ? "protected32" : "protected16";

    const apic = new Int32Array(this.wasm_memory.buffer, this.get_apic_addr(), 46);
    const bits = words => {
        const vectors = [];
        for(let i = 0; i < 256; i++) if(words[i >> 5] >>> (i & 31) & 1) vectors.push(i);
        return vectors;
    };
    const pic = new Uint8Array(this.wasm_memory.buffer, this.get_pic_addr_master(), 13);
    const pic_slave = new Uint8Array(this.wasm_memory.buffer, this.get_pic_addr_slave(), 13);

    const acpi = this.devices && this.devices.acpi;
    const tables = this.acpi_enabled[0] ? locate_acpi_tables(this.mem8) : null;

    // per core: the active one from the live state, the others from their saved state
    const cores = this.cores.map((state, core) => {
        const field = (offset, size) => {
            if(core === this.active_core || this.parallel && core !== 0)
            {
                // (a core in a worker: its live state, read while it runs)
                const base = core === this.active_core ? this.state_base : this.parallel.state_base(core);
                const view = new DataView(this.wasm_memory.buffer, base + offset, size);
                return size === 1 ? view.getUint8(0) : view.getInt32(0, true);
            }
            const index = CORE_STATE_RANGES.findIndex(([start, end]) => offset >= start && offset + size <= end);
            const view = new DataView(state.saved[index].buffer, offset - CORE_STATE_RANGES[index][0], size);
            return size === 1 ? view.getUint8(0) : view.getInt32(0, true);
        };
        const lapic = new Int32Array(this.wasm_memory.buffer, this.apic_addr(core), 46);
        return {
            "state": this.wm.exports["exception_shutdown"](core) ? "shutdown" :
                !(this.parallel && core ? this.parallel.core_running(core) : state.running) ? "wait-for-sipi" :
                field(STATE_OFFSETS.in_hlt, 1) ? "halted" : "runnable",
            "slices": this.parallel && core ? this.parallel.core_counters(core).slices : state.slices,
            "interpreter_steps": this.parallel && core ? this.parallel.core_counters(core).steps : state.steps,
            "retired_instructions": this.wm.exports["core_statistics_get"](core, 0),
            "rep_elements": this.wm.exports["core_statistics_get"](core, 1),
            "faults": this.wm.exports["core_statistics_get"](core, 2),
            "halt_count": this.wm.exports["core_statistics_get"](core, 3),
            "runtime_ms": this.wm.exports["core_statistics_get"](core, 4),
            "ipi_sent": this.wm.exports["apic_core_ipi_sent"](core) >>> 0,
            "ipi_received": this.wm.exports["apic_core_ipi_received"](core) >>> 0,
            "apic_id": lapic[0] >>> 24,
            "apic_irr": bits(lapic.subarray(16, 24)),
            "apic_isr": bits(lapic.subarray(24, 32)),
            "apic_tpr": lapic[13],
            "halted": !!field(STATE_OFFSETS.in_hlt, 1),
            "interrupts_enabled": !!(field(STATE_OFFSETS.flags, 4) & FLAG_INTERRUPT),
            "linear_ip": hex(field(STATE_OFFSETS.instruction_pointer, 4)),
            "cs": hex(field(STATE_OFFSETS.sreg + 2, 4) & 0xFFFF),
            "cr0": hex(field(STATE_OFFSETS.cr, 4)),
        };
    });

    return {
        "active_core": this.active_core,
        "cores": cores,
        "parallel": this.parallel ? this.parallel.status() : null,
        // how the cores run: "parallel" (vCPU workers) or "cooperative", and why not parallel
        "execution": { "mode": this.parallel ? "parallel" : "cooperative", "fallback": this.parallel_fallback || null },
        "clock": Object.assign({ "mode": this.clock.mode, "now_ms": this.clock.now() }, this.clock.get_diagnostics()),
        "scheduler": { "quantum": this.scheduler_quantum, "seed": this.scheduler_seed, "round": this.scheduler_round },
        "cpu": {
            "mode": mode,
            "paging": !!(cr0 & 1 << 31),
            "pae": !!(this.cr[4] & 1 << 5),
            "cs": hex(this.sreg[1]),
            "eip": hex(this.instruction_pointer[0] - cs_base),
            "linear_ip": hex(this.instruction_pointer[0]),
            "eflags": hex(eflags),
            "cpl": this.cpl[0],
            "cr0": hex(cr0),
            "cr3": hex(this.cr[3]),
            "cr4": hex(this.cr[4]),
            "halted": !!this.in_hlt[0],
        },
        "apic": this.acpi_enabled[0] ? {
            "id": apic[0] >>> 24,
            "enabled": !!this.apic_enabled[0],
            "software_enabled": !!(apic[40] & 0x100),
            "tpr": apic[13],
            "irr": bits(apic.subarray(16, 24)),
            "isr": bits(apic.subarray(24, 32)),
            "lvt_timer": hex(apic[8]),
            "lvt_lint0": hex(apic[10]),
            "lvt_lint1": hex(apic[11]),
        } : null,
        "pic": {
            "master": { "irr": hex(pic[3]), "isr": hex(pic[2]), "enabled": hex(pic[0]), "elcr": hex(pic[10]) },
            "slave": { "irr": hex(pic_slave[3]), "isr": hex(pic_slave[2]), "enabled": hex(pic_slave[0]), "elcr": hex(pic_slave[10]) },
        },
        "shared_irq_sources": Object.fromEntries(this.shared_irq_sources
            .map((sources, irq) => [irq, Array.from(sources)]).filter(([, sources]) => sources.length)),
        "acpi": acpi ? {
            "pm_base": acpi.pm_base === -1 ? null : hex(acpi.pm_base),
            "sci_enabled": !!(acpi.pm1_cnt & 1),
            "sci_level": acpi.sci_level,
            "pm1_sts": hex(acpi.pm1_sts),
            "pm1_en": hex(acpi.pm1_en),
            "gpe_sts": hex(acpi.gpe_sts),
            "gpe_en": hex(acpi.gpe_en),
            "soft_off": acpi.soft_off,
        } : null,
        "acpi_tables": tables && {
            "rsdp": hex(tables.rsdp),
            "revision": tables.revision,
            "oem_id": tables.oem_id,
            "tables": tables.tables.map(t => ({ "signature": t.signature, "address": hex(t.address), "length": t.length, "checksum_ok": t.checksum_ok })),
        },
    };
};

CPU.prototype.set_state_apic = function(state)
{
    const APIC_STRUCT_SIZE = 4 * 46; // keep in sync with apic.rs
    const IOAPIC_CONFIG_MASKED = 1 << 16;

    if(state instanceof Array)
    {
        // old js state image; delete this code path when the state version changes
        const apic = new Int32Array(this.wasm_memory.buffer, this.get_apic_addr(), APIC_STRUCT_SIZE >> 2);
        apic[0] = state[0]; // apic_id
        apic[1] = state[1]; // timer_divier
        apic[2] = state[2]; // timer_divider_shift
        apic[3] = state[3]; // timer_initial_count
        apic[4] = state[4]; // timer_current_count
        // skip next_tick (in js: state[4]; in rust: apic[6] and apic[7])
        apic[8] = state[6]; // lvt_timer
        apic[9] = state[7]; // lvt_perf_counter
        apic[10] = state[8]; // lvt_int0
        apic[11] = state[9]; // lvt_int1
        apic[12] = state[10]; // lvt_error
        apic[13] = state[11]; // tpr
        apic[14] = state[12]; // icr0
        apic[15] = state[13]; // icr1
        apic.set(state[15], 16); // irr
        apic.set(state[15], 24); // isr
        apic.set(state[16], 32); // tmr
        apic[40] = state[17]; // spurious_vector
        apic[41] = state[18]; // destination_format
        apic[42] = state[19]; // local_destination
        apic[43] = state[20]; // error
        apic[44] = state[21]; // read_error
        apic[45] = state[22] || IOAPIC_CONFIG_MASKED; // lvt_thermal_sensor
    }
    else
    {
        const apic = new Uint8Array(this.wasm_memory.buffer, this.get_apic_addr(), APIC_STRUCT_SIZE);
        dbg_assert(state instanceof Uint8Array);
        dbg_assert(state.length === apic.length); // later versions might need to handle state upgrades here
        apic.set(state);
    }
};

CPU.prototype.set_state_ioapic = function(state)
{
    const IOAPIC_STRUCT_SIZE = 4 * 52; // keep in sync with ioapic.rs

    if(state instanceof Array)
    {
        // old js state image; delete this code path when the state version changes
        dbg_assert(state[0].length === 24);
        dbg_assert(state[1].length === 24);
        dbg_assert(state.length === 6);
        const ioapic = new Int32Array(this.wasm_memory.buffer, this.get_ioapic_addr(), IOAPIC_STRUCT_SIZE >> 2);
        ioapic.set(state[0], 0); // ioredtbl_config
        ioapic.set(state[1], 24); // ioredtbl_destination
        ioapic[48] = state[2]; // ioregsel
        ioapic[49] = state[3]; // ioapic_id
        ioapic[50] = state[4]; // irr
        ioapic[51] = state[5]; // irq_value
    }
    else
    {
        const ioapic = new Uint8Array(this.wasm_memory.buffer, this.get_ioapic_addr(), IOAPIC_STRUCT_SIZE);
        dbg_assert(state instanceof Uint8Array);
        dbg_assert(state.length === ioapic.length); // later versions might need to handle state upgrades here
        ioapic.set(state);
    }
};

CPU.prototype.pack_memory = function()
{
    dbg_assert((this.mem8.length & 0xFFF) === 0);

    const page_count = this.mem8.length >> 12;
    const nonzero_pages = [];
    for(let page = 0; page < page_count; page++)
    {
        if(!this.is_memory_zeroed(page << 12, 0x1000))
        {
            nonzero_pages.push(page);
        }
    }

    // (only single-buffer snapshots pack RAM: streams write it page by page)
    const packed_size = nonzero_pages.length * 0x1000;
    if(packed_size > STATE_MAX_SINGLE_BUFFER)
    {
        throw new RangeError("The state (" + Math.ceil(packed_size / 1048576) + " MB of RAM) is larger than a " +
            "single-buffer snapshot can be (2 GiB): use save_state_stream");
    }
    const bitmap = new Bitmap(page_count);
    const packed_memory = new Uint8Array(packed_size);

    for(const [i, page] of nonzero_pages.entries())
    {
        bitmap.set(page, 1);

        const offset = page << 12;
        const page_contents = this.mem8.subarray(offset, offset + 0x1000);
        packed_memory.set(page_contents, i << 12);
    }

    return { bitmap, packed_memory };
};

CPU.prototype.unpack_memory = function(bitmap, packed_memory)
{
    this.zero_memory(0, this.memory_size[0]);

    const page_count = this.memory_size[0] >> 12;
    let packed_page = 0;

    for(let page = 0; page < page_count; page++)
    {
        if(bitmap.get(page))
        {
            const offset = packed_page << 12;
            const view = packed_memory.subarray(offset, offset + 0x1000);
            this.mem8.set(view, page << 12);
            packed_page++;
        }
    }
};

/** @param {function():number} run @return {number} */
CPU.prototype.execute_cpu = function(run)
{
    const core = this.active_core;
    const start = v86.microtick();
    this.in_cpu = true;
    try { return run(); }
    finally
    {
        this.in_cpu = false;
        this.wm.exports["core_statistics_runtime"](core, Math.max(0, v86.microtick() - start));
        if(this.wm.exports["exception_take_bsp_reset"]())
        {
            this.reset_pending = true;
            this.note_reset("triple-fault");
        }
        if(this.reset_pending)
        {
            this.reset_pending = false;
            this.reboot_internal();
        }
    }
};

/**
 * Diagnostics only: why and where the last board reset was requested.
 * @param {string} reason
 */
CPU.prototype.note_reset = function(reason)
{
    const d = this.get_diagnostics().cpu;
    const high = new Uint32Array(this.wasm_memory.buffer, this.state_base + STATE_OFFSETS.x64_rip_hi, 1)[0];
    this.last_reset = {
        "reason": reason, "count": (this.last_reset ? this.last_reset["count"] : 0) + 1,
        "rip": "0x" + (BigInt(high) << 32n | BigInt(this.instruction_pointer[0] >>> 0)).toString(16),
        "mode": d["mode"], "cs": d["cs"], "cpl": d["cpl"], "cr3": d["cr3"], "cr2": "0x" + (this.cr[2] >>> 0).toString(16),
        "active_core": this.active_core,
    };
    const words = new Uint32Array(this.wasm_memory.buffer, this.state_base + STATE_OFFSETS.x64_idtr_base_hi, 2);
    const base = (high, low) => "0x" + (BigInt(high >>> 0) << 32n | BigInt(low >>> 0)).toString(16);
    this.last_reset["gdtr"] = [base(words[1], this.gdtr_offset[0]), this.gdtr_size[0]];
    this.last_reset["idtr"] = [base(words[0], this.idtr_offset[0]), this.idtr_size[0]];
    const log = this.wm.exports["x64_fault_log"];
    if(log)
    {
        const hex = (index, field) => "0x" + (BigInt(log(index, field, true) >>> 0) << 32n | BigInt(log(index, field, false) >>> 0)).toString(16);
        this.last_reset["x64_faults"] = [];
        for(let i = 0; i < 6; i++)
        {
            if(!log(i, 2, true) && !log(i, 2, false)) break;
            this.last_reset["x64_faults"].push({ "vector": log(i, 0, false), "error": hex(i, 1), "rip": hex(i, 2), "address": hex(i, 3), "rsp": hex(i, 4), "cs": hex(i, 5) });
        }
    }
};

/** @param {string=} reason */
/**
 * S3 entered (ACPI): stop executing at the end of the current instruction.
 * run_cores then only services device timers until a wake event.
 */
CPU.prototype.enter_sleep = function()
{
    this.wm.exports["request_core_yield"]();
};

/**
 * Wake from S3: CPUs and devices are reset as on a hardware reset, but RAM
 * and the shadowed BIOS (with SeaBIOS's "POST ran" flag) are kept, so the
 * firmware takes its resume path.
 */
CPU.prototype.resume_from_sleep = function()
{
    this.reboot_internal("s3-wake", true);
};

/**
 * @param {string=} reason
 * @param {boolean=} keep_memory wake from S3: do not reload the firmware
 */
CPU.prototype.reboot_internal = function(reason, keep_memory)
{
    if(reason) this.note_reset(reason);
    // A guest CF9/8042 OUT finishes before architectural state is replaced.
    if(this.in_cpu)
    {
        this.reset_pending = true;
        this.wm.exports["request_core_yield"]();
        return;
    }
    if(this.parallel && !this.parallel.all_parked())
    {
        // the application processors stop first (see run_parallel)
        this.parallel.pending_reset = { reason, keep_memory };
        this.parallel.request_stop();
        this.stop_idling();
        return;
    }
    if(this.parallel)
    {
        this.parallel.schedule(COMMAND_RESET);
    }
    this.clock.now();
    this.reset_cores();
    this.wm.exports["reset_interrupt_controllers"]();
    this.reset_cpu();
    this.wm.exports["context_reset_all"]();

    this.fw_value = [];

    if(this.devices.pci)
    {
        this.devices.pci.reset();
    }
    for(const port of this.devices.pcie_root_ports || [])
    {
        port.reset();
    }
    if(this.devices.acpi)
    {
        this.devices.acpi.reset();
    }
    if(this.devices.q35)
    {
        this.devices.q35.reset();
    }
    if(this.devices.hpet)
    {
        this.devices.hpet.reset();
    }
    if(this.devices.smbus)
    {
        this.devices.smbus.reset();
    }

    // Like PCIRST#, a reset deasserts every level-triggered source
    this.shared_irq_sources.forEach((sources, irq) => {
        if(sources.size)
        {
            sources.clear();
            // (16-23: IOAPIC-only inputs)
            irq < 16 ? this.device_lower_irq(irq) : this.ioapic_lower_irq(irq);
        }
    });

    // (disk I/O still in flight must not reach the machine that starts now)
    if(this.devices.ide)
    {
        this.devices.ide.reset();
    }
    if(this.devices.ahci)
    {
        this.devices.ahci.reset();
    }
    if(this.devices.ahci_test)
    {
        this.devices.ahci_test.reset();
    }
    if(this.devices.dma)
    {
        this.devices.dma.cancel_transfers();
    }

    if(this.devices.virtio_9p)
    {
        this.devices.virtio_9p.reset();
    }
    if(this.devices.virtio_console)
    {
        this.devices.virtio_console.reset();
    }
    if(this.devices.virtio_net)
    {
        this.devices.virtio_net.reset();
    }
    if(this.devices.ps2)
    {
        this.devices.ps2.reset();
    }
    for(const device of this.devices.virtio_devices || [])
    {
        device.reset();
    }
    if(this.devices.graphics_adapter)
    {
        this.devices.graphics_adapter.reset();
    }

    if(keep_memory)
    {
        return;
    }

    if(reason === "power-on")
    {
        // Power was off (ACPI S4/S5): RAM does not keep its contents. A guest
        // resuming from S4 has to restore itself from disk. (A raw fill does
        // not reach the JIT's write notification: drop all compiled code.)
        this.zero_memory(0, this.memory_size[0]);
        this.clear_extended_memory();
        this.jit_clear_cache();
        this.full_clear_tlb();
    }

    this.load_bios();

    if(this.reload_direct_boot_kernel)
    {
        this.reload_direct_boot_kernel();
    }
};

/**
 * The storage device behind a configured drive name ("hda", "hdb",
 * "cdrom"): an IDE interface, or the device on an AHCI port. Every one has
 * `buffer`; the CD drive also has has_disk/set_cdrom/eject. Undefined for a
 * drive the machine does not have.
 * @param {string} name
 * @return {?}
 */
CPU.prototype.disk_device = function(name)
{
    const devices = this.devices;
    if(devices.ahci)
    {
        return devices.ahci.disk_device(name);
    }
    const ide = devices.ide;
    switch(name)
    {
        case "hda": return ide && ide.primary ? ide.primary.master : undefined;
        case "hdb": return ide && ide.primary ? ide.primary.slave : undefined;
        case "cdrom": return devices.cdrom;
    }
    return undefined;
};

/**
 * Every storage device that can hold a disk, with a name for diagnostics
 * @return {!Array<!Array<?>>} [name, device] pairs
 */
CPU.prototype.disk_devices = function()
{
    const devices = this.devices;
    if(devices.ahci)
    {
        return devices.ahci.disk_devices();
    }
    const ide = devices.ide;
    return [["hda", ide?.primary?.master], ["hdb", ide?.primary?.slave],
        ["cdrom", ide?.secondary?.master], ["secondary_slave", ide?.secondary?.slave]].filter(([, device]) => device);
};

/**
 * Drive a level-triggered interrupt source that may share its line with
 * others (ACPI SCI, PCI INTx). The line stays asserted until every source on
 * it has deasserted. Devices that own their line exclusively keep calling
 * device_raise_irq/device_lower_irq directly.
 * @param {number} irq
 * @param {number} source unique per device: pci_id for PCI functions
 * @param {boolean} level
 */
CPU.prototype.set_shared_irq_level = function(irq, source, level)
{
    const sources = this.shared_irq_sources[irq];

    if(level)
    {
        sources.add(source);
        this.device_raise_irq(irq);
    }
    else
    {
        sources.delete(source);
        if(sources.size === 0)
        {
            this.device_lower_irq(irq);
        }
    }
};

/**
 * The storage of the Q35 machine: the ICH9 AHCI controller (00:1f.2) with
 * hda on port 0, hdb on port 1 and an ATAPI drive on port 2 that holds cdrom
 * (empty without it)
 * @param {Object} settings
 * @param {BusConnector} device_bus
 */
CPU.prototype.create_q35_storage = function(settings, device_bus)
{
    this.devices.ahci = new AHCIController(this, device_bus, [
        settings.hda ? { buffer: settings.hda } : undefined,
        settings.hdb ? { buffer: settings.hdb } : undefined,
        { buffer: settings.cdrom, is_cdrom: true },
    ]);
    this.devices.cdrom = this.devices.ahci.disk_device("cdrom");
};

/**
 * Where a built-in device goes when its options put it behind a PCI Express
 * root port (pcie_root_port, platform.root_port_devices): device 0 on that
 * port's secondary bus; undefined for its usual place
 * @param {string} name
 * @return {number|undefined}
 */
CPU.prototype.root_port_pci_id = function(name)
{
    const port = this.platform.root_port_devices[name];
    return port === undefined ? undefined : this.devices.pcie_root_ports[port].pci_secondary_bus << 8;
};

/**
 * An SMI (Q35: the APM control port, the TCO watchdog) for a core, by
 * default the one whose port access raised it: latched until the core can
 * enter system management mode (src/rust/cpu/smm.rs). The current core
 * enters it at once (after the long-mode instruction it is in, if any),
 * another core at its next slice, a core in SMM after RSM.
 * @param {number=} core
 */
CPU.prototype.smi = function(core)
{
    this.apic_raise_smi(core === undefined ? (this.io_core >= 0 ? this.io_core : this.active_core) : core);
    this.handle_irqs();
};

/**
 * set_shared_irq_level for an IOAPIC input without a PIC counterpart (GSI
 * 16-23: Q35's PIRQ lines in APIC mode)
 * @param {number} gsi
 * @param {number} source
 * @param {boolean} level
 */
CPU.prototype.set_shared_gsi_level = function(gsi, source, level)
{
    dbg_assert(gsi >= 16 && gsi < this.shared_irq_sources.length);
    const sources = this.shared_irq_sources[gsi];

    if(level)
    {
        sources.add(source);
        this.ioapic_raise_irq(gsi);
    }
    else
    {
        sources.delete(source);
        if(sources.size === 0)
        {
            this.ioapic_lower_irq(gsi);
        }
    }
};

CPU.prototype.reset_memory = function()
{
    this.mem8.fill(0);
};

/**
 * Relocate the top `size` bytes of RAM to guest physical 4 GiB. Low RAM
 * then ends at `low_memory_size`; the backing bytes stay in the wasm32 heap.
 * @param {number} size
 * @param {number} low_minimum bytes that must remain below the relocated range
 */
CPU.prototype.configure_high_memory = function(size, low_minimum)
{
    this.low_memory_size = this.memory_size[0];
    if(!size) return;
    const low = this.memory_size[0] - size;
    if(!Number.isSafeInteger(size) || size < 0 || size % (1 << 20) !== 0 || low < Math.max(32 << 20, low_minimum))
    {
        throw new Error("high_memory_size must be a multiple of 1 MiB that leaves at least 32 MiB (and the initrd) below 4 GiB");
    }
    if(!this.wm.exports["x64_phys_set_window"](0, 0, 1, low, size, 1))
    {
        throw new Error("Cannot map high_memory_size above 4 GiB");
    }
    this.low_memory_size = low;
};

/**
 * RAM beyond the wasm32 backing store (extended RAM): `size` bytes at guest physical
 * 4 GiB + high_memory_size, kept in an ExtendedStore (src/extended_memory.js)
 * and cached in `cache_size` bytes of frames (src/rust/x64/extended.rs).
 * Only a long-mode guest can address it.
 * @param {number} size
 * @param {number=} cache_size
 */
CPU.prototype.configure_extended_memory = function(size, cache_size)
{
    this.extended_pages = 0;
    this.extended_base = 0;
    this.extended_store = null;
    if(!size) return;
    if(!Number.isSafeInteger(size) || size < 0 || size % (2 << 20))
    {
        throw new Error("extended_memory_size must be a multiple of 2 MiB");
    }
    const base = 0x100000000 + (this.memory_size[0] - this.low_memory_size);
    if(base + size > 0x1000000000)
    {
        throw new Error("extended_memory_size: guest RAM would exceed the 36-bit physical address space");
    }
    const cache = Math.min(size, cache_size || 512 << 20);
    if(!Number.isSafeInteger(cache) || cache < 1 << 20 || cache % 4096)
    {
        throw new Error("extended_memory_cache must be a multiple of 4 KiB and at least 1 MiB");
    }
    let store;
    try
    {
        store = new ExtendedStore(size / 4096);
    }
    catch(e)
    {
        throw new Error("extended_memory_size: the host cannot allocate " + size + " bytes (" + e.message + ")");
    }
    if(!this.wm.exports["x64_ext_configure"](base >>> 0, Math.floor(base / 0x100000000), size / 4096, cache / 4096))
    {
        throw new Error("extended_memory_size: cannot allocate the frame cache");
    }
    this.extended_store = store;
    this.extended_pages = size / 4096;
    this.extended_base = base;
};

/** Every dirty frame back into the store (src/state.js: a snapshot stream) */
CPU.prototype.flush_extended_memory = function()
{
    this.wm.exports["x64_ext_flush"]();
};

/** Extended RAM reads as zero again (power-on); every core is stopped */
CPU.prototype.clear_extended_memory = function()
{
    if(!this.extended_store) return;
    this.wm.exports["x64_ext_discard"]();
    this.extended_store.clear();
};

CPU.prototype.create_memory = function(size, minimum_size)
{
    // e.g. `2048 << 20` is negative: reject it instead of silently using the minimum
    if(!(size >= 0))
    {
        throw new Error("memory_size must be a non-negative number of bytes, got " + size);
    }
    // The size is kept in 32 bits and RAM lives in wasm32 memory: at most
    // 2 GiB - 128 KiB. (A multiple of 4 GiB used to wrap to 0 bytes here.)
    const max_size = Math.pow(2, 31) - MMAP_BLOCK_SIZE;
    if(size < minimum_size)
    {
        size = minimum_size;
        dbg_log("Rounding memory size up to " + size, LOG_CPU);
    }
    else if(size > max_size)
    {
        // (2 GiB itself only loses the last 128 KiB: not worth a warning)
        if(size > Math.pow(2, 31))
        {
            console.warn("memory_size of " + Math.round(size / (1 << 20)) + " MB exceeds the maximum; using " +
                (max_size / (1 << 20)) + " MB");
        }
        size = max_size;
    }

    size = ((size - 1) | (MMAP_BLOCK_SIZE - 1)) + 1 | 0;
    dbg_assert((size | 0) > 0);
    dbg_assert((size & MMAP_BLOCK_SIZE - 1) === 0);

    console.assert(this.memory_size[0] === 0, "Expected uninitialised memory");

    this.memory_size[0] = size;

    const memory_offset = this.allocate_memory(size);

    this.mem8 = view(Uint8Array, this.wasm_memory, memory_offset, size);
    this.mem32s = view(Uint32Array, this.wasm_memory, memory_offset, size >> 2);
};

// Constructor policy only. IR is the only compiler.
CPU.prototype.configure_jit_backend = function(settings)
{
    if(settings["jit_backend"] !== undefined && settings["jit_backend"] !== "ir")
        throw new Error("jit_backend must be ir (the legacy backend was removed)");
    const exports = this.wm.exports;
    if(!exports["jit_set_enabled"])
        throw new Error("This core has no JIT; rebuild build/v86.wasm");
    // (the IR region tiers' settings, ir_region_budget, ir_opt_level,
    // ir_passes_disabled, ir_verify, ir_dump, ir_stats and ir_page_mode, are
    // deprecated and have no effect: docs/jit-unification-plan.md M11
    // deleted the region tiers, and the x64 page tier compiles all code)
    const enabled = !settings.disable_jit;
    if(!exports["jit_set_enabled"](enabled ? 1 : 0))
        throw new Error("Cannot configure the JIT");
    if(settings["ir_tier0"] !== undefined && typeof settings["ir_tier0"] !== "boolean")
        throw new Error("ir_tier0 must be a boolean");
    // 32-bit and 16-bit code in the x64 page tier (default on; the name is
    // IR Tier-0's, which it replaced in P7.5): without it that code runs in
    // the interpreter
    if(!exports["jit_set_page32"](enabled && settings["ir_tier0"] !== false ? 1 : 0))
        throw new Error("Cannot configure ir_tier0");
    this.jit_backend = "ir";
    this.ir_sync_publication = settings["ir_sync_publication"] === true;
};

CPU.prototype.get_jit_info = function()
{
    const exports = this.wm.exports;
    // (the page tier's counters, through jitrt's jit_stat: client 0,
    // docs/jit-unification-plan.md P5.10)
    const stat = exports["jit_stat"] ? field => exports["jit_stat"](0, field) : null;
    // (the IR region tiers' statistics and settings went with them,
    // docs/jit-unification-plan.md M11; IR Tier-0's before, P7.5)
    return {
        "backend": this.jit_backend,
        "ir_available": !!exports["jit_set_enabled"],
        "ir": {
            // (1 when the JIT compiles: configure_jit_backend, jit_set_enabled)
            "enabled": exports["jit_is_enabled"] ? +exports["jit_is_enabled"]() : 0,
            "tier0": null,
            // (32-bit and 16-bit code in the x64 page tier)
            "page_tier": stat ? {
                "legacy32": !!stat(40),
                "compat32": !!stat(41),
                // (16-bit protected-mode code, x64_page_prot16)
                "prot16": !!stat(42),
                // (real-mode and virtual-8086 code, x64_page_v86)
                "v86": !!stat(44),
                "functions": stat(12) >>> 0,
                "native_instructions": stat(1) >>> 0,
                "activations": stat(13) >>> 0,
            } : null,
        },
    };
};

/**
 * @param {BusConnector} device_bus
 */
CPU.prototype.init = function(settings, device_bus)
{
    // (the V86 constructor checked the options; this is the x86 CPU, of the
    // PC machines: docs/arm64-virt-android16-plan.md P1.1)
    const machine_type = check_machine_options(settings).machine_type;
    if(machine_type === "virt" || machine_type === "ranchu")
    {
        throw new Error("The x86 CPU does not run machine_type \"" + machine_type + "\"");
    }
    const multicore = (settings.cpu_cores || 1) > 1;
    this.clock = new MachineClock(Object.assign({ now: v86.microtick }, settings.cpu_clock));
    this.clock.set_instruction_source(() => this.wm.exports["take_clock_progress"]());
    const deterministic = this.clock.mode === "deterministic";
    this.wm.exports["set_deterministic_execution"](deterministic);
    // Compiled code retires a slice in microseconds: switching cores (their
    // state is copied) would dominate a short one
    const default_quantum = settings.disable_jit || deterministic ? 4096 : 32768;
    this.scheduler_quantum = settings.cpu_quantum === undefined ? default_quantum : settings.cpu_quantum;
    if(!Number.isInteger(this.scheduler_quantum) || this.scheduler_quantum < 1 || this.scheduler_quantum > 100000)
    {
        throw new Error("cpu_quantum must be an integer from 1 to 100000");
    }
    this.scheduler_seed = settings.cpu_schedule_seed >>> 0;
    if(multicore && settings.cpuid_level !== undefined && settings.cpuid_level < 0x1F)
    {
        throw new Error("Multicore topology requires cpuid_level >= 0x1F");
    }
    // Deterministic time uses the interpreter's architectural commit ledger.
    // Multicore JIT remains opt-in until the complete cross-core stress matrix passes.
    if(settings.parallel && deterministic) throw new Error("parallel: deterministic time needs cooperative cores");
    const interpreted = deterministic || multicore && !settings.experimental_smp_jit;
    this.configure_jit_backend(interpreted ? Object.assign({}, settings, { disable_jit: true }) : settings);
    // The JIT switches (src/jit_switches.js): the build's JIT_DEFAULTS, then
    // the setting jit_switches
    set_jit_switches(this.wm.exports, this.wasm_memory, build_jit_defaults(this.wm.exports, this.wasm_memory), "JIT_DEFAULTS");
    set_jit_switches(this.wm.exports, this.wasm_memory, settings["jit_switches"]);
    // The x86-64 CPU profile (CPUID long mode, NX, SYSCALL, CX16, ...) is
    // opt-in while x64 support is experimental
    this.wm.exports["set_x64_test_capabilities"](settings["cpu_type"] === "x86_64");
    this.wm.exports["set_x87_fast_math"]?.(settings["x87_fast_math"] !== false);
    this.wm.exports["set_x87_jit_cache"]?.(settings["x87_jit_cache"] !== false);
    this.create_memory(
        settings.memory_size || 64 * 1024 * 1024,
        settings.initrd ? 64 * 1024 * 1024 : 1024 * 1024,
    );

    this.platform = create_platform(settings, this.memory_size[0]);
    this.configure_high_memory(settings.high_memory_size || 0, settings.initrd ? 64 * 1024 * 1024 + settings.initrd.byteLength : 0);
    this.configure_extended_memory(settings.extended_memory_size || 0, settings.extended_memory_cache);

    settings.cpuid_level && this.set_cpuid_level(settings.cpuid_level);
    // The features of docs/simd-xsave-plan.md (src/cpu_features.js): those
    // cpu_features names (for x86_64 every released one if it names none),
    // and for tests and development the unreleased ones, which warn unless
    // cpu_features_unreleased is set
    this.cpu_features = resolve_cpu_features(settings["cpu_features"], settings["cpu_type"] === "x86_64", settings.cpuid_level || 0x16);
    this.cpu_features_explicit = settings["cpu_features"] !== undefined;
    const unreleased = unreleased_cpu_features(settings["cpu_features"]);
    if(unreleased.length && !settings["cpu_features_unreleased"])
    {
        console.warn("cpu_features: " + unreleased.join(", ") + " not released yet (docs/simd-xsave-plan.md): " +
            "for tests and development, their instructions may still be #UD");
    }
    this.wm.exports["set_cpu_features"](this.cpu_features);

    this.acpi_enabled[0] = +this.platform.acpi;

    this.reset_cpu();
    this.setup_cores();

    var io = new IO(this);
    this.io = io;

    this.bios.main = settings.bios;
    // The display adapter plugin's descriptor; none with graphics_adapter: "none"
    this.graphics_adapter_descriptor = settings.graphics_adapter;
    this.bios.vga = settings.vga_bios;

    this.load_bios();

    if(settings.bzimage)
    {
        const { bzimage, initrd } = settings;
        const cmdline = settings.cmdline || "";
        const option_rom = load_kernel(this.mem8, bzimage, initrd, cmdline);

        if(option_rom)
        {
            this.option_roms.push(option_rom);
            // The running kernel reuses the memory it was loaded to, so every
            // reset has to place it again (like QEMU's -kernel)
            this.reload_direct_boot_kernel = () => load_kernel(this.mem8, bzimage, initrd, cmdline);
        }
    }

    io.register_read(0xB3, this, function()
    {
        // seabios smm_relocate_and_restore
        dbg_log("port 0xB3 read");
        return 0;
    });

    var a20_byte = 0;

    io.register_read(0x92, this, function()
    {
        return a20_byte;
    });

    io.register_write(0x92, this, function(out_byte)
    {
        a20_byte = out_byte;
    });

    io.register_read(0x511, this, function()
    {
        // bios config port (used by seabios and kvm-unit-test)
        if(this.fw_pointer < this.fw_value.length)
        {
            return this.fw_value[this.fw_pointer++];
        }
        else
        {
            dbg_assert(false, "config port: Read past value");
            return 0;
        }
    });
    io.register_write(0x510, this, undefined, function(value)
    {
        // https://wiki.osdev.org/QEMU_fw_cfg
        // https://github.com/qemu/qemu/blob/master/docs/specs/fw_cfg.txt

        dbg_log("bios config port, index=" + h(value));

        function i32(x)
        {
            return new Uint8Array(Int32Array.of(x).buffer);
        }
        function i64(low, high)
        {
            return new Uint8Array(Int32Array.of(low, high).buffer);
        }

        function to_be16(x)
        {
            return x >> 8 | x << 8 & 0xFF00;
        }

        function to_be32(x)
        {
            return x << 24 | x << 8 & 0xFF0000 | x >> 8 & 0xFF00 | x >>> 24;
        }

        this.fw_pointer = 0;

        if(value === FW_CFG_SIGNATURE)
        {
            // Pretend to be qemu (for seabios)
            this.fw_value = i32(FW_CFG_SIGNATURE_QEMU);
        }
        else if(value === FW_CFG_ID)
        {
            this.fw_value = i32(0);
        }
        else if(value === FW_CFG_RAM_SIZE)
        {
            this.fw_value = i64(this.memory_size[0], 0);
        }
        else if(value === FW_CFG_NB_CPUS)
        {
            this.fw_value = i32(this.platform.cores);
        }
        else if(value === FW_CFG_MAX_CPUS)
        {
            this.fw_value = i32(this.platform.cores);
        }
        else if(value === FW_CFG_BOOT_MENU)
        {
            this.fw_value = i32(+settings.bootmenu);
        }
        else if(value === FW_CFG_NUMA)
        {
            this.fw_value = new Uint8Array(16);
        }
        else if(value === FW_CFG_FILE_DIR)
        {
            const buffer_size = 4 + 64 * this.option_roms.length;
            const buffer32 = new Int32Array(buffer_size);
            const buffer8 = new Uint8Array(buffer32.buffer);

            buffer32[0] = to_be32(this.option_roms.length);

            for(let i = 0; i < this.option_roms.length; i++)
            {
                const { name, data } = this.option_roms[i];
                const file_struct_ptr = 4 + 64 * i;

                dbg_assert(FW_CFG_FILE_START + i < 0x10000);
                buffer32[file_struct_ptr + 0 >> 2] = to_be32(data.length);
                buffer32[file_struct_ptr + 4 >> 2] = to_be16(FW_CFG_FILE_START + i);

                dbg_assert(name.length < 64 - 8);

                for(let j = 0; j < name.length; j++)
                {
                    buffer8[file_struct_ptr + 8 + j] = name.charCodeAt(j);
                }
            }

            this.fw_value = buffer8;
        }
        else if(value >= FW_CFG_CUSTOM_START && value < FW_CFG_FILE_START)
        {
            this.fw_value = i32(0);
        }
        else if(value >= FW_CFG_FILE_START && value - FW_CFG_FILE_START < this.option_roms.length)
        {
            const file = this.option_roms[value - FW_CFG_FILE_START];
            this.fw_value = file.get_data ? file.get_data() : file.data;
            dbg_assert(this.fw_value.length === file.data.length, "fw_cfg file " + file.name + " changed size");
        }
        else
        {
            dbg_log("Warning: Unimplemented fw index: " + h(value));
            this.fw_value = i32(0);
        }
    });

    if(DEBUG)
    {
        // Avoid logging noisey ports
        io.register_write(0x80, this, function(out_byte) {});
        io.register_read(0x80, this, function() { return 0xFF; });
        io.register_write(0xE9, this, function(out_byte) {});
    }

    this.devices = {};

    // TODO: Make this more configurable
    if(settings.load_devices)
    {
        this.devices.pci = new PCI(this);

        if(this.acpi_enabled[0])
        {
            const acpi = this.devices.acpi = new ACPI(this, device_bus);

            // v86's own tables, installed by SeaBIOS's table loader. They are
            // generated when SeaBIOS reads them, after it has programmed the PM
            // base (0x600 when the loader is present); the sizes don't depend on it.
            const platform = /** @type {Platform} */ (this.platform);
            const build_tables = () => {
                const pm_base = acpi.pm_base === -1 ? ACPI_PM_BASE_DEFAULT : acpi.pm_base;
                check_platform(platform, pm_base);
                return build_acpi_tables(platform, pm_base);
            };
            const tables = build_tables();
            this.option_roms.push(
                { name: ACPI_LOADER_FILE, data: tables.loader },
                { name: ACPI_RSDP_FILE, data: tables.rsdp },
                { name: ACPI_TABLES_FILE, data: tables.tables, get_data: () => build_tables().tables });

            // Only read by SeaBIOS's fallback builder, if the loader fails:
            // advertise only the sleep states that are implemented
            this.option_roms.push({ name: "etc/system-states", data: acpi_system_states_file(platform) });
        }

        if(this.platform.machine === "q35")
        {
            if(!this.ioapic_raise_irq)
            {
                throw new Error("machine_type \"q35\" needs a newer v86.wasm (ioapic_raise_irq)");
            }
            // (the MCH and the ICH9 LPC; the AHCI function is created with the drives)
            this.devices.q35 = new Q35(this);
            // the PCI Express root ports, before anything is put behind them
            const root_ports = this.platform.pcie_root_ports;
            this.devices.pcie_root_ports = Array.from({ length: root_ports }, (_, i) => new PCIeRootPort(this, i, root_ports));
            if(this.platform.hpet)
            {
                this.devices.hpet = new HPET(this);
            }
            if(this.platform.smbus)
            {
                this.devices.smbus = new SMBus(this);
            }
        }

        this.devices.rtc = new RTC(this);
        this.fill_cmos(this.devices.rtc, settings);

        this.devices.dma = new DMA(this);

        this.devices.display = new DisplayHub(device_bus, settings.screen);
        if(this.graphics_adapter_descriptor)
        {
            this.devices.graphics_adapter = new GraphicsAdapter(this, this.graphics_adapter_descriptor,
                { vram_size: settings.vram_size, test: settings.graphics_adapter_test, renderer: settings.graphics_adapter_renderer });
            // (tests and debugging reach into the VGA core)
            this.devices.vga = this.devices.graphics_adapter.vga();
        }

        this.devices.ps2 = new PS2(this, device_bus);
        this.devices.vmware = new VMwareMouse(this, device_bus);

        this.devices.uart0 = new UART(this, 0x3F8, device_bus);
        this.devices.parallel0 = new ParallelPort(this, 0x378, 7, 0, device_bus);

        if(settings.uart1)
        {
            this.devices.uart1 = new UART(this, 0x2F8, device_bus);
        }
        if(settings.uart2)
        {
            this.devices.uart2 = new UART(this, 0x3E8, device_bus);
        }
        if(settings.uart3)
        {
            this.devices.uart3 = new UART(this, 0x2E8, device_bus);
        }
        if(settings.parallel1)
        {
            this.devices.parallel1 = new ParallelPort(this, 0x278, 5, 1, device_bus);
        }

        if(DEBUG)
        {
            // The platform description (and so the ACPI tables) lists these ports
            for(const { port } of this.platform.uarts.concat(this.platform.parallel_ports))
            {
                dbg_assert(this.io.ports[port].device, "platform port " + h(port) + " has no device");
            }
        }

        this.devices.fdc = new FloppyController(this, settings.fda, settings.fdb);

        if(this.platform.machine === "q35")
        {
            this.create_q35_storage(settings, device_bus);

            if(settings["ahci_test_drives"])
            {
                // (tests only: a second AHCI controller with drives of its
                // own, e.g. behind a root port with ahci_test_pci_id 1 << 8;
                // not part of the machine contract)
                this.devices.ahci_test = new AHCIController(this, device_bus, settings["ahci_test_drives"],
                    settings["ahci_test_pci_id"] === undefined ? 0x0D << 3 : settings["ahci_test_pci_id"]);
            }
        }
        else
        {
            const ide_config = [[undefined, undefined], [undefined, undefined]];
            if(settings.hda)
            {
                ide_config[0][0] = { buffer: settings.hda };
                ide_config[0][1] = { buffer: settings.hdb };
            }
            ide_config[1][0] = { is_cdrom: true, buffer: settings.cdrom };
            this.devices.ide = new IDEController(this, device_bus, ide_config);
            this.devices.cdrom = this.devices.ide.secondary.master;

            if(settings["ahci_test_drives"])
            {
                // (tests only: an AHCI controller on the i440FX at 00:0d.0,
                // with drives of its own; not part of the machine contract)
                this.devices.ahci_test = new AHCIController(this, device_bus, settings["ahci_test_drives"], 0x0D << 3);
            }
        }

        this.devices.pit = new PIT(this, device_bus);

        if(settings.net_device.type === "ne2k")
        {
            this.devices.net = new Ne2k(this, device_bus, settings.preserve_mac_from_state_image, settings.mac_address_translation,
                0, this.root_port_pci_id("net"));
        }
        else if(settings.net_device.type === "virtio")
        {
            this.devices.virtio_net = new VirtioNet(this, device_bus, settings.preserve_mac_from_state_image, settings.net_device.mtu,
                this.root_port_pci_id("net"));
        }

        if(settings.fs9p)
        {
            this.devices.virtio_9p = new Virtio9p(settings.fs9p, this, device_bus, this.root_port_pci_id("virtio_9p"));
        }
        else if(settings.handle9p)
        {
            this.devices.virtio_9p = new Virtio9pHandler(settings.handle9p, this, this.root_port_pci_id("virtio_9p"));
        }
        else if(settings.proxy9p)
        {
            this.devices.virtio_9p = new Virtio9pProxy(settings.proxy9p, this, this.root_port_pci_id("virtio_9p"));
        }
        if(settings.virtio_console)
        {
            this.devices.virtio_console = new VirtioConsole(this, device_bus, this.root_port_pci_id("virtio_console"));
        }
        if(settings.virtio_balloon)
        {
            this.devices.virtio_balloon = new VirtioBalloon(this, device_bus, this.root_port_pci_id("virtio_balloon"));
        }

        if(true)
        {
            this.devices.sb16 = new SB16(this, device_bus);
        }

        // Last, so that they get a slot and ports that nothing else uses
        if(settings.virtio_devices)
        {
            this.devices.virtio_devices = create_virtio_devices(this, settings.virtio_devices);
        }

        // the root ports' slots: the cards the options put behind them,
        // plugged in unless pcie_plugged is false
        const unplugged = new Set();
        for(const placement of Object.values(settings.root_port_devices || {}))
        {
            if(!placement.plugged) unplugged.add(placement.port);
        }
        for(const descriptor of settings.virtio_devices || [])
        {
            if(descriptor["pcie_root_port"] !== undefined && descriptor["pcie_plugged"] === false) unplugged.add(descriptor["pcie_root_port"]);
        }
        for(const port of this.devices.pcie_root_ports || [])
        {
            port.setup(!unplugged.has(port.number));
        }
    }

    if(settings.multiboot)
    {
        dbg_log("loading multiboot", LOG_CPU);
        const option_rom = this.load_multiboot_option_rom(settings.multiboot, settings.initrd, settings.cmdline);

        if(option_rom)
        {
            if(this.bios.main)
            {
                dbg_log("adding option rom for multiboot", LOG_CPU);
                this.option_roms.push(option_rom);
            }
            else
            {
                dbg_log("loaded multiboot without bios", LOG_CPU);
                this.reg32[REG_EAX] = this.io.port_read32(0xF4);
            }
        }
    }

    this.debug_init();
};

CPU.prototype.load_multiboot = function (buffer)
{
    if(this.bios.main)
    {
        dbg_assert(false, "load_multiboot not supported with BIOS");
    }

    const option_rom = this.load_multiboot_option_rom(buffer, undefined, "");
    if(option_rom)
    {
        dbg_log("loaded multiboot", LOG_CPU);
        this.reg32[REG_EAX] = this.io.port_read32(0xF4);
    }
};

CPU.prototype.load_multiboot_option_rom = function(buffer, initrd, cmdline)
{
    // https://www.gnu.org/software/grub/manual/multiboot/multiboot.html

    dbg_log("Trying multiboot from buffer of size " + buffer.byteLength, LOG_CPU);

    const ELF_MAGIC = 0x464C457F;
    const MULTIBOOT_HEADER_MAGIC = 0x1BADB002;
    const MULTIBOOT_HEADER_MEMORY_INFO = 0x2;
    const MULTIBOOT_HEADER_ADDRESS = 0x10000;
    const MULTIBOOT_BOOTLOADER_MAGIC = 0x2BADB002;
    const MULTIBOOT_SEARCH_BYTES = 8192;
    const MULTIBOOT_INFO_STRUCT_LEN = 116;
    const MULTIBOOT_INFO_CMDLINE = 0x4;
    const MULTIBOOT_INFO_MODS = 0x8;
    const MULTIBOOT_INFO_MEM_MAP = 0x40;

    if(buffer.byteLength < MULTIBOOT_SEARCH_BYTES)
    {
        var buf32 = new Int32Array(MULTIBOOT_SEARCH_BYTES / 4);
        new Uint8Array(buf32.buffer).set(new Uint8Array(buffer));
    }
    else
    {
        var buf32 = new Int32Array(buffer, 0, MULTIBOOT_SEARCH_BYTES / 4);
    }

    for(var offset = 0; offset < MULTIBOOT_SEARCH_BYTES; offset += 4)
    {
        if(buf32[offset >> 2] === MULTIBOOT_HEADER_MAGIC)
        {
            var flags = buf32[offset + 4 >> 2];
            var checksum = buf32[offset + 8 >> 2];
            var total = MULTIBOOT_HEADER_MAGIC + flags + checksum | 0;

            if(total)
            {
                dbg_log("Multiboot checksum check failed", LOG_CPU);
                continue;
            }
        }
        else
        {
            continue;
        }

        dbg_log("Multiboot magic found, flags: " + h(flags >>> 0, 8), LOG_CPU);
        // bit 0 : load modules on page boundaries (may as well, if we load modules)
        // bit 1 : provide a memory map (which we always will)
        dbg_assert((flags & ~MULTIBOOT_HEADER_ADDRESS & ~3) === 0, "TODO");

        // The image is loaded later (from the option ROM); reject what cannot
        // be loaded now, with an error the embedder sees
        if(!(flags & MULTIBOOT_HEADER_ADDRESS))
        {
            if(buf32[0] !== ELF_MAGIC)
            {
                throw new Error("Multiboot image has neither an address header nor an ELF header");
            }
            const reason = elf_unsupported_reason(buffer);
            if(reason)
            {
                throw new Error("Unsupported multiboot ELF image: " + reason);
            }
        }

        // do this in a io register hook, so it can happen after BIOS does its work
        var cpu = this;

        this.io.register_read(0xF4, this, function () {return 0;} , function () { return 0;}, function () {
            // actually do the load and return the multiboot magic
            const multiboot_info_addr = 0x7C00;
            let multiboot_data = multiboot_info_addr + MULTIBOOT_INFO_STRUCT_LEN;
            let info = 0;

            // command line
            if(cmdline)
            {
                info |= MULTIBOOT_INFO_CMDLINE;

                cpu.write32(multiboot_info_addr + 16, multiboot_data);

                cmdline += "\x00";
                const encoder = new TextEncoder();
                const cmdline_utf8 = encoder.encode(cmdline);
                cpu.write_blob(cmdline_utf8, multiboot_data);
                multiboot_data += cmdline_utf8.length;
            }

            // memory map
            if(flags & MULTIBOOT_HEADER_MEMORY_INFO)
            {
                info |= MULTIBOOT_INFO_MEM_MAP;
                let multiboot_mmap_count = 0;
                cpu.write32(multiboot_info_addr + 44, 0);
                cpu.write32(multiboot_info_addr + 48, multiboot_data);

                // Create a memory map for the multiboot kernel
                // does not exclude traditional bios exclusions
                let start = 0;
                let was_memory = false;
                const ram = addr => addr < cpu.low_memory_size && cpu.memory_map_read8[addr >>> MMAP_BLOCK_BITS] === undefined;
                for(let addr = 0; addr < MMAP_MAX; addr += MMAP_BLOCK_SIZE)
                {
                    if(was_memory && !ram(addr))
                    {
                        cpu.write32(multiboot_data, 20); // size
                        cpu.write32(multiboot_data + 4, start); //addr (64-bit)
                        cpu.write32(multiboot_data + 8, 0);
                        cpu.write32(multiboot_data + 12, addr - start); // len (64-bit)
                        cpu.write32(multiboot_data + 16, 0);
                        cpu.write32(multiboot_data + 20, 1); // type (MULTIBOOT_MEMORY_AVAILABLE)
                        multiboot_data += 24;
                        multiboot_mmap_count += 24;
                        was_memory = false;
                    }
                    else if(!was_memory && ram(addr))
                    {
                        start = addr;
                        was_memory = true;
                    }
                }
                dbg_assert (!was_memory, "top of 4GB shouldn't have memory");
                // relocated and extended RAM
                const high = cpu.memory_size[0] - cpu.low_memory_size + cpu.extended_pages * 4096;
                if(high)
                {
                    cpu.write32(multiboot_data, 20);
                    cpu.write32(multiboot_data + 4, 0); // addr = 4 GiB
                    cpu.write32(multiboot_data + 8, 1);
                    cpu.write32(multiboot_data + 12, high >>> 0);
                    cpu.write32(multiboot_data + 16, Math.floor(high / 0x100000000));
                    cpu.write32(multiboot_data + 20, 1);
                    multiboot_data += 24;
                    multiboot_mmap_count += 24;
                }
                cpu.write32(multiboot_info_addr + 44, multiboot_mmap_count);
            }

            let entrypoint = 0;
            let top_of_load = 0;

            if(flags & MULTIBOOT_HEADER_ADDRESS)
            {
                dbg_log("Multiboot specifies its own address table", LOG_CPU);

                var header_addr = buf32[offset + 12 >> 2];
                var load_addr = buf32[offset + 16 >> 2];
                var load_end_addr = buf32[offset + 20 >> 2];
                var bss_end_addr = buf32[offset + 24 >> 2];
                var entry_addr = buf32[offset + 28 >> 2];

                dbg_log("header=" + h(header_addr, 8) +
                        " load=" + h(load_addr, 8) +
                        " load_end=" + h(load_end_addr, 8) +
                        " bss_end=" + h(bss_end_addr, 8) +
                        " entry=" + h(entry_addr, 8));

                dbg_assert(load_addr <= header_addr);

                var file_start = offset - (header_addr - load_addr);

                if(load_end_addr === 0)
                {
                    var length = undefined;
                }
                else
                {
                    dbg_assert(load_end_addr >= load_addr);
                    var length = load_end_addr - load_addr;
                }

                const blob = new Uint8Array(buffer, file_start, length);
                cpu.write_blob(blob, load_addr);

                entrypoint = entry_addr | 0;
                top_of_load = Math.max(load_end_addr, bss_end_addr);
            }
            else if(buf32[0] === ELF_MAGIC)
            {
                dbg_log("Multiboot image is in elf format", LOG_CPU);

                const elf = read_elf(buffer);

                entrypoint = elf.header.entry;

                for(const program of elf.program_headers)
                {
                    if(program.type === 0)
                    {
                        // null
                    }
                    else if(program.type === 1)
                    {
                        // load

                        dbg_assert(program.filesz <= program.memsz);

                        if(program.paddr + program.memsz < cpu.memory_size[0])
                        {
                            if(program.filesz) // offset might be outside of buffer if filesz is 0
                            {
                                const blob = new Uint8Array(buffer, program.offset, program.filesz);
                                cpu.write_blob(blob, program.paddr);
                            }
                            top_of_load = Math.max(top_of_load, program.paddr + program.memsz);
                            dbg_log("prg load " + program.paddr + " to " + (program.paddr + program.memsz), LOG_CPU);

                            // Since multiboot specifies that paging is disabled, we load to the physical address;
                            // but the entry point is specified in virtual addresses so adjust the entrypoint if needed

                            if(entrypoint === elf.header.entry && program.vaddr <= entrypoint && (program.vaddr + program.memsz) > entrypoint)
                            {
                                entrypoint = (entrypoint - program.vaddr) + program.paddr;
                            }
                        }
                        else
                        {
                            dbg_log("Warning: Skipped loading section, paddr=" + h(program.paddr) + " memsz=" + program.memsz, LOG_CPU);
                        }
                    }
                    else if(
                        program.type === 2 || // dynamic
                        program.type === 3 || // interp
                        program.type === 4 || // note
                        program.type === 6 || // phdr
                        program.type === 7 || // tls
                        program.type === 0x6474e550 || // gnu_eh_frame
                        program.type === 0x6474e551 || // gnu_stack
                        program.type === 0x6474e552 || // gnu_relro
                        program.type === 0x6474e553)   // gnu_property
                    {
                        dbg_log("skip load type " + program.type + " " + program.paddr + " to " + (program.paddr + program.memsz), LOG_CPU);
                        // ignore for now
                    }
                    else
                    {
                        dbg_assert(false, "unimplemented elf section type: " + h(program.type));
                    }
                }
            }
            else
            {
                dbg_assert(false, "Not a bootable multiboot format");
            }

            if(initrd)
            {
                info |= MULTIBOOT_INFO_MODS;

                cpu.write32(multiboot_info_addr + 20, 1); // mods_count
                cpu.write32(multiboot_info_addr + 24, multiboot_data); // mods_addr;

                var ramdisk_address = top_of_load;
                if((ramdisk_address & 4095) !== 0)
                {
                    ramdisk_address = (ramdisk_address & ~4095) + 4096;
                }
                dbg_log("ramdisk address " + ramdisk_address);
                var ramdisk_top = ramdisk_address + initrd.byteLength;

                cpu.write32(multiboot_data, ramdisk_address); // mod_start
                cpu.write32(multiboot_data + 4, ramdisk_top); // mod_end
                cpu.write32(multiboot_data + 8, 0); // string
                cpu.write32(multiboot_data + 12, 0); // reserved
                multiboot_data += 16;

                dbg_assert(ramdisk_top < cpu.memory_size[0]);

                cpu.write_blob(new Uint8Array(initrd), ramdisk_address);
            }

            cpu.write32(multiboot_info_addr, info);

            // set state for multiboot

            cpu.reg32[REG_EBX] = multiboot_info_addr;
            cpu.cr[0] = 1;
            cpu.protected_mode[0] = +true;
            cpu.flags[0] = FLAGS_DEFAULT;
            cpu.is_32[0] = +true;
            cpu.stack_size_32[0] = +true;

            for(var i = 0; i < 6; i++)
            {
                cpu.segment_is_null[i] = 0;
                cpu.segment_offsets[i] = 0;
                cpu.segment_limits[i] = 0xFFFFFFFF;
                // cpu.segment_access_bytes[i]
                cpu.sreg[i] = i === REG_CS ? 0x08 : 0x10;
            }
            cpu.instruction_pointer[0] = cpu.get_seg_cs() + entrypoint | 0;
            cpu.update_state_flags();
            dbg_log("Starting multiboot kernel at:", LOG_CPU);
            cpu.dump_state();
            cpu.dump_regs_short();

            return MULTIBOOT_BOOTLOADER_MAGIC;
        });

        // only for kvm-unit-test
        this.io.register_write_consecutive(0xF4, this,
            function(value)
            {
                console.log("Test exited with code " + h(value, 2));
                throw "HALT";
            },
            function() {},
            function() {},
            function() {});

        // only for kvm-unit-test
        for(let i = 0; i <= 0xF; i++)
        {
            function handle_write(value)
            {
                dbg_log("kvm-unit-test: Set irq " + h(i) + " to " + h(value, 2));
                if(value)
                {
                    this.device_raise_irq(i);
                }
                else
                {
                    this.device_lower_irq(i);
                }
            }

            this.io.register_write(0x2000 + i, this, handle_write, handle_write, handle_write);
        }

        // This rom will be executed by seabios after its initialisation
        // It sets up the multiboot environment.
        const SIZE = 0x200;

        const data8 = new Uint8Array(SIZE);
        const data16 = new Uint16Array(data8.buffer);

        data16[0] = 0xAA55;
        data8[2] = SIZE / 0x200;
        let i = 3;
        // trigger load
        data8[i++] = 0x66; // in 0xF4
        data8[i++] = 0xE5;
        data8[i++] = 0xF4;

        dbg_assert(i < SIZE);

        const checksum_index = i;
        data8[checksum_index] = 0;

        let rom_checksum = 0;

        for(let i = 0; i < data8.length; i++)
        {
            rom_checksum += data8[i];
        }

        data8[checksum_index] = -rom_checksum;

        return {
            name: "genroms/multiboot.bin",
            data: data8
        };
    }
    dbg_log("Multiboot header not found", LOG_CPU);
};

CPU.prototype.fill_cmos = function(rtc, settings)
{
    var boot_order = settings.boot_order || BOOT_ORDER_CD_FIRST;

    // Used by seabios to determine the boot order
    //   Nibble
    //   1: FloppyPrio
    //   2: HDPrio
    //   3: CDPrio
    //   4: BEVPrio
    // bootflag 1, high nibble, lowest priority
    // Low nibble: Disable floppy signature check (1)
    rtc.cmos_write(CMOS_BIOS_BOOTFLAG1 , 1 | boot_order >> 4 & 0xF0);

    // bootflag 2, both nibbles, high and middle priority
    rtc.cmos_write(CMOS_BIOS_BOOTFLAG2, boot_order & 0xFF);

    // 640k or less if less memory is used
    rtc.cmos_write(CMOS_MEM_BASE_LOW, 640 & 0xFF);
    rtc.cmos_write(CMOS_MEM_BASE_HIGH, 640 >> 8);

    const low_memory = this.low_memory_size;
    // (above 4 GiB: relocated RAM, then extended RAM)
    const high_memory = this.memory_size[0] - low_memory + this.extended_pages * 4096;
    var memory_above_1m = 0; // in k
    if(low_memory >= 1024 * 1024)
    {
        memory_above_1m = (low_memory - 1024 * 1024) >> 10;
        memory_above_1m = Math.min(memory_above_1m, 0xFFFF);
    }

    rtc.cmos_write(CMOS_MEM_OLD_EXT_LOW, memory_above_1m & 0xFF);
    rtc.cmos_write(CMOS_MEM_OLD_EXT_HIGH, memory_above_1m >> 8 & 0xFF);
    rtc.cmos_write(CMOS_MEM_EXTMEM_LOW, memory_above_1m & 0xFF);
    rtc.cmos_write(CMOS_MEM_EXTMEM_HIGH, memory_above_1m >> 8 & 0xFF);

    var memory_above_16m = 0; // in 64k blocks
    if(low_memory >= 16 * 1024 * 1024)
    {
        memory_above_16m = (low_memory - 16 * 1024 * 1024) >> 16;
        memory_above_16m = Math.min(memory_above_16m, 0xFFFF);
    }
    rtc.cmos_write(CMOS_MEM_EXTMEM2_LOW, memory_above_16m & 0xFF);
    rtc.cmos_write(CMOS_MEM_EXTMEM2_HIGH, memory_above_16m >> 8 & 0xFF);

    // memory above 4G, in 64k blocks (high_memory_size relocates it there)
    rtc.cmos_write(CMOS_MEM_HIGHMEM_LOW, Math.floor(high_memory / 0x10000) & 0xFF);
    rtc.cmos_write(CMOS_MEM_HIGHMEM_MID, Math.floor(high_memory / 0x1000000) & 0xFF);
    rtc.cmos_write(CMOS_MEM_HIGHMEM_HIGH, Math.floor(high_memory / 0x100000000) & 0xFF);

    rtc.cmos_write(CMOS_EQUIPMENT_INFO, 0x2F);

    rtc.cmos_write(CMOS_BIOS_SMP_COUNT, this.platform.cores - 1);

    // Used by bochs BIOS to skip the boot menu delay.
    if(settings.fastboot) rtc.cmos_write(0x3f, 0x01);
};

CPU.prototype.load_bios = function()
{
    var bios = this.bios.main;
    var vga_bios = this.bios.vga;

    if(!bios)
    {
        dbg_log("Warning: No BIOS");
        return;
    }

    dbg_assert(bios instanceof ArrayBuffer);

    // load bios
    var data = new Uint8Array(bios),
        start = 0x100000 - bios.byteLength;

    this.write_blob(data, start);

    const adapter = this.graphics_adapter_descriptor;
    if(vga_bios && !adapter)
    {
        dbg_log("Warning: VGA BIOS not loaded: graphics_adapter is \"none\"");
    }
    else if(vga_bios)
    {
        dbg_assert(vga_bios instanceof ArrayBuffer);

        // load vga bios, its PCI ROM header naming the adapter's device
        var vga_bios8 = new Uint8Array(vga_bios).slice();
        patch_vga_bios_ids(vga_bios8, adapter["pci_vendor"], adapter["pci_device"]);

        // older versions of seabios
        this.write_blob(vga_bios8, 0xC0000);

        // newer versions of seabios (needs to match pci rom address, see
        // vga_core.js). One block of the memory map, no more: SeaBIOS puts
        // other devices' BARs right above the ROM (virtio-vga's capabilities),
        // and this runs again at every reset
        this.io.mmap_register(0xFEB00000, 0x20000,
            function(addr)
            {
                addr = (addr - 0xFEB00000) | 0;
                if(addr < vga_bios8.length)
                {
                    return vga_bios8[addr];
                }
                else
                {
                    return 0;
                }
            },
            function(addr, value)
            {
                dbg_assert(false, "Unexpected write to VGA rom");
            });
    }
    else
    {
        dbg_log("Warning: No VGA BIOS");
    }

    // seabios expects the bios to be mapped to 0xFFF00000 also
    this.io.mmap_register(0xFFF00000, 0x100000,
        function(addr)
        {
            addr &= 0xFFFFF;
            return this.mem8[addr];
        }.bind(this),
        function(addr, value)
        {
            addr &= 0xFFFFF;
            this.mem8[addr] = value;
        }.bind(this));
};

CPU.prototype.run_hardware_timers = function(acpi_enabled, now)
{
    const pit_time = this.devices.pit.timer(now, false);
    const rtc_time = this.devices.rtc.timer(now, false);
    const display_time = this.devices.display.timer(now);
    const hpet_time = this.devices.hpet ? this.devices.hpet.timer(now) : 100;

    let acpi_time = 100;
    let apic_time = 100;
    if(acpi_enabled)
    {
        acpi_time = this.devices.acpi.timer(now);
        apic_time = this.apic_timer(now);
    }

    return Math.min(pit_time, rtc_time, display_time, hpet_time, acpi_time, apic_time);
};

CPU.prototype.debug_init = function()
{
    if(!DEBUG) return;

    if(this.io)
    {
        // write seabios debug output to console
        var seabios_debug = "";

        this.io.register_write(0x402, this, handle); // seabios
        this.io.register_write(0x500, this, handle); // vgabios
    }

    function handle(out_byte)
    {
        if(out_byte === 10)
        {
            dbg_log(seabios_debug, LOG_BIOS);
            seabios_debug = "";
        }
        else
        {
            seabios_debug += String.fromCharCode(out_byte);
        }
    }
};

CPU.prototype.dump_stack = function(start, end)
{
    if(!DEBUG) return;

    var esp = this.reg32[REG_ESP];
    dbg_log("========= STACK ==========");

    if(end >= start || end === undefined)
    {
        start = 5;
        end = -5;
    }

    for(var i = start; i > end; i--)
    {
        var line = "    ";

        if(!i) line = "=>  ";

        line += h(i, 2) + " | ";

        dbg_log(line + h(esp + 4 * i, 8) + " | " + h(this.read32s(esp + 4 * i) >>> 0));
    }
};

/** @param {string=} where */
CPU.prototype.debug_get_state = function(where)
{
    if(!DEBUG) return;

    var mode = this.protected_mode[0] ? "prot" : "real";
    var vm = (this.flags[0] & FLAG_VM) ? 1 : 0;
    var flags = this.get_eflags();
    var iopl = this.getiopl();
    var cpl = this.cpl[0];
    var cs_eip = h(this.sreg[REG_CS], 4) + ":" + h(this.get_real_eip() >>> 0, 8);
    var ss_esp = h(this.sreg[REG_SS], 4) + ":" + h(this.reg32[REG_ES] >>> 0, 8);
    var op_size = this.is_32[0] ? "32" : "16";
    var if_ = (this.flags[0] & FLAG_INTERRUPT) ? 1 : 0;

    var flag_names = {
        [FLAG_CARRY]: "c",
        [FLAG_PARITY]: "p",
        [FLAG_ADJUST]: "a",
        [FLAG_ZERO]: "z",
        [FLAG_SIGN]: "s",
        [FLAG_TRAP]: "t",
        [FLAG_INTERRUPT]: "i",
        [FLAG_DIRECTION]: "d",
        [FLAG_OVERFLOW]: "o",
    };
    var flag_string = "";

    for(var i = 0; i < 16; i++)
    {
        if(flag_names[1 << i])
        {
            if(flags & 1 << i)
            {
                flag_string += flag_names[1 << i];
            }
            else
            {
                flag_string += " ";
            }
        }
    }

    return ("mode=" + mode + "/" + op_size + " paging=" + (+((this.cr[0] & CR0_PG) !== 0)) +
        " pae=" + (+((this.cr[4] & CR4_PAE) !== 0)) +
        " iopl=" + iopl + " cpl=" + cpl + " if=" + if_ + " cs:eip=" + cs_eip +
        " cs_off=" + h(this.get_seg_cs() >>> 0, 8) +
        " flgs=" + h(this.get_eflags() >>> 0, 6) + " (" + flag_string + ")" +
        " ss:esp=" + ss_esp +
        " ssize=" + (+this.stack_size_32[0]) +
        (where ? " in " + where : ""));
};

/** @param {string=} where */
CPU.prototype.dump_state = function(where)
{
    if(!DEBUG) return;

    dbg_log(this.debug_get_state(where), LOG_CPU);
};

CPU.prototype.get_regs_short = function()
{
    if(!DEBUG) return;

    var
    r32 = { "eax": REG_EAX, "ecx": REG_ECX, "edx": REG_EDX, "ebx": REG_EBX,
        "esp": REG_ESP, "ebp": REG_EBP, "esi": REG_ESI, "edi": REG_EDI },
        r32_names = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"],
        s = { "cs": REG_CS, "ds": REG_DS, "es": REG_ES, "fs": REG_FS, "gs": REG_GS, "ss": REG_SS },
        line1 = "",
        line2 = "";

    for(var i = 0; i < 4; i++)
    {
        line1 += r32_names[i] + "="  + h(this.reg32[r32[r32_names[i]]] >>> 0, 8) + " ";
        line2 += r32_names[i+4] + "="  + h(this.reg32[r32[r32_names[i+4]]] >>> 0, 8) + " ";
    }

    //line1 += " eip=" + h(this.get_real_eip() >>> 0, 8);
    //line2 += " flg=" + h(this.get_eflags(), 8);

    line1 += "  ds=" + h(this.sreg[REG_DS], 4) + " es=" + h(this.sreg[REG_ES], 4) + " fs=" + h(this.sreg[REG_FS], 4);
    line2 += "  gs=" + h(this.sreg[REG_GS], 4) + " cs=" + h(this.sreg[REG_CS], 4) + " ss=" + h(this.sreg[REG_SS], 4);

    return [line1, line2];
};

CPU.prototype.dump_regs_short = function()
{
    if(!DEBUG) return;

    var lines = this.get_regs_short();

    dbg_log(lines[0], LOG_CPU);
    dbg_log(lines[1], LOG_CPU);
};

CPU.prototype.dump_gdt_ldt = function()
{
    if(!DEBUG) return;

    dbg_log("gdt: (len = " + h(this.gdtr_size[0]) + ")");
    dump_table(this.translate_address_system_read(this.gdtr_offset[0]), this.gdtr_size[0]);

    dbg_log("\nldt: (len = " + h(this.segment_limits[REG_LDTR]) + ")");
    dump_table(this.translate_address_system_read(this.segment_offsets[REG_LDTR]), this.segment_limits[REG_LDTR]);

    function dump_table(addr, size)
    {
        for(var i = 0; i < size; i += 8, addr += 8)
        {
            var base = this.read16(addr + 2) |
                this.read8(addr + 4) << 16 |
                this.read8(addr + 7) << 24,

                limit = this.read16(addr) | (this.read8(addr + 6) & 0xF) << 16,
                access = this.read8(addr + 5),
                flags = this.read8(addr + 6) >> 4,
                flags_str = "",
                dpl = access >> 5 & 3;

            if(!(access & 128))
            {
                // present bit not set
                //continue;
                flags_str += "NP ";
            }
            else
            {
                flags_str += " P ";
            }

            if(access & 16)
            {
                if(flags & 4)
                {
                    flags_str += "32b ";
                }
                else
                {
                    flags_str += "16b ";
                }

                if(access & 8)
                {
                    // executable
                    flags_str += "X ";

                    if(access & 4)
                    {
                        flags_str += "C ";
                    }
                }
                else
                {
                    // data
                    flags_str += "R ";
                }

                flags_str += "RW ";
            }
            else
            {
                // system
                flags_str += "sys: " + h(access & 15);
            }

            if(flags & 8)
            {
                limit = limit << 12 | 0xFFF;
            }

            dbg_log(h(i & ~7, 4) + " " + h(base >>> 0, 8) + " (" + h(limit >>> 0, 8) + " bytes) " +
                flags_str + ";  dpl = " + dpl + ", a = " + access.toString(2) +
                ", f = " + flags.toString(2));
        }
    }
};

CPU.prototype.dump_idt = function()
{
    if(!DEBUG) return;

    for(var i = 0; i < this.idtr_size[0]; i += 8)
    {
        var addr = this.translate_address_system_read(this.idtr_offset[0] + i),
            base = this.read16(addr) | this.read16(addr + 6) << 16,
            selector = this.read16(addr + 2),
            type = this.read8(addr + 5),
            line,
            dpl = type >> 5 & 3;

        if((type & 31) === 5)
        {
            line = "task gate ";
        }
        else if((type & 31) === 14)
        {
            line = "intr gate ";
        }
        else if((type & 31) === 15)
        {
            line = "trap gate ";
        }
        else
        {
            line = "invalid   ";
        }


        if(type & 128)
        {
            line += " P";
        }
        else
        {
            // present bit not set
            //continue;
            line += "NP";
        }


        dbg_log(h(i >> 3, 4) + " " + h(base >>> 0, 8) + ", " +
            h(selector, 4) + "; " + line + ";  dpl = " + dpl + ", t = " + type.toString(2));
    }
};

CPU.prototype.dump_page_structures = function()
{
    var pae = !!(this.cr[4] & CR4_PAE);
    if(pae)
    {
        dbg_log("PAE enabled");

        for(var i = 0; i < 4; i++) {
            var addr = this.cr[3] + 8 * i;
            var dword = this.read32s(addr);
            if(dword & 1)
            {
                this.dump_page_directory(dword & 0xFFFFF000, true, i << 30);
            }
        }
    }
    else
    {
        dbg_log("PAE disabled");
        this.dump_page_directory(this.cr[3], false, 0);
    }
};

// NOTE: PAE entries are 64-bits, we ignore the high half here.
CPU.prototype.dump_page_directory = function(pd_addr, pae, start)
{
    if(!DEBUG) return;

    function load_page_entry(dword_entry, pae, is_directory)
    {
        if(!DEBUG) return;

        if(!(dword_entry & 1))
        {
            // present bit not set
            return false;
        }

        var size = (dword_entry & 128) === 128,
            address;

        if(size && !is_directory)
        {
            address = dword_entry & (pae ? 0xFFE00000 : 0xFFC00000);
        }
        else
        {
            address = dword_entry & 0xFFFFF000;
        }

        return {
            size: size,
            global: (dword_entry & 256) === 256,
            accessed: (dword_entry & 0x20) === 0x20,
            dirty: (dword_entry & 0x40) === 0x40,
            cache_disable : (dword_entry & 16) === 16,
            user : (dword_entry & 4) === 4,
            read_write : (dword_entry & 2) === 2,
            address : address >>> 0
        };
    }

    var n = pae ? 512 : 1024;
    var entry_size = pae ? 8 : 4;
    var pd_shift = pae ? 21 : 22;

    for(var i = 0; i < n; i++)
    {
        var addr = pd_addr + i * entry_size,
            dword = this.read32s(addr),
            entry = load_page_entry(dword, pae, true);

        if(!entry)
        {
            continue;
        }

        var flags = "";

        flags += entry.size ? "S " : "  ";
        flags += entry.accessed ? "A " : "  ";
        flags += entry.cache_disable ? "Cd " : "  ";
        flags += entry.user ? "U " : "  ";
        flags += entry.read_write ? "Rw " : "   ";

        if(entry.size)
        {
            dbg_log("=== " + h(start + (i << pd_shift) >>> 0, 8) + " -> " +
                h(entry.address >>> 0, 8) + " | " + flags);
            continue;
        }
        else
        {
            dbg_log("=== " + h(start + (i << pd_shift) >>> 0, 8) + " | " + flags);
        }

        for(var j = 0; j < n; j++)
        {
            var sub_addr = entry.address + j * entry_size;
            dword = this.read32s(sub_addr);

            var subentry = load_page_entry(dword, pae, false);

            if(subentry)
            {
                flags = "";

                flags += subentry.cache_disable ? "Cd " : "   ";
                flags += subentry.user ? "U " : "  ";
                flags += subentry.read_write ? "Rw " : "   ";
                flags += subentry.global ? "G " : "  ";
                flags += subentry.accessed ? "A " : "  ";
                flags += subentry.dirty ? "Di " : "   ";

                dbg_log("# " + h(start + (i << pd_shift | j << 12) >>> 0, 8) + " -> " +
                    h(subentry.address, 8) + " | " + flags + "        (at " + h(sub_addr, 8) + ")");
            }
        }
    }
};

CPU.prototype.get_memory_dump = function(start, count)
{
    if(!DEBUG) return;

    if(start === undefined)
    {
        start = 0;
        count = this.memory_size[0];
    }
    else if(count === undefined)
    {
        count = start;
        start = 0;
    }

    return this.mem8.slice(start, start + count).buffer;
};

CPU.prototype.memory_hex_dump = function(addr, length)
{
    if(!DEBUG) return;

    length = length || 4 * 0x10;
    var line, byt;

    for(var i = 0; i < length >> 4; i++)
    {
        line = h(addr + (i << 4), 5) + "   ";

        for(var j = 0; j < 0x10; j++)
        {
            byt = this.read8(addr + (i << 4) + j);
            line += h(byt, 2) + " ";
        }

        line += "  ";

        for(j = 0; j < 0x10; j++)
        {
            byt = this.read8(addr + (i << 4) + j);
            line += (byt < 33 || byt > 126) ? "." : String.fromCharCode(byt);
        }

        dbg_log(line);
    }
};

CPU.prototype.used_memory_dump = function()
{
    if(!DEBUG) return;

    var width = 0x80,
        height = 0x10,
        block_size = this.memory_size[0] / width / height | 0,
        row;

    for(var i = 0; i < height; i++)
    {
        row = h(i * width * block_size, 8) + " | ";

        for(var j = 0; j < width; j++)
        {
            var used = this.mem32s[(i * width + j) * block_size] > 0;

            row += used ? "X" : " ";
        }

        dbg_log(row);
    }
};

CPU.prototype.debug_interrupt = function(interrupt_nr)
{
    //if(interrupt_nr === 0x20)
    //{
    //    //var vxd_device = this.safe_read16(this.instruction_pointer + 2);
    //    //var vxd_sub = this.safe_read16(this.instruction_pointer + 0);
    //    //var service = "";
    //    //if(vxd_device === 1)
    //    //{
    //    //    service = vxd_table1[vxd_sub];
    //    //}
    //    //dbg_log("vxd: " + h(vxd_device, 4) + " " + h(vxd_sub, 4) + " " + service);
    //}

    //if(interrupt_nr >= 0x21 && interrupt_nr < 0x30)
    //{
    //    dbg_log("dos: " + h(interrupt_nr, 2) + " ah=" + h(this.reg8[reg_ah], 2) + " ax=" + h(this.reg16[reg_ax], 4));
    //}

    //if(interrupt_nr === 0x13 && (this.reg8[reg_ah] | 1) === 0x43)
    //{
    //    this.debug.memory_hex_dump(this.get_seg(reg_ds) + this.reg16[reg_si], 0x18);
    //}

    //if(interrupt_nr == 0x10)
    //{
    //    dbg_log("int10 ax=" + h(this.reg16[reg_ax], 4) + " '" + String.fromCharCode(this.reg8[reg_al]) + "'");
    //    this.debug.dump_regs_short();
    //    if(this.reg8[reg_ah] == 0xe) vga.tt_write(this.reg8[reg_al]);
    //}

    //if(interrupt_nr === 0x13)
    //{
    //    this.debug.dump_regs_short();
    //}

    //if(interrupt_nr === 6)
    //{
    //    this.instruction_pointer += 2;
    //    dbg_log("BUG()", LOG_CPU);
    //    dbg_log("line=" + this.read_imm16() + " " +
    //            "file=" + this.read_string(this.translate_address_read(this.read_imm32s())), LOG_CPU);
    //    this.instruction_pointer -= 8;
    //    this.debug.dump_regs_short();
    //}

    //if(interrupt_nr === 0x80)
    //{
    //    dbg_log("linux syscall");
    //    this.debug.dump_regs_short();
    //}

    //if(interrupt_nr === 0x40)
    //{
    //    dbg_log("kolibri syscall");
    //    this.debug.dump_regs_short();
    //}
};
