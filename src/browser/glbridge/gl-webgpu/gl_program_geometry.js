// Geometry which depends on the application's vertex program stays on the
// GPU. The captured clip coordinates drive facing and polygon depth slope;
// the ordinary vertex entry still produces every application varying.
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

    const polygonAnalysis = `
@group(0) @binding(0) var<storage,read> gl_geometry_positions:array<vec4<f32>>;
@group(0) @binding(1) var<storage,read> gl_geometry_indices:array<u32>;
@group(0) @binding(2) var<storage,read> gl_geometry_starts:array<u32>;
@group(0) @binding(3) var<storage,read_write> gl_geometry_faces:array<vec4<f32>>;
@group(0) @binding(4) var<uniform> gl_geometry_params:array<vec4<f32>,2>;
fn gl_polygon_determinant(a:vec4<f32>,b:vec4<f32>,c:vec4<f32>)->f32{
 return a.x*(b.y*c.w-b.w*c.y)-a.y*(b.x*c.w-b.w*c.x)+a.w*(b.x*c.y-b.y*c.x);
}
fn gl_geometry_position(index:u32)->vec4<f32>{
 let p=gl_geometry_positions[index];let scale=max(max(abs(p.x),abs(p.y)),max(abs(p.z),abs(p.w)));
 return p/max(scale,1e-30);
}
@compute @workgroup_size(64) fn analyze_main(@builtin(global_invocation_id) id:vec3<u32>){
 if(id.x>=arrayLength(&gl_geometry_faces)){return;}
 let gl_start=gl_geometry_starts[id.x];let gl_end=gl_geometry_starts[id.x+1u];
 let a=gl_geometry_position(gl_geometry_indices[gl_start]);
 var area=0.0;var slope=0.0;var best=0.0;var maximumDepth=0.0;
 let viewport=gl_geometry_params[0].xy;let near=gl_geometry_params[0].z;let far=gl_geometry_params[0].w;
 for(var i=gl_start+1u;i+1u<gl_end;i++){
 let b=gl_geometry_position(gl_geometry_indices[i]);let c=gl_geometry_position(gl_geometry_indices[i+1u]);
 let orientation=gl_polygon_determinant(a,b,c);if(abs(orientation)>abs(area)){area=orientation;}
 if(abs(orientation)>best){best=abs(orientation);
 let dx=gl_polygon_determinant(vec4<f32>(a.z,a.y,0.0,a.w),vec4<f32>(b.z,b.y,0.0,b.w),vec4<f32>(c.z,c.y,0.0,c.w))/orientation;
 let dy=gl_polygon_determinant(vec4<f32>(a.x,a.z,0.0,a.w),vec4<f32>(b.x,b.z,0.0,b.w),vec4<f32>(c.x,c.z,0.0,c.w))/orientation;
 slope=abs(far-near)*max(abs(dx)/max(viewport.x,1.0),abs(dy)/max(viewport.y,1.0));}
 var points=array<vec4<f32>,3>(a,b,c);for(var j=0;j<3;j++){let p=points[j];
 if(p.w!=0.0){maximumDepth=max(maximumDepth,abs(clamp(near+(far-near)*(p.z/p.w+1.0)*0.5,0.0,1.0)));}}
 }
 var resolution=exp2(-24.0);if(gl_geometry_params[1].x==1.0){resolution=exp2(-16.0);}
 if(gl_geometry_params[1].x==2.0){resolution=exp2(select(-149.0,floor(log2(maximumDepth))-23.0,maximumDepth>0.0));}
 gl_geometry_faces[id.x]=vec4<f32>(area,slope,resolution,0.0);
}
`;

    function polygonVertex(source) {
        const entry = /@vertex\s+fn\s+vs_main\s*\(([^]*?)\)\s*->\s*VSOut\s*\{/;
        if (!entry.test(source)) throw new Error("program geometry requires a VSIn/VSOut vertex entry");
        const input = source.match(/struct VSIn\s*\{([^]*?)\}/)?.[1] || "", output = source.match(/struct VSOut\s*\{([^]*?)\}/)?.[1] || "",
            flat = output.split("\n").filter(line => line.includes("@interpolate(flat)")).map(line => line.match(/\b(\w+)\s*:/)?.[1]).filter(Boolean),
            inputs = [...input.matchAll(/@location\((\d+)\)\s+(\w+)\s*:\s*([^,\n]+)/g)].map(match => {
                const components = /vec([234])/.exec(match[3])?.[1], value = "gl_polygon_params.attributes[" + match[1] + "]";
                return "gl_provoking_input." + match[2] + "=" + value + "." + "xyzw".slice(0, components ? +components : 1) + ";";
            }), provoking = flat.length ? "var gl_provoking_input:VSIn;\n" + inputs.join("\n") +
                "\nlet gl_provoking_out=gl_polygon_vertex_entry(gl_provoking_input);\n" + flat.map(field => "gl_polygon_out." + field + "=gl_provoking_out." + field + ";").join("\n") : "";
        return source.replace(entry, "fn gl_polygon_vertex_entry($1) -> VSOut {") + `
struct gl_PolygonParams {info:vec4<u32>,offset:vec4<f32>,attributes:array<vec4<f32>,16>}
@group(0) @binding(0) var<storage,read> gl_polygon_faces:array<vec4<f32>>;
@group(0) @binding(1) var<uniform> gl_polygon_params:gl_PolygonParams;
@vertex fn vs_main(gl_polygon_input:VSIn)->VSOut{
 var gl_polygon_out=gl_polygon_vertex_entry(gl_polygon_input);let gl_polygon_info=gl_polygon_params.info;
 ${provoking}
 let gl_polygon_face=gl_polygon_faces[gl_polygon_info.x];let gl_polygon_front=(gl_polygon_face.x>=0.0)==(gl_polygon_info.z!=0u);
 if(select(1u,0u,gl_polygon_front)!=gl_polygon_info.y){gl_polygon_out.position=vec4<f32>(0.0,0.0,0.0,-1.0);return gl_polygon_out;}
 let gl_polygon_range=gl_polygon_params.offset.z;
 if(gl_polygon_range>0.0){let gl_polygon_offset=(gl_polygon_face.y*gl_polygon_params.offset.x+gl_polygon_face.z*gl_polygon_params.offset.y)/gl_polygon_range;
 gl_polygon_out.position.z=gl_polygon_out.position.z+gl_polygon_offset*gl_polygon_out.position.w;}
 return gl_polygon_out;
}
`;
    }
    const api = { packVertices, positionCapture, polygonAnalysis, polygonVertex };
    global.GLProgramGeometry = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
