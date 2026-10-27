# iPhone 4（A4，S5L8930）机器实施计划

状态：研究性计划，尚未实现。2026-10-27 初稿；同日复核，修正与补充见“复核结论”。所有者决定把 iPhone 4 作为
v86 的第一台 iOS 设备。S0 第 1 步已完成：固件与密钥已在所有者本机，核对结果见“复核结论”的“固件与密钥”。

本计划为 v86 增加机器类型 `machine_type: "s5l8930"`，模拟 iPhone 4（`iPhone3,1`，板子 N90AP），目标是
iOS 6.1.3 启动到主屏幕，能触控操作，能运行系统自带的应用。

v86 不提供也不托管苹果的任何文件：固件（IPSW）由用户自己从苹果的服务器取得，在本机解密和处理，
解密用的密钥由用户提供。见“法律与分发”。

## 选型结论

2026-10-27 与所有者讨论的结论：

1. **现代 iOS 不做。** arm64e 的指针认证、苹果私有的 CPU 扩展、SEP、ANS2、AGX GPU 等都没有公开资料，
   已有的 QEMU 项目（iPhone 11、iOS 14）做了多年仍不完整。
2. **iPhone 4 是 ARMv7 时代最好的起点。**
   - **CPU 合适**：单核 Cortex-A8（ARMv7-A），v86 的 AArch32 核心是它的超集，不必像 iPod touch 1G/2G
     那样另做 ARMv6；
   - **资料最全**：openiBoot（GPL-3.0）的 `plat-a4` 有 A4 几乎全部外设的驱动；
   - **密钥齐全**：A4 有 bootrom 漏洞 limera1n（2010），The Apple Wiki 上有 `iPhone3,1` 各版本的固件密钥；
   - **系统跨度大**：iOS 4.0–7.1.2，含拟物风格的 iOS 6；
   - **没有安全隔区（SEP）**：SEP 从 A7 才开始有。
3. **iPhone 4S（A5）放在之后。** 它是双核 Cortex-A9，公开资料少得多，部分版本的密钥也不全。A5 的外设大多
   是 A4 的演进，本计划做完后，4S 主要是增量工作。
4. **iPod touch 4G（`iPod4,1`，同为 A4）是同一台机器的另一个型号。** 它没有基带，内存是 256 MiB（iPhone 4 是
   512 MiB），系统到 iOS 6.1.6。SIM 或基带成为阻塞点时，它是备选的首个型号（见“风险”）。它去掉的是 SIM 与基带
   这一层；它本身要不要联网激活，S4 核对。

## 目标与非目标

**目标**：

- iOS 6.1.3（`iPhone3,1`，10B329）从模拟的 NAND 启动到 SpringBoard 主屏幕；
- 触控、Home/电源/音量键、横竖屏（用浏览器的设备方向，或手动切换）；
- 自带应用可用：设置、备忘录、计算器、照片、日历、时钟、离线的 Safari；
- 串口控制台（调试用）、快照、CPU Worker 模式。

**之后再定**：

- iOS 4.3.x、5.1.1、7.1.2；
- iPod touch 4G 型号；
- 声音；
- 安装用户自己的未加密 IPA（老游戏）；
- iPhone 4S（A5）。

**非目标**：

- 基带、蜂窝网络、SIM；
- Wi-Fi 与蓝牙（BCM4329，SDIO）；
- iTunes/USB 同步与在模拟器里完整恢复固件；
- App Store、iCloud、FaceTime、Game Center；
- FairPlay 加密的 App Store 应用（解密要真机的密钥，模拟器做不到；和 touchHLE 一样只支持已解密的 IPA）。

## 机器设计

| 层 | 选择 |
| --- | --- |
| CPU | `cpu_type: "arm32"`、`cpu_profile: "cortex-a8"`（统一的 CPU 型号选项，见下一节；arm32 的默认型号是现有的 `cortex-a15`） |
| 机器 | `machine_type: "s5l8930"`：A4 的地址布局、4 个 VIC、定时器、UART、时钟与电源门控、I2C、SPI、GPIO、H2FMI、CDMA、AES、CLCD |
| 中断 | 4 个 PL192 式的 VIC 直接驱动 CPU 的 IRQ 与 FIQ 线；没有 GIC，也没有 ARM 的 generic timer（定时器是 SoC 自己的） |
| 型号 | `apple_model: "iPhone3,1"`（v1 只有这一个；以后 `"iPod4,1"`、`"iPhone3,3"`） |
| 显示 | CLCD 帧缓冲经显示中枢输出；`graphics_adapter` 只能是 `"none"`（与 `ranchu` 相同） |
| 存储 | 模拟的原始 NAND（H2FMI 控制器），镜像由构建工具生成（见“存储”）；不能用 `hda`、`cdrom` |
| 输入 | 指针和触摸事件 → 多点触控控制器；键盘 → 按键；设备方向 → 传感器 |
| 引导 | 不运行 iBoot：v86 直接装载解密后的内核与设备树，按 XNU 的约定交给内核（见“引导”） |
| 不提供 | PCI、virtio、ACPI、BIOS |

拟新增的配置（字段名在 S1 冻结）：

```js
new V86({
    cpu_type: "arm32",
    cpu_profile: "cortex-a8",
    machine_type: "s5l8930",
    apple_model: "iPhone3,1",
    memory_size: 512 << 20,                 // 由型号决定，不可调：iPhone 4 是 512 MiB，iPod touch 4G 是 256 MiB
    ios: {
        kernelcache: { url: "kernelcache.n90.macho" },   // 解密、解压后的 Mach-O，由用户的工具生成
        devicetree: { url: "DeviceTree.n90ap.bin" },     // 解密后的苹果设备树
        ramdisk: { url: "restore.dmg" },                 // 可选：S3 的 shell 阶段
        nand: { url: "nand.img", async: true },          // 构建工具生成，可写 overlay
        boot_args: "-v serial=3",
    },
});
```

### CPU 型号：统一的 `cpu_profile`

现在 CPU 型号有三种不同的配置方式：
- arm64 用 `a64_profile`（`"v1"`、`"v1.1"`、`"v2"`、`"v3"`）；
- arm32 没有选项，固定为 Cortex-A15；
- x86 用 `cpu_features` 加功能位，或者用级别预设 `"x86-64-v2"`、`"v3"`。

本计划需要第四种（arm32 的 Cortex-A8），所以先把它们统一成一个选项 **`cpu_profile`**：值是一个 CPU 型号的名字，
对所有 CPU 类型都一样。它作为 S1 的第一个提交单独落地，现有机器的行为不变。这一步与苹果的文件无关，可以早于
S0 单独做。

**语义：**

- `cpu_type` 仍然决定指令集和核心（`v86.wasm` 或 `v86-arm64.wasm`），`cpu_profile` 决定这个指令集里的型号：
  ID 寄存器或 CPUID 的身份、可用的功能、少数型号特有的行为。
- 每个型号声明它适用的 `cpu_type`。只给 `cpu_profile` 时由它推出 `cpu_type`；两者冲突时报错，并说明各自
  允许的值。
- 某些机器要求特定的型号，与“机器要求 ARM CPU”的检查放在一起（`src/machine_options.js`）：`s5l8930`
  只接受 `cortex-a8`，`ranchu` 的 32 位只接受 `cortex-a15`。
- 快照恢复时用快照自己的型号。

**型号与功能级别分开，避免重复。** 一个 CPU 有两方面：身份（厂商、型号，或 ARM 的 MIDR，软件读到的“这是哪颗
CPU”），以及能用哪些指令。两者混在 `cpu_profile` 里会出现几乎一样的选项：
- `generic-x86-64` 已经包含 x86-64-v3 级别的全部指令（另加 XSAVE 系列），v2 是它的子集；
- 将来的 `haswell` 在指令上也和它差不多。

所以分工如下：

- **`cpu_profile` 只回答“模拟哪颗 CPU”。** 每类 CPU 有一个通用型号作默认值，即 v86 能提供的全部功能。
  真实型号只在软件会检查 CPU 身份时才需要：老游戏和老系统识别型号，Mac OS X 的内核按型号走不同的代码。
- **功能级别留在 `cpu_features`。** `"x86-64-v2"`、`"x86-64-v3"` 这两个预设和单个功能的增减都留在原地，
  属于高级用法，用来检查系统在较老的 CPU 上能否运行；它们不是型号，不进 `cpu_profile`，界面上也不显示。
  `cpu_features` 作用在型号之上，就像 QEMU 的 `-cpu Haswell,-avx2`。

**给新手的原则：**

1. **新手不需要选。** 处理器一项的默认值是“自动（由系统决定）”：系统预设已经选好了型号。只有当某个系统或
   游戏确实需要特定的 CPU 时才改它。
2. **界面上显示人话，API 用简短的名字。**
   - 界面上：型号的通俗名字、年代和一句话用途，例如“ARM Cortex-A8（2005）— iPhone 4 用的 CPU”；
   - API：`cpu_profile` 的值，只给写配置的开发者看。
3. **两类名字，一眼能分清。**
   - 真实芯片用它的型号名：`pentium3`、`cortex-a8`；
   - v86 自己的组合不对应任何一款真实芯片，统一用 `generic-` 开头，意思是“通用”：`generic-x86-64`。
     不用 `v86-` 前缀和 `v1`、`v2` 这类版本号，新手看不出它们的意思。
4. **只列有意义的型号。** 下拉框只显示当前机器能用的型号；只用于回归测试的配置不在界面上出现。

**型号表**（第一批只有现有行为与 `cortex-a8`，其余随需要它的计划加入）：

| 界面上显示 | `cpu_profile` | 架构 | 适合 | 状态 |
| --- | --- | --- | --- | --- |
| 通用 32 位 x86（推荐） | `generic-x86` | x86 32 位 | DOS、Windows 3.x 到 XP、32 位 Linux | 现有，x86 的默认，行为不变 |
| 通用 64 位 x86（推荐） | `generic-x86-64` | x86 64 位 | Windows 8.1 到 11 的 64 位版、64 位 Linux | 现有，x86_64 的默认，行为不变 |
| 通用 64 位 ARM（推荐） | `generic-arm64` | ARM 64 位 | 64 位 Linux、Android 16 | 现有，arm64 的默认 |
| 通用 64 位 ARM，能运行 32 位程序 | `generic-arm64-compat32` | ARM 64 位 | 64 位系统里要运行 32 位 ARM 程序时 | 现有 |
| ARM Cortex-A15（2011） | `cortex-a15` | ARM 32 位 | 32 位 Linux、Android 7.1 | 现有，arm32 的默认，行为不变 |
| ARM Cortex-A8（2005）— iPhone 4 用的 CPU | `cortex-a8` | ARM 32 位 | iPhone 4 机器（必须用它） | 本计划 S1 |
| ARM Cortex-A9（2007）— iPhone 4S；ARM11（2002）— iPod touch 1G/2G | `cortex-a9`、`arm1176` | ARM 32 位 | 对应的苹果机器 | 之后 |
| Intel Pentium（1993）、Pentium MMX、Pentium II、Pentium III、Pentium 4、Core 2、Core 2（Penryn）、Haswell（2013） | `pentium`、`pentium-mmx`、`pentium2`、`pentium3`、`pentium4`、`core2`、`penryn`、`haswell` | x86 | 只在软件检查 CPU 身份时用：某些老游戏和老系统要求特定的 CPU，Mac OS X 需要 Penryn 或 Haswell。界面上只在要求它的系统预设中自动选中，或放在“高级”分组里。没有 64 位模式的型号只用于 32 位机器；忠实的 `haswell` 还需要 v86 先实现 AES-NI 与 PCLMULQDQ | 之后，按需 |
| （界面不显示，只用于回归测试） | `generic-arm64-v1`、`generic-arm64-v1.1` | ARM 64 位 | 与 QEMU 参考比对时用（没有 PAN；`v1` 只有 4 KiB 页） | 现有 |

为什么现在的 32 位 x86 默认不叫 `pentium3`：它的 CPUID 报 family 6 model 7（代码注释写着 pentium3），但功能位
一直到 SSE3，而真正的 Pentium III 没有 SSE2 和 SSE3。它是 v86 自己的组合，所以叫 `generic-x86`；真正的
`pentium3` 以后作为单独的型号加入。

**`cortex-a8` 的依据。** 与现有的 `cortex-a15` 一样，以 QEMU 的同名型号为行为参考（只看行为，不抄代码）；
裸机测试对照 QEMU 的 `realview-pb-a8` 板。要点：
- MIDR 是 Cortex-A8 的；A4 的修订号在 S0 从内核与设备树的期望核对；
- ID 寄存器：没有 `SDIV`/`UDIV`（ID_ISAR0）；VFPv3 与 NEON，没有融合乘加与半精度转换（MVFR0/1）；没有 LPAE、
  generic timer、虚拟化与多处理器扩展。核心照样能执行这些指令，armv7 的 iOS 代码不会用到；
- 缓存几何（CLIDR、CCSIDR）照 A4 填：XNU 按组与路清缓存，几何不对时会清不干净或循环过长。

**旧选项直接替换，暂不考虑兼容：**

- 删除 `a64_profile`，改用 `cpu_profile`。`cpu_features`（含 `"x86-64-v2"`、`"x86-64-v3"` 预设）不变。
- VM 管理器的配置字段 `cpu.profile`（`src/app/vm_config.js`）直接改存新名字。
- 不做别名，也不迁移旧的配置与快照。

**界面：**

- 设置对话框的处理器一项新增“CPU 型号”下拉框：
  - 第一项是“自动（由系统决定）”；
  - 其余按上表第一列显示，每项下面一行灰字写用途；
  - 只列当前机器能用的型号；
  - 选了不推荐的型号时，在这一项上提示原因（例如“这台机器的系统需要 64 位 CPU”）。
  预设不改默认型号。

**测试：**
- 选项检查：`cpu_profile` 与 `cpu_type` 冲突、机器要求的型号、由型号推出 `cpu_type`；
- 每个型号的 ID 寄存器与 CPUID 读回，arm32 用裸机程序，x86 用现有的 CPUID 测试；
- 现有测试与预设改用新选项后结果不变；
- `make app-tests` 中“CPU 型号”下拉框的用例。

### 在仓库中的位置

| 位置 | 内容 |
| --- | --- |
| `src/rust/aarch64/a32_system.rs`、`sysregs.rs` | Cortex-A8 配置（见“`cortex-a8` 的依据”）：MIDR、ID 寄存器、MVFR（VFPv3 + NEON）、缓存几何；不报 LPAE、generic timer 与 GIC 的 CP15 接口；A8 特有的 CP15（L2 辅助控制等）读写为“只存值” |
| `src/rust/aarch64/gic.rs` | 没有 GIC 的机器：一个由机器直接置 CPU 的 IRQ/FIQ 线的入口。现在核心只看 GIC 算出的 `SIGNAL`；s5l8930 的 VIC 用这个入口 |
| `src/machine_options.js`、`v86.d.ts`、`src/app/vm_config.js`、`src/app/ui/settings.js` | `cpu_profile` 选项与型号表（取代 `a64_profile`）、设置中的“CPU 型号” |
| `src/apple/s5l8930.js` | 机器：地址布局、设备创建、复位、快照 |
| `src/apple/boot.js` | Mach-O 装载、`boot_args`、设备树补全 |
| `src/apple/devicetree.js` | 苹果设备树格式的解析与写回 |
| `src/apple/vic.js`、`timer.js`、`uart.js`、`gpio.js`、`clock.js` | 中断、定时器、串口（Samsung 风格）、GPIO 与按键、时钟/电源门控/chipid/miu 寄存器 |
| `src/apple/i2c.js`、`pmu.js`、`sensors.js` | I2C 控制器，电源管理芯片（RTC、电量、充电状态、背光），各种传感器 |
| `src/apple/spi.js`、`multitouch.js` | SPI 控制器，多点触控控制器（Z2 协议）；照 ARM 机器的做法向页面宣告 `mouse-enable` 与 `absolute-pointer`，页面才会把触控板交给它，点击时也不锁指针 |
| `src/apple/h2fmi.js`、`cdma.js`、`aes.js` | NAND 控制器与 NAND 芯片模型，DMA 与 AES 引擎 |
| `src/apple/clcd.js` | 显示控制器与 MIPI DSI、vsync 中断 |
| `src/gles/`（与 Android 共用） | GLES 代理：解码器、影子状态、renderControl、后门传输（见 [gles-proxy-plan.md](gles-proxy-plan.md)）；后门的截获在 `src/rust/aarch64/a32.rs` |
| `tools/ios/` | 主机侧工具（node）：`ipsw.mjs`（img3、AES、LZSS、根文件系统 DMG 解密）、`devicetree.mjs`、`kernel_patch.mjs`、`nand_build.mjs`、`hfsplus.mjs` |
| `tools/ios/guest/` | 客体侧的 GL ES 代理库与补丁说明（armv7，见“GPU”；与 `tools/windows/` 的客体工具同一做法） |

外设的寄存器布局与行为以设备树的 `reg` 与 `compatible` 属性、openiBoot `plat-a4` 的驱动和 The Apple Wiki 为准，
每个外设在实现前写下它的契约（寄存器、中断号、iOS 驱动用到的行为）。DRAM 起始地址与内核虚拟基址在 S0 从
设备树与内核中核对。

## 引导

v86 代替 iBoot 完成交接：

1. **装载内核。** 内核缓存（kernelcache）是带 kext 的 Mach-O，按各段的地址放进 RAM。
2. **补全设备树。** 解密后的设备树是一个模板，iBoot 会在启动时填入 `chosen` 等节点的属性（芯片与板子 ID、
   `unique-chip-id`、随机种子、NVRAM 内容、`root-matching`、`memory-map` 中内核与 ramdisk 的位置等）。v86 按
   同样的方式填写；没有模拟的设备（基带、Wi-Fi、蓝牙）的节点删除或标为不可用。需要的属性清单在 S0 从内核
   与设备树中整理。
3. **准备 `boot_args`。** 结构见 XNU 开源代码的 `pexpert/pexpert/arm/boot.h`：版本、物理与虚拟基址、内存
   大小、内核数据末尾、帧缓冲描述（`Boot_Video`：基址、行宽、宽、高、色深）、设备树地址与长度、命令行。
   XNU 的 ARM 代码从 iOS 11 时代的 xnu-4570 才公开；iOS 6 的内核（xnu-2107）没有公开的 ARM 源码。这个头文件是
   后来版本的布局，只作起点：字段、`Revision` 与 `Version` 在 S0 用 iOS 6 内核的反汇编（读 `boot_args` 的代码）
   核对。
4. **交给内核。** MMU 关闭，`r0` 指向 `boot_args`，跳到内核入口。CPU 的状态照 iBoot 留下的样子设置。

命令行 `-v serial=3` 让内核把启动日志输出到串口与屏幕上，供 S1–S3 调试。

## 存储

iPhone 4 用原始 NAND：H2FMI 控制器，内核里的 VSVFL 与 YAFTL 两层（坏块管理与闪存转换层），其上是分区、
HFS+ 的系统分区与数据分区。数据分区受数据保护：

- 每个文件的密钥由保护类密钥包装；
- 类密钥在系统钥匙包 `/private/var/keybags/systembag.kb` 里；
- 钥匙包的密钥、Dkey 与 EMF（文件系统）密钥存放在 NAND 的 effaceable storage 中，后两者由 AES 引擎用设备
  唯一的 UID 派生的密钥加密。iOS 4 的 locker 是 BAG1、Dkey、EMF! 三个。Belenko 的 iOS 5 资料说 iOS 5 起 LwVM
  取代了 EMF!，另一份 iOS 5 的资料仍列 EMF：iOS 6.1.3 的实际布局在 S0 核对。

真机上这些都由 iTunes 恢复固件时生成。本计划不在模拟器里跑完整的恢复，而是由构建工具离线生成同样的结构：

1. **模拟器的 UID 是一个固定的假密钥。** AES 引擎用它做真实的 AES 运算；构建工具用同一实现，所以构建工具
   包装的密钥模拟器能解开。
2. **数据保护的加密。** 真机在 NAND 的 DMA 路径上用 AES 引擎加解密文件数据。模拟器的这条路径与构建工具
   约定为同一种变换，可以是恒等变换，只要读写两侧一致；内核从不校验密文。
3. **`nand_build.mjs` 的工作**：
   - 按 iPhone 4 的 NAND 几何写出 VSVFL/YAFTL 的结构、分区表（MBR，或 iOS 5 起的 LwVM，按版本核对）和
     effaceable storage；
   - 系统分区：解密后的根文件系统 DMG 中的 `Apple_HFSX` 分区（区分大小写的 HFS+）；
   - 数据分区：根文件系统 `/private/var` 的内容，按恢复时的规则加上保护属性；
   - 钥匙包；跳过首次设置的偏好（Setup Assistant 的 `SetupDone`）；
   - 结构以 openiBoot 的 `vfl-vsvfl`、`plat-a4/yaftl.c`、`h2fmi.c` 与 Sogeti 的 iphone-dataprotection 工具和演讲
     资料为参照。
4. **镜像是稀疏的。** 真机的 NAND 有 16 或 32 GB，镜像只存写过的块，作为可写的 overlay 磁盘，与 `hda` 的
   存储后端相同（浏览器磁盘、快照）。

首次启动时如果没有 `systembag.kb`，iOS 是否会自己创建，S4 要先确认；如果不会，就由构建工具生成。

**备选：在客体里建数据分区。** 如果离线写出的分区表、文件系统或钥匙包与内核的预期对不上，S4 改用 S3 的
ramdisk 环境：用固件自带的工具（`newfs_hfs`、`asr` 等）在模拟的 NAND 上建分区与文件系统，走与真机恢复相同的
代码路径，加密也由内核与模拟的 AES 引擎完成。构建工具这时只写 NAND 的几何，以及（如果内核不会自己格式化）
VSVFL/YAFTL 的空结构。

## 系统服务与补丁

需要的补丁都由 `kernel_patch.mjs` 等工具在用户本机对用户自己的固件进行，补丁说明（位置的查找规则与修改
内容）写在仓库里，补丁后的苹果二进制文件不进仓库、不分发。

- **内核**：关闭代码签名检查（AMFI），使 GL ES 代理库和补丁后的系统程序能加载；必要时关闭 sandbox 的个别
  检查。与 iOS 6 越狱工具同类的补丁，按版本列出。v86 自己的二进制（客体库、shell）用开源的 `ldid` 加伪签名，
  与越狱环境相同。如果 S5 选了内联钩子（见“GPU”），补丁还要允许改写代码页。
- **激活**：iPhone 在 iOS 4–6 首次进入主屏幕前要联网到苹果服务器激活，并且需要 SIM 卡。离线的模拟器按越狱
  工具的 hacktivation 做法修改 `lockdownd`。这是阻塞点，S4 先验证；不行就先做 iPod touch 4G 型号。它不需要
  SIM 与基带，但本身可能也要激活，S4 一并核对。
- **看门狗**：iOS 的超时按真机定，在慢 CPU 上会杀进程：应用启动超时的看门狗（崩溃码 `0x8badf00d`）、
  SpringBoard 与 backboardd 的启动检查。对策与 ranchu 相同：放慢机器时钟（Android 7.1 用宿主的十分之一），
  倍数在 S4 测量后定。
- **基带**：设备树中删除或禁用基带，CommCenter 报“无服务”。如果它的反复重启影响开机，再给它一个最小的
  “基带不在”行为。
- **电源与时钟**：
  - PMU 报满电量、正在充电、温度正常，否则 iOS 会提示低电量并关机；
  - RTC 给宿主时间；
  - 背光亮度由 PMU 控制，作用于显示的亮度。
- **传感器**：加速度计、陀螺仪、指南针、距离与环境光传感器给静止、竖持的合理读数。可选：用浏览器的
  DeviceMotion 驱动加速度计与陀螺仪。

## GPU

iPhone 4 的 GPU 是 PowerVR SGX535，没有公开文档，硬件级模拟不现实。iOS 的界面合成（Core Animation 的渲染服务）
与游戏都通过 OpenGL ES 1.1/2.0 画图。iOS 6 引入的 `backboardd` 接管了事件处理；渲染服务在它里面还是在
SpringBoard 里，S0 核对。本计划在 OpenGL ES 这一层代理。

### 与 Android 32 位共用一套 GLES 代理

32 位 Android（`ranchu` 上的 Android 7.1，[arm32.md](arm32.md)）现在用 `qemu.gles=0`，界面由 CPU 绘制。它的
镜像里自带 Android 模拟器的 GLES 客体栈（2026-10-27 从 `armeabi-v7a-25_r18` 的 `system.img` 核对）：
- `libEGL_emulation.so`、`libGLESv1_CM_emulation.so`、`libGLESv2_emulation.so`；
- 编码器 `libGLESv1_enc.so`、`libGLESv2_enc.so`、`lib_renderControl_enc.so`、`libOpenglSystemCommon.so`；
- `gralloc.ranchu.so`。

它们把 GL 调用编码成 emugl 协议，经 goldfish pipe 的 `opengles` 服务交给宿主。这个协议后来演变成 gfxstream
的 GLES 协议，今天的 Android 模拟器仍用同一套宿主解码器运行这些老镜像。v86 已经有 gfxstream 的传输与
按操作码分派解码器的框架（[gfxstream-protocol.md](gfxstream-protocol.md)），但还没有解码任何 renderControl 命令
（Android 16 的官方模式在客体内合成，不发 renderControl）。renderControl、GLES 的解码器与执行器都要新写。

所以两边共用一个代理：**协议用 gfxstream/emugl 的 GLES 协议**，宿主侧写一次，客体侧各接各的：

```text
iOS 6（armv7）                                 Android 7.1（armeabi-v7a，ranchu）
libv86gles.dylib：v86 自己的编码器              镜像自带的编码器与 libEGL_emulation
  + EAGL / IOSurface 的适配层                     （不改客体的任何文件）
    │ 用户态后门指令（UDF）与进程内的环            │ goldfish pipe 的 "opengles" 服务
    └──────────────────┬──────────────────────────────┘
          gfxstream/emugl 的 GLES 协议：renderControl + GLESv1 + GLESv2 的操作码
                       │ CPU 侧：解码、按参数的方向与长度读取客体内存、
                       │ 影子状态回答查询、打成 GLES 批次
                       │ 渲染器通道的新 stream "gles"
          页面：GLES 执行器（共用 gl-webgpu 的函数）→ WebGPU
```

**宿主侧（共用）：**
- **解码器**：按 gfxstream 源码中 GLES 协议的规格文件（`*.in`、`*.attrib`、`*.types`）生成，与 gfxstream 的
  Vulkan 部分同样固定在 `gfxstream-protocol.md` 记录的提交上。
- **renderControl**：全部新写。v86 现在一个 rc 命令也不解码，只回答进程管道（`GLProcessPipe`）。
- **影子状态**：CPU 侧保存一份 GL 状态的影子，`glGetError`、`glGetIntegerv` 等查询由它直接回答，不等页面上
  的渲染器。只有 `glReadPixels`、`rcReadColorBuffer` 这类要数据的调用才往返；`glFinish` 与同步对象只要顺序。
- **执行器**：页面上新的 GLES 执行器，共用 `src/browser/glbridge/gl-webgpu/` 的函数，不拆 XP 的执行器
  （gles-proxy-plan.md 的“结论”第 4 条）。三项：
  - 着色器：在现有的 GLSL 1.20 前端上加 GLSL ES 1.00 的方言（精度限定符等）；
  - GLES 1.1 的固定功能：复用现有的 `gl_fixed_function.js`；
  - 压缩纹理：ETC1（Android）用 WebGPU 的 ETC2 特性，没有就解码；PVRTC（iOS 游戏常用）一律解码成 RGBA。
- **呈现**：颜色缓冲作为显示画面送进合成器层，或者回读到帧缓冲。

**iOS 侧（本计划独有）：**
- **客体库** `libv86gles.dylib`（armv7）：
  - 编码器由同一套规格文件生成 C 代码；
  - 构建：clang 加 cctools-port 的 ld64，链接用从固件导出表生成的桩，不需要苹果的 SDK；
  - 注入：`DYLD_INSERT_LIBRARIES`（`launchd` 环境中设置，覆盖 `backboardd` 与各应用）；
  - 替换 Objective-C 的部分：`EAGLContext` 等类的方法在构造函数中替换。消息是动态分派的，共享缓存里的调用者
    也走得到；
  - 替换 C 函数不能只靠 dyld 的 `__interpose`：它只改进程与它装载的库之间的绑定，共享缓存
    （dyld_shared_cache）内部的调用不经过它。Core Animation（QuartzCore）调 OpenGL ES 正是缓存内部的调用。
    S0 用静态分析定下做法，候选依次是：
    - 替换上下文的 GL 分派表：如果 OpenGLES 的 C 入口按当前上下文的分派表转发，接管上下文的创建就接管了
      全部调用；
    - 内联钩子：改写 OpenGLES 导出函数的开头。要求内核补丁允许改写代码页，越狱环境的 MobileSubstrate 就是
      这样做的；
    - 替换 GL 驱动插件（`IMGSGX535GLDriver.bundle`）：接口私有、面很大，作为最后的选择。

    `__interpose` 只用来补应用自己调用的部分。共享缓存不改。
- **EAGL 到 renderControl 的对应**：
  - `EAGLContext` → `rcCreateContext`；
  - `renderbufferStorage:fromDrawable:` → 窗口表面加颜色缓冲；
  - `presentRenderbuffer:` → 把颜色缓冲交给合成（`CAEAGLLayer` 的内容），不直接上屏；
  - 共享组（sharegroup）→ 共享上下文。
- **上屏**：渲染服务把合成结果画进 IOSurface，再经 IOMobileFramebuffer 的 swap 交给显示控制器扫描输出
  （The Apple Wiki 的 IOMobileFramebuffer 页面记有 `swapBegin`、`swapEnd` 与返回 IOSurface 的
  `getDefaultSurface`）。代理里这些 IOSurface 的内容在宿主的 GPU 上，客体内存里没有。做法二选一，S0 看清
  iOS 6 的路径后再定：
  - 客体库接管 IOMobileFramebuffer 的 swap 调用，把对应的颜色缓冲交给 `rcFBPost`，不回读；
  - 显示控制器（CLCD）扫描输出时，向宿主要回那块 IOSurface 的内容。
- **苹果私有部分**：Core Animation 用到的私有扩展、IOSurface 作为纹理和渲染缓冲，放在 v86 自己的扩展操作码
  区间里。清单在 S5 开头由静态分析 QuartzCore、OpenGLES 的导入与调用整理，touchHLE（源码 MPL-2.0）的
  EAGL 实现可作为语义参考。
- **传输**：一条用户态的后门指令（约定立即数的 `UDF`）加进程内的环，作用相当于 goldfish pipe。不用 MMIO 设备，
  因为 iOS 的用户进程没有内核驱动就碰不到设备寄存器。细节见 [gles-proxy-plan.md](gles-proxy-plan.md) 的 “iOS 传输”。

**顺序：先做 Android 32 位，再做 iOS 的 S5。** Android 这边客体完全不用改，是未经修改的真实编码器在驱动宿主侧，
解码器与执行器的错误能在没有逆向的环境里先找出来。之后 iOS 的 S5 只剩客体库、EAGL 适配、上屏和苹果私有部分。
Android 32 位因此得到 GPU 加速的界面，现在由 CPU 绘制的慢界面（[arm32.md](arm32.md) 的 “Known defects”）也随之
解决。共用部分的阶段、测试和验收见 [gles-proxy-plan.md](gles-proxy-plan.md)，iOS 的 S5 建立在它的 E0–E6 之上。

**软件渲染**：如果 S0 发现 iOS 6 的 Core Animation 有可用的软件渲染路径，S4 可以先用它点亮主屏幕，GPU 代理
作为性能与游戏的路线。

SGX 的内核驱动保持加载，但没有硬件：它的 MMIO 读回“空闲”，不产生中断。GPU 驱动初始化失败若导致系统
不能启动，就在设备树中禁用它的节点，由代理承担全部绘制。

## 界面

照 Android 镜像的做法（[vm-manager.md](vm-manager.md) 的 “Android”，`src/app/android_catalog.js`、`android_import.js`、
`android_import_worker.js`）：用户只选设备和版本、交出自己的文件，页面在本地验证、解密、打补丁、组装磁盘；
开机时由 v86 从磁盘中读出内核与设备树。新模块是 `src/app/ios_catalog.js`、`ios_import.js`、`ios_import_worker.js`。

**入口。** 实验性机器默认不显示。**Preferences…** 里有一个开关“显示实验性机器（iPhone）”，打开时显示一段说明：
固件与密钥由用户自己提供，只在本机处理，不得分享生成的磁盘。

**新建向导**（来源一步多出 **Apple 固件（IPSW）**）：

1. **设备与版本。** 目录列出已验证的组合，v1 只有“iPhone 4（GSM，iPhone3,1）· iOS 6.1.3（10B329）”。每项列出
   IPSW 的文件名、大小和哈希，以及验证状态。与 Android 目录不同，**不给下载链接**：文件由用户自己取得。
2. **固件。** 把 IPSW 拖进向导（或选择文件）。页面在本地读取，不上传：
   - 读出 `BuildManifest.plist`/`Restore.plist`，检查机型与版本和所选的一致；
   - 与目录中的哈希比对。
3. **密钥。** 粘贴或载入一个密钥文件（JSON，字段为内核缓存、设备树、恢复 ramdisk 的 IV 与 key，以及根文件系统
   的 key；格式见“复核结论”的“固件与密钥”），内容来自 The Apple Wiki 上该版本的页面。
   - 页面立即试解密逐项验证：内核缓存解开后应是 `complzss` 头，设备树能解析，恢复 ramdisk 在 0x400 处是 HFS+
     卷头，根文件系统有 `encrcdsa` 头、解出的末尾是 UDIF 的 `koly` 尾；
   - 哪一项不对就标在哪一项上；
   - 密钥不保存：组装完成后不再需要。
4. **磁盘。**
   - 容量 16 或 32 GB（稀疏镜像，只占实际写入的空间），保存在浏览器磁盘或磁盘服务上；
   - **完成** 后在 worker 里组装：解密、解压、本地打补丁、`nand_build`；显示进度，可取消。
5. **摘要。** 硬件固定（A4、512 MiB、iPhone 4 的显示与按键），只能改名字。

**设置对话框**（`s5l8930` 机器只显示这些项）：

| 项 | 内容 |
| --- | --- |
| iPhone | 型号（只读）、iOS 版本（只读）；启动参数（预设 `-v` 详细日志，开关）；GL ES 代理（开；关闭只用于调试，没有主屏幕）；横竖屏的初始方向 |
| 存储 | NAND 磁盘（不可移除）；**抹掉所有内容与设置…**：用磁盘中保存的系统分区重建数据分区，与真机的“抹掉”相同 |
| 串口 | 内核与 shell 的串口终端 |
| 声音 | S7 之后：开或静音 |

内存、处理器、显示适配器、硬盘、光驱、软驱、网卡、USB、共享文件夹、固件等项都不出现；配置校验拒绝它们
（与 `ranchu` 的规则相同，`src/machine_options.js`）。

**控制台：**

- 画面按手机的纵向 640×960 显示，旋转时改为 960×640；
- 工具栏提供 Home、锁屏（电源）、音量加减、静音开关、旋转；
- 快捷键：Home 键映射到 Esc（Esc 原有的功能另行安排），锁屏为 ⌘L；
- 指针：桌面上鼠标是一根手指，按住 Option 拖动是两指缩放；触屏设备上直接多点触控；
- 串口终端与其他机器相同。

**库与导出：**

- 库中显示设备与 iOS 版本；
- `.v86vm.json` 的导出本来就不含磁盘；
- **Browser disks…** 导出 NAND 磁盘时提示：磁盘中含有苹果的系统文件，只能自己备份，不能分享。

**配置结构**（S7 冻结）：
- `machine.type: "s5l8930"`；
- `ios: { model, build, boot_args, gles_proxy, orientation }`；
- NAND 是一个磁盘项；
- 配置版本加 1。

## 阶段

### S0 资料、固件与工具

1. 所有者取得 iOS 6.1.3 的 `iPhone3,1` IPSW 与对应的固件密钥。**2026-10-27 完成**，文件、出处与核对结果见
   “复核结论”的“固件与密钥”。
2. `tools/ios/ipsw.mjs`：
   - 解开 IPSW；
   - 解密 img3（AES-256-CBC，用密钥页面的 IV 与 key）：`DATA` 标签的密文补齐到 16 字节，按补齐后的长度解密，
     再截到标签记录的长度（只解整块的话，内核缓存最后一块解错，LZSS 的结果短几十字节）；
   - 解压 LZSS 内核缓存（`complzss` 头 0x180 字节，带 adler32 与解压后的长度）；
   - 解密根文件系统 DMG：VFDecrypt 的 `encrcdsa` 格式，key 是 36 字节（AES-128 的 key 加 HMAC-SHA1 的 key），
     每 4096 字节一块，IV 是块号（大端 32 位）的 HMAC-SHA1 的前 16 字节；解出的是 UDIF（`koly` 尾、zlib 块）；
   - 读 HFS+（根文件系统是区分大小写的 HFSX）；
   - `--check`：按密钥文件逐项试解密，检查内容与向导第 3 步相同。
3. 整理以下清单，写进本计划的“复核结论”：
   - 设备树：节点、`compatible`、`reg`、中断号；
   - 内核：kext 列表；
   - `chosen` 中 iBoot 填写的属性；`boot_args` 的布局与版本（反汇编内核读它的代码）；
   - Cortex-A8 的 MIDR 与缓存几何（内核与设备树的期望）；
   - effaceable storage 的 locker 与 LwVM 的格式；
   - Core Animation 的渲染路径：有没有软件路径；渲染服务在哪个进程；
   - GL 调用的路径：QuartzCore 与 UIKit 怎样调 OpenGLES，OpenGLES 的分派结构，决定 S5 替换 C 函数的做法；
   - 上屏的路径：IOMobileFramebuffer 的 swap 与 IOSurface，决定 S5 的上屏做法。
4. 在宿主上跑一次 QEMU-iOS 的 iPod touch 2G，记下它对 NAND 镜像与 SpringBoard 的做法，作为参照。

验收：从用户的 IPSW 得到可装载的内核、设备树与根文件系统；清单完成；本计划的 S1–S7 按清单修正。

### S1 CPU 配置、机器骨架与内核串口日志

- 先单独提交统一的 `cpu_profile` 选项（见“CPU 型号：统一的 `cpu_profile`”，现有机器的行为不变），再加 `cortex-a8` 型号；
- 机器的地址布局、VIC（经新的入口直接置 CPU 的 IRQ/FIQ 线，见“在仓库中的位置”）、定时器、UART、
  时钟/电源/chipid/miu 寄存器；
- Mach-O 装载、`boot_args` 与设备树补全。

验收：`-v serial=3` 下内核在串口上输出启动日志，一直走到等待根设备。

### S2 显示

- CLCD 与 MIPI DSI，帧缓冲经显示中枢输出，vsync 中断，背光。

验收：屏幕上显示启动 logo 与 `-v` 的文字日志；快照往返。

### S3 恢复 ramdisk 到 shell

- 用固件里的恢复 ramdisk（`rd=md0`）启动；
- 内核补丁；
- 最小的 PMU（RTC、电量）与按键；
- 在 ramdisk 中换入一个 shell。shell 用开源软件为 armv7 iOS 构建，不用越狱工具的二进制。最简单的起步是
  v86 自己写一个直接用 XNU 系统调用的静态小程序，不依赖 dyld 与 SDK；用 `ldid` 加伪签名。

验收：串口上能交互的 shell，`uname -a`、`sysctl hw` 正确。

### S4 NAND、数据保护与系统启动

- H2FMI、NAND 模型、CDMA、AES 引擎（假 UID）；
- `nand_build.mjs`；
- 激活与首次设置的处理、基带缺席、传感器；
- 看门狗与机器时钟放慢的倍数。

验收：内核从 NAND 挂载系统与数据分区；`launchd` 与核心的守护进程（`lockdownd`、`configd`、`mediaserverd` 等）
在运行，用 `ps` 确认。此时还没有画面：没有 GL 时 `backboardd` 与 SpringBoard 可能反复崩溃重启。记下它们停在
哪里，作为 S5 的起点，不算 S4 失败。

### S5 GL ES 代理

- 前提：共用的 GLES 代理（解码器、影子状态、执行器）已经由 Android 32 位验证过（见“GPU”）。它可以与 S1–S4
  并行推进。
- 后门指令、生成的 C 编码器与客体库的传输部分已在 gles-proxy-plan.md 的 E6 完成，并在 Linux armv7 上验证过。
- 本阶段只做 iOS 独有的部分：客体库的注入与 C 函数的替换（S0 定的做法）、EAGL 到 renderControl 的对应、
  IOSurface、上屏（S0 定的做法）、Core Animation 的私有扩展、PVRTC。

验收：主屏幕显示正确（图标、壁纸、状态栏、Dock）；与真机截图（所有者提供，或公开的 iOS 6.1.3 截图）比较。

### S6 交互

- 多点触控（Z2 协议：接受驱动上传的固件、报告就绪、送出触点帧）、按键（Home、电源、音量、静音开关）、
  方向。

验收：
- 解锁、翻页、打开并使用自带应用；
- 两指缩放（用触屏，或桌面上按住修饰键模拟）；
- 横竖屏切换。

### S7 集成与完善

- 声音（I2S 与音频 codec 的最小模型，接到 v86 的音频输出）；
- 快照（含 NAND overlay）；
- 性能测量；
- VM 管理器中作为实验性机器，按“界面”一节实现，`make app-tests` 增加向导与设置的用例；
- 文档：`docs/ios.md` 描述机器、工具与已知偏差，本计划改为“已完成”并精简。

### 之后

1. iOS 4.3.x、5.1.1、7.1.2（各版本的补丁与设备树差异）；
2. iPod touch 4G；
3. 安装用户自己的未加密 IPA（安装服务的签名检查补丁），验收经典的 GL ES 游戏；
4. iPhone 4S（A5）：Cortex-A9 双核与 A5 外设，作为下一台机器的计划。

## 测试

| 层 | 位置 | 运行方式 |
| --- | --- | --- |
| Cortex-A8 配置：ID 寄存器、缓存几何、无 LPAE、无 generic timer 时的行为，对照 QEMU 的 `realview-pb-a8`；没有 GIC 时由机器直接置 IRQ/FIQ | `tests/a32/` 的裸机程序（与现有的 A32 裸机测试同一框架） | `make a32-system-tests` |
| img3、AES、LZSS、苹果设备树、Mach-O：用测试自己构造的样本（假密钥），不用苹果的文件 | `tests/ios/tools.mjs` | `make ios-tests` |
| VIC、定时器、UART、I2C、SPI、GPIO、CLCD、H2FMI、CDMA/AES 的寄存器与中断 | `tests/ios/devices.mjs` | `make ios-tests` |
| NAND 构建工具：生成的镜像由独立的读取代码（VSVFL/YAFTL/HFS+）读回并核对 | `tests/ios/nand.mjs` | `make ios-tests` |
| GL ES 代理：录下的命令流经宿主执行器，在真 GPU 上比较像素 | `tests/glbridge/gles_*_browser_test.html` | `make display-browser-tests` |
| 客体：S1–S6 的里程碑（串口标记、截图） | `tests/ios/iphone4_boot.mjs` | 手动；需要 `IPHONE4_IPSW` 与 `IPHONE4_KEYS`，缺少时跳过 |

CI 只跑 eslint、构建与 `make ci-tests`：不依赖苹果文件的 `make ios-tests` 加进 `ci-tests`；需要固件的客体测试
手动运行。

## 法律与分发

（不是法律意见。）

- iOS 受苹果版权保护，许可协议只允许在苹果的设备上使用。v86 的仓库与网站不包含、不托管、不链接下载任何
  苹果的文件：IPSW、解密后的内核与文件系统、生成的 NAND 镜像、补丁后的二进制文件、固件密钥都不进仓库。
  计划与文档只记密钥页面的出处，不记密钥的值；开发者本机的密钥文件放在 git 忽略的 `build/ios/keys/`。
- 工具只处理用户自己提供的文件，在本机完成。页面上的 VM 管理器同样只在本地处理，不上传。
- 激活与代码签名的补丁只为在模拟器中离线运行，补丁说明以互操作与研究为目的记录；不提供绕过真机激活锁的
  功能。
- 网站不提供这台机器的在线体验；演示用录屏。

## 风险

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 内核依赖 iBoot 留下的硬件状态或未记录的设备树属性 | S1 卡在早期 | 对照 openiBoot 的初始化与 QEMU 类项目的做法；串口日志；XNU 开源代码中 ARM 的部分（iOS 11 以后的版本，只作参照）与 iOS 6 内核的反汇编 |
| NAND 与数据保护的格式细节 | S4 挂载失败 | iphone-dataprotection 的读取代码作为独立核对；先用 S3 的 ramdisk 环境检查读写 |
| 激活绕过不可行 | 停在激活界面 | iPod touch 4G 型号（去掉 SIM 与基带；它本身要不要激活，S4 核对） |
| Core Animation 依赖 SGX 特有的私有扩展 | S5 画面不完整 | 先整理私有接口清单；软件渲染路径（若存在）作为过渡 |
| `__interpose` 管不到共享缓存内部的调用 | Core Animation 的 GL 调用漏掉，主屏幕出不来 | S0 定替换做法：分派表、内联钩子或驱动插件（见“GPU”） |
| 上屏走 IOMobileFramebuffer 的 IOSurface swap | 画面不更新 | 客体库接管 swap，转成 `rcFBPost`；或 CLCD 向宿主要回内容 |
| iOS 的看门狗在慢 CPU 上杀进程 | SpringBoard 与应用反复重启 | 放慢机器时钟（ranchu 的做法） |
| 没有 GIC 的中断路径 | S1 收不到中断 | 新的入口直接置 IRQ/FIQ；裸机测试覆盖 |
| 多点触控控制器的协议细节 | S6 没有触控 | openiBoot 的多点触控驱动；先用按键与辅助功能测试其余部分 |
| A8 的性能与 JIT 覆盖 | 启动与界面慢 | v86 的 AArch32 页层；测量后针对热点优化 |
| 法律风险 | 项目受影响 | 严格执行“法律与分发” |

## 复核结论

**2026-10-27 复核初稿。** 对照 v86 的代码与公开资料核对，结果已经写进上文，这里汇总。S0 拿到固件后整理的清单也
写在这一节。

- **v86 的现状**：
  - arm32 的 MMU 已经支持 VMSAv7 的短描述符（段、超级段、大小页、域与 DACR、TEX 重映射，`mmu_a32.rs`），
    iOS 6 不用 LPAE 也能跑；
  - FIQ 已经实现，但 CPU 的中断信号只来自 GIC 的模型（`gic.rs` 的 `SIGNAL`），没有 GIC 的机器要新的入口；
  - 现在的 arm32 型号是 QEMU 的 cortex-a15 r4p0（MIDR `0x414FC0F0`），裸机测试对照 QEMU；
  - `A64_PROFILES` 是 v1、v1.1、v2、v3；x86 的预设是 `x86-64-v2`、`x86-64-v3`；x86 的 CPUID 报 family 6 model 7。
- **对初稿的修正**：
  - 内存由型号决定，iPod touch 4G 是 256 MiB；
  - `boot.h` 是 iOS 11 以后才公开的源码，iOS 6 的布局要反汇编核对；
  - effaceable storage 的 locker 在 iOS 5 前后不同；
  - dyld 的 `__interpose` 管不到共享缓存内部的调用，C 函数的替换要另选做法；
  - 上屏走 IOMobileFramebuffer 的 IOSurface swap，`presentRenderbuffer:` 不直接上屏；
  - 渲染服务在 backboardd 还是 SpringBoard，没有找到可靠的资料，改为 S0 核对；
  - iPod touch 去掉的是 SIM 与基带，它本身要不要激活还要核对；
  - 加上看门狗与机器时钟；S4 的验收不要求 backboardd 与 SpringBoard 存活；
  - 触控设备要向页面宣告 `mouse-enable` 与 `absolute-pointer`；
  - CI 只跑 `make ci-tests`；Cortex-A8 的裸机测试在 `a32-system-tests` 里。
- **固件与密钥**（2026-10-27，S0 第 1 步）：
  - IPSW：`iPhone3,1_6.1.3_10B329_Restore.ipsw`，938,891,219 字节，SHA-1
    `f8c53328656f2708e1d2bcb793f12ae46dd4eb23`（与 ipsw.me 公布的一致），就是界面目录中这一项的大小与哈希。
    所有者先下载的 `iPhone3,3`（CDMA，板子 N92AP）6.1.3 IPSW（936,050,758 字节，SHA-1
    `42f09fdc2e35426cc402ee683efb3b5e62dfe46a`）v1 不用：板子与密钥页面都不同。
  - 密钥：The Apple Wiki 的 [Keys:BrightonMaps 10B329 (iPhone3,1)](https://theapplewiki.com/wiki/Keys:BrightonMaps_10B329_(iPhone3,1))，
    共 18 项：根文件系统（只有 key）、更新与恢复 ramdisk、内核缓存、设备树、iBSS/iBEC/iBoot/LLB、9 张启动图片。
    本计划与仓库不记密钥的值；所有者的副本是 `build/ios/keys/iPhone3,1_10B329.json`（`build/` 被 git 忽略），
    工具与客体测试从 `IPHONE4_KEYS` 读它的路径。
  - 用到的项：内核缓存与设备树（S1）、恢复 ramdisk（S3）、根文件系统（S4），可选 AppleLogo（启动画面）。直接
    引导内核，不用 iBSS/iBEC/iBoot/LLB；不跑恢复流程，不用更新 ramdisk。
  - 核对：18 项都能用页面上的值解开（临时脚本直接从 IPSW 读，不解包；S0 的 `ipsw.mjs --check` 做同样的事）：
    - 内核缓存：`complzss`，LZSS 解压后 13,393,920 字节、adler32 相符，是 32 位 ARM 的 Mach-O，版本串为
      `Darwin Kernel Version 13.0.0 … xnu-2107.7.55.2.2~1/RELEASE_ARM_S5L8930X`；
    - 设备树：105 个节点完整解析，根节点的 `compatible` 是 `N90AP`、`iPhone3,1`、`AppleARM`；
    - 两个 ramdisk：0x400 处是 HFS+ 卷头，9 MiB；
    - 根文件系统：`encrcdsa` 解密后是 UDIF（`koly` 尾），里面是 Apple 分区表，系统分区是
      `disk image (Apple_HFSX : 5)`，区分大小写的 HFS+，1212 MiB；
    - iBSS/iBEC/iBoot/LLB 是 `iBoot-1537.9.55`；启动图片是 `iBootIm`。

密钥文件的格式（向导第 3 步载入的也是它；`images` 的键用密钥页面上的项名，这里的值是占位）：

```json
{
  "format": "v86-ios-keys",
  "version": 1,
  "device": "iPhone3,1",
  "board": "n90ap",
  "ios": "6.1.3",
  "build": "10B329",
  "codename": "BrightonMaps",
  "ipsw": { "name": "iPhone3,1_6.1.3_10B329_Restore.ipsw", "size": 938891219, "sha1": "f8c53328…eb23" },
  "source": "https://theapplewiki.com/wiki/Keys:BrightonMaps_10B329_(iPhone3,1)",
  "images": {
    "Kernelcache": { "file": "kernelcache.release.n90", "iv": "<32 位十六进制>", "key": "<64 位十六进制>" },
    "DeviceTree": { "file": "DeviceTree.n90ap.img3", "iv": "…", "key": "…" },
    "RestoreRamdisk": { "file": "048-2441-007.dmg", "iv": "…", "key": "…" },
    "RootFileSystem": { "file": "048-2748-005.dmg", "key": "<72 位十六进制>" }
  }
}
```

## 待所有者决定

1. 机器名 `s5l8930`、型号字段 `apple_model` 是否合适。
2. `cpu_profile` 的命名：真实芯片用型号名（`cortex-a8`、`pentium3`），v86 自己的组合用 `generic-` 开头
   （`generic-x86`、`generic-arm64`）；界面上的中文显示名。
3. 首个系统版本用 iOS 6.1.3，还是更轻的 4.3.x。4.3.x 没有 LwVM 与 backboardd，守护进程更少，开机路径更短，
   S4 的风险小；6.1.3 的界面更有代表性，能跑的应用也多。
4. 激活绕过不可行时，是否把首个型号改为 iPod touch 4G（它去掉 SIM 与基带，但本身可能也要激活）。
5. 实验性机器默认隐藏、由 Preferences 的开关打开（见“界面”），是否合适；Home 键映射到 Esc 是否可以。

## 规范与实现参考

- [The Apple Wiki](https://theapplewiki.com/)：[S5L8930](https://theapplewiki.com/wiki/S5L8930)、固件密钥（[iPhone3,1 的密钥页面分类](https://theapplewiki.com/wiki/Category:IPhone_4_(iPhone3,1)_Key_Page)）、IMG3 格式、内核缓存、设备树、LwVM、恢复流程、effaceable storage、[IOMobileFramebuffer](https://theapplewiki.com/wiki/Dev:IOMobileFramebuffer)、[backboardd](https://theapplewiki.com/wiki/Backboardd)
- [openiBoot](https://github.com/oranav/openiBoot)（GPL-3.0，只读参考）：[`openiboot/plat-a4`](https://github.com/oranav/openiBoot/tree/master/openiboot/plat-a4)（VIC、定时器、UART、时钟、电源、GPIO、I2C、SPI、PMU、CLCD、MIPI DSI、H2FMI、YAFTL、按键）、`vfl-vsvfl`、`usb-synopsys`、`radio-xgold618`、`hfs`
- Sogeti/ESEC 的 iphone-dataprotection 工具（许可证使用前核对）与资料：[iPhone data protection in depth](https://www.slideshare.net/slideshow/iphone-data-protection-in-depth/8079476)、[SSTIC 2012](https://www.sstic.org/media/SSTIC2012/SSTIC-actes/forensicsios/SSTIC2012-Slides-forensicsios-sigwald_bedrune.pdf)、[Belenko：iOS Data Protection](https://papers.put.as/papers/ios/2011/bh-ad-11-Belenko-iOS_Data_Protection.pdf)
- [QEMU-iOS](https://github.com/devos50/qemu-ios)（GPL-2.0，只读参考）与 [FOSDEM 2024 演讲](https://archive.fosdem.org/2024/events/attachments/fosdem-2024-2826-breathing-life-into-legacy-an-open-source-emulator-of-legacy-apple-devices/slides/22606/fosdem_presentation_pVgCvZ1.pdf)：iPod touch 1G/2G 的 NOR/NAND 生成与启动
- [alephsecurity xnu-qemu-arm64](https://github.com/alephsecurity/xnu-qemu-arm64)（GPL-2.0，只读参考）：直接引导 iOS 内核与补全设备树的做法（arm64，`boot_args` 的结构不同，只参考做法）
- [XNU 开源代码](https://github.com/apple-oss-distributions/xnu)（APSL）：`pexpert/pexpert/arm/boot.h`、`osfmk/arm/`（ARM 部分从 xnu-4570 起才公开，比 iOS 6 晚）
- [touchHLE](https://github.com/touchHLE/touchHLE)（源码 MPL-2.0，二进制 GPL-3.0 以上）：EAGL 与 GL ES 1.1 的语义参考
- QEMU（GPL-2.0，只读参考）：`cortex-a8` 型号与 `realview-pb-a8` 板，Cortex-A8 配置的行为参考
- ARM：ARMv7-A/R 架构参考手册、Cortex-A8 TRM、PL192 VIC TRM
- v86 内部：[arm32.md](arm32.md)（AArch32 核心）、[virt.md](virt.md)（ARM 机器与 ranchu 的先例）、[glbridge.md](glbridge.md)（代理与协议）、[gpu-devices.md](gpu-devices.md)（渲染器通道）
