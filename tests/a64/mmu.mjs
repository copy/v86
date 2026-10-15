#!/usr/bin/env node
// The stage 1 MMU against QEMU (docs/arm64-virt-android16-plan.md P3.3-P3.5;
// `--granules` all: P3.4's 16 and 64 KiB too, with the test profile v1.1).
// Each case programs TCR_EL1 (TnSZ, TGn, TBIn, IPS, A1, AS, EPDn), MAIR_EL1,
// SCTLR_EL1.A and both TTBRs with an ASID, builds random translation tables
// (pages and blocks, APTable/XNTable/PXNTable, AF clear, nG, output and
// table addresses beyond the 40-bit PA space or in a hole) next to an
// identity map of the guest, turns the MMU on and runs a list of probes:
// loads and stores (aligned and not, on Normal and Device memory), LDTR and
// STTR, the four AT S1E* with PAR_EL1, an instruction fetch at EL1 (BLR to
// a page of RETs) and at EL0 (ERET to a page of SVCs), and descriptor
// rewrites followed by each kind of TLBI. A probe records its value, or
// the exception's ESR and FAR; QEMU's records and v86's must be equal.
//
//   node tests/a64/mmu.mjs [--cases N] [--seed S] [--granules 4k|all]
import assert from "node:assert/strict";
import fs from "node:fs";
import { build, reference, actual, root } from "./guest_runner.mjs";

const args = process.argv.slice(2);
const option = (name, value) => { const i = args.indexOf(name); return i < 0 ? value : args[i + 1]; };
const CASES = +option("--cases", 300);
const SEED = +option("--seed", 1);
const ALL_GRANULES = option("--granules", "4k") === "all";
const BATCH = 50;
const MEMORY_MB = 256;

let state = BigInt(SEED) * 0x9E3779B97F4A7C15n & (1n << 64n) - 1n || 1n;
function next64()
{
    state ^= state << 13n & (1n << 64n) - 1n;
    state ^= state >> 7n;
    state ^= state << 17n & (1n << 64n) - 1n;
    return state;
}
const rand = n => Number(next64() % BigInt(n));
const pick = list => list[rand(list.length)];
const chance = p => rand(1000) < p * 1000;
const hex = v => "0x" + BigInt.asUintN(64, BigInt(v)).toString(16);
const M64 = (1n << 64n) - 1n;

// ---- the physical layout (RAM from 0x4000_0000)
const IDENTITY = [0x40000000n, 0x46000000n];  // the guest, its data pages and the table pool: identity mapped
const DATA = 0x41000000n;                       // 16 data pages of 64 KiB, a pattern each
const RET_PAGE = DATA + 16n * 0x10000n;         // 64 KiB of RET
const SVC_PAGE = RET_PAGE + 0x10000n;           // 64 KiB of SVC #0
const BLOCK_2M = 0x41400000n;                   // 2 MiB-aligned (4 KiB granule blocks)
const BLOCK_32M = 0x42000000n;                  // 32 MiB-aligned (16 KiB granule blocks)
const POOL = 0x44000000n;                       // translation tables (each case starts it zeroed)
const POOL_SIZE = 0x01000000n;
// (no RAM or device, aligned for every block size; below 1 GiB QEMU has flash and devices v86 lacks)
const HOLE = 0x80000000n;

// ---- MAIR: index 0 is the identity map's Normal memory
const MAIR_ATTRS = [0xFFn, 0x00n, 0x04n, 0x08n, 0x0Cn, 0x44n, 0xBBn, 0x4Fn, 0xF4n];

/** One case's tables: a pool allocator and the descriptor writes */
class Tables
{
    constructor()
    {
        this.next = POOL;
        this.writes = new Map();
    }
    alloc(bytes)
    {
        const size = BigInt(Math.max(bytes, 64));
        this.next = (this.next + size - 1n) / size * size;
        const at = this.next;
        this.next += size;
        assert.ok(this.next <= POOL + POOL_SIZE, "table pool exhausted");
        return at;
    }
    write(pa, value) { this.writes.set(pa, BigInt.asUintN(64, value)); }
    read(pa) { return this.writes.get(pa) ?? 0n; }
}

/** A translation regime half: granule log2, input size; the root table */
class Region
{
    constructor(tables, granule, inputsize)
    {
        this.tables = tables;
        this.granule = granule;
        this.stride = granule - 3;
        this.inputsize = inputsize;
        this.start = 4 - Math.floor((inputsize - 4) / this.stride);
        const root_bits = inputsize - (this.stride * (4 - this.start) + 3);
        this.root = tables.alloc(Math.max(8 << root_bits, 1 << granule));
    }
    shift(level) { return BigInt(this.stride * (4 - level) + 3); }
    index(va, level)
    {
        const bits = level === this.start ? this.inputsize - Number(this.shift(level)) : this.stride;
        return (va >> this.shift(level)) & ((1n << BigInt(bits)) - 1n);
    }
    /** The table at `level` holding `va` (made as needed); its descriptor's address */
    slot(va, level, table_bits = 0n)
    {
        let table = this.root;
        for(let l = this.start; l < level; l++)
        {
            const at = table + 8n * this.index(va, l);
            let d = this.tables.read(at);
            if((d & 3n) !== 3n)
            {
                const next = this.tables.alloc(1 << this.granule);
                d = next | 3n | (l === level - 1 ? table_bits : 0n);
                this.tables.write(at, d);
            }
            table = d & 0xFFFFFFFFF000n & ~((1n << BigInt(this.granule)) - 1n);
        }
        return table + 8n * this.index(va, level);
    }
    map(va, level, descriptor, table_bits = 0n)
    {
        const at = this.slot(va, level, table_bits);
        this.tables.write(at, descriptor);
        return at;
    }
    block_levels() { return this.granule === 12 ? [1, 2] : [2]; }
}

function leaf(oa, level, { ap = 0n, attr = 0n, af = 1n, ng = 0n, pxn = 0n, uxn = 0n, sh = 3n, contiguous = 0n } = {})
{
    return oa | (level === 3 ? 3n : 1n) | attr << 2n | ap << 6n | sh << 8n | af << 10n | ng << 11n | contiguous << 52n |
        pxn << 53n | uxn << 54n;
}

// ---- probes
const OP = { ldr: 0, ldrb: 1, str: 2, ldtr: 3, sttr: 4, at_e1r: 5, at_e1w: 6, at_e0r: 7, at_e0w: 8, fetch_el1: 9, fetch_el0: 10,
    write: 11, tlbi: 12, ldr_q: 13, str_q: 14 };

function make_case()
{
    const tables = new Tables();
    const granules = ALL_GRANULES ? [12, 14, 16] : [12];
    const g0 = pick(granules), g1 = pick(granules);
    // (T0SZ keeps the identity map, at 0x4000_0000, reachable: at most 33)
    const t0sz = 16 + rand(18);
    const t1sz = chance(0.05) ? pick([8, 12, 40, 48]) : 16 + rand(24);
    const tbi0 = BigInt(rand(2)), tbi1 = BigInt(rand(2));
    const ips = BigInt(rand(6)), a1 = BigInt(rand(2)), as = BigInt(rand(2));
    const epd1 = chance(0.05) ? 1n : 0n;
    const tg0 = { 12: 0n, 14: 2n, 16: 1n }[g0], tg1 = { 12: 2n, 14: 1n, 16: 3n }[g1];
    const tcr = BigInt(t0sz) | tg0 << 14n | 3n << 12n | BigInt(t1sz) << 16n | a1 << 22n | epd1 << 23n | tg1 << 30n | 3n << 28n |
        ips << 32n | as << 36n | tbi0 << 37n | tbi1 << 38n;
    const mair = [0xFFn, ...Array.from({ length: 7 }, () => pick(MAIR_ATTRS))].reduce((m, a, i) => m | a << BigInt(8 * i), 0n);
    const asid0 = BigInt(rand(1 << 16)), asid1 = BigInt(rand(1 << 16));
    const low = new Region(tables, g0, 64 - t0sz);
    const t1_in_range = t1sz >= 16 && t1sz <= 39;
    const high = new Region(tables, g1, t1_in_range ? 64 - t1sz : 48);
    // the identity map: Normal, EL1 read/write, global, EL1-executable
    const identity_level = g0 === 12 ? 2 : 2;
    const identity_size = 1n << low.shift(identity_level);
    for(let pa = IDENTITY[0] & ~(identity_size - 1n); pa < IDENTITY[1]; pa += identity_size)
    {
        low.map(pa, identity_level, leaf(pa, identity_level, { uxn: 1n }));
    }
    const identity_end = (IDENTITY[1] + identity_size - 1n) & ~(identity_size - 1n);
    const identity_start = IDENTITY[0] & ~(identity_size - 1n);

    // random mappings in both halves
    const mappings = [];
    const random_va = region => {
        for(;;)
        {
            const va = next64() & ((1n << BigInt(region.inputsize)) - 1n);
            if(region === low && va + 0x10000000n > identity_start && va < identity_end) continue;
            return region === low ? va : BigInt.asUintN(64, va - (1n << BigInt(region.inputsize)));
        }
    };
    for(let k = 0; k < 6 + rand(6); k++)
    {
        const region = rand(2) ? low : high;
        if(region === high && !t1_in_range) continue;
        const block = chance(0.3);
        const level = block ? pick(region.block_levels()) : 3;
        const size = 1n << region.shift(level);
        const va = random_va(region) & ~(size - 1n);
        // (nothing may replace the identity map's entries)
        const overlaps = (start, length) => region === low && start < identity_end && start + length > identity_start;
        if(overlaps(va, size)) continue;
        let oa;
        if(block)
        {
            oa = region.granule === 12 ? (level === 2 ? BLOCK_2M : 0x40000000n) : region.granule === 14 ? BLOCK_32M : 0x40000000n;
            if(level === 1 && region.granule === 12) oa = 0x40000000n;
        }
        else
        {
            oa = DATA + BigInt(rand(16)) * 0x10000n;
            if(chance(0.1)) oa = RET_PAGE;
            if(chance(0.1)) oa = SVC_PAGE;
            oa &= ~(size - 1n);
        }
        if(chance(0.05)) oa = HOLE;                              // a hole: an external abort on the access
        if(chance(0.05)) oa |= 1n << BigInt(40 + rand(8));   // beyond 40 bits: an address size fault
        const attrs = {
            ap: BigInt(rand(4)), attr: BigInt(rand(8)), af: chance(0.1) ? 0n : 1n, ng: BigInt(rand(2)),
            pxn: chance(0.2) ? 1n : 0n, uxn: chance(0.3) ? 1n : 0n, sh: BigInt(rand(4)), contiguous: chance(0.1) ? 1n : 0n,
        };
        // (aliases of the guest's own memory and the code pages are read-only: stores must not reach them)
        if(oa === 0x40000000n || oa === RET_PAGE || oa === SVC_PAGE) attrs.ap |= 2n;
        let descriptor = leaf(oa, level, attrs);
        if(chance(0.05)) descriptor &= ~1n;                      // invalid
        if(chance(0.03) && level === 3) descriptor &= ~2n;       // a block at level 3: invalid
        const table_bits = chance(0.15) ? BigInt(rand(16)) << 59n : 0n;
        try
        {
            const slot = region.map(va, level, descriptor, table_bits);
            mappings.push({ va, size, slot, level, region, oa, descriptor });
        }
        catch(e)
        {
            // (a table already a block, or the other way round: skip)
        }
    }
    // table descriptors pointing beyond 40 bits or at a hole
    if(chance(0.2) && mappings.length)
    {
        // (the table entry above a mapping, unless its range holds the identity map)
        const m = pick(mappings);
        const level = m.level - 1;
        const span = 1n << m.region.shift(level);
        const start = m.va & ~(span - 1n);
        if(level >= m.region.start && !(m.region === low && start < identity_end && start + span > identity_start))
        {
            const at = m.region.slot(m.va, level);
            const d = tables.read(at);
            if((d & 3n) === 3n) tables.write(at, chance(0.5) ? d | 1n << 42n : HOLE | 3n);
        }
    }

    // probes: on the mappings (sometimes off by an offset or tagged), and anywhere
    const probes = [];
    const target = () => {
        if(!mappings.length || chance(0.15)) return pick([random_va(low), t1_in_range ? random_va(high) : random_va(low), next64()]);
        const m = pick(mappings);
        // (a block at the start of RAM: the reference keeps its boot stub there, so read the data pages through it)
        const base = m.oa === 0x40000000n ? DATA - 0x40000000n : 0n;
        let va = m.va + base + (next64() & (m.size < 0x10000n ? m.size - 1n : 0xFFFFn));
        if(chance(0.15)) va = va & ~(0xFFn << 56n) | BigInt(rand(256)) << 56n;
        return BigInt.asUintN(64, va);
    };
    // (the reference does not alignment-fault on Device memory with the MMU on, an allowed difference:
    // misaligned probes only where the mapping is Normal memory)
    const device = va => {
        const d = leaf_descriptor(va >> 55n & 1n ? high : low, tables, va);
        if(d === null) return true;
        const attr = mair >> (8n * (d >> 2n & 7n)) & 0xFFn;
        return (attr & 0xF0n) === 0n;
    };
    for(let k = 0; k < 10 + rand(10); k++)
    {
        const kind = pick(["ldr", "ldr", "ldrb", "str", "ldtr", "sttr", "at_e1r", "at_e1w", "at_e0r", "at_e0w", "fetch_el1", "fetch_el0",
            "remap", "ldr_q", "str_q"]);
        let va = target();
        if(["ldr", "str", "ldtr", "sttr", "ldr_q", "str_q"].includes(kind) && (!chance(0.2) || device(va))) va &= ~7n;
        if(kind === "ldr_q" || kind === "str_q") va &= chance(0.8) || device(va) ? ~15n : ~7n;
        if(kind === "ldrb" && device(va) && chance(0.5)) va &= ~7n;
        if(kind.startsWith("fetch"))
        {
            // (only the pages of RET or SVC run: a data page would run its pattern)
            const code = mappings.filter(m => m.oa === RET_PAGE || m.oa === SVC_PAGE);
            if(code.length && !chance(0.2))
            {
                const m = pick(code);
                va = m.va + (next64() & (m.size - 1n) & 0xFFFCn);
            }
            else
            {
                va = random_va(rand(2) || !t1_in_range ? low : high);
                if(mappings.some(m => va >= m.va && va < m.va + m.size)) continue;
            }
            va &= ~3n;
        }
        const data_mappings = mappings.filter(m => m.oa !== RET_PAGE && m.oa !== SVC_PAGE);
        if(kind === "remap" && data_mappings.length)
        {
            // rewrite a leaf (not a code page's) to another data page, then a TLBI, then read through it
            const m = pick(data_mappings);
            const target_pa = DATA + BigInt(rand(16)) * 0x10000n;
            const new_oa = target_pa & ~(m.size - 1n);
            const new_descriptor = leaf(new_oa, m.level, { ap: 0n, attr: 0n, ng: BigInt(rand(2)) });
            probes.push({ op: OP.write, va: m.slot, arg: new_descriptor });
            // (a cached entry is the old descriptor's: global or not decides which TLBI must drop it)
            const old_descriptor = m.descriptor;
            m.descriptor = new_descriptor;
            const asid = a1 ? asid1 : asid0;
            // (ASIDE1 leaves a global entry: then either translation is allowed, so only for nG ones)
            const op2 = pick((old_descriptor >> 11n & 1n) ? [0, 1, 2, 3, 5, 7] : [0, 1, 3, 5, 7]);
            const is = rand(2);
            const xt = op2 === 0 ? 0n : op2 === 2 ? asid << 48n : (asid << 48n | (m.va >> 12n) & 0xFFFFFFFFFFFn);
            probes.push({ op: OP.tlbi, va: xt, arg: BigInt(op2 | is << 3) });
            probes.push({ op: OP.ldr, va: m.va + (target_pa - new_oa), arg: 0n });
            continue;
        }
        if(kind === "remap") continue;
        probes.push({ op: OP[kind], va, arg: next64() });
    }
    const sctlr_a = chance(0.15) ? 1n : 0n;
    const ttbr0 = low.root | asid0 << 48n, ttbr1 = high.root | asid1 << 48n;
    return { tcr, mair, ttbr0, ttbr1, sctlr_a, writes: [...tables.writes], probes, pool_end: tables.next, low, high, tables };
}

/** The leaf descriptor a walk of `va` reaches in the tables (now), or null */
function leaf_descriptor(region, tables, va)
{
    let table = region.root;
    for(let level = region.start; level <= 3; level++)
    {
        const d = tables.read(table + 8n * region.index(va, level));
        if((d & 1n) === 0n) return null;
        if((d & 2n) === 0n || level === 3) return d;
        table = d & 0xFFFFFFFFF000n & ~((1n << BigInt(region.granule)) - 1n);
    }
    return null;
}

const cases = Array.from({ length: CASES }, make_case);
if(process.env.MMU_DUMP)
{
    // (diagnostics: one case's probes and the walks they start with)
    const c = cases[+process.env.MMU_DUMP];
    c.probes.forEach((p, k) => console.log(`${k} ${Object.keys(OP).find(key => OP[key] === p.op)} va ${hex(p.va)} arg ${hex(p.arg)}` +
        (p.op === OP.write || p.op === OP.tlbi ? "" : "\n    " + explain(c, p.va))));
    process.exit(0);
}

/** (diagnostics) the descriptors a walk of `va` reads in a case's tables */
function explain(c, va)
{
    const select = va >> 55n & 1n;
    const region = select ? c.high : c.low;
    let table = region.root, out = [];
    for(let level = region.start; level <= 3; level++)
    {
        const at = table + 8n * region.index(va, level);
        const d = c.tables.read(at);
        out.push(`L${level}@${hex(at)}=${hex(d)}`);
        if((d & 1n) === 0n || (d & 2n) === 0n || level === 3) break;
        table = d & 0xFFFFFFFFF000n & ~((1n << BigInt(region.granule)) - 1n);
    }
    return out.join(" ");
}

// ---- the guest of a batch: a probe interpreter in assembly
// probe record (32 bytes): status (0 done, 1 sync exception at EL1, 2 from EL0), ESR, FAR, value
function guest(batch, first)
{
    const L = [];
    L.push(".text", ".balign 4", ".global run_cases", "run_cases:",
        "    stp x29, x30, [sp, #-96]!", "    stp x19, x20, [sp, #16]", "    stp x21, x22, [sp, #32]", "    stp x23, x24, [sp, #48]",
        "    stp x25, x26, [sp, #64]", "    stp x27, x28, [sp, #80]", "    mrs x27, vbar_el1", "    mrs x26, sctlr_el1", "    mov x19, #0",
        "    adrp x25, case_list", "    add x25, x25, :lo12:case_list",
        "next_case:", "    ldr x0, [x25], #8", "    cbz x0, all_done",
        // case header: tcr, mair, ttbr0, ttbr1, sctlr_a, pool_end, writes count, probes count, writes..., probes..., then output pointer
        "    mov x24, x0",
        // zero the pool up to pool_end
        `    ldr x1, =${hex(POOL)}`, "    ldr x2, [x24, #40]",
        "1:  stp xzr, xzr, [x1], #16", "    cmp x1, x2", "    b.lo 1b",
        // descriptor writes (physical, the MMU is off)
        "    ldr x3, [x24, #48]", "    add x4, x24, #72",
        "2:  cbz x3, 3f", "    ldp x5, x6, [x4], #16", "    str x6, [x5]", "    sub x3, x3, #1", "    b 2b",
        "3:  ldr x23, [x24, #56]", "    mov x22, x4", "    ldr x20, [x24, #64]",
        "    ldr x1, [x24, #0]", "    msr tcr_el1, x1", "    ldr x1, [x24, #8]", "    msr mair_el1, x1",
        "    ldr x1, [x24, #16]", "    msr ttbr0_el1, x1", "    ldr x1, [x24, #24]", "    msr ttbr1_el1, x1",
        "    adr x1, test_vectors", "    msr vbar_el1, x1",
        "    dsb sy", "    tlbi vmalle1", "    dsb sy", "    isb",
        "    ldr x1, [x24, #32]", "    orr x2, x26, #1", "    bic x2, x2, #(1 << 19)", "    bic x2, x2, #2", "    orr x2, x2, x1, lsl #1",
        "    msr sctlr_el1, x2", "    isb",
        "next_probe:", "    cbz x23, case_done",
        "    ldp x2, x0, [x22], #16", "    ldr x3, [x22], #8",
        "    stp xzr, xzr, [x20]", "    stp xzr, xzr, [x20, #16]",
        "    adr x4, op_table", "    ldr w5, [x4, x2, lsl #2]", "    add x4, x4, x5", "    br x4",
        "probe_done:", "    add x20, x20, #32", "    sub x23, x23, #1", "    b next_probe",
        "case_done:", "    msr sctlr_el1, x26", "    isb", "    msr vbar_el1, x27", "    isb", "    b next_case",
        "all_done:", "    ldp x19, x20, [sp, #16]", "    ldp x21, x22, [sp, #32]", "    ldp x23, x24, [sp, #48]",
        "    ldp x25, x26, [sp, #64]", "    ldp x27, x28, [sp, #80]", "    ldp x29, x30, [sp], #96", "    ret",
        ".ltorg");
    // the probes (x0 the VA, x3 the argument, x20 the record; a fault records itself and returns past the instruction)
    const ops = [
        ["p_ldr", ["ldr x1, [x0]", "str x1, [x20, #24]"]],
        ["p_ldrb", ["ldrb w1, [x0]", "str x1, [x20, #24]"]],
        ["p_str", ["str x3, [x0]"]],
        ["p_ldtr", ["ldtr x1, [x0]", "str x1, [x20, #24]"]],
        ["p_sttr", ["sttr x3, [x0]"]],
        ["p_at_e1r", ["at s1e1r, x0", "isb", "mrs x1, par_el1", "str x1, [x20, #24]"]],
        ["p_at_e1w", ["at s1e1w, x0", "isb", "mrs x1, par_el1", "str x1, [x20, #24]"]],
        ["p_at_e0r", ["at s1e0r, x0", "isb", "mrs x1, par_el1", "str x1, [x20, #24]"]],
        ["p_at_e0w", ["at s1e0w, x0", "isb", "mrs x1, par_el1", "str x1, [x20, #24]"]],
        ["p_fetch_el1", ["mov x1, #7", "mov x19, #1", "blr x0", "mov x19, #0", "str x1, [x20, #24]"]],
        ["p_fetch_el0", ["adr x21, 4f", "msr elr_el1, x0", "msr spsr_el1, xzr", "eret", "4:"]],
        ["p_write", ["str x3, [x0]", "dsb sy"]],
        ["p_tlbi", ["and x1, x3, #7", "tst x3, #8", "b.ne 5f",
            "cmp x1, #0", "b.ne 6f", "tlbi vmalle1", "b 9f", "6: cmp x1, #1", "b.ne 6f", "tlbi vae1, x0", "b 9f",
            "6: cmp x1, #2", "b.ne 6f", "tlbi aside1, x0", "b 9f", "6: cmp x1, #3", "b.ne 6f", "tlbi vaae1, x0", "b 9f",
            "6: cmp x1, #5", "b.ne 6f", "tlbi vale1, x0", "b 9f", "6: tlbi vaale1, x0", "b 9f",
            "5: cmp x1, #0", "b.ne 6f", "tlbi vmalle1is", "b 9f", "6: cmp x1, #1", "b.ne 6f", "tlbi vae1is, x0", "b 9f",
            "6: cmp x1, #2", "b.ne 6f", "tlbi aside1is, x0", "b 9f", "6: cmp x1, #3", "b.ne 6f", "tlbi vaae1is, x0", "b 9f",
            "6: cmp x1, #5", "b.ne 6f", "tlbi vale1is, x0", "b 9f", "6: tlbi vaale1is, x0",
            "9: dsb sy", "isb"]],
        ["p_ldr_q", ["ldr q0, [x0]", "fmov x1, d0", "str x1, [x20, #24]", "mov x1, v0.d[1]", "str x1, [x20, #16]"]],
        ["p_str_q", ["fmov d0, x3", "mov v0.d[1], x3", "str q0, [x0]"]],
    ];
    L.push(".balign 4", "op_table:");
    for(const [label] of ops) L.push(`    .word ${label} - op_table`);
    for(const [label, body] of ops) L.push(`${label}:`, ...body.map(line => /^\d:/.test(line) || /^\d+:$/.test(line) ? line : "    " + line), "    b probe_done");
    // the vectors: record the exception; from EL1, skip the instruction (in the EL1 fetch probe, x19 1, return to the link register);
    // from EL0 (the SVC or the abort of the EL0 fetch probe), return to x21 at EL1
    L.push(".balign 2048", "test_vectors:", ".skip 0x200",
        "    mrs x1, esr_el1", "    str x1, [x20, #8]", "    mrs x1, far_el1", "    str x1, [x20, #16]", "    mov x1, #1", "    str x1, [x20]",
        "    cbnz x19, 7f",
        "    mrs x1, elr_el1", "    add x1, x1, #4", "    msr elr_el1, x1", "    eret",
        "7:  msr elr_el1, x30", "    eret",
        ".balign 0x80", ".skip 0x400 - 0x280",
        "    mrs x1, esr_el1", "    str x1, [x20, #8]", "    mrs x1, far_el1", "    str x1, [x20, #16]", "    mov x1, #2", "    str x1, [x20]",
        "    msr elr_el1, x21", "    mov x1, #0x3c5", "    msr spsr_el1, x1", "    eret");
    // the cases
    L.push(".data", ".balign 8", "case_list:");
    batch.forEach((_, i) => L.push(`    .quad case_${first + i}`));
    L.push("    .quad 0");
    batch.forEach((c, i) => {
        const n = first + i;
        L.push(".balign 8", `case_${n}:`, ...[c.tcr, c.mair, c.ttbr0, c.ttbr1, c.sctlr_a, c.pool_end, BigInt(c.writes.length),
            BigInt(c.probes.length)].map(v => `    .quad ${hex(v)}`), `    .quad output_${n}`);
        for(const [pa, value] of c.writes) L.push(`    .quad ${hex(pa)}, ${hex(value)}`);
        for(const p of c.probes) L.push(`    .quad ${p.op}, ${hex(p.va)}, ${hex(p.arg)}`);
    });
    batch.forEach((c, i) => L.push(".balign 8", `output_${first + i}:`, `    .zero ${32 * c.probes.length}`));
    L.push(".text", ".global case_outputs", ".balign 8", "case_outputs:");
    batch.forEach((c, i) => L.push(`    .quad output_${first + i}`, `    .quad ${c.probes.length}`));
    return L.join("\n") + "\n";
}

const MAIN = `#include <a64.h>
#include <stdio.h>
void run_cases(void);
extern const unsigned long case_outputs[][2];
static void fill(unsigned long at, unsigned long size, unsigned long seed)
{
    for(unsigned long i = 0; i < size; i += 8) *(volatile unsigned long *)(at + i) = (seed << 40) ^ (at + i) * 0x9E3779B97F4A7C15ul;
}
int main(int argc, char **argv)
{
    (void)argc, (void)argv;
    for(int p = 0; p < 16; p++) fill(${hex(DATA)} + 0x10000ul * p, 0x10000, p + 1);
    for(unsigned long i = 0; i < 0x10000; i += 4) *(volatile unsigned *)(${hex(RET_PAGE)} + i) = 0xd65f03c0;  // RET
    for(unsigned long i = 0; i < 0x10000; i += 4) *(volatile unsigned *)(${hex(SVC_PAGE)} + i) = 0xd4000001;  // SVC #0
    fill(${hex(BLOCK_2M)}, 0x10000, 17);
    fill(${hex(BLOCK_32M)}, 0x10000, 18);
    __asm__ volatile("dsb sy; ic iallu; isb" ::: "memory");
    run_cases();
    for(int i = 0; i < CASE_COUNT; i++)
    {
        const unsigned long *out = (const unsigned long *)case_outputs[i][0];
        printf("case %d", FIRST + i);
        for(unsigned long k = 0; k < case_outputs[i][1]; k++)
            printf(" | %lx %lx %lx %lx", out[4 * k], out[4 * k + 1], out[4 * k + 2], out[4 * k + 3]);
        unsigned long sum = 0;
        for(unsigned long a = ${hex(DATA)}; a < ${hex(DATA)} + 0x100000; a += 8) sum = (sum ^ *(volatile unsigned long *)a) * 0x100000001B3ul;
        printf(" | memory %lx\\n", sum);
    }
    return 0;
}
`;

const directory_base = root + "build/a64-mmu-oracle/";
fs.mkdirSync(directory_base, { recursive: true });
const only_qemu = process.env.A64_TARGET === "qemu";
let differences = 0, compared = 0, probes = 0;
const setup = ALL_GRANULES ? cpu => cpu.wm.exports["a64_set_granules"](7) : null;
for(let first = 0; first < cases.length; first += BATCH)
{
    const batch = cases.slice(first, first + BATCH);
    fs.writeFileSync(directory_base + `cases-${first}.S`, guest(batch, first));
    fs.writeFileSync(directory_base + `main-${first}.c`, MAIN.replace(/CASE_COUNT/g, String(batch.length)).replace(/FIRST/g, String(first)));
    const directory = build(`mmu-oracle-${first}`, [directory_base + `cases-${first}.S`, directory_base + `main-${first}.c`]);
    const expected = await reference(directory, { memory: MEMORY_MB, timeout: 120000 });
    assert.equal(expected.status, "ok", "QEMU: " + expected.status + " " + expected.text.slice(-500));
    if(only_qemu) { compared += batch.length; continue; }
    const got = await actual(directory, { memory: MEMORY_MB, timeout: 600000, setup });
    assert.equal(got.status, "ok", "v86: " + got.status + " " + got.text.slice(-500));
    const want = expected.text.trim().split("\n"), have = got.text.trim().split("\n");
    assert.equal(have.length, want.length, "line count");
    for(let i = 0; i < want.length; i++)
    {
        compared++;
        probes += batch[i].probes.length;
        if(want[i] === have[i]) continue;
        differences++;
        if(differences > 12) continue;
        const c = batch[i];
        const w = want[i].split(" | "), h = have[i].split(" | ");
        console.log(`DIFF case ${first + i}: tcr ${hex(c.tcr)} mair ${hex(c.mair)} ttbr0 ${hex(c.ttbr0)} ttbr1 ${hex(c.ttbr1)} A ${c.sctlr_a}`);
        for(let k = 1; k < w.length; k++)
        {
            if(w[k] === h[k]) continue;
            const p = c.probes[k - 1];
            const name = p ? Object.keys(OP).find(key => OP[key] === p.op) + " " + hex(p.va) : "";
            console.log(`  probe ${k - 1} ${name}: qemu ${w[k]} v86 ${h[k]}`);
            if(p && process.env.MMU_EXPLAIN) console.log("    " + explain(c, p.va));
        }
    }
}
console.log(`mmu oracle: ${compared} cases, ${probes} probes (${ALL_GRANULES ? "4/16/64 KiB granules, profile v1.1" : "4 KiB granule"}, seed ${SEED}), ` +
    `${differences} differences` + (only_qemu ? " (QEMU only)" : ""));
process.exit(differences ? 1 : 0);
