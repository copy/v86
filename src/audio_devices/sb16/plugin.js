// audio_device "sb16" (the default) -- a Sound Blaster 16 on the ISA bus.
// Built into build/v86-sb16.js; from the source tree, src/device_plugin.js
// imports this file directly. Its state is the core SB16's of before (a
// snapshot's untagged state[61] is read as it is: src/device_plugin.js). No
// reset hook: the machine's reset left the SB16 as it was before as well.

import { SB16 } from "./sb16.js";
import { AudioMachine, register_audio_device } from "../machine.js";

register_audio_device({
    "name": "sb16",
    "create": handle =>
    {
        const card = new SB16(new AudioMachine(handle));
        return {
            "card": card,
            "get_state": () => card.get_state(),
            "set_state": state => card.set_state(state),
        };
    },
});
