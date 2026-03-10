// warning: experimental, incomplete and likely to change in the future
// if you find problems, please send a pull request

/**
 * The type for images as a file.
 *
 * Files with `async: true` and `use_parts: false` are downloaded using HTTP
 * Range requests. Note that not all web servers support this header correctly,
 * and it inherently disables HTTP compression. The `url` fields points
 * directly to the disk images.
 *
 * State images and fixed-size chunks (but not other image types) that end with
 * .zst are automatically decompressed using a built-in zstd decompressor. This
 * has a performance overhead compared to HTTP compression, but will result in
 * better compression ration.
 *
 * Note that bios, initial state, bzimage, initrd, multiboot and floppy disk
 * images are always loaded synchronously.
 */
type V86FileImage =
    {
        /** The URL to the image */
        url: string;

        /**
         * Async loading.
         *
         * If true, the file is downloaded completely, otherwise in chunks (see 
         * below for the chunking method). BIOS, multiboot, bzimage and state 
         * files are always downloaded completely, as they're required before 
         * emulation can start.
         *
         * @default false
         */
        async?: boolean;

        /** Image size, required for async loading */
        size: number;

        /**
         * Use parts instead of Range header, useful for static hostings.
         *
         * If true, v86 expects the image to be split in files of `fixed_chunk_size` 
         * bytes. You can use [split-image.py](https://github.com/copy/v86/blob/master/tools/split-image.py)
         * to split an image. V86 appends `-<start-byte>-<end-byte>` to the url.
         */
        use_parts?: boolean;

        /**
         * Fixed chunk size, useful with `use_parts: true` for GitHub Pages users.
         */
        fixed_chunk_size?: number;
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
 */
export type V86Image = V86FileImage | V86BufferImage;

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
}

export enum BootOrder {
    AUTO = 0,
    CD_FLOPPY_HARDDISK = 0x213,
    CD_HARDDISK_FLOPPY = 0x123,
    FLOPPY_CD_HARDDISK = 0x231,
    FLOPPY_HARDDISK_CD = 0x321,
    HARDDISK_CD_FLOPPY = 0x132,
}

export type Event =
    | "9p-attach"
    | "9p-read-end"
    | "9p-read-start"
    | "9p-write-end"
    | "download-error"
    | "download-progress"
    | "emulator-loaded"
    | "emulator-ready"
    | "emulator-started"
    | "emulator-stopped"
    | "eth-receive-end"
    | "eth-transmit-end"
    | "ide-read-end"
    | "ide-read-start"
    | "ide-write-end"
    | "mouse-enable"
    | "net0-send"
    | "screen-put-char"
    | "screen-set-size"
    | "serial0-output-byte"
    | "virtio-console0-output-bytes";

/**
 * Network device configuration
 * @see {@link https://github.com/copy/v86/blob/master/docs/networking.md} for more infos
 */
type V86NetworkDevice =
    {
        /**
         * The type of emulated NIC provided to the guest OS.
         * Recommended to use `ne2k` for old OSes and `virtio` for modern Linux.
         * @default "ne2k"
         */
        type?: "ne2k" | "virtio";

        /**
         * The network backend URL. 
         * Note that the CORS proxy server of the fetch backend is defined in field `cors_proxy` below.
         * @see {@link https://github.com/copy/v86/blob/master/docs/networking.md#backend-url-schemes} for backend URL schemes
         */
        relay_url?: string;

        /**
         * Network id, all v86 network instances with the same id share the same network namespace.
         * @todo class NetworkAdapter should also get options.net_device as an argument, at least options.net_device.id.
         * @default 0
         */
        id?: number;

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
    };

/**
 * emulator instance constructor options.
 */
export interface V86Options {
    /**
     * Reference to the v86 wasm exported function.
     */
    wasm_fn?: (options: WebAssembly.Imports) => Promise<WebAssembly.Exports>;

    /**
     * Path to v86 wasm artifact
     * @default "build/v86.wasm" or "build/v86-debug.wasm" when debug mode enabled
     */
    wasm_path?: string;

    /**
     * The memory size in bytes, should be a power of 2.
     * @example 16 * 1024 * 1024
     * @default 64 * 1024 * 1024
     */
    memory_size?: number;

    /**
     * VGA memory size in bytes.
     * @example 8 * 1024 * 1024
     * @default 8 * 1024 * 1024
     */
    vga_memory_size?: number;

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
     * @see {@link https://github.com/copy/v86/tree/master/bios} for BIOS images
     */
    bios?: V86Image;

    /**
     * VGA BIOS image
     * @see {@link https://github.com/copy/v86/tree/master/bios} for BIOS images
     */
    vga_bios?: V86Image;

    /**
     * First hard disk
     */
    hda?: V86Image;

    /**
     * Second hard disk
     */
    hdb?: V86Image;

    /**
     * First floppy disk
     */
    fda?: V86Image;

    /**
     * Second floppy disk
     */
    fdb?: V86Image;

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
     * @see {@link https://github.com/copy/v86/blob/master/docs/networking.md#v86-run-time-state-images}
     */
    preserve_mac_from_state_image?: boolean;

    /**
     * A 9p filesystem is supported by the emulator, using a virtio transport. Using it, files can be exchanged with the guest OS
     * If `basefs` and `baseurl` are omitted, an empty 9p filesystem is created.
     */
    filesystem?: {
        /**
         * A URL to a JSON file created using [fs2json](https://github.com/copy/v86/blob/master/tools/fs2json.py).
         */
        baseurl?: string;

        /**
         * A directory of 9p files, as created by [copy-to-sha256.py](https://github.com/copy/v86/blob/master/tools/copy-to-sha256.py).
         * @see {@link https://github.com/copy/v86/blob/master/docs/filesystem.md} for more details
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
    };

    /**
     * A textarea that will receive and send data to the emulated serial terminal (only browsers).
     * Alternatively the serial terminal can also be accessed programatically, see 
     * [examples/serial.html](https://github.com/copy/v86/blob/master/examples/serial.html) for example.
     * Deprecated in favor of the serial_console config below
     * @deprecated
     */
    serial_container?: HTMLTextAreaElement;

    /**
     * Xtermjs serial terminal container (only browsers). When set, serial_container option is ignored.
     * Deprecated in favor of the serial_console config below.
     * @deprecated
     */
    serial_container_xtermjs?: HTMLElement;

    /**
     * Console adapter for serial console
     */
    serial_console: ConsoleConfig;

    /**
     * Console adapter for virtio console.
     * Setting to true, creates virtio console device without adapter
     */
    virtio_console: ConsoleConfig;

    /**
     * Emulator screen element (only browsers).
     * @see {@link https://github.com/copy/v86/blob/master/examples/basic.html|exmaples/basic.html} for example
     */
    screen_container?: HTMLElement | null;

    /**
     * Enable ACPI (also enables APIC). Experimental and only partially implemented.
     * @default false
     */
    acpi?: boolean;

    /**
     * log level
     * @default LogLevel.LOG_NONE
     */
    log_level?: LogLevel;

    /**
     * boot order
     * @default BootOrder.AUTO
     */
    boot_order?: BootOrder;

    /**
     * fast boot, skips boot menu in bochs bios
     * @default false
     */
    fastboot?: boolean;

    /**
     * create a virtio balloon device
     * @default false
     */
    virtio_balloon?: boolean;

    /**
     * override the maximum supported cpuid level
     * used for some versions of Windows, see [docs/windows-nt.md](https://github.com/copy/v86/blob/master/docs/windows-nt.md)
     */
    cpuid_level?: number;

    /**
     * turn off the x86-to-wasm jit
     * @default false
     */
    disable_jit?: boolean;

    /**
     * The URL of a server running network relay.
     * Deprecated in favor of the net_device config.
     * @deprecated
     * @see {@link V86Options.net_device}
     */
    network_relay_url?: string;

    /**
     * Network device configuration.
     */
    net_device?: V86NetworkDevice;
}

export class V86 {
    constructor(options: V86Options);

    /**
     * Start emulation. Do nothing if emulator is running already. Can be asynchronous.
     */
    run(): void;

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
    restart(): void;

    /**
     * Add an event listener (the emulator is an event emitter).
     *
     * The callback function gets a single argument which depends on the event.
     *
     * @param event Name of the event.
     * @param listener The callback function.
     */
    add_listener(event: Event, listener: Function): void;

    /**
     * Remove an event listener.
     *
     * @param event
     * @param listener
     */
    remove_listener(event: Event, listener: Function): void;

    /**
     * Restore the emulator state from the given state, which must be an
     * ArrayBuffer returned by
     * [`save_state`](#save_statefunctionobject-arraybuffer-callback).
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
     * Asynchronously save the current state of the emulator.
     */
    save_state(): Promise<ArrayBuffer>;

    get_instruction_counter(): number;
    is_running(): boolean;

    /**
     * Set the image inserted in the floppy drive. Can be changed at runtime, as
     * when physically changing the floppy disk.
     */
    set_fda(image: V86Image): Promise<void>;

    /**
     * Eject the floppy drive.
     */
    eject_fda(): void;

    /**
     * Set the image inserted in the CD-ROM drive. Can be changed at runtime, as
     * when physically changing the CD-ROM.
     */
    set_cdrom(image: V86Image): Promise<void>;

    /**
     * Eject the CD-ROM.
     */
    eject_cdrom(): void;

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
     * Send bytes to a serial port (to be received by the emulated PC).
     *
     * @param serial the index of the serial port
     * @param data
     */
    serial_send_bytes(serial: number, data: Uint8Array): void;

    /**
     * Write to a file in the 9p filesystem. Nothing happens if no filesystem has
     * been initialized.
     *
     * @param file
     * @param data
     * @param callback
     */
    create_file(file: string, data: Uint8Array): Promise<void>;

    /**
     * Read a file in the 9p filesystem.
     *
     * @param {string} file
     */
    read_file(file: string): Promise<Uint8Array>;
}
