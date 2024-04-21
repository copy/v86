FROM i386/alpine:3.18.6

ENV KERNEL=lts
ENV HOSTNAME=localhost
ENV ROOT_PASSWORD='root'
ENV ADDPKGS=''

RUN apk add openrc \ 
            alpine-base \
            agetty \
            alpine-conf \ 
            $ADDPKGS

# Install mkinitfs from edge (todo: remove this when 3.19+ has worked properly with 9pfs)
RUN apk add mkinitfs --no-cache --allow-untrusted --repository https://dl-cdn.alpinelinux.org/alpine/edge/main/ 

RUN if [ "$KERNEL" == "lts" ]; then \
    apk add linux-lts \
            linux-firmware-none \
            linux-firmware-sb16; \
else \
    apk add linux-$KERNEL; \
fi

RUN sed -i 's/getty 38400 tty1/agetty --autologin root tty1 linux/' /etc/inittab && \
    echo "root:$ROOT_PASSWORD" | chpasswd

RUN setup-hostname $HOSTNAME

# Adding networking.sh script (works only on lts kernel yet)
RUN if [ "$KERNEL" == "lts" ]; then \ 
    echo -e "rmmod ne2k-pci && modprobe ne2k-pci\nhwclock -s\nsetup-interfaces -a -r" > /root/networking.sh && \ 
    chmod +x /root/networking.sh; \ 
fi

# https://wiki.alpinelinux.org/wiki/Alpine_Linux_in_a_chroot#Preparing_init_services
RUN for i in devfs dmesg mdev hwdrivers; do rc-update add $i sysinit; done
RUN for i in hwclock modules sysctl hostname syslog bootmisc; do rc-update add $i boot; done
RUN rc-update add killprocs shutdown

# Generate initramfs with 9p modules
RUN mkinitfs -F "ata base ide scsi virtio ext4 9p" $(cat /usr/share/kernel/$KERNEL/kernel.release)