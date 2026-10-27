// net_device.type "ne2k" (the default) -- an NE2000-compatible card (RTL8029).
// Built into build/v86-ne2k.js; from the source tree, src/device_plugin.js
// imports this file directly. Its state is the core NE2000's of before (a
// snapshot's untagged state[59] is read as it is: src/device_plugin.js). No
// reset hook: the machine's reset left the NE2000 as it was before as well.

import { Ne2k } from "./ne2k.js";
import { NetMachine, register_net_adapter } from "../machine.js";

register_net_adapter({
    "name": "ne2k",
    "create": (handle, options) =>
    {
        const card = new Ne2k(new NetMachine(handle), options);
        return {
            "card": card,
            "get_state": () => card.get_state(),
            "set_state": state => card.set_state(state),
        };
    },
});
