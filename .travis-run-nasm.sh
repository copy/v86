#!/usr/bin/env bash
set -e
make build/libv86.js
make -C tests/nasm/
./tests/nasm/run.js
