#!/usr/bin/env node
"use strict";

// Read a wasm module in binary format from stdin, find table import entries, i.e.:
//
//   (import "env" "table" (table (;0;) <initial> <maximum> anyfunc))
//
// Remove the <maximum> and write the patched wasm module to stdout.

process.on("unhandledRejection", exn => { throw exn; });

const fs = require("fs");

const SECTION_IMPORT = 2;

const IMPORT_KIND_FUNCTION = 0;
const IMPORT_KIND_TABLE = 1;
const IMPORT_KIND_MEMORY = 2;
const IMPORT_KIND_GLOBAL = 3;

function main()
{
    const wasm = fs.readFileSync("/dev/stdin");
    const view = new DataView(wasm.buffer);
    var ptr = 0;

    // magic
    console.assert(view.getUint32(ptr, true) === 0x6d736100);
    ptr += 4;

    // version
    console.assert(view.getUint32(ptr, true) === 1);
    ptr += 4;

    while(ptr < view.byteLength)
    {
        const section_id = view.getUint8(ptr);
        ptr++;
        var { ptr, value: size } = read_leb_u32(ptr, view);
        const section_end = ptr + size;

        if(section_id === SECTION_IMPORT)
        {
            patch_import_section(ptr, view);
        }

        ptr = section_end;
    }

    // sanity check
    const module = new WebAssembly.Module(view.buffer);

    process.stdout.write(wasm);
}

function patch_import_section(ptr, view)
{
    var { ptr, value: section_entry_count } = read_leb_u32(ptr, view);

    for(let i = 0; i < section_entry_count; i++)
    {
        var { ptr, value: module_str_length } = read_leb_u32(ptr, view);
        ptr += module_str_length;
        var { ptr, value: field_str_length } = read_leb_u32(ptr, view);
        ptr += field_str_length;

        const kind = view.getUint8(ptr);
        ptr++;

        if(kind === IMPORT_KIND_FUNCTION)
        {
            var { ptr, value: function_signature_index } = read_leb_u32(ptr, view);
        }
        else if(kind === IMPORT_KIND_TABLE)
        {
            const table_offset = ptr;
            var { ptr, value: table_element_type } = read_leb_u32(ptr, view);
            console.assert(table_element_type === 0x70);

            const maximum_present = new Uint8Array(view.buffer, ptr, 1);
            console.assert(maximum_present[0] === 0 || maximum_present[0] === 1);
            ptr++;

            var { ptr, value: initial_table_size, leb_view: initial_table_size_view } = read_leb_u32(ptr, view);

            if(maximum_present[0])
            {
                var { ptr, value: maximum_table_size, leb_view: maximum_table_size_view } = read_leb_u32(ptr, view);
            }
            else
            {
                maximum_table_size = -1;
            }

            console.error(`Found table import at offset` +
                          ` ${table_offset}` +
                          ` maximum_present=${maximum_present[0]}` +
                          ` initial=${initial_table_size}` +
                          ` maximum=${maximum_table_size}`);

            if(maximum_present[0])
            {
                patch_maximum_limit(maximum_present, initial_table_size_view, maximum_table_size_view);
                console.error("Patched!");
            }
            else
            {
                console.error("No maximum present, skipped");
            }
        }
        else if(kind === IMPORT_KIND_MEMORY)
        {
            const maximum_present = view.getUint8(ptr);
            console.assert(maximum_present === 0 || maximum_present === 1);
            ptr++;

            var { ptr, value: initial_memory_size } = read_leb_u32(ptr, view);

            if(maximum_present)
            {
                var { ptr, value: maximum_memory_size } = read_leb_u32(ptr, view);
            }
        }
        else if(kind === IMPORT_KIND_GLOBAL)
        {
            const content_type = view.getUint8(ptr);
            ptr++;
            const mutability = view.getUint8(ptr);
            console.assert(mutability === 0 || mutability === 1);
            ptr++;
        }
        else
        {
            console.assert(false, `Unexpected import kind: 0x${kind.toString(16)} at offset ${ptr - 1}`);
        }
    }
}

function patch_maximum_limit(maximum_present, initial_size, maximum_size)
{
    // clear the maximum present bit
    maximum_present[0] = 0;

    // set the highest bit of the initial size, in order to use it to pad the existing maximum size bytes
    const last_byte_initial_size = initial_size[initial_size.length - 1];
    console.assert((last_byte_initial_size & 0x80) === 0);
    initial_size[initial_size.length - 1] = last_byte_initial_size | 0x80;

    for(let i = 0; i < maximum_size.length - 1; i++)
    {
        // pad maximum value with 0x80 bytes
        maximum_size[i] = 0x80;
    }

    // pad the last byte of the maximum value with 0x00
    maximum_size[maximum_size.length - 1] = 0x00;
}

function read_leb_u32(ptr, view)
{
    let value = 0;
    let byte_length = 0;

    while(true)
    {
        let byte = view.getUint8(ptr++);

        value |= (byte & 0x7f) << (byte_length * 7);
        byte_length++;

        if((byte & 0x80) === 0)
        {
            break;
        }
    }

    console.assert(byte_length <= 4);

    const leb_view = new Uint8Array(view.buffer, ptr - byte_length, byte_length);

    return { ptr, value, leb_view };
}

main();
