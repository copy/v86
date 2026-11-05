#!/usr/bin/env node
// Isolated browser; disk images are served read-only with bounded range reads.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../../",import.meta.url));
const game=process.argv[2]||"3dmarklegacy";
if(!["3dmarklegacy","maplestory","warcraft3","gtasa"].includes(game))throw new Error("Unknown game");
const out=path.resolve(process.env.D3D_GAME_OUT||root+"build/d3d-review/game-"+game);
fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),"d3d-game-"));
let browser,timer,finished=false;
const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,"http://localhost");
    if(req.method==="POST" && ["/__test_file","/__test_result","/__test_progress"].includes(url.pathname)) {
        const chunks=[];for await(const chunk of req)chunks.push(chunk);const data=Buffer.concat(chunks);
        if(url.pathname==="/__test_file")fs.writeFileSync(path.join(out,path.basename(url.searchParams.get("name")||"artifact")),data);
        else if(url.pathname==="/__test_progress")console.log(data.toString());
        else {
            fs.writeFileSync(out+"/result.json",data);console.log(data.toString());
            res.end("OK");finish(JSON.parse(data).status==="PASS"?0:1);return;
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
        res.end(fs.readFileSync(file,"utf8")+reporter);return;
    }
    res.setHeader("Content-Length",end-start+1);
    if(req.method==="HEAD"){res.end();return;}
    const stream=fs.createReadStream(file,{start,end});stream.on("error",()=>res.destroy());stream.pipe(res);
});
function finish(code){
    if(finished)return;finished=true;clearTimeout(timer);
    if(browser){browser.once("exit",()=>fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100}));browser.kill();}
    else fs.rmSync(profile,{recursive:true,force:true});
    server.closeAllConnections();server.close();process.exitCode=code;
}
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const query=new URLSearchParams({game,worker:process.env.D3D_GAME_WORKER||"0",boot_ms:process.env.D3D_GAME_BOOT_MS||"150000",manual:process.env.D3D_GAME_MANUAL||"0"});
const url=`http://127.0.0.1:${server.address().port}/tests/glbridge/d3d_guest_trace_capture.html?${query}`;
browser=spawn(process.env.GL_CHROME||"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",[
    "--headless=new","--enable-unsafe-webgpu","--remote-debugging-port=0","--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-renderer-backgrounding","--disable-background-timer-throttling",
    ...(process.env.GL_SWIFTSHADER==="1"?["--use-webgpu-adapter=swiftshader","--use-gpu-in-tests"]:[]),`--user-data-dir=${profile}`,url,
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
        const page=pages.find(page=>page.type==="page"&&page.url.includes("d3d_guest_trace_capture"));
        if(page){fs.writeFileSync(out+"/control.json",JSON.stringify({port,webSocketDebuggerUrl:page.webSocketDebuggerUrl}));break;}
    }
    await new Promise(resolve=>setTimeout(resolve,100));
}
