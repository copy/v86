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

// E0 and its scan code are one physical keyboard event. Delaying between
// those bytes can make the guest lose an extended modifier such as Win.
export function probe_keyboard_events(codes)
{
    const events=[];
    for(let i=0;i<codes.length;i++) {
        const code=codes[i];
        if(code===0xe0) {
            if(i+1===codes.length || codes[i+1]===0xe0)
                throw new Error("Incomplete extended scan code");
            events.push([code,codes[++i]]);
        } else events.push([code]);
    }
    return events;
}

// The local XP image uses the classic theme. Require its visible Run title,
// dialog background and edit field before sending a command. A desktop or a
// late hardware wizard must never receive probe command keystrokes.
export function probe_run_dialog_visible(picture)
{
    if(!picture) return false;
    const title = [
        "..#####.........................",
        "..##..##........................",
        "..##..##..##..##.#####..........",
        "..##..##..##..##.##..##.........",
        "..#####...##..##.##..##.........",
        "..##.##...##..##.##..##.........",
        "..##..##..##..##.##..##.........",
        "..##...##..#####.##..##.........",
    ];
    const {width, height, raw} = picture, stride = width * 3 + 1;
    const white = at => raw[at] > 220 && raw[at+1] > 220 && raw[at+2] > 220;
    const blue = at => raw[at] < 100 && raw[at+1] < 180 && raw[at+2] > raw[at]+40;
    const grey = at => Math.abs(raw[at]-212) < 5 && Math.abs(raw[at+1]-208) < 5 && Math.abs(raw[at+2]-200) < 5;
    for(let y=0;y+160<height;y++) for(let x=0;x+330<width;x++) {
        const at=y*stride+1+x*3;
        if(!white(at+6) || !blue(at) || !grey(at+25*stride+12*3)
                || !white(at+85*stride+250*3)) continue;
        let matched=true;
        for(let j=0;j<title.length && matched;j++) for(let i=0;i<title[j].length;i++) {
            const pixel=at+j*stride+i*3;
            if(!(title[j][i]==="#" ? white(pixel) : blue(pixel))) {matched=false;break;}
        }
        if(matched) return true;
    }
    return false;
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
