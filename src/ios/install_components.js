import { SHA256 } from "../image/sha256.js";
import { link_guest_gles, patch_guest_code, cdhashes } from "./guest_load.js";
import { macho_parse } from "../apple/macho.js";

export const INSTALL_DAEMON = "/usr/libexec/installd";
export const INSTALL_POLICY = "/usr/lib/libv86install.dylib";
export const INSTALL_AGENT = "/usr/lib/v86-app-agent";
export const INSTALL_BOOTSTRAP = "/usr/lib/libv86appbootstrap.dylib";

export function check_install_components(components)
{
    for(const [key, type, id] of [["agent", 2, null], ["policy", 6, INSTALL_POLICY], ["bootstrap", 6, INSTALL_BOOTSTRAP]])
    {
        const bytes = components?.[key];
        if(!(bytes instanceof Uint8Array) || bytes.length > (2 << 20)) throw new Error("Missing iPhone installation component: " + key);
        const image = macho_parse(bytes);
        if(image.is64 || image.cputype !== 12 || image.filetype !== type || id && image.id !== id)
            throw new Error("Incorrect iPhone installation component: " + key);
        cdhashes(bytes);
    }
    return components;
}

export function link_install_policy(original)
{
    if(new SHA256().update(original).hex() !== "d8deaeabb4d7335c3facc77e7b692150e8e6878d2d6b2427365dc07e3d1720e9")
        throw new Error("Expected the stock N90 10B329 installation daemon");
    // Native libmis returns SigningID/Entitlements for valid ad-hoc code,
    // with no signer certificate. Preserve that dictionary. installd's
    // install map requires a non-null signer *description*. Supply an
    // explicit local ad-hoc label, without inventing a signing certificate.
    // Actual certificates keep the original parsing/subject-summary path.
    // Thumb VA 0x1157c: cbnz r1,0x115ac; else create a CFString through
    // the existing 0x6cd38 stub, store it in the owned summary output,
    // and continue at 0x1163a. Signature errors return before this block.
    const replacement=new Uint8Array(48);
    replacement.set([0xb1,0xb9,0x04,0xa1,0x28,0x46,0x5b,0xf0,0xda,0xeb,0x03,0x99,0x08,0x60,0x56,0xe0,0,0xbf,0,0xbf]);
    replacement.set(new TextEncoder().encode("v86 local ad-hoc\0"),20);
    const patched=patch_guest_code(original,0x1057c,original.subarray(0x1057c,0x105ac),replacement);
    return link_guest_gles(patched, INSTALL_POLICY);
}
