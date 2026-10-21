// The old page's systems: ?profile=<id> (docs/vm-manager-plan.md, U0). The
// old page (Closure, in build/v86_all.js) and the VM manager (an ES module,
// outside Closure) both import this module, so it uses neither Closure's
// defines nor the emulator's internals (the plan's G5).

/**
 * The systems, their images on `host`
 * @param {string} host where the images are: "images/" on localhost, else
 *     "//i.copy.sh/", or the page's ?cdn=
 * @param {boolean} on_localhost the page is not copy.sh's (KolibriOS from its own builds there)
 * @return {!Array<!Object>}
 */
export function get_profiles(host, on_localhost)
{
    // Abandonware OS images are from https://winworldpc.com/library/operating-systems
    return [
        {
            id: "archlinux",
            name: "Arch Linux",
            memory_size: 512 * 1024 * 1024,
            vram_size: 8 * 1024 * 1024,
            state: { url: host + "arch_state-v3.bin.zst" },
            filesystem: {
                baseurl: host + "arch/",
            },
            net_device_type: "virtio",
        },
        {
            id: "archlinux-boot",
            name: "Arch Linux",
            memory_size: 512 * 1024 * 1024,
            vram_size: 8 * 1024 * 1024,
            filesystem: {
                baseurl: host + "arch/",
                basefs: { url: host + "fs.json" },
            },
            cmdline: [
                "rw apm=off vga=0x344 video=vesafb:ypan,vremap:8",
                "root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose",
                "mitigations=off audit=0",
                "init_on_free=on",
                "tsc=reliable",
                "random.trust_cpu=on",
                "nowatchdog",
                "init=/usr/bin/init-openrc net.ifnames=0 biosdevname=0",
            ].join(" "),
            bzimage_initrd_from_filesystem: true,
            net_device_type: "virtio",
        },
        {
            id: "copy/skiffos",
            name: "SkiffOS",
            cdrom: {
                url: host + "skiffos/.iso",
                size: 124672000,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            memory_size: 512 * 1024 * 1024,
        },
        {
            id: "serenity",
            name: "SerenityOS",
            hda: {
                url: host + "serenity-v3/.img.zst",
                size: 734003200,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            memory_size: 512 * 1024 * 1024,
            state: { url: host + "serenity_state-v4.bin.zst" },
            homepage: "https://serenityos.org/",
            mac_address_translation: true,
        },
        {
            id: "serenity-boot",
            name: "SerenityOS",
            hda: {
                url: host + "serenity-v3/.img.zst",
                size: 734003200,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            memory_size: 512 * 1024 * 1024,
            homepage: "https://serenityos.org/",
        },
        {
            id: "redox",
            name: "Redox",
            hda: {
                url: host + "redox_demo_i686_2024-09-07_1225_harddrive/.img",
                size: 671088640,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            memory_size: 1024 * 1024 * 1024,
            state: { url: host + "redox_state-v2.bin.zst" },
            homepage: "https://www.redox-os.org/",
            acpi: true,
        },
        {
            id: "redox-boot",
            name: "Redox",
            hda: {
                url: host + "redox_demo_i686_2024-09-07_1225_harddrive/.img",
                size: 671088640,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            memory_size: 1024 * 1024 * 1024,
            homepage: "https://www.redox-os.org/",
            acpi: true,
        },
        {
            id: "helenos",
            memory_size: 256 * 1024 * 1024,
            cdrom: {
                //url: host + "HelenOS-0.11.2-ia32.iso",
                //size: 25765888,
                url: host + "HelenOS-0.14.1-ia32.iso",
                size: 25792512,
                async: false,
            },
            name: "HelenOS",
            homepage: "http://www.helenos.org/",
        },
        {
            id: "fiwix",
            memory_size: 256 * 1024 * 1024,
            hda: {
                url: host + "FiwixOS-3.4-i386/.img",
                size: 1024 * 1024 * 1024,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            name: "FiwixOS",
            homepage: "https://www.fiwix.org/",
        },
        {
            id: "haiku",
            memory_size: 512 * 1024 * 1024,
            hda: {
                url: host + "haiku-v5/.img",
                size: 1342177280,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            state: { url: host + "haiku_state-v5.bin.zst" },
            name: "Haiku",
            homepage: "https://www.haiku-os.org/",
            acpi: true,
        },
        {
            id: "haiku-boot",
            memory_size: 512 * 1024 * 1024,
            hda: {
                url: host + "haiku-v5/.img",
                size: 1342177280,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            name: "Haiku",
            homepage: "https://www.haiku-os.org/",
            acpi: true,
        },
        {
            id: "beos",
            memory_size: 512 * 1024 * 1024,
            hda: {
                url: host + "beos5/.img",
                size: 536870912,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            name: "BeOS 5",
            // NOTE: segfaults if 256k bios is used
        },
        {
            id: "msdos",
            hda: {
                url: host + "msdos622/.img",
                size: 64 * 1024 * 1024,
                async: true,
                fixed_chunk_size: 256 * 1024,
                use_parts: true,
            },
            name: "MS-DOS 6.22",
        },
        {
            id: "msdos4",
            fda: {
                url: host + "msdos4.img",
                size: 1474560,
            },
            name: "MS-DOS 4",
        },
        {
            id: "freedos",
            fda: {
                url: host + "freedos722.img",
                size: 737280,
            },
            name: "FreeDOS",
        },
        {
            id: "doof",
            fda: {
                url: host + "doof-1440.img",
                size: 1474560,
            },
            name: "DOOF",
            homepage: "https://github.com/fragglet/squashware",
        },
        {
            id: "quantixos",
            cdrom: {
                url: host + "quantixos.iso",
                size: 11784192,
                async: false,
            },
            name: "QuantixOS",
            homepage: "https://github.com/MrGilli/QuantixOS",
        },
        {
            id: "chip4504",
            fda: {
                url: host + "chip4504.img",
                size: 1474560,
            },
            name: "Chip4504",
            homepage: "https://github.com/RelativisticMechanic/chip4504",
        },
        {
            id: "forthos",
            hda: {
                url: host + "forthos20.img.zst",
                size: 95420416,
                async: false,
            },
            memory_size: 128 * 1024 * 1024,
            name: "ForthOS",
            homepage: "http://sources.vsta.org/forthos/",
        },
        {
            id: "chimaeraos",
            hda: {
                url: host + "chimaeraos.img",
                size: 34120704,
                async: false,
            },
            name: "Chimaera OS",
            homepage: "https://chimaeraos.org/",
        },
        {
            id: "freegem",
            hda: {
                url: host + "freegem/.bin",
                size: 209715200,
                async: true,
                fixed_chunk_size: 256 * 1024,
                use_parts: true,
            },
            name: "Freedos with FreeGEM",
        },
        {
            id: "xcom",
            fda: {
                url: host + "xcom144.img",
                size: 1440 * 1024,
            },
            name: "Freedos with Xcom",
            homepage: "http://xcom.infora.hu/index.html",
        },
        {
            id: "psychdos",
            hda: {
                url: host + "psychdos/.img",
                size: 549453824,
                async: true,
                fixed_chunk_size: 256 * 1024,
                use_parts: true,
            },
            name: "PsychDOS",
            homepage: "https://psychoslinux.gitlab.io/DOS/INDEX.HTM",
        },
        {
            id: "86dos",
            fda: {
                url: host + "pc86dos.img",
                size: 163840,
            },
            name: "86-DOS",
            homepage: "https://www.os2museum.com/wp/pc-86-dos/",
        },
        {
            id: "oberon",
            hda: {
                url: host + "oberon.img",
                size: 24 * 1024 * 1024,
                async: false,
            },
            name: "Oberon",
        },
        {
            id: "gentleos16",
            fda: {
                url: host + "gentleos16-fd1440.img",
                size: 1474560,
            },
            name: "GentleOS/16",
            homepage: "https://github.com/luke8086/gentleos",
        },
        {
            id: "gentleos32",
            hda: {
                url: host + "gentleos32-disk.img",
                size: 8388608,
                async: false,
            },
            name: "GentleOS/32",
            homepage: "https://github.com/luke8086/gentleos32",
        },
        {
            id: "windows1",
            fda: {
                url: host + "windows101.img",
                size: 1474560,
            },
            name: "Windows 1.01",
        },
        {
            id: "windows2",
            hda: {
                url: host + "windows2.img",
                size: 4177920,
                async: false,
            },
            name: "Windows 2.03",
        },
        {
            id: "linux26",
            cdrom: {
                url: host + "linux.iso",
                size: 6547456,
                async: false,
            },
            name: "Linux",
        },
        {
            id: "linux3",
            cdrom: {
                url: host + "linux3.iso",
                size: 8638464,
                async: false,
            },
            name: "Linux",
        },
        {
            id: "linux4",
            cdrom: {
                url: host + "linux4.iso",
                size: 7731200,
                async: false,
            },
            name: "Linux",
            filesystem: {},
        },
        {
            id: "buildroot",
            bzimage: {
                url: host + "buildroot-bzimage.bin",
                size: 5166352,
                async: false,
            },
            name: "Buildroot Linux",
            filesystem: {},
            cmdline: "tsc=reliable mitigations=off random.trust_cpu=on",
            mouse_disabled_default: true,
        },
        {
            id: "buildroot6",
            bzimage: {
                url: host + "buildroot-bzimage68.bin",
                size: 10068480,
                async: false,
            },
            name: "Buildroot Linux 6.8",
            filesystem: {},
            cmdline: "tsc=reliable mitigations=off random.trust_cpu=on",
        },
        {
            id: "basiclinux",
            hda: {
                url: host + "bl3-5.img",
                size: 104857600,
                async: false,
            },
            name: "BasicLinux",
        },
        {
            id: "xpud",
            cdrom: {
                url: host + "xpud-0.9.2.iso",
                size: 67108864,
                async: false,
            },
            name: "xPUD",
            memory_size: 256 * 1024 * 1024,
        },
        {
            id: "elks",
            hda: {
                url: host + "elks-hd32-fat.img",
                size: 32514048,
                async: false,
            },
            name: "ELKS",
            homepage: "https://github.com/ghaerr/elks",
        },
        {
            id: "nodeos",
            bzimage: {
                url: host + "nodeos-kernel.bin",
                size: 14452000,
                async: false,
            },
            name: "NodeOS",
            cmdline: "tsc=reliable mitigations=off random.trust_cpu=on",
        },
        {
            id: "dsl",
            memory_size: 256 * 1024 * 1024,
            cdrom: {
                url: host + "dsl-4.11.rc2.iso",
                size: 52824064,
                async: false,
            },
            name: "Damn Small Linux",
            homepage: "http://www.damnsmalllinux.org/",
        },
        {
            id: "xwoaf",
            memory_size: 256 * 1024 * 1024,
            cdrom: {
                url: host + "xwoaf_rebuild4.iso",
                size: 2205696,
                async: false,
            },
            name: "xwoaf",
            homepage: "https://pupngo.dk/xwinflpy/xwoaf_rebuild.html",
        },
        {
            id: "minix",
            name: "Minix",
            memory_size: 256 * 1024 * 1024,
            cdrom: {
                url: host + "minix-3.3.0/.iso",
                size: 605581312,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            homepage: "https://www.minix3.org/",
        },
        {
            id: "unix-v7",
            name: "Unix V7",
            hda: {
                url: host + "unix-v7x86-0.8a/.img",
                size: 152764416,
                async: true,
                fixed_chunk_size: 256 * 1024,
                use_parts: true,
            },
        },
        {
            id: "kolibrios",
            fda: {
                url: on_localhost ?
                        host + "kolibri.img" :
                        "//builds.kolibrios.org/en_US/data/data/kolibri.img",
                size: 1474560,
            },
            name: "KolibriOS",
            homepage: "https://kolibrios.org/en/",
        },
        {
            id: "kolibrios-fallback",
            fda: {
                url: host + "kolibri.img",
                size: 1474560,
            },
            name: "KolibriOS",
        },
        {
            id: "mu",
            hda: {
                url: host + "mu-shell.img",
                size: 10321920,
                async: false,
            },
            memory_size: 256 * 1024 * 1024,
            name: "Mu",
            homepage: "https://github.com/akkartik/mu",
            mouse_disabled_default: true, // https://github.com/akkartik/mu/issues/52
        },
        {
            id: "openbsd",
            hda: {
                url: host + "openbsd/.img",
                size: 1073741824,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            state: { url: host + "openbsd_state-v2.bin.zst" },
            memory_size: 256 * 1024 * 1024,
            name: "OpenBSD",
        },
        {
            id: "sortix",
            cdrom: {
                url: host + "sortix-1.0-i686.iso",
                size: 71075840,
                async: false,
            },
            memory_size: 512 * 1024 * 1024,
            name: "Sortix",
        },
        {
            id: "openbsd-boot",
            hda: {
                url: host + "openbsd/.img",
                size: 1073741824,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            memory_size: 256 * 1024 * 1024,
            name: "OpenBSD",
            //acpi: true, // doesn't seem to work
        },
        {
            id: "netbsd",
            hda: {
                url: host + "netbsd/.img",
                size: 511000064,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            memory_size: 256 * 1024 * 1024,
            name: "NetBSD",
        },
        {
            id: "crazierl",
            multiboot: {
                url: host + "crazierl-elf-2026.img",
                size: 919492,
                async: false,
            },
            initrd: {
                url: host + "crazierl-initrd-2026.img",
                size: 20960021,
                async: false,
            },
            acpi: true,
            net_device_type: "virtio",
            cmdline: "kernel /libexec/ld-elf32.so.1",
            memory_size: 128 * 1024 * 1024,
            name: "Crazierl",
        },
        {
            id: "solos",
            fda: {
                url: host + "os8.img",
                size: 1474560,
            },
            name: "Sol OS",
            homepage: "http://oby.ro/os/",
        },
        {
            id: "bootchess",
            fda: {
                url: host + "bootchess.img",
                size: 1474560,
            },
            name: "BootChess",
            homepage: "http://www.pouet.net/prod.php?which=64962",
        },
        {
            id: "bootbasic",
            fda: {
                url: host + "bootbasic.img",
                size: 512,
            },
            name: "bootBASIC",
            homepage: "https://github.com/nanochess/bootBASIC",
        },
        {
            id: "bootlogo",
            fda: {
                url: host + "bootlogo.img",
                size: 512,
            },
            name: "bootLogo",
            homepage: "https://github.com/nanochess/bootLogo",
        },
        {
            id: "pillman",
            fda: {
                url: host + "pillman.img",
                size: 512,
            },
            name: "Pillman",
            homepage: "https://github.com/nanochess/Pillman",
        },
        {
            id: "invaders",
            fda: {
                url: host + "invaders.img",
                size: 512,
            },
            name: "Invaders",
            homepage: "https://github.com/nanochess/Invaders",
        },
        {
            id: "bootos",
            fda: {
                url: host + "bootos-all.img",
                size: 368640,
            },
            name: "bootOS",
            homepage: "https://github.com/nanochess/bootOS",
        },
        {
            id: "sectorlisp",
            fda: {
                url: host + "sectorlisp-friendly.bin",
                size: 512,
            },
            name: "SectorLISP",
            homepage: "https://justine.lol/sectorlisp2/",
        },
        {
            id: "sectorforth",
            fda: {
                url: host + "sectorforth.img",
                size: 512,
            },
            name: "sectorforth",
            homepage: "https://github.com/cesarblum/sectorforth",
        },
        {
            id: "floppybird",
            fda: {
                url: host + "floppybird.img",
                size: 1474560,
            },
            name: "Floppy Bird",
            homepage: "http://mihail.co/floppybird",
        },
        {
            id: "stillalive",
            fda: {
                url: host + "stillalive-os.img",
                size: 368640,
            },
            name: "Still Alive",
            homepage: "https://github.com/maniekx86/stillalive-os",
        },
        {
            id: "hello-v86",
            fda: {
                url: host + "hello-v86.img",
                size: 512,
            },
            name: "Hello v86",
        },
        {
            id: "tetros",
            fda: {
                url: host + "tetros.img",
                size: 512,
            },
            name: "TetrOS",
            homepage: "https://github.com/daniel-e/tetros",
        },
        {
            id: "dino",
            fda: {
                url: host + "bootdino.img",
                size: 512,
            },
            name: "dino",
            homepage: "https://github.com/franeklubi/dino",
        },
        {
            id: "bootrogue",
            fda: {
                url: host + "bootrogue.img",
                size: 512,
            },
            name: "bootRogue",
            homepage: "https://github.com/nanochess/bootRogue",
        },
        {
            id: "duskos",
            hda: {
                url: host + "duskos.img",
                async: false,
                size: 8388608,
            },
            name: "Dusk OS",
            homepage: "http://duskos.org/",
        },
        {
            id: "windows2000",
            memory_size: 512 * 1024 * 1024,
            hda: {
                url: host + "windows2k-v2/.img",
                size: 2 * 1024 * 1024 * 1024,
                async: true,
                fixed_chunk_size: 256 * 1024,
                use_parts: true,
            },
            name: "Windows 2000",
            state: { url: host + "windows2k_state-v4.bin.zst" },
            mac_address_translation: true,
        },
        {
            id: "windows2000-boot",
            memory_size: 512 * 1024 * 1024,
            hda: {
                url: host + "windows2k-v2/.img",
                size: 2 * 1024 * 1024 * 1024,
                async: true,
                fixed_chunk_size: 256 * 1024,
                use_parts: true,
            },
            name: "Windows 2000",
        },
        {
            id: "windows-me",
            memory_size: 256 * 1024 * 1024,
            hda: {
                url: host + "windowsme-v3/.img",
                size: 1073741824,
                async: true,
                fixed_chunk_size: 256 * 1024,
                use_parts: true,
            },
            state: { url: host + "windows-me_state-v3.bin.zst" },
            name: "Windows ME",
        },
        {
            id: "windowsnt4",
            memory_size: 512 * 1024 * 1024,
            hda: {
                url: host + "winnt4_noacpi/.img",
                size: 523837440,
                async: true,
                fixed_chunk_size: 256 * 1024,
                use_parts: true,
            },
            name: "Windows NT 4.0",
            cpuid_level: 2,
        },
        {
            id: "windowsnt35",
            memory_size: 256 * 1024 * 1024,
            hda: {
                url: host + "windowsnt351-v2/.img",
                size: 163577856,
                async: true,
                fixed_chunk_size: 256 * 1024,
                use_parts: true,
            },
            name: "Windows NT 3.51",
        },
        {
            id: "windowsnt3",
            memory_size: 256 * 1024 * 1024,
            hda: {
                url: host + "winnt31/.img",
                size: 87 * 1024 * 1024,
                async: true,
                fixed_chunk_size: 256 * 1024,
                use_parts: true,
            },
            name: "Windows NT 3.1",
        },
        {
            id: "windows98",
            memory_size: 128 * 1024 * 1024,
            hda: {
                url: host + "windows98/.img",
                size: 300 * 1024 * 1024,
                async: true,
                fixed_chunk_size: 256 * 1024,
                use_parts: true,
            },
            name: "Windows 98",
            state: { url: host + "windows98_state-v2.bin.zst" },
            mac_address_translation: true,
        },
        {
            id: "windows98-boot",
            memory_size: 128 * 1024 * 1024,
            hda: {
                url: host + "windows98/.img",
                size: 300 * 1024 * 1024,
                async: true,
                fixed_chunk_size: 256 * 1024,
                use_parts: true,
            },
            name: "Windows 98",
        },
        {
            id: "windows95",
            memory_size: 64 * 1024 * 1024,
            hda: {
                url: host + "windows95-v3/.img",
                size: 471859200,
                async: true,
                fixed_chunk_size: 256 * 1024,
                use_parts: true,
            },
            name: "Windows 95",
        },
        {
            id: "windows95-boot",
            memory_size: 64 * 1024 * 1024,
            hda: {
                url: host + "windows95-v3/.img",
                size: 471859200,
                async: true,
                fixed_chunk_size: 256 * 1024,
                use_parts: true,
            },
            name: "Windows 95",
        },
        {
            id: "windows30-old",
            memory_size: 64 * 1024 * 1024,
            cdrom: {
                url: host + "Win30.iso",
                size: 7774208,
                async: false,
            },
            name: "Windows 3.0",
        },
        {
            id: "windows30",
            memory_size: 128 * 1024 * 1024,
            hda: {
                url: host + "windows30.img",
                size: 25165824,
                async: false,
            },
            name: "Windows 3.0",
        },
        {
            id: "windows31",
            memory_size: 64 * 1024 * 1024,
            hda: {
                url: host + "win31.img",
                async: false,
                size: 34463744,
            },
            name: "Windows 3.1",
        },
        {
            id: "tilck",
            memory_size: 128 * 1024 * 1024,
            hda: {
                url: host + "tilck.img",
                async: false,
                size: 37748736,
            },
            name: "Tilck",
            homepage: "https://github.com/vvaltchev/tilck",
        },
        {
            id: "littlekernel",
            multiboot: {
                url: host + "littlekernel-multiboot.img",
                async: false,
                size: 969580,
            },
            name: "Little Kernel",
            homepage: "https://github.com/littlekernel/lk",
        },
        {
            id: "sanos",
            memory_size: 128 * 1024 * 1024,
            hda: {
                url: host + "sanos-flp.img",
                async: false,
                size: 1474560,
            },
            name: "Sanos",
            homepage: "http://www.jbox.dk/sanos/",
        },
        {
            id: "386bsd",
            memory_size: 64 * 1024 * 1024,
            hda: {
                url: host + "386bsd/.img",
                size: 536870912,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            name: "386BSD",
            homepage: "https://en.wikipedia.org/wiki/386BSD",
        },
        {
            id: "freebsd",
            memory_size: 256 * 1024 * 1024,
            hda: {
                url: host + "freebsd/.img",
                size: 2147483648,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            state: { url: host + "freebsd_state-v2.bin.zst" },
            name: "FreeBSD",
        },
        {
            id: "freebsd-boot",
            memory_size: 256 * 1024 * 1024,
            hda: {
                url: host + "freebsd/.img",
                size: 2147483648,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            name: "FreeBSD",
        },
        {
            id: "reactos",
            memory_size: 512 * 1024 * 1024,
            hda: {
                url: host + "reactos-v3/.img",
                size: 734003200,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            state: { url: host + "reactos_state-v3.bin.zst" },
            mac_address_translation: true,
            name: "ReactOS",
            acpi: true,
            net_device_type: "virtio",
            homepage: "https://reactos.org/",
        },
        {
            id: "reactos-boot",
            memory_size: 512 * 1024 * 1024,
            hda: {
                url: host + "reactos-v2/.img",
                size: 681574400,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            name: "ReactOS",
            acpi: true,
            homepage: "https://reactos.org/",
        },
        {
            id: "skift",
            cdrom: {
                url: host + "skift-20200910.iso",
                size: 64452608,
                async: false,
            },
            name: "Skift",
            homepage: "https://skiftos.org/",
        },
        {
            id: "snowdrop",
            fda: {
                url: host + "snowdrop.img",
                size: 1440 * 1024,
            },
            name: "Snowdrop",
            homepage: "http://www.sebastianmihai.com/snowdrop/",
        },
        {
            id: "openwrt",
            hda: {
                url: host + "openwrt-18.06.1-x86-legacy-combined-squashfs.img",
                size: 19846474,
                async: false,
            },
            name: "OpenWrt",
        },
        {
            id: "qnx",
            fda: {
                url: host + "qnx-demo-network-4.05.img",
                size: 1474560,
            },
            name: "QNX 4.05",
        },
        {
            id: "9front",
            memory_size: 128 * 1024 * 1024,
            hda: {
                url: host + "9front-10931.386/.iso",
                size: 489453568,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            state: { url: host + "9front_state-v3.bin.zst" },
            acpi: true,
            name: "9front",
            homepage: "https://9front.org/",
        },
        {
            id: "9front-boot",
            memory_size: 128 * 1024 * 1024,
            hda: {
                url: host + "9front-10931.386/.iso",
                size: 489453568,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            acpi: true,
            name: "9front",
            homepage: "https://9front.org/",
        },
        {
            id: "9legacy",
            memory_size: 512 * 1024 * 1024,
            hda: {
                url: host + "9legacy.img",
                async: false,
                size: 16000000,
            },
            name: "9legacy",
            homepage: "http://www.9legacy.org/",
            //net_device_type: "none",
        },
        {
            id: "mobius",
            fda: {
                url: host + "mobius-fd-release5.img",
                size: 1474560,
            },
            name: "Mobius",
        },
        {
            id: "android",
            memory_size: 512 * 1024 * 1024,
            cdrom: {
                url: host + "android-x86-1.6-r2/.iso",
                size: 54661120,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            name: "Android",
        },
        {
            id: "android4",
            memory_size: 512 * 1024 * 1024,
            cdrom: {
                url: host + "android_x86_nonsse3_4.4r1_20140904/.iso",
                size: 247463936,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            name: "Android 4",
        },
        {
            id: "tinycore",
            memory_size: 256 * 1024 * 1024,
            hda: {
                url: host + "TinyCore-11.0.iso",
                size: 19922944,
                async: false,
            },
            name: "Tinycore",
            homepage: "http://www.tinycorelinux.net/",
        },
        {
            id: "slitaz",
            memory_size: 512 * 1024 * 1024,
            hda: {
                url: host + "slitaz-rolling-2024.iso",
                size: 56573952,
                async: false,
            },
            name: "SliTaz",
            homepage: "https://slitaz.org/",
        },
        {
            id: "freenos",
            memory_size: 256 * 1024 * 1024,
            cdrom: {
                url: host + "FreeNOS-1.0.3.iso",
                async: false,
                size: 11014144,
            },
            name: "FreeNOS",
            acpi: true,
            homepage: "http://www.freenos.org/",
        },
        {
            id: "syllable",
            memory_size: 512 * 1024 * 1024,
            hda: {
                url: host + "syllable-destop-0.6.7/.img",
                async: true,
                size: 500 * 1024 * 1024,
                fixed_chunk_size: 512 * 1024,
                use_parts: true,
            },
            name: "Syllable",
            homepage: "http://syllable.metaproject.frl/",
        },
        {
            id: "toaruos",
            memory_size: 512 * 1024 * 1024,
            cdrom: {
                url: host + "toaruos-1.6.1-core.iso",
                size: 67567616,
                async: false,
            },
            name: "ToaruOS",
            acpi: true,
            homepage: "https://toaruos.org/",
        },
        {
            id: "nopeos",
            cdrom: {
                url: host + "nopeos-0.1.iso",
                size: 532480,
                async: false,
            },
            name: "Nope OS",
            homepage: "https://github.com/d99kris/nopeos",
        },
        {
            id: "soso",
            cdrom: {
                url: host + "soso.iso",
                size: 22546432,
                async: false,
            },
            name: "Soso",
            homepage: "https://github.com/ozkl/soso",
        },
        {
            id: "pcmos",
            fda: {
                url: host + "PCMOS386-9-user-patched.img",
                size: 1440 * 1024,
            },
            name: "PC-MOS/386",
            homepage: "https://github.com/roelandjansen/pcmos386v501",
        },
        {
            id: "jx",
            fda: {
                url: host + "jx-demo.img",
                size: 1440 * 1024,
            },
            name: "JX",
            homepage: "https://www4.cs.fau.de/Projects/JX/index.html",
        },
        {
            id: "house",
            fda: {
                url: host + "hOp-0.8.img",
                size: 1440 * 1024,
            },
            name: "House",
            homepage: "https://programatica.cs.pdx.edu/House/",
        },
        {
            id: "bleskos",
            name: "BleskOS",
            cdrom: {
                url: host + "bleskos_2024u32.iso",
                size: 1835008,
                async: false,
            },
            homepage: "https://github.com/VendelinSlezak/BleskOS",
        },
        {
            id: "boneos",
            name: "BoneOS",
            cdrom: {
                url: host + "BoneOS.iso",
                size: 11429888,
                async: false,
            },
            homepage: "https://amanuel.io/projects/BoneOS/",
        },
        {
            id: "mikeos",
            name: "MikeOS",
            cdrom: {
                url: host + "mikeos.iso",
                size: 3311616,
                async: false,
            },
            homepage: "https://mikeos.sourceforge.net/",
        },
        {
            id: "bluejay",
            name: "Blue Jay",
            fda: {
                url: host + "bj050.img",
                size: 1474560,
            },
            homepage: "https://archiveos.org/blue-jay/",
        },
        {
            id: "t3xforth",
            name: "T3XFORTH",
            fda: {
                url: host + "t3xforth.img",
                size: 1474560,
            },
            homepage: "https://t3x.org/t3xforth/",
        },
        {
            id: "nanoshell",
            name: "NanoShell",
            cdrom: {
                url: host + "nanoshell.iso",
                size: 6785024,
                async: false,
            },
            homepage: "https://github.com/iProgramMC/NanoShellOS",
        },
        {
            id: "catk",
            name: "CatK",
            cdrom: {
                url: host + "catkernel.iso",
                size: 11968512,
                async: false,
            },
            homepage: "https://catk.neocities.org/",
        },
        {
            id: "mcp",
            name: "M/CP",
            fda: {
                url: host + "mcp2.img",
                size: 512,
            },
            homepage: "https://github.com/ybuzoku/MCP",
        },
        {
            id: "ibm-exploring",
            name: "Exploring The IBM Personal Computer",
            fda: {
                url: host + "ibm-exploring.img",
                size: 368640,
            },
        },
        {
            id: "leetos",
            name: "lEEt/OS",
            fda: {
                url: host + "leetos.img",
                size: 1474560,
            },
            homepage: "http://sininenankka.dy.fi/leetos/index.php",
        },
        {
            id: "newos",
            name: "NewOS",
            fda: {
                url: host + "newos-flp.img",
                size: 1474560,
                async: false,
            },
            homepage: "https://newos.org/",
        },
        {
            id: "newos-notion",
            hda: {
                url: host + "newos-notion.img",
                size: 4128768,
                async: false,
            },
            memory_size: 128 * 1024 * 1024,
            name: "NewOS Notion",
            homepage: "http://notion.muelln-kommune.net/newos.html",
        },
        {
            id: "aros-broadway",
            name: "AROS Broadway",
            memory_size: 512 * 1024 * 1024,
            cdrom: {
                url: host + "broadway10/.iso",
                size: 742051840,
                async: true,
                fixed_chunk_size: 512 * 1024,
                use_parts: true,
            },
            homepage: "https://web.archive.org/web/20231109224346/http://www.aros-broadway.de/",
        },
        {
            id: "icaros",
            name: "Icaros Desktop",
            memory_size: 512 * 1024 * 1024,
            cdrom: {
                url: host + "icaros-pc-i386-2.3/.iso",
                size: 726511616,
                async: true,
                // NOTE: needs 136MB/287 requests to boot, maybe state image or zst parts?
                fixed_chunk_size: 512 * 1024,
                use_parts: true,
            },
            homepage: "http://vmwaros.blogspot.com/",
        },
        {
            id: "tinyaros",
            name: "Tiny Aros",
            memory_size: 512 * 1024 * 1024,
            cdrom: {
                url: host + "tinyaros-pc-i386/.iso",
                size: 111175680,
                async: true,
                fixed_chunk_size: 512 * 1024,
                use_parts: true,
            },
            homepage: "https://www.tinyaros.it/",
        },
        {
            id: "dancy",
            name: "Dancy",
            cdrom: {
                url: host + "dancy.iso",
                size: 10485760,
                async: false,
            },
            homepage: "https://github.com/Tiihala/Dancy",
        },
        {
            id: "curios",
            name: "CuriOS",
            hda: {
                url: host + "curios.img",
                size: 83886080,
                async: false,
            },
            homepage: "https://github.com/h5n1xp/CuriOS",
        },
        {
            id: "os64",
            name: "OS64",
            cdrom: {
                url: host + "os64boot.iso",
                size: 5580800,
                async: false,
            },
            homepage: "https://os64.blogspot.com/",
        },
        {
            id: "ipxe",
            name: "iPXE",
            cdrom: {
                url: host + "ipxe.iso",
                size: 4194304,
                async: false,
            },
            homepage: "https://ipxe.org/",
        },
        {
            id: "netboot.xyz",
            name: "netboot.xyz",
            cdrom: {
                url: host + "netboot.xyz.iso",
                size: 2398208,
                async: false,
            },
            homepage: "https://netboot.xyz/",
            net_device_type: "virtio",
        },
        {
            id: "squeaknos",
            name: "SqueakNOS",
            cdrom: {
                url: host + "SqueakNOS.iso",
                size: 61171712,
                async: false,
            },
            memory_size: 512 * 1024 * 1024,
            homepage: "https://squeaknos.blogspot.com/"
        },
        {
            id: "chokanji4",
            name: "Chokanji 4",
            hda: {
                url: host + "chokanji4/.img.zst",
                size: 10737418240,
                async: true,
                fixed_chunk_size: 256 * 1024,
                use_parts: true,
            },
            memory_size: 512 * 1024 * 1024,
            homepage: "https://archive.org/details/brightv4000"
        },
        {
            id: "archhurd",
            name: "Arch Hurd",
            hda: {
                url: host + "archhurd-2018.09.28/.img.zst",
                size: 4294967296,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            memory_size: 512 * 1024 * 1024,
            homepage: "https://archhurd.org/",
        },
        {
            id: "prettyos",
            name: "PrettyOS",
            fda: {
                url: host + "prettyos.img",
                size: 1474560,
                async: false,
            },
            homepage: "https://www.prettyos.de/Image.html",
        },
        {
            id: "vanadium",
            name: "Vanadium OS",
            cdrom: {
                url: host + "vanadiumos.iso",
                size: 8388608,
                async: false,
            },
            homepage: "https://www.durlej.net/software.html",
        },
        {
            id: "xenus",
            name: "XENUS",
            hda: {
                url: host + "xenushdd.img",
                size: 52428800,
                async: false,
            },
            homepage: "https://www.durlej.net/xenus/",
        },
        {
            id: "mojo",
            name: "Mojo OS",
            cdrom: {
                url: host + "mojo-0.2.2.iso",
                size: 4048896,
                async: false,
            },
            homepage: "https://archiveos.org/mojoos/",
        },
        {
            id: "bsdos",
            memory_size: 128 * 1024 * 1024,
            name: "BSD/OS",
            hda: {
                url: host + "bsdos43/.img.zst",
                size: 1024 * 1024 * 1024,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            state: { url: host + "bsdos43_state.bin" },
            homepage: "https://en.wikipedia.org/wiki/BSD/OS",
        },
        {
            id: "bsdos-boot",
            memory_size: 128 * 1024 * 1024,
            name: "BSD/OS",
            hda: {
                url: host + "bsdos43/.img.zst",
                size: 1024 * 1024 * 1024,
                async: true,
                fixed_chunk_size: 1024 * 1024,
                use_parts: true,
            },
            homepage: "https://en.wikipedia.org/wiki/BSD/OS",
        },
        {
            id: "asuro",
            name: "Asuro",
            cdrom: {
                url: host + "asuro.iso",
                size: 5361664,
                async: false,
            },
            homepage: "https://asuro.xyz/",
        },
    ];
}

/**
 * ?profile=<user>/<name>: an image someone uploaded to the experimental
 * server for user images (its profile.json); undefined for other ids
 * @param {?string} id
 * @return {string|undefined} the profile's base URL
 */
export function user_profile_base(id)
{
    return id && /^[a-zA-Z0-9\-_]+\/[a-zA-Z0-9\-_]+$/.test(id) ? "https://v86-user-images.b-cdn.net/" + id : undefined;
}

/**
 * The profile of a user image's profile.json (its names as the server writes them)
 * @param {string} base
 * @param {!Object} p
 * @return {!Object}
 */
export function user_profile(base, p)
{
    function handle_image(o)
    {
        return o && { url: base + "/" + o["url"], async: o["async"], size: o["size"] };
    }

    return {
        id: p["id"],
        name: p["name"],
        memory_size: p["memory_size"],
        graphics_adapter: p["graphics_adapter"],
        vram_size: p["vram_size"] || p["vga_memory_size"],
        acpi: p["acpi"],
        boot_order: p["boot_order"],
        hda: handle_image(p["hda"]),
        cdrom: handle_image(p["cdrom"]),
        fda: handle_image(p["fda"]),
        multiboot: handle_image(p["multiboot"]),
        bzimage: handle_image(p["bzimage"]),
        initrd: handle_image(p["initrd"]),
    };
}
