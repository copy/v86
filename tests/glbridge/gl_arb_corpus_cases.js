"use strict";
(function(global){
 function scene(s,row,GL,P){
  const vertex=row.stage==="vertex",stage=vertex?GL.VERTEX_PROGRAM_ARB:GL.FRAGMENT_PROGRAM_ARB,
   helper=/result\.color/.test(row.source)?"!!ARBfp1.0\nMOV result.color,fragment.color;\nMOV result.color.w,1.0;\nEND\n":"!!ARBfp1.0\nMOV result.color,{0.25,0.5,0.75,1.0};\nEND\n";
  s.call("VIEWPORT",0,0,16,16).call("CLEAR_COLOR",0,0,0,0).call("CLEAR",GL.COLOR_BUFFER_BIT).call("BIND_PROGRAM_ARB",stage,1).programStringARB(stage,row.source).call("ENABLE",stage);
  if (vertex)s.call("BIND_PROGRAM_ARB",GL.FRAGMENT_PROGRAM_ARB,2).programStringARB(GL.FRAGMENT_PROGRAM_ARB,helper).call("ENABLE",GL.FRAGMENT_PROGRAM_ARB);
  for (const [index,values] of row.locals)s.programParameterARB(2,stage,index,values);
  const kind=row.texture||"2D",depth=kind==="SHADOW2D",target=kind==="1D"?GL.TEXTURE_1D:kind==="3D"?GL.TEXTURE_3D:kind==="CUBE"?GL.TEXTURE_CUBE_MAP:kind==="RECT"?GL.TEXTURE_RECTANGLE:GL.TEXTURE_2D,
   data=depth?new Uint8Array(new Float32Array([0.75]).buffer):new Uint8Array([64,128,191,255]);
  s.call("BIND_TEXTURE",target,1).call("TEX_PARAMETERI",target,GL.TEXTURE_MIN_FILTER,GL.NEAREST).call("TEX_PARAMETERI",target,GL.TEXTURE_MAG_FILTER,GL.NEAREST);
  if (depth)s.call("TEX_PARAMETERI",target,GL.TEXTURE_COMPARE_MODE,GL.COMPARE_R_TO_TEXTURE).call("TEX_PARAMETERI",target,GL.TEXTURE_COMPARE_FUNC,GL.LEQUAL);
  if (kind==="1D"||kind==="3D"){
   const name=kind==="1D"?"TEX_IMAGE_1D":"TEX_IMAGE_3D",header=P.encodeRecord(name,{target,level:0,internalformat:GL.RGBA8,width:1,height:1,depth:1,border:0,format:GL.RGBA,type:GL.UNSIGNED_BYTE,data_size:data.length});
   s.record(P.GLFN[name],new Uint8Array([...header,...data]));
  } else if (kind==="CUBE") for (let face=0;face<6;face++)s.texImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X+face,0,GL.RGBA8,1,1,GL.RGBA,GL.UNSIGNED_BYTE,data);
  else s.texImage2D(target,0,depth?GL.DEPTH_COMPONENT24:GL.RGBA8,1,1,depth?GL.DEPTH_COMPONENT:GL.RGBA,depth?GL.FLOAT:GL.UNSIGNED_BYTE,data);
  s.call("COLOR4F",0.25,0.5,0.75,1).call("NORMAL3F",0,0,1);for (let i=0;i<8;i++)s.call("MULTI_TEX_COORD4F",GL.TEXTURE0+i,0.5,0.5,0.5,1);
  return s.call("BEGIN",GL.TRIANGLES).call("VERTEX3F",-1,-1,0).call("VERTEX3F",3,-1,0).call("VERTEX3F",-1,3,0).call("END");
 }
 const api={scene};global.GLARBCorpusCases=api;if (typeof module!=="undefined"&&module.exports)module.exports=api;
})(typeof globalThis!=="undefined"?globalThis:this);
