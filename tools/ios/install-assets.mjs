// Ship only v86's own ARMv7 code; no SDK/framework/firmware bytes.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { check_install_components } from "../../src/ios/install_components.js";
const release=process.argv[2]==="--refresh";
if(process.argv.length>(release?3:2))throw Error("usage: install-assets.mjs [--refresh]");
const root=path.resolve(import.meta.dirname,"../.."),directory=path.join(root,"bios/ios-install"),build=path.join(root,"build/ios-install-fixtures");
const names={agent:"v86-app-agent",bootstrap:"libv86appbootstrap.dylib",policy:"libv86install.dylib"};
const sources=["ios-api.h","app-native.h","app-code-hash.h","app-agent.c","app-agent.entitlements.plist","app-service.c","app-bootstrap.c","install-policy.c","build-apps.sh"];
const hash=b=>createHash("sha256").update(b).digest("hex");
const input=Object.fromEntries(sources.map(n=>["tools/ios/guest/"+n,hash(fs.readFileSync(path.join(root,"tools/ios/guest",n)))]));
if(release){
    const components=Object.fromEntries(Object.entries(names).map(([key,name])=>[key,new Uint8Array(fs.readFileSync(path.join(build,name)))]));
    check_install_components(components);fs.mkdirSync(directory,{recursive:true});
    for(const [key,name] of Object.entries(names))fs.writeFileSync(path.join(directory,name),components[key]);
    fs.writeFileSync(path.join(directory,"manifest.json"),JSON.stringify({format:"v86-ios-install-assets",version:1,build:"10B329",protocol:1,
        sources:input,files:Object.fromEntries(Object.entries(names).map(([key,name])=>[name,hash(components[key])]))},null,2)+"\n");
    console.log("Recorded original v86 installation helpers and source provenance");
}else{
    const manifest=JSON.parse(fs.readFileSync(path.join(directory,"manifest.json"),"utf8"));
    if(manifest.format!=="v86-ios-install-assets"||manifest.version!==1||manifest.build!=="10B329"||manifest.protocol!==1)throw Error("Unrecognized iPhone helper manifest");
    for(const [name,digest] of Object.entries(input))if(manifest.sources[name]!==digest)throw Error("iPhone helper sources changed: rebuild with make ios-install-assets-refresh on macOS");
    const components=Object.fromEntries(Object.entries(names).map(([key,name])=>[key,new Uint8Array(fs.readFileSync(path.join(directory,name)))]));
    check_install_components(components);fs.mkdirSync(build,{recursive:true});
    for(const [key,name] of Object.entries(names)){
        if(hash(components[key])!==manifest.files[name])throw Error("Corrupt iPhone helper asset: "+name);
        fs.writeFileSync(path.join(build,name),components[key]);
    }
    console.log("Verified and copied iPhone installation helper assets");
}
