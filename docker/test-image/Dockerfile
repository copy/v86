FROM ttt43ttt/emscripten

RUN \
        dpkg --add-architecture i386 && \
        apt-get update -qq && \
        apt-get install -y clang-tidy gcc-multilib nasm gdb unzip openjdk-8-jre wget python qemu-system-x86 && \
        wget https://nodejs.org/dist/v8.9.4/node-v8.9.4-linux-x64.tar.xz && \
        tar xfv node-v8.9.4-linux-x64.tar.xz && \
        rm node-v8.9.4-linux-x64.tar.xz
