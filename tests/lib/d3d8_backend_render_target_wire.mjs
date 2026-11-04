// Reuse the independent4K17 operation/image contract for the new SDK8 creation boundary.
import assert from 'node:assert/strict';
import {renderable_lock_scenes,inspect_renderable_lock_wire} from './d3d_renderable_lock_wire.mjs';
export const backend_render_target_scenes=renderable_lock_scenes;
export function inspect_backend_render_target_wire(bytes,result){
 const guard='RTCORE CHECK invalidCases=13 sdkABI=8 profile=8 earlyOutput=1';
 const text=result.logs['RTLOCK.TXT'].replace(/\r/g,'');assert.equal(text.split(guard).length,2);
 const clean=text.replace(guard+'\n','');
 // Guard matrix must complete immediately before the private core's first frame.
 assert(text.includes(guard+'\nRTLOCK FRAME index=34 mode=4 api=18 sdk=220 target=0 step=0 readback=1'));
 return{...inspect_renderable_lock_wire(bytes,{...result,logs:{'RTLOCK.TXT':clean}}),sdkGuardCases:13};
}
