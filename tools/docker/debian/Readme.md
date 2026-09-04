Debian-xfce docker example:

For using split raw disk:
1. run `bash build-raw-disk.sh` to build images
2. run `./build-state-raw-disk.js` to build the state
3. An example frontend is `examples/debian-raw-disk.html`

For using 9p filesystem:

1. run `bash build-9p.sh` to build images
2. run `./build-state-9p.js` to build the state
3. An example frontend is `examples/debian-9p.html`

For setting up website:

1. Either build v86 or downloading the release and place `v86.wasm` and `libv86.js` in `build` directory
2. Launch a server at the root of this repository, e.g. `python3 -m http.server 8000`
3. Open `http://localhost:8000/examples/debian-raw-disk.html` (raw disk) or `http://localhost:8000/examples/debian-9p.html` (9p filesystem)

Network:

Enable network by typing the following command in the xfce terminal:

```
sudo dhclient enp0s5
```

Credit:

v86 debian config from sandbox-bio: https://github.com/sandbox-bio/v86/tree/master/tools/docker/debian

