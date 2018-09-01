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
            "CACHE_MISMATCH",
            "RUN_INTERPRETED",
            "RUN_INTERPRETED_PENDING",
            "RUN_INTERPRETED_NEAR_END_OF_PAGE",
            "RUN_INTERPRETED_DIFFERENT_STATE",
            "RUN_INTERPRETED_MISSED_COMPILED_ENTRY",
            "RUN_INTERPRETED_STEPS",
            "RUN_FROM_CACHE",
            "RUN_FROM_CACHE_STEPS",
            "TRIGGER_CPU_EXCEPTION",
            "SAFE_READ32_FAST",
            "SAFE_READ32_SLOW_PAGE_CROSSED",
            "SAFE_READ32_SLOW_NOT_VALID",
            "SAFE_READ32_SLOW_NOT_USER",
            "SAFE_READ32_SLOW_IN_MAPPED_RANGE",
            "SAFE_WRITE32_FAST",
            "SAFE_WRITE32_SLOW_PAGE_CROSSED",
            "SAFE_WRITE32_SLOW_NOT_VALID",
            "SAFE_WRITE32_SLOW_NOT_USER",
            "SAFE_WRITE32_SLOW_IN_MAPPED_RANGE",
            "SAFE_WRITE32_SLOW_READ_ONLY",
            "SAFE_WRITE32_SLOW_HAS_CODE",
            "DO_RUN",
            "DO_MANY_CYCLES",
            "CYCLE_INTERNAL",
            "INVALIDATE_PAGE",
            "INVALIDATE_CACHE_ENTRY",
            "NONFAULTING_OPTIMIZATION",
            "CLEAR_TLB",
            "FULL_CLEAR_TLB",
            "TLB_FULL",
            "TLB_GLOBAL_FULL",
        ];

        for(let i = 0; i < stat_names.length; i++)
        {
            let stat = cpu.v86oxide.exports["profiler_stat_get"](i);
            stat = stat >= 100e6 ? Math.round(stat / 1e6) + "m" : stat >= 100e3 ? Math.round(stat / 1e3) + "k" : stat;
            text += stat_names[i] + "=" + stat + " ";

            if(((i + 1) % Math.floor(stat_names.length / 3) === 0))
            {
                text += "\n";
            }
        }

        text += "\n";

        const tlb_entries = cpu.v86oxide.exports["get_valid_tlb_entries_count"]();
        const global_tlb_entries = cpu.v86oxide.exports["get_valid_global_tlb_entries_count"]();
        const nonglobal_tlb_entries = tlb_entries - global_tlb_entries;

        text += "TLB_ENTRIES=" + tlb_entries + " (" + global_tlb_entries + " global, " + nonglobal_tlb_entries + " non-global)\n";
        text += "CACHE_UNUSED=" + cpu.v86oxide.exports["jit_unused_cache_stat"]() + "\n";
        text += "WASM_TABLE_FREE=" + cpu.v86oxide.exports["jit_get_wasm_table_index_free_list_count"]() + "\n";

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
            const address = cpu.v86oxide.exports["jit_get_entry_address"](i);

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
            const length = cpu.v86oxide.exports["jit_get_entry_length"](i);
            pending_count += cpu.v86oxide.exports["jit_get_entry_pending"](i);
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
        let text = "";

        const counts = [];

        for(let i = 0; i < 0x100; i++)
        {
            const count = cpu.v86oxide.exports["get_opstats_buffer"](i) / 1000 | 0;
            counts.push([i, count]);

            const count_0f = cpu.v86oxide.exports["get_opstats_buffer"](i + 0x100) / 1000 | 0;
            counts.push([0x0f00 | i, count_0f]);
        }

        const max_count = Math.max.apply(Math,
            counts.map(([_, count]) => count)
        );
        const pad_length = String(max_count).length;

        text += "Instruction counts (in 1000):\n";
        let total = 0;
        const prefixes = new Set([
            0x26, 0x2E, 0x36, 0x3E,
            0x64, 0x65, 0x66, 0x67,
            0xF0, 0xF2, 0xF3,
        ]);
        for(let [i, count] of counts)
        {
            total += i < 0x100 && !prefixes.has(i) ? count : 0;
        }
        text += "Total: " + total + "\n";

        if(total === 0)
        {
            return "";
        }

        for(let [i, count] of counts)
        {
            if((i & 0xFF00) === 0)
            {
                text += h(i, 2).slice(2) + ":" + v86util.pads(count, pad_length);

                if(i % 16 == 15)
                    text += "\n";
                else
                    text += " ";
            }
        }

        text += "\n";
        text += "Instruction counts (0f, in 1000):\n";

        for(let [i, count] of counts)
        {
            if((i & 0xFF00) === 0x0F00)
            {
                text += h(i & 0xFF, 2).slice(2) + ":" + v86util.pads(count, pad_length);

                if(i % 16 == 15)
                    text += "\n";
                else
                    text += " ";
            }
        }
        text += "\n";

        const top_counts = counts.sort(([o1, c1], [o2, c2]) => c2 - c1);

        for(let [opcode, count] of top_counts.slice(0, 100))
        {
            text += opcode.toString(16) + ":" + (count / total * 100).toFixed(1) + " ";
        }
        text += "\n";

        return text;
    },
};
