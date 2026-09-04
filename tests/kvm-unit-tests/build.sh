#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
./configure --arch=i386
make CC="gcc -std=gnu11 -mno-sse -mno-sse2 -mno-mmx" x86/realmode.flat x86/taskswitch.flat x86/taskswitch2.flat
