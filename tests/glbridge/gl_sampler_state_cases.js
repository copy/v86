"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream,
        P = typeof require === "function" ? require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js") : global.GLProtocol;
    const names = ["fixed_nearest", "fixed_linear", "fixed_mip", "fixed_trilinear", "fixed_nonmip", "glsl_param", "glsl_array", "glsl_target", "glsl_lod", "glsl_bias", "glsl_bias_sum", "arb_linear", "arb_bias", "fixed_3d", "glsl_3d", "fixed_1d", "glsl_1d", "glsl_shadow", "glsl_depth_alpha", "glsl_shadow_alpha", "glsl_shadow_intensity", "glsl_shadow_clamp"];
    function image(s, target, level, internalformat, width, height, depth, format, type, bytes) {
        const name = target === GL.TEXTURE_1D ? "TEX_IMAGE_1D" : target === GL.TEXTURE_3D ? "TEX_IMAGE_3D" : "TEX_IMAGE_2D",
            header = P.encodeRecord(name, { target, level, internalformat, width, height, depth, format, type, data_size: bytes.length }), data = new Uint8Array(header.length + bytes.length);
        data.set(header);data.set(bytes, header.length);return s.record(P.GLFN[name], data);
    }
    function setup(s, name) {
        const i = names.indexOf(name), unit = i === 5 || i === 6 ? 3 : 0,
            target = i === 13 || i === 14 ? GL.TEXTURE_3D : i === 15 || i === 16 ? GL.TEXTURE_1D : GL.TEXTURE_2D,
            mip = [2, 3, 8, 9, 10, 12].includes(i), nearest = [0, 4, 9, 10, 12, 18].includes(i);
        s.call("USE_PROGRAM", 0).call("DISABLE", GL.FRAGMENT_PROGRAM_ARB);
        for (let u = 0; u < 4; ++u) s.call("ACTIVE_TEXTURE", GL.TEXTURE0 + u).call("DISABLE", GL.TEXTURE_1D).call("DISABLE", GL.TEXTURE_2D).call("DISABLE", GL.TEXTURE_3D)
            .call("TEX_ENVF", GL.TEXTURE_FILTER_CONTROL, GL.TEXTURE_LOD_BIAS, 0);
        s.call("ACTIVE_TEXTURE", GL.TEXTURE0 + unit).call("BIND_TEXTURE", target, i + 100).call("ENABLE", target)
            .call("TEX_PARAMETERI", target, GL.TEXTURE_MIN_FILTER, mip ? nearest ? GL.NEAREST_MIPMAP_NEAREST : GL.LINEAR_MIPMAP_LINEAR : nearest ? GL.NEAREST : GL.LINEAR)
            .call("TEX_PARAMETERI", target, GL.TEXTURE_MAG_FILTER, nearest ? GL.NEAREST : GL.LINEAR)
            .call("TEX_PARAMETERI", target, GL.TEXTURE_MAX_LEVEL, target === GL.TEXTURE_2D && i < 17 ? 2 : 0)
            .call("TEX_PARAMETERI", target, GL.TEXTURE_WRAP_S, [4, 9, 10, 12].includes(i) ? GL.REPEAT : GL.CLAMP_TO_BORDER)
            .call("TEX_PARAMETERI", target, GL.TEXTURE_WRAP_T, target === GL.TEXTURE_3D ? GL.CLAMP_TO_BORDER : GL.CLAMP_TO_EDGE)
            .call("TEX_PARAMETERI", target, GL.TEXTURE_WRAP_R, GL.CLAMP_TO_BORDER)
            .call("TEX_PARAMETERFV", target, GL.TEXTURE_BORDER_COLOR, 4, i >= 17 ? 0.25 : 1, unit ? 1 : 0, 0, i === 18 ? 0.9 : 1)
            .call("TEX_ENVI", GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE, GL.REPLACE);
        if (i >= 17) {
            image(s, target, 0, GL.DEPTH_COMPONENT32, 1, 1, 1, GL.DEPTH_COMPONENT, GL.FLOAT, new Uint8Array(new Float32Array([i === 21 ? 0 : 0.75]).buffer))
                .call("TEX_PARAMETERI", target, GL.DEPTH_TEXTURE_MODE, i === 18 || i === 19 ? GL.ALPHA : i === 20 ? GL.INTENSITY : GL.LUMINANCE);
            if (i >= 17 && i !== 18) s.call("TEX_PARAMETERI", target, GL.TEXTURE_COMPARE_MODE, GL.COMPARE_R_TO_TEXTURE).call("TEX_PARAMETERI", target, GL.TEXTURE_COMPARE_FUNC, GL.LESS);
        } else if (target === GL.TEXTURE_2D) for (let level = 0; level < 3; ++level) {
            const size = 4 >> level, data = new Uint8Array(size * size * 4), color = [[0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255]][level];
            for (let at = 0; at < data.length; at += 4) data.set(color, at);image(s, target, level, GL.RGBA8, size, size, 1, GL.RGBA, GL.UNSIGNED_BYTE, data);
        } else image(s, target, 0, GL.RGBA8, 1, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array([0, 255, 0, 255]));
        if ([2, 3, 4].includes(i)) s.call("TEX_PARAMETERF", target, GL.TEXTURE_MIN_LOD, i === 3 ? 0.5 : i === 4 ? 2 : 1).call("TEX_PARAMETERF", target, GL.TEXTURE_MAX_LOD, i === 3 ? 0.5 : i === 4 ? 2 : 1);
        if (i === 8) s.call("TEX_PARAMETERF", target, GL.TEXTURE_LOD_BIAS, 2);
        if ([9, 10, 12].includes(i)) s.call("TEX_PARAMETERF", target, GL.TEXTURE_LOD_BIAS, i === 10 ? 16 : -1).call("TEX_ENVF", GL.TEXTURE_FILTER_CONTROL, GL.TEXTURE_LOD_BIAS, i === 10 ? 16 : 2);
        if (i === 7) image(s.call("BIND_TEXTURE", GL.TEXTURE_3D, 99), GL.TEXTURE_3D, 0, GL.RGBA8, 1, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array([0, 0, 255, 255]))
            .call("TEX_PARAMETERI", GL.TEXTURE_3D, GL.TEXTURE_WRAP_S, GL.CLAMP_TO_EDGE).call("ENABLE", GL.TEXTURE_3D);
        const shader = i >= 5 && i <= 10 || i >= 14 && i !== 15;
        let location;
        if (shader) {
            let vs = "#version 120\nvarying vec2 v;void main(){gl_Position=gl_Vertex;gl_FrontColor=gl_Color;v=gl_Vertex.xy+vec2(.5);}",
                lookup = i === 9 ? "texture2D(probe,v,1.0)" : i === 10 ? "texture2D(probe,v,-16.0)" : i === 14 ? "texture3D(probe,vec3(0.0))" : i === 16 ? "texture1D(probe,0.0)" :
                    i === 21 ? "shadow2D(probe,vec3(.5,.5,-.25))" : i >= 17 && i !== 18 ? "shadow2D(probe,vec3(0.0,.5,.5))" : i === 18 ? "texture2D(probe,vec2(-.25,.5))" : i === 6 ? "lookup(probe[1],vec2(0.0,.5))" : "lookup(probe,vec2(0.0,.5))",
                fs = "#version 120\nvarying vec2 v;uniform sampler" + (i === 14 ? "3D" : i === 16 ? "1D" : i >= 17 && i !== 18 ? "2DShadow" : "2D") + " probe" + (i === 6 ? "[2]" : "") + ";vec4 lookup(sampler2D argTex,vec2 uv){return texture2D(argTex,uv);}void main(){gl_FragColor=" + lookup + ";}";
            if (i === 8) { vs = "#version 120\nuniform sampler2D probe;void main(){gl_Position=gl_Vertex;gl_FrontColor=texture2DLod(probe,vec2(-.125,.5),1.0);}";fs = "#version 120\nvoid main(){gl_FragColor=gl_Color;}"; }
            const program = i + 200, vertex = i * 2 + 1000, fragment = vertex + 1;
            s.call("CREATE_PROGRAM", program).call("CREATE_SHADER", vertex, GL.VERTEX_SHADER).call("CREATE_SHADER", fragment, GL.FRAGMENT_SHADER)
                .shaderSource(vertex, vs).shaderSource(fragment, fs).call("COMPILE_SHADER", vertex).call("COMPILE_SHADER", fragment)
                .call("ATTACH_SHADER", program, vertex).call("ATTACH_SHADER", program, fragment).call("LINK_PROGRAM", program).call("USE_PROGRAM", program);
            location = s.queryLocation(P.C.V86GL_LOCATION_KIND_UNIFORM, program, i === 6 ? "probe[1]" : "probe", 64);
        }
        if (i === 11 || i === 12) s.call("BIND_PROGRAM_ARB", GL.FRAGMENT_PROGRAM_ARB, i + 500)
            .programStringARB(GL.FRAGMENT_PROGRAM_ARB, "!!ARBfp1.0\n" + (i === 12 ? "TXB" : "TEX") + " result.color,fragment.texcoord[0],texture[0],2D;END").call("ENABLE", GL.FRAGMENT_PROGRAM_ARB);
        s.call("ACTIVE_TEXTURE", GL.TEXTURE0);
        return { location, unit };
    }
    function draw(s, name) {
        const i = names.indexOf(name);
        s.call("VIEWPORT", 0, 0, 16, 16).call("CLEAR_COLOR", 0, 0, 0, 0).call("CLEAR", GL.COLOR_BUFFER_BIT).call("COLOR4F", 1, 1, 1, 1).call("BEGIN", GL.TRIANGLES);
        for (const [x, y] of [[-1, -1], [3, -1], [-1, 3]]) s.call("TEX_COORD4F", i === 12 ? x + 0.5 : i === 0 || i === 18 ? -0.25 : i === 2 || i === 3 ? -0.125 : 0,
            i === 12 ? y + 0.5 : i === 13 || i === 14 ? 0 : 0.5, i === 17 ? 0.5 : 0, 1).call("VERTEX3F", x, y, 0);
        return s.call("END");
    }
    // GL 2.1 3.8.14 clamps R before comparison. Apple leaves this
    // negative shader reference unclamped; Mesa and the normative rule agree.
    const expected = entry => entry.name === "glsl_shadow_clamp" ? [0, 0, 0, 255] : entry.rgba;
    const api = { names, setup, draw, expected };global.GLSamplerStateCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
