# SSSE3 至 x86-64-v3 指令集与 XSAVE 完整实现计划

状态：设计与实施计划；本文不表示这些功能已经实现或通过验收。

（2026-10-15 注：本文提到的 IR Tier-0 与 region 管线（Tier-1/2，`src/rust/ir/`）已由
[jit-unification-plan.md](jit-unification-plan.md) 在 P7.5 与 M11 删除，32 位与 16 位代码现在由 x64 page tier
编译；本文的 `make ir-*-tests` 目标随之删除，各节保留实施当时的记录。）

初稿基于 2026 年 10 月 3 日的工作区（Git 基线 `696d91ab`）。2026 年 10 月 4 日复核到
`6912875a`，其间合入了 SMM（见第 2 节），并按审阅意见修订了解码前缀、浮点、XSAVE、
快照/INIT、测试参考和发布顺序；同日把 x86-64-v3 的其余指令（FMA、F16C、BMI1、BMI2、
LZCNT、MOVBE）纳入范围。目标是让现有
`cpu_type: "x86"` 和 `cpu_type: "x86_64"` 在架构允许的执行模式下完整支持这些指令集，
使 x64 配置达到 x86-64-v3，并覆盖解释执行、编译执行、操作系统状态切换、快照和多核。实现完成前，保持相应 CPUID
能力位关闭；不能以少量程序能够运行、指令名称已登记或解释器与 JIT 结果相同作为完整性证明。

## 1. 交付范围与完成定义

### 1.1 必须交付的功能

| 功能 | 本计划的完成范围 |
| --- | --- |
| SSSE3 | 全部合法 MMX/XMM 形式、寄存器/内存源、立即数、模式与异常规则 |
| SSE4.1 | 全部合法形式，包括整数扩展、混合、舍入、点积、插入/提取和非临时读取 |
| SSE4.2 | 字符串比较四条指令、PCMPGTQ、CRC32；独立审计已有 POPCNT |
| AVX | 两字节/三字节 VEX、架构定义的 128/256 位形式、三操作数、标量合并、YMM 状态及零化指令 |
| AVX2 | 256 位整数扩展、新增 128/256 位形式、广播、排列、变长移位、掩码读写与 gather |
| FMA | VFMADD、VFMSUB、VFNMADD、VFNMSUB、VFMADDSUB、VFMSUBADD 的 132/213/231 全部形式（PS/PD/SS/SD，128/256 位），乘加只舍入一次 |
| F16C | VCVTPH2PS、VCVTPS2PH 的 128/256 位、寄存器/内存形式及 imm8 舍入控制 |
| BMI1 | ANDN、BEXTR、BLSI、BLSMSK、BLSR 的 32/64 位形式，TZCNT 的 16/32/64 位形式；未开放时 `F3 0F BC` 按 BSF 执行 |
| BMI2 | BZHI、MULX、PDEP、PEXT、RORX、SARX、SHLX、SHRX 的 32/64 位形式 |
| LZCNT | 16/32/64 位形式，只在 x64 配置开放（第 13 节 Q7）；未开放时，包括在 32 位配置中，`F3 0F BD` 按 BSR 执行 |
| MOVBE | 16/32/64 位的加载与存储形式（只有内存操作数形式） |
| 基础 XSAVE | XSAVE、XRSTOR、XGETBV(0)、XSETBV、XCR0、CR4.OSXSAVE、CPUID leaf 0xD |
| XSAVE 家族扩展 | 分阶段完成 XSAVEOPT、XGETBV(1)、XSAVEC，最后是 XSAVES/XRSTORS，并分别公布能力位（第 13 节 Q3） |
| 状态分量 | x87/MMX、SSE/MXCSR、YMM_Hi128；按架构定义处理初始化状态与 32/64 位格式 |
| 所有执行入口 | 32 位解释器、IR Tier-0、IR region 管线、64 位解释器及 page tier；兼容模式同样覆盖，且 32 位解释器与 x64 引擎结果一致 |
| 可移植性 | Wasm SIMD 和无 `simd128` 构建提供相同客体语义，宿主无需具有原生 AVX |

这里将“XSAVE 完整”明确拆成基础功能和上述家族扩展，两部分均列入最终目标（XSAVES/XRSTORS
由第 13 节 Q3 定为实现）。本项目没有新增 supervisor state 分量，XSAVES 本身没有功能收益，
公开后还会让 Linux 改走 XSAVES/XRSTORS 的压缩格式路径，所以它放在 M5 的最后一步，并对这条
路径做完整的操作系统验收。XSAVES/XRSTORS 同时实现 `IA32_XSS` 及其校验，初始受支持 XSS
位图为零，不能借此宣称支持其他状态组件。

本计划覆盖 x86-64-v3 的全部要求：在 x86-64-v2 之上，还有 AVX、AVX2、BMI1、BMI2、F16C、
FMA、LZCNT、MOVBE 和 OSXSAVE。很多“要求 AVX2”的软件实际按 v3 整组检测；glibc 的 AVX2
字符串函数也要求 AVX2、BMI1、BMI2、LZCNT 同时可用，只开放 AVX2 时不会被选中。
x86-64-v3 只针对 x64 配置；32 位配置开放其中除 LZCNT 以外的指令（第 13 节 Q7）。

不将 FMA4、AES/PCLMUL、VAES/VPCLMULQDQ、GFNI、AVX-VNNI、SHA、ADX、SSE4a、XOP、AVX-512、
AVX10、MPX、PKRU、AMX 或 APX 纳入本计划。它们有独立能力位或状态组件，后续另行规划；
其中落在 `0F38`/`0F3A` 或 VEX 编码空间的指令，本计划只保证它们稳定地产生 #UD。
本计划要求指令可观察的行为正确，不要求模拟特定物理 CPU 的周期数、缓存实现或
AVX/SSE 转换性能惩罚。非临时访问涉及的内存行为仍须符合现有内存模型。

### 1.2 “完整”的判定单位

以 **指令编码形式** 为单位建立机器可读清单，而非只统计 mnemonic：

```text
ISA / mnemonic / encoding family / opcode map / opcode / mandatory prefix
W / L / vvvv 约束 / ModRM group / operands / immediate / VSIB
legal modes / address size / operand size / CPUID requirements
CR0 / CR4 / XCR0 requirements / exception class / memory footprint
destination merge and upper-half policy / flags / MXCSR effects
interpreter / tier0 / region / x64 interpreter / page tier / portable backend
semantic oracle / positive tests / negative tests / lifecycle tests
```

每个形式必须有合法编码测试、非法编码测试、独立语义依据和每条相关执行路径的覆盖。
后端可以调用已验证的公共语义 helper；复杂指令不必全部内联，但不能静默跳过、返回固定值，
或因某种 JIT 模式缺少实现而变成 #UD。性能优化另设验收，不用“已内联”替代语义正确。

指令规范以 [Intel SDM 官方入口](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html)
中的 Volume 2 各指令条目及 Volume 3 异常规则为准。P0 固定实际使用的手册版本、
下载校验值和勘误，避免测试随着在线文档更新而无记录变化。本文统一引用
[SDM 合订本（cdrdv2 835781）](https://cdrdv2-public.intel.com/835781/325462-sdm-vol-1-2abcd-3abcd-4.pdf)，
并注明卷号和章节。P0 固定的版本是 325462-085US（2024 年 10 月），SHA-256
`ae21642237489554840f3e640848e53bdbbbfa73108a92e60139748b4f804de3`；更换版本时同步更新所有引用。

## 2. 当前代码基础与缺口

| 入口 | 审查所得现状 | 所需改动 |
| --- | --- | --- |
| [`gen/x86_table.js`](../gen/x86_table.js)、[`gen/generate_interpreter.js`](../gen/generate_interpreter.js)、[`src/rust/decode_rules.rs`](../src/rust/decode_rules.rs) | `0F38/0F3A` 仍是占位；生成器围绕主表和 `0F` 表组织，并假设现有 opcode 长度。`mandatory_prefix` 让 66 优先于 F2/F3；遇到未列出的强制前缀时只有 `dbg_assert`，release 构建执行无前缀形式 | 扩展 map-aware 编码描述和生成器，不能仅追加数值 opcode；按 5.2 节统一前缀规则 |
| [`src/rust/cpu/instructions_0f.rs`](../src/rust/cpu/instructions_0f.rs) | `instr_0F38/0F3A` 调用未实现入口；XSAVE/XRSTOR/XSAVEOPT 为未定义指令路径；`0FAE /7`（CLFLUSH）一律 #UD，而 x64 配置公布了 CLFSH | 接入新解码、共享语义及独立功能门控；顺带消除 CLFLUSH 在兼容模式下的双引擎分歧 |
| [`src/rust/ir/frontend/decode.rs`](../src/rust/ir/frontend/decode.rs)、[`gen/generate_ir_decoder.js`](../gen/generate_ir_decoder.js) | 当前解码围绕单字节及 `0F`，无 VEX 元数据 | 扩展编码身份、立即数、第三源及 VSIB 表达 |
| [`src/rust/x64/decode.rs`](../src/rust/x64/decode.rs) | 长模式拒绝 C4/C5；`base_opcode` 与后续分发需要支持更多 map；同样 66 优先，未列出的强制前缀只在 64 位模式下 #UD | 保持解释器/page tier 共用解码结果，增加 VEX 与三字节 map；前缀规则与 32 位解码器统一 |
| [`src/rust/ir/tier0/simd.rs`](../src/rust/ir/tier0/simd.rs)、[`src/rust/ir/tier0/emit.rs`](../src/rust/ir/tier0/emit.rs) | SIMD 缓存围绕 8 个 XMM/v128 | 扩展 YMM 高半依赖、物化、写回和 helper 边界 |
| [`src/rust/ir/types.rs`](../src/rust/ir/types.rs)、[`src/rust/ir/simd.rs`](../src/rust/ir/simd.rs)、[`src/rust/ir/backend/simd.rs`](../src/rust/ir/backend/simd.rs) | 已有 V128、整数 SIMD、scalar 后端及状态恢复基础 | 表达成对 v128 的 256 位值、跨半区操作和副作用 |
| [`src/rust/x64/vector.rs`](../src/rust/x64/vector.rs)、[`src/rust/x64/pagegen.rs`](../src/rust/x64/pagegen.rs) | 已有 SSE–SSE3、较完整的 FP 处理及部分原生模板 | 抽取可复用语义，扩展 16 个 YMM 和 page tier |
| [`gen/state_layout.js`](../gen/state_layout.js) | XMM0–7 与 XMM8–15 分库存放；无 YMM_Hi128/XCR0；固定状态区为 4096 字节 | 追加每核字段并重新生成 Rust/JS 布局；校验空间、范围与快照兼容 |
| [`src/rust/cpu/misc_instr.rs`](../src/rust/cpu/misc_instr.rs)、`x64/vector.rs` | 分别实现 legacy 与 long-mode FXSAVE/FXRSTOR。legacy 的对齐 #GP 只是 `dbg_assert`；x64 的 FXSAVE 整块写出 512 字节（SDM 规定处理器不写 464–511 字节），并且在非 64 位模式下也存取 XMM8–15 | 提取模式相关的状态编解码，修复影响 XSAVE 的旧路径缺陷（6.2 节） |
| `instructions_0f.rs`、[`src/rust/x64/system.rs`](../src/rust/x64/system.rs) | CPUID 未公布目标扩展，无 leaf 0xD；两条路径的 CR4 合法位校验不一致（legacy 接受 bit 18 OSXSAVE）。CPU 配置只是布尔值 `X64_TEST_CAPABILITIES`，不进快照；`cpuid_level` 可配置（Windows NT 用 2）。32 位配置的 CPUID 0x80000000 返回 5，即没有有效的扩展 leaf，因此无法报告 LZCNT（0x80000001:ECX[5]） | 集中能力定义并改为能力位图，统一 OSXSAVE、XCR0 和异常规则；32 位配置不补扩展 leaf，也不开放 LZCNT（第 13 节 Q7） |
| [`src/rust/cpu/smm.rs`](../src/rust/cpu/smm.rs)（基线后合入） | SMI 进入时把 CR4 清零；RSM 原样恢复 CR4，不做合法位校验；`entered_mode()` 会调用 `ir_admission_barrier` | RSM 与 MOV CR4 共用校验，并列入 JIT 失效写入方（6.1 节） |
| [`src/rust/ir/runtime/sse_fp.rs`](../src/rust/ir/runtime/sse_fp.rs)、[`src/rust/cpu/cpu.rs`](../src/rust/cpu/cpu.rs) | 32 位引擎（解释器、Tier-0、regions）的 SSE/SSE2 算术直接用宿主或 Wasm 运算：不设置任何 MXCSR 状态位，算术不支持 RC/DAZ/FZ（`set_mxcsr` 只打日志），也从不产生 #XM。x64 的 `vector.rs` 基于 SoftFloat，是精确的 | 单列 P4a：建立准确的公共 FP 核心，改造现有 SSE/SSE2 浮点路径（7.4 节） |
| [`src/rust/ir/runtime/continuation.rs`](../src/rust/ir/runtime/continuation.rs) | selective continuation 保存范围包含 legacy XMM，但没有 YMM 高半 | 扩展捕获/恢复与失效规则，防止 helper 返回后恢复过期高半 |
| [`lib/softfloat/softfloat.c`](../lib/softfloat/softfloat.c)、[`src/rust/softfloat.rs`](../src/rust/softfloat.rs) | 捆绑的 C SoftFloat 已包含 `f32_mulAdd`、`f64_mulAdd`、`f32_to_f16` 和 `f16_to_f32`，Rust 侧尚未声明 | FMA/F16C 的精确路径直接复用；x86 的 NaN 选择规则在外层实现（9.3 节） |
| `gen/x86_table.js` 的 BSF/BSR、`x64/execute.rs`、`x64/pagegen.rs` | `0F BC/BD` 忽略 F3 前缀，行为等同于不支持 BMI1/LZCNT 的 CPU | TZCNT/LZCNT 是唯一随能力位改变解码结果、而不是变成 #UD 的形式：能力关闭时仍按 BSF/BSR 执行（5.2 节） |
| 惰性标志：32 位引擎的 `flags_changed`/`last_op1`/`last_result`，x64 page tier 的惰性标志记录 | 只覆盖现有整数指令 | BMI1/BMI2/LZCNT/TZCNT 接入两套机制，未定义标志取固定值（9.2 节） |
| [`src/cpu.js`](../src/cpu.js) | 多核快照按区间恢复，缺失区间填复位值（SMBASE 是先例）；单核旧快照把 1360 以上的 core 区间清零。INIT 只保留 `INIT_PRESERVED` 中的 PAT、MTRR、MC 和 SMBASE，其余（包括 x87、XMM、MXCSR）都取复位值 | 按 6.4 节加入 XCR0/XSS 的填充与 INIT 规则 |
| [`tests/nasm/`](../tests/nasm/)、[`tests/x64/`](../tests/x64/) | 已有差分与外部 oracle；NASM fixture 目前只记录 XMM0–7；`qemu_oracle.js` 只解析 `XMM0n=`，并以 `-cpu max` 运行 QEMU | 版本化记录格式，增加 YMM、MXCSR、XCR0、异常与内存副作用；处理 11.1 节列出的 QEMU 缺口 |

现有 IR 是唯一的 32 位 JIT，旧 Legacy JIT 已移除。long mode 使用独立 page tier，
不能假设修改 32 位 IR 就同时完成 64 位支持。沿用
[`docs/ir-design.md`](ir-design.md) 和 [`docs/x86-64.md`](x86-64.md) 的分工，
本项目不以建设 64 位 region 管线为前置条件。

兼容模式（LMA=1、CS.L=0）由两个引擎共同执行：在 `X64_COMPAT_JIT` 下，编译过的代码经
32 位解释器单步执行，未编译的代码走 x64 引擎。两者对同一指令的任何分歧，都要等代码变热后
才会暴露（RDTSCP 曾因此出现“热了就 #UD”）。目前已知的同类偏差有 CLFLUSH、FXSAVE/FXRSTOR
的 XMM 范围和 SSE 浮点精度。新形式按 3.1 节共用解码，并按 5.2 节做双引擎差分。

## 3. 总体设计

### 3.1 一份编码契约，共享纯语义，保留模式适配层

在生成源中建立规范化编码描述，供解释器表、IR 解码、x64 解码校验和覆盖报告使用。
建议保留 `gen/x86_table.js` 作为入口，将新 SIMD 表和特性依赖拆到专门模块；
具体拆文件方式在 P0 确定。不要手工修改生成后的解释器文件或 coverage JSON。

VEX、`0F38` 和 `0F3A` 的字段解析与合法性判定只实现一份（例如扩展
[`src/rust/decode_rules.rs`](../src/rust/decode_rules.rs)），由 32 位解释器生成器、IR 解码和
x64 解码共同调用，从结构上消除兼容模式下的双引擎分歧。解释器对 VEX 采用两级分派（先 map
再 opcode），不把 map×pp×L×W 摊平成巨型 match 或 br_table；V8 遇到数万项的 br_table
曾因 Zone OOM 中止。

公共语义层接收已经读取的操作数，返回结果及 flags/MXCSR 更新，不在整数 lane 运算中
直接访问全局 CPU 或客体内存。各执行引擎负责模式检查、地址转换、异常交付和结果提交。
字符串比较、FP、gather 与 xstate 使用明确的专用结果类型，不强行塞进单一“向量二元运算”。

新模块建议按职责组织为 SIMD 整数、SIMD 浮点（含 FMA/F16C）、字符串/CRC、位操作
（BMI/LZCNT/MOVBE）、xstate；最终路径随现有
Rust 模块结构确定。公共 helper 的读写状态、副作用和异常出口必须登记到 IR helper contract。

### 3.2 YMM 表示与状态所有权

- 保留现有 XMM 低 128 位存储，追加 16 × 128 位的 `YMM_Hi128`，避免 XMM/YMM 两份低半数据。
- 32 位/兼容模式按编码可访问 0–7，long mode 可访问 0–15；模式切换不得误清不可寻址的寄存器。
- 追加每核 `XCR0`；家族扩展阶段补充 `IA32_XSS`、必要的 in-use/modified 跟踪信息。
  架构状态均标为 `owner: "core"`，临时优化缓存单独分类。
- 256 位执行优先表示为 `(lo: v128, hi: v128)`。Wasm scalar 后端提供等价实现，
  不为客体 AVX 引入宿主 AVX 或新的浏览器能力要求。
- IR 使用显式的成对向量值和集中读写 API；不先在整个类型系统增加 V256，避免一次性扩大
  优化器和寄存器分配器改动。需要 256 位整体操作时，由语义操作统一管理两半。
- 每个编码记录写入策略：legacy SSE 保留高半；VEX.128 向量目的寄存器清零高半；
  VEX.256 写完整两半。标量指令的低半合并、内存源零化等规则逐条描述，不能只看长度决定。
- `VZEROUPPER/VZEROALL`、FXRSTOR/XRSTOR、helper、去优化、跨页退出和快照都走同一状态边界。
  非 64 位模式下，VZEROUPPER/VZEROALL 只修改 YMM0–7；FXSAVE/FXRSTOR/XSAVE/XRSTOR 也不存取
  XMM8–15 及其高半。

### 3.3 精确异常与内存访问

建立逐类异常表，明确 #UD、#NM、#GP、#SS、#AC、#PF、#XM 的条件和优先顺序。
分类直接采用 SDM Volume 2A 第 2 章的异常类型（Exception Type 1–13；F16C 属 Type 11，
VEX 编码的 GPR 指令属 Type 13），清单为每个形式登记所属类型。不能给所有 SIMD 指令套用
同一套 CR0/CR4 检查：MMX、legacy XMM、AVX、BMI、CRC32、POPCNT、XSAVE 和 XGETBV/XSETBV
的条件不同。最容易出错的几条规则要显式写进测试：

- VEX 编码的 SIMD 指令（包括 FMA、F16C）要求 CR4.OSXSAVE=1 且 XCR0[2:1]=11b，否则 #UD；
  CR0.TS=1 时 #NM。SDM 的异常类型表只对传统 SSE 列出 CR0.EM 和 CR4.OSFXSR；QEMU 对 VEX
  指令也检查 CR0.EM，这一点需要硬件判定（11.1 节）。
- VEX 编码的 GPR 指令（BMI1、BMI2）不受 CR0.TS、CR4.OSXSAVE 和 XCR0 影响，操作系统没有
  开启 AVX 时照样可用；VEX.L=1 时 #UD，非 64 位模式下忽略 VEX.W1。
- VEX 访存除 Type 1（对齐 move、VMOVNTDQA 等）外不要求对齐。
- 传统 SSE 的 16 字节对齐要求有例外：MOVU*/LDDQU、PCMPxSTRx，以及按窄宽度访问内存的形式。
- 32 位路径原先在 CR4.OSFXSR=0 时只打日志，不产生 #UD。P4a 改为新旧形式共用同一组检查
  （14 节 P4a 第二部分）。

普通向量运算先检查合法性、读取需要的操作数，再提交目的状态。不得提前读取比指令规定
更宽的内存，例如把窄源扩展读取成完整 16/32 字节。编译阶段只读指令快照，不触发数据 MMIO
或客体异常。跨页、非 canonical 地址、段边界和高物理地址复用现有受检访存接口。

gather 允许架构规定的逐元素进度，不能套用普通指令的整体回滚；XSAVE/XRSTOR 的多次
内存访问和故障后的可观察状态也单独按规范定义。page tier 的 RETRY 只用于尚未产生
副作用的指令；已提交 gather lane 后不能从头重放全部访存。

## 4. 分阶段路线与依赖

| 阶段 | 交付物 | 依赖 | 阶段验收 |
| --- | --- | --- | --- |
| P0 | 完整编码清单、能力依赖、热点形式清单、测试/性能基线、固定参考版本；第 13 节待决问题的结论 | 无 | 目标形式清单可审阅，已有能力无变化 |
| P1 | `0F38/0F3A` 与 VEX 解码基础、统一的强制前缀规则、负例、模式适配 | P0 | 独立解码差分通过，旧解码的有意修正都有回归测试 |
| P2 | YMM/XCR0 每核状态、基础 XSAVE/XRSTOR（只接受标准格式）、快照迁移 | P0。XSAVE 系列在 `0F AE`/`0F C7`，XGETBV/XSETBV 在 `0F 01`，都属现有 map，不依赖 P1 | 分量 round-trip、异常、旧快照和多核通过 |
| P3 | SSSE3 全部形式、执行后端与覆盖 | P1 的 legacy maps | MMX/XMM 及三条 32 位执行路径、两条 x64 路径通过 |
| P4a | 公共准确 FP 核心；现有 SSE/SSE2 浮点改造与快路径准入 | P0 的精度策略结论（Q2） | 旧 SSE 浮点的精确性差分与性能预算都通过 |
| P4b | SSE4.1/SSE4.2 | P1、P4a；复用 P3 语义基础 | 全部 forms、FP/字符串边界与独立 oracle 通过 |
| P5 | AVX 128 位、三操作数、零化、VEX 状态门控 | P1、P2、P3、P4b | legacy/VEX 混合链、标量合并和状态恢复通过 |
| P6 | AVX 全部 256 位形式及掩码访存 | P5 | 256 位浮点、排列、异常及 OS 上下文保存通过 |
| P7 | AVX2 普通整数、广播、排列、变长移位 | P6 | 逐形式和双 128 位 lane 边界测试通过 |
| P8 | AVX2 gather 与掩码故障/重启完整性 | P7；复杂访存框架可提前并行 | 故障进度、mask 写回、重启及 MMIO 计数通过 |
| P9 | XSAVEOPT、XGETBV(1)、XSAVEC，最后是 XSAVES/XRSTORS | P2；与 P5–P8 并行 | 各独立能力位、格式及状态跟踪通过 |
| P10 | BMI1、BMI2、LZCNT/TZCNT、MOVBE：VEX 编码 GPR 指令、旧编码位操作与标志位接入 | P1；与 P2–P9 并行 | 逐形式语义与标志位通过；能力关闭时 TZCNT/LZCNT 按 BSF/BSR 执行的测试通过 |
| P11 | FMA、F16C | P4a、P6 | 单次舍入、NaN/MXCSR 规则、F16C 舍入控制与独立 oracle 通过 |
| P12 | 发布集成、真实客体、浏览器/可移植构建及性能 | P3–P11 | 完整清单无缺口，所有发布验收完成 |

P1 的 legacy maps 可先交付，以便推进 P3/P4b；P2 不依赖 P1，可以在 P0 之后直接开始。
P10 只依赖 P1 的 VEX 解码，不涉及 YMM、XSAVE 和 MXCSR，可以与 P2–P9 并行。
P4a 的 FP 核心、oracle/fixture 升级也可从 P0 后独立推进。解码元数据、寄存器状态接口和
能力定义先冻结，再并行开发指令族。每个阶段都要接入相应编译执行路径和测试，不把所有
后端工作积压到最后。

### 4.1 发布里程碑

能力位按里程碑开放。每个里程碑独立验收，对应 `tools/release_gate.mjs` 中的一个等级（11.4 节）：

| 里程碑 | 包含阶段 | 开放的能力 | 价值与前提 |
| --- | --- | --- | --- |
| M1 x86-64-v2 | P1 的 legacy maps、P3、P4a、P4b | 两个配置都开放 SSSE3、SSE4.1、SSE4.2 | x64 配置已有 CX16、LAHF/SAHF、POPCNT 和 SSE3，补齐后即达到 x86-64-v2（RHEL 9 系要求它；Windows 11 24H2 要求 SSE4.2 和 POPCNT）。不需要 VEX、YMM 或 XSAVE |
| M2 基础 XSAVE | P2 | XSAVE（OSXSAVE 位随 CR4 反映）；XCR0 只支持 x87 和 SSE | 有 XSAVE 而无 AVX 有硬件先例（Goldmont），可以先验证操作系统的上下文切换路径。XCR0 的可支持位由 CPU 配置推导，开放 AVX 后才允许 bit 2 |
| M3 AVX | P5、P6 | AVX；XCR0 bit 2 | 依赖 M1、M2 |
| M4 x86-64-v3 | P7、P8、P10、P11 | AVX2、FMA、F16C、BMI1、BMI2、LZCNT、MOVBE 一起开放（32 位配置不含 LZCNT） | 依赖 M3。软件多按 v3 整组检测；glibc 的 AVX2 字符串函数要求 AVX2、BMI1、BMI2、LZCNT 同时可用，libm 的 `_fma` 变体要求 FMA 和 AVX2，只开放其中一部分收益有限。P10 的指令可以更早用内部 feature mask 测试，对外随 M4 开放 |
| M5 XSAVE 扩展 | P9 | XSAVEOPT、XGETBV(1)、XSAVEC，最后开放 XSAVES | 依赖 M2；每开放一项都会改变 Linux 和 glibc 的代码路径（6.3 节） |

每个里程碑开放能力位之前，5.1 节热点形式清单中属于该里程碑的形式，必须已在编译路径上有
原生模板（12.2 节）。

进度：M1 于 2026-10-07 开放（14 节“M1”）：公开选项 `cpu_features` 接受这三个能力，默认 CPU
配置不变（Q1）。M2、M3 于 2026-10-08 开放（14 节“M2、M3”）：`cpu_features` 另接受 XSAVE 与 AVX。
M4、M5 于 2026-10-08 开放（14 节“M4、M5”）：`cpu_features` 另接受 AVX2、FMA、F16C、BMI1、BMI2、LZCNT、MOVBE
（`cpu_type: "x86_64"` 时有预设 `"x86-64-v3"`）以及 XSAVEOPT、XSAVEC、XGETBV1、XSAVES；默认 CPU 仍不变（Q1）。

## 5. P0–P1：清单、能力契约和解码

### 5.1 编码清单与生成检查

在 `gen/` 下新增目标 ISA 清单及审计工具，为每种 register/memory、W/L、模式、
立即数和掩码形式分配稳定 ID。清单中的 iform、isa-set、CPUID 位、异常类型、操作数宽度和
属性，直接由 [Intel XED](https://intelxed.github.io/ref-manual/) 的数据文件生成，避免手抄
SDM 表格；SDM 只做仲裁，分歧逐条登记。XED 或已有的 iced-x86（`tests/x64/oracle`）同时作为
独立解码参考。解码参考不是执行语义 oracle。

扩展 `ir-coverage.json` 生成、测试归属及未知编码检查。现有 `Pending=0` 只覆盖旧目录；
新验收应同时断言预期 forms 总集和实现集相等，防止“没登记就不算缺失”。
P0 输出各 ISA 的 forms 数量并固定在基线中，本文不凭 mnemonic 数量估算完整性。

P0 同时产出“热点形式清单”。做法是反汇编目标客体中会因能力位开放而改走新路径的代码，
列出其中实际执行的形式。这类代码包括 glibc 的 IFUNC 变体（含 libm 的 `_fma` 变体）与 ld.so
惰性绑定、Linux 内核的上下文切换、zstd 这类按 BMI2 运行时分派的库，以及 Windows 的对应库。
清单中的形式例如 PCMPISTRI、VMOVDQU ymm、VPCMPEQB、VPMOVMSKB、VZEROUPPER、TZCNT、
LZCNT、BLSR、SHLX/SARX/BZHI、VFMADD231SD/PD、PSHUFB、PALIGNR 和 XSAVE/XRSTOR。
它用于 4.1 节的开放前提和 12.2 节的性能基准。

P12 补充：真实客体中开放 AVX2 与 BMI2 后，Linux 内核的 SHA-256/512（`*_transform_rorx`，如校验模块签名）在
启动中执行 RORX 与 AVX2 的 ymm 移位、VPALIGNR、VPSHUFD、VINSERTI128、VPERM2I128。它们不在取自 glibc 的这份
清单中，起初在 page tier 单步执行，启动因此慢了 75%；P12 为它们补了模板（14 节 P12 第一部分）。

### 5.2 解码改造

- 分离 `encoding family + map + opcode + pp`，不要继续靠 opcode 整数长度猜 mandatory prefix。
- legacy 增加 `0F38/0F3A` 的第三 opcode 字节及相应 imm8；正确保留 `0F39` 等未分配空间。
- 实现 C5 两字节和 C4 三字节 VEX，解出反相 R/X/B、vvvv、W、L、pp、map 字段。
- 按模式区分 legacy LES/LDS 与 VEX；覆盖 16/32 位及兼容模式，不能把所有 C4/C5 都判成 VEX。
- 独立声明 W0/W1/WIG、L0/L1/LIG 和保留 vvvv 规则；忽略位与非法位不能混为一谈。
- 校验重复/冲突 prefix、LOCK、REX 与 VEX 的组合，按规范决定可接受、忽略或 #UD。
- 强制前缀采用 XED 的 refining-prefix 规则：F2/F3 优先于 66，F2/F3 并存时取最后一个；
  有 F2/F3 时，66 只作操作数大小前缀，例如 `66 F2 0F 38 F1` 是 CRC32 r32, r/m16。现有两个
  解码器都让 66 优先：按代码推断，`66 F3 0F 10` 在 32 位和兼容模式下执行 MOVUPD，在 64 位
  模式下 #UD，而硬件执行 MOVSS。统一后会改变旧 `0F` 表的行为，这是有意修正，需补回归测试。
- 未列出的强制前缀在所有模式、所有构建下一律 #UD。现在 32 位生成器只有 `dbg_assert`，
  release 构建会执行无前缀形式；照搬到 `0F38` 后，`F3 0F 38 00` 会被执行成 MMX PSHUFB。
- `F3 0F BC/BD` 在开放 BMI1/LZCNT 时是 TZCNT/LZCNT，未开放时 F3 被忽略、按 BSF/BSR 执行。
  这是本计划中唯一随能力位改变解码结果、而不是变成 #UD 的情形。解码缓存、Tier-0 和
  page tier 的编译结果都以 CPU 配置为前提；恢复快照导致配置变化时一并清空。
- `0F 38 F0/F1`：无前缀或只有 66（操作数大小）时是 MOVBE，只有内存形式，寄存器形式和
  F3 前缀 #UD；F2 前缀是 CRC32，`66 F2` 是 CRC32 的 16 位源形式。
- BMI1/BMI2 的 VEX.vvvv 用法各异（源、目的或控制操作数），按清单逐条登记。
- 支持 imm8 高位编码第四源的 VBLENDV* / VPBLENDVB，及 gather 的 VSIB 索引。
- VSIB 保留向量索引寄存器、元素宽度和 scale，不能沿用普通 SIB 的 GPR 索引及 no-index 判断。
- 对合法和非法编码均验证长度、15 字节上限、截断输入、跨取指页和 #UD/取指故障顺序。
- 更新 x64 `Decoded`/`base_opcode`、page tier 分类以及测试 oracle 的编码 key，避免 map 碰撞。

P1 验收包含独立解码器差分、所有 prefix/字段组合的边界集、LES/LDS 回归和取指故障测试。
未开启某项能力时仍应得到稳定的解码及正确 #UD 行为，不允许执行到另一个旧指令。
在兼容模式下合法的每个新形式，都要在 32 位解释器和 x64 引擎上做差分（第 2 节末），
比较长度、#UD 和执行结果。

## 6. P2 与 P9：XSAVE、CPU 契约和生命周期

### 6.1 CPUID 与运行时启用

| 枚举入口 | 需要落实的内容 |
| --- | --- |
| CPUID.1:ECX | SSSE3[9]、FMA[12]、SSE4.1[19]、SSE4.2[20]、MOVBE[22]、XSAVE[26]、OSXSAVE[27]、AVX[28]、F16C[29]；POPCNT[23] 独立 |
| CPUID.7.0:EBX | BMI1[3]、AVX2[5]、BMI2[8]，保留其他既有位（例如 ERMS[9]） |
| CPUID.80000001H:ECX | LZCNT[5]（AMD 称 ABM），保留 LAHF/SAHF[0]；只在 x64 配置报告。32 位配置的 0x80000000 继续返回 5（没有扩展 leaf），不报告 LZCNT（第 13 节 Q7） |
| CPUID.0 | 最大 basic leaf 能到达 0xD，并保留 `cpuid_level` 等已有配置契约。`cpuid_level` 小于 0xD 时，隐藏 XSAVE、OSXSAVE 以及依赖它们的 AVX、AVX2、FMA、F16C；小于 7 时，隐藏 AVX2、BMI1 和 BMI2。否则 Linux 会因 leaf 0xD 不可达而告警，并退回 FXSAVE |
| CPUID.0xD,0 | 支持的 XCR0 位图、当前启用状态所需标准大小、全部支持分量所需大小 |
| CPUID.0xD,1 | EAX 中 XSAVEOPT[0]、XSAVEC[1]、XGETBV(1)[2]、XSAVES/XRSTORS[3]；适用的 compacted 大小及支持的 XSS 位图 |
| CPUID.0xD,2 | YMM_Hi128 的大小、标准偏移和属性；其他未支持分量子叶正确返回零 |

CPUID 中硬件能力与 OS 启用状态分开：OSXSAVE 根据当前 vCPU 的 CR4.OSXSAVE 返回，
AVX、AVX2、FMA、F16C 的硬件能力不随一次 XSETBV 被清除。执行时检查对应能力、CR0/CR4 和 XCR0。
Linux 的应用检测流程也要求结合 CPUID 与 XGETBV，见
[Linux xstate 文档](https://www.kernel.org/doc/html/latest/arch/x86/xstate.html)。

能力之间的依赖由 CPU 配置统一校验，不满足时拒绝创建：AVX 依赖 XSAVE，AVX2、FMA 和 F16C
依赖 AVX；BMI1、BMI2、LZCNT 和 MOVBE 不依赖 AVX 与 XSAVE，也不受 OS 是否开启 AVX 影响。

基础 XCR0 支持位为 x87[0]、SSE[1]、YMM[2]；复位值为 1。可支持位由 CPU 配置推导：
未开放 AVX 时只有 x87 和 SSE（M2），CPUID.0xD,0 的 EAX 和各大小字段随之变化。XSETBV 检查 ECX、CPL、
保留位、x87 必须保留启用、YMM 对 SSE 的依赖，以及 OSXSAVE 前提。XGETBV(0) 与
XGETBV(1) 分别受对应条件控制；不支持的 index 不能返回伪造零值。

统一 legacy 与 x64 的 CR4 写入校验，修复当前未公布 XSAVE 却接受 OSXSAVE 位的路径；
RSM 恢复的 CR4 走同一套校验。能力关闭、OS 未开启、TS/EM 状态和 XCR0 不完整的测试，
分别记录异常向量与指令位置。

已编译代码必须立即遵守新状态，按变化频率分两种方式处理：

- CR0.TS 在 XP 这类延迟保存 FPU 的系统里切换频繁，沿用 Tier-0 现有的运行时检查（`simd_guard`）。
- CR4.OSXSAVE 和 XCR0 很少变化，走准入版本号失效（`ir_admission_barrier` 及 page tier 的对应机制）。

写入方要逐一覆盖并各有测试：MOV CR0/CR4、CLTS、LMSW、硬件任务切换（会置 TS）、XSETBV、
SMI（CR4 清零，所以 SMM 内 OSXSAVE=0）、RSM、INIT/RESET 和快照恢复。XCR0 不在 SMRAM
保存映像里，跨 SMI/RSM 保持不变。

### 6.2 状态区编解码

基础标准格式按架构分量组织，不直接复制内部 CPU state block：

| 区域 | 偏移 / 大小 | 工作项 |
| --- | --- | --- |
| Legacy region | 0 / 512 字节 | x87/MMX、MXCSR、XMM；遵循模式和 REX.W 对指针字段/寄存器数量的规定 |
| Header | 512 / 64 字节 | XSTATE_BV、XCOMP_BV、保留字段及格式合法性 |
| YMM_Hi128 | 576 / 256 字节 | 16 个寄存器的高半存储；非 long mode 的实际访问范围按规范处理 |

仅支持这些分量时，标准格式全部启用的大小为 832 字节。CPUID 动态大小由分量表和启用位
计算，不能在所有查询中无条件返回 832。compact 格式由对应布局算法处理，即使当前
分量组合恰好与标准格式使用相同偏移，也必须检查格式位。规则依据 SDM Volume 1 第 13 章
（[合订本](https://cdrdv2-public.intel.com/835781/325462-sdm-vol-1-2abcd-3abcd-4.pdf)）。

实现要求：

- 按每条指令计算 requested/enabled mask，区分“未请求保持不变”“请求恢复存储值”
  和“请求但状态位未置位时恢复初始化值”。
- XSAVE/XSAVEOPT 保留未请求分量的 XSTATE_BV 位，新值为
  `(旧 XSTATE_BV & ~RFBM) | (XINUSE & RFBM)`；它们只写 XSTATE_BV，不写 XCOMP_BV 和头部其他字节。
  XSAVEC/XSAVES 按 RFBM/in-use 规则重写位图、清零未请求位并设置 XCOMP_BV。
  各指令未规定写入的保留字节保持不变，不能用统一的 header 清零或合并策略替代。
- MXCSR/MXCSR_MASK 有专门的保存与恢复条件，不能简单归结为复制 SSE 分量：
  - XSAVE 在 RFBM[1] 或 RFBM[2] 为 1 时保存 MXCSR 和 MXCSR_MASK。
  - 标准格式的 XRSTOR 在同样条件下，不管 XSTATE_BV 是什么，都从内存加载 MXCSR，并校验保留位。
  - 压缩格式把 MXCSR 归入分量 1，初始化时置为 1F80H。
  - 特别测试只请求 YMM、SSE 标记为 init、非默认 MXCSR、无效 MXCSR 保留位等组合。
- XRSTOR 是否接受压缩格式取决于 XSAVEC：`XCOMP_BV[63]=1` 而
  CPUID.(EAX=0DH,ECX=1):EAX[1]=0 时 #GP(0)。所以 P2 的 XRSTOR 必须拒绝压缩格式，
  P9 开放 XSAVEC 时在同一能力位下放开。
- 64 字节对齐、CPL/TS、段限制、页权限、canonical 地址以及各异常优先级逐项验证。
- 按实际需要访问的字段/分量访存，不预读/预写完整 832 字节，不触碰未请求区域制造额外 #PF。
- 保存前同步 x87 shadow 与编译器缓存；恢复后更新/失效 x87、XMM/YMM、MXCSR 派生状态。
- 明确多次访存故障后的允许部分效果和恢复策略；不把普通向量“先检查后提交”当作
  所有 xstate 指令的统一架构要求。
- 修复共享到这里的 FXSAVE/FXRSTOR 缺陷；FXSAVE/FXRSTOR 本身不应偷偷保存、清零或恢复 YMM 高半：
  - x64 的 FXSAVE 先构造 512 字节零缓冲区再整块写出，而 SDM 规定处理器不写 464–511 字节
    （Linux 在信号帧里用这一段存放 sw_reserved）。XSAVE 只写所选分量的字段，不能沿用整块写出。
  - x64 的 FXSAVE/FXRSTOR 在非 64 位模式下也存取 XMM8–15，应只存取 XMM0–7。
  - 32 位 FXSAVE/FXRSTOR 未对齐时只有 `dbg_assert`，应产生 #GP。

### 6.3 家族扩展的单独验收

| 扩展 | 独立工作与验收 |
| --- | --- |
| XSAVEOPT | 标准格式及合法 init/modified 优化语义；保守保存可作为正确性阶段实现，跳过写入优化另测 |
| XSAVEC | compacted 格式、XCOMP_BV、分量布局和 init 规则；XRSTOR 随同一能力位开始接受压缩格式（6.2 节） |
| XGETBV(1) | 返回与 XCR0/in-use 语义一致的值，独立 CPUID 门控，不强制将架构允许的保守 in-use 判成错误 |
| XSAVES/XRSTORS（M5 最后一步） | CPL0、IA32_XSS 的 RDMSR/WRMSR、用户/监督状态位图及 compacted 保存恢复；未支持 XSS 位写入 #GP |

优化跟踪必须纳入所有写入来源，包括 legacy SSE、VEX、FXRSTOR、XRSTOR、VZERO*、
复位及快照恢复。首轮可以采用规范允许的保守跟踪；不能漏标 dirty 后错误省略写入。
如果实现 modified 优化，还要验证恢复来源、目标缓冲区、权限/地址上下文等适用条件。

开放这些能力会改变客体实际执行的路径，验收要覆盖这些路径：

- Linux 内核在 XSAVE、XSAVEOPT、XSAVEC、XSAVES 中选最后一个可用的。开放 XSAVEC 后，
  每次上下文切换都用 XSAVEC 加压缩格式的 XRSTOR；开放 XSAVES 后，改用 XSAVES/XRSTORS。
- x86-64 glibc 的 ld.so 做惰性绑定时，有 XSAVEC 就用 xsavec，否则用 xsave。每个尚未解析的
  PLT 调用和 TLS descriptor 都会执行它，属于进程启动的热路径。

### 6.4 快照、复位、多核与迁移

布局改动从 `gen/state_layout.js` 生成，不直接手改 `global_pointers.rs` / `src/state_layout.js`。
新增字段能放入当前 4096 字节状态槽（`x64_mc_banks` 之后到 4096 还有约 1.6 KiB），但仍须
运行布局和 parallel relocation 检查，禁止依赖过时文档中的状态总大小。

`src/cpu.js` 当前快照范围按精确 `CORE_STATE_RANGES` 校验。`core_ranges()` 会跨空隙合并相邻的
core 字段，紧接在 2424 之后追加会把旧区间 [2056,2424] 撑大，旧快照随即校验失败。
YMM_Hi128、XCR0 和 XSS 应单独成为一个区间；建议在 `state_layout.js` 中引入显式分组，
不要靠插入非 core 字段来隔开。以下现有机制可以直接复用：

- 多核快照（版本 2）记录各区间，`set_machine_core_state` 对缺失区间填复位值，SMBASE
  （0x30000）就是这样处理的先例。XCR0=1 照此填写。
- 单核旧快照路径先把 1360 以上的 core 区间清零，再补写 PAT 和 SMBASE；XCR0=1 也要在这里补写。
- 老快照缺少新字段：按旧 CPU 能力恢复，YMM 高半初始化为零，XCR0 初始化为 1，XSS 为零。
  不能让通用“缺失字段填零”生成非法 XCR0。旧的 CR4 写入路径接受 OSXSAVE，旧快照里理论上
  可能出现 CR4.OSXSAVE=1，恢复时要按 CPU 配置校验。
- 新快照保存 CPU feature profile、每核 XCR0/YMM/XSS 及架构可见跟踪状态；恢复前完成
  profile、位图和状态范围验证，失败不能部分修改正在运行的 VM。
- 现在的 CPU 配置只是布尔值 `X64_TEST_CAPABILITIES`，cpu_type 也不进快照。应改为能力位图，
  存入顶层快照状态（做法同记录机器类型的 `state[103]`），并经 `copy_cpu_profile` 分发到并行实例。
- 缺少 feature profile 的旧快照，按恢复时 cpu_type 对应的旧能力集解释；不能因升级模拟器让恢复后的 OS
  突然看到新的 AVX 能力。新状态恢复到不支持的实现应清晰拒绝。
- 区分 reset、INIT、SIPI、软重启的架构状态规则，为 BSP/AP 分别测试，不能全部复用清零：
  - XCR0 和 IA32_XSS 只在 RESET 时复位（XCR0=1、XSS=0），INIT 保持不变；
    [KVM 按 SDM 也是这样实现的](https://patchew.org/linux/20220126034750.2495371-1-xiaoyao.li@intel.com/)。
    两者加入 `INIT_PRESERVED`，与 SMBASE 并列。
  - SDM 规定 INIT 不改变 x87/MMX/XMM/YMM/MXCSR，而 v86 现在的 INIT 会把它们取为复位值。
    YMM 按哪条规则处理由第 13 节 Q6 决定，建议连同 XMM、x87、MXCSR 一起按 SDM 修正。
- 同步 [`src/rust/cpu/context.rs`](../src/rust/cpu/context.rs)、
  [`src/parallel/machine.js`](../src/parallel/machine.js) 和 state streaming 的保存恢复。
- 每核使用不同 XMM/YMM/XCR0 指纹，覆盖单 Worker 调度、parallel Workers、暂停恢复、
  迁移到新 VM、故障重启和浏览器 worker 生命周期。

## 7. P3–P4b：SSSE3 与 SSE4

### 7.1 SSSE3 清单

| 类别 | 指令 |
| --- | --- |
| 字节排列/对齐 | PSHUFB、PALIGNR |
| 水平加减 | PHADDW、PHADDD、PHADDSW、PHSUBW、PHSUBD、PHSUBSW |
| 乘加/舍入乘法 | PMADDUBSW、PMULHRSW |
| 符号/绝对值 | PSIGNB/W/D、PABSB/W/D |

覆盖每条存在的 MMX 与 XMM 形式；MMX 与 x87 的别名、tag/状态转换必须正确。
重点测试 PSHUFB 高位清零、不同宽度的索引截断、PALIGNR 的全部 imm8、饱和边界、
最小负数绝对值、符号零值，以及 PMADDUBSW 的有符号/无符号输入组合。
PMULHRSW 按精确定义处理舍入与结果截取，不能套用通用饱和乘法。

### 7.2 SSE4.1 清单

| 类别 | 指令 |
| --- | --- |
| 混合 | BLENDPS/PD、BLENDVPS/PD、PBLENDW、PBLENDVB |
| 点积/舍入 | DPPS、DPPD、ROUNDPS/PD/SS/SD |
| 插入/提取 | INSERTPS、EXTRACTPS、PINSRB/D/Q、PEXTRB/W/D/Q 的 SSE4.1 编码形式 |
| 扩展 | PMOVSXBW/BD/BQ/WD/WQ/DQ、PMOVZXBW/BD/BQ/WD/WQ/DQ |
| 比较/打包 | PCMPEQQ、PACKUSDW、PTEST |
| 最大/最小 | PMAXSB/SD/UW/UD、PMINSB/SD/UW/UD |
| 乘法/规约 | PMULLD、PMULDQ、MPSADBW、PHMINPOSUW |
| 非临时读取 | MOVNTDQA |

显式区分新 PEXTRW 形式与已有形式，Q 形式的 long-mode 约束、GPR 宽度及零扩展单独测。
验证隐式 XMM0 mask、提取/插入立即数、窄内存源真实宽度、PTEST flags、PHMINPOSUW
最小位置规则，以及 MOVNTDQA 对齐和内存访问行为。

### 7.3 SSE4.2 与 POPCNT

- 实现 `PCMPESTRI/PCMPESTRM/PCMPISTRI/PCMPISTRM`：显式/隐式长度、byte/word、
  有/无符号、四类聚合、极性、有效元素和 mask/index 输出，覆盖全部 imm8。
- 测试长度为零、负长度、最小有符号长度、超出最大元素数、嵌入 NUL、无匹配/全匹配，
  以及 ECX/XMM0 与所有规定 flags 的修改。隐式结束符不允许改变固定内存操作数的访问要求。
- 实现 `PCMPGTQ` 有符号 64 位比较。
- 实现 CRC32 的合法 8/16/32/64 位源形式，使用 CRC-32C 的独立位级模型验证，
  不误用普通 IEEE CRC32；目的寄存器宽度、前缀及 flags 保持另测。
- POPCNT 已存在，但它是独立能力位；审计其 16/32/64 位形式和 flags，不用开启 SSE4.2
  替代它自己的门控。CRC32/POPCNT 不应套用 XMM 的任务切换检查。

### 7.4 浮点准确性是前置任务（P4a）

这项工作比 SSE4.1 本身更大。32 位引擎现有的 SSE/SSE2 浮点算术不设置 MXCSR 状态位，
不支持 RC/DAZ/FZ，也不产生 #XM（第 2 节）。SSE4.1 的 ROUND/DPPS 和 AVX 都要与旧 SSE
共享同一个正确的 MXCSR，因此必须改造全部现有 SSE/SSE2 浮点热路径，而 3DMark06 和游戏的
性能正取决于这些路径。所以单列为 P4a，并配独立的性能验收。

P0 先确定精度策略（第 13 节 Q2）：像默认开启的 `x87_fast_math` 那样保留一个快速模式，
还是默认精确、另设快路径。

P4a 同时修正 32 位引擎中 legacy SSE 的异常条件（3.3 节），新旧形式共用一个检查：CR4.OSFXSR=0
时 XMM 形式 #UD（原先只记日志）；要求对齐的 16 字节内存操作数未对齐时 #GP(0)（原先只有
ADDSUBPS/PD 和 P3 的 SSSE3 形式检查）。x64 引擎已经这样做，原先兼容模式下两个引擎因此不同。
这部分已在 P4a 第二部分完成（14 节）。

抽取 x64 已有 FP 处理（`vector.rs`，基于 SoftFloat）中的可复用部分，补齐所有目标指令用到的
f32/f64 操作、转换、比较、舍入及异常记录。可扩展当前 SoftFloat 接口，但不得通过中间
extF80 转换不经证明地替代所有 f32/f64 操作，避免双重舍入。

必测四种舍入方式、DAZ/FZ、正负零、subnormal、无穷、qNaN/sNaN、NaN 来源选择、
溢出/下溢/精度和未屏蔽异常。ROUND 的立即数控制和精度异常抑制、DPPS/DPPD 的
mask 与加法顺序独立实现。AVX 比较支持 32 种谓词，不能复用现有 `predicate & 7` 截断。

Wasm SIMD 仅在结果、NaN、舍入及 MXCSR 效果等价的条件下走快路径，其余进入公共准确
helper。快路径的准入条件：

- MXCSR 控制位是默认值：RC 为就近舍入，DAZ=FZ=0，异常全部屏蔽。
- 输入或结果出现 NaN、非规格化数、无穷或零时（可能引发 IE/DE/ZE/OE/UE），回退到精确 helper。
  实现（P4a）细化为：非规格化操作数，或者结果为 NaN、无穷时回退；MUL、DIV 和窄化转换的结果
  按舍入后判断为微小（绝对值不超过最小规格化数）时回退，除非它是零因子（被除数）得到的精确零。
  零操作数本身不回退。
- 状态位是粘滞的：PE 已置位时，可以省掉不精确检测；PE 未置位时，要么检测不精确，要么回退
  一次，回退之后 PE 就已置位。

旧 SSE 与新 VEX 混合执行同样需要共享正确的 MXCSR，不保留两套互相矛盾的行为。

## 8. P5–P6：AVX

按 P0 固定的 AVX 编码清单实现，以下是分组而非替代完整 forms 清单：

| 分组 | 实现范围与重点 |
| --- | --- |
| VEX.128 既有操作 | 架构定义的 SSE/SSE2/SSE3/SSSE3/SSE4 的 VEX 形式；不机械地给每条 legacy 指令加 V 前缀 |
| 数据传送 | 对齐/非对齐、标量、整数/浮点及非临时形式；加载/存储方向、寄存器别名与上半清零 |
| FP 运算与转换 | 合法 PS/PD/SS/SD 形式、水平运算、sqrt/rcp/rsqrt、转换及 32 比较谓词 |
| 广播/排列 | VBROADCASTSS/SD/F128、VPERMILPS/PD、VPERM2F128、VINSERTF128、VEXTRACTF128、混合/解包/洗牌 |
| 掩码与测试 | VMASKMOVPS/PD、VTESTPS/PD，以及合法 VEX PTEST 形式 |
| 控制与清零 | VLDMXCSR/VSTMXCSR、VZEROUPPER/VZEROALL |

P5 先完成 128 位与统一三操作数/上半策略，再在 P6 完成全部合法 256 位形式。
IR 解码器不知道 CPU 模式，总把寄存器形式的 C4/C5 解成 VEX（P1c）。VEX 行有了语义后，
IR 和 Tier-0 的代码要在运行时检查实模式和虚拟 8086 模式并 #UD，与解释器一致
（BMI1/BMI2 的 P10 同样需要）。
VEX.128 的许多整数形式属于 AVX，256 位整数扩展通常属于 AVX2；每个形式按能力定义
判断，不能仅凭 mnemonic 或目的宽度猜测。并非所有标量、点积和转换都存在 L=1 形式。

所有 source/destination 重叠组合都要测试。输入操作数先快照，之后才清高半或写目的；
标量上部位可能来自第一源，不能沿用 legacy destination-preserving 逻辑。
对 256 位 lane 内操作分别执行两个 128 位半区；跨半区的 insert/extract/permute 另有语义。

VMASKMOV 按活跃 lane 访存，被屏蔽 lane 不触发架构要求抑制的内存异常。
测试全零 mask、页边界、不可访问地址、零填充/保留结果和实际写入范围。
不能用一次整 32 字节 load/store 再做 mask 合并替代。被屏蔽 lane 所在页面是否设置 A/D 位
由实现决定：v86 固定一种行为（建议不设置），测试按允许结果判定；实际读写的页面必须设置 A/D 位。

RCP/RSQRT 等近似指令按规定误差及特殊值要求验收，不要求与某一型号硬件逐位相同；
规范唯一确定的精确结果和状态位采用逐位比较。DPPS 水平运算的部分 NaN 传播/位置等
实现相关结果使用允许结果集或 postcondition；v86 自身各后端仍保持确定且一致的结果。
参考 SDM Volume 2A 的 DPPS 条目（[合订本](https://cdrdv2-public.intel.com/835781/325462-sdm-vol-1-2abcd-3abcd-4.pdf)）。

## 9. P7–P8、P10–P11：AVX2 与 x86-64-v3 的其余指令

### 9.1 AVX2（P7–P8）

| 分组 | 覆盖要求 |
| --- | --- |
| 256 位整数 | 合法 VEX.256 加减、饱和、比较、逻辑、乘法、移位、打包/解包、水平运算、符号/绝对值和 shuffle |
| 扩展与广播 | VPMOVSX*/VPMOVZX*、VPBROADCASTB/W/D/Q、VBROADCASTI128，以及 AVX2 新增的寄存器源广播形式 |
| 排列与混合 | VPERMD、VPERMPS、VPERMQ、VPERMPD、VPERM2I128、VINSERTI128、VEXTRACTI128、VPBLENDD |
| 每元素移位 | VPSLLVD/Q、VPSRLVD/Q、VPSRAVD，含移位量超过元素宽度 |
| 掩码读写 | VPMASKMOVD/Q，包含 128/256 位形式和故障抑制 |
| Gather | VPGATHERDD/DQ/QD/QQ、VGATHERDPS/DPD/QPS/QPD 的全部合法形式 |

按指令区分 lane 内 shuffle/pack 与跨 256 位排列；不同元素/索引宽度导致的有效 lane 数、
未使用目的位和高半清零必须登记。特别覆盖 PSHUFB、PALIGNR、水平运算在 256 位下的
128 位 lane 边界，防止“把向量扩成 32 字节后全局操作”的错误实现。

Gather 独立开发和验收：

1. VSIB 解析、索引符号扩展、scale、地址大小与 FS/GS 基址正确；验证受限制的寄存器重叠。
2. 以 mask 指定的活跃元素读取，已完成元素更新目的并清除对应 mask 进度。
3. 在任意 lane 制造 #PF/#GP 等错误，验证从低序元素向高序元素交付故障的规则
   （right-to-left）、允许的提前完成、故障元素、mask 和 RIP。
4. 验证 mask 元素规范化、成功后 mask 清零，以及故障时目的/mask 的未使用位和高半状态；
   单独测试 16 位地址大小 #UD 和 gather 不产生 #AC 的规则。
5. 故障处理后重新执行，确认 v86 按其已提交的 mask 进度继续，不因执行引擎退出而重放已提交操作。
6. page tier/IR 使用专用慢路径或可恢复执行协议；不使用会重复已提交 lane 的整指令 RETRY。
7. 用访存计数器、不同页面权限和索引别名检查模拟器选定的访问策略；覆盖全部 mask 与不同宽度组合。

VMASKMOV/gather 的硬件访问顺序或次数并非统一保证，Intel 也不建议把它们用于 MMIO。
v86 对这些设备地址选择确定的逐 lane 行为，并用 MMIO 计数器检测实现内部的意外重复；
这是模拟器的行为约定和 RETRY 检查，不能作为“硬件保证每个元素恰好访问一次”的证明。
参考 [Intel SDM 的 gather 与 masked move 条目](https://cdrdv2-public.intel.com/835781/325462-sdm-vol-1-2abcd-3abcd-4.pdf)。

### 9.2 BMI1、BMI2、LZCNT 与 MOVBE（P10）

| 类别 | 指令 |
| --- | --- |
| BMI1 | ANDN、BEXTR、BLSI、BLSMSK、BLSR（VEX 编码）；TZCNT（`F3 0F BC`） |
| BMI2 | BZHI、MULX、PDEP、PEXT、RORX、SARX、SHLX、SHRX（VEX 编码） |
| LZCNT | LZCNT（`F3 0F BD`），只在 x64 配置开放 |
| MOVBE | MOVBE 加载/存储（`0F 38 F0/F1`，只有内存操作数） |

这些都是通用寄存器指令，只依赖 P1 的 VEX 与 `0F38`/`0F3A` 解码，不涉及 YMM、XSAVE 和 MXCSR：

- **标志位**：ANDN、BEXTR、BLSI、BLSMSK、BLSR、BZHI、TZCNT、LZCNT 写入规定的标志，
  其余标志未定义；MULX、PDEP、PEXT、RORX 和 SARX/SHLX/SHRX 不修改标志。未定义标志由 v86
  固定一种取值，测试按允许结果判定。新指令要接入各引擎现有的惰性标志机制：32 位引擎的
  `flags_changed`/`last_op1`/`last_result`，以及 x64 page tier 的惰性标志记录。
- **操作数宽度**：VEX.W1 在 64 位模式下选 64 位操作数，在非 64 位模式下被忽略。
  SARX/SHLX/SHRX 的移位量按操作数宽度取模；BEXTR 的起点/长度和 BZHI 的位置超出操作数宽度时，
  按 SDM 处理（BZHI 此时置 CF）。
- **MULX**：不修改标志，同时写两个目的寄存器；两个目的相同时，结果取乘积的高半部分。
- **TZCNT/LZCNT**：源为 0 时返回操作数宽度并置 CF。能力关闭时按 BSF/BSR 执行，保留现有
  BSF/BSR 在源为 0 时的行为（5.2 节）。
- **MOVBE**：只有内存形式；按操作数宽度做一次读或写再交换字节，不能拆成逐字节访问，也不能多读多写。
- **参考模型**：独立的位级模型覆盖全部宽度的边界值，包括 PDEP/PEXT 的全零/全一掩码、
  BEXTR/BZHI 的越界参数和 MULX 的最大乘数。

### 9.3 FMA 与 F16C（P11）

| 类别 | 指令 |
| --- | --- |
| FMA | VFMADD、VFMSUB、VFNMADD、VFNMSUB 的 132/213/231 形式（PS、PD、SS、SD）；VFMADDSUB、VFMSUBADD 的 132/213/231 形式（PS、PD） |
| F16C | VCVTPH2PS、VCVTPS2PH |

FMA 和 F16C 是 VEX 编码的 SIMD 指令，门控与 AVX 相同，并依赖 P4a 的精确 FP 核心：

- **FMA 的运算规则**：乘法和加法只舍入一次。VEX.W 区分单精度与双精度；132/213/231 决定
  哪两个操作数相乘、哪个相加，三种排列都要测试全部源/目的别名组合。目的寄存器同时也是源操作数：
  标量形式的 [127:32] 或 [127:64] 保留目的寄存器原值，而不是像其他 VEX 标量指令那样取自
  vvvv 源；[MAXVL-1:128] 清零。异常类型是 Type 2（向量）和 Type 3（标量）。
- **FMA 的精确路径**：复用捆绑的 SoftFloat 中已有的 `f32_mulAdd`/`f64_mulAdd`，DAZ/FZ 和 DE 由外层的
  MXCSR 包装处理（与 x64 `vector.rs` 的做法一致）。NaN 的来源选择、0×∞ 加 QNaN 时是否报 IE 等
  特殊值规则，按 SDM 在 SoftFloat 外层实现并逐条测试，不默认 SoftFloat 的 NaN 传播与 x86 一致。
- **FMA 的快路径**：Wasm 没有确定性的融合乘加，relaxed-simd 的 `madd` 可能融合也可能不融合，
  由宿主选定（同一环境中固定）。起初禁止使用；P12 第三部分（用户同意）改为启动时检测，宿主确实融合时
  Tier-0 与 page tier 用它计算 MXCSR 与操作数都准入的 lane，否则走以下的精确路径。单精度形式可以在 f64
  中算出精确乘积，以“舍入到奇数”求和后再舍入回 f32，理论上能给出正确舍入（Boldo–Melquiond）；但必须先
  在 P0 用穷举和随机对拍验证，才能作为快路径。双精度形式走 SoftFloat helper。P12 实现了双精度与单精度的
  快路径（`simd_fp::fused_fast`，双精度用 Boldo 与 Melquiond 的 FMA 模拟），以主机硬件 FMA 对拍 4000 万例
  验证，其中有专门构造的离舍入中点很近的用例（14 节 P12 第一部分）。
- **FMA 的性能**：glibc libm 在 FMA 和 AVX2 都可用时，会把 exp、log、pow、sin、cos、tan、atan
  等改用 `_fma` 变体（`ifunc-fma.h`）。所以 FMA 属于热点形式，性能按 12.2 节在新 profile 下单独测。
- **F16C**：VCVTPH2PS 把半精度转为单精度，结果精确。VCVTPS2PH 按 imm8[1:0] 选择舍入方式，
  imm8[2]=1 时改用 MXCSR.RC；它忽略 MXCSR.FTZ，下溢结果转为半精度非规格化数；DAZ=0 时可能报 DE。
  两者都要覆盖半精度的非规格化数、无穷、NaN（含 SNaN 静默化）和 MXCSR 标志，异常类型是 Type 11。
  精确路径可以复用 SoftFloat 的 `f16_to_f32`/`f32_to_f16`。
- **VCVTPS2PH 的写入宽度**：内存目的形式按 VEX.L 只写 8 或 16 字节；寄存器目的形式清零其余高位。

## 10. 编译后端与优化约束

每批语义进入解释器后立即接入其他执行路径：

- **Tier-0**：更新 SIMD 寄存器缓存、读写范围、成对 v128 和退出物化；helper 前后
  对 XMM/YMM/MXCSR 的失效规则一致。
- **IR region**：扩展 frontend、HIR/MIR lowering、状态映射、liveness、helper contract、
  continuation、scalar/SIMD backend。清高半是实际状态写入，必须参与数据流和死写消除。
- **x64 page tier**：先通过精确的 step/helper 路径获得完整可执行性，再为常见算术、传送、
  shuffle 和整数运算增加模板；覆盖 XMM/YMM8–15、RIP-relative、完整 64 位地址。
- **优化器**：禁止把可能引发异常的 FP/内存操作当作纯运算消除，禁止跨状态恢复、XSETBV、
  MXCSR 写入错误移动 SIMD 操作；跨半区依赖、mask 与 flags 一起纳入验证。
- **调度**：长 helper 的预算、IRQ/NMI 可见边界以及自修改代码失效沿用引擎约定；gather
  的部分进度和 xstate 恢复边界需要额外审查。

Wasm 快路径的已知陷阱，从 P0 起写进模板审查清单：

- PMULHRSW 不能直接用 `i16x8.q15mulr_sat_s`：-32768×-32768 时 x86 得到 0x8000，Wasm 会饱和为 0x7FFF。
- relaxed-simd 的结果因宿主而异，一般禁用。例外是 FMA：只在启动时检测到 `relaxed_madd`/`relaxed_nmadd`
  融合时使用，融合的乘加与 IEEE 754 的 fusedMultiplyAdd 一样只舍入一次（准入见 `native_fp::fused_refused`，
  P12 第三部分）。
- Wasm 浮点运算可能规范化 NaN，NaN 结果按现有做法回退。
- `trunc_sat` 的饱和结果与 x86 的整数不定值（0x80000000）不同。
- `pmin`/`pmax` 的操作数顺序要对应 x86 的规则：相等（含 ±0）或有 NaN 时返回第二操作数。
- 用 `i8x16.swizzle` 实现 PSHUFB 时，索引要先 `& 0x8F`。

x86-64-v3 通用寄存器指令的模板要点：

- Wasm 的 `clz`/`ctz` 在输入为 0 时返回位宽，与 LZCNT/TZCNT 一致，32/64 位形式可以直接映射；
  16 位形式要单独处理。
- PDEP/PEXT 没有对应的 Wasm 指令，用按掩码位循环的实现或 helper。
- 64 位 MULX 的 64×64→128 乘法要拆成部分积，或走 helper。
- MOVBE 的字节交换没有单条 Wasm 指令，用移位与掩码组合实现。

发布报告分别给出“完整语义覆盖”和“原生模板/内联覆盖”，避免所有指令都回退执行却被
误报为性能实现完成。复杂指令保留 helper 是允许的，只要语义、可恢复性和性能预算达标。

## 11. 测试与验收矩阵

### 11.1 独立参考与测试格式

复用 [`tests/rust/sse3.mjs`](../tests/rust/sse3.mjs) 的解释器/Tier-0/region 对照、
[`tests/rust/compiled_arms.mjs`](../tests/rust/compiled_arms.mjs) 的编译执行计数，
以及 [`tests/x64/vector_oracle.mjs`](../tests/x64/vector_oracle.mjs) 的外部客体参考方式。

- 整数/CRC/字符串/BMI 采用独立位级模型，避免直接把实现代码复制进测试。FMA 的参考不能
  与实现共用同一份 SoftFloat：在测试中用大整数或有理数精确算出乘加结果再舍入，作为独立参考。
- 使用可用的 x86 硬件结果、固定 QEMU TCG 版本和 SDM postconditions 交叉验证。
  现有 x64 oracle 已记录 QEMU 在部分 FP 异常/NaN 上的差异，不能单纯以 QEMU 为真值。
  QEMU TCG 支持 FMA、F16C、MOVBE、LZCNT（ABM）、BMI1 和 BMI2，可以作为这部分的参考。
  已知的 QEMU 缺口（2026-10-04 对照 QEMU master 核对）：
  - TCG 不支持 XSAVEC/XSAVES（`TCG_XSAVE_FEATURES` 的注释写明缺失）。这两项以及 XRSTORS
    只能依靠硬件或按 SDM 编写的模型判定。
  - QEMU 的 XSAVE/XRSTOR 只在 `rfbm & XSTATE_SSE_MASK` 时处理 MXCSR，而 SDM 规定的是
    RFBM[1] 或 RFBM[2]。“只请求 YMM”的用例必然与 QEMU 不符，需要预先登记一条 `QEMU_DEVIATIONS`。
  - XCR0 同时启用 SSE 和 YMM 后，QEMU 的寄存器转储从 `XMMnn=` 变为 `YMMnn=`；
    `tests/nasm/qemu_oracle.js` 现在只解析 `XMM0n=`，会直接失败。
  - 现有 oracle 用 `-cpu max`，会顺带开启 AES、PCLMUL、SHA、ADX 等范围外能力。依赖能力位的
    负例和 CPUID 用例，以及 TZCNT/LZCNT 回退为 BSF/BSR 的用例，要固定一个与 v86 CPU 配置一致的
    QEMU CPU 型号。
  - QEMU 对 VEX 编码的 SIMD 指令也检查 CR0.EM，而 SDM 的异常类型表只对传统 SSE 列出 CR0.EM。
    以硬件结果为准，登记后再决定是否加入 `QEMU_DEVIATIONS`。P5 第一部分确认 QEMU 10.2 给出
    #UD，v86 按 SDM 不检查；`tests/x64/avx.mjs` 已登记，仍待硬件判定。
  - P5 第一部分新发现（QEMU 10.2，均在 `tests/x64/avx.mjs` 登记）：
    - VMOVSS/VMOVSD（VEX.LIG）在 VEX.L=1 时按 256 位执行：寄存器之间时目的寄存器的 255:128 位
      取自第一源（VEX.vvvv），VMOVSD 从内存加载时保留原值，只有 VMOVSS 从内存加载时清零。
      SDM 的操作是 VEX.128 的，这些位应清零。
    - 非 64 位模式下 VZEROUPPER 也清零 YMM8–15 的高半（`gen_VZEROUPPER` 遍历 `CPU_NB_REGS`）。
      SDM 规定只修改 YMM0–7（3.2 节）。
    - VLDMXCSR 不检查 MXCSR 的保留位，不产生 #GP(0)，并把该值载入 MXCSR。
  - P5 第二部分新发现（QEMU 10.2，`tests/x64/avx.mjs` 登记）：
    - VPCMPESTRx 的 VEX.W1 形式与 legacy 的 REX.W 一样被忽略，长度仍取 EAX/EDX。
    - 非 64 位模式下 VPBLENDVB 的掩码寄存器取 imm8[7:4]；SDM（Vol. 2A 2.3 的 /is4）规定只用
      imm8[6:4]。
  - P5 第三部分新发现（QEMU 10.2）：VEX.L=1 的 VSQRTSS（VEX.LIG）产生 #UD；VROUNDSS 则使 QEMU
    自身中止（emit.c.inc 中 `gen_VROUNDSS` 的断言 `!s->vex_l`）。`tests/x64/avx.mjs` 对浮点的
    LIG 形式只用 VEX.L=0，VEX.L=1 由 32 位测试对照模型检查。
  - P5 第四部分新发现（QEMU 10.2，`tests/x64/vector_oracle.mjs` 对这几例按 SDM 单独判定）：
    VMASKMOVPS/PD 加载时读取整个 16 字节操作数，所以未选中的 lane 在缺页上也会 #PF，CR2 为
    页边界；存储时逐个 lane 写入，后面的 lane 故障时，前面的 lane 已经写出。SDM 规定未选中的
    lane 不产生故障；故障指令应恢复到执行前的状态（Vol. 3 6.5），不能留下部分存储。
  - P6 第一部分新发现（QEMU 10.2）：
    - 非 64 位模式下 VZEROALL 也清零 YMM8–15，与 VZEROUPPER 相同；SDM 规定只修改 YMM0–7。已在
      `tests/x64/avx.mjs` 登记。
    - 32 字节存储的高半区落在缺页上时，低半区已经写出。SDM 规定故障指令不留下部分存储。
      `tests/x64/vector_oracle.mjs` 对这一例按 SDM 单独判定。
  - P6 第二部分新发现（QEMU 10.2）：RCPPS/RSQRTPS（包括 VEX 形式）对非规格化的源给出精确的倒数
    或倒数平方根（不小于 2^63）；SDM 把非规格化的源当作 0.0，结果为 ±∞，v86 与模型都按此实现
    （P4a）。VEX.128 形式也有这一差别，只是用例增多后才遇到；`tests/x64/avx.mjs` 按偏差登记。
  - P10 新发现（QEMU 10.2）：VEX.vvvv 不是 1111b 的 RORX 不产生 #UD（SDM 规定没有该操作数时 VEX.vvvv
    必须为 1111b）。`tests/x64/bmi.mjs` 按偏差登记。
  - P11 新发现（QEMU 10.2，`tests/x64/fma.mjs` 按 SDM 判定）：VCVTPH2PS 对非规格化的半精度数报 DE，并在
    DAZ 下把它转为零（SDM 规定 DAZ 不起作用，也不报 DE）；VCVTPS2PH 在 FZ 下把过小的结果清零（SDM 规定
    FZ 不起作用，结果是半精度非规格化数）；未屏蔽的 SIMD 浮点异常不引发 #XM。FMA 的 NaN 优先次序、
    0 × ∞ 加 QNaN 不报 IE 等规则与模型一致。
- Apple Silicon 上可运行 QEMU oracle；没有原生 x86 参考时明确记录缺口，发布前在
  具备相应能力的 x86 测试环境补足需要硬件判定的案例。macOS 15 及以上版本的 Rosetta 2 支持
  AVX/AVX2（CPUID 不报告），可作为用户态整数语义的第三方交叉参考。它不是真值，也测不了
  特权指令、XSETBV 和 CPL0 下的 XSAVE；其余 x86-64-v3 指令在 Rosetta 2 下是否可用，要先探测。
- 规范允许多种结果的情形，一律按允许结果集或 postcondition 判定，并集中登记：
  - DPPS 的部分 NaN 传播、RCP/RSQRT 的近似值（第 8 节）；
  - XSAVE 写入的 XSTATE_BV：分量处于初始配置时 XINUSE 仍可为 1（SDM Vol. 1 13.6）。v86 按模式
    判定（非 64 位模式只看 YMM0–7 的高半），QEMU 不跟踪，始终为 1；
  - 开启对齐检查时，XSAVE/FXSAVE 未对齐报 #AC 还是 #GP；
  - CR4.OSFXSR=0 时，FXSAVE 是否写 XMM/MXCSR 区；
  - VMASKMOV 被屏蔽 lane 的 A/D 位；
  - gather 故障时，目的/mask 高位和更高序元素的状态；
  - BMI1/BMI2/LZCNT/TZCNT 未定义的标志位。
- 扩展 NASM fixture/GDB/QEMU stub 或新增版本化 guest record，包含所有可见 YMM、
  MXCSR、XCR0、EFLAGS、异常向量/错误码/IP、内存变化。旧 fixture 保持可读。
- AVX 客体初始化必须设置 CR4.OSXSAVE/XCR0，分别处理 CPL0 boot stub 与宿主用户态测试。
- 随机测试固定 seed，失败保存最小字节序列、初态、路径和预期结果，支持独立重放。

### 11.2 必测维度

| 维度 | 必测内容 |
| --- | --- |
| 模式 | real/protected 16/32、VM86、compatibility 16/32、long64；按各指令合法性验证执行或拒绝 |
| 编码 | legacy、VEX2/3、map、pp、W/L/vvvv、ModRM/SIB/VSIB、REX、imm8、非法组合与长度；能力开、关两种配置下的 TZCNT/LZCNT 与 BSF/BSR |
| 数据 | 全零/全一、符号边界、溢出/饱和、随机 lane、全 imm8；FP 特殊值和控制位组合 |
| 寄存器 | 源/目的全别名、隐式 XMM0、ECX/长度寄存器、0–7/8–15、YMM 高低半 |
| 内存 | 对齐/非对齐、真实访问宽度、跨页/跨段、权限、canonical 地址、高物理地址、MMIO、自修改代码 |
| 状态与异常 | CPUID/CR0/CR4/XCR0 组合、`cpuid_level` 降级、SMI/RSM、MXCSR、#UD/#NM/#XM/#GP/#SS/#AC/#PF、失败后的部分效果 |
| 执行路径 | 32 位解释器、Tier-0、regions、64 位解释器、page tier；有/无 Wasm SIMD；兼容模式下 32 位解释器与 x64 引擎的双引擎差分 |
| 生命周期 | reset/INIT/SIPI、每核切换、IR continuation、快照/流式快照、parallel Worker 恢复 |

全 imm8 测试适用于含立即数的目标形式；各模式按可达规则组织代表性组合，不以不可管理的
全部维度笛卡尔积替代有目的的测试。每项高风险交互仍必须有显式案例。

### 11.3 操作系统验收

- 基于已有 Linux x86/x86_64 客体，验证实际 CPUID→OSXSAVE→XSETBV→XSAVE 路径；
  加入进程/线程切换、signal/sigreturn、系统调用和线程跨核迁移的 YMM 指纹探针。
- 验证开放能力后，客体切换到的路径确实被执行且结果正确。这些路径包括：
  - 内核上下文切换所用的 XSAVE 变体，以及 ld.so 惰性绑定的 xsave/xsavec；
  - glibc IFUNC 选中的 `_sse42`、`_ssse3`、`_avx2` 变体，例如 `__strcmp_sse42`、`__strcspn_sse42`、
    `__memmove_ssse3`、`__strlen_avx2`、`__memmove_avx_unaligned_erms`。`_avx2` 字符串变体要求
    AVX2、BMI1、BMI2、LZCNT 同时可用（`ifunc-avx2.h`）；
  - libm 的 `_fma` 变体，要求 FMA 和 AVX2。

  同一组探针也用于 12.2 节的性能测量。
- x86-64-v3 整体验收：在 x64 Linux 客体中，`ld.so --help` 报告 `x86-64-v3 (supported, searched)`，
  `glibc-hwcaps/x86-64-v3` 下的库被实际加载；以 `-march=x86-64-v3` 编译的程序和要求 v3 的发行版
  用户态（例如 RHEL 10 系）能正常运行。
- 基于已有 Windows 8.1 x64 客体，验证 64 位和 WOW64 AVX 程序、线程/异常上下文保存、
  多核及快照恢复；不把桌面启动成功等同于 AVX 状态正确。
- 用明确编译选项构建 SSSE3/SSE4/AVX/AVX2/FMA/F16C/BMI/LZCNT/MOVBE 小程序，并检查产物
  实际包含目标指令。`-march=x86-64-v3` 只引入范围内的能力，可以使用；`-march=haswell` 这类
  整机配置会引入 AES、PCLMUL 等范围外能力，不能作为唯一探针。
- 正向探针之外，增加禁用 OSXSAVE/XCR0 的负例、旧 guest/旧快照回归，以及调度中途
  修改不同 vCPU 控制状态的测试。

### 11.4 已有检查入口

以下是当前已有目标，按改动阶段选取；本次仅写计划，未执行这些构建和运行测试：

```sh
make state-layout-check ir-generated-check platform-contract-tests
make ir-decoder-tests ir-decode-contract-tests ir-coverage-tests
make sse3-tests packed-simd-tests
make ir-simd-move-tests ir-simd-integer-tests ir-simd-immediate-tests
make ir-simd-shuffle-tests ir-simd-transfer-tests ir-simd-lane-tests ir-simd-masked-tests
make ir-sse-fp-tests ir-fp-state-tests ir-helper-audit ir-portable-tests
make nasmtests nasmtests-force-jit
make x64-decode-tests x64-system-tests x64-differential-tests
make x64-page-tier-tests x64-opcode-matrix-tests
make smp-tests multicore-coherence-tests multicore-state-tests
make multicore-parallel-tests multicore-parallel-tests-release
make multicore-parallel-browser-tests ir-backend-browser-tests
make x64-guest-tests x64-multicore-guest-tests
make bench-quick
```

**计划新增** `ssse3-tests`、`sse41-tests`、`sse42-tests`、`xsave-tests`、`avx-tests`、
`avx2-tests`、`bmi-tests`（含 LZCNT/TZCNT/MOVBE）、`fma-tests`、`f16c-tests`、`simd-xsave-tests`，
并接入 CI；这些名称当前不是可依赖的已有目标。实际（P12）：`ssse3-tests`、`sse4-tests`、`sse-fp-tests`、
`sse-fault-tests`、`xsave-tests`、`avx-tests`（含 AVX2 与 gather）、`bmi-tests`、`fma-tests`（含 F16C）、
`x64-glibc-tests`，及 IR 的 `ir-avx-tests`、`ir-bmi-tests` 等；发布等级见 `tools/release_gate.mjs`。CI 运行其中
确定性的一组（`isa-forms-check`、`platform-contract-tests`、`decode-rules-tests`、`ir-avx-tests`、`ir-bmi-tests`
与 BMI、FMA 的模型对拍）；x64 的 QEMU 对拍需要 QEMU 10.2，`avx-tests` 需要约一小时，留给发布门槛。
CI 分为快速确定性语义/解码检查与较长的差分、浏览器、OS 集成任务，合并与发布分别设 gate。
`make all-tests` 不能代替上述专项汇总。发布 gate 按 4.1 节的里程碑，在
[`tools/release_gate.mjs`](../tools/release_gate.mjs) 中增加 `R-SSE4`、`R-XSAVE`、`R-AVX`、
`R-x86-64-v3`、`R-XSAVE-ext` 等级，用法与现有的 `R-x64-UP`、`R-q35` 等等级一致。

## 12. 发布、性能和最终检查表

### 12.1 能力开放与兼容策略

内部开发可使用测试专用 feature mask；公共 CPUID 只在整个 ISA 的合法形式、异常和所有
执行入口通过后开放。SSSE3、SSE4.1、SSE4.2、基础 XSAVE、AVX、AVX2、FMA、F16C、BMI1、
BMI2、LZCNT、MOVBE 以及 XSAVE 家族扩展独立验收，并按 4.1 节的里程碑开放；AVX2、FMA 和
F16C 必须建立在完整 AVX/xstate 上。
开放之前还要满足 12.2 节的热点形式前提。

CPU feature profile 在 VM 创建时固定并保存到快照；不允许运行中从旧能力集升级到新能力集。
保留当前旧 profile 用于快照和回归，新建 VM 是否默认采用扩展 profile 在 P12 按兼容性结果
确定（第 13 节 Q1）。若增加公开配置，应同时更新 `v86.d.ts`、starter、CPU Worker 和文档，并拒绝不满足
依赖的能力组合。宿主 SIMD 快路径不可用不应偷偷缩减客体 profile。

更新并人工审核 [`tests/platform/cpu-contract.json`](../tests/platform/cpu-contract.json)，
包括 CPUID.0xD、OSXSAVE 动态变化、不同核数和两类 CPU profile。不能只刷新基线掩盖变化。
同步 `docs/x86-64.md` 的 CPU 能力表及相关 IR/多核说明。

### 12.2 性能预算

P0 固定旧 profile 的启动、整数、x87、SSE、代码生成大小/时间和多核基线。建议发布预算：
既有客体主要工作负载中位数回退不超过 5%，启动场景不超过 10%；超过时先分析和优化。
预算按 Q2 选定的默认精度策略测量，不能为了通过预算另开不准确路径。阈值和重复次数在 P0
与现有 benchmark 的噪声一起固定。

预算要在旧、新两套 profile 下分别测量。能力位开放后客体会切换代码路径（6.3、11.3 节），
同一工作负载转而执行新指令；这些形式如果在编译路径上只走 helper，开放能力反而会让现有
工作负载变慢。因此 5.1 节热点形式清单中属于某个里程碑的形式，必须先在 Tier-0 和 page tier
上有原生模板，该里程碑才能开放能力位。P4a 改造现有 SSE 浮点之后，也要在旧 profile 下
单独过一遍预算。

新 ISA 增加纯寄存器、访存、跨 lane、字符串比较、gather、FMA、位操作和 XSAVE 上下文切换基准，
分别报告解释器、编译路径、helper 占比、Wasm 大小与无 SIMD 构建。性能比较使用相同工作量，
不预设双 v128 实现的 AVX2 必然比 SSE 快两倍。

待改进（P4b 第四部分登记）：regions 中 ROUND 和 PCMPxSTRx 仍走完整 reload 的 SSE helper，比
Tier-0 的模板慢（14 节 P4b 第四部分的分层数据）。ROUND 的寄存器形式可沿用 regions 已有的原生
FP 准入（`NativeFp`）；PCMPxSTRI 不写 XMM，可改用只 reload 标量状态的 helper，或者为纯 helper
增加按值传递 v128 的 ABI。

待改进（P5 第六部分登记）：regions 中 VBROADCASTSS 与 VEX 浮点的内存形式走完整 reload 的
`ir_avx_continue`，每条 VEX 指令各有一个 `AvxCheck`（读五个状态字段）和一个 `YmmZero`；只用 regions
时 715.avx.matmul 比 601 慢 12 倍（14 节 P5 第六部分）。可把 VBROADCASTSS 原生化（加载后 splat，慢路径
另设 TransferOp），浮点内存形式改用只 reload 必要状态的 helper，并合并 region 内重复的检查与清零。

待改进（P6 登记）：VEX.256 的浮点形式在 Tier-0 中由解释器单步执行，在 page tier 中走 step；在
regions 中，VEX.256 形式都走完整 reload 的 `ir_avx_continue`。glibc 的 AVX（非 AVX2）热点只有搬运
与 VZEROALL，这些形式不在热点清单中；用 `-mprefer-vector-width=256` 编译的浮点代码会受影响。

待改进（P10 登记）：regions 中 BMI1/BMI2、TZCNT/LZCNT 与 MOVBE 走 `ir_bmi_reg_continue`/`ir_bmi_mem_continue`
（寄存器形式只 reload 标量状态）；Tier-0 和 page tier 有热点形式的模板，MULX、PDEP、PEXT、BEXTR、RORX
与 16 位形式在这两层仍单步执行。

待改进（P11 登记）：FMA 在 Tier-0 和 page tier 的模板调用 SoftFloat 的 helper（`ir_t0_fma`），
721.fma.poly 为 63 MIPS（单步执行时 17 MIPS）；单精度的“舍入到奇数”快路径要先按 9.3 节验证。regions
中 FMA 与 F16C 走完整 reload 的 `ir_avx_continue`，VEX.256 的 FMA 形式与 F16C 在 Tier-0 和 page tier
中单步执行。P12 第三部分：宿主的 relaxed 乘加融合时，Tier-0 与 page tier 的模板直接计算准入的 lane，
721.fma.poly 为 678 MIPS（关掉时 67 MIPS）；regions、VEX.256 的 FMA 与 F16C 仍如上。

P12 的测量（14 节 P12 第一部分）：x86-64-v3 下 Alpine 启动到登录与 x86-64-v2 相同；glibc 的字符串函数持平
或更快（strlen 与 3936 字节的 memcpy 快约 30%）；libm 的 `_fma` 版本比 SSE2 版本慢 1.3–2.1 倍（exp 1.28、
log 1.64、sin 2.06、pow 1.92），因为 FMA 在软件中精确计算，即使有快路径，每条仍约 20 ns，而 SSE2 的乘法和加法
在编译代码中各约 1 ns，libm 密集的负载因此超出预算。P12 第三部分（用户同意放开 9.3 节对 relaxed-simd 的
禁令）在宿主的 relaxed 乘加融合时直接计算 FMA，结果仍精确、各宿主一致：之后 x86-64-v3 下 exp、log、sin、pow
为 x86-64-v2 的 0.79、0.73、0.73、0.72 倍，预算达标；没有融合的 relaxed 乘加的宿主上仍是上述 1.3–2.1 倍。
测量中还发现 x64 解释器的 REP MOVS/STOS 跨页时逐元素复制，开放 AVX 后 glibc 的 memcpy、memset 更常走到
那里，已一并修正（14 节 P12 第一部分发现四）。

（P12 结束时的状态，依据见 14 节各阶段的记录。）

- [x] 机器可读 forms 清单完整，所有目标形式具有实现和独立测试归属，无未解释缺口。
  （814 个形式全部实现，`isa-forms-check`、`ir-coverage-tests` 检查；P11 后每个 VEX 行都有语义。）
- [x] SSSE3 MMX/XMM、SSE4.1/4.2、AVX/AVX2、FMA、F16C、BMI1、BMI2、LZCNT、MOVBE 的
  全部合法编码、模式和操作数形式完成。（P3–P11。）
- [x] x64 配置通过 x86-64-v3 检测：glibc 报告 x86-64-v3 受支持，要求 v3 的用户态正常运行。
  （P12：glibc 2.39 的 ld.so 报告 v3 受支持并装入 `glibc-hwcaps/x86-64-v3` 下以 `-march=x86-64-v3` 构建的库；
  glibc 的 v3 代码路径与 QEMU 结果相同。没有运行整套要求 v3 的发行版。）
- [x] 能力关闭时（包括 32 位配置中的 LZCNT），TZCNT/LZCNT 按 BSF/BSR 执行，与开放时的行为分别通过测试。（P10。）
- [x] 基础 XSAVE 及计划内家族扩展逐项完成；未实现的其他状态组件不被公布。（P2、P9；CPU contract。）
- [x] CR0/CR4/XCR0/CPUID 的能力检查和故障顺序在各引擎一致，并符合独立规范测试。（P1–P11。）
- [x] FP 舍入、NaN、MXCSR 和未屏蔽异常正确，近似指令按误差要求验收。（P4a–P11；P12 的 FMA 快路径另有主机
  硬件 FMA 的对拍。）
- [x] 普通访存、mask fault suppression、gather 部分完成/重启与 xstate 故障分别通过。（P2、P5、P6、P8、P9。）
- [x] 32 位解释器/Tier-0/regions、64 位解释器/page tier 及无 simd128 构建通过。（`avx-tests` 也在
  `v86-fallback.wasm` 上运行；P12 中 BMI、FMA 的模型测试同样在其上通过。）
- [x] 新旧快照、reset/INIT/SIPI、每核状态和 parallel Worker 生命周期通过。（P2 的 `xstate_lifecycle`；P12：
  Linux 探针运行中保存恢复、双核与 vCPU worker 的真实客体，Windows 探针 AVX 部分中的快照。）
- [x] Linux、Windows x64/WOW64 的实际 SIMD 上下文切换探针通过。（P12。）
- [x] 强制前缀和未列出前缀的规则在三个解码器中一致，兼容模式双引擎差分无分歧。（P1；`x64-differential-tests`。）
- [x] SMI/RSM、`cpuid_level` 降级和所有 CR0/CR4/XCR0 写入方的 JIT 门控测试通过。（P2、P5；`cpu_features.mjs`。）
- [x] 热点形式在编译路径上有原生模板，新旧 profile 下的性能预算都达标。（模板齐全，包括 P12 补上的内核
  SHA-2 形式；旧 profile 不受影响；新 profile 的启动与字符串函数达标，libm 的 FMA 版本在宿主的 relaxed 乘加
  融合时（P12 第三部分）快于 SSE2 版本。没有融合的 relaxed 乘加的宿主上，FMA 走精确的 helper，仍慢 1.3–2.1
  倍，见 12.2 节。）
- [x] 11.1 节的 QEMU 偏差逐条登记，并由硬件或 SDM 模型判定。
- [x] CPU contract、公开配置与文档一致，既有客体回归和性能预算达标。（旧 profile 的基准与客体回归不变；新
  profile 的 libm 见上一项。）

P12 之后，除新 profile 下 libm 的性能预算外各项均已满足；P12 第三部分用融合的 relaxed 乘加满足了这一项
（前提是宿主的 relaxed 乘加融合，以启动时的检测为准；本机 ARM64 上的 V8 是如此），本项目据此标为
“完整实现”。

达到以上条件才能将本项目标为“完整实现”；仅完成到某一阶段时，按已验收的 ISA 和
XSAVE 子能力报告进度，不将 AVX 基础、AVX2 普通算术或 XSAVE 指令占位称为全部完成。

## 13. 待决问题

以下问题在 P0 结束前给出结论（Q1 除外，它要等 P12 的兼容性结果），并把结论写回相应章节：

| 编号 | 问题 | 建议 |
| --- | --- | --- |
| Q1 | 新建 VM 默认采用哪个 CPU 配置 | **已定（2026-10-08，P12）**：默认保持旧配置，由用户用 `cpu_features` 显式开启。x86-64-v3 下 libm 的 FMA 版本慢于 SSE2 版本（12.2 节），而改变默认会改变已有客体和快照看到的 CPU。P12 第三部分之后，宿主的 relaxed 乘加融合时前一条理由不再成立，后一条仍在。**所有者 2026-10-17 改定**：`cpu_type: "x86_64"` 不给 `cpu_features` 时打开全部已开放的能力（x86-64-v3 加 XSAVE 家族），`cpu_type: "x86"` 仍为旧配置，`[]` 显式关闭；快照问题的处理：没有显式给 `cpu_features` 的机器恢复快照时采用快照的能力集，显式给了的仍拒绝不同的能力集 |
| Q2 | SSE/AVX 浮点的精度策略 | **已定（2026-10-04）**：默认精确，用 7.4 节的快路径准入保住性能；性能预算按这一策略测量。P4a 达不到预算时再重新讨论。P4a 结果（2026-10-05）：全套基准中位数不变，SSE 浮点四项 x0.72–0.89（14 节），待复核 |
| Q3 | 是否实现 XSAVES/XRSTORS | **已定（2026-10-04）**：实现，作为 M5 的最后一步，并对 Linux 的 XSAVES/XRSTORS 路径做完整验收 |
| Q4 | 公开配置的 API 形态 | **P0 采纳建议**：能力位图，外加 `x86-64-v2` 这类预设级别；不满足依赖的组合直接报错 |
| Q5 | 兼容模式由哪个引擎执行 | **P0 采纳建议**：共用解码与语义（3.1 节），并保留双引擎差分作为回归手段 |
| Q6 | INIT 是否保留 x87/XMM/YMM/MXCSR | **P0 采纳建议**：按 SDM 保留，与 XCR0/XSS 一起加入 `INIT_PRESERVED` |
| Q7 | 32 位配置是否开放 x86-64-v3 中的指令 | **已定（2026-10-04）**：开放 BMI1、BMI2、MOVBE、FMA 和 F16C，不开放 LZCNT。32 位配置的 CPUID 0x80000000 继续返回 5，旧系统看到的扩展 leaf 不变，`F3 0F BD` 继续按 BSR 执行。x86-64-v3 是否完整只看 x64 配置 |

### 13.1 风险与工作量初评

以下为初步估计，P0 按清单规模校准：

| 阶段 | 工作量 | 主要风险 |
| --- | --- | --- |
| P4a | 高 | 改动现有 SSE 浮点热路径，直接影响 3DMark06 和游戏的性能 |
| P5–P6 | 高 | 形式数量最多，并引入 YMM 状态 |
| P1 | 中 | 统一前缀规则会改变旧 `0F` 表的行为；需要三个解码器协同修改 |
| P8 | 中 | gather 的部分完成与重启语义，以及它与 RETRY 机制的交互 |
| P2、P9 | 中 | 操作系统上下文切换路径；QEMU 无法作为 XSAVEC/XSAVES 的参考 |
| P11 | 中 | Wasm 没有确定性的 FMA，精确与性能难以兼顾；libm 改用 `_fma` 变体后成为热点 |
| P3、P4b | 中低 | 形式多但语义规整；PCMPxSTRx 和 CRC32 需要独立的位级模型 |
| P10 | 中低 | TZCNT/LZCNT 的解码随能力位变化；要接入两套惰性标志机制；PDEP/PEXT/MULX 在 Wasm 中没有直接对应的指令 |

全部完成后，按项目惯例把本计划压缩进 [`docs/x86-64.md`](x86-64.md) 的 CPU 能力表和一份
新的 SIMD 设计文档，然后删除本计划。

## 14. 实施记录

### P0（2026-10-04，基线 `8d2b7c04`）

- **编码清单**：`tools/isa_forms` 用 iced-x86 1.21.0 生成 `gen/isa_forms.json`；`make isa-forms`
  重新生成，`make isa-forms-check` 校验它是否过期。共 814 个形式：SSSE3 32、SSE4.1 53、
  SSE4.2 12、POPCNT 3、XSAVE 6、XSAVEOPT 2、XSAVEC 2、XSAVES 4、AVX 390、AVX2 172、FMA 96、
  F16C 4、BMI1 13、BMI2 16、LZCNT 3、MOVBE 6。另有 370 个范围外的 VEX、`0F38`、`0F3A` 编码
  （`outside_scope`），只要求稳定地产生 #UD。
- **能力定义**：`gen/cpu_features.js` 记录 17 个能力的 CPUID 位置、依赖、可开放的配置和里程碑，
  并与 `gen/isa_forms.json` 和 CPU contract 交叉校验；目前没有任何计划内能力被报告。
- **热点形式**：`make isa-hot-forms` 用 iced 线性解码 Ubuntu 24.04 glibc 2.39
  （libc6_2.39-0ubuntu8.9_amd64.deb）的 libc、libm 和 ld.so，得到 120 个形式，写入
  `gen/isa_hot_forms.json`。按扩展分：AVX 68、AVX2 15、FMA 11、BMI1 7、BMI2 5、SSE4.1 3、
  XSAVE 3、SSSE3 2、LZCNT 2、MOVBE 2、SSE4.2 1、XSAVEC 1。用量最大的是 libm 的 VEX 标量
  双精度运算（VMOVSD、VMULSD、VADDSD、VSUBSD 各有数百到上千处），以及 libc 的 VPMOVMSKB 和
  VPCMPEQB（ymm）、TZCNT、PALIGNR、PCMPISTRI。
- **SDM**：325462-085US（2024 年 10 月，5237 页），见 1.2 节。
- **测试基线**：`platform-contract-tests`、`x64-decode-tests`、`ir-decoder-tests`、
  `ir-coverage-tests`、`sse3-tests`、`packed-simd-tests`、`ir-sse-fp-tests`、
  `ir-simd-integer-tests`、`ir-simd-shuffle-tests` 全部通过。
- **性能基线**：`make bench-quick` 在负载约为 5 的机器上运行（只作参考，例如 606.nbody.sse
  1444 MIPS、611.mandel.sse 1532、620.simd.sse 1757、621.simd.int 4460）。基线构建的
  `v86.wasm` 保存在本地的 `build/simd-xsave/p0-baseline/`（SHA-256 `be6b4283…`），后续对比
  用 `--baseline` 交错运行，不比较绝对数值。
- **决定**：Q2、Q3、Q7 已定；Q4、Q5、Q6 采纳建议；Q1 留到 P12。

### P1a：统一强制前缀规则（2026-10-04）

- `decode_rules::mandatory_variant` 成为三个解码器（32 位解释器生成器、IR 解码、x64 解码）共用的
  规则：F2/F3 优先于 66，F2/F3 并存时取最后一个（`apply_prefix` 不再累积两者）。在 SSE 映射中
  （表中有 `sse` 或 `refining` 行的操作码），没有对应行的强制前缀在读完 ModRM 后 #UD，
  不读 SIB、位移和立即数，也不做 CR0 检查；其他操作码里 F2/F3 只是被忽略的重复前缀。
- 行为变化（都与 iced-x86 一致）：`66 F3 0F 10` 等组合改为 MOVSS/MOVSD；`F2 66 0F 10` 由
  MOVUPD 改为 MOVSD；未列出的强制前缀在 32 位解释器、兼容模式中也 #UD（以前 release 构建执行
  无前缀形式，x64 只在 64 位模式 #UD）；`F2 F3` 重复前缀取后者（以前 debug 构建断言失败）。
- 表中新增 `refining` 标志：MOVNTI（`0F C3`）和 `0F 78`–`7B` 是强制前缀族但不是 SSE 指令。
- 测试：`tests/ir/decode/decode.rs` 和 `x64::decode` 的单元测试覆盖新规则；新增
  `make decode-rules-tests`（`tests/rust/decode_rules.mjs`），在解释器、Tier-0 和 regions 上
  验证 10 种 `0F 10` 前缀顺序、4 种 CMPSB 重复前缀顺序、8 个未定义强制前缀的 #UD 位置。
  x64 长模式 opcode 矩阵与 iced 的对拍不变（349888 行，iced 判为合法的 123947 行一致）。

### P1e：能力位图（2026-10-04）

- `gen/cpu_features.js` 生成 `src/rust/cpu/features.rs` 的常量（每个能力一位、依赖、CPUID 位置、
  最低 `cpuid_level`、只属于 x86-64 配置的能力）和 `src/cpu_features.js`（供设置解析）。
- 机器级静态变量 `features::FEATURES` 在创建时固定，并经 `copy_cpu_profile` 复制到并行实例；
  CPUID 的叶 1、7、0x80000001 和 0xD.1 按它报告。叶 7 和 0xD 区分子叶，其他叶忽略 ECX。
- 内部设置 `cpu_features`（`starter.js`、CPU worker 透传）：能力名数组，或预设
  `x86-64-v2`、`x86-64-v3`。未知能力、配置不允许的能力（32 位配置的 LZCNT）和缺少依赖时报错；
  `cpuid_level` 报告不了的能力连同依赖它的能力一起去掉（`cpuid_level` 为 7 时去掉 XSAVE、AVX、
  AVX2、FMA、F16C；为 2 时再去掉 BMI1、BMI2）。
- 测试：`tests/x64/cpu_features.mjs`（并入 `make platform-contract-tests`）；`cargo test
  cpu::features`；默认配置的 CPU contract 不变。

### P1b：三字节映射（2026-10-04）

- `gen/x86_table.js` 新增 88 行 `0F38`/`0F3A`：SSSE3 32 行（无前缀的 MMX 形式和 66 的 XMM 形式，
  含 PALIGNR）、SSE4.1 47 行、SSE4.2 5 行（PCMPGTQ 和四条 PCMPxSTRx）、MOVBE 2 行、CRC32 2 行。
  每行带所属能力（`feature`）；尚未实现的行带 `unimplemented`，在读完 ModRM 后 #UD，不读 SIB、
  位移和立即数。`0F 38`、`0F 3A` 本身是 `escape` 行。`node gen/cpu_features.js --check` 校验这些
  行与 `gen/isa_forms.json` 的 legacy 形式一一对应。
- 三个解码器都读第三个 opcode 字节，编码键为 `0x0F38xx`/`0x0F3Axx`（强制前缀在 24–31 位）：
  32 位解释器由生成器产生 `interpreter0f38.rs`、`interpreter0f3a.rs`，`instr_0F38`/`instr_0F3A`
  按操作码字节分派；IR 解码目录 `encodings.rs` 增至 1021 个编码；x64 解码器和 `base_opcode`
  识别这两个映射。`0F 39`、`0F 3B`–`3F` 仍在第二个字节 #UD。以前 `0F 38`/`0F 3A` 在第二个字节
  #UD；现在先读第三字节和 ModRM，这两个字节上的取指故障优先于 #UD。
- 能力门控：能力未开放的行视为不存在。表中的 `refining` 区分两类映射：SSE 映射里 66/F2/F3
  都选择指令；MOVBE/CRC32 只有 F2/F3 选择指令，66 是操作数大小。因此 `F3 0F 38 F0` #UD，
  `66 0F 38 F1` 是 16 位 MOVBE，`66 F2 0F 38 F1` 是 CRC32 r32, r/m16。
- 测试：IR 解码单元测试 `three_byte_maps_decode_and_stay_undefined_until_implemented` 遍历
  全部三字节编码，在能力全关和全开时检查长度与提前 #UD；x64 单元测试在三种模式下检查同样的
  行为；`decode_rules.mjs` 在解释器、Tier-0 和 regions 上验证 13 个三字节编码在开不开能力时
  都 #UD。回归：`nasmtests` 15629/15629，x64 opcode 矩阵与 iced 对拍不变，P0 列出的其余目标
  和 `make rust-test` 全部通过。P1a 漏改的单元测试 `rep_contract_and_progress_maps`（仍要求
  debug 构建拒绝 `F2 F3` 重复前缀）在此更新。

### P1c：VEX 解码（2026-10-04）

- **VEX 行**：`gen/vex_table.js` 从 `gen/isa_forms.json` 为 688 个 VEX 形式各生成一行，键为
  `0xC4_MM_PP_OO`（map 1–3、pp、opcode）。每行记录接受的 VEX 字段与操作数编码：VEX.L、VEX.W
  （WIG32：W 只在 64 位模式有效）、vvvv 是否为操作数（否则必须为 1111b）、只在 64 位模式、
  is4、VSIB、gather 的寄存器互异要求、GPR 指令（BMI1/BMI2，异常类型 13，不要求 AVX 状态），
  以及只有寄存器或只有内存形式。生成时检查任一编码最多被一行接受。IR 目录增至 1711 个编码；
  测试用的 `FORMS` 表给出每个 VEX 行对应的 iced-x86 形式名。
- **共用规则**（`decode_rules`）：`is_vex`（64 位模式总是 VEX，其他模式看下一字节的 bits 7:6
  是否为 11b）、`Vex` 字段解码、`vex_row`（按 ModRM.reg 组、寄存器/内存形式、L、W、模式选行）、
  `vex_valid`（vvvv、VSIB 要求 SIB 且不能是 16 位寻址）、`vex_prefixes_ud`。三个解码器都调用
  它们：32 位解释器经 LES/LDS 寄存器形式进入 `cpu/vex.rs`；IR 解码器的 `decode_vex`；x64 解码器
  的 `decode_vex`（64 位模式下 VEX.R/X/B 扩展寄存器，W1 行的通用寄存器操作数为 64 位）。
- **#UD 位置**（三个解码器一致）：VEX 前有 66、F2、F3、LOCK 或 REX，在 VEX 第一个字节后 #UD；
  保留 map 和没有行的键，在 opcode 字节后 #UD；没有行接受这些字段、能力缺失或尚无语义，在
  ModRM 后 #UD；gather 的目的、索引、掩码寄存器重复，在 SIB 后 #UD。实模式和虚拟 8086 模式
  没有 VEX，C4/C5 的寄存器形式仍是 LES/LDS 的 #UD；IR 解码器不知道模式，VEX 行有语义后需要
  运行时模式检查（P5）。取指故障先于 #UD，只取解码需要的字节。
- **与 iced 的分歧**：16/32 位模式下三字节 VEX 第 2 字节的 bit 6（vvvv 最高位）按 SDM 2.3.5.6
  忽略，也不参与“必须为 1111b”的检查（QEMU 相同）；iced 仍要求它为 1。P1d 的差分登记这一项。
- **TZCNT/LZCNT**：表中 `F3 0F BC`、`F3 0F BD` 两行分别属于 BMI1 和 LZCNT。没有能力时 F3 被
  忽略，按 BSF/BSR 执行；有能力时在 P10 之前 #UD。
- **测试**：只在 cargo test 中有效的 `TEST_DECODE_UNIMPLEMENTED` 让解码器把尚无语义的行当作已
  实现，用来检查长度、操作数和拒绝条件。IR 解码与 x64 解码的单元测试从每个 VEX 行自己的编码
  解出该行（x64 覆盖三种模式），并检查 L/W/vvvv 改变后的选行、VSIB、prefix 和取指顺序。
  `tests/ir/decode/vex_modes.mjs` 在实模式、虚拟 8086、16/32 位保护模式下单步解释器，覆盖
  LES/LDS、VEX 与取指故障顺序；`decode_rules.mjs` 在解释器、Tier-0 和 regions 上验证 12 个 VEX
  编码、LES/LDS 内存形式以及 TZCNT/LZCNT 的两种行为。IR 的 far-control 夹具去掉了寄存器形式的
  LES/LDS（它们现在是 VEX 前缀），invalid-form 夹具跳过 VEX 行。
- **回归**：`make rust-test`（361 个）、`x64-decode-tests`、opcode 矩阵（不变）、`nasmtests`
  15629/15629、`ir-decode-contract-tests`、`ir-tier0-tests`、`ir-differential-tests` 和
  `decode-rules-tests` 等全部通过。`ir-segment-tests` 的 `segments.mjs:93`（描述符 accessed 位
  写故障应当陷出编译代码）失败，在本计划开始前的 `8d2b7c04` 上同样失败，与本计划无关，另行
  处理。P1a–P1b 留下的 rustfmt 差异一并修正，`gen/cpu_features.js` 生成的数组加
  `#[rustfmt::skip]`。

### P1d：与 iced-x86 的解码差分（2026-10-04）

- `tests/decode/simd_corpus.rs`（`cargo test simd_corpus`，并入 `make x64-decode-tests`）在
  16、32、64 位模式下生成 1705444 个编码：map 1–3 的每个 C4 opcode 配合各 pp，以及 VEX.L、W、
  vvvv（低位和最高位）、R/X/B 的组合；C5 形式；保留 map；VEX 前的 66/F2/F3/LOCK/段/67/REX；
  `0F 38`、`0F 3A` 和 `0F BC/BD` 的强制前缀顺序（64 位模式另加 REX.W）。每个编码配 8 个
  ModRM（各 ModRM.reg 的寄存器和内存形式，内存形式带 VSIB 可用的 SIB）。
- 打开全部能力、把尚无语义的行当作已实现时，x64 解码器认可其中 133550 个。16/32 位模式下 IR
  解码器对全部 1082120 个编码给出相同的行和长度，#UD 时与 x64 解码器取到的字节数相同（提前
  #UD 的位置一致）。关闭能力，或打开能力但没有语义（发布时的情形）时，VEX 和三字节映射的
  编码全部 #UD，`F3 0F BC/BD` 在没有 BMI1/LZCNT 时执行 BSF/BSR。
- `tests/x64/oracle` 用 iced-x86 1.21.0 解码同一批编码，比较有效性（iced 有效且所需 CPUID
  能力都在本计划或基线之内）、长度和 VEX 形式名，全部一致。唯一登记的分歧是 2916 个 16/32 位
  三字节 VEX 编码：vvvv 最高位为 0，SDM 2.3.5.6 说忽略，iced 判为无效；把这一位改成 1 后，
  iced 解出的形式和长度与 v86 相同。
- 兼容模式下两个引擎的执行差分（第 2 节末）随各阶段的语义一起做：目前所有新形式都在两边
  #UD，位置由上面的解码一致性保证。

### P2：XCR0、YMM 高半与基础 XSAVE/XRSTOR（2026-10-04）

- **状态**：`gen/state_layout.js` 新增每核 `xcr0`、`xss` 和 `ymm_hi`（16 个 128 位），自成快照区间
  [2432, 2704]。字段可以声明 `range`，不同 range 的字段不合并成一个区间。旧快照缺这一区间时，
  XCR0 填 1、其余为 0，多核快照和单核旧快照两条路径都这样处理。字段还可标 `init: "keep"`，由此生成
  `INIT_PRESERVED`：INIT 保留 x87、MMX/XMM、MXCSR、YMM 高半、XCR0 和 XSS（Q6），以及原有的
  PAT、MTRR、机器检查寄存器和 SMBASE。`cpu.js` 与并行 vCPU worker 共用这份列表（worker 以前
  漏了 SMBASE）。RESET 时 XCR0 为 1。
- **CPUID**：叶 1 ECX[26] 报告 XSAVE，[27] 的 OSXSAVE 随 CR4。叶 0xD 子叶 0 报告支持的 XCR0
  （没有 AVX 时为 3，有时为 7）、当前 XCR0 和全部支持分量各自所需的标准格式大小（576 或 832）；
  子叶 2 报告 YMM_Hi128 的大小和偏移；其他子叶为零。
- **CR4**：legacy 和 x64 的 MOV CR4 以及 RSM 共用 `cr4_valid_bits()`：VME 至 OSXMMEXCPT，
  OSXSAVE 只在有 XSAVE 时允许。legacy 路径不再接受 CPUID 没有报告的 VMXE、SMXE、PCIDE、SMEP、
  SMAP 等位。RSM 恢复到带保留位的 CR4 时进入 shutdown。
- **XGETBV/XSETBV**（`0F 01 D0/D1`）在三条执行路径都已实现。没有 CR4.OSXSAVE 或带 66/F2/F3 前缀时
  #UD。XSETBV 只接受 XCR0，值必须包含 x87、只含支持的分量、YMM 必须同时有 SSE，CPL>0 时 #GP。
  XGETBV(1) 在 P9 之前 #GP。XSETBV 会推进 IR 的准入版本。
- **XSAVE/XRSTOR**（`0F AE /4`、`/5`；64 位模式下带 REX.W 为 XSAVE64/XRSTOR64）使用共用的
  编解码 `cpu/xstate.rs`，只支持标准格式：
  - 按所请求的分量逐字段存取，不写保留字节和 464–511 字节；64 位模式外不碰 XMM8–15 和
    YMM8_H–15_H。
  - XINUSE 按 SDM 13.6 定义的初始配置精确计算；RFBM[1] 或 [2] 为 1 时存取 MXCSR。
  - XRSTOR 检查 XCOMP_BV[63]、头部字节 8–23、XSTATE_BV 是否超出 XCR0，以及 MXCSR 保留位。
  - 每个执行引擎实现 `Area`：32 位解释器和 IR helper（`ir_xsave`、`ir_xrstor`）按线性地址访存，
    x64 引擎用自己的访存函数。所有字段先检查页故障再搬运数据，故障时内存和状态都不变。
  - 异常顺序：#UD（OSXSAVE），#NM（CR0.TS），然后才是操作数的段检查，接着 #GP（64 字节对齐），
    最后 #PF。32 位解释器为此让 XSAVE/XRSTOR 自己解析操作数地址（`custom_modrm_resolve`）；
    IR 的 coverage 差分发现过这一顺序与 IR helper 不一致。
- **`0F AE` 改为 refining**：66/F2/F3 在这一组选择 CLFLUSHOPT、RDFSBASE、PTWRITE、INCSSP 等
  本机没有的指令，所以都在 ModRM 后 #UD，与 iced 一致。
- **FXSAVE/FXRSTOR** 也改用共用编解码。32 位执行路径未对齐时 #GP，以前只有 `dbg_assert`。
  x64 的 FXSAVE 不再写 464–511 字节（以前写出整个 512 字节零缓冲区）。64 位模式外只存取 XMM0–7。
- **快照**：顶层 `state[106]` 记录 CPU 能力位图。恢复到能力不同的机器时，在修改任何状态之前报错；
  旧快照按没有计划内能力处理。同时修复 `set_state` 的一个旧缺陷：它把 `last_result`、
  `fpu_status_word`、`mxcsr` 的内存视图换成了快照里的数组，恢复后 JS 读到的是过期值。
- **测试**：
  - `make xsave-tests`：
    - `tests/rust/xsave.mjs` 在解释器、Tier-0 和 regions 上覆盖 CPUID、CR4、XGETBV/XSETBV、
      往返、部分保存、初始化、各种异常、页故障无部分效果，以及不访问未请求分量的位置。
    - `tests/x64/xsave.mjs` 覆盖 64 位模式和兼容模式下的格式，以及 x64 引擎的 9 种异常，
      解释执行和 page tier 各跑一遍。
    - `tests/smp/xstate_lifecycle.mjs` 覆盖快照、INIT、RESET、旧快照和能力校验。
  - `cargo test cpu::xstate`。
  - IR fp_state 差分扩展到 XSAVE/XRSTOR，共 392 个用例：OSXSAVE、TS、空段的先后顺序，MMIO，
    以及跨页 #PF。
  - `tests/devices/smm.js` 新增 SMI/RSM 用例。
  - `make kvm-unit-test-xsave`：kvm-unit-tests 的 x86/xsave（x86_64 构建）在无能力、XSAVE、
    XSAVE+AVX 三种配置下分别通过 4、15、17 项。为此，构建脚本不再把 clang 对该库的 format 和
    constant-conversion 警告当作错误。
- **客体**：Alpine x86_64（virt 内核，单核，page tier）在 `cpu_features: ["XSAVE"]` 下启动到 shell，
  并通过 64 位和 32 位探针。内核报告 "Enabled xstate features 0x3, context size is 576 bytes,
  using 'standard' format"，上下文切换使用 XSAVE/XRSTOR。
- **回归**：`make rust-test`、`x64-decode-tests`、opcode 矩阵、`nasmtests`、`ir-decode-contract-tests`、
  `ir-coverage-tests`、`ir-fp-state-tests`、`ir-tier0-tests`、`ir-differential-tests`、`sse3-tests`、
  `packed-simd-tests`、`ir-sse-fp-tests`、`x64-system-tests`、`smp-tests`、`api-tests`、
  `q35-device-tests`、`kvm-unit-test`、`decode-rules-tests` 和 `platform-contract-tests` 全部通过。
- **事后修正（P3 期间）**：P2 的回归没有包括 `x64-differential-tests` 和 `x64-page-tier-tests`。
  它们发现 x64 引擎的 FXSAVE/FXRSTOR（与 XSAVE 共用 `Area`）在保存区跨入缺页时，#PF 的 CR2
  指向越界字段的最后一个字节，而不是缺页的第一个字节。现已与 32 位路径和 QEMU 一致，修正单独提交。

### P3：SSSE3（2026-10-04）

- **语义**：`src/rust/cpu/simd_int.rs` 是公共的打包整数语义：输入输出都是字节向量，不读写 CPU
  状态。MMX 形式为 8 字节，XMM 形式为 16 字节，VEX.256 以后按 128 位 lane 复用。覆盖 16 条指令：
  PSHUFB、PHADDW/D/SW、PMADDUBSW、PHSUBW/D/SW、PSIGNB/W/D、PMULHRSW、PABSB/W/D、PALIGNR。
  单元测试覆盖：PSHUFB 的 bit 7 清零和索引截断（MMX 取低 3 位，XMM 取低 4 位）、饱和边界、
  最小负数的取反和绝对值、PMULHRSW 的舍入、PMADDUBSW 的无符号×有符号组合，以及 PALIGNR 的
  全部 imm8。
- **32 位解释器**：`instructions_0f38.rs`、`instructions_0f3a.rs` 按生成器的命名提供各形式。
  32 行 SSSE3 去掉 `unimplemented` 和 `skip`（后者让它们进入 nasm 测试）。
  - 没有 SSSE3 时 #UD，先于 #NM；F2/F3 前缀 #UD。
  - XMM 形式的内存操作数未按 16 字节对齐时 #GP(0)（异常类型 4），与已有的 ADDSUBPS/PD 相同，
    新增 `safe_read128s_aligned`。MMX 形式没有对齐要求。
  - MMX 形式按 MMX 规则改写 x87 状态：目的寄存器的指数为全 1，TOP 为 0，标记全有效；内存故障时
    x87 状态不变。
- **IR**：
  - Tier-0 对 PSHUFB 和 PALIGNR 有原生模板（`i8x16.swizzle`、`i8x16.shuffle`），覆盖 MMX 和
    XMM、寄存器源和内存源。XMM 内存操作数未对齐时重试，由解释器产生 #GP。其余 SSSE3 形式
    逐条交给解释器执行（`ir_t0_step`）。
  - regions 对 PSHUFB、PALIGNR 的寄存器形式原生翻译：PSHUFB 是 `PackedOp::ShuffleBytes`，
    PALIGNR 是 `VectorShuffle`，移出源寄存器时与零向量 shuffle。其余形式以及这两条的内存形式经
    helper：MMX 形式走 `ir_mmx_*`；XMM 形式走 SSE helper（`ir_sse_fp_*`），寄存器形式在审计
    名单内，调用后只重新载入目的 XMM。
  - Tier-0、regions 和 page tier 的 PALIGNR shuffle lane 都来自 `simd_int::palignr_lanes`。
- **x64**：`x64/vector.rs` 执行全部 MMX/XMM 形式；64 位模式下可用 XMM8–15，MMX 寄存器忽略
  REX。page tier 对 PSHUFB、PALIGNR 的 XMM 形式有原生模板，其他形式逐条解释（Step）。兼容
  模式下两个引擎都执行 SSSE3，测试中与 QEMU 一致，包括编译后的兼容模式代码。
- **热点形式（5.1 节）**：SSSE3 的两个热点形式 PALIGNR xmm、PSHUFB xmm 在 Tier-0、regions
  （寄存器形式）和 page tier 上都是原生代码。一个 PSHUFB+PALIGNR 循环的速度：解释器 32 MIPS，
  Tier-0 531 MIPS，regions 381 MIPS。只走 helper 的 PMADDUBSW+PHADDW 循环为 20–33 MIPS，
  它们的性能留到 P12。
- **测试**：
  - `make ssse3-tests`：
    - `tests/rust/ssse3.mjs` 以 `tests/rust/ssse3_model.mjs` 为准。该模型按 SDM 伪代码独立
      编写，不调用 `simd_int.rs`。在解释器、Tier-0、regions 上运行全部 32 个形式，共 2432 例：
      寄存器源和内存源、目的即源、PALIGNR 全部 256 个 imm8。另外覆盖 MMX 的 x87 转换，
      #UD/#NM/#GP/#PF 及故障时目的寄存器不变，并检查 Tier-0 确实执行了 PSHUFB/PALIGNR 模板。
      分别在 Wasm SIMD、debug 和无 SIMD 构建上运行。
    - `tests/x64/ssse3.mjs` 覆盖 64 位模式和兼容模式下的 285 例和 8 种故障，结果与 QEMU 和模型
      都一致。分别以解释执行、page tier、page tier 加兼容模式 JIT 运行，并检查 page tier 模板
      确实执行（热循环中 69.8 万条指令原生退休，只有 3 次 step）。
  - nasm：`create_tests.js` 支持三字节映射，新增 320 个 SSSE3 测试，QEMU fixture 全部通过；
    `run.js` 打开 SSSE3。
  - IR：MMX 和 SSE helper 的 fixture 差分包含 SSSE3 形式，差分所用机器打开了 SSSE3。
    `mir_value` 检查 PSHUFB/PALIGNR 的寄存器形式原生、内存形式走 helper。Tier-0 fuzz 新增
    SSSE3 类别（`FUZZ_KIND=s10`）。
  - 解码：x64 和 IR 的解码测试改用 SSE4.1 行作为“未实现”的例子，并新增 SSSE3 行的解码测试。
    `decode_rules.mjs` 中 SSSE3 只在没有能力时 #UD。P1d 语料的约定改为：有能力时，只有已实现
    的行可以解出。
- **回归**：`ssse3-tests`、`rust-test`、`x64-decode-tests`、`ir-decoder-tests`、
  `ir-decode-contract-tests`、`decode-rules-tests`、`ir-mmx-tests`、`ir-sse-fp-tests`、
  `ir-coverage-tests`、`ir-fp-state-tests`、`ir-tier0-tests`、`ir-differential-tests`、
  `ir-simd-integer-tests`、`ir-simd-shuffle-tests`、`packed-simd-tests`、`sse3-tests`、`xsave-tests`、
  `x64-system-tests`、opcode 矩阵、`x64-differential-tests`、`x64-page-tier-tests`、`nasmtests`、
  `nasmtests-force-jit`、`kvm-unit-test`、`smp-tests`、`api-tests` 和 `platform-contract-tests`
  全部通过。`q35-device-tests` 中 `tests/devices/smm.js` 的两个 x86-64 用例偶发失败；计划开始前的
  `8d2b7c04` 上同样如此（6 次中失败 2 次），与本计划无关，已另立任务。
- **遗留**：
  - 32 位路径的 legacy SSE 在 CR4.OSFXSR=0 时仍只记日志，旧形式也不查对齐（3.3 节）。SSSE3
    与旧形式共用前一项检查，两项一并在 P4a 修正（7.4 节）。已在 P4a 第二部分修正。
  - MMX 形式不因 x87 未决异常产生 #MF，与现有 MMX 形式一致。

### P4a：精确的 SSE 浮点（2026-10-05）

本节记录 P4a 的第一部分：32 位引擎的 SSE/SSE2/SSE3 浮点改为精确实现。legacy SSE 的
OSFXSR 和对齐检查（3.3 节）是第二部分，单独提交。

- **公共核心**：`src/rust/cpu/simd_fp.rs` 实现全部 SSE 浮点形式的精确语义，32 位解释器、
  regions 的 helper 和 x64 解释器（`x64/vector.rs`，删去了它自己的一份）共用：
  - SoftFloat 的 8086-SSE 规则：x86 的 NaN 选择，舍入后判断微小。
  - MXCSR：RC，DAZ，FZ（只在 UM 屏蔽时），粘滞的状态位。异常顺序按 SDM 第 1 卷 11.5.3 节：
    运算前的异常（IE、DE、ZE）未屏蔽时直接产生故障，不再置运算后的状态位；然后才是 OE、UE、PE。
    产生故障时目的寄存器不变。同一 lane 中，QNaN 操作数、无效运算和 ZE 优先于 DE。UE 未屏蔽时，
    任何微小结果都产生异常，即使结果精确。
  - 微小按舍入后判断，取 SoftFloat 的 underflow 标志：不精确且舍入后进到最小规格化数的乘积
    或商也算微小（UE；FZ 时清零）。测试新加的边界值发现了这个问题，同时修正了核心和两条快路径。
  - 未屏蔽的异常：CR4.OSXMMEXCPT=1 时 #XM（向量 19），否则 #UD。
  - 覆盖 ADD/SUB/MUL/DIV/MIN/MAX/SQRT/CMP 的 PS/PD/SS/SD 形式、HADD/HSUB/ADDSUB、
    (U)COMISS/SD 和全部转换。RCP/RSQRT 不产生异常：返回正确舍入的近似值，非规格化输入
    视为零，微小结果为零。
  - x64 page tier 原本就是精确的（TwoSum/TwoProduct 检测不精确），未改动。
- **快路径准入**（7.4 节，`src/rust/ir/native_fp.rs`）：
  - MXCSR 条件为 `(mxcsr & 0xFFE0) == 0x1FA0`。
  - lane 条件：操作数不是非规格化数；结果有限。MUL、DIV 和窄化转换的结果按舍入后判断不是微小
    （绝对值大于最小规格化数），零因子（被除数）得到的精确零除外。MIN/MAX、比较和扩宽转换只要求
    操作数既不是 NaN 也不是非规格化数。RCP/RSQRT 要求源是有限的规格化数（RSQRT 还要为正），
    结果不低于最小规格化数。
  - 解释器的快路径（`simd_fp::fast_lane`）采用同一条件。
  - 掩码的实现方式：有限值用 `x - x == 0`；非规格化数用 2|x| - 1 的范围；双精度只比较高半部分，
    最小规格化数本身也会被拒绝。常量在每个 32 位 lane 中取同一个值，在 ARM64 上各是一条立即数
    指令。任意 v128 常量每次使用都要经过一次通用寄存器和一次传送，代价比检查本身还大。
- **Tier-0**：
  - MXCSR 条件每个块只算一次。
  - 被拒绝的指令通过 `ir_t0_sse_fp`（操作数块上的 helper）在原地精确执行，不再交给解释器重试。
    原先的重试会留下入口点，把热循环切成许多小块：每两条浮点指令之间都要把 XMM 缓存写回再读回。
    只有在指令产生故障，或 lane 检查失败而本指令要记录寄存器事实时，才重试。
  - `Page::xmm_clean` 记录块内寄存器中已知既不是 NaN 也不是非规格化数的 lane，这些操作数不再
    检查。来源有：被准入的 MUL/DIV/SQRT/MIN/MAX 和转换的结果、已检查过的操作数、寄存器复制、
    搬动整个 lane 的 shuffle、`XORPS x, x`。ADD/SUB 的结果不算在内，它可能是精确的非规格化数。
  - 标量 MUL/DIV 先做一次廉价检查，指数为零或结果微小时才做完整检查，零只能在完整检查中放过。
    打包形式直接做完整检查，因为向量和矩阵数据常含零，廉价检查每次都会失败。
- **regions**：ADD/SUB/MUL/DIV 的寄存器形式仍是原生代码，按同样的条件准入；其他形式走 helper。
- **性能**（12.2 节）：`tests/bench` 全套 36 项与 P3 交错比较（M1 Pro，负载约 3–4；
  `build/simd-xsave/p4a-bench-full.json`），warm 几何平均 x0.975，cold x0.971，中位数约 x1.00，
  在 5% 的中位数预算之内。SSE 浮点四项回退：601.matmul.sse x0.72、606.nbody.sse x0.83、
  611.mandel.sse x0.89、620.simd.sse x0.72。其余各项（整数、x87、MMX、SSE2 整数）在 x0.94–x1.06
  之间，属于噪声。最初的精确版本在这四项上只有 x0.42–0.58。
  - 剩余开销主要有两项，都按指令逐条计算：一是还未确认干净的操作数要做非规格化检查，每对约 6 条
    指令；二是乘积要做带零例外的微小检查，约 6 条指令。检查分支和 MXCSR 的代价很小。
  - 可继续的方向：块间传递寄存器事实（循环中不变的寄存器每轮都要重新检查），以及按指令位置
    自适应地选择一级或两级检查。
  - 这一回退记录在第 13 节 Q2，供复核。
- **测试**：
  - `make sse-fp-tests`：
    - `tests/rust/sse_fp.mjs` 以 `tests/rust/sse_fp_model.mjs` 为准。该模型用 BigInt 做精确的
      有理数运算，不依赖 SoftFloat 和 `simd_fp.rs`。测试覆盖 68 个形式、寄存器源和内存源、
      11 种 MXCSR，以及 #XM 和 #UD，共 117744 例，在解释器、Tier-0 和 regions 上运行；
      分别用 release、无 SIMD 和 debug 构建。
    - `tests/ir/differential/sse_fp_tracking.mjs` 用 15 个序列检查 Tier-0 记录的寄存器事实，
      逐条验证过：故意写错的三条规则（ADD 结果算作干净、shuffle 只要部分 lane 干净就算干净、
      标量检查推出整个寄存器干净）都会被对应序列发现。
  - Tier-0 fuzz 比较 MXCSR，并新增两类：`s11` 用特殊值和 9 种屏蔽的 MXCSR；`s12` 针对寄存器
    事实。两类程序每轮开头都用 LDMXCSR 和 MOVAPS 重置状态，因为 MXCSR 的状态位是粘滞的，
    之后的轮次会把漏掉的状态位补上。
  - x64 的 vector oracle 在共用核心上解释执行和 page tier 下都通过。`ir-sse-fp-tests` 检查
    helper 和原生路径的约定（原生路径要求 PE 已置位）。
- **回归**：`sse-fp-tests`、`ssse3-tests`、`rust-test`、`x64-decode-tests`、`ir-decoder-tests`、
  `ir-decode-contract-tests`、`decode-rules-tests`、`ir-mmx-tests`、`ir-sse-fp-tests`、
  `ir-coverage-tests`、`ir-fp-state-tests`、`ir-tier0-tests`、`ir-differential-tests`、
  `ir-simd-integer-tests`、`ir-simd-shuffle-tests`、`packed-simd-tests`、`sse3-tests`、`xsave-tests`、
  `x64-system-tests`、opcode 矩阵、`x64-differential-tests`、`x64-page-tier-tests`、`nasmtests`、
  `nasmtests-force-jit`、`kvm-unit-test`、`smp-tests`、`api-tests`、`platform-contract-tests`、
  rustfmt 和 state layout 检查全部通过。

### P4a 第二部分：legacy SSE 的异常条件（2026-10-05）

本节记录 P4a 的第二部分：32 位引擎按 SDM 的异常类型 4 检查 legacy SSE 形式（3.3 节）。x64 引擎
原本就这样做，兼容模式下两个引擎不再不同。

- **CR4.OSFXSR**：
  - XMM 形式在 CR0.EM=1 或 CR4.OSFXSR=0 时 #UD，然后才是 CR0.TS 的 #NM。MMX 形式只检查
    CR0.EM 和 CR0.TS。MMX 形式是无前缀的 0F 60–7F、C4、C5、D0–FF 以及 0F38/0F3A 映射中的形式
    （`gen/x86_table.js` 的 `mmx_form`），与 x64 `vector.rs` 的划分相同。MMX 与 XMM 寄存器之间的
    转换（CVTPI2PS、CVTPS2PI、MOVQ2DQ、MOVDQ2Q 等）引用 XMM 寄存器，属于 XMM 形式。
    LDMXCSR/STMXCSR 按 XMM 形式检查，EMMS 按 MMX 形式检查，FXSAVE/FXRSTOR 不看 OSFXSR。
  - 解释器：生成器为 MMX 形式生成 `task_switch_test_mmx`，为其余 SSE 形式生成新的
    `task_switch_test_xmm`。OSFXSR=0 时原来打的日志删去。
  - regions：IR 编码表新增 `mmx` 标志（94 行）。`SseCheck` 的守卫增加 `required` 条件
    （CR4.OSFXSR 必须置位）；invalid/reserved 形式的守卫区分 MMX 和 XMM；helper 和
    LDMXCSR/STMXCSR 改用 `task_switch_test_xmm`。
  - Tier-0：守卫每个块只做一次（`Page::simd_checked`）。MMX 条件与 x87 守卫共用一位，XMM 形式
    另需 OSFXSR 一位，所以块中先出现 MMX 形式时，之后的 XMM 形式仍会检查 OSFXSR。
  - 删去了 debug 构建中只记录、不产生故障的 OSFXSR 观察机制（后端的 `debug_sse_*`、语义 fixture
    和 `tests/ir/differential/fp_debug_deferral.mjs`）。新测试 `tests/ir/differential/sse_task_faults.mjs`
    让缓存的 region 与解释器逐一比较：18 个形式（SSE、MMX、原生 SIMD、LDMXCSR/STMXCSR、
    invalid/reserved 形式、STI 之后），两个 tier，两个优化级别，7 种 CR0/CR4/诊断组合，共 504 次。
- **16 字节对齐**：
  - legacy SSE 形式的 m128 操作数不是 16 字节对齐时 #GP(0)：按线性地址判断，先于 #PF，没有任何
    效果。例外是 MOVUPS、MOVUPD、MOVDQU 和 LDDQU（PCMPxSTRx 在 P4b）。UNPCKLPS/UNPCKLPD 只读
    8 字节，但操作数是 m128，同样要求对齐。较窄的操作数、MMX 形式和 MASKMOVDQU/MASKMOVQ 的
    隐式操作数不要求对齐。
  - 解释器：109 个内存形式改用 `safe_read128s_aligned`，UNPCKLPS/UNPCKLPD 先调用 `aligned16`；
    6 个对齐存储（MOVAPS、MOVAPD、MOVNTPS、MOVNTPD、MOVDQA、MOVNTDQ）改用 `mov_r_m128_aligned`。
  - IR：`Encoding::aligned_m128` 是唯一的判断。regions 在访存前插入 `Op::AlignmentCheck`，在 MIR
    中是 `Check` 的 `misaligned` 条件，不对齐时调用 `ir_alignment_fault`；SSE helper 的内存读取
    改用对齐版本。Tier-0 遇到不对齐的地址时重试，由解释器产生 #GP。
  - x64 引擎的 MOVSLDUP/MOVSHDUP 内存操作数原先不查对齐，已修正。
- **测试环境**：不少测试在裸机上运行 SSE 代码，却没有置位 CR4.OSFXSR，或者特意用未对齐的 m128
  操作数测试跨页访问。以前前者只记日志，后者不检查，现在都会产生故障，因此逐一修改：
  - v86 的 multiboot 入口不设置 CR4（multiboot 规范不要求），BIOS 也不设置。`tests/nasm/run.js`
    像 QEMU oracle 的启动代码一样置位 CR4.OSFXSR 和 OSXMMEXCPT；`decode_rules.mjs`、`sse3.mjs`、
    `xsave.mjs`、`packed_simd.mjs` 在程序开头置位；`cpu_optimizations.mjs`、
    `cpu_plan_sequences.mjs`、`x87_jit_cache.mjs` 在机器启动后置位（这些程序按绝对地址引用自身）。
  - 未对齐的操作数：`sse3.mjs`（HADD/HSUB、MOVSLDUP/MOVSHDUP）和 `packed_simd.mjs` 让要求对齐
    的形式使用对齐的地址，包括页内最后一个 16 字节位置；MOVDDUP、LDDQU 和窄操作数仍测跨页。
    IR 差分测试（`sse_fp.mjs`、`simd_integer/shuffle/moves/transfer/lane.mjs`）用按 SDM 独立写出的
    `aligned_m128`（`tests/ir/differential/sse_fixture.mjs`）判断：要求对齐的形式在未对齐和跨页的
    地址上期望 #GP(0)，且设备看不到任何访问，在页末对齐的位置上测 MMIO；其余形式照旧测跨页、
    部分故障和映射变化。IR 的 SIMD 差分测试在 OSFXSR=0 时期望故障。
  - x64 vector oracle 新增未对齐 MOVSLDUP/MOVSHDUP 两例。QEMU 10.2 不检查这两条的对齐，直接在
    跨页处 #PF；SDM 把它们列为异常类型 4，因此登记为 QEMU 的已知差异，按 SDM 判定 #GP(0)。
  - `tests/expect` 中固定了 SSE 守卫代码的期望（`task_switch_test_sse.wast`），已更新：入口处原先
    的 debug 观察检查删去，守卫合并为 `(cr0 & 12) | ((cr4 & 512) ^ 512)`。
- **测试**：`make sse-fault-tests`（`tests/rust/sse_faults.mjs`）。每个程序在解释器、Tier-0 和
  regions 上先热运行，再单独运行一轮，两次的故障记录、寄存器和内存都要与解释器一致。分别用
  release、无 SIMD 和 debug 构建运行：
  - 没有 OSFXSR 时，131 个 XMM 形式的 244 个寄存器/内存变体都是 #UD，CR0.TS=1、内存操作数未对齐
    或所在页不存在时也一样；25 个 MMX 形式、EMMS 和 FXSAVE 照常执行，结果与开启 OSFXSR 时相同。
    XMM 与 MMX 形式交替排列，覆盖块中先检查了 MMX 条件的情况。CR0.TS=1 时全部 #NM。
  - 140 个内存形式各在对齐和未对齐的地址上运行：73 个 #GP(0)，寄存器和内存都不变（FXSAVE/FXRSTOR
    也一样）；其余 67 个的结果与对齐时相同。
  - 17 个顺序用例：未对齐的 #GP(0) 先于 #PF；跨页访问的 #PF 报告第一个不存在的字节；跨页存储
    不写入任何字节。CR0.TS 的 #NM 先于两者。
  - 故意植入 8 个错误来验证测试能力，全部被发现：Tier-0 的 OSFXSR 守卫、块内守卫缓存、源操作数
    和存储的对齐检查、UNPCKLPS 的 m128 规则，regions 的 OSFXSR 守卫和对齐检查，以及 helper 的
    对齐读取。最初 regions 用默认的热度阈值：故障之后的恢复点每轮只运行一次，来不及编译，3 个
    regions 错误都漏掉了。现在测试中 regions 的阈值为 1，并同步发布。
- **性能**：与第一部分交错比较 SIMD 六项（601/606/611/620 SSE 浮点、621 SSE2 整数、625 MMX；
  `build/simd-xsave/p4a2-bench.json`），warm x1.017，cold x0.988，在噪声之内。测量时机器负载约 25，
  只有交错比较可信。Tier-0 每块只检查一次 OSFXSR；对齐检查是每个访存一次的 `and` 加条件分支。
- **回归**：`sse-fault-tests`、`sse-fp-tests`、`ssse3-tests`、`rust-test`、`ir-tests`（`-D warnings`）、
  `x64-decode-tests`、`ir-decoder-tests`、`ir-decode-contract-tests`、`decode-rules-tests`、
  `ir-mmx-tests`、`ir-sse-fp-tests`、`ir-coverage-tests`、`ir-fp-state-tests`、`ir-tier0-tests`、
  `ir-differential-tests`、七个 `ir-simd-*-tests`、`ir-sti-tests`、`ir-fusion-tests`、`ir-cfg-tests`、
  `ir-cache-tests`、`ir-helper-reload-tests`、`packed-simd-tests`、`sse3-tests`、`xsave-tests`、
  `x64-system-tests`、opcode 矩阵、`x64-differential-tests`、`x64-page-tier-tests`、`nasmtests`、
  `nasmtests-force-jit`、`kvm-unit-test`、`smp-tests`、`api-tests`、`expect-tests`、`jitpagingtests`、
  `cpu-optimization-tests`、`cpu-plan-tests`、`cpu-worker-tests`、`flags-provenance-tests`、
  `jit-tiers-tests`、`jit-disabled-tests`、`mmx-fast-tests`、`softfloat-fast-tests`、四个 x87 目标、
  `performance-recording-tests`、`platform-contract-tests`、rustfmt、state layout 和 eslint 全部通过。
  以下失败与本部分无关，已另立任务：`ir-control-reference-tests` 在计划开始前的 `8d2b7c04` 上就
  无法编译（它把旧版函数体拼进当前源码），P2 的 FXSAVE 改动又增加了几处错误；
  `ir-portable-tests` 的 `fallback.mjs` 在 2026-10-01/03 的显示适配器改动后，于 JS 选项处理中崩溃；
  `cpu::mmio_ram` 的两个单元测试共用静态表，并行运行时互相干扰（串行运行通过）。
- **遗留**：PSHUFB 的内存形式在 regions 中仍走 helper；现在有了对齐检查，可以改为原生代码，
  留到 P12 与其他只走 helper 的形式一起处理。

### P4b 第一部分：SSE4.1 的整数与数据搬运形式（2026-10-05）

- **范围**：SSE4.1 中除 ROUNDPS/PD/SS/SD 和 DPPS/DPPD 之外的全部 41 行，外加 SSE4.2 的 PCMPGTQ。
  浮点的 ROUND/DPP 在第二部分，PCMPxSTRx 和 CRC32 在第三部分，此前这些行仍 #UD。
  - 66 0F 38：PBLENDVB、BLENDVPS/PD（隐式以 XMM0 为掩码），PTEST（置 ZF、CF，其余算术标志
    清零），12 个 PMOVSX/PMOVZX（只读要扩展的字节，不要求对齐），PMULDQ、PCMPEQQ、PACKUSDW、
    PCMPGTQ、PMINSB/SD/UW/UD、PMAXSB/SD/UW/UD、PMULLD、PHMINPOSUW（最小值相同时取最低下标），
    MOVNTDQA（只有对齐的内存形式）。
  - 66 0F 3A：BLENDPS/PD、PBLENDW、MPSADBW，INSERTPS，PEXTRB/W/D 和 EXTRACTPS（寄存器目的
    零扩展，内存目的只写元素宽度），PINSRB/D（取寄存器的低位）。
- **语义**：`cpu/simd_int.rs` 新增 `sse4`、`ptest`、`sse4_imm` 和 `insertps`，三个引擎共用。
- **解释器**：`instructions_0f38.rs`、`instructions_0f3a.rs`。
- **IR**：regions 经 SSE helper（`ir_sse_fp_*`）执行，helper 直接调用解释器的语义函数，自行读写
  内存。只读写两个 XMM 操作数的形式加入 `xmm_register_operands` 审计；BLENDV（读 XMM0）、
  PTEST（写标志）和 PEXTR/PINSR（读写 GPR）不在其中。Tier-0 逐条解释。热点形式的原生模板
  放在第四部分（4.1 节的开放前提）。
- **x64**：`vector.rs` 的 `sse4`：可用 XMM8–15，REX.W 选择 PEXTRQ/PINSRQ，寄存器目的零扩展到
  64 位。page tier 逐条解释。
- **测试**：
  - `make sse4-tests`：
    - `tests/rust/sse4.mjs` 以 `tests/rust/sse4_model.mjs` 为准。该模型按 SDM 伪代码独立编写，
      不调用 `simd_int.rs`，其中 PCMPxSTRx、CRC32、ROUND 和 DPPS 的部分供后续两部分使用。
      29 个 66 0F 38 形式各 64 例（寄存器源和内存源，目的即源或即 XMM0），5 个 imm8 形式各
      512 例（全部 imm8，寄存器源和内存源），PEXTR/PINSR 到寄存器和内存，PTEST 的标志，MOVNTDQA。
      异常：没有特性时 #UD，CR0.EM 或没有 OSFXSR 时 #UD，CR0.TS 时 #NM，LOCK/F2/F3 和 MOVNTDQA 的
      寄存器形式 #UD，未对齐的 m128 #GP(0)（窄操作数没有），跨页读写 #PF 且不写入任何字节。共
      4913 项，在解释器、Tier-0 和 regions 上运行，分别用 release、无 SIMD 和 debug 构建。
    - `tests/x64/sse4.mjs`：64 位模式和兼容模式共 428 例、12 个故障，与 QEMU 和模型一致；
      分别以解释执行、page tier、page tier 加兼容模式 JIT 运行。QEMU 10.2 不检查 legacy PTEST
      的对齐，登记为差异，按 SDM 判定为 #GP(0)。
  - nasm：420 个新测试覆盖新增各行，QEMU fixture 全部通过。
  - IR：SSE helper 的 fixture 差分包含新形式（含 imm8 变体，以及字节操作数的跨页）。
  - 故意植入 3 个错误验证测试能力，全部被发现：regions 中 PEXTRB 的操作数次序、PMOVSX 的窄读，
    以及 x64 PEXTR 的零扩展。
- **测试框架的修正**：`tests/rust/ssse3.mjs`、`sse_fp.mjs`、`sse3.mjs` 和 `decode_rules.mjs` 原先只在
  冷运行之后检查结果。冷运行前程序被重写，编译代码随之作废，冷运行基本是解释执行，因此
  编译路径的结果从未被检查。植入的 regions 错误因此全部漏掉，这个问题才暴露出来。现在热运行
  （编译代码）和冷运行都检查。修正后全部通过，P3、P4a 的结论不变。`xsave.mjs` 结构相同，P9 时
  一并修正。
- **回归**：`sse4-tests`、`sse-fault-tests`、`sse-fp-tests`、`ssse3-tests`、`sse3-tests`、`rust-test`、
  `x64-decode-tests`、`ir-decoder-tests`、`ir-decode-contract-tests`、`decode-rules-tests`、`ir-mmx-tests`、
  `ir-sse-fp-tests`、`ir-coverage-tests`、`ir-fp-state-tests`、`ir-tier0-tests`、`ir-differential-tests`、
  七个 `ir-simd-*-tests`、`ir-sti-tests`、`ir-fusion-tests`、`ir-cfg-tests`、`ir-cache-tests`、
  `ir-helper-reload-tests`、`packed-simd-tests`、`xsave-tests`、`x64-system-tests`、opcode 矩阵、
  `x64-differential-tests`、`x64-page-tier-tests`、`nasmtests`、`nasmtests-force-jit`、`kvm-unit-test`、
  `smp-tests`、`api-tests`、`expect-tests`、`cpu-optimization-tests`、`cpu-plan-tests`、`jitpagingtests`、
  `platform-contract-tests`、rustfmt、state layout、isa-forms 检查和 eslint 全部通过。

### P4b 第二部分：ROUND 与 DPPS/DPPD（2026-10-05）

- **范围**：ROUNDPS/PD/SS/SD（66 0F 3A 08–0B）和 DPPS/DPPD（66 0F 3A 40/41）。SSE4.1 至此完整；
  PCMPxSTRx 和 CRC32 在第三部分，此前仍 #UD。
- **语义**：`cpu/simd_fp.rs` 新增 `round` 和 `dot_product`，三个引擎共用，与 P4a 的其他浮点形式
  共享 MXCSR。
  - ROUND：imm8[1:0] 给出舍入方式；imm8[2]=1 时改用 MXCSR.RC；imm8[3]=1 时不报告精度异常。
    DAZ 把非规格化输入当作零，但不报告 DE（SDM 明确 ROUND 不产生 DE）；只有 SNaN 产生 IE，
    结果为对应的 QNaN。标量形式只处理源的低 lane，其余 lane 取自目的。内存操作数：ROUNDSS
    读 4 字节，ROUNDSD 读 8 字节，均不要求对齐；ROUNDPS/PD 的 m128 要求对齐。
  - DPPS/DPPD：imm8[7:4] 选出参与相乘的 lane（未选的乘积为 +0.0），按 SDM 的次序两两相加，
    结果写入 imm8[3:0] 选出的 lane，其余 lane 为 +0.0：DPPD 为 p0+p1，DPPS 为 (p0+p1)+(p2+p3)。
    每次乘法和加法单独判定异常（单个运算按 11.5.3 节的次序），并在 MXCSR 中置位。未屏蔽异常
    在 SDM 伪代码检查的位置产生故障，目的不变：DPPD 在两次乘法之后和加法之后检查；DPPS 只在
    每次加法之后检查，因此即使某次乘法已有未屏蔽异常，第一次加法仍会执行并置位。最初的实现
    在第一个未屏蔽异常处立即停止，对照 SDM 伪代码后改正。`sse_fp.mjs` 的未屏蔽 MXCSR 列能
    区分这两种做法：旧构建对新模型时，乘积的 UE 状态位缺失。
- **解释器**：`instructions_0f3a.rs`，经 `sse_instr.rs` 的 `sse_fp_round`/`sse_fp_dot_product`；
  未屏蔽异常按 CR4.OSXMMEXCPT 产生 #XM 或 #UD。
- **IR**：regions 经 SSE helper 执行，内存宽度登记为 08/09/40/41 16 字节、0A 4 字节、0B 8 字节。
  这六个形式只读写两个 XMM 操作数，已加入 `xmm_register_operands` 审计。Tier-0 逐条解释；
  ROUNDSS/SD 的原生模板在第四部分。
- **x64**：`vector.rs` 经共用核心执行，源宽度分别为 32、64 和对齐的 128 位，未屏蔽异常映射为
  `simd_fault`。page tier 逐条解释。
- **测试**：
  - `tests/rust/sse_fp.mjs` 新增 6 个形式：ROUND 的 imm8 低 4 位全部取到，DPP 的 imm8 经常
    选中全部乘积。对照 `tests/rust/sse4_model.mjs` 的 `round_lane` 和 `dot_product`，覆盖 11 种
    MXCSR（含未屏蔽异常）。现在共 74 个形式、126368 例，在三个构建上运行。
  - `tests/x64/sse4.mjs` 新增 ROUND（imm8 取 0–4 和 8–12）和 DPP 用例，每例之后用
    STMXCSR 取出 MXCSR 比较。操作数含 NaN、±0、无穷、非规格化数和 SNaN。QEMU 10.2 按 x87 的
    规则传播 SSE NaN（P4a 已登记），因此 DPP 的操作数保证每次加法至多遇到一个 NaN 乘积；
    NaN 的全部组合由 `sse_fp.mjs` 对照模型检查。共 924 例和 12 个故障，与 QEMU 和模型一致。
  - nasm：60 个新测试（每个形式 10 个），QEMU fixture 全部通过。
  - IR 的 SSE helper 差分新增“恰好到页尾”的用例：窄内存操作数结束于页尾，下一页不存在，
    不得产生故障。植入的错误（regions 中 ROUNDSS 读 8 字节）只有在这种情形下才可观察，
    `sse_fp.mjs` 没有发现它，这个用例发现了。x64 中 ROUNDSD 只读 32 位的错误由
    `tests/x64/sse4.mjs` 发现。
- **回归**：`sse4-tests`、`sse-fault-tests`、`sse-fp-tests`、`ssse3-tests`、`sse3-tests`、`rust-test`、
  `x64-decode-tests`、`ir-decoder-tests`、`ir-decode-contract-tests`、`decode-rules-tests`、`ir-mmx-tests`、
  `ir-sse-fp-tests`、`ir-coverage-tests`、`ir-fp-state-tests`、`ir-tier0-tests`、`ir-differential-tests`、
  七个 `ir-simd-*-tests`、`ir-sti-tests`、`ir-fusion-tests`、`ir-cfg-tests`、`ir-cache-tests`、
  `ir-helper-reload-tests`、`packed-simd-tests`、`xsave-tests`、`x64-system-tests`、opcode 矩阵、
  `x64-differential-tests`、`x64-page-tier-tests`、`nasmtests`、`nasmtests-force-jit`、`kvm-unit-test`、
  `smp-tests`、`api-tests`、`expect-tests`、`cpu-optimization-tests`、`cpu-plan-tests`、`jitpagingtests`、
  `platform-contract-tests`、rustfmt、state layout、isa-forms 检查和 eslint 全部通过。

### P4b 第三部分：PCMPxSTRx、CRC32 与 POPCNT 审计（2026-10-07）

- **范围**：PCMPESTRM/PCMPESTRI/PCMPISTRM/PCMPISTRI（66 0F 3A 60–63）和 CRC32（F2 0F 38 F0/F1；
  66 选择 r/m16，64 位模式下 REX.W 选择 r64），SSE4.2 至此完整（PCMPGTQ 在第一部分）。
  POPCNT 只做审计。与 CRC32 共用 0F 38 F0/F1 的 MOVBE 仍 #UD（P10）。
- **语义**：`cpu/simd_int.rs` 新增 `compare_strings` 和 `crc32c`，三个引擎共用。
  - `compare_strings` 按 SDM 第 2 卷 4.1 节：imm8[1:0] 选元素格式；四种聚合，无效元素按
    表 4-7 强制取值；四种极性（masked negative 只翻转 b 的有效元素）；xSTRI 取最低或最高
    置位位的下标，没有置位时为元素个数；xSTRM 输出位掩码或字节/字掩码。显式长度取绝对值，
    最多为元素个数（i64::MIN 也正确）；隐式长度到第一个零元素为止。
  - `crc32c` 用查表实现 CRC-32C（多项式 11EDC6F41H，反射形式 82F63B78H），低字节在前。
  - 单元测试：CRC-32C 校验值（"123456789" 得 0xE3069283）、各种聚合的例子，以及 equal
    ordered 在满 16 字节的 haystack 末尾部分匹配、masked negative 求第一个差异（strcmp）、
    带符号字和显式长度。
- **解释器**：`instructions_0f3a.rs` 的 `pcmpstr`：EAX/EDX 为显式长度，结果写 ECX 或 XMM0，
  置 CF、ZF、SF、OF，清 AF、PF；m128 不要求对齐（SDM 异常类型 4 的注）。
  `instructions_0f38.rs` 的 CRC32：目的总是 r32，不改标志，不做 CR0.TS、CR0.EM、CR4.OSFXSR
  检查。
- **IR**：PCMPxSTRx 经 SSE helper 执行；`Encoding::aligned_m128` 和 fixture 的 `aligned_m128`
  都把它们排除在对齐要求之外。它们读 EAX/EDX、写 ECX/XMM0 和标志，不在
  `xmm_register_operands` 中。CRC32 新增 `ir/frontend/crc32.rs` 和 `ir/runtime/crc32.rs`：
  寄存器形式用 `ir_crc32_reg_continue`（标量 reload，不失效代码），内存形式用
  `ir_crc32_mem_continue`（完整 reload，与 SSE 内存形式一样检查 continuation context）。两者都
  让 region 继续执行，CRC32 循环不会在每条指令处退出 region。lowering 类别为
  `CpuCrc32Helper`，测试为 `make ir-crc32-tests`。Tier-0 逐条解释。
- **x64**：`vector.rs` 执行 PCMPxSTRx：长度取 EAX/EDX，有 REX.W 时取 RAX/RDX；写 ECX 时 RCX
  零扩展。`execute.rs` 执行 CRC32：r/m8（有 REX 时可用 SIL/DIL，无 REX 时为 AH–BH）、
  r/m16/32/64，结果零扩展到目的寄存器（r32 和 REX.W 的 r64），不改标志（`flag_free`）。
- **POPCNT 审计**：CPUID.1:ECX[23] 始终报告（v86 的基础能力），与 `cpu_features` 中的
  SSE4.2 无关；16/32/64 位形式和标志（清 OF、SF、AF、CF、PF，源为零时置 ZF）都正确，没有
  XMM 状态检查。IR 的原生 lowering 已由 bits 测试覆盖。代码未改动，新增测试。
- **测试**：
  - `tests/rust/sse4.mjs`：
    - 没有任何 SSE4 时，PCMPxSTRx 和 CRC32 #UD，POPCNT 可用且 CPUID 报告它。新增只有
      SSE4.1 的机器：CPUID 只报告 SSE4.1，PCMPGTQ、PCMPxSTRx、CRC32 #UD，SSE4.1 形式正常执行。
    - PCMPxSTRx 四个形式各 512 例：全部 imm8（含保留的 bit 7），寄存器源和不对齐的内存源，
      操作数可与 XMM0 重合。显式长度共 21 种，含 0、负数、-2^31 和超出元素数的值。断言数据
      覆盖了无匹配、全匹配和两个串都提前结束的情形。
    - CRC32 三种宽度各 128 例：含 AH–BH、源与目的同一寄存器、不对齐内存，检查两种标志状态都
      保持不变。POPCNT r16/r32 各 64 例。
    - 异常：PCMPxSTRx 的不对齐 m128 不产生 #GP；CR0.TS 时 #NM，CR0.EM 或没有 OSFXSR 时 #UD；
      LOCK、F2、F3 #UD。隐式长度的串在第一个字节就结束，仍读整个 m128，跨入不存在的页时 #PF。
      CRC32、POPCNT 不受 CR0.TS、CR0.EM、OSFXSR 影响；LOCK #UD，F3 0F 38 F0/F1 #UD，CRC32
      跨页 #PF。
    - 共 7508 项，三个构建都通过。
  - `tests/x64/sse4.mjs`：共 1227 例、22 个故障（第二部分为 924 例、12 个故障）。新增：
    PCMPxSTRx 有无 REX.W（`o64`），RCX 预置全 1 以检查零扩展；CRC32 的 REX.W、AH、SIL、
    r9d,r10w、r9,r10 等形式；POPCNT 16/32/64 位。故障表新增不产生故障的项：不对齐的
    PCMPxSTRx，以及 CR0.TS/EM 下的 CRC32 和 POPCNT。
  - QEMU 差异：QEMU 10.2 的 `gen_PCMPESTRx` 只把 8 位立即数传给 helper，而 helper 靠 bit 8
    判断 REX.W，于是 REX.W 形式仍用 EAX/EDX。SDM 规定用 RAX/RDX。已登记：对 QEMU 按 32 位
    长度检查，v86 与 QEMU 比较时略去这些结果槽；v86 按 SDM 与模型比较。
  - nasm：70 个新测试（PCMPxSTRx 40 个，CRC32 30 个），QEMU fixture 全部通过，共 16499 个。
  - IR：SSE helper 差分包含 PCMPxSTRx（每个构建 179820 例）。CRC32 差分每个构建 696 例：
    寄存器/内存源对照模型、MMIO、跨页 #PF、恰好到页尾、空段 #GP，以及 CR0.TS/EM、OSFXSR
    不起作用。
  - 解码：x64 和 IR 解码器新增有无 SSE4.2 时的解码测试，`decode_rules.mjs` 把 PCMPISTRx 和
    CRC32 移到“没有能力时 #UD”的列表。
  - 故意植入 8 个错误，全部被发现：解释器 PCMPESTRx 交换 EAX/EDX、regions 的 PCMPxSTRx 内存
    源要求对齐、regions 的 CRC32 字节寄存器按 32 位读、regions 的 CRC32 m16 读 4 字节（只有
    “恰好到页尾”的用例发现）、frontend 把 CRC32 F1 的宽度固定为 32、x64 忽略 REX.W、x64 CRC32
    F0 按操作数宽度读、x64 的 xSTRI 只写 CX。
- **回归**：`p4b3-batch` 共 53 个目标（第二部分的目标加 `ir-crc32-tests`），48 个通过。另外
  5 个（`state-layout-check`、`platform-contract-tests`、`x64-decode-tests`、
  `x64-opcode-matrix-tests`、`smp-tests`）在前置的 state layout 检查处失败。原因是另一个会话
  正在修改 `src/rust/cpu/mmio_ram.rs`：它新增了 `cfg(test)` 静态变量，但没有登记到
  `gen/state_layout.js`。在只含本部分改动的工作树中，state layout 检查通过；这些目标其余的
  命令（`cpu_features`、`cpu_contract`、`profile_options`、`cargo test x64::`、`simd_corpus`、
  iced-x86 oracle、opcode 矩阵、`core_swap` 的两种模式）直接运行，全部通过。

### P4b 第四部分：SSE4 热点形式的原生模板（2026-10-07）

- **范围**：5.1 节热点清单中 SSE4 的四个形式 PMINUD、ROUNDSS、ROUNDSD、PCMPISTRI，以及与它们
  同类、代价低的形式，在 Tier-0 和 x64 page tier 上改为原生模板；regions 中 SSE4.1 的整数和
  blend 形式改为原生 HIR。4.1 节 M1 的开放前提（热点形式有原生模板）至此满足。
- **Tier-0**（`ir/tier0/simd.rs` 的 `sse4`）：
  - 一条 Wasm SIMD 运算即可完成的 12 个形式：PCMPEQQ、PACKUSDW、PCMPGTQ、PMINSB/SD/UW/UD、
    PMAXSB/SD/UW/UD、PMULLD。BLENDPS/BLENDPD/PBLENDW 按 imm8 作为 shuffle。m128 的对齐检查
    与 SSE2 形式相同。
  - ROUND 用 Wasm 的 nearest/floor/ceil/trunc。以下情形拒绝原生执行：NaN lane（payload 不确定，
    SNaN 还要置 IE）、MXCSR.DAZ、imm8[2] 时 MXCSR.RC 不是就近，以及要报告 PE（imm8[3]=0）且
    PE 未屏蔽时出现不精确的 lane。被拒绝的指令经 `ir_t0_sse_fp`（新增 ROUND 分派）精确执行。
    PE 由模板自己置位，所以 PE 尚未置位时也走原生路径；floor/ceil 常用的 imm8 9–11 本来就不
    报告 PE。
  - PCMPxSTRx：操作数写入 `ir_t0_sse_fp` 的操作数块，调用纯函数 `ir_t0_pcmpstr`（EAX/EDX 作为
    参数），再由模板写 ECX 或 XMM0 以及 EFLAGS。
  - 诊断：新增 `ir_t0_sse_fp_calls`，按 key 统计精确路径的调用次数。
- **page tier**（`x64/pagegen.rs`）：同样的 12 个形式和三个 blend 用 `Vpacked`。ROUND 用
  `Vround`，拒绝条件同上，被拒绝时在解释器中重试。PCMPxSTRx 用 `Vstrings`，经
  `x64_page_pcmpstr`（REX.W 时长度取 RAX/RDX），写 RCX（零扩展）或 XMM0，标志经
  `flags_begin`/`flags_end` 更新。
- **regions**：12 个形式成为 `PackedOp`，id 取 66 0F 38 的字节。`from_encoding` 只从 66 0F 38 的
  键映射这些 id，否则 66 0F 28/29/2B（MOVAPD、MOVNTPD）会被误认为它们。三个 blend 成为
  `ShuffleOp`。寄存器形式是原生 HIR；内存形式先检查对齐，再走原生读取或
  `ir_xmm_binary`/`ir_xmm_shuffle`。ROUND 和 PCMPxSTRx 仍走 SSE helper（见“性能”）。
- **`compare_strings` 提速**：先把两个串的元素取到数组，再只做聚合需要的比较：equal any 对字节
  用 256 位集合，ranges 只遍历两端都有效的区间对，equal each 只比对角线，equal ordered 遇到
  不匹配就停。语义不变，模型测试、nasm 和 x64 测试全部通过。
- **性能**：`tests/bench` 新增三个微基准 712.sse4.int、713.sse4.round、714.sse4.strings。新的
  `cpu_features` 字段由 runner 传给 V86。与第三部分的构建交错比较（M1 Pro，
  `build/simd-xsave/p4b4-bench-sse4.json`）：
  - warm：712 从 34 到 1977 MIPS（x58），713 从 43 到 959 MIPS（x22），714 从 15 到 59 MIPS
    （x4）；cold 分别为 x7.8、x5.7、x1.7。
  - 按层（第三次运行，MIPS）：714 解释器 16、只用 Tier-0 82、只用 regions 26、默认 60；713 为
    22、920、58、约 1000–1150；712 为 20、1700–3200、900、1900。
  - regions 中 ROUND 和 PCMPxSTRx 仍走完整 reload 的 SSE helper，比 Tier-0 的模板慢。默认配置
    下 714 的热循环被提升到 regions，所以比只用 Tier-0 慢（60 对 82）。改进方向记入 12.2 节。
- **测试**：
  - `tests/rust/sse4.mjs` 在 Tier-0 机器上检查模板确实执行（`ir_t0_steps`）：12 个形式、三个
    blend 和 PCMPxSTRx。新增 ROUND 测试：从默认 MXCSR（PE 未置位）出发，有限值在 Tier-0
    原生执行（`ir_t0_sse_fp_calls` 为 0，几乎没有 step），NaN lane 走精确 helper；结果和最终
    MXCSR 都与模型一致，覆盖全部模式和 imm8 的保留位。共 8020 项。
  - `tests/x64/sse4.mjs` 新增 64 例 ROUND，MXCSR 取三种非就近的舍入方式和 DAZ（page tier 重试
    这些情形），共 1291 例。hot loop 中的 PMINUD 等、ROUND（含置 PE 的 ROUNDPS）、PCMPISTRI
    （不对齐的内存操作数）和 PCMPESTRM 都在 page tier 原生执行：240 万条指令，24 次 step。
  - IR：`simd_integer` fixture 加入 12 个形式（共 57024 种场景），`simd_shuffle` 加入三个
    blend（共 65792 种）；独立的 JS 模型（`packed_model.mjs`、`shuffle_model.mjs`）相应扩展。
    `mir_value` 的 PackedOp 测试覆盖全部 69 个运算的寄存器和内存路径。
  - `tests/x64/sse4.mjs` 新增一个编译执行的循环：DAZ 下的 ROUNDPD 和 imm8 4、MXCSR.RC 向下的
    ROUNDPD，每轮结果累加，并检查 page tier 确实重试了它们（`x64_page_stat(2)`）。
  - 故意植入 16 个错误，全部被发现：Tier-0 的 PMINUD 按有符号比较、BLENDPS 漏掉 imm8 bit 3、
    ROUND 的 floor 与 ceil 对调、不置 PE、不拒绝 NaN（由 `sse_fp.mjs` 的 SNaN 用例发现）、
    PCMPxSTRx 的标志移位错、ECX 写成 EDX；page tier 的 PMINUD、ROUNDPD 的舍入方式、不拒绝 DAZ、
    不拒绝 MXCSR.RC、忽略 REX.W；regions 的 PMINUD 的 Wasm 运算码、PBLENDW 的 lane；
    `compare_strings` 的 equal any 集合。
  - 由此发现并修正了两个测试问题。（1）完整的 x64 测试中，靠后的 ROUND 用例并不总是以编译
    代码执行：重试之后，运行时会在解释器中继续一段，所以不拒绝 DAZ 的错误起初漏过了。上面的
    循环把每轮结果累加，补上了这个漏洞。（2）regions 的错误必须先用 `cargo test` 重新生成
    fixture（`make ir-simd-integer-tests`），只重建 runtime 的 wasm 不会把错误带进被测代码。
- **回归**：`p4b4-batch` 的 53 个目标中 48 个通过。另外 5 个（`state-layout-check`、
  `platform-contract-tests`、`x64-decode-tests`、`x64-opcode-matrix-tests`、`smp-tests`）与第三
  部分一样，在另一个会话尚未完成的 `src/rust/cpu/mmio_ram.rs` 改动处失败。在只含本部分改动的
  工作树中 state layout 检查通过（新增的 `SSE_FP_CALLS` 已登记）；这些目标其余的命令直接运行，
  全部通过。

### M1：开放 SSSE3、SSE4.1、SSE4.2（x86-64-v2）（2026-10-07）

- **含义**：Q1 让新建 VM 的默认配置保持不变，所以“开放”指公开选项 `cpu_features` 接受这三个
  能力（按名称，或用预设 `x86-64-v2`）；默认 CPUID 不变，`gen/cpu_features.js` 的 `open` 仍为空。
- **公开与内部**：`gen/cpu_features.js` 新增 `RELEASED = ["M1"]`，生成的 `src/cpu_features.js` 为
  每个能力记录 `released`。之后里程碑的能力（XSAVE、AVX……）仍然接受，但启动时会警告：它们只供
  测试和开发，指令可能仍是 #UD。设置 `cpu_features_unreleased` 可以关掉警告（12.1 节的测试专用
  feature mask）。`unreleased_cpu_features` 列出这些能力。本计划自己的测试都设置了这个选项；
  `tests/devices/smm.js` 正由另一个会话修改，暂未设置，所以会警告。
- **文档**：`v86.d.ts` 记录 `cpu_features`，只列已开放的能力和预设；`docs/x86-64.md` 说明用法以及
  与 Q1 的关系。`starter.js` 和 CPU worker 传递 `cpu_features_unreleased`。
- **CPU contract**：`tools/cpu_contract.mjs` 新增 `legacy-v2`、`x64-v2` 两个 profile（预设
  `x86-64-v2`）。人工审核：原有四个 profile 不变；新 profile 与 `legacy-1`、`x64-1` 只差
  CPUID.1:ECX 的 bit 9、19、20（0x180200），MSR 相同。`gen/cpu_features.js` 的检查改为：能力的位
  只在它开放的 profile 和请求它的 profile 中置位。
- **发布 gate**：`tools/release_gate.mjs` 新增 `R-SSE4`：`platform-contract-tests`、`ssse3-tests`、
  `sse4-tests`、`sse3-tests`、`sse-fp-tests`、`sse-fault-tests`、`packed-simd-tests`、
  `decode-rules-tests`、`x64-decode-tests`、`ir-sse-fp-tests`、`ir-crc32-tests`、
  `ir-simd-integer-tests`、`ir-simd-shuffle-tests`，以及两种 `nasmtests`。这些目标在 P4b 第四部分
  的回归中都已通过（state layout 的外部问题见那里）。
- **留到 P12**：真实客体验收（11.3 节，如 glibc 的 `_sse42` 变体；Alpine x86_64 用 musl，
  TinyCore 11 是 32 位 glibc），以及默认配置的决定（Q1）。
- **测试**：`tests/x64/cpu_features.mjs` 检查只有 x86-64-v2 的能力是 released；contract 检查和
  `gen/cpu_features.js --check` 通过。用到未开放能力的测试（`tests/rust/xsave.mjs`、
  `decode_rules.mjs`、`tests/x64/xsave.mjs`、`tests/smp/xstate_lifecycle.mjs`、kvm-unit-tests 和
  `linux_boot.mjs` 的 runner）设置 `cpu_features_unreleased`，运行通过且没有警告。`api-tests` 和
  `kvm-unit-test` 通过；`tests/api/reset.js` 有一次在负载约 20 时超时，重跑通过。

### P5 第一部分：共享的 AVX 执行器，数据搬运与逻辑形式（2026-10-07）

- **范围**：P5 的 296 个 VEX.128/VEX.LIG 形式中的 70 个（47 个助记符），即数据搬运、逻辑运算、
  VZEROUPPER、VLDMXCSR/VSTMXCSR：VMOVUPS/UPD/APS/APD、VMOVDQA/DQU、VLDDQU、VMOVNTDQA、
  VMOVNTPS/PD/DQ、VMOVSS/SD、VMOVHLPS/LHPS/LPS/LPD/HPS/HPD、VMOVSLDUP/SHDUP/DDUP、VMOVD/VMOVQ、
  VUNPCKLPS/LPD/HPS/HPD、VANDPS/PD、VANDNPS/PD、VORPS/PD、VXORPS/PD、VPAND/VPANDN/VPOR/VPXOR、
  VMOVMSKPS/PD、VPMOVMSKB、VMASKMOVDQU。整数、浮点和 AVX 新增的 128 位形式在后续部分接入
  同一个执行器。
- **共享执行器**（`src/rust/cpu/avx.rs`）：32 位解释器、IR 的 helper 和 x64 引擎共用一份 VEX
  语义。
  - 引擎负责解码（`decode_rules::vex_row` 选中的行存在、有语义、接受这些 VEX 字段），并通过
    `Machine` trait 提供访存、通用寄存器、EFLAGS 和异常交付。XMM、YMM 高半、MXCSR、CR0/CR4/XCR0
    在各引擎中是同一份状态。
  - 语义复用 legacy 形式的值级函数（`ir::simd` 的 `PackedOp`、`TransferOp` 等），`legacy(key)`
    把 VEX 键换成对应 legacy 形式的目录键。操作数按 VEX 组织：VEX.vvvv 是第一源；VEX.128 的
    目的寄存器清零 255:128 位，寄存器之间的 VMOVSS/VMOVSD 也清零；所有输入先读后写，任意别名
    都正确。
- **异常与顺序**：
  - `check` 先判 #UD（CR4.OSXSAVE=0，或 XCR0[2:1]≠11b），再判 #NM（CR0.TS）。CR0.EM 和
    CR4.OSFXSR 不影响 VEX 形式。
  - 按 SDM Vol. 3 6.9 的优先级：先取完指令的全部字节，再判这两类异常，最后检查操作数的段并
    访存。新增的 `modrm::resolve_offset` 只取 SIB 和位移，不检查段。
  - 只有 VMOVAPS/APD、VMOVDQA、VMOVNTPS/PD/DQ 和 VMOVNTDQA 要求 16 字节对齐（#GP(0)）。
    VLDMXCSR 遇到保留位时 #GP(0)。
  - VMASKMOVDQU 沿用各引擎 MASKMOVDQU 的做法：32 位引擎先检查整个 16 字节可写，x64 引擎只探测
    被选中的字节。
- **各执行路径**：
  - 32 位解释器（`cpu/vex.rs`）：取完字节后调用 `check`，再算地址并执行。实模式和 V86 模式下
    仍是 LES/LDS 的 #UD。
  - x64 引擎（`x64/vector.rs`）：对 `Decoded.vex` 调用同一个执行器（`Avx` machine，地址、
    canonical 检查和对齐沿用 SSE 的函数）。page tier 把 VEX 形式作为 step 执行。
  - IR regions：`ir::frontend::avx` 把每个 AVX 形式降低为 CPU helper `ir_avx_continue`（CpuReload
    ABI，参数为键、打包的操作数字段、偏移和段），helper 之后 region 继续执行。IR 解码器不知道
    模式，总把寄存器形式的 C4/C5 解成 VEX，所以 helper 在实模式和 V86 模式下 #UD。有访存时按
    ContinuationContext 判断能否继续。覆盖报告的新类别为 `CpuAvxHelper`。`ir_avx_calls` 统计调用
    次数，供测试使用（state layout 中登记为 debug）。
  - Tier-0 用解释器 step 执行 VEX 形式，热点模板在第五部分。
  - 无 Wasm SIMD 的可移植构建中，regions 本来就不生成向量 IR，含 AVX 形式的 region 被拒绝，
    这些指令由解释器执行（Tier-0 仍 step 它们）。
  - 生成：`gen/vex_table.js` 的 `AVX_128` 列出已有语义的助记符（VEX.128 与 VEX.LIG 形式），其余
    行仍为 unimplemented（#UD）。IR 解码测试改为：有语义的行完整解码。
- **测试**（`make avx-tests`、`make ir-avx-tests`）：
  - `tests/rust/avx_model.mjs`：按 SDM 写的模型和形式表，两边的测试共用。
  - `tests/rust/avx.mjs`（32 位：解释器、Tier-0、regions；release、debug 和无 SIMD 构建）：
    - 每个形式 32 例：寄存器的各种别名组合、不对齐的内存操作数、两种 VEX 前缀，VEX.W（WIG，
      以及非 64 位模式下的 WIG32）和 VEX.L（LIG）取随机值。XRSTOR 载入全部 XMM 和 YMM 高半，
      XSAVE 读回，检查目的寄存器的高半清零、其他寄存器不变。
    - legacy SSE 与 VEX 的混合链（legacy 保留高半）；CR0.EM 和无 CR4.OSFXSR 不影响 VEX；页末的窄
      操作数不访问之后的字节。
    - 异常：无 AVX 能力、无 CR4.OSXSAVE、XCR0=3 时 #UD（先于 #NM），CR0.TS 时 #NM，对齐和 VLDMXCSR
      保留位的 #GP(0)，VEX.L1 和多余 VEX.vvvv 的 #UD，#PF 无副作用。
    - 热运行确认 Tier-0 step 了 VEX 形式、regions 调用了 AVX helper。region 编译是异步的，热运行
      要等到编译后的 VEX 代码实际运行。共 1892 项。
  - `tests/x64/avx.mjs`：64 位模式（XMM8–15、VEX.R/X/B、SIB 寻址、W1 的 64 位通用寄存器形式）和
    兼容模式下的全部形式共 476 例，对照 QEMU 和模型。50 个异常用例：#UD、#NM、对齐的 #GP、
    非 canonical 地址的 #GP/#SS、CR0.EM、VLDMXCSR 保留位。兼容模式下 VZEROUPPER 只清 YMM0–7，
    YMM8–15 的高半经过兼容模式后不变。解释执行、page tier 和兼容模式 JIT 三种配置都通过。QEMU 的
    偏差见 11.1 节。
  - IR：`tests/ir/semantics/avx.rs`（lift、CFG、降低与发射）和 `tests/ir/differential/avx.mjs`。
    90 个 fixture，前面有 region 持有的 XMM 值或通用寄存器值，后面有读取结果的 PADDD；配置包括
    MMIO、跨页 #PF、空段、CR0/CR4/XCR0 和实模式。1227 项比较，debug 和 release 都通过。
  - 植入 7 个错误，全部被发现：不清零高半、兼容模式的 VZEROUPPER 清 16 个寄存器、不检查 XCR0、
    VMOVSS 不合并第一源、非 64 位模式把 W1 当作 64 位、IR helper 的 vvvv 字段、VMASKMOVDQU 的
    地址。其中 W1 一项起初漏过：两个测试都只用 W0 编码 VMOVD。模型为 WIG32 形式加上 `wig32`
    标记，非 64 位模式下随机取 VEX.W 之后被发现。
- **回归**：`p5a-batch` 的 55 个目标（P4b 第四部分的 53 个加上 `avx-tests`、`ir-avx-tests`）中
  49 个通过。`avx-tests` 在无 SIMD 构建上超时：测试要求 regions 调用 AVX helper，而该构建的
  regions 不处理 XMM 状态。测试改为只在有 Wasm SIMD 时要求这一点，重跑通过（x64 部分的 debug
  和 release 也通过）。其余 5 个（`state-layout-check`、`platform-contract-tests`、
  `x64-decode-tests`、`x64-opcode-matrix-tests`、`smp-tests`）仍是另一个会话的
  `src/rust/cpu/mmio_ram.rs` 所致：只含本部分改动的工作树中 state layout 检查通过（新增的
  `CALLS` 已登记），这些目标其余的命令直接运行，全部通过。

### P5 第二部分：整数形式（2026-10-07）

- **范围**：再接入 139 个 VEX.128 形式（共 209 个），都是已有 legacy 语义的整数和类整数形式：
  - 66 0F 的打包整数运算：解包、打包、比较、按 xmm/m128 移位、算术、逻辑（`PackedOp`）。
  - 按 imm8 移位的 VPSRLW/D/Q、VPSRAW/D、VPSLLW/D/Q、VPSRLDQ、VPSLLDQ：目的是 VEX.vvvv，源是
    r/m 寄存器（没有内存形式）。
  - VPSHUFD/HW/LW、VSHUFPS/PD（`ShuffleOp`），VPINSRW、VPEXTRW（C5）。
  - SSSE3 全部 XMM 形式（`simd_int::ssse3`）和 VPALIGNR。
  - SSE4.1/4.2：VPTEST、VPMOVSX/ZX（按扩展宽度访存）、VPMULDQ、VPCMPEQQ/GTQ、VPACKUSDW、
    VPMIN/VPMAX、VPMULLD、VPHMINPOSUW、VBLENDPS/PD、VPBLENDW、VMPSADBW、VPEXTRB/W/D/Q、
    VEXTRACTPS、VPINSRB/D/Q、VINSERTPS。
  - VPBLENDVB：掩码寄存器由 imm8[7:4] 给出，非 64 位模式下只用 imm8[6:4]。
  - VPCMPESTRx/VPCMPISTRx：64 位模式的 VEX.W1 形式长度取 RAX/RDX；ECX 零扩展；xSTRM 写 XMM0
    并清零其高半。
- 都在共享执行器中实现，复用 `simd_int`、`ir::simd` 的值级函数。IR、Tier-0、x64 和 page tier
  的路径不变（第一部分的 helper、step）。剩余的 87 个 VEX.128 形式是浮点（第三部分）和 AVX 新增
  的 128 位形式（第四部分）。
- **测试**：
  - `tests/rust/avx_model.mjs` 新增这些形式，语义由已有的独立模型给出（`packed_model.mjs`、
    `shuffle_model.mjs`、`ssse3_model.mjs`、`sse4_model.mjs`），按 VEX 的操作数组织；新增 kind：
    `load_imm`、`binary_imm`、`shift_imm`、`ptest`、`extract`、`insert`、`insertps`、`blendv`、
    `pcmpstr`。
  - `tests/rust/avx.mjs`：每个形式 32 例，imm8 在各例间轮换；VPTEST 和 VPCMPxSTRx 检查标志（之前
    置位 OF、SF、AF、CF），VPCMPESTRx 的显式长度含负数和极值；页末的窄操作数加入 VPMOVSXBQ、
    VPMOVZXDQ、VPINSRB、VINSERTPS、VPEXTRB、VPEXTRW；新增 #UD：VPBLENDVB 的 VEX.W1、按 imm8
    移位的内存形式、VPEXTRW（C5）的内存形式、VPSHUFD 的 VEX.vvvv。共 188 个形式、6030 项。
  - `tests/x64/avx.mjs`：1548 例（含 W1 的 64 位形式，长度超过 32 位的 VPCMPESTRx）。用例数增加后
    结果区彼此重叠，改了内存布局；VPCMPxSTRx 的内存操作数不再用 RCX 作 index（它先被置为全 1）。
  - IR fixture 增加 10 个形式：标志、通用寄存器结果、VEX.vvvv 作目的、imm8[7:4] 作寄存器、
    VPCMPxSTRx 写 ECX/XMM0；区域与解释器对比 2013 项。
  - 植入 7 个错误，全部被发现：按 imm8 移位写到 ModRM.reg、非 64 位模式下 is4 用 4 位、VPCMPESTRx
    忽略 VEX.W1、VPINSRB 不截断通用寄存器、VPTEST 的 ZF/CF 对调、VPEXTRW（C5）的 imm8 只用 2 位、
    VPMOVSX/ZX 按 16 字节访存（由页末用例发现）。
- **发现的旁支问题**：启用 JIT 时，客体物理地址 0x3FFEA0 处有 8 字节非零数据
  （0x0020000A00400010），即使客体只运行整数循环；解释执行时没有。起初以为是 page tier 的写入，
  单独立项调查后查明是开机时 RAM 就不为零：客体 RAM 分配在 Tier-0 编译器刚释放的堆块上，残留了
  分配器的块头（修复与 `tests/x64/initial_ram.mjs` 由那个会话提交）。`tests/x64/avx.mjs` 的
  原始内存对比不覆盖这段地址。

### P5 第三部分：浮点形式（2026-10-07）

- **范围**：再接入 76 个形式（共 285 个）：
  - VSQRT/VADD/VMUL/VSUB/VMIN/VDIV/VMAX 的 PS/PD/SS/SD，VHADD/VHSUB、VADDSUB 的 PS/PD，VRCPPS/SS、
    VRSQRTPS/SS；
  - VCMPPS/PD/SS/SD 的 32 个谓词，VCOMISS/SD、VUCOMISS/SD；
  - 转换：VCVTSI2SS/SD 和 VCVT(T)SS2SI/SD2SI（64 位模式下 VEX.W1 用 64 位整数），VCVTPS2PD、
    VCVTPD2PS、VCVTSS2SD、VCVTSD2SS、VCVTDQ2PS、VCVT(T)PS2DQ、VCVTDQ2PD、VCVT(T)PD2DQ；
  - VROUNDPS/PD/SS/SD、VDPPS/VDPPD、VBLENDVPS/VBLENDVPD（掩码寄存器同 VPBLENDVB）。
- 语义沿用 `simd_fp` 的精确实现（P4a）：标量形式的其余 lane 取自第一源，未屏蔽的异常为 #XM
  （无 CR4.OSXMMEXCPT 时 #UD），目的寄存器不变。
- **32 个比较谓词**：`Fp::compare` 改为接受 imm8[4:0]。imm8[3:0] 决定关系（有序时只看 imm8[2:0]，
  所以已有的快速路径对全部谓词都正确），imm8[4] 交换 quiet 与 signaling。`simd_fp::compare` 是
  VEX 的入口；legacy 的 `arithmetic` 只取 imm8[2:0]，忽略其他位。
- 剩下 11 个 AVX 新增的 128 位形式（VBROADCASTSS、VPERMILPS/PD、VTESTPS/PD、VMASKMOVPS/PD）
  在第四部分。
- **测试**：
  - `tests/rust/sse_fp.mjs` 的形式表、特殊值、MXCSR 设置与按模型求期望值的部分移到
    `tests/rust/sse_fp_cases.mjs`，供 legacy 与 VEX 两个测试共用。`sse_fp_model.mjs` 改用 SDM
    CMPPD 表 3-1 写成的 32 项谓词表 `PREDICATES`。legacy CMP 的用例在 imm8[7:3] 也置位，检查它们
    被忽略。
  - 新增 `tests/rust/avx_fp.mjs`：68 个 VEX 浮点形式（legacy 形式去掉 MMX 的六个），目的为 XMM2、
    第一源为 XMM1、第二源为 XMM0 或内存，VCMP* 覆盖 32 个谓词；11 种 MXCSR 设置，#XM 与 #UD 两种
    异常交付。三个 arm 上 117920 例。
  - `tests/rust/avx_model.mjs` 由 `sse_fp_cases.mjs` 生成浮点形式（kind `fp`，按操作数分为单源、
    双源、标志、到/从通用寄存器）。`tests/rust/avx.mjs` 中 MXCSR 的异常位总是屏蔽：258 个形式、
    8270 项；页末的窄操作数加入 VADDSS、VCVTSD2SS、VCVTPS2PD、VROUNDSD、VCOMISS。
  - `tests/x64/avx.mjs`：2132 例。VRCPPS 等近似指令与 QEMU 按误差比较（各自在 1.5×2⁻¹² 之内，
    彼此相差不超过 2⁻¹⁰，特殊值精确）。每个用例都记录意外的异常并跳过，不再因 QEMU 的 #UD 卡住。
  - IR fixture 增加 10 个浮点形式，差分配置增加三种 MXCSR（全部不屏蔽、DAZ 与 FZ、向下舍入）：
    3429 项比较。
  - 植入 11 个错误，全部被发现：转换忽略 VEX.W1、VCOMIS 操作数对调、VROUNDSS 的其余 lane 取自
    目的、VDPPS 当作双精度、VBLENDVPS/PD 对调、标量运算的第一源取 ModRM.reg、无序时的谓词表、
    imm8[4] 不交换 signaling、VEX 只取 imm8[2:0]、legacy CMP 不忽略 imm8[7:3]、标量形式按 16 字节
    访存（由页末用例发现）。
- **回归**：`p5c-batch` 的 55 个目标中 50 个通过，`avx-tests` 含新的 `avx_fp.mjs`（三种构建），
  `sse-fp-tests` 跑的是重构后的 `sse_fp.mjs`。另外 5 个仍是另一个会话的 `mmio_ram.rs` 所致，
  它们其余的命令直接运行，全部通过。第二部分回归中 `sse-fault-tests` 在 debug 构建的 regions
  arm 上失败过一次（MOVDQ2Q 的 #UD 报在下一条指令），单独重跑三次和这次回归都通过，暂按偶发处理。

### P5 第四部分：AVX 新增的 128 位形式（2026-10-07）

- **范围**：最后 11 个形式，P5 的 296 个 VEX.128/VEX.LIG 形式至此全部接入（VEX.L=1 的形式在 P6）：
  - VBROADCASTSS xmm, m32；
  - VPERMILPS/PD：按第二源每个 dword 的 bit 1:0（每个 qword 的 bit 1）或按 imm8 选取第一源的 lane；
  - VTESTPS/PD：只看各 lane 的符号位，ZF、CF 的定义同 PTEST，AF、OF、PF、SF 清零；
  - VMASKMOVPS/PD 的加载与存储。
- **VMASKMOV**：`Machine` 增加 `read_lanes`/`write_lanes`，按掩码（VEX.vvvv 各 lane 的符号位）
  逐 lane 访存。
  - 未选中的 lane 不访问：不产生故障，不置 A/D 位，加载时为零。这符合第 8 节“v86 固定一种
    行为（建议不设置）”。
  - 存储先对每个选中的 lane 做写检查，全部通过后才写，故障时内存不变。
  - 32 位解释器与 regions（`ir_avx_continue`）用 `safe_read32s/64s` 与 `writable_or_pagefault`，
    x64 用 `memory::read` 与 `probe_write`。
- **测试**：
  - `tests/rust/avx.mjs`：269 个形式，三个 arm 上 8637 项。
    - 页末窄操作数的用例加入 VBROADCASTSS。
    - VMASKMOVPS/PD 的四个形式跨入缺页：那里的 lane 未选中时不产生故障，结果与模型一致。
    - 选中缺页上的 lane 时报告 #PF，CR2 为该 lane 的地址，存储不写任何 lane。用例同时选中
      缺页之前的 lane（PS 的 lane 0、1，PD 的 lane 0）。
    - 加载与存储只置选中 lane 所在页的 A 位（存储还有 D 位），另一页的 A/D 位不变。
  - `tests/x64/avx.mjs`：2220 例，三种配置。
  - `tests/x64/vector_oracle.mjs` 新增 10 例 VMASKMOV 跨页，解释执行与 tier0 各跑一遍。QEMU 10.2
    的两处差异（11.1 节）由其中 5 例按 SDM 单独判定，含 CR2、错误码和“不留部分存储”。这个
    oracle 的 v86 配置因此打开 AVX 等能力，其余用例的结果不变。
  - IR fixture 增加 6 个形式，共 4047 项比较。
  - 植入 11 个错误，全部被发现：VBROADCASTSS 读 16 字节（页末用例）、VPERMILPS 的两个源对调、
    VPERMILPD 取每个 qword 的 bit 0、VPERMILPS 的 imm8 字段错位、VTESTPD 用 PS 的符号位、
    VMASKMOV 加载读全部 lane、存储的掩码取自 ModRM.reg、存储不先做写检查（缺页用例发现部分
    写入）、VMASKMOVPD 的 lane 间距按 4 字节；x64 引擎的存储不先检查和加载读全部 lane（都由
    `vector_oracle.mjs` 的跨页用例发现）。
- **回归**：`p5d-batch` 的 55 个目标中 50 个通过。另外 5 个仍是另一个会话的 `mmio_ram.rs` 所致
  （state layout 预检查），它们其余的命令直接运行，全部通过；只含本部分改动的工作树中 state
  layout 检查通过。

### P5 第五部分：AVX 热点形式在 Tier-0 和 page tier 的原生模板（2026-10-07）

- **范围**：5.1 节热点清单中 AVX 的 VEX.128/VEX.LIG 形式在 Tier-0 和 x64 page tier 上改为原生模板，
  同类且代价低的形式一并接入：
  - 搬运：VMOVSD/SS（加载、存储、寄存器之间）、VMOVAPD/APS/UPD/UPS、VMOVDQA/DQU、VMOVNT*、
    VMOVQ、VMOVD（64 位模式下 VEX.W1 为 VMOVQ r/m64）；page tier 另有 VLDMXCSR/VSTMXCSR；
  - 逻辑与整数：VXORPD/PS、VANDPD/PS、VANDNPD/PS、VORPD/PS、VPXOR/VPAND/VPANDN/VPOR、66 0F 的
    全部紧缩整数运算（VPCMPEQB/D、VPCMPGTB、VPADDB……）、VUNPCKL/HPS/PD、VSHUFPS/PD、
    VPSHUFD/HW/LW、按立即数移位；Tier-0 另有 VPSHUFB、VPALIGNR、SSE4.1 的单运算形式、
    VPMULDQ、VBROADCASTSS、VMOVHLPS/LHPS、VMOVLPS/HPS/LPD/HPD 的加载形式与
    VMOVDDUP/SLDUP/SHDUP；
  - 浮点：VADD/VMUL/VSUB/VDIV PS/PD/SS/SD；Tier-0 另有 VMIN/VMAX/VSQRT、VRCP/VRSQRT、
    VROUNDxx、VPCMPxSTRx 与全部转换；VCOMISD/VUCOMISD/VCOMISS/VUCOMISS；VCMPPS/PD/SS/SD；
  - VPMOVMSKB、VMOVMSKPS/PD，VBLENDVPS/PD、VPBLENDVB，VZEROUPPER；
  - 标量转换 VCVTSI2SD/SS、VCVT(T)SD2SI/SS2SI、VCVTSD2SS、VCVTSS2SD（page tier 新增，legacy 同用）。
- **做法**：VEX 形式沿用 legacy 形式的模板（`ir/tier0/simd.rs` 的 `classify_vex` 与 `Vex`，
  `x64/pagegen.rs` 的 `vex`）：
  - legacy 读目的寄存器之处改读 VEX.vvvv（第一源）；按立即数移位的源是 r/m 寄存器、目的是
    VEX.vvvv；标量形式的其余 lane 来自第一源；
  - 写目的寄存器后清零其 255:128 位。这一步在指令最后一次重试之后（模板最后才写目的），
    直接写 CPU 状态，不进 Tier-0 的寄存器缓存。Tier-0 每块对每个寄存器只清一次
    （`Page::ymm_zeroed`：块内没有别的代码写这些位，256 位形式是解释器单步，会结束块）；
  - 只有 VMOVAPS/APD/DQA 与 VMOVNT* 检查对齐；
  - 守卫：CR0.TS、CR4.OSXSAVE、XCR0 的 SSE 与 AVX 位；Tier-0 另查保护模式且非虚拟 8086
    模式（IR 在各模式都把寄存器形式的 C4/C5 解成 VEX）。CR0.EM、CR4.OSFXSR 不影响。page tier
    每条指令检查（同其 SSE 检查）。Tier-0 在页函数入口算一次（`simd::vex_fault`，只在页内有
    VEX 模板时），每块只读这个局部变量：激活期间这些状态只能由解释器单步改变，而单步改了
    CR0、CR4、模式或 EFLAGS.VM 就退出激活（`runtime::tier0::ir_t0_step` 的上下文为此加入 CR4；
    XSETBV 经 admission barrier 推进 epoch，已在上下文中）；
  - Tier-0 的精确路径（`ir_t0_sse_fp`）以 legacy 键执行，第一源作为目的。
- **legacy 与 VEX 共用的新模板**：PMOVMSKB/MOVMSKPS/MOVMSKPD；CMPPS/PD/SS/SD（两操作数都不是
  NaN 或非规格化数时，按 imm8[2:0] 的关系计算：有序时 32 个谓词只看这三位，且不产生异常；
  否则 Tier-0 走精确路径，page tier 重试）；BLENDVPS/BLENDVPD/PBLENDVB；VZEROUPPER；Tier-0 的
  PMULDQ。page tier 的标量转换在精确或仅不精确时原生执行并置 PE（MXCSR 须为就近舍入且全部
  屏蔽），NaN、非规格化操作数、整数越界、单精度结果溢出或过小时重试。
- **解释器中的 VEX 指令不再是块边界**：32 位解释器经 LES/LDS（C4/C5）的寄存器形式执行 VEX 指令，
  而这两个操作码标为 block boundary，每条 VEX 指令都结束解释执行的一段，其后的指令成为派发入口。
  Tier-0 编译时这些入口都成为块起点，循环被切成每条 VEX 指令一块，XMM 缓存和守卫在每条指令处
  重来，AVX 基准因此比同一源码的 SSE 版慢约一倍。现在 `gen/x86_table.js` 给 C4/C5 标
  `vex_escape`，生成的解释器只在内存形式（LES/LDS）之后调用 `after_block_boundary`。
- regions 中的 VEX 形式仍走完整 reload 的 `ir_avx_continue`（legacy 的 SSE 浮点在 regions 中同样
  走 helper，只有寄存器形式的 ADD/SUB/MUL/DIV 有 MIR 的 `NativeFp`）。原生的 regions 在下一部分。
- **测试**：
  - `tests/rust/avx.mjs`：269 个形式，三个 arm 上 9246（无 Wasm SIMD 的构建 9245） 项。
    - 热点清单中的 46 个形式（`TIER0_HOT` 与浮点的 `TIER0_HOT_FP`，后者用普通操作数）必须由
      Tier-0 模板执行；全部形式中有 170 个走模板。
    - 故障用例等到 Tier-0 跑满 300 轮，此时页已按故障指令之后的入口重新编译，守卫与对齐检查
      由模板执行；未对齐用例先访问一次所在页（未对齐故障不填 TLB，否则模板总是重试）。
    - 解释器中的块边界：程序重写后的那一轮在 Tier-0 机器上基本是解释执行，16 条 VEX 形式的循环
      跑 32 次，派发次数须与同一循环的 legacy 形式相同（`ir_auto_stat(0)`，修复后两者都是 39；
      VEX 指令仍是块边界时为 551）。比较 Tier-0 编译出的块数的写法测不出这个错误：页在热运行中
      编译时，这些入口未必已经记下。
  - `tests/rust/sse4.mjs`：PBLENDVB、BLENDVPS/PD 与 PMULDQ 现在由 Tier-0 模板执行。
  - `tests/ir/differential/tier0_fuzz.mjs` 新增 `s13`：VEX 形式与有新模板的 legacy 形式混合，
    特殊值操作数、各种 MXCSR，比较 YMM 的上半部分；`ir-tier0-tests` 中跑 40 个程序。
  - `tests/x64/avx.mjs`：page tier 的热循环（约 40 个 VEX 形式，20000 轮，普通操作数）与 QEMU
    结果相同，原生执行超过每轮 50 条、单步少于 2000 次；边界循环：精确的转换与相等操作数的
    比较原生执行，不精确的转换（置 PE）与拒绝的操作数（越界，重试后 IE）各一个循环，均与 QEMU
    相同。
- **基准**：`tests/bench` 新增 `avx` profile（`-mavx -mprefer-vector-width=128`）与 715.avx.matmul、
  716.avx.nbody、717.avx.mandel（同 601/606/611 的源码与工作量）；`boot.asm` 在 CPUID 报告 XSAVE
  时置 CR4.OSXSAVE 并设 XCR0（有 AVX 时为 7）。AVX 版执行的指令更少（matmul 4570 万条对 5790 万条），
  所以按耗时比较，不按 MIPS：
  - 修复块边界之前，AVX 版的耗时约为 SSE 版的两倍（715/716/717 为 567/478/684 MIPS）；
  - 修复后（加上守卫每次激活算一次、上半部分每块清一次），负载约 4 时两轮各五次的中位数：
    matmul 40.6–40.7 ms 对 SSE 39.6–40.0 ms（+2%），nbody 71.1–72.6 对 71.1–72.8（持平），mandel
    141.2–142.6 对 143.3–143.6（-1%），都在 12.2 节的 5% 预算内；
  - 只含 VEX 浮点的微基准与 legacy 版相差 2%（1386 对 1411 MIPS）。剩下的差别是每条写 XMM 的 VEX
    指令（每块每个寄存器一次）清零上半部分的存储。
- **变异测试**：模板植入 30 个错误，29 个被发现；剩下的 `pt_demote_tiny`（page tier 的 VCVTSD2SS
  把结果恰为 FLT_MIN 的情形也拒绝）等价，拒绝只多一次重试。后续修正植入 8 个，7 个被发现：
  VEX 的寄存器形式仍调用 `after_block_boundary`（派发次数）、单步上下文不含 CR4、块开始时
  不重置 `ymm_zeroed`、每块只清第一个写到的寄存器（VZEROUPPER 的用例）、守卫不读入口算出的
  条件、入口条件不查 XCR0 或 CR0.TS。剩下一个是上下文中的 XCR0：XSETBV 的 admission barrier
  已推进 epoch，这个字段多余，已删去。
- **未覆盖**：Tier-0 守卫中的实模式与虚拟 8086 模式条件没有 Tier-0 测试（那里的 C4/C5 寄存器形式
  是 #UD 的 LES/LDS）。
- **回归**：`p5f-batch`（含后续修正）的 55 个目标中 50 个通过。另外 5 个仍因另一个会话未完成的
  `mmio_ram.rs`（state layout 预检查）失败，它们其余的 12 条命令直接运行，全部通过；本部分不新增
  Rust static。

### P5 第六部分：regions 中的 VEX 形式（2026-10-07）

- **范围**：regions（IR 的 region 编译）中，VEX.128/VEX.LIG 形式凡有 legacy SSE lifter 的都原生执行：
  搬运（VMOVAPS/UPS/DQA/DQU、VMOVSS/SD、VMOVQ/VMOVD、VMOVHPS/LPS 等）、逻辑、66 0F 与 SSE4.1 的
  紧缩整数运算和比较、解包、洗牌（VPSHUFD/HW/LW、VSHUFPS/PD）、带 imm8 的混合、按立即数移位、
  VPMOVMSKB/VMOVMSKPS/PD、VPEXTRW 与寄存器形式的 VPINSRW；VZEROUPPER 也原生执行（269 个形式中
  119 个的全部用例不经 AVX helper）。XMM 寄存器之间的浮点形式走 `ir_avx_fp_reg_continue`（同
  `ir_sse_fp_reg_continue`：只 reload 目的寄存器，MIR 的 `NativeFp` 原生执行 ADD/SUB/MUL/DIV）。
  其余形式（浮点的内存形式、VLDMXCSR/VSTMXCSR、内存形式的 VPINSRW 等）仍走完整 reload 的
  `ir_avx_continue`；legacy SSE 浮点的内存形式同样走完整 reload 的 helper。热点清单
  中只有 VBLENDVPD（legacy 的 BLENDVPD 也走 helper）与内存形式的 VPSHUFB 仍经 helper。
- **做法**：
  - 新的 HIR 操作 `Op::AvxCheck`：VEX 守卫，`GlobalGuard` 要求 CR4.OSXSAVE、XCR0 的 SSE 与 AVX 位
    和保护模式，排除 CR0.TS 与 EFLAGS.VM，失败时 `ir_avx_guard` 产生 #UD 或 #NM。`GlobalGuard`
    为此推广为多个 required/forbidden 条件。
  - `Op::YmmZero`：写目的寄存器之后清零其 255:128 位，状态图是指令之后的状态（不会出错），
    MIR 的 `EffectPlan::ZeroState` 内联为两次 i64 存储。
  - `IntegerBuilder::vex`（`VexLift`）：legacy lifter 读目的寄存器旧值之处改读 VEX.vvvv
    （`IntegerBuilder::first`）；只有对齐搬运检查对齐。`frontend::avx::native` 选出 legacy 形式
    及其 lifter（含 `simd_lane`），并给出写入的寄存器（存储操作码的寄存器形式写 r/m，按立即数
    移位写 VEX.vvvv，符号掩码与 VPEXTRW 写通用寄存器）。第一源按编码行的 `vex::VVVV`（VEX.vvvv
    是操作数）决定：有它的形式第一源是 VEX.vvvv（按立即数移位则是目的），没有的形式其 legacy
    形式不读目的旧值（整个覆盖的除外）。
  - `XmmLoad`/`XmmBinary`/`XmmShuffle`/`XmmTransferLoad` 增加 `first` 与 `vex`：慢路径（TLB 未命中、
    MMIO）的 helper 由 `mir::memory::slow_register` 打包的参数得到第一源，VEX 形式还清零上半部分。
- **修正**（都由改正后的 regions arm 等待条件发现，见“测试”）：
  - `native` 判断存储形式时调用 `simd_moves::is_store`，它按操作码低字节匹配 0x11/0x29/0x7F，
    PCMPEQQ（66 0F 38 29）也匹配上了，VPCMPEQQ 的上半清零因此落到 r/m 寄存器。现在只对
    `simd_moves` 支持的形式调用它。
  - 第一源原先按 legacy 键列表决定，漏了洗牌 lifter 上的 BLENDPS/BLENDPD/PBLENDW：VBLENDPS
    读成了目的寄存器的旧值。现在按 `vex::VVVV`。
- **测试**：
  - `tests/ir/semantics/avx.rs`：几个代表形式的 helper、`AvxCheck` 个数与清零的寄存器（含
    VPCMPEQQ、11 /r 的 VMOVSS、VPSRLW imm、VPMOVMSKB、VPINSRW、VZEROUPPER）；
    `tests/ir/differential/avx.mjs` 新增 VBLENDPS（第一源不是目的）、VPCMPEQQ、11 /r 的 VMOVSS、
    VPINSRW、VPEXTRW 与 VMOVMSKPS，16 位用例另在虚拟 8086 模式下各跑一遍（那里的 C4/C5 是 LES/LDS，
    寄存器形式 #UD），共 4710 例（含 MMIO、故障、CR0/CR4/XCR0、实模式与虚拟 8086 模式）与解释器
    一致。
  - `tests/rust/avx.mjs` 的 regions arm 原先等 AVX helper 被调用够次数，原生形式不再调用 helper。
    现在等到程序完整的一轮里没有解释执行任何 VEX 指令（`compiled_arms.mjs` 的 `vex_settled`，
    `ir_interpreted_stat` 的新字段 6），并记录 regions 不经 helper 执行的形式；热点形式
    （`REGIONS_NATIVE`）必须如此。只比较相邻两次轮询的写法不可靠：两次轮询之间模拟器可能没有
    运行，VZEROUPPER 这样总走 helper 的形式也被算成原生。三个 arm 上 9246 项（无 Wasm SIMD 的
    构建 9245）。
  - `tests/rust/avx_fp.mjs` 仍等 helper 调用：它的程序是一长串没有循环的用例，regions 约 12 s 后
    才开始编译其中一部分，60 s 内也编译不全；这些操作数（特殊值与内存形式）仍经 helper。
- **性能**：只用 regions（`--ir-setup ir_auto_set_tier0=0`，负载约 3，五次中位数）时，715/716/717 的
  耗时从 1959/3824/3254 ms 降到 957/1277/709 ms（快 2.0–4.6 倍），SSE 版 601/606/611 不变
  （81/1124–1129/560 ms）。与 SSE 版相比，nbody 慢 13%，mandel 慢 26%，matmul 仍慢 12 倍：它的
  循环每轮 4 条 VBROADCASTSS，走完整 reload 的 `ir_avx_continue`（legacy 没有这条指令）。默认
  配置下这些基准只用 Tier-0（第五部分）。待改进（记入 12.2 节）：regions 中原生的 VBROADCASTSS、
  浮点内存形式改用只 reload 必要状态的 helper、同一 region 内重复的 `AvxCheck` 与 `YmmZero`。
- **变异测试**：植入 17 个错误，全部被发现：守卫的五个条件各去掉一个（EFLAGS.VM 那个先存活，差分测试
  加入虚拟 8086 模式的用例后被发现）、`IntegerBuilder::first` 恒为目的、标量合并读目的、第一源不按
  `vex::VVVV`、对齐全部不查或全部都查、按立即数移位与存储的寄存器形式写入的寄存器、`is_store` 不限于
  `simd_moves`、VZEROUPPER 少清一个寄存器、慢路径打包的第一源、`NativeFp` 的第一源与
  `ir_avx_fp_reg_continue` 的 pp 映射。
- **回归**：`p6-batch` 的 55 个目标中 50 个通过。另外 5 个仍因另一个会话未完成的 `mmio_ram.rs`（state
  layout 预检查）失败，它们其余的 12 条命令直接运行，全部通过；只含本部分改动的工作树中 state layout
  检查通过（新增的 `INTERPRETED_VEX` 已归类）。

### P6 第一部分：VEX.256 的数据搬运、逻辑、洗牌、跨半区、测试与掩码形式（2026-10-07）

- **范围**：AVX 的 94 个 VEX.256 形式中的 59 个（47 个助记符）：VMOVUPS/UPD/APS/APD/DQA/DQU、VLDDQU、
  VMOVNTPS/PD/DQ；VMOVSLDUP/SHDUP/DDUP；VUNPCKL/HPS/PD；VAND/ANDN/OR/XOR PS/PD；VSHUFPS/PD；
  VBLENDPS/PD；VBLENDVPS/PD；VPERMILPS/PD；VBROADCASTSS/SD/F128；VINSERTF128、VEXTRACTF128、
  VPERM2F128；VZEROALL；VPTEST、VTESTPS/PD；VMOVMSKPS/PD；VMASKMOVPS/PD（`gen/vex_table.js` 的
  `AVX_256`）。浮点运算与转换的 35 个在第二部分。
- **做法**：
  - 共享执行器的 `execute256`：按半区工作的形式在两个 128 位半区上各执行一次 VEX.128 的语义；
    imm8 中高半区另有位段的形式按 SDM 取（VSHUFPD、VBLENDPD 与 VPERMILPD 的 imm8[3:2]，VBLENDPS 的
    imm8[7:4]）。跨半区的形式（广播、VINSERTF128、VEXTRACTF128、VPERM2F128、VZEROALL）以及
    VPTEST/VTESTPS/PD 与 VMOVMSKPS/PD 的 256 位结果单独实现。
  - `Instruction::l` 改为表示“VEX.256 形式”：各引擎（32 位解释器、IR helper 的 `operands`、x64）只在
    编码行有 `vex::L1` 时置位，VEX.LIG 形式的 VEX.L 不再传入。执行器缺少某个 VEX.256 形式时触发
    断言并产生 #UD，不会悄悄按 128 位执行。
  - `Machine` 增加 32 字节的 `read256`/`write256`：对齐形式要求 32 字节对齐，否则 #GP(0)；存储先
    检查整个 32 字节都可写，故障时不写任何字节。`read_lanes`/`write_lanes` 增加 lane 数参数
    （VEX.256 时 8 个 PS lane、4 个 PD lane）。
  - VZEROALL 在 64 位模式清零 YMM0–15，其他模式只清零 YMM0–7；VEXTRACTF128 写 XMM 寄存器时清零其
    255:128 位。
  - Tier-0、page tier 与 regions 遇到 VEX.256 形式时走解释器单步或 `ir_avx_continue`；原生模板留到
    第三部分。
- **测试**：
  - `tests/rust/avx_model.mjs` 新增 57 个 VEX.256 形式（另有 VMOVMSKPS/PD 的 W1 两行由同一模型
    覆盖）：按半区的形式用 VEX.128 的模型逐半区组合，跨半区的按 SDM 单独实现。
  - `tests/rust/avx.mjs`：326 个形式，三个 arm 上 11072 项（无 Wasm SIMD 的构建 11071 项）。新增用例：
    - 页末的 32 字节操作数；VPTEST、VBROADCASTSD/F128、VINSERTF128/VEXTRACTF128 的窄操作数不越界
      访问。
    - VMASKMOVPS/PD ymm 跨入缺页：未选中的 lane 不访问；选中时 #PF，不写任何 lane。
    - 32 字节加载与存储跨入缺页：#PF，不写任何字节。
    - 对齐到 16 字节但未对齐到 32 字节的对齐形式：#GP(0)。
    - 用例可以设置 YMM 寄存器的上半部分（`uppers`）。
  - `tests/x64/avx.mjs`：2672 例，三种配置下都与 QEMU 和模型一致。兼容模式下 VZEROALL 只清零
    YMM0–7，XMM8–15 保持不变（QEMU 清零全部 16 个，已登记为偏差）。比较兼容模式的 XSAVE 区域时，
    略去 XSAVE 在该模式不写的 XMM8–15 与 YMM8–15 上半部分。用例增多后，这些区域延伸到
    0x5FFEA8；开启 JIT 时，那里有开机时堆分配器留下的头部（`tests/x64/initial_ram.mjs`，另一会话
    正在修复）。
  - `tests/x64/vector_oracle.mjs` 新增 4 个 VEX.256 故障用例：32 字节加载与存储跨入缺页，以及只对齐到
    16 字节的对齐加载与存储（#GP(0)）。跨页存储按 SDM 单独判定（见 11.1 节）。共 974 例，解释执行与
    Tier-0 下都通过。
  - IR 差分测试新增 7 个 VEX.256 fixture（`ir_avx_continue`，含 32 字节内存操作数与 VZEROALL），
    共 5412 例。
- **变异测试**：植入 17 个错误，全部被检出：
  - VSHUFPD 与 VPERMILPD 的高半区用 imm8[1:0]，VBLENDPS 的高半区用 imm8[5:2]；
  - 32 字节对齐只按 16 字节检查；存储前不检查整个 32 字节可写；
  - VPERM2F128 忽略清零位；VEXTRACTF128 写寄存器时不清零上半部分；VZEROALL 保留 XMM 部分；
  - VTESTPS 的 ZF 不看高半区；VMOVMSKPD ymm 高半区的移位；VMASKMOV ymm 的 lane 数；`lane256` 总取
    低半区；VBROADCASTSD 按 32 位而不是 64 位间距复制；VINSERTF128 的 imm8[0] 取反；VEX.LIG 形式传入 VEX.L；
  - x64 的 32 字节对齐与存储前对高 16 字节的检查。这两个最初存活，`vector_oracle.mjs` 加入 VEX.256
    故障用例后被检出。
- **回归**：`p6p1-batch` 的 55 个目标中 50 个通过。另外 5 个仍因另一会话未完成的 `mmio_ram.rs`
  失败，它们的 12 条命令直接运行，全部通过。

### P6 第二部分：VEX.256 的浮点运算与转换（2026-10-08）

- **范围**：其余 35 个 VEX.256 形式，AVX 的 94 个 VEX.256 形式至此全部接入：VSQRT、VADD、VMUL、VSUB、
  VMIN、VDIV、VMAX 的 PS/PD；VHADDPS/PD、VHSUBPS/PD、VADDSUBPS/PD；VCMPPS/PD（32 个谓词）；
  VRSQRTPS、VRCPPS；VROUNDPS/PD；VDPPS；VCVTDQ2PS、VCVTPS2DQ、VCVTTPS2DQ、VCVTPS2PD、VCVTDQ2PD、
  VCVTPD2PS、VCVTPD2DQ、VCVTTPD2DQ。标量形式是 VEX.LIG，VDPPD 没有 VEX.256 形式（VEX.L=1 时 #UD）。
- **做法**：
  - `simd_fp` 的 `operate` 与 `round` 推广到 N 个半区（const generic）。VEX.256 形式的两个半区共用
    一个异常上下文（`arithmetic256`、`round256`），SDM 11.5.3 的顺序作用于全部 8 个（PD：4 个）lane：
    任一 lane 有未屏蔽的计算前异常时，整条指令只记录计算前的标志。分别对两个半区调用 VEX.128 的
    实现做不到这一点。快路径（`fast_half`）逐半区判断，两个半区都满足条件时才走快路径。
  - `convert256`：VCVTDQ2PS/VCVTPS2DQ/VCVTTPS2DQ 转换八个 lane；VCVTPS2PD、VCVTDQ2PD 把 XMM 源
    （m128）的四个 lane 扩展为四个双精度；VCVTPD2PS、VCVTPD2DQ、VCVTTPD2DQ 把四个双精度收窄为
    XMM 结果，并清零 YMM 的上半部分。三类转换都只用一个异常上下文。
  - VHADD/VHSUB 在每个半区内取相邻 lane 对；VDPPS 在两个半区各做一次点积，先算低半区（它的未屏蔽
    异常在高半区运算之前产生故障）；VRCPPS/VRSQRTPS 没有异常，逐半区计算。
  - Tier-0、page tier 与 regions 遇到这些形式时仍走解释器单步或 `ir_avx_continue`。
- **测试**：
  - `tests/rust/sse_fp_cases.mjs` 的模型增加宽度参数：VEX.256 的 lane 数加倍，HADD/HSUB 在每个
    半区内取对，VDPPS 依次计算两个半区（低半区有未屏蔽异常时停止），转换按源和目的的宽度计数。
  - `tests/rust/avx_model.mjs` 从 VEX.128 的浮点形式派生出 35 个 VEX.256 形式（标量形式与 VDPPD
    除外）。`tests/rust/avx.mjs`：361 个形式，三个 arm 上 12193 项。定向用例：VADDPS ymm 在
    MXCSR 0x1F00（只开放 IE）下执行，低半区的 lane 不精确（PE，已屏蔽），高半区有一个 SNaN lane →
    #XM，MXCSR 只记录 IE（0x1F01），XMM 与 YMM 上半部分不变。
  - `tests/rust/avx_fp.mjs`：35 个 VEX.256 形式加入精确用例，检查 256 位结果与 MXCSR。共 142560 例
    （68 个 VEX.128/VEX.LIG 形式、35 个 VEX.256 形式，寄存器与内存源，11 种 MXCSR 设置），三个 arm
    都与模型一致；未屏蔽异常的 #XM 与 #UD（CR4.OSXMMEXCPT=0）两项也覆盖 VEX.256 形式。
  - `tests/x64/avx.mjs`：2952 例，三种配置下都与 QEMU 和模型一致。VRCPPS/VRSQRTPS ymm 的近似值
    按误差比较两个半区。QEMU 对非规格化的源给出精确的倒数（见 11.1 节），按偏差登记。
  - IR fixture 增加 10 个 VEX.256 浮点形式（含 m128 源的 VCVTDQ2PD 与收窄的 VCVTPD2PS），差分
    测试共 6432 例。
- **变异测试**：植入 16 个错误，全部被检出（都由 `avx_fp.mjs` 的精确用例发现）：
  - 两个半区各用一个异常上下文（VADDPS 与 VROUNDPD）；VCMPPS ymm 只取 imm8[2:0]；
  - 高半区 VHADDPS 的输入次序颠倒；快路径只算低半区，或只算第一个 lane；
  - VRCPPS 的高半区读低半区的源；VROUNDPS ymm 不按 imm8 舍入（总按 MXCSR）；
  - VDPPS 的高半区读低半区的第二源，或先算高半区（在全部异常都不屏蔽时被发现）；
  - 转换总从低半区取元素；VCVTPS2DQ、VCVTPD2DQ 截断；转换不记录异常；VCVTDQ2PD ymm 只转两个
    lane；收窄的转换保留 YMM 的上半部分。
- **另行修正**（49e08ed5，回归中发现）：regions 中 MMX 的寄存器 helper 对每个形式都只做 MMX 的
  检查（CR0.EM，然后 CR0.TS）。MOVDQ2Q 与 MOVQ2DQ 涉及 XMM 寄存器，解释器按 legacy SSE 形式检查，
  没有 CR4.OSFXSR 时产生 #UD；region 却执行了它们，再报告下一条指令的 #UD。
  `tests/rust/sse_faults.mjs` 只有在冷启动的那一轮之前，覆盖它们的 region 恰好已经编译好时才失败
  （负载下 4 次中 1 次）。MMX 的 IR 差分测试现在对每个寄存器用例另在 OSFXSR 清零时各跑一次。
- **回归**：`p6p2-batch-a`、`p6p2-batch-b` 的 55 个目标中 50 个通过。另外 5 个仍因另一会话未完成的
  `mmio_ram.rs` 失败，它们的 12 条命令直接运行，全部通过。第一次批次与变异测试、其他构建同时运行，
  负载过高，ssse3、sse3、ir-tier0 超时（单独重跑通过），也正是那次运行暴露了上面 MOVDQ2Q 的问题。

### P6 第三部分：VEX.256 热点形式在 Tier-0 和 page tier 的原生模板（2026-10-08）

- **范围**：5.1 节热点清单中属于 AVX 的 VEX.256 形式只有搬运与 VZEROALL：VMOVDQU ymm 的加载与存储、
  VMOVDQA ymm 的加载与存储、VMOVNTDQ m256、VZEROALL；其余 256 位热点形式属于 AVX2。它们和同类的
  VMOVUPS/UPD/APS/APD ymm、VMOVNTPS/PD m256 一起，在 Tier-0 和 x64 page tier 上改为原生模板。
  其他 VEX.256 形式在 Tier-0 中仍由解释器单步执行，在 page tier 中仍走 step。
- **做法**：
  - Tier-0（`classify_vex256`）：先一次检查整个 32 字节的访问（`tlb_miss(32)`：同一页内的普通 RAM，
    存储还要求可写且页内没有代码），再做两次 v128 访问。对齐形式要求 32 字节对齐，否则重试，由
    解释器产生 #GP(0)。加载读完两个半区才写目的寄存器；存储在检查通过之后才写，不会留下部分写入。
    上半部分直接写 CPU 状态（`store_ymm`），并把该寄存器从 `Page::ymm_zeroed` 中去掉，块内之后的
    VEX.128 写入会再次清零它。VZEROALL 清零 XMM0–7 及其上半部分（Tier-0 不运行 64 位模式的代码）。
  - page tier（`vex256`、`Op::Vmove256`、`Op::Vzeroall`）：先一次查找整个 32 字节的访问
    （`vector_address_bytes`），再按 64 位读写 XMM 与 YMM_Hi128 的状态；VZEROALL 清零 YMM0–15。
    多核（cores in workers）构建中，未对齐的读取先复制到 `pages::BOUNCE` 再读，这个缓冲区从
    16 字节扩为 32 字节。
- **测试**：
  - `tests/rust/avx.mjs`：Tier-0 与 regions 的统计在形式名后加 " ymm"，区分 VEX.256 形式；这 10 个
    名字下的每个形式都必须由模板执行，不能单步。新增定向用例（8 例）：同一块内 VEX.256 搬运与
    VEX.128 形式交替，检查 VEX.256 搬运之后的 VEX.128 写入再次清零上半部分、寄存器之间和内存之间
    两个半区的搬运，以及 VZEROALL。三个 arm 都与模型一致，Tier-0 以模板执行。
  - `tests/x64/avx.mjs`：page tier 的热点循环每轮加入 22 条这些形式与读回检查，全部原生执行
    （共 1797950 条原生、83 次单步）。故障用例加入只对齐到 16 字节的 VMOVAPS/VMOVNTDQ/VMOVDQA ymm
    （#GP(0)）与未对齐的 VMOVDQU ymm（不产生故障）；两种模式共 58 个故障用例，与 QEMU 一致。
  - 新增 page tier 的故障热循环：前面各轮都不出故障，循环由 page tier 编译执行；在相隔一千轮的
    三轮中，分别有一次 32 字节存储跨入缺页（#PF，不写任何字节）、一次只对齐到 16 字节的
    VMOVAPS ymm 加载和一次 VMOVDQA ymm 存储（各 #GP(0)）。处理程序计数并跳过该指令。结果与 QEMU
    一致，只有跨页存储的低半区除外（QEMU 10.2 会写出它，见 11.1 节）。重试之后运行时会解释执行
    一段时间，所以只执行一次的故障指令（如 FAULT_CASES）以及同一轮中故障之后的指令，都不在 page
    tier 编译的代码中执行；三个故障因此分在不同的轮次。
  - `tests/bench` 新增微基准 718.avx.ymm：4 KiB 表上 VMOVDQA/VMOVDQU ymm 的加载、VMOVNTDQ 与 VMOVDQU ymm
    的存储、寄存器之间的 VMOVUPS ymm，以及对低半区做 VEX.128 的 VPXOR、每轮一次 VZEROUPPER。
    第二部分的构建（Tier-0 单步执行这些形式）为 23 MIPS，本部分为 1288 MIPS（约 56 倍；负载约 8）。
- **变异测试**：植入 15 个错误，全部被检出：
  - Tier-0（9 个）：VEX.256 写入之后不清 `ymm_zeroed` 位；加载或存储只按 16 字节检查对齐；加载或
    存储只检查 16 字节的 TLB 范围（跨页时不重试）；存储的高半区写成低半区；VZEROALL 不清上半部分；
    寄存器形式的加载从目的寄存器取上半部分；未对齐形式也检查对齐（每次重试，模板检查发现）。
  - page tier（6 个）：VZEROALL 只清 8 个寄存器；存储两次写低半区；寄存器之间只复制 16 字节；加载
    的上半部分取低半区；只按 16 字节检查对齐，或只查找 16 字节的访问。最后两个起初存活：故障用例
    不在编译的代码中执行，加入上面的故障热循环后被检出。
- **回归**：在只含本计划改动的工作树（第二部分与 MMX 修正之上加本部分）中运行 55 个目标
  （`p6p3-batch-a`、`p6p3-batch-b`），53 个通过，包括在主工作树中被另一会话的 `mmio_ram.rs` 阻塞的
  五个。另外两个（`api-tests`、`jitpagingtests`）需要不在 git 中的 `images/`，在主工作树中加入本部分
  后运行，都通过。

### M2、M3：开放 XSAVE 与 AVX（2026-10-08）

- **含义**：与 M1 相同，公开选项 `cpu_features` 现在接受 XSAVE（XSAVE/XRSTOR、XSETBV/XGETBV，x87 与
  SSE 状态）和 AVX（VEX.128 与 VEX.256 的全部形式和 YMM 状态，需要 XSAVE 与 SSE4.2）。默认 CPU
  配置不变（Q1）。`gen/cpu_features.js` 的 `RELEASED` 为 M1、M2、M3；之后里程碑的能力（AVX2、FMA 等）
  仍会警告。
- **前提**：P2（XSAVE）、P5 与 P6（AVX 的全部形式）已完成；5.1 节热点清单中属于 AVX 的形式在 Tier-0
  和 page tier 上都有原生模板（P5 第五部分、P6 第三部分）。
- **CPU contract**：新增四个 profile：`legacy-xsave`、`x64-xsave`（只请求 XSAVE）和 `legacy-avx`、
  `x64-avx`（x86-64-v2 加 XSAVE 与 AVX）。人工审核结果：
  - 原有六个 profile 不变；MSR 都相同。
  - XSAVE 的 profile 与 `legacy-1`/`x64-1` 只差 CPUID.1:ECX 的 bit 26 和 leaf 0xD（EAX=3，即 x87 与
    SSE；EBX=ECX=576）。
  - AVX 的 profile 与 `legacy-v2`/`x64-v2` 只差 CPUID.1:ECX 的 bit 26、28 和 leaf 0xD（EAX=7；
    EBX=576，即 XCR0 的复位值 1 对应的大小；ECX=832）。
  - 探测时 CR4.OSXSAVE 为 0，所以 OSXSAVE（bit 27）都为 0。
- **发布 gate**：`R-XSAVE` 包括 `platform-contract-tests`、`xsave-tests`、`kvm-unit-test-xsave`；`R-AVX`
  包括 `platform-contract-tests`、`xsave-tests`、`decode-rules-tests`、`x64-decode-tests`、
  `isa-forms-check`、`ir-avx-tests`、`x64-differential-tests`、`x64-page-tier-tests` 和长目标
  `avx-tests`。
- **文档**：`v86.d.ts`、`docs/x86-64.md`。
- **留到 P12**：真实客体验收（11.3 节，如 Linux 用 XSAVE 保存 YMM 状态、glibc 的 AVX 变体），以及
  默认配置的决定（Q1）。
- **测试**：`tests/x64/cpu_features.mjs` 检查 M1–M3 的能力已开放，AVX2 等仍未开放；
  `gen/cpu_features.js --check` 与 `tools/cpu_contract.mjs --check` 通过；`kvm-unit-test-xsave`
  通过（只有 XSAVE 时 15 项，加上 AVX 时 17 项）。gate 的其他目标在 P6 第二、三部分的回归中都已通过。

### P7 第一部分：AVX2 按半区执行的紧缩整数形式（2026-10-08）

- **范围**：AVX2 的 172 个形式中的 105 个，即 VEX.128 整数形式（P5 第二部分）的 VEX.256 版本：66 0F 的
  解包、打包、比较、算术与逻辑；按 xmm/m128 和按 imm8 的移位（含 VPSRLDQ/VPSLLDQ）；VPSHUFD/HW/LW；
  VPMOVMSKB；SSSE3 的 VPSHUFB、水平加减、VPMADDUBSW、VPSIGN、VPMULHRSW、VPABS；SSE4.1 的 VPMULDQ、
  VPCMPEQQ、VPACKUSDW、VPCMPGTQ、VPMIN/VPMAX、VPMULLD、VMOVNTDQA；VPBLENDW、VPALIGNR、VMPSADBW、
  VPBLENDVB（`gen/vex_table.js` 的 `AVX2_256`）。跨半区的形式、AVX2 新增的指令和 gather 在后续部分。
- **做法**：共享执行器的 `execute256` 在两个半区上各执行一次 VEX.128 的语义。按 xmm/m128 的移位
  只读 16 字节的计数，两个半区用同一个计数（取低 64 位）；VMPSADBW 的高半区取 imm8[5:3]；VPBLENDW
  两个半区用同一个 imm8；VPSHUFB 与 VPALIGNR 只在各自半区内取字节；VPMOVMSKB 取全部 32 个符号位；
  VMOVNTDQA 要求 32 字节对齐。按 imm8 移位的逻辑提取为 `shift_imm`，供两种宽度共用。
- **测试**：
  - `tests/rust/avx_model.mjs` 从 VEX.128 形式派生 104 个 AVX2 形式（`isa: "AVX2"`）；`binary` 按
    `f.bytes` 取源（计数移位为 16 字节），`shift_imm` 读整个寄存器。
  - `tests/rust/avx.mjs`：开启 AVX 而不开启 AVX2 时，CPUID.7.0:EBX 不报告 AVX2，它的形式产生 #UD；
    之后各机器开启 AVX2。共 465 个形式，三个 arm 上 15534 项；页末的窄操作数加入计数移位的 m128。
  - `tests/x64/avx.mjs`：3784 例，三种配置下都与 QEMU 和模型一致（新增 832 例）。
  - 按 xmm/m128 计数的移位（VEX.128 与 VEX.256）原先用随机数据作计数：低 64 位几乎总超过元素宽度，
    结果总是 0 或全为符号位，用错计数的高 64 位也看不出来。现在两个测试都给它们小计数（低 64 位
    在元素宽度以下和以上，高 64 位随机）：32 位测试按用例设置寄存器或内存，x64 测试从 `samples`
    中预留的位置读取，寄存器形式先用 VMOVDQU 载入。
  - IR 差分测试新增 9 个 AVX2 fixture，共 7338 例。
  - `src/rust/x64/decode.rs` 的解码测试原先用 VPADDD ymm 检查“没有能力或语义时在 ModRM 之后 #UD”，
    它现在有语义了，改用到 P11 才实现的 VFMADD132PS ymm。
- **变异测试**：植入 12 个错误，全部被检出：66 0F 运算、SSSE3、SSE4.1 形式与 VPALIGNR 的高半区取低半区
  的源；按 imm8 移位与 VPSHUFD 只算低半区；计数移位的高半区取计数的高 64 位（起初存活，上面的小计数
  加入后被检出）；计数读 32 字节（页末用例发现）；VPMOVMSKB 按字取符号位；VMPSADBW 的高半区用
  imm8[2:0]；VPBLENDVB 按 dword 选择；VMOVNTDQA 不检查 32 字节对齐。
- **回归**：在只含本计划改动的工作树（P6 与本部分）中运行 55 个目标（`p7a-batch-a`、`p7a-batch-b`）：
  `x64-decode-tests` 与 `ir-decoder-tests` 先因上面那个解码测试失败，修改后重跑通过；需要 `images/` 的
  `api-tests`、`jitpagingtests` 在主工作树中加入本部分后运行，通过；其余 51 个通过。

### P7 第二部分：AVX2 的跨半区形式、广播、扩展、可变移位与掩码搬运（2026-10-08）

- **范围**：AVX2 其余 51 个非 gather 形式，至此 172 个中只剩 16 个 gather（P8）：VPERMD、VPERMPS、VPERMQ、
  VPERMPD、VPERM2I128、VINSERTI128、VEXTRACTI128；VPBLENDD（xmm/ymm）；VPBROADCASTB/W/D/Q
  （xmm/ymm，源为 XMM 寄存器或内存）、VBROADCASTI128，以及 VBROADCASTSS/SD 的寄存器形式；VPMOVSX/ZX
  的 ymm 形式；VPSRLVD/Q、VPSRAVD、VPSLLVD/Q（xmm/ymm）；VPMASKMOVD/Q（xmm/ymm，加载与存储）。
- **做法**：
  - VEX.128 的 AVX2 形式进入 `execute`，VEX.256 的进入 `execute256`。广播取内存的元素或 r/m 寄存器的
    最低元素（`element`、`splat`）。VPERMD/PS 按 VEX.vvvv 各 dword 的低 3 位、VPERMQ/PD 按 imm8 的
    两位一组跨半区取元素（`permute256`）。VPERM2I128、VINSERTI128、VEXTRACTI128 与 F128 形式共用
    分支。VPBLENDD 的 ymm 形式高半区取 imm8[7:4]。
  - VPMOVSX/ZX 的 ymm 形式从 xmm/m128（m64、m32）扩展到 256 位：低半区由源的前一半元素扩展，高半区由
    后一半扩展；内存只读取这些字节。
  - 可变移位（`shift_variable`）：每个元素按第二源同一元素的无符号计数移位；逻辑移位的计数达到元素宽度
    时结果为 0，VPSRAVD 为符号位。VEX.W1 为 qword。
  - VPMASKMOVD/Q 与 VMASKMOVPS/PD 共用分支，lane 宽度由 VEX.W 决定。
- **测试**：
  - `tests/rust/avx_model.mjs`：AVX2 共 159 个形式（VEX.128 15 个，VEX.256 144 个）；VPERM2F128 与
    VPERM2I128 共用 `vperm2`。
  - `tests/rust/avx.mjs`：520 个形式，三个 arm 上 17315 项；无 AVX2 时的 #UD 用例加入 VPBROADCASTB、
    VPSLLVD、VPERMQ 与 VBROADCASTSS 的寄存器形式；页末的窄操作数加入 VPBROADCASTB/W/Q、
    VBROADCASTI128 与 VPMOVSX/ZX 的 m32、m64、m128；VPMASKMOVD/Q 与 VMASKMOVPS/PD 一样检查跨入缺页时
    未选中的 lane 不访问。可变移位与计数移位一样使用小计数（每个元素在宽度以下和以上）。
  - `tests/x64/avx.mjs`：4224 例，三种配置下都与 QEMU 和模型一致；每例结果区扩到可容纳 5120 例。
  - IR 差分测试新增 16 个 fixture，共 8856 例。
- **变异测试**：植入 13 个错误，全部被检出：VPBROADCASTW 按字节复制；寄存器形式的广播不截取最低元素；
  VPBLENDD ymm 的高半区用 imm8[3:0]；VPSLLVD/Q 不截断元素；VPSRAVD 的计数上限为 30；VPSRLVQ 的计数上限
  按 32；VPERMD 的索引只取两位；VPERMQ 的 imm8 每个元素取一位；VPMOVSX/ZX ymm 的高半区重复低半区，
  或读取 16 字节（页末用例发现）；VPMASKMOVQ ymm 按 dword 选择，VPMASKMOVD/Q xmm 存储按 dword 选择；
  VBROADCASTI128 当作元素广播。
- **回归**：在只含本计划改动的工作树（P6、P7 第一部分与本部分）中运行 55 个目标（`p7b-batch-a`、
  `p7b-batch-b`）：`rustfmt` 起初因 `avx.rs` 未格式化失败，格式化后重跑通过；需要 `images/` 的
  `api-tests`、`jitpagingtests` 在主工作树中加入本部分后运行，通过；其余 52 个通过。

### P7 第三部分：AVX2 热点形式在 Tier-0 和 page tier 的原生模板（2026-10-08）

- **范围**：5.1 节热点清单中 AVX2 的形式：VPMOVMSKB r32, ymm；VPCMPEQB/D、VPADDB、VPANDN、VPMINUB、
  VPCMPGTB、VPAND、VPMINUD、VPOR、VPXOR ymm；VPBROADCASTB/D 的 xmm 与 ymm 形式。同类的形式一并接入：
  66 0F 的其他紧缩整数运算、VPSHUFB 与 SSE4.1 单运算形式的 ymm 版本（计数移位除外）；VMOVMSKPS/PD
  ymm；VPBROADCASTW/Q，以及 VBROADCASTSS/SD（含 AVX2 的寄存器形式）。
- **做法**：
  - Tier-0：
    - `Packed256` 在两个半区上各执行一次 VEX.128 的模板运算。第一源（VEX.vvvv）的两个半区分别来自
      XMM 缓存和 CPU 状态中的上半部分；第二源是寄存器的两个半区，或在一次 32 字节检查之后做两次
      v128 加载。
    - `MoveMask256` 把两个半区的符号位拼成 32 位；`Broadcast256` 取出元素后复制到两个半区。
    - VEX.128 的广播沿用洗牌模板，`source` 取元素宽度，寄存器形式取低位元素。
    - 计数移位（`Packed::Shift`）的计数是一个 128 位操作数，仍由解释器单步执行。
  - page tier：`Op::Vpacked256`、`Op::Vmovmsk256`，以及 `Op::Vbroadcast`（VEX.128 与 VEX.256）。
    VPAND/VPANDN/VPOR/VPXOR 的 ymm 形式用 SIMD 实现，为此新增 `Packed::AndNot`：`v128.andnot` 的
    操作数次序与 PANDN 相反。它们的 VEX.128 形式仍用 i64 的 `Op::Vlogic`。
- **测试**：
  - `tests/rust/avx.mjs`：TIER0_HOT_256 加入 13 个 AVX2 名字，TIER0_HOT 加入 VPBROADCASTB/D，这些名字
    下的每个形式都必须由模板执行；regions 的热点清单不含 AVX2 的广播，它们在 regions 中走 AVX
    helper。完整运行中，Tier-0 以模板执行的形式从 180 个增至 256 个，三个 arm 上 17315 项。
  - `tests/x64/avx.mjs`：page tier 热点循环每轮加入 22 条 AVX2 指令，全部原生执行（共 2218022 条原生、
    11 次单步），结果与 QEMU 一致。起初 VPAND/VPANDN/VPOR/VPXOR ymm 仍被单步执行，因为 page tier 的
    `packed_op` 没有这几个逻辑运算；这是用 `x64_page_profile` 的单步统计找出来的。
  - `tests/bench` 新增 719.avx2.scan：一个仿 strlen 的扫描，用到 13 种 AVX2 形式。第二部分的构建
    （这些形式由 Tier-0 单步执行）为 2 MIPS，本部分为 1740 MIPS。718 在不同调用之间有约 15% 的差异，
    而两个构建为它生成的代码相同（Tier-0 统计一致，wasm 都是 10402 字节），所以属于噪声。
- **变异测试**：植入 12 个错误，全部被检出：
  - Tier-0：高半区取低半区的第二源；第一源的上半部分取 XMM；VPMOVMSKB ymm 的高半区移位；广播按 4
    字节复制；计数移位也按半区执行；VEX.128 广播的源宽度固定为 4。
  - page tier：高半区取低半区的源；`AndNot` 的操作数次序；VPMOVMSKB ymm 的高半区移位；ymm 广播只写
    低半区；xmm 广播不清零上半部分；VPOR 映射成 xor。
- **回归**：在只含本计划改动的工作树（P6、P7 前两部分与本部分）中运行 55 个目标（`p7c-batch-a`、
  `p7c-batch-b`），53 个通过；需要 `images/` 的 `api-tests`、`jitpagingtests` 在主工作树中加入本部分
  后运行，通过。

### P8：AVX2 gather（2026-10-08）

- **范围**：VPGATHERDD/DQ/QD/QQ、VGATHERDPS/DPD/QPS/QPD 的 VEX.128 与 VEX.256 形式（16 个）。至此 AVX2 的
  172 个形式全部实现。
- **做法**：
  - 解码：VSIB 行（`vex::VSIB`）要求 ModRM.rm 为 100b 的内存操作数，以及 32 或 64 位地址大小，16 位地址
    为 #UD（`vex_valid`）。目的、掩码（VEX.vvvv）与索引寄存器必须两两不同，否则 #UD（`vex::UNIQUE`）；
    解释器在读出 SIB 之后检查，x64 解码器也一样。
  - 共享执行器的 `gather` 按 SDM 的操作执行：
    - 先把掩码的每个元素按符号位规范化为全 1 或 0，清零元素之外的部分，然后写回。
    - 再按元素顺序处理：选中的元素读入目的并写回，然后清除该元素的掩码并写回。
    - 全部完成后，清零目的中元素之外的部分。
    - 元素数为向量长度除以数据与索引两者中较宽的一个。
    - 若在元素 k 处故障，k 之前的元素已经完成，k 及之后的元素保持规范化后的原状。重新执行时从剩余的
      掩码继续，不会重复已经完成的读取。
  - 地址为基址加位移（不含索引），再加上符号扩展并按 scale 移位的索引：
    - 32 位地址大小在 4 GiB 处回绕，qword 索引的高 32 位因此不起作用。这包括保护模式、兼容模式，以及
      64 位模式下带 67 前缀的情况。
    - 每个元素使用同一个段：基址寄存器决定的默认段，或段前缀指定的段。64 位模式下 FS/GS 的基址同样
      计入。
    - 非规范地址：以 RSP 或 RBP 为基址时为 #SS(0)，其余为 #GP(0)。
  - 各执行路径：
    - 解释器：`resolve_offset_vsib` 读出 SIB 并计算不含索引的偏移；`Interpreter::gather` 加上元素偏移
      （32 位回绕），逐个元素读取。
    - x64：`Avx::gather` 去掉 `AddressExpr` 中的索引，把元素偏移加到位移上，然后按地址大小截断，再加
      段基址。
    - IR：operands 携带 VSIB 的索引寄存器和 scale；有效地址不含索引，由 AVX helper 逐个元素读取。
  - Tier-0、regions 和 page tier 都不为 gather 生成原生代码，所以不会对整条指令做 RETRY。部分完成的
    状态由 helper 直接写回寄存器。
  - #AC：SDM 说明 gather 不做对齐检查，永远不产生 #AC。v86 没有实现对齐检查（设置 CR0.AM 时只记录警告），
    因此不需要额外处理。
- **测试**：
  - `tests/rust/avx_model.mjs`：加入 16 个 gather 形式。模型逐个读取选中的元素；在 64 位模式以外，
    地址在 32 位回绕。
  - `tests/rust/avx.mjs`（三个 arm 上 17853 项）：
    - 每个 gather 形式的用例有不同的 scale 和正负索引，qword 索引的高 32 位不为零（因此被忽略）。
    - 每个形式都在元素 k 处产生 #PF，检查 EIP、CR2 和部分完成的目的与掩码。映射页面后再次执行，结果
      与不中断的执行相同。
    - 三个寄存器重叠时 #UD，16 位地址时 #UD。
    - FS 段前缀（基址 0x10000）对每个元素生效。
  - `tests/x64/vector_oracle.mjs`：68 个 64 位模式的 gather 用例与 QEMU 比较，在解释器、page tier 和
    Tier-0 三种配置下都通过。登记的 SDM 用例原先只比较 CR2 的低 32 位，现在比较全部 64 位。
    - 常规用例覆盖每个形式的两种宽度、四种 scale，以及以下寻址方式：64 位基址、disp8、disp32、无基址、
      32 位地址大小；索引寄存器包括低位和高位寄存器。目的与掩码先填入可辨认的值，之后读出高半部分。
    - 特殊用例：没有选中任何元素；FS 和 GS 的基址；32 位地址大小在 4 GiB 处回绕；未选中的元素位于缺页
      （不访问）；qword 索引的高 32 位不为零（基址在表下方 4 GiB，截断索引的实现会得到非规范地址）。
    - 故障用例：缺页和跨页元素造成的 #PF（检查部分完成的状态和 CR2）、规范化前的掩码、值为 2^31 的
      qword 索引、非规范地址的 #GP 与 #SS。
    - 无效编码的 #UD：三种重叠、没有 SIB 字节、寄存器操作数。
  - `tests/x64/avx.mjs`：4352 例，其中 gather 128 例（64 位模式与兼容模式），三种配置下都与 QEMU 和模型
    一致；新增两个 gather 故障用例，检查 RIP 与向量；guest 增加了 #PF 门。
  - IR 差分测试新增 4 个 gather fixture（16 位代码加 67 前缀），共 9312 例。差分测试载入较小的索引，
    使页末、MMIO 和缺页用例中的元素分布在页边界两侧，前两个选中的元素索引相同。部分完成的状态和故障
    都与解释器一致。此外直接检查访问策略：元素对齐的 fixture（scale 4 和 8）在 MMIO 上的读取恰好是
    选中元素各一次，按元素顺序，qword 为两次 dword 读取（低半在前），索引相同的元素读两次。
  - QEMU 10.2 与 SDM 的偏差（按 SDM 判定，逐一登记）：
    - 故障时不规范化掩码，也不清零元素之外的掩码。
    - 以 RBP 为基址的非规范地址报 #GP，而不是 #SS。
    - 32 位地址大小不回绕：QEMU 以 64 位加上索引，因此在 4 GiB 以上产生缺页。兼容模式下带随机高半部分的
      qword 索引也受此影响，`tests/x64/avx.mjs` 中这些用例不与 QEMU 比较。
- **变异测试**：植入 23 个错误，全部被检出：
  - 执行器：不规范化掩码（直接按符号选择）；元素之外的掩码到最后才清零；目的在开始就清零元素之外的
    部分；逆序处理元素；元素读入后不立即写回目的；掩码到最后才写回；dword 索引零扩展；元素数不考虑
    索引宽度；scale 只取最低位；每个元素读两次（由上面的访问策略检查检出）。
  - qword 索引截成 32 位再符号扩展：起初存活。oracle 的 2^31 索引用例中，正确地址 80600FF0H 与截断后
    的 FFFFFFFF_80600FF0H 低 32 位相同，而登记用例只比较 CR2 的低 32 位。改为比较 64 位，并加入高 32 位
    不为零的不故障用例后检出。
  - 解码：解释器和 x64 解码器的寄存器重叠检查各缺一项；16 位地址不 #UD。
  - x64：32 位地址大小不回绕；忽略 FS/GS 基址；RBP 基址的非规范地址报 #GP。
  - IR：scale 与索引寄存器的位置取错；有效地址带上索引。
  - 解释器的 VSIB 解析：忽略位移；忽略基址寄存器（这个变异起初写法编译失败，改写后检出）。
- **回归**：在只含本计划改动的工作树（P7 三个部分与本部分）中运行 55 个目标（`p8-batch-a`、
  `p8-batch-b`），53 个通过；需要 `images/` 的 `api-tests`、`jitpagingtests` 在主工作树中加入本部分
  后运行，通过。

### P9：XSAVE 家族扩展（2026-10-08）

- **范围**：XSAVEOPT（`0F AE /6`，内存形式）、XGETBV(1)、XSAVEC（`0F C7 /4`）、XSAVES（`0F C7 /5`）与
  XRSTORS（`0F C7 /3`），以及 IA32_XSS（MSR 0DA0H）。各自的能力位（CPUID.(EAX=0DH,ECX=1):EAX[0..3]）
  在 P1e 已有；它们仍需 `cpu_features_unreleased`，到 M5 开放。64 位模式下带 REX.W 为各自的 64 位形式。
- **做法**（`cpu/xstate.rs`，三个执行路径共用；语义取自 SDM 各指令的 Operation）：
  - XSAVEOPT：标准格式。只存储使用中的分量（init 优化），MXCSR 与 MXCSR_MASK 在 RFBM[1] 或 RFBM[2]
    时总是存储，XSTATE_BV 的规则与 XSAVE 相同。没有实现 modified 优化（SDM 允许不做）。
  - XGETBV(1)：XCR0 AND XINUSE。XINUSE 沿用 P2 的精确计算：MXCSR 不计入，XMM8–15 只在 64 位模式计入；
    x87 的初始配置要求 ST0–ST7 为零，所以 FNINIT 之后 x87 仍算使用中。
  - XSAVEC：压缩格式。存储使用中的分量；MXCSR 不是 1F80H 时也存储 SSE 状态。MXCSR 与 MXCSR_MASK 只随
    SSE 状态存储。XSTATE_BV 为实际存储的分量，XCOMP_BV 为 RFBM 加上第 63 位；头部的其他字节和
    464–511 字节不写。本实现唯一的扩展分量是 YMM_Hi128（256 字节，不要求 64 字节对齐），所以它在压缩
    格式中的偏移与标准格式相同，都是 576。
  - XRSTOR 接受压缩格式（`header_form`），条件是有 XSAVEC，并且 XCOMP_BV[62:0] 在 XCR0 之内、XSTATE_BV
    在 XCOMP_BV 之内、头部 16–63 字节为零，否则 #GP(0)。压缩格式只在载入 SSE 状态时载入 MXCSR，初始化
    SSE 状态时把 MXCSR 置为 1F80H。标准格式的规则不变。
  - XSAVES 与 XSAVEC 相同，只是 RFBM 为 (XCR0 OR IA32_XSS) AND EDX:EAX。XRSTORS 只接受压缩格式，
    XCOMP_BV 须在 XCR0 OR IA32_XSS 之内。两者在 #UD、#NM 之后、操作数的段检查之前检查 CPL，CPL > 0 时
    #GP(0)。
  - IA32_XSS 只在有 XSAVES 时存在。本实现没有 supervisor 分量，所以只接受写入 0，其他值 #GP(0)。它属于
    各模式共用的模型 MSR 表。没有 XSAVES 时，长模式下读写 #GP(0)；32 位配置沿用 v86 对未知 MSR 的旧约定，
    读为 0、写入忽略。
  - CPUID.(EAX=0DH,ECX=1)：有 XSAVEC 时，EBX 为 XCR0 OR IA32_XSS 所含分量的压缩格式大小（576 或 832）；
    ECX、EDX（支持的 IA32_XSS 位）为 0。
  - 解码：XSAVEC、XSAVES、XRSTORS 的行带各自的能力位，寄存器形式 #UD。0F AE /6 与 MFENCE 共用一行，
    XSAVEOPT 的能力在它的处理函数中检查。66、F2、F3 前缀在处理函数中 #UD。IR 由 `fp_state` 的 helper
    （`ir_xsaveopt`、`ir_xsavec`、`ir_xsaves`、`ir_xrstors`）执行。`coverage` 原先把 0F AE /6 的内存
    形式当作 #UD 处理，并且排在 `fp_state` 之前，所以 regions 中的 XSAVEOPT 都是 #UD；现已改正（见下）。
- **测试**：
  - `tests/rust/xsave.mjs`（三个 arm 上 154 项）：
    - 测试框架有两处修正。一是每个检查在热运行（编译代码）和冷运行之后各做一次，这是 P4b 第一部分记下的
      待办。二是每轮先清除故障记录，热运行在一轮结束时停止，热运行的结果因此来自编译代码的最后一轮，
      而不是早先解释执行的某一轮。
    - 新的分节使用同时具有四个能力的机器。每轮保持 XCR0 为 7、CR4.OSXSAVE 置位（由 preamble 每轮写入
      相同的值）。如果程序每轮改变 XCR0，编译 arm 上的这些指令始终由解释器执行（下面的变异测试暴露了
      这一点）。
    - 内容：CPUID.0xD.1；XGETBV(1) 的各种情形；XSAVEOPT 的 init 优化、MXCSR 与部分请求；XSAVEC 存储的
      分量、MXCSR 强制存储 SSE 状态、头部；压缩格式 XRSTOR 的往返、MXCSR 的两条规则；头部的各个 #GP；
      XSAVES 与 XSAVEC 结果相同；XRSTORS 与 XRSTOR 各自恢复 XSAVES 的区域；IA32_XSS 的读写；四条指令的
      #UD（缺 OSXSAVE 时在 #NM 之前）、#NM、未对齐 #GP、前缀 #UD、寄存器形式 #UD，以及头部所在页缺页时
      #PF 且不写任何字节。没有相应能力时各指令 #UD。
  - `tests/x64/xsave.mjs`：第二个 guest 覆盖 XSAVEOPT64/XSAVEOPT、XGETBV(1)（XMM8 只在 64 位模式计入）、
    XSAVEC64/XSAVEC、XSAVES64/XSAVES、XRSTOR64 与 XRSTORS64 恢复压缩区域、IA32_XSS，以及 CPL 3 下
    XSAVES64 和 XRSTORS64 的 #GP(0)：这个 guest 自带含用户段与 TSS 的 GDT，把前 4 MiB 设为用户可访问，
    用 IRETQ 进入 ring 3，再经 DPL 3 的中断门返回。主 guest 加入缺少能力时的 #UD，以及长模式下读写
    不存在的 IA32_XSS 时的 #GP。解释执行和 page tier 各跑一遍。
  - IR fp_state 差分：新增 XSAVEOPT、XRSTORS、XSAVEC、XSAVES 的 fixture，共 736 例。XCR0 改为 3，EAX 请求
    x87 和 SSE（原先 RFBM 为 0，XSAVE 家族实际上不搬运数据）。新增 SSE 状态为初始配置的用例：XSAVEOPT、
    XSAVEC、XSAVES 跳过 SSE 状态，XSAVE 写入 SSE 状态。新增 CPL 3 的用例（用户页和带 ring-0 栈的 TSS）：
    XSAVES、XRSTORS 为 #GP(0)，并且晚于 #NM；XSAVEC 正常执行。
  - IR coverage 差分不再把 XSAVEOPT 的内存形式当作 coverage 形式；`gen/ir_semantics.js` 把它与 0F C7 /3–/5
    的内存形式归入 `CpuFpStateHelper`。
  - `cargo test cpu::xstate`：压缩格式头部的各项规则。
- **客体**：Alpine x86_64（virt 内核，单核，page tier）在两组能力下都启动到 shell，并通过 64 位和 32 位
  探针。工作树只含 P7 第一部分，所以没有打开 AVX2。
  - `SSSE3,SSE4.1,SSE4.2,XSAVE,AVX,XSAVEOPT,XSAVEC,XGETBV1,XSAVES`：内核报告 "Enabled xstate features
    0x7, context size is 832 bytes, using 'compacted' format"。按内核 `XSTATE_XSAVE` 的 alternatives，
    上下文切换使用 XSAVES/XRSTORS；探针收发的实时信号，其信号帧仍用标准格式的 XSAVE/XRSTOR。
  - `SSSE3,SSE4.1,SSE4.2,XSAVE,AVX,XSAVEOPT`：报告 'standard' format，上下文切换使用 XSAVEOPT。
- **变异测试**：植入 34 个错误，全部被检出。第一轮有两个存活：regions 中 XSAVEOPT 不检查能力，以及
  regions 把 XSAVEOPT 分派成 XSAVE。原因是程序每轮执行 XSETBV，编译 arm 实际上没有执行这些指令；
  调整分节后两者都被检出。按指令分：
  - XSAVEOPT 与 XGETBV(1)（13 个）：不做 init 优化；MXCSR 只随使用中的分量存储；XGETBV(1) 不与 XCR0
    相与、不检查能力、64 位模式之外也计入 XMM8–15；三个执行路径各自不检查能力、各自分派成 XSAVE；
    coverage 的分组；未对齐时不 #GP。
  - XSAVEC 与压缩格式的 XRSTOR（15 个）：MXCSR 不是 1F80H 时不强制存储 SSE 状态；不做 init 优化；多写
    头部字节；XCOMP_BV 缺第 63 位；XSTATE_BV 写成 RFBM；载入 MXCSR 的规则；初始化 SSE 状态时不置
    1F80H；去掉 XCOMP_BV 在 XCR0 之内、XSTATE_BV 在 XCOMP_BV 之内、头部保留字节为零这三项检查；不检查
    XSAVEC 能力；CPUID.(0DH,1).EBX 为 0；三个执行路径各自不拒绝前缀。
  - XSAVES、XRSTORS 与 IA32_XSS（6 个）：三个执行路径各自不检查 CPL；XRSTORS 接受标准格式；IA32_XSS
    接受非零值；没有 XSAVES 时 IA32_XSS 仍然存在。
- **回归**：在只含本计划改动的工作树（P7、P8 与本阶段合并）中运行 55 个目标（`p9-batch-a`、`p9-batch-b`）。
  `ir-fusion-tests` 起初失败：`xstate.rs` 的单元测试里有一个赋值之后不再读取，在 `-D warnings` 下编译失败；
  删去后通过。另外 52 个通过；需要 `images/` 的 `api-tests`、`jitpagingtests` 在主工作树中加入本阶段后
  运行，通过。

### P10 第一部分：BMI1、BMI2、TZCNT/LZCNT 与 MOVBE 的语义（2026-10-08）

- **范围**：9.2 节的全部形式：BMI1 的 ANDN、BEXTR、BLSI、BLSMSK、BLSR（VEX 编码）与 TZCNT，BMI2 的
  BZHI、MULX、PDEP、PEXT、RORX、SARX、SHLX、SHRX，LZCNT（只在 x64 配置开放），以及只有内存形式的
  MOVBE（`0F 38 F0/F1`）。能力位在 P1e 已有，仍需 `cpu_features_unreleased`，随 M4 开放。
- **做法**：
  - `cpu/bmi.rs` 给出三个引擎共用的结果与标志，按 SDM 各指令的 Operation 实现。SDM 未定义的标志由 v86
    固定一种取值：AF 为 0，PF 取结果低字节的奇偶，SF 或 OF 未定义时（BEXTR、TZCNT、LZCNT）分别取结果的
    符号和 0。`execute` 先读 r/m 操作数，故障因此发生在任何寄存器改变之前。MULX 先写 VEX.vvvv（低半），
    再写 ModRM.reg（高半），两者是同一个寄存器时高半有效。
  - 32 位解释器：VEX 的 GPR 行（`vex::GPR`）属于异常类型 13，不做 AVX 状态检查；非 64 位模式下操作数
    恒为 32 位，VEX.W 被忽略。`F3 0F BC/BD` 带能力位的两行是 TZCNT/LZCNT，没有能力时仍按 BSF/BSR 执行。
    MOVBE 按操作数宽度做一次访问，寄存器形式 #UD。写入标志后清零 `flags_changed`。
  - IR：新的 lowering 类别 `CpuBmiHelper`，由 `ir_bmi_reg_continue` 和 `ir_bmi_mem_continue` 执行
    （CpuReload；寄存器形式只 reload 标量状态）。实模式和虚拟 8086 模式下 C4 是 LES，VEX 形式在 helper 中
    #UD。
  - x64 引擎（只执行 64 位模式；兼容模式由 32 位解释器执行）：VEX.W1 选 64 位操作数，32 位结果零扩展。
    page tier 原先把 `F3 0F BC/BD` 都当作 BSF/BSR 编译，现在带能力位的这两行改为 step（模板见第二部分）。
- **测试**：
  - `tests/rust/bmi_model.mjs`：独立的 BigInt 位级模型。
  - `tests/rust/bmi.mjs`（三个 arm 上 1534 项）：每个 VEX 形式 96 例，覆盖寄存器与内存操作数、边界值与
    随机值、目的与源的别名、MULX 的 EDX。标志检查 SDM 定义的位和 v86 对未定义位的取值，不修改标志的形式
    检查标志保持不变。TZCNT/LZCNT 与 MOVBE 各测 16 位和 32 位。#UD：VEX.L1、无操作数时 VEX.vvvv 不是
    1111b、VEX 前有 66/F2/F3/LOCK、寄存器形式的 MOVBE。CR4.OSXSAVE 清零或 CR0.TS 置位时不产生 #UD/#NM。
    #PF 无副作用，MOVBE 的存储跨入缺页时不写任何字节。没有能力时 CPUID 不报告，TZCNT/LZCNT 为 BSF/BSR，
    VEX 形式和 MOVBE #UD。
  - `tests/x64/bmi.mjs`：598 例，覆盖 64 位模式和兼容模式（兼容模式含 VEX.W1 的寄存器形式），与模型和
    QEMU 比较，QEMU 只比较 SDM 定义的标志；另有 10 个故障用例。BEXTR 和 BZHI 在每种宽度下覆盖全部控制值和
    索引值。用例循环执行（64 位 200 轮，兼容模式 2000 轮），在解释器、page tier、page tier 加兼容模式的
    Tier-0 下各运行一遍，并断言编译后的代码确实执行了（第二部分加入断言和第三遍：原先 page tier 一遍
    没有检查这一点）。QEMU 10.2 对 VEX.vvvv 不是 1111b 的 RORX 不产生 #UD，登记为偏差。
  - IR：`tests/ir/semantics/bmi.rs` 检查各形式调用对应的 helper、只能用 CPU ABI 编译、没有能力时不调用，
    并生成 236 个 fixture。`tests/ir/differential/bmi.mjs` 用这些 fixture（优化前后）共 3908 例，与解释器
    和模型比较：寄存器与内存操作数、MMIO、跨入缺页、恰好到页尾、空段 #GP、CR0.TS/EM 与 CR4.OSXSAVE 无
    影响、实模式与虚拟 8086 模式。测试还断言 region 本身执行到哪里；否则 region 在入口退出、由解释器补完
    剩余指令，也能通过比较。
  - `tests/rust/decode_rules.mjs`：x86-64-v3 配置下 TZCNT/LZCNT 执行，MOVBE 和 ANDN 不再 #UD。IR 与 x64
    解码器的单元测试原先断言 MOVBE、TZCNT、LZCNT 在实现之前于 ModRM 之后 #UD，现改为：没有能力时如此，
    有能力时完整解码（包括内存操作数的 SIB 字节）。回归批次中这两个单元测试失败，修正后通过。
  - 新目标 `make bmi-tests`、`make ir-bmi-tests`。
- **变异测试**：植入 33 个错误，31 个被检出：
  - 共用语义（17 个）：ANDN 的操作数次序；BEXTR 起点等于操作数宽度；BLSI 的 CF；BZHI 的 CF 与索引
    只取低 8 位；MULX 的写入次序与 EDX；PDEP、PEXT 的位次序；RORX 的回绕；SARX 改为逻辑移位；SHLX 的计数
    模；TZCNT 对 0 的结果；LZCNT 的宽度；计数指令的 CF；PF 的计算范围；没有清零 `flags_changed`。
  - 32 位解释器（5 个）：BMI 也做 AVX 状态检查；16 位 TZCNT 按 32 位计数；LZCNT 的内存形式执行成
    TZCNT；16 位 MOVBE 加载写满 32 位；MOVBE 存储不交换字节。
  - IR（5 个）：不检查实模式/虚拟 8086 模式；操作数宽度恒为 32；VEX.vvvv 只取两位；内存形式不加段基址；
    VEX 形式不进入 BMI helper。
  - x64（6 个）：兼容模式下 VEX.W1 选 64 位；CF 没有清除；BMI 也做 AVX 状态检查；TZCNT 不清除旧标志；
    MOVBE 存储不交换字节；page tier 把 TZCNT 编译成 BSF。
  - 两个存活：BEXTR 起点等于操作数宽度的变异只在 64 位时有区别，x64 测试原先没有“起点 64、长度非零”的
    用例；补上之后（并让 BEXTR、BZHI 在每种宽度下取遍控制值和索引值）检出。兼容模式下 VEX.W1 的变异是等价
    的：x64 引擎只执行 64 位模式，`vector.rs` 中的模式判断恒为真；新增的兼容模式 W1 用例检查 32 位解释器
    忽略 VEX.W1。
- **回归**：与第二部分一起进行，见第二部分。

### P10 第二部分：BMI 热点形式在 Tier-0 和 page tier 的原生模板（2026-10-08）

- **范围**：5.1 节热点清单中 P10 的形式：TZCNT、LZCNT（r32、r64）、SHRX/SARX/SHLX r32、BLSMSK
  r32/r64、BZHI r32/r64、ANDN、BLSR r64，以及 MOVBE r32/r64 的加载。同类的形式一并接入：BLSI、上述形式
  的另一种宽度、MOVBE 存储。MULX、PDEP、PEXT、BEXTR、RORX 与 16 位形式仍单步执行。
- **做法**：
  - Tier-0（32 位操作数）：`Form::Bmi`、`Form::Movbe`。标志沿用逻辑运算的惰性记录（SF、ZF、PF 由结果
    计算，AF、OF 清零），CF 另行写入，这些形式也不再作为可融合的逻辑运算（ANDN 的 CF 为 0，仍可融合）。
    VEX 形式在实模式和虚拟 8086 模式下重试，由解释器产生 #UD（每块检查一次）。Tier-0 只编译 32 位代码，
    所以这个检查只在代码段为 32 位的实模式下起作用；16 位代码由 region 执行，helper 自己检查模式。
  - page tier（64 位模式）：`Op::Bmi`、`Op::Movbe`。ANDN 直接用 AND 的标志。其余形式立即计算需要的
    SF/ZF/PF，CF 总是立即计算；其余标志留作 AND 的惰性记录（两个操作数都是结果），这样惰性计算出的值与
    `cpu::bmi::logic_flags` 相同。page tier 的标志活跃性只是估计，退出、单步或其他代码读取尚在记录中的
    标志时会重新计算，所以记录必须给出正确的值。BSWAP 与 MOVBE 共用 `byte_swap`。
- **测试**：
  - `tests/rust/bmi.mjs`：在 Tier-0 机器上统计每个形式的单步次数，断言模板集合恰好是上述 11 个形式（16 位
    形式和其他形式单步执行）。新增虚拟 8086 模式和 32 位代码段的实模式：循环先在编译代码中运行，然后落到
    ANDN（#UD）或 TZCNT（执行）。共 1538 项。
  - `tests/ir/differential/tier0_fuzz.mjs` 新增 `b` 类：BMI 形式，一半后接 SETcc（多为读 CF 的条件），
    TZCNT/LZCNT 有一半先把源寄存器清零；程序循环 20 倍于默认的次数。`make ir-tier0-tests` 中运行
    40 例，另外跑过 300 例和跨页的 100 例。
  - `tests/x64/bmi.mjs`：page tier 的热点循环。每轮把结果累加到 R14；在每条指令之后立即用 PUSHFQ 取出
    SDM 定义的标志累加到 R13；三个函数以 BMI 指令结束，它们的标志在 RET 之后仍在惰性记录中，由调用者读取。
    294 万条指令原生执行，结果与 QEMU 一致。循环中另有从内存读的 CRC32（与 MOVBE 共用 `0F 38 F0/F1`），
    它在 page tier 中单步执行，每轮三次。
  - 基准 720.bmi.bits（逐个处理字中的置位比特，以及 LZCNT/SHLX/BZHI/BLSMSK/ANDN/SARX/SHRX、MOVBE 加载）：
    第一部分的构建 48 MIPS，本部分 1426 MIPS。基准新增 `cpu_type` 字段（LZCNT 需要 x86-64 配置）。
- **变异测试**：植入 22 个错误，全部检出或确认等价：
  - Tier-0（12 个）：VEX 形式不检查模式；ANDN 不取反；BLSR 与 BLSMSK 的运算对调；BLSI 的 CF；BZHI 的界限
    与 CF；写 CF 后仍把这些形式当作可融合的逻辑运算；MOVBE 存储不交换字节；TZCNT 用 clz；SARX 改为逻辑
    移位；16 位形式也走 32 位模板；不写逻辑标志。
  - page tier（10 个）：ANDN 不取反；BZHI 的界限；BLSI 的 CF；CF 留在惰性记录中；SF 取第 63 位；32 位
    计数按 64 位计算；32 位移位按 64 位计算；MOVBE 存储不交换字节；16 位 TZCNT 走模板；CRC32 的内存形式
    被当作 MOVBE。
  - 第一轮有两个存活。“仍当作可融合的逻辑运算”只在 CF 为 1 时可见，fuzz 的源操作数很少为零，程序也常在
    编译好的页面装入之前就结束（Tier-0 的编译是异步的，阈值为 5 万条指令）。fuzz 改为先清零源寄存器、
    条件多读 CF、循环 20 倍后，40 个程序中有 23 个检出。“CRC32 被当作 MOVBE”是等价变异：CRC32 带 F2
    前缀，page tier 在分类之前就让它单步执行，这个判断只是防御性的。
- **回归**：在只含本计划改动的工作树（P8、P9 与本阶段合并）中运行 57 个目标（`p10-batch-a`、`p10-batch-b`，
  即 P9 的 55 个加上 `bmi-tests`、`ir-bmi-tests`）。`x64-decode-tests` 和 `ir-decoder-tests` 起初失败：两个解码器的
  单元测试仍断言 MOVBE、TZCNT、LZCNT 在 ModRM 之后 #UD（见第一部分），修正后重跑通过。另外 53 个通过；需要
  `images/` 的 `api-tests`、`jitpagingtests` 在主工作树中加入本阶段后运行，通过。

### P11 第一部分：FMA 与 F16C 的语义（2026-10-08）

- **范围**：9.3 节的全部形式。FMA 共 96 个：VFMADD、VFMSUB、VFNMADD、VFNMSUB 的 132/213/231 形式（PS、PD 的
  VEX.128 与 VEX.256，SS、SD），以及 VFMADDSUB、VFMSUBADD 的 132/213/231 形式（PS、PD 的两种宽度）。F16C 共
  4 个：VCVTPH2PS、VCVTPS2PH 的 VEX.128 与 VEX.256 形式。能力位在 P1e 已有，仍需 `cpu_features_unreleased`，
  随 M4 开放。至此每个 VEX 行都有语义。
- **做法**：
  - `cpu/simd_fp.rs` 的 `Fp::fused`：一个通道 x × y + z，只舍入一次（SoftFloat 的 `f32_mulAdd`/`f64_mulAdd`）。
    有 NaN 操作数时不进 SoftFloat：结果是 x、y、z 中第一个 NaN，静默化、不取反，SNaN 报 IE。0 × ∞ 加
    QNaN 得到该 QNaN 且不报 IE（SDM Vol. 1 14.5.2；SoftFloat 的 8086-SSE 规则给出默认 NaN 并报 IE）。
    其余情况先对非 NaN 操作数取反，再交给 SoftFloat：0 × ∞ 与 ∞ − ∞ 是无效运算。输入按 DAZ 处理并报 DE
    （QNaN 操作数或无效运算优先于 DE），输出按 FZ 与 UE 的规则处理，与其他 SSE 浮点运算相同。
  - `simd_fp::fused`：132 为 DEST × SRC3 + SRC2，213 为 SRC2 × DEST + SRC3，231 为 SRC2 × SRC3 + DEST，
    NaN 的优先次序按这三个式子中的 x、y、z（与 QEMU 一致）。ADDSUB 的偶数通道相减，SUBADD 的奇数通道相减。
    整条指令共用一个异常上下文；标量形式的其余通道取自 DEST。
  - F16C：`half_to_single` 精确转换，不受 DAZ 影响、不报 DE，SNaN 报 IE。`single_to_half` 按 imm8[1:0]
    舍入，imm8[2] 置位时用 MXCSR.RC；输入按 DAZ 处理并报 DE；FZ 不起作用，过小的结果给出半精度非规格化数，
    UE 未屏蔽时任何过小的结果都报 UE。
  - SoftFloat 的 `float16_t` 是只有一个 u16 的结构体。clang 用 i32 传递和返回它，高位不定义；Rust 若声明为
    u16，会假定高位已零扩展，结果一个通道的高位溢入了下一个通道（`fma.mjs` 发现）。现在声明为 u32 并显式
    屏蔽。
  - `cpu/avx.rs`：FMA 的 VEX.128/VEX.LIG 与 VEX.256 形式；VCVTPH2PS 从 m64/m128 读取，VCVTPS2PH 写入内存时
    只写 8 或 16 字节，写寄存器时清零其余位。`gen/vex_table.js` 打开 FMA 与 F16C 的行。IR 与 x64 引擎通过
    共用执行器得到这些形式。x64 解码器的测试原先用 VFMADD132PS ymm 作为“没有语义的形式”，这一项已不存在，
    删去。
- **测试**：
  - `tests/rust/sse_fp_model.mjs` 增加 `fused`（精确求和后舍入一次）与半精度转换；`tests/rust/fma_cases.mjs`
    给出形式、特殊三元组（两三个操作数带不同载荷的 NaN；0 × ∞ 加 QNaN、SNaN 或数；有符号零；上溢、下溢、
    非规格化数）以及暴露乘积舍入误差的用例（只舍入一次时结果是误差本身，分两次舍入则为 0）。
  - `tests/rust/fma.mjs`：96 个 FMA 形式与 4 个 F16C 形式，寄存器与内存源，11 种 MXCSR，三个 arm 上共
    42636 例；没有能力时 CPUID 不报告、各形式 #UD。
  - `tests/x64/fma.mjs`：1228 例，64 位模式（XMM0–15、别名、内存操作数）与兼容模式，与 QEMU 和模型比较，
    包括全部异常未屏蔽时的 #XM。QEMU 10.2 与模型在 FMA 的全部规则上一致；与 SDM 不一致之处登记为偏差：
    VCVTPH2PS 对非规格化半精度数报 DE，且在 DAZ 下转为零；VCVTPS2PH 在 FZ 下把过小的结果清零；未屏蔽的
    异常不引发 #XM。这些用例只按 SDM 判定。
  - IR：AVX fixture 增加 7 个 FMA/F16C 形式，差分共 10038 例。
  - 新目标 `make fma-tests`。
- **变异测试**：植入 21 个错误，全部检出：
  - FMA 的语义（12 个）：NaN 的优先次序反向；不检查加数的 NaN；SNaN 不报 IE；NaN 不静默化；NaN 结果随
    加数取反；132、213 的操作数次序（各一个）；ADDSUB/SUBADD 的奇偶通道对调；VFNMADD 取反加数而不是乘积；
    VFMADD132SS/SD 按紧缩形式执行；加数不按 DAZ 处理；结果不经 FZ 与 UE 的处理。
  - F16C（5 个）：VCVTPH2PS 对非规格化半精度数报 DE；VCVTPS2PH 不用 imm8[1:0] 的舍入方式；UE 未屏蔽时
    过小的结果不报 UE；输入不按 DAZ 处理；`f32_to_f16` 的返回值不屏蔽高位。
  - `cpu/avx.rs`（4 个）：标量形式内存操作数的宽度对调；VCVTPS2PH 的 xmm 形式写 16 字节；VCVTPH2PS 的
    ymm 形式只读 8 字节；VEX.256 FMA 高半的第一个操作数取自低半。
- **回归**：与第二部分一起进行，见第二部分。

### P11 第二部分：FMA 在 Tier-0 和 page tier 的模板（2026-10-08）

- **范围**：FMA 的 VEX.128 与标量形式（60 个），其中有 5.1 节热点清单的 VFMADD213SD（libm 中 297 处）、
  VFMADD132SD（182 处）、VFMADD231SD、VFMSUB132SD、VFMADD132PD、VFMADD213PD、VFMSUB231SD、VFMADD213SS。
  VEX.256 形式仍单步执行。
- **做法**：按 9.3 节，双精度走 SoftFloat 的精确路径：模板把目的、第一源与 r/m 操作数写入精确路径的操作数
  块（`T0_SSE_FP` 扩为三个槽），调用 `ir_t0_fma`（`simd_fp::fused`）。未屏蔽的异常使指令重试，由解释器
  产生 #XM。Tier-0 是 `Simd::Fused`，page tier 是 `Op::Vfused`。单精度的“舍入到奇数”快路径需要先在 P0
  验证，没有做。
- **测试**：`tests/rust/fma.mjs` 在 Tier-0 机器上以普通操作数运行每个形式，统计单步次数：60 个形式走模板，
  36 个 VEX.256 形式单步。`tests/x64/fma.mjs` 增加 page tier 热点循环：53.8 万条指令原生执行、12 次单步，
  结果与 QEMU 一致。它的逐例用例改为循环执行（64 位 400 轮，兼容模式 4000 轮），在解释器、page tier、
  page tier 加兼容模式的 Tier-0 下各运行一遍，并断言编译后的代码确实执行了：原先只执行一遍，page tier
  从未编译这些用例（一个页面要先解释执行 2000 条指令才编译）。两个测试的 VEX.128 用例中，目的寄存器的高半
  先置为非零值。
- **基准** 721.fma.poly（多项式的 Horner 求值，用 VFMADD213SD/VFMADD132SD/VFMADD231SD）：第一部分的构建
  17 MIPS，本部分 63 MIPS（x3.67）。每条 FMA 仍调用 SoftFloat 的 `f64_mulAdd`；与 SSE2 的乘法加加法相比
  是否拖慢 libm 的 `_fma` 变体，由 P12 的性能预算判定。
- **变异测试**：植入 12 个错误，全部检出：
  - Tier-0（6 个）：目的与第一源写入操作数块的次序对调；标量形式内存操作数的宽度对调；未屏蔽的异常不重试；
    不传 VEX.W；不清零 YMM 高半；分类时漏掉 231 形式（由模板集合的统计检出）。
  - `ir_t0_fma`（1 个）：不取 VEX.W。
  - page tier（5 个）：操作数块的次序；标量内存操作数的宽度；不重试；不传 VEX.W；不清零 YMM 高半。
  - 第一轮 page tier 的“不重试”和“不清零高半”存活：逐例用例当时只执行一遍，page tier 从未编译它们，
    编译后执行的只有热点循环，而热点循环既没有异常，也不检查高半。逐例用例改为循环执行（见上）之后检出。
- **回归**：在只含本计划改动的工作树（P10 的提交 `2b8b4d0d` 加本阶段）中运行 58 个目标（`p11-batch-a`、
  `p11-batch-b`，即 P10 的 57 个加上 `fma-tests`）。`rustfmt` 起初失败：本阶段的几处长表达式，以及 P10 修正解码
  测试时加入的一行（P10 的回归批次在这一修正之前就跑过了 `rustfmt`）；格式化后通过，`tests/ir/decode/decode.rs`
  的这一行随本阶段提交。另外 55 个通过；需要 `images/` 的 `api-tests`、`jitpagingtests` 在主工作树中加入本阶段后
  运行，通过。主分支其间多了 `d92705b7`（`tier0_fuzz.mjs` 的改进，不涉及本阶段的文件），加入本阶段后
  `make ir-tier0-tests` 也在主工作树中运行，通过。

### P12 第一部分：Linux x86_64 真实客体验收，以及它发现的问题（2026-10-08）

- **范围**：11.3 节的 Linux 部分：x86-64-v3 的整体验收（glibc 的级别、glibc-hwcaps、IFUNC 选中的实现及其结果），
  YMM 状态在上下文切换、信号和迁移中的保持，OSXSAVE 关闭时的负例；以及验收中发现的四个问题（启动变慢、libm
  变慢、vCPU worker 下的非对齐读取、REP MOVS/STOS 逐元素复制）的修正。
- **验收方法**：
  - `tests/x64/linux_glibc.mjs`（`linux_boot.mjs` 的 `X64_LINUX_GLIBC=1`）：P0 用过的 Ubuntu 24.04 glibc 2.39
    （`libc6_2.39-0ubuntu8.9_amd64.deb`，按 SHA-256 固定，没有本地副本时从 Launchpad 下载）的 ld.so、libc 和
    libm，连同 `linux_glibc_probe.c` 一起放进 Alpine x86_64（它本身用 musl），用 glibc 的 ld.so 以
    `--library-path` 运行。探针链接这三个库和 `libhwprobe.so`（`linux_hwprobe.c`，基线构建在库目录，
    `-march=x86-64-v3` 构建在 `glibc-hwcaps/x86-64-v3`；后者确实含 FMA 和 AVX2 指令，前者都没有，由测试检查
    反汇编）。都用 clang 与 rust-lld 交叉构建，不需要 glibc 头文件。
  - 探针报告：`ld.so --help` 的 x86-64-v2/v3/v4 是否 “supported, searched”；ld.so 装入的是哪个
    `libhwprobe.so` 及其计算结果；64 个 IFUNC（libc 的字符串函数，libm 的 sin/cos/expf/fma 等，以及用
    `dlvsym` 取得的 `__exp_finite` 等，它们指向 libm 内部分派的 exp/log/pow）选中的实现在库中的偏移；字符串
    函数在长度 0–300、64 种对齐、字符串紧贴未映射页之前、重叠复制等用例上的结果散列；16 个 libm 函数在 4096 个
    输入（含特殊值）上的结果散列；以及 exp、log、sin、pow、strlen、memchr、memcpy（3936 字节与 16 KiB，都不对齐
    且跨页）和 memset（3936 字节）的耗时。
  - 检查：主机用 `.eh_frame` 找到每个偏移所在的函数，反汇编判断它用 YMM（AVX2 版本）还是 FMA；有 AVX2、BMI1、
    BMI2 和 LZCNT 时 21 个字符串函数必须是 AVX2 版本，有 FMA 时 18 个 libm 函数必须是 FMA 版本，没有 AVX2 时
    任何 IFUNC 都不能选到用 YMM 或 FMA 的实现。同一个探针先在 QEMU 中以相同能力运行（`-cpu` 由能力列表生成，
    厂商、family、model 与 v86 相同，使 glibc 的调优选择一致），v86 的 IFUNC 选择与全部结果散列必须与它相同。
  - `linux_probe.c` 增加 `X64_PROBE_YMM`：内核开启 AVX 时，2 倍于 CPU 数的线程各在全部 YMM 寄存器（64 位 16 个，
    兼容模式 8 个）放入指纹，在一条 asm 语句内依次经过系统调用、`sched_yield`、迁移到另一个 CPU、处理函数改写
    YMM 的实时信号、被其他线程抢占的自旋，然后逐字节比较。32 位探针在兼容模式下同样运行。
  - `linux_boot.mjs`：传 `cpu_type: "x86_64"`（LZCNT 只属于 x64 配置）；命令行有 `noxsave` 时按内核关闭
    XSAVE 处理（依赖 XSAVE 的能力视为不可用）；记录启动到登录提示的时间（`X64_LINUX_LOGIN_MS`）；单步统计把
    VEX 指令按 L、pp、map 和操作码分开（原先只记 C4/C5）。
  - 新目标 `make x64-glibc-tests`：page tier 下 6 种配置：x86-64-v3 加 XSAVE 家族单核、双核并在探针运行中做
    快照保存与恢复、双核并且第二个核在 vCPU worker 中（`X64_PARALLEL=1`，并行构建），只有 AVX，x86-64-v2，
    以及 x86-64-v3 加 `noxsave`。
- **客体结果**（page tier，release 构建；每种配置先在 QEMU 中以相同能力运行同一探针）：
  - x86-64-v3 加 XSAVE 家族，单核：ld.so 报告 x86-64-v2、x86-64-v3 受支持（x86-64-v4 不受支持），装入
    `glibc-hwcaps/x86-64-v3` 下的 `libhwprobe.so`；64 个 IFUNC 中 27 个选中 AVX2 版本、23 个选中 FMA 版本（检查
    要求的 21 个与 18 个都在其中），选择与全部结果散列与 QEMU 相同；YMM 探针在 64 位（16 个寄存器）与兼容模式
    （8 个）下各 2 个线程、80 步、16 次信号，没有一个字节改变。
  - 同样能力，双核：64 位与 32 位探针运行中三次保存并恢复整机（V7 流、V6 缓冲、V7 流，各约 230 MB），结果同上，
    YMM 探针各 4 个线程、160 步、32 次信号。
  - 同样能力，双核，第二个核在 vCPU worker 中：结果同上（修正前 printf 的输出错乱，见发现三）。
  - 只开 AVX（另有 SSSE3、SSE4.1/4.2 与 XSAVE）：ld.so 只报告 x86-64-v2，装入基线的 `libhwprobe.so`，没有 IFUNC
    选中用 YMM 或 FMA 的实现，与 QEMU 相同；YMM 探针照常通过（它只用 AVX 的指令，信号处理函数用 VCMPPS 与
    VXORPS 改写 YMM）。
  - x86-64-v2：同样只有 x86-64-v2 与基线的库，YMM 探针报告没有 AVX。
  - x86-64-v3 加 `noxsave`：内核不置 CR4.OSXSAVE，依赖 XSAVE 的能力都不可用，ld.so 只报告 x86-64-v2，IFUNC 的
    选择与结果与同样命令行的 QEMU 相同，YMM 探针报告没有 AVX。
  - QEMU 一侧：QEMU 10.2 以 `qemu64` 加能力位运行，需要另加 POPCNT、CX16、LAHF_LM，否则 glibc 不报告
    x86-64-v2；用 v86 的厂商与 family/model 时，只有 XSAVE 而没有 XSAVEOPT 的 QEMU 客体内核在初始化 XSAVE 时
    挂起，所以 QEMU 有 XSAVE 时总加上 XSAVEOPT（内核的上下文切换格式不影响探针看到的结果）。
- **发现一：x86-64-v3 下 Linux 启动慢 75%**。启动到登录提示 x86-64-v2 为 24.9 s，x86-64-v3 为 43.5 s（只开 AVX
  为 25.2 s）。单步统计显示 RORX 单步 1.2 亿次，其后是 ymm 的按立即数移位（0F 72、73）、VPALIGNR、VPSHUFD、
  VINSERTI128、VPERM2I128：内核有 AVX2 和 BMI2 时选用 SHA-256/512 的 `*_transform_rorx` 实现（如校验模块签名），
  这些形式在 page tier 没有模板。5.1 节的热点清单只取自 glibc，漏掉了内核的这条路径。page tier 现在为它们生成
  模板：RORX（`BmiOp::Rorx`，不改标志），VPSRLW/D/Q、VPSRAW/D、VPSLLW/D/Q、VPSRLDQ/VPSLLDQ ymm, imm8（两半各自
  移位），VPSHUFD/HW/LW ymm 与 VPALIGNR ymm（两半各自），VINSERTF128/I128（`Op::Vinsert128`），VPERM2F128/I128
  （`Op::Vperm2`）。之后启动中不再有 VEX 指令单步；空闲机器上交替测两次，到登录提示 x86-64-v2 为 24.9 s、
  24.8 s，x86-64-v3 加 XSAVE 家族为 24.4 s、24.8 s。
- **发现二：x86-64-v3 下 libm 变慢**。glibc 选用 libm 的 `_fma` 版本后，每条 FMA 都调用 SoftFloat。P11 的构建中
  只含 FMA 的循环为 25 MIPS（VADDSD 的同样循环为 994 MIPS）。`simd_fp::fused` 现在先走快路径
  （`fused_fast`）：舍入方式为就近时，双精度用 Boldo 与 Melquiond 的方法（Dekker 精确乘积、TwoSum 精确加上
  加数、低位部分按舍入到奇数相加，再就近舍入一次），要求操作数是规格化数且 |x|、|y| 在 2^±450、|z| 在 2^±900
  之内，使所有中间值都是规格化数；单精度在双精度中精确相乘，按舍入到奇数相加后再舍入到单精度（结果过小或溢出时
  不走快路径）。只可能出现精度异常：由 TwoSum 的余项精确判定，未屏蔽且不精确时交给精确路径产生 #XM。三个引擎都
  经过这里。只含 FMA 的循环升到 41 MIPS；空 helper 时为 361 MIPS，剩下的时间是这一串相互依赖的浮点运算本身。
  glibc 探针中每个函数取十次中最快的一次；空闲机器上 x86-64-v2、只开 AVX、x86-64-v3 轮流各测 4 次（已含发现四
  的修正），中位数（ms）：

  | | exp | log | sin | pow | strlen | memchr | memcpy | memcpy 16 KiB | memset |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | x86-64-v2 | 7.70 | 5.31 | 7.25 | 9.86 | 2.65 | 0.72 | 3.36 | 3.30 | 1.01 |
  | 只开 AVX | 5.77 | 5.89 | 7.74 | 9.89 | 2.67 | 1.00 | 1.43 | 1.14 | 1.01 |
  | x86-64-v3 | 9.86 | 8.68 | 14.91 | 18.96 | 1.93 | 0.95 | 2.28 | 1.23 | 1.03 |
  | v3 比 v2 | 1.28 | 1.64 | 2.06 | 1.92 | 0.73 | 1.33 | 0.68 | 0.37 | 1.01 |

  x86-64-v3 下 libm 的 `_fma` 版本仍慢 1.3–2.1 倍，超出 12.2 节的预算（见 12.2 节与 Q1）；字符串函数持平或更快
  （16 KiB 的 memcpy 用 REP MOVSB）。memchr 每次落在约 0.65 ms 或约 1.1 ms 两档之一，三种配置都如此，它们的差别
  在噪声以内。只测一次时各次差别很大（同一配置的 exp 从 12.6 到 23.9 ms），所以改为十次取最快、多次取中位数。
  基准套件中 P12 的构建与 P11 的相比总分 1.002，旧 profile 的负载不受影响。
- **发现三：vCPU worker 下 32 字节的非对齐读取只复制了 8 字节**。x86-64-v3 加并行 vCPU worker
  （`X64_PARALLEL=1`，2 核）时 glibc 探针的 printf 输出错乱（格式串被原样打印、字符错位），后来连 `uname -m`
  的输出也错；不开 worker、只用解释器或只开 x86-64-v2 时都正常。并行构建中客体内存经对齐的原子操作访问，非对齐
  读取由访问缓存的内联代码复制到 `pages::BOUNCE` 再读。P6 第三部分把 BOUNCE 扩到 32 字节、慢路径也复制 32
  字节，但生成代码中的内联复制只处理到 16 字节，32 字节的读取（VEX.256 的内存操作数）只复制前 8 字节，后 24
  字节是上一次读取留下的。glibc 的 AVX2 memcpy、strchrnul 正是这样读取。内联复制现在按大小复制 8、16 或 32
  字节。`tests/x64/avx.mjs` 增加并行构建下的热点循环（双核，另一个核在 vCPU worker 中等待 SIPI，循环由引导处理器
  的编译代码执行）：先以对齐读取让数据页进入访问缓存（只有非对齐读取时它不进缓存，不会走到这段代码），再做
  非对齐的 128 与 256 位读取，与 QEMU 比较；未修正的构建上它在 debug 与 release 下都失败。
  `x64-glibc-tests` 的 vCPU worker 配置即上文的第三种。
- **发现四：x64 解释器的 REP MOVS/STOS 逐元素复制**。只开 AVX 以及 x86-64-v3 加 `noxsave` 时，glibc 探针的
  memcpy 比 x86-64-v2 慢约 20 倍（67–69 ms 对 3.3 ms；修正后只开 AVX 时为 1.4 ms，见发现二的表）。v86 的 CPUID
  是 family 6 model 7，glibc 把 CPUID 报告 AVX 的这种处理器当作 Core i3/i5/i7，置 Fast_Unaligned_Copy，memcpy
  因此改用 `__memmove_sse2_unaligned_erms`：2 KiB 以上用 REP MOVSB（AVX2 版本从 4 KiB 起；memset 的 ERMS 版本
  从 2 KiB 起用 REP STOSB）。默认的 x64 配置没有 SSSE3，glibc 同样选这个版本。page tier 只在两个操作数都不跨页、
  方向向前时内联整段复制，否则单步进入解释器的 `bulk_string`；后者按页分块，块内却对每个元素调用一次 memmove，
  每字节约 8.5 ns。现在块内没有元素读到先前元素的写入时，整块一次复制（与 `cpu::string` 的判断相同：向前复制时
  目的不在源的范围内开始，向后复制时源不在目的的范围内开始），STOS 一次填充；会读到时仍逐元素复制（LZ 式的
  回引）。page tier 中跨页的 REP MOVSB，3936 字节从 33.8 µs 降到约 0.5 µs，16 KiB 从 138 µs 降到 1.3 µs，3936
  字节的 REP STOSB 从 12.9 µs 降到 1 µs 以下。这不是本计划的指令，但开放 AVX 后 glibc 的 memcpy、memset 更常走到
  这里（x86-64-v3 下 4 KiB 以上的复制也走这里），默认配置下 2 KiB 以上跨页的复制和填充同样变快。新测试
  `tests/x64/rep_strings.mjs`（`x64-differential-tests`）与 QEMU 比较 452 例，解释执行与 page tier 各一遍：元素
  宽度 1、2、4、8 字节，两个方向，一个元素到超过一页（解释器分几步完成），源与目的的距离取元素跨度附近的各个
  值；操作数在 4 KiB 页中，各页映射到打乱次序的物理页，与进程的内存一样。
- **快路径的验证**：`cargo test cpu::simd_fp::tests` 在主机上把 2000 万个双精度和 2000 万个单精度用例与硬件 FMA
  （`mul_add`）逐位比较，精度异常与 Boldo–Muller 的精确误差（ErrFma）或精确的 TwoSum 比较；用例包括相消、
  粘滞位，以及专门构造的离中点只差一点的和（x × RN(2^e / x) 与末位为 2^(e+1) 的加数相加；单精度用 3a 这样的
  中点加远小于它的加数）。去掉舍入到奇数时两个测试立即失败（只用随机用例时不会失败，见下）。
- **变异测试**：植入 26 个错误，全部检出：
  - FMA 快路径（9 个）：舍入到奇数的方向反了；准入范围放宽到指数 ±1000；不精确只看第一次 TwoSum 的余项；
    单精度不排除过小的结果；未屏蔽的精度异常不交给精确路径；不检查舍入方式；不置 PE；精确零的符号；取反
    乘积时改成取反加数。
  - page tier（11 个）：ymm 按立即数移位只处理低半、目的取 ModRM.reg、计数边界差一；VPALIGNR ymm 的两个源
    对调；VPSHUFD ymm 的 imm8；VINSERT*128 的高低半对调、保留的一半取自目的；VPERM2*128 不清零、选错一半；
    RORX 的方向与 64 位计数的掩码。
  - REP MOVS/STOS 的整块复制（6 个）：不判断元素间的读写重叠；两个方向的判断对调；向前复制的目的落在源的最后
    一个元素之内时漏判；向后复制时块的起点算错；STOSQ 只写低 32 位；STOSW 少写第一个元素。都由
    `tests/x64/rep_strings.mjs` 检出。
  - 第一轮 VPALIGNR 源对调的变异存活：`tests/x64/avx.mjs` 的 imm8 取 n × 37 + 11，VPALIGNR 的 imm8 多数不小于
    32（结果全零），按立即数移位的计数也多数超过元素宽度。现在 `tests/x64/avx.mjs` 与 `tests/rust/avx.mjs`
    给移位以 0–19 的计数，给 VPALIGNR 以 0–35 的 imm8，之后检出；新增的计数边界变异也由它检出。
- **其他**：`tests/x64/xsave.mjs` 的 page tier 一遍只执行一次，page tier 不会编译这些代码；page tier 没有
  XSAVE 家族的模板（它们单步进入 x64 解释器，即解释执行一遍测的代码），真实客体中内核用 XSAVES/XRSTORS 做的
  上下文切换走的正是这条单步路径，所以不另加循环。
  - 无 `simd128` 的构建（`build/v86-fallback.wasm`）上，`tests/rust/bmi.mjs` 与 `tests/rust/fma.mjs` 的全部用例
    通过；后者末尾按 Tier-0 模板集合计数的检查原先假定有 SIMD 模板，现在没有 Wasm SIMD 时期望全部单步。
  - eslint：本计划的测试中有两处 setter 返回值（`tests/rust/avx.mjs`、`tests/x64/avx.mjs`）、一个驼峰的导入名
    （`tests/rust/avx_model.mjs`）和一个文件末尾的空行（`tests/rust/sse_fp_cases.mjs`），一并修正。仓库中其他
    几处 eslint 错误不属于本计划，另行处理。
- **回归**：在只含本计划改动的工作树（P11 的提交 `8d72c755` 加本阶段）中运行两轮。本阶段中途（`p12-batch-a`、
  `p12-batch-b`）：P11 的 58 个目标加 `x64-glibc-tests`，除需要 `images/` 的 `api-tests`、`jitpagingtests` 外都
  通过，只有 `x64-glibc-tests` 只开 AVX 的一种挂在 QEMU 一侧（见客体结果中 QEMU 的一条），改后通过。全部修正
  之后（`p12-final-a`、`p12-final-b1`、`p12-final-b2`、`p12-final-c`）：同样这些目标，加上 `v86-parallel.wasm`、
  `vcpu-worker.js` 的构建以及 `highmem-tests`、`x64-multicore-tests`（REP MOVS/STOS 的修改涉及它们），
  `api-tests`、`jitpagingtests` 用主工作树 `images/` 的副本在同一工作树中运行，共 63 个，除 `highmem-tests` 外
  都通过。`highmem-tests` 停在 `tests/smp/virtio_high_dma.mjs`：它在 P11 的提交上同样失败（测试替身的 PCI
  对象缺少 PCIe 热插拔加入的 `absent`），与本计划无关，另行处理；这个目标的其余四个文件单独运行都通过。
  `tests/x64/avx.mjs` 在 debug 构建上起初失败：并行构建的一段只给了一个核，而 debug 构建断言并行执行至少有两个
  核；改为两个核（另一个核在 vCPU worker 中等待 SIPI）后 debug 与 release 都通过，未修正的构建上两者都失败。

### M4、M5：开放 x86-64-v3 与 XSAVE 家族；Q1（2026-10-08）

- **开放**：`gen/cpu_features.js` 的 `RELEASED` 包含 M1–M5，所有计划内能力都可直接用于 `cpu_features`，不再需要
  `cpu_features_unreleased`：AVX2、FMA、F16C、BMI1、BMI2、LZCNT、MOVBE（`cpu_type: "x86_64"` 时可用预设
  `"x86-64-v3"`；32 位配置没有 LZCNT，Q7），以及 XSAVEOPT、XSAVEC、XGETBV1、XSAVES。`v86.d.ts`、
  `docs/x86-64.md` 随之更新。
- **CPU contract**：新增 `legacy-v3`（x86-64-v3 的能力去掉 LZCNT）、`x64-v3`、`legacy-xsaves`、`x64-xsaves`
  四个配置，原有 10 个配置逐项核对未变。`x64-v3` 比 `x64-avx` 多出 CPUID.1:ECX 的 FMA、MOVBE、F16C，
  CPUID.7:EBX 的 BMI1、AVX2、BMI2，CPUID.80000001h:ECX 的 LZCNT；`legacy-v3` 同样但没有 LZCNT；两个 xsaves
  配置的 CPUID.(0DH,1):EAX 为 0FH，复位时 EBX 为 576。
- **发布门槛**：`tools/release_gate.mjs` 增加 `R-x86-64-v3`（解码与能力、IR、x64 差分与 page tier、
  `bmi-tests`、`fma-tests`、`avx-tests`、`x64-glibc-tests`）与 `R-XSAVE-ext`（`xsave-tests`、
  `ir-fp-state-tests`、`kvm-unit-test-xsave`、`x64-glibc-tests`）。
- **测试**：`tests/x64/cpu_features.mjs` 不再期望任何能力未开放；新增 x86-64-v3 预设不带
  `cpu_features_unreleased`、32 位配置的 v3 能力集、XSAVE 家族（检查 CPUID.(0DH,1):EAX），以及
  `cpuid_level` 为 7 时 XSAVE 家族随 XSAVE 一起隐藏。
- **Q1 的结论**：新建 VM 的默认 CPU 不变，仍是 v86 一直以来的配置，本计划的能力由 `cpu_features` 显式开启。
  已有客体和快照看到的 CPU 因此不变。依据是 12.2 节在新旧 profile 下的测量（P12 第一部分）：x86-64-v3 下
  启动与 x86-64-v2 相同，glibc 的字符串函数持平或更快，但 libm 选用 `_fma` 版本后 exp、log、sin、pow
  比 SSE2 版本慢 1.3–2.1 倍（FMA 在软件中精确计算），libm 密集的负载开放能力后会变慢。

### P12 第二部分：Windows 8.1 x64 真实客体验收（2026-10-08）

- **范围**：11.3 节的 Windows 部分：64 位与 WOW64 的 AVX 程序，线程与异常上下文中的 YMM 状态，多核，以及快照
  恢复。用用户的 Windows 8.1 Pro x64 映像（只读打开，客体的写入留在内存中）。
- **方法**：
  - `tests/x64/windows_probe.c`（64 位与 WOW64 两个构建，不用 CRT）增加 AVX 部分：CPUID 报告 OSXSAVE 与 AVX
    且 XGETBV(0) 含 SSE 与 AVX 状态时，2 倍于处理器数的线程在全部 YMM 寄存器（64 位 16 个，WOW64 8 个）放入
    指纹，每轮依次：直接存回；迁移到另一个处理器后自旋（期间被其他线程抢占）；执行 UD2，由向量化异常处理函数
    跳过后自旋。全部在一条 asm 语句中完成，之后逐字节比较。64 位探针还在一个线程带着指纹自旋时挂起它，用
    `GetThreadContext`（`CONTEXT_XSTATE`，`InitializeContext`/`SetXStateFeaturesMask`/`LocateXStateFeature`，
    运行时取得）读出它的 XMM 与 YMM 高半并比较。有 AVX2、FMA 时，ymm 上的 VPADDD、VPMULLD、VFMADD231PD 与标量
    结果比较（操作数位数少，结果精确）。结果多一行 `X64_WIN_AVX`。
  - `tests/x64/windows_boot.mjs`：`WIN_CPU_FEATURES` 给出 `cpu_features`（`cpu_type: "x86_64"`）；
    `WIN_PROBE_SNAPSHOT=1` 在每个探针的 AVX 部分开始后保存并就地恢复整机一次。没有 AVX 能力时探针必须报告
    `avx=0`。
- **结果**（page tier，release 构建，x86-64-v3 加 XSAVE 家族时探针线程数为 2N，每个线程 8 轮 × 3 步）：
  - x86-64-v3 加 XSAVE 家族，2 核，AVX 部分开始后各做一次快照保存与恢复（每次约 1.6 GB）：64 位探针 96 步、
    32 次异常、`GetThreadContext` 读出的 XMM 与 YMM 高半正确，WOW64 探针 96 步、32 次异常，YMM 无一改变，
    ymm 上的 AVX2、FMA 运算正确；原有的拓扑、绑核与 4 GiB 以上分配检查照常通过。
  - 同样能力，1 核：两个探针各 48 步、16 次异常，结果同上。
  - 不开放能力，2 核：两个探针报告 `avx=0`，其余检查通过。
  - 在最终构建（含第一部分发现三、发现四的修正，后者改变了 Windows 内核大量使用的 REP MOVS/STOS 路径）上重跑
    第一种配置：桌面在 260 s 出现，两个探针各 96 步、32 次异常，结果同上；映像文件的大小与修改时间不变。

### P12 第三部分：FMA 用融合的 relaxed-simd 乘加（2026-10-09）

- **决定**：P12 第一部分测得 x86-64-v3 下 glibc libm 的 `_fma` 版本比 x86-64-v2 的 SSE2 版本慢 1.3–2.1 倍，
  原因是每条 FMA 都在 helper 中精确计算（`ir_t0_fma`，即使走 `fused_fast` 也约 20 ns）。用户同意放开 9.3 节
  对 relaxed-simd 的禁令：宿主的 `relaxed_madd`/`relaxed_nmadd` 确实融合时用它们计算 FMA。
- **检测**：`cpu.js` 的 `relaxed_fma_fused` 在创建 CPU 时（vCPU worker 中各自）编译一个小模块，对
  f32x4/f64x2 的 `relaxed_madd` 与 `relaxed_nmadd` 各算一次 (1 + ulp) × (1 + ulp) 加上只留下乘积最低位的加数：
  只有融合的运算得到 2^-104（单精度 2^-46），不融合的得到 0。没有 relaxed-simd（模块不能通过验证）或不融合时
  返回 false。结果经 `ir_relaxed_fma_fused` 交给 Rust（`runtime::tier0`）；`ir_set_relaxed_fma(0/1)` 是 A/B 开关
  （1 只在检测到融合时接受），`ir_relaxed_fma()` 报告当前选择。检测对之后编译的代码有效：规范的 relaxed
  运算在同一环境中全局固定为允许结果中的同一种（“each environment globally chooses a fixed projection for each
  operator”）。本机（ARM64）的 Node 25 检测为融合。
- **准入**（`native_fp::fused_refused`，与 7.4 节其他原生浮点的规则一致）：MXCSR 满足 `mxcsr_refused` 的条件
  （所有异常屏蔽、就近舍入、无 DAZ/FZ、PE 已置），每个读到的 lane：三个操作数都不是非规格化数（DE），结果
  有限（排除 IE、OE 和 NaN 的载荷；NaN 与无穷的操作数也由此排除），结果不 tiny（UE），除非是零因子与零加数
  的精确零。这样的 lane 上融合乘加只舍入一次，结果与 `simd_fp::fused` 的精确结果相同，唯一可能的异常 PE 已
  置。被拒绝时（或 MXCSR 不满足）走原来的 `ir_t0_fma`。
- **生成代码**（`native_fp::fused`）：按 132/213/231 选出两个因子与加数；VFMSUB/VFNMSUB 把加数取反
  （`f32x4/f64x2.neg`，精确），VFMADDSUB 取反偶数 lane、VFMSUBADD 取反奇数 lane（异或符号位）；VFNMADD/VFNMSUB
  用 `relaxed_nmadd`。标量形式的其余 lane 取自目的寄存器原值（不是 vvvv），VEX.128 清零 YMM 高半照旧。
  Tier-0（`Simd::Fused`）每个块只算一次 MXCSR 的条件；page tier（`Op::Vfused`）每条指令检查。两者在分支之前
  读入寄存器（Tier-0 的寄存器缓存不能只在一个分支里建立）。regions 中 FMA 仍走 `ir_avx_continue`；VEX.256 的
  FMA 形式仍单步执行。
- **测试**：
  - `tests/rust/fma.mjs`：主体的 42636 例中 MXCSR 为 0x1FA0 的那一组在 Tier-0 中经过原生准入（全部特殊三元组：
    NaN 载荷、0 × ∞、有符号零、上溢、下溢、非规格化数，及暴露乘积舍入误差的用例），与精确模型逐位比较结果和
    MXCSR。Tier-0 一节改为 PE 已置：开着时 60 个模板形式没有一次调用 `ir_t0_fma`（`ir_t0_fma_calls`），关掉后
    每次都调用，两次结果相同。
  - `tests/x64/fma.mjs`：屏蔽异常的 MXCSR 设置加入 0x1FA0，八个完整形式的全部特殊三元组在 page tier 中经过原生
    准入，与模型和 QEMU 比较；热点循环（每轮 13 条 FMA，标量与打包，含 ADDSUB 与零因子零加数的上半 lane）
    开着时 helper 只调用 2 次（PE 置位之前），关掉后 259038 次，和都与 QEMU 相同。
  - `x64-glibc-tests`：glibc 的 `_fma` libm 在 4096 个输入（含特殊值）上的结果散列与 QEMU（硬件精确）相同。
  - 变异测试：植入 16 个错误，全部检出（Tier-0 与生成代码的由 `tests/rust/fma.mjs`，page tier 的由
    `tests/x64/fma.mjs` 中 MXCSR 为 0x1FA0 的用例）：
    - 准入（4 个）：不拒绝非规格化的操作数；不拒绝 tiny 的结果；加数为零即豁免（不要求零因子）；不拒绝非有限的
      结果。
    - 生成代码（6 个）：132 的加数与第二个因子对调；231 的因子与加数顺序错；VFNMSUB 标量形式不取反加数；
      双精度 VFMADDSUB/VFMSUBADD 的奇偶 lane 对调；单精度 ADDSUB 漏掉 lane 2；VFNMADD 当作 VFMADD。
    - Tier-0（3 个）：标量形式不合并目的寄存器的其余 lane；不检查 MXCSR；准入与拒绝颠倒。
    - page tier（3 个）：标量形式不合并；不检查 MXCSR；结果写入 VEX.vvvv 的寄存器。
- **性能**：glibc 探针（P12 第一部分，`X64_LINUX_GLIBC_TIMES=1`）在 x86-64-v2、x86-64-v3、FMA 走 helper
  （`X64_RELAXED_FMA=0`）的 x86-64-v3 之间轮流各测 4 次，中位数（ms）：

  | | exp | log | sin | pow | strlen | memcpy | memcpy 16 KiB | memset |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | x86-64-v2 | 7.92 | 5.74 | 7.65 | 9.81 | 2.65 | 3.33 | 3.29 | 1.03 |
  | x86-64-v3 | 6.25 | 4.17 | 5.56 | 7.05 | 1.98 | 2.32 | 1.06 | 1.10 |
  | x86-64-v3，FMA 走 helper | 9.85 | 8.90 | 15.07 | 19.03 | 1.95 | 2.27 | 1.03 | 1.04 |
  | v3 比 v2 | 0.79 | 0.73 | 0.73 | 0.72 | 0.75 | 0.70 | 0.32 | 1.07 |

  三种配置启动到登录都是 22.7 s。FMA 走 helper 时的比值（exp 1.24、log 1.55、sin 1.97、pow 1.94）与 P12 第一部分
  相符。sin 与 pow 每一轮都是 x86-64-v3 更快；exp 与 log 各有一轮相反（exp 各次波动较大，x86-64-v2 在 5.7 到
  9.7 ms 之间；log 那一轮为 6.16 对 6.11 ms），看中位数。memset 的 1.07 来自 x86-64-v3 的两次受干扰的运行（1.47、
  1.18 ms，同一轮的 strlen、memcpy 也偏慢）；字符串函数与 FMA 的路径无关，FMA 走 helper 的那组中 memset 为
  1.04 ms，与 x86-64-v2 相同。memchr 仍在两档之间跳动，不列。721.fma.poly（32 位，Tier-0 的模板）为 678 MIPS，
  FMA 走 helper 时 67 MIPS。
- **回归**：在只含本计划改动的工作树（`60817b0e` 加本阶段）中运行与 P12 最后一轮相同的 63 个目标
  （`rfma-final-a`、`rfma-final-b1`、`rfma-final-b2`）。`state-layout-check` 起初失败：三个新的 static 没有在
  `gen/state_layout.js` 登记归属，依赖它的 `platform-contract-tests`、`x64-opcode-matrix-tests`、`smp-tests` 随之
  失败；登记后这四个重跑通过（`rfma-final-c`）。其余全部通过，`highmem-tests` 也通过（`tests/smp/virtio_high_dma.mjs`
  已在 `60817b0e` 修正）。`x64-glibc-tests` 六种配置中 glibc 的 `_fma` libm 在原生 FMA 下与 QEMU 结果相同（vCPU
  worker 的配置中，各 worker 自己检测）。
