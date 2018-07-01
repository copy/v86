#pragma once

#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "cpu.h"

// like memcpy, but only efficient for large (approximately 10k) sizes
// See memcpy in https://github.com/kripken/emscripten/blob/master/src/library.js
extern void* memcpy_large(void* dest, const void* src, size_t n);
extern bool cpu_exception_hook(int32_t);
extern bool has_rand_int(void);
extern int32_t arpl(int32_t, int32_t);
extern int32_t bswap(int32_t);
extern int32_t get_rand_int(void);
extern int32_t int_log2(int32_t);
extern int32_t lar(int32_t, int32_t);
extern int32_t lsl(int32_t, int32_t);
extern int32_t mmap_read16(uint32_t);
extern int32_t mmap_read32(uint32_t);
extern int32_t mmap_read8(uint32_t);
extern int32_t set_cr0(int32_t);
extern int32_t verr(int32_t);
extern int32_t verw(int32_t);

extern void codegen_finalize(int32_t, int32_t, int32_t, int32_t, int32_t);
extern void log_uncompiled_code(int32_t, int32_t);
extern void dump_function_code(const struct basic_block* basic_block, int32_t basic_block_count, int32_t end);

extern void cpl_changed(void);
extern void cpuid(void);
extern void enter16(int32_t, int32_t);
extern void enter32(int32_t, int32_t);
extern void far_jump(int32_t, int32_t, int32_t);
extern void far_return(int32_t, int32_t, int32_t);
extern void handle_irqs(void);
extern void hlt_op(void);
extern void invlpg(int32_t);
extern void iret16(void);
extern void iret32(void);
extern void load_ldt(int32_t);
extern void load_tr(int32_t);
extern void mmap_write128(uint32_t, int32_t, int32_t, int32_t, int32_t);
extern void mmap_write16(uint32_t, int32_t);
extern void mmap_write32(uint32_t, int32_t);
extern void mmap_write8(uint32_t, int32_t);
extern void popa16(void);
extern void popa32(void);
extern void todo(void);
extern void undefined_instruction(void);
extern void unimplemented_sse(void);
extern void update_cs_size(int32_t);
extern void update_eflags(int32_t);
extern void switch_seg(int32_t, int32_t);
extern void lss16(int32_t, int32_t, int32_t);
extern void lss32(int32_t, int32_t, int32_t);
extern void test_privileges_for_io(int32_t, int32_t);
extern int32_t io_port_read8(int32_t);
extern int32_t io_port_read16(int32_t);
extern int32_t io_port_read32(int32_t);
extern void io_port_write8(int32_t, int32_t);
extern void io_port_write16(int32_t, int32_t);
extern void io_port_write32(int32_t, int32_t);
extern int32_t convert_f64_to_i32(double_t);
extern void jit_clear_func(int32_t index);
extern void call_interrupt_vector(int32_t interrupt_nr, bool is_software_int, bool has_error_code, int32_t error_code);
extern void throw_cpu_exception(void);
extern double_t microtick(void);
