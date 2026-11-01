// Pure D3D texture format conversion and readback packing. No GPU/owner state.
(function(global) {
    "use strict";
    const D3DFMT_R8G8B8 = 20;
    const D3DFMT_A8R8G8B8 = 21;
    const D3DFMT_X8R8G8B8 = 22;
    const D3DFMT_R5G6B5 = 23;
    const D3DFMT_X1R5G5B5 = 24;
    const D3DFMT_A1R5G5B5 = 25;
    const D3DFMT_A4R4G4B4 = 26;
    const D3DFMT_R3G3B2 = 27;
    const D3DFMT_A8 = 28;
    const D3DFMT_A8R3G3B2 = 29;
    const D3DFMT_X4R4G4B4 = 30;
    const D3DFMT_A2B10G10R10 = 31;
    const D3DFMT_A8B8G8R8 = 32;
    const D3DFMT_X8B8G8R8 = 33;
    const D3DFMT_G16R16 = 34;
    const D3DFMT_A2R10G10B10 = 35;
    const D3DFMT_A16B16G16R16 = 36;
    const D3DFMT_L8 = 50;
    const D3DFMT_A8L8 = 51;
    const D3DFMT_A4L4 = 52;
    const D3DFMT_V8U8 = 60;
    const D3DFMT_L6V5U5 = 61;
    const D3DFMT_X8L8V8U8 = 62;
    const D3DFMT_Q8W8V8U8 = 63;
    const D3DFMT_V16U16 = 64;
    const D3DFMT_W11V11U10 = 65;
    const D3DFMT_A2W10V10U10 = 67;
    const D3DFMT_L16 = 81;
    const D3DFMT_R16F = 111;
    const D3DFMT_G16R16F = 112;
    const D3DFMT_A16B16G16R16F = 113;
    const D3DFMT_R32F = 114;
    const D3DFMT_G32R32F = 115;
    const D3DFMT_A32B32G32R32F = 116;
    const D3DFMT_CxV8U8 = 117;
    const D3DFMT_P8 = 41;
    const D3DFMT_A8P8 = 40;
    const D3DFMT_Q16W16V16U16 = 110;
    const D3DFMT_UYVY = 0x59565955;
    const D3DFMT_YUY2 = 0x32595559;
    const D3DFMT_R8G8_B8G8 = 0x47424752;
    const D3DFMT_G8R8_G8B8 = 0x42475247;
    const D3DFMT_DF16 = 0x36314644;
    const D3DFMT_DF24 = 0x34324644;
    const D3DFMT_INTZ = 0x5A544E49;
    const D3DFMT_ATI1N = 0x31495441;
    const D3DFMT_ATI2N = 0x32495441;
    const D3DFMT_NULL = 0x4C4C554E;
    const D3DFMT_DXT1 = 0x31545844;
    const D3DFMT_DXT2 = 0x32545844;
    const D3DFMT_DXT3 = 0x33545844;
    const D3DFMT_DXT4 = 0x34545844;
    const D3DFMT_DXT5 = 0x35545844;
    const D3DFMT_INDEX16 = 101;
    const D3DFMT_INDEX32 = 102;

    function srgbSiblingOf(gpuFormat) {
        return {
            "bgra8unorm": "bgra8unorm-srgb",
            "rgba8unorm": "rgba8unorm-srgb",
            "bc1-rgba-unorm": "bc1-rgba-unorm-srgb",
            "bc2-rgba-unorm": "bc2-rgba-unorm-srgb",
            "bc3-rgba-unorm": "bc3-rgba-unorm-srgb",
        }[gpuFormat] || null;
    }

    function isCompressedFormat(format) {
        return format === D3DFMT_DXT1 || format === D3DFMT_DXT2 ||
            format === D3DFMT_DXT3 || format === D3DFMT_DXT4 ||
            format === D3DFMT_DXT5 ||
            format === D3DFMT_ATI1N || format === D3DFMT_ATI2N;
    }

    function compressedBlockBytes(format) {
        return (format === D3DFMT_DXT1 || format === D3DFMT_ATI1N) ? 8 : 16;
    }

    function blockAlignedCopyExtent(size, compressed) {
        return compressed ? Math.ceil(size / 4) * 4 : size;
    }

    function isFourCCDepthFormat(format) {
        return format === D3DFMT_DF16 || format === D3DFMT_DF24 ||
            format === D3DFMT_INTZ;
    }

    function isPalettizedFormat(format) {
        return format === D3DFMT_P8 || format === D3DFMT_A8P8;
    }

    function isPackedPairFormat(format) {
        return format === D3DFMT_UYVY || format === D3DFMT_YUY2 ||
            format === D3DFMT_R8G8_B8G8 || format === D3DFMT_G8R8_G8B8;
    }

    function isHalfFloatExpansionFormat(format) {
        return format === D3DFMT_Q16W16V16U16 ||
            format === D3DFMT_L6V5U5 || format === D3DFMT_X8L8V8U8 ||
            format === D3DFMT_V16U16 || format === D3DFMT_W11V11U10 ||
            format === D3DFMT_A2W10V10U10 ||
            format === D3DFMT_L16 || format === D3DFMT_CxV8U8 ||
            format === D3DFMT_A2B10G10R10 || format === D3DFMT_G16R16 ||
            format === D3DFMT_A2R10G10B10 ||
            format === D3DFMT_A16B16G16R16 || format === D3DFMT_R16F ||
            format === D3DFMT_G16R16F ||
            format === D3DFMT_A16B16G16R16F;
    }

    function gpuBytesPerTexel(format) {
        if (isHalfFloatExpansionFormat(format)) return 8;
        if (format === D3DFMT_G32R32F) return 8;
        if (format === D3DFMT_A32B32G32R32F) return 16;
        return 4;
    }

    function fullMipLevelCount(width, height) {
        let levels = 1;
        let w = width, h = height;
        while (w > 1 || h > 1) {
            if (w > 1) w >>= 1;
            if (h > 1) h >>= 1;
            ++levels;
        }
        return levels;
    }

    function isRenderableGPUFormat(format) {
        return format === "rgba8unorm" || format === "bgra8unorm" || format === "rgba16float" ||
            format === "r32float" || format === "rg32float" ||
            format === "rgba32float" ||
            // The NULL FOURCC target's stand-in. It is renderable by
            // definition -- being a render target nothing reads is its whole
            // purpose -- and r8unorm is the cheapest format that can be one.
            format === "r8unorm" ||
            // Protocol 1.7: the storage a DirectDraw palettised surface uses.
            // It has to be an attachment because a 2D title's whole frame is
            // built by blitting P8 sprites into a P8 back buffer.
            format === "r8uint";
    }

    function isFloat32GPUFormat(format) {
        return format === "r32float" || format === "rg32float" ||
            format === "rgba32float";
    }

    function isBlendableGPUFormat(format, features) {
        return !isFloat32GPUFormat(format) ||
            !!(features && features.float32Blendable);
    }

    const GPU_STORAGE = Object.freeze({
        [D3DFMT_R8G8B8]: "rgba8unorm",
        [D3DFMT_A8R8G8B8]: "bgra8unorm",
        [D3DFMT_X8R8G8B8]: "rgba8unorm",
        [D3DFMT_X1R5G5B5]: "rgba8unorm",
        [D3DFMT_A1R5G5B5]: "rgba8unorm",
        [D3DFMT_A4R4G4B4]: "rgba8unorm",
        [D3DFMT_R3G3B2]: "rgba8unorm",
        [D3DFMT_A8R3G3B2]: "rgba8unorm",
        [D3DFMT_X4R4G4B4]: "rgba8unorm",
        [D3DFMT_A8B8G8R8]: "rgba8unorm",
        [D3DFMT_X8B8G8R8]: "rgba8unorm",
        [D3DFMT_R5G6B5]: "rgba8unorm",
        [D3DFMT_L8]: "rgba8unorm",
        [D3DFMT_A8]: "rgba8unorm",
        [D3DFMT_A8L8]: "rgba8unorm",
        [D3DFMT_A4L4]: "rgba8unorm",
        [D3DFMT_P8]: "rgba8unorm",
        [D3DFMT_A8P8]: "rgba8unorm",
        [D3DFMT_UYVY]: "rgba8unorm",
        [D3DFMT_YUY2]: "rgba8unorm",
        [D3DFMT_R8G8_B8G8]: "rgba8unorm",
        [D3DFMT_G8R8_G8B8]: "rgba8unorm",
        [D3DFMT_INDEX16]: "rgba8unorm",
        [D3DFMT_INDEX32]: "rgba8unorm",
        [D3DFMT_V8U8]: "rgba8snorm",
        [D3DFMT_Q8W8V8U8]: "rgba8snorm",
        [D3DFMT_L6V5U5]: "rgba16float",
        [D3DFMT_X8L8V8U8]: "rgba16float",
        [D3DFMT_V16U16]: "rgba16float",
        [D3DFMT_W11V11U10]: "rgba16float",
        [D3DFMT_A2W10V10U10]: "rgba16float",
        [D3DFMT_L16]: "rgba16float",
        [D3DFMT_CxV8U8]: "rgba16float",
        [D3DFMT_A2B10G10R10]: "rgba16float",
        [D3DFMT_G16R16]: "rgba16float",
        [D3DFMT_A2R10G10B10]: "rgba16float",
        [D3DFMT_A16B16G16R16]: "rgba16float",
        [D3DFMT_Q16W16V16U16]: "rgba16float",
        [D3DFMT_R16F]: "rgba16float",
        [D3DFMT_G16R16F]: "rgba16float",
        [D3DFMT_A16B16G16R16F]: "rgba16float",
        [D3DFMT_R32F]: "r32float",
        [D3DFMT_G32R32F]: "rg32float",
        [D3DFMT_A32B32G32R32F]: "rgba32float",
        [D3DFMT_DXT1]: "bc1-rgba-unorm",
        [D3DFMT_DXT2]: "bc2-rgba-unorm",
        [D3DFMT_DXT3]: "bc2-rgba-unorm",
        [D3DFMT_DXT4]: "bc3-rgba-unorm",
        [D3DFMT_DXT5]: "bc3-rgba-unorm",
        [D3DFMT_ATI1N]: "bc4-r-unorm",
        [D3DFMT_ATI2N]: "bc5-rg-unorm",
        [D3DFMT_NULL]: "r8unorm"
    });
    function formatToGPU(format) { return GPU_STORAGE[format] || null; }

    const HALF_BITS_BUFFER = new ArrayBuffer(4);

    const HALF_BITS_F32 = new Float32Array(HALF_BITS_BUFFER);

    const HALF_BITS_U32 = new Uint32Array(HALF_BITS_BUFFER);

    function floatToHalfBits(value) {
        HALF_BITS_F32[0] = value;
        const bits = HALF_BITS_U32[0];
        const sign = (bits >>> 16) & 0x8000;
        let exponent = (bits >>> 23) & 0xff;
        let mantissa = bits & 0x7fffff;
        if (exponent === 0xff)
            return sign | (mantissa ? 0x7e00 : 0x7c00);
        exponent = exponent - 127 + 15;
        if (exponent >= 31) return sign | 0x7c00;
        if (exponent <= 0) {
            if (exponent < -10) return sign;
            const normalized = mantissa | 0x800000;
            const shift = 14 - exponent;
            let halfMantissa = normalized >>> shift;
            const remainderMask = (1 << shift) - 1;
            const remainder = normalized & remainderMask;
            const halfway = 1 << (shift - 1);
            if (remainder > halfway ||
                    (remainder === halfway && (halfMantissa & 1)))
                ++halfMantissa;
            return sign | halfMantissa;
        }
        let halfMantissa = mantissa >>> 13;
        const remainder = mantissa & 0x1fff;
        if (remainder > 0x1000 ||
                (remainder === 0x1000 && (halfMantissa & 1))) {
            ++halfMantissa;
            if (halfMantissa === 0x400) {
                halfMantissa = 0;
                if (++exponent >= 31) return sign | 0x7c00;
            }
        }
        return sign | (exponent << 10) | halfMantissa;
    }

    function writeHalf(dest, offset, value) {
        const bits = floatToHalfBits(value);
        dest[offset] = bits & 0xff;
        dest[offset + 1] = bits >>> 8;
    }

    function halfBitsToFloat(bits) {
        const sign = (bits & 0x8000) ? -1 : 1;
        const exponent = (bits >>> 10) & 0x1f;
        const mantissa = bits & 0x3ff;
        if (!exponent)
            return mantissa ? sign * Math.pow(2, -14) * mantissa / 1024
                : sign === -1 ? -0 : 0;
        if (exponent === 0x1f)
            return mantissa ? NaN : sign * Infinity;
        return sign * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
    }

    function d3dBytesPerTexel(format) {
        switch (format) {
        case D3DFMT_R5G6B5:
        case D3DFMT_X1R5G5B5:
        case D3DFMT_A1R5G5B5:
        case D3DFMT_A4R4G4B4:
        case D3DFMT_R16F:
            return 2;
        case D3DFMT_A8R8G8B8:
        case D3DFMT_X8R8G8B8:
        case D3DFMT_A2B10G10R10:
        case D3DFMT_A2R10G10B10:
        case D3DFMT_G16R16F:
        case D3DFMT_R32F:
            return 4;
        case D3DFMT_A16B16G16R16F:
        case D3DFMT_G32R32F:
            return 8;
        case D3DFMT_A32B32G32R32F:
            return 16;
        default:
            return 0;
        }
    }

    function packGPUReadbackRow(format, gpuFormat, source, sourceOffset,
            width, destination, destinationOffset) {
        const sourceView = new DataView(source.buffer,
            source.byteOffset, source.byteLength);
        const destinationView = new DataView(destination.buffer,
            destination.byteOffset, destination.byteLength);
        const sourceBpp = gpuFormat === "rgba16float" ? 8
            : gpuFormat === "rg32float" ? 8
            : gpuFormat === "rgba32float" ? 16 : 4;
        const destinationBpp = d3dBytesPerTexel(format);
        const clamp = value => Math.max(0, Math.min(1,
            Number.isFinite(value) ? value : 0));
        const unorm = (value, maximum) =>
            Math.round(clamp(value) * maximum);
        for (let x = 0; x < width; ++x) {
            const sourceAt = sourceOffset + x * sourceBpp;
            const destinationAt = destinationOffset + x * destinationBpp;
            let r, g, b, a;
            if (gpuFormat === "rgba16float") {
                r = halfBitsToFloat(sourceView.getUint16(sourceAt, true));
                g = halfBitsToFloat(sourceView.getUint16(sourceAt + 2, true));
                b = halfBitsToFloat(sourceView.getUint16(sourceAt + 4, true));
                a = halfBitsToFloat(sourceView.getUint16(sourceAt + 6, true));
            } else if (gpuFormat === "r32float") {
                r = sourceView.getFloat32(sourceAt, true); g = b = 0; a = 1;
            } else if (gpuFormat === "rg32float") {
                r = sourceView.getFloat32(sourceAt, true);
                g = sourceView.getFloat32(sourceAt + 4, true); b = 0; a = 1;
            } else if (gpuFormat === "rgba32float") {
                r = sourceView.getFloat32(sourceAt, true);
                g = sourceView.getFloat32(sourceAt + 4, true);
                b = sourceView.getFloat32(sourceAt + 8, true);
                a = sourceView.getFloat32(sourceAt + 12, true);
            } else if (gpuFormat === "bgra8unorm" ||
                    gpuFormat === "bgra8unorm-srgb") {
                b = source[sourceAt] / 255; g = source[sourceAt + 1] / 255;
                r = source[sourceAt + 2] / 255; a = source[sourceAt + 3] / 255;
            } else {
                r = source[sourceAt] / 255; g = source[sourceAt + 1] / 255;
                b = source[sourceAt + 2] / 255; a = source[sourceAt + 3] / 255;
            }
            switch (format) {
            case D3DFMT_A8R8G8B8:
            case D3DFMT_X8R8G8B8:
                destination[destinationAt] = unorm(b, 255);
                destination[destinationAt + 1] = unorm(g, 255);
                destination[destinationAt + 2] = unorm(r, 255);
                destination[destinationAt + 3] = format === D3DFMT_A8R8G8B8
                    ? unorm(a, 255) : 0xff;
                break;
            case D3DFMT_R5G6B5:
                destinationView.setUint16(destinationAt,
                    (unorm(r, 31) << 11) | (unorm(g, 63) << 5) |
                    unorm(b, 31), true);
                break;
            case D3DFMT_X1R5G5B5:
            case D3DFMT_A1R5G5B5:
                destinationView.setUint16(destinationAt,
                    ((format === D3DFMT_X1R5G5B5 ? 1 : unorm(a, 1)) << 15) |
                    (unorm(r, 31) << 10) | (unorm(g, 31) << 5) |
                    unorm(b, 31), true);
                break;
            case D3DFMT_A4R4G4B4:
                destinationView.setUint16(destinationAt,
                    (unorm(a, 15) << 12) | (unorm(r, 15) << 8) |
                    (unorm(g, 15) << 4) | unorm(b, 15), true);
                break;
            case D3DFMT_A2B10G10R10:
                destinationView.setUint32(destinationAt,
                    (unorm(r, 1023) | (unorm(g, 1023) << 10) |
                    (unorm(b, 1023) << 20) | (unorm(a, 3) << 30)) >>> 0,
                    true);
                break;
            case D3DFMT_A2R10G10B10:
                destinationView.setUint32(destinationAt,
                    (unorm(b, 1023) | (unorm(g, 1023) << 10) |
                    (unorm(r, 1023) << 20) | (unorm(a, 3) << 30)) >>> 0,
                    true);
                break;
            case D3DFMT_R16F:
                destinationView.setUint16(destinationAt,
                    floatToHalfBits(r), true);
                break;
            case D3DFMT_G16R16F:
                destinationView.setUint16(destinationAt,
                    floatToHalfBits(r), true);
                destinationView.setUint16(destinationAt + 2,
                    floatToHalfBits(g), true);
                break;
            case D3DFMT_A16B16G16R16F:
                destinationView.setUint16(destinationAt,
                    floatToHalfBits(r), true);
                destinationView.setUint16(destinationAt + 2,
                    floatToHalfBits(g), true);
                destinationView.setUint16(destinationAt + 4,
                    floatToHalfBits(b), true);
                destinationView.setUint16(destinationAt + 6,
                    floatToHalfBits(a), true);
                break;
            case D3DFMT_R32F:
                destinationView.setFloat32(destinationAt, r, true);
                break;
            case D3DFMT_G32R32F:
                destinationView.setFloat32(destinationAt, r, true);
                destinationView.setFloat32(destinationAt + 4, g, true);
                break;
            case D3DFMT_A32B32G32R32F:
                destinationView.setFloat32(destinationAt, r, true);
                destinationView.setFloat32(destinationAt + 4, g, true);
                destinationView.setFloat32(destinationAt + 8, b, true);
                destinationView.setFloat32(destinationAt + 12, a, true);
                break;
            default:
                throw new Error("unsupported render-target readback format " +
                    format);
            }
        }
    }

    function signedNormalized(value, bitCount) {
        const signBit = 1 << (bitCount - 1);
        const fullRange = 1 << bitCount;
        const signed = value & signBit ? value - fullRange : value;
        return signed === -signBit ? -1 : signed / (signBit - 1);
    }

    function yuvToRGB(y, u, v, out) {
        const c = y - 16, d = u - 128, e = v - 128;
        out[0] = Math.min(255, Math.max(0, (298 * c + 409 * e + 128) >> 8));
        out[1] = Math.min(255, Math.max(0,
            (298 * c - 100 * d - 208 * e + 128) >> 8));
        out[2] = Math.min(255, Math.max(0, (298 * c + 516 * d + 128) >> 8));
    }

    const YUV_SCRATCH = new Int32Array(3);

    function expandPairedRowToGPU(format, source, sourceOffset, count, dest,
            destOffset) {
        for (let i = 0; i < count; ++i) {
            const block = sourceOffset + (i >> 1) * 4;
            const second = (i & 1) !== 0;
            const out = destOffset + i * 4;
            let r, g, b;
            switch (format) {
            case D3DFMT_YUY2: { // Y0 U Y1 V
                yuvToRGB(source[block + (second ? 2 : 0)], source[block + 1],
                    source[block + 3], YUV_SCRATCH);
                r = YUV_SCRATCH[0]; g = YUV_SCRATCH[1]; b = YUV_SCRATCH[2];
                break;
            }
            case D3DFMT_UYVY: { // U Y0 V Y1
                yuvToRGB(source[block + (second ? 3 : 1)], source[block],
                    source[block + 2], YUV_SCRATCH);
                r = YUV_SCRATCH[0]; g = YUV_SCRATCH[1]; b = YUV_SCRATCH[2];
                break;
            }
            case D3DFMT_R8G8_B8G8: // R G0 B G1: the pair shares R and B
                r = source[block];
                g = source[block + (second ? 3 : 1)];
                b = source[block + 2];
                break;
            default:               // D3DFMT_G8R8_G8B8 -- G0 R G1 B
                r = source[block + 1];
                g = source[block + (second ? 2 : 0)];
                b = source[block + 3];
                break;
            }
            dest[out] = r; dest[out + 1] = g; dest[out + 2] = b;
            dest[out + 3] = 0xff;
        }
    }

    function expandUNorm8(value, bits) {
        if (!bits) return 0;
        if (bits >= 8) return (value >>> (bits - 8)) & 255;
        value &= (1 << bits) - 1;
        let expanded = value, width = bits;
        while (width < 8) { expanded = (expanded << bits) | value;width += bits; }
        return expanded >>> (width - 8);
    }

    // Replicate the source bits when widening UNORM channels, as D3D does;
    // truncating a floating-point scale loses one at many mid-range values.
    const UNORM5 = Uint8Array.from({ length: 32 }, (_, v) => expandUNorm8(v, 5));
    const UNORM6 = Uint8Array.from({ length: 64 }, (_, v) => expandUNorm8(v, 6));
    const UNORM3 = Uint8Array.from({ length: 8 }, (_, v) => expandUNorm8(v, 3));
    function expandRowToGPU(format, source, sourceOffset, count, dest,
            destOffset, palette) {
        if (format === D3DFMT_A8R8G8B8 || format === D3DFMT_R32F || format === D3DFMT_G32R32F ||
                format === D3DFMT_A32B32G32R32F) {
            const bytes = count * gpuBytesPerTexel(format);
            dest.set(source.subarray(sourceOffset, sourceOffset + bytes), destOffset);
            return;
        }
        if (isPackedPairFormat(format)) {
            expandPairedRowToGPU(format, source, sourceOffset, count, dest,
                destOffset);
            return;
        }
        if (isPalettizedFormat(format)) {
            const stride = format === D3DFMT_A8P8 ? 2 : 1;
            for (let i = 0; i < count; ++i) {
                const at = sourceOffset + i * stride;
                // D3DFMT_A8P8 is little-endian [index, alpha]; the palette's
                // own alpha is overridden by the per-texel one.
                const entry = (palette ? source[at] : 0) * 4;
                const out = destOffset + i * 4;
                if (palette) {
                    dest[out] = palette[entry];
                    dest[out + 1] = palette[entry + 1];
                    dest[out + 2] = palette[entry + 2];
                    dest[out + 3] = stride === 2
                        ? source[at + 1] : palette[entry + 3];
                } else {
                    // No palette has been set yet. Opaque white keeps the draw
                    // neutral instead of painting the scene with whatever the
                    // uninitialised entries happened to be.
                    dest[out] = dest[out + 1] = dest[out + 2] = 0xff;
                    dest[out + 3] = stride === 2 ? source[at + 1] : 0xff;
                }
            }
            return;
        }
        for (let i = 0; i < count; ++i) {
            let r, g, b, a;
            if (isHalfFloatExpansionFormat(format)) {
                let u, v, w, q;
                if (format === D3DFMT_CxV8U8) {
                    const at = sourceOffset + i * 2;
                    u = signedNormalized(source[at], 8);
                    v = signedNormalized(source[at + 1], 8);
                    w = Math.sqrt(Math.max(0, 1 - u * u - v * v));
                    q = 1;
                } else if (format === D3DFMT_L16) {
                    const at = sourceOffset + i * 2;
                    const luminance = (source[at] |
                        (source[at + 1] << 8)) / 65535;
                    u = v = w = luminance;
                    q = 1;
                } else if (format === D3DFMT_R16F) {
                    const at = sourceOffset + i * 2;
                    const out = destOffset + i * 8;
                    dest[out] = source[at];
                    dest[out + 1] = source[at + 1];
                    writeHalf(dest, out + 2, 0);
                    writeHalf(dest, out + 4, 0);
                    writeHalf(dest, out + 6, 1);
                    continue;
                } else if (format === D3DFMT_G16R16F) {
                    const at = sourceOffset + i * 4;
                    const out = destOffset + i * 8;
                    dest[out] = source[at];
                    dest[out + 1] = source[at + 1];
                    dest[out + 2] = source[at + 2];
                    dest[out + 3] = source[at + 3];
                    writeHalf(dest, out + 4, 0);
                    writeHalf(dest, out + 6, 1);
                    continue;
                } else if (format === D3DFMT_A16B16G16R16F) {
                    const at = sourceOffset + i * 8;
                    const out = destOffset + i * 8;
                    dest.set(source.subarray(at, at + 8), out);
                    continue;
                } else if (format === D3DFMT_G16R16 ||
                        format === D3DFMT_A16B16G16R16) {
                    const at = sourceOffset + i *
                        (format === D3DFMT_G16R16 ? 4 : 8);
                    const readUNorm16 = offset =>
                        (source[offset] | (source[offset + 1] << 8)) / 65535;
                    u = readUNorm16(at);
                    v = readUNorm16(at + 2);
                    w = format === D3DFMT_A16B16G16R16 ?
                        readUNorm16(at + 4) : 1;
                    q = format === D3DFMT_A16B16G16R16 ?
                        readUNorm16(at + 6) : 1;
                } else if (format === D3DFMT_A2B10G10R10 ||
                        format === D3DFMT_A2R10G10B10) {
                    const at = sourceOffset + i * 4;
                    const value = (source[at] | (source[at + 1] << 8) |
                        (source[at + 2] << 16) |
                        (source[at + 3] << 24)) >>> 0;
                    const c0 = (value & 0x3ff) / 1023;
                    const c1 = ((value >>> 10) & 0x3ff) / 1023;
                    const c2 = ((value >>> 20) & 0x3ff) / 1023;
                    u = format === D3DFMT_A2B10G10R10 ? c0 : c2;
                    v = c1;
                    w = format === D3DFMT_A2B10G10R10 ? c2 : c0;
                    q = (value >>> 30) / 3;
                } else if (format === D3DFMT_L6V5U5) {
                    const value = source[sourceOffset + i * 2] |
                        (source[sourceOffset + i * 2 + 1] << 8);
                    u = signedNormalized(value & 0x1f, 5);
                    v = signedNormalized((value >>> 5) & 0x1f, 5);
                    w = ((value >>> 10) & 0x3f) / 63;
                    q = 1;
                } else if (format === D3DFMT_X8L8V8U8) {
                    const at = sourceOffset + i * 4;
                    u = signedNormalized(source[at], 8);
                    v = signedNormalized(source[at + 1], 8);
                    w = source[at + 2] / 255;
                    q = 1;
                } else if (format === D3DFMT_V16U16) {
                    const at = sourceOffset + i * 4;
                    const rawU = source[at] | (source[at + 1] << 8);
                    const rawV = source[at + 2] | (source[at + 3] << 8);
                    u = signedNormalized(rawU, 16);
                    v = signedNormalized(rawV, 16);
                    w = q = 1;
                } else if (format === D3DFMT_Q16W16V16U16) {
                    const at = sourceOffset + i * 8;
                    const read = offset => signedNormalized(
                        source[offset] | (source[offset + 1] << 8), 16);
                    u = read(at);
                    v = read(at + 2);
                    w = read(at + 4);
                    q = read(at + 6);
                } else if (format === D3DFMT_W11V11U10) {
                    // The one D3D8 bump format whose channels are not a whole
                    // number of bits alike: U is 10 bits at 0-9, V is 11 at
                    // 10-20, W is 11 at 21-31, and all three are signed.
                    const at = sourceOffset + i * 4;
                    const value = (source[at] | (source[at + 1] << 8) |
                        (source[at + 2] << 16) |
                        (source[at + 3] << 24)) >>> 0;
                    u = signedNormalized(value & 0x3ff, 10);
                    v = signedNormalized((value >>> 10) & 0x7ff, 11);
                    w = signedNormalized((value >>> 21) & 0x7ff, 11);
                    q = 1;
                } else {
                    const at = sourceOffset + i * 4;
                    const value = (source[at] | (source[at + 1] << 8) |
                        (source[at + 2] << 16) |
                        (source[at + 3] << 24)) >>> 0;
                    u = signedNormalized(value & 0x3ff, 10);
                    v = signedNormalized((value >>> 10) & 0x3ff, 10);
                    w = signedNormalized((value >>> 20) & 0x3ff, 10);
                    q = (value >>> 30) / 3;
                }
                const out = destOffset + i * 8;
                writeHalf(dest, out, u);
                writeHalf(dest, out + 2, v);
                writeHalf(dest, out + 4, w);
                writeHalf(dest, out + 6, q);
                continue;
            }
            switch (format) {
            case D3DFMT_R8G8B8: {
                const at = sourceOffset + i * 3;
                b = source[at]; g = source[at + 1]; r = source[at + 2];
                a = 0xff;
                break;
            }
            case D3DFMT_A8R8G8B8:
            case D3DFMT_X8R8G8B8: {
                const value = source[sourceOffset + i * 4] |
                    (source[sourceOffset + i * 4 + 1] << 8) |
                    (source[sourceOffset + i * 4 + 2] << 16) |
                    (source[sourceOffset + i * 4 + 3] << 24);
                b = value & 0xff; g = (value >>> 8) & 0xff;
                r = (value >>> 16) & 0xff;
                a = format === D3DFMT_A8R8G8B8 ? (value >>> 24) & 0xff : 0xff;
                break;
            }
            case D3DFMT_R5G6B5: {
                const value = source[sourceOffset + i * 2] |
                    (source[sourceOffset + i * 2 + 1] << 8);
                r = UNORM5[(value >>> 11) & 0x1f];
                g = UNORM6[(value >>> 5) & 0x3f];
                b = UNORM5[value & 0x1f];
                a = 0xff;
                break;
            }
            case D3DFMT_X1R5G5B5:
            case D3DFMT_A1R5G5B5: {
                const value = source[sourceOffset + i * 2] |
                    (source[sourceOffset + i * 2 + 1] << 8);
                r = UNORM5[(value >>> 10) & 0x1f];
                g = UNORM5[(value >>> 5) & 0x1f];
                b = UNORM5[value & 0x1f];
                a = format === D3DFMT_A1R5G5B5 ?
                    ((value >>> 15) & 0x1) * 255 : 0xff;
                break;
            }
            case D3DFMT_A4R4G4B4: {
                const value = source[sourceOffset + i * 2] |
                    (source[sourceOffset + i * 2 + 1] << 8);
                r = ((value >>> 8) & 0xf) * 255 / 15;
                g = ((value >>> 4) & 0xf) * 255 / 15;
                b = (value & 0xf) * 255 / 15;
                a = ((value >>> 12) & 0xf) * 255 / 15;
                break;
            }
            case D3DFMT_R3G3B2: {
                const value = source[sourceOffset + i];
                r = UNORM3[(value >>> 5) & 0x7];
                g = UNORM3[(value >>> 2) & 0x7];
                b = (value & 0x3) * 255 / 3;
                a = 0xff;
                break;
            }
            case D3DFMT_A8R3G3B2: {
                const at = sourceOffset + i * 2;
                const value = source[at];
                r = UNORM3[(value >>> 5) & 0x7];
                g = UNORM3[(value >>> 2) & 0x7];
                b = (value & 0x3) * 255 / 3;
                a = source[at + 1];
                break;
            }
            case D3DFMT_X4R4G4B4: {
                const value = source[sourceOffset + i * 2] |
                    (source[sourceOffset + i * 2 + 1] << 8);
                r = ((value >>> 8) & 0xf) * 17;
                g = ((value >>> 4) & 0xf) * 17;
                b = (value & 0xf) * 17;
                a = 0xff;
                break;
            }
            case D3DFMT_A8B8G8R8:
            case D3DFMT_X8B8G8R8: {
                const at = sourceOffset + i * 4;
                r = source[at]; g = source[at + 1]; b = source[at + 2];
                a = format === D3DFMT_A8B8G8R8 ? source[at + 3] : 0xff;
                break;
            }
            case D3DFMT_L8:
                r = g = b = source[sourceOffset + i];
                a = 0xff;
                break;
            case D3DFMT_A8:
                // A8 is the sole D3D9 format whose missing colour channels
                // default to zero rather than one.
                r = g = b = 0;
                a = source[sourceOffset + i];
                break;
            case D3DFMT_A8L8: {
                const at = sourceOffset + i * 2;
                r = g = b = source[at]; a = source[at + 1];
                break;
            }
            case D3DFMT_A4L4: {
                const value = source[sourceOffset + i];
                r = g = b = (value & 0xf) * 17;
                a = (value >>> 4) * 17;
                break;
            }
            case D3DFMT_V8U8: {
                const at = sourceOffset + i * 2;
                r = source[at]; g = source[at + 1]; b = a = 0x7f;
                break;
            }
            case D3DFMT_Q8W8V8U8: {
                const at = sourceOffset + i * 4;
                r = source[at]; g = source[at + 1];
                b = source[at + 2]; a = source[at + 3];
                break;
            }
            case D3DFMT_INDEX16: {
                /*
                 * INDEX16/32 are buffer formats, not standard D3D colour
                 * formats, but old capability scanners also try them as
                 * textures. Preserve the little-endian index bytes in RGBA
                 * instead of inventing a lossy colour conversion: shaders can
                 * reconstruct the exact value after multiplying by 255.
                 */
                const at = sourceOffset + i * 2;
                r = source[at]; g = source[at + 1]; b = 0; a = 0xff;
                break;
            }
            case D3DFMT_INDEX32: {
                const at = sourceOffset + i * 4;
                r = source[at]; g = source[at + 1];
                b = source[at + 2]; a = source[at + 3];
                break;
            }
            default:
                r = g = b = a = 0;
                break;
            }
            dest[destOffset + i * 4] = r | 0;
            dest[destOffset + i * 4 + 1] = g | 0;
            dest[destOffset + i * 4 + 2] = b | 0;
            dest[destOffset + i * 4 + 3] = a | 0;
        }
    }

    const api = {
        D3DFMT_R8G8B8,
        D3DFMT_A8R8G8B8,
        D3DFMT_X8R8G8B8,
        D3DFMT_R5G6B5,
        D3DFMT_X1R5G5B5,
        D3DFMT_A1R5G5B5,
        D3DFMT_A4R4G4B4,
        D3DFMT_R3G3B2,
        D3DFMT_A8,
        D3DFMT_A8R3G3B2,
        D3DFMT_X4R4G4B4,
        D3DFMT_A2B10G10R10,
        D3DFMT_A8B8G8R8,
        D3DFMT_X8B8G8R8,
        D3DFMT_G16R16,
        D3DFMT_A2R10G10B10,
        D3DFMT_A16B16G16R16,
        D3DFMT_L8,
        D3DFMT_A8L8,
        D3DFMT_A4L4,
        D3DFMT_V8U8,
        D3DFMT_L6V5U5,
        D3DFMT_X8L8V8U8,
        D3DFMT_Q8W8V8U8,
        D3DFMT_V16U16,
        D3DFMT_W11V11U10,
        D3DFMT_A2W10V10U10,
        D3DFMT_L16,
        D3DFMT_R16F,
        D3DFMT_G16R16F,
        D3DFMT_A16B16G16R16F,
        D3DFMT_R32F,
        D3DFMT_G32R32F,
        D3DFMT_A32B32G32R32F,
        D3DFMT_CxV8U8,
        D3DFMT_P8,
        D3DFMT_A8P8,
        D3DFMT_Q16W16V16U16,
        D3DFMT_UYVY,
        D3DFMT_YUY2,
        D3DFMT_R8G8_B8G8,
        D3DFMT_G8R8_G8B8,
        D3DFMT_DF16,
        D3DFMT_DF24,
        D3DFMT_INTZ,
        D3DFMT_ATI1N,
        D3DFMT_ATI2N,
        D3DFMT_NULL,
        D3DFMT_DXT1,
        D3DFMT_DXT2,
        D3DFMT_DXT3,
        D3DFMT_DXT4,
        D3DFMT_DXT5,
        D3DFMT_INDEX16,
        D3DFMT_INDEX32,
        srgbSiblingOf,
        isCompressedFormat,
        compressedBlockBytes,
        blockAlignedCopyExtent,
        isFourCCDepthFormat,
        isPalettizedFormat,
        isPackedPairFormat,
        isHalfFloatExpansionFormat,
        gpuBytesPerTexel,
        fullMipLevelCount,
        isRenderableGPUFormat,
        isFloat32GPUFormat,
        isBlendableGPUFormat,
        formatToGPU,
        floatToHalfBits,
        writeHalf,
        halfBitsToFloat,
        d3dBytesPerTexel,
        packGPUReadbackRow,
        signedNormalized,
        yuvToRGB,
        expandPairedRowToGPU,
        expandRowToGPU,
        expandUNorm8
    };
    global.D9WGFormats = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
