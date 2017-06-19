How to run:

- Obtain the `linux3.iso` image (see [Readme.md](../../Readme.md))
- Run `make test-i386`
- Get the result on the host: `./test-386 > reference`
- Get the result from the VM: `./run.js > result`
- The difference should be empty: `diff reference result`
