// Final render-command validation lives beside the CPU state, so errors
// never depend on the page processing a later batch (plan C3/C6/C7).
(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js"), { GL } = global.GLWGConstants || require("./gl_constants.js"),
        { GLShadow } = global.V86GLShadow || require("./gl_shadow.js"), state = global.V86GLShadowState || require("./gl_shadow_state.js"),
        pixels = global.V86GLShadowTextures || require("./gl_shadow_textures.js"), client = global.GLClientArrays || require("./gl_client_arrays.js"),
        { enabledArrays } = global.V86GLShadowArrays || require("./gl_shadow_arrays.js");
    if (typeof require === "function") { require("./gl_shadow_objects.js"); require("./gl_shadow_arrays.js"); require("./gl_shadow_lists.js"); }
    const primitive = mode => mode <= GL.POLYGON, indexBytes = type => type === GL.UNSIGNED_BYTE ? 1 : type === GL.UNSIGNED_SHORT ? 2 : type === GL.UNSIGNED_INT ? 4 : 0;
    const bits = GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT;
    function attachment(s, target, kind) {
        const c = s.current, name = target === GL.READ_FRAMEBUFFER ? c.readFramebuffer : c.drawFramebuffer;
        if (!name) return { internalFormat: GL.DEPTH24_STENCIL8, componentBits: [0, 0, 0, 0, 24, 8] };
        const fbo = s.boundFramebuffer(target);
        return fbo?.[kind] ? s.attachedImage(fbo[kind]) : null;
    }
    function attachmentFormat(image, kind) {
        const format = image.internalFormat;
        if (kind === "stencil") return String(image.componentBits?.[5] || 8);
        const bits = image.componentBits?.[4] || (format === GL.DEPTH_COMPONENT16 ? 16 : format === GL.DEPTH24_STENCIL8 ? 24 : 32);
        return bits + ":" + (format === GL.DEPTH_COMPONENT32F || format === 0x8CAD ? "float" : "fixed");
    }
    function sourceError(s, format) {
        if (format === GL.DEPTH_COMPONENT || format === GL.STENCIL_INDEX)
            return attachment(s, GL.READ_FRAMEBUFFER, format === GL.DEPTH_COMPONENT ? "depth" : "stencil") ? 0 : GL.INVALID_OPERATION;
        return s.current.readBuffer === GL.NONE ? GL.INVALID_OPERATION : 0;
    }
    state.rule("CLEAR", (c, [mask]) => mask & ~(bits | GL.ACCUM_BUFFER_BIT) ? GL.INVALID_VALUE : 0);
    state.rule("COPY_PIXELS", (c, [x, y, width, height, type], s) => width < 0 || height < 0 ? GL.INVALID_VALUE :
        ![GL.COLOR, GL.DEPTH, GL.STENCIL].includes(type) ? GL.INVALID_ENUM :
            sourceError(s, type === GL.DEPTH ? GL.DEPTH_COMPONENT : type === GL.STENCIL ? GL.STENCIL_INDEX : GL.RGBA) ||
            (type === GL.STENCIL && !attachment(s, GL.DRAW_FRAMEBUFFER, "stencil") ? GL.INVALID_OPERATION : 0));
    state.rule("ACCUM", (c, [op], s) => op < 0x100 || op > 0x104 ? GL.INVALID_ENUM :
        c.drawFramebuffer !== c.readFramebuffer || !s.stateValue(GL.ACCUM_RED_BITS)?.[0][0] ? GL.INVALID_OPERATION : 0);
    state.rule("BLIT_FRAMEBUFFER", (c, a, s) => {
        if (a[8] & ~bits) return GL.INVALID_VALUE;
        if (![GL.NEAREST, GL.LINEAR].includes(a[9])) return GL.INVALID_ENUM;
        if (a[8] & (GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT) && a[9] !== GL.NEAREST) return GL.INVALID_OPERATION;
        for (const [bit, kind] of [[GL.DEPTH_BUFFER_BIT, "depth"], [GL.STENCIL_BUFFER_BIT, "stencil"]]) if (a[8] & bit) {
            const read = attachment(s, GL.READ_FRAMEBUFFER, kind), draw = attachment(s, GL.DRAW_FRAMEBUFFER, kind);
            // EXT_framebuffer_blit ignores an absent buffer. Two present
            // buffers must have exactly matching GL storage formats.
            if (read && draw && attachmentFormat(read, kind) !== attachmentFormat(draw, kind)) return GL.INVALID_OPERATION;
        }
        return 0;
    });
    const packedNames = ["DRAW_ARRAYS", "DRAW_ELEMENTS", "DRAW_ARRAYS_GL2", "DRAW_ELEMENTS_GL2"],
        directNames = ["DRAW_ARRAYS_DIRECT", "DRAW_ELEMENTS_DIRECT", "DRAW_RANGE_ELEMENTS_DIRECT"],
        multiNames = ["MULTI_DRAW_ARRAYS_DIRECT", "MULTI_DRAW_ELEMENTS_DIRECT"];
    function indexError(c, type, offset, count) {
        const bytes = indexBytes(type); if (!bytes) return GL.INVALID_ENUM;
        const buffer = c.group.bufferObjects.get(c.bufferBindings.get(GL.ELEMENT_ARRAY_BUFFER));
        if (!count) return buffer?.mapped ? GL.INVALID_OPERATION : 0;
        return !buffer || buffer.mapped || offset + count * bytes > (buffer.data?.length || 0) ? GL.INVALID_OPERATION : 0;
    }
    function direct(c, name, r) {
        if (!primitive(r.mode)) return GL.INVALID_ENUM;
        if (r.count < 0 || name === "DRAW_RANGE_ELEMENTS_DIRECT" && r.end < r.start) return GL.INVALID_VALUE;
        const indexed = name.includes("ELEMENTS"), error = indexed && indexError(c, r.type, r.offset, r.count);
        if (error || !r.count) return error || 0;
        let first = r.first, last = first + r.count - 1;
        if (indexed) {
            const data = c.group.bufferObjects.get(c.bufferBindings.get(GL.ELEMENT_ARRAY_BUFFER)).data,
                indices = new DataView(data.buffer, data.byteOffset + r.offset, data.length - r.offset), step = indexBytes(r.type);
            first = 0xFFFFFFFF; last = 0;
            for (let i = 0; i < r.count; ++i) {
                const value = step === 1 ? indices.getUint8(i) : step === 2 ? indices.getUint16(i * 2, true) : indices.getUint32(i * 4, true);
                first = Math.min(first, value); last = Math.max(last, value);
            }
        }
        for (const array of enabledArrays(c)) {
            const buffer = c.group.bufferObjects.get(array.bufferId), bytes = client.componentBytes(array.type),
                span = array.pointer + last * (array.stride || array.size * bytes) + array.size * bytes;
            if (!buffer || first < 0 || !Number.isSafeInteger(span) || span > buffer.size) return GL.INVALID_OPERATION;
        }
        return 0;
    }
    for (const name of directNames) GLShadow.rules({ [P.GLFN[name]]: (s, bytes, view, offset, size) => {
        if (s.current.state.begin) return GL.INVALID_OPERATION;
        const r = name === "DRAW_ARRAYS_DIRECT" ? Object.fromEntries(["mode", "first", "count"].map((key, i) => [key, s.args(name, view, offset, size)[i]])) : P.decodeRecord(name, view, offset);
        return direct(s.current, name, r);
    } });
    for (const name of multiNames) GLShadow.rules({ [P.GLFN[name]]: (s, bytes, view, offset, size) => {
        if (s.current.state.begin) return GL.INVALID_OPERATION;
        const r = P.decodeRecord(name, view, offset), indexed = name.includes("ELEMENTS"), header = P.RECORDS[name].size,
            entry = indexed ? "MULTI_DRAW_ELEMENTS_ENTRY" : "MULTI_DRAW_ARRAYS_ENTRY", stride = P.RECORDS[entry].size;
        if (!primitive(r.mode) || indexed && !indexBytes(r.type)) return GL.INVALID_ENUM;
        if (r.primcount < 0 || header + r.primcount * stride > size) return GL.INVALID_VALUE;
        for (let i = 0; i < r.primcount; ++i) {
            const value = P.decodeRecord(entry, view, offset + header + i * stride);
            if (!value.count) continue;
            const error = direct(s.current, indexed ? "DRAW_ELEMENTS_DIRECT" : "DRAW_ARRAYS_DIRECT", { ...r, ...value });
            if (error) return error;
        }
        return 0;
    } });
    function packed(name, bytes, view, offset, size) {
        const header = P.decodeRecord(name.includes("ELEMENTS") ? "DRAW_ELEMENTS" : "DRAW_ARRAYS", view, offset);
        if (!primitive(header.mode)) return GL.INVALID_ENUM;
        if (header.count < 0) return GL.INVALID_VALUE;
        if (name.includes("ELEMENTS") && !indexBytes(header.type)) return GL.INVALID_ENUM;
        if (!header.count) return 0;
        let packet;
        try { packet = client.decode(name, bytes, view, offset, size); } catch (error) { return GL.INVALID_OPERATION; }
        let max = packet.count - 1;
        if (packet.indices) {
            const step = indexBytes(packet.indices.type), data = packet.indices.data;
            if (packet.count * step > data.length) return GL.INVALID_OPERATION;
            const indices = new DataView(data.buffer, data.byteOffset, data.length); max = 0;
            for (let i = 0; i < packet.count; ++i) max = Math.max(max, step === 1 ? indices.getUint8(i) : step === 2 ? indices.getUint16(i * 2, true) : indices.getUint32(i * 4, true));
        }
        const validTypes = [GL.BYTE, GL.UNSIGNED_BYTE, GL.SHORT, GL.UNSIGNED_SHORT, GL.INT, GL.UNSIGNED_INT, GL.FLOAT, GL.DOUBLE];
        for (const [key, array] of Object.entries(packet.arrays)) {
            if (key.startsWith("generic") && +key.slice(7) >= 16 || array.size < 1 || array.size > 4 || array.stride < 0) return GL.INVALID_VALUE;
            if (!validTypes.includes(array.type)) return GL.INVALID_ENUM;
            const bytes = client.componentBytes(array.type), span = max * (array.stride || bytes * array.size) + bytes * array.size;
            if (!array.data || span > array.data.length) return GL.INVALID_OPERATION;
        }
        return 0;
    }
    for (const name of packedNames) GLShadow.rules({ [P.GLFN[name]]: (s, bytes, view, offset, size) =>
        s.current.state.begin ? GL.INVALID_OPERATION : packed(name, bytes, view, offset, size) });
    for (const name of ["READ_PIXELS", "DRAW_PIXELS"]) GLShadow.rules({ [P.GLFN[name]]: (s, bytes, view, offset, size) => {
        const r = P.decodeRecord(name, view, offset), read = name === "READ_PIXELS", c = s.current;
        const fail = error => { if (read) view.setUint32(offset + P.F[name].status, P.C.V86GL_SYNC_QUERY_STATUS_FAILED, true); return error; };
        if (c.state.begin) return fail(GL.INVALID_OPERATION);
        if (r.width < 0 || r.height < 0) return fail(GL.INVALID_VALUE);
        const error = pixels.pixelError(r.format, r.type, true); if (error) return fail(error);
        if (read && r.format === GL.COLOR_INDEX) return fail(GL.INVALID_OPERATION);
        if (read) { const error = sourceError(s, r.format); if (error) return fail(error); }
        if (!read && r.format === GL.STENCIL_INDEX && !attachment(s, GL.DRAW_FRAMEBUFFER, "stencil")) return fail(GL.INVALID_OPERATION);
        const span = pixels.uploadSpan(c, { ...r, format: r.format === GL.STENCIL_INDEX ? GL.COLOR_INDEX : r.format }, 2, read);
        if (!Number.isSafeInteger(span) || span > r.data_size || P.RECORDS[name].size + r.data_size > size) return fail(GL.INVALID_OPERATION);
        return 0;
    } });
    GLShadow.part({
        routeRecord(s, fn, bytes, view, offset, size) {
            const name = P.NAME_BY_OPCODE[fn];
            if (name?.startsWith("QUERY_") && name !== "QUERY_ERROR") {
                const encodingRead = name === "QUERY_BUFFER_DATA" && [GL.VERTEX_ARRAY,GL.NORMAL_ARRAY,GL.COLOR_ARRAY,GL.INDEX_ARRAY,
                    GL.EDGE_FLAG_ARRAY,GL.SECONDARY_COLOR_ARRAY_EXT,GL.FOG_COORDINATE_ARRAY_EXT,GL.TEXTURE_COORD_ARRAY,GL.VERTEX_ATTRIB_ARRAY_POINTER]
                    .includes(view.getUint32(offset + P.F.QUERY_BUFFER_DATA.target,true));
                let error = s.current?.state.begin && !encodingRead || !s.current && !["QUERY_INTEGER", "QUERY_GL_STRING"].includes(name) ? GL.INVALID_OPERATION : 0;
                if (["QUERY_OBJECT_IV", "QUERY_OBJECT_LOG", "QUERY_OBJECT_BATCH"].includes(name)) {
                    const kind = view.getUint32(offset + P.F[name].object_kind, true), kinds = name === "QUERY_OBJECT_BATCH" ? [P.C.V86GL_OBJECT_KIND_QUERY] :
                        name === "QUERY_OBJECT_LOG" ? [P.C.V86GL_OBJECT_KIND_SHADER, P.C.V86GL_OBJECT_KIND_PROGRAM, P.C.V86GL_TEXT_SHADER_SOURCE] : [P.C.V86GL_OBJECT_KIND_SHADER, P.C.V86GL_OBJECT_KIND_PROGRAM, P.C.V86GL_OBJECT_KIND_QUERY];
                    if (!kinds.includes(kind)) error ||= GL.INVALID_ENUM;
                }
                const selector = { QUERY_ACTIVE: "active_kind", QUERY_LOCATION: "location_kind", QUERY_UNIFORM: "value_kind" }[name];
                if (selector && ![1, 2].includes(view.getUint32(offset + P.F[name][selector], true))) error ||= GL.INVALID_ENUM;
                if (P.F[name].data_size !== undefined) {
                    const capacity = view.getUint32(offset + P.F[name].data_size, true);
                    if (P.RECORDS[name].size + capacity > size || P.F[name].buf_size !== undefined && view.getUint32(offset + P.F[name].buf_size, true) > capacity) error ||= GL.INVALID_VALUE;
                }
                if (error) {
                    if (P.F[name].error !== undefined) view.setUint32(offset + P.F[name].error, error, true);
                    s.answered(name, view, offset, P.C.V86GL_SYNC_QUERY_STATUS_FAILED); return { error };
                }
            }
            if (!s.current) return;
            if (name === "BLIT_FRAMEBUFFER" && !s.args(name, view, offset, size)[8]) {
                const error = s.dispatch(fn, bytes, view, offset, size); return error ? { error } : { commands: [] };
            }
            if (name !== "READ_PIXELS" && name !== "DRAW_PIXELS" && !packedNames.includes(name)) return;
            const r = P.decodeRecord(packedNames.includes(name) ? name.includes("ELEMENTS") ? "DRAW_ELEMENTS" : "DRAW_ARRAYS" : name, view, offset);
            if (packedNames.includes(name) ? r.count : r.width && r.height) return;
            const error = s.dispatch(fn, bytes, view, offset, size); if (error) return { error };
            if (name === "READ_PIXELS") s.answered(name, view, offset, P.C.V86GL_SYNC_QUERY_STATUS_OK);
            return { commands: [] };
        },
    });
})(typeof globalThis !== "undefined" ? globalThis : this);
