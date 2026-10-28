// SPIR-V as glslang's code pass writes it, read and changed in place
// (docs/gles3-plan.md, "着色器的数据流"): the module's names, types,
// variables and decorations, and the decorations the host decides itself:
// the locations of the interface (by GL's rules and names, across stages)
// and the bindings of the resources, which glslang maps per stage.

export const OP = {
    Name: 5, MemberName: 6, EntryPoint: 15, ExecutionMode: 16, TypeBool: 20, TypeInt: 21, TypeFloat: 22, TypeVector: 23,
    TypeMatrix: 24, TypeImage: 25, TypeSampler: 26, TypeSampledImage: 27, TypeArray: 28, TypeRuntimeArray: 29,
    TypeStruct: 30, TypePointer: 32, Constant: 43, Variable: 59, Decorate: 71, MemberDecorate: 72,
};
export const DECORATION = { Block: 2, BufferBlock: 3, RowMajor: 4, ColMajor: 5, ArrayStride: 6, MatrixStride: 7,
    BuiltIn: 11, Flat: 14, Location: 30, Component: 31, Index: 32, Binding: 33, DescriptorSet: 34, Offset: 35,
    XfbBuffer: 36, XfbStride: 37 };
export const STORAGE = { UniformConstant: 0, Input: 1, Uniform: 2, Output: 3, Workgroup: 4, Private: 6, Function: 7,
    PushConstant: 9, Image: 11, StorageBuffer: 12 };
export const EXECUTION_MODEL = { Vertex: 0, TessellationControl: 1, TessellationEvaluation: 2, Geometry: 3, Fragment: 4, GLCompute: 5 };

/** @param {!Uint32Array} words @param {number} at a literal string's first word @return {string} */
function string_at(words, at)
{
    const bytes = [];
    for(let i = at; i < words.length; i++)
    {
        for(let b = 0; b < 4; b++)
        {
            const c = words[i] >>> 8 * b & 0xFF;
            if(!c) return new TextDecoder().decode(new Uint8Array(bytes));
            bytes.push(c);
        }
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * A module's parts the host reads
 * @param {!Uint32Array} words
 * @return {!Object} {names, member_names, types, constants, variables, decorations, member_decorations, entry}
 */
export function parse_spirv(words)
{
    const m = {
        /** @type {!Map<number, string>} */ names: new Map(),
        /** @type {!Map<number, !Array<string>>} */ member_names: new Map(),
        /** @type {!Map<number, !Object>} */ types: new Map(),
        /** @type {!Map<number, number>} */ constants: new Map(),
        /** @type {!Array<{id: number, type: number, storage: number}>} */ variables: [],
        /** id -> decoration -> the word index of its first operand (-1: none) */
        /** @type {!Map<number, !Map<number, number>>} */ decorations: new Map(),
        /** @type {!Map<number, !Map<number, !Map<number, number>>>} */ member_decorations: new Map(),
        entry: null,
    };
    for(let at = 5; at < words.length;)
    {
        const count = words[at] >>> 16, op = words[at] & 0xFFFF;
        if(!count) break;
        const w = i => words[at + i];
        switch(op)
        {
            case OP.Name: m.names.set(w(1), string_at(words, at + 2)); break;
            case OP.MemberName:
            {
                if(!m.member_names.has(w(1))) m.member_names.set(w(1), []);
                m.member_names.get(w(1))[w(2)] = string_at(words, at + 3);
                break;
            }
            case OP.EntryPoint: m.entry = { model: w(1), id: w(2) }; break;
            case OP.TypeBool: m.types.set(w(1), { kind: "bool" }); break;
            case OP.TypeInt: m.types.set(w(1), { kind: "int", width: w(2), signed: !!w(3) }); break;
            case OP.TypeFloat: m.types.set(w(1), { kind: "float", width: w(2) }); break;
            case OP.TypeVector: m.types.set(w(1), { kind: "vector", component: w(2), size: w(3) }); break;
            case OP.TypeMatrix: m.types.set(w(1), { kind: "matrix", column: w(2), columns: w(3) }); break;
            case OP.TypeImage: m.types.set(w(1), { kind: "image", sampled_type: w(2), dim: w(3), depth: w(4), arrayed: w(5), ms: w(6), sampled: w(7), format: w(8) }); break;
            case OP.TypeSampler: m.types.set(w(1), { kind: "sampler" }); break;
            case OP.TypeSampledImage: m.types.set(w(1), { kind: "sampled_image", image: w(2) }); break;
            case OP.TypeArray: m.types.set(w(1), { kind: "array", element: w(2), length_id: w(3) }); break;
            case OP.TypeRuntimeArray: m.types.set(w(1), { kind: "runtime_array", element: w(2) }); break;
            case OP.TypeStruct: m.types.set(w(1), { kind: "struct", members: Array.from(words.subarray(at + 2, at + count)) }); break;
            case OP.TypePointer: m.types.set(w(1), { kind: "pointer", storage: w(2), pointee: w(3) }); break;
            case OP.Constant: m.constants.set(w(2), w(3)); break;
            case OP.Variable: if(w(3) !== STORAGE.Function) m.variables.push({ id: w(2), type: w(1), storage: w(3) }); break;
            case OP.Decorate:
            {
                if(!m.decorations.has(w(1))) m.decorations.set(w(1), new Map());
                m.decorations.get(w(1)).set(w(2), count > 3 ? at + 3 : -1);
                break;
            }
            case OP.MemberDecorate:
            {
                if(!m.member_decorations.has(w(1))) m.member_decorations.set(w(1), new Map());
                const members = m.member_decorations.get(w(1));
                if(!members.has(w(2))) members.set(w(2), new Map());
                members.get(w(2)).set(w(3), count > 4 ? at + 4 : -1);
                break;
            }
        }
        at += count;
    }
    return m;
}

/** @return {!Object} the type a variable points to */
export function variable_type(m, v)
{
    return m.types.get(m.types.get(v.type).pointee);
}

/** @return {number} an array type's length */
export function array_length(m, type)
{
    return m.constants.get(type.length_id) || 1;
}

/**
 * The locations a value of the type takes in an interface (a matrix's
 * columns, an array's elements, a struct's members, one each)
 * @param {!Object} m parse_spirv's
 * @param {number} id the type
 * @return {number}
 */
export function location_count(m, id)
{
    const t = m.types.get(id);
    switch(t && t.kind)
    {
        case "matrix": return t.columns;
        case "array": return array_length(m, t) * location_count(m, t.element);
        case "struct": return t.members.reduce((n, member) => n + location_count(m, member), 0);
        default: return 1;
    }
}

/** @return {boolean} whether the variable is a built-in (or a block of them: gl_PerVertex) */
export function is_builtin(m, v)
{
    const d = m.decorations.get(v.id);
    if(d && d.has(DECORATION.BuiltIn)) return true;
    const members = m.member_decorations.get(innermost(m, m.types.get(v.type).pointee));
    return !!members && [...members.values()].some(member => member.has(DECORATION.BuiltIn));
}

/** @return {number} the type an array type is an array of, arrays of arrays too (the id itself for any other) */
export function innermost(m, id)
{
    let t = m.types.get(id);
    while(t && t.kind === "array") { id = t.element; t = m.types.get(id); }
    return id;
}

/**
 * A decoration's operand set (the decoration is there: glslang decorated
 * every interface variable and resource, the maps on)
 * @return {boolean} whether it was there
 */
export function set_decoration(words, m, id, decoration, value)
{
    const d = m.decorations.get(id);
    const at = d && d.get(decoration);
    if(at === undefined || at < 0) return false;
    words[at] = value >>> 0;
    return true;
}

/** @return {number|undefined} a decoration's operand */
export function get_decoration(words, m, id, decoration)
{
    const d = m.decorations.get(id);
    const at = d && d.get(decoration);
    return at === undefined || at < 0 ? undefined : words[at];
}

/** @return {string} a variable's name: the variable's own, else its (block) type's */
export function variable_name(m, v)
{
    const own = m.names.get(v.id);
    if(own) return own;
    return m.names.get(innermost(m, m.types.get(v.type).pointee)) || "";
}

/**
 * A block's leaves as GL names them ("a", "k[0]", "s.l[1].c"): each one's
 * offset, array stride and matrix stride, from the module's decorations
 * (glslang's reflection of the code pass gives other offsets for its
 * default uniform block than the SPIR-V has)
 * @param {!Uint32Array} words
 * @param {!Object} m parse_spirv's
 * @param {string} block_name the block type's name ("gl_DefaultUniformBlock")
 * @return {!Map<string, {offset: number, array_stride: number, matrix_stride: number, row_major: boolean}>}
 */
export function block_layout(words, m, block_name)
{
    const leaves = new Map();
    const block = [...m.names].find(([id, name]) => name === block_name && m.types.has(id) && m.types.get(id).kind === "struct");
    if(!block) return leaves;
    const member_word = (id, index, decoration) =>
    {
        const members = m.member_decorations.get(id);
        const d = members && members.get(index);
        const at = d && d.get(decoration);
        return at === undefined || at < 0 ? undefined : words[at];
    };
    const has_member = (id, index, decoration) =>
    {
        const members = m.member_decorations.get(id);
        const d = members && members.get(index);
        return !!d && d.has(decoration);
    };
    const walk = (type_id, name, offset, matrix_stride, row_major) =>
    {
        const t = m.types.get(type_id);
        if(t.kind === "struct")
        {
            const names = m.member_names.get(type_id) || [];
            t.members.forEach((member, i) =>
            {
                walk(member, (name ? name + "." : "") + names[i], offset + (member_word(type_id, i, DECORATION.Offset) || 0),
                    member_word(type_id, i, DECORATION.MatrixStride) || 0, has_member(type_id, i, DECORATION.RowMajor));
            });
            return;
        }
        if(t.kind === "array")
        {
            const stride = get_decoration(words, m, type_id, DECORATION.ArrayStride) || 0;
            const element = m.types.get(t.element);
            if(element.kind === "struct" || element.kind === "array")
            {
                for(let i = 0; i < array_length(m, t); i++) walk(t.element, name + "[" + i + "]", offset + i * stride, matrix_stride, row_major);
                return;
            }
            leaves.set(name + "[0]", { offset, array_stride: stride, matrix_stride, row_major });
            return;
        }
        leaves.set(name, { offset, array_stride: 0, matrix_stride, row_major });
    };
    walk(block[0], "", 0, 0, false);
    return leaves;
}

/**
 * Transform feedback's decorations (VK_EXT_transform_feedback's, which
 * vx_naga's xfb.rs reads): the TransformFeedback capability, the entry
 * point's Xfb mode, and each captured output's XfbBuffer, XfbStride and
 * Offset (a gl_PerVertex member's on the member)
 * @param {!Uint32Array} words
 * @param {!Array<{name: string, buffer: number, offset: number, stride: number}>} captures by variable name, or gl_Position, gl_PointSize
 * @return {!Uint32Array} the module with them
 */
export function add_xfb(words, captures)
{
    const m = parse_spirv(words);
    const decorations = [];
    const instruction = (op, ...operands) => [(operands.length + 1) << 16 | op, ...operands];
    for(const c of captures)
    {
        const builtin = { gl_Position: 0, gl_PointSize: 1 }[c.name];
        if(builtin !== undefined)
        {
            for(const v of m.variables.filter(x => x.storage === STORAGE.Output))
            {
                const type = m.types.get(v.type).pointee;
                const members = m.member_decorations.get(type);
                const member = members && [...members].find(([, d]) => d.has(DECORATION.BuiltIn) && words[d.get(DECORATION.BuiltIn)] === builtin);
                if(member)
                {
                    decorations.push(instruction(OP.MemberDecorate, type, member[0], DECORATION.Offset, c.offset),
                        instruction(OP.MemberDecorate, type, member[0], DECORATION.XfbBuffer, c.buffer),
                        instruction(OP.MemberDecorate, type, member[0], DECORATION.XfbStride, c.stride));
                }
                else if(get_decoration(words, m, v.id, DECORATION.BuiltIn) === builtin)
                {
                    decorations.push(instruction(OP.Decorate, v.id, DECORATION.Offset, c.offset), instruction(OP.Decorate, v.id, DECORATION.XfbBuffer, c.buffer),
                        instruction(OP.Decorate, v.id, DECORATION.XfbStride, c.stride));
                }
            }
            continue;
        }
        const v = m.variables.find(x => x.storage === STORAGE.Output && variable_name(m, x) === c.name && !is_builtin(m, x));
        if(!v) continue;
        decorations.push(instruction(OP.Decorate, v.id, DECORATION.XfbBuffer, c.buffer), instruction(OP.Decorate, v.id, DECORATION.XfbStride, c.stride),
            instruction(OP.Decorate, v.id, DECORATION.Offset, c.offset));
    }
    // (the capability first; the mode after the entry points and modes; the decorations after the others)
    let modes = 5, debug = 5, annotations = 5;
    for(let at = 5; at < words.length;)
    {
        const count = words[at] >>> 16, op = words[at] & 0xFFFF;
        if(!count) break;
        if(op === OP.EntryPoint || op === OP.ExecutionMode || op === 17 || op === 10 || op === 11 || op === 14) modes = at + count;
        if(op >= 3 && op <= 7 || op === 330) debug = at + count;
        if(op === OP.Decorate || op === OP.MemberDecorate || op === 332 || op === 333) annotations = at + count;
        at += count;
    }
    annotations = Math.max(annotations, debug, modes);
    const head = Array.from(words.subarray(0, modes));
    const mode = m.entry ? instruction(OP.ExecutionMode, m.entry.id, 11) : [];
    const out = [...head.slice(0, 5), ...instruction(17, 53), ...head.slice(5), ...mode, ...words.subarray(modes, annotations), ...decorations.flat(),
        ...words.subarray(annotations)];
    return new Uint32Array(out);
}
