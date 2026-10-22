// @ts-check
// The VM manager (docs/vm-manager-plan.md): index.html's page. The address
// decides: ?vm=<id> is a library machine's console, ?profile=custom with an
// image (hda.url, cdrom.url or fda.url, and the old page's other query
// arguments) a console as the old page starts it, anything else the library.

import { open_library } from "./ui/library.js";
import { open_console } from "./ui/console.js";

const args = new URLSearchParams(location.search);
const root = /** @type {HTMLElement} */ (document.getElementById("app"));

if(!globalThis.WebAssembly)
{
    root.textContent = "Your browser is not supported because it doesn't support WebAssembly";
}
else if(args.has("vm"))
{
    open_console(root, { vm: /** @type {string} */ (args.get("vm")) });
}
else if(args.has("profile") && !(args.get("profile") === "custom" && !["hda.url", "cdrom.url", "fda.url"].some(name => args.has(name))))
{
    open_console(root, { query_args: args });
}
else
{
    open_library(root);
}
