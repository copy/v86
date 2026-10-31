// Shared packed client-array decoding for the CPU state machine and renderer.
(function(global) {
    "use strict";
    const protocol = global.GLProtocol || require("./gl_protocol.js");
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    function parseArrayBlocks(bytes, view, offset, end, count) {
        const blocks = [];
        const R = protocol.F.CLIENT_ARRAY_BLOCK, header = protocol.RECORDS.CLIENT_ARRAY_BLOCK.size;
        let at = offset;
        for (let i = 0; i < count; ++i) {
            if (at + header > end) return null;
            const enabled = view.getUint32(at + R.enabled, true) !== 0;
            const size = view.getInt32(at + R.size, true);
            const type = view.getUint32(at + R.type, true);
            const stride = view.getInt32(at + R.stride, true);
            const dataSize = view.getUint32(at + R.data_size, true);
            at += header;
            if (at + dataSize > end) return null;
            blocks.push({
                enabled, size: enabled ? size : 0, type: enabled ? type : 0,
                stride: enabled ? stride : 0,
                data: enabled && dataSize ?
                    bytes.subarray(at, at + dataSize) : null,
            });
            at += dataSize;
        }
        return { blocks, offset: at };
    }

    function parseGenericBlocks(bytes, view, offset, end, count) {
        const blocks = [];
        const R = protocol.F.GENERIC_ATTRIB_BLOCK, header = protocol.RECORDS.GENERIC_ATTRIB_BLOCK.size;
        let at = offset;
        for (let i = 0; i < count; ++i) {
            if (at + header > end) return null;
            const index = view.getUint32(at + R.index, true);
            const normalized = view.getUint32(at + R.normalized, true) !== 0;
            const enabled = view.getUint32(at + R.enabled, true) !== 0;
            const size = view.getInt32(at + R.size, true);
            const type = view.getUint32(at + R.type, true);
            const stride = view.getInt32(at + R.stride, true);
            const dataSize = view.getUint32(at + R.data_size, true);
            at += header;
            if (at + dataSize > end) return null;
            blocks.push({
                index, normalized, enabled, size, type, stride,
                data: enabled && dataSize ?
                    bytes.subarray(at, at + dataSize) : null,
            });
            at += dataSize;
        }
        return { blocks, offset: at };
    }

    function componentBytes(type) {
        switch (type) {
        case GL.BYTE: case GL.UNSIGNED_BYTE: return 1;
        case GL.SHORT: case GL.UNSIGNED_SHORT: case GL.HALF_FLOAT: return 2;
        case GL.INT: case GL.UNSIGNED_INT: case GL.FLOAT: return 4;
        case GL.DOUBLE: return 8;
        default: return 0;
        }
    }

    function readComponent(view, at, type, normalized) {
        switch (type) {
        case GL.FLOAT: return view.getFloat32(at, true);
        case GL.DOUBLE: return view.getFloat64(at, true);
        case GL.BYTE: {
            const v = view.getInt8(at);
            return normalized ? (2 * v + 1) / 255 : v;
        }
        case GL.UNSIGNED_BYTE: {
            const v = view.getUint8(at);
            return normalized ? v / 255 : v;
        }
        case GL.SHORT: {
            const v = view.getInt16(at, true);
            return normalized ? (2 * v + 1) / 65535 : v;
        }
        case GL.UNSIGNED_SHORT: {
            const v = view.getUint16(at, true);
            return normalized ? v / 65535 : v;
        }
        case GL.INT: {
            const v = view.getInt32(at, true);
            return normalized ? (2 * v + 1) / 4294967295 : v;
        }
        case GL.UNSIGNED_INT: {
            const v = view.getUint32(at, true);
            return normalized ? v / 4294967295 : v;
        }
        default: return 0;
        }
    }
    function decode(name, bytes, view, offset, size) {
        const indexed = name.includes("ELEMENTS"), gl2 = name.endsWith("GL2"), baseName = indexed ? "DRAW_ELEMENTS" : "DRAW_ARRAYS";
        const base = protocol.RECORDS[baseName], end = offset + size;
        if (size < base.size) throw new Error("packed draw header is short");
        const r = protocol.decodeRecord(baseName, view, offset), magic = offset + base.size + 4 <= end ? view.getUint32(offset + base.size, true) : 0;
        let indexAt, count = 4, units = 0, secondary = false, fog = false, generic = 0;
        if (magic === protocol.C.CLIENT_ARRAY_MT_MAGIC) {
            const mt = "PACKED_" + baseName + (gl2 ? "_GL2_MT" : "_MT");
            if (size < protocol.RECORDS[mt].size) throw new Error("packed multitexture header is short");
            const fields = protocol.decodeRecord(mt, view, offset);
            secondary = !!(fields.tex_unit_count & protocol.C.CLIENT_ARRAY_MT_SECONDARY_COLOR_BIT);
            fog = !!(fields.tex_unit_count & protocol.C.CLIENT_ARRAY_MT_FOG_COORD_BIT);
            units = fields.tex_unit_count & ~(protocol.C.CLIENT_ARRAY_MT_SECONDARY_COLOR_BIT | protocol.C.CLIENT_ARRAY_MT_FOG_COORD_BIT);
            if (units > 8 || fields.generic_attrib_count > 16) throw new Error("packed array count exceeds the profile");
            generic = gl2 ? fields.generic_attrib_count : 0; indexAt = offset + protocol.RECORDS[mt].size;
            count = 3 + units + +secondary + +fog;
        } else indexAt = offset + 16;
        const dataSize = indexed ? r.index_data_size : 0;
        if (indexed && indexAt + dataSize > end) throw new Error("index data is truncated");
        const at = indexed ? indexAt + dataSize : magic === protocol.C.CLIENT_ARRAY_MT_MAGIC ? indexAt : offset + 8;
        const parsed = parseArrayBlocks(bytes, view, at, end, count);
        if (!parsed) throw new Error("client array blocks are truncated");
        const order = magic === protocol.C.CLIENT_ARRAY_MT_MAGIC ? ["vertex", "color", "normal",
            ...Array.from({ length: units }, (_, i) => "texCoord" + i), ...(secondary ? ["secondaryColor"] : []), ...(fog ? ["fogCoord"] : [])] :
            ["vertex", "color", "texCoord0", "normal"];
        const arrays = Object.fromEntries(order.flatMap((key, i) => parsed.blocks[i]?.enabled ? [[key, parsed.blocks[i]]] : []));
        if (generic) {
            const result = parseGenericBlocks(bytes, view, parsed.offset, end, generic);
            if (!result) throw new Error("generic attribute blocks are truncated");
            for (const block of result.blocks) if (block.enabled) arrays["generic" + block.index] = block;
        }
        return { mode: r.mode, count: r.count, arrays, indices: indexed ? { type: r.type, data: bytes.subarray(indexAt, indexAt + dataSize) } : null };
    }
    function attribute(block, index, components, normalized = false) {
        if (!block?.data) return null;
        const bytes = componentBytes(block.type), size = block.size, stride = block.stride || bytes * size;
        const start = index * stride;
        if (!bytes || size < 1 || size > 4 || start < 0 || start + size * bytes > block.data.length) throw new Error("array element is outside its captured data");
        const view = new DataView(block.data.buffer, block.data.byteOffset, block.data.length);
        return Array.from({ length: components }, (_, i) => i < size ? readComponent(view, start + i * bytes, block.type, block.normalized ?? normalized) : i === 3 ? 1 : 0);
    }
    const immediateAttributes = new Set(("COLOR4F NORMAL3F TEX_COORD2F TEX_COORD4F MULTI_TEX_COORD4F " +
        "SECONDARY_COLOR3F FOG_COORDF EDGE_FLAG VERTEX_ATTRIB4F INDEX_STATE").split(" "));
    function parseImmediateBlock(bytes, view, offset, size) {
        const header = protocol.RECORDS.IMMEDIATE_VERTEX_BLOCK.size, end = offset + size, runs = [];
        if (size < header || size > protocol.C.V86GL_IMMEDIATE_BLOCK_BYTES) return null;
        const r = protocol.decodeRecord("IMMEDIATE_VERTEX_BLOCK", view, offset);
        if (r.data_size !== size - header || r.run_count > r.data_size / 8) return null;
        let at = offset + header;
        for (let i = 0; i < r.run_count; ++i) {
            if (at + 8 > end) return null;
            const attributes = view.getUint32(at, true), count = view.getUint32(at + 4, true);at += 8;
            const vertices = at + attributes, next = vertices + count * 16;
            if (next > end) return null;
            let p = at;
            while (p < vertices) {
                if (p + 4 > vertices) return null;
                const fn = view.getUint16(p, true), length = view.getUint16(p + 2, true), name = protocol.NAME_BY_OPCODE[fn];p += 4;
                const expected = protocol.SIGNATURES[name] ? protocol.payloadBytes(protocol.SIGNATURES[name][1]) : protocol.RECORDS[name]?.size;
                if (!immediateAttributes.has(name) || length !== expected || p + length > vertices ||
                    name === "VERTEX_ATTRIB4F" && view.getUint32(p, true) === 0 || name === "INDEX_STATE" && view.getUint32(p, true) !== 0) return null;
                p += length;
            }
            runs.push({ attributes: bytes.subarray(at, vertices), positions: bytes.subarray(vertices, next), count });at = next;
        }
        return at === end ? runs : null;
    }
    function immediateRecord(runs) {
        const size = 8 + runs.reduce((sum, run) => sum + 8 + run.attributes.length + run.positions.length, 0), extended = size >= 0xFFFF,
            bytes = new Uint8Array(size + (extended ? 8 : 4)), view = new DataView(bytes.buffer), base = bytes.length - size;
        view.setUint16(0, protocol.GLFN.IMMEDIATE_VERTEX_BLOCK, true);view.setUint16(2, extended ? 0xFFFF : size, true);if (extended) view.setUint32(4, size, true);
        view.setUint32(base, runs.length, true);view.setUint32(base + 4, size - 8, true);let at = base + 8;
        for (const run of runs) {
            view.setUint32(at, run.attributes.length, true);view.setUint32(at + 4, run.positions.length / 16, true);at += 8;
            bytes.set(run.attributes, at);at += run.attributes.length;bytes.set(run.positions, at);at += run.positions.length;
        }
        return bytes;
    }
    const api = { parseArrayBlocks, parseGenericBlocks, componentBytes, readComponent, decode, attribute, parseImmediateBlock, immediateRecord };
    global.GLClientArrays = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
