"use strict";
(function(global) {
    const version = source => "#version 120\n" + source,
        vertex = version("void main(){gl_Position=gl_Vertex;}"), fragment = version("void main(){gl_FragColor=vec4(0.25,0.5,0.75,1.0);}"),
        cases = [
            { name: "reserved_names", fragment: version("void main(){float target=0.25;float self=0.5;float type=0.75;gl_FragColor=vec4(target,self,type,1.0);}") },
            { name: "reserved_fields_function", fragment: version("struct Value{float self;};float target(float value){return value*0.5;}void main(){Value type=Value(0.5);gl_FragColor=vec4(target(type.self),type.self,0.75,1.0);}") },
            { name: "builtin_shadow_names", fragment: version("void main(){float floor=0.25;float select=0.5;gl_FragColor=vec4(mod(0.75,0.5),max(floor,select),floor<select?0.75:0.0,1.0);}") },
            { name: "stage_parameter_names", fragment: version("void main(){float fsin=0.25;float vsin=0.5;float var=0.75;float var_=1.0;gl_FragColor=vec4(fsin,vsin,var,var_);}") },
            { name: "double_underscore", fragment: version("void main(){float __value=0.5;gl_FragColor=vec4(0.25,__value,0.75,1.0);}") },
            { name: "uniform_value_struct", fragment: version("struct State{bool enabled;float weights[3];vec2 offset;};uniform State settings;void main(){State local=settings;local.weights[1]+=0.125;gl_FragColor=vec4(local.enabled?local.weights[1]:0.0,local.offset,1.0);}"), uniforms: [
                { name: "settings.enabled", integer: true, value: [1] }, { name: "settings.weights", components: 1, count: 3, value: [0.125, 0.25, 0.5] }, { name: "settings.offset", components: 2, value: [0.5, 0.75] }] },
            { name: "uniform_float_array", fragment: version("uniform float values[3];void main(){float local[3];local=values;gl_FragColor=vec4(local[0],local[1],local[2],1.0);}"), uniforms: [{ name: "values", components: 1, count: 3, value: [0.25, 0.5, 0.75] }] },
            { name: "array_constructor_length", fragment: version("void main(){float a[3]=float[3](0.25,0.5,0.75);gl_FragColor=vec4(a[0],a[1],float(a.length())/4.0,1.0);}") },
            { name: "const_array_bound", fragment: version("const int N=3;uniform vec4 a[N];void main(){gl_FragColor=a[2];}"), uniforms: [{ name: "a", components: 4, count: 3, value: [0, 0, 0, 1, 0, 0, 0, 1, 0.25, 0.5, 0.75, 1] }] },
            { name: "uniform_initializer", fragment: version("uniform vec4 tint=vec4(0.25,0.5,0.75,1.0);void main(){gl_FragColor=tint;}") },
            { name: "uniform_local_shadow", fragment: version("uniform float value;float readGlobal(){return value;}void main(){float value=0.5;gl_FragColor=vec4(readGlobal(),value,0.75,1.0);}"), uniforms: [{ name: "value", components: 1, value: [0.25] }] },
            { name: "ftransform_color", scale: 0.5, vertex: version("void main(){gl_Position=ftransform();gl_FrontColor=gl_Color;}"), fragment: version("void main(){gl_FragColor=gl_Color;}") },
            { name: "texcoord_redeclare", vertex: version("varying vec4 gl_TexCoord[2];void main(){gl_Position=gl_Vertex;gl_TexCoord[1]=vec4(0.25,0.5,0.75,1.0);}"), fragment: version("varying vec4 gl_TexCoord[2];void main(){gl_FragColor=gl_TexCoord[1];}") },
            { name: "position_invariant", vertex: version("invariant gl_Position;void main(){gl_Position=gl_Vertex;}") },
            { name: "legacy_light_state", fragment: version("void main(){gl_FragColor=gl_LightSource[0].diffuse+gl_Fog.color;}") },
            { name: "shadow_1d", fragment: version("uniform sampler1DShadow depthTex;void main(){gl_FragColor=vec4(shadow1D(depthTex,vec3(0.75,0.0,0.5)).r,shadow1D(depthTex,vec3(0.25,0.0,0.5)).r,0.25,1.0);}"), texture: "depth1d" },
            { name: "shadow_2d_proj_bias", fragment: version("uniform sampler2DShadow depthTex;void main(){gl_FragColor=shadow2DProj(depthTex,vec4(0.75,0.75,0.5,1.0),0.0);}"), texture: "depth2d" },
            { name: "opaque_uniform_struct", fragment: version("struct Source{sampler2D image;vec4 tint;};uniform Source source;void main(){gl_FragColor=texture2D(source.image,vec2(0.5))*source.tint;}"), texture: "color2d", uniforms: [{ name: "source.tint", components: 4, value: [1, 1, 1, 1] }] },
            { name: "undefined_division", fragment: version("void main(){float value=1.0/0.0;gl_FragColor=vec4(value,0.5,0.75,1.0);}"), defined: false },
            { name: "undefined_sqrt", fragment: version("void main(){float value=sqrt(-1.0);gl_FragColor=vec4(value,0.5,0.75,1.0);}"), defined: false },
            { name: "undefined_integer_division", fragment: version("void main(){int value=1/0;gl_FragColor=vec4(float(value),0.5,0.75,1.0);}"), defined: false },
        ].map(entry => ({ vertex, fragment, uniforms: [], defined: true, ...entry }));
    global.GLGLSL120CodegenCases = cases;if (typeof module !== "undefined" && module.exports) module.exports = cases;
})(typeof globalThis !== "undefined" ? globalThis : this);
