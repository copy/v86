// Image storage decisions shared by the CPU metadata and the renderer.
(function(global) {
    "use strict";
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const PROXY_TARGETS = new Map([[GL.PROXY_TEXTURE_1D, GL.TEXTURE_1D], [GL.PROXY_TEXTURE_2D, GL.TEXTURE_2D],
        [GL.PROXY_TEXTURE_3D, GL.TEXTURE_3D], [GL.PROXY_TEXTURE_CUBE_MAP, GL.TEXTURE_CUBE_MAP]]);
    const BASE_INTERNAL_FORMATS = {
        [GL.ALPHA]: "ALPHA", [GL.ALPHA4]: "ALPHA", [GL.ALPHA8]: "ALPHA",
        [GL.ALPHA12]: "ALPHA", [GL.ALPHA16]: "ALPHA",
        [GL.LUMINANCE]: "LUMINANCE", [GL.LUMINANCE4]: "LUMINANCE",
        [GL.LUMINANCE8]: "LUMINANCE", [GL.LUMINANCE12]: "LUMINANCE",
        [GL.LUMINANCE16]: "LUMINANCE",
        [GL.LUMINANCE_ALPHA]: "LUMINANCE_ALPHA",
        [GL.LUMINANCE4_ALPHA4]: "LUMINANCE_ALPHA",
        [GL.LUMINANCE8_ALPHA8]: "LUMINANCE_ALPHA",
        [GL.LUMINANCE12_ALPHA12]: "LUMINANCE_ALPHA",
        [GL.LUMINANCE16_ALPHA16]: "LUMINANCE_ALPHA",
        0x8044: "LUMINANCE_ALPHA", 0x8046: "LUMINANCE_ALPHA", // LUMINANCE6_ALPHA2 / LUMINANCE12_ALPHA4
        [GL.INTENSITY]: "INTENSITY", [GL.INTENSITY8]: "INTENSITY",
        [GL.INTENSITY16]: "INTENSITY",
        0x804A: "INTENSITY", 0x804C: "INTENSITY", // INTENSITY4/12
        [GL.RGB]: "RGB", [GL.RGB4]: "RGB", [GL.RGB5]: "RGB", [GL.RGB8]: "RGB",
        [GL.RGB10]: "RGB", [GL.RGB12]: "RGB", [GL.RGB16]: "RGB",
        [GL.R3_G3_B2]: "RGB", [GL.RGB565]: "RGB",
        [GL.RGBA]: "RGBA", [GL.RGBA2]: "RGBA", [GL.RGBA4]: "RGBA",
        [GL.RGB5_A1]: "RGBA", [GL.RGBA8]: "RGBA", [GL.RGB10_A2]: "RGBA",
        [GL.RGBA12]: "RGBA", [GL.RGBA16]: "RGBA",
        [GL.BGR]: "RGB", [GL.BGRA]: "RGBA",
        3: "RGB", 4: "RGBA", 1: "LUMINANCE", 2: "LUMINANCE_ALPHA",
        [GL.DEPTH_COMPONENT]: "DEPTH",
        [GL.DEPTH_COMPONENT16]: "DEPTH",
        [GL.DEPTH_COMPONENT24]: "DEPTH",
        [GL.DEPTH_COMPONENT32]: "DEPTH",
        [GL.SRGB]: "RGB", [GL.SRGB8]: "RGB",
        [GL.SRGB_ALPHA]: "RGBA", [GL.SRGB8_ALPHA8]: "RGBA",
        [GL.RGBA16F_ARB]: "RGBA", [GL.RGBA32F_ARB]: "RGBA",
        [GL.RGB16F_ARB]: "RGB", [GL.RGB32F_ARB]: "RGB",
        [GL.ALPHA16F_ARB]: "ALPHA", [GL.ALPHA32F_ARB]: "ALPHA",
        [GL.LUMINANCE16F_ARB]: "LUMINANCE", [GL.LUMINANCE32F_ARB]: "LUMINANCE",
        [GL.LUMINANCE_ALPHA16F_ARB]: "LUMINANCE_ALPHA", [GL.LUMINANCE_ALPHA32F_ARB]: "LUMINANCE_ALPHA",
        0x881D: "INTENSITY", 0x8817: "INTENSITY", // INTENSITY16F/32F_ARB
        [GL.SLUMINANCE]: "LUMINANCE", [GL.SLUMINANCE8]: "LUMINANCE",
        [GL.SLUMINANCE_ALPHA]: "LUMINANCE_ALPHA", [GL.SLUMINANCE8_ALPHA8]: "LUMINANCE_ALPHA",
        [GL.COMPRESSED_ALPHA]: "ALPHA", [GL.COMPRESSED_LUMINANCE]: "LUMINANCE",
        [GL.COMPRESSED_LUMINANCE_ALPHA]: "LUMINANCE_ALPHA", [GL.COMPRESSED_INTENSITY]: "INTENSITY",
        [GL.COMPRESSED_RGB]: "RGB", [GL.COMPRESSED_RGBA]: "RGBA",
        [GL.COMPRESSED_SRGB]: "RGB", [GL.COMPRESSED_SRGB_ALPHA]: "RGBA",
        [GL.COMPRESSED_SLUMINANCE]: "LUMINANCE", [GL.COMPRESSED_SLUMINANCE_ALPHA]: "LUMINANCE_ALPHA",
        [GL.COLOR_INDEX]: "COLOR_INDEX",
        [GL.COLOR_INDEX8_EXT]: "COLOR_INDEX",
        0x80E2: "COLOR_INDEX", 0x80E3: "COLOR_INDEX", 0x80E4: "COLOR_INDEX", // COLOR_INDEX1/2/4_EXT
        0x80E6: "COLOR_INDEX", 0x80E7: "COLOR_INDEX", // COLOR_INDEX12/16_EXT
    };

    const COMPRESSED_FORMATS = {
        [GL.COMPRESSED_RGB_S3TC_DXT1_EXT]:
            { gpu: "bc1-rgba-unorm", blockBytes: 8, base: "RGB", dxt: 1 },
        [GL.COMPRESSED_RGBA_S3TC_DXT1_EXT]:
            { gpu: "bc1-rgba-unorm", blockBytes: 8, base: "RGBA", dxt: 1 },
        [GL.COMPRESSED_RGBA_S3TC_DXT3_EXT]:
            { gpu: "bc2-rgba-unorm", blockBytes: 16, base: "RGBA", dxt: 3 },
        [GL.COMPRESSED_RGBA_S3TC_DXT5_EXT]:
            { gpu: "bc3-rgba-unorm", blockBytes: 16, base: "RGBA", dxt: 5 },
    };

    // GL 2.1 section 3.8.1 makes only the legacy component counts aliases
    // of the corresponding base formats. A base format and a sized format
    // remain distinct for mip/cube completeness (section 3.8.10).
    function textureInternalFormatKey(format) {
        return [0, GL.LUMINANCE, GL.LUMINANCE_ALPHA, GL.RGB, GL.RGBA][format] || format;
    }

    function storageFormatFor(internalFormat, features) {
        const compressed = COMPRESSED_FORMATS[internalFormat];
        if (compressed) {
            // Without the BC feature the blocks are decoded on the CPU rather
            // than the extension being withdrawn, because the guest may have
            // already been told S3TC exists. The decode is deterministic, so
            // the picture is identical; only the memory cost differs.
            return features && features.bc ?
                { gpu: compressed.gpu, compressed: true, blockBytes: compressed.blockBytes,
                  base: compressed.base, dxt: compressed.dxt } :
                { gpu: "rgba8unorm", compressed: false, decodeDXT: compressed.dxt,
                  base: compressed.base, blockBytes: compressed.blockBytes };
        }
        const base = BASE_INTERNAL_FORMATS[internalFormat];
        switch (internalFormat) {
        case GL.DEPTH_COMPONENT:
        case GL.DEPTH_COMPONENT24:
            // depth24plus has an implementation-defined texel layout and cannot
            // receive queue.writeTexture data. depth32float preserves uploaded
            // depth values and remains renderable/sampleable on core WebGPU.
            return { gpu: "depth32float", depth: true, base: "DEPTH" };
        case GL.DEPTH_COMPONENT16:
            return { gpu: "depth16unorm", depth: true, base: "DEPTH" };
        case GL.DEPTH_COMPONENT32:
            return { gpu: "depth32float", depth: true, base: "DEPTH" };
        case GL.SRGB:
        case GL.SRGB8:
        case GL.SRGB_ALPHA:
        case GL.SRGB8_ALPHA8:
        case GL.SLUMINANCE:
        case GL.SLUMINANCE8:
        case GL.SLUMINANCE_ALPHA:
        case GL.SLUMINANCE8_ALPHA8:
        case GL.COMPRESSED_SRGB:
        case GL.COMPRESSED_SRGB_ALPHA:
        case GL.COMPRESSED_SLUMINANCE:
        case GL.COMPRESSED_SLUMINANCE_ALPHA:
            return { gpu: "rgba8unorm-srgb", base: base || "RGBA" };
        case GL.RGBA16F_ARB:
        case GL.RGB16F_ARB:
        case GL.ALPHA16F_ARB:
        case GL.LUMINANCE16F_ARB:
        case GL.LUMINANCE_ALPHA16F_ARB:
        case 0x881D:
            return { gpu: "rgba16float", base: base || "RGBA", float: true };
        case GL.RGBA32F_ARB:
        case GL.RGB32F_ARB:
        case GL.ALPHA32F_ARB:
        case GL.LUMINANCE32F_ARB:
        case GL.LUMINANCE_ALPHA32F_ARB:
        case 0x8817:
            return { gpu: "rgba32float", base: base || "RGBA", float: true };
        case GL.COLOR_INDEX:
        case GL.COLOR_INDEX8_EXT:
        case 0x80E2:
        case 0x80E3:
        case 0x80E4:
        case 0x80E6:
        case 0x80E7:
            // Palettised textures keep their index on the GPU and are resolved
            // in the shader, the same way the D3D9 path handles P8.
            return { gpu: "r8uint", base: "COLOR_INDEX", palettised: true };
        default:
            return { gpu: "rgba8unorm", base: base || "RGBA",
                ...(SIZED_BITS[internalFormat] ? { bits: SIZED_BITS[internalFormat] } : {}) };
        }
    }

    /*
     * The bits a sized internal format keeps per channel (R, G, B, A), when
     * fewer than eight: the image is stored at that precision as GL does
     * (review S2-22: RGB5_A1 kept an alpha of 100 that has one bit)
     */
    const SIZED_BITS = {
        [GL.R3_G3_B2]: [3, 3, 2, 8], [GL.RGB4]: [4, 4, 4, 8], [GL.RGB5]: [5, 5, 5, 8],
        [GL.RGBA2]: [2, 2, 2, 2], [GL.RGBA4]: [4, 4, 4, 4], [GL.RGB5_A1]: [5, 5, 5, 1],
        [GL.ALPHA4]: [8, 8, 8, 4], [GL.LUMINANCE4]: [4, 4, 4, 8], [GL.LUMINANCE4_ALPHA4]: [4, 4, 4, 4],
        0x804A: [4, 4, 4, 4],
    };


    function renderbufferFormatFor(format, features) {
        const stencil = [GL.STENCIL_INDEX, GL.STENCIL_INDEX1_EXT, GL.STENCIL_INDEX4_EXT, GL.STENCIL_INDEX8_EXT, GL.STENCIL_INDEX16_EXT];
        if (stencil.includes(format)) return { gpu: "depth24plus-stencil8", base: "STENCIL", components: [0, 0, 0, 0, 0, 8] };
        if ([GL.DEPTH_STENCIL, GL.DEPTH24_STENCIL8].includes(format))
            return { gpu: "depth24plus-stencil8", base: "DEPTH_STENCIL", components: [0, 0, 0, 0, 24, 8] };
        if ([GL.DEPTH_COMPONENT, GL.DEPTH_COMPONENT16, GL.DEPTH_COMPONENT24, GL.DEPTH_COMPONENT32, GL.DEPTH_COMPONENT32F].includes(format)) {
            const bits = format === GL.DEPTH_COMPONENT16 ? 16 : 32;
            return { gpu: bits === 16 ? "depth16unorm" : "depth32float", base: "DEPTH", depth: true,
                internalFormat: bits === 16 ? GL.DEPTH_COMPONENT16 : format === GL.DEPTH_COMPONENT32F ? format : GL.DEPTH_COMPONENT32,
                components: [0, 0, 0, 0, bits, 0] };
        }
        const base = BASE_INTERNAL_FORMATS[format];
        if (!["RGB", "RGBA"].includes(base) || format < 5 || [GL.BGR, GL.BGRA, GL.RGB565].includes(format)) return null;
        const storage = storageFormatFor(format, features);
        const bits = storage.gpu === "rgba32float" ? 32 : storage.gpu === "rgba16float" ? 16 : 8;
        return { ...storage, components: [bits, bits, bits, base === "RGBA" ? bits : 0, 0, 0] };
    }

    // Effective component resolutions, including the low-bit quantization
    // performed before uploading to RGBA8 storage. Missing channels stay zero.
    function textureComponents(format, compressed, features) {
        const storage = storageFormatFor(format, features), base = storage.base;
        const dxt = compressed && COMPRESSED_FORMATS[format];
        if (dxt) return [5, 6, 5, base === "RGBA" ? dxt.dxt === 1 ? 1 : dxt.dxt === 3 ? 4 : 8 : 0, 0, 0, 0, 0, 0];
        if (storage.depth) return [0, 0, 0, 0, 0, 0, storage.gpu === "depth16unorm" ? 16 : 32, 0, 0];
        if (storage.palettised) return [0, 0, 0, 0, 0, 0, 0, 0, 8];
        const n = storage.gpu === "rgba16float" ? 16 : storage.gpu === "rgba32float" ? 32 : 8;
        const bits = storage.bits || [n, n, n, n];
        return [base === "RGB" || base === "RGBA" ? bits[0] : 0,
            base === "RGB" || base === "RGBA" ? bits[1] : 0,
            base === "RGB" || base === "RGBA" ? bits[2] : 0,
            ["RGBA", "ALPHA", "LUMINANCE_ALPHA"].includes(base) ? bits[3] : 0,
            base === "LUMINANCE" || base === "LUMINANCE_ALPHA" ? bits[0] : 0,
            base === "INTENSITY" ? bits[0] : 0, 0, 0, 0];
    }

    const UNCOMPRESSED_HINTS = new Map([
        [GL.COMPRESSED_ALPHA, GL.ALPHA], [GL.COMPRESSED_LUMINANCE, GL.LUMINANCE],
        [GL.COMPRESSED_LUMINANCE_ALPHA, GL.LUMINANCE_ALPHA], [GL.COMPRESSED_INTENSITY, GL.INTENSITY],
        [GL.COMPRESSED_RGB, GL.RGB], [GL.COMPRESSED_RGBA, GL.RGBA],
        [GL.COMPRESSED_SRGB, GL.SRGB], [GL.COMPRESSED_SRGB_ALPHA, GL.SRGB_ALPHA],
        [GL.COMPRESSED_SLUMINANCE, GL.SLUMINANCE], [GL.COMPRESSED_SLUMINANCE_ALPHA, GL.SLUMINANCE_ALPHA],
    ]);
    function uncompressedInternalFormat(format) {
        const block = COMPRESSED_FORMATS[format];
        return block ? block.base === "RGB" ? GL.RGB : GL.RGBA : UNCOMPRESSED_HINTS.get(format) || format;
    }

    const api = { BASE_INTERNAL_FORMATS, COMPRESSED_FORMATS, SIZED_BITS, PROXY_TARGETS, textureInternalFormatKey, storageFormatFor,
        renderbufferFormatFor, textureComponents, uncompressedInternalFormat };
    global.GLImageFormats = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
