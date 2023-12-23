# v86 networking

Emulating a network card is supported. It can be used by passing the
`network_relay_url` option to `V86`. The url must point to a running
WebSockets Proxy. The source code for the WebSockets Proxy can be found at
[benjamincburns/websockproxy](https://github.com/benjamincburns/websockproxy).
An alternative, Node-based implementation is
[krishenriksen/node-relay](https://github.com/krishenriksen/node-relay).

The network card could also be controlled programatically, but this is
currently not exposed.

There is no built-in support for NodeJS, but networking only depends on a
browser-compatible `WebSocket` constructor being present in the global scope.

**NOTE:** original `benjamincburns/jor1k-relay:latest` docker image has
throttling built-in by default which will degrade the networking.
`bellenottelling/websockproxy`docker image has this throttling removed via
[websockproxy/issues/4#issuecomment-317255890](https://github.com/benjamincburns/websockproxy/issues/4#issuecomment-317255890).

### Interaction with state images

When using state images, v86 randomises the MAC address after the state has
been loaded, so that multiple VMs don't receive the same address. However, the
guest OS is not aware that the MAC address has changed, which prevents it from
sending and receiving packets correctly. There are several workarounds:

- Unload the network driver before saving the state. On Linux, unloading can be
  done using `rmmod ne2k-pci` or `echo 0000:00:05.0 >
  /sys/bus/pci/drivers/ne2k-pci/unbind` and loading (after the state has been
  loaded) using `modprobe ne2k-pci` or `echo 0000:00:05.0 >
  /sys/bus/pci/drivers/ne2k-pci/bind`
- Pass `preserve_mac_from_state_image: true` to the V86 constructor. This
  causes MAC addresses to be shared between all VMs with the same state image.
- Pass `mac_address_translation: true` to the V86 constructor. This causes v86
  to present the old MAC address to the guest OS, but translate it to a
  randomised MAC address in outgoing packets (and vice-versa for incoming
  packets). This mechanism currently only supports the ethernet, ipv4, dhcp and
  arp protcols. See `translate_mac_address` in
  [`src/ne2k.js`](https://github.com/copy/v86/blob/master/src/ne2k.js). This is
  currently used in Windows, ReactOS and SerenityOS profiles.
- Some OSes don't cache the MAC address when the driver loads and therefore
  don't need any of the above workarounds. This seems to be the case for Haiku,
  OpenBSD and FreeBSD.

Note that the same applies to IP addresses, so a DHCP client should only be run
after the state has been loaded.
