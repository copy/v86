You can build a Linux image for use with v86:

1. Run `./build-container.sh` to build the Docker container and v86 images (requires dockerd)
2. Run `./build-state.js` to build a state image in order to skip the boot process
3. Optionally, compress the `debian-state-base.bin` file using zstd (v86 automatically detects the zstd magic and decompresses on the fly)
4. Run a webserver serving repo root and go to `examples/debian.html` in a browser

If you want to see more info you can run it in a debug mode, to do so add a new profile in the `src/browser/main.js` file to the `oses` variable like so:

```js
var oses = [
    {
        id: "debian",
        name: "Debian",
        memory_size: 512 * 1024 * 1024,
        vga_memory_size: 8 * 1024 * 1024,
        state: { url: host + "debian-state-base.bin" },
        filesystem: { baseurl: host + "debian-9p-rootfs-flat/" }
    },
    ...
```

Save it and go to `debug.html?profile=debian` to start the generated container.

You can modify the `Dockerfile` to customize the generated Linux image.
