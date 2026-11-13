import { SHA256 } from "../image/sha256.js";
import { link_guest_gles, cdhashes } from "./guest_load.js";
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
    return link_guest_gles(original, INSTALL_POLICY);
}
