"use strict";
(function(global){
 const scalar=["RCP result.color, fragment.color;","RCP result.color, fragment.color.x;","RSQ result.color, fragment.color.xxxx;","POW result.color, fragment.color.x, fragment.color;","POW result.color, fragment.color, fragment.color.x;","POW result.color, 0.25, 0.5;","RCP result.color, {2,3,4,5};","RCP result.color, {2,3,4,5}.y;", "POW result.color, {0.25}.x, {0.5}.x;"].map(body=>"!!ARBfp1.0\n"+body+"\nEND\n"),
 names=["logic_fixed_vertex","logic_arb_pair","point_replace","point_no_replace","point_disabled","point_replace_arb_pair","alpha_less","alpha_never","alpha_gequal","alpha_pair","logic_copy","logic_mrt"];
 function scene(s,c,GL){
  const program=(target,name,source)=>s.call("BIND_PROGRAM_ARB",target,name).programStringARB(target,source).call("ENABLE",target),
   triangle=()=>s.call("BEGIN",GL.TRIANGLES).call("VERTEX3F",-1,-1,0).call("VERTEX3F",3,-1,0).call("VERTEX3F",-1,3,0).call("END");
  if (c===11){const P=global.GLProtocol||require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");s.names(P.GLFN.GEN_FRAMEBUFFERS,[1]).call("BIND_FRAMEBUFFER",GL.FRAMEBUFFER_EXT,1).names(P.GLFN.GEN_RENDERBUFFERS,[1,2]);for (let i=0;i<2;i++)s.call("BIND_RENDERBUFFER",GL.RENDERBUFFER_EXT,i+1).call("RENDERBUFFER_STORAGE",GL.RENDERBUFFER_EXT,GL.RGBA8,16,16).call("FRAMEBUFFER_RENDERBUFFER",GL.FRAMEBUFFER_EXT,GL.COLOR_ATTACHMENT0+i,GL.RENDERBUFFER_EXT,i+1);}
  s.call("VIEWPORT",0,0,16,16).call("CLEAR_COLOR",0.2,0.4,0.6,0.8).call("CLEAR",GL.COLOR_BUFFER_BIT).call("COLOR4F",0.8,0.2,0.4,0.6)
   .call("MULTI_TEX_COORD4F",GL.TEXTURE0,0.25,0.5,0.75,1).call("MULTI_TEX_COORD4F",GL.TEXTURE0+1,0.5,0.25,0,1);
  if (c===11){const P=global.GLProtocol||require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");s.call("DRAW_BUFFER",GL.COLOR_ATTACHMENT0+1).call("CLEAR_COLOR",0.6,0.4,0.2,0.8).call("CLEAR",GL.COLOR_BUFFER_BIT).names(P.GLFN.DRAW_BUFFERS,[GL.COLOR_ATTACHMENT0,GL.COLOR_ATTACHMENT0+1]);}
  if ([1,5,9].includes(c))program(GL.VERTEX_PROGRAM_ARB,1,"!!ARBvp1.0\nMOV result.position,vertex.position;\nMOV result.color,vertex.color;\nMOV result.texcoord[0],vertex.texcoord[0];\nMOV result.texcoord[1],vertex.texcoord[1];\nEND\n");
  program(GL.FRAGMENT_PROGRAM_ARB,2,c>=2&&c<=5?"!!ARBfp1.0\nMOV result.color,fragment.texcoord[0];\nMOV result.color.z,fragment.texcoord[1].x;\nEND\n":"!!ARBfp1.0\nMOV result.color,fragment.color.primary;\nEND\n");
  if (c<=1||c===11){s.call("ENABLE",GL.COLOR_LOGIC_OP).call("ENABLE",GL.SCISSOR_TEST);for (let op=0;op<16;op++){s.call("VIEWPORT",op%4*4,Math.floor(op/4)*4,4,4).call("SCISSOR",op%4*4,Math.floor(op/4)*4,4,4).call("LOGIC_OP",0x1500+op);triangle();}}
  else if (c>=2&&c<=5){s.call("POINT_SIZE",8);if (c!==4)s.call("ENABLE",GL.POINT_SPRITE);s.call("ACTIVE_TEXTURE",GL.TEXTURE0).call("TEX_ENVI",GL.POINT_SPRITE,GL.COORD_REPLACE,c===3?0:1).call("ACTIVE_TEXTURE",GL.TEXTURE0+1).call("TEX_ENVI",GL.POINT_SPRITE,GL.COORD_REPLACE,0).call("ACTIVE_TEXTURE",GL.TEXTURE0).call("BEGIN",GL.POINTS).call("VERTEX3F",0,0,0).call("END");}
  else {if (c===10)s.call("ENABLE",GL.COLOR_LOGIC_OP).call("LOGIC_OP",GL.COPY);else s.call("ENABLE",GL.ALPHA_TEST).call("ALPHA_FUNC",c===7?GL.NEVER:c===8?GL.GEQUAL:GL.LESS,(c===8||c===6)?0.5:0.7);triangle();}
  return s;
 }
 const api={scalar,names,scene};global.GLARBPipelineCases=api;if (typeof module!=="undefined"&&module.exports)module.exports=api;
})(typeof globalThis!=="undefined"?globalThis:this);
