// Local IPA processing. No IPA, firmware, entitlement or key is uploaded.
import { inspect_ipa } from "../ios/ipa.js";
import { prepare_ipa } from "../ios/ipa_prepare.js";
const reader=file=>async(at,size)=>new Uint8Array(await file.slice(at,at+size).arrayBuffer());
globalThis.onmessage=async({data})=>{
    let access,directory;
    const progress=(stage,done,total)=>globalThis.postMessage({progress:{stage,done,total}});
    try{
        if(data.op==="inspect"){
            const result=await inspect_ipa(reader(data.file),data.file.size,progress);
            globalThis.postMessage({result:result.report});return;
        }
        if(data.op!=="prepare" || !/^[a-zA-Z0-9-]+\.ipa$/.test(data.name))throw new Error("Invalid IPA preparation request");
        const space=await navigator.storage.estimate();
        if(space.quota && space.quota-(space.usage||0)<data.file.size+(64<<20))throw new Error("The browser has insufficient free space to prepare this IPA");
        directory=await navigator.storage.getDirectory();
        for(const name of ["v86","ipa"])directory=await directory.getDirectoryHandle(name,{create:true});
        const handle=await directory.getFileHandle(data.name,{create:true});access=await handle.createSyncAccessHandle();access.truncate(0);
        let at=0;
        const manifest=await prepare_ipa(reader(data.file),data.file.size,bytes=>{
            if(access.write(bytes,{at})!==bytes.length)throw new Error("Incomplete write while preparing the IPA");at+=bytes.length;
        },{graphics:data.graphics,progress});
        access.flush();access.close();access=null;
        globalThis.postMessage({result:{manifest,file:await handle.getFile()}});
    }catch(error){globalThis.postMessage({error:error?.message||String(error)});}
    finally{access?.close();}
};
