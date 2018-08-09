#pragma once

#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#include "const.h"
#include "shared.h"

extern uint8_t* const reg8;
extern uint16_t* const reg16;
extern int8_t* const reg8s;
extern int16_t* const reg16s;
extern int32_t* const reg32s;

extern int32_t* const last_op1;
extern int32_t* const last_op2;
extern int32_t* const last_op_size;
extern int32_t* const last_add_result;
extern int32_t* const last_result;
extern int32_t* const flags_changed;
extern int32_t* const flags;

extern bool* const page_fault;

// gap

extern bool* const a20_enabled;
extern int32_t* const instruction_pointer;
extern int32_t* const previous_ip;

extern int32_t* const idtr_size;
extern int32_t* const idtr_offset;
extern int32_t* const gdtr_size;
extern int32_t* const gdtr_offset;
extern int32_t* const cr; // length 32

extern uint8_t* const cpl;
extern bool* const in_hlt;
extern int32_t* const last_virt_eip;
extern int32_t* const eip_phys;
extern int32_t* const last_virt_esp;
extern int32_t* const esp_phys;
extern int32_t* const sysenter_cs;
extern int32_t* const sysenter_esp;
extern int32_t* const sysenter_eip;
extern uint8_t* const prefixes;
// gap
extern uint32_t* const timestamp_counter;

extern uint16_t* const sreg;
extern int32_t* const dreg; // length 32
extern int32_t* const fw_value;
extern bool* const segment_is_null; // length 8
extern int32_t* const segment_offsets; // length 32
extern uint32_t* const segment_limits; // length 32

extern bool* const protected_mode;
extern bool* const is_32;
extern bool* const stack_size_32;
extern uint32_t* const memory_size;
extern int32_t* const fpu_stack_empty;

// gap

extern int32_t* const mxcsr;

extern union reg128* const reg_xmm; // length 128

extern uint64_t* const current_tsc;

extern double_t* const fpu_st; // length 64
extern uint8_t* const fpu_st8;
extern int32_t* const fpu_st32;

extern uint32_t* const fpu_stack_ptr;
extern int32_t* const fpu_control_word;
extern int32_t* const fpu_status_word;
extern int32_t* const fpu_opcode;
extern int32_t* const fpu_ip;
extern int32_t* const fpu_ip_selector;
extern int32_t* const fpu_dp;
extern int32_t* const fpu_dp_selector;

extern union reg64* const reg_mmx; // length 64

// gap

extern uint32_t* const opstats_buffer; // length 0x400
extern uint32_t* const opstats_buffer_0f; // length 0x400

// gap

extern int32_t* const tlb_data; // length 0x100000*4
