Debian-xfce docker example:

For using 9p filesystem:

1. remove `Dockerfile` and rename `Dockerfile-9p`to `Dockerfile`
2. run `bash build-9p.sh` to build images
3. run `./build-state-9p.js` to build the state
4. run `bash ./compress-split-state.sh` to compress and split the state
5. An example frontend is `web-example/debian-9p.html`

