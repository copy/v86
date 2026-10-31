// A renderer checkpoint contains live GL binding identities and GPU contents,
// rather than the draws which happened to produce them.
(function(global) {
    "use strict";
    const codec = global.GLSnapshotCodec || require("./gl_snapshot_codec.js"), gpu = global.GLGPUArchive || require("./gl_gpu_snapshot.js");
    const translator = global.GLShaderTranslator || require("./gl_shader_translator.js"),
        arb = global.GLARBProgram || require("./gl_arb_program.js");
    const fields = ["shareGroups", "contexts", "nextContextId", "nextShareGroupId", "nextUniformLocation", "current", "framebuffers", "queries", "activeQuery",
        "surface", "drawables", "currentDrawable", "backBuffer", "backBufferWidth", "backBufferHeight", "backBufferFormat", "depthTarget", "depthWidth", "depthHeight", "depthSamples",
        "multisampleTarget", "multisampleWidth", "multisampleHeight", "multisampleFormat", "accumBuffer", "frontDrawn", "pendingClear"];
    const caches = new Set(["variants", "viewCache"]), views = new Set(["currentView", "nextView", "backBufferView", "depthTargetView", "multisampleView"]);
    function project(object) {
        return Object.fromEntries(Object.entries(object).filter(([key]) => !views.has(key) &&
            !(object.textureUnits && object.stacks && ["error", "errorQueue", "arbErrorString", "arbErrorPosition"].includes(key))).map(([key, value]) =>
            [key, caches.has(key) ? new Map() : key === "depthColor" ? null : value]));
    }
    function shaderSource(compiled) {
        return { stage: compiled.stage, preprocessedSource: compiled.preprocessedSource, unitSources: compiled.unitSources, version: compiled.version,
            extensions: compiled.extensions, sourceHash: compiled.sourceHash, warnings: compiled.warnings, log: compiled.log };
    }
    function shader(reference, options) {
        const source = reference.shader;
        if (!source || !["vertex", "fragment"].includes(source.stage)) throw new Error("Invalid GL shader checkpoint");
        if (source.unitSources) {
            const result = translator.linkShaderUnits(source.unitSources.map(unit => shader({ shader: unit }, options)), source.stage, options);
            if (!result.ok) throw new Error("GL checkpoint shader link: " + result.log); return result;
        }
        if (typeof source.preprocessedSource !== "string") throw new Error("Invalid GL shader source checkpoint");
        const ast = new translator.Parser(translator.lex(source.preprocessedSource), source.stage).parseProgram(),
            analyzer = new translator.Analyzer(source.stage, ast, { ...options, library: true }), usage = analyzer.run();
        return { ...source, ok: true, ast, usage, functions: analyzer.functions };
    }
    async function capture(executor) {
        await executor.idle(); executor.flushFrame(); await executor.idle();
        await executor.awaitReadback(executor.device.queue.onSubmittedWorkDone(), "GL snapshot fence");
        const resources = [], state = codec.encode(Object.fromEntries(fields.map(key => [key, executor[key]])), { project, external: object => {
            if (object.ok && object.ast && object.usage && ["vertex", "fragment"].includes(object.stage)) return { shader: shaderSource(object) };
            if (typeof object.destroy !== "function" || typeof object.createView !== "function" && typeof object.mapAsync !== "function") return;
            const index = resources.length; resources.push(object); return { resource: index };
        } }), images = [];
        // Bound transient GPU allocations to one resource at a time.
        for (const resource of resources) images.push(await gpu.capture(executor, resource));
        return codec.encode({ version: 1, state, resources: images });
    }
    function inspect(bytes) {
        const archive = codec.decode(bytes);
        if (archive?.version !== 1 || !(archive.state instanceof Uint8Array) || !Array.isArray(archive.resources)) throw new Error("Invalid GL renderer checkpoint");
        const objects = archive.resources.map((resource, i) => ({ resource: i }));
        const state = codec.decode(archive.state, { external: reference => {
            if (reference?.shader) return reference;
            if (!Number.isInteger(reference?.resource) || reference.resource < 0 || reference.resource >= objects.length) throw new Error("Invalid GL resource reference");
            return objects[reference.resource];
        } });
        if (!(state.contexts instanceof Map) || !(state.shareGroups instanceof Map) || !(state.framebuffers instanceof Map) || !(state.queries instanceof Map)) throw new Error("Invalid GL renderer state");
        for (const resource of archive.resources) {
            gpu.validate(resource);
        }
        return archive;
    }
    async function restore(executor, bytes) {
        const archive = inspect(bytes), resources = [];
        try {
            for (const image of archive.resources) resources.push(await gpu.restore(executor, image));
            const state = codec.decode(archive.state, { external: reference => reference?.shader ? shader(reference, executor.options.translator || {}) : resources[reference.resource] });
            // ARB reflection is generated state, just like GLSL ASTs. Rebuild it
            // from source so archives made before layout changes remain valid.
            const arbPrograms = new Set();
            for (const group of state.shareGroups.values()) for (const program of group.arbPrograms.values()) arbPrograms.add(program);
            for (const context of state.contexts.values()) {
                for (const program of context.arbBindings.values()) arbPrograms.add(program);
                for (const program of Object.values(context.arbDefaults)) arbPrograms.add(program);
            }
            for (const program of arbPrograms) {
                if (!program?.compiled || !program.source) continue;
                const compiled = arb.compileARBProgram(program.source);
                if (!compiled.ok) throw new Error("GL checkpoint ARB program: " + compiled.log);
                program.compiled = compiled;
            }
            // Decode and allocate before changing the installed renderer.
            await executor.idle(); executor.resetForReplay();
            for (const context of state.contexts.values()) {
                // Before D1 these were renderer copies of CPU-owned errors.
                delete context.error;delete context.errorQueue;delete context.arbErrorString;delete context.arbErrorPosition;
            }
            for (const resource of resources) executor.resources.track(resource);
            for (const key of fields) {
                if (["drawables", "currentDrawable"].includes(key) && state[key] === undefined) continue;
                executor[key] = state[key];
            }
            // Older archives contain one drawable at the root.
            if (!(state.drawables instanceof Map)) executor.drawables.set(executor.current?.hwnd || 0, executor.currentDrawable);
            for (const drawable of executor.drawables.values()) {
                drawable.backBufferView = drawable.backBuffer?.createView() || null;
                drawable.depthTargetView = drawable.depthTarget?.createView() || null;
                drawable.multisampleView = drawable.multisampleTarget?.createView() || null;
                if (drawable.accumBuffer) {
                    drawable.accumBuffer.currentView = drawable.accumBuffer.currentTexture.createView();
                    drawable.accumBuffer.nextView = drawable.accumBuffer.nextTexture.createView();
                }
            }
            executor.backBufferView = executor.backBuffer?.createView() || null;
            executor.depthTargetView = executor.depthTarget?.createView() || null;
            executor.multisampleView = executor.multisampleTarget?.createView() || null;
            if (executor.accumBuffer) {
                executor.accumBuffer.currentView = executor.accumBuffer.currentTexture.createView();
                executor.accumBuffer.nextView = executor.accumBuffer.nextTexture.createView();
            }
            if ([...executor.contexts.values()].some(c => c.activeQuery)) executor.ensureOcclusionQuerySet();
            executor.notifySurface("restore");
        } catch (error) { for (const resource of resources) resource.destroy(); throw error; }
    }
    const api = { capture, restore, inspect };
    global.GLRendererSnapshot = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
