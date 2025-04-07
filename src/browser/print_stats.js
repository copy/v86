import { pads } from "../lib.js";

export function stats_to_string(cpu)
{
    return print_misc_stats(cpu) + print_instruction_counts(cpu);
}

function print_misc_stats(cpu)
{
    let text = "";

    const stat_names = [
        "COMPILE",
        "COMPILE_SKIPPED_NO_NEW_ENTRY_POINTS",
        "COMPILE_WRONG_ADDRESS_SPACE",
        "COMPILE_CUT_OFF_AT_END_OF_PAGE",
        "COMPILE_WITH_LOOP_SAFETY",
        "COMPILE_PAGE",
        "COMPILE_PAGE/COMPILE",
        "COMPILE_BASIC_BLOCK",
        "COMPILE_DUPLICATED_BASIC_BLOCK",
        "COMPILE_WASM_BLOCK",
        "COMPILE_WASM_LOOP",
        "COMPILE_DISPATCHER",
        "COMPILE_ENTRY_POINT",
        "COMPILE_WASM_TOTAL_BYTES",
        "COMPILE_WASM_TOTAL_BYTES/COMPILE_PAGE",
        "RUN_INTERPRETED",
        "RUN_INTERPRETED_NEW_PAGE",
        "RUN_INTERPRETED_PAGE_HAS_CODE",
        "RUN_INTERPRETED_PAGE_HAS_ENTRY_AFTER_PAGE_WALK",
        "RUN_INTERPRETED_NEAR_END_OF_PAGE",
        "RUN_INTERPRETED_DIFFERENT_STATE",
        "RUN_INTERPRETED_DIFFERENT_STATE_CPL3",
        "RUN_INTERPRETED_DIFFERENT_STATE_FLAT",
        "RUN_INTERPRETED_DIFFERENT_STATE_IS32",
        "RUN_INTERPRETED_DIFFERENT_STATE_SS32",
        "RUN_INTERPRETED_MISSED_COMPILED_ENTRY_RUN_INTERPRETED",
        "RUN_INTERPRETED_STEPS",
        "RUN_FROM_CACHE",
        "RUN_FROM_CACHE_STEPS",
        "RUN_FROM_CACHE_STEPS/RUN_FROM_CACHE",
        "RUN_FROM_CACHE_STEPS/RUN_INTERPRETED_STEPS",
        "DIRECT_EXIT",
        "INDIRECT_JUMP",
        "INDIRECT_JUMP_NO_ENTRY",
        "NORMAL_PAGE_CHANGE",
        "NORMAL_FALLTHRU",
        "NORMAL_FALLTHRU_WITH_TARGET_BLOCK",
        "NORMAL_BRANCH",
        "NORMAL_BRANCH_WITH_TARGET_BLOCK",
        "CONDITIONAL_JUMP",
        "CONDITIONAL_JUMP_PAGE_CHANGE",
        "CONDITIONAL_JUMP_EXIT",
        "CONDITIONAL_JUMP_FALLTHRU",
        "CONDITIONAL_JUMP_FALLTHRU_WITH_TARGET_BLOCK",
        "CONDITIONAL_JUMP_BRANCH",
        "CONDITIONAL_JUMP_BRANCH_WITH_TARGET_BLOCK",
        "DISPATCHER_SMALL",
        "DISPATCHER_LARGE",
        "LOOP",
        "LOOP_SAFETY",
        "CONDITION_OPTIMISED",
        "CONDITION_UNOPTIMISED",
        "CONDITION_UNOPTIMISED_PF",
        "CONDITION_UNOPTIMISED_UNHANDLED_L",
        "CONDITION_UNOPTIMISED_UNHANDLED_LE",
        "FAILED_PAGE_CHANGE",
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
        "TLB_MISS",
        "MAIN_LOOP",
        "MAIN_LOOP_IDLE",
        "DO_MANY_CYCLES",
        "CYCLE_INTERNAL",
        "INVALIDATE_ALL_MODULES_NO_FREE_WASM_INDICES",
        "INVALIDATE_MODULE_WRITTEN_WHILE_COMPILED",
        "INVALIDATE_MODULE_UNUSED_AFTER_OVERWRITE",
        "INVALIDATE_MODULE_DIRTY_PAGE",
        "INVALIDATE_PAGE_HAD_CODE",
        "INVALIDATE_PAGE_HAD_ENTRY_POINTS",
        "DIRTY_PAGE_DID_NOT_HAVE_CODE",
        "RUN_FROM_CACHE_EXIT_SAME_PAGE",
        "RUN_FROM_CACHE_EXIT_NEAR_END_OF_PAGE",
        "RUN_FROM_CACHE_EXIT_DIFFERENT_PAGE",
        "CLEAR_TLB",
        "FULL_CLEAR_TLB",
        "TLB_FULL",
        "TLB_GLOBAL_FULL",
        "MODRM_SIMPLE_REG",
        "MODRM_SIMPLE_REG_WITH_OFFSET",
        "MODRM_SIMPLE_CONST_OFFSET",
        "MODRM_COMPLEX",
        "SEG_OFFSET_OPTIMISED",
        "SEG_OFFSET_NOT_OPTIMISED",
        "SEG_OFFSET_NOT_OPTIMISED_ES",
        "SEG_OFFSET_NOT_OPTIMISED_FS",
        "SEG_OFFSET_NOT_OPTIMISED_GS",
        "SEG_OFFSET_NOT_OPTIMISED_NOT_FLAT",
    ];

    let j = 0;
    const stat_values = {};
    for(let i = 0; i < stat_names.length; i++)
    {
        const name = stat_names[i];
        let value;
        if(name.includes("/"))
        {
            j++; // skip profiler_stat_get
            const [left, right] = name.split("/");
            value = stat_values[left] / stat_values[right];
        }
        else
        {
            const stat = stat_values[name] = cpu.wm.exports["profiler_stat_get"](i - j);
            value = stat >= 100e6 ? Math.round(stat / 1e6) + "m" : stat >= 100e3 ? Math.round(stat / 1e3) + "k" : stat;
        }
        text += name + "=" + value + "\n";
    }

    text += "\n";

    const tlb_entries = cpu.wm.exports["get_valid_tlb_entries_count"]();
    const global_tlb_entries = cpu.wm.exports["get_valid_global_tlb_entries_count"]();
    const nonglobal_tlb_entries = tlb_entries - global_tlb_entries;

    text += "TLB_ENTRIES=" + tlb_entries + " (" + global_tlb_entries + " global, " + nonglobal_tlb_entries + " non-global)\n";
    text += "WASM_TABLE_FREE=" + cpu.wm.exports["jit_get_wasm_table_index_free_list_count"]() + "\n";
    text += "JIT_CACHE_SIZE=" + cpu.wm.exports["jit_get_cache_size"]() + "\n";
    text += "FLAT_SEGMENTS=" + cpu.wm.exports["has_flat_segmentation"]() + "\n";

    text += "wasm memory size: " + (cpu.wasm_memory.buffer.byteLength >> 20) + "m\n";

    text += "Config:\n";
    text += "JIT_DISABLED=" + cpu.wm.exports["get_jit_config"](0) + "\n";
    text += "MAX_PAGES=" + cpu.wm.exports["get_jit_config"](1) + "\n";
    text += "JIT_USE_LOOP_SAFETY=" + Boolean(cpu.wm.exports["get_jit_config"](2)) + "\n";
    text += "MAX_EXTRA_BASIC_BLOCKS=" + cpu.wm.exports["get_jit_config"](3) + "\n";

    return text;
}

function print_instruction_counts(cpu)
{
    return [
        print_instruction_counts_offset(cpu, false, false, false, false),
        print_instruction_counts_offset(cpu, true, false, false, false),
        print_instruction_counts_offset(cpu, false, true, false, false),
        print_instruction_counts_offset(cpu, false, false, true, false),
        print_instruction_counts_offset(cpu, false, false, false, true),
    ].join("\n\n");
}

function print_instruction_counts_offset(cpu, compiled, jit_exit, unguarded_register, wasm_size)
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
            for(const is_mem of [false, true])
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
    for(const { count, opcode } of counts)
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

    for(const { opcode, count } of counts)
    {
        if((opcode & 0xFF00) === 0x0F00)
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
        text += i.toString(16).padStart(2, "0") + ":" + pads(Math.round(per_opcode[i] / factor), pad_length);

        if(i % 16 === 15)
            text += "\n";
        else
            text += " ";
    }

    text += "\n";
    text += `Instruction counts ${label} (0f, in ${factor}):\n`;

    for(let i = 0; i < 0x100; i++)
    {
        text += (i & 0xFF).toString(16).padStart(2, "0") + ":" + pads(Math.round(per_opcode0f[i] / factor), pad_length);

        if(i % 16 === 15)
            text += "\n";
        else
            text += " ";
    }
    text += "\n";

    const top_counts = counts.filter(({ count }) => count).sort(({ count: count1 }, { count: count2 }) => count2 - count1);

    for(const { opcode, is_mem, fixed_g, count } of top_counts.slice(0, 200))
    {
        const opcode_description = opcode.toString(16) + "_" + fixed_g + (is_mem ? "_m" : "_r");
        text += opcode_description + ":" + (count / total * 100).toFixed(2) + " ";
    }
    text += "\n";

    return text;
}
