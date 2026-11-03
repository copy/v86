# D3D 代理 → WebGPU 代码审查与重构建议

审查对象：DirectDraw、Direct3D 1–7、Direct3D 8、Direct3D 9 四个客体前端，以及它们共用的 D9WG 协议和宿主执行器。
基线：v86 `e92fd4f0`（`ios6` 分支，D3D 相关文件与 `master` 相同），retro-gaming-site `43c4d1e`。日期 2026-10-29。
性质：本文保留修复前的审查基线，已提交；后续实施进度记在第 7 节各阶段的状态块。
OpenGL 路径的审查见姊妹篇 [`opengl-webgpu-review.md`](opengl-webgpu-review.md)。两条路径共用传输层和 `webgpu_host.js`，错误捕获与失败策略（本文 S1-1、S1-4）应一起修。

## 0. 结论摘要

1. **最大的问题是错误不可见，而不是某一个功能缺失。**
   - 宿主没有任何 WebGPU 错误捕获：`d3d9-webgpu/` 与 `webgpu_host.js` 中没有 `pushErrorScope`，也没有 `uncapturederror`。
   - 被拒绝的管线会被永久缓存。
   - 命令出错时只按 opcode 告警一次就跳过。
   - 未知 opcode 静默计数。
   - 客体对这些一概不知，仍然拿到 `D3D_OK`。

   GTA SA 的黑屏（平直着色插值不匹配）正是这一类问题。本次找到 **至少 9 种确定会被真实 WebGPU 拒绝的管线/通道构造**（见 §3.1 S1-5、S1-6、S1-7），其中多数是常见状态组合就能触发的。

2. **失败策略在各层互相矛盾：** 单条命令吞掉，单个批处理失败却是永久性的。
   - CPU worker 模式下（站点默认），一次批处理异常会让之后每个批处理都上报“renderer 不可用”。
   - 客体随后把传输标记为永久失败，所有 D3D/DDraw 进程失去图形，也再也无法存档。
   - 另有三条死锁/永久失效路径：
     - `GetData` 无超时；
     - 主机丢帧时不回复查询；
     - 驱动轮询超时后销毁 virtio 传输。

3. **一批常见状态的语义是错的，而现有测试测不出来。**
   - 典型例子：
     - `Clear` 忽略视口；
     - 预变换顶点（XYZRHW）不做透视校正、没有雾；
     - 未绑纹理时 stage 0 的 alpha 被当成 1；
     - ps<3.0 时不加雾；
     - alpha test 精度错误；
     - 开 4x MSAA 即黑屏（从未 resolve）；
     - SM2/3 的谓词寄存器完全无效。
   - 测试审查员做了变异实验：在 12 个一行级语义错误（剔除方向、深度比较、混合因子、`rcp(0)` 等）中，现有 Node 测试只抓到 2 个。
   - 他写的一个 19 个探针的真 GPU 像素页 1.5 秒就发现了 2 个真实错误。我本人在本机 Chrome/Metal 上复跑，结果一致（3 个探针失败）。

4. **“四个前端只是翻译层”只部分成立。**
   - D3D8 不是 DXVK 式包在 D3D9 对象之上，而是把 d3d9 客体代码复制一份再改：
     - 330 个函数中 192 个与 `d3d9_proxy.c` 同名；
     - 约 760 行 ≥95% 相同；
     - 按 6 行窗口比对，约 23% 的有效代码行与 d3d9 原样重复。
   - 后果是修复只落在一份里，另一份保留旧 bug。已确认的例子：纹理分带上传、默认状态表、Present 节流、回读、光标、gamma。
   - DDraw 的宿主侧 `ddraw_ops.js` 是第二套 2D 后端，不是薄映射。
   - 固定管线有三份实现：
     - 宿主 WGSL 生成；
     - 客体 `ProcessVertices`（d3d8、d3d9 各一份）；
     - 已退役但仍在打包和初始化的 `d3d8_executor.js`。

5. **协议由手工在 5 处以上重复定义，已经出现漂移。**
   - `PRESENT_SWAP_CHAIN` 的 width/height 读错偏移。
   - 顶点纹理采样器索引差一（256 vs 257），测试把同样的错误写进了期望值。
   - opcode 10 映射到一个不存在的方法。

对照 Wine 源码（2026-10-29 补充，附录 C）后：

- 有 21 个 S2 条目和 4 个 S3 条目，Wine 的测试在真实 Windows 上钉住了正确行为，我们的实现与之不符；
- 有 11 个条目由 Wine 的实现确认，但没有 Windows 测试；
- 本文原先有 4 处说法需要修正，已在文中改正。

建议的路线是：先止血并让错误可见（阶段 0），再建立真 GPU 像素一致性测试和协议单一来源（阶段 1–2），然后才是执行器拆分和客体共用核心（阶段 3–4）。详见 §6、§7。

### 最该先修的十项

| # | 问题 | 见 |
| --- | --- | --- |
| 1 | WebGPU 错误零捕获，坏管线永久缓存 | S1-4 |
| 2 | 一次批处理失败 → 本会话永久失去图形且不能存档 | S1-1 |
| 3 | `GetData` 无超时 + 主机丢帧不回复查询 → 游戏死锁 | S1-2 |
| 4 | 4x MSAA 从未附加/resolve，开抗锯齿即黑屏（客体却宣称支持） | S1-6 |
| 5 | SM3 着色器在非一致控制流里采样，Chrome(Tint) 拒绝；谓词寄存器完全无效 | S1-7、S2-9 |
| 6 | `BLENDOP MIN/MAX`、线/点 + depthBias、MRT 写掩码等必被拒绝的管线 | S1-5 |
| 7 | `Clear` 清整个目标而不是视口 | S2-1 |
| 8 | XYZRHW 顶点无透视校正、无雾；未绑纹理 stage 的 alpha=1 | S2-2、S2-3 |
| 9 | D3D9 `Reset` 泄漏所有资源，且拒绝 BackBufferCount>1 | S1-9 |
| 10 | d3d9/d3d8 从不发送 `SESSION_END` | S1-10 |

## 1. 范围、方法与标注

### 1.1 审查的代码

| 层 | 文件 | 行数 |
| --- | --- | --- |
| D3D9 客体 | `retro-gaming-site/glbridge/d3d9proxy/d3d9_proxy.c`、`d3d9_protocol.h` | 15 277 + 1 269 |
| D3D8 客体 | `d3d8proxy/d3d8_proxy.c`、`d3d8_protocol.h` | 8 821 + 295 |
| DDraw / D3D1–7 客体 | `ddrawproxy/ddraw_proxy.c`、`d3d7_proxy.inc`、`d3d_legacy_proxy.inc`、`ddraw_protocol.h` | 6 662 + 3 148 + 3 664 + 811 |
| 内核驱动 | `v86gl_driver/v86gl_driver.c`、`virtio_transport.h` | 353 + 292 |
| D9WG 执行器 | `src/browser/glbridge/d3d9-webgpu/d3d9_executor.js` | 12 505 |
| 着色器翻译 | `d3d9_shader_pipeline.js`、`d3d9_shader_worker.js` | 2 472 + 24 |
| DDraw 宿主 | `ddraw_ops.js` | 1 231 |
| 已退役 D3D8 后端 | `d3d8-webgpu/d3d8_executor.js` | 4 472 |
| 传输与集成 | `v86_network_bridge.js`、`v86gl_device.js`、`graphics_proxy.js`、`graphics_journal.js`、`webgpu_host.js`、`graphics_adapters/vmware_svga/svga3d_d9wg.js` | 约 2 300 |
| 测试 | `tests/glbridge/` 中 D3D/DDraw 相关文件，`retro-gaming-site/glbridge/tests/`，`glbridge/sample/*.c` | 约 14 000 |

客体约 3.8 万行 C，宿主约 2.1 万行 JS。

### 1.2 方法

- 按层分给 10 个只读审查子代理，每个负责一块：
  - D3D9 客体前半、D3D9 客体后半；
  - D3D8；
  - DDraw/D3D7；
  - 协议与执行器核心；
  - 资源与表面；
  - 固定管线；
  - 绘制路径；
  - 着色器翻译；
  - 测试体系。
- 各审查员都对照 D3D 规范语义（Microsoft 文档，以及 Wine wined3d/d3d8/d3d9/ddraw 和 DXVK 的实现与测试）和 WebGPU 校验规则。
- 绘制路径、着色器、测试三位审查员在本机 headless Chrome（WebGPU/Metal）里用 error scope 复现了 WebGPU 拒绝。着色器审查员另用 naga 30 生成并校验 WGSL。
- 测试审查员跑了全部 D3D/DDraw 相关测试，做了变异实验，并写了一个像素一致性原型页。
- 我本人逐条复核了最重要的约 40 个结论（见附录 A 的核实记录），并亲自重跑了像素原型页。
- 你同意下载后，我取了 Wine 源码（`66caeb46`），逐项对照本文所有依赖 D3D 语义的条目（附录 C）。
- 子代理的原始英文报告、核实记录、像素原型和变异实验脚本都放在会话共享笔记目录：
  `~/Library/Application Support/Claude/side-session-notes/local_e0809f53-9de5-4887-ac0e-d29f1677b8aa/d3d-review/`

### 1.3 标注

- **✅ 已核实**：我本人读通代码路径确认，或在真 GPU 上复现。
- **☑️ 审查员核实**：子代理读通代码路径或运行复现，我没有逐行复核。
- **❓ 可能**：代码行为已看到，但 D3D 规范语义或触发条件未能核对，或未在客体中运行验证。
- **W**：已对照 Wine 源码（`66caeb46`，2026-10-28）的实现确认。
- **W+**：有 Wine 的一致性测试钉住这一行为；这些测试在真实 Windows 上运行过，是最强的证据。

DXVK 的对照仍只来自记忆，没有核对源码。

路径缩写：

| 缩写 | 路径 |
| --- | --- |
| `E` | `src/browser/glbridge/d3d9-webgpu/d3d9_executor.js` |
| `SP` | `src/browser/glbridge/d3d9-webgpu/d3d9_shader_pipeline.js` |
| `DO` | `src/browser/glbridge/d3d9-webgpu/ddraw_ops.js` |
| `BR` | `src/browser/glbridge/v86_network_bridge.js` |
| `GP` | `src/browser/glbridge/graphics_proxy.js` |
| `G9` | `retro-gaming-site/glbridge/d3d9proxy/d3d9_proxy.c` |
| `PH` | `retro-gaming-site/glbridge/d3d9proxy/d3d9_protocol.h` |
| `G8` | `retro-gaming-site/glbridge/d3d8proxy/d3d8_proxy.c` |
| `GD` | `retro-gaming-site/glbridge/ddrawproxy/ddraw_proxy.c` |
| `D7` | `retro-gaming-site/glbridge/ddrawproxy/d3d7_proxy.inc` |
| `DL` | `retro-gaming-site/glbridge/ddrawproxy/d3d_legacy_proxy.inc` |
| `VT` | `retro-gaming-site/glbridge/v86gl_driver/virtio_transport.h` |

### 1.4 没有覆盖的

- 没有在 XP 客体里运行任何程序。
- 没有读的部分：
  - 着色器翻译器的 PN-triangle/Bezier 数学；
  - `diagnostic_trace.h`、`window_region.h` 的细节；
  - DDraw 的 overlay z 序、`EnumSurfaces`；
  - `svga3d.js` 中与 D9WG 无关的部分；
  - GX/DX 路径。

## 2. 架构现状

```text
game.exe
  ├─ ddraw.dll  (DDraw 1–7 + D3D1–7, 13.5k 行 C)  ─┐
  ├─ d3d8.dll   (D3D8, 8.8k 行 C, 复制自 d3d9)      ├─ 各自一份 transport → v86gl.sys (单 owner) → virtio 0xFFE1
  └─ d3d9.dll   (D3D9, 15.3k 行 C)                  ─┘
                         │ D9WG 命令流（PH，手写）
                         ▼
  v86gl_device.js → graphics_proxy.js → v86_network_bridge.js ── 0xFFE0 → d3d8_executor.js（已退役，仍初始化）
                                                            └── 0xFFE1 → d3d9_executor.js (+ ddraw_ops.js mixin,
                                                                         + d3d9_shader_pipeline.js)
                                                                         ← svga3d_d9wg.js（VMware SVGA 旧 3D）
```

### 2.1 设计意图正确的部分

- D3D8/DDraw 复用 D9WG，而不是各自造后端。
- 只在宿主侧翻译着色器。
- 用重放日志实现存档。
- 能力宣称要有代码支撑。

### 2.2 实现上偏离意图的部分

1. **D3D8 是复制，不是包装。** 修复只落在一份里，另一份保留旧 bug，具体见 S1-12、S2-34、S2-36、S2-40；对照表见 §5.1。
2. **`ddraw_ops.js` 是第二套 2D 后端。**
   - 它有自己的 blit 管线、颜色键着色器、调色板展开和 overlay 合成。
   - 它在原型上 monkey-patch `onSetPalette`/`onDestroyResource`。
   - 它自带一份执行器 `replayBlit` 的超集拷贝，顶点着色器相同。
3. **固定管线三处实现：**
   - 宿主 WGSL；
   - 客体 `ProcessVertices`（d3d9、d3d8 各一份）；
   - 已退役 `d3d8_executor.js`。
   - 客体软件 T&L 的光照模型是简化版：没有 spot 锥，没有材质源，镜面直接拷贝。它与宿主结果不一致。
4. **默认渲染状态存在三处：** 客体表、宿主回退值、D3D8 表。客体的“冗余 Set 过滤”依赖“两边默认值相同”这一隐性约定，但没有任何东西保证它；S2-36 就是它破裂的结果。
5. **协议手写 5 处以上：**
   - `PH`；
   - `E` 的 `OP_*` 常量与字面偏移；
   - `DO`；
   - `svga3d_d9wg.js`；
   - 测试编码器（约 10 套独立的 D9WG 编解码）。
6. **退役的 `d3d8_executor.js` 并未退役。**
   - 0xFFE0 路由仍在。
   - 每次页面加载都会初始化它，并分配 16 MiB 临时 GPU 缓冲和 4 MiB uniform ring。
   - 它在 `Promise.all` 里初始化（`GP:80-84`），失败会拖垮整个 bridge。
   - 它约占 `libv86-webgpu.js` 的 8%。
   - 它仍有 6 个测试文件在 `make test-glbridge` 中跑。
7. **文档与代码漂移：**
   - `retro-gaming-site/docs/d3d9-webgpu-architecture.md` 仍写 vkd3d-shader → SPIR-V → Tint，实际是手写翻译器；`SP` 头注释自称“几百行”，实为 2.5k 行。
   - `d3d9proxy/README.md` 写“protocol 1.3”“最多 4 个流”，与代码不符；它还说 MSAA “由执行器 resolve”——这是错的。
   - `d3d8proxy/README.md` 里的“存档回归”一节已过时：现在所有信封都有日志重放。
   - `G9` 文件头把附加交换链、GetDC、调色板纹理、patch 列为不支持，实际都已实现。
   - `G8` 头注释仍写 “D8WG stream”。
   - `ddrawproxy/README.md` 说“尚未在真实游戏中运行”，但提交历史（`88a6943` “ddraw diablo2 works”、`8f12c3e` “d3d7 3dmark 2000 test pass”、`406a78d` “3dmark99 pass”）显示跑过。不过只走过很窄的路径：全屏独占 8 位 Lock+Flip、D3D7 HAL flip chain、窗口化启动画面。
8. **提交粒度过粗。** 关键代码进库时是“update”“improve”“test”这类大提交，例如 `543abdb` 一次加了 13 194 行。之后很难二分定位或追溯设计意图。

## 3. 问题清单（按严重程度）

- **S1**：整帧或整个会话失效、死锁、黑屏、永久失去图形。
- **S2**：常见游戏中可见的错误渲染或功能失效。
- **S3**：少见路径或较小偏差。

### 3.1 S1 致命

**S1-1 一次批处理失败 → 本会话永久失去图形，且之后无法存档** ✅

- 位置：`E:3534-3543`（`submit` 的 catch 设置 `this.failed`）。
- `this.failed` 只在 `resetForReplay`/`recoverDevice` 中清除。
- `BR:545` `waitForSubmittedBatches` 在之后每个批处理都重新抛出它。
- CPU worker 模式下，`GP:246-252` 调用 `setAvailable(false)`。
- `v86gl_device.js:187` 随后回答 `NO_RENDERER`。
- 客体 `G9:1686-1690` 在 IOCTL 失败时设置 `g_transport_failed = TRUE`，永久生效。
- 触发：任何 `D9WGStreamError`（例如尺寸不符、比主机更新的 minor 版本），或 `finishFrame`/`beat` 抛出的异常。
- 后果：
  - 当前和以后所有 D3D/DDraw 进程失去图形；
  - `prepareSaveState`（`BR:528`）重抛这个标志，之后无法存档；
  - `after_restore` 不会把可用性设回 true；
  - 非 worker 模式下同一错误却被忽略，两种模式行为不一致。
- 修复：失败只影响本批处理并上报，不做全局粘性标志；可用性由设备丢失这类真正的不可恢复事件决定。

**S1-2 `GetData` 无超时，主机在多条路径上不回复查询 → 游戏死锁** ✅

- 位置：`G9:11785-11825`，没有期限，未完成时一直返回 `S_FALSE`。
- 主机丢弃查询而不回复的路径：
  - `onCreateQuery`/`onBegin/EndQuery` 收到短载荷或未知句柄（`E:4599-4635`）；
  - back buffer 与深度尺寸不匹配时清空整帧 ops，查询也随之丢弃（`E:5202-5214`）；
  - `discardFrame`（批处理失败、`CREATE_DEVICE`）；
  - `finishFrame` 抛出异常。
- 后果：用 `while (GetData()==S_FALSE)` 做帧节流或等 GPU 的游戏卡死。
- 修复：
  - 主机在任何丢弃 ops 的路径上把挂起的查询回答为 FAILED（遮挡查询给 0）；
  - 客体 `GetData` 沿用回读路径已有的心跳期限。

**S1-3 驱动轮询超时后永久销毁 virtio 传输** ✅（代码；触发条件 ❓）

- 位置：`VT:262-274`。驱动轮询 5000 次 × `KeDelayExecutionThread(1 ms)`，然后调用 `vgl_transport_destroy`，此后再无重新初始化。
- 实际时长：XP 默认时钟精度下约 50–80 秒；游戏调用过 `timeBeginPeriod(1)` 时约 5 秒。
- 为什么主机会停顿这么久：设备在 8 个在途批处理时停止接收（`v86gl_device.js:42`），而“done”要等整批执行完才发，着色器编译、查询映射都算在内。
- 后果：重启客体之前没有图形。
- 两种客体策略也不一致：d3d9/d3d8 把任何瞬时 SUBMIT 错误当永久失败；DDraw 则带退避重试。

**S1-4 宿主没有任何 WebGPU 错误捕获，坏管线被永久缓存** ✅

- `d3d9-webgpu/` 与 `webgpu_host.js` 中零处 `pushErrorScope`/`uncapturederror`。
- `pipelineFor`（`E:10810-10836`）缓存 `createRenderPipeline` 的任何返回值。
- 后果：
  - 一个无效管线会让整帧的命令缓冲无效，包括 back buffer 快照；
  - 下一帧从缓存里拿到同一个无效管线，于是永久黑屏或冻结；
  - 客体早已拿到 `D3D_OK`。
- 修复：
  - 创建时用 error scope，或改用 `createRenderPipelineAsync`；
  - 失败就驱逐缓存项、计数，并跳过该 op；
  - 每帧提交外再包一层 validation scope，供诊断和测试断言。

**S1-5 确定会被 WebGPU 拒绝的构造**（每项都会使整帧命令缓冲失效，再叠加 S1-4 就是持续黑屏）

| 项 | 触发 | 位置 | 核实 |
| --- | --- | --- | --- |
| a | `BLENDOP` 为 MIN/MAX 时仍使用应用的混合因子；WebGPU 要求 one/one。D3D9 默认 `DESTBLEND=ZERO` 就会触发 | `E:9660-9679, 10741` | ✅ 代码；☑️ Chrome 复现 |
| b | 线/点拓扑管线带非零 `depthBias`；`applyFillMode` 的线框也走这里 | `E:10798, 12347` | ✅ 代码；☑️ Chrome 复现 |
| c | MRT：额外目标的写掩码是 `COLORWRITEENABLE1-3` 或 0xF，不看着色器是否输出该 location；固定管线 PS 只写 location 0。应用残留绑定 RT1 即触发 | `E:10733-10745` | ✅ 代码；☑️ Chrome 复现 |
| d | 固定管线 VS 声明了顶点布局没有提供的属性：stride 0 的流、未绑定的流、未知 DECLTYPE，以及整数类型喂给 `vec4<f32>`。翻译着色器路径有默认属性兜底，固定管线没有 | `E:8829-8836, 2149, 10544` | ☑️ Chrome 复现 |
| e | 采样当前 pass 的颜色附件（即使是不同 mip）；只防了深度附件 | `E:11379` | ☑️ |
| f | 遮挡查询集 `count` 最多到 8192；WebGPU 上限 4096 | `E:5055-5063` | ✅ |
| g | 对深度表面 `ColorFill`：客体接受，主机把深度视图当颜色附件；原生返回 INVALIDCALL | `G9`、`E:onColorFill` | ☑️ |
| h | `StretchRect` 没有矩形校验：越界会产生越界拷贝；负 left/top 在 `finishFrame` 中抛 TypeError；深度到深度时 `null === null` 误走 copy 路径；`src == dst` 自拷贝 | `E:7778-7867`、`G9:11481` | ☑️ |
| i | BCn 纹理顶层尺寸不是 4 的倍数；DDraw 路径的 BC 小 mip 拷贝；对 BC 目标做带键或缩放的 blit | `E:6435`、`DO:517` | ☑️ |

`createTextureOrNull`（`E:6931`）只捕获“缺少特性”的 TypeError。尺寸、对齐、限额错误在 WebGPU 中不会抛出，只会得到一个无效对象，之后污染每次提交，所以它承诺的 1×1 白色回退其实不会发生。

**S1-6 4x MSAA 从未附加或 resolve，开抗锯齿即黑屏** ✅

- 整个 `d3d9-webgpu/` 中没有 `resolveTarget`。
- `backBufferMsaaView` 和资源的 `msaaTexture` 被创建，但从未被读取。
- 颜色附件总是单采样的 `swapView`/`color.view`（`E:5156-5165`）。
- 自动深度（`E:4379`）和管线（`E:9758`）却用 `state.sampleCount = 4`。
- 客体宣称支持 4x（`G9:2250` 附近）；SVGA 旧表面 `samples>1` 也走这条路。
- README 说 MSAA “由执行器 resolve”，与代码不符。
- 单元测试 `d3d9_webgpu_executor_test.js:1737` 断言 sampleCount 为 4 的管线数量，等于把这个错误固化了。
- 修复：实现 MSAA 纹理加 `resolveTarget`（2026-10-29 决定：阶段 0 直接实现，不先撤销宣称）。

**S1-7 SM3 着色器被 Chrome(Tint) 拒绝：在非一致控制流中采样** ✅（缺少诊断指令）☑️（Chrome 复现）

- 三种常见形状：
  - `if p0.x` 里采样（翻译器把它当成一致控制流，`SP:1249-1252`）；
  - `rep`/`loop` 中数据相关的 `breakc`/`break_pred` 之后采样；
  - 从 `if_comp` 内 `call` 一个会采样的子程序。
- Chrome 报 “textureSample must only be called from uniform control flow”。naga 接受全部三种，而测试只用 naga 校验，所以测不出来。
- 后果：使用该管线的帧丢失，此后这个 draw 永远被跳过。
- 修复：输出 `diagnostic(off, derivative_uniformity);`。同仓库的 GLSL 翻译器已经这样做了（`gl_shader_translator.js:3686`，注释写着 “Tint checks it, naga does not”）。
- 做了这个修复后，约 250 行的“梯度提升”机制（S2-11）可以删除。

**S1-8 back buffer 与深度尺寸不一致时整帧丢弃** ✅

- 位置：`E:5202-5214`。只 `warnOnce` 一次，然后执行 `frame.ops.length = 0`，查询也一起丢掉（引出 S1-2）。
- 触发：
  - D3D9 允许深度缓冲比渲染目标大，WebGPU 要求一致；
  - 同一执行器的多个设备共用一个 back buffer（S2-22）。
- 修复：
  - 深度比 RT 大时，用等尺寸替身，或渲染到等尺寸的临时颜色目标；
  - 尺寸逻辑错误应当断言，而不是丢帧。

**S1-9 D3D9/D3D8 的 `Reset`**

- **(a) 每次 Reset 泄漏所有存活资源。** ✅
  - `recreate_device_resources`（`G9:3827-3952`）给每个托管、系统内存、scratch 资源、声明和着色器分配新句柄并重新上传，但从不发 DESTROY。
  - 宿主 `onReset`（`E:4198-4237`）只替换设备状态，不碰 `this.resources`。
  - 注释 `G9:3911-3919` 说“主机资源表从头重建”，这是错的。
  - 后果：每次改分辨率或 Alt+Enter，GPU 内存约翻倍，所有纹理再走一遍 DMA。
  - 修复：保留句柄，删除整个重建流程。
- **(b) Reset 拒绝 `BackBufferCount > 1`（`G9:5689`）。** ✅ CreateDevice 却接受 ≤3（`G9:4641`），所以双缓冲、三缓冲的游戏每次 Reset 都失败。同样的检查也复制在 `G8:3425, 5651`。
- **(c) D3D8 的 RTT 保存/恢复模式之后 Reset 永远失败。** ☑️ 模式是 GetRenderTarget/GetDepthStencilSurface → SetRenderTarget → 恢复 → Release。设备持有的隐式深度表面仍算 `reset_blocker`，而 Reset 在清绑定之前就检查阻塞（`G8:3426, 3481, 5862-5866, 5938-5942`）。
- **(d) Reset 不处理全屏/窗口切换和全屏分辨率变化。** ☑️ 不改显示模式，不改窗口样式，不抢前台（`G9:4746, 4820`）。gamma 渐变在 Reset 后丢失（`G9:909-914` 注释说要重发，代码没有）。

**S1-10 d3d9.dll 与 d3d8.dll 从不发送 `SESSION_END`** ✅

- 只有 `GD:1074` 发送。`G9` 的 `DllMain` DETACH（`G9:15251-15264`）只做 flush 和关闭。
- 后果：进程带着存活对象退出（很常见）或崩溃时，它的 GPU 资源、未提交帧和 overlay 图层一直残留到页面刷新。
- 修复：
  - DLL 卸载时发送 `SESSION_END`；
  - 驱动在 `IRP_MJ_CLOSE`/注销 arena 时也结束会话，覆盖进程被杀死、`DllMain` 不运行的情况。

**S1-11 每个进程一个 DMA 映射，却有四个 DLL 各自当 owner** ☑️/❓

- 同一进程（例如 ddraw.dll 加上经 DirectShow 载入的 d3d9.dll）：
  - 两者用各自的锁在同一偏移写批处理；
  - 查询槽表、会话 id 各自独立；
  - 任一方关闭都会解除另一方的映射。
- 跨进程时驱动返回 `STATUS_DEVICE_BUSY`（`v86gl_driver.c:88-94`），`Direct3DCreate9` 返回 NULL（`G9:15157-15160`）。所以只读过 caps、仍常驻的启动器或配置工具会把游戏锁在外面。
- uniform ring 游标是执行器全局的（`E:10927-10939`），两个会话在帧内交错时，常量会串到对方。

**S1-12 大上传失败** ☑️

- 原因：`batch_capacity()` = 16 MiB − 4 MiB 响应区 ≈ 12 MiB。
- D3D9 顶点/索引缓冲上传不分带（`G9:1861`）。超过约 12 MiB 时 Unlock 返回 DRIVERINTERNALERROR，`Reset` 重建也会在中途失败。
- D3D8 的纹理上传 `emit_level_update`（`G8:1805-1865`）是 d3d9 分带版本修复之前的拷贝，所以 2048² A8R8G8B8 的第 0 级就会失败。D3D8 caps 却宣称支持 8192。

### 3.2 S2 严重

#### 宿主侧（所有前端共用）

| # | 问题 | 位置 | 触发 → 后果 | 核实 |
| --- | --- | --- | --- | --- |
| S2-1 | `Clear` 忽略视口和剪裁矩形 | `E:4945-5003`；客体原样转发矩形（`G9` `device_clear`、`G8:3545`） | `rect_count==0` 时清整个附件，有矩形时只按目标尺寸夹取。D3D9 规定清除区域被视口裁剪，Wine 在开启剪裁测试时还与剪裁矩形求交 → 分屏、画中画、UI 模型预览先 `SetViewport` 再 `Clear`，结果清掉整帧 | ✅；W+（d3d9 `visual.c` `clear_test`：视口与剪裁都限制 Clear） |
| S2-2 | XYZRHW 预变换顶点不做透视校正，且没有雾 | `E:2275-2279`（`vec4(ndc_x, ndc_y, z, 1.0)`，没读 rhw）；`E:9946-9955`（screen 位置类型直接禁用雾） | D3D5–7 软件 T&L、D3D8/9 软件顶点处理、客体 `ProcessVertices` 的输出 → 大三角形上纹理“游动”；雾因子应取镜面 alpha（表雾取 z），现在完全无雾。浏览器测试用 rhw=1，所以测不出 | ✅ 代码；✅ 真 GPU 复现雾（像素原型）；W（透视：`glsl_shader.c:9292-9296` 除以 rhw）；W+（雾：d3d8 `visual.c:1315-1343`、d3d9 `visual.c:28476-28494`） |
| S2-3 | 引用 TEXTURE 但未绑纹理的 stage 采样 1×1 白色 | `E:8573-8654, 10111` | 默认 stage 0 的 ALPHAOP 是 `SELECTARG1(TEXTURE)`，`SetTexture(0,NULL)` 后 alpha 恒为 1 → 半透明的无纹理淡入淡出、对话框底、阴影块都变成不透明。wined3d 会把这种 stage 变成“选 CURRENT” | ✅ 真 GPU 复现（0x80FF0000 盖在蓝色上得 255,0,0，应为 128,0,127；显式设 ALPHAARG1=DIFFUSE 则正确）；W（`wined3d/utils.c:5482-5500` `is_invalid_op` → `SELECTARG1(CURRENT)`） |
| S2-4 | ps_1_x/ps_2_x 下不应用固定管线雾 | `E:10087-10093`（只计数和告警） | D3D9 对 <3.0 的像素着色器仍做雾混合 → 所有 D3D8 ps_1_x 效果和用硬件雾的 ps_2_0 游戏都没有雾。README 未记录 | ✅；W+（d3d8 `visual.c` `fog_with_shader_test`；`glsl_shader.c:7835-7837`） |
| S2-5 | 顶点缺少颜色时，材质颜色源不回退到材质 | `E:2333-2337, 8798-8801, 2318-2323` | 在默认的 COLORVERTEX=TRUE、DIFFUSE=COLOR1 下，`XYZ\|NORMAL\|TEX1` 网格配红色材质，结果渲染成白色漫反射、没有高光。`DEFAULT_MATERIAL` 是白色，Wine/DXVK 是全 0 | ☑️；W+（`validate_material_colour_source`，d3d9 `visual.c` `test_color_vertex`） |
| S2-6 | Alpha test 精度错误，ALPHAREF 被编进着色器 | `E:1812-1826`（未量化的 alpha 与 `toFixed(6)` 字面量比较）、`E:9887-9890`（进入变体 key） | 对等于 ALPHAREF 的 alpha：GREATEREQUAL 在 122 个参考值上误判，GREATER 在 124 个上误判，EQUAL 在 246 个上误判；每个新的 ALPHAREF 值都同步重新翻译着色器并新建管线 | ✅ 代码；✅ 真 GPU 复现（GREATER 0x80 留下了 0x7F） |
| S2-7 | 视口 MaxZ=0 被改成 1 | `E:9049` | MinZ=MaxZ=0（“画在近平面”，HUD/武器）失效。MinZ>MaxZ 不夹取，WebGPU 会报校验错误 | ✅ |
| S2-8 | 顶点纹理采样器索引差一 | `E:10599`（`256 + index`）；`D3DVERTEXTEXTURESAMPLER0` 是 257，客体发送原始 stage | vs_3_0 的 s0 永远拿到回退纹理，s1 读到应用的 s0。单元测试（`d3d9_webgpu_executor_test.js:288, 6704`）发送 256，把同样的错误写进了期望值 | ✅ |
| S2-9 | 谓词寄存器完全无效 | `SP:719-721`（setp 写 `p0f`），`SP:909, 1310, 1460`（读 `p0`）；`p0f` 从不复制到 `p0` | `(p0)` 指令从不执行，`(!p0)` 总是执行，`if p0` 从不进入，`break_pred` 从不跳出；caps 仍宣称支持谓词。谓词还只看第一个分量，D3D 是按分量门控 | ✅ |
| S2-10 | 嵌套 `loop` 破坏 `aL` | `SP:1284, 1296, 1900` | 只有一个 `aL`：内层覆盖，外层 `endloop` 从内层终值继续步进 | ☑️（运行复现） |
| S2-11 | 梯度提升在循环中采样错误坐标 | `SP:1664-1693, 1411-1437` | 坐标被提到最外层数据相关 `if` 之前，于是 `if_gt; rep; texld r2, r1, s0; add r1, r1, c1; endrep` 的每次迭代都采样循环前的 r1；失败时静默回退为导数 0 或 LOD 0 | ☑️（运行复现） |
| S2-12 | SM3 语义链接只支持 COLOR0-1、TEXCOORD0-7、FOG | `SP:262-269, 695, 700-703, 2106-2109` | vs_3_0/ps_3_0 使用 NORMAL、TANGENT、BINORMAL、TEXCOORD8/9、COLOR2+ 时整个着色器翻译失败；`dcl_position1` 会覆盖真正的位置 | ☑️ |
| S2-13 | ps_1_x 纹理寻址指令丢掉源修饰符 | `SP:1119, 1148, 1164, 1180, 1192, 1213` | `texm3x3pad t1, t0_bx2` 丢掉 `_bx2` → 环境凹凸反射错误 | ☑️ |
| S2-14 | vs<3.0 的 oD0/oD1 不饱和；没写 oD0 时默认 0 | `SP:2056-2057, 2153-2154, 1915`、`E:2622` | 顶点着色器或像素着色器低于 3.0 时，D3D 把颜色输出夹到 [0,1]，没写的 oD0 为 (1,1,1,1) → 过亮或负值光照，D3D8 游戏常见 | W+（d3d9 `visual.c` `test_color_clamping`：vs1+ps1、vs2+ps2 得 0x7f7f7f，vs3+ps3 得 0xffffff；d3d8 同） |
| S2-15 | 纹理“重命名”丢失或乱序数据 | `E:6630-6680, 7108, 7126` | (a) 只用 CPU 影子重建：同帧内 ColorFill/StretchRect 写过的非 RT 纹理再被上传时，GPU 写入的内容丢失；(b) RT/DS 纹理从不重命名：同帧 draw 之后的 UpdateSurface 会跑到这些 draw 之前执行；(c) generate-mips 在回放时才查视图：重命名后，之前的 draw 采样到全黑的 mip | ☑️ |
| S2-16 | X8 格式的 alpha 不恒为 1 | `E:4964, 8011`；X8R8G8B8/X1R5G5B5/X4R4G4B4 存为 rgba8unorm | 采样 X8 RT、在 X8 目标上用 DESTALPHA、StretchRect X8→A8 时都读到残留的 alpha → 后处理变半透明 | W（混合：目标无 alpha 时 DESTALPHA→ONE、INVDESTALPHA→ZERO，`ffp_gl.c:255-264`）；采样一侧 ❓ |
| S2-17 | `PRESENT_SWAP_CHAIN` 解码偏移错误 | `E:7273-7283` 对照 `PH:671-680` | 从 +16 读 width（实为 y），+20 读 height（实为 width），y 从不读 → 附加交换链的图层尺寸错乱。测试不检查 surface | ✅ |
| S2-18 | `DrawIndexedPrimitiveUP` 的三角扇被丢弃 | `E:12257`（在两个缓冲都上传之后） | D3D7 的 `DrawIndexedPrimitive` 全部走这条路（`D7:636-645`）→ D3D7 所有索引三角扇消失 | ✅ |
| S2-19 | 纹理变换的输入按输出 COUNT 补齐 | `E:2503-2508`；签名不记录纹理坐标尺寸（`E:8424`） | D3D 按坐标自身维度补成 (u,1,0,0)/(u,v,1,0)/(u,v,w,1)。现在相机空间 TCI 配 COUNT2 时 z 被换成 1，FLOAT2 配 COUNT3/4 时平移取自错误的行 | ☑️；W（`utils.c` `compute_texture_matrix` 按输入维度选平移行；COUNT1 视为单位阵） |
| S2-20 | DOT3 不复制到 alpha；参数使用判定不看 op | `E:2841-2843`（`E:8637-8642` 是死代码）；`E:8612-8616` | `SELECTARG2(DIFFUSE)` 加上残留的颜色键纹理会错误 discard；fragment key 含有没用到的参数，产生重复管线 | ☑️；W（`utils.c:6131-6139` DOT3 覆盖 alpha op；按 op 决定读哪些参数） |
| S2-21 | BORDER 寻址在翻译着色器和比较采样器上静默变成 clamp，告警却说“已模拟” | `E:9870` | 阴影图、聚光灯 cookie 的边缘像素被拉伸 | ☑️ |
| S2-22 | 一个执行器只有一个 back buffer，被所有设备共用 | `E:4275` | 两个设备画进同一纹理；尺寸不同时触发 S1-8 | ☑️ |
| S2-23 | INTZ 深度纹理的创建判据与绑定判据矛盾 | `E:6369` 对照 `E:7611` | usage 0 的 INTZ 当深度创建，绑成深度时却按无深度执行 pass | ☑️ |
| S2-24 | `MULTISAMPLEANTIALIAS=FALSE` 只写 sample 0 | `E:9784-9788` | D3D9 写所有 sample → 4x 下 resolve 后只剩 25% 亮度（实现 MSAA 之后才会显现） | ☑️ |
| S2-25 | 有 INSTANCEDATA 残留的流时点列表被丢弃 | `E:11748-11760`（扫描所有流，而不只是声明用到的） | 粒子消失 | ☑️ 代码；影响 ❓ |

#### D3D9 客体

| # | 问题 | 位置 | 触发 → 后果 | 核实 |
| --- | --- | --- | --- | --- |
| S2-26 | 窗口模式 `BackBufferWidth/Height = 0` 时，设备在客体里是 640×480 | `G9:4693-4710` 设 640×480，`G9:4726-4731` 却把客户区尺寸发给主机；呈现参数不回写 | 这是 SDK 教程的写法 → 全客户区 `SetViewport` 被拒（INVALIDCALL）；`SetRenderTarget(0, backbuffer)` 把视口重置为 640×480，只画左上角；GetDesc、深度表面、剪裁矩形都错；Reset 又走另一套推导。D3D8 相同（`G8:3215-3266`） | ✅ |
| S2-27 | Lock 标志比零售版运行时严格 | `G9:13230-13241`（VB）、IB 同；`G8:4378-4388` 原样拷贝 | 拒绝非 DYNAMIC 缓冲上的 DISCARD/NOOVERWRITE，以及 DISCARD\|NOOVERWRITE。Wine 会忽略这些标志并告警，DXVK 也忽略 → 加载时对静态缓冲 DISCARD 锁定的游戏拿到 NULL 指针（崩溃或缺几何）。READONLY\|DISCARD 的拒绝与 Win7 一致 | ✅ 代码；W+（`wined3d/device.c:4639-4672` “Windows never returns an error”；d3d9 `device.c:6302-6309` 各组合在 DYNAMIC 缓冲上都返回 D3D_OK，READONLY\|DISCARD 只在 Win7 上是 INVALIDCALL） |
| S2-28 | Patch 绘制解绑应用的 stream 0 和 IB | `G9:10743, 10897, 11069` 调用公开的 `device_draw_indexed_primitive_up`，它会清 stream 0 和 indices（`G9:7310-7311`） | 一次细分绘制之后，所有不重设 stream 0 的 draw 都被拒；NPATCHES/RTPATCHES 都有宣称。样例程序每次都重新绑定，所以没测出 | ✅ |
| S2-29 | `SetRenderTarget(0)` 只重置视口，不重置剪裁矩形 | `G9:11330-11350` | 开剪裁测试时，渲染到纹理的 pass 被旧矩形裁掉；默认剪裁矩形在 D3DSBT_ALL 中被捕获为 {0,0,0,0} | ✅；W（`wined3d/device.c:2425-2437` 同时重置视口和剪裁矩形） |
| S2-30 | 灯光：LightEnable 一个未设置的索引不会创建默认灯；索引 ≥8 被拒；SetLight 不校验类型 | `G9:9272-9312` | 物体不受光、按场景 id 编号灯光的游戏丢灯（D3D8 前端这三点都是对的，`G8:6123-6260`） | ☑️；W+（`stateblock.c:2144-2148` 未设置的索引装入默认灯；d3d9 `visual.c:29013` 使用索引 123） |
| S2-31 | `MultiplyTransform` 乘法顺序反了：算的是 current×M，应为 M×current | `G9:9214-9229`、`G8:6043`、`D7:1673` | 两矩阵不可交换时变换错误，三个前端都有 | ✅ 代码；W（`stateblock.c:1957` + `utils.c:6017-6025` 结果为 M×current，与 MSDN 一致；Windows 测试用单位阵，未钉住顺序） |
| S2-32 | `CheckDeviceFormat` 对所有 `D3DUSAGE_QUERY_*` 都回答 yes | `G9:4397-4428` | 浮点格式的 POSTPIXELSHADER_BLENDING、FILTER，无 sRGB 兄弟格式的 SRGBREAD/WRITE，以及所有格式的 VERTEXTEXTURE → HDR 引擎据此选择 FP16/FP32，选错后主机静默降级。这违反了文件自己定下的规则（`G9:2169-2174`） | ☑️ |
| S2-33 | 主机设备丢失不报告给客体 | `TestCooperativeLevel` 恒返回 `D3D_OK`（`G9:4852`）；`recoverDevice` 清空一切（`E:4455`） | 游戏继续画进已经失效的句柄。`recoverDevice` 还替换 `this.work`，打乱批处理顺序（`E:4505`） | ☑️ |
| S2-34 | `DrawIndexedPrimitive` 过度校验 | `G9:7163-7197` | 范围检查不计 BaseVertexIndex；拒绝 NumVertices=0、锁着的 VB/IB、零图元数，零售版都会正常执行 | ☑️；W（Wine 的 `d3d9_device_DrawIndexedPrimitive` 只检查声明和索引缓冲是否已设置） |
| S2-35 | `UpdateTexture` 要求尺寸完全相同 | `G9:8752` | 引擎“降低纹理质量”的路径（源更大、跳过顶层 mip）失败 | W（`wined3d/device.c:3959-3978` 源更大时跳过顶层、级数取较小值）；Windows 测试只覆盖不崩溃 |

#### D3D8 客体

| # | 问题 | 位置 | 触发 → 后果 | 核实 |
| --- | --- | --- | --- | --- |
| S2-36 | `CopyRects`、`GetFrontBuffer`、锁定可锁 RT 只读 CPU 影子，而影子只被 `Clear` 写过 | `G8:5509-5569, 5780-5800, 4821-4843`；`G8` 中没有任何 READBACK | 截图得到清屏色；从 back buffer/RT CopyRects 到纹理，上传的是清屏色；CopyRects 到 back buffer（经典 D3D8 2D blit）静默无效；锁 RT 再解锁会把影子盖回已渲染内容。D9WG 早有 READBACK/STRETCH_RECT/UPDATE_SURFACE，`G9` 也在用 | ✅ |
| S2-37 | 渲染到立方体面时绑定的是 back buffer | `G8:5825, 5881-5883, 8050-8066` | 立方体面表面只有 `->cube`，于是发出 `color_texture_handle=0`、`face=0` → 动态环境图画到屏幕上。立方体 RT 有宣称 | ☑️ |
| S2-38 | 默认状态表缺项，又被冗余过滤吞掉 | `G8:2858-2923` 缺 FILLMODE、LASTPIXEL、CLIPPING、POINTSIZE、POINTSCALE_A、BLENDOP、MULTISAMPLE*、ADDRESSW、COLORARG0/ALPHAARG0（POINTSIZE_MIN 在 D3D8 默认就是 0，RESULTARG 已是 CURRENT；ZENABLE 应随 EnableAutoDepthStencil，现恒为 TRUE）；过滤在 `G8:3790-3800` | 第一次把这些状态设为 0 会被当成冗余过滤掉，主机保留非零默认：粒子 A=0 失效、`COLORARG0=DIFFUSE` 被丢（LERP/MULTIPLYADD 错）；`GetRenderState(FILLMODE)` 返回 0。`G9` 修过同样的问题并写了原因（`G9:3971-4076`） | ✅；W+（d3d8 `stateblock.c:1203-1270` 默认值表、`device.c:5345-5425`） |
| S2-39 | 状态块语义 | `G8:3793-3799, 6310-6335, 144-175, 6551-6556` | 录制期间每个 Set 也立即生效（Wine/DXVK 不会）；PIXELSTATE/VERTEXSTATE 范围过宽；不捕获常量和裁剪面；在第一次 SetVertexShader 之前创建的 ALL 块 Apply 时会 `SetVertexShader(0)` 中途失败 | ☑️；W+（d3d8 `device.c:8002-8020` 录制期间不改设备；`stateblock.c` 范围测试） |
| S2-40 | `CreateVertexShader(decl, NULL)`（多流固定管线）被拒；`D3DVSD_CONST` 只保留最后一块且不检查越界 | `G8:7135, 1260-1270, 4049-4054` | 多流固定管线的 D3D8 游戏无法建着色器；常量错，`GetVertexShaderConstant` 和 Reset 后的重传数据陈旧 | ☑️；W+（d3d8 `device.c:2396-2398` 返回 D3D_OK，测试注释提到 3DMark2001；`visual.c:11150-11186` 经此路径绘制） |
| S2-41 | ps_1_4 的 `cnd` 被客体拒绝 | `G8:933-935` | 合法着色器在 CreatePixelShader 失败；宿主其实能正确翻译它 | ☑️；W+（d3d8 `visual.c` `cnd_test`） |
| S2-42 | 一批 API 静默无效或返回错误，而 `G9` 早已用现成的 D9WG op 实现 | `G8:5578-5584, 5685-5689, 4955-4963, 4332` | 硬件光标不可见；gamma 无效且 Get 返回全 0；SetLOD 不发送；SetPrivateData 总返回 INVALIDCALL；没有 Present 节流（`G9:5950-6050` 有）；GetBackBuffer 等每次调用都分配新 COM 对象（同一性破坏，每个副本还都算 Reset 阻塞）；附加交换链没有自己的 back buffer | ☑️ |
| S2-43 | CreateRenderTarget 开 4x MSAA 时对同一句柄发两次 CREATE_TEXTURE_2D | `G8:5704-5717`、`E:6491` | 每次调用泄漏一张 GPU 纹理 | ☑️ |
| S2-56 | `SetRenderTarget(NULL, ds)` 被拒（只换深度、或 `(NULL, NULL)` 解绑深度） | `G8:5817` | D3D8 规定 NULL 颜色目标表示保留当前目标 → 只换深度缓冲的游戏失败 | W+（d3d8 `device.c:3965-3983, 2664-2670`；`d3d8/device.c:1531-1605`） |

#### DDraw / D3D1–7 客体与 `ddraw_ops.js`

| # | 问题 | 位置 | 触发 → 后果 | 核实 |
| --- | --- | --- | --- | --- |
| S2-44 | COLORFILL 颜色的格式，三处说法互相矛盾 | `GD:2331` 原样发送 `dwFillColor`；`PH:1049` 说是“目标格式的值”；`DO:416-431` 按 A8R8G8B8 解码，并注释“客体已转换” | 565 的白色 0xFFFF 变成青色；用颜色键预填的表面不再匹配键；32 位 X8 填充 alpha 为 0。只有索引色填充有测试 | ✅；W+（ddraw7 `test_color_fill`；Wine 用目标格式的掩码解码，`ddraw/utils.c:593-645`） |
| S2-45 | 窗口剪裁器用客户区坐标裁剪 | `GD:2256-2266, 2417+`（`GetClientRect`，不做 `ClientToScreen`） | 主表面是屏幕坐标 → 不在 (0,0) 的窗口被裁错或完全不画 | ✅；W+（ddraw7 `tests/ddraw7.c:1360-1384`：剪裁列表是映射到屏幕坐标的可见区域） |
| S2-46 | 表面颜色键没有 `DDCKEY_COLORSPACE` 时仍用 high 值；带 COLORSPACE 的范围键应返回 `DDERR_NOCOLORKEYHW` | `GD:3256, 4435-4446, 2839`、`DO:240-245` | Windows 在缺这个标志时令 high=low，应用常把 high 留 0 或垃圾值 → 精灵不透明或出现空洞。Blt 的覆盖键（DDBLTFX）仍是范围，保持现状 | W+（`ddraw/surface.c:5243-5257`；ddraw7 `test_range_colorkey`） |
| S2-47 | stage 0 的 alpha 默认值被 TEXTUREMAPBLEND 回放覆盖；没有按版本区分的默认状态 | `D7:1058, 2410, 1820-1829, 1125`、`ddraw_protocol.h:760-764` | 所有版本共用一套初始化，D3D7 也从 `SELECTARG2(DIFFUSE)` 开始 → alpha 纹理几何画成不透明；传统 MODULATE 应在纹理有 alpha 或未绑纹理时取 `SELECTARG1(TEXTURE)`，否则 `SELECTARG2(CURRENT)`，并在 SetTexture 时重算；D3D7 上 TEXTUREMAPBLEND 应返回 `DDERR_INVALIDPARAMS`；按版本的默认值缺失（v1 COLORKEYENABLE=TRUE，v2 SPECULARENABLE=TRUE，v1–3 NORMALIZENORMALS=TRUE 等） | W+（`ddraw/device.c:2697-2722` `fixup_texture_alpha_op`、`6943-6953`；ddraw4 `11171-11273`、ddraw7 `16094-16101`、ddraw1 `2165-2170` 等） |
| S2-48 | 对 GPU 写过的表面做 `DDLOCK_WRITEONLY` 锁定会擦掉内容 | `GD:3177, 3333-3335` | 软件光标或 HUD 叠在 D3D 帧上时，把整帧替换掉 | ☑️；W（`ddraw/utils.c:570-571` WRITEONLY 只去掉读权限，内容保留；无 Windows 测试） |
| S2-49 | `palette_SetEntries` 不触发呈现 | `GD:3833` | 只改调色板的淡入淡出不可见，要到下一次 Flip | ☑️；W（`ddraw/palette.c:160-181` 主表面的调色板立即更新前台） |
| S2-50 | 可见表面写入：丢失或越界 | `GD:2485, 2553, 3036, 3336`、`DO:356` | flip chain 下画在前缓冲的加载画面不可见；窗口模式 `Unlock(NULL)`/`ReleaseDC` 把整个桌面标脏，其他窗口被盖上旧桌面 | ☑️ |
| S2-51 | 非主表面的 flip chain 错误 | `GD:2675`、`DO:717` | overlay flip chain 被 1:1 贴到交换链上，overlay 显示的是应用正在画的那块缓冲 | ☑️ |
| S2-52 | 执行缓冲 `D3DPROCESSVERTICES_TRANSFORM` 丢掉 LVERTEX 颜色；传统视口映射被忽略 | `DL:2882, 2896-2897`；`DL:639-656, 780-820` | 预光照几何变白；D3DVIEWPORT 的 `dvScaleX/Y` 和 D3DVIEWPORT2 的 `dvClip*`、MinZ/MaxZ 应经裁剪空间矩阵生效（深度范围固定 0..1；`dvMaxX/Y` Wine 也不用） | W+（`ddraw/executebuffer.c:417-429`、`viewport.c:28-101`；ddraw1 `7732-7741`、ddraw2 `12983-13130`） |
| S2-53 | 对象生命周期 | `GD:4021, 4338, 4650, 3226, 3298` | 释放 flip chain 前缓冲时，隐式后缓冲及其 GPU 纹理全部泄漏，`flip_next` 悬空；经 IDirectDraw4/7 创建的表面应 AddRef DirectDraw 对象（DD1/DD2 不加），现在不加，v4/v7 应用先释放 DirectDraw 就会 use-after-free；SetPalette/SetClipper 先 Release 旧对象再 AddRef 新对象，设回同一个对象时会 AddRef 已释放的内存 | ☑️；W+（`tests/refcount.c:109-191`、ddraw7 `9024-9027`；`surface.c:574-577, 4766-4777` 先 AddRef 后 Release） |
| S2-54 | 纹理 `Load` 不完整 | `D7:2573-2604`、`DL:1213-1240` | D3D7 `Load` 只拷第 0 级（没有 mip、没有立方体面），忽略 flags；`IDirect3DTexture2::Load` 不拷调色板和颜色键，mip 数不同时返回 BADSIZE（Wine 加载共同的级） | W+（`ddraw/surface.c:5671-5795`、`device.c:6114-6276`；ddraw7 `test_device_load`、ddraw2 `1622-1629`） |
| S2-55 | DX3 `D3DLIGHT` 的 `dwFlags`=0 被当成“禁用” | `DL:580` | 传统灯光不起作用 | W+（`ddraw/light.c:174` 小于 D3DLIGHT2 的灯视为 ACTIVE；ddraw1 `7827-7838` 无标志的灯照亮四边形） |
| S2-57 | 无源 BLACKNESS/WHITENESS 被拒；P8 表面没有调色板时 GetDC 的颜色表全黑 | `GD:2354, 2405-2415`；`GD:2959-2969` | 用 ROP 清屏的程序得到 `DDERR_INVALIDPARAMS`（WHITENESS 得 `NORASTEROPHW`）；GDI 文字不可见 | W+（ddraw7 `12363-12378`；`surface.c:2531-2542` 回退到主表面调色板，ddraw7 `10360-10372`） |

### 3.3 S3 一般（摘要，细节见共享笔记目录里的各区报告）

- **格式（`E` 约 1420–1550 行）：**
  - 5/6 位展开用截断而不是位复制，约一半取值差 1；
  - G16R16、R16F、G16R16F 缺失的通道读 0，D3D 读 1；
  - 565/1555/4444 渲染目标按 rgba8 存储，不量化，没有 1 位 alpha，也未记录这一偏差。
- **调色板纹理（`E:6997-7058`）：**
  - 上传日志重放顺序错误且无界增长；
  - 每次 `SetCurrentTexturePalette` 都重绘全部 P8 纹理，开销 O(纹理数²)/帧。
- **呈现与显示：**
  - Present 的源/目的矩形和脏区被忽略（`G9:6059`），README 未提；
  - 呈现附加交换链时，也会把隐式 back buffer 的半成品复制到主画布；
  - `GetDisplayMode` 在窗口模式返回 back buffer 而不是桌面模式（`G9:4895`）。
- **客体默认值与 caps：**
  - ZENABLE 在没有自动深度时仍为 TRUE；POSITIONDEGREE、NORMALDEGREE 等细分状态为 0；
  - `DynamicFlowControlDepth=0` 却宣称 ps_3_0；RasterCaps 缺 ANISOTROPY；
  - `MaxStreamStride`=65535，但主机没有提高 `maxVertexBufferArrayStride`（默认 2048）。
- **D3D9 客体其他问题：**
  - `D3DCREATE_MULTITHREADED` 被忽略：设备资源链表无锁，释放时 O(n) 解链（`G9:6731, 13526-13530`）；
  - `host_log` 用 `wvsprintfA` 写进 240 字节的栈缓冲（`G9:1812-1819`），没有长度上限；
  - GDI 光标回退丢掉反色像素，I 形光标完全不可见（`G9:5532`）。
- **协议与查询：**
  - 回读的 `status` 位于载荷之前，迟到的旧应答会让下一次回读失败（`G9:9047`）；
  - 比主机更新的 minor 版本被直接拒绝（`E:3619-3624`），与“未知 opcode 按 size 跳过”的设计目标相矛盾，还会触发 S1-1；
  - 每帧创建一个时间戳查询集，从不销毁；它依赖已移除的 `encoder.writeTimestamp`（`E:5064-5067, 5244-5246`）。
- **着色器翻译：**
  - 地址寄存器取整：vs_1_1 的 `mov a0` 应为 floor，现在用 WGSL `round()`（W+：d3d9 `visual.c` `test_mova`，-2.4→-3、1.6→1）；`mova` 取最近整数，.5 的取舍 Windows 测试未覆盖（wined3d 远离零，vkd3d 取偶，现在与 vkd3d 一致）；
  - ps_1_x 的 `tex` 忽略 D3DTTFF_PROJECTED（W+：d3d8 `visual.c` `intz_test`、`shadow_test`）；ps_1_x 被禁用深度采样器，但 GeForce3 时代 D3D8 的阴影缓冲就是用 ps.1.1；
  - ps 1.0–1.4 的浮点常量（包括 `def`）应夹到 [-1,1]，现在不夹（W+：d3d9 `visual.c` `constant_clamp_ps_test`，ps_1_x 得 0x808000，ps_2_0 得 0xbfbf80）；中间值不必夹（Wine 不夹，原报告此说法撤回）；
  - vs<3.0 没写 oFog 时，Windows 从输出的 oD1.a 取雾（W+：d3d9 `visual.c:28476-28479`），现在默认 oFog=1.0，即无雾；
  - `texreg2rgb`/`texm3x3tex` 被强制成 3D/立方体采样器，执行器随后拒绝该 draw；`v[aL]`/`o[aL]` 忽略相对寻址；`texm3x3`、`texdepth` 被拒。
- **采样器与过滤：**
  - 比较采样器设为 POINT 时按线性过滤（`E:11456`）；
  - MIPFILTER NONE 把 LOD 的 min 和 max 夹成相等，在 Vulkan 后端上会选到放大过滤器（`E:9852`）。
- **D3D8 特有：**
  - ZBIAS 的比例：现在每级 −5e-6（约 84 个 D24 单位，只有常量项）。Wine 是每级约 1 个 D24 单位加 1 倍斜率（`glPolygonOffset(-zbias, -zbias)`，`ffp_gl.c:922-925`），没有 Windows 测试钉住；`d3d8_protocol.h:61-73` 注释说“与 DXVK 一致”，DXVK 的值本次未核对；
  - ps_1_x 中 `def` 常量：Wine 在 D3D8 里同样当作着色器私有（与我们一致），没有 Windows 测试，不算问题；
  - `D3DLOCK` 的 DISCARD 每次都把整个影子缓冲清零（d3d8、d3d9 都是）。
- **SVGA → D9WG：**
  - `SURFACE_COPY` 映射成 `STRETCH_RECT`，继承了 S1-5h 的问题；
  - DMA 后缀里的 discard/unsynchronized 标志被跳过，所以同帧 draw 之后的每次缓冲 DMA 都拷贝整块；
  - 三种格式标为可做渲染目标，但无法回读。

## 4. 过度防御性编程：模式、它掩盖了什么、怎么改

### 4.1 宿主侧

1. **命令级全捕获（`E:3662-3679`）**
   - 现状：每条命令都包在 try/catch 里，异常按 opcode `warnOnce` 一次，然后继续执行。
   - 掩盖了什么：
     - 客体拒绝、协议错误、JS bug 被当成同一种情况处理，同一 opcode 的第二种不同错误永远看不到；
     - 曾经的 `DrawIndexedPrimitiveUP` ReferenceError 就是这样藏起来的；
     - 测试 `d3d9_webgpu_executor_test.js:4380` 还把这一行为固化了，除它之外没有测试断言 `commandsFailed == 0`。
   - 改法：
     - 区分三类错误：`GuestRefusal`（可报告给客体）、`StreamError`（批处理失败）、其他（宿主 bug，在 strict 模式下直接抛出）；
     - 测试默认开 strict。
2. **未知 opcode 静默计数（`E:3713-3721`）；DDraw 处理器是“可选的”（`E:4011-4018`）；opcode 10 映射到不存在的 `this.onUpdateSurface`（`E:3954`）**
   - 掩盖了什么：部署不一致或协议漂移只表现为黑屏，没有任何报错。
   - 改法：
     - 启动时断言处理器表里每一项都是函数；
     - 未知 opcode 在 strict 模式下报错，平时至少要能从统计页面看到。
3. **自动创建状态：`deviceState(handle)` 对任何句柄都新建一个设备（`E:3727-3734`，42 处调用）**
   - 掩盖了什么：陈旧句柄会造出幽灵设备，状态静默分叉。
   - 改法：只有 CREATE_DEVICE 能创建；其他地方查不到句柄就是协议错误。
4. **为 mock 写进产品代码的 `typeof x === "function"`**
   - 现状：约 38 处，针对的是 WebGPU API 和可选 mixin，例如 `createQuerySet`、`onSubmittedWorkDone`、`destroy`、`writeTimestamp`、`replayDDOverlays`。
   - 掩盖了什么：
     - 回退逻辑“立即销毁对象”掩盖了 use-after-destroy；
     - 一个已从 WebGPU 移除的 API 分支（`writeTimestamp`）在 Chrome 上是死代码，却仍然每帧创建一个不会用到、也不会销毁的查询集。
   - 改法：让测试 mock 实现完整接口，删除产品代码里的这些分支。
5. **“修正”客体传来的值**
   - 例子：
     - 视口 MaxZ 0→1（S2-7）；
     - PRESENT 的空矩形替换；
     - 线性雾 `max(end - start, 1e-6)`（`E:2048`），把合法的 FOGEND<FOGSTART 变成阶跃；
     - D3DTSS_CONSTANT 的 `|| 0xff000000`（`E:11264`），把合法的 0 变成不透明黑。
   - 改法：照原样执行 D3D 语义；客体传来非法值时，在客体侧按 D3D 规则返回错误。
6. **告警后继续，产生“看起来合理但错误”的帧**
   - 例子：
     - 深度尺寸不符就丢整帧（S1-8）；
     - `mrt-sample-count` 告警说“用 slot 0 的采样数”，实际仍发出不匹配的附件（`E:7692`）；
     - `writeBufferAligned` 遇到未对齐的更新就告警并丢弃（`E:6297`）；
     - 不支持的纹理 op 退化为 SELECTARG1、法线矩阵奇异时退化为单位阵、混合权重不符时退化为绑定姿势；
     - `noteDroppedDraw` 静默丢 draw，而客体已经拿到 OK。
   - 改法：能在客体侧事前拒绝的就在客体拒绝（返回真实 HRESULT），主机侧改为断言；确实需要的降级，要列入 README 的偏差表，并在 strict 模式下报错。
7. **`createTextureOrNull`（`E:6931`）** 以为 WebGPU 的校验错误会以异常抛出，实际不会（见 S1-5 末段）。改法：在客体用 caps 和格式表事前拒绝，主机显式校验描述符，并配合 error scope。
8. **热路径上的诊断**
   - 例子：没有法线的受光 draw，每次都分配一个诊断对象，即使告警已关闭（`E:10456-10529`）；GTA SA 每个角色批次都会走到这里。
   - 改法：只在 debug 模式下收集诊断。

### 4.2 客体侧

1. **校验比零售版运行时更严格**：Lock 标志（S2-27）、DrawIndexedPrimitive（S2-34）、UpdateTexture（S2-35）、ps_1_4 `cnd`（S2-41）。
   - 这些检查的写法更像 debug runtime，而零售 D3D9 和 Wine 会接受并忽略这些输入。真实游戏是对着零售运行时写的，所以这种严格不是保护，而是把能用的调用变成失败。
   - 改法：以 Wine `dlls/d3d9/tests` 的期望值为准；对“Windows 从不报错”的组合，清洗标志而不是拒绝调用。
2. **影子先更新、再发命令**（`G8:3797, 3823`，`G9` 中大量 Set*）。发送失败时，影子与主机永久分叉（冗余过滤会挡住后续重发）。传输失败本来就是全局永久的，这些逐调用的失败分支实际上毫无用处。
   - 改法：
     - 传输失败只在一个地方处理，响亮地失败一次；
     - 去掉逐调用的失败分支；
     - 影子和发送放进同一个函数原子完成。
3. **不可能失败的校验和重试**
   - `validate_vertex_declaration` 的 `(token>>29)&7 > 7` 恒为假（`G8:1151-1153`），而且它不跳过 CONST 载荷；
   - `allocate_shader_handle` 为 `|1` 后不可能出现的零句柄重试（`G8:582-585`）；
   - `ValidateVertexShader`/`ValidatePixelShader` 对任何输入都返回 S_OK（`G8:8780-8800`）。
   - 改法：删除；真正的校验放在 Create* 共用的那一个函数里。
4. **为了少打一行日志的特判**：`-PCF` 格式探测（`G9:4382-4389`），还专门配了一个用源码字符串提取的测试。改法：删除。
5. **配置开关和死代码**
   - caps 配置有 6 个别名，外加一个旧变量（`G9:3238-3256`）；
   - 三张被 `#if` 掉的适配器身份表；
   - XP 上 QueryPerformanceCounter 的 GetTickCount 回退。
   - 改法：只保留一个开关，其余删除。
6. **追踪噪声**：TRACE、TRACE_MARK、HOSTLOG 包住几乎每个调用，例如 `device_create_vertex_buffer` 一个校验有 8 个追踪点。改法：用表驱动的方法追踪器统一生成。
7. **D3D8 的拒绝在主机侧看不见**：`G8` 没有 `GUEST_LOG`/`HOSTLOG_REFUSED`，`G9` 有（`G9:1764-1859`）。改法：用共用核心统一。

### 4.3 统一原则

- **客体是 D3D 语义的唯一裁判。** 能在 Create/Set 时拒绝的，就按 Wine 测试确定的零售语义拒绝或清洗。
- **宿主只执行，不猜测。** 它对协议做断言；WebGPU 错误一律经 error scope 捕获，计数并回报。
- **每一种降级都必须同时满足三条：** 在 README 偏差表中有一行；在 strict 模式下报错；有测试覆盖。

## 5. 结构问题

### 5.1 分层与重复

| 重复 | 位置 | 已出现的漂移 |
| --- | --- | --- |
| 传输/批处理 | `G9:1514-1885`、`G8:589-865`、`GD:375-580` | 失败策略不同（d3d9/d3d8 永久失败，DDraw 重试）；`G8` 缺响应区清零和 GUEST_LOG |
| 格式与上传 | `G9:1897-2527`、`G8:1650-1865` | `G8` 没有分带上传（S1-12）；格式表各自增删 |
| 默认状态 | `G9:3971-4076`、`G8:2858-2923`、`E` 中几十处回退值 | S2-38 |
| caps | 每个前端一份 `fill_caps` | — |
| 窗口跟踪/WinEvent | `G9:5041-5205`、`G8:1901-2260`、`GD:4265-4310` | `G8` 还另外子类化了窗口过程 |
| COM 对象（VB/IB/纹理/表面/立方体/体积） | 两份 | Lock 规则逐字相同（含 S2-27） |
| 软件 T&L | `G9:9875-10100`、`G8:6754-7114`、`D7:2831` | 三份都与宿主固定管线不一致 |
| Patch | `G9:10366-11226`（Bezier + N-patch）、`G8:7488-7727`（只有线性） | D3D8 拒绝 D3D9 已经能做的 |
| 状态块 | `G9:12637-13142`、`G8:6310-6651` | 范围语义不同 |
| `MultiplyTransform` | 三份 | 三份顺序都错 |
| 全屏四边形管线 | `E` 的 blit、gamma、rect-clear、ColorFill、光标，加上 `DO:970` | 6 套顶点着色器和缓存；ColorFill 是 rect-clear 的子集 |
| 字节码哈希 | `G9:3023`、`G8:1103`、`SP:2303` | 宿主不信任客体的哈希，会重算一遍 |
| SM1 操作数表 | `SP:139`、`G8:899`、`d3d8_executor.js` | S2-41 |
| varying 布局 | `E:1768`、`SP:506` | 与 GTA SA 插值 bug 属同一类漂移 |

### 5.2 宿主执行器

- **单文件 12.5k 行。** 其中：
  - `finishFrame` 约 730 行，包含嵌套闭包，每帧对 ops 做多次 O(n) 扫描；
  - `programFor` 约 750 行。
- **状态所有权不清。**
  - 设备状态、会话状态、执行器全局状态（back buffer、uniform ring 游标）混在一起；
  - S2-22 和 S1-11 中 uniform 串扰的根源就在这里。
- **用影子和“重命名”模拟上传顺序。**
  - 每次上传在宿主存两份：展开后的数据永久保存在 `textureShadows`，另有预览切片和调色板源。
  - 一张 L16 4096² 纹理在 JS 堆上占 128 MB。
  - S2-15 的三个错误都来自这套机制。
  - 正确做法（DXVK 的做法）：上传按帧内顺序记录成 staging 加 copy op，由提交顺序保证次序，影子和重命名一并删除。
- **性能（测量值）。**
  - 绘制路径审查员用一个什么都不做的 GPU mock 测得：每个固定管线 draw 约 15–17 µs，一帧 2000 个 draw 约 30 ms JS（与模拟器共用一个线程）。
    - `programFor` 占 48%：固定管线 WGSL 每个 draw 都重新生成，再按全文查模块，生成约 9.7 µs；
    - `pipelineFor` 的 `JSON.stringify` 占 11%；
    - GC 占 6.5%。
  - 动态状态进了管线 key：只改 STENCILREF（模板未开）、只改 BLENDFACTOR（混合未开）或只改 ALPHAREF（alpha test 未开）的 200 个 draw，各自产生 200 条管线，缓存从不淘汰。
  - ALPHAREF 和 LOD bias 被编进 WGSL，每个新值都要在绘制路径上同步翻译一次着色器。
  - 每条管线有独立的 bind group layout，bind group 无法共享；UP draw、三角扇每次都新建 GPU 缓冲；常量每个 draw 新建 ArrayBuffer。
  - A8R8G8B8（最常见的格式）在 JS 中逐 texel 交换通道，本可以直接上传成 `bgra8unorm`；A16B16G16R16F 每个 texel 分配一个 subarray。
  - 每个批处理被复制三次，每次最多 12 MiB。
- **着色器 worker 只增加延迟，没有并行。** 每次 Create 都按顺序等一次往返（`E:3663-3668`）。缓存只存基础翻译，而大多数 draw 用的是变体。
- **存档靠重放全部历史。** 历史无界增长，会话结束时不压缩，重放时会重跑所有历史回读。这在文档里写明了，但属于设计债务。

### 5.3 客体

- `d3d9_proxy.c` 15k 行、`ddraw` 13k 行，各是一个翻译单元，没有可单独编译测试的纯逻辑模块。
- **每次 Present 约 20 次 user32/gdi32 调用。** 包括窗口探测、`GetDC`/`GetRandomRgn`/`GetRegionData`、覆盖判断、`GetCursorInfo`。WinEvent 钩子已经存在，应改为事件触发时才重新探测。
- **内存拷贝与流量：**
  - `reserve_command_locked` 先把整条记录（含载荷）清零，再由调用者拷贝覆盖（`G9:1720`），上传和 UP draw 的内存流量翻倍；
  - SYSTEMMEM/SCRATCH 纹理也在宿主建 GPU 纹理并上传，UpdateTexture 时再上传一遍；
  - D3D8 的 `Clear` 逐像素填写 CPU 影子，1024×768 就是 78 万次循环，而且跑在被模拟的 CPU 上。这个影子唯一的消费者正是 S2-36 那条错误路径。
- **DDraw 的线路冗余：**
  - 每次 SetTexture 重发 4 个颜色键和调色板绑定；
  - 每个 draw 重发 SET_FVF；
  - VB Unlock 上传整块缓冲；
  - `DrawIndexedPrimitiveVB` 把顶点当 UP 数据重发；
  - 窗口化主表面的每次 Blt 都是一次 present 加一次 VM exit。

## 6. 测试体系评估

### 6.1 实际运行结果（测试审查员；像素原型由我复跑）

| 套件 | 结果 |
| --- | --- |
| `d3d9_webgpu_executor_test.js` | 168 项通过，0.6 s；161 条相同的“no guest-memory writer”告警淹没其他输出 |
| `ddraw_webgpu_executor_test.js` | 25 项通过 |
| `d3d9_shader_pipeline_test.js` | 47 项通过 |
| WGSL 校验（naga 30） | 190 个翻译着色器和 27 个 DDraw blit 着色器通过 |
| `d3d9_shader_corpus_test.js` | SKIP：磁盘上不存在任何语料 |
| 退役 D3D8 执行器的单元、性能、路由、checkpoint、journal、shared-device 测试 | 全部通过 |
| `retro-gaming-site/glbridge/tests` 的 13 个客体测试 | 全部通过 |
| 真 GPU：`d3d9_webgpu_browser_test.html`、`d3d8_webgpu_browser_test.html`、`d3d9_legacy_format_browser_test.html` | 通过 |
| 真 GPU，需要 `build/` 产物：`d3d9_virtio`、`graphics_checkpoint`、`display_compositor`、`svga_renderer`、`svga_fixed_function` | 通过（产物比源码新） |
| **像素一致性原型**（19 个探针） | **3 个失败，即 S2-3（含 alpha test 后果）和 S2-2 的雾**；我在本机复跑结果相同 |

### 6.2 测试在断言什么

- **mock GPU 只检查两条规则：** bind group 与 layout 匹配；`writeBuffer` 4 字节对齐（`d3d9_webgpu_executor_test.js:303-545`）。它跳过了：
  - WGSL 编译；
  - `createRenderPipeline` 的全部校验：阶段间接口与插值、顶点格式、目标格式、可混合性、采样数、限额；
  - 管线 layout 与着色器绑定是否一致，采样器与纹理类型是否兼容；
  - usage 标志、`bytesPerRow` 256 对齐、附件尺寸一致、动态偏移对齐。

  共有 6 套互不相同的假 GPU，DDraw 那套更弱。S1-5、S1-6、S1-7、S1-8 在 mock 下全部“通过”。
- **变异实验：12 个一行级语义错误只抓到 2 个**（寻址模式、DDraw 索引色颜色键）。漏掉的 10 个是：
  - 剔除方向颠倒；
  - 深度比较 LESS/GREATER 互换；
  - SRCALPHA/INVSRCALPHA 互换；
  - SUBTRACT/REVSUBTRACT 互换；
  - MODULATE2X 少乘 2；
  - D3DCOLOR 通道顺序错误；
  - `rcp(0)` 返回 0；
  - 线性雾用 START 代替 END；
  - `lit()` 丢掉 N·L 判断；
  - DDraw RGB 颜色键改成不含端点。
- **断言的是文本和计数器，不是结果：**
  - 执行器测试中 122 条断言匹配 WGSL 子串，管线测试中 76 条；
  - 284 条断言检查统计计数器，另有一些测试直接探查执行器的私有状态；
  - 回读得到的“像素”是测试自己注入到假纹理里的。
- **唯一的 D3D9 真 GPU 页面只检查计数器和校验错误，从不检查像素**，而且不在任何 make 目标里。
- **CI 中的静默跳过：** CI 跑 `make ci-tests` 但没有安装 naga，两个 WGSL 校验测试打印 SKIP 后算作通过；客体测试完全不在 CI 里。
- **覆盖率：** `d3d9_executor.js` 行覆盖率 84.7%，但 D3D9 Reset（`onReset`）、`onDrawPrimitiveUP`、Begin/EndScene、像素着色器的 int/bool 常量从未被 Node 测试执行。
- **客体测试主要是正则匹配 C 源文本**（例如断言源码中存在 `depth_width\s*<\s*render_target_width`）和 vtable 布局检查，没有执行任何 `d3d*_proxy.c` 的逻辑。
- **`glbridge/sample/*.c` 没有运行器，大多也不检查自己的像素。**

### 6.3 各领域“测试用例数”与“真 GPU 像素检查数”

| 领域 | 用例（mock/静态/naga） | 真 GPU 像素检查 |
| --- | --- | --- |
| DDraw 2D | 25 + 27 + 约 20 项客体检查 | 1（颜色填充） |
| D3D1–7 3D | 只有 vtable 检查 | 0 |
| D3D8 现行路径（d3d8.dll → D9WG） | 1 个正则测试 | 0 |
| D3D9 固定管线 | 约 50 | 0（另有约 4 个经 SVGA 路径的） |
| D3D9 着色器 | 约 290 | 0 |
| 资源与格式 | 约 46 | 1–2（经 SVGA 的 texel 回读） |
| 协议与帧格式 | 约 10 | 不适用 |
| 存档/恢复 | 少量 | 约 6（只有清屏和填充） |

**结论：** 现有测试回答的是“代码有没有按作者的理解运行”，而不是“结果是否符合 D3D”。因为期望值同样来自作者的理解，同一个误解会同时写进代码和测试，S2-8 的 256 就是实例。

## 7. 分阶段重构方案

阶段之间有依赖：0 → 1 → 2 → 3/4（3 和 4 可以并行）→ 5 → 6。每个阶段结束时，KartRider、GTA SA、3DMark06（D3D9）、3DMark 2001 SE、MapleStory（D3D8）、Diablo II、3DMark 99/2000（DDraw/D3D7）都不能退步。

### 阶段 0：止血，让错误可见（约 1–2 周）

> **状态（2026-10-29，分支 `refactor`）：完成，客体部分尚未在 XP 中运行。**
> - 宿主（v86）：
>   - `a77b4c3a`：错误捕获、失败不粘滞、D8WG 退役；
>   - `d579d206`：S1-5a/b/c、S1-7、S2-1、S2-7、S2-8、S2-9、S2-17；
>   - `a79f7e23`：MSAA（S1-6、S2-24）；
>   - `fe54bbe6`：arena 所有者释放即结束会话、Reset 保留资源。
> - 客体（retro-gaming-site）：`fe324b4`，含 S1-2、S1-3、S1-9a/b、S1-10、S2-28、S2-29。
> - 验收：
>   - 真 GPU 一致性页 `tests/glbridge/d3d9_conformance_browser_test.html`，含已知失败表；
>   - Tint 页 `d3d9_shader_tint_browser_test.html`。
>   - 上述两页的每个新用例都在上一个提交上失败。
> - 偏差：已登记在 `d3d9proxy/README.md` 的 “Deviations from D3D9”。
> - 2026-10-30 共用传输回归：GL 的内联响应增加提交生命周期检查，D3D 的专用响应槽仍按 arena 生命周期处理；Node 的 D3D9/DDraw/桥接测试及 D3D9 一致性、Tint、旧格式等真 WebGPU 页面再次通过。D3D 客体仍未在 XP 里验收，阶段 3–6 尚未开始。

- **目标：** 所有 S1 不再发生；任何 WebGPU 错误都能被看到、被计数、被测试断言。
- **改动：**
  - **错误捕获：**
    - 管线创建和每帧提交都套 error scope；坏管线驱逐出缓存；
    - `noteDroppedDraw`、`commandsFailed`、未知 opcode 通过 GUEST_LOG 或统计回报；
    - 增加 `strict` 选项，测试默认开启。
  - **失败策略：**
    - 去掉粘性的 `this.failed`，失败只作用于本批处理并上报（S1-1）；
    - 主机在任何丢弃 ops 的路径上回答挂起查询，客体 `GetData` 加期限（S1-2）；
    - 驱动超时后复位队列而不是销毁传输，客体传输统一采用 DDraw 的退避重试（S1-3）；
    - d3d9/d3d8 发送 SESSION_END，驱动在关闭句柄时补发（S1-10）。
  - **小而确定的修复，每项几行到几十行：**
    - S1-5 a/b/c/f；
    - S1-7（`diagnostic(off, derivative_uniformity)`）；
    - S1-9 a/b；
    - S2-1、S2-7、S2-8（257）、S2-9（`p0f`）、S2-17、S2-28、S2-29。
  - **MSAA（S1-6）：** 直接实现。多采样颜色附件加 `resolveTarget`：back buffer、MSAA 渲染目标和自动深度采样数一致；`StretchRect`/`GetRenderTargetData`/Present 从 resolve 结果读取；S2-24 一并修正。验证用真 GPU 页面在 4x 下检查像素和 error scope。
- **风险：**
  - strict 模式会让现有游戏暴露大量已有错误，所以先只在测试和 debug 下开启；
  - 关闭 derivative_uniformity 不改变语义：D3D 在非一致控制流里的导数本来就是未定义的。
- **验证：**
  - 每个修复都配一个真 GPU 页面用例，用 error scope 断言没有校验错误，并检查像素；
  - 上述游戏冒烟测试，并截图对比。

### 阶段 1：测试底座（约 2 周，可以与阶段 0 后半并行）

> **状态（2026-10-29，分支 `refactor`）：大部分完成。**
> - `bb6721f0`、`7007986f`、`b00d62aa`：
>   - 共用的严格假 GPU（`tests/glbridge/webgpu_rules.js`），naga 必须存在；
>   - 一致性页带已知失败表；
>   - 变异实验 `make glbridge-mutations`，D3D9 12/12；
>   - `make glbridge-gpu-tests`。
> - 未做：CI 里跑 SwiftShader 真 GPU 页；从真实游戏录制轨迹。

> **阶段 1A（2026-11-01）：CI 目标与客体回读边界完成。**
>
> - 新增 `make d3d-review-gpu-tests` 与独立 CI job：强制 SwiftShader，先核对实际适配器，再执行 D3D9 一致性、Tint 和浏览器页；同一 job 取配套站点 `refactor`，安装 clang/MinGW/naga 并执行客体 ABI 测试。配置按 Chromium 自身的 [WebGPU SwiftShader 测试参数](https://github.com/chromium/chromium/blob/main/third_party/blink/web_tests/FlagSpecificConfig)设置。远端 CI 尚未触发，本机已执行相同浏览器目标并全部通过。
> - 33 个一致性场景改由真正的 `READBACK_SURFACE` 和客体响应包取像素，不再直接拷贝测试纹理。S2-2/S2-3/S2-6 三项原有已知失败仍明确保留，后续在阶段 3 修复。
> - 增加 V86GTRC1 浏览器录放 codec，与既有 x64 recorder 逐字节交叉验证，并拒绝截断/空包/未知记录。真实游戏录制、黄金回放和特性分表继续阶段 1B；首次 Warcraft III 启动未进入绘制，保留为失败诊断，未计通过。

> **阶段 1B（2026-11-01）：录放底座与 Warcraft III 地图基线完成；GTA SA 尚未通过。**
>
> - `tools/d3d_guest_review.mjs` 编译当前三个代理 DLL，生成工具光盘；XP 和游戏盘只读打开，DLL 复制发生在 RAM overlay。`d3d_guest_trace_capture.html` 从实际呈现中等待 32 帧，停止客体后通过 READBACK 收集完整图像，拒绝近乎均匀画面与任何渲染错误。GTA SA 的菜单/场景选择保留为手动操作，不能把菜单绘制计作世界场景验收。
> - Warcraft III 实际地图：592×383，479 包、169,226,688 字节、83,329 次索引绘制；宿主/WebGPU 错误、失败命令、丢弃绘制均为零。此版本加载的是 D3D9，工具光盘同时提供 D3D8/D3D9，不能据此宣称 D3D8 已验收。私有轨迹与完整图像留在忽略的 `build/browser-test-output/`；可审查的输入哈希、计数和重复测量见 [warcraft3-baseline.json](fixtures/d3d-review/warcraft3-baseline.json)。
> - 同一未修改宿主的重复回放出现零至十余字节波动，原因未定。`tools/d3d_trace_baseline.mjs` 固定 `81d8d626` 的五份执行器源码，只从该基线收集有限 RGBA 元组；当前保留 25 份可核验观测，加原始图像，共 11 个可变像素。候选不能扩张位置或颜色集合，其他像素逐字节一致。早期采样曾复用文件名，已改为独立归档与原子更新；被覆盖的试验不列入证据。此政策仅用于宿主回归，不证明原生 D3D 一致性。
> - `tools/d3d_trace_evidence.mjs` 导出前核验轨迹、黄金图、报告和保留图像的 SHA-256。回放报告里的 `dispatchMs` 统计所有命令分派，不能充当阶段 3 的每 draw 开销。
> - 回放器支持原始 V86GTRC1 和产品分页 journal，处理所有者释放与 checkpoint barrier。两个公开、规范推导的绿色图像 fixture 都纳入 `make d3d-review-gpu-tests`；本机 SwiftShader 扩展目标通过，核心 116 组、站点客体 71 组通过。远端 CI 未触发。
> - GTA SA 已进入加载并产生 1,588,543 次索引绘制，随后黑屏且不再呈现，宿主没有报告渲染拒绝。保留约 745 MiB journal 与完整 VM 现场，未计为通过。EIP 位于游戏 `CTrain::ProcessControl` 的浮点循环，关闭浮点近似和 x87 cache，并重新应用存档控制字后，恢复运行 120 秒仍无新呈现，EIP 已离开原采样点；原因未确定，不能归因于浮点精度或 D3D，也不能断言修复。

本地重现（包含游戏内容的文件不提交）：

```sh
node tools/d3d_guest_review.mjs
GL_TIMEOUT_MS=900000 node tests/glbridge/gl_multipass_browser_runner.js 'd3d_guest_trace_capture.html?game=warcraft3'
node tools/d3d_trace_baseline.mjs d9wg-warcraft3-worker 8
GL_TIMEOUT_MS=590000 node tests/glbridge/gl_multipass_browser_runner.js 'd3d_game_trace_replay_browser_test.html?prefix=d9wg-warcraft3-worker&policy=frozen'
node tools/d3d_trace_evidence.mjs d9wg-warcraft3-worker docs/fixtures/d3d-review/warcraft3-baseline.json
```

特性分表与剩余游戏验收继续阶段 1C/6；阶段 1 整体尚未关闭。

> **阶段 1C（2026-11-01）：按特性分表的像素底座完成。**
>
> - 33 个原有场景加 100 个独立规范场景，共 133 个：48 种已宣称可采样纹理格式的 RGBA、25 种已宣称纹理运算（含 DOT3 alpha、凹凸贴图）、六种雾组合、七种材质/灯光、sRGB 读写，以及 DirectDraw 原生格式填充、键范围端点和镜像 blit。`?group=formats|texture-ops|fog|lighting|srgb|ddraw` 可独立执行。PREMODULATE 未宣称，不纳入能力覆盖。
> - 期望值来自 [D3DFORMAT](https://learn.microsoft.com/en-us/windows/win32/direct3d9/d3dformat)、[D3DTEXTUREOP](https://learn.microsoft.com/en-us/windows/win32/direct3d9/d3dtextureop)、[雾公式](https://learn.microsoft.com/en-us/windows/win32/direct3d9/fog-formulas)、[仿射投影下的像素雾规则](https://learn.microsoft.com/en-us/windows/win32/direct3d9/pixel-fog)，以及 Wine `66caeb46` 的 `utils.c` 格式 swizzle / `visual.c` 材质用例；不调用宿主格式转换或固定管线生成器推导预期。
> - RGBA 探针走完整 READBACK；已知像素失败不能掩盖 GPU/宿主错误、失败命令或丢弃绘制。19 项失败显式登记，修好即要求删除登记：原有三项，缺失通道五项、ATI swizzle 两项、仿射表雾三项、DOT3 alpha、X8/565 填充、缺颜色材质回退、两种 bump uniform。后者定位为 `uniformBlockLayout` 丢掉 `bumpSource` / `bumpLuminanceSource` 元数据，留待阶段 3 修复。
> - 站点新增 `d3d_pixel_coverage_test.js`：广告的每种采样格式与纹理运算都必须有像素 fixture；新增能力而未补 fixture 会令 CI 失败。该检查不代表渲染目标、深度或全部 `QUERY_*` 能力已经验收，阶段 3/4/6 仍须补齐。
> - SwiftShader 上 133 场景完成：114 符合规范、19 已知像素失败，零 WebGPU 校验错误。完整浏览器目标通过，D3D 语义变异 12/12 拦截；可审查结果见 [feature-baseline.json](fixtures/d3d-review/feature-baseline.json)。游戏清单仍未全通过，阶段 6 继续，不以测试底座完成代替游戏验收。

- **目标：** 测试能发现语义错误；变异实验从 2/12 提升到 ≥10/12。
- **改动：**
  - **严格的假 GPU（一套共用）：**
    - 内置 naga 校验、阶段间链接检查、layout 检查、对齐检查；
    - 加入 WebGPU 规则：MIN/MAX 因子、线/点 depthBias、写掩码对应输出、附件尺寸和采样数一致、查询集上限、copy 对齐；
    - 出现意外告警或失败命令时测试失败。
  - **把像素原型扩成表驱动的真 GPU 一致性套件。**
    - 按特性分表：渲染状态、纹理 stage op（含无纹理）、雾的各模式、光照、每个宣称支持的格式、DDraw blit 与颜色键、光栅化规则、MSAA、sRGB。
    - 期望值取自 D3D 文档和 Wine `visual.c`。
    - 回读走客体可见的 READBACK 命令。
  - **把真 GPU 页面纳入 make 目标，修正 CI：**
    - CI 安装 naga，SKIP 视为失败；
    - 客体测试进入 CI。
  - **从真实游戏录制 D9WG 轨迹。** 基础设施已有：`tests/x64/gpu_trace.mjs`、`tests/ir/performance/game_state.mjs`。用轨迹在真 GPU 上重放并做黄金图像比对，作为阶段 3 重构的回归网。
- **风险：** 有些期望值来自记忆，需要对照 Wine 测试源码核对（要先下载，见 §8）。
- **验证：** 变异实验成为常设测试；故意回退阶段 0 的修复，应当失败。

### 阶段 2：协议单一来源（约 1–2 周）

> **状态（2026-10-29，分支 `refactor`）：宿主完成；客体头文件随后在 retro-gaming-site 重新生成。**
> - 单一来源是 `src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js`：
>   - 头文件的全部内容按顺序记录（`ITEMS`），结构体布局（`STRUCTS`、`F`）由它算出；
>   - `COMMANDS` 给出每个 opcode 的载荷结构体；
>   - `ADDED_FIELDS` 列出 1.3 之后加的字段，`minBytes`/`has` 由它得出。
> - `tools/gen_d9wg_header.mjs` 生成：
>   - 客体的 `d3d9_protocol.h`，每个结构体的 sizeof 和每个字段的 offsetof 都有断言（typedef 数组，C89 可用）；
>   - `--svga` 生成 `src/graphics_adapters/vmware_svga/d9wg_constants.js`。
> - 执行器：
>   - 所有载荷字段经 `D9WG.F` 读取，字面偏移已删除；
>   - 载荷长度在 `dispatchCommand` 统一按 schema 检查，各处理函数里的长度检查已删除；
>   - 版本范围 1.3–1.7 真正测试：1.3 的短载荷把新增字段读成 0；
>   - 批处理先整体检查结构（大小、`sequence` 连续、数量），通过后才执行任何命令。
> - `svga3d_d9wg.js` 的 opcode、资源种类、版本来自生成文件；debug 构建断言每个载荷不短于其结构体。
> - 测试：`tests/glbridge/d9wg_protocol_test.js`：
>   - 生成的头文件能编译，改错一个偏移就编译失败；
>   - 编解码往返；
>   - 1.3 短载荷；
>   - 执行器处理表与 `COMMANDS` 完全一致；
>   - SVGA 生成文件是最新的。
> - 未做：
>   - 大多数测试编码器仍按顺序手写字段（性能测试已改用 `D9WG.encode`）；
>   - `svga3d.js` 仍按顺序写字段，只检查长度；
>   - 轨迹重放逐字节比较要等阶段 1 的轨迹。

> **阶段 2A（2026-11-01）：SVGA 与主要测试编码器完成迁移。阶段 2 整体仍待 2B 清理局部 fixture。**
>
> - schema 生成 SVGA 的字段名、偏移、类型、数组长度和 opcode→结构体映射。47 个 SVGA 命令头及变换、材质、灯光、矩形、顶点声明、shader/上传数据块改为命名字段，删除顺序写入器和数字占位偏移。包头/命令头也由 schema 填写；调试解码器拒绝截断、零大小和数量不符，避免损坏轨迹导致死循环。
> - 新增 `D9WGProtocol.encodeBatch`，统一主要 D3D9/DDraw/性能/像素测试和浏览器传输、工作线程、存档、合成页的构包。数据块按字段名定位；未知字段名、错误数组长度立即失败；旧版本/故意损坏输入仍可传原始载荷。编码器不修改调用者输入，旧测试兼容层只为既有损坏输入检查回填偏移。
> - 增加没有改变现有布局的 `D9WGRect` 定义并重新生成客体头文件。所有 72 种命令载荷与 canonical encoder 逐字节一致；1.3–1.7 包头与短载荷、多个命名 blob、内联数组都有检查。
> - 与 `52e1dfdf` 比较：SVGA 两套原样 FIFO 测试的 19 批、7,416 字节完全一致；133 个公开像素输入的 126,912 字节完全一致，见 [schema-wire-baseline.json](fixtures/d3d-review/schema-wire-baseline.json)。Warcraft III 私有轨迹按原先冻结政策回放通过。
> - 验证：118 组非语料核心入口、72 组客体入口；源码和 Closure 发布构建的 SVGA FIFO 测试；133 场景 SwiftShader 目标；真实 virtqueue/CPU worker、同实例及冷存档恢复、遮挡/区域合成页面；D3D 变异 12/12。详见 [stage2-validation.json](fixtures/d3d-review/stage2-validation.json)。远端 CI 没有触发。
> - 存档浏览器页原有“至少三次回放”断言在原页面和站点原 `8523858ab36865e264c6` 运行包上同样失败：GL 已使用资源快照，只剩两个 D3D 会话回放。改为明确检查 session 9/10、每次历史回放不可见，以及 GL 活资源和 D3D9/DDraw 的同实例/冷恢复像素；没有放宽像素断言。
> - 从 GTA SA 诊断 journal 原样提取 12 个 shader，私有字节码留在 `build/d3d-review/corpus`，仅提交 [哈希清单](fixtures/d3d-review/gtasa-shader-corpus.json)。`D3D9_CORPUS_STRICT=1 D9_SHADER_CORPUS=build/d3d-review/corpus node tests/glbridge/d3d9_shader_corpus_test.js` 翻译/Naga 均 12/12；严格模式缺语料、空语料或缺 Naga 会失败。此结果不代表 GTA SA 游戏启动或阶段 5 的差分矩阵已通过。
> - 配套运行包已重建并同步站点：核心仍为 `cc49eed222f9fb724ba3`（核心执行逻辑未变），WebGPU 为 `05cdab879d36d9beb7b9`。镜像不写回。
> - **2B 继续项：** 主执行器测试中部分局部上传/查询/UP draw 等 fixture 仍以 `Buffer.alloc` 和字段写入构造；逐个迁移其正向载荷，保留明确的损坏输入实验。完成后才关闭阶段 2，进入阶段 3。

> **阶段 2B（2026-11-01）：完成局部 fixture 清理，阶段 2 关闭。**
>
> - 主执行器测试的 36 个局部初始化器改用命名编码，剩余分量修改与故意损坏输入的目标偏移改用 `P.F`。gamma 数组、窗口区域、Clear 矩形、交换链、LOD/Reset、UP draw 和上传 fixture 都引用 schema；原始 DWORD 仅保留 shader token、texel 和明确的未知 opcode 输入。
> - 173 个执行器用例及原有失败路径断言通过；存档和协议套件通过。构包边界捕获的 221 批、164,408 字节与 `bb97f595` 完全一致，见 [executor-wire-baseline.json](fixtures/d3d-review/executor-wire-baseline.json)。捕获点位于故意破坏 framing 之前，这些破坏实验另由原有断言验证。
> - 无生产语义或运行资源变更，继续使用 2A 的匹配站点头文件与 `05cdab879d36d9beb7b9` 运行包。接下来按模块推进阶段 3。

- **目标：** 协议漂移在构建时就失败。
- **改动：**
  - 用一份 schema（JSON，或带注解的头文件）生成：
    - C 结构体，附 `_Static_assert(sizeof/offsetof)`；
    - JS 解码表（字段偏移、各 minor 版本的最小长度）；
    - 测试用编码器；
    - `svga3d_d9wg.js` 的常量。
  - 删除手写的字面偏移。
  - 要么真正测试 1.3–1.7 的版本范围，要么收窄到当前版本。
  - 用 command 头里被忽略的 `sequence` 字段做完整性检查。
  - **退役的 D3D8 执行器（2026-10-29 决定：不兼容旧存档）：** 删除 `d3d8_executor.js`、0xFFE0 路由、v1/legacy checkpoint 中的 D3D8 恢复分支及其测试；0xFFE0 批处理和含 D8WG 载荷的旧存档改为报明确错误。这一步不依赖协议 schema，可以提前到阶段 0 末尾做。
- **风险：** 机械性的大改动。
- **验证：**
  - 用生成的编解码器做往返测试；
  - 重放阶段 1 录下的轨迹，结果必须逐字节相同。

### 阶段 3：宿主执行器重构（约 4–6 周）

> **阶段 3A（2026-11-01）：独立线路校验模块完成；阶段 3 继续。**
>
> - `d9wg_wire.js` 独立处理包头、版本范围、记录边界、命令数量和 uint32 序号连续性，并持有统一的 stream error 类型及 schema 最小载荷表。没有 GPU、会话或资源副作用，也不分配每命令对象。执行器通过它验证后继续原有分派，错误计数及坏命令/坏批的区别保持不变。
> - 保留现有 1.3–1.7、非零起始序号与回绕、传输 carrier 尾部字节的契约；没有在此子阶段变更渲染语义或载荷解析策略。新纯函数测试覆盖合法/损坏包、非零 byteOffset、carrier、版本、未知 opcode 和序号回绕。
> - 直接加载页面和发布构建显式加载新模块；固定旧宿主的回放仍使用旧宿主自身的五个文件，不混入候选模块。客体协议检查改为实际验证 parser 的版本范围，替代对旧执行器源码变量声明的正则断言。
> - 120 组核心检查（私有 shader corpus 严格执行，无 SKIP）、72 组客体检查、站点两项 graphics integration、133 场景 SwiftShader 目标、工作线程和完整存档恢复、Warcraft III 冻结回放、D3D 12/12 变异均通过。证据见 [stage3a-validation.json](fixtures/d3d-review/stage3a-validation.json)。
> - 配套站点运行包更新为 `07c8009386d3da396e6e`，核心仍为 `cc49eed222f9fb724ba3`。接下来处理显式设备/会话对象及资源归属；19 项已知像素偏差、每 draw <3 µs、客体共用核心和完整游戏验收仍未完成。

> **阶段 3B1（2026-11-01）：会话状态及 uniform 隔离完成；继续 3B2。**
>
> - `d9wg_state.js` 独立建立设备/会话状态。每个会话拥有 uniform ring、CPU staging 和写游标，切换会话保存/恢复；结束 owner 仅回收自己的 GPU 缓冲。
> - 新增两会话交错录制测试：相同客体句柄、相同 uniform 偏移，两帧都保持未呈现。3A 中 B 的绿色覆盖 A 的红色（4,096 个像素错），修复后通过 READBACK 检查的 8,192 个像素全部正确；没有 GPU/宿主错误、丢弃或失败命令。该用例加入 CI；它是宿主隔离验收，XP 驱动多 owner 仍属阶段 4。
> - 121 组核心（严格 corpus，无 SKIP）、72 组客体、两项站点集成、133 场景及新增隔离页面、原生 GPU 的 Warcraft III 冻结回放、SwiftShader 工作线程/完整存档恢复、12/12 变异均通过。游戏冻结图使用原始原生适配器；另一次 SwiftShader 对原生图的比较不满足同适配器条件，未计为通过。证据见 [stage3b1-validation.json](fixtures/d3d-review/stage3b1-validation.json)。
> - 配套运行包 `017490988930d2e252be`。3B2 继续移除隐式设备创建、隔离各设备 back buffer；资源顺序、固定管线的 19 项偏差和 draw 预算保持待办。

> **阶段 3B2（2026-11-01）：设备 back buffer 隔离完成；继续 3B3。**
>
> - 每个设备持有自己的单采样 back buffer 和线性/sRGB 视图；绘制、clear、StretchRect、DDraw blit 在录制时保存对应视图，pass key 包含真实纹理身份。READBACK 按请求设备读取，Present 只复制所选设备；执行器/会话的旧字段仅保留最近选择设备的诊断别名。
> - 新建 B 不再丢弃 A 的未呈现帧；重置 A 先提交已录制工作，再仅回收 A 的纹理。DDraw 切换模式同样保留其他设备。不同尺寸设备不会再与最后 Present 设备的尺寸误比较。
> - 修复前同会话两设备出现 4,096 个红色像素被绿色替换，修复后全 8,192 像素正确。新增不同尺寸交错 clear、独立 pass、Reset 保留 B 及 GPU fence 后回收 A 的检查。
> - 122 组核心（严格 corpus，无 SKIP）、72 组客体、两项站点集成、133 场景及两种隔离页面、原生 GPU Warcraft III 冻结回放、SwiftShader 完整存档恢复通过。配套运行包 `fb445497baa3807c1523`；见 [stage3b2-validation.json](fixtures/d3d-review/stage3b2-validation.json)。3B3 接着移除隐式设备创建并更新 SVGA 的显式创建路径；资源/FFP 等后续模块仍待办。

> **阶段 3B3（2026-11-01）：显式创建设备完成；继续资源模块。**
>
> - `deviceState` 仅查找已有设备，未知句柄令对应命令失败并继续处理后续命令，不再制造设备。Reset 必须有有效旧设备且新句柄不冲突；保留逻辑对象身份并更新 generation/defaults。新增负向测试证明普通命令及 Reset 都不能隐式创建。
> - SVGA 的首条资源操作前显式建立 utility device，每个 context define 显式建立设备；reset/存档重建按相同顺序重发。vgpu9/gb9 测试逐条检查带设备字段的命令必须已有 CREATE_DEVICE，源码和发布构建均通过。
> - 实际 SVGA 工作线程页暴露 Clear 被 viewport 裁剪为一个像素。依据 [VMware 参考驱动的 Clear 契约](https://raw.githubusercontent.com/prepare/vmware-svga/master/lib/refdriver/svga3d.c)，翻译层临时覆盖 viewport/scissor，清除后恢复原绘图状态；实际页在 4×4 viewport、1×1 scissor 下检查全部 256 个像素，存档恢复后再检查全部 256 个像素，均通过。
> - 122 组核心（严格 corpus，无 SKIP）、72 组客体、两项站点集成、133 场景及两种隔离页面、原生 GPU Warcraft III 冻结回放、SwiftShader 完整存档恢复全部通过；运行包 `b770378be2570b592c5e`。见 [stage3b3-validation.json](fixtures/d3d-review/stage3b3-validation.json)。设备/会话模块的本轮三项完成；接下来处理资源上传顺序和格式展开，19 项已知像素偏差尚未减少。

> **阶段 3C1（2026-11-01）：独立格式模块、BGRA 上传及窄 UNORM 修复完成。**
>
> - `d9wg_formats.js` 持有格式常量、存储格式表及纯上传/读回转换；执行器移出约 800 行格式逻辑。A8R8G8B8 直接按 BGRA 字节上传为 `bgra8unorm`，线性/sRGB 视图、渲染及读回同步支持；仅诊断预览需要转成 RGBA。
> - 565/1555/332 改为位复制查表，避免浮点缩放截断；565 的全部 65,536 个颜色通过读回打包往返，另增三个中间值的独立像素探针。Wine [格式转换源码](https://github.com/wine-mirror/wine/blob/master/dlls/wined3d/utils.c) 的 `rgb888_from_rgb565` 使用同一位复制规则。G16R16 缺失 B 修为 1，已知像素偏差从 19 项降至 18 项。
> - DirectDraw 客体的颜色键展开同步改为位复制；测试编译实际 C 函数并与实际宿主模块逐值对比全部 510 个输入，替代原测试内复制旧宿主公式。D3D8 能力检查改用真实存储/读回函数，shipping/diagnostic DDraw DLL 均重新构建。
> - 123 组核心（严格 corpus，无 SKIP）、72 组客体、两项站点集成、136 场景（118 正向、18 明示偏差）、会话/设备隔离、完整存档恢复、12/12 变异通过。运行包 `0e7abe82a5a0bb1e93a6`；见 [stage3c1-validation.json](fixtures/d3d-review/stage3c1-validation.json)。
> - **游戏图变化已解释，未记为逐字节通过：** Warcraft III 使用 144 张 565、33 张 1555 纹理；修复后 95,393 个通道字节提高 1–2（72,763 个像素）。保留旧黄金图/冻结策略。仅恢复旧窄 UNORM 算法的诊断回放通过原冻结比较，BGRA 等其余候选代码仍启用；可用 `tools/d3d_format_counterfactual.mjs` 重建此对照。没有用候选输出扩充策略。
> - 3C2 继续半浮点直接上传及采样通道映射，3C3 继续按顺序上传、删除 textureShadows 和重命名；其余模块及完整客体验收仍待办。

> **阶段 3C2（2026-11-01）：半浮点直接上传和统一采样通道映射完成。**
>
> - R16F/G16R16F 分别直接存为 `r16float`/`rg16float`，RGBA16F 也按原始半浮点字节上传；移除旧 RGBA 扩展分支。同格式读回按原始位复制，NaN/Inf/负零 payload 的上传及读回检查通过。
> - 缺失颜色通道 R111/RG11、ATI1N XXXX、ATI2N YX11 在采样表达式中统一修正，每次只求值一次纹理采样。固定管线、可编程像素和顶点纹理读取都使用相同表达式；绑定格式映射计入对应 shader variant key，支持切换回来复用正确版本。
> - 六项原已知格式偏差全部关闭：147 个场景中 135 正向通过、12 明示偏差。新增六种像素着色器采样、四种顶点纹理采样以及 R16F→G16R16F→R16F 交错切换的 READBACK 像素检查。
> - 123 组核心（严格 corpus，无 SKIP）、72 组客体、两项站点集成、147 场景及隔离页面、完整存档恢复均通过。Warcraft III 保留 3C1 已解释的窄 UNORM 图差；仅恢复旧展开规则的诊断版本通过未改动的冻结比较。运行包 `f285613f1df69e38e4d3`；见 [stage3c2-validation.json](fixtures/d3d-review/stage3c2-validation.json)。3C3 接着处理有序上传、移除 textureShadows/重命名；其余模块继续待办。

> **阶段 3C3A（2026-11-01）：普通资源有序上传完成；继续索引调色板路径。**
>
> - `d9wg_uploads.js` 以会话为 owner，分块复用 GPU 暂存缓冲和 CPU 暂存数据，录制时复制输入，重放时在相应 draw 之间编码目标复制。纹理按 256 字节行对齐；上传量达到 64 MiB 时提交一段，避免单帧暂存无界增长。结束 owner 时回收自己的分块。
> - buffer 普通锁定、DISCARD、NOOVERWRITE 都按命令顺序更新；删除 buffer/texture 重命名及普通纹理的全量 CPU shadows。渲染目标纹理也能正确在两次采样间更新：修复前左侧错误为绿，修复后左红右绿。另有普通/DISCARD 顶点更新的真实像素检查。
> - mock 观察实际 GPU staging copy 数据、行布局和每个 draw 读取的顶点快照；DirectDraw 检查也开启严格宿主/GPU 错误断言。新增数据寿命、行对齐、分块溢出/复用/增长/回收测试。四种 uniform/上传与会话/设备组合共检查 32,768 个像素。
> - 124 组核心（严格 corpus，无 SKIP）、72 组客体、两项站点集成、150 场景（138 正向、12 偏差）、完整存档恢复、SVGA 工作线程和 12/12 变异通过。运行包 `e973b79d51ab0c893696`；见 [stage3c3a-validation.json](fixtures/d3d-review/stage3c3a-validation.json)。
> - **游戏变化仍单独登记：** 恢复旧窄 UNORM 后，Warcraft III 另有 146 字节、49 个稳定像素超出旧策略；仅恢复旧 buffer 更新仍失败，恢复固定 `0f5641e7` 的全部 buffer/texture 上传函数后通过原冻结比较。`tools/d3d_format_counterfactual.mjs ... --legacy-uploads` 可重建对照。由此定位到上传语义变化；这些游戏像素的完整原生正确性仍待客体 visual 验收，没有修改黄金图或策略，也没有将候选记为无差异通过。
> - 3C3B 继续替换 DirectDraw 索引采样的 CPU shadow 和即时 palette 写入；这是 `textureShadows` 的最后一条路径，尚未关闭资源模块。

> **阶段 3C3B（2026-11-01）：索引采样与 palette 有序更新完成；继续资源 handler 拆分。**
>
> - 删除最后的 `textureShadows` 及相关方法。P8 D3D 采样伴随图由 GPU 索引纹理和表面 palette 解析，所有 GPU 写入都会使其失效；按顺序更新同一伴随图，保留 view 身份以复用绑定组。按原始 index 判透明，重复 RGB 不会误透明，keyed texel 保留 RGB、仅 alpha 变零。
> - palette buffer 也通过有序 staging copy 更新。Present 才发现的 overlay palette 直接编码到该 encoder；上传环只写新追加范围。绑定解析期间不触发中途提交，避免丢失已经分配常量的 draw。
> - 两项新复现已修复：GPU fill 后采样旧索引、两次 blit 间 palette 更新覆盖第一次。153 场景中 141 正向、12 明示偏差；同套件强制 1 字节上传预算、频繁提交也通过。新增实际 GPU 的 8,192 个最终显示像素检查，覆盖仅 palette+Present 的帧；此处观察最终 scanout，客体 READBACK 仍只读 primary。
> - 124 组核心（严格 corpus，无 SKIP）、72 组客体、两项站点集成、完整存档恢复、12/12 变异通过；Naga 增测 keyed-alpha 的有/无 palette 两变体。存档检查改为核验重建的实际 GPU index copy，不再依赖已删除的 CPU shadow。固定旧上传函数的 Warcraft III 对照通过未改动的冻结策略，候选图仍保留 3C1/3C3A 已登记差异。
> - 运行包 `add5b110de1479123c37`；见 [stage3c3b-validation.json](fixtures/d3d-review/stage3c3b-validation.json)。资源上传的功能改造完成；3C4 接着把资源 handlers 移出执行器，随后推进 surface-ops 等模块。

> **阶段 3C4（2026-11-01）：资源 handlers 拆分完成；继续 surface-ops。**
>
> - `d9wg_resources.js` 接管 34 个资源创建/更新/回收、palette、shader/声明创建、mip 与 view 方法，移出主执行器约 1,000 行。依赖在安装时显式注入，owner 可变状态仍由当前设备/会话持有；方法直接安装到原型，不增加 draw 包装或每 draw 对象。
> - 与提交 `dc1bbcf7` 对比，34 个函数的语法树完全相同；安装时保留 class 方法不可枚举、可写、可配置的属性。对比记录见 [resource-extraction.json](fixtures/d3d-review/resource-extraction.json)。发布构建和直接加载页面均加入模块，旧宿主冻结回放仍使用自身文件。
> - 124 组核心（严格 corpus，无 SKIP）、72 组客体、两项站点集成、153 场景及强制小预算配置、overlay/隔离页面和完整存档恢复通过；保留已登记游戏图变化，固定旧上传路径的诊断回放通过未改动的冻结策略。
> - 运行包 `785d758106b345d40b29`；见 [stage3c4-validation.json](fixtures/d3d-review/stage3c4-validation.json)。资源拆分的本轮工作完成，接下来统一 surface utility passes 和 uniform 分配；12 项像素偏差及 draw CPU 目标尚待后续模块。

> **阶段 3D1（2026-11-02）：统一 surface utility passes 和 uniform 分配。**
>
> - `d9wg_surface_ops.js` 接管 13 个主执行器方法、3 个 DirectDraw GPU 方法和 4 个纯辅助函数，覆盖 blit、矩形 clear/ColorFill、gamma、光标、mip、unresolve 和 overlay 重放。blit、fill、光标与 DDraw 常量共用会话 uniform ring；128 个混合 utility pass 使用一个 GPU 缓冲，后续帧不再分配缓冲。
> - 强制耗尽测试发现并修复重放期间临时 uniform 意外创建下一帧、重置当前游标的问题。临时缓冲由当前重放帧持有并在 GPU fence 后回收；256 字节单块配置中 127 个临时缓冲独立且正确回收。
> - 125 组核心（严格 corpus，无 SKIP）、72 组客体、两项站点集成、153 场景的普通/小上传预算/强制 uniform 耗尽配置、最终 overlay、四种隔离、完整存档恢复和 12/12 变异通过。Warcraft III 的固定旧上传诊断通过原冻结策略，候选既有差异保持登记。
> - 运行包 `cea10466db157bfc0ed8`；见 [stage3d1-validation.json](fixtures/d3d-review/stage3d1-validation.json)。3D2 接着迁移 DDraw GPU 缓存并修正原生格式 fill；12 项像素偏差及 draw CPU 目标尚未关闭。

> **阶段 3D2（2026-11-02）：DDraw GPU 缓存归入资源模块，原生填充语义修复。**
>
> - palette GPU buffer 和 indexed sample view 两方法移至 `d9wg_resources.js`（共 36 方法）；`ddraw_ops.js` 保留客体语义转换和公共操作录制，不再构造 GPU 资源或管线。surface-ops 本轮拆分完成。
> - 修正 S2-44：`DDBlt.fill_color` 按目标原生像素解码，共用上传的通道默认值和位复制；新增 565 中间值、1555、4444、24 位和反向通道用例。D3D9 `ColorFill` 继续按 D3DCOLOR 输入，并为无 alpha 的目标写不透明 alpha。
> - 160 个 GPU 场景中 150 个正向通过、10 个明确偏差；普通、小上传预算、uniform 耗尽配置全部通过。125 组核心、72 组客体、两项站点集成、overlay/隔离、完整存档恢复和 12/12 变异通过。固定旧上传的 Warcraft III 诊断继续通过原冻结策略，既有候选差异未改为新黄金图。
> - 运行包 `6a92839acfa896bc8bdc`；见 [stage3d2-validation.json](fixtures/d3d-review/stage3d2-validation.json)。接下来推进 FFP 纯生成器和签名缓存；通用绘制中的窄格式写入语义仍需对应验收，单个 draw 的 3 µs 目标尚未实测。

> **阶段 3E1（2026-11-02）：FFP 纯生成器和签名缓存完成。**
>
> - `d9wg_ffp.js` 接管纯 WGSL、uniform layout 和固定输入语义辅助函数；14 个函数与 `5458632c` 语法树相同，保留字符串及模板字面量内容。见 [ffp-extraction.json](fixtures/d3d-review/ffp-extraction.json)。
> - 先按完整的状态签名查 GPU module，再在未命中时生成 WGSL，避免每 draw 重新拼全文；签名包含裁剪平面及完整声明信息，清缓存/设备退出同时失效。新增测试实际拦截生成器调用，公共命令的后续绘制不再调用生成器。
> - 新增 `tools/d3d_draw_benchmark.mjs`：2,000 draw × 30 轮，另 10 轮预热，计入 wire 解码、两次状态写入和记录，排除重放/驱动/GPU。本机中位数缓存约 8.0 µs、逐 draw 生成约 14.1 µs；**尚未达到 3 µs**，不是游戏帧率测量。
> - 126 组核心、160 场景的三种配置、overlay/隔离、完整恢复、12/12 变异和站点两项集成通过，旧上传 Warcraft III 对照仍通过原冻结策略。客体源码未改，72 组客体结果沿用 3D2。
> - 运行包 `6b5e2b385c039a89dae2`；见 [stage3e1-validation.json](fixtures/d3d-review/stage3e1-validation.json)。3E2 接着修复剩余 FFP 语义；10 项已知像素偏差仍明确待办。

> **阶段 3E2（2026-11-02）：已有 10 项 FFP 像素偏差全部修复。**
>
> - 无纹理的操作改选 CURRENT，采样/颜色键/签名只读实际使用的参数；DOT3 同时写 alpha。alpha test 量化到 UNORM8 后比较；XYZRHW 重建 clip W，保留透视插值。预变换顶点雾取 specular alpha；table fog 通过 uniform 按投影第四列选择 Z/W。缺失材质颜色源回退材质，默认材质改为全零；uniform layout 保留 bump 来源元数据。
> - 移除全部 10 条已知失败登记，新增 RHW、透视 W 雾、未使用纹理颜色键、默认材质四项：**164/164 正向通过、0 已知偏差**。三种预算配置、126 组核心（严格 corpus）、overlay/隔离、完整恢复、12/12 变异和站点两项集成通过。删除已被像素测试取代的旧 alpha 小数字面量/W 固定来源断言。
> - Warcraft III 在旧 UNORM/上传对照下新增 654 字节、282 像素差异，零宿主/GPU 错误。工具新增 `--legacy-ffp`，固定 `46a46b4e` 的生成器、签名和 uniform writer 后通过**原有**冻结策略，定位到本阶段 FFP 语义组；尚不能据此声称每个变化像素已通过 Windows 原生对照。黄金图和策略未更新。
> - 运行包 `b1ff7db2ef58bbd8fe9c`；见 [stage3e2-validation.json](fixtures/d3d-review/stage3e2-validation.json)。3E3 继续 S2-19 的输入维度变换及 S2-4 的 ps<3 雾；0 已知偏差仅描述当前已建立的像素套件，不代表整个审查完成。

> **阶段 3E3（2026-11-02）：FFP 本轮语义和模块工作完成。**
>
> - S2-19：签名携带纹理坐标输入维度，分别补成 `(u,1,0,0)` / `(u,v,1,0)` / `(u,v,w,1)`；COUNT 只控制输出。相机生成坐标保留 Z，预变换顶点绕过纹理矩阵。修正 uniform writer 对省略矩阵字段仍写入的越界路径。
> - S2-4：ps 1.x/2.x 的后置雾与 FFP 共用纯 WGSL 生成和 uniform writer，支持 vertex/specular/oFog、仿射 Z 与透视 W；ps 3.0 不执行 legacy 后置雾。参数附在 shader 寄存器块之后，反射明确记录偏移；无效着色器仍按原失败契约跳过绘制。
> - 新增 16 个实际像素场景，**180/180 正向通过，0 已知偏差**；三种预算配置、126 组核心、190 个 Naga 着色器、overlay/隔离、完整恢复、12/12 变异和站点两项集成通过。
> - Warcraft III 的旧 UNORM/上传对照现有 636 字节、275 像素差异，零宿主/GPU 错误；加固定旧 FFP 后继续通过未改动的原冻结策略。这里保留 FFP 语义组变化，未将候选图训练为新黄金图，逐像素原生正确性仍需 L4/L5 验收。
> - 运行包 `3ff511520f2d880e9f70`；见 [stage3e3-validation.json](fixtures/d3d-review/stage3e3-validation.json)。继续 pipeline-state、记录/重放、呈现及诊断；draw CPU <3 µs 目标和客体阶段均尚未关闭。

> **阶段 3F1（2026-11-02）：pipeline-state 拆分及 blend/stencil 动态值完成。**
>
> - `d9wg_pipeline_state.js` 接管管线状态、sampler 和 render pipeline 三方法，显式安装不可变依赖。与 `d31dcfe6` 对比，函数体除管线 key 选择外语法树相同；见 [pipeline-state-extraction.json](fixtures/d3d-review/pipeline-state-extraction.json)。
> - blend constant、stencil reference 移出不可变管线 key；绘制记录保留自身动态值，通过 `setBlendConstant` / `setStencilReference` 重放。alpha test 继续由 shader key 表示，不在管线状态中重复编码。128 次 blend/stencil 值变化不新建管线；新增实际像素检查分别保留两次 blend 以及 stencil 写入/相等测试的结果。
> - **182/182 正向场景**及三种预算配置、127 组核心、overlay/隔离、完整恢复、12/12 变异和站点两项集成通过；固定旧 UNORM/上传/FFP 的 Warcraft III 诊断通过原冻结策略。模块格式整理后再次核验语法树、预算测试和变异锚点。
> - 运行包 `52bcf2c6e309bca7e8ab`；见 [stage3f1-validation.json](fixtures/d3d-review/stage3f1-validation.json)。3F2 继续 ALPHAREF uniform，随后 LOD bias 和 clip 开关；draw CPU 目标保持待办。

> **阶段 3F2（2026-11-02）：ALPHAREF uniform 完成。**
>
> - FFP 与 ps 1/2/3 的参考值均由 uint uniform 提供，签名只保留比较函数，移除 ALPHAREF 数值。翻译着色器在现有寄存器/fog 字段后附加参考值，反射明确偏移；每 draw 从当前设备状态写入，保留 UNORM8 量化比较。
> - 新增 96 个矩阵场景：四条路径 × 八种比较 × 相邻 alpha 值，每场景遍历全部 256 个参考值，合计 **24,576 个精确像素比较/配置**。四条路径的缓存测试均证明预热后改变参考值不生成 module 或 pipeline。
> - **278/278 正向场景**及三种预算配置、128 组核心（严格 corpus）、overlay/隔离、完整恢复、12/12 变异和站点两项集成通过。固定旧 UNORM/上传/FFP 的 Warcraft III 对照继续通过原冻结策略；既有候选语义变化不改黄金图。
> - 运行包 `738a0ae664a53d644c86`；见 [stage3f2-validation.json](fixtures/d3d-review/stage3f2-validation.json)。继续 LOD bias、clip 开关 uniform 和后续模块；单 draw CPU 目标尚未关闭。

> **阶段 3F3（2026-11-02）：LOD bias uniform 完成。**
>
> - FFP 和 SM1/2/3 的普通隐式像素采样从紧凑 bias 向量读取浮点值；数值移出 shader key，删除为限制变体而引入的 1/16 软件量化。反射记录 uniform 区域；FFP/可编程路径共用 writer。独立翻译接口仍支持原先的 literal 选项，显式 LOD/gradient/非一致控制流的既有行为留待阶段 5 差分测试。
> - 四条路径各改变 256 个浮点值，预热后零新增 module/pipeline；新增 8 个 GPU 场景检查负偏移、正偏移、恢复以及相邻 mip。Metal 与 SwiftShader 在 0.49/0.51 的选择边界附近存在精度差异，因此像素用例使用有余量的 0.25/0.75；另直接核验上传的 0.49 float32，确保宿主不量化。
> - **286/286 场景同时通过 SwiftShader 和本机 Metal**；三种预算配置、129 组核心（严格 corpus，夹具调整后重跑相关 173 项）、overlay/隔离、完整恢复、12/12 变异和站点两项集成通过。删除被像素/缓存验证取代的旧 bias 字面量和变体数断言。固定旧语义的 Warcraft III 对照继续通过原冻结策略。
> - 运行包 `dff918e7597ce77ad91b`；见 [stage3f3-validation.json](fixtures/d3d-review/stage3f3-validation.json)。继续 clip 开关 uniform，随后记录/重放等模块；CPU 目标仍待后续优化。

> **阶段 3F4（2026-11-02）：clip 开关 uniform 完成，pipeline-state 本轮工作关闭。**
>
> - 设备第一次使用用户裁剪时取得固定六槽 shader layout；之后包括关闭全部裁剪在内的所有 mask 变化，仅更新 active/neutral 平面系数 uniform。设备始终未使用裁剪时维持原紧凑布局；预热容量归设备并随默认状态重置。
> - 新增 30 个实际像素场景：六平面 × FFP/ps1/ps2/ps3/VS2+PS2 五条路径，逐一遍历 64 个开关组合，合计 **1,920 个精确像素比较/配置**。缓存验证确认首次裁剪预热后，所有 mask 均不新增 module 或 pipeline。
> - **316/316 场景通过 SwiftShader 与 Metal**；三种预算配置、130 组核心（严格 corpus）、overlay/隔离、完整恢复、12/12 变异和站点两项集成通过。固定旧语义 Warcraft III 对照保持原冻结策略通过，未更新黄金图。
> - 运行包 `fa5b6b738c3dea7ec1a8`；见 [stage3f4-validation.json](fixtures/d3d-review/stage3f4-validation.json)。继续 draw-recorder / frame-replayer、呈现和 debug 诊断拆分，并继续实测/优化 CPU；整个阶段 3 及后续客体阶段尚未完成。

> **阶段 3G1（2026-11-02）：draw-recorder / frame-replayer 拆分。**
>
> - `d9wg_draw_recorder.js` 接管 4 个帧/绘制录制方法，直接安装原型，不增加每 draw 转发层；`d9wg_frame_replayer.js` 提供每执行器一个 `FrameReplayer`，接管 finish/replay 的 GPU 编码、校验和提交，owner 状态仍由执行器持有。主文件移出约 900 行。
> - 4 个录制函数语法树原样保持；2 个重放函数仅把原 lexical this 转为显式 executor 引用，移除该引用声明后语法树等同，且无嵌套动态 this。方法描述符保持原语义；见 [record-replay-extraction.json](fixtures/d3d-review/record-replay-extraction.json)。
> - **316/316 场景通过 SwiftShader/Metal**，三种预算配置、130 组核心、overlay/隔离、完整恢复、12/12 变异和站点两项集成通过；固定旧语义的 Warcraft III 对照满足原冻结策略。模板内容和渲染逻辑保持不变。
> - 运行包 `8f5752f3a81661c9cf26`；见 [stage3g1-validation.json](fixtures/d3d-review/stage3g1-validation.json)。3G2 继续把提交前的帧统计扫描改为录制期摘要，随后继续 CPU 优化、present 和 diagnostics；未关闭整个审查。

> **阶段 3G2（2026-11-02）：帧摘要改在录制期维护。**
>
> - `RecordedFrame.record()` 统一 17 处操作追加，维护 colour-clear 和 occlusion 标记，移除 finish/replay 的两次列表扫描。绘制计数仍在录制入口完成，实际 GPU pass/submit 指标保留重放时统计；有序 GPU 编码本身的遍历保持。
> - **316/316 场景通过 SwiftShader/Metal**，三种预算配置、130 组核心、overlay/隔离、完整恢复、12/12 变异和两项站点集成通过。M6 稳态预算保持 150 draw、零新增 pipeline/bind-group/buffer、一个 pass 和一次 submit；固定旧语义 Warcraft III 对照满足原冻结策略。
> - CPU 采样指出重复静态管线 key、程序签名和 uniform layout 构造仍占主要成本，尚未达到单 draw 3 µs。后续模块完成后继续针对这些热路径优化，不用推测代替测量。
> - 运行包 `7274a57750560ad63982`；见 [stage3g2-validation.json](fixtures/d3d-review/stage3g2-validation.json)。录制/重放本轮结构和计数工作完成；继续 present、debug diagnostics 及阶段 3 的最终性能验证。

> **阶段 3H1（2026-11-02）：统一呈现模块完成迁移。**
>
> - `d9wg_present.js` 接管 retained back buffer / MSAA 配置、交换链 surface、窗口位置、gamma/cursor 命令和最终 scanout；GPU utility pipelines 仍在 surface-ops。设备/会话所有权保持，重放器在原 pass 边界调用呈现方法。
> - 22 个方法语法树原样保持；主/附加呈现的两段逻辑仅降低 owner 引用及 helper 控制流，附加呈现的 closePass 和终止 continue 保留在调用者。见 [present-extraction.json](fixtures/d3d-review/present-extraction.json)。
> - **316/316 场景通过 SwiftShader/Metal**；三种预算配置、130 组核心、overlay/隔离、完整恢复、12/12 变异和两项站点集成通过。固定旧语义 Warcraft III 对照满足未改动的原冻结策略。
> - 运行包 `426ba2aeabb3f85b3c2f`；见 [stage3h1-validation.json](fixtures/d3d-review/stage3h1-validation.json)。3H2 接着处理交换链销毁/替换之前的排队呈现和无设备空呈现，再继续 diagnostics 与 CPU 性能验证。

> **阶段 3H2（2026-11-02）：交换链排队呈现生命周期修复，present 本轮完成。**
>
> - 销毁或替换交换链句柄前，先提交已接受的该链呈现，再关闭 context；替换也会关闭旧 context。会话退出仍按原策略丢弃未提交帧。无设备的空 Present 不再把画布改成 0×0，也不获取无 owner 的图像。
> - 修复前，两项严格 context 生命周期测试失败，真实 GPU 的最后图像丢失；修复后，新增 **192 个 scanout 像素及原生画布 context 退休检查**在 SwiftShader/Metal 均通过，执行器 175 项通过。
> - 130 组严格核心、316/316 一致性场景（两种 GPU，三种预算）、overlay/隔离、完整恢复、12/12 变异、两项站点集成及原冻结 Warcraft III 旧语义对照通过。
> - 运行包 `26ad13c413cf4e98789a`；见 [stage3h2-validation.json](fixtures/d3d-review/stage3h2-validation.json)。继续仅 debug 加载的 diagnostics，随后完成阶段 3 的 CPU 优化；客体、着色器差分与游戏验收仍待后续阶段。

> **阶段 3I（2026-11-02）：diagnostics 按需加载完成。**
>
> - 六个报告方法语法树原样迁入独立 `d9wg_diagnostics.js`，纹理预览和 pipeline/draw 快照也只在显式启用后采集；默认会话不保留最后绘制引用。轻量错误与计数、直接调试开关仍可用。见 [diagnostics-extraction.json](fixtures/d3d-review/diagnostics-extraction.json)。
> - `enableDiagnostics()` 或首次 debug 报告按需加载，后续调用保持同步报告 API；浏览器并发请求共用一次加载，失败可重试。独立文件由 manifest 同步，URL 使用同一运行包 revision。
> - 真实浏览器验证默认无模块/快照，开启后正确捕获状态，**4096 个 GPU 像素完全相同**；SwiftShader/Metal 通过。131 组严格核心、316/316 一致性场景（三种预算）、overlay/隔离/交换链、恢复、12/12 变异、两项站点集成和冻结 Warcraft III 旧语义对照通过。
> - 运行包 `081f4cdbe432d69ff6b7`；见 [stage3i-validation.json](fixtures/d3d-review/stage3i-validation.json)。九个结构模块的本轮拆分已完成，接着优化程序、管线 key 和 uniform 热路径；CPU 目标和后续阶段尚未关闭。


> **阶段 3J1（2026-11-02）：程序及活跃 uniform 复用。**
>
> - 序列化 wire draw 复用程序、反射与 uniform layout；pipeline/uniform-only 状态不重建程序，其他命令保守失效。覆盖 UP stride/frequency、点展开、alpha 模式、直接 debug 修改、清缓存及异步编译失败；直接调用构建器保留不缓存契约。
> - uniform 单独跟踪有效输入，cull/stencil reference/blend factor 及未使用的 texture factor 不再重复打包；被消费的值仍更新。缓存命中按 draw 累加语义计数，编译计数保持创建事件。
> - 同一公开 wire 基准由 **9.14 降到 3.36 µs/draw（中位数）**，不含 replay/GPU；80150 次 draw 仅构建两个程序。**3 µs 目标尚未关闭**，继续管线 key 热路径。
> - 132 组严格核心、316/316 场景（SwiftShader/Metal、三种预算）、全部呈现/隔离页、恢复、12/12 变异、两项站点集成、原冻结 Warcraft III 旧语义对照通过。运行包 `e3dd8f5fbf98ded721f9`；见 [stage3j1-validation.json](fixtures/d3d-review/stage3j1-validation.json)。

> **阶段 3J2（2026-11-02）：管线签名热路径完成，阶段 3 本轮关闭。**
>
> - 程序/绑定布局的大签名仅序列化一次；每次 draw 使用明确的规范化静态状态元组和程序内短 key。每次命中仍检查全局管线表，删除、清空和验证拒绝不会被二级缓存绕过；blend/stencil/alpha 动态值仍不进入静态 key。
> - 公开 wire 基准在本机 Apple M1 Pro / Node v25.6.0 为 **1.91 µs/draw 中位数、2.78 µs P90**，低于 3 µs 目标（此前 9.14）。范围是 wire 解码、两次状态写入及 FFP draw 录制，不含 replay/驱动/GPU，也不是所有游戏 draw 的时延上限。
> - 九个结构模块、本轮已知像素修复及所选 CPU 基准目标均完成。132 组严格核心、316/316 场景（SwiftShader/Metal、三种预算）、全部呈现/隔离页、恢复、12/12 变异、两项站点集成、原冻结 Warcraft III 旧语义对照通过。
> - 运行包 `9341833c88a4a8e6a411`；见 [stage3j2-validation.json](fixtures/d3d-review/stage3j2-validation.json)。接着阶段 4 的客体共用核心；仍不宣称 Wine API、D3D8 包装、着色器差分或真实游戏验收完成。

- **目标：** 结构清楚，单个 draw 的 JS 开销降到 3 µs 以下，消除 S2-15 这一类错误。
- **改动（按模块拆分 `d3d9_executor.js`）：**
  1. `wire/`：解码，由阶段 2 生成。
  2. `session/device`：显式的状态对象。back buffer 和 uniform ring 游标归设备或会话所有。只有 CREATE_DEVICE 能创建设备。
  3. `resources`：
     - 上传按帧内顺序记录（staging ring + copy op），删除 `textureShadows` 和重命名；
     - A8R8G8B8 直接上传为 `bgra8unorm`，16 位浮点直接上传；
     - 格式展开改为查表，修正位复制和缺失通道。
  4. `surface-ops`：一个通用 utility-pass 模块统一 blit、clear、ColorFill、gamma、光标和 DDraw blit，使用 uniform ring；`ddraw_ops.js` 只保留语义翻译。
  5. `ffp`：纯函数生成器。输入规范化的签名，输出 WGSL。程序按签名 key 缓存，缓存未命中才生成。与此同时修正 §3.2 中的固定管线语义问题（S2-2 到 S2-6、S2-19、S2-20）。
  6. `pipeline-state`：动态状态移出管线 key（`setStencilReference`、`setBlendConstant`）；ALPHAREF、LOD bias、裁剪面开关改为 uniform。
  7. `draw-recorder` 与 `frame-replayer`：把 `finishFrame` 拆成一个类，计数在录制时完成。
  8. `present`：呈现与交换链（MSAA resolve 已在阶段 0 完成，这里只整理归属）。
  9. `diagnostics`：只在 debug 下加载。
- **风险：** 改动最大，最容易让游戏退步。
- **缓解：**
  - 阶段 1 的一致性套件加轨迹黄金图像，作为每个 PR 的门槛；
  - 按模块逐个替换，不做一次性大重写。
- **验证：**
  - 一致性套件和轨迹重放零差异，或差异都可解释并已记录；
  - 用绘制路径审查员的基准测单个 draw 的开销。

### 阶段 4：客体共用核心（约 4–6 周，可以与阶段 3 并行）

> **阶段 4A1（2026-11-02）：共用纯 C runtime 起步，缓冲分带完成。**
>
> - D3D9、D3D8、DDraw 的构建均链接私有 `libd9wg_runtime.a`；统一 1 秒重试（包含 GetTickCount 回绕）及有边界检查的 buffer span 上传。传输锁覆盖整次逻辑上传，DISCARD 只出现在首段，失败停止且不重试已录制前缀。
> - D3D7 VB Unlock/ProcessVertices 同样走此路径。修复前固定旧实现拒绝 17 MiB；修复后实际 C emitter 在三条路径分别完整重建 **17,825,805 字节、两批、一次 DISCARD**，并覆盖 framing、溢出、空指针、开启失败及第二段失败。
> - 73 组客体测试、两项站点集成通过；35 个 XP 冒烟 EXE、六个零售/诊断 DLL 严格交叉编译通过，只导入 GDI32/KERNEL32/USER32，无 CRT。已更新 app-local DLL，未改写系统或游戏磁盘。
> - 见 [stage4a1-validation.json](fixtures/d3d-review/stage4a1-validation.json)；宿主运行包仍为 `9341833c88a4a8e6a411`。**不是阶段 4 完成**：D3D8 大纹理、进程唯一 owner、驱动多 owner、其余共用核心及 XP/Wine/游戏验收仍待继续。


> **阶段 4A2（2026-11-02）：共用纹理分带及上传编码完成。**
>
> - `d9wg_upload_bridge.h` 统一三前端的 UPDATE_BUFFER / UPDATE_TEXTURE 编码，runtime 统一有边界检查的整块行迭代。D3D8 大纹理、D3D9 cube/volume、DDraw surface 全部接入；D3D9 原 2D 路径也复用同一实现。
> - 实际 C emitter 对照：旧 D3D8 拒绝 2048² / 16 MiB，新三条路径两批完整提交；验证带 padding 行距、非零 mip/face、压缩纹理边缘与部分区域的逻辑尺寸。实际 cube wrapper 和两条 volume wrapper 也被执行，整次 volume 上传持锁。
> - 74 组客体测试、两项站点集成通过；35 个 XP 冒烟 EXE 和六个零售/诊断 DLL 严格构建通过，无 CRT 导入。前一阶段的 buffer/discard/失败边界检查继续通过。源码模式断言中对应上传部分已由实际 C 行为测试取代。
> - 见 [stage4a2-validation.json](fixtures/d3d-review/stage4a2-validation.json)。继续进程唯一 owner、驱动多 owner 和其余共用核心；这些是原生 C 与构建验收，尚不等同于 XP/Wine/游戏完成。

> **阶段 4B1（2026-11-02）：同进程 DirectX 唯一 owner 状态完成。**
>
> - 三前端共享进程内 canonical metadata：DMA/file、传输/读回锁、批处理游标、session、resource/shader handle、query slot 及请求号。创建该视图的 DLL 卸载后，视图保留到最后一个前端退出；不持有前端函数指针。
> - DLL 通知按 Windows loader 的进程级串行化初始化，无新增等待；进程终止不再进入可能由已结束线程持有的锁，由 OS 关闭驱动 handle。DDraw 提交失败也保留共用映射，丢弃不确定批次且不重放。
> - 实际三个 C DLL 入口验证 canonical 生命周期、批处理/句柄/session 共享、失败加载和终止路径。**真实 XP 通过两种创建者卸载顺序**：D3D9 或 DirectDraw 先卸载，余下前端继续使用原映射；最后卸载才关闭，4 批、恰好 2 次 owner 释放，91 秒。磁盘只读、写入仅 RAM。
> - 75 组客体测试、35 个 XP 冒烟程序及专用 owner EXE、六个零售/诊断 DLL 构建通过，无 CRT。见 [stage4b1-validation.json](fixtures/d3d-review/stage4b1-validation.json)；可复跑 `tests/glbridge/d3d_process_owner_xp.mjs`，它先构建当前源码。
> - 继续共用 framing/transport 实现、驱动多进程 owner 和混合 OpenGL 所有权；**本次 XP 检查不涉及绘制**，Wine API/图像与游戏验收尚未关闭。

> **阶段 4B2（2026-11-02）：Windows transport 与封包实现归入共用库。**
>
> - `d9wg_transport.c` 统一映射/开启/关闭、响应尾区、批次重置、VGL2/D9WG 封包、提交、命令预留与 generation。前端 wrapper 只保留各 API 的丢批返回方式及诊断；驱动缺失、映射忙和失败批次上下文继续保留。
> - 固定 `4f067af` 的三个原 C 实现作为冻结 oracle，**每条路径 28 批、共 84 批逐字节相同**。fixture 入库并固定 SHA，无需 CI 获取旧 Git 对象。另验证溢出/对齐、失败 flush、响应区隔离、错误阶段及不确定接受后不重复执行。
> - 76 组客体、两项站点集成、35 个 XP 冒烟 EXE 与六个零售/诊断 DLL 构建通过，无 CRT。**当前共用库在真实 XP 再次通过两种卸载顺序**，95 秒、4 批、2 次 owner 释放；仍只验证 loader/driver 所有权，不宣称绘制通过。
> - 见 [stage4b2-validation.json](fixtures/d3d-review/stage4b2-validation.json)。继续宿主 owner 作用域及存档、多个 D3D arena 和驱动多 owner，再推进余下共用核心与 API 验收。

> **阶段 4C1（2026-11-02）：宿主 owner 命名空间及检查点完成。**
>
> - 稳定 transport owner token 纳入 D3D 会话及附加 swap-chain 标识；不同进程即使使用相同 session/device/resource 句柄也互不覆盖。退出只回收指定 owner，保留另一进程尚未 Present 的帧；legacy owner 0 保留原路径。
> - owner 回收排入 executor 的批次链，修复本地模式中已接受批次在回收后重新创建资源的竞态。旧无作用域回收记录继续表示全部 owner。
> - VGS2 journal 写入 v4 并保存 owner，继续读取 v1–v3；冷恢复验证同名资源、SESSION_END 作用域、GL 与两个 D3D owner 的独立生命周期。GL resource checkpoint 的外层 v4 格式不变。
> - 两个新增用例在 SwiftShader 与本机 Metal 各通过 16,384 个像素，覆盖 uniform 和上传暂存；132 组宿主测试、316 场景及预算变体、完整存档页、12/12 变异、两项站点集成通过。Warcraft 冻结旧语义对照通过，仍不代表当前全部游戏语义验收。
> - 运行包 `cca565279ff8d9998d67`；见 [stage4c1-validation.json](fixtures/d3d-review/stage4c1-validation.json)。此阶段是宿主准备，继续设备多 arena 与 XP 驱动，尚未宣称客体多进程通过。

> **阶段 4C2（2026-11-02）：virtio 设备多个 DirectX arena 完成。**
>
> - 新协商位 1 启用非零 owner token，owner 0 保留原 OpenGL 请求；独立 16 MiB 物理 arena 拒绝重叠，正 owner 仅接收 D9WG 封包。相同 owner/range 重注册幂等。
> - stable owner 和物理 write generation 分开；一个进程退出不能撤销另一个进程的回读，D3D 提交也不撤销 GL 的当前 inline 回答。队列超时重置只撤销物理映射，退出时即使未重新注册也能回收逻辑 owner。
> - 设备存档 v4 保存多个 arena 和逻辑 owner，恢复时更新写租约；继续读取 v2/v3，错误/重叠存档不替换现有映射。真实 PCI/virtqueue/物理内存测试覆盖上述路径。
> - 133 组宿主测试、26 项浏览器检查点检查及两项站点集成通过；运行包 `de4f6973b6863625750c`。见 [stage4c2-validation.json](fixtures/d3d-review/stage4c2-validation.json)。继续 XP 驱动接入与真实多进程验收。

> **阶段 4C3（2026-11-02）：XP 驱动多进程 arena 与 runtime 协商完成。**
>
> - 驱动为各进程维护 DirectX arena，多个 file object 共享引用；旧 OpenGL 使用独立 owner 0。共用 runtime 先请求新增 MAP_D3D_BUFFER，仅在不支持时退回旧 IOCTL，busy/OOM 不会静默回退。
> - CLEANUP 释放映射引用，CLOSE 幂等清理；进程退出通知在地址空间删除前撤销映射，跨进程复制句柄的最后清理只在原进程仍存活时附着并解除映射。内核映射的 SEH 边界使用 ntoskrnl 的 XP handler，不引入 CRT；注入真实分配异常后，下一次映射继续成功。
> - **真实 XP：** 两个各持有 D3D9/D3D8/DDraw 的进程与旧 GL arena 同时提交；把 A 的设备句柄复制到 B，再终止 A。A 在 B 关闭残留句柄前即被回收，B 与旧 GL 继续提交；B 还关闭来自父进程的最后 GL 句柄。正常 114 秒、异常注入含启动重试 299 秒，各 7 批、3 次独立回收。当前 DLL 对旧驱动两种卸载顺序也通过，131 秒、4 批、2 次回收；磁盘写入只在 RAM overlay。
> - 77 组客体测试、35 个冒烟 EXE、六个零售/诊断 DLL 与 XP SYS 严格构建、两项站点集成通过。SYS 只导入 HAL/ntoskrnl；实际 C harness 覆盖分配失败回滚、引用、退出及外国进程清理。详见 [stage4c3-validation.json](fixtures/d3d-review/stage4c3-validation.json)。该 XP 验收不涉及绘制，完整 Wine/API/图像及游戏验收继续保留。
> - 继续共用 FVF、软件 T&L、状态默认表、窗口/格式/caps，以及 D3D8 包装 D3D9 等余项。

> **阶段 4D1（2026-11-02）：三个 API 共用纯 C FVF 展开完成。**
>
> - `d9wg_fvf.c` 统一元素、偏移、步长和 D3D7 软件顶点布局；前端只传 API 模式和容量。D3D7 reserved DWORD、D3D8/9 position mask、XYZW、LASTBETA 的既有区别明确保留；D3D8/9 不请求 layout 时不构建中间布局。
> - 冻结 `2ea4c38` 三个原 C decoder，固定 fixture SHA，无 Git 历史依赖。对所有低 16 位配四组纹理维数、所有高 16 位配三组布局及每 API 十万个确定性随机 token，**1,676,256 次实际 C 前端对照全部相同**，包括拒绝结果、元素字节及 D3D7 布局；另验证容量边界和空指针。
> - 78 组客体、两项站点集成、35 个冒烟 EXE 与六个 DLL 严格构建通过，无 CRT。见 [stage4d1-validation.json](fixtures/d3d-review/stage4d1-validation.json)。这次保持原 API 行为，不把冻结结果当作 Windows/Wine 零售语义的证明；继续软件 T&L 及余下核心。

> **阶段 4D2a（2026-11-02）：D3D8/9 共用设备创建 x87 设置完成。**
>
> - 与 [D3DCREATE 文档](https://learn.microsoft.com/en-us/windows/win32/direct3d9/d3dcreate) 和固定 Wine `66caeb46` 的 `test_fpu_setup` 对齐：默认创建屏蔽异常，设置 24 位、就近舍入；FPU_PRESERVE 保留当前线程控制字。实现归入 `d9wg_fpu.c`，只在接受的设备初始化时调用，后续方法不重新设置。
> - **真实 XP COM 验证 D3D8 与 D3D9 均通过**：`0x0f60→0x007f`、preserve、调用者后续修改、Release、无效 adapter，以及独立窗口线程中的创建不改变等待线程的控制字。107 秒、8 批、2 个 owner；不涉及 GPU 绘制。新工具 `d3d_fpu_xp.mjs` 使用通用 RAM probe helper，镜像写入仅 RAM overlay。
> - 全部 65,536 个控制字的纯逻辑、79 组客体、两项站点集成、35 个冒烟 EXE 和六个 DLL 严格构建通过。见 [stage4d2a-validation.json](fixtures/d3d-review/stage4d2a-validation.json)。继续软件 T&L 共用化；D3D7 cooperative-level FPU 模式仍待 DDraw 阶段。GTA SA 现场已是 24 位精度，此修复不构成其停滞原因或恢复的证明。

> **阶段 4D2b（2026-11-02）：软件顶点数学共用化完成。**
>
> - 三个前端的平方根近似、行向量变换、矩阵相乘、颜色打包归入纯 C `d9wg_math.c`。矩阵读取兼容 D3D7 的独立 SDK 字段及 D3D8/9 数组，并使用常量尺寸 builtin copy 避免别名/对齐假设，无 CRT 调用。
> - 冻结 `120176e` 原 C 方法：宿主 1,100,000 次操作对照通过；**真实 XP 在 x87 24/53/64 位精度各通过 220,000 次、共 660,000 次对照**，110 秒。有限矩阵/颜色逐位一致，平方根另覆盖边界/NaN 分类；独立检查乘法顺序、平移与方向、未对齐 SDK 缓冲。
> - 80 组客体、两项站点集成、35 个冒烟 EXE 与六个 DLL 严格构建通过。见 [stage4d2b-validation.json](fixtures/d3d-review/stage4d2b-validation.json)。这只是共用数学，继续光照、法线与完整 ProcessVertices 的统一及 GPU 语义对照，不将当前近似算法等同规范验收。

> **阶段 4D2c（2026-11-02）：共用软件光照核心及 CPU/GPU 对照完成。**
>
> - 新增纯 C `d9wg_lighting`，三个 SDK 的材质、灯及渲染状态通过有布局断言的适配层进入同一实现；D3D7/8/9 ProcessVertices、旧版 LightElements 与 execute-buffer 的光照入口均接入。每次顶点操作只准备一次灯状态，统一材质颜色来源、环境/自发光、镜面反射、点光源/聚光及逆转置法线，按 NORMALIZENORMALS 状态归一化。新增无 CRT 的 x87 sqrt/pow/cos；同时补上此前仍独立的 D3D7 矩阵乘法，并保留其可别名输出行为。
> - **19 个 CPU/GPU 场景，13 组独立公式断言**：SwiftShader 与 Metal 各比较 77,824 对像素，最大字节误差均为 0（预设容差 1）。修复了宿主把 D3D7 平行点光源当作点光源，以及把衰减系数限制为 1 的错误；两个反例原先各错 1,128 像素，新增变异测试 2/2 均检出。CPU 生成的顶点只是差分输入，不是游戏黄金图像。
> - **真实 XP COM 的 D3D7/8/9 探针均通过**：从 VB shadow 读取结果，检查 COLOR1/COLOR2、关闭 COLORVERTEX、镜面 RGB 与来源 alpha、允许大于 1 的衰减、聚光余弦/平方衰减、非均匀缩放法线、归一化、零法线环境/自发光，并额外检查 D3D7 平行点光源及 D3D8 的稀疏灯索引 37。XP 数学另在 24/53/64 位精度共对照 720,000 次原方法运算及 180,000 次光照数学，控制字保持不变；宿主分别为 1,200,000 与 600,000 次。
> - 133 组核心、82 组客体、两项站点集成、35 个冒烟 EXE、3 个 XP 探针与六个 DLL 严格构建通过；316 项 GPU 一致性及预算模式、owner 隔离、26 项检查点、12/12 原变异和 Warcraft III 既有策略反例回归通过。证据见 [stage4d2c-validation.json](fixtures/d3d-review/stage4d2c-validation.json)，运行包 `279aac0b1243074d50fd`。
> - 继续统一完整顶点处理；雾生成、裁剪、混合矩阵、纹理坐标生成/复制规则、可编程顶点处理及旧版完整光照语义尚未完成。D3D7/9 的灯索引仍限于 0–7。本次不是阶段 4、Wine API 或游戏验收完成，也不构成 GTA SA 停滞修复的证明。

> **阶段 4D2d（2026-11-02）：共用固定功能顶点几何、复制及范围核完成。**
>
> - 新增纯 C `d9wg_vertex`，D3D7/8/9 现在共用声明/FVF 布局、矩阵/视口映射、颜色及纹理复制循环；D3D8 补丁插值也复用同一布局。移除三个 ProcessVertices 中的重复循环，并修正旧注释中“镜面反射未实现”的描述。
> - 修复 DONOTCOPYDATA：关闭光照时保留颜色/纹理透传，启用光照时继续生成受影响的颜色；补上 D3D7/8 的标志处理。多出的纹理分量及缺失的纹理组保留目的值，复制 normal/PSIZE。D3D9 使用输入流字节偏移，同一 VB 作输入/输出时先快照；范围检查在写出之前完成，不再先以 32 位相加/相乘，最后一个源顶点也不强求尾部步幅填充。FLOAT4 的输入 W 与很小的非零 W 参与透视除法。
> - **真实 XP 三个 COM API 均通过**：141 秒、6 批、三个 owner 完整释放；增加复制标志、纹理尾分量、D3D9 offset/alias 和索引溢出检查。另在三个 x87 精度各执行 20,000 组新范围/数值检查，既有 720,000 次数学及 180,000 次光照运算仍通过，控制字不变。宿主有 200,000 组独立范围对照，4/4 C 语义变异均由实际执行的数值/边界断言检出。
> - 把 C 核输出的 XYZRHW 与量化颜色送入 GPU：SwiftShader、Metal 各 19 场景、77,824 对像素，最大误差 1 字节，均在预先固定的容差内；原浮点光照页面仍通过。84 组客体、两项站点集成、35 个冒烟 EXE、3 个 XP 探针和六个 DLL 严格构建通过。宿主生产代码/运行包未变，沿用 4D2c 的全量核心/GPU 基线；见 [stage4d2d-validation.json](fixtures/d3d-review/stage4d2d-validation.json)。
> - 继续雾与纹理坐标生成/变换，以及混合、裁剪和可编程顶点处理；本次不宣称完整 ProcessVertices 或阶段 4 验收完成。

> **阶段 4D2e（2026-11-02）：共用顶点雾完成。**
>
> - `d9wg_vertex` 读取三个 SDK 相同的雾状态布局，按相机空间绝对 Z 或距离生成线性、指数及平方指数雾，写入 specular alpha，保留 RGB；DONOTCOPYDATA 仍生成雾，NONE 保留来源 alpha。线性分母保留符号，等起止值使用确定的阶跃。与固定 Wine 的 ProcessVertices 一样，因子生成由 FOGVERTEXMODE 决定，FOGENABLE 控制后续颜色混合。
> - 新用例暴露宿主将负的线性雾分母改成正数：原先错 1,128 个像素、最大 45 字节，已修复。C/GPU 对照扩为 **26 场景、每后端 106,496 对像素**，SwiftShader 与 Metal 最大误差均为 1 字节，在预设容差内；新增雾语义变异 1/1 检出。
> - **真实 XP 的 D3D7/8/9 COM 雾探针均通过**，150 秒、6 批、3 个 owner 完整释放；检查线性/指数/平方指数/范围/反向边界、复制标志及 NONE。纯数学在三种 x87 精度共对照 60,000 组雾公式，137 秒，控制字保持；宿主另有 200,000 组 libm 对照。
> - 133 组核心、85 组客体、两项站点集成、35 个冒烟 EXE、3 个 XP 探针、六个 DLL 严格构建通过；316 项一致性及预算模式、检查点、既有 Warcraft III 轨迹策略回归通过。C 变异 5/5、原 D3D9 变异 12/12、光照 2/2 通过。运行包 `e6d86a853e5e147a77c7`；见 [stage4d2e-validation.json](fixtures/d3d-review/stage4d2e-validation.json)。
> - 继续纹理坐标生成/变换，再完成混合、裁剪和可编程顶点处理；不把这些 XP 代理探针等同原生 Microsoft DLL、完整 Wine 或游戏验收。

> **阶段 4D2f（2026-11-02）：共用纹理坐标生成与变换完成。**
>
> - 三个前端通过同一 SDK 状态/矩阵解码函数接入 `d9wg_vertex`：来源索引、COUNT1–4、按输入维数补齐的纹理矩阵，以及相机位置、逆转置法线、反射和球面映射均在同一 C 核生成。NORMALIZENORMALS 按状态应用；投影坐标保留原 q，留给插值后的光栅阶段除法；生成/变换在 DONOTCOPYDATA 下继续写出，额外分量和缺失来源保持原值。光照与纹理生成共用稳定的向量归一化。
> - **真实 XP D3D7/8/9 COM 探针均通过**：122 秒、6 批、三个 owner 完整释放；检查来源 1、矩阵、COUNT1、保留 q、复制标志、位置/法线/反射，D3D9 另查球面映射。三个 x87 精度共完成 60,000 组独立纹理变换及所有前序数值对照，117 秒，控制字保持；宿主另有 100,000 组解析式检查。
> - 新增 **12 个带纹理 C/GPU 场景，每后端 49,152 对像素**，SwiftShader 与 Metal 逐像素一致。它们验证既有 XYZRHW 防重复变换逻辑，并发现 COUNT1 未应用矩阵：原先错 1,128 像素、最大 121 字节；已补齐 uniform 与着色器路径，专用变异 1/1 检出。参考数据由 C 核生成，另用解析坐标断言核对，沿用预设 1 字节像素容差。
> - 133 组核心、87 组客体、两项站点集成、35 个冒烟 EXE、3 个 XP 探针及六个 DLL 严格构建通过；26 场景的前序光照/几何/雾、316 项一致性与预算模式、检查点和既有 Warcraft III 轨迹策略回归通过。C 变异 9/9、宿主四组变异合计 16/16 通过。运行包 `322c06c1c7e1053c21e1`；见 [stage4d2f-validation.json](fixtures/d3d-review/stage4d2f-validation.json)。
> - 继续混合矩阵、裁剪和可编程顶点处理，然后收敛默认状态、格式/caps 与 D3D8 翻译层；完整 Wine 和游戏验收仍按后续阶段执行。

> **阶段 4D2g（2026-11-02）：共用固定功能顶点混合完成。**
>
> - 三个前端接入同一 C 调色板内核，支持 1–3 个显式权重、余量权重、索引/非索引及第 255 个矩阵；D3D7 正确跨过 view/projection 槽位。每个骨骼的法线先应用逆转置，再加权并按状态归一化；光照、雾和纹理生成复用混合后的相机空间数据。所有顶点索引在输出前校验，矩阵按需缓存。
> - 新增 **17 个 C/GPU 场景，每后端 69,632 对像素**，SwiftShader 与 Metal 均逐像素一致。发现并修复宿主混合法线、D3DCOLOR 索引和权重分量次序错误；专用 GPU 变异 3/3、C 混合变异 6/6 检出。固定 Wine 原生声明表的 28 项独立断言还纠正了 D3D9 特殊 FVF：XYZB2 的打包权重及裸 XYZB5 的 FLOAT1 索引；1,676,256 项展开对照保留原始基线并显式记录 11,172 种输入的修正。
> - **真实 XP 的 D3D7/8/9 COM 探针均通过**：130 秒、6 批、三个 owner 完整释放；覆盖混合、法线、打包权重和索引。三种 x87 精度另有 60,000 组混合解析对照及全部前序数值检查，147 秒、控制字保持；宿主有 100,000 组混合解析对照。
> - 133 组核心、90 组客体、两项站点集成、35 个冒烟 EXE、3 个 XP 探针、六个 DLL 严格构建通过；前序像素、一致性、预算、检查点及五组 GPU 变异合计 19/19 通过。Warcraft III 首次冻结策略重放出现 3 个策略外像素，随后前后版本各五次成对重放及额外复测均通过；保留首次失败，原因尚未证实，未扩展像素策略。
> - 运行包 `6a4aa34fffcf89a78f47`；见 [stage4d2g-validation.json](fixtures/d3d-review/stage4d2g-validation.json)。继续裁剪元数据、输出布局和可编程顶点处理；Tween、完整 Wine 与游戏验收尚未完成。

> **阶段 4D2h1（2026-11-02）：软件顶点深度回放修复，建立原生裁剪参考。**
>
> - 发现宿主对 XYZRHW 再次应用 MinZ/MaxZ，改变已完成软件顶点处理的深度。录制时屏幕坐标绘制改用 0–1 的有效深度范围，普通 XYZ 保留原范围；回放缓存正确切换同帧两种绘制。新增 11 项独立 GPU 像素用例，修复前 8 项失败，SwiftShader/Metal 修复后全部通过，变异 1/1 检出。原有近面用例误用 XYZRHW，现改用普通 XYZ 保留其预期验证目标。
> - **真实 XP 系统原生 Microsoft DDraw7 RGB 设备对照通过**：96 秒，10 项深度绘制逐项锁定表面读回绿色，确认屏幕顶点不重复应用深度范围。另捕获 252 组 ProcessVertices 原始 DWORD 输出，覆盖 CLIP 操作与 render state、guard band、近远面、W=1/2/−2。仅加载绝对系统目录 DLL，未部署代理；磁盘写入仍仅在 RAM。参考见 [d3d7-native-process-reference.json](fixtures/d3d-review/d3d7-native-process-reference.json)。
> - 133 组核心、两项站点集成、327 项一致性及两种预算模式、全部前序像素与 owner 隔离通过；Metal 327 项和 Warcraft III 冻结策略回归通过。运行包 `46b300fb4065049393df`；见 [stage4d2h1-validation.json](fixtures/d3d-review/stage4d2h1-validation.json)。继续共用裁剪输出、元数据及绘制接入；这些原生 D3D7 结果不代表 D3D8/9、完整 Wine 或游戏验收完成。

> **阶段 4D2h2（2026-11-02）：共用裁剪几何与原生存储核完成。**
>
> - 新增 `d9wg_clip`，分别保留原始裁剪坐标、屏幕坐标、公开 VB 存储、视锥 outcode 与投影标志；六平面边界按 D3D 的 Z=0..W，guard band 独立判断。与 h1 捕获的 **252 组原生 Microsoft DDraw7 输出全部对照通过**，包括 CLIP 操作独立于 render state、guard band、W=1/2/−2，以及原生投影存储 `((x+w)/2,(y+w)/2,z,w)`。
> - 三个前端的 viewport 投影现在调用同一函数；抽出前后的 26/12/17 组 C 参考数值逐项相同。宿主 100,000 组解析检查、C 裁剪变异 6/6、前序顶点 9/9 及混合 6/6 通过。XP 三种 x87 精度另对照 60,000 组裁剪公式和全部前序数值检查，122 秒、控制字保持。
> - 真实 XP 三个代理 COM 回归通过：145 秒、6 批、三个 owner 完整释放；92 组客体、两项站点集成、35 个冒烟 EXE、六个 DLL 严格构建通过。SwiftShader 四组 C/GPU 对照共 331,776 对像素通过；宿主代码与运行包仍为 `46b300fb4065049393df`。见 [stage4d2h2-validation.json](fixtures/d3d-review/stage4d2h2-validation.json)。
> - **尚未切换前端的公开 VB 输出格式**：接下来必须同时接入缓冲裁剪元数据和图元绘制，不能只把投影格式上传为 XYZRHW。用户平面、原生 W=0、输出布局及可编程处理继续执行。

> **阶段 4D2h3a（2026-11-02）：共用图元裁剪、缓冲元数据及 D3D7 绘制接入完成。**
>
> - `d9wg_clip`/`d9wg_clip_draw` 先在齐次空间裁剪，再执行除法；共用点、线、三角形、条带和扇区处理，保留已映射深度。缓冲记录按字节位置关联，支持覆盖、部分重叠、位置改写失效及释放；划分出的工作区由调用者持有，避免 x86 大栈帧。D3D7 的 CLIP 操作现在写出原生投影格式，普通及索引 VB 绘制消费同一元数据；RGB guard band 与原生测量一致。
> - **真实 XP 代理 102 秒、19 批录制 18 次 COM 绘制**；六个场景分别覆盖直接、普通 VB 和索引 VB。SwiftShader/Metal 每后端 **196,608 对像素**，均在预设 1 字节容差内。修复前，前三场景各错 459 像素，负 W 场景错 1,240 像素。零 W 用独立推导的正 W 多边形校验；原始直接零 W 的后端差异单独保留为诊断，未当作参考或宣称修复。
> - **系统原生 Microsoft RGB 软件设备另用 100 秒完成 18 幅图**，索引与普通 VB 全图相同；原始坐标及图像参考保留。其透视颜色和边缘结果与现代 GPU 存在差异，仍属后续完整旧版验收，不能把这些图直接当 D3D9 颜色标准。公共 XP 回放仅保留过程生成的绘制数据，已清掉桌面像素和诊断文本，纳入 GPU 回归。
> - 宿主 100,000 组三角形解析/重心检查；XP 三种 x87 精度共 60,000 组，并执行缓冲和绘制检查及全部前序数值验证，117 秒、控制字保持。三个 API 的原有 COM 回归另用 115 秒通过，6 批、三个 owner 完整释放。裁剪变异 6/6、管线变异 8/8、前序顶点 9/9、混合 6/6 均检出。
> - 134 组核心、96 组客体、两项站点集成、35 个冒烟 EXE、六个 DLL 严格构建、327 项一致性与预算模式及全部前序 GPU 回归通过。宿主包仍为 `46b300fb4065049393df`；见 [stage4d2h3a-validation.json](fixtures/d3d-review/stage4d2h3a-validation.json)。接下来把相同缓冲/绘制核心接入 D3D8/9，继续用户平面、布局、可编程处理及完整 Wine/游戏验收。

> **阶段 4D2h3b（2026-11-02）：D3D8/9 的处理缓冲裁剪接入完成。**
>
> - D3D8/9 现在在 `ProcessVertices` 开启 CLIPPING 时保留缓冲内部记录，普通及索引绘制共用已有齐次裁剪核；处理后改变 CLIPPING 不会丢失原记录。覆盖非零源/目标顶点、D3D9 流偏移和 POSITIONT 不在首位的输出声明。DISCARD/释放清理记录，D3D8 同缓冲输入先快照。
> - 裁剪后的内部命令保留应用的 VB/IB 绑定；共享 Windows 工作区分配也用于 D3D7。索引范围同时检查 MinVertexIndex、上界和实际有符号基顶点；D3D8 验证 16/32 位索引。guard band 全零时按视口边界处理，不把它当成四个零坐标。
> - **真实 XP D3D8 88 秒、D3D9 122 秒，各 37 批、36 次 COM 绘制**。每 API 六个几何场景及六种调用路径；SwiftShader/Metal 每 API、每后端 **491,520 对像素**，全部在预设 1 字节容差内，绑定检查通过。公共回放已清除无关系统光标/纹理像素及诊断文本，并纳入完整 GPU 目标。
> - 135 组核心、96 组客体、两项站点集成、35 个冒烟 EXE、六个 DLL 严格构建、23 个 GPU 页及适配器检查通过；327 项一致性的普通、uniform 溢出和小上传预算模式均通过。XP 三种 x87 精度重新执行全部前序数学及 60,000 组三角形、缓冲/绘制检查，另复跑三个 API 的 COM 数值回归。裁剪管线变异 **9/9**，包括低于 MinVertexIndex 的索引。
> - 宿主包仍为 `46b300fb4065049393df`；见 [stage4d2h3b-validation.json](fixtures/d3d-review/stage4d2h3b-validation.json)。系统原生参考仍来自独立 D3D7 测量，本次不宣称 Microsoft D3D8/9、完整 Wine 或游戏等价；继续用户裁剪平面、通用布局和可编程顶点处理。直接零 W 插值的后端差异继续单列诊断。

> **阶段 4D2h3c（2026-11-02）：处理缓冲的共用用户裁剪平面完成。**
>
> - 系统原生 Microsoft D3D7 RGB 另用 87 秒记录 **360 组输出，全部逐字节匹配**。确认平面按世界坐标判断，用户平面外的顶点写投影格式；D3D7 的 OP_CLIP 与 CLIPPING 状态独立。保留 [原生参考](fixtures/d3d-review/d3d7-native-user-plane-reference.json)。
> - 三前端保留处理时的六个用户平面距离/掩码，与视锥六平面共用齐次裁剪；点、线和三角形覆盖十二个半空间，插值保留颜色、纹理及已映射深度。索引混合直接计算加权世界位置，支持奇异投影，无需求逆。工作区扩到最多 15 个多边形顶点/39 个绘制顶点，继续放在堆上。
> - 输出屏幕顶点时暂时关闭宿主用户平面，防止再次用错误坐标裁剪，随后恢复原掩码；发射及恢复失败保持可见。实际 C 测试验证成功、发射失败、两次分配失败及恢复失败，并检查释放平衡。
> - **真实 XP 三 API 共 96 次 COM 绘制**，包含处理后再次直接绘制来验证恢复，以及索引、流偏移和输出声明。SwiftShader/Metal 每后端 **1,277,952 对像素全部相同，最大字节误差 0**。D3D7 成功标记曾早于 DLL detach；测试现等待实际 owner 释放，保留原断言，重跑完整释放通过。
> - 100,000 组原生多平面三角形/线段及重心检查，XP 三种 x87 精度共 60,000 组，含世界混合和奇异投影；9/9 用户平面、9/9 原裁剪管线、6/6 混合变异均检出。136 组核心、100 组客体、两项站点集成、35 个冒烟 EXE、六个 DLL 严格构建、26 个 GPU 页及适配器检查通过；原数值差分样例内容未改变。
> - 宿主包仍为 `46b300fb4065049393df`；见 [stage4d2h3c-validation.json](fixtures/d3d-review/stage4d2h3c-validation.json)。继续 ClipStatus、通用布局、多流和可编程处理；本次不宣称完整 ProcessVertices、原生 D3D8/9、旧 RGB 颜色栅格、Wine 或游戏验收完成，直接零 W 插值差异仍单列诊断。

> **阶段 4D2h4（2026-11-02）：共用 ClipStatus 与旧版 2D 范围更新完成。**
>
> - 新增原生 Microsoft D3D7 RGB **100 组查询、8 组 Set 标志 HRESULT 参考**，纯 C 及真实 XP 代理均逐字节匹配。旧版 Get 只写 2D 字段并保留调用者 Z 范围，Set 按标志更新并拒绝 EXTENTS3；默认状态、累积位和高位标志与原生一致。[原生参考](fixtures/d3d-review/d3d7-native-clip-status-reference.json)。
> - 三 API 的软件固定功能处理共用裁剪代码和状态核。索引调用处理整个声明顶点范围，包含未引用顶点；修改状态前校验索引、实际缓冲范围及骨骼索引。D3D7 的 CLIP 与 EXTENTS 分开更新，2D 范围采用原生一像素边距并限制在视口；普通 XYZ 缓冲绘制更新状态，预变换缓冲不重复处理。
> - 即时 XYZRHW 仅在开启裁剪时更新状态，忽略世界用户平面，Z 按实际深度缓冲的 [0,1] 判断；塌缩 MinZ/MaxZ 不会再次映射。D3D9 POSITIONT 即使绑定顶点程序也跳过顶点处理。尚无 CPU 支持的程序/多流布局继续走原有 GPU 绘制，状态查询明确拒绝陈旧结果。
> - 新增三个 API 同次 XP 启动的状态与绘制探针，均验证独立 owner 及完整释放；后者重录 **96 次 COM 绘制**。SwiftShader/Metal 每后端 **1,277,952 对像素相同**，公共数据清除桌面/光标像素并保留实际 DLL、EXE 与源码构建信息。补跑原三 API 光照、雾、纹理、混合及范围回归通过。
> - 原生 100,000 组状态历史；XP 三种 x87 精度分别匹配 100 组原生查询和 100,000 组状态历史，全部前序数学及几何检查通过，控制字保持。状态变异 **14/14**、原裁剪 **9/9**、用户平面 **9/9**、混合 **6/6** 均检出；各变异头文件现分目录隔离，避免交叉影响。
> - 136 组核心、102 组客体、两项站点集成、35 个冒烟 EXE、六个 DLL 严格构建、26 个 GPU 页及适配器检查通过。宿主包仍为 `46b300fb4065049393df`，见 [stage4d2h4-validation.json](fixtures/d3d-review/stage4d2h4-validation.json)。软件固定功能绘制增加按声明范围的 CPU 状态计算，尚未宣称客体 FPS 验收。继续通用属性布局、多流、可编程处理及默认值/caps/包装层；本次不宣称原生 D3D8/9、完整 Wine 或游戏验收完成。

> **阶段 4D2i1（2026-11-02）：D3D7 原生 RGB 输出布局及有界尾部写入完成。**
>
> - 在原始 Microsoft DDraw7 RGB 上冻结 3 种源格式、12 种目标 FVF、复制标志和偏移的 168 个完整公开缓冲（7,056 个 DWORD）；84 个成功转换作为逐字参考。RGB 拒绝的其余组合保留 HRESULT 记录，不把代理的更宽格式支持算作 HRESULT 一致性通过。原生 `OP_CLIP + XYZ` 会卡在调用中，原生参考跳过该组合，并始终留一个备用目标顶点容纳尾部写入。
> - 实测补齐 Wine 测试所记录的 XYZ/RHW 特例：Microsoft RGB 始终用紧凑 XYZRHW、颜色、float2 纹理坐标游标写属性，以声明的 FVF stride 推进顶点；目标 NORMAL/保留字段不推进属性游标，纹理复制不被目标组件数截断。规则进入同一份 C 顶点核的 D3D7 输出布局描述，D3D8/9 仍使用自己的声明布局。
> - D3D7 接受 XYZ 目标；RHW/后续属性只写入公开分配范围内，最后一个有效顶点不会越界。上传包含分配范围内的尾部变化。XYZ 的临时裁剪记录只更新状态/范围，不留作 XYZRHW 绘制元数据；源、目标是同一缓冲时先快照源字节。
> - 实际 XP 代理 COM 调用逐字匹配全部 84 个成功原生缓冲，另通过重叠源/目标、末尾有效顶点及临时裁剪/范围记录检查。共用 C 核在 x87 三种精度下各通过 84 个原生缓冲及末尾哨兵检查；原有裁剪/用户平面/状态/混合/光照/纹理数学回归通过。新增输出语义变异 6/6 拦截。
> - 137 组核心、104 组客体、27 项 WebGPU 验证、2 项站点集成、35 个冒烟 EXE、六个严格构建 DLL 及实际 XP 三 API T&L 回归通过。三个既有数值参考的 cases 不变，仅更新源码哈希。宿主运行包仍为 `46b300fb4065049393df`；见 [stage4d2i1-validation.json](fixtures/d3d-review/stage4d2i1-validation.json)。
> - 本次原生依据是 Microsoft RGB 的软件输出行为；不宣称原生 HAL、D3D8/9、原生重叠缓冲或会挂起的 XYZ 裁剪调用一致性。继续通用打包/多流布局、可编程处理及其余共用核心；完整 Wine 与游戏验收仍待后续阶段。

> **阶段 4D2i2a（2026-11-02）：共用打包输入解码及软件几何属性接入完成。**
>
> - 增加 SDK 无关的 17 种 D3DDECLTYPE 读取：float、ARGB/字节、带符号短整数、8/16 位归一化值、10:10:10、半浮点及缺省分量。未对齐数据通过字节复制读取；SNORM 极小值钳制为 −1，半浮点保留有限值和有符号零，并产生正确的 Infinity/quiet NaN 分类。
> - 同一解码器接入软件位置、法线、点大小、纹理坐标、归一化混合权重、光照/混合的法线以及 ClipStatus 位置读取。范围校验使用真实压缩字节数；现阶段输出仍限规范 float/ARGB 布局，打包输出在写入前明确拒绝，避免写坏缓冲。D3D7 的原生 RGB 输出特例仍通过。
> - 独立公式生成 1,088 组格式向量，并穷举全部 65,536 种 binary16 位模式；C 核逐字/NaN 分类检查、未对齐字段、混合/光照/裁剪、末尾范围和额外纹理分量检查通过。新增语义变异 9/9 拦截，AddressSanitizer/UBSan 通过。XP x87 三种精度累计验证 3,264 组格式向量和 196,608 个半浮点模式，原有全套数学检查也通过。
> - 实际 D3D9 COM 检查通过：半浮点位置、DEC3N 法线、SHORT2N 纹理、半浮点点大小、源/目标偏移、DONOTCOPYDATA、ClipStatus，以及不支持输出/截断输入时的原子拒绝。三 API 的实际 XP T&L 回归通过。
> - 新增 GPU 顶点读取差分：保留生产着色器的输入转换与 MOV 主体，通过整数 flat varying 与片段 storage 记录值。SwiftShader 和 Metal 各处理 66,624 组向量；有限半浮点值精确相符，归一化格式最大 1 ULP，在事先固定的 2 ULP 范围内。NaN/Infinity 单独记录，不能作为可移植 GPU 精确相等的依据；SwiftShader 对 2,048 个特殊半浮点模式返回有限值，Metal 保留 2,046 个 NaN 和两个 Infinity，见 [WGSL 有限数学规则](https://www.w3.org/TR/WGSL/#floating-point-evaluation)。
> - 138 组核心、106 组客体、28 项 WebGPU 验证、2 项站点集成、35 个标准冒烟 EXE 和六个严格构建 DLL 通过。既有三个数值参考的 cases 不变，并把新头文件加入来源哈希。运行包仍为 `46b300fb4065049393df`；见 [stage4d2i2a-validation.json](fixtures/d3d-review/stage4d2i2a-validation.json)。
> - 本次 GPU 检查覆盖实际格式读取与生产可编程入口转换，不等于完整固定功能绘制已支持所有打包位置/法线。继续固定功能入口的类型转换、浮点颜色、打包输出、多流和可编程处理；原生 D3D8/9、完整 Wine 与游戏验收仍待后续阶段。

> **阶段 4D2i2b（2026-11-02）：固定功能/可编程入口共用类型转换完成。**
>
> - 用实际执行器绘制 85 个颜色、法线、纹理、位置和点大小场景，并与独立解码后的 FLOAT4 输入逐像素对照。修复前 28 场景像素错误、40 个 GPU 校验错误、5 个丢弃绘制；问题包括整数属性与 float 着色器参数不匹配、10 位打包值未展开，以及 ARGB 作为几何/法线/纹理输入时通道颠倒。
> - 把属性参数类型、float4 扩展、ARGB 顺序及 UDEC3/DEC3N 展开集中到着色器模块的共用入口函数；固定功能与可编程调用方共用同一类型映射。固定功能在入口建立规范 float4 局部变量，混合权重/索引继续使用其既有专门规则，避免重复归一化或重复交换通道。
> - 转换种类进入固定功能模块缓存键；普通 float/ARGB 颜色路径按需创建转换描述，数据数值不进入 shader key。现有 12 种可编程入口生成结果和公开绘制触发的普通固定功能入口保持 WGSL 字节相同。
> - 修复后 SwiftShader、Metal 各 85 场景、348,160 对像素完全相同：最大字节误差 0，GPU/宿主错误、丢弃和命令失败均为 0。新增可重现 GPU 变异检查，六种路由、通道、缺省 W、归一化和缓存错误全部被检测，并保证每次恢复源码。
> - 138 组核心、29 项 WebGPU 验证和两项站点集成通过；客体生产代码未调整，沿用 4D2i2a 的 106 组客体、三种 x87 精度、XP COM/T&L 和六 DLL 构建结果。新运行包 `3e84336e0707ddf60aa8` 已同步站点；见 [stage4d2i2b-validation.json](fixtures/d3d-review/stage4d2i2b-validation.json)。
> - 继续软件浮点颜色、打包输出、多流和可编程处理。上述 GPU 结果是格式读取与固定功能绘制验收，不代表完整原生 D3D8/9、Wine 或真实游戏验收完成。

> **阶段 4D2i2c（2026-11-02）：软件顶点颜色的浮点精度与类型接入完成。**
>
> - 软件处理的 COLOR0/COLOR1 接入共用 17 格式解码器，浮点、半浮点及整数/归一化颜色在光照前保持解码精度，最后写 ARGB 目标时才量化。光照/混合视图入口复用同一浮点颜色桥接；既有 DWORD 颜色保留直接复制路径。
> - 共用颜色字节转换明确处理 NaN/Infinity，避免非有限浮点值到整数的 C 未定义转换；雾 alpha 使用同一转换，并保留 RGB。输出继续使用固定功能的 float/ARGB 布局；一般打包声明输出随可编程处理继续，后续原生 API 验收还会核对 FVF 目标约束与复制/生成细节。
> - 独立数值参考覆盖 1,092 种输入及六种复制/光照/镜面/雾模式。0.0011 等小颜色在 100 倍光照后得到正确结果，提前量化的实现会失败。新增六种语义变异全部拦截，其中非有限整数转换由实际运行的 sanitizer 检查；ASan/UBSan 通过。
> - 实际 XP COM 验证浮点材质颜色精度、独立镜面源、DONOTCOPYDATA、雾 alpha、半浮点及原始整数颜色；x87 三种精度累计检查 3,276 组颜色输入、19,656 个处理模式，原有 196,608 个半浮点模式及所有几何/混合/裁剪数学检查通过。三 API XP T&L 回归通过。
> - SwiftShader、Metal 各 84 个颜色/光照/镜面/雾场景、344,064 对像素完全相同，最大字节误差 0；雾对照使用 0–1 颜色，屏幕位置采用已固定的解析视口映射。GPU/宿主错误、丢弃、命令失败均为 0。
> - 139 组核心、108 组客体、30 项 WebGPU 验证、两项站点集成、35 个标准冒烟 EXE 和六个严格构建 DLL 通过；既有三个数值参考的 cases 保持不变。宿主运行包沿用 `3e84336e0707ddf60aa8`；见 [stage4d2i2c-validation.json](fixtures/d3d-review/stage4d2i2c-validation.json)。
> - 继续多流软件输入和可编程处理/打包输出，以及其余共用核心；完整原生 D3D8/9、Wine 与游戏验收继续保留在后续阶段。


> **阶段 4D2i3a（2026-11-02）：共用多流软件输入与 D3D9 ProcessVertices 接入完成。**
>
> - 声明保留最多 64 个原始属性，按各自流、偏移和步长读取；16 个流共享已有打包解码、浮点颜色、光照、混合、雾和裁剪内核。零步长重复同一份属性，不按源顶点索引推进；单流普通布局继续直接调用原处理内核。
> - 在第一处写入前验证全部流和整个调色板索引范围。目标同时绑定为多个输入流时，只保存一份调用前缓冲快照，所有别名共用该快照；未绑定 stream 0 的合法源声明也可处理。实例分频的软件处理仍明确拒绝。
> - 独立 double 边界参考检查 100,000 组范围，轮换覆盖全部 16 个流编号；验证混合格式、常量颜色、偏移、复制/雾/光照、逐顶点裁剪记录、世界用户平面和最后一个无效调色板索引的原子失败。7/7 语义变异被实际断言拦截，ASan/UBSan 通过。
> - 实际 XP D3D9 COM 覆盖非零位置流、各流偏移、打包法线、浮点常量颜色、复制标志、裁剪状态、全部零步长配合 UINT_MAX 源索引、多个目标别名和失败时不改输出/状态。视口外顶点继续采用既有齐次裁剪存储约定。三种 x87 精度累计检查 300,000 组范围及 48 组流轮换；三 API T&L 回归通过。
> - 139 组核心、110 组客体、两项站点集成、35 个标准冒烟 EXE 和六个严格构建 DLL 通过。四个已有数值参考的 cases 保持不变；宿主 JS/运行包没有变化，GPU 验收沿用 4D2i2c 的 30 项结果，不把本次 XP 接口检查计作 GPU 绘制验收。见 [stage4d2i3a-validation.json](fixtures/d3d-review/stage4d2i3a-validation.json)。
> - 本阶段完成软件 ProcessVertices 的多流输入。继续普通绘制的多流范围/ClipStatus、宿主零步长绘制、可编程处理/打包输出和其余共用核心；原生 D3D8/9、完整 Wine 与真实游戏验收仍待后续完成。


> **阶段 4D2i3b（2026-11-02）：宿主常量顶点流绘制完成。**
>
> - 宿主区分已绑定的零步长输入与未绑定流，保留原属性类型/偏移，直接使用 WebGPU 的 arrayStride=0；普通顶点、实例和点扩展都重复同一份属性。依据 [WebGPU 顶点布局规则](https://www.w3.org/TR/webgpu/#abstract-opdef-validating-gpuvertexbufferlayout)，零步长属性仍检查真实属性范围。
> - 大于一的实例分频无需展开常量数据；索引点压缩保留常量流的原始缓冲、偏移和资源引用，因此后续上传继续正确处理已记录绘制。普通步长与零步长切换使用各自的管线布局，回切可复用匹配缓存。
> - 12 个实际 GPU 场景覆盖浮点/ARGB 颜色、固定/可编程入口、非零位置流、源/属性偏移、StartVertex、负 BaseVertexIndex、索引点、常量位置、实例分频 1/3 及同一缓冲的多个绑定。对照按 D3D 语义显式重复数据，并独立检查覆盖区域的颜色。
> - SwiftShader、Metal 各 49,152 对像素完全相同，最大字节误差 0；GPU/宿主错误、命令失败和绘制丢弃均为 0。旧实现失败，三个语义变异全部拦截且生产源码已恢复。
> - 140 组核心、31 项 WebGPU 验证及两项站点集成通过。客体 C 未改变，沿用 4D2i3a 的 110 组客体、三精度 XP 数学、COM/T&L 和六个 DLL 构建结果。运行包 `be0e784a17c9ea12cf09` 已同步站点；见 [stage4d2i3b-validation.json](fixtures/d3d-review/stage4d2i3b-validation.json)。
> - 本阶段是宿主线协议绘制验收；客体普通绘制还需接入多流范围和 ClipStatus 校验。继续这些内容及可编程软件处理/打包输出、其余共用核心，不宣称原生 D3D8/9、完整 Wine 或真实游戏验收完成。


> **阶段 4D2i3c（2026-11-02）：D3D9 普通多流绘制范围及 ClipStatus 接入完成。**
>
> - DrawPrimitive/DrawIndexedPrimitive 按声明验证各实际输入流的缓冲、锁定、偏移、类型宽度及步长，允许缺少 stream 0、未使用但锁定的 stream 0、零步长和没有末尾填充的最后一个顶点。索引声明范围同时计入有符号 BaseVertexIndex，并检查溢出；实例流按分频后的实例数量检查范围。
> - 多流软件 ClipStatus 共用既有单顶点裁剪内核，检查实际索引边界，再处理完整声明范围，包括未引用顶点。世界用户平面、混合调色板和 POSITIONT 的跳过/即时处理规则保持一致；晚出现的坏范围或调色板索引不提交部分状态。Windows 状态准备在单流/多流间共享。
> - 新增独立 C 场景和 8/8 语义变异，覆盖有符号基址、上下索引边界、常量位置、完整范围、世界平面、逐步状态提交错误和即时 POSITIONT；ASan/UBSan 通过。三种 x87 精度重新运行完整数学集合及多流裁剪检查。
> - 实际 XP COM 覆盖普通/索引绘制、未引用范围、有符号基址、各流边界、用户平面、锁定、UINT_MAX 常量位置及失败状态不变。CPU 尚未实现的实例 ClipStatus 继续明确拒绝查询，禁用裁剪后恢复有效零状态。原始多流 POSITIONT 可直接绘制并保留 ClipStatus。
> - 带处理记录的多流 POSITIONT 还需要重映射裁剪记录；在此之前明确拒绝相关绘制，避免把齐次记录误当屏幕坐标。位置写入后使用既有逐字校验使失效记录永久失效，原始数据可恢复普通绘制；该分支的共用裁剪发射继续下一步实现。
> - 140 组核心、112 组客体、两项站点集成、35 个标准冒烟 EXE、六个严格构建 DLL、三 API XP T&L 通过。四个已有数值参考的 cases 不变；宿主代码和运行包沿用 `be0e784a17c9ea12cf09`，GPU 验收沿用 4D2i3b 的 31 项结果。本次 XP ACK 检查不计作新的 GPU 绘制验收。见 [stage4d2i3c-validation.json](fixtures/d3d-review/stage4d2i3c-validation.json)。
> - 继续多流处理记录的裁剪发射、可编程软件处理/打包输出和其余共用核心；新范围检查尚未做客体 FPS 验收，完整原生 D3D8/9、Wine 与真实游戏验收仍保留在后续阶段。


> **阶段 4D2i3d（2026-11-02）：多流处理记录的裁剪发射及 POSITIONT 宿主语义接入完成。**
>
> - 共用裁剪器可从多个源流按原始字节地址查找处理记录，再收集属性，复用原单流的几何、用户平面、深度和插值内核。多流 UP 发射临时使用单流声明；无论成功或发射失败，都恢复宿主声明及用户平面状态，应用的 VB/IB 和声明身份保持不变。没有活动记录的范围继续普通绘制，未引用记录不会阻塞；位置改写仍永久使旧记录失效。
> - 独立 C 对照在近/侧面裁剪、处理时用户平面、绘制视口变更和有符号索引下，逐字比较单流/多流的几何、ARGB 与纹理坐标。覆盖全常量流跨 UINT_MAX 索引及晚出现坏流时不发射部分图元。6/6 新语义变异、原 9/9 裁剪变异及 ASan/UBSan 通过；旧裁剪 C 源文件无法通过新多流用例。
> - 新实际 XP 捕获包含三组、12 个纹理画面：原始单流、处理后单流、处理后多流、裁剪后恢复普通多流。含非零位置流、常量 ARGB、独立纹理流、负索引基址、用户平面及不同处理/绘制视口。公开捕获清除桌面/光标和日志数据，只保留明确给定的 2×2 程序纹理；记录实际 DLL/EXE 和构建源码摘要。
> - SwiftShader、Metal 各六组、98,304 对像素完全相同，最大字节误差 0；独立纹理采样点符合指定颜色，GPU/宿主错误、丢弃与命令失败均为 0。错误声明恢复、颜色/纹理偏移及 POSITIONT 用户平面回归四种 GPU 变异全部拦截，文件已精确恢复。
> - GPU 验证还发现宿主对原始 POSITIONT 重复应用用户平面；现按其跳过顶点处理的语义，在固定及 PS1/2/3 路径省略用户裁剪，XYZ 路径保留原平面容量和缓存。新增两项独立像素检查，SwiftShader/Metal 的 329 项 conformance 通过。GPU 捕获声明使用 DWORD 对齐；非对齐属性的纯 C/x87 测试不作为原生声明接受性的证明。
> - 142 组核心、114 组客体、32 项 WebGPU 验证、两项站点集成、35 个标准冒烟 EXE 和六个严格构建 DLL 通过；三精度 XP 数学与三 API T&L 回归通过。四个原数值参考的 cases 不变。运行包 `7beb9d03738199295430` 已同步站点；见 [stage4d2i3d-validation.json](fixtures/d3d-review/stage4d2i3d-validation.json)。
> - 本次多流发射覆盖既有 float 几何/ARGB/float 纹理输出布局。混用其他打包/浮点颜色属性的处理记录仍需下一步接入；继续该项、可编程软件处理/打包输出和其余共用核心。客体 FPS、完整原生 D3D8/9、Wine 与真实游戏验收仍保留在后续阶段。


> **阶段 4D2i3e（2026-11-02）：处理后多流裁剪的 17 种属性格式接入完成。**
>
> - 共用裁剪器按源声明解码颜色、镜面颜色、法线、点大小和纹理坐标，再按独立的临时输出声明发射 float 属性。FLOAT/整数/归一化/半浮点颜色保持 float4 至最终像素转换；原 D3DCOLOR 的 ARGB 裁剪路径保留原有逐字行为。D3D9 单流非规范布局也进入该共用路径，裁剪后恢复原声明。
> - 独立数值参考提供 1,082 组有限输入、5,410 组属性角色用例，覆盖全部 17 种类型、非对齐常量源、写入边界和原 DWORD 路径；7/7 C 语义变异及 ASan/UBSan 通过。三种 x87 精度执行 3,246 组输入、16,230 组角色用例通过。
> - 实际 XP COM 新捕获含 19 组、76 帧：17 种颜色格式、半浮点点大小和浮点镜面颜色，包含处理后绘制及恢复后的普通三角形绘制。64 倍颜色增益放大提前量化错误；固定管线和显式 COLOR1 的 PS3 各有独立源字节/颜色期望。公开捕获清除全部桌面/光标及日志载荷，只保留明确给定的九 token 程序着色器，并记录实际 DLL/EXE/源码摘要。
> - SwiftShader、Metal 各 38 组、622,592 对像素完全一致，76 个独立颜色探针最大字节误差 0，GPU/宿主错误和丢弃均为 0。提前颜色量化、浮点镜面 alpha 丢失和半浮点点大小三种 GPU 变异全部被拦截，压缩捕获已精确恢复。测试几何使用可精确表示的裁剪交点；未放宽逐像素比较要求。
> - 143 组核心、116 组客体、33 项 WebGPU 验证、两项站点集成、35 个标准冒烟 EXE、六个严格构建 DLL 及三 API XP T&L 回归通过。四个原数值参考的 cases 不变。宿主 JS 未改变，运行包继续为 `7beb9d03738199295430`；已更新 app-local 客体 DLL。见 [stage4d2i3e-validation.json](fixtures/d3d-review/stage4d2i3e-validation.json)。
> - 此步扩展裁剪输入与内部发射格式；应用指定的任意打包 ProcessVertices 输出、可编程 CPU 顶点处理、其余共用运行时及完整 Wine/游戏验收继续按阶段推进。GPU 属性格式组合不等同于完整原生 D3D8/9 API 验收，也不构成新的 FPS 结论。


> **阶段 4D2j1（2026-11-02）：共用稀疏灯光存储与 D3D9 高索引软件光照接入完成。**
>
> - D3D8/9 共用 SDK 灯光存储、默认值和释放逻辑。D3D9 保留 0–7 的内联访问，为更高的 DWORD 索引分配稀疏节点；Set/GetLight、LightEnable/GetLightEnable、软件 T&L 和状态块接入同一份数据。首次 LightEnable(FALSE) 也创建默认白色 +Z 方向光，替换属性保留启用状态。MaxActiveLights 仍限制同时参与的数量，不限制索引编号。
> - 原生 XP 系统 D3D7 RGB 的 35 组公开查询已冻结：索引 0、7、8、37、1000，涵盖不存在的灯光、首次禁用/启用、属性改写和重复启停。默认 SDK 26 个 DWORD 与官方表一致；原生启用 BOOL 实测为 0x80，尚未创建时 GetLight/GetLightEnable 失败且不改写输出。该原生证据用于默认值及下一步 D3D7 接入，不作为原生 D3D9 的证明。
> - 纯 C 检查对照五组原生默认表，验证 1,007 个稀疏 DWORD 键、UINT_MAX、重复查找、分配失败时链表不变及完整/幂等释放；5/5 语义变异、ASan/UBSan 通过。D3D9 状态块保留高索引的属性/启用独立掩码，Capture 不扩张掩码，分配失败清理节点；顶点/ALL 块只捕获已创建灯光，像素块不捕获灯光。
> - 实际 app-local XP D3D8/9 COM 通过六个索引（含 UINT_MAX）的默认值、精确属性、启用持续性和顶点/像素块 Capture/Apply；D3D9 还通过录制后恢复及仅启用掩码。D3D8/9 的完整软件光照用例均改用索引 37，独立颜色期望继续通过；三 API T&L、三个 owner 及释放回归通过。新检查发现 D3D8 EndStateBlock 未恢复录制前状态，列入紧接着的修正，未将该行为计作本步验收。
> - 143 组核心、118 组客体、35 个标准冒烟 EXE 和六个严格构建 DLL 通过；已更新 app-local DLL。宿主 JS 和运行包 `7beb9d03738199295430` 未改变，WebGPU/数学验证沿用 4D2i3e，未声明新的 GPU 像素、FPS 或完整 Wine/游戏验收。见 [stage4d2j1-validation.json](fixtures/d3d-review/stage4d2j1-validation.json)。
> - 后续顶点处理范围校正：微软规定 ProcessVertices 输出声明只允许 FLOATn / D3DCOLOR，显式输出声明要求 VS3+；此前“任意打包输出”的泛化待办撤销，保留合法输出布局及可编程 CPU 顶点处理。依据：[输出声明规则](https://learn.microsoft.com/en-us/windows/win32/direct3d9/mapping-fvf-codes-to-a-directx-9-declaration)、[LightEnable 默认值](https://learn.microsoft.com/en-us/windows/win32/api/d3d9/nf-d3d9-idirect3ddevice9-lightenable)、[灯光索引与 MaxActiveLights](https://learn.microsoft.com/en-us/windows/win32/api/d3d9/nf-d3d9-idirect3ddevice9-setlight)。D3D7 的稀疏状态和 D3D8 的录制恢复继续下一步。


> **阶段 4D2j2a（2026-11-02）：D3D8 现有状态块入口改为延迟录制。**
>
> - 录制中的渲染状态、纹理阶段、视口、材质、变换及乘法、灯光属性/启用、流、索引、纹理与着色器绑定直接写入录制块，不再改写当前设备或提前发射宿主命令。EndStateBlock 保留记录值；显式 Apply 才更新设备。同值调用仍设置掩码，多次写入保留最后值；矩阵乘法使用同一录制中先前记录的矩阵。Capture 继续读取掩码对应的当前状态。
> - 录制块独立持有 VB/IB/纹理引用；重复记录先持有新引用再释放旧引用，应用释放其引用后块仍可应用。实际 XP COM 检查录制期间的查询及录制后/Apply 后的结果，验证精确引用计数、索引基址、FVF、材质/视口/矩阵与同值掩码；D3D8 的高索引灯光录制恢复用例也通过。
> - 新实际 XP 命令捕获用三个 Present 划定边界：录制阶段只有第二个 PRESENT，没有任何状态命令；Apply 阶段才出现记录的状态、纹理、材质、变换、流/索引和 FVF 等命令。原始捕获保留在忽略的构建目录，公开验证记录仅含命令名和摘要，不带桌面/光标等像素。
> - 宿主原生编译实际 D3D8 C 入口，验证重复/同值写入、查询不变、参数校验、局部矩阵组合、零命令发射及退出录制后的普通写入。6/6 语义变异及 ASan/UBSan 通过，上一版 `8c86698` 的实际 C 源码不能通过该检查。120 组客体、17 个 D3D8 标准冒烟 EXE、零售/诊断 D3D8 DLL 和三 API XP T&L 回归通过；已更新 app-local D3D8 DLL。
> - 143 组核心、WebGPU/三精度数学及两项站点集成沿用前两步；宿主 JS 和运行包 `7beb9d03738199295430` 未改变。此步未声称完整原生 D3D8、Wine、游戏或 FPS 验收。验证见 [stage4d2j2a-validation.json](fixtures/d3d-review/stage4d2j2a-validation.json)。依据 Wine 的 [D3D8 状态块测试](https://github.com/wine-mirror/wine/blob/master/dlls/d3d8/tests/stateblock.c) 与 [矩阵录制实现](https://github.com/wine-mirror/wine/blob/master/dlls/wined3d/stateblock.c)。
> - 继续补齐 D3D8 常量、用户平面/调色板等未进入旧快照的状态、着色器句柄生命周期和预定义块范围；D3D9 录制期间的查询隔离、D3D7 稀疏灯光及其余共用运行时仍在后续步骤。


> **阶段 4D2j2b（2026-11-02）：D3D8 状态块补齐常量与用户裁剪平面。**
>
> - 顶点常量 96 个 float4、像素常量 8 个 float4、六个用户平面加入快照及逐项掩码。录制时不改写当前值或发射命令，End 保留记录，Capture 仅更新已有掩码，Apply 恢复对应值。VERTEX/ALL 捕获顶点常量和平面，PIXEL/ALL 捕获像素常量；寄存器按最终写入值恢复。
> - 实际 XP COM 覆盖末尾寄存器、重叠写入、零长度 NULL 写入、越界拒绝、录制期间及 End 后查询不变、Capture 不扩张掩码、未录制寄存器/平面保持新值，以及 VS/PS/ALL 的范围和基线恢复。三 API T&L 与 owner 释放回归通过。
> - 六个 Present 划定原有状态与常量/平面两组边界，两个录制区间都只有 PRESENT；常量组 Apply 实测依次恢复 VS94/95、PS6/7、平面5。独立检查明确给定的寄存器编号、五组 float4 值及平面系数，最大误差 0；同时验证实际捕获的载体边界和命令结构。原始捕获仍在忽略的构建目录，公开记录只有程序数据、命令名和摘要。
> - 宿主原生编译实际 C 入口，增加常量范围、逐项掩码、平面和零命令检查；10/10 语义变异、ASan/UBSan 通过。`8c86698` 和紧邻上一版 `8e2d2cd` 的实际 C 源码均不能通过扩展检查。120 组客体、17 个 D3D8 冒烟 EXE、零售/诊断 DLL 通过并更新 app-local D3D8 DLL。
> - 核心 143 组、WebGPU、三精度数学和站点集成沿用既有结果；宿主 JS、D3D7/9 已发布 DLL 和运行包 `7beb9d03738199295430` 未改变。此步仍不是完整原生 D3D8、Wine、游戏或 FPS 验收。见 [stage4d2j2b-validation.json](fixtures/d3d-review/stage4d2j2b-validation.json)。继续预定义块的其余范围、调色板、着色器句柄生命周期、D3D9 录制查询隔离及 D3D7 稀疏灯光。


> **阶段 4D2j2c（2026-11-02）：D3D8/9 共用预定义状态块范围及完整矩阵保存。**
>
> - 共用一份分版本渲染/纹理/采样器范围表。依据 Wine 的 Windows 测试处理文档分歧：SPECULARENABLE、LOCALVIEWER 和材质来源 RS 保留在顶点类，CCW_STENCILFUNC 只由 ALL/显式录制保存；纹理坐标路由和纹理变换标志同时属于顶点、像素类。D3D9 补齐顶点类的度数/细分状态及 NPatch，频率与 VB 绑定分开捕获，采样器 DMAPOFFSET 状态与其余像素采样状态分开。
> - D3D8 收紧此前过宽的预定义范围；两 API 的材质、平面系数、视口、变换及 VB/IB/纹理绑定仅由 ALL/显式记录保存。**修正 4D2j2b 的范围假设：用户平面不属于预定义顶点块**，对应实现与期望已一起更正。D3D9 增加此前缺失的平面、NPatch 与独立频率录制/恢复。这里只验证有效采样器上的状态保存，不宣称实现位移贴图的 256 号采样槽。
> - D3D8 的预定义灯光键只在创建时选择；后续 Capture 不加入新灯光，未创建的内联灯光也不会因 Apply 被隐式创建。稀疏键分配失败返回 OOM 并释放已持有的引用。两 API 共用合法矩阵编号与密集槽映射，D3D9 从原先的有限矩阵集合扩展为 256 个世界矩阵、view/projection 和八个纹理矩阵，并在 O(1) 时间标记录制槽。
> - 独立参考包含 D3D8 的 38/36、D3D9 的 45/60 项顶点/像素 RS 及 SDK 编号；D3D8 额外的 ZBIAS/阶数项依据 Wine 实现映射，未标作新的原生 Windows 运行结果。宿主直接编译实际范围 C 函数，检查两 API 三种范围、共享纹理状态、采样器类别、资源/材质/平面隔离、已创建灯光和全部 266 个矩阵槽；11/11 语义变异、ASan/UBSan 通过，上一版 `ead272a` 的两份实际 C 源码均失败。
> - 实际 XP D3D8/9 各三类、798 组矩阵查询（共 1,596 组）以及 RS/TSS、对象绑定、材质、平面、后来创建的高/低索引灯光、FVF 的保存/修改/Capture/Apply 检查通过。D3D9 额外验证采样器状态、频率、NPatch，以及仅录制频率时不覆盖后来改绑的 VB。三 API T&L、六帧 D3D8 零提前状态命令及精确常量/平面载荷继续通过，三个 owner 正常释放。
> - 143 组核心、122 组客体、35 个标准冒烟 EXE 和六个严格构建 DLL 通过；已更新 app-local D3D8/9 零售/诊断 DLL。宿主 JS、运行包 `7beb9d03738199295430` 与既有数值内核未改变，GPU/三精度数学和站点集成沿用 4D2i3e，未声明新的像素、FPS 或完整原生/Wine/游戏验收。见 [stage4d2j2c-validation.json](fixtures/d3d-review/stage4d2j2c-validation.json)。
> - 依据：[Wine D3D8 测试](https://github.com/wine-mirror/wine/blob/master/dlls/d3d8/tests/stateblock.c)、[Wine D3D9 测试](https://github.com/wine-mirror/wine/blob/master/dlls/d3d9/tests/stateblock.c)、[ALL 范围](https://learn.microsoft.com/en-us/windows/win32/direct3d9/saving-all-device-states-with-a-stateblock)、[顶点范围](https://learn.microsoft.com/en-us/windows/win32/direct3d9/saving-vertex-states-with-a-stateblock)。继续调色板、着色器生命周期、D3D9 录制查询隔离、D3D7 稀疏灯光与其余共用运行时。

> **阶段 4D2j2d（2026-11-02）：共用稀疏调色板、状态块选择及实际 P8/A8P8 图像完成。**
>
> - D3D8/9 共用两级稀疏存储和 SDK RGBA/线格式 ARGB 转换；编号范围统一为 0..65535，未设置条目隐式为 `0xffffffff`，选择未设置的合法编号也成功。替换原先 D3D8 的 256、D3D9 的 16 份限制，无需为高编号分配中间调色板。新增页面/条目分配失败不发布半成品，实际销毁时释放全部内容。
> - ALL 与显式录制保存当前选择，PIXEL/VERTEX 不保存；调色板颜色内容不随状态块回滚。两 API 的选择录制均延迟生效，期间 Get 查询保持原值，重复和同值调用也保留录制掩码；Capture 只刷新已有掩码。D3D9 其余状态仍采用旧录制路径，本项不代表完整查询隔离已完成。
> - 宿主初始选择统一为 0，修复先上传 P8、后更新默认调色板时未重新着色的问题；Reset 迁移资源和颜色内容后，重新按默认选择展开已有 P8。严格假 GPU 检查默认更新、高编号切换、Reset 重新展开及迁移后再次选择；原生 D3D8/9 Reset 细节仍待独立验收。
> - 两份实际前端 C 的 palette Set/Get/录制函数在宿主直接编译，逐个覆盖 65,536 个编号、SDK 字节/alpha、隐式白色、无效调用输出原子性、两级 OOM、替换复用及完整释放。8/8 语义变异与 ASan/UBSan 通过。XP app-local D3D8、D3D9 COM 检查分别 96/110 秒通过；每个 API 捕获 12 帧、24 次绘制，验证 ALL/显式/Capture/两类排除、录制期间查询及资源内容更新。
> - 冻结捕获只保留逐字节校验的程序化索引、颜色表和四边形；日志/鼠标数据清零。独立期望检查 P8 的调色板 alpha 和 A8P8 的逐像素 alpha。SwiftShader 与 Metal 各检查 24 帧、48 组、80,640 个内部像素，最大字节误差均为 0；3/3 宿主像素语义变异被拦截，原文件逐字节还原。
> - 144 组核心、124 组客体、34 项 WebGPU、35 个标准冒烟 EXE/六个严格 DLL、三 API XP T&L 及 D3D8 六帧零提前命令/精确常量载荷、两项站点集成通过。发布 DLL 与冻结图像捕获中的二进制一致；D3D7 发布 DLL 沿用 4D2j1。运行包更新为 `c3bba1907e73f97e09c3`。见 [stage4d2j2d-validation.json](fixtures/d3d-review/stage4d2j2d-validation.json)。
> - 依据：[D3D9 调色板范围/默认值](https://learn.microsoft.com/en-us/windows/win32/direct3d9/texture-palettes)、[ALL 保存范围](https://learn.microsoft.com/en-us/windows/win32/direct3d9/saving-all-device-states-with-a-stateblock)。D3D8 共用行为是代理兼容契约，未冒充原生 D3D8 新测量；完整原生/Wine/游戏/FPS 验收、D3D8 着色器句柄生命周期、D3D9 其余录制隔离、D3D7 稀疏灯光和后续共用运行时继续推进。

> **阶段 4D2j2e（2026-11-02）：D3D8 着色器句柄与状态块对象生命周期完成。**
>
> - 着色器的公共句柄与内部状态引用分开：Delete 立即使公共 Set/Delete/GetFunction 拒绝旧句柄，已捕获/录制的对象及配套顶点声明仍由状态块保活。Apply 通过内部绑定恢复该对象；删除状态块后，当前绑定继续持有它，最后一次解绑或 Capture 替换才发送最终销毁。引用替换先获取新引用，避免相同对象 Capture 的提前释放；销毁从设备链表移除对象。
> - 预定义捕获、显式录制、Capture、Apply、状态块删除、设备绑定清理/退出均接入同一引用逻辑。删除当前对象时，常规路径解绑；录制期间的解绑写入录制块，公共句柄立即失效，实时查询仍保持原绑定。绑定发送失败不替换客体原引用。这里依据 Wine 的对象/状态块实现建立兼容契约，尚无原生 Microsoft D3D8 新测量。
> - XP 新用例暴露 `SetVertexShader(0)` 原本在 FVF 展开时失败；现按空声明发出 FVF 0，确保恢复/最后解绑成功。移除相应旧源码正则断言，改用实际 C 调用链检查 shader-null 与空 FVF 的命令顺序；其余现有协议检查保留。
> - 宿主编译实际前端函数，检查 VS/PS 的旧句柄失败、记录重复写入、实时查询隔离、内部恢复、相同引用替换、资源内容查询、绑定持有、录制期间删除、传输失败原子性、shader/声明恰好销毁及完整内存释放。7/7 故障变异和 ASan/UBSan 通过。
> - 实际 XP 三 API T&L 与新增 VS/PS 生命周期用例通过；D3D8 六帧零提前状态命令和精确常量/平面载荷仍通过。原始命令流另检查六个 VS、六个 PS 和六个配套声明：每次绑定均引用尚存对象，销毁晚于最后绑定、不会销毁当前绑定或重复销毁；D3D9 的额外声明按 owner 隔离。
> - 核心 144 组、客体 126 组、D3D8 17 个标准冒烟 EXE 与零售/诊断两份严格 DLL 通过，更新已测试的 app-local D3D8 DLL。D3D9/7 发布 DLL、宿主 JS 和 `c3bba1907e73f97e09c3` 运行包未改变；WebGPU 34 项、SwiftShader/Metal 图像与两项站点集成沿用 4D2j2d，本阶段未新宣称 GPU 图像、原生/Wine/游戏/FPS 验收。见 [stage4d2j2e-validation.json](fixtures/d3d-review/stage4d2j2e-validation.json)。
> - 依据：[Wine D3D8 设备句柄删除/内部状态绑定](https://github.com/wine-mirror/wine/blob/master/dlls/d3d8/device.c)、[Wine shader 父对象延迟销毁](https://github.com/wine-mirror/wine/blob/master/dlls/d3d8/shader.c)。接着补齐 D3D9 全部录制查询隔离、D3D7 稀疏灯光及其余共用运行时。

> **阶段 4D2j2f1（2026-11-02）：D3D9 普通状态、矩阵和常量改为延迟录制。**
>
> - RS/TSS/采样器、视口、材质、用户平面、剪裁矩形、NPatch、独立流频率及 VS/PS 的 float/int/BOOL 六组常量在写入录制块后返回，不改实时影子或提前发送状态命令；同值/重复/覆盖写入保留掩码，BOOL 归一化。End 对这些已延迟字段保留录制值，公共 Capture 仍刷新原有掩码；流绑定的旧捕获路径不会覆盖独立录制的频率。
> - MultiplyTransform 从本次录制里最近的矩阵继续运算，Get 始终返回实时矩阵。D3D9 Set/Get/Multiply 共用 266 个合法 SDK 变换编号的映射，拒绝保留编号并保持失败查询输出不变。
> - 宿主直接编译实际 C Setter/Get/helper，检查 266 个矩阵与连续乘法、普通状态与结构体查询、常量尾部/覆盖/越界、BOOL、无效调用原子性和零提前发送。10/10 语义变异、ASan/UBSan 通过；上一版实际 C `f163c0f` 在实时查询断言失败。
> - 实际 XP 三 API T&L 和新 D3D9 用例通过，覆盖 Begin 期间 Get、End 保持原值、Apply 最终值及 Capture 掩码不扩展。四帧 D3D9 命令检查确认录制间隔只有 Present 及其例行光标位置更新，没有状态命令；Apply 的矩阵、RS/TSS/采样器、视口/材质/平面/剪裁/频率和六组常量载荷符合独立值。第一次后处理将 Present 的光标更新误当状态，已在同一原始捕获上修正检查并全部重验，未修改捕获。D3D8 六帧与 12 个 shader/六个声明的生命周期检查继续通过。
> - 144 组核心、128 组客体、D3D9 14 个标准冒烟 EXE 及零售/诊断两份严格 DLL 通过，更新本次 XP 所测 D3D9 零售 DLL。宿主 JS、运行包、D3D8/7 发布 DLL 未改变；GPU/Metal/站点集成沿用 4D2j2d，本步没有新的像素或原生/Wine/游戏/FPS 验收。见 [stage4d2j2f1-validation.json](fixtures/d3d-review/stage4d2j2f1-validation.json)。
> - **尚未宣称完整 D3D9 隔离：** 对象绑定、灯光仍由旧路径临时改变实时状态，End 的基线恢复尚在；下一步完成这些路径后移除基线恢复。D3D7 稀疏灯光及其余共用运行时继续随后推进。

> **阶段 4D2j2f2（2026-11-02）：D3D9 对象/灯光延迟录制，移除 Begin/End 基线回放。**
>
> - VB/IB、2D/cube/volume 纹理、VS/PS、声明/FVF 以及低/高编号灯光都直接写入录制块。对象先获取新引用再释放旧引用，同值重复写入和纹理种类切换只保留最终的一份引用；所有 Get 继续读取实时设备。独立频率和绑定掩码保持分离。
> - 灯光属性与启用掩码分开；录制未知灯光的 LightEnable 创建块内默认属性，不创建实时节点，之后显式 SetLight/Enable 保留调用顺序。低编号也遵守相同规则。分配失败保持实时状态与已录制内容完整。
> - Begin 只分配一份未完成块，End 直接交出它，不再复制实时状态或回放整份基线；无效 End 输出保留正在录制的块。移除上一阶段的 End 特殊字段保留逻辑。最后一个公共设备引用释放时，先释放无法由应用取回的未完成录制及其对象引用，再清理实时绑定，避免隐藏块保活设备。
> - 宿主编译实际对象/灯光 Setter/Get、Begin/End 和引用释放函数，验证实时查询、精确引用、VB 偏移/纹理种类/声明-FVF 替换、稀疏默认灯光、OOM、无效 End 保留及全部引用释放。11/11 故障变异、ASan/UBSan 通过；既有普通状态、矩阵、六组常量及预定义范围回归继续通过。
> - 实际 XP 三 API T&L 通过；D3D9 对象检查验证应用 Release 后每项恰好留一份块引用、Apply 后绑定持有对象、重复 Capture、未知灯光隔离及设备释放时的未完成录制清理。D3D9 八帧原始命令分别核对普通状态和对象两组：录制期间和 End 期间均只有 Present/窗口/光标辅助命令；仅 Apply 发送状态。精确核对缓冲偏移、三类纹理、VS/PS/声明、已知/默认高编号灯光及六组常量载荷。D3D8 六帧与六 VS/六 PS/六声明检查仍通过。
> - 原始捕获的后处理按 owner 区分 D3D8 句柄生命周期契约与 D3D9 设备退出的对象清理，未改写捕获数据。核心 144 组、客体 130 组、D3D9 14 个标准冒烟 EXE 及零售/诊断两份严格 DLL 通过；更新实际 XP 所测 D3D9 DLL。宿主/运行包与 D3D8/7 DLL 未变，GPU/Metal/站点集成沿用 4D2j2d，未新宣称原生/Wine/游戏/FPS 验收。见 [stage4d2j2f2-validation.json](fixtures/d3d-review/stage4d2j2f2-validation.json)。
> - 现有状态块覆盖的 D3D9 入口已完成延迟录制；继续 D3D7 稀疏灯光、三版本的启用查询返回值/未创建语义，以及其余默认值/caps/格式/窗口共用运行时和后续阶段。

> **阶段 4D2j3a（2026-11-02）：D3D7/8/9 共用 LightEnable 查询契约完成。**
>
> - 三版本共用一个查询函数：已创建且启用返回 `0x80`，禁用返回 0；未创建或空输出指针返回失败，不改调用者输出。D3D8/9 同时区分已分配但尚未设置的稀疏节点，修复此前把不存在灯光当作禁用成功，以及把启用结果返回 1 的行为。内部启用标志、线协议和光照计算仍用普通布尔值。
> - 依据本机原生 Microsoft D3D7 RGB 的既有 35 条冻结查询及 Wine D3D8/9 的 Windows 状态块期望；实际 C GetLightEnable 在三套私有结构下编译，检查已知/未知低编号、D3D8/9 的高编号和最大 DWORD、分配但未设置节点、非标准 BOOL 输入、空指针及失败输出保留。6/6 语义变异和 ASan/UBSan 通过。
> - 实际 XP 三 API 新增原始 BOOL 检查，确认未创建失败、SetLight 后默认禁用、非零输入启用后精确返回 128、再禁用返回 0。三 API T&L、D3D8 六帧/着色器生命周期、D3D9 八帧录制与 End 零状态回放、精确 Apply 载荷和未完成录制释放继续通过，三个 owner 正常释放。
> - 144 组核心、132 组客体、35 个标准冒烟 EXE、六份严格零售/诊断 DLL 通过，发布三版本本次 XP 所测 DLL。宿主 JS、`c3bba1907e73f97e09c3` 运行包、数值内核未变，WebGPU/Metal/站点集成沿用 4D2j2d，本项不代表完整原生/Wine/游戏/FPS 验收。见 [stage4d2j3a-validation.json](fixtures/d3d-review/stage4d2j3a-validation.json)。
> - 参考：[D3D8 Windows 灯光期望](https://github.com/wine-mirror/wine/blob/master/dlls/d3d8/tests/stateblock.c)、[D3D9 Windows 灯光期望](https://github.com/wine-mirror/wine/blob/master/dlls/d3d9/tests/stateblock.c)、[原生 D3D7 冻结查询](../tests/glbridge/fixtures/d3d7_native_light_state.json)。D3D7 的存储仍限于旧的低编号表，下一步测量原生录制/捕获行为后接入稀疏存储与默认创建，再继续其余运行时工作。

> **阶段 4D2j3b（2026-11-02）：原生 D3D7 灯光录制参考、共用稀疏存储与高编号 T&L 完成。**
>
> - 新增原生系统 Microsoft D3D7 RGB 的 19 条查询参考，分别测量录制期间/End/Apply、已知与未创建灯光、仅启用录制、VERTEX/ALL 后续 Capture 的键集合。原生与 app-local 代理使用同一个程序，代理逐字段、HRESULT、BOOL 和 26 个 SDK 字比较全部一致；原生运行无 D9WG owner/命令；工具与日志位于 RAM 工具盘，基础 XP 镜像不写入。
> - 原生结果确认 D3D7 灯光 Set/Enable 延迟生效，End 保留实时值；**D3D7 VERTEX 只保存启用状态，ALL 才保存属性**，Capture 不扩展到创建块后出现的灯光。该版本差异单独保留，未套用 D3D8/9 的灯光属性范围。仅录制启用不覆盖之后修改的属性；录制未知灯光的禁用调用也在 Apply 时创建默认灯光。
> - D3D7 接入 `d9wg_light_state.h` 的稀疏 DWORD 索引、SDK 默认值和启用查询；保留低编号快速表。Set/Get、LightEnable、灯光录制/Capture/Apply、块/设备销毁及软件光照使用该存储；支持高编号和最大 DWORD，无需按最大编号分配数组。新增 OOM 返回及创建失败清理，启用数预算仍为 caps 的八个，未提高同时活动灯光能力。
> - 宿主编译实际 D3D7 light/emitter/capture/End/T&L 函数，重放既有 35 条原生查询，检查精确 SDK 字、原始 BOOL、默认创建、录制隔离、固定键与原生 VERTEX/ALL 灯光掩码、最大索引、OOM、稀疏软件光照及活动预算；8/8 语义变异与 ASan/UBSan 通过。三版本共用启用查询测试现在也覆盖 D3D7 高编号。
> - 三 API 实际 XP T&L 通过，D3D7 主计算改为使用 37 号灯光，验证方向/点/聚光、雾、混合和坐标路径；三版本共享灯光 API 检查均通过，并按 D3D7 原生范围区分 VERTEX 属性行为。D3D8 六帧与 shader 生命周期、D3D9 八帧/零提前状态与 End 回放、精确 Apply 载荷和未完成录制释放继续通过。
> - 144 组核心、134 组客体、DDraw 四个标准冒烟 EXE 与零售/诊断两份严格 DLL 通过；发布本次 T&L 所测 DDraw DLL。宿主、运行包及 D3D8/9 发布 DLL 未变，GPU/Metal/站点集成沿用 4D2j2d，未新宣称原生硬件/完整 Wine/游戏/FPS 验收。见 [stage4d2j3b-validation.json](fixtures/d3d-review/stage4d2j3b-validation.json) 与 [原生灯光录制参考](../tests/glbridge/fixtures/d3d7_native_light_recording.json)。
> - 此步只将 D3D7 的灯光入口改为延迟录制，其他旧 D3D7 状态仍会临时更改实时值；继续测量并补齐其录制、预定义范围及剩余共用运行时。原生 RGB 的活动灯光上限与代理 caps 不同，未当作一致性结果。

> **阶段 4D2j3c（2026-11-02）：D3D7 普通状态延迟录制及原生范围对照完成。**
>
> - 新增原生 Microsoft RGB 状态块探针，在只读 XP 基盘和 RAM 工具盘上冻结 170 条查询，覆盖 ALL/PIXEL/VERTEX 的 Apply/Capture、Begin/End 实时查询、显式录制的 Apply 与再次 Capture。原生运行 111 秒、零代理 owner/命令；同一探针使用代理运行 94 秒，170 条 SDK 字节结果全部相同。
> - 矩阵、视口、材质、六个裁剪平面、纹理绑定、渲染状态和 TSS 在 Begin 内只写块的值与掩码；End 只发布录制结果，删除旧的实时状态捕获。Multiply 使用之前录制的矩阵，纹理替换先加新引用再释放旧引用，录制期间不准备或上传表面。
> - 按此次测量修正范围：矩阵/视口/材质/平面系数/纹理绑定只属于 ALL；TEXCOORDINDEX 与 TEXTURETRANSFORMFLAGS 同属 PIXEL/VERTEX；CULL、SPECULARENABLE、LIGHTING、FOGENABLE 属于 VERTEX，SHADEMODE 属于两者。沿用上一阶段测得的 D3D7 灯光版本差异；尚未把六个渲染状态的结果外推为完整分类表。
> - 宿主原生编译实际 C 方法，独立使用 MinGW SDK 枚举和冻结查询验证 170 条结果，并检查零提前命令/上传、重复纹理绑定引用、连续 Multiply、无效过滤值以及 Wrap 调用顺序；11/11 普通状态语义变异与既有 8/8 灯光变异、ASan/UBSan 通过。
> - 144 组核心、136 组客体、DDraw 四个冒烟 EXE 和零售/诊断严格 DLL，以及 XP 三版本 T&L/录制载荷回归通过；发布本次 XP 所测 DDraw DLL。宿主及运行包未变，GPU/Metal/站点集成沿用 4D2j2d。见 [stage4d2j3c-validation.json](fixtures/d3d-review/stage4d2j3c-validation.json) 与 [170 条原生参考](../tests/glbridge/fixtures/d3d7_native_state_blocks.json)。
> - 继续核对完整 D3D7 预定义状态表、旧式 RS/TSS 别名与交错顺序；本次不宣称完整 Wine、游戏/FPS 或阶段 4 验收完成。

> **阶段 4D2j3d（2026-11-02）：D3D7 完整预定义状态范围与旧接口版本隔离完成。**
>
> - 原生 Microsoft RGB 探针逐个测量 113 个 RS 编号（2–152 内的 SDK 编号）和 24 个 TSS 的 ALL/PIXEL/VERTEX/显式录制，冻结 548 条调用/查询/End/Apply 结果；另测 504 条旧 RS 与 TSS 交错查询，共 1,052 条。最终原生采集 126 秒，零代理 owner/命令；代理运行逐条比较完整状态字和 HRESULT。
> - PIXEL 的 41 个 RS、VERTEX 的 24 个 RS 采用各自明确范围，SHADEMODE 与 FOGSTART/END/DENSITY 同属两者，ALL 保存并集 61 个。FOGCOLOR、FOGTABLEMODE、RANGEFOGENABLE、CLIPPING、EXTENTS 等修正到 VERTEX；ZVISIBLE/FLUSHBATCH 可查询且可显式录制，所有预定义块均不保存。24 个 TSS 全属于 PIXEL，只有坐标编号/变换标志同时属于 VERTEX。
> - D3D7 公开 RS 入口与 D3D1–3 的内部旧状态引擎分开；旧接口继续支持纹理过滤/寻址/混合及 Wrap 别名。D3D7 拒绝测得的旧编号且查询不改输出，不再把旧 RS 当作有效 TSS 别名。原生还显示：普通调用会缓存被拒绝的旧值，再次设置相同值可以无操作返回成功；Begin 内既不查询也不修改此缓存。代理按该零售行为处理，失败/重复调用均不发送状态。
> - 实际 C 回归现在重放此前 170 条普通状态和新增 1,052 条完整结果，额外调用实际旧接口 Set/Get 检查版本隔离与无副作用。19/19 普通状态语义变异、8/8 灯光变异及 ASan/UBSan 通过；回归不从代理自身生成期望值。
> - 144 组核心、136 组客体、DDraw 四个冒烟 EXE、零售/诊断严格 DLL、最终 XP 三 API T&L 与录制载荷验证通过；发布最终 T&L 所测 DDraw DLL。宿主/运行包不变，GPU/Metal/站点集成沿用 4D2j2d。见 [stage4d2j3d-validation.json](fixtures/d3d-review/stage4d2j3d-validation.json) 和 [原生范围参考](../tests/glbridge/fixtures/d3d7_native_state_scope.json)。
> - 此探针不覆盖非零旧纹理句柄资源生命周期；后续继续共用 T&L 的 Tween/可编程处理、默认值/caps、包装层与 Wine/游戏验收，未宣称阶段 4 完成。

> **阶段 4D2k1（2026-11-02）：共用 CPU Tween 与 D3D9 ProcessVertices 接入完成。**
>
> - 共用声明布局保存 POSITION1/NORMAL1 的独立类型与偏移；支持任一第二通道，继续使用已有 17 种声明解码和多流/零步长收集。重复第二通道拒绝，缺少两种第二通道时在写输出之前失败。
> - 共用混合上下文新增 Tween 模式和浮点因子，按 `p0*(1-t)+p1*t` 插值位置/法线，再进行世界/视图/投影、逆转置法线、可选归一化、光照、雾、纹理坐标生成及世界空间用户平面。Tween 不读取矩阵索引；因子从 RS170 读取且不作软件夹取。语义依据 [Microsoft Vertex Tweening](https://learn.microsoft.com/en-us/windows/win32/direct3d9/vertex-tweening) 与 [使用说明](https://learn.microsoft.com/en-us/windows/win32/direct3d9/using-vertex-tweening)。
> - 10 万组独立解析公式检查含负值/大于 1 的因子、对象/世界/视图/裁剪坐标和非均匀法线变换；实际 CPU 全管线检查光照/归一化/雾/坐标/平面、单个第二通道、半浮点/归一化整数属性、多流/常量流、UINT_MAX 常量索引、失败原子性和 ClipStatus。实际 Windows 适配函数也由宿主 C 检查 RS170 与临时内存释放；10/10 Tween 与既有 6/6 混合变异、ASan/UBSan 通过。
> - XP 三版本 T&L/录制回归 115 秒通过，新增 D3D9 公开 COM 检查精确位置/颜色/雾/坐标、单通道、归一化、状态块因子、用户平面 ClipStatus 和错误路径保持目标数据；三 owner 全部释放，原有六/八帧录制载荷和着色器生命周期检查继续通过。
> - 144 组核心、138 组客体、35 个冒烟 EXE 与六份严格 DLL 通过。四份既有数值参考只刷新源码哈希，所有数值 case 与提交前完全相同。发布本次 XP 所测三份零售 DLL及对应诊断 DLL；宿主/GPU 包未变，既有 GPU/Metal/站点验收沿用 4D2j2d。见 [stage4d2k1-validation.json](fixtures/d3d-review/stage4d2k1-validation.json)。
> - 当前完成共用 CPU 核和 D3D9 ProcessVertices；D3D8 声明输入、宿主 Tween 绘制/真 GPU 对照与能力声明接着完成，TWEENING caps 本步保持未宣称。可编程 CPU 顶点处理及整个阶段 4 继续执行。

> **阶段 4D2k2（2026-11-02）：宿主 Tween 绘制、真实 GPU 对照与 D3D9 能力声明完成。**
>
> - 宿主 FFP 解析 POSITION1/NORMAL1；Tween 与矩阵权重混合复用两个互斥输入位置，保持原有顶点属性预算。第二通道使用既有 17 种输入转换，可分别存在；只有 NORMAL1 时以零主法线插值。对象空间插值后复用世界矩阵、逆转置法线、视图空间光照/雾/坐标生成及世界空间用户平面。
> - 因子使用独立 uniform，不加入 shader/pipeline key。公开命令回归确认因子改变复用原 shader/pipeline；缺少第二位置和第二法线时拒绝该 draw，不再静默画出 world0 的形状。屏幕坐标输入继续绕过顶点变换。
> - 新增 50 个真实 GPU 场景：负/零/中间/大于 1 的因子、独立位置/法线、只有第二法线、17 种第二属性格式、禁用路径、世界空间裁剪、多流及常量第二流。期望来自独立仿射/法线/漫反射/雾/平面方程和预处理顶点，不调用生产 CPU 或 shader 辅助函数。SwiftShader/Metal 各比较 204,800 对像素，50/50 通过且实际最大误差 0，所有场景有可见覆盖；3/3 GPU 位置/法线/因子变异被像素差异检出，源码逐字恢复。
> - D3D9 的工厂和设备 caps 现在宣称 TWEENING；新增 XP 公开查询并重跑三版本 T&L/录制/生命周期检查。D3D8 的声明式 CPU 输入仍待接入，故其 caps 保持未宣称该特性。
> - 145 组核心、138 组客体、完整 35 次 WebGPU 回归（适配器及 34 页）、两项站点集成、D3D9 十四个 SDK 冒烟 EXE/严格零售诊断 DLL，以及 XP 三 API 检查通过。发布本次 XP 所测 D3D9 DLL，并同步运行包 `dffb0322a62fa650c089`。见 [stage4d2k2-validation.json](fixtures/d3d-review/stage4d2k2-validation.json)。
> - 接着完成 D3D8 声明输入及其 Tween 接入，再推进可编程 CPU 顶点处理和其余共用核心。此步未宣称原生 Microsoft D3D8/9、完整 Wine 或游戏/FPS 验收完成。

> **阶段 4D2k3a（2026-11-02）：D3D8 固定管线声明对象与生命周期完成。**
>
> - `CreateVertexShader(declaration, NULL, …)` 现在创建固定管线声明对象；空函数合法，实际字节码仍走已有版本/指令校验。构造时一次解析并缓存元素、常量和原 SDK token；不创建空 shader 资源，绑定声明后发送零 VS 句柄，销毁时只释放真实声明资源。Reset 使用同一缓存发射入口。
> - GetDeclaration 保留原始 SDK token 与 END；固定声明的 GetFunction 返回零长度并不写调用者数据。对象仍使用现有公开句柄失效、实时绑定/状态块持有引用、延迟录制、重复 Capture 和最后解绑释放规则。补上 SDK NORMAL2（寄存器 16）到 NORMAL1 的映射；固定管线主法线要求 FLOAT3，声明常量不能越过 c95。NULL 函数行为对照 [原 Microsoft D3D8 SDK](https://alpyne.me/archive/dx8/directx_cpp/graphics/reference/cpp/d3d/interfaces/idirect3ddevice8/createvertexshader.htm)，主法线校验对照 [Wine 的声明初始化](https://github.com/wine-mirror/wine/blob/master/dlls/d3d8/shader.c)。
> - 宿主编译实际创建/声明解析/发射/绑定/查询/删除/引用函数，检查公开输入、独立 SDK 元素、空代码无资源、录制隔离、删除后应用、常量、校验及每项分配失败的原子清理。9/9 声明语义变异、原有 7/7 shader 生命周期变异和 ASan/UBSan 通过。
> - XP 三 API T&L/录制检查 111 秒通过，新增 D3D8 NULL 函数创建、精确 token/空代码查询、公开句柄与状态块保活、常量和无效法线校验。原始命令流确认六 VS/六 PS 保持原样，额外三个固定声明均以零 VS 绑定，无虚构 shader 创建/销毁；九个声明最终各销毁一次，三个 owner 正常退出。
> - 145 组核心、140 组客体、D3D8 十七个 SDK 冒烟 EXE 与严格零售/诊断 DLL 通过；发布本次 XP 所测 D3D8 DLL。宿主运行包不变，35 次 WebGPU、Tween 的 SwiftShader/Metal 和两项站点集成沿用 4D2k2。见 [stage4d2k3a-validation.json](fixtures/d3d-review/stage4d2k3a-validation.json)。
> - 当前补齐创建/绑定/查询/保活边界；接着把 D3D8 声明输入接到共用多流 CPU 处理与 ClipStatus/Tween。其 TWEENING caps 仍未宣称；不以代理 COM 检查替代原生 Microsoft D3D8 验收。

> **阶段 4D2k3b（2026-11-03）：D3D8 声明式多流 CPU 处理与 Tween 接入完成。**
>
> - D3D8 的固定管线声明和 FVF 转成共用流描述，引用创建时缓存的元素；可从任意声明流读取主位置，不再要求流 0 绑定。复用共用布局/范围/收集/处理函数，支持多流和零步长；已删除但被状态块保活的声明从绑定引用读取，实际程序 shader 继续拒绝 CPU 固定管线替代。
> - 逐个使用的流检查设备归属、锁定和完整属性范围；常量流不计算 `start*stride`，可处理 UINT_MAX 索引。所有与输出相同的输入流共用一份调用前快照；任一布局/范围/分配失败均清理临时内存并保持输出数据。已有单流 FVF 路径继续使用连续输入。
> - 实际 C 入口适配检查 FVF/保活声明、主流 15、常量流、UINT_MAX、所有权/锁/短范围、多个别名共用快照和每层分配失败；8/8 输入语义变异及 ASan/UBSan 通过。共用 Tween 数学仍由 4D2k1 的独立公式和 4D2k2 的真实 GPU 像素覆盖。
> - XP 三 API 回归通过；D3D8 新增实际声明式 ProcessVertices，用流 15 保存主位置/法线、流 1 保存常量第二通道，且流 0 未绑定。精确验证 Tween 位置/颜色/雾/坐标、归一化、独立第二通道、延迟因子录制、用户平面 ClipStatus、输出别名和失败原子性。原始流核对新增七个固定声明及其精确流/语义布局；六 VS/六 PS 不变，十三个声明全部释放。
> - 145 组核心、142 组客体、D3D8 十七个 SDK 冒烟 EXE与严格零售/诊断 DLL 通过；发布最终 XP 所测 D3D8 DLL。宿主包保持 `dffb0322a62fa650c089`，GPU/Metal/站点集成沿用 4D2k2。见 [stage4d2k3b-validation.json](fixtures/d3d-review/stage4d2k3b-validation.json)。
> - 下一步完成 D3D8 普通声明绘制的范围/ClipStatus 与客体像素回放，再开启其 Tween caps；本步仍未宣称该能力或原生 Microsoft D3D8/Wine/游戏验收完成。

> **阶段 4D2k3c（2026-11-03）：D3D8 普通声明绘制范围与 ClipStatus 完成。**
>
> - 普通/索引绘制按缓存声明或 FVF 计算实际使用的流和属性末端，逐流复用共用范围函数验证设备归属、锁定、常量步长与完整属性字节；最后一个顶点不再要求无用的步长尾部填充。主位置可在流 15，流 0 可未绑定；已删除但绑定保活的声明继续有效，程序声明无需固定 POSITION0 也可绘制。
> - 软件处理设备的声明绘制复用共用多流 ClipStatus 与 Tween/世界用户平面计算；索引路径按整个声明范围分类，包括未引用顶点，并验证实际索引。成功计算可恢复此前因程序 shader 不可得的状态；范围、分配和传输失败保留原状态。固定管线 FVF 与预变换 VB 的既有裁剪记录路径继续保留。
> - 按 [DirectX 8.1 DrawPrimitiveUP 文档](https://alpyne.me/archive/dx8/directx_cpp/graphics/reference/cpp/d3d/interfaces/idirect3ddevice8/drawprimitiveup.htm) 拒绝引用非零流的 UP 声明，并检查流 0 属性范围；成功 UP 的流/索引解绑语义不变。普通声明绘制先于流 0 的裁剪记录访问判断 shader 类型，避免未绑定流 0 时解引用空指针。
> - 实际 C 绘制入口与共用数学联合验证多流/常量/保活声明、逐流范围/归属/锁、索引基址/未引用顶点、Tween/用户平面状态、UP 限制、失败原子性及 FVF 兼容；11/11 语义变异和 ASan/UBSan 通过。XP 三 API 回归新增声明式普通/索引绘制及拒绝路径检查，保持既有 6/8 Present 屏障和着色器生命周期计数。
> - 145 组核心、144 组客体、D3D8 十七个 SDK 冒烟 EXE 和严格零售/诊断 DLL 通过；发布 XP 所测 D3D8 DLL。宿主包保持 `dffb0322a62fa650c089`，GPU/Metal/站点集成沿用 4D2k2。见 [stage4d2k3c-validation.json](fixtures/d3d-review/stage4d2k3c-validation.json)。
> - 下一步用实际 D3D8 客体捕获完成 Tween 普通绘制/ProcessVertices 的像素回放验收，再开启其 Tween caps；尚未宣称原生 Microsoft D3D8/Wine/游戏验收完成。

> **阶段 4D2k3d（2026-11-03）：D3D8 Tween 客体像素验收与能力声明完成。**
>
> - 新增实际 SDK COM 客体程序，以主流 15、第二通道流 1 和 NULL 函数声明绘制，再以同一输入执行 ProcessVertices 后绘制，捕获 16 帧；八组覆盖 .25/.75 因子、独立第二位置/法线、无主法线、索引基址、常量第二流、世界用户平面和插值后归一化。每个原始绘制都不绑定流 0。
> - 冻结工具独立计算几何、方向光颜色、线性雾和裁剪多边形，逐字节检查原始 VB/IB 和八次 CPU 输出，再检查裁剪后提交的三角形；包含被裁顶点的原生存储规则，未调用生产顶点/着色器函数。仅保留已检查的过程数据，诊断/光标内容清零。常规核心测试核对四种精确声明、16 帧状态/基址/流范围以及固定数学锚点。
> - 最终客体捕获在 SwiftShader 和 Metal 上各比较 32,768 个像素对，并核对八个独立颜色探针；法线归一化一组最大误差为 1 字节/通道，其余七组完全一致，每组至少 552 个覆盖像素。无 WebGPU/宿主错误、命令失败或丢弃绘制；不放宽既有误差要求。五项仅修改回放输入的因子、主流步长、索引基址、用户平面与归一化变异均触发像素失败，随后精确还原冻结文件。
> - 在首轮两种后端像素通过后开启 D3D8 的 `D3DVTXPCAPS_TWEENING`；最终重新构建/捕获验证工厂与设备查询均包含该能力，发布这一最终 XP 所测 DLL。D3D8 CPU 与 GPU Tween 均已验收，程序 VS 的 CPU 执行仍未实现。
> - 146 组核心、144 组客体、18 个 D3D8 SDK 冒烟 EXE 与零售/诊断 DLL 通过；完整 WebGPU 验收扩为 36 次运行。宿主包保持 `dffb0322a62fa650c089`。见 [stage4d2k3d-validation.json](fixtures/d3d-review/stage4d2k3d-validation.json)。
> - 本步关闭 D3D8 Tween 能力缺口，继续阶段 4 的共用核心/默认状态/运行时 caps 与包装层工作；未宣称原生 Microsoft D3D8、Wine/游戏或 FPS 验收完成。

> **阶段 4E1（2026-11-03）：D3D8/9 与宿主的共用渲染状态默认表完成。**
>
> - `d9wg_state.js` 维护唯一的版本化渲染状态表，生成 SDK 无关的 `d9wg_state_defaults.h`；两个客体初始化/Reset 与宿主新建/Reset 都从此表取值。补齐 D3D8 的 FILLMODE、LASTPIXEL、CLIPPING、点大小/衰减、MULTISAMPLEANTIALIAS/MASK、BLENDOP 和补丁阶数，补齐 D3D9 的补丁阶数与自适应细分默认值。生成器与常规测试检查头文件漂移。
> - ZENABLE 根据创建/Reset 的 EnableAutoDepthStencil 决定，之后绑定深度表面不会自动改变它；POINTSIZE_MAX 根据实际报告的 MaxPointSize，0/1 使用软件默认 64。D3D8 的 POINTSIZE_MIN 保留 0，D3D9 为 1；共用桥只同步有版本或能力差异的两项，范围/失败行为有实际 C 检查。宿主诊断现在读取包含默认值的有效状态。
> - 冻结独立的 [Wine D3D8](https://github.com/wine-mirror/wine/blob/master/dlls/d3d8/tests/stateblock.c)/[D3D9](https://github.com/wine-mirror/wine/blob/master/dlls/d3d9/tests/stateblock.c) 默认值事实及原始源码 SHA，保留自动深度和点上限上下文；另以 DirectX 8.1/9 SDK 核对点大小和补丁默认值。实际 C/JS 对照 1,002 个上下文组合参考值，覆盖头文件生成、设备隔离、宿主创建/Reset、零冗余补丁及两次传输失败；9/9 C 语义变异、两种畸形同步流和 ASan/UBSan 通过。
> - 实际 XP 公开 COM 完成 688 次精确 GetRenderState 查询，覆盖新建、ALL 块恢复及关闭→开启→关闭自动深度的两次 Reset；原始图形流核对 D3D8 三次 POINTSIZE_MIN 初始化补丁与两 API 的创建参数。三 API T&L/录制/着色器生命周期回归通过，分别 2/3 个 owner 正常释放。发布默认值探针所测的两个零售 DLL；T&L 使用同源码的独立构建，不将时间戳不同的 PE 文件当作相同字节。
> - 148 组核心、144 组客体、32 个 D3D8/9 SDK 冒烟 EXE 与四个严格零售/诊断 DLL、两项站点集成通过；完整 WebGPU 36 次运行通过。新增两组“后绑定深度表面”的独立像素用例，SwiftShader/Metal 均通过全部 331 个用例；忽略创建深度参数的 GPU 变异只使新增关闭场景失败，源码已精确还原。
> - 新宿主包 `cfad0009655b0a109c05` 已同步到站点。见 [stage4e1-validation.json](fixtures/d3d-review/stage4e1-validation.json)。本步统一已核对的渲染默认值；纹理阶段、采样器、材料及其他对象/模式默认值接着处理，运行时 caps、窗口/格式和包装层仍待继续；不是原生 Microsoft D3D8/9、Wine 全套或游戏/FPS 验收。

> **阶段 4E2（2026-11-03）：共用纹理阶段与采样器默认表完成。**
>
> - 在同一宿主状态模块维护纹理阶段/采样器默认值及 D3D8 的十项采样状态映射，生成两个客体使用的 C 查询函数；取代三处手写初始化。覆盖八个纹理阶段、十六个像素和四个顶点采样器，保留各阶段的 TEXCOORDINDEX、首阶段/后续阶段操作差异与版本专属 CONSTANT；未知旧状态的既有零值不扩展为新能力。
> - 修正 D3D8 ADDRESSW、COLORARG0、ALPHAARG0 缺项。后两者默认 CURRENT=1，应用首次设置 DIFFUSE=0 时必须发送命令；实际 C Setter 检查默认相等时省略、首次零值写入、采样状态编号转换和录制隔离。生成器验证状态号、版本映射与重复项。
> - 独立 [DirectX 8.1 纹理阶段](https://alpyne.me/archive/dx8/directx_cpp/graphics/reference/cpp/d3d/enums/d3dtexturestagestatetype.htm)、[D3D9 纹理阶段](https://learn.microsoft.com/en-us/windows/win32/direct3d9/d3dtexturestagestatetype)及[采样器](https://learn.microsoft.com/en-us/windows/win32/direct3d9/d3dsamplerstatetype)事实，验证 620 项 C/JS 默认值与设备隔离；9/9 C 语义变异、ASan/UBSan 通过。SDK 未明确 CONSTANT 初值，零值来自 Wine 清零/默认初始化路径的推断，未当作原生 Windows 测量。
> - 实际 XP 新增 2,480 次纹理/采样器公开查询，覆盖新建、ALL 恢复和两次 Reset，既有 688 次渲染查询继续通过。原始图形流在两 API 各核对三次首次零值颜色/透明度更新，以及阶段 7/最后一个顶点采样器的 W 寻址更新。三 API T&L/录制/生命周期回归通过，所有 owner 释放；发布默认值探针所测的两个零售 DLL。
> - 新增三元颜色/透明度运算的独立像素探针，分别验证默认 CURRENT 与首次显式 DIFFUSE 的精确 RGBA。SwiftShader/Metal 全部 333 个用例通过；两个宿主默认值变异均使默认 CURRENT 探针失败，显式 DIFFUSE 保持通过，随后精确恢复源码。
> - 150 组核心、144 组客体、32 个 SDK 冒烟 EXE、四个严格零售/诊断 DLL、两项站点集成及完整 WebGPU 36 次运行通过。新宿主包 `6f16a361c67d83f7fde8` 已同步站点。见 [stage4e2-validation.json](fixtures/d3d-review/stage4e2-validation.json)。接着处理材料/其他对象默认值及剩余运行时工作；未宣称 Microsoft D3D8/9 原生、Wine 全套或游戏/FPS 验收完成。

> **阶段 4E3（2026-11-03）：共用材料/裁剪平面默认值及 Reset 对象清理完成。**
> - `d9wg_state.js` 的材料默认表同时生成三个 SDK 前端的 C 默认值；保留 API 差异：D3D8 diffuse RGB=1、alpha=0，其余为零；D3D7/9 全零。宿主创建、Reset 与六个裁剪平面使用独立的默认对象。D3D8 在创建及 Reset 后发送精确材料补丁。
> - 原版 Microsoft D3D7 RGB 新建、修改后重建设备共采集 82 项材料/平面 DWORD 和 HRESULT；代理全部相同。D3D8/9 材料依据各自 SDK 表，未冒称原生 HAL 实测；D3D8/9 零平面依据共享初始化和 Wine 行为。
> - 修复 D3D8 Reset 残留裁剪平面，以及 D3D9 Reset 残留材料、平面、低编号灯光定义/启用标志和稀疏高编号灯光。已验证释放稀疏存储、失败查询不改写输出；本步不改变既有 shader 常量恢复策略。
> - 独立事实表验证 51 个材料字、带边界保护的平面清零、实际 D3D9 初始化函数和补丁失败传播；9/9 C 语义变异及 ASan/UBSan 通过。XP D3D8/9 在 fresh/ALL/两次 Reset 核对 328 个对象字和 64 次灯光查询，并保留此前 688 个渲染与 2,480 个纹理/采样器查询；线协议确认三次 API8 材料补丁。三 API T&L/录制回归通过。
> - 新增四个材料默认值/Reset 像素场景，SwiftShader、Metal 各 337 场景通过；四个宿主材料、平面、Reset 材料/高编号灯光变异被实际像素拦截。152 组核心、144 组客体、36 个 SDK EXE、六个严格零售/诊断 DLL、两项站点集成及 WebGPU 36 次运行通过。运行包 `c7a0a2cafccd9009a5e3` 已同步；发布 DLL 与 XP 测过的字节完全相同。见 [stage4e3-validation.json](fixtures/d3d-review/stage4e3-validation.json)。继续采样过滤、其余默认值和运行时能力协商；完整包装层、Wine/游戏/FPS 验收仍在后续阶段。


> **阶段 4E4（2026-11-03）：默认状态的采样/常量读取修复完成。**
> - `comparisonSamplerFor` 原来把非零枚举都视为线性，导致默认 POINT=1 也使用 PCF；MAG/MIN 还共用一个布尔值和缓存项。现在复用普通采样器的枚举映射，分别生成放大/缩小过滤及缓存键，支持独立的 POINT/LINEAR 组合。
> - 固定像素 uniform 写入原来用 `value || opaqueBlack`，把显式 `D3DTSS_CONSTANT=0` 的透明 alpha 改为 1；现在保留完整 DWORD。新增 stage 0/3 非零→零→另一颜色的实际绘制检查。本步只钉住显式赋零；不将 SDK/Wine 对初始 CONSTANT 的分歧冒称为原生实测。
> - 独立 64×64 深度图以半边失败/半边通过定义比较结果；指定 UV=32.25/64，POINT 必须为 1、线性 PCF 为 0.75，分别用 UV 导数选择放大/缩小。默认值及四种 MAG/MIN 组合共十个场景，加上两个零常量场景：修复前八个像素失败，修复后 SwiftShader/Metal 各 12/12；四种常量/POINT/MIN/缓存语义变异全部被像素拦截。
> - 153 组核心、完整 WebGPU 36 次运行及 Metal 全部 349 场景通过，两项站点集成通过；缓存和带边界保护的 RGBA uniform 单测通过。此为宿主修改，客体源/DLL 沿用 4E3 已验字节。运行包 `c3ca1373a9dc431a030d` 已同步站点，见 [stage4e4-validation.json](fixtures/d3d-review/stage4e4-validation.json)。接着共用格式表与真实后端能力查询，阶段 4/5/6 继续。


> **阶段 4F1（2026-11-03）：共用 SDK 格式/块布局与溢出安全的 mip 计算完成。**
> - `d9wg_formats.js` 统一 58 种原生像素/块几何，生成 SDK 无关的 `d9wg_format_layouts.h`。D3D8/9 的布局及 mip 行计算、DDraw 的像素/压缩块大小和旧深度分类均接入该表；保留原有 29/34/48 个前端布局范围。宿主 BCn 分类和块大小也读取此表。布局掩码只是兼容范围，不作为过滤/混合能力宣称。
> - 共享 mip 计算使用商与余数求块数，避免 `UINT32_MAX + block - 1` 回绕，并在行步长/总字节溢出时原子失败。独立 SDK 几何、冻结的旧范围、实际三个前端函数和 BigInt 数学参考检查 58 行及 1,160 个尺寸/边界组合；10/10 C 语义变异、ASan/UBSan、生成文件一致性检查通过。
> - XP 实际 D3D8/9 对 34/48 种格式分别创建纹理、检查四级 mip 描述与 LockRect 步长，再只读锁定逐字节复查，共 82 张纹理、328 层、19,548 字节。捕获的真实 UPDATE_TEXTURE 逐字节一致；每层只上传一次，只读解锁没有额外上传。线协议检查器会拒绝错字节、错 pitch 和缺层；三 API T&L/录制回归通过。
> - 156 组核心、144 组客体、36 个既有 SDK 冒烟 EXE 与两个新探针、六个严格零售/诊断 DLL、两项集成和完整 WebGPU 36 次运行通过，Metal 全部 349 场景通过。运行包 `d765137eda37adc53ad7` 已同步；发布的 D3D8/9 为格式探针原 DLL，DDraw 为 T&L 探针原 DLL。见 [stage4f1-validation.json](fixtures/d3d-review/stage4f1-validation.json)。继续运行时特性协商及查询谓词；未宣称 S2-32、D3D8 包装或阶段 4/5/6 已完成。


> **阶段 4F2a（2026-11-03）：HELLO 的实际后端能力响应与共用读取器完成。**
> - 在现有 16 字节心跳尾部剩余的 12 字节加入单一协议定义的 `HostCapabilities`，回报实际已启用设备的 float32 过滤/混合、BC 和 timestamp 位。命令布局、HELLO 长度、心跳计数及现有 DLL 兼容性不变；不能把 adapter 宣称但设备未启用的特性当成支持。
> - 回报按 DMA owner 缓存，独立于可能被清理的无设备会话；相同 session id 的两个 owner 各自收到响应。只在首次/能力变化时先清完成标记、写数据、最后发布完成；稳定情况下仍只写原先的心跳 DWORD。传输中断清缓存并重试，部分写入后特性恢复旧值也必须重新发布。owner 释放清理，重放/设备恢复使回报失效并更新。
> - 共用 SDK 无关的 C 读取器验证 magic/版本、屏蔽未知位；缺失、旧版和错误响应不写调用者输出，不授予可选特性。16 种设备特性组合、完整响应顺序/生命周期、C ABI 和保守解码通过；8/8 C/JS 语义变异及 ASan/UBSan 通过。
> - SwiftShader 与 Metal 从实际设备特性独立计算位图，均收到 `15`，两个 owner、重复空批次和交错写入均通过。158 组核心、144 组客体、36 个 SDK 冒烟 EXE、六个严格 DLL 构建、两项集成和加入新页面后的 WebGPU 37 次运行通过，Metal 349 个像素场景通过。运行包 `24ce510eae7000c6d0e3` 已同步，已发布客体 DLL 保持 4F1 已测字节。见 [stage4f2a-validation.json](fixtures/d3d-review/stage4f2a-validation.json)。此步完成协商响应/读取基础；接着接入 CheckDeviceFormat 查询谓词，尚未宣称 S2-32 或后续阶段完成。

> **阶段 4F2b（2026-11-03）：D3D9 公开格式查询接入真实后端能力，压缩纹理 sRGB 修复完成。**
>
> - 共用格式查询事实从宿主表生成 SDK 无关 C 谓词；FILTER、SRGBREAD/WRITE、POSTPIXELSHADER_BLENDING、VERTEXTEXTURE、WRAPANDMIP 逐项验证，复合请求必须全部满足。FP32 过滤/混合分别要求实际设备位，BC 格式连 usage=0 也要求原生 BC 位；D3D 路径没有 CPU BC 解压回退。VS3 顶点纹理仅宣称已经逐格式像素验证的 2D 颜色格式，CPU 可编程纹理、cube/volume VTF、原始深度过滤及旧 bump 查询仍回答不支持。
> - `CheckDeviceFormat` 在需要时通过进程共用 transport 发 HELLO 获取能力；有效零位图可缓存，缺失响应不授予可选特性，等待限于 1 秒并限频重试。锁、会话/profile 字段、延迟、打开/分配/提交失败及计时回绕均验证。新增共用进程字段后，三个 DLL 作为同一版本发布；宿主能力响应明确走 arena 写入，不能把 CPU 构造的记录当作 inline 回包。
> - 真 GPU 揭示 SwiftShader 的 BC sRGB reinterpretation view 不执行解码；改为按需建立原生 sRGB 压缩副本，以有序原始 GPU 复制同步全部 mip/面，保留线性原纹理。更新使副本失效，释放等待在途帧完成；仅使用 BC sRGB 时增加一份压缩纹理存储。两后端验证过滤前解码、上传与线性/sRGB 交错、2×2/1×1 mip 尾块及六个 cube 面。
> - 7200 组独立格式/type/profile/设备上下文各验证 128 种查询组合；查询、transport 和副本的 25/25 新语义变异、两个真 GPU 像素变异及 ASan/UBSan 通过。XP 明确模拟位图 0/15，各跑 FFP/SM2/SM3 共 11520 次公开 SDK 查询；这是客体接口验收，不是 Microsoft 原生 D3D9 或 GPU 功能测量。真实设备另验证正常、关闭 FP32 特性和关闭 BC 三种配置。
> - 164 组核心、144 组客体、六个严格 DLL 构建、36 个 SDK 冒烟 EXE、两项集成、SwiftShader 完整 41 次运行和 Metal 全部 458 个像素场景通过。格式/T&L XP 回归继续检查 328 个 mip 的 19548 个精确字节、状态块与对象生命周期。运行包 `8aa5a0758eba94e27f0f` 已同步，发布 DLL 使用验收时的原始字节；见 [stage4f2b-validation.json](fixtures/d3d-review/stage4f2b-validation.json)。S2-32 的查询缺陷在此关闭；接着检查自动 mip 能力及共用核心的剩余内容，阶段 4/5/6 继续。

> **阶段 4F2c（2026-11-03）：自动 mip 的能力、单层回退及真实过滤状态完成。**
>
> - 共用格式查询表补充自动生成资格：39 种可渲染存储的颜色格式支持生成；BC/SNORM/NULL/深度保持单层。合法 2D/cube 查询在无法生成时返回 `D3DOK_NOAUTOGEN`，创建仍返回 `D3D_OK`、保留 usage 并只暴露一层；体积纹理 autogen、DYNAMIC 组合、显式多层及 SYSTEMMEM/SCRATCH 则按 SDK/Wine 返回不支持/非法调用。
> - 补上实际过滤状态：NONE 不再被当作 LINEAR 接受，POINT/LINEAR/ANISOTROPIC 各自传到宿主；FP32 未启用过滤时默认 POINT 并拒绝 LINEAR/ANISOTROPIC。过滤改变只标脏，读取或显式生成时再执行；录制操作捕获各自过滤类型，后来的设置不能改写早先的绘制。各向异性下采样使用实际 anisotropic sampler。普通纹理/体积纹理的 getter 返回 NONE，普通纹理生成调用不发包。
> - 协议 1.8 为 GenerateMips 增加可选过滤/延迟字段，既有 8 字节 payload 仍按当前过滤立即生成，其余命令布局不变。资源创建发送过滤配置，managed 纹理 Reset 保留设置。像素验收进一步发现并修复 ColorFill 写入后没有标记生成链失效，现与上传/复制/附件写入一样触发更新。
> - 新增 75 个像素场景：8 种实际 GPU 存储、2D/cube、四种过滤选择、两级生成层、六个面、旧命令/过滤交错、GPU 写入及 9 种不能生成的存储。SwiftShader/Metal 通过，关闭 float32-filterable 的 66 场景也通过；两个真 GPU 变异必须造成像素不匹配。2856 组过滤事实、175 组创建组合、真实 C setter/getter/封包及宿主录制通过；12 个 C、7 个宿主及 15 个格式查询变异全部检出，ASan/UBSan 通过。
> - XP 在明确模拟的位图 15/12 下各验证 48 种格式、291 个对象、2705 项 SDK 检查，确认 getter、失败输出、单层回退、非法创建及两次 Reset。原始命令流另检查 194 个 autogen 对象、484/472 次延迟配置、96 次显式生成和 managed Reset 保留；GPU 颜色结论来自独立浏览器验收，不将 XP 模拟响应当成原生 Microsoft HAL 测量。
> - 168 组核心、144 组客体、36 个 SDK 冒烟 EXE、六个严格 DLL、两项集成、完整 WebGPU 42 次运行与 Metal 全部 533 场景通过；T&L XP 三 API/生命周期回归通过。运行包 `8cc48a9a2b75d0296e91` 已同步，三个零售 DLL 均发布验收时原字节。见 [stage4f2c-validation.json](fixtures/d3d-review/stage4f2c-validation.json)。接着共用窗口状态与其余客体核心，阶段 4/5/6 继续。
> - 依据：[Microsoft 自动 mip 契约](https://learn.microsoft.com/en-us/windows/win32/direct3d9/automatic-generation-of-mipmaps)、[CreateTexture 返回行为](https://learn.microsoft.com/en-us/windows/win32/api/d3d9/nf-d3d9-idirect3ddevice9-createtexture)，以及冻结 Wine `device.c` 的 `test_mipmap_gen`/`test_cube_texture_mipmap_gen`。

> **阶段 4G1（2026-11-03）：共用完整窗口报告缓存及客体事件验收完成。**
>
> - 抽出 SDK 无关的 `d9wg_window_state.c/.h`，三个前端共用区域封包、有效字节比较、成功排队/提交后的缓存及失效操作。比较包含全部设备/HWND/前台/标志、位置、内外尺寸和有效区域；未发送的区域尾部不参与比较，最大 32 个矩形有边界保护验证。移除三套不完整的字段缓存和 D3D8 重复的 surface 比较。
> - 修复 D3D9 位置/尺寸变化在 flags/region 不变时被去重、D3D8/DDraw 前台 HWND 变化被遗漏，以及 D3D9/DDraw 失败排队/立即提交后错误记为已发送而不重试。比较与缓存更新由进程 transport 锁保护；D3D9 Reset 失效，DDraw 无主表面通知清除 showing 缓存。保留 D3D8 隐藏几何与 DirectDraw fullscreen/no-surface 的既有协议策略。
> - 原生编译实际三个前端报告函数与共用实现，验证完整几何/前台变化、区域内容、排队/提交失败、有效零区域与 32 矩形、未用尾部、失效和 no-surface。10/10 C 语义变异、ASan/UBSan 通过。协议一致性检查从实际 runtime 头读取私有描述符，新增类型不再需要手工维护头名单。
> - 真实 XP 三进程/三个 API 产生 27 条窗口报告，对照独立 Win32 GetClientRect/ClientToScreen/GetWindowRect、前台及可见性测量，22 个移动、缩放、双前台窗口、隐藏/显示与主表面释放步骤通过；动作后停止 Present，仅泵消息，仍收到更新。驱动命令流、阶段标记及 SDK 观测冻结为 fixture，四种几何/前台/no-surface 数据破坏必须失败。
> - SwiftShader/Metal 完整回放真实命令流，22 步均正确更新宿主 surface 几何或隐藏状态，27 条报告零 GPU/宿主错误。169 组核心、146 组客体、36 个 SDK 冒烟 EXE、六个严格 DLL、两项集成、加入窗口回放后的 WebGPU 43 次运行及 Metal 533 个像素场景通过；三 API T&L/状态块/生命周期 XP 回归通过。宿主运行包保持已验 `8cc48a9a2b75d0296e91`，零售 DLL 均为窗口探针原字节。见 [stage4g1-validation.json](fixtures/d3d-review/stage4g1-validation.json)。接着共用 Win32 探测/事件与每次 Present 的复用，尚未宣称整个窗口核心、D3D8 包装或阶段 4/5/6 完成。

> **阶段 4G2（2026-11-03）：共用 Win32 探测及每次 Present 的复用完成。**
>
> - 新增 `d9wg_window_probe.c/.h` 和 SDK 无关的 `d9wg_window_geometry.c`。三个前端共用窗口身份、前台、可见性、内外尺寸、客户区屏幕位置和可见区域采集；区域计算接收已读取的客户区/原点，消除重复的 Win32 查询。D3D9/DDraw 的 Present 和窗口报告使用同一份观测；D3D8 的 Present 保持轻量几何采集，不额外读取前台或 GDI 区域。
> - D3D9 主动恢复/提升前台窗口后重新采集，再构建 Present 和窗口报告，避免发送改变前的位置。完整遮挡和 500 ms 限速沿用显式策略；D3D8 的隐藏/最小化、D3D9 的空客户区外框回退、DDraw 各轴模式尺寸回退及实际 fullscreen/no-surface 形状保留为独立、可测试的策略输入。
> - 原生编译实际 Win32/GDI 采集实现和三个实际 Present 函数，独立模拟全显/全遮/部分遮挡、负屏幕位置、2–32 个区域及超限、GDI/坐标/尺寸查询失败、最小化、隐藏和各 API 几何回退。检查常规 Present 对每项原始事实只查询一次，前台恢复路径重采集，区域与 Present/报告一致；17/17 探测/Present 变异、原有 10/10 报告缓存变异及 ASan/UBSan 通过。OpenGL 的旧入口复用拆出的区域函数，坐标转换失败时保守报告全区域。
> - 真实 XP 再次通过三 API 的 22 个独立 Win32 测量步骤和 27 条报告。新命令流 `d3d_window_probe_xp` 与 4G1 原 fixture 分开冻结；两个冻结流均包含四种数据破坏检查。SwiftShader/Metal 完整回放新流，22 步 surface 几何/隐藏状态全部匹配，零宿主/GPU 错误。
> - 169 组核心、149 组客体、36 个 SDK 冒烟 EXE、六个严格 D3D DLL、两项集成、完整 WebGPU 44 次运行及 Metal 533 场景通过；XP 三 API T&L/状态块/生命周期回归通过。三个发布零售 DLL 均为本次窗口 XP 验收原字节，宿主运行包保持 `8cc48a9a2b75d0296e91`。见 [stage4g2-validation.json](fixtures/d3d-review/stage4g2-validation.json)。接着共用 WinEvent 注册/分发与生命周期；D3D8 包装和阶段 4/5/6 仍在继续。
> - 依据：[GetClientRect 的客户区约定](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getclientrect)、[GetRandomRgn 的屏幕坐标与时效限制](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-getrandomrgn)、[GetRegionData 的所需容量和失败返回](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-getregiondata)。保留既有 SYSRGN 算法，不宣称在窗口移动期间取得原子的可见区域快照。

> **阶段 4G3（2026-11-03）：共用 WinEvent 订阅、消息线程和回调生命周期完成。**
>
> - 新增 CRT-free 的 `d9wg_window_watch.c/.h`，三个前端共用事件过滤、订阅、分发、重入合并、重试及退出实现，仅保留各自的报告/flush 策略。各加载模块的钩子由自己的消息线程安装、泵消息和卸载；应用停止 Present 或消息泵时仍能更新窗口。移除三套固定 8 对象数组，订阅节点随 API 对象保存。
> - 移除操作持有进程 transport 锁，与正在执行的回调同步后才允许释放对象。每次通知后重新读取订阅链表，回调可移除/释放自己或其他对象；回调中新注册对象由后续合并刷新通知，处理 epoch 回绕，避免重入颠倒更新顺序。D3D9 仍在一轮报告发生变化后合批 flush，D3D8/DDraw 保留立即提交策略。
> - 私有线程持有 DLL 引用，使用 `FreeLibraryAndExitThread` 完成退出；旧线程清理不会覆盖新线程状态。消息队列先于 ready 发布，调用方复制 ready 句柄并在锁外有界等待；锁指针原子发布。分配/event/模块引用/线程启动失败按一秒限速重试，部分钩子失败由工作线程 timer 重试，timer 创建失败可由后续 Present 恢复；正常 Present 不增加几何/GDI/时钟探测。
> - 补充并修复事件和 Present 的交错顺序：三个实际 Present 函数在采集后插入较新窗口事件时，修复前均会把新位置覆盖回旧位置。现在采集、对应报告和 Present 排队在同一把锁内完成；D3D9 主动恢复/提升窗口时先解锁，完成后重新加锁采集。reserve/emit/submit 失败均释放锁，窗口报告及 DirectDraw no-surface 采集也与事件线程串行。这保证协议提交顺序，不宣称 Win32/GDI 观测原子化。
> - 原生并发测试通过 64 个订阅、六类事件/非窗口过滤、重复注册、epoch 回绕、回调中新建及自删/互删、另一线程等待正在执行的回调后移除、四种启动失败、钩子/timer 重试及线程代际退出。新增 30/30 事件/前端语义变异，原有 17/17 探测/Present 和 10/10 报告缓存变异通过；ASan/UBSan 及共用线程实现的 ThreadSanitizer 通过。
> - **真实 XP：每 API 12 个对象，共 36 个，验收第 12 个对象。** 动作后既不 Present 也不泵应用消息，仅 Sleep；22 个独立 Win32 几何/前台/隐藏/主表面释放步骤全部匹配，产生 136 条报告。解码验证每个 owner 创建 12 个设备、步骤对应最后一个设备；释放后全部三个 DLL 在进程仍运行时成功卸载。新命令流 `d3d_window_event_xp` 单独冻结，三代 fixture 共通过 12 种数据破坏检查。
> - 新流在 SwiftShader/Metal 均通过 136 报告、22 步 surface 几何/隐藏状态检查，零宿主/GPU 错误；前两代回放入口也通过，本轮共四次窗口浏览器运行。169 组核心、151 组客体、36 个 SDK 冒烟 EXE、六个严格 DLL、两项集成及三 API T&L/状态块/生命周期 XP 回归通过；零售 DLL 为最终窗口 XP 探针原字节。运行包仍为 `8cc48a9a2b75d0296e91`，宿主源码和发布包未变，沿用 4G2 完整 44 次 WebGPU/Metal 533 场景基线；完整 GPU 目标已加入新流，现含 45 次运行。见 [stage4g3-validation.json](fixtures/d3d-review/stage4g3-validation.json)。接着零售输入语义、D3D8 包装及其余客体核心，阶段 4/5/6 继续。
> - 依据：[SetWinEventHook 的消息线程与重入约定](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook)、[UnhookWinEvent 必须在安装线程调用](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-unhookwinevent)、[PostThreadMessage 的消息队列就绪要求](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-postthreadmessagea)、[DLL 引用与线程一起释放](https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-freelibraryandexitthread)。

> **阶段 4H1（2026-11-03）：XP 零售版 VB/IB Lock 标志语义（S2-27）完成。**
>
> - 新增 SDK/CRT 无关的 `d9wg_buffer_lock.c/.h`，四个 D3D8/9 VB/IB Lock 入口共用清洗策略，移除拒绝非动态 DISCARD/NOOVERWRITE、两者混用及 READONLY 冲突的检查。Wine 的 Windows 测试明确记录 XP 对七种组合（包括 `0xdeadbeef`）返回成功，D3D9 的 Win7 行为不同；这里按 XP 行为处理，保留指针/范围错误的既有保护。
> - 依据独立冻结的 Wine 访问转换/map 清洗事实：非动态或 CPU 池忽略 streaming 提示；两种 streaming 提示并用时保留 NOOVERWRITE；与资源 WRITEONLY/streaming 相矛盾的 READONLY 回退到可写访问；真正只读的映射不上传。有效标志用于 unlock/上传及 VB 裁剪记录失效，忽略的 DISCARD 不再破坏旧数据或裁剪元数据。有效 DISCARD 去掉整块 CPU 影子清零，旧内容仍按 D3D 合约未定义。
> - 固定 8 份 Wine 源码 blob 和 SHA-256，整理 12 个 usage/pool 上下文、8 种基本组合、7 种额外/未知位及七种 XP HRESULT 事实；生成独立客体参考头。原生编译实际四个 Lock/Unlock 与共用 C，每 API **1,344 组**验证有效标志、精确上传、只读保留、范围/失败原子性、解锁清理和裁剪失效。16 MiB 保护页检查确保 DISCARD 不访问未请求的影子页；27/27 C 语义变异及 ASan/UBSan 通过。
> - **真实 XP 两 API 共 2,688 组 COM/命令流检查通过。** 每 API 24 个矩阵缓冲、84 个只读跳过、1,260 个局部写入，逐字验证 86,016 字节基线及 20,160 字节更新；七种 XP HRESULT 组合应用于 VB/IB，共再检查 28 次。四个场景/每 API 涵盖静态冲突标志、动态 NOOVERWRITE 优先及两种 READONLY 冲突；保留旧数据场景回传整块影子以暴露误清零，READONLY 冲突场景直接绘制以暴露漏上传。
> - 冻结 `d3d_buffer_lock_xp`；公共检查重验全部矩阵/帧顺序及四种标志/数据破坏。SwiftShader/Metal 各通过八帧、24 个独立颜色探针、零宿主/GPU 错误。另将合法命令流中第一组三角形由红改蓝并更新完整性摘要：格式/矩阵检查仍通过，真实像素比较以 255 字节差异失败，验证测试能发现实际颜色错误。
> - 171 组核心、153 组客体、36 个 SDK 冒烟 EXE、六个严格 DLL、两项集成及三 API T&L/状态块/生命周期 XP 回归通过。D3D8/9 零售 DLL 发布最终 XP 验收原字节，DDraw 保持 4G3 已验收字节。宿主源码/运行包 `8cc48a9a2b75d0296e91` 未变，沿用既有 44 次完整 WebGPU/Metal 533 场景及 4G3 新窗口回放基线；本轮新增两个正向 GPU 运行和一个预期失败的像素变异，完整目标现含 46 次运行。见 [stage4h1-validation.json](fixtures/d3d-review/stage4h1-validation.json)。这里的访问策略来自 Wine、图像来自已知输入几何，不宣称原始 Microsoft 缓冲内容/像素测量或整个 Buffer API 验收；继续零售绘制/复制语义、客体包装与阶段 4/5/6。
> - 依据：[Wine D3D8 的 XP 标志测试](https://github.com/wine-mirror/wine/blob/master/dlls/d3d8/tests/device.c)、[Wine D3D9 的 XP/Win7 区分](https://github.com/wine-mirror/wine/blob/master/dlls/d3d9/tests/device.c)、[Microsoft Lock 提示约定](https://learn.microsoft.com/en-us/windows/win32/direct3d9/locking-resources)、[动态缓冲 DISCARD/NOOVERWRITE 合约](https://learn.microsoft.com/en-us/windows/win32/direct3d9/performance-optimizations)。

> **阶段 4H2a（2026-11-03）：索引绘制提示、有符号基址和零图元（S2-34 部分）完成。**
>
> - D3D8/9 共用从声明元素、流长度/偏移/步长及实例频率计算 CPU 可读索引区间的纯 C 核；支持常量流与负基址。普通 GPU 路径按流和声明元素计算范围，不扫描索引；保护页测试约束预变换绘制也不多读索引。
> - `MinVertexIndex/NumVertices` 继续原样发送，零顶点数、溢出或不相干的提示不再误拒绝有效绘制。D3D8 Set/GetIndices 和延迟状态块保留完整 UINT 基址位型；D3D9 保留无顶点输入程序的空声明路径。六种有效图元的零数量调用在必要入口校验后成功，不读绘制范围、不发 Draw、不更新镜像。
> - 可用于软件分类的提示仍包含未被索引引用的顶点；无法安全分类时继续绘制并将代理 ClipStatus 查询标为不可用，后续有效单流/多流绘制恢复查询。预变换绘制保持既有状态行为；这一回退策略不是原始 Microsoft 无效提示 ClipStatus 的测量结果。
> - 两个实际 SDK 前端函数、10 万组独立枚举范围、未对齐 16/32 位索引、常量/实例流、有界尾部、失败原子性、六种基址位型和状态块引用通过；25/25 变异、四个录制语义破坏及 ASan/UBSan 通过。旧 SetIndices 在高位基址定向回归中实际失败。
> - XP 两 API 各九个场景，共 18 帧；逐条检查提示/基址、已知顶点和索引字节、零图元没有 Draw，以及 COM 对象释放。SwiftShader/Metal 各通过 54 个颜色探针，零宿主/GPU 错误。三 API T&L/状态块/生命周期和 D3D9 类型、颜色、多流实际 XP 回归通过。
> - 173 组核心、157 组客体、36 个 SDK 冒烟 EXE、六个严格 DLL、两项集成通过。D3D8/9 发布最终绘制 XP 验收的原字节，DDraw 保持已验收字节；宿主源码和运行包 `8cc48a9a2b75d0296e91` 未变，沿用既有完整 GPU/533 场景基线，本轮新增两次正向回放，完整 GPU 目标现含 47 次运行。见 [stage4h2a-validation.json](fixtures/d3d-review/stage4h2a-validation.json)。
> - 接着处理仍锁定的 VB/IB 在绘制前的上传可见性；UP、缺失绑定和原生 HAL 边界契约也未在本步宣称完成。S2-34、包装层和阶段 4/5/6 继续。

- **目标：** 一个 bug 只修一处；D3D8 和 DDraw 变成真正的翻译层。
- **改动：**
  - 抽出 `d9wg_runtime`（C 静态库）：
    - 传输：进程级唯一 owner、统一的重试策略，以及驱动侧的多 owner 支持；
    - 窗口跟踪：事件驱动，缓存每次 Present 的探测结果；
    - 格式表和分带上传；
    - caps 谓词：加入宿主运行时特性，例如 float32-filterable/blendable，通过 HELLO 响应回报给客体（S2-32）；
    - FVF 展开；
    - 唯一一份软件 T&L，与宿主固定管线同一套语义；
    - 状态影子：默认值与宿主由同一张表生成，并把隐性约定写成测试。
  - **D3D8 改为包装 D3D9 客体对象（DXVK 模型）：**
    - 把 `d3d9_proxy.c` 编成静态库或私有的 `d9wg.dll`；
    - D3D8 侧只做这些转换：
      - D3DCAPS9→8、PP8→PP9；
      - 状态和 TSS 映射（已在 `d3d8_protocol.h`）；
      - `SetVertexShader(FVF|handle)`；
      - 声明到元素（`declaration_to_elements` 已有）；
      - BaseVertexIndex 留在包装层；
      - CopyRects 按池组合映射到 UpdateSurface、StretchRect、GetRenderTargetData；
      - GetFrontBuffer 映射到 GetFrontBufferData；
      - DWORD 状态块句柄映射到 IDirect3DStateBlock9；
      - 表面包装按容器缓存，保持 COM 同一性。
    - 这样 S2-36 到 S2-43 中的大部分自动消失。
    - 风险：D3D9 的严格校验会拒绝 D3D8 合法的输入（ps_1_0、没有 dcl 的 vs_1_1），需要一个“D3D8 模式”。
  - **客体校验改为零售语义：** 以 Wine 测试为准，清洗标志而不是拒绝。
  - **DDraw：** 复用共用核心的传输、窗口、格式和 T&L；修正 §3.2 DDraw 一节的问题。
- **验证：**
  - 先把纯逻辑部分（声明转换、FVF、状态映射、状态块范围、默认表）在宿主上原生编译，做单元测试；
  - 再跑阶段 6 的 Wine 测试；
  - 3DMark 2001 SE 和 MapleStory 回归。

### 阶段 5：着色器翻译器（约 3–4 周）

- **目标：** 翻译的正确性由差分测试保证。
- **改动：**
  - 写一个 SM1–3 的 CPU 参考解释器（JS），按 D3D9 文档的伪代码实现。
  - 把生成的 `d9_body()` 包成 compute 入口：输入和常量来自 storage buffer，寄存器结果写回；在真 GPU 上与解释器对比随机输入和边界输入。纹理指令对已知梯度、显式 LOD 采样。
  - 系统地生成测试程序：opcode × 修饰符 × 掩码 × 版本，再加上控制流形状（嵌套 loop、`if` 内 break/call）。
  - 变体架构改为“主体只翻译一次，外加很薄的入口包装”，变体不再整份重新翻译。
  - 语义链接改为在链接时重映射。
  - 修正 S2-10 到 S2-14 和 §3.3 中的着色器项。
  - 建立一份私有的游戏着色器语料，并以 `D3D9_CORPUS_STRICT=1` 在 Tint（Chrome）下校验。
- **验证：** 差分测试零差异；语料在 Tint 下零拒绝。

### 阶段 6：客体内验收（持续）

见 §8。

## 8. 建立成体系的验收

### 8.1 分层

| 层 | 内容 | 期望值从哪里来 | 在哪里跑 |
| --- | --- | --- | --- |
| L0 协议 | schema 生成的往返测试，逐个 opcode 测截断、版本门控、会话隔离 | schema | 每次 push |
| L1 纯逻辑单元 | 客体纯函数原生编译；宿主各模块单独测试 | 规范 | 每次 push |
| L2 严格假 GPU | 现有执行器测试迁到严格假 GPU 上，去掉对 WGSL 文本和私有计数器的断言 | WebGPU 规则 | 每次 push |
| L3 真 GPU 像素一致性 | 表驱动，按 D3D 特性分表；着色器差分测试 | D3D 文档、Wine `visual.c` 期望值、参考解释器 | CI 用 SwiftShader WebGPU（ubuntu 上 headless Chrome）；每晚在本机 Metal 上跑 |
| L4 客体 API 一致性 | 在 XP 客体里跑 Wine 的 `dlls/d3d9/tests`、`d3d8/tests`、`ddraw/tests`（device.c、visual.c 等），代理 DLL 放在 EXE 旁边 | Wine 测试自身 | 每晚，在有磁盘镜像的机器上 |
| L5 游戏冒烟 | 固定的存档状态加脚本输入，截图与黄金图像比对 | 人工确认过的黄金图像 | 每晚或发布前 |

### 8.2 L4 已有的基础设施和缺口

- **已有：**
  - `tests/devices/usb_windows_xp.mjs` 能只读启动 XP 镜像，用 mingw 编译 EXE，放进 FAT16 工具盘，通过 Win+R 运行并读回结果；
  - `gpu_remote_renderer.mjs` 提供 headless Chrome WebGPU 渲染端，但目前只支持 SVGA。
- **缺少：**
  - 渲染端的 D9WG（v86gl）入口；
  - 装好 `v86gl.sys` 的 XP overlay 镜像；
  - 结果解析器：解析 Wine 测试的 “Test failed” 行，并与基线比较。
- **更快的变体：** 在 Linux 上用 Wine 直接运行同样的 EXE，用 socket 垫片替换代理 DLL 的三处驱动调用（`G9:1595-1690`）。本机没有安装 Wine。

### 8.3 规则

1. **能力宣称必须有测试覆盖。** 客体 caps 和 `CheckDeviceFormat` 的每一个“yes”，都要在 L3 或 L4 有对应的用例；没有用例的能力不宣称。
2. **每个 bug 修复都要在能暴露它的最低一层加回归用例。** 只能在 L5 暴露的问题，要补一个 L3 用例。
3. **SKIP 不算通过。** CI 缺工具就失败。
4. **偏差表即契约。** README 偏差表里的每一行都要对应一个 L3 用例，断言的就是这种偏差的具体表现；不在表里的偏差就是 bug。
5. **删除：**
   - 退役 D3D8 执行器的测试（视阶段 2 的存档审计结果而定）；
   - 不经过执行器的 `d3d9_legacy_format_browser_test.html`；
   - 诊断追踪覆盖测试；
   - 匹配 C 源文本的正则测试；
   - 在 L3 建好之后，大部分 WGSL 文本断言和精确计数器断言。

### 8.4 已做的决定（2026-10-29）

| 问题 | 决定 | 对方案的影响 |
| --- | --- | --- |
| 是否下载 Wine 源码 | 同意（已完成） | 已用于核对本文的语义条目（附录 C）；之后用于移植 `visual.c` 期望值、在 XP 客体里运行。Wine 测试是 LGPL，只用于测试，不打进发布的 bundle |
| 退役 D3D8 执行器是否支持旧存档 | 不需要兼容旧存档 | 不做存档审计；直接删除 `d3d8_executor.js`、0xFFE0 路由和旧存档的 D3D8 分支（阶段 2，可提前） |
| 阶段 0 的 MSAA | 直接实现 resolve | 阶段 0 实现多采样附件加 `resolveTarget`，不先撤销 4x 的宣称 |

## 附录 A：我本人的核实记录

以下结论由我直接读代码确认（行号基于本文基线）：

- **执行器核心：**
  - `E:3662-3679` 命令级全捕获；`E:3713-3721` 未知 opcode；`E:3954` 指向不存在的 `onUpdateSurface`；`E:4011-4018` DDraw 处理器可选。
  - `E:3539-3543` → `BR:528, 545` → `GP:246-252` → `v86gl_device.js:187` → `G9:1686-1690`，粘性失败的整条链。
  - `E:5202-5214` 尺寸不符时丢整帧，查询一起丢；`E:5055-5063` 遮挡查询集最多 8192。
  - `d3d9-webgpu/` 和 `webgpu_host.js` 中零处 `pushErrorScope`/`uncapturederror`。
- **客体与驱动：**
  - `VT:262-274` 5000 次轮询后销毁传输；`G9:11785-11825` `GetData` 无期限。
  - `SESSION_END` 只出现在 `GD:1074`。
- **MSAA 与清除：**
  - 没有 `resolveTarget`；`backBufferMsaaView` 从未被读取；`E:5156-5165` 附件是单采样，`E:4379`、`E:9758` 却是 4 采样。
  - `E:4945-5003` 与 `G9` `device_clear`：Clear 不按视口裁剪。
- **解码与状态处理：**
  - `E:7273-7283` 对照 `PH:671-680`，偏移错位。
  - `E:9049` 视口 MaxZ；`E:10599` 顶点纹理 256+index。
  - `E:9660-9679` MIN/MAX 因子；`E:10798` depthBias；`E:10733-10745` MRT 写掩码；`E:12257` UP 路径丢索引三角扇（`D7:636-645` 走此路径）。
- **固定管线与着色器：**
  - `E:2275-2279` 不读 RHW；`E:9946-9955` 禁用雾；`E:1812-1826` alpha test 字面量；`E:10087-10093` ps<3 不加雾。
  - `SP:719-721`、`SP:909/1310/1460` 谓词；`SP` 中没有 `derivative_uniformity`。
- **D3D9 客体：**
  - `G9:4641` 对照 `G9:5689`，BackBufferCount；`G9:4693-4710` 640×480。
  - `G9:3827-3952` 重建时没有 DESTROY，`E:4198-4237` 不清 `this.resources`。
  - `G9:13230-13241` Lock 标志；`G9:7300-7314` 加 `G9:10743/10897/11069` patch 绘制解绑流；`G9:11330-11350` SetRenderTarget 不重置剪裁；`G9:9214-9229` MultiplyTransform 的循环。
- **D3D8 客体：**
  - `G8:5545-5569, 5780-5800` CopyRects/GetFrontBuffer 使用 CPU 影子，`G8` 中没有 READBACK。
  - `G8:2858-2923` 默认表缺项；`G8:3790-3800` 冗余过滤。
- **DDraw：**
  - `GD:2331` 加 `PH:1049` 加 `DO:416-431`，COLORFILL 三方矛盾；`GD:2256-2266` 剪裁器用客户区坐标。
- **真 GPU 复跑：** 像素原型页 19 个探针中 3 个失败，即 S2-3（及其 alpha test 后果）和 S2-2 的雾。
- **重复度：**
  - 自写脚本按 6 行窗口比对：`d3d8_proxy.c` 约 23% 的有效代码行与 `d3d9_proxy.c` 原样重复；
  - 宿主各执行器之间几乎没有文本重复，重复在于功能，而不是文本。
- **opcode 表：** C 有 76 个，JS 有 73 个；差异只在保留或未使用的 opcode（`CREATE_STATE_BLOCK`、`0x210`、`GET_QUERY_DATA`）。

## 附录 B：原始分区报告

10 份英文分区报告（每份约 2–3 千词，带完整行号和复现脚本说明）、核实记录、像素一致性原型（`conformance-prototype/`）和变异实验（`mutation-experiment/`）都在：

`~/Library/Application Support/Claude/side-session-notes/local_e0809f53-9de5-4887-ac0e-d29f1677b8aa/d3d-review/`

这些不在仓库里。如果需要把像素原型转成正式测试，它可以直接改写为 `tests/glbridge/` 下的一个 `*_browser_test.html`，用 `gl_multipass_browser_runner.js` 运行。

## 附录 C：Wine 对照结果

对照对象是 Wine `66caeb46`（2026-10-28），稀疏取了 `dlls/d3d8`、`dlls/d3d9`、`dlls/ddraw`、`dlls/wined3d` 和 `libs/vkd3d/libs/vkd3d-shader`。这份源码放在本会话的临时目录里，需要时可以重新获取：

```bash
git -c http.proxy=http://127.0.0.1:7897 clone --depth 1 --filter=blob:none --sparse https://gitlab.winehq.org/wine/wine.git
```

```bash
git -C wine sparse-checkout set dlls/d3d8 dlls/d3d9 dlls/ddraw dlls/wined3d libs/vkd3d/libs/vkd3d-shader
```

（这台机器的全局 git 代理指向不可用的 10808 端口，所以要显式指定代理。）

### 结果汇总

| 结论 | 条目 |
| --- | --- |
| 有 Windows 上运行过的 Wine 测试钉住，我们的实现与之不符（W+） | S2-1、S2-2（雾）、S2-4、S2-5、S2-14、S2-27、S2-30、S2-38、S2-39、S2-40、S2-41、S2-44、S2-45、S2-46、S2-47、S2-52、S2-53、S2-54、S2-55、S2-56、S2-57；S3 的 vs_1_1 `mov a0` 取整、ps_1_x 常量夹取、ps_1_x `tex` 投影、vs<3 的 oFog 来源 |
| Wine 实现与本文结论一致，但没有 Windows 测试钉住（W） | S2-2（透视）、S2-3、S2-16（混合一侧）、S2-19、S2-20、S2-29、S2-31、S2-34、S2-35、S2-48、S2-49 |
| 需要修正本文原先说法的 | S2-46：DDBLTFX 覆盖键仍是范围，只有表面颜色键要收拢为 high=low；S2-53：只有经 DD4/DD7 创建的表面才持有 DirectDraw 对象；S2-38：POINTSIZE_MIN 在 D3D8 默认是 0，RESULTARG 已正确；S3：ps_1_x 中间值不需要夹取 |
| 与 Wine 一致，不算问题 | D3D8 ps_1_x 的 `def` 常量（Wine 同样当作着色器私有） |
| 仍无法定论 | `mova` 在 .5 处的取舍（wined3d 与 vkd3d 不同，Windows 测试未覆盖）；D3D8 ZBIAS 的比例（Wine 与我们不同，也无 Windows 测试）；S2-16 采样一侧；S1-3、S1-11 的触发条件（需要在客体中运行） |

逐条的 Wine 文件和行号、测试名称和期望值，见共享笔记目录 `d3d-review/` 下的 `wine-check-lead.md`、`wine-check-shader-d3d8.md`、`wine-check-ddraw.md`。

Wine 的测试里有不少可以直接作为阶段 1 像素一致性套件的期望值来源：d3d9 `visual.c` 的 `clear_test`、`fog_test`、`test_color_clamping`、`constant_clamp_ps_test`、`test_mova`、`test_color_vertex`、`texop_test`，d3d8 `visual.c` 的 `fog_with_shader_test`、`cnd_test`、`intz_test`，以及 ddraw1/2/4/7 中的颜色填充、颜色键、执行缓冲和视口测试。

