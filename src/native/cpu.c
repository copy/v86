#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "const.h"
#include "cpu.h"
#include "global_pointers.h"
#include "instructions.h"
#include "js_imports.h"
#include "log.h"
#include "memory.h"
#include "misc_instr.h"
#include "modrm.h"
#include "profiler/profiler.h"
#include "rust_imports.h"
#include "shared.h"

const int32_t FLAG_CARRY = 1;
const int32_t FLAG_PARITY = 4;
const int32_t FLAG_ADJUST = 16;
const int32_t FLAG_ZERO = 64;
const int32_t FLAG_SIGN = 128;
const int32_t FLAG_TRAP = 256;
const int32_t FLAG_INTERRUPT = 512;
const int32_t FLAG_DIRECTION = 1024;
const int32_t FLAG_OVERFLOW = 2048;
const int32_t FLAG_IOPL = (1 << 12 | 1 << 13);
const int32_t FLAG_NT = (1 << 14);
const int32_t FLAG_RF = (1 << 16);
const int32_t FLAG_VM = (1 << 17);
const int32_t FLAG_AC = (1 << 18);
const int32_t FLAG_VIF = (1 << 19);
const int32_t FLAG_VIP = (1 << 20);
const int32_t FLAG_ID = (1 << 21);
const int32_t FLAGS_DEFAULT = (1 << 1);

const int32_t FLAGS_MASK = (
    FLAG_CARRY | FLAG_PARITY | FLAG_ADJUST | FLAG_ZERO | FLAG_SIGN | FLAG_TRAP | FLAG_INTERRUPT |
    FLAG_DIRECTION | FLAG_OVERFLOW | FLAG_IOPL | FLAG_NT | FLAG_RF | FLAG_VM | FLAG_AC |
    FLAG_VIF | FLAG_VIP | FLAG_ID);

const int32_t FLAGS_ALL = (FLAG_CARRY | FLAG_PARITY | FLAG_ADJUST | FLAG_ZERO | FLAG_SIGN | FLAG_OVERFLOW);

const int32_t OPSIZE_8 = 7;
const int32_t OPSIZE_16 = 15;
const int32_t OPSIZE_32 = 31;

const int32_t EAX = 0;
const int32_t ECX = 1;
const int32_t EDX = 2;
const int32_t EBX = 3;
const int32_t ESP = 4;
const int32_t EBP = 5;
const int32_t ESI = 6;
const int32_t EDI = 7;

const int32_t AX = 0;
const int32_t CX = 2;
const int32_t DX = 4;
const int32_t BX = 6;
const int32_t SP = 8;
const int32_t BP = 10;
const int32_t SI = 12;
const int32_t DI = 14;

const int32_t AL = 0;
const int32_t CL = 4;
const int32_t DL = 8;
const int32_t BL = 12;
const int32_t AH = 1;
const int32_t CH = 5;
const int32_t DH = 9;
const int32_t BH = 13;

const int32_t ES = 0;
const int32_t CS = 1;
const int32_t SS = 2;
const int32_t DS = 3;
const int32_t FS = 4;
const int32_t GS = 5;

const int32_t TR = 6;
const int32_t LDTR = 7;


const int32_t PAGE_TABLE_PRESENT_MASK = (1 << 0);
const int32_t PAGE_TABLE_RW_MASK = (1 << 1);
const int32_t PAGE_TABLE_USER_MASK = (1 << 2);
const int32_t PAGE_TABLE_ACCESSED_MASK = (1 << 5);
const int32_t PAGE_TABLE_DIRTY_MASK = (1 << 6);
const int32_t PAGE_TABLE_PSE_MASK = (1 << 7);
const int32_t PAGE_TABLE_GLOBAL_MASK = (1 << 8);

const int32_t MMAP_BLOCK_BITS = 17;
const int32_t MMAP_BLOCK_SIZE = (1 << MMAP_BLOCK_BITS);

const int32_t CR0_PE = 1;
const int32_t CR0_MP = (1 << 1);
const int32_t CR0_EM = (1 << 2);
const int32_t CR0_TS = (1 << 3);
const int32_t CR0_ET = (1 << 4);
const int32_t CR0_WP = (1 << 16);
const int32_t CR0_NW = (1 << 29);
const int32_t CR0_CD = (1 << 30);
const int32_t CR0_PG = (1 << 31);

const int32_t CR4_VME = (1);
const int32_t CR4_PVI = (1 << 1);
const int32_t CR4_TSD = (1 << 2);
const int32_t CR4_PSE = (1 << 4);
const int32_t CR4_DE = (1 << 3);
const int32_t CR4_PAE = (1 << 5);
const int32_t CR4_PGE = (1 << 7);


const int32_t IA32_SYSENTER_CS = 0x174;
const int32_t IA32_SYSENTER_ESP = 0x175;
const int32_t IA32_SYSENTER_EIP = 0x176;

const int32_t IA32_TIME_STAMP_COUNTER = 0x10;
const int32_t IA32_PLATFORM_ID = 0x17;
const int32_t IA32_APIC_BASE_MSR = 0x1B;
const int32_t IA32_BIOS_SIGN_ID = 0x8B;
const int32_t MSR_PLATFORM_INFO = 0xCE;
const int32_t MSR_MISC_FEATURE_ENABLES = 0x140;
const int32_t IA32_MISC_ENABLE = 0x1A0;
const int32_t IA32_RTIT_CTL = 0x570;
const int32_t MSR_SMI_COUNT = 0x34;
const int32_t IA32_MCG_CAP = 0x179;
const int32_t IA32_KERNEL_GS_BASE = 0xC0000101;
const int32_t MSR_PKG_C2_RESIDENCY = 0x60D;

const int32_t IA32_APIC_BASE_BSP = (1 << 8);
const int32_t IA32_APIC_BASE_EXTD = (1 << 10);
const int32_t IA32_APIC_BASE_EN = (1 << 11);


// Note: Duplicated in apic.js
const int32_t APIC_ADDRESS = ((int32_t)0xFEE00000);


// Segment prefixes must not collide with reg_*s variables
// _ZERO is a special zero offset segment
const int32_t SEG_PREFIX_NONE = (-1);
const int32_t SEG_PREFIX_ZERO = 7;

const int32_t PREFIX_MASK_REP = 0b11000;
const int32_t PREFIX_REPZ = 0b01000;
const int32_t PREFIX_REPNZ = 0b10000;

const int32_t PREFIX_MASK_SEGMENT = 0b111;
const int32_t PREFIX_MASK_OPSIZE = 0b100000;
const int32_t PREFIX_MASK_ADDRSIZE = 0b1000000;

// aliases
const int32_t PREFIX_F2 = PREFIX_REPNZ;
const int32_t PREFIX_F3 = PREFIX_REPZ;
const int32_t PREFIX_66 = PREFIX_MASK_OPSIZE;

const int32_t LOG_CPU =    0x000002;

const int32_t A20_MASK = (~(1 << 20));
const int32_t A20_MASK16 = (~(1 << (20 - 1)));
const int32_t A20_MASK32 = (~(1 << (20 - 2)));

const int32_t MXCSR_MASK = (0xFFFF & ~(1 << 6));

const int32_t CPU_EXCEPTION_DE = 0;  // Divide Error
const int32_t CPU_EXCEPTION_DB = 1;  // Debug Exception
const int32_t CPU_EXCEPTION_NMI = 2; // NMI Interrupt
const int32_t CPU_EXCEPTION_BP = 3;  // Breakpoint
const int32_t CPU_EXCEPTION_OF = 4;  // Overflow
const int32_t CPU_EXCEPTION_BR = 5;  // BOUND Range Exceeded
const int32_t CPU_EXCEPTION_UD = 6;  // Invalid Opcode
const int32_t CPU_EXCEPTION_NM = 7;  // Device Not Available
const int32_t CPU_EXCEPTION_DF = 8;  // Double Fault
const int32_t CPU_EXCEPTION_TS = 10; // Invalid TSS
const int32_t CPU_EXCEPTION_NP = 11; // Segment Not Present
const int32_t CPU_EXCEPTION_SS = 12; // Stack-Segment Fault
const int32_t CPU_EXCEPTION_GP = 13; // General Protection
const int32_t CPU_EXCEPTION_PF = 14; // Page Fault
const int32_t CPU_EXCEPTION_MF = 16; // x87 FPU Floating-Point Error
const int32_t CPU_EXCEPTION_AC = 17; // Alignment Check
const int32_t CPU_EXCEPTION_MC = 18; // Machine Check Abort
const int32_t CPU_EXCEPTION_XM = 19; // SIMD Floating-Point Exception
const int32_t CPU_EXCEPTION_VE = 20; // Virtualization Exception

const int32_t LOOP_COUNTER = 20011;
const double_t TSC_RATE = (50 * 1000);

const bool CHECK_TLB_INVARIANTS = false;

const bool DEBUG = true;

const int32_t TLB_VALID = (1 << 0);
const int32_t TLB_READONLY = (1 << 1);
const int32_t TLB_NO_USER = (1 << 2);
const int32_t TLB_IN_MAPPED_RANGE = (1 << 3);
const int32_t TLB_GLOBAL = (1 << 4);
const int32_t TLB_HAS_CODE = (1 << 5);


uint8_t* mem8 = NULL;
uint16_t* mem16 = NULL;
int32_t* mem32s = NULL;

bool must_not_fault = false;

#if 1
int32_t current_cpu_exception = -1;
void assert_no_cpu_exception() {
    if(current_cpu_exception != -1)
    {
        dbg_log1("Expected no cpu exception, got %d", current_cpu_exception);
        dbg_trace();
        assert(false);
    }
}
void set_current_cpu_exception(int32_t n) { current_cpu_exception = n; }
void clear_current_cpu_exception() { current_cpu_exception = -1; }
#else
void assert_no_cpu_exception() {}
void set_current_cpu_exception(int32_t n) { UNUSED(n); }
void clear_current_cpu_exception() {  }
#endif

uint64_t tsc_offset = 0;

bool jit_block_boundary = false;

const int32_t VALID_TLB_ENTRY_MAX = 10000;
int32_t valid_tlb_entries[VALID_TLB_ENTRY_MAX] = {0};
int32_t valid_tlb_entries_count = 0;

void after_block_boundary()
{
    jit_block_boundary = true;
}

int32_t get_eflags()
{
    return (*flags & ~FLAGS_ALL) | !!getcf() | !!getpf() << 2 | !!getaf() << 4 |
                                  !!getzf() << 6 | !!getsf() << 7 | !!getof() << 11;
}

int32_t getiopl(void)
{
    return *flags >> 12 & 3;
}

bool vm86_mode(void)
{
    return (*flags & FLAG_VM) == FLAG_VM;
}

/*
 * Update the flags register depending on iopl and cpl
 */
void update_eflags(int32_t new_flags)
{
    int32_t dont_update = FLAG_RF | FLAG_VM | FLAG_VIP | FLAG_VIF;
    int32_t clear = ~FLAG_VIP & ~FLAG_VIF & FLAGS_MASK;

    if(*flags & FLAG_VM)
    {
        // other case needs to be handled in popf or iret
        dbg_assert(getiopl() == 3);

        dont_update |= FLAG_IOPL;

        // don't clear vip or vif
        clear |= FLAG_VIP | FLAG_VIF;
    }
    else
    {
        if(!*protected_mode) dbg_assert(*cpl == 0);

        if(*cpl)
        {
            // cpl > 0
            // cannot update iopl
            dont_update |= FLAG_IOPL;

            if(*cpl > getiopl())
            {
                // cpl > iopl
                // cannot update interrupt flag
                dont_update |= FLAG_INTERRUPT;
            }
        }
    }

    *flags = (new_flags ^ ((*flags ^ new_flags) & dont_update)) & clear | FLAGS_DEFAULT;

    *flags_changed = 0;
}

void trigger_pagefault(bool write, bool user, bool present)
{
    if(0 * 0)
    {
        dbg_log5("page fault w=%d u=%d p=%d eip=%x cr2=%x",
                write, user, present, *previous_ip, cr[2]);
        dbg_trace();
    }

if( DEBUG) {
    if(must_not_fault)
    {
        dbg_log("Unexpected page fault");
        dbg_trace();
        assert(false);
    }
}

    if(*page_fault)
    {
        dbg_log("double fault");
        dbg_trace();
        assert(false);
    }

    // invalidate tlb entry
    int32_t page = (uint32_t)cr[2] >> 12;
    tlb_data[page] = 0;

    *instruction_pointer = *previous_ip;
    *page_fault = true;
    call_interrupt_vector(CPU_EXCEPTION_PF, false, true, user << 2 | write << 1 | present);

    profiler_stat_increment(S_TRIGGER_CPU_EXCEPTION);
    throw_cpu_exception();
}

int32_t do_page_translation(int32_t addr, bool for_writing, bool user)
{
    bool can_write = true;
    bool global;
    bool allow_user = true;

    int32_t page = (uint32_t)addr >> 12;
    int32_t high;

    if((cr[0] & CR0_PG) == 0)
    {
        // paging disabled
        high = addr & 0xFFFFF000;
        global = false;
    }
    else
    {
        int32_t page_dir_addr = ((uint32_t)cr[3] >> 2) + (page >> 10);
        int32_t page_dir_entry = read_aligned32(page_dir_addr);

        // XXX
        const bool kernel_write_override = !user && !(cr[0] & CR0_WP);

        if(!(page_dir_entry & PAGE_TABLE_PRESENT_MASK))
        {
            // to do at this place:
            //
            // - set cr2 = addr (which caused the page fault)
            // - call_interrupt_vector  with id 14, error code 0-7 (requires information if read or write)
            // - prevent execution of the function that triggered this call
            //dbg_log("#PF not present", LOG_CPU);

            cr[2] = addr;
            trigger_pagefault(for_writing, user, 0);

            // never reached as trigger_pagefault throws
            dbg_assert(false);
        }

        if((page_dir_entry & PAGE_TABLE_RW_MASK) == 0 && !kernel_write_override)
        {
            can_write = false;

            if(for_writing)
            {
                cr[2] = addr;
                trigger_pagefault(for_writing, user, 1);
                dbg_assert(false);
            }
        }

        if((page_dir_entry & PAGE_TABLE_USER_MASK) == 0)
        {
            allow_user = false;

            if(user)
            {
                // "Page Fault: page table accessed by non-supervisor";
                //dbg_log("#PF supervisor", LOG_CPU);
                cr[2] = addr;
                trigger_pagefault(for_writing, user, 1);
                dbg_assert(false);
            }
        }

        if((page_dir_entry & PAGE_TABLE_PSE_MASK) && (cr[4] & CR4_PSE))
        {
            // size bit is set

            // set the accessed and dirty bits
            write_aligned32(page_dir_addr, page_dir_entry | PAGE_TABLE_ACCESSED_MASK |
                (for_writing ? PAGE_TABLE_DIRTY_MASK : 0));

            high = (page_dir_entry & 0xFFC00000) | (addr & 0x3FF000);
            global = (page_dir_entry & PAGE_TABLE_GLOBAL_MASK) == PAGE_TABLE_GLOBAL_MASK;
        }
        else
        {
            int32_t page_table_addr = ((uint32_t)(page_dir_entry & 0xFFFFF000) >> 2) + (page & 0x3FF);
            int32_t page_table_entry = read_aligned32(page_table_addr);

            if((page_table_entry & PAGE_TABLE_PRESENT_MASK) == 0)
            {
                //dbg_log("#PF not present table", LOG_CPU);
                cr[2] = addr;
                trigger_pagefault(for_writing, user, 0);
                dbg_assert(false);
            }

            if((page_table_entry & PAGE_TABLE_RW_MASK) == 0 && !kernel_write_override)
            {
                can_write = false;

                if(for_writing)
                {
                    //dbg_log("#PF not writable page", LOG_CPU);
                    cr[2] = addr;
                    trigger_pagefault(for_writing, user, 1);
                    dbg_assert(false);
                }
            }

            if((page_table_entry & PAGE_TABLE_USER_MASK) == 0)
            {
                allow_user = false;

                if(user)
                {
                    //dbg_log("#PF not supervisor page", LOG_CPU);
                    cr[2] = addr;
                    trigger_pagefault(for_writing, user, 1);
                    dbg_assert(false);
                }
            }

            // set the accessed and dirty bits
            write_aligned32(page_dir_addr, page_dir_entry | PAGE_TABLE_ACCESSED_MASK);
            write_aligned32(page_table_addr,
                    page_table_entry | PAGE_TABLE_ACCESSED_MASK |
                    (for_writing ? PAGE_TABLE_DIRTY_MASK : 0));

            high = page_table_entry & 0xFFFFF000;
            global = (page_table_entry & PAGE_TABLE_GLOBAL_MASK) == PAGE_TABLE_GLOBAL_MASK;
        }
    }

    if(tlb_data[page] == 0)
    {
        if(valid_tlb_entries_count == VALID_TLB_ENTRY_MAX)
        {
            profiler_stat_increment(S_TLB_FULL);
            clear_tlb();

            // also clear global entries if tlb is almost full after clearing non-global pages
            if(valid_tlb_entries_count > VALID_TLB_ENTRY_MAX * 3 / 4)
            {
                profiler_stat_increment(S_TLB_GLOBAL_FULL);
                full_clear_tlb();
            }
        }

        assert(valid_tlb_entries_count < VALID_TLB_ENTRY_MAX);
        valid_tlb_entries[valid_tlb_entries_count++] = page;

        // TODO: Check that there are no duplicates in valid_tlb_entries
        // XXX: There will probably be duplicates due to invlpg deleting
        //      entries from tlb_data but not from valid_tlb_entries
    }
    else
    {
        if(CHECK_TLB_INVARIANTS)
        {
            bool found = false;

            for(int32_t i = 0; i < valid_tlb_entries_count; i++)
            {
                if(valid_tlb_entries[i] == page)
                {
                    found = true;
                    break;
                }
            }

            assert(found);
        }
    }

    bool is_in_mapped_range = in_mapped_range(high);
    int32_t physical_page = (uint32_t)high >> 12;

    bool has_code = !is_in_mapped_range && jit_page_has_code(physical_page);

    int32_t info_bits =
        TLB_VALID |
        (can_write ? 0 : TLB_READONLY) |
        (allow_user ? 0 : TLB_NO_USER) |
        (is_in_mapped_range ? TLB_IN_MAPPED_RANGE : 0) |
        (global && (cr[4] & CR4_PGE) ? TLB_GLOBAL : 0) |
        (has_code ? TLB_HAS_CODE : 0);

    assert(((high ^ page << 12) & 0xFFF) == 0);
    tlb_data[page] = high ^ page << 12 | info_bits;

    return high;
}

void tlb_set_has_code(uint32_t physical_page, bool has_code)
{
    assert(physical_page < (1 << 20));

    for(int32_t i = 0; i < valid_tlb_entries_count; i++)
    {
        int32_t page = valid_tlb_entries[i];
        int32_t entry = tlb_data[page];

        if(entry)
        {
            uint32_t tlb_physical_page = (uint32_t)entry >> 12 ^ page;

            if(physical_page == tlb_physical_page)
            {
                tlb_data[page] = has_code ? entry | TLB_HAS_CODE : entry & ~TLB_HAS_CODE;
            }
        }
    }

    check_tlb_invariants();
}

void check_tlb_invariants(void)
{
    if(!CHECK_TLB_INVARIANTS) return;

    for(int32_t i = 0; i < valid_tlb_entries_count; i++)
    {
        int32_t page = valid_tlb_entries[i];
        int32_t entry = tlb_data[page];

        if(!entry || (entry & TLB_IN_MAPPED_RANGE)) // there's no code in mapped memory
        {
            continue;
        }

        uint32_t physical_page = (uint32_t)entry >> 12 ^ page;
        dbg_assert(!in_mapped_range(physical_page << 12));

        bool entry_has_code = entry & TLB_HAS_CODE;
        bool has_code = jit_page_has_code(physical_page);

        // If some code has been created in a page, the corresponding tlb entries must be marked
        dbg_assert(!has_code || entry_has_code);

        // If a tlb entry is marked to have code, the physical page should
        // contain code (the converse is not a bug, but indicates a cleanup
        // problem when clearing code from a page)
        dbg_assert(!entry_has_code || has_code);
    }
}

int32_t get_valid_tlb_entries_count(void)
{
    int32_t result = 0;

    for(int32_t i = 0; i < valid_tlb_entries_count; i++)
    {
        int32_t page = valid_tlb_entries[i];
        int32_t entry = tlb_data[page];

        if(entry)
        {
            result++;
        }
    }

    return result;
}

int32_t get_valid_global_tlb_entries_count(void)
{
    int32_t result = 0;

    for(int32_t i = 0; i < valid_tlb_entries_count; i++)
    {
        int32_t page = valid_tlb_entries[i];
        int32_t entry = tlb_data[page];

        if(entry & TLB_GLOBAL)
        {
            result++;
        }
    }

    return result;
}

void writable_or_pagefault(int32_t addr, int32_t size)
{
    dbg_assert(size < 0x1000);
    dbg_assert(size > 0);

    if((cr[0] & CR0_PG) == 0)
    {
        return;
    }

    bool user = cpl[0] == 3;
    int32_t mask = TLB_READONLY | TLB_VALID | (user ? TLB_NO_USER : 0);
    int32_t expect = TLB_VALID;
    int32_t page = (uint32_t)addr >> 12;

    if((tlb_data[page] & mask) != expect)
    {
        do_page_translation(addr, true, user);
    }

    int32_t next_page = (uint32_t)(addr + size - 1) >> 12;

    if(page != next_page)
    {
        assert(next_page == page + 1);

        // XXX: possibly out of bounds
        if((tlb_data[next_page] & mask) != expect)
        {
            do_page_translation(next_page << 12, true, user);
        }
    }
}

uint32_t translate_address_read(int32_t address)
{
    int32_t base = (uint32_t)address >> 12;
    int32_t entry = tlb_data[base];
    bool user = cpl[0] == 3;
    if((entry & (TLB_VALID | (user ? TLB_NO_USER : 0))) == TLB_VALID)
    {
        return entry & ~0xFFF ^ address;
    }
    else
    {
        return do_page_translation(address, false, user) | address & 0xFFF;
    }
}

uint32_t translate_address_write(int32_t address)
{
    int32_t base = (uint32_t)address >> 12;
    int32_t entry = tlb_data[base];
    bool user = cpl[0] == 3;
    if((entry & (TLB_VALID | (user ? TLB_NO_USER : 0) | TLB_READONLY)) == TLB_VALID)
    {
        return entry & ~0xFFF ^ address;
    }
    else
    {
        return do_page_translation(address, true, user) | address & 0xFFF;
    }
}

uint32_t translate_address_system_read(int32_t address)
{
    int32_t base = (uint32_t)address >> 12;
    int32_t entry = tlb_data[base];
    if(entry & TLB_VALID)
    {
        return entry & ~0xFFF ^ address;
    }
    else
    {
        return do_page_translation(address, false, false) | address & 0xFFF;
    }
}

uint32_t translate_address_system_write(int32_t address)
{
    int32_t base = (uint32_t)address >> 12;
    int32_t entry = tlb_data[base];
    if((entry & (TLB_VALID | TLB_READONLY)) == TLB_VALID)
    {
        return entry & ~0xFFF ^ address;
    }
    else
    {
        return do_page_translation(address, true, false) | address & 0xFFF;
    }
}

int32_t get_phys_eip()
{
    int32_t eip = *instruction_pointer;

    if((eip & ~0xFFF) ^ *last_virt_eip)
    {
        *eip_phys = translate_address_read(eip) ^ eip;
        *last_virt_eip = eip & ~0xFFF;
    }

    uint32_t phys_addr = *eip_phys ^ eip;
    assert(!in_mapped_range(phys_addr));
    return phys_addr;
}

int32_t read_imm8()
{
    int32_t eip = *instruction_pointer;

    if((eip & ~0xFFF) ^ *last_virt_eip)
    {
        *eip_phys = translate_address_read(eip) ^ eip;
        *last_virt_eip = eip & ~0xFFF;
    }

    assert(!in_mapped_range(*eip_phys ^ eip));
    int32_t data8 = mem8[*eip_phys ^ eip];
    *instruction_pointer = eip + 1;

    return data8;
}

int32_t read_imm8s()
{
    return read_imm8() << 24 >> 24;
}

int32_t read_imm16()
{
    // Two checks in one comparison:
    //    1. Did the high 20 bits of eip change
    // or 2. Are the low 12 bits of eip 0xFFF (and this read crosses a page boundary)
    if((uint32_t)(*instruction_pointer ^ *last_virt_eip) > 0xFFE)
    {
        return read_imm8() | read_imm8() << 8;
    }

    int32_t data16 = read16(*eip_phys ^ *instruction_pointer);
    *instruction_pointer = *instruction_pointer + 2;

    return data16;
}

int32_t read_imm32s()
{
    // Analogue to the above comment
    if((uint32_t)(*instruction_pointer ^ *last_virt_eip) > 0xFFC)
    {
        return read_imm16() | read_imm16() << 16;
    }

    int32_t data32 = read32s(*eip_phys ^ *instruction_pointer);
    *instruction_pointer = *instruction_pointer + 4;

    return data32;
}

bool is_osize_32()
{
    return *is_32 != ((*prefixes & PREFIX_MASK_OPSIZE) == PREFIX_MASK_OPSIZE);
}

bool is_asize_32()
{
    return *is_32 != ((*prefixes & PREFIX_MASK_ADDRSIZE) == PREFIX_MASK_ADDRSIZE);
}

int32_t get_seg(int32_t segment)
{
    assert(segment >= 0 && segment < 8);

    // TODO: Remove protected_mode check
    if(*protected_mode)
    {
        if(segment_is_null[segment])
        {
            assert(segment != CS && segment != SS);
            dbg_log("#gp: Access null segment");
            trigger_gp(0);
        }
    }

    return segment_offsets[segment];
}

int32_t get_seg_cs(void)
{
    return segment_offsets[CS];
}

int32_t get_seg_ss(void)
{
    return segment_offsets[SS];
}

int32_t get_seg_prefix(int32_t default_segment)
{
    int32_t prefix = *prefixes & PREFIX_MASK_SEGMENT;

    if(prefix)
    {
        if(prefix == SEG_PREFIX_ZERO)
        {
            return 0; // TODO: Remove this special case
        }
        else
        {
            return get_seg(prefix - 1);
        }
    }
    else
    {
        return get_seg(default_segment);
    }
}

int32_t get_seg_prefix_ds(int32_t offset) { return get_seg_prefix(DS) + offset; }
int32_t get_seg_prefix_ss(int32_t offset) { return get_seg_prefix(SS) + offset; }
int32_t get_seg_prefix_cs(int32_t offset) { return get_seg_prefix(CS) + offset; }

int32_t modrm_resolve(int32_t modrm_byte)
{
    if(is_asize_32())
    {
        return resolve_modrm32(modrm_byte);
    }
    else
    {
        return resolve_modrm16(modrm_byte);
    }
}

static void jit_run_interpreted(int32_t phys_addr)
{
    profiler_stat_increment(S_RUN_INTERPRETED);

    jit_block_boundary = false;

    assert(!in_mapped_range(phys_addr));
    int32_t opcode = mem8[phys_addr];
    (*instruction_pointer)++;
    (*timestamp_counter)++;

    run_instruction(opcode | !!*is_32 << 8);

    clear_current_cpu_exception();

    while(!jit_block_boundary && same_page(*previous_ip, *instruction_pointer))
    {
        previous_ip[0] = instruction_pointer[0];
        (*timestamp_counter)++;

        int32_t opcode = read_imm8();

        if(DEBUG)
            logop(previous_ip[0], opcode);

        run_instruction(opcode | !!*is_32 << 8);

        clear_current_cpu_exception();
    }
}

bool has_flat_segmentation(void)
{
    // ss can't be null
    return segment_offsets[SS] == 0 && !segment_is_null[DS] && segment_offsets[DS] == 0;
}

cached_state_flags pack_current_state_flags()
{
    return *is_32 << 0 | *stack_size_32 << 1 | (*cpl == 3) << 2 | has_flat_segmentation() << 3;
}

bool same_page(int32_t addr1, int32_t addr2)
{
    return (addr1 & ~0xFFF) == (addr2 & ~0xFFF);
}

void cycle_internal()
{
    profiler_stat_increment(S_CYCLE_INTERNAL);
    if(true) {

    *previous_ip = *instruction_pointer;
    uint32_t phys_addr = get_phys_eip();

    cached_state_flags state_flags = pack_current_state_flags();
    uint32_t entry = jit_find_cache_entry(phys_addr, state_flags);

    if(entry)
    {
        profiler_stat_increment(S_RUN_FROM_CACHE);

        int32_t initial_tsc = *timestamp_counter;

        //uint32_t old_start_address = entry->start_addr;

        uint16_t wasm_table_index = entry & 0xFFFF;
        uint16_t initial_state = entry >> 16;
        call_indirect1((uint32_t)wasm_table_index + 0x100, initial_state);

        clear_current_cpu_exception();

        // XXX: New clearing: This should fail on self-modifying code
        //assert(entry->start_addr == old_start_address);

        //UNUSED(old_start_address);

        profiler_stat_increment_by(S_RUN_FROM_CACHE_STEPS, *timestamp_counter - initial_tsc);
    }
    else
    {
        if(DEBUG) {
        assert(!must_not_fault); must_not_fault = true;
        }
        jit_increase_hotness_and_maybe_compile(phys_addr, get_seg_cs(), state_flags);

        if(DEBUG) {
        assert(must_not_fault); must_not_fault = false;
        }

        int32_t initial_tsc = *timestamp_counter;

        jit_run_interpreted(phys_addr);

        profiler_stat_increment_by(S_RUN_INTERPRETED_STEPS, *timestamp_counter - initial_tsc);
    }

    }
    else
    {
/* Use non-JIT mode */
    previous_ip[0] = instruction_pointer[0];

    (*timestamp_counter)++;

    int32_t opcode = read_imm8();

    if(DEBUG)
        logop(previous_ip[0], opcode);


    run_instruction(opcode | !!*is_32 << 8);
    }
}

void run_prefix_instruction()
{
    run_instruction(read_imm8() | is_osize_32() << 8);
}

void clear_prefixes()
{
    *prefixes = 0;
}

void segment_prefix_op(int32_t seg)
{
    assert(seg <= 5);
    *prefixes |= seg + 1;
    run_prefix_instruction();
    *prefixes = 0;
}

void do_many_cycles_unsafe()
{
    profiler_stat_increment(S_DO_MANY_CYCLES);

    uint32_t initial_timestamp_counter = *timestamp_counter;

    for(; *timestamp_counter - initial_timestamp_counter < LOOP_COUNTER && !in_hlt[0]; )
    {
        cycle_internal();
    }
}

void raise_exception(int32_t interrupt_nr)
{
    if(DEBUG) {
    if(must_not_fault)
    {
        dbg_log1("Unexpected fault: 0x%x", interrupt_nr);
        dbg_trace();
        assert(false);
    }

    if(cpu_exception_hook(interrupt_nr))
    {
        throw_cpu_exception();
        return;
    }
    }
    profiler_stat_increment(S_TRIGGER_CPU_EXCEPTION);
    call_interrupt_vector(interrupt_nr, false, false, 0);
    throw_cpu_exception();
}

void raise_exception_with_code(int32_t interrupt_nr, int32_t error_code)
{
    if(DEBUG) {
    if(must_not_fault)
    {
        dbg_log2("Unexpected fault: 0x%x with code 0x%x", interrupt_nr, error_code);
        dbg_trace();
        assert(false);
    }

    if(cpu_exception_hook(interrupt_nr))
    {
        throw_cpu_exception();
        return;
    }
    }
    profiler_stat_increment(S_TRIGGER_CPU_EXCEPTION);
    call_interrupt_vector(interrupt_nr, false, true, error_code);
    throw_cpu_exception();
}

__attribute__((noinline))
void trigger_de()
{
    if(DEBUG) {
    if(cpu_exception_hook(CPU_EXCEPTION_DE))
    {
        return;
    }
    }
    *instruction_pointer = *previous_ip;
    call_interrupt_vector(CPU_EXCEPTION_DE, false, false, 0);
    set_current_cpu_exception(CPU_EXCEPTION_DE);
}

__attribute__((noinline))
void trigger_ud()
{
    dbg_log("#ud");
    dbg_trace();
    if(DEBUG) {
    if(cpu_exception_hook(CPU_EXCEPTION_UD))
    {
        return;
    }
    }
    *instruction_pointer = *previous_ip;
    call_interrupt_vector(CPU_EXCEPTION_UD, false, false, 0);
    set_current_cpu_exception(CPU_EXCEPTION_UD);
}

__attribute__((noinline))
void trigger_nm()
{
    if(DEBUG) {
    if(cpu_exception_hook(CPU_EXCEPTION_NM))
    {
        return;
    }
    }
    *instruction_pointer = *previous_ip;
    call_interrupt_vector(CPU_EXCEPTION_NM, false, false, 0);
    set_current_cpu_exception(CPU_EXCEPTION_NM);
}

__attribute__((noinline))
void trigger_np(int32_t code)
{
    if(DEBUG) {
    if(cpu_exception_hook(CPU_EXCEPTION_NP))
    {
        return;
    }
    }
    *instruction_pointer = *previous_ip;
    call_interrupt_vector(CPU_EXCEPTION_NP, false, true, code);
    set_current_cpu_exception(CPU_EXCEPTION_NP);
}

__attribute__((noinline))
void trigger_ss(int32_t code)
{
    if(DEBUG) {
    if(cpu_exception_hook(CPU_EXCEPTION_SS))
    {
        return;
    }
    }
    *instruction_pointer = *previous_ip;
    call_interrupt_vector(CPU_EXCEPTION_SS, false, true, code);
    set_current_cpu_exception(CPU_EXCEPTION_SS);
}

__attribute__((noinline))
void trigger_gp(int32_t code)
{
    *instruction_pointer = *previous_ip;
    raise_exception_with_code(CPU_EXCEPTION_GP, code);
}

__attribute__((noinline))
void trigger_gp_non_raising(int32_t code)
{
    if(DEBUG) {
    if(cpu_exception_hook(CPU_EXCEPTION_GP))
    {
        return;
    }
    }
    *instruction_pointer = *previous_ip;
    call_interrupt_vector(CPU_EXCEPTION_GP, false, true, code);
    set_current_cpu_exception(CPU_EXCEPTION_GP);
}

int32_t virt_boundary_read16(int32_t low, int32_t high)
{
    dbg_assert((low & 0xFFF) == 0xFFF);
    dbg_assert((high & 0xFFF) == 0);

    return read8(low) | read8(high) << 8;
}

int32_t virt_boundary_read32s(int32_t low, int32_t high)
{
    dbg_assert((low & 0xFFF) >= 0xFFD);
    dbg_assert((high - 3 & 0xFFF) == (low & 0xFFF));

    int32_t mid = 0;

    if(low & 1)
    {
        if(low & 2)
        {
            // 0xFFF
            mid = read_aligned16((high - 2) >> 1);
        }
        else
        {
            // 0xFFD
            mid = read_aligned16((low + 1) >> 1);
        }
    }
    else
    {
        // 0xFFE
        mid = virt_boundary_read16(low + 1, high - 1);
    }

    return read8(low) | mid << 8 | read8(high) << 24;
}

void virt_boundary_write16(int32_t low, int32_t high, int32_t value)
{
    dbg_assert((low & 0xFFF) == 0xFFF);
    dbg_assert((high & 0xFFF) == 0);

    write8(low, value);
    write8(high, value >> 8);
}

void virt_boundary_write32(int32_t low, int32_t high, int32_t value)
{
    dbg_assert((low & 0xFFF) >= 0xFFD);
    dbg_assert((high - 3 & 0xFFF) == (low & 0xFFF));

    write8(low, value);

    if(low & 1)
    {
        if(low & 2)
        {
            // 0xFFF
            write8(high - 2, value >> 8);
            write8(high - 1, value >> 16);
        }
        else
        {
            // 0xFFD
            write8(low + 1, value >> 8);
            write8(low + 2, value >> 16);
        }
    }
    else
    {
        // 0xFFE
        write8(low + 1, value >> 8);
        write8(high - 1, value >> 16);
    }

    write8(high, value >> 24);
}

int32_t safe_read8(int32_t addr)
{
    assert_no_cpu_exception();
    return read8(translate_address_read(addr));
}

__attribute__((noinline))
int32_t safe_read16_slow(int32_t addr)
{
    assert_no_cpu_exception();
    if((addr & 0xFFF) == 0xFFF)
    {
        return safe_read8(addr) | safe_read8(addr + 1) << 8;
    }
    else
    {
        return read16(translate_address_read(addr));
    }
}

__attribute__((always_inline))
int32_t safe_read16(int32_t address)
{
#if 1
    int32_t base = (uint32_t)address >> 12;
    int32_t entry = tlb_data[base];
    int32_t info_bits = entry & 0xFFF & ~TLB_READONLY & ~TLB_GLOBAL & ~TLB_HAS_CODE;

    if(info_bits == TLB_VALID && (address & 0xFFF) <= (0x1000 - 2))
    {
        // - not in memory mapped area
        // - can be accessed from any cpl

        uint32_t phys_address = entry & ~0xFFF ^ address;
        assert(!in_mapped_range(phys_address));
        return *(uint16_t*)(mem8 + phys_address);
    }
#endif

    return safe_read16_slow(address);
}

__attribute__((noinline))
int32_t safe_read32s_slow(int32_t addr)
{
    if((addr & 0xFFF) >= 0xFFD)
    {
        return safe_read16(addr) | safe_read16(addr + 2) << 16;
    }
    else
    {
        return read32s(translate_address_read(addr));
    }
}

__attribute__((always_inline))
int32_t safe_read32s(int32_t address)
{
    assert_no_cpu_exception();
#if 1
    int32_t base = (uint32_t)address >> 12;
    int32_t entry = tlb_data[base];
    int32_t info_bits = entry & 0xFFF & ~TLB_READONLY & ~TLB_GLOBAL & ~TLB_HAS_CODE;

    if(info_bits == TLB_VALID && (address & 0xFFF) <= (0x1000 - 4))
    {
if( ENABLE_PROFILER_SAFE_READ_WRITE)
        profiler_stat_increment(S_SAFE_READ32_FAST);

        // - not in memory mapped area
        // - can be accessed from any cpl

        uint32_t phys_address = entry & ~0xFFF ^ address;
        assert(!in_mapped_range(phys_address));
        return *(int32_t*)(mem8 + phys_address);
    }
    else
    {
if( ENABLE_PROFILER_SAFE_READ_WRITE) {
        if((address & 0xFFF) > 0x1000 - 4)
        {
            profiler_stat_increment(S_SAFE_READ32_SLOW_PAGE_CROSSED);
        }
        else if((info_bits & TLB_VALID) == 0)
        {
            profiler_stat_increment(S_SAFE_READ32_SLOW_NOT_VALID);
        }
        else if(info_bits & TLB_NO_USER)
        {
            profiler_stat_increment(S_SAFE_READ32_SLOW_NOT_USER);
        }
        else if(info_bits & TLB_IN_MAPPED_RANGE)
        {
            profiler_stat_increment(S_SAFE_READ32_SLOW_IN_MAPPED_RANGE);
        }
        else
        {
            dbg_assert(false);
        }
    }
    }
#endif

    return safe_read32s_slow(address);
}

union reg64 safe_read64s(int32_t addr)
{
    assert_no_cpu_exception();

    union reg64 x;
    if((addr & 0xFFF) > (0x1000 - 8))
    {
        x.u32[0] = safe_read32s(addr);
        x.u32[1] = safe_read32s(addr + 4);
    }
    else
    {
        int32_t addr_phys = translate_address_read(addr);
        x.u64[0] = read64s(addr_phys);
    }
    return x;
}

__attribute__((always_inline))
union reg128 safe_read128s(int32_t addr)
{
    assert_no_cpu_exception();

    union reg128 x;
    if((addr & 0xFFF) > (0x1000 - 16))
    {
        x.u64[0] = safe_read64s(addr).u64[0];
        x.u64[1] = safe_read64s(addr + 8).u64[0];
    }
    else
    {
        int32_t addr_phys = translate_address_read(addr);
        x = read128(addr_phys);
    }
    return x;
}

void safe_write8(int32_t addr, int32_t value)
{
    assert_no_cpu_exception();

    write8(translate_address_write(addr), value);
}

__attribute__((noinline))
void safe_write16_slow(int32_t addr, int32_t value)
{
    assert_no_cpu_exception();

    int32_t phys_low = translate_address_write(addr);

    if((addr & 0xFFF) == 0xFFF)
    {
        virt_boundary_write16(phys_low, translate_address_write(addr + 1), value);
    }
    else
    {
        write16(phys_low, value);
    }
}

__attribute__((always_inline))
void safe_write16(int32_t address, int32_t value)
{
#if 1
    int32_t base = (uint32_t)address >> 12;
    int32_t entry = tlb_data[base];
    int32_t info_bits = entry & 0xFFF & ~TLB_GLOBAL;

    if(info_bits == TLB_VALID && (address & 0xFFF) <= (0x1000 - 2))
    {
        // - allowed to write in user-mode
        // - not in memory mapped area
        // - can be accessed from any cpl
        // - does not contain code

        uint32_t phys_address = entry & ~0xFFF ^ address;
        assert(!jit_page_has_code(phys_address >> 12));
        assert(!in_mapped_range(phys_address));
        *(uint16_t*)(mem8 + phys_address) = value;
        return;
    }
#endif

    safe_write16_slow(address, value);
}

__attribute__((noinline))
void safe_write32_slow(int32_t addr, int32_t value)
{
    int32_t phys_low = translate_address_write(addr);

    if((addr & 0xFFF) > (0x1000 - 4))
    {
        virt_boundary_write32(phys_low, translate_address_write(addr + 3 & ~3) | (addr + 3) & 3, value);
    }
    else
    {
        write32(phys_low, value);
    }
}

__attribute__((always_inline))
void safe_write32(int32_t address, int32_t value)
{
    assert_no_cpu_exception();

#if 1
    int32_t base = (uint32_t)address >> 12;
    int32_t entry = tlb_data[base];
    int32_t info_bits = entry & 0xFFF & ~TLB_GLOBAL & ~(*cpl == 3 ? 0 : TLB_NO_USER);

    if(info_bits == TLB_VALID && (address & 0xFFF) <= (0x1000 - 4))
    {
if( ENABLE_PROFILER_SAFE_READ_WRITE)
        profiler_stat_increment(S_SAFE_WRITE32_FAST);
        // - allowed to write in user-mode
        // - not in memory mapped area
        // - does not contain code

        uint32_t phys_address = entry & ~0xFFF ^ address;
        assert(!jit_page_has_code(phys_address >> 12));
        assert(!in_mapped_range(phys_address));
        *(int32_t*)(mem8 + phys_address) = value;
        return;
    }
    else
    {
if( ENABLE_PROFILER_SAFE_READ_WRITE) {
        if((address & 0xFFF) > 0x1000 - 4)
        {
            profiler_stat_increment(S_SAFE_WRITE32_SLOW_PAGE_CROSSED);
        }
        else if((info_bits & TLB_VALID) == 0)
        {
            profiler_stat_increment(S_SAFE_WRITE32_SLOW_NOT_VALID);
        }
        else if(info_bits & TLB_NO_USER)
        {
            profiler_stat_increment(S_SAFE_WRITE32_SLOW_NOT_USER);
        }
        else if(info_bits & TLB_IN_MAPPED_RANGE)
        {
            profiler_stat_increment(S_SAFE_WRITE32_SLOW_IN_MAPPED_RANGE);
        }
        else if(info_bits & TLB_READONLY)
        {
            profiler_stat_increment(S_SAFE_WRITE32_SLOW_READ_ONLY);
        }
        else if(info_bits & TLB_HAS_CODE)
        {
            profiler_stat_increment(S_SAFE_WRITE32_SLOW_HAS_CODE);
        }
        else
        {
            dbg_assert(false);
        }
}
    }
#endif

    safe_write32_slow(address, value);
}

void safe_write64(int32_t addr, int64_t value)
{
    assert_no_cpu_exception();

    if((addr & 0xFFF) > (0x1000 - 8))
    {
        writable_or_pagefault(addr, 8);
        safe_write32(addr, value);
        safe_write32(addr + 4, value >> 32);
    }
    else
    {
        int32_t phys = translate_address_write(addr);
        write64(phys, value);
    }
}

__attribute__((always_inline))
void safe_write128(int32_t addr, union reg128 value)
{
    assert_no_cpu_exception();

    if((addr & 0xFFF) > (0x1000 - 16))
    {
        writable_or_pagefault(addr, 16);
        safe_write64(addr, value.u64[0]);
        safe_write64(addr + 8, value.u64[1]);
    }
    else
    {
        int32_t phys = translate_address_write(addr);
        write128(phys, value);
    }
}

int32_t get_reg8_index(int32_t index) { return index << 2 & 0xC | index >> 2 & 1; }

int32_t read_reg8(int32_t index)
{
    return reg8[get_reg8_index(index)];
}

void write_reg8(int32_t index, int32_t value)
{
    reg8[get_reg8_index(index)] = value;
}

int32_t get_reg16_index(int32_t index) { return index << 1; }

int32_t read_reg16(int32_t index)
{
    return reg16[get_reg16_index(index)];
}

void write_reg16(int32_t index, int32_t value)
{
    reg16[get_reg16_index(index)] = value;
}


int32_t read_reg32(int32_t index)
{
    return reg32s[index];
}

void write_reg32(int32_t index, int32_t value)
{
    reg32s[index] = value;
}

void write_reg_osize(int32_t index, int32_t value)
{
    assert(index >= 0 && index < 8);

    if(is_osize_32())
    {
        write_reg32(index, value);
    }
    else
    {
        write_reg16(index, value & 0xFFFF);
    }
}

int32_t read_mmx32s(int32_t r)
{
    return reg_mmx[r].u32[0];
}

union reg64 read_mmx64s(int32_t r)
{
    return reg_mmx[r];
}

void write_mmx64(int32_t r, int32_t low, int32_t high)
{
    reg_mmx[r].u32[0] = low;
    reg_mmx[r].u32[1] = high;
}

void write_mmx_reg64(int32_t r, union reg64 data)
{
    reg_mmx[r].u64[0] = data.u64[0];
}

float_t read_xmm_f32(int32_t r)
{
    return reg_xmm[r].f32[0];
}

int32_t read_xmm32(int32_t r)
{
    return reg_xmm[r].u32[0];
}

union reg64 read_xmm64s(int32_t r)
{
    union reg64 x;
    x.u64[0] = reg_xmm[r].u64[0];
    return x;
}

union reg128 read_xmm128s(int32_t r)
{
    return reg_xmm[r];
}

void write_xmm_f32(int32_t r, float_t data)
{
    reg_xmm[r].f32[0] = data;
}

void write_xmm32(int32_t r, int32_t data)
{
    reg_xmm[r].i32[0] = data;
}

void write_xmm64(int32_t r, union reg64 data)
{
    reg_xmm[r].u64[0] = data.u64[0];
}

void write_xmm128(int32_t r, int32_t i0, int32_t i1, int32_t i2, int32_t i3)
{
    union reg128 x = { .u32 = { i0, i1, i2, i3 } };
    reg_xmm[r] = x;
}

void write_xmm_reg128(int32_t r, union reg128 data)
{
    reg_xmm[r].u64[0] = data.u64[0];
    reg_xmm[r].u64[1] = data.u64[1];
}

void clear_tlb()
{
    profiler_stat_increment(S_CLEAR_TLB);
    // clear tlb excluding global pages

    *last_virt_eip = -1;
    *last_virt_esp = -1;

    int32_t global_page_offset = 0;

    for(int32_t i = 0; i < valid_tlb_entries_count; i++)
    {
        int32_t page = valid_tlb_entries[i];
        int32_t entry = tlb_data[page];

        if(entry & TLB_GLOBAL)
        {
            // reinsert at the front
            valid_tlb_entries[global_page_offset++] = page;
        }
        else
        {
            tlb_data[page] = 0;
        }
    }

    valid_tlb_entries_count = global_page_offset;

    if(CHECK_TLB_INVARIANTS)
    {
        for(int32_t i = 0; i < 0x100000; i++)
        {
            assert(tlb_data[i] == 0 || (tlb_data[i] & TLB_GLOBAL));
        }
    }
}

void full_clear_tlb()
{
    profiler_stat_increment(S_FULL_CLEAR_TLB);
    // clear tlb including global pages

    *last_virt_eip = -1;
    *last_virt_esp = -1;

    for(int32_t i = 0; i < valid_tlb_entries_count; i++)
    {
        int32_t page = valid_tlb_entries[i];
        tlb_data[page] = 0;
    }

    valid_tlb_entries_count = 0;

    if(CHECK_TLB_INVARIANTS)
    {
        for(int32_t i = 0; i < 0x100000; i++)
        {
            assert(tlb_data[i] == 0);
        }
    }
}

void invlpg(int32_t addr)
{
    //dbg_log("invlpg: addr=" + h(addr >>> 0), LOG_CPU);
    int32_t page = (uint32_t)addr >> 12;

    // Note: Doesn't remove this page from valid_tlb_entries: This isn't
    // necessary, because when valid_tlb_entries grows too large, it will be
    // empties by calling clear_tlb, which removes this entry as it isn't global.
    // This however means that valid_tlb_entries can contain some invalid entries
    tlb_data[page] = 0;

    *last_virt_eip = -1;
    *last_virt_esp = -1;
}

bool task_switch_test()
{
    if(cr[0] & (CR0_EM | CR0_TS))
    {
        trigger_nm();
        return false;
    }

    return true;
}
void task_switch_test_void() { task_switch_test(); }

bool task_switch_test_mmx()
{
    if(*cr & CR0_TS)
    {
        trigger_nm();
        return false;
    }
    else if(*cr & CR0_EM)
    {
        trigger_ud();
        return false;
    }

    return true;
}
void task_switch_test_mmx_void() { task_switch_test_mmx(); }

// read 2 or 4 byte from ip, depending on address size attribute
int32_t read_moffs()
{
    if(is_asize_32())
    {
        return read_imm32s();
    }
    else
    {
        return read_imm16();
    }
}

// Returns the "real" instruction pointer, without segment offset
int32_t get_real_eip()
{
    return *instruction_pointer - get_seg_cs();
}

int32_t get_stack_reg()
{
    if(*stack_size_32)
    {
        return reg32s[ESP];
    }
    else
    {
        return reg16[SP];
    }
}

void set_stack_reg(int32_t value)
{
    if(*stack_size_32)
    {
        reg32s[ESP] = value;
    }
    else
    {
        reg16[SP] = value;
    }
}

int32_t get_reg_asize(int32_t reg)
{
    dbg_assert(reg == ECX || reg == ESI || reg == EDI);
    int32_t r = reg32s[reg];

    if(is_asize_32())
    {
        return r;
    }
    else
    {
        return r & 0xFFFF;
    }
}

void set_ecx_asize(int32_t value)
{
    if(is_asize_32())
    {
        reg32s[ECX] = value;
    }
    else
    {
        reg16[CX] = value;
    }
}

void add_reg_asize(int32_t reg, int32_t value)
{
    dbg_assert(reg == ECX || reg == ESI || reg == EDI);
    if(is_asize_32())
    {
        reg32s[reg] += value;
    }
    else
    {
        reg16[reg << 1] += value;
    }
}

int32_t decr_ecx_asize()
{
    return is_asize_32() ? --reg32s[ECX] : --reg16[CX];
}

void set_tsc(uint32_t low, uint32_t high)
{
    uint64_t new_value = low | (uint64_t)high << 32;
    uint64_t current_value = read_tsc();
    tsc_offset = current_value - new_value;
}


uint64_t rdtsc_last_value = 0;
uint64_t rdtsc_imprecision_offset = 0;

uint64_t read_tsc()
{
    double_t n = microtick() * TSC_RATE;
    uint64_t value = (uint64_t)n - tsc_offset;

    if(1 + 1) {
    return value;
    }
    else {

    if(value == rdtsc_last_value)
    {
        // don't go past 1ms

        if(rdtsc_imprecision_offset < TSC_RATE)
        {
            rdtsc_imprecision_offset++;
        }
    }
    else
    {
        uint64_t previous_value = rdtsc_last_value + rdtsc_imprecision_offset;

        if(previous_value <= value)
        {
            rdtsc_last_value = value;
            rdtsc_imprecision_offset = 0;
        }
        else
        {
            dbg_log6("XXX: Overshot tsc prev=%x:%x offset=%x:%x curr=%x:%x",
                    (uint32_t)(rdtsc_last_value >> 32), (uint32_t)rdtsc_last_value,
                    (uint32_t)(rdtsc_imprecision_offset >> 32), (uint32_t)rdtsc_imprecision_offset,
                    (uint32_t)(value >> 32), (uint32_t)value
                    );
            dbg_assert(false);

            // Keep current value until time catches up
        }
    }

    return rdtsc_last_value + rdtsc_imprecision_offset;
    }
}

void store_current_tsc()
{
    *current_tsc = read_tsc();
}


int32_t get_opstats_buffer(int32_t index)
{
    assert(index >= 0 && index < 0x200);

if( ENABLE_PROFILER_OPSTATS) {
    if(index < 0x100)
    {
        return opstats_buffer[index];
    }
    else
    {
        return opstats_buffer_0f[index - 0x100];
    }
}

    UNUSED(index);
    return 0;
}
