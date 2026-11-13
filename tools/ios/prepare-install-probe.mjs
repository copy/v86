// Build a disposable native-install test disk from the owner's prepared
// graphics/offline system volume. Never edits the input or a running phone.
import fs from "node:fs";
import path from "node:path";
import { open_volume } from "./hfs_edit.mjs";
import { install_system_file, install_system_directory, rewrite_daemon } from "../../src/ios/system_volume.js";
import { graphics_kernel, link_guest_gles, patch_guest_code, GUEST_GL_LIBRARY, DISPLAY_DAEMONS, SYSTEM_GL_APPLICATIONS, LOCKDOWN_DAEMON } from "../../src/ios/guest_load.js";
import { macho_parse } from "../../src/apple/macho.js";
import { systembag, offline_setup_file } from "../../src/ios/provision.js";
import { write_hfsx_data } from "../../src/ios/hfsx_data.js";
import { write_bootstrap_pages } from "../../src/ios/nand_layout.js";
import { data_capacity, write_volumes } from "../../src/ios/nand_volumes.js";
import { NAND_BYTES, NAND_SLOT, nand_offset } from "../../src/apple/nand_geometry.js";
import { cdhashes, SYSTEM_GL_LIBRARY } from "../../src/ios/guest_load.js";
import { INSTALL_DAEMON, INSTALL_POLICY, link_install_policy } from "../../src/ios/install_components.js";
import { inspect_ipa } from "../../src/ios/ipa.js";
import { initial_install_state, install_allowlist } from "../../src/ios/install_trust.js";
import { write_nand_boot } from "../../src/ios/nand_boot.js";
import { zip_read } from "../../src/android/zip.js";
import { sign_macho, macho_entitlements } from "../../src/ios/codesign.js";

const [source, kernel, guest, library, output, ...extra] = process.argv.slice(2);
const serve = extra.includes("--serve"), policyEnabled = extra.includes("--policy"), at = extra.indexOf("--ipa"), ipaPath = at < 0 ? null : extra[at + 1];
const misProbe = extra.includes("--mis-test");
if(at >= 0) extra.splice(at, 2);
if(!output || at >= 0 && !ipaPath || misProbe && serve || extra.some(x => !["--policy", "--serve", "--mis-test"].includes(x)))
    throw new Error("usage: prepare-install-probe.mjs prepared-system.hfs stock-kernel guest-build libv86gles.dylib new-directory [--policy] [--ipa app.ipa]");
fs.mkdirSync(output); // Refuse to overwrite any previous run.
const systemPath = path.join(output, "system.hfs"), dataPath = path.join(output, "data.hfs");
fs.copyFileSync(source, systemPath, fs.constants.COPYFILE_FICLONE);
const systemFD = fs.openSync(systemPath, "r+"), dataFD = fs.openSync(dataPath, "wx+"), nandFD = fs.openSync(path.join(output, "flash.img"), "wx");
const reader = fd => (at, length) => {
    const b = new Uint8Array(length);
    if(fs.readSync(fd, b, 0, length, at) !== length) throw new Error("Short local volume read");
    return b;
};
try
{
    const volume = await open_volume(systemFD), agent = fs.readFileSync(path.join(guest, "v86-app-agent"));
    await install_system_file(volume, (at, b) => fs.writeSync(systemFD, b, 0, b.length, at), "/usr/lib/v86-app-agent", agent, 0o755);
    const daemon = new TextEncoder().encode(`<?xml version="1.0"?><plist version="1.0"><dict>
<key>Label</key><string>org.v86.app-agent</string><key>RunAtLoad</key><true/>
<key>ProgramArguments</key><array><string>/usr/lib/v86-app-agent</string><string>--install-test</string><string>/private/var/mobile/Media/v86-input/test.ipa</string></array>
<key>StandardOutPath</key><string>/dev/console</string><key>StandardErrorPath</key><string>/dev/console</string></dict></plist>`);
    const write = (at, b) => fs.writeSync(systemFD, b, 0, b.length, at);
    // System jobs are loaded from xpcd_cache in this firmware; local jobs
    // belong in the separately scanned Library/LaunchDaemons directory.
    if(!await volume.lookup("/Library/LaunchDaemons")) await install_system_directory(volume, write, "/Library/LaunchDaemons");
    await install_system_file(volume, write, "/Library/LaunchDaemons/org.v86.app-agent.plist", daemon);
    const lib = fs.readFileSync(library), executables = [];
    const compress = async bytes => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
    if(!await volume.lookup(SYSTEM_GL_LIBRARY))
        await install_system_file(volume, write, SYSTEM_GL_LIBRARY, lib, 0o755);
    for(const p of [...DISPLAY_DAEMONS, ...SYSTEM_GL_APPLICATIONS])
    {
        // Match production imports: sandboxed display processes load the
        // adapter from the read-only system volume, not the mobile data volume.
        const bytes = await rewrite_daemon(volume,write,p,compress,input=>{
            const parsed=macho_parse(input);
            if(parsed.dylibs.includes(SYSTEM_GL_LIBRARY))return input;
            if(!parsed.dylibs.includes(GUEST_GL_LIBRARY))return link_guest_gles(input,SYSTEM_GL_LIBRARY);
            const v=new DataView(input.buffer,input.byteOffset,input.byteLength);
            for(let at=28,i=0;i<v.getUint32(16,true);i++,at+=v.getUint32(at+4,true)){
                if(![12,0x80000018].includes(v.getUint32(at,true)))continue;
                const start=at+v.getUint32(at+8,true),end=at+v.getUint32(at+4,true),previous=input.subarray(start,end);
                if(new TextDecoder().decode(previous).replace(/\0.*$/,"")!==GUEST_GL_LIBRARY)continue;
                const replacement=new Uint8Array(previous.length);replacement.set(new TextEncoder().encode(SYSTEM_GL_LIBRARY));
                return patch_guest_code(input,start,previous,replacement);
            }throw Error("Missing legacy display adapter command");
        });
        executables.push(bytes);
    }
    const bootstrap = fs.readFileSync(path.join(guest, "libv86appbootstrap.dylib"));
    await install_system_file(volume, write, "/usr/lib/libv86appbootstrap.dylib", bootstrap, 0o755);
    const lockdown = await rewrite_daemon(volume, write, LOCKDOWN_DAEMON, compress,
        bytes => link_guest_gles(bytes, "/usr/lib/libv86appbootstrap.dylib"));
    const ipa = fs.readFileSync(ipaPath || path.join(guest, "V86InstallTest.ipa"));
    const inspected = await inspect_ipa((at, n) => ipa.subarray(at, at + n), ipa.length);
    const trusted = [agent, bootstrap, lockdown, ...serve ? [] : inspected.code.map(c => c.bytes)];
    if(policyEnabled)
    {
        const policy = fs.readFileSync(path.join(guest, "libv86install.dylib"));
        await install_system_file(volume, write, INSTALL_POLICY, policy, 0o755);
        trusted.push(policy, await rewrite_daemon(volume, write, INSTALL_DAEMON, compress, link_install_policy));
    }
    const preparedKernel = graphics_kernel(fs.readFileSync(kernel), executables, lib, null, trusted);
    const install = serve ? initial_install_state(preparedKernel) : null;
    fs.writeFileSync(path.join(output, "kernel.macho"), preparedKernel, { flag: "wx" });
    const capacity = data_capacity(volume.total_blocks * volume.block_size);
    const probeFiles = [];
    if(misProbe)
    {
        probeFiles.push({ path: "/v86/install-mis-probe", bytes: new Uint8Array(1), dir_mode: 0o755, mode: 0o600 });
        for(const e of inspected.entries.filter(e => e.name.startsWith(inspected.root + "/") && !e.name.endsWith("/"))
            .sort((a, b) => a.name.split("/").length - b.name.split("/").length))
            probeFiles.push({ path: "/mobile/Media/v86-input/Probe.app/" + e.name.slice(inspected.root.length + 1),
                bytes: await zip_read((at, n) => ipa.subarray(at, at + n), e), dir_mode: 0o755, mode: 0o755, uid: 501, gid: 501 });
        const read=(at,n)=>ipa.subarray(at,at+n);
        const info=await zip_read(read,inspected.entries.find(e=>e.name===inspected.root+"/Info.plist"));
        const seal=inspected.entries.find(e=>e.name===inspected.root+"/_CodeSignature/CodeResources");
        const resources=seal?await zip_read(read,seal):null;
        for(const [name,withInfo,withResources] of [["minimal",false,false],["no-info",false,true],["no-resources",true,false]])
        {
            const bytes=sign_macho(inspected.main.bytes,{identifier:inspected.report.bundle_id,
                entitlements:macho_entitlements(inspected.main.bytes),info:withInfo?info:null,resources:withResources?resources:null});
            const root="/mobile/Media/v86-input/Probe-"+name+".app/";
            probeFiles.push({path:root+"Info.plist",bytes:info,dir_mode:0o755,mode:0o644,uid:501,gid:501},
                {path:root+"V86Test",bytes,dir_mode:0o755,mode:0o755,uid:501,gid:501});
            if(resources)probeFiles.push({path:root+"_CodeSignature/CodeResources",bytes:resources,dir_mode:0o755,mode:0o644,uid:501,gid:501});
        }
    }
    fs.ftruncateSync(dataFD, capacity);
    await write_hfsx_data(volume, capacity, (at, b) => fs.writeSync(dataFD, b, 0, b.length, at), [
        { path: "/keybags/systembag.kb", bytes: systembag(), dir_mode: 0o700, mode: 0o600 },
        ...serve ? [{ path: "/v86/install-token", bytes: Buffer.from(install.token, "hex"), dir_mode: 0o755, mode: 0o600 },
            { path: "/v86/install-diagnostics", bytes: new Uint8Array(1), dir_mode: 0o755, mode: 0o600 }] :
            [{ path: "/v86/install-probe", bytes: new Uint8Array(1), dir_mode: 0o755, mode: 0o600 }],
        { path: "/v86/libv86gles.dylib", bytes: lib, dir_mode: 0o755, mode: 0o755 },
        { path: "/mobile/Media/v86-input/test.ipa", bytes: ipa, dir_mode: 0o700, mode: 0o600, uid: 501, gid: 501 },
        ...probeFiles,
        { path: "/mobile/Library/Logs/.v86", bytes: new Uint8Array(0), dir_mode: 0o755, mode: 0o644, uid: 501, gid: 501 },
        { path: "/mobile/Library/Logs/MobileInstallation/.v86", bytes: new Uint8Array(0), dir_mode: 0o755, mode: 0o644, uid: 501, gid: 501 },
        ...(() => {
            const hashes = serve ? [] : inspected.code.flatMap(c => cdhashes(c.bytes)), bytes = new Uint8Array(12 + 20 * hashes.length), v = new DataView(bytes.buffer);
            bytes.set(new TextEncoder().encode("V86T")); v.setUint32(4, 1, true); v.setUint32(8, hashes.length, true);
            hashes.forEach((h, i) => bytes.set(h, 12 + i * 20));
            return [{ path: "/v86/install-trust.bin", bytes, dir_mode: 0o755, mode: 0o644 }];
        })(),
        offline_setup_file(),
    ]);
    fs.ftruncateSync(nandFD, NAND_BYTES);
    const slot = new Uint8Array(NAND_SLOT), put = (bus, ce, row, raw) => {
        slot.fill(0);
        for(let i = 0; i < raw.length; i++) slot[i] = ~raw[i];
        if(fs.writeSync(nandFD, slot, 0, slot.length, nand_offset(bus, ce, row)) !== slot.length) throw new Error("Short NAND write");
    };
    write_bootstrap_pages(put);
    await write_volumes(put, reader(systemFD), reader(dataFD), () => {}, true);
    if(serve) write_nand_boot(put, preparedKernel, fs.readFileSync(path.join(path.dirname(kernel), "DeviceTree.n90ap.bin")), new Uint8Array(0), lib, install);
    console.log("Prepared disposable IPA installation probe in " + output);
}
finally { fs.closeSync(systemFD); fs.closeSync(dataFD); fs.closeSync(nandFD); }
