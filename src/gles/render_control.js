// renderControl (opcodes 10000 on: docs/gles-proxy-plan.md, E1): the
// emulator's EGL on the host, as gfxstream's host/RenderControl.cpp and
// FrameBuffer answer the guest's libEGL_emulation and gralloc: the
// renderer's version and strings, the EGL configurations, contexts, window
// surfaces, color buffers (gralloc's buffers: created, opened and closed
// by reference, updated from the CPU, read back, bound as a texture or a
// renderbuffer, posted), client images, sync objects, the multi-display
// commands. Each object belongs to the process that made it (its puid,
// rcSetPuid; a connection without one owns its own): when the process's
// GLProcessPipe closes, what it made and its references go, as gfxstream's
// cleanupProcGLObjects.
//
// What the page needs to know of these comes out through `events` (an
// object made or gone, a frame flushed or posted, pixels written): the GLES
// host makes them GLES records (src/gles/gles_host.js). Reads back are the
// host's: here they give nothing.

import { CONFIGS, CONFIG_ATTRIBUTES, EGL, EGL_STRINGS, choose_configs, configs_for, gl_string } from "./gles_caps.js";

/** rcGetFBParam's parameters (gfxstream's host/FrameBuffer.h) */
const FB_WIDTH = 1;
const FB_HEIGHT = 2;
const FB_XDPI = 3;
const FB_YDPI = 4;
const FB_FPS = 5;
const FB_MIN_SWAP_INTERVAL = 6;
const FB_MAX_SWAP_INTERVAL = 7;
/** rcCreateContext's API (gfxstream's GLESApi): 1 GLES 1.1, 2 GLES 2.0, 3 and up GLES 3.x */
const GLES_API_CM = 1;
/** EGL_GL_TEXTURE_2D_KHR, EGL_NATIVE_BUFFER_ANDROID: rcCreateClientImage's targets */
const EGL_GL_TEXTURE_2D_KHR = 0x30B1;
const EGL_NATIVE_BUFFER_ANDROID = 0x3140;

/**
 * One connection's view: its process and what it made current
 * @typedef {{id: number, puid: ?number, context: number, draw: number, read: number}}
 */
export let RCConnection;

/**
 * @constructor
 * @param {{width: number, height: number, dpi: number}} display the screen (rcGetFBParam)
 */
export function RenderControl(display)
{
    this.display = display;
    /** @type {function(string, ...*)} what happened: "context_create", ... (gles_host.js) */
    this.events = () => {};
    this.reset();
}

RenderControl.prototype.reset = function()
{
    /** handles of every kind come from one counter, as gfxstream's genHandle */
    this.next_handle = 1;
    /** @type {!Map<number, {config: number, share: number, api: number, owner: string}>} */
    this.contexts = new Map();
    /** @type {!Map<number, {config: number, width: number, height: number, color_buffer: number, owner: string}>} */
    this.surfaces = new Map();
    /** @type {!Map<number, {width: number, height: number, format: number, refs: !Map<string, number>, updates: number}>} */
    this.color_buffers = new Map();
    /** @type {!Map<number, {context: number, target: number, buffer: number, owner: string}>} */
    this.images = new Map();
    /** @type {!Map<number, {owner: string}>} sync objects, by their 64-bit handle (below 2^53) */
    this.syncs = new Map();
    /** @type {!Map<number, {color_buffer: number, x: number, y: number, w: number, h: number, dpi: number}>} displays besides 0 */
    this.displays = new Map();
    /** @type {!Map<number, {size: number, owner: string}>} rcCreateBuffer's (Vulkan's; never used by a GLES guest) */
    this.buffers = new Map();
    this.posted = 0;
    this.posts = 0;
    this.swap_interval = 1;
    /** the bytes rcUpdateColorBuffer brought (E1: counted) */
    this.update_bytes = 0;
};

/** @param {!RCConnection} conn @return {string} the owner of what the connection makes */
function owner_of(conn)
{
    return conn.puid !== null ? "p" + conn.puid : "c" + conn.id;
}

RenderControl.prototype.handle = function()
{
    return this.next_handle++;
};

/**
 * The API of the connection's current context, for rcGetGLString (none: 2)
 * @param {!RCConnection} conn
 * @return {number}
 */
RenderControl.prototype.current_api = function(conn)
{
    const context = this.contexts.get(conn.context);
    return context ? context.api : 2;
};

/**
 * The configuration of the connection's draw surface (gles_defaults.js:
 * the GL_*_BITS queries)
 * @param {!RCConnection} conn
 * @return {?{width: number, height: number, config: !Array<number>}}
 */
RenderControl.prototype.draw_surface = function(conn)
{
    const surface = this.surfaces.get(conn.draw);
    if(!surface) return null;
    return { width: surface.width, height: surface.height, config: CONFIGS[surface.config] };
};

/**
 * A NUL-terminated string into an out buffer, as rcQueryEGLString answers:
 * its length with the NUL, or minus that when the buffer is too small
 * @param {string} text
 * @param {!Object} out an OutBuffer
 * @return {number}
 */
function string_reply(text, out)
{
    const bytes = new TextEncoder().encode(text + "\0");
    if(bytes.length > out.size) return -bytes.length;
    out.data.set(bytes);
    return bytes.length;
}

/** @param {!Object} out an OutBuffer @param {!Array<number>} values written as u32s while they fit */
function put_u32s(out, values)
{
    for(let i = 0; i < values.length && 4 * i + 4 <= out.size; i++) out.view.setUint32(4 * i, values[i] >>> 0, true);
}

/**
 * The commands, by name: (rc, conn, args) to the return value
 * @type {!Object<string, function(!RenderControl, !RCConnection, !Array<*>): *>}
 */
const HANDLERS = {
    "rcGetRendererVersion": () => 1,
    "rcGetEGLVersion": (rc, conn, [major, minor]) =>
    {
        put_u32s(major, [1]);
        put_u32s(minor, [4]);
        return EGL.TRUE;
    },
    "rcQueryEGLString": (rc, conn, [name, buffer]) =>
    {
        const text = EGL_STRINGS.get(name);
        return text === undefined ? 0 : string_reply(text, buffer);
    },
    "rcGetGLString": (rc, conn, [name, buffer]) => string_reply(gl_string(name, rc.current_api(conn), rc.max_version), buffer),
    "rcGetNumConfigs": (rc, conn, [num_attribs]) =>
    {
        put_u32s(num_attribs, [CONFIG_ATTRIBUTES.length]);
        return CONFIGS.length;
    },
    // (the attributes' ids, then each configuration's values)
    "rcGetConfigs": (rc, conn, [size, buffer]) =>
    {
        const needed = (CONFIGS.length + 1) * CONFIG_ATTRIBUTES.length * 4;
        if(buffer.size < needed) return -needed;
        put_u32s(buffer, [...CONFIG_ATTRIBUTES, ...configs_for(rc.max_version).flat()]);
        return CONFIGS.length;
    },
    "rcChooseConfig": (rc, conn, [attribs, attribs_size, configs, configs_size]) =>
    {
        const view = attribs && new DataView(attribs.buffer, attribs.byteOffset, attribs.byteLength);
        const list = [];
        for(let at = 0; view && at + 4 <= view.byteLength; at += 4) list.push(view.getInt32(at, true));
        const chosen = choose_configs(list, configs_for(rc.max_version));
        // (with room for some, as many as fit; without, how many there are)
        if(configs && configs_size > 0)
        {
            const n = Math.min(chosen.length, configs_size);
            put_u32s(configs, chosen.slice(0, n));
            return n;
        }
        return chosen.length;
    },
    "rcGetFBParam": (rc, conn, [param]) =>
    {
        switch(param)
        {
            case FB_WIDTH: return rc.display.width;
            case FB_HEIGHT: return rc.display.height;
            case FB_XDPI: case FB_YDPI: return rc.display.dpi;
            case FB_FPS: return 60;
            case FB_MIN_SWAP_INTERVAL: case FB_MAX_SWAP_INTERVAL: return 1;
        }
        return -1;
    },
    "rcCreateContext": (rc, conn, [config, share, api]) =>
    {
        // (the guest asks 3 for GLES 3.0, 4 for 3.1 and 3.2: such a context is
        // the highest version announced, which EGL allows; its "api" is that
        // version, 30 to 32, past GLES 1.1's 1 and 2.0's 2)
        if(!CONFIGS[config] || share && !rc.contexts.has(share) || api < GLES_API_CM || api > (rc.max_version >= 30 ? 4 : 2)) return 0;
        const level = api >= 3 ? rc.max_version : api;
        const handle = rc.handle();
        const group = share ? rc.contexts.get(share).share || share : 0;
        rc.contexts.set(handle, { config, share: group, api: level, owner: owner_of(conn) });
        rc.events("context_create", handle, config, group, level);
        return handle;
    },
    "rcDestroyContext": (rc, conn, [context]) => { if(rc.contexts.delete(context)) rc.events("context_destroy", context); },
    "rcCreateWindowSurface": (rc, conn, [config, width, height]) =>
    {
        if(!CONFIGS[config]) return 0;
        const handle = rc.handle();
        rc.surfaces.set(handle, { config, width, height, color_buffer: 0, owner: owner_of(conn) });
        rc.events("surface_create", handle, config, width, height);
        return handle;
    },
    "rcDestroyWindowSurface": (rc, conn, [surface]) => { if(rc.surfaces.delete(surface)) rc.events("surface_destroy", surface); },
    "rcCreateColorBuffer": (rc, conn, [width, height, format]) => rc.create_color_buffer(conn, width, height, format, 0),
    "rcCreateColorBufferDMA": (rc, conn, [width, height, format]) => rc.create_color_buffer(conn, width, height, format, 0),
    "rcCreateColorBufferWithHandle": (rc, conn, [width, height, format, handle]) => { rc.create_color_buffer(conn, width, height, format, handle); },
    "rcOpenColorBuffer": (rc, conn, [color_buffer]) => { rc.open_color_buffer(conn, color_buffer); },
    "rcOpenColorBuffer2": (rc, conn, [color_buffer]) => rc.open_color_buffer(conn, color_buffer),
    "rcCloseColorBuffer": (rc, conn, [color_buffer]) => { rc.close_color_buffer(owner_of(conn), color_buffer); },
    "rcSetWindowColorBuffer": (rc, conn, [surface, color_buffer]) =>
    {
        const s = rc.surfaces.get(surface);
        if(!s || !rc.color_buffers.has(color_buffer)) return;
        s.color_buffer = color_buffer;
        rc.events("surface_color_buffer", surface, color_buffer);
    },
    "rcFlushWindowColorBuffer": (rc, conn, [surface]) => rc.flush_surface(surface) ? 0 : -1,
    "rcFlushWindowColorBufferAsync": (rc, conn, [surface]) => { rc.flush_surface(surface); },
    "rcFlushWindowColorBufferAsyncWithFrameNumber": (rc, conn, [surface]) => { rc.flush_surface(surface); },
    "rcMakeCurrent": (rc, conn, [context, draw, read]) => rc.make_current(conn, context, draw, read),
    "rcMakeCurrentAsync": (rc, conn, [context, draw, read]) => { rc.make_current(conn, context, draw, read); },
    "rcFBPost": (rc, conn, [color_buffer]) =>
    {
        if(!rc.color_buffers.has(color_buffer)) return;
        rc.posted = color_buffer;
        rc.posts++;
        rc.events("post", color_buffer);
    },
    "rcFBSetSwapInterval": (rc, conn, [interval]) => { rc.swap_interval = interval; },
    "rcBindTexture": (rc, conn, [color_buffer]) => { if(rc.color_buffers.has(color_buffer)) rc.events("bind", conn, color_buffer, true); },
    "rcBindRenderbuffer": (rc, conn, [color_buffer]) => { if(rc.color_buffers.has(color_buffer)) rc.events("bind", conn, color_buffer, false); },
    "rcColorBufferCacheFlush": () => 0,
    // (E1: nothing drawn, zeros read back)
    "rcReadColorBuffer": () => {},
    "rcReadColorBufferYUV": () => {},
    "rcReadColorBufferDMA": () => -1,
    "rcUpdateColorBuffer": (rc, conn, [color_buffer, x, y, width, height, format, type, pixels]) =>
    {
        const cb = rc.color_buffers.get(color_buffer);
        if(!cb) return -1;
        cb.updates++;
        rc.update_bytes += pixels.length;
        rc.events("color_buffer_update", color_buffer, x, y, width, height, format, type, pixels);
        return 0;
    },
    "rcUpdateColorBufferDMA": () => -1,
    "rcCreateClientImage": (rc, conn, [context, target, buffer]) =>
    {
        // (a texture of a context; or a gralloc buffer, by its color buffer)
        if(target === EGL_NATIVE_BUFFER_ANDROID ? !rc.color_buffers.has(buffer) : target !== EGL_GL_TEXTURE_2D_KHR || !rc.contexts.has(context)) return 0;
        const handle = rc.handle();
        rc.images.set(handle, { context, target, buffer, owner: owner_of(conn) });
        rc.events("image_create", handle, context, target, buffer);
        return handle;
    },
    "rcDestroyClientImage": (rc, conn, [image]) =>
    {
        if(!rc.images.delete(image)) return 0;
        rc.events("image_destroy", image);
        return 1;
    },
    "rcSelectChecksumHelper": () => {},
    // (fences signal when the commands before them ran: in the order of
    // the channel, so at once here; docs/gles-proxy-plan.md "影子状态")
    "rcCreateSyncKHR": (rc, conn, [type, attribs, num_attribs, destroy_when_signaled, glsync_out, syncthread_out]) =>
    {
        const handle = rc.handle();
        if(!destroy_when_signaled) rc.syncs.set(handle, { owner: owner_of(conn) });
        put_u32s(glsync_out, [handle, 0]);
        put_u32s(syncthread_out, [0, 0]);
    },
    "rcClientWaitSyncKHR": () => EGL.CONDITION_SATISFIED_KHR,
    "rcWaitSyncKHR": () => {},
    "rcDestroySyncKHR": (rc, conn, [sync]) => { rc.syncs.delete(sync); return 0; },
    "rcDestroySyncKHRAsync": (rc, conn, [sync]) => { rc.syncs.delete(sync); },
    "rcIsSyncSignaled": () => 1,
    "rcSetPuid": (rc, conn, [puid]) =>
    {
        // (all ones, as the wire's u64 reads: virtio-gpu's, whose context is the process; not this transport's)
        if(puid !== 0xFFFFFFFF * 0x100000000 + 0xFFFFFFFF) conn.puid = puid;
    },
    // (hardware composer 2 and multi-display: an API 25 guest sends none of
    // them; answered as a host without them)
    "rcCompose": () => -1,
    "rcComposeWithoutPost": () => -1,
    "rcComposeAsync": () => {},
    "rcComposeAsyncWithoutPost": () => {},
    "rcCreateDisplay": () => -1,
    "rcCreateDisplayById": () => -1,
    "rcDestroyDisplay": () => -1,
    "rcSetDisplayColorBuffer": () => -1,
    "rcGetDisplayColorBuffer": () => -1,
    "rcGetColorBufferDisplay": () => -1,
    "rcGetDisplayPose": () => -1,
    "rcSetDisplayPose": () => -1,
    "rcSetDisplayPoseDpi": () => -1,
    "rcGetDisplayColorTransform": () => -1,
    "rcSetDisplayColorTransform": () => -1,
    "rcGetFBDisplayConfigsCount": () => 1,
    "rcGetFBDisplayConfigsParam": (rc, conn, [config, param]) => config === 0 ? HANDLERS["rcGetFBParam"](rc, conn, [param]) : -1,
    "rcGetFBDisplayActiveConfig": () => 0,
    // (Vulkan's: no Vulkan on this host)
    "rcSetColorBufferVulkanMode": () => -1,
    "rcSetColorBufferVulkanMode2": () => -1,
    "rcCreateBuffer": () => 0,
    "rcCreateBuffer2": () => 0,
    "rcCloseBuffer": () => {},
    "rcMapGpaToBufferHandle": () => -1,
    "rcMapGpaToBufferHandle2": () => -1,
    "rcSetTracingForPuid": () => {},
    "rcSetProcessMetadata": () => {},
    "rcGetHostExtensionsString": (rc, conn, [size, buffer]) => string_reply("", buffer),
};

/**
 * @param {!RCConnection} conn
 * @param {!Object} command (gles_wire.js)
 * @param {!Array<*>} args
 * @return {*} the return value
 */
RenderControl.prototype.call = function(conn, command, args)
{
    const handler = HANDLERS[command.name];
    return handler ? handler(this, conn, args) : 0;
};

/** @param {string} name @return {boolean} whether renderControl knows the command */
export function rc_handles(name)
{
    return Object.prototype.hasOwnProperty.call(HANDLERS, name);
}

/**
 * @param {!RCConnection} conn
 * @param {number} width
 * @param {number} height
 * @param {number} format
 * @param {number} handle the guest's (0: one of the host's)
 * @return {number}
 */
RenderControl.prototype.create_color_buffer = function(conn, width, height, format, handle)
{
    if(!width || !height || width > 0x4000 || height > 0x4000) return 0;
    handle = handle || this.handle();
    this.color_buffers.set(handle, { width, height, format, refs: new Map([[owner_of(conn), 1]]), updates: 0 });
    this.events("color_buffer_create", handle, width, height, format);
    return handle;
};

/** @param {!RCConnection} conn @param {number} handle @return {number} 0, or -1 for no such color buffer */
RenderControl.prototype.open_color_buffer = function(conn, handle)
{
    const cb = this.color_buffers.get(handle);
    if(!cb) return -1;
    const owner = owner_of(conn);
    cb.refs.set(owner, (cb.refs.get(owner) || 0) + 1);
    return 0;
};

/** @param {string} owner @param {number} handle */
RenderControl.prototype.close_color_buffer = function(owner, handle)
{
    const cb = this.color_buffers.get(handle);
    if(!cb) return;
    // (a reference of another process: gralloc frees a buffer it imported)
    const from = cb.refs.has(owner) ? owner : cb.refs.keys().next().value;
    const count = cb.refs.get(from) - 1;
    if(count > 0) cb.refs.set(from, count);
    else cb.refs.delete(from);
    if(!cb.refs.size)
    {
        this.color_buffers.delete(handle);
        this.events("color_buffer_destroy", handle);
    }
};

/** @param {number} surface @return {boolean} whether there is one: what was drawn to it goes to its color buffer */
RenderControl.prototype.flush_surface = function(surface)
{
    if(!this.surfaces.has(surface)) return false;
    this.events("flush_surface", surface);
    return true;
};

/** @return {number} EGL_TRUE or EGL_FALSE */
RenderControl.prototype.make_current = function(conn, context, draw, read)
{
    // (no context: no surfaces; a context: surfaces that exist, or none, EGL_KHR_surfaceless_context's)
    const known = surface => !surface || this.surfaces.has(surface);
    if(context ? !this.contexts.has(context) || !known(draw) || !known(read) : draw || read) return EGL.FALSE;
    conn.context = context;
    conn.draw = draw;
    conn.read = read;
    this.events("make_current", conn, context, draw, read);
    return EGL.TRUE;
};

/**
 * A connection or a process went: what it owned goes
 * @param {string} owner "p" + puid, or "c" + a connection's id
 */
RenderControl.prototype.release = function(owner)
{
    for(const [map, gone] of [[this.images, "image_destroy"], [this.surfaces, "surface_destroy"], [this.contexts, "context_destroy"], [this.syncs, ""]])
    {
        map.forEach((object, handle) =>
        {
            if(object.owner !== owner) return;
            map.delete(handle);
            if(gone) this.events(gone, handle);
        });
    }
    this.color_buffers.forEach((cb, handle) =>
    {
        cb.refs.delete(owner);
        if(cb.refs.size) return;
        this.color_buffers.delete(handle);
        this.events("color_buffer_destroy", handle);
    });
};

/** @param {!RCConnection} conn the connection closed */
RenderControl.prototype.disconnect = function(conn)
{
    // (a process's objects stay until its GLProcessPipe closes)
    if(conn.puid === null) this.release(owner_of(conn));
};

/** @return {!Object} the counts for reports */
RenderControl.prototype.summary = function()
{
    return {
        contexts: this.contexts.size, surfaces: this.surfaces.size, color_buffers: this.color_buffers.size,
        images: this.images.size, syncs: this.syncs.size, posts: this.posts, posted: this.posted, update_bytes: this.update_bytes,
    };
};
