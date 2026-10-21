export function stats_to_string(cpu)
{
    return print_misc_stats(cpu);
}

function print_misc_stats(cpu)
{
    let text = "";

    // Keep in sync with the stat enum in src/rust/profiler.rs.
    const stat_names = [
        "RUN_INTERPRETED",
        "RUN_INTERPRETED_STEPS",
        "RUN_INTERPRETED_STEPS/RUN_INTERPRETED",
        "DIRTY_PAGE_DID_NOT_HAVE_CODE",
        "PAGE_FAULT",
        "TLB_MISS",
        "MAIN_LOOP",
        "MAIN_LOOP_IDLE",
        "DO_MANY_CYCLES",
        "CYCLE_INTERNAL",
        "CLEAR_TLB",
        "FULL_CLEAR_TLB",
        "TLB_FULL",
        "TLB_GLOBAL_FULL",
        "X87_EXACT",
        "X87_SOFTFLOAT",
        "X87_NATIVE_F64",
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
    text += "FLAT_SEGMENTS=" + cpu.wm.exports["has_flat_segmentation"]() + "\n";

    text += "wasm memory size: " + (cpu.wasm_memory.buffer.byteLength >> 20) + "m\n";

    return text;
}
