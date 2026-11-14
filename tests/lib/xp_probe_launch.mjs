// Launch detection is separate from test results. A service can still be
// starting before FAT has flushed the first redirected log's directory entry.
export function probe_run_scancodes(text)
{
    const keys = new Map();
    for (const [row, start] of [["1234567890-=", 2], ["qwertyuiop[]", 16],
        ["asdfghjkl;'", 30], ["`", 41], ["\\", 43], ["zxcvbnm,./", 44], [" ", 57]])
        Array.from(row).forEach((character, index) => keys.set(character, start + index));
    const shifted = "!@#$%^&*()_+{}:\"~|<>?", plain = "1234567890-=[];'`\\,./", result = [];
    for (const character of text)
    {
        const index = shifted.indexOf(character), base = index < 0 ? character.toLowerCase() : plain[index];
        const key = keys.get(base), shift = index >= 0 || character !== base;
        if (key === undefined) throw new Error("Probe Run command requires US keyboard ASCII: " + character);
        if (shift) result.push(42);
        result.push(key, key | 128);
        if (shift) result.push(170);
    }
    return result;
}

export function probe_screen_changed(before, after)
{
    if (!after) return false;
    if (!before || before.width !== after.width || before.height !== after.height) return true;
    const step = Math.max(1, Math.floor(Math.min(before.width, before.height) / 64));
    const stride = before.width * 3 + 1;
    let samples = 0, changed = 0;
    // Exclude the taskbar/clock, whose small updates are not a launched probe.
    for (let y = Math.floor(before.height * .1); y < before.height * .85; y += step)
        for (let x = Math.floor(before.width * .1); x < before.width * .9; x += step)
        {
            const at = y * stride + 1 + x * 3;
            ++samples;
            if (before.raw[at] !== after.raw[at] || before.raw[at + 1] !== after.raw[at + 1]
                    || before.raw[at + 2] !== after.raw[at + 2]) ++changed;
        }
    return changed > Math.max(16, samples * .02);
}

export function probe_launch_activity({ launchBatches, batches, launchWrites, writes,
    result, logs, before, after })
{
    return { batchTraffic: batches > launchBatches, toolsDiskWrite: writes > launchWrites,
        flushedLog: !!result || Object.values(logs).some(Boolean),
        visibleWindow: probe_screen_changed(before, after) };
}
