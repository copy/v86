# AArch32 实施计划

状态：设计与实施计划，尚未实现。2026-10-23 初稿，基于 `c5debe9a`。规模：S 为几天，M 约 1–2 周，
L 约 3–4 周，XL 超过一个月（与 [ARM64 virt 与 Android 16 计划](arm64-virt-android16-plan.md) 相同）。

本计划为 ARM64 核心增加 AArch32：64 位内核下运行 32 位进程（A32 与 T32 指令集、VFP 与 Advanced
SIMD），即 Linux arm64 的 compat 与 Android 的 `armeabi-v7a`。现在的 CPU 只有 AArch64（[aarch64.md](aarch64.md)
“CPU profile”一节把 AArch32 列为不公布），只含 32 位原生库的 APK 安装失败、Linux 的 armhf 程序得到
ENOEXEC，都是 ARM64 计划的预期（arm64-virt-android16-plan.md 84–86）。

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
3. **什么时候才需要单独的选项**：只有 AArch32 跑在 EL1，也就是 32 位内核（ARMv7 的 Linux、Android 9 以前
   只有 32 位的系统、32 位的 Raspberry Pi OS）。那是另一台机器：短描述符或 LPAE 页表、带模式切换和
   分组寄存器的异常模型、CP15 系统寄存器、zImage 与 ATAGS 或 32 位设备树的引导。它若要做，就像 x86
   与 x86-64 那样另设 `cpu_type`（例如 `"arm"`，现在被 [tests/api/arm64-options.js](../tests/api/arm64-options.js) 51–53 拒绝），
   另写计划；本计划不做。
4. **先确认需求再动手。** Cuttlefish 的 `aosp_cf_arm64_only_phone` 是纯 64 位（P10.2 特意选了它，
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

- AArch32 EL1、EL2、EL3（32 位内核、Hyp、Monitor）。
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

## 阶段与任务

### Q0 需求确认、参考与 profile 定义

目标：确认要用的系统镜像确实需要 AArch32；建立对照手段；定下 v3 的 ID 值。

| ID | 任务 | 关键位置 | 门禁/开关 | 规模 |
| --- | --- | --- | --- | --- |
| Q0.1 | 检查要运行的 GSI 与应用：`ro.product.cpu.abilist32`、`ro.zygote`、`/system/lib`、`/system/bin/app_process32`；记录结论（为空则本计划对该 GSI 不是前提） | GSI 的 `system.img` | 结论入本文 | S |
| Q0.2 | 裸机对照框架：AArch64 EL1 的运行时 ERET 到 AArch32 EL0 代码，SVC 与异常回到 0x600 向量；同一程序在 QEMU 与 v86 上跑 | `tests/a64/guest_runner.mjs`、`tests/a64/baremetal/`（start.S 已有 0x600 组） | 框架自测 | M |
| Q0.3 | 单指令 oracle（A32、T32、VFP、NEON）：随机寄存器与内存，逐条与 QEMU 比较；llvm-mc 解码对照 | 新 `tests/a64/aarch32_oracle.mjs`、`tests/a64/oracle/decode.mjs` | 框架自测 | M |
| Q0.4 | v3 的 ID 值：`ID_AA64PFR0_EL1.EL0 = 2`；ID_PFR0/1、ID_ISAR0–6、ID_MMFR0–4、MVFR0–2 取 cortex-a35 与实现范围的交集；COMPAT_HWCAP 预期（half、thumb、fastmult、vfp、edsp、neon、vfpv3、tls、vfpv4、idiva、idivt、lpae、evtstrm 与 aes、pmull、sha1、sha2、crc32） | `tests/platform/a64-profile.json`、`src/virt/platform.js` | C：`tools/cpu_contract.mjs --a64-v86` 与参考一致（允许差异只剩明确列出的） | S |

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
| Q5.2 | Android：带 32 位第二架构的系统（Q0.1 选定的 GSI，或非 arm64-only 的 Cuttlefish 产品）启动到 `sys.boot_completed`，`zygote_secondary` 存活；只含 `armeabi-v7a` 库的 APK 安装并启动 | `tools/a64_android.mjs`、`tests/a64/android_boot.mjs`、`android_scenario.mjs` | 场景通过 | M |
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

## 里程碑

| 里程碑 | 内容 | 可见的收益 |
| --- | --- | --- |
| B1 | Q0、Q1 | 往返 AArch32 EL0 的框架与 v3 profile |
| B2 | Q2、Q3 | 整数的 32 位程序（无浮点）可以运行 |
| B3 | Q4、Q5 | Linux armhf 程序与 Android 32 位应用、带 32 位第二架构的系统 |
| B4 | Q6 | 32 位代码的性能达标 |
| B5 | Q7 | 界面可选，文档完成 |

只为让某个 GSI 能开机时，B1–B3 加 Q7 即可（约 3 个月）；Q6 按性能需要再做。全部约 4–5 个月。

## 主要风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 指令面大：A32、T32 两套编码加 VFP 与 NEON 的 AArch32 形式 | 编码覆盖清单驱动；T32 解码到与 A32 相同的操作；SIMD 复用 AArch64 的逐元素实现 |
| 没有实机对照（M1 不支持 AArch32） | 以 QEMU 为准，另用 llvm-mc 对照解码；QEMU 的已知偏差照 ARM64 计划的做法登记 |
| v2 行为被意外改变 | v2 的测试全集作为回归；`core-split-check`；新行为全部挂在 v3 下 |
| 页层的条件执行与 IT 块使代码膨胀 | 先只编译无条件或短 IT 块的常见形式，其余单步；以基准决定范围 |
| 需求可能不成立（GSI 是纯 64 位） | Q0.1 先确认；若不需要，本计划延后，只保留结论 |

## 规范与实现参考

- Arm Architecture Reference Manual for A-profile（ARM DDI 0487）：AArch32 指令集、AArch32 与 AArch64 的
  执行状态切换（“Interprocessing”）、AArch32 的 ESR 编码
- [QEMU target/arm](https://gitlab.com/qemu-project/qemu/-/tree/master/target/arm)：`translate.c`、`translate-a32`/`t32` 的 decodetree 描述
- [Linux arm64 compat](https://www.kernel.org/doc/html/latest/arch/arm64/index.html)：`arch/arm64/kernel/armv8_deprecated.c`、compat 信号与 vDSO
- [Android ABI 管理](https://developer.android.com/ndk/guides/abis)：`armeabi-v7a`
