FROM ubuntu:16.04 as ubuntu-blockchain
LABEL maintainer="Kris Henriksen"

ENV DEBIAN_FRONTEND noninteractive

RUN apt update && \
	apt --yes --no-install-recommends install \
		linux-image-virtual \
		grub2 \
		systemd \
		initramfs-tools \
		net-tools \
		iputils-ping \
	&& \
    chsh -s /bin/bash && \
    echo "root:root" | chpasswd && \
    mkdir -p /etc/systemd/system/serial-getty@ttyS0.service.d/ && \
    systemctl enable serial-getty@ttyS0.service && \
    rm /lib/systemd/system/getty.target.wants/getty-static.service && \
    rm /etc/issue && \
	chmod -x /etc/update-motd.d/* && \
	systemctl disable apt-daily-upgrade.timer && \
	systemctl mask apt-daily-upgrade.service && \
	systemctl disable apt-daily.timer && \
	systemctl mask apt-daily.service && \
    systemctl disable systemd-timesyncd.service && \
	systemctl mask systemd-timesyncd.service && \
	systemctl disable motd-news.timer && \
	systemctl mask motd-news.timer && \
    echo "tmpfs /tmp tmpfs nodev,nosuid 0 0" >> /etc/fstab

COPY getty-noclear.conf getty-override.conf /etc/systemd/system/getty@tty1.service.d/
COPY getty-autologin-serial.conf /etc/systemd/system/serial-getty@ttyS0.service.d/
COPY logind.conf /etc/systemd/
COPY boot-9p /etc/initramfs-tools/scripts/
COPY grub /etc/default/

COPY networking.sh /root/

# this needs to be commented out in order to boot from hdd
RUN printf '%s\n' 9p 9pnet 9pnet_virtio virtio virtio_ring virtio_pci | tee -a /etc/initramfs-tools/modules && \
    echo 'BOOT=boot-9p' | tee -a /etc/initramfs-tools/initramfs.conf && \
    update-initramfs -u

# ReducingDiskFootprint
RUN apt-get remove --purge perl && \
	apt-get autoremove --purge
RUN apt-get --yes clean && \
    rm -r /var/lib/apt/lists/* && \
    rm -r /usr/share/doc/* && \
    rm -r /usr/share/man/* && \
    rm -r /usr/share/locale/?? && \	
    rm /var/log/*.log /var/log/lastlog /var/log/wtmp /var/log/apt/*.log