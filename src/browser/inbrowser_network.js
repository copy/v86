// For Types Only
import { BusConnector } from "../bus.js";

/**
 * Network adapter "inbrowser" which connects the emulated NIC
 * to a shared in-browser BroadcastChannel.
 *
 * NOTE: BroadcastChannel.postMessage() sends the given message to
 *       *other* BroadcastChannel objects set up for the same channel.
 *       Since we use the same BroadcastChannel instance for both
 *       sending and receiving we do not receive copies of our
 *       own sent messages.
 *       Source: https://html.spec.whatwg.org/multipage/web-messaging.html#broadcasting-to-other-browsing-contexts
 *
 * @constructor
 *
 * @param {BusConnector} bus
 * @param {*=} config
 */
export function InBrowserNetworkAdapter(bus, config)
{
    const id = config.id || 0;

    this.bus = bus;
    this.bus_send_msgid = `net${id}-send`;
    this.bus_recv_msgid = `net${id}-receive`;
    this.channel = new BroadcastChannel(`v86-inbrowser-${id}`);
    this.is_open = true;

    // forward ethernet frames from emulated NIC to hub
    this.nic_to_hub_fn = (eth_frame) => {
        this.channel.postMessage(eth_frame);
    };
    this.bus.register(this.bus_send_msgid, this.nic_to_hub_fn, this);

    // forward ethernet frames from hub to emulated NIC
    this.hub_to_nic_fn = (ev) => {
        this.bus.send(this.bus_recv_msgid, ev.data);
    };
    this.channel.addEventListener("message", this.hub_to_nic_fn);
}

InBrowserNetworkAdapter.prototype.destroy = function()
{
    if(this.is_open) {
        this.bus.unregister(this.bus_send_msgid, this.nic_to_hub_fn);
        this.channel.removeEventListener("message", this.hub_to_nic_fn);
        this.channel.close();
        this.is_open = false;
    }
};
