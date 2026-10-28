// warning: experimental, incomplete and likely to change in the future
// if you find problems, please send a pull request

/**
 * The type for images as a file, loaded asynchronously.
 *
 * Files with `async: true` and `use_parts: false` are downloaded using HTTP
 * Range requests. Note that not all web servers support this header correctly,
 * and it inherently disables HTTP compression. The `url` fields points
 * directly to the disk images.
 */
type V86AsyncFileImage =
    {
        /** The URL to the image */
        url: string;

        /**
         * Async loading.
         *
         * If true, the file is downloaded completely, otherwise in chunks
         * (see {@link V86AsyncFileImage.use_parts} for the chunking method).
         */
        async: true;

        /** Image size, required for async loading */
        size: number;

        /**
         * Use parts instead of Range header, useful for static hostings.
         *
         * If true, v86 expects the image to be split in files of `fixed_chunk_size`
         * bytes. You can use [split-image.py](https://github.com/speedyHKjournalist/v64/blob/master/tools/split-image.py)
         * to split an image. V86 appends `-<start-byte>-<end-byte>` to the url.
         */
        use_parts?: boolean;

        /**
         * Fixed chunk size, useful with `use_parts: true` for GitHub Pages users.
         */
        fixed_chunk_size?: number;
    };

/**
 * The type for images as a file, loaded synchronously.
 */
type V86SyncFileImage =
    {
        /** The URL to the image */
        url: string;

        /** @ignore */
        async?: false;
    };

/**
 * The type for images as a buffer.
 */
type V86BufferImage =
    {
        /** Image buffer */
        buffer: ArrayBuffer
    };
    //| { buffer: File; async?: boolean; }; // only in browsers: https://developer.mozilla.org/en-US/docs/Web/API/File

/**
 * The type of disk/bios/state images.
 *
 * Note that bios, initial state, bzimage, initrd, multiboot and floppy disk
 * images are always loaded synchronously.
 *
 * State images and fixed-size chunks (but not other image types) that end with
 * .zst are automatically decompressed using a built-in zstd decompressor. This
 * has a performance overhead compared to HTTP compression, but will result in
 * better compression ration.
 */
export type V86Image = V86AsyncFileImage | V86SyncFileImage | V86BufferImage;

/**
 * The container format of a hard disk image (docs/disk-image-formats-plan.md).
 * "raw" (or no format): the sectors as they are, as before. "auto": the
 * format from the image's signature and structure; a RAW image has none, so
 * "auto" fails for it. "vpc" is QEMU's name of VHD. VHD and VDI: fixed and
 * dynamic images (not differencing ones). VMDK: monolithicSparse,
 * streamOptimized, monolithicFlat, vmfs, twoGbMaxExtentSparse,
 * twoGbMaxExtentFlat (other createTypes fail at start). VHDX: fixed and
 * dynamic images with 512- or 4096-byte logical sectors (the disk's sectors
 * are the image's) and no log to replay (not differencing ones).
 */
export type V86DiskFormat = "raw" | "qcow2" | "vhd" | "vpc" | "vdi" | "vmdk" | "vhdx" | "auto";

/**
 * The options of a hard disk image (hda, hdb, attach_sata_drive). With a
 * container format, `size` is the length of the file (as for async images),
 * and the guest sees the disk's virtual size; the guest's writes stay in
 * memory, the file is never written.
 */
export type V86DiskImageOptions =
    {
        /** The container format; omitted: RAW, as before */
        format?: V86DiskFormat;

        /**
         * The source image's policy (docs/disk-persistence-plan.md), not
         * whether the guest may write (that is virtio_disks' readonly):
         * "read_only" (the default) keeps the guest's writes in memory, the
         * image stays as it is. "read_write" writes them back to the image
         * the url names: a disk service's URL (a server, or the local disk
         * service on 127.0.0.1: tools/disk-service.mjs; a URL that is not
         * one fails at start), in Node a local file path (written in place,
         * async is ignored), or a buffer object of one's own with the
         * backend contract (flush, close, mark, generation, get_state,
         * set_state, check_state). A completed write is in the
         * image; it is durable after a flush (the guest's, or one by itself
         * 1 s after the last write, 5 s at most; stop() and destroy() flush
         * too). The guest sees a write cache it may turn off (IDE/AHCI). A
         * snapshot of the disk holds only a reference of the image (no
         * data), restored only onto the same image not written since. It
         * fails at start for any other source (an ArrayBuffer, a File, a
         * plain URL, an image in parts), for an image in a container
         * format, with readonly, and for an image bound to two disks. An
         * option of each disk, never of the V86 options.
         */
        disk_option?: "read_only" | "read_write";

        /**
         * What a failed read or write of this disk does (the "disk-error"
         * event): "stop" (the default) stops the machine until run()
         * retries the request; "report" ends the guest's command with an
         * I/O error at once
         */
        disk_error?: "stop" | "report";

        /**
         * The credentials of a disk service that wants them (sent as
         * Authorization: Bearer, never in the URL)
         */
        token?: string;

        /**
         * An identifier of the image's version, published with it (an
         * image of a container format): a snapshot records it with the
         * image's metadata, size and format, and restores only onto the
         * same image
         */
        image_id?: string;

        /**
         * The most bytes of guest writes kept in memory (an image of a
         * container format); beyond it, writes fail with an I/O error.
         * Default: no limit
         */
        overlay_limit?: number;

        /**
         * The parent image of an image that has one (a QCOW2 image with a
         * backing file): given here, never loaded by the name the image has
         * for it. Its format is the one the image names, or `format` here.
         * A snapshot records the parents' identities too.
         */
        backing?: V86Image & V86DiskImageOptions;

        /**
         * The other files of an image in several files (a VMDK descriptor's
         * extents), by the name the image has for them: none is loaded by
         * that name alone
         */
        files?: { [name: string]: V86Image };

        /**
         * The image is this file in the TAR archive `url` or `buffer` is (an
         * OVA): read there, not extracted (see V86.import_ova)
         */
        archive_member?: string;

        /**
         * The disk's logical sectors as the guest sees them: 512 bytes (the
         * default) or 4096. IDE and AHCI report them in IDENTIFY (words 106,
         * 117-118) and count LBAs, the capacity and PIO blocks in them;
         * virtio-blk reports them as blk_size. For RAW and the formats that
         * do not record a sector size (QCOW2, VHD, VDI, VMDK); a VHDX image
         * has its own, which this must equal, and a child takes its parent's.
         * The disk's size must be a multiple. The BIOS (SeaBIOS) does not
         * boot from a disk of 4096-byte sectors, and DOS cannot use one; on
         * IDE the guest must move data by DMA (Linux's libata in PIO mode
         * times out), AHCI and virtio-blk have no such limit. The physical
         * sector size reported equals the logical one (as QEMU's default).
         */
        logical_sector_size?: 512 | 4096;
    };

/**
 * A hard disk image
 */
export type V86HardDiskImage = V86Image & V86DiskImageOptions;

/**
 * Config for virtio/serial console.
 */
export type ConsoleConfig =
    {
        /**
         * Console type
         *
         * Available types:
         *  - `textarea` - using TextArea HTML element, doesn't support ESC codes
         *  - `xtermjs` - using XtermJS-compatible terminal
         */
        type: "textarea" | "xtermjs" | "none";

        /** XtermJS constructor, useful for ESM users. When not set, `window["Terminal"]` is used */
        xterm_lib?: Function;

        /** HTML container for console */
        container?: HTMLElement | HTMLTextAreaElement;
    };

/**
 * Config for emulator screen.
 */
export type ScreenConfig =
    {
        /**
         * HTML container for emulator screen. This should have a certain structure.
         * @see {@link https://github.com/speedyHKjournalist/v64/blob/master/examples/basic.html} for example
         */
        container?: HTMLElement | null;

        /** Explicit VGA 2D canvas. Graphics overlays always use a different canvas. */
        canvas?: HTMLCanvasElement;

        /**
         * Encoding for text mode screen
         * @default "cp437"
         */
        encoding?: "ascii" | "cp437" | "cp858";

        /**
         * Screen scaling
         * @default 1
         */
        scaling?: number;

        /**
         * Use canvas for text mode (browser only) with VGA fonts.
         * @default false
         */
        use_graphical_text?: boolean;

        /**
         * Use ANSI Truecolor codes for text mode output.
         * @default false
         */
        ansi?: boolean;
    };

/**
 * Debug log levels.
 */
export enum LogLevel {
    LOG_ALL = -1,
    LOG_NONE = 0,
    LOG_OTHER = 0x000001,
    LOG_CPU = 0x000002,
    LOG_FPU = 0x000004,
    LOG_MEM = 0x000008,
    LOG_DMA = 0x000010,
    LOG_IO = 0x000020,
    LOG_PS2 = 0x000040,
    LOG_PIC = 0x000080,
    LOG_VGA = 0x000100,
    LOG_PIT = 0x000200,
    LOG_MOUSE = 0x000400,
    LOG_PCI = 0x000800,
    LOG_BIOS = 0x001000,
    LOG_FLOPPY = 0x002000,
    LOG_SERIAL = 0x004000,
    LOG_DISK = 0x008000,
    LOG_RTC = 0x010000,
    LOG_HPET = 0x020000,
    LOG_ACPI = 0x040000,
    LOG_APIC = 0x080000,
    LOG_NET = 0x100000,
    LOG_VIRTIO = 0x200000,
    LOG_9P = 0x400000,
    LOG_SB16 = 0x800000,
    LOG_FETCH = 0x1000000,
    LOG_MODEM = 0x2000000,
}

/**
 * Boot order.
 */
export enum BootOrder {
    AUTO = 0,
    CD_FLOPPY_HARDDISK = 0x213,
    CD_HARDDISK_FLOPPY = 0x123,
    FLOPPY_CD_HARDDISK = 0x231,
    FLOPPY_HARDDISK_CD = 0x321,
    HARDDISK_CD_FLOPPY = 0x132,
}

/**
 * Emulator events.
 */
export interface Event {
    "9p-attach": void;
    "9p-read-end": [filename: string, byte_count: number];
    "9p-read-start": [filename: string];
    "9p-write-end": [filename: string, byte_count: number];
    /** The guest turned the machine off through ACPI; the value is the sleeping state ("S5", or "S4" for hibernation). The emulator stops. */
    "acpi-power-off": "S4" | "S5";
    "acpi-sleep": "S3";
    "acpi-wake": "power-button" | "rtc" | "other";
    "download-error": {
        file_index: number,
        file_count: number,
        file_name: string,
        request: any,
    };
    "download-progress": {
        file_index: number,
        file_count: number,
        file_name: string,
        lengthComputable: boolean,
        total: number,
        loaded: number,
    };
    /**
     * A disk's read, write or flush failed (docs/disk-persistence-plan.md
     * "错误处理"). With the disk's disk_error "stop" (the default) the
     * request stays unfinished and the machine stops: run() retries the
     * held requests in their order (those that cannot be retried, such as
     * an image that changed while it was read, are then reported to the
     * guest), destroy() drops them; save_state is refused meanwhile. With
     * "report" the guest's command ends with the device's error status.
     */
    "disk-error": {
        /** hda, hdb, cdrom, sata<port>, virtio_disk<n>, usb:<id> */
        disk: string,
        operation: "read" | "write" | "flush",
        offset: number,
        length: number,
        reason: string,
        retryable: boolean,
        policy: "stop" | "report",
    };
    /** The start failed (an image could not be loaded or opened, the CPU Worker did not start): the emulator does not run */
    "emulator-error": Error;
    "emulator-loaded": void;
    "emulator-ready": void;
    "emulator-started": void;
    "emulator-stopped": void;
    "eth-receive-end": [byte_count: number];
    "eth-transmit-end": [byte_count: number];
    /**
     * Disk activity of hda/hdb (channel 0) and the CD drive (channel 1), on
     * IDE and on the AHCI ports of machine_type "q35" alike (there the channel
     * is the one the drive would have on IDE).
     */
    "ide-read-end": [channel_nr: number, byte_count: number, sector_count: number];
    "ide-read-start": void;
    "ide-write-end": [channel_nr: number, byte_count: number, sector_count: number];
    "mouse-enable": boolean;
    "net0-send": Uint8Array;
    /**
     * A text cell sent to the screen: one that a write changed, or each cell
     * when the whole screen is sent again (after a palette, font or mode
     * change, at most once a frame). With the CPU in a worker it comes once
     * the page's screen has the character.
     */
    "screen-put-char": [row: number, col: number, chr: number];
    "screen-set-size": [width: number, height: number, bpp: number];
    "serial0-input": number;
    "serial0-output-byte": number;
    "serial1-input": number;
    "serial1-output-byte": number;
    "serial2-input": number;
    "serial2-output-byte": number;
    "serial3-input": number;
    "serial3-output-byte": number;
    "parallel0-data-output": number;
    "parallel0-control-output": number;
    "parallel0-status-input": number;
    "parallel1-data-output": number;
    "parallel1-control-output": number;
    "parallel1-status-input": number;
    /** The guest configured the USB tablet (true) or let it go (false): while it uses it, the tablet has the page's pointer */
    "usb-tablet-active": boolean;
    /** a byte of the UEFI firmware's debug log (firmware.debug_console) */
    "debug-console-output-byte": number;
    /** The guest ejected a USB disk's medium (its id): it can be detached now */
    "usb-disk-ejected": string;
    "virtio-console0-output-bytes": Uint8Array;
    "virtio-console0-input-bytes": Uint8Array;
    "virtio-console0-resize": [cols: number, rows: number];
    "vmware-absolute-mouse": boolean;
}

/**
 * @ignore
 * @constructor
 *
 * @param {string=} message
 */
declare class FileExistsError extends Error {
    constructor(message: string);
}

/**
 * @ignore
 * @constructor
 *
 * @param {string=} message
 */
declare class FileNotFoundError extends Error {
    constructor(message: string);
}

/**
 * Network device configuration.
 * @see {@link https://github.com/speedyHKjournalist/v64/blob/master/docs/networking.md} for more infos
 */
type V86NetworkDevice =
    {
        /**
         * The type of emulated NIC provided to the guest OS.
         * Recommended to use `ne2k` for old OSes, `e1000` (an Intel 82540EM, whose drivers come with
         * Windows Vista to 11 and Linux) for Windows, and `virtio` for modern Linux. `ne2k` and `e1000`
         * are plugins, build/v86-ne2k.js and build/v86-e1000.js, loaded beside the bundle (or from
         * `plugin_path`). `none`: no network card.
         * @default "ne2k"
         */
        type?: "ne2k" | "virtio" | "e1000" | "none";

        /**
         * Where the plugin of the card (type `ne2k`, `e1000`) is, a path or URL
         * @default build/v86-<type>.js beside the bundle (with the bundle's query, e.g. ?v=<revision>)
         */
        plugin_path?: string;

        /**
         * The network backend URL.
         * Note that the CORS proxy server of the fetch backend is defined in field `cors_proxy` below.
         * @see {@link https://github.com/speedyHKjournalist/v64/blob/master/docs/networking.md#backend-url-schemes} for backend URL schemes
         */
        relay_url?: string;

        /**
         * Network id, all v86 network instances with the same id share the same network namespace.
         * On machine_type "virt" with `count`, the NIC the backend serves (net<id>).
         * @todo class NetworkAdapter should also get options.net_device as an argument, at least options.net_device.id.
         * @default 0
         */
        id?: number;

        /**
         * machine_type "virt" with type "virtio" only: this many virtio-net functions, NICs net0, net1, ...
         * (Android's three, as Cuttlefish's: its Wi-Fi is on the third); the backend serves `id`'s
         * @default 1
         */
        count?: number;

        /**
         * MAC address of virtual network peers (ARP, PING, DHCP, DNS, NTP, UDP echo and TCP peers) in common MAC
         * address notation (fetch/wisp only).
         * @default "52:54:0:1:2:3"
         */
        router_mac?: string;

        /**
         * IP address of virtual network peers (ARP, PING, DHCP, DNS and TCP peers) in dotted IP notation (fetch/wisp only).
         * @default "192.168.86.1"
         */
        router_ip?: string;

        /**
         * IP address to be assigned to the guest by DHCP in dotted IP notation (fetch/wisp only).
         * @default "192.168.86.100"
         */
        vm_ip?: string;

        /**
         * Network masquerade (fetch/wisp only).
         *
         * If true, announce `router_ip` as the router's and DNS server's IP addresses in generated
         * DHCP replies, and also generate ARP replies to IPs outside the router's subnet `255.255.255.0`.
         * @default true
         */
        masquerade?: boolean;

        /**
         * DNS method to use (fetch/wisp only).
         *
         * Available methods:
         * - `static`: use built-in DNS server
         * - `doh`: use DNS-over-HTTPS (DoH)
         * @default `static` for `fetch` or `doh` for `wisp` backend
         * @see {@link https://en.wikipedia.org/wiki/DNS_over_HTTPS} about DNS over HTTPS
         */
        dns_method?: "static" | "doh";

        /**
         * Host name or IP address (and optional port number) of the DoH server if `dns_method` is `doh`.
         *
         * The value is expanded to the URL `https://DOH_SERVER/dns-query`.
         * @default "cloudflare-dns.com"
         */
        doh_server?: string;

        /**
         * CORS proxy server URL, do not use a proxy if undefined (`fetch` backend only).
         */
        cors_proxy?: string;

        /**
         * The MTU used for the virtual network. Increasing it can improve performance. This only works if the NIC type is `virtio`.
         * @default 1500
         */
        mtu?: number;
    } & PCIeRootPortPlacement;

/**
 * Where a built-in device goes on a machine_type "q35" machine (net_device,
 * filesystem, virtio_console, virtio_balloon; virtio_devices descriptors
 * have the same fields): behind a PCI Express root port instead of a slot of
 * bus 0, as the card in the port's hot plug slot (see
 * {@link V86.attach_pcie_device}, {@link V86.detach_pcie_device}).
 */
export interface PCIeRootPortPlacement {
    /**
     * Put the device behind PCI Express root port n (from 0, with
     * pcie_root_ports above n), as device 0 of the port's secondary bus. One
     * device per root port. The guest numbers the bus and opens the port's
     * windows (SeaBIOS does). An NE2000 there gets its I/O ports from 0x1300.
     */
    pcie_root_port?: number;

    /**
     * false: the slot starts empty, attach_pcie_device plugs the device in.
     * @default true
     */
    pcie_plugged?: boolean;
}

/**
 * Emulator instance constructor options.
 */
export interface V86Options {
    /** Keep CPU, JIT, RAM and synchronous devices in a dedicated browser Worker.
     * Defaults to false for the library. The demo UI enables it by default.
     * Requires serializable image descriptors; wasm_fn/handle9p callbacks stay in main-thread mode.
     */
    cpu_worker?: boolean;
    /** Worker bundle URL, relative to the page. Default: build/cpu-worker.js. */
    cpu_worker_url?: string;
    /**
     * The display hardware the guest sees, like QEMU's -vga. Required.
     * Each adapter is a plugin file (build/v86-<name>.js, e.g.
     * build/v86-bochs-vga.js) that is loaded only when named here; "none"
     * gives a machine without a display (serial console only).
     * "bochs_vga" is the display v86 always had. "vmware_svga" (VMware SVGA
     * II) and "virtio_gpu" (virtio-gpu as virtio-vga) offer 3D when the page
     * has loaded build/glbridge/libv86-webgpu.js and WebGPU has an adapter,
     * and 2D only otherwise (docs/gpu-devices.md).
     */
    graphics_adapter: "bochs_vga" | "vmware_svga" | "virtio_gpu" | "none";
    /**
     * Path or URL of the graphics_adapter's plugin file. By default
     * v86-<name>.js beside the libv86 bundle when the bundle knows its own
     * location (libv86.js as a classic script in a page, libv86.mjs,
     * CommonJS in node), otherwise build/v86-<name>.js relative to the page,
     * like wasm_path. Without cpu_worker, a page may also load the plugin
     * file itself first; it registers in globalThis.V86GraphicsAdapters.
     */
    graphics_adapter_path?: string;
    /**
     * Forward the guest's Direct3D/DirectDraw/OpenGL calls to WebGPU. Needs
     * build/glbridge/libv86-webgpu.js loaded before the emulator is created,
     * a browser screen container, and the v86gl driver and proxy DLLs in the
     * guest (docs/glbridge.md). Works with any graphics_adapter.
     */
    graphics_proxy?: boolean | V86GraphicsProxyOptions;
    /**
     * Custom virtio devices. v86 provides the PCI function, the virtqueues,
     * the interrupt and the transport's part of a snapshot; the descriptor
     * implements the device. Descriptors run on the CPU's thread, so they
     * cannot be combined with cpu_worker.
     */
    virtio_devices?: VirtioDeviceDescriptor[];
    /**
     * Reference to the v86 wasm exported function.
     */
    wasm_fn?: (options: WebAssembly.Imports) => Promise<WebAssembly.Exports>;

    /**
     * Path to v86 wasm artifact
     * @default "build/v86.wasm" or "build/v86-debug.wasm" when debug mode enabled
     */
    wasm_path?: string;
    /** Portable core URL; defaults to the primary name with -fallback.wasm. */
    wasm_fallback_path?: string;

    /**
     * The memory size in bytes, should be a power of 2. At most 2 GiB - 128 KiB
     * (wasm32); larger values are reduced to that with a console warning.
     * @example 16 * 1024 * 1024
     * @default 64 * 1024 * 1024
     */
    memory_size?: number;

    /**
     * Testing option: place this many bytes of memory_size at guest physical
     * 4 GiB instead of below it (a multiple of 1 MiB). The relocated range is
     * absent from the low address space; firmware reports it as RAM above
     * 4 GiB. Total capacity is still limited to memory_size.
     * @default 0
     */
    high_memory_size?: number;

    /**
     * Experimental: guest RAM beyond memory_size (a multiple of 2 MiB), at
     * guest physical 4 GiB + high_memory_size (cpu_type: "arm64": at 4 GiB,
     * a second memory range of the device tree), so that the total can
     * exceed what fits in the emulator's 32-bit WebAssembly memory. Its
     * pages are kept in host ArrayBuffers and cached in
     * extended_memory_cache bytes of the WebAssembly heap: slower than
     * memory_size. Only a 64-bit guest (cpu_type: "x86_64" or "arm64") can
     * address it.
     * Snapshots of it need save_state_stream. Fails at startup when the host
     * cannot allocate it.
     * @default 0
     */
    extended_memory_size?: number;
    /** Testing option: bytes of the WebAssembly heap that cache extended RAM (default 512 MiB). */
    extended_memory_cache?: number;

    /**
     * Video memory of the graphics_adapter in bytes, a power of two (formerly
     * vga_memory_size, which is now an error). At least 4 MiB for
     * "vmware_svga" and 16 MiB for "virtio_gpu".
     * @example 8 * 1024 * 1024
     * @default 8 * 1024 * 1024 for "bochs_vga", 32 * 1024 * 1024 for
     *     "vmware_svga" and "virtio_gpu"
     */
    vram_size?: number;

    /**
     * If emulation should be started when emulator is ready.
     * @default false
     */
    autostart?: boolean;

    /**
     * If keyboard should be disabled (only browsers).
     */
    disable_keyboard?: boolean;

    /**
     * If mouse should be disabled (only browsers).
     */
    disable_mouse?: boolean;

    /**
     * If speaker should be disabled (only browsers).
     */
    disable_speaker?: boolean;

    /**
     * BIOS image (supported SeaBIOS and Bochs BIOS)
     * @see {@link https://github.com/speedyHKjournalist/v64/tree/master/bios} for BIOS images
     */
    bios?: V86Image;

    /**
     * VGA BIOS image
     * @see {@link https://github.com/speedyHKjournalist/v64/tree/master/bios} for BIOS images
     */
    vga_bios?: V86Image;

    /**
     * The machine's firmware, on the PC machines: SeaBIOS (`bios` and `vga_bios`, the default)
     * or UEFI. UEFI is OVMF, X64 (bios/ovmf-code.fd and bios/ovmf-vars.fd: edk2-stable202408 as
     * QEMU 9.2.0 ships it, see bios/fetch-ovmf.sh), mapped as flash below 4 GiB: the variable
     * store, then the code (or `code` alone, an image holding both). It needs cpu_type "x86_64",
     * acpi: true and, on i440FX, qemu_compatible: true; it takes the place of `bios` and
     * `vga_bios`. The variable store is CFI flash; with `disk_option: "read_write"` its writes go
     * back into its image, as a disk's (else they stay in memory). See docs/uefi.md.
     */
    firmware?: {
        type: "seabios" | "uefi";
        code?: V86Image;
        vars?: V86HardDiskImage;
        /**
         * The firmware is a Secure Boot build that keeps its variables in SMM (edk2's
         * SMM_REQUIRE: bios/ovmf-secure-code.fd): the variable store is written only by code in
         * SMM, as QEMU's pflash with secure=on. It needs machine_type "q35" and `vars`. Whether
         * Secure Boot is on is the variable store's: the keys enrolled in it (docs/uefi.md).
         */
        secure_boot?: boolean;
        /**
         * QEMU's debug console at port 0x402: the firmware's debug log, byte by byte, as the
         * "debug-console-output-byte" event
         */
        debug_console?: boolean;
    };

    /**
     * A TPM 2.0 on the PC machines (a plugin, build/v86-tpm.js, with build/libtpms.wasm beside it):
     * libtpms behind the CRB interface at 0xFED40000, described by the ACPI tables (MSFT0101,
     * TPM2); it needs acpi: true. `state` keeps the TPM's permanent state (a 512 KiB image; with
     * disk_option "read_write" written back, else in memory; zeros: a new TPM). See docs/tpm.md.
     */
    tpm?: {
        version?: "2.0";
        interface?: "crb";
        state?: V86HardDiskImage;
        plugin_path?: string;
        wasm_path?: string;
    };

    /**
     * First hard disk
     */
    hda?: V86HardDiskImage;

    /**
     * Second hard disk
     */
    hdb?: V86HardDiskImage;

    /**
     * First floppy disk. disk_option "read_write" writes the guest's
     * changes back (docs/disk-persistence-plan.md D3: a local file in Node,
     * a disk service's URL; the image of a floppy format's size).
     * disk_error as for hard disks: "stop" (the default) holds a failed
     * transfer and stops the machine, run() tries it again; "report" ends
     * the command with an error. A held transfer of a disk taken out ends
     * with the error.
     */
    fda?: V86Image & { disk_option?: "read_only" | "read_write"; disk_error?: "stop" | "report"; token?: string };

    /**
     * Second floppy disk, as fda
     */
    fdb?: V86Image & { disk_option?: "read_only" | "read_write"; disk_error?: "stop" | "report"; token?: string };

    /**
     * CD-ROM
     * By default, an ejected CD-ROM drive is emulated
     */
    cdrom?: V86Image;

    /**
     * A Linux kernel image to boot (only bzimage format)
     */
    bzimage?: V86Image;

    /**
     * Kernel boot cmdline
     */
    cmdline?: string;

    /**
     * A Linux ramdisk image
     */
    initrd?: V86Image;

    /**
     * machine_type "virt" only (in development: docs/aarch64.md): an arm64
     * Linux Image or EFI zboot image to boot
     */
    kernel?: V86Image;

    /**
     * machine_type "virt" only, for debugging: a device tree instead of the
     * one v86 generates from the platform
     */
    dtb?: V86Image;

    /**
     * machine_type "virt" only: virtio-blk disks in order (not together
     * with hda and hdb, which are the first two on virt). Each may be in a
     * container format as hda (export_disk_image names it virtio_disk<n>);
     * a read or write its image fails ends with an I/O error
     * (VIRTIO_BLK_S_IOERR).
     */
    virtio_disks?: Array<V86HardDiskImage & { readonly?: boolean; id?: string }>;

    /**
     * machine_type "virt" only: virtio-rng, its entropy from
     * crypto.getRandomValues (the guest's /dev/hwrng)
     */
    virtio_rng?: boolean;

    /**
     * machine_type "virt" only: virtio-input devices, true for a keyboard and
     * a tablet, or a list of "keyboard", "tablet" (the pointer's absolute
     * position) and "multitouch" (the page's touches), as QEMU's
     * virtio-keyboard, virtio-tablet and virtio-multitouch
     */
    virtio_input?: boolean | Array<"keyboard" | "tablet" | "multitouch">;

    /**
     * machine_type "virt" only: virtio-vsock, the guest CID 3 (the host
     * side, CID 2, connects with vsock_connect; the guest's own connections
     * to the host are refused). Android's adbd listens on its port 5555.
     */
    virtio_vsock?: boolean;

    /**
     * machine_type "virt" only: virtio-snd with one output stream (PCM, 1 or
     * 2 channels, S16 or S32, 8000 to 48000 Hz), played on the machine's
     * clock to the speaker; each buffer played is also sent on the bus as
     * "virtio-snd-pcm" ({stream, rate, channels, format, bytes})
     */
    virtio_sound?: boolean;

    /**
     * machine_type "virt" only: virtio-console with this many ports, all
     * consoles (hvc0, hvc1, ...); without it 4 ports, 1-3 generic ones named
     * org.v86.port<N>
     */
    virtio_console_ports?: number;

    /**
     * machine_type "virt" with virtio_transport "pci" only: the PCI slot of
     * the display adapter (the other devices skip it), as Cuttlefish puts its
     * GPU at 00:02.0
     */
    virtio_gpu_pci_slot?: number;

    /**
     * machine_type "virt" only: the virtio devices' transport, virtio-mmio
     * slots or functions on the PCIe host (see docs/virt.md)
     * @default "mmio"
     */
    virtio_transport?: "mmio" | "pci";

    /**
     * Automatically fetch bzimage and initrd from the 9p filesystem
     */
    bzimage_initrd_from_filesystem?: boolean;

    /**
     * Multiboot image
     */
    multiboot?: V86Image;

    /**
     * An initial state to load
     * @see {@link V86.prototype.save_state}
     */
    initial_state?: V86Image;

    /**
     * Should the MAC address be preserved from the state image, for operating systems that
     * don't allow you to reload the network card driver
     * @default false
     * @see {@link https://github.com/speedyHKjournalist/v64/blob/master/docs/networking.md#v86-run-time-state-images}
     */
    preserve_mac_from_state_image?: boolean;

    /**
     * A 9p filesystem is supported by the emulator, using a virtio transport. Using it, files can be exchanged with the guest OS
     * If `basefs` and `baseurl` are omitted, an empty 9p filesystem is created.
     */
    filesystem?: {
        /**
         * A URL to a JSON file created using [fs2json](https://github.com/speedyHKjournalist/v64/blob/master/tools/fs2json.py).
         */
        baseurl?: string;

        /**
         * A directory of 9p files, as created by [copy-to-sha256.py](https://github.com/speedyHKjournalist/v64/blob/master/tools/copy-to-sha256.py).
         * @see {@link https://github.com/speedyHKjournalist/v64/blob/master/docs/filesystem.md} for more details
         */
        basefs?: string;

        /**
         * A function that will be called for each 9p request.
         * If specified, this will back Virtio9p instead of a filesystem.
         * Use this to build or connect to a custom 9p server.
         */
        handle9p?: (reqbuf: Uint8Array, reply: (replybuf: Uint8Array) => void) => void;

        /**
         * A URL to a websocket proxy for 9p.
         * If specified, this will back Virtio9p instead of a filesystem.
         * Use this to connect to a custom 9p server over websocket.
         */
        proxy_url?: string;
    } & PCIeRootPortPlacement;

    /**
     * A textarea that will receive and send data to the emulated serial terminal (only browsers).
     * Alternatively the serial terminal can also be accessed programatically, see
     * [examples/serial.html](https://github.com/speedyHKjournalist/v64/blob/master/examples/serial.html) for example.
     * Deprecated in favor of {@link V86Options.serial_console}.
     * @deprecated
     * @see {@link V86Options.serial_console}
     */
    serial_container?: HTMLTextAreaElement;

    /**
     * Xtermjs serial terminal container (only browsers). When set, serial_container option is ignored.
     * Deprecated in favor of {@link V86Options.serial_console}.
     * @deprecated
     * @see {@link V86Options.serial_console}
     */
    serial_container_xtermjs?: HTMLElement;

    /**
     * Console adapter for serial console
     */
    serial_console?: ConsoleConfig;

    /**
     * Console adapter for virtio console.
     * Setting to true, creates virtio console device without adapter
     */
    virtio_console?: ConsoleConfig | (Partial<ConsoleConfig> & PCIeRootPortPlacement);

    /**
     * Emulator screen element (only browsers).
     * Only provided for backwards compatibility, use {@link V86Options.screen} instead.
     * @deprecated
     * @see {@link https://github.com/speedyHKjournalist/v64/blob/master/examples/basic.html} for example
     */
    screen_container?: HTMLElement | null;

    /**
     * Emulator screen config
     */
    screen?: ScreenConfig;

    /**
     * Enable ACPI (also enables APIC). Experimental. Implemented: PM1 event,
     * control and timer registers, GPE0, SCI, SMI_CMD ACPI enable/disable,
     * the fixed power button (see power_button()) and the sleeping states:
     * S3 (suspend to RAM: the cores stop, "acpi-sleep" is emitted; the power
     * button or an RTC alarm with RTC_EN wakes the machine through the
     * firmware's resume path, "acpi-wake"), S4 (the guest hibernates to its
     * disk and turns the machine off) and S5 (soft off); after S4/S5 the
     * emulator stops and emits "acpi-power-off". See power_state().
     * @default false (true with machine_type "q35")
     */
    acpi?: boolean;

    /**
     * The chipset. "i440fx": i440FX host bridge, PIIX3/PIIX4 and IDE (hda,
     * hdb and cdrom on the IDE channels). "q35": Q35 host bridge with PCI
     * Express configuration space (ECAM), ICH9 LPC with its power management,
     * and an ICH9 AHCI controller with six SATA ports: hda on port 0, hdb on
     * port 1 and an ATAPI drive on port 2 that holds cdrom (empty without
     * it). Q35 always has ACPI; acpi: false is an error. Guests should have
     * an AHCI driver: the firmware disk services reach the AHCI controller
     * from virtual-8086 mode (DOS with EMM386, Windows 3.x enhanced mode,
     * Windows 9x compatibility mode) only through system management mode,
     * two SMIs per call, so such guests are better off on "i440fx". A
     * snapshot only restores into an emulator of the same machine type. See
     * docs/q35.md.
     *
     * "virt" is the machine of cpu_type "arm64" and "arm32" (and their default; see
     * docs/virt.md): no PC firmware, chipset or VGA. The PC machines' options
     * (bios, vga_bios, fda, fdb, cdrom, bzimage, multiboot, acpi: true, hpet,
     * smbus, pcie_root_ports, qemu_compatible, uart1-3, parallel1, modem,
     * cpuid_level, cpu_features, x87_*, high_memory_size) are errors there,
     * as are kernel, dtb, virtio_disks, virtio_rng, virtio_input and
     * virtio_transport on the PC machines, and every
     * other combination of cpu_type and machine_type.
     *
     * "ranchu" is the Android Emulator's board, for cpu_type "arm64" and
     * "arm32" (docs/virt.md, "The ranchu machine"): the virt machine's RAM,
     * PL011, timer and virtio-mmio slots (the legacy transport), the
     * emulator's goldfish devices and its framebuffer (graphics_adapter
     * "none"), a GICv2 with "arm32"; no PCIe.
     * @default "i440fx" ("virt" with cpu_type "arm64" or "arm32")
     */
    machine_type?: "i440fx" | "q35" | "virt" | "ranchu";

    /**
     * machine_type "ranchu" only: the display (the framebuffer's size in
     * pixels, the density the boot properties give)
     * @default { width: 480, height: 800, dpi: 240 }
     */
    ranchu_display?: { width: number; height: number; dpi: number };

    /**
     * machine_type "ranchu" only: boot properties added to the emulator's
     * (qemu.sf.lcd_density, qemu.hw.mainkeys), which qemu-props sets
     */
    ranchu_properties?: { [name: string]: string };

    /**
     * machine_type "ranchu" only: the emulator image's GPU (docs/gles-proxy-plan.md).
     * "guest": the guest renders (the kernel command line's qemu.gles=0);
     * "host": its GL libraries send GLES over the pipe's "opengles" to the
     * GLES host, the plugin build/v86-gles.js (qemu.gles=1 on the command
     * line, ro.opengles.version in ranchu_properties). The android option
     * sets it from the device model's gpu_mode.
     * @default "guest"
     */
    ranchu_gpu?: "guest" | "host";

    /**
     * machine_type "ranchu", ranchu_gpu "host": the highest OpenGL ES version
     * the GLES host announces (ANDROID_EMU_gles_max_version_*; the guest's
     * contexts and ro.opengles.version follow it; docs/gles3-plan.md); an
     * emulator image's android.gles_version where this is not given
     * @default "3.0"
     */
    ranchu_gles_version?: "2.0" | "3.0" | "3.1" | "3.2";

    /**
     * The GLES host's GLSL ES compiler (glslang, ranchu_gpu "host")
     * @default beside the bundle, glslang.wasm
     */
    gles_glslang_path?: string;

    /**
     * The GLES host's plugin file (ranchu_gpu "host", gles_backdoor)
     * @default beside the bundle, v86-gles.js
     */
    ranchu_gpu_path?: string;

    /**
     * cpu_type "arm32" on machine_type "virt" only: the GLES backdoor of user
     * code (docs/gles-proxy-plan.md "iOS 传输"): UDF #0x8664 at PL0 with r0's
     * top half 0x8664 calls the GLES host's services ("opengles",
     * "GLProcessPipe"), which the plugin build/v86-gles.js gives, drawn by
     * the page's WebGPU renderer. Off: those UDFs are undefined instructions.
     * @default false
     */
    gles_backdoor?: boolean;

    /**
     * machine_type "q35" only: the number of ICH9 PCI Express root ports
     * (00:1c.0 and up, 0 to 6). Each is a PCI-to-PCI bridge whose secondary
     * bus can hold a device (pcie_root_port in the options of net_device,
     * filesystem, virtio_console, virtio_balloon and virtio_devices); the
     * guest numbers the buses and opens the bridges' windows itself (SeaBIOS
     * does). Each port has a slot with PCI Express native hot plug (attention
     * button, power controller, indicators, presence detect, data link layer
     * events; MSI or INTx), which the ACPI tables give the guest through
     * _OSC; see {@link V86.attach_pcie_device}.
     * @default 0
     */
    pcie_root_ports?: number;

    /**
     * machine_type "q35" only: ICH9's High Precision Event Timer at
     * 0xFED00000 (three timers, 14.31818 MHz), described by the ACPI HPET
     * table. Guests may then use it as clock source and timer (Linux:
     * clocksource=hpet; Windows takes its clock interrupt from it, as FSB
     * messages); with its legacy replacement route, it takes IRQ 0 and 8
     * from the PIT and the RTC.
     * @default false
     */
    hpet?: boolean;

    /**
     * machine_type "q35" only: ICH9's SMBus controller (00:1f.3) with eight
     * 256-byte SPD EEPROMs at 0x50-0x57, as QEMU's Q35 has it. Off by
     * default, which keeps the machine's set of devices (Windows 8.1 knows
     * the controller from its own INF).
     * @default false
     */
    smbus?: boolean;

    /**
     * Number of CPU cores available to the guest operating system, from 1 to 8.
     * Execution is managed by the emulator; no additional CPU mode is required.
     * Multiple cores currently require acpi: true. Snapshots require the same
     * core count when restored. Multicore support is experimental.
     * @default 1
     */
    cpu_cores?: number;
    /** Testing option. All device clocks and TSC share this domain; deterministic mode uses the interpreter.
     * rate (normal mode, at most 1, cooperative cores): the machine's milliseconds per host millisecond, so that the
     * guest's timeouts get more host time on a slow CPU (its wall clock lags). */
    cpu_clock?: { mode?: "normal" | "deterministic"; instructions_per_ms?: number;
        wall_epoch_ms?: number; max_host_delta_ms?: number; rate?: number };
    /** Testing option: work budget for each CPU scheduling slice. */
    cpu_quantum?: number;
    /** Testing option: seed for reproducible CPU scheduling. */
    cpu_schedule_seed?: number;
    /** Testing option: opt into multicore JIT while the cross-core stress matrix is being qualified. */
    experimental_smp_jit?: boolean;
    /**
     * The guest's CPU. "x86" is the 32-bit CPU v86 always had; "x86_64"
     * (experimental) adds long mode, NX, SYSCALL, CMPXCHG16B, ..., needed by
     * 64-bit operating systems such as Windows 8.1 x64 or x86_64 Linux.
     * "arm64" (experimental, in development: docs/aarch64.md) is an Armv8.0-A
     * CPU on machine_type "virt", with its own core (v86-arm64.wasm);
     * "arm32" (in development: docs/aarch32-plan.md part 2) the same core in
     * AArch32 throughout, a 32-bit Arm (ARMv7-A, Cortex-A15-like) CPU for
     * 32-bit kernels on the same machine.
     * Other values fail at startup.
     * @default "x86"
     */
    cpu_type?: "x86" | "x86_64" | "arm64" | "arm32";

    /**
     * The CPU model: which CPU the guest sees. Each runs on one cpu_type
     * (given alone, it picks cpu_type); the generic- ones are v86's own and
     * each cpu_type's default. "generic-x86" (cpu_type "x86"),
     * "generic-x86-64" ("x86_64"), "generic-arm64" ("arm64": Armv8.0-A with
     * FEAT_PAN, 64-bit programs only), "generic-arm64-compat32" (that and
     * AArch32 at EL0: a 64-bit kernel with COMPAT runs 32-bit Arm programs,
     * armhf and armeabi-v7a; docs/aarch32-plan.md), "cortex-a15" ("arm32").
     * "generic-arm64-v1.1" and "generic-arm64-v1" (generic-arm64 without
     * FEAT_PAN; v1 the 4 KiB granule only) are for regression tests against
     * QEMU. See
     * [docs/aarch64.md](https://github.com/speedyHKjournalist/v64/blob/master/docs/aarch64.md),
     * "CPU profile". A restored snapshot takes its own model.
     * @default the cpu_type's generic model ("cortex-a15" for "arm32")
     */
    cpu_profile?: "generic-x86" | "generic-x86-64" | "generic-arm64" | "generic-arm64-compat32" | "generic-arm64-v1" | "generic-arm64-v1.1" |
        "cortex-a15";

    /**
     * CPU features beyond the base profile, reported by CPUID: SSSE3, SSE4.1
     * and SSE4.2, by name or as the preset "x86-64-v2" (with
     * cpu_type: "x86_64", what x86-64-v2 requires: RHEL 9, Windows 11 24H2);
     * XSAVE (XSAVE/XRSTOR, XSETBV/XGETBV with the x87 and SSE state) and AVX
     * (the VEX.128 and VEX.256 forms and the YMM state); AVX2, FMA, F16C,
     * BMI1, BMI2, LZCNT and MOVBE, or with cpu_type: "x86_64" the preset
     * "x86-64-v3" (what RHEL 10 requires; LZCNT only with cpu_type:
     * "x86_64"); XSAVEOPT, XSAVEC, XGETBV1 and XSAVES (the XSAVE family:
     * Linux then saves the state in the compacted format).
     * A feature needs those it builds on (SSE4.1 needs SSSE3; SSE4.2 needs
     * SSE4.1; AVX needs XSAVE and SSE4.2; AVX2, FMA and F16C need AVX; the
     * XSAVE family needs XSAVE, XSAVES needs XSAVEC); other combinations fail
     * at startup. Not set: all of them with cpu_type "x86_64", none with
     * "x86" ([] gives none); a restored snapshot's features then replace them.
     * See [docs/x86-64.md](https://github.com/speedyHKjournalist/v64/blob/master/docs/x86-64.md).
     */
    cpu_features?: Array<"SSSE3" | "SSE4.1" | "SSE4.2" | "XSAVE" | "AVX" | "AVX2" | "FMA" | "F16C" | "BMI1" | "BMI2" |
        "LZCNT" | "MOVBE" | "XSAVEOPT" | "XSAVEC" | "XGETBV1" | "XSAVES"> | "x86-64-v2" | "x86-64-v3";

    /**
     * Log level (for debug builds)
     * @default LogLevel.LOG_NONE
     */
    log_level?: LogLevel;

    /**
     * Boot order
     * @default BootOrder.AUTO
     */
    boot_order?: BootOrder;

    /**
     * Fast boot, skips boot menu in bochs bios
     * @default false
     */
    fastboot?: boolean;

    /**
     * Enable the boot menu (seabios)
     * @default false
     */
    bootmenu?: boolean;

    /**
     * Create a virtio balloon device
     * @default false
     */
    virtio_balloon?: boolean | PCIeRootPortPlacement;

    /**
     * Override the maximum supported cpuid level
     * Used for some versions of Windows, see [docs/windows-nt.md](https://github.com/speedyHKjournalist/v64/blob/master/docs/windows-nt.md)
     */
    cpuid_level?: number;

    /**
     * Turn off the x86-to-wasm jit
     * @default false
     */
    disable_jit?: boolean;
    /** Compiler selection. IR is the only backend (the legacy one was removed). */
    jit_backend?: "ir";
    /**
     * Deprecated and ignored: the IR region tiers' settings (docs/jit-unification-plan.md
     * M11 deleted the region tiers; the x64 page tier compiles all code).
     */
    ir_stats?: "off" | "sampled" | "debug";
    /** Deprecated and ignored (see ir_stats). */
    ir_verify?: "off" | "debug" | "every_pass";
    /** Deprecated and ignored (see ir_stats). */
    ir_dump?: "off" | "hir" | "mir" | "wasm" | "all";
    /** Deprecated and ignored (see ir_stats). */
    ir_opt_level?: 0 | 1 | 2;
    /** Deprecated and ignored (see ir_stats). */
    ir_passes_disabled?: string[];
    /** Deprecated and ignored (see ir_stats). */
    ir_page_mode?: boolean;
    /**
     * 32-bit and 16-bit code in the x64 page tier (default true; JIT switches
     * x64_page_legacy32, x64_page_compat32, x64_page_prot16 and x64_page_v86).
     * False leaves that code to the interpreter. (The name is IR Tier-0's,
     * which the page tier replaced.)
     */
    ir_tier0?: boolean;
    /** Deprecated and ignored (see ir_stats). */
    ir_region_budget?: {
        hot_threshold?: number;
        promotion_threshold?: number;
        max_source_bytes?: number;
        execution_budget?: number;
        rep_iterations?: number;
    };
    /**
     * JIT switches by name (src/rust/jit_switches.rs; docs/jit-unification-plan.md), as
     * { x64_outline: 0 } or "x64_outline=0,x64_loops=1", applied after the other JIT settings.
     * An unknown name, or a value the JIT refuses, fails the construction.
     */
    jit_switches?: { [name: string]: number | boolean } | string;
    /** Use approximate f64 x87 add/sub/mul/div (default true). False selects compatible arithmetic. */
    x87_fast_math?: boolean;
    /** Cache bounded register-only x87 regions in Wasm f64 locals (default true, requires x87_fast_math). */
    x87_jit_cache?: boolean;

    /**
     * The URL of a server running network relay.
     * Deprecated in favor of {@link V86Options.net_device}.
     * @deprecated
     * @see {@link V86Options.net_device}
     */
    network_relay_url?: string;

    /**
     * Network device configuration.
     */
    net_device?: V86NetworkDevice;

    /**
     * The sound card of the PC machines: the Sound Blaster 16 (a plugin, build/v86-sb16.js beside
     * the bundle), an Intel HD Audio controller with a generic output codec (what Windows Vista to 11
     * and Linux drive with their own drivers; a plugin, build/v86-hd-audio.js), or none (the PC
     * speaker stays). The virt machine has `virtio_sound` instead.
     * @default "sb16"
     */
    audio_device?: "sb16" | "hd_audio" | "none";

    /**
     * Where the plugin of the sound card (`audio_device`: "sb16", "hd_audio") is, a path or URL
     * @default build/v86-<name>.js beside the bundle (dashes for underscores; with the bundle's query)
     */
    audio_device_path?: string;

    /**
     * USB on the PC machines (a plugin, build/v86-usb.js beside the bundle): a UHCI controller
     * (PIIX3's on i440FX at 00:01.2, ICH9's on Q35 at 00:1d.0), or "ehci": ICH9's EHCI with its three
     * UHCI companions (00:1d.0-2 and .7 on Q35, 00:06 on i440FX; high-speed devices on the EHCI, the
     * others on the companions); with `tablet`, a HID tablet on the first port, an absolute pointer
     * that has the page's pointer while the guest uses it (unless the pointer is locked: then the PS/2
     * mouse has it); `mass_storage`: USB disks (disk images as USB sticks: Bulk-Only Transport, SCSI;
     * high speed on EHCI, SuperSpeed on xHCI) on the ports after it. UHCI has 2 ports, EHCI 6, xHCI 4 (QEMU's
     * qemu-xhci at 00:14.0; each port a USB 3 and a USB 2 root port). See {@link V86.usb_plug},
     * {@link V86.usb_attach_disk}.
     */
    usb?: {
        controller: "uhci" | "ehci" | "xhci";
        tablet?: boolean;
        mass_storage?: {
            /** its name for usb_plug and usb_detach_disk ("usb:" + id for disk_buffer and export_disk_image) */
            id: string;
            /** as hda's */
            image: V86HardDiskImage;
            /** the guest sees it write protected */
            read_only?: boolean;
        }[];
        plugin_path?: string;
    };

    /**
     * Enable serial port 1
     * @default false
     */
    uart1?: boolean;

    /**
     * Enable serial port 2
     * @default false
     */
    uart2?: boolean;

    /**
     * Enable serial port 3
     * @default false
     */
    uart3?: boolean;

    /**
     * Enable LPT2 (parallel1)
     * @default false
     */
    parallel1?: boolean;

    /**
     * Present the PCI devices, drives and ACPI namespace with the places and
     * identities of QEMU's default i440FX PC (PCI root _UID 0, IDE at 01.1,
     * ACPI at 01.3, VGA at 02.0, NE2000 at 03.0, QEMU's subsystem ids and
     * drive names). A Windows installed under QEMU then finds its devices
     * unchanged instead of installing them again at every boot. The
     * processor and the host bridge keep v86's identity (SeaBIOS would take
     * QEMU's host bridge for QEMU).
     * @default false
     */
    qemu_compatible?: boolean;
}

/** A custom virtio device (see V86Options.virtio_devices). */
export interface VirtioDeviceDescriptor {
    /** Unique among the devices; the key of the device's part of a snapshot. */
    name: string;
    /** PCI device ID; the vendor is always 0x1AF4. */
    device_id: number;
    subsystem_device_id?: number;
    /** PCI slot (1-31). A stable slot keeps the guest's device instance. Default: the first free slot from 0x10. */
    pci_slot?: number;
    /** Instead of pci_slot: behind this PCI Express root port (see {@link PCIeRootPortPlacement}). */
    pcie_root_port?: number;
    /** With pcie_root_port, false: the slot starts empty (see {@link PCIeRootPortPlacement}). */
    pcie_plugged?: boolean;
    /** Base of four 256-byte I/O windows (256-byte aligned). Default: allocated from 0xE000. */
    io_base?: number;
    /** Device feature bits; VIRTIO_F_VERSION_1 (32) is added. */
    features?: number[];
    /** Queue sizes (powers of two). */
    queues: { size: number }[];
    /** Device-specific configuration space, at most 256 bytes. */
    config?: { bytes: 1 | 2 | 4; name?: string; read(): number; write?(value: number): void }[];
    /** Called once with the handle, after the PCI function exists. */
    init?(device: VirtioDeviceHandle): void;
    /** The driver notified a queue. Only called after DRIVER_OK. */
    notify(queue: number): void;
    /** The driver reset the device, the machine reset, or the device starts afresh in its hot plug slot. */
    reset?(): void;
    /** Work the device still waits for from elsewhere (0 when none); saving waits for 0. */
    busy?(): number;
    /** Synchronous. Numbers, strings, arrays and typed arrays only (no plain objects). */
    get_state?(): unknown;
    set_state?(state: unknown): void;
    /**
     * Recognize state[92] of a snapshot from before custom devices; return
     * [transport state, device state, host state], or null.
     */
    upgrade_state?(slot: unknown): [unknown, unknown, unknown] | null;
}

/** A request popped from a virtqueue. */
export interface VirtioRequest {
    /** Bytes the driver wrote for the device. */
    readable: number;
    /** Bytes the device may write back. */
    writable: number;
    read(): Uint8Array;
    /** Returns the number of bytes written. */
    write(bytes: Uint8Array): number;
    /** Hand the request back (staged until flush). No effect after a reset or restore. */
    complete(): void;
}

/** What a VirtioDeviceDescriptor gets from v86. */
export interface VirtioDeviceHandle {
    name: string;
    /** DRIVER_OK is set and neither side failed. */
    is_ready(): boolean;
    has_request(queue: number): boolean;
    pop_request(queue: number): VirtioRequest | null;
    /** Publish completed requests and raise the interrupt. */
    flush(queue: number): void;
    /** Guest RAM, not a device window, a hole or the legacy VGA/ROM range. */
    is_ram(address: number, length: number): boolean;
    /** A view when one contiguous backing holds the range, a copy otherwise. Throws a RangeError for non-RAM. */
    read_memory(address: number, length: number): Uint8Array;
    write_memory(bytes: Uint8Array, address: number): void;
    is_feature_negotiated(bit: number): boolean;
    needs_reset(): void;
    config_changed(): void;
}

/** Options of graphics_proxy. */
export interface V86GraphicsProxyOptions {
    /** WebGPU could not start; the screen stays on its 2D canvas. */
    onError?: (error: Error) => void;
    /** Compressed RAM cache budget (default 64 MiB); excess pages use IndexedDB. */
    graphicsJournalMemoryBytes?: number;
    /** Legacy alias for graphicsJournalMemoryBytes. No longer a total history limit. */
    maxGraphicsJournalBytes?: number;
    /** Legacy alias for graphicsJournalMemoryBytes. */
    maxGLJournalBytes?: number;
    gl?: Record<string, unknown>;
    d3d8?: Record<string, unknown>;
    d3d9?: Record<string, unknown>;
}

export class V86 {
    /**
     * Read an OVF package, an OVA archive, before a machine is made: its
     * disks as descriptors (the archive with archive_member: read in it),
     * the hardware it describes as V86 options (memory_size, cpu_cores,
     * machine_type, hda, hdb), notes for what v86 does not have
     * (architecture, firmware, controllers, devices)
     */
    static import_ova(file: V86Image): Promise<{
        ovf: string;
        files: string[];
        disks: Array<{ id: string; file: string; format: string; capacity: number; controller: string; descriptor: V86HardDiskImage | null }>;
        options: Partial<V86Options>;
        notes: string[];
    }>;

    constructor(options: V86Options);
    /** The graphics proxy's plugin, when graphics_proxy is set (for diagnostics). */
    graphics_proxy?: object | null;

    /**
     * Start emulation. Do nothing if emulator is running already. Can be asynchronous.
     */
    run(): Promise<void>;

    /**
     * Stop emulation. Do nothing if emulator is not running. Can be asynchronous.
     */
    stop(): Promise<void>;

    /**
     * Free resources associated with this instance
     */
    destroy(): Promise<void>;

    /**
     * Restart (force a reboot).
     */
    restart(): Promise<void>;

    /**
     * Press the ACPI power button. A running ACPI guest gets a power button
     * event (usually starting an orderly shutdown); a machine the guest has
     * turned off (S4/S5) is powered on and started again, with RAM cleared;
     * a suspended machine (S3) wakes up. Resolves to false without ACPI.
     */
    power_button(): Promise<boolean>;

    /**
     * The ACPI power state: "S0" (running, or no ACPI), "S3" (suspended to
     * RAM: events "acpi-sleep"/"acpi-wake"), "S4" (the guest hibernated to
     * its disk and turned the machine off) or "S5" (soft off).
     */
    power_state(): Promise<"S0" | "S3" | "S4" | "S5">;

    /**
     * Add an event listener (the emulator is an event emitter).
     *
     * The callback function gets a single argument which depends on the event.
     *
     * @param event Name of the event.
     * @param listener The callback function.
     */
    add_listener<T extends keyof Event>(event: T, listener: (argument: Event[T]) => void): void;

    /**
     * Remove an event listener.
     *
     * The callback function gets a single argument which depends on the event.
     *
     * @param event Name of the event.
     * @param listener The callback function.
     */
    remove_listener<T extends keyof Event>(event: T, listener: (argument: Event[T]) => void): void;

    /**
     * Restore the emulator state from the given state, which must be an
     * ArrayBuffer returned by {@link V86.prototype.save_state}.
     *
     * Note that the state can only be restored correctly if this constructor has
     * been created with the same options as the original instance (e.g., same disk
     * images, memory size, etc.).
     *
     * Different versions of the emulator might use a different format for the
     * state buffer.
     *
     * @param state
     */
    restore_state(state: ArrayBuffer): Promise<void>;

    /**
     * Asynchronously save the current state of the emulator, in one buffer:
     * less than 2 GiB (the RAM in use, the video memory, the devices' state).
     * A larger state rejects with a RangeError; save_state_stream saves any
     * machine (and is needed with extended RAM).
     */
    save_state(): Promise<ArrayBuffer>;

    /** Save a V7 snapshot, awaiting each bounded chunk before producing the next. */
    save_state_stream(write: (chunk: Uint8Array) => void | Promise<void>): Promise<void>;

    /** Restore a V7 snapshot. Failed restoration leaves the machine stopped. */
    restore_state_stream(source: Blob | {
        size: number;
        read(offset: number, length: number): Uint8Array | Promise<Uint8Array>;
    }): Promise<void>;

    /**
     * Get current instruction counter
     */
    get_instruction_counter(): number;

    /**
     * Get emulator running status
     */
    is_running(): boolean;

    /**
     * Set the image inserted in the first floppy drive. Can be changed at runtime,
     * as when physically changing the floppy disk. A disk written back
     * (disk_option "read_write") that is taken out, by another or by
     * eject_fda, is flushed and closed.
     */
    set_fda(image: V86Image & { disk_option?: "read_only" | "read_write"; disk_error?: "stop" | "report"; token?: string }): Promise<void>;

    /**
     * Eject the first floppy drive.
     */
    eject_fda(): void | Promise<void>;

    /**
     * Set the image inserted in the second floppy drive. Can be changed at runtime,
     * as when physically changing the floppy disk.
     */
    set_fdb(image: V86Image & { disk_option?: "read_only" | "read_write"; disk_error?: "stop" | "report"; token?: string }): Promise<void>;

    /**
     * Eject the second floppy drive.
     */
    eject_fdb(): void | Promise<void>;

    /**
     * Set the image inserted in the CD-ROM drive. Can be changed at runtime, as
     * when physically changing the CD-ROM.
     */
    set_cdrom(image: V86Image): Promise<void>;

    /**
     * Eject the CD-ROM.
     */
    eject_cdrom(): void | Promise<void>;

    /**
     * The CD-ROM drive: whether the machine has one (an IDE or AHCI drive;
     * the virt machine's CD image is a virtio disk) and whether a disc is in it.
     */
    get_cdrom_state(): Promise<{ present: boolean; inserted: boolean }>;

    /**
     * Insert a CD made of files: an ISO 9660 image with the files in its root directory.
     */
    set_cdrom_files(files: Array<{ name: string; contents: Uint8Array }>): Promise<void>;

    /**
     * Watch the first network card's traffic: each packet the guest sends ("O") and receives ("I").
     * @returns a function that stops watching
     */
    capture_network_traffic(listener: (direction: "I" | "O", data: Uint8Array) => void): () => void;

    /**
     * The speaker's volume: 0 mutes it, 1 is full.
     * @returns whether the machine has a speaker (none with disable_speaker)
     */
    set_speaker_volume(volume: number): boolean;

    /**
     * The image in the first floppy drive, or null if the drive is empty
     * (a promise when the CPU runs in a Worker).
     */
    get_disk_fda(): Uint8Array | null | Promise<Uint8Array | null>;

    /**
     * The image in the second floppy drive, or null if the drive is empty
     * (a promise when the CPU runs in a Worker).
     */
    get_disk_fdb(): Uint8Array | null | Promise<Uint8Array | null>;

    /**
     * A diagnostic snapshot of the machine (CPU mode and registers, interrupt
     * controllers, ACPI, how the cores run: `execution`) as plain data, for
     * debugging and test reports; the format is not a stable API.
     */
    get_diagnostics(): Promise<any>;

    /**
     * Hot plug a drive into a free SATA port of the Q35 machine's AHCI
     * controller (ports 0-5; hda, hdb and cdrom are on ports 0, 1 and 2). The
     * guest sees the link come up and finds the drive by resetting the port.
     * To restore a snapshot taken with a hot plugged drive, attach the same
     * image to the same port first; otherwise the restored guest sees the
     * drive removed.
     *
     * @param port the port, 0-5
     * @param image the disk image, or for a CD drive the disc (null: empty)
     * @param options cdrom: attach an ATAPI CD drive instead of a hard disk
     */
    attach_sata_drive(port: number, image: V86HardDiskImage | null, options?: { cdrom?: boolean }): Promise<void>;

    /**
     * What an export of a disk writes: its size as the guest sees it, the
     * format and size of its image file, the bytes the guest wrote (kept in
     * memory), and the size of the sectors the guest sees (512 or 4096; a
     * CD drive's 2048)
     *
     * @param name "hda", "hdb", "cdrom", "sata<port>" or (virt) "virtio_disk<n>"
     */
    disk_image_info(name: string): Promise<{ name: string; format: string; size: number; file_size: number; written?: number; logical_sector_size: number }>;

    /**
     * Export a disk as the guest sees it, as a RAW image of its whole size
     * or a new QCOW2 image: the image's data with the guest's writes. The
     * machine stops and its disk I/O finishes first (the stream is one view
     * of the disk), and goes on afterwards. Each chunk (at most 1 MiB) goes to `write`;
     * the next one waits for the promise it returns. Resolves to the size
     * written.
     *
     * @param name "hda", "hdb", "cdrom", "sata<port>" or (virt) "virtio_disk<n>"
     */
    export_disk_image(name: string, options: {
        write: (chunk: Uint8Array) => void | Promise<void>;
        /**
         * "raw" (the default): the disk's whole size. "qcow2": a new QCOW2
         * image (version 3, 64 KiB clusters, clusters of zeros left out),
         * which needs a pass over the disk first: its size is then known
         */
        format?: "raw" | "qcow2";
        progress?: (progress: { loaded: number; total: number }) => void;
        signal?: AbortSignal;
    }): Promise<number>;

    /**
     * Remove the drive of a SATA port of the Q35 machine (a surprise
     * removal); the guest learns of it from the link going down.
     *
     * @param port the port, 0-5
     */
    detach_sata_drive(port: number): void | Promise<void>;

    /**
     * Plug a card into the hot plug slot of a PCI Express root port of the
     * Q35 machine: the device whose options put it behind that port
     * (pcie_root_port), after it was pulled out or when it started out of
     * the slot (pcie_plugged: false). The device starts afresh. Into a slot
     * that is off (as empty slots are after reset, like QEMU's, unless the
     * guest switched them on): presence detect changed and the attention
     * button pressed, as QEMU does, and the guest switches the slot on (Linux
     * and Windows do at once). Into a powered slot: presence detect changed
     * and the link comes up. Guests need PCI Express native hot plug (Linux:
     * pciehp). A snapshot holds which slots have their card in.
     *
     * @param port the root port, from 0
     */
    attach_pcie_device(port: number): Promise<void>;

    /**
     * Pull the card out of the hot plug slot of a PCI Express root port of
     * the Q35 machine. By default as with the slot's attention button: the
     * guest releases the device and switches the slot and its power indicator
     * off, then the card leaves and the promise is fulfilled (Linux and
     * Windows wait 5 seconds for a second press, which would cancel; a guest
     * without hot plug never does).
     * surprise: true pulls the card at once; reads from it then return all
     * ones, as on real hardware. Linux (as of 6.18) does not survive that
     * for a virtio device with a driver: its hot plug thread waits forever
     * for the device's reset to finish. Windows 8.1 answers the button by
     * switching the slot off at the end of the 5 seconds without stopping
     * the device's driver first; a storage controller's removal then never
     * finishes (devices without a driver come out fine).
     *
     * @param port the root port, from 0
     * @param options surprise: pull the card out at once
     */
    detach_pcie_device(port: number, options?: { surprise?: boolean }): Promise<void>;

    /**
     * Plug a USB device out of its port or back in (the `usb` option's devices: "tablet", a USB
     * disk's id): the guest sees it leave or arrive. Rejected for a device the machine does not have.
     *
     * @param id the device: "tablet" or a USB disk's id
     * @param plugged in (true) or out
     */
    usb_plug(id: string, plugged: boolean): Promise<void>;

    /**
     * The USB devices: each one's id, port, whether it is in it, the controller that has it ("ehci",
     * or "uhci": the UHCI, or one of EHCI's UHCI companions) and its speed in Mbit/s
     */
    usb_devices(): Promise<{ id: string; port: number; plugged: boolean; controller: "uhci" | "ehci" | "xhci"; speed: number }[]>;

    /**
     * Plug a disk image in as a USB disk (in the first free port): the guest sees it arrive. A
     * snapshot holds the USB disks in their ports: to restore one taken with a USB disk, attach the
     * same image with the same id first; otherwise the restored guest sees the disk leave.
     *
     * @param id its name (usb_plug, usb_detach_disk; "usb:" + id for disk_buffer and export_disk_image)
     * @param image as hda's
     * @param options read_only: the guest sees it write protected
     */
    usb_attach_disk(id: string, image: V86HardDiskImage, options?: { read_only?: boolean }): Promise<void>;

    /**
     * Pull a USB disk out, as a USB stick pulled from its socket: the writes the guest issued before
     * are in the image (a disk written back is flushed and closed). To let the guest finish first,
     * eject it in the guest ("usb-disk-ejected").
     */
    usb_detach_disk(id: string): Promise<void>;

    /**
     * Send a sequence of scan codes to the emulated PS2 controller. A list of
     * codes can be found at http://stanislavs.org/helppc/make_codes.html.
     * Do nothing if there is no keyboard controller.
     *
     * @param codes
     */
    keyboard_send_scancodes(codes: number[]): void;

    /**
     * Send translated keys
     */
    keyboard_send_keys(codes: number[]): void;

    /**
     * Send text, assuming the guest OS uses a US keyboard layout
     */
    keyboard_send_text(string: string): void;

    /**
     * Download a screenshot (returns an <img> element, only works in browsers)
     */
    screen_make_screenshot(): HTMLElement;

    /**
     * Set the scaling level of the emulated screen.
     *
     * @param {number} sx
     * @param {number} sy
     */
    screen_set_scale(sx: number, sy: number): void;

    /**
     * Tell the display adapter what size the page would show the guest's
     * display at (such as its window's). Adapters that can ask the guest to
     * change its resolution do (virtio_gpu); the others ignore it.
     *
     * @param display which of the guest's displays (0, the first)
     */
    set_display_size(width: number, height: number, display?: number): void;

    /**
     * Go fullscreen (only browsers)
     */
    screen_go_fullscreen(): void;

    /**
     * Lock the mouse cursor: It becomes invisble and is not moved out of the browser window (only browsers)
     */
    lock_mouse(): void;

    /**
     * Enable or disable sending mouse events to the emulated PS2 controller.
     */
    mouse_set_enabled(enabled: boolean): void;

    /**
     * Enable or disable sending keyboard events to the emulated PS2 controller.
     */
    keyboard_set_enabled(enabled: boolean): void;

    /**
     * Send a string to the first emulated serial terminal.
     *
     * @param data
     */
    serial0_send(data: string): void;
    /**
     * Send text (as UTF-8) or bytes to the first virtio console port (hvc0 on
     * the virt machine, the kernel's console there)
     */
    virtio_console_send(data: string | Uint8Array): void;

    /**
     * Send bytes to a serial port (to be received by the emulated PC).
     *
     * @param serial the index of the serial port
     * @param data
     */
    serial_send_bytes(serial: number, data: Uint8Array): void;

    /**
     * Set or clear the data carrier detect (DCD) status of a serial port.
     *
     * @param serial the index of the serial port
     * @param status the new DCD signal status
     */
    serial_set_carrier_detect(serial: number, status: boolean): void;

    /**
     * Set or clear the ring indicator (RING) status of a serial port.
     *
     * @param serial the index of the serial port
     * @param status the new RING signal status
     */
    serial_set_ring_indicator(serial: number, status: boolean): void;

    /**
     * Set or clear the data set ready (DSR) status of a serial port.
     *
     * @param serial the index of the serial port
     * @param status the new DSR signal status
     */
    serial_set_data_set_ready(serial: number, status: boolean): void;

    /**
     * Set or clear the clear to send (CTS) status of a serial port.
     *
     * @param serial the index of the serial port
     * @param status the new CTS signal status
     */
    serial_set_clear_to_send(serial: number, status: boolean): void;

    /**
     * Write to a file in the 9p filesystem. Nothing happens if no filesystem has
     * been initialized.
     *
     * @param file
     * @param data
     * @param callback
     * @throws {FileNotFoundError}
     */
    create_file(file: string, data: Uint8Array): Promise<void>;

    /**
     * Read a file in the 9p filesystem.
     *
     * @param {string} file
     * @throws {FileNotFoundError}
     */
    read_file(file: string): Promise<Uint8Array>;

    /**
     * Reads data from memory at specified offset.
     *
     * @param offset
     * @param length
     */
    /** CPU Worker mode returns a Promise with a copied buffer. */
    read_memory(offset: number, length: number): Uint8Array | Promise<Uint8Array>;

    /**
     * A stream socket to a port of the guest's vsock (virtio_vsock):
     * resolves when the guest accepts, rejects when it refuses
     */
    vsock_connect(port: number): Promise<{
        write(bytes: Uint8Array): void;
        close(): void;
        on_data: ((bytes: Uint8Array) => void) | null;
        on_close: (() => void) | null;
        readonly closed: boolean;
    }>;

    /** Read a 36-bit physical range in bounded chunks (default 1 MiB). */
    read_memory_chunks(offset: number, length: number, chunk_size?: number): AsyncGenerator<Uint8Array, void, unknown>;

    /**
     * Writes data to memory at specified offset.
     *
     * @param blob
     * @param offset
     */
    /** Await in CPU Worker mode to observe completion. */
    write_memory(blob: number[] | Uint8Array, offset: number): void | Promise<void>;

    /**
     * Wait until expected text is present on the VGA text screen.
     *
     * Returns immediately if the expected text is already present on screen
     * at the time this function is called.
     *
     * @param expected
     * @param options
     */
    wait_until_vga_screen_contains(expected: string|RegExp|Array<string|RegExp>, options?: {timeout_msec?: number}): Promise<boolean>;

    /**
     * Set Xtermjs serial port console
     *
     * @param element
     * @param xterm_lib
     */
    set_serial_container_xtermjs(element: HTMLElement, xterm_lib?: Function): void;

    /**
     * Set Xtermjs virtio console
     *
     * @param element
     * @param xterm_lib
     */
    set_virtio_console_container_xtermjs(element: HTMLElement, xterm_lib?: Function): void;

    /**
     * Run steps automatically
     *
     * @param steps
     * @deprecated
     * @see {@link V86.prototype.wait_until_vga_screen_contains}
     */
    automatically(steps: Array<{ sleep?: number, vga_text?: string, keyboard_send?: string | number[], call?: Function }>): void;

    /**
     * Get instruction stats
     *
     * @see {@link https://github.com/speedyHKjournalist/v64/blob/master/docs/profiling.md} for more infos
     */
    get_instruction_stats(): string | Promise<string>;

    /** Runtime snapshot of the JIT. */
    get_jit_info(): V86JitInfo | Promise<V86JitInfo>;
    /** Deprecated: the IR region tiers' compiler dumps (deleted in M11); returns []. */
    get_ir_dumps(clear?: boolean): unknown[];
    /** Deprecated: the IR region tiers' diagnostics (deleted in M11); returns false. */
    configure_ir_diagnostics(sample_period: number): boolean;
}

export interface V86JitInfo {
    backend: "ir";
    ir_available: boolean;
    ir: {
        /** 1 when the JIT compiles (disable_jit, or jit_set_enabled at run time), else 0. */
        enabled: 0 | 1;
        /** Deprecated: IR Tier-0 was deleted (its code is the page tier's, page_tier); always null. */
        tier0: null;
        /** The x64 page tier's 32-bit and 16-bit modes; counters wrap at 2^32. */
        page_tier: { legacy32: boolean; compat32: boolean; prot16: boolean; v86: boolean; functions: number; native_instructions: number; activations: number } | null;
    };
}
