# D3D 代理 → WebGPU 代码审查与重构建议

审查对象：DirectDraw、Direct3D 1–7、Direct3D 8、Direct3D 9 四个客体前端，以及它们共用的 D9WG 协议和宿主执行器。
基线：v86 `e92fd4f0`（`ios6` 分支，D3D 相关文件与 `master` 相同），retro-gaming-site `43c4d1e`。日期 2026-10-29。
性质：本文保留修复前的审查基线，已提交；后续实施进度记在第 7 节各阶段的状态块。
当前实施状态（2026-11-05）：**阶段4由4L15收尾，阶段5由5L7完成**。历史状态块保留各提交当时的范围；阶段6整套Wine及六版3DMark本地验收仍开放，冒险岛按用户要求跳过。阶段6不要求新增GitHub CI或每晚自动运行，不上传XP/游戏磁盘镜像，最新范围见§8.5。
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
| S2-56 | `SetRenderTarget(NULL, ds)` 被拒（只换深度、或 `(NULL, NULL)` 解绑深度） | `G8:5817` | D3D8 规定 NULL 颜色目标表示保留当前目标 → 只换深度缓冲的游戏失败 | ✅；4H5a |

#### DDraw / D3D1–7 客体与 `ddraw_ops.js`

| # | 问题 | 位置 | 触发 → 后果 | 核实 |
| --- | --- | --- | --- | --- |
| S2-44 | COLORFILL 颜色的格式，三处说法互相矛盾 | `GD:2331` 原样发送 `dwFillColor`；`PH:1049` 说是“目标格式的值”；`DO:416-431` 按 A8R8G8B8 解码，并注释“客体已转换” | 565 的白色 0xFFFF 变成青色；用颜色键预填的表面不再匹配键；32 位 X8 填充 alpha 为 0。只有索引色填充有测试 | ✅；W+（ddraw7 `test_color_fill`；Wine 用目标格式的掩码解码，`ddraw/utils.c:593-645`） |
| S2-45 | 窗口剪裁器用客户区坐标裁剪 | `GD:2256-2266, 2417+`（`GetClientRect`，不做 `ClientToScreen`） | 主表面是屏幕坐标 → 不在 (0,0) 的窗口被裁错或完全不画 | ✅；W+（ddraw7 `tests/ddraw7.c:1360-1384`：剪裁列表是映射到屏幕坐标的可见区域） |
| S2-46 | 表面颜色键没有 `DDCKEY_COLORSPACE` 时仍用 high 值；带 COLORSPACE 的范围键应返回 `DDERR_NOCOLORKEYHW` | `GD:3256, 4435-4446, 2839`、`DO:240-245` | Windows 在缺这个标志时令 high=low，应用常把 high 留 0 或垃圾值 → 精灵不透明或出现空洞。Blt 的覆盖键（DDBLTFX）仍是范围，保持现状 | ✅；W+（`ddraw/surface.c:5243-5257`；ddraw7 `test_range_colorkey`）；4I1 |
| S2-47 | stage 0 的 alpha 默认值被 TEXTUREMAPBLEND 回放覆盖；没有按版本区分的默认状态 | `D7:1058, 2410, 1820-1829, 1125`、`ddraw_protocol.h:760-764` | 所有版本共用一套初始化，D3D7 也从 `SELECTARG2(DIFFUSE)` 开始 → alpha 纹理几何画成不透明；传统 MODULATE 应在纹理有 alpha 或未绑纹理时取 `SELECTARG1(TEXTURE)`，否则 `SELECTARG2(CURRENT)`，并在 SetTexture 时重算；D3D7 上 TEXTUREMAPBLEND 应返回 `DDERR_INVALIDPARAMS`；按版本的默认值缺失（v1 COLORKEYENABLE=TRUE，v2 SPECULARENABLE=TRUE，v1–3 NORMALIZENORMALS=TRUE 等） | ✅；W+（`ddraw/device.c:2697-2722` `fixup_texture_alpha_op`、`6943-6953`；ddraw4 `11171-11273`、ddraw7 `16094-16101`、ddraw1 `2165-2170` 等）；4I2 |
| S2-48 | 对 GPU 写过的表面做 `DDLOCK_WRITEONLY` 锁定会擦掉内容 | `GD:3177, 3333-3335` | 软件光标或 HUD 叠在 D3D 帧上时，把整帧替换掉 | ✅；W（`ddraw/utils.c:570-571` WRITEONLY 只去掉读权限，内容保留；无 Windows 测试）；4I3 |
| S2-49 | `palette_SetEntries` 不触发呈现 | `GD:3833` | 只改调色板的淡入淡出不可见，要到下一次 Flip | ✅；W（`ddraw/palette.c:160-181` 主表面的调色板立即更新前台）；4I4 |
| S2-50 | 可见表面写入：丢失或越界 | `GD:2485, 2553, 3036, 3336`、`DO:356` | flip chain 下画在前缓冲的加载画面不可见；窗口模式 `Unlock(NULL)`/`ReleaseDC` 把整个桌面标脏，其他窗口被盖上旧桌面 | ✅；4I5 |
| S2-51 | 非主表面的 flip chain 错误 | `GD:2675`、`DO:717` | overlay flip chain 被 1:1 贴到交换链上，overlay 显示的是应用正在画的那块缓冲 | ✅；4I6 |
| S2-52 | 执行缓冲 `D3DPROCESSVERTICES_TRANSFORM` 丢掉 LVERTEX 颜色；传统视口映射被忽略 | `DL:2882, 2896-2897`；`DL:639-656, 780-820` | 预光照几何变白；D3DVIEWPORT 的 `dvScaleX/Y` 和 D3DVIEWPORT2 的 `dvClip*`、MinZ/MaxZ 应经裁剪空间矩阵生效（深度范围固定 0..1；`dvMaxX/Y` Wine 也不用） | ✅；4I7 |
| S2-53 | 对象生命周期 | `GD:4021, 4338, 4650, 3226, 3298` | 释放 flip chain 前缓冲时，隐式后缓冲及其 GPU 纹理全部泄漏，`flip_next` 悬空；经 IDirectDraw4/7 创建的表面应 AddRef DirectDraw 对象（DD1/DD2 不加），现在不加，v4/v7 应用先释放 DirectDraw 就会 use-after-free；SetPalette/SetClipper 先 Release 旧对象再 AddRef 新对象，设回同一个对象时会 AddRef 已释放的内存 | ✅；4I8 |
| S2-54 | 纹理 `Load` 不完整 | `D7:2573-2604`、`DL:1213-1240` | D3D7 `Load` 只拷第 0 级（没有 mip、没有立方体面），忽略 flags；`IDirect3DTexture2::Load` 不拷调色板和颜色键，mip 数不同时返回 BADSIZE（Wine 加载共同的级） | ✅；4I9 |
| S2-55 | DX3 `D3DLIGHT` 的 `dwFlags`=0 被当成“禁用” | `DL:580` | 传统灯光不起作用 | ✅；4I10 |
| S2-57 | 无源 BLACKNESS/WHITENESS 被拒；P8 表面没有调色板时 GetDC 的颜色表全黑 | `GD:2354, 2405-2415`；`GD:2959-2969` | 用 ROP 清屏的程序得到 `DDERR_INVALIDPARAMS`（WHITENESS 得 `NORASTEROPHW`）；GDI 文字不可见 | ✅；4I11 |

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

> **阶段 4H2b（2026-11-03）：共用持锁 VB/IB 绘制上传与锁状态保持（S2-34）完成。**
>
> - D3D8/9 共用纯 C 映射上传核和 SDK 类型适配：普通 Draw 上传当前绑定的持锁 VB，索引 Draw 再上传 IB；先校验所有描述，再上传唯一缓冲。重复绑定只上传一次，真正 READONLY 不上传，非索引 Draw 不提前上传持锁 IB。
> - 每次绘制读取当时的映射内容，保留锁状态、范围和 NOOVERWRITE；已接受的上传只消耗一次 DISCARD。后续上传失败仍保存已接受前缀的结果，不发送 Draw、不提交 ClipStatus 或镜像更新。传输自身可接受部分分块；失败的完整映射范围仍可重传。
> - 软件 Draw 输入显式允许持锁来源，ProcessVertices 保留原有拒绝规则；零图元不上传映射。实际两个前端函数验证了上传顺序、软件多流分类、失败原子性与锁状态；实际 Lock/Unlock 和不同布局的 VB/IB 测试覆盖 17 个映射、重复写入、只读/冲突/静态提示、零大小、重复绑定和部分失败。25/25 变异、四个录制语义破坏与 ASan/UBSan 通过；两个旧前端均在定向运行中失败。
> - XP 两 API 各七场景/三阶段，共 42 帧、98 次精确上传；验证 Unlock 前的两次绘制和改写、部分范围保留、32 位索引、只读省略及非索引绘制后延迟上传 IB。NOOVERWRITE/READONLY 场景不在首次绘制后改写。SwiftShader/Metal 各通过 126 个颜色探针，零宿主/GPU 错误；三 API T&L/状态块/生命周期与 D3D9 类型、颜色、多流及 ProcessVertices 锁定边界的 XP 回归通过。
> - 175 组核心、159 组客体、36 个 SDK 冒烟 EXE、六个严格 DLL及两项集成通过；发布 D3D8/9 最终 XP 验收原字节，DDraw 保持既有验收字节。宿主源码/运行包 `8cc48a9a2b75d0296e91` 未变，沿用既有完整 GPU/533 场景基线，本轮增加两次正向回放，完整目标现含 48 次运行。见 [stage4h2b-validation.json](fixtures/d3d-review/stage4h2b-validation.json)。
> - 4H2a/b 已覆盖 S2-34 原列出的提示/基址、零顶点、零图元和持锁绘制四类；依据为 Wine 实现与已知几何输入，未宣称原始 Microsoft 持锁像素或全部 Draw/UP/缺失绑定边界验收。接着零售复制语义、共用客体包装与阶段 4/5/6。

> **阶段 4H3（2026-11-03）：共用 UpdateTexture mip 匹配和有界复制（S2-35）完成。**
>
> - D3D8/9 的 2D、立方体和体积纹理改用同一个纯 C mip 匹配核与 SDK 类型适配。源尺寸更大时跳过顶层 mip；按实际剩余源级数和目标级数取较小值，立方体分别使用源、目标的面步长，体积匹配包含深度维度。
> - 先校验所有待复制层，再准备全部目标影子，最后复制和上传。最后一面元数据错误或准备阶段内存不足不会留下像素复制前缀；已分配的影子可保留复用。传输失败保留已接受的上传前缀。D3D9 延迟影子按需分配，并为三种纹理都设置有效标记。
> - 10 万组独立枚举、两个实际 SDK 入口各 42 组布局/延迟影子案例、25/25 语义变异及 ASan/UBSan 通过；覆盖源/目标级数不同、没有可用源 mip、跳过层持锁、最后一面错误、分配失败及精确上传字节。旧 2D 入口在实际运行中因延迟目标空影子被 ASan 拦截。
> - XP 两 API 各七场景，共 84 帧、598 次精确上传；覆盖完整/截短 2D 与立方体链、六个面、体积与深度主导切片、两套现有构造器支持的单级 RT 影子。初始化通过 SYSTEMMEM→DEFAULT UpdateTexture 写入保留值。SwiftShader/Metal 各通过 252 个颜色探针，零宿主/GPU 错误；三 API T&L、状态块和生命周期 XP 回归通过。
> - 177 组核心、162 组客体、36 个既有 SDK 冒烟 EXE、六个严格 DLL、两项集成通过。发布 D3D8/9 最终 XP 验收原字节，DDraw 保持既有验收字节。宿主源码和运行包 `8cc48a9a2b75d0296e91` 未变，沿用先前完整 GPU/533 场景基线并新增两次回放，完整 GPU 目标现含 49 次运行。见 [stage4h3-validation.json](fixtures/d3d-review/stage4h3-validation.json)。
> - 匹配尺寸来自固定 Wine 实现事实；理论匹配但源存储级数不足时安全成功且不复制，是明确的代理策略，不复现越界读取。保留 D3D9 池校验和 D3D8 既有宽松池规则；脏区、被复制层持锁及完整 UpdateTexture 契约仍未在本步全部验收。未宣称原始 Microsoft HAL 像素；接着 D3D8 表面复制/回读、共用包装与阶段 4/5/6。

> **阶段 4H4a（2026-11-03）：共用强制表面回读与 D3D9 接入（S2-36 前置）完成。**
>
> - CRT-free 共用模块集中管理完整线性像素行的分块、进程请求编号、应答空间、心跳/静默超时、ID/状态/长度检查及已接受行前缀。按“回读锁→传输锁”持锁等待，阻止共享映射在等待期间被其他前端关闭；宿主应答不需要这两把客体锁。静默上限仍为 6 秒，持续心跳的 15 秒积压测试成功。
> - D3D9 保留原有池、格式、对象与尺寸规则、有效影子快路径、前台透明度修正及目标有效标记。回读改用严格提交回调，容量预先 flush 和请求提交都返回真实传输失败，不采用普通绘制的丢批后继续策略。
> - 实际共用 C 覆盖四块精确行/填充、请求编号零值跳过与有符号回绕、时钟回绕、迟到/失败/长度错误、提交/预留失败及已接受前缀；实际 D3D9 入口 39 组检查、31/31 变异、ASan/UBSan 通过。165 组客体全量检查后，对新增严格提交路径进行了定向复验；178 组核心、36 个 SDK 冒烟 EXE、六个严格 DLL和两项集成通过。
> - XP 公开 GetRenderTargetData 使用明确的模拟宿主应答，验证两次完整 1024×1024 CPU 图像、1019/5 行分块，以及请求编号、失败状态和短长度三类首块错误后的保留值与恢复。真实 GPU 则独立回放已知整屏几何和全部七个回读请求：SwiftShader/Metal 各核对 5,227,520 个像素，零宿主/GPU 错误。模拟回复不作为 GPU 像素或原生 Microsoft HAL 证据。
> - 发布最终 XP 所测 D3D9 DLL 原字节；D3D8/DDraw 保持前期验收字节。宿主源码及运行包 `8cc48a9a2b75d0296e91` 未变，沿用先前完整 GPU/533 场景基线，新增两次最终回放；完整 GPU 目标现含 50 次运行。见 [stage4h4a-validation.json](fixtures/d3d-review/stage4h4a-validation.json)。接着将共用机制接入 D3D8 CopyRects/GetFrontBuffer/可锁 RT；S2-36 和阶段 4/5/6 继续。

> **阶段 4H4b（2026-11-03）：D3D8 表面复制、回读和锁定镜像（S2-36 像素来源与复制方向）完成。**
>
> - 不同 DEFAULT GPU 子资源通过现有 StretchRect 直接复制，包含 back buffer、普通纹理、立方体面与 mip；不经 CPU 回读。GPU 写入使目标 CPU 镜像失效，下一次 CPU 读取先刷新；RT 锁定始终读取 GPU。SYSTEMMEM/MANAGED/SCRATCH 保持 CPU 数据权威，即使此前镜像上传失败也不从旧 GPU 内容覆盖 CPU 数据。
> - 只读 Unlock 不上传；局部可写 RT 锁在修改前回读整层，保留渲染后的周围像素。上传失败保留镜像失效状态，部分上传不会把未知的周围像素标为有效；UpdateTexture 的上传结果也更新该标记。失败 Lock 撤销内部锁并保持调用者输出不变。
> - CPU 表面重叠复制使用快照；CPU image→back buffer 只为复制区域创建临时纹理、上传、blit、销毁。CopyRects 按 Wine 的相同格式、可省略目标点和零计数规则校验；目标范围以有界减法检查，避免 POINT 加法溢出。保留逐矩形的已接受前缀。GetFrontBuffer 读取实际代理输出面，保留更大 CPU 目标的外部区域，并将 ARGB 设为不透明。
> - 实际 D3D8 C 的 51 组检查、29/29 表面变异、既有 25/25 mip 变异与 ASan/UBSan 通过。覆盖 12 种 GPU 表面方向、立方体面步长、脏镜像、RT 局部锁、暂存生命周期、重叠/内存不足、越界/锁定/外国对象，以及回读与上传失败后的恢复。锁定 mip 的拒绝另有 Wine Windows 测试依据；其余未宣称完整原生 API 契约。
> - XP 公开 COM 验证红/绿渲染、蓝色局部 RT 改写、独立渐变快照、GPU/CPU 各方向、前台有效区域、立方体面/mip、锁定子资源拒绝和一次明确模拟的回读失败后的重试。逐条核对两次 Draw、四次上传、五次 GPU blit、六个纹理完整释放及设备销毁；11 次回读在 SwiftShader/Metal 各通过 38,912 个真实 GPU 像素。客体 CPU 的宿主回复是显式模拟，GPU 像素验收单独进行。
> - 180 组核心、167 组客体、36 个 SDK 冒烟 EXE、六个严格 DLL和两项集成通过。D3D8 发布最终 XP 验收原 DLL 字节；D3D9/DDraw 保持既有已验收字节。宿主源码/运行包 `8cc48a9a2b75d0296e91` 未变，沿用先前完整 GPU/533 场景基线并新增两次最终回放，完整 GPU 目标现含 51 次运行。见 [stage4h4b-validation.json](fixtures/d3d-review/stage4h4b-validation.json)。
> - GetFrontBuffer 仍采用代理输出面的坐标/尺寸契约，未宣称完整桌面、窗口偏移或原生 front/back 呈现时序。Clear 的 CPU 填充、附加交换链/COM 同一性、可锁 back buffer、完整 MSAA 边界和立方体 RT 绑定（S2-37）继续；本步的立方体验收针对复制与 CPU 镜像，不等同于渲染到立方体。接着目标绑定/创建及共用包装，阶段 4/5/6 继续。

> **阶段 4H5a（2026-11-03）：D3D8 立方体目标、NULL 颜色目标与实时视口（S2-37 / S2-56）完成。**
>
> - SetRenderTarget 使用共用表面定位器解析 2D、立方体和 back buffer，发送正确资源、face 与 mip。设备保留立方体父对象引用，重绑/清理先获取新引用并清空旧绑定再释放；当前尺寸、Clear 镜像和 GetRenderTarget 都选择实际立方体层，避免落到 back buffer 或零尺寸。
> - NULL 颜色参数仅更改深度，保留颜色资源/face/mip 与视口；深度尺寸按当前目标验证，较大允许、较小拒绝。解绑后的 GetDepthStencilSurface 返回 NOTFOUND 和 NULL。切换颜色目标通过与普通 SetViewport 共用的实时发射器恢复完整视口；这个绑定副作用不进入状态块录制，显式 SetViewport 仍按原规则延迟录制。
> - 实际 C 的 31 组检查、24/24 新变异、10/10 既有录制变异及 ASan/UBSan 通过。覆盖六面/两层的目标、深度、尺寸、查询、引用和清理，NULL 保留、有效较大深度、验证无副作用、录制/实时视口边界及传输错误前缀策略。
> - XP 公开 COM 完成 12 个立方体渲染场景，通过查询得到的目标回读；验证深度独立切换、录制期间视口重置、空录制块 Apply 不捕获该副作用、调用者释放后的父对象存活和 back buffer 保持。原始流逐项核对 25 次颜色绑定、62 次深度绑定、60 次视口更新、13 次 Clear、12 次 Draw、四个资源及设备销毁。SwiftShader/Metal 各通过 13 次回读、34,816 个真实 GPU 像素；所有较大深度目标都先清深度，未把跨尺寸历史深度内容纳入本次结论。
> - 182 组核心、169 组客体、36 个 SDK 冒烟 EXE、六个严格 DLL和两项集成通过。D3D8 发布最终 XP 验收原 DLL，D3D9/DDraw 保持既有已验收字节。宿主源码/运行包 `8cc48a9a2b75d0296e91` 未变，沿用先前完整 GPU/533 场景基线并新增两次最终回放；完整 GPU 目标现含 52 次运行。见 [stage4h5a-validation.json](fixtures/d3d-review/stage4h5a-validation.json)。
> - NULL 行为及深度错误依据固定 Wine Windows 测试；颜色查询已保持资源/face/mip 身份，COM 表面指针同一性仍留给 S2-42。客体 CPU 回复是显式模拟，GPU 像素单独验收，不宣称原生 Microsoft HAL、完整 Reset/MSAA 或游戏/FPS 验收。接着修复 MSAA 目标重复创建（S2-43）和相关元数据，随后继续共用包装及阶段 4/5/6。

> **阶段 4H5b（2026-11-03）：D3D8 MSAA 单次创建、表面描述和深度采样匹配（S2-43 / S2-42 部分）完成。**
>
> - 把颜色纹理构造收敛为带采样类型的内部入口；公开 CreateTexture 继续传 NONE，CreateRenderTarget 在第一次且唯一一次 CREATE 中传请求类型。删除同句柄先 NONE 再 4× 的重复创建。采样质量固定为 0，仅宣称后端能够表示的 NONE/4×。
> - 纹理承载表面、back buffer 和隐式深度表面的 GetDesc 返回实际采样类型；隐式深度尺寸采用呈现参数，未指定时才回退显示模式。SetRenderTarget 的显式颜色和 NULL 颜色两条路径都在引用/命令副作用之前检查颜色与深度采样类型一致；立方体仍为 NONE。
> - 原生编译实际构造方法运行 81 项检查，覆盖 64 次交替创建、精确首条命令、描述、锁定限制及分配/提交/表面转换失败清理；绑定检查扩展到 39 项。17/17 构造、28/28 绑定语义变异与 ASan/UBSan 通过；冻结命令的五种破坏均被捕获。
> - 真实 XP 使用 4× back buffer，交替创建 16 个 NONE/4× 目标；查询描述，拒绝显式和 depth-only 的不匹配绑定并保持视口，逐个绘制/回读，最后检查 back buffer 未被改写。18 个资源句柄各创建/销毁一次，设备与 owner 正常释放。客体 CPU 回复明确使用模拟；独立 SwiftShader/Metal 重放分别验证 17 次实际 GPU 回读和 20,480 个像素，零宿主/GPU 错误或丢弃。
> - 探针图形超出视口边界，保证所有样本覆盖；本项只验证 resolve、回读和生命周期，不把纯色结果称为 MSAA 边缘覆盖率验收。184 组核心、171 组客体、36 个标准 SDK 冒烟 EXE 与六份严格零售/诊断 DLL、站点两项集成通过；发布本次 XP 所测 D3D8 DLL。宿主及 `8cc48a9a2b75d0296e91` 运行包未变，完整 GPU 基线沿用 4H5a 加本次新页面（目标总计 53 次）。见 [stage4h5b-validation.json](fixtures/d3d-review/stage4h5b-validation.json)。
> - S2-42 的 SetLOD、光标、gamma、私有数据、Present 节流、表面 COM 同一性及附加交换链仍待继续；完整 Reset 边界、包装层转换及阶段 4/5/6 未宣称完成。

> **阶段 4H6a（2026-11-03）：共用资源 SetLOD 与 NONE/POINT 采样语义（S2-42 部分）完成。**
>
> - D3D8/9 的 2D、立方体和体纹理六个入口共用 MANAGED 池限制、级数夹取、DWORD 存储、旧值返回和 SET_TEXTURE_LOD 编码；D3D8 不再只改本地字段。其他三个池忽略请求；相同值仍发送，提交失败仍保存本地状态，与没有 HRESULT 的资源调用保持一致。
> - 按冻结的 Wine 共享纹理实现及 Windows visual 期望修正宿主：MIPFILTER=NONE 忽略 MAXMIPLEVEL，但采用资源 SetLOD；POINT 使用两者较大的层级下限。旧纹理复制探针原来用 NONE 配 MAXMIPLEVEL 选择 mip，本阶段改为明确使用 POINT 并重新采集 XP，避免回归依赖旧的错误采样。
> - 原生编译六个实际 C 方法，每个 API 435 项检查，覆盖三类纹理、四个池、完整 DWORD 请求、夹取、旧值、精确 wire 和失败后的同值重试；旧 D3D8 源码在运行时断言失败。18/18 语义变异与 ASan/UBSan 通过，宿主执行器 176 项检查通过。
> - 实际 XP 两 API 各创建并释放 12 个纹理，MANAGED 的三类纹理验证资源 LOD 在状态块录制期间实时生效且不随块 Apply 回滚，逐一运行七种 LOD/filter/MAXMIPLEVEL 组合。客体回复明确模拟；独立 SwiftShader/Metal 各检查 42 次实际 GPU 回读、172,032 个像素，全部逐字节一致。更新后的纹理复制捕获两后端各通过 84 帧、252 个颜色探针；五种 LOD 捕获破坏与四种复制捕获破坏均被捕获。
> - 186 组核心、173 组客体、36 个标准 SDK EXE、六份严格零售/诊断 DLL 和站点两项集成通过；完整 53 页 SwiftShader 目标与 Metal 533 项一致性通过，新/刷新两页另在 Metal 复跑。运行包更新为 `63c129acb57fb1c7d5b5`，发布两 API 本次 LOD XP 所测的零售 DLL；DDraw DLL 不变。见 [stage4h6a-validation.json](fixtures/d3d-review/stage4h6a-validation.json)。
> - 本步不代表完整 Reset、光标、gamma、私有数据、Present 节流、表面 COM 同一性、附加交换链、D3D8 包装或阶段 4/5/6 完成。参考：[Wine 共享 LOD 实现](https://github.com/wine-mirror/wine/blob/master/dlls/wined3d/texture.c)、[Wine Windows mip 像素期望](https://github.com/wine-mirror/wine/blob/master/dlls/d3d9/tests/visual.c)。

> **阶段 4H6b（2026-11-03）：共用 gamma 缓存/编码与 Reset 恢复（S2-42 / S1-9d 的 gamma 部分）完成。**
>
> - D3D8/9 共用默认线性曲线、复制式 WORD RGB 缓存、查询、flags 保存和 SET_GAMMA_RAMP 编码。D3D8 不再丢弃设置或返回全零，并宣称已验证的虚拟全屏 gamma；D3D9 保留原来的无效交换链查询行为。NULL 调用不改状态，状态块录制期间 gamma 立即生效且不被 Apply 回滚；void 设置在提交失败后保留请求缓存，允许同值重发。
> - 两 API 的实际 Reset 恢复函数都向新设备句柄重发已提供的曲线及其 flags；发送失败按现有 Reset 错误路径返回失败。修复 D3D9 原注释提到、实际未执行的 gamma 恢复。未设置曲线的默认设备无需多发命令。
> - 原生编译实际设置/查询/Reset，D3D8 21 项、D3D9 22 项检查覆盖三个完整 16 位色表、输入复制、默认值、flags、NULL/无效交换链、录制边界、失败缓存和 Reset 的成功/失败路径；旧 D3D8 源码在运行时断言失败。17/17 语义变异、ASan/UBSan 与五种捕获破坏检查通过。
> - 真实 XP 两 API 分别查询完整曲线、录制并应用空块、两次切换全屏/窗口参数后 Reset，合计 16 次 Clear/Present、14 次完整色表更新和四次恢复；两个 owner 正常释放。探针使用精确 64×64 客户区。SwiftShader/Metal 在每个完整 Present 批次结束后读取实际 scanout 和原始 back buffer，各核对 65,536 个显示像素及 65,536 个原始像素；显示采用预期曲线，原始图像保持绘制颜色，恢复线性曲线后也一致。
> - 188 组核心、175 组客体、36 个标准 SDK EXE、六份严格零售/诊断 DLL 和站点两项集成通过；发布本次 XP 所测两 API 零售 DLL。宿主与 `63c129acb57fb1c7d5b5` 运行包未变，沿用 4H6a 的完整 GPU 基线并新增两后端 gamma 用例（完整目标现为 55 次）。见 [stage4h6b-validation.json](fixtures/d3d-review/stage4h6b-validation.json)。
> - 本项测量虚拟显示 LUT；物理显示器校准及 calibration flags 的硬件效果不模拟。OS 全屏样式、显示模式/前台恢复与完整 Reset 仍待继续；光标、私有数据、Present 节流、表面 COM 同一性、附加交换链、D3D8 包装及阶段 4/5/6 未宣称完成。

> **阶段 4H6c（2026-11-03）：共用应用光标 API、GPU 图片源与正确 BGRA 显示（S2-42 的硬件光标部分）完成。**
>
> - D3D8/9 共用光标状态、A8R8G8B8/二次幂/适配器尺寸/锁状态校验、逐行图片复制与可选严格 GPU 回读。图片不保留来源 COM 引用；GPU 来源保持源设备、资源、mip 和 cube face，临时分配在失败与成功路径都释放。D3D8 宣称已验证的彩色虚拟光标能力。
> - 按 Wine Windows 测试修正 ShowCursor：设置图片前重复 TRUE 均返回 FALSE；首次设置图片保持隐藏，之后返回前一次可见状态。D3D9 的应用状态与 GDI 回退状态分开。公用坐标处理保留 D3D8 UINT 的有符号位模式，转换屏幕/客户区坐标并支持 focus-window 回退；32×32 路径同步 OS 位置，其他尺寸保留软件位置策略。
> - 原生编译两个实际入口及共用实现，各 31 项检查覆盖紧/填充/最大尺寸行、格式与边界、源引用、立方体 GPU 回读身份、分配/回读/提交失败清理、Show、坐标、warp/回退和接受前缀；32/32 语义变异与 ASan/UBSan 通过。既有回读变异测试改为选中函数定义，避免新增前置声明扩大抽取范围；原 31/31 回读变异和三 API 窗口/Present 检查继续通过。
> - 真实 XP 两 API 共运行 16 帧，验证 CPU 图片释放返回 0 后仍显示、前次 BOOL、仅 OS 移动时的跟随、负客户区坐标/热点、隐藏/显示及 cube face 4/mip 1 的 GPU 图片源。GPU 源客体回复明确模拟；独立 GPU 重放另检查实际两个 cube 回复的 2,048 个像素，并逐像素核对 65,536 个最终显示像素及 65,536 个原始 back-buffer 像素，原始图像保持绘制内容。
> - 四色/透明度参考暴露原宿主的红蓝互换：A8R8G8B8 展开保留 BGRA 字节，光标却创建为 RGBA8。改用 BGRA8 存储；旧宿主的彩色图案失败，修正后 SwiftShader/Metal 的透明、半透明、热点和裁剪均通过。宿主执行器 176 项、190 组核心、177 组客体、36 个标准 SDK EXE、六份严格 DLL、站点两项集成通过；完整 55 页 SwiftShader 与 Metal 533 项一致性复跑通过。运行包更新为 `a532e70eacef8cba3d10`，发布两 API 本次 XP 所测 DLL。见 [stage4h6c-validation.json](fixtures/d3d-review/stage4h6c-validation.json)。
> - 本项核对 32×32 应用图片的虚拟硬件光标；物理 HCURSOR 替换、D3D8 自动 GDI 捕获、非 32 尺寸软件光标写入 render target 的原生效果及完整 Reset 仍待继续。私有数据、Present 节流、表面 COM 同一性、附加交换链、包装转换与阶段 4/5/6 未宣称完成。

> **阶段 4H6d1（2026-11-03）：共用私有数据存储与 D3D8/9 顶点/索引缓冲（S2-42 部分）完成。**
>
> - 新增无 CRT 的共用 GUID 存储；两 API 的 VB/IB Set/Get/FreePrivateData 接入同一实现。原始字节复制、大小查询、MOREDATA/NOTFOUND、失败覆盖保留旧值，以及 IUNKNOWN 的 Set/Get/替换/销毁引用按固定 Wine Windows 测试和实现核对。已存在条目的 NULL size 安全拒绝；不复制 Windows 的访问异常。
> - 不可变条目在 Get 期间持有内部引用；分配、释放和 COM 回调均在锁外进行。验证 AddRef 回调删除同一 GUID、旧对象释放时查询新值、Clear 回调重新插入、size/输出重叠与未对齐访问。最终缓冲释放先移出设备资源链，再清理私有接口，保留设备直到回调完成。
> - 共用实现 14 项、每 API 实际入口/释放路径 14 项、四线程 8,000 次并发 Set/Get/Clear、19/19 语义变异以及 ASan/UBSan/TSan 通过。真实 XP 两 API 验证 VB/IB 字节、查询、引用和最终 Release，两个 owner 退出，140 秒；冻结轨迹及日志可重验，四项损坏均被发现。
> - 191 组核心、180 组客体、36 个标准 SDK EXE、六份严格 DLL和站点两项集成通过；发布本次 XP 所测两 API 零售 DLL及严格诊断 DLL。仅改变客体 CPU 存储/引用路径，宿主与运行包 `a532e70eacef8cba3d10` 不变，沿用 4H6c GPU 基线。见 [stage4h6d1-validation.json](fixtures/d3d-review/stage4h6d1-validation.json)。
> - 接着接入纹理、cube/volume 与逻辑子资源存储；S2-42 其余部分、完整 Reset、包装转换及阶段 4/5/6 仍待继续。

> **阶段 4H6d2（2026-11-03）：纹理及逻辑 mip/face/volume 子资源私有数据（S2-42 部分）完成。**
>
> - 两 API 的 2D/cube/volume 纹理接入同一私有数据存储；父纹理与每个 mip/face 各自拥有独立 GUID 域。子表面/volume 视图访问所属逻辑 level 的存储，释放并重新获取视图后仍可查询；最后一个父/子引用退出时，逐一清理父存储及全部 level 存储。
> - 每 API 26 项实际 C 入口/销毁测试覆盖父子隔离、cube 六面和各 mip、重复视图、大小/错误和接口引用；30/30 语义变异、ASan/UBSan 通过。另直接编译六种生产纹理结构和转换函数，验证 COM 接口位于偏移 0；字段前置的错误布局在原生测试失败，DLL 构建也加入编译期约束。
> - 真实 XP 两 API 分别验证 2D 两级、cube 三个面/级组合、volume 两级：父子数据独立、重新获取后保留内容、父引用先释放时子引用仍存活、最后退出仅保留调用者自己的接口引用。两个 owner 正常退出，117 秒；冻结轨迹另核对十个缓冲/纹理资源的完整生存期，五项轨迹/日志损坏均被发现，不产生 GPU 上传或读回。
> - 192 组核心、183 组客体、36 个标准 SDK EXE、六份严格 DLL及站点两项集成通过；发布本次 XP 所测两 API 零售 DLL和严格诊断 DLL。宿主及运行包不变，继续沿用 4H6c 的 GPU 基线。见 [stage4h6d2-validation.json](fixtures/d3d-review/stage4h6d2-validation.json)。
> - 接着完成独立/隐式表面私有数据；S2-42 的 Present 节流、表面 COM 同一性、D3D8 附加交换链，完整 Reset、包装转换及阶段 4/5/6 仍待继续。

> **阶段 4H6d3（2026-11-03）：独立/隐式表面与交换链 back-buffer 私有数据（S2-42 部分）完成。**
>
> - 两 API 的独立 image/offscreen、render-target、depth 表面接入共用存储及实际销毁清理。D3D9 隐式 back/depth 存储随缓存表面保留，到设备销毁时清理；D3D8 的隐式 back/depth 包装尚未缓存，改由设备分别持有逻辑存储，跨 Release/Get 保留数据。
> - D3D8 附加交换链的私有存储单独分配并计数，交换链和各表面包装各持一份内部引用，不改变公开 COM 引用计数。交换链释放返回 0 后已有表面仍可查询，最后一份表面退出时才清理；与设备隐式 back buffer 隔离。覆盖链对象/存储分配失败及表面创建失败的清理。
> - 实际 C 表面/设备/链释放路径分别通过 D3D8 10 项、D3D9 7 项，19/19 私有存储语义变异及 ASan/UBSan 通过。原 MSAA 原生夹具补充隐式存储指针检查，81 项及扩展后的 19/19 变异通过，包含两条隐式 back/depth 路由的退化检测。
> - 真实 XP 两 API 分别验证三个独立表面、隐式 back/depth 的重新获取、父设备退出、交换链先退出及两份表面引用的最后清理。两个 owner 正常退出，120 秒；冻结轨迹核对 15 个缓冲/纹理资源及 D3D9 附加交换链完整销毁，六项轨迹/日志损坏均被发现。
> - 193 组核心、185 组客体、36 个标准 SDK EXE、六份严格 DLL和站点两项集成通过；发布本次 XP 所测两 API 零售 DLL和严格诊断 DLL。宿主/运行包未改，沿用 4H6c GPU 基线。见 [stage4h6d3-validation.json](fixtures/d3d-review/stage4h6d3-validation.json)。
> - 私有数据的常规资源/子资源/表面路径已接入；完整 Reset 存储边界、COM 表面指针同一性、D3D8 附加交换链像素独立性仍待相关步骤验收。继续 Present 节流及其余 S2-42，随后继续包装转换和阶段 4/5/6。

> **阶段 4H6e1（2026-11-03）：共用设备 Present 节流、D3D8 间隔转换与可靠计时（S2-42 部分）完成。**
>
> - 新增无 CRT 的共用 deadline/时钟实现，接入 D3D8/9 Device.Present；D3D9 隐式交换链继续转发此入口。按固定 DXVK 参数转换保留 D3D8 差异：普通窗口立即呈现，COPY_VSYNC 窗口等待一次刷新，全屏 COPY_VSYNC 的 IMMEDIATE 同样转为 ONE。附加交换链的独立节流/标志留给相关步骤。
> - 计数器与频率在 QPC 失败/停滞时一起切换到毫秒回退，修正原 D3D9 回退后仍沿用旧频率的问题；保留分数 tick 和不足一毫秒欠账。Windows Sleep 可能提前醒，按剩余时间重验、增加停滞短等待，限定重试次数；时钟跳变/长延迟重新建立节奏。只有 emitter 返回成功时推进节奏，等待发生在传输锁外；IMMEDIATE 和既有环境开关均跳过节流。
> - 独立解析式覆盖 241 项、1,461,000 帧及 10 ms 提前/延迟唤醒；两个实际公开入口分别通过 64/36 项，覆盖关闭节流、极端计数频率/位移、QPC 失败/冻结、窗口交换效果、已报告失败的呈现及锁外等待。27/27 语义变异和 ASan/UBSan 通过；上一版 D3D8 全屏入口在可控时钟验收中运行失败，单次 Sleep 原型也被提前唤醒模型发现。
> - 真实 XP 每 API 五种合法参数组合各运行 12 帧，共 120 组 Clear/Present、十个设备生存期、两个 owner 退出，145 秒。独立 QPC 测量验证七组同步间隔，普通 D3D8 窗口和两版全屏 IMMEDIATE 保留立即语义；冻结轨迹/日志的六项损坏被发现。测量虚拟 deadline 和命令序列，未执行物理 GPU/vblank、原生 HAL 或游戏/FPS 验收。
> - 195 组核心、188 组客体、36 个标准 SDK EXE、六份严格 DLL及站点两项集成通过；发布本次 XP 所测两 API 零售 DLL和严格诊断 DLL。宿主/运行包未改，沿用 4H6c GPU 基线。见 [stage4h6e1-validation.json](fixtures/d3d-review/stage4h6e1-validation.json)。
> - 继续呈现参数的零售校验、附加交换链及其标志/节流、COM 表面同一性、完整 Reset，随后继续包装转换及阶段 4/5/6；本项未宣称 S2-42 或阶段 4 完成。

> **阶段 4H6e2（2026-11-03）：共用呈现间隔零售校验与失败原子性（S2-42 部分）完成。**
>
> - CreateDevice、Reset、CreateAdditionalSwapChain 的六个 D3D8/9 入口接入同一纯校验实现；能力表与校验共用 ONE/IMMEDIATE 掩码。D3D8 窗口仅接受 DEFAULT；D3D9 窗口接受 DEFAULT/ONE/IMMEDIATE；全屏非默认值须是单一已公布能力。组合位、保留位及未公布的多刷新间隔在分配、窗口修改和 Reset 状态变更前拒绝。
> - 1,797 项能力子集/版本/窗口组合、两版实际入口前缀各 73 项、18/18 语义变异及 ASan/UBSan 通过；入口前缀对合法参数停在分配前，完整成功路径另由 XP 验证。保留实际独立/隐式表面与附加链私有存储原生测试；上一版 D3D8 的无校验入口在运行时负面对照中失败。
> - 真实 XP 两 API 共拒绝 116 次无效调用，逐次检查参数/输出及拒绝 Reset 后的自定义视口；六个成功设备生存期、四次合法 Reset、四个附加交换链及六帧继续呈现全部通过，两个 owner 正常退出。冻结轨迹核对成功创建/Reset 数量和资源退出，六项语义损坏被发现；无效调用未产生这些 GPU 命令。
> - 197 组核心、191 组客体、36 个标准 SDK EXE、六份严格 DLL及站点两项集成通过；发布本次 XP 所测两 API 零售 DLL和严格诊断 DLL。宿主/运行包不变，沿用 4H6c GPU 基线。见 [stage4h6e2-validation.json](fixtures/d3d-review/stage4h6e2-validation.json)。
> - 本项仅完成 interval 字段；其余呈现参数、完整 Reset、附加交换链节流/标志和 D3D8 独立像素、表面 COM 同一性继续处理。未宣称原生 Microsoft HAL、完整 S2-42 或阶段 4/5/6 完成。

> **阶段 4H6e3（2026-11-03）：附加交换链独立节流与 D3D9 DONOTWAIT（S2-42 部分）完成。**
>
> - D3D8/9 附加交换链分别持有时钟及 deadline；D3D8 普通窗口保持立即语义，COPY_VSYNC 接入同步节奏。D3D9 隐式链继续共享设备节奏，附加链互不影响，成功提交后才更新状态。
> - 共用 deadline 转换同时服务等待和非阻塞路径。D3D9 DONOTWAIT 在虚拟间隔未到时返回 WASSTILLDRAWING，不提交帧、不调用 Sleep，也不推进状态；成功提交才发布候选 deadline，已报告的提交失败丢弃候选。LINEAR_CONTENT 可组合接受；默认能力未宣称线性到 sRGB 转换，既有显式 permissive 诊断模式保持原用途。
> - 原 241 项/1,461,000 帧等待模型继续通过，新增 134 项/128,000 帧非阻塞解析式与边界检查；实际链入口 D3D8 24 项、D3D9 60 项覆盖链/设备独立、隐式连续性、计时回退、关闭节流、窗口覆盖、组合标志和失败原子性。19/19 新增变异、27/27 保留变异及 ASan/UBSan 通过；两版上一提交的无附加节流入口均在运行时负面对照失败。
> - 真实 XP 两 API 各运行立即/同步两模式，每模式两条链各 12 帧；D3D9 另验证显式和隐式 DONOTWAIT 的忙碌/可用调用。轨迹共 100 次成功呈现、八个附加链生存期、两个 owner 退出，四行独立 QPC 记录中两行验证同步下限；六项轨迹/计时损坏被发现。命令收发已执行，GPU 像素与物理硬件队列就绪不在此验收范围。
> - 198 组核心、194 组客体、36 个标准 SDK EXE、六份严格 DLL及站点两项集成通过；发布本次 XP 所测两 API 零售 DLL和严格诊断 DLL，宿主/运行包不变，沿用 4H6c GPU 基线。见 [stage4h6e3-validation.json](fixtures/d3d-review/stage4h6e3-validation.json)。
> - 继续表面 COM 同一性、D3D8 附加链独立 back buffer、其余呈现矩形/标志与完整 Reset，随后继续包装转换和阶段 4/5/6；本项未宣称完整 S2-42 或阶段 4 完成。

> **阶段 4H6f1（2026-11-03）：D3D8 纹理子视图 COM 同一性及共享父引用计数（S2-42 部分）完成。**
>
> - 2D/cube/volume 的每个逻辑 level 缓存自己的 surface/volume 视图；重复获取、释放全部公开视图后重新获取、IUnknown 查询均保持同一对象，cube 各面及不同 level 不混用。缓存没有独立父引用，最终父纹理销毁时释放全部包装。
> - 按固定 Wine Windows 引用测试及 D3D8 surface/volume 实现，所有子视图公开 AddRef/Release 转发父纹理计数；子引用可独立保留父纹理到最后退出。独立表面的原有计数与私有数据所有者保持原路径。
> - 实际 C 获取、QueryInterface、引用与最终释放路径 105 项覆盖 16 个子资源、分配失败、缓存绕过分配、共享返回值及无缓存泄漏；18/18 新增变异、ASan/UBSan 通过。保留私有纹理测试补充两版缓存对象清理，26 项/API 及 30/30 原有变异继续通过；上一版 D3D8 的重复获取在运行时负面对照失败。
> - 真实 XP 以 D3D9 为对照，两 API 各遍历 16 个视图（cube 六面各两级），核对活跃/重新获取/IUnknown/container 身份、父子计数、私有数据保持及最后子引用退出。另复跑既有 VB/IB、纹理、独立/隐式表面与交换链私有数据探针；四个 owner 正常退出，113 秒。冻结轨迹核对 21 个资源完整释放，六项轨迹/日志损坏被发现。
> - 199 组核心、196 组客体、36 个标准 SDK EXE、六份严格 DLL及站点两项集成通过；发布本次 XP 所测两 API 零售 DLL和严格诊断 DLL。宿主/运行包不变，沿用 4H6c GPU 基线。见 [stage4h6f1-validation.json](fixtures/d3d-review/stage4h6f1-validation.json)。
> - 本项为客体 COM/存储生命周期验收，未执行 GPU 像素或原生 Microsoft HAL；并发缓存发布、隐式/附加链表面同一性及 Reset 边界继续处理。S2-42、D3D8 包装转换和阶段 4/5/6 未宣称完成。

> **阶段 4H6f2（2026-11-03）：隐式表面 COM 同一性、归零恢复及设备引用转换（S2-42 部分）完成。**
>
> - D3D8 设备缓存隐式 back/depth 包装；GetRenderTarget 与 GetBackBuffer 返回同一对象。两 API 的隐式表面公开引用独立于设备计数：仅 0→1 保留设备、1→0 释放设备，0 时重复 Release 返回 0，缓存对象可在设备仍存活时恢复引用。最后设备退出时清理缓存及私有数据。
> - 两版设备 GetBackBuffer 按 Wine Windows 测试忽略 mono/left/right/未知 type 选择值；索引仍校验。补上 D3D9 自动深度表面 GetContainer 的设备接口身份及引用。D3D8 区分设备自己持有的默认深度引用与调用者额外引用，避免仅恢复默认目标后 Reset 永久失败；成功 Reset 更新缓存的尺寸、格式、采样及字节布局。
> - 实际获取/引用/设备销毁入口各 20 组生命周期检查，覆盖缓存分配失败、重复获取、归零恢复、设备先退出、默认深度的内部/外部引用差别及容器查询；23/23 新增语义变异和 ASan/UBSan 通过。保留 105 项子视图、39 项 render-target、81 项 MSAA 与独立/隐式私有存储检查；其 18/28/19/19 项变异继续通过。分别恢复上一提交的 D8 获取入口及 D9 AddRef 函数原体，均在运行时负面对照失败。
> - XP 两版验证活跃/归零/重新获取/IUnknown/container 身份、原始私有数据、独立表面与设备计数、stereo 容忍、设备先退出、仅设备持有默认目标时成功 Reset，以及 80×72/4×MSAA 描述更新；另复跑完整私有数据/表面探针，四个 owner 正常退出，140 秒。冻结轨迹确认两次 Reset、默认目标绑定和既有 15 个资源清理，六项轨迹/日志损坏被发现。
> - 200 组核心、198 组客体、36 个标准 SDK EXE、六份严格 DLL及站点两项集成通过；发布本次 XP 所测两 API 零售 DLL和严格诊断 DLL。宿主/运行包不变，沿用 4H6c GPU 基线。见 [stage4h6f2-validation.json](fixtures/d3d-review/stage4h6f2-validation.json)。
> - 本项验收客体 COM/元数据，不宣称物理 MSAA、GPU 像素或原生 HAL。D3D9 外部隐式引用的 Reset 拒绝、完整 Reset 私有数据/资源边界、并发缓存发布、附加交换链表面与独立像素继续处理；S2-42、包装转换及阶段 4/5/6 未宣称完成。

> **阶段 4H6f3a（2026-11-03）：Reset 资源图检查及设备内部引用区分（S1-9 / S2-42 部分）完成。**
>
> - D3D8/9 共用 DEFAULT 资源阻塞判定，逐项核对 VB、IB、2D、cube、volume 的外部引用及锁定状态；扣除设备自己持有的 stream、sampler、目标与深度引用，设备内部绑定可在 Reset 清理。SYSTEMMEM/SCRATCH 的映射保持有效，managed 纹理保留内容及私有数据。
> - 隐式 back/depth 的外部引用和仍存活的附加链视图会阻止 Reset；D3D9 独立目标的 backing texture 按表面唯一计数，重复绑定到多个槽位不会重复扣除，调用者仍持有表面时不会误判成内部资源。检查阶段不改写资源图。
> - 实际 C 资源图 D3D8 580 项、D3D9 587 项，覆盖五类资源、四种 pool、列表尾、最后 stream/sampler、全部 cube 面及内外引用差别；33/33 新增语义变异、23/23 保留隐式生命周期变异和 ASan/UBSan 通过。
> - 真实 XP 两 API 各执行 15 次成功、7 次拒绝 Reset，覆盖应用持有、仅设备绑定、CPU 锁定、隐式表面及默认目标恢复；managed 标记和私有数据逐次保持。两个 owner 正常退出，114 秒，冻结轨迹核对 30 次 Reset、30 个资源退出，六项语义损坏被发现。
> - 同一 XP 轨迹在 SwiftShader 和 Metal 各重放一次，两 API 最终帧的 managed 纹理和清屏区域均正确；每后端原始图像 4096、显示图像 4096 个像素比较均为零误差，无 GPU/宿主错误。201 组核心、200 组客体、36 个标准 SDK EXE、六份严格 DLL及站点两项集成通过；发布本次 XP 所测两 API 零售 DLL和严格诊断 DLL。宿主/运行包不变，另保留 4H6c 全量 GPU 基线。见 [stage4h6f3a-validation.json](fixtures/d3d-review/stage4h6f3a-validation.json)。
> - 下一步继续 Reset HRESULT/设备状态；公开绑定引用计数、完整 Reset 私有数据/模式边界、并发缓存、附加交换链独立像素及后续包装转换和阶段 4/5/6 仍未完成。本项不宣称原生 Microsoft HAL 或完整 S2-42 验收。

> **阶段 4H6f3b（2026-11-03）：Reset 返回码、协作状态及失败期间的 Present（S1-9 / S2-42 部分）完成。**
>
> - 两版设备共用 Reset 状态：开始重置即进入可重试的 NOTRESET，所有失败出口保持该状态，完整 Reset 和默认状态重放成功后才恢复可用。TestCooperativeLevel 返回实际状态；查询或释放阻塞资源不会自行恢复设备。D3D8 资源阻塞返回 DEVICELOST，D3D9 保持 INVALIDCALL，按固定 Wine Windows 测试区分。
> - 设备及隐式/附加交换链 Present 在需要重置时返回 DEVICELOST，先于提交、窗口探测、节流和 DONOTWAIT deadline 处理；不会产生帧或推进计时。此步骤只建模虚拟适配器的 Reset 失败，不把物理失焦或设备移除混入同一状态。
> - 实际 C Reset、协作查询和 Present 入口各 363 项、12 类失败出口，覆盖参数/资源拒绝、内存和提交失败、状态重放失败、反复查询/重试、设备隔离及恢复后继续呈现；19/19 新增语义变异及 ASan/UBSan 通过。原参数、设备节流和交换链节流的 18/27/19 项变异继续通过，上一提交两版源码均被运行时负面对照发现。
> - 真实 XP 两 API 各核对 7 次资源拒绝、28 次 NOTRESET 查询、7 次 DEVICELOST Present 及 15 次成功 Reset 后的可用状态，日志保存实际 HRESULT；两 owner 正常退出，114 秒。冻结轨迹保持 30 次成功 Reset、30 个资源完整退出和两帧，失败 Present 无对应提交；八项日志/轨迹语义损坏被发现。
> - 同一新轨迹在 SwiftShader 和 Metal 各重放一次，每后端原始/显示各 4096 个参考像素零误差，无 GPU/宿主错误。202 组核心、202 组客体、36 个标准 SDK EXE、六份严格 DLL及站点两项集成通过；发布本次 XP 所测零售 DLL和严格诊断 DLL。宿主/运行包不变，保留 4H6c 全量 GPU 基线。见 [stage4h6f3b-validation.json](fixtures/d3d-review/stage4h6f3b-validation.json)。
> - 接着修复 Reset 对活动 Scene 的处理，再继续状态块/私有数据、窗口/全屏模式及附加交换链边界；物理设备丢失、线程约束、公开绑定引用计数、完整包装转换和阶段 4/5/6 仍待完成。

> **阶段 4H6f3c（2026-11-03）：Reset 对活动 Scene 的处理（S1-9 / S2-42 部分）完成。**
>
> - 按两版固定 Wine Windows `test_scene`，更正 4H6f3a 将活动 Scene 作为资源阻塞的判定：只要资源图允许，Scene 内可成功 Reset。重置命令成功排入队列后清除旧 Scene；此前拒绝的 Reset 保留其标志，后续默认状态重放失败则维持 NOTRESET。成功后 EndScene 返回 INVALIDCALL，新的 BeginScene/EndScene 正常工作。
> - 实际 C Reset/Scene/协作状态/Present 每版 411 项，12 类失败路径同时检查 Scene 的保持或清理；资源图保留 580/587 项并修正活动 Scene 期望。状态 23/23、资源图 35/35 语义变异和 ASan/UBSan 通过，上一提交两版源码均在运行时负面对照失败。
> - 真实 XP 每版 8 次在活动 Scene 中成功 Reset、15 次拒绝旧 EndScene、15 对新 Scene；原 7 次失败 Reset、28 次 NOTRESET 查询、7 次失败 Present、managed 像素和私有数据继续通过。两个 owner 正常退出，115 秒；冻结轨迹逐 owner 验证 24 次 Begin、16 次 End、8 次由 Reset 结束 Scene，资源保持 30 次成功 Reset、30 个完整退出，十项日志/轨迹语义损坏被发现。
> - 新 XP 轨迹在 SwiftShader 和 Metal 各重放一次，每后端原始/显示各 4096 个参考像素零误差，无 GPU/宿主错误。203 组核心检查、14 组相关客体回归及变异、36 个标准 SDK EXE、六份严格 DLL及站点两项集成通过；其余客体检查继承 4H6f3b 的 202 组完整基线。发布本次 XP 所测零售 DLL和严格诊断 DLL；宿主/运行包不变，另保留 4H6c 全量 GPU 基线。见 [stage4h6f3c-validation.json](fixtures/d3d-review/stage4h6f3c-validation.json)。
> - 继续完整 Reset 的状态块/私有数据与窗口/全屏切换，再处理附加交换链和包装转换；物理设备丢失、线程约束、公开绑定引用计数及阶段 4/5/6 仍未宣称完成。

> **阶段 4H6f4a（2026-11-03）：D3D9 Reset 显示模式、窗口样式与 WM_SIZE 保护（S1-9d / S2-42 部分）完成。**
>
> - Reset 接入已有全屏模式/前台策略，支持窗口→全屏、全屏变分辨率、更换设备窗口及恢复桌面与原样式；保存的原样式不会被后续全屏样式覆盖。模式设置失败保留既有显示模式所有权，恢复桌面失败保留恢复标志，并使 Reset 维持 NOTRESET。
> - 新共用窗口作用域在模式/样式变更期间过滤 WM_SIZE，防止游戏在消息回调中再次 Reset；ANSI/Unicode 原过程与其他消息保持转发，支持同窗口嵌套 DLL 作用域，退出时恢复过程和属性。旧设备窗口、新设备窗口、焦点窗口去重后受保护；分配/子类化失败完整撤销，窗口已销毁或应用已换过程时不覆盖其变化。
> - 共用窗口保护 64 项、实际模式入口 25 项，公共 Reset/Scene/协作状态 D3D8 411 项、D3D9 469 项；25/25 新增语义变异、保留状态 23/23、资源图 35/35 及 ASan/UBSan 通过。上一版 D3D9 Reset 未执行模式处理或最终窗口报告，在运行时负面对照失败。
> - 最终真实 XP ANSI/Unicode 各完成 128×128 窗口、640×480 全屏、无效 33×33 模式拒绝及恢复、800×600 全屏、更换设备窗口、回到窗口模式；每版五次成功 Reset、一次拒绝、六帧，Reset 期间零 WM_SIZE，八次自定义消息及八次位置消息正常转发，原窗口过程/样式与桌面模式恢复。两个 owner 正常退出，111 秒；back buffer 通过表面描述核对，客户区和实际显示模式独立检查。
> - 冻结轨迹核对十二次已排队 Reset（其中两次在物理模式设置时失败）、十次成功切换、十二帧和最终窗口报告；失败期间 Present 无帧提交，十项语义损坏被发现。SwiftShader、Metal 各重放一次，每后端原始/显示各 2,868,736 个像素全图零误差，无 GPU/宿主错误。
> - 204 组核心、205 组客体、36 个标准 SDK EXE、六份严格 DLL、另两份模式 SDK EXE及站点两项集成通过；发布本次最终 XP 所测 D3D9 零售 DLL和严格诊断 DLL，D3D8/DDraw 保留已验收文件。宿主/运行包不变，保留 4H6c 全量 GPU 基线。见 [stage4h6f4a-validation.json](fixtures/d3d-review/stage4h6f4a-validation.json)。
> - 下一步更正实际适配器显示模式查询，并接入 D3D8 模式切换。精确焦点窗口策略、刷新率/色深归一化、完整构造参数、并发子类化、物理设备丢失、完整 Reset/交换链及包装转换和阶段 4/5/6 仍待完成；不宣称物理模式失败时宿主命令尚未排队或原生 Microsoft HAL 验收。

> **阶段 4H6f4b（2026-11-03）：D3D8/9 共用实际适配器显示模式查询（Reset / S2-42 相关）完成。**
>
> - 五个工厂/设备/交换链公开入口统一读取当前 Win32 适配器模式。D3D8 工厂不再固定报 1024×768，两版设备和 D3D9 链不再把缓存的 back buffer 尺寸当作适配器模式；内部缓冲几何保持原值。共用查询保留既有 D3D9 的查询失败回退与未知刷新率按 60 处理的约定。
> - 实际 C 入口 D3D8 113 项、D3D9 170 项，覆盖逐次读取、尺寸/格式/刷新率、零尺寸/查询失败回退、无效输入、输出边界及设备缓存不变；22/22 语义变异、两版上一提交的运行时负面对照、ASan/UBSan 及每版 31 项光标检查通过。
> - XP 两版各运行六次独立 Win32 对照快照，覆盖 640×480/800×600、16/32 位色深、同设备期间的实际模式变化和原桌面恢复；工厂、设备及 D3D9 隐式/附加链均读到实际模式，back buffer 始终为 128×128。两个 owner、八个设备生命周期及四条附加链/四个 backing texture 正常退出，133 秒。
> - 按官方定义，GetNumberOfSwapChains 只统计 CreateDevice 创建的隐式链；存在附加链时仍为 1，设备查询索引 1 仍拒绝，附加链通过自身接口查询。该边界已加入 XP 验收，未把附加链误计入设备的隐式序号。
> - 冻结轨迹确认查询不产生 Reset/绘图/呈现命令，资源全部释放，十项日志/轨迹语义损坏被发现。205 组核心、13 组相关客体回归及变异、36 个标准 SDK EXE、六份严格 DLL、另两份查询 SDK EXE及站点两项集成通过；其余客体检查继承 4H6f4a 的 205 组完整基线。发布本次 XP 所测两版零售 DLL和严格诊断 DLL，DDraw 保持原验收文件。见 [stage4h6f4b-validation.json](fixtures/d3d-review/stage4h6f4b-validation.json)。
> - 本项没有新增 GPU 像素运行，宿主/协议/着色器未改，继承 4H6f4a 模式像素与 4H6c 全量 GPU 基线。继续 D3D8 模式切换、完整 Reset/交换链、包装转换和阶段 4/5/6；不宣称完整刷新率/色深归一化、适配器组、物理设备丢失或原生 HAL/游戏/FPS 验收完成。

> **阶段 4H6f4c（2026-11-03）：D3D8/9 共用模式切换及受保护的全屏构造（S1-9d / S2-42 部分）完成。**
>
> - 全屏进入、桌面/样式恢复、窗口替换、前台与输入队列处理、三窗口 WM_SIZE 保护均移入同一份 runtime 策略。前端只提供类型明确的 HWND/LONG/BOOL/DWORD 字段绑定，保持私有布局；D3D8 的 CreateDevice、Reset 和最终设备释放接入该策略，D3D9 移除对应重复实现。
> - 两版 CreateDevice 同样保护模式变更消息；模式设置失败返回 INVALIDCALL、输出保持 NULL，清理已排队的宿主设备及客体引用。D3D8 Reset 在模式成功后更新跟踪窗口并发布最终窗口报告，物理模式失败保持 NOTRESET。输入队列仅在需要时连接，成功连接后必定断开，连接失败仍按既有前台策略尝试激活。
> - 实际模式入口各 29 组、Reset/Scene/协作状态各 469 项及 13 类失败，覆盖 ANSI/Unicode、前台线程差异/连接失败、模式/样式/窗口替换和完整撤销；40/40 语义变异、保留状态/资源/COM/私有数据回归及 ASan/UBSan 通过。上一版 D3D8 缺少模式处理和最终报告，在运行时负面对照失败。
> - XP 四个进程覆盖 API8/API9 × ANSI/Unicode，每个各完成五次成功 Reset、一次无效模式 Reset、一次成功全屏构造和一次无效全屏构造；窗口和全屏七帧、原过程/样式与桌面恢复均通过，模式变更期间零 WM_SIZE，其他消息继续转发。四个 owner 正常退出，144 秒；十二个设备生存期包含四个拒绝构造，冻结轨迹确认全部退出、二十四次已排队 Reset 与二十八帧，十四项语义损坏被发现。
> - SwiftShader、Metal 各重放一次新轨迹，每后端原始/显示各 6,966,272 个像素全图零误差，无 GPU/宿主错误。206 组核心、207 组客体、36 个标准 SDK EXE、六份严格 DLL、另四份模式 SDK EXE及站点两项集成通过；发布本次 XP 所测两版零售 DLL和严格诊断 DLL，DDraw 保留已验收文件。宿主/运行包不变，另保留 4H6c 全量 GPU 基线。见 [stage4h6f4c-validation.json](fixtures/d3d-review/stage4h6f4c-validation.json)。
> - 继续完整 Reset 的状态块/私有数据及呈现参数边界、附加交换链与包装转换。精确焦点窗口策略、完整刷新率/色深归一化、并发子类化、物理设备丢失、线程约束、原生 HAL/游戏/FPS 和阶段 4/5/6 均未宣称完成；物理模式失败仍可能发生在宿主命令已排队之后。

> **阶段 4H6f4d（2026-11-03）：Reset 取消正在录制的状态块及资源引用（S1-9 / S2-39 相关）完成。**
>
> - 两版先验证呈现输入，再取消活动录制、释放录制持有的对象，之后检查资源阻塞。仅由录制持有的 DEFAULT 资源不再阻止 Reset；仍有应用引用的资源继续拒绝，释放应用引用后可恢复。取消前先清空设备录制槽，私有 IUnknown 析构回调不会看到旧录制块；已完成的状态块不在本项变更范围。
> - 此契约对齐固定版本 Wine 的 D3D8 与非 Ex D3D9 Reset 实现（W），不是新增原生 Microsoft HAL 测量。参数错误保留录制；资源阻塞或后续分配、提交、状态重放失败后不恢复已取消的录制，失败状态保持 NOTRESET。
> - 实际 Reset 入口各 511 项，其中新增六组/42 项录制生命周期断言；状态变异 31/31、资源变异 37 项、上一版两份 Reset 运行时负面对照和 ASan/UBSan 通过。呈现参数前置测试移除因检查顺序调整而不再使用的模拟函数，保留严格编译。
> - XP 两版各完成 13 次成功 Reset、7 次预期拒绝、26 次录制及 13 次恢复后的无效 End；五类资源分别覆盖应用仍持有和录制独占，另验证两种无效输入保留录制。24 个私有 IUnknown 最终释放，两个 owner 正常退出，121 秒；冻结轨迹确认 26 次排队 Reset 前资源已退役、录制绑定零宿主命令，十一项语义损坏被发现。
> - 七组相关核心及 26 组相关客体回归、36 个标准 SDK EXE、六份严格 DLL、另两份录制 SDK EXE、站点两项集成通过，其余检查继承 4H6f4c 的 206/207 组完整基线。发布本次 XP 所测零售 DLL 和严格诊断 DLL。宿主/协议/着色器不变，本项没有新 GPU 像素运行，继承 4H6f4c 和 4H6c GPU 基线。见 [stage4h6f4d-validation.json](fixtures/d3d-review/stage4h6f4d-validation.json)。
> - 继续完整 Reset 呈现参数、已完成状态块/私有数据边界及交换链引用/独立缓冲，包装转换与阶段 4/5/6 尚未完成。

> **阶段 4H6f5a（2026-11-03）：D3D9 隐式/附加交换链引用与最终设备释放（S2-42 相关）完成。**
>
> - 隐式链仅在公共引用 0→1 时取得一个设备子引用，在 1→0 时归还；重复 GetSwapChain、AddRef、QueryInterface 不再逐次增加设备引用。公共计数为零时重复 Release 返回零，设备仍存活期间可重新取得同一链。附加链沿用构造时的生命周期引用，后续 AddRef 仅增加链自身计数，修复最终 Release 后设备引用泄漏。
> - 沿用既有资源清理顺序：附加链先从设备链表移除、发送销毁、释放 backing surface 并释放链内存，最后归还设备引用。隐式链最终归还引用后不再访问可能已释放的设备或嵌入对象。依据固定版本 Wine 交换链实现与 Windows refcount 测试；backing texture/surface 内部表示及其设备引用数量保持现有约定，不宣称全部 COM 计数已原生一致。
> - 实际 C 入口 1,958 项，含 128 轮隐式链归零/恢复、公开身份和 GetDevice、三条附加链交错释放与最后子对象销毁设备；14/14 语义变异、上一版本运行时负面对照、ASan/UBSan 通过，相关 Reset/资源/隐式表面/私有数据/呈现时钟回归保留。
> - XP 单进程覆盖 32 轮隐式恢复、64 次重复零 Release、四条附加链和三个设备生存期；链 AddRef 的设备引用增量为零，应用先释放设备的两种最终 owner 路径均释放设备及工厂引用，108 秒正常退出。独立冻结解码确认三设备、四链和四个 backing texture 全部退役、没有绘制/Reset/Present，九项语义损坏被发现。
> - 五组相关核心、十二组相关客体、36 个标准 SDK EXE、六份严格 DLL、另一个链生命周期 SDK EXE与站点两项集成通过；其余检查继承 4H6f4c 完整基线。只更新本次 XP 所测 D3D9 零售 DLL及严格诊断 DLL，D3D8/DDraw 保持上一验收文件。宿主/协议/着色器不变，无新 GPU 像素运行，继承 4H6f4c 和 4H6c。见 [stage4h6f5a-validation.json](fixtures/d3d-review/stage4h6f5a-validation.json)。
> - 继续交换链 back buffer 的选择器、身份、独立缓冲/容器及多缓冲边界，完整 Reset、包装转换和阶段 4/5/6 仍未完成。


> **阶段 4H6f5b（2026-11-03）：D3D8/9 交换链 back buffer 选择器与错误输出（S2-42 相关）完成。**
>
> - 两版附加链忽略 MONO/LEFT/RIGHT 及任意类型值；无效索引返回 INVALIDCALL 并保留调用方原输出指针，NULL 输出同样拒绝。D3D9 隐式链在转到设备入口前检查索引，避免设备入口清空输出的不同约定泄漏到链接口。成功查询仍精确取得一次表面引用，失败不增加引用。
> - 依据固定版本 Wine 两版 Windows test_swapchain 与链实现；本项只覆盖当前支持的单缓冲链，不宣称 BackBufferCount>1 的多缓冲支持、D3D8 附加表面身份或独立 GPU 缓冲已实现。D3D8 现有分配失败 NULL 输出及私有数据 owner 清理约定保留。
> - 实际 C 入口 D3D8 36 项、D3D9 75 项，覆盖五种类型、四个无效索引、两种 D3D9 链、成功引用和 D3D8 分配失败；8/8 语义变异、上一版两份运行时负面对照、ASan/UBSan 及私有表面/隐式身份/链引用/呈现节流回归通过。
> - XP 两版共十五次成功查询、三十次无效索引输出保留及十五次 NULL 拒绝，附加缓冲为 96×64，D3D9 隐式缓冲为 64×64；最终设备引用回到 1，两 owner 正常退出，109 秒。冻结轨迹确认无绘制/Reset/Present、设备和 D3D9 附加链/backing texture 正常退役，九项语义损坏被发现。
> - 四组相关核心、十组相关客体、36 个标准 SDK EXE、六份严格 DLL、另两份选择器 SDK EXE及站点两项集成通过；其余检查继承 4H6f4c 完整基线。发布本次 XP 所测两版零售 DLL 和严格诊断 DLL，DDraw 保持上一验收文件。宿主/协议/着色器不变，无新 GPU 像素运行，继承 4H6f4c/4H6c。见 [stage4h6f5b-validation.json](fixtures/d3d-review/stage4h6f5b-validation.json)。
> - 继续呈现参数归一化、附加链独立缓冲/身份/容器及多缓冲边界；完整 Reset、包装转换和阶段 4/5/6 尚未完成。

> **阶段 4H6f6a（2026-11-03）：D3D8/9 窗口设备的实际缓冲尺寸与参数回写（S2-26 / S1-9 相关）完成。**
>
> - 两版 CreateDevice 在分配尺寸相关的客体存储前解析窗口客户区，零尺寸不再让宿主缓冲与客体默认视口/表面分别使用客户区和 640×480。D3D8 front shadow、D3D9 默认 scissor、缓存呈现参数与宿主 CreateDevice 使用同一尺寸；Reset 共用同一尺寸选择与参数策略，缓存窗口保存实际窗口，调用方 NULL 窗口保持不变。
> - 内部参数保存实际宽高/格式及归一化计数。按固定版本 Wine Windows 测试，两版成功后都把零 BackBufferCount 回写为 1；D3D8 保留调用方宽高，D3D9 回写实际宽高/格式。仅完整成功后回写，资源/分配/提交/重放/模式失败不提前修改调用方参数。共享头在各自 SDK 布局下编译，无跨版本布局转换。
> - 当前 Microsoft Reset 文档的返回字段描述与上述 Windows 测试期望不同；本项明确采用固定测试中的兼容行为，不把它称为新的原生 HAL 测量。空客户区的既有回退与 UNKNOWN 格式的既有回退保持原策略，附加链回写及完整全屏/格式归一化另行处理。
> - 实际构造器 D3D8 1,140 项、D3D9 1,139 项，各 162 组合，覆盖零/指定/客户区尺寸、独立维度、窗口 fallback、缓冲计数、客体存储和视口/宿主一致性、调用方字段与失败清理。实际 Reset 各 545 项，新增 34 项零/部分尺寸、缓存颜色/深度表面、版本回写与重放/模式失败原子性。20/20 新语义变异、两版上一构造器运行时负面对照、保留回归和 ASan/UBSan 通过。
> - XP 两版各完成 128×96 零尺寸创建、160×112 零尺寸 Reset、96×80 部分零尺寸 Reset，验证默认视口、完整客户区 SetViewport、颜色/深度描述、D3D9 scissor/隐式链参数与输出版本差异；两个 owner 正常退出，144 秒。冻结轨迹确认四次 Reset 与六帧，十二项语义损坏被发现。D3D8 相同视口设置按既有规则省略命令，D3D9 发出三条视口命令。
> - SwiftShader、Metal 各重放六帧，每后端原始/显示各 75,776 像素全图零误差，无 GPU/宿主错误。210 组核心、213 组客体完整回归、36 个标准 SDK EXE、六份严格 DLL、另两份几何 SDK EXE及站点两项集成通过。发布本次 XP 所测两版零售 DLL 和严格诊断 DLL，DDraw 保留验收文件。宿主/运行包不变，另保留 4H6c 全量 GPU 基线。见 [stage4h6f6a-validation.json](fixtures/d3d-review/stage4h6f6a-validation.json)。
> - 继续附加链参数/独立缓冲/身份/容器、多缓冲、UNKNOWN 格式与完整 Reset 边界；包装转换和阶段 4/5/6 尚未完成。

> **阶段 4H6f6b（2026-11-03）：D3D8/9 附加链的创建尺寸、参数回写与数量上限（S2-26 / S2-42 相关）完成。**
>
> - 两版附加链接入共用的实际参数/调用方版本策略。D3D8 在创建时解析所选窗口客户区，不再把主设备尺寸当作另一窗口的零尺寸缓冲；缓存实际窗口、独立宽高和归一化计数，窗口稍后改变大小不改变创建尺寸。D3D9 缓存沿用现有实际值并在完整成功后回写宽高/格式/计数；两版调用方 NULL 窗口保持不变。
> - D3D8 成功回写零计数为 1，调用方宽高保留；D3D9 返回实际宽高。D3D9 增加与已有 SDK 上限一致的 >3 拒绝，失败前不分配资源、输出链初始化为 NULL，参数及设备协作状态保持。接受 2/3 仍是既有接口行为，不代表多个实际 back buffer 已实现。
> - 实际构造器各 24 组合，D3D8 123 项、D3D9 124 项，涵盖不同/默认窗口、各维度为零或指定、计数 0/1/3/4、版本输出及分配/提交失败清理；10/10 新语义变异、两版上一源文件运行时负面对照、ASan/UBSan 通过。共享几何、参数前置、私有表面、选择器及链引用回归保留。
> - XP 两版各创建两条链：另一窗口 96×80，创建后窗口改为 160×112，缓冲描述仍为 96×80；NULL 窗口路径为 128×96，主设备始终为 128×96。每版各拒绝一次计数 4、参数保持且设备引用回到 1；两个 owner 正常退出，108 秒。冻结解码确认四条 SDK 链、两条 D3D9 宿主链及两份 backing texture 正常退役，十项语义损坏被发现。
> - 六组相关核心、十三组相关客体、36 个标准 SDK EXE、六份严格 DLL、另两份附加参数 SDK EXE及站点两项集成通过，其余检查继承 4H6f6a 的 210/213 组完整基线。发布本次 XP 所测两版零售 DLL和严格诊断 DLL；本项无绘制/呈现和新 GPU 像素运行，继承 4H6f6a/4H6c。见 [stage4h6f6b-validation.json](fixtures/d3d-review/stage4h6f6b-validation.json)。
> - UNKNOWN 格式选择、D3D8 附加链独立 GPU 缓冲/身份/容器、多缓冲、完整 Reset、包装转换和阶段 4/5/6 尚未完成。

> **阶段 4H6f6c（2026-11-03）：D3D9 窗口 UNKNOWN 使用当前桌面格式（S2-26 / Reset 相关）完成。**
>
> - CreateDevice、Reset 和附加链共用当前适配器格式选择；UNKNOWN 不再固定为 X8R8G8B8 或沿用旧 back buffer 格式。显式格式保持原值且不读取 Win32 模式。构造与 Reset 在分配/提交/模式变更前拒绝全屏 UNKNOWN；Reset 失败保持 NOTRESET，成功恢复后才 ready。D3D8 的 UNKNOWN 语义未改，共用查询继续沿用既有 16 位映射与查询失败回退。
> - 实际共用查询检查 D3D8 149 项、D3D9 206 项；D3D9 构造器 1,149 项/165 组合，附加链 133 项/27 组合，Reset 559 项/14 类失败。新增显式/当前桌面与旧缓冲格式不同的组合、显式值零 Win32 查询、全屏拒绝与恢复；D3D8 保留 1,140/123/545 项对应回归。14/14 新变异、三个上一源文件入口的运行时负面对照及 ASan/UBSan 通过。补充 Reset 模拟测试的表面对象延长到恢复检查结束，修正 ASan 发现的测试作用域错误后重跑。
> - XP 单进程覆盖 32 位 UNKNOWN 构造、A8R8G8B8 显式设备、UNKNOWN 附加链与 Reset、640×480 16 位桌面下的 UNKNOWN 附加链/Reset/构造、16 位下显式 A8R8G8B8 保持，以及恢复原桌面后 UNKNOWN Reset。全屏 UNKNOWN 构造/Reset 各拒绝一次，后者仅经 Reset 恢复；原桌面尺寸/色深恢复，120 秒正常退出。
> - 独立冻结解码确认三个设备生存期，构造格式 22/21/23、Reset 格式 22/23/22、附加 texture 格式 22/23/21，三链/三 texture 全部退役；拒绝路径没有额外宿主构造/Reset，十二项语义损坏被发现。五组相关核心、十四组相关客体、36 个标准 SDK EXE、六份严格 DLL、另一个默认格式 SDK EXE及站点两项集成通过，继承 4H6f6a 的 210/213 完整基线。
> - 只更新本次 XP 所测 D3D9 零售 DLL 和严格诊断 DLL，D3D8/DDraw 保留验收文件。宿主/协议/着色器不变，本项无绘制与新 GPU 像素运行，继承 4H6f6a/4H6c。见 [stage4h6f6c-validation.json](fixtures/d3d-review/stage4h6f6c-validation.json)。原生 Microsoft HAL、完整刷新率/MSAA/全屏参数、物理丢失、D3D8 附加独立缓冲/身份/容器、多缓冲、包装转换和阶段 4/5/6 尚未完成。

> **阶段 4H6f7a（2026-11-03）：D3D8 附加链独立 GPU 缓冲与两版呈现隔离（S2-42 相关）完成。**
>
> - D3D8 附加链复用现有 render-target texture 与缓存 level surface，创建、呈现和销毁均使用既有 D9WG 交换链命令。反复 GetBackBuffer 返回同一表面，两个链及主设备各有独立内容；私有数据复用逻辑 level store，移除另建的私有 owner。链先释放时，应用表面和渲染目标绑定继续保留缓冲与私有 IUnknown，最后解除绑定才清理；资源/链创建失败完整回收。
> - 14 帧真实 XP 轨迹暴露共用提交边界错误：附加链 Present 标志还会复制主缓冲区，主窗口在自己的 Present 前就被更新。宿主现在区分该批中的主链与附加链命令，附加链单独呈现不获取主 canvas；混合命令两种顺序及既有仅标志的主呈现兼容行为均有回归。旧宿主四个显示快照失败而全部原始缓冲通过，保留失败证据。
> - 实际 D3D8 命令发射器 23 项及 10/10 变异，覆盖链标识、窗口覆盖、负坐标/空区域、保留字段归零、提交失败和锁释放。附加参数 124/133 项、选择器 36/75 项、私有表面 12/7 组、子视图身份 105 项和链时钟 24/60 项通过；更新测试以验证缓存与 texture-level store 生命周期，ASan/UBSan、16 项私有表面、8 项选择器、10 项参数、19 项时钟、30 项 texture 私有数据及 18 项子身份变异保留。
> - XP 两版各完成七帧：交错红/蓝附加链与绿色主缓冲，修改 A 不影响 B/主缓冲，随后先释放 A 链、保留表面并绑定/清除，再解除绑定令私有 IUnknown 恰好析构一次。D3D8 B 使用 4× MSAA；两版各在资源清理后成功 Reset，两个 owner 正常退出。独立冻结解码确认四链/四 texture、八次附加及六次主呈现、两次清理 Reset，十六项语义损坏被发现。
> - SwiftShader 与 Metal 各验证 14 帧、40 份原始缓冲快照（410,624 像素）和 42 份显示快照（422,912 像素），包括尚未 Present 的窗口与已退役链显示，全部零误差。重建并同步宿主 bundle；完整 GPU 基线、核心/客体回归、36 个标准 SDK EXE、六份严格 DLL、另两份独立链 SDK EXE和站点两项集成通过。发布最终 XP 所测 D3D8 零售 DLL及严格诊断 DLL，D3D9/DDraw 保留此前验收文件。详见 [stage4h6f7a-validation.json](fixtures/d3d-review/stage4h6f7a-validation.json)。
> - 本项仅验收单 back buffer 的独立存储与显示；附加表面的公共 COM 计数/容器仍沿用 backing texture 表示。下一步处理 D3D8 的设备容器与 D3D9 的链容器、公共计数归零与恢复。多 back buffer 存储/轮换、完整 SwapEffect/MSAA/刷新率/全屏参数、原生 Microsoft HAL、游戏/FPS、D3D8 包装及阶段 4/5/6 仍未完成。

> **阶段 4H6f7b（2026-11-03）：D3D8 附加 back buffer 的设备容器（S2-42 相关）完成。**
>
> - 附加链的缓存表面标记为公共 back buffer；GetContainer 对 IUnknown / IDirect3DDevice8 返回其设备并精确取得一次引用，不再暴露内部 render-target texture。沿用已有无效 IID 清空输出、NULL 输出 E_POINTER 的约定；普通二维/立方纹理 level/face 仍返回原纹理，隐式缓冲仍返回设备。本项依据固定 Wine Windows 引用测试，未推断独立 render/depth surface 的容器语义。
> - 实际 GetContainer 入口 121 项，覆盖成功身份/引用、七类错误、失败输出、重复查询和普通纹理隔离；实际附加构造器的 24 组合验证分类标记确实发布。7/7 新变异、上一版本运行时负面对照、ASan/UBSan 通过，保留 124/133 项附加参数、12/7 组私有表面、105 项子视图身份及 Reset/选择器/时钟/传输回归。
> - XP 在链存活、链已释放但表面仍持有、隐式缓冲三阶段各完成两次设备容器查询、七次 IID 拒绝和一次 NULL 输出拒绝；逐次检查设备引用恰好增加一次并归还。额外验证普通二维/立方纹理容器各一次及拒绝设备 IID，链先释放后的私有标记保留；最终设备及工厂归零，单 owner 118 秒退出。冻结解码确认一设备、一链和三份 texture 全部退役，无绘制/Present/Reset；十一项语义损坏被发现。
> - 七组相关核心、21 组相关客体、36 个标准 SDK EXE、六份严格 DLL、另一个容器 SDK EXE和站点两项集成通过。其余检查继承 4H6f7a 的 213/218 完整回归与 58 次 GPU 运行；宿主/协议/着色器及 bundle 未变，本项无新增 GPU 像素运行。只发布本次 XP 所测 D3D8 零售 DLL和严格诊断 DLL。见 [stage4h6f7b-validation.json](fixtures/d3d-review/stage4h6f7b-validation.json)。
> - 继续附加缓冲公共 COM 计数的归零/恢复和设备生命周期、D3D9 的链容器及链公共引用为零时的物理存活。多缓冲、完整呈现/Reset、原生 Microsoft HAL、游戏/FPS、包装转换和阶段 4/5/6 仍未完成。

> **阶段 4H6f7c（2026-11-03）：D3D8 附加 back buffer 公共计数与设备/存储生命周期（S2-42 相关）完成。**
>
> - 附加表面公共计数不再转发内部纹理计数：第一次 GetBackBuffer 返回 1，重复获取/AddRef 只增加表面计数；0→1 取得一份存储引用和设备引用，1→0 归还，公共零计数时重复 Release 返回零。链存活期间可重新取得同一缓存表面，私有数据仍属于该逻辑缓冲。普通二维/立方/volume 纹理视图继续转发父纹理计数，隐式表面策略保持。
> - 内部纹理的创建设备引用转交交换链，避免附加链构造同时保留两份设备引用；纹理最终析构不再重复归还已转交引用。链销毁直接归还内部存储引用，应用公共表面另有独立引用边界。最后一个表面先释放存储再归还设备引用，期间不再访问可能被存储析构释放的视图。设备仅持有渲染目标绑定时，不额外保留公共表面/设备引用；绑定仍保留存储和私有数据，Reset 或设备最终清理可正常释放。
> - 使用实际 Device/child AddRef/Release、texture/view/chain 引用与清理入口检查 1,178 项，含 128 轮缓存归零/恢复、重复零 Release、设备先释放、链先释放、最后视图销毁设备和仅剩绑定的最终清理。12/12 新变异及上一版本运行时负面对照、ASan/UBSan 通过。手写模拟布局补充存储标志；旧隐式 Release 变异改为明确定位隐式分支，23/23 恢复运行时拒绝，私有表面 16、容器 7、纹理私有数据 30、子视图 18 项变异保留。
> - XP 单进程完成三种设备生存期：32 轮公共计数/身份/IUnknown/私有数据恢复与精确设备引用；应用先释放设备再释放链，最后表面令设备/工厂引用归还；链和公共表面都释放但绑定保留存储，GetRenderTarget 重新取得同一公共表面，随后 Reset 成功清理。另验证活跃链仍拒绝 Reset、释放后可恢复。三份私有 IUnknown 各析构一次，三个设备全部退出，141 秒。冻结解码确认三链/三 texture、两次排队 Reset、一次 RT 绑定及三设备退役，无绘制/Present；十四项语义损坏被发现。
> - 八组相关核心、24 组相关客体、36 个标准 SDK EXE、六份严格 DLL、另一个公共生命周期 SDK EXE和站点两项集成通过。继承 4H6f7a 的 213/218 完整回归及 58 次 GPU 运行；宿主/协议/着色器和 bundle 未变，本项无新 GPU 像素运行。只发布最终 XP 所测 D3D8 零售 DLL和严格诊断 DLL。见 [stage4h6f7c-validation.json](fixtures/d3d-review/stage4h6f7c-validation.json)。
> - 继续 D3D9 附加缓冲的独立公共计数、链容器以及公共链计数为零时的物理存活/恢复；D3D8 公共链归零后的物理生存期也未在本项验收。多缓冲、独立 render/depth surface 计数、完整呈现/Reset、原生 Microsoft HAL、游戏/FPS、包装转换和阶段 4/5/6 仍未完成。

> **阶段 4H6f7d（2026-11-03）：D3D9 附加缓冲/链公共计数、零计数链容器与 Reset 上下文退休（S2-42 / S1-10 相关）完成。**
>
> - 附加 back buffer 的 GetContainer 对 IUnknown / IDirect3DSwapChain9 返回所属链。表面与链各有独立公共计数，各自只在零/非零边界保留一个设备引用；第一次 GetBackBuffer 返回 1，链 AddRef 不再改变表面计数。创建时把独立表面的设备引用转交链，并归还多余的内部纹理设备引用；内部析构跳过已经转交的引用，避免最终双重归还。
> - 链公共计数归零后，只要表面仍被持有，链和存储继续物理存活；GetContainer 可以重新取得同一条链，缓存缓冲和私有数据保持。两者公共计数都为零才统一移除设备链表、发送销毁并清理表面/纹理，最后归还当前公共对象的设备引用。Reset 仅把正公共计数的附加链视为直接阻塞，外部缓冲仍由 DEFAULT 资源图阻塞，仅有设备绑定的存储可清理；接受 Reset 后先切换设备 handle，再释放绑定，后续链销毁对应新宿主 handle。
> - 实际表面/纹理/链和设备引用清理入口新增 1,305 项，含各 128 轮表面及链归零/恢复、物理链/私有数据保留、最后视图销毁设备和仅剩绑定的最终清理；保留 D3D8 1,178 项和 D3D9 链 1,958 项。14/14 新变异、链 14/14、隐式 23/23、资源图 37、私有表面 16 项变异及 ASan/UBSan 通过。资源图 D3D9 增至 590 项，新增零公共链与混合链表；两份旧源运行时对照分别拒绝旧设备引用数量和零公共链阻塞 Reset。
> - XP 单进程完成三设备生存期、32 轮表面恢复和 32 轮 GetContainer 链恢复，链/缓冲身份与公共计数保持，设备引用精确归还。覆盖活跃链阻止 Reset 后恢复、应用先释放设备与链后由最后表面完成销毁、仅有绑定时 Reset 成功；三份私有 IUnknown 各析构一次，114 秒正常退出。冻结轨迹确认三链/三 texture、两次排队 Reset、一次 RT 绑定及三设备退役，十五项语义损坏被发现。本次没有 SESSION_END 命令，但明确记录一次驱动 owner 释放；独立验证和宿主回放使用该真实退出事件结束会话。
> - 新 XP 轨迹暴露宿主 Reset 遗漏：替换设备状态会丢掉仍存活的交换链上下文，没有 unconfigure。旧宿主仅关闭两个而应关闭三个；共用 Reset 现先提交排队工作，再退休附加链上下文。严格宿主测试 178 项通过。实际 GPU 用例增加链画面提交后立即 Reset，两个后端各检查 256 个显示像素、四个保留纹理上下文及一个原生上下文恰好关闭一次；原有 14 帧/40 原始及 42 显示快照也在两个后端重新验收，零误差。
> - 重建并同步 bundle；216/222 组完整核心/客体回归、56 页 SwiftShader、Metal 533 项一致性及两个生命周期/独立缓冲页面，共 59 次新 GPU 运行通过。36 个标准 SDK EXE、六份严格 DLL、另一个 D3D9 公共生命周期 SDK EXE和站点两项集成通过。只发布最终 XP 所测 D3D9 零售 DLL和严格诊断 DLL，D3D8/DDraw 保持已验收文件。见 [stage4h6f7d-validation.json](fixtures/d3d-review/stage4h6f7d-validation.json)。
> - D3D8 公共链归零后的物理生存期、多 back buffer、独立 render/depth 表面计数/设备引用、完整 MSAA/呈现/Reset、原生 Microsoft HAL、游戏/FPS、包装转换和阶段 4/5/6 仍未完成。

> **阶段 4H6f7e（2026-11-03）：D3D8 零公共计数链的物理生存期及两版真实 GPU 恢复画面（S2-42 相关）完成。**
>
> - D3D8 附加缓冲的内部纹理记录所属交换链；链公共计数归零时只归还当前设备/存储引用，不提前释放物理链。表面公共引用或设备 RT 绑定仍持有存储时，原链指针 AddRef 可从零恢复，精确重新取得一个设备引用、一个存储引用及 Reset 阻塞计数。最终纹理清理才发送链销毁、释放物理链；外层最后归还设备引用。Reset 接受后先切换新设备 handle，再清理绑定，延迟的链销毁使用新 handle。
> - 固定 Wine 链/表面源码及原 Windows 引用测试作为依据；新增实际入口检查增至 D3D8 1,701 项，包含各 128 轮表面及原链零计数恢复、四种最终所有者顺序及仅剩绑定时的链恢复/清理；保留 D3D9 1,305 项。新增 10/10 物理链语义变异，既有计数、容器、隐式、私有数据、Reset、呈现间隔/时钟变异和七族 ASan/UBSan 通过；旧 D3D8 源在实际构造入口被运行时断言拒绝。D3D8 链重复零 Release 的防御行为不作为原生 Windows 保证。
> - 共享 SDK 程序在 XP 分别运行 D3D8/9，各 32 次链归零/恢复并检查独立公共计数、设备引用、IUnknown/缓存表面身份和私有数据。两次 Clear/Present 之间不重建链和缓冲，D3D8 使用四倍 MSAA；最后仅剩绑定时 Reset 成功，两份私有 IUnknown 各析构一次，111 秒正常退出，两个驱动 owner 完整归还。冻结轨迹确认两链/两纹理、四次附加链呈现、两次 Reset 后再按新设备 handle 销毁，二十项语义损坏全部被发现。
> - 独立回放页面在 SwiftShader 与 Metal 各检查四帧、3,072 个原始 GPU 像素及 3,072 个显示像素，全部零误差；只创建两个链上下文，呈现获取四次，Reset 恰好各关闭一次，没有主窗口呈现、读取失败或 GPU/宿主错误。显式链销毁发生在 Reset 退休之后，因此宿主显式销毁计数为零，实际关闭次数由上下文回调核验。
> - 十组相关核心、28 组相关客体、36 个标准 SDK EXE、六份严格 DLL、两份新增 SDK EXE及站点两项集成通过。宿主/协议/着色器及 bundle `64aa2cd7f7413ccbe760` 未变，继承 4H6f7d 的 216/222 完整回归及 59 次 GPU 基线，另有本次两个新 GPU 运行。只发布最终 XP 所测 D3D8 零售 DLL和严格诊断 DLL。见 [stage4h6f7e-validation.json](fixtures/d3d-review/stage4h6f7e-validation.json)。
> - 多 back buffer 的真实存储/轮转、独立 render/depth 表面计数/设备引用、完整 SwapEffect/MSAA/呈现/Reset、线程/物理丢失设备、原生 Microsoft HAL、游戏/FPS、包装转换及阶段 4/5/6 仍未完成。

> **阶段 4H6f8a（2026-11-03）：两版共用 SwapEffect 枚举与 COPY 单缓冲校验（S2-26 / S2-42 相关）完成。**
>
> - 新共用标量校验用于两版 CreateDevice、Reset 和 CreateAdditionalSwapChain，共六个入口：拒绝零/越界枚举；D3D8 保留 DISCARD / FLIP / COPY / COPY_VSYNC，普通 D3D9 只允许前三种；COPY 及 D3D8 COPY_VSYNC 只接受零计数归一为一个或显式一个缓冲。沿用既有 DISCARD / FLIP 的 2/3 计数接受行为，本项不代表多缓冲存储已实现。固定 Wine 的 Windows 参数表及实际构造/Reset 断言核对版本差异，共用实现与 Microsoft 参数/枚举文档交叉核对。
> - 每版实际入口各 397 项、110 组构造/Reset/附加调用，覆盖窗口/全屏参数前置路径、正常枚举、COPY_VSYNC 版本差异、COPY 零/单/多及大计数、对象输出清零、输入参数/设备状态保持和 Reset 状态发布。20/20 新语义变异覆盖共用策略和全部六个实际入口；两份旧前端均在运行时断言失败，六族 ASan/UBSan 通过。既有几何、间隔、默认格式、Reset、链计数/存储/私有数据回归保留。
> - 共享 SDK 程序在 XP 执行九个设备生存期：参数矩阵 21 次有效调用、39 次拒绝，七条附加链及其缓存缓冲；每版十次有效 Reset，十三次无效 Reset 发布 DEVICENOTRESET、随后 Present 返回 DEVICELOST 而不发送呈现命令，再有效 Reset 恢复。拒绝路径对象输出为 NULL、参数不改、设备/工厂引用平衡，140 秒正常退出。冻结轨迹独立确认九设备、二十 Reset、七链/七纹理及完整退役；十八项语义损坏全部发现。本轨迹 D3D8 无 SESSION_END 命令、D3D9 有一次，另要求两个实际驱动 owner 释放事件，不补造命令。
> - 十一组相关核心、225 组完整客体、36 个标准 SDK EXE、六份严格 DLL、两份新增 SDK EXE及站点两项集成通过。只发布最终 XP 所测两版零售 DLL及严格诊断 DLL，DDraw 保持已验收文件。宿主/协议/着色器与 bundle `64aa2cd7f7413ccbe760` 未变；本项没有绘制或成功 Present，无新增 GPU 像素运行，继承 4H6f7d 的完整核心/GPU 基线及 4H6f7e 双后端恢复画面验收。见 [stage4h6f8a-validation.json](fixtures/d3d-review/stage4h6f8a-validation.json)。
> - MSAA 与 SwapEffect/Flags/Quality 组合、刷新率及全屏完整参数、多缓冲存储/轮转、独立 render/depth 表面引用、完整 Reset/线程/物理丢失、原生 Microsoft HAL、游戏/FPS、包装转换及阶段 4/5/6 仍未完成。

> **阶段 4H6f8b（2026-11-03）：两版共用呈现 MSAA 组合、质量/锁定标志及 D3D8 缓冲锁定（S2-26 / S2-42 相关）完成。**
>
> - 六个创建/Reset/附加入口共用 MSAA 结构校验：多采样仅配 DISCARD；D3D9 在当前唯一质量级别下，非零质量索引返回 INVALIDCALL，含 NONE 模式。D3D8 允许 MSAA 与 LOCKABLE_BACKBUFFER 标志组合，D3D9 拒绝；两版差异依据固定 Wine 的 Windows 多采样测试及其参数转换代码。结构接受用例只证明通过前置校验，不等同于后端已支持每种组合。
> - D3D8 多采样纹理 LockRect 在读取、分配或改变锁定状态前拒绝，保留输出和缓存；实际表面/复制/读取入口增至 61 项，其中新增十组多采样/只读及写锁拒绝，旧源会错误发起一次读取。XP 另暴露附加链复用独立 render-target 构造时误传可锁定 MSAA：现保持调用方/缓存 Flags，内部多采样存储不标记可锁定，避免合法呈现参数被独立目标入口拒绝；实际附加构造增至 D3D8 128 项、25 个用例。
> - 每版 343 项、95 组实际入口前置检查，覆盖 DISCARD、COPY/FLIP、质量、标志和失败原子性/Reset 状态。24/24 新语义变异覆盖共用策略、六入口、D3D8 提前拒绝锁定及内部标志转换；保留呈现/几何/Reset/缓存身份/链存储变异，八族 ASan/UBSan 通过。三份旧源运行时对照分别拒绝两版旧参数策略和 D3D8 锁定读取。
> - 最终 XP 122 秒正常退出，四设备生存期、参数矩阵六次有效/27 次拒绝、九次失败 Reset 和失败 Present 后恢复，共十一有效 Reset；八次锁定失败保持输出、设备引用归还。两链/两纹理及两个驱动 owner 完整退役。冻结独立轨迹核对 MSAA 构造/Reset、D3D8 四倍附加缓冲及 D3D9 普通附加缓冲，并确认没有绘制、读取或成功呈现命令；十九项语义损坏全部发现。
> - 十二组相关核心、26 组相关客体、36 个标准 SDK EXE、六份严格 DLL、两份新增 SDK EXE及站点两项集成通过。发布最终 XP 所测两版零售 DLL及严格诊断 DLL，DDraw 保持验收文件。宿主/协议/着色器及 bundle `64aa2cd7f7413ccbe760` 不变，无新 GPU 像素运行；继承紧邻 4H6f8a 的 225 完整客体回归和 4H6f7d/e 的核心/GPU 基线。见 [stage4h6f8b-validation.json](fixtures/d3d-review/stage4h6f8b-validation.json)。
> - D3D9 附加四倍 MSAA 仍明确拒绝并在本次 SDK 检查，本项不将其算作实现；下一步接通独立缓冲的采样/resolve 与实际 GPU 验收。完整刷新率/全屏参数、多缓冲存储/轮转、独立 render/depth 表面引用、完整 Reset/线程/物理丢失、原生 Microsoft HAL、游戏/FPS、包装转换及阶段 4/5/6 仍未完成。

> **阶段 4H6f8c（2026-11-03）：D3D9 附加四倍 MSAA 存储/resolve 及两版真实采样附件像素（S2-42 相关）完成。**
>
> - D3D9 附加链接入已有共用多采样 render-target 路径，校验格式/采样支持后，将请求的 MultiSampleType 与已验证质量值传给内部纹理，不再拒绝所有非 NONE 模式或创建单采样缓冲。保留 4H6f8b 的 DISCARD、质量和 D3D9 可锁定标志约束；未支持的采样类型在分配/发命令前拒绝。链缓存参数与实际 Surface.GetDesc 保持四倍/质量零。
> - 实际附加构造 D3D9 增至 141 项、28 个正例构造，含四倍存储传参/缓存、精确设备引用及四种未支持类型失败原子性；D3D8 128 项保持。新增 5/5 语义变异覆盖采样/质量传递、支持判断和缓存参数，旧 D3D9 源在四倍正例运行时失败，七族 ASan/UBSan 通过。原手动 MSP9 SDK 同步改为要求四倍附加链创建成功；历史 8b 冻结轨迹保留当时的拒绝事实，新行为由本阶段独立验收。
> - 新共享 SDK 在 XP 检查两版四倍能力，D3D9 返回一个质量级别；实际缓冲/缓存参数为四倍和质量零。两版各在 32 次链公共计数归零/恢复前后呈现两帧，缓存身份、私有数据、设备引用不变；最后仅剩绑定时 Reset 清理，两份私有 IUnknown 各析构一次，133 秒退出，两个 driver owner 归还。冻结轨迹确认两条四倍链、两纹理、四次附加呈现及两次晚清理 Reset，二十项语义损坏全部发现。
> - 新 GPU 回放除读取宿主解析纹理和显示画面，还直接读取真实四采样附件：验证 GPUTexture.sampleCount=4，并用独立 WebGPU resolve 读出其像素，解析纹理 sampleCount=1。SwiftShader/Metal 各检查四帧、3,072 个实际多采样附件像素、3,072 个解析像素及 3,072 个显示像素，全部零误差；两个上下文创建/关闭各一次、四次显示获取，没有主窗口呈现、读取失败或 GPU/宿主错误。
> - 十三组相关核心、27 组相关客体、36 个标准 SDK EXE、六份严格 DLL、两份新增 SDK EXE、两份更新后的手动 MSAA SDK 编译及站点两项集成通过。只发布最终 XP 所测 D3D9 零售 DLL与严格诊断 DLL，D3D8/DDraw 保持 8b 已验收文件。宿主/协议/着色器和 bundle `64aa2cd7f7413ccbe760` 未改，继承 8a 的 225 完整客体、7d 的完整核心/GPU 基线及 7e 双后端像素，新增本次两个 GPU 页面运行。见 [stage4h6f8c-validation.json](fixtures/d3d-review/stage4h6f8c-validation.json)。
> - 完整格式/深度/MSAA 匹配、刷新率/全屏参数、多缓冲存储/轮转、独立 render/depth 表面引用、完整 Reset/线程/物理丢失、原生 Microsoft HAL、游戏/FPS、包装转换及阶段 4/5/6 仍未完成。

> **阶段 4H6f8d（2026-11-03）：D3D9 独立 GPU/CPU 表面的设备容器（S2-42 相关）完成。**
>
> - 按 Microsoft GetContainer 文档，独立 render target / depth-stencil / offscreen plain 表面对 IUnknown / IDirect3DDevice9 返回创建设备，并只为本次查询增加一个引用。原先 GPU 表面暴露私有纹理，SYSTEMMEM / SCRATCH 因无纹理直接失败；现独立表面复用自动深度表面的设备分支，拒绝纹理等其他 IID，不暴露内部存储。真正 texture/cube 级表面及交换链缓冲保持各自容器。
> - 明确记录依据差异：固定 Wine 的独立表面创建传入 NULL container，其 GetContainer 返回 E_NOINTERFACE，与 Microsoft 文档的设备容器说明不同。本项采用明确文档契约；XP 测试运行的是本项目 DLL，不作为原生 Microsoft HAL 验证。构造时私有纹理的多余设备引用尚未修，本项只核对查询相对增量和最终归还，下一步单独收敛创建引用。
> - 实际 GetContainer 入口 7,792 项、2,592 次查询：三类 GPU、两类 CPU、自动深度、纹理/立方体/交换链控制；核对身份、查询引用、输出及隔离。7/7 新语义变异和保留的隐式 23/23 变异通过；旧源在有效 IUnknown 容器身份查询中运行时失败，六族 ASan/UBSan 通过。
> - XP 依次创建五类真实独立表面，各八轮查询，总计 80 次设备容器查询、280 次拒绝及十组 NULL 保护，所有查询引用平衡；普通纹理/立方体控制各四次成功、五次拒绝，共享计数与设备隔离保持。118 秒正常退出，设备/工厂引用归零。冻结轨迹确认四份 2D 存储、一份 cube、完整资源与设备退役，无绘制/呈现/Reset；十八项语义损坏被发现。
> - 十二组相关核心、22 组相关客体、36 个标准 SDK EXE、六份严格 DLL、另一个容器 SDK EXE及站点两项集成通过。只发布最终 XP 所测 D3D9 零售 DLL和严格诊断 DLL，D3D8/DDraw 保持已验收文件。宿主/协议/着色器及 bundle `64aa2cd7f7413ccbe760` 未改，无新增 GPU 像素运行，继承 8a 完整客体和 7d/e、8c 核心/GPU 基线。见 [stage4h6f8d-validation.json](fixtures/d3d-review/stage4h6f8d-validation.json)。
> - 独立目标创建设备引用、完整格式/MSAA/刷新率/全屏参数、多缓冲存储/轮转、完整 Reset/线程/物理丢失、原生 Microsoft HAL、游戏/FPS、包装转换及阶段 4/5/6 仍未完成。

> **阶段 4H6f8e（2026-11-03）：D3D9 独立表面只持有一个创建设备引用（S2-42 相关）完成。**
>
> - create_target_texture 的内部纹理不再额外持有一个公共设备引用；独立表面持有唯一创建引用，内部存储在构造时标记为私有，析构跳过不存在的设备引用。既有 private_back_buffer 标志现涵盖私有 surface/backbuffer 存储，未改公开对象布局。附加链接过同一个表面引用，不再归还已消失的“第二份纹理引用”；普通公开 texture/cube/volume 的归属不变。8d 的设备容器继续隔离内部纹理。
> - 实际构造、纹理/表面和设备清理入口新增 2,000 项、361 组生存期/失败路径：五个 RT/depth/offscreen 采样配置，各 64 轮引用/销毁，构造返回表面 1、未绑表面仅增加一个设备引用；完整覆盖每处分配/发命令失败、设备先释放、抽象设备所持引用清理及纹理先于设备退役。12/12 新变异通过，保留附加生命周期 14 项的两处所有权变异随责任移动到真实存储构造；旧源运行时拒绝，八族 ASan/UBSan 通过。
> - XP 七类 GPU/CPU 表面均为表面计数 1、设备总计 2（一个应用引用加一个表面引用），GetDevice/设备容器查询临时到 3 后归还；112 轮额外 AddRef/私有数据查询不增加设备引用。六设备生存期包含三次应用先释放设备后由最后表面销毁、两次真正 RT/depth 绑定后仅剩绑定的清理。十二份私有 IUnknown 恰好析构一次，回调期间设备仍由待归还引用保护；122 秒退出，设备/工厂归零。
> - 冻结独立轨迹确认十份 GPU 存储、六设备、各一次 RT/depth 绑定、存储先于对应设备退役及完整 owner 归还，无绘制/呈现/Reset；二十一项语义损坏全部检出。绑定仍沿用本项目原有公共表面引用保留模型，本项校正创建引用并核验清理安全，不宣称已完成绑定后的原生公共计数/设备计数语义；回调中的设备计数也是本项目安全不变量，不作为原生 HAL 销毁期间计数证明。
> - 十三组相关核心、232 组完整客体、36 个标准 SDK EXE、六份严格 DLL、另一个生命周期 SDK EXE及站点两项集成通过。只发布最终 XP 所测 D3D9 零售 DLL与严格诊断 DLL，D3D8/DDraw 保持验收文件。宿主/协议/着色器及 bundle `64aa2cd7f7413ccbe760` 未改，无新增 GPU 像素运行，继承 7d/e、8c 的完整核心/GPU 基线。见 [stage4h6f8e-validation.json](fixtures/d3d-review/stage4h6f8e-validation.json)。
> - D3D8 独立目标容器、绑定对象的原生公共计数/设备引用、完整格式/MSAA/刷新率/全屏参数、多缓冲存储/轮转、完整 Reset/线程/物理丢失、原生 Microsoft HAL、游戏/FPS、包装转换及阶段 4/5/6 仍未完成。

> **阶段 4H6f8f（2026-11-03）：D3D8 独立 GPU 表面的设备容器及普通 RT 纹理隔离（S2-42 相关）完成。**
>
> - 独立 CreateRenderTarget / CreateDepthStencilSurface 成功取得表面后设置独立的设备容器标志，GetContainer 不再暴露内部存储纹理。标志与附加缓冲的公共计数/物理生存期标志分开；失败构造不写空输出。CPU image 表面已有设备容器；应用创建的普通及 RENDERTARGET 用途 texture/cube 级表面仍返回真实纹理，不按用途误分类。
> - 本项采用固定 blob 的 DXVK D3D8 GetContainer 实现作为桥接契约，D3D9 Microsoft 文档仅作跨版本背景；固定 Wine 的独立 NULL container 行为与此不同，明确保留分歧。原 Windows 测试可支持创建时一个设备引用及普通纹理/隐式/附加缓冲身份，未据此宣称验证过独立 D3D8 GetContainer 的原生 HAL 行为。
> - 实际容器与两种构造入口 8,674 项、2,880 次查询，包含普通/四倍 RT 与 depth、CPU/隐式/附加缓冲及普通 2D/cube 控制；十项新变异、既有七项附加容器变异和七族 ASan/UBSan 通过。旧源在实际构造的设备容器标志断言中失败；真实纹理分配/失败清理仍由已有 81 组 MSAA 入口回归覆盖。
> - XP 五类真实独立表面各八轮查询，80 次设备查询、280 次拒绝与十组 NULL 保护全部平衡；四种普通/渲染用途的 texture/cube 控制保持父身份与共享计数。每类独立表面仅持有一个设备创建引用；115 秒退出，设备/工厂归零。冻结轨迹核对六份 2D、两份 cube 存储全部先于设备退役及完整 owner 归还，十八项语义损坏全部发现；无绘制/呈现/Reset。
> - 十四组相关核心、18 组相关客体、36 个标准 SDK EXE、六份严格 DLL、新容器 SDK EXE和站点两项集成通过。只发布最终 XP 所测 D3D8 零售 DLL及严格诊断 DLL；宿主/协议/着色器与 bundle `64aa2cd7f7413ccbe760` 不变，无新 GPU 像素运行，继承 8e 的 232 组完整客体及 7d/e、8c 核心/GPU 基线。见 [stage4h6f8f-validation.json](fixtures/d3d-review/stage4h6f8f-validation.json)。
> - 绑定对象的原生公共计数/设备引用、完整格式/MSAA/刷新率/全屏参数、多缓冲存储/轮转、完整 Reset/线程/物理丢失、原生 Microsoft HAL、游戏/FPS、包装转换及阶段 4/5/6 仍未完成。

> **阶段 4H6f8g（2026-11-03）：D3D9 RT 绑定拒绝外设备表面并保持失败原子性（S2-26 / S2-42 相关）完成。**
>
> - SetRenderTarget 在解析宿主 handle、取得/归还引用、替换绑定及改变视口之前验证前端接口与创建设备；其他设备的纹理级、立方体面、独立 RT、主/附加缓冲和自动深度等表面不能进入本设备的 RT 命令。D3D8 已有接口/设备校验，保留原入口回归；本项不更改两版公共计数模型或 D3D9 深度绑定的归属策略。
> - 固定 Wine D3D9 SetRenderTarget 的明确设备检查作为实现依据；不同前端接口拒绝为本项目策略，不宣称覆盖原生任意 COM 包装接口。本项是在分离绑定内部/公共引用之前补齐归属前提，原生绑定计数及完整设备所有权仍待后续阶段。
> - 新实际入口 3,547 项、1,174 组：九种外设备/无效接口形态、全部四个 RT 槽、失败后整个设备/表面/旧目标及命令/视口/裁剪不变；本设备 2D/cube/主缓冲、同目标重绑、NULL 和槽边界保持。仅含接口头的对象通过 ASan/UBSan，八项新变异全部发现；旧源在第一组外设备 HRESULT 断言失败，五族 ASan/UBSan 通过。
> - XP 同一进程创建两个设备，以八类真实外设备表面各八轮遍历四槽，256 次拒绝后目标/深度/视口/裁剪及双方引用保持。另有本设备 RT 重绑、主缓冲恢复和 cube 第三槽绑定/解绑五次成功；128 秒退出，全部资源、两个设备与工厂归零。冻结轨迹只含五条本设备合法 RT 命令，外设备拒绝不发绑定，七份 texture/cube 和一条附加链完整退役；22 项语义损坏全部检出，无绘制/呈现/Reset。
> - 十五组相关核心、236 组完整客体、14 个 D3D9 标准 SDK EXE、两份严格 D3D9 DLL、新双设备 SDK EXE和站点两项集成通过；未改的 D3D8/DDraw 继承紧邻 8f 的 36 EXE/六 DLL 验收及原发布文件。只发布最终 XP 所测 D3D9 零售 DLL及严格诊断 DLL。宿主/协议/着色器与 bundle `64aa2cd7f7413ccbe760` 未改，无新 GPU 像素运行，继承 7d/e、8c 核心/GPU 基线。见 [stage4h6f8g-validation.json](fixtures/d3d-review/stage4h6f8g-validation.json)。
> - 绑定对象的原生公共计数/设备引用、其他跨设备资源入口、完整格式/MSAA/刷新率/全屏参数、多缓冲存储/轮转、完整 Reset/线程/物理丢失、原生 Microsoft HAL、游戏/FPS、包装转换及阶段 4/5/6 仍未完成。

> **阶段 4H6f8h（2026-11-03）：D3D9 独立 RT/depth 分离公共计数与内部绑定存储（S2-42 相关）完成。**
>
> - 独立表面新增内部绑定计数；SetRenderTarget / SetDepthStencilSurface、同对象重绑及清绑定不再取得公共表面/设备引用。公共计数归零归还唯一设备引用，内部绑定继续保存原表面、GPU 存储及私有数据；GetRenderTarget / GetDepthStencilSurface 从零恢复同一对象时只重新取得一个设备引用。最后解绑且公共计数为零时才销毁存储；多个内部槽只拥有一份私有 texture。普通 texture/cube 级表面和隐式/交换链缓冲保留原模型。
> - Reset 对独立表面只看公共引用和锁定，不再把内部槽从公共计数中扣除；原交换链模型仍按其原计数处理。设备清理临时保留自身，保护仅剩内部绑定的私有 IUnknown 回调。公共 Release 的进入/退出记录保持平衡，内部物理销毁不伪造公共 Release 退出；回调中的计数验证本项目安全不变量，不作为原生 HAL 析构计数证明。
> - 固定 Wine 的独立表面零/非零设备引用及内部 view 保留作为依据。新增实际构造/绑定/查询/清理/Reset 阻塞入口 4,255 项、16 组、1,024 次零公共计数恢复，覆盖单槽/双槽、普通/四倍 RT/depth、借用指针同目标重绑、最后解绑/设备先释放/最后公共引用等顺序；23 项新变异、既有 12 项目标生存期、14 项附加生命周期、23 项隐式及 37 项 Reset 变异通过。Reset 资源图 D3D9 增至 598 项，D3D8 保留 580 项；六族 ASan/UBSan 通过。
> - XP 真实四倍 RT/depth 各 32 轮从零恢复，IUnknown/容器/私有数据及精确设备引用保持；在公共计数为零时 Clear 两帧，经 StretchRect 解析到主缓冲并呈现。随后仅剩内部绑定时 Reset 成功，两份存储/私有对象清理；另覆盖设备最后释放和最后解绑，三设备生存期、一次 Reset、五份 IUnknown 恰好析构一次，工厂归零。冻结轨迹核对五份 GPU 存储、40 次 RT/38 次 depth 绑定、两次 Clear/复制/呈现及资源先于设备退役，30 项语义损坏全部检出。
> - SwiftShader 与本机 GPU 各回放同一 XP 两帧，独立解析真实四倍采样附件，并读取解析纹理及呈现纹理；每后端分别 1,536 / 1,536 / 1,536 像素全部零误差，零 WebGPU/宿主错误，owner 完整结束。原始计数与诊断记录分别有旧源运行时对照；诊断收尾前后零售 DLL 的 .text 完全相同，最终 XP 使用收尾后的零售 DLL。
> - 16 组相关核心、238 组完整客体、14 个 D3D9 标准 SDK EXE、两份严格 D3D9 DLL、两份专用 SDK EXE及站点两项集成通过。完整客体回归之后仅校正诊断记录并补充实际记录断言/三项变异，最终入口/变异/ASan 和严格诊断构建再次通过；零售指令相同。只发布最终 XP 所测 D3D9 零售 DLL及严格诊断 DLL。宿主/协议/着色器与 bundle `64aa2cd7f7413ccbe760` 未改，继承 7d/e、8c 基线并新增本次双后端 GPU 验收。见 [stage4h6f8h-validation.json](fixtures/d3d-review/stage4h6f8h-validation.json)。
> - 本项只收敛 D3D9 独立表面绑定；D3D8、texture/cube/缓冲/着色器/状态块及隐式/链绑定的公共计数仍待后续。通用设备根引用消失但外部资源仍存活时的状态保持、回调重入的完整资源图、其他跨设备入口、完整格式/MSAA/呈现/Reset/线程/物理丢失、多缓冲轮转、原生 Microsoft HAL、游戏/FPS、包装转换及阶段 4/5/6 仍未完成。

> **阶段 4H6f8i（2026-11-03）：D3D8 独立 RT/depth 公共计数与私有存储引用分离（S2-42 相关）完成。**
>
> - 独立构造成功后把原缓存视图提升为公共计数 1，将内部 texture 已持有的设备引用转交表面，不增加第二份引用；沿用 private_back_buffer 标志让私有存储不归还不存在的设备引用。公共计数从零恢复时只取得一份存储和一份设备引用，额外公共 AddRef 不增加两者；公共归零先归还存储、最后归还设备引用。普通 texture/cube 级视图仍共享父计数，附加链接过同一份表面引用作为既有链基础所有权。
> - 颜色绑定继续直接保留 texture 存储；独立深度绑定也改为保留存储，避免增加公开表面计数。绑定继续保留原缓存表面和私有数据，实际 getter 可从零恢复同一对象；Reset 现有物理存储引用检查因此能区分公共引用和仅有绑定，无需另一套扣除规则。设备最终清理临时保留自身，保护公共设备/表面计数均已归零的绑定存储回调。
> - 实际公共/存储/设备/缓存/私有数据方法新增 2,638 项、512 次零公共恢复，分别用颜色存储持有及真实深度存储 helper 覆盖四种最后所有者顺序。保留 8,674 项实际构造/容器、81 组真实 MSAA 构造、39 组实际 RT 入口、D3D8 1,701 / D3D9 1,305 项附加生存期；16 项新变异及原构造/容器/身份/绑定/私有/隐式变异、七族 ASan/UBSan 通过。旧源严格编译后在真实 AddRef 仍转发纹理公共计数的断言中失败；新 native 生存期采用抽象颜色/深度存储持有，完整 setter/getter 由保留入口及 XP 覆盖。
> - XP 独立 RT/depth 各 32 轮恢复，IUnknown、设备容器、私有对象及设备引用准确；公共计数归零时 Clear 两帧，经 GPU CopyRects 到主缓冲呈现，随后仅有内部绑定时 Reset 成功。另有四倍 RT/depth 的仅绑定最终销毁及最后解绑；三设备、一次 Reset、五份私有 IUnknown 恰好析构一次，143 秒退出，设备/工厂及 owner 归还。冻结轨迹为五份存储、40 次 RT/40 次 depth 绑定、两次 Clear/复制/呈现和完整退役；30 项语义损坏全部检出。
> - SwiftShader / 本机 GPU 各核对 1,536 个保留目标像素与 1,536 个呈现像素，全部零误差、零 WebGPU/宿主错误。**本轮像素场景为单采样；四倍独立表面只核验引用和清理，不计作新的四倍独立目标像素验收。** 既有 8c 的双 API 四倍附件像素基线保留。
> - 17 组相关核心、239 组完整客体、18 个 D3D8 标准 SDK EXE、两份严格 D3D8 DLL、新绑定 SDK EXE及站点两项集成通过。只发布最终 XP 所测 D3D8 零售 DLL及严格诊断 DLL；D3D9/DDraw 维持原验收文件。宿主/协议/着色器与 bundle `64aa2cd7f7413ccbe760` 不变，继承 7d/e、8c、8h 基线并新增本次双后端 GPU 运行。见 [stage4h6f8i-validation.json](fixtures/d3d-review/stage4h6f8i-validation.json)。
> - 两版独立表面之外的隐式/链/texture/cube/缓冲/着色器/状态块绑定计数、通用设备根引用消失但外部资源存活时的状态保持及完整回调资源图、其他跨设备入口、完整格式/MSAA/呈现/Reset/线程/物理丢失、多缓冲轮转、原生 Microsoft HAL、游戏/FPS、包装转换及阶段 4/5/6 仍未完成。

> **阶段 4H6f8j（2026-11-03）：两版隐式缓存私有对象回调的设备保护与重入清理（S2-42 相关）完成。**
>
> - 隐式 back/depth 私有对象原先在临时设备引用归还后才析构，回调若查询设备会在设备计数零时重入销毁。现在两版都在既有临时引用下清理缓存，随后才归还临时引用并销毁宿主设备和缓存表面；回调保留设备时，后续 store 延后到其最终 Release，回调重新插入的缓存项由循环继续清理。
> - 原始两版源均严格编译，在真实私有 IUnknown 回调的设备引用断言中失败；修复后每版五种顺序、11 次恰好一次的析构通过，覆盖空绑定、仅设备持有绑定、最后一个公开表面、保留父设备及重新写入缓存。新增 14 项变异、原有 16 项私有数据变异通过；清理遗漏变异采用直接脱链，严格编译后以泄漏断言检出，避免把无限循环当作有效结果。
> - XP 使用同一套双 API SDK 用例，十个逻辑设备、22 次实际 AddRef/Release 与协作状态查询、两次保留设备、两次重新插入缓存均通过；被保留设备的深度表面身份与私有对象保持。冻结轨迹逐一核对十次设备创建/销毁、两次 RT/depth 绑定及真实 owner 归还，26 项命令/日志损坏全部检出，没有绘制、Clear、Present 或 Reset。**回调中设备引用为 1 是代理清理安全约束，不是原生 Microsoft HAL 的析构计数测量。**
> - 18 组相关核心、240 组完整客体、六族 ASan/UBSan、32 个标准 SDK EXE、四份严格零售/诊断 DLL、两份新增 SDK EXE及站点两项集成通过；两版发布最终 XP 所测零售 DLL 和严格诊断 DLL，DDraw 维持原验收文件。宿主/协议/着色器和 bundle `64aa2cd7f7413ccbe760` 不变；本轮没有新增 GPU 运行，继承 7d、8c、8h、8i 像素基线。见 [stage4h6f8j-validation.json](fixtures/d3d-review/stage4h6f8j-validation.json)。
> - 本轮只补齐缓存清理顺序；隐式/附加链等公共绑定计数、通用设备根引用消失时的状态保持、任意重入/线程/丢失资源图、其他跨设备入口、完整格式/MSAA/呈现/Reset、多缓冲轮转、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4H6f8k（2026-11-03）：两版隐式表面公共计数、内部绑定与 Reset 外部引用检查（S2-42 相关）完成。**
>
> - D3D8 隐式深度绑定不再取得公开表面引用，沿用设备缓存的物理所有权；主颜色原已使用设备存储。D3D9 隐式主缓冲与自动深度和独立表面共用内部 binding_refs，最后解绑保留由设备拥有的缓存。附加链和普通 texture/cube 的既有绑定模型留给后续步骤。
> - Reset 不再从隐式表面的公共计数中扣除内部绑定数，应用持有的每个公开引用都能阻止 Reset，纯内部绑定则允许重置。两版旧源均严格编译后在实际绑定 helper 增加公共计数的断言中失败；新 native 每版 128 轮、256 次归零恢复，覆盖两种缓存、单个公开设备引用、公开引用存活期间重绑、最后解绑和 Reset 计数。保留 4,256 项 D3D9 实际绑定、D3D8 39 组实际入口及 580/598 项 Reset 资源图。
> - 10 项新增变异、原隐式 23、D3D9 绑定 23、Reset 37、缓存回调 14、私有数据 16、D3D8 绑定 16 / RT 28 项变异及五族 ASan/UBSan 通过。保留测试也改为内部绑定不占公开计数，并用真实零/非零链句柄区分缓存与附加链，避免旧假对象或旧计数假设掩盖失败。
> - 双 API XP 完整 setter/getter 各 32 轮、64 次公共归零恢复与借用重绑；公共计数零时各 Clear/Present 两帧；分别持有 back/depth 引用的两次 Reset 均被拒绝，归还引用后成功。保持已验收的 D3D8 DEVICELOST / D3D9 INVALIDCALL 差异。六个逻辑设备、八个线协议设备句柄、128 次恢复、70 次 RT/70 次 depth 绑定、四次呈现、两次 Reset 与 12 次受保护析构全部核对，34 项轨迹/日志损坏检出，两个真实 owner 归还。
> - 隐式缓存沿用现有 Reset 身份/私有数据保留行为，用例在重置后再次取得同一缓存并检查私有对象，最终释放设备时各析构一次；**这不是原生 HAL 的隐式私有数据 Reset 边界验收。** 首轮 SDK 将 D3D8 返回码误写为 D3D9 值、次轮误以为 Reset 会清理这些缓存，均修正测试假设后重跑；没有因此扩大生产代码改动。
> - SwiftShader / 本机 GPU 各核对四帧、3,072 个主缓冲读回像素及 3,072 个呈现像素，全部零误差、零 WebGPU/宿主错误；本轮为单采样隐式目标，四倍附件基线继续继承 8c/8h。19 组相关核心、241 组完整客体、32 个标准 SDK EXE、四份严格 DLL、两份新增 SDK EXE及站点两项集成通过；发布最终 XP 所测两版零售 DLL 与严格诊断 DLL，DDraw、宿主/协议/着色器及 bundle `64aa2cd7f7413ccbe760` 不变。见 [stage4h6f8k-validation.json](fixtures/d3d-review/stage4h6f8k-validation.json)。
> - 附加链和其他资源绑定公共计数、外部子资源存在时的设备状态保持、完整隐式缓存 Reset/回调/线程/丢失资源图、其他跨设备入口、格式/MSAA/全屏/多缓冲轮转、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4H6f8l（2026-11-03）：D3D9 附加交换链内部绑定与三方物理所有权（S2-42 相关）完成。**
>
> - 附加 back buffer 也使用内部 binding_refs，绑定不再增加公开表面计数或设备引用。物理链、表面和背后 texture 等到公开链、公开表面、内部绑定三类计数全部为零才销毁；公开链/表面的正数边界各只持有一个设备引用。最后解绑可以退休没有公开所有者的链，任一公开对象仍存活则保留存储。
> - 物理链清理先脱链和发送退休命令，再直接进入存储析构，取消伪造表面公共计数后调用 Release 的路径，并移除不再需要的 device_pin_transferred 标志。真正的公共 Release 最后归还自己的设备引用；仅剩绑定时由设备临时引用保护私有对象回调。Reset 对私有绑定不再扣除公开计数，公开链或表面分别阻止重置，仅有绑定允许重置。
> - 实际公共/设备/存储/私有数据方法新增 2,603 项、640 次显式链/表面归零恢复，两个内部槽覆盖五种最后所有者顺序及私有回调。旧源严格编译，在实际绑定仍增加公开表面计数的断言中失败。12 项新增变异、原附加 14、D3D9 绑定 23、独立生存期 12、Reset 37、隐式绑定 10 及完整私有数据/回调变异、七族 ASan/UBSan 通过；原 flag/slot 变异改为真实公开初始计数、父关系、直接物理清理和内部绑定计数故障，均严格编译后以运行时失败检出。完整回归在旧链 fake 处停止，补齐直接存储清理和 binding_refs 后从该组续跑，保留前 128 组已通过结果与首轮失败记录，生产代码未改变。
> - XP 完整 setter/getter/GetContainer/IUnknown 各 32 轮表面与链容器恢复，另有两次呈现用链恢复、两次公开 Reset 阻塞恢复；借用重绑始终保持公开计数零及设备计数一。三设备、四个线协议设备句柄、三链/三存储、36 次 RT/36 次 depth 调用，两次拒绝 Reset、一次仅绑定 Reset、仅绑定最终设备清理及最后解绑，三个私有对象各析构一次且回调设备计数一。115 秒退出，真实 owner 归还；冻结记录 36 项语义损坏全部检出。
> - 首链四倍采样 Clear/Present 两帧，另两份 NONE 链只覆盖最后所有者清理。SwiftShader / 本机 GPU 各核对 1,536 个真正四倍附件独立解析像素、1,536 个解析缓冲读回及 1,536 个呈现像素，全部零误差、零 GPU/宿主错误。三个链上下文全部关闭；首链由 Reset 先退休，另两链由最终设备或解绑显式退休，宿主显式销毁计数为二。
> - 20 组相关核心、242 组完整客体、14 个标准 D3D9 SDK EXE、两份严格 D3D9 DLL、新 SDK EXE及站点两项集成通过。只发布最终 XP 所测 D3D9 零售 DLL及严格诊断 DLL；D3D8/DDraw 维持 8k 文件。宿主/协议/着色器与 bundle `64aa2cd7f7413ccbe760` 不变，继承 7d、8c、8k 基线并新增本次双后端四倍采样运行。见 [stage4h6f8l-validation.json](fixtures/d3d-review/stage4h6f8l-validation.json)。
> - 原生 Microsoft HAL、游戏/FPS、texture/cube/缓冲/着色器/状态块公共绑定计数、外部子资源存活时的设备状态保持、完整回调/线程/丢失/隐式私有缓存 Reset 边界、格式/MSAA/全屏/多缓冲轮转、包装转换及阶段 4/5/6 仍未完成。

> **阶段 4I1（2026-11-03）：DirectDraw 表面颜色键规范化、创建范围拒绝及覆盖键保持（S2-46）完成。**
>
> - SetColorKey 和创建描述预检共用同一规则：未带 COLORSPACE 时忽略调用者的 high，缓存、描述和命令都使用 high=low；显式相等端点允许，不等端点以 NOCOLORKEYHW 拒绝，拒绝时没有缓存/描述/overlay 变更。创建描述四种带标志的键均在分配前校验，未带描述标志的键值忽略；NULL 清除及既有无效参数策略保留。DDBLTFX 的临时覆盖键继续使用范围。
> - 固定 Wine Windows test_range_colorkey 和 surface 实现均核验到 Git blob 字节哈希：创建正/反向范围拒绝、普通键收拢、显式相等接受、显式范围拒绝且原键不变。跨版本由实际共用 thunk 接入，XP 验证的是替代 DLL，未宣称原生 Microsoft HAL 全版本运行结果。
> - native 编译实际 Set/Get、描述 helper 和完整 CreateSurface 入口，分配/格式/窗口部分使用 stub；1,870 项断言、288 组 setter 和 300 组创建预检覆盖四种键、反向/极值、输入不变、无标志描述值及 overlay 失败原子性。旧源严格编译后在实际 high 未收拢的断言中失败；16 项语义变异及 ASan/UBSan 通过，变异均严格编译后以运行时失败检出。
> - XP 实际 DirectDraw 1/2/3/4/7 创建与表面接口各验证四类键，40 次创建范围及 40 次设置范围被拒绝，接受普通/显式相等键、清除及描述回读，输入全部不变。43 个实际表面完整退休，246 条键命令逐条核对，148 秒退出且真实 owner 归还；六种 source/destination Blt/BltFast、两个覆盖范围和缓存恢复均执行，冻结记录 42 项语义损坏检出。
> - **XP 的 CPU 读回回复是模拟值，不作像素验收。** SwiftShader / 本机 GPU 独立重放实际命令，各检查六次实际 GPU 读回、24 个 X8R8G8B8 像素，覆盖单值键、两个端点都保留的覆盖范围及缓存恢复；全部零误差、零读回/回复写入/GPU/宿主错误。重放区分能力/心跳与像素回复，并等待异步读回；没有主表面呈现或新的其他格式像素声明。
> - 21 组相关核心、244 组完整客体、四个标准 DirectDraw SDK EXE、两份严格 DirectDraw DLL、新 SDK EXE及站点两项集成通过；发布最终 XP 所测 DDraw 零售 DLL 和严格诊断 DLL。D3D8/9、宿主/协议/着色器和 bundle `64aa2cd7f7413ccbe760` 不变；继承 7d、8l 基线，新增本次双 GPU 颜色键场景。见 [stage4i1-validation.json](fixtures/d3d-review/stage4i1-validation.json)。
> - S2-47 分版本默认状态/传统 alpha 修正、S2-53 所有权、其余资源公共绑定计数及包装转换、完整格式/Reset/线程/丢失、多缓冲轮转、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4I2（2026-11-03）：D3D1/2/3/7 分版本默认状态与传统 MODULATE alpha（S2-47）完成。**
>
> - 创建版本在初始化前传入公共实现：v1 开启 COLORKEYENABLE、v2 开启 SPECULARENABLE，v1–3 开启 NORMALIZENORMALS；D3D7 保持三者关闭。初始同步只使用有效 Device7 状态，清除复用宿主设备上的零默认值，不再重放旧 TEXTUREMAPBLEND 覆盖 stage 0 的 SELECTARG1(TEXTURE)/CURRENT。
> - 传统 MODULATE 在 ARGB/未绑定纹理时选择纹理 alpha，在 RGB 时选择 CURRENT alpha，绑定变化重新计算；未改变的传统 stage/map 值不切换模式，改变 stage 退出传统模式，改变 map 重新启用。传统 LIGHTING/LOCALVIEWER/NORMALIZENORMALS 查询返回 FFFFFFFF、写入忽略，Device7 视图仍查询实际默认状态；既有 Device7 旧状态拒绝及重复调用缓存行为保留。
> - 固定 Wine device、ddraw1/2/4/7 Windows 测试均核验 Git blob 字节哈希。native 编译实际初始化、同步、render emitter 和状态/绑定函数；非相关矩阵/material/clip 与宿主发送使用 stub。128 轮 RGB/ARGB/NULL 绑定、引用归还、现代显式模式、同值保护、绑定失败回滚及已接受纹理前缀后的 alpha 失败重试通过；保留 170+1,052 项原生状态观察。20 项变异全部严格编译后以运行断言检出，ASan/UBSan 通过。旧前端配当前共享 cascade 头严格编译后在版本默认值断言失败，未宣称整套旧 bundle 对照。
> - XP 经 v1 表面 QI、v2/v3/v7 CreateDevice 四条实际入口创建，并以 Device3/7 视图执行状态和纹理调用。四个逻辑设备共用一个宿主设备，12 个表面完整退休，203 秒、18 批命令，真实 owner 归还；16 次四边形绘制与实际读回命令、28 项冻结记录语义损坏检查通过。**XP 的 CPU 像素回复是模拟值，不作像素验收。**
> - SwiftShader / 本机 GPU 各独立核对 16 次实际 GPU 读回、1,024 个 ARGB 目标 RGBA 像素：纹理 alpha=128、顶点 alpha=64、现代 RGB 纹理 alpha=255，以及显式模式退出/恢复，均零误差、零读回/回复写入/GPU/宿主错误；没有主表面 Present。
> - 22 组相关核心、245 组完整客体、四个标准 DirectDraw SDK EXE、两份严格 DLL、新 SDK EXE及两项站点集成通过；发布最终 XP 所测 DDraw 零售 DLL及严格诊断 DLL。D3D8/9、宿主/协议 ABI/着色器与 bundle `64aa2cd7f7413ccbe760` 不变，继承 7d/4I1 基线并增加本次双后端 alpha 场景。见 [stage4i2-validation.json](fixtures/d3d-review/stage4i2-validation.json)。
> - 混合新旧接口下状态块的传统模式元数据、S2-53 所有权及其他未完成项、其余资源公共绑定计数及包装转换、完整格式/Reset/线程/丢失、多缓冲轮转、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4I3（2026-11-03）：DirectDraw WRITEONLY 锁定保留 GPU 内容及读回失败隔离（S2-48）完成。**
>
> - Lock 先校验矩形和压缩块边界，再同步 GPU 已写入的共享影子；WRITEONLY 仅限制应用读取，不能把完整上传矩形中未修改的像素视为丢弃。读回失败返回 GENERIC，不发布输出指针、不改变锁计数/标志/矩形，保留脏标记以便重试；READONLY 解锁继续不上传。
> - Wine map-flags helper 固定到 Git blob 字节哈希，作为实现证据；没有原生 Microsoft HAL 的 WRITEONLY Windows 对照。native 严格编译实际完整 Lock/Unlock，7,648 项断言、768 次整面/局部 read/write、READONLY、WRITEONLY 锁，覆盖共享 alias、15 个未改像素、压缩指针/边界、无效调用及读回失败重试。旧源严格编译后在 WRITEONLY 未读回的运行断言失败；10 项变异全部以运行断言检出，ASan/UBSan 通过。
> - XP 实际五种表面接口执行十次整面/局部 WRITEONLY 修改，以及错误请求编号、失败状态、短回复三种拒绝及重试；12 个表面完整退休，127 秒、31 批命令，真实 owner 归还。13 次上传的每个字节和 26 次 fill/copy 均与独立意图数据核对；冻结记录 28 项语义损坏全部检出。
> - **XP 的 CPU 回复是显式模拟意图数据。** SwiftShader / 本机 GPU 另行验证全部 29 个实际成功 GPU 回复、464 个 RGBA 像素，包括三种 CPU 拒绝前的原图及 13 份修改后的图像，每份仍有 15 个原像素。CPU 注入错误不会修改 GPU 命令，GPU 回放中的对应请求仍应成功；两后端全部零像素/读回/回复写入/GPU/宿主错误，没有主表面 Present。
> - 23 组相关核心、247 组完整客体、四个标准 DirectDraw SDK EXE、两份严格 DLL、新 SDK EXE及两项站点集成通过；发布最终 XP 所测 DDraw 零售 DLL 和严格诊断 DLL。D3D8/9、D3D1–7 状态实现、宿主/协议/着色器和 bundle `64aa2cd7f7413ccbe760` 不变；继承 7d/4I2 基线，新增本次双后端锁定场景。见 [stage4i3-validation.json](fixtures/d3d-review/stage4i3-validation.json)。
> - native 压缩用例只覆盖指针及边界，不是新增 BC GPU 像素验收。GetDC 失败策略、嵌套锁重新设计、S2-49 至 S2-55/S2-57、所有权及包装转换、完整格式/Reset/线程/丢失、多缓冲轮转、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4I4（2026-11-03）：DirectDraw 索引色主表面调色板即时呈现（S2-49）完成。**
>
> - SetEntries 成功后，只有该调色板正绑定当前 P8 主表面时才立即解析到交换图像并 Present；未绑定/无关调色板、没有主表面和非索引色表面不额外呈现。合法空范围沿用成功调用行为；无效输入不修改缓存或发送命令。解析/Present 失败返回 GENERIC，保留已接受的调色板前缀，同值调用可重试。
> - Wine palette SetEntries 的主表面更新路径核验到 Git blob 字节哈希，仍属实现证据，没有新增原生 Microsoft HAL Windows 对照。native 编译实际完整 Set/GetEntries，375,706 项断言、1,445 组范围/绑定状态，检查 table → resolve → Present 顺序、部分更新、未触及项、输入不变及失败重试。10 项变异严格编译后全部以运行断言检出，ASan/UBSan 通过；旧源严格编译后在实际缺失呈现的计数断言失败。
> - XP 经 DD1/2/3/4/7 五条调色板工厂入口，创建 11 个调色板及一个 P8 主表面。一次索引棋盘上传后，十五次仅 SetEntries 的调用立即呈现，加上初始帧共 16 帧；37 份完整调色板、六次绑定、五次未绑定更新及十次拒绝调用逐项核对，31 项冻结语义损坏全部检出。118 秒、20 批命令，所有公开引用及真实 owner 归还。
> - 测试使用既有 32×24×8 虚拟全屏模式，Win32 模式切换失败后的桥接 fallback；不代表原生模式接受或真实桌面切换。XP 没有像素读回回复。SwiftShader / 本机 GPU 各独立验证 16 帧、12,288 个真实解析主表面读回像素及 12,288 个实际显示像素，所有棋盘颜色、alpha 和呈现时序均零误差、零 GPU/宿主/读回错误。
> - 25 组相关核心（包含既有 DDraw 执行器）、17 组完整 DDraw/D3D1–7 相关客体回归、四个标准 DirectDraw SDK EXE、两份严格 DLL、新 SDK EXE及两项站点集成通过；其余客体继承紧邻 4I3 的 247 组完整回归。只发布最终 XP 所测 DDraw 零售 DLL 和严格诊断 DLL，D3D8/9、宿主/协议/着色器与 bundle `64aa2cd7f7413ccbe760` 不变。见 [stage4i4-validation.json](fixtures/d3d-review/stage4i4-validation.json)。
> - S2-50/51 前缓冲/窗口脏区/非主表面 Flip、S2-52/53/54/55/57、GetDC 调色板 fallback、完整所有权/包装转换/格式/Reset/线程/丢失、多缓冲轮转、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4I5（2026-11-04）：前缓冲即时写入与窗口主表面呈现范围（S2-50）完成。**
>
> - Blt、BltFast、Unlock、ReleaseDC 共用当前主表面呈现 helper；flip chain 的前缓冲写入同样立即显示。窗口模式的屏幕复制将表面/脏区与客户区屏幕坐标求交，优先使用 clipper HWND；没有 HWND 时保留既有整面 fallback。失败的坐标探测跳过屏幕复制，right/bottom 使用 64 位加法避免溢出。更新已接受而解析/Present 失败时返回 GENERIC，不撤回 CPU/GDI/GPU 前缀。
> - native 编译实际范围 helper、屏幕 emitter、呈现 helper、Unlock 和 DC 提交，23,658 项断言、10,800 组窗口/脏区组合，覆盖负坐标、空/越界范围、clipper/window 选择、探测失败、溢出、主/非主表面及有/无 flip chain。13 项变异均严格编译后以运行断言检出；新主表面测试与保留 Lock 测试两族 ASan/UBSan 通过。旧屏幕 emitter、Unlock/DC 配当前 helper 定义严格编译后在整桌面复制越界的断言失败，未宣称完整旧 bundle 对照。
> - XP 在窗口 800×600 主表面和既有 32×24 虚拟全屏 fallback flip-chain 前缓冲上，经五种表面接口分别执行 Blt、BltFast、WRITEONLY Unlock、GDI ReleaseDC；没有调用 Flip，40 次呈现均存在。一次初始 GDI 桌面 seed、30 次确定的 CPU/GDI 上传、20 次 GPU 写入、40 次屏幕复制及十次写前读回逐项核对；冻结记录 30 项语义损坏全部检出，108 秒、57 批命令，真实 owner 归还。
> - 写前 CPU 读回回复填零，只用于随后完整覆盖的内存，不作像素验收。SwiftShader / 本机 GPU 各验证十个真实客体读回成功回复、40 个独立画面读回及实际显示区域，每后端 30,720 个读回和 30,720 个显示像素全部零误差；窗口模式实际呈现的桌面遮罩固定为客户区 (30,40)–(62,64)，没有扩大到全桌面，虚拟全屏不使用桌面遮罩。没有新增原生模式切换或 HAL 声明。
> - 28 组相关核心（含执行器、页面合成和网络路由）、19 组完整 DDraw/D3D1–7 相关客体回归、四个标准 DirectDraw SDK EXE、两份严格 DLL、新 SDK EXE及两项站点集成通过；其余客体继承 4I3 的 247 组完整回归。发布最终 XP 所测 DDraw 零售 DLL 和严格诊断 DLL；D3D8/9、宿主/协议/着色器与 bundle `64aa2cd7f7413ccbe760` 不变。见 [stage4i5-validation.json](fixtures/d3d-review/stage4i5-validation.json)。
> - **S2-53 的隐式后缓冲 CPU/存储清理缺陷仍保留在记录中：** 五份实际纹理、四条显式表面销毁命令，另一个隐式子表面随宿主设备结束处理，其客体分配未单独清理；本阶段不宣称完成客体资源图。S2-51 overlay Flip、S2-52/53/54/55/57、GetDC 失败策略、复杂窗口/遮挡/线程/丢失、完整所有权与包装转换/格式/Reset、多缓冲轮转、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4I6（2026-11-04）：overlay Flip 的存储、显示绑定与主底图保持（S2-51）完成。**
>
> - 非主表面 Flip 不再把源图 1:1 复制到主底图。默认 Flip 轮转各缓冲的 handle/storage/memory/shadow/external/upload-pending；指定后缓冲只交换前缓冲和指定成员，其他成员不变。公共表面、调色板/颜色键和 overlay id 保持身份；轮转后重新发布受影响的可见 overlay 源/目标句柄，只为主表面或可见 overlay 变化呈现，隐藏/无关离屏链保持静默。self/非成员/foreign 指定目标先拒绝，呈现故障保留已接受的存储前缀。
> - Wine Flip 实现核验到 Git blob 字节哈希：默认轮转、指定成员交换、拒绝 self/非成员，只有主表面更新 frontbuffer。native 编译实际 Flip 和 helpers，2,830 项断言、512 次双/三缓冲默认/指定 Flip，覆盖耦合字段、稳定 id、源/目标重绑、主底图、隐藏/离屏、拒绝及故障前缀。13 项变异严格编译后以运行断言检出，ASan/UBSan 通过；旧实际 Flip 配当前 helper 定义严格编译后在错误的 screen/overlay/Present 行为断言失败。
> - XP 经五种表面 Flip 接口，15 次可见、五次隐藏、十次 self/无关目标拒绝、一次静默离屏 Flip，执行 46 次 CPU 影子颜色检查。37 帧含 36 条稳定 overlay 更新、22 次上传、276 次键重放及 22 个背景对照，122 秒、41 批命令，真实 owner 归还。SHOW/HIDE 仍沿用排队策略；SDK 只在这些观察点显式写背景以呈现，Flip 观察帧没有背景写入，不宣称修改 SHOW/HIDE 的即时呈现策略。首轮控制帧标签与实际 Present 不符的记录保留在 ignored build 目录，最终使用重新录制的捕获。
> - SwiftShader / 本机 GPU 各独立检查 37 帧、28,416 个真实主底图读回像素和 28,416 个实际合成显示像素；底图保持纯背景，overlay 始终在 (8,6)–(24,18)，默认/指定目标和隐藏显示均符合独立颜色/物理存储序列。36 次 overlay 更新、31 次实际合成、零像素/读回/回复写入/GPU/宿主错误。XP 没有 CPU 像素回复，使用既有 32×24 虚拟模式 fallback，不代表原生 HAL/模式接受。
> - 29 组相关核心、21 组完整 DDraw/D3D1–7 相关客体回归、四个标准 DirectDraw SDK EXE、两份严格 DLL、新 SDK EXE及两项站点集成通过；其余客体继承 4I3 的 247 组完整回归。发布最终 XP 所测 DDraw 零售 DLL 和严格诊断 DLL。D3D8/9、宿主/协议/着色器与 bundle `64aa2cd7f7413ccbe760` 不变。见 [stage4i6-validation.json](fixtures/d3d-review/stage4i6-validation.json)。
> - S2-53 隐式子表面缺陷仍明确保留：七份纹理、四条显式物理销毁，另三份子存储没有独立客体清理，不据此宣称资源图完整。广泛 Flip caps/lock/DC/format/interval、external 描述指针语义、S2-52/53/54/55/57、完整所有权/包装转换/回调/线程/丢失/Reset、多缓冲全覆盖、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4I7（2026-11-04）：执行缓冲预光照颜色与传统视口裁剪空间映射（S2-52）完成。**
> - `TRANSFORM` 按 LVERTEX 布局保留 diffuse、specular 和 UV，不再依赖无关的照明准备；仅 `TRANSFORMLIGHT` 执行照明。保留并验证 NOCOLOR 的两个颜色字段、COPY、源/目标边界和 UPDATEEXTENTS 的既有项目契约，不将 Wine 尚未完整实现的标志行为当作原生结论。
> - 旧设备保存应用的逻辑投影，共用 Device7 状态保存 `logicalProjection * legacyClipspace`；Device2/3 Set/Get/Multiply 和 Execute STATETRANSFORM 统一走这条路径。V1 的 dvScaleX/Y、V2 的 dvClip*/MinZ/MaxZ 均在齐次除法前生效，宿主 viewport 深度固定 0..1；重复激活不会累乘。V1 MaxX/Y 与 MinZ/MaxZ 按已钉住的 Wine 行为忽略。
> - TransformVertices 使用调用所指的视口而不改动当前视口；复制完整 16 字节 payload，CLIPPED HOut 返回视口变换前的齐次坐标，offscreen 返回裁剪标志交集。保留安全的 32 字节 stride/NULL 检查和零 W 策略；拒绝顶点的 XYZW 只沿用 Wine 实现，不宣称原生输出值有定义。
> - 实际 C **2,281 检查、128 次重复激活、128 次预光照处理**，冻结 Windows/Wine 的六组位置和四组裁剪向量；**16/16** 严格编译后的运行时变异检出，旧实际函数配合新 helper 的运行时负对照及 ASAN/UBSAN 通过。保留状态块的 170+1,052 项观察及传统默认状态回归通过。
> - 实际 XP CRT-free SDK：**2 个视口 × 3 个投影 × Execute/D3D2/D3D3 = 18 次绘制/读回**，36 个 CPU 顶点、576 字节 payload、12 次逻辑投影查询；109 秒、20 批次、一个真实 owner/release，磁盘只写 RAM overlay。XP 像素回复是传输控制；场景显式 LIGHTING=FALSE，真实颜色由后续 GPU 回放验证。
> - SwiftShader 与 Metal 各验证 **4,608 个实际像素，零误差**，包括视口范围、投影乘法顺序、深度归一化与执行/直接绘制颜色一致性；39 种冻结指令语义破坏全部拒绝。首次对照对 raw LVERTEX 布局、Clear 仅覆盖当前视口及默认照明的错误假设已修正并保留原工件；生产修复未因此更改。
> - 本轮完整 DDraw/D3D1–7 **23 suites**、核心相关 **30 suites**，四个标准 EXE、retail/diagnostic DLL 和自定义 SDK 严格构建、站点集成 2 项及两侧零新增 lint 问题通过。继承 4I3 的全客体 247 suites 和 4H6f7d 的完整核心/GPU 基线；准确发布本次通过 XP 的 DDraw DLL 与严格构建 diagnostic，D3D8/9、host/protocol/shader 和 bundle `64aa2cd7f7413ccbe760` 保持原版本。证据：`docs/fixtures/d3d-review/stage4i7-validation.json`，站点镜像 `glbridge/deployments/d3d-webgpu-review-4I7.json`。
> - 默认照明下无 normal FVF 的完整行为、混用 Device7/传统接口时的状态块私有元数据、完整 viewport 验证/Execute 裁剪及照明标志、S2-53/54/55/57、所有权/包装转换/格式/Reset/线程/丢失、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4I8（2026-11-04）：DirectDraw 创建引用、父存储保活与复杂表面清理（S2-53）完成。**
> - DirectDraw 公开引用与物理存活计数分开：DD4/7 创建的显式表面和调色板各增加一个公开父引用，DD1/2 及项目 DD3 不增加；表面/调色板/裁剪器的分配各持有一个内部存活引用。这样既符合已钉住的公开计数增量，也允许 DD1/2 在最后一个公开父引用释放后继续使用子对象。最后一个公开/内部引用统一触发父对象回收。
> - 复杂 flip 根拥有整条链，销毁时清理全部隐式成员及其 GPU storage/CPU memory；隐式成员公开计数到零时保留至根销毁。mip/cube 隐式子成员采用同样的根清理规则，显式软附件则正常 Release。拒绝移除隐式复杂边，创建后缓冲失败时回滚整条部分链。父公开/内部引用均在子对象解除列表、完成宿主和内存清理后释放。
> - SetPalette/SetClipper 先 AddRef 替换对象，再 Release 旧对象，避免仅由表面持有的同一对象被提前释放。分版本创建包装传递创建版本；DuplicateSurface 继续共享 storage/memory，并采用项目创建版本配置；Wine DuplicateSurface 仍是 partial stub，这一重复表面配置不宣称完整原生接口计数结论。
> - 实际 C **98,967 检查、160 创建配置、每种绑定 10,240 次同指针替换、32 复杂图、32 软附件、4 个分配失败回滚**；实际运行时/工厂函数配合构造及宿主发送 stub，确定性 tombstone 检出提前释放，ASAN/UBSAN 最终实际释放所有分配。**18/18** 严格编译后的运行时变异检出，旧实际所有权函数配合新 helper 运行时负对照通过；保留颜色键 1,870 检查和 16 变异。
> - 实际 XP 完整分配器/构造器：DD1/2/3/4/7 五配置，公开父引用增量、每类 80 次仅由表面持有的同指针绑定、全部公开父引用释放后的上传和别名 GPU 复制；五个复杂根清理十个仍有公开引用的隐式成员。**30 个表面对象共享 25 份物理纹理、5 个调色板、5 个裁剪器、5 次读回**；139 秒、11 批次、一个真实 owner/release，磁盘仅 RAM overlay。
> - SwiftShader/Metal 各验证 **320 个实际复制像素，零误差**；25 份纹理均收到显式销毁，五个 DeviceDestroy 前分别已清空对应纹理；处理真实 owner 释放之前，实际宿主设备表/资源表已为空。五个设备共用一个 owner session；修正测试最初按五个设备计五次 session end 的假设，生产及 XP 捕获没有改动。36 种冻结语义破坏全部拒绝。旧阶段工件中记录的隐式泄漏作为历史证据保留。
> - 本轮 DDraw/D3D1–7 **25 suites**、核心相关 **31 suites**，四个标准 EXE、retail/diagnostic DLL、自定义 CRT-free SDK、内存检查、站点集成 2 项和两侧零新增 lint 问题通过。继承 4I3 全客体 247 suites 和 4H6f7d 完整核心/GPU 基线，准确发布通过 XP 的 DDraw DLL 与严格 diagnostic；D3D8/9、host/protocol/shader/bundle `64aa2cd7f7413ccbe760` 保持原版本。证据：`docs/fixtures/d3d-review/stage4i8-validation.json`，站点镜像 `glbridge/deployments/d3d-webgpu-review-4I8.json`。
> - 逐接口独立公开计数、隐式初始公开计数、任意回调/重入图及循环、软 detach/caps 完整规则、完整线程/丢失/Reset/格式/包装转换、S2-54/55/57、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4I9（2026-11-04）：共用纹理 Load 的 mip/立方体/元数据转换与宿主普通立方体写入（S2-54）完成。**
> - Device7 Load 先校验全部源面/目标 mip 子集，再复制 flags 选择的立方体面；flags=0 不复制立方体，普通 2D 忽略 face flags。目标可从较小尺寸顶层起匹配源链，坐标按每个源层缩小，原点向下、右/下边界向上取整，调用方 POINT/RECT 保持原值。采用 Wine/Win98 RGB 坐标规则，不新增 XP/Win8 的已记录坏变体。
> - Texture1/2 复制共同的 mip 前缀，允许层数不同并保留目标后缀；源有调色板时要求已有目标调色板，复制表而不替换对象。旧接口只复制 SRCBLT key，Device7 复制源中所有已设置的 key；源缺失的目标 key 保留。旧加载访问层清除 ALLOCONLOAD，缺调色板失败也保留此前缀。共用原始子资源复制绕过表面 clipper/key 过滤、保持 mip/face 地址，保留已接受前缀并报告传输失败，外部内存仍同步。mip 描述标记 MIPMAPSUBLEVEL，附件查询支持仅 caps2 的 mip 条件。
> - 实际 C **9,671 检查、384 组冻结 Windows/Wine 用例**，覆盖子链、奇数坐标、cube 选择/全图预检、调色板身份、颜色键、长短 mip、ALLOCONLOAD、输入不变、外部内存与失败前缀。**20/20** 严格编译后的运行时变异检出、旧实际前端配新 helper 的冻结 HRESULT 负对照及 ASAN/UBSAN 通过。
> - XP CRT-free SDK 请求 **60 表面节点共享 9 份纹理（含两份 cube）、35 上传、29 清屏、23 复制、29 次读回、5 拒绝**，逐层观察全部六面、两个选中面与四个保留面、offset=2 的较小顶层子链及 Texture1/2 P8 前缀/后缀。原始调色板对象/整表、颜色键及 caps 前缀均有实际 API 检查；122 秒、31 批次、一个真实 owner/release，只写 RAM overlay。CPU 像素回复仅作传输控制。
> - 实际回放发现普通 cube 没有清屏所需的 RenderAttachment 权限。共用宿主 cube 创建现采用 2D 的可渲染/非压缩准入规则，公开 usage flags 保持原值、BC 仍不作附件。RGB/索引 cube 的六面三级及压缩排除加入执行器检查，fake device 检查附件存储权限；旧宿主模块在同一捕获上真实复现十八个 cube 图像失败，另十一个非 cube 图像正确。修复后 SwiftShader/Metal 各核对 **29 图像、1,037 实际像素，零误差/零 GPU 或宿主错误**；9 份纹理全部显式销毁，真实 owner 释放之前实际设备/资源表均为空。40 项冻结语义破坏均拒绝。
> - 新 helper 补齐了仓库统一错误诊断后重新捕获 XP；保留早期工件。1×1 CPU 读回按原有 8 字节行对齐处理，上传仍紧密打包，GPU 对照按 pitch 取像素；最初把 1×1 读回当作 4 字节的验证假设已修正。新增 fake case 也在检查附件前提交缓冲帧，并按 API 默认值处理省略的 mip/layer=0。
> - 宿主资源策略改变后新跑 **完整核心 238 suites**、DDraw/D3D1–7 **27 suites**、26 个 DDraw 执行器和保留的 178 个 D3D9 执行器用例、四个标准 EXE、retail/diagnostic DLL、自定义 SDK、站点集成 2 项及两侧零新增 lint 问题。两种 GPU 各另跑 **533 conformance cases** 和既有 **84 帧/252 色探针纹理复制**，本阶段合计六次通过的 GPU 运行及一次旧模块负对照；其余客体继承 4I3 全 247 suites。
> - 图形包重建并同步至 **`9335ee9a77fb7cc808d2`**，页面及全部 worker revision 一致；四个 CPU 产物与前一提交、核心 build 均逐字节一致，协议 ABI/着色器语义和 D3D8/9 DLL 不变。发布本次 XP 的准确 DDraw DLL 与严格 diagnostic。证据：`docs/fixtures/d3d-review/stage4i9-validation.json`，站点镜像 `glbridge/deployments/d3d-webgpu-review-4I9.json`。
> - 传统接口 cube 支持是项目既有扩展；安全的负坐标/NULL/非顶层拒绝和传输失败返回，不复制原生崩溃/静默失败。部分 cube 创建、任意公开子级 palette/key 继承及限制、完整格式/压缩/回调/线程/丢失/Reset/包装转换、S2-55/57、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4I10（2026-11-04）：DX3 灯光默认启用与完整 D3DLIGHT2 标志（S2-55）完成。**
> - 共用旧灯光 SetLight 按调用方结构大小选标志：76 字节 D3DLIGHT 及未包含完整 flags 的尺寸默认 ACTIVE，80 字节 D3DLIGHT2 保留显式 0/ACTIVE/NO_SPECULAR。输入保持原值，当前视口即时更新，未选中/脱离视口只更新缓存；既有 NO_SPECULAR 翻译继续独立作用于 specular。
> - 实际 C **59,995 检查、2,304 次尺寸/标志转换**，精确尺寸分配验证不越读 DX3 尾部，覆盖输出边界、显式禁用、镜面色、非当前/脱离隔离、NULL/短结构拒绝及已接受的传输失败前缀。**6/6** 严格编译后运行时变异检出、旧实际源的运行时负对照及 ASAN/UBSAN 通过。
> - CRT-free XP SDK 在一个真实灯光上运行 **9 状态 × Execute TRANSFORMLIGHT / D3D3 原始法线两路径**，含蓝/黑/红、完整标志 0 与 NO_SPECULAR、脱离后红色缓存和重附着。9 次 diffuse/specular 查询、2 次非法输入拒绝、18 次真实读回；119 秒、20 批次、一个真实 owner/release，只写 RAM overlay。最初 SDK 把启用查询与 TRUE=1 比较，现按已钉住的返回值 0x80 检查，生产实现未因此改变，早期失败工件保留。
> - 独立像素期望及冻结流检查含 **43 项语义破坏**；SwiftShader/Metal 各核对 **18 图像、1,152 实际像素，零误差/零 GPU 或宿主错误**。XP 的模拟像素回复仅用于传输；双 GPU 验证真正图像。单纹理和设备均显式销毁，真实 owner 释放前实际资源/设备表为空。
> - 新跑核心相关 **33 suites**、DDraw/D3D1–7 **29 suites**、四个标准 EXE、retail/diagnostic DLL、自定义 SDK、站点集成 2 项及两侧零新增 lint 问题；其余继承 4I9 完整核心 238 suites/六次 GPU 和 4I3 完整客体 247 suites。发布准确 XP DDraw DLL 与严格 diagnostic；D3D8/9、宿主/协议/着色器及图形包 `9335ee9a77fb7cc808d2` 不变。证据：`docs/fixtures/d3d-review/stage4i10-validation.json`，站点镜像 `glbridge/deployments/d3d-webgpu-review-4I10.json`。
> - GetLight 原始调用方尺寸怪癖、完整 type/range 验证、任意多灯顺序、S2-57、完整格式/线程/丢失/Reset/包装转换、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4I11（2026-11-04）：无源 ROP 填充与 P8 GetDC 调色板快照（S2-57）完成。**
> - BLACKNESS/WHITENESS 在源检查前转换为共用 native-pixel 填充；NULL 源和被忽略的已锁源可用。SRCCOPY 仍检查有效未锁源，缺 fx/其他 ROP 返回明确错误；调用方 fx/RECT 不变，裁剪、外部内存同步和呈现失败前缀沿用。白色用 P8 索引 255 或目标 RGB 掩码，ARGB alpha=0，与 Windows 测试记录一致。
> - P8 GetDC 按自身 palette、当前主表面 palette、既有空表取快照；继承只影响 DC，不给表面绑定 palette。采用 Wine 的主调色板回退策略，不声称完整原生系统调色板或已打开 DC 的实时变更。
> - 实际 C **73,524 检查**，含 **1,024** 个 P8/565/555/ARGB32 填充与 **256** 份完整颜色表，覆盖裁剪/调用方守卫/自身优先/无 owner/无 primary palette/GDI 失败及既有读回失败策略。**11/11** 严格编译后的运行时变异检出、旧实际源运行时负对照及 ASAN/UBSAN 通过。
> - XP CRT-free SDK 通过 Surface1/2/3/4/7 实际执行 **10 填充、20 份 GetDIBColorTable（5,120 条）、1,280 次 SetPixelV、15 次拒绝、30 次读回**。先验证继承后表面仍未绑定 palette，再显式绑定仅用于索引预览。一个主表面和十个普通表面全部释放；111 秒、34 批次、一个真实 owner/release，仅写 RAM overlay。8×8×8 虚拟模式是项目测试配置，不是原生 HAL 模式验收。
> - 冻结流检查准确的 **55 份表、55 次绑定、20 个索引上传、10 填充/20 复制**，**37 项语义破坏**均拒绝。最初 reader 把公开 DDSCL_NORMAL=8 当作线上的 cooperative_flags，已改用既有映射值 1；生产、SDK 和捕获不变。SwiftShader/Metal 各核对 **30 图像、1,920 实际像素，零误差/零 GPU 或宿主错误**；11 纹理显式销毁，真实 owner 释放之前实际资源/设备表为空。XP 模拟回复只作传输控制。
> - 新跑核心相关 **34 suites**、DDraw/D3D1–7 **31 suites**、四个标准 EXE、retail/diagnostic DLL、自定义 SDK、站点集成 2 项及两侧零新增 lint 问题，继承 4I9 完整核心 238 suites/六次 GPU 和 4I3 完整客体 247 suites。发布准确 XP DDraw DLL 与严格 diagnostic；图形包 `9335ee9a77fb7cc808d2`、D3D8/9 和宿主/协议/着色器保持一致。证据：`docs/fixtures/d3d-review/stage4i11-validation.json`，站点镜像 `glbridge/deployments/d3d-webgpu-review-4I11.json`。
> - 原生无调色板时的系统 palette、打开 DC 后实时 palette、GetDC 读回失败策略、完整格式/深度/压缩 ROP 矩阵、任意 ROP 真值表、回调/线程/丢失/Reset/包装转换、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4J1（2026-11-04）：D3D9 二维纹理 sampler/目标的公开计数与内部存储分离（S2-42 / Reset 后续）完成。**
> - 二维纹理新增内部 binding_refs；实时 SetTexture 和纹理层目标只保留内部存储，不增加共享父纹理/层表面的公开 COM 计数。公开 0→1 只添加一个设备 pin，1→0 先处理存储再最后释放设备；GetTexture、GetRenderTarget、GetSurfaceLevel/GetContainer 可从公开零计数恢复同一对象。独立目标的私有 backing texture 继续沿用原有设备引用转移。
> - 共用存储销毁在公开/私有计数均零时执行，先从资源链摘除，再清理 private data、缓存层视图和像素。实时替换先发布新绑定，再释放旧对象；清理设备绑定采用私有二维引用。Reset 只按外部共享公开计数/锁判断二维 DEFAULT 资源，不再把 sampler/纹理层目标私有引用作为公开计数折扣。录制/已完成状态块的公开引用保留原策略，留待后续收敛。
> - 新实际 C **86,784 检查、1,024 组 pool/销毁顺序、8,192 次公开归零恢复**，含四 sampler 与两目标同时持有、层视图共享计数、查询设备 pin、同对象重绑、非法 stage/外设备、锁/池 Reset、设备先释放/最后公开引用/显式解绑。**13/13** 严格编译后运行时变异、旧实际方法配新 helper 的运行时负对照及 ASAN/UBSAN 通过，既有独立 RT/depth 生命周期检查继续保留。
> - CRT-free XP 使用两个 DEFAULT 二维纹理、三个 sampler 绑定、**128 次**纹理及层视图恢复；公开归零后画出红色，公开归零 RT 写蓝色并查询容器，再解绑目标后采样蓝色。有外部 DEFAULT 纹理引用的 Reset 被拒，释放后仅绑定允许 Reset；新设备 sampler 全空，绿色清屏读回通过。**126 秒、5 批次、一个 owner/release、3 次读回**，只写 RAM overlay；模拟 XP 像素只验证传输。
> - 冻结流核对一个 2×2 上传、四 sampler 设置、两纹理目标切换、两次完整顶点绘制、Reset 和两份准确资源销毁；**39 项语义破坏**均拒绝。SwiftShader/Metal 各核对 **3 图像、192 实际像素，零误差/零 GPU 或宿主错误**。实际顺序为排入 Reset 后、后续渲染前销毁绑定纹理；最初 reader 的“销毁在 Reset 前”假设已修正，生产/SDK/捕获不变。真实 owner 释放前设备/资源表为空。
> - 新跑 **完整客体 265 suites**、核心相关 **35 suites**、14 个标准 D3D9 EXE、retail/diagnostic DLL、自定义 SDK、站点集成 2 项和两侧零新增 lint 问题。完整核心 238 suites/六次 GPU 基线继承 4I9。引用拆分后旧 harness 加入共用销毁提取/新类型，并把变异定位改到真实新函数，避免编译失败冒充语义检出；初次 263 组的 7 项适配问题和中间工件均保留。发布准确 XP D3D9 DLL 与严格 diagnostic，D3D8/DDraw、宿主/协议/着色器及包 `9335ee9a77fb7cc808d2` 不变。证据：`docs/fixtures/d3d-review/stage4j1-validation.json`，站点镜像 `glbridge/deployments/d3d-webgpu-review-4J1.json`。
> - S2-56 的表格状态同步至已完成的 4H5a 证据。D3D8、cube/volume/缓冲/着色器/状态块绑定计数、外部子资源存活时设备根状态保持、任意重入/线程/丢失/完整 Reset/格式/MSAA/全屏/多缓冲/包装转换、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4J2（2026-11-04）：D3D9 cube sampler/面目标的公开计数与六面存储（S2-42 / Reset 后续）完成。**
> - cube 采用二维已验证的公开/私有引用分离：sampler 和 cube 面目标只持有 binding_refs，公开 0→1 保留一个设备 pin，1→0 最后归还；归零后 GetTexture、面/目标/容器查询恢复同一共享父计数。共用物理销毁先摘除资源链，再清理父/六面 private data、所有缓存视图/像素，清理设备/Reset 使用私有引用，DEFAULT 公开计数不再扣除 cube 绑定槽。
> - **纠正 4J1 的 cube 分类回归：** 实际 GetCubeMapSurface 同时设 texture_child 和 cube_texture，而二维 parent 为 NULL。绑定分支现先识别 cube_texture。新 native suite 通过实际构造函数取得全部六面；在新引用模型上单独换回 4J1 分类分支，ASAN/UBSAN 准确复现空二维 parent 访问。该反例单独保留，不计入 13 项运行时断言变异，也不改写 4J1 历史捕获。
> - 新实际 C **104,192 检查、1,024 pool/销毁顺序、8,192 次公开归零恢复**，覆盖四 sampler、两面目标、实际六面缓存、设备 pin、共享计数、Reset 锁/公开引用、非法 stage/外设备及四种最终拥有者顺序；保留二维 **86,784** 检查和独立目标 suite。**13/13** 严格编译后运行时断言变异、旧实际 cube 方法配新 helpers 的计数负对照、分类 sanitizer 反例及修复后 ASAN/UBSAN 通过。
> - XP 构造一个 DEFAULT RT cube，初始化六个 8×8 面，经三个 sampler 保留；**128 次** cube/面公开恢复及 **256 次** private data 查询。依次采样六色，再把公开为零的面 4 改橙色并验证面 5 保留；目标/容器共享计数、外部 cube 引用阻止 Reset、仅绑定允许 Reset、Reset 后读回均通过。**136 秒、11 批次、一个 owner/release、9 读回**，只写 RAM overlay，XP 模拟像素仍只作传输。
> - 冻结流核对六面初始目标、面 4 编辑与两次回 back buffer、三个 sampler、8 次绘制、8 次清屏、9 次读回及 Reset 后准确 cube 销毁。**35 项语义破坏**均拒绝；初始 reader 的销毁种类沿用二维值 3，现按 cube=4 冻结，生产/SDK/捕获不变。SwiftShader/Metal 各核对 **9 图像、576 实际像素，零误差/零 GPU 或宿主错误**；真实 owner 释放前设备/资源表为空。
> - 新跑 **完整客体 267 suites**、核心相关 **36 suites**、14 个标准 D3D9 EXE、retail/diagnostic DLL、自定义 SDK、站点集成 2 项及两侧零新增 lint 问题，继承 4I9 完整核心 238 suites/六次 GPU。发布准确 XP D3D9 DLL 与严格 diagnostic；D3D8/DDraw、宿主/协议/着色器及包 `9335ee9a77fb7cc808d2` 不变。证据：`docs/fixtures/d3d-review/stage4j2-validation.json`，站点镜像 `glbridge/deployments/d3d-webgpu-review-4J2.json`。
> - D3D8、volume/缓冲/着色器/状态块的绑定计数、外部子资源存活时设备根状态保持、任意回调/线程/丢失/完整 Reset/格式/MSAA/全屏/多缓冲/包装转换、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4J3（2026-11-04）：D3D9 体纹理 sampler/层视图的公开计数与体数据存储（S2-42 / Reset 后续）完成。**
> - volume sampler 只保留内部 binding_refs，公开计数由父纹理/所有缓存 volume 层共享；公开 0→1 只持有一个设备 pin，1→0 先处理物理存储再最后归还。共用销毁摘除 volume 资源链并清理父/层 private data、缓存视图与切片像素。实时替换、设备清理和 Reset 使用私有 volume 引用；三类纹理都不再把私有 sampler 槽作为 DEFAULT 公开计数的折扣。
> - 新实际 C **70,656 检查、1,024 pool/最终拥有者组合、8,192 次公开归零恢复、64 轮二维→cube→volume→二维替换**，覆盖四 sampler、两层缓存与共享计数、设备 pin、锁/外部公开引用 Reset、非法层/stage/外设备及四种清理顺序。**14/14** 严格编译后运行时变异、旧实际 volume 方法配新 helpers 的计数负对照及 ASAN/UBSAN 通过，保留二维 86,784/cube 104,192 检查与独立目标 suite。
> - XP 构造 **4×4×4 DEFAULT dynamic volume + 2×2×2 mip**，上传六个切片，经三个 sampler 保留；**128 次**父/层/容器恢复、256 次 private data 和 128 次容器查询，公开转换设备 pin 逐项核对。采样四个基级切片，通过缓存层只改 slice 2 并验证 slice 3 保留；显式 MIPFILTER POINT/MAXMIPLEVEL=1 选择两个较小层切片。父公开引用及仅子层引用分别阻止 Reset，释放后仅绑定允许 Reset。**139 秒、11 批次、一个 owner/release、9 读回**，仅写 RAM overlay；XP 模拟回复仍只验证传输。
> - 冻结流核对 **7 个准确切片上传、8 绘制、1 清屏、9 读回**，独立校验 UpdateTexture 的 z/depth/slice_pitch、三维坐标、mip 选择和 Reset 后准确 volume 销毁；**45 项语义破坏**均拒绝。MIN/MAG POINT 属于默认值，guest 会过滤重复写，reader 已用共享默认值初始化并仍要求显式 mip 状态，清除复用 cube reader 的残留变量；生产/SDK/捕获不变。SwiftShader/Metal 各核对 **9 图像、576 实际像素，零误差/零 GPU 或宿主错误**；真实 owner 释放前实际设备/资源表为空。
> - 新跑 **完整客体 269 suites**、核心相关 **37 suites**、14 个标准 D3D9 EXE、retail/diagnostic DLL、自定义 SDK、站点集成 2 项及两侧零新增 lint 问题，继承 4I9 完整核心 238 suites/六次 GPU。三类 sampler 均已私有化，旧 D3D9 Reset 的“最后 sampler 公共引用折扣”变异相应改为“私有 sampler 错误折扣”，D3D8 原最后槽控制保留。发布准确 XP D3D9 DLL 与严格 diagnostic；D3D8/DDraw、宿主/协议/着色器及包 `9335ee9a77fb7cc808d2` 不变。证据：`docs/fixtures/d3d-review/stage4j3-validation.json`，站点镜像 `glbridge/deployments/d3d-webgpu-review-4J3.json`。
> - D3D8、缓冲/声明/着色器/状态块绑定计数、外部子资源存活时设备根状态保持、任意回调/线程/丢失/完整 Reset/格式/MSAA/全屏/多缓冲/包装转换、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4J4（2026-11-04）：D3D9 VB/IB 私有绑定与 UP 绘制清理（S2-42 / Reset 后续）完成。**
> - 顶点 stream/索引槽采用私有 binding_refs；多槽共享缓冲不改变公开 COM 计数，公开 0→1/1→0 只转换一个设备 pin。共用 VB/IB 存储销毁先摘除资源链，清理 private data、裁剪记录和像素影子，再最后归还设备。实时替换先发布新槽/属性，再释放旧存储；普通清理、PrimitiveUP 的 stream 0、IndexedUP 的 stream 0/IB 全部使用同一套私有释放规则。
> - DEFAULT Reset 按公开计数/锁判断，不扣除私有 stream/index 槽；录制/已完成状态块仍保留原公开持有规则。新实际 C **91,904 检查、1,024 pool/最终拥有者组合、16,384 次公开归零恢复**，覆盖三个 VB stream、一个 IB、Getter offset/stride、分别隔离的 VB/IB 公开 Reset 阻塞、UP 解绑和影子/裁剪清理。初始 75,520 检查补上仅 IB 公开引用的 Reset 观察后达到当前数量；**27/27** 严格编译后运行时变异、旧实际方法配新 helpers 的计数负对照及 ASAN/UBSAN 通过，三类纹理和独立目标检查保留。
> - XP 使用 **3 VB / 2 IB、256 次恢复、256 次 private data 查询**，精确核对设备 pin。公开为零的缓冲通过 **offset=16** 执行索引绘制，局部更新顶点后变蓝；PrimitiveUP 只解绑并销毁 stream 0 的 VB、保留 IB；IndexedUP 解绑并销毁两者。新缓冲的 VB/IB 外部公开引用分别阻止 Reset，仅绑定允许 Reset，之后空槽和清屏读回正确。**129 秒、7 批次、一个 owner/release、5 读回**，仅写 RAM overlay；模拟 XP 像素只作传输。
> - 冻结流核对 **6 次准确上传、3 次 stream / 2 次 indices 设置、2 次索引绑定绘制、各一次 PrimitiveUP/IndexedUP、1 清屏、5 读回**，包含前缀守卫、局部更新、完整顶点/索引布局以及 UP/Reset 五份准确缓冲销毁；**60 项语义破坏**均拒绝。SwiftShader/Metal 各核对 **5 图像、320 实际像素，零误差/零 GPU 或宿主错误**；真实 owner 释放之前设备/资源表为空。
> - 新跑 **完整客体 271 suites**、核心相关 **38 suites**、14 个标准 D3D9 EXE、retail/diagnostic DLL、自定义 SDK、站点集成 2 项和两侧零新增 lint 问题，继承 4I9 完整核心 238 suites/六次 GPU。旧 D3D9 Reset 的最后 stream 公共引用折扣变异改为私有缓冲错误折扣控制，D3D8 原控制保留；private-data selectors 跟随真实物理销毁函数。发布准确 XP D3D9 DLL 与严格 diagnostic；D3D8/DDraw、宿主/协议/着色器及包 `9335ee9a77fb7cc808d2` 不变。证据：`docs/fixtures/d3d-review/stage4j4-validation.json`，站点镜像 `glbridge/deployments/d3d-webgpu-review-4J4.json`。
> - NULL stream 的 offset/stride 零售边界、D3D8、声明/着色器/状态块绑定计数、外部子资源存活时设备根状态保持、任意回调/线程/丢失/完整 Reset/格式/MSAA/全屏/多缓冲/包装转换、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4J5（2026-11-04）：D3D9 声明/VS/PS 私有绑定与公开归零恢复（S2-42 / Reset 后续）完成。**
> - 顶点声明、顶点/像素着色器采用独立私有 binding_refs；实时 Set 不增加公开 COM 计数，同对象重绑先保留新槽并发布状态，再释放旧槽。公开 0→1/1→0 只转换一个设备 pin；共享 shader QueryInterface 也通过公开 AddRef 恢复 pin。存储销毁先摘链、释放字节码/对象，再最后归还公开设备引用。FVF、统一清理与 Reset 均使用私有释放；复核补齐统一清理的声明分支，避免保留公开 Release。
> - 新实际 C **179,968 检查、1,024 最终拥有者组合、24,576 次公开归零 QI 恢复**，核对公开/私有计数、Getter、元数据、设备 pin、FVF、清理/重绑和最终存储清理；**30/30** 严格编译后运行时变异、旧实际 Set 与旧实际 QI 配新 lifetime helpers 的两组计数负对照及 ASAN/UBSAN 通过。保留二维/cube/volume/VB-IB/独立目标全部检查。录制测试补充后端私有构造持有 stub，录制公开计数仍单独观察。
> - XP 创建 **2 声明、2 VS、2 PS**，执行 **384 次 QI 恢复、384 次 Getter、129 轮完整声明与字节码比对**，逐项检查设备 pin。公开为零时执行四次可编程 UP 绘制：FVF 退休旧声明，解绑替换旧 VS/PS；第一次 Reset 在外部公开对象存活时成功，保持元数据并可重绑，第二次仅私有绑定 Reset 成功并退休剩余对象。**212 秒、7 批次、一个 owner/release、5 读回**，仅写 RAM overlay；XP 模拟回复仍只证明传输。
> - 冻结流独立核对两份准确声明、四份 VS/PS 字节码与缓存 hash、14 次准确绑定、FVF 元素、4 绘制/1 清屏、两次 Reset 跨设备句柄重绑及六个对象的准确销毁位置；**63 项语义破坏**均拒绝。hash 参考以整数计算现有 limb-hash ABI 的 `2^32+0x1b3` 乘子，不把旧代码注释所写的 FNV 乘子当作新规范；生产 hash/翻译器未改。SwiftShader/Metal 各验证 **5 图像、320 实际像素，零误差/零 GPU 或宿主错误**；真实 owner 释放前设备/资源表为空。
> - 新跑 **完整客体 273 suites**、核心相关 **39 suites**、14 个标准 D3D9 EXE、retail/diagnostic DLL、自定义 SDK、站点集成 2 项和两侧零新增 lint 问题，继承 4I9 完整核心 238 suites/六次 GPU。发布准确 XP D3D9 DLL 与严格 diagnostic；D3D8/DDraw、宿主/协议/翻译器及包 `9335ee9a77fb7cc808d2` 不变。证据：`docs/fixtures/d3d-review/stage4j5-validation.json`，站点镜像 `glbridge/deployments/d3d-webgpu-review-4J5.json`。
> - 录制/已完成状态块暂保留公开资源持有规则；状态块私有化、外部子资源存活时设备根状态保持、D3D8、NULL stream 的 offset/stride 零售边界、任意回调/线程/丢失/完整 Reset/格式/MSAA/全屏/多缓冲/包装转换、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4J6（2026-11-04）：D3D9 状态块八类资源私有持有与 Capture 录制边界（S2-42 / Reset 后续）完成。**
> - 录制、Capture、释放统一使用二维/cube/volume、VB/IB、声明、VS/PS 的私有存储引用，不增加资源公开 COM 计数；录制替换先保留并发布新槽再释放旧存储，状态块清理先清空槽再逐项私有释放，最后先释放块内存再归还设备 pin。Windows/Wine 对照确认录制期间 Capture 与 Apply 都应拒绝，补齐原先仅 Apply 的保护。
> - 新实际 C **160,909 检查、512 pool/最终拥有者组合、4,096 轮 Capture→清理→Apply**，覆盖八类资源、公开归零、同对象/跨纹理种类录制替换、FVF、空 Capture、替换 Capture、录制拒绝、未结束录制取消及最终回收。**35/35** 严格编译后断言变异、旧完整 4J5/旧实际 Capture/旧实际 Capture 入口三组负对照及 ASAN/UBSAN 通过。保留全部纹理/缓冲/声明/着色器/目标生命周期检查；录制 registry 改为分别观察公开与私有计数，其原 11 个变异保留。五组实时绑定变异明确选择录制分支之后的实时路径，避免因同名 helper 重复而漏测。
> - XP 录制 **八类资源、两组共 16 对象**，公开引用归零后完成 **65 次 Capture、528 次 Getter、64 轮完整声明/字节码查询、2 次 Apply**。录制中的 Capture/Apply 各拒绝一次。第一组仅由状态块保留时 DEFAULT Reset 成功，Apply 恢复完整资源身份/offset/stride；替换 Capture 销毁第一组八对象，释放状态块保留仍绑定的第二组，最后显式解绑回收第二组。两次 Reset 成功，四次可编程索引绘制后读回；准确最终捕获 **128 秒、7 批次、一个 owner/release、5 读回**，仅写 RAM overlay。
> - 冻结流独立核对 **16 创建、6 准确缓冲上传、40 次绑定、两份声明/四份 shader 字节码与 hash、4 绘制/1 清屏、2 Reset 和全部 16 销毁**；两组清理顺序分别按 Capture 旧快照释放及显式解绑验证，**103 项语义破坏**均拒绝。SwiftShader/Metal 各验证 **5 图像、320 实际像素，零误差/零 GPU 或宿主错误**，真实 owner 释放前设备/资源表为空。这里三类纹理参与真实绑定/持有但 PS 只输出顶点颜色；采样仍由先前独立阶段验证，XP 模拟回复只证明传输。
> - SDK 初版严格构建补上 unbind 循环大括号；首轮 API 通过后将日志误写的 Getter 536 核正为实际 528，并保存旧捕获后重新启动 XP 取得最终证据。完整客体初跑发现二维/cube 独立入口不再调用 volume 公开 Release 的严格未使用函数错误，补充函数地址引用后新跑 **完整客体 275 suites** 全过，核心相关 **40 suites**、14 标准 D3D9 EXE、retail/diagnostic DLL、自定义 SDK、站点集成 2 项和两侧零新增 lint 问题均通过。继承 4I9 完整核心 238 suites/六次 GPU。发布准确最终 XP D3D9 DLL 与严格 diagnostic；D3D8/DDraw、宿主/协议/翻译器及包 `9335ee9a77fb7cc808d2` 不变。证据：`docs/fixtures/d3d-review/stage4j6-validation.json`，站点镜像 `glbridge/deployments/d3d-webgpu-review-4J6.json`。
> - 外部子资源存活时设备根状态保持、D3D8、NULL stream 的 offset/stride 零售边界、任意回调/线程/丢失/完整 Reset/格式/MSAA/全屏/多缓冲/包装转换、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4J7（2026-11-04）：D3D9 外部子资源保留设备完整状态与录制块设备引用转移（S2-42 后续）完成。**
> - 所有实时/状态块内部引用私有化后，设备清理改为仅在总公开计数真正归零时进行；应用最后一个直接设备引用释放后，外部公开子资源或已完成状态块仍保留设备的全部绑定和标量状态。未结束录制块不持有公开设备 pin，End 发布时才取得一个，完成块释放时最后归还；最终设备释放仍在临时保护下取消未完成录制并清理内部存储。Wine Device.Release716+ 与 Windows 测试 device.c1804–1807 分别支持最终状态生命周期及 Begin 不加/End 加一个设备引用。
> - 新实际 C **111,616 检查、2,048 pool/公开锚点/最终拥有者组合、2,048 次 GetDevice 恢复**，覆盖八类公开资源保留完整实时状态、设备/最后子资源/完成块的最终释放顺序、未结束录制跨直接设备释放仍存活及 End 的准确 pin。**9/9** 严格编译后断言变异、旧实际 Device.Release 和旧 End 配新私有 allocator 两组负对照、两组 ASAN/UBSAN 通过。保留全部先前生命周期检查。额外交换链私有测试新增“公开 chain 存活时显式清理绑定”第六种顺序，达到 **3,124 检查、768 次公开归零恢复**，原 12 个变异全部继续检出；两侧 implicit private callback 各 11 个准确 finalizer 保留。
> - XP 每次仅保留二维/cube/volume/VB/IB/声明/VS/PS 中一个公开资源，再释放原设备引用；关键区间没有 CPU 读回表面等其他子资源 pin。随后经该资源 GetDevice 恢复同一设备，核对八个完整绑定、offset/stride、cull 与自定义 shader 常量并绘制。第九设备取消未完成内部录制，第十设备仅由已完成状态块保留，经其 GetDevice 恢复再 Apply/绘制。**10 设备、80 资源、72 Getter、9 元数据轮、8 子资源恢复/1 状态块恢复**；准确捕获 **125 秒、20 批次、一个 owner/release、9 读回**，仅写 RAM overlay。
> - 冻结流独立验证 **80 创建/销毁、10 设备创建/销毁、20 准确缓冲上传、83 次绑定、9 份自定义常量、9 次可编程索引绘制**，**109 项语义破坏**全部拒绝。无 auto-depth 时 ZENABLE 按共享创建默认 false 初始化，不能要求被 guest 去重过滤的重复 FALSE 写入。SwiftShader/Metal 各核对 **9 图像、576 实际像素，零误差/零 GPU 或宿主错误**，真实 owner 释放前设备/资源表为空。
> - 首轮 XP 的 API/9 图像日志已通过，但 runner 沿用旧成功文本误报；修正 runner 后完整重新捕获，生产 C/SDK 未改。完整客体初跑中仅旧 D3D9 额外 chain/surface 测试仍期待直接设备 Release 清空两个槽，改为保留槽并补齐显式解绑路径后，原 12 个变异再次全部检出。新跑 **完整客体 277 suites**、核心相关 **41 suites**、14 标准 D3D9 EXE、retail/diagnostic DLL、自定义 SDK、站点集成 2 项与两侧零新增 lint 问题通过，继承 4I9 完整核心 238 suites/六次 GPU。发布准确最终 XP D3D9 DLL 与严格 diagnostic；D3D8/DDraw、宿主/协议/翻译器及包 `9335ee9a77fb7cc808d2` 不变。证据：`docs/fixtures/d3d-review/stage4j7-validation.json`，站点镜像 `glbridge/deployments/d3d-webgpu-review-4J7.json`。
> - D3D8、NULL stream 的 offset/stride 零售边界、FVF 转换声明的公开缓存身份、任意回调/线程/丢失/完整 Reset/格式/MSAA/全屏/多缓冲/包装转换、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4J8（2026-11-04）：D3D9 空 stream 零售元数据、状态块精确恢复与成功 UP 清零完成。**
> - 公开 SetStreamSource(NULL) 忽略传入 offset/stride，保留当前实时槽的元数据；录制时同样取实时槽，不能误取先前录制的 VB 参数。共用内部绑定 setter 负责准确发布 buffer/offset/stride 及私有释放，状态块 Apply 直接通过它恢复捕获的空槽元数据，避免再触发公开 NULL 归一化。成功 UP 将 stream 0 的 buffer/offset/stride 全部清零；IndexedUP 另清 IB。依据固定 Wine 公开 Set3848+、内部 setter2032+、UP3362/3431 及 Windows NULL/UP 测试。
> - 新实际 C **40,960 检查、512 pool/slot 组合、4,096 次 NULL 保留、512 轮录制 NULL/Capture/Apply**，覆盖 16 槽、零 stride、巨大但被忽略的输入、重复过滤、实时与录制参数区别、捕获参数精确恢复及最终存储回收。**12/12** 严格编译后断言变异、旧实际公开 Set/旧 Apply 配新公开 NULL 规则/旧 UP 三组负对照及 ASAN/UBSAN 通过，先前资源/根状态/回调检查保留。VB 实时变异改为选择共用内部 setter，录制变异明确选录制分支，原 27/11 项控制继续通过。
> - XP 使用 **5 VB / 1 IB、16 槽、70 次 stream Getter、两次 Apply、一次 Capture**：16 槽解绑均保留 16/20 参数；录制不同 VB 的 64/28 后再录 NULL，准确取实时 32/20；实时改成 0/4 后 Apply 仍恢复 NULL 32/20，Capture 空槽后再次恢复同样参数并回收替换 VB。两次绑定 strip 绘制、PrimitiveUP、IndexedUP 和 Reset 后 Clear 共 **5 读回**；UP 查询为 NULL/0/0，IB 清空，Reset 后全部槽归默认。设备 pin 与最终引用核对通过。捕获 **135 秒、7 批次、一个 owner/release**，仅写 RAM overlay，模拟像素只证明传输。
> - 冻结流核对 **6 次准确上传、38 stream / 1 indices 设置、2 bound / 1 UP / 1 indexedUP、1 清屏、1 Reset、6 缓冲销毁**；逐项验证 16 槽保留参数、录制没有误发实时指令、Capture/Apply 的 NULL 32/20 与资源退休。C 先发布空槽再私有释放，故线上 Destroy 可紧邻并先于 SET_STREAM_SOURCE(NULL)；reader 要求准确的下一命令配对及其他槽已解绑，避免将合理顺序误判为旧句柄绘制。**61 项语义破坏**均拒绝。SwiftShader/Metal 各验证 **5 图像、320 实际像素，零误差/零 GPU 或宿主错误**，真实 owner 释放前设备/资源表为空。
> - SDK 严格构建发现沿用的 refs helper 未使用，补入设备 pin 债务核对后才进行最终 XP；fixture lint 清除复用 reader 的未使用局部变量。新跑 **完整客体 279 suites**、核心相关 **42 suites**、14 标准 D3D9 EXE、retail/diagnostic DLL、自定义 SDK、站点集成 2 项和两侧零新增 lint 问题通过，继承 4I9 完整核心 238 suites/六次 GPU。发布准确最终 XP D3D9 DLL 与严格 diagnostic；D3D8/DDraw、宿主/协议/翻译器及包 `9335ee9a77fb7cc808d2` 不变。证据：`docs/fixtures/d3d-review/stage4j8-validation.json`，站点镜像 `glbridge/deployments/d3d-webgpu-review-4J8.json`。
> - 非 NULL offset 范围/未对齐硬件差异、失败 UP 清理、FVF 转换声明公开缓存身份、D3D8、任意回调/线程/丢失/完整 Reset/格式/MSAA/全屏/多缓冲/包装转换、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4J9（2026-11-04）：D3D9 FVF 转换声明缓存、公开身份与零 FVF 无操作完成。**
> - SetFVF 为精确 FVF 保留真实声明对象，设备 cache 只持有一个私有存储引用，不增加公开资源/设备计数；实时/录制槽另保留私有引用。GetVertexDeclaration 返回真实公开对象，切换 FVF、公开归零后恢复及 Reset 后重用均保持身份/布局。SetFVF(0) 成功且不改变当前或录制声明。直接绑定转换声明保留其 FVF 关联；最终设备清理在普通绑定/录制之后摘除 cache 标志再释放，允许公开视图存活时幂等清理并重新接回 cache。依据 Windows fvf_decl_management843+、零 FVF803–833 及 Wine cache3563+ / SetFVF3630+ / 最终清理734+。
> - 新实际 C **116,928 检查、128 最终拥有者组合、8,192 次缓存切换、16,384 次公开归零恢复**，链接真实共用 FVF decoder，以六份独立元素表核对 XYZ、XYZRHW、NORMAL-only、变换后 diffuse、normal/texture、specular/texture 布局及 END；还核对记录/Capture/Apply、Reset 式清理后身份、公开设备 pin、新条目分配/创建发射失败时原状态保留、幂等 cache 释放与最终拥有者顺序。**14/14** 严格编译后断言变异、旧实际 SetFVF/转换声明重绑/owned-cleanup 三组负对照及 ASAN/UBSAN 通过；先前所有资源/根状态/stream/私有回调检查保留，原断言计数不变，物理清理预期计入新增 cache 条目。
> - XP 进行 **768 次循环切换/公开归零恢复、778 轮完整布局与 END 比对**，只创建 **6 缓存声明 + 1 用户声明**。零 FVF 保留两类对象；直接资源声明、录制/Capture/Apply 后转换声明分别实际绘制；公开 cache 视图允许 Reset 并在恢复同一 FVF 时返回同一指针；第二次 Reset 回收用户声明，最后设备释放回收六个缓存。**111 秒、7 批次、一个 owner/release、5 读回**，仅写 RAM overlay。模拟 XP 像素只证明传输。
> - 冻结流核对 **7 份准确声明、777 次准确内联 FVF、4 次资源声明绑定、4 个 UP 绘制、1 清屏、2 Reset 及 7 个准确声明销毁**；验证 20/32 字节顶点和宽格式 specular/UV 数据，两条布局入口共享同一像素预期。**74 项语义破坏**全部拒绝。SwiftShader/Metal 各验证 **5 图像、320 实际像素，零误差/零 GPU 或宿主错误**，真实 owner 释放前设备/资源表为空。
> - 录制 registry 的 cache 创建使用独立后端构造 stub，明确区分资源创建和被记录的状态写入；真实 cache 存储/pin 在新原生图和 XP 验证。完整客体初跑中未启用声明测试的十个入口因 cache 统计变量未使用而严格编译失败，改为按声明功能声明计数后新跑 **完整客体 281 suites** 全过。另有核心相关 **43 suites**、14 标准 D3D9 EXE、retail/diagnostic DLL、自定义 SDK、站点集成 2 项与两侧零新增 lint 问题通过，继承 4I9 完整核心 238 suites/六次 GPU。发布准确最终 XP D3D9 DLL 与严格 diagnostic；D3D8/DDraw、宿主/协议/翻译器及包 `9335ee9a77fb7cc808d2` 不变。证据：`docs/fixtures/d3d-review/stage4j9-validation.json`，站点镜像 `glbridge/deployments/d3d-webgpu-review-4J9.json`。
> - 用户声明反推 FVF（特别是 Windows POSITION/POSITIONT-only 分支）、非 NULL stream 范围/未对齐硬件差异、失败 UP 清理、D3D8、任意回调/线程/丢失/完整 Reset/格式/MSAA/全屏/多缓冲/包装转换、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4J10（2026-11-04）：D3D9 POSITION-only 用户声明 FVF 关联与转换缓存身份隔离完成。**
> - CreateVertexDeclaration 为精确单元素、stream/offset/index 为零且默认 method 的 POSITION FLOAT3 / POSITIONT FLOAT4 分别关联 XYZ2 / XYZRHW4；实时和录制绑定、Capture/Apply 通过已有声明关联保留 GetFVF。其余反推保持原来的零值。新增独立 `fvf_converted` 来源标志，使 cache 查找不会吸收同 FVF 的用户对象；来源标志与可摘除的 cache 私有拥有标志分开，公开视图清理后仍可恢复原缓存身份。依据固定 Windows 声明转换测试514–545（两项正例在 Wine 标记 todo_wine）及 Wine 独立转换缓存3563+ / GetFVF3657+；测试本身注明原生配置差异，非零 stream/offset/method/多元素保护只表示保守保留旧策略。
> - 新实际 C **60,032 检查、128 最终拥有者组合、8,192 次冲突切换**，通过真实公开创建/解析/关联/绑定方法，覆盖 17 个 Windows 正负声明、END、用户先建/缓存先建两种顺序、精确设备 pin、状态块私有存储和最终清理。**11/11** 严格编译后断言变异、旧实际用户构造函数及旧精确 key 查找（移除来源保护）两组负对照、ASAN/UBSAN 通过；4J9 缓存变异按新条件选择后原 14 项继续通过，先前生命周期检查保留。
> - XP 创建 **7 用户 / 2 缓存声明**，进行 **128 组冲突切换、269 次身份/FVF 查询、269 轮完整布局与 END 比对**。先建 XYZ 用户后建同值 cache，先建 RHW cache 后建同值用户；录制用户公开归零后由状态块保留，Apply/Capture 恢复关联；公开 cache 视图允许 Reset，随后返回原指针。五个 position-only UP 绘制通过 texture-factor 着色，覆盖 XYZ 用户/cache、RHW 用户/cache及 Reset 恢复。**127 秒、7 批次、一个 owner/release、5 读回**，仅写 RAM overlay；模拟像素只证明传输。
> - 冻结流核对 **9 声明、133 内联 FVF、141 资源声明绑定、5 UP、1 Reset、9 准确销毁**，包括空声明、12/16 字节原始顶点、每帧 texture-factor 与用户/缓存独立退休顺序。**69 项语义破坏**全部拒绝。SwiftShader/Metal 各验证 **5 图像、320 实际像素，零误差/零图形错误**，真实 owner 释放前设备/资源表为空。初次 fixture 复制留下多余括号，修正后重新跑相关 44 核心检查。
> - **完整客体 283 suites**、核心相关 **44 suites**、14 标准 D3D9 EXE、retail/diagnostic DLL、自定义 SDK、站点集成 2 项和两侧零新增 lint 问题通过；继承 4I9 完整核心 238 suites/六次 GPU。发布准确最终 XP D3D9 DLL 与严格 diagnostic；D3D8/DDraw、宿主/协议/翻译器及包 `9335ee9a77fb7cc808d2` 不变。证据：`docs/fixtures/d3d-review/stage4j10-validation.json`，站点镜像 `glbridge/deployments/d3d-webgpu-review-4J10.json`。
> - 完整用户声明反推、非 NULL stream 范围/硬件未对齐、失败 UP 清理、D3D8 包装、任意回调/线程/丢失/完整 Reset/格式/MSAA/全屏/多缓冲、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4J11（2026-11-04）：D3D9 缺少顶点声明时 UP 失败的私有存储清理完成。**
> - 对基本参数有效、非零 primitive 且缺少声明的公开 UP，返回 INVALIDCALL，同时断开实时 stream 0；IndexedUP 另断开 IB。失败保留原 offset/stride，与成功 UP 的 NULL/0/0 分开。仅通过私有 hold 释放，槽发布为空后才回收旧对象，其他槽保持；录制中直接作用于实时状态，不将清理录入状态块。内部 indexed draw 新增独立 public_up 参数，与 track_status 分离：N-patch 的 TRUE/FALSE 和 Rect/Tri patch 的 FALSE/FALSE 都保留绑定。依据 Windows device3171–3203 的 NULL VB/保留 stride 与 NULL IB（Wine todo）及3270+不录制成功清理；其他参数/status/发射失败保留旧策略，失败 offset/IndexedUP 元数据沿用保守规则，不冒充新的 HAL 证明。
> - 新实际 C **44,800 检查、256 pool/最终拥有者组合、8,192 次缺声明拒绝**，覆盖实时元数据、索引私有回收、第二槽隔离、录制排除、独立 tracking/public 标志、成功 UP 清零及其他失败不变。状态计算与传输为明确 stub，真正公开方法和私有生命周期执行；**12/12** 严格编译后断言变异、旧实际非索引 UP/旧 indexed 内部函数两组负对照与 ASAN/UBSAN 通过。旧 indexed 对照只适配未使用的新参数，旧行为原样保留。先前资源/声明/缓存/根状态检查继续通过。
> - XP 使用 **3 VB / 2 IB**，验证 **3 次缺声明 + 1 次基本参数拒绝、16 次 stream / 6 次 indices 查询**。私有独占 A/C/IB 在失败时及时退休，旁路槽 B 保留；失败期间的空记录状态块 Capture/Apply 不覆盖后续 B/IB，之后绑定绘制、两次 UP 和一次 IndexedUP 正常，成功清零与失败保留明确区分，最后 Reset/Clear。**128 秒、7 批次、一个 owner/release、5 读回**，仅 RAM overlay；模拟像素只证明传输。
> - 冻结流核对 **5 次准确上传、7 stream / 2 indices、1 bound / 2 UP / 1 IndexedUP、1 Reset / Clear、5 buffer + 1 缓存声明销毁**，拒绝绘制没有错误发射 packet。仅有资源退休而无状态命令的实时变更由 SDK Getter 证明；wire 验证退休顺序和后续可见行为。**86 项语义破坏**全部拒绝。SwiftShader/Metal 各验证 **5 图像、320 实际像素，零误差/零图形错误**，真实 owner 释放前设备/资源表为空。
> - 初次原生 harness 将新状态字段放在 COM interface 前，破坏已有转换；恢复 interface 首字段并修正严格比较警告后通过。初次 retail 缺输出目录，创建后严格构建通过。首轮 XP 日志 `UPFAIL FRAME` 意外包含工具失败哨兵 `FAIL `，保存失败记录、改成 `UPF` 并重新完整捕获。**完整客体 285 suites**、核心相关 **45 suites**、14 标准 D3D9 EXE、retail/diagnostic DLL、自定义 SDK、站点集成 2 项与两侧零新增 lint 通过，继承 4I9 完整核心238/六次 GPU。发布准确最终 XP DLL 与严格 diagnostic；D3D8/DDraw、宿主/协议/翻译器及包 `9335ee9a77fb7cc808d2` 不变。证据：`docs/fixtures/d3d-review/stage4j11-validation.json`，站点镜像 `glbridge/deployments/d3d-webgpu-review-4J11.json`。
> - 零 primitive UP、其他零售 stream/UP 分支、完整用户声明反推、D3D8 包装、任意线程/回调/丢失/完整 Reset/格式/MSAA/全屏/多缓冲、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4J12（2026-11-04）：D3D9 零 primitive UP 的成功空操作与校验顺序完成。**
> - 两个公开 UP 入口在 stride 非零且 primitive_count 为零时立即成功返回，先于数据/格式检查，也先于成功或缺声明路径的解绑；stride 为零仍按原路径返回 INVALIDCALL。内部 patch helper 保持原有语义。依据固定 Wine public UP3327–3337 /3391–3401 明确的 stride→count→declaration 顺序；这是该参考实现的正例，并非额外完成原生 Microsoft HAL 测试。
> - 新实际 C **15,808 检查、64 pool/format/record/最终拥有者组合、4,096 次成功空操作和4,096 次零 stride 拒绝**，覆盖 NULL/不可读指针、被忽略的巨大范围和无效 primitive 参数、无声明/有效缓存声明、录制、实时 VB/IB/声明身份及元数据、设备 pin、ClipStatus、无状态计算/传输/存储副作用与最终清理。**10/10** 严格编译后断言变异、旧实际两个公开 UP 入口负对照、ASAN/UBSAN 通过；先前缺声明/资源/根状态/缓存图继续通过。
> - XP 在四个检查点追加 **512 次成功空操作、512 次零 stride 拒绝**，分别位于缺声明、录制、正常缓存声明和失败后空 stream 状态；**528 次 stream / 262 次 indices 查询**确认相同对象/参数，FVF 保持，空状态块 Capture/Apply 不记录隐含清理。保留 3 缺声明 / 1 基本参数拒绝与正常五幅场景。**178 秒、7 批次、一个 owner/release、5 读回**，仅 RAM overlay；模拟像素只证明传输。
> - 冻结流仍只有 **5 buffer 上传、7 stream / 2 indices、1 bound / 2 UP / 1 IndexedUP、1 Reset/Clear、5 buffer + 1 缓存声明销毁**；空操作没有额外上传/绘制包，逐字核对状态日志及原始顶点/索引。**86 项语义破坏**全部拒绝。SwiftShader/Metal 各验证 **5 图像、320 实际像素，零误差/零图形错误**，真实 owner 释放前设备/资源表为空。
> - **完整客体 287 suites**、核心相关 **46 suites**、14 标准 D3D9 EXE、retail/diagnostic DLL、自定义 SDK、站点集成 2 项与两侧零新增 lint 通过，继承 4I9 完整核心238/六次 GPU。发布准确最终 XP DLL 与严格 diagnostic；D3D8/DDraw、宿主/协议/翻译器及包 `9335ee9a77fb7cc808d2` 不变。证据：`docs/fixtures/d3d-review/stage4j12-validation.json`，站点镜像 `glbridge/deployments/d3d-webgpu-review-4J12.json`。
> - 后续转入可链接的 D3D9 客体核心与 D3D8 包装迁移；完整零售输入矩阵、完整用户声明反推、硬件 stream 未对齐、任意线程/回调/丢失/完整 Reset/格式/MSAA/全屏/多缓冲、原生 HAL、游戏/FPS及阶段 4/5/6 仍未完成。

> **阶段 4K1（2026-11-04）：可静态链接的 D3D9 客体核心与真实模块共存验收完成。**
> - build.sh 新增 `--static` / `--static-diagnostic`，将同一 D3D9 实现与20个共用 runtime object 打成 **21-member archive**。私有 factory/module 入口使用独立 stdcall 名称，静态模式不包含普通 D3D9 兼容/loader 导出；前端继续拥有自己的 DllMain 和导出表。边界头只前向声明 D3D9 接口，D3D8 SDK 可直接包含；未来适配方法在独立 D3D9 编译单元实现。私有诊断使用 `d3d9_core_trace_%lu.log`，避免覆盖普通 D3D9 日志。普通 DLL 的 API 实现及导出保持。
> - 新构建检查同时验证 retail/diagnostic archive 的21个唯一成员、带参数字节数的私有符号、无普通 loader/兼容符号、只导出一个 factory 的严格消费 DLL、仅 GDI32/KERNEL32/USER32 导入以及 D3D8 头文件共存；旧实际 D3D9 源文件构建 archive 后，因缺少私有 ABI 被 artifact 断言拒绝（构建级负对照，不算来宾运行变异）。先前完整生命周期图与 ASAN/UBSAN 继续通过。
> - XP 通过真实 loader 加载最小私有消费 DLL 与普通 D3D9.DLL。私有 DLL **加载/卸载各两次**，普通设备跨两次私有卸载持续绘制；**3 factory / 3 device、6 次 factory/parent 身份检查、准确最终零引用**。**115 秒、9 批次、一个 owner/release、5 读回**，仅 RAM overlay。冻结流要求三个 HELLO 使用同一 session，六个 device/cache-declaration 句柄全局唯一，三个设备/声明按0→2→1显式销毁，最后仅一个 SessionEnd；没有提前关闭仍在使用的 owner。
> - **58 项语义破坏**全部拒绝。SwiftShader/Metal 各验证 **5 图像、320 实际像素，零误差/零图形错误**；额外在执行 SessionEnd 之前断言 device/resource 表已空，随后再处理真实 driver owner release，避免兜底清理掩盖遗漏。XP 模拟像素只证明传输，两个 GPU 使用独立颜色预期。
> - 初次静态模式沿用纯 runtime 的 freestanding/no-builtin 参数，导致 Win32 SDK 内存宏生成 CRT 外部符号；改为与已验证客体 DLL 一致的 frontend 编译参数，保留 CRT-free 链接/import 检查。构建检查适配新版 objdump 的 ordinal/+base/hint 导出表格式。**完整客体 288 suites**、核心相关 **47 suites**、14 标准 D3D9 EXE、retail/diagnostic DLL、两个静态 archive/严格消费 DLL、自定义 SDK、站点集成 2 项与两侧零新增 lint 通过，继承 4I9 完整核心238/六次 GPU。发布准确最终 XP retail DLL 与严格 diagnostic；D3D8/DDraw、宿主/协议/翻译器及包 `9335ee9a77fb7cc808d2` 不变。证据：`docs/fixtures/d3d-review/stage4k1-validation.json`，站点镜像 `glbridge/deployments/d3d-webgpu-review-4K1.json`。
> - 这是 D3D8 包装迁移的编译/加载基础。D3D8 factory/device/resource 真正委托、caps/PP/state/CopyRects/句柄和身份映射、完整零售输入/Reset/loss/线程/格式/MSAA/全屏/多缓冲、HAL/游戏/FPS及阶段4/5/6仍未完成。

> **阶段 4K2（2026-11-04）：D3D8 工厂真实包装 D3D9 核心与单一模块进程拥有权完成。**
> - D8Direct3D 为每个公开工厂保留一个真实私有 D3D9 工厂引用，最终公开 wrapper Release 先释放 backend 再回收 wrapper；D3D8 QueryInterface/SDK120与220/设备 GetDirect3D 仍保持原来的公开身份与计数。GetAdapterCount/GetAdapterMonitor 通过独立 SDK ABI 委托真实后台。D3D9 构造抽成共用 helper，正常 Direct3DCreate9 仍发布自己的 HELLO，供 D3D8 使用的 create8 不发布 D3D9 HELLO，避免改变兼容配置。
> - D3D8 链接同一核心 archive，DllMain 委托核心 attach/detach 并借用 canonical process，**一个 DLL 仍只有一个进程 attachment**，不另附着 runtime；移除 D3D8 重复的 transport close/shutdown 路径，最终 flush/SessionEnd/owner release 由核心处理。D3D8 自有诊断保留，后台诊断使用私有文件名。原生进程模型执行真实后台 DllMain/borrow getter，保留三前端引用为3、创建者先卸载、失败 attach，并增加 D3D8 在终止进程锁已占用时的保留路径。
> - 新实际 C **69,764 检查、512 SDK/最终拥有者组合、16,384 轮查询/身份验证**，真实 D3D8 wrapper/真实 D3D9 constructor与Release/私有桥接运行；适配器 provider 使用可观测 stub 来确认委托，Windows 进程映射由原模型提供。验证 backend恰好一个引用、多个公开 wrapper AddRef 不加 backend引用、最后父拥有者、后台无HELLO及 wrapper/backend分配与transport失败的原子回收。**12/12** 严格编译后断言变异、旧实际 D8构造/Release/count/DllMain **4组负对照**和两组 ASAN/UBSAN 通过。
> - XP 用两个 SDK 编译单元避免混用 D3D8/9 类型：**128 轮工厂、264 次 root/parent 身份检查**；SDK120/220 各创建设备，应用提前释放工厂后仍可经设备取得同一 wrapper并查询后台。两个 D3D8 DLL/设备生命周期之间，普通 D3D9 设备持续绘制；**128秒、11批次、一个owner/release、5读回**，仅RAM overlay。冻结流精确要求 **HELLO配置0/3/0**、三个实际设备、只有普通D3D9的一个缓存声明、五个UP、D8两次NULL VS绑定、0→2→1设备销毁和最后单个SessionEnd；后台工厂没有额外HELLO或设备。
> - **60项语义破坏**全部拒绝。SwiftShader/Metal 各验证 **5图像、320实际像素，零误差/零图形错误**，SessionEnd兜底清理之前及真实driver owner release之前表都为空。首轮SDK沿用D3D9 IMMEDIATE填写D3D8窗口模式的全屏interval字段，设备拒绝；归档首轮，采用既有D3D8测试的DEFAULT后重新完整XP。SDK模拟像素只证明传输。
> - **完整客体290 suites**、核心相关**48 suites**、18 D3D8 +14 D3D9标准EXE、四个retail/diagnostic DLL及私有核心构建、自定义SDK、站点集成2项、两侧零新增lint通过，继承4I9完整核心238/六次GPU。发布准确最终XP D3D8/D3D9 DLL与严格diagnostic；DDraw、宿主/协议/翻译器及包`9335ee9a77fb7cc808d2`不变。证据：`docs/fixtures/d3d-review/stage4k2-validation.json`，站点镜像`glbridge/deployments/d3d-webgpu-review-4K2.json`。
> - D3D8 device/resource 目前仍使用旧实现；其真正委托、caps/PP/format/state/CopyRects/DWORD句柄/容器缓存转换、完整零售输入/Reset/loss/线程/格式/MSAA/全屏/多缓冲、HAL/游戏/FPS及阶段4/5/6仍未完成。

> **阶段 4K3（2026-11-04）：D3D8 能力查询使用同一核心能力表与完整53字段回归完成。**
> - D3D9 能力构造抽成共享 profile helper，普通 D3D9 仍走原 shader/permissive 配置；私有 D3D8 查询取不带 D3D9 专用配置的基础表。两个 SDK 分别静态断言 **53 DWORD /212字节**前缀布局，私有桥接只复制该前缀，并映射 DEPTHBIAS→旧 ZBIAS。D3D8 保留版本掩码、flat/alpha-palette、Shader1.1/1.4与96常量/8.0范围、固定数组上限和打包 FVF 坐标数量。纹理尺寸/过滤等共用值来自核心，删除原来重复的能力常量表。D3D8 体纹理寻址保留与已过滤2D寻址相同的关系；D3D9基础VolumeTextureAddressCaps的旧零值在本阶段保持。
> - 新实际 C **62,403检查、1,344 profile/provider组合、10,176个旧D3D8字段字**，用各自SDK预处理真实当前/旧C函数再原生执行。D3D9全结构在0/2/3与permissive开关下和旧实现逐字节相同；D3D8默认53字段完全保留。观测provider注入尺寸/过滤/数组限额和FVF数量，区分真实委托与冻结旧常量；直接私有前缀和公开 root/device 均有边界/一致性检查。**16/16** 严格编译后断言变异、旧实际 D8 fill_caps 不再委托的负对照及ASAN/UBSAN通过，保留工厂生命周期检查。测试里的历史C函数固定于站点`b3f9da5`。
> - XP 从该已验收commit直接加载旧D3D8 DLL作为`BASE8.DLL`，进行 **130次root/device能力查询，每次53字段**字节比对，覆盖sm3/ffp/sm2/permissive四配置；旧53 DWORD同时打印并与旧C原生参考核对。保留128工厂轮次、264身份检查、SDK120/220设备/模块与D3D9跨卸载继续绘制。**112秒、11批次、一个owner/release、5读回**，仅RAM overlay。基线工厂维持同一owner，冻结流要求 **0/0/3/0四HELLO、三个实际设备、一个声明、五UP及最后一个SessionEnd**。
> - **114项语义破坏**全部拒绝，含53个基线能力字逐一破坏与新增查询计数。SwiftShader/Metal 各验证 **5图像、320实际像素，零误差/零图形错误**，SessionEnd兜底清理前及真实driver释放前表为空；XP模拟像素只证明传输。初次原生对照发现D3D9基础体寻址字段为0，D3D8转换按原来关系从过滤后的2D字段派生；补入生产中的pacing/旧flat宏定义后原生SDK预处理完整。SDK字节循环补明确括号后严格构建通过；freeze helper改为引用实际共用的D3D9探针编译单元，捕获C/SDK未因此变化。
> - **完整客体292 suites**、核心相关**49 suites**、18 D3D8 +14 D3D9标准EXE、四个retail/diagnostic DLL及私有核心构建、自定义SDK、站点集成2项、两侧零新增lint通过，继承4I9完整核心238/六次GPU。发布准确最终XP D3D8/D3D9 DLL与严格diagnostic；DDraw、宿主/协议/翻译器及包`9335ee9a77fb7cc808d2`不变。证据：`docs/fixtures/d3d-review/stage4k3-validation.json`，站点镜像`glbridge/deployments/d3d-webgpu-review-4K3.json`。
> - 其余adapter/format/PP检查、真正device/resource/state/copy/句柄包装、D3D9体寻址能力独立验收、完整零售/Reset/loss/线程/格式/MSAA/全屏/多缓冲、HAL/游戏/FPS与阶段4/5/6仍未完成。

> **阶段 4K4（2026-11-04）：D3D8 适配器标识、当前模式和软件设备注册委托完成。**
> - 核心工厂保存 API8/9 compatibility profile：真实私有8构造选择8，普通9选择9。D3D8 的驱动名称、设备/GUID和旧 NO_WHQL 标志规则移入核心；普通 D3D9 四种构建身份保持旧完整字节。D3D8 三个入口使用已有私有工厂调用核心，设备 GetDisplayMode 也经过该委托。分别在两个 SDK 编译检查 **1068/1100 字节、DriverVersion偏移1024/1056、模式16字节**；私有桥分两段复制，跳过D3D9额外32字节 DeviceName，错误时保留输出。
> - 新实际 C **48,148 检查、四种身份配置、1,024轮**旧新标识/模式/注册比对，历史实际函数固定于站点`a91fa5f`并用各自SDK预处理。观察真实provider调用，直接核对全结构和复制前后保护区；**17/17**严格编译后运行时断言变异、三个旧实际8入口不委托的负对照、ASAN/UBSAN通过。保留工厂检查扩为 **69,766**，同时验证真实8/9构造选择profile；保留12工厂变异和能力检查。
> - XP 直接加载该旧commit已验收8/9 DLL作为 BASE8/BASE9，原始hash与4K3发布件一致。**128次D8标识、130次adapter/device模式、256次软件注册**与旧DLL比对；普通9四种flags的完整1100字节标识、一次模式和两次注册也保持。保留130次53字段caps、128工厂轮次、264身份检查、SDK120/220和普通9跨两次8卸载继续绘制。**113秒、11批次、一个owner/release、5读回**，仅RAM overlay；**0/0/3/3/0五HELLO、三个设备、一个声明、五UP、最后一个SessionEnd**。
> - **120项语义破坏**均拒绝。SwiftShader/Metal 各验证 **5图像、320真实像素、零误差/图形错误**，SessionEnd兜底和driver释放前表为空。XP模拟像素只证明传输。旧显示模式原生测试初轮因仍抽取已移动的8实现而编译失败，现改为运行真实8包装→私有桥→实际9方法→Win32模式provider；原149/206检查、22显示模式和14默认格式变异及该路径ASAN/UBSAN全部保留。初轮完整客体结果归档；291项未受影响通过项保留，三个受影响套件修复后重跑通过，生产/SDK/捕获未改动。
> - **完整客体294 suites最终通过**、核心相关**50 suites**、18 D3D8 +14 D3D9标准EXE、四个retail/diagnostic DLL、私有核心构建、自定义SDK、站点集成2项及两侧零新增lint，继承4I9完整核心238/六次GPU。发布准确XP DLL与严格diagnostic。证据：`docs/fixtures/d3d-review/stage4k4-validation.json`，站点镜像`glbridge/deployments/d3d-webgpu-review-4K4.json`。
> - 后续继续 adapter枚举/format/PP以及真正device/resource/state/copy/句柄包装。D3D9体寻址能力独立验收、完整零售/Reset/loss/线程/格式/MSAA/全屏/多缓冲、HAL/游戏/FPS及阶段4/5/6仍未完成；宿主/协议/翻译器/包`9335ee9a77fb7cc808d2`及DDraw保持。

> **阶段 4K5（2026-11-04）：D3D8 适配器模式数量与枚举委托完成。**
> - 原D3D8固定列表移入核心 API8 profile；公开8入口只调用私有工厂的9 vtable。私有 UNKNOWN selector 仅在8 profile表示该扁平列表，普通9继续按格式过滤真实驱动模式。一个helper同时给出数量/索引，保留 **640×480、800×600、1024×768，每个分辨率按X1R5G5B5/R5G6B5/X8R8G8B8排列、60Hz的9项**，错误不改输出。私有桥只在成功时复制16字节；本阶段保留8旧固定列表策略，未宣称8已改为动态驱动枚举。
> - 新实际C **41,088检查、256驱动/profile轮次、2,304个旧D8条目及8,576个旧D9条目**，用各自SDK预处理当前/站点`10ce33d`历史实际函数。空/单项/混合/127项Win32列表覆盖16/24/32位过滤、零尺寸、0/1刷新率、重复项与列表终点；观察provider验证真实委托，保护16字节输出及失败路径。**17/17**严格编译后运行时断言变异、两个旧实际8函数负对照和ASAN/UBSAN通过；保留69,766工厂、48,148适配器及此前能力/显示模式检查。
> - XP 旧8/9 DLL直接来自4K4已验收commit，hash与发布件相同。**128份列表、384次数量查询、1,152个完整模式条目、640次无效调用**与旧8逐字节比对；保留4K4标识/模式/软件注册、130次53字段caps、128工厂轮次/264身份、SDK120/220与9跨两次8卸载继续绘制。最终 **128秒、11批次、一个owner/release、5读回**，仅RAM overlay；流要求五HELLO **0/0/3/3/0**、三个设备、一个声明、五UP和最后一个SessionEnd。
> - **127项语义破坏**拒绝；SwiftShader/Metal各 **5图像、320真实像素、零误差/图形错误**，SessionEnd兜底及driver释放前表为空。首轮112秒XP API已通过，但复用9探针残留旧baseline标签，完整归档后创建本阶段标签正确的编译单元并重跑最终XP。原生抽取补入实际SDK D3DFORMAT enum，并限制从声明行起抽取，避免把缩进条件里的同名调用当定义；均未改生产行为。XP模拟像素仅证明传输。
> - **完整客体296 suites、核心相关51 suites**、18 D8+14 D9标准EXE、四个retail/diagnostic DLL与私有核心构建、自定义SDK、站点集成2项、两侧零新增lint通过；继承4I9完整核心238/六次GPU。发布准确最终XP DLL及严格diagnostic，证据`docs/fixtures/d3d-review/stage4k5-validation.json`，站点镜像`glbridge/deployments/d3d-webgpu-review-4K5.json`。
> - 后续继续format/type/MSAA/depth检查、PP和真实device/resource/state/copy/句柄包装。D3D9体寻址能力独立验收、完整零售/Reset/loss/线程/格式/MSAA/全屏/多缓冲、HAL/游戏/FPS及阶段4/5/6仍未完成；宿主/协议/翻译器/包`9335ee9a77fb7cc808d2`及DDraw不变。

> **阶段 4K6（2026-11-04）：D3D8 设备类型、MSAA与深度匹配查询委托完成。**
> - 三个公开8入口通过私有工厂调用真实9 vtable。核心API8 profile保留旧X1R5G5B5显示格式、六种backbuffer/depth格式限制，白名单与共用实现谓词相交；MSAA8查询按旧规则忽略format，取共用A8R8G8B8谓词判断样本数量。普通9保持原来的格式/quality行为。8设备/资源创建目前仍用局部旧谓词，待对象真正包装时移除；未把该部分写成已完成。
> - 新实际C **213,843检查：49,005个类型、29,700个MSAA、13,365个depth矩阵组合**，各自SDK预处理当前与站点`ccf680b`历史方法/谓词，覆盖33种格式含9专用/FOURCC/未知值、无效adapter/type、windowed 0/1/-1、20个sample值。所有参数都观察转发，包括原来忽略的字段；9 quality有/无输出均与旧实现相同。注入共用谓词能力撤销，8查询随之变化；**17/17**严格编译后运行时断言变异、三个旧实际8函数负对照、ASAN/UBSAN通过。保留69,766工厂、48,148适配器、41,088枚举及此前能力/显示检查。
> - XP旧8/9来自4K5验收commit，hash与其发布件相同。对照 **1,536次类型、2,560次MSAA、1,280次depth**的8返回值，以及普通9 **12次类型、160次MSAA含quality、10次depth**。保留模式/标识/软件注册、130次53字段caps、128工厂/264身份、SDK120/220与9跨两次8卸载绘制。**110秒、11批次、一个owner/release、5读回**，仅RAM overlay；五HELLO **0/0/3/3/0**、三个设备、一个声明、五UP和最后SessionEnd。
> - **135项语义破坏**拒绝；SwiftShader/Metal各 **5图像、320真实像素、零误差/图形错误**，SessionEnd兜底及driver释放前表为空。初次原生SDK enum需要BYTE别名，旧实际负对照需要先声明历史8辅助函数，均修复在测试框架内；生产行为未因此改变。XP模拟读回只证明传输。
> - **完整客体298 suites、核心相关52 suites**、18 D8+14 D9标准EXE、四个retail/diagnostic DLL和私有核心构建、自定义SDK、站点集成2项、两侧零新增lint通过；继承4I9完整核心238/六次GPU。发布准确最终XP DLL和严格diagnostic。证据`docs/fixtures/d3d-review/stage4k6-validation.json`，站点镜像`glbridge/deployments/d3d-webgpu-review-4K6.json`。
> - 后续继续CheckDeviceFormat、PP和实际device/resource/state/copy/句柄包装。D3D9体寻址能力独立验收、完整零售/Reset/loss/线程/格式/MSAA/全屏/多缓冲、HAL/游戏/FPS及阶段4/5/6仍未完成；宿主/协议/翻译器/包`9335ee9a77fb7cc808d2`及DDraw不变。

> **阶段 4K7（2026-11-04）：D3D8 CheckDeviceFormat委托与API8共用布局查询完成。**
> - 公开8查询通过私有工厂调用真实9 vtable；API8 profile走迁入核心的旧resource/usage规则。纹理/普通表面查询使用共用格式表的 **API8布局过滤**，表面限制1×1 texel块、体纹理拒绝DXT、RT/Depth保留旧usage掩码与版本格式限制。普通9继续原来的query/autogen/host-feature路径，旧8创建谓词待device/resource包装时移除。
> - 新实际C **1,653,373检查、826,686矩阵组合、63格式、27 usage、六种shader/host配置**。实际当前/站点`8509914`历史查询、旧8辅助函数、未改动的实际9创建谓词和共用生成布局/查询表经各自SDK预处理执行；核对全参数、普通9返回及host-feature查询次数，注入共用布局撤销。**17/17**严格编译后运行时断言变异、旧实际8查询不委托负对照和ASAN/UBSAN通过。普通9 `-PCF`诊断保留一条INFO/零拒绝警告，其他拒绝仍可见；其测试使用profile9真实工厂替换原来的NULL iface，并断言不会误入8路径。
> - XP直接加载4K6已验收8/9，hash与发布件一致。**11,520次API8、3,600次普通9格式查询，40格式×9资源类型×10 usage**与旧DLL对照，保留此前类型/MSAA/depth/枚举/caps/工厂/身份矩阵、SDK120/220和9跨两次8卸载绘制。**139秒、11批次、一个owner/release、5读回**，仅RAM overlay。明确提供 **simulatedHostFeatures=0**响应避免能力发现重试；不代表真实宿主可选能力验收，原生矩阵另覆盖0/full mask。五HELLO **0/0/3/3/0**、三个设备、一个声明、五UP、最终SessionEnd。
> - **143项流/日志/能力字段破坏**拒绝；SwiftShader/Metal各 **5图像、320真实像素、零误差/图形错误**，SessionEnd兜底及driver释放前表为空。负格式查询产生的正常REFUSED报告与GPU/宿主执行错误区分。首次严格8构建发现旧image-surface查询辅助函数已无调用，移除并重建；首轮错误日志归档。变异断开helper使用时用仅取地址引用维持严格编译，仍要求运行时断言，不用编译失败计数。
> - **完整客体300 suites、核心相关53 suites**、18 D8+14 D9标准EXE、四个retail/diagnostic DLL和私有核心构建、自定义SDK、站点集成2项、两侧零新增lint通过，继承4I9完整核心238/六次GPU。发布准确最终XP DLL及严格diagnostic。证据`docs/fixtures/d3d-review/stage4k7-validation.json`，站点镜像`glbridge/deployments/d3d-webgpu-review-4K7.json`。
> - 后续继续PP及真正device/resource/state/copy/句柄包装；D3D9体寻址能力独立验收、完整零售/Reset/loss/线程/格式/MSAA/全屏/多缓冲、HAL/游戏/FPS及阶段4/5/6仍未完成。宿主/协议/翻译器/包`9335ee9a77fb7cc808d2`及DDraw不变。

> **阶段 4K8（2026-11-04）：D3D8 CreateDevice有效参数经过PP8→PP9→PP8核心桥接。**
> - 实际8构造的有效参数存储改调私有核心。两个SDK静态检查 **52/56字节、quality20、swap20/24、HWND24/28、interval48/52**。输入完整暂存，补quality0，在SDK9布局调用未改动的共用effective helper，再跳过quality槽回写52字节。保留8的swap/interval/flags；这是8兼容路径布局转换，未把普通9 CreateDevice校验用于8。8原有参数校验与成功后caller回写规则不变。
> - 新实际SDK预处理 **98,304检查、32,768 metadata/provider/alias组合**，当前/站点`203054a`历史helper分别经SDK8/9执行，比对13字、两侧保护区、只读输入及原地别名；观测9输入quality0和provider输出count/flags注入。**15/15**严格编译后运行时断言变异、ASAN/UBSAN通过。保留实际构造几何 **1140/1149检查、162个8/165个9构造**及20共享规则/Reset变异；该逻辑fixture的8 provider观测委托，真实打包ABI另由新测试和XP验证。旧完整8构造严格编译成功，但因仍直调旧helper而失败委托断言。
> - XP SDK120/220实际请求 **宽0、高0、count0、device HWND NULL**，核对完整52字节caller只回写count1，尺寸/格式/window保持；读取真实backbuffer描述均8×8。保留4K7旧DLL查询矩阵、工厂/身份/模块共存，9跨两次8卸载绘制。**135秒、11批次、一个owner/release、5读回**，仅RAM overlay；明确模拟能力0，五HELLO **0/0/3/3/0**、三个设备、一个声明、五UP与最终SessionEnd。
> - **151项流/日志/能力字段破坏**拒绝。SwiftShader/Metal各 **5图像、320真实像素、零误差/图形错误**，SessionEnd兜底及driver释放前表为空；XP模拟回复不算像素或可选能力验收。捕获hash同时固定共用呈现参数头文件，历史函数/构造fixture和该头固定于站点`203054a`。
> - **完整客体302 suites、核心相关54 suites**、18 D8+14 D9标准EXE、四个retail/diagnostic DLL及私有核心构建、自定义SDK、站点集成2项、两侧零新增lint通过，继承4I9完整核心238/六次GPU。发布准确最终XP DLL和严格diagnostic，证据`docs/fixtures/d3d-review/stage4k8-validation.json`，站点镜像`glbridge/deployments/d3d-webgpu-review-4K8.json`。
> - 本阶段只迁移CreateDevice的有效参数存储；Reset/附加交换链仍直调原SDK8 helper，随后接入同一桥。真正device/resource/state/copy/句柄包装、完整零售/Reset/loss/线程/格式/MSAA/全屏/多缓冲、HAL/游戏/FPS及阶段4/5/6仍未完成。宿主/协议/翻译器/包`9335ee9a77fb7cc808d2`及DDraw不变。

> **阶段 4K9（2026-11-04）：D3D8 Reset/附加交换链有效参数统一到PP8/PP9核心桥。**
> - 实际8 Reset和CreateAdditionalSwapChain改调已有核心桥，完成Create/Reset/Additional三个存储入口。未改校验、成功回写、资源/回调顺序；共用52/56字节转换实现和呈现头本阶段未改。保留 **98,304 SDK检查、32,768 metadata/provider/alias组合、15变异**。
> - 实际Reset逻辑fixture保留8/9 **545/559检查、13/14失败路径**及各42录制/34几何检查；附加链 **128/141检查、25/28构造**。观测8成功入口恰好调用一次核心normalizer，历史站点`20ab5b5`两个实际方法严格编译后失败委托断言。**20几何/Reset+10附加链变异**更新8函数名定位后保持运行时断言；真实codec、Reset、附加链及私有生命周期四类ASAN/UBSAN通过。逻辑fixture不替代真实SDK布局测试。
> - XP SDK120/220分别实际Create、Reset、CreateAdditional，均请求宽/高/count0及NULL HWND；**六次完整52字节caller比较**只允许count1回写，所有实际描述8×8。新增 **两个RESET、两组临时RT纹理/交换链**，在主设备绘制前完整释放；保留旧DLL查询矩阵/身份/共存、9跨两次8卸载绘制。**121秒、13批次、一个owner/release、5读回**，仅RAM overlay，明确模拟能力0。
> - 冻结流要求 **10唯一句柄、三个逻辑设备/两次改句柄Reset、两组临时texture/chain、一个声明、五UP/读回、五HELLO0/0/3/3/0、最终SessionEnd**。纹理销毁kind用协议常量3，非buffer的1。**218项流/日志/能力破坏**拒绝，含Reset旧新句柄、资源/窗口/尺寸/释放身份和各路径caller字段。SwiftShader/Metal各 **5图像、320真实像素、零误差/图形错误**，两次显式纹理创建，无主Present，SessionEnd兜底及driver释放前表为空。
> - 初轮完整客体302中8项因同一个私有生命周期fixture缺少新8参数入口而编译失败；加该所有权fixture的逻辑normalizer provider后，保留294项未受影响通过结果，八项全部重跑，更新fixture亦经ASAN/UBSAN。初轮和复检日志归档，生产/SDK/捕获未改。**最终完整客体302 suites、核心相关55 suites**、18 D8+14 D9标准EXE、四个retail/diagnostic DLL、私有核心构建、自定义SDK、站点集成2项及两侧零新增lint通过，继承4I9完整核心238/六次GPU。
> - 发布准确最终XP DLL及严格diagnostic，证据`docs/fixtures/d3d-review/stage4k9-validation.json`，站点镜像`glbridge/deployments/d3d-webgpu-review-4K9.json`。真正device/resource/state/copy/句柄包装、完整零售/Reset/loss/线程/格式/MSAA/全屏/多缓冲、HAL/游戏/FPS及阶段4/5/6仍未完成；宿主/协议/翻译器/包`9335ee9a77fb7cc808d2`及DDraw不变。

> **阶段 4K10（2026-11-04）：真正D3D9核心设备的API8兼容创建入口及初始默认状态。**
> - 新私有`core_create_device8`接受只读52字节PP8，复用52→56转换并插入quality0，实际调用核心9工厂的CreateDevice。profile8构造按原8规则保留COPY_VSYNC4、behavior0、16位backbuffer及MSAA+lockable；初始RS/TSS/material使用API8默认表并发送差异补丁。普通9构造仍按9规则；Reset初始化包装仍固定9，等待下一阶段迁移。D3D8公开设备本阶段仍是原实现。
> - 实际旧8/9构造前缀对照 **234,460检查、134,654组合**，包括格式/深度/interval/MSAA/flags/behavior/失败输入和9桌面查询次数。实际初始状态对照 **229,632检查、768组合**，完整旧8共用字段及旧9逐字节默认值、Reset包装一致。真实SDK私有桥 **6,152检查、2,052组合**，观察全部参数、52/56字节布局、quality0、只读输入和失败输出。新增 **15运行时变异、两个旧实际9负对照**，四类ASAN/UBSAN通过；保留98,304项codec/15变异。
> - SDK8编译测试consumer链接真实静态核心；XP SDK120/220各建两个临时16位/MSAA-lockable设备并释放，再建主设备，验证完整输入不变、有效8×8/count1、POINTSIZE_MIN为0、父/设备COM身份和提前释放工厂。普通9默认1.0且跨两次私有模块卸载继续绘制。**176秒、13批次、七个真实设备/三个声明、五UP/读回、仅一个普通9 HELLO、一个owner和最终SessionEnd/release**；显式模拟能力0，仅RAM overlay。
> - **223项冻结流/日志破坏**拒绝。SwiftShader/Metal各 **五图像、320真实像素、零误差/图形错误**，SessionEnd兜底及driver释放前设备/资源表为空。另用当前DLL重跑原公开8的Create/Reset/Additional与旧DLL查询矩阵，**131秒、13批次、五读回、两个Reset/附加链**，通过保留4K9检查器；此复检不另算新的GPU像素验收。
> - 首轮304客体中300通过，四个变异测试仍定位旧literal9/赋值写法；仅更新定位，四项重跑并补两个新增suite，归档初轮/复检。最终 **完整客体306 suites、核心相关56 suites**、18 D8+14 D9标准EXE、四个retail/diagnostic DLL/静态核心/测试consumer、自定义SDK、站点集成2项、两侧零新增lint通过。第一次自定义EXE编译发现memcmp的CRT引用，改用显式字节比较后才运行XP。
> - 发布准确已验收XP DLL及严格diagnostic；证据`docs/fixtures/d3d-review/stage4k10-validation.json`，站点镜像`glbridge/deployments/d3d-webgpu-review-4K10.json`。本阶段仅私有核心创建基础，公开8 device/resource/state/copy/句柄包装、API8 Reset/附加链/shader兼容、完整零售/loss/线程/格式/MSAA/全屏/多缓冲、HAL/游戏/FPS及阶段4/5/6仍未完成。宿主/协议/翻译器/包`9335ee9a77fb7cc808d2`及DDraw不变。

> **阶段 4K11（2026-11-04）：真正核心设备的API8 Reset兼容、错误状态与默认值重建。**
> - 核心从设备父工厂取得API profile；Reset保留8的interval/COPY_VSYNC/MSAA-lockable/旧颜色深度格式、UNKNOWN沿用当前格式、资源占用返回DEVICELOST、count-only内部回写，普通9仍保留原校验/桌面格式/INVALIDCALL/尺寸回写。Reset初始化与发送默认补丁均使用该profile。新私有`core_reset8`接受只读52字节PP8；NULL仍进入实际Reset以设置pending状态，错误profile/设备拒绝。
> - 旧实际8/9 Reset前缀 **57,028检查、45,940组合**；完整核心8 Reset **608检查、12失败路径、42录制/34几何/98旧格式检查**，含取消录制顺序、失败原子性、反复恢复、Scene、缓存表面和24个格式/count/MSAA组合。SDK桥 **6,147检查、2,051组合**；默认状态 **230,016检查、768组合**，核对8/9重置包装。新增 **15运行时变异、两个旧实际9负对照**；保留创建15变异及codec98,304项，四类ASAN/UBSAN通过。实际Reset replay函数额外验证profile8补丁路由。
> - XP SDK120/220分别验证NULL/非法windowed interval导致DEVICENOTRESET、持有真实backbuffer表面导致DEVICELOST、释放后恢复；完整52字节输入保持不变，UNKNOWN仍21，有效8×8/count1，POINTSIZE_MIN恢复0/material恢复1110。普通9实际Reset回写尺寸8×8/count1、默认1.0；保留提前释放工厂/COM身份、四临时设备和两次私有卸载。最终 **172秒、13批次、七设备/三个成功Reset/三个声明/13唯一句柄、五UP/读回、一个HELLO/owner/SessionEnd/release**，能力0明确模拟、仅RAM overlay。
> - 初轮XP错用没有8对应getter的隐式9交换链作blocker，改持有backbuffer表面；首次通过136秒流仍有旧held-chain描述，归档后以准确说明重采最终流。新原生ASAN发现测试局部表面指针超出作用域，清除该fixture指针后重跑通过，生产代码未因此修改。初轮/中间捕获和原ASAN日志均保留。
> - **270项流/日志破坏**拒绝；SwiftShader/Metal各 **五图像、320真实像素、零误差/图形错误**，三次真实Reset完整重放，SessionEnd兜底及driver释放前表为空。另以当前DLL复检公开8 Create/Reset/附加链/旧DLL查询，**151秒、13批次、五读回、两个Reset/附加链**，保留4K9检查器通过，不另算新的GPU像素验收。
> - 初轮完整310客体有303通过，七项为新profile helper的严格编译引用、逻辑display字段或旧Reset源码定位；修正后复检七项及四项受影响测试，保留299项未改通过结果，原日志/11项复检归档。最终 **完整客体310 suites、核心相关57 suites**、32标准EXE/四retail-diagnostic DLL/静态核心/测试consumer、自定义SDK、站点集成2项、两侧零新增lint通过，继承4I9完整核心238/六次GPU。
> - 发布准确最终XP DLL及严格diagnostic；证据`docs/fixtures/d3d-review/stage4k11-validation.json`，镜像`glbridge/deployments/d3d-webgpu-review-4K11.json`。公开8仍用原设备；API8附加链/shader兼容、真正device/resource/state/copy/句柄包装、完整零售/loss/线程/格式/MSAA/全屏/多缓冲、HAL/游戏/FPS及阶段4/5/6仍未完成。宿主/协议/翻译器/包`9335ee9a77fb7cc808d2`及DDraw不变。

> **阶段 4K12（2026-11-04）：核心API8附加交换链创建、参数与生命周期兼容。**
> - 新私有`core_additional8`复用52→56字节转换、quality0，52字节caller输入不变。实际核心9构造按API8保留interval/COPY_VSYNC/MSAA-lockable参数、六种旧颜色格式、UNKNOWN沿用当前格式、空窗口/空client尺寸回退、全屏父设备允许创建及count-only内部回写；普通9仍按原窗口/桌面/quality/尺寸回写规则。返回真实私有9交换链，表面LockRect及公开8包装仍是后续独立适配。
> - 旧实际8/9构造前缀 **57,030检查、45,942组合**；完整核心8方法 **326检查、74构造**，含六旧格式、count0/1/3、独立零尺寸、空client/NULL窗口、全屏父、MSAA+flag1、分配/发送失败及完整清理。真实SDK桥 **6,152检查、2,052组合**；新增 **16运行时变异**。同一个历史9实际构造在参数前缀和完整caller回写两个上下文均严格编译后失败API8断言；四类ASAN/UBSAN通过，保留普通9 **141检查、28构造**和旧8 **128检查、25构造**。
> - XP SDK120/220共建 **六组真实RT纹理/交换链**：两个在focus/window均NULL的临时设备上沿用16位格式24，四个在主设备Reset后沿用21，含两组MSAA4+flag1。核对完整caller不变、有效8×8/count1/quality0、真实描述和 **六次容器COM身份**，均在绘制/设备销毁前释放。保留七设备/三Reset/三声明/两次私有模块卸载/五UP读回；最终 **274秒、13批次、25唯一句柄、一个HELLO/owner/SessionEnd/release**，明确模拟能力0、仅RAM overlay。
> - **407项冻结流/日志破坏**拒绝。SwiftShader/Metal各 **五图像、320真实像素、零误差/图形错误**，六次显式纹理创建，所有新链与纹理的创建/尺寸/格式/采样/NULL窗口/退役顺序完整核对，SessionEnd兜底及driver释放前表为空。未声称LockRect或附加链Present验收。
> - 初轮完整314客体有313通过，一项仍定位旧literal9回写；修正定位后10变异严格编译/运行时断言全过，保留313项未改结果，初轮/复检日志归档。最终 **完整客体314 suites、核心相关58 suites**、32标准EXE/四retail-diagnostic DLL/静态核心/测试consumer、自定义SDK、站点集成2项、两侧零新增lint通过，继承4I9完整核心238/六次GPU。
> - 原公开8的当前DLL复检首次在XP欢迎屏停留、测试EXE从未启动，失败图与空日志归档；完整并行回归释放资源后重试通过，**189秒、13批次、五读回、两个Reset/附加链**，保留4K9检查器通过。未为启动环境问题修改生产/SDK代码。
> - 发布准确最终XP DLL及严格diagnostic；证据`docs/fixtures/d3d-review/stage4k12-validation.json`，镜像`glbridge/deployments/d3d-webgpu-review-4K12.json`。公开8仍用原设备，表面锁定/API8 shader兼容、真正device/resource/state/copy/句柄包装、完整零售/loss/线程/格式/MSAA/全屏/多缓冲、HAL/游戏/FPS及阶段4/5/6仍未完成。宿主/协议/翻译器/包`9335ee9a77fb7cc808d2`及DDraw不变。


> **阶段 4K13（2026-11-04）：共用 D3D8 SM1.x 着色器校验，核心设备保留旧版输入。**
> - 核对实际代码后确认：原 D3D9 扫描器已经接受 1.0 和无 dcl 输入，本项不声称修复不存在的版本拒绝。把公开8原有 opcode/寄存器/body 策略移到核心，公开8委托同一实现；核心 API8 创建入口应用旧8版本及8192-token边界，普通9仍走原扫描器。SDK8寄存器枚举是左移编码、SDK9是序号，核心明确归一化后比较。版本、声明与 DWORD 句柄仍归8适配层。
> - 原生执行真实SDK头/历史8校验和历史9构造器：**3,492,911项策略检查**，含786,432 opcode/model和640,000有界body/委托案例；**43,516项构造检查、10,578次构造**，覆盖1.0/无dcl、8192边界、逐字节复制、既有协议hash、类型/父引用、分配与提交失败及5,280组普通9对照。保留既有hash乘数，不改缓存/线协议。16项变异均严格编译后运行时断言拒绝，两个真实旧实现负对照及两组地址检查通过。
> - 协议校验不再用源码正则推测8的opcode表，改为编译执行公共核心策略，再与宿主48个opcode/40格式/16输入寄存器契约比较。其他旧源码防护仍保留，未宣称全部测试完成迁移。
> - XP 合并SDK探针在两个私有核心8设备上创建/逐字节查询 VS1.0/1.1、PS1.0/1.4，无dcl；核对四次shader设备身份、三次绑定身份、公开引用归零后的绑定存活及非法输入拒绝。SDK120实际运行1.0/1.0，SDK220运行1.1/1.4。另在同一XP中比较准确4K12公开8 DLL与当前DLL，每个模块接受2个VS/5个PS、拒绝7例、核对7个函数字节及7个过期句柄，最终引用归零并卸载。
> - **115秒、17批次、九设备/七声明/22shader/53唯一句柄**，保留三Reset/六临时纹理链/五UP读回、两次私有模块生命周期、普通9持续可用，Hello能力序列3/0/0、一个owner/session/最终释放。明确模拟宿主能力0、只用RAM overlay。公开8完整生命周期矩阵继承4K12；本项当前公开8新增创建/查询路径在合并捕获中实测，不冒充完整矩阵重跑。
> - 冻结流 **645项破坏检测**通过；SwiftShader和Metal各验证五帧、320真实像素、零误差/图形错误，两个programmable draw、22次shader翻译；所有资源在SessionEnd兜底前已退役。六附加链仅核对客体构造/元数据/生命周期，宿主无Present场景拒绝链显示，不计作附加链呈现验收。
> - 完整客体317项初轮316通过、一项仍在旧8文件定位诊断文本；修正到实际共享实现后通过，保留未改316项及初轮/复检证据。核心相关59项、32标准EXE/四零售诊断DLL、静态核心/SDK consumer、站点集成2项、两侧零新增lint通过；继承4I9完整核心238/六GPU基线。发布同一次已验收XP中的准确8/9零售DLL及严格diagnostic。
> - 证据 [stage4k13-validation.json](fixtures/d3d-review/stage4k13-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K13.json`。本项完成共享校验前置条件；公开8仍用原设备，完整device/resource/state/copy/句柄包装、表面锁定、shader数值差分/语料、完整零售/loss/线程/格式/MSAA/全屏/多缓冲、HAL/游戏/FPS及阶段4/5/6仍开放。宿主/协议/翻译器/包 `9335ee9a77fb7cc808d2` 及DDraw不变。


> **阶段 4K14（2026-11-04）：D3D8 声明多段局部常量、API隔离与Reset/状态块。**
> - 继续收敛 S2-40：声明扫描器跨过完整 CONSTMEM 字面值，不再把常量中的 `0xffffffff` 误认为声明END；转换保留全部离散常量块、空洞与c95边界。多次定义同一寄存器采用确定的最后块值，原生HAL的重叠优先级不在本项验收范围。
> - 核对固定版本 [Wine声明加载](https://github.com/wine-mirror/wine/blob/415a275e3844c252ad385b46023095e9401ca234/dlls/d3d8/vertexdeclaration.c#L146) 与 [shader创建](https://github.com/wine-mirror/wine/blob/415a275e3844c252ad385b46023095e9401ca234/dlls/d3d8/shader.c#L130)：声明常量属于shader-local，NULL函数不加载局部常量。实现将全部值转为私有wire code里的DEF，普通函数字节、声明查询、协议hash算法与API设备常量银行保持各自语义；移除绑定时向设备常量上传声明值。原审查表“GetVertexShaderConstant应反映声明常量”的推论在此更正：API银行不应被局部常量覆盖。此方案复用现有宿主DEF路径，不改宿主/协议。
> - **1,656,669项原生检查**，12,544个解码案例、489,216次有界扫描、128个公开构造；含多块/空洞/重叠/c95、原始END/NaN位模式、私有DEF逐字节和独立既有hash、原始查询、设备银行不变、重绑定、再次编码、固定声明与记录常量。16项变异严格编译后运行时断言拒绝；真实旧扫描器负对照、两组地址检查及保留9项declaration-only变异通过。NaN仅核对位模式/解析，不宣称数值一致性。
> - 新XP SDK120/220探针同进程加载准确4K13旧DLL与当前DLL。旧版两帧复现早先常量块丢失的蓝色结果；当前各六帧核对c2红、c8绿、空洞API蓝、API覆盖后仍红、公开句柄已删除但状态块保留后绿、Reset后红。核对原始声明/函数、字面END、NULL函数与API常量查询隔离；**109秒、25批次、四设备/两Reset/十声明/八shader/24唯一句柄、14读回、一个owner/session/最终释放**。两个DLL各只发送一次Hello（实际共两个0能力Hello，非每factory一次）；修正探针初始描述中的四Hello计数，不改已捕获字节或SDK结果。仍明确模拟能力0、仅RAM overlay。
> - 初轮两次探针在直接backbuffer LockRect退出：加lockable标志后确认该公开8入口尚未接通。失败输出已归档；改用既有 `CopyRects` 到CPU image surface再锁定的读回路径，未为探针改动生产表面代码。冻结验证发现一次无绘制的临时声明篡改未被原检查器识别，补齐完整42次绑定/资源退役时间线后，**847项语义破坏检测**全过。
> - SwiftShader/Metal各 **14帧、896真实像素、零差异/图形错误**，包含旧DLL蓝色回归和修复后的两SDK全部场景；14次可编程绘制，设备/资源在SessionEnd兜底与driver释放前均为空。公开8/9共存及完整PPLIFE矩阵继承4K13/4K12；本项不冒充新9设备或完整生命周期矩阵重跑。
> - 完整客体 **319 suites零失败**、核心相关 **60 suites**（保留59项通过及补齐检查器后的新fixture复检）、18标准EXE/两零售诊断DLL、定制SDK、站点集成2项、两侧零新增lint通过。验证和发布记录见 [stage4k14-validation.json](fixtures/d3d-review/stage4k14-validation.json)，站点镜像 `glbridge/deployments/d3d-webgpu-review-4K14.json`。只发布同次已验收XP的准确8零售DLL与严格diagnostic，9/DDraw继承已验收文件。完整包装、公开8直接backbuffer锁定、数值差分/语料、零售/loss/线程/完整格式/MSAA/全屏/多缓冲、HAL/游戏/FPS及阶段4/5/6仍开放，包 `9335ee9a77fb7cc808d2` 不变。


> **阶段 4K15（2026-11-04）：S2-41，公共核心接受 ps_1_4 CND。**
> - 按 [Microsoft CND 语义](https://learn.microsoft.com/en-us/windows/win32/direct3dhlsl/cnd---ps) 和固定 [Wine cnd_test](https://github.com/wine-mirror/wine/blob/415a275e3844c252ad385b46023095e9401ca234/dlls/d3d8/tests/visual.c#L1741)，把公共核心CND的最高pixel minor从3改为4，顶点拒绝及其他opcode不变。公开8调用同一校验器；实际核心API8构造也使用它。普通9仍使用原扫描器。宿主既有CND逐通道比较无需修改，coissue特殊语义不在本项验收范围。
> - 在历史SDK8 oracle上明确加入唯一的文档契约差异“pixel CND minor4合法”，其余历史规则不改。**3,492,911项策略检查**、786,432 opcode/model与640,000有界body/委托案例通过；**43,518项构造检查、10,578次构造**，91合法8/5,189拒绝8及5,280普通9历史对照。**17项变异**严格编译后运行时断言全部检出，真实修复前公共opcode函数负对照和两组地址检查通过。
> - XP SDK120/220同时对照准确4K14旧8 DLL与当前DLL。旧版各接受CND1.0–1.3、拒绝1.4；新版各接受五版本，逐字节函数及过期句柄查询通过。旧版1.1标量样例保持白色；新版每SDK六个1.1 alpha标量、六个1.4逐分量案例，包含恰好0.5、相邻float32位值0x3effffff/0x3f000001、混合通道与alpha。**118秒、35批次、四设备/18shader/22唯一句柄、26读回、两个0能力Hello、一个owner/session/最终释放**。明确模拟能力0、仅RAM overlay；XP实际使用公开8对象，私有核心API8 CND构造由原生实际C函数矩阵覆盖。
> - 冻结流核对原始九token线代码/既有hash、四FVF布局、十次pixel绑定、34次常量写入、所有比较输入/逐帧角色/资源退役及SDK拒绝记录，**1,262项语义破坏检测**通过。SwiftShader和Metal各 **26帧、1,664真实像素、零差异/图形错误**；所有资源在SessionEnd兜底和driver释放前已清空。未把定向CND边界样例称为完整数值解释器/差分语料或原生Microsoft HAL结果。
> - **完整客体319 suites、核心相关61 suites零失败**，32标准EXE/四严格零售诊断DLL、定制SDK、站点集成2项及两侧零新增lint通过；继承4I9完整核心238/六GPU基线。验证与发布证据见 [stage4k15-validation.json](fixtures/d3d-review/stage4k15-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K15.json`。只发布同次已验收XP的准确8零售DLL与严格诊断DLL；普通9原扫描路径未变、保留已验收零售/诊断文件，新增9严格构建用于源码检查。宿主/协议/翻译器/包 `9335ee9a77fb7cc808d2` 及DDraw不变。完整包装/锁定、数值差分/语料、coissue、零售/loss/线程/完整格式/MSAA/全屏/多缓冲、HAL/游戏/FPS和阶段4/5/6仍开放。


> **阶段 4K16（2026-11-04）：两API隐式back buffer共用锁定校验与区域写回。**
> - 接续4K14实测失败，按固定 [Wine8 lockable-backbuffer测试](https://github.com/wine-mirror/wine/blob/415a275e3844c252ad385b46023095e9401ca234/dlls/d3d8/tests/device.c#L9346) 与 [Microsoft锁定标志](https://learn.microsoft.com/en-us/windows/win32/direct3d9/d3dpresentflag) 实现显式LOCKABLE_BACKBUFFER：无标志、多重采样、重复锁、非法矩形仍拒绝。公共纯C规划器核对矩形/行距/缓冲范围，8和核心9各自适配设备存储；成功锁定前读取真实GPU内容，只在完成读回后发布指针和锁状态。只读解锁不上传，写锁只上传所锁矩形。
> - 公共上传桥抽取原8的临时纹理→行上传→backbuffer blit→销毁流程，核心9复用；原8 CopyRects路径也使用同一实现。上传/拷贝失败仍尝试退役已创建临时资源并报告失败。9的隐式表面按需分配CPU锁存储，成功Reset时释放旧存储，保留缓存对象身份与更新尺寸。CPU/texture/cube旧分派保持原有路径。此项只接通**隐式**缓冲，附加链和其他目标锁定不在本次验收范围。
> - **87,414项检查、43,008个纯规划案例、48组实际8/9方法场景**，覆盖六种格式、带填充行距、部分写入、当前GPU读回、只读不上传、输出字段、MSAA/标志/重复锁、读回/OOM/提交失败及清理；**22项变异**严格编译后运行时断言全检出，两份真实旧Surface.LockRect负对照通过。保留61组实际8表面复制和29项变异，把其中三项上传变异接到真正共享实现。三组地址检查通过；Reset矩阵另核对五次旧CPU锁存储释放，核心API8为613项/12失败路径、普通9为564项/14失败路径。
> - 同次XP加载准确4K15 BASE8/BASE9、当前8/9及私有CORE8。旧8 SDK120/220和旧9在flag1下复现拒绝；当前公开8 SDK120/220、普通9、SDK9接口的API8兼容核心设备分别验证flag0拒绝、只读GPU刷新、4×4蓝色局部写、整面绿色写、只读不上传、锁定时Reset阻塞与恢复、缩为4×4后蓝色读回。两公开8及私有核心8另创建MSAA4/flag1临时设备并拒绝锁定，普通9的MSAA组合不在本项XP范围。SDK核对描述、重复查询身份、行距、输出字段和最终引用。
> - **139秒、48批次、十设备/八成功Reset/三声明/八临时纹理与blit、29唯一句柄、27读回**，四Hello能力0/3/0/3，一个owner/session/最终释放。明确模拟能力0、只用RAM overlay；为SDK的CPU像素检查注入解析预期图像，**数值绘图证据由两次真实GPU回放独立提供**，不把模拟CPU回复称为真实GPU读回。测试日志`api=18`仅标记“SDK9接口的API8核心设备”，不表示新API版本。
> - 冻结验证核对每次上传的确切蓝/绿字节、临时纹理/目标区域/行距、前后图像、11个UP/11次FVF、27读回（末图4×4）、全部资源退役及SDK失败/重置记录，**1,637项语义破坏检测**通过。SwiftShader/Metal各 **27图像、1,536真实像素、零差异/图形错误**，11绘制/八blit；SessionEnd兜底及driver释放前表为空。
> - 初次定制SDK编译只修复一行误导缩进，未启动XP；最终首次VM捕获通过。**完整客体321 suites、核心相关62 suites零失败**，32标准EXE/四严格零售诊断DLL/21-member静态核心/SDK8 consumer、站点集成2项、两侧零新增lint通过；继承4I9完整核心238/六GPU基线。发布同次XP准确8/9零售DLL和严格diagnostic。见 [stage4k16-validation.json](fixtures/d3d-review/stage4k16-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K16.json`。
> - 宿主/协议/翻译器/包 `9335ee9a77fb7cc808d2` 与DDraw不变；附加链/其他表面锁、完整flags/格式/MSAA/全屏/多缓冲/物理loss/线程、完整包装、数值差分/语料、HAL/游戏/FPS和阶段4/5/6仍开放。GPU格式只验收21，不将六格式的原生内存检查扩展成全部GPU格式验收。

> **阶段 4K17（2026-11-04）：核心独立RT及附加back buffer锁定、写回缓存失效与锁定Reset保护。**
>
> - 核心9的`CreateRenderTarget(Lockable)`和附加链`LOCKABLE_BACKBUFFER`现在保存表面锁定权限，与隐式缓冲共用范围校验和GPU读回；写回桥接增加目标纹理/层/面参数。普通RT纹理子表面保持不可锁定，MSAA仍拒绝锁定。公开8已有独立/附加锁定实现，本项保留并作为旧版与当前版对照，未把它登记成新修复。
> - 成功锁定后同步纹理层的locked状态，防止公开引用归零、仅内部绑定保留时Reset漏判；解锁清除此状态。可写解锁使旧Clear/ColorFill CPU镜像失效，后续GetRenderTargetData重新读GPU；复制拒绝锁定的源/目标表面和层。只读解锁不上传。
> - 原生 **88,470检查/43,008纯计划/96适配场景** 覆盖六格式、填充行距、局部字节、目标权限/身份、重复锁定、输出守卫、失败清理及缓存失效；独立构造器 **11,520检查/5,760组合** 对照旧验证/输出/提供方参数，复制入口43场景。**33项严格编译后运行失败变异、三个实际旧入口对照、三组ASAN**通过。此前4K14的16项和4K16的22项变异用固定旧源码加显式编译错误筛选复核，全部确属运行期检测；当前筛选同步加强。
> - SDK8/9混合XP程序比较准确4K16旧8/9与当前8/9、私有API8核心：旧8的独立/附加路径正常，旧9拒绝；当前核心验证红色只读、蓝色4×4局部写、GPU读回、绿色整面写与读回、锁定复制拒绝、归零锁定目标阻止Reset、身份恢复及解锁后Reset成功。**131秒/54批次、五设备/四成功Reset/十目标/五附加链/八临时纹理、33唯一协议句柄、46读回**，Hello能力0/3/0/3，一个owner/session/最终释放。模拟能力0且磁盘仅RAM overlay；CPU回复明确注入独立解析图像，实际像素另由GPU验证。
> - 冻结读取器核对每次直接上传/临时上传的字节、目标和区域、绑定/清除/读回次序、所有资源在SessionEnd前退役与SDK结果；**2,167项语义破坏检测**通过。SwiftShader/Metal各 **46图像/2,944真实像素、零差异和图形错误**，18纹理/16上传/八blit/两绘制；兜底前和driver释放前资源表为空。回放没有窗口关联，五个附加呈现链被宿主拒绝；真实RT纹理存储及读写已验证，**不据此宣称附加Present验收**。
> - 完整客体322 suites、核心相关63 suites，32标准EXE、四严格DLL、21-member静态核心及SDK8 consumer、站点集成2项和两侧零新增lint；客体首次回归一项旧变异选择器仍指向已改为包装器的上传函数，改为实际通用函数后重跑通过，其余321项沿用同次通过结果。发布本次XP接受的准确8/9零售DLL及严格diagnostic，证据见 [stage4k17-validation.json](fixtures/d3d-review/stage4k17-validation.json)，站点镜像`glbridge/deployments/d3d-webgpu-review-4K17.json`。
> - 宿主/协议/翻译器/包`9335ee9a77fb7cc808d2`及DDraw不变；继承4I9完整核心238/六GPU基线。深度/其他格式、完整标志/MSAA/全屏/多缓冲/物理loss/线程、公开8设备与资源包装、数值差分/语料、原生HAL/游戏/FPS及阶段4/5/6继续开放。

> **阶段 4K18（2026-11-04）：SDK8可调用的私有核心独立渲染目标创建适配器。**
>
> - 增加`d9wg_d3d9_core_render_target8`，以不混用SDK头的前置声明返回真实核心9表面。保留旧公开8的早期MSAA/可锁MSAA失败不改输出、后期失败清空输出、4096尺寸上限和六格式策略；只接受API8核心设备，向实际核心构造器传质量0及空共享句柄。存储、锁定和引用生命周期复用4K17；普通9和公开8的创建方法不改动。本项为后续资源包装提供入口，未开启公开8设备包装。
> - 固定实际旧公开8构造方法作对照，执行 **1,264,902检查/421,635组合**，比较结果、输出、锁定发布、尺寸/格式/MSAA/负BOOL、提供方错误和转发参数；**16项严格编译后运行失败变异及一组ASAN**通过。真实SDK8 consumer、SDK8头兼容调用、21-member零售/诊断静态库及私有stdcall `@28`边界检查通过。
> - 新SDK8 consumer在XP中调用私有入口；混合SDK程序检查13类无效尺寸、格式、采样、可锁MSAA和空输出的失败发布规则，再通过新入口创建独立目标，复用4K17独立定义的46图像契约，继续验证当前8/9/私有核心的区域写回、缓存刷新、归零锁定Reset及清理。旧8对照固定4K17，旧9拒绝对照固定4K16。
> - 首次XP复用时错误选择4K17作旧9拒绝对照，程序在十幅旧8图像后正确报`FAIL old9 refusal`；保留失败现场，改回实际修复前4K16 DLL后完整重跑，未改生产实现或放宽断言。最终捕获为105秒/54批次、五设备、四成功Reset、十目标、五链、八临时纹理、33协议句柄、46读回；一个owner/session/最终释放，模拟能力0，磁盘仅RAM overlay。CPU回复明确为解析图像注入。
> - 冻结读取器复用4K17独立字节/目标/次序/生命周期模型，增加私有SDK守卫日志校验，**2,170项语义破坏检测**通过。SwiftShader/Metal各 **46图像/2,944真实像素、零差异/图形错误**；兜底和owner释放前资源表为空。五个无窗口关联的附加呈现链被回放拒绝，本项验证实际纹理存储，不验收附加Present。
> - 完整客体324 suites、核心相关64 suites、32标准EXE、四严格DLL、21-member静态核心/SDK8 consumer、站点集成2项及两侧零新增lint通过。发布同次XP接受的准确8/9零售DLL及严格diagnostic；见 [stage4k18-validation.json](fixtures/d3d-review/stage4k18-validation.json)，镜像`glbridge/deployments/d3d-webgpu-review-4K18.json`。宿主/协议/翻译器/DDraw/包`9335ee9a77fb7cc808d2`不变，继承4I9完整核心238/六GPU基线。
> - 继续深度及其余资源/状态/复制适配器和公开8设备包装；完整格式/标志/MSAA/全屏/多缓冲/物理loss/线程、数值差分/语料、原生HAL/游戏/FPS及阶段4/5/6仍开放。

> **阶段 4K19（2026-11-04）：SDK8私有核心深度表面适配与深度/模板保留验收。**
>
> - 新增`d9wg_d3d9_core_depth_surface8`，保留旧公开8六种深度格式、无/四倍采样及早期失败不改输出规则；后期设备/存储失败清空输出，复用核心8192尺寸边界。向实际核心构造器传质量0、`Discard=FALSE`和空共享句柄，以保持切换目标时的深度内容。普通9和公开8的构造方法不变，返回真实核心9表面供后续资源包装使用。
> - 预处理真实SDK8/9核对深度枚举，以固定旧公开8方法和独立存储提供方作对照，**210,822检查/70,275组合**比较尺寸、格式、采样、结果、输出和全部转发参数。**14项严格编译后运行失败变异、一组ASAN**通过；两项初始尺寸变异的未使用参数编译错误被筛选拒绝，加入等价void引用后重新验证全部运行期失败。真实SDK8 consumer及头兼容调用验证私有stdcall `@24`，零售/诊断静态库保持21成员。
> - 新混合SDK探针比较4K18旧公开8、当前公开8、普通9、私有API8核心SDK120/220；后两模式各验证11种失败参数/输出。每模式创建无/四倍采样深度表面，核对描述、锁定拒绝/输出、GetDevice、缓存及公开归零恢复身份，再验证近红遮挡远蓝、解绑/重绑保留深度、仅清深度允许蓝色、左半屏模板7允许绿色且错误引用8拒绝蓝色；释放全部资源后Reset及最终设备释放成功。
> - 首次严格SDK构建和首次XP捕获通过，**154秒/30批次、五设备/五Reset/15纹理/三声明、28唯一协议句柄、35次UP/15次Clear/20读回**，Hello能力0/0/3，一个owner/session/最终释放。模拟能力0、只用RAM overlay；CPU回复明确注入解析图像，实际像素另由GPU证明。四倍采样对象只验证元数据与存储创建，不宣称四倍采样绘制或精度。
> - 冻结读取器独立计算LESS深度、清除/保留及模板比较/替换，核对35次输入顶点、83项状态、TSS、绑定、Clear、三声明、Reset及资源退役；**2,885项语义破坏检测**通过。SwiftShader/Metal各 **20图像/1,280真实像素、零差异/图形错误**，35绘制/15纹理，无上传/blit/Present；SessionEnd兜底和owner释放前表为空。实际GPU格式仅颜色21/深度75。
> - **完整客体326 suites、核心相关65 suites首次全通过**；32标准EXE、四严格DLL、21-member静态核心/SDK8 consumer、站点集成2项和两侧零新增lint通过。发布同次XP接受的准确8/9零售DLL及严格diagnostic，见 [stage4k19-validation.json](fixtures/d3d-review/stage4k19-validation.json)，镜像`glbridge/deployments/d3d-webgpu-review-4K19.json`。宿主/协议/翻译器/DDraw/包`9335ee9a77fb7cc808d2`不变，继承4I9完整核心238/六GPU基线。
> - 继续其余纹理/cube/volume/VB/IB/状态/复制适配及公开8设备/资源包装；完整格式/标志/MSAA/全屏/多缓冲/物理loss/线程、数值差分/语料、原生HAL/游戏/FPS及阶段4/5/6仍开放。

> **阶段 4K20（2026-11-04）：SDK8 CPU图像创建、32字节表面描述转换与版本化CPU锁定。**
>
> - 增加私有`image_surface8`和`surface_desc8`入口；从普通9的SYSTEMMEM/SCRATCH路径抽出共用CPU分配/生命周期，普通9原校验及DEFAULT GPU分支不变。API8图像保留8192上限、线性格式及失败输出规则，使用API8布局；CPU表面锁定按创建设备版本选布局，支持8独有的`W11V11U10/65`，普通9继续拒绝65。图像只占CPU内存，不新发GPU纹理创建。
> - 真实SDK8/9表面描述均32字节，但8的`Size`/采样字段占据9的采样/质量位置；逐字段暂存转换并检查长度、版本、vtable、格式、溢出与提供方错误，失败不改输出。SDK8 consumer用真实结构断言Size偏移16、采样偏移20；私有stdcall分别`@20/@12`，静态核心仍21成员。
> - 固定旧8图像/独立CPU构造及旧9offscreen方法对照 **59,475组合（8版8,496、普通9版50,976及三守卫）**，覆盖注册格式、池、尺寸/溢出、OOM清理、行距、零初始化与父引用。**47,203组**真实SDK描述布局/128位独立大小计算/输出守卫通过；保留锁定 **88,476检查/96适配场景**，新增65的版本差异检查。**24新变异、33保留变异、一个实际4K19旧CPU锁定入口对照、三组ASAN**通过，变异均严格编译后运行失败。
> - XP旧4K19公开8、当前公开8、核心8 SDK120/220均验证65的实际CPU零存储、整面写、子矩形保持、pitch12/Size24及最终释放；普通9拒绝65。两核心模式各检查九种图像参数失败及31/33字节描述失败原子性，CPU/RT/depth均用新描述入口；20次读回中的私有核心CPU目标使用新图像入口。首次SDK构建和XP捕获 **143秒/30批次**通过，保留五设备/五Reset/15纹理/三声明/28句柄/35绘制/20读回、一个owner/session/最终释放。能力0和磁盘RAM overlay；GPU读回CPU回复仍明确为解析图像注入，65本地CPU测试无需该注入。
> - 新读取器核对四模式CPU检查、9版拒绝及描述守卫，再复用4K19独立深度/模板/字节/生命周期模型，**2,891项语义破坏检测**通过；SwiftShader/Metal各 **20图像/1,280真实像素零差异/错误**，SessionEnd兜底和owner释放前表为空。此GPU验收覆盖保留的颜色21/深度75画面，不宣称65的GPU解码/采样。原捕获说明复制了“4K18旧8”标签，实际DLL为4K19 `404d7d5`且哈希吻合；保留原结果/日志，在元数据中明确更正原因及原文，仅修正未来运行说明，无需为标签重跑VM。
> - **完整客体329 suites、核心相关66 suites首次全通过**；32标准EXE/四严格DLL/21-member静态核心及SDK8 consumer、站点集成2项和两侧零新增lint通过。发布本次XP接受的准确8/9零售DLL及严格diagnostic；证据 [stage4k20-validation.json](fixtures/d3d-review/stage4k20-validation.json)，镜像`glbridge/deployments/d3d-webgpu-review-4K20.json`。宿主/协议/翻译器/DDraw/包`9335ee9a77fb7cc808d2`不变，继承4I9完整核心238/六GPU基线。
> - **已识别的下一修复：** 本次接口迁移的深度Size沿用旧代理“独立深度0、隐式深度固定四字节元数据”，不把它算作原生一致性。提交前核对固定Wine `415a275e` 的`d3d8_surface_GetDesc`及`wined3d_texture_init`，确认Size来自按格式/设备对齐计算的资源大小，而非CPU影子；接下来统一修正两入口的资源大小。相关源码blob分别`5b02035d53980c006fc19122b028f9263d1219a5`、`4ada3c3c8af82740cea4dc4a994fd3adb855d373`；尚无原生Windows对齐/物理深度精度验收。
> - 其余纹理/cube/volume/VB/IB/状态/复制适配、公开8设备/资源包装、完整格式/标志/MSAA/全屏/多缓冲/物理loss/线程、数值差分/语料、HAL/游戏/FPS及阶段4/5/6继续开放。

> **阶段 4K21（2026-11-04）：统一 API8 深度资源 Size，修复公开接口与私有描述转换。**
>
> - 按固定 Wine `415a275e3844c252ad385b46023095e9401ca234` 的 D3D8 四字节 surface alignment、格式行距与子资源大小，新增共用 `d9wg_depth_surface_layout8.h`。六种深度格式按每像素2/4字节计算并把每行对齐到4字节，逻辑大小不乘 MSAA；64位中间值/32位边界和失败输出原子性均有检查。此为 Wine 实现对照，尚无原生 Windows 对照；颜色/CPU 图像仍使用原有紧密行距。
> - 公开8的独立深度 GetLevelDesc/GetDesc、隐式深度创建及 Reset 缓存，与核心8的32字节描述入口统一使用该计算。修复旧独立深度 Size=0、旧隐式深度一律 width×height×4；Reset 在提交前计算大小。普通9描述布局不变。实际 GPU 深度存储仍为既有格式，不宣称六种格式的物理精度或真实四样本覆盖。
> - 独立128位计算对照 **103,680组/207,360检查**；公开8实际函数 **192组/1,156检查**；保留真实 SDK 描述布局 **47,203组/141,603检查**。Reset 新增12种格式/采样组合，API8共581检查、普通9共564检查；**31严格运行期变异、四个实际4K20旧函数反例、五组ASAN**通过，编译错误不计变异检出。
> - XP 使用准确4K20旧8、当前公开8、普通9、核心8 SDK120/220，验证 **56条独立元数据记录**：3×2六格式×MSAA0/4、初始8×8 D16 Size128及5×3 Reset Size36。旧8稳定复现0/固定4字节错误。保留65格式本地CPU位保持、普通9拒绝、私有图像及描述失败守卫和深度/模板画面。首次构建/捕获 **133秒/32批次、五设备/九Reset/63纹理/三声明/80句柄/35绘制/15清除/20读回**，单owner/session/最终释放；磁盘仅RAM overlay、模拟能力0。GPU读回的CPU回复仍明确使用解析图像注入，本地CPU检查无需该注入。
> - 冻结读取器 **3,846项语义破坏检测**通过，SwiftShader/Metal各 **20图像/1,280真实像素零差异/错误**；SessionEnd兜底与owner释放前资源表均为空。该GPU验收覆盖保留画面，新增六格式目标只作元数据/存储生命周期验收。
> - 客体首轮327/331通过，四处测试夹具因新增头文件及Reset运行错误前缀需要适配；修复夹具后四项单独重验，合计 **331全部通过**，保留原失败日志。核心 **67项首次全通过**；32标准EXE、四严格DLL、21-member静态核心/SDK8 consumer、站点集成2项及本任务两侧零新增lint通过。工作区另有Apple/ARM改动，首次全工作区lint发现五处无关module解析问题；保留日志，仅对本任务文件完成lint，不修改无关工作。
> - 发布同次XP接受的8/9零售DLL和严格diagnostic，证据 [stage4k21-validation.json](fixtures/d3d-review/stage4k21-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K21.json`。宿主/协议/翻译器/DDraw/包 `9335ee9a77fb7cc808d2` 不变，继承4I9完整核心238/六GPU基线。后续继续纹理/立方体/体积/VB/IB及状态/复制适配，公开8全面包装、原生对照和阶段4/5/6仍未完成。
>

> **阶段 4K22（2026-11-04）：SDK8 私有二维纹理创建与普通 CPU 纹理锁定/上传适配。**
>
> - 新增 `d9wg_d3d9_core_texture8@32` 和真实 SDK8 consumer；按旧公开8保留4096尺寸界限、8版格式/池/层级/RT参数与失败输出规则，再复用共用核心的存储、资源链表、父引用和失败清理。普通9构造入口仍选择9版8192/格式/autogen策略。核心普通纹理锁定和上传按所属设备版本取格式，支持8专有65；普通9仍拒绝65。8版未知autogen位不额外触发9版生成命令。RT纹理的创建可对照，专用读回及公开8包装尚待后续。
> - 旧8/9实际构造与创建命令对照 **2,945,283组合/14,928,972检查、103,737个mip比较**，包含两版本、注册格式、尺寸边界、层级、池/usage、每层分配失败与独立提交失败、零初始化、输出/资源链表/父引用。普通9创建支持谓词通过共享测试provider控制，两边调用同一provider；该对照证明构造重构不漂移，不替代9版全部原生格式兼容性验收。真实锁定/上传 **41,760组/88,694检查**，覆盖子矩形偏移、整行pitch、BC边界、只读/重复/空输出/非法层、上传失败清理；**23严格运行期变异、三个实际4K21旧入口反例、两组ASAN**通过。
> - 新 SDK8/9 分离编译探针在 XP 首次 **117秒/30批次**通过：准确4K21旧公开8、当前公开8、普通9、核心8 SDK120/220，五设备/五Reset/14纹理/三声明/27句柄/**43上传、20采样绘制、20读回**。四8版模式检查65的两级CPU零存储、写入保持、pitch/Size及44个非法调用，普通9拒绝65；全部模式验证四级21纹理、表面身份/父设备、子矩形整行pitch、Surface子视图上传及BC1。单owner/session/最终释放，能力0及RAM磁盘overlay；GPU读回CPU回复明确为解析图像注入。
> - 独立模型从操作规格产生上传字节和纹素，检查整面红、中央蓝子矩形、右侧绿表面写及BC1蓝，**3,317项语义破坏检测**通过。SwiftShader/Metal各 **20图像/1,280真实像素零差异/错误**，验证43次真实上传/20次采样绘制，SessionEnd兜底和owner释放前表为空。65的GPU上传与生命周期可见，未绘制65，不宣称其GPU采样精度；只读CPU检查不依赖解析GPU回复。
> - **334客体、68核心首次全通过**；构造测试在整套运行后补充独立提交失败及较低mip分配失败，将147万组合扩展至294万，最终构造/变异/ASAN均单独重验通过，保留两套准确计数日志。32标准EXE/四严格DLL/21-member静态核心及SDK8 ABI、站点集成2项、两侧本任务零新增lint通过。
> - 验收后仅清除一个空行尾随空格，保持所有C token及行号。保留XP原始源哈希，严格重建8/9及SDK8 consumer；首次原始section比较受链接器按输出路径分配的image base影响，按PE实际HIGHLOW重定位归一到RVA后，18个代码/常量/数据/重定位section均逐字节一致。发布准确XP接受的零售8/9及严格diagnostic；见 [stage4k22-validation.json](fixtures/d3d-review/stage4k22-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K22.json`。宿主/协议/翻译器/DDraw/包 `9335ee9a77fb7cc808d2` 不变，继承4I9完整核心238/六GPU基线。继续立方体/体积/VB/IB及状态/复制适配，阶段4/5/6仍开放。
>

> **阶段 4K23（2026-11-04）：SDK8 私有立方体纹理创建、六面/mip CPU 锁定与上传适配。**
>
> - 新增 `d9wg_d3d9_core_cube_texture8@28` 与真实SDK8 consumer。共用构造按版本保留8版4096/格式/池/usage/层级规则和9版8192/autogen规则，六面按face-major排列完整mip链；8版未知autogen位不额外发9版生成命令。普通立方体CPU锁定/上传按所属设备版本取格式，并保留8版压缩块子矩形对齐拒绝规则；普通9既有对齐行为不变。RT立方体创建可对照，专用读回和公开8完整包装仍待后续。
> - 实际旧8/9构造和创建命令对照 **2,548,803组合/12,875,871检查、65,934个face/mip比较**，覆盖格式/边界/层级/池/usage/每面分配失败/独立提交失败、零存储、链表和父引用。普通9支持谓词使用两边相同的受控provider，不替代完整原生格式验收；旧8对NULL的失败HeapFree按无成功释放处理。锁定/上传 **467,712组合/1,554,588检查**，六面/三层的选择与隔离、BC版本差异、子矩形pitch/偏移、只读、失败输出及上传失败清理均有独立计算对照。**26严格运行期变异、三个实际4K22旧入口反例、两组ASAN**通过；编译失败不计变异检出。
> - XP 首次严格构建/捕获 **109秒/55批次**通过：准确4K22旧公开8、当前公开8、普通9、核心8 SDK120/220，五设备/五Reset/14立方体/三声明/27句柄、**173上传/45采样绘制/45读回**。四8版模式检查65的六面/两层CPU零存储、写入保持、pitch/Size及32次非法调用，普通9拒绝65；全部模式检查21的六面/三层、表面身份/父设备、单面子视图更新及BC1。单owner/session/最终释放，能力0及RAM overlay；GPU读回CPU回复仍明确为解析图像注入。
> - 独立操作模型产生每面/mip上传字节，再对六个固定方向采样；修改+Z面中央子矩形后，检查+Z变化及-Z不变。**7,246项语义破坏检测**通过。SwiftShader/Metal各 **45图像/2,880真实像素零差异/错误**，真实14立方体/173上传/45采样绘制；SessionEnd兜底和owner释放前资源表为空。65仅验证CPU位保持和GPU上传生命周期，未采样，不宣称其采样精度；没有RT立方体读回或全mip GPU过滤覆盖的声明。
> - 32标准EXE/四严格DLL/21-member静态核心及SDK8 ABI、站点集成2项和本任务两侧零新增lint通过。发布同次XP接受的准确零售8/9及严格diagnostic。完整客体337和核心69回归结果写入 [stage4k23-validation.json](fixtures/d3d-review/stage4k23-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K23.json`。宿主/协议/翻译器/DDraw/包 `9335ee9a77fb7cc808d2` 不变，继承4I9完整核心238/六GPU基线。继续体积/VB/IB与状态/复制/包装适配；颜色/CPU原生行距、全部flag/格式/MSAA/窗口/丢失/线程、数值差分与阶段4/5/6仍开放。
>

> **阶段 4K24（2026-11-04）：SDK8 私有体积纹理、32字节体积描述及分层视图适配。**
>
> - 新增 `d9wg_d3d9_core_volume_texture8@36`、`d9wg_d3d9_core_volume_desc8@12`。共用构造保留8版2048/格式/usage/池/层级和失败输出规则，普通9保留既有创建策略及shadow失败后仍尝试view分配的次序。8版层级视图继续按需创建，9版继续构造时创建；查询的缓存身份、共享父引用、失败原子性和两版本非法level输出规则均保留。普通3D CPU锁定/逐切片上传按设备版本取格式，支持8专有65并保留8版子盒块对齐规则。
> - 真实SDK预处理确认 `D3DVOLUME_DESC8` 为32字节、9版为28字节；私有转换在word4插入Size，采用格式行距×行数×depth的32位溢出守卫，完整暂存后才写出。保留代理原有Usage透传；官方9文档把Usage记为0，此处仅做接口迁移与布局转换，未把该透传当作原生语义正确性。
> - 实际旧8/9构造/命令对照 **2,945,283组合/14,845,695检查、59,646个mip比较**；普通9支持谓词在两边使用相同受控provider，不替代全格式原生对照。真实box锁定/上传 **169,128组/447,186检查**，独立计算行距、切片间距、子盒源偏移/首尾切片、只读和上传失败清理；描述 **26,433组/79,297检查** 使用真实SDK布局及128位大小计算；视图 **320组/1,298检查** 覆盖按需分配失败、缓存身份和父引用。**33严格运行期变异、三个实际4K23旧入口反例、四组ASAN**通过，保留普通9体积绑定及14个严格运行期变异也通过。
> - 首次探针构建把体积接口宏误写成LockRect/UnlockRect，严格编译已拒绝，尚未启动VM；修正为LockBox/UnlockBox后，**首轮XP VM 117秒/40批次**通过。准确4K23旧公开8、当前公开8、普通9、核心8 SDK120/220，五设备/五Reset/九体积纹理/三声明/22句柄、**56上传/30采样绘制/30读回**。四8版模式检查65的两级CPU零存储、位保持、RowPitch/SlicePitch/Size及52次非法调用；普通9拒绝65。全部模式检查21的四切片/三mip、view身份/父设备、单切片子盒view写入及相邻切片保持。单owner/session/最终释放，能力0/RAM overlay；GPU读回CPU回复明确为解析图像注入。
> - 独立操作模型生成每层/每切片上传字节，再采样四个固定切片中心；子盒仅更新slice1，slice2保持原色。**4,102项语义破坏检测**通过，SwiftShader/Metal各 **30图像/1,920真实像素零差异/错误**、九体积纹理/56上传/30采样绘制；SessionEnd兜底和owner释放前表为空。65未采样，未声明GPU采样精度或全体积过滤/mip选择覆盖。
> - **客体342项、核心70项首次全通过**；32标准EXE/四严格DLL/21-member静态核心/真实SDK8 ABI、站点集成2项和本任务两侧零新增lint通过。保留绑定夹具补上9版profile/vtable依赖，原缓存别名变异改为新查询中的唯一lookup表达式，断言未放宽；旧构造反例通过mock函数地址引用避免无关unused警告，编译失败从未计入检出。发布同次XP准确零售8/9及严格diagnostic，证据 [stage4k24-validation.json](fixtures/d3d-review/stage4k24-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K24.json`。宿主/协议/翻译器/DDraw/包 `9335ee9a77fb7cc808d2` 不变，继承4I9完整核心238/六GPU基线。继续VB/IB、状态/复制/句柄及公开8包装；原生pitch/Usage/全flag/格式/MSAA/窗口/丢失/线程、数值差分、游戏/FPS和阶段4/5/6仍开放。
>

> **阶段 4K25（2026-11-04）：SDK8 私有顶点/索引缓冲创建与真实缓冲绘制验收。**
>
> - 新增 `d9wg_d3d9_core_vertex_buffer8@24`、`d9wg_d3d9_core_index_buffer8@24`，先清空输出并检查8版设备profile，再调用实际9版构造且shared handle固定NULL。实际旧8/9构造、描述和锁定规则在本迁移范围内一致，因此不复制分配/绑定引用/锁定/描述实现。真实SDK8/9预处理核对VB描述24字节/FVF偏移20、IB描述20字节，以及VertexData/Index16/Index32和资源类型枚举。保留旧代理接受SCRATCH、未校验最小FVF字节数等行为；官方9文档更严格，本阶段未将迁移一致性当作原生参数合规。
> - 旧8/9实际构造/命令/8版描述对照 **52,806组合/218,286检查**，两版本各26,400及六个profile/null守卫，检查 **41,982,960字节**零存储、长度/池/usage/FVF/索引格式对齐、OOM/提交失败清理、初始锁定/内部引用状态、资源链表/父引用和shared=NULL。**24严格运行期变异、两个实际4K24普通9构造体用于私有8入口的wrong-profile反例**通过；该反例说明边界必须有profile检查，不宣称普通9构造体自身有错。构造与保留锁定两组ASAN通过；原有8/9锁定各 **1,344组**固定策略/七XP HRESULT观测/保护页检查复用。
> - 保留锁定变异加强为明确拒绝编译失败；**27/27** 为23个C运行断言和四个受控保护页越界故障，后者必须有保护页标记及SIGSEGV/SIGBUS。初始仅接受SIGSEGV而拒绝了本机SIGBUS，保留日志后补上明确的平台故障类型。与实际4K24逐字节核对两个前端的四个锁定函数、共享策略、原27补丁计划和生成的C夹具均未变，避免把任意信号或编译错误算作检出。
> - 探针runner初次生成有for-loop截断导致解析失败，构建/VM尚未启动；修正后首轮VM **107秒/30批次**通过。随后发现VB元数据的FVF误用十进制44，而设备FVF使用SDK标志对应68；保留完整原捕获及源快照，将探针改为SDK标志表达式并重跑，**最终VM120秒/30批次**通过，生产代码未变。旧4K24/当前公开8、普通9、核心8 SDK120/220共五设备/五Reset/15缓冲/三声明/28句柄/**30上传/20缓冲绘制/20读回**；CPU零存储/只读位保持/DISCARD/NOOVERWRITE/offset16部分更新、VB80/IB16-12/IB32-24描述、绑定身份及45个非法调用通过。单owner/session/最终释放，模拟能力0及RAM overlay；GPU读回CPU回复明确为解析图像注入。
> - 独立模型规定顶点与16/32位索引字节，应用部分更新并核对两三角覆盖全屏，**1,857项语义破坏检测**通过。SwiftShader/Metal各 **20图像/1,280真实像素零差异/错误**，覆盖index16红/部分蓝、index32绿、非索引strip紫；实际GPU计数为 **15 indexedDrawCalls+5 drawCalls**，不要把后一个计数单独写为20。SessionEnd兜底和owner释放前表为空。
> - **344客体/71核心首次全通过**；32标准EXE/四严格DLL/21-member核心/SDK8 ABI、站点集成2项和两侧本任务零新增lint通过。发布最终XP接受的准确8/9零售DLL及严格diagnostic，见 [stage4k25-validation.json](fixtures/d3d-review/stage4k25-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K25.json`。宿主/协议/翻译器/DDraw/包 `9335ee9a77fb7cc808d2` 不变，继承4I9完整核心238/六GPU基线。继续状态/复制/句柄翻译与公开8设备/资源包装；原生验证缺口、RT纹理/立方体读回、全flag/格式/过滤/MSAA/窗口/丢失/线程、数值差分/游戏/FPS及阶段4/5/6仍开放。
>

> **阶段 4K26（2026-11-04）：共用 D3D8 render/TSS 翻译及私有核心状态入口完成。**
>
> - `runtime/d9wg_state_bridge8.h` 统一七个旧状态的丢弃、ZBIAS 的 0..16 限幅/负浮点位及十个 TSS→sampler 映射；公开8命令生成和私有核心8入口共用。新 render/TSS 入口 ABI 为 **@12/@16**，先检查 NULL/profile/范围，再调用实际9 setter，复用其重复过滤和状态块录制。**原始8 Get 值、被删除状态、未限幅 ZBIAS 及其状态块掩码仍归前端**，不把这两个入口当作完整公开8包装。ZBIAS 比例保留现有本地近似，不宣称原生驱动精度。
> - 实际旧8命令/setter、旧普通9 setter 和当前实际9录制对照 **740,360组合/1,533,458检查**：163,840命令、72,192原始前端、327,680翻译后端、176,640普通9；覆盖256个render槽、8×32个TSS槽、SDK8/9枚举、随机/NaN/符号位、负零、失败/重复顺序、原始查询和录制。旧8常量冻结为SDK数值，旧sampler函数单独冻结，oracle不调用被测映射。**35个有效严格运行变异、两个实际2e3982d普通9函数用于私有8边界的反例、ASAN**通过；反例说明需要翻译层，不宣称普通9 setter自身有错。13个公开8/普通9查询、设置和录制函数与4K25逐字节相同。
> - 初始原生夹具在重复设置检查前过早清空录制指针，修正夹具并保留失败日志。初始变异发现 `>=256` 改为 `>256` 被实际9 setter等价拦截，明确剔除，未算作检出。XP文件名最初超过8.3，构建完成但VM未启动；首轮实际VM通过旧/当前公开8后，因探针误认为所有被删除状态的9版默认值均为0而失败，实际172/173为3/1；改为设置前读取、设置后断言未变，保留捕获和源快照，生产代码未变。
> - 下一轮VM **126秒/9批次**通过五模式且driver owner释放，但没有SESSION_END：快速的无绘制探针在窗口监听线程异步卸载模块前退出。保留完整捕获/源快照，探针在FreeLibrary后等待四个模块实际卸载，**最终VM110秒/10批次**通过。准确4K25旧/当前公开8、普通9、核心8 SDK120/220共五设备/五Reset/10句柄、35次被删除状态设置、400组sampler配置，录制期间live查询、Apply/Capture/Reset默认及finalRefs=0通过；Hello[0,0,3]、单owner/session/end/最终释放、模拟能力0和RAM overlay。**没有绘制/读回/CPU注入回复，也没有新增像素正确性宣称。**
> - 独立SDK操作计划精确核对 **507条状态及八条默认补丁**，**2,243项语义损坏**均检出。原始8每设备102条，翻译9每设备101条，原因是9在ZBIAS转换后过滤等值输入；分别按原始/转换空间验证，未放宽序列。初始模型把Hello错误放在设备计数0/2/4，按前端实际激活顺序修正为0/1/2，状态计划未改。另外在SwiftShader/Metal分别重放**保留的4K25**缓冲绘制，均20图/1280像素零差异，15indexed+5nonindexed、SessionEnd回退前/owner释放前maps=0；这是既有L3回归，不是新状态探针的像素验收。
> - 首次完整客体 **342通过/四个旧夹具失败**：协议测试直接找原头文件内常量，caps夹具没引入共用限值，声明变异的临时头文件缺新include路径。修正夹具并重跑四项后 **346项汇总全通过**；协议映射检查改为编译执行实际C映射，保留caps16/声明9个严格运行变异。核心 **72项首次完整通过**；32标准EXE、四严格DLL、21-member核心/SDK8 ABI、站点集成2项、两侧本任务零新增lint通过。发布最终XP接受的准确8/9零售DLL和严格diagnostic，见 [stage4k26-validation.json](fixtures/d3d-review/stage4k26-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K26.json`。
> - 宿主/协议/着色器/DDraw/包 `9335ee9a77fb7cc808d2` 未变，继承4I9完整核心238/六GPU基线。继续复制/着色器句柄转换、原始8状态适配及完整公开8设备/资源包装；原生pool/FVF/depth-Usage/pitch、RT纹理/立方体读回、全flag/格式/过滤/MSAA/窗口/丢失/线程、数值差分/语料/HAL/游戏/FPS及阶段4/5/6仍开放。

> **阶段 4K27（2026-11-04）：UpdateTexture 原生池规则收敛及私有核心8复制入口完成。**
>
> - 固定 Wine blob `1764980c089b2dc8d1eab36312fea856c3e59d5f` 的 `test_update_texture_pool`：2D/volume只有SYSTEMMEM→DEFAULT成功，其他组合必须INVALIDCALL且目标像素不变；同时核对实际8包装和wined3d实现。发现公开8三个复制路径均缺此检查。新增共用 `d9wg_texture_copy_pools()`，公开8和普通9三类路径统一使用，修复8拒绝规则并保留9语义；cube按同一BaseTexture契约和既有9规则扩展，不把Wine的2D/volume用例称作独立原生cube HAL证明。
> - 新私有 `d9wg_d3d9_core_update_texture8@12` 验证NULL/profile，再调用实际9 UpdateTexture；类型/父设备/格式、全部mip/面/体积预检、分配、CPU镜像和上传继续复用核心实现。不是完整公开8设备/资源包装，也不把2D/cube/volume新复制内核重复实现一遍。
> - 原生 **221,186组合/663,614检查**，公开8/普通9/核心8各73,728，加两个边界守卫；SDK池枚举、全类型/池含坏元数据/NULL/父设备/格式组合、精确extent/指针/status、输入位保持及实际旧普通9oracle通过。实际旧8 **420次非法池分派**被新规则拦截，包含故障注入和构造器不会发布的坏pool元数据，未把它们称作420次原生API成功。**17严格运行变异、三个实际2a43549旧8函数反例、两组ASAN**通过。初始“source别名”变异产生unused参数而被严格编译拒绝；改为保留参数引用的错误实参顺序，未降低警告标准或算作检出。
> - 保留实际8/9共用复制内核各 **42组** mip选择/截断/无源mip安全no-op/六面stride/late-invalid/OOM-before-copy/上传失败前缀用例，并让两版都检查非法source pool。保留 **25个复制变异**加强为明确拒绝编译失败及要求带数字行号的实际C断言。使用同一复制内核验证，未放宽失败分类。
> - **XP首轮109秒/10批次通过**：准确4K26旧8/当前公开8/普通9/核心8 SDK120/220共五设备/五Reset、**480纹理/490句柄/240池组合/640个本地DWORD**，cube全部六面。旧DLL实际复现 **45次错误成功并改写目标**；其余四profile各拒绝45组，共 **180次拒绝且目标保持不变**，各三组合法复制成功。最终模块实际卸载、单owner/session/end/释放、Hello[0,0,3]、finalRefs=0、能力0/RAM overlay通过。无绘制/读回/注入CPU回复，未宣称新增GPU采样正确性。
> - 独立操作模型精确核对 **1440次四字节上传**：旧8有384次，四个当前profile各264次；拒绝的调用无额外上传。**6205项语义损坏**均检出；初始遗漏volume-create reserved校验导致对应损坏存活，补充reserved=0断言，保留初始失败日志，未删变异。SwiftShader/Metal分别重放**保留的多mip复制夹具**，各 **84帧/252个采样点**字节误差0；42纹理/598上传/84UP/84Present/84真GPU读回、两session结束及零错误。旧浏览器只检查三个采样点/帧，未把它写成整幅64×64像素覆盖或本次池探针的新像素。
> - **348客体/73核心完整通过**；核心首次启动脚本与生成并行导致文件尚未存在，未运行任何测试，保留启动日志，实际首次执行73项全通过。32标准EXE/四严格DLL/21-member核心/SDK8新ABI、站点集成2项及两侧本任务零新增lint通过。发布最终XP接受的准确8/9零售DLL及严格diagnostic，见 [stage4k27-validation.json](fixtures/d3d-review/stage4k27-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K27.json`。
> - 宿主/协议/翻译器/DDraw/包 `9335ee9a77fb7cc808d2` 未变，继承4I9完整核心238/六GPU基线。继续表面复制/前缓冲/着色器句柄转换和公开8对象包装；原生pool/FVF/depth-Usage/pitch的其他缺口、RT纹理/立方体读回、全flag/格式/过滤/MSAA/窗口/丢失/线程、数值差分/语料/HAL/游戏/FPS及阶段4/5/6仍开放。

> **阶段 4K28（2026-11-05）：共用 API8 前缓冲算法及私有核心读回入口完成。**
>
> - `runtime/d9wg_front_buffer_bridge8.h` 将实际旧8 GetFrontBuffer 算法用SDK绑定实例化；公开8变成薄调用，核心8新增 **@8** 入口及实际9对象的存储/读回/上传适配。保留大目标外圈、X8、2D/cube子表面和不透明A8结果；不能直接调用要求等尺寸/A8/CPU目标的普通9入口。共用函数体与实际c5221bb旧8方法经类型/访问器机械重绑定后的函数体逐字相同；六个普通9方法逐字不变。
> - 原生 **28,835组合/133,300检查**，实际冻结旧8方法oracle、真实SDK8/9的32字节描述及不同字段偏移、21/22/23格式、等大/更大/带padding目标、CPU/2D/cube/backbuffer/RT、锁定/父设备/depth/NULL、读回与上传失败、缓存源引用、零分配/两处OOM/外圈保护通过。另测内部65 CPU布局，不宣称65为合法backbuffer或GPU精度。**25个严格运行变异**要求实际C数字行号断言或精确的分配器保护断言（函数/文件/行号），不接受一般信号；一个实际旧9严格方法保留profile守卫后作为私有8入口的反例通过，不把9方法本身说成有错。
> - 保留公开8表面 **61组/29变异**、普通9读回 **43组**，两组ASAN通过。初始原生夹具名称`gets`撞到标准库且少一个runtime类型include，修正夹具；分配保护触发的C断言最初未被分类识别，增加精确匹配。收紧旧表面分类后发现越界点用例只产生SIGBUS；为非法矩形探针增加实际调用者缓冲范围观察，在非法写入前产生C断言，29个变异全部按C断言检出，未把任意崩溃算成功。最初DLL输出目录不存在、SDK探针缩排被Werror拒绝均发生在VM之前；修正目录/括号，编译标准未降。
> - **实际XP首轮125秒/59批次通过**：准确4K27旧8/当前公开8/普通9/核心8 SDK120/220，共五设备/五Reset、35前缓冲调用 **29成功/6拒绝**、**4095个本地DWORD**、10纹理/三声明/23句柄。普通9只接受等大A8 CPU目标，其余旧8形状保持拒绝且目标未变；8路径保持大目标外圈及X8、2D/cube子表面上传，Reset后5×3源写入7×5目标仍保持外圈。单owner/session/end/最终释放、Hello[0,0,3]、能力0/RAM overlay及finalRefs=0通过。
> - CPU读回回复明确为解析注入，A8源回复刻意保留alpha=0，由API前缓冲路径置255；X8回复按格式为不透明。独立SDK操作模型核对 **18上传/6048字节、20次中心/外圈UP绘制、49次读回/2940像素、55清除**，**4233项语义损坏**均检出。SwiftShader/Metal均49图/2940实际像素零差异；中心为不透明复制色，外圈保留原alpha/颜色，并核对透明源、X8和Reset后的源。零宿主/GPU错误，SessionEnd回退及owner释放前maps=0。这里只验收代理输出面，不宣称原生桌面、窗口偏移或完整Present前后时序。
> - **350客体/74核心完整通过**；32标准EXE/四严格DLL/21-member核心/SDK8新ABI、站点集成2项和两侧本任务零新增lint通过。发布最终XP接受的准确8/9零售DLL及严格diagnostic，见 [stage4k28-validation.json](fixtures/d3d-review/stage4k28-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K28.json`。
> - 宿主/协议/着色器/DDraw/包 `9335ee9a77fb7cc808d2` 未变，继承4I9完整核心238/六GPU基线。继续CopyRects/着色器句柄转换与完整公开8设备/资源包装；原生pool/FVF/depth-Usage/pitch、RT纹理/立方体其他读回规则、全flag/格式/过滤/MSAA/窗口/丢失/线程、数值差分/语料/HAL/游戏/FPS及阶段4/5/6仍开放。

> **阶段 4K29（2026-11-05）：共用 API8 CopyRects 顺序、重叠及 CPU/GPU 复制算法。**
> - 把原公开8的单矩形算法和数组入口原样抽入 `d9wg_copy_rects_bridge8.h`，公开8变成薄调用；新增私有 `d9wg_d3d9_core_copy_rects8@24`，只接受API8核心设备，使用实际核心9的表面/父级存储、上传及公共读回传输。保留零count指针语义、多矩形逐项提交/中途失败、可选目标点、同存储快照、部分写的有效性、池组合和立方体face/mip身份。普通9的UpdateSurface/StretchRect/GetRenderTargetData仍应用原规则。
> - 冻结准确4K28旧8两个实际函数作对照，SDK8/9描述从真实头文件提取；**316,230次检查 / 77,766个案例**覆盖四池、21/23/内部65元数据、CPU/2D/cube/隐式缓冲、padding、锁/深度/异设备、读取/上传失败、顺序部分成功、重叠/OOM及profile守卫。内部合成池/65组合用于算法对照，不冒充原生HAL能力。**22项严格编译后的实际C断言变异、两组ASAN**通过；保留公开8的61案例/29项语义变异全部通过。源码审计证明16个原有方法/存储函数字节未变，两个共享主体机械还原后与准确旧8逐字节相同。
> - **首次严格SDK构建和首次实际XP捕获170秒/29批次通过**：准确4K28旧8、当前公开8、核心8 SDK120/220，四设备/四Reset、**1,148个本地DWORD检查、16纹理/24句柄、16上传528字节、20GPU blit、20读回**。核对立方体face4/mip1、CPU和cube重叠、两项成功后第三矩形失败且前两项已生效、零count无操作、锁定源/越界拒绝及Reset8×8→5×3。实际Hello为 **[0,0]**；核心8借用已附加的进程运行时，没有普通9模式新增Hello。单owner/session/end/最终释放、模块实际卸载、finalRefs=0、能力0与RAM磁盘overlay通过。CPU读回回复明确为独立解析图像注入。
> - 冻结器首轮误把外层Escape的保留word当0、遗漏WINDOW_STATE/常量默认包并误设三次Hello，还引用了协议中不存在的Clear.rects_offset；核对真实协议/捕获后修正检查器，保留三轮失败日志，未改VM字节、SDK断言或生产代码。**1,273项字段/像素/日志/生命周期语义破坏**全部检出。
> - SwiftShader与Metal各验证 **20张完整图像 / 1,084个RGBA像素零差异**，实际16纹理/4cube、16上传528字节、20blit、20读回、零Draw/Present、零宿主/GPU错误；客体在SessionEnd兜底及owner释放前已把资源/设备映射清空。此项证明复制路径，不宣称新增着色器绘图正确性。
> - **352客体/75核心完整回归**、32标准EXE/四严格DLL/21-member静态核心/SDK8新ABI、站点集成2项和两侧本任务零新增lint通过。发布本次XP接受的准确公开8零售DLL、同源严格构建9零售DLL及两API严格diagnostic；本次没有运行普通9的SDK模式，普通9由源码不变审计及保留测试覆盖。证据 [stage4k29-validation.json](fixtures/d3d-review/stage4k29-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K29.json`。
> - 宿主/协议/着色器/DDraw/包 `9335ee9a77fb7cc808d2` 不变，继承4I9完整核心238/六GPU基线。继续着色器/状态块句柄与完整公开8设备/资源包装；其他原生pool/FVF/depth-Usage/pitch、RT纹理/cube普通Lock读回、全flag/格式/过滤/MSAA/窗口/丢失/线程、数值差分/语料/HAL/游戏/FPS及阶段4/5/6仍开放。

> **阶段 4K30（2026-11-05）：共用 D3D8 顶点声明策略/解析器，私有核心构造真实声明对象。**
> - 把旧8的声明字段、类型大小/映射和寄存器语义移到SDK无关的 `d9wg_declaration8_policy.h`，原8头引用该表；两个扫描/转换主体共用 `d9wg_declaration8.h`，公开8保留薄包装。新增 `d9wg_d3d9_core_vertex_declaration8@16`，仅接受API8核心设备，转换后调用真实9声明构造器，保留declaration-only主NORMAL只能FLOAT3的规则。原始8声明、DWORD句柄和局部常量元数据继续由8适配层持有；本项不把局部常量写进设备API常量，也不构造完整8着色器包装。
> - 准确4K29旧8策略/两个C函数冻结为独立对照；真实SDK9提取的8字节顶点元素布局参与验证。**4,013,650次检查 / 1,105,927个案例**覆盖多流/跳过/offset、所有寄存器和输入类型、容量、局部常量块/字面END/重叠/范围、主/次NORMAL规则、8192边界、profile/输出及后端构造错误。**25项严格编译后实际数字行C断言变异、两组ASAN**通过；保留局部常量1,656,669次检查和16变异、declaration-only完整路径及9变异通过。
> - 初轮严格SDK8静态核心构建发现`DWORD*`与`uint32_t*`虽然同宽却是不同C类型；改成`memcpy`读取四字节word、按字节复制常量，消除强转/别名假设后重新构建。初轮新变异中FLOAT3大小修改未被检出：原测试将可变类型放在最后一个元素，无法观察其大小；增加后继元素观察下一offset，保留失败日志后25项全过。旧变异夹具补上纯解析器/策略头依赖和固定宽度类型匹配，没有放宽编译或断言。
> - **首个实际XP VM135秒/20批次通过**，启动器第一次无SDK日志，第二次启动成功；捕获严格只含一组五模式执行。准确4K29旧8/当前公开8/普通9独立SDK布局/核心8 SDK120/220，共五设备/五Reset、10托管VB/五声明/25句柄、**15上传640字节/十次双流绑定绘制/十读回/640本地DWORD**。输入位置/颜色分别使用stream0/1、offset4、stride16/8；核对原8的48字节声明/空函数/失效句柄、核心COM描述/父设备/绑定身份、16次非法声明拒绝、常量字面END不被当终止及API常量不被覆盖。Reset后保留真实对象与位置缓冲，只更新颜色后继续绘制；单owner/session/end/release、模块实际卸载、finalRefs=0、Hello[0,0,3]、能力0/RAM overlay通过。CPU读回回复明确为解析图像注入。
> - 冻结检查器依据实际旧8/9规则区分NULL流解绑：公开8把stride写0，9和当前私有8核心保留旧stride；该差异仍需未来公开8包装层保存原8查询状态。另纠正检查器对Reset常量全清零的假设：两侧均重发已保留的c2白色值；逐字校验完整常量包。保留三轮检查失败日志，捕获/SDK断言/生产代码未因此改动。**8,514项字段/声明字节/顶点字节/常量字节/日志/生命周期破坏**全检出。
> - SwiftShader和Metal各验证 **10张完整图像 / 640个RGBA像素零差异**，包含跨Reset红→绿、真实双流偏移输入；十次非UP/非索引缓冲绘制、零纹理/Present、零宿主/GPU错误，资源/设备映射在SessionEnd兜底及owner释放前归零。源码审计确认19个原8/9创建、绑定、查询和常量方法未变，策略表精确搬迁，两个解析主体机械适配后相同。
> - **354客体/76核心完整回归**、32标准EXE/四严格DLL/21-member核心/真实SDK8新ABI、站点集成2项及两侧本任务零新增lint通过。发布本次XP准确8/9零售DLL和严格diagnostic；证据 [stage4k30-validation.json](fixtures/d3d-review/stage4k30-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K30.json`。宿主/协议/着色器/DDraw/包 `9335ee9a77fb7cc808d2` 不变，继承4I9完整核心238/六GPU基线。继续局部DEF构造、真实核心着色器/句柄、状态块及完整公开8对象包装；其他原生兼容、数值差分/语料/HAL/游戏/FPS及阶段4/5/6仍开放。

> **阶段 4K31（2026-11-05）：共用局部DEF字节码构造，私有核心8创建真实VS/声明对及PS对象。**
> - 把旧8 emitter中的局部DEF拼接收敛到 `d9wg_shader8_local_defs.h`，按字节复制以兼容SDK标量类型。公开8仍保持原始函数/声明查询、原wire计数/哈希；私有 `d9wg_d3d9_core_vertex_shader8@20` 返回真实9声明/VS对象，NULL函数仅创建声明，局部常量只进入程序DEF。先验证原始8版本/body/8192边界，再扩展可信DEF，复用从原9工厂原样抽出的唯一分配/发布路径；普通9仍先走原扫描器。新增 `d9wg_d3d9_core_pixel_shader8@12`，用原8 profile校验创建真实9 PS。失败时两输出清空，声明/临时程序/着色器和父设备引用按实际失败位置回收。
> - **1,012次检查 / 478个实际核心构造案例**覆盖VS1.0/1.1、PS1.0–1.4、NULL函数/主NORMAL、重叠/空洞/c95局部常量、原始8192边界与扩展后8211字存储、profile/输出、四处分配失败和声明/着色器提交失败回收。**22项严格编译后的实际C语义/分配guard断言变异、两组ASAN**通过。保留原8局部常量1,656,669检查/16变异，以及核心创建43,518检查、10,578构造、5,280次旧普通9对照和17校验变异全部通过。
> - 初始native夹具漏TRUE/FALSE定义、一个旧变异在抽函数后使bytecode参数未用，均按编译失败拒绝；补齐测试宏，并在错误复制变异中显式引用参数，未放宽警告。首轮SDK探针在VM启动前被实际头文件拒绝：9版GetFunction的长度是UINT指针，8版是DWORD指针；分别使用真实类型后严格构建通过。失败日志保留。
> - **首个实际XP VM117秒/30批次、启动一次通过**：准确4K30旧8/当前公开8/普通9独立展开程序/核心8 SDK120/220，五设备/五Reset、**15声明/35着色器/60句柄、20UP绘制/20读回/1280个本地DWORD**。五个模式各创建VS1.0红、VS1.1绿、声明专用NULL函数和五种PS版本；核对原8函数/声明/失效句柄、内部9的DEF+END完整查询、COM父设备/绑定身份及最终释放。VS局部c2红在API c2改黄后仍红，局部c8绿跨Reset仍绿；原始8查询保持原输入，内部9查询明确是展开程序，不混为同一接口。PS只验证创建/函数/父设备/退役，未宣称PS数值绘制。单owner/session/end/release、模块实际卸载、finalRefs=0、Hello[0,0,3]、能力0/RAM overlay通过。CPU回复明确注入独立红/绿解析图像。
> - 独立wire规范校验两种END计数、全部展开DEF/原body、既有协议哈希、原始/Reset API常量包、绑定与资源退役；**11,569项字段/程序/顶点/常量/日志/生命周期语义破坏**检出，首轮冻结与检查器即通过。SwiftShader和Metal各验证 **20张完整图像 / 1,280个RGBA像素零差异**；实际20次可编程UP绘制（drawCalls/upDrawCalls/programmableDraws是重叠计数）、零纹理/Present、零宿主/GPU错误，设备/资源映射在SessionEnd兜底及owner释放前归零。
> - 源码审计证明22个原8/9创建、绑定、查询、引用/销毁方法未改；把共享DEF调用还原成旧循环后，8 emitter逐字节一致；把抽出的分配主体放回后，9工厂的校验/分配主体逐字节一致。**356客体/77核心完整回归**、32标准EXE/四严格DLL/21-member静态核心/真实SDK8新ABI、站点集成2项及两侧本任务零新增lint通过。发布本次XP准确8/9零售DLL和严格diagnostic；证据 [stage4k31-validation.json](fixtures/d3d-review/stage4k31-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K31.json`。
> - 宿主/协议/着色器翻译器/DDraw/包 `9335ee9a77fb7cc808d2` 不变，继承4I9完整核心238/六GPU基线。继续API8的FVF/句柄绑定、原始查询状态/状态块和完整公开8对象包装；其他原生兼容、全部SM数值差分/语料/HAL/游戏/FPS及阶段4/5/6仍开放。


> **阶段 4K32（2026-11-05）：核心8以真实9声明缓存绑定 FVF，并保持8的清零及状态块语义。**
>
> - 新增私有 `d9wg_d3d9_core_set_fvf8@8`。按8方言解码，解绑VS；零值清除VS和布局。转换后的真实9声明保留独立 `legacy_fvf8` 缓存键，内部 `fvf=0`，防止状态块 Apply 将8的数值按9再次解码。缓存只持内部引用，公开引用归零后不额外固定设备；状态块/公开声明可跨缓存清理及Reset保留，再次绑定复用同一对象。普通9缓存及 SetFVF(0) 无操作行为保留。
> - **622,117项原生检查 / 40,970例**：冻结旧8/9 decoder，对照40,960种位置/标志/纹理维数，36,832接受、4,128拒绝，另10例清零/生命周期/入口及失败检查。覆盖声明字节、公开归零/设备父引用、两种缓存不串用、记录及应用状态块、缓存重获、设备先释放/最后公开视图清理、OOM/创建提交失败。**19/19变异**均严格编译后被实际C断言杀死；语义等价的Stream255终止项变异没有计作成功，改为真正无效的非终止UNUSED元素。新8绑定及保留9缓存两族ASAN通过。
> - **真实XP 108秒 / 30批 / 一次启动**：准确4K31旧8、当前公开8、普通9参考、核心8 SDK120/220，5设备/5Reset/8声明/5VS/23协议句柄。旧8原值 `0x4042` 忽略bit14，得到FLOAT3+diffuse、stride16；普通9参考明确用 `0x42` 并单独解绑VS。各模式红色程序切到绿色FFP、顶点状态块恢复、清零后绘制拒绝、Reset后恢复，1,280本地DWORD、最终引用0、模块卸载/单owner/SessionEnd/释放通过。公开8仍返回原FVF，私有9 GetFVF为0，二者职责明确。
> - 独立wire模型验证完整布局/着色器/顶点/常量载荷及绑定顺序、零值拒绝无draw、Reset及退休，**15,899项关键字段/日志/截断篡改全部检出**。SwiftShader和Metal各**20完整图像 / 1,280 RGBA像素零误差**：20UP draw包含5可编程+15FFP，0纹理/Present；SessionEnd回收前及owner释放前资源表均为空，GPU/host错误0。VM CPU回复明确为解析图像注入，真实图像由两GPU独立验证。
> - 源码审计：原**634个核心9函数逐字节一致**，整个公开8源文件及8/9 decoder未改，冻结decoder与基线准确一致。**358客体 / 78核心完整回归**、32标准EXE/四严格DLL/21-member静态核心/真实SDK8新ABI、站点集成2项及两侧本任务零新增lint通过。发布XP准确8/9零售DLL及严格diagnostic。证据 [stage4k32-validation.json](fixtures/d3d-review/stage4k32-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K32.json`。
> - **范围仍开放：** 这是核心8绑定接口；原8前端保留DWORD句柄、原始Get影子及公开错误策略，完整公开8包装尚未切换。ProcessVertices目标VB的8方言FVF、其余池/标志/格式语义、着色器数值差分、原生HAL/游戏/FPS及阶段4/5/6继续推进。宿主、协议、translator、DDraw及运行包 `9335ee9a77fb7cc808d2` 未改。


> **阶段 4K33（2026-11-05）：核心8绑定真实9的程序/声明对。**
>
> - 新增私有 `d9wg_d3d9_core_set_vertex_shader8@12`：接收前端已解析的真实9声明与VS，**先验证两对象的类型和设备归属，再修改任一绑定**；NULL VS支持声明专用，NULL/NULL复用8的清零入口。未录制的相同对象对无操作，录制中即使相同仍写入两个状态槽。公开8的DWORD句柄、Get原始字节和错误发布继续归前端。
> - **33,440原生检查 / 1,036例**：程序/声明专用、独立换声明/独立换程序、公开引用归零/再取回、重复值与录制区别、状态块Apply及NULL/NULL录制、清绑定后恢复、设备先释放/最后公开视图/最后状态块清理。空设备/普通9配置/缺声明/异类型/跨设备输入在改状态前拒绝；第一或第二次提交失败均按底层9的状态发布顺序检查，不重放不确定前缀。**19/19严格编译C语义变异**、新绑定及实际创建两族ASAN通过。首次仅同时换两个对象的测试漏掉“忽略声明的重复判断”变异；补齐独立切换后全部检出，没有计入编译错误或普通信号。
> - **真实XP 148秒 / 30批 / 一次启动**：准确4K32旧8、当前公开8、普通9、核心8 SDK120/220，5设备/5Reset/15声明/35着色器/60协议句柄。实际创建VS1.0/1.1及其局部DEF；先绑定并清除声明专用对象，再绘制红色；重复红色绑定录制后切绿并Apply恢复红色，API常量覆盖仍不改变局部红；Capture更新为绿色对，Reset后Apply恢复绿色。1,280本地DWORD、原始8与扩展9查询、最终引用0及模块卸载/单owner/SessionEnd/释放全部通过。PS1.0–1.4仍只验证创建/查询/销毁，不宣称像素数值。
> - 独立wire模型钉住布局/字节码/散列/全部常量及顶点、逐模式绑定顺序和退休；**11,656项关键字段/日志/截断篡改全部检出**。SwiftShader与Metal各**20完整图像 / 1,280 RGBA像素零误差**，20可编程UP draw、0纹理/Present，35 shader translations，GPU/host错误0；资源表在SessionEnd兜底与owner释放前为空。CPU回复仍明确为解析图像注入，与实际GPU结果分别记录。
> - 源码审计：原**636个核心9函数逐字节一致**，整个公开8文件与8/9 decoder未改。**360客体 / 79核心完整回归**、32标准EXE/四严格DLL/静态21-member/真实SDK8 stdcall12 ABI、两项站点集成及任务范围lint通过。发布XP准确零售8/9和严格diagnostic；证据 [stage4k33-validation.json](fixtures/d3d-review/stage4k33-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K33.json`。
> - **失败边界：** 这里只对无效对象输入保证不改状态；实际9 setter先发布本地状态再提交，传输失败按其原有顺序保留已发布状态，不宣称公开8失败策略已替换。原生绑定测试的构造器仅供应对象元数据，实际SM1.x创建由保留创建套件及XP覆盖。完整公开8包装、原始句柄/状态块影子、ProcessVertices目标8方言、其余原生兼容性/数值差分/游戏/FPS和阶段4/5/6继续；宿主、协议、translator、DDraw及运行包未改。


> **阶段 4K34（2026-11-05）：D3D8 BaseVertexIndex 按原始位模式送入核心9索引绘制。**
>
> - 新增私有 `d9wg_d3d9_core_draw_indexed8@28`，前端把 SetIndices 保存的UINT基址逐次传入；通过字节复制得到INT基址，原值 `0xffffffff`准确成为−1，不清符号位、不取绝对值、不改核心9的索引绑定。公开8 GetIndices 与DWORD状态块中的原始base仍由包装层维护。边界头文件继续只依赖Windows与不透明COM声明，以UINT表示primitive类型，进入真实9调用时转换。
> - **115,727项检查 / 50,004例**执行实际9 DrawIndexedPrimitive、范围判断、emitter及状态提交。50,000组独立物理顶点枚举对照：4,941次正常发出、42,375拒绝、2,459零图元、225传输失败；另4例空设备/普通9有效控制/配置隔离/无绑定零图元。覆盖正负极值、16/32位IB长度、两个流的offset/stride与常量流、原样hint、绑定保持、失败不提交ClipStatus/镜像。**16/16严格C语义变异**及新索引/保留公开8绘制两族ASAN通过。首次oracle遗漏原9最小stride限制，补齐前提；零hint随机样本未命中则补显式0后，原先存活的“拒绝空hint”变异被检出。
> - 独立静态消费者发现新接口最初误将SDK专用枚举放进纯边界头；首轮探索XP仍通过138秒/30批。随后边界改UINT、实现显式转为SDK9枚举，21-member零售/诊断archive与无SDK消费者/真实SDK8 stdcall28全部通过，并以最终源码**重新XP验收：180秒 / 30批 / 一次启动**。最终交付仅取第二轮准确零售DLL。
> - XP准确4K33旧8、当前公开8、普通9参考、核心8 SDK120/220：5设备/5Reset/15 managed VB/IB/3缓存声明/28协议句柄；基址+1、−1、0配合16/32位索引，六顶点的首尾为黄色屏外哨兵，实际索引均准确选中中间四顶点。红/蓝/绿/紫20次索引绘制和1,280本地DWORD，managed缓冲跨Reset、原始8 base查询、零图元及两种范围拒绝、父对象/绑定身份、最终引用0与模块卸载/单owner/SessionEnd/释放通过。极端基址只在原生范围/命令检查中使用，实际图像用有效+1/−1/0。
> - 独立wire模型核对完整VB/IB上传、哨兵/位置/颜色、raw-to-signed base及全部draw字段、Reset保留及资源退休，**4,583项关键字段/载荷字节/日志/截断篡改全部检出**。两GPU各**20完整图像 / 1,280 RGBA像素零误差**：20 bound indexed draw、40 buffer uploads、0UP/可编程/纹理/Present；资源表在SessionEnd兜底与owner释放前为空，GPU/host错误0。VM CPU回复明确为解析图像注入；图像另由SwiftShader/Metal实际读回。模型先前误认为Reset重建FVF缓存声明，已按实际复用保留为每9模式一个，未改捕获或生产行为。
> - 源码审计证明原**637个核心9函数逐字节一致**，公开8完整文件及FVF decoder未改。**362客体 / 80核心完整回归**、32标准EXE/四严格DLL、静态核心及两项站点集成、任务范围lint通过；发布第二轮XP准确8/9零售DLL和严格diagnostic。证据 [stage4k34-validation.json](fixtures/d3d-review/stage4k34-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K34.json`。
> - 继续DWORD状态块句柄/原始元数据与完整公开8对象包装，及ProcessVertices目标8方言、其余原生兼容性/数值差分/原生HAL/游戏/FPS和阶段4/5/6；宿主、协议、translator、DDraw及运行包 `9335ee9a77fb7cc808d2` 未改。


> **阶段 4K35（2026-11-05）：核心8根据前端原始快照构建真实9状态块。**
>
> - 新增私有 `d9wg_d3d9_core_record_state_block8@16` 和SDK无关的同步recorder回调。前端按8的范围选出原始快照，通过现有8转换入口录制；核心复用真实9 Begin/End，成功后只保留值和对象引用，失败调用现有 `device_cancel_recording`。回调及context不进入状态块；已存在录制在Begin失败时原样保留。8的DWORD句柄、原始Get、范围选择与Capture重建策略仍归包装层，可用新9快照替换同一公开8句柄背后的对象。
> - **19,488项原生检查 / 1,037例**：1,024程序/声明专用及四种清理顺序，录制期间live不变、栈快照改写后Apply仍使用已保存数据、重建替换、公开引用归零/再取回、设备先释放/最后公开视图/最后状态块。另13例入口/已有录制/Begin OOM/回调错误/空context/正HRESULT/冷FVF创建失败与缓存所有权；负HRESULT原样返回，输出清空，失败块/父引用无泄漏。冷FVF录制可准备仍由设备持有的缓存，取消块不会丢失该缓存所有权。**15/15严格C语义变异**及新快照/保留9状态块两族ASAN通过；原9状态块160,909项检查继续通过。首次fixture把LONG引用数存入UINT触发严格编译，改用准确LONG，未放宽警告。
> - **真实XP 141秒 / 30批 / 一次启动**：准确4K34旧8、当前公开8、普通9显式规范化快照参考、核心8 SDK120/220，5设备/5Reset/15声明/35着色器/60协议句柄。红色live状态下记录绿色对，先检查录制/失败均不改变live，再Apply变绿；Capture更新快照后跨Reset恢复。公开8查询保留ZBIAS原整数111及已删除POSITIONORDER的42/7；9查询分别验证转换后的clamped浮点bias和ADDRESSU→sampler。转换尺度沿用既有本地近似，不宣称原生HAL精度。回调栈数据改写、公开原始8与9扩展shader查询、最终引用0和模块卸载/单owner/SessionEnd/释放通过。
> - 旧8参考的放弃录制用End/Delete，普通9参考用End/Release，私有8回调失败则执行真实cancel；**不把前两者称为已有公开回调API**。Capture在公开8保留DWORD，在私有/参考9根据新的前端快照重建对象。PS1.0–1.4仍只验证创建/查询/销毁，不宣称PS像素数值。
> - 独立wire模型验证完整布局/字节码/散列/常量/顶点、绑定顺序、bias/sampler值与Reset退休，**11,749项关键字段/日志/截断篡改全部检出**。初始模型把原始8零值与9转换后的负零都当作会发出；已分别钉住8未变化raw0省略、9的0x80000000初始写入，生产/SDK/捕获未改。两GPU各**20完整图像 / 1,280 RGBA像素零误差**，20可编程UP draw、35 shader translations、0纹理/Present，GPU/host错误0，资源表在SessionEnd兜底与owner释放前为空；CPU回复明确为解析图像注入，GPU结果独立记录。
> - 源码审计：原**638个核心9函数及状态块存储逐字节一致**，完整公开8/FVF decoder/8状态转换与范围头未改。**364客体 / 81核心完整回归**、32标准EXE/四严格DLL/21-member静态核心/真实SDK8 callback与stdcall16、两项站点集成及任务范围lint通过。发布本次XP准确8/9零售DLL和严格diagnostic；证据 [stage4k35-validation.json](fixtures/d3d-review/stage4k35-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K35.json`。
> - **仍需继续：** 完整公开8 DWORD状态块/对象包装及全部预定义8范围接线，ProcessVertices目标8方言，其余原生兼容性/着色器数值差分/原生HAL/游戏/FPS及阶段4/5/6。recorder只用于已准备快照的可录制转换setter；本阶段没有把普通9预定义范围当作8范围。宿主、协议、translator、DDraw及运行包未改。

> **4K36（2026-11-05，已完成）：ProcessVertices8 目标布局进入共用软件处理管线。**
> - 公开8原有目标FVF子集抽为纯头；8 decoder仅换成调用。核心9保留原验证/输出声明规则，把实际变换、属性复制、ClipStatus与上传主体抽成共用函数，新增私有 `process_vertices8`（stdcall24）选择8目标方言，无临时输出声明。重建旧函数逐字节一致：保留390个8函数/638个9函数，八份共用运行文件未改；普通9仍拒绝没有显式声明的raw8 bit14目标FVF。
> - 原生 **392,170检查 / 364,469用例**：362,144个冻结8布局比较，2,325个实际处理/控制用例；别名、范围、矩阵、零W本地策略、颜色/纹理属性、DONOTCOPYDATA、完整缓冲区与padding、ClipStatus、上传和清理。冻结9、抽取后9及私有8结果逐字节对照；**22严格语义变异、两组ASAN**通过。首次零count变异落在既有拒绝之后，等价变异存活；移到拒绝前形成可达错误后检出。数值用例只覆盖未照明配置，未声称全部照明/HAL一致；上传失败时CPU数据已提交，保持旧9行为。
> - 首次XP **116秒 / 30批 / 一次启动**：准确4K35旧8/当前8/普通9规范化FVF/core8 SDK120/220，五设备/五Reset、10 managed VB、六缓存声明/26协议句柄。source0x4042/destination0x4044、首尾哨兵、索引1/count6、目标stride20；**800 DWORD实际客体CPU顶点结果**核对。四步red/red/green/purple验证DONOTCOPYDATA与managed Reset，20个绑定draw；另1,280 DWORD帧缓冲回复为明确解析注入，独立GPU验证实际图像。
> - 独立wire核对45次更新/5,760字节完整源/目标/padding，45流绑定、格式切换、25拒绝、Reset及资源退休，**8,084项篡改检出**。初始模型遗漏普通9/private9解绑保留stride20，而旧8发0，修正模型后通过，生产/SDK/捕获未改。两GPU各 **20完整图像 / 1,280 RGBA像素零误差**，20非索引绑定draw、0 UP/programmable/纹理/Present，GPU/host错误0，资源表在SessionEnd与owner兜底前为空。
> - **366客体 / 82核心完整回归**、32标准EXE/四严格DLL/21-member静态核心/真实SDK8 stdcall24、两项站点集成、范围lint通过。发布准确XP零售8/9及同源严格diagnostic。证据 [stage4k36-validation.json](fixtures/d3d-review/stage4k36-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K36.json`。宿主/协议/translator/DDraw/运行包未改。
> - **继续项：** 公开8 DWORD状态块所有权、全部预定义范围及对象包装，原生兼容性、完整T&L/着色器数值差分/HAL/游戏/FPS与阶段4/5/6。

> **4K37（2026-11-05，已完成）：核心8 DWORD状态块所有权。**
> - 新增私有create/capture/apply/delete句柄入口（stdcall16/16/8/8），使用4K35同步recorder建立真实9状态块。新增零初始化 `handle8`；普通9块仍是COM对象，8句柄只保留块存储、不保留设备parent pin，设备最终释放时统一清理。token不发协议资源命令；跨设备/配置/零/失效句柄拒绝。原始8范围和Get影子继续由前端管理，尚未接入完整公开8包装。
> - Capture先建立新快照，成功后沿用原DWORD并释放旧块；OOM/回调失败保留旧块。操作临时持有设备和块存储，回调中删除旧token后不得复活。清理先摘掉句柄，再释放资源；清理期间拒绝重入句柄操作，私有数据回调保留设备后允许后续重新创建。源审计：**640个既有9函数逐字节一致**；设备清理仅新增token drain，状态块存储仅新增DWORD和注释，完整公开8/FVF/状态范围/转换策略未改。
> - 原生 **19,161检查 / 1,117用例**：1,024 program/FFP/四种清理顺序、64组八类资源，稳定Capture、失败/现有recording、普通9块共存、公共引用归零/设备先释放/真实跨设备拒绝、32句柄乱序删除及计数碰撞跳过。真实纹理私有数据回调覆盖Apply时删除正在应用的块、销毁时访问另一枚token、设备复活。**25严格编译语义变异、两组ASAN**通过，保留9状态块160,909检查通过。初始变异发现另一枚token在清理回调中的覆盖缺口，补用例；泛化信号与unused-function编译错误均未计入，通过后才计数。
> - 真实SDK编译发现新增声明早于recorder typedef，已调整顺序，保持Windows-only不暴露SDK枚举。首次XP **120秒 / 30批 / 一次启动**：准确4K36旧8/当前8/普通9参考/coreSDK120/220，五设备/五Reset/15声明/35shader/60协议资源句柄，20个programmable UP draw、1,280 DWORD本地帧缓冲核对。私有配置执行新四入口、失败Capture/稳定token/删除后拒绝、遗留空token设备自动清理；旧8/普通9继续用其原API作为图像/元数据参考。
> - 独立wire检查完整布局/字节码/常量/顶点、状态映射和资源退休，**11,753项篡改检出**。两GPU各 **20完整图像 / 1,280 RGBA像素零误差**，35shader translations，0纹理/Present/GPU/host错误，资源表在SessionEnd及owner兜底前为空。CPU帧缓冲回复为明确解析注入；GPU图像独立验证。ZBIAS继续只是本地clamp16×−0.000005近似，PS1.0–1.4仅元数据用例。
> - **368客体 / 83核心完整回归**、32标准EXE/四严格DLL/21-member静态核心/真实SDK8 ABI、两项站点集成/范围lint通过；发布准确XP零售8/9与严格diagnostic。证据 [stage4k37-validation.json](fixtures/d3d-review/stage4k37-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K37.json`。宿主/协议/translator/DDraw/运行包未改。
> - 客体回归为首次全量367项通过，加修正旧变异测试函数边界后补跑一项通过（11/11）；原失败日志与补跑日志均保留，未把匹配不到目标算作运行时变异检出。
> - **继续项：** 将核心能力接入完整公开8对象/状态块包装及全部预定义范围，其他原生兼容性、完整T&L/着色器数值差分/HAL/游戏/FPS与阶段4/5/6。

> **4K38（2026-11-05，已完成）：增量Begin/End录制进入核心8 DWORD句柄。**
> - 私有 `begin_state_block8`（stdcall4）直接调用实际9 Begin，`end_state_block_handle8`（stdcall8）调用实际9 End后发布设备持有的token。与4K37快照创建共用同一个token publisher；只移动原有token分配/碰撞跳过/adopt主体，重建原Create8逐字节一致。End输出先清零；空End/错误配置/清理期间调用拒绝，无效输出不取消正在录制的块。前端继续负责raw8范围/Get影子，公开8设备包装尚待接线。
> - 原生 **79,400检查 / 1,038用例**：1,024组八类资源/两种pool/四种清理顺序，连续记录同一对象与替换对象、实时状态不变、公开引用归零、End后Apply与设备先释放，另14组null/profile/teardown/OOM/现有recording/无效End、与普通9 Begin/End互通、未结束录制的设备清理。**15个新严格语义变异 + 保留25个句柄变异**通过；组合ASAN覆盖新录制、句柄管理与保留9状态块160,909检查。旧变异定位随publisher抽取迁移，未使用helper及缩进编译失败均不计作检出，修正变异表达式后严格编译并由C断言检出。
> - 源审计：**647个既有9函数逐字节一致**；Create8重建与移出的publisher主体完全一致，状态块存储、公开8、8状态映射/范围、FVF与Process布局文件未改。实际9 Begin/End及Capture/Apply/生命周期函数未改。
> - 首次XP **136秒 / 30批 / 一次启动**：准确4K37旧8/当前8/普通9显式录制参考/coreSDK120/220，五设备/五Reset/15声明/35shader/60协议资源句柄。私有配置实际执行Begin、嵌套Begin拒绝、映射setter录制、无效End保留、End生成DWORD，实时red保持不变，Apply变green并在Reset后恢复；保留失败Capture/稳定token/删除后拒绝/遗留空token自动清理。20个programmable UP draw及1,280 DWORD帧缓冲解析回复核对，PS1.0–1.4仅元数据，本地ZBIAS近似范围不变。
> - 独立wire验证全部布局/着色器/常量/顶点/绑定/状态映射/Reset/退休及SDK增量录制日志，**11,756项篡改检出**。两GPU各 **20完整图像 / 1,280 RGBA像素零误差**，35shader translations、0纹理/Present/GPU/host错误，资源表在SessionEnd及owner兜底前为空。CPU帧缓冲回复明确为解析注入，实际GPU图像独立验证。
> - **370客体 / 84核心完整回归**、32标准EXE/四严格DLL/21-member静态核心/真实SDK8 stdcall4/8、两项站点集成和范围lint通过；发布准确XP零售8/9及同源严格diagnostic。证据 [stage4k38-validation.json](fixtures/d3d-review/stage4k38-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K38.json`。宿主/协议/translator/DDraw/运行包未改。
> - **继续项：** 完整公开8对象/状态块包装和全部预定义范围接线，其余原生兼容性、完整T&L/着色器数值差分/HAL/游戏/FPS及阶段4/5/6。

> **4K39（2026-11-05，已完成）：公开8包装对象的弱缓存基础。**
> - 私有 `get_view8`/`attach_view8`（stdcall8/12，retire callback stdcall4）为同一个实际9资源存储保留唯一前端元数据。查询/注册不持有资源或设备公开引用；公开引用归零而核心私有绑定仍保留存储时，缓存仍可复用。仅接受本核心8配置的VB/IB/纹理/cube/volume及其表面/volume视图、独立/隐式表面和附加链；拒绝普通9配置、其他接口、重复注册与隐式链。尚未把这些元数据替换为完整公开8 COM包装。
> - 八条实际销毁路径接入通知，资源私有数据清理后、存储释放前回调一次。回调期间保留retiring记录，拒绝查询/重注册同一正在销毁对象；递归通知不重复调用。回调可使其他对象退出链表，返回后重新定位当前记录，避免使用失效的链表位置。元数据回调释放前端元数据，不释放正在销毁的核心对象。
> - 原生 **112,181检查 / 1,038用例**：1,024组两种pool/四种清理顺序，每组五种父资源、三个缓存子视图、两隐式表面；公共引用归零/Get复活、状态块保留/Reset式清理、真实私有数据回调顺序、重复/OOM/接口/配置guard、嵌套删除链表首项、独立RT，以及附加链类型识别。附加链的实际新通知由SDK/XP验证，原生该项只执行元数据类型路径；不把它标成原生COM销毁覆盖。**35严格语义变异**及组合ASAN通过，ASAN同时覆盖保留9状态块160,909检查和8增量/句柄生命周期。旧volume元数据fixture缺少接口表，已在新用例中补齐；首次变异缺少插入函数的前置声明而编译失败，改用既有COM入口后才计入运行时检出。
> - 源审计：**643个既有9函数逐字节一致**；八个销毁函数去掉通知及相应括号后与原文一致，十种原有存储结构及完整公开8/状态映射/范围/FVF/Process布局未改。零新协议命令；宿主/协议/translator/DDraw/运行包未改。
> - 严格SDK编译先检出测试源for语句缩进，修正后首次实际XP **105秒 / 32批 / 一次启动**。准确4K38旧8/当前8/普通9/coreSDK120/220五渲染配置，另加SDK120/220两个生命周期设备：共 **七设备/七Reset/80协议资源句柄**。每新增配置14个缓存，**28销毁回调**验证父子顺序、raw资源/缓存同一性、公开零计数复活、RT/附加链/隐式视图及最终设备释放；另 **32 DWORD实际CPU影子**核对。SDK最终PASS行的五设备字段只统计保留渲染配置，两条独立生命周期日志单独统计新增设备。
> - 独立wire先逐项验证原始捕获，再将五渲染配置的完整命令前缀交给既有4K38模型，另用独立顺序/资源状态机消费全部新增生命周期命令，核对80句柄、七Reset、六常量库清零、绑定/退休及28回调日志。**16,339项篡改检出**。两GPU各 **20完整图像 / 1,280 RGBA像素零误差**，10纹理/2cube/2volume/4RT、35shader translations、0纹理上传/Present/GPU/host错误，设备/资源表在SessionEnd及owner兜底前为空。首次回放未提供第二画布，swapChainsRefused=2；补齐真实canvas后重跑，两GPU均swapChainsCreated=2/refused=0/destroyed=2，不把初始拒绝计作最终通过。
> - **372客体 / 85核心完整回归**、32标准EXE/四严格DLL/21-member静态核心/真实SDK8 ABI、两项站点集成/范围lint通过；发布准确XP零售8/9及同源严格diagnostic。证据 [stage4k39-validation.json](fixtures/d3d-review/stage4k39-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K39.json`。CPU帧缓冲回复仍明确解析注入，与新增实际CPU影子检查、GPU图像分开。
> - **继续项：** 接入完整公开8设备/资源/状态块COM包装和全部预定义范围，其他原生兼容性、完整T&L/着色器数值差分/HAL/游戏/FPS及阶段4/5/6。

> **4K40（2026-11-05，已完成）：真实IDirect3DSurface8接口包装核心9表面。**
> - 新增SDK8独立编译的 `d3d8_core_surface.c/.h`，实现真实11方法表；通过Windows-only类型边界取得现有核心9私有数据/八字描述/锁定/解锁方法，新增lock输出指针薄适配。包装接入4K39弱缓存，返回同一前端接口。纹理/cube层级沿用前端容器引用计数，独立/隐式/RT/附加backbuffer使用自己的计数；零→非零时仅保留一个核心表面引用和前端设备引用。释放可能立即触发弱缓存回调销毁包装，因此先保存后续所需指针。GetDevice/GetContainer返回前端对象。
> - 私有wrap入口在全部返回路径消费传入的一份已持有核心引用，成功时折叠到包装/容器已有引用；失败输出NULL、OOM与并发发布失败清理候选对象，重新读取竞争获胜的缓存对象，并检查类型/设备/容器/计数策略。缓存命中不分配，内存不足时仍可复用；保留现有8 QI政策（IUnknown/Resource8/Surface8），未宣称该历史政策已经过原生HAL验证。
> - 原生执行实际适配器C/11方法表，后端是明确的COM/元数据shim：**54,571检查 / 1,037用例**，1,024组自身/容器计数、四种释放顺序、public-zero复活、竞争发布、所有权输入消费、失败HRESULT、16字节GUID逐项拒绝、缓存类型/父对象不匹配及完整清理；**34严格语义变异与ASAN**通过。初始fixture缺少FAILED宏且void*未显式转IUnknown，严格编译检出后补齐fixture，未放宽警告。
> - 所有 **656个既有9函数、十种存储结构、完整旧8源与共用策略/运行文件逐字节一致**；8构建只增加新适配器源文件，公开DLL仍只有原四个导出。普通8设备工厂尚未切换到新资源包装；设备/容器父接口在SDK夹具中明确只实现IUnknown引用规则，不能据此声称完整Device8/Texture8/Cube8适配完成。
> - 首次实际XP **125秒 / 36批 / 一次启动**：准确4K39旧8/当前8/普通9/coreSDK120/220五保留渲染配置，加SDK120/220两组新适配器：共 **七设备/七Reset/76协议句柄/17声明/35shader**。真实SDK8客户端在CPU表面、texture/cube层级、隐式back/depth、RT与附加backbuffer共 **14个Surface8接口**上覆盖适用方法、八字描述Size/容器/设备/QI/private MoreData/Delete、Lock双重调用/只读/行跨度、public-zero及Reset后缓存同一性；**128 DWORD实际CPU影子**核对。七种表面不等于每种都支持全部锁定标志。
> - Surface8 texture层级Lock/Unlock将red/blue完整上传到实际核心9，SDK9固定管线参考绘制出 **4张新增图像**；保留20个可编程图像，合计 **24完整图像 / 1,536 RGBA像素**，两GPU均零误差。cube绿色核对CPU与完整上传，不在本探针中采样。独立wire核对6次纹理上传/384字节、168字节顶点/三元素布局、Reset保留和全部退休，**17,108项篡改检出**。8纹理/2cube、0volume、35shader translations、2交换链创建/0拒绝/2销毁、0 Present/GPU/host错误；资源表在SessionEnd及owner兜底前为空。帧缓冲CPU回复明确为解析注入，与实际CPU影子、GPU图像区分。
> - **374客体 / 86核心完整回归**、32标准EXE/四严格DLL/21-member静态核心/真实SDK8边界与stdcall20包装入口、两项站点集成/范围lint通过；发布准确XP零售8/9及同源diagnostic。证据 [stage4k40-validation.json](fixtures/d3d-review/stage4k40-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K40.json`。宿主/协议/translator/DDraw/运行包未改。
> - **继续项：** 接入真实Texture8/Cube8/Volume8/VB/IB/SwapChain8及Device8父对象、全部状态块范围和默认工厂，再完成其他原生兼容性、完整T&L/着色器数值差分/HAL/游戏/FPS与阶段4/5/6。

> **4K41（2026-11-05，已完成）：真实Texture8接口与Surface8容器组合。**
> - 新增 `d3d8_core_texture.c/.h`，实现SDK8真实19方法表；通过15方法的类型化核心9边界复用私有数据、priority/LOD、描述、锁定、dirty rect。GetSurfaceLevel返回真实Surface8，GetContainer回到真实Texture8，两个接口共享核心锁定状态、容器计数与弱缓存。GUID/自身引用计数抽到共用头；表面/纹理八字描述共用原有打包逻辑，纹理描述不创建临时Surface。
> - 原生执行两种实际适配器，后端明确为COM/元数据shim：**54,048检查 / 1,036用例、43严格语义变异与ASAN**通过；保留Surface8 **54,571检查 / 1,037用例、34变异与ASAN**及描述/31项image-depth变异。错误mip变异起初存活，补充独立的子表面尺寸/Size断言后检出。新文件名曾与4K22重名，七个旧文件已从HEAD准确恢复，新探针统一使用 `frontend_texture`；静态ABI测试的重复生成声明也已由严格编译检出并修正。
> - **657个既有核心9函数、十种存储结构、完整旧8源与共用运行策略保持一致**。既有surface_desc8通过内联共用描述函数、恢复局部变量声明可逐字节重建；Surface8除三个共用辅助入口外其余函数保持一致。8构建仅增加Texture8源。默认公开工厂尚未切换，完整Device8/Cube8等仍待接入。
> - 首次实际XP **106秒 / 36批 / 一次启动**（此前一次SDK编译失败，未进入VM）：准确4K40旧8/当前8/普通9/coreSDK120/220五配置，加两组实际Texture8客户端，共 **七设备/七Reset/76句柄/17声明/35shader**。**2个真实Texture8与16个Surface8**覆盖四层mip（8/4/2/1）、四种QI、私有数据/priority/LOD/PreLoad/描述/dirty、跨接口锁定互斥、public-zero复活、Reset后同一性和最终引用0；核对 **352 DWORD实际CPU影子**。Device8与Cube8父接口仍明确为IUnknown引用夹具。
> - **24张完整图像 / 1,536像素，SwiftShader与Metal均零误差**；20个保留可编程图像加实际Texture8/Surface8写入产生的4个red/blue固定管线图像。mip1/cube绿色核对CPU与完整上传，不宣称本探针采样。独立wire验证LOD 3→0、8次上传/1,280字节、全部退休，**18,046项篡改检出**；2交换链创建/0拒绝/2销毁、0 Present/GPU/host错误，资源在SessionEnd及owner兜底前为空。帧缓冲CPU回复明确为解析注入。
> - **376客体 / 87核心回归**、32标准EXE/四严格DLL/21成员静态核心/实际SDK8接口边界/两项站点集成/范围lint通过；发布准确XP零售8/9及同源diagnostic。证据 [stage4k41-validation.json](fixtures/d3d-review/stage4k41-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K41.json`。继续Cube8/Volume8/VB/IB/SwapChain8/Device8、状态块范围和默认工厂，以及原生兼容性、完整T&L/着色器数值差分/HAL/游戏/FPS与阶段4/5/6。

> **4K42（2026-11-05，已完成）：真实CubeTexture8六面与Surface8容器。**
> - 新增 `d3d8_core_cube_texture.c/.h`，SDK8真实19方法表通过15方法类型化核心9边界转发；六面/各mip的GetCubeMapSurface返回真实Surface8，容器是实际CubeTexture8，复用共用引用计数、弱缓存、八字描述与核心锁定状态。拥有的输入引用在所有构造返回路径均消费，缓存命中无分配，失败/竞争/OOM不泄漏。
> - 原生 **61,952检查 / 1,164用例**，其中1,152组六面×三个mip×四种释放顺序，检查子表面实际后端地址/尺寸、容器计数、public-zero复活、父对象/设备先释放、所有权消费与失败路径；**47严格语义变异与ASAN**通过，包含Get/Lock/Unlock/Dirty丢失face参数的变异。后端明确为COM/元数据shim；保留Texture8 **54,048检查/43变异**与Surface8 **54,571检查/34变异**通过。
> - **663个既有核心9函数、十种存储结构、完整旧8、现有Surface8/Texture8/共用辅助头和运行策略逐字节一致**；8构建只增加Cube适配器。初始生成头文件类型名/borrowed getter命名问题被严格编译检出并修正；SDK探针同一行两条if触发缩进警告，拆行后继续，未放宽警告。
> - 首次实际XP **128秒 / 52批 / 一次启动**：保留4K41七设备，再加SDK120/220实际CubeTexture8两设备，共 **九设备/九Reset/84句柄/19声明/35shader**。每个新设备检查全部六面×四mip的24个实际Surface8、四种QI、private/priority/LOD/type/PreLoad/描述、无效face/level/out、跨接口同面锁定互斥/不同面同时锁定、public-zero缓存复活与Reset后同一性。新增 **928 DWORD实际CPU影子**，合计1,280 DWORD；新设备的Device8父接口仍为明确的IUnknown夹具。
> - 六面分别写入六种颜色并用三维方向采样，Reset后face0改白；**14张新增固定管线图像 + 24张保留图像 = 38完整图像 / 2,432像素**，SwiftShader与Metal均零误差。face5/mip1绿色核对CPU/上传；本探针不宣称采样该mip。独立wire **27,582项篡改检出**，核对24次上传/4,992字节；10纹理/4cube/0volume、20可编程+18固定管线draw、2交换链创建/0拒绝/2销毁、0 Present/GPU/host错误，资源在兜底前为空。帧缓冲CPU回复为解析注入，与实际CPU影子及真实GPU图像区分。Cube AddDirtyRect沿用核心现有no-op政策，尚未宣称原生HAL一致。
> - **378客体 / 88核心回归**、32标准EXE/四严格DLL/21成员静态核心/SDK8边界、两项站点集成/范围lint通过；发布准确XP零售8/9和同源diagnostic。证据 [stage4k42-validation.json](fixtures/d3d-review/stage4k42-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K42.json`。继续Volume8/VolumeTexture8/VB/IB/SwapChain8/Device8、状态块范围与默认工厂，再完成其余原生兼容性、完整T&L/着色器数值差分/HAL/游戏/FPS及阶段4/5/6。

> **4K43（2026-11-05，已完成）：真实VolumeTexture8与Volume8层级容器。**
> - 新增 `d3d8_core_volume_texture.c/.h`（19方法）及 `d3d8_core_volume.c/.h`（11方法）。Volume8的容器/引用拥有者为实际VolumeTexture8；两种接口共用核心三维锁定、私有数据、弱缓存和存储退休。Volume8沿用既有IUnknown/Volume8查询政策，不接受Resource8。15/6方法的类型化边界使用中立盒/输出指针，SDK转换只在核心9实现内完成。
> - **669个既有核心9函数、十种存储结构及九个完整旧8/运行策略/Surface8/Texture8/Cube8/共用文件保持一致**；volume_desc8的原有打包逻辑抽为共用函数，内联并恢复局部声明可逐字节重建旧函数，纹理层级描述不再需要临时Volume对象。8构建仅增加两份适配器源，公开默认工厂尚未切换。
> - 原生 **66,667检查 / 790用例**，768组三个三维mip×四种释放顺序及构造/缓存/竞争/OOM/输入引用消费、实际子对象地址、GUID/方法参数/HRESULT、容器与设备同一性检查；后端明确为COM/元数据shim。**42项纹理适配器 + 28项Volume8变异、ASAN**通过；输出清空变异起初因输入已经NULL而存活，改为非空哨兵后检出。保留体积描述 **79,297检查 / 26,433用例**及33项核心体积变异通过。
> - 独立消费者最初检出了核心头对SDK盒类型的依赖，改成中立边界后严格独立/SDK8编译均通过。首次XP因测试消费者缺少体积创建导出失败；补齐后第二次129秒/64批通过，但不作为最终证据。最终中立边界重新独立捕获 **136秒 / 64批，第三次运行**：共 **十一设备/十一Reset/92句柄/21声明/35shader**。每个新设备覆盖四层三维mip（8×4×4、4×2×2、2×1×1、1×1×1）、真实Volume8容器与QI/private/设备/Size、行/片跨度、同层跨接口互斥与不同层同时锁定、priority/LOD/PreLoad/type/dirty/public-zero复活、Reset同一性及最终引用0；新增544 DWORD实际CPU影子，累计 **1,824 DWORD**。新Device8父接口仍明确为IUnknown夹具。
> - 四个深度切片分别采样red/green/blue/yellow，Reset后改白，新增10图像；累计 **48完整图像 / 3,072像素**，SwiftShader与Metal均零误差。mip1 magenta核对CPU/上传，本探针未采样该mip。独立wire **35317项篡改检出**，核对44次逐片上传/7,168字节；12纹理/4cube/2volume、20可编程+28固定管线draw、35shader translations、2交换链创建/0拒绝/2销毁，0 Present/GPU/host错误，资源在兜底前为空。CPU帧缓冲回复明确为解析注入，区别于实际CPU影子与GPU图像。AddDirtyBox沿用核心现有no-op政策，原生HAL一致性仍待验证。
> - **381客体 / 89核心最终回归**、32标准EXE/四严格DLL/21成员核心/独立消费者及SDK8边界、两项站点集成/范围lint通过；发布准确最终XP零售8/9及同源diagnostic。证据 [stage4k43-validation.json](fixtures/d3d-review/stage4k43-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K43.json`。继续VB/IB/SwapChain8/Device8、状态块范围与默认工厂，及其余原生兼容性、完整T&L/着色器数值差分/HAL/游戏/FPS与阶段4/5/6。

> **4K44（2026-11-05，已完成）：VB8/IB8真实接口，共用一份前端实现。**
> - 新增 `d3d8_core_buffer.c/.h`，为VB8和IB8生成各自真实14方法表，共用QI、构造、弱缓存、引用计数和转发逻辑。核心提供SDK中立10方法表及对象/预期类型选择器；复用现有9的private/priority/PreLoad/type/Lock/Unlock/GetDesc，24字节VB及20字节IB描述直接沿用一致布局，SDK差异只在薄边界转换。输入引用在所有构造路径消费，public-zero复活/缓存命中不重复分配或增加核心持有。
> - **678个既有核心9函数、十种存储结构、十一份完整旧8/运行策略/已有资源适配器文件逐字节一致**；8构建只增加一份缓冲区适配器源，公开默认工厂尚未切换。两个资源类没有再复制构造和生命周期政策。
> - 原生 **24,373检查 / 536用例**，512组双资源类×四种释放顺序及全部GUID字节、IUnknown/Resource8/具体类/设备同一性、方法参数/HRESULT、描述、弱缓存/public-zero、输入消费/OOM/竞争/父对象先释放；后端明确为COM/元数据shim。**36严格语义变异与ASAN**通过。首次严格编译检出SDK IUnknownVtbl的const差异；首次原生夹具错误提供了NULL方法表却要求消费其COM引用，修正为有效的外部IUnknown方法表。变异定位和unused参数编译失败均修正后重跑，编译失败/普通信号未计作检出。
> - 首次实际XP **125秒 / 74批 / 一次运行**：保留4K43十一设备，新增SDK120/220两设备，共 **十三设备/十三Reset/104句柄/23声明/35shader**。真实SDK8核对 **2个VB8、4个IB8** 的14方法、24/20字节描述、raw FVF 0x44、private/priority/PreLoad/type/QI/前端设备、零长度整段锁定/只读/双锁拒绝/错误输出原子性、16/32位索引数据、public-zero缓存复活、Reset与最终引用0；新增138 DWORD，累计 **1,962 DWORD实际CPU影子**。新Device8父接口仍为IUnknown夹具。
> - 实际SDK8写入由SDK9参考绘制消费：新增2次普通绑定绘制及6次索引绘制（含Reset后blue），累计 **56完整图像 / 3,584像素**，SwiftShader与Metal均零误差。独立wire核对8次buffer上传/552字节、全部顶点和两种索引字节，**40,748项篡改检出**。共48 UP、2次普通绑定、6次索引draw；宿主计数drawCalls=50记录非索引，另indexedDrawCalls=6。保留44次纹理上传/7,168字节、12纹理/4cube/2volume、35shader translations、2交换链创建/0拒绝/2销毁、0 Present/GPU/host错误，资源在兜底前为空。CPU帧缓冲回复明确为解析注入。参考绘制的9 NULL stream保留stride20，不据此声称Device8 SetStream政策已实现。
> - **383客体 / 90核心完整回归**、32标准EXE/四严格DLL/21成员核心/独立消费者与SDK8边界、两项站点集成/范围lint通过；发布准确XP零售8/9和同源diagnostic。证据 [stage4k44-validation.json](fixtures/d3d-review/stage4k44-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K44.json`。继续SwapChain8/Device8、状态块范围与默认工厂，及其余原生兼容性、完整T&L/着色器数值差分/HAL/游戏/FPS与阶段4/5/6。

> **4K45（2026-11-05，已完成）：SwapChain8真实接口与独立back-buffer引用。**
> - 新增 `d3d8_core_swap_chain.c/.h`，实现SDK8真实5方法表；2方法的SDK中立核心边界仅处理Present补flags=0及back-buffer类型转换。只接受实际8配置的附加交换链；返回现有真实Surface8，使用独立引用和前端Device8容器。无效索引/核心getter失败保留调用者原输出；成功getter才进入消费已持有引用的Surface8包装。弱缓存随实际链/表面存储退休，链public-zero且表面仍存活时可复用同一接口。
> - 删除新增桥接块后，**完整既有核心9源与头逐字节重建一致**，包括679个可提取源函数、全部宏与存储结构；十二份旧8/运行策略/现有资源适配器完整文件一致，8构建只增加新适配器源。默认公开工厂仍待切换。Present裁剪/dirty区域沿用既有核心政策，本阶段未宣称原生裁剪语义已补齐。
> - 原生 **8,482检查 / 269用例**，256组四种清理顺序，检查QI全部GUID字节、Present四参数/HRESULT、GetBackBuffer错误输出原子性、真实Surface8容器/独立引用、public-zero复活、表面public/private持有延迟链存储销毁，以及输入消费/OOM/缓存命中/竞争/类型/设备/隐式链拒绝；后端明确为COM/元数据shim。**28严格语义变异与ASAN**通过，已有资源适配器和Surface8检查均保留通过。
> - 首次实际XP探针漏算了renderable表面每次成功Lock的GPU读回，CPU比较失败。补齐锁定前/只读/Present后读回，并把独立CPU检查移到上传前；最终第二次XP **133秒 / 92批**，共 **十五设备/十五Reset/116句柄/23声明/35shader**。两组新SDK120/220客户端覆盖真实SwapChain8及Surface8、Device8容器、独立计数、无效索引保留输出、忽略立体类型、52字节输入不改写、链public-zero/表面仍有效/复活同一性、释放后Reset和最终引用0。新Device8父接口仍明确为IUnknown夹具。
> - 新增 **64 DWORD上传前CPU影子检查**，累计2,026 DWORD；只读锁定的另64 DWORD消费了解析GPU回复，单独作为读回集成检查。新增12次4×4完整读回，加保留56次，合计 **68完整图像 / 3,776像素**，SwiftShader与Metal均零误差，涵盖锁定前局部初始零值/上一颜色、只读及Present后red/blue。**4次附加Present在真实附加GPU上下文执行、0丢弃**；未单独读回canvas输出像素。初始零值为本地WebGPU政策，未宣称原生HAL初始化内容有保证。
> - 独立wire **45686项篡改检出**，核对48次纹理上传/7,424字节、4次临时纹理StretchRect、18纹理/6RT/4cube/2volume、4交换链创建/0拒绝/4销毁；保留56次draw、0主Present/GPU/host错误，资源在兜底前为空。**385客体 / 91核心回归**、32标准EXE/四严格DLL/21成员核心/独立消费者及SDK8边界、两项站点集成/范围lint通过，发布准确最终XP零售8/9与同源diagnostic。证据 [stage4k45-validation.json](fixtures/d3d-review/stage4k45-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K45.json`。继续Device8弱元数据生命周期、完整前端/状态块范围/默认工厂及其余原生兼容性、完整T&L/着色器数值差分/HAL/游戏/FPS和阶段4/5/6。

> **4K46（2026-11-05，已完成）：设备前端弱元数据与最后退休顺序。**
> - 既有弱视图注册表开始接受实际8配置的Device9，不增加COM引用或设备父引用。设备元数据的退休位于两份隐式表面元数据之后、设备存储释放之前，父工厂保持有效直到全部元数据回调完成；用户私有数据的析构回调仍先在既有核心临时引用保护下运行，允许重新持有设备。退休回调只清理元数据，不得重新持有已经提交销毁的存储。
> - 生产改动限于识别设备及最终退休两个函数；删除两处改动后，完整旧核心9源码逐字节重建一致，682个可提取源函数中680个完全不变，全部宏与存储结构不变；核心头只增加契约注释，十五份旧8/运行策略/资源适配器/构建文件完整一致。无新ABI或默认工厂切换。
> - 原生 **7,560检查 / 772用例**，覆盖768组逻辑引用归零/后端持有、隐式表面公开持有、绑定私有存储及三种私有数据析构模式；验证瞬时及保留的设备复活、子表面先退休、设备最后退休、退休期间墓碑查询/递归拒绝、无额外公开引用和普通9/类型/OOM/重复注册边界。**10严格语义变异与ASAN**通过；保留弱资源视图112,181检查/35变异及既有资源适配器回归通过。首轮变异存在可移植类型编译问题，修正后仅把成功编译且实际C断言失败计入通过。
> - 首轮SDK编译缺少全局不透明9类型前置声明，修正独立编译单元的头文件后，首次实际XP曾在156秒通过；随后源码核对发现父工厂过早释放可能让退休回调访问已释放内存，将其释放移到所有元数据回调之后，补充精确恢复旧顺序的负控制。最终第二次实际XP **192秒 / 96批** 通过，同一VM内三次RAM启动尝试。累计 **十九设备/十九Reset/124句柄/23声明/35shader**；新增SDK120/220各两组设备，检查前端逻辑零值时后端显式引用仍存活、Reset身份、私有数据析构中的瞬时/保留重新持有、八份隐式表面元数据和十二次有序退休回调，最终引用0。
> - 新设备前端明确为 **IUnknown三方法夹具**，隐式表面只注册元数据；没有宣称完整Device8接口已接通。本阶段不新增绘制，完整保留先前真实资源适配器的 **68图像 / 3,776像素**，SwiftShader与Metal均零误差；2,026 DWORD独立上传前CPU检查、4附加Present/0丢弃、48纹理上传/7,424字节、56逻辑draw及最终清理继续通过。XP读回使用明确解析回复，实际GPU像素由独立重放验证；附加canvas输出未另行读回。
> - 独立wire **54257项篡改检出**；初次核心并行回归的该夹具超出500秒时限，未计通过，缓存指令名查找并以1800秒单项时限重跑。**387客体 / 92核心回归**、32标准EXE/四严格DLL/21成员静态核心/独立消费者及SDK8边界、两项站点集成和范围lint通过。准确最终XP零售8/9及同源diagnostic已发布。证据 [stage4k46-validation.json](fixtures/d3d-review/stage4k46-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K46.json`。继续原始8着色器私有存储持有、设备清理边界、完整前端/状态块范围/默认工厂及其余原生兼容性、完整T&L/着色器数值差分/HAL/游戏/FPS和阶段4/5/6。

> **4K47（2026-11-05，已完成）：原始8着色器元数据持有真实9私有存储。**
> - 新增两个SDK中立的私有 `@8` 存储retain/release入口，识别实际8配置设备上的声明/VS/PS，复用既有binding引用机制。入口借用参数、只改变私有存储引用；前端在成功持有后单独释放构造时的公开COM引用，并在设备元数据退休回调内释放所有存储持有，此时核心设备与父工厂仍有效。调用者负责保持参数有效并成对归还自己的持有；普通9、类型/设备不符、NULL及私有计数为零的释放被拒绝。
> - 删除新增桥接块后，完整既有核心9源码与头逐字节重建一致，**682个既有源函数、全部宏和存储结构不变**；新增3个源函数，十七份旧8/运行策略/现有资源适配器/私有数据核心/构建文件完整一致。无新设备字段、公开引用、父引用、分配或持有操作的传输命令。
> - 原生 **10,008检查 / 525用例**，512组无绑定/实时绑定/捕获状态块/私有数据析构重新持有设备，检查声明与VS/PS公开归零、私有克隆、getter公开复活、无设备父引用环、最终回调内有序销毁与设备/父工厂有效；**17严格语义变异及ASAN**通过。原生后端明确为COM/元数据shim，保留此前全部资源/状态块/弱元数据检查。首轮SDK严格编译检出不同接口表指针直接比较，修正为共同的不透明表地址后编译通过，未放宽编译选项。
> - 首次实际XP **130秒 / 97批**，累计 **十九设备/十九Reset/136句柄/27声明/43shader**。新增4声明、4VS、4PS共十二个真实核心对象，由SDK120/220各两份设备元数据上下文持有；检查公开引用归零后的克隆、getter身份、声明/函数完整字节与GetDevice、Reset后存储身份、用户私有数据析构中瞬时/保留的设备复活、最终引用0。独立wire严格验证 **十二次资源销毁位于对应DeviceDestroy之后、SESSION_END之前**；实际GPU会话结束前资源表已空，无兜底清理遗漏。
> - 前端仍明确为 **IUnknown设备夹具和着色器句柄元数据持有夹具**，并未宣称完整Device8接口或实际原始DWORD句柄表已经接通。本阶段无新增绘制/CPU影子写入，保留 **68完整图像 / 3,776像素**，SwiftShader与Metal均零误差；43次shader翻译、2,026 DWORD独立上传前CPU检查、56逻辑draw（50非索引+6索引）、4附加Present/0丢弃、48纹理上传/7,424字节均通过。XP解析读回回复与独立真实GPU验证区分记录，附加canvas输出像素未单独读取。
> - 全量客体回归还发现既有GUID冲突变异依赖线程交错、偶尔漏检；新增16组按GUID每个字节变化的确定性共存查询，并收紧旧变异只接受实际C断言失败。独立30私有数据用例/8,000并发迭代、19严格变异及内存检查通过，之后重跑完整客体回归。
> - **9,125项篡改检出**覆盖全部新增shader/Reset所选字段和载荷DWORD，保留前缀按指令族抽样；既有完整冻结夹具在回归中单独执行。**389客体 / 93核心回归**、32标准EXE/四严格DLL/21成员静态核心、两个新增stdcall及SDK8独立边界、两项站点集成和范围lint通过。发布准确接受的XP零售8/9与同源diagnostic。证据 [stage4k47-validation.json](fixtures/d3d-review/stage4k47-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K47.json`。继续设备所属状态清理观察边界、真实Device8/原始状态块范围/默认工厂，以及原生兼容性、完整T&L/着色器数值差分/HAL/游戏/FPS和阶段4/5/6。

> **4K48（2026-11-05，已完成）：设备所属状态清理观察边界。**
> - 新增可选设备弱视图清理回调 `attach_device_view8@16`，在核心取消录制、清理设备所属状态块/实时绑定/FVF缓存之前通知前端CPU元数据，回调在自身传输锁范围外、核心临时设备引用保护下执行；最终退休仍走既有回调。新增 `release_owned8@4` 供前端在实际公共子资源仍存活时调用同一处核心清理。拒绝重入；回调若释放其他全部设备引用，最后的临时引用归还可以触发最终清理，因此通知允许重复，前端必须幂等，入口最后归还临时引用之后不再访问设备。
> - 普通弱视图附加接口保持原签名，通过共用实现存入空清理回调；可选字段只加在弱注册表元数据，未增加设备或资源存储字段。完整旧核心源码/头可按明确桥接删除与两处重建逐字节还原：**685个既有源函数中683个不变**，修改普通attach委托和所属状态清理通知两处，新增4个函数；十七份旧8/运行策略/私有数据核心/资源适配器/构建文件完全一致。保留35个弱资源/10个弱设备变异，定位随共用attach实现迁移，未删减控制。
> - 原生 **8,468检查 / 521用例**，512组显式/自动清理、录制与状态块/实时绑定/FVF缓存清理前通知、锁外回调、临时保护、嵌套拒绝、幂等重复通知、公开子资源持有、用户析构释放其他全部引用或重新持有设备；加普通9/类型/NULL/OOM/重复附加等边界。**19严格语义变异和ASAN**通过。首轮测试对既有FVF缓存函数的调用参数错误、一次变异匹配包含额外换行，均先被检查拒绝并修正，未把编译/定位失败计为变异通过。
> - 首次实际XP **117秒 / 97批**，十九设备/十九Reset/**140句柄/27声明/43shader**。四份SDK120/220设备上下文各持有一个真实公开VB子对象时显式清理；观察回调读取仍存活的绑定、清除一次CPU快照夹具、拒绝递归入口，之后实际增量录制取消、原生DWORD状态块失效、绑定为空；子对象GetDevice仍有效，释放后Reset不发清理通知。最终瞬时/保留设备复活路径合计 **10次清理通知 / 4次显式清理**，最终引用0。
> - 此处前端明确为 **IUnknown设备和CPU原始快照夹具**，真实Device8最后直接公开引用的调用连接与原始表/状态块范围仍待完整前端。保留12个实际shader/声明私有持有和DeviceDestroy之后/SESSION_END之前的退休销毁，**68完整图像 / 3,776像素**在SwiftShader与Metal均零误差，会话结束前设备/资源均为空。仅新增4次VB创建与销毁共8条协议命令，合计1,221命令；未新增绘制、上传或CPU影子写入。43shader翻译、56逻辑draw、4附加Present/0丢弃、48纹理上传/7,424字节和2,026 DWORD上传前CPU检查继续通过；XP解析读回回复与实际GPU证据区分，附加canvas输出未单独读回。
> - **9,205项篡改检出**覆盖新增清理日志、buffer/shader/Reset所选字段与载荷，保留前缀抽样并单独运行既有完整夹具。**391客体 / 94核心回归**、32标准EXE/四严格DLL/21成员静态核心、两个新增stdcall及SDK8独立边界、两项站点集成和范围lint通过。发布准确接受的XP零售8/9及同源diagnostic。证据 [stage4k48-validation.json](fixtures/d3d-review/stage4k48-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K48.json`。继续真实Device8、子资源前端引用、原始着色器/状态块元数据和默认工厂，以及其余原生兼容性、完整T&L/着色器数值差分/HAL/游戏/FPS和阶段4/5/6。

> **4K49（2026-11-05，已完成）：57项设备后端方法表与常量字节语义。**
> - 新增SDK无关的 `D9WGDeviceMethods8` 私有57项方法表及 `device_methods8@4` 选择器，严格类型调用已有核心9设备实现；额外交换链/目标索引固定0、流偏移固定0，SDK8结构体仅在SDK9实现内转换。选择器只接受真实8兼容设备；该表不持有公开设备引用。8的128MiB显存查询、VS96/PS8常量范围和零数量调用政策在薄适配处处理。8的PURE创建提示继续允许状态查询，普通9的256MiB、256/224范围、零数量拒绝与PURE查询拒绝保持既有行为。
> - 实测前发现共用float4 setter用浮点相等比较会合并正负零，重复NaN也无法去重；改为比较和复制16字节对象表示，保留sNaN/qNaN负载、Inf和次正规数。原生 **56,505检查 / 5,686用例**覆盖五项策略适配与真实常量方法、每个字节、符号零翻转、重复抑制、录制隔离和已提交传输失败；**25严格编译后实际C断言变异、ASAN**及既有录制检查通过。完整57项函数调用另外由真实SDK/XP验证，未把原生缩减环境当成全部设备实现。
> - 完整旧核心源码/头按桥接删除和两处函数重建可逐字节还原：**689个既有源函数中687个不变**，仅PURE判定与float setter改变；新增57个薄方法、选择器和字节比较共59个函数。所有设备/资源/弱注册表存储布局不变，十七份旧8、运行策略、私有数据、真实资源适配器和构建文件一致。
> - 接受的第三次实际XP运行 **131秒 / 106批**，**21设备 / 21 Reset / 152句柄 / 27声明 / 43shader**。SDK120/220各普通与PURE提示两份上下文覆盖所有57槽、结构体逐字节查询、资源身份/引用、常量原始位值和范围；新增两份普通9设备作反例。首次编译被严格缩进检查拒绝并修正；前两次VM分别发现探针对未绑定深度查询状态、零stride绘制的预期错误，按现有实现改为NOTFOUND/空输出及零数量非零stride成功、零stride拒绝后重跑，失败记录保留。未放宽编译检查。
> - 新增四份1×1纹理与IB、四次主Present和8×8清除/读回；Reset逐字节保留并重发VS95/PS7及gamma，旧夹具委托前先验证原始新增命令，再重排被过滤命令的偏移与序号。**72完整图像 / 4,032像素**在SwiftShader/Metal均零误差；主Present4、附加Present4、0丢弃，会话结束前设备/资源为空。总命令1,401，比48增加180；仍为56逻辑draw、48上传/7,424字节、2,026个上传前CPU DWORD检查，新增只读回复不冒充独立CPU影子证据。canvas输出未单独读回。
> - **23,849项篡改检出**覆盖新增结构体/常量/gamma/palette/资源/呈现/普通9边界及SDK摘要，保留前缀抽样并独立运行旧完整夹具。**393客体 / 95核心回归**、32标准EXE、四严格DLL、21成员静态核心与SDK8独立方法表布局、两项站点集成及范围lint通过。发布准确接受的XP零售8/9与同源diagnostic。证据 [stage4k49-validation.json](fixtures/d3d-review/stage4k49-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K49.json`。
> - 本阶段是 **有类型的后端设备分发表**；设备前端仍为IUnknown/CPU元数据夹具，尚未接通完整97方法Device8、成对RT政策、真实子资源前端引用、原始shader/stateblock元数据与默认工厂。继续这些内容，以及原生兼容性、完整T&L/着色器数值差分/HAL/游戏/FPS和阶段4/5/6。

> **4K50（2026-11-05，已完成）：成对目标绑定与真实表面所属关系。**
> - 新增私有 `set_render_target8@12`，先验证颜色/深度的真实类型、所属设备、用途、默认池、尺寸和采样类型，再修改任何状态；NULL颜色保留现有颜色目标及viewport，NULL深度解除深度绑定。两个CPU绑定先于首条传输提交，随后按颜色→深度→实时viewport发送；失败保留已提交状态，匹配viewport不重复发送，录制期间的目标副作用仍更新实时viewport。私有颜色/深度存储替换和实时viewport发布抽成三处共用实现，普通9的既有校验、发送顺序与录制行为保留。
> - 新增借用型 `surface_owner8@12`：纹理子表面返回纹理、cube子表面返回cube，独立RT/隐式或交换链表面返回设备；不加引用，调用方须保持表面公共引用。真实Surface8新增 `surface_backend8@4`，仅接受自身vtable，借用实际9表面。为随后完整Device8按真实容器恢复前端视图提供基础；没有把底层独立RT存储纹理误作公开容器。
> - 原生 **36,400检查 / 4,135用例**覆盖四类颜色表面、NULL颜色/深度、预校验原子性、尺寸/采样/类型/设备、同对象仅剩绑定引用重绑、每个传输失败位置、录制/实时viewport和容器种类；**25项严格C变异与ASAN**通过。真实Surface8适配器 **55,595检查 / 1,037用例**及新增选择器**4项严格C变异、ASAN**通过；保留23项绑定、8项所属设备、10项标量录制变异。初次原生探针接口指针类型错误、一次用途负例被另一条规则同时拒绝、两项变异因未使用变量被编译器拒绝，均先修正再验收，未计为成功变异。
> - 完整旧核心源码/头和Surface8源码/头均能逐字节还原：**748个既有核心源函数中745个不变**，只改三处共用委托，新增5个核心函数和1个前端选择器；所有设备/资源/弱注册表布局不变，十六份其余旧前端/运行策略/构建文件完全一致。Windows-only头的新增IUnknown声明使用既有opaque struct形式，独立SDK8/无D3D头消费者及21成员静态核心通过。
> - 接受的第三次实际XP运行 **128秒 / 118批**，**21设备 / 21 Reset / 172句柄**，保留27声明/43shader。四份SDK120/220普通/PURE上下文使用真实Texture8、CubeTexture8、Surface8，检查20次成对绑定、4次过小深度拒绝、纹理/cube/设备容器身份、从借用父对象恢复同一缓存前端、公开引用平衡、空颜色目标及录制期间viewport副作用；两份普通9设备拒绝8专用入口。每份上下文新增五个资源和三次4×4读回。
> - 初次严格SDK编译因探针辅助函数名错误而拒绝；第一次VM发现普通9 GetRenderTargetData拒绝cube，改用已存在的8共用CopyRects路径。第二次VM通过，但实际GPU揭示探针错误地假定自定义viewport下Clear清整面；最终探针先明确清零整面，再验证中间2×2着色/外围零，重新跑XP和GPU。所有失败记录保留；不改变宿主或普通9cube读回政策。
> - **84完整图像 / 4,224像素**在SwiftShader和Metal均零误差，主Present4/附加Present4/0丢弃，退出前设备/资源为空；共1,529命令，比49增加128。新增完整纹理/独立RT和cube局部viewport清除参考；仍为56逻辑draw、48上传/7,424字节、2,026上传前CPU DWORD检查。新增192只读回复像素不充作独立CPU影子证据，canvas输出未单独读回。
> - **1,218项篡改检出**覆盖全部128条新增命令的载荷字、帧边界、摘要和所选保留操作，模型还验证所有命令的设备关联。**395项客体回归、新增1项核心夹具、两GPU、32标准EXE/四严格DLL、站点2项及范围lint**通过；宿主与全部既有核心测试/夹具无改动，继承49完整95项核心基线，不把继承结果写成96项新跑。证据 [stage4k50-validation.json](fixtures/d3d-review/stage4k50-validation.json)，镜像 `glbridge/deployments/d3d-webgpu-review-4K50.json`。发布准确接受的XP零售8/9与同源diagnostic，继续完整97方法Device8、前端子资源引用、原始shader/stateblock元数据与默认工厂，以及原生兼容性/完整T&L/数值差分/HAL/游戏/FPS及阶段4/5/6。

> **阶段 4L1（2026-11-05，功能批次完成）：完整 Device8 前端、资源引用、着色器句柄与状态块。**
> - 从本批开始按完整功能归并提交，不再逐个私有桥接入口增加 4K 小阶段。新增真实 SDK8 的 **97 方法 Device8**，普通设备操作复用既有 57 项后端表，资源创建/绑定/查询使用共用核心及已完成的 Surface/Texture/Cube/Volume/VB/IB/SwapChain 包装。
> - 子资源持有与直接设备引用分开计数，公开零/非零边沿只保留一个核心引用；释放期间另持有 CPU 元数据，防止最终回调先销毁前端。最后直接引用离开时清理设备所属状态，GetDevice 可恢复同一前端；真实容器查询保持纹理层级表面身份。既有独立 SDK 探针改为链接完整适配器集合，IUnknown 父夹具保留明确回退。
> - 原始 VS/PS 声明及函数字节、DWORD 句柄、FVF、BaseVertexIndex 和 API8 render/TSS 查询影子留在前端。着色器存储使用私有持有，删除公开句柄后被状态块保留的程序仍可恢复；增量录制和 ALL/PIXEL/VERTEX 范围使用 API8 列表，公共状态和资源引用由实际核心状态块保存。仅新增两项核心入口，复用既有捕获引擎并观察 Reset 的实际提交/取消录制边界；没有修改既有核心函数。
> - **398 项客体回归全部通过**。新增原生生命周期 **13,307 检查/1,024 场景**、公共范围 **5,125 检查/1,024 场景**、两者 ASAN、**27 项严格编译错误注入**通过；保留的 34 项 Surface8 错误注入亦通过。生命周期/范围原生测试的底层 COM/捕获函数为明确夹具；真实组合由 XP 单独验证。
> - 接受的第三次 XP 运行 **162 秒/37 批**，SDK120/220 × 普通/PURE 共四个真实 Device8，调用 **全部97方法**，完成 **2,815 检查、4 Reset、80 句柄、1,762 命令**。覆盖资源身份、三种状态范围、增量 Capture、已删除着色器恢复、Reset 常量保留和子资源复活。并非每种方法的全部参数组合均已验证；GetInfo/无效 patch 等按现有拒绝政策检查。
> - **28 完整图像/1,408 像素**在 SwiftShader 与 Metal 均零误差，4 主 Present，设备/资源在 SessionEnd 前为空；独立线路模型检出 **2,210 项**帧边界、设备归属、资源释放及读回字段破坏。XP 回读回复为解析注入，真实图像由 GPU 回放独立核对。
> - 首次 XP 暴露新前端遗漏既有 Root8 能力转换，已改为复用原规则；第二次暴露测试把桌面模式当成 backbuffer 尺寸，改为核对实际适配器模式。另修正测试的 SDK 缺失宏名、结构体填充字节范围及旧变异锚点；失败记录保留。
> - 32 个标准 EXE、零售/诊断 DLL、21 成员静态核心、两项站点集成和范围 lint 通过；新增核心夹具实际运行，既有冻结夹具沿用 4K50 基线，不计作本轮重跑。发布本次 XP 的准确零售8及同源诊断8，普通9/宿主/协议/着色器及其运行包不变。证据：[stage4l1-validation.json](fixtures/d3d-review/stage4l1-validation.json)，站点镜像 `glbridge/deployments/d3d-webgpu-review-4L1.json`。
> - **阶段4继续：默认公开工厂尚未切换。** 下一功能批次切换入口、清理旧重复实现并完成兼容性边界回归；其后继续共用顶点处理/DDraw收尾与原生对照。阶段5系统数值差分、完整HAL/游戏/FPS验收仍未完成。

> **阶段 4L2（2026-11-05，功能批次完成）：公开 D3D8 入口切换、旧后端退出发布构建及兼容回归。**
> - `Direct3DCreate8` / `IDirect3D8::CreateDevice` 默认创建完整共用核心 Device8；旧 8,350 行后端移入不可变历史夹具，生产 Root8 缩至 418 行。静态核心统一发送 API8 HELLO，已有核心函数逐字不变。零售 DLL 从 261,120 降至 193,024 字节。
> - **实际公开入口 XP：130 秒/37 批、全部97方法、2,815检查、四设备/四Reset、80句柄/1,762命令**，SDK120/220 × 普通/PURE。最终驱动 owner 释放、设备/资源清空均确认。28完整图像/1,408像素在 SwiftShader 与 Metal 均零误差；CPU 回读回复为解析注入，真实图像由独立 GPU 回放验证。冻结流检出2,210项破坏。
> - **旧版公开 DLL 对照：113秒/45批、同样2,815检查和28次读回通过**。唯一修改的期望为 GetRasterStatus：旧实现固定返回 INVALIDCALL，新核心支持成功查询；这不是完整原生HAL等价性证明，也未把旧版的CPU回读注入称作GPU图像验证。原始对照在该旧stub处停止；中间探针误写NOTAVAILABLE，核对原实现后改正，日志均保留。
> - **398项客体回归最终通过**：初轮四项失败是协议/caps/owner测试仍引用退出生产的函数，调整后逐项重跑通过。历史Device8比较使用显式读取器并验证原源SHA-256；Root8、真实适配器和共用核心测试仍读取生产实现。历史比较结果不冒充新前端覆盖。
> - 18个标准SDK8 EXE、严格零售/诊断构建、两项站点集成、114项站点文件/3项核心文件范围lint通过。发布XP验证的准确零售DLL和同源诊断DLL；普通9、DDraw、宿主/协议/着色器及包保持不变。新增公开入口夹具实际运行，其余旧核心冻结夹具继承前轮基线。证据：[stage4l2-validation.json](fixtures/d3d-review/stage4l2-validation.json)，站点镜像 `glbridge/deployments/d3d-webgpu-review-4L2.json`。
> - **阶段4继续**：按功能批次处理兼容性错误路径、共用顶点处理及DDraw收尾，再做原生对照；阶段5系统着色器差分和完整游戏验收尚未完成。

> **阶段 4L3（2026-11-05，功能批次完成）：状态块回放的失败传播、API8原始状态同步与回调期间快照保活。**
> - 发现共用核心除调色板外忽略了回放setter的失败；统一回放器现在在首个失败处停止并返回原HRESULT。D3D8通过受控回调在对应边界执行原始RS/TSS、FVF/着色器句柄转换，不再等到整体成功才一次性复制查询影子；索引基址跟随实际setter的提交结果。
> - Apply持有独立原始快照和设备引用，底层仍由真实状态块持有资源。删除过的着色器可通过捕获的私有对象恢复；回放期间重入删除原块不破坏当前快照。API8采用共用核心回放顺序，不新增Windows HAL失败顺序等价性声明。
> - 原生共用回放**1,532检查/352失败位置**、API8原始状态**208,400检查/400场景**及两组ASAN通过；**38/38严格编译后的运行时变异**检出，含各setter错误吞没、重复映射、错误前缀、基址位模式和快照/设备引用。首次变异删除唯一helper调用触发未使用函数编译错误，改为保留不可执行引用后才计入运行时检出。
> - **401项客体suite通过**（完整400项加新建的38变异suite）。实际公开8 XP **173秒/37批、97方法/2,815检查、4Reset、80句柄/1,730命令、28图像**；普通9 XP **119秒/7批、65 Capture/528 getter查询/64元数据轮、2Reset、5图像**，16份应用资源及1份FVF缓存明确退休。两边均确认单owner释放。
> - 两次实际捕获在SwiftShader和Metal各验证**33图像/1,728像素零误差**，分别检出2,178/110项线路破坏；保留的旧9夹具也重跑通过。XP回读回复仍为解析注入，与真实GPU验证区分。
> - 普通9首轮在Apply之前暴露旧探针对BeginStateBlock引用数的过期期望：按4J7的录制所有权改为+8，并新增End之后+9检查；生产Begin/End/分配器没有变化。线路模型另显式验证4J9后新增的私有FVF缓存，不放宽旧历史夹具。
> - 32个SDK EXE、两API零售/诊断构建、站点集成2项及两侧各5文件范围lint通过；发布两份XP验证过的准确零售DLL和同源诊断DLL，DDraw/宿主/协议/着色器包不变。证据：[stage4l3-validation.json](fixtures/d3d-review/stage4l3-validation.json)，站点镜像 `glbridge/deployments/d3d-webgpu-review-4L3.json`。
> - 继续阶段4共用顶点处理/旧版接口整体验收，以及阶段5系统着色器差分；本批未把注入式错误测试称为真实设备丢失测试，也未宣称完整HAL/游戏/FPS验收完成。

> **阶段 4L4（2026-11-05，功能批次完成）：XP 与真实 WebGPU 双向联机验收。**
> - 真实浏览器 GPU 的读回直接写入请求所属 XP DMA arena，由客体检查每个像素；不再以解析生成的像素替代联机验收。公开 Device8 的97方法/4设备/2,815项检查、D3D9状态块/Reset、DirectDraw1/2/3/4/7的ROP/GDI/调色板分别接入同一通道。
> - SwiftShader及Metal各完成三次XP：每种后端 **63张图 / 3,648个像素**，合计6次、126张图、7,296像素。全部客体检查通过，GPU/宿主错误为零，所有设备/资源在会话回收前释放。两种后端另各完成三个冻结轨迹的真实双向传输测试。
> - 异步通道复制客体命令内存、限制在途批次并保持写入generation；按序处理owner释放。最初联机失败暴露了本地通道共享内存被客体复用的问题，改用remote复制/背压后重跑通过。测试只把实际READBACK请求地址的写入视为像素，主机心跳和能力发布仍完整送回客体。
> - 新增序列/连接丢失/写入异常/超时/关闭/释放期间非法写入测试；实际virtqueue测试新增DMA复用后命令副本不变断言。原传输、旧D3D9冻结夹具、两项客体原生套件、站点集成2项和11文件范围lint通过；未重跑的401项客体基线明确继承4L3。生产DLL源码、宿主、协议及着色器包不变，本批只修改测试通道和客体探针。
> - 一次运行完整矩阵：`node tests/glbridge/d3d_live_xp_matrix.mjs`。证据：[stage4l4-validation.json](fixtures/d3d-review/stage4l4-validation.json)，站点镜像 `glbridge/deployments/d3d-webgpu-review-4L4.json`。继续原版Wine及本地3DMark/MapleStory验收，再完成阶段5；这些选定API探针不等同于完整游戏验收。

> **阶段 4L5（2026-11-05，功能批次完成）：原版 Wine 状态块验收与预定义块的流偏移兼容性。**
> - 固定Wine提交 `415a275e3844c252ad385b46023095e9401ca234` 的完整D3D8/9状态块测试及standalone头文件，保留上游字节、哈希、版权和LGPL许可。在XP选择Windows期望值，测试正文/断言/期望值均未修改；缺失、跳过或未完整结束均不能算通过。
> - 首次实际执行：8的9,283项全部通过；9的14,738项有16次流偏移失败。预定义CreateStateBlock在创建时保存offset，后续Capture仅刷新buffer/stride；Begin/End录制块仍刷新offset。共用核心已按此修正，实际C覆盖16槽×两种策略×三轮捕获和替换对象引用。
> - SwiftShader与Metal下完整两套测试均 **24,021项、零失败/零todo/零flaky/零skip**。每次9,393条实际客体命令、两个进程owner，资源在owner-released回收前为空。这里测试API状态，没有绘图/像素比较；独立像素验收继承4L4。
> - 完整401项客体回归、161,345项原生状态块持有检查（新增436项）、37/37严格编译后运行断言变异、ASan/UBSan、32标准SDK EXE、四严格DLL、站点集成2项及范围lint通过。结果解析器另拒绝13种不完整/失败/跳过/矛盾日志。等待两份日志结束标记，避免XP延迟落盘误判；观察进程退出清理，覆盖Wine没有显式FreeLibrary的卸载路径。
> - 发布准确Metal验收的零售8/9及同源诊断DLL。运行：`GL_SWIFTSHADER=1 node tests/glbridge/d3d_wine_stateblock_xp.mjs`。证据：[stage4l5-validation.json](fixtures/d3d-review/stage4l5-validation.json)，站点镜像 `glbridge/deployments/d3d-webgpu-review-4L5.json`。完整Wine device/visual/DDraw、游戏及阶段5继续；未将本批状态块套件称为全部Wine验收或原生Microsoft HAL验证。



> **阶段 4L6（2026-11-05，功能批次完成）：Wine 驱动的验证导出、模式枚举与 DXT 创建边界。**
> - 修复完整设备测试最初在 `ValidateVertexShader` 的空错误字符串上崩溃：两个导出检查版本/能力，调用共用字节码校验，验证声明输入和常量范围；错误字符串使用进程堆，成功/静默失败返回可释放的空字符串，NULL像素程序保持输出不变。诊断版本记录失败。
> - D3D8 从真实驱动枚举16/32位显示模式，取消硬编码九项及虚构15位模式；CheckDeviceType限制显示/后缓冲格式组合。共用8/9二维/立方体构造拒绝顶层DXT尺寸未按4×4块对齐的请求，所有池一致；合法2×2/1×1 mip仍可创建、锁定、上传。
> - 固定上游完整 `d3d8/tests/device.c` 原始字节。默认验收调用未修改的四个Wine函数（VS/PS验证、显示格式、显示模式），再执行明确标注为项目自有的DXT矩阵。SwiftShader/Metal各 **2,996项、零失败/todo/flaky/skip**；266条命令、125个纹理（含40个立方体）、10次tiny-mip上传，owner退出前资源和设备为零，无GPU/宿主错误。此组没有图像比较。
> - 403项独立客体套件完成验证：一次402项全量运行有两个旧构造期望和一个诊断规则失败，修正后全部定向重跑通过，并新增8/8导出变异。纹理/立方体原生检查27,774,923项；模式、格式、导出检查293,099项；相关93个严格编译后运行变异、ASan/UBSan、32 SDK EXE、四DLL构建、两站点集成和范围lint通过。
> - **完整设备套件仍失败**：原验证崩溃和压缩纹理GPU错误已消除，但后续观察到805次失败、78个源码位置，最后在缺失的压缩体积纹理上崩溃；退出前有3设备/9资源依赖强制回收。窗口/Reset、多后缓冲、锁定和体积纹理等继续保留为待办，未把选定组成功称为完整Wine通过。
> - 发布准确Metal验收的8零售DLL及同源诊断包；9的共用构造更新通过原生矩阵，本批未另跑XP9。运行 `node tests/glbridge/d3d_wine_device_xp.mjs`；完整失败审计使用 `D3D_WINE_DEVICE_GROUP=device`。证据：[stage4l6-validation.json](fixtures/d3d-review/stage4l6-validation.json)，站点镜像 `glbridge/deployments/d3d-webgpu-review-4L6.json`。继续阶段4游戏回归与剩余兼容性，再完成阶段5。

> **阶段 4L7（2026-11-05，功能批次完成）：真实 XP 3DMark 2001 SE 场景与回放验收。**
> - 使用当前零售 D3D8 DLL、只读磁盘和 RAM overlay 启动基准，进入实际车辆场景，采样32次 Present，取得1024×768的GPU读回。14,327次索引绘制、191个纹理、810次上传，宿主/GPU错误与丢弃绘制均为零；没有宣称跑完整套基准或取得总分。
> - 修复捕获/回放丢失 owner 身份以及回放积压造成的读回超时；136个包（含1个诊断READBACK）、38,034,208字节。Metal回放的3,145,728个像素字节完全一致。SwiftShader回放完成且无GPU错误，但与Metal黄金图仍有252,626字节不同，保留为失败，不放宽图像门槛。
> - 加入独立浏览器启动、镜像分段读取、失败截图与手动准备入口；修复Wine设备运行器默认输出路径初始化次序。游戏trace、528MiB journal往返、站点两项集成、输入辅助程序严格编译和范围lint通过。
> - **按用户最新要求跳过冒险岛验收**。已观察到登录及人物选择；不再等待进入地图，不记为地图验收通过。后续保留正确的系统目录DLL安装方式。3DMark成功作为本批游戏回归证据，其余Wine兼容性及阶段5仍继续。
> - 证据：[stage4l7-validation.json](fixtures/d3d-review/stage4l7-validation.json)。本地游戏数据、journal和图像不进入仓库；站点保存同份验收记录。

> **阶段 4L8（2026-11-05，功能批次完成）：D3D8 资源锁定规则与 WRITEONLY 拒绝。**
> - 按原版Wine要求区分资源：CPU池二维纹理接受越界、空、反向和未对齐矩形，重复Unlock成功；立方体与独立表面失败清空输出，二维纹理重复Lock保留输出。API9及默认池二维纹理继续严格校验。
> - 宽松Lock只用整数计算返回偏移，内部上传矩形始终限定在自有存储。负数、INT_MIN、超范围和块未对齐组合在ASan/UBSan下逐行读取上传数据通过。二维/立方体创建同时拒绝 WRITEONLY，修复实际Wine测试留下的6个资源引用。
> - 原版 `test_lockrect_invalid`、`test_surface_double_unlock` 在XP Metal/SwiftShader各 **552项、零失败/todo/flaky/skip**，退出前设备/资源均为零，GPU/宿主错误为零。未修改Wine测试或降低预期。
> - 二维锁定50,112组、立方体467,712组，构造检查37,017,042项；87个相关变异、渲染目标/私有数据/绑定/诊断回归、32 SDK EXE、四DLL构建、两站点集成及范围lint通过。发布Metal实际验收的8零售DLL及同源8/9零售/诊断包。
> - 证据：[stage4l8-validation.json](fixtures/d3d-review/stage4l8-validation.json)。完整Wine的压缩图像/体积纹理、窗口Reset及多后缓冲等仍未收尾；本组没有场景像素比较，API9未另跑XP。

> **阶段 4L9（2026-11-05，功能批次完成）：压缩图像和纯 CPU Scratch 体积纹理。**
> - API8 ImageSurface 支持 DXT/YUV 块布局；DXT 顶层保持四像素对齐。Scratch 体积纹理允许压缩存储，不创建、上传或销毁 GPU 资源，也不能绑定采样；默认池非动态 LockBox 按 Wine 预期清空 pBits 后拒绝。补齐 WRITEONLY、MANAGED/SCRATCH+DYNAMIC 的创建限制。
> - 原版 volume_blocks、volume_locking、lockbox_invalid 加项目图像矩阵，在实际 XP Metal/SwiftShader 各 **38,326 项、零失败/todo/flaky/skip**；退出前设备/资源为零，GPU/宿主错误为零。首次原版 storage-audit 的 42,855 项有一项输出错误和两个 ATI 扩展 skip：输出错误已修，原审计日志保留；ATI 未宣称支持，不把其 skip 计成通过。
> - 图像/体积/锁定合计 51,557,191 项原生检查及 ASan/UBSan 通过，67 个变异检出；格式、生命周期、绑定、状态块、回缓冲等回归、32 SDK EXE、四 DLL、两站点集成通过。发布准确 Metal 验收的 D3D8 零售 DLL 和同源诊断/9包。
> - 证据：[stage4l9-validation.json](fixtures/d3d-review/stage4l9-validation.json)。完整 Wine 窗口/Reset/多后缓冲及阶段5仍开放；本组没有场景像素比较，不代表完整 Wine 验收。

> **阶段 4L10（2026-11-05，功能批次完成）：Wine 资源 API 和复制兼容性。**
> - API8 仅 MANAGED 池保存优先级；无效深度格式清空输出；全屏设备拒绝额外交换链。纹理/立方体/体积包装以内部身份校验，应用替换或清空 COM vtable 后仍能 SetTexture，保持容器、父设备和引用规则。
> - 共用复制循环增加 API8 策略：容器锁定不阻止 UpdateTexture；体积尺寸/格式不同时复制合法内存范围内的原始字节前缀。Windows 越界读取部分没有定义，本实现保留目标余下内容，不模拟越界或宣称这部分像素等价；普通API9严格规则保留。
> - 7个未修改 Wine 函数在实际XP Metal/SwiftShader各 **431项、零失败/todo/flaky/skip**，设备/资源释放为零，GPU/宿主错误为零。244组真实复制矩阵及ASan/UBSan、资源优先级/深度/包装/绑定/生命周期检查、207个相关变异、32 SDK EXE、四DLL和两站点集成通过。
> - 4L9后的完整审计已越过体积崩溃点，在多后缓冲测试8827行再次崩溃，之前记录89次断言失败/64个位置；保留失败日志和哈希，尚未宣称完整Wine通过。下一批继续多后缓冲及窗口/Reset。发布准确Metal验收8零售DLL，证据：[stage4l10-validation.json](fixtures/d3d-review/stage4l10-validation.json)。

> **阶段 4L11（2026-11-05，功能批次完成）：多后备缓冲区、FLIP 像素轮换与交换链寿命。**
> - 隐式/附加交换链提供独立的 1–3 个后备缓冲区，公开对象和绑定身份保持稳定；GPU 复制实现 FLIP 的前后缓冲循环，COPY 保留内容，DISCARD 不承诺丢弃后的像素。缓存的公开引用/内部绑定参与父对象寿命，未被应用持有的缓存不阻止 Reset，最终销毁受临时设备引用保护。
> - 实际像素测试发现并修复 LockRect 读回缓存被误判为 CPU-only 表面的问题；读回后重新绑定和 StretchRect 继续使用原 GPU 资源。首次运行的 52 次失败保留，不计为验收。
> - 两个未修改 Wine 函数及 14 组项目像素场景在 XP Metal/SwiftShader 各 **816 项、零失败/todo/flaky/skip**；各完成 82 次 GPU blit、69 次像素读回，GPU/宿主错误、结束后的设备/资源均为零。覆盖逐像素 FLIP 循环、附加链不影响主链、对象/绑定身份、先释放链再释放表面、持有末缓冲阻止 Reset 与释放后尺寸更新。
> - 相关生命周期、私有数据重入、资源/Reset、参数/节奏/目标绑定矩阵和变异检查、32 SDK EXE、四 DLL、范围 lint 与两项站点集成通过。发布准确 Metal 验收的 D3D8 DLL；本批未单独运行 XP9。证据：[stage4l11-validation.json](fixtures/d3d-review/stage4l11-validation.json)。全屏只覆盖原版参数检查，新增像素场景为窗口化非 MSAA；完整 Wine 窗口/Reset/visual/DDraw 及阶段5仍未关闭。


> **阶段 4L12（2026-11-05，功能批次完成）：零售设备调用与连续 mip 存储。**
> - 修复 GetInfo 返回值/输出保留、UNKNOWN 格式失败输出、格式查询及 D32 深度匹配、资源用途/池和锁权限。MultiplyTransform 按输入矩阵×实时矩阵执行，录制期间也只改实时状态；UP 绘制清理实时 BaseVertexIndex，零图元调用保持原状态，缺失顶点流的 API8 索引绘制成功但不提交。
> - API8 CPU 池二维/立方体纹理采用连续 mip 存储，各面起点16字节对齐；分配失败和溢出不改变指针，析构只释放整个块。未压缩 scratch volume 可绑定并正确销毁 GPU 资源，压缩 scratch volume 保留纯 CPU 路径。Present 在提交前检查已销毁窗口。
> - 原版四个 Wine 函数与项目矩阵在 Metal/SwiftShader 各 **6,816项、零失败/todo/flaky/skip**。五格式×三池×二维/立方体×九级，逐字节重锁验证不串写；947次上传、24,902,768字节，零GPU/宿主错误，owner清理前设备/资源为空。重锁数据来自CPU影子，本批不冒充新增GPU像素比较。
> - 实际分配器通过 ASan/UBSan 的103组布局/OOM/溢出检查；实际 C 状态录制、非交换矩阵、资源寿命/重入、格式/锁/构造矩阵、旧实现反例与严格变异检查、32 SDK EXE、四DLL、范围lint和两站点集成通过。同步准确 Metal 验收的8零售DLL及同源诊断、共用9构建，宿主包保持 `6018289b1abb163f6620`。
> - 原版后半段审计从925次失败降至 **1次**：11036行 SetForegroundWindow(GetDesktopWindow())；保留5个可选能力分支skip，未计作通过。完整套件前段的重复Release/缓冲锁问题仍待处理；本批不是完整Wine验收。证据：[stage4l12-validation.json](fixtures/d3d-review/stage4l12-validation.json)。阶段5已完成，阶段4继续；冒险岛按用户要求跳过。


> **阶段 4L13（2026-11-05，功能批次完成）：零售资源寿命与嵌套缓冲锁。**
> - 二维纹理包装对象的存储由设备按大小复用，保留立即重复 Release 所需的对象头；底层资源立即销毁，缓存受锁保护、复用前清零、设备最终释放时清空。保留量取决于各尺寸同时存活对象的峰值，不随创建次数增长；不承诺任意失效 COM 指针可继续使用。
> - 共用核心支持 API8 VB/IB 多次锁定：计数、合并范围、只读标志取交集，最后一次 Unlock 上传；绘制期间可见合并范围。API9 保留原有重复锁拒绝。另修复 ApplyStateBlock(0) 的成功空操作及合法但不支持的 MSAA 目标返回值。
> - 四个未修改 Wine 函数及项目用例在 XP Metal/SwiftShader 各 **3,619项、零失败/todo/flaky/skip**；六种缓冲/池组合逐字节检查嵌套写入、1,000次纹理创建/释放/再次释放，零GPU/宿主错误，owner清理前设备和资源为空。CPU重锁不计作GPU像素比较。
> - 本机实际C通过5万次串行/四线程复用、ASan/UBSan、缓冲上传范围/字节、生命周期/录制/Reset/映射绘制和严格变异检查；32 SDK EXE、四DLL、范围lint、两项站点集成通过。同步准确Metal验收的8零售DLL及同源诊断/9构建，宿主包不变。
> - 完整原版套件终于正常跑完：**53,539项、71次失败、10次skip**，该审计发生在本批最后三处返回值断言修复之前，不能标记为通过。剩余集中在窗口/焦点/全屏丢失语义。结束前一个设备/目标残留已追溯到原版 `test_depth_stencil_size` 缺少设备Release，原版和严格清理断言均未修改。证据：[stage4l13-validation.json](fixtures/d3d-review/stage4l13-validation.json)。阶段4继续，阶段5完成；冒险岛跳过。


> **阶段 4L14（2026-11-05，功能批次完成）：全屏焦点、窗口消息与丢失恢复。**
> - API8 分开管理焦点窗口和绘图窗口，保留原有样式和原生消息顺序；失焦恢复桌面模式、最小化绘图窗口，恢复焦点后允许 Reset，Present 不再抢前台。XP 最小化期间的线程激活不提前恢复；只收到窗口激活时，按实际前台状态补齐恢复通知。
> - 窗口订阅与 COM 设备分开保活，覆盖 ANSI/Unicode、共享窗口、回调中释放/销毁和应用替换窗口过程。实际 C 的 ASan/UBSan **130项**与 **14个**运行时变异通过，相关 Reset、窗口、寿命、节奏和参数回归通过；32 SDK EXE、四 DLL、范围 lint、站点集成通过。
> - 五个未修改 Wine 函数及项目恢复场景在 XP Metal/SwiftShader 各 **249项、零失败/todo/flaky/skip**，各比较 **633,600个实际GPU读回像素**；GPU/宿主错误和 owner 释放前设备/资源均为零。同步准确 Metal 验收的8零售DLL及同源诊断/9包，宿主bundle不变。
> - 完整未修改 Wine device 审计为 **53,530项、零失败/todo/flaky、10次可选分支skip**。严格门禁仍不算通过；原版 `test_depth_stencil_size` 漏掉设备 Release 的一设备/一目标残留继续如实记录，未修改上游或放宽清理断言。
> - 修复测试失败时浏览器临时目录遗留：清理返回可等待结果，Wine harness 在抛错前等待完成；真实 Chrome 的正常结束、调用者失败及启动超时三条路径均确认目录已删除。证据：[stage4l14-validation.json](fixtures/d3d-review/stage4l14-validation.json)。阶段4继续最终跨API集成；阶段5完成，冒险岛跳过。


> **阶段 4L15（2026-11-05，功能批次完成）：完整回归与跨API集成，阶段4收尾。**
> - 修复旧原生夹具的结构/依赖和变异定位，冻结参考文件保持不变。API8 CPU纹理以旧元数据加独立的连续块分配次数、偏移和OOM期望校验；补齐UNKNOWN输出保留、缓冲用途/池、非压缩scratch volume的GPU创建及传输失败。立方体上传覆盖四池，索引矩阵显式覆盖缺失stream0的成功空操作。
> - `glbridge/tests/*_test.js` **408个脚本全部通过**；二维/立方体构造矩阵另通过 ASan/UBSan，范围lint零新增问题。首轮磁盘空间不足中断的结果不计通过：保留89个有完整成功记录的测试，清理空间后重跑其余未完成/失败/无记录项目，最终408项均exit0。
> - D3D8、D3D9、DirectDraw × Metal/SwiftShader **六次真实XP/GPU运行全部通过**，合计126个图像、7,296个像素，GPU/宿主错误为零、会话清理前设备/资源均为空。三份harness等待浏览器清理；站点同步准确Metal验收的8/9/DDraw零售DLL，同源8/9诊断包沿用4L14。
> - 当前宿主回放已保存的3DMark2001SE场景：136包、3,145,728字节读回，与4L7基准**零差异**。这是原有场景的Metal回放，不是重新跑完整benchmark或分数；4L7的SwiftShader与Metal截图差异仍保留，未改黄金图。
> - **阶段4计划项完成**：共用runtime/owner/传输/窗口/格式/caps/FVF/T&L/状态，D3D8包装真实私有D3D9对象、零售语义及DDraw共用路径完成；阶段5已由5L1～5L7完成。证据：[stage4l15-validation.json](fixtures/d3d-review/stage4l15-validation.json)，站点镜像 `glbridge/deployments/d3d-webgpu-review-4L15.json`。宿主bundle保持 `6018289b1abb163f6620`。
> - **阶段6继续**：4L14完整Wine device审计虽零失败，仍有10次可选分支skip和上游漏Release，严格整套验收未通过；其余Wine visual/DDraw套件、跨后端游戏截图及持续验收不在本次完成声明内。冒险岛明确跳过，不据选定用例宣称所有API/游戏无缺陷。

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
  - 3DMark 2001 SE 回归；MapleStory 按用户 2026-11-05 指示跳过。

### 阶段 5：着色器翻译器（约 3–4 周）

> **阶段 5L1（2026-11-05，功能批次完成）：数值参考解释器、算术/控制流修复与严格 Tint 语料门禁。**
> - 新增独立算术/控制流解释器，复用字节码解码、不复用生成的WGSL。实际生成的 `d9_body` 包装为compute，在Metal和SwiftShader分别比较707个程序×32组输入，共90,496个分量；两端均无超出明确精度预算的差异、无GPU错误。覆盖常量、掩码/修饰符、地址取整、嵌套循环、break及调用内提前return。初始差分直接暴露SM1常量未夹取及嵌套aL污染。
> - 修复ps_1_x常量读取夹取、vs_1_1 MOV a0向下取整、嵌套/调用后的aL恢复，以及POW零底数正指数/零指数的明确定义。MOVA半整数采用ties-to-even测试策略，仍不宣称Windows原生半整数已定论。
> - 通用相对误差门槛2e-5（尺度至少1）；SINCOS在[-π,π]依WGSL规范采用2^-11绝对误差预算。707个合成程序用于数值执行，不等同于所有版本合法指令组合的验证器测试。
> - 47项翻译器单测、190个Naga程序、178项执行器测试、22,624次CPU执行及范围lint通过。严格语料入口现要求真实Chrome Tint校验，12个私有GTA着色器在两个后端均零拒绝；私有字节码不提交。
> - 发布主线程和shader worker同源bundle `94631fcb923bae8aab2a`，验证两者包含准确测试源码，站点两项集成通过。证据：[stage5l1-validation.json](fixtures/d3d-review/stage5l1-validation.json)。纹理采样差分、SM3语义链接、旧版颜色/雾规则和主体一次翻译架构继续，阶段5尚未完成。

> **阶段 5L2（2026-11-05，功能批次完成）：纹理采样数值回归，修复 S2-11/S2-13。**
> - 删除坐标/导数提升及静默零值、LOD0回退，使用已有 `derivative_uniformity` 诊断开关保持指令原执行位置。循环每次迭代读取当前坐标；分支中的偏置与导数也不再被替换。
> - 旧版 TEXBEM/L、TEXDP3/TEX、矩阵PAD/采样/反射路径使用完整源修饰符和swizzle；保留原来的坐标、梯度与LOD运算。
> - 新增RGBA16Float已知纹理、四mip、六立方体面和RGBA32Float读回：34个实际fragment程序、8,704个分量，在Metal/SwiftShader均通过1e-5绝对误差门槛，零GPU错误。旧代码在同组中有13个失败程序，包含循环坐标冻结、分支导数清零、偏置丢失及 `_bx2` 丢失。
> - 数值用例保证quad内执行一致，未宣称真正分歧分支中的未定义导数具有确定值。三种谓词/break/call控制流通过真实Tint；12个私有shader通过Naga+Tint；44项单测、190个Naga程序、178项执行器、范围lint及两站点集成通过。删除了三个要求旧错误回退行为的文本断言。
> - 发布bundle `895589dae30ca08739ae`。证据：[stage5l2-validation.json](fixtures/d3d-review/stage5l2-validation.json)。语义链接、旧版投影/深度/颜色/雾规则、主体只翻译一次及完整资源兼容性继续。

> **阶段 5L3（2026-11-05，功能批次完成）：旧版着色器颜色输出与雾来源，修复 S2-14。**
> - VS1/2 未写漫反射时默认白色；漫反射/高光在插值前夹取到 [0,1]。VS3 与旧版像素着色器/固定管线配对时使用单独缓存变体，VS3+PS3 保留未夹取值；同一帧切换旧/新像素伙伴的回归通过。
> - VS1/2 未写 oFog 时从输出高光 alpha 取雾，保留显式 oFog、table fog 优先级和 PS3 不应用旧版后置雾的规则。删除要求错误“默认无雾”的文本断言，以实际像素覆盖。
> - 新增129场景，覆盖版本配对、缺失颜色、插值前夹取、四种顶点雾模式与显式/高光/table来源。完整 **662场景在Metal/SwiftShader全部通过**，使用明确UNORM8±1预算，零GPU/宿主错误、失败命令或丢弃draw；旧版本在最初124个新场景中失败48个。
> - 43翻译器单测、178执行器、190Naga程序、12私有shader严格Naga+Chrome Tint、范围lint和两站点集成通过。发布bundle `f85e1b4608acc142f6c0`。证据：[stage5l3-validation.json](fixtures/d3d-review/stage5l3-validation.json)。语义链接、主体一次翻译、旧版投影/深度采样及相对输入/输出寻址继续，阶段5尚未关闭。

> **阶段 5L4（2026-11-05，功能批次完成）：SM3 语义/分量链接，修复 S2-12。**
> - VS3 指令主体写入物理 o# 寄存器，入口包装按语义映射；只有 POSITION0 驱动光栅位置，POSITION1 不再覆盖它。保留同一寄存器上多个 DCL 的语义与掩码，支持 NORMAL/TANGENT/BINORMAL、TEXCOORD8/9/15、COLOR2+ 等。
> - 在 draw 链接时匹配语义、索引与分量，将实际消费的值打包到最多11个 vec4 位置；同一原寄存器中的平面颜色和平滑分量分别插值。VS/PS 变体缓存均包含紧凑的配对键；缺失、重叠或重复声明在创建 GPU 管线前拒绝，旧版/固定管线保留兼容映射。
> - 新增 **127 个实际像素场景**：寄存器重排、部分掩码、多个语义共用寄存器、40分量满输入、平面/平滑混合及同帧重复切换伙伴。全套 **789 场景 Metal/SwiftShader 全通过**，UNORM8±1预算，零 GPU/宿主错误或丢弃 draw；改动前版本在新组中失败118场景。
> - 46翻译器单测、178执行器、190Naga程序、12私有shader严格Naga+Chrome Tint、范围lint和两项站点集成通过。发布bundle `a75587607e9ccd7fa1c0`。证据：[stage5l4-validation.json](fixtures/d3d-review/stage5l4-validation.json)。本批完成入口链接；每个变体仍会遍历指令，主体一次翻译、相对输入/输出寻址及旧版投影/深度采样继续，阶段5尚未关闭。

> **阶段 5L5（2026-11-05，功能批次完成）：SM3 输入/输出相对寻址。**
> - VS3 输入支持 a0 四分量及 aL 索引，PS3 输入支持 aL；入口先完成属性转换及语义链接，再填充输入数组。VS3 静态和相对输出共用物理寄存器数组，保留分量掩码、条件写入、循环步长和嵌套循环恢复。
> - 新增 **204 个实际像素场景**，覆盖16个顶点输入、10个像素输入、可索引输出o2–o11、正负偏移、顺逆循环、嵌套及谓词分量。全套 **993 场景 Metal/SwiftShader 全通过**；原实现在新组中失败171场景。有效索引按文档验证；越界防护不宣称等同原生未定义行为。
> - 测试程序此前每个场景保留独立会话，扩容后耗尽ArrayBuffer；现通过协议发送SESSION_END，每例核对设备、资源、会话表为空。未改变像素期望或错误门槛。
> - 48翻译器单测、178执行器、190Naga程序、12私有shader严格Naga+Chrome Tint、6文件范围lint及两项站点集成通过。发布bundle `fd0a2a95df0b43356bd8`。证据：[stage5l5-validation.json](fixtures/d3d-review/stage5l5-validation.json)。主体一次翻译和旧版投影/深度/矩阵采样仍待完成，阶段5尚未关闭。

> **阶段 5L6（2026-11-05，功能批次完成）：旧版投影/深度/矩阵采样。**
> - 实现ps_1_4 texdepth、ps_1_3 texm3x2depth及ps_1_2/1_3 texm3x3；前两者接入片元深度并处理文档规定的除零结果1。ps_1_1～1_3普通tex按PROJECTED和COUNT选择除数，ps_1_4忽略该标志，缓存键覆盖状态切换。
> - 旧版普通tex/texld支持硬件深度比较与INTZ/DF24原始深度读取；texreg2rgb和三行矩阵采样按实际绑定选择2D/cube/volume。修复无采样器时纯纹理坐标运算没有被固定顶点管线传出的缺口。
> - 新增 **130 个实际像素场景**，包含单采样/4xMSAA深度比较和写入、正负/零除数、矩阵修饰符、投影及同帧状态/纹理维度切换。全套 **1123场景 Metal/SwiftShader 全通过**；旧实现失败114个新场景。独立纹理/深度数值参考扩至 **52程序、13,312分量**，两后端绝对误差≤1e-5。
> - 49翻译器单测、178执行器、199Naga程序、12私有shader严格Naga+Chrome Tint、9文件范围lint、两项站点集成通过。发布bundle `3cda04417fadd87ee619`。证据：[stage5l6-validation.json](fixtures/d3d-review/stage5l6-validation.json)。未将未定义深度范围或全部依赖深度采样组合宣称为原生等价；主体一次翻译仍待完成，阶段5尚未关闭。

> **阶段 5L7（2026-11-05，功能批次完成）：主体一次翻译与薄变体适配，阶段5验收完成。**
> - 字节码只遍历一次，生成可序列化的指令主体/子程序、寄存器元数据和去重采样适配描述；prepared program不保存原字节码或指令列表。执行器两阶段改为specializeShader，共享同一主体，只按状态重建入口、uniform布局、语义链接及采样适配函数。
> - Worker返回及JSON持久缓存保留主体；不完整缓存跳过，旧形态Worker响应触发正常回退。单测在创建后禁止读取原token，并对冻结、序列化后的主体做多变体等价与不变性检查；采样适配去重后仍保留逐指令诊断计数。
> - Metal/SwiftShader均通过 **1123像素场景、1258个共享主体变体、516次真实Worker编译（零回退）和缓存恢复**；两后端数值差分707程序/90,496分量、纹理/深度差分52程序/13,312分量通过。Swift算术首轮并行测试超过60秒，单独重跑在180秒预算内通过，未将超时计作成功。
> - 52翻译器单测、178执行器、199Naga程序、12私有shader严格Naga+Chrome Tint、11文件范围lint及两项站点集成通过。本机252指令/200变体微基准，中位CPU生成时间26.36→4.76ms，约5.54倍；不作为游戏FPS指标。WebGPU仍需按绑定/接口变体编译完整WGSL模块。
> - 发布bundle `6018289b1abb163f6620`；证据：[stage5l7-validation.json](fixtures/d3d-review/stage5l7-validation.json)。**阶段5计划项由5L1～5L7完成**：参考解释器及差分矩阵、S2-10～14/§3.3着色器修复、语义链接、主体复用和严格Tint语料门禁。阶段4的完整Wine设备/窗口/资源兼容性仍继续，未宣称全部D3D计划完成。

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

### 阶段 6：客体内与完整3DMark本地验收

见 §8，执行范围以2026-11-05用户修订的§8.5为准。

## 8. 建立成体系的验收

### 8.1 分层

| 层 | 内容 | 期望值从哪里来 | 在哪里跑 |
| --- | --- | --- | --- |
| L0 协议 | schema 生成的往返测试，逐个 opcode 测截断、版本门控、会话隔离 | schema | 每次 push |
| L1 纯逻辑单元 | 客体纯函数原生编译；宿主各模块单独测试 | 规范 | 每次 push |
| L2 严格假 GPU | 现有执行器测试迁到严格假 GPU 上，去掉对 WGSL 文本和私有计数器的断言 | WebGPU 规则 | 每次 push |
| L3 真 GPU 像素一致性 | 表驱动，按 D3D 特性分表；着色器差分测试 | D3D 文档、Wine `visual.c` 期望值、参考解释器 | 本机 Metal / SwiftShader；阶段6不要求新增CI或定时任务 |
| L4 客体 API 一致性 | 在 XP 客体里跑 Wine 的 `dlls/d3d9/tests`、`d3d8/tests`、`ddraw/tests`（device.c、visual.c 等），代理 DLL 放在 EXE 旁边 | Wine 测试自身 | 本机XP镜像，按功能批次验收 |
| L5 完整3DMark验收 | 六版3DMark全部测试、逐场景画面检查与完整浏览器错误日志 | 测试完成记录、人工核对及独立参考画面 | 本地站点浏览器，见§8.5 |

### 8.2 L4 已有的基础设施和缺口

截至4L15，原审查中列出的D9WG渲染入口、装好驱动的本地XP镜像和严格Wine结果解析器均已具备：

- `tests/lib/xp_ram_probe.mjs` 只读启动XP，写入只留在RAM覆盖层；当前DLL与MinGW测试EXE一起放入工具盘。
- `tests/lib/d3d_live_renderer.mjs` 连接真实Chrome WebGPU，返回实际GPU读回；`tests/glbridge/d3d_live_xp_matrix.mjs` 串行验收8/9/DDraw和两个GPU后端。
- `tests/glbridge/d3d_wine_stateblock_xp.mjs` 与 `d3d_wine_device_xp.mjs` 运行固定哈希的未修改Wine源码，严格解析完成记录、失败/todo/flaky/skip、进程退出及owner清理。选定组通过与完整套件通过分开记录。
- **阶段6仍待完成：** 扩展D3D8/9 visual、其余device及DDraw原版套件，处理完整审计的skip/上游寿命问题，并完成§8.5六版3DMark本地全项验收。当前不把未实现的可选能力或上游漏释放静默豁免为通过；新增线上CI/每晚运行已按用户要求移出范围。
- Linux/Wine加socket垫片仍是可选的加速方案，本机未以此替代XP验收。

### 8.3 规则

1. **能力宣称必须有测试覆盖。** 客体 caps 和 `CheckDeviceFormat` 的每一个“yes”，都要在 L3 或 L4 有对应的用例；没有用例的能力不宣称。
2. **每个 bug 修复都要在能暴露它的最低一层加回归用例。** 只能在 L5 暴露的问题，要补一个 L3 用例。
3. **适用测试必须全部通过。** Wine互斥/平台不适用分支按用户确认逐项记录源码位置、原因和证据；未知skip、缺失功能、失败和崩溃仍不通过。验收缺工具、能力或镜像时记录未完成；本地镜像不上传GitHub。
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

### 8.5 阶段6范围修订（2026-11-05，用户确认）

保留完整Wine/API验收和缺陷修复，增加下列本地3DMark全项验收。移除新增GitHub线上CI、每晚调度与发布自动化工作包；不要求上传XP或3DMark镜像。保留本地运行脚本、测试清单、截图和日志，便于复现与复核。冒险岛继续跳过。

| 顺序 | 程序 | 本地镜像（相对于retro-gaming-site） | 状态 |
| --- | --- | --- | --- |
| 1 | 3DMark99 | `game/3dmarklegacy.img` | Metal全部26项通过；旧分支性能对齐/跨后端核对仍开放 |
| 2 | 3DMark2000 | `game/3dmarklegacy.img` | Metal全部22项通过；跨后端核对仍开放 |
| 3 | 3DMark2001 SE | `game/3dmarklegacy.img` | Metal全部21项通过；跨后端核对仍开放 |
| 4 | 3DMark03 | `game/3dmark03.img` | Metal图形/CPU 11项完成；3项声音不支持，尚未全项通过 |
| 5 | 3DMark05 | `game/3dmark05.img` | Metal全部16项通过；跨后端核对仍开放 |
| 6 | 3DMark06 | `game/3dmark06.img` | 全项验收待完成；用户已确认最后重复的05指06 |

验收要求：

1. 使用本地站点浏览器与当前代理DLL实际运行，按上述顺序逐版完成。先记录镜像内实际版本、全部子测试清单、运行设置、浏览器/GPU后端及DLL/宿主版本；每次只运行一个XP虚拟机。
2. **全部子测试完成**：包括各版提供的游戏、CPU和功能测试，逐项记录完成状态与结果。只运行默认计分子集、演示、单个场景或旧命令回放均不足以通过。因能力不足、崩溃、挂起、授权限制或其他原因未运行的项目，明确记录为未完成，不跳过后宣称全项通过。
3. **画面正确**：逐场景检查并保留关键帧/必要的视频证据，核对纹理、几何、光照、阴影、透明、特效及场景切换；不能用完成分数或无崩溃代替画面验证。参考图需独立核对，不能直接把当前输出指定为正确答案。Metal与SwiftShader发现的差异须定位，不能以同后端自回放一致替代跨后端核对。
4. **浏览器console零错误**：从启动到结果页记录完整console、页面未捕获异常、Promise拒绝与WebGPU错误；不屏蔽、不清空错误后计为通过。设备丢失、超时及资源清理异常也必须处理。告警保留供复核，不隐藏可能的渲染缺陷。
5. 新发现的问题按功能合并修复，在能复现问题的最低层补回归，再重跑受影响版本。每完成一个功能批次，在两个仓库的`refactor`分支分别提交实现、回归或相关验收记录；不按单个断言拆提交。
6. 阶段6关闭需同时满足Wine/API验收与以上六版全项要求。当前只修订范围，不表示上述3DMark已跑完或已通过。

### 当前执行顺序与验收口径（2026-11-06，用户确认）

先跑通完整Wine验收，再进行3DMark99、2001 SE、03、06的新旧版本性能对比。Wine适用测试必须全部通过；互斥分支或平台不适用项须逐项记录准确源码位置、原因和证据，不能用不适用清单豁免真实失败、崩溃或缺失功能。03的三项声音测试保留为未完成，本轮先完成其余验收，不扩展音频实现。

性能对比固定机器、浏览器/后端、XP/游戏镜像、CPU Worker、内存及各程序图形设置，记录DLL和宿主准确提交/哈希，要求图形分数不回退。旧默认分支在本地实际命名为v86 `master`（当前基线`87d26deb9a77c2e98b4b684f39cc72ba9065d76a`）与本站 `main`（`43c4d1e58c6808e2fee2e2abac59062467b6942b`）；新组合使用两个仓库的`refactor`。正式对比须在Wine通过后进行，之前六版历史成绩只作排查证据。仍逐功能批次在两个仓库分别commit，不上传磁盘镜像。

### 阶段6首批修复与99结果（2026-11-06）

修复逐绘制重复扫描ClipStatus造成的客体CPU开销、索引UP上传整个未使用顶点区间的问题，以及宿主压缩队列缺少限流导致的十几GB原始记录积压。缓存逐字比较全部位置（包括未引用顶点），可变位置/视口/非法索引仍被正确处理；屏幕内部顶点使用保守快速路径，边界及异常值保留原计算。队列限流保留全部历史，不丢弃绘图或隐藏错误。

3DMark99 Max build 200在Metal完成全部26项：1605分，赛车22.7 FPS、第一人称12.4 FPS；同为CPU Worker的修复前为189分、6.2/1.1 FPS。18张质量图片已导出；9张完整图扣除元数据后与修复前像素完全一致，另核对了随程序提供的32位软件参考图与场景关键帧。浏览器/宿主/GPU错误、失败命令和丢弃绘制均为零；正常退出后设备/资源为零。客体程序目录内DLL SHA-256与发布DLL一致。

**99的完整Metal运行已通过，旧分支性能对齐仍开放。** 旧分支仅观察到赛车瞬时约42 FPS，随后发生历史队列内存失败，不能把它当作完整平均成绩。此批不声称达到旧分支全部性能，也不声称完成SwiftShader全项比较、其余五版或完整Wine/API验收。详细版本、哈希、设置及证据见 `fixtures/d3d-review/stage6-1-validation.json`；大体积图片/报告仅在本地 `v86/build/d3d-review/stage6-99-scalar` 保存。

### 3DMark2000完整Metal验收（2026-11-06）

Pro build 340在1024×768、16位颜色/纹理/深度、三缓冲、硬件T&L与CPU Worker下完成全部22项，得分2799、CPU分161。直升机低/中/高为71.1/47.0/15.0 FPS，Adventure为51.0/29.6/19.6 FPS；其余填充率、1/4/8光源、8/16/32/64MB纹理、四种凹凸映射均有实际成绩。两类画质测试输出18张图片，9张完整图与关键场景已检查，并核对自带帮助中的独立图例和高光差异说明。

浏览器console错误、宿主/GPU错误、失败命令和丢弃绘制均为零，正常退出后设备/资源为零。保留两类告警：测试切换时客体窗口暂时隐藏；坐标诊断样本为未绑定纹理的纯颜色绘制。没有隐藏告警或把它们改成通过条件。原始详情表由`BENCHUI --list Details`读取，项目、DLL、成绩表和18张图片通过RAM磁盘导出核验。详见 `fixtures/d3d-review/stage6-2-validation.json`。SwiftShader比较、其余四版及完整Wine/API验收继续开放。

### 3DMark2001 SE完整Metal验收（2026-11-06）

Pro build 300在1024×768、32位颜色、24位深度、DXTC纹理、双缓冲、硬件T&L与CPU Worker下完成全部21项（7游戏、6理论、4 DX8功能、4画质），得分8237。程序提示设置不是默认值，故不将该分数作为标准默认成绩。三组游戏低/高细节分别为69.2/20.5、133.2/65.0、85.3/33.4 FPS，Nature为149.1 FPS；其余功能项目均有实际结果，四类画质输出8张图片。

全部场景关键帧、4张完整画质图及自带帮助独立图例已核对。Dragothic高细节的未写纹理坐标提示另做定向捕获：两种状态均只采样1×1、wrap寻址的纹理，采样值与坐标无关；保留提示及原始计数，不把提示隐藏。阴影、着色器和点精灵画面已检查。浏览器/宿主/GPU错误、着色器编译/翻译失败、失败命令和丢弃绘制均为零，正常退出后设备/资源为零。客体程序目录DLL与发布D3D8 DLL哈希一致。

详情表、项目、DLL、质量图和独立诊断仅留本地；清单见 `fixtures/d3d-review/stage6-3-validation.json`。03/05/06、跨后端比较、99旧分支性能对齐及完整Wine/API验收继续开放。

### 3DMark03首轮与诊断修复（2026-11-06）

Professional Edition 3.6.0完成4个游戏、2个CPU和5个功能项目，得分9521、CPU分1895。四个游戏为94.6/95.1/64.6/58.7 FPS；CPU为86.1/54.5 FPS。显示设置为1024×768、无AA、Optimal纹理/顶点着色器，保留原始结果中的Checksums Valid=No，不作为官方认证成绩。游戏、CPU、填充率、顶点/像素着色器与Ragtroll关键帧已对照自带帮助独立图例检查；浏览器/宿主/GPU错误、着色器失败及丢弃绘制均为零，退出后设备/资源清零。

**03仍未全项通过：3个声音测试全部未运行。** 原始结果明确为Not supported。新增只读`SOUNDCAP.EXE`核验：XP可正常打开Sound Blaster 16及DirectSound，但驱动报告硬件3D声源数量为0。需补齐真实音频能力再重跑，不能修改能力位、跳过项目或用分数代替通过。

另修正点精灵诊断的反射信息：生成的入口已写入全部8组纹理坐标，旧统计却仅计算客体着色器本体的输出。03全程376个采样中，该提示与点精灵绘制数完全一致。修复仅补全变体反射，保持WGSL画面逻辑不变；普通三角形确实缺失UV时仍报告。52项着色器测试与179项执行器测试通过，发布WebGPU版本为`f95489b0bdfbfc0030ee`。

05从镜像根目录启动会触发其自带Boost路径错误；改为在RAM覆盖层内将指定程序文件移入普通目录后已进入主界面。启动脚本对05/06保留同盘重命名方式，不复制大数据文件或改写原始镜像。正式05/06测试继续。证据见 `fixtures/d3d-review/stage6-4-validation.json`；03声音测试、跨后端比较、99性能对齐及其余阶段6验收保持开放。

### 3DMark05完整Metal验收（2026-11-06）

Business Edition 1.3.0已完成全部16项：3游戏、2 CPU、5功能、6批量绘制。1024×768、无AA、Optimal纹理、VS/PS 3.0，保留默认深度阴影与后处理；CPU项目使用程序自身规定的低分辨率/软件顶点路径。得分2945、CPU分7784；游戏为11.0/8.0/18.6 FPS，CPU为2.4/11.0 FPS。原始`.3dr`含18行结果（含两项分数），全部状态成功，6种批量大小均有成绩。

逐场景检查了金属/光照/阴影、森林萤火、水面/飞艇/怪物/泛光、CPU变体、填充率、岩石像素着色、四个高面数模型、草地及6种批量网格。独立参考使用自带游戏截图与功能说明；帮助中的`ss_fillrate.jpg`实际是过滤隧道，未把它当成填充率逐像素基准。浏览器/宿主/GPU错误、着色器失败、失败命令及丢弃绘制均为零；正常退出后设备/资源清零。修正后的点精灵反射在9180次点精灵绘制下不再产生缺失UV误报。

新增`python3 tests/glbridge/d3d_3dmark_result.py INPUT.3DR OUTPUT.json`直接解析本地原始结果，保留状态及单位倍率，排除注册码、评论与机器清单；已用03/05实际文件校验。保留原始Checksums Valid=No，不作为官方认证成绩。详细证据见 `fixtures/d3d-review/stage6-5-validation.json`。06、03声音范围、跨后端比较、99旧分支性能及完整Wine/API验收继续开放。

### 3DMark06完整Metal验收（2026-11-06）

Advanced Edition 1.2.0完成全部19项：2 SM2游戏、2 HDR/SM3游戏、2 CPU、7功能及6批量绘制。1280×1024、无AA、Optimal、VS/PS 3.0，保留默认硬件深度阴影、后处理与浮点过滤。总分1961，SM2分900、HDR/SM3分1197、CPU分323；游戏为7.62/7.38/15.19/8.75 FPS，CPU为0.108/0.156 FPS。CPU项目完成了自身固定帧数，不将其低帧率误报为挂死。结果24行包含19测试、4分数及独立交互小游戏的Game Score N/A；最后一项不属于所选基准测试。

逐场景核对游戏/CPU、填充、像素/顶点、粒子、Perlin及批量绘制。粒子测试只有250帧，5秒定时截图漏过实际画面；补跑保存可见暂停帧和9个GPU后缓冲帧，确认粒子从展开到环状演变正常，6张浮点位置/速度纹理无NaN/Infinity。呈现回调中的同步画布截图早于合成更新，属于旧桌面图，未用作验收依据；未为此修改着色器。浏览器/宿主/GPU、失败命令、丢弃绘制和着色器错误均为零，正常退出后设备/资源清零。原始全程统计与后续诊断分开保存。

解析器补充06设置名称白名单，仍排除注册码与机器清单。此轮为兼容性验收，期间有少量只读检查/低优先级编译，分数不作为严格性能对照。详细证据见 `fixtures/d3d-review/stage6-6-validation.json`。03声音、99旧分支性能、跨后端及完整Wine/API验收仍开放。

### 99旧分支完整对照与第二批性能修复（2026-11-06）

以相同800×600、16位颜色/Z、三缓冲、VSync Off、P3、1GiB和CPU Worker设置完成旧组合26项：v86 master `87d26deb` + 站点main `43c4d1e`，赛车26.2、第一人称2.2 FPS，总分401。旧宿主仅补充记录队列上限避免OOM，保留全部记录，未改客体/绘制/着色器；因此不是完全无改动的运行环境。旧宿主缺少结构化GPU错误收集，未虚构该项零错误。

独立性能采样显示宿主约89%空闲，客体热点涉及裁剪/顶点处理。把另外两处逐顶点16字节复制改成保持位模式的标量读写，完整26项达到 **24.6/14.7 FPS、1842分**（上批22.7/12.4、1605分）。9张全尺寸质量图除64行元数据外逐字节一致；浏览器/宿主/GPU、失败命令、丢弃绘制及着色器错误均为零，正常退出后设备/资源清零。赛车仍比本次旧分支平均慢约6.1%，没有用CPU分数归一化或瞬时FPS宣称追平。

25万组差分与内存安全检查通过；真实XP三API裁剪检查通过，D3D7与100行独立原生记录一致。项目测试中“多流不支持”的过时断言改为明确的左平面1/1结果，并以顶点程序保留过期状态拒绝检查。一个FVF布局缓存候选实测变慢，已完全撤回；一次被窗口操作打断的运行保留为诊断，不计验收。

发布准确验收的DDraw零售DLL及同源8/9、诊断构建；六版历史验收仍保留各自原始DLL哈希，不冒充新二进制重跑。详细证据见 `fixtures/d3d-review/stage6-7-validation.json`。剩余赛车差距、03声音、完整Wine/API与跨后端核对继续开放。

### 完整Wine视觉审计与首批语义修复（2026-11-06）

新增固定Wine提交的完整D3D8 visual、D3D9 device/visual及DirectDraw1/2/4/7原版套件；七份均可编译，测试源与期望值保持原样。MinGW补充声明只恢复缺失的Windows ABI，不伪造功能。XP运行器支持长套件，开始运行后超时不会重复启动并污染日志；最终运行记录DLL、EXE及16份宿主脚本哈希。

完整D3D8 visual首次143,588项检查、66失败、18跳过。修复共享Clear的空矩形参数、VS1.x标量分量与LOGP结果、凹凸映射的alpha传递、关闭高光生成后的顶点高光透传，并补齐API8漏报的四种已实现混合能力。最终143648项、**57失败、14跳过**，五组相关原版函数没有剩余失败/跳过；GPU/宿主错误为零。完整套件仍为FAIL，退出前一个残留资源仍开放，不以owner回收掩盖。

完整D3D9 visual因D16_LOCKABLE读回失败而在后续访问中崩溃，未形成完成摘要，明确记为CRASH；其余新增套件此批只有编译结果。52项着色器、179项执行器、199份naga编译、62,403项能力断言及16/16变异检查通过；实际XP能力/生命周期回归通过，但该探针模拟读回，像素证据由完整Wine GPU运行提供。原能力表基线未改，项目比较明确增加四个经像素验证的能力位。

发布准确验收的D3D8零售DLL、同源其余DLL与WebGPU版本ddae32c450159e67526a。此前六版3DMark记录仍对应原始版本，本批不冒充新版本完整重跑。详细失败函数、日志哈希、清理和版本证据见 `fixtures/d3d-review/stage6-8-validation.json`。深度/视口、脏区与mip上传、雾/光照、透明混合、其余完整套件、跨后端、03声音及99赛车差距继续开放。

### 着色器输入、退出清理及独立数值校验（2026-11-06）

API8现在拒绝读取声明中不存在的输入寄存器，且在分配布局/着色器前返回失败；常量和注释中的位模式不会误判为输入。设备最终退出改为先退役raw8着色器元数据，再提交全部资源及设备销毁命令。完整D3D8 visual为143,648项检查、**54失败、14跳过**，较上一批准确修复3项输入校验；退出到owner回收前设备/资源已为零，GPU/宿主错误为零。中间一次52失败来自原版同步测试因计时计算而跳过，未算作修复。

**更正上一批LOGP修改**：微软文档和Wine后端均要求复制同一对数到四个分量；上一批改成指数/尾数元组是不正确的，原Wine样例的w=2未能区分。现已恢复复制语义，同时保留VS1.x经swizzle后的w选择和EXPP自身元组语义。新增非单位输入/分量/写掩码组合，独立CPU参考23,392次执行、本机Metal和SwiftShader各731程序/93,568分量全部通过。软件后端首次超过60秒，延长为240秒后相同检查通过，没有放宽数值阈值。该数值证据不等于完整Wine或3DMark新版本重跑。

原版DirectDraw1在旧设备查询表面接口失败后崩溃，记为CRASH。D3D9 device首次被Win7+的K32GetModuleInformation导入阻止启动，没有API覆盖；已改为XP的PSAPI入口并核对导入表，重新执行中。运行器新增定期画面和批次数，避免把加载错误弹窗误认为长时间测试。原版套件源与期望值未修改。

输入校验1,043项、23/23变异；清理1,940,563项、19/19变异；目标生命周期2,000项；实际Device8前端生命周期63,308项；52项着色器及站点集成2/2通过。发布六份同源DLL（D3D8零售为准确验收文件）与WebGPU版本560cc857c38792ddb3bd。两次完整D3D8审计仍对应旧LOGP宿主；新组合完整重跑、54项失败、其余完整套件、03声音、跨后端及99赛车差距仍开放。证据见 `fixtures/d3d-review/stage6-9-validation.json`。

### 空颜色目标、目标alpha与压缩纹理边界（2026-11-06）

范围更新：用户确认03的三项声音测试记为未完成，先完成其余验收，本轮不扩展音频实现。

补齐NULL渲染目标的创建及锁定：保留其逻辑格式，锁定只提供有边界检查的临时存储，不读取或上传不存在的颜色。RGB/XRGB混合现在按目标alpha恒为1计算，并逐MRT区分；管线缓存包含不透明目标掩码，Reset保留后缓冲格式。非4对齐边长的ATI1/2、DXT1—5二维/立方纹理在宿主展开为RGBA8，保留原尺寸、mip、UV和通道；正常对齐的压缩路径不变。GPU失败时先记录当前错误快照，避免使用失败前的零错误统计。

最终组合在Metal和SwiftShader各通过**1,179项像素检查**，CPU块解码42,525像素通过；目标生命周期2,399项、12/12变异，锁定88,505项、35/35变异，纹理后端25,069,994项、设备清理1,940,563项、执行器179项及站点集成2/2通过。发布六份DLL和WebGPU版本ce2e3593ba41e7d3dcb9。

完整D3D8 visual在更正LOGP及目标alpha后为143,648检查、**53失败、14跳过**；本批修复一个混合断言，GPU/宿主错误及owner回收前资源均为零。此审计早于压缩边界补丁和等价掩码表示，最终组合由上述两后端像素检查覆盖，未冒充完整套件重跑。

D3D9 device已越过NULL目标崩溃与非对齐BC纹理GPU错误；最新运行GPU/宿主错误为零，但在CPU-only压缩体纹理创建失败后崩溃，记录**1,770条失败断言，无完整摘要**，退出回收前仍有2设备/13资源，不能算通过。中间两次GPU中止保留为失败记录，其中旧快照漏记最后批次的问题已修复。体纹理、压缩GPU读回、其余API/视觉失败、03声音、跨后端、99赛车差距及受影响基准重跑继续开放。详细版本与证据见 `fixtures/d3d-review/stage6-10-validation.json`。

### CPU体纹理、状态块空声明及验收口径（2026-11-06）

API9的SCRATCH体纹理改为CPU存储，创建/锁定/销毁不发送GPU命令，绑定时拒绝并保留原状态；补齐DXT创建/部分锁定的块边界。API8行为单独保留。ATI压缩GPU体纹理原先宣称支持，但宿主明确拒绝压缩3D存储；本批纠正该能力查询，CPU scratch仍可用，**未声称实现ATI体纹理采样**。API9状态块捕获NULL顶点声明后Apply不覆盖当前声明，API8仍保留显式清空规则。

完整D3D9原版测试已通过此前崩溃的`test_volume_blocks`和`test_vdecl_apply`，推进到着色器校验器；缺失`Direct3DShaderValidatorCreate9`导出导致空函数调用崩溃。最新记录3,830条失败断言、7项skip，**无完整摘要，仍为CRASH**；GPU/宿主错误为零，退出回收前仍有3设备/24资源，不能算通过。失败条数增加来自覆盖更多后续测试。最终发布构建另保留了API8空声明分支，由兼容档案回归验证，不冒充完整Wine新版本通过。

体纹理创建16,572,915项、锁定4,312,230项、36/36变异；体纹理生命周期53,888项、14/14变异；状态绑定682,442项、38/38变异；清理1,923,814项、19/19变异；格式查询1,653,415项和站点集成2/2通过。完整Wine验收器新增准确位置/消息/次数及证据校验，并绑定源码哈希；未审查skip、缺失功能及真实失败仍不通过。

用户调整顺序前已完成99新版26项：图形1876、CPU9378、赛车25.3/第一人称14.9FPS；9张完整质量图去除64行元数据后与上次验收逐字节相同，DLL匹配、错误为零、正常退出设备/资源清零。这只是已完成的历史证据，正式四版新旧性能比较仍须等Wine通过后进行。详见`fixtures/d3d-review/stage6-11-validation.json`。

### 原版D3D9测试首次完整结束与资源接口修复（2026-11-06）

本批补齐着色器校验器导出，委托XP系统原生D3D9提供CPU字节码诊断；加载使用绝对系统路径，保留模块寿命并检查路径越界、递归及并发加载。GPU渲染仍由代理实现。部署须保留系统原生d3d9.dll；将代理覆盖系统原生DLL时，该委托不可用。设备真实初始化路径保留BFME Online Arena使用的x86接口表定位序列，原版Wine验证其Present地址与实际设备一致。

资源接口修复包括八类共享句柄请求按XP返回E_NOTIMPL、VB/IB拒绝SCRATCH、缓冲区16字节对齐并保存原始分配地址、查询失败保留输出，以及普通DXT表面尺寸校验。格式回归发现的DXT/YUV混淆已纠正并重新验收。

最终发布DLL的原版D3D9 device测试**完整结束，仍未通过**：157,123项检查、2,834条失败、9项未审查skip、退出255。着色器校验器、设备接口表定位、共享句柄、查询支持、顶点缓冲对齐五组已无失败。GPU/宿主错误为零；进程结束前仍有2设备/13资源，强制回收后的零不能代替正常释放验收。仍需修复纹理布局、锁定、裁剪平面、复制、窗口和其他API行为，以及其余Wine套件。

32项加载器检查、30/30缓冲创建变异、27/27绑定生命周期变异及纹理/表面/清理回归通过。六个DLL及本地工具镜像已重建，证据与哈希见`fixtures/d3d-review/stage6-12-validation.json`。执行顺序保持Wine适用测试全部通过后，再做99/2001SE/03/06正式新旧性能对比；本批不声称图形分数无回退。

### 连续纹理存储、裁剪平面与表面复制约束（2026-11-06）

API9 CPU池的二维/立方纹理mip改为连续存储，保留面间16字节边界、自动mip可见级数、溢出及分配失败的原子释放；ATI1/ATI2的公开pitch转换仍待实现。API9越界裁剪平面索引映射到最后一项，记录状态块时不改动实时状态；API8仍拒绝越界。颜色StretchRect补齐同设备、DEFAULT池、filter及目标角色约束，只允许复制到RT或普通离屏表面之间复制；API8与深度复制路径分开保留。

原版Wine显示裁剪平面582条失败消除、普通纹理布局549条失败消除；剩余366条mip失败均来自ATI格式。最终复制规则重跑中`test_stretch_rect`477条失败也消除。完整D3D9检查157,123项，仍有**1,226条失败、9项未审查skip，验收未通过**。GPU/宿主错误为零，进程结束前仍有2设备/13资源，继续阻塞验收。

实际构造器矩阵、内存安全检查、复制/裁剪规则和生命周期回归通过；故障注入验证见`fixtures/d3d-review/stage6-13-validation.json`。最终发布D3D9 DLL与完整XP重跑哈希一致，六个DLL及本地工具镜像已重建。正式四版新旧性能比较仍等待Wine适用测试全部通过。

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

### ATI压缩格式与CPU映射验收（2026-11-06）

ATI1/ATI2的公开字节步长、连续mip偏移与GPU压缩块传输步长分别计算，分配空间覆盖最后一个完整压缩块。API9 CPU池保留XP允许越界矩形的映射语义，但上传只访问自身分配的有效存储；DEFAULT静态普通纹理拒绝锁定，普通离屏表面的私有存储仍可锁定。

原版D3D9完整执行157,919项，失败从1,226降至466；`test_surface_blocks`与`test_miptree_layout`均零失败。9项skip尚未逐项审查，GPU/宿主错误零，结束前仍有2设备/13资源，**Wine验收未通过**。构造、锁定、内存安全、生命周期及56项故障注入检查通过；六个DLL和工具镜像重建，发布D3D9与完整XP运行哈希一致。记录见`fixtures/d3d-review/stage6-14-validation.json`。继续修复GDI绘图、资源和窗口等剩余问题；正式性能对比等待Wine适用项通过。
