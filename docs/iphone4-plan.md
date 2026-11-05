# iPhone 4（A4，S5L8930）机器实施计划

截至 2026-11-05，S1–S3 已用 iPhone3,1 的 10B329 固件验收。S4 已用原版内核从 NAND 挂载系统卷与数据卷，启动核心服务，加载系统钥匙包，并验证 C、D 两类文件写入、同步和重开后的内容。保留原版系统写入后断电，第二次冷启动已通过原版 YAFTL 全盘恢复并重新挂载两卷。浏览器入口与本地工具见 [iOS 使用说明](ios.md)。

S5 已在完整系统冷启动中显示原版 iOS 锁屏，并用模拟触控滑动解锁进入原版主屏。S6 已通过连续熄屏唤醒、主屏翻页、原版双指缩放及 Safari 横竖屏往返。设置、备忘录、计算器、日历和时钟已完成界面操作验收，照片和 Safari 的内容显示仍在验收。S7 已在 Chrome 用真实 IPSW 验证导入、擦除、从持久 NAND 冷启动、连续两轮唤醒和触控解锁。此前浏览器挂起恢复已验收到客体和 NAND 状态。

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
| `src/apple/spi.js`、`multitouch.js` | SPI1 控制器，多点触控控制器（N90 的 N1 协议）；照 ARM 机器的做法向页面宣告 `mouse-enable` 与 `absolute-pointer`，页面才会把触控板交给它，点击时也不锁指针 |
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
  - 10B329 的加载方式见下面 S5 系统进程加载记录。
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

**离线激活，2026-11-05。** 原版 10B329 `lockdownd` 的 `dealwith_activation` 已有本地 Activated 分支。模拟器准备镜像时，对通过完整 SHA-256 核验的私有副本改写一个 Thumb 分支（文件偏移 0xe22c），保留 `DisableHactivation` 检查，更新受影响的签名页，并只将重签后的哈希加入原版内核的信任表。新数据卷为 mobile 用户设置 `SetupDone`、`SetupFinishedAllSteps`、`SetupVersion=3` 和 `ForceNoBuddy`，符合原版 Preferences.framework 的设置检查。原版冷启动已记录两次实际进入激活分支，无需 SIM 或联网；使用这组偏好的启动越过了设置助理，只有完成标记的对照则反复启动 Setup。进入主屏仍是后续验收。

Chrome 与本地工具的压缩结果可能不同。若重写后的资源在原有分配块中放不下，构建器在私有 HFSX 副本末尾追加连续区段，重写目录分配、分配位图和两个卷头。已对故意放宽压缩的三份系统程序逐字节回读，并用独立的 HFSX 检查器验证扩展后的卷。

- H2FMI、NAND 模型、CDMA、AES 引擎（假 UID）；
- `nand_build.mjs`；
- 激活与首次设置的处理、基带缺席、传感器；
- 看门狗与机器时钟放慢的倍数。

验收：内核从 NAND 挂载系统与数据分区；`launchd` 与核心的守护进程（`lockdownd`、`configd`、`mediaserverd` 等）
在运行，用 `ps` 确认。此时还没有画面：没有 GL 时 `backboardd` 与 SpringBoard 可能反复崩溃重启。记下它们停在
哪里，作为 S5 的起点，不算 S4 失败。

### S5 GL ES 代理

直接引导为缺失或全零的 `/chosen/display-scale` 补上整数倍率 2，保留已有非零值。10B329 的 UIKit 从该属性读取无符号整数并转换成浮点数；原全零模板会让屏幕退回 1 倍。2026-11-05 的正常 NAND 冷启动中，已从运行中的原版 UIScreen 对象确认倍率为 2。独立构造的设备树测试覆盖默认值和已有值保留，原版启动文字、显示快照及构建回归通过。真实界面仍停在启动画面，此项不构成主屏验收。

同次排查发现原版 CADisplay 与 UIScreen 的范围为 0×0。LCD 模型此前只设置窗口自己的地址、跨度和范围，遗漏全局窗口选择寄存器 0x1038 的位 0x100；DisplayPipe 因此没有读取启动窗口，并将零尺寸传给上层。复位现启用第一窗口，`boot.mjs --wait-root --display` 新增原版驱动实例的尺寸检查，已冷启动确认其接管 640×960 窗口，画面和快照检查同时通过。完整界面另行验收。

**LCD 提交与 DART，2026-11-05。** 原版 DisplayPipe 将带序号的寄存器批次写入 0x103c；模型此前仅保存最后一个字，画面提交一直没有完成。现已解析批次和连续寄存器写入，更新 0x1048 的完成序号及 0x102c 的 0x100 状态。每次垂直回扫推进 0x1034 的 16 位计数；原版驱动会为带定时标志的批次预设计数，模型在指定回扫才应用。中断过滤器确认回扫位后，完成位仍可供原版工作线程读取。接收中及等待回扫的批次都保存进快照。

两个 DART 另已实现四条流、各 64 个 4 MiB 段的页表选择与读回；有效条目映射 4 KiB 物理页。LCD 第一窗口使用 DART2 的流 0，原版启动驱动将 0x1000 映射到启动帧缓冲。扫描输出和宿主完整面板发布均按页访问，允许物理页不连续；发布前验证全部映射。独立回归覆盖流/段隔离、无效页、非连续像素、接收中恢复及旧快照。`boot.mjs --wait-root --display` 已冷启动验收原版批次完成、DART 像素及快照恢复，构建检查通过。补发旧快照遗失完成通知的诊断副本已结束数据迁移，并创建系统自身的 EAGL 上下文；正常完整冷启动与最终主屏像素仍在另行验收。

- 前提：共用的 GLES 代理（解码器、影子状态、执行器）已经由 Android 32 位验证过（见“GPU”）。它可以与 S1–S4
  并行推进。
- 后门指令、生成的 C 编码器与客体库的传输部分已在 gles-proxy-plan.md 的 E6 完成，并在 Linux armv7 上验证过。
- 本阶段只做 iOS 独有的部分：客体库的注入与 C 函数的替换（S0 定的做法）、EAGL 到 renderControl 的对应、
  IOSurface、上屏（S0 定的做法）、Core Animation 的私有扩展、PVRTC。

原版合成器的 GL 入口还使用客户内存中的顶点和索引。客体库在绘制时复制仍启用的顶点数组，按原始步长取数据并打包，索引缓冲路径仍传偏移。两种路径已在原版 backboardd 和 SpringBoard 的 EAGL 上下文中逐像素验证：先画 VBO 三角形，再用带填充的顶点和非连续索引覆盖为另一颜色。构建当前 WebGPU 渲染器后，可用 `tests/ios/system.mjs --draw` 复测；此项不代替主屏验收。

原版合成器已提交带顶点和索引的绘图，目标是附到 FBO 的 640×960 IOSurface 纹理。客体库在结束该 FBO 的绘图时，将修改过的表面从 WebGPU 分批读回并写入原版 IOSurface，再交给原版 LCD 交换。原版两个进程的独立回归已逐像素核对 FBO 切换后的共享内存。普通纹理上传保留像素行填充；PVRTC1 在客体内展开成 RGBA，原版 GLES 入口已验证上传和整级替换。`make ios-pvrtc-tests` 可独立复测位深、环绕、透明度和小纹理；另有 784 组输入和 [PowerVR SDK 参考解码器](https://github.com/powervr-graphics/Native_SDK/blob/master/framework/PVRCore/texture/PVRTDecompress.cpp) 逐像素对照。真实主屏仍单独验收。

**原版锁屏及主屏，2026-11-05。** 客体适配器等 WebGPU 像素读回并解锁 IOSurface 后，才让原版合成器提交对应图层。已写完的表面无需再等待 SGX 发出完成信号。这个处理只应用于识别出的 10B329 QuartzCore 和该适配器已完成的表面。原版 IOMobileFramebuffer 确认了换帧，LCD 实际选中了经 DART 映射的锁屏表面。可用 `tests/ios/system.mjs --screen` 检查实际扫描输出。一次完整冷启动中，滑动通过 N1、原版 HID 和 backboardd 投递给 SpringBoard，随后实际 LCD 输出显示图标、壁纸、状态栏和 Dock。该次解锁有明显延迟。

验收：主屏幕显示正确（图标、壁纸、状态栏、Dock）；与真机截图（所有者提供，或公开的 iOS 6.1.3 截图）比较。

### S6 交互

- 多点触控（N90 的 N1 协议：接受驱动上传的固件、报告就绪、送出触点帧）、按键（Home、电源、音量、静音开关）、
  方向。

10B329 原版设备树将 `multi-touch,n90` 挂在 SPI1；固件的驱动匹配项选择 `AppleMultitouchN1SPI`。Z2 匹配项用于 K48、K94、J1，不能直接当作 N90 协议。SPI2 是基带，继续作为非目标移除。

已补 SPI0、SPI1 的独立控制寄存器、16 字节收发 FIFO、PIO 全双工传送和中断，并追加快照状态。直接引导为全零的外设时钟项补上模拟值，保留已有非零值：pclk 为 100 MHz、两个 SPI 的 nclk 为 24 MHz。这些是模型配置，不是测得的真机频率；原版驱动此前因 pclk 为零，在映射控制器之前就返回失败。

原版 NAND 冷启动已匹配 N1 驱动，完成两字节唤醒命令及多次 16 字节探测，通过 VIC 中断 30 排空接收 FIFO并确认完成。在断开触控芯片的控制器验收中，返回 0xff 空总线后，驱动明确报告未找到 HBPP 并正常退出。可用 `node tests/ios/spi.mjs <原版固件目录> <NAND 镜像>` 复测此项 PIO 传输。设备测试覆盖 FIFO 背压、中断屏蔽与重开、在途快照；构建、原版启动文字和显示快照回归均通过。

SPI1 另已接通原版 N1 上传固件使用的纯发送 DMA，通道 18、19 的中断路由到应用处理器。该驱动使用 32 字节回调环；控制位 0x10 启用的描述符进度现于中断前更新，旧的 NAND FIFO 模式保持原有语义。模拟器保留一次 SPI 请求在描述符批次间的字节位置及快照状态。独立设备测试覆盖 70 KB 分散数据、两种请求先后顺序、批次补充、在途恢复及不重复发送。原版冷启动在诊断空闲应答下，已发送约 53 KB 固件，处理 DMA 完成中断、回收描述符并结束 SPI 事务；运行上面命令时加 `--dma` 可复测。接收 DMA 尚未建模。

**N1 启动协议，2026-11-05。** 现已连接独立的 N1 芯片模型。它校验分段上传的长度、头部与数据校验和，提供只读芯片标识、带掩码的校准寄存器、启动命令、接口版本和短报告的两阶段应答。上传的 ARM 代码由客体自己提供；模型不保存或执行这段代码，只实现芯片的外部协议。D1 报告 N1F55 家族标识；D3 单独报告小端格式、行列和模拟固件版本；D9 用百分之一毫米报告模拟的 50×75 mm 传感器。主机仍以 640×960 像素为输入坐标，与 UIKit 的点坐标分开。GPIO 20 的低电平复位会清除固件及协议状态，协议状态也加入快照。

原版 10B329 冷启动已确认上传 256 字节校准数据和 53,196 字节固件，完成寄存器校准、启动命令、接口版本及 D1、D3、D0、A1、D9 五项报告读取，未触发属性缓存失败或设备重启。`node tests/ios/multitouch.mjs <原版固件目录> <NAND 镜像>` 可复测。独立设备回归覆盖损坏上传拒绝、在途恢复、寄存器掩码、只读标识、应答校验和、报告两阶段及硬件复位，构建检查通过。此启动协议阶段尚未验收触点帧。

**N1 触点传输，2026-11-05。** GPIO 21 已连接帧队列中断，EB 两阶段传输提供长度查询、五字节头校验、数据校验和及 1/2 序号重试。二进制触点帧使用 24 字节头和 28 字节触点记录，支持五个活动触点及按下、移动、抬起；坐标限制在模拟面板内。浏览器鼠标与多点触控按显示区域缩放，并保持浏览器触点标识；控制器启动和恢复时通过 `mouse-enable`、`absolute-pointer` 启用页面输入。队列、活动触点、重试帧与传输中途状态均加入快照。旧设备快照按无待处理触点恢复。

原版冷启动测试已逐项读取按下、移动、抬起，三帧分别使用 1、2、1 序号，各读取一次，无重试或固件恢复。私有观察器另确认三帧均通过原版内核校验并进入上层分发入口；这不等于已生成 HID 触控事件。独立回归覆盖两点触控、边界、损坏请求不消耗队列、同序号重传不重复消耗、在途恢复、宿主输入缩放与复位，构建检查通过。完整系统的触控解析、HID 事件及解锁/滑动操作仍待验收。帧字段的公开交叉参考见 [openiBoot 的结构定义](https://github.com/planetbeing/iphonelinux/blob/master/openiboot/includes/multitouch.h)。

**N1 触点解析与 HID，2026-11-05。** 触点现在带手指类别，按原版 N90 配置选择的有效区域映射屏幕坐标，使用有符号的小端坐标并反转传感器 Y 轴。在正确读取 D1、D3 和 D9 的正常冷启动检查点中，原版 backboardd 对一次单指和一次双指的按下、移动、抬起共生成九个手指事件。按下和移动的 range、touch 均为 1，抬起均为 0；原版滤波后的横纵坐标最大偏差分别为屏宽的 0.71% 和屏高的 2.12%。该测试观察原版函数入口并继续执行其代码，未替换事件或返回值。解锁、翻页和双指缩放仍须用实际界面验收。

触点路径编号从 1 开始，保留原版 HID 拒绝的编号 0。后续冷启动已观察到滑动事件进入 SpringBoard 的队列并最终解锁。延迟期间，SpringBoard 主线程在注册电源通知时等待 IOService 锁，原版显示驱动反复匹配背光服务，而背光服务在等待原版 NAND 发布 IONVRAM。

NVRAM 分区现以块映射标志发布，原版 IOFlashNVRAM 能取得四颗芯片上各两个块的几何并初始化空白区。旧 v86 镜像的两份分区表在读取时兼容，无需重建或改写分区表。用旧镜像冷启动已验证原版背光驱动找到 CLCD，系统和数据卷正常挂载。面板彻底休眠后，DSI 软件复位现会清除通道低功耗状态，设备回归覆盖休眠请求清除后再复位的顺序。`tests/ios/system.mjs --panel-power` 已用原版 10B329 通过连续两轮电源键熄屏和 Home 键唤醒，每轮检查黑色与恢复后的彩色 LCD 像素。该次本地冷启动约 683 秒出现首个彩色帧。

原版应用启动看门狗曾以 `0x8badf00d` 终止设置，报告的 20.27 秒窗口内设置取得 5.85 秒 CPU 时间。N90 图形模式默认以 0.2 倍宿主时间推进客体时钟，留出应用启动时间，显式配置的客体时钟仍可覆盖默认值。用这个速率恢复原版锁屏后，滑动进入主屏，打开设置并进入通用页面。界面动画与计时器也按客体时间推进。

**原版应用和方向，2026-11-05。** 在 10B329 中，设置打开通用并修改自动锁定选项，备忘录通过原版软键盘输入并保存一条笔记，日历从日视图切到月视图，时钟的秒表开始并持续计时。主屏滑动切到第二页，打开实用工具中的计算器，触控计算 2 + 3 得到 5。Safari 通过宿主的旋转控制完成横屏、竖屏往返，原版工具栏和地址栏在 LCD 扫描输出中重新布局。

Safari 的原版沙箱拒绝从数据卷打开 GLES 适配器。仅在私有对照实例中临时放行这个文件的读取后，原版 Safari 绘制了离线 `data:text/html,v86` 页面，LCD 上可见 `v86`。导入器现将适配器放在系统卷的 `/usr/lib` 中，将 Safari 的弱依赖指向该副本，并登记更新后的签名。系统卷已通过 HFSX 一致性检查。新镜像正在按原版沙箱规则冷启动复测。

**原版双指缩放，2026-11-05。** 在设置的「移动和缩放」界面，从触控总线送入两根手指的张开和合拢轨迹。原版 UIKit 缩放控件实际收到逐步增大的比例，张开时最高约 3.80，松手后回弹到 1.50，合拢时降到约 0.53。诊断只记录函数的输入参数，缩放逻辑由原版代码执行。从测试 NAND 回读的 640×960 截图 PNG 含正确的壁纸与预览界面，照片查看器和移动缩放界面却显示蓝色内容。该缩放验收覆盖原版手势和控件状态，图片像素显示单独跟踪。

同一原版运行中，编号 0 和 1 的按下、移动、抬起均通过了帧解析，只有编号 1 进入 HID 数字化器事件的构建路径。宿主鼠标和触屏现分配非零编号。旧快照里的在途 SPI 报告照常恢复，原版系统已忽略的活动触点 0 不再继续分配给宿主手指。

**传感器，2026-11-05。** I2C2 上的 LIS331DLH 可按四个方向输出重力；MPU3100 提供静止时的角速度、温度、原始采样中断和 FIFO。I2C0 上的 AK8975B 提供稳定磁场和单次测量，CT700 提供室内光线和无遮挡距离。模型只启用设备树中同类备选器件的一颗。设备测试覆盖测量、读写、确认和在途快照；原版 10B329 已识别加速度计和陀螺仪、读到指南针工厂增益、探测 CT700，并两次读取 D1815 实时时钟。客体应用读取传感器和旋转仍待界面验收。寄存器参考：[ST LIS331DLH](https://www.st.com/resource/en/datasheet/lis331dlh.pdf)、[InvenSense MPU-3000 系列](https://invensense.tdk.com/wp-content/uploads/2015/02/MPU-3050-Register-Map.pdf)；CT700 的读取布局来自本地固件驱动。

验收：
- 解锁、翻页、打开并使用自带应用；
- 两指缩放（用触屏，或桌面上按住修饰键模拟）；
- 横竖屏切换。

### S7 集成与完善

**浏览器实测，2026-11-05。** Chrome 对原版 IPSW 及所有必需的本地密钥逐项验证，在浏览器私有存储中写入稀疏 NAND。设置页已擦除并重建数据，随后从保存的 NAND 自行加载内核和设备树，用 CPU Worker 启动原版 iOS，挂载两卷。运行中的客体和 NAND 已在浏览器本地挂起，并从库中恢复；该次挂起约占 110 MB。控制台的旋转按钮已验证更新屏幕坐标映射；客体应用自身的旋转另行验收。当前导入只支持 16 GB 布局和浏览器本地存储。

在 NVRAM 和 DSI 修复后的 Chrome 冷启动中，约 34 分 44 秒出现原版锁屏。连续两轮电源键熄屏、Home 键唤醒都恢复了彩色锁屏。浏览器触控滑动后，LCD 实际显示了原版主屏的图标、壁纸和 Dock。此轮写入了主屏状态的挂起数据，随后测试脚本误回到控制台地址，完整图形状态从库中恢复仍待复测。

- 完成界面启动所需的音频控制初始化（I2S 与音频 codec）；PCM 播放输出仍属于“之后再定”；
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

**2026-11-04，10B329 的实机固件与 v86 串口。** 公开入口使用 `machine_type: "s5l8930"`、
`graphics_adapter: "none"`、`ios.kernelcache` 和 `ios.devicetree`。默认选择单核 Cortex-A8 和 512 MiB。
`build/ios/10B329` 下保留本地提取结果，固件不入库。

- `LC_UNIXTHREAD` 给出的虚拟入口为 `0x80086084`。N90 主内存从 `0x40000000` 开始，
  入口物理地址为 `0x40086084`。入口从 r0+4、+8、+12、+16 读取虚拟基址、物理基址、内存大小和临时页表起点。
  页表起点必须按 16 KiB 对齐，内核从此处清零 40 KiB。
- 此内核在 `0x8027ad4a` 从启动参数 +2 读取版本并检查它等于 3；命令行从 +0x38 取。
  设备树指针使用虚拟地址。内核把 `/pram/reg` 作为启动跟踪缓冲区，模板中全零的范围会导致数据异常。
- 设备树的总线地址需要经 `/arm-io/ranges` 翻译。UART0 在 `0x82500000`，IRQ 22；
  四个 VIC 从 `0xbf200000` 开始，间隔 64 KiB。PMGR 的 24 MHz 计数器在 `0xbf102000`。
  时间基准留零会触发内核的 `rtclock timebase_callback` panic。
- 入口的 cache 清理循环给出 64 字节行、四路 32 KiB L1 和八路 512 KiB L2。
  MIDR 暂用本机 QEMU Cortex-A8 的 `0x410fc080`，固件设备树没有给出芯片修订值。
- UART0 输出了 corecrypto 的完整性、AES、TDES、SHA、HMAC、ECDSA 和 DRBG 自检结果。
  IODTNVRAM 按小端 16 字节单位遍历 8 KiB 的 nvram-proxy-data。模板中的零长度分区会让遍历原地循环。
  填入 common 分区后，IOKit 启动 AppleARMBacklight 和 AppleARMPerformanceController。
- 不挂盘时运行 `node tests/ios/boot.mjs build/ios/10B329 --wait-root --display`。
  它要求串口收到等待 Apple_HFS 根设备的消息，并验证修改过的显示内存能经快照恢复到逐像素一致。
  CLCD 使用 `0x5f700000` 的 640×960、32 位启动帧缓冲。没有使用宿主绘制的替代启动画面。
- 使用 `ios.ramdisk` 与 `rd=md0` 后，串口报告 `BSD root: md0, major 3, minor 0`。
  调试恢复盘的工具将本地构建的静态 shell 替换到恢复盘副本中，回读验证可执行文件。
  实测 10B329 的 BSD 初始化在 `0x802bbe68` 调用 IOSecureBSDRoot，随后 AppleARMPlatform 等待
  SecureRootCallBack。调试副本用两个 Thumb NOP 替换此处的 BL。工具检查完整 SHA-256 和原指令，
  拒绝其余版本、已修改的输入或已存在的输出文件。原始内核仍用于无盘 S1 测试。
- S3 本机复测（以下命令从仓库根运行；输出目录须存在，镜像文件须为新文件）：
  ```sh
  sh tools/ios/guest/build-shell.sh build/ios/shell
  node tools/ios/kernel_patch.mjs build/ios/10B329/kernelcache.n90.macho build/ios/shell/kernel.macho
  node tools/ios/recovery-ramdisk.mjs build/ios/10B329/restore.dmg build/ios/shell/recovery-shell build/ios/shell/disk.dmg
  node tests/ios/recovery.mjs build/ios/shell/kernel.macho build/ios/10B329/DeviceTree.n90ap.bin build/ios/shell/disk.dmg
  ```
  macOS 自带 clang、ld 与 codesign 可生成 armv7 静态 Mach-O 及 SHA-1/SHA-256 临时签名，无需 iOS SDK。
  串口输入后，内核 sysctl 返回 Darwin 13.0.0、iPhone3,1、1 核、527433728 字节可用物理内存。
  时钟门控和 CDMA 通道注册已过启动探测，CDMA 数据传送、
  DART DMA 地址转换、NAND、密钥与完整电源模型还未验收。

**S2 显示与中断记录。** 从用户的 IPSW 提取 `AppleLogo.ibootim`，可选 `ios.bootlogo` 将其合成到启动帧缓冲。
在同一提取目录运行 `node tests/ios/boot.mjs 目录 --logo --iop --wait-root --display`。AppleCLCD 会核对
第二段 CLCD 寄存器的 +0x60（宽高各减一）和 +0x50（显示使能）。内核实际从 VIC0+0xf00 取到
VIC1 的向量 `0x8000002a`，随后到 CLCD+0x102c 查询状态。+0x1028 是掩码，状态位写一清除；
完成中断时先写所属 VIC，再写 VIC0。PMU 寄存器 0x66、0x67 和 0x68 控制背光 DAC 和使能。

**S4 辅助串口，2026-11-05。** 原版 UserEventAgent 打开电量计的 UART5 时，AppleSamsungSerial 在读取控制寄存器（物理地址 0x82a00004）时触发内核异常。现为设备树中六个辅助串口提供各自的控制、FIFO 状态与波特率寄存器，启动控制台仍用 UART0。用已有启动快照重放时，已观察到 UART5 多轮真实控制读写，系统随后开始读取 PMU 的 ADC 通道。电量计外设的串行应答仍待验证。

D1815 PMU 的原版驱动写寄存器 0x30 启动 ADC，等待 GPIO 13 中断，然后读取状态块的第二个字节。此前它反复报告 ADC 状态停在 1。模拟转换现在锁存完成位，按板级设备树经 GPIO 控制器和 VIC 中断 116 通知内核。完整冷启动跟踪到了 32 次原版驱动读取含 0x20 的状态块，同次运行未再出现 ADC 状态超时。设备测试覆盖屏蔽、开中断、确认及快照恢复。未建模的模拟输入返回零；温度与电池电量数值尚待校验。

**N90 面板识别，2026-11-05。** 恢复设备树在 `/arm-io/mipi-dsim/lcd` 留下为零的 `lcd-panel-id`。在该值为零的对照运行中，ApplePinotLCD 的启动方法返回失败，AppleCLCD 对象已出现在 IORegistry 但没有可打开的主显示器。backboardd 对显示列表的断言抛出 `NSInternalInconsistencyException: No window server display found`，随后被 launchd 重启。

直接引导现在为缺失或全零的面板标识填写模拟值 1，保留设备树原有的非零值。这个值选择 Pinot 一类面板，不代表某块量产屏的厂商编号。仅替换这个字段时，10B329 的同一方法返回成功，串口报告面板标识 1、类别 1，并进入此前未到达的 AppleCLCD 抖动配置阶段。`tests/ios/boot.mjs <固件目录> --wait-root --display` 同时检查两项驱动日志、画面和快照。完整系统中，原版 IOMobileFramebufferGetMainDisplay 从返回 0xe00002c0 和空引用变为返回 0 和有效引用。未替换入口的 backboardd 执行 CAWindowServer 的 addDisplay: 后再次读取显示列表，越过了原先的断言。

**S4 正在实施：需要运行 IOP 固件。** 未填充的闪存设备树会使 AppleIOPFMI 报告 32 个全零芯片 ID。
在局部探测中，提供 NAND 几何后必须给 `/arm-io/clock-frequencies` 中的 0x21 项赋值，
否则驱动在 `_fmiInitTimings` 的 `clockSpeedKHz > 0` 断言中停止。实验用 100 MHz，不代表测得的真机时钟。
随后 AppleARM7M 向 0x86300100 发停止命令 0x10 并检查状态位 1，再写 +0x110（固件物理基址）、
+0x114（实测 256 KiB）并从本地地址零启动。固件内有 ARM 指令异常向量。v86 已用独立寄存器组执行此固件；
IOP 的低地址映射到所选 DRAM，0xc0000000 起的窗口通向共享 DRAM，另有从 0xbf300000 开始的 VIC。
用 `node tests/ios/flash.mjs build/ios/10B329` 可复测：实测 IOP 自己向 FMI 的命令窗口发出
NAND READ（0x3000）。已支持擦除态和已写页读回，已接入稀疏物理镜像（见下文）。芯片读写、VSVFL/YAFTL、LwVM 和系统盘挂载分别验收；
恢复盘 shell 不作为 S4 的验收依据。

**S4 物理 NAND 镜像和分区，2026-11-04。** `ios.nand` 接受本地生成的四芯片稀疏镜像，使用通用磁盘后端按范围读取。
每个总线有两个 CE，块大小为 128 页，每个 CE 有 0x1038 块。按总线、CE、物理行号排列；
每页 8192 字节数据及 436 字节 spare，按位取反存储并将槽补齐到 8704 字节，稀疏空洞即全 0xff 的擦除页。
构建工具不覆盖已有文件。以下两个实测走原版内核和真实 IOP 固件：

- `node tests/ios/flash.mjs build/ios/10B329` 把标记写入 0 号芯片的第 0 页。
  客体向 H2FMI 发出 0x3000 读命令，等待采样状态，经 CDMA 通道 5 的描述符将 1536 字节复制到应用 CPU 的 RAM；
  IOFlashStorage 的分区解析器打印出该标记。
- `node tests/ios/flash.mjs build/ios/10B329 --partition` 使用 `nand_build.mjs bootstrap`。
  物理页 0、1 含 10B329 接受的 Grdn 分区表。客体识别 Boot Block、Effaceable、NVRAM、Firmware 和 Filesystem，
  发布第 4 个分区，AppleNANDLegacyFTL 从物理块偏移 15 启动并通过 FIL、BUF、FPart 初始化。
  这些偏移是模拟器的布局。每颗芯片末块含 DEVICEINFOBBT，第一颗另含 NANDDRIVERSIGN。原版内核读出 0x43313131，报告 VSVFL Register 和 VFL Init 均为 OK。四颗芯片的第 15 块各含 8 份 VSVFL 上下文，spare 按物理行号 whitening；原版驱动扫描环形目录后报告 VFL_Open [OK]。上下文选择 FTL 类型 2 后，原版驱动报告 YAFTL Register [OK]。独立读回测试覆盖四个物理槽。ce-bitmap 每个总线占 8 位，dbg-chipids 每个总线留 16 个槽。修正位图为 0x303 后，固件分别从 FMI0/CE0、FMI1/CE0、FMI0/CE1、FMI1/CE1 读取坏块表，回归测试核对四个物理地址。bootstrap 模式的 YAFTL 控制块为空，会触发只读全盘恢复。
- 新增 format 模式写入干净的 CX01 检查点。控制块为 3997，逻辑页依次跨 FMI0/CE0、FMI1/CE0、FMI0/CE1、FMI1/CE1。10B329 读取控制页后报告 FTL_Open [OK] 并发布闪存服务。运行 node tests/ios/flash.mjs build/ios/10B329 --format --snapshot 可复测。
- H2FMI 支持 DMA 编程数据与 spare、确认写入和按块擦除。设备测试验证只能清零已写位、擦除范围和快照恢复，包括跨页 DMA 的中间状态。当前格式化卷的逻辑页索引为空，尚需写入 LwVM、系统与数据卷并验证数据保护。

**S4 逻辑卷，2026-11-04。** 构建器将本机的 HFS+/HFSX 系统与数据卷写入 NAND 的数据页、反向页表、索引页及 CX01 目录。
LwVM 的逻辑扇区 0 含校验和及两个分区的块映射。10B329 识别两个分区，选择系统分区 disk0s1s1 为 BSD 根设备。
数据分区为 disk0s1s2。带 NAND 的直接启动默认传 rd=disk0s1s1，显式 boot_args 仍优先。
本机使用 1,271,173,120 字节的原版系统卷和一个 128 MiB 空白 HFSX 数据卷。独立读取器逐页核对两个源卷的全部字节。
原版内核在 SecureRootCallBack 处等待。使用 S3 同一份本地调试内核（无 ramdisk），HFS 根卷挂载成功，原版系统卷的 launchd 以 PID 1 打印启动消息，随后调用 fsck_hfs。此后曾出现 YAFTL 批量读的元数据校验错误；数据卷挂载、密钥与核心服务仍待验收。

```sh
node tools/ios/nand_build.mjs volumes build/ios/root-native.img build/ios/10B329/rootfs.hfs build/ios/n90-data-probe.dmg
node tests/ios/nand-volumes.mjs build/ios/root-native.img build/ios/10B329/rootfs.hfs build/ios/n90-data-probe.dmg
node tests/ios/system.mjs build/ios/10B329 build/ios/root-native.img
node tests/ios/system.mjs build/ios/10B329 build/ios/root-native.img --debug-kernel build/ios/shell/kernel.macho
```

**S4 系统与数据卷挂载，2026-11-04。** 10B329 恢复镜像的 fstab 使用 disk0s1 和 disk0s2。system-volume 在独立副本中将这两项改为实际的 LwVM 子分区 disk0s1s1 和 disk0s1s2，保留原挂载选项。CX01 检查点现在记录数据和索引块的下一个空闲页，首次写入不会覆写已编程页。Grdn 的第 5 项是物理块 14 上的 fbbt，AppleNANDFactoryBBT 匹配后系统才发布 Effaceable、NVRAM 和其他分区。

data-volume 在 macOS 上生成稀疏的 HFSX 卷，容量 15,082,717,184 字节，复制系统卷 /private/var 下 60 个条目。
构建器独立回读文件、符号链接、属主和权限。用本地调试内核启动后，fsck_hfs 检查两个正确的分区，客体报告系统卷只读挂在 /，数据卷可写挂在 /private/var。FIPS 用户空间自检通过。
从 XNU 进程表同时读到 launchd (1)、mediaserverd (39)、lockdownd (45)、configd (48) 和 backboardd (26)，PID 可随启动次序变化。
数据卷缺少系统钥匙包时，keybagd 打印 FATAL KEYBAG ERROR: kb_load，随后 launchd 关机。数据保护、持续运行与首次设置仍未验收。

```sh
node tools/ios/system-volume.mjs build/ios/10B329/rootfs.hfs build/ios/system-fstab.hfs
node tools/ios/data-volume.mjs build/ios/system-fstab.hfs build/ios/var-full.hfs
node tools/ios/nand_build.mjs volumes build/ios/seeded.img build/ios/system-fstab.hfs build/ios/var-full.hfs
node tests/ios/nand-volumes.mjs build/ios/seeded.img build/ios/system-fstab.hfs build/ios/var-full.hfs
node tests/ios/system.mjs build/ios/10B329 build/ios/seeded.img --debug-kernel build/ios/shell/kernel.macho --processes
```

**S4 可擦除密钥存储。** plog 使用 slice 标志，物理块 1–4 的启动页 16 保存第 1 代 Face 记录。头部、内容 CRC 和 BAG1 记录由构建器生成，BAG1 内的密钥材料仅供模拟设备使用。H2FMI 支持客体以三个 512 字节的 PIO 传输写入一张启动页，写到半个扇区时也可快照往返。
运行 node tests/ios/flash.mjs build/ios/10B329 --lockers --snapshot，10B329 的 AppleEffaceableStorage 报告在 group 0 读取到第 1 代记录。尚须让 keybagd 从数据卷加载与此记录配套的系统钥匙包，并验证 UID 加解密。

**S4 原版内核启动，2026-11-04。** A4 的 CDMA 通道 1 从内存取明文或密文，通道 2 将 AES-CBC 结果写回内存。两个通道分别向应用处理器发送完成中断。原版内核使用固定的模拟 UID 执行设备密钥派生，完成安全根设备回调。启动使用固件设备树原有的安全根前缀。

在本机用带实验性系统钥匙包的 NAND 运行 `node tests/ios/system.mjs build/ios/10B329 build/ios/bag-candidate.img --processes`，未修改的 kernelcache 挂载了只读系统卷与可写数据卷，进程表同时出现 launchd（PID 1）、mediaserverd（39）、lockdownd（45）和 configd（48）。此项仅验收挂载与进程启动；系统钥匙包解锁和首次设置需独立验证。

**S4 系统钥匙包，2026-11-04。** data-volume 生成与本机模拟 UID、BAG1 配套的无密码钥匙包，并将它写入数据卷的 `/keybags/systembag.kb`。目录属主为 root、模式为 0700，文件属主为 root、模式为 0600。建盘后逐项核对 62 个文件和目录的内容或元数据。主机侧用独立 AES 实现验证封装、SIGN 和十组类别密钥的完整性。

在 10B329 原版内核和系统上，采样 keybagd 实际调用 syslog 时传入的格式化消息，读到 `main: System Keybag loaded`。同次启动可看到 backboardd、SpringBoard 的进程名。尚需验证带保护类别的文件读写、首次设置与激活，以及主屏幕画面。后续启动日志中出现 `AppleNANDLegacyFTL::readRegion: failed to read region 1` 和 `Failed to read syscfg region.`，下一步核对该出厂配置区。
用 `node tests/ios/system.mjs build/ios/10B329 build/ios/provisioned-s4.img --keybag` 在新生成的 NAND 冷启动复测通过。检查器在客体内存里查找含线程 ID 和调用者名的完整日志，同时核对双卷挂载与四个核心进程。固件内置的消息常量无法单独满足此检查。
在独立系统卷副本的 fstab 给数据卷启用 `protect` 后，原版内核在挂载输出中列出该标志，同一冷启动也通过了 `--keybag`。在钥匙包加载后调用客体的 open、fcntl、write、fsync、close、read 与 unlink，确认 D 类文件（类别 4）重开时类别和八字节负载均保留。受保护数据卷默认使用此挂载选项。C 类（首次解锁后可用）在同一启动阶段设置类别返回 EPERM，首次解锁和其他类别仍待验证。此测试没有检查 NAND 原始页上的密文。
**S4 出厂配置。** 已确认 AppleNANDLegacyFTL 的第 1 区读取名为 DEVICEUNIQUEINFO 的物理特殊页。构建器在第一个芯片末块的第 2 页写入 SCfg，包含模拟器专用的 SrNm。用原版内核启动自建 NAND 后，在隔离的诊断运行中调用已注册的 AppleNANDLegacyFTL 实例的 readRegion(1)，IOKit 返回成功，缓冲区内的 44 字节 SCfg 和序列号与建盘输入一致。此项验收驱动读取路径，首次设置流程还需另测。
**S4 文件保护类别，2026-11-05。** 生成工具现在分别处理钥匙包中设备专用的 WPKY（32 字节、零 IV 的 AES-CBC）和 HMCK、Dkey（RFC 3394）。物理可擦除区的 Dkey 与钥匙包中的 D 类密钥解密后相同。用修正后的数据卷与 NAND 冷启动，keybagd 成功加载系统包。在它报告加载成功后执行客体文件系统调用，设置 C 类（3）、写入、同步、关闭、重开、查询类别、读回并比对八字节内容，全部通过。此前的“EPERM”发生在旧镜像，单独看到系统包加载成功无法覆盖文件类别测试。仍须独立测试真实的锁定/解锁转换和物理 NAND 上的密文。




**S4 系统卷零页，2026-11-05。** 10B329 对没有 YAFTL 映射的逻辑页可能保留读取缓冲区的旧内容。旧镜像从系统分区起点连续读取 32 MiB 时，前 8 MiB 正确，到 12 MiB 的累计 CRC32 出现差异。宿主端模拟跳过未映射的页，复现了全部八个检查点。构建器现为整个系统卷分配 NAND 页，并按数据卷的 HFS 分配位图保留已用块里的零页。旧镜像需从源卷重新构建。

独立校验器已核对新镜像的两个完整源卷。用 `build-shell.sh <目录> --nand` 构建恢复 shell，以 `recovery-ramdisk.mjs` 放入恢复盘，再运行 `node tests/ios/recovery.mjs <内核> <设备树> <恢复盘> --nand <NAND> <系统HFS>`。在原版内核中，连续 128 次读取 256 KiB 后，全部八个累计 CRC32 均与源系统卷吻合。

**S4 批量 NAND 读写，2026-11-05。** 原版 IOP 在较大的分页操作中会分批提供 CDMA 描述符。模拟器现在响应 FIFO 清空命令，保留批次结束时的剩余长度并通知 IOP 补充描述符。读操作等数据和备用区两个通道都完成再通知固件切页。设备测试还覆盖了描述符批次在一个 FIFO 请求中间结束，以及在该处保存、恢复快照。

在一次性 NAND 上，原版内核已连续完成 32 次 1 MiB 写入。独立回读使用 `node tests/ios/nand-roundtrip.mjs <内核> <设备树> <带 --nand 命令的恢复盘>`，测试自行建盘，从数据分区第二页开始写入四份不同的 1 MiB 数据，关闭后重新打开，逐字节核对所有 4 MiB。修复前原版驱动在读取时报告 DMA 超时，修复后两次冷启动均通过。此项验收覆盖原始分区 I/O；系统长期运行单独验证。

**S4 异常重启。** 重新建盘时，每个已分配 YAFTL 块使用独立序号，闭合块的反向页表标明闭合，检查点保留各在用块的序号和下一写入序号。此前恢复会对物理块 0–18 发出擦除，包括引导区、可擦除密钥和 VSVFL 上下文。现在由每颗芯片的 VSVFL 上下文将这些虚拟块指向保留池，真实物理引导分区保持原位。见 [openiBoot 的 VSVFL 映射实现](https://github.com/iDroid-Project/openiBoot/blob/master/vfl-vsvfl/vsvfl.c)。两次原版冷启动回归先把第一次启动的写入同步到测试镜像，再从头启动并要求第二次执行完整 YAFTL 恢复、重新挂载两卷且没有崩溃。用 `node tests/ios/nand-reboot.mjs <固件目录> <已准备的系统 HFSX> <数据 HFSX>` 复测。

**S4 闪存命令与芯片时序。** 原版 IOP 在屏蔽普通中断时等待发出 PROGRAM CONFIRM，之后再读芯片自己的状态。现在 PROGRAM 可立即确认，芯片保持忙直到写完。若原版驱动此时提交同芯片的验证读，按芯片排序的后端让它等到写入完成，另一颗芯片可独立继续。ERASE 则在该芯片真正完成后才确认，避免原版 YAFTL 恢复提交成千上万条擦除命令，阻塞后续读取。空块按字检查，无需写入零。原版异步后端已从一次非正常关机完成 YAFTL 全量恢复，读出密钥区并检查、挂载两个 HFS 卷。设备测试覆盖两个状态的独立确认、验证读顺序、快照等待和重复擦除保留稀疏区域。

**S5 接口核对，10B329。** 本机原版 armv7 共享缓存的 OpenGLES 含 344 个 `gl[A-Z]` 公共符号。反汇编确认 glClear、glDrawArrays、glDrawElements、glGetError 和 glViewport 经每线程的分派表调用。包装函数从 TPIDRURO（清低两位）偏移 0x78 取当前表，从表偏移 0x10 取驱动上下文作为第一个参数。五个函数的目标槽偏移依次为 0x3c、0x118、0x120、0x1ac、0x550。S5 客体适配层可据此为每个 EAGL 上下文设置分派表，需保留驱动上下文参数与原有寄存器、栈参数布局。

QuartzCore 的动态依赖含 OpenGLES、IOSurface、IOMobileFramebuffer。其未定义符号含 EAGLContext、SwapBegin、SwapSetLayer、SwapEnd 和 SwapWait，但符号表没有逐个导入公共 gl 函数。仍须用运行中的合成进程验证实际绘制入口与最终呈现。
运行 `node tests/ios/gl-dispatch.mjs build/ios/dp/cache-armv7`，测试从用户的共享缓存取出这五个位置无关的 Thumb 函数，并在 v86 的 AArch32 核心上实际执行。测试覆盖空上下文、驱动上下文指针、寄存器及栈上传参、返回值。此项覆盖公共入口的 ABI，上下文创建与合成仍须在系统客体内验证。
**S5 客体与宿主通信，2026-11-05。** N90 支持显式启用 `gles_backdoor`。用 `sh tools/ios/guest/build-shell.sh build/ios/gles-shell --gles` 构建诊断程序，以 recovery-ramdisk 工具装入本地恢复盘后，运行 `tests/ios/recovery.mjs` 并加 `--gles`。10B329 原版内核中的用户态程序已用真实 UDF 指令探测接口、打开 opengles 服务、发送三个 renderControl 显示参数查询、读回 640×960 和 326 dpi、关闭连接。此测试使用应答检查通道，未提交图形帧。下一项是从客体创建渲染上下文并经真实渲染器核对像素。
**S5 首张 GPU 测试帧，2026-11-05。** 用同一恢复盘构建流程和 `node tests/ios/recovery.mjs <原版内核> <设备树> <带 GLES 命令的恢复盘> --frame`，在本机 Chrome 的 WebGPU 设备上复测。iOS 用户进程经 UDF 创建上下文、窗口与颜色缓冲，画出绿色底面和左下角 2×2 红块，提交整帧并从宿主读回 8×8 采样区的全部 64 个像素。宿主把最终发布的全尺寸 RGBA 图像按当前 CLCD 窗口地址写回 XRGB 显存，经正常扫描输出。640×960 个像素逐一匹配；清空显存再恢复快照后，全部像素与保存前一致。这是恢复环境中的绘图验收。backboardd 的 EAGL/IOSurface 适配与 SpringBoard 主屏幕仍待验收。

10B329 OpenGLES 的 Objective-C 方法表另确认了私有参数入口 `initWithAPI:properties:`、`texImageIOSurface:target:internalFormat:width:height:format:type:plane:invert:` 及 `attachImage:toCoreSurface:invertedRender:`。接下来需将这些系统调用方与已验证的传输、上屏路径接通。
10B329 的本地共享缓存可直接生成驱动分派表头文件。工具核对 OpenGLES 的 UUID，从 344 个公开 Thumb 入口解出 322 个不同的槽位，最大字节偏移为 0xe58；部分别名共用同一槽。全部槽位已跟本机 LLVM 的独立反汇编逐一比对。AArch32 测试用生成的头文件安装回调，再实际执行原版函数核对 ABI。表头只描述位置，各函数的协议编码和私有调用约定仍需逐项支持。
**S5 原版 OpenGLES 入口绘图，2026-11-05。** 恢复盘里的绘图程序现在可以调用 10B329 自带的 `glClearColor`、`glClear`、`glEnable` 和 `glScissor`。四个入口从线程分派表取出客体驱动回调，回调将实际参数发给宿主。测试覆盖四个浮点颜色分量及带栈参数的裁剪矩形。原版内核中实际绘制并读回 64 个采样像素，宿主核对 CLCD 的全部 640×960 个像素和恢复快照后的画面。此路径使用恢复环境创建的上下文，系统合成器创建上下文和提交桌面仍需独立验收。

在本机运行 `sh tools/ios/guest/build-shell.sh <输出目录> --native-gles <dyld_shared_cache_armv7>`，用 `recovery-ramdisk.mjs` 装入本地恢复盘，再以 `tests/ios/recovery.mjs <原版内核> <设备树> <恢复盘> --native-frame` 验证。构建时从用户提供的缓存取出这四个入口，生成的私有文件只供本地测试。

**S5 系统进程加载，2026-11-05。** 10B329 的 launchctl 从共享缓存内的 xpcd_cache.dylib 读取启动任务。对照运行已确认，仅在两份磁盘 plist 中加 DYLD_INSERT_LIBRARIES 时，两个进程的 dyld 映像清单均不含客体库。现用 `system-volume.mjs ... --gles` 在私有副本的 backboardd、SpringBoard 原有 Mach-O 头部空隙增加弱库依赖，重算改动页的签名哈希，保留原有依赖序号和权限声明。数据卷的 `--gles-library` 选项按 root:wheel、0755 安装 `/private/var/v86/libv86gles.dylib` 并回读验证。固件共享缓存保持原样。

专用的 `graphics-kernel.mjs <原版内核> <已链接的系统卷> <客体库> <新内核>` 只接受已核对的 10B329 原版输入，将这两个副本和客体库的 CodeDirectory 哈希写入 AMFI 原生信任表，并跳过启动时清空该表头的一条指令。原有签名校验继续执行。在隔离的同版本客体中装入这组哈希后，分别从 backboardd 和 SpringBoard 的 dyld 映像清单读到了客体库，与原版 QuartzCore 和 OpenGLES 同驻。独立冷启动也已读回预置表头。映像清单证明加载，初始化、EAGL 调用与主屏幕呈现另行验收。
客体库由 `sh tools/ios/guest/build-gles.sh <输出目录>` 构建。10B329 的 ARM 入口可以由 dyld 的模块初始化指针直接调用。机器只在启用 GLES 传输时在设备树的 /chosen 下发布版本号，客体库读取该属性后才执行 UDF。它向宿主查询实际显示大小，并通过 Objective-C 运行时接入 EAGLContext 的私有初始化方法，目前将初始化转交给原实现并记录结果。已从冷启动复测通过 `--graphics`：backboardd 和 SpringBoard 均已在本进程中加载客体库、挂接初始化方法、查询宿主并发出含各自 PID 与实测 640×960 的完整日志；同一运行还验证了核心进程、钥匙包和两个卷。独立快照复测中两者的 PID 分别是 26 和 65。目前该方法转交原实现，尚未让系统合成器经代理绘制主屏幕。

本地验收命令（输出路径须是新文件，数据卷生成需要 macOS）：
```sh
sh tools/ios/guest/build-gles.sh build/ios/gpu
node tools/ios/system-volume.mjs build/ios/10B329/rootfs.hfs build/ios/gpu/system.hfs --gles
node tools/ios/data-volume.mjs build/ios/gpu/system.hfs build/ios/gpu/data.hfs --gles-library build/ios/gpu/libv86gles.dylib
node tools/ios/nand_build.mjs volumes build/ios/gpu/flash.img build/ios/gpu/system.hfs build/ios/gpu/data.hfs
node tools/ios/graphics-kernel.mjs build/ios/10B329/kernelcache.n90.macho build/ios/gpu/system.hfs build/ios/gpu/libv86gles.dylib build/ios/gpu/kernel.macho
node tests/ios/system.mjs build/ios/10B329 build/ios/gpu/flash.img --debug-kernel build/ios/gpu/kernel.macho --graphics
```
**S5 原版 EAGL 上下文，2026-11-05。** 在 backboardd 中，原版 EAGLSharegroup 会调用 libGFXShared 的 gfxCreateSharedState，继而进入 IMGSGX535GLDriver。10B329 的 OpenGLES 从 GLEngine 按名称载入 17 项 GLI 接口。客体库的 `--host-contexts <本地共享缓存>` 构建模式核对框架 UUID、数据区和这组函数地址，接入 ES2 共享组和上下文的创建与销毁。iOS 本身继续管理 EAGL 对象、每线程的当前上下文和分派表。每个上下文按宿主返回的实际长度保存自己的 GL 字符串。

用 `sh tools/ios/guest/build-gles.sh <目录> --check-host-contexts <dyld_shared_cache_armv7>` 构建带验收线程的客体库，然后依上面的流程创建数据卷、NAND 和调试内核，在 `system.mjs` 使用 `--contexts`。一次完整冷启动中，backboardd 和 SpringBoard 各自创建两个 EAGLContext，第一项创建的着色器可从第二项查询，切回第一项后成功删除。两个进程都读回了宿主渲染器名称、清除了当前上下文并释放对象。普通 `--host-contexts` 构建没有验收线程。该模式目前支持无窗口的 ES2 上下文；原生窗口、IOSurface 和最终上屏分开验收。 另一次完整冷启动在每个进程中增加第三个上下文，使用原版 Core Animation 的 `initWithAPI:properties:` 入口及加速、客户端保留释放、共享组三项属性。三个上下文之间的着色器共享、当前上下文切换、删除和释放均通过，随后原版 IOSurface 着色器绘图的全部像素也通过。

`node tests/ios/gl-scalar.mjs <dyld_shared_cache_armv7>` 逐一执行 76 个原版入口，比较传输包的长度及每个字节，并验证 8 位和 32 位返回值。代码生成器使用同一份宿主命令定义，处理混合字节宽度、软浮点调用约定和栈参数。两个删除入口在 10B329 中机器码相同，驱动根据宿主共享组中的对象类型选择着色器或程序删除命令。

**S5 IOSurface 标识与宿主缓冲。** 在原版 backboardd 的独立诊断运行中，IOSurfaceCreate 创建了 64×48 的 BGRA 表面，真实行跨度为 256 字节，IOSurfaceLookup 按内核 ID 成功取回同一表面。两条客体 GLES 连接用该 ID 调用 v86 私有命令后取得同一个宿主颜色缓冲句柄；释放第一条连接后，第二条仍能打开该缓冲。宿主协议测试另覆盖两个进程、几何不匹配、快照恢复、最后一次释放后复用同一内核 ID。此处验证了身份和引用寿命，纹理绑定和显示器提交需要像素级测试。

在本机 WebGPU 上，`tests/ios/iosurface-render.mjs` 通过两条独立进程连接验证了宿主像素共享。写方将同一 IOSurface 的颜色缓冲绑作渲染缓冲，另一方将其绑作纹理。64×48 全部像素经第二方帧缓冲读回并与绿底、红角图案比对。快照恢复后，写方把红角改黄，读方观察到更新；写方另行分配普通渲染缓冲再清蓝，读方仍保留黄角和绿底。此测试覆盖宿主渲染器，客体 CAEAGLLayer 的窗口提交仍需验证。

CPU 创建的 BGRA 表面也能作为 GL 输入。客体在 IOSurface 的只读锁内取得内核种子，按实际行跨度读取有效像素。非反转的原版纹理绑定保持 IOSurface 行顺序，QuartzCore 自行设置纹理坐标与投影。CAEAGLLayer 的窗口缓冲仍在复制时转换为 GL 窗口坐标。宿主保存最近导入的种子，同一种子的重复绑定保留 GPU 后续绘制的内容。测试逐像素核对了初次 CPU 导入、GPU 更新、重复导入、快照恢复和新种子的 CPU 更新。

构建客体库时用 `--check-host-surfaces <dyld_shared_cache_armv7>`，完整 NAND 冷启动时用 `system.mjs --surfaces` 验证系统进程。backboardd 和 SpringBoard 均通过原版 EAGL 调用把同一块内核 IOSurface 绑定到两个上下文，在渲染缓冲上绘图，从纹理读回，64×48 的所有像素均匹配。另用 `--check-host-window` 构建和 `system.mjs --windows` 区分两项窗口验收。测试窗口在两个真实内核表面之间轮换，发布回调逐像素验证了连续两帧及行方向。启用保留内容时，第二帧只改左下角，另一个缓冲完整保留首帧背景。在同一次完整冷启动中，backboardd 和 SpringBoard 均在原版 CAEAGLLayer 上执行 renderbufferStorage:fromDrawable: 和 presentRenderbuffer:，发布后核对了内核 IOSurface 全部 64×48 像素。在测试中引用已经领到的缓冲，这个版本的原生窗口每帧只允许领取一次。整屏合成及 SpringBoard 主屏仍待验证。

**S5 原版着色器绘图。** 使用 `--check-host-draw <本地共享缓存>` 构建客体库，用 `system.mjs ... --draw` 完整冷启动。backboardd 与 SpringBoard 均经过原版 glShaderSource 提交多段顶点着色器（含显式长度）和片段着色器，链接程序，查询属性位置，建立并更新顶点缓冲，再从非零偏移绘制三角形。两者在真实 IOSurface 上读回的 64×48 个像素全部为预期的洋红色。当前顶点指针支持绑定顶点缓冲的形式。

原版 backboardd 的冷启动已绘制 640×960 锁屏。重放同一组原版绘制确认了纹理及输出表面应保持原生行顺序。最初面板仍停在开机表面：QuartzCore 把这张表面作为延迟图层提交，原版显示驱动等待 SGX 的完成通知。客体库只对已经读回并解锁的代理表面取消这一等待，并继续调用原版显示接口。完整冷启动已观察到原版驱动切换 DART 表面并输出原版壁纸、日期、时间、状态栏及解锁滑块；方向正确。可用 `tests/ios/system.mjs --screen` 核对真实面板的彩色输出。主屏和解锁仍单独验收。

**S5 公开 GL 查询，2026-11-05。** 客体适配层已接通整数、浮点与布尔状态查询，以及着色器、程序状态、信息日志和着色器源码查询。传输按输出的元素数及字节宽度接收结果，压缩纹理格式等列表先查询实际长度，空的可选日志长度指针也会正确排空返回数据。`node tests/ios/gl-query.mjs <本地共享缓存>` 执行八个原版 ARM 入口，逐字节核对十个请求和对应应答，覆盖多值状态、动态长度、日志截断、空长度指针、非法负长度及输出两侧的保护值。

另一次完整 NAND 冷启动在 backboardd 和 SpringBoard 中均通过编译与链接状态、当前程序、四分量清除颜色、四字节颜色掩码及视口查询，随后原版三角形绘图的全部 64×48 像素仍匹配。普通构建也已生成，真实系统合成器的主屏提交继续单独验证。

**首次迁移与显示交换。** 正常异步读盘运行中，原版 DataMigrator 已记录地图和账户等迁移插件完成。在同一私有快照上改用同步读取底层文件字节、保留写入覆盖层的诊断对照中，DMPerformMigration 返回 1，DataMigrator 以 0 退出，SpringBoard 越过 BKSSystemAppCheckIn。随后 backboardd 的 SwapBegin、SwapSetLayer、SwapEnd 返回成功。首次交换提交了空图层，后续等待反复返回 0xe00002d5。内核逐帧确认了 CLCD 中断，但物理面板仍为启动画面。后续使用当前正式客体库的普通异步读盘冷启动，backboardd 已记录允许系统应用启动，随后启动 Setup。该长跑未再出现 NAND IOP 超时。Setup 的原版报告显示启动看门狗超时，全系统 CPU 时间约 36.8 秒，应用自身约 3.1 秒。SpringBoard 后续有一次崩溃重启，物理面板仍为两色启动画面。相同迁移后快照的正常时钟与十分之一速时钟对照都仍停在两色启动画面，慢时钟运行也出现 SpringBoard 重启，不能仅以降低时钟解决。主屏像素仍待验收。 在迁移后的一次性诊断客体中，原版内核的线程转储显示 Setup 主线程等待 SpringBoardServices；SpringBoard 主线程等待 FigPlayerRemoteCreate；mediaserverd 主线程停在 FigPlayerCMSession 的一次性初始化，另一个线程正在设置 CoreAudio 属性。正在核对音频设备初始化所需的硬件应答。

新增的双芯片回归覆盖了一颗芯片预读时另一颗仍在等待 DMA 的情况。模拟器为已启动的传输保留源页和列，恢复快照后仍能读出原来的字节，下一颗芯片的新页也能按序读取。

另在多次较长的启动运行中记录到 AppleIOPFMI 等待多页读取超时，向 IOP 发 NMI 后内核 panic。原配置也可复现。持续运行的验收需要覆盖这个故障。
同一迁移快照中，原版固件反复读取闪存序列器的完成位。等待宿主异步 I/O 时，当前实现缩短下一次协处理器执行片段，待数据就绪即恢复正常长度，保留固件自己的指令、完成中断与超时规则。每颗芯片最多保留一个 16 页的只读范围，写入、擦除和恢复会清除相应缓存。相邻页预读失败时单独重读所需页。设备回归及原版 iOS 在一次性 NAND 的 4 MiB 写入、关闭、重开和逐字节读回均通过。单独合并读取的长跑对照仍可触发超时。










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

**S6 按键硬件输入，2026-11-05。** N90 设备树的五个按键连接 GPIO 0–4。它们是低电平有效，未按下时现在返回高电平。此前全零初值会让原版驱动读到持续按下。GPIO 配置写入和外部电平分开，按下、松开各锁存一次中断，重复状态不产生新边沿。宿主可用 `emulator.ios_send_button("home", true)` 按下，再用 `false` 松开；另支持 `power`、`volume-up`、`volume-down`、`mute`。设备测试覆盖电平、中断确认、按住时恢复快照和旧快照默认状态。在按键修复后完成迁移的原版客体中，依次按下、松开五个按键，原版 GPIO 驱动确认了全部边沿；原版 AppleM68Buttons 随后向 IOHIDEventService 发出恰好十个事件。Home、电源、音量加减分别为消费页的 0x40、0x30、0xe9、0xea，静音为电话页的 0x2e，每项的按下值为 1、松开值为 0。此项确认系统输入分派，尚未观察到电源键引起背光变化，主屏操作效果另行验收。按键极性另与 [openiBoot 的 A4 按键实现](https://github.com/iDroid-Project/openiBoot/blob/master/plat-a4/buttons.c) 核对。

**S5 着色器数组与矩阵参数，2026-11-05。** 客体库现将 ES2 的 8 种浮点、整数向量数组及 2×2、3×3、4×4 矩阵展平成共享协议中的参数字节；同时转发 uniform 名称查询和 attribute 位置绑定。矩阵的单字节转置参数后紧跟未对齐的长度字段，不能按宿主 C 结构体的对齐传送。所有者原版 ARM 入口测试覆盖双元素数组、非对称矩阵、空数组、忽略的位置 -1、负数、空指针和长度溢出，与宿主独立编码器逐包比较通过。

完整 iOS 冷启动复测中，backboardd 和 SpringBoard 各自用原版入口绑定 attribute 位置、查找五个 uniform，并向顶点着色器设置三种矩阵、向片元着色器设置浮点和整数数组。两个进程的全部 64×48 输出像素均正确，原有上下文共享、IOSurface 和挂载验收同时通过。该项是绘图适配验收，真实系统主屏仍待验收。可用 `node tests/ios/gl-uniform.mjs <原版共享缓存>` 复测参数 ABI。

**S7 音频控制的前置接口，2026-11-05。** 迁移后的原版内核等待栈显示，音频编解码器的启动停在取得 Mikey 接口；I2C 记录同时显示地址 0x39 的复位请求返回缺少从设备。现在在第一条 I2C 总线上提供 CD3282 控制寄存器、软件复位和带自动递增地址的读写，耳机和线控保持未接入。寄存器及未读完的控制器 FIFO 随快照保存，旧快照将新接口恢复到复位状态。另一个 I2C 总线不响应这个地址。

一次原版 10B329 冷启动已连续完成复位、配置写入和版本读取，三个事务均获完成状态，先前的 Mikey 复位错误消失。设备回归覆盖复位、配置、只读检测位、事务中恢复和旧快照兼容，构建检查通过。此项仅验收控制接口；后续编解码器识别、媒体服务正常就绪及 PCM 播放仍待完成。

**S7 编解码器与 I2S 控制寄存器。** Mikey 接口可用后，原版 CS42L61 驱动开始读取电源寄存器，继而访问 I2S；未提供 I2S 窗口时，原版内核在该处产生数据访问异常。现为地址 0x4a 提供独立的 CS42L61 控制寄存器及只读标识，为三个 I2S 控制器提供独立配置窗口和停钟完成位。新设备追加到快照序列末尾，旧快照按复位状态恢复。

原版冷启动中，CS42L61 已连续完成电源、静音、增益及路由配置读写，Mikey 完成中断掩码和未插入耳机的检测；I2S0、I2S2 均执行原版停钟序列并读到完成应答。此后两个 NAND 卷通过检查并挂载，未再发生上述 I2S 访问异常。设备回归、构建检查以及原版启动显存和快照回归均通过。尚未接入 I2S 的 PCM DMA，此处不构成播放验收；正在继续观察媒体服务及界面启动。 本地可运行 `node tests/ios/audio.mjs <原版固件目录> <NAND 镜像>`，测试让原版驱动执行并逐项核对 Mikey 复位、配置、无耳机检测、CS42L61 控制事务和 I2S 停钟应答，不需要图形渲染器。该原版内核回归已通过。

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
