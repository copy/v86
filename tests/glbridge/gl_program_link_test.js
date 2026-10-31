"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const {setImmediate} = require("node:timers");
const {GLShadow} = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js"),
    {Glslang} = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js"),
    {GLWebGPUExecutor} = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"),
    {createFakeHost} = require("./gl_fake_gpu.js"), {GLStream, GL} = require("./gl_stream_builder.js"),
    {connect} = require("./gl_program_link_harness.js"), P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_glsl.js");
const compiler = new Glslang(fs.readFileSync(path.join(__dirname, "../../bios/glslang.wasm"))), kind = P.C.V86GL_OBJECT_KIND_PROGRAM;
const fragment = "#version 120\nuniform float value=0.25;void main(){gl_FragColor=vec4(value,0.5,0.75,1.0);}";
const setup = () => new GLStream().makeCurrent(1,0,0,16,16,1,1).call("CREATE_PROGRAM",1)
    .call("CREATE_SHADER",2,GL.VERTEX_SHADER).shaderSource(2,"void main(){gl_Position=gl_Vertex;}").call("COMPILE_SHADER",2)
    .call("CREATE_SHADER",3,GL.FRAGMENT_SHADER).shaderSource(3,fragment).call("COMPILE_SHADER",3)
    .call("ATTACH_SHADER",1,2).call("ATTACH_SHADER",1,3);
const linked = r => r.view.getInt32(P.F.QUERY_OBJECT_IV.value,true);
(async () => {
    for (const copied of [false,true]) {
        const cpu = new GLShadow(), {host,device} = createFakeHost(), gpu = new GLWebGPUExecutor(null,{host,strict:true});
        await gpu.initialize();cpu.setCapabilities(gpu.capabilities());cpu.setGlslang(compiler);
        const wire = connect(cpu,gpu,copied), createModule = device.createShaderModule.bind(device);
        let pending = [], mode = "hold", stages = 0;
        device.createShaderModule = descriptor => {
            const module = createModule(descriptor);
            module.getCompilationInfo = () => {
                stages++;assert.equal(device.openScopes(),0,"no device scope crosses an await");
                if (mode === "reject") return Promise.reject(new Error("injected compiler rejection"));
                if (mode === "throw") throw new Error("injected compiler exception");
                if (mode === "error") return Promise.resolve({messages:[{type:"error",lineNum:7,message:"invalid backend identifier"}]});
                if (mode === "warning") return Promise.resolve({messages:[{type:"warning",message:"warning only"}]});
                return new Promise(resolve => pending.push(resolve));
            };
            return module;
        };
        await wire.send(setup());
        const first = new GLStream().call("LINK_PROGRAM",1), query = first.queryObjectiv(kind,1,GL.LINK_STATUS);
        wire.start(first);await new Promise(resolve => setImmediate(resolve));
        assert.equal(query.view.getUint32(P.F.QUERY_OBJECT_IV.status,true),0,"query waits for backend");
        assert.ok(cpu.cpuBarrier);assert.equal(pending.length,2,"both generated stages checked");
        const job = [...cpu.programLinkJobs.values()][0], result = {job:job.id,program:1,object_id:job.program.objectId,link_generation:job.generation,ok:true};
        for (const key of ["job","program","object_id","link_generation"]) assert.equal(cpu.completeProgramLink({...result,[key]:result[key]+1}),false,key);
        pending.forEach(resolve => resolve({messages:[]}));pending=[];await gpu.idle();
        assert.equal(linked(query),1);assert.equal(cpu.cpuBarrier,null);assert.equal(cpu.completeProgramLink(result),false,"duplicate result ignored");
        const c = cpu.current.group.programs.get(1), g = gpu.current.shareGroup.programs.get(1), location = c.linked.uniforms.find(u=>u.name==="value").location;
        await wire.send(new GLStream().call("USE_PROGRAM",1).uniformfv(location,1,1,[0.875]));
        const code = g.compiled, bytes = g.uniformData.slice(), executable = c.installed;
        for (const failure of ["error","reject","throw"]) {
            mode = failure;gpu.moduleCache.clear();
            const s = new GLStream().call("LINK_PROGRAM",1), q = s.queryObjectiv(kind,1,GL.LINK_STATUS), log = s.queryObjectLog(kind,1,512);
            wire.start(s);assert.equal(c.installed,executable,"old CPU executable retained while pending");
            await gpu.idle();assert.equal(linked(q),0,failure);assert.match(Buffer.from(log.bytes.subarray(24)).toString(),/GPU program link/);
            assert.equal(g.compiled,code);assert.equal(g.linked,false);assert.deepEqual(g.uniformData,bytes);assert.equal(c.installed,executable);assert.deepEqual(c.values.get(location),[0.875]);
            const restore = new GLShadow();restore.setState(JSON.parse(JSON.stringify(cpu.getState())));restore.setGlslang(compiler);
            const saved = restore.current.group.programs.get(1);assert.equal(restore.linkedProgram(saved).ok,false);assert.match(saved.linked.log,/GPU program link/);
            assert.equal(restore.installedProgram(saved).ok,true);assert.deepEqual(saved.values.get(location),[0.875]);
        }
        mode="warning";gpu.moduleCache.clear();await wire.send(new GLStream().call("LINK_PROGRAM",1));assert.equal(c.linked.ok,true);
        assert.deepEqual(c.values.get(location),[0.25],"successful relink installs initializers");assert.notEqual(g.compiled,code);
        mode="hold";gpu.moduleCache.clear();wire.start(new GLStream().call("LINK_PROGRAM",1));await new Promise(resolve=>setImmediate(resolve));
        const stale = {...wire.results.at(-1),job:[...cpu.programLinkJobs.keys()][0]};cpu.cancelCPU();
        assert.equal(cpu.programLinkJobs.size,0,"cancelled jobs release all candidates");
        assert.equal(cpu.completeProgramLink(stale),false);pending.forEach(resolve=>resolve({messages:[]}));pending=[];await gpu.idle();
        assert.equal(c.linked.ok,false);assert.match(c.linked.log,/cancelled/);
        cpu.nextProgramLinkJob=0xFFFFFFFF;await wire.send(new GLStream().call("LINK_PROGRAM",1));assert.equal(cpu.current.error,GL.OUT_OF_MEMORY);
        const fresh = new GLShadow();fresh.setCapabilities(gpu.capabilities());fresh.setGlslang(compiler);fresh.process(setup().bytes());
        fresh.process(new GLStream().record(P.GLFN.PROGRAM_LINK_VALIDATION,P.encodeRecord("PROGRAM_LINK_VALIDATION",{operation:1,job:1,program:1,object_id:1,link_generation:1,data_size:0})).bytes());
        assert.equal(fresh.current.error,GL.INVALID_OPERATION,"guest cannot forge validation results");
        assert.ok(stages>=10);assert.equal(gpu.hostErrors.length,0);
    }
    console.log("PASS asynchronous program link: both transports, stage checks/scopes, atomic install/defaults, failed relink, snapshots, cancellation, stale/forged replies and exhaustion");
})().catch(error=>{console.error(error);process.exitCode=1;});
