"use strict";
(function(global){
 const names=["fixed_priority","arb_rect","glsl_rect","glsl_shadow_rect","arb_shadow_rect","default_object","copy_update","subimage","border","linear","fbo_image"],
  image=new Uint8Array([255,0,0,255,0,255,0,255,0,0,255,255,128,128,0,255,0,128,128,255,128,0,128,255]);
 function scene(s,c,GL,P){
  const target=GL.TEXTURE_RECTANGLE;
  s.call("VIEWPORT",0,0,16,16).call("CLEAR_COLOR",0,0,0,0).call("CLEAR",GL.COLOR_BUFFER_BIT)
   .call("BIND_TEXTURE",GL.TEXTURE_2D,2).texImage2D(GL.TEXTURE_2D,0,GL.RGBA8,1,1,GL.RGBA,GL.UNSIGNED_BYTE,new Uint8Array([0,0,255,255]))
   .call("TEX_PARAMETERI",GL.TEXTURE_2D,GL.TEXTURE_MIN_FILTER,GL.NEAREST).call("ENABLE",GL.TEXTURE_2D)
   .call("BIND_TEXTURE",target,c===5?0:1).texImage2D(target,0,GL.RGBA8,3,2,GL.RGBA,GL.UNSIGNED_BYTE,image)
   .call("TEX_PARAMETERI",target,GL.TEXTURE_MIN_FILTER,GL.NEAREST).call("TEX_PARAMETERI",target,GL.TEXTURE_MAG_FILTER,GL.NEAREST)
   .call("TEX_ENVI",GL.TEXTURE_ENV,GL.TEXTURE_ENV_MODE,GL.REPLACE).call("ENABLE",target);
  if (c===3||c===4)s.texImage2D(target,0,GL.DEPTH_COMPONENT24,3,2,GL.DEPTH_COMPONENT,GL.FLOAT,new Uint8Array(new Float32Array([0.25,0.25,0.25,0.75,0.75,0.75]).buffer))
   .call("TEX_PARAMETERI",target,GL.TEXTURE_COMPARE_MODE,GL.COMPARE_R_TO_TEXTURE).call("TEX_PARAMETERI",target,GL.TEXTURE_COMPARE_FUNC,GL.LEQUAL);
  if (c===1||c===4)s.call("DISABLE",target).call("BIND_PROGRAM_ARB",GL.FRAGMENT_PROGRAM_ARB,1).programStringARB(GL.FRAGMENT_PROGRAM_ARB,c===4?
   "!!ARBfp1.0\nOPTION ARB_fragment_program_shadow;\nTEX result.color,fragment.texcoord[0],texture[0],SHADOWRECT;\nEND\n":
   "!!ARBfp1.0\nTEX result.color,fragment.texcoord[0],texture[0],RECT;\nEND\n").call("ENABLE",GL.FRAGMENT_PROGRAM_ARB);
  if (c===2||c===3){const fragment=c===3?"#version 120\n#extension GL_ARB_texture_rectangle:require\nuniform sampler2DRectShadow image;void main(){gl_FragColor=shadow2DRect(image,gl_TexCoord[0].xyz);}":
   "#version 120\n#extension GL_ARB_texture_rectangle:require\nuniform sampler2DRect image;void main(){gl_FragColor=texture2DRect(image,gl_TexCoord[0].xy);}";
   s.call("DISABLE",target).call("CREATE_PROGRAM",1).call("CREATE_SHADER",2,GL.VERTEX_SHADER).call("CREATE_SHADER",3,GL.FRAGMENT_SHADER)
    .shaderSource(2,"#version 120\nvoid main(){gl_Position=gl_Vertex;gl_TexCoord[0]=gl_MultiTexCoord0;}").shaderSource(3,fragment)
    .call("COMPILE_SHADER",2).call("COMPILE_SHADER",3).call("ATTACH_SHADER",1,2).call("ATTACH_SHADER",1,3).call("LINK_PROGRAM",1).call("USE_PROGRAM",1);
  }
  if (c===6)s.call("CLEAR_COLOR",1,0,0,1).call("CLEAR",GL.COLOR_BUFFER_BIT).call("COPY_TEX_SUB_IMAGE_2D",target,0,0,0,0,0,3,2).call("CLEAR_COLOR",0,0,0,0).call("CLEAR",GL.COLOR_BUFFER_BIT);
  if (c===7)s.texSubImage2D(target,0,1,1,1,1,GL.RGBA,GL.UNSIGNED_BYTE,new Uint8Array([255,255,255,255]));
  if (c===8)s.call("TEX_PARAMETERI",target,GL.TEXTURE_WRAP_S,GL.CLAMP_TO_BORDER).call("TEX_PARAMETERFV",target,GL.TEXTURE_BORDER_COLOR,4,0,1,0,1).call("MATRIX_MODE",GL.TEXTURE).call("TRANSLATEF",-4,0,0).call("MATRIX_MODE",GL.MODELVIEW);
  if (c===9)s.texImage2D(target,0,GL.RGBA8,3,2,GL.RGBA,GL.UNSIGNED_BYTE,new Uint8Array([128,0,0,255,0,128,0,255,0,0,128,255,128,128,0,255,0,128,128,255,128,0,128,255])).call("TEX_PARAMETERI",target,GL.TEXTURE_MIN_FILTER,GL.LINEAR).call("TEX_PARAMETERI",target,GL.TEXTURE_MAG_FILTER,GL.LINEAR)
   .call("MATRIX_MODE",GL.TEXTURE).call("TRANSLATEF",1,1,0).call("SCALEF",0,0,1).call("MATRIX_MODE",GL.MODELVIEW);
  if (c===10)s.names(P.GLFN.GEN_FRAMEBUFFERS,[1]).call("BIND_FRAMEBUFFER",GL.FRAMEBUFFER_EXT,1).call("FRAMEBUFFER_TEXTURE_2D",GL.FRAMEBUFFER_EXT,GL.COLOR_ATTACHMENT0,target,1,0)
   .call("CLEAR_COLOR",0,1,0,1).call("CLEAR",GL.COLOR_BUFFER_BIT).call("BIND_FRAMEBUFFER",GL.FRAMEBUFFER_EXT,0).call("CLEAR_COLOR",0,0,0,0);
  return draw(s,GL);
 }
 function draw(s,GL){return s.call("BEGIN",GL.TRIANGLES).call("TEX_COORD4F",0,0,0.5,1).call("VERTEX3F",-1,-1,0).call("TEX_COORD4F",6,0,0.5,1).call("VERTEX3F",3,-1,0).call("TEX_COORD4F",0,4,0.5,1).call("VERTEX3F",-1,3,0).call("END");
 }
 const api={names,image,scene,draw};global.GLRectangleCases=api;if (typeof module!=="undefined"&&module.exports)module.exports=api;
})(typeof globalThis!=="undefined"?globalThis:this);
