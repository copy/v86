// Compiled-code arms for tests that compare generated code with the
// interpreter. 32-bit protected-mode code runs in the x64 page tier by
// default since M8 (x64_page_legacy32, docs/jit-unification-plan.md P7.3),
// 16-bit code since M10; the region tiers, a second arm until then, were
// deleted in M11. Tests run their compiled side once per arm (tests check the
// page tier's step counts on the first compiled machine, x64_page_steps).
export const COMPILED_ARMS = [
    { label: "pages", options: { ir_sync_publication: true } },
];

// A hot run of VEX forms waits until no VEX instruction was interpreted
// (ir_interpreted_stat field 6) through a whole round of its program (they
// run in page functions). The run calls it once a round has ended (the
// program sets the word at `marker`); it clears the word until two calls in a
// row found the count unchanged, which spans a round from its start to its
// end.
export function vex_settled(marker)
{
    let last = -1, quiet = 0;
    return vm => {
        const count = vm.v86.cpu.wm.exports["ir_interpreted_stat"](6, 0);
        quiet = count === last ? quiet + 1 : 0;
        last = count;
        if(quiet >= 2) return true;
        vm.write_memory(new Uint8Array(4), marker);
        return false;
    };
}

// Activations of compiled code: the page tier's (x64_page_stat 13)
export function compiled_activations(exports)
{
    return exports["x64_page_stat"](13) >>> 0;
}
