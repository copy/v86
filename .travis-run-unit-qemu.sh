#!/usr/bin/env bash
set -e
mkdir -p images
(cd images && curl --compressed -O https://copy.sh/v86/images/linux3.iso)
make build/libv86.js
(cd tests/qemu && make test-i386)
./tests/qemu/run.js > result
./tests/qemu/test-i386 > reference
diff result reference
