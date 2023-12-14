In order to create a Linux image that can mount the 9p file system, add the following lines to the kernel configuration:

```
CONFIG_NET_9P=y
CONFIG_NET_9P_VIRTIO=y
CONFIG_NET_9P_DEBUG=y
CONFIG_VIRTIO=y
CONFIG_VIRTIO_PCI=y
CONFIG_9P_FS=y
CONFIG_9P_FSCACHE=y
CONFIG_9P_FS_POSIX_ACL=y
```

A Dockerfile for this build is here: https://github.com/ysangkok/build-v86-9p-linux

Using initcpio
--------------

This allows you to remount the root file system using 9p. No changes are necessary if you only want to mount a 9p filesystem after booting.

Add the following files:

`/etc/initcpio/hooks/9p_root`

```bash
#!/usr/bin/bash

run_hook() {
    mount_handler="mount_9p_root"
}

mount_9p_root() {
    msg ":: mounting '$root' on real root (9p)"
    if ! mount -t 9p host9p "$1"; then
        echo "You are now being dropped into an emergency shell."
        launch_interactive_shell
        msg "Trying to continue (this will most likely fail) ..."
    fi
}
```

<hr>

`/etc/initcpio/install/9p_root`

```bash
#!/bin/bash
build() {
	add_runscript
}
```

Change the following options in `/etc/mkinitcpio.conf`:

```bash
MODULES="virtio_pci 9p 9pnet 9pnet_virtio"
HOOKS="base udev autodetect modconf block filesystems keyboard fsck 9p_root" # appended 9p_root
```
