// Builds OpenGL command records the way openglproxy/opengl32_proxy.c does.
//
// The tests need to speak the guest's wire format exactly, so this encodes
// from the same signature table gl_executor.js decodes with. Anything the
// table cannot describe -- textures, draws, shader source -- gets an explicit
// builder here, and those are precisely the records worth hand-checking.

"use strict";

const wire = typeof require === "function" ?
    require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js") : globalThis.GLProtocol;
const constants = typeof require === "function" ?
    require("../../src/browser/glbridge/gl-webgpu/gl_constants.js") : globalThis.GLWGConstants;

const GL = constants.GL;
const GLFN = constants.GLFN;

class GLStream {
    constructor() {
        this.buffer = new Uint8Array(4096);
        this.length = 0;
    }

    reserve(extra) {
        if (this.length + extra <= this.buffer.byteLength) return;
        let size = this.buffer.byteLength * 2;
        while (size < this.length + extra) size *= 2;
        const grown = new Uint8Array(size);
        grown.set(this.buffer.subarray(0, this.length));
        this.buffer = grown;
    }

    /*
     * Returns a view of the payload *inside* the assembled stream, because a
     * synchronous query is answered by writing into the record the guest
     * submitted. A test holding a detached copy would never see the answer,
     * which is the same mistake a bridge that copies the batch would make.
     */
    record(opcode, payloadBytes) {
        const payload = payloadBytes || new Uint8Array(0);
        const extended = payload.byteLength > 0xFFFE;
        this.reserve((extended ? 8 : 4) + payload.byteLength);
        const view = new DataView(this.buffer.buffer);
        view.setUint16(this.length, opcode, true);
        if (extended) {
            view.setUint16(this.length + 2, 0xFFFF, true);
            view.setUint32(this.length + 4, payload.byteLength, true);
            this.length += 8;
        } else {
            view.setUint16(this.length + 2, payload.byteLength, true);
            this.length += 4;
        }
        const at = this.length;
        this.buffer.set(payload, at);
        this.length += payload.byteLength;
        this.lastPayload = { offset: at, length: payload.byteLength };
        return this;
    }

    /* The payload of the record just appended, as a live view. */
    payloadView() {
        const { offset, length } = this.lastPayload;
        const stream = this;
        return {
            get bytes() {
                return stream.buffer.subarray(offset, offset + length);
            },
            get view() {
                return new DataView(stream.buffer.buffer, offset, length);
            },
        };
    }

    /* Encodes from the declarative signature, which is what keeps the tests
     * honest about the layout the executor expects. */
    call(name, ...args) {
        const signature = wire.SIGNATURES[name];
        if (!signature) throw new Error("no signature for " + name);
        const types = signature[1];
        const payload = new Uint8Array(wire.payloadBytes(types));
        const view = new DataView(payload.buffer);
        let offset = 0;
        for (let i = 0; i < types.length; ++i) {
            const value = args[i] === undefined ? 0 : args[i];
            switch (types[i]) {
            case "i": view.setInt32(offset, value | 0, true); offset += 4; break;
            case "u": view.setUint32(offset, value >>> 0, true); offset += 4; break;
            case "f": view.setFloat32(offset, value, true); offset += 4; break;
            default: view.setFloat64(offset, value, true); offset += 8; break;
            }
        }
        return this.record(GLFN[name], payload);
    }

    makeCurrent(hwnd, x, y, width, height, contextId, shareGroup, format, capsProfile) {
        const extended = contextId !== undefined || shareGroup !== undefined || format !== undefined || capsProfile !== undefined;
        const payload = new Uint8Array(capsProfile !== undefined ? 36 : format !== undefined ? 32 : extended ? 28 : 20);
        const view = new DataView(payload.buffer);
        view.setUint32(0, hwnd, true);
        view.setInt32(4, x, true);
        view.setInt32(8, y, true);
        view.setUint32(12, width, true);
        view.setUint32(16, height, true);
        if (extended) {
            view.setUint32(20, (contextId || 0) >>> 0, true);
            view.setUint32(24, (shareGroup || 0) >>> 0, true);
        }
        if (format !== undefined) view.setUint32(28, format >>> 0, true);
        if (capsProfile !== undefined) view.setUint32(32, capsProfile >>> 0, true);
        return this.record(constants.CTRL.MAKE_CURRENT, payload);
    }

    swapWindow(hwnd, interval = 1) {
        const payload = new Uint8Array(wire.RECORDS.SWAP_WINDOW.size), view = new DataView(payload.buffer);
        view.setUint32(wire.F.SWAP_WINDOW.hwnd, hwnd, true);
        view.setUint32(wire.F.SWAP_WINDOW.interval, interval, true);
        this.record(wire.CTRL.SWAP_WINDOW, payload);
        return this.payloadView();
    }

    // V86GL_CTRL_WINDOW_STATE: flags as D9WGWindowState's; `rects` (client
    // coordinates, [left, top, right, bottom]) sets the region flag
    windowState(hwnd, flags, x, y, width, height, rects) {
        const payload = new Uint8Array(24 + (rects ? 4 + rects.length * 16 : 0));
        const view = new DataView(payload.buffer);
        view.setUint32(0, hwnd, true);
        view.setUint32(4, (flags | (rects ? 1 << 7 : 0)) >>> 0, true);
        view.setInt32(8, x, true);
        view.setInt32(12, y, true);
        view.setUint32(16, width, true);
        view.setUint32(20, height, true);
        if (rects) {
            view.setUint32(24, rects.length, true);
            rects.forEach((rect, i) => rect.forEach((v, j) => view.setInt32(28 + i * 16 + j * 4, v, true)));
        }
        return this.record(constants.CTRL.WINDOW_STATE, payload);
    }

    names(opcode, list) {
        const payload = new Uint8Array(4 + list.length * 4);
        const view = new DataView(payload.buffer);
        view.setUint32(0, list.length, true);
        list.forEach((name, i) => view.setUint32(4 + i * 4, name, true));
        return this.record(opcode, payload);
    }

    texImage2D(target, level, internalFormat, width, height, format, type, data) {
        const bytes = data || new Uint8Array(0);
        const payload = new Uint8Array(36 + bytes.byteLength);
        const view = new DataView(payload.buffer);
        let at = 0;
        for (const value of [target, level, internalFormat, width, height, 0,
                format, type, bytes.byteLength]) {
            view.setUint32(at, value >>> 0, true);
            at += 4;
        }
        payload.set(bytes, at);
        return this.record(GLFN.TEX_IMAGE_2D, payload.subarray(0, at + bytes.byteLength));
    }

    compressedTexImage2D(target, level, internalFormat, width, height, data,
            border) {
        const bytes = data || new Uint8Array(0);
        // This is the guest proxy's fixed CompressedTexImage wire struct.  It
        // retains a depth word for 2D uploads rather than using a shorter
        // dimension-specific record.
        const payload = new Uint8Array(32 + bytes.byteLength);
        const view = new DataView(payload.buffer);
        view.setUint32(0, target >>> 0, true);
        view.setInt32(4, level | 0, true);
        view.setUint32(8, internalFormat >>> 0, true);
        view.setInt32(12, width | 0, true);
        view.setInt32(16, height | 0, true);
        view.setInt32(20, 1, true);
        view.setInt32(24, (border || 0) | 0, true);
        view.setUint32(28, bytes.byteLength >>> 0, true);
        payload.set(bytes, 32);
        return this.record(GLFN.COMPRESSED_TEX_IMAGE_2D, payload);
    }

    compressedTexSubImage2D(target, level, x, y, width, height, format, data) {
        const bytes = data || new Uint8Array(0);
        // The subimage command likewise always includes z and depth.
        const payload = new Uint8Array(40 + bytes.byteLength);
        const view = new DataView(payload.buffer);
        view.setUint32(0, target >>> 0, true);
        view.setInt32(4, level | 0, true);
        view.setInt32(8, x | 0, true);
        view.setInt32(12, y | 0, true);
        view.setInt32(16, 0, true);
        view.setInt32(20, width | 0, true);
        view.setInt32(24, height | 0, true);
        view.setInt32(28, 1, true);
        view.setUint32(32, format >>> 0, true);
        view.setUint32(36, bytes.byteLength >>> 0, true);
        payload.set(bytes, 40);
        return this.record(GLFN.COMPRESSED_TEX_SUB_IMAGE_2D, payload);
    }

    texSubImage2D(target, level, x, y, width, height, format, type, data) {
        const header = wire.encodeRecord("TEX_SUB_IMAGE_2D", { target, level, xoffset: x, yoffset: y,
            width, height, format, type, data_size: data.byteLength });
        const payload = new Uint8Array(header.byteLength + data.byteLength);
        payload.set(header);
        payload.set(data, header.byteLength);
        return this.record(GLFN.TEX_SUB_IMAGE_2D, payload);
    }

    drawPixels(width, height, format, type, data) {
        const bytes = data || new Uint8Array(0);
        const payload = new Uint8Array(20 + bytes.byteLength);
        const view = new DataView(payload.buffer);
        view.setInt32(0, width, true);
        view.setInt32(4, height, true);
        view.setUint32(8, format, true);
        view.setUint32(12, type, true);
        view.setUint32(16, bytes.byteLength, true);
        payload.set(bytes, 20);
        return this.record(GLFN.DRAW_PIXELS, payload);
    }

    bitmap(width, height, xorig, yorig, xmove, ymove, data) {
        const bytes = data || new Uint8Array(0);
        const payload = new Uint8Array(28 + bytes.byteLength);
        const view = new DataView(payload.buffer);
        view.setInt32(0, width, true);
        view.setInt32(4, height, true);
        view.setFloat32(8, xorig, true);
        view.setFloat32(12, yorig, true);
        view.setFloat32(16, xmove, true);
        view.setFloat32(20, ymove, true);
        view.setUint32(24, bytes.byteLength, true);
        payload.set(bytes, 28);
        return this.record(GLFN.BITMAP, payload);
    }

    /*
     * The packed client-array draw. Thirteen blocks in the guest's order --
     * vertex, colour, normal, eight texture coordinates, secondary colour, fog
     * coordinate -- behind the 'CAMT' header.
     */
    drawArrays(mode, count, arrays) {
        return this.packedDraw(mode, count, null, arrays, [], false);
    }

    drawElements(mode, indices, type, arrays) {
        return this.packedDraw(mode, indices, type, arrays, [], false);
    }

    drawArraysGL2(mode, count, arrays, generics) {
        return this.packedDraw(mode, count, null, arrays, generics || [], true);
    }

    drawElementsGL2(mode, indices, type, arrays, generics) {
        return this.packedDraw(mode, indices, type, arrays, generics || [], true);
    }

    packedDraw(mode, indicesOrCount, type, arrays, generics, gl2) {
        const indexed = type !== null;
        const indices = indexed ? new Uint8Array(indicesOrCount.buffer, indicesOrCount.byteOffset, indicesOrCount.byteLength) : null;
        const count = indexed ? indices.byteLength / (type === GL.UNSIGNED_INT ? 4 : type === GL.UNSIGNED_SHORT ? 2 : 1) : indicesOrCount;
        const name = (indexed ? "DRAW_ELEMENTS" : "DRAW_ARRAYS") + (gl2 ? "_GL2" : "");
        const header = wire.encodeRecord("PACKED_" + name + "_MT", {
            mode, count, type, index_data_size: indices ? indices.byteLength : 0,
            magic: wire.C.CLIENT_ARRAY_MT_MAGIC,
            tex_unit_count: (8 | wire.C.CLIENT_ARRAY_MT_SECONDARY_COLOR_BIT | wire.C.CLIENT_ARRAY_MT_FOG_COORD_BIT) >>> 0,
            client_active_texture: 0, generic_attrib_count: generics.length,
        });
        const chunks = [header];
        if (indices) chunks.push(indices);
        const order = ["vertex", "color", "normal", "texCoord0", "texCoord1", "texCoord2", "texCoord3",
            "texCoord4", "texCoord5", "texCoord6", "texCoord7", "secondaryColor", "fogCoord"];
        for (const block of order.map(name => arrays[name] || null)) {
            const data = block && block.data;
            chunks.push(wire.encodeRecord("CLIENT_ARRAY_BLOCK", {
                enabled: +!!block, size: block ? block.size : 0, type: block ? block.type : 0,
                stride: block ? block.stride || 0 : 0, data_size: data ? data.byteLength : 0,
            }));
            if (data) chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        }
        for (const block of generics) {
            chunks.push(wire.encodeRecord("GENERIC_ATTRIB_BLOCK", {
                index: block.index, normalized: +!!block.normalized, enabled: 1, size: block.size,
                type: block.type, stride: block.stride || 0, data_size: block.data ? block.data.byteLength : 0,
            }));
            if (block.data) chunks.push(new Uint8Array(block.data.buffer, block.data.byteOffset, block.data.byteLength));
        }
        const payload = new Uint8Array(chunks.reduce((sum, bytes) => sum + bytes.byteLength, 0));
        let at = 0;
        for (const bytes of chunks) { payload.set(bytes, at); at += bytes.byteLength; }
        return this.record(GLFN[name], payload);
    }
    shaderSource(shader, source) {
        const text = source;
        const payload = new Uint8Array(8 + text.length);
        const view = new DataView(payload.buffer);
        view.setUint32(0, shader, true);
        view.setUint32(4, text.length, true);
        for (let i = 0; i < text.length; ++i)
            payload[8 + i] = text.charCodeAt(i) & 0xff;
        return this.record(GLFN.SHADER_SOURCE, payload);
    }

    /* {target, size, usage, data_size} then the contents. */
    bufferData(target, byteCount, usage, data) {
        const bytes = data || new Uint8Array(0);
        const payload = new Uint8Array(16 + bytes.byteLength);
        const view = new DataView(payload.buffer);
        view.setUint32(0, target, true);
        view.setInt32(4, byteCount, true);
        view.setUint32(8, usage, true);
        view.setUint32(12, bytes.byteLength, true);
        payload.set(bytes, 16);
        return this.record(GLFN.BUFFER_DATA, payload);
    }

    /* The VBOPointerPayload the guest sends once the array lives in a buffer:
     * no data travels, only where in the bound buffer to read it. */
    pointerVBO(name, size, type, stride, offset) {
        const payload = new Uint8Array(16);
        const view = new DataView(payload.buffer);
        view.setInt32(0, size, true);
        view.setUint32(4, type, true);
        view.setInt32(8, stride, true);
        view.setUint32(12, offset, true);
        return this.record(GLFN[name], payload);
    }

    attribPointerVBO(index, size, type, normalized, stride, offset) {
        const payload = new Uint8Array(24);
        const view = new DataView(payload.buffer);
        view.setUint32(0, index, true);
        view.setInt32(4, size, true);
        view.setUint32(8, type, true);
        view.setUint32(12, normalized ? 1 : 0, true);
        view.setInt32(16, stride, true);
        view.setUint32(20, offset, true);
        return this.record(GLFN.VERTEX_ATTRIB_POINTER_VBO, payload);
    }

    drawElementsDirect(mode, count, type, offset, start, end) {
        const payload = new Uint8Array(24);
        const view = new DataView(payload.buffer);
        view.setUint32(0, mode, true);
        view.setUint32(4, start || 0, true);
        view.setUint32(8, end === undefined ? count : end, true);
        view.setInt32(12, count, true);
        view.setUint32(16, type, true);
        view.setUint32(20, offset, true);
        return this.record(GLFN.DRAW_ELEMENTS_DIRECT, payload);
    }

    /* {target, format, length, reserved} then the assembly text. */
    programStringARB(target, source) {
        const payload = new Uint8Array(16 + source.length);
        const view = new DataView(payload.buffer);
        view.setUint32(0, target, true);
        view.setUint32(4, GL.PROGRAM_FORMAT_ASCII_ARB, true);
        view.setInt32(8, source.length, true);
        for (let i = 0; i < source.length; ++i)
            payload[16 + i] = source.charCodeAt(i) & 0xff;
        return this.record(GLFN.PROGRAM_STRING_ARB, payload);
    }

    /* {kind, target, index, count} then count*4 floats -- the parameter kind
     * leads, and it is 1 for env and 2 for local. */
    programParameterARB(kind, target, index, values) {
        const payload = new Uint8Array(16 + values.length * 4);
        const view = new DataView(payload.buffer);
        view.setUint32(0, kind, true);
        view.setUint32(4, target, true);
        view.setUint32(8, index, true);
        view.setUint32(12, values.length / 4, true);
        values.forEach((value, i) => view.setFloat32(16 + i * 4, value, true));
        return this.record(GLFN.PROGRAM_PARAMETER_FV_ARB, payload);
    }

    queryProgramParameterARB(kind, target, index) {
        const payload = new Uint8Array(40);
        const view = new DataView(payload.buffer);
        view.setUint32(0, kind, true);
        view.setUint32(4, target, true);
        view.setUint32(8, index, true);
        view.setUint32(16, 16, true);
        this.record(GLFN.QUERY_PROGRAM_PARAMETER_FV_ARB, payload);
        return this.payloadView();
    }

    queryProgramStringARB(target, capacity) {
        const payload = new Uint8Array(24 + capacity);
        const view = new DataView(payload.buffer);
        view.setUint32(0, target, true);
        view.setUint32(4, GL.PROGRAM_STRING_ARB, true);
        view.setUint32(16, capacity, true);
        this.record(GLFN.QUERY_PROGRAM_STRING_ARB, payload);
        return this.payloadView();
    }

    queryObjectLog(kind, name, capacity) {
        const payload = new Uint8Array(24 + capacity);
        const view = new DataView(payload.buffer);
        view.setUint32(0, kind, true);
        view.setUint32(4, name, true);
        view.setUint32(8, capacity, true);
        view.setUint32(20, capacity, true);
        this.record(GLFN.QUERY_OBJECT_LOG, payload);
        return this.payloadView();
    }

    queryActive(kind, program, index, capacity) {
        const payload = new Uint8Array(40 + capacity);
        const view = new DataView(payload.buffer);
        view.setUint32(0, kind, true);
        view.setUint32(4, program, true);
        view.setUint32(8, index, true);
        view.setUint32(12, capacity, true);
        view.setUint32(32, capacity, true);
        this.record(GLFN.QUERY_ACTIVE, payload);
        return this.payloadView();
    }

    queryInteger(pname) {
        const payload = new Uint8Array(16);
        new DataView(payload.buffer).setUint32(0, pname, true);
        this.record(GLFN.QUERY_INTEGER, payload);
        return this.payloadView();
    }

    queryError() {
        const payload = new Uint8Array(16);
        this.record(GLFN.QUERY_ERROR, payload);
        return this.payloadView();
    }

    queryString(pname, capacity) {
        const payload = new Uint8Array(16 + capacity);
        const view = new DataView(payload.buffer);
        view.setUint32(0, pname, true);
        view.setUint32(12, capacity, true);
        this.record(GLFN.QUERY_GL_STRING, payload);
        return this.payloadView();
    }

    queryLocation(kind, program, name, capacity) {
        const text = name + "\0";
        const payload = new Uint8Array(32 + Math.max(capacity || 0, text.length));
        const view = new DataView(payload.buffer);
        view.setUint32(0, kind, true);
        view.setUint32(4, program, true);
        view.setUint32(28, text.length, true);
        for (let i = 0; i < text.length; ++i)
            payload[32 + i] = text.charCodeAt(i) & 0xff;
        this.record(GLFN.QUERY_LOCATION, payload);
        return this.payloadView();
    }

    queryObjectiv(kind, name, pname) {
        const payload = new Uint8Array(24);
        const view = new DataView(payload.buffer);
        view.setUint32(0, kind, true);
        view.setUint32(4, name, true);
        view.setUint32(8, pname, true);
        this.record(GLFN.QUERY_OBJECT_IV, payload);
        return this.payloadView();
    }

    /* {program, location, value_kind, status, value_count, data_size, reserved0, reserved1} then the values */
    queryUniform(program, location, valueKind, capacity) {
        const payload = new Uint8Array(32 + capacity);
        const view = new DataView(payload.buffer);
        view.setUint32(0, program, true);
        view.setInt32(4, location, true);
        view.setUint32(8, valueKind, true);
        view.setUint32(20, capacity, true);
        this.record(GLFN.QUERY_UNIFORM, payload);
        return this.payloadView();
    }

    uniformfv(location, components, count, values) {
        const payload = new Uint8Array(12 + values.length * 4);
        const view = new DataView(payload.buffer);
        view.setInt32(0, location, true);
        view.setInt32(4, components, true);
        view.setInt32(8, count, true);
        values.forEach((value, i) => view.setFloat32(12 + i * 4, value, true));
        return this.record(GLFN.UNIFORM_FV, payload);
    }

    uniformMatrixfv(location, dimension, count, transpose, values) {
        const header = wire.encodeRecord("UNIFORM_MATRIX_FV", { location, dimension, count, transpose: +transpose });
        const payload = new Uint8Array(header.length + values.length * 4), view = new DataView(payload.buffer);
        payload.set(header); values.forEach((value, i) => view.setFloat32(header.length + 4 * i, value, true));
        return this.record(GLFN.UNIFORM_MATRIX_FV, payload);
    }

    pixelMap(name, map, values) {
        const header = wire.encodeRecord(name, { map, count: values.length }), stride = name === "PIXEL_MAPUSV" ? 2 : 4;
        const payload = new Uint8Array(header.length + values.length * stride), view = new DataView(payload.buffer);
        payload.set(header);
        values.forEach((value, i) => name === "PIXEL_MAPUSV" ? view.setUint16(header.length + i * 2, value, true) :
            name === "PIXEL_MAPUIV" ? view.setUint32(header.length + i * 4, value, true) : view.setFloat32(header.length + i * 4, value, true));
        return this.record(GLFN[name], payload);
    }

    uniformiv(location, components, count, values) {
        const payload = new Uint8Array(12 + values.length * 4);
        const view = new DataView(payload.buffer);
        view.setInt32(0, location, true);
        view.setInt32(4, components, true);
        view.setInt32(8, count, true);
        values.forEach((value, i) => view.setInt32(12 + i * 4, value | 0, true));
        return this.record(GLFN.UNIFORM_IV, payload);
    }

    bytes() {
        return this.buffer.subarray(0, this.length);
    }

    /* glReadPixels: {x, y, w, h, format, type, dataSize, status} then the
     * destination bytes, pre-seeded the way the guest seeds them */
    readPixels(x, y, width, height, format, type, dataSize, seed) {
        const payload = new Uint8Array(32 + dataSize);
        const view = new DataView(payload.buffer);
        view.setInt32(0, x, true); view.setInt32(4, y, true);
        view.setInt32(8, width, true); view.setInt32(12, height, true);
        view.setUint32(16, format, true); view.setUint32(20, type, true);
        view.setUint32(24, dataSize, true); view.setUint32(28, 0, true);
        payload.fill(seed === undefined ? 0xCD : seed, 32);
        this.record(GLFN.READ_PIXELS, payload);
        return this.payloadView();
    }

    raw(opcode, bytes) { return this.record(opcode, bytes); }
}

if (typeof module !== "undefined" && module.exports)
    module.exports = { GLStream, GL, GLFN };
else
    globalThis.GLTestStream = { GLStream, GL, GLFN };
