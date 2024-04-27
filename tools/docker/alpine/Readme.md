You can build a Alpine Linux 9p image using Docker:

1. As needed, kernel flavor (`virt` is smaller than `lts`, but don't have networking) and set of additional packages (community repo is enabled by default) can be edited in `Dockerfile`
2. Run `./start-container.sh` with started dockerd (podman works)
3. Configure V86 options (you can use `examples/arch.html` or `examples/debian.html` as template) or add profile in `src/browser/main.js` (see `tools/docker/debian/Readme.md`) and run local webserver (`make run`)

```js
filesystem: {
    baseurl: "../images/alpine-rootfs-flat",
    basefs: "../images/alpine-fs.json"
},
bzimage_initrd_from_filesystem: true,
cmdline: [
    "rw",
    "root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose modules=virtio_pci",
    "tsc=reliable nowatchdog"
].join(" ")
```
