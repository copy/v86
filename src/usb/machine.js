// The USB plugin's view of the machine (usb: { controller, tablet,
// mass_storage }): the device handle of src/device_machine.js plus the bus
// messages it takes (the page's pointer for the tablet) and sends (which
// pointer device is in use), and the disk images' block backends. Built into
// build/v86-usb.js.

import { DeviceMachine, register_device_plugin } from "../device_machine.js";

/**
 * Make the USB plugin known to v86 (its file calls this when it loads)
 * @param {!Object} descriptor { "name": "usb", "create": function(handle, options) }
 */
export function register_usb_plugin(descriptor)
{
    register_device_plugin("V86UsbControllers", descriptor);
}

/**
 * @constructor
 * @extends {DeviceMachine}
 * @param {!Object} handle
 */
export function UsbMachine(handle)
{
    DeviceMachine.call(this, handle);
    /** @const @type {!Object} */
    this.bus = handle["bus"];
}

UsbMachine.prototype = Object.create(DeviceMachine.prototype);

/**
 * A bus message for the plugin: "mouse-absolute", "mouse-click",
 * "mouse-wheel", "mouse-pointer-lock"
 * @param {string} name
 * @param {function(*)} handler
 */
UsbMachine.prototype.on = function(name, handler)
{
    this.bus["register"](name, handler);
};

/**
 * @param {string} name
 * @param {*} value
 */
UsbMachine.prototype.send = function(name, value)
{
    this.bus["send"](name, value);
};

/**
 * A disk image's block backend (src/device_plugin.js block_handle)
 * @param {!Object} buffer
 * @return {!Object}
 */
UsbMachine.prototype.block_backend = function(buffer)
{
    return this.handle["block_backend"](buffer);
};
