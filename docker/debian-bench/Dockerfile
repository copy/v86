FROM i386/debian

ENV DEBIAN_FRONTEND noninteractive

RUN apt-get update && \
    apt-get --yes --no-install-recommends install \
        linux-image-4.9.0-6-686 systemd \
        gcc make libc6-dev \
        wget \
        file vim \
    && \
    apt-get --yes clean && \
    chsh -s /bin/bash && \
    echo "root:root" | chpasswd && \
    rm /etc/motd /etc/issue && \
    cd /root/ && \
    wget http://www.math.utah.edu/~mayer/linux/nbench-byte-2.2.3.tar.gz && \
    tar xfv nbench-byte-2.2.3.tar.gz && \
    rm nbench-byte-2.2.3.tar.gz && \
    mv nbench-byte-2.2.3 bench && \
    cd bench && \
    make

COPY getty-noclear.conf /etc/systemd/system/getty@tty1.service.d/noclear.conf
COPY getty-override.conf /etc/systemd/system/getty@tty1.service.d/override.conf
