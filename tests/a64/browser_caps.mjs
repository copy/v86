// The probes of tests/a64/browser_caps.html (docs/arm64-virt-android16-plan.md
// P0.8): every result comes from compiling or running a module here, not from
// the user agent string. Run under Node it checks Node's V8:
//
//   node tests/a64/browser_caps.mjs

const leb = n => {
    const out = [];
    do { out.push(n > 127 ? n & 127 | 128 : n); n >>>= 7; } while(n);
    return out;
};
const simd = op => [0xFD, ...leb(op)];

// A module of one function `f` of type `type` (bytes of a functype) with body
// `body` (locals and code), plus an optional memory section
function module(type, body, memory = [])
{
    const code = [...leb(body.length), ...body];
    return new Uint8Array([0, 0x61, 0x73, 0x6D, 1, 0, 0, 0,
        1, ...leb(type.length + 1), 1, ...type,
        3, 2, 1, 0,
        ...(memory.length ? [5, ...leb(memory.length), ...memory] : []),
        7, 5, 1, 1, 0x66, 0, 0,
        10, ...leb(code.length + 1), 1, ...code]);
}
const validate = bytes => { try { return WebAssembly.validate(bytes); } catch{ return false; } };
const RESULT_I32 = [0x60, 0, 1, 0x7F];

// (cpu.js relaxed_fma_fused: (1 + ulp)^2 plus an addend that cancels all but
// the product's last bit, which only a fused multiply-add keeps)
function relaxed_madd()
{
    const lanes = (double, ...words) => [...simd(0x0C), ...(double ? [...words, ...words] : [words[0], words[0], words[0], words[0]])
        .flatMap(w => [w & 255, w >>> 8 & 255, w >>> 16 & 255, w >>> 24 & 255])];
    const check = (op, double, a, c, expected) => [...lanes(double, ...a), ...lanes(double, ...a), ...lanes(double, ...c),
        ...simd(op), ...lanes(double, ...expected), ...simd(double ? 0xD6 : 0x37), ...simd(double ? 0xC3 : 0xA3)];
    const bytes = module(RESULT_I32, [0,
        ...check(0x107, true, [1, 0x3FF00000], [2, 0xBFF00000], [0, 0x39700000]),
        ...check(0x108, true, [1, 0x3FF00000], [2, 0x3FF00000], [0, 0xB9700000]), 0x71,
        ...check(0x105, false, [0x3F800001], [0xBF800002], [0x28800000]), 0x71,
        ...check(0x106, false, [0x3F800001], [0x3F800002], [0xA8800000]), 0x71,
        0x0B]);
    if(!validate(bytes)) return { relaxed_simd: false, relaxed_madd_fused: false };
    try
    {
        return { relaxed_simd: true, relaxed_madd_fused: new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.f() === 1 };
    }
    catch{ return { relaxed_simd: true, relaxed_madd_fused: false }; }
}

/** The largest memory (in 64 KiB pages) of `candidates` this host creates */
function largest_memory(shared)
{
    for(const pages of [65536, 49152, 32768, 16384, 8192])
    {
        try
        {
            const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, ...(shared ? { shared: true } : {}) });
            const ok = memory.buffer.byteLength === pages * 65536;
            if(ok) return pages * 65536 / 1048576 + " MiB";
        }
        catch{}
    }
    return "below 512 MiB";
}

export async function probe()
{
    const g = globalThis;
    const host = {};
    if(g.process?.versions?.node)
    {
        Object.assign(host, { node: g.process.version, v8: g.process.versions.v8, architecture: g.process.arch, platform: g.process.platform });
    }
    else if(g.navigator)
    {
        host.user_agent = g.navigator.userAgent;
        host.hardware_concurrency = g.navigator.hardwareConcurrency;
        try
        {
            const data = await g.navigator.userAgentData?.getHighEntropyValues(["architecture", "bitness", "platform", "platformVersion", "fullVersionList"]);
            if(data) Object.assign(host, { architecture: data.architecture, bitness: data.bitness, platform: data.platform,
                platform_version: data.platformVersion, browser: data.fullVersionList?.map(b => b.brand + " " + b.version).join(", ") });
        }
        catch{}
    }
    return {
        ...host,
        date: new Date().toISOString().slice(0, 10),
        cross_origin_isolated: g.crossOriginIsolated ?? null,
        shared_array_buffer: typeof SharedArrayBuffer === "function",
        largest_memory: largest_memory(false),
        largest_shared_memory: typeof SharedArrayBuffer === "function" ? largest_memory(true) : "no SharedArrayBuffer",
        // i32x4.splat, i32x4.extract_lane 0
        simd128: validate(module(RESULT_I32, [0, 0x41, 1, ...simd(0x11), ...simd(0x1B), 0, 0x0B])),
        // return_call 0
        tail_calls: validate(module(RESULT_I32, [0, 0x12, 0, 0x0B])),
        ...relaxed_madd(),
        // a 64-bit memory (limits flag 4), i64.const 0, i32.load
        memory64: validate(module(RESULT_I32, [0, 0x42, 0, 0x28, 2, 0, 0x0B], [1, 4, 1])),
        // atomic.fence
        threads: validate(module(RESULT_I32, [0, 0xFE, 0x03, 0, 0x41, 0, 0x0B])),
        bulk_memory: validate(module([0x60, 0, 0], [0, 0x41, 0, 0x41, 0, 0x41, 0, 0xFC, 11, 0, 0x0B], [1, 0, 1])),
    };
}

if(typeof window === "undefined" && import.meta.url === `file://${process.argv[1]}`)
{
    console.log(JSON.stringify(await probe(), null, 1));
}
