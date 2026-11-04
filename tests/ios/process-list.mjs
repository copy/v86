// Read a stopped 10B329 application core's XNU process list. _proc_pid
// loads p_pid at 8, _proc_name copies p_name at 0x170. Starting at the
// kernel process, follow the BSD LIST_ENTRY predecessor links.
export function process_list(cpu)
{
    const state = new DataView(cpu.wasm_memory.buffer, cpu.state_base);
    const memory = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset, cpu.mem8.length);
    const phys = a => a >= 0x40000000 && a - 0x40000000 <= memory.byteLength - 4 ?
        memory.getUint32(a - 0x40000000, true) : 0;
    function translate(a)
    {
        const ttbr = state.getUint32(a >>> 30 ? 944 : 936, true);
        const section = phys((ttbr & 0xFFFFC000) + (a >>> 20) * 4);
        if((section & 3) === 2) return ((section & 0xFFF00000) | (a & 0xFFFFF)) >>> 0;
        if((section & 3) !== 1) return 0;
        const page = phys((section & 0xFFFFFC00) + (a >>> 12 & 255) * 4);
        return page & 2 ? ((page & 0xFFFFF000) | a & 4095) >>> 0 : 0;
    }
    const word = a => phys(translate(a)), list = [], seen = new Set();
    let p = word(0x8033CBB8); // _kernproc in the 10B329 N90 Mach-O
    while(p >= 0x80000000 && !seen.has(p) && seen.size < 2048)
    {
        seen.add(p);
        let name = "";
        for(let i = 0; i < 32; i++)
        {
            const a = translate(p + 0x170 + i) - 0x40000000;
            if(a < 0 || a >= memory.byteLength) return list;
            const c = memory.getUint8(a);
            if(!c) break;
            if(c < 32 || c > 126) return list;
            name += String.fromCharCode(c);
        }
        if(!name) break;
        list.push({ pid: word(p + 8), name });
        const prev = word(p + 4);
        if(!prev || word(prev) !== p) break;
        p = prev;
    }
    return list;
}
