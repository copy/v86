// GL 2.1 section 3.2.1: disabling MULTISAMPLE uses fragment-center
// coverage, then applies that fragment to every destination sample.
(function(global) {
    "use strict";
    const quad = `
@vertex fn vs_main(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{
 return vec4<f32>(f32((i<<1u)&2u)*2.0-1.0,f32(i&2u)*2.0-1.0,0.0,1.0);
}
`;
    function capture(source, side) {
        const input = source.match(/struct FSIn\s*\{([^]*?)\}/)?.[1] || "", facing = input.match(/@builtin\(front_facing\)\s+(\w+)/)?.[1],
            front = side ? side === "front" ? "true" : "false" : facing ? "gl_fragment." + facing : "gl_front",
            entry = /@fragment\s+fn\s+fs_main\s*\(([^]*?)\)\s*->\s*FSOut\s*\{/;
        if (!entry.test(source)) throw new Error("single-sample capture requires FSOut");
        return source.replace(entry, "fn gl_single_fragment($1)->FSOut{") + `
@group(3) @binding(0) var<storage,read_write> gl_single_meta:array<u32>;
@group(3) @binding(1) var<uniform> gl_single_info:vec4<u32>;
@fragment fn fs_main(gl_fragment:FSIn${!side && !facing ? ",@builtin(front_facing) gl_front:bool" : ""})->FSOut{
 let out=gl_single_fragment(gl_fragment);let p=vec2<u32>(gl_fragment.position.xy);
 gl_single_meta[((p.y-gl_single_info.y)*gl_single_info.x+p.x)*2u]=select(2u,1u,${front});return out;
}
`;
    }
    const depth = `
@group(0) @binding(0) var<storage,read_write> glSingleMeta:array<u32>;
@group(0) @binding(1) var depth:texture_depth_2d;
@group(0) @binding(2) var<uniform> info:vec4<u32>;
@compute @workgroup_size(8,8) fn single_depth(@builtin(global_invocation_id) p:vec3<u32>){
 if(p.x>=info.x||p.y>=info.z){return;}let at=(p.y*info.x+p.x)*2u;
 if(glSingleMeta[at]!=0u){glSingleMeta[at+1u]=bitcast<u32>(textureLoad(depth,vec2<i32>(i32(p.x),i32(p.y+info.y)),0));}
}
`;
    function composite(colors, logic) {
        const expression = ["vec4<u32>(0u)", "s&d", "s&~d", "s", "~s&d", "d", "s^d", "s|d", "~(s|d)", "~(s^d)", "~d", "s|~d", "~s", "~s|d", "~(s&d)", "vec4<u32>(255u)"][logic & 15],
            active = colors.map((color, i) => color ? i : -1).filter(i => i >= 0);
        return quad + `
@group(0) @binding(0) var<storage,read> glSingleMeta:array<u32>;
@group(0) @binding(1) var<uniform> info:vec4<u32>;
${active.map(i => "@group(0) @binding(" + (2 + i) + ") var color" + i + ":texture_2d<f32>;" +
        (logic ? "\n@group(0) @binding(" + (10 + i) + ") var destination" + i + ":texture_multisampled_2d<f32>;" : "")).join("\n")}
${logic ? "fn applyLogic(src:vec4<f32>,dst:vec4<f32>)->vec4<f32>{let s=vec4<u32>(round(clamp(src,vec4<f32>(0.0),vec4<f32>(1.0))*255.0));let d=vec4<u32>(round(clamp(dst,vec4<f32>(0.0),vec4<f32>(1.0))*255.0));return vec4<f32>((" + expression + ")&vec4<u32>(255u))/255.0;}" : ""}
struct SingleOut {${active.map(i => "@location(" + i + ") color" + i + ":vec4<f32>,").join("\n")} @builtin(frag_depth) depth:f32,}
@fragment fn fs_main(@builtin(position) p:vec4<f32>${logic ? ",@builtin(sample_index) sample:u32" : ""})->SingleOut{
 let pixel=vec2<u32>(p.xy);let at=((pixel.y-info.y)*info.x+pixel.x)*2u;
 if(glSingleMeta[at]!=info.w){discard;}var out:SingleOut;out.depth=bitcast<f32>(glSingleMeta[at+1u]);
 ${active.map(i => "out.color" + i + "=" + (logic ? "applyLogic(" : "") + "textureLoad(color" + i + ",vec2<i32>(pixel),0)" + (logic ? ",textureLoad(destination" + i + ",vec2<i32>(pixel),sample))" : "") + ";").join("\n")}
 return out;
}
`;
    }
    function copy(colors) {
        const active = colors.map((color, i) => color ? i : -1).filter(i => i >= 0);
        return quad + active.map(i => "@group(0) @binding(" + i + ") var source" + i + ":texture_multisampled_2d<f32>;").join("\n") + `
struct CopyOut {${active.map(i => "@location(" + i + ") color" + i + ":vec4<f32>,").join("\n")}}
@fragment fn fs_main(@builtin(position) p:vec4<f32>,@builtin(sample_index) sample:u32)->CopyOut{var out:CopyOut;
 ${active.map(i => "out.color" + i + "=textureLoad(source" + i + ",vec2<i32>(p.xy),sample);").join("\n")}return out;}
`;
    }
    function pointCircle(vertex, fragment) {
        const output = vertex.match(/struct VSOut\s*\{([^]*?)\}/)?.[1] || "", coordinate = output.match(/@location\((\d+)\)\s+(?:@interpolate\([^)]*\)\s+)?(?:pointCoord|glPointCoord)\s*:\s*vec2<f32>/);
        if (!coordinate) throw new Error("multisample points require point coordinates");
        const location = coordinate[1], attribute = new RegExp("@location\\(" + location + "\\)\\s+(?:@interpolate\\([^)]*\\)\\s+)?(\\w+)\\s*:\\s*vec2<f32>"),
            input = fragment.match(/struct FSIn\s*\{([^]*?)\}/)?.[1] || "", existing = input.match(attribute), field = existing?.[1] || "gl_circle_coord";
        vertex = vertex.replace(attribute, "@location(" + location + ") @interpolate(perspective,sample) $1:vec2<f32>");
        fragment = existing ? fragment.replace(attribute, "@location(" + location + ") @interpolate(perspective,sample) $1:vec2<f32>") :
            fragment.replace(/struct FSIn\s*\{/, "struct FSIn {\n@location(" + location + ") @interpolate(perspective,sample) " + field + ":vec2<f32>,");
        fragment = fragment.replace(/@fragment\s+fn\s+fs_main\s*\(([^]*?)\)\s*->\s*FSOut\s*\{/, "fn gl_circle_fragment($1)->FSOut{") + `
@fragment fn fs_main(gl_fragment:FSIn)->FSOut{
 let p=gl_fragment.${field}*2.0-1.0;if(dot(p,p)>1.0){discard;}return gl_circle_fragment(gl_fragment);
}
`;
        return { vertex, fragment };
    }
    const api = { capture, depth, composite, copy, pointCircle };global.GLSingleSample = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
