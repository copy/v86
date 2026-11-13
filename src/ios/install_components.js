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
    // optional certificate summary must stay null in that case; signatures
    // with a certificate still take its original certificate parsing path.
    // Thumb VA 0x1157c: cbnz r1,0x115ac; ldr.w r0,[r10] becomes
    // cmp r1,#0; beq 0x1163a; b 0x115ac. Signature errors return earlier.
    const patched=patch_guest_code(original,0x1057c,Uint8Array.of(0xb1,0xb9,0xda,0xf8,0,0),
        Uint8Array.of(0,0x29,0x5c,0xd0,0x14,0xe0));
    return link_guest_gles(patched, INSTALL_POLICY);
}
