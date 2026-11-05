#!/usr/bin/env node
// Isolated browser; disk images are served read-only with bounded range reads.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../../",import.meta.url));
const game=process.argv[2]||"3dmarklegacy";
if(!["3dmarklegacy","3dmark03","3dmark05","3dmark06","maplestory","warcraft3","gtasa"].includes(game))throw new Error("Unknown game");
const out=path.resolve(process.env.D3D_GAME_OUT||root+"build/d3d-review/game-"+game);
fs.mkdirSync(out,{recursive:true});
fs.copyFileSync(root+"build/d3d-review/inputs.json",out+"/inputs.json");
const profile=fs.mkdtempSync(path.join(os.tmpdir(),"d3d-game-"));
let browser,timer,finished=false,control,sampling;
const browserErrors=[];
const monitorErrors=[];
const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,"http://localhost");
    if(url.pathname === "/favicon.ico") { res.writeHead(204).end(); return; }
    if(req.method==="POST" && ["/__test_file","/__test_result","/__test_progress"].includes(url.pathname)) {
        const chunks=[];for await(const chunk of req)chunks.push(chunk);const data=Buffer.concat(chunks);
        if(url.pathname==="/__test_file")fs.writeFileSync(path.join(out,path.basename(url.searchParams.get("name")||"artifact")),data);
        else if(url.pathname==="/__test_progress")console.log(data.toString());
        else {
            const result=JSON.parse(data);
            if(browserErrors.length){result.status="FAIL";result.browserErrors=browserErrors;}
            if(monitorErrors.length){result.status="FAIL";result.monitorErrors=monitorErrors;}
            fs.writeFileSync(out+"/result.json",JSON.stringify(result,null,2));console.log(JSON.stringify(result));
            res.end("OK");finish(result.status==="PASS"?0:1);return;
        }
        res.end("OK");return;
    }
    const file=path.resolve(root,"."+decodeURIComponent(url.pathname));
    if(!file.startsWith(root)){res.writeHead(403).end();return;}
    let stat;try{stat=fs.statSync(file);}catch{res.writeHead(404).end();return;}
    if(!stat.isFile()){res.writeHead(404).end();return;}
    res.setHeader("Cross-Origin-Opener-Policy","same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy","require-corp");
    res.setHeader("Cache-Control","no-store");
    res.setHeader("Accept-Ranges","bytes");
    res.setHeader("Content-Type",/\.(js|mjs)$/.test(file)?"text/javascript":file.endsWith(".wasm")?"application/wasm":file.endsWith(".html")?"text/html":"application/octet-stream");
    let start=0,end=stat.size-1;
    if(req.headers.range){
        const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if(!match){res.writeHead(416).end();return;}
        start=Number(match[1]);end=match[2]?Math.min(end,Number(match[2])):end;
        if(start>end||start>=stat.size){res.writeHead(416,{"Content-Range":"bytes */"+stat.size}).end();return;}
        res.statusCode=206;res.setHeader("Content-Range",`bytes ${start}-${end}/${stat.size}`);
    }
    if(file.endsWith(".html")){
        const reporter=`<script>new MutationObserver(function(){const text=document.querySelector('#result')?.textContent||'';if(/^(PASS|FAIL)\\b/.test(text)&&!window.reported){window.reported=true;fetch('/__test_result',{method:'POST',body:JSON.stringify({status:text.startsWith('PASS')?'PASS':'FAIL',details:text})});}}).observe(document.documentElement,{subtree:true,childList:true,characterData:true});</script>`;
        let html=fs.readFileSync(file,"utf8");
        if(process.env.D3D_GAME_ASSET_ROOT){
            const assetRoot=process.env.D3D_GAME_ASSET_ROOT.replace(/\/$/,"");
            if(!/^\/build\/[a-z0-9_/-]+$/i.test(assetRoot)) throw new Error("Invalid baseline asset root");
            html=html.replaceAll("../../build/",assetRoot+"/")
                .replaceAll('"/build/v86','"'+assetRoot+'/v86')
                .replaceAll('"/build/cpu-worker.js"','"'+assetRoot+'/cpu-worker.js"');
        }
        res.end(html+reporter);return;
    }
    res.setHeader("Content-Length",end-start+1);
    if(req.method==="HEAD"){res.end();return;}
    const stream=fs.createReadStream(file,{start,end});stream.on("error",()=>res.destroy());stream.pipe(res);
});
function finish(code){
    if(finished)return;finished=true;clearTimeout(timer);clearInterval(sampling);control?.close();
    fs.writeFileSync(out+"/runner-exit.json",JSON.stringify({code,browserErrors,monitorErrors,time:new Date().toISOString()},null,2));
    if(browser){browser.once("exit",()=>fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100}));browser.kill();}
    else fs.rmSync(profile,{recursive:true,force:true});
    server.closeAllConnections();server.close();process.exitCode=code;
}
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
// Match the site's normal CPU Worker configuration; main-thread diagnostics opt out explicitly.
const query=new URLSearchParams({game,worker:process.env.D3D_GAME_WORKER||"1",boot_ms:process.env.D3D_GAME_BOOT_MS||"150000",manual:process.env.D3D_GAME_MANUAL||"0",launcher:process.env.D3D_GAME_LAUNCHER||"",tools:process.env.D3D_GAME_TOOLS||"/build/d3d-review/tools.iso"});
const url=`http://127.0.0.1:${server.address().port}/tests/glbridge/d3d_guest_trace_capture.html?${query}`;
browser=spawn(process.env.GL_CHROME||"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",[
    "--headless=new","--enable-unsafe-webgpu","--remote-debugging-port=0","--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-renderer-backgrounding","--disable-background-timer-throttling",
    ...(process.env.GL_SWIFTSHADER==="1"?["--use-webgpu-adapter=swiftshader","--use-gpu-in-tests"]:[]),`--user-data-dir=${profile}`,"about:blank",
],{stdio:["ignore","ignore","pipe"]});
browser.stderr.on("data",data=>fs.appendFileSync(out+"/chrome.log",data));
browser.on("error",error=>{console.error(error);finish(1);});
process.on("exit",()=>browser?.kill("SIGKILL"));
for(const signal of ["SIGINT","SIGTERM"])process.once(signal,()=>finish(1));
timer=setTimeout(()=>{console.error("FAIL real game timeout: "+game);finish(1);},Number(process.env.D3D_GAME_TIMEOUT_MS||1200000));
console.log(JSON.stringify({game,out,url,gpu:process.env.GL_SWIFTSHADER==="1"?"SwiftShader":"hardware"}));
for(let i=0;i<100&&!finished;i++) {
    if(fs.existsSync(profile+"/DevToolsActivePort")) {
        const port=Number(fs.readFileSync(profile+"/DevToolsActivePort","utf8").split("\n")[0]);
        const pages=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page=pages.find(page=>page.type==="page");
        if(page){
            fs.writeFileSync(out+"/control.json",JSON.stringify({port,webSocketDebuggerUrl:page.webSocketDebuggerUrl}));
            control=new WebSocket(page.webSocketDebuggerUrl);
            await new Promise((resolve,reject)=>{control.onopen=resolve;control.onerror=reject;});
            let sequence=0;const pending=new Map();
            const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
                const id=++sequence,timeout=setTimeout(()=>{pending.delete(id);reject(new Error("CDP timeout: "+method));},30000);
                pending.set(id,{resolve,reject,timeout});control.send(JSON.stringify({id,method,params,sessionId}));
            });
            control.onmessage=({data})=>{
                const message=JSON.parse(data);
                if(message.id){const request=pending.get(message.id);if(request){clearTimeout(request.timeout);pending.delete(message.id);if(message.error)request.reject(new Error(JSON.stringify(message.error)));else request.resolve(message.result);}return;}
                if(message.method==="Target.attachedToTarget") {
                    const sessionId=message.params.sessionId;
                    (async()=>{
                        await call("Runtime.enable",{},sessionId);
                        await call("Runtime.runIfWaitingForDebugger",{},sessionId);
                    })().catch(error=>{
                        monitorErrors.push(String(error));
                        fs.appendFileSync(out+"/monitor-errors.log",String(error)+"\n");
                    });
                }
                if(message.method==="Runtime.exceptionThrown"||message.method==="Inspector.targetCrashed"||
                    message.method==="Runtime.consoleAPICalled"&&message.params.type==="error"||
                    message.method==="Log.entryAdded"&&message.params.entry.level==="error") browserErrors.push(message);
                if(["Runtime.consoleAPICalled","Runtime.exceptionThrown","Log.entryAdded","Inspector.targetCrashed"].includes(message.method))
                    fs.appendFileSync(out+"/browser-events.jsonl",JSON.stringify({time:new Date().toISOString(),...message})+"\n");
            };
            await call("Runtime.enable");await call("Log.enable");await call("Page.enable");
            await call("Target.setAutoAttach",{autoAttach:true,waitForDebuggerOnStart:true,flatten:true});
            fs.writeFileSync(out+"/environment.json",JSON.stringify({time:new Date().toISOString(),game,url,
                profile,worker:query.get("worker"),assets:process.env.D3D_GAME_ASSET_ROOT||"/build",
                tools:query.get("tools"),browser:await call("Browser.getVersion"),
                platform:process.platform,arch:process.arch},null,2));
            const assetRoot=path.join(root,(process.env.D3D_GAME_ASSET_ROOT||"/build").replace(/^\//,""));
            const assetHashes=Object.fromEntries(["libv86.js","v86.wasm","cpu-worker.js","v86-bochs-vga.js"].map(name=>{
                const bytes=fs.readFileSync(path.join(assetRoot,name));
                return [name,{bytes:bytes.length,sha256:crypto.createHash("sha256").update(bytes).digest("hex")}];
            }));
            fs.writeFileSync(out+"/core-assets.json",JSON.stringify(assetHashes,null,2));
            const manifest=path.join(root,(process.env.D3D_GAME_ASSET_ROOT||"/build").replace(/^\//,""),"glbridge/manifest.json");
            if(fs.existsSync(manifest))fs.copyFileSync(manifest,out+"/host-manifest.json");
            await call("Emulation.setDeviceMetricsOverride",{width:1280,height:1100,deviceScaleFactor:1,mobile:false});
            await call("Page.navigate",{url});
            if(process.env.D3D_GAME_MANUAL==="1"){
                let busy=false,index=0;
                sampling=setInterval(async()=>{
                    if(busy||finished)return;busy=true;
                    try{
                        const shot=await call("Runtime.evaluate",{expression:"document.querySelector('#screen_container canvas')?.toDataURL('image/png')",returnByValue:true});
                        if(shot.exceptionDetails) throw new Error(JSON.stringify(shot.exceptionDetails));
                        if(!shot.result?.value) return;
                        fs.writeFileSync(out+"/frame-"+String(++index).padStart(5,"0")+".png",Buffer.from(shot.result.value.split(",")[1],"base64"));
                        const state=await call("Runtime.evaluate",{expression:"JSON.stringify({log:document.querySelector('#log')?.textContent,result:document.querySelector('#result')?.textContent,stats:window.vm?.graphics_proxy?.bridge?.d3d9Executor?.stats,hostErrors:window.vm?.graphics_proxy?.bridge?.d3d9Executor?.hostErrors,gpuErrors:window.vm?.graphics_proxy?.bridge?.d3d9Executor?.gpuErrors?.errors})",returnByValue:true});
                        fs.appendFileSync(out+"/samples.jsonl",JSON.stringify({time:new Date().toISOString(),frame:index,state:state.result?.value})+"\n");
                    }catch(error){monitorErrors.push(String(error));fs.appendFileSync(out+"/monitor-errors.log",String(error)+"\n");}
                    finally{busy=false;}
                },5000);
            }
            break;
        }
    }
    await new Promise(resolve=>setTimeout(resolve,100));
}
