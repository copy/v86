// The ranchu machine (machine_type "ranchu", docs/aarch32-plan.md R6): the
// Android emulator's board, which the SDK's system images (kernel-ranchu,
// ramdisk.img, system.img, userdata.img) are built for. The virt machine's
// RAM, PL011, generic timer and virtio-mmio slots; a GICv2 with cpu_type
// "arm32" (Linux 3.10's ranchu kernel has no GICv3 driver), the virt
// machine's GICv3 with "arm64"; the emulator's goldfish devices
// (src/virt/goldfish.js) where its board has them; a PL031 (the kernels'
// RTC); no PCIe. The kernels find all of it in the device tree, whose
// compatible strings are the emulator's ("generic," for Linux 3.10,
// "google," for newer kernels).

import { node, flatten } from "./dtb.js";
import { VIRT_GIC_DIST, VIRT_GIC_DIST_SIZE, VIRT_GIC_REDIST, VIRT_MMIO, VIRT_MMIO_COUNT, VIRT_MMIO_SIZE, VIRT_RAM_BASE, VIRT_UART } from "./platform.js";

/** Version of the ranchu machine's device layout, recorded in snapshots */
export const RANCHU_LAYOUT_VERSION = 1;

export const RANCHU_GIC_CPU = 0x08010000;
export const RANCHU_GIC_CPU_SIZE = 0x10000;
export const RANCHU_GOLDFISH_FB = 0x09010000;
export const RANCHU_GOLDFISH_BATTERY = 0x09020000;
export const RANCHU_GOLDFISH_AUDIO = 0x09030000;
export const RANCHU_GOLDFISH_EVENTS = 0x09040000;
export const RANCHU_RTC = 0x09050000;
export const RANCHU_GOLDFISH_PIPE = 0x0A010000;
/** The devices' SPIs (the virtio-mmio slots': 16 + slot, as the virt machine's) */
export const RANCHU_SPI = { uart: 1, fb: 2, battery: 3, audio: 4, events: 5, rtc: 6, pipe: 7 };
/** The low redistributor region (the virt machine's) */
const GIC_REDIST_REGION_SIZE = 0xF60000;
const APB_PCLK_HZ = 24000000;

/** The display the framebuffer has unless the machine's settings say otherwise: a phone's, hdpi */
export const RANCHU_DISPLAY = { width: 480, height: 800, dpi: 240 };

/**
 * (arm32) the simple-framebuffer's place: the top of RAM, in 2 MiB
 * @param {number} memory_size
 * @param {{width: number, height: number}} display
 * @return {{base: number, size: number, width: number, height: number}}
 */
export function ranchu_framebuffer(memory_size, display)
{
    const size = Math.ceil(display.width * display.height * 2 / 0x200000) * 0x200000;
    return { base: VIRT_RAM_BASE + memory_size - size, size, width: display.width, height: display.height };
}

const u64 = value => [Math.floor(value / 0x100000000), value >>> 0];

/**
 * The kernel command line the emulator gives an SDK image (its
 * android/kernel/kernel_utils's): the hardware's name, the console, host
 * GLES or not (qemu.gles=1: the GL libraries are the emulator's, over the
 * pipe's "opengles", ranchu_gpu "host"; qemu.gles=0: the guest renders),
 * no RIL (no android.qemud), no Wi-Fi namespace (eth0 with DHCP), no boot
 * animation when asked
 * @param {{arm32: boolean, gles: (boolean|undefined), bootanim: (boolean|undefined), extra: (string|undefined)}} m
 * @return {string}
 */
export function ranchu_cmdline(m)
{
    // (the kernel's console the PL011; init's console service then opens
    // /dev/console, which the image's SELinux policy lets its shell use: it
    // labels no ttyAMA device)
    return ["qemu=1", "androidboot.hardware=ranchu", "console=ttyAMA0",
        "android.checkjni=1", "qemu.gles=" + (m.gles ? 1 : 0), "qemu.encrypt=0", "qemu.wifi=0", "loop.max_part=7",
        ...(m.bootanim === false ? ["android.bootanim=0"] : []), ...(m.extra ? [m.extra] : [])].join(" ");
}

/**
 * The ranchu machine's tree
 * (`framebuffer`: a simple-framebuffer at the top of RAM, kept out of the
 * memory node, instead of the goldfish framebuffer: arm32's)
 * @param {{cores: number, memory_size: number, bootargs: (string|undefined), arm32: boolean,
 *          initrd: ({start: number, end: number}|undefined),
 *          framebuffer: ({base: number, size: number, width: number, height: number}|undefined)}} m
 * @return {!Uint8Array} the flattened tree
 */
export function ranchu_dtb(m)
{
    const clock = 0x8000;
    const gic = 0x8000 + m.cores + 1;
    const cpu_phandle = i => 0x8000 + m.cores - i;
    const spi = (n, type) => [0, n, type];
    // (a GICv2's PPIs name the cores they go to: bits 15:8)
    const ppi_flags = m.arm32 ? ((1 << m.cores) - 1) << 8 | 4 : 4;
    const smc = m.arm32 ? 0x84000000 : 0xC4000000;
    const children = [];
    children.push(node("psci", [
        ["migrate", [smc | 5]], ["cpu_on", [smc | 3]], ["cpu_off", [0x84000002]], ["cpu_suspend", [smc | 1]],
        ["method", "hvc"], ["compatible", ["arm,psci-0.2", "arm,psci"]],
    ]));
    const fb = m.framebuffer;
    children.push(node("memory@" + VIRT_RAM_BASE.toString(16), [
        ["reg", [...u64(VIRT_RAM_BASE), ...u64(m.memory_size - (fb ? fb.size : 0))]], ["device_type", "memory"],
    ]));
    if(fb)
    {
        children.push(node("framebuffer@" + fb.base.toString(16), [
            ["format", "r5g6b5"], ["stride", [2 * fb.width]], ["height", [fb.height]], ["width", [fb.width]],
            ["reg", [...u64(fb.base), ...u64(fb.size)]], ["compatible", "simple-framebuffer"],
        ]));
    }
    // (from the last slot down, where the machine puts its first device: the
    // kernel probes them in this order, the first disk becoming vda as fstab.ranchu wants)
    for(let n = VIRT_MMIO_COUNT - 1; n >= 0; n--)
    {
        const base = VIRT_MMIO + n * VIRT_MMIO_SIZE;
        children.push(node("virtio_mmio@" + base.toString(16), [
            ["interrupts", spi(16 + n, 1)], ["reg", [...u64(base), ...u64(VIRT_MMIO_SIZE)]], ["compatible", "virtio,mmio"],
        ]));
    }
    const goldfish = (name, base, size, irq, kind) => node(name + "@" + base.toString(16), [
        ["interrupts", spi(irq, 4)], ["reg", [...u64(base), ...u64(size)]], ["compatible", ["google," + kind, "generic," + kind]],
    ]);
    children.push(goldfish("goldfish_pipe", RANCHU_GOLDFISH_PIPE, 0x2000, RANCHU_SPI.pipe, "android-pipe"));
    children.push(goldfish("goldfish_events", RANCHU_GOLDFISH_EVENTS, 0x1000, RANCHU_SPI.events, "goldfish-events-keypad"));
    children.push(goldfish("goldfish_audio", RANCHU_GOLDFISH_AUDIO, 0x1000, RANCHU_SPI.audio, "goldfish-audio"));
    children.push(goldfish("goldfish_battery", RANCHU_GOLDFISH_BATTERY, 0x1000, RANCHU_SPI.battery, "goldfish-battery"));
    if(!fb) children.push(goldfish("goldfish_fb", RANCHU_GOLDFISH_FB, 0x1000, RANCHU_SPI.fb, "goldfish-fb"));
    children.push(node("pl031@" + RANCHU_RTC.toString(16), [
        ["clock-names", "apb_pclk"], ["clocks", [clock]], ["interrupts", spi(RANCHU_SPI.rtc, 4)], ["reg", [...u64(RANCHU_RTC), ...u64(0x1000)]],
        ["compatible", ["arm,pl031", "arm,primecell"]],
    ]));
    children.push(node("pl011@" + VIRT_UART.toString(16), [
        ["clock-names", ["uartclk", "apb_pclk"]], ["clocks", [clock, clock]], ["interrupts", spi(RANCHU_SPI.uart, 4)],
        ["reg", [...u64(VIRT_UART), ...u64(0x1000)]], ["compatible", ["arm,pl011", "arm,primecell"]],
    ]));
    children.push(node("intc@" + VIRT_GIC_DIST.toString(16), m.arm32 ? [
        ["phandle", [gic]],
        ["reg", [...u64(VIRT_GIC_DIST), ...u64(VIRT_GIC_DIST_SIZE), ...u64(RANCHU_GIC_CPU), ...u64(RANCHU_GIC_CPU_SIZE)]],
        ["compatible", "arm,cortex-a15-gic"], ["interrupt-controller", true], ["#interrupt-cells", [3]],
    ] : [
        ["phandle", [gic]],
        ["reg", [...u64(VIRT_GIC_DIST), ...u64(VIRT_GIC_DIST_SIZE), ...u64(VIRT_GIC_REDIST), ...u64(GIC_REDIST_REGION_SIZE)]],
        ["#redistributor-regions", [1]], ["compatible", "arm,gic-v3"], ["interrupt-controller", true], ["#interrupt-cells", [3]],
    ]));
    const cores = [];
    for(let i = 0; i < m.cores; i++)
    {
        cores.push(node("cpu@" + i, [
            ["phandle", [cpu_phandle(i)]], ["reg", [i]], ...(m.cores > 1 ? [["enable-method", "psci"]] : []),
            ["compatible", m.arm32 ? "arm,cortex-a15" : "arm,armv8"], ["device_type", "cpu"],
        ]));
    }
    children.push(node("cpus", [["#size-cells", [0]], ["#address-cells", [1]]], cores));
    children.push(node("timer", [
        ["interrupts", [1, 13, ppi_flags, 1, 14, ppi_flags, 1, 11, ppi_flags, 1, 10, ppi_flags]], ["always-on", true],
        ["compatible", m.arm32 ? ["arm,armv7-timer"] : ["arm,armv8-timer", "arm,armv7-timer"]],
    ]));
    children.push(node("apb-pclk", [
        ["phandle", [clock]], ["clock-output-names", "clk24mhz"], ["clock-frequency", [APB_PCLK_HZ]], ["#clock-cells", [0]],
        ["compatible", "fixed-clock"],
    ]));
    children.push(node("aliases", [["serial0", "/pl011@" + VIRT_UART.toString(16)]]));
    const chosen = [["stdout-path", "/pl011@" + VIRT_UART.toString(16)]];
    if(m.bootargs !== undefined) chosen.push(["bootargs", m.bootargs]);
    if(m.initrd) chosen.push(["linux,initrd-end", u64(m.initrd.end)], ["linux,initrd-start", u64(m.initrd.start)]);
    children.push(node("chosen", chosen));
    return flatten(node("", [
        ["interrupt-parent", [gic]], ["model", "ranchu"], ["#size-cells", [2]], ["#address-cells", [2]],
        ["compatible", ["ranchu", "linux,dummy-virt"]],
    ], children));
}
