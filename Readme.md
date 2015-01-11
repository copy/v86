
Demos 
-

- [Linux](http://copy.sh/v86/?profile=linux26)
- [KolibriOS](http://copy.sh/v86/?profile=kolibrios)
- [FreeDOS](http://copy.sh/v86/?profile=freedos)
- [Windows 1.01](http://copy.sh/v86/?profile=windows1)
- [Archlinux](http://copy.sh/v86/?profile=archlinux) (possibly unstable)


API examples
-

- [Basic](docs/samples/basic.html)
- [Programatically using the serial terminal](docs/samples/serial.html)
- [A LUA interpreter](docs/samples/lua.html)
- [Two instances in one window](docs/samples/two_instances.html)
- [Saving and restoring emulator state](docs/samples/save_restore.html)

Using v86 for your own purposes is as easy as:

```javascript
var emulator = new V86Starter({
    screen_container: document.getElementById("screen_container"),
    bios: {
        url: "../../bios/seabios.bin",
    },
    vga_bios: {
        url: "../../bios/vgabios.bin",
    },
    cdrom: {
        url: "../../images/linux.iso",
    },
    autostart: true,
});
```

See [API](docs/api.md).


How does it work?
-

v86 emulates an x86-compatible CPU and hardware. Here's a list of emulated hardware:

- An x86 compatible CPU. The instruction set is around Pentium 1 level. Some
  features are missing, more specifically:
  - Task gates, far calls in protected mode
  - 16 bit protected mode features
  - Single stepping
  - MMX, SSE
  - A bunch of FPU instructions
  - Some exceptions
- A floating point unit (FPU). Calculations are done with JavaScript's double
  precision numbers (64 bit), so they are not as precise as calculations on a
  real FPU (80 bit).
- A floppy disk controller (8272A).
- An 8042 Keyboard Controller, PS2. With mouse support.
- An 8254 Programmable Interval Timer (PIT).
- An 8259 Programmable Interrupt Controller (PIC).
- A CMOS Real Time Clock (RTC).
- A VGA controller with SVGA support and Bochs VBE Extensions.
- A PCI bus. This one is partly incomplete and not used by every device.
- An IDE disk controller.
- An NE2000 (8390) PCI network card.
- A virtio filesystem.


How to build, run and embed?
-

- In order to build the `cpu.js` file, you need `make` and `cpp` (the C preprocessor).
  Run: `make build/cpu.js`.
- If you want a compressed and fast (i.e. with debug code removed) version, you
  need Closure Compiler. Pull the submodule using 
  `git submodule update --init --recursive closure-compiler` and run `make build/v86_all.js`.
- ROM and disk images are loaded via XHR, so if you want to try out `index.html`
  locally, make sure to serve it from a local webserver. You can use `make run`
  to serve the files using Python's SimpleHTTPServer.
- If you want only want to embed v86 on website you can use libv86.js. For
  usage, check out the [API](docs/api.md) and [examples](docs/samples/).
- A couple of disk images are provided for testing. You can check them out
  using `git submodule update --init --recursive images`.


**Summary:**

```bash
git clone https://github.com/copy/v86.git                     # grab the main repo
cd v86
git submodule update --init --recursive images                # get the disk images
git submodule update --init --recursive closure-compiler      # fetch the disk images
```

Rebuild compiled version:

```
make
```

Rebuild only debug version (only necessary after changing `.macro.js` files):

```
make build/cpu.js
```


Why? 
- 

Similiar projects have been done before, but I decided to work on this as a fun
project and learn something about the x86 architecture. It has grown pretty
advanced and I got Linux and KolibriOS working, so there might be some actual
uses.

If you build something interesting, let me know.


Compatibility
-

Here's an overview of the operating systems supported in v86:

- Linux works pretty well. Graphical boot fails in many versions, but you
  mostly get a shell. The mouse is often not detected automatically.
  - Damn Small Linux (2.4 Kernel): Run with `lowram` and choose PS2 mouse in
    xsetup. Takes circa 10 minutes to boot.
  - Tinycore (3.0 kernel): `udev` and `X` fail, but you get a
    terminal.
  - Nanolinux works.
  - Archlinux works. Add `atkbd` to `MODULES` in `/etc/mkinitcpio.conf`.
- FreeDOS and Windows 1.01 run very well. 
- KolibriOS works. A few applications need SSE.
- Haiku boots, but takes very long (around 30 minutes). Set the memory size to 128MB.
- ReactOS doesn't work.
- No Android version seems to work, you still get a shell.

You can get some infos on the disk images here: https://github.com/copy/images.


How can I contribute?
-

- Add new features (hardware devices, fill holes in the CPU), fix bugs. Check
  out the issues section and contact me if you need help.
- Report bugs.
- Donate. Via Bitcoin:
  [`14KBXSoewGzbQY8VoznJ5MZXGxoia8RxC9`](https://blockchain.info/address/14KBXSoewGzbQY8VoznJ5MZXGxoia8RxC9).
  If you want to donate elsewhere, let me know.

License
-

Simplified BSD License, see [LICENSE](LICENSE), unless otherwise noted.


Credits
-

- Test cases via QEMU, http://wiki.qemu.org/Main_Page 
- [Disk Images](https://github.com/copy/images)
- [The jor1k project](https://github.com/s-macke/jor1k) for 9p and filesystem drivers


More questions?
-

Shoot me an email to `copy@copy.sh`. Please don't tell about bugs via mail,
create a bug report on GitHub instead.


Author
-

Fabian Hemmer (http://copy.sh/, `copy@copy.sh`)

