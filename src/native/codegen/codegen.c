#include <stdint.h>
#include <stdlib.h>
#include <assert.h>

#include "cstring.h"
#include "const.h"
#include "wasm_opcodes.h"
#include "codegen_util.h"
#include "codegen.h"

uint8_t* cs_ptr = code_section;

static void write_type_section()
{
    write_u8(SC_TYPE);

    uint8_t* ptr_section_size = op_ptr;
    write_u8(0);

    write_u8(6); // number of type descriptors

    // FN0
    write_u8(TYPE_FUNC);
    write_u8(0); // no args
    write_u8(0); // no return val

    // FN1
    write_u8(TYPE_FUNC);
    write_u8(1);
    write_u8(TYPE_I32);
    write_u8(0);

    // FN2
    write_u8(TYPE_FUNC);
    write_u8(2);
    write_u8(TYPE_I32);
    write_u8(TYPE_I32);
    write_u8(0);

    // FN0_RET
    write_u8(TYPE_FUNC);
    write_u8(0);
    write_u8(1);
    write_u8(TYPE_I32);

    // FN1_RET
    write_u8(TYPE_FUNC);
    write_u8(1);
    write_u8(TYPE_I32);
    write_u8(1);
    write_u8(TYPE_I32);

    // FN2_RET
    write_u8(TYPE_FUNC);
    write_u8(2);
    write_u8(TYPE_I32);
    write_u8(TYPE_I32);
    write_u8(1);
    write_u8(TYPE_I32);

    *ptr_section_size = (op_ptr - 1) - ptr_section_size;
}

// Import table

static uint8_t* ptr_import_count = (uint8_t*) 0;
static uint8_t* ptr_import_entries = (uint8_t*) 0;
static uint8_t* ptr_import_table_size = (uint8_t*) 0;

// The import table size is written in leb encoding, which we can't read by simple dereferencing so
// we store the actual value separately. This is needed since we reserve two bytes for the import
// table size as it can exceed 127
// Default value is one as the section starts with containing one byte for the import count
static uint32_t import_table_size = 1;

// Goes over the import block to find index of an import entry by function name
// Returns -1 if not found
static int32_t get_import_index(char* fn, uint8_t fn_len)
{
    uint8_t* offset = ptr_import_entries;
    for(int32_t i = 0; i < *ptr_import_count; i++)
    {
        offset += 1; // skip length of module name
        offset += 1; // skip module name itself
        uint8_t len = *offset++;
        char* name = (char*) offset;
        if (len == fn_len && strncmp(name, fn, fn_len) == 0)
        {
            return i;
        }
        offset += len; // skip the string
        offset += 1; // skip import kind
        offset += 1; // skip type index
    }
    return -1;
}

static void set_import_table_size(uint16_t size)
{
    import_table_size = size;
    write_fixed_leb16_to_ptr(ptr_import_table_size, size);
}

static void write_import_section_preamble()
{
    write_u8(SC_IMPORT);

    ptr_import_table_size = op_ptr; // store current pointer location to write into later on
    write_u8(1 | 0b10000000); write_u8(0); // 1 in 2 byte leb

    // same as above but for count of entries
    ptr_import_count = op_ptr;
    write_u8(0);

    // here after starts the actual list of imports
    ptr_import_entries = op_ptr;
}

static void write_memory_import()
{
    write_u8(1);
    write_u8('e');
    write_u8(1);
    write_u8('m');

    write_u8(EXT_MEMORY);

    write_u8(0); // memory flag, 0 for no maximum memory limit present
    write_u32(256); // initial memory length of 256 pages, takes 2 bytes in leb128

    *ptr_import_count += 1;
    set_import_table_size(import_table_size + 1 + 1 + 1 + 1 + 1 + 1 + 2);
}

static uint8_t write_import_entry(char* fn_name, uint8_t fn_name_len, uint8_t type_index)
{
    write_u8(1); // length of module name
    write_u8('e'); // module name
    write_u8(fn_name_len);
    for (uint8_t i = 0; i < fn_name_len; i++)
    {
        write_u8(fn_name[i]);
    }
    write_u8(EXT_FUNCTION);
    write_u8(type_index);
    *ptr_import_count += 1;

    set_import_table_size(import_table_size + 1 + 1 + 1 + fn_name_len + 1 + 1);

    return *ptr_import_count - 1;
}

static void write_function_section()
{
    write_u8(SC_FUNCTION);
    write_u8(2); // length of this section
    write_u8(1); // count of signature indices
    write_u8(FN0_TYPE_INDEX); // we export one function which is nullary
}

static void write_export_section()
{
    write_u8(SC_EXPORT);
    write_u8(1 + 1 + 1 + 1 + 1); // size of this section
    write_u8(1); // count of table: just one function exported

    write_u8(1); // length of exported function name
    write_u8('f'); // function name
    write_u8(EXT_FUNCTION);

    // index of the exported function
    // function space starts with imports. index of last import is import count - 1
    // the last import however is a memory, so we subtract one from that
    write_u8(*ptr_import_count - 1);
}

int32_t get_fn_index(char* fn, uint8_t fn_len, uint8_t type_index)
{
    int32_t fn_idx = get_import_index(fn, fn_len);
    if (fn_idx == -1)
    {
        return write_import_entry(fn, fn_len, type_index);
    }
    return fn_idx;
}

static uint8_t* op_ptr_reset_location;
static uint32_t import_table_size_reset_value;
static uint32_t initial_import_count;

void gen_init()
{
    // wasm magic header
    write_u8(0); write_u8('a'); write_u8('s'); write_u8('m');

    // wasm version in leb128, 4 bytes
    write_u8(WASM_VERSION); write_u8(0); write_u8(0); write_u8(0);

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
    op_ptr_reset_location = op_ptr;
    initial_import_count = *ptr_import_count;
    import_table_size_reset_value = import_table_size;
}

void gen_reset()
{
    op_ptr = op_ptr_reset_location;
    cs_ptr = code_section;
    *ptr_import_count = initial_import_count;
    import_table_size = import_table_size_reset_value;
}

static void copy_code_section()
{
    uint8_t* offset = code_section;
    while (offset < cs_ptr)
    {
        write_u8(*offset++);
    }
}

uintptr_t gen_finish()
{
    write_memory_import();
    write_function_section();
    write_export_section();

    uint8_t* ptr_code_section_size = (uint8_t*) 0; // initialized below
    uint8_t* ptr_fn_body_size = (uint8_t*) 0; // this as well

    // write code section preamble
    write_u8(SC_CODE);
    ptr_code_section_size = op_ptr; // we will write to this location later
    write_u8(0); write_u8(0); // write temp val for now using 2 bytes

    write_u8(1); // number of function bodies: just 1

    // same as above but for body size of the function
    ptr_fn_body_size = op_ptr;
    write_u8(0); write_u8(0);

    write_u8(0); // count of locals, none

    copy_code_section();

    // write code section epilogue
    write_u8(OP_END);

    // write the actual sizes to the pointer locations stored above. We subtract 1 from the actual
    // value because the ptr itself points to two bytes
    write_fixed_leb16_to_ptr(ptr_fn_body_size, ((op_ptr - 1) - ptr_fn_body_size) - 1);
    write_fixed_leb16_to_ptr(ptr_code_section_size, ((op_ptr - 1) - ptr_code_section_size) - 1);

    return (uintptr_t) op_ptr;
}

uintptr_t gen_get_final_offset()
{
    return (uintptr_t) op_ptr;
}

