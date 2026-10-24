// What v64 adds to an emulator image's ramdisk (an Android Emulator system
// image's, docs/aarch32-plan.md R7.1): a second cpio archive after the
// image's own, which the kernel unpacks over it (a later file of the same
// name replaces the earlier one): the device's init file (init.ranchu.rc)
// with the device model's lines after its own, and the device model's
// files. The image's ramdisk is gzip-compressed; the archive added is not.

import { concat, bytes_of, latin1 } from "./bytes.js";
import { cpio_files, cpio_newc } from "./cpio.js";

/**
 * A gzip stream's data (a partition's: the zeros after the stream, which
 * DecompressionStream calls junk, end it)
 * @param {!Uint8Array} bytes gzip
 * @return {!Promise<!Uint8Array>}
 */
async function gunzip(bytes)
{
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    const chunks = [];
    try
    {
        for(;;)
        {
            const { done, value } = await reader.read();
            if(done) break;
            chunks.push(value);
        }
    }
    catch(e)
    {
        if(!chunks.length) throw e;
    }
    return concat(chunks);
}

/**
 * The ramdisk with the device model's additions (`device.init`: `{ rc:
 * string, files: Object<string, string> }`, the rc lines for `rc_file`),
 * or the ramdisk itself when it has none
 * @param {!Uint8Array} ramdisk the image's (gzip-compressed cpio)
 * @param {!Object} device src/android/devices.js's
 * @return {!Promise<!Uint8Array>}
 */
export async function ramdisk_overlay(ramdisk, device)
{
    const init = device.init;
    if(!init) return ramdisk;
    const files = cpio_files(await gunzip(ramdisk));
    const rc_file = init.rc_file || "init.ranchu.rc";
    const rc = files.get(rc_file);
    if(!rc) throw new Error(`android: the ramdisk has no ${rc_file}`);
    const added = [[rc_file, bytes_of(latin1(rc) + "\n" + init.rc)],
        ...Object.entries(init.files || {}).map(([name, text]) => [name, bytes_of(text)])];
    // (the image's archive ends where its gzip stream does; the next one starts 4-aligned)
    const pad = new Uint8Array((4 - ramdisk.length % 4) % 4);
    return concat([ramdisk, pad, cpio_newc(added)]);
}
