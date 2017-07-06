#include <stdint.h>
#include <math.h>
#include <assert.h>
#include <stdbool.h>
#include <stdio.h>

#include "const.h"
#include "global_pointers.h"

int32_t read_e8_partial_branch() {
    return reg8[*modrm_byte << 2 & 0xC | *modrm_byte >> 2 & 1];
}

int32_t translate_address_read(int32_t);
int32_t translate_address_write(int32_t);
int32_t read8(uint32_t);
int32_t read16(uint32_t);
int32_t read32s(uint32_t);
int32_t virt_boundary_read16(int32_t, int32_t);
int32_t virt_boundary_read32s(int32_t, int32_t);
void write8(uint32_t, uint8_t);
void write16(uint32_t, uint16_t);
void write32(uint32_t, int32_t);
void virt_boundary_write16(int32_t, int32_t, int32_t);
void virt_boundary_write32(int32_t, int32_t, int32_t);

void trigger_gp(int32_t);

int32_t safe_read8(int32_t);
int32_t safe_read16(int32_t);
int32_t safe_read32s(int32_t);

void safe_write8(int32_t, int32_t);
void safe_write16(int32_t, int32_t);
void safe_write32(int32_t, int32_t);

void fxsave(int32_t);
void fxrstor(int32_t);

int32_t do_page_translation(int32_t, bool, bool);

void diverged() {}
void branch_taken() {}
void branch_not_taken() {}

int32_t getcf(void);
int32_t getpf(void);
int32_t getaf(void);
int32_t getzf(void);
int32_t getsf(void);
int32_t getof(void);


int32_t get_eflags()
{
    return (*flags & ~FLAGS_ALL) | !!getcf() | !!getpf() << 2 | !!getaf() << 4 |
                                  !!getzf() << 6 | !!getsf() << 7 | !!getof() << 11;
}

int32_t translate_address_read(int32_t address)
{
    if(!*paging) return address;

    int32_t base = (uint32_t)address >> 12;
    if(tlb_info[base] & (*cpl == 3 ? TLB_USER_READ : TLB_SYSTEM_READ))
    {
        return tlb_data[base] ^ address;
    }
    else
    {
        return do_page_translation(address, 0, *cpl == 3) | address & 0xFFF;
    }
}

int32_t translate_address_write(int32_t address)
{
    if(!*paging) return address;

    int32_t base = (uint32_t)address >> 12;
    if(tlb_info[base] & (*cpl == 3 ? TLB_USER_WRITE : TLB_SYSTEM_WRITE))
    {
        return tlb_data[base] ^ address;
    }
    else
    {
        return do_page_translation(address, 1, *cpl == 3) | address & 0xFFF;
    }
}

int32_t read_imm8()
{
    int32_t eip = *instruction_pointer;

    if((eip & ~0xFFF) ^ *last_virt_eip)
    {
        *eip_phys = translate_address_read(eip) ^ eip;
        *last_virt_eip = eip & ~0xFFF;
    }

    int32_t data8 = read8(*eip_phys ^ eip);
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

int32_t read_op0F() { return read_imm8(); }
int32_t read_sib() { return read_imm8(); }
int32_t read_op8() { return read_imm8(); }
int32_t read_op8s() { return read_imm8s(); }
int32_t read_op16() { return read_imm16(); }
int32_t read_op32s() { return read_imm32s(); }
int32_t read_disp8() { return read_imm8(); }
int32_t read_disp8s() { return read_imm8s(); }
int32_t read_disp16() { return read_imm16(); }
int32_t read_disp32s() { return read_imm32s(); }

bool is_osize_32()
{
    return *is_32 != ((*prefixes & PREFIX_MASK_OPSIZE) == PREFIX_MASK_OPSIZE);
}

bool is_asize_32()
{
    return *is_32 != ((*prefixes & PREFIX_MASK_ADDRSIZE) == PREFIX_MASK_ADDRSIZE);
}

void read_modrm_byte()
{
    *modrm_byte = read_imm8();
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
            trigger_gp(0);
        }
    }

    return segment_offsets[segment];
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

static void run_instruction(int32_t);
static int32_t resolve_modrm16(int32_t);
static int32_t resolve_modrm32(int32_t);

static int32_t modrm_resolve(int32_t modrm_byte)
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

void set_e8(int32_t value)
{
    int32_t modrm_byte_ = *modrm_byte;
    if(modrm_byte_ < 0xC0) {
        int32_t addr = modrm_resolve(modrm_byte_);
        safe_write8(addr, value);
    } else {
        reg8[modrm_byte_ << 2 & 0xC | modrm_byte_ >> 2 & 1] = value;
    }
}

void set_e16(int32_t value)
{
    int32_t modrm_byte_ = *modrm_byte;
    if(modrm_byte_ < 0xC0) {
        int32_t addr = modrm_resolve(modrm_byte_);
        safe_write16(addr, value);
    } else {
        reg16[modrm_byte_ << 1 & 14] = value;
    }
}

void set_e32(int32_t value)
{
    int32_t modrm_byte_ = *modrm_byte;
    if(modrm_byte_ < 0xC0) {
        int32_t addr = modrm_resolve(modrm_byte_);
        safe_write32(addr, value);
    } else {
        reg32s[modrm_byte_ & 7] = value;
    }
}

int32_t read_g8()
{
    return reg8[*modrm_byte >> 1 & 0xC | *modrm_byte >> 5 & 1];
}

int32_t read_g16()
{
    return reg16[*modrm_byte >> 2 & 14];
}

int32_t read_g16s()
{
    return reg16s[*modrm_byte >> 2 & 14];
}

int32_t read_g32s()
{
    return reg32s[*modrm_byte >> 3 & 7];
}

void write_g8(int32_t value)
{
    reg8[*modrm_byte >> 1 & 0xC | *modrm_byte >> 5 & 1] = value;
}

void write_g16(int32_t value)
{
    reg16[*modrm_byte >> 2 & 14] = value;
}

void write_g32(int32_t value)
{
    reg32s[*modrm_byte >> 3 & 7] = value;
}

int32_t read_e8()
{
    if(*modrm_byte < 0xC0)
    {
        return safe_read8(modrm_resolve(*modrm_byte));
    }
    else
    {
        return reg8[*modrm_byte << 2 & 0xC | *modrm_byte >> 2 & 1];
    }
}

int32_t read_e8s()
{
    return read_e8() << 24 >> 24;
}

int32_t read_e16()
{
    if(*modrm_byte < 0xC0)
    {
        return safe_read16(modrm_resolve(*modrm_byte));
    }
    else
    {
        return reg16[*modrm_byte << 1 & 14];
    }
}

int32_t read_e16s()
{
    return read_e16() << 16 >> 16;
}

int32_t read_e32s()
{
    if(*modrm_byte < 0xC0)
    {
        return safe_read32s(modrm_resolve(*modrm_byte));
    }
    else
    {
        return reg32s[*modrm_byte & 7];
    }
}

void cycle_internal()
{
    previous_ip[0] = instruction_pointer[0];

    (*timestamp_counter)++;

    int32_t opcode = read_imm8();

    run_instruction(opcode | !!*is_32 << 8);
}

static void run_prefix_instruction()
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
    for(int32_t k = 0; k < LOOP_COUNTER; k++)
    {
        cycle_internal();
    }
}

void raise_exception(int32_t interrupt_nr)
{
    call_interrupt_vector(interrupt_nr, false, false, 0);
    throw_cpu_exception();
}

void raise_exception_with_code(int32_t interrupt_nr, int32_t error_code)
{
    call_interrupt_vector(interrupt_nr, false, true, error_code);
    throw_cpu_exception();
}

void trigger_de()
{
    *instruction_pointer = *previous_ip;
    raise_exception(0);
}

void trigger_gp(int32_t code)
{
    *instruction_pointer = *previous_ip;
    raise_exception_with_code(13, code);
}

int32_t safe_read8(int32_t addr)
{
    return read8(translate_address_read(addr));
}

int32_t safe_read16(int32_t addr)
{
    if((addr & 0xFFF) == 0xFFF)
    {
        return safe_read8(addr) | safe_read8(addr + 1) << 8;
    }
    else
    {
        return read16(translate_address_read(addr));
    }
}

int32_t safe_read32s(int32_t addr)
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

void safe_write8(int32_t addr, int32_t value)
{
    write8(translate_address_write(addr), value);
}

void safe_write16(int32_t addr, int32_t value)
{
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

void safe_write32(int32_t addr, int32_t value)
{
    int32_t phys_low = translate_address_write(addr);

    if((addr & 0xFFF) >= 0xFFD)
    {
        virt_boundary_write32(phys_low, translate_address_write(addr + 3 & ~3) | (addr + 3) & 3, value);
    }
    else
    {
        write32(phys_low, value);
    }
}

int32_t read_write_e8()
{
    if(*modrm_byte < 0xC0)
    {
        int32_t virt_addr = modrm_resolve(*modrm_byte);
        *phys_addr = translate_address_write(virt_addr);
        return read8(*phys_addr);
    }
    else
    {
        return reg8[*modrm_byte << 2 & 0xC | *modrm_byte >> 2 & 1];
    }
}

void write_e8(int32_t value)
{
    if(*modrm_byte < 0xC0)
    {
        write8(*phys_addr, value);
    }
    else
    {
        reg8[*modrm_byte << 2 & 0xC | *modrm_byte >> 2 & 1] = value;
    }
}

int32_t read_write_e16()
{
    if(*modrm_byte < 0xC0)
    {
        int32_t virt_addr = modrm_resolve(*modrm_byte);
        *phys_addr = translate_address_write(virt_addr);
        if((virt_addr & 0xFFF) == 0xFFF)
        {
            *phys_addr_high = translate_address_write(virt_addr + 1);
            dbg_assert(*phys_addr_high);
            return virt_boundary_read16(*phys_addr, *phys_addr_high);
        }
        else
        {
            *phys_addr_high = 0;
            return read16(*phys_addr);
        }
    }
    else
    {
        return reg16[*modrm_byte << 1 & 14];
    }
}

void write_e16(int32_t value)
{
    if(*modrm_byte < 0xC0)
    {
        if(*phys_addr_high)
        {
            virt_boundary_write16(*phys_addr, *phys_addr_high, value);
        }
        else
        {
            write16(*phys_addr, value);
        }
    }
    else
    {
        reg16[*modrm_byte << 1 & 14] = value;
    }
}

int32_t read_write_e32()
{
    if(*modrm_byte < 0xC0)
    {
        int32_t virt_addr = modrm_resolve(*modrm_byte);
        *phys_addr = translate_address_write(virt_addr);
        if((virt_addr & 0xFFF) >= 0xFFD)
        {
            *phys_addr_high = translate_address_write(virt_addr + 3 & ~3) | (virt_addr + 3) & 3;
            dbg_assert(*phys_addr_high);
            return virt_boundary_read32s(*phys_addr, *phys_addr_high);
        }
        else
        {
            *phys_addr_high = 0;
            return read32s(*phys_addr);
        }
    }
    else
    {
        return reg32s[*modrm_byte & 7];
    }
}

void write_e32(int32_t value)
{
    if(*modrm_byte < 0xC0)
    {
        if(*phys_addr_high)
        {
            virt_boundary_write32(*phys_addr, *phys_addr_high, value);
        }
        else
        {
            write32(*phys_addr, value);
        }
    }
    else
    {
        reg32s[*modrm_byte & 7] = value;
    }
}

void clear_tlb()
{
    for(int32_t i = 0; i < 0x100000; i += 4)
    {
        *(int32_t*)(tlb_info + i) = *(int32_t*)(tlb_info_global + i);
    }
}
