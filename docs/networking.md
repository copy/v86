# v86 networking

User guide to networking in v86.

## Introduction

On the most basic level, networking in v86 is comprised of two components:

* an emulation of the guest's [Network Interface Controller](https://en.wikipedia.org/wiki/Network_interface_controller) (NIC), and
* a network backend which passes ethernet frames between the NIC and a virtual and/or physical [ethernet network](https://en.wikipedia.org/wiki/Ethernet).

There are two **NIC emulations** supported by v86 to chose from, either **`ne2k`** (NE2000/RTL8390-compatible NIC) or **`virtio`** ([VirtIO](http://wiki.osdev.org/Virtio)-compatible device). The right choice simply depends on the driver support in the guest OS, older OSes like FreeDOS only support NE2000, more modern ones usually support VirtIO. In case both are supported by the guest OS it's recommended to try VirtIO first and only fall back to NE2000 if that fails. In some cases it will also be necessary to manually load a driver or similar to activate the NIC and/or networking in the guest OS, yet modern systems usually auto-detect an available NIC during installation and when booting.

There are also several **network backends** to chose from which emulate the network that the virtual NIC is connected to, they differ in their requirements and in the degree of network access and services provided to guests. Some provide only limited network access, others full access to a physical network which may include a gateway to the Internet. Backends may require a specific type of proxy server to operate.

### Backend URL schemes

The active network backend is configured through a user-specified **backend URL**. Each backend has at least one distinct URL scheme as specified below, where `PROXY` is the DNS hostname or IP address of a compatible proxy server, `PORT` its optional TCP port number (and its default), and `QUERY` is some HTTP query field fragment:

| Backend | Backend URL scheme(s) | Example(s) |
| :------ | :-------------------- | :--------- |
| **[inbrowser](#the-inbrowser-backend)** | `inbrowser` | `inbrowser` |
| **[wsproxy](#the-wsproxy-backend)** | `"ws://" PROXY [":" PORT=80] ["/" ...]`<br>`"wss://" PROXY [":" PORT=443] ["/" ...]` | `wss://relay.widgetry.org/` |
| **[wisp](#the-wisp-backend)** | `"wisp://" PROXY [":" PORT=80] ["/" ...]`<br>`"wisps://" PROXY [":" PORT=443] ["/" ...]` | `wisp://localhost:12345` |
| **[fetch](#the-fetch-backend)** | `"fetch" [ "://" PROXY [":" PORT] ["/" QUERY] ]` | `fetch`<br>`fetch://localhost:1234/?url=` |

Note that `wss://` and `wisps://` are the TLS-secured transports of `ws://` and `wisp://`, respectively.

> [!TIP]
> Since public proxy servers provide only limited bandwidth it is recommended to install and use a local, private proxy server for best results. All proxy servers allow to be executed on the local machine, in a VM running on the local machine, in a local network or even publicly on the Internet (which is generally not recommended, of course). Many proxy servers are distributed as Docker containers which is the recommended way of installing them, otherwise install into a VM.

## Network setup

### Web interface setup

Network setup in the v86 web interface at **https://copy.sh/v86/** is straightforward, simply copy the backend URL into the text box named **`Networking proxy`** or select one of the presets to configure the network backend. The guest's NIC emulation (NE2000 or VirtIO) is automatically configured when selecting the guest image in the web interface.

### Embedded v86 setup

JavaScript applications that do not use the v86 web interface (but instead embed V86 into their architecture) setup their network by using the common `config` object that they pass to the V86 constructor. Network settings are members of the object **`config.net_device`**, all settings are optional except for `relay_url`.

#### General `net_device` settings

Common options in `config.net_device`:

| net_device    | type | description |
| :------------ | :--- | :--- |
| **type**      | str  | The type of emulated NIC provided to the guest OS, either `ne2k` or `virtio`. Default: `ne2k`. |
| **relay_url** | str  | The network backend URL, see [Backend URL schemes](#backend-url-schemes) for details. Note that the CORS proxy server of the `fetch` backend is defined in field `cors_proxy` below. This option is required. |
| **id**        | int  | Network id, all v86 network instances with the same id share the same network namespace. Default: `0`.<br>*(TODO: class `NetworkAdapter` should also get options.net_device as an argument, at least options.net_device.id).* |

#### Special `net_device` settings

Backends `fetch` and `wisp` support a couple of special settings in `config.net_device` to control virtual network components emulated by the backend:

| net_device     | type | description |
| :------------- | :--- | :--- |
| **router_mac** | str  | MAC address of virtual network peers (ARP, PING, DHCP, DNS, NTP, UDP echo and TCP peers) in common MAC address notation. Default `52:54:0:1:2:3`. |
| **router_ip**  | str  | IP address of virtual network peers (ARP, PING, DHCP, DNS and TCP peers) in dotted IP notation. Default `192.168.86.1`. |
| **vm_ip**      | str  | IP address to be assigned to the guest by DHCP in dotted IP notation. Default `192.168.86.100`. |
| **masquerade** | bool | If `True`, announce `router_ip` as the router's and DNS server's IP addresses in generated DHCP replies, and also generate ARP replies to IPs outside the router's subnet `255.255.255.0`. Default: `True`. |
| **dns_method** | str  | DNS method to use, either `static` or `doh`. `static`: use built-in DNS server, `doh`: use [DNS-over-HTTPS](https://en.wikipedia.org/wiki/DNS_over_HTTPS) (DoH). Defaults to `static` for `fetch` and to `doh` for `wisp` backend. |
| **doh_server** | str  | Host name or IP address (and optional port number) of the DoH server if `dns_method` is `doh`. The value is expanded to the URL `https://DOH_SERVER/dns-query`. Default: `cloudflare-dns.com`. |
| **cors_proxy** | str  | CORS proxy server URL, do not use a proxy if undefined. Default: undefined (`fetch` backend only). |

#### Example `net_device` settings

* **Example 1:** Provide an emulated NE2000 NIC to the guest OS and use the `wsproxy` backend with a secure wsproxy server at public host `relay.widgetry.org` listening at default TLS port 443:
   ```javascript
   let example_1 = new V86({
       net_device: {
           relay_url: "wss://relay.widgetry.org/"
       },
       // ...
   });
   ```

* **Example 2:** Provide a VirtIO NIC to the guest OS and use the `fetch` backend with a CORS proxy server at the local machine listening at port number 23456:
   ```javascript
   let example_2 = new V86({
       net_device: {
           type: "virtio",
           relay_url: "fetch",
           cors_proxy: "https://localhost:23456/?url="
       },
       // ...
   });
   ```

## Network backends

One way to compare the different network backends is how they operate on different layers of the TCP/IP Model (see [Wikipedia](https://en.wikipedia.org/wiki/OSI_model#Comparison_with_TCP/IP_model) for a comparison to the OSI model), approximately:

     Network Peer              Backend                 v86 Guest

    [ Application ] <---- fetch ----> +-----+       [ Application ]
    [   Transport ] <---- wisp -----> | v86 |       [ Transport   ]
    [     Network ]                   |     |       [ Network     ]
    [      Access ] <--- wsproxy ---> +-----+ <---> [ Access      ]
                      and inbrowser

                    Fig. 1: Network backends in v86

v86 guests strictly expect to exchange raw ethernet frames with their (emulated) network card, hence the higher the layer that a v86 network backend operates on the more virtualized the network becomes and the more work has to be done by the backend to fill in for the missing layers.

In order to facilitate this for backend implementations, v86 provides helper functions to encode/decode ethernet frames, ARP and IPv4 packets, UDP datagrams, TCP streams and HTTP requests/responses. v86 can also provide minimal but sufficient ARP, ICMP-echo, DHCP, DNS (including DoH) and NTP services to guests.

The v86 architecture is open for additional network backend implementations, for a basic example see [examples/two_instances.html](../examples/two_instances.html).

### The `inbrowser` backend

This backend provides raw ethernet services for multiple v86 guests running within the same browser process (meaning within the same web page and/or in separate browser tabs). It works standalone without a proxy server, but it also does not provide any access to external networks.

The `inbrowser` backend is implemented using the browser-internal [BroadcastChannel](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel) API, due to its simplicity it is the most efficient backend, however all VMs have to share the same browser resources.

### The `wsproxy` backend

A backend based on a proxy server that provides raw ethernet services to guests using the [WebSocket](https://en.wikipedia.org/wiki/WebSocket) protocol for transport. It depends on the specific proxy server what kind of network configuration it presents to guests, but usually a separate IP subnet with DHCP and DNS services and optional access to the server's physical network and possibly Internet are provided.

Since this backend (including its proxy server) only forwards unmodified ethernet frames it is inherently efficient while providing full physical network emulation to guests.

**Proxy server**

* **[websockproxy](https://github.com/benjamincburns/websockproxy)** -- one TAP device for all clients, integrates dnsmasq for DHCP/DNS, no TLS, original server by benjamincburns
  * Docker container [`benjamincburns/jor1k-relay`](https://hub.docker.com/r/benjamincburns/jor1k-relay) is throttled, see [this comment](https://github.com/benjamincburns/websockproxy/issues/4#issuecomment-317255890)
  * Docker container [`bellenottelling/websockproxy`](https://hub.docker.com/r/bellenottelling/websockproxy) is unthrottled
  * [See here](https://github.com/copy/v86/discussions/1175#discussioncomment-11199254) for step-by-step instructions on how to unthrottle websockproxy manually.
* **[go-websockproxy](https://github.com/gdm85/go-websockproxy)** -- one TAP device for all clients, written in Go, without integraded DHCP but with integrated TLS support
* **[node-relay](https://github.com/krishenriksen/node-relay)** -- like websockproxy but written for NodeJS (dnsmasq/no TLS), see [New websocket ethernet switch built using Node.js #777](https://github.com/copy/v86/discussions/777)
* **[wsnic](https://github.com/chschnell/wsnic)** -- uses a single bridge and one TAP device per client, integrates dnsmasq for DHCP/DNS and stunnel for TLS

[See here](https://github.com/copy/v86/discussions/1199#discussioncomment-12026845) for a benchmark comparing the download performance of these proxy servers.

### The `wisp` backend

The `wisp` backend implements the client side of the [WISP protocol](https://github.com/MercuryWorkshop/wisp-protocol). WISP is a client/server protocol designed to exchange messages containing UDP and TCP payloads between a WebSocket client and a WISP-compatible proxy server. Note that WISP transports only the packet payloads, not the raw UDP or TCP packets.

This backend monitors outbound traffic from guests and wraps/unwraps TCP payload data in WISP messages. A TCP state machine is included to terminate the guest's TCP stream. In addition to the TCP stream, virtual replies to ARP, DHCP, DNS, NTP, ICMP-Ping and UDP-Echo requests from guests are generated (to a certain degree). See PR [#1097](https://github.com/copy/v86/pull/1097) for additional information about this backend.

v86 guests are isolated from each other when using the `wisp` backend.

**WISP-compatible proxy server**

* **[wisp-js](https://www.npmjs.com/package/@mercuryworkshop/wisp-js)**
* **[epoxy-tls](https://github.com/MercuryWorkshop/epoxy-tls)**

> [!NOTE]
> The WISP protocol only supports UDP and TCP client sockets in the v86 guest, any server sockets listening in the guest are not supported.

> [!NOTE]
> This WISP implementation does not support UDP, only TCP. Once UDP is added, regular DNS over UDP will become the default (instead of DoH), and the builtin NTP and UDP-Echo servers will be removed.

### The `fetch` backend

The `fetch` backend uses the browser's [`fetch()`](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API) API to allow guests to send HTTP requests to external HTTP servers and to receive related HTTP responses. This is however complicated by the fact that browsers add [CORS headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS) to HTTP requests initiated by `fetch()`, and that they check the CORS headers of related HTTP responses to block access to external web resources not authorized to `fetch()` in the given context.

This backend is efficient and very useful in cases where CORS is not in the way, otherwise (and in general) a CORS proxy server must be used to provide access to HTTP servers on the open Internet.

Like the [`wisp`](#the-wisp-backend) backend, the `fetch` backend handles DHCP and ARP requests from guests internally, and additionally monitors the guest's outbound traffic for HTTP requests which it translates into calls to `fetch()`. NTP, ICMP pings and UDP echo packets are handled to a certain degree. Note that `fetch()` performs the DNS lookup using the browser's internal DNS client. See PR [#1061](https://github.com/copy/v86/pull/1061) for additional technical details.

Starting with PR [#1233](https://github.com/copy/v86/pull/1233), the TCP guest listener can be accessed from JS API, see the [examples/tcp_terminal.html](../examples/tcp_terminal.html) example.

v86 guests are isolated from each other when using the `fetch` backend.

v86 guests have HTTP access to the host's `localhost` using the URL `http://<port>.external` (e.g. `1234.external` -> `localhost:1234`).

**CORS proxy server**

* **[cors-anywhere](https://github.com/Rob--W/cors-anywhere)** -- NodeJS
* **[uncors](https://github.com/chschnell/uncors)** -- A simple PHP-based CORS proxy server for Apache2.

> [!TIP]
> You can pass the following flags to **chromium** to allow browsing without restrictions when using the fetch backend:
>
>     --disable-web-security --user-data-dir=/tmp/test
>
> **NOTE:** This turns off the same-origin policy and should only be used temporarily!

## Related topics

### v86 run-time state images

v86 supports saving and restoring the guest's and emulator's run-time state in **state image** files.

When restoring a state image, v86 randomises the restored guest's MAC address to make sure that multiple VMs restored from the same state image use different MAC addresses. However, the restored guest OS is unaware that its NIC's MAC address has changed which prevents it from sending and receiving packets correctly. There are several workarounds:

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

### NodeJS

Network backends `wsproxy` and `wisp` depend on a browser-compatible `WebSocket` constructor being present which is the case since NodeJS v22, backends `inbrowser` and `fetch` should work straightaway.

## Links

* [`examples/two_instances.html`](../examples/two_instances.html), example code that shows how to connect two VMs in a web page with a virtual ethernet crossover cable.
* [`examples/broadcast-network.html`](../examples/broadcast-network.html), example code that shows the raw packet API.
* [`examples/tcp_terminal.html`](../examples/tcp_terminal.html), example code that shows how to communicate with a guest TCP port on the `fetch` backend.
* [DC through windows OS for experimental lab #1195](https://github.com/copy/v86/discussions/1195), demonstrates how to setup a Domain Controller for two Windows VMs (XP and Server 2003) using a virtual crossover cable.
* [Working on a new cross-platform network relay that is a full virtualized network #1064](https://github.com/copy/v86/discussions/1064) (used in [env86 #1085](https://github.com/copy/v86/discussions/1085))
