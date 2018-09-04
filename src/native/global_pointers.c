#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#include "const.h"
#include "shared.h"

uint8_t* const reg8 = (uint8_t* const) 4;
uint16_t* const reg16 = (uint16_t* const) 4;
int8_t* const reg8s = (int8_t* const) 4;
int16_t* const reg16s = (int16_t* const) 4;
int32_t* const reg32s = (int32_t* const) 4;

int32_t* const last_op1 = (int32_t* const) 512;
int32_t* const last_op2 = (int32_t* const) 516;
int32_t* const last_op_size = (int32_t* const) 520;
int32_t* const last_add_result = (int32_t* const) 524;
int32_t* const last_result = (int32_t* const) 528;
int32_t* const flags_changed = (int32_t* const) 532;
int32_t* const flags = (int32_t* const) 536;

bool* const page_fault = (bool* const) 540;

// gap

bool* const a20_enabled = (bool* const) 552;
int32_t* const instruction_pointer = (int32_t* const) 556;
int32_t* const previous_ip = (int32_t* const) 560;

int32_t* const idtr_size = (int32_t* const) 564;
int32_t* const idtr_offset = (int32_t* const) 568;
int32_t* const gdtr_size = (int32_t* const) 572;
int32_t* const gdtr_offset = (int32_t* const) 576;
int32_t* const cr = (int32_t* const) 580; // length 32

uint8_t* const cpl = (uint8_t* const) 612;
bool* const in_hlt = (bool* const) 616;
int32_t* const last_virt_eip = (int32_t* const) 620;
int32_t* const eip_phys = (int32_t* const) 624;
int32_t* const last_virt_esp = (int32_t* const) 628;
int32_t* const esp_phys = (int32_t* const) 632;
int32_t* const sysenter_cs = (int32_t* const) 636;
int32_t* const sysenter_esp = (int32_t* const) 640;
int32_t* const sysenter_eip = (int32_t* const) 644;
uint8_t* const prefixes = (uint8_t* const) 648;
// gap
uint32_t* const timestamp_counter = (uint32_t* const) 664;

uint16_t* const sreg = (uint16_t* const) 668;
int32_t* const dreg = (int32_t* const) 684; // length 32
int32_t* const fw_value = (int32_t* const) 720;
bool* const segment_is_null = (bool* const) 724; // length 8
int32_t* const segment_offsets = (int32_t* const) 736; // length 32
uint32_t* const segment_limits = (uint32_t* const) 768; // length 32

bool* const protected_mode = (bool* const) 800;
bool* const is_32 = (bool* const) 804;
bool* const stack_size_32 = (bool* const) 808;
uint32_t* const memory_size = (uint32_t* const) 812;
int32_t* const fpu_stack_empty = (int32_t* const) 816;

// gap

int32_t* const mxcsr = (int32_t* const) 824;

union reg128* const reg_xmm = (union reg128* const) 828; // length 128

uint64_t* const current_tsc = (uint64_t* const) 956;

double_t* const fpu_st = (double_t* const) 968; // length 64
uint8_t* const fpu_st8 = (uint8_t* const) 968;
int32_t* const fpu_st32 = (int32_t* const) 968;

uint32_t* const fpu_stack_ptr = (uint32_t* const) 1032;
int32_t* const fpu_control_word = (int32_t* const) 1036;
int32_t* const fpu_status_word = (int32_t* const) 1040;
int32_t* const fpu_opcode = (int32_t* const) 1044;
int32_t* const fpu_ip = (int32_t* const) 1048;
int32_t* const fpu_ip_selector = (int32_t* const) 1052;
int32_t* const fpu_dp = (int32_t* const) 1056;
int32_t* const fpu_dp_selector = (int32_t* const) 1060;

union reg64* const reg_mmx = (union reg64* const) 1064; // length 64

extern bool* const tss_size_32 = (bool* const) 1128;

// gap

uint32_t* const opstats_buffer = (uint32_t* const) 0x1000; // length 0x400
uint32_t* const opstats_buffer_0f = (uint32_t* const) 0x1400; // length 0x400

// gap

int32_t* const tlb_data = (int32_t* const) 0x400000; // length 0x100000*4
