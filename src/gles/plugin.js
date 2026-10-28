// ranchu_gpu: "host" -- the GLES host (docs/gles-proxy-plan.md): the
// emulator's GLES protocol decoded on the machine's thread, its services
// handed to the ranchu machine's goldfish pipe ("opengles",
// "GLProcessPipe"). Built into build/v86-gles.js; from the source tree,
// src/device_plugin.js imports this file directly.
//
// The shadow state answers the guest; GLES batches go to the renderer
// channel (options "renderer": the page's, stream "gles"). The device's
// "summary" gives the counts (tests, the plan's review). Built by esbuild,
// not Closure: it brings gl-webgpu's GLSL front end (CommonJS scripts).

import { register_device_plugin } from "../device_machine.js";
import { GLESHost } from "./gles_host.js";

register_device_plugin("V86GlesHosts", {
    "name": "gles",

    /**
     * @param {!Object} handle
     * @param {!Object} options "display": the screen's width, height and
     *     dpi; "renderer": the renderer channel, or null; "present": the
     *     screen's (RGBA, width, height), for frames read back
     */
    "create": (handle, options) =>
    {
        const display = options["display"];
        const host = new GLESHost({ width: display["width"], height: display["height"], dpi: display["dpi"] }, options["renderer"] || null,
            options["present"]);
        return {
            // (a service as src/virt/goldfish.js takes one; with a snapshot's state of it)
            "service": (name, wake, saved) => host.service(name, wake, saved),
            "summary": () => host.summary(),
            "reset": () => host.reset(),
            // (E5: the calls waiting for the page answered, the page's state fetched;
            // then the snapshot's slot, restored after the pipe's channels)
            "prepare_save": () => host.prepare_save(),
            "get_state": () => host.get_state(),
            "set_state": state => host.set_state(state),
        };
    },
});
