#!/bin/bash
# Build kvm-unit-tests out of tree, in build/kvm-unit-tests/<arch>/ of the v86
# checkout, so that i386 and x86_64 builds do not overwrite each other.
#
# usage: build.sh [ARCH [TEST.flat...]]
#   ARCH defaults to i386; the tests default to the ones in `make kvm-unit-test`
#   ARCH arm64-4k, arm64-16k or arm64-64k: upstream's arm64 tests with that
#   translation granule (docs/arm64-virt-android16-plan.md P0.6), built from
#   the pinned upstream checkout KUT_ARM64_SRC (default build/a64-ref/
#   kvm-unit-tests at $kut_arm64_commit): this copy's lib/ is years older
#   than upstream's arm/ and lib/arm*.
set -euo pipefail

src="$(cd "$(dirname "$0")"; pwd)"
arch="${1:-i386}"
shift || true
kut_arm64_commit=5a221342a025948fa7d84f0c404748f6ba57f3ad

case "$arch" in arm64-*|arm)
    page="${arch#arm64-}"
    ksrc="${KUT_ARM64_SRC:-$src/../../build/a64-ref/kvm-unit-tests}"
    ksrc="$(cd "$ksrc"; pwd)"
    if [ "$(git -C "$ksrc" rev-parse HEAD)" != "$kut_arm64_commit" ]
    then
        echo "$ksrc is not kvm-unit-tests $kut_arm64_commit" >&2
        exit 1
    fi
    if [ $# -eq 0 ] && [ "$arch" = arm ]
    then
        # (ARCH arm: the 32-bit tests, cpu_type arm32's: docs/aarch32-plan.md R5.1)
        # (upstream's timer, cache, debug and fpu tests are arm64's)
        set -- arm/selftest.flat arm/psci.flat arm/gic.flat arm/pmu.flat arm/pl031.flat arm/spinlock-test.flat arm/sieve.flat
    elif [ $# -eq 0 ]
    then
        set -- arm/selftest.flat arm/psci.flat arm/timer.flat arm/gic.flat arm/cache.flat arm/debug.flat \
            arm/fpu.flat arm/pl031.flat arm/spinlock-test.flat
    fi
    out="$src/../../build/kvm-unit-tests/$arch"
    mkdir -p "$out"
    out="$(cd "$out"; pwd)"
    cd "$out"
    rust_bin="$(rustc --print sysroot)/lib/rustlib/$(rustc -vV | sed -n 's/^host: //p')/bin"
    llvm="${LLVM_BIN:-$(dirname "$(command -v llvm-objcopy || echo /opt/homebrew/opt/llvm/bin/llvm-objcopy)")}"
    mkdir -p tools
    ln -sf "$rust_bin/rust-lld" tools/ld.lld
    if [ "$arch" = arm ]
    then
        cc="clang -target armv7a-unknown-linux-gnueabi --ld-path=$out/tools/ld.lld -Wno-unknown-warning-option -Wno-unused-command-line-argument"
        configure_args=(--arch=arm)
    else
        cc="clang -target aarch64-unknown-linux-gnu --ld-path=$out/tools/ld.lld -Wno-unknown-warning-option -Wno-unused-command-line-argument"
        configure_args=(--arch=arm64 --page-size="$page")
    fi
    if [ ! -f config.mak ]
    then
        # (upstream's configure insists on bash 4 but runs on macOS's 3.2)
        sed -e '/BASH_VERSINFO/,/^fi$/d' -e "s|^srcdir=.*|srcdir=\"$ksrc\"|" "$ksrc/configure" > configure
        bash ./configure "${configure_args[@]}" --cc="$cc" --ld="$out/tools/ld.lld" --disable-werror
    fi
    tools=(CC="$cc" LD="$out/tools/ld.lld" OBJCOPY="$llvm/llvm-objcopy" OBJDUMP="$llvm/llvm-objdump" READELF="$llvm/llvm-readelf" AR="$llvm/llvm-ar")
    # (the object directories: only `make all` creates them)
    make "${tools[@]}" directories
    make "${tools[@]}" "$@"
    exit 0
esac
if [ $# -eq 0 ]
then
    set -- x86/realmode.flat x86/taskswitch.flat x86/taskswitch2.flat
fi

out="$src/../../build/kvm-unit-tests/$arch"
mkdir -p "$out"
out="$(cd "$out"; pwd)"
cd "$out"

# the test code must not use SSE/MMX; warnings clang has about the library
# (lib/pci.c's constants) and x86/xsave.c's printf formats are not errors
flags="-std=gnu11 -mno-sse -mno-sse2 -mno-mmx -Wno-error=format -Wno-error=constant-conversion"

if [ "$(uname -s)" = Darwin ]
then
    # No Linux gcc on macOS: clang's <arch>-linux target, the lld and objcopy
    # that come with Rust, a GNU-format ar with an ELF symbol index (v86/ar.py)
    # and the 64-bit division helpers libgcc would provide (v86/builtins.c)
    rust_bin="$(rustc --print sysroot)/lib/rustlib/$(rustc -vV | sed -n 's/^host: //p')/bin"
    mkdir -p tools
    ln -sf "$rust_bin/rust-lld" tools/ld.lld
    target="$arch-unknown-linux-gnu"
    # -no-pie here, not only in CFLAGS: clang links PIE by default for Linux
    # targets and some link rules don't pass CFLAGS
    cc="clang -target $target --ld-path=$out/tools/ld.lld -no-pie -Wno-unknown-warning-option -Wno-unused-command-line-argument -Wno-varargs -Wno-error=unused-function"
    [ -f config.mak ] || "$src/configure" --arch="$arch" --cc="$cc" --ld="$out/tools/ld.lld"
    # an archive, like libgcc: link rules add both the *.o prerequisites and libgcc
    clang -target "$target" -ffreestanding -fno-pic -O2 $flags -c "$src/v86/builtins.c" -o builtins.o
    python3 "$src/v86/ar.py" rcs libbuiltins.a builtins.o
    tools=(CC="$cc $flags" OBJCOPY="$rust_bin/rust-objcopy" AR="python3 $src/v86/ar.py" libgcc="$out/libbuiltins.a")
    # the object directories (lib/x86, ...): only `make all` creates them
    make "${tools[@]}" directories
    # realmode.c relies on gcc's `asm(".code16gcc")`; clang needs -m16 for
    # 16-bit code, so that object is built first with bits=16
    for test in "$@"
    do
        if [ "$test" = x86/realmode.flat ]
        then
            make "${tools[@]}" bits=16 x86/realmode.o
        fi
    done
    make "${tools[@]}" "$@"
else
    [ -f config.mak ] || "$src/configure" --arch="$arch"
    # the object directories (lib/x86, ...): only `make all` creates them, and
    # gcc does not create the directory of a dependency file (-MF)
    make CC="gcc $flags" directories
    make CC="gcc $flags" "$@"
fi
