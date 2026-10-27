// audio_device "hd_audio" -- an Intel HD Audio controller (ICH6 on i440FX,
// ICH9 on Q35) with a generic output codec, the sound card Windows Vista to
// 11 and Linux have drivers for. Built into build/v86-hd-audio.js; from the
// source tree, src/device_plugin.js imports this file directly.

import { HDAController } from "./controller.js";
import { register_audio_device } from "../machine.js";

register_audio_device({
    "name": "hd_audio",
    "create": (handle, options) =>
    {
        const controller = new HDAController(handle);
        return {
            "controller": controller,
            "reset": () => controller.reset(),
            "get_state": () => controller.get_state(),
            "set_state": state => controller.set_state(state),
        };
    },
});
