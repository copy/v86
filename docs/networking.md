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

### fetch-based networking

v86 supports an experimental networking mode, which is enabled by specifying
`"fetch"` as the relay url. In this mode, no external relay is used and packets
are parsed internally by v86. DHCP and ARP requests are handled by an internal
router, and HTTP requests are translated into calls to `fetch` (which only
works on [CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS)-enabled
hosts). Additionally, NTP, ICMP pings and UDP echo packets are handled to a
certain degree. See [#1061](https://github.com/copy/v86/pull/1061) for some
technical details.

You can pass the following flags to chromium to allow browsing without
restrictions in `fetch` mode:
    `--disable-web-security --user-data-dir=/tmp/test`
Note that this turns off the same-origin policy and should only be used
temporarily.

### wisp networking

v86 also supports the [wisp
protocol](https://github.com/MercuryWorkshop/wisp-protocol) as a networking
proxy. Wisp servers can be specified with the `wisp://` or `wisps://` prefix.
See #1097 for some information.

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
