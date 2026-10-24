# AArch32 与 arm32 实施计划

状态：第一部分实施中（见“进展”），第二部分未开始。2026-10-23 初稿，基于 `c5debe9a`；同日按所有者的要求加入第二部分
`cpu_type: "arm32"`。规模：S 为几天，M 约 1–2 周，L 约 3–4 周，XL 超过一个月（与
[ARM64 virt 与 Android 16 计划](arm64-virt-android16-plan.md) 相同）。

本计划为 ARM 核心增加 AArch32（A32 与 T32 指令集、VFP 与 Advanced SIMD），分两部分：

- **第一部分（Q0–Q7）**：64 位内核下运行 32 位进程，即 Linux arm64 的 compat 与 Android 的
  `armeabi-v7a`，作为 arm64 的 CPU profile `v3`。现在的 CPU 只有 AArch64（[aarch64.md](aarch64.md)
  “CPU profile”一节把 AArch32 列为不公布），只含 32 位原生库的 APK 安装失败、Linux 的 armhf 程序得到
  ENOEXEC，都是 ARM64 计划的预期（arm64-virt-android16-plan.md 84–86）。
- **第二部分（R0–R8）**：新的 `cpu_type: "arm32"`，运行 32 位内核（AArch32 的 PL1，即 ARMv7 风格的
  系统）：32 位 Linux，以及 Android 模拟器的官方 32 位镜像。指令集的实现与第一部分共用。

## 进展

2026-10-24，分支 `android`：

- **Q0.2、Q1.1–Q1.4（`fd40ea3a`）**：PSTATE 的 nRW、T、ITSTATE、GE、Q、E，ERET 到 AArch32 User，0x600 向量，
  AArch32 的 ESR（16 位 T32 的 IL=0、SVC32、WFx、BKPT、CP15 陷入），取指按执行状态。裸机框架
  `tests/a64/aarch32_el0.mjs`（`tests/a64/aarch32/el0.c`、`el0_run.S`，`A64_AARCH32_CASES=q1|q3|q4`）。
- **Q0.3、Q2（`126a0376`）、Q3（`2cf6dc99`）**：A32 与 T32 的整数指令、IT 块。单指令 oracle
  `tests/a64/aarch32_oracle.mjs`（A32 与 T32 的各编码类，`A64_AARCH32_SEED`、`A64_AARCH32_COUNT`、`A64_AARCH32_ONLY`）。
- **Q4.1、Q4.4（`cc014fec`）**：`a32_fp.rs`，VFPv4（ARMv8 的形式，没有短向量与半精度运算），FPSCR 映射到
  FPSR/FPCR（Len、Stride 读 0，同 FPCR）；CPACR_EL1.FPEN 的陷入（EC 0x07）。
- **Q4.2、Q4.3（`6d2e6779`）**：`a32_simd.rs`，Advanced SIMD 的全部数据处理组与 VLDn/VSTn，AES、SHA-1、SHA-256、
  VMULL.P64；浮点用标准 FPSCR 值。
- **Q0.4（`14cd0ec7`）**：v3 的 AArch32 ID 寄存器：参考机的值按“只有 EL0 的 AArch32”调整（ID_PFR1.ProgMod、
  ID_ISAR1.Endian、ID_ISAR4.SMC 为 0，同 Cortex-A76）；`tests/platform/a64-profile.json` 的 `v3` 一项，
  `tools/cpu_contract.mjs --a64-v86` 检查。
- **Q1.5（`8925f5d0`）**：AArch32 EL0 下的单步（LDREX 的 EX、SVC 结束单步）、断点（BAS）、观察点；顺带修正 MMU
  关闭时观察点不触发（A64 同样）。`A64_AARCH32_DRIVER=debug A64_AARCH32_CASES=qdebug`。
- **Q5.1、Q5.3、Q1.6（`9f2e9e91`）**：`A64_PROFILE=v3 A64_WORKLOAD=aarch32 node tests/a64/linux_boot.mjs`：32 位探针
  `tests/a64/linux_probe32.c`（A32 与 T32 两个版本）与 Alpine armv7 的程序（`tools/alpine_repo.mjs --arch armv7 --set aarch32`）
  的输出与参考机相同：1 核、4 核且中途保存恢复快照、4 核 vCPU worker。快照不需要新字段：AArch32 的状态都在原有的
  PSTATE（SPSR 格式）、X、V、FPSR/FPCR 里，profile 已在快照身份里。

门禁结果：oracle 全部编码类（69 类）、VFP 6720 例（种子 2–5）、Advanced SIMD 21000 例（种子 2、3、4、5、7–10）与
QEMU 0 差异；q1、q3、q4、qdebug 的退出与 QEMU 相同；v2 的 fp、simd、system、integer、crypto oracle 不变。

偏离 QEMU 之处（都是 UNPREDICTABLE 或 QEMU 自身的问题，oracle 不生成）：v86 对 UNPREDICTABLE 的编码 UNDEF
（寄存器列表越过 D31、以 PC 为基址、同一寄存器的 VTRN/VUZP/VZIP、PC 或 SP 作核心寄存器的 VMOV、负的定点小数位数）；
FPSCR.Len、Stride 读 0（QEMU 保存它们，非 0 时 VFP 运算 UNDEF）；VLDR.16 无 FEAT_FP16 时 UNDEF（QEMU 执行）；
VLDM/VSTM 中途出错时什么都不写（QEMU 写了前面的部分）；EL0 的 CP14 访问 UNDEF（未实现调试通信通道）。

尚未完成：Q5.2（带 32 位第二架构的 Android）、Q6（页层编译 A32 与 T32，现在 32 位代码只走解释器，单核约 14 MIPS）、
Q7（界面与配置、文档）。

## 结论

1. **AArch32 放进 arm64，不新增 `cpu_type`。** 这里要的是 AArch32 EL0 跑在 AArch64 EL1 之下：同一个
   内核、同一台 virt 机器，内核按进程决定执行状态（ERET 到 PSTATE.nRW=1 的用户态），与 x86-64 的
   兼容模式是同一种关系。x86 那边，兼容模式也不是单独的 `cpu_type`，而是同一个核心的执行模式
   （`ExecutionMode::Compatibility32`，[src/rust/x64/state.rs](../src/rust/x64/state.rs) 20–80）；`x86` 与 `x86_64` 两个选项的区别
   只是 CPUID 与 MSR 的能力集，核心是同一个 `v86.wasm`。ARM64 计划也早已定下：将来的 AArch32
   （EL0 compat）放在 `v86-arm64.wasm`，与 Linux 的 arm64 架构包含 compat 的做法一致（arm64-virt-android16-plan.md 44、
   324–326；jit-unification-plan.md 169、315）。
2. **对外是新的 CPU profile，不是开关。** ARM64 计划规定 profile 是机器状态：复制到 vCPU worker、写进
   快照，任何改动都升版本号，AArch32 EL0 另立 profile（同上 427–434）。新增 `a64_profile: "v3"`：
   v2 的全部特性加 AArch32 EL0（`ID_AA64PFR0_EL1.EL0 = 0b0010`，AArch32 的 ID 寄存器按实现的功能填写）。
   v1、v1.1、v2 的 ID 寄存器不变，旧快照照旧恢复。默认 profile 在 Q5 验收后再决定是否改成 v3。
3. **32 位内核是单独的选项 `cpu_type: "arm32"`（第二部分）。** AArch32 跑在 EL1，也就是 32 位内核
   （ARMv7 的 Linux、只有 32 位的旧 Android、32 位的 Raspberry Pi OS），是另一台机器：短描述符或 LPAE
   页表、带模式切换和分组寄存器的异常模型、CP15 系统寄存器、zImage 与 32 位设备树的引导。这正对应
   x86 与 x86-64 的关系：两个 `cpu_type`，同一个核心文件（`x86` 与 `x86_64` 都用 `v86.wasm`）。ARM 这边
   `arm32` 与 `arm64` 都用 `v86-arm64.wasm`（ARM 一族一个核心，见 jit-unification-plan.md 169），按
   `cpu_type` 复位到不同的执行状态与 ID 寄存器。现在 `"arm"` 与 `"aarch64"` 这两个名字被
   [tests/api/arm64-options.js](../tests/api/arm64-options.js) 51–53 拒绝；新名字取 `"arm32"`，与 `"arm64"` 对称。
4. **官方 32 位 Android 8、9 不存在。** 2026-10-23 核对 Google 的 SDK 镜像仓库（`sys-img2-1.xml` 的
   default、google_apis、google_apis_playstore）：`armeabi-v7a` 的官方模拟器镜像到 API 25（Android 7.1.1，
   google_apis `armeabi-v7a-25_r18.zip`，953 MB）为止；API 26–28（Android 8.0、8.1、9）只有 `arm64-v8a`。
   所以第二部分的 Android 验收用**官方 Android 7.1.1 的 32 位镜像**；Android 8、9 的官方 arm64 镜像带 32 位
   用户态，用来验收第一部分（64 位内核下的 32 位进程）。32 位的 Android 8、9 只能从 AOSP 源码自己构建，
   不是官方二进制，不在本计划内（所有者 2026-10-23 决定）。
5. **先确认需求再动手。** Cuttlefish 的 `aosp_cf_arm64_only_phone` 是纯 64 位（P10.2 特意选了它，
   arm64-virt-android16-plan.md 1027、1329），不需要 AArch32。需要它的是：带 32 位第二架构的 Android 系统
   （`TARGET_2ND_ARCH := arm`，例如非 arm64-only 的 Cuttlefish 产品，以及 `ro.product.cpu.abilist32` 不为空
   的 GSI）、只有 `armeabi-v7a` 原生库的应用，以及 Linux 上的 armhf 程序。Q0.1 先查要用的 GSI。

## 目标与非目标

目标：

- AArch64 EL1（Linux、Android 的内核）之下的 AArch32 EL0：A32、T32（含 IT 块）、VFPv4、Advanced SIMD、
  AArch32 的 AES、SHA1、SHA2、PMULL、CRC32，独占与获取释放访问，EL0 可用的 CP15 与通用定时器访问。
- 与 AArch64 之间的异常与返回：0x600 的低异常级 AArch32 向量、AArch32 的 ESR 类别、16 位 T32 指令的
  IL=0、SPSR 的 T、IT、GE、Q、E 字段、寄存器映射。
- 与 QEMU（`cortex-a35`，支持 AArch32 EL0）逐条指令 0 差异；Linux compat 与 Android 32 位进程的整机验收。
- 解释器先行；页层（page tier）编译 A32/T32 是单独的阶段。

非目标：

- EL2、EL3（Hyp、Monitor）与虚拟化扩展；32 位内核（AArch32 EL1）属于第二部分。
- Jazelle、ThumbEE、大端数据（`SETEND` 与 E 位按 SCTLR_EL1.SED 处理为 UNDEF，内核可以模拟）、
  ARMv8 已移除的 SWP/SWPB（UNDEF，Linux 的 `armv8_deprecated` 可以模拟）。
- VFP 的短向量（FPSCR.Len/Stride 非零时的行为按 ARMv8 处理为 UNDEF 或忽略，见 Q4）。
- 实机对照：开发机 M1 Pro 不支持 AArch32，只有 QEMU 作参考。

## 现状与要改的地方

| 位置 | 现状 | 本计划 |
| --- | --- | --- |
| `cpu.rs` PSTATE（9–23、122–173） | u32 按 SPSR_EL1 布局，`PSTATE_SAVED = 0x1F｜DAIF｜IL｜SS｜PAN`；M[4] 存着但无人使用；没有 T、IT、GE、Q、E | 补 nRW、T、ITSTATE、GE、Q、E；`current_spsr` 与保存掩码 |
| `sysregs.rs` MSR SPSR_EL1（234–238） | 掩码只留 31:28、22:21、9:0：丢了 IL（注释说保留），也丢了 Q、IT、GE | 改掩码；IL 的遗漏是现有缺陷，Q1 一起修 |
| `cpu.rs` 异常入口（308–338） | 低异常级向量固定 0x400 | 来自 AArch32 EL0 用 0x600 |
| `cpu.rs` ERET（359–382） | 只接受 M∈{EL0t, EL1t, EL1h}，M[4]=1 视为非法返回 | 接受 AArch32 User（0b10000），设 T 与 ITSTATE，PC 按状态对齐 |
| `cpu.rs` 综合征（220–284） | 只有 A64 的类别，IL 恒为 1 | AArch32 的 EC（MCR/MRC CP15 0x03、MCRR/MRRC 0x04、CP14 0x05/0x06/0x0C、SVC 0x11、浮点 0x07 的 AArch32 形式等）；16 位 T32 的 IL=0 |
| `cpu.rs` `take_sync`（341–355） | SVC 的返回地址 PC+4 | T32 16 位 SVC 为 PC+2 |
| `memory.rs` 取指（118–130）、`execute.rs`（1257–1262） | 一次取对齐的 u32 | T32 按半字对齐；32 位 T32 指令可跨页（两次取半字） |
| `execute.rs` 解码缓存（22–35） | 只以指令字为键 | 键加上执行状态（A64、A32、T32） |
| `sysregs.rs` ID 空间（59–77） | AArch32 ID 寄存器（CRm 1–3、MVFRx）读 0 | 按 v3 填写 |
| `fp.rs`（19、36–51） | FPCR 可写位、CPACR 检查 | FPSCR 读写映射到 FPCR/FPSR；AArch32 的浮点陷入 |
| 页层 `jit/pages.rs`（72–85） | 函数键的模式位在 28–29，30–31 空着 | A32、T32 各占一个模式位（Q6） |
| 状态块 `state.rs`、`gen/state_layout.js` 169–245 | 4096 字节里约 2.7 KB 空闲 | AArch32 的寄存器映射在 X、V 上，只需少量新字段；快照升版本 |
| profile（`src/virt/platform.js` 10–21、`src/arm/cpu.js` 204–209、1056–1095） | v1、v1.1、v2 | 新增 v3；快照身份含 profile |
| 测试里“没有 AArch32”的断言 | `tests/a64/linux_probe.c` 693、`tests/a64/linux_boot.mjs` 487、511、`tests/platform/a64-profile.json` 82–243 与 707–709 | v3 下改为“ran”与真实的 ID 值；v2 下保持原断言 |

寄存器映射照架构规定：R0–R12 是 X0–X12 的低 32 位，User 模式的 SP、LR 是 X13、X14；从 AArch32 进入
AArch64 时这些 X 的高 32 位按架构处理。浮点寄存器 Qn 即 Vn（n < 16），D2n、D2n+1 是 Vn 的低、高 64 位，
S4n..S4n+3 是 Vn 的四个 32 位。FPSCR 是 FPCR 与 FPSR 的合并视图。这样 AArch32 几乎不需要新的寄存器
存储，SIMD 的实现也能复用 `simd.rs`、`simd_fp.rs`、`crypto.rs` 的逐元素运算。

## 跨阶段规则

1. 每个指令阶段先写编码覆盖清单（同 `tests/a64/encodings.json`）：每个编码类标为已实现、profile 外
   （UNDEF）或提示（NOP），再接 oracle。
2. 正确性门禁（C）：与 QEMU 0 差异，覆盖寄存器、标志（NZCV、GE、Q）、内存、异常（ESR、ELR、SPSR、
   FAR、向量）。解码另用 llvm-mc（`--triple=armv8a`、`thumbv8a`）对照。
3. v2 及更早的 profile 行为逐字节不变：`make core-split-check` 证明 `v86.wasm` 不受影响，ARM64 的全部
   测试在 v2 下照旧通过，再加 v3 下的同一组。
4. 只公布实现了的功能：ID 寄存器与 COMPAT_HWCAP 跟实现同步更新，没实现的编码是 UNDEF 而不是
   “大概能跑”。

## 第一部分：AArch32 EL0（profile v3）

### Q0 需求确认、参考与 profile 定义

目标：确认要用的系统镜像确实需要 AArch32；建立对照手段；定下 v3 的 ID 值。

| ID | 任务 | 关键位置 | 门禁/开关 | 规模 |
| --- | --- | --- | --- | --- |
| Q0.1 | 检查要运行的 GSI 与应用：`ro.product.cpu.abilist32`、`ro.zygote`、`/system/lib`、`/system/bin/app_process32`；记录结论（为空则本计划对该 GSI 不是前提） | GSI 的 `system.img` | 结论入本文 | S |
| Q0.2 | 裸机对照框架：AArch64 EL1 的运行时 ERET 到 AArch32 EL0 代码，SVC 与异常回到 0x600 向量；同一程序在 QEMU 与 v86 上跑 | `tests/a64/guest_runner.mjs`、`tests/a64/baremetal/`（start.S 已有 0x600 组） | 框架自测 | M |
| Q0.3 | 单指令 oracle（A32、T32、VFP、NEON）：随机寄存器与内存，逐条与 QEMU 比较；llvm-mc 解码对照 | 新 `tests/a64/aarch32_oracle.mjs`、`tests/a64/oracle/decode.mjs` | 框架自测 | M |
| Q0.4 | v3 的 ID 值：`ID_AA64PFR0_EL1.EL0 = 2`；ID_PFR0/1、ID_ISAR0–6、ID_MMFR0–4、MVFR0–2 取 cortex-a35 与实现范围的交集；COMPAT_HWCAP 预期（half、thumb、fastmult、vfp、edsp、neon、vfpv3、tls、vfpv4、idiva、idivt、lpae、evtstrm 与 aes、pmull、sha1、sha2、crc32） | `tests/platform/a64-profile.json`、`src/virt/platform.js` | C：`tools/cpu_contract.mjs --a64-v86` 与参考一致（允许差异只剩明确列出的） | S |

Q0.1 的结论（2026-10-24）：官方 GSI `aosp_arm64-exp-BP4A.251205.006` 与 `CP3A.260905.010` 的 `build.prop` 都有
`ro.system.product.cpu.abilist32=armeabi-v7a,armeabi`，但它们放在 Cuttlefish 的 arm64-only 设备上时，vendor 的
`ro.zygote` 是 `zygote64`：init 报 “start zygote_secondary … service zygote_secondary not found”，只有 64 位
zygote，开机不受影响（QEMU 上 22–35 s 到 `boot_completed`，Apple 的 CPU 本来就没有 AArch32 EL0）。所以对这两个
GSI 与这台设备，本计划**不是开机的前提**；32 位应用要同时有 AArch32 与带 32 位 zygote 的设备（`zygote64_32`，
例如 Cuttlefish 的 `aosp_cf_arm64_phone`，或 R6 的模拟器镜像）。

### Q1 执行状态、异常与返回

目标：AArch64 EL1 与 AArch32 EL0 之间可以往返，A32 指令先只有 NOP、SVC、B。

| ID | 任务 | 关键位置 | 门禁/开关 | 规模 |
| --- | --- | --- | --- | --- |
| Q1.1 | PSTATE 的 nRW、T、ITSTATE、GE、Q、E；SPSR 的保存与写入掩码（含修掉 MSR SPSR_EL1 丢 IL 的缺陷） | `cpu.rs` 9–23、173；`sysregs.rs` 234–238 | C：system_oracle 扩展 | M |
| Q1.2 | ERET 到 AArch32 User；PC 按 T 位对齐；非法返回的规则 | `cpu.rs` 359–382 | C | S |
| Q1.3 | 0x600 向量；AArch32 的 ESR 类别与 ISS；16 位 T32 的 IL=0；T32 SVC 的返回地址 | `cpu.rs` 178–355 | C | M |
| Q1.4 | 取指按执行状态：A32 字对齐，T32 半字与跨页；解码缓存键加执行状态；数据中止与指令中止在 AArch32 下的 FAR | `memory.rs` 118–130；`execute.rs` 22–35、1257–1262 | C | M |
| Q1.5 | 中断、单步（MDSCR.SS）、断点与观察点在 AArch32 EL0 下的行为 | `smp.rs` 266–280；`debug.rs` | C | M |
| Q1.6 | 状态块与快照：新字段、升版本；v3 profile 的接线（`a64_profile: "v3"`，worker 与快照身份） | `gen/state_layout.js`、`src/arm/cpu.js` 204–209、1056–1095、`src/virt/platform.js` | 快照往返 | S |

验收（Q1）：裸机程序在 EL0 AArch32 执行 NOP、B、SVC，往返 EL1 的全部寄存器与 ESR/ELR/SPSR 与 QEMU 一致；
v2 的全部 ARM64 测试不变。

### Q2 A32 整数指令

| ID | 任务 | 关键位置 | 门禁/开关 | 规模 |
| --- | --- | --- | --- | --- |
| Q2.1 | 解码器与覆盖清单：条件执行、数据处理（移位操作数与进位）、乘法与长乘、SDIV/UDIV、饱和与 Q 标志、并行加减与 GE、打包与扩展、位操作（CLZ、RBIT、REV*、BFI、UBFX、SBFX） | 新 `src/rust/aarch64/a32_decode.rs`、`a32_execute.rs` | C：oracle 0 差异 | L |
| Q2.2 | 加载与存储：全部寻址模式、LDM/STM、LDRD/STRD、LDREX/STREX 家族与 CLREX、LDA/STL 与获取释放独占；对齐检查（SCTLR.A） | 同上；复用 `memory.rs`、独占监视器 | C；litmus 的 AArch32 形式 | L |
| Q2.3 | 分支与交互：B、BL、BX、BLX（寄存器与立即数）、写 PC 的加载与 POP 切换 T 位 | 同上 | C | S |
| Q2.4 | 系统类：MRC/MCR/MRRC 的 CP15 中 EL0 可访问的（TPIDRURW、TPIDRURO、CNTFRQ、CNTVCT、CNTVCTSS 等），其余按 EC 0x03/0x04 陷入；DMB/DSB/ISB 与 CP15 屏障（按 SCTLR.CP15BEN）；YIELD、WFE、WFI（按 SCTLR.nTWE/nTWI）；BKPT；UDF；SETEND 与 SWP 为 UNDEF | 同上；`sysregs.rs` | C | M |

### Q3 T32（Thumb-2）

| ID | 任务 | 关键位置 | 门禁/开关 | 规模 |
| --- | --- | --- | --- | --- |
| Q3.1 | 16 位编码全集与 32 位编码全集的解码与覆盖清单；与 A32 共用执行函数，解码层把 T32 映射到同一组操作 | 新 `src/rust/aarch64/t32_decode.rs` | C：llvm-mc 与 oracle 0 差异 | L |
| Q3.2 | IT 块：ITSTATE 的推进、块内条件、块内不允许的指令、异常与返回时 ITSTATE 进出 SPSR | `a32_execute.rs`、`cpu.rs` | C | M |
| Q3.3 | T32 的取指、跨页的 32 位指令、对齐与 PC 读取值（PC+4）、CBZ/CBNZ、TBB/TBH | `memory.rs`、`execute.rs` | C | M |

### Q4 VFP 与 Advanced SIMD

| ID | 任务 | 关键位置 | 门禁/开关 | 规模 |
| --- | --- | --- | --- | --- |
| Q4.1 | VFPv4：算术、乘加与融合乘加、比较（VCMP、VCMPE 与 FPSCR 标志、VMRS APSR_nzcv）、转换、VMOV 各形式、VLDR/VSTR/VLDM/VSTM/VPUSH/VPOP；FPSCR 映射到 FPCR/FPSR；短向量（Len/Stride）按 ARMv8 处理 | 新 `a32_fp.rs`；复用 `fp.rs` 的 SoftFloat ARM 特化 | C：fp_oracle 风格，覆盖全部 RMode、FZ、DN 组合 | L |
| Q4.2 | Advanced SIMD 整数、浮点、置换与加载存储（VLD1–4、VST1–4 的各种形式）；按元素复用 `simd.rs`、`simd_fp.rs` | 新 `a32_simd.rs` | C：vector oracle | L |
| Q4.3 | AArch32 的 AES、SHA1、SHA256、VMULL.P64 与 CRC32 | 复用 `crypto.rs` | C | S |
| Q4.4 | CPACR 与 FPEXC 在 AArch32 EL0 下的陷入与 EC | `fp.rs` 36–51 | C | S |

### Q5 Linux 与 Android 的 32 位进程

| ID | 任务 | 关键位置 | 门禁/开关 | 规模 |
| --- | --- | --- | --- | --- |
| Q5.1 | Linux：Alpine 的 armhf 或 armv7 程序在 arm64 内核（COMPAT=y）下运行；`linux_probe` 的 `aarch32()` 在 v3 下为 “ran”；compat 系统调用、信号与 32 位的 vDSO | `tests/a64/linux_probe.c` 548–571、692–693；`tests/a64/linux_boot.mjs` 484–511 | C：与 QEMU 同一组探针结果 | M |
| Q5.2 | Android：带 32 位第二架构的系统启动到 `sys.boot_completed`，`zygote_secondary` 存活；只含 `armeabi-v7a` 库的 APK 安装并启动。系统取 Q0.1 选定的 GSI（Cuttlefish vendor），或官方 Android 8.0、8.1、9 的 `arm64-v8a` 模拟器镜像（API 26–28，需要第二部分 R6 的 ranchu 机器） | `tools/a64_android.mjs`、`tests/a64/android_boot.mjs`、`android_scenario.mjs` | 场景通过 | M |
| Q5.3 | 32 位与 64 位进程混跑的多核与快照：vCPU worker、保存恢复时 AArch32 进程的状态 | `a64-parallel-guest-tests`、`a64-lifecycle-guest-tests` | 场景通过 | S |

验收（Q5）：v3 下 ARM64 的全部测试、Q0–Q4 的 oracle 与 Q5 的场景通过；v2 下所有测试不变。

### Q6 页层编译 A32 与 T32

目标：32 位进程的热点代码进入页函数，避免全靠解释器。

| ID | 任务 | 关键位置 | 门禁/开关 | 规模 |
| --- | --- | --- | --- | --- |
| Q6.1 | 函数键：A32、T32 各占 30–31 位中的一个模式位；块的发现与 T32 的半字入口 | `jit/pages.rs` 72–85、`jit/pagegen.rs` 529 | 开关 `a64_page_aarch32`，默认 0 | M |
| Q6.2 | 整数模板：数据处理、条件执行（转成分支或选择）、IT 块、加载存储与访问缓存；其余单步到解释器 | `jit/pagegen.rs` | C：page_fuzz 的 AArch32 程序与解释器一致 | L |
| Q6.3 | VFP 与 NEON 模板（复用 `jit/pagegen/neon.rs` 的 v128 模板） | `jit/pagegen/neon.rs` | C | L |
| Q6.4 | 性能：同一份 C 代码编成 armv7 与 aarch64 的基准对比（参考 `tests/bench` 的同源做法）；默认打开的条件 | 新基准 | E：32 位不低于 64 位的一半 | M |

### Q7 界面与配置

| ID | 任务 | 关键位置 | 门禁/开关 | 规模 |
| --- | --- | --- | --- | --- |
| Q7.1 | VM 管理器的处理器面板：arm64 下的 profile 选择（“ARMv8.0（64 位）”与“ARMv8.0 加 32 位应用”），预设按系统选；配置校验与迁移 | `src/app/ui/panels/system.js`、`src/app/vm_config.js`、`src/app/guest_presets.js` | app-tests | S |
| Q7.2 | `a64_profile` 写进公开选项与 `v86.d.ts`（现在只是内部选项，arm64-virt-android16-plan.md 1865） | `v86.d.ts`、`src/machine_options.js` | api 测试 | S |
| Q7.3 | 文档：[aarch64.md](aarch64.md) 的 CPU profile 一节、已知缺陷与测试表 | 文档 | — | S |

## 第二部分：`cpu_type: "arm32"`（32 位内核）

目标：v64 运行 32 位 ARM 内核：32 位 Linux 到登录，官方 Android 7.1.1 的 32 位模拟器镜像到桌面。
A32、T32、VFP、NEON 的指令实现来自第一部分（Q2–Q4）；这里补 PL1 的系统层、MMU、32 位平台与
Android 模拟器的 ranchu 机器。

### 设计

- **CPU**：复位到 AArch32 的 SVC 模式。profile `arm32-v1`：ARMv8-A 的 AArch32 状态，只有 PL0 与 PL1
  （无 Hyp、无 Monitor、无安全扩展），LPAE、通用定时器（CP15）、VFPv4、Advanced SIMD、AArch32 的加密
  与 CRC32；ID 寄存器（MIDR、ID_PFR0/1、ID_MMFR0–4、ID_ISAR0–6、MVFR0–2）取与 QEMU `cortex-a15`
  兼容的值（Android 模拟器 32 位镜像的参考 CPU）再按实现裁剪，Q0.4 的 AArch32 ID 值与此共用一套来源。
- **状态**：AArch32 PL1 的分组寄存器（FIQ 的 R8–R12，各模式的 SP、LR、SPSR）按 ARMv8 的映射放在
  AArch64 的 X 寄存器与 SPSR 存储里（架构规定的 AArch32 与 AArch64 寄存器对应关系），CPSR 用第一部分的
  PSTATE 字段，另加模式位与 A、I、F；CP15 寄存器多数是 AArch64 系统寄存器的 32 位视图（SCTLR、TTBR0/1、
  TTBCR、DACR、DFSR/IFSR、DFAR/IFAR、PRRR/NMRR 或 MAIR0/1、CONTEXTIDR、VBAR、TPIDR*），存储共用。
- **核心文件**：`v86-arm64.wasm`，与 x86、x86-64 共用 `v86.wasm` 的做法相同；`check_core()`（
  `src/browser/starter.js` 155–166）与 `src/main.js` 32 的选择按 ISA 族而不是按 64 位判断。
- **机器**：`machine_type: "virt"` 在 `arm32` 下是 32 位的 virt：内存与外设在 4 GiB 以下，GICv2（gic.rs
  现为 GICv3，加 v2 的分发器与 CPU 接口 MMIO；Android 的 32 位 ranchu 内核按 cortex-a15 期望 GICv2），
  CP15 的通用定时器，PSCI 0.2 的 SMC32/HVC32 函数号，PL011、PL031、virtio-mmio 与 virtio-pci。另设
  `machine_type: "ranchu"`：Android 模拟器的板子（R6），32 位与 64 位共用。
- **引导**：32 位 Linux 的 zImage 协议（MMU 关、SVC 模式、r0=0、r1=~0、r2=DTB 地址，内核在内存起点
  加 0x8000）；initrd 与命令行经 DTB 的 chosen 节点。

### R0 目标与参考

| ID | 任务 | 关键位置 | 门禁/开关 | 规模 |
| --- | --- | --- | --- | --- |
| R0.1 | 固定验收镜像：官方 Android 7.1.1 `armeabi-v7a-25_r18.zip`（google_apis；内含 `kernel-ranchu`、`kernel-qemu`、`ramdisk.img`、2 GiB 的 `system.img`、`userdata.img`、`build.prop`，2026-10-23 读 zip 目录核对）；32 位 Linux 取 Debian armhf 或 Alpine armv7 的 netboot 内核与 initramfs；记录 hash | `tests/a64/` 下新目录、`tools/` 下载脚本 | 镜像与 hash 入库（不入 git 的大文件按现有做法放 `build/`） | S |
| R0.2 | 参考：本地构建的 QEMU 9.2.0（`qemu-system-aarch64` 可用 `-M virt -cpu cortex-a15` 跑 32 位客体）跑 32 位 Linux；Android 模拟器（Android Studio 的 emulator，TCG）跑 7.1.1 的 32 位镜像，记录内核命令行、DTB（从客体 `/proc/device-tree` 导出）与 ranchu 的设备清单 | `tools/a64_qemu/`、新的参考脚本 | 两个参考都能到登录或桌面 | M |
| R0.3 | ranchu 的设备与属性清单：读 Android 模拟器 QEMU 的 ranchu 板定义与镜像 ramdisk 里的 `init.ranchu.rc`、`fstab.ranchu`、`ueventd.ranchu.rc`，列出 32 位与 64 位镜像各自真正需要的 goldfish 设备 | 文档 | 清单入本文 | S |

R0 的进展（2026-10-24）：Alpine 3.24 armv7 的 netboot 内核与 initramfs（`vmlinuz-lts` 6.18.58，
`initramfs-lts`、`modloop-lts`，`build/a32-linux/`）：多平台内核，`CONFIG_ARCH_VIRT`、PSCI、VFPv3、内核态 NEON，
GICv2 与 GICv3 都编进内核，没有 LPAE（短描述符页表）。参考机 `qemu-system-aarch64 -M virt -cpu cortex-a15`
引导到 Alpine 的 init（没有启动介质时停在那里）；`-M virt,gic-version=3` 也一样（GICv3 的 AArch32 CP15 接口）。
所以 32 位 virt 沿用现有的 GICv3（加它的 CP15 访问），不另做 GICv2；ranchu 是否需要 GICv2 由 R0.3 决定。
官方 Android 7.1.1 的 `armeabi-v7a-25_r18.zip` 下载到 `build/a32-android/`。

### R1 `cpu_type: "arm32"` 接线与 profile

| ID | 任务 | 关键位置 | 门禁/开关 | 规模 |
| --- | --- | --- | --- | --- |
| R1.1 | `CPU_TYPES` 增加 `"arm32"`；校验、默认机器（virt）、跨族选项的拒绝；`v86.d.ts`；`tests/api/arm64-options.js` 改为接受 `"arm32"`，仍拒绝 `"arm"` 与 `"aarch64"` | `src/machine_options.js` 9、62–141；`v86.d.ts` 962–973 | api 测试 | S |
| R1.2 | 核心选择：`arm32` 加载 `v86-arm64.wasm` 系列（含 parallel、debug、fallback）；A64CPU 按 `cpu_type` 复位 | `src/browser/starter.js` 155–166、326–339；`src/main.js` 32；`src/arm/cpu.js` | `tests/a64/core_loader.mjs` 扩展 | S |
| R1.3 | profile `arm32-v1` 的 ID 值与特性掩码；快照身份含 cpu_type 与 profile | `src/virt/platform.js` 10–21；`src/arm/cpu.js` 1056–1095；`tests/platform/` 下新的 arm32 profile | C：`tools/cpu_contract.mjs` 的 32 位版本与参考一致 | M |

### R2 PL1 的系统层

| ID | 任务 | 关键位置 | 门禁/开关 | 规模 |
| --- | --- | --- | --- | --- |
| R2.1 | 模式与分组寄存器：USR、FIQ、IRQ、SVC、ABT、UND、SYS；CPSR 与各模式的 SPSR；模式切换的合法性 | `cpu.rs`、新 `a32_system.rs` | C：裸机对照 | M |
| R2.2 | 异常模型：向量（VBAR、SCTLR.V 的高向量）、各异常的入口模式与返回地址偏移、IRQ 与 FIQ、数据与预取中止（DFSR/IFSR 的短格式与长格式状态码、DFAR/IFAR）、未定义指令、SVC、BKPT | 同上 | C | L |
| R2.3 | 特权指令：CPS、MRS/MSR（含分组与 SPSR）、SRS、RFE、`LDM`/`STM` 的用户寄存器形式、`SUBS PC, LR`、WFI、WFE、SEV；CP14 调试寄存器的最小集合 | `a32_execute.rs` | C | M |
| R2.4 | CP15：上面列出的系统寄存器、缓存与 TLB 维护操作（按 ASID、MVA、全部）、屏障、通用定时器（CNTFRQ、CNTPCT、CNTV_*、CNTP_*）、性能计数器读零 | `sysregs.rs` 的 AArch32 视图、`timer.rs` | C | L |

### R3 MMU

| ID | 任务 | 关键位置 | 门禁/开关 | 规模 |
| --- | --- | --- | --- | --- |
| R3.1 | 短描述符：段、超级段、大页、小页；域（DACR）；AP/APX、XN、PXN；TEX 重映射（PRRR/NMRR）；ASID 与全局页 | `mmu.rs`、`tlb.rs` | C：随机页表对照（`tests/a64/mmu.mjs` 的 32 位版本） | L |
| R3.2 | 长描述符（LPAE，TTBCR.EAE=1）：三级、MAIR0/1、40 位物理地址、TTBR 的分割 | 同上 | C | M |
| R3.3 | 与访问缓存、页层、TLBI 的 epoch 对接；对齐与权限错误的状态码 | `jit/`、`memory.rs` | C | M |

### R4 32 位平台

| ID | 任务 | 关键位置 | 门禁/开关 | 规模 |
| --- | --- | --- | --- | --- |
| R4.1 | 32 位 virt 的内存布局与 DTB（CPU 节点、GICv2、定时器的中断号、PSCI 的 32 位函数号、chosen） | `src/virt/platform.js`、`src/virt/dtb.js` | `a64-virt-device-tests` 的 32 位用例 | M |
| R4.2 | GICv2：分发器与 CPU 接口 MMIO、SGI、优先级与掩码；多核的 SMP 启动（PSCI CPU_ON） | `gic.rs`、`psci.rs` | kvm-unit-tests（`--arch=arm`）的 gicv2 用例 | M |
| R4.3 | zImage 引导：加载、DTB 与 initrd 的位置、32 位内核的解压入口 | `src/virt/loader.js` | 32 位 Linux 打印到控制台 | S |

### R5 32 位 Linux 验收

| ID | 任务 | 关键位置 | 门禁/开关 | 规模 |
| --- | --- | --- | --- | --- |
| R5.1 | kvm-unit-tests 的 32 位 ARM 用例（selftest、psci、timer、gicv2、pmu 读零、spinlock），QEMU 与 v64 同一组结果 | `tests/kvm-unit-tests/`（新 `--arch=arm` 构建） | C | M |
| R5.2 | Debian armhf 或 Alpine armv7 到登录；探针程序（线程、信号、浮点上下文、独占、自修改代码）；1、2、4 核；快照、重启、关机 | 新 `tests/a64/linux32_boot.mjs`（沿用 `linux_boot.mjs` 的结构） | 与 QEMU 同一组探针结果 | M |
| R5.3 | 页层：PL1 的系统模板与短描述符、长描述符在访问缓存中的支持（与 Q6 共用 A32/T32 模板） | `jit/` | E：同源基准 | L |

### R6 ranchu 机器（Android 模拟器镜像）

Android 模拟器的官方镜像（32 位与 64 位）都为模拟器的 ranchu 板构建：`kernel-ranchu` 期望
goldfish 设备与模拟器给的命令行和 DTB，`system.img`、`userdata.img`（API 28 起还有 `vendor.img`、
`encryptionkey.img`）是各自独立的 virtio 盘。设备的确切清单以 R0.3 为准；预计包括：

| 设备 | 用途 | 说明 |
| --- | --- | --- |
| goldfish_events | 键盘、触摸 | 输入事件与按键表 |
| goldfish_battery | 电池与充电状态 | 固定为插电满电 |
| goldfish_pipe（qemud） | 启动属性、传感器等 qemud 服务；宿主 GLES 时的渲染管道 | 只实现启动属性与必要服务；渲染用客体软件渲染（`-gpu guest` 的等价设置），不做宿主 GLES |
| goldfish_fb 或 virtio-gpu 2D | 显示 | 软件渲染的帧缓冲 |
| goldfish_sync、goldfish_rtc、goldfish_audio | 同步、时钟、声音 | 按 R0.3 的结论取舍；声音可先不做 |
| virtio-mmio 的块设备与网卡 | system、userdata、vendor；网络 | 现有设备 |

| ID | 任务 | 关键位置 | 门禁/开关 | 规模 |
| --- | --- | --- | --- | --- |
| R6.1 | `machine_type: "ranchu"`：内存布局、DTB 与命令行与模拟器一致；32 位（`arm32`）与 64 位（`arm64`）共用 | 新 `src/virt/ranchu.js` | 内核启动到 init | M |
| R6.2 | goldfish 设备（按 R0.3 的清单） | 新 `src/virt/goldfish/` | 设备测试 | L |
| R6.3 | 导入 Android 模拟器的镜像 zip（`kernel-ranchu`、`ramdisk.img`、`system.img`、`vendor.img`、`userdata.img`），与 [android-images-plan.md](android-images-plan.md) 的 I6 共用 zip 读取与磁盘建立；`build.prop` 与 `source.properties` 决定 cpu_type 与 API 级别 | VM 管理器 | app-tests | M |

R6 也让 64 位的官方模拟器镜像（API 24 起的 `arm64-v8a`，包括 Android 8.0、8.1、9）能在 arm64 下运行，
第一部分 Q5.2 用它们验收 32 位应用。

### R7 Android 验收

| ID | 任务 | 关键位置 | 门禁/开关 | 规模 |
| --- | --- | --- | --- | --- |
| R7.1 | 官方 Android 7.1.1（`armeabi-v7a-25_r18`，google_apis）在 `cpu_type: "arm32"`、ranchu 上启动到 `sys.boot_completed` 与桌面；触摸打开应用；安装一个 `armeabi-v7a` APK | 新的 Android 32 位场景（沿用 `android_scenario.mjs`） | 场景通过；冷启动时间与 Android 模拟器 TCG 对比记录 | M |
| R7.2 | 官方 Android 8.0、8.1、9 的 `arm64-v8a` 镜像（API 26–28）在 arm64、profile v3 下运行 32 位应用（第一部分的验收，见 Q5.2） | 同上 | 场景通过 | S |

### R8 界面

| ID | 任务 | 关键位置 | 门禁/开关 | 规模 |
| --- | --- | --- | --- | --- |
| R8.1 | VM 管理器：处理器类型增加“ARM（32 位）”；机器可选 virt 或 ranchu；新预设“Android 7.1（32 位，模拟器镜像）”与“Linux（ARM 32 位）” | `src/app/ui/panels/system.js` 10、`src/app/vm_model.js`、`src/app/guest_presets.js` | app-tests | S |
| R8.2 | 文档：新 `docs/arm32.md`（或并入 [aarch64.md](aarch64.md) 改名为 ARM 的总文档）、[virt.md](virt.md) 的 32 位 virt 与 ranchu | 文档 | — | S |

## 里程碑

| 里程碑 | 内容 | 可见的收益 |
| --- | --- | --- |
| B1 | Q0、Q1 | 往返 AArch32 EL0 的框架与 v3 profile |
| B2 | Q2、Q3 | 整数的 32 位程序（无浮点）可以运行 |
| B3 | Q4、Q5 | Linux armhf 程序与 Android 32 位应用、带 32 位第二架构的系统 |
| B4 | Q6 | 32 位代码的性能达标 |
| B5 | Q7 | 第一部分的界面与文档 |
| C1 | R0–R4 | `cpu_type: "arm32"`：32 位内核在 virt 上启动 |
| C2 | R5 | 32 位 Linux 到登录，kvm-unit-tests 通过 |
| C3 | R6 | ranchu 机器：官方模拟器镜像可以导入并引导（32 位与 64 位） |
| C4 | R7、R8 | 官方 Android 7.1.1 的 32 位镜像到桌面；Android 8、9 的官方 arm64 镜像跑 32 位应用 |

第一部分只为让某个 GSI 能开机时，B1–B3 加 Q7 即可（约 3 个月）；Q6 按性能需要再做，第一部分全部
约 4–5 个月。第二部分在第一部分的指令实现（Q2–Q4）之后再约 4–5 个月（R2、R3、R6 最大）。R6 的 ranchu
机器不依赖 32 位，可以提前做，先让官方的 64 位模拟器镜像在 arm64 下运行。

## 主要风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 指令面大：A32、T32 两套编码加 VFP 与 NEON 的 AArch32 形式 | 编码覆盖清单驱动；T32 解码到与 A32 相同的操作；SIMD 复用 AArch64 的逐元素实现 |
| 没有实机对照（M1 不支持 AArch32） | 以 QEMU 为准，另用 llvm-mc 对照解码；QEMU 的已知偏差照 ARM64 计划的做法登记 |
| v2 行为被意外改变 | v2 的测试全集作为回归；`core-split-check`；新行为全部挂在 v3 下 |
| 页层的条件执行与 IT 块使代码膨胀 | 先只编译无条件或短 IT 块的常见形式，其余单步；以基准决定范围 |
| 需求可能不成立（GSI 是纯 64 位） | Q0.1 先确认；若不需要，第一部分延后，只保留结论 |
| 没有官方的 32 位 Android 8、9 | 第二部分以官方 Android 7.1.1 的 32 位镜像验收；Android 8、9 的官方 arm64 镜像验收 32 位应用；自建的 32 位 8、9 不做 |
| ranchu 的 goldfish 设备没有规范，只有模拟器的源码 | 以模拟器的 QEMU 源码与镜像里的 rc、fstab 为准，只做客体实际用到的；R0.2 的参考记录作对照 |
| PL1 的系统层（模式、短描述符 MMU、CP15）面大 | 裸机对照与 kvm-unit-tests 的 32 位用例逐项推进；与 AArch64 共用 TLB、访问缓存与定时器 |
| 参考 CPU（cortex-a15）是 ARMv7，v64 实现的是 ARMv8 的 AArch32 | ID 值标明 ARMv8 AArch32；ARMv8 移除或改变的行为（SWP、短向量、CP15 屏障）按 ARMv8 处理，与 QEMU 的差异登记 |

## 规范与实现参考

- Arm Architecture Reference Manual for A-profile（ARM DDI 0487）：AArch32 指令集、AArch32 与 AArch64 的
  执行状态切换（“Interprocessing”）、AArch32 的 ESR 编码
- [QEMU target/arm](https://gitlab.com/qemu-project/qemu/-/tree/master/target/arm)：`translate.c`、`translate-a32`/`t32` 的 decodetree 描述
- [Linux arm64 compat](https://www.kernel.org/doc/html/latest/arch/arm64/index.html)：`arch/arm64/kernel/armv8_deprecated.c`、compat 信号与 vDSO
- [Android ABI 管理](https://developer.android.com/ndk/guides/abis)：`armeabi-v7a`
- Arm Architecture Reference Manual ARMv7-A and ARMv7-R（ARM DDI 0406）：短描述符 MMU、CP15、异常模型
- [Android 模拟器（external/qemu，emu-master-dev 分支）](https://android.googlesource.com/platform/external/qemu/)：ranchu 板与 goldfish 设备；[goldfish 内核驱动](https://android.googlesource.com/kernel/goldfish/)
- [Android SDK 系统镜像仓库](https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-1.xml)：官方模拟器镜像的清单
