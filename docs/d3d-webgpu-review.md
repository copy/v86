# D3D 代理 → WebGPU 代码审查与重构建议

审查对象：DirectDraw、Direct3D 1–7、Direct3D 8、Direct3D 9 四个客体前端，以及它们共用的 D9WG 协议和宿主执行器。
基线：v86 `e92fd4f0`（`ios6` 分支，D3D 相关文件与 `master` 相同），retro-gaming-site `43c4d1e`。日期 2026-10-29。
性质：只读审查，没有改动代码；本文尚未提交。
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

