#!/usr/bin/env bash
set -e
make build/libv86.js
(cd tests/kvm-unit-tests && ./configure && make)
tests/kvm-unit-tests/run.js tests/kvm-unit-tests/x86/realmode.flat
