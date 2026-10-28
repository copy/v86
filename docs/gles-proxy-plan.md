# 共享 GLES 代理实施计划

状态：实施中。2026-10-27 初稿；同日复核：对照镜像、内核与代码核对。E0、E1、E2 已完成（2026-10-27、28，见“复核结论”的
“E0 结论”“E1 结论”“E2 结论”），下一步 E3。

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
  （gfxstream）运行这些老镜像。编码器是 2017 年的构建，已经带 GLES 3.x 的入口和 `*AEMU` 命令；宿主不宣告
  更高的版本时，客体只用 GLES 2.0（见“复核结论”）。
- **v86 的 `ranchu` 现在用 `qemu.gles=0`**（`src/virt/ranchu.js` 的内核命令行）：界面由客体 CPU 绘制，很慢
  （arm32.md 的 “Known defects”）。为了在这样慢的 CPU 上开得了机，设备模型（`src/android/devices.js` 的
  `RANCHU_25_ARMEABI_V7A`）还做了三件事：
  - 设成低内存设备（`ro.config.low_ram`），让 system_server 不用 GL：客体自带的 SwiftShader 的 JIT 被 SELinux
    拒绝，它的第一帧 GL 曾杀死 system_server；
  - 关掉开机动画；
  - 机器时钟放慢到宿主的十分之一。

  宿主 GLES 打开后，这三项要重新评估，见 E3。
- **goldfish pipe 已经实现**（`src/virt/goldfish.js`，向客体报版本 1）。服务只有 qemud 的 `boot-properties`、
  `hw-control`、`sensors`；`opengles` 与 `GLProcessPipe` 都会被拒绝。镜像的 3.10 内核带
  `goldfish_pipe_v2.c`，所以 pipe 版本 2 只取决于宿主报不报。
- **v86 的 gfxstream 还没有解码任何 renderControl 命令。**
  - 已有的：virtio-gpu 上的 gfxstream 传输（ASG 环）、按操作码区间把命令分派给各解码器的框架
    （`src/graphics_adapters/virtio_gpu/gfxstream.js`）、Vulkan 解码器；进程管道 `pipe:GLProcessPipe` 已经能回答
    （virtio-gpu 的 pipe 资源上）；
  - 没有的：rc 命令（10000 起）只计数、跳过、不回复。Android 16 的官方模式在客体内合成，不发 renderControl
    （[gpu-deviations.md](gpu-deviations.md) 的 G-59 与 “Not done” 中 renderControl 一行）。
- **GL→WebGPU 执行器已经有**（`src/browser/glbridge/gl-webgpu/`，服务 XP 的 OpenGL 代理）：
  - 有 GL 1.1–2.1 的状态机、GLSL 1.10/1.20 前端、固定功能、ARB 程序；`gl_executor.js` 约 9900 行；
  - 它把权威的 GL 状态放在执行器里，在送来查询的那次端口写入中同步回答 `glGet*`。这对 GLES 不适用，
    见“影子状态”；
  - 它是页面上的代码，不在 `libv86` 与 CPU Worker 的包里。CPU 侧要用的部分（GLSL ES 前端）得另外打包，
    见“结论”第 7 条。

## 结论

1. **一套协议、一个宿主。** 解码器、renderControl、影子状态与执行器由 Android 与 iOS 共用。
2. **解码器由规格文件生成。** 规格文件是 emugl/gfxstream 的 `*.in`、`*.attrib`、`*.types`：每个调用的参数、
   指针参数的方向与长度表达式。来源只用一份：gfxstream 在 [gfxstream-protocol.md](gfxstream-protocol.md) 里
   已经固定的提交。模拟器要运行所有老镜像，GLES 的操作码只增不改，所以新规格是老编码器的超集；API 25 的编码器
   用到哪些命令，由 E1 的开机核对（没有未知操作码）。老版本的 `device/generic/goldfish-opengl` 只作参考。
   同一个生成器还输出：
   - 测试用的 JS 编码器；
   - iOS 用的 C 编码器。
3. **查询不等页面。** 解码在 CPU 侧（机器线程或 CPU Worker），渲染在页面上，两者之间是异步的渲染器通道。
   CPU 侧保存影子状态，`glGetError`、`glGetIntegerv`、`glGen*` 等直接回答。
   - 只有要数据的调用才等页面：`glReadPixels`、`rcReadColorBuffer`；
   - `glFinish`（编码器发的是 `glFinishRoundTrip`）、`rcFlushWindowColorBuffer` 与等待同步对象只需要顺序：
     批次排进通道后，CPU 侧就回复；
   - 同时限制在途的批次数（背压），客体不会比页面快出太多。
4. **执行器复用 gl-webgpu 的无状态部分，不拆 XP 的执行器。**（复核时改。初稿是先把 `gl_executor.js` 拆成
   状态层与 WebGPU 后端。）
   - GLES 2.0 与 1.1 的状态比桌面 GL 2.1 小得多，而且不同：没有 `glBegin`、显示列表、ARB 程序与属性栈，
     默认值与错误规则也不同。影子状态在 `src/gles/` 里按 GLES 规范新写；
   - 共用的是页面执行器能直接调用的函数：常量表、GLSL 前端（加 ES 方言）、WGSL 生成、固定功能着色器的生成
     （`gl_fixed_function.js`）、纹理格式的转换、管线缓存；
   - `gl_executor.js`（XP 的 OpenGL 路径）原则上不动。E0 若发现值得共用的有状态代码，拆分单独提交，XP 的
     测试与 Cube 2 语料全部通过才合并。
5. **传输各接各的：**
   - Android：goldfish pipe 的 `opengles` 服务；
   - iOS：一条用户态的后门指令，因为 iOS 的用户进程没有内核驱动，碰不到 MMIO 设备，见“iOS 传输”。
6. **先 Android，再 iOS。** Android 用未经修改的真实编码器驱动宿主，宿主侧的错误在没有逆向的环境里先排干净。
7. **CPU 侧是一个设备插件。** 解码器、影子状态、renderControl 与 GLSL ES 前端打包成 `build/v86-gles.js`，与
   NE2000、SB16、virtio-gpu 的插件同一机制，只有启用 GLES 的机器才加载，`libv86` 与 CPU Worker 的包不变大。
   页面上的 GLES 执行器随图形代理（`make glbridge`）加载。

## 架构

```text
=== guest ======================================================================
 Android 7.1 (armeabi-v7a, ranchu)                 iOS 6 (armv7, s5l8930) / Linux armv7 测试程序
 libEGL_emulation + libGLES*_enc                   libv86gles (生成的 C 编码器 + 适配层)
 + lib_renderControl_enc + gralloc.ranchu
      │ goldfish pipe "opengles"                         │ 后门指令 (UDF) + 进程内的环
=== CPU thread (or CPU worker): plugin build/v86-gles.js ======================
 src/gles/: 流 → 解码器 (rc 10000+, GLESv1, GLESv2 的操作码区间)
            参数按 .attrib 的方向与长度读写客体内存
            影子状态: 错误、对象名、查询、上下文与共享组
            renderControl: 配置、上下文、窗口表面、颜色缓冲、FBPost、同步
            批次写入器 → 渲染器通道的 stream "gles"
=== page (WebGPU) ==============================================================
 gl-webgpu: GLES 执行器 (WebGPU, 调用共用的函数), GLSL ES 前端, ETC1/PVRTC
 颜色缓冲 = GPU 纹理; FBPost → 合成器层 (或回读到机器的帧缓冲)
```

### 模块

| 位置 | 内容 |
| --- | --- |
| `tools/gles/gen.mjs` | 读规格文件，生成 `src/gles/gles_protocol.js`（各调用的操作码、参数布局、方向）；E6 再加长度表达式与 iOS、Linux 测试用的 C 编码器 |
| `src/gles/gles_wire.js` | 按生成的布局取参数（`in` 指针从命令中取，`out` 指针留出回复的位置）、组装回复；测试用的 JS 编码器（`encode_command`、`decode_reply`） |
| `src/gles/gles_stream.js` | 一条连接的流：客户端标志、命令头（操作码、总长）、跨写入的拼接、按区间分派、回复的顺序（等页面的回复之后的命令先不解码）、未知操作码的计数 |
| `src/gles/gles_host.js` | 宿主：传输连接的服务 `opengles`（一条连接一个流）与 `GLProcessPipe`（进程号；它关闭时 renderControl 释放该进程的对象），调用统计 |
| `src/gles/gles_caps.js` | 宿主自己的数：EGL 配置（renderControl 的打包顺序）与 `eglChooseConfig` 的匹配和排序、EGL 与 GL 字符串、实现限制与状态初值 |
| `src/gles/gles_defaults.js` | E1 的默认回答（名字递增、编译链接成功、帧缓冲完整、查询给限制与初值）；E2 换成 `gles_shadow.js` |
| `src/gles/plugin.js` | 插件 `build/v86-gles.js` 的入口（种类 `gles`，`V86GlesHosts`）：把服务交给 ranchu 的 goldfish pipe |
| `src/gles/gles_shadow.js` | 影子状态：GLES 1.1 与 2.0 的可查询状态、错误码、对象名空间（纹理、缓冲、程序、着色器、FBO、渲染缓冲），上下文与共享组；按 GLES 规范新写（“结论”第 4 条） |
| `src/gles/render_control.js` | renderControl：渲染器与 EGL 的版本和字符串、主机扩展字符串、配置、上下文、窗口表面、颜色缓冲（创建、打开、关闭、更新、读回、绑定为纹理或渲染缓冲）、`rcFBPost`、交换间隔、同步 |
| `src/gles/gles_batch.js` | GLES 批次：自包含（数据随批次走），与 D9WG、GX 同样的顺序与完成规则 |
| `src/virt/goldfish.js` | goldfish pipe 新增两个服务：`opengles`（连接开始的客户端标志，之后是流；回复可读时唤醒客体），`GLProcessPipe`（进程号，逻辑与 gfxstream 已有的进程管道共用） |
| `src/gles/backdoor_a32.js` | iOS 与 Linux 测试用的传输：用户态后门指令与进程内的环 |
| `src/rust/aarch64/a32.rs` | 选项开启时，PL0 的两条后门 `UDF` 不进未定义指令异常，而是调用 JS 的后门处理；页层把它们当作步进，不编进原生代码 |
| `src/gles/page/` | 页面上的 GLES 执行器（E3）：`gles_executor.js`（批次 → WebGPU，运行同一个影子状态机）、`gles_textures.js`（格式展开成 RGBA8、ETC1 解码；PVRTC 在 iOS 时加）；`tools/build_glbridge.mjs` 用 esbuild 把它们打进 `libv86-webgpu.js`，GLSL 前端用包里已有的那份。ES 模块，所以不放在 `src/browser/glbridge/`（那里是 CommonJS 脚本） |
| `src/browser/glbridge/gl-webgpu/` | `gl_shader_translator.js` 增加 GLSL ES 1.00 方言（E2）；`gl_executor.js` 不动 |
| `src/browser/glbridge/svga_renderer.js` | 渲染器增加 stream `"gles"` |
| `src/virt/ranchu.js`、`src/android/devices.js`、`src/apple/` | 机器拿到渲染器通道（现在只有显示适配器插件有，这两台机器的 `graphics_adapter` 是 `"none"`）；ranchu 的 GPU 模式，见“Android 传输”中的“启用” |

## 设计细节

### 协议与生成器

- **命令格式**：每个命令是操作码（u32）、命令总长（u32，含这 8 字节），后面是参数。
  - `in` 指针：参数位置写长度，数据随命令走；大块数据（纹理像素、缓冲内容）可能在命令头之后单独写出；
  - `out` 指针：只写长度，宿主把结果放进回复；
  - 回复里依次是各 `out` 参数的数据与返回值，顺序以生成的编码器为准；
  - 操作码区间：GLESv1 从 1024、GLESv2 从 2048、renderControl 从 10000 开始，以固定的规格文件为准。
- **emugl 自己的命令**：GLES 里没有、编码器为不把客体内存交给宿主而加的命令（2026-10-27 在 API 25 的编码器中
  核对）：
  - 客户端顶点数组随绘制送数据：GLESv2 的 `glVertexAttribPointerData`/`Offset`、`glDrawElementsData`/`Offset`；
    GLESv1 的 `glVertexPointerData`、`glColorPointerData`、`glNormalPointerData`、`glTexCoordPointerData`、
    `glPointSizePointerData`、`glWeightPointerData`、`glMatrixIndexPointerData` 及各自的 `Offset` 版本。规范的
    `glVertexAttribPointer` 在客体内处理，换成这两种命令；
  - `glShaderString`（着色器源码）、`glFinishRoundTrip`、`glGetCompressedTextureFormats`；
  - GLES 3 的 `*AEMU` 命令（`glMapBufferRangeAEMU`、`glReadPixelsOffsetAEMU` 等）：宿主宣告 GLES 3 时才出现。
- **长度表达式**：`.attrib` 里的 `len`（如 `glTexImage2D` 的像素大小由宽、高、格式、类型、对齐算出）在生成器
  里翻译成 JS 与 C 两份，由测试互相核对。
- **客户端标志与主机扩展**：连接开始时客体写一个标志字。随后客体通过 renderControl 询问主机支持的特性。
  API 25 的客体库认识的只有两类字符串（2026-10-27 核对）：
  - `ANDROID_EMU_CHECKSUM_HELPER_v1`：命令校验和；
  - `ANDROID_EMU_gles_max_version_2`、`_3_0`、`_3_1`、`_3_2`：GLES 的版本（镜像的 GLESDynamicVersion 特性）。

  v86 起步时一个都不宣告：没有校验和，客体只用 GLES 2.0。镜像的 `advancedFeatures.ini` 还列了 GLAsyncSwap
  （`rcFlushWindowColorBufferAsync`）、GLDMA（`rc*DMA`）与 GrallocSync，同样不打开；它们的开关方式 E0 核对。

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
- **等页面的调用**：只有要数据的 `glReadPixels` 与 `rcReadColorBuffer`。设备发出批次并等它的 `done` 与回读，
  期间客体的读取阻塞：Android 由 pipe 的唤醒机制完成，iOS 由环的轮询完成。
- **只要顺序的调用**：`glFinishRoundTrip`、`rcFlushWindowColorBuffer`、`rcClientWaitSyncKHR` 等。客体看不到
  GPU 的进度，后面的命令又在同一通道里排在它们之后，所以批次排进通道后 CPU 侧就回复。在途的批次超过上限
  （例如两帧）时，才等最老的那批完成，作为背压。

### 执行器（页面）

- 批次进入 GLES 执行器，它在 WebGPU 上执行，调用 gl-webgpu 的共用函数（“结论”第 4 条）。GLES 2.0 没有固定功能；
  GLES 1.1 的固定功能着色器由现有的 `gl_fixed_function.js` 生成。
- **GLES 有、WebGPU 没有的**，逐项给出做法：
  - `GL_TRIANGLE_FAN`、`GL_LINE_LOOP`：换成索引；
  - `GL_FIXED`（16.16 定点）顶点属性：GLES 1.1 常用，GLES 2.0 也允许；展开成浮点；
  - 点与线：`gl_PointSize`、GLES 1.1 的点精灵与 `OES_point_size_array` 展开成四边形；线宽大于 1 时近似；
  - GLES 1.1 的扩展：`OES_draw_texture`（`glDrawTex*OES`，2D 游戏常用）画成屏幕对齐的四边形；`OES_matrix_palette`；
  - 不完整的纹理：GLES 2.0 中非 2 的幂的纹理只在 `CLAMP_TO_EDGE` 且没有 mipmap 时可用，否则按规范采样为
    (0, 0, 0, 1)。dEQP 检查这一条；
  - `SAMPLE_ALPHA_TO_COVERAGE` 与 `glSampleCoverage`：只在多重采样时有效果。
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
GLES 插件在启用时向页面申请一个。`starter.js` 现在只为显示适配器插件建这条通道
（`graphics_adapter_renderer`），要推广到设备插件。没有渲染器（页面没有 WebGPU）时：
- Android 明确要求宿主模式（`gpu_mode: "host"`，见下一节的“启用”）就报错；VM 管理器在这种页面上用 `"guest"`，
  也就是 `qemu.gles=0`；
- iOS 没有主屏幕。

### Android 传输：goldfish pipe 的 `opengles`

- 客体打开 `pipe:opengles`，先写客户端标志，之后是命令流；从同一通道读回复。每个使用 GLES 的线程一条连接。
  它们按进程归组，属于同一进程的上下文共享对象。
- **进程归属**：`libOpenglSystemCommon` 先打开 `pipe:GLProcessPipe` 取得进程号，再在每条连接上用 `rcSetPuid`
  报告（2026-10-27 核对）。v86 的 gfxstream 已经为 virtio-gpu 的 pipe 资源回答它，逻辑共用。
- **读**：回复没准备好时返回“再试”，回复就绪时用 pipe 的唤醒寄存器叫醒客体。现有的服务已经有这套机制。
- **写**：命令可能跨多次写入；流按命令头组装完整命令再解码。
- **启用**：GPU 模式放在已有的 Android 设备模型（`src/android/devices.js`）与 VM 配置的 `android.gpu_mode` 上，
  不另设顶层选项（复核时改，初稿是 `gles: "host" | "software"`）：
  - `ranchu_25_armeabi_v7a` 有两个模式：`"guest"`（今天的做法：`qemu.gles=0`、低内存设备；默认）与
    `"host"`（本计划）。arm32 的预设现在写的 `"swiftshader"` 对 ranchu 没有意义，改成 `"guest"`，与 Android
    目录中的 `gpu: "guest"` 一致；
  - `"host"` 时：内核命令行改成 `qemu.gles=1`；补上镜像依赖的属性（`ro.opengles.version` 等，按 Android 模拟器
    给 API 25 镜像的做法，E0 核对）；去掉 `ro.config.low_ram`、打开开机动画（E3 测量后定）；插件申请渲染器
    通道；
  - 没有渲染器时启动失败并说明原因，不悄悄退回软件绘制。
- **吞吐**：pipe 版本 1 的每次读写都要走寄存器，开销大。镜像的 3.10 内核带 `goldfish_pipe_v2.c`，宿主报版本 2，
  它就走带命令缓冲的版本 2。E1 先用现有的版本 1；E5 测量后决定是否改报版本 2。

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
- **在核心中的位置**：截获放在 `src/rust/aarch64/a32.rs` 的未定义指令路径上。PL0、选项开启、编码与 `r0` 的
  高 16 位都匹配时，它调用 JS 的后门处理，不产生异常。页层把这两条编码当作步进，不编进原生代码。多核在
  vCPU worker 里时，后门调用像 MMIO 访问一样转给机器所在的线程。
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

复核时已经有答案的，见“复核结论”：renderControl 的命令清单、客体认识的主机特性字符串、进程归属的做法、内核的
pipe 版本 2。剩下的：

- 规格文件：确认 [gfxstream-protocol.md](gfxstream-protocol.md) 固定的提交里 GLES 与 renderControl 的规格齐全，
  生成器以它为唯一来源；
- `qemu.gles=1` 下镜像需要的属性（`ro.opengles.version` 等）与启动链（`qemu-props`、EGL 的加载规则）；
- gralloc.ranchu 对颜色缓冲的用法（格式、CPU 写入、FBPost）；GLAsyncSwap、GLDMA、GrallocSync 的开关方式；
- 页面执行器要共用 gl-webgpu 的哪些函数（“结论”第 4 条），以及 `v86-gles.js` 插件怎样打包它们：GLSL 前端要能在
  CPU Worker 里运行。

验收：清单与共用方案写进“复核结论”；E1–E6 按清单修正。**2026-10-27 完成**，见“E0 结论”。

### E1 生成器、传输与 renderControl（2026-10-27 完成）

- `tools/gles/gen.mjs` 生成协议表与 JS 编码器；
- goldfish pipe 的 `opengles`、`GLProcessPipe` 服务与流；
- renderControl 的全部命令；
- GLES 的调用此时只解码与计数，不渲染。有返回值或 `out` 参数的调用给出合法的默认回复：对象名递增、编译与链接
  成功、帧缓冲完整、`glGetError` 为 0、查询给规范的初始值。客体在等回复，不回就会挂住；E2 换成影子状态。

验收：`qemu.gles=1` 下 Android 7.1 的 `sys.boot_completed` 为 1；没有未知操作码；每种调用的次数统计写进复核
结论。此时屏幕没有内容，作为预期。

做法（2026-10-27）：
- **开关**：ranchu 的选项 `ranchu_gpu: "guest" | "host"`（插件路径 `ranchu_gpu_path`），只在 ranchu 上有效。设备模型
  `ranchu_25_armeabi_v7a` 的 `gpu_modes` 有 `guest` 与 `host`。`host` 给命令行 `qemu.gles=1`、启动属性
  `ro.opengles.version=131072`；低内存设置、关掉的开机动画与十分之一的时钟照旧，等 E3。Android 引导程序按
  `android.gpu_mode` 选模式；VM 配置现有的默认值 `"swiftshader"` 在 ranchu 上当作 `guest`，VM 配置的取值留给 E5。
  页面在引导程序之后才知道模式，所以插件在那时装载；CPU Worker 收到 `ranchu_gpu` 与插件的绝对路径。
- **插件**：`build/v86-gles.js`（种类 `gles`，注册表 `V86GlesHosts`，快照槽 `state[14]`）。没有这个插件的机器
  拒绝带它的快照。
- **goldfish pipe 的服务接口**改成 `write`、`read(max)`、`available`、`close`，回复按块排队，不再展开成数字数组
  （`rcReadColorBuffer` 这类大回复）；关闭通道、重开同号通道、机器复位时调用服务的 `close`。
- **renderControl**：72 个命令都有处理。配置 12 个：RGBA8888、RGBX8888、RGB565，各配无深度、16 位深度、24 位深度、
  24 位深度加 8 位模板，没有多重采样；`EGL_NATIVE_VISUAL_ID` 是 HAL 像素格式（SurfaceFlinger 按它挑）。
  `eglChooseConfig` 按 EGL 1.4 的匹配与排序规则在宿主上算。同步对象立即发信号；对象按进程（puid）归属，
  `GLProcessPipe` 关闭时释放。GL 扩展只列 E3、E4 要实现的；不宣告任何 `ANDROID_EMU_*` 特性。
- **默认回答**（`gles_defaults.js`）只跟踪查询要用的：开关、绑定、视口、缓冲与渲染缓冲的大小、附着、着色器源码。
- **快照**：E1 不保存连接，恢复后 pipe 的通道是关闭的，客体的 GL 进程会因读写失败退出（E5 处理）。

### E2 影子状态与批次（2026-10-28 完成）

- 影子状态与错误语义；CPU 侧的 GLSL ES 前端（语法、语义、链接）；
- 批次写入器；
- `ranchu` 的渲染器通道；
- 把一次启动的全部批次录成文件，供 E3 离线重放。

验收：单元测试；启动过程中没有任何查询等待页面；录下的批次能在 Node 中解析。

做法（2026-10-28）：
- **影子状态**（`src/gles/gles_shadow.js`）按 GLES 2.0 规范写：错误码（第一个保留到 `glGetError`）、全部可查询状态与
  `glGet` 的类型转换（颜色与深度按规范线性映射到整数）、对象名（`glGen` 只保留名字，绑定才成为对象；删除时解除当前
  上下文的绑定与附着）、纹理的图像与参数（外部纹理的默认值与限制）、缓冲、渲染缓冲、帧缓冲的完整性（深度与模板
  分开附着报 UNSUPPORTED：WebGPU 只有一个深度模板纹理）、着色器与程序（删除推迟到不再使用）、uniform 的检查与值、
  顶点属性。帧缓冲与 VAO 属于上下文（ES 3.0 的规则），其余属于共享组。GLES 1.1 的上下文共用对象部分，固定功能的
  状态在 E4 之前答初值。`call()` 返回答案和“是否交给页面”：被规则拒绝的调用与查询都不进批次。页面上的执行器（E3）
  对收到的命令运行同一个状态机，名字、绑定与 location 两边一致；`glCreateShader`/`glCreateProgram` 的名字随命令走。
- **GLSL ES**（`src/gles/glsl_es.js`）：gl-webgpu 的 `gl_shader_translator.js` 加 ES 模式（`es: true`）：
  `#version 100`、`GL_ES`、ES 的内建常量与输出（一个绘制缓冲、没有 `gl_FragDepth`、没有兼容的内建状态与属性，
  `gl_DepthRange` 除外）、`samplerExternalOES`（当作 2D 采样器，反射里标出 external）、属性位置从 0 往上分配。
  顺带修了一个共用的错误：`uniform sampler2D tex[2]` 被当成“混了采样器的结构”拒绝。XP 的 glbridge 测试不变。
  链接的反射换算成 GL 的视图：活动 attribute/uniform 的 GL 名字（数组带 `[0]`）、大小、类型枚举，以及
  `glGetUniformLocation` 认的全部名字。ES 的更严格规则（没有隐式转换、默认精度）留给 E4 的 dEQP。
- **批次**：GLES 记录放在 `renderer_protocol.js`（魔数 `GE10`，用 GX 的写入器）：命令原样带客体编码的字节（数据随命令走）
  与 CPU 侧的答案；renderControl 的对象用自己的记录（颜色缓冲、表面、上下文、图像的建立与消失，帧的冲刷与投递，
  读回），不带客体的引用计数。冲刷点：`rcFlushWindowColorBuffer`、`rcFBPost`、`glFinishRoundTrip`/`glFinish`/`glFlush`、
  同步等待、读回、超过 4 MiB。在途批次超过 2 个时，帧与 `glFinishRoundTrip` 的回复等最老的一个（背压）。
  `src/gles/gles_batch.js` 读回记录（页面与 Node 共用）。
- **通道**：`starter.js` 在 `ranchu_gpu: "host"`（或 Android 设备模型的 `gpu_mode: "host"`）时也建页面的渲染器；没有
  渲染器就启动失败并说明原因。`svga_renderer.js` 增加 stream `"gles"`（执行器在 E3）。Android 的 `gpu_mode` 按设备模型
  检查（ranchu：guest、host，以及 VM 配置的默认值 swiftshader）。
- **插件**改用 esbuild 构建（它要打包 CommonJS 的 GLSL 前端）：`build/v86-gles.js` 约 255 KB。
- **录制**：`tests/gles/lib.mjs` 的 `recording_renderer` 把批次写进文件，`tools/gles/batches.mjs` 读回并按种类统计，
  `--shaders` 导出着色器语料。

### E3 执行器与 Android 主屏幕

- 共用 gl-webgpu 的函数（E0 的方案；`gl_executor.js` 若要拆分，单独提交，XP 的 OpenGL 回归不变）；
- GLES 2.0 执行器、GLSL ES 到 WGSL、FBO 与渲染缓冲、纹理格式与 ETC1、颜色缓冲、`rcFBPost` 的呈现；
- `"host"` 模式的设备设置：去掉 `ro.config.low_ram`、打开开机动画，各测一次启动时间与 system_server 是否稳定，
  再定。机器时钟的放慢（十分之一）先保留，等 E5 的性能数据。

验收：
- Android 7.1 用主机 GPU 合成，进入主屏幕；启动动画、桌面、设置、滚动列表正常；
- 截图与 `"guest"` 模式（`qemu.gles=0`）的软件绘制结果做结构相似度比较（字体与抗锯齿允许差异）；
- E2 录下的批次在浏览器测试中重放，像素与参考一致。

做法（2026-10-28）：
- **执行器**（`src/gles/page/gles_executor.js`，打进 `libv86-webgpu.js`）对收到的命令跑同一个影子状态机，再做 GPU 的
  部分：纹理（整条 mip 链，第 0 级换尺寸时重建并拷回已有级别）、缓冲（字节留在页面）、渲染缓冲、FBO、绘制（顶点在
  CPU 上组装成 f32，索引成 u32，扇形与线环展开）、着色器（链接时的 WGSL，按入口可达的绑定建布局，同
  `gl_executor.js` 的 `collectReachableWgslBindings`）、清除（带遮罩与剪裁时画一个四边形）、混合、深度与模板。
  采样正被渲染的纹理（反馈回路）时换成占位纹理。GPU 对象的销毁推迟到批次提交之后。
- **方向**：GL 的绘制保留翻译器的翻转（行 0 是 GL 的底行）；颜色缓冲按 Android 的内存顺序（行 0 在上）。窗口表面画进
  自己的纹理，`rcFlushWindowColorBuffer` 时翻转拷进颜色缓冲（同 gfxstream 的 pbuffer）。`rcBindTexture` 的纹理、EGL
  图像的纹理直接采样或写入颜色缓冲本身，所以图集上传（`glTexSubImage2D`）落在颜色缓冲里。
- **呈现**：有合成器层时 `rcFBPost` 把颜色缓冲拷进层；否则读回（同时只读一帧，最新的赢）交给 CPU 侧，ranchu 的帧缓冲
  设备显示它。
- **重放**：`tests/glbridge/gles_replay_browser_test.html?batches=<录制>` 在浏览器里重放一次启动的批次并存下每帧。
- **真 GPU 的启动**：`A32_ANDROID_RENDERER=chrome` 让 `android_boot.mjs` 的渲染器通道连到无头 Chrome 的 WebGPU
  （`tests/gles/chrome_renderer.mjs`），截图就是 SurfaceFlinger 的帧。

### E4 GLES 1.1 与兼容性

- GLESv1 解码与固定功能；
- EGL 同步、交换间隔、多进程、多上下文与共享；
- 外部纹理（YUV）；
- 主机扩展按需补充。

验收：
- **dEQP**：用 Android CTS 7.1 的 32 位 ARM 包中的 `CtsDeqpTestCases`（下载 CTS 包前征得所有者同意），测试方法
  照 Android 16 的 dEQP 工具：
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

做法（2026-10-28）：
- **GLES 1.1**：固定功能的状态在影子里（`src/gles/gles1_state.js`：矩阵栈、光照与材质、纹理环境与 combine、雾、点、
  裁剪平面、客户端数组、`draw_texture` 的裁剪矩形，以及它们的查询与错误）。页面（`src/gles/page/gles1_draw.js`）把它
  换成 gl-webgpu 固定功能生成器的签名与状态块（XP 路径的 `gl_fixed_function.js` 与 `gl_state_layout.js`，原样共用），
  顶点来自客户端数组或当前值；`glDrawTex*OES` 画屏幕对齐的矩形。GLES 1.1 的扩展串去掉了没实现的 `GL_OES_texture_cube_map`。
- **自建 APK**（`tests/a32/android/v86gles.c`，`A32_ANDROID_GLES_APP=1`）：NativeActivity 在一个窗口表面上先后用
  GLES 2.0 与 1.1 的上下文画清除、三角与扇形、FBO、ETC1、固定功能的颜色与纹理、光照、`draw_texture`，每个场景用
  `glReadPixels` 读几个点写进日志，测试按 GL 的规则核对。
- **dEQP**（`A32_ANDROID_DEQP=1`）：`tools/a32_cts.mjs` 按字节范围只取 CTS 7.1_r29 里 dEQP 的 APK 与用例表；子集是全部
  `state_query` 与 `negative_api`、`dEQP-EGL.info`，以及其余 functional 每九个取一个，放在第四块 virtio 盘（ext2）上，
  `su` 拷进 `/data/local/tmp` 后安装，由它的 instrumentation 分批运行，结果写进 `deqp.json`。

### E5 性能、快照与界面

- **性能**：批次大小、在途批次的上限、影子状态覆盖率、上传路径、pipe 版本 2（镜像的内核已经支持）；
  合成器层呈现，不回读；测量启动时间与界面帧率；机器时钟的放慢还需不需要。
- **快照**：
  - CPU 侧保存影子状态与 pipe 连接；
  - `prepare_save` 把纹理、缓冲、渲染缓冲与颜色缓冲的内容读回并存入快照；
  - 恢复时在新的渲染器上重建；
  - 不用图形日志重放：XP 上恢复时长达 70 秒的黑屏就是它造成的。
- **界面**：VM 管理器中 Android 7.1 的设置项“GPU”，选项为“主机（WebGPU）”（`gpu_mode: "host"`）和
  “客体（CPU 绘制）”（`"guest"`）。页面有 WebGPU 时默认用主机。`make app-tests` 增加用例。
- **文档**：[arm32.md](arm32.md) 与 [gpu-devices.md](gpu-devices.md) 增加 GLES 一节，偏差记入
  [gpu-deviations.md](gpu-deviations.md)。

验收：快照往返后画面与状态一致；性能报告写进文档。

做法（2026-10-28）：
- **快照**（`src/gles/gles_snapshot.js`）：影子状态与 renderControl 的对象按 JSON 加类型化数组打包（Map、Set、共享的
  对象、类的原型、`undefined` 与 JSON 没有的数都保留），编译过的着色器与链接过的程序不存，存它们编译和链接时的源码，
  恢复时重新编译链接（答案相同）。`prepare_save`（机器已停）先答完所有等页面的调用（批次跑完、读回到达、流里排着的命令
  解完），再向页面要状态（`gles_save`）：执行器把颜色缓冲、窗口表面、纹理各级与颜色渲染缓冲读回，连同自己的影子状态
  打包。goldfish pipe 的通道带着服务的状态进快照（流里没凑齐的命令、没读走的回复；qemud 服务的缓冲），旧格式的快照照旧
  关闭通道。恢复时通道先回来，GLES 主机的槽在后，页面先 reset 再 `gles_restore`。深度与模板内容不存（WebGPU 拷不出
  `depth24plus`），恢复后读作已清除。快照时仍有调用在等页面（没经过 `prepare_save` 的保存）的连接恢复后断开。
- **界面**：VM 配置的 `android.gpu_mode` 对模拟器镜像取 `"host"`、`"guest"`（旧配置的 `"swiftshader"` 等于 `"guest"`），
  Cuttlefish 仍是 SwiftShader、Venus、gfxstream；两类设备之间切换时按设备改回合法值并提示。Android 7.1 的预设用
  `"host"`；启动时页面没有 WebGPU 就这一次用 `"guest"` 并在状态栏说明（从快照恢复则报错：快照是主机模式的）。
  设置面板、摘要与说明随之更新。
- **测量**：GLES 主机记下自己在机器线程上的时间（`stats.cpu_ms`）与着色器编译时间（`shaders.compile_ms`）；
  `A32_ANDROID_SCREEN` 打开一个界面截图并上下滑动一分钟，按宿主的秒数报帧率。

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

这几个数是在 Venus 模式下测的（aarch64.md 的 “Known defects”）。现在默认的官方 gfxstream 模式还没有同样的
帧时间数据，E7 的决定要在这个模式下重测。

E7 改用 gfxstream 的 GLES 能力集（capset 8，Cuttlefish 的 `egl=emulation`），GLES 调用直接交给本计划的宿主：
- ANGLE 的状态校验、着色器编译（glslang 到 SPIR-V）与 Vulkan 编码不再在模拟的 CPU 上运行；
- 着色器改在宿主上用 JS 原生速度翻译。

**代价比“同一组解码器”大得多。** Android 16 要求 GLES 3.0 以上，而 E0–E6 的执行器只到 GLES 2.0。E7 要把执行器与
GLSL ES 前端扩到 3.0（uniform 缓冲、多渲染目标、实例化、变换反馈、3D 与整数纹理、采样器对象、GLSL ES 3.00），
规模接近 WebGL 2。这还会给 Android 16 留下两条要维护和测试的 GLES 路径。

**做不做由测量决定，不在 E0–E6 之内。** E5 之后在 Android 16 的 gfxstream 模式下采样一次 Launcher3 的帧，统计
客体时间落在 ANGLE、Vulkan 驱动（`libGLESv2_angle.so`、`vulkan.ranchu`）与着色器编译上的比例。采样用客体的
`simpleperf record -e cpu-clock`：软件事件，不需要模拟 PMU，按共享库归类。
- 占到帧时间的三成以上（尤其是冷画面里的编译），就做 E7；
- 否则不做，把精力放在客体 CPU 的性能上。

另外，API 25 的编码器已经带 GLES 3 的命令（“复核结论”）。GLES 3.0 的执行器一旦做出来，宿主宣告
`ANDROID_EMU_gles_max_version_3_0` 后 Android 7.1 的应用也能用上，评估收益时两边一起算。

2026-10-28：GLES 3.0–3.2 的执行器另立计划，见 [gles3-plan.md](gles3-plan.md)。

## 测试

| 层 | 位置 | 运行方式 |
| --- | --- | --- |
| 生成器：JS 与 C 两份长度表达式一致；JS 编码器与解码器往返 | `tests/gles/protocol.mjs` | `make gles-tests` |
| 流：拆分的写入、拼接、回复顺序、未知操作码的处理 | `tests/gles/stream.mjs` | `make gles-tests` |
| 影子状态：查询、错误语义、名字空间与共享组，对照 GLES 规范的用例 | `tests/gles/shadow.mjs` | `make gles-tests` |
| renderControl：配置、上下文、表面、颜色缓冲、FBPost、同步 | `tests/gles/render_control.mjs` | `make gles-tests` |
| goldfish pipe 的 `opengles` 与 `GLProcessPipe` 服务：标志、进程号、阻塞读与唤醒、快照 | `tests/a32/ranchu_devices.mjs`（扩展） | `make a32-system-tests` |
| GLSL ES 前端与 WGSL：着色器语料（E1 起从 Android 的启动中收集）经 naga 校验 | `tests/glbridge/glsl_es_wgsl_test.js` | `make test-glbridge` |
| 执行器：录下的批次重放，比较像素 | `tests/glbridge/gles_*_browser_test.html` | `make display-browser-tests` |
| XP 的 OpenGL 回归（不变） | 现有的 gl-webgpu 测试与 Cube 2 语料 | `make test-glbridge` |
| Android 7.1 客体 | `tests/a32/android_boot.mjs` 加 `A32_ANDROID_GPU=host` | 手动 |
| dEQP-GLES2 子集（CTS 7.1 的 32 位 ARM 包） | `tests/a32/android_deqp.mjs`：`tests/a64/android_deqp.mjs` 的 32 位版本，CTS 由 `tools/a64_cts.mjs` 的同一流程取得 | 手动 |
| 自建 GLES 测试 APK 的像素 | `tests/a32/android_gles.mjs` | 手动 |
| 后门与 Linux 测试程序 | `tests/a32/gles_backdoor.mjs` | `make a32-tests` |

CI 只跑 eslint、构建与 `make ci-tests`：`make gles-tests` 加进 `ci-tests`，`test-glbridge` 已经在里面。
`a32-system-tests`、浏览器与客体测试手动运行。

## 风险

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| API 25 编码器与新版规格的差异 | 解码错位 | 以 gfxstream 固定的规格为准（操作码只增不改），差异由 E1 的往返测试与客体启动发现 |
| 等页面的调用多 | 客体卡顿 | 影子状态覆盖查询；只要顺序的调用不等页面；E1 统计这类调用的次数 |
| pipe 版本 1 的吞吐 | 帧率低 | E5 测量；版本 2；合并小写入 |
| GLSL ES 的翻译 | 个别着色器错误 | 语料与 naga；dEQP 子集 |
| 改动 `gl_executor.js` 影响 XP 路径 | OpenGL 游戏回归 | 原则上不拆（“结论”第 4 条）；要拆时单独提交，现有测试与 Cube 2 语料全部通过才合并 |
| E1 对有返回值的调用不回复 | 客体线程挂住，开不了机 | E1 给默认回复；未知操作码计数并报告 |
| GLSL 前端要在 CPU 侧运行 | 包变大、加载变慢 | 放进 `v86-gles.js` 插件，只在启用 GLES 时加载 |
| 打开 GL 后去掉低内存设置 | system_server 不稳定、内存不够 | E3 分别测量再定；不行就保留低内存设置，只让 SurfaceFlinger 与应用用 GL |
| 颜色缓冲的格式与 YUV | 视频与相机画面错误 | E4 处理外部纹理；先保证界面 |
| 页面没有 WebGPU | 无法加速 | 退回软件绘制，与现在相同 |
| iOS 后门与 XNU 的交互 | iOS 上不可用 | E6 在 Linux 上先验证；iOS 只多一层适配 |

## 复核结论（2026-10-27）

对照 `armeabi-v7a-25_r18`（Android 7.1.1）的镜像与内核、v86 的代码核对。结果已经写进上文，这里汇总：

- **客体库**：`system.img` 的 `lib/egl/` 有 `libEGL_emulation.so`、`libGLESv1_CM_emulation.so`、
  `libGLESv2_emulation.so`，以及软件绘制的 `libGLES_android.so`；`lib/` 有三个编码器、`libOpenglSystemCommon.so`
  与 `libGLESv3.so`；`lib/hw/` 有 `gralloc.ranchu.so` 与 `gralloc.goldfish.so`。
- **renderControl 的 37 个命令**（编码器的符号）：`rcGetRendererVersion`、`rcGetEGLVersion`、`rcQueryEGLString`、
  `rcGetGLString`、`rcGetNumConfigs`、`rcGetConfigs`、`rcChooseConfig`、`rcGetFBParam`、`rcCreateContext`、
  `rcDestroyContext`、`rcCreateWindowSurface`、`rcDestroyWindowSurface`、`rcCreateColorBuffer`、`rcOpenColorBuffer`、
  `rcOpenColorBuffer2`、`rcCloseColorBuffer`、`rcSetWindowColorBuffer`、`rcFlushWindowColorBuffer`、
  `rcFlushWindowColorBufferAsync`、`rcMakeCurrent`、`rcFBPost`、`rcFBSetSwapInterval`、`rcBindTexture`、
  `rcBindRenderbuffer`、`rcColorBufferCacheFlush`、`rcReadColorBuffer`、`rcUpdateColorBuffer`、
  `rcUpdateColorBufferDMA`、`rcCreateColorBufferDMA`、`rcCreateClientImage`、`rcDestroyClientImage`、
  `rcSelectChecksumHelper`、`rcCreateSyncKHR`、`rcClientWaitSyncKHR`、`rcWaitSyncKHR`、`rcDestroySyncKHR`、`rcSetPuid`。
- **主机特性**：客体认识的字符串见“协议与生成器”。`advancedFeatures.ini` 列了 GrallocSync、LogcatPipe、
  GLAsyncSwap、GLESDynamicVersion、GLDMA、Wifi 等；内核没有 `CONFIG_GOLDFISH_SYNC`，GrallocSync 用不上。
- **编码器**：有 emugl 自己的客户端数组命令、`glShaderString` 与 `glFinishRoundTrip`；GLES 3 的入口与 `*AEMU`
  命令也都在，是 2017 年的构建。
- **进程**：`libOpenglSystemCommon` 打开 `pipe:GLProcessPipe`，再用 `rcSetPuid` 报告。
- **内核**：Linux 3.10.0+（2017 年 5 月构建），有 `CONFIG_GOLDFISH_PIPE` 与 `goldfish_pipe_v2.c`，`CONFIG_ARM_LPAE`。
- **v86**：pipe 报版本 1，服务只有 qemud 的三个；gfxstream 的 rc 命令不解码（[gpu-deviations.md](gpu-deviations.md)
  的 “Not done”），进程管道已能回答；渲染器通道只建给显示适配器插件；`gl_executor.js` 在送来查询的端口写入中
  同步回答。
- **对初稿的修正**：
  - G-59 在 gpu-deviations.md；
  - 规格只用 gfxstream 固定的一份；
  - 不拆 XP 的执行器，CPU 侧打成插件；
  - `glFinish` 与同步对象只要顺序，加背压；
  - 开关改用 `android.gpu_mode`；
  - goldfish pipe 的测试放在 `tests/a32/ranchu_devices.mjs`；
  - CI 只跑 `make ci-tests`；
  - E1 要给默认回复；
  - E7 的数据要在 gfxstream 模式下重测。

### E0 结论（2026-10-27）

对照 gfxstream 固定的提交 `7e9d595b`（[gfxstream-protocol.md](gfxstream-protocol.md)）与 `armeabi-v7a-25_r18` 的镜像：

- **规格文件**：唯一来源是宿主的 `codegen/gles1`、`codegen/gles2`、`codegen/renderControl`（各自的 `.in`、
  `.attrib`、`.types`）。
  - 同一提交的 `guest/renderControl_enc/renderControl.in` 是另一套：有 `*Puid` 的变体，缺命令，顺序也不同，
    不能用；
  - renderControl 有 72 个命令，操作码 10000–10071。第一行在上游写作 `GL_ENRTY`，emugen 照样接受，生成器也要
    接受；
  - 操作码按 `.in` 中的顺序从 `.attrib` 的 `base_opcode` 起编号。
- **线格式**（emugen 的 README 与 `api_gen.cpp`）：
  - 命令头是操作码与总长（各 u32）；
  - 值参数按 `.types` 的位宽排列（`GLboolean`、`GLubyte` 1 字节，`GLshort` 2 字节，`GLsync`、`uint64_t` 8 字节，
    其余 4 字节）；
  - 指针参数：`in` 与 `inout` 是 u32 长度加数据，`out` 只有长度；`DMA` 指针是 8 字节的客体物理地址，只在宿主
    宣告 GLDMA 时出现；`isLarge` 只改变编码器的写法，字节顺序不变；
  - 回复依次是各 `out`、`inout` 参数的数据，最后是返回值；宿主不宣告校验和时没有校验和字节。
- **连接**：开始是一个 u32 的标志字，宿主读了就丢（`host/RenderThread.cpp`）；之后每个命令按操作码区间交给
  对应的解码器。
- **`qemu.gles=1` 的启动链**：
  - 内核命令行的 `qemu.gles=1` 由 init 变成 `ro.kernel.qemu.gles=1`；
  - `libEGL.so` 的加载器读 `ro.kernel.qemu` 与 `ro.kernel.qemu.gles`，设 `qemu.gles=1`，装载
    `/system/lib/egl/lib{EGL,GLESv1_CM,GLESv2}_emulation.so`；
  - `gralloc.ranchu.so` 也读 `ro.kernel.qemu.gles`；
  - qemud 的启动属性要加上 `ro.opengles.version=131072`（GLES 2.0，模拟器给 API 25 镜像的值），
    `qemu.sf.lcd_density` 已经有了；`init.ranchu-core.sh` 只管开机动画与 RIL。
- **主机特性**：2017 年的客体库只认识 `ANDROID_EMU_CHECKSUM_HELPER_v1` 与 `ANDROID_EMU_gles_max_version_*`，
  它们出现在宿主回答 `rcGetGLString(GL_EXTENSIONS)` 的字符串里。客体库里没有 GLAsyncSwap、GLDMA、GrallocSync
  的开关，这三项不存在，不用处理。客体库有 `goldfish_dma` 与 `/dev/goldfish_sync` 的代码，内核没有这两个设备。
- **开关**：库一级的选项是 ranchu 自己的 `ranchu_gpu: "guest" | "host"`，与已有的 `ranchu_display`、
  `ranchu_properties` 同类。VM 配置的 `android.gpu_mode` 与设备模型的 `gpu_modes` 映射到它，上层不另设开关。
- **共用与打包**：
  - 页面上可共用的有 `gl_constants.js`、`gl_shader_translator.js`（预处理、词法、语法、语义与 WGSL 生成）、
    `gl_state_layout.js`、`gl_fixed_function.js`。它们是不依赖页面的 UMD 脚本，CPU Worker 里也能运行；
  - CPU 侧的 GLES 宿主是设备插件 `build/v86-gles.js`（插件种类 `gles`，入口 `src/gles/plugin.js`），只在
    `ranchu_gpu: "host"` 时由页面装载，交给机器；它把 `opengles` 与 `GLProcessPipe` 两个服务交给 goldfish pipe。

### E1 结论（2026-10-27）

`A32_ANDROID_GPU=host node tests/a32/android_boot.mjs`（2 个协作核心，页层，时钟十分之一）：
- `qemu.gles=1` 下 `sys.boot_completed` 在 268 秒为 1（同一测试的 `"guest"` 模式 2026-10-25 约 417 秒；E1 什么也
  不画，两者还不可比）；之后解锁、按 HOME，焦点是启动器（`NexusLauncherActivity`）。
- 15 条连接、6 个进程（GLProcessPipe），35201 次调用、75 种；**没有未知操作码，没有解码不了的命令，没有断掉的流**。
  API 25 的编码器与 gfxstream 固定的规格一致。
- renderControl（次数）：rcBindTexture 721、rcSetWindowColorBuffer 345、rcFlushWindowColorBuffer 335、rcFBPost 262、
  rcGetGLString 67、rcCreateColorBuffer 30、rcOpenColorBuffer2 25、rcCloseColorBuffer 24、rcColorBufferCacheFlush 24、
  rcUpdateColorBuffer 24（共 8.6 MB）、rcReadColorBuffer 23、rcQueryEGLString 20、rcSetPuid 15、rcMakeCurrent 14、
  rcCreateWindowSurface 10、rcChooseConfig 8、rcGetFBParam 7，其余配置与版本查询各 5，rcDestroyWindowSurface 4。
  没有 rcCreateClientImage 与同步对象。
- GLES（按名字合计，前 20）：glBindTexture 6981、glUniformMatrix4fv 3487、glEnableVertexAttribArray 3231、glTexParameteri 2590、
  glVertexAttribPointerData 2396、glGetError 1829、glDrawArrays 1405、glDisable 1370、glUseProgram 1201、
  glDisableVertexAttribArray 1049、glUniform1i 910、glUniform1f 907、glUniform4fv 907、glEnable 713、glBindBuffer 614、
  glViewport 608、glBlendFunc 562、glUniform4f 397、glVertexAttribPointerOffset 362、glFinishRoundTrip 345。
  着色器 64 个、程序 32 个，glTexImage2D 25、glTexSubImage2D 3，FBO 9 个。
- **等页面的调用**：rcReadColorBuffer 23 次（gralloc 锁定 GPU 缓冲给 CPU 读：低内存设置下 CPU 画的系统窗口，
  锁定时读回、解锁时 rcUpdateColorBuffer 上传），glReadPixels 0 次。**只要顺序的**：glFinishRoundTrip 345、
  rcFlushWindowColorBuffer 335。**影子状态要答的**：glGetError 1829（占有回复调用的大半），glGetUniformLocation 170、
  glGetProgramiv 128、glGetShaderiv 64、glGetIntegerv 18、glCheckFramebufferStatus 9。E2 的影子状态覆盖这些，
  启动中就只剩 23 次读回要等页面。

### E2 结论（2026-10-28）

`A32_ANDROID_GPU=host node tests/a32/android_boot.mjs`（录制批次，没有执行器）：
- `sys.boot_completed` 在 257 秒为 1，之后启动器得到焦点；33870 次调用，没有未知操作码与解不了的命令；
- 722 个批次、9.2 MB、30439 条记录，`tools/gles/batches.mjs` 全部读回并解码；
- CPU 侧编译 64 个着色器、链接 32 个程序，全部成功；
- 等页面的只有 20 次 `rcReadColorBuffer`（读回，不是查询），没有任何查询等待页面；
- 影子状态拒绝的调用：0（计数里曾把 `glGen*` 当成拒绝，已改）。

### E3 结论（2026-10-28）

`A32_ANDROID_GPU=host A32_ANDROID_RENDERER=chrome node tests/a32/android_boot.mjs`（无头 Chrome 的 WebGPU 画）：
- `sys.boot_completed` 在 247–333 秒（机器上同时跑几个模拟器时偏慢）；同一时期客体模式是 449 秒（单独跑）到 705 秒；
- 主屏幕由主机 GPU 合成：状态栏、启动器、图标与文字、导航栏、通知栏与快速设置都对；E2 录下的一次启动在浏览器里重放，
  与实时画面逐像素相同；
- **壁纸**：8 次主机模式的启动里只有 1 次画出了默认壁纸（颜色、位置都对），其余是黑的。黑的那几次 SurfaceFlinger 的
  `ImageWallpaper` 层可见、不透明、没有被盖住，但从没收到过缓冲（1×1，`activeBuffer` 空）；壁纸引擎重建后没再画
  （`mBackgroundWidth=-1`），WindowManager 却记为已画（`HAS_DRAWN`）。壁纸的像素到过主机（一次完整的
  `rcUpdateColorBuffer`）。看起来是 Android 壁纸服务在启动时的竞争，不是 GLES 的绘制路径；客体模式只跑成一次，
  不能说它那边不会发生。记为已知缺陷。壁纸层的位置有约 0.9 像素的偏移（最左一列黑），真 GPU 按像素中心光栅化也如此。
- **与客体模式比较**（`A32_ANDROID_SCREEN="-a android.settings.SETTINGS"`，同一个设置界面，列表都还没载入）：状态栏
  以下的结构相似度 0.9997（应用栏 0.9997，导航栏 0.9998；状态栏只差时钟）。颜色上客体模式偏紫：它经过 16 位的帧缓冲，
  Material 的灰 224 量化成 RGB565 再展开正好是 231、227、231；主机模式是准确的 8 位颜色。
- **设备设置**：去掉 `ro.config.low_ram` 并打开开机动画（`A32_ANDROID_PROPS="ro.config.low_ram=" A32_ANDROID_BOOTANIM=1`）
  启动 281 秒，没有进程崩溃，空闲内存 643 MB。系统界面改走 hwui 的 GL 后，滑动设置与通知栏的帧率反而从 5.6 降到 3.6
  帧每秒（同样的画面，这个 CPU 上软件绘制加上传比 GL 路径便宜）。所以保留低内存设置，开机动画也不默认打开；机器
  时钟的放慢照旧。

### E4 结论（2026-10-28）

- **自建 APK**：`A32_ANDROID_GLES_APP=1` 的七个场景（GLES 2.0 的清除、绘制、FBO、ETC1，GLES 1.1 的固定功能、光照、
  `draw_texture`）在主机 GPU 上与 GL 的规则一致。`draw_texture` 起初差在测试本身：纹理的放大过滤默认是 LINEAR，加
  REPEAT 在裁剪矩形边上混进了红色，真 GPU 也如此；测试改用 NEAREST。
- **dEQP**（`A32_ANDROID_DEQP=1`，CTS 7.1_r29 的子集：全部 `state_query` 与 `negative_api`、`dEQP-EGL.info`，其余
  functional 每九个取一个；ios6 的 adad9d79 加上 GLES 3.x 会话的 L1/L2）：2033 个支持的用例通过 1890 个（93.0%），
  没有崩溃或挂起；第一次完整运行是 88.9%。
  - `state_query` 372/372、`negative_api` 183/183：影子状态达到 99% 的目标；
  - 修掉的：立方体贴图先给 -X 面时丢面（约 20 个）、完整性按格式判断、`glCopyTexSubImage2D` 的级别检查、正反面不同的
    模板参考值与掩码（WebGPU 只有一组：分两次画，15 个）、前端异常不再打断机器；
  - 剩下 143 个失败里约 117 个在 GLSL 前端（`shaders.random` 84、`uniform_api` 里结构中的采样器 11、`preprocessor` 等
    ES 严格性 18、`invariance` 2），归 GLES 3.x 计划的 L3（ES 1.00 改走 glslang）；
  - 执行器约 26 个：混合同时用常量颜色与常量 alpha 5 个（G-70）、宽点 1 个（G-64），其余是随机片段操作与交互、
    纹理随机规格、带剪裁的清除、深度范围比较、RGB 加 16 位深度的 FBO 清除，图像比较失败，还没定位（需要 dEQP 的日志
    图像）。
  - 结果在 `build/a32-android/runs/v86-gles-deqp3/`（`deqp.json`、`deqp-details.json`）。
  - **改走 glslang 之后**（GLES 3.x 会话的 L3/L4：GLES 2 上下文也由 `gles3_executor.js` 与 glslang 编译，同一个子集）：
    2034 个支持的用例通过 1980 个（**97.3%**），97% 的总目标达到；`state_query` 372/372、`negative_api` 183/183、
    `dEQP-EGL.info` 5/5。修好 127 个（`shaders.random` 84、`preprocessor` 10、`uniform_api` 11 等），回退 38 个，
    都在新执行器里，已交给 GLES 3.x 会话：用 `CONSTANT_ALPHA` 的混合 22 个（没照 G-70 把常量的 alpha 放进四个
    通道；随机片段操作与交互的 5 个多半也是）、着色器用到而没有启用数组的属性 8 个左右（WebGPU 报顶点状态缺槽，管线无效）、嵌套结构数组的 uniform、
    一个内建函数重载的链接、`depth_range.write` 2 个、`draw_elements.triangles.single_attribute`。两条路径都失败的
    18 个：常量颜色加常量 alpha 混合 4 个（G-70）、随机片段操作与交互 9 个、RGB 加 16 位深度的 FBO 清除、深度范围
    比较各 1 个、FBO 完整性的 QualityWarning 3 个（规范允许）。结果在 `build/a32-android/runs/v86-gles-deqp4/`。
  - GLES 3.x 会话修了回退（3337e95d 等）之后，38 个回退用例带图像重跑（`A32_ANDROID_DEQP_FILTER` 与
    `A32_ANDROID_DEQP_IMAGES=1`，`runs/v86-gles-deqp6/`）：36 个通过。剩下两个已交给那个会话：
    `max_vertex_texture_image_units_vertex`（着色器里的常量不等于查询到的 16，glslang 的资源上限多半还是它的默认值）、
    `draw_elements.triangles.single_attribute`（三次迭代都整张黑，参考是一个白三角形）。那个会话随后修好了这两个：
    glslang 的资源上限从没设置过（着色器里的 `gl_Max*` 都是 glslang 的默认值，现在按 glGet 的回答设），6 字节的
    索引缓冲上传时补不齐整字被拒（现在补零）。
  - **最终**（ios6 的 f48fdcc7，整个子集重跑，`runs/v86-gles-deqp7/`）：2039 个支持的用例通过 2013 个（**98.7%**），
    `state_query`、`negative_api`、`dEQP-EGL.info` 仍然全过。比上一次完整运行修好 44 个，新失败 11 个：其中 2 个是
    G-70（常量的 alpha 放进四个通道之后，混用常量颜色的组合反过来失败），另外 9 个是新代码的回退，已交给 GLES 3.x
    会话（`shaders.random.all_features` 5 个编译失败、NPOT 加 REPEAT 的纹理完整性 2 个、FBO 附件查询、一个
    `glCreateProgram` 报 `GL_INVALID_OPERATION`）。那个会话查明这次的 dEQP-GLES2 其实跑在 3.x 上下文上：客体的 EGL 按
    主机宣布的最高版本建 GLES 2.0 上下文，3.0 成为默认之后，ES2 的用例都走 3.x 的影子与执行器；FBO 的两个是 3.x 拒绝
    没有 glGen 过的名字（GLES 仍然允许绑定时创建），NPOT 的两个是 3.x 上下文的扩展串里少了 ES2 的扩展，都在 fb1075c2
    修好；随机着色器 5 个是 ES 1.00 改写内建函数重载时，把全局初始值里的 `log2(...)` 当成了用户的重载（aeaa68f6）。
    这 9 个加上子集里全部 `fbo.*` 与 `texture.completeness.*`（59 个，`runs/v86-gles-deqp8/`，ios6 240a84e1）重跑：
    9 个都过，其余不变。并进整套的结果，子集是 **2022/2039（99.2%）**；剩下 17 个都是上面列出的已知失败。其余 15 个是已知的：G-70 混合 4 个、随机片段操作与交互 8 个、
    RGB 加 16 位深度的 FBO 清除、深度范围比较、宽点的裁剪（G-64）。
- **EGL**：自建 APK 加了 EGL 场景（`v86gles.c` 的 `egl_scenes`）：交换间隔 0 与 1、`eglCreateSyncKHR` 的栅栏等到
  `EGL_CONDITION_SATISFIED_KHR` 与 `EGL_SIGNALED_KHR`、32×32 的 pbuffer 清成黄色、一个上下文建的纹理在同一共享组的另一个
  上下文里采样，都通过。
- **视频与游戏**（`A32_ANDROID_MEDIA=1`：两个 F-Droid 的游戏与一段 ffmpeg 生成的绿色 H.264 片段放在第四块盘上，
  `runs/v86-gles-media11/`）：
  - 视频：Gallery 的播放器显示出绿色画面（软件解码器的 YV12 经 gralloc 转成 RGB 再交给 GLES 主机）。起初是
    “Can't play this video”：播放器自己打开文件，而 Gallery 还没有存储权限（从桌面打开时它才会请求）；测试先 `pm grant`。
  - Replica Island（GLES 1）：它的对话框与菜单是 Android 视图，测试用 uiautomator 找按钮点击（“Leave it this way”、
    “Rock on!”、开始、中等难度），进入第一关，片头字幕在关卡上滚动，之后是 Wanda 的对话；一分钟约 220 帧、
    6.6 万次 GLES 调用。
  - Shattered Pixel Dungeon（libGDX，GLES 2）：进入地牢，点地块角色就走（撞上锁着的门，提示没有钥匙）；一分钟约
    230 帧、8 万次 GLES 调用。下地牢前故事画面的 Continue 从来不响应触摸点击（关卡早已生成好，按钮已启用；旁边的
    折叠箭头与地牢里的点击都正常），按键松开同样算 Continue，测试用回车通过；原因在游戏一侧，没有再查。
  - 两个游戏都没有声音：这台机器没有音频输出，游戏的 AudioTrack 与 MediaPlayer 报错后照常运行。系统按
    `interpret-only` 安装应用，代码靠 JIT。
  - 这些运行顺带找到并修好一个测试工具的问题：`tests/app/browser_runner.mjs` 被外部停掉时不关它的 Chrome，
    两次停掉的 Android 页面测试在后台跑了五个多小时，机器负载到 58，那段时间的运行都慢了一倍以上。

### E5 结论（2026-10-28）

- **快照**：主机模式启动后保存（`A32_ANDROID_SAVE_STATE`，1.17 GB），在新的进程与新的 Chrome 渲染器上恢复
  （`A32_ANDROID_RESTORE_STATE`）：4 秒恢复，主屏幕原样（图标来自图集颜色缓冲，随快照读回），点击热座打开拨号，
  32 位 APK 安装并画出它的帧。单元测试与浏览器测试覆盖 pipe 通道、半条命令、未读的回复、等页面的调用、纹理、
  渲染到纹理、EGL 图像、GLES 1.1 的状态。
- **性能**（同一个设置界面与通知栏的滑动，宿主秒）：

  | | 主机 GPU | 客体 CPU |
  | --- | --- | --- |
  | 滑动的帧率 | 5.6 帧每秒 | 0.08 帧每秒 |
  | 设置的启动（客体时间） | 0.9–1.2 秒 | 8.8 秒 |
  | 到 `boot_completed` | 247–333 秒 | 449–705 秒 |

  主机模式的帧率顶在机器时钟放慢后的 vsync 上：客体的 60 Hz 在宿主时间里是 6 Hz。GLES 主机自己在机器线程上的时间
  只占约 1.3%（36 秒的滑动里 467 毫秒），没有一次背压等待，页面的 WebGPU 工作也很少；低内存设置下的批次主要是 CPU
  画的窗口上传（36 秒 128.5 MiB）。所以批次大小、在途上限与 pipe 版本 2 都不是瓶颈，没有改；瓶颈是客体 CPU 与时钟的
  放慢。启动后把时钟调回原速（`A32_ANDROID_RATE_AFTER=1`）反而更差：设置的启动超时，内核报 RCU 停顿，时钟应用 ANR，
  滑动只有 0.83 帧每秒（客体时间走得快，定时器、闹钟与超时按十倍触发，界面分到的 CPU 更少）。所以十分之一的时钟
  保留；30 帧每秒要的是快得多的客体 CPU，不是 GPU 这一侧。
- **界面**：VM 管理器的 Android 7.1 有了“GPU”设置项（主机 / 客体），预设默认主机；`tests/app/presets.mjs` 增加用例，
  类型检查通过。浏览器里实测（`tests/app/android_gles_test.html`，`TIMEOUT_MS=2400000 node tests/app/browser_runner.mjs
  tests/app/android_gles_test.html webgpu=1`，导入的镜像按 URL 只读打开）：从管理器启动“Android (ARM 32-bit)”，CPU 在
  Worker 里约 120 MIPS，303 秒到 `boot_completed`，唤醒并回到主屏幕后屏幕就是启动器。这次实测找出一个已有的错误：
  Chrome 的 `DecompressionStream` 把 ramdisk 分区里 gzip 流之后的零当作垃圾报错，读到的块缺了归档的末尾，
  `init.ranchu.rc` 不在里面，管理器根本启动不了 Android 7.1（Node 的实现给了全部数据，所以 Node 的测试一直没发现）；
  `ramdisk_overlay.js` 改用 `src/virt/inflate.js`。另外 Makefile 里几个包的依赖漏了 `src/android/*.js`。
- **呈现**：没有图形代理时，GLES 主机自己用一个合成器接管屏幕的画布（同代理的做法，`V86.gles_screen_compositor`），
  `rcFBPost` 把颜色缓冲拷进合成器的一层，不再每帧读回；没有 WebGPU 就退回 2D 画布与读回。上面的浏览器实测走的就是
  这条路（执行器与合成器同一设备，层可见、全屏）。
- **pipe 版本 2**：滑动设置时 goldfish pipe 每秒约 4700 次寄存器访问、470 次写与 460 次读，客体同时每秒执行约 8900 万条
  指令；即使每次访问都算一次陷入，也只占机器时间的百分之一左右，pipe 版本 2 能省下的不到 1%，所以不做。

### E7 的测量（2026-10-28）

按 E7 一节的方法，在 gfxstream 模式下测：从 `build/a64-android/a10-desktop-gfxstream.v7`（官方镜像的桌面）恢复，
`A64_PARALLEL=1 A64_JIT=1`，客体里 `su 0 simpleperf record -e cpu-clock -a`，工作负载是冷启动设置
（`am start -W -S`，TotalTime 103 秒）、在设置里上下滑动、回到桌面、左右滑动，共 289 秒、149.5 万个样本：

| 范围 | ANGLE（`libGLESv2_angle.so`、`libEGL_angle.so`）与 Vulkan 驱动（`vulkan.ranchu.so`、`libvulkan.so`） | 其他 |
| --- | --- | --- |
| 全系统 | 约 1.5% | 内核 57.8%、libc 9.5%、ART 8.1%、simpleperf 自身 5.7% |
| `RenderThread`（hwui 发 GL 的线程） | 约 29%（ANGLE 23.6%、vulkan.ranchu 4.7%） | 内核 30.6%、hwui 22.7%、libc 10.8% |
| 界面相关的全部线程（设置的主线程、`RenderThread`、SurfaceFlinger、SystemUI、启动器） | 约 11% | |

着色器编译（ANGLE 的 GLSL 解析与翻译：`yyparse`、`sh::` 的遍历）只占几百到一千多个样本，不到 0.1%。SurfaceFlinger
里没有 ANGLE：它的合成走 HWC（`composer3-service.ranchu`）。

结论：按 E7 一节的标准（ANGLE、Vulkan 驱动与着色器编译占帧时间三成以上才做），这些数不够：发 GL 的线程里约三成，
整个界面的工作里约一成，编译几乎为零；界面慢主要在内核、ART 与 libc（客体 CPU 的速度）。原始报告在 E7 运行目录的
`probe-*.txt`（`build/a64-android/runs/v86-jit-par-gfxstream-bl-1536m-4c-out-official/`）。

## 已定（2026-10-27）

所有者不确定这几项，按以下默认推进；需要时随时改：

1. **E4 的验收**：dEQP-GLES2 子集与目标、三个 APK，见 E4。
2. **后门**：`UDF #0x8664`（A32 `0xE7F866F4`，T32 `0xF7F8 0xA664`），`r0` 的高 16 位为 `0x8664`；选项名 `gles_backdoor`；
   见“iOS 传输”。
3. **Android 的开关**：ranchu 设备模型的 `gpu_mode`（VM 配置的 `android.gpu_mode`）取 `"guest"`（默认）或
   `"host"`；VM 管理器在页面有 WebGPU 时选 `"host"`。复核时由初稿的顶层选项 `gles: "host" | "software"` 改来，
   理由见“Android 传输”的“启用”。
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
