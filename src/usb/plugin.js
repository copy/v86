// usb: { controller: "uhci" | "ehci" | "xhci", tablet: true, mass_storage } --
// a USB host controller and its devices (docs/usb.md,
// docs/modern-pc-devices-plan.md U1 to U4): UHCI (PIIX3's on i440FX, ICH9's
// on Q35), ICH9's EHCI with its three UHCI companions (the plugin's PCI
// function is the EHCI's, 7; the companions are functions 0 to 2), or xHCI
// (QEMU's qemu-xhci); the HID tablet on the first port,
// USB disks (disk images, src/usb/mass_storage.js) on the ports after it.
// Built into build/v86-usb.js; from the source tree, src/device_plugin.js
// imports this file directly.

import { UsbMachine, register_usb_plugin } from "./machine.js";
import { COMPANION_IDENTITY, PORTS as UHCI_PORTS, UHCIController } from "./uhci.js";
import { EHCI_PORTS, EHCIController } from "./ehci.js";
import { XHCI_PORTS, XHCIController } from "./xhci.js";
import { HIDTablet } from "./hid_tablet.js";
import { MassStorage } from "./mass_storage.js";

register_usb_plugin({
    "name": "usb",
    "create": (handle, options) =>
    {
        const machine = new UsbMachine(handle);
        const ehci = options["controller"] === "ehci", xhci = options["controller"] === "xhci";
        const controller = ehci ?
            new EHCIController(machine, COMPANION_IDENTITY.map((identity, i) => new UHCIController(machine.function_machine(i), identity, i === 0))) :
            xhci ? new XHCIController(machine) : new UHCIController(machine);
        const PORTS = ehci ? EHCI_PORTS : xhci ? XHCI_PORTS : UHCI_PORTS;
        const NAME = ehci ? "EHCI" : xhci ? "xHCI" : "UHCI";
        const tablet = options["tablet"] ? new HIDTablet(() => machine.now()) : null;
        /**
         * The devices by their IDs: the device, its port (kept while it is
         * out of it), a disk's block backend
         * @type {!Map<string, {device: !Object, port: number, backend: ?Object}>}
         */
        const devices = new Map();
        if(tablet)
        {
            devices.set("tablet", { device: tablet, port: 0, backend: null });
            controller.attach(0, tablet);
            connect_pointer(machine, tablet);
        }

        const free_port = () =>
        {
            const used = Array.from(devices.values(), entry => entry.port);
            for(let port = 0; port < PORTS; port++) if(!used.includes(port)) return port;
            return -1;
        };
        // a disk image as a USB disk in the first free port
        const attach_disk = (id, buffer, read_only) =>
        {
            if(typeof id !== "string" || !id) throw new Error("usb: a USB disk needs an id");
            if(devices.has(id)) throw new Error("usb: there is a USB device " + JSON.stringify(id) + " already");
            const port = free_port();
            if(port < 0) throw new Error("usb: no free port for " + JSON.stringify(id) + " (the " + NAME + " controller has " + PORTS + ")");
            const backend = machine.block_backend(buffer);
            const disk = new MassStorage(backend, { id, read_only });
            disk.on_eject = () => machine.send("usb-disk-ejected", id);
            devices.set(id, { device: disk, port, backend });
            controller.attach(port, disk);
            return port;
        };
        // out of its port and gone: what it had under way is dropped (writes
        // issued are in the image)
        const detach_disk = id =>
        {
            const entry = devices.get(id);
            if(!entry || !entry.backend) throw new Error("usb: no USB disk " + JSON.stringify(id));
            entry.device.unplugged();
            if(controller.devices[entry.port] === entry.device) controller.attach(entry.port, null);
            entry.backend["drop"]();
            devices.delete(id);
        };
        for(const disk of options["mass_storage"] || []) attach_disk(disk["id"], disk["buffer"], !!disk["read_only"]);

        // V86.usb_plug: a device out of its port and back in ("usb-plugged"
        // answers: the ID, whether it is in, an error)
        machine.on("usb-plug", data =>
        {
            const id = data[0], plugged = !!data[1];
            const entry = devices.get(id);
            if(!entry)
            {
                machine.send("usb-plugged", [id, false, "no USB device " + JSON.stringify(id)]);
                return;
            }
            if(!plugged) entry.device.reset();
            controller.attach(entry.port, plugged ? entry.device : null);
            machine.send("usb-plugged", [id, plugged, null]);
        });
        return {
            "controller": controller,
            "tablet": tablet,
            "devices": devices,
            "attach_disk": attach_disk,
            "detach_disk": detach_disk,
            // V86.usb_devices: each device's port, whether it is in, the
            // controller that has it and its speed in Mbit/s
            "device_list": () => Array.from(devices, ([id, { device, port }]) => ({
                "id": id,
                "port": port,
                "plugged": controller.devices[port] === device,
                "controller": xhci ? "xhci" : ehci && controller.owns(port) ? "ehci" : "uhci",
                "speed": [1.5, 12, 480, 5000][device.speed],
            })),
            "reset": () => ehci || xhci ? controller.reset_all() : controller.reset(),
            "get_state": () => [controller.get_state(), tablet ? tablet.get_state() : null,
                Array.from(devices, ([id, { port }]) => controller.devices[port] ? id : null).filter(Boolean),
                Array.from(devices, ([id, { device, port, backend }]) => backend ? [id, port, device.get_state()] : null).filter(Boolean)],
            "set_state": state =>
            {
                controller.set_state(state[0]);
                const saved_disks = new Map((state[3] || []).map(disk => [disk[0], disk]));
                const arriving = [];
                for(const [id, { device, port, backend }] of devices)
                {
                    const saved = saved_disks.get(id);
                    if(!backend || saved && saved[1] === port)
                    {
                        controller.devices[port] = state[2].includes(id) ? device : null;
                        if(saved) device.set_state(saved[2]);
                    }
                    else
                    {
                        controller.devices[port] = null;
                        arriving.push([port, device]);
                    }
                }
                if(tablet && state[1]) tablet.set_state(state[1]);
                // (EHCI: each device on the side its port's owner had)
                if(ehci) controller.restore_routing();
                // a disk the snapshot does not have (there): it arrives now
                for(const [port, device] of arriving) controller.attach(port, device);
                // a device the snapshot had that this machine has not: it leaves now
                for(let port = 0; port < PORTS; port++)
                {
                    if(!controller.devices[port] && controller.port_connected(port)) controller.attach(port, null);
                }
            },
        };
    },
});

/**
 * The page's pointer to the tablet: its absolute position, buttons and
 * wheel while the guest has the tablet configured and the pointer is not
 * locked (locked, the pointer is relative: the PS/2 mouse's). The tablet's
 * use is announced ("usb-tablet-active"), so that the PS/2 mouse and the
 * VMware backdoor leave the pointer to it.
 * @param {UsbMachine} machine
 * @param {HIDTablet} tablet
 */
function connect_pointer(machine, tablet)
{
    let locked = false;
    const active = () => tablet.in_use && !locked;
    tablet.on_use = in_use => machine.send("usb-tablet-active", in_use);
    // (the middle of the page's pixel: guests take the pixel a position falls
    // in, and the pixel's left or top edge would round into its neighbour)
    machine.on("mouse-absolute", data =>
    {
        if(active() && data[2] > 0 && data[3] > 0) tablet.move((data[0] + 0.5) / data[2], (data[1] + 0.5) / data[3]);
    });
    machine.on("mouse-click", data => { if(active()) tablet.press(!!data[0], !!data[1], !!data[2]); });
    machine.on("mouse-wheel", data => { if(active()) tablet.scroll(data[0] | 0); });
    machine.on("mouse-pointer-lock", value =>
    {
        locked = !!value;
        // (the buttons held go up: the other path has them from now on)
        if(locked) tablet.press(false, false, false);
    });
}
