FROM library/node:lts-bookworm

ARG DEBIAN_FRONTEND=noninteractive
RUN apt update && \
    apt-get install -y nodejs nasm gdb unzip p7zip-full openjdk-17-jre wget python3 qemu-system-x86 git-core build-essential libc6-dev-i386-cross libc6-dev-i386 clang curl time
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
RUN export PATH="$HOME/.cargo/bin:$PATH" && \
    rustup toolchain install stable && \
    rustup target add wasm32-unknown-unknown && \
    rustup component add rustfmt-preview
RUN wget -P images/ https://k.copy.sh/{linux.iso,linux4.iso,buildroot-bzimage.bin,openbsd-floppy.img,kolibri.img,windows101.img,os8.img,freedos722.img}
RUN npm install -g jshint
RUN rustup update && rustup update nightly
