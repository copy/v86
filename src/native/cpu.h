#pragma once

#include <assert.h>
#include <stdbool.h>
#include <stdint.h>

#include "const.h"
#include "instructions.h"
#include "shared.h"

#define CODE_CACHE_SEARCH_SIZE 8

union reg128 {
    int8_t   i8[16];
    int16_t  i16[8];
    int32_t  i32[4];
    int64_t  i64[2];
    uint8_t   u8[16];
    uint16_t  u16[8];
    uint32_t  u32[4];
    uint64_t  u64[2];
};
_Static_assert(sizeof(union reg128) == 16, "reg128 is 16 bytes");

union reg64 {
    int8_t   i8[8];
    int16_t  i16[4];
    int32_t  i32[2];
    int64_t  i64[1];
    uint8_t   u8[8];
    uint16_t  u16[4];
    uint32_t  u32[2];
    uint64_t  u64[1];
    double   f64[1];
};
_Static_assert(sizeof(union reg64) == 8, "reg64 is 8 bytes");

typedef uint8_t cached_state_flags;

struct code_cache {
    // Address of the start of the basic block
    uint32_t start_addr;
#if DEBUG
    // Address of the instruction immediately after the basic block ends
    uint32_t end_addr;
    int32_t opcode[1];
    int32_t len;
#endif
    // Cleanliness status of the entry's "group" (based on
    // DIRTY_ARR_SHIFT). Value only has meaning in relation with the
    // group_dirtiness value.
    uint32_t group_status;

    uint16_t wasm_table_index;
    cached_state_flags state_flags;
};
#if DEBUG
#else
_Static_assert(sizeof(struct code_cache) == 12, "code_cache uses 12 bytes");
#endif
struct code_cache jit_cache_arr[WASM_TABLE_SIZE];

// Flag indicating whether the instruction that just ran was a jump of some sort
extern uint32_t jit_jump;

// Count of how many times prime_hash(address) has been called through a jump
extern int32_t hot_code_addresses[HASH_PRIME];
// An array indicating the current "initial group status" for entries that map
// to the same group due to the shift
extern uint32_t group_dirtiness[GROUP_DIRTINESS_LENGTH];

#define VALID_TLB_ENTRY_MAX 10000
int32_t valid_tlb_entries[VALID_TLB_ENTRY_MAX];
int32_t valid_tlb_entries_count;

#define TLB_VALID (1 << 0)
#define TLB_READONLY (1 << 1)
#define TLB_NO_USER (1 << 2)
#define TLB_IN_MAPPED_RANGE (1 << 3)
#define TLB_GLOBAL (1 << 4)

// defined in call-indirect.ll
extern void call_indirect(int32_t index);

void after_jump(void);
void diverged(void);
void branch_taken(void);
void branch_not_taken(void);
int32_t get_eflags(void);
uint32_t translate_address_read(int32_t address);
uint32_t translate_address_write(int32_t address);
void writable_or_pagefault(int32_t addr, int32_t size);
int32_t read_imm8(void);
int32_t read_imm8s(void);
int32_t read_imm16(void);
int32_t read_imm32s(void);
bool is_osize_32(void);
bool is_asize_32(void);
int32_t get_seg(int32_t segment);
int32_t get_seg_cs();
int32_t get_seg_ss();
int32_t get_seg_prefix(int32_t default_segment);
int32_t get_seg_prefix_ds(int32_t offset);
int32_t get_seg_prefix_ss(int32_t offset);
int32_t get_seg_prefix_cs(int32_t offset);
int32_t modrm_resolve(int32_t modrm_byte);
uint32_t jit_hot_hash(uint32_t addr);
void jit_link_block(int32_t target);
void jit_link_block_conditional(int32_t offset, const char* condition);
void cycle_internal(void);
void run_prefix_instruction(void);
jit_instr_flags jit_prefix_instruction(void);
void clear_prefixes(void);
void segment_prefix_op(int32_t seg);
jit_instr_flags segment_prefix_op_jit(int32_t seg);
void do_many_cycles_unsafe(void);
void raise_exception(int32_t interrupt_nr);
void raise_exception_with_code(int32_t interrupt_nr, int32_t error_code);
void trigger_de(void);
void trigger_ud(void);
void trigger_nm(void);
void trigger_gp(int32_t code);
int32_t virt_boundary_read16(int32_t low, int32_t high);
int32_t virt_boundary_read32s(int32_t low, int32_t high);
void virt_boundary_write16(int32_t low, int32_t high, int32_t value);
void virt_boundary_write32(int32_t low, int32_t high, int32_t value);
int32_t safe_read8(int32_t addr);
int32_t safe_read16(int32_t addr);
int32_t safe_read32s(int32_t address);
union reg64 safe_read64s(int32_t addr);
union reg128 safe_read128s(int32_t addr);
void safe_write8(int32_t addr, int32_t value);
void safe_write16(int32_t addr, int32_t value);
void safe_write32(int32_t address, int32_t value);
void safe_write64(int32_t addr, int64_t value);
void safe_write128(int32_t addr, union reg128 value);
int32_t get_reg8_index(int32_t index);
int32_t read_reg8(int32_t index);
void write_reg8(int32_t index, int32_t value);
int32_t get_reg16_index(int32_t index);
int32_t read_reg16(int32_t index);
void write_reg16(int32_t index, int32_t value);
int32_t read_reg32(int32_t index);
void write_reg32(int32_t index, int32_t value);
void write_reg_osize(int32_t index, int32_t value);
int32_t read_mmx32s(int32_t r);
union reg64 read_mmx64s(int32_t r);
void write_mmx64(int32_t r, int32_t low, int32_t high);
void write_mmx_reg64(int32_t r, union reg64 data);
union reg64 read_xmm64s(int32_t r);
union reg128 read_xmm128s(int32_t r);
void write_xmm64(int32_t r, union reg64 data);
void write_xmm128(int32_t r, int32_t i0, int32_t i1, int32_t i2, int32_t i3);
void write_xmm_reg128(int32_t r, union reg128 data);
void clear_tlb(void);
void full_clear_tlb(void);
void task_switch_test(void);
void task_switch_test_mmx(void);
int32_t read_moffs(void);
int32_t get_real_eip(void);
int32_t get_stack_reg(void);
void set_stack_reg(int32_t value);
int32_t get_reg_asize(int32_t reg);
void set_ecx_asize(int32_t value);
void add_reg_asize(int32_t reg, int32_t value);
int32_t decr_ecx_asize(void);
void set_tsc(uint32_t, uint32_t);
uint64_t read_tsc(void);
bool vm86_mode(void);
int32_t getiopl(void);
