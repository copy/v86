You can build a Linux image for use with v86:

1. Run `./build-container.sh` to build the Docker container (requires dockerd)
2. Run `./create-9p-from-container.sh` to extract the files for v86 from the Docker container (requires root)
3. Run `./build-state.js` to build a state image in order to skip the boot process

Go to `debug.html?profile=debian` to start the generated container.

You can modify the `Dockerfile` to customize the generated Linux image.
