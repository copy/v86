Emulating a network card is supported. It can be used by passing the
`network_relay_url` option to `V86Starter`. The url must point to a running
WebSockets Proxy. The source code for WebSockets Proxy can be found at
https://github.com/benjamincburns/websockproxy.

The network card could also be controlled programatically, but this is
currently not exposed.

There is no built-in support for NodeJS, but networking only depends on a
browser-compatible `WebSocket` constructor being present in the global scope.

**NOTE:** original `benjamincburns/jor1k-relay:latest` docker image has
throttling built-in by default which will degrade the networking.
`bellenottelling/websockproxy`docker image has this throttling removed via
[websockproxy/issues/4#issuecomment-317255890](https://github.com/benjamincburns/websockproxy/issues/4#issuecomment-317255890).
