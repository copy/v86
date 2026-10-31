"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream,
        P = typeof require === "function" ? require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js") : global.GLProtocol;
    const names = ["fog_singular_below", "fog_singular_at", "fog_singular_above", "directional_spot_outside", "directional_spot_inside", "positional_spot_outside",
        "eye_homogeneous_lighting", "light_homogeneous_lighting", "point_homogeneous_attenuation", "point_cartesian_attenuation", "explicit_image_border",
        "rgba4_fbo_precision", "dxt1_rgb_alpha", "stipple_points", "stipple_lines", "stipple_polygon_points", "stipple_fill", "srgb_fbo_encoding", "compressed_mipmap", "smooth_point"];
    function scene(s, name) {
        const c = names.indexOf(name);s.call("VIEWPORT", 0, 0, 16, 16).call("CLEAR_COLOR", 0, 0, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT).call("COLOR4F", 0, 1, 0, 1).call("POINT_SIZE", 4);
        if (c < 3) s.call("ENABLE", GL.FOG).call("FOGI", GL.FOG_MODE, GL.LINEAR).call("FOGF", GL.FOG_START, 1).call("FOGF", GL.FOG_END, 1)
            .call("FOGI", GL.FOG_COORD_SRC, GL.FOG_COORD).call("FOGFV", GL.FOG_COLOR, 4, 1, 0, 0, 1).call("FOG_COORDF", c === 0 ? .5 : c === 1 ? 1 : 2);
        if (c >= 3 && c <= 7) {
            s.call("ENABLE", GL.LIGHTING).call("ENABLE", GL.LIGHT0).call("LIGHT_MODELFV", GL.LIGHT_MODEL_AMBIENT, 4, 0, 0, 0, 1)
                .call("LIGHTFV", GL.LIGHT0, GL.AMBIENT, 4, 0, 0, 0, 1).call("LIGHTFV", GL.LIGHT0, GL.DIFFUSE, 4, 0, 1, 0, 1)
                .call("LIGHTFV", GL.LIGHT0, GL.POSITION, 4, 1, 0, c === 7 ? 2 : 1, c === 7 ? 2 : c === 3 || c === 4 ? 0 : 1)
                .call("MATERIALFV", GL.FRONT_AND_BACK, GL.DIFFUSE, 4, 1, 1, 1, 1).call("NORMAL3F", 0, 0, 1);
            if (c < 6) s.call("LIGHTF", GL.LIGHT0, GL.SPOT_CUTOFF, 30).call("LIGHTFV", GL.LIGHT0, GL.SPOT_DIRECTION, 3, c === 4 ? -1 : 0, 0, c === 4 ? -1 : 1);
            else s.call("LIGHTF", GL.LIGHT0, GL.LINEAR_ATTENUATION, .2);
        }
        if (c === 8 || c === 9) s.call("POINT_SIZE", 8).call("POINT_PARAMETERFV", GL.POINT_DISTANCE_ATTENUATION, 1, 0, 3);
        if (c === 10 || c === 12) {
            s.call("BIND_TEXTURE", GL.TEXTURE_2D, 1).call("ENABLE", GL.TEXTURE_2D).call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, c === 10 ? GL.LINEAR : GL.NEAREST)
                .call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, c === 10 ? GL.LINEAR : GL.NEAREST).call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.CLAMP).call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_WRAP_T, GL.CLAMP);
            if (c === 10) {
                const data = new Uint8Array(64);for (let y = 0; y < 4; ++y) for (let x = 0; x < 4; ++x) data.set(x > 0 && x < 3 && y > 0 && y < 3 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * 4 + x) * 4);
                const header = P.encodeRecord("TEX_IMAGE_2D", { target: GL.TEXTURE_2D, level: 0, internalformat: GL.RGBA8, width: 4, height: 4, border: 1, format: GL.RGBA, type: GL.UNSIGNED_BYTE, data_size: data.length }), payload = new Uint8Array(header.length + data.length);payload.set(header);payload.set(data, header.length);s.record(P.GLFN.TEX_IMAGE_2D, payload);
                s.call("COLOR4F", 1, 1, 1, 1).call("TEX_COORD2F", 0, .5);
            } else {
                s.compressedTexImage2D(GL.TEXTURE_2D, 0, GL.COMPRESSED_RGB_S3TC_DXT1_EXT, 4, 4, new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255]), 0).call("CREATE_PROGRAM", 1);
                for (const [id, type, source] of [[2, GL.VERTEX_SHADER, "#version 120\nvoid main(){gl_Position=gl_Vertex;gl_TexCoord[0]=gl_MultiTexCoord0;}"],
                    [3, GL.FRAGMENT_SHADER, "#version 120\nuniform sampler2D image;void main(){gl_FragColor=vec4(texture2D(image,gl_TexCoord[0].xy).a);}"]])
                    s.call("CREATE_SHADER", id, type).shaderSource(id, source).call("COMPILE_SHADER", id).call("ATTACH_SHADER", 1, id);
                s.call("LINK_PROGRAM", 1).call("USE_PROGRAM", 1).call("TEX_COORD2F", .5, .5);
            }
        }
        if (c === 11 || c === 17) s.call("BIND_TEXTURE", GL.TEXTURE_2D, 1).texImage2D(GL.TEXTURE_2D, 0, c === 17 ? GL.SRGB8_ALPHA8 : GL.RGBA4, 16, 16, GL.RGBA, GL.UNSIGNED_BYTE, null)
            .call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST).call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 1)
            .call("FRAMEBUFFER_TEXTURE_2D", GL.FRAMEBUFFER_EXT, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, 1, 0, 0).call("COLOR4F", .1, .3, .6, 1);
        if (c >= 13 && c <= 16) {
            const header = P.encodeRecord("POLYGON_STIPPLE_BITMAP", { data_size: 128 }), payload = new Uint8Array(header.length + 128);payload.set(header);s.record(P.GLFN.POLYGON_STIPPLE_BITMAP, payload).call("ENABLE", GL.POLYGON_STIPPLE);
            if (c === 15) s.call("POLYGON_MODE", GL.FRONT_AND_BACK, GL.POINT);
        }
        if (c === 18) s.call("BIND_TEXTURE", GL.TEXTURE_2D, 1).call("ENABLE", GL.TEXTURE_2D)
            .compressedTexImage2D(GL.TEXTURE_2D, 0, GL.COMPRESSED_RGB_S3TC_DXT1_EXT, 4, 4, new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255]), 0)
            .call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST_MIPMAP_NEAREST).call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, 2)
            .call("GENERATE_MIPMAP", GL.TEXTURE_2D).call("TEX_COORD2F", .5, .5);
        if (c === 19) s.call("ENABLE", GL.POINT_SMOOTH);
        if ([10, 11, 12, 16, 17, 18].includes(c)) s.call("BEGIN", GL.TRIANGLES).call("VERTEX3F", -1, -1, 0).call("VERTEX3F", 3, -1, 0).call("VERTEX3F", -1, 3, 0).call("END");
        else if (c === 14) s.call("LINE_WIDTH", 3).call("BEGIN", GL.LINES).call("VERTEX3F", -.5, .0625, 0).call("VERTEX3F", .5, .0625, 0).call("END");
        else if (c === 15) s.call("BEGIN", GL.TRIANGLES).call("VERTEX3F", .0625, .0625, 0).call("VERTEX3F", .75, .0625, 0).call("VERTEX3F", .0625, .75, 0).call("END");
        else s.call("BEGIN", GL.POINTS).call("VERTEX4F", c === 6 || c === 8 ? 1 : c === 9 ? .5 : 0, 0, 0, c === 6 || c === 8 ? 2 : 1).call("END");
        return s;
    }
    const api = { names, scene };global.GLS3RenderCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
