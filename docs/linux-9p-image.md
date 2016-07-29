In order to create a Linux image that can mount the 9p file system, use add the following lines to the kernel config:

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
