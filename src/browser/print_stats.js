"use strict";

const print_stats = {
    stats_to_string: function(cpu)
    {
        return print_stats.print_misc_stats(cpu) +
            print_stats.print_basic_block_duplication(cpu) +
            print_stats.print_wasm_basic_block_count_histogram(cpu) +
            print_stats.print_instruction_counts(cpu);
    },

    print_misc_stats: function(cpu)
    {
        let text = "";

        const stat_names = [
            "COMPILE",
            "COMPILE_SUCCESS",
            "COMPILE_CUT_OFF_AT_END_OF_PAGE",
            "COMPILE_WITH_LOOP_SAFETY",
            "COMPILE_BASIC_BLOCK",
            "COMPILE_ENTRY_POINT",
            "COMPILE_DUPLICATE_ENTRY",
            "COMPILE_WASM_TOTAL_BYTES",
            "CACHE_MISMATCH",
            "RUN_INTERPRETED",
            "RUN_INTERPRETED_PENDING",
            "RUN_INTERPRETED_NEAR_END_OF_PAGE",
            "RUN_INTERPRETED_DIFFERENT_STATE",
            "RUN_INTERPRETED_MISSED_COMPILED_ENTRY_RUN_INTERPRETED",
            "RUN_INTERPRETED_MISSED_COMPILED_ENTRY_LOOKUP",
            "RUN_INTERPRETED_STEPS",
            "RUN_FROM_CACHE",
            "RUN_FROM_CACHE_STEPS",
            "SAFE_READ_FAST",
            "SAFE_READ_SLOW_PAGE_CROSSED",
            "SAFE_READ_SLOW_NOT_VALID",
            "SAFE_READ_SLOW_NOT_USER",
            "SAFE_READ_SLOW_IN_MAPPED_RANGE",
            "SAFE_WRITE_FAST",
            "SAFE_WRITE_SLOW_PAGE_CROSSED",
            "SAFE_WRITE_SLOW_NOT_VALID",
            "SAFE_WRITE_SLOW_NOT_USER",
            "SAFE_WRITE_SLOW_IN_MAPPED_RANGE",
            "SAFE_WRITE_SLOW_READ_ONLY",
            "SAFE_WRITE_SLOW_HAS_CODE",
            "SAFE_READ_WRITE_FAST",
            "SAFE_READ_WRITE_SLOW_PAGE_CROSSED",
            "SAFE_READ_WRITE_SLOW_NOT_VALID",
            "SAFE_READ_WRITE_SLOW_NOT_USER",
            "SAFE_READ_WRITE_SLOW_IN_MAPPED_RANGE",
            "SAFE_READ_WRITE_SLOW_READ_ONLY",
            "SAFE_READ_WRITE_SLOW_HAS_CODE",
            "PAGE_FAULT",
            "DO_RUN",
            "DO_MANY_CYCLES",
            "CYCLE_INTERNAL",
            "INVALIDATE_ALL_MODULES_NO_FREE_WASM_INDICES",
            "INVALIDATE_PAGE",
            "INVALIDATE_MODULE",
            "INVALIDATE_CACHE_ENTRY",
            "INVALIDATE_MODULE_CACHE_FULL",
            "INVALIDATE_SINGLE_ENTRY_CACHE_FULL",
            "RUN_FROM_CACHE_EXIT_SAME_PAGE",
            "RUN_FROM_CACHE_EXIT_DIFFERENT_PAGE",
            "CLEAR_TLB",
            "FULL_CLEAR_TLB",
            "TLB_FULL",
            "TLB_GLOBAL_FULL",
            "MODRM_SIMPLE_REG",
            "MODRM_SIMPLE_REG_WITH_OFFSET",
            "MODRM_COMPLEX",
        ];

        for(let i = 0; i < stat_names.length; i++)
        {
            let stat = cpu.wm.exports["profiler_stat_get"](i);
            stat = stat >= 100e6 ? Math.round(stat / 1e6) + "m" : stat >= 100e3 ? Math.round(stat / 1e3) + "k" : stat;
            text += stat_names[i] + "=" + stat + "\n";
        }

        text += "\n";

        const tlb_entries = cpu.wm.exports["get_valid_tlb_entries_count"]();
        const global_tlb_entries = cpu.wm.exports["get_valid_global_tlb_entries_count"]();
        const nonglobal_tlb_entries = tlb_entries - global_tlb_entries;

        text += "TLB_ENTRIES=" + tlb_entries + " (" + global_tlb_entries + " global, " + nonglobal_tlb_entries + " non-global)\n";
        text += "CACHE_UNUSED=" + cpu.wm.exports["jit_unused_cache_stat"]() + "\n";
        text += "WASM_TABLE_FREE=" + cpu.wm.exports["jit_get_wasm_table_index_free_list_count"]() + "\n";
        text += "FLAT_SEGMENTS=" + cpu.wm.exports["has_flat_segmentation"]() + "\n";

        text += "do_many_cycles avg: " + do_many_cycles_total / do_many_cycles_count + "\n";

        return text;
    },

    print_basic_block_duplication: function(cpu)
    {
        let unique = 0;
        let total = 0;
        let duplicates = 0;
        const histogram = [];
        const addresses = {};

        for(let i = 0; i < JIT_CACHE_ARRAY_SIZE; i++)
        {
            const address = cpu.wm.exports["jit_get_entry_address"](i);

            if(address !== 0)
            {
                addresses[address] = (addresses[address] || 0) + 1;
            }
        }

        for(let [address, count] of Object.entries(addresses))
        {
            dbg_assert(count >= 1);
            unique++;
            total += count;
            duplicates += count - 1;

            //for(let i = histogram.length; i < count + 1; i++) histogram.push(0);
            //histogram[count]++;
        }

        let text = "";
        text += "UNIQUE=" + unique + " DUPLICATES=" + duplicates + " TOTAL=" + total + "\n";

        return text;
    },

    print_wasm_basic_block_count_histogram: function(cpu)
    {
        let text = "";
        let pending_count = 0;
        const histogram = Object.create(null);

        for(let i = 0; i < JIT_CACHE_ARRAY_SIZE; i++)
        {
            const length = cpu.wm.exports["jit_get_entry_length"](i);
            pending_count += cpu.wm.exports["jit_get_entry_pending"](i);
            histogram[length] = (histogram[length] || 0) + 1;
        }

        let above = 0;

        for(let i of Object.keys(histogram))
        {
            i = +i;
            if(i >= 32)
            {
                above += histogram[i];
            }
        }

        for(let i = 0; i < 32; i++)
        {
            text += i + ":" + (histogram[i] || 0) + " ";
        }

        text += "32+:" + above + "\n";

        text += "Pending: " + pending_count + "\n";

        return text;
    },

    print_instruction_counts: function(cpu)
    {
        return [
            print_stats.print_instruction_counts_offset(cpu, false, false, false, false),
            print_stats.print_instruction_counts_offset(cpu, true, false, false, false),
            print_stats.print_instruction_counts_offset(cpu, false, true, false, false),
            print_stats.print_instruction_counts_offset(cpu, false, false, true, false),
            print_stats.print_instruction_counts_offset(cpu, false, false, false, true),
        ].join("\n\n");
    },

    print_instruction_counts_offset: function(cpu, compiled, jit_exit, unguarded_register, wasm_size)
    {
        let text = "";

        const counts = [];

        const label =
            compiled ? "compiled" :
            jit_exit ? "jit exit" :
            unguarded_register ? "unguarded register" :
            wasm_size ? "wasm size" :
            "executed";

        for(let opcode = 0; opcode < 0x100; opcode++)
        {
            for(let fixed_g = 0; fixed_g < 8; fixed_g++)
            {
                for(let is_mem of [false, true])
                {
                    const count = cpu.wm.exports["get_opstats_buffer"](compiled, jit_exit, unguarded_register, wasm_size, opcode, false, is_mem, fixed_g);
                    counts.push({ opcode, count, is_mem, fixed_g });

                    const count_0f = cpu.wm.exports["get_opstats_buffer"](compiled, jit_exit, unguarded_register, wasm_size, opcode, true, is_mem, fixed_g);
                    counts.push({ opcode: 0x0f00 | opcode, count: count_0f, is_mem, fixed_g });
                }
            }
        }

        let total = 0;
        const prefixes = new Set([
            0x26, 0x2E, 0x36, 0x3E,
            0x64, 0x65, 0x66, 0x67,
            0xF0, 0xF2, 0xF3,
        ]);
        for(let { count, opcode } of counts)
        {
            if(!prefixes.has(opcode))
            {
                total += count;
            }
        }

        if(total === 0)
        {
            return "";
        }

        const per_opcode = new Uint32Array(0x100);
        const per_opcode0f = new Uint32Array(0x100);

        for(let { opcode, count } of counts)
        {
            if((opcode & 0xFF00) == 0x0F00)
            {
                per_opcode0f[opcode & 0xFF] += count;
            }
            else
            {
                per_opcode[opcode & 0xFF] += count;
            }
        }

        text += "------------------\n";
        text += "Total: " + total + "\n";

        const factor = total > 1e7 ? 1000 : 1;

        const max_count = Math.max.apply(Math,
            counts.map(({ count }) => Math.round(count / factor))
        );
        const pad_length = String(max_count).length;

        text += `Instruction counts ${label} (in ${factor}):\n`;

        for(let i = 0; i < 0x100; i++)
        {
            text += h(i, 2).slice(2) + ":" + v86util.pads(Math.round(per_opcode[i] / factor), pad_length);

            if(i % 16 == 15)
                text += "\n";
            else
                text += " ";
        }

        text += "\n";
        text += `Instruction counts ${label} (0f, in ${factor}):\n`;

        for(let i = 0; i < 0x100; i++)
        {
            text += h(i & 0xFF, 2).slice(2) + ":" + v86util.pads(Math.round(per_opcode0f[i] / factor), pad_length);

            if(i % 16 == 15)
                text += "\n";
            else
                text += " ";
        }
        text += "\n";

        const top_counts = counts.filter(({ count }) => count).sort(({ count: count1 }, { count: count2 }) => count2 - count1);

        for(let { opcode, is_mem, fixed_g, count } of top_counts.slice(0, 200))
        {
            let opcode_description = opcode.toString(16) + "_" + fixed_g + (is_mem ? "_m" : "_r");
            text += opcode_description + ":" + (count / total * 100).toFixed(2) + " ";
        }
        text += "\n";

        return text;
    },
};

if(typeof module !== "undefined" && typeof module.exports !== "undefined")
{
    module.exports["print_stats"] = print_stats;
}
