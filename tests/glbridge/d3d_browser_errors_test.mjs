import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../../",import.meta.url));
const html=fs.readFileSync(root+"tests/glbridge/d3d_remote_renderer.html","utf8");
const script=/<script id="d3d-browser-errors">([\s\S]*?)<\/script>/.exec(html);
assert(script && html.indexOf(script[0])<html.indexOf('<script src='),"Install observer before dependencies");
const handlers=new Map(),reported=[];
const context=vm.createContext({console:{error(...args){reported.push(args);}},addEventListener(name,handler){handlers.set(name,handler);}});
vm.runInContext(script[1],context);
context.console.error("visible error",new Error("retained stack"));
assert.equal(reported.length,1,"Original console must still receive errors");
assert.match(context.d3dBrowserErrors.consoleErrors[0],/visible error.*retained stack/s);
let suppressed=0;
handlers.get("error")({error:new Error("uncaught fault"),preventDefault(){suppressed++;}});
handlers.get("error")({target:{tagName:"SCRIPT",src:"/missing-script.js"},preventDefault(){suppressed++;}});
handlers.get("unhandledrejection")({reason:new Error("rejected work"),preventDefault(){suppressed++;}});
assert.equal(suppressed,0,"Browser error reporting must not be suppressed");
assert.equal(context.d3dBrowserErrors.pageErrors.length,2);
assert.match(context.d3dBrowserErrors.pageErrors[0],/uncaught fault/);
assert.match(context.d3dBrowserErrors.pageErrors[1],/missing-script/);
assert.match(context.d3dBrowserErrors.unhandledRejections[0],/rejected work/);
assert.equal(Object.values(context.d3dBrowserErrors).reduce((n,rows)=>n+rows.length,0),4);
assert(html.includes("checkBrowserErrors();send(4,seq);") && html.includes("checkBrowserErrors();socket.send"),"Errors gate both readiness and batch acknowledgements");
console.log("PASS browser error observer: original console retained, startup ordering, exception/resource/rejection capture, readiness/batch gates");
if(process.env.D3D_BROWSER_ERRORS_REAL === "1") {
    const {create_remote_renderer}=await import("../x64/gpu_remote_renderer.mjs");
    const {createHash}=await import("node:crypto");
    const out=path.resolve(process.env.D3D_BROWSER_ERRORS_OUT || root+"build/d3d-review/browser-error-observer-"+Date.now());
    assert(out.startsWith(root),"Real browser fixtures must be served from the workspace");
    fs.mkdirSync(out,{recursive:true});
    const template=html.replaceAll('src="../../src/','src="/src/');
    const cases=[
        ["console",'console.error("EXPECTED observer console mutation");'],
        ["exception",'setTimeout(()=>{throw new Error("EXPECTED observer exception mutation");},0);'],
        ["rejection",'Promise.reject(new Error("EXPECTED observer rejection mutation"));'],
        ["after-ready",'const original=WebSocket.prototype.send;WebSocket.prototype.send=function(data){if(data instanceof Uint8Array&&data.length===1&&data[0]===6)setTimeout(()=>console.error("EXPECTED observer after-ready mutation"),0);return original.call(this,data);};'],
    ];
    const results=[];
    for(const [label,code]of cases) {
        const file=out+"/"+label+".html";
        fs.writeFileSync(file,template.replace('</script>','</script>\n<script>'+code+'</script>'));
        let rejected=false,remote;
        const relative=file.slice(root.length);
        try {
            remote=await create_remote_renderer({page:"../../"+relative,timeout:20000});
            if(label==="after-ready") {
                await new Promise(resolve=>setTimeout(resolve,100));
                const loss=new Promise((resolve,reject)=>{
                    const timer=setTimeout(()=>reject(new Error("Missing late console failure")),5000);
                    remote.renderer.listen(message=>{
                        if(message.type==="lost") {clearTimeout(timer);resolve(message.reason);}
                        else if(message.type==="done") {clearTimeout(timer);reject(new Error("Late console error was acknowledged"));}
                    });
                });
                const carrier=Buffer.alloc(8);carrier.writeUInt32LE(1);carrier.writeUInt32LE(0xffffffff,4);
                remote.renderer.post({type:"submit",seq:1,bytes:carrier});
                throw new Error(await loss);
            }
            assert.fail("Browser error accepted: "+label);
        } catch(error) {
            assert.match(error.message,/Browser page errors:/,label+": must reject the actual error, not a timeout");
            assert.match(error.message,/EXPECTED observer/);rejected=true;
            results.push({label,status:"PASS expected browser error rejected",message:error.message});
        } finally {if(remote) await remote.close();}
        assert(rejected);console.log("PASS actual Chrome error rejection "+label);
    }
    fs.writeFileSync(out+"/results.json",JSON.stringify({results,sourceSha256:createHash("sha256").update(html).digest("hex")},null,2)+"\n");
}
