(This document partly also applies to other Linuxes)

Choosing an installer ISO
-------------------------

The last ISO installer version of Archlinux that supports 32-bit is [2017.02.01](https://www.archlinux.org/releng/releases/2017.02.01/). Later versions of the archisos don't work on the v86 emulator because the installer only supports x86_64, not x86 anymore.  For existing Archlinux installations, updates and patches will be done until somewhere around 2018. 

In the future the community might come up with an alternative distribution based on Archlinux to maintain support for x86. At this point in time [archlinux32](https://mirror.archlinux32.org) seems to work.

Basic installation using QEMU
-----------------------

Installing Archlinux like this will result in a raw disk image that can be booted by v86.

```sh
# Create a 10 gigabyte disk image. If you intend to pacstrap only 'base' then 1.5G should be fine also.
qemu-img create arch.img 10G

# Follow the normal installation process (you can add accel=kvm if your system supports it to speed up the installation)
qemu-system-x86_64 -m 256 -drive file=arch.img,format=raw -cdrom archlinux-2017.02.01-dual.iso
```

For keyboard support it is necessary to open /etc/mkinitcpio.conf and edit the following line:

```sh
MODULES="atkbd i8042"
```

For the changes to take effect you need to regenerate the RAMdisk with `mkinitcpio -p linux`

The resulting `arch.img` is a bootable disk image for v86.

Scripting image creation for v86
--------------------------------

Installing the ISO by hand takes a long time if you intend to recreate the image many times. There are various reasons why you might want to do this more than once. For example: because the emulator is slow you might want to compile any new software release in QEMU which is much faster and then use the resulting image in v86 instead of making the emulator compile the software. Another reason is that the build progress potentially takes long and if you want to do automated builds in parallel to find out what configurations do and don't work you can just throw more computing power at the problem in order to solve it. This example requires that you have `packer`, `qemu` and `kpartx` installed.

### Creating a packer template

[Packer](https://www.packer.io/docs/builders/qemu.html) is a tool that lets you boot an ISO in any of multiple emulators (so QEMU in our case) and send pre-scripted keystrokes to bootstrap and SSH server. Once the SSH connection is established a script can be started for further provisioning. 

Create a template for automating the base installation
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
      "type": "qemu",
      "boot_command": [
        "<enter><wait10>",
        "dhcpcd<enter><wait10>",
	"usermod --password $(echo toor | openssl passwd -1 -stdin) root<enter><wait10>",
        "systemctl start sshd<enter>"
      ],
      "headless": true,
      "boot_wait": "10s",
      "disk_size": 1500,
      "disk_interface": "ide",
      "http_directory": "http",
      "iso_url": "https://mirror.archlinux32.org/archisos/archlinux-2017.04.01-i686.iso",
      "iso_checksum": "aa4718837c95e607233aecca43824c08c798b1a4",
      "iso_checksum_type": "sha1",
      "ssh_wait_timeout": "120s",
      "ssh_pty": true,
      "ssh_username": "root",
      "ssh_password": "toor",
      "ssh_port": 22,
      "format": "raw",
      "vm_name": "Archlinux-v86"
    }
  ]
}
EOF
```

You can tweak the options a bit to match your situation. For debugging you can set `headless` to `false`. That will show you the vnc instead of running the `boot_command` in the background. For a `base` pacstrap using a 1.5G disk should be sufficient. The `raw` disk format is important. v86 does not read qcow2 images, only raw disk images. If your system does not support kvm (the default accelerator), you can add `"accelerator": "none"` to the settings. Other accelerator options can be found [here](https://www.packer.io/docs/builders/qemu.html#accelerator).

After gaining SSH connectivity to the VM, packer will run the `scripts/provisioning.sh` script in the guest.

### Creating the Archlinux installation script

Create a script for your Archlinux installation. This runs in the ISO booted Archlinux environment, so you need to partition, pacstrap and install a bootloader.
```sh
mkdir -p packer/scripts
### Write your own or copy paste the example below
vim packer/scripts/provision.sh
```

An example script to install Archlinux with the root mounted using the 9p network filesystem:
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

# Install the Archlinux base system
echo "Performing pacstrap"
pacstrap -i /mnt base --noconfirm

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
sed -i 's/MODULES=""/MODULES="atkbd i8042 virtio_pci 9p 9pnet 9pnet_virtio"/g' /mnt/etc/mkinitcpio.conf

# Because we want to mount the root filesystem over the network during boot, we need to 
# hook into initcpio. If you do not want to mount the root filesystem during boot but
# only want to mount a 9p filesystem later, you can leave this out. Once the system
# has been booted you should be able to mount 9p filesystems with mount -t 9p host9p /blabla
# without this hook.
sed -i 's/fsck"/fsck 9p_root"/g' /mnt/etc/mkinitcpio.conf

echo "Writing the installation script"
cat << 'EOF' > /mnt/bootstrap.sh
#!/usr/bin/bash
echo "Re-generate initial ramdisk environment"
mkinitcpio -p linux

echo "Installing the grub package"
pacman -S os-prober grub --noconfirm

echo "Setting grub timeout to 0 seconds"
sed -i 's/GRUB_TIMEOUT=5/GRUB_TIMEOUT=0/g' /etc/default/grub

echo "Installing bootloader"
grub-install --target=i386-pc --recheck /dev/sda --force

echo "Writing grub config"
grub-mkconfig -o /boot/grub/grub.cfg
sync
EOF

echo "Chrooting and bootstrapping the installation"
arch-chroot /mnt bash bootstrap.sh

umount -R /mnt
```

With the packer template and the script you have enough to create an image that can be booted by v86. But because this example script installs an Archlinux that wants to mount root over the network with 9p, we need to host that filesystem first. If you do not want to use 9p, you can just run `(cd packer && packer build -force template.json)` to build the image.

### Creating the 9p filesystem

Now that we have an image that contains a filesystem, we can convert that filesystem into something we can host on the webserver together with the v86 library.

To do so, we need to mount the image once and create a json mapping of the filesystem. This can be done with the [fs2json](https://github.com/copy/fs2json) python script. 

Get the script: 
```sh
wget https://raw.githubusercontent.com/copy/fs2json/master/fs2json.py
```

The following script shows how to map the filesystem in an automated fashion.

Create a script to builds the image and then creates v86 compatible artifacts:
```sh
vim build.sh
```

Example script:

```sh
#!/bin/sh

# build the boxfile from the iso
(cd packer && packer build -force template.json)

# test if there is a boxfile where we expected it
if [ ! -f packer/output-qemu/Archlinux-v86 ]; then
    echo "Looks like something went wrong building the image, maybe try again?"
    exit 1
fi;

# clean up any previous loops and mounts
echo "Making sure mountpoint is empty"
sudo umount diskmount -f || /bin/true
sudo kpartx -d /dev/loop0 || /bin/true
sudo losetup -d /dev/loop0 || /bin/true

# mount the generated raw image, we do that so we can create 
# a json mapping of it and copy it to host on the webserver
mkdir -p diskmount
echo "Mounting the created image so we can convert it to a p9 image"
sudo losetup /dev/loop0 packer/output-qemu/Archlinux-v86
sudo kpartx -a /dev/loop0
sudo mount /dev/mapper/loop0p1 diskmount

# make images dir
mkdir -p output/images

# map the filesystem to json with fs2json
sudo python fs2json.py --exclude /boot/ --out output/images/fs.json diskmount

# copy the filesystem and chown to nonroot user
echo "Copying the filesystem to output/arch"
mkdir output/arch -p
sudo rsync -q -av diskmount/ output/arch
sudo chown -R $(whoami):$(whoami) output/arch

# clean up mount
echo "Cleaning up mounts"
sudo umount diskmount -f
sudo kpartx -d /dev/loop0
sudo losetup -d /dev/loop0

# Move the image to the images dir
mv packer/output-qemu/Archlinux-v86 output/images/arch.img
```

An example repository with these scripts can be found [here](https://github.com/vdloo/archlinux-v86-builder)

### Using the created artifacts in v86

Now that we have everything we need to host a server that serves an Archlinux environment over the network.

Create a checkout of v86 and run `make build/libv86.js`. Then edit `examples/arch.html` and replace the `hda` and `filesystem` section with something like this:
```sh
hda: {
    url: "http://localhost:8000/images/arch.img",
    async: true,  # For this option we need to run a webserver that supports the Range header
    size: 1.5 * 1024 * 1024 * 1024,  # This needs to be the size of the raw disk. 
    # See the `disk_size` item in the packer template.
},
filesystem: {
    baseurl: "http://localhost:8000/arch/",
    basefs: "http://localhost:8000/images/fs.json",
},
```

Then copy the created image, filesystem and json file to the v86 directory:
```sh
cp -f /your/packer/dir/output/images/arch.img /your/v86/dir/images/arch.img
cp -f /your/packer/dir/output/images/fs.json /your/v86/dir/images/fs.json
cp -r /your/pacher/dir/output/arch /your/v86/dir/
```

Next, we need a webserver that supports the Range header. For example [this extension of the SimpleHTTPServer](https://github.com/smgoller/rangehttpserver). 

```sh
cd /your/v86/dir
wget https://raw.githubusercontent.com/smgoller/rangehttpserver/master/RangeHTTPServer.py
python2 RangeHTTPServer.py
```

Now that the webserver is running, point your browser to `http://localhost:8000/examples/arch.html`. Wait for the Linux to boot. When the system is up, click 'Save state to file'. Your browser will download a `v86state.bin` file. Copy that file to `/your/v86/dir/images`. You can then edit `examples/arch.html` again and add a 'state' key to the `V86Starter` array.

```sh
initial_state: {
    "url": ""http://localhost:8000/images/v86state.bin,
},
```

If you refresh `http://localhost:8000/examples/arch.html` you will see that the state is restored instantly and all required files are loaded over the network on the fly.

### Networking

The emulator can emulate a network card. For more information [look at the networking documentation](https://github.com/copy/v86/blob/master/docs/networking.md). To set up networking in the VM, add the following item to the `V86Starter` array in the `examples/arch.html` file:
```sh
network_relay_url: "ws://localhost:8080/",
```

This will make the emulator try to connect to a [WebSockets proxy](https://github.com/benjamincburns/websockproxy). Running the proxy is very easy if you use the Docker container.

```sh
sudo docker run --privileged -p 8080:80 --name relay benjamincburns/jor1k-relay:latest
```

You can check if the relay is running correctly by going to `http://localhost:8080/` in your browser. There you should see a message that reads `Can "Upgrade" only to "Websocket".`.

Now you should be able to get network connectivity in the virtual machine. If you are restoring from a saved state, you might need to first run:
```sh
ip link set enp0s5 down
rmmod ne2k-pci
```

To bring the network up, run:
```sh
modprobe ne2k-pci
ip link set enp0s5 up
dhcpcd -w4 enp0s5
```

It might take a while for a carrier to become available on the interface. If the `dhcpcd` command fails shortly after booting, wait a bit and try again a bit later. If you are using the 9p network filesystem you can use the developer tools networking tab (in chrome) to get a sense of what is going on by looking at the files that are being downloaded.

When the network is up you should be able to curl a website. To check, run `curl icanhazip.com`. There you should see the public IP of the machine running the proxy.

You can't do inbound traffic into the VM with the websockproxy Docker container because it uses a basic NAT. To SSH into the VM running in the browser, you can create a reverse SSH tunnel to expose the SSH port of the sshd in the VM to the outside world.

```sh
# This will create a port 1122 on the example.com server 
# which forwards to the SSH in the VM
ssh root@example.com -R 1122:localhost:22
```

Now on the `example.com` server you should be able to SSH into your browser tab by running `ssh root@localhost -p 1122`.

