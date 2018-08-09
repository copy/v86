#pragma once

#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#include "const.h"
#include "config.h"
#include "shared.h"

extern uint8_t* mem8;
extern uint16_t* mem16;
extern int32_t* mem32s;

union reg128 {
    int8_t i8[16];
    int16_t i16[8];
    int32_t i32[4];
    int64_t i64[2];
    uint8_t u8[16];
    uint16_t u16[8];
    uint32_t u32[4];
    uint64_t u64[2];
    float_t f32[4];
    double_t f64[2];
};
//_Static_assert(sizeof(union reg128) == 16, "reg128 is 16 bytes");

union reg64 {
    int8_t i8[8];
    int16_t i16[4];
    int32_t i32[2];
    int64_t i64[1];
    uint8_t u8[8];
    uint16_t u16[4];
    uint32_t u32[2];
    uint64_t u64[1];
    float_t f32[2];
    double f64[1];
};
//_Static_assert(sizeof(union reg64) == 8, "reg64 is 8 bytes");

typedef uint8_t cached_state_flags;

// Flag indicating whether the instruction that just ran was at a block's boundary (jump,
// state-altering, etc.)
extern bool jit_block_boundary;

extern const int32_t VALID_TLB_ENTRY_MAX;
extern int32_t valid_tlb_entries[10000];
extern int32_t valid_tlb_entries_count;

extern const int32_t TLB_VALID;
extern const int32_t TLB_READONLY;
extern const int32_t TLB_NO_USER;
extern const int32_t TLB_IN_MAPPED_RANGE;
extern const int32_t TLB_GLOBAL;
extern const int32_t TLB_HAS_CODE;

extern const int32_t CPU_EXCEPTION_DE;  // Divide Error
extern const int32_t CPU_EXCEPTION_DB;  // Debug Exception
extern const int32_t CPU_EXCEPTION_NMI; // NMI Interrupt
extern const int32_t CPU_EXCEPTION_BP;  // Breakpoint
extern const int32_t CPU_EXCEPTION_OF;  // Overflow
extern const int32_t CPU_EXCEPTION_BR;  // BOUND Range Exceeded
extern const int32_t CPU_EXCEPTION_UD;  // Invalid Opcode
extern const int32_t CPU_EXCEPTION_NM;  // Device Not Available
extern const int32_t CPU_EXCEPTION_DF;  // Double Fault
extern const int32_t CPU_EXCEPTION_TS; // Invalid TSS
extern const int32_t CPU_EXCEPTION_NP; // Segment Not Present
extern const int32_t CPU_EXCEPTION_SS; // Stack-Segment Fault
extern const int32_t CPU_EXCEPTION_GP; // General Protection
extern const int32_t CPU_EXCEPTION_PF; // Page Fault
extern const int32_t CPU_EXCEPTION_MF; // x87 FPU Floating-Point Error
extern const int32_t CPU_EXCEPTION_AC; // Alignment Check
extern const int32_t CPU_EXCEPTION_MC; // Machine Check Abort
extern const int32_t CPU_EXCEPTION_XM; // SIMD Floating-Point Exception
extern const int32_t CPU_EXCEPTION_VE; // Virtualization Exception

// defined in call-indirect.ll
extern void call_indirect(int32_t index);
extern void call_indirect1(int32_t index, int32_t arg);

void after_block_boundary(void);

bool same_page(int32_t, int32_t);

int32_t get_eflags(void);
uint32_t translate_address_read(int32_t address);
uint32_t translate_address_write(int32_t address);
void tlb_set_has_code(uint32_t physical_page, bool has_code);
void check_tlb_invariants(void);

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

void cycle_internal(void);
void run_prefix_instruction(void);
void clear_prefixes(void);
void segment_prefix_op(int32_t seg);

bool has_flat_segmentation(void);
void do_many_cycles_unsafe(void);
void raise_exception(int32_t interrupt_nr);
void raise_exception_with_code(int32_t interrupt_nr, int32_t error_code);
void trigger_de(void);
void trigger_ud(void);
void trigger_nm(void);
void trigger_gp(int32_t code);
void trigger_gp_non_raising(int32_t code);
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
float_t read_xmm_f32(int32_t r);
int32_t read_xmm32(int32_t r);
union reg64 read_xmm64s(int32_t r);
union reg128 read_xmm128s(int32_t r);
void write_xmm_f32(int32_t r, float_t data);
void write_xmm32(int32_t r, int32_t);
void write_xmm64(int32_t r, union reg64 data);
void write_xmm128(int32_t r, int32_t i0, int32_t i1, int32_t i2, int32_t i3);
void write_xmm_reg128(int32_t r, union reg128 data);
void clear_tlb(void);
void full_clear_tlb(void);
bool task_switch_test(void);
void task_switch_test_void(void);
bool task_switch_test_mmx(void);
void task_switch_test_mmx_void(void);
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

int32_t get_opstats_buffer(int32_t index);
