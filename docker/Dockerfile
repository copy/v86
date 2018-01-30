FROM ttt43ttt/emscripten

RUN \
        dpkg --add-architecture i386 && \
        apt-get update -qq && \
        apt-get install -y gcc-multilib nasm gdb unzip openjdk-8-jre wget python && \
        wget https://nodejs.org/dist/v8.2.1/node-v8.2.1-linux-x64.tar.xz && \
        tar xfv node-v8.2.1-linux-x64.tar.xz
