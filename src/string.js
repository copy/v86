"use strict";

/*
 * string operations
 *
 *       cmp  si  di
 * movs   0    1   1/w    A4
 * cmps   1    1   1/r    A6
 * stos   0    0   1/w    AA
 * lods   0    1   0      AC
 * scas   1    0   1/r    AE
 * ins    0    0   1/w
 * outs   0    1   0
 */

/** @const */
var MAX_COUNT_PER_CYCLE = 0x1000;


function string_get_cycle_count(size, address)
{
    dbg_assert(size && size <= 4 && size >= -4);

    if(size < 0)
    {
        return (address & 0xFFF) >> (-size >> 1);
    }
    else
    {
        return (~address & 0xFFF) >> size;
    }
}

function string_get_cycle_count2(size, addr1, addr2)
{
    dbg_assert(arguments.length === 3);

    return Math.min(
            string_get_cycle_count(size, addr1),
            string_get_cycle_count(size, addr2));
}


function movsb(cpu)
{
    var src = cpu.get_seg_prefix(reg_ds) + cpu.regv[cpu.reg_vsi] | 0;
    var dest = cpu.get_seg(reg_es) + cpu.regv[cpu.reg_vdi] | 0;
    var size = cpu.flags & flag_direction ? -1 : 1;

    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        var count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        var phys_src = cpu.translate_address_read(src);
        var phys_dest = cpu.translate_address_write(dest);
        if(cpu.paging)
        {
            cycle_counter = string_get_cycle_count2(size, src, dest);
        }
        do
        {
            cpu.write8(phys_dest, cpu.read8(phys_src));
            phys_dest += size;
            phys_src += size;
            cont = --count !== 0;
        }
        while(cont && cycle_counter--);
        var diff = size * (start_count - count) | 0;
        cpu.regv[cpu.reg_vdi] += diff;
        cpu.regv[cpu.reg_vsi] += diff;
        cpu.regv[cpu.reg_vcx] = count;
        cpu.timestamp_counter += start_count - count;
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        cpu.safe_write8(dest, cpu.safe_read8(src));
        cpu.regv[cpu.reg_vdi] += size;
        cpu.regv[cpu.reg_vsi] += size;
    }
}

function movsw(cpu)
{
    var src = cpu.get_seg_prefix(reg_ds) + cpu.regv[cpu.reg_vsi] | 0;
    var dest = cpu.get_seg(reg_es) + cpu.regv[cpu.reg_vdi] | 0;
    var size = cpu.flags & flag_direction ? -2 : 2;

    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        var count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(dest & 1) && !(src & 1))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_src = cpu.translate_address_read(src) >> 1;
            var phys_dest = cpu.translate_address_write(dest) >> 1;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count2(size, src, dest);
            }
            do
            {
                cpu.write_aligned16(phys_dest, cpu.read_aligned16(phys_src));
                phys_dest += single_size;
                phys_src += single_size;
                cont = --count !== 0;
            }
            while(cont && cycle_counter--);
            var diff = size * (start_count - count) | 0;
            cpu.regv[cpu.reg_vdi] += diff;
            cpu.regv[cpu.reg_vsi] += diff;
            cpu.regv[cpu.reg_vcx] = count;
            cpu.timestamp_counter += start_count - count;
        }
        else
        {
            do
            {
                cpu.safe_write16(dest, cpu.safe_read16(src));
                dest += size;
                cpu.regv[cpu.reg_vdi] += size;
                src += size;
                cpu.regv[cpu.reg_vsi] += size;
                cont = --cpu.regv[cpu.reg_vcx] !== 0;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        cpu.safe_write16(dest, cpu.safe_read16(src));
        cpu.regv[cpu.reg_vdi] += size;
        cpu.regv[cpu.reg_vsi] += size;
    }
}

function movsd(cpu)
{
    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        // often used by memcpy, well worth optimizing
        //   using cpu.mem32s.set
        var ds = cpu.get_seg_prefix(reg_ds),
            src = ds + cpu.regv[cpu.reg_vsi] | 0,
            es = cpu.get_seg(reg_es),
            dest = es + cpu.regv[cpu.reg_vdi] | 0,
            count = cpu.regv[cpu.reg_vcx] >>> 0;

        if(!count)
        {
            return;
        }

        // must be page-aligned if cpu.paging is enabled
        // and dword-aligned in general
        var align_mask = cpu.paging ? 0xFFF : 3;

        if((dest & align_mask) === 0 &&
           (src & align_mask) === 0 &&
           // If df is set, alignment works a different
           // This should be unlikely
           (cpu.flags & flag_direction) === 0)
        {
            var cont = false;
            if(cpu.paging)
            {
                src = cpu.translate_address_read(src);
                dest = cpu.translate_address_write(dest);

                if(count > 0x400)
                {
                    count = 0x400;
                    cont = true;
                }
            }

            if(!cpu.io.in_mmap_range(src, count) &&
                !cpu.io.in_mmap_range(dest, count))
            {
                var diff = count << 2;
                cpu.regv[cpu.reg_vcx] -= count;
                cpu.regv[cpu.reg_vdi] += diff;
                cpu.regv[cpu.reg_vsi] += diff;

                dest >>= 2;
                src >>= 2;
                cpu.write_blob32(cpu.mem32s.subarray(src, src + count), dest);

                if(cont)
                {
                    cpu.instruction_pointer = cpu.previous_ip;
                }

                return;
            }
        }
    }

    var src = cpu.get_seg_prefix(reg_ds) + cpu.regv[cpu.reg_vsi] | 0;
    var dest = cpu.get_seg(reg_es) + cpu.regv[cpu.reg_vdi] | 0;
    var size = cpu.flags & flag_direction ? -4 : 4;

    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        var count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(dest & 3) && !(src & 3))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_src = cpu.translate_address_read(src) >>> 2;
            var phys_dest = cpu.translate_address_write(dest) >>> 2;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count2(size, src, dest);
            }
            do
            {
                cpu.write_aligned32(phys_dest, cpu.read_aligned32(phys_src));
                phys_dest += single_size;
                phys_src += single_size;
                cont = --count !== 0;
            }
            while(cont && cycle_counter--);
            var diff = size * (start_count - count) | 0;
            cpu.regv[cpu.reg_vdi] += diff;
            cpu.regv[cpu.reg_vsi] += diff;
            cpu.regv[cpu.reg_vcx] = count;
            cpu.timestamp_counter += start_count - count;
        }
        else
        {
            do
            {
                cpu.safe_write32(dest, cpu.safe_read32s(src));
                dest += size;
                cpu.regv[cpu.reg_vdi] += size;
                src += size;
                cpu.regv[cpu.reg_vsi] += size;
                cont = --cpu.regv[cpu.reg_vcx] !== 0;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        cpu.safe_write32(dest, cpu.safe_read32s(src));
        cpu.regv[cpu.reg_vdi] += size;
        cpu.regv[cpu.reg_vsi] += size;
    }
}

function cmpsb(cpu)
{
    var src = cpu.get_seg_prefix(reg_ds) + cpu.regv[cpu.reg_vsi] | 0;
    var dest = cpu.get_seg(reg_es) + cpu.regv[cpu.reg_vdi] | 0;
    var data_src, data_dest;
    var size = cpu.flags & flag_direction ? -1 : 1;

    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        var count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var is_repz = cpu.repeat_string_prefix === REPEAT_STRING_PREFIX_Z;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        var phys_src = cpu.translate_address_read(src);
        var phys_dest = cpu.translate_address_read(dest);
        if(cpu.paging)
        {
            cycle_counter = string_get_cycle_count2(size, src, dest);
        }
        do
        {
            data_dest = cpu.read8(phys_dest);
            data_src = cpu.read8(phys_src);
            phys_dest += size;
            phys_src += size;
            cont = --count !== 0 && (data_src === data_dest) === is_repz;
        }
        while(cont && cycle_counter--);
        var diff = size * (start_count - count) | 0;
        cpu.regv[cpu.reg_vdi] += diff;
        cpu.regv[cpu.reg_vsi] += diff;
        cpu.regv[cpu.reg_vcx] = count;
        cpu.timestamp_counter += start_count - count;
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        data_src = cpu.safe_read8(src);
        data_dest = cpu.safe_read8(dest);
        cpu.regv[cpu.reg_vdi] += size;
        cpu.regv[cpu.reg_vsi] += size;
    }

    cpu.cmp8(data_src, data_dest);
}

function cmpsw(cpu)
{
    var src = cpu.get_seg_prefix(reg_ds) + cpu.regv[cpu.reg_vsi] | 0;
    var dest = cpu.get_seg(reg_es) + cpu.regv[cpu.reg_vdi] | 0;
    var data_src, data_dest;
    var size = cpu.flags & flag_direction ? -2 : 2;

    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        var count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var is_repz = cpu.repeat_string_prefix === REPEAT_STRING_PREFIX_Z;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(dest & 1) && !(src & 1))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_src = cpu.translate_address_read(src) >> 1;
            var phys_dest = cpu.translate_address_read(dest) >> 1;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count2(size, src, dest);
            }
            do
            {
                data_dest = cpu.read_aligned16(phys_dest);
                data_src = cpu.read_aligned16(phys_src);
                phys_dest += single_size;
                phys_src += single_size;
                cont = --count !== 0 && (data_src === data_dest) === is_repz;
            }
            while(cont && cycle_counter--);
            var diff = size * (start_count - count) | 0;
            cpu.regv[cpu.reg_vdi] += diff;
            cpu.regv[cpu.reg_vsi] += diff;
            cpu.regv[cpu.reg_vcx] = count;
            cpu.timestamp_counter += start_count - count;
        }
        else
        {
            do
            {
                data_dest = cpu.safe_read16(dest);
                data_src = cpu.safe_read16(src);
                dest += size;
                cpu.regv[cpu.reg_vdi] += size;
                src += size;
                cpu.regv[cpu.reg_vsi] += size;
                cont = --cpu.regv[cpu.reg_vcx] !== 0 && (data_src === data_dest) === is_repz;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        data_dest = cpu.safe_read16(dest);
        data_src = cpu.safe_read16(src);
        cpu.regv[cpu.reg_vdi] += size;
        cpu.regv[cpu.reg_vsi] += size;
    }

    cpu.cmp16(data_src, data_dest);
}

function cmpsd(cpu)
{
    var src = cpu.get_seg_prefix(reg_ds) + cpu.regv[cpu.reg_vsi] | 0;
    var dest = cpu.get_seg(reg_es) + cpu.regv[cpu.reg_vdi] | 0;
    var data_src, data_dest;
    var size = cpu.flags & flag_direction ? -4 : 4;

    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        var count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var is_repz = cpu.repeat_string_prefix === REPEAT_STRING_PREFIX_Z;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(dest & 3) && !(src & 3))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_src = cpu.translate_address_read(src) >>> 2;
            var phys_dest = cpu.translate_address_read(dest) >>> 2;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count2(size, src, dest);
            }
            do
            {
                data_dest = cpu.read_aligned32(phys_dest);
                data_src = cpu.read_aligned32(phys_src);
                phys_dest += single_size;
                phys_src += single_size;
                cont = --count !== 0 && (data_src === data_dest) === is_repz;
            }
            while(cont && cycle_counter--);
            var diff = size * (start_count - count) | 0;
            cpu.regv[cpu.reg_vdi] += diff;
            cpu.regv[cpu.reg_vsi] += diff;
            cpu.regv[cpu.reg_vcx] = count;
            cpu.timestamp_counter += start_count - count;
        }
        else
        {
            do
            {
                data_dest = cpu.safe_read32s(dest);
                data_src = cpu.safe_read32s(src);
                dest += size;
                cpu.regv[cpu.reg_vdi] += size;
                src += size;
                cpu.regv[cpu.reg_vsi] += size;
                cont = --cpu.regv[cpu.reg_vcx] !== 0 && (data_src === data_dest) === is_repz;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        data_dest = cpu.safe_read32s(dest);
        data_src = cpu.safe_read32s(src);
        cpu.regv[cpu.reg_vdi] += size;
        cpu.regv[cpu.reg_vsi] += size;
    }

    cpu.cmp32(data_src, data_dest);
}

function stosb(cpu)
{
    var data = cpu.reg8[reg_al];
    var dest = cpu.get_seg(reg_es) + cpu.regv[cpu.reg_vdi] | 0;
    var size = cpu.flags & flag_direction ? -1 : 1;

    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        var count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        var phys_dest = cpu.translate_address_write(dest);
        if(cpu.paging)
        {
            cycle_counter = string_get_cycle_count(size, dest);
        }
        do
        {
            cpu.write8(phys_dest, data);
            phys_dest += size;
            cont = --count !== 0;
        }
        while(cont && cycle_counter--);
        var diff = size * (start_count - count) | 0;
        cpu.regv[cpu.reg_vdi] += diff;
        cpu.regv[cpu.reg_vcx] = count;
        cpu.timestamp_counter += start_count - count;
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        cpu.safe_write8(dest, data);
        cpu.regv[cpu.reg_vdi] += size;
    }
}

function stosw(cpu)
{
    var data = cpu.reg16[reg_ax];
    var dest = cpu.get_seg(reg_es) + cpu.regv[cpu.reg_vdi] | 0;
    var size = cpu.flags & flag_direction ? -2 : 2;

    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        var count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(dest & 1))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_dest = cpu.translate_address_write(dest) >> 1;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count(size, dest);
            }
            do
            {
                cpu.write_aligned16(phys_dest, data);
                phys_dest += single_size;
                cont = --count !== 0;
            }
            while(cont && cycle_counter--);
            var diff = size * (start_count - count) | 0;
            cpu.regv[cpu.reg_vdi] += diff;
            cpu.regv[cpu.reg_vcx] = count;
            cpu.timestamp_counter += start_count - count;
        }
        else
        {
            do
            {
                cpu.safe_write16(dest, data);
                dest += size;
                cpu.regv[cpu.reg_vdi] += size;
                cont = --cpu.regv[cpu.reg_vcx] !== 0;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        cpu.safe_write16(dest, data);
        cpu.regv[cpu.reg_vdi] += size;
    }
}

function stosd(cpu)
{
    var data = cpu.reg32s[reg_eax];
    var dest = cpu.get_seg(reg_es) + cpu.regv[cpu.reg_vdi] | 0;
    var size = cpu.flags & flag_direction ? -4 : 4;

    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        var count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(dest & 3))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_dest = cpu.translate_address_write(dest) >>> 2;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count(size, dest);
            }
            do
            {
                cpu.write_aligned32(phys_dest, data);
                phys_dest += single_size;
                cont = --count !== 0;
            }
            while(cont && cycle_counter--);
            var diff = size * (start_count - count) | 0;
            cpu.regv[cpu.reg_vdi] += diff;
            cpu.regv[cpu.reg_vcx] = count;
            cpu.timestamp_counter += start_count - count;
        }
        else
        {
            do
            {
                cpu.safe_write32(dest, data);
                dest += size;
                cpu.regv[cpu.reg_vdi] += size;
                cont = --cpu.regv[cpu.reg_vcx] !== 0;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        cpu.safe_write32(dest, data);
        cpu.regv[cpu.reg_vdi] += size;
    }
}

function lodsb(cpu)
{
    var src = cpu.get_seg_prefix(reg_ds) + cpu.regv[cpu.reg_vsi] | 0;
    var size = cpu.flags & flag_direction ? -1 : 1;

    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        var count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        var phys_src = cpu.translate_address_read(src);
        if(cpu.paging)
        {
            cycle_counter = string_get_cycle_count(size, src);
        }
        do
        {
            cpu.reg8[reg_al] = cpu.read8(phys_src);
            phys_src += size;
            cont = --count !== 0;
        }
        while(cont && cycle_counter--);
        var diff = size * (start_count - count) | 0;
        cpu.regv[cpu.reg_vsi] += diff;
        cpu.regv[cpu.reg_vcx] = count;
        cpu.timestamp_counter += start_count - count;
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        cpu.reg8[reg_al] = cpu.safe_read8(src);
        cpu.regv[cpu.reg_vsi] += size;
    }
}

function lodsw(cpu)
{
    var src = cpu.get_seg_prefix(reg_ds) + cpu.regv[cpu.reg_vsi] | 0;
    var size = cpu.flags & flag_direction ? -2 : 2;

    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        var count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(count === 0) return;
        var cont = false;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        do
        {
            cpu.reg16[reg_ax] = cpu.safe_read16(src);
            src += size;
            cpu.regv[cpu.reg_vsi] += size;
            cont = --cpu.regv[cpu.reg_vcx] !== 0;
        }
        while(cont && cycle_counter--);
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        cpu.reg16[reg_ax] = cpu.safe_read16(src);
        cpu.regv[cpu.reg_vsi] += size;
    }
}

function lodsd(cpu)
{
    var src = cpu.get_seg_prefix(reg_ds) + cpu.regv[cpu.reg_vsi] | 0;
    var size = cpu.flags & flag_direction ? -4 : 4;

    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        var count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(count === 0) return;
        var cont = false;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        do
        {
            cpu.reg32s[reg_eax] = cpu.safe_read32s(src);
            src += size;
            cpu.regv[cpu.reg_vsi] += size;
            cont = --cpu.regv[cpu.reg_vcx] !== 0;
        }
        while(cont && cycle_counter--);
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        cpu.reg32s[reg_eax] = cpu.safe_read32s(src);
        cpu.regv[cpu.reg_vsi] += size;
    }
}

function scasb(cpu)
{
    var dest = cpu.get_seg(reg_es) + cpu.regv[cpu.reg_vdi] | 0;
    var size = cpu.flags & flag_direction ? -1 : 1;
    var data_dest;
    var data_src = cpu.reg8[reg_al];

    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        var count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var is_repz = cpu.repeat_string_prefix === REPEAT_STRING_PREFIX_Z;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        var phys_dest = cpu.translate_address_read(dest);
        if(cpu.paging)
        {
            cycle_counter = string_get_cycle_count(size, dest);
        }
        do
        {
            data_dest = cpu.read8(phys_dest);
            phys_dest += size;
            cont = --count !== 0 && (data_src === data_dest) === is_repz;
        }
        while(cont && cycle_counter--);
        var diff = size * (start_count - count) | 0;
        cpu.regv[cpu.reg_vdi] += diff;
        cpu.regv[cpu.reg_vcx] = count;
        cpu.timestamp_counter += start_count - count;
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        data_dest = cpu.safe_read8(dest);
        cpu.regv[cpu.reg_vdi] += size;
    }

    cpu.cmp8(data_src, data_dest);
}

function scasw(cpu)
{
    var dest = cpu.get_seg(reg_es) + cpu.regv[cpu.reg_vdi] | 0;
    var size = cpu.flags & flag_direction ? -2 : 2;
    var data_dest;
    var data_src = cpu.reg16[reg_al];

    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        var count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var is_repz = cpu.repeat_string_prefix === REPEAT_STRING_PREFIX_Z;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(dest & 1))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_dest = cpu.translate_address_read(dest) >> 1;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count(size, dest);
            }
            do
            {
                data_dest = cpu.read_aligned16(phys_dest);
                phys_dest += single_size;
                cont = --count !== 0 && (data_src === data_dest) === is_repz;
            }
            while(cont && cycle_counter--);
            var diff = size * (start_count - count) | 0;
            cpu.regv[cpu.reg_vdi] += diff;
            cpu.regv[cpu.reg_vcx] = count;
            cpu.timestamp_counter += start_count - count;
        }
        else
        {
            do
            {
                data_dest = cpu.safe_read16(dest);
                dest += size;
                cpu.regv[cpu.reg_vdi] += size;
                cont = --cpu.regv[cpu.reg_vcx] !== 0 && (data_src === data_dest) === is_repz;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        data_dest = cpu.safe_read16(dest);
        cpu.regv[cpu.reg_vdi] += size;
    }

    cpu.cmp16(data_src, data_dest);
}

function scasd(cpu)
{
    var dest = cpu.get_seg(reg_es) + cpu.regv[cpu.reg_vdi] | 0;
    var size = cpu.flags & flag_direction ? -4 : 4;
    var data_dest;
    var data_src = cpu.reg32s[reg_eax];

    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        var count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var is_repz = cpu.repeat_string_prefix === REPEAT_STRING_PREFIX_Z;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(dest & 3))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_dest = cpu.translate_address_read(dest) >>> 2;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count(size, dest);
            }
            do
            {
                data_dest = cpu.read_aligned32(phys_dest);
                phys_dest += single_size;
                cont = --count !== 0 && (data_src === data_dest) === is_repz;
            }
            while(cont && cycle_counter--);
            var diff = size * (start_count - count) | 0;
            cpu.regv[cpu.reg_vdi] += diff;
            cpu.regv[cpu.reg_vcx] = count;
            cpu.timestamp_counter += start_count - count;
        }
        else
        {
            do
            {
                data_dest = cpu.safe_read32s(dest);
                dest += size;
                cpu.regv[cpu.reg_vdi] += size;
                cont = --cpu.regv[cpu.reg_vcx] !== 0 && (data_src === data_dest) === is_repz;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            cpu.instruction_pointer = cpu.previous_ip;
        }
    }
    else
    {
        data_dest = cpu.safe_read32s(dest);
        cpu.regv[cpu.reg_vdi] += size;
    }

    cpu.cmp32(data_src, data_dest);
}

function insb(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 1);

    var dest = cpu.get_seg(reg_es) + cpu.regv[cpu.reg_vdi] | 0;
    var size = cpu.flags & flag_direction ? -1 : 1;

    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        var count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        var phys_dest = cpu.translate_address_write(dest);
        if(cpu.paging)
        {
            cycle_counter = string_get_cycle_count(size, dest);
        }
        do
        {
            cpu.write8(phys_dest, cpu.io.port_read8(port));
            phys_dest += size;
            cont = --count !== 0;
        }
        while(cont && cycle_counter--);
        var diff = size * (start_count - count) | 0;
        cpu.regv[cpu.reg_vdi] += diff;
        cpu.regv[cpu.reg_vcx] = count;
        cpu.timestamp_counter += start_count - count;
        if(cont)
        {
            //cpu.instruction_pointer = cpu.previous_ip;
            insb(cpu);
        }
    }
    else
    {
        cpu.safe_write8(dest, cpu.io.port_read8(port));
        cpu.regv[cpu.reg_vdi] += size;
    }
}

function insw(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 2);

    var dest = cpu.get_seg(reg_es) + cpu.regv[cpu.reg_vdi] | 0;
    var size = cpu.flags & flag_direction ? -2 : 2;

    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        var count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(dest & 1))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_dest = cpu.translate_address_write(dest) >> 1;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count(size, dest);
            }
            do
            {
                cpu.write_aligned16(phys_dest, cpu.io.port_read16(port));
                phys_dest += single_size;
                cont = --count !== 0;
            }
            while(cont && cycle_counter--);
            var diff = size * (start_count - count) | 0;
            cpu.regv[cpu.reg_vdi] += diff;
            cpu.regv[cpu.reg_vcx] = count;
            cpu.timestamp_counter += start_count - count;
        }
        else
        {
            do
            {
                cpu.safe_write16(dest, cpu.io.port_read16(port));
                dest += size;
                cpu.regv[cpu.reg_vdi] += size;
                cont = --cpu.regv[cpu.reg_vcx] !== 0;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            //cpu.instruction_pointer = cpu.previous_ip;
            insw(cpu);
        }
    }
    else
    {
        cpu.safe_write16(dest, cpu.io.port_read16(port));
        cpu.regv[cpu.reg_vdi] += size;
    }
}

function insd(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 4);

    var dest = cpu.get_seg(reg_es) + cpu.regv[cpu.reg_vdi] | 0;
    var size = cpu.flags & flag_direction ? -4 : 4;

    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        var count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(dest & 3))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_dest = cpu.translate_address_write(dest) >>> 2;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count(size, dest);
            }
            do
            {
                cpu.write_aligned32(phys_dest, cpu.io.port_read32(port));
                phys_dest += single_size;
                cont = --count !== 0;
            }
            while(cont && cycle_counter--);
            var diff = size * (start_count - count) | 0;
            cpu.regv[cpu.reg_vdi] += diff;
            cpu.regv[cpu.reg_vcx] = count;
            cpu.timestamp_counter += start_count - count;
        }
        else
        {
            do
            {
                cpu.safe_write32(dest, cpu.io.port_read32(port));
                dest += size;
                cpu.regv[cpu.reg_vdi] += size;
                cont = --cpu.regv[cpu.reg_vcx] !== 0;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            //cpu.instruction_pointer = cpu.previous_ip;
            insd(cpu);
        }
    }
    else
    {
        cpu.safe_write32(dest, cpu.io.port_read32(port));
        cpu.regv[cpu.reg_vdi] += size;
    }
}

function outsb(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 1);

    var src = cpu.get_seg_prefix(reg_ds) + cpu.regv[cpu.reg_vsi] | 0;
    var size = cpu.flags & flag_direction ? -1 : 1;

    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        var count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        var phys_src = cpu.translate_address_read(src);
        if(cpu.paging)
        {
            cycle_counter = string_get_cycle_count(size, src);
        }
        do
        {
            cpu.io.port_write8(port, cpu.read8(phys_src));
            phys_src += size;
            cont = --count !== 0;
        }
        while(cont && cycle_counter--);
        var diff = size * (start_count - count) | 0;
        cpu.regv[cpu.reg_vsi] += diff;
        cpu.regv[cpu.reg_vcx] = count;
        cpu.timestamp_counter += start_count - count;
        if(cont)
        {
            //cpu.instruction_pointer = cpu.previous_ip;
            outsb(cpu);
        }
    }
    else
    {
        cpu.io.port_write8(port, cpu.safe_read8(src));
        cpu.regv[cpu.reg_vsi] += size;
    }
}

function outsw(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 2);

    var src = cpu.get_seg_prefix(reg_ds) + cpu.regv[cpu.reg_vsi] | 0;
    var size = cpu.flags & flag_direction ? -2 : 2;

    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        var count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(src & 1))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_src = cpu.translate_address_read(src) >> 1;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count(size, src);
            }
            do
            {
                cpu.io.port_write16(port, cpu.read_aligned16(phys_src));
                phys_src += single_size;
                cont = --count !== 0;
            }
            while(cont && cycle_counter--);
            var diff = size * (start_count - count) | 0;
            cpu.regv[cpu.reg_vsi] += diff;
            cpu.regv[cpu.reg_vcx] = count;
            cpu.timestamp_counter += start_count - count;
        }
        else
        {
            do
            {
                cpu.io.port_write16(port, cpu.safe_read16(src));
                src += size;
                cpu.regv[cpu.reg_vsi] += size;
                cont = --cpu.regv[cpu.reg_vcx] !== 0;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            //cpu.instruction_pointer = cpu.previous_ip;
            outsw(cpu);
        }
    }
    else
    {
        cpu.io.port_write16(port, cpu.safe_read16(src));
        cpu.regv[cpu.reg_vsi] += size;
    }
}

function outsd(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 4);

    var src = cpu.get_seg_prefix(reg_ds) + cpu.regv[cpu.reg_vsi] | 0;
    var size = cpu.flags & flag_direction ? -4 : 4;

    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        var count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(count === 0) return;
        var cont = false;
        var start_count = count;
        var cycle_counter = MAX_COUNT_PER_CYCLE;
        if(!(src & 3))
        {
            var single_size = size < 0 ? -1 : 1;
            var phys_src = cpu.translate_address_read(src) >>> 2;
            if(cpu.paging)
            {
                cycle_counter = string_get_cycle_count(size, src);
            }
            do
            {
                cpu.io.port_write32(port, cpu.read_aligned32(phys_src));
                phys_src += single_size;
                cont = --count !== 0;
            }
            while(cont && cycle_counter--);
            var diff = size * (start_count - count) | 0;
            cpu.regv[cpu.reg_vsi] += diff;
            cpu.regv[cpu.reg_vcx] = count;
            cpu.timestamp_counter += start_count - count;
        }
        else
        {
            do
            {
                cpu.io.port_write32(port, cpu.safe_read32s(src));
                src += size;
                cpu.regv[cpu.reg_vsi] += size;
                cont = --cpu.regv[cpu.reg_vcx] !== 0;
            }
            while(cont && cycle_counter--);
        }
        if(cont)
        {
            //cpu.instruction_pointer = cpu.previous_ip;
            outsd(cpu);
        }
    }
    else
    {
        cpu.io.port_write32(port, cpu.safe_read32s(src));
        cpu.regv[cpu.reg_vsi] += size;
    }
}
