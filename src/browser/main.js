import { V86 } from "./starter.js";
import { LOG_NAMES } from "../const.js";
import { SyncBuffer, SyncFileBuffer } from "../buffer.js";
import { h, pad0, pads, hex_dump, dump_file, download, round_up_to_next_power_of_2 } from "../lib.js";
import { log_data, LOG_LEVEL, set_log_level } from "../log.js";
import * as iso9660 from "../iso9660.js";


const ON_LOCALHOST = !location.hostname.endsWith("copy.sh");

const DEFAULT_NETWORKING_PROXIES = ["wss://relay.widgetry.org/", "ws://localhost:8080/"];
const DEFAULT_MEMORY_SIZE = 128;
const DEFAULT_VGA_MEMORY_SIZE = 8;
const DEFAULT_BOOT_ORDER = 0;

const MAX_ARRAY_BUFFER_SIZE_MB = 2000;

function query_append()
{
    const version = $("version");
    return version ? "?" + version.textContent : "";
}

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
        return (time / 60 | 0) + "m " + pad0(time % 60, 2) + "s";
    }
    else
    {
        return (time / 3600 | 0) + "h " +
            pad0((time / 60 | 0) % 60, 2) + "m " +
            pad0(time % 60, 2) + "s";
    }
}

function read_file(file)
{
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = e => reject(e);
        fr.readAsArrayBuffer(file);
    });
}

let progress_ticks = 0;

function show_progress(e)
{
    const el = $("loading");
    el.style.display = "block";

    const file_name = e.file_name.split("?", 1)[0];

    if(file_name.endsWith(".wasm"))
    {
        const parts = file_name.split("/");
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
                url: host + "windowsme-v2/.img",
                size: 834666496,
                async: true,
                fixed_chunk_size: 256 * 1024,
                use_parts: true,
            },
            state: { url: host + "windows-me_state-v2.bin.zst" },
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
                url: host + "windowsnt351/.img",
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
        link.href = "build/v86.wasm" + query_append();
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
            return;
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

    if(query_args.has("m")) $("memory_size").value = query_args.get("m");
    if(query_args.has("vram")) $("vga_memory_size").value = query_args.get("vram");
    if(query_args.has("relay_url")) $("relay_url").value = query_args.get("relay_url");
    if(query_args.has("mute")) $("disable_audio").checked = bool_arg(query_args.get("mute"));
    if(query_args.has("acpi")) $("acpi").checked = bool_arg(query_args.get("acpi"));
    if(query_args.has("boot_order")) $("boot_order").value = query_args.get("boot_order");

    for(const dev of ["fda", "fdb"])
    {
        const toggle = $(dev + "_toggle_empty_disk");
        if(!toggle) continue;

        toggle.onclick = function(e)
        {
            e.preventDefault();
            const select = document.createElement("select");
            select.id = dev + "_empty_size";
            for(const n_sect of [320, 360, 400, 640, 720, 800, 1440, 2400, 2880, 3444, 5760, 7680])
            {
                const n_bytes = n_sect * 512, kB = 1024, MB = kB * 1000;
                const option = document.createElement("option");
                if(n_bytes < MB)
                {
                    option.textContent = (n_bytes / kB) + " kB";
                }
                else
                {
                    option.textContent = (n_bytes / MB).toFixed(2) + " MB";
                }
                if(n_sect === 2880)
                {
                    option.selected = true;
                }
                option.value = n_bytes;
                select.appendChild(option);
            }
            // TODO (when closure compiler supports it): parent.parentNode.replaceChildren(...);
            const parent = toggle.parentNode;
            parent.innerHTML = "";
            parent.append("Empty disk of ", select);
        };
    }

    for(const dev of ["hda", "hdb"])
    {
        const toggle = $(dev + "_toggle_empty_disk");
        if(!toggle) continue;

        toggle.onclick = function(e)
        {
            e.preventDefault();
            const input = document.createElement("input");
            input.id = dev + "_empty_size";
            input.type = "number";
            input.min = "0";
            input.max = String(MAX_ARRAY_BUFFER_SIZE_MB);
            input.step = "100";
            input.value = "100";
            // TODO (when closure compiler supports it): parent.parentNode.replaceChildren(...);
            const parent = toggle.parentNode;
            parent.innerHTML = "";
            parent.append("Empty disk of ", input, " MB");
        };
    }

    const os_info = Array.from(document.querySelectorAll("#oses a.tr")).map(element =>
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

    const known_filter = [
        [   // Family:
            { id: "linux", condition: os => os.family === "Linux" },
            { id: "bsd", condition: os => os.family === "BSD" },
            { id: "windows", condition: os => os.family === "Windows" },
            { id: "unix", condition: os => os.family === "Unix" },
            { id: "dos", condition: os => os.family === "DOS" },
            { id: "custom", condition: os => os.family === "Custom" },
        ],
        [   // UI:
            { id: "graphical", condition: os => os.graphical },
            { id: "text", condition: os => !os.graphical },
        ],
        [   // Medium:
            { id: "floppy", condition: os => os.medium === "Floppy" },
            { id: "cd", condition: os => os.medium === "CD" },
            { id: "hd", condition: os => os.medium === "HD" },
        ],
        [   // Size:
            { id: "bootsector", condition: os => os.size <= 512 },
            { id: "lt5mb", condition: os => os.size <= 5 * 1024 * 1024 },
            { id: "gt5mb", condition: os => os.size > 5 * 1024 * 1024 },
        ],
        [   // Status:
            { id: "modern", condition: os => os.status === "Modern" },
            { id: "historic", condition: os => os.status === "Historic" },
        ],
        [   // License:
            { id: "opensource", condition: os => os.source === "Open-source" },
            { id: "proprietary", condition: os => os.source === "Proprietary" },
        ],
        [   // Arch:
            { id: "16bit", condition: os => os.arch === "16-bit" },
            { id: "32bit", condition: os => os.arch === "32-bit" },
        ],
        [   // Lang:
            { id: "asm", condition: os => os.languages.has("ASM") },
            { id: "c", condition: os => os.languages.has("C") },
            { id: "cpp", condition: os => os.languages.has("C++") },
            { id: "other_lang", condition: os => ["ASM", "C", "C++"].every(lang => !os.languages.has(lang)) },
        ],
    ];

    const defined_filter = [];
    for(const known_category of known_filter)
    {
        const category = known_category.filter(filter => {
            const element = document.getElementById(`filter_${filter.id}`);
            if(element)
            {
                element.onchange = update_filters;
                filter.element = element;
            }
            return element;
        });
        if(category.length)
        {
            defined_filter.push(category);
        }
    }

    function update_filters()
    {
        const conjunction = [];
        for(const category of defined_filter)
        {
            const disjunction = category.filter(filter => filter.element.checked);
            if(disjunction.length)
            {
                conjunction.push(disjunction);
            }
        }
        for(const os of os_info)
        {
            os.element.style.display = conjunction.every(disjunction => disjunction.some(filter => filter.condition(os))) ? "" : "none";
        }
    }

    if($("reset_filters"))
    {
        $("reset_filters").onclick = function()
        {
            for(const element of document.querySelectorAll("#filter input[type=checkbox]"))
            {
                element.checked = false;
            }
            update_filters();
        };
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
    set_proxy_value("network_inbrowser", "inbrowser");
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

        label.append(input, pads(name, 4) + " ");
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
            set_log_level(LOG_LEVEL | mask);
        }
        else
        {
            set_log_level(LOG_LEVEL & ~mask);
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
// - the user clicked on the "start emulation" button
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
        settings.fdb = profile.fdb;
        settings.cdrom = profile.cdrom;
        settings.hda = profile.hda;
        settings.hdb = profile.hdb;
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
                chunk_size = round_up_to_next_power_of_2(chunk_size);
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
            else if(query_args.has("hda.empty"))
            {
                const empty_size = parseInt(query_args.get("hda.empty"), 10);
                if(empty_size > 0)
                {
                    settings.hda = { buffer: new ArrayBuffer(empty_size) };
                }
            }

            if(query_args.has("hdb.url"))
            {
                settings.hdb = {
                    size: parseInt(query_args.get("hdb.size"), 10) || undefined,
                    // TODO: synchronous if small?
                    url: query_args.get("hdb.url"),
                    fixed_chunk_size: chunk_size,
                    async: true,
                };
            }
            else if(query_args.has("hdb.empty"))
            {
                const empty_size = parseInt(query_args.get("hdb.empty"), 10);
                if(empty_size > 0)
                {
                    settings.hdb = { buffer: new ArrayBuffer(empty_size) };
                }
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
            settings.net_device_type = query_args.get("net_device_type") || settings.net_device_type;
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
        const vga_bios = $("vga_bios").files[0];
        if(vga_bios)
        {
            settings.vga_bios = { buffer: vga_bios };
        }
        const fda = $("fda_image")?.files[0];
        if(fda)
        {
            settings.fda = { buffer: fda };
        }
        const fda_empty_size = +$("fda_empty_size")?.value;
        if(fda_empty_size)
        {
            settings.fda = { buffer: new ArrayBuffer(fda_empty_size) };
        }
        const fdb = $("fdb_image")?.files[0];
        if(fdb)
        {
            settings.fdb = { buffer: fdb };
        }
        const fdb_empty_size = +$("fdb_empty_size")?.value;
        if(fdb_empty_size)
        {
            settings.fdb = { buffer: new ArrayBuffer(fdb_empty_size) };
        }
        const cdrom = $("cdrom_image").files[0];
        if(cdrom)
        {
            settings.cdrom = { buffer: cdrom };
        }
        const hda = $("hda_image")?.files[0];
        if(hda)
        {
            settings.hda = { buffer: hda };
        }
        const hda_empty_size = +$("hda_empty_size")?.value;
        if(hda_empty_size)
        {
            const size = Math.min(1, Math.max(MAX_ARRAY_BUFFER_SIZE_MB, hda_empty_size)) * 1024 * 1024;
            settings.hda = { buffer: new ArrayBuffer(size) };
            new_query_args.set("hda.empty", String(size));
        }
        const hdb = $("hdb_image")?.files[0];
        if(hdb)
        {
            settings.hdb = { buffer: hdb };
        }
        const hdb_empty_size = +$("hdb_empty_size")?.value;
        if(hdb_empty_size)
        {
            const size = Math.min(1, Math.max(MAX_ARRAY_BUFFER_SIZE_MB, hdb_empty_size)) * 1024 * 1024;
            settings.hdb = { buffer: new ArrayBuffer(hdb_empty_size) };
            new_query_args.set("hdb.empty", String(size));
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
        if(settings.boot_order !== DEFAULT_BOOT_ORDER) new_query_args.set("boot_order", settings.boot_order.toString(16));

        if(settings.acpi === undefined)
        {
            settings.acpi = $("acpi").checked;
            if(settings.acpi) new_query_args.set("acpi", "1");
        }

        const BIOSPATH = "bios/";

        if(!settings.bios)
        {
            settings.bios = { url: BIOSPATH + (DEBUG ? "seabios-debug.bin" : "seabios.bin") };
        }
        if(!settings.vga_bios)
        {
            settings.vga_bios = { url: BIOSPATH + (DEBUG ? "vgabios-debug.bin" : "vgabios.bin") };
        }
        if(settings.use_bochs_bios)
        {
            settings.bios = { url: BIOSPATH + "bochs-bios.bin" };
            settings.vga_bios = { url: BIOSPATH + "bochs-vgabios.bin" };
        }
    }

    if(!query_args)
    {
        push_state(new_query_args);
    }

    const emulator = new V86({
        wasm_path: "build/" + (DEBUG ? "v86-debug.wasm" : "v86.wasm") + query_append(),
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
        fdb: settings.fdb,
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

                    panel.textContent = emulator.get_instruction_stats();

                    CLEAR_STATS && emulator.v86.cpu.clear_opstats();
                }, CLEAR_STATS ? 5000 : 1000);
        }

        if(["dsl", "helenos", "android", "android4", "redox", "beos", "9legacy"].includes(profile?.id))
        {
            setTimeout(() => {
                // hack: Start automatically
                emulator.keyboard_send_text(profile.id === "9legacy" ? "1\n" : "\n");
            }, 3000);
        }

        init_ui(profile, settings, emulator);

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

        if(query_args?.has("theatre") && bool_arg(query_args?.get("theatre")))
        {
            $("toggle_theatre").click();
        }
    });

    emulator.add_listener("emulator-loaded", function()
    {
        if(!emulator.v86.cpu.devices.cdrom)
        {
            $("change_cdrom_image").style.display = "none";
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
function init_ui(profile, settings, emulator)
{
    $("loading").style.display = "none";
    $("runtime_options").style.display = "block";
    $("runtime_infos").style.display = "block";
    $("screen_container").style.display = "block";

    var filesystem_is_enabled = false;

    if(settings.filesystem)
    {
        filesystem_is_enabled = true;
        init_filesystem_panel(emulator);
    }
    else
    {
        emulator.add_listener("9p-attach", function()
        {
            filesystem_is_enabled = true;
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
        emulator.destroy();
        const url = new URL(location.href);
        url.searchParams.delete("profile");
        location.href = url.pathname + url.search;
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

        emulator.mouse_set_enabled(mouse_is_enabled);
        $("toggle_mouse").value = (mouse_is_enabled ? "Dis" : "En") + "able mouse";
        $("toggle_mouse").blur();
    };

    if(profile?.mouse_disabled_default)
    {
        $("toggle_mouse").onclick();
    }

    var theatre_mode = false;
    var theatre_ui = true;
    var theatre_zoom_to_fit = false;

    function zoom_to_fit()
    {
        // reset size
        emulator.screen_set_scale(1, 1);

        const emulator_screen = $("screen_container").getBoundingClientRect();
        const emulator_screen_width = emulator_screen.width;
        const emulator_screen_height = emulator_screen.height;

        const viewport_screen_width = window.innerWidth;
        const viewport_screen_height = window.innerHeight;

        const n = Math.min(viewport_screen_width / emulator_screen_width, viewport_screen_height / emulator_screen_height);
        emulator.screen_set_scale(n, n);
    }

    /**
     * @param {boolean} enabled
     */
    function enable_theatre_ui(enabled)
    {
        theatre_ui = enabled;

        $("runtime_options").style.display = theatre_ui ? "block" : "none";
        $("runtime_infos").style.display = theatre_ui ? "block" : "none";
        $("filesystem_panel").style.display = (filesystem_is_enabled && theatre_ui) ? "block" : "none";

        $("toggle_ui").value = (theatre_ui ? "Hide" : "Show") + " UI";
    }

    /**
     * @param {boolean} enabled
     */
    function enable_zoom_to_fit(enabled)
    {
        theatre_zoom_to_fit = enabled;
        $("scale").disabled = theatre_zoom_to_fit;

        if(theatre_zoom_to_fit)
        {
            window.addEventListener("resize", zoom_to_fit, true);
            emulator.add_listener("screen-set-size", zoom_to_fit);

            zoom_to_fit();
        }
        else
        {
            window.removeEventListener("resize", zoom_to_fit, true);
            emulator.remove_listener("screen-set-size", zoom_to_fit);

            const n = parseFloat($("scale").value) || 1;
            emulator.screen_set_scale(n, n);
        }

        $("toggle_zoom_to_fit").value = (theatre_zoom_to_fit ? "Dis" : "En") + "able zoom to fit";
    }

    /**
     * @param {boolean} enabled
     */
    function enable_theatre_mode(enabled)
    {
        theatre_mode = enabled;

        if(!theatre_ui)
        {
            enable_theatre_ui(true);
        }

        if(!theatre_mode && theatre_zoom_to_fit)
        {
            enable_zoom_to_fit(false);
        }

        for(const el of ["screen_container", "runtime_options", "runtime_infos", "filesystem_panel"])
        {
            $(el).classList.toggle("theatre_" + el);
        }

        $("theatre_background").style.display = theatre_mode ? "block" : "none";
        $("toggle_zoom_to_fit").style.display = theatre_mode ? "inline" : "none";
        $("toggle_ui").style.display = theatre_mode ? "block" : "none";

        // hide scrolling
        document.body.style.overflow = theatre_mode ? "hidden" : "visible";

        $("toggle_theatre").value = (theatre_mode ? "Dis" : "En") + "able theatre mode";
    }

    $("toggle_ui").onclick = function()
    {
        enable_theatre_ui(!theatre_ui);
        $("toggle_ui").blur();
    };

    $("toggle_theatre").onclick = function()
    {
        enable_theatre_mode(!theatre_mode);
        $("toggle_theatre").blur();
    };

    $("toggle_zoom_to_fit").onclick = function()
    {
        enable_zoom_to_fit(!theatre_zoom_to_fit);
        $("toggle_zoom_to_fit").blur();
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

        if(!obj || obj.async)
        {
            elem.style.display = "none";
            return;
        }

        elem.onclick = function(e)
        {
            // XXX: the filename is a bit confusing for empty disks (it chooses the profile name)
            const filename = buffer.file && buffer.file.name || ((profile?.id || "v86") + (type === "cdrom" ? ".iso" : ".img"));

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
        if(emulator.get_disk_fda())
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

    $("change_fdb_image").value = settings.fdb ? "Eject second floppy image" : "Insert second floppy image";
    $("change_fdb_image").onclick = function()
    {
        if(emulator.get_disk_fdb())
        {
            emulator.eject_fdb();
            $("change_fdb_image").value = "Insert second floppy image";
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
                    await emulator.set_fdb({ buffer: file });
                    $("change_fdb_image").value = "Eject second floppy image";
                }
            };
            file_input.click();
        }
        $("change_fdb_image").blur();
    };

    $("change_cdrom_image").value = settings.cdrom ? "Eject CD image" : "Insert CD image";
    $("change_cdrom_image").onclick = function()
    {
        if(emulator.v86.cpu.devices.cdrom.has_disk())
        {
            emulator.eject_cdrom();
            $("change_cdrom_image").value = "Insert CD image";
        }
        else
        {
            const file_input = document.createElement("input");
            file_input.type = "file";
            file_input.multiple = "multiple";
            file_input.onchange = async function(e)
            {
                const files = file_input.files;
                let buffer;

                if(files.length === 1 && files[0].name.endsWith(".iso"))
                {
                    buffer = files[0];
                }
                else if(files.length)
                {
                    const files2 = [];
                    for(const file of files)
                    {
                        files2.push({
                            name: file.name,
                            contents: new Uint8Array(await read_file(file)),
                        });

                    }
                    buffer = iso9660.generate(files2).buffer;
                }

                if(buffer)
                {
                    await emulator.set_cdrom({ buffer });
                    $("change_cdrom_image").value = "Eject CD image";
                }
            };
            file_input.click();
        }
        $("change_cdrom_image").blur();
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

    /**
     * @this HTMLElement
     */
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

    /**
     * @this HTMLElement
     */
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

    /**
     * @this HTMLElement
     */
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

    $("screen_container").onclick = function(e)
    {
        if(emulator.is_running() && emulator.speaker_adapter?.audio_context?.state === "suspended")
        {
            emulator.speaker_adapter.audio_context.resume();
        }

        if(mouse_is_enabled && os_uses_mouse)
        {
            emulator.lock_mouse();
        }

        // allow text selection
        if(window.getSelection().isCollapsed)
        {
            const phone_keyboard = document.getElementsByClassName("phone_keyboard")[0];

            phone_keyboard.style.top = window.scrollY + e.clientY + 20 + "px";
            phone_keyboard.style.left = window.scrollX + e.clientX + "px";

            // clean after previous input
            phone_keyboard.value = "";
            phone_keyboard.focus();
        }
    };

    const phone_keyboard = document.getElementsByClassName("phone_keyboard")[0];

    phone_keyboard.setAttribute("autocorrect", "off");
    phone_keyboard.setAttribute("autocapitalize", "off");
    phone_keyboard.setAttribute("spellcheck", "false");
    phone_keyboard.tabIndex = 0;

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

    /**
     * @this HTMLElement
     */
    $("filesystem_send_file").onchange = function()
    {
        Array.prototype.forEach.call(this.files, function(file)
        {
            var loader = new SyncFileBuffer(file);
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

    /**
     * @this HTMLElement
     */
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
    const cpu = emulator.v86.cpu;

    $("dump_gdt").onclick = cpu.dump_gdt_ldt.bind(cpu);
    $("dump_idt").onclick = cpu.dump_idt.bind(cpu);
    $("dump_regs").onclick = () => { cpu.dump_regs_short(); cpu.dump_state(); };
    $("dump_pt").onclick = cpu.dump_page_structures.bind(cpu);

    $("dump_log").onclick = function()
    {
        dump_file(log_data.join(""), "v86.log");
    };

    $("debug_panel").style.display = "block";
    setInterval(function()
    {
        $("debug_panel").textContent =
            cpu.get_regs_short().join("\n") + "\n" + cpu.debug_get_state();

        $("dump_log").value = "Dump log" + (log_data.length ? " (" + log_data.length + " lines)" : "");
    }, 1000);

    // helps debugging
    window.cpu = cpu;
    window.h = h;
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
        let search = "?" + Array.from(params.entries()).map(([key, value]) => key + "=" + value.replace(/[?&=#+]/g, encodeURIComponent)).join("&");
        window.history.pushState({ search }, "", search);
    }
}
