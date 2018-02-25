#!/usr/bin/env bash
set -e
./tests/nasm/create_tests.js
make -j $(nproc --all) JIT_ALWAYS=1 nasmtests
