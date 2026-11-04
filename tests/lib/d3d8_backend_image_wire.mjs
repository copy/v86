// Reuse4K19 independent depth/stencil images;format65 CPU bits are checked bySDK.
import assert from 'node:assert/strict';
import {backend_depth_scenes,inspect_backend_depth_wire} from './d3d8_backend_depth_wire.mjs';
export const backend_image_scenes=backend_depth_scenes;
export function inspect_backend_image_wire(bytes,result){
 let text=result.logs['IMAGE8RT.TXT'].replace(/\r/g,'');
 const rows=[['IMAGE8 LEGACY mode=0 format65=1 Size=24 pitch=12 finalRefs=0',0],['IMAGE8 LEGACY mode=1 format65=1 Size=24 pitch=12 finalRefs=0',4],['IMAGE8 ORDINARY9 format65Refused=1',8],['IMAGE8 CORE mode=3 format65=1 Size=24 pitch=12 invalidCases=9 descriptorGuards=1 finalRefs=0',12],['IMAGE8 CORE mode=4 format65=1 Size=24 pitch=12 invalidCases=9 descriptorGuards=1 finalRefs=0',16]];
 for(const[line,frame]of rows){assert.equal(text.split(line).length,2);assert(text.includes(line+'\nDEPTH8 FRAME index='+frame+' '));text=text.replace(line+'\n','');}
 return{...inspect_backend_depth_wire(bytes,{...result,logs:{'DEPTH8RT.TXT':text}}),cpuFormat65Modes:4,ordinary9Format65Refusals:1,privateImageInvalidCases:18,descriptorWordBytes:32};
}
