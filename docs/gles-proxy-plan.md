# 共享 GLES 代理实施计划

状态：设计与实施计划，尚未实现。2026-10-27 初稿。

本计划给 v86 的 ARM 客体加上 OpenGL ES 的 GPU 加速：客体的 GLES 调用编码后交给宿主，在页面上用 WebGPU 执行。
它服务两类客体，宿主侧只写一次：

1. **32 位 Android**：`ranchu` 上的 Android 7.1（[arm32.md](arm32.md)）。镜像自带 Android 模拟器的 GLES 客体栈，
   客体一个文件都不用改。**先做它。**
2. **iOS**：[iphone4-plan.md](iphone4-plan.md) 的 S5。v86 自己写客体侧的库，复用同一个宿主。

协议用 Android 模拟器的 emugl 协议，也就是今天 gfxstream 的 GLES 协议：renderControl 加 GLESv1、GLESv2 的
操作码。

## 现状（2026-10-27 核对）

- **Android 7.1 镜像的客体栈是现成的。** `armeabi-v7a-25_r18` 的 `system.img` 里有：
  - `lib/egl/libEGL_emulation.so`、`libGLESv1_CM_emulation.so`、`libGLESv2_emulation.so`；
  - 编码器 `lib/libGLESv1_enc.so`、`libGLESv2_enc.so`、`lib_renderControl_enc.so`、`libOpenglSystemCommon.so`；
  - `lib/hw/gralloc.ranchu.so`、`gralloc.goldfish.so`。

  它们经 goldfish pipe 的 `opengles` 服务把命令交给宿主。今天的 Android 模拟器仍用同一套宿主解码器
  （gfxstream）运行这些老镜像。
- **v86 的 `ranchu` 现在用 `qemu.gles=0`**（`src/virt/ranchu.js` 的内核命令行）：界面由客体 CPU 绘制，很慢
  （arm32.md 的 “Known defects”）。goldfish pipe 已经实现（`src/virt/goldfish.js`，版本 1），服务有
  `boot-properties`、`hw-control`、`sensors`；`opengles` 会被拒绝。
- **v86 的 gfxstream 还没有解码任何 renderControl 命令。**
  - 已有的：virtio-gpu 上的 gfxstream 传输（ASG 环）、按操作码区间把命令分派给各解码器的框架
    （`src/graphics_adapters/virtio_gpu/gfxstream.js`）、Vulkan 解码器、进程管道 `GLProcessPipe`；
  - 没有的：Android 16 的官方模式在客体内合成，不发 renderControl（[gpu-devices.md](gpu-devices.md) 的 G-59）。
- **GL→WebGPU 执行器已经有**（`src/browser/glbridge/gl-webgpu/`，服务 XP 的 OpenGL 代理）：
  - 有 GL 1.1–2.1 的状态机、GLSL 1.20 前端、固定功能、ARB 程序；
  - 它把权威的 GL 状态放在执行器里，同步回答 `glGet*`。这对 GLES 不适用，见“影子状态”。

## 结论

1. **一套协议、一个宿主。** 解码器、renderControl、影子状态与执行器由 Android 与 iOS 共用。
2. **解码器由规格文件生成。** 规格文件是 emugl/gfxstream 的 `*.in`、`*.attrib`、`*.types`：每个调用的参数、
   指针参数的方向与长度表达式。来源按 Android 7.1 时代的 `device/generic/goldfish-opengl` 与 gfxstream 两个版本
   核对，并固定在提交上。同一个生成器还输出：
   - 测试用的 JS 编码器；
   - iOS 用的 C 编码器。
3. **查询不等页面。** 解码在 CPU 侧（机器线程或 CPU Worker），渲染在页面上，两者之间是异步的渲染器通道。
   CPU 侧保存影子状态，`glGetError`、`glGetIntegerv`、`glGen*` 等直接回答；只有必须看 GPU 结果的调用
   （`glReadPixels`、`glFinish`、`rcReadColorBuffer`、同步对象）才等页面。
4. **执行器在 gl-webgpu 上扩展，不另起炉灶。**
   - 先把 `gl_executor.js` 分成两层：不碰 WebGPU 的状态层，和 WebGPU 后端；
   - XP 的路径继续把两层放在一起用；
   - GLES 的影子状态复用状态层，页面上的 GLES 执行器复用后端。
5. **传输各接各的：**
   - Android：goldfish pipe 的 `opengles` 服务；
   - iOS：一条用户态的后门指令，因为 iOS 的用户进程没有内核驱动，碰不到 MMIO 设备，见“iOS 传输”。
6. **先 Android，再 iOS。** Android 用未经修改的真实编码器驱动宿主，宿主侧的错误在没有逆向的环境里先排干净。

## 架构

```text
=== guest ======================================================================
 Android 7.1 (armeabi-v7a, ranchu)                 iOS 6 (armv7, s5l8930) / Linux armv7 测试程序
 libEGL_emulation + libGLES*_enc                   libv86gles (生成的 C 编码器 + 适配层)
 + lib_renderControl_enc + gralloc.ranchu
      │ goldfish pipe "opengles"                         │ 后门指令 (UDF) + 进程内的环
=== CPU thread (or CPU worker) =================================================
 src/gles/: 流 → 解码器 (rc 10000+, GLESv1, GLESv2 的操作码区间)
            参数按 .attrib 的方向与长度读写客体内存
            影子状态: 错误、对象名、查询、上下文与共享组
            renderControl: 配置、上下文、窗口表面、颜色缓冲、FBPost、同步
            批次写入器 → 渲染器通道的 stream "gles"
=== page (WebGPU) ==============================================================
 gl-webgpu: GLES 执行器 = 状态层 + WebGPU 后端, GLSL ES 前端, ETC1/PVRTC
 颜色缓冲 = GPU 纹理; FBPost → 合成器层 (或回读到机器的帧缓冲)
```

### 模块

| 位置 | 内容 |
| --- | --- |
| `tools/gles/gen.mjs` | 读规格文件，生成：`src/gles/gles_protocol.js`（各调用的操作码、参数布局、方向、长度表达式）、测试用的 JS 编码器、iOS 与 Linux 测试用的 C 编码器 |
| `src/gles/gles_stream.js` | 一条连接的流：命令头（操作码、总长）、跨读写的拆分、回复的组装、按区间分派 |
| `src/gles/gles_decoder.js` | 按生成的布局取参数；`in` 指针从流中取，`out` 指针的结果写回回复；返回值 |
| `src/gles/gles_shadow.js` | 影子状态：GLES 1.1 与 2.0 的可查询状态、错误码、对象名空间（纹理、缓冲、程序、着色器、FBO、渲染缓冲），上下文与共享组；复用 gl-webgpu 的状态层 |
| `src/gles/render_control.js` | renderControl：渲染器与 EGL 的版本和字符串、主机扩展字符串、配置、上下文、窗口表面、颜色缓冲（创建、打开、关闭、更新、读回、绑定为纹理或渲染缓冲）、`rcFBPost`、交换间隔、同步 |
| `src/gles/gles_batch.js` | GLES 批次：自包含（数据随批次走），与 D9WG、GX 同样的顺序与完成规则 |
| `src/virt/goldfish.js` | goldfish pipe 新增 `opengles` 服务：连接开始的客户端标志，之后是流；回复可读时唤醒客体 |
| `src/gles/backdoor_a32.js` | iOS 与 Linux 测试用的传输：用户态后门指令与进程内的环 |
| `src/browser/glbridge/gl-webgpu/` | 拆出状态层（`gl_state.js`）；新增 `gles_executor.js`（批次 → 状态层 + 后端）、`gles_textures.js`（ETC1、PVRTC 的解码与 ETC2 直传）；`gl_shader_translator.js` 增加 GLSL ES 1.00 方言 |
| `src/browser/glbridge/svga_renderer.js` | 渲染器增加 stream `"gles"` |
| `src/virt/ranchu.js`、`src/apple/` | 机器拿到渲染器通道。现在只有显示适配器插件有，这两台机器的 `graphics_adapter` 是 `"none"` |

## 设计细节

### 协议与生成器

- **命令格式**：每个命令是操作码（u32）、命令总长（u32），后面是参数。
  - `in` 指针：参数位置写长度，数据随命令走；
  - `out` 指针：只写长度，宿主把结果放进回复；
  - 返回值与 `out` 数据在回复中的顺序由规格决定；
  - 操作码区间：GLESv1 从 1024、GLESv2 从 2048、renderControl 从 10000 开始，以固定的规格文件为准。
- **长度表达式**：`.attrib` 里的 `len`（如 `glTexImage2D` 的像素大小由宽、高、格式、类型、对齐算出）在生成器
  里翻译成 JS 与 C 两份，由测试互相核对。
- **客户端标志与主机扩展**：连接开始时客体写一个标志字。随后客体通过 renderControl 询问主机支持的特性
  （`ANDROID_EMU_*` 一类的字符串）。v86 只声明 Android 7.1 的编码器认识、而且已经实现的特性，起步时为空，
  走最老、最简单的协议。哪些查询、哪些字符串在 E0 从客体库与 gfxstream 宿主源码中整理。
- **校验**：emugl 有可选的命令校验和，按客体与主机协商。v86 不声明它。

### 影子状态

- **回答查询**：
  - 状态：`glGetError`、`glGetIntegerv`/`Floatv`/`Booleanv`、`glIsEnabled`、`glGetString`；
  - 对象：`glIs*`、`glGetTexParameter*`、`glGetBufferParameteriv`、`glGetRenderbufferParameteriv`；
  - 程序：`glGetShaderiv`、`glGetProgramiv`、`glGetShaderInfoLog`、`glGetProgramInfoLog`、
    `glGetUniformLocation`、`glGetAttribLocation`、`glGetActiveUniform`、`glGetActiveAttrib`；
  - FBO：`glCheckFramebufferStatus`。
- **着色器在 CPU 侧编译。** 程序的链接结果（错误、uniform 与 attribute 的表）需要在 CPU 侧知道，所以 GLSL ES 的
  前端（语法、语义、链接）在 CPU 侧也要能跑：它是纯 JS，与页面上的执行器共用。WGSL 的生成与 WebGPU 的编译
  仍在页面上。
- **`glGen*` 与名字**：名字由影子状态分配；页面上的执行器用同样的名字建对象。
- **错误语义**：影子状态按 GLES 规范判断参数是否合法，记下 `GL_INVALID_*`；被它判为错误的调用不进批次。
- **必须等 GPU 的调用**：`glReadPixels`、`glFinish`、`rcReadColorBuffer`、等待同步对象。设备发出批次并等它的
  `done` 与回读，期间客体的读取阻塞：Android 由 pipe 的唤醒机制完成，iOS 由环的轮询完成。

### 执行器（页面）

- 批次进入 GLES 执行器，它驱动 gl-webgpu 的状态层与 WebGPU 后端。GLES 2.0 没有固定功能。GLES 1.1 用现有的
  `gl_fixed_function.js`。
- **GLSL ES 1.00**：精度限定符；ES 的内建变量与限制；`gl_FragColor`/`gl_FragData`；没有固定功能的内建状态。
  在现有前端上加方言，不重写。
- **纹理格式**：
  - RGBA/RGB/ALPHA/LUMINANCE/LUMINANCE_ALPHA 的 8 位与 565/4444/5551 打包格式（WebGPU 没有打包格式，展开
    存放）；
  - ETC1（Android 的 `GL_OES_compressed_ETC1_RGB8_texture`）：有 `texture-compression-etc2` 时按 ETC2 RGB8 直传，
    否则解码；
  - PVRTC（iOS 的 `GL_IMG_texture_compression_pvrtc`）：一律解码成 RGBA；
  - 深度与模板格式；
  - 外部纹理（gralloc 的 YUV 缓冲，`GL_OES_EGL_image_external`）：转换成 RGBA，E4 处理。
- **颜色缓冲**：renderControl 的颜色缓冲是页面上的 GPU 纹理。它可以绑定成窗口表面、纹理或渲染缓冲；CPU 写入
  （`rcUpdateColorBuffer`，gralloc 的软件缓冲）作为上传进入批次。
- **呈现**：`rcFBPost` 指定的颜色缓冲就是屏幕：
  - 有图形代理的合成器时直接放进合成器层，不回读；
  - 否则回读到机器的帧缓冲：ranchu 的 simple-framebuffer，iPhone 的 CLCD。

### 渲染器通道

GLES 批次走现有渲染器（`svga_renderer.js`）的通道，新增 stream `"gles"`。顺序、完成与渲染器丢失的规则与
D9WG、GX 相同（[gpu-devices.md](gpu-devices.md) 的 “Architecture”）。`ranchu` 与 `s5l8930` 现在没有渲染器通道：
机器在启用 GLES 时向页面申请一个，与显示适配器插件的做法相同。没有渲染器（页面没有 WebGPU）时：
- Android 明确要求 `gles: "host"` 就报错；VM 管理器在这种页面上选 `"software"`，也就是 `qemu.gles=0`；
- iOS 没有主屏幕。

### Android 传输：goldfish pipe 的 `opengles`

- 客体打开 `pipe:opengles`，先写客户端标志，之后是命令流；从同一通道读回复。每个使用 GLES 的线程一条连接。
  它们按进程归组，属于同一进程的上下文共享对象。进程归属由 renderControl 的进程相关调用确定，E0 核对。
- **读**：回复没准备好时返回“再试”，回复就绪时用 pipe 的唤醒寄存器叫醒客体。现有的服务已经有这套机制。
- **写**：命令可能跨多次写入；流按命令头组装完整命令再解码。
- **启用**：选项 `gles: "host"`（`ranchu` 专用；默认 `"software"`，与现在相同）。打开后：
  - 内核命令行改成 `qemu.gles=1`；
  - 补上镜像依赖的其他属性（`ro.opengles.version` 等），按 Android 模拟器给 API 25 镜像的做法，E0 核对；
  - 机器申请渲染器通道。没有渲染器时启动失败并说明原因，不悄悄退回软件绘制。
- **吞吐**：pipe 版本 1 的每次读写都要走寄存器，开销大。E5 测量；Android 7.1 的 3.10 内核如果支持带批缓冲的版本 2，
  就改用版本 2。

### iOS 传输：用户态后门指令

iOS 的用户进程没有内核驱动就无法映射设备寄存器，而为 iOS 6 构建内核扩展不现实。所以 iOS 走一条“后门”，
与 x86 上 VMware 后门端口允许用户态访问的做法相同：

- **指令**：`UDF #0x8664`（“v86”的谐音），两种编码：

  | 指令集 | 编码 |
  | --- | --- |
  | A32 | `0xE7F866F4` |
  | T32 | `0xF7F8 0xA664`（`UDF.W`） |

  - 选这个立即数是为了避开已有的用法：Linux 的断点与 BUG 用 A32 的 `0xE7F001F0`–`0xE7F001F2` 与 Thumb 的
    `0xDE01`、`0xDE02`，LLVM 与苹果工具链的 `trap` 是 `0xE7FFDEFE` 与 Thumb 的 `0xDEFE`。
  - 只有这两个编码、只在 PL0 执行时才被截获；其他 `UDF` 照常是未定义指令。
- **调用约定**：
  - `r0` 是命令，高 16 位必须是 `0x8664`，低 16 位是命令号：探测、打开连接、提交、查询完成、关闭；
  - `r1` 是用户虚拟地址，`r2` 是长度，`r3` 是连接号；
  - 返回值写回 `r0`：0 成功，负数是错误（缺页、再试、参数错、未开启）；
  - 处理后 PC 前进一条指令。
  - 高 16 位不对时，照常产生未定义指令异常。这样一条偶然执行到的 `UDF` 不会被误当成调用。
- **选项与范围**：选项名 `gles_backdoor`（布尔），只用于 arm32 机器。`s5l8930` 默认开启；其他机器默认关闭，`virt`
  只在测试中开启。关闭时这两个编码也照常是未定义指令。客体库第一次使用前，在 `SIGILL` 处理器的保护下发一次
  “探测”命令。没有开启时，它得到 `SIGILL` 并报告“没有 GLES 后门”，而不是让进程崩溃。
- **内存**：每条连接一个进程内的环，地址由打开时给出。设备通过当前的页表把用户地址翻译成物理地址。页不在
  内存中时，调用返回“缺页”，客体库访问一下该页再重试。客体库会预先锁住环的页，所以这种情况应当很少。
- **完成**：提交立即返回；需要回复的调用由客体库轮询完成状态，带退避（`sched_yield`），不阻塞 CPU 线程。
- **快照**：环在客体内存中，设备只保存每条连接的读写位置与未完成的回复。

在 iOS 能启动之前，后门与编码器先在 `virt` 的 Alpine armv7 上用一个 Linux 测试程序验证（E6）。

## 阶段

### E0 调研与固定

- 固定规格文件的来源与提交：Android 7.1 时代的 `device/generic/goldfish-opengl` 与 gfxstream。
- 从客体库与宿主源码整理：
  - renderControl 中 API 25 的编码器会调用的命令；
  - 它询问的主机扩展字符串；
  - `qemu.gles=1` 下镜像需要的属性；
  - gralloc.ranchu 对颜色缓冲的用法（格式、CPU 写入、FBPost）。
- 设计 `gl_executor.js` 拆分为状态层与后端的方案。

验收：清单与拆分方案写进本计划的“复核结论”；E1–E6 按清单修正。

### E1 生成器、传输与 renderControl

- `tools/gles/gen.mjs` 生成协议表与 JS 编码器；
- goldfish pipe 的 `opengles` 服务与流；
- renderControl 的全部命令；
- GLES 的调用此时只解码与计数，不渲染。

验收：`qemu.gles=1` 下 Android 7.1 的 `sys.boot_completed` 为 1；没有未知操作码；每种调用的次数统计写进复核
结论。此时屏幕没有内容，作为预期。

### E2 影子状态与批次

- 影子状态与错误语义；CPU 侧的 GLSL ES 前端（语法、语义、链接）；
- 批次写入器；
- `ranchu` 的渲染器通道；
- 把一次启动的全部批次录成文件，供 E3 离线重放。

验收：单元测试；启动过程中没有任何查询等待页面；录下的批次能在 Node 中解析。

### E3 执行器与 Android 主屏幕

- `gl_executor.js` 拆分（XP 的 OpenGL 回归不变）；
- GLES 2.0 执行器、GLSL ES 到 WGSL、FBO 与渲染缓冲、纹理格式与 ETC1、颜色缓冲、`rcFBPost` 的呈现。

验收：
- Android 7.1 用主机 GPU 合成，进入主屏幕；启动动画、桌面、设置、滚动列表正常；
- 截图与 `qemu.gles=0` 的软件绘制结果做结构相似度比较（字体与抗锯齿允许差异）；
- E2 录下的批次在浏览器测试中重放，像素与参考一致。

### E4 GLES 1.1 与兼容性

- GLESv1 解码与固定功能；
- EGL 同步、交换间隔、多进程、多上下文与共享；
- 外部纹理（YUV）；
- 主机扩展按需补充。

验收：
- **dEQP**：用 Android CTS 7.1 的 32 位 ARM 包中的 `CtsDeqpTestCases`，测试方法照 Android 16 的 dEQP 工具：
  - 子集的组成：
    - 抽样：从 dEQP-GLES2 的 functional 各组均匀抽约 1500 个用例。覆盖着色器（运算、常量、swizzle、条件、
      循环、函数、纹理函数）、纹理（格式、尺寸、wrap、过滤）、FBO、片段操作（混合、深度、模板）、缓冲写入、
      光栅化、多边形偏移、清除、深度范围、attribute 位置、uniform API、顶点数组；
    - 全部收入，不抽样：`state_query` 与 `negative_api` 两组，它们直接检验影子状态；
    - 另加 `dEQP-EGL.info`；
    - 不收：性能、压力、多线程与 `flush_finish`（计时）各组。
  - 目标：
    - 在支持的用例中通过率 ≥ 97%；`state_query` 与 `negative_api` ≥ 99%；
    - 没有崩溃、挂起或超时；
    - 每个失败归类：要么修掉，要么作为偏差记入 gpu-deviations.md。
  - 参照：Android 16 在 Venus 上的 GLES3 抽样，在支持的用例中通过 99.5%（[aarch64.md](aarch64.md)）。
- **APK**：都是开源的，能合法下载或从源码构建，满足 32 位与 API 25：
  - **自建测试 APK**（源码进仓库，照 `tests/a32/android/v86arm32.c` 与 `tests/a64/apk.mjs` 的做法）：
    NativeActivity 画固定的 GLES 1.1 与 GLES 2.0 场景（纹理、混合、FBO、ETC1），用于像素比较；
  - **Replica Island**：Google 的开源游戏，Java 加 GLES 1.0；
  - **Shattered Pixel Dungeon**：libGDX 加 GLES 2.0，原生库有 armeabi-v7a。
  - 两个游戏的版本固定在 F-Droid 上支持 API 25 与 armeabi-v7a 的构建，E0 核对。下载前征得所有者同意。
  - 验收：自建 APK 的像素与参考一致；两个游戏能进入游戏画面并操作一分钟。

### E5 性能、快照与界面

- **性能**：批次大小、影子状态覆盖率、上传路径、pipe 版本 2（若内核支持）；
  合成器层呈现，不回读；测量启动时间与界面帧率。
- **快照**：
  - CPU 侧保存影子状态与 pipe 连接；
  - `prepare_save` 把纹理、缓冲、渲染缓冲与颜色缓冲的内容读回并存入快照；
  - 恢复时在新的渲染器上重建；
  - 不用图形日志重放：XP 上恢复时长达 70 秒的黑屏就是它造成的。
- **界面**：VM 管理器中 Android 7.1 的设置项“GPU”，选项为“主机（WebGPU）”和“软件”。页面有 WebGPU 时
  默认用主机。`make app-tests` 增加用例。
- **文档**：[arm32.md](arm32.md) 与 [gpu-devices.md](gpu-devices.md) 增加 GLES 一节，偏差记入
  [gpu-deviations.md](gpu-deviations.md)。

验收：快照往返后画面与状态一致；性能报告写进文档。

### E6 iOS 传输与客体库的公共部分

- arm32 的后门指令、`backdoor_a32.js`；
- 生成器输出 C 编码器；`libv86gles` 的传输与编码部分（不含 iOS 适配）；
- 用同一套源码构建一个 Linux armv7 测试程序：在 `virt` 的 Alpine armv7 上画三角形、纹理与 FBO，经后门交给宿主。

验收：
- Linux 测试程序的画面与参考像素一致；
- 缺页重试、多线程多连接、快照中途的连接都有用例。

iOS 特有的部分（EAGL 与 IOSurface 的适配、Core Animation 的私有扩展、PVRTC、注入）在 iphone4-plan.md 的 S5 完成。

### E7（可选）Android 16 的 GLES 模式

Android 16 现在用客体内的 ANGLE：GLES 在客体里翻译成 Vulkan，再经 gfxstream 的 Vulkan 交给宿主。它能用（GLES 3.0），
但界面慢：
- Launcher3 的一帧在热状态下约 0.8–1.4 秒；
- 新画面要几秒；
- 一个 GL 应用持续约 14 fps（[aarch64.md](aarch64.md)）。

E7 改用 gfxstream 的 GLES 能力集（capset 8，Cuttlefish 的 `egl=emulation`），GLES 调用直接交给本计划的宿主：
- ANGLE 的状态校验、着色器编译（glslang 到 SPIR-V）与 Vulkan 编码不再在模拟的 CPU 上运行；
- 着色器改在宿主上用 JS 原生速度翻译。

**代价比“同一组解码器”大得多。** Android 16 要求 GLES 3.0 以上，而 E0–E6 的执行器只到 GLES 2.0。E7 要把执行器与
GLSL ES 前端扩到 3.0（uniform 缓冲、多渲染目标、实例化、变换反馈、3D 与整数纹理、采样器对象、GLSL ES 3.00），
规模接近 WebGL 2。这还会给 Android 16 留下两条要维护和测试的 GLES 路径。

**做不做由测量决定，不在 E0–E6 之内。** E5 之后在 Android 16 上采样一次 Launcher3 的帧，统计客体时间落在 ANGLE、
Vulkan 驱动（`libGLESv2_angle.so`、`vulkan.ranchu`）与着色器编译上的比例：
- 占到帧时间的三成以上（尤其是冷画面里的编译），就做 E7；
- 否则不做，把精力放在客体 CPU 的性能上。

## 测试

| 层 | 位置 | 运行方式 |
| --- | --- | --- |
| 生成器：JS 与 C 两份长度表达式一致；JS 编码器与解码器往返 | `tests/gles/protocol.mjs` | `make gles-tests` |
| 流：拆分的写入、拼接、回复顺序、未知操作码的处理 | `tests/gles/stream.mjs` | `make gles-tests` |
| 影子状态：查询、错误语义、名字空间与共享组，对照 GLES 规范的用例 | `tests/gles/shadow.mjs` | `make gles-tests` |
| renderControl：配置、上下文、表面、颜色缓冲、FBPost、同步 | `tests/gles/render_control.mjs` | `make gles-tests` |
| goldfish pipe 的 `opengles` 服务：标志、阻塞读与唤醒、快照 | `tests/devices/goldfish_pipe_gles.mjs` | `make devices-test` |
| GLSL ES 前端与 WGSL：着色器语料（E1 起从 Android 的启动中收集）经 naga 校验 | `tests/glbridge/glsl_es_wgsl_test.js` | `make test-glbridge` |
| 执行器：录下的批次重放，比较像素 | `tests/glbridge/gles_*_browser_test.html` | `make display-browser-tests` |
| XP 的 OpenGL 回归（拆分后不变） | 现有的 gl-webgpu 测试与 Cube 2 语料 | `make test-glbridge` |
| Android 7.1 客体 | `tests/a32/android_boot.mjs` 加 `A32_ANDROID_GPU=host` | 手动 |
| dEQP-GLES2 子集（CTS 7.1 的 32 位 ARM 包） | `tests/a32/android_deqp.mjs`：`tests/a64/android_deqp.mjs` 的 32 位版本，CTS 由 `tools/a64_cts.mjs` 的同一流程取得 | 手动 |
| 自建 GLES 测试 APK 的像素 | `tests/a32/android_gles.mjs` | 手动 |
| 后门与 Linux 测试程序 | `tests/a32/gles_backdoor.mjs` | `make a32-tests` |

CI 跑 `make gles-tests`、`make devices-test` 与 `make test-glbridge`；浏览器与客体测试手动运行。

## 风险

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| API 25 编码器与新版规格的差异 | 解码错位 | 以 Android 7.1 时代的规格为准，差异由 E1 的往返测试与客体启动发现 |
| 必须等 GPU 的调用多 | 客体卡顿 | 影子状态覆盖查询；E1 统计这类调用的次数 |
| pipe 版本 1 的吞吐 | 帧率低 | E5 测量；版本 2；合并小写入 |
| GLSL ES 的翻译 | 个别着色器错误 | 语料与 naga；dEQP 子集 |
| `gl_executor.js` 拆分影响 XP 路径 | OpenGL 游戏回归 | 拆分单独提交，现有测试与 Cube 2 语料全部通过才合并 |
| 颜色缓冲的格式与 YUV | 视频与相机画面错误 | E4 处理外部纹理；先保证界面 |
| 页面没有 WebGPU | 无法加速 | 退回软件绘制，与现在相同 |
| iOS 后门与 XNU 的交互 | iOS 上不可用 | E6 在 Linux 上先验证；iOS 只多一层适配 |

## 已定（2026-10-27）

所有者不确定这几项，按以下默认推进；需要时随时改：

1. **E4 的验收**：dEQP-GLES2 子集与目标、三个 APK，见 E4。
2. **后门**：`UDF #0x8664`（A32 `0xE7F866F4`，T32 `0xF7F8 0xA664`），`r0` 的高 16 位为 `0x8664`；选项名 `gles_backdoor`；
   见“iOS 传输”。
3. **Android 的开关**：选项 `gles: "host" | "software"`，默认 `"software"`；VM 管理器在页面有 WebGPU 时选 `"host"`。
4. **E7**：现在不做，E5 之后按 E7 一节的测量结果决定。

## 规范与实现参考

- [gfxstream](https://android.googlesource.com/platform/hardware/google/gfxstream/)（Apache-2.0）：宿主的 GLES 解码器与
  renderControl、客体的编码器与规格文件；v86 已固定的提交见 [gfxstream-protocol.md](gfxstream-protocol.md)
- [device/generic/goldfish-opengl](https://android.googlesource.com/device/generic/goldfish-opengl/)（Apache-2.0）：
  Android 7.1 时代的客体编码器与规格文件
- [Android 模拟器的 GPU 仿真文档](https://android.googlesource.com/platform/external/qemu/+/refs/heads/emu-master-dev/android/android-emugl/DESIGN)（emugl 的设计说明）
- Khronos：OpenGL ES 1.1、2.0 规范与 GLSL ES 1.00 规范；dEQP（VK-GL-CTS）
- v86 内部：[arm32.md](arm32.md)、[virt.md](virt.md)（ranchu）、[gpu-devices.md](gpu-devices.md)（渲染器通道、gfxstream）、
  [gfxstream-protocol.md](gfxstream-protocol.md)、[glbridge.md](glbridge.md)、[iphone4-plan.md](iphone4-plan.md)
