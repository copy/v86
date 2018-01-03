#pragma once

#include<stdint.h>

#include "util.h"

static Buffer op;
static Buffer cs;

static void write_type_section()
{
    write_raw_u8(&op, SC_TYPE);

    uint8_t* ptr_section_size = op.ptr;
    write_raw_u8(&op, 0);

    write_raw_u8(&op, 6); // number of type descriptors

    // FN0
    write_raw_u8(&op, TYPE_FUNC);
    write_raw_u8(&op, 0); // no args
    write_raw_u8(&op, 0); // no return val

    // FN1
    write_raw_u8(&op, TYPE_FUNC);
    write_raw_u8(&op, 1);
    write_raw_u8(&op, TYPE_I32);
    write_raw_u8(&op, 0);

    // FN2
    write_raw_u8(&op, TYPE_FUNC);
    write_raw_u8(&op, 2);
    write_raw_u8(&op, TYPE_I32);
    write_raw_u8(&op, TYPE_I32);
    write_raw_u8(&op, 0);

    // FN0_RET
    write_raw_u8(&op, TYPE_FUNC);
    write_raw_u8(&op, 0);
    write_raw_u8(&op, 1);
    write_raw_u8(&op, TYPE_I32);

    // FN1_RET
    write_raw_u8(&op, TYPE_FUNC);
    write_raw_u8(&op, 1);
    write_raw_u8(&op, TYPE_I32);
    write_raw_u8(&op, 1);
    write_raw_u8(&op, TYPE_I32);

    // FN2_RET
    write_raw_u8(&op, TYPE_FUNC);
    write_raw_u8(&op, 2);
    write_raw_u8(&op, TYPE_I32);
    write_raw_u8(&op, TYPE_I32);
    write_raw_u8(&op, 1);
    write_raw_u8(&op, TYPE_I32);

    *ptr_section_size = (op.ptr - 1) - ptr_section_size;
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
    write_raw_u8(&op, SC_IMPORT);

    ptr_import_table_size = op.ptr; // store current pointer location to write into later on
    write_raw_u8(&op, 1 | 0b10000000); write_raw_u8(&op, 0); // 1 in 2 byte leb

    // same as above but for count of entries
    ptr_import_count = op.ptr;
    write_raw_u8(&op, 0);

    // here after starts the actual list of imports
    ptr_import_entries = op.ptr;
}

static void write_memory_import()
{
    write_raw_u8(&op, 1);
    write_raw_u8(&op, 'e');
    write_raw_u8(&op, 1);
    write_raw_u8(&op, 'm');

    write_raw_u8(&op, EXT_MEMORY);

    write_raw_u8(&op, 0); // memory flag, 0 for no maximum memory limit present
    write_leb_u32(&op, 256); // initial memory length of 256 pages, takes 2 bytes in leb128

    *ptr_import_count += 1;
    set_import_table_size(import_table_size + 1 + 1 + 1 + 1 + 1 + 1 + 2);
}

static uint8_t write_import_entry(char* fn_name, uint8_t fn_name_len, uint8_t type_index)
{
    write_raw_u8(&op, 1); // length of module name
    write_raw_u8(&op, 'e'); // module name
    write_raw_u8(&op, fn_name_len);
    for (uint8_t i = 0; i < fn_name_len; i++)
    {
        write_raw_u8(&op, fn_name[i]);
    }
    write_raw_u8(&op, EXT_FUNCTION);
    write_raw_u8(&op, type_index);
    *ptr_import_count += 1;

    set_import_table_size(import_table_size + 1 + 1 + 1 + fn_name_len + 1 + 1);

    return *ptr_import_count - 1;
}

static void write_function_section()
{
    write_raw_u8(&op, SC_FUNCTION);
    write_raw_u8(&op, 2); // length of this section
    write_raw_u8(&op, 1); // count of signature indices
    write_raw_u8(&op, FN0_TYPE_INDEX); // we export one function which is nullary
}

static void write_export_section()
{
    write_raw_u8(&op, SC_EXPORT);
    write_raw_u8(&op, 1 + 1 + 1 + 1 + 1); // size of this section
    write_raw_u8(&op, 1); // count of table: just one function exported

    write_raw_u8(&op, 1); // length of exported function name
    write_raw_u8(&op, 'f'); // function name
    write_raw_u8(&op, EXT_FUNCTION);

    // index of the exported function
    // function space starts with imports. index of last import is import count - 1
    // the last import however is a memory, so we subtract one from that
    write_raw_u8(&op, *ptr_import_count - 1);
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

static void copy_code_section()
{
    uint8_t* offset = cs.start;
    while (offset < cs.ptr)
    {
        write_raw_u8(&op, *offset++);
    }
}

