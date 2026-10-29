# GLES 3.x 执行器计划（3.0、3.1 与 3.2）

状态：完成。2026-10-28 写，同日所有者定了范围、做法与后端（见“已定”）。L0–L7 都已完成（见各自的结论）：
dEQP-GLES3 子集 99.5%、GLES31 子集 99.4%、GLES2 子集 99.2%（宿主宣告 3.1，2026-10-29）；默认宣告 3.1，可选 3.2。前提是
[gles-proxy-plan.md](gles-proxy-plan.md) 的 E0–E6，以 `a17140ed` 为基线：E3–E6 的代码已提交，验收还没跑完。

本计划把 ranchu 的 GLES 宿主（`ranchu_gpu: "host"`）从 GLES 2.0 扩到 3.2，涉及三处：CPU 侧的影子状态、着色器编译、
页面上的执行器。客体仍是 Android 7.1（`armeabi-v7a-25_r18`），一个文件都不改。阶段记作 L0–L7，与
gles-proxy-plan 的 E 阶段区分。

## 现状（2026-10-28 核对）

### 客体能发什么

- **客体认识 3.2。**
  - `libOpenglSystemCommon.so` 与 `libEGL_emulation.so` 认识 `ANDROID_EMU_gles_max_version_2`、`_3_0`、`_3_1`、`_3_2`；
  - 宿主在 `rcGetGLString(GL_EXTENSIONS)` 里宣告哪一个，EGL 就按它建上下文，并检查请求的版本（“no ES 3.1 support”、
    “no ES 3.2 support”）；
  - `libGLESv2_enc.so` 自己会加 `GL_OES_EGL_image_external_essl3`。
- **编码器只到 ES 3.1。**
  - `libGLESv2_emulation.so` 的函数表有 797 项，最后是 ES 3.1 的 `glGetTexLevelParameteriv` 与 `GL_EXT_robustness` 的
    四个函数；
  - ES 3.2 新增的入口一个也没有：`glPatchParameteri`、`glFramebufferTexture`、`glTexStorage3DMultisample`、
    `glCopyImageSubData`、三个 `*BaseVertex` 绘制、`glMinSampleShading`、`glBlendBarrier`、`glPrimitiveBoundingBox`、
    `glTexBuffer*`、`glEnablei`/`glBlendFunci` 一族、`glGetnUniform*`、KHR_debug；
  - 平台的分发库 `libGLESv3.so` 有这些符号，但调用只落到 “called unimplemented OpenGL ES API” 的桩上。
- **gfxstream 的协议本身也只到这里。**
  - 固定的 `codegen/gles2/gles2.in` 在 ES 3.1 之后，只多了 `GL_OES/EXT_texture_buffer` 与
    `GL_EXT_draw_buffers_indexed` 的入口和几个 AEMU 命令，API 25 的编码器一个都不发；
  - 宿主的 `gles32_only.entries` 只给宿主自己的翻译库用。模拟器宣告 3.2 时，线上同样没有 3.2 的命令。
- **命令数**（`src/gles/gles_protocol.js`）：

  | 部分 | 命令 | 其中有回复的 |
  | --- | --- | --- |
  | ES 2.0 | 208 | |
  | ES 3.0 | 130 | 39 |
  | ES 3.1 与 robustness | 82 | 23 |
  | 之后（API 25 不发） | 19 | |

- **宿主宣告 3.x 后才出现的 emugl 命令**：
  - 缓冲映射：`glMapBufferRangeAEMU`（宿主把当前内容放进回复）、`glUnmapBufferAEMU`、
    `glFlushMappedBufferRangeAEMU`（客体写的字节随命令来）；
  - PBO：`glReadPixelsOffsetAEMU`、`glTex(Sub)Image2D/3DOffsetAEMU`、`glCompressedTex(Sub)Image2D/3DOffsetAEMU`，
    数据在绑定的 PBO 里；
  - 绘制：`glVertexAttribIPointerData/OffsetAEMU`、`glDrawElementsInstancedData/OffsetAEMU`、
    `glDrawRangeElementsData/OffsetAEMU`、`glDraw*IndirectData/OffsetAEMU`；
  - 其他：`glGetUniformIndicesAEMU`、`glTransformFeedbackVaryingsAEMU`、`glFenceSyncAEMU` 一族、
    `glCreateShaderProgramvAEMU`。
- **`rcCreateContext` 的版本参数**：今天的 gfxstream 客体对 3.1 与 3.2 都发 4（`guest/egl/egl.cpp`），宿主按自己
  宣告的最高版本建上下文。2017 年的客体发什么，L4 记日志核对。

### 宿主现在有什么

- **影子状态**：`src/gles/gles_shadow.js`（1549 行）与 `gles1_state.js`，覆盖 GLES 2.0 与 1.1。FBO 已按 ES 3.0 的
  规则属于上下文。
- **页面执行器**：`src/gles/page/gles_executor.js`（1561 行），只有 ES 2.0：
  - 每次绘制在 CPU 上把顶点组装成 f32、把索引组装成 u32；
  - 颜色纹理一律 `rgba8unorm`（gpu-deviations 的 G-67）；
  - 一个颜色目标、一个 uniform 块，只绑 2D、立方体与外部纹理。
- **宿主 CPU 的开销**（E2、E3 的录制，`gles.json` 的 `stats.cpu_ms`）：
  - 每次调用 11–23 µs；
  - 一次开机约 0.5 s，相对约 260 s 的开机时间约占 0.2%；
  - CPU 侧编译一个 ES 1.00 着色器约 0.5 ms。
- **dEQP-GLES2 还没有基线**：E4 的那次运行（`runs/v86-gles-deqp/deqp.json`）1950 个用例全是 NotRun。
- **着色器**：`gl_shader_translator.js` 的 ES 模式（GLSL ES 1.00）。它是手写前端，没有 IR，直接生成 WGSL。
  2026-10-28 的评估（附录 A）：
  - 扩到 3.00 约 3.5–4.5k 行，到 3.20 共 11–14k 行。它按名字把 varying 打包成 f32 槽，uniform 只有一种私有布局；
    原子类型、可分离程序、几何与细分的降级都和这个设计冲突，不宜扩过 3.00。
  - 已有的错误今天就影响 ES 2.0，XP 的桌面 GL 与它共用同一份代码：
    - 非一致控制流里的采样被写成 `textureSampleGrad` 加 `dpdx`，Chrome 的 Tint 拒绝，浏览器里复现了 4 种情形。
      VX 与 GX 都加了 `diagnostic(off, derivative_uniformity)`，它没加。
    - 向量 `==`、`ivec & int`、以变量作移位量时，生成的 WGSL naga 不收。
    - 写 `in` 参数被拒。

### 能复用的

- **`vx_naga`**（`src/browser/glbridge/vx/naga/`）：naga 30 的 spv-in → wgsl-out，加 4.6k 行 pass；
  `build/glbridge/vx_naga.wasm` 1.4 MB，已随图形代理加载。
  - 已有的转换：组合采样器拆开（`split.rs`）；整数纹理的采样改成取值（`intsample.rs`、`cubes.rs`）；std140 的二行
    矩阵与行主序（`layout.rs`）；矩阵与数组的输入输出（`io.rs`）；switch 的贯穿；isnan/isinf；数组纹理的层数；
    超过 12 个的 uniform 缓冲改成只读存储；变换反馈（`xfb.rs`：顶点着色器重跑成计算着色器）。
  - ANGLE 的 SPIR-V 走它，在 dEQP-GLES3 抽样中 1334 个用例通过 1233 个（arm64 附录 F）。
  - naga 的 SPIR-V 前端只认顶点、片段、计算（和 task、mesh）几种执行模型，不读几何与细分阶段
    （`front/spv/mod.rs` 的 `parse_entry_point`）。
- **GX**（`src/browser/glbridge/gx/`）：
  - 几何着色器、曲面细分、流输出、顶点拉取的做法；
  - `tessellator_wgsl.js`：D3D11 参考细分器的 WGSL 版，有 count、scan、generate 三个入口，自带绑定。
- **VX**：swizzle 拷贝、深度读取拷贝（`vx_executor.js` 的 `copyMode`）。
- **glslang**（2026-10-28 对照上游源码）：
  - `-R`（`setEnvInputVulkanRulesRelaxed`）把按 OpenGL 写的 GLSL 编成 Vulkan 的 SPIR-V：
    - 默认 uniform 打包进一个块（`--set-default-uniform-block`，`setGlobalUniformBlockName/Set/Binding`）；
    - `atomic_uint` 进存储块（`--set-atomic-counter-block`）；
  - `--auto-map-bindings`、`--auto-map-locations`，上游注明后者“fragile, not cross stage”；
  - `TProgram::buildReflection` 给反射；
  - **生成 SPIR-V 时 ES 版本必须 ≥ 310**（`DeduceVersionProfile`：“ES shaders for SPIR-V require version 310 or
    higher”）。宽松模式也一样；`setOverrideVersion` 在这项检查之前生效。不生成 SPIR-V 时，它按真实版本做 ES 的
    全部检查。
- **emsdk**（emcc 6.0.0）已在 `../emsdk`。

### WebGPU 与 ES 3.x 的差距

| ES 3.x 要的 | WebGPU | 做法 |
| --- | --- | --- |
| 3 分量格式（RGB8、RGB16F、RGB32I…）、打包格式、LUMINANCE/ALPHA | 没有 | 展开存放（RGB 存成 RGBA，alpha 用写入遮罩保持 1），L/A/LA 用 swizzle 拷贝 |
| 纹理 swizzle（3.0） | 没有 | VX 的 swizzle 拷贝：内容或 swizzle 变时重画一份 |
| ETC2/EAC（3.0 必须）、ASTC（3.2 必须） | 可选特性 `texture-compression-etc2`、`-astc` | 有就直传，没有就在页面上解码 |
| 边框颜色（3.2） | 没有 | 着色器里判断坐标（线性过滤时近似） |
| 整数纹理的 `texture()` | 只能取值 | `intsample.rs`，把寻址方式作为选项传入 |
| 变换反馈；顶点阶段写存储 | 顶点阶段不能写存储 | `xfb.rs` |
| 几何、细分（3.2） | 没有这些阶段 | 计算着色器，照 GX 的做法 |
| 多重采样 | 只有 1 或 4 个采样，没有多重采样数组 | 原生 4x；`sampler2DMSArray` 不做 |
| 实例除数大于 1、3 分量的 8/16 位属性、未对齐的偏移与步长、`GL_FIXED` | 顶点格式与对齐不收 | 计算着色器转成临时缓冲 |
| flat 取最后一个顶点 | WebGPU 取第一个 | 有 flat varying 的绘制重排索引，照 GX |
| 图元重启 | strip 总是在全 1 索引处重启，list 不重启 | 对上 ES 的固定索引重启；关掉重启而索引里有全 1 时有偏差，与 GX 相同 |
| 图像原子（3.2） | core 没有 | 偏差 |
| `interpolateAtCentroid/Sample/Offset`（3.2） | WGSL 没有 | 用导数近似，记为偏差 |
| 高级混合（3.2） | 不能读帧缓冲 | 绘制前拷贝目标，在片段着色器里混合 |
| 片段着色器写 SSBO 的绘制，后面又把同一缓冲当顶点或 uniform | 一个 pass 内的用法不能冲突 | 在冲突处结束 render pass |

点与线的宽度沿用 G-64、G-65。深度与模板分开附着仍报 `GL_FRAMEBUFFER_UNSUPPORTED`（G-66）。

## 结论

1. **执行器沿 E3 扩展，直接生成 WGSL。** ES 1.1、2.0、3.x 共用一个影子状态和一个执行器。不走 virgl→GX；
   附录 B 是退路。
2. **ES 3.x 的着色器走 glslang → SPIR-V → vx_naga → WGSL。**
   - CPU 侧（插件 `v86-gles.js`）带 glslang 的 wasm，跑两遍：
     - **第一遍**按着色器的真实版本（100、300、310、320 es），不生成 SPIR-V。它给出编译与链接的错误和 info log，
       以及 GL 视角的反射：活动的 attribute、uniform、uniform 块、缓冲变量、程序的输入输出，各自的类型与数组大小。
       `glGetShaderiv`、`glGetProgramiv`、`glGetActiveUniform*`、`glGetProgramResource*` 都由它回答。
     - **第二遍**在链接成功后，按宽松的 Vulkan 规则生成 SPIR-V。300 es 覆盖成 310 es，第一遍已按 300 检查过。
       location 与 binding 由宿主按 GL 的规则定（输入输出按链接时配对的名字给 location，uniform、采样器、块给
       binding），写进 SPIR-V 的 `OpDecorate`，不依赖 `--auto-map-locations`。变换反馈的 varying 同样写成
       `XfbBuffer`、`XfbStride`、`Offset`，加上 `Xfb` 执行模式。
   - SPIR-V 随链接的记录进批次。页面不跑 glslang，执行器里的影子状态直接用 CPU 侧给的链接结果。
   - 页面用 vx_naga 把 SPIR-V 变成 WGSL，选项按管线来：深度输出、整数采样器的寻址方式、改成存储的 uniform 缓冲、
     变换反馈的计算版本。
   - **GLSL ES 1.00** 走哪条由 L1 的数据决定。目标是也走 glslang：用现有前端的语法树打印成 310 es（重命名用户
     标识符，换掉 1.00 的内建），执行器就只剩一种着色器模型。做不到就留在现有翻译器，执行器按程序区分两种模型
     （ES 不允许 1.00 与 3.x 的着色器链接在一起）。
   - GLES 1.1 的固定功能仍由 `gl_fixed_function.js` 生成 WGSL，E4 的做法不变。
3. **先验证（L1）再动执行器。** 要验证的有：宽松模式在 GL 语义下能不能用（默认 uniform、location、反射、跨阶段
   配对），wasm 的大小与编译耗时，vx_naga 与 Tint 收不收。不通过就转附录 B 的 GX 路线；L0 与 L2（影子状态）两条
   路线都用得上。
4. **影子状态仍是 CPU 侧的权威。** ES 3.x 的查询照样不等页面，只多三类等页面的调用：
   - `glMapBufferRangeAEMU` 读一个 GPU 写过的缓冲（变换反馈、计算、`glCopyBufferSubData`、PBO 读回之后）。CPU 侧
     给每个缓冲留一份镜像和一个“GPU 较新”的标记，镜像是最新的就直接回复；
   - `glGetQueryObjectuiv` 取遮挡查询的 `GL_QUERY_RESULT`。`GL_QUERY_RESULT_AVAILABLE` 按已完成的批次回答，不等。
     变换反馈的图元数由 CPU 侧自己算：它知道每次绘制的图元数和缓冲的容量，而 ES 不允许在变换反馈时间接绘制；
   - `glReadnPixelsEXT`，同 `glReadPixels`。
5. **数据放到 GPU 上。** 每个 GL 缓冲对应一个 GPU 缓冲，CPU 侧另有镜像。顶点按 WebGPU 能收的布局直接取，收不了的
   先用计算着色器转换。纹理按大小格式（sized internal format）选 WebGPU 格式，不再一律 RGBA8。
6. **几何与细分在计算着色器里跑，照 GX：**
   - 顶点着色器以计算方式运行，顶点由它自己拉取，用 `xfb.rs` 的拉取；
   - 几何着色器每个输入图元跑一次，写下记录，再间接绘制；
   - 细分用 GX 的 WGSL 细分器；
   - naga 不读这两种阶段，所以先在 SPIR-V 上做小改动：执行模型改成 GLCompute，输入输出改成 Private，
     `OpEmitVertex`/`OpEndPrimitive` 改成调用占位函数。然后由 vx_naga 的新 pass 接上存储缓冲，方式同 `xfb.rs`。
7. **分阶段宣告版本。** 每个阶段验收后，才宣告对应的 `ANDROID_EMU_gles_max_version_*` 和 `ro.opengles.version`
   （3.0 = 196608，3.1 = 196609，3.2 = 196610）。ranchu 的选项 `ranchu_gles_version`（`"2.0"` | `"3.0"` | `"3.1"` |
   `"3.2"`）限制宣告的最高版本，默认取已验收的最高版本。vx_naga 的新 pass 都由选项打开，VX 不受影响。

### 性能预期

两条路线比较时的结论（2026-10-28）：
- **日常界面**：瓶颈是模拟的客体 CPU。宿主每次调用 11–23 µs；ES 3.x 的状态多了，也还在这个量级。
- **着色器编译**：直接生成 WGSL，体积小、变体少，管线建得比 GX 的寄存器机风格快，这是新画面首帧卡顿的主要来源。
  CPU 侧多了 glslang 的两遍编译，L1 测量；目标是一个典型的 300 es 着色器 ≤ 5 ms。
- **多重采样**：用 WebGPU 原生的 4x，片段着色器每像素跑一次。GX 是超采样，要跑 4 次。
- **顶点**：GPU 缓冲加上原生的顶点获取，取代 E3 每次绘制在 CPU 上组装顶点；大网格的绘制会快得多。
- **几何与细分**：只能用计算着色器模拟，开销与 GX 相同。

## 范围（已定，2026-10-28）

- **ES 3.0、3.1 完整。**
- **ES 3.2 只做现有操作码能表达的部分：**
  - GLSL ES 3.20 的全部着色器阶段：几何、细分控制、细分求值。客体没有 `glPatchParameteri`，patch 的顶点数固定为
    默认的 3；
  - 立方体贴图数组、ASTC（LDR）、`GL_CLAMP_TO_BORDER` 与边框颜色；
  - 高级混合（KHR_blend_equation_advanced，非一致版本）；
  - 采样着色：`GL_SAMPLE_SHADING` 的开关、`sample` 限定符、`gl_SampleID`、`gl_SamplePosition`、`gl_SampleMaskIn`、
    `gl_SampleMask`。客体没有 `glMinSampleShading`，最小比例保持 0；
  - `GL_EXT_robustness` 的四个函数；
  - KHR_debug 的可查询状态（入口不在线上，只答初值与限制）；
  - `GL_EXT_draw_buffers_indexed`：API 25 不发，但规格有操作码，执行器的代价小，所以做。
- **宣告 `ANDROID_EMU_gles_max_version_3_2`。** 够不到的 3.2 入口记为偏差（gpu-deviations 的 GLES 一节）：客体调用
  只落到桩上，什么也不发生。
- **不做：**
  - 纹理缓冲：客体没有入口，WebGPU 也没有；
  - 多重采样数组纹理；
  - 分层渲染：`glFramebufferTexture` 不在线上；
  - 图像原子：记为偏差；
  - KHR_debug 的回调，以及 `glCopyImageSubData` 等不在线上的入口。

## 架构

```text
=== guest: Android 7.1 (libGLESv2_enc, 2017) ==================================
 GLES 2.0 / 3.0 / 3.1 commands (+ AEMU), goldfish pipe "opengles"
=== CPU side: build/v86-gles.js ================================================
 stream → decoder → shadow state (gles_shadow.js + gles3_state.js + gles31_state.js)
   answers glGet*/glIs*/errors, program interface, maps (mirror), TF counts
 shaders: #version 300/310/320 es → glslang.wasm
   pass 1: validate + link + GL reflection (real version)
   pass 2: SPIR-V (relaxed Vulkan rules), locations/bindings/xfb written by the host
 batch writer → renderer stream "gles" (commands + answers + SPIR-V at link)
=== page: libv86-webgpu.js =====================================================
 gles_executor.js runs the same state machine (link results from the batch)
   programs: SPIR-V → vx_naga.wasm (GLES options) → WGSL → pipelines (cached)
   buffers on the GPU, vertex conversion, formats, samplers, MRT, MSAA 4x
   TF (xfb.rs), compute, images, SSBOs, indirect, queries, blits
   GS / tessellation as compute (SPIR-V patch + naga pass + GX's tessellator)
 color buffers, window surfaces, rcFBPost as in E3
```

### 模块

| 位置 | 内容 |
| --- | --- |
| `tools/glslang/build.mjs` | 用 emsdk 把固定提交的 glslang 编成 `build/glslang.wasm` 加一个小的 C 接口（编译、链接、反射、生成 SPIR-V），只开要用的部分 |
| `src/gles/glslang.js` | CPU 侧的封装：两遍编译、GL 规则的 location 与 binding 分配、写 SPIR-V 的装饰；反射换成 GL 的视图（名字、类型枚举、数组大小、块与成员的偏移和步长） |
| `src/gles/glsl_es.js` | 按 `#version` 选路：1.00 走现有前端（或 L1 定的 310 打印），3.x 走 glslang |
| `src/gles/gles3_state.js` | ES 3.0 的影子：VAO、采样器对象、查询、变换反馈对象、同步、不可变纹理与大小格式、3D 与数组纹理、PBO、缓冲映射与镜像、索引绑定（UBO、TF）、`glGetInteger64v`、`glGetIntegeri_v`、`glGetStringi`、`glGetInternalformativ`、程序接口、MRT 与读缓冲、`glClearBuffer*`、`glBlitFramebuffer` 与 `glInvalidate*` 的检查 |
| `src/gles/gles31_state.js` | ES 3.1 与 3.2 的影子：计算、SSBO、图像、原子计数器、间接绘制、程序管线与可分离程序、顶点属性绑定、多重采样纹理、帧缓冲默认参数、`glGetProgramResource*`、`glGetTexLevelParameter*`、robustness，以及 3.2 的状态（立方体数组、边框颜色、采样着色、高级混合、按目标的混合与遮罩、KHR_debug 的查询值） |
| `src/gles/gles_formats.js`、`gles_caps.js` | ES 3.0 表 3.13 与 3.16 的大小格式（可渲染、可过滤、可读回）；各版本的字符串、扩展与限制 |
| `src/gles/page/gles_programs.js` | SPIR-V → vx_naga → WGSL，管线与变体的缓存，绑定的布局 |
| `src/gles/page/gles_buffers.js` | GPU 缓冲、映射的读回、`glCopyBufferSubData`、PBO 的上传与读回 |
| `src/gles/page/gles_vertex.js` | 顶点输入：直接取或转换；索引：8 位、扇形与线环、重启、flat 的重排；间接绘制的参数 |
| `src/gles/page/gles_textures.js` | 格式映射与展开，ETC2/EAC 与 ASTC 的解码（没有对应特性时），swizzle 拷贝 |
| `src/gles/page/gles_passes.js` | MRT、多重采样与解析、blit、清除、查询，render pass 的切分 |
| `src/gles/page/gles_compute.js` | 计算、图像、SSBO、原子计数器、屏障 |
| `src/gles/page/gles_stages.js` | 几何与细分：顶点的计算版本、几何记录、细分器（GX 的 `tessellator_wgsl.js`）、间接绘制 |
| `src/browser/glbridge/vx/naga/src/` | 新 pass，都由选项打开：`stages.rs`（几何与细分接存储缓冲）、`border.rs`（边框颜色）、`blend.rs`（高级混合）、`sample.rs`（采样变量与 `interpolateAt*`），以及 SPIR-V 的预处理（几何与细分的执行模型） |
| `src/browser/glbridge/webgpu_host.js` | 可选特性加上 `texture-compression-etc2` 与 `texture-compression-astc` |

## 设计细节

### 着色器的数据流

- **`glCompileShader`**：第一遍按真实版本解析，回答 `GL_COMPILE_STATUS` 与 info log，保存源码。
- **`glLinkProgram`**：
  1. 第一遍重新解析各阶段并按 GL 的规则链接：接口配对、限制、变换反馈的 varying 是否存在。
  2. 由反射建立程序的 GL 视图：
     - uniform 的 location：先取 `layout(location)`，其余按反射顺序分配；
     - attribute 的 location：先取 `glBindAttribLocation` 与 `layout(location)`，其余由宿主分配；
     - 片段输出：`glBindFragDataLocation` 是桌面 GL 的，ES 只有 `layout(location)` 与单输出的默认值；
     - uniform 块与缓冲块的索引、大小、成员。
  3. 第二遍生成每个阶段的 SPIR-V，再按名字（`OpName`）把 location、binding、DescriptorSet 与 Xfb 的装饰改成上一步
     定的值。
- **默认 uniform**：宽松模式把它们放进 `gl_DefaultUniformBlock`，偏移来自反射。影子状态为每个程序保存这个块的
  字节映像：`glUniform*` 按 location 写字节，批次带上改过的范围，页面每次绘制用一个环形的 uniform 缓冲取当前映像。
- **采样器**：采样器 uniform 的值是纹理单元，可以随时改。所以绑定在绘制时才定：SPIR-V 的 binding 取该单元当前的
  纹理，再加上绑定的采样器对象或纹理自己的参数。
- **块**：uniform 块的 binding 点由 `glUniformBlockBinding` 指定。绘制时，按 binding 点取 `glBindBufferRange` 的
  缓冲与范围（偏移对齐报 256）。SSBO（`layout(binding)`）、原子计数器（宽松模式下成了存储块）、图像
  （`glBindImageTexture` 的单元）同理。
- **页面**：vx_naga 的结果按 SPIR-V 的散列与选项缓存。选项来自绘制的状态：有没有深度附着、整数采样器的寻址方式、
  哪些 uniform 缓冲超出 12 个而要改成存储。

### 顶点与索引

- **直接取**：布局合法就直接从 GPU 缓冲取，即格式存在、偏移与步长对齐、步长不超过 2048、除数是 0 或 1。
- **转换**：其余情况由计算着色器转进临时缓冲：3 分量的 8/16 位、`GL_FIXED`、未对齐、除数大于 1（按实例展开）。
  客户端数组（数据随命令来）先上传到临时缓冲。
- **索引**：
  - 8 位索引扩成 16 位；
  - 扇形与线环生成索引：索引在 CPU 侧可知时（客户端数组或镜像最新）在 CPU 上生成，否则用计算着色器；
  - 有 flat varying 的绘制，按 GL 的最后一个顶点重排索引；
  - 间接绘制直接交给 WebGPU。要转换或扇形的间接绘制，用计算着色器生成参数（GX 不画这类绘制，这里要画）。
- `gl_VertexID`、`gl_InstanceID` 对应 WGSL 的 `vertex_index`、`instance_index`，两者都包含起始值，与 GL 一致。

### 纹理、采样器与格式

- **格式表**：ES 3.0 的大小格式逐个映射到 WebGPU。没有 3 分量格式时展开存放。32F 不可过滤（ES 3.0 的规定），有
  `float32-filterable` 时才宣告 `GL_OES_texture_float_linear`。
- **纹理参数**：
  - 不可变纹理（`glTexStorage*`）；
  - `BASE_LEVEL`、`MAX_LEVEL` 用视图的级别范围；
  - `MIN_LOD`、`MAX_LOD` 用采样器的 `lodMinClamp`、`lodMaxClamp`；
  - `COMPARE_MODE` 为比较采样器加深度视图；
  - `DEPTH_STENCIL_TEXTURE_MODE`（3.1）为只含模板的视图；
  - 采样器对象优先于纹理自己的参数。
- **swizzle 与 L/A/LA**：用 swizzle 拷贝，按内容的版本缓存。
- **压缩格式**：
  - ETC1、ETC2/EAC：有 `texture-compression-etc2` 就直传，否则在页面上解码（ETC1 的解码器已有）；
  - ASTC：有 `texture-compression-astc` 就直传，否则解码。解码器自己写，或把参考解码器编成 wasm，L6 决定。
- **其他纹理**：3D、2D 数组、立方体数组；4x 多重采样纹理（3.1）。
- **读回**：`glReadPixels` 按 ES 3.0 的格式与类型组合转换，包括 `GL_IMPLEMENTATION_COLOR_READ_FORMAT/TYPE`。

### 帧缓冲与绘制

- **目标**：MRT 报 4 个，即 ES 3.0 的最小值。8 个 RGBA32F 会超过 WebGPU 每采样 32 字节的限制；之后要提高再测。
- **清除**：`glDrawBuffers`、`glReadBuffer`；`glClearBuffer*` 按目标的类型（浮点、整数、深度、模板）清除。
- **`glBlitFramebuffer`**：着色器拷贝，可以缩放、过滤、翻转；深度写 `frag_depth`；1:1 的多重采样解析用
  `resolveTarget`。模板做不到，每位一遍的模板写入代价太高，记为偏差。
- **多重采样**：多重采样的渲染缓冲是原生 4x。`glGetMultisamplefv` 答 WebGPU 4x 的标准位置。
- **其他**：`glInvalidate(Sub)Framebuffer` 用作 `storeOp: "discard"` 的提示。没有附着的帧缓冲（3.1）用一个写入遮罩为
  0 的占位目标。sRGB 格式直接用 WebGPU 的 `-srgb` 格式。
- **render pass 的切分**：一个 pass 内的用法冲突时结束 pass，例如前面写过的存储缓冲又被当作顶点或 uniform 读。
  `glMemoryBarrier` 也结束 pass。

### 变换反馈、查询与同步

- **变换反馈**：用 `xfb.rs` 的计算预跑，写进 TF 缓冲，再照常绘制（`GL_RASTERIZER_DISCARD` 时不画）。暂停与继续
  记在 CPU 侧的偏移里。
- **遮挡查询**：一个 GL 查询可能跨几个 render pass，每个 pass 用 WebGPU 的遮挡查询，结果相加；`ANY_SAMPLES_PASSED`
  与 `_CONSERVATIVE` 都按“和大于 0”。
- **同步对象**：只要顺序，同 E2。

### ES 3.1

- **计算**：`glDispatchCompute`，以及读间接缓冲的 `glDispatchComputeIndirect`。
- **SSBO 与原子**：SSBO 用 WGSL 的 `atomic<T>`，有符号的原子最小值、最大值照常用 `atomicMin/Max<i32>`（GX 有这项
  偏差，这里没有）。
- **图像**：用存储纹理。ES 3.1 的图像格式与读写规则（只有 r32f/i/ui 可以读写）与 WebGPU core 一致；分层绑定用数组
  视图。
- **可分离程序与程序管线**：每个阶段单独生成 SPIR-V，阶段之间按 location 配对；管线对象在影子状态里。
- **顶点属性绑定**：`glVertexAttribFormat`/`glBindVertexBuffer` 是 3.1 的模型，3.0 的调用在影子里改写成它。
- **限制**：顶点阶段报 0 个 SSBO、图像与原子计数器，这是 ES 3.1 的最小值，也是 WebGPU 顶点阶段不能写存储的原因。

### ES 3.2

- **几何着色器**：顶点着色器的计算版本把记录写进缓冲，几何着色器每个输入图元（和实例）跑一次，写出至多
  `max_vertices` 个顶点，带计数；然后一次计算把条带展开成列表，写间接参数，再画。
- **曲面细分**：细分控制每个 patch 跑一次，写输出与细分因子；接 GX 的细分器（count、scan、generate）；细分求值每个
  生成的点跑一次；再画。细分后接几何着色器（GX 没有）也要支持。
- **高级混合**：用了高级方程的绘制，先把目标的对应区域拷成纹理；片段着色器读它，按方程混合，再关掉固定混合写出。
  一次绘制内图元重叠时结果不定，非一致版本的规范本来就允许这样。
- **边框颜色**：只在用到 `CLAMP_TO_BORDER` 的采样上，在着色器里判断坐标；最近过滤时准确，线性过滤时近似。
- **采样变量**：`gl_SampleID`、`gl_SampleMaskIn`、`gl_SampleMask` 对应 WGSL 的内建；`gl_SamplePosition` 按 4x 的标准
  位置计算；`sample` 限定符对应 `@interpolate(..., sample)`；`interpolateAt*` 用导数近似。
- **立方体贴图数组**：用 WebGPU 的 `cube-array` 视图。
- **按目标的混合与写入遮罩**：WebGPU 的每个颜色目标各有一组。

### 限制

CPU 侧在页面有设备之前就要回答 `glGet*`，所以限制是固定值，取 WebGPU 的默认限制能保证的数，不看适配器：

| 限制 | 值 | 依据 |
| --- | --- | --- |
| `MAX_TEXTURE_SIZE`、`MAX_CUBE_MAP_TEXTURE_SIZE` | 4096 | 沿用；ES 3.0 最小 2048 |
| `MAX_3D_TEXTURE_SIZE`、`MAX_ARRAY_TEXTURE_LAYERS` | 2048、256 | WebGPU 默认 |
| `MAX_VERTEX_UNIFORM_BLOCKS`、`MAX_FRAGMENT_UNIFORM_BLOCKS` | 12 | ES 最小值；加上默认块的第 13 个由 vx_naga 改成只读存储 |
| `MAX_UNIFORM_BLOCK_SIZE` | 16384 | ES 最小值；WebGPU 默认 65536 |
| `MAX_DRAW_BUFFERS`、`MAX_COLOR_ATTACHMENTS` | 4 | 见上文 |
| `MAX_SAMPLES` | 4 | WebGPU |
| `MAX_VARYING_VECTORS`、输出与输入分量 | 15、60、60 | 16 个 location 留一个余量；`io.rs` 把矩阵和数组拆开后可能超出，见“风险” |
| `MAX_TRANSFORM_FEEDBACK_*` | 64、4、4 | ES 最小值 |
| `MAX_COMPUTE_WORK_GROUP_SIZE`、调用数、共享内存 | (128, 128, 64)、128、16384 | ES 最小值，都在 WebGPU 默认之内 |
| `MAX_COMPUTE_SHADER_STORAGE_BLOCKS`、`MAX_COMPUTE_IMAGE_UNIFORMS` | 4、4 | ES 最小值；WebGPU 默认 8、4 |
| `MAX_COMBINED_TEXTURE_IMAGE_UNITS`、`MAX_FRAGMENT_UNIFORM_COMPONENTS`、`MAX_UNIFORM_BUFFER_BINDINGS` | 48、1024、36 | ES 3.1 的最小值，3.0 的上下文也一样；GLES 2.0 的上下文（api 20）仍是 32、896 |
| `MAX_SHADER_STORAGE_BUFFER_BINDINGS`、`MAX_ATOMIC_COUNTER_BUFFER_BINDINGS` | 8、4 | 绑定点只是上下文状态，高于最小值 4、1：dEQP-GLES31 把计数器绑在 1，实例数组的六个块各占一个 |
| `MAX_GEOMETRY_*`、`MAX_TESS_*`、`MAX_PATCH_VERTICES` | ES 3.2 的最小值 | 计算着色器里做，不受渲染阶段的限制约束 |

## 阶段

### L0 准备

- **修共用翻译器的已知错误**（现状一节列出的那些）：加 `diagnostic(off, derivative_uniformity)`，不再用
  `dpdx`/`textureSampleGrad` 的写法；修向量 `==`、整数位运算的广播、移位量、写 `in` 参数。
- **补 ES 模式的测试**：`tests/glbridge/` 加 `es: true` 的用例。浏览器测试用 Tint（`getCompilationInfo`）检查，因为
  naga 不检查片段阶段的一致性。
- **跑一次 E4 的 dEQP-GLES2 子集**，记下基线。之前那次全是 NotRun，要先查明原因；之后各阶段都按这个数检查不回退。
- **取用例表**：从同一个 CTS 7.1_r29 包里，用 `tools/a32_cts.mjs` 按字节范围取 `gles3-master.txt` 与
  `gles31-master.txt`。下载前征得所有者同意。

验收：
- `make test-glbridge`，以及 XP 的 Cube 2 语料全部通过；
- 新的 ES 用例经 Tint 验证；
- dEQP-GLES2 的基线写进本计划。

粗估：约 0.5k 行。

**L0 结论（2026-10-28）：**
- 共用翻译器（`0057be1d`、`34c2c349`）：
  - 每个模块关掉 `derivative_uniformity`，非一致控制流里的采样默认照常写 `textureSample`（XP 的执行器仍要 `"grad"`）；
  - 向量、矩阵、结构与数组的 `==`/`!=` 合成一个 bool；整数位运算里的标量扩成向量；移位量转成 u32；`in` 参数可以写；
  - GLSL ES 1.00 拒绝它保留的 `%`、`&`、`|`、`^`、`<<`、`>>`、`~`；
  - 矩阵与标量的 `+`、`-`、`/`、矩阵相除、矩阵取负与自增按列做；uniform 结构里的结构数组能排布局（dEQP 的
    `shaders.discard` 曾在这里让链接抛异常）；
  - `TRANSLATOR_REVISION` 2。
- 测试：
  - `tests/glbridge/gles_shader_browser_test.html` 用 Chrome 的 Tint 检查四种非一致控制流、写 `in` 参数与各种运算，
    已加进 `make display-browser-tests`；
  - `gl_shader_wgsl_validation_test.js` 加了 ES 用例；
  - XP 的 OpenGL 浏览器测试与 Cube 2 语料照旧通过。
- **dEQP-GLES2 基线**（另一个会话跑的，ios6 `b1328cb2`，含 `0057be1d`）：
  - 支持的 2032 个用例中通过 1807 个（88.9%，含 3 个 QualityWarning），失败 225，NotSupported 15，没有崩溃；
  - `state_query` 372/372 全过；
  - 翻译器一侧的失败：`shaders.random` 85、`shaders.matrix` 35（`34c2c349` 修了生成错误）、`uniform_api` 14、
    `preprocessor` 10、其余各 1–4 个；
  - 执行器一侧的失败：`fragment_ops` 38、`texture` 23，由那个会话处理；
  - 结果在 `build/wt-m10/build/a32-android/runs/v86-gles-deqp/deqp.json` 与 `deqp-details.json`。
- 用例表 `gles3-master.txt`、`gles31-master.txt` 已取到 `build/a32-android/cts/`。

### L1 着色器的验证

- `tools/glslang/build.mjs`：固定一个 glslang 的发布版（下载前征得同意），用 emsdk 编成 wasm，测大小。
- `src/gles/glslang.js` 的最小版：两遍编译、location 与 binding 的分配、写 SPIR-V 的装饰、GL 视角的反射。
- **语料**：
  - Android 7.1 开机时的 64 个着色器（E2 的 `--shaders` 导出）；
  - dEQP-GLES3、GLES31 的 `shaders.*` 各组抽样，从用例的源码里取；
  - 手写的 3.10 与 3.20 用例：计算、SSBO、图像、原子计数器、几何、细分。
- **每个着色器的检查**：
  - 第一遍的结果与 dEQP 的期望一致：合法的能编译，非法的被拒；
  - 第二遍的 SPIR-V 经 vx_naga 得到 WGSL，经 naga 与 Tint 验证；
  - 反射与 GL 的期望一致：名字、类型、数组大小、块的布局、location；
  - 跨阶段的 location 配对正确。
- **测量**：每个着色器的两遍耗时（CPU Worker 里），wasm 的装载时间与大小。
- **GLSL ES 1.00**：试用现有前端打印 310 es，对开机语料与 dEQP-GLES2 的 `shaders.*` 抽样比较：输出相同，或者
  像素一致。
- **几何与细分的可行性**：一个几何着色器和一对细分着色器的 SPIR-V 经预处理后被 naga 读进，pass 的雏形能生成
  合法的计算着色器。

验收（全部满足才继续，否则转附录 B）：
- 语料的 99% 以上走完整条路并通过 Tint；剩下的每个都有原因，而且不是 glslang 或宽松模式的根本限制；
- 反射能回答 GL 的全部程序查询；
- 一个典型的 300 es 着色器两遍合计 ≤ 5 ms；wasm 不超过 4 MB；
- 1.00 的走法定下来；
- 结论写进本计划的“L1 结论”。

粗估：1.5–2.5k 行，加语料与测试。

**L1 结论（2026-10-28）：验证通过，继续直接生成 WGSL 的路线。**

- **glslang**：16.6.0，`tools/glslang/build.sh` 用 emsdk 编成 `bios/glslang.wasm`，2.0 MB，独立 wasm，只要几个 WASI 的
  桩。接口在 `tools/glslang/v86_glslang.cpp`，JS 一侧是 `src/gles/glslang.js`。补丁 `tools/glslang/es_spirv.patch`
  改了三处：
  - 宽松的 Vulkan 规则下允许 ES 低于 310 生成 SPIR-V；
  - 低于 310 es 时不加 tile image 的内建（它们用到 `uint`）；
  - 默认 uniform 块写明 std140（glslang 本来就是这个默认值，补丁写死它）。
- **两遍**：
  - **检查遍**按着色器的真实版本，不生成 SPIR-V。`glCompileShader` 的那一遍还单独链接一次这个阶段：ES 每个阶段只有一个
    着色器，`gl_FragColor` 与 `gl_FragData` 同用、函数没有函数体这类错误，GL 报在编译时；
  - **代码遍**用宽松的 Vulkan 规则生成 SPIR-V 1.0。
- **ES 1.00**：在代码遍之前用词法改写成 300 es（`src/gles/glsl_es_rewrite.js`），不再由 glslang 的补丁支持：
  - 改写的内容：`attribute`/`varying`、`gl_FragColor`/`gl_FragData` 改成输出，1.00 的纹理函数与扩展的同名函数、
    `gl_FragDepthEXT`、`samplerExternalOES`、`gl_MaxVaryingVectors`、`#extension` 行，以及片段输入上的 `invariant`；
  - 与 3.00（及 Vulkan GLSL）关键字或内建同名的用户名字加后缀，改名表随结果走；
  - 已知缺口：1.00 允许重载内建函数，函数体内的局部变量可以遮住参数，3.00 两样都不允许。dEQP-GLES2 中受影响的有
    6 个用例，真实着色器里有 1 个（重载 `step`）。
- **GL 的视图**（`src/gles/glsl_program.js`）：
  - 产出影子状态现有的 `ProgramInfo` 形状，另加 `spirv`、`blocks`、`bindings`；
  - attribute 的 location 先取 `layout(location)`，再取 `glBindAttribLocation`，都没有就取最低的空位；
  - uniform 的 location 先取显式的。两个 uniform 用同一个显式 location 时链接失败，不活动的也算（glslang 不查）；
  - 默认块的偏移与步长**从 SPIR-V 的装饰读**：glslang 对代码遍的反射给出的默认块偏移与它写进 SPIR-V 的不一样。
- **接口**（`src/gles/spirv_patch.js` 改 SPIR-V 的装饰）：
  - 顶点输入用 attribute 的 location；
  - 前一阶段的输出与后一阶段的输入按名字取同一个 location（着色器自己写了 location 时照它的）；
  - 资源都在组 0：默认块 0，采样器从 1 起，uniform 块从 17，存储块从 42，原子计数器从 60，图像从 70。采样器与图像按
    SPIR-V 的变量一个一个给绑定：结构里的采样器数组在 SPIR-V 里是每个元素一个变量。
- **vx_naga** 新增两处，VX 也受益：
  - `math.rs`：标量的 `normalize`/`reflect`/`refract`/`faceforward` 改用 `vec2(x, 0)` 计算，取 `.x`；
  - `lib.rs` 的 `explicit_layout`：naga 30 的 WGSL 写出器不写 `@size`/`@align`，偏移不是自然布局的结构成员丢了位置。
    现在补 `@size`；结构作为数组元素时，按数组的步长定结构的大小。没有这一条，std140 的嵌套结构读错字节（或者在
    uniform 缓冲里被拒）。
- **语料**（`tests/gles/shader_corpus.mjs`，已加进 `make gles-tests`，结果低于下面的数就失败）：
  - **dEQP 的着色器库**（CTS 7.1 APK 里 gles2、gles3、gles31 的 `.test`，模板按 dEQP 的做法简化填充）：
    - 4643 个用例，590 个跳过（可分离管线、我们不宣告的扩展、顶点阶段为 0 的限制），7286 个程序；
    - 检查遍与 dEQP 的期望一致 7162 个（98.3%）。不一致的 124 个大多是简化模板的偏差，真正的差别有三类：
      - 3.00 的保留字里有 8 个 glslang 接受了（`image1DShadow` 等）；
      - 约 20 个应当链接失败的跨阶段规则 glslang 不查（uniform 在两个阶段的精度不同等）；
      - `fragdata`：dEQP 期望 `gl_FragColor` 与 `gl_FragData` 同用是编译错误，单阶段链接之后已经一致；
    - 4939 个程序链接成功，生成 10096 个 SPIR-V 模块。其中 219 个是几何或细分着色器，naga 不读，留待 L6；
    - 其余 9877 个里 vx_naga 失败 3 个：`missing_returns` 用例，naga 报 `ExpressionAlreadyInScope`。
  - **真实着色器**（三次 Android 7.1 录制中导出：开机、自建 APK、dEQP-GLES2 运行）：
    - 1440 个，检查遍接受 1374 个；
    - 只有 glslang 拒绝的 15 个，大多是旧翻译器错放的非法着色器；只有旧翻译器拒绝的 29 个，glslang 接受；
    - 1373 个生成 WGSL，失败 1 个（上面的 `step` 重载）。
  - **WGSL 全部合法**：两套语料共 11247 个 WGSL 模块经 naga 验证，并在 Chrome 中经 Tint 验证
    （`gles_shader_browser_test.html?corpus=build/gles-shader-corpus.json`），一个都没被拒。
- **耗时与大小**（Node 中测）：
  - 真实着色器每个两遍合计中位 1.2 ms，p95 2.2 ms；第一次用到某个版本与阶段时约 70 ms，是 glslang 建内建表；
  - dEQP 程序的检查遍平均 0.5 ms，代码遍平均 1.1 ms；
  - 达到 ≤ 5 ms 的目标。
- **几何与细分可行**：
  - 一个几何着色器的 SPIR-V 做了这些改动后，naga 能读进来并写出合法的计算着色器：执行模型改成 GLCompute，
    `Geometry` 能力改成 `Shader`，去掉几何的执行模式与入口的接口列表，Input/Output 改成 Private，去掉 Location 与
    BuiltIn 装饰，`OpEmitVertex`/`OpEndPrimitive` 先去掉；
  - L6 要做的：`EmitVertex` 换成调用占位函数，再加一个 naga pass 接上记录缓冲（同 `xfb.rs`）。
- **留给后面的**：
  - 计算着色器里原子计数器的操作 naga 报 `InvalidAtomic`（L5）；
  - 检查遍不查的跨阶段规则（L2 在 `glsl_program.js` 里补）；
  - 执行器还没有用到这条路（L2、L3）。

### L2 ES 3.0 的影子状态

- `gles3_state.js` 与改动的 `gles_shadow.js`、`gles_formats.js`、`gles_caps.js`：
  - 上下文的版本：2.0 上下文里，ES 3.0 的入口按 GL 的规则报错；
  - 模块表里 ES 3.0 的全部状态与查询；AEMU 命令；
  - 缓冲的镜像与“GPU 较新”的标记；
  - 变换反馈的计数；
  - 等页面的三类调用（结论第 4 条）。
- `glslang.js` 接进 `compile_shader`/`link_program`：3.x 走 glslang，SPIR-V 进链接的记录。
- 快照（`gles_snapshot.js`）加入新的对象。着色器按 E5 的做法，恢复时从源码重新编译。

验收：
- `tests/gles/shadow3.mjs`：对照 ES 3.0 规范的状态表与错误；
- 录下的 ES 3.0 批次在 Node 里能解码；
- 2.0 的测试不变。

粗估：3–4k 行。

**L2 结论（2026-10-28）：完成**（`7ba3106e`、`6d240bb3`，页面的影子在 L3 补了一处）。

- **版本**：`rcCreateContext` 的版本参数 3 起建 3.x 上下文（记录里的 api 为 30–32），`ranchu_gles_version` 选宣告
  的最高版本；`rcGetGLString` 按它回答版本串与 `ANDROID_EMU_gles_max_version_3_x`。
- **状态**：`src/gles/gles3_state.js`（约 2.1k 行）按 ES 3.0 规范的状态表写：顶点数组对象、缓冲的全部目标与 AEMU 的
  映射命令、3D 与数组纹理、不可变纹理、采样器对象、ES 3.0 的帧缓冲完整性与读写缓冲、uniform 块、变换反馈、查询、
  同步对象、`glGetStringi`、`glGetInternalformativ`。2.0 上下文仍用 `gles_shadow.js` 自己的处理函数。
- **着色器**：3.x 的着色器在 CPU 侧过 glslang，链接结果（`glsl_program.js` 的 `pack_program`）以 `GLES.PROGRAM_LINK`
  记录先于它的 `glLinkProgram` 进批次；页面没有 glslang，照这份结果链接。快照里页面保留这类程序的结果，CPU 侧从
  源码重新链接。
- **缓冲的镜像**：CPU 侧保留缓冲的字节（`keep_bytes`），页面写过的缓冲标“GPU 较新”（变换反馈、拷贝、打包缓冲）；
  这样的缓冲被映射时由页面回答（L3 的 `BUFFER_READ`）。
- **L3 发现并补上的**：`glGen*` 是查询，只在 CPU 侧，页面从没见过这些名字。ES 3.0 绑定没生成过的名字是错误，页面的
  影子因此拒绝了全部缓冲、顶点数组、帧缓冲、变换反馈、查询与采样器的绑定。现在页面的影子是 `trusted`：CPU 侧接受
  了的名字视为已生成。
- 验收：`tests/gles/shadow3.mjs` 通过，2.0 的测试不变。

### L3 ES 3.0 的执行器

页面的执行器按“设计细节”扩展：
- 缓冲上 GPU，顶点的直接取与转换，索引；
- 格式表、采样器对象、swizzle 拷贝、ETC2/EAC；
- 3D 与数组纹理；
- MRT、多重采样与 blit、清除与读回、PBO；
- 变换反馈、查询；
- vx_naga 的 GLES 选项与程序缓存。

E3 的 CPU 组装路径在 ES 2.0 的测试全部转到新路径之后删掉。

验收：
- `tests/glbridge/gles_executor_browser_test.html` 加入 ES 3.0 的场景，每个都与参考像素比较：整数纹理、MRT、UBO、
  实例化、变换反馈、3D 与数组纹理、多重采样解析、PBO、sRGB；
- ES 2.0 的场景与 E3 录下的开机批次重放不变。

粗估：4–6k 行。

**L3 结论（2026-10-28）：完成**（`f80f5dcb`、`c391bfa2`、`348cdcf8`、`02dac8f6`、`e5310dfd`；`src/gles/page/gles3_executor.js`
约 2.4k 行，`gles3_pixels.js` 约 0.4k 行）。

- **着色器**：每个阶段的 SPIR-V 经 vx_naga 转成 WGSL，带新增的 `gl_depth` 选项（z 变成 (z + w) / 2，位置单独作为结果
  也照办）和旧翻译器同样的 Y 翻转，所以帧缓冲第 0 行仍是 GL 的最底一行。没有深度附着时去掉片段的深度输出；整数纹理的
  采样改成读取，带上采样器的寻址方式。绑定组按 WGSL 的声明与绑到的纹理定类型（可过滤与否、深度、整数），不用 `auto`。
- **缓冲**：每个缓冲第一次用到时建 GPU 缓冲，从 CPU 侧的字节同步（脏区间）；GPU 较新的缓冲直接收客体的写入。
- **顶点**：WebGPU 有格式、对齐也合法的数组直接从缓冲取，同一缓冲、步长与步进的属性合用一个槽；其余在 CPU 上组装
  （客户端数组、3 分量与打包类型、除数大于 1）。当前值放进一个步长为 0 的缓冲。索引能直接用就直接用元素缓冲，否则
  在 CPU 上生成列表：扇形与线环、8 位索引、固定的重启索引（条带用 0xFFFFFFFF 重启，列表在重启处结束图元）。
- **纹理**：按大小格式的 WebGPU 格式存放，一个 GPU 纹理放下从最低的那一级起的全部级别；ES 3.0 的完整性（基础与最大
  级别、立方体、不可过滤格式的过滤器）不满足时采样 (0, 0, 0, 1)。上传按 ES 3.0 的像素存储参数解包再转成 WebGPU 的
  纹素（`gles3_pixels.js`）。深度格式中 WebGPU 不允许拷入的（depth24plus、depth32float）由绘制写入。ETC2/EAC 在设备
  有 `texture-compression-etc2` 时直传（这台 Mac 有），否则只解码 ETC1 子集。swizzle 用 `texture-component-swizzle`
  的视图（这台 Mac 有）。3D 纹理的 mipmap 逐层绘制。
- **帧缓冲**：绘制缓冲各是一个颜色附着，带各自的格式；多重采样渲染缓冲为 4x。`glClear`/`glClearBuffer*` 不受限时用
  pass 的清除，否则画一个四边形。`glBlitFramebuffer`：不缩放、不翻转、不裁剪、格式相同时拷贝，否则绘制；多重采样
  先解析；深度经 `frag_depth`。`glCopyTex*Image` 换格式时走同一个绘制，带 ES 3.0 表 3.15 的通道规则。
- **读回**：`glReadPixels` 读读缓冲的原始纹素，按调用的格式、类型与打包参数转换；读进打包缓冲的在批次结束后写入，
  同一批次里随后的映射会叠上这些字节。
- **变换反馈**：链接时给被捕获的输出加 VK_EXT_transform_feedback 的装饰（`spirv_patch.js` 的 `add_xfb`），绘制前用
  vx_naga 的 `xfb.rs` 把顶点着色器当计算着色器跑一遍，写进暂存缓冲，再拷到绑定的缓冲里影子已经计数的位置。
- **映射与查询的回读**：映射 GPU 较新的缓冲（不作废内容时），宿主向页面要字节（`GLES.BUFFER_READ`）；遮挡查询每次
  绘制用一个 WebGPU 遮挡查询，批次末汇总，宿主读结果时向页面要（`GLES.QUERY_READ`，画过的查询才要，只要一次）。
- **ES 2.0**：宿主有 glslang 时，2.0 上下文的记录是 api 20（`Context` 的 `glslang`），ES 1.00 着色器也过 glslang，
  页面按 3.x 的路径画。没有 glslang.wasm 时仍是 api 2，用旧翻译器；GLES 1.1 仍用固定功能的路径。因此“E3 的 CPU
  组装路径”还在，删不掉：1.1 与没有 glslang 的宿主都用它。
- **快照**：新路径的纹理按自己的格式、层与压缩块读回，再经 `gpu_texture3`/`upload3` 放回；渲染缓冲按格式与采样数
  重建。depth24plus 与多重采样的内容不保留（同 E5）。GPU 较新的缓冲在快照里取的是 CPU 侧的字节（L7）。
- **测试**：`tests/glbridge/gles3_executor_browser_test.html` 43 项（`make display-browser-tests`），覆盖本阶段验收的
  各项：整数纹理、MRT、UBO、实例化、变换反馈、3D 与数组纹理、多重采样解析、PBO、sRGB，另有深度采样、blit、遮挡
  查询、ETC2、swizzle、api 20 的 2.0 上下文与它的快照。`gles_executor_browser_test.html`（api 2，旧路径）75 项不变；
  `shadow3.mjs` 覆盖宿主的映射与查询回读。E3 录下的开机批次重放留到 L4 与开机一起核对。
- **偏差**（写进 gpu-deviations.md 时一起整理，L7）：
  - `glBlitFramebuffer` 不拷模板（WebGPU 不能写模板值）；带数据的深度模板图像不写模板值；
  - 打包缓冲中行之间的填充与跳过的字节被写成 0（GL 保留原值）；
  - 由 GPU 写过的缓冲作解包源（`glTexImage*` 从 PBO）还不支持，计在 `stats.gles3`；
  - 没有 `texture-compression-etc2` 的设备只能解 ETC1 子集；没有 `texture-component-swizzle` 的设备不做 swizzle；
  - 一个阶段超过 12 个 uniform 缓冲（12 个块加默认块）时，WebGPU 的默认限制不够，改成只读存储的那一步还没做。

### L4 ES 3.0 的验收与宣告

- **宣告**：宿主宣告 `ANDROID_EMU_gles_max_version_3_0`，启动属性 `ro.opengles.version=196608`，
  `ranchu_gles_version` 默认 `"3.0"`。
- **核对**：
  - `rcCreateContext` 的版本参数（见“现状”的“客体能发什么”）；
  - SurfaceFlinger 与 hwui 用哪个版本的上下文；
  - 开机时间与开机的批次数和 E3 相比。
- **dEQP-GLES3 子集**（`A32_ANDROID_DEQP`，用例表换成 `gles3-master.txt`），组成照 E4：
  - `state_query` 与 `negative_api` 全部收入；
  - 其余的 functional 每九个取一个；
  - 不收性能、压力与 `flush_finish`。
- **自建 APK**：`tests/a32/android/v86gles.c` 加 ES 3.0 的场景，用 `glReadPixels` 读点检查。

验收：
- 开机正常；
- dEQP-GLES3 子集在支持的用例中通过 ≥ 97%，`state_query` 与 `negative_api` ≥ 99%，没有崩溃或挂起；
- dEQP-GLES2 不比 L0 的基线差；
- 自建 APK 的点全对；
- 每个失败归类：修掉，或者记为偏差。

**L4 结论（2026-10-28）：完成**。dEQP 子集在 Android 7.1 上跑（`A32_ANDROID_DEQP_SUITE=gles3`，宿主宣告 3.0；客体的 EGL 不带
`EGL_KHR_create_context`，测试脚本给 system.img 的副本打补丁）：

- **dEQP-GLES3 子集**（5649 例：`state_query`、`negative_api` 全部，其余 functional 每九取一，加 5 个 EGL 的 info）：支持的
  5354 例中 5300 例通过（99.0%）；`state_query` 与 `negative_api` 1224 例中 1219 例（99.6%）；没有崩溃，没有挂起。分三次跑：
  `v86-gles3-deqp`（前 1650 例，笔记本睡眠打断）、`v86-gles3-deqp2`（其余，用 `A32_ANDROID_DEQP_RESUME` 接着跑）、
  `v86-gles3-deqp3`（之前失败的 341 例用最新代码重跑）。
- **dEQP-GLES2 子集**（E4，同一个 3.x 执行器：客体的 EGL 把 2.0 上下文建成宣告的最高版本）：2039 例中 2022 例（99.2%），比
  L0 的基线好。
- **自建 APK**：GLES 1.1、2.0、3.0、3.1 的场景全对（`v86-gles31-app2`、`v86-gles31-app3`）。
- **这一阶段跑出来并修掉的**（每个都有测试）：glslang 的上限从没设过（`gl_Max*` 都是 glslang 的默认）；6 字节的索引缓冲没上
  GPU；2.0 上下文其实是 3.x 的（未生成名字的绑定、2.0 的扩展名单）；1.00 的 overload 误判；`DEPTH_STENCIL_TEXTURE_MODE`
  与模板采样；整数纹理的 REPEAT（取模成了余数）；`textureSize` 的 lod；Metal 编译器的 `atan2(y, 0)` 与 `tanh`；非整块的 ETC2/EAC
  （GPU 解码）；shared 与 packed 的 uniform 块（glslang 按 std430 反射）；有实例名与实例数组的块没有绑定；RGB 格式的 alpha；只接
  模板的深度模板缓冲；越界的 blit；目标因子 `SRC_ALPHA_SATURATE`；丢弃光栅化时的清除；GL 的引发顶点（flat 变量取最后一个顶点）；
  `negative_api` 的错误码；模板掩码与 LOD 的查询换算。
- **剩下的 54 例**：
  - 偏差：常量颜色与常量 alpha 混用（G-70，10 例）；阴影采样的显式 LOD 与梯度（G-76，5 例）；宽点（G-64，1 例）；
  - `ubo.random` 20 例与 4 例实例数组的块（std140 的复杂布局：数组、嵌套结构、行主序矩阵的报告与读取，未查）；
  - `fragment_ops` 的随机与交互用例 5 例、`fbo` 的多重采样与深度模板 blit 3 例、`rasterization` 的多重采样点 1 例（未查）；
  - `state_query` 5 例（渲染缓冲的分量大小、立方体面的附着、`glGetInteger64v` 的元素缓冲绑定、变换反馈的起点与大小：在
    Node 里照 dEQP 的调用答得对，可能是客体库自己记账的值，未查）。

### L5 ES 3.1

- **内容**：影子（`gles31_state.js`）与执行器的计算、SSBO、图像、原子计数器、间接绘制、可分离程序与程序管线、
  顶点属性绑定、多重采样纹理、纹理 gather、没有附着的帧缓冲、`glGetTexLevelParameter*`、robustness。
- **宣告**：宿主宣告 `_3_1` 与 196609。

验收：
- dEQP-GLES31 子集的 ES 3.1 部分（只用到 3.2 扩展的组除外），目标同 L4；
- dEQP-GLES3 与 GLES2 不回退；
- 自建 APK 加计算与 SSBO 的场景。

粗估：3–4k 行。

**L5 结论（2026-10-29）：完成**（`35c69fb5`、`b4c6cd9f`、`6a45c0b8`、`0b64fc67`、`ce19e76d`、`e5945656`、
`bfdaefbf`、`6764a1cc`、`96faef9e`、`3997f4e6`、`7ea99cd5`）。宿主宣告 3.1（3.2 的宣告让 dEQP 去试客体库拒绝的几何与细分，见 G-68），
`A32_ANDROID_DEQP_SUITE=gles31`，组成照 L4（`state_query` 全收，其余 functional 每九取一），5254 例：

- **dEQP-GLES31 子集**：支持的 1924 例中 1913 例通过（99.4%）；`state_query` 599 例全过；负面用例 57 例中 56 例。先整跑一遍
  （`v86-gles31-deqp3`，旧代码，中途停下：间接调度的上传在打开的计算通道里做，整批命令作废，后面的结果都不可信），再用
  `A32_ANDROID_DEQP_RESUME` 接着跑（`v86-gles31-deqp4`），之后每修一轮只重跑没过的（`deqp5` 到 `deqp10`，带完整日志）。
- **两例让客体的 dEQP 进程退出**，没算在里面（用 `A32_ANDROID_DEQP_FILTER` 排除，否则同一批后面的用例都不跑）：
  `atomic_counter.layout.default_offset_set.get_dec.8_counters_5_calls_1000_threads`（读回约 480 KB 的结果缓冲时进程没了：
  第五次 map 没有对应的 unmap；宿主没有报错，客体的日志没有崩溃转储）与
  `debug.negative_coverage.get_error.buffer.invalidate_sub_framebuffer`（同样没有转储）。都是客体一侧的问题，未查。
- **这一阶段跑出来并修掉的**（每个都有浏览器或 Node 的测试）：
  - 原子计数器：glslang 不反射偏移（从代码那一遍的 `gl_AtomicCounterBlock_N` 取），宽松规则下的 `atomicCounterDecrement`
    是 uint 减 int（开隐式转换），naga 把不从 0 开始或倒序的偏移排错（vx_naga `counters.rs` 摊成一个 uint 数组）；
    `GL_OFFSET` 答成 -1，dEQP 从映射的前一个字节读出 447；绑定点只有一个（dEQP 绑在 1）。
  - SSBO：块的实例数组只在 SPIR-V 绑定 19 以内拆开（VX 的编码，WebGPU 只有 1000 个绑定），之后的存储块与 uniform 块数组都
    没拆（GLES 的模块打 `OpModuleProcessed` 标记，元素 e 用绑定 b + e）；拆开后留下的数组类型 naga 拒绝声明；`layout.rs`
    只做了读，写 std140 的 16 字节元素与行主序矩阵的模块原样交给 naga（现在逐分量写，留着补齐的字节）；不定长数组；
    `MATRIX_STRIDE`（glslang 不反射）、只给矩阵的 `IS_ROW_MAJOR`、不定长数组的 `ARRAY_SIZE` 0、顶层成员的
    `TOP_LEVEL_ARRAY_SIZE`/`STRIDE`；`writeonly` 块（naga 拒绝 NonReadable）。
  - 执行器：在打开的通道里上传间接参数，整批作废；`glBufferData` 不认 3.1 的目标，GPU 副本留着旧字节；没有绑定的可写存储
    写进了大家读的全零缓冲；采样器单元卡在 31；同一调度里对同一资源的可写别名（G-79）。
  - 图像：立方体图像（`imagecubes.rs`，面当二维数组的层）；格式重解释与 3D 纹理的一层当二维图像（代理纹理，拷进拷回）；
    naga 写的 `@coherent`/`@volatile`；`gl_HelperInvocation`（naga 不认，取 false，G-78）。
  - 程序：可分离程序的输入与输出（glslang 加 `EShReflectionIntermediateIO`，重新链接了 `bios/glslang.wasm`）；程序管线校验
    两个方向都对接口；采样器与图像的 `layout(binding)`；变换反馈抓数组元素与结构成员（在 `main` 之后拷到自己的输出）；
    `uniform_location`：数组的数组、结构成员与只在一个阶段声明的位置（glslang 都不给）。
  - 其余：`bitCount`/`findLSB`/`findMSB` 的结果类型（`negate.rs`）；3.1 的最小限制（48 个纹理单元、1024 个片段 uniform
    分量、36 个 uniform 缓冲绑定点）；`glGetBooleani_v`；多重采样纹理的参数；`VERTEX_BINDING_STRIDE` 的初值。
- **剩下的 11 例**：
  - 偏差：同一调度里对同一资源的可写别名（G-79，2 例）；采样数一律 4（G-80，1 例）；
  - `ssbo.layout` 7 例：带不定长数组的结构的实例数组 3 例（翻译得出，执行结果不对，未查）、`random` 4 例（其一是 dEQP
    要的 `BlockE` 不在反射里）；
  - `ubo.random` 1 例：std140 嵌套结构里的 `mat4x2 mA[3][3]`，两个阶段都翻译得出，没有 WebGPU 错误，像素全错，未查。
- **自建 APK**：3.1 的计算与 SSBO 场景在 L4 已加且全对。
- **回归**（宿主宣告 3.1，GLES3 与 GLES2 的上下文都是 3.1 的）：
  - dEQP-GLES3 子集：支持的 5384 例中 5359 例通过（99.5%，L4 是 99.0%）；`state_query` 与 `negative_api` 1224 例全过；
    和 L4 比没有新的失败。整跑（`v86-gles3-l5-regress`）先跑出 40 例新的失败，修在 `7ea99cd5` 后重跑
    （`v86-gles3-l5-regress2`）：带 flat 变量又被变换反馈抓的绘制没按 GL 的引发顶点画（G-77，dEQP 比较抓与不抓的两张图）；
    删掉的纹理还挂在没绑定的帧缓冲上时，同名的新纹理被画进去（现在留作孤儿）；深度模板纹理的模板写一个矩形
    （WebGPU 只拷整层，现在经缓冲由计算通道改）；顶点输入超过 16 个位置的链接（现在报错）。剩下 25 例：G-70 10 例、
    G-76 5 例、G-64 1 例，其余是 L4 已列的 `fragment_ops`、`fbo`、`ubo.random` 与 `rasterization`。
  - dEQP-GLES2 子集：2039 例中 2023 例（99.2%），比 L4 多修好 10 例；整跑里唯一新的失败
    （`fbo.render.color.mix_tex2d_rgba_depth_component16`）单独重跑通过。

**L5 之后（2026-10-29）**：上面没查的 8 例（GLES31 的 `ssbo.layout` 7 例、`ubo.random.all_shared_buffer.37`，加上 GLES3 的
`ubo.random.nested_structs.22`）查完并修掉；扩大重跑（`ssbo.layout` 的实例数组与 `random` 全部、`ubo.random` 全部，不抽样）
又找出同一类的 10 例，也修掉了。都是反射与代码对不上，或 vx_naga 把留下的类型交给 naga：
- **块的实例数组**：glslang 只把缓冲变量（uniform 块的 uniform）挂在数组的第一个元素上，`Block[1]`、`Block[2]` 的
  `ACTIVE_VARIABLES` 是空的。dEQP 照每个元素自己的变量找不定长数组的步长来定缓冲大小，后两个元素的缓冲于是只放得下
  一个元素（不定长结构数组的实例数组 3 例，`random` 3 例）。现在每个元素都列出数组的变量（`gles31_state.js`、
  `glsl_program.js`）。
- **没用到的 shared 缓冲块**：GL 里它照样是活的，但 `std_blocks` 把它改成 std430 之后，glslang 的
  `EShReflectionSharedStd140SSBO` 只管 std140 与 shared，反射里就没有它（dEQP 要的 `BlockE`，`random.nested_structs_arrays.8`）。
  检查那一遍现在拿缓冲块原来的布局（glslang 的反射把 shared 与 packed 按 std430 排，和代码那一遍一样）。
- **默认语句给的 std140**：块自己不写布局、靠 `layout(std140) uniform;` 时，glslang 的反射把块里结构的数组与矩阵按 std430
  排（`mat4x2 mA[3][3]` 的步长 32、行主序的 `mat2x3` 24 字节），代码那一遍的 SPIR-V 却是 std140 的。dEQP 照反射写数据，
  着色器读到的全错（`ubo.random.all_shared_buffer.37` 与 GLES3 的 `nested_structs.22`）。`std_blocks` 现在把布局写到每个块上。
- **vx_naga 留下的类型**：`blockarrays.rs` 拆开块数组、`layout.rs` 换掉块的类型之后，判断原来的指针与数组类型还有没有人用时
  连字面量也算了进去（成员偏移 16、整数类型的宽度 32 恰好等于指针类型的 id），留下的 `array<Block, 3>` 或指向不定长结构的
  Uniform 指针 naga 拒绝声明，整个着色器建不起来；哪个着色器碰上只看 id 怎么排。现在两处都只看 id 的位置（`names()`）。
  这让 `2_level_unsized_struct_array.*_instance_array` 8 例与 `random.nested_structs.3`、`nested_structs_instance_arrays.19`
  失败（后一例在早先的整跑里过了，L5 后面的改动让 id 换了位置）。元素的 `length()`（`OpArrayLength`）也让块数组整个不拆，
  现在照拆。
- **测试**：`tests/gles/shadow31.mjs`（实例数组每个元素的变量、没用到的 shared 块、std140 缓冲块与 uniform 块里结构的偏移）、
  `shadow3.mjs`（默认布局的 uniform 块，偏移与 SPIR-V 的一致）、`shader_corpus.mjs` 自己的 4 例（在改之前的 vx_naga 上都
  建不起来）、`gles3_executor_browser_test.html`（不定长结构数组的实例数组：各元素的长度与写入）。
- **重跑**：dEQP-GLES31 子集整跑（`v86-gles31-fix3`）支持的 1929 例中 1926 例通过（99.8%），剩下 G-79 2 例、G-80 1 例；
  不抽样的 743 例全过（`v86-gles31-fix4`）。dEQP-GLES3 子集（宿主宣告 3.1，`v86-gles3-fix5`）5349/5384，`nested_structs.22`
  通过；比 L5 多出的 11 例失败都是早就有的时有时无的问题，单独重跑（`v86-gles3-ff2`，同样 12 例同样次序）全过：
  - `flush_finish.flush` 压 GPU（标定到 556 次绘制、每个像素 1024 次 `sin`）时 Chrome 的 WebGPU 设备有时丢失，之后这个
    客体的绘制全是空的（紧跟着的 `default_vertex_attrib` 9 例）。改动前也有：L4 的 `v86-gles3-deqp2`、`deqp3` 一样是
    flush_finish 后 9 例全错。这次四次里丢了两次，改动前的代码两次没丢；两边 flush_finish 的 WGSL 一样。渲染页
    （`gles_remote_renderer.html`）现在把设备丢失的原因写进日志。没有恢复丢失的设备。
  - `state_query.shader.current_vertex_attrib_float_to_int`：不是偶然，整跑里它前面是 `_int`、`_uint`（同一个 dEQP 进程），
    单独重跑才过。见下一条。
- **当前值属于上下文**（GLES 3.0 表 6.6）：3.x 上下文里 `glVertexAttribI4*` 记进上下文的当前值，浮点的 `glVertexAttrib*f`
  却用的是 GLES 2.0 的处理，只改顶点数组里的那份，查询先看上下文的，于是答出前面整数形式的值。现在浮点形式也记进上下文
  （`gles3_state.js`）。页上的绘制同样只看绑着的顶点数组：在别的顶点数组下设的当前值，换了顶点数组就没了，现在取上下文的
  （`gles3_executor.js` 的 `vertex_plan3`）。测试：`shadow3.mjs`（整数形式之后的浮点形式，换顶点数组后再查），
  `gles3_executor_browser_test.html`（关掉的属性取另一个顶点数组下设的当前值来画）。
- **比 WGSL 类型的最小大小短的范围**（最后一个成员是长度为 0 的不定长数组，或范围停在最后一个元素的补齐里）：存储块与
  uniform 块原来都绑一块全零（写进丢弃的缓冲）；现在照最小大小绑缓冲本身的内存，范围在缓冲末尾时把 GPU 缓冲加长
  （`storage3`、`block3`，偏差 G-81：这时的 `length()` 数的是那个大小放得下的元素）。测试：浏览器测试的整个 16 字节的
  缓冲与缓冲末尾 16 字节的范围。
- **这两处之后的重跑**：dEQP-GLES3 的 `ubo`、`state_query`、`default_vertex_attrib`、`vertex_arrays`、`draw`、`instanced`、
  `attribute_location`（抽样，`state_query` 全收，`v86-gles3-fix7`）1344 例全过，`current_vertex_attrib_float_to_int` 紧跟在
  `_int`、`_uint` 后面也过；dEQP-GLES31 的 `ssbo`、`ubo`、`compute`、`atomic_counter`、`synchronization`、`image_load_store`、
  `draw_indirect`、`layout_binding`、`program_uniform`、`shaders.opaque_type_indexing`（抽样，`v86-gles31-fix8`、`fix9`）
  只剩 G-79 的 2 例，不抽样的 743 例全过。

### L6 ES 3.2（线上能到的）

- **几何与细分**：SPIR-V 预处理加 `stages.rs`；顶点的计算版本；几何的记录与绘制；GX 细分器的接入；细分接几何。
- **其余**：ASTC（直传或解码）、立方体贴图数组、边框颜色（`border.rs`）、高级混合（`blend.rs`）、采样着色与采样
  变量（`sample.rs`）、按目标的混合与遮罩、KHR_debug 的查询值。
- **宣告**：宿主宣告 `_3_2` 与 196610，`GL_VERSION` 为 `OpenGL ES 3.2 v86`，`GL_SHADING_LANGUAGE_VERSION` 为
  `OpenGL ES GLSL ES 3.20`。
- **偏差**：够不到的入口与 WebGPU 做不到的，写进 gpu-deviations（改 G-68，新增条目）。

验收：
- dEQP-GLES31 子集中 3.2 的组（`geometry_shading`、`tessellation`、`texture.border_clamp`、`blend_equation_advanced`、
  `sample_shading`、`sample_variables`、`texture.texture_cube_map_array` 等）：每个失败要么修掉，要么归到偏差，而且
  原因写明是客体缺入口还是 WebGPU 做不到；
- 其余组不回退；
- 自建 APK 加几何与细分的场景。

粗估：5–7k 行，其中 naga pass 3–4k。

**L6 结论（2026-10-28）：完成**（`28e76316`、`6d879a24`、`00a5bb9d`、`eaf9801f`、`7eacf3c6`、`31823aef`、`7ff6dda7`）。
线上能到的 3.2 都做了：

- **客体能用到的**（同日自建 APK 在 3.2 宿主上探测，`df0ac8e5`）：Android 7.1 的 GLES 库自己检查枚举，只认到 3.1：几何与细分着色器的
  `glCreateShader`、立方体贴图数组的 `glBindTexture` 在客体里就被拒（`INVALID_ENUM`，宿主收不到）；`TEXTURE_BORDER_COLOR`
  到了宿主、颜色也设上了，但库报 `INVALID_ENUM`。客体能用的是高级混合、`CLAMP_TO_BORDER`、GLSL ES 3.20 的着色器（采样变量）与
  ASTC。几何、细分与立方体贴图数组在宿主上做好了、浏览器测试覆盖，但这个客体用不上（留给库更新的客体）。所以默认宣告 3.1
  （“已定”第 6 条），G-68 写明。

- **立方体贴图数组与 ASTC**：`cube-array` 视图；ASTC 在设备有 `texture-compression-astc` 时直传（这台 Mac 有）。3.2 的
  状态值、上限与开关照规范的最小值回答（KHR_debug 的初值；它的入口不在线上）。
- **几何着色器**：vx_naga 的 `geometry.rs` 把几何阶段的 SPIR-V 改成计算着色器（输入输出成私有变量，`EmitVertex`、
  `EndPrimitive` 成函数调用），一个输入图元与调用一个 invocation，条带写成列表（GL 的引发顶点放在第一个，WebGPU 的
  `flat` 取第一个），没写满的槽在裁剪体外；列表经生成的直通顶点着色器与片段着色器画。顶点着色器先当计算着色器跑，
  全部输出写进记录（`xfb.rs` 的 `all` 模式）。图元在 CPU 上组装，带邻接的线与三角形按表 10.1；没有几何着色器时
  丢掉邻接顶点再画。
- **细分**：`tessellation.rs` 把控制着色器改成一个 patch 一个工作组（输出在工作组内存，`barrier()` 是带工作组内存的
  工作组屏障），评估着色器一个点一个调用；中间是 GX 的 D3D11 细分器（`tessellator_wgsl.js`），评估用间接分派，画用
  间接的带索引绘制。线上没有 `glPatchParameteri`，patch 固定为 GL 默认的 3 个顶点。GL 的 `equal_spacing` 对应 D3D 的
  integer 划分，GL 的顶点顺序与 D3D 的相反（测试里剔除背面核对了）。
- **采样变量与多重采样插值**：`gl_SampleMask(In)` 的类型（`samplemask.rs`）；centroid 与 sample 插值（`sampling.rs`：
  naga 的前端在没有插值修饰时把它们改成中心；页面让顶点输出的插值跟片段输入一致）；`gl_SamplePosition` 与
  `interpolateAt*` 在代码那一遍改写成 `gl_SampleID`、标准 4x 位置（样本数是特化常量 71，管线给）与导数。
  `glMinSampleShading` 不在线上，`GL_SAMPLE_SHADING` 开着也没有效果。
- **边框颜色**：`border.rs` 在 `split` 之后给夹到边框的浮点采样加一个选择：坐标在边框轴上出了 [0, 1) 就取边框色。边框色
  与轴作为翻译的常量经 wraps 列表传（Vulkan 的 clamp to border 写在轴的半字节里，颜色带标记），翻译按状态缓存。最近
  过滤准确，线性过滤在边上不与边框色混合。
- **高级混合**：代码那一遍改写声明了 `blend_support_*` 的片段着色器：颜色输出变成变量，在着色器里按方程（特化常量
  72）与绘制前拷出的目标（`_v86_dst`）混合，管线不混合。每次绘制拷一次，所以一次绘制内重叠的图元用的是绘制前的目标
  （非 coherent 扩展允许的结果）；线上没有 `glBlendBarrier`，绘制之间也不需要。顺带修了 3.0 的 `MIN`/`MAX`（之前被拒）。
- **够不到的**（线上没有入口，见 gpu-deviations 的 G-68）：按目标的混合与写入遮罩、纹理缓冲、`*BaseVertex` 绘制、分层
  帧缓冲（`glFramebufferTexture`）、`glTexStorage3DMultisample`、`glCopyImageSubData`、KHR_debug 的入口、
  `glPrimitiveBoundingBox`。
- **测试**：`gles3_executor_browser_test.html` 69 项（加了几何、细分、采样变量、边框、高级混合与快照恢复后的几何程序），
  `shadow31.mjs` 覆盖 3.2 的程序查询、模式与错误。VX 的 Venus 语料（748 个着色器、1391 条管线）不变。
- **还没做**：细分之后的几何着色器、几何与细分输出的变换反馈、可分离程序里的几何与细分阶段、patch 的间接绘制、
  `gl_Layer`、片段的 `gl_PrimitiveID`。dEQP-GLES31 中 3.2 的组等 L5 的那次运行。

### L7 快照、性能、界面与文档

- **快照**：GPU 缓冲读回，3D、数组与多重采样纹理（多重采样的内容不保存，恢复后为已清除，同 G-69 的深度），查询与
  变换反馈的状态，程序管线。
- **性能**：
  - CPU 侧：glslang 的耗时、影子状态每次调用的耗时（`stats.cpu_ms`）；
  - 页面：管线与 vx_naga 的缓存命中、顶点转换的次数；
  - 一个 ES 3.0 的游戏或基准程序的帧率。具体程序 L4 选，开源而且有 armeabi-v7a 构建，下载前征得同意。
- **界面**：VM 配置加 `android.gles_version`（模拟器镜像在 `"host"` 模式下才有），默认取已验收的最高版本；设置面板
  与摘要随之更新；`make app-tests` 加用例。
- **文档**：[arm32.md](arm32.md)、[gpu-devices.md](gpu-devices.md) 的 GLES 一节、[gpu-deviations.md](gpu-deviations.md)。

验收：
- 快照往返后画面与状态一致；
- 性能数据写进文档。

**L7 结论（2026-10-28）：完成**（`e0f22269`、`4df322f3`、`85fea08b`、`72552f19`、`fcd23edf`、`d8369e19`）：

- **快照**：页面的保存读回 GPU 写过的缓冲（存储写入、变换反馈、拷贝、打包缓冲），恢复时 GPU 缓冲从这些字节建起；
  多重采样纹理不存（WebGPU 拷不出来，之前一张就让整个保存失败）；遮挡查询的结果放在影子的查询对象上（之前按对象 id
  存，恢复后丢失）；glslang 的程序在恢复时按链接时的绑定、可分离与变换反馈变量重新链接。`snapshot.mjs` 有 3.1 宿主的
  往返，浏览器测试有页面上 3.x 上下文的往返（缓冲、遮挡、立方体贴图数组、程序管线、几何程序）。
- **界面**：VM 配置的 `android.gles_version`（2.0 到 3.2，默认 `DEFAULT_GLES_VERSION`，只在 `"host"` 时传给模拟器），
  Android 面板的选择与摘要；`make app-tests` 的配置与预设测试。默认是 3.1（见“已定”第 6 条），3.2 可选。
- **性能**（这台 M1 Pro，`gles_replay_stats_browser_test.html` 重放录下的批次）：
  - 3.0 的开机（glslang 路线）：649 批、13.4 MB，页面 733 ms（每批 1.1 ms，最慢 58 ms）；1679 次绘制、19 条管线、
    27 次 vx_naga 翻译共 29 ms；客户端数组在 CPU 上组装 2439 次、索引列表 743 次（hwui 用客户端数组）。
  - 早先 2.0 的开机（旧翻译器路线）：478 批、10.8 MB，页面 2093 ms（每批 4.4 ms，最慢 633 ms：旧翻译器的着色器转换）。
  - CPU 侧（`gles.json`）：开机 27351 次调用，打批次共 900 ms，glslang 编译 62 个着色器、链接 31 个程序共 251 ms。
- **文档**：arm32.md、gpu-devices.md 的 GLES 一节、gpu-deviations.md 的 G-67 到 G-75。
- **帧率**（所有者定：不下载，用自建 APK 里的 ES 3.0 场景）：`v86gles.c` 的 `fps_scene`，49 个带光照与纹理的立方体
  （顶点数组对象、交错的顶点与索引缓冲、每帧写的 uniform 块、采样器对象下的 mipmap 纹理、深度测试），交换间隔 0；
  先用一次实例化绘制，再每个立方体一次绘制（49 次）。热身 5 帧后计 100 帧，用客体的时钟计时，按时钟比例（0.1）换成
  宿主的时间；结果写进运行目录的 `fps.json`。旁边跑着另外两个 Android（这台 M1 Pro）：
  - 一次实例化绘制：88–131 帧/秒（两次运行之差是机器上别的负载）；
  - 每帧 49 次绘制：83 帧/秒，比一次绘制只慢约 0.7 ms 一帧（每次绘制约 15 µs，客体编码、影子与页面合计）。
  - 宿主让客体等的次数：866 批中 2 次（`throttled`），页面跟得上；一帧约 11 ms 宿主时间花在客体每帧的路径上
    （交换经 SurfaceFlinger 的缓冲队列、编码器、管道），不在页面。客体的 vsync 按 0.1 的时钟是每秒 6 帧，所以
    界面与普通应用（间隔 1）仍封顶 6 帧/秒（gles-proxy-plan 的 E7）。

## 测试

| 层 | 位置 | 运行方式 |
| --- | --- | --- |
| 共用翻译器的 ES 模式 | `tests/glbridge/` 的新用例（Tint 在浏览器测试里） | `make test-glbridge`、`make display-browser-tests` |
| glslang 的两遍、反射、location 与装饰 | `tests/gles/glslang.mjs` | `make gles-tests` |
| 着色器语料：glslang → vx_naga → WGSL，经 naga 验证 | `tests/gles/shader_corpus.mjs` | `make gles-tests`（naga 不在时跳过，同现有做法） |
| 同一语料经 Tint 验证 | `tests/glbridge/gles_shader_browser_test.html` | `make display-browser-tests` |
| ES 3.0/3.1/3.2 的影子状态 | `tests/gles/shadow3.mjs`、`shadow31.mjs` | `make gles-tests` |
| 执行器的场景与像素 | `tests/glbridge/gles_executor_browser_test.html` | `make display-browser-tests` |
| vx_naga 的新 pass；VX 不变 | `src/browser/glbridge/vx/naga` 的单元测试，加上现有的 VX 语料 | `cargo test`，以及 `make test-glbridge` |
| Android 7.1：开机、dEQP-GLES2/3/31 子集、自建 APK | `tests/a32/android_boot.mjs` 及其 `A32_ANDROID_*` 开关 | 手动 |

`make gles-tests` 已经在 `make ci-tests` 里，新的测试跟着它进 CI。glslang 的 wasm 要像 `vx_naga.wasm` 一样在 CI 里
构建，或者作为固定的构建产物检入；L1 决定用哪种。

## 风险

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| glslang 的宽松模式不合 GL 的语义（默认 uniform 的布局、location、反射的名字） | 着色器路线不成立 | L1 先验证；不成立就转附录 B，影子状态照用 |
| 300 es 覆盖成 310 es 时语义有差别（310 新增的关键字、内建与用户标识符冲突） | 合法的 300 着色器在第二遍失败 | 第一遍按 300 检查；第二遍之前重命名冲突的标识符；语料覆盖 |
| GLSL ES 1.00 打印成 310 有差错 | ES 2.0 回退 | L1 的比较；不行就保留现有翻译器，执行器支持两种模型 |
| glslang 的 wasm 大、编译慢 | 插件变大，新画面卡顿 | L1 测量；只编需要的部分；只在 `ranchu_gpu: "host"` 时装载 |
| varying 打包：GL 按分量计数，`io.rs` 拆开后每个数组元素占一个 location | 合法的着色器超出 WebGPU 的 16 个 location | vx_naga 加一个打包 pass，或者把限制报低；dEQP 的 varying 上限用例检验 |
| naga 不读几何与细分的 SPIR-V | 3.2 的主要部分做不了 | L1 做可行性；SPIR-V 预处理加 naga pass；不行就在 glslang 之前改写源码 |
| 缓冲映射要等页面 | 读取 GPU 结果的应用卡顿 | 镜像是最新的就不等；只在 GPU 写过之后等 |
| 宣告 3.2 后，客体调用够不到的入口 | 应用走到桩上，画面不对 | 记为偏差；`ranchu_gles_version` 可以把宣告压回 3.1 |
| vx_naga 的改动影响 VX | Android 16 的 Venus 与 gfxstream 回退 | 新 pass 都由选项打开；VX 的语料与 dEQP 抽样作为回归 |
| 执行器的改动影响已有的 ES 2.0 | Android 7.1 的界面回退 | E3 的批次重放与开机截图，加上 dEQP-GLES2 基线 |

## 已定（2026-10-28）

1. **范围**：ES 3.0、3.1 完整；3.2 只做现有操作码能表达的部分；宣告 3_2，缺的 3.2 入口记为偏差。所有者选的是
   “3.0+3.1 全做，3.2 做线上能到的”。
2. **先写计划**，审过再逐步实施。
3. **E3–E6 的改动**先提交成 `ios6` 上的基线，即 `a17140ed`。
4. **后端**：扩展 E3 的执行器，直接生成 WGSL；着色器先验证 glslang → SPIR-V → vx_naga，验证不通过再退回 GX 路线
   （附录 B）。所有者问过两条路线的性能差别，答复见“性能预期”。
5. **L7 的帧率**：不下载游戏或基准程序，用自建 APK（`tests/a32/android/v86gles.c`）里的一个 ES 3.0 场景。
6. **默认版本**：宿主默认宣告 3.1，3.2 可选（`android.gles_version`）。2026-10-28 自建 APK 的探测表明 Android 7.1 的 GLES
   库自己拒掉几何与细分着色器、立方体贴图数组（宿主根本收不到），边框颜色报错；宣告 3.2 只会让以 3.2 核心为前提的程序
   （dEQP-GLES31）去试这些然后失败（gpu-deviations 的 G-68）。所有者同意默认 3.1、可选 3.2。

## 待定（有默认值，所有者可改）

1. **`ranchu_gles_version` 的默认值**：已定为 `"3.1"`（见“已定”第 6 条）。
2. **glslang 的来源**：固定一个上游的发布版，源码下载到 `build/`，下载前征得同意。wasm 是在 CI 里构建还是检入，L1
   决定。
3. **CTS 的用例表**：`gles3-master.txt`、`gles31-master.txt`，按字节范围从已用过的 CTS 7.1_r29 包里取，下载前征得
   同意。
4. **GLSL ES 1.00 也走 glslang**：由 L1 的数据决定，默认“是”。

## 附录 A：翻译器的评估（2026-10-28）

`gl_shader_translator.js`（5308 行）对照 GLSL ES 3.00、3.10、3.20 的逐项结论。探测用 naga 30 与 Chrome 的 Tint 跑
真实输出，没有改仓库。

- **有的**：非方阵矩阵、`transpose`/`outerProduct`、整数的 `abs`/`sign`/`min`/`max`/`clamp`、十六进制字面量、整数的位
  运算与 `%`、`sampler3D` 与 `sampler2DShadow`、`invariant`。
- **部分有的**：`gl_FragDepth`（ES 模式丢掉）、`.length()`（被拒）、数组赋值（有）与数组比较（没有）、全局的
  `in`/`out`（能解析，但悄悄变成私有全局变量）。
- **3.00 没有的**：`uint` 与 `u` 后缀、`layout(...)`、`flat`/`smooth`、`switch`、数组构造、多个片段输出、整数的属性
  与 varying、`texture()` 一族与 `textureSize`、`sampler2DArray`、`samplerCubeShadow`、`isampler*`/`usampler*`、
  uniform 块、`gl_VertexID`/`gl_InstanceID`、变换反馈。
- **3.10 与 3.20 的内容一项都没有。**
- **它的设计**：
  - 每个程序在链接时生成一次 WGSL，只有 `vs_main` 与 `fs_main`；
  - uniform 都在一个私有的 `GLUniforms` 块里，每个成员按 16 字节对齐，不是 std140；
  - varying 按名字贪心地打包进最多 16 个 `vec4<f32>`。
- **估计**：扩到 3.00 加 3.5–4.5k 行；3.10 再加 3–3.5k；3.20（几何与细分降级成计算）再加 4.5–6k；执行器另计。重写
  一个前端到 3.2 要 16–20k 行，并不更省。
- **建议**：先修已有的错误；不往 3.00 以上扩；3.x 先验证 glslang 接 vx_naga（被本计划采纳）。

## 附录 B：退路（virgl → GX）

L1 不通过时采用。CPU 侧做两件事：
- 把 GL ES 的状态翻成 virgl（Gallium）的命令，交给一个内嵌的 `Virgl` 设备侧（`src/graphics_adapters/virtio_gpu/
  virgl.js`）。它管资源、传输、快照与呈现，吃 virgl 的命令字，产出 GX 批次；
- 自己写 GLSL ES → TGSI 的后端，接 `tgsi_vgpu10.js`。

页面只跑 GX。

- **现成的**：几何、细分、流输出、计算、UAV、顶点拉取、多重采样（超采样）、间接绘制、查询，Linux 客体靠它们跑
  GL 4.3 与 GLES 3.1。
- **要补的**：
  - GX 缺的 3.2 部分：ASTC、高级混合、边框颜色、`imageSize`、细分后接几何、`interpolateAt*`、有符号的原子最小值和
    最大值。补上后 Linux 的 virgl 也能报 GLES 3.2；
  - ES 2.0 与 1.1 也迁过去，E3 的页面执行器在新路径达到同样效果后退役。
- **代价**：
  - GLSL ES → TGSI 的编译器是这条路最大、最险的一块；
  - GX 的 WGSL 是寄存器机风格，体积大、变体多，管线编译更慢；
  - 多重采样是超采样。

L0 与 L2 在两条路线上都用得上。
