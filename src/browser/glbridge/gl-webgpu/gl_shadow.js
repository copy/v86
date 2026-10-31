// The CPU side's OpenGL state (docs/opengl-webgpu-plan.md C3). It lives in
// the v86gl device (v86gl_device.js), on the thread the CPU runs on, and
// reads every GL batch in guest memory before the renderer gets it: the
// guest's synchronous queries are answered there, before the device
// completes the request. So the answers are the same whether the renderer
// is on this thread or across the CPU worker's boundary, where the renderer
// only ever sees a copy (review S1-1).
//
// CPU modules answer state, object, program and error queries. Rendering
// results (pixels, occlusion results and programmable vertex captures) use
// explicit asynchronous replies; renderer state is never a GL error source.
//
// The parts: this file walks the records and keeps the contexts and their
// share groups; the others add handlers (GLShadow.install) and the state
// they keep (GLShadow.parts), to snapshots too.

(function(global) {
    "use strict";

    const protocol = global.GLProtocol || require("./gl_protocol.js");
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const glCaps = global.GLCaps || require("./gl_caps.js");
    const { GLFN, CTRL, C, F, RECORDS } = protocol;

    const OK = C.V86GL_SYNC_QUERY_STATUS_OK;
    const PENDING = C.V86GL_SYNC_QUERY_STATUS_PENDING;
    const EXTENDED_RECORD_SIZE = C.V86GL_EXTENDED_RECORD_SIZE;
    const UPLOAD_NAMES = new Set(("BUFFER_DATA BUFFER_SUB_DATA SHADER_SOURCE PROGRAM_STRING_ARB UNIFORM_FV UNIFORM_IV UNIFORM_MATRIX_FV UNIFORM_MATRIX_RECT_FV " +
        "TEX_IMAGE_1D TEX_IMAGE_2D TEX_IMAGE_3D TEX_SUB_IMAGE_1D TEX_SUB_IMAGE_2D TEX_SUB_IMAGE_3D " +
        "COMPRESSED_TEX_IMAGE_1D COMPRESSED_TEX_IMAGE_2D COMPRESSED_TEX_IMAGE_3D " +
        "COMPRESSED_TEX_SUB_IMAGE_1D COMPRESSED_TEX_SUB_IMAGE_2D COMPRESSED_TEX_SUB_IMAGE_3D " +
        "DRAW_ARRAYS DRAW_ARRAYS_GL2 DRAW_ELEMENTS DRAW_ELEMENTS_GL2 BITMAP DRAW_PIXELS MAP_EVALUATOR PIXEL_MAPFV PIXEL_MAPUIV PIXEL_MAPUSV").split(" "));
    const uploadHash = bytes => { let hash = 2166136261;for (const value of bytes) hash = Math.imul(hash ^ value, 16777619);return hash >>> 0; };

    // record code -> method; the parts add theirs
    const HANDLERS = new Map();
    // CPU rules run before any state mutation or query handler. Returning a
    // GL error suppresses the original command in both halves of the stream.
    const RULES = new Map();
    // glGetIntegerv and glGetString pnames the parts answer: pname -> method
    // of the shadow, giving the value (undefined: not this side's yet)
    const INTEGERS = new Map(), STRINGS = new Map();
    // { reset(shadow), group(group), context(context), getState(shadow, state), setState(shadow, state) }
    // of each part
    const PARTS = [];

    // Attribute stacks copy live numeric state; JSON would turn NaN and
    // infinities into null and -0 into +0 before a snapshot even begins.
    function cloneState(value) {
        if (Array.isArray(value)) return value.map(cloneState);
        if (ArrayBuffer.isView(value)) return value instanceof DataView ?
            new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)) : new value.constructor(value);
        if (value instanceof ArrayBuffer) return value.slice(0);
        if (value instanceof Map) return new Map([...value].map(([key, item]) => [cloneState(key), cloneState(item)]));
        if (value instanceof Set) return new Set([...value].map(cloneState));
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneState(item)]));
        return value;
    }
    const NUMBER_TAG = "$v86glNumber";
    function snapshotNumbers(value, decode) {
        if (typeof value === "number" && !decode) {
            const token = Number.isNaN(value) ? "nan" : value === Infinity ? "+inf" : value === -Infinity ? "-inf" : Object.is(value, -0) ? "-0" : null;
            return token ? { [NUMBER_TAG]: token } : value;
        }
        if (Array.isArray(value)) return value.map(item => snapshotNumbers(item, decode));
        if (value && typeof value === "object") {
            if (decode && Object.keys(value).length === 1 && Object.hasOwn(value, NUMBER_TAG)) {
                switch (value[NUMBER_TAG]) {
                case "nan": return NaN;
                case "+inf": return Infinity;
                case "-inf": return -Infinity;
                case "-0": return -0;
                }
            }
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotNumbers(item, decode)]));
        }
        return value;
    }

    class GLShadow {
        constructor() {
            // gl_caps.js's capabilities object; none until the renderer sends it
            this.capabilities = null;
            // gl_glslang.js's Glslang; none until the renderer sends the module
            this.glslang = null;
            this.stats = { batches: 0, records: 0, answered: 0, malformed: 0, rejected: 0 };
            this.reset();
        }

        // fn -> the method's name, for a part
        static install(handlers) {
            for (const [fn, method] of Object.entries(handlers)) HANDLERS.set(+fn, method);
        }

        static rules(rules) {
            for (const [fn, rule] of Object.entries(rules)) RULES.set(+fn, rule);
        }

        // pname -> the method's name, for a part's glGetIntegerv and glGetString
        static queries({ integers, strings }) {
            for (const [pname, method] of Object.entries(integers || {})) INTEGERS.set(+pname, method);
            for (const [pname, method] of Object.entries(strings || {})) STRINGS.set(+pname, method);
        }

        static part(part) {
            PARTS.push(part);
        }

        static clone(value) { return cloneState(value); }

        // A new owner of the arena, or a reset machine: no contexts
        reset() {
            this.responseTargets = new Map();
            this.nextResponseTarget = 0;
            this.cpuBarrier = null;
            this.deferredCPU = [];
            this.deferredCPUBytes = 0;
            this.cpuResumeInsertion = null;
            this.completedCPUBatches = null;
            this.contexts = new Map();
            this.groups = new Map();
            this.nextGroup = 1;
            this.current = null;
            for (const part of PARTS) if (part.reset) part.reset(this);
        }

        setCapabilities(capabilities) {
            this.capabilities = glCaps.freeze(capabilities);
        }

        setGlslang(glslang) {
            this.glslang = glslang;
            this.glslangFailure = null;
        }

        setGlslangFailure(message) {
            this.glslang = null;
            this.glslangFailure = "ERROR: GLSL compiler is unavailable: " + message + "\n";
        }

        /*
         * One GL batch's records, in guest memory (a view the answers are
         * written into). A malformed stream stops the walk: the executor
         * reports it.
         */
        process(bytes, metadata = this.batchMetadata) {
            if (this.cpuBarrier) { this.deferCPU(bytes, metadata); return []; }
            const previous = this.batchMetadata;
            this.batchMetadata = metadata;
            try {
                const result = this.processBatch(bytes);
                if (!this.cpuBarrier && metadata?.root) {
                    if (this.completedCPUBatches) this.completedCPUBatches.push(metadata);
                    else this.onCPUComplete?.(metadata);
                }
                return result;
            }
            finally { this.batchMetadata = previous; }
        }

        blockCPU(token) {
            if (this.cpuBarrier) throw new Error("a GL CPU state dependency is already pending");
            this.cpuBarrier = { token, metadata: this.batchMetadata };
        }

        deferCPU(bytes, metadata) {
            const task = { bytes: bytes.slice(), metadata: metadata && { ...metadata, deferred: true } };
            if (this.current?.listExecution) task.execution = { context: this.current.key, ...GLShadow.clone(this.current.listExecution) };
            (this.cpuResumeInsertion || this.deferredCPU).push(task); this.deferredCPUBytes += task.bytes.length;
        }

        cancelCPU() {
            const barrier = this.cpuBarrier;
            this.cpuBarrier = null; this.deferredCPU = []; this.deferredCPUBytes = 0;
            for (const part of PARTS) if (part.cancelCPU) part.cancelCPU(this, barrier);
        }

        resumeCPU(token, commands = []) {
            if (this.cpuBarrier?.token !== token) return false;
            if (this.completedCPUBatches) { Promise.resolve().then(() => this.resumeCPU(token, commands)); return true; }
            const metadata = this.cpuBarrier.metadata;
            this.cpuBarrier = null; this.completedCPUBatches = [];
            try {
                if (commands.length) this.onCPUResume?.(new Uint8Array(), commands.map(bytes => ({ bytes })), { ...metadata, generated: true, root: false, offset: 0 });
                while (!this.cpuBarrier && this.deferredCPU.length) {
                    const task = this.deferredCPU.shift(); this.deferredCPUBytes -= task.bytes.length;
                    const context = task.execution && this.contexts.get(task.execution.context), previous = context?.listExecution;
                    if (context) context.listExecution = { depth: task.execution.depth, bytes: task.execution.bytes };
                    this.cpuResumeInsertion = [];
                    try {
                        const segments = this.process(task.bytes, task.metadata);
                        this.onCPUResume?.(task.bytes, segments, task.metadata);
                    } finally {
                        this.deferredCPU.unshift(...this.cpuResumeInsertion); this.cpuResumeInsertion = null;
                        if (context) context.listExecution = previous;
                    }
                }
                // Publish continuations before releasing the submitting IOCTL:
                // a newly accepted batch must follow their rendering work.
                for (const completed of this.completedCPUBatches) this.onCPUComplete?.(completed);
            } finally { this.completedCPUBatches = null; }
            return true;
        }

        deferResponse(view, offset, length, local = false) {
            if (this.batchMetadata?.batchId !== undefined && !local) return { ...this.batchMetadata, offset: (this.batchMetadata.offset || 0) + offset };
            const id = ++this.nextResponseTarget;
            this.responseTargets.set(id, new Uint8Array(view.buffer, view.byteOffset + offset, length));
            return { localId: id };
        }

        completeResponse(target, bytes, statusOffset) {
            if (target.localId) {
                const output = this.responseTargets.get(target.localId);
                this.responseTargets.delete(target.localId);
                if (output) { output.set(bytes.subarray(0, statusOffset)); output.set(bytes.subarray(statusOffset + 4), statusOffset + 4); output.set(bytes.subarray(statusOffset, statusOffset + 4), statusOffset); }
            } else if (this.writeResponse) this.writeResponse(target, bytes, statusOffset);
        }

        processBatch(bytes) {
            ++this.stats.batches;
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const end = bytes.byteLength;
            let offset = 0;
            const segments = [];
            let accepted = 0, filtered = false;
            while (offset + 4 <= end) {
                const recordOffset = offset;
                const fn = view.getUint16(offset, true);
                let size = view.getUint16(offset + 2, true);
                offset += 4;
                if (size === EXTENDED_RECORD_SIZE) {
                    if (offset + 4 > end) { offset = recordOffset; break; }
                    size = view.getUint32(offset, true);
                    offset += 4;
                }
                if (offset + size > end) {
                    offset = recordOffset; break;
                }
                ++this.stats.records;
                let routed;
                const name = protocol.NAME_BY_OPCODE[fn], signature = protocol.SIGNATURES[name], header = RECORDS[name];
                const minimum = signature ? protocol.payloadBytes(signature[1]) : header ? header.size : 0;
                if (size < minimum || !name && !Object.values(CTRL).includes(fn) && !protocol.isRejected(fn)) {
                    ++this.stats.malformed;
                    const fields = protocol.F[name];
                    if (fields?.status !== undefined && fields.status + 4 <= size) view.setUint32(offset + fields.status, C.V86GL_SYNC_QUERY_STATUS_FAILED, true);
                    routed = { error: GL.INVALID_OPERATION };
                } else if (!this.current && fn < 0xFF00 && !name?.startsWith("QUERY_")) {
                    routed = { commands: [] };
                } else if (fn === GLFN.UPLOAD_CHUNK) {
                    routed = this.uploadChunk(bytes, view, offset, size);
                } else for (const part of PARTS) if (part.routeRecord) {
                    routed = part.routeRecord(this, fn, bytes, view, offset, size);
                    if (routed !== undefined) break;
                }
                const error = routed ? routed.error || 0 : this.dispatch(fn, bytes, view, offset, size);
                if (error) {
                    if (this.current && !this.current.error) this.current.error = error;
                    view.setUint16(recordOffset, protocol.rejectedOpcode(fn, error), true);
                    ++this.stats.rejected;
                } else if (!routed) {
                    for (const part of PARTS) if (part.forwardOpcode) {
                        const forwarded = part.forwardOpcode(this, fn, bytes, view, offset, size);
                        if (forwarded !== undefined) view.setUint16(recordOffset, forwarded, true);
                    }
                }
                const statusOffset = protocol.F[name]?.status;
                if (this.batchMetadata?.deferred && !this.batchMetadata.generated && statusOffset !== undefined && statusOffset + 4 <= size &&
                    view.getUint32(offset + statusOffset, true) !== PENDING && this.writeResponse)
                    this.completeResponse({ ...this.batchMetadata, offset: (this.batchMetadata.offset || 0) + offset }, bytes.slice(offset, offset + size), statusOffset);
                offset += size;
                if (routed || protocol.isRejected(view.getUint16(recordOffset, true))) {
                    if (accepted < recordOffset) segments.push({ offset: accepted, length: recordOffset - accepted });
                    if (routed && !error) for (const command of routed.commands || []) segments.push({ bytes: command });
                    accepted = offset; filtered = true;
                }
                if (this.cpuBarrier) {
                    this.deferCPU(bytes.subarray(offset), this.batchMetadata && { ...this.batchMetadata, offset: (this.batchMetadata.offset || 0) + offset });
                    if (accepted < offset) segments.push({ offset: accepted, length: offset - accepted });
                    return segments;
                }
            }
            if (offset !== end) ++this.stats.malformed;
            for (const part of PARTS) if (part.afterBatch) part.afterBatch(this);
            if (offset !== end) {
                if (accepted < offset) segments.push({ offset: accepted, length: offset - accepted });
                return segments;
            }
            if (!filtered) return;
            if (accepted < end) segments.push({ offset: accepted, length: end - accepted });
            return segments;
        }

        // CPU-generated records own their storage and carry no guest reply
        // addresses. Lists and evaluators use this to validate their expansion
        // through exactly the same command rules as the original stream.
        expand(bytes) {
            const segments = this.process(bytes, this.batchMetadata && { ...this.batchMetadata, generated: true, root: false, offset: 0 });
            return segments ? segments.map(segment => segment.bytes || bytes.subarray(segment.offset, segment.offset + segment.length)) : [bytes];
        }

        // Only the complete immutable original enters GL validation and list
        // compilation. Partial transport data cannot redefine live storage.
        uploadChunk(bytes, view, offset, size) {
            const c = this.current, r = protocol.decodeRecord("UPLOAD_CHUNK", view, offset), header = RECORDS.UPLOAD_CHUNK.size;
            const fail = error => { if (c) c.upload = null;return { error }; };
            if (!c || !r.token || !UPLOAD_NAMES.has(protocol.NAME_BY_OPCODE[r.opcode]) || !r.total_size || !r.data_size ||
                size !== header + r.data_size || r.offset + r.data_size > r.total_size) return fail(GL.INVALID_OPERATION);
            if (r.total_size > C.V86GL_MAX_UPLOAD_BYTES) return fail(GL.OUT_OF_MEMORY);
            const data = bytes.subarray(offset + header, offset + size), last = c.completedUpload;
            if (last?.token === r.token) return last.opcode === r.opcode && last.total_size === r.total_size &&
                last.offset === r.offset && last.data_size === r.data_size && last.hash === uploadHash(data) ? { commands: [] } : fail(GL.INVALID_OPERATION);
            let upload = c.upload;
            if (!r.offset && upload?.token !== r.token) {
                c.upload = null;
                const allocated = [...this.contexts.values()].reduce((sum, context) => sum + (context.upload?.total_size || 0), 0);
                if (allocated + r.total_size > C.V86GL_MAX_UPLOAD_BYTES) return fail(GL.OUT_OF_MEMORY);
                try {
                    const record = new Uint8Array(8 + r.total_size), v = new DataView(record.buffer);
                    v.setUint16(0, r.opcode, true);v.setUint16(2, EXTENDED_RECORD_SIZE, true);v.setUint32(4, r.total_size, true);
                    c.upload = upload = { token: r.token, opcode: r.opcode, total_size: r.total_size, received: 0, record };
                } catch (_) { return fail(GL.OUT_OF_MEMORY); }
            }
            if (!upload || upload.token !== r.token || upload.opcode !== r.opcode || upload.total_size !== r.total_size) return fail(GL.INVALID_OPERATION);
            if (r.offset < upload.received) {
                if (r.offset + r.data_size > upload.received || !data.every((v, i) => v === upload.record[8 + r.offset + i])) return fail(GL.INVALID_OPERATION);
                return { commands: [] };
            }
            if (r.offset !== upload.received) return fail(GL.INVALID_OPERATION);
            upload.record.set(data, 8 + r.offset);upload.received += data.length;
            if (upload.received < upload.total_size) return { commands: [] };
            c.upload = null;c.completedUpload = { ...r, hash: uploadHash(data) };
            return { commands: this.expand(upload.record) };
        }

        dispatch(fn, bytes, view, offset, size, validateOnly = false) {
            if (protocol.isRejected(fn)) {
                if (this.current && !this.current.error) this.current.error = protocol.rejectionError(fn);
                return;
            }
            const name = protocol.NAME_BY_OPCODE[fn];
            const signature = protocol.SIGNATURES[name];
            const header = RECORDS[name];
            const minimum = signature ? protocol.payloadBytes(signature[1]) : header ? header.size : 0;
            if (size < minimum) { ++this.stats.malformed; return; }
            const rule = RULES.get(fn);
            if (rule && this.current) {
                const error = rule(this, bytes, view, offset, size);
                if (error) return error;
            }
            for (const part of PARTS) if (part.checkCommand && this.current) {
                const error = part.checkCommand(this, fn, bytes, view, offset, size);
                if (error) return error;
            }
            if (validateOnly) return 0;
            // GL errors are CPU state, including NO_ERROR. The renderer may
            // still report host failures, but cannot change this GL answer.
            if (fn === GLFN.QUERY_ERROR && this.pending("QUERY_ERROR", view, offset, size)) {
                const c = this.current, inside = c?.state?.begin;
                view.setUint32(offset + F.QUERY_ERROR.value, inside ? 0 : c?.error || 0, true);
                if (inside) { if (!c.error) c.error = GL.INVALID_OPERATION; }
                else if (c) c.error = 0;
                this.answered("QUERY_ERROR", view, offset, OK);
            }
            for (const part of PARTS) if (part.command) part.command(this, fn, bytes, view, offset, size);
            const method = HANDLERS.get(fn);
            if (!method) return;
            // (a GL command needs a context; one without is the executor's to report)
            if (fn < 0xFF00 && fn !== GLFN.QUERY_INTEGER && fn !== GLFN.QUERY_GL_STRING &&
                    fn !== GLFN.QUERY_STATE && fn !== GLFN.QUERY_PARAMETER && fn !== GLFN.QUERY_BUFFER_DATA &&
                    fn !== GLFN.QUERY_BUFFER_MAP && fn !== GLFN.QUERY_BUFFER_UNMAP && fn !== GLFN.QUERY_NAMES &&
                    fn !== GLFN.QUERY_TEXTURE_IMAGE && fn !== GLFN.QUERY_POLYGON_STIPPLE &&
                    fn !== GLFN.POLYGON_STIPPLE_BITMAP && fn !== GLFN.QUERY_LIST && fn !== GLFN.QUERY_RENDER_MODE && !this.current) return;
            return this[method](bytes, view, offset, size);
        }

        // A flat record's arguments, or null when it is short
        args(name, view, offset, size) {
            const out = [];
            return protocol.decodeArgs(protocol.SIGNATURES[name][1], view, offset, size, out) < 0 ? null : out;
        }

        // An older guest's MAKE_CURRENT stops short; the fields after read as 0
        field(name, field, view, offset, size) {
            const at = F[name][field];
            return at + 4 <= size ? view.getUint32(offset + at, true) : 0;
        }

        // Keyed as the executor keys them: by the guest's context id, or by
        // the window for a guest too old to send one. Objects belong to the
        // share group: the guest's, or the context's own.
        makeCurrent(bytes, view, offset, size) {
            const id = this.field("MAKE_CURRENT", "context_id", view, offset, size);
            const hwnd = this.field("MAKE_CURRENT", "hwnd", view, offset, size);
            const key = id ? "context:" + id : "hwnd:" + hwnd;
            let context = this.contexts.get(key);
            if (!context) {
                const shareGroup = this.field("MAKE_CURRENT", "share_group", view, offset, size);
                context = this.createContext(key, id, shareGroup ? "guest:" + shareGroup : "private:" + this.nextGroup++);
            }
            // Optional in older MAKE_CURRENT records. Freeze the first hint
            // for this context; a later switch cannot change its contract.
            if (context.capsProfile === undefined) {
                const profile = this.field("MAKE_CURRENT", "caps_profile", view, offset, size);
                context.capsProfile = profile >= 0 && profile <= C.V86GL_CAPS_PROFILE_GL21 ? profile : 0;
            }
            this.current = context;
            for (const part of PARTS) if (part.current) part.current(this, context, view, offset, size);
        }

        createContext(key, id, groupKey) {
            let group = this.groups.get(groupKey);
            if (!group) {
                group = { key: groupKey };
                for (const part of PARTS) if (part.group) part.group(group);
                this.groups.set(groupKey, group);
            }
            const context = { key, id, group, program: 0, error: 0 };
            for (const part of PARTS) if (part.context) part.context(context);
            this.contexts.set(key, context);
            return context;
        }

        releaseCurrent() {
            this.current = null;
        }

        destroyContext(bytes, view, offset, size) {
            if (size < RECORDS.DESTROY_CONTEXT.size) {
                this.reset();
                return;
            }
            const key = "context:" + view.getUint32(offset + F.DESTROY_CONTEXT.context_id, true);
            const context = this.contexts.get(key);
            if (this.current && this.current.key === key) this.current = null;
            this.contexts.delete(key);
            if (context) for (const part of PARTS) if (part.destroy) part.destroy(this, context);
            // a share group goes with its last context
            for (const [groupKey, group] of this.groups)
                if (![...this.contexts.values()].some(c => c.group === group)) this.groups.delete(groupKey);
        }

        // Whether a query record is still the guest's to have answered
        pending(name, view, offset, size) {
            return size >= RECORDS[name].size && view.getUint32(offset + F[name].status, true) === PENDING;
        }

        answered(name, view, offset, status) {
            view.setUint32(offset + F[name].status, status, true);
            ++this.stats.answered;
        }

        // A name list record (GEN_*, DELETE_*, DRAW_BUFFERS): the names, or null
        names(name, view, offset, size) {
            if (size < RECORDS[name].size) return null;
            const count = view.getUint32(offset + F[name].count, true);
            if (RECORDS[name].size + count * 4 > size) return null;
            const names = [];
            for (let i = 0; i < count; ++i) names.push(view.getUint32(offset + RECORDS[name].size + i * 4, true));
            return names;
        }

        // A capability, or a part's state (with a context)
        integer(pname) {
            const method = INTEGERS.get(pname);
            if (method && this.current) {
                const value = this[method](pname); if (value !== undefined) return value;
            }
            return glCaps.integer(this.capabilities, pname);
        }

        string(pname) {
            const c = this.current;
            if (c?.capsProfile && !c.capsStrings) {
                c.capsStrings = {};
                for (const name of [GL.VENDOR, GL.RENDERER, GL.VERSION, GL.SHADING_LANGUAGE_VERSION, GL.EXTENSIONS]) {
                    const text = glCaps.profileString(this.capabilities, c.capsProfile, name);
                    if (text !== undefined) c.capsStrings[name] = text;
                }
            }
            const value = c?.capsProfile ? c.capsStrings[pname] : glCaps.string(this.capabilities, pname);
            const method = STRINGS.get(pname);
            return value !== undefined || !method || !this.current ? value : this[method](pname);
        }

        queryInteger(bytes, view, offset, size) {
            if (!this.capabilities || !this.pending("QUERY_INTEGER", view, offset, size)) return;
            const pname = view.getUint32(offset + F.QUERY_INTEGER.pname, true);
            let value = this.integer(pname);
            if (value === undefined && this.current && this.stateValue) {
                const result = this.stateValue(pname);
                if (result) {
                    const v = result[0][0] || 0, kind = result[1];
                    value = kind === "u" ? v | 0 : kind === "n" ? (v <= -1 ? -0x80000000 : Math.trunc(Math.max(-1, Math.min(1, v)) * 0x7FFFFFFF)) :
                        kind === "t" ? Math.trunc(v) : v < 0 ? -Math.round(-v) : Math.round(v);
                }
            }
            if (value === undefined) {
                if (this.current && !this.current.error) this.current.error = GL.INVALID_ENUM;
                return this.answered("QUERY_INTEGER", view, offset, C.V86GL_SYNC_QUERY_STATUS_FAILED);
            }
            view.setUint32(offset + F.QUERY_INTEGER.value, value >>> 0, true);
            view.setUint32(offset + F.QUERY_INTEGER.status, OK, true);
            ++this.stats.answered;
        }

        // {name, status, length, data_size} then data_size bytes for the
        // text; length counts its terminator, which is written when it fits
        queryString(bytes, view, offset, size) {
            if (!this.capabilities || !this.pending("QUERY_GL_STRING", view, offset, size)) return;
            const text = this.string(view.getUint32(offset + F.QUERY_GL_STRING.name, true));
            const capacity = view.getUint32(offset + F.QUERY_GL_STRING.data_size, true);
            const header = RECORDS.QUERY_GL_STRING.size;
            if (text === undefined || header + capacity > size) {
                if (this.current && !this.current.error) this.current.error = text === undefined ? GL.INVALID_ENUM : GL.INVALID_VALUE;
                return this.answered("QUERY_GL_STRING", view, offset, C.V86GL_SYNC_QUERY_STATUS_FAILED);
            }
            const limit = Math.min(text.length + 1, capacity);
            for (let i = 0; i < limit; ++i)
                bytes[offset + header + i] = i < text.length ? text.charCodeAt(i) & 0xff : 0;
            view.setUint32(offset + F.QUERY_GL_STRING.length, text.length + 1, true);
            view.setUint32(offset + F.QUERY_GL_STRING.status, OK, true);
            ++this.stats.answered;
        }

        getState() {
            if (this.cpuBarrier || this.deferredCPU.length)
                throw new Error("GL snapshot requires completed CPU state dependencies");
            const state = {
                numberEncoding: 1,
                capabilities: this.capabilities,
                nextGroup: this.nextGroup,
                contexts: [...this.contexts.values()].map(c => ({ key: c.key, id: c.id, group: c.group.key,
                    program: c.program, error: c.error, capsProfile: c.capsProfile || 0,
                    ...(c.completedUpload ? { completedUpload: { ...c.completedUpload } } : {}),
                    ...(c.upload ? { upload: { ...c.upload, record: Array.from(c.upload.record.subarray(0, 8 + c.upload.received)) } } : {}),
                    ...(c.capsStrings ? { capsStrings: { ...c.capsStrings } } : {}) })),
                current: this.current ? this.current.key : null,
            };
            for (const part of PARTS) if (part.getState) part.getState(this, state);
            return snapshotNumbers(state, false);
        }

        // A snapshot's capabilities stand: the guest was told those
        setState(state) {
            this.reset();
            if (!state) return;
            state = state.numberEncoding === 1 ? snapshotNumbers(state, true) : cloneState(state);
            this.capabilities = glCaps.freeze(state.capabilities);
            this.nextGroup = state.nextGroup || 1;
            for (const c of state.contexts || []) {
                const context = this.createContext(c.key, c.id, c.group || "private:" + c.key);
                context.program = c.program || 0;
                context.error = c.error || 0;
                context.capsProfile = c.capsProfile || 0;
                if (c.completedUpload) context.completedUpload = { ...c.completedUpload };
                if (c.upload) {
                    const u = c.upload;
                    if (!u.token || !UPLOAD_NAMES.has(protocol.NAME_BY_OPCODE[u.opcode]) || !Number.isInteger(u.total_size) || u.total_size < 1 || u.total_size > C.V86GL_MAX_UPLOAD_BYTES ||
                        !Number.isInteger(u.received) || u.received < 1 || u.received >= u.total_size || u.record.length !== u.received + 8)
                        throw new Error("Invalid GL upload checkpoint");
                    const allocated = [...this.contexts.values()].reduce((sum, item) => sum + (item.upload?.total_size || 0), 0);
                    if (allocated + u.total_size > C.V86GL_MAX_UPLOAD_BYTES) throw new Error("Invalid GL upload checkpoint budget");
                    const record = new Uint8Array(8 + u.total_size), v = new DataView(record.buffer);
                    v.setUint16(0, u.opcode, true);v.setUint16(2, EXTENDED_RECORD_SIZE, true);v.setUint32(4, u.total_size, true);
                    record.set(u.record.slice(8), 8);context.upload = { ...u, record };
                }
                if (c.capsStrings) context.capsStrings = { ...c.capsStrings };
            }
            this.current = state.current ? this.contexts.get(state.current) || null : null;
            for (const part of PARTS) if (part.setState) part.setState(this, state);
        }
    }

    GLShadow.install({
        [CTRL.MAKE_CURRENT]: "makeCurrent",
        [CTRL.RELEASE_CURRENT]: "releaseCurrent",
        [CTRL.DESTROY_CONTEXT]: "destroyContext",
        [GLFN.QUERY_INTEGER]: "queryInteger",
        [GLFN.QUERY_GL_STRING]: "queryString",
    });

    const api = { GLShadow };
    global.V86GLShadow = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
