// @ts-check
import { h,replace,format_size } from "./dom.js";
/** @param {import("../ios_install.js").IOSInstallController} controller @param {string} name */
export function show_ios_install(controller,name)
{
    const previous=/** @type {HTMLElement} */(document.activeElement);
    const picker=/** @type {HTMLInputElement} */(h("input#ios_ipa_file",{type:"file",accept:".ipa,application/octet-stream",onchange:()=>{
        if(picker.files?.[0])controller.choose(picker.files[0]);
    }}));
    const status=h("p#ios_ipa_status",{role:"status","aria-live":"polite"});
    const report=h("div#ios_ipa_metadata");
    const progress=/** @type {HTMLProgressElement} */(h("progress#ios_ipa_progress",{max:100,hidden:true}));
    const error=h("p.error#ios_ipa_error",{role:"alert"});
    const detail=h("pre#ios_ipa_details");
    const downgrade=/** @type {HTMLInputElement} */(h("input#ios_ipa_downgrade",{type:"checkbox",onchange:()=>render()}));
    const downgrade_row=h("label",{hidden:true},downgrade," Allow installing this older version");
    const install=/** @type {HTMLButtonElement} */(h("button.primary#ios_ipa_install",{type:"button",onclick:()=>controller.install()},"Install"));
    const resume=/** @type {HTMLButtonElement} */(h("button.primary#ios_ipa_resume",{type:"button",hidden:true,onclick:()=>controller.resume()},"Continue installation"));
    const cancel=/** @type {HTMLButtonElement} */(h("button#ios_ipa_cancel",{type:"button",hidden:true,onclick:()=>controller.cancel()},"Cancel installation"));
    const close=()=>{controller.removeEventListener("change",render);element.close();element.remove();previous?.focus();};
    const element=/** @type {HTMLDialogElement} */(h("dialog.dialog.ios-install-dialog",{id:"ios_ipa_dialog",ondragover:e=>{e.preventDefault();},ondrop:e=>{
        e.preventDefault();if(!controller.active()&&e.dataTransfer?.files?.[0])controller.choose(e.dataTransfer.files[0]);
    }},h("h2",null,"Install IPA"),h("div.dialog-body",null,
        h("p",null,"Install a local, unencrypted ARMv7 application compatible with iOS 6.1.3 on ",h("strong",null,name),"."),
        h("label",null,"Choose or drop an IPA",picker),report,status,progress,error,downgrade_row,
        h("details",null,h("summary",null,"Technical details"),detail)),
        h("div.dialog-buttons",null,cancel,resume,h("button",{type:"button",onclick:close},"Close"),install)));
    const phases={choose:"Choose an IPA to inspect it.",checking:"Checking IPA…",ready:"Ready to install.",preparing:"Preparing application…",
        transferring:"Transferring IPA…",staged:"The IPA is staged on the iPhone.",committing:"Committing installation…",
        installing:"Installing through iOS…",verifying:"Verifying the installed application…",installed:"Installed. Return to the Home screen and tap the application icon.",
        failed:"Installation failed.",cancelled:"Installation cancelled.",interrupted:"The previous installation was interrupted.",recoverable:"Checking the previous installation result."};
    const older=(a,b)=>{const x=String(a).split(/[.-]/).map(Number),y=String(b).split(/[.-]/).map(Number);for(let i=0;i<Math.max(x.length,y.length);i++){if((x[i]||0)!==(y[i]||0))return(x[i]||0)<(y[i]||0);}return false;};
    let shown=null;
    const render=()=>{
        const s=controller.state,c=s.capability,r=s.report;
        picker.disabled=controller.active();
        let text=phases[s.phase]||s.phase;
        if(s.phase==="ready"||s.phase==="choose"){
            if(c.supported===false)text=c.error;
            else if(!c.available)text=c.error||"Waiting for the native iPhone installer. You can check an IPA while the iPhone starts.";
            else if(!c.running)text="Resume the iPhone before installing.";
        }
        if(s.phase==="transferring")text+=" "+format_size(s.offset||0)+" / "+format_size(s.total||0);
        status.textContent=text;error.textContent=s.error||"";
        if(r!==shown){shown=r;downgrade.checked=false;replace(report,r?h("dl.ios-ipa-info",null,
            ...[["Application",r.name],["Bundle ID",r.bundle_id],["Version",r.version],["Minimum iOS",r.minimum_ios],["Architecture",r.architecture],["IPA size",format_size(r.size)]].flatMap(([k,v])=>[h("dt",null,k),h("dd",null,v)])):null);}
        const update=!!s.existing?.installed,down=update&&older(r?.version,s.existing.version);
        downgrade_row.hidden=!down;
        install.textContent=update?"Update":"Install";install.hidden=s.phase!=="ready";
        install.disabled=!c.available||!c.running||!s.existing_checked||down&&!downgrade.checked;
        if(update&&s.phase==="ready")status.textContent+=" Existing version: "+(s.existing.version||"unknown")+". Application data will be kept.";
        cancel.hidden=!controller.cancellable();
        resume.hidden=!["staged","recoverable"].includes(s.phase)||!c.available;
        detail.textContent=s.error||JSON.stringify({phase:s.phase,status:c.status||"",install_id:s.install_id||c.install_id||null},null,2);
        progress.hidden=!controller.active();
        if(s.phase==="transferring"&&s.total)progress.value=100*(s.offset||0)/s.total;
        else if(s.progress?.total)progress.value=100*s.progress.done/s.progress.total;
        else progress.removeAttribute("value");
    };
    element.addEventListener("cancel",e=>{e.preventDefault();close();});controller.addEventListener("change",render);
    render();document.body.append(element);element.showModal();picker.focus();
}
