"use strict";

const print_stats = {
    stats_to_string: function(cpu)
    {
        return this.print_misc_stats(cpu) +
            this.print_wasm_basic_block_count_histogram(cpu) +
            this.print_instruction_counts(cpu);
    },

    print_misc_stats: function(cpu)
    {
        let text = "";

        const names = [
            "IDLE",
            "DO_MANY_CYCLES",
            "GEN_INSTR",
            "RUN_FROM_CACHE",
            "RUN_INTERPRETED",
        ];
        const stat_names = [
            "COMPILE",
            "COMPILE_SUCCESS",
            "RUN_INTERPRETED",
            "RUN_FROM_CACHE",
            "CACHE_MISMATCH",
            "CACHE_DROP",
            "CACHE_SKIPPED",
            "COMPILE_WITH_LINK",
            "NONFAULTING_OPTIMIZATION",
            "CLEAR_TLB",
            "FULL_CLEAR_TLB",
            "TLB_FULL",
            "TLB_GLOBAL_FULL",
        ];

        const total = cpu.wm.exports["_profiler_get_total"]();

        for(let i = 0; i < names.length; i++)
        {
            let stat = cpu.wm.exports["_profiler_get_time"](i) / total;
            text += names[i] + "=" + stat.toFixed(2) + " ";
        }

        text += "\n";

        for(let i = 0; i < stat_names.length; i++)
        {
            let stat = cpu.wm.exports["_profiler_stat_get"](i);
            stat = stat >= 100e6 ? Math.round(stat / 1e6) + "m" : stat >= 100e3 ? Math.round(stat / 1e3) + "k" : stat;
            text += stat_names[i] + "=" + stat + " ";
        }

        text += "\n";
        text += "CACHE_INVALID=" + cpu.wm.exports["_jit_invalid_cache_stat"]();
        text += " CACHE_UNUSED=" + cpu.wm.exports["_jit_unused_cache_stat"]();
        text += "\n";

        return text;
    },

    print_wasm_basic_block_count_histogram: function(cpu)
    {
        let text = "";
        const histogram = Object.create(null);

        for(let i = 0; i < 0x10000; i++)
        {
            const length = cpu.wm.exports["_jit_get_entry_length"](i);
            histogram[length] = (histogram[length] || 0) + 1;
        }

        let above = 0;

        for(let i in histogram)
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

        return text;
    },

    print_instruction_counts: function(cpu)
    {
        let text = "";

        const counts = [];

        for(let i = 0; i < 0x100; i++)
        {
            const count = cpu.wm.exports["_get_opstats_buffer"](i) / 1000 | 0;
            counts.push([i, count]);

            const count_0f = cpu.wm.exports["_get_opstats_buffer"](i + 0x100) / 1000 | 0;
            counts.push([0x0f00 | i, count_0f]);
        }

        const max_count = Math.max.apply(Math,
            counts.map(([_, count]) => count)
        );
        const pad_length = String(max_count).length;

        text += "Instruction counts (in 1000):\n";

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
            text += opcode.toString(16) + ":" + count + " ";
        }
        text += "\n";

        return text;
    },
};
