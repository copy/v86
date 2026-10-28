// GLES state in snapshots (docs/gles-proxy-plan.md E5): what the GLES host
// keeps (renderControl's objects, the shadow state, the connections) and
// what the page's executor keeps (its shadow, color buffers, surfaces and
// the GPU's contents read back) packed into what v86's snapshots hold: a
// JSON string and the typed arrays beside it ([json, buffers]).
//
// The packing keeps Maps, Sets, typed arrays, undefined and the numbers JSON
// has no words for, and objects reached twice (a share group of several
// contexts) once; instances of the classes named in `classes` come back
// with their prototypes. A function, or an instance of a class not named
// (a GPU object), is left out, as is a key `skip` refuses.
//
// The shadow's compiled shaders and linked programs are not kept: their
// sources are (compiled_source, link: gles_shadow.js), compiled and linked
// again at the restore, which gives the same answers.

import { compile_shader, link_program } from "./glsl_es.js";

const TYPED = { Uint8Array, Int8Array, Uint8ClampedArray, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array };

/**
 * @param {*} value
 * @param {{classes: (!Object<string, !Object>|undefined), skip: (function(string, !Object): boolean|undefined)}=} options
 *     classes: tags and the prototypes of their instances; skip(key, owner)
 *     whether an object's key is left out
 * @return {!Array<*>} [json, buffers]
 */
export function pack(value, options = {})
{
    const classes = new Map(Object.entries(options.classes || {}).map(([tag, prototype]) => [prototype, tag]));
    const skip = options.skip || (() => false);
    /** @type {!Array<!Uint8Array>} */
    const buffers = [];
    const seen = new Map();
    const walk = v =>
    {
        if(v === undefined) return { $u: 1 };
        if(typeof v === "number") return Number.isFinite(v) && !Object.is(v, -0) ? v : { $n: Object.is(v, -0) ? "-0" : String(v) };
        if(typeof v === "bigint") return { $g: v.toString() };
        if(typeof v === "function" || typeof v === "symbol") return { $u: 1 };
        if(v === null || typeof v !== "object") return v;
        if(ArrayBuffer.isView(v))
        {
            const name = Object.keys(TYPED).find(n => v instanceof TYPED[n]);
            if(!name) return { $u: 1 };
            buffers.push(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
            return { $t: name, $b: buffers.length - 1 };
        }
        if(v instanceof ArrayBuffer)
        {
            buffers.push(new Uint8Array(v.slice(0)));
            return { $t: "ArrayBuffer", $b: buffers.length - 1 };
        }
        if(seen.has(v)) return { $r: seen.get(v) };
        const prototype = Object.getPrototypeOf(v);
        const tag = classes.get(prototype);
        if(prototype !== Object.prototype && prototype !== null && !tag && !Array.isArray(v) && !(v instanceof Map) && !(v instanceof Set))
        {
            return { $u: 1 };
        }
        const id = seen.size;
        seen.set(v, id);
        if(Array.isArray(v)) return { $i: id, $a: v.map(walk) };
        if(v instanceof Map) return { $i: id, $m: [...v].map(([k, x]) => [walk(k), walk(x)]) };
        if(v instanceof Set) return { $i: id, $s: [...v].map(walk) };
        const fields = {};
        for(const key of Object.keys(v)) if(!skip(key, v)) fields[key] = walk(v[key]);
        return tag ? { $i: id, $o: fields, $c: tag } : { $i: id, $o: fields };
    };
    return [JSON.stringify(walk(value)), buffers];
}

/**
 * @param {!Array<*>} packed [json, buffers] (pack's)
 * @param {!Object<string, !Object>=} classes the same tags' prototypes
 * @return {*}
 */
export function unpack(packed, classes = {})
{
    const [json, buffers] = packed;
    const objects = new Map();
    const walk = v =>
    {
        if(v === null || typeof v !== "object") return v;
        if("$u" in v) return undefined;
        if("$n" in v) return v.$n === "-0" ? -0 : Number(v.$n);
        if("$g" in v) return BigInt(v.$g);
        if("$t" in v)
        {
            const bytes = buffers[v.$b];
            const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            return v.$t === "ArrayBuffer" ? copy : new TYPED[v.$t](copy);
        }
        if("$r" in v) return objects.get(v.$r);
        if("$a" in v)
        {
            const array = [];
            objects.set(v.$i, array);
            for(const x of v.$a) array.push(walk(x));
            return array;
        }
        if("$m" in v)
        {
            const map = new Map();
            objects.set(v.$i, map);
            for(const [k, x] of v.$m) map.set(walk(k), walk(x));
            return map;
        }
        if("$s" in v)
        {
            const set = new Set();
            objects.set(v.$i, set);
            for(const x of v.$s) set.add(walk(x));
            return set;
        }
        const object = Object.create(v.$c ? classes[v.$c] : Object.prototype);
        objects.set(v.$i, object);
        for(const [key, x] of Object.entries(v.$o)) object[key] = walk(x);
        return object;
    };
    return walk(JSON.parse(json));
}

/**
 * What of a shadow's objects a snapshot leaves out: the GPU's part (the
 * page's), the compiled shaders and linked programs (compiled again)
 * @param {string} key
 * @param {!Object} owner
 * @return {boolean}
 */
export function shadow_skip(key, owner)
{
    // (a program glslang linked keeps its result where nothing can link it
    // again: on the page; the CPU side links it again, as the rest)
    return key === "gpu" || owner.kind === "shader" && key === "compiled" ||
        owner.kind === "program" && key === "info" && !(owner.link && owner.link.glslang && owner.keep_info);
}

/**
 * The shaders compiled and the programs linked again from their sources
 * (after unpack)
 * @param {!Map<*, {objects: !Map<number, !Object>}>} groups the shadow's share groups
 */
export function relink(groups, shadow)
{
    const cache = new Map();
    const compiled = (source, stage) =>
    {
        const key = stage + "\n" + source;
        if(!cache.has(key)) cache.set(key, compile_shader(source, stage));
        return cache.get(key);
    };
    for(const group of groups.values())
    {
        for(const object of group.objects.values())
        {
            if(object.kind === "shader")
            {
                object.compiled = object.compiled_source === null || object.compiled_source === undefined ? null :
                    shadow ? shadow.compile(object.compiled_source, object.type, !!group.glslang, !!group.es2) :
                    compiled(object.compiled_source, object.type === 0x8B31 ? "vertex" : "fragment");
            }
            else if(object.kind === "program" && object.link && object.link.glslang)
            {
                // (glslang's: linked again on the CPU side as it was linked, not as the program is now; the page kept its result)
                if(object.info) continue;
                const link = object.link;
                const shaders = link.shaders.map(([type, source]) => ({ type, compiled_source: source,
                    compiled: shadow.compile(source, type, true, !!group.es2) }));
                object.info = shadow.link({ bindings: link.bindings, separable: !!link.separable, tf_request: link.tf || null }, shaders, !!group.es2);
            }
            else if(object.kind === "program")
            {
                const link = object.link;
                object.info = link ? link_program(link.vs === null ? null : compiled(link.vs, "vertex"),
                    link.fs === null ? null : compiled(link.fs, "fragment"), new Map(link.bindings)) : null;
            }
        }
    }
}
