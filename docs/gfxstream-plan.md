# gfxstream 实施计划

状态：设计与实施计划，尚未实现。2026-10-23 初稿，基于 `c5debe9a`。规模：S 为几天，M 约 1–2 周，
L 约 3–4 周，XL 超过一个月（与 [ARM64 virt 与 Android 16 计划](arm64-virt-android16-plan.md) 相同）。

本计划为 v64 的 virtio-gpu 增加 gfxstream：Android 模拟器和 Cuttlefish 把客体的 Vulkan（以及
渲染控制、合成）转发到宿主 GPU 用的协议。目标是**不修改**官方镜像也能用 GPU 绘制 Android 16：
Cuttlefish 官方镜像，以及搭配 Cuttlefish vendor 的官方 GSI（例如 `aosp_arm64-exp-BP2A.250605.031.A3`）。
现在的 Venus 路线要往 odm 注入我们编译的 Mesa venus 驱动、改写 odm 的 hash tree 与 vbmeta，再用
`initrd-venus.img` 改几个 bootconfig 键（[aarch64.md](aarch64.md)、[tools/a64_android.mjs](../tools/a64_android.mjs)
117–120、898–911）；gfxstream 用的是 Cuttlefish vendor 里本来就有的客体驱动。

Venus 不撤：它服务 Linux 客体的 Mesa venus，也是 gfxstream 完成前 Android 的路线。两者共用
Vulkan 模型与 VX 执行器（Vulkan 到 WebGPU），只是前端协议不同。

## 结论

1. **为什么非 gfxstream 不可**：官方 vendor 的 GPU 栈只有两种客体驱动（2026-10-23 核对
   `build/a64-android/rootfs.tar`）：`/apex/com.google.cf.vulkan/lib64/hw/vulkan.ranchu.so`（gfxstream）
   与 `vulkan.pastel.so`（SwiftShader）；EGL 是 `libEGL_emulation`（gfxstream 的 GLES 编码器）或系统里的
   ANGLE；合成器 APEX `com.android.hardware.graphics.composer.ranchu` 链接 `lib_renderControl_enc` 与
   `libOpenglSystemCommon`。SwiftShader 在 v64 上画不出 Launcher3（38 分钟仍未绘制，A9 记录）。不改镜像
   又要能用，只能在宿主一侧实现 gfxstream。
2. **只做 Vulkan 一侧，不做宿主 GLES**：Cuttlefish 的 `gfxstream_guest_angle` 模式让客体的 ANGLE 把
   GLES 翻译成 Vulkan，再经 gfxstream 的 Vulkan 编码器送到宿主。宿主只需 Vulkan 解码、渲染控制
   （renderControl）的一个子集与合成。gfxstream 的 GLES 转发（`libGLESv2_emulation` 的编码流）要在宿主
   实现 GLES 1/2/3，在 WebGPU 上代价极大，不做。
3. **配置是官方的**：选哪种 GPU 模式由启动参数决定（`androidboot.hardware.vulkan`、`egl`、`hwcomposer`、
   `hwcomposer.mode`、`gltransport` 等，经 vendor 的 `init_graphics.vendor.rc` 映射成 `ro.hardware.*`），
   这些键本来由 Cuttlefish 的启动器写进 bootconfig。v64 照启动器在 `gfxstream_guest_angle` 下写的值写，
   不改任何分区。
4. **版本跟着 vendor 走，不跟 GSI**：gfxstream 的客体库在 vendor（APEX `com.google.cf.vulkan`、
   vendor 的 `lib*_enc`），GSI 只换 system。宿主解码器固定到 Cuttlefish vendor 构建（15581820，
   `android16-qpr2-release`）对应的 gfxstream 版本即可，换 GSI 不影响协议。
5. **复用 Venus 已有的部分**：host-visible 内存（BAR4、脏页上传与回读，`virtio_gpu_device.js` 1014–1084）、
   blob、CONTEXT_INIT、渲染器通道与 VX、快照里重放 VX 命令的做法都已具备。新的是传输（ASG 环）、
   gfxstream 的 Vulkan 编码、渲染控制与颜色缓冲、按环的围栏。

## 现有基础（2026-10-23，`c5debe9a`）

| 部分 | 位置 | 对 gfxstream 的意义 |
| --- | --- | --- |
| virtio-gpu 设备、级别、capset 表 | [virtio_gpu_device.js](../src/graphics_adapters/virtio_gpu/virtio_gpu_device.js) `LEVELS` 58–77、capset 列表 360、GET_CAPSET 760–781 | 新级别 `gfxstream` 与新 capset 在这里声明 |
| CONTEXT_INIT 分派 | 同文件 `command_3d` 1388–1402 | 按 capset 建上下文，现为 virgl 与 Venus 两种 |
| SUBMIT_3D | 同文件 1449–1472 | gfxstream 上下文命令（建上下文、ping、同步导出）从这里进来 |
| 围栏 | 同文件 `notify`/`enqueue`/`drain`/`respond` 530–663 | 现在全部按控制队列顺序完成，没有按环的围栏队列；gfxstream 依赖按环的时间线（见 G1） |
| blob 与映射 | 同文件 `create_blob` 897–932、`map_blob` 938–975 | ASG 环与 host-visible 的 Vulkan 内存都是 HOST3D blob |
| host-visible 内存 | 同文件 207–214（venus 级 128 MiB）、386–412（BAR）、1014–1084 | 直接复用；环的读取与 Venus 的 `run_ring`（[venus.js](../src/graphics_adapters/virtio_gpu/venus.js) 557–601）同理 |
| Vulkan 模型 | [venus_vk.js](../src/graphics_adapters/virtio_gpu/venus_vk.js)、`venus_vk_resources.js`、`venus_vk_commands.js`、`venus_vk_pipeline.js`（共约 2600 行，125 个处理函数） | 对象、提交、等待、内存镜像、快照记录；要拆成与协议无关的模型，两种前端共用 |
| 设备能力 | [venus_device_info.js](../src/graphics_adapters/virtio_gpu/venus_device_info.js) | Vulkan 1.1、WebGPU 的限制与格式；gfxstream 前端报同一组能力 |
| 渲染器与 VX | [renderer_protocol.js](../src/graphics_adapters/renderer_protocol.js)、[svga_renderer.js](../src/browser/glbridge/svga_renderer.js)、[vx_executor.js](../src/browser/glbridge/vx/vx_executor.js)（2819 行）、naga（SPIR-V 到 WGSL） | 不改协议即可复用；ANGLE 在 VX 上目前得到 GLES 3.0（[gpu-deviations.md](gpu-deviations.md) 98） |
| 显示 | `set_scanout_blob`、`present`、`render`（1090–1206、1602–1676） | 客户端合成走现有的 KMS 路径；每次 3D 呈现都要回读（G-31），是性能瓶颈 |
| 协议生成 | `tools/venus_protocol_gen.mjs`、`venus_protocol.js`（15133 行，Mesa 26.1.6） | gfxstream 的编码同样从代码生成器的输入生成 |
| 测试 | `tests/devices/virtio_gpu_venus.js`（假 VX 渲染器）、`tests/x64/gpu_remote_renderer.mjs`（无头 Chrome 里的真渲染器）、`tests/a64/android_boot.mjs`（`A64_ANDROID_GPU=venus`） | 各加 gfxstream 的对应用例 |
| 未声明 | [third_party/virtio/virtio_gpu.h](../third_party/virtio/virtio_gpu.h) 318–323 定义了 `GFXSTREAM_VULKAN 3`；[gpu-devices.md](gpu-devices.md) 1651–1655 记为“需要宿主的 gfxstream” | 本计划完成后改写这两处 |

## 设计

### 客体侧（固定，不改）

`gfxstream_guest_angle` 下的客体栈（具体键值在 G0 从 Cuttlefish 启动器源码核对）：

- Vulkan：`ro.hardware.vulkan=ranchu`，libvulkan 从 APEX `com.google.cf.vulkan` 加载 `vulkan.ranchu.so`。
- GLES：`ro.hardware.egl=angle`，系统的 ANGLE 跑在上面的 Vulkan 上。
- gralloc：minigbm（`libminigbm_gralloc`、`mapper.minigbm.so`），缓冲是 virtio-gpu 资源。
- 合成：ranchu HWC。它在 `ro.hardware.vulkan` 不是 `pastel` 时用 gfxstream 的宿主合成（renderControl
  的 compose），设 `hwcomposer.mode=client` 则由 SurfaceFlinger 用 GPU 合成后经 DRM/KMS 翻页
  （[tools/a64_android.mjs](../tools/a64_android.mjs) 24–26 的记录）。G0 确定官方启动器在该模式下用哪一种。
- 传输：`gltransport=virtio-gpu-asg`（Address Space Graphics 环，放在 HOST3D blob 里）。

### 宿主侧（v64 新增）

```
客体 vulkan.ranchu / renderControl 编码器
        │  ASG 环（HOST3D blob，经 BAR4 的 host-visible 内存）+ SUBMIT_3D 上的 gfxstream 命令
        ▼
virtio_gpu_device.js ── 级别 gfxstream：capset、CONTEXT_INIT、按环围栏
        │
gfxstream.js（传输：上下文、ASG 环的读取与 ping、同步导出）
        │  按操作码范围分派
        ├─ gfxstream_vk.js（Vulkan 解码，生成代码）──┐
        └─ gfxstream_rc.js（renderControl 子集、颜色缓冲、同步对象）
                                                    ▼
                         vulkan_model（从 venus_vk*.js 拆出的协议无关模型）
                                                    │  VX 命令（不改 renderer_protocol.js）
                                                    ▼
                                    页面上的 VX 执行器（WebGPU）
```

- **新级别 `gfxstream`**：特性与 `venus` 相同（VIRGL、BLOB、CONTEXT_INIT、hostmem），capset 换成
  gfxstream 的。一台机器选一种 Vulkan 前端，Venus 与 gfxstream 不同时声明，避免客体 libvulkan 选错。
  与 `venus` 一样由 VM 管理器显式选（`display.vulkan` 扩成 `"none" | "venus" | "gfxstream"`）。
- **capset**：至少 `GFXSTREAM_VULKAN`（3）；渲染控制与合成是否另开 `GFXSTREAM_GLES`（8）、
  `GFXSTREAM_COMPOSER`（9）的上下文，由 G0 的轨迹决定。capset 内容（协议版本、环与缓冲大小、
  `noRenderControlEnc`、`alwaysBlob`、`externalSync`、`blobAlignment`、`deferredMapping`、
  `colorBufferMemoryIndex`、格式位图）照固定版本的上游头文件填，只公布实现了的能力
  （[gpu-deviations.md](gpu-deviations.md) 的规则）。
- **传输**：SUBMIT_3D 里的 gfxstream 上下文命令（`GFXSTREAM_CONTEXT_CREATE`、`CONTEXT_PING`、
  `CONTEXT_PING_WITH_RESPONSE`、`CREATE_EXPORT_SYNC`、`CREATE_IMPORT_SYNC_VK`、`CREATE_EXPORT_SYNC_VK`、
  `CREATE_QSRI_EXPORT_VK`、`RESOURCE_CREATE_3D`、`PLACEHOLDER_COMMAND_VK`；数值取自固定版本的
  `virtgpu_gfxstream_protocol.h`）。ASG 环：`asg_ring_config`（缓冲大小、刷新间隔、宿主已消费位置、
  客体写位置、传输模式、出错标志）、小消息环与大块传输区；客体写入后在宿主休眠时 ping。读取方式与
  Venus 的环相同：上传脏页、按位置读、回写消费位置。
- **解码**：gfxstream 的 Vulkan 流是“操作码、长度、载荷”的序列，载荷按 gfxstream 的 cereal 规则编码，
  另有 `VK_GOOGLE_gfxstream` 的私有命令（异步提交、宿主同步、映射内存到地址空间、带内存需求的建图、
  批量描述符更新等）。生成器 `tools/gfxstream_protocol_gen.mjs` 从固定版本的 vk.xml 与 gfxstream 的
  代码生成输入产出读写代码，像 Venus 那样配一个 C 写的协议向量对照（`tools/venus_oracle` 的做法）。
  句柄由宿主分配（boxed handle），映射到同一个 Vulkan 模型的对象。
- **渲染控制与颜色缓冲**：只实现客体实际调用的 rc 命令（G0 的轨迹为准；预计有版本与参数查询、
  颜色缓冲的建立/打开/关闭与 Vulkan 模式、同步对象、帧缓冲参数，以及宿主合成时的 compose）。颜色缓冲
  对应 virtio-gpu 资源与 VX 纹理，复用 Venus 导入 gralloc 资源的路径（`venus_vk_resources.js` 114–203、
  VX `TEXTURE_IMPORT`）。
- **围栏**：gfxstream 用按环的时间线与 sync file；现在的设备按控制队列顺序完成所有围栏（530–663）。
  G1 给带 `FLAG_INFO_RING_IDX` 的请求分环排队，Venus 也受益。
- **显示**：客户端合成走现有 KMS 路径；若官方模式用宿主合成，则在 VX 里实现 compose（多层、变换、
  混合）。两种都要避开每帧回读（G-31）：增加从 VX 纹理直接呈现到页面画布的路径，只在快照和截图时回读。

### 和“从磁盘直接引导 Android”的关系

不改镜像的另一半是引导：v64 要像 Cuttlefish 的 bootloader 一样从磁盘上的 boot、init_boot、
vendor_boot 取内核与 ramdisk，按启动器的规则生成 bootconfig（包括上面的 GPU 键）。这一步不依赖
gfxstream，单独排期（[android-images-plan.md](android-images-plan.md) 的 I2 引导器）；本计划只要求它能写出
`gfxstream_guest_angle` 的键。
在它完成前，G5 的验收用 `tools/a64_android.mjs` 生成的 initrd（新增一个 `--gpu gfxstream` 选项，只改
bootconfig 的 GPU 键，不改分区）。

## 优先级总览

| 顺序 | 阶段 | 首个交付 | 前置 | 规模 |
| --- | --- | --- | --- | --- |
| 1 | G0 参考与协议固定 | 官方镜像在参考宿主上以 `gfxstream_guest_angle` 进入桌面；固定的上游版本；协议轨迹语料 | 无 | M |
| 2 | G1 传输与按环围栏 | 级别 `gfxstream`、capset、CONTEXT_INIT、ASG 环、gfxstream 上下文命令、按环的围栏队列 | G0 | M |
| 3 | G2 Vulkan 解码与共用模型 | 生成的解码器、`VK_GOOGLE_gfxstream`、从 Venus 拆出的 Vulkan 模型 | G1 | L |
| 4 | G3 渲染控制与颜色缓冲 | rc 子集、颜色缓冲与 gralloc 资源、同步对象 | G2 | M |
| 5 | G4 显示与合成 | 客户端或宿主合成；不回读的呈现路径 | G3 | M（宿主合成则 L） |
| 6 | G5 Android 集成与验收 | 官方 Cuttlefish 镜像与官方 GSI 进入桌面，界面可用 | G4；引导用 `--gpu gfxstream` 或磁盘直接引导 | M |
| 7 | G6 快照、Worker 与多核 | gfxstream 状态进快照；CPU Worker；vCPU Worker | G5 | M |

整体约 2 到 3 个月，G2 最大。

## 1. G0 参考与协议固定

- 固定版本：gfxstream 的宿主与客体代码取 Cuttlefish 构建 15581820（`android16-qpr2-release`）对应的
  AOSP 标签；记录 vk.xml 版本与 gfxstream 协议版本，生成器只认这一组输入。
- 读 Cuttlefish 启动器源码（`device/google/cuttlefish` 的 `assemble_cvd` 图形参数部分），记下
  `gfxstream_guest_angle` 写入 bootconfig 的全部 GPU 键与内核参数，写进 `tools/a64_android.mjs` 的
  `--gpu gfxstream` 与本计划。
- 参考宿主：在 Linux arm64 虚拟机里用 QEMU 的 rutabaga（gfxstream 后端，宿主 Vulkan 用 lavapipe 或
  SwiftShader）引导同一份官方镜像。注意 A3/A5 记录的 lavapipe aarch64 崩溃；若 QEMU 路线走不通，改用
  crosvm 与 Cuttlefish 自己的启动器。验收：进入桌面，Launcher3 绘制。
- 轨迹：在参考宿主记录 virtio-gpu 命令、capset 查询、ASG 环的字节流与 SUBMIT_3D 的 gfxstream 命令，
  覆盖开机到桌面、打开一个应用、旋转与息屏。轨迹存成测试语料（格式与 `tests/x64/gpu_trace.mjs` 一致），
  统计实际出现的 rc 命令与 Vulkan 命令清单，作为 G2、G3 的范围。

验收：参考宿主进入桌面；轨迹语料与命令清单入库；本计划的未定项（capset 组合、合成方式）定稿。

进度（2026-10-24）：
- 版本固定与协议：完成，记在 [gfxstream-protocol.md](gfxstream-protocol.md)。Cuttlefish 15581820 的清单给出
  `device/google/cuttlefish` `4d368849`、mesa `d4b6f1eb`（客体的 gfxstream Vulkan 驱动与传输在 mesa 的
  `src/gfxstream/guest`，不在 gfxstream 仓库）、gfxstream `7e9d595b`、ANGLE `ff25cbdf`、minigbm `b7c93249`。
  capset：3 Vulkan、8 GLES、9 composer（字段布局已记）；execbuffer 命令表（CONTEXT_CREATE/PING、同步、
  RESOURCE_CREATE_3D 等）；一个连接 = 一个 host3d 可映射 blob（ring 加 buffer，按 blobAlignment 对齐），
  CONTEXT_CREATE 把 ASG 环绑在 blob 上，`asg_ring_storage` 三个 4 KiB 页与 `asg_ring_config` 的字节偏移。
- 启动器的选择：完成。`gfxstream_guest_angle` 写的 bootconfig（`vulkan=ranchu`、`gltransport=virtio-gpu-asg`、
  `cpuvulkan.version=0`，其余同 SwiftShader 档）进了设备型号的 `gpu_modes.gfxstream`（`src/android/devices.js`，
  引导器接受 `gpu_mode: "gfxstream"`，界面在 G5 前不提供）；QEMU 的设备是
  `virtio-gpu-rutabaga,gfxstream-vulkan=on,x-gfxstream-composer=on,hostmem=256M`。客体里 HWC 带 renderControl
  编码器（composer capset），GLES 是 ANGLE（没有宿主 GLES）。macOS 上 Cuttlefish 自己的启动器不提供 gfxstream。
- 参考宿主与轨迹：命令清单完成——官方镜像从第一个 gfxstream 上下文到桌面发出的 Vulkan 命令与次数（v86 上
  `A64_ANDROID_GFXSTREAM_TRACE=1` 记录）写进 [gfxstream-protocol.md](gfxstream-protocol.md) 的“What the official
  image sends”。参考宿主（QEMU 的 rutabaga 加 gfxstream 宿主）不做：协议由客体自己的编码器对照（G2 的对照程序与
  向量）检验，官方镜像在 v86 上到桌面并通过 A9 场景是端到端的检验；macOS 上要另建 Linux 虚拟机、rutabaga、
  gfxstream 宿主与 lavapipe（A3/A5 记录的 aarch64 崩溃），投入大而不再改变实现。

## 2. G1 传输与按环围栏

- `virtio_gpu_device.js`：级别 `gfxstream`、capset 声明与内容、CONTEXT_INIT 分派到新的 `gfxstream.js`。
- `gfxstream.js`：上下文、ASG 环（配置区、小消息、大块传输）、ping 与带回复的 ping、同步导出与导入、
  资源相关的占位命令；环的读取复用 hostmem 的脏页上传与回读。
- 围栏：带环号的请求分环排队，各环独立完成；不带环号的仍按控制队列顺序。Venus 的
  `timeline_idle` 改用新的分环队列。
- 设备测试：用 G0 的轨迹驱动设备（不需要真渲染器），检查 capset、上下文、环的消费位置、ping、
  按环围栏的完成顺序与快照。

验收：设备测试通过；Venus 的全部设备测试与 Android A9 场景不退化。

设计补充（2026-10-24，读 `virtio_gpu_device.js` 之后）：第一步是设备里**按 capset 的上下文类型表**：每种上下文
（Venus 的 4，gfxstream 的 3、9）一个处理者，接口是 Venus 已有的那一组（`contexts`、`create_context`、
`destroy_context`、`create_blob`、`mapped`、`unref_blob`、`submit`、`resubmit`、`timer`、`reset`、
`get_state`/`set_state`）；设备里现在 35 处直接引用 `this.venus`（建 blob、映射、提交、快照等）改成查上下文所属的
处理者，blob 的 `venus` 标记改成所属处理者。Venus 的设备测试（`tests/devices/virtio_gpu_venus.js`、
`venus_protocol.js`）逐字不变即是这一步的门禁。gfxstream 的 ASG blob（blob id 0、host3d、可映射）与 Venus 的共享内存
blob 同类，映射与脏页的路径可以共用。宿主在空闲时把 `host_state` 置为 `NEED_NOTIFY`（0），客体每次刷新都会 ping
（[gfxstream-protocol.md](gfxstream-protocol.md)），设备不必在 CPU 的时间片之间轮询环。

进度（2026-10-24）：完成。级别 `gfxstream`、两个 capset（3、9）、上下文类型表、`gfxstream.js` 的传输：一个
virtio-gpu 上下文（一个客体进程）可有多个 ASG 环（每个线程的流一个，按 blob 的资源号，同宿主的
`mAddressSpaceHandles`；PING 带资源号选环），每个环各自的流、客户端标志与等待；解码者可回答 `AGAIN`
（命令排在另一个环的后面，见 G2 的序号），另一个环解码了命令后再试。按环的围栏（`timeline_of`、分环的
`drain`），同步命令作为上下文时间线上的任务，进程管道（`GLProcessPipe`）。设备测试
`tests/devices/virtio_gpu_gfxstream.js`；Venus 的设备测试不变，A9 的 Venus 引导（v86、CPU Worker、4 核、
引导器）`boot_completed` 1313 s，不退化。

## 3. G2 Vulkan 解码与共用模型

- 把 `venus_vk*.js` 拆成协议无关的 `vulkan_model`（对象、内存、提交、等待、快照记录）与 Venus 前端；
  行为不变，Venus 测试作为回归。
- `tools/gfxstream_protocol_gen.mjs` 生成 gfxstream 的 Vulkan 读写代码；C 写的对照程序用上游编码器产出
  协议向量，解码器逐条比对（同 `venus_protocol.js` 的测试）。
- `gfxstream_vk.js`：标准 Vulkan 命令映射到模型；`VK_GOOGLE_gfxstream` 的私有命令（异步提交与宿主同步、
  内存映射到地址空间、带需求的建图建缓冲、描述符批量更新、命令缓冲流式录制等）按 G0 清单实现。
- 设备能力与 Venus 相同（`venus_device_info.js` 拆成共用的设备信息），只公布 VX 支持的功能。
- 客体测试：在官方镜像里用 `vulkan.ranchu` 跑 `tests/a64/android/vkprobe.c` 与 `vkahb.c`（只换驱动选择，
  不重编译）。

验收：协议向量全部一致；vkprobe、vkahb 在 v64 上通过，结果与 Venus 一致。

进度（2026-10-24）：
- 生成器与对照：完成。`tools/gfxstream_protocol_gen.mjs` 解析固定版本客体的生成代码（mesa
  `src/gfxstream/guest/vulkan_enc` 的 `goldfish_vk_reserved_marshaling_guest.cpp`、`goldfish_vk_marshaling_guest.cpp`、
  `VkEncoder.cpp`，类型取 mesa `include/vulkan` 与客体自己的 `vk_android_native_buffer_gfxstream.h`、
  `vulkan_gfxstream.h`），按语句翻译：请求的写入变成设备的解码（`d_*`），回复的读取变成设备的编码（`e_*`），
  `--guest` 另写客体一侧（测试用，`tests/devices/gfxstream_guest_protocol.js`）。356 个命令、1163 个函数；流特性
  按 virtio-gpu 客体的四个全开折叠成常量。pNext 的大小按 LP64 布局算出（客体只看是否为 0，但写的是 `sizeof`）。
  对照程序 `tools/gfxstream_oracle`（`build.sh` 把客体的编组 C++ 与桩一起编译）：17 个请求结构由客体自己的
  `reservedmarshal_*` 写出，解码再编码逐字节一致（指针的存在字统一成 1）；9 个回复由客体的 `unmarshal_*`
  读回再写出，与写入的一致。向量在 `tests/devices/gfxstream_protocol_vectors.txt`，测试
  `tests/devices/gfxstream_protocol.js`。
- 模型：Venus 的 `VulkanModel`（`venus_vk*.js`）本来就只经 `ctx.objects` 与 `ctx.physical_device` 认上下文，处理者
  吃 C 字段名的对象，gfxstream 直接用它（每个 gfxstream 上下文一份状态作为模型的上下文），不另拆文件；只加了
  `handles(name)`。Venus 专有的处理者（`*MESA`）留在原处。
- `gfxstream_vk.js`：完成第一版。顶层命令先读序号（QUEUE_SUBMIT_WITH_COMMANDS：一个进程的命令按序号执行，
  不论在哪个环；不是下一个就 `AGAIN`），命令完成后才前进。宿主分配句柄（生成器从回复里映射句柄的参数得出每个
  命令的输出句柄）；物理设备与队列句柄固定。私有命令：`vkCreateImage/BufferWithRequirementsGOOGLE`、
  `vkQueueSubmitAsync(2)GOOGLE`、`vkQueueWaitIdleAsyncGOOGLE`、`vkQueueFlushCommandsGOOGLE`（客体录好的命令缓冲：
  操作码、长度、参数，没有序号与句柄，含 `vkBegin/End/ResetCommandBufferAsyncGOOGLE`）、`vkQueueHostSyncGOOGLE`
  与 `vkCommandBufferHostSyncGOOGLE`（同宿主：最多等 5 s）、`vkAllocateMemory` 的 `VkCreateBlobGOOGLE`（blob id 记到
  内存，`vkGetBlobGOOGLE` 后客体以该 id 建 HOST3D blob，映射与上传沿用模型的 `export_memory`/`map_memory`/
  `upload_blob`）、`VkImportColorBufferGOOGLE`/`VkImportBufferGOOGLE`（换成模型的资源导入）、描述符更新模板与
  `vkUpdateDescriptorSetWithTemplateSized(2)GOOGLE`（按宿主的线性化顺序拆成写入）、`vkGetLinearImageLayout(2)GOOGLE`、
  交换链的 gralloc 用途、`vkAcquireImageANDROID`；`CREATE_EXPORT_SYNC_VK` 等围栏信号，`CREATE_QSRI_EXPORT_VK` 等队列空闲。
  KHR/EXT 别名走核心命令。capset 不开批量描述符更新，`vkQueueCommitDescriptorSetUpdatesGOOGLE` 不会来。
  设备测试 `tests/devices/virtio_gpu_gfxstream_vk.js` 用客体编码器在环上走一遍：实例、物理设备、设备与队列、带需求的
  缓冲、以 blob 映射的内存（客体写入经 blob 到 GPU 的复制）、刷入的命令缓冲、无回复的提交、导出围栏、两个环按序号。
- 未做：官方镜像里的 vkprobe/vkahb（G5 的引导之后）；ANB 图像与颜色缓冲导入的细节在 G3。

## 4. G3 渲染控制与颜色缓冲

- `gfxstream_rc.js`：G0 清单里的 rc 命令。颜色缓冲与 virtio-gpu 资源（RESOURCE_CREATE_3D 或 blob）一一
  对应，背后是 VX 纹理；gralloc（minigbm）分配的缓冲经这条路导入 Vulkan。
- 同步对象：rc 的同步与 Vulkan 的 sync file、按环围栏对齐。
- 测试：轨迹回放；官方镜像里 SurfaceFlinger 与 HWUI 的缓冲分配不再报错（logcat 检查）。

验收：开机到 system_server 期间没有渲染控制或 gralloc 错误；颜色缓冲的内容可读回比对。

进度（2026-10-24）：完成（客户端合成所需的部分）。官方镜像用 `hwcomposer.mode client`，HWC 经 KMS 翻页、不用
renderControl，所以 rc 只需进程管道与同步；gralloc（minigbm）的缓冲是 virtio-gpu 资源：`VkNativeBufferANDROID`
的图像（`vkCreateImage` 的链与 `vkBindImageMemory2` 的链两种形式，`13fc393f`、`fb30efa9`）与 AHB
（`VkImportColorBufferGOOGLE`）导入为模型绑定到资源的图像；AHB 的格式查询按 dma-buf 回答，`vkCreateDevice` 去掉客体
或宿主模拟的扩展、提供 `VK_KHR_external_memory_fd`。清除颜色按 uint32 位传（`f060d136`）。
`tests/devices/virtio_gpu_gfxstream_render.js` 在无头 Chrome 的渲染器上按 vkahb 的步骤清除 AHB 图像与交换链图像并经
TRANSFER_FROM_HOST_3D 读回。宿主合成（rcCompose）未做：官方模式不需要。

## 5. G4 显示与合成

- 客户端合成：SurfaceFlinger 用 ANGLE 合成，HWC 经 KMS 翻页；设备已有的 SET_SCANOUT_BLOB 与 flush
  路径即可，补上颜色缓冲作为扫描输出。
- 宿主合成（若 G0 确定官方模式需要）：rc 的 compose 在 VX 里实现层的裁剪、变换、混合与颜色格式。
- 不回读的呈现：VX 纹理直接画到页面画布（CPU Worker 下经渲染器通道传纹理句柄而非像素）；快照、截图
  与测试仍回读。G-31 改写。

验收：桌面与 Launcher3 正确显示；帧时间与 Venus（A9：热中位数 2.3 s）对比并记录。

进度（2026-10-24）：客户端合成完成：SurfaceFlinger 用 ANGLE（gfxstream 的 Vulkan 上，OpenGL ES 3.0）合成，HWC 翻页，
扫描输出是颜色缓冲（设备的 SET_SCANOUT_BLOB 与 flush 路径）；A9 场景的桌面与 Launcher3 正确（见 G5）。冷启动的帧
5 帧、中位数 4.95 s（gfxinfo 在 Launcher 的重启后取不到热帧；Venus 的热中位数 2.3 s）。不回读的呈现（G-31 改写）
完成：页面上有图形代理的合成器时，显示适配器的渲染器（`svga_renderer.js`）建在合成器的设备上并拿到它的一个图层，
向设备回答 caps；virtio-gpu 对 3D 扫描输出的刷新改发 GX 的 SURFACE_PRESENT，渲染器在 GPU 上把刷新的矩形复制进
图层（同格式的 copyTextureToTexture），没有回读；有光标或两个显示器时、渲染器做不到时（Node、无合成器）照旧回读，
SET_SCANOUT 0 时撤下图层。Venus 与 gfxstream 的扫描输出（RESOURCE_CREATE_3D 的颜色缓冲）都走这条路。测试：
`tests/devices/virtio_gpu_present.js`（设备的选择）、`tests/glbridge/virtio_gpu_present_browser_test.html`（Chrome：
3D 资源上屏，0 次回读）。

## 6. G5 Android 集成与验收

- 官方 Cuttlefish 镜像：磁盘不改（不注入驱动，不改 vbmeta），只用 `gfxstream_guest_angle` 的 bootconfig。
- 官方 GSI（如 `aosp_arm64-exp-BP2A.250605.031.A3`）替换 system，vendor 仍是 Cuttlefish 的。是否需要
  AArch32 取决于 GSI 的 ABI 列表，见 [aarch32-plan.md](aarch32-plan.md)。
- 场景：沿用 `tests/a64/android_scenario.mjs` 的 A9 场景（桌面、触摸打开 Gallery、Wi-Fi 与 HTTP、APK 安装与
  启动、重启），加 `A64_ANDROID_GPU=gfxstream`；dEQP-VK 与 dEQP-GLES3 抽样（appendix F 的工具）。
- VM 管理器：Android 预设默认 `display.vulkan: "gfxstream"`；向导导入官方镜像时不再需要 initrd-venus。
- 文档：[aarch64.md](aarch64.md) 的 Android 一节、[gpu-devices.md](gpu-devices.md) 的 gfxstream 一节与
  “Not done”、[gpu-deviations.md](gpu-deviations.md) 新增条目。

验收：两种官方镜像都进入桌面并通过 A9 场景；指标与 Venus 并列记录（冷启动、桌面、帧、应用启动）。

进度（2026-10-24）：官方 Cuttlefish 镜像（15581820，磁盘不改，引导器的 `gpu_mode: "gfxstream"`）在 v86、4 个 vCPU
Worker、页层、1536 MB 下通过 A9 场景（`A64_ANDROID_SCENARIO=a9 A64_ANDROID_GPU=gfxstream A64_ANDROID_BOOTLOADER=1`）：
`boot_completed` 1186 s（Venus 1313 s），SELinux enforcing，解锁后 Launcher3（QuickstepLauncher）在前台，
`GLES: ... ANGLE (Mesa, Vulkan 1.1.0 (Virtio-GPU GFXStream (v86 WebGPU)), gfxstream-24.2.0), OpenGL ES 3.0.0`，
触摸打开 Gallery，Wi-Fi 地址与 HTTP（Wi-Fi 关开之后也通），APK 安装 Success、启动 59.9 s，重启后 665 s 再到桌面，
无应用崩溃。VM 管理器：显示的 Vulkan 可选 gfxstream，Android 的 GPU 档位随之（`55221e2e`）；预设的默认改 gfxstream
见 android-images-plan I8.1。未做：官方 GSI 在 gfxstream 下、dEQP 抽样、文档的 gfxstream 节。

## 7. G6 快照、Worker 与多核

- 快照：gfxstream 上下文、环位置、句柄表与颜色缓冲进设备状态；Vulkan 对象沿用模型的“重放 VX 命令”
  做法（`venus_state.js`）。保存时环必须空闲或可续读。
- CPU Worker：渲染器留在页面，设备在 Worker，通道不变；vCPU Worker 下多核同时写环的顺序由客体保证，
  设备侧只按环处理。
- 验收：A10 的保存与恢复场景（`a64-android-a10`）在 gfxstream 下通过；CPU Worker 与 4 个 vCPU Worker。

进度（2026-10-24）：快照完成（`d78b3747`）：每个上下文的环（未解码的流、先在等待的命令）、RESOURCE_CREATE_3D
模板、同步号、Vulkan 状态（如 Venus 的 `venus_state.js`：对象、blob、队列、模板、宿主同步序号、原生图像）与进程管道
进设备状态，模型恢复时重建渲染器对象；保存前环如 Venus 的一样排空。设备测试覆盖两环序列跨快照。4 个 vCPU Worker
在 G5 的 A9 场景里用过。未做：A10 场景在 gfxstream 下、CPU Worker 下的浏览器运行。

## 风险与未定项

- **协议不稳定**：gfxstream 的线上格式随版本变化，没有 Venus 那样的协议版本承诺。缓解：固定到 vendor
  构建，生成器与对照程序只认固定输入；换 vendor 构建时重新生成并跑对照。
- **私有命令的范围**：`VK_GOOGLE_gfxstream` 与 rc 的实际使用面只有轨迹能说清，G0 的清单决定 G2、G3 的
  工作量。
- **合成方式**：若官方模式必须宿主合成，G4 变大（多层合成与格式转换）。
- **ANGLE 的功能需求**：ANGLE 在 VX 上目前得到 GLES 3.0；若客体或应用要求 3.1/3.2，需要 VX 增加计算着色器
  以外的功能，另行评估（与 Venus 共同的限制）。
- **参考宿主**：rutabaga 与 gfxstream 在 arm64 Linux 上的构建与 lavapipe 的稳定性；必要时改用 x86-64 Linux
  主机跑 arm64 客体（TCG）。

## 规范与实现参考

- [gfxstream（AOSP）](https://android.googlesource.com/platform/hardware/google/gfxstream/)：宿主解码器、
  代码生成输入、`virtgpu_gfxstream_protocol.h`、ASG 的环结构
- [Cuttlefish（device/google/cuttlefish）](https://android.googlesource.com/device/google/cuttlefish/)：启动器的
  GPU 模式与 bootconfig 键
- [rutabaga_gfx（crosvm）](https://chromium.googlesource.com/crosvm/crosvm/+/refs/heads/main/rutabaga_gfx/)、
  [QEMU virtio-gpu-rutabaga](https://www.qemu.org/docs/master/system/devices/virtio-gpu.html)
- [virtio-gpu 规范（virtio 1.3）](https://docs.oasis-open.org/virtio/virtio/v1.3/virtio-v1.3.html)
- [Vulkan 注册表 vk.xml](https://github.com/KhronosGroup/Vulkan-Docs)
