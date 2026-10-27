// A network card plugin's view of the machine (net_device.type "e1000"): the
// device handle of src/device_machine.js plus the card's network, the
// net<id>-send/-receive/-mac messages of the bus (src/cpu.js,
// create_net_plugin). Built into each card's plugin file.

import { DeviceMachine, register_device_plugin } from "../device_machine.js";

/**
 * Make a card known to v86 (its plugin file calls this when it loads)
 * @param {!Object} descriptor { "name", "create": function(handle, options) }
 */
export function register_net_adapter(descriptor)
{
    register_device_plugin("V86NetAdapters", descriptor);
}

/**
 * @constructor
 * @extends {DeviceMachine}
 * @param {!Object} handle
 */
export function NetMachine(handle)
{
    DeviceMachine.call(this, handle);

    /** @const @type {!Object} */
    this.net = handle["net"];

    /** @const @type {number} the network (net<id>) */
    this.net_id = this.net["id"];
}

NetMachine.prototype = Object.create(DeviceMachine.prototype);

/**
 * A frame to the network (without its FCS); the card does not keep it
 * @param {!Uint8Array} frame
 */
NetMachine.prototype.send = function(frame)
{
    this.net["send"](frame);
};

/**
 * The card's address, for the backend (its DHCP, ARP)
 * @param {string} mac "00:22:15:01:02:03"
 */
NetMachine.prototype.set_mac = function(mac)
{
    this.net["set_mac"](mac);
};

/**
 * Frames from the network: `handler` returns whether the card took the frame
 * @param {function(!Uint8Array):boolean} handler
 */
NetMachine.prototype.on_receive = function(handler)
{
    this.net["on_receive"](handler);
};
