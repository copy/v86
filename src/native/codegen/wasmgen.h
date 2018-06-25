#pragma once

#include <stdint.h>

typedef struct PackedStr {
    uint64_t a;
    uint64_t b;
    uint64_t c;
} PackedStr;

#define PSTR_TY uint64_t, uint64_t, uint64_t

extern uint8_t* wg_get_code_section(void);
extern uint8_t* wg_get_instruction_body(void);
extern void wg_commit_instruction_body_to_cs(void);
extern void wg_finish(uint8_t no_of_locals_i32);
extern void wg_reset(void);
extern uint16_t wg_get_fn_idx(PSTR_TY, uint8_t fn_type);

extern void wg_push_i32(uint8_t* buf, int32_t v);
extern void wg_push_u32(uint8_t* buf, uint32_t v);
extern void wg_load_aligned_u16(uint8_t* buf, uint32_t addr);
extern void wg_load_aligned_i32(uint8_t* buf, uint32_t addr);
extern void wg_store_aligned_u16(uint8_t* buf);
extern void wg_store_aligned_i32(uint8_t* buf);
extern void wg_add_i32(uint8_t* buf);
extern void wg_and_i32(uint8_t* buf);
extern void wg_or_i32(uint8_t* buf);
extern void wg_shl_i32(uint8_t* buf);
extern void wg_call_fn(uint8_t* buf, uint16_t fn_idx);
extern void wg_call_fn_with_arg(uint8_t* buf, uint16_t fn_idx, int32_t arg0);
extern void wg_eq_i32(uint8_t* buf);
extern void wg_ne_i32(uint8_t* buf);
extern void wg_le_i32(uint8_t* buf);
extern void wg_lt_i32(uint8_t* buf);
extern void wg_ge_i32(uint8_t* buf);
extern void wg_gt_i32(uint8_t* buf);
extern void wg_if_i32(uint8_t* buf);
extern void wg_block_i32(uint8_t* buf);
extern void wg_tee_local(uint8_t* buf, int32_t idx);
extern void wg_xor_i32(uint8_t* buf);
extern void wg_load_unaligned_i32_from_stack(uint8_t* buf, uint32_t byte_offset);
extern void wg_load_aligned_i32_from_stack(uint8_t* buf, uint32_t byte_offset);
extern void wg_store_unaligned_i32(uint8_t* buf, uint32_t byte_offset);
extern void wg_shr_u32(uint8_t* buf);
extern void wg_shr_i32(uint8_t* buf);
extern void wg_eqz_i32(uint8_t* buf);
extern void wg_if_void(uint8_t* buf);
extern void wg_else(uint8_t* buf);
extern void wg_loop_void(uint8_t* buf);
extern void wg_block_void(uint8_t* buf);
extern void wg_block_end(uint8_t* buf);
extern void wg_return(uint8_t* buf);
extern void wg_drop(uint8_t* buf);
extern void wg_brtable_and_cases(uint8_t* buf, int32_t cases_count);
extern void wg_br(uint8_t* buf, int32_t depth);
extern void wg_get_local(uint8_t* buf, int32_t idx);
extern void wg_set_local(uint8_t* buf, int32_t idx);
extern void wg_unreachable(uint8_t* buf);
extern void wg_increment_mem32(uint8_t* buf, int32_t addr);
extern void wg_increment_variable(uint8_t* buf, int32_t addr, int32_t n);
extern void wg_load_aligned_u16_from_stack(uint8_t* buf, uint32_t byte_offset);

extern void wg_fn0_const(uint8_t* buf, PSTR_TY);
extern void wg_fn0_const_ret(uint8_t* buf, PSTR_TY);
extern void wg_fn1_const(uint8_t* buf, PSTR_TY, int32_t arg0);
extern void wg_fn1_const_ret(uint8_t* buf, PSTR_TY, int32_t arg0);
extern void wg_fn2_const(uint8_t* buf, PSTR_TY, int32_t arg0, int32_t arg1);
extern void wg_fn3_const(uint8_t* buf, PSTR_TY, int32_t arg0, int32_t arg1, int32_t arg2);
extern void wg_call_fn1_ret(uint8_t* buf, PSTR_TY);
extern void wg_call_fn2(uint8_t* buf, PSTR_TY);

#undef PSTR_TY

