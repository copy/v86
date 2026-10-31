// Geometry which depends on the application's vertex program stays on the
// GPU. Captured clip coordinates drive the line stipple counter; ordinary
// vertex entries still produce every application varying.
(function(global) {
    "use strict";
    function packVertices(cpu, first, count) {
        const out = new Float32Array(count * 64);
        for (let vertex = 0; vertex < count; ++vertex) {
            const to = vertex * 64, from = (first + vertex) * cpu.stride;
            for (let location = 0; location < 16; ++location) out[to + location * 4 + 3] = 1;
            for (const attribute of cpu.layout) {
                if (attribute.location >= 16) continue;
                for (let c = 0; c < Math.min(4, attribute.components); ++c)
                    out[to + attribute.location * 4 + c] = cpu.data[from + attribute.offsetFloats + c];
            }
        }
        return out;
    }

    function positionCapture(source) {
        const struct = /struct GLCaptureOutput\s*\{[^}]*\}/;
        if (!struct.test(source)) throw new Error("program geometry requires the vertex capture ABI");
        return source.replace(struct, "struct GLCaptureOutput { clip:vec4<f32>, }")
            .replace(/\s*glCaptureOutput\[id\.x\]\.(?:color|backColor|tex|eye)\s*=[^;]*;/g, "");
    }

    const lineAnalysis = `
@group(0) @binding(0) var<storage,read> gl_line_positions:array<vec4<f32>>;
@group(0) @binding(1) var<storage,read> gl_line_segments:array<vec4<u32>>;
@group(0) @binding(2) var<storage,read_write> gl_line_distances:array<vec4<f32>>;
@group(0) @binding(3) var<storage,read_write> gl_line_carry:array<f32>;
struct gl_LineAnalysisParams {info:vec4<u32>,viewport:vec4<f32>}
@group(0) @binding(4) var<uniform> gl_line_analysis:gl_LineAnalysisParams;
@compute @workgroup_size(1) fn line_main(){
 var distance=gl_line_carry[0];let first=gl_line_analysis.info.x;let end=min(first+256u,arrayLength(&gl_line_segments));
 for(var i=first;i<end;i++){
 let segment=gl_line_segments[i];if(segment.w!=0u){distance=0.0;}
 let a=gl_line_positions[segment.x];let b=gl_line_positions[segment.y];
 var start=vec2<f32>(0.0);var delta=vec2<f32>(0.0);
 if(a.w>0.0&&b.w>0.0){start=gl_line_analysis.viewport.xy+(a.xy/a.w*0.5+0.5)*gl_line_analysis.viewport.zw;
 delta=(b.xy/b.w-a.xy/a.w)*0.5*gl_line_analysis.viewport.zw;}
 let xmajor=abs(delta.x)>=abs(delta.y);let direction=select(select(-2.0,2.0,delta.y>=0.0),select(-1.0,1.0,delta.x>=0.0),xmajor);
 gl_line_distances[i]=vec4<f32>(start,direction,distance);
 distance+=floor(max(abs(delta.x),abs(delta.y))+0.5);
 }
 gl_line_carry[0]=distance;
}
`;
    function lineShaders(vertex, fragment, stipple) {
        const entry = /@vertex\s+fn\s+vs_main\s*\(([^]*?)\)\s*->\s*VSOut\s*\{/;
        if (!entry.test(vertex)) throw new Error("line expansion requires a VSIn/VSOut vertex entry");
        const input = vertex.match(/struct VSIn\s*\{([^]*?)\}/)?.[1] || "", output = vertex.match(/struct VSOut\s*\{([^]*?)\}/)?.[1] || "",
            inputs = [...input.matchAll(/@location\((\d+)\)\s+(\w+)\s*:\s*([^,\n]+)/g)].map(match => {
                const components = /vec([234])/.exec(match[3])?.[1];
                return "gl_input." + match[2] + "=gl_line_params.attributes[base+" + match[1] + "u]." + "xyzw".slice(0, components ? +components : 1) + ";";
            }), flat = output.split("\n").filter(line => line.includes("@interpolate(flat)")).map(line => line.match(/\b(\w+)\s*:/)?.[1]).filter(Boolean),
            uniforms = `
struct gl_LineParams {info:vec4<u32>,viewport:vec4<f32>,attributes:array<vec4<f32>,48>}
@group(0) @binding(2) var<uniform> gl_line_params:gl_LineParams;
`;
        vertex = vertex.replace(entry, "fn gl_line_vertex_entry($1)->VSOut{") + uniforms + `
fn gl_line_input(base:u32)->VSIn{var gl_input:VSIn;${inputs.join("\n")}return gl_input;}
@vertex fn vs_main(@builtin(vertex_index) gl_vertex:u32,@builtin(instance_index) gl_replica:u32)->VSOut{
 let gl_a=gl_line_vertex_entry(gl_line_input(0u));let gl_b=gl_line_vertex_entry(gl_line_input(16u));
 var gl_out=gl_a;if(gl_vertex==1u){gl_out=gl_b;}
 ${flat.length ? "let gl_provoking=gl_line_vertex_entry(gl_line_input(32u));" + flat.map(field => "gl_out." + field + "=gl_provoking." + field + ";").join("\n") : ""}
 let gl_delta=(gl_b.position.xy*gl_a.position.w-gl_a.position.xy*gl_b.position.w)*gl_line_params.viewport.zw;
 let gl_offset=f32(gl_replica)-(f32(gl_line_params.info.y)-1.0)*0.5;
 if(abs(gl_delta.x)>=abs(gl_delta.y)){gl_out.position.y-=2.0*gl_offset*gl_out.position.w/gl_line_params.viewport.w;}
 else{gl_out.position.x+=2.0*gl_offset*gl_out.position.w/gl_line_params.viewport.z;}
 return gl_out;
}
`;
        if (stipple) {
            const fragmentEntry = /@fragment\s+fn\s+fs_main\s*\(([^]*?)\)\s*->\s*FSOut\s*\{/;
            if (!fragmentEntry.test(fragment)) throw new Error("line stipple requires an FSIn/FSOut fragment entry");
            fragment = fragment.replace(fragmentEntry, "fn gl_line_fragment_entry($1)->FSOut{") + uniforms + `
@group(0) @binding(3) var<storage,read> gl_line_distances:array<vec4<f32>>;
@fragment fn fs_main(gl_fragment:FSIn)->FSOut{
 let gl_info=gl_line_distances[gl_line_params.info.x];let gl_xmajor=abs(gl_info.z)<1.5;
 let gl_coordinate=select(gl_fragment.position.y,gl_fragment.position.x,gl_xmajor);let gl_start=select(gl_info.y,gl_info.x,gl_xmajor);
 let gl_distance=gl_info.w+max(0.0,floor((gl_coordinate-gl_start)*sign(gl_info.z)+0.5));
 let gl_bit=(u32(gl_distance)/gl_line_params.info.w)%16u;
 if(((gl_line_params.info.z>>gl_bit)&1u)==0u){discard;}
 return gl_line_fragment_entry(gl_fragment);
}
`;
        }
        return { vertex, fragment };
    }

    const api = { packVertices, positionCapture, lineAnalysis, lineShaders };
    global.GLProgramGeometry = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
