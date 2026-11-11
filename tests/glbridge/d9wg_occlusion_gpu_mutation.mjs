import assert from "node:assert/strict";
import fs from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../../",import.meta.url)),directory=root+"build/d3d-review/occlusion-gpu-mutations";
fs.mkdirSync(directory,{recursive:true});
const html=fs.readFileSync(root+"tests/glbridge/d3d9_occlusion_browser_test.html","utf8")
    .replaceAll('src="../../src/','src="/src/').replace(/src="(d3d[^"/]+\.js)"/g,'src="/tests/glbridge/$1"');
const file="src/browser/glbridge/d3d9-webgpu/d9wg_frame_replayer.js",source=fs.readFileSync(root+file,"utf8");
for(const [name,before,after] of [
    ["missing-count-output","result.samples = vec4<f32>(1.0)","result.samples = vec4<f32>(0.0)"],
    ["half-float-overflow","COUNTER_PRIMITIVE_BUDGET = 256","COUNTER_PRIMITIVE_BUDGET = 65536"],
    ["strip-winding","COUNTER_PRIMITIVE_BUDGET = 256","COUNTER_PRIMITIVE_BUDGET = 255"],
    ["missing-msaa-samples","sample < ${sampleCount};","sample < 1;"],
    ["missing-64-bit-carry","atomicAdd(&total.high, 1u);","atomicAdd(&total.high, 0u);"],
    ["lost-present-accumulator","else record.value += result.values.get(completion);","else record.value = result.values.get(completion);"],
    ["native-boolean-count",null,null],
]) {
    let page=html;
    if(before) {
        assert.equal(source.split(before).length,2,name);
        fs.writeFileSync(directory+"/d9wg_frame_replayer.js",source.replace(before,after));
        page=page.replace('src="/'+file+'"','src="/build/d3d-review/occlusion-gpu-mutations/d9wg_frame_replayer.js"');
    }
    fs.writeFileSync(directory+"/test.html",page);
    const run=spawnSync(process.execPath,[root+"tests/glbridge/gl_multipass_browser_runner.js",
        "../../build/d3d-review/occlusion-gpu-mutations/test.html"+(before?"":"?native_occlusion=1")],{cwd:root,encoding:"utf8",timeout:180000});
    assert.equal(run.status,1,name+run.stderr);const result=JSON.parse(run.stdout);
    assert.equal(result.status,"FAIL");assert(/: count \d+ expected \d+|64-bit reduction carry/.test(result.details),result.details);
    assert(result.details.includes('"errors":[]')&&result.details.includes('"host":[]'),result.details);
    fs.writeFileSync(directory+"/"+name+".json",JSON.stringify(result,null,2)+"\n");
}
console.log("PASS exact occlusion GPU negative controls: 7/7 count output, half-float precision, strip winding, MSAA samples, 64-bit carry, Present accumulation and native boolean errors detected without GPU/host errors");
