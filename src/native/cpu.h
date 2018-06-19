#pragma once

#include <assert.h>
#include <stdbool.h>
#include <stdint.h>

#include "const.h"
#include "config.h"
#include "shared.h"

#define CODE_CACHE_SEARCH_SIZE 8

union reg128 {
    int8_t i8[16];
    int16_t i16[8];
    int32_t i32[4];
    int64_t i64[2];
    uint8_t u8[16];
    uint16_t u16[8];
    uint32_t u32[4];
    uint64_t u64[2];
};
_Static_assert(sizeof(union reg128) == 16, "reg128 is 16 bytes");

union reg64 {
    int8_t i8[8];
    int16_t i16[4];
    int32_t i32[2];
    int64_t i64[1];
    uint8_t u8[8];
    uint16_t u16[4];
    uint32_t u32[2];
    uint64_t u64[1];
    double f64[1];
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
    int32_t virt_addr;
#endif

    // an index into jit_cache_arr for the next code_cache entry within the same physical page
    int32_t next_index_same_page;

    uint16_t wasm_table_index;
    uint16_t initial_state;
    cached_state_flags state_flags;
    bool pending;
};
#if DEBUG
#else
_Static_assert(sizeof(struct code_cache) == 16, "code_cache uses 16 bytes");
#endif
struct code_cache jit_cache_arr[JIT_CACHE_ARRAY_SIZE];

// XXX: Remove this limitation when page_entry_points is sparse
#define MAX_PHYSICAL_PAGES (512 << 20 >> 12)

#define MAX_ENTRIES_PER_PAGE 128
#define ENTRY_POINT_END 0xFFFF

uint16_t page_entry_points[MAX_PHYSICAL_PAGES][MAX_ENTRIES_PER_PAGE];

// Flag indicating whether the instruction that just ran was at a block's boundary (jump,
// state-altering, etc.)
extern uint32_t jit_block_boundary;

typedef uint32_t jit_instr_flags;

#define JIT_INSTR_BLOCK_BOUNDARY_FLAG (1 << 0)
#define JIT_INSTR_NO_NEXT_INSTRUCTION_FLAG (1 << 1)
#define JIT_INSTR_NONFAULTING_FLAG (1 << 2)
#define JIT_INSTR_IMM_JUMP16_FLAG (1 << 3)
#define JIT_INSTR_IMM_JUMP32_FLAG (1 << 4)

struct analysis {
    jit_instr_flags flags;
    int32_t jump_offset;
    int32_t condition_index;
};

struct basic_block {
    int32_t addr;
    int32_t end_addr;
    int32_t next_block_addr; // if 0 this is an exit block
    int32_t next_block_branch_taken_addr;
    int32_t condition_index; // if not -1 this block ends with a conditional jump
    int32_t jump_offset;
    bool jump_offset_is_32;
    bool is_entry_block;
};

#define BASIC_BLOCK_LIST_MAX 1000

struct basic_block_list {
    int32_t length;
    struct basic_block blocks[BASIC_BLOCK_LIST_MAX];
};

// Count of how many times prime_hash(address) has been called through a jump
extern int32_t hot_code_addresses[HASH_PRIME];

#define JIT_CACHE_ARRAY_NO_NEXT_ENTRY (-1)

uint16_t wasm_table_index_free_list[WASM_TABLE_SIZE];
int32_t wasm_table_index_free_list_count;

uint16_t wasm_table_index_pending_free[WASM_TABLE_SIZE];
int32_t wasm_table_index_pending_free_count;

#define VALID_TLB_ENTRY_MAX 10000
int32_t valid_tlb_entries[VALID_TLB_ENTRY_MAX];
int32_t valid_tlb_entries_count;

#define TLB_VALID (1 << 0)
#define TLB_READONLY (1 << 1)
#define TLB_NO_USER (1 << 2)
#define TLB_IN_MAPPED_RANGE (1 << 3)
#define TLB_GLOBAL (1 << 4)

// Indices for local variables and function arguments (which are accessed as local variables) for
// the generated WASM function
#define GEN_LOCAL_ARG_INITIAL_STATE 0
#define GEN_LOCAL_STATE 1
#define GEN_LOCAL_ITERATION_COUNTER 2
// local scratch variables for use wherever required
#define GEN_LOCAL_SCRATCH0 3
#define GEN_LOCAL_SCRATCH1 4
#define GEN_LOCAL_SCRATCH2 5
// Function arguments are not included in the local variable count
#define GEN_NO_OF_LOCALS 5

// defined in call-indirect.ll
extern void call_indirect(int32_t index);
extern void call_indirect1(int32_t index, int32_t arg);

void after_block_boundary(void);
struct analysis analyze_step(int32_t);

void after_jump(void);
void diverged(void);
void branch_taken(void);
void branch_not_taken(void);

bool same_page(int32_t, int32_t);

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
int32_t get_seg_cs(void);
int32_t get_seg_ss(void);
int32_t get_seg_prefix(int32_t default_segment);
int32_t get_seg_prefix_ds(int32_t offset);
int32_t get_seg_prefix_ss(int32_t offset);
int32_t get_seg_prefix_cs(int32_t offset);
int32_t modrm_resolve(int32_t modrm_byte);
void modrm_skip(int32_t modrm_byte);

void check_jit_cache_array_invariants(void);

uint32_t jit_hot_hash_page(uint32_t page);
void jit_link_block(int32_t target);
void jit_link_block_conditional(int32_t offset, const char* condition);
void cycle_internal(void);
void run_prefix_instruction(void);
jit_instr_flags jit_prefix_instruction(void);
void clear_prefixes(void);
void segment_prefix_op(int32_t seg);
jit_instr_flags segment_prefix_op_jit(int32_t seg);
bool has_flat_segmentation(void);
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
