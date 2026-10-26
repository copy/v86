// net_device.type "e1000" -- an Intel 82540EM (PRO/1000 MT Desktop), the card
// Windows Vista to 11 and Linux have drivers for. Built into
// build/v86-e1000.js; from the source tree, src/device_plugin.js imports this
// file directly.

import { E1000 } from "./e1000.js";
import { register_net_adapter } from "../machine.js";

register_net_adapter({
    "name": "e1000",
    "create": (handle, options) =>
    {
        const card = new E1000(handle, options);
        return {
            "card": card,
            "reset": () => card.reset(),
            "get_state": () => card.get_state(),
            "set_state": state => card.set_state(state),
        };
    },
});
