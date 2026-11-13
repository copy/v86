// Build a disposable native-install test disk from the owner's prepared
// graphics/offline system volume. Never edits the input or a running phone.
import fs from "node:fs";
import path from "node:path";
import { open_volume } from "./hfs_edit.mjs";
import { install_system_file } from "../../src/ios/system_volume.js";
import { graphics_kernel, DISPLAY_DAEMONS, SYSTEM_GL_APPLICATIONS, LOCKDOWN_DAEMON, SYSTEM_GL_LIBRARY } from "../../src/ios/guest_load.js";
import { macho_parse } from "../../src/apple/macho.js";
import { systembag, offline_setup_file } from "../../src/ios/provision.js";
import { write_hfsx_data } from "../../src/ios/hfsx_data.js";
import { write_bootstrap_pages } from "../../src/ios/nand_layout.js";
import { data_capacity, write_volumes } from "../../src/ios/nand_volumes.js";
import { NAND_BYTES, NAND_SLOT, nand_offset } from "../../src/apple/nand_geometry.js";

const [source, kernel, guest, library, output, ...extra] = process.argv.slice(2);
if(!output || extra.length) throw new Error("usage: prepare-install-probe.mjs prepared-system.hfs stock-kernel guest-build libv86gles.dylib new-directory");
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
<key>ProgramArguments</key><array><string>/usr/lib/v86-app-agent</string><string>--install-test</string><string>/private/var/v86/test.ipa</string></array>
<key>StandardOutPath</key><string>/dev/console</string><key>StandardErrorPath</key><string>/dev/console</string></dict></plist>`);
    await install_system_file(volume, (at, b) => fs.writeSync(systemFD, b, 0, b.length, at),
        "/System/Library/LaunchDaemons/org.v86.app-agent.plist", daemon);
    const lib = fs.readFileSync(library), executables = [];
    for(const p of [...DISPLAY_DAEMONS, ...SYSTEM_GL_APPLICATIONS])
    {
        const bytes = await volume.contents(await volume.lookup(p));
        if(macho_parse(bytes).dylibs.some(p => p.includes("libv86gles"))) executables.push(bytes);
    }
    const lockdown = await volume.contents(await volume.lookup(LOCKDOWN_DAEMON));
    fs.writeFileSync(path.join(output, "kernel.macho"), graphics_kernel(fs.readFileSync(kernel), executables, lib, lockdown,
        [agent, fs.readFileSync(path.join(guest, "Payload/V86InstallTest.app/V86Test"))]), { flag: "wx" });
    const capacity = data_capacity(volume.total_blocks * volume.block_size);
    fs.ftruncateSync(dataFD, capacity);
    await write_hfsx_data(volume, capacity, (at, b) => fs.writeSync(dataFD, b, 0, b.length, at), [
        { path: "/keybags/systembag.kb", bytes: systembag(), dir_mode: 0o700, mode: 0o600 },
        { path: "/v86/libv86gles.dylib", bytes: lib, dir_mode: 0o755, mode: 0o755 },
        { path: "/v86/test.ipa", bytes: fs.readFileSync(path.join(guest, "V86InstallTest.ipa")), dir_mode: 0o755, mode: 0o644 },
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
    console.log("Prepared disposable IPA installation probe in " + output);
}
finally { fs.closeSync(systemFD); fs.closeSync(dataFD); fs.closeSync(nandFD); }
