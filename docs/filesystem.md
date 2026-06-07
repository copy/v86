A 9p filesystem is supported by v86, using a virtio transport. There are several
ways it can be set up.

### Guest mount

In all cases, the filesystem is mounted in the guest system using the `9p`
filesystem type and the `host9p` device tag. Typically you want to be specific
with the version and transport options:

```sh
mount -t 9p -o trans=virtio,version=9p2000.L host9p /mnt/9p/
```

Here are kernel arguments you can use to boot directly off the 9p filesystem:

```
rw root=host9p rootfstype=9p rootflags=trans=virtio,version=9p2000.L
```

The `aname` option can be used to pick the directory from 9p to mount. The `rw`
argument makes this a read-write root filesystem.


### JSON/HTTP Filesystem

This is the standard way to setup the 9p filesystem. It loads files over
HTTP on-demand into an in-memory filesystem in JS. This allows files to be
exchanged with the guest OS. See `create_file` and `read_file` in
[`starter.js`](https://github.com/copy/v86/blob/master/src/browser/starter.js).

This mode is enabled by passing the following options to `V86`:

```javascript
filesystem: {
    basefs: "../9p/fs.json",
    baseurl: "../9p/base/",
}
```

Here, `basefs` is a json file created using
[fs2json.py](tools/fs2json.py) and the `baseurl` directory is created using
[copy-to-sha256.py](tools/copy-to-sha256.py).

If `basefs` and `baseurl` are omitted, an empty 9p filesystem is created. Unless
you configure one of the alternative modes.


### Function Handler

You can handle 9p messages directly in JavaScript yourself by providing a
function as `handle9p` under `filesystem`:

```javascript
filesystem: {
    handle9p: async (reqBuf, reply) => {
        // reqBuf is a Uint8Array of the entire request frame.
        // you can parse these bytes using a library or reading the 9p spec.
        // once you formulate a response, you send the reply frame as a
        // Uint8Array by passing it to reply: reply(respBuf)
    }
}
```

This allows you to implement a 9p server or custom proxy in JS. However, this
filesystem will not be cached (unless cached in the guest OS), functions like
`create_file` and `read_file` will not be available, and you will be responsible
for keeping its state in sync with any machine save states.


### WebSocket Proxy

You can also back the 9p virtio filesystem with a 9p server over WebSocket by
providing a WS proxy URL:

```javascript
filesystem: {
    proxy_url: "ws://localhost:8080/"
}
```

Simlar to using `handle9p`, this filesystem will not be available in JS and
will need to be re-mounted after restoring state.

The WS proxy just needs to hand off messages with a connection to a normal 9p
server. Each binary WebSocket message is the full buffer of a request or a
reply.

To implement, request message bytes can just be sent directly to the 9p
connection, but the 9p reply stream needs to be buffered into a single binary
WebSocket message. The proxy must at least parse the first 4 bytes to get the
message size and use it to buffer a full message before sending over WebSocket.

The [wanix](https://github.com/tractordev/wanix) CLI has a `serve` command that
not only serves a directory over HTTP, but also over 9P via WebSocket. You can
see how it [implements a proxy][1] in Go.

[1]: https://github.com/tractordev/wanix/blob/main/cmd/wanix/serve.go#L117-L177
