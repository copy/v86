#pragma once

#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#include "const.h"
#include "shared.h"

static uint8_t* const reg8 = (uint8_t* const) 4;
static uint16_t* const reg16 = (uint16_t* const) 4;
static int8_t* const reg8s = (int8_t* const) 4;
static int16_t* const reg16s = (int16_t* const) 4;
static int32_t* const reg32s = (int32_t* const) 4;

static int32_t* const last_op1 = (int32_t* const) 512;
static int32_t* const last_op2 = (int32_t* const) 516;
static int32_t* const last_op_size = (int32_t* const) 520;
static int32_t* const last_add_result = (int32_t* const) 524;
static int32_t* const last_result = (int32_t* const) 528;
static int32_t* const flags_changed = (int32_t* const) 532;
static int32_t* const flags = (int32_t* const) 536;

static bool* const page_fault = (bool* const) 540;

// gap

static bool* const a20_enabled = (bool* const) 552;
static int32_t* const instruction_pointer = (int32_t* const) 556;
static int32_t* const previous_ip = (int32_t* const) 560;

static int32_t* const idtr_size = (int32_t* const) 564;
static int32_t* const idtr_offset = (int32_t* const) 568;
static int32_t* const gdtr_size = (int32_t* const) 572;
static int32_t* const gdtr_offset = (int32_t* const) 576;
static int32_t* const cr = (int32_t* const) 580; // length 32

static uint8_t* const cpl = (uint8_t* const) 612;
static int32_t* const page_size_extensions = (int32_t* const) 616;
static int32_t* const last_virt_eip = (int32_t* const) 620;
static int32_t* const eip_phys = (int32_t* const) 624;
static int32_t* const last_virt_esp = (int32_t* const) 628;
static int32_t* const esp_phys = (int32_t* const) 632;
static int32_t* const sysenter_cs = (int32_t* const) 636;
static int32_t* const sysenter_esp = (int32_t* const) 640;
static int32_t* const sysenter_eip = (int32_t* const) 644;
static uint8_t* const prefixes = (uint8_t* const) 648;
// gap
static uint32_t* const timestamp_counter = (uint32_t* const) 664;

static uint16_t* const sreg = (uint16_t* const) 668;
static int32_t* const dreg = (int32_t* const) 684; // length 32
static int32_t* const fw_value = (int32_t* const) 720;
static bool* const segment_is_null = (bool* const) 724; // length 8
static int32_t* const segment_offsets = (int32_t* const) 736; // length 32
static uint32_t* const segment_limits = (uint32_t* const) 768; // length 32

static bool* const protected_mode = (bool* const) 800;
static bool* const is_32 = (bool* const) 804;
static bool* const stack_size_32 = (bool* const) 808;
static uint32_t* const memory_size = (uint32_t* const) 812;
static int32_t* const fpu_stack_empty = (int32_t* const) 816;

static bool* const paging = (bool* const) 820;

static int32_t* const mxcsr = (int32_t* const) 824;

static union reg128* const reg_xmm = (union reg128* const) 828; // length 128

static uint64_t* const current_tsc = (uint64_t* const) 956;

static double_t* const fpu_st = (double_t* const) 968; // length 64
static uint8_t* const fpu_st8 = (uint8_t* const) 968;
static int32_t* const fpu_st32 = (int32_t* const) 968;

static uint32_t* const fpu_stack_ptr = (uint32_t* const) 1032;
static int32_t* const fpu_control_word = (int32_t* const) 1036;
static int32_t* const fpu_status_word = (int32_t* const) 1040;
static int32_t* const fpu_opcode = (int32_t* const) 1044;
static int32_t* const fpu_ip = (int32_t* const) 1048;
static int32_t* const fpu_ip_selector = (int32_t* const) 1052;
static int32_t* const fpu_dp = (int32_t* const) 1056;
static int32_t* const fpu_dp_selector = (int32_t* const) 1060;

static union reg64* const reg_mmx = (union reg64* const) 1064; // length 64

// gap

static uint8_t* const codegen_buffer_op = (uint8_t* const) 0x1000; // length 0x100000
static uint8_t* const codegen_buffer_cs = (uint8_t* const) 0x101000; // length 0x100000
static uint8_t* const codegen_buffer_instruction_body = (uint8_t* const) 0x201000; // length 0x100000
static uint8_t* const codegen_string_input = (uint8_t* const) 0x301000; // length 32

// gap

static int32_t* const tlb_data = (int32_t* const) (0x400000); // length 0x100000*4
// A mapping from physical page to index into jit_cache_arr
static int32_t* const page_first_jit_cache_entry = (int32_t* const) (0x800000); // length 0x100000*4

static uint8_t* const mem8 = (uint8_t* const) (0x400000 + 0x100000 * 8);
static uint16_t* const mem16 = (uint16_t* const) (0x400000 + 0x100000 * 8);
static int32_t* const mem32s = (int32_t* const) (0x400000 + 0x100000 * 8);
