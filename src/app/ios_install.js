// One controller per running iPhone. The UI uses only V86's public API.
import { query_append } from "./emulator_bridge.js";
import { SHA256 } from "../image/sha256.js";
const busy=new Set(["checking","preparing","transferring","staged","installing","verifying","committing"]);
async function remove_scratch(name){
    if(!name)return;
    for(let attempt=0;attempt<10;attempt++){
        try{let d=await navigator.storage.getDirectory();for(const n of ["v86","ipa"])d=await d.getDirectoryHandle(n);await d.removeEntry(name);return;}
        catch(error){if(error.name==="NotFoundError")return;if(attempt===9)return;await new Promise(ok=>setTimeout(ok,100));}
    }
}
export class IOSInstallController extends EventTarget {
    constructor(emulator,{graphics=true,worker_factory,storage_key=/** @type {string} */ (crypto.randomUUID())}={}){
        super();this.emulator=emulator;this.graphics=graphics;this.worker_factory=worker_factory||(()=>new Worker("build/ios-install-worker.js"+query_append(),{type:"module"}));
        this.state={phase:"choose",capability:{available:false,phase:"waiting"}};this.file=null;this.worker=null;this.cancelled=false;
        this.prefix=new SHA256().update(new TextEncoder().encode(storage_key)).hex().slice(0,24)+"-";
        // The console holds this VM's exclusive lock. Other VMs use a different prefix.
        this.cleanup=(async()=>{try{let d=await navigator.storage.getDirectory();for(const n of ["v86","ipa"])d=await d.getDirectoryHandle(n);
            for await(const name of d.keys())if(name.startsWith(this.prefix))await d.removeEntry(name).catch(()=>{});
        }catch(error){if(error.name!=="NotFoundError")throw error;}})();
        this.cleanup.catch(()=>{});
        this.listener=event=>{
            this.state.capability={...this.state.capability,...event};
            // A successful native callback still needs host persistence.
            if(["transferring","staged","installing","verifying"].includes(event.phase))this.update({...event,phase:event.phase});
            else if(!this.uploading && !["checking","ready","committing","installed"].includes(this.state.phase) &&
                ["installed","failed","interrupted"].includes(event.phase))this.update({...event,phase:event.phase==="installed"?"recoverable":event.phase});
            else this.update({});
        };
        emulator.add_listener("ios-install-progress",this.listener);
        this.poll=setInterval(()=>this.refresh(),3000);this.refresh();
    }
    update(value){Object.assign(this.state,value);this.dispatchEvent(new Event("change"));}
    active(){return busy.has(this.state.phase);}
    cancellable(){return ["checking","preparing","transferring","staged"].includes(this.state.phase)||
        this.state.phase==="interrupted"&&["transferring","staged","interrupted"].includes(this.state.capability.phase);}
    async refresh(){
        if(this.disposed || this.refreshing)return;
        this.refreshing=true;
        try{
            const capability=await this.emulator.ios_install_status();this.state.capability=capability;
            if(this.state.phase==="ready" && this.state.report && capability.available && !this.state.existing_checked){
                const bundle=this.state.report.bundle_id,existing=await this.emulator.ios_install_lookup(bundle);
                if(this.state.phase==="ready" && this.state.report?.bundle_id===bundle){this.state.existing=existing;this.state.existing_checked=true;}
            }
            if(["choose","interrupted","recoverable"].includes(this.state.phase) && capability.install_id && ["transferring","staged","installing","verifying","interrupted","installed","failed"].includes(capability.phase))
                this.update({...capability,phase:capability.phase==="installed"?"recoverable":capability.phase==="transferring"?"interrupted":capability.phase});
            else this.update({});
        }catch(error){this.state.capability={available:false,error:error.message,phase:"disconnected"};this.update({});}
        finally{this.refreshing=false;}
    }
    process(message){
        return new Promise((resolve,reject)=>{
            const worker=this.worker=this.worker_factory();
            this.reject_worker=reject;
            worker.onmessage=({data})=>{
                if(data.progress){this.update({progress:data.progress});return;}
                worker.terminate();if(this.worker===worker)this.worker=null;this.reject_worker=null;
                data.error?reject(new Error(data.error)):resolve(data.result);
            };
            worker.onerror=error=>{worker.terminate();this.worker=null;this.reject_worker=null;reject(new Error(error.message||"The IPA preparation worker could not start"));};
            worker.postMessage(message);
        });
    }
    async choose(file){
        if(this.active())return;
        if(this.state.capability.install_id&&["transferring","staged","interrupted"].includes(this.state.capability.phase)){
            this.update({error:"Cancel or continue the previous installation before choosing another IPA"});return;
        }
        this.file=file;this.cancelled=false;this.update({phase:"checking",error:"",report:null,existing:null,existing_checked:false,progress:null});
        try{
            const report=await this.process({op:"inspect",file});if(this.cancelled)return;
            let existing=null;if(this.state.capability.available)existing=await this.emulator.ios_install_lookup(report.bundle_id);
            if(this.cancelled)return;
            this.update({phase:"ready",report,existing,existing_checked:!!existing,progress:null});
        }catch(error){if(!this.cancelled)this.update({phase:"failed",error:error.message});}
    }
    async install(){
        if(this.state.phase!=="ready" || !this.file || !this.state.capability.available || !this.state.existing_checked)return;
        if(!this.emulator.is_running()){this.update({error:"Resume the iPhone before installing this IPA"});return;}
        const scratch=this.prefix+crypto.randomUUID()+".ipa";this.scratch=scratch;this.cancelled=false;
        this.uploading=true;this.update({phase:"preparing",error:"",progress:null});
        try{
            await this.cleanup;if(this.cancelled){this.update({phase:"cancelled"});return;}
            const prepared=await this.process({op:"prepare",file:this.file,name:scratch,graphics:this.graphics});if(this.cancelled)return;
            const task=await this.emulator.ios_install_begin(prepared.manifest);this.state.install_id=task.install_id;
            this.update({phase:"transferring",total:prepared.file.size,offset:0});
            for(let at=0;at<prepared.file.size;at+=65536){
                if(this.cancelled){await this.emulator.ios_install_cancel(task.install_id);this.update({phase:"cancelled"});return;}
                const bytes=new Uint8Array(await prepared.file.slice(at,at+65536).arrayBuffer());
                await this.emulator.ios_install_write(task.install_id,at,bytes);this.update({offset:at+bytes.length});
            }
            if(this.cancelled){await this.emulator.ios_install_cancel(task.install_id);this.update({phase:"cancelled"});return;}
            await this.emulator.ios_install_stage(task.install_id);
            if(this.cancelled){await this.emulator.ios_install_cancel(task.install_id);this.update({phase:"cancelled"});return;}
            this.update({phase:"committing",progress:null});
            const result=await this.emulator.ios_install_commit(task.install_id);
            if(!result.installed)throw new Error("The native installer did not verify this application");
            this.update({phase:"installed",error:"",installed:true});
        }catch(error){
            if(this.state.install_id && ["transferring","staged"].includes(this.state.capability.phase))
                await this.emulator.ios_install_cancel(this.state.install_id).catch(()=>{});
            if(!this.cancelled)this.update({phase:"failed",error:error.message});
        }finally{this.uploading=false;await remove_scratch(scratch);if(this.scratch===scratch)this.scratch=null;}
    }
    async resume(){
        const task=this.state.capability;
        if(!task.available || !task.install_id)return;
        this.update({phase:"committing",error:"",install_id:task.install_id});
        try{const result=await this.emulator.ios_install_commit(task.install_id);if(!result.installed)throw new Error("The application is not registered");this.update({phase:"installed",error:""});}
        catch(error){this.update({phase:"interrupted",error:error.message});}
    }
    async cancel(){
        if(!this.cancellable())return;
        const phase=this.state.phase;
        this.cancelled=true;
        if(this.worker){this.worker.terminate();this.worker=null;this.reject_worker?.(new Error("Cancelled"));this.reject_worker=null;this.update({phase:"cancelled"});await remove_scratch(this.scratch);}
        else if(phase==="checking" || phase==="preparing")this.update({phase:"cancelled"});
        else if(!this.uploading && this.state.install_id){
            try{await this.emulator.ios_install_cancel(this.state.install_id);this.update({phase:"cancelled"});}
            catch(error){this.update({phase:"interrupted",error:error.message});}
        }
        // Upload cancellation is processed after the current acknowledged block.
    }
    dispose(){this.disposed=true;this.cancelled=true;clearInterval(this.poll);this.emulator.remove_listener("ios-install-progress",this.listener);
        this.worker?.terminate();this.worker=null;this.reject_worker?.(new Error("The iPhone was powered off"));this.reject_worker=null;remove_scratch(this.scratch);}
}
