// An actual GPU may vary at a few raster/transparent edges even when the
// same executable replays the same recording. Preserve all stable reference
// pixels exactly and permit only RGBA values observed at that exact position.
export function compare_pixels(reference, candidates, width, height)
{
    const size = width * height * 4;
    if(!reference.length || !candidates.length || !Number.isSafeInteger(size) || size <= 0 || [...reference, ...candidates].some(a => !(a instanceof Uint8Array) || a.byteLength !== size)) throw new Error("invalid pixel comparison inputs");
    const views = arrays => arrays.map(a => new DataView(a.buffer, a.byteOffset, a.byteLength)), base = views(reference), current = views(candidates), unstable = [], allowed = new Map();
    for(let at = 0; at < size; at += 4)
    {
        const values = [...new Set(base.map(v => v.getUint32(at, true)))];
        if(values.length > 1)
        {
            allowed.set(at, values);
            unstable.push({ x: at / 4 % width, y: Math.floor(at / 4 / width), rgba: values.map(v => [v & 255, v >>> 8 & 255, v >>> 16 & 255, v >>> 24]) });
        }
    }
    let stable_mismatches = 0, outside_observed_values = 0;
    for(const view of current) for(let at = 0; at < size; at += 4)
    {
        const value = view.getUint32(at, true);if(value === base[0].getUint32(at, true)) continue;
        const values = allowed.get(at);
        if(!values) ++stable_mismatches;else if(!values.includes(value)) ++outside_observed_values;
    }
    return { mode: "observed reference values at reference-variable pixels; all other pixels exact", width, height, referenceRuns: reference.length,
        candidateRuns: candidates.length, unstableReferencePixels: unstable, stableMismatches: stable_mismatches, outsideObservedValues: outside_observed_values, passed: stable_mismatches === 0 && outside_observed_values === 0 };
}
