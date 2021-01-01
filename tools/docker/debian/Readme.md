You can build a Linux image for use with v86:

1. Run `./build-container.sh` to build the Docker container and v86 images (requires dockerd)
2. Run `./build-state.js` to build a state image in order to skip the boot process

Go to `debug.html?profile=debian` to start the generated container.

You can modify the `Dockerfile` to customize the generated Linux image.
