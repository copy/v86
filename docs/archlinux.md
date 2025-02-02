See [Alpine setup](../tools/docker/alpine/Readme.md) for a more reliable and
faster way to automatically build Linux images for v86.

(This document partly also applies to other Linuxes)

Choosing an installer ISO
-------------------------

Download Arch Linux 32 from  https://archlinux32.org.

Basic installation using QEMU
-----------------------

Installing Arch Linux with these instructions will result in a raw disk image that can be booted by v86.

```sh
# fetch archlinux32 installer
wget https://mirror.archlinux32.org/archisos/archlinux32-2021.12.01-i686.iso

# Create a 10 gigabyte disk image. If you intend to pacstrap only 'base' then 1.5G should be fine also.
qemu-img create arch.img 10G

# Follow the normal installation process (you can add accel=kvm if your system supports it to speed up the installation)
qemu-system-x86_64 -m 256 -drive file=arch.img,format=raw -cdrom archlinux32-2021.12.01-i686.iso
```

For keyboard support, it is necessary to open /etc/mkinitcpio.conf and edit the following line:

```sh
MODULES="atkbd i8042"
```

For the changes to take effect, you need to regenerate the initial ramdisk with `mkinitcpio -p linux`

The resulting `arch.img` file is a bootable disk image for v86.

Scripting image creation for v86
--------------------------------

Installing the ISO by hand takes a long time if you intend to recreate the image many times. There are various reasons why you might want to do this more than once. For example: because the emulator is slow you might want to compile any new software release in QEMU which is much faster and then use the resulting image in v86 instead of making the emulator compile the software. Another reason is that the build progress potentially takes long and if you want to do automated builds in parallel to find out what configurations do and don't work you can just throw more computing power at the problem in order to solve it. This example requires that you have `packer`, `qemu` and `kpartx` installed.

### Creating a packer template

[Packer](https://www.packer.io/docs/builders/qemu.html) is a tool that lets you boot an ISO in any of multiple emulators (so QEMU in our case) and send pre-scripted keystrokes to bootstrap an SSH server. Once the SSH connection is established a script can be started for further provisioning.

Create a template for automating the base installation:
```sh
mkdir -p packer
cat > packer/template.json << 'EOF'
{
  "provisioners": [
    {
      "type": "shell",
      "override": {
        "qemu": {
          "scripts": ["scripts/provision.sh"]
        }
      }
    }
  ],
  "builders": [
    {
      "accelerator": "kvm",
      "type": "qemu",
      "boot_command": [
        "<enter><wait30><enteropenssl passwd help<wait10>",
        "dhcpcd<enter><wait5>",
        "echo root:root | chpasswd<enter><wait5>",
        "systemctl start sshd<enter>"
      ],
      "headless": true,
      "boot_wait": "10s",
      "disk_size": 1500,
      "disk_interface": "ide",
      "iso_url": "https://mirror.archlinux32.org/archisos/archlinux32-2021.12.01-i686.iso",
      "iso_checksum": "90c6f5aecb095d5578f6c9970539da7c5e9324ec",
      "iso_checksum_type": "sha1",
      "ssh_wait_timeout": "120s",
      "ssh_pty": true,
      "ssh_username": "root",
      "ssh_password": "root",
      "ssh_port": 22,
      "format": "raw",
      "vm_name": "archlinux",
      "disk_detect_zeroes": "unmap",
      "memory": 2048,
      "vnc_bind_address": "0.0.0.0"
    }
  ]
}
EOF
```

You can tweak the options a bit to match your situation. For debugging, you can set `headless` to `false`. That will show you the VNC connection instead of running the `boot_command` in the background. For a `base` pacstrap, using a 2 GB disk image should be sufficient. The `raw` disk format is important. v86 does not read qcow2 images, only raw disk images. If your system does not support KVM (the default accelerator), you can change `"accelerator": "none"` to the settings, in macos you may use `"accelerator": "hvf"`. Other accelerator options can be found [here](https://www.packer.io/docs/builders/qemu.html#accelerator).

After gaining SSH connectivity to the VM, packer will run the `scripts/provisioning.sh` script in the guest.

### Creating the Arch Linux installation script

Create a script for your Arch Linux installation. This runs in the live Arch Linux environment, so you need to partition the disk, do a pacstrap, and install a bootloader.
```sh
mkdir -p packer/scripts
### Write your own or copy paste the example below
vim packer/scripts/provision.sh
```

An example script to install Arch Linux with the root mounted using the 9p network filesystem:
```sh
#!/bin/bash
echo "Creating a GPT partition on /dev/sda1"
echo -e "g\nn\n\n\n\nw" | fdisk /dev/sda

# In case you might want to create a DOS partition instead. It doesn't really matter.
#echo "Creating a DOS partition on /dev/sda1"
#echo -e "o\nn\np\n1\n\n\nw" | fdisk /dev/sda

echo "Formatting /dev/sda1 to ext4"
mkfs -t ext4 /dev/sda1

echo "Mounting new filesystem"
mount -t ext4 /dev/sda1 /mnt

echo "Create pacman package cache dir"
mkdir -p /mnt/var/cache/pacman/pkg

# We don't want the pacman cache to fill up the image. After reboot whatever tarballs pacman has cached are gone.
echo "Mount the package cache dir in memory so it doesn't fill up the image"
mount -t tmpfs none /mnt/var/cache/pacman/pkg

echo "Updating archlinux-keyring"
pacman -Sy archlinux-keyring --noconfirm

# uncomment to remove signing if unable to resolve signing errors
sed -i 's/SigLevel.*/SigLevel = Never/g' /etc/pacman.conf

# Install the Arch Linux base system, feel free to add packages you need here
echo "Performing pacstrap"
pacstrap -i /mnt base linux dhcpcd curl openssh --noconfirm

echo "Writing fstab"
genfstab -p /mnt >> /mnt/etc/fstab

# When the Linux boots we want it to automatically log in on tty1 as root
echo "Ensuring root autologin on tty1"
mkdir -p /mnt/etc/systemd/system/getty@tty1.service.d
cat << 'EOF' > /mnt/etc/systemd/system/getty@tty1.service.d/override.conf
[Service]
ExecStart=
ExecStart=-/usr/bin/agetty --autologin root --noclear %I $TERM
EOF

# This is the tricky part. The current root will be mounted on /dev/sda1 but after we reboot
# it will try to mount root during boot using the 9p network filesystem. This means the emulator
# will request all files over the network using XMLHttpRequests from the server. This is great
# because then you only need to provide the client with a saved state (the memory) and the
# session will start instantly and load needed files on the fly. This is fast and it saves bandwidth.
echo "Ensuring root is remounted using 9p after reboot"
mkdir -p /mnt/etc/initcpio/hooks
cat << 'EOF' > /mnt/etc/initcpio/hooks/9p_root
run_hook() {
    mount_handler="mount_9p_root"
}

mount_9p_root() {
    msg ":: mounting '$root' on real root (9p)"
    # Note the host9p. We won't mount /dev/sda1 on root anymore,
    # instead we mount the network filesystem and the emulator will
    # retrieve the files on the fly.
    if ! mount -t 9p host9p "$1"; then
        echo "You are now being dropped into an emergency shell."
        launch_interactive_shell
        msg "Trying to continue (this will most likely fail) ..."
    fi
}
EOF

echo "Adding initcpio build hook for 9p root remount"
mkdir -p /mnt/etc/initcpio/install
cat << 'EOF' > /mnt/etc/initcpio/install/9p_root
#!/bin/bash
build() {
	add_runscript
}
EOF

# We need to load some modules into the kernel for it to play nice with the emulator
# The atkbd and i8042 modules are for keyboard input in the browser. If you do not
# want to use the network filesystem you only need these. The 9p, 9pnet and 9pnet_virtio
# modules are needed for being able to mount 9p network filesystems using the emulator.
echo "Configure mkinitcpio for 9p"
sed -i 's/MODULES=()/MODULES=(atkbd i8042 libps2 serio serio_raw psmouse virtio_pci virtio_pci_modern_dev 9p 9pnet 9pnet_virtio fscache netfs)/g' /mnt/etc/mkinitcpio.conf

# Because we want to mount the root filesystem over the network during boot, we need to
# hook into initcpio. If you do not want to mount the root filesystem during boot but
# only want to mount a 9p filesystem later, you can leave this out. Once the system
# has been booted you should be able to mount 9p filesystems with mount -t 9p host9p /blabla
# without this hook.
sed -i 's/fsck"/fsck 9p_root"/g' /mnt/etc/mkinitcpio.conf

# enable ssh password auth and root login
sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/g' /etc/ssh/sshd_config
sed -i 's/#PasswordAuthentication.*/PasswordAuthentication yes/g' /etc/ssh/sshd_config

echo "Writing the installation script"
cat << 'EOF' > /mnt/bootstrap.sh
#!/usr/bin/bash
echo "Re-generate initial ramdisk environment"
mkinitcpio -p linux

# uncomment to remove signing if you are unable to resolve signing errors otherwise
sed -i 's/SigLevel.*/SigLevel = Never/g' /etc/pacman.conf

pacman -S --noconfirm syslinux gptfdisk
syslinux-install_update -i -a -m

# disabling ldconfig to speed up boot (to remove Rebuild dynamic linker cache...)
# you may want to comment this out
echo "Disabling ldconfig service"
systemctl mask ldconfig.service

sync
EOF

echo "Chrooting and bootstrapping the installation"
arch-chroot /mnt bash bootstrap.sh


cat << 'EOF' > /mnt/boot/syslinux/syslinux.cfg
# Config file for Syslinux -
# /boot/syslinux/syslinux.cfg
#
# Comboot modules:
#   * menu.c32 - provides a text menu
#   * vesamenu.c32 - provides a graphical menu
#   * chain.c32 - chainload MBRs, partition boot sectors, Windows bootloaders
#   * hdt.c32 - hardware detection tool
#   * reboot.c32 - reboots the system
#
# To Use: Copy the respective files from /usr/lib/syslinux to /boot/syslinux.
# If /usr and /boot are on the same file system, symlink the files instead
# of copying them.
#
# If you do not use a menu, a 'boot:' prompt will be shown and the system
# will boot automatically after 5 seconds.
#
# Please review the wiki: https://wiki.archlinux.org/index.php/Syslinux
# The wiki provides further configuration examples

DEFAULT arch
PROMPT 0        # Set to 1 if you always want to display the boot: prompt
TIMEOUT 100

# Menu Configuration
# Either menu.c32 or vesamenu32.c32 must be copied to /boot/syslinux
UI menu.c32
#UI vesamenu.c32

# Refer to http://syslinux.zytor.com/wiki/index.php/Doc/menu
MENU TITLE Arch Linux
#MENU BACKGROUND splash.png
MENU COLOR border       30;44   #40ffffff #a0000000 std
MENU COLOR title        1;36;44 #9033ccff #a0000000 std
MENU COLOR sel          7;37;40 #e0ffffff #20ffffff all
MENU COLOR unsel        37;44   #50ffffff #a0000000 std
MENU COLOR help         37;40   #c0ffffff #a0000000 std
MENU COLOR timeout_msg  37;40   #80ffffff #00000000 std
MENU COLOR timeout      1;37;40 #c0ffffff #00000000 std
MENU COLOR msg07        37;40   #90ffffff #a0000000 std
MENU COLOR tabmsg       31;40   #30ffffff #00000000 std

# boot sections follow
#
# TIP: If you want a 1024x768 framebuffer, add "vga=773" to your kernel line.
#
#-*

LABEL arch
    MENU LABEL Arch Linux 9p
    LINUX ../vmlinuz-linux
    APPEND root=/dev/sda1 rw quiet
    INITRD ../initramfs-linux.img

LABEL arch2
    MENU LABEL Arch Linux Disk
    LINUX ../vmlinuz-linux
    APPEND root=/dev/sda1 rw quiet disablehooks=9p_root
    INITRD ../initramfs-linux.img

LABEL hdt
        MENU LABEL HDT (Hardware Detection Tool)
        COM32 hdt.c32

LABEL reboot
        MENU LABEL Reboot
        COM32 reboot.c32

LABEL poweroff
        MENU LABEL Poweroff
        COM32 poweroff.c32
EOF
umount -R /mnt
```

With the packer template and the script you have enough to create an image that can be booted by v86. But because this example script installs an Arch Linux that wants to mount root over the network with 9p, we need to host that filesystem first. If you do not want to use 9p, you can just run `(cd packer && packer build -force template.json)` to build the image.

### Creating the 9p filesystem

Now that we have an image that contains a filesystem, we can convert that filesystem into something we can host on the webserver together with the v86 library.

To do so, we need to mount the image once and create a json mapping of the filesystem. The following script shows how to map the filesystem in an automated fashion.

Create a script to builds the image and then creates v86 compatible artifacts:
```sh
vim build.sh
```

Example script:

```sh
#!/bin/sh

SRC=packer
TARGET=output

# build the boxfile from the iso
(cd $SRC && sudo PACKER_LOG=1 PACKER_LOG_PATH="./packer.log" packer build -force template.json)

# test if there is a boxfile where we expected it
if [ ! -f $SRC/output-qemu/archlinux ]; then
    echo "Looks like something went wrong building the image, maybe try again?"
    exit 1
fi;

# clean up any previous loops and mounts
echo "Making sure mountpoint is empty"
LOOP_DEV=$(sudo losetup -f)

sudo umount diskmount -f || /bin/true
sudo kpartx -d $LOOP_DEV || /bin/true
sudo losetup -d $LOOP_DEV || /bin/true

# mount the generated raw image, we do that so we can create
# a json mapping of it and copy it to host on the webserver
mkdir -p diskmount
echo "Mounting the created image so we can convert it to a p9 image"
sudo losetup $LOOP_DEV $SRC/output-qemu/archlinux
sudo kpartx -a $LOOP_DEV
sudo mount /dev/mapper/$(basename $LOOP_DEV)p1 diskmount

# make images dir
mkdir -p $TARGET
mkdir -p $TARGET/images
mkdir -p $TARGET/images/arch

# map the filesystem to json with fs2json
sudo ./tools/fs2json.py --out $TARGET/images/fs.json diskmount
sudo ./tools/copy-to-sha256.py diskmount $TARGET/images/arch

# copy the filesystem and chown to nonroot user
echo "Copying the filesystem to $TARGET/arch"
mkdir $TARGET/arch -p
sudo rsync -q -av diskmount/ $TARGET/arch
sudo chown -R $(whoami):$(whoami) $TARGET/arch

# clean up mount
echo "Cleaning up mounts"
sudo umount diskmount -f
sudo kpartx -d $LOOP_DEV
sudo losetup -d $LOOP_DEV

# Move the image to the images dir
sudo mv $SRC/output-qemu/archlinux $TARGET/images/arch.img
```

Given that the packer template and provision.sh is rooted at `packer` (adjust the value of `$SRC` otherwise), run the `build.sh` at root of your `v86` repo:

```
chmod +x build.sh
./build.sh
```

Generated artifacts are now available for serving from `output`.

### Using the created artifacts in v86

Now that we have everything we need to host a server that serves an Arch Linux environment over the network.

Create a checkout of v86 and run `make build/libv86.js`.
We can then edit `examples/arch.html`, we have two options:

1. Boot Arch Linux from the 9p filesystem (generated .bin artifacts at `/output/images/arch`):

  ```sh
  filesystem: {
    baseurl: "../output/images/arch/",
    basefs: "../output/images/fs.json",
  },

  bzimage_initrd_from_filesystem: true,

  cmdline: [
    "rw",
    "root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose",
  ].join(" "),

  acpi: false,
  autostart: true,
  ```
2. Boot the Arch Linux from the qemu raw disk image:

  ```sh
  hda: {
      url: "../output/images/arch.img",
      # set to true if you want to load it asynchrously during runtime (for this option we need to run a webserver that supports the Range header)
      # NOTE: async: false is slow but proved to be more realiable
      async: false,

      # This needs to be the size of the raw disk.
      size: 1.5 * 1024 * 1024 * 1024,
      # See the `disk_size` item in the packer template.
  },

  acpi: false,
  autostart: true,
  ```

Next, we need a webserver that supports the Range header. For example [this extension of the SimpleHTTPServer](https://github.com/smgoller/rangehttpserver). At your `v86` root, run:

```sh
wget https://raw.githubusercontent.com/smgoller/rangehttpserver/master/RangeHTTPServer.py
python2 RangeHTTPServer.py
```

Now that the webserver is running, point your browser to `http://localhost:8000/examples/arch.html`. Wait for the Linux to boot. When the system is up, click 'Save state to file'. Your browser will download a `v86state.bin` file. Copy that file to `/your/v86/dir/images`. You can then edit `examples/arch.html` again and add a 'state' key to the `V86` array.

```sh
initial_state: {
    "url": "http://localhost:8000/images/v86state.bin",
},
```

If you refresh `http://localhost:8000/examples/arch.html` you will see that the state is restored instantly and all required files are loaded over the network on the fly.

### Networking

The emulator can emulate a network card. For more information [look at the networking documentation](https://github.com/copy/v86/blob/master/docs/networking.md). To set up networking in the VM, add the following item to the `V86` array in the `examples/arch.html` file:
```sh
network_relay_url: "ws://localhost:8080/",
```

This will make the emulator try to connect to a [WebSockets proxy](https://github.com/benjamincburns/websockproxy). Running the proxy is very easy if you use the Docker container.

```sh
sudo docker run --privileged -p 8080:80 --name relay bennottelling/websockproxy
```
**NOTE:** original `benjamincburns/jor1k-relay:latest` has throttling built-in by default which will degrade the networking. `bennottelling/websockproxy` has this throttling removed via [websockproxy/issues/4#issuecomment-317255890](https://github.com/benjamincburns/websockproxy/issues/4#issuecomment-317255890).

You can check if the relay is running correctly by going to `http://localhost:8080/` in your browser. There you should see a message that reads `Can "Upgrade" only to "Websocket".`.

Now you should be able to get network connectivity in the virtual machine. If you are restoring from a saved state, you might need to first run:
```sh
ip link set enp0s5 down
rmmod ne2k-pci
```

To bring the network up, run:
```sh
modprobe ne2k-pci
dhcpcd -w4 enp0s5
```

It might take a while for a carrier to become available on the interface. If the `dhcpcd` command fails shortly after booting, wait a bit and try again a bit later. If you are using the 9p network filesystem you can use the developer tools networking tab (in chrome) to get a sense of what is going on by looking at the files that are being downloaded.

When the network is up you should be able to curl a website. To check, run `curl icanhazip.com`. There you should see the public IP of the machine running the proxy.

You can't do inbound traffic into the VM with the websockproxy Docker container because it uses a basic NAT. To SSH into the VM running in the browser, you can create a reverse SSH tunnel to expose the SSH port of the sshd in the VM to the outside world. You may need to start `sshd` first, it may also be reasonable to change root password:

```sh
passwd root
systemctl start sshd
```

then create a reverse SSH tunnel:

```sh
# This will create a port 1122 on the example.com server
# which forwards to the SSH in the VM
ssh root@example.com -R 1122:localhost:22
```

Now on the `example.com` server you should be able to SSH into your browser tab by running `ssh root@localhost -p 1122`.
