"use strict";

(function()
{
    const ON_LOCALHOST = !location.hostname.endsWith("copy.sh");

    const DEFAULT_NETWORKING_PROXIES = ["wss://relay.widgetry.org/", "ws://localhost:8080/"];
    const DEFAULT_MEMORY_SIZE = 128;
    const DEFAULT_VGA_MEMORY_SIZE = 8;
    const DEFAULT_BOOT_ORDER = 0;

    function set_title(text)
    {
        document.title = text + " - v86" +  (DEBUG ? " - debug" : "");
        const description = document.querySelector("meta[name=description]");
        description && (description.content = "Running " + text);
    }

    function bool_arg(x)
    {
        return !!x && x !== "0";
    }

    function format_timestamp(time)
    {
        if(time < 60)
        {
            return time + "s";
        }
        else if(time < 3600)
        {
            return (time / 60 | 0) + "m " + v86util.pad0(time % 60, 2) + "s";
        }
        else
        {
            return (time / 3600 | 0) + "h " +
                v86util.pad0((time / 60 | 0) % 60, 2) + "m " +
                v86util.pad0(time % 60, 2) + "s";
        }
    }

    let progress_ticks = 0;

    function show_progress(e)
    {
        const el = $("loading");
        el.style.display = "block";

        if(e.file_name.endsWith(".wasm"))
        {
            const parts = e.file_name.split("/");
            el.textContent = "Fetching " + parts[parts.length - 1] + " ...";
            return;
        }

        if(e.file_index === e.file_count - 1 && e.loaded >= e.total - 2048)
        {
            // last file is (almost) loaded
            el.textContent = "Done downloading. Starting now ...";
            return;
        }

        let line = "Downloading images ";

        if(typeof e.file_index === "number" && e.file_count)
        {
            line += "[" + (e.file_index + 1) + "/" + e.file_count + "] ";
        }

        if(e.total && typeof e.loaded === "number")
        {
            var per100 = Math.floor(e.loaded / e.total * 100);
            per100 = Math.min(100, Math.max(0, per100));

            var per50 = Math.floor(per100 / 2);

            line += per100 + "% [";
            line += "#".repeat(per50);
            line += " ".repeat(50 - per50) + "]";
        }
        else
        {
            line += ".".repeat(progress_ticks++ % 50);
        }

        el.textContent = line;
    }

    function $(id)
    {
        return document.getElementById(id);
    }

    // These values were previously stored in localStorage
    const elements_to_restore = [
        "memory_size",
        "video_memory_size",
        "networking_proxy",
        "disable_audio",
        "enable_acpi",
        "boot_order",
    ];
    for(const item of elements_to_restore)
    {
        try
        {
            window.localStorage.removeItem(item);
        }
        catch(e) {}
    }

    function onload()
    {
        if(!window.WebAssembly)
        {
            alert("Your browser is not supported because it doesn't support WebAssembly");
            return;
        }

        $("start_emulation").onclick = function(e)
        {
            start_emulation(null, null);
            $("start_emulation").blur();
            e.preventDefault();
        };

        if(DEBUG)
        {
            debug_onload();
        }

        if(DEBUG && ON_LOCALHOST)
        {
            // don't use online relay in debug mode
            $("relay_url").value = "ws://localhost:8080/";
        }

        const query_args = new URLSearchParams(location.search);
        const host = query_args.get("cdn") || (ON_LOCALHOST ? "images/" : "//i.copy.sh/");

        // Abandonware OS images are from https://winworldpc.com/library/operating-systems
        const oses = [
            {
                id: "archlinux",
                name: "Arch Linux",
                memory_size: 512 * 1024 * 1024,
                vga_memory_size: 8 * 1024 * 1024,
                state: { url: host + "arch_state-v2.bin.zst" },
                filesystem: {
                    baseurl: host + "arch/",
                },
                net_device_type: "virtio",
            },
            {
                id: "archlinux-boot",
                name: "Arch Linux",
                memory_size: 512 * 1024 * 1024,
                vga_memory_size: 8 * 1024 * 1024,
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
                    url: host + "FiwixOS-3.3-i386/.img",
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
                    url: host + "haiku-v4/.img",
                    size: 1 * 1024 * 1024 * 1024,
                    async: true,
                    fixed_chunk_size: 1024 * 1024,
                    use_parts: true,
                },
                state: { url: host + "haiku_state-v4.bin.zst" },
                name: "Haiku",
                homepage: "https://www.haiku-os.org/",
            },
            {
                id: "haiku-boot",
                memory_size: 512 * 1024 * 1024,
                hda: {
                    url: host + "haiku-v4/.img",
                    size: 1 * 1024 * 1024 * 1024,
                    async: true,
                    fixed_chunk_size: 1024 * 1024,
                    use_parts: true,
                },
                name: "Haiku",
                homepage: "https://www.haiku-os.org/",
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
                    url: ON_LOCALHOST ?
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
                state: { url: host + "openbsd_state.bin.zst" },
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
                    url: host + "crazierl-elf.img",
                    size: 896592,
                    async: false,
                },
                initrd: {
                    url: host + "crazierl-initrd.img",
                    size: 18448316,
                    async: false,
                },
                acpi: true,
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
                    url: host + "windows2k/.img",
                    size: 2 * 1024 * 1024 * 1024,
                    async: true,
                    fixed_chunk_size: 256 * 1024,
                    use_parts: true,
                },
                name: "Windows 2000",
                state: { url: host + "windows2k_state-v2.bin.zst" },
                mac_address_translation: true,
            },
            {
                id: "windows2000-boot",
                memory_size: 512 * 1024 * 1024,
                hda: {
                    url: host + "windows2k/.img",
                    size: 2 * 1024 * 1024 * 1024,
                    async: true,
                    fixed_chunk_size: 256 * 1024,
                    use_parts: true,
                },
                name: "Windows 2000",
            },
            {
                id: "windows-me",
                memory_size: 128 * 1024 * 1024,
                hda: {
                    url: host + "windowsme/.img",
                    size: 834666496,
                    async: true,
                    fixed_chunk_size: 256 * 1024,
                    use_parts: true,
                },
                state: { url: host + "windows-me_state.bin.zst" },
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
                state: { url: host + "windows98_state.bin.zst" },
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
                // old image:
                //memory_size: 32 * 1024 * 1024,
                //hda: {
                //    url: host + "w95/.img",
                //    size: 242049024,
                //    async: true,
                //    fixed_chunk_size: 256 * 1024,
                //    use_parts: true,
                //},
                //state: { url: host + "windows95_state.bin.zst" },
                hda: {
                    url: host + "windows95-v2/.img",
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
                    url: host + "windows95-v2/.img",
                    size: 471859200,
                    async: true,
                    fixed_chunk_size: 256 * 1024,
                    use_parts: true,
                },
                name: "Windows 95",
            },
            {
                id: "windows30",
                memory_size: 64 * 1024 * 1024,
                cdrom: {
                    url: host + "Win30.iso",
                    size: 7774208,
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
                id: "freebsd",
                memory_size: 256 * 1024 * 1024,
                hda: {
                    url: host + "freebsd/.img",
                    size: 2147483648,
                    async: true,
                    fixed_chunk_size: 1024 * 1024,
                    use_parts: true,
                },
                state: { url: host + "freebsd_state.bin.zst" },
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
                    url: host + "reactos-v2/.img",
                    size: 681574400,
                    async: true,
                    fixed_chunk_size: 1024 * 1024,
                    use_parts: true,
                },
                state: { url: host + "reactos_state-v2.bin.zst" },
                mac_address_translation: true,
                name: "ReactOS",
                acpi: true,
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
                    url: host + "9front-8963.f84cf1e60427675514fb056cc1723e45da01e043.386/.iso",
                    size: 477452288,
                    async: true,
                    fixed_chunk_size: 1024 * 1024,
                    use_parts: true,
                },
                state: { url: host + "9front_state-v2.bin.zst" },
                acpi: true,
                name: "9front",
                homepage: "https://9front.org/",
            },
            {
                id: "9front-boot",
                memory_size: 128 * 1024 * 1024,
                hda: {
                    url: host + "9front-8963.f84cf1e60427675514fb056cc1723e45da01e043.386/.iso",
                    size: 477452288,
                    async: true,
                    fixed_chunk_size: 1024 * 1024,
                    use_parts: true,
                },
                acpi: true,
                name: "9front",
                homepage: "https://9front.org/",
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
        ];

        if(DEBUG)
        {
            // see tests/kvm-unit-tests/x86/
            const tests = [
                "realmode",
                // All tests below require an APIC
                "cmpxchg8b",
                "port80",
                "setjmp",
                "sieve",
                "hypercall", // crashes
                "init", // stops execution
                "msr", // TODO: Expects 64 bit msrs
                "smap", // test stops, SMAP not enabled
                "tsc_adjust", // TODO: IA32_TSC_ADJUST
                "tsc", // TODO: rdtscp
                "rmap_chain", // crashes
                "memory", // missing mfence (uninteresting)
                "taskswitch", // TODO: Jump
                "taskswitch2", // TODO: Call TSS
                "eventinj", // Missing #nt
                "ioapic",
                "apic",
            ];

            for(const test of tests)
            {
                oses.push({
                    name: "Test case: " + test,
                    id: "test-" + test,
                    memory_size: 128 * 1024 * 1024,
                    multiboot: { url: "tests/kvm-unit-tests/x86/" + test + ".flat" }
                });
            }
        }

        const profile = query_args.get("profile");

        if(!profile && !DEBUG)
        {
            const link = document.createElement("link");
            link.rel = "prefetch";
            link.href = "build/v86.wasm";
            document.head.appendChild(link);
        }

        const link = document.createElement("link");
        link.rel = "prefetch";
        link.href = "build/xterm.js";
        document.head.appendChild(link);

        for(const os of oses)
        {
            if(profile === os.id)
            {
                start_emulation(os, query_args);
                return;
            }

            const element = $("start_" + os.id);

            if(element)
            {
                element.onclick = e =>
                {
                    if(!e.ctrlKey)
                    {
                        e.preventDefault();
                        element.blur();
                        start_emulation(os, null);
                    }
                };
            }
        }

        if(profile === "custom")
        {
            // TODO: if one of the file form fields has a value (firefox), start here?

            if(query_args.has("hda.url") || query_args.has("cdrom.url") || query_args.has("fda.url"))
            {
                start_emulation(null, query_args);
            }
            else
            {
                if(query_args.has("m")) $("memory_size").value = query_args.get("m");
                if(query_args.has("vram")) $("vga_memory_size").value = query_args.get("vram");
                if(query_args.has("relay_url")) $("relay_url").value = query_args.get("relay_url");
                if(query_args.has("mute")) $("disable_audio").checked = bool_arg(query_args.get("mute"));
                if(query_args.has("acpi")) $("acpi").checked = bool_arg(query_args.get("acpi"));
                if(query_args.has("boot_order")) $("boot_order").value = query_args.get("boot_order");
            }
        }
        else if(/^[a-zA-Z0-9\-_]+\/[a-zA-Z0-9\-_]+$/g.test(profile))
        {
            // experimental: server that allows user-uploaded images

            const base = "https://v86-user-images.b-cdn.net/" + profile;

            fetch(base + "/profile.json")
                .catch(e => alert("Profile not found: " + profile))
                .then(response => response.json())
                .then(p => {
                    function handle_image(o)
                    {
                        return o && { url: base + "/" + o["url"], async: o["async"], size: o["size"] };
                    }

                    const profile = {
                        id: p["id"],
                        name: p["name"],
                        memory_size: p["memory_size"],
                        vga_memory_size: p["vga_memory_size"],
                        acpi: p["acpi"],
                        boot_order: p["boot_order"],
                        hda: handle_image(p["hda"]),
                        cdrom: handle_image(p["cdrom"]),
                        fda: handle_image(p["fda"]),
                        multiboot: handle_image(p["multiboot"]),
                        bzimage: handle_image(p["bzimage"]),
                        initrd: handle_image(p["initrd"]),
                    };

                    start_emulation(profile, query_args);
                });
        }

        const os_info = Array.from(document.querySelectorAll("#oses tbody tr")).map(element =>
        {
            const [_, size_raw, unit] = element.children[1].textContent.match(/([\d\.]+)\+? (\w+)/);
            let size = +size_raw;
            if(unit === "MB") size *= 1024 * 1024;
            else if(unit === "KB") size *= 1024;
            return {
                element,
                size,
                graphical: element.children[2].firstChild.className === "gui_icon",
                family: element.children[3].textContent.replace(/-like/, ""),
                arch: element.children[4].textContent,
                status: element.children[5].textContent,
                source: element.children[6].textContent,
                languages: new Set(element.children[7].textContent.split(", ")),
                medium: element.children[8].textContent,
            };
        });

        const filter_elements = document.querySelectorAll("#filter input");
        for(const element of filter_elements)
        {
            element.onchange = update_filters;
        }

        function update_filters()
        {
            const filter = {};
            for(const element of filter_elements)
            {
                filter[element.id.replace(/filter_/, "")] = element.checked;
            }

            const show_all = !Object.values(filter).includes(true);
            for(const os of os_info)
            {
                const show = show_all ||
                    filter["graphical"] && os.graphical ||
                    filter["text"] && !os.graphical ||
                    filter["linux"] && os.family === "Linux" ||
                    filter["bsd"] && os.family === "BSD" ||
                    filter["windows"] && os.family === "Windows" ||
                    filter["unix"] && os.family === "Unix" ||
                    filter["dos"] && os.family === "DOS" ||
                    filter["custom"] && os.family === "Custom" ||
                    filter["floppy"] && os.medium === "Floppy" ||
                    filter["cd"] && os.medium === "CD" ||
                    filter["hd"] && os.medium === "HD" ||
                    filter["modern"] && os.status === "Modern" ||
                    filter["historic"] && os.status === "Historic" ||
                    filter["opensource"] && os.source === "Open-source" ||
                    filter["proprietary"] && os.source === "Proprietary" ||
                    filter["bootsector"] && os.size <= 512 ||
                    filter["lt5mb"] && os.size <= 5 * 1024 * 1024 ||
                    filter["gt5mb"] && os.size > 5 * 1024 * 1024 ||
                    filter["16bit"] && os.arch === "16-bit" ||
                    filter["32bit"] && os.arch === "32-bit" ||
                    filter["asm"] && os.languages.has("ASM") ||
                    filter["c"] && os.languages.has("C") ||
                    filter["cpp"] && os.languages.has("C++") ||
                    filter["other_lang"] && ["Java", "Haskell", "Rust", "Erlang", "Oberon"].some(l => os.languages.has(l));

                os.element.style.display = show ? "" : "none";
            }
        }

        function set_proxy_value(id, value)
        {
            const elem = $(id);
            if(elem)
            {
                elem.onclick = () => $("relay_url").value = value;
            }
        }
        set_proxy_value("network_none", "");
        set_proxy_value("network_fetch", "fetch");
        set_proxy_value("network_relay", "wss://relay.widgetry.org/");
        set_proxy_value("network_wisp", "wisps://wisp.mercurywork.shop/v86/");
    }

    function debug_onload()
    {
        // called on window.onload, in debug mode

        const log_levels = $("log_levels");

        if(!log_levels)
        {
            return;
        }

        for(let i = 0; i < LOG_NAMES.length; i++)
        {
            const mask = LOG_NAMES[i][0];

            if(mask === 1)
                continue;

            const name = LOG_NAMES[i][1].toLowerCase();
            const input = document.createElement("input");
            const label = document.createElement("label");

            input.type = "checkbox";

            label.htmlFor = input.id = "log_" + name;

            if(LOG_LEVEL & mask)
            {
                input.checked = true;
            }
            input.mask = mask;

            label.append(input, v86util.pads(name, 4) + " ");
            log_levels.appendChild(label);

            if(i === Math.floor(LOG_NAMES.length / 2))
            {
                log_levels.append("\n");
            }
        }

        log_levels.onchange = function(e)
        {
            const target = e.target;
            const mask = target.mask;

            if(target.checked)
            {
                LOG_LEVEL |= mask;
            }
            else
            {
                LOG_LEVEL &= ~mask;
            }

            target.blur();
        };
    }

    window.addEventListener("load", onload, false);

    // old webkit fires popstate on every load, fuck webkit
    // https://code.google.com/p/chromium/issues/detail?id=63040
    window.addEventListener("load", function()
    {
        setTimeout(function()
        {
            window.addEventListener("popstate", onpopstate);
        }, 0);
    });

    // works in firefox and chromium
    if(document.readyState === "complete")
    {
        onload();
    }

    // we can get here in various ways:
    // - the user clicked on the "start emulation"
    // - the user clicked on a profile
    // - the ?profile= query parameter specified a valid profile
    // - the ?profile= query parameter was set to "custom" and at least one disk image was given
    function start_emulation(profile, query_args)
    {
        $("boot_options").style.display = "none";

        const new_query_args = new Map();
        new_query_args.set("profile", profile?.id || "custom");

        const settings = {};

        if(profile)
        {
            if(profile.state)
            {
                $("reset").style.display = "none";
            }

            set_title(profile.name);

            settings.initial_state = profile.state;
            settings.filesystem = profile.filesystem;
            settings.fda = profile.fda;
            settings.cdrom = profile.cdrom;
            settings.hda = profile.hda;
            settings.multiboot = profile.multiboot;
            settings.bzimage = profile.bzimage;
            settings.initrd = profile.initrd;
            settings.cmdline = profile.cmdline;
            settings.bzimage_initrd_from_filesystem = profile.bzimage_initrd_from_filesystem;
            settings.mac_address_translation = profile.mac_address_translation;
            settings.cpuid_level = profile.cpuid_level;
            settings.acpi = profile.acpi;
            settings.memory_size = profile.memory_size;
            settings.vga_memory_size = profile.vga_memory_size;
            settings.boot_order = profile.boot_order;
            settings.net_device_type = profile.net_device_type;

            if(!DEBUG && profile.homepage)
            {
                $("description").style.display = "block";
                const link = document.createElement("a");
                link.href = profile.homepage;
                link.textContent = profile.name;
                link.target = "_blank";
                $("description").append(document.createTextNode("Running "), link);
            }
        }

        if(query_args)
        {
            // ignore certain settings when using a state image
            if(!settings.initial_state)
            {
                let chunk_size = parseInt(query_args.get("chunk_size"), 10);
                if(chunk_size >= 0)
                {
                    chunk_size = Math.min(4 * 1024 * 1024, Math.max(512, chunk_size));
                    chunk_size = v86util.round_up_to_next_power_of_2(chunk_size);
                }
                else
                {
                    chunk_size = 256 * 1024;
                }

                if(query_args.has("hda.url"))
                {
                    settings.hda = {
                        size: parseInt(query_args.get("hda.size"), 10) || undefined,
                        // TODO: synchronous if small?
                        url: query_args.get("hda.url"),
                        fixed_chunk_size: chunk_size,
                        async: true,
                    };
                }

                if(query_args.has("cdrom.url"))
                {
                    settings.cdrom = {
                        size: parseInt(query_args.get("cdrom.size"), 10) || undefined,
                        url: query_args.get("cdrom.url"),
                        fixed_chunk_size: chunk_size,
                        async: true,
                    };
                }

                if(query_args.has("fda.url"))
                {
                    settings.fda = {
                        size: parseInt(query_args.get("fda.size"), 10) || undefined,
                        url: query_args.get("fda.url"),
                        async: false,
                    };
                }

                const m = parseInt(query_args.get("m"), 10);
                if(m > 0)
                {
                    settings.memory_size = Math.max(16, m) * 1024 * 1024;
                }

                const vram = parseInt(query_args.get("vram"), 10);
                if(vram > 0)
                {
                    settings.vga_memory_size = vram * 1024 * 1024;
                }

                settings.acpi = query_args.has("acpi") ? bool_arg(query_args.get("acpi")) : settings.acpi;
                settings.use_bochs_bios = query_args.get("bios") === "bochs";
                settings.net_device_type = query_args.get("net_device_type") === "virtio" ? "virtio" : "ne2k";
            }

            settings.relay_url = query_args.get("relay_url");
            settings.disable_jit = bool_arg(query_args.get("disable_jit"));
            settings.disable_audio = bool_arg(query_args.get("mute"));
        }

        if(!settings.relay_url)
        {
            settings.relay_url = $("relay_url").value;
            if(!DEFAULT_NETWORKING_PROXIES.includes(settings.relay_url)) new_query_args.set("relay_url", settings.relay_url);
        }
        if(settings.relay_url.startsWith("fetch:"))
        {
            settings.cors_proxy = settings.relay_url.slice(6);
            settings.relay_url = "fetch";
        }
        settings.disable_audio = $("disable_audio").checked || settings.disable_audio;
        if(settings.disable_audio) new_query_args.set("mute", "1");

        // some settings cannot be overridden when a state image is used
        if(!settings.initial_state)
        {
            const bios = $("bios").files[0];
            if(bios)
            {
                settings.bios = { buffer: bios };
            }
            const fda = $("floppy_image").files[0];
            if(fda)
            {
                settings.fda = { buffer: fda };
            }
            const cdrom = $("cdrom_image").files[0];
            if(cdrom)
            {
                settings.cdrom = { buffer: cdrom };
            }
            const hda = $("hda_image").files[0];
            if(hda)
            {
                settings.hda = { buffer: hda };
            }
            const hdb = $("hdb_image")?.files[0];
            if(hdb)
            {
                settings.hdb = { buffer: hdb };
            }
            const multiboot = $("multiboot_image")?.files[0];
            if(multiboot)
            {
                settings.multiboot = { buffer: multiboot };
            }
            const bzimage = $("bzimage").files[0];
            if(bzimage)
            {
                settings.bzimage = { buffer: bzimage };
            }
            const initrd = $("initrd").files[0];
            if(initrd)
            {
                settings.initrd = { buffer: initrd };
            }

            const title = multiboot?.name || hda?.name || cdrom?.name || hdb?.name || fda?.name || bios?.name;
            if(title)
            {
                set_title(title);
            }

            const MB = 1024 * 1024;

            const memory_size = parseInt($("memory_size").value, 10) || DEFAULT_MEMORY_SIZE;
            if(!settings.memory_size || memory_size !== DEFAULT_MEMORY_SIZE)
            {
                settings.memory_size = memory_size * MB;
            }
            if(memory_size !== DEFAULT_MEMORY_SIZE) new_query_args.set("m", String(memory_size));

            const vga_memory_size = parseInt($("vga_memory_size").value, 10) || DEFAULT_VGA_MEMORY_SIZE;
            if(!settings.vga_memory_size || vga_memory_size !== DEFAULT_VGA_MEMORY_SIZE)
            {
                settings.vga_memory_size = vga_memory_size * MB;
            }
            if(vga_memory_size !== DEFAULT_VGA_MEMORY_SIZE) new_query_args.set("vram", String(vga_memory_size));

            const boot_order = parseInt($("boot_order").value, 16) || DEFAULT_BOOT_ORDER;
            if(!settings.boot_order || boot_order !== DEFAULT_BOOT_ORDER)
            {
                settings.boot_order = boot_order;
            }
            if(settings.boot_order !== DEFAULT_BOOT_ORDER) new_query_args.set("boot_order", String(settings.boot_order));

            if(settings.acpi === undefined)
            {
                settings.acpi = $("acpi").checked;
                if(settings.acpi) new_query_args.set("acpi", "1");
            }

            if(!settings.bios)
            {
                const BIOSPATH = "bios/";

                if(settings.use_bochs_bios)
                {
                    var biosfile = "bochs-bios.bin";
                    var vgabiosfile = "bochs-vgabios.bin";
                }
                else
                {
                    var biosfile = DEBUG ? "seabios-debug.bin" : "seabios.bin";
                    var vgabiosfile = DEBUG ? "vgabios-debug.bin" : "vgabios.bin";
                }

                settings.bios = { url: BIOSPATH + biosfile };
                settings.vga_bios = { url: BIOSPATH + vgabiosfile };
            }
        }

        if(!query_args)
        {
            push_state(new_query_args);
        }

        const emulator = new V86({
            screen: {
                container: $("screen_container"),
                use_graphical_text: false,
            },
            net_device: {
                type: settings.net_device_type || "ne2k",
                relay_url: settings.relay_url,
                cors_proxy: settings.cors_proxy
            },
            autostart: true,

            memory_size: settings.memory_size,
            vga_memory_size: settings.vga_memory_size,
            boot_order: settings.boot_order,

            bios: settings.bios,
            vga_bios: settings.vga_bios,
            fda: settings.fda,
            hda: settings.hda,
            hdb: settings.hdb,
            cdrom: settings.cdrom,
            multiboot: settings.multiboot,
            bzimage: settings.bzimage,
            initrd: settings.initrd,

            cmdline: settings.cmdline,
            bzimage_initrd_from_filesystem: settings.bzimage_initrd_from_filesystem,
            acpi: settings.acpi,
            disable_jit: settings.disable_jit,
            initial_state: settings.initial_state,
            filesystem: settings.filesystem || {},
            disable_speaker: settings.disable_audio,
            mac_address_translation: settings.mac_address_translation,
            cpuid_level: settings.cpuid_level,
        });

        if(DEBUG) window.emulator = emulator;

        emulator.add_listener("emulator-ready", function()
        {
            if(DEBUG)
            {
                debug_start(emulator);
            }

            if(emulator.v86.cpu.wm.exports["profiler_is_enabled"]())
            {
                const CLEAR_STATS = false;

                const panel = document.createElement("pre");
                document.body.appendChild(panel);

                setInterval(function()
                    {
                        if(!emulator.is_running())
                        {
                            return;
                        }

                        const text = print_stats.stats_to_string(emulator.v86.cpu);
                        panel.textContent = text;

                        CLEAR_STATS && emulator.v86.cpu.clear_opstats();
                    }, CLEAR_STATS ? 5000 : 1000);
            }

            if(["dsl", "helenos", "android", "android4", "redox", "beos"].includes(profile?.id))
            {
                setTimeout(() => {
                    // hack: Start automatically
                    emulator.keyboard_send_text("\n");
                }, 3000);
            }

            init_ui(settings, emulator);

            if(query_args?.has("c"))
            {
                setTimeout(function()
                {
                    emulator.keyboard_send_text(query_args.get("c") + "\n");
                }, 25);
            }

            if(query_args?.has("s"))
            {
                setTimeout(function()
                {
                    emulator.serial0_send(query_args.get("s") + "\n");
                }, 25);
            }
        });

        emulator.add_listener("download-progress", function(e)
        {
            show_progress(e);
        });

        emulator.add_listener("download-error", function(e)
        {
            const el = $("loading");
            el.style.display = "block";
            el.textContent = `Loading ${e.file_name} failed. Check your connection and reload the page to try again.`;
        });
    }

    /**
     * @param {Object} settings
     * @param {V86} emulator
     */
    function init_ui(settings, emulator)
    {
        $("loading").style.display = "none";
        $("runtime_options").style.display = "block";
        $("runtime_infos").style.display = "block";
        $("screen_container").style.display = "block";

        if(settings.filesystem)
        {
            init_filesystem_panel(emulator);
        }
        else
        {
            emulator.add_listener("9p-attach", function()
            {
                init_filesystem_panel(emulator);
            });
        }

        $("run").onclick = function()
        {
            if(emulator.is_running())
            {
                $("run").value = "Run";
                emulator.stop();
            }
            else
            {
                $("run").value = "Pause";
                emulator.run();
            }

            $("run").blur();
        };

        $("exit").onclick = function()
        {
            emulator.stop();
            location.href = location.pathname;
        };

        $("lock_mouse").onclick = function()
        {
            if(!mouse_is_enabled)
            {
                $("toggle_mouse").onclick();
            }

            emulator.lock_mouse();
            $("lock_mouse").blur();
        };

        var mouse_is_enabled = true;

        $("toggle_mouse").onclick = function()
        {
            mouse_is_enabled = !mouse_is_enabled;

            emulator.mouse_set_status(mouse_is_enabled);
            $("toggle_mouse").value = (mouse_is_enabled ? "Dis" : "En") + "able mouse";
            $("toggle_mouse").blur();
        };

        var last_tick = 0;
        var running_time = 0;
        var last_instr_counter = 0;
        var interval = null;
        var os_uses_mouse = false;
        var total_instructions = 0;

        function update_info()
        {
            var now = Date.now();

            var instruction_counter = emulator.get_instruction_counter();

            if(instruction_counter < last_instr_counter)
            {
                // 32-bit wrap-around
                last_instr_counter -= 0x100000000;
            }

            var last_ips = instruction_counter - last_instr_counter;
            last_instr_counter = instruction_counter;
            total_instructions += last_ips;

            var delta_time = now - last_tick;

            if(delta_time)
            {
                running_time += delta_time;
                last_tick = now;

                $("speed").textContent = (last_ips / 1000 / delta_time).toFixed(1);
                $("avg_speed").textContent = (total_instructions / 1000 / running_time).toFixed(1);
                $("running_time").textContent = format_timestamp(running_time / 1000 | 0);
            }
        }

        emulator.add_listener("emulator-started", function()
        {
            last_tick = Date.now();
            interval = setInterval(update_info, 1000);
        });

        emulator.add_listener("emulator-stopped", function()
        {
            update_info();
            if(interval !== null)
            {
                clearInterval(interval);
            }
        });

        var stats_9p = {
            read: 0,
            write: 0,
            files: [],
        };

        emulator.add_listener("9p-read-start", function(args)
        {
            const file = args[0];
            stats_9p.files.push(file);
            $("info_filesystem").style.display = "block";
            $("info_filesystem_status").textContent = "Loading ...";
            $("info_filesystem_last_file").textContent = file;
        });
        emulator.add_listener("9p-read-end", function(args)
        {
            stats_9p.read += args[1];
            $("info_filesystem_bytes_read").textContent = stats_9p.read;

            const file = args[0];
            stats_9p.files = stats_9p.files.filter(f => f !== file);

            if(stats_9p.files[0])
            {
                $("info_filesystem_last_file").textContent = stats_9p.files[0];
            }
            else
            {
                $("info_filesystem_status").textContent = "Idle";
            }
        });
        emulator.add_listener("9p-write-end", function(args)
        {
            stats_9p.write += args[1];
            $("info_filesystem_bytes_written").textContent = stats_9p.write;

            if(!stats_9p.files[0])
            {
                $("info_filesystem_last_file").textContent = args[0];
            }
        });

        var stats_storage = {
            read: 0,
            read_sectors: 0,
            write: 0,
            write_sectors: 0,
        };

        $("ide_type").textContent = emulator.disk_images.cdrom ? " (CD-ROM)" : " (hard disk)";

        emulator.add_listener("ide-read-start", function()
        {
            $("info_storage").style.display = "block";
            $("info_storage_status").textContent = "Loading ...";
        });
        emulator.add_listener("ide-read-end", function(args)
        {
            stats_storage.read += args[1];
            stats_storage.read_sectors += args[2];

            $("info_storage_status").textContent = "Idle";
            $("info_storage_bytes_read").textContent = stats_storage.read;
            $("info_storage_sectors_read").textContent = stats_storage.read_sectors;
        });
        emulator.add_listener("ide-write-end", function(args)
        {
            stats_storage.write += args[1];
            stats_storage.write_sectors += args[2];

            $("info_storage_bytes_written").textContent = stats_storage.write;
            $("info_storage_sectors_written").textContent = stats_storage.write_sectors;
        });

        var stats_net = {
            bytes_transmitted: 0,
            bytes_received: 0,
        };

        emulator.add_listener("eth-receive-end", function(args)
        {
            stats_net.bytes_received += args[0];

            $("info_network").style.display = "block";
            $("info_network_bytes_received").textContent = stats_net.bytes_received;
        });
        emulator.add_listener("eth-transmit-end", function(args)
        {
            stats_net.bytes_transmitted += args[0];

            $("info_network").style.display = "block";
            $("info_network_bytes_transmitted").textContent = stats_net.bytes_transmitted;
        });


        emulator.add_listener("mouse-enable", function(is_enabled)
        {
            os_uses_mouse = is_enabled;
            $("info_mouse_enabled").textContent = is_enabled ? "Yes" : "No";
        });

        emulator.add_listener("screen-set-size", function(args)
        {
            const [w, h, bpp] = args;
            $("info_res").textContent = w + "x" + h + (bpp ? "x" + bpp : "");
            $("info_vga_mode").textContent = bpp ? "Graphical" : "Text";
        });


        $("reset").onclick = function()
        {
            emulator.restart();
            $("reset").blur();
        };

        add_image_download_button(settings.hda, emulator.disk_images.hda, "hda");
        add_image_download_button(settings.hdb, emulator.disk_images.hdb, "hdb");
        add_image_download_button(settings.fda, emulator.disk_images.fda, "fda");
        add_image_download_button(settings.fdb, emulator.disk_images.fdb, "fdb");
        add_image_download_button(settings.cdrom, emulator.disk_images.cdrom, "cdrom");

        function add_image_download_button(obj, buffer, type)
        {
            var elem = $("get_" + type + "_image");

            if(!obj || obj.size > 100 * 1024 * 1024)
            {
                elem.style.display = "none";
                return;
            }

            elem.onclick = function(e)
            {
                const filename = buffer.file && buffer.file.name || (settings.id + (type === "cdrom" ? ".iso" : ".img"));

                if(buffer.get_as_file)
                {
                    var file = buffer.get_as_file(filename);
                    download(file, filename);
                }
                else
                {
                    buffer.get_buffer(function(b)
                    {
                        if(b)
                        {
                            dump_file(b, filename);
                        }
                        else
                        {
                            alert("The file could not be loaded. Maybe it's too big?");
                        }
                    });
                }

                elem.blur();
            };
        }

        $("change_fda_image").value = settings.fda ? "Eject floppy image" : "Insert floppy image";
        $("change_fda_image").onclick = function()
        {
            if(emulator.v86.cpu.devices.fdc.fda_image)
            {
                emulator.eject_fda();
                $("change_fda_image").value = "Insert floppy image";
            }
            else
            {
                const file_input = document.createElement("input");
                file_input.type = "file";
                file_input.onchange = async function(e)
                {
                    const file = file_input.files[0];
                    if(file)
                    {
                        await emulator.set_fda({ buffer: file });
                        $("change_fda_image").value = "Eject floppy image";
                    }
                };
                file_input.click();
            }
            $("change_fda_image").blur();
        };

        $("memory_dump").onclick = function()
        {
            const mem8 = emulator.v86.cpu.mem8;
            dump_file(new Uint8Array(mem8.buffer, mem8.byteOffset, mem8.length), "v86memory.bin");
            $("memory_dump").blur();
        };

        //$("memory_dump_dmp").onclick = function()
        //{
        //    var memory = emulator.v86.cpu.mem8;
        //    var memory_size = memory.length;
        //    var page_size = 4096;
        //    var header = new Uint8Array(4096);
        //    var header32 = new Int32Array(header.buffer);

        //    header32[0] = 0x45474150; // 'PAGE'
        //    header32[1] = 0x504D5544; // 'DUMP'

        //    header32[0x10 >> 2] = emulator.v86.cpu.cr[3]; // DirectoryTableBase
        //    header32[0x24 >> 2] = 1; // NumberProcessors
        //    header32[0xf88 >> 2] = 1; // DumpType: full dump
        //    header32[0xfa0 >> 2] = header.length + memory_size; // RequiredDumpSpace

        //    header32[0x064 + 0 >> 2] = 1; // NumberOfRuns
        //    header32[0x064 + 4 >> 2] = memory_size / page_size; // NumberOfPages
        //    header32[0x064 + 8 >> 2] = 0; // BasePage
        //    header32[0x064 + 12 >> 2] = memory_size / page_size; // PageCount

        //    dump_file([header, memory], "v86memory.dmp");

        //    $("memory_dump_dmp").blur();
        //};

        $("capture_network_traffic").onclick = function()
        {
            this.value = "0 packets";

            let capture = [];

            function do_capture(direction, data)
            {
                capture.push({ direction, time: performance.now() / 1000, hex_dump: hex_dump(data) });
                $("capture_network_traffic").value = capture.length + " packets";
            }

            emulator.emulator_bus.register("net0-receive", do_capture.bind(this, "I"));
            emulator.add_listener("net0-send", do_capture.bind(this, "O"));

            this.onclick = function()
            {
                const capture_raw = capture.map(({ direction, time, hex_dump }) => {
                    // https://www.wireshark.org/docs/wsug_html_chunked/ChIOImportSection.html
                    // In wireshark: file -> import from hex -> tick direction indication, timestamp %s.%f
                    return direction + " " + time.toFixed(6) + hex_dump + "\n";
                }).join("");
                dump_file(capture_raw, "traffic.hex");
                capture = [];
                this.value = "0 packets";
            };
        };


        $("save_state").onclick = async function()
        {
            const result = await emulator.save_state();
            dump_file(result, "v86state.bin");

            $("save_state").blur();
        };

        $("load_state").onclick = function()
        {
            $("load_state_input").click();
            $("load_state").blur();
        };

        $("load_state_input").onchange = async function()
        {
            var file = this.files[0];

            if(!file)
            {
                return;
            }

            var was_running = emulator.is_running();

            if(was_running)
            {
                await emulator.stop();
            }

            var filereader = new FileReader();
            filereader.onload = async function(e)
            {
                try
                {
                    await emulator.restore_state(e.target.result);
                }
                catch(err)
                {
                    alert("Something bad happened while restoring the state:\n" + err + "\n\n" +
                          "Note that the current configuration must be the same as the original");
                    throw err;
                }

                if(was_running)
                {
                    emulator.run();
                }
            };
            filereader.readAsArrayBuffer(file);

            this.value = "";
        };

        $("ctrlaltdel").onclick = function()
        {
            emulator.keyboard_send_scancodes([
                0x1D, // ctrl
                0x38, // alt
                0x53, // delete

                // break codes
                0x1D | 0x80,
                0x38 | 0x80,
                0x53 | 0x80,
            ]);

            $("ctrlaltdel").blur();
        };

        $("alttab").onclick = function()
        {
            emulator.keyboard_send_scancodes([
                0x38, // alt
                0x0F, // tab
            ]);

            setTimeout(function()
            {
                emulator.keyboard_send_scancodes([
                    0x38 | 0x80,
                    0x0F | 0x80,
                ]);
            }, 100);

            $("alttab").blur();
        };

        $("scale").onchange = function()
        {
            var n = parseFloat(this.value);

            if(n || n > 0)
            {
                emulator.screen_set_scale(n, n);
            }
        };

        $("fullscreen").onclick = function()
        {
            emulator.screen_go_fullscreen();
        };

        $("screen_container").onclick = function()
        {
            if(emulator.is_running() && emulator.speaker_adapter && emulator.speaker_adapter.audio_context.state === "suspended")
            {
                emulator.speaker_adapter.audio_context.resume();
            }

            if(mouse_is_enabled && os_uses_mouse)
            {
                emulator.lock_mouse();
            }
            else
            {
                // allow text selection
                if(window.getSelection().isCollapsed)
                {
                    const phone_keyboard = document.getElementsByClassName("phone_keyboard")[0];

                    // stop mobile browser from scrolling into view when the keyboard is shown
                    phone_keyboard.style.top = document.body.scrollTop + 100 + "px";
                    phone_keyboard.style.left = document.body.scrollLeft + 100 + "px";

                    phone_keyboard.focus();
                }
            }
        };

        const phone_keyboard = document.getElementsByClassName("phone_keyboard")[0];

        phone_keyboard.setAttribute("autocorrect", "off");
        phone_keyboard.setAttribute("autocapitalize", "off");
        phone_keyboard.setAttribute("spellcheck", "false");
        phone_keyboard.tabIndex = 0;

        $("screen_container").addEventListener("mousedown", e =>
        {
            phone_keyboard.focus();
        }, false);

        $("take_screenshot").onclick = function()
        {
            const image = emulator.screen_make_screenshot();
            try {
                const w = window.open("");
                w.document.write(image.outerHTML);
            }
            catch(e) {}
            $("take_screenshot").blur();
        };

        if(emulator.speaker_adapter)
        {
            let is_muted = false;

            $("mute").onclick = function()
            {
                if(is_muted)
                {
                    emulator.speaker_adapter.mixer.set_volume(1, undefined);
                    is_muted = false;
                    $("mute").value = "Mute";
                }
                else
                {
                    emulator.speaker_adapter.mixer.set_volume(0, undefined);
                    is_muted = true;
                    $("mute").value = "Unmute";
                }

                $("mute").blur();
            };
        }
        else
        {
            $("mute").remove();
        }

        window.addEventListener("keydown", ctrl_w_rescue, false);
        window.addEventListener("keyup", ctrl_w_rescue, false);
        window.addEventListener("blur", ctrl_w_rescue, false);

        function ctrl_w_rescue(e)
        {
            if(e.ctrlKey)
            {
                window.onbeforeunload = function()
                {
                    window.onbeforeunload = null;
                    return "CTRL-W cannot be sent to the emulator.";
                };
            }
            else
            {
                window.onbeforeunload = null;
            }
        }

        const script = document.createElement("script");
        script.src = "build/xterm.js";
        script.async = true;
        script.onload = function()
        {
            emulator.set_serial_container_xtermjs($("terminal"));
        };
        document.body.appendChild(script);
    }

    function init_filesystem_panel(emulator)
    {
        $("filesystem_panel").style.display = "block";

        $("filesystem_send_file").onchange = function()
        {
            Array.prototype.forEach.call(this.files, function(file)
            {
                var loader = new v86util.SyncFileBuffer(file);
                loader.onload = function()
                {
                    loader.get_buffer(async function(buffer)
                    {
                        await emulator.create_file("/" + file.name, new Uint8Array(buffer));
                    });
                };
                loader.load();
            }, this);

            this.value = "";
            this.blur();
        };

        $("filesystem_get_file").onkeypress = async function(e)
        {
            if(e.which !== 13)
            {
                return;
            }

            this.disabled = true;

            let result;
            try
            {
                 result = await emulator.read_file(this.value);
            }
            catch(err)
            {
                console.log(err);
            }

            this.disabled = false;

            if(result)
            {
                var filename = this.value.replace(/\/$/, "").split("/");
                filename = filename[filename.length - 1] || "root";

                dump_file(result, filename);
                this.value = "";
            }
            else
            {
                alert("Can't read file");
            }
        };
    }

    function debug_start(emulator)
    {
        if(!emulator.v86)
        {
            return;
        }

        // called as soon as soon as emulation is started, in debug mode
        var debug = emulator.v86.cpu.debug;

        $("dump_gdt").onclick = debug.dump_gdt_ldt.bind(debug);
        $("dump_idt").onclick = debug.dump_idt.bind(debug);
        $("dump_regs").onclick = debug.dump_regs.bind(debug);
        $("dump_pt").onclick = debug.dump_page_structures.bind(debug);

        $("dump_log").onclick = function()
        {
            dump_file(log_data.join(""), "v86.log");
        };

        var cpu = emulator.v86.cpu;

        $("debug_panel").style.display = "block";
        setInterval(function()
        {
            $("debug_panel").textContent =
                cpu.debug.get_regs_short().join("\n") + "\n" + cpu.debug.get_state();

            $("dump_log").value = "Dump log" + (log_data.length ? " (" + log_data.length + " lines)" : "");
        }, 1000);

        // helps debugging
        window.cpu = cpu;
        window.dump_file = dump_file;
    }

    function onpopstate(e)
    {
        location.reload();
    }

    function push_state(params)
    {
        if(window.history.pushState)
        {
            let search = "?" + params.entries().map(([key, value]) => key + "=" + value.replace(/[?&=#+]/g, encodeURIComponent))["toArray"]().join("&");
            window.history.pushState({ search }, "", search);
        }
    }

})();
