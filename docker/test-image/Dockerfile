FROM ttt43ttt/emscripten

RUN \
        dpkg --add-architecture i386 && \
        apt-get update -qq && \
        apt-get install -y clang-tidy gcc-multilib nasm gdb unzip openjdk-8-jre wget python python3 qemu-system-x86 && \
        wget https://nodejs.org/dist/v8.9.4/node-v8.9.4-linux-x64.tar.xz && \
        tar xfv node-v8.9.4-linux-x64.tar.xz && \
        rm node-v8.9.4-linux-x64.tar.xz && \
        wget https://sh.rustup.rs -O rustup.sh && \
        sh ./rustup.sh -y && \
        rm ./rustup.sh && \
        export PATH="$HOME/.cargo/bin:$PATH" && \
        rustup toolchain install nightly && \
        rustup default nightly && \
        rustup target add wasm32-unknown-unknown --toolchain nightly && \
        rustup component add rustfmt-preview --toolchain nightly
