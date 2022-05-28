# Windows XP

Windows XP doesn't work out-of-the-box ([#86](https://github.com/copy/v86/issues/86)). However, there is a way to get Windows XP working.
1. Install XP in QEMU. Use `-enable-kvm` if you can, otherwise the install might take a long time.
3. Open Device Management (Use QEMU)
4. Select "Computer" > right-click > "Update Driver..."
5. Select "Install from a list or specific location (Advanced)" > "Don't search. I will choose the driver to install.". Then, click "Next".
7. Select "Standard PC".
8. Reboot your VM when prompted.
9. Once your VM reboots, shut down your VM and use it in v86.

Networking should work by default.

## Guest configuration


Memory | VGA memory
------ | ----------
512 MB | 8 MB
