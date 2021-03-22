FROM ubuntu:20.04

RUN \
        export DEBIAN_FRONTEND=noninteractive && \
        dpkg --add-architecture i386 && \
        apt-get update -qq && \
        apt-get dist-upgrade -y
RUN \
        export DEBIAN_FRONTEND=noninteractive && \
        apt-get install -y nasm gdb unzip p7zip-full openjdk-8-jre wget python python3 qemu-system-x86 git-core build-essential libc6-dev-i386-cross libc6-dev-i386 clang curl
RUN \
        NODEVSN=v14.16.0 && \
        wget https://nodejs.org/dist/$NODEVSN/node-$NODEVSN-linux-x64.tar.xz && \
        tar xfv node-$NODEVSN-linux-x64.tar.xz && \
        rm node-$NODEVSN-linux-x64.tar.xz && \
        echo 'export PATH="$PATH:/node-$NODEVSN-linux-x64/bin"' >> ~/.bashrc && \
        wget https://sh.rustup.rs -O rustup.sh && \
        sh ./rustup.sh -y && \
        rm ./rustup.sh && \
        export PATH="$HOME/.cargo/bin:$PATH" && \
        rustup toolchain install nightly && \
        rustup default nightly && \
        rustup target add wasm32-unknown-unknown --toolchain nightly && \
        rustup component add rustfmt-preview --toolchain nightly
