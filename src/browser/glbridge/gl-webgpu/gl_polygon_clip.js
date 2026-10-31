// Clip post-vertex outputs on the GPU before polygon line/point conversion.
// Intersections interpolate varyings; flat fields retain the original provoking
// output, rather than evaluating a nonlinear vertex program at a new input.
(function(global) {
    "use strict";
    function interfaceOf(source) {
        const match = source.match(/struct VSOut\s*\{([^]*?)\}/);
        if (!match) throw new Error("polygon clipping requires VSOut");
        const fields = match[1].split("\n").map(line => {
            const field = line.match(/\b(\w+)\s*:\s*(vec([234])<f32>|f32)\s*,?/);
            return field && { name: field[1], type: field[2], components: +(field[3] || 1), flat: line.includes("@interpolate(flat)") };
        }).filter(Boolean);
        let size = 0;
        for (const field of fields) {
            const alignment = field.components === 1 ? 4 : field.components === 2 ? 8 : 16;
            size = Math.ceil(size / alignment) * alignment + field.components * 4;
        }
        return { fields, declaration: match[0].replace(/\bVSOut\b/, "GLCapturedOut"), stride: Math.ceil(size / 16) * 16 + 16 };
    }
    const entry = /@vertex\s+fn\s+vs_main\s*\(([^]*?)\)\s*->\s*VSOut\s*\{/;
    function capture(source, options) {
        const iface = interfaceOf(source), input = source.match(/struct VSIn\s*\{([^]*?)\}/)?.[1] || "",
            inputs = [...input.matchAll(/@location\((\d+)\)\s+(\w+)\s*:\s*([^,\n]+)/g)].map(match => {
                const components = /vec([234])/.exec(match[3])?.[1];
                return "gl_input." + match[2] + "=gl_clip_input[id.x].attributes[" + match[1] + "]." + "xyzw".slice(0, components ? +components : 1) + ";";
            });
        if (!entry.test(source)) throw new Error("polygon clipping requires a vertex entry");
        if (options.pointSize) source = source.replace("out.position = clip;", "gl_clip_point_size=" + options.pointSize + ";\n    out.position = clip;");
        source = source.replace(entry, "fn gl_clip_vertex_entry($1)->VSOut{") + `
struct GLClipInput {attributes:array<vec4<f32>,16>}
struct GLClipCapture {output:VSOut,params:vec4<f32>}
struct GLClipCaptureState {modelview:mat4x4<f32>,point:vec4<f32>,attenuation:vec4<f32>}
@group(3) @binding(0) var<storage,read> gl_clip_input:array<GLClipInput>;
@group(3) @binding(1) var<storage,read_write> gl_clip_output:array<GLClipCapture>;
@group(3) @binding(2) var<uniform> gl_clip_capture_state:GLClipCaptureState;
var<private> gl_clip_point_size:f32;
@compute @workgroup_size(64) fn clip_capture_main(@builtin(global_invocation_id) id:vec3<u32>){
 if(id.x>=arrayLength(&gl_clip_output)){return;}
 var gl_input:VSIn;${inputs.join("\n")}
 ${options.fixed ? `let eye=gl_clip_capture_state.modelview*gl_clip_input[id.x].attributes[0];let distance=length(eye.xyz);
 gl_clip_point_size=clamp(gl_clip_capture_state.point.x*inverseSqrt(max(dot(gl_clip_capture_state.attenuation.xyz,vec3<f32>(1.0,distance,distance*distance)),1e-8)),gl_clip_capture_state.point.y,gl_clip_capture_state.point.z);` :
        "gl_clip_point_size=clamp(gl_clip_capture_state.point.x,1.0,64.0);"}
 gl_clip_output[id.x].output=gl_clip_vertex_entry(gl_input);
 gl_clip_output[id.x].params=vec4<f32>(gl_clip_point_size,0.0,0.0,0.0);
}
`;
        return { code: source, iface };
    }
    function storageTypes(iface) {
        return iface.declaration + "\nstruct GLClipVertex {output:GLCapturedOut,params:vec4<f32>}\n";
    }
    function kernel(iface) {
        const clip = iface.fields.find(field => ["clipDist", "glClipDist"].includes(field.name))?.name,
            extra = iface.fields.find(field => ["clipExtra", "glClipExtra"].includes(field.name))?.name,
            mix = iface.fields.map(field => " r.output." + field.name + "=" + (field.flat ? "a.output." + field.name : "mix(a.output." + field.name + ",b.output." + field.name + ",t)") + ";").join("\n"),
            flat = iface.fields.filter(field => field.flat).map(field => "v.output." + field.name + "=provoking.output." + field.name + ";").join("\n");
        return storageTypes(iface) + `
@group(0) @binding(0) var<storage,read> gl_clip_raw:array<GLClipVertex>;
@group(0) @binding(1) var<storage,read> gl_clip_indices:array<vec2<u32>>;
@group(0) @binding(2) var<storage,read_write> gl_clip_a:array<GLClipVertex>;
@group(0) @binding(3) var<storage,read_write> gl_clip_b:array<GLClipVertex>;
@group(0) @binding(4) var<storage,read_write> gl_clip_meta:array<u32>;
struct GLClipParams {info:vec4<u32>,style:vec4<u32>,viewport:vec4<f32>,depth:vec4<f32>,raster:vec4<u32>}
@group(0) @binding(5) var<uniform> gl_clip:GLClipParams;
fn gl_clip_load(i:u32,b:bool)->GLClipVertex{if(b){return gl_clip_b[i];}return gl_clip_a[i];}
fn gl_clip_store(i:u32,b:bool,v:GLClipVertex){if(b){gl_clip_b[i]=v;}else{gl_clip_a[i]=v;}}
fn gl_clip_distance(v:GLClipVertex,plane:u32)->f32{
 let p=v.output.position;
 switch plane{case 0u:{return p.x+p.w;}case 1u:{return p.w-p.x;}case 2u:{return p.y+p.w;}case 3u:{return p.w-p.y;}case 4u:{return p.z;}case 5u:{return p.w-p.z;}default:{}}
 ${clip ? "if(plane<10u){return v.output." + clip + "[plane-6u];}" : ""}
 ${extra ? "return v.output." + extra + "[plane-10u];" : "return 1.0;"}
}
fn gl_clip_intersection(a:GLClipVertex,b:GLClipVertex,da:f32,db:f32,plane:u32)->GLClipVertex{
 let scale=max(max(abs(da),abs(db)),1e-30);let t=(da/scale)/(da/scale-db/scale);var r:GLClipVertex;
 ${mix}
 r.params=vec4<f32>(mix(a.params.x,b.params.x,t),0.0,0.0,0.0);
 switch plane{case 0u:{r.output.position.x=-r.output.position.w;}case 1u:{r.output.position.x=r.output.position.w;}
 case 2u:{r.output.position.y=-r.output.position.w;}case 3u:{r.output.position.y=r.output.position.w;}
 case 4u:{r.output.position.z=0.0;}case 5u:{r.output.position.z=r.output.position.w;}default:{
 ${clip ? "if(plane<10u){r.output." + clip + "[plane-6u]=0.0;}" : ""}
 ${extra ? "if(plane>=10u){r.output." + extra + "[plane-10u]=0.0;}" : ""}
 }}return r;
}
// Binary scaling keeps the derived divide in range without changing the
// stored clip w used for perspective interpolation by the render stage.
fn gl_clip_window(v:GLClipVertex)->vec3<f32>{
 let p=v.output.position;let exponent=frexp(p.w).exp;let q=ldexp(p,-vec4<i32>(exponent));
 let ndc=q.xyz/q.w;return vec3<f32>(gl_clip.viewport.xy+(vec2<f32>(ndc.x,-ndc.y)*0.5+0.5)*gl_clip.viewport.zw,
 gl_clip.depth.x+(gl_clip.depth.y-gl_clip.depth.x)*ndc.z);
}
@compute @workgroup_size(1) fn clip_polygon_main(){
 let base=gl_clip.info.w*4u;let localCapacity=gl_clip.raster.y;
 for(var i=0u;i<localCapacity;i++){gl_clip_meta[i*4u]=0u;gl_clip_meta[i*4u+1u]=0u;gl_clip_meta[i*4u+2u]=0u;gl_clip_meta[i*4u+3u]=0u;}
 var n=gl_clip.info.y;var source=false;let provoking=gl_clip_raw[gl_clip.info.z];
 for(var i=0u;i<n;i++){let at=gl_clip_indices[gl_clip.info.x+i];var v=gl_clip_raw[at.x];v.params.y=f32(at.y);${flat}gl_clip_a[i]=v;}
 for(var plane=0u;plane<12u;plane++){
 if(n==0u){break;}if((plane==4u||plane==5u)&&gl_clip.raster.x!=0u){continue;}
 if(plane>=6u&&(gl_clip.style.w&(1u<<(plane-6u)))==0u){continue;}
 var inside=0u;for(var i=0u;i<n;i++){if(gl_clip_distance(gl_clip_load(i,source),plane)>=0.0){inside++;}}
 if(inside==n){continue;}if(inside==0u){n=0u;break;}
 var next=0u;var previous=gl_clip_load(n-1u,source);var previousDistance=gl_clip_distance(previous,plane);
 for(var i=0u;i<n;i++){
 let current=gl_clip_load(i,source);let currentDistance=gl_clip_distance(current,plane);
 if((currentDistance>=0.0)!=(previousDistance>=0.0)){
 var intersection=gl_clip_intersection(previous,current,previousDistance,currentDistance,plane);
 intersection.params.y=select(1.0,previous.params.y,currentDistance>=0.0);
 if(next<localCapacity){gl_clip_store(next,!source,intersection);}next++;
 }
 if(currentDistance>=0.0){if(next<localCapacity){gl_clip_store(next,!source,current);}next++;}
 previous=current;previousDistance=currentDistance;
 }
 if(next>localCapacity){n=0u;break;}n=next;source=!source;
 }
 var kept=0u;for(var i=0u;i<n;i++){var v=gl_clip_load(i,source);if(v.output.position.w<=0.0){continue;}
 ${clip ? "v.output." + clip + "=max(v.output." + clip + ",vec4<f32>(0.0));" : ""}
 ${extra ? "v.output." + extra + "=max(v.output." + extra + ",vec2<f32>(0.0));" : ""}
 gl_clip_store(kept,source,v);kept++;}n=kept;
 gl_clip_meta[base]=n;gl_clip_meta[base+1u]=select(0u,1u,source);
 var area=0.0;var slope=0.0;var best=0.0;var maximumDepth=0.0;
 if(n>0u){let a=gl_clip_window(gl_clip_load(0u,source));
 for(var i=0u;i<n;i++){let p=gl_clip_window(gl_clip_load(i,source));let q=gl_clip_window(gl_clip_load((i+1u)%n,source));area+=p.x*q.y-q.x*p.y;maximumDepth=max(maximumDepth,abs(clamp(p.z,0.0,1.0)));}
 for(var i=1u;i+1u<n;i++){let b=gl_clip_window(gl_clip_load(i,source));let c=gl_clip_window(gl_clip_load(i+1u,source));let det=(b.x-a.x)*(c.y-a.y)-(c.x-a.x)*(b.y-a.y);
 if(abs(det)>best){best=abs(det);slope=max(abs(((b.z-a.z)*(c.y-a.y)-(c.z-a.z)*(b.y-a.y))/det),abs(((b.x-a.x)*(c.z-a.z)-(c.x-a.x)*(b.z-a.z))/det));}}
 }
 var resolution=exp2(-24.0);if(gl_clip.depth.z==1.0){resolution=exp2(-16.0);}if(gl_clip.depth.z==2.0){resolution=exp2(select(-149.0,floor(log2(maximumDepth))-23.0,maximumDepth>0.0));}
 gl_clip_meta[base+3u]=bitcast<u32>(slope);gl_clip_meta[base+4u]=bitcast<u32>(resolution);
 var boundaries=0u;var distance=0.0;
 for(var i=0u;i<n;i++){var v=gl_clip_load(i,source);if(v.params.y==0.0){continue;}
 let a=gl_clip_window(v);let b=gl_clip_window(gl_clip_load((i+1u)%n,source));let delta=b.xy-a.xy;let xmajor=abs(delta.x)>=abs(delta.y);
 v.params.z=distance;v.params.w=select(select(-2.0,2.0,delta.y>=0.0),select(-1.0,1.0,delta.x>=0.0),xmajor);gl_clip_store(i,source,v);
 distance+=floor(max(abs(delta.x),abs(delta.y))+0.5);gl_clip_meta[base+16u+boundaries]=i;boundaries++;
 }
 gl_clip_meta[base+2u]=boundaries;

 let front=(area>=0.0)==(gl_clip.style.z!=0u);if(front!=(gl_clip.style.y==0u)){return;}
 switch gl_clip.style.x{
 case 0u:{if(n>=3u){gl_clip_meta[0]=(n-2u)*3u;gl_clip_meta[1]=1u;}}
 case 1u:{if(n>=2u){for(var i=0u;i<boundaries;i++){gl_clip_meta[i*4u]=2u;gl_clip_meta[i*4u+1u]=u32(gl_clip.depth.w);}}}
 default:{if(gl_clip.raster.z!=0u){for(var i=0u;i<boundaries;i++){gl_clip_meta[i*4u]=6u;gl_clip_meta[i*4u+1u]=1u;gl_clip_meta[i*4u+3u]=0u;}}else{gl_clip_meta[0]=6u;gl_clip_meta[1]=boundaries;}}
 }
}
`;
    }
    function render(vertex, fragment, iface, mode, options) {
        const output = interfaceOf(vertex), declarations = storageTypes(iface) + `
@group(0) @binding(0) var<storage,read> gl_clip_a:array<GLClipVertex>;
@group(0) @binding(1) var<storage,read> gl_clip_b:array<GLClipVertex>;
@group(0) @binding(2) var<storage,read> gl_clip_meta:array<u32>;
struct GLClipDraw {info:vec4<u32>,viewport:vec4<f32>,depth:vec4<f32>,raster:vec4<u32>}
@group(0) @binding(3) var<uniform> gl_clip_draw:GLClipDraw;
fn gl_clip_fetch(i:u32)->GLClipVertex{if(gl_clip_meta[gl_clip_draw.info.x*4u+1u]!=0u){return gl_clip_b[i];}return gl_clip_a[i];}
`;
        if (!entry.test(vertex)) throw new Error("polygon clipping requires a render vertex entry");
        vertex = vertex.replace(entry, "fn gl_clip_unused_vertex($1)->VSOut{") + declarations + `
@vertex fn vs_main(@builtin(vertex_index) gl_vertex:u32,@builtin(instance_index) gl_instance:u32)->VSOut{
 let gl_base=gl_clip_draw.info.x*4u;let gl_count=gl_clip_meta[gl_base];var gl_at=0u;
 ${mode === 0 ? "let gl_corner=gl_vertex%3u;gl_at=select(0u,gl_vertex/3u+gl_corner,gl_corner!=0u);" :
        mode === 1 ? "gl_at=gl_clip_meta[gl_base+16u+gl_clip_draw.info.z];if(gl_vertex==1u){gl_at=(gl_at+1u)%gl_count;}" : "gl_at=gl_clip_meta[gl_base+16u+gl_clip_draw.info.z+gl_instance];"}
 let gl_value=gl_clip_fetch(gl_at);var gl_out:VSOut;
 ${output.fields.map(field => {
        if (["pointCoord", "glPointCoord"].includes(field.name) && mode === 2) return "";
        return iface.fields.some(source => source.name === field.name) ? "gl_out." + field.name + "=gl_value.output." + field.name + ";" : "";
    }).join("\n")}
 ${mode === 1 ? `let gl_a=gl_clip_fetch(gl_clip_meta[gl_base+16u+gl_clip_draw.info.z]).output.position;
 let gl_b=gl_clip_fetch((gl_clip_meta[gl_base+16u+gl_clip_draw.info.z]+1u)%gl_count).output.position;
 let gl_delta=(gl_b.xy*gl_a.w-gl_a.xy*gl_b.w)*gl_clip_draw.viewport.zw;let gl_offset=f32(gl_instance)-(f32(gl_clip_draw.raster.x)-1.0)*0.5;
 if(abs(gl_delta.x)>=abs(gl_delta.y)){gl_out.position.y-=2.0*gl_offset*gl_out.position.w/gl_clip_draw.viewport.w;}
 else{gl_out.position.x+=2.0*gl_offset*gl_out.position.w/gl_clip_draw.viewport.z;}` : ""}
 ${mode === 2 ? `let gl_corner=gl_point_corner(gl_vertex);var clip=vec4<f32>(gl_out.position.x,-gl_out.position.y,gl_out.position.z*2.0-gl_out.position.w,gl_out.position.w);
 clip=gl_point_position(clip,gl_value.params.x,gl_corner,gl_clip_draw.viewport);clip.z=(clip.z+clip.w)*0.5;clip.y=-clip.y;gl_out.position=clip;
 ${output.fields.filter(field => ["pointCoord", "glPointCoord"].includes(field.name)).map(field => "gl_out." + field.name + "=vec2<f32>(gl_corner.x*0.5+0.5," + (options.lowerLeft ? "gl_corner.y*0.5+0.5" : "0.5-gl_corner.y*0.5") + ");").join("\n")}` : ""}
 ${options.reversed ? "gl_out.position.z=gl_out.position.w-gl_out.position.z;" : ""}
 ${mode !== 0 ? `let gl_range=abs(gl_clip_draw.depth.y-gl_clip_draw.depth.x);if(gl_range>0.0){let gl_offset=(bitcast<f32>(gl_clip_meta[gl_base+3u])*gl_clip_draw.depth.z+bitcast<f32>(gl_clip_meta[gl_base+4u])*gl_clip_draw.depth.w)/gl_range;
 gl_out.position.z+=gl_offset*gl_out.position.w;}` : ""}
 return gl_out;
}
`;
        if (mode === 1 && options.stipple) {
            const fragmentEntry = /@fragment\s+fn\s+fs_main\s*\(([^]*?)\)\s*->\s*FSOut\s*\{/;
            fragment = fragment.replace(fragmentEntry, "fn gl_clip_fragment_entry($1)->FSOut{") + declarations + `
@fragment fn fs_main(gl_fragment:FSIn)->FSOut{
 let gl_base=gl_clip_draw.info.x*4u;let gl_value=gl_clip_fetch(gl_clip_meta[gl_base+16u+gl_clip_draw.info.z]);let p=gl_value.output.position;
 let gl_start=gl_clip_draw.viewport.xy+(vec2<f32>(p.x,-p.y)/p.w*0.5+0.5)*gl_clip_draw.viewport.zw;
 let gl_xmajor=abs(gl_value.params.w)<1.5;let gl_coordinate=select(gl_fragment.position.y,gl_fragment.position.x,gl_xmajor);
 let gl_distance=gl_value.params.z+max(0.0,floor((gl_coordinate-select(gl_start.y,gl_start.x,gl_xmajor))*sign(gl_value.params.w)+0.5));
 let gl_bit=(u32(gl_distance)/gl_clip_draw.raster.z)%16u;if(((gl_clip_draw.raster.y>>gl_bit)&1u)==0u){discard;}
 return gl_clip_fragment_entry(gl_fragment);
}
`;
        }
        return { vertex, fragment };
    }
    const api = { interfaceOf, capture, kernel, render };
    global.GLPolygonClip = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
