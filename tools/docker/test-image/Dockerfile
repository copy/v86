FROM ubuntu:21.04

RUN \
        export DEBIAN_FRONTEND=noninteractive && \
        dpkg --add-architecture i386 && \
        apt-get update -qq && \
        apt-get install -y nodejs nasm gdb unzip p7zip-full openjdk-8-jre wget python python3 qemu-system-x86 git-core build-essential libc6-dev-i386-cross libc6-dev-i386 clang curl time && \
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && \
        export PATH="$HOME/.cargo/bin:$PATH" && \
        rustup toolchain install stable && \
        rustup target add wasm32-unknown-unknown && \
        rustup component add rustfmt-preview
