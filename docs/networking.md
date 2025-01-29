# v86 networking

On the simplest level, networking in v86 is comprised of two components:

* an emulation of the guest's Network Interface Card (NIC), and
* a network backend which passes ethernet frames between the NIC and a virtual and/or physical network.

There are two **NIC emulations** supported by v86 to chose from, either **`ne2k`** (NE2000/RTL8390-compatible NIC) or **`virtio`** ([VirtIO](http://wiki.osdev.org/Virtio)-compatible device). The right choice simply depends on the driver support in the guest OS, older OSes like FreeDOS only support NE2000, more modern ones usually support VirtIO. In case both are supported by the guest OS it's recommended to try VirtIO first and only fall back to NE2000 if that fails. In some cases it will also be necessary to manually load a driver or similar to activate the NIC and/or networking in the guest OS, yet modern systems usually auto-detect an available NIC during installation and when booting.

There are also several **network backends** to chose from, they differ in their requirements and in the degree of network access and services provided to guests. Some provide only limited network access, others full access to a physical network which may include a gateway to the Internet. Backends may require a specific type of proxy server to operate.

The active network backend is configured through a user-specified **backend URL**. Each backend has at least one distinct URL scheme as specified below, where `PROXY` is the DNS hostname or IP address of a compatible proxy server, `PORT` its optional TCP port number (and its default), and `QUERY` is some HTTP query field fragment:

| Backend | Backend URL scheme(s) | Example |
| :------ | :-------------------- | :------ |
| **[localhub](#the-localhub-backend)** | `localhub` | `localhub` |
| **[wsproxy](#the-wsproxy-backend)** | `"ws://" PROXY [":" PORT=80] ["/" ...]`<br>`"wss://" PROXY [":" PORT=443] ["/" ...]` | `wss://relay.widgetry.org/` |
| **[wisp](#the-wisp-backend)** | `"wisp://" PROXY [":" PORT=80] ["/" ...]`<br>`"wisps://" PROXY [":" PORT=443] ["/" ...]` | `wisp://localhost:12345` |
| **[fetch](#the-fetch-backend)** | `"fetch" [ "://" PROXY [":" PORT] ["/?" QUERY] ]` | `fetch`<br>`fetch://localhost:1234/?url=` |

Note that `wss://` and `wisps://` are the TLS-secured transports of `ws://` and `wisps://`, respectively.

> [!TIP]
> Since public proxy servers provide only limited bandwidth it is recommended to install and use a local, private proxy server for best results. All proxy servers allow to be executed on the local machine, in a VM running on the local machine, in a local network or even publicly on the Internet (which is generally not recommended, of course). Many proxy servers are distributed as Docker containers which is the recommended way of installing them, otherwise install into a VM.

## Setup

### Network setup in the v86 web interface

Setting up networking in the web interface at https://copy.sh/v86/ is simple.

To configure the network backend, simply copy the backend URL into the text box named `Networking proxy`.

The guest's NIC emulation (NE2000 or VirtIO) is automatically configured when selecting the guest image in the web interface.

### Network setup using `net_device` options

In order to embed the v86 emulator in another project an instance of class `V86` needs to be created. The constructor expects a `config` object, and the network settings are controlled through its member **`config.net_device`**.

#### Basic `net_device` settings

All network setups support the following options:

| net_device   | type | description |
| :----------- | :--- | :--- |
| `type`       | str  | The type of emulated NIC provided to the guest OS, either `ne2k` (default) or `virtio` |
| `relay_url`  | str  | The network backend URL, either `localhub`, `ws[s]://...`, `wisp[s]://...` or `fetch`. Note that the CORS proxy server of the fetch backend is defined in field `cors_proxy` below. Also see the backend URL schemes described in the previous section. |
| `id`         | int  | Network id, all v86 network instances with the same id share the same network namespace, default: `0` (TODO: NetworkAdapter in browser/starter.js should also get options.net_device as the last argument ) |

#### Advanced `net_device` settings

Network backends `fetch` and `wisp` support some advanced settings in `net_device` that control the network components emulated by v86:

| net_device   | type | description |
| :----------- | :--- | :--- |
| `router_mac` | str  | Emulated router's MAC address, default `52:54:0:1:2:3` |
| `router_ip`  | str  | Emulated router's IP address in dotted IP notation, default `192.168.86.1` |
| `vm_ip`      | str  | IP address to be assigned to the guest VM in dotted IP notation, default `192.168.86.100` |
| `masquerade` | bool | `False`: TODO, `True`: TODO |
| `cors_proxy` | str  | URL including HTTP query fragment of the HTTP CORS proxy server to use with the fetch backend |
| `dns_method` | str  | DNS method to use, either `static` or `doh`. `static`: use built-in DNS server, `doh`: use DNS-over-HTTPS. Defaults to `static` for fetch and to `doh` for wisp |
| `doh_server` | str  | Host name (and optional port number) of the DoH-server if `dns_method` is `doh`. The value is expanded to the URL `https://DOH_SERVER/dns-query`. Default: `cloudflare-dns.com` |

#### Example `net_device` settings

* **Example 1:** Provide an emulated NE2000 NIC to the guest OS and use the wsproxy backend with a secure wsproxy server at public host `relay.widgetry.org` listening at default TLS port 443:
   ```
   let example_1 = new V86({
       net_device: {
           type: "ne2k",
           relay_url: "wss://relay.widgetry.org/"
       },
       // ...
   });
   ```

* **Example 2:** Provide a VirtIO NIC to the guest OS and use the fetch backend with a HTTP CORS proxy server at the local machine listening at port number 23456:
   ```
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

One way to look at the different types of network backends supported by v86 is how they operate on different layers in the [OSI reference model](https://en.wikipedia.org/wiki/OSI_model), approximately:

       Network Peer               Backend                 v86 Guest

    [ 7: Application  ] <--- fetch ---> +-----+      [ 7: Application  ]
    [ 6: Presentation ]                 |     |      [ 6: Presentation ]
    [ 5: Session      ]                 | v86 |      [ 5: Session      ]
    [ 4: Transport    ] <--- wisp ----> |     |      [ 4: Transport    ]
    [ 3: Network      ]                 |     |      [ 3: Network      ]
    [ 2: Data Link    ] <-- wsproxy --> +-----+ <--> [ 2: Data Link    ]
    [ 1: Physical     ] <-------- localhub --------> [ 1: Physical     ]

                      Fig. 1: Network backends in v86

v86 guests strictly expect to exchange layer-2 ethernet frames with their (emulated) network card, hence the higher the OSI layer that a v86 network backend operates on the more virtualized the network becomes and the more work has to be done by the backend to fill in for the missing layers.

In order to facilitate this for backend implementations, v86 provides helper functions to encode/decode ethernet frames, ARP and IPv4 packets, UDP datagrams, TCP streams and HTTP requests/responses. v86 can also provide minimal but sufficient ICMP, DHCP, DNS (including DoH) and NTP services to guests.

### The `localhub` backend

This backend provides layer-2 networking services for multiple v86 guests running within the same browser process (meaning within the same web page and/or in separate browser tabs). It works without a proxy server, but it also does not provide any access to external networks. v86 is not involved in the exchange of frames between guests beyond emulating the guests' network cards, hence the stretch to place it in Layer 1 in Fig. 1.

The localhub backend is implemented using the [BroadcastChannel](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel) browser API.

**Example**

* [`examples/broadcast-network.html`](../examples/broadcast-network.html)

### The `wsproxy` backend

A backend based on a proxy server that provides layer-2 networking services to guests using the [WebSocket](https://en.wikipedia.org/wiki/WebSocket) protocol for transport. It depends on the specific proxy server what kind of network configuration it presents to guests, but usually a separate IP subnet with DHCP and DNS services and optional access to the server's physical network and possibly Internet is provided to guests.

Since this type of backend simply forwards raw ethernet frames in v86 as well as in the proxy server it is generally very efficient and provides full physical network emulation to guests.

**Proxy server**

* **[websockproxy](https://github.com/benjamincburns/websockproxy)** -- uses a single TAP device for all clients, integrates dnsmasq for DHCP/DNS, original server implementation by benjamincburns
  * Docker `benjamincburns/jor1k-relay:latest` is throttled, see [this comment](https://github.com/benjamincburns/websockproxy/issues/4#issuecomment-317255890)
  * Docker `bellenottelling/websockproxy` is unthrottled
  * See [here](https://github.com/copy/v86/discussions/1175#discussioncomment-11199254) for step-by-step instructions on how to unthrottle websockproxy manually.
* **[wsnic](https://github.com/chschnell/wsnic)** -- uses a single bridge and one TAP device per client, integrates dnsmasq for DHCP/DNS and stunnel for TLS
* **[node-relay](https://github.com/krishenriksen/node-relay)** -- NodeJs
* **[go-websockproxy](https://github.com/gdm85/go-websockproxy)** -- Go

### The `wisp` backend

This backend implements the client side of the [WISP protocol](https://github.com/MercuryWorkshop/wisp-protocol). WISP is a client/server protocol designed to exchange WebSocket messages containing UDP and TCP payloads between a WebSocket client and a WISP-compatible proxy server. Note that WISP transports only the payloads, not the full UDP or TCP packets. See PR [#1097](https://github.com/copy/v86/pull/1097) for additional information about the WISP backend.

TODO: are v86 guests bridged or isolated in WISP (can they communicate with each other or not)?

**WISP-compatible proxy server**

* **[wisp-js](https://www.npmjs.com/package/@mercuryworkshop/wisp-js)**
* **[epoxy-tls](https://github.com/MercuryWorkshop/epoxy-tls)**

> [!NOTE]
> WISP only supports TCP client sockets in the v86 guest, TCP server sockets listening in the guest are not supported.

> [!NOTE]
> The WISP implementation in v86 is missing support for UDP.

### The `fetch` backend

The fetch backend uses the browser's [`fetch()`](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API) API to allow guests to send HTTP requests to external HTTP servers and to receive related HTTP responses. This is however complicated by the fact that browsers add [HTTP CORS headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS) to HTTP requests initiated by `fetch()`, and that they check the CORS headers of related HTTP responses to block access to external web resources not authorized to `fetch()` in the current context.

Even though a proxy server is optional with this backend, a HTTP CORS proxy server is generally indispensable in order to evade the limitations imposed by CORS and to access the open Internet. Yet, this backend is highly useful in special cases where CORS is not in the way.

This backend handles DHCP and ARP requests from the guest internally, and monitors the guest's outbound traffic for HTTP requests which it translates into calls to `fetch()`. Additionally, NTP, ICMP pings and UDP echo packets are handled to a certain degree. See PR [#1061](https://github.com/copy/v86/pull/1061) for additional technical details.

v86 guests are isolated from each other when using the fetch backend.

**HTTP CORS proxy server**

* **[cors-anywhere](https://github.com/Rob--W/cors-anywhere)** -- NodeJS
* **[uncors](https://github.com/chschnell/uncors)** -- A simple PHP-based HTTP CORS proxy server for Apache2.

> [!TIP]
> You can pass the following flags to **chromium** to allow browsing without restrictions in fetch mode:
>
>        --disable-web-security --user-data-dir=/tmp/test
>
> but note that this turns off the same-origin policy and should only be used temporarily!

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

There is no built-in support for v86 networking under NodeJS, but network backends `wsproxy` and `wisp` only depend on a browser-compatible `WebSocket` constructor being present in the global scope, whereas backends `localhub` and `fetch` should work directly.

## Links

*TODO*
