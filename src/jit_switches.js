// The JIT switches of src/rust/jit_switches.rs (docs/jit-unification-plan.md,
// cross-phase rule 1). The names come from the Wasm module; values are set by
// name, from the build's JIT_DEFAULTS, the V86 option jit_switches
// ({ name: value } or "name=value,...") and, in tests, JIT_SWITCHES
// (tests/lib/jit_switches.mjs).

const UNSET = 0xFFFFFFFF;

// (a copy: TextDecoder refuses views of the parallel build's shared memory)
function text(exports, memory, which)
{
    const bytes = new Uint8Array(memory.buffer, exports["jit_switch_text"](which) >>> 0, exports["jit_switch_text_length"](which) >>> 0).slice();
    return new TextDecoder().decode(bytes);
}

/**
 * The switches of a v86 Wasm module, by id; none for a module without them
 * @return {Array<{name: string, default: number}>}
 */
export function jit_switch_table(exports, memory)
{
    if(!exports["jit_switch_count"]) return [];
    return text(exports, memory, 0).split("\n").filter(Boolean).map(line => {
        const [name, value] = line.split(" ");
        return { name, default: Number(value) };
    });
}

/**
 * "name=value, ..." or an object, as an object; booleans become 0 and 1
 * @param {Object|string|undefined} values
 * @return {!Object<string, number>}
 */
export function parse_jit_switches(values)
{
    const result = {};
    if(values === undefined || values === null) return result;
    if(typeof values === "object")
    {
        for(const [name, value] of Object.entries(values)) result[name] = typeof value === "boolean" ? +value : value;
        return result;
    }
    for(const pair of String(values).split(",").map(p => p.trim()).filter(Boolean))
    {
        const match = /^([a-z0-9_]+)\s*=\s*(\d+)$/.exec(pair);
        if(!match) throw new Error("JIT switches: expected name=value, not " + JSON.stringify(pair));
        result[match[1]] = Number(match[2]);
    }
    return result;
}

/**
 * Sets switches by name, in the registry's order (src/rust/jit_switches.rs).
 * Throws on an unknown name, and on a value the module refuses: out of range,
 * or a change it allows only before anything is compiled. `origin` names the
 * source in the message.
 */
export function set_jit_switches(exports, memory, values, origin = "jit_switches")
{
    const wanted = parse_jit_switches(values);
    const names = Object.keys(wanted);
    if(!names.length) return;
    const table = jit_switch_table(exports, memory);
    for(const name of names)
    {
        if(!table.some(s => s.name === name))
            throw new Error(`${origin}: no JIT switch ${name} (the switches: ${table.map(s => s.name).join(", ")})`);
    }
    table.forEach(({ name }, id) => {
        if(!(name in wanted)) return;
        const value = wanted[name];
        if(!Number.isInteger(value) || value < 0 || value >= UNSET || !exports["jit_set_switch"](id, value))
            throw new Error(`${origin}: the JIT switch ${name} cannot be ${value} now`);
    });
}

/**
 * The value of each switch: all of them, or with `explicit` only those set
 * through set_jit_switches (what a vCPU worker is started with)
 * @return {!Object<string, number>}
 */
export function get_jit_switches(exports, memory, explicit = false)
{
    const result = {};
    jit_switch_table(exports, memory).forEach(({ name }, id) => {
        const value = (explicit ? exports["jit_switch_explicit"](id) : exports["jit_switch"](id)) >>> 0;
        if(value !== UNSET) result[name] = value;
    });
    return result;
}

/** The build's JIT_DEFAULTS (Makefile), as an object */
export function build_jit_defaults(exports, memory)
{
    return exports["jit_switch_count"] ? parse_jit_switches(text(exports, memory, 1)) : {};
}
