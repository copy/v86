#include <stdint.h>
#include <stdlib.h>
#include <assert.h>

#include "cstring.h"
#include "const.h"
#include "wasm_opcodes.h"
#include "codegen.h"
#include "util.h"
#include "module_init.h"

static Writer op = { .start = (uint8_t* const) 2048, .ptr = (uint8_t*) 2048, .len = 1024 };
Writer cs = { .start = (uint8_t* const) 3072, .ptr = (uint8_t*) 3072, .len = 1024 };

static uint8_t* op_ptr_reset_location;
static uint32_t import_table_size_reset_value;
static uint32_t initial_import_count;

void gen_init()
{
    // wasm magic header
    write_raw_u8(&op, 0); write_raw_u8(&op, 'a'); write_raw_u8(&op, 's'); write_raw_u8(&op, 'm');

    // wasm version in leb128, 4 bytes
    write_raw_u8(&op, WASM_VERSION); write_raw_u8(&op, 0); write_raw_u8(&op, 0); write_raw_u8(&op, 0);

    write_type_section();
    write_import_section_preamble();

    // add initial imports
    uint8_t _fn_get_seg_prefix_ds_idx = write_import_entry(
            "get_seg_prefix_ds", 17, FN1_RET_TYPE_INDEX);
    assert(_fn_get_seg_prefix_ds_idx == fn_get_seg_prefix_ds_idx);

    uint8_t _fn_get_seg_prefix_ss_idx = write_import_entry(
            "get_seg_prefix_ss", 17, FN1_RET_TYPE_INDEX);
    assert(_fn_get_seg_prefix_ss_idx == fn_get_seg_prefix_ss_idx);

    uint8_t _fn_get_seg_prefix_idx = write_import_entry(
            "get_seg_prefix", 14, FN1_RET_TYPE_INDEX);
    assert(_fn_get_seg_prefix_idx == fn_get_seg_prefix_idx);

    // store state of current pointers etc. so we can reset them later
    op_ptr_reset_location = op.ptr;
    initial_import_count = *ptr_import_count;
    import_table_size_reset_value = import_table_size;
}

void gen_reset()
{
    op.ptr = op_ptr_reset_location;
    cs.ptr = cs.start;
    *ptr_import_count = initial_import_count;
    import_table_size = import_table_size_reset_value;
}

uintptr_t gen_finish()
{
    write_memory_import();
    write_function_section();
    write_export_section();

    uint8_t* ptr_code_section_size = (uint8_t*) 0; // initialized below
    uint8_t* ptr_fn_body_size = (uint8_t*) 0; // this as well

    // write code section preamble
    write_raw_u8(&op, SC_CODE);
    ptr_code_section_size = op.ptr; // we will write to this location later
    write_raw_u8(&op, 0); write_raw_u8(&op, 0); // write temp val for now using 2 bytes

    write_raw_u8(&op, 1); // number of function bodies: just 1

    // same as above but for body size of the function
    ptr_fn_body_size = op.ptr;
    write_raw_u8(&op, 0); write_raw_u8(&op, 0);

    write_raw_u8(&op, 0); // count of locals, none

    copy_code_section();

    // write code section epilogue
    write_raw_u8(&op, OP_END);

    // write the actual sizes to the pointer locations stored above. We subtract 1 from the actual
    // value because the ptr itself points to two bytes
    write_fixed_leb16_to_ptr(ptr_fn_body_size, ((op.ptr - 1) - ptr_fn_body_size) - 1);
    write_fixed_leb16_to_ptr(ptr_code_section_size, ((op.ptr - 1) - ptr_code_section_size) - 1);

    return (uintptr_t) op.ptr;
}

uintptr_t gen_get_final_offset()
{
    return (uintptr_t) op.ptr;
}

