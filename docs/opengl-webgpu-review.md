# OpenGL 代理 → WebGPU 代码审查与重构建议

审查对象：Windows XP 客体的 `opengl32.dll` 代理（OpenGL 1.1–2.1 + WGL），以及宿主的 `gl-webgpu` 执行器、GLSL/ARB 翻译器和固定管线生成器。
基线：v86 `e92fd4f0`（`ios6` 分支；`gl-webgpu/` 中只有 `gl_shader_translator.js` 与 `master` 不同，多了 GLES 3.x L0 的 240 行），retro-gaming-site `43c4d1e`。日期 2026-10-29。
性质：只读审查，没有改动代码；本文尚未提交。它是 [`d3d-webgpu-review.md`](d3d-webgpu-review.md) 的姊妹篇。两条路径共用 `v86gl.sys`、`v86gl_device.js`、`graphics_proxy.js`、`v86_network_bridge.js` 和 `webgpu_host.js`，交叉问题在文中注明。

## 0. 结论摘要

1. **站点默认配置下，OpenGL 的同步查询全部失效。** ✅
   - 站点和 VM 管理器都默认 `cpu_worker: true`。这种模式下设备把批处理复制一份交给页面，然后立即完成客体的 virtio 请求。
   - 执行器把 glGetError、glGetString、glGetUniformLocation、编译/链接状态、glCheckFramebufferStatus 等答案写进那份副本，不写回客体内存。客体在 IOCTL 返回后立刻读记录，读到的永远是 PENDING。
   - 后果：
     - 所有 GLSL 程序都报编译或链接失败；
     - `glGetUniformLocation` 返回 -1；
     - 每次 `glFinish` 都置 `GL_INVALID_OPERATION`；
     - 宿主能力查询失败，浮点纹理、各向异性等扩展永不宣称；
     - 轮询 `GL_QUERY_RESULT_AVAILABLE` 的程序死循环。
   - 这条路径从未被测过：worker 模式的测试把 `pushPCIBatch` 打桩了，worker 浏览器测试只画了一个 D3D9 三角形。
   - D3D9 不受影响：它的查询答案经 `writeGuestMemory` 写进响应槽（`d3d9_executor.js:4565-4580`），客体轮询状态字。GL 当初的设计依赖“批处理字节就是客体内存的别名”，CPU worker 引入复制后，这个前提就不成立了。

2. **错误不可见，一次失败就永久失去图形。** 这一点与 D3D 审查的 S1-1、S1-4 相同，而且 GL 路径上更容易触发。
   - 宿主没有任何 WebGPU 错误捕获，无效的管线和 bind group 被永久缓存。本次找到 10 种以上常见 GL 状态就能触发的无效构造（S1-2）。
   - 任何非 `GLStreamError` 的 JS 异常都会从 `executeBatch` 抛出，在 worker 模式下导致 `setAvailable(false)`，本会话永久失去 GL。
   - 客体在 IOCTL 失败后设置 `g_v86gl_failed`，永久生效。此后每个 GL 调用都强制走 `OutputDebugStringA`：没有调试器时，每行都触发一次 first-chance 异常。立即模式的游戏因此不是“黑屏”，而是“卡死般地慢”。

3. **一批基础语义是错的，现有测试一个也测不出。** 下面每一项我都读通了代码，带 GPU 标记的在真 GPU 上复现过：
   - 法线矩阵是 modelview 的**逆**，不是逆转置。旋转过的模型光照方向全错，GLSL 的 `gl_NormalMatrix` 同样受影响；
   - `GL_QUAD_STRIP` 每个四边形的第二个三角形反绕（GPU：开背面剔除后缺 1/4 像素）；
   - flat 着色的引发顶点用的是第一个，GL 规定用最后一个（GPU）；
   - 关闭 `GL_STENCIL_TEST` 后，管线仍带着旧的模板函数和操作；
   - 视口超出窗口时被压扁而不是裁剪（GPU）；
   - `glDepthRange(n > f)` 被 WebGPU 拒绝；
   - `GL_CONSTANT_ALPHA` 实际用的是常量颜色的 RGB；
   - `glLightiv`/`glMaterialiv` 把所有分量都除以 2³¹−1，聚光角 45° 变成约 0°；
   - 固定管线上未完整的纹理采样成黑色，GL 规定该纹理单元直接失效（GPU）；
   - `glTexImage2D(NULL)` 之后 `glTexSubImage2D` 返回 `INVALID_OPERATION`，什么都不上传；
   - `GL_BGRA` + `UNSIGNED_INT_8_8_8_8_REV`（WineD3D 上传 A8R8G8B8 的方式）红蓝互换；
   - 6 个用户裁剪平面只有前 4 个生效；
   - 线框模式画出四边形的对角线（GPU）；
   - 线、点开着 `POLYGON_OFFSET_FILL` 时整帧丢失（GPU：Chrome 拒绝 depthBias）。

   以 macOS 自带的 OpenGL 2.1 为参照的 54 个像素场景中，我们通过 22 个、失败 32 个（附录 C）。通过的部分很整齐：texenv 全部模式与 combine、雾、alpha 测试、逻辑运算、模板、清除、多边形偏移、点画、拷贝路径、渲染到纹理、累积缓冲、剔除、GLSL 的标量语义、ARB 的指令语义，都与 Apple 一致。错误集中在顶点阶段、图元装配、ARB 前端、读回，以及 WebGPU 没有原生对应物的状态。

4. **客体与宿主各有一套 GL 状态机，互不同步。**
   - 宿主自称“权威”，但客体也保存了几乎整个 GL 上下文：每次切换上下文复制约 85 KB 快照，外加每张纹理每级和每个缓冲的 CPU 副本。客体用这份影子决定丢弃哪些调用、走哪条路径，并在本地回答一部分 `glGet*`。
   - 显示列表、按纹理单元的状态、GPU 写入的状态都没有同步机制。表现为：
     - 显示列表把 GL 规定必须立即执行的命令（`glPixelStorei`、`glBindBuffer`、`glDeleteTextures`……）也编进列表；
     - `GL_COMPILE` 只改客体影子，不改宿主；
     - 列表内容在调用时而不是编译时取值。
   - `GL_SELECT`/`GL_FEEDBACK` 是占位实现：不变换、不裁剪，每个图元都算命中，深度恒为 0 和 0xFFFFFFFF。拾取总是返回所有对象。
   - GLES 方案（`src/gles/`）当初明确选择了另一种架构：CPU 侧影子回答查询，页面只负责渲染。它的理由正是 `gl_executor.js` 的同步权威模型“不适合”。本文建议 XP 的 GL 路径向它收敛（§7 阶段 3）。

5. **测试体系的问题比 D3D 更严重。**
   - 22 个一行语义变异，测试只杀死 7 个。固定管线测试 0/5，ARB 测试 0/2，两个浏览器页 0。
   - 217 个 opcode 中有 119 个（55%）从未被任何测试解码过，包括 `VIEWPORT`、`ORTHO`、`BLEND_FUNC`、`TEX_SUB_IMAGE_2D`、`STENCIL_*`、`UNIFORM_MATRIX_FV`。
   - 有 5 个测试断言了错误的 GL 行为，例如扇形的引发顶点、未完整纹理采样为黑。
   - CI 没有安装 naga，`gl_shader_wgsl_validation_test.js` 打印 SKIP 后退出 0。
   - 19.7k 行的客体 DLL 没有任何行为测试。
   - 协议一致性测试是循环论证：测试编码器用解码器自己的表构造记录。

6. **文档与代码漂移。**
   - GL 宿主从站点仓库搬到 v86 时（站点 `8bcd2f7`，2026-09-06），偏差清单 `gl-webgpu/README.md`（D-01..D-18）和协议模式 `gl_protocol.json` 被删除，而不是搬走。`COVERAGE.md`、它的生成器和客体 README 仍然链接它们。
   - v86 源码引用的 `docs/opengl-webgpu-implementation-plan.zh-CN.md` 在站点仓库里，不在 v86。
   - `COVERAGE.md` 的 “A = 已实现”只表示存在 handler：`glLineWidth` 是 A，但宽度从未生效。

建议的路线与 D3D 审查一致：先止血并让错误可见（阶段 0），再建测试底座和协议单一来源（阶段 1–2）。之后先决定状态归属（阶段 3，本文最重要的架构决定），再拆分执行器、换翻译器前端、重写客体的显示列表与选择模式。详见 §7。

### 最该先修的十项

| # | 问题 | 见 |
| --- | --- | --- |
| 1 | CPU worker 模式（站点默认）下所有同步答案丢失：GLSL 全部链接失败 | S1-1 |
| 2 | WebGPU 错误零捕获，无效管线/bind group 永久缓存；10 余种常见触发 | S1-2 |
| 3 | 一次 JS 异常 → 本会话永久失去 GL；客体失败后每次调用都触发 OutputDebugString | S1-3 |
| 4 | 法线矩阵是逆而不是逆转置，光照方向错 | S2-1 |
| 5 | 模板测试关闭后仍生效、视口压扁、`glDepthRange(n>f)` 被拒、CONSTANT_ALPHA | S2-6、S2-7、S1-2(d)、S2-8 |
| 6 | flat 引发顶点、QUAD_STRIP 反绕 | S2-4、S2-5 |
| 7 | `TexImage(NULL)`+`TexSubImage` 失败、BGRA_REV 红蓝互换、未完整纹理采样为黑 | S2-20、S2-22、S2-3 |
| 8 | 显示列表编译规则错误，客体影子漂移 | S2-30 |
| 9 | 上下文和程序以客体进程内编号为键：下一个进程继承上一个的状态和着色器 | S1-4 |
| 10 | 超过 16 MiB 的纹理（2048² RGBA8）被丢弃，却宣称 `MAX_TEXTURE_SIZE` 16384 | S1-6 |

## 1. 范围、方法与标注

### 1.1 审查的代码

| 层 | 文件 | 行数 |
| --- | --- | --- |
| 客体 DLL | `retro-gaming-site/glbridge/openglproxy/opengl32_proxy.c`、`gl_opcode_names.h`、`v86gl_ioctl.h`、`README.md` | 19 747 + 235 + 55 + 213 |
| 内核驱动 | `v86gl_driver/`（与 D3D 共用） | 645 |
| 执行器 | `src/browser/glbridge/gl-webgpu/gl_executor.js` | 9 892 |
| 着色器 | `gl_shader_translator.js`（GLSL 1.10/1.20 → WGSL）、`gl_arb_program.js`（ARB vp/fp → WGSL） | 5 418 + 1 276 |
| 固定管线 | `gl_fixed_function.js`、`gl_state_layout.js` | 1 227 + 446 |
| 协议 | `gl_wire.js`、`gl_constants.js`（自称“生成”，没有生成器） | 193 + 1 109 |
| 共用传输与集成 | `v86_network_bridge.js`、`v86gl_device.js`、`graphics_proxy.js`、`graphics_journal.js`、`webgpu_host.js`、`webgpu_compositor.js` | 约 2 600 |
| 测试 | `tests/glbridge/gl_*`、`webgpu_shared_device_test.js`、`v86_network_bridge_gl_route_test.js`；站点 `glbridge/tests/gl_*.js`、`cube2_gl_proc_coverage_test.js` | 约 5 200 + 1 060 |

`gl_shader_translator.js`、`gl_fixed_function.js`、`gl_state_layout.js` 同时被 GLES 路径使用（`src/gles/glsl_es.js`、`gles1_state.js`、`page/gles1_draw.js`），修改它们会影响 Android/iOS。

### 1.2 方法

- 按层分给 8 个只读审查子代理：
  - 客体核心（传输、WGL、显示列表、选择/反馈）；
  - 客体 API 层；
  - 执行器核心与资源；
  - 绘制路径；
  - 固定管线语义；
  - GLSL/ARB 翻译器；
  - 测试体系；
  - 以 macOS 自带 OpenGL 2.1 为参照的像素一致性原型。
- 判断依据：OpenGL 2.1 规范、GLSL 1.10/1.20、ARB_vertex/fragment_program、EXT_framebuffer_object、Windows `opengl32.dll` 的 WGL 行为、Mesa 的实现（来自记忆，本机没有 Mesa/piglit 源码），以及 WebGPU 校验规则（Chrome/Tint 比 naga 严格）。
- 复现手段：
  - 多位审查员用 Node 探针驱动执行器（mock GPU），或直接调用翻译器；
  - 绘制路径和着色器审查员在本机 headless Chrome（WebGPU/Metal）里用 error scope 确认 WebGPU 拒绝；
  - 测试审查员做了变异实验，并写了一个 15 项的真 GPU 语义探针页；
  - 客体核心审查员用真实的 `v86gl_device.js` 复现了 worker 模式丢答案。
- 参照原型审查员用 macOS 自带的 OpenGL 2.1（CGL，无需下载）做参照，写了 54 个场景，同一份场景描述同时生成 C 参照程序和我们的 VGL2 记录，逐像素比较（附录 C）。
- 我本人复核了约 40 个结论（附录 A），读通了代码路径，并重跑了真 GPU 探针页和整个参照原型：Apple 硬件渲染器、Apple 软件渲染器和我们执行器三份输出都与审查员的逐字节相同，比较结果同为 22 通过、32 失败。
- 有一处我自己先错了：我曾用不读取数组的程序验证 ARB 的 `program.local[0..4]` 区间，以为它能解析；数组一旦被读取就失败（S2-48），审查员的结论成立。
- 子代理的原始英文报告、探针脚本和我的核实记录都在会话共享笔记目录：
  `~/Library/Application Support/Claude/side-session-notes/local_e0809f53-9de5-4887-ac0e-d29f1677b8aa/gl-review/`

### 1.3 标注

- **✅ 已核实**：我本人读通代码路径确认，或在真 GPU 上复现。
- **☑️ 审查员核实**：子代理读通代码路径或运行复现，我没有逐行复核。
- **❓ 可能**：代码行为已看到，但规范语义或触发条件未能核对，或未在客体中运行验证。
- **GPU**：在本机 Chrome（WebGPU/Metal）上用像素或校验错误复现。
- **O**：macOS OpenGL 2.1 参照原型的像素差异确认（附录 C 的场景名），我已复跑。

所有结论都没有在 XP 客体里运行验证。

路径缩写：

| 缩写 | 路径 |
| --- | --- |
| `E` | `src/browser/glbridge/gl-webgpu/gl_executor.js` |
| `T` | `src/browser/glbridge/gl-webgpu/gl_shader_translator.js` |
| `A` | `src/browser/glbridge/gl-webgpu/gl_arb_program.js` |
| `FF` | `src/browser/glbridge/gl-webgpu/gl_fixed_function.js` |
| `SL` | `src/browser/glbridge/gl-webgpu/gl_state_layout.js` |
| `DEV` | `src/browser/glbridge/v86gl_device.js` |
| `GP` | `src/browser/glbridge/graphics_proxy.js` |
| `BR` | `src/browser/glbridge/v86_network_bridge.js` |
| `P` | `retro-gaming-site/glbridge/openglproxy/opengl32_proxy.c` |
| `VT` | `retro-gaming-site/glbridge/v86gl_driver/virtio_transport.h` |

### 1.4 没有覆盖的

- 没有在 XP 客体里运行任何程序。
- 没有逐行读的部分：
  - 客体 1D/3D 纹理、`glTexGen`、`glFog` 的客体侧校验、像素映射表；
  - `wglGetProcAddress` 表的完整性；
  - `window_region.h`、`diagnostic_trace.h`；
  - 合成器自己的设备丢失处理；
  - `gles1_state.js` 的 setter。
- GLES 路径（`src/gles/`）不在本次范围内，只在共用文件处说明影响。

## 2. 架构现状

```text
game.exe
  └─ opengl32.dll（19.7k 行 C，831 个导出，217 个 opcode）
       · 几乎完整的 GL 影子状态 + 每张纹理/缓冲的 CPU 副本
       · 显示列表（字节级录制）、glPushAttrib、软件 GL_SELECT/FEEDBACK、求值器
       │ VGL2 记录（手写 C 结构；gl_protocol.json 已被删除）
       ▼
  v86gl.sys → virtio → v86gl_device.js ──(本地) 别名客体内存 ─────────────┐
                                       └─(CPU worker) 复制 → graphics_proxy.js ┤
                                                                               ▼
                         v86_network_bridge.js → gl_executor.js（“权威”GL 状态机，同步回答查询）
                                                  ├─ gl_shader_translator.js（与 GLES 共用）
                                                  ├─ gl_fixed_function.js / gl_state_layout.js（与 GLES1 共用）
                                                  └─ gl_arb_program.js
```

### 2.1 设计意图正确的部分

- 只有一条 OpenGL 宿主路径，没有回退后端。
- 着色器只在宿主翻译。
- Y 轴只在顶点着色器里翻转一次，视口、剪裁、读回都不必再换算；代价（绕向反转）集中在 `gpuFrontFace` 一处。
- 用 `define(name, handler)` 建 opcode 表，`COVERAGE.md` 由真实表生成。
- 诊断 DLL 默认输出摘要和 opcode 直方图，不需要客体环境变量。

### 2.2 实现上偏离意图的部分

1. **“宿主权威、同步回答”只在本地模式成立。** 它依赖批处理字节别名客体内存（`DEV:191` 的 `subarray`）。CPU worker 模式是复制，答案写不回去（S1-1）。
2. **客体并不薄。** README 说“`v86gl.sys` 只是传输，权威状态机在宿主”。实际上客体 DLL 保留了几乎完整的影子，并据此做决定。两边的状态互相独立，没有任何东西保证一致（§5.1）。
3. **`glPushAttrib` 两边都实现了。** `COVERAGE.md` 把它归为 C 类“无效果，只发送差异”，两半说法都不对。
4. **能力宣称没有代码支撑：**
   - `GL_EXT_texture_lod_bias` 已宣称，但客体对 `glTexEnvf(GL_TEXTURE_FILTER_CONTROL_EXT, …)` 返回 `INVALID_ENUM`，宿主保存了 bias 却从不使用；
   - `GL_ARB_texture_border_clamp` 实际是 clamp-to-edge（D-03 自己就承认）；
   - `MAX_TEXTURE_IMAGE_UNITS` 报 16，实际只有 8 个单元；
   - `MAX_TEXTURE_SIZE` 报 16384，单条记录却装不下 2048² RGBA8；
   - `GL_ARB_multisample` 已宣称，`GL_SAMPLES` 却是 0；
   - `GL_EXT_paletted_texture` 已宣称，却没有 `glColorTableEXT`，`r8uint` 也无法采样。
5. **文档漂移：**
   - 偏差清单 D-01..D-18 和 `gl_protocol.json` 已被删除，`COVERAGE.md`、`tools/gen_gl_coverage.cjs:25,76`、`openglproxy/README.md`、`A:33` 仍引用它们；
   - 源码注释引用的计划文档只在站点仓库；
   - `gl_wire.js`、`gl_constants.js` 自称“生成”，但没有生成器；
   - `E:1807-1809` 的“GL 回退纹理是黑不是白”注释把 GLSL 规则套到了固定管线（S2-3）。
6. **与 GLES 共用文件，但快照逻辑已经分叉。** GLES1 的 `ff_snapshot`（`src/gles/page/gles1_draw.js:93,122`）自己算法线矩阵（正确），并把禁用的裁剪平面清零。XP 路径的 `stateSnapshot` 两样都没做。

## 3. 问题清单（按严重程度）

- **S1**：整帧或整个会话失效、死锁、黑屏、永久失去图形。
- **S2**：常见程序中可见的错误渲染或功能失效。
- **S3**：少见路径或较小偏差。

### 3.1 S1 致命

**S1-1 CPU worker 模式（站点默认）下，客体收不到任何同步答案** ✅（代码路径；客体核心审查员用真实 `DEV` 复现）

- 位置：
  - `DEV:191`：`remote ? raw.slice(HEADER_BYTES) : raw.subarray(HEADER_BYTES)`；
  - `DEV:196-213`：`channel.post` 之后立即返回 OK；
  - `DEV:135-143`：随即 `request.complete()`；
  - `GP:236-258`：worker 模式下的 `done` 只释放 inflight 配额。
- 执行器把答案写进副本：`E:3441-3448`（`QUERY_ERROR`）、`E:3450-3460`（`QUERY_INTEGER`），同类的还有 `E:3496, 3530, 3585, 8989`。
- 客体在 IOCTL 返回后立刻读：`P:5063-5084` 在 `emit_pci_batch`（`P:4453`，不等待）之后读 `args+4`，读到 PENDING 后回退到默认值或报错。
- 默认配置：`src/app/vm_config.js:256` 与站点 `app.js:429` 都是 `cpu_worker: true`。
- 后果（下列客体行号来自客体核心审查员，☑️）：
  - GLSL 编译/链接状态恒为 FALSE（`P:11134, 11153`）；
  - `glGetUniformLocation` 返回 -1 并置 `INVALID_OPERATION`（`P:11269`）；
  - 每次 `glFinish` 都置 `INVALID_OPERATION`（`P:9896`）；
  - 宿主能力查询失败，浮点和各向异性扩展不宣称（`P:8729`）；
  - 轮询 `GL_QUERY_RESULT_AVAILABLE` 的程序死循环（`P:12658-12735`）；
  - Cube 2、WineD3D 的 GLSL 后端都无法工作。
- 页面模式下，渲染器尚未初始化时（`E:2161` 排队）也会这样丢答案。
- 修复方向：
  - 最小改动：客体在批处理头的 flags 里标记“含同步查询”，设备在 worker 模式下对这种批处理推迟 `request.complete()`，直到收到渲染器的 `done`；
  - 结构性改动：见 §7 阶段 3。

**S1-2 宿主没有 WebGPU 错误捕获，无效管线和 bind group 被永久缓存** ✅

- `gl-webgpu/` 与 `webgpu_host.js` 中零处 `pushErrorScope`/`uncapturederror`。共享设备上唯一的监听器属于 SVGA DX 执行器（`gx/gx_executor.js:210`），并且只在它存在时注册。
- 管线和 bind group 的 `try/catch`（`E:7466-7475`、`E:7595-7615`）只能接住同步 TypeError；WebGPU 校验错误是异步的，这里一个也接不住。
- 一帧只有一个 encoder（present 也在里面），所以一个无效对象就让整帧丢失。被缓存的无效管线随后让每一帧都丢失。
- 无效提交中所有遮挡查询读到 0（“被遮挡”），恰好是不安全的那个方向。
- 常见 GL 状态就能触发的无效构造：

| # | 构造 | 位置 | 标注 |
| --- | --- | --- | --- |
| a | 唯一的回退视图是 2D `rgba8unorm`，却被绑到 `texture_cube`/`texture_3d`/`texture_depth_2d`：任何未完整或缺失的立方体、3D、阴影纹理都让整帧丢失 | `E:1801-1814, 7655-7656` | ✅ 代码 + Chrome |
| b | `GL_MIN`/`GL_MAX` 混合保留应用的因子（默认 ONE, ZERO），WebGPU 要求 ONE, ONE | `E:7756-7767` | ☑️ |
| c | 线、点拓扑也设置 `depthBias`（开着 `POLYGON_OFFSET_FILL` 时）：Chrome 报“depthBias must be 0 when using LineList”，同帧之后的三角形也变黑 | `E:7459` | ✅ GPU |
| d | `glDepthRange(n > f)` 原样传给 `setViewport`，WebGPU 要求 min ≤ max；GLQuake 默认的 `gl_ztrick 1` 每隔一帧触发 | `E:2344-2347, 6953-6957` | ✅；O（`depth_range_reversed`：调用之前画的红色四边形也消失，4000 像素） |
| e | 有索引的 `GL_POINTS` 在点大小≠1 或开启点精灵时，着色器声明了 corner 输入，但 corner 缓冲只在无索引时添加；`glPolygonMode(GL_POINT)` 加点大小同样触发（Chrome：“Vertex attribute slot 7 … not present in the VertexState”） | `E:6866-6867` vs `E:7067-7068`、`FF:381` | ✅；O（`polymode_point`） |
| f | `gl_FragColor` 或 ARB 片段程序只有一个输出，管线却对每个 draw buffer 建目标且 writeMask 非 0；GL 的广播语义也缺失 | `T:5241`、`E:7123, 7414` | ☑️ Chrome |
| g | `GL_COMBINE` 的 crossbar 源指向未启用的单元：`texN` 未声明，WGSL 无效（Chrome：“unresolved value 'tex1'”） | `FF:1043-1046` vs `FF:800-806` | ☑️ naga；O（`texenv_crossbar_unit1_off`；首轮里同帧 10 个 combine 方块全部丢失，包括在它之前画的） |
| h | 立即模式下通用属性 0 不别名 `glVertex`：`glBindAttribLocation(p, 0, …)` 让同一位置出现两个属性 | 绘制路径 B8 | ☑️ |
| i | `glReadPixels` 不裁剪源矩形：越界拷贝被拒，状态却报 OK（见 S1-7） | `E:8836` | ✅ GPU |
| j | 比较模式为 NONE 的深度纹理按 `texture_2d<f32>` 绑定；`sampler2D` 读 `depth32float` | `E:7656` | ☑️ Chrome |
| k | 向 RGBA32F FBO 混合 | — | ❓ |
| l | 合法 GLSL 生成非法 WGSL（保留字、`1.0/0.0` 常量等，见 S2-40），链接状态却是 TRUE | `T` | ✅ naga（部分） |

**S1-3 一次异常 → 本会话永久失去 GL；客体失败后每次调用都触发 first-chance 异常** ✅

- 宿主：`E:2217-2233` 只捕获 `GLStreamError`，其它异常重新抛出，批处理剩余部分（包括客体等待的答案）全部丢弃，`beat()` 也不写。
  - worker 模式：`GP:250-253` 调用 `setAvailable(false)`，没有任何东西再把它打开；`DEV` 随后回答 `NO_RENDERER`。
  - 本地模式：设备回答 INVALID。
- 客体：`P:4511-4514` SUBMIT 失败后关闭设备并设置 `g_v86gl_failed = TRUE`。之后每次打开传输都走 `v86gl_error`（`P:4208-4211`），强制分支调用 `OutputDebugStringA`（`P:1504-1507`）。没有调试器时，每行一次 first-chance 异常，发行版 DLL 也一样。
- 驱动轮询超时（`VT:263`，即 D3D 的 S1-3）也会走到这里。
- 已知的 TypeError 触发：
  - `glClearStencil(-1)`：`stencilClearValue` 为负时同步抛出；
  - 向尚未定义 +X 面的立方体面，或在 0 级之前向 >0 级 `glCopyTexImage2D`（`E:8756`）；
  - `COMBINE_ALPHA = DOT3_RGB`：固定管线生成器抛出（`FF:1124`），客体和宿主都不校验这个枚举；
  - 翻译器内部异常（不是 GLSL 错误的那种），GLES 路径会捕获，XP 路径不会。

**S1-4 上下文、共享组和程序都以客体进程内的编号为键** ☑️（关键代码 ✅）

- 上下文和共享组 ID 是客体进程内计数器（`P:7778, 8115`），每个进程都从 1 开始。
- 被杀掉的进程不发 DETACH/DESTROY，下一个 GL 进程就继承它的上下文：启用位、矩阵、纹理，审查员复现时 `DEPTH_TEST` 仍是开的。
- 反过来，每次正常 DETACH 都发一条没有载荷的 DESTROY，它会清掉所有上下文（`E:2031`）。
- GLSL/ARB 管线缓存的键只有 GL 程序名（`E:7214-7215`，以及 `E:7117, 7181`），没有共享组、链接序号或源码散列，`destroyContext` 也不清缓存。所以同一会话里第二个 GLSL 程序会用上第一个程序的着色器；重新指定 ARB 程序字符串也会复用旧的 WGSL。
- `activeQuery` 在 `destroyContext` 后仍然保留，之后每次 `glBeginQuery` 都返回 `INVALID_OPERATION`，直到页面重新加载。
- `isContextFreeTeardownNoop` 是一个只为 GLView 加的特例，掩盖了这个问题（§4）。
- 这是 D3D S1-10（从不发 `SESSION_END`）在 GL 上的对应问题，而且更严重。

**S1-5 设备丢失后无法恢复** ☑️

- `onDeviceLost`（`E:1841`）保留了旧设备上的 present 管线（于是每帧都失败），以及拷贝、mip、blit 管线、遮挡查询集、renderbuffer 纹理和打开着的 encoder/pass。
- VBO 被置为 null 且不再重建，绘制路径直接跳过它们（`E:5933`）。
- 每次恢复都会再注册一个丢失处理器。
- 根因：延迟创建的 GPU 缓存没有统一的所有者（§5.2）。

**S1-6 单条记录不能超过 16 MiB，大纹理被丢弃** ✅

- `P:4546-4553`：记录大于“arena − 描述符”时置 `GL_OUT_OF_MEMORY` 并丢弃，不分带。
- 2048² RGBA8 恰好 16 MiB，加上头部就超过上限；纹理载荷还包括跳过的行和行长填充。
- `E:9772-9773` 却报告 `MAX_TEXTURE_SIZE = min(16384, 适配器上限)`，本机是 16384。
- 这是 D3D S1-12 在 GL 上的对应问题。

**S1-7 读回失败与超时** ☑️

- `mapAsync` 被拒时从不写 FAILED（`E:8873`），客体每次都要等满 5 秒（`P:4645`）。
- 越界或跨窗口边缘的 `glReadPixels` 返回状态 OK，但像素全零，窗口内的部分也是零（✅ GPU）。
- worker 模式下，客体超时后会重用 arena，宿主迟到的写入却仍写到旧记录偏移（`E:8862-8871`），覆盖客体正在构建的批处理 ❓。
- 心跳写在 arena 偏移 16 MiB − 48 处（`E:2281-2296`、`DEV:205`），这在 GL 客体的命令区内。GL 客体从不预留这块“响应区” ❓（只在接近 16 MiB 的批处理上才会撞到）。

### 3.2 S2 严重

#### 固定管线与绘制状态（宿主）

| # | 问题 | 位置 | 后果 | 标注 |
| --- | --- | --- | --- | --- |
| S2-1 | 法线矩阵是 modelview 的逆，不是逆转置 | `E:334-361` + `SL:46-54` + `FF:409` | 绕 z 轴旋转 90° 时 `N*(1,0,0) = (0,-1,0)`，应为 `(0,1,0)`；剪切矩阵同样错。只有对角缩放是对的，所以测试测不出。所有带旋转的固定管线光照、SPHERE/REFLECTION/NORMAL_MAP 纹理坐标生成，以及 GLSL 的 `gl_NormalMatrix` 都受影响。GLES1 用自己的正确实现 | ✅ 数值；O（`light_normal_matrix`：Apple 212,122,66，我们 28,15,15；`glsl_normal_matrix`：应为 127,255,128，我们 128,0,128） |
| S2-2 | `GL_RESCALE_NORMAL` 公式错：用 modelview 第三列的长度，应为 M⁻¹ 第三行 | `FF:412-417` | 均匀缩放 s 时法线长度变成 1/s²（`glScalef(2)` 暗 4 倍）；GLES1 共用这段代码 | ☑️；O（`light_basic`） |
| S2-3 | 固定管线上启用的单元若纹理未完整或未绑定，采样为不透明黑 | `E:7253-7261, 7656` | GL 规定该单元直接失效（Mesa 跳过它），只有着色器才得到 (0,0,0,1)。只上传 0 级而用默认 mipmap 过滤，或启用 `GL_TEXTURE_2D` 却绑定纹理 0，都画成黑色。默认纹理对象 0 也没有实现：绑定 0 时 `glTexImage*`/`glTexParameter*` 返回 `INVALID_OPERATION`（`E:4188, 4338, 4398`） | ✅ GPU；O（`mipmap`：Apple 输出顶点色 51,204,102，我们 0,0,0） |
| S2-4 | `GL_QUAD_STRIP` 第二个三角形 `(b+3,b+1,b+2)` 反绕 | `E:500-510` | 开背面剔除时每个四边形缺一半（gluCylinder、gluSphere、glutSolidTorus、客体自己的 `glEvalMesh2`）；双面光照把这一半当背面 | ✅ GPU；O（`primitives`、`strip_winding_cull`：平滑四边形带内部出现三角形空洞） |
| S2-5 | flat 着色的引发顶点：WGSL `flat` 取第一个顶点，GL 取最后一个 | `E:473-537` | TRIANGLES、TRIANGLE_STRIP、LINES、LINE_STRIP 从不重排；扇形把 i+1 放首位，应为 i+2；flat 标志按槽位生效，会把同槽的雾坐标或 1D 纹理坐标也变成 flat | ✅ GPU；O（`flat_provoking`、`flat_lines`、`draw_elements`；QUADS 和 POLYGON 是对的） |
| S2-6 | 关闭 `GL_STENCIL_TEST` 时，管线键写 “off”，描述符却总是带上当前的模板函数和操作 | `E:7387` vs `E:7457-7458, 7777-7791` | 状态取决于历史：Q3 模板阴影、阴影体、镜面、WineD3D 在关闭模板测试后仍丢片段、仍写模板 | ✅ |
| S2-7 | 视口被夹到目标内并缩小宽高 | `E:6950-6956` | 部分超出窗口的视口被压扁而不是裁剪（Chrome 接受超界视口，这个夹取完全没必要）；像素矩形用未夹取的视口，二者错位 | ✅ GPU；O（`viewport_offscreen`） |
| S2-8 | `GL_CONSTANT_ALPHA` 映射为 `constant`，`setBlendConstant` 原样写 RGBA | `E:405-410, 6968-6972` | RGB 通道用的是常量的 RGB 而不是 A，注释说的“写入常量 alpha”并不存在；常见的 `glBlendColor(0,0,0,a)` 淡出画不出来 | ✅；O（`blend`） |
| S2-9 | `LIGHTIV`/`LIGHT_MODELIV`/`MATERIALIV` 把每个分量都除以 2³¹−1 | `E:2571-2603` | GL 只归一化颜色。位置、`SPOT_CUTOFF`、`SHININESS`、`COLOR_CONTROL` 都错（例如 SEPARATE_SPECULAR 变成 0）。客体缓存的是原始整数（`P:15683-15715`），两边对 glGet 的回答也不一致；`TEX_ENVIV` 颜色不归一化，客体 `glFogiv` 原样传 `FOG_COLOR` | ✅；O（`light_integer_params`） |
| S2-10 | 用户裁剪平面：`clipDist` 是 vec4，循环 `i < 4`；计数取“最高启用编号 + 1”，中间禁用的平面仍用旧值裁剪；眼空间 w 固定为 1 | `FF:451-459`、`E:7060-7062, 8106` | 宣称 6 个，只有 4 个生效；先设后禁的平面仍在裁剪 | ✅；O（`clip_planes`；平面本身的变换是对的） |
| S2-11 | 关闭光照时忽略 `GL_COLOR_SUM`；ARB 顶点程序下按 LIGHTING 而不是 COLOR_SUM 判断 | `FF:282, 306` | 次颜色被取出但从不相加 | ☑️；O（`color_clamp_sum`：Apple 191,191,223，我们 64,128,32） |
| S2-12 | 1D/2D/3D 目标丢弃投影纹理坐标：varying 只带 s,t | `FF` | 纹理矩阵、texgen Q、`glTexCoord4` 的 q 丢失；只有阴影单元除 q，而 `max(q,1e-8)` 又破坏 q<0 | ☑️；O（`projective_texcoord`、`texgen`） |
| S2-13 | `COLOR_MATERIAL` 从不把当前颜色写回材质 | `E` setter | `glDisable(GL_COLOR_MATERIAL)` 后物体回到旧材质，`glGetMaterial` 也是旧值 | ☑️；O（`light_twoside_colormaterial`） |
| S2-14 | 线框模式：画出三角化后的对角线，忽略边标志；转成线之后再剔除，WebGPU 不剔除线，`front_facing` 恒为真；`POLYGON_OFFSET_LINE/POINT` 从不读取 | `E:596-607, 6827-6843` | CAD 线框/消隐视图错误 | ✅ GPU（对角线）；O（`polymode_line`、`polymode_front_line_back_fill`） |
| S2-15 | 光栅位置：只检查 w≠0，不裁剪（相机后方的标签镜像绘制）；窗口 z 忽略 `glDepthRange`；`glBitmap` 用调用时的颜色而不是 `glRasterPos` 时锁存的颜色；客体回答 `GL_CURRENT_RASTER_POSITION` 用未变换坐标且恒为 VALID | `E:9473-9497` | 文本和 HUD 位置、颜色、深度错误 | ☑️；O（`drawpixels_bitmap`：无效光栅位置仍然绘制） |
| S2-16 | `glDrawPixels`/`glBitmap` 被视口裁剪；`glCopyPixels` 不裁剪源矩形，产生越界拷贝 | `E:8994-9077` | 像素操作丢失或整帧失败 | ☑️ |
| S2-17 | 关闭光照时不钳制顶点颜色 | `FF` | `glColor3f(2,2,2)` + MODULATE 过亮 2 倍 | ☑️；O（`color_clamp_sum`；GLSL 的 `gl_FrontColor` 同样不钳制，`glsl_semantics`） |
| S2-18 | 点参数：`POINT_FADE_THRESHOLD_SIZE` 从不使用；点大小为 1 时忽略距离衰减和 `POINT_SIZE_MIN`；`glEnable(GL_POINT_SPRITE)` 写的是当前单元的 COORD_REPLACE；`gl_PointSize` 只在 glPointSize≠1 或开启精灵时生效；扩展后的点还会被面剔除 | `E:4004, 4126` 等 | 粒子消失或大小错误 | ☑️ |
| S2-19 | 关闭的数组的常量值被当作单元素的 instance-step 缓冲上传 | `E:5991-6013` | VBO 宽点每点一个实例，第 i 个点读到垃圾颜色，靠近 ring 页尾时校验失败；应改用 `arrayStride: 0` | ☑️ Chrome |

#### 资源、上下文与读回（宿主）

| # | 问题 | 位置 | 后果 | 标注 |
| --- | --- | --- | --- | --- |
| S2-20 | `glTexImage*(NULL)` 不保存影子，之后的 `glTexSubImage*` 以 “level has no storage” 返回 `INVALID_OPERATION` | `E:4417-4456` vs `E:4466-4470`；客体 `P:13552+` 发 0 字节 | 模拟器、视频、字体图集、光照贴图图集都画不出来；`glCopyTexSubImage` 之后的级别同样如此 | ✅ |
| S2-21 | 完整性判断忽略 `BASE_LEVEL`/`MAX_LEVEL`；0 尺寸的 mipmap 基级也算完整 | `E:4612-4635` | 只有 0 级、`MAX_LEVEL=0`、默认过滤的纹理采样为黑；立方体纹理则整帧丢失（S1-2a） | ✅ 代码（完整性检查总从 0 级开始、mipmap 过滤时要求完整链；参照原型确认的是视图按 BASE/MAX_LEVEL 选级正确，二者不矛盾） |
| S2-22 | 打包像素类型忽略 `format`：`GL_BGRA` + `8888_REV`/`1555_REV`/`4444_REV` 红蓝互换 | `E:780-858`（打包类型在 BGRA 交换之前 `return`） | WineD3D 的 A8R8G8B8 上传颜色错误 | ✅；O（`tex_formats_unpack`：Apple 蓝，我们红） |
| S2-23 | 读回忽略格式、类型和打包状态：`packReadback` 忽略 `PACK_ALIGNMENT`/`ROW_LENGTH`/`SKIP`，奇数宽度的 GL_RGB 读回错位，并覆盖客体预置的填充字节；`GL_DEPTH_COMPONENT`（FLOAT/USHORT）和 `GL_STENCIL_INDEX` 返回的是颜色字节；GL_FLOAT 的 RGBA 写原始字节；`GL_LUMINANCE` 返回 R 而不是钳制后的 R+G+B；浮点附件的 `bytesPerRow = width*4` 太小，触发校验错误。客体按 pack 状态计算大小和拷贝，与宿主的紧凑行不一致 | `E:9656-9694, 8810+, 8828` | 截图、拾取、阴影读回错误；Quake 3 的 `tr_flares` 用 `GL_DEPTH_COMPONENT/GL_FLOAT` 读深度判断光晕可见性 | ☑️；O（`readpixels_formats`：10 次读回错 6 次，例如深度 FLOAT 应为 0.25，我们得到 -8.0e7） |
| S2-24 | 按上下文的状态放在执行器全局：`makeCurrent` 不结束打开的 pass，所以 B 的绘制落进 A 的 FBO，A 的待清除作用到 B；所有窗口共用一个后缓冲和深度目标，尺寸不同的窗口切换时内容被丢弃；`this.queries` 全局共享 | `E:1920-1960` | 多窗口和多上下文程序（编辑器、CAD）画错 | ✅ 代码；☑️ 后果 |
| S2-25 | 宿主的 CPU 影子覆盖 GPU 写入的纹素：任何脏纹理都重传所有有影子的级别（`E:4733`），mip 生成从过期的影子降采样（`E:4802`）；拷贝或渲染得到的 RGB/LUMINANCE/INTENSITY 级别保留源 alpha | `E:4733, 4802` | FBO 渲染到某一级后调用 `glGenerateMipmap` 会覆盖渲染结果 | ☑️ |
| S2-26 | `GENERATE_MIPMAP` 只在 0 级 `TexImage` 时触发，SubImage、CopyTexImage、FBO 渲染都不触发 | `E:4455` | 动态纹理的远处 mip 是旧内容 | ☑️ |
| S2-27 | 纹理单元：宣称 `MAX_TEXTURE_IMAGE_UNITS` 16、`MAX_COMBINED` 24，实际 8 个；`glActiveTexture(GL_TEXTURE8+)` 返回 `INVALID_ENUM`，采样器 ≥8 被夹到 7 | `E:63, 2638, 7640` | WineD3D 按宣称值使用 | ✅（8） |
| S2-28 | draw buffer 状态按上下文而不是按 FBO 保存（宿主和客体都是） | 绘制路径 B9 | 用 `glDrawBuffer(GL_NONE)` 设置的纯深度 FBO 会让下一个颜色 FBO 不写颜色；对窗口帧缓冲的 `glDrawBuffer(GL_NONE)` 被忽略 | ☑️ |
| S2-29 | FBO 边界：删除当前绑定的 FBO 不结束 pass；尺寸不一致报 `INCOMPLETE_ATTACHMENT` 而不是 EXT 的 `INCOMPLETE_DIMENSIONS`；FBO 尺寸缓存过期；没有可用附件的 FBO 打开的 pass 被 Chrome 拒绝；前缓冲渲染（`glDrawBuffer(GL_FRONT)` + `glFlush`）从不呈现 | `E:3194, 8592-8655` | 渲染到纹理的边界情况 | ☑️ / ❓（前缓冲） |

#### 客体 DLL

| # | 问题 | 位置 | 后果 | 标注 |
| --- | --- | --- | --- | --- |
| S2-30 | 显示列表的编译规则错。`emit_gl_call` 在列表打开时录制所有记录（`P:5441-5456`），只有 Push/Pop(Client)Attrib 和 `glCallList` 看模式。GL 2.1 §5.4 规定立即执行、不进列表的命令（`glPixelStorei`、客户端状态、指针、`glBindBuffer`/`glBufferData`、`glGen/DeleteTextures`、着色器编译链接……）都被编进列表，在 `GL_COMPILE` 下不发给宿主，之后每次 `glCallList` 都重放 | `P:5441`、`P:12383`（`glDeleteTextures`）、`P:12839`（`glBindBufferARB`） | 编进列表的 `glDeleteTextures` 每次调用都删除活纹理；`GL_COMPILE` 期间入口照样改客体影子，宿主却什么也没执行（代理自己的 `wglUseFontOutlines` 每个字形编一个 `glTranslatef`，客体的 modelview 就错了）；重放（`P:5824`）不更新影子，于是影子里绑定的纹理或当前程序过期时，`glTexSubImage2D`、`glUniform*` 被以 `INVALID_OPERATION` 丢弃 | ✅（录制规则）；☑️（影子漂移） |
| S2-31 | 列表内容在调用时取值：列表里的 VBO 绘制在执行时才读缓冲；像素记录用重放时的解包状态解码（`E:9119`）；编译中的 `glCallList` 把被调列表的内容抄进来，而不是记一次调用（`P:18023`） | `P:18023`、`E:9119` | `wglUseFontBitmaps` 的字形按对齐 4 编译，应用把 `GL_UNPACK_ALIGNMENT` 设为 1 后文字乱码；被调列表重新定义后不生效，嵌套列表成倍膨胀 | ☑️ |
| S2-32 | `GL_SELECT`/`GL_FEEDBACK` 是占位实现：每个有顶点的 `glBegin/glEnd` 都记一次命中，深度恒为 0 和 0xFFFFFFFF，不变换、不裁剪；每个图元一条记录，而不是名字栈变化时一条；select 模式下的显示列表照常发给宿主绘制，不产生命中；名字栈调用在 render 模式下报错（应忽略），溢出用错误码；反馈写对象空间坐标，令牌布局错误，没有颜色和纹理坐标 | `P:5512-5535, 9783-9792, 5559-5597, 18176` | 拾取总是返回所有对象（编辑器、CAD、策略游戏的选取） | ✅ |
| S2-33 | 矩阵栈：投影栈和纹理栈只有 2 层（GL 允许的最小值），宿主是 4 层；8 个单元共用一个纹理栈。被拒绝的 push 不转发，pop 却照常转发，两边的栈逐渐错开 | `P:2007-2008` | 纹理矩阵和投影矩阵错乱 | ✅（栈定义）；☑️（错开） |
| S2-34 | `glDrawElements`/`glDrawRangeElements` 的客户端数组路径从 0 拷贝到最大索引，忽略最小值和 `start`；VBO 路径每次绘制都在客体 CPU 上扫描所有索引；超过 `end` 的索引让整个绘制被丢弃，真实驱动会照画 | `P` 绘制路径 | 大网格多拷贝数 MB；某些程序的绘制消失 | ☑️ |
| S2-35 | `glArrayElement` 把 VBO 偏移当指针，丢掉 w，忽略通用属性；`glVertexAttrib(0, …)` 在 Begin/End 内不产生顶点 | `P` | 崩溃或读到默认值 | ☑️ |
| S2-36 | `glMultiDraw*` 的回退路径把锁存的 `g_error` 当作本地状态：`if (g_error) return;` | `P` | 只要之前有一个未读的错误，就只画第一个子绘制 | ☑️ |
| S2-37 | 没有任何锁：GL 影子状态和 arena 游标都是进程全局变量。另一个线程的 `wglMakeCurrent` 会在第一个线程底下换掉状态（`P:8184`）；`vgl_window_proc` 在窗口线程里发记录（`P:6191`） | `P:8184, 6191` | 渲染线程与窗口线程分离的程序批处理损坏 | ☑️ |
| S2-38 | WGL 生命周期与 Windows 不同：`wglMakeCurrent(hdc, NULL)` 失败（`P:8172`）；删除自己的当前上下文返回 `ERROR_BUSY`（`P:8110`）；`WM_NCDESTROY` 释放上下文时不保存状态（`P:7879`）；`wglCopyContext` 是空操作；客体对象表是进程级，宿主按共享组释放 | `P:7879-8200` | 关闭窗口、切换上下文的程序出错 | ☑️ |
| S2-39 | 像素格式：无论应用要什么都返回同一个；单缓冲程序从不呈现；内存 DC 渲染显示成 640×480 的覆盖层；`SwapBuffers` 忽略 `hdc`；`SetWindowLongA` 把 Unicode 窗口变成 ANSI；恢复窗口过程时盲目移除之后安装的子类 | `P` WGL/窗口部分 | 单缓冲演示程序、离屏渲染、Unicode 程序 | ☑️ |

#### 着色器（GLSL 与 ARB）

| # | 问题 | 位置 | 后果 | 标注 |
| --- | --- | --- | --- | --- |
| S2-40 | 合法 GLSL 生成非法 WGSL：局部变量、函数、结构字段用了 116 个 WGSL 保留字之一（`filter`、`target`、`type`、`common`、`shared`、`self`、`set`、`get`……），或以 `__` 开头；用户变量叫 `floor`/`select` 会破坏 `mod()` 和 `?:`；`fsin`/`vsin`、`var`/`var_` 冲突；带 bool 或 float 数组字段的 uniform 结构与局部变量共用一个 WGSL 类型；uniform 的 float/vec2/vec3 数组存成 vec4 数组；Tint 拒绝求值的常量（`1.0/0.0`、`1e40`、`sqrt(-1)`、`log(0)`、整数除以常量 0） | `T` | 编译和链接都报成功，之后每次绘制都是无效管线（S1-2） | ✅ naga（保留字局部变量 `filter`）；☑️ 其余 |
| S2-41 | 前端拒绝合法的 GLSL 1.10/1.20：`const int N; uniform vec4 a[N];`（`T:1088`）、`.length()`、数组构造器、`varying vec4 gl_TexCoord[n];` 重声明、`invariant gl_Position;`、`shadow2DProj` 的 bias 重载；uniform 初值被静默丢弃，着色器读到 0 | `T:1088` 等 | 真实着色器编译失败或结果错误；部分问题也影响 GLES 回退路径 | ✅（数组大小、uniform 初值）；☑️ 其余 |
| S2-42 | 程序必须恰好有一个顶点着色器和一个片段着色器（`E:5038`）；同阶段的第二个着色器替换第一个（`E:5035`）；没有 `main()` 的着色器编译失败（`T:2124`） | `E:5035-5038`、`T:2124` | GL 允许只有片段或只有顶点的程序，也允许多个着色器对象拼成一个阶段 | ☑️ |
| S2-43 | 宿主立即删除程序和着色器（`E:3344, 3347`），客体则正确地推迟 | `E:3344-3348` | 删除当前程序后绘制退回固定管线；先删着色器再重新链接失败 | ☑️ |
| S2-44 | uniform API：`glUniform1iv` 计数 >1 时只设置第一个采样器（`E:5149`）；从不检查类型和大小，对 mat3 调用 `glUniformMatrix4fv` 会覆盖下一个 uniform；对 float 调用 `glGetUniformiv` 返回位模式；`ACTIVE_UNIFORM_MAX_LENGTH` 不计 `[0]`；客体丢弃它没有发出过的 `loc+i` 位置（`P:11552`） | `E:5149`、`P:11552` | 采样器数组、uniform 数组的常见写法失效 | ☑️ |
| S2-45 | 链接缓存键（32 位 FNV）不含 `glBindAttribLocation` | `E:5077` | 改了属性绑定后重新链接，得到旧的链接结果 | ☑️ |
| S2-46 | ARB `program.env` 按程序保存，不是按目标共享；没有绑定程序时设置 env 返回 `INVALID_OPERATION` | `E:9546-9562` | WineD3D 的 ARB 后端和 arbfp 固定管线替代、Doom 3 式程序全部错误 | ✅；O（`arb_vp_semantics`） |
| S2-47 | ARB 参数上限两个目标都是 28（`A:38`），顶点程序规范最低 96；客体按 96 校验，宿主拒绝 28–95；`MAX_PROGRAM_ATTRIBS`、地址寄存器、ALU/TEX 指令数等查询返回 0 | `A:38` | WineD3D 的 `PARAM C[N] = { program.env[0..N-1] }`（N>28）编译失败 | ✅ |
| S2-48 | ARB 解析器拒绝标准语法：PARAM 数组的相对寻址 `c[A0.x+n]`；指令里的内联常量 `MUL R0, R1, 2.0;`；SWZ 的逗号语法；缺少 `state.matrix.texture[n]`、`lightprod[n].front.*`、`material.front.emission`、不带下标的 `texgen`；`matrix.modelview[0]` 被读成第 0 行；解析后发现的错误把位置报在字符串末尾 | `A` | cgc 生成的 arbvp1 常用相对寻址；手写 ARB 程序常用内联常量 | ✅（相对寻址、内联标量与向量常量、区间）；☑️ 其余；O（`arb_fragment_program`、`arb_vertex_program`）。另外，`PARAM c[5] = { program.local[0..4] };` 只要数组被读取就以“unsupported parameter index '00.4'”失败（词法把 `0..4` 切成数字），Cg 的 arbvp1/arbfp1 输出大量使用这种区间；负的相对偏移 `arr[A0.x-1]` 也失败 |
| S2-49 | ARB `result.depth` 无法写入：深度是 f32，`.z` 写入和整体写入都生成非法 WGSL | `A` | 写深度的片段程序失效 | ☑️ |
| S2-50 | ARB 顶点程序 + 固定片段：开了裁剪平面或点扩展就拒绝（`E:7137`）；固定顶点 + ARB 片段程序直接丢弃（D-18）；`OPTION ARB_fog_*` 被忽略；双面颜色跟随 `LIGHT_MODEL_TWO_SIDE` 而不是 `VERTEX_PROGRAM_TWO_SIDE`；`VERTEX_PROGRAM_POINT_SIZE` 被忽略 | `E:7135-7194`（只有片段程序时拒绝：`E:7106-7110`） | 只用 ARB 片段程序、顶点走固定管线的程序（WineD3D 的常见组合）什么也画不出，GL 错误为 0 | ☑️；O（`arb_fragment_program`） |
| S2-51 | ARB 程序对里，每个程序按自己用到的字段声明状态结构（`A:722`），而这一对共用的缓冲按两者的并集布局（`E:7112-7121`）。于是片段程序读到的是顶点程序的字段 | `A:722`、`E:7112-7121` | 片段程序里的 `state.fog.color` 读到 mvp[0][0]（Apple 77,153,229，我们 8,0,0,0，8/255 = 2/64）；`state.light[0].diffuse` 同样错位 | O（`arb_fp_semantics`、`arb_diag`） |
| S2-52 | ARB 片段程序的 `TEX texture[0], 2D` 只有在 `glEnable(GL_TEXTURE_2D)` 时才采样，否则为黑。规范规定片段程序启用时忽略纹理启用位 | `E` ARB 绑定路径 | 只绑定纹理、不调用 `glEnable(GL_TEXTURE_2D)` 的 ARB 程序画成黑色（Apple 160,100,183，我们 0,0,0） | O（`arb_fp_semantics`、`arb_diag`） |

### 3.3 S3 一般（摘要，细节见共享笔记目录里的各区报告）

- **固定管线：**
  - 线性雾 `start == end` 时比例取 0（Mesa 取 1）；
  - 聚光项也作用于方向光（Mesa 不会）；
  - 眼空间 w 假定为 1；
  - RGB DXT1 的穿透纹素 alpha 为 0 ❓；
  - 阴影比较结果复制到 RGBA，从不读 `DEPTH_TEXTURE_MODE`，MODULATE 会吃掉片段 alpha；
  - LOD bias 存了三份（纹理参数和 `TEXTURE_FILTER_CONTROL` 两种设法），没有一处被读取（O：`mipmap`）；
  - `GL_CLAMP` 和 `GL_CLAMP_TO_BORDER` 都不采样边框色，D-03 的注释却说着色器处理了它，`ARB_texture_border_clamp` 也已宣称（O：`tex_wrap_border`）。
- **绘制：**
  - 剔除 `GL_FRONT_AND_BACK` 时线和点也被丢掉；
  - 没有多重采样缓冲时仍应用 sample coverage；
  - 模板参考值不钳制；
  - `glLineWidth` 在 `COVERAGE.md` 里是 A 类，宽度却从不生效；
  - ARB 顶点 + 片段程序组合下宽点消失。
- **资源：**
  - 忽略 `border`；
  - `UNSIGNED_BYTE_3_3_2` 以 `GL_INVALID_ENUM` 拒绝，`UNPACK_SWAP_BYTES` 被忽略（O：`tex_formats_unpack`）；
  - sRGB 渲染目标总是编码；
  - `queryInteger` 对未知 pname 回答 0 和 OK；
  - 自适配器特性得出的扩展串在另一台机器上恢复存档时可能变化，而客体已经缓存了旧串；
  - 重放日志从不压缩，“已无 GL 上下文”时也不压缩。
- **客体：**
  - `glGen*` 计数器可能发出应用已经自己绑定过的名字；
  - 纹理启用位和当前纹理坐标是全局的，不按单元；
  - 不支持代理纹理，`glGetTexLevelParameteriv` 不写 `params`；
  - 求值器产生重复顶点，没有 `GL_AUTO_NORMAL`；
  - Begin/End 之间什么都不拒绝；
  - 交换间隔不发给宿主；
  - gl15 能力档在没有宿主检查的情况下宣称浮点和各向异性扩展（gl21 档有检查，`P:1672`）；
  - `glGenLists`/`glDeleteLists` 的名字处理不对；
  - 另一个代理 DLL 若在同一进程里，会写同一块 arena（D3D S1-11 的对应问题）❓。
- **着色器：**
  - 结构构造器参数生成两次，`inout` 副作用执行两次；
  - ARB 的 LIT 在 shininess 为 0（GL 默认值）时得到 NaN；
  - RECT 目标不归一化，SHADOW 目标按普通纹理采样；
  - 接受未知 OPTION；
  - 别名属性产生重复位置；
  - GLSL 的纹理单元常量写的是 16/24，实际只有 8 个。

## 4. 过度防御性编程：模式、它掩盖了什么、怎么改

### 4.1 宿主侧

- **只能接住 TypeError 的 `try/catch`。** 包在管线和 bind group 创建外面（`E:7466-7475, 7595-7615`），接不住任何真正的 WebGPU 错误，反而把宿主自己的 bug 以 `GL_INVALID_OPERATION` 报给应用。改为 error scope 加上“失败的对象不进缓存”。
- **`refuse()`/`warnOnce` 只记一次。** 一个持续的失败只在第一帧打印，之后每帧静默失败。`refuse(..., 0)` 丢弃绘制却不设 GL 错误（S2-50 就是这样“安静地什么都不画”）。改为：实现限制在开发构建里断言；GL 层面的非法输入设置正确的 GL 错误。
- **所有枚举都不校验，未知值静默回落默认值：** `|| "MODULATE"`、`|| "always"`、`|| "EYE"`、`|| "TEXTURE"`，`normalizeSignature` 再回落一次。结果是 `INVALID_ENUM` 从来不报，有一种组合还会让生成器抛异常（S1-3）。改为一张表校验一次，在入口处设置 `INVALID_ENUM`。
- **WGSL 里的 `max(x, 1e-8)` 保护**改变了语义，例如负的 q（S2-12）。删除它，按规范处理除零。
- **无效的矩阵模式回落到 MODELVIEW**，静默改错栈。
- **猜测值：**
  - `queryInteger` 对未知 pname 回答 0；
  - `FRAMEBUFFER_UNDEFINED || 0x8219`；
  - `try { destroy() } catch {}`。
- **`isContextFreeTeardownNoop`** 是只为 GLView 加的特例，掩盖了 S1-4。删除它，改为让上下文有进程身份。
- **无效输入被静默跳过：** TexSubImage 跳过越界行，而不是报 `INVALID_VALUE`；绘制路径里 `continue` 静默丢掉一个属性（`E:5933`，S1-5 就藏在这里）。
- **只是把 API 变严格的转换：** ARB 的分量数转换没有必要，Chrome 接受更窄的格式，固定管线路径本来就依赖这一点。
- **死代码：** `derivedDirty` 有四处写入，从不读取；约 150 行一致性分析在 `diagnostic(off, derivative_uniformity)` 之后已经不起作用；默认的 “grad” 采样策略只是丢掉了 bias 参数。
- **读回答案写两遍。** readPixels 的答案有两条写回路径，bridge 和 proxy 各自叠加 generation、epoch、`isMemoryValid` 检查。正是这种不清楚的接线让 S1-1 一直没被发现。

### 4.2 客体侧

- **重复宿主已做的校验：**
  - 每次绘制做 4096 槽的 VBO 范围扫描；
  - 自己算一遍帧缓冲完整性，然后扔掉，改用宿主的答案；
  - 自己检查 uniform 归属。
- **每次查询先 flush。** 每个 `glGet*`/`glGetError` 都先刷新待发批处理，于是每次调用两次 IOCTL。WineD3D 的 `checkGLcall` 频繁调用 `glGetError`（❓ 成本很大）。
- **把传输丢失伪装成 GL 结果：** 编译 FALSE 配空的信息日志，读回缓冲全零，`emit_frame` 恢复错误标志从而掩盖失败的呈现。改为：传输丢失就是传输丢失，按 §4.3 处理。
- **猜测的极限值。** `query_limit_or_default` 在查询失败时猜一个值。正因为有它，S1-1 表现为“扩展少了几个”而不是“无法工作”。
- **报告成功的空实现：** `wglCopyContext`、调色板函数、轮廓字体都返回成功。
- **把不可能为 NULL 的内部参数映射成 GL 错误。** 例如 `reserve_packed_draw_payload` 检查 `payload_out` 为 NULL 时设置 `GL_INVALID_VALUE`。
- **永远不会触发的大小检查**，而且放在记录已经预留之后（`P:4709`）。
- **锁存错误被当作本地状态使用**（S2-36）。

### 4.3 统一原则

与 D3D 审查 §4.3 相同：

- 宿主 bug 用断言或 error scope 暴露，不报给应用；
- 应用的非法输入只在一层校验，并返回规范规定的 GL 错误；
- 实现限制在能力宣称里如实反映，而不是运行时静默降级；
- 传输失败可以恢复，不永久生效。

## 5. 结构问题

### 5.1 两套状态机

| 状态 | 客体 | 宿主 | 问题 |
| --- | --- | --- | --- |
| 当前上下文的 GL 状态 | 几乎完整的影子，切换上下文时复制约 85 KB 两次 | “权威”状态机 | 显示列表、PopAttrib、按单元状态、GPU 写入的状态都不同步（S2-30、S2-33） |
| 纹理与缓冲数据 | 每级、每个缓冲一份 CPU 副本；每次上传在客体里复制三次 | 每级一份 CPU 影子 + GPU 纹理 | 一张纹理存三份，32 位进程 2 GB 地址空间吃紧；宿主影子会覆盖 GPU 写入的内容（S2-25） |
| GL 错误 | 客体锁存一份 | 宿主每个上下文一份 | 每次 `glGetError` 都要同步往返合并 |
| glGet 的回答 | 一部分在客体本地回答 | 另一部分由宿主回答 | 光源位置、裁剪平面、光栅位置两边的空间不同（对象空间 vs 眼空间），整数换算不同（S2-9、S2-15） |
| 极限值与扩展串 | 客体有一份，并夹取到宣称值 | 宿主另有一份 | 两边不一致（ARB 96 vs 28，纹理单元 16 vs 8） |

GLES 方案（`docs/gles-proxy-plan.md`）在同一个问题上做了明确选择：状态、错误、程序信息都放在 CPU 侧的影子（`src/gles/gles_shadow.js`，跑在 CPU worker 里），页面只负责渲染。只有 ReadPixels、Finish 和同步等待才需要页面。XP 的 GL 路径是唯一一条“页面权威、同步回答”的路径，也正是它在 worker 模式下坏了。阶段 3 建议向 GLES 的架构收敛。

### 5.2 宿主执行器

- **9.9k 行的单文件**，同时负责：
  - 解码；
  - 状态机；
  - 资源；
  - 管线缓存；
  - pass 管理；
  - 读回；
  - 查询；
  - 像素操作；
  - ARB；
  - 能力回答。
- **延迟创建的 GPU 缓存没有统一的所有者。** 设备丢失和 `resetForReplay` 各清一个不同的子集，这是 S1-5 的根因。
- **pass 目标失效散落在各个调用点。** 应该在 `ensurePass` 里比较目标键，这是 S2-24、S2-29 的根因。
- **管线键不完整，而且是手写的。** 改变画面的状态必须进键，这是文件头自己定下的原则，却有 S2-6（模板）、S1-4（程序名）、S2-45（属性绑定）三处违反。应该由“解析后的绘制状态”结构自动生成键。
- **每次绘制的开销：**
  - 每个固定管线绘制构造两次完整签名，再做 `normalizeSignature` 和 `JSON.stringify`：仅 `signatureKey` 一项就测得 1.67 µs，键长 1.5 KB；
  - ring 偏移放在 bind group 键里，布局是 `"auto"`，每次 flush 都清空 bind group 缓存，结果大约每次绘制一个 `createBindGroup`；
  - 每次小上传一个 `writeBuffer`；
  - 每次绘制逐字节比较整个 uniform 块（`program.serial` 明明存在），还用 `indexOf` 搜 WGSL 文本；
  - 立即模式每个顶点都分配数组、重算属性集；
  - pass 被每次 `glPopAttrib` 和每次带剪裁的 `glClear` 切断（Q3 一直开着剪裁测试）；
  - 逻辑运算每次绘制拷贝整个目标；`glBitmap` 每个字形建一张纹理；
  - 清除管线的键包含清除颜色，每种新颜色编译一个着色器；
  - `bufferSubData` 在缓冲使用中重建整个缓冲；任何纹理更新都重传所有级别。
- **用正则解析 WGSL 判断 bind group 的可达性。**
- **与 D3D9 执行器：** 按 6 行窗口比对，文本重复为 0，说明是独立重写的。但功能上重复：格式转换、DXT 解码、mip 生成、读回、遮挡查询、回退纹理、上传 ring、管线缓存。两边的缺陷也相同：没有错误捕获、MIN/MAX 因子、线和点上的 depthBias、MRT 写掩码、大上传。这些应该抽成共用的 WebGPU 工具层，一次修好两边。

### 5.3 客体 DLL

- **19.7k 行单文件**，按 6 行窗口有 13% 的行自我重复。重复主要来自入口函数的各个变体，以及 11 个几乎相同的查询辅助函数。
- **协议常量在 C 和 JS 中各写一份**（`gl_opcode_names.h` 由脚本生成，但 `gl_wire.js`/`gl_constants.js` 没有生成器）。
- **立即模式每个属性、每个顶点一条记录。** 显示列表每次调用都完整重发；`glLockArraysEXT` 是空操作。
- **`glGetError` 在本地没有错误时总要往返一次宿主。**
- **GLView 等程序的规避代码散落各处**（`isContextFreeTeardownNoop` 在宿主，`wglUseFontBitmaps` 的对齐假设在客体）。

### 5.4 与 GLES 共用的代码

- `gl_shader_translator.js` 被 GLES 的 GLSL ES 前端使用（GLES 3.x 的主路径已改为 glslang → SPIR-V → vx_naga，GLES2 的旧路径和回退仍用它）。S2-40、S2-41 的部分问题也会影响 GLES 回退路径。
- `gl_fixed_function.js` 被 GLES1 使用，所以 S2-2（RESCALE_NORMAL）同样影响 GLES1。S2-1（法线矩阵）不影响：GLES1 用自己的快照。
- 两份快照构造器已经分叉。应该在 `gl_state_layout.js` 里只保留一个共用的构造器。

## 6. 测试体系评估

### 6.1 实际运行结果（测试审查员；真 GPU 探针由我复跑）

| 项 | 结果 |
| --- | --- |
| 8 个 Node GL 套件 + 4 个客体 GL 测试 | 全绿，GL 部分约 1.7 秒；整个 `run.cjs` 约 7.7 秒 |
| 两个 GL 浏览器页 | 全绿，各 1–2 秒；不在任何 make 目标里 |
| 测试生成的 202 个 WGSL 模块，naga + Tint | 全部接受 |
| 变异实验（22 个一行语义变异） | 只杀死 7 个：剔除面、SRC_ALPHA 混合、打包索引基址、元素缓冲偏移、深度清除位、GLSL `mod`、QUADS 引发顶点 |
| 存活的变异 | 深度 LESS、DST_COLOR 混合、MODULATE alpha、雾混合、alpha GREATER、多边形偏移符号、视口 y、模板 INCR、光照衰减、半角向量、`texture2DProj`、ARB LIT、ARB LRP、REPEAT 环绕、法线矩阵 |
| 按文件 | 固定管线测试 0/5；ARB 测试 0/2；浏览器页 0（D3D 路径是 2/12） |
| opcode 覆盖 | 217 个中 119 个从未被任何测试解码 |
| 真 GPU 语义探针（15 项，我在本机 Chrome/Metal 上复跑，源码与仓库一致） | QUAD_STRIP 缺 1024 像素；flat 三角形得到红（应为蓝）；扇形得到 [绿,蓝]（应为 [蓝,黄]）；固定管线未完整纹理得到黑（应为绿）；线 + POLYGON_OFFSET_FILL 被 Chrome 拒绝，同帧之后的三角形变黑；部分为负的视口得到黑（应为白）；越界 readPixels 状态 OK 但有校验错误；跨边缘读回窗口内像素为 [0,0,0,0]；线框四边形对角线点亮 24 像素 |

### 6.2 测试在断言什么

- **断言了错误的 GL 行为：**
  - `gl_executor_test.js:439-451` 断言扇形 `fan[0] === 1`，GL 要求 2。生产代码注释引用的 `gl_flat_shading_test.exe` 并不存在，错误来自计划文档 §4.6 的表；
  - `gl_executor_test.js:701` 以 GLSL 规则（“不透明黑”）命名，测的却是固定管线单元；
  - `gl_shader_translator_test.js:87` 要求 `#version 130` 只给警告就编译通过，GLSL 1.20 编译器必须拒绝；
  - `gl_arb_program_test.js:119` 要求 `!!ARBfp1.0` 接受 `|r0|`，这是 NV 扩展的语法；
  - `gl_executor_test.js:268-286` 要求宣称 `GL_ARB_texture_border_clamp`，而边框钳制是已记录的偏差（D-03）。
- **白盒测试。** `gl_executor_test.js` 有 2441 行、101 个测试，引用约 50 个私有成员，把解码、状态、GPU 资源、查询和翻译混在一起。
- **翻译器测试只匹配 WGSL 子串**，固定管线测试只对手写签名跑 naga，从不计算数值，也不对执行器实际能产生的签名做模糊测试。
- **mock GPU 从不拒绝。** `gl_fake_gpu.js` 接受任何着色器模块和管线，不检查拷贝边界，`mapAsync` 总是成功，只校验 6 条很窄的规则。执行器的“拒绝管线”路径只在测试里可达。
- **异步测试数 microtask 跳数，而不是 await 操作本身。** 正是这样，readback 和遮挡查询完成路径曾经“死了而测试仍绿”。
- **`run.cjs` 只看退出码。** 一个从未打印总结的文件也算通过。

### 6.3 缺口

- **协议测试不比较 C 布局和 JS 解码器。**
  - 对 140 个声明式记录，它只检查类型串格式良好。测试编码器用解码器自己的表构造记录，所以表错了也看不出。
  - 测试审查员写的 60 行检查器，把客体的 133 个发射点与表逐一比对：今天 0 个不一致。这个检查很便宜，却没有人做。
  - 对 21 个手写记录，它比较的是字段名与测试里手打的列表，不是解码器的偏移。约 56 个手写布局没有被钉住。
  - 站点仓库没有 CI，这个跨仓库测试不会自动运行。
- **客体 DLL 没有行为测试**，只有对 C 源码的正则和一份导出表：显示列表、PushAttrib、SELECT/FEEDBACK、求值器都没有。负责人的笔记写着：2026-09-01 以来的每个 GL bug 都来自客体运行，没有一个能被测试看到。
- **没有像素参照：** 没有一个 GL 像素测试与参考图像或计算值比较。runner 支持 `/__test_file` 截图，但没有 GL 页使用。
- **没有真实程序的轨迹：** 诊断 DLL 能打印 opcode 直方图，但两个仓库里都没有 GLView、Warcraft III、Cube 2 的直方图或可重放的轨迹。
- **CI 不验证 WGSL：** CI 没装 naga，校验测试 SKIP 后退出 0。计划文档把它称为“CI 硬门槛”。
- **没有覆盖的场景：**
  - worker 模式的同步答案；
  - 两个客体进程；
  - 宿主异常后传输是否还活着；
  - 设备丢失；
  - `destroyContext`；
  - 多上下文 pass；
  - 非压缩 `TexSubImage`；
  - 打包 BGRA；
  - BASE/MAX_LEVEL；
  - pack 状态；
  - 深度和浮点读回；
  - 立方体 `CopyTexImage`；
  - `QUERY_OBJECT_BATCH`；
  - 法线矩阵的数值。
- **重复：** 线格式编码器在 JS 里有三份（另加 C 的发射代码），测试脚手架六份，`findNaga()` 三份；`initializeSync` 重写了一遍 `initialize()`，而且已经漂移。GLES 套件已有更好的像素检查辅助函数，GL 页没有用。

## 7. 分阶段重构方案

阶段编号与 D3D 审查对齐。凡是落在共用宿主层的工作（错误捕获、失败策略、WebGPU 工具层），两条路径应一起做，而不是各修一份。

### 阶段 0：止血，让错误可见（约 1–2 周）

- **目标：** 站点默认配置下 GL 能用；任何 WebGPU 错误和宿主异常都可见、不粘滞；修掉一批一行级的语义错误。
- **范围：**
  - **S1-1：** 客体在批处理 flags 里标记“含同步查询或等待”，`DEV` 在 worker 模式下对这类批处理推迟 `request.complete()`，直到页面回 `done`。批处理头 flags 和请求 flags 现在只允许 bit 0（`DEV:172, 185`），新增一位即可。
  - **错误捕获**（与 D3D 阶段 0 共用一个实现）：
    - 管线、bind group、着色器模块创建时使用 error scope，失败的对象不进缓存；
    - 设备注册 `uncapturederror`，按条去重后上报；
    - 测试模式下任何校验错误都让测试失败。
  - **失败策略：**
    - 每条命令一个 catch：记录日志，对应用设置 `GL_INVALID_OPERATION`，继续执行这一批的其余命令，答案照常写回；
    - `setAvailable(false)` 只用于设备真正丢失；
    - 客体在传输失败后可以重试，不再永久设置 `g_v86gl_failed`；
    - 删掉强制的 `OutputDebugStringA`。
  - **S1-2 的触发项逐个修：**
    - 按绑定维度准备回退视图（2D、cube、3D、depth 各一个）；
    - MIN/MAX 用 ONE, ONE；
    - 线和点不设 depthBias；
    - `glDepthRange` 在 n>f 时用顶点着色器变体处理（参考 Venus 的 G-50）；
    - 有索引的宽点也加 corner 缓冲；
    - `gl_FragColor` 广播到所有 draw buffer；
    - crossbar 指向禁用单元时直通；
    - 读回矩形与目标求交。
  - **一行级语义修复：**
    - 法线矩阵改为逆转置（S2-1）、RESCALE_NORMAL（S2-2）；
    - QUAD_STRIP 改为 `(b+3, b+2, b)`（S2-4）；
    - 模板关闭时用 always/keep（S2-6）；
    - 视口不夹取（S2-7）；
    - CONSTANT_ALPHA 写 (a,a,a,a)，或拆成两次 pass，保持准确（S2-8）；
    - 整数向量只归一化颜色（S2-9）；
    - 6 个裁剪平面（`array<f32,6>` 或两个 vec4），禁用的平面置零（S2-10）；
    - 未完整纹理让固定管线单元直通（S2-3）；
    - 实现纹理对象 0；
    - `TexImage(NULL)` 分配零填充的存储（S2-20）；
    - 打包类型交换 BGRA（S2-22）；
    - `mapAsync` 失败写 FAILED（S1-7）。
  - **能力宣称如实反映：**
    - 纹理单元报 8；
    - 撤下 `EXT_texture_lod_bias`、`ARB_texture_border_clamp`、`EXT_paletted_texture`，直到真正实现；
    - `GL_SAMPLES` 与 `ARB_multisample` 一致；
    - 在分带上传完成之前，`MAX_TEXTURE_SIZE` 报 2048 以下。
- **风险：** 低到中。修正后画面会变化，这些变化正是修复本身；客体 flags 的改动需要同时重新构建 DLL。
- **验证：**
  - 每个修复配一个真 GPU 回归用例（§8 的 L4），以测试审查员的探针页为起点；
  - 在 worker 模式下跑 GLView、Cube 2（GLSL 链接）、Warcraft III。

### 阶段 1：测试底座（约 2 周，可以与阶段 0 后半并行）

- **目标：** 让语义错误能被测试抓到。
- **范围：**
  - **修正断言了错误行为的 5 个测试**（§6.2）。
  - **校验型 mock GPU：** 把绘制路径审查员在 Chrome 上确认过的规则表（`scratchpad/gl/webgpu_rules`）放进 `gl_fake_gpu.js`，至少覆盖拓扑与 depthBias、MIN/MAX 因子、视口深度顺序、颜色目标与片段输出、顶点缓冲与着色器输入、绑定维度、拷贝边界。
  - **CI 安装 naga**，缺了就失败；加一个对执行器实际能产生的签名做 naga + Tint 模糊测试的用例。
  - **GL 浏览器页进 make 目标**，每页都在 error scope 下运行，像素与计算出的期望值比较。
  - **worker 模式的同步查询测试；** 两个客体进程的测试；宿主异常后传输仍可用的测试。
  - **变异脚本常驻，** 目标 ≥ 19/22。
  - **`run.cjs` 要求每个文件打印 “N passed, 0 failed”。**
- **风险：** 低。
- **验证：** 变异杀死率；把已知 bug 回退后测试必须失败。

### 阶段 2：协议单一来源（约 1–2 周）

- **目标：** C 结构、JS 解码器、测试编码器、opcode 名称都从一份模式生成。
- **范围：**
  - 恢复 `gl_protocol.json`（站点 `8bcd2f7^` 里有最后一版），放进 v86，作为唯一来源；
  - 由它生成客体的 C 结构和 `gl_opcode_names.h`，以及 `gl_wire.js`、`gl_constants.js` 和测试编码器；
  - 测试审查员的 60 行检查器（`tests_review/sig_check.cjs`）在生成器落地之前先放进 v86 CI；
  - 恢复偏差清单 D-01..D-18：放进 `gl-webgpu/README.md`，或并入 `docs/gpu-deviations.md`；把计划文档的引用改到实际位置；
  - `COVERAGE.md` 增加“有测试”一列，A 类必须有至少一个行为测试。
- **风险：** 低到中；生成的 C 结构必须与现有发行版 DLL 的 ABI 逐字节相同，用现有检查器验证。
- **验证：** 生成前后客体 DLL 的记录字节不变；检查器在 CI 中运行。

### 阶段 3：决定状态归属（本文最重要的架构决定；约 3–5 周）

- **问题：** 现在是两套状态机（§5.1）。“宿主权威、同步回答”在 worker 模式下需要每次查询都往返页面。阶段 0 的修复只是让它不丢答案，没有让它变快：WineD3D 频繁调用 `glGetError`，每次都会是一次跨线程往返。
- **选项：**
  - **(a) 维持宿主权威：** 客体删掉影子，只保留 WGL 必需的部分。每个查询都同步往返页面。改动最小，但 worker 模式下最慢。
  - **(b) CPU 侧权威（建议）：** 与 GLES 方案相同，把权威状态机、错误、GLSL 编译链接信息、uniform 位置都放在 CPU worker 一侧的 JS 影子里，复用 `src/gles/gles_shadow.js` 的基础设施和翻译前端；页面执行器只渲染、从不回答。只有 ReadPixels、Finish、查询结果需要等页面。客体 DLL 变薄：删掉大部分影子，查询经 IOCTL 到 worker 即可同步回答，不必等页面。
  - **(c) 客体权威：** 客体 C 影子负责全部校验和回答，`glGetError` 不出客体。这样最快，但要在 C 里实现完整的 GLSL 编译信息，不现实。
- **建议 (b)。** 理由：
  - 它从结构上消除了 S1-1；
  - 它消除了“两套状态互不同步”这一类问题（S2-30、S2-33、§5.1）；
  - GLES 已经验证过这种架构（dEQP-GLES2/3/31 子集 99%+）。
- **风险：** 高。这是一次大重构，需要阶段 1 的测试底座先就位。
- **验证：** 状态查询的一致性测试（类似 dEQP 的 `state_query`），两种模式下结果一致。

### 阶段 4：宿主执行器重构（约 4–6 周，与 D3D 阶段 3 共用一部分）

- **目标：** 拆分 9.9k 行的执行器，让管线键和资源生命周期由结构保证，而不是靠每个调用点记得。
- **范围：**
  - **解析后的绘制状态 → 自动生成管线键**（消除 S2-6、S1-4、S2-45 一类问题）；
  - **资源管理器拥有所有 GPU 对象**，设备丢失和重放时统一重建（S1-5）；
  - **pass 管理器按目标键判断是否需要新 pass**（S2-24、S2-29）；
  - **按上下文、按 FBO 的状态各归其位**（S2-28）；
  - **与 D3D9 执行器共用 WebGPU 工具层：** 格式转换、DXT、mip、读回、查询、回退纹理、上传 ring、错误捕获；
  - **性能：**
    - 签名改为整数位域，不用 `JSON.stringify`；
    - bind group 用显式布局加动态偏移；
    - 用 `program.serial` 做 uniform 脏检查；
    - 清除管线不以颜色为键；
    - `glBitmap` 用字形图集；
    - 纹理只重传脏的级别。
- **风险：** 中到高。
- **验证：** 阶段 1 的测试全部通过；Warcraft III、Cube 2 的每帧 CPU 时间对比。

### 阶段 5：着色器翻译器（约 3–4 周）

- **目标：** 翻译结果对合法输入总是有效的 WGSL；ARB 语法完整。
- **范围：**
  - **评估把 GLSL 1.10/1.20 前端换成 glslang → SPIR-V → vx_naga，**与 GLES 3.x 共用。要先确认 glslang 能否把兼容 profile 的 GLSL 1.10/1.20 生成 SPIR-V（❓ 未核对）。不能的话，就在现有前端里修：
    - 统一的标识符改名（避开 WGSL 保留字）；
    - uniform 与局部变量的类型分离；
    - 常量折叠交给 Tint 能接受的形式；
    - 实现 S2-41 的语法。
  - **ARB：**
    - env 按目标共享；
    - 参数上限顶点 96、片段 24 以上，并与客体一致；
    - 相对寻址；
    - 内联常量；
    - SWZ 逗号语法；
    - 缺失的状态绑定；
    - `result.depth`；
    - 固定顶点 + ARB 片段程序（D-18）；
    - `OPTION ARB_fog_*`。
  - **运行时校验：** 链接时对 WGSL 调用 `getCompilationInfo`，失败就把链接状态报为 FALSE，并给出信息日志。
- **风险：** 中；这些文件与 GLES 共用，改动要跑 GLES 的 dEQP 子集。
- **验证：** Cube 2 语料；新增的 GLSL 1.20 一致性语料；ARB 用 WineD3D 生成的程序和 cgc 输出做语料。

### 阶段 6：客体重写（约 4–6 周，可以与阶段 4、5 并行）

- **目标：** 客体 DLL 的行为与 GL 2.1 规范一致。
- **范围：**
  - **显示列表：** 按 GL 2.1 §5.4 区分立即执行与编译；编译时取值（VBO 内容、解包状态）；嵌套 `glCallList` 记为一次调用；在宿主侧回放，而不是每次重发全部记录。
  - **GL_SELECT/GL_FEEDBACK：** 在 CPU 侧用影子的矩阵做真正的变换和裁剪。选择模式很少用，图元数也少，软件实现足够。
  - **线程：** 每个线程一个当前上下文；arena 游标加锁；窗口过程不发记录，只设置标志。
  - **WGL 生命周期：** 照 Windows 的行为；上下文有进程身份，进程退出时宿主清理它的上下文（对应 D3D 的 `SESSION_END`）。
  - **大上传分带**（与 D3D S1-12 共用方案）。
  - **立即模式：** 合并成顶点块；`glLockArraysEXT` 生效。
- **风险：** 中。
- **验证：** 阶段 1 的 L1（客体 C 代码在本机编译，接假传输，回放到真执行器）。

### 阶段 7：客体内验收（持续）

- 在 worker 模式和本地模式下分别跑：
  - GLView 2.6.0（固定管线、ARB、显示列表、拾取）；
  - Warcraft III OpenGL 模式；
  - Cube 2；
  - 至少一个 Quake 3 引擎游戏；
  - 至少一个 WineD3D-on-GL 程序。
- 每个程序录一段诊断 DLL 的 opcode 直方图和短轨迹，作为 L5 回放资产。

## 8. 建立成体系的验收

### 8.1 分层

| 层 | 内容 | 现状 |
| --- | --- | --- |
| L0 协议 | 一份模式生成 C 结构与 JS 偏移；检查器在 v86 CI 中运行 | 测试是循环论证；模式文件已删除 |
| L1 客体 ABI | `opengl32_proxy.c` 在本机对着一个小的 `windows.h`/`DeviceIoControl` 垫片编译，批处理喂给真执行器（`gl_diagnostic_buffer_test.js` 已经这样编译过诊断写入器） | 不存在 |
| L2 状态 | 只通过记录驱动执行器，不碰私有成员；状态查询一致性 | 白盒，约 50 个私有成员 |
| L3 翻译器 | 每个 GLSL 内建函数、ARB 指令、texenv 行都在 GPU 上渲染，与 JS 参考实现比较；执行器可达的签名做 naga + Tint 模糊测试 | 只匹配 WGSL 子串 |
| L4 像素 | 按 piglit 的类别组织，期望值精确计算；每页都在 error scope 下运行；以参照 GL 实现为最终依据（§8.2） | 只有两个页面，不在 make 目标里 |
| L5 回放 | GLView、Warcraft III、Cube 2 的短轨迹回放，比较图像和 opcode 直方图 | 不存在 |

### 8.2 参照实现

D3D 审查用 Wine 的一致性测试作参照（它们在真实 Windows 上运行过）。GL 路径有三个候选：

- **macOS 自带的 OpenGL 2.1（legacy profile）。** 不需要下载，本机就有 CGL 和 `OpenGL.framework`。原型已经建成并跑通（附录 C），参照一侧不到 1 秒，执行器一侧约 2 秒加 Chrome 启动。缺点：Apple 的 GL 实现在 Metal 之上，有自己的偏差（硬件渲染器有 3 个光照方块什么也没画、1 个聚光方块错，软件渲染器的 COLOR_MATERIAL 跟踪和顶点程序 EXP 错），而且只能在 Mac 上跑。转成常驻验收的办法：
  - 把场景描述和 Apple 生成的金像（golden image）提交进 `tests/glbridge`，Linux/Windows 的 CI 只比较金像，不需要 Apple GL；
  - Apple 自己错的地方，按规范条款钉住手算的期望值；
  - 维护一张已知失败表，每项对应本文的问题编号，修一个删一个；
  - 规则：容差 ±2/255；只有与两个 Apple 渲染器都不一致的像素才算失败；图元边缘像素用局部线性测试排除（平滑渐变不排除，所以图元内部的空洞能抓到）；线和点用 3×3 邻域；任何 WebGPU 校验错误都算失败。
- **Mesa llvmpipe/softpipe。** 跨平台，CI 可用；需要下载和构建。长期看它是最好的参照：参照原型的 C 运行时只需把 CGL 上下文换成 OSMesa。
- **piglit 测试集。** 它在真实驱动上运行过，是 Wine 测试的对等物；需要下载。阶段 1 之后可以挑出 `spec/!opengl 1.0`–`2.1`、`spec/arb_vertex_program`、`spec/arb_fragment_program`、`spec/glsl-1.10`/`1.20` 中不依赖窗口系统的用例，移植到 L4 的场景格式。

下载 Mesa 或 piglit 需要你同意。

### 8.3 规则

与 D3D 审查 §8.3 相同，另加两条：

- **“答案在批处理之后才到”的路径**（ReadPixels、查询结果）必须同时断言两件事：在端口写返回的那一刻仍是 PENDING，之后会完成。只有同步断言的测试，对一个永远不完成的执行器也会通过（负责人的笔记里已经吃过这个亏）。
- **每条需要客体答案的命令**都要在本地模式和 worker 模式下各测一次。

### 8.4 已做的决定（2026-10-29）

| # | 决定 |
| --- | --- |
| 1 | 状态归属选 (b)：CPU 侧权威，与 GLES 的架构一致 |
| 2 | 同意下载 Mesa 作为第二参照 |
| 3 | GLSL 前端分两步：glslang 先做检查与反射；代码生成是否也换成 glslang，由不超过一周的试验决定（见 [`opengl-webgpu-plan.md`](opengl-webgpu-plan.md) §0.1） |
| 4 | 不先上 worker 模式的最小修复，所有修复放在一个计划里完成：[`opengl-webgpu-plan.md`](opengl-webgpu-plan.md) |

下表是做决定之前的原始问题和建议，保留备查。

### 8.5 原先待决定的事项

| # | 决定 | 我的建议 |
| --- | --- | --- |
| 1 | 阶段 3 的状态归属：(a) 宿主权威 / (b) CPU 侧权威，与 GLES 共用 / (c) 客体权威 | (b) |
| 2 | 是否下载 Mesa（llvmpipe）或 piglit 作为参照 | macOS 参照原型已经可用：先把它的场景和金像提交成常驻验收；需要在非 Mac 的 CI 上重新生成金像时，再下载 Mesa 换成 OSMesa 上下文 |
| 3 | GLSL 前端是否换成 glslang → SPIR-V → vx_naga | 先做可行性核对（兼容 profile 的 1.10/1.20） |
| 4 | 阶段 0 的 S1-1 最小修复（flags 位 + 推迟完成）是否先上 | 是，阶段 3 之前站点上的 GL 就能用 |

## 附录 A：我本人的核实记录

以下每条我都读通了代码或亲自运行过。完整记录在共享笔记目录的 `verified.md`。

- **S1-1：** `DEV:191` 复制、`DEV:196-213` 发送后返回 OK、`DEV:135-143` 立即完成请求；`GP:236-258` 中 worker 模式的 `done` 只释放配额；`E:3441-3460` 只写 `view`；`P:5063-5084` 在不等待的 `emit_pci_batch`（`P:4453`）之后立刻读状态；`vm_config.js:256` 与站点 `app.js:429` 都是 `cpu_worker: true`。
- **S1-2：** `gl-webgpu/` 与 `webgpu_host.js` 中零处 `pushErrorScope`/`uncapturederror`，只有 `gx_executor.js:210` 有；回退视图 `E:1801-1814, 7655-7656`；depthBias `E:7459`（GPU）；`DEPTH_RANGE` `E:2344-2347` 只夹取不排序，`E:6953-6957` 原样传入；宽点 corner `E:6866-6867` vs `E:7067-7068`、`FF:381`。
- **S1-3：** `E:2217-2233` 重新抛出；`P:4511-4514` 永久失败；`P:4208-4211` 每次重试都走 `v86gl_error`；`P:1504-1507` 强制调用 `OutputDebugStringA`。
- **S1-4：** `E:7214-7215` 的管线键为 `"p" + program.name + "|" + 变体`。
- **S1-6：** `P:4546-4553` 丢弃超大记录；`E:9772-9773` 报 16384。
- **S2-1：** 数值验证（`normalMatrixOf` + `writeMat3` + `glState.normalMatrix * vin.normal`）：绕 z 旋转 90° 得 `(0,-1,0)`；剪切矩阵得 `(-1,1,0)`，逆转置应为 `(0,1,0)`；对角缩放正确。
- **S2-4：** 四边形顶点顺序 v0→v1→v3→v2，三角形 (v1,v2,v3) 反绕。
- **S2-6：** `E:7387` 键写 “off”，`E:7457-7458` 与 `E:7777-7791` 不看启用位。
- **S2-8：** `E:405-410` 与 `E:6968-6972`。
- **S2-9：** `E:2571-2603`；客体 `P:15683-15715` 发原始整数，缓存 `(GLfloat)int`。
- **S2-10：** `FF:451-459` 循环 `i < 4`；`E:7060-7062`；`E:8106-8107` 拷贝所有平面。
- **S2-20：** `E:4417-4456` 无数据时 `pixels = null`；`E:4466-4470` 拒绝；客体 `glTexImage2D(NULL)` 发 0 字节。
- **S2-22：** `E:780-858` 打包类型在格式交换之前 `return`。
- **S2-27：** `E:63` 单元数 8；`E:2638` 拒绝；`E:7640` 夹取。
- **S2-30：** `P:5441-5456` 录制所有记录；`glDeleteTextures`（`P:12383`）、`glBindBufferARB`（`P:12839`）都经 `emit_gl_call`。
- **S2-32：** `P:5512-5535` 恒定深度；`P:9783-9792` 每个 `glEnd` 记一次命中。
- **S2-33：** `P:2007-2008` 两层栈，8 个单元共用一个纹理栈。
- **S2-40、S2-41：** 我用翻译器 + naga 跑过：局部变量 `float filter` → “name `filter` is a reserved keyword”；`const int N = 4; uniform vec4 a[N];` → 编译失败；`uniform float u = 0.5` 编译通过但 WGSL 里没有 0.5；`mod()` 翻译正确。
- **S2-46、S2-47：** `E:9546-9562`（env 与 local 都写到绑定的程序上，未绑定时 `INVALID_OPERATION`）；`A:38` 为 28。
- **S2-48：** 我调用 `compileARBProgram` 验证：`PARAM c[5] = { program.local[0..4] };` 在数组不被读取时能编译，一旦 `MOV result.position, c[1];` 就以 “'00.4'” 失败；逐个列出 `program.local[0], …` 的写法能编译；PARAM 数组的相对寻址、内联标量常量（`MUL r, fragment.color, 2.0;`）和内联向量常量（`{1,0,0,1}`）都失败。我第一次的探针没有读取数组，因而一度误判区间没问题。
- **S2-21：** `E:4612-4635` 的完整性检查总是从 0 级开始，mipmap 过滤时要求完整的级链，不看 `BASE_LEVEL`/`MAX_LEVEL`。
- **参照原型：** 我重新运行了 `./ref hw`、`./ref sw` 和执行器一侧的 runner，三份输出都与审查员的逐字节相同；`compare.js` 再次给出 22 通过、32 失败。
- **真 GPU：** 我在本机 Chrome/Metal 上复跑了测试审查员的探针页（scratch 里的源码与仓库逐字节相同），结果见 §6.1。
- **文档：** 站点 `8bcd2f7`（2026-09-06）删除了 `glbridge/gl-webgpu/README.md`（208 行，D-01..D-18）和 `gl_protocol.json`；副本在共享笔记目录的 `deleted-gl-webgpu-README.md`。
- **重复度：** GL 执行器与 D3D9 执行器按 6 行窗口共享 0 行；`opengl32_proxy.c` 自我重复 1836/14173 规范化行（13%）。

## 附录 B：原始分区报告

共享笔记目录 `gl-review/` 下：

- `review-guest-core.md`：客体核心；
- `review-guest-api.md`：客体 API 层；
- `review-host-core.md`：执行器核心与资源；
- `review-host-draw.md`：绘制路径；
- `review-fixed-function.md`：固定管线；
- `review-shaders.md`：GLSL/ARB；
- `review-tests.md`：测试体系；
- `review-oracle.md`：macOS OpenGL 参照原型；
- `verified.md`：我的核实记录；
- `deleted-gl-webgpu-README.md`：被删除的偏差清单。

探针脚本和 WGSL 输出在会话 scratchpad 的 `gl/` 目录（`/private/tmp/claude-501/-Users-renruisi-Desktop-Code/50408d07-4a2e-4b0d-8e3b-129303a09430/scratchpad/gl/`），重启后可能被清除。

## 附录 C：macOS OpenGL 参照原型

### 做法

- **一份场景描述**（`scenes.js`）：每个场景是一串 GL 调用。64×64 的帧缓冲分成 16×16 的方块，每块内部 12×12 是一个探针。
  - “点状”方块把四边形收缩到眼空间的一个点，再用投影放大。这样光照、雾、texgen 在每个顶点看到的输入完全相同，逐顶点与逐像素、三角化方式都不会造成差异。
- **参照一侧：** `gen_c.js` 把场景翻译成 C，`ref.c` 用 CGL 为每个场景新建一个 OpenGL 2.1 上下文，画进 64×64 RGBA8 + DEPTH24_STENCIL8 的 FBO，输出 RGBA、额外读回、第一个 GL 错误及其调用序号、编译日志。主参照是 M1 的硬件渲染器，Apple 软件渲染器作第二意见。它还打印枚举表，与 `gl_constants.js` 比对（0 处不一致）。
- **被测一侧：** `to_stream.js` 把同一串调用编码成 VGL2 记录，编码方式照 `opengl32_proxy.c` 的每个入口（计数、`Color3f→COLOR4F`、ub/255 等），在 headless Chrome 里驱动 `GLWebGPUExecutor`，经执行器自己的 `READ_PIXELS` 读回，并收集每个场景的校验错误、拒绝和控制台警告。
- **比较：** 规则见 §8.2。
- 文件在共享笔记目录 `gl-review/oracle/`（`scenes.js`、`gen_c.js`、`ref.c`、`to_stream.js`、`oracle.html`、`runner.js`、`compare.js`、`report.txt`、`png/<场景>.png` 为“Apple | 执行器 | 差异图”）。

### 结果汇总：22 通过，32 失败

| 结果 | 场景 |
| --- | --- |
| 通过 | `texenv_modulate`/`replace`/`decal`/`blend`/`add`（全部模式 × ALPHA/L/I/LA/RGB/RGBA）、`texenv_combine`（INTERPOLATE、DOT3、ADD_SIGNED、SUBTRACT、比例、ONE_MINUS 操作数、两个单元）、`texenv_crossbar_unit1_on`、`fog`（LINEAR/EXP/EXP2、FOG_COORD）、`light_positional_spot`（衰减与聚光，Apple 硬件在锥外方块上算错，我们与软件渲染器和手算一致）、`clear_scissor_mask`、`depth_offset_range`、`alpha_test`（127 与 128/255 对 0.5，六种函数）、`logic_op`（16 种逐位一致）、`stencil_ops`、`copy_pixels_teximage`、`fbo_render_to_texture`、`accum`（以手算为参照）、`points_size4`、`lines_width3`、`lines_width1`、`polygon_stipple`、`cull_frontface`（含镜像 modelview） |
| 失败：本文问题 | `light_normal_matrix`、`glsl_normal_matrix`（S2-1）；`light_basic`（S2-2）；`mipmap`（S2-3，以及 LOD bias）；`primitives`、`strip_winding_cull`（S2-4）；`flat_provoking`、`flat_lines`、`draw_elements`（S2-5）；`viewport_offscreen`（S2-7）；`blend`（S2-8）；`light_integer_params`（S2-9）；`clip_planes`（S2-10）；`color_clamp_sum`（S2-11、S2-17）；`projective_texcoord`、`texgen`（S2-12）；`light_twoside_colormaterial`（S2-13）；`polymode_line`、`polymode_front_line_back_fill`（S2-14）；`drawpixels_bitmap`（S2-15）；`glsl_semantics`（`gl_FrontColor` 不钳制，S2-17）；`tex_formats_unpack`（S2-22）；`readpixels_formats`（S2-23）；`arb_fragment_program`、`arb_vertex_program`（S2-48、S2-50）；`arb_fp_semantics`、`arb_vp_semantics`、`arb_diag`（S2-46、S2-51、S2-52）；`tex_wrap_border`（S3 边框色） |
| 失败：校验错误让整帧丢失 | `depth_range_reversed`（S1-2d）、`texenv_crossbar_unit1_off`（S1-2g）、`polymode_point`（S1-2e） |

### 参照本身的问题

- Apple 的 FBO 上没有累积缓冲，`accum` 以手算为参照。
- Apple 硬件渲染器有 3 个光照方块什么也没画，1 个聚光方块算错；这些地方软件渲染器、手算与我们的执行器一致。
- Apple 软件渲染器的 COLOR_MATERIAL 跟踪和顶点程序 `EXP` 的 x 分量错。
- 对 crossbar 指向禁用单元的情况，两个 Apple 渲染器都输出黑色；规范要求主颜色直通。
- 对每个有争议的方块，审查员都做了手算。

### 局限

- 不经过客体 DLL：显示列表、PushAttrib、客体缓存都没有覆盖。
- 主要调用的记录编码与客体源码核对过，其余是按客体的写法推定的。
- 只跑了 Chrome 的 Metal 后端。
- 没有运行任何游戏，严重程度按常见用法判断。
