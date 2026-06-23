FROM i386/debian:bookworm-slim

WORKDIR /root/build
ENV DEBIAN_FRONTEND=noninteractive

# Base Setup
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    linux-image-686 \
    systemd-sysv \
    locales \
    libterm-readline-perl-perl \
    && rm -rf /var/lib/apt/lists/*

RUN echo "en_US.UTF-8 UTF-8" >> /etc/locale.gen && \
    locale-gen && \
    echo 'LANG="en_US.UTF-8"' > /etc/default/locale && \
    chsh -s /bin/bash root  

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    xserver-xorg-core xserver-xorg-video-fbdev xinit \
    xfce4 xfce4-terminal \
    xserver-xorg-input-mouse xserver-xorg-input-kbd xserver-xorg-input-evdev \
    libxext6 libxrender1 libxtst6 libxi6 libx11-xcb1 libxrender-dev \
    libfontconfig1 fonts-dejavu-core adwaita-icon-theme fonts-wqy-microhei fonts-symbola \
    wget tar unzip ca-certificates xterm \
    xdg-utils shared-mime-info dbus-x11 desktop-base \
    thunar-archive-plugin xfce4-taskmanager ristretto \
    gvfs fonts-liberation xfce4-notifyd gvfs-backends \
    isc-dhcp-client iproute2 iputils-ping sudo \
    cmake git tmux mc htop vim nano p7zip-full geany mousepad atril engrampa curl build-essential \
    firefox-esr libreoffice thunar pavucontrol xfce4-screenshooter thunderbird gimp \
    && rm -rf /var/lib/apt/lists/*

# Configure Root and Standard User ('username')
RUN passwd -d root && \
    sed -i 's/nullok_secure/nullok/' /etc/pam.d/common-auth && \
    useradd -m -s /bin/bash username && \
    passwd -d username && \
    usermod -aG sudo,video,tty,input,dialout username && \
    echo "username ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

# Configure Serial Console Auto-login
COPY getty-noclear.conf getty-override.conf /etc/systemd/system/getty@tty1.service.d/
COPY getty-autologin-serial.conf /etc/systemd/system/serial-getty@ttyS0.service.d/

# Disable Unnecessary Services
RUN systemctl disable systemd-timesyncd.service && \
    systemctl disable apt-daily.timer && \
    systemctl disable apt-daily-upgrade.timer

# Configure X11, Networking, and Auto-start for 'username'
RUN echo '(sleep 5 && sudo bash -c "printf \"\\n\\nGUI_READY\\n\" > /dev/ttyS0") & \n\
exec startxfce4' > /home/username/.xinitrc

RUN { \
    echo 'if [ -z "$DISPLAY" ]; then'; \
    echo '  sudo bash -c "echo 127.0.0.1 localhost > /etc/hosts"'; \
    echo '  sudo bash -c "echo localhost > /etc/hostname"'; \
    echo '  sudo hostname localhost'; \
    echo '  startx -- -ac'; \
    echo 'fi'; \
} >> /home/username/.bashrc

RUN chown username:username /home/username/.xinitrc /home/username/.bashrc

# Force Xorg to use the FBDEV driver
RUN mkdir -p /etc/X11/xorg.conf.d && \
    echo 'Section "Device"\n\
    Identifier "Card0"\n\
    Driver "fbdev"\n\
EndSection' > /etc/X11/xorg.conf.d/10-fbdev.conf

WORKDIR /home/username