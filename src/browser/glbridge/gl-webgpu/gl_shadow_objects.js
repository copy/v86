// The GL shadow's textures, renderbuffers and framebuffer objects
// (docs/opengl-webgpu-plan.md C3): their names, what each texture level and
// renderbuffer holds (size and internal format), what each framebuffer
// object has attached, and the bindings -- so glCheckFramebufferStatus is
// answered on the CPU side, by EXT_framebuffer_object's rules.
//
// Textures and renderbuffers belong to the share group. Framebuffer names
// currently follow the executor's context-local namespace; distinguishing
// shared EXT FBO creation from core creation remains part of C3/C6.
// Draw/read buffer selection belongs to each framebuffer, including zero.

(function(global) {
    "use strict";

    const protocol = global.GLProtocol || require("./gl_protocol.js");
    const constants = global.GLWGConstants || require("./gl_constants.js");
    const glCaps = global.GLCaps || require("./gl_caps.js");
    const buffers = global.GLFramebufferState || require("./gl_framebuffer_state.js");
    const formats = global.GLImageFormats || require("./gl_image_formats.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const { GLFN, C, F, RECORDS } = protocol;
    const GL = constants.GL;

    const OK = C.V86GL_SYNC_QUERY_STATUS_OK;
    const PENDING = C.V86GL_SYNC_QUERY_STATUS_PENDING;
    const MAX_TEXTURE_UNITS = glCaps.LIMITS.MAX_TEXTURE_UNITS;
    const MAX_COLOR_ATTACHMENTS = glCaps.LIMITS.MAX_DRAW_BUFFERS;
    const AUTO_MIPMAP_UPDATES = new Set([GLFN.TEX_SUB_IMAGE_1D, GLFN.TEX_SUB_IMAGE_2D, GLFN.TEX_SUB_IMAGE_3D,
        GLFN.COMPRESSED_TEX_SUB_IMAGE_1D, GLFN.COMPRESSED_TEX_SUB_IMAGE_2D, GLFN.COMPRESSED_TEX_SUB_IMAGE_3D,
        GLFN.COPY_TEX_SUB_IMAGE_1D, GLFN.COPY_TEX_SUB_IMAGE_2D, GLFN.COPY_TEX_SUB_IMAGE_3D]);

    const DEPTH_FORMATS = new Set([GL.DEPTH_COMPONENT, GL.DEPTH_COMPONENT16, GL.DEPTH_COMPONENT24,
        GL.DEPTH_COMPONENT32, GL.DEPTH_COMPONENT32F, GL.DEPTH_STENCIL, GL.DEPTH24_STENCIL8, 0x8CAD]);
    const STENCIL_FORMATS = new Set([GL.STENCIL_INDEX, GL.STENCIL_INDEX1_EXT, GL.STENCIL_INDEX4_EXT,
        GL.STENCIL_INDEX8_EXT, GL.STENCIL_INDEX16_EXT, GL.DEPTH_STENCIL, GL.DEPTH24_STENCIL8, 0x8CAD]);

    // A texture image target: the binding it is made through, and its layer
    // (a cube map's face)
    function imageTarget(target) {
        const face = target - GL.TEXTURE_CUBE_MAP_POSITIVE_X;
        if (face >= 0 && face < 6) return { binding: GL.TEXTURE_CUBE_MAP, layer: face };
        return { binding: target, layer: 0 };
    }

    const proto = GLShadow.prototype;

    proto.textureObject = function(name) {
        const group = this.current.group;
        let texture = group.textures.get(name);
        if (!texture) {
            texture = { name, id: group.nextImageId++, target: 0, levels: new Map(), deleted: false };
            group.textures.set(name, texture);
            group.textureImages.set(texture.id, texture);
        }
        return texture;
    };

    proto.defaultTexture = function(target) {
        const c = this.current, group = c.group;
        let id = c.defaultTextures.get(target);
        if (!id) {
            const texture = { name: 0, id: group.nextImageId++, target, levels: new Map(), deleted: false };
            id = texture.id; group.textureImages.set(id, texture); c.defaultTextures.set(target, id);
        }
        return group.textureImages.get(id);
    };

    proto.genTextures = function(bytes, view, offset, size) {
        for (const name of this.names("GEN_TEXTURES", view, offset, size) || []) if (name) this.textureObject(name);
    };

    // A deleted texture is unbound from every unit of this context and
    // detached from the framebuffer objects bound here
    proto.deleteTextures = function(bytes, view, offset, size) {
        const c = this.current;
        for (const name of this.names("DELETE_TEXTURES", view, offset, size) || []) {
            const texture = c.group.textures.get(name);
            if (!name || !texture) continue;
            c.group.textures.delete(name); texture.deleted = true;
            c.units.forEach((unit, i) => {
                for (const [target] of unit) if (c.unitImages[i].get(target) === texture.id) {
                    unit.set(target, 0); c.unitImages[i].delete(target);
                }
            });
            this.detach("texture", texture.id);
        }
    };

    proto.bindTexture = function(bytes, view, offset, size) {
        const a = this.args("BIND_TEXTURE", view, offset, size);
        if (!a) return;
        const c = this.current;
        c.units[c.activeTexture].set(a[0], a[1]);
        c.unitImages[c.activeTexture].set(a[0], a[1] ? this.textureObject(a[1]).id : this.defaultTexture(a[0]).id);
        if (a[1]) {
            const texture = this.textureObject(a[1]);
            if (!texture.target) texture.target = a[0];
        }
    };

    proto.activeTexture = function(bytes, view, offset, size) {
        const a = this.args("ACTIVE_TEXTURE", view, offset, size);
        const unit = a ? a[0] - GL.TEXTURE0 : -1;
        if (unit >= 0 && unit < MAX_TEXTURE_UNITS) this.current.activeTexture = unit;
    };

    // The texture bound for an image target on the active unit, and the layer
    proto.boundImage = function(target) {
        const { binding, layer } = imageTarget(target);
        const c = this.current;
        const id = c.unitImages[c.activeTexture].get(binding);
        return { texture: id ? c.group.textureImages.get(id) : this.defaultTexture(binding), layer };
    };

    proto.defineLevel = function(target, level, width, height, depth, internalFormat, metadata) {
        if (metadata && !metadata.compressed) internalFormat = formats.uncompressedInternalFormat(internalFormat);
        if (formats.PROXY_TARGETS.has(target)) {
            let levels = this.current.proxyImages.get(target);
            if (!levels) this.current.proxyImages.set(target, levels = new Map());
            const binding = formats.PROXY_TARGETS.get(target), border = metadata?.border || 0;
            const maximum = this.capabilities ? glCaps.integer(this.capabilities, binding === GL.TEXTURE_3D ? GL.MAX_3D_TEXTURE_SIZE :
                binding === GL.TEXTURE_CUBE_MAP ? GL.MAX_CUBE_MAP_TEXTURE_SIZE : GL.MAX_TEXTURE_SIZE) : 8192;
            const limit = Math.max(1, Math.floor(maximum / 2 ** level)) + 2 * border;
            if (width > limit || binding !== GL.TEXTURE_1D && height > limit || binding === GL.TEXTURE_3D && depth > limit) {
                // GL 2.1 3.8.11: an unsupported probe clears its image state
                // without a GL error, rather than retaining the last success.
                levels.set(level, { width: 0, height: 0, depth: 0, border: 0, internalFormat: 0, compressed: false, unsupported: true });
                return;
            }
            if (width && height && depth) levels.set(level, { width, height, depth, internalFormat, ...metadata });
            else levels.delete(level);
            return;
        }
        const image = this.boundImage(target);
        if (!image || level < 0) return;
        let layer = image.texture.levels.get(image.layer);
        if (!layer) image.texture.levels.set(image.layer, layer = new Map());
        if (width > 0 && height > 0 && depth > 0) layer.set(level, { width, height, depth, internalFormat, ...metadata });
        else layer.delete(level);
    };

    proto.texImage = function(dimensions) {
        const name = "TEX_IMAGE_" + dimensions + "D";
        return function(bytes, view, offset, size) {
            if (size < RECORDS[name].size) return;
            const r = protocol.decodeRecord(name, view, offset);
            this.defineLevel(r.target, r.level, r.width, dimensions >= 2 ? r.height : 1, dimensions >= 3 ? r.depth : 1,
                r.internalformat >>> 0, { border: r.border, compressed: false });
            this.autoMipmap(r.target, r.level);
        };
    };
    proto.texImage1D = proto.texImage(1);
    proto.texImage2D = proto.texImage(2);
    proto.texImage3D = proto.texImage(3);

    proto.compressedTexImage = function(dimensions) {
        const name = "COMPRESSED_TEX_IMAGE_" + dimensions + "D";
        return function(bytes, view, offset, size) {
            if (size < RECORDS[name].size) return;
            const r = protocol.decodeRecord(name, view, offset);
            this.defineLevel(r.target, r.level, r.width, dimensions >= 2 ? r.height : 1, dimensions >= 3 ? r.depth : 1,
                r.internalformat, { border: r.border, compressed: true, compressedSize: r.image_size });
            this.autoMipmap(r.target, r.level);
        };
    };
    proto.compressedTexImage1D = proto.compressedTexImage(1);
    proto.compressedTexImage2D = proto.compressedTexImage(2);
    proto.compressedTexImage3D = proto.compressedTexImage(3);

    // glCopyTexImage1D (target, level, internalformat, x, y, width, border)
    proto.copyTexImage1D = function(bytes, view, offset, size) {
        const a = this.args("COPY_TEX_IMAGE_1D", view, offset, size);
        if (a) {
            this.defineLevel(a[0], a[1], a[5], 1, 1, a[2], { border: a[6], compressed: false });
            this.autoMipmap(a[0], a[1]);
        }
    };

    // glCopyTexImage2D (target, level, internalformat, x, y, width, height, border)
    proto.copyTexImage2D = function(bytes, view, offset, size) {
        const a = this.args("COPY_TEX_IMAGE_2D", view, offset, size);
        if (a) {
            this.defineLevel(a[0], a[1], a[5], a[6], 1, a[2], { border: a[7], compressed: false });
            this.autoMipmap(a[0], a[1]);
        }
    };

    // Manual generation stops at q=min(p,MAX_LEVEL); automatic generation
    // replaces the full pyramid through p, including border texels (GL 2.1
    // 3.8.8 and EXT_framebuffer_object's Manual Mipmap Generation).
    proto.generateMipmap = function(bytes, view, offset, size) {
        const a = this.args("GENERATE_MIPMAP", view, offset, size);
        const texture = a && this.boundImage(a[0]).texture;
        if (!texture) return;
        this.generateMipmapForImage(texture);
    };

    proto.autoMipmap = function(target, level) {
        if (formats.PROXY_TARGETS.has(target)) return;
        const image = this.boundImage(target).texture;
        if (target !== GL.TEXTURE_RECTANGLE && level === (image.parameters?.[GL.TEXTURE_BASE_LEVEL]?.[0] || 0) && image.parameters?.[GL.GENERATE_MIPMAP]?.[0])
            this.generateMipmapForImage(image, target);
    };

    proto.generateMipmapForImage = function(texture, changedTarget) {
        const first = texture.parameters?.[GL.TEXTURE_BASE_LEVEL]?.[0] || 0;
        const maximum = changedTarget === undefined ? texture.parameters?.[GL.TEXTURE_MAX_LEVEL]?.[0] ?? 1000 : Infinity;
        const dimensions = texture.target === GL.TEXTURE_1D ? 1 : texture.target === GL.TEXTURE_3D ? 3 : 2;
        for (const [face, layer] of texture.levels) {
            if (changedTarget !== undefined && face !== imageTarget(changedTarget).layer) continue;
            const base = layer.get(first);
            if (!base) continue;
            const border = base.border || 0;
            let { width, height, depth } = base;
            width -= 2 * border;
            if (dimensions >= 2) height -= 2 * border;
            if (dimensions >= 3) depth -= 2 * border;
            if (width < 1 || height < 1 || depth < 1) continue;
            for (let level = first + 1; level <= maximum && (width > 1 || height > 1 || depth > 1); ++level) {
                width = Math.max(1, Math.floor(width / 2));
                height = Math.max(1, Math.floor(height / 2));
                depth = Math.max(1, Math.floor(depth / 2));
                layer.set(level, { ...base, width: width + 2 * border,
                    height: height + (dimensions >= 2 ? 2 * border : 0), depth: depth + (dimensions >= 3 ? 2 * border : 0),
                    ...(base.compressed ? { compressedSize: Math.ceil(width / 4) * Math.ceil(height / 4) * depth *
                        (formats.COMPRESSED_FORMATS[base.internalFormat]?.blockBytes || 0) } : {}) });
            }
        }
    };

    proto.genRenderbuffers = function(bytes, view, offset, size) {
        for (const name of this.names("GEN_RENDERBUFFERS", view, offset, size) || [])
            if (name) this.renderbufferObject(name);
    };

    proto.renderbufferObject = function(name) {
        const group = this.current.group;
        let rb = group.renderbuffers.get(name);
        if (!rb) {
            rb = { name, id: group.nextImageId++, width: 0, height: 0, internalFormat: GL.RGBA,
                componentBits: [0, 0, 0, 0, 0, 0], deleted: false, created: false };
            group.renderbuffers.set(name, rb); group.renderbufferImages.set(rb.id, rb);
        }
        return rb;
    };

    proto.deleteRenderbuffers = function(bytes, view, offset, size) {
        const c = this.current;
        for (const name of this.names("DELETE_RENDERBUFFERS", view, offset, size) || []) {
            const rb = c.group.renderbuffers.get(name);
            if (!name || !rb) continue;
            c.group.renderbuffers.delete(name); rb.deleted = true;
            if (c.renderbufferImage === rb.id) c.renderbuffer = c.renderbufferImage = 0;
            this.detach("renderbuffer", rb.id);
        }
    };

    proto.bindRenderbuffer = function(bytes, view, offset, size) {
        const a = this.args("BIND_RENDERBUFFER", view, offset, size);
        if (!a) return;
        this.current.renderbufferImage = a[1] ? this.renderbufferObject(a[1]).id : 0;
        if (a[1]) this.renderbufferObject(a[1]).created = true;
        this.current.renderbuffer = a[1];
    };

    // glRenderbufferStorage (target, internalformat, width, height)
    proto.renderbufferStorage = function(bytes, view, offset, size) {
        const a = this.args("RENDERBUFFER_STORAGE", view, offset, size);
        const rb = a && this.current.group.renderbufferImages.get(this.current.renderbufferImage);
        if (!rb) return;
        const storage = a[2] && a[3] ? formats.renderbufferFormatFor(a[1], this.capabilities?.features) : null;
        rb.internalFormat = storage ? storage.internalFormat || a[1] : GL.RGBA;
        rb.componentBits = storage ? storage.components : [0, 0, 0, 0, 0, 0];
        rb.width = storage ? a[2] : 0;
        rb.height = storage ? a[3] : 0;
    };

    proto.findFramebuffer = function(name) {
        const c = this.current;
        return c.privateFramebuffers.get(name) || c.group.sharedFramebuffers.get(name) || c.group.framebufferReservations.get(name);
    };

    proto.framebufferObject = function(name) {
        const c = this.current, g = c.group;
        let fbo = this.findFramebuffer(name);
        if (!fbo) {
            fbo = { name, id: g.nextFramebufferId++, created: false, shared: false, deleted: false,
                ...buffers.initial(GL.COLOR_ATTACHMENT0), color: new Array(MAX_COLOR_ATTACHMENTS).fill(null), depth: null, stencil: null };
            g.framebufferObjects.set(fbo.id, fbo); g.framebufferReservations.set(name, fbo);
        }
        c.framebuffers.set(name, fbo);
        return fbo;
    };

    proto.genFramebuffers = function(bytes, view, offset, size) {
        for (const name of this.names("GEN_FRAMEBUFFERS", view, offset, size) || []) if (name) this.framebufferObject(name);
    };

    proto.deleteFramebuffers = function(bytes, view, offset, size) {
        const c = this.current;
        for (const name of this.names("DELETE_FRAMEBUFFERS", view, offset, size) || []) {
            const object = name && this.findFramebuffer(name); if (!object) continue;
            if (c.privateFramebuffers.get(name) === object) c.privateFramebuffers.delete(name);
            if (c.group.sharedFramebuffers.get(name) === object) c.group.sharedFramebuffers.delete(name);
            if (c.group.framebufferReservations.get(name) === object) c.group.framebufferReservations.delete(name);
            object.deleted = true;
            for (const other of this.contexts.values()) if (other.group === c.group && other.framebuffers.get(name) === object) other.framebuffers.delete(name);
            if (c.drawFramebufferObject === object) { c.drawFramebuffer = 0; c.drawFramebufferObject = null; }
            if (c.readFramebufferObject === object) { c.readFramebuffer = 0; c.readFramebufferObject = null; }
        }
        buffers.sync(c, c.framebuffers);
    };

    proto.bindFramebuffer = function(bytes, view, offset, size, shared = false) {
        const a = this.args("BIND_FRAMEBUFFER", view, offset, size);
        if (!a) return;
        const c = this.current;
        const object = a[1] ? this.framebufferObject(a[1]) : null;
        if (object && !object.created) {
            object.created = true; object.shared = shared;
            c.group.framebufferReservations.delete(a[1]);
            if (shared) {
                c.group.sharedFramebuffers.set(a[1], object);
                for (const other of this.contexts.values()) if (other.group === c.group && !other.privateFramebuffers.has(a[1])) other.framebuffers.set(a[1], object);
            } else {
                c.privateFramebuffers.set(a[1], object);
                for (const other of this.contexts.values()) if (other !== c && other.group === c.group && other.framebuffers.get(a[1]) === object) other.framebuffers.delete(a[1]);
            }
        }
        buffers.bind(c, c.framebuffers, a[0], a[1], object);
    };
    proto.bindFramebufferEXT = function(bytes, view, offset, size) { this.bindFramebuffer(bytes, view, offset, size, true); };

    proto.boundFramebuffer = function(target) {
        const c = this.current;
        const name = target === GL.READ_FRAMEBUFFER ? c.readFramebuffer : c.drawFramebuffer;
        return name ? buffers.owner(c, c.framebuffers, target === GL.READ_FRAMEBUFFER) || null : null;
    };

    proto.attach = function(target, attachment, record) {
        const fbo = this.boundFramebuffer(target);
        if (!fbo) return;
        if (attachment === GL.DEPTH_ATTACHMENT) fbo.depth = record;
        else if (attachment === GL.STENCIL_ATTACHMENT) fbo.stencil = record;
        else if (attachment === GL.DEPTH_STENCIL_ATTACHMENT) fbo.depth = fbo.stencil = record;
        else {
            const index = attachment - GL.COLOR_ATTACHMENT0;
            if (index >= 0 && index < MAX_COLOR_ATTACHMENTS) fbo.color[index] = record;
        }
    };

    // An object deleted while attached to a framebuffer object bound here
    proto.detach = function(kind, id) {
        const c = this.current;
        for (const fbo of new Set([this.boundFramebuffer(GL.DRAW_FRAMEBUFFER), this.boundFramebuffer(GL.READ_FRAMEBUFFER)])) {
            if (!fbo) continue;
            const stale = record => record && record.kind === kind && record.id === id;
            fbo.color = fbo.color.map(record => stale(record) ? null : record);
            if (stale(fbo.depth)) fbo.depth = null;
            if (stale(fbo.stencil)) fbo.stencil = null;
        }
    };

    // glFramebufferTexture* (target, attachment, textarget, texture, level, zoffset)
    proto.framebufferTexture = function(bytes, view, offset, size) {
        const a = this.args("FRAMEBUFFER_TEXTURE", view, offset, size);
        if (!a) return;
        const face = a[2] - GL.TEXTURE_CUBE_MAP_POSITIVE_X;
        this.attach(a[0], a[1], a[3] ? { kind: "texture", name: a[3], level: a[4],
            id: this.current.group.textures.get(a[3])?.id,
            layer: face >= 0 && face < 6 ? face : a[5] } : null);
    };

    // glFramebufferRenderbuffer (target, attachment, renderbuffertarget, renderbuffer)
    proto.framebufferRenderbuffer = function(bytes, view, offset, size) {
        const a = this.args("FRAMEBUFFER_RENDERBUFFER", view, offset, size);
        if (a) this.attach(a[0], a[1], a[3] ? { kind: "renderbuffer", name: a[3], level: 0, layer: 0,
            id: this.current.group.renderbuffers.get(a[3])?.id } : null);
    };

    proto.drawBuffer = function(bytes, view, offset, size) {
        const a = this.args("DRAW_BUFFER", view, offset, size);
        if (a) buffers.draw(this.current, this.current.framebuffers, [a[0]]);
    };

    proto.drawBuffers = function(bytes, view, offset, size) {
        const list = this.names("DRAW_BUFFERS", view, offset, size);
        if (list) buffers.draw(this.current, this.current.framebuffers, list);
    };

    proto.readBuffer = function(bytes, view, offset, size) {
        const a = this.args("READ_BUFFER", view, offset, size);
        if (a) buffers.read(this.current, this.current.framebuffers, a[0]);
    };

    // What an attachment holds: {width, height, internalFormat}, or null
    proto.attachedImage = function(record) {
        const group = this.current.group;
        if (record.kind === "renderbuffer") {
            const rb = group.renderbufferImages.get(record.id);
            return rb && rb.width && rb.height ? rb : null;
        }
        const texture = group.textureImages.get(record.id);
        const layer = texture && texture.levels.get(texture.target === GL.TEXTURE_3D ? 0 : record.layer);
        const level = layer && layer.get(record.level);
        if (!level || !level.width || !level.height) return null;
        // a 3D texture's attached layer must be one it has
        return texture.target === GL.TEXTURE_3D && (record.layer < 0 || record.layer >= level.depth) ? null : level;
    };

    // EXT_framebuffer_object's completeness. Two depth and stencil images
    // that are not the same one are UNSUPPORTED: WebGPU has one
    // depth-stencil attachment.
    proto.framebufferStatus = function(target) {
        const c = this.current;
        const name = target === GL.READ_FRAMEBUFFER ? c.readFramebuffer : c.drawFramebuffer;
        if (!name) return GL.FRAMEBUFFER_COMPLETE;
        const fbo = this.boundFramebuffer(target);
        if (!fbo) return GL.FRAMEBUFFER_UNDEFINED;
        let width = 0, height = 0, any = false, dimensions = true;
        const colorFormats = new Set();
        const complete = (record, accept) => {
            if (!record) return true;
            const image = this.attachedImage(record);
            if (!image || !accept(image.internalFormat >>> 0, image, record)) return false;
            if (!any) {
                width = image.width;
                height = image.height;
                any = true;
            } else if (image.width !== width || image.height !== height) {
                dimensions = false;
            }
            return true;
        };
        for (const record of fbo.color)
            if (!complete(record, (format, image, record) => {
                if (formats.COMPRESSED_FORMATS[format] || !["RGB", "RGBA"].includes(formats.BASE_INTERNAL_FORMATS[format])) return false;
                const storage = formats.storageFormatFor(format, this.capabilities?.features);
                const bits = record.kind === "renderbuffer" ? image.componentBits : formats.textureComponents(format, false, this.capabilities?.features);
                colorFormats.add(JSON.stringify([storage.gpu, storage.base, bits.slice(0, 4)]));
                return true;
            }))
                return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
        if (!complete(fbo.depth, format => DEPTH_FORMATS.has(format)))
            return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
        if (!complete(fbo.stencil, format => STENCIL_FORMATS.has(format)))
            return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
        if (!any) return GL.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT;
        if (!dimensions) return GL.FRAMEBUFFER_INCOMPLETE_DIMENSIONS_EXT;
        // This profile exposes EXT_framebuffer_object, whose colour images
        // must share an internal format. ARB FBO's relaxed rule is not exposed.
        if (colorFormats.size > 1) return GL.FRAMEBUFFER_INCOMPLETE_FORMATS_EXT;
        const same = (x, y) => x.kind === y.kind && x.id === y.id && x.level === y.level && x.layer === y.layer;
        if (fbo.depth && fbo.stencil && !same(fbo.depth, fbo.stencil)) return GL.FRAMEBUFFER_UNSUPPORTED_EXT;
        // a buffer that is not an attachment (BACK on an FBO) means the first
        const index = buffer => buffer >= GL.COLOR_ATTACHMENT0 ? buffer - GL.COLOR_ATTACHMENT0 : 0;
        if (target !== GL.READ_FRAMEBUFFER)
            for (const buffer of c.drawBuffers)
                if (buffer !== GL.NONE && !fbo.color[index(buffer)]) return GL.FRAMEBUFFER_INCOMPLETE_DRAW_BUFFER_EXT;
        if (target !== GL.DRAW_FRAMEBUFFER && c.readBuffer !== GL.NONE && !fbo.color[index(c.readBuffer)])
            return GL.FRAMEBUFFER_INCOMPLETE_READ_BUFFER_EXT;
        return GL.FRAMEBUFFER_COMPLETE;
    };

    // {target, status, result, reserved}
    proto.checkFramebufferStatus = function(bytes, view, offset, size) {
        const R = F.CHECK_FRAMEBUFFER_STATUS;
        if (size < RECORDS.CHECK_FRAMEBUFFER_STATUS.size || view.getUint32(offset + R.status, true) !== PENDING) return;
        const target = view.getUint32(offset + R.target, true);
        const error = this.current.state?.begin ? GL.INVALID_OPERATION :
            [GL.FRAMEBUFFER_EXT, GL.READ_FRAMEBUFFER, GL.DRAW_FRAMEBUFFER].includes(target) ? 0 : GL.INVALID_ENUM;
        if (error) { this.answered("CHECK_FRAMEBUFFER_STATUS", view, offset, C.V86GL_SYNC_QUERY_STATUS_FAILED); return error; }
        view.setUint32(offset + R.result, this.framebufferStatus(target), true);
        view.setUint32(offset + R.status, OK, true);
        ++this.stats.answered;
    };

    GLShadow.install({
        [GLFN.GEN_TEXTURES]: "genTextures",
        [GLFN.DELETE_TEXTURES]: "deleteTextures",
        [GLFN.BIND_TEXTURE]: "bindTexture",
        [GLFN.ACTIVE_TEXTURE]: "activeTexture",
        [GLFN.TEX_IMAGE_1D]: "texImage1D",
        [GLFN.TEX_IMAGE_2D]: "texImage2D",
        [GLFN.TEX_IMAGE_3D]: "texImage3D",
        [GLFN.COMPRESSED_TEX_IMAGE_1D]: "compressedTexImage1D",
        [GLFN.COMPRESSED_TEX_IMAGE_2D]: "compressedTexImage2D",
        [GLFN.COMPRESSED_TEX_IMAGE_3D]: "compressedTexImage3D",
        [GLFN.COPY_TEX_IMAGE_1D]: "copyTexImage1D",
        [GLFN.COPY_TEX_IMAGE_2D]: "copyTexImage2D",
        [GLFN.GENERATE_MIPMAP]: "generateMipmap",
        [GLFN.GEN_RENDERBUFFERS]: "genRenderbuffers",
        [GLFN.DELETE_RENDERBUFFERS]: "deleteRenderbuffers",
        [GLFN.BIND_RENDERBUFFER]: "bindRenderbuffer",
        [GLFN.RENDERBUFFER_STORAGE]: "renderbufferStorage",
        [GLFN.GEN_FRAMEBUFFERS]: "genFramebuffers",
        [GLFN.DELETE_FRAMEBUFFERS]: "deleteFramebuffers",
        [GLFN.BIND_FRAMEBUFFER]: "bindFramebuffer",
        [GLFN.BIND_FRAMEBUFFER_EXT]: "bindFramebufferEXT",
        [GLFN.FRAMEBUFFER_TEXTURE]: "framebufferTexture",
        [GLFN.FRAMEBUFFER_TEXTURE_1D]: "framebufferTexture",
        [GLFN.FRAMEBUFFER_TEXTURE_2D]: "framebufferTexture",
        [GLFN.FRAMEBUFFER_TEXTURE_3D]: "framebufferTexture",
        [GLFN.FRAMEBUFFER_RENDERBUFFER]: "framebufferRenderbuffer",
        [GLFN.DRAW_BUFFER]: "drawBuffer",
        [GLFN.DRAW_BUFFERS]: "drawBuffers",
        [GLFN.READ_BUFFER]: "readBuffer",
        [GLFN.CHECK_FRAMEBUFFER_STATUS]: "checkFramebufferStatus",
    });

    const levelsOut = texture => [...texture.levels].map(([layer, levels]) => [layer, [...levels]]);
    const levelsIn = saved => new Map(saved.map(([layer, levels]) => [layer, new Map(levels)]));

    function collectImages(shadow) {
        for (const group of shadow.groups.values()) {
            const live = new Set();
            const held = new Set([...group.sharedFramebuffers.values(), ...group.framebufferReservations.values()]);
            const units = list => { for (const unit of list) for (const id of unit.values()) live.add(id); };
            for (const c of shadow.contexts.values()) if (c.group === group) {
                units(c.unitImages); for (const id of c.defaultTextures.values()) live.add(id);
                live.add(c.renderbufferImage);
                if (c.textureRead) live.add(c.textureRead.imageId);
                for (const fbo of c.privateFramebuffers.values()) held.add(fbo);
                if (c.drawFramebufferObject) held.add(c.drawFramebufferObject);
                if (c.readFramebufferObject) held.add(c.readFramebufferObject);
                for (const a of c.state?.attrib || []) {
                    const images = a.parts?.images;
                    if (images) units(images.unitImages.map(u => new Map(u)));
                }
            }
            for (const [id, fbo] of group.framebufferObjects) {
                if (!held.has(fbo)) { group.framebufferObjects.delete(id); continue; }
                for (const r of [...fbo.color, fbo.depth, fbo.stencil]) if (r) live.add(r.id);
            }
            for (const pool of [group.textureImages, group.renderbufferImages])
                for (const [id, image] of pool) if ((image.deleted || !image.name) && !live.has(id)) pool.delete(id);
        }
    }

    GLShadow.part({
        afterBatch: collectImages,
        command(shadow, fn, bytes, view, offset) {
            if (AUTO_MIPMAP_UPDATES.has(fn) && shadow.current)
                shadow.autoMipmap(view.getUint32(offset, true), view.getInt32(offset + 4, true));
        },
        current(shadow, c, view, offset, size) {
            if (c.buffersInitialized) { buffers.sync(c, c.framebuffers); return; }
            const first = shadow.field("MAKE_CURRENT", "format", view, offset, size) & C.V86GL_FORMAT_SINGLE_BUFFER ? GL.FRONT : GL.BACK;
            c.defaultFramebufferState = buffers.initial(first); buffers.sync(c, c.framebuffers); c.buffersInitialized = true;
        },
        group(group) {
            group.textures = new Map();
            group.renderbuffers = new Map();
            group.textureImages = new Map();
            group.renderbufferImages = new Map();
            group.nextImageId = 1;
            group.framebufferObjects = new Map(); group.sharedFramebuffers = new Map(); group.framebufferReservations = new Map(); group.nextFramebufferId = 1;
        },
        context(context) {
            context.activeTexture = 0;
            context.units = Array.from({ length: MAX_TEXTURE_UNITS }, () => new Map());
            context.unitImages = Array.from({ length: MAX_TEXTURE_UNITS }, () => new Map());
            context.defaultTextures = new Map();
            context.proxyImages = new Map();
            context.framebuffers = new Map();
            context.privateFramebuffers = new Map();
            context.drawFramebufferObject = context.readFramebufferObject = null;
            context.drawFramebuffer = 0;
            context.readFramebuffer = 0;
            context.renderbuffer = 0;
            context.renderbufferImage = 0;
            context.drawBuffers = [GL.BACK];
            context.readBuffer = GL.BACK;
            context.defaultFramebufferState = buffers.initial(GL.BACK);
        },
        getState(shadow, state) {
            state.objects = {
                version: 3,
                groups: [...shadow.groups.values()].map(group => ({ key: group.key,
                    nextImageId: group.nextImageId,
                    textures: [...group.textureImages.values()].map(t => [t.name, t.target, levelsOut(t), t.id, t.deleted, t.parameters]),
                    renderbuffers: [...group.renderbufferImages.values()], nextFramebufferId: group.nextFramebufferId,
                    framebuffers: [...group.framebufferObjects.values()], sharedFramebuffers: [...group.sharedFramebuffers].map(([n, f]) => [n, f.id]),
                    framebufferReservations: [...group.framebufferReservations].map(([n, f]) => [n, f.id]) })),
                contexts: [...shadow.contexts.values()].map(c => ({ key: c.key, activeTexture: c.activeTexture,
                    units: c.units.map(unit => [...unit]), framebuffers: [...c.framebuffers].map(([n, f]) => [n, f.id]),
                    privateFramebuffers: [...c.privateFramebuffers].map(([n, f]) => [n, f.id]),
                    drawFramebufferId: c.drawFramebufferObject?.id || 0, readFramebufferId: c.readFramebufferObject?.id || 0,
                    unitImages: c.unitImages.map(unit => [...unit]), defaultTextures: [...c.defaultTextures],
                    proxyImages: [...c.proxyImages].map(([target, levels]) => [target, [...levels]]),
                    renderbufferImage: c.renderbufferImage,
                    defaultFramebufferState: c.defaultFramebufferState,
                    drawFramebuffer: c.drawFramebuffer, readFramebuffer: c.readFramebuffer, renderbuffer: c.renderbuffer,
                    drawBuffers: c.drawBuffers, readBuffer: c.readBuffer })),
            };
        },
        setState(shadow, state) {
            const saved = state.objects;
            if (!saved) return;
            for (const g of saved.groups) {
                const group = shadow.groups.get(g.key);
                if (!group) continue;
                group.nextImageId = g.nextImageId || 1;
                group.nextFramebufferId = g.nextFramebufferId || 1;
                for (const fbo of g.framebuffers || []) group.framebufferObjects.set(fbo.id, fbo);
                for (const [n, id] of g.sharedFramebuffers || []) group.sharedFramebuffers.set(n, group.framebufferObjects.get(id));
                for (const [n, id] of g.framebufferReservations || []) group.framebufferReservations.set(n, group.framebufferObjects.get(id));
                for (const [name, target, levels, savedId, deleted, parameters] of g.textures) {
                    const t = { name, target, levels: levelsIn(levels), id: savedId || group.nextImageId++, deleted: !!deleted, parameters };
                    group.textureImages.set(t.id, t); if (name && !deleted) group.textures.set(name, t);
                }
                for (const savedRb of g.renderbuffers) {
                    const rb = { ...savedRb, id: savedRb.id || group.nextImageId++ };
                    if (!rb.componentBits) {
                        const storage = rb.width && rb.height ? formats.renderbufferFormatFor(rb.internalFormat, shadow.capabilities?.features) : null;
                        rb.internalFormat = storage ? storage.internalFormat || rb.internalFormat : GL.RGBA;
                        rb.componentBits = storage ? storage.components : [0, 0, 0, 0, 0, 0];
                        if (!storage) rb.width = rb.height = 0;
                    }
                    group.renderbufferImages.set(rb.id, rb); if (!rb.deleted) group.renderbuffers.set(rb.name, rb);
                }
            }
            for (const c of saved.contexts) {
                const context = shadow.contexts.get(c.key);
                if (!context) continue;
                Object.assign(context, { activeTexture: c.activeTexture, units: c.units.map(unit => new Map(unit)),
                    unitImages: c.unitImages ? c.unitImages.map(unit => new Map(unit)) : c.units.map(unit =>
                        new Map(unit.map(([target, name]) => [target, context.group.textures.get(name)?.id]))),
                    defaultTextures: new Map(c.defaultTextures || []),
                    proxyImages: new Map((c.proxyImages || []).map(([target, levels]) => [target, new Map(levels)])),
                    renderbufferImage: c.renderbufferImage || context.group.renderbuffers.get(c.renderbuffer)?.id || 0,
                    framebuffers: new Map(saved.version >= 3 ? c.framebuffers.map(([n, id]) => [n, context.group.framebufferObjects.get(id)]) : c.framebuffers.map(fbo => [fbo.name, fbo])), drawFramebuffer: c.drawFramebuffer,
                    readFramebuffer: c.readFramebuffer, renderbuffer: c.renderbuffer, drawBuffers: c.drawBuffers,
                    readBuffer: c.readBuffer });
                context.defaultFramebufferState = c.defaultFramebufferState || buffers.initial(GL.BACK);
                if (saved.version >= 3) {
                    context.privateFramebuffers = new Map(c.privateFramebuffers.map(([n, id]) => [n, context.group.framebufferObjects.get(id)]));
                    context.drawFramebufferObject = context.group.framebufferObjects.get(c.drawFramebufferId) || null;
                    context.readFramebufferObject = context.group.framebufferObjects.get(c.readFramebufferId) || null;
                } else {
                    for (const fbo of context.framebuffers.values()) {
                        fbo.id = context.group.nextFramebufferId++; fbo.shared = false; fbo.deleted = false;
                        context.group.framebufferObjects.set(fbo.id, fbo);
                        (fbo.created === false ? context.group.framebufferReservations : context.privateFramebuffers).set(fbo.name, fbo);
                    }
                    context.drawFramebufferObject = context.framebuffers.get(c.drawFramebuffer) || null;
                    context.readFramebufferObject = context.framebuffers.get(c.readFramebuffer) || null;
                }
                for (const fbo of context.framebuffers.values()) {
                    if (!fbo.drawBuffers) fbo.drawBuffers = fbo.name === c.drawFramebuffer ? c.drawBuffers.slice() : [GL.COLOR_ATTACHMENT0];
                    if (fbo.readBuffer === undefined) fbo.readBuffer = fbo.name === c.readFramebuffer ? c.readBuffer : GL.COLOR_ATTACHMENT0;
                }
                if (!c.defaultFramebufferState) {
                    if (!c.drawFramebuffer) context.defaultFramebufferState.drawBuffers = c.drawBuffers.slice();
                    if (!c.readFramebuffer) context.defaultFramebufferState.readBuffer = c.readBuffer;
                }
                context.buffersInitialized = true;
                buffers.sync(context, context.framebuffers);
                if (!saved.version) for (const fbo of context.framebuffers.values())
                    for (const r of [...fbo.color, fbo.depth, fbo.stencil]) if (r)
                        r.id = (r.kind === "texture" ? context.group.textures : context.group.renderbuffers).get(r.name)?.id;
            }
        },
    });
})(typeof globalThis !== "undefined" ? globalThis : this);
