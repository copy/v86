# GeForce 6800 GT（NV40）显示适配器实施计划

状态：设计与实施计划，尚未实现。2026-10-26 初稿。所有者决定模拟 AGP 版 GeForce 6800 GT。

本计划为 v86 增加第四种显示适配器 `graphics_adapter: "geforce_6800"`。它是一张 Windows 98 和
Windows XP 都能用、支持 DirectX 9.0c 与 Shader Model 3.0 的复古显卡。客体装 NVIDIA 官方驱动：
98 用 ForceWare 81.98（Win9x 版），XP 用 ForceWare 的 XP 版。设备在寄存器和命令层面模拟真实的
NV40，2D 在 CPU 侧完成，3D 翻译成现有的 D9WG 批次，由页面上的 D3D9 执行器在 WebGPU 上运行
（[gpu-devices.md](gpu-devices.md) 的 “Architecture”）。

与已有的三种适配器的关系：Bochs VGA 不变；VMware SVGA II 与 virtio-gpu 面向现代客体，给客体的是
高层的 3D 命令（SVGA3D、VGPU10、virgl、Venus）；NV40 给客体的是真实硬件接口，客体驱动是闭源的
NVIDIA 驱动，设备必须从硬件层面的方法流重建 D3D9 级的状态。

## 选型结论

2026-10-26 的选型过程（证据见“规范与实现参考”）：

1. **只有 NVIDIA 的 NV40 家族同时满足 98、XP 与 SM3.0。** Radeon X1000（R5xx）没有 Win9x 驱动：
   Win9x 的最后一版 Catalyst 6.2 不含 R5xx；Intel GMA X3000 也没有 98 驱动。GeForce 6/7 系列
   （NV40 家族：NV40–NV4E、G70–G73）都是 SM3.0。
2. **6800 GT AGP（`10DE:0045`）是 98 支持最稳的型号。** ForceWare 81.98 的 Win98/ME 版只列出 AGP 的
   GeForce 6 系列（6200、6600、6600 GT、6800 Ultra/GT/LE 等）；PCIe 型号和 7 系列在 98 上要改 INF
   或用 82.69，社区报告有妥协。7 系列与 6 系列是同一套 3D 类和着色器指令集，对 DX9.0c/SM3.0 没有
   额外能力。6800 GT AGP 是原生 AGP 的 NV40，不经过 HSI 桥（6600 GT AGP 是 PCIe 的 NV43 加桥），
   也不是 TurboCache（6200 TC、7300 借用系统内存，显存管理更复杂）。
3. **XP 也要装驱动。** XP SP3 自带的 `nv4_disp.inf`（5.6.7.3，即 ForceWare 56.73）只到 GeForce FX 5700
   （NV36），没有 NV40（2026-10-26 从安装盘核对）。98 SE 更没有。这只影响首次准备镜像：网站的
   XP/98 镜像由所有者装一次驱动。
4. **有现成的参考实现。** Bochs 的实验性 GeForce 模拟有 `geforce6800` 型号（Leadtek 6800GT AGP 的
   VGA BIOS），2D 大部分可用，据报 Windows 到 7 可以启动，3D 是 PGRAPH 方法的软件解释，未完成。
   Bochs 是 LGPL，xemu 的 NV2A（同一谱系的 PFIFO/PGRAPH，GPL）也只作参考；nouveau、Mesa 的 nv30
   驱动与 envytools 是 MIT 许可，可以移植并注明来源。
5. **代价是 98 老游戏的部分兼容性。** GeForce 6 起取消了调色板纹理（P8），部分 DX5/6 游戏的贴图会
   出错。这是真卡的行为，不是模拟的缺陷，写进 [gpu-deviations.md](gpu-deviations.md) 的客体说明。

## 关键决定

1. **身份。** PCI `10DE:0045`，修订号与 `PMC_BOOT_0` 取 NV40 的 A1 步进（G0 依 envytools 与驱动行为
   核对；Bochs 只返回 `0x04000000`），类代码 `030000`，INTA。子系统 ID 取一个公版值（G0 决定；
   驱动 INF 按 `PCI\VEN_10DE&DEV_0045` 匹配，与子系统无关）。显存 256 MiB（`vram_size` 可选
   128 MiB），正好是 `MAX_VRAM_SIZE`。显存是 wasm 堆里的设备内存（与其他适配器相同），XP 门禁配置的
   2048 MB 内存加 256 MiB 显存仍在 32 位堆的 4 GiB 之内。
2. **BAR。** 与真卡和 Bochs 一致：BAR0 16 MiB 寄存器（不可预取），BAR1 显存（可预取，大小等于
   `vram_size`），BAR2 16 MiB 的 RAMIN 窗口，另有扩展 ROM BAR（VGA BIOS）。
3. **总线：先用 PCI 模式。** v86 的 i440FX 没有 AGP（Bochs 为此改用 i440BX）。NVIDIA 的 DMA 对象本来
   就能用页表访问系统内存，不依赖 AGP 的 GART；AGP 芯片跑在 PCI 总线上有真实先例（GeForce 6200
   PCI 是 AGP 的 NV44A 跑在 PCI 上）。所以设备先不声明 AGP capability，PEXTDEV 的总线 strap 报
   PCI。模拟中 AGP 内存与系统内存都是客体 RAM，PCI 模式不损失能力。G0 验证 81.98（98、XP）与
   XP 主驱动接受 PCI 模式的 NV40；不接受时再做可选阶段 A1（i440BX 与 AGP GART）。
4. **3D 后端复用 D9WG。** NV40 的 3D 状态是 D3D9 级的（NV40 正是为 D3D9 SM3.0 设计的），D9WG
   执行器已经按设备保存完整的 D3D9 状态，并在 VMware SVGA 的 `vgpu9` 上把 3DMark06 跑完。设备把
   `NV40_3D`（类 `0x4097`）的方法翻译成 D9WG 命令（`svga3d_d9wg.js` 的 `D9WGWriter`，会话
   `"NV40"`），把 NV40 的顶点和片段程序微码翻译成 D3D9 SM3.0 的字节码，由
   `d3d9_shader_pipeline.js` 转成 WGSL。D3D9 字节码表达不了的少数 NV 指令（打包/解包、条件码的
   某些用法）用私有操作码扩展字节码，协议升到 1.8，就像 GX 的前端接受 VMware 的私有 VGPU10
   操作码。不选 GX：它是 D3D10/11 级的状态模型，NV40 的语义要先降成 D3D9 再升回去。
5. **显存的权威副本。** 显存字节（设备内存，BAR1 直接映射）是权威副本，除非某个表面被 GPU 写过。
   上传靠显存页的脏位图与 DMA 写入记录，下载发生在同步点（见“显存一致性”）。tile 区域和 Z 压缩
   由显存控制器处理、对访问者透明，模拟中显存始终按线性地址保存，只记录寄存器值；swizzle 纹理
   是驱动选择的数据布局，上传时按 Morton 顺序还原。
6. **自己的 VGA BIOS。** NVIDIA 驱动会读 ROM 里的 BIT 表、DCB、I2C 表、PLL 限制与初始化脚本。
   真卡 ROM 的 dump 不能随 v86 分发，也不作为测试的前提。v86 构建自己的 ROM：基于 SeaVGABIOS，
   加一个用 NV 的 CRTC/RAMDAC 寄存器设置模式的驱动（像 `vgasrc/` 现有的 cirrus、ati、bochs 驱动），
   以及按 envytools/nouveau 文档写的最小 NVIDIA 表格。这是第一个需要专属 ROM 的适配器：插件的描述符
   新增 `vga_bios` 字段，`graphics_adapter.js` 用它代替共用的 `bios/vgabios.bin`，不再走 ID 修补。
7. **驱动版本固定。** 98：ForceWare 81.98（Win9x）。XP：93.71（2006-11 WHQL，复古社区最常用）为主，
   81.98（XP 版）对照，307.83（应是 GeForce 6/7 在 XP 上的最后一版，G0 确认）作回归。安装包从
   NVIDIA 官方存档下载（所有者下载，不进仓库），测试按环境变量取路径。
8. **测试素材**：所有者的 XP 镜像，3DMark03/05/06 与 legacy 镜像（3DMark99 MAX、2000、2001 SE），见
   “测试镜像”。3DMark03/05/06 的注册码取自 UL 官方的 legacy benchmarks 页面。
9. **许可。** nouveau、Mesa nv30、envytools（MIT）的表格、编码与公式可以移植，在文件头记录来源与
   修改；Bochs（LGPL-2.1）与 xemu（GPL-2.0）只读、不复制代码。

## 范围

**目标**（v1）：

- Windows 98 SE + ForceWare 81.98，Windows XP SP3 + ForceWare XP 版：驱动加载，设备管理器无问题代码；
- VGA 兼容、VBE、文本模式，98 的 DOS 全屏切换；
- 8/16/32 bpp 桌面，模式切换，硬件光标，DDC/EDID；
- GDI 与 DirectDraw 加速，翻页；
- Direct3D 5 到 9.0c：固定功能（驱动把它编译成 NV40 程序）、VS/PS 1.x–3.0、多渲染目标、FP16 混合与
  过滤、顶点纹理、硬件阴影图、遮挡查询；
- 3DMark99 MAX、2000、2001 SE、03、05、06 跑完；
- 快照，CPU Worker 模式。

**非目标**（v1 之后再定）：

- Vista/7 的 WDDM 驱动（同一硬件，但多出 GPU 调度与显存管理的要求）；
- SLI、电视输出、DVI/TMDS 的细节（报一个 CRT 输出），第二个显示头（报未连接）；
- PureVideo/MPEG 解码；PVIDEO 视频覆盖层在可选阶段 V1；
- 降频、温度与风扇：接受写入，读回固定的合理值；
- AGP（可选阶段 A1）。

**OpenGL**：NVIDIA 驱动的 OpenGL ICD 走同一个 `NV40_3D` 类，硬件模拟完整时它自然可用。v1 不专门
验收，可选阶段 O1 用 OpenGL 游戏验收。

## 架构

```text
=== guest ======================================================================
 XP: nv4_mini.sys + nv4_disp.dll (GDI, DirectDraw, D3D) + nvoglnt.dll (OpenGL)
 98: ForceWare 81.98 (VxD 驱动, DirectDraw/D3D HAL, OpenGL ICD)
        │ BAR0 寄存器, BAR1 显存, BAR2 RAMIN, PCI DMA (系统内存)
=== CPU thread (or CPU worker) =================================================
 v86-geforce-6800.js
  PMC/PBUS/PTIMER/PFB/PEXTDEV, IRQ           PCRTC/PRAMDAC + vga_core.js, 光标, DDC/EDID
  PFIFO: 通道, DMA pusher, RAMHT/RAMFC, USER  PGRAPH: 对象, 通知器, 上下文, 错误中断
  2D 类 (surf2d, blit, gdi, ifc, sifm, m2mf) → 显存字节 (CPU 上)
  NV40_3D (0x4097) 状态 → 表面/纹理/顶点缓存 → D9WG 命令
  VP/FP 微码 → D3D9 SM3 字节码 (+私有操作码)
        │ renderer channel: submit (d9wg), reset ↓   write, done, lost ↑
=== page (WebGPU) ==============================================================
 svga_renderer.js 的 D9WG 执行器 (d3d9_executor.js, d3d9_shader_pipeline.js)
```

- **CPU 侧**（插件）做所有涉及客体内存的事：寄存器语义、FIFO 解析、DMA 对象与页表、2D 运算、
  表面与纹理的缓存及其失效。3D 方法流被归并成 D3D9 级的状态，在绘制时写成 D9WG 命令，所引用的
  显存或系统内存数据随批次一起走（批次自包含，与 SVGA 相同）。没有渲染器时只提供 2D：3D 类的
  方法照常接受，绘制不出画面，通知器照常完成，客体不挂。
- **渲染器**不变，复用 `svga_renderer.js` 与远程渲染器（`tests/x64/gpu_remote_renderer.mjs`）。
  D9WG 协议的扩展（私有操作码、视口约定，见下）放在协议 1.8，执行器同时接受 1.7。
- **线程**：与其他适配器相同，插件在机器线程（单线程或 CPU Worker），并行模式下 vCPU Worker 不加载它。

### 模块划分

| 文件 | 内容 |
| --- | --- |
| `src/graphics_adapters/geforce_6800/plugin.js` | 描述符（`name`、`pci_vendor`、`pci_device`、`vga_bios`、`create`） |
| `nv_device.js` | PCI 与 BAR、BAR0 分发、PMC（ID、使能、中断汇总）、PBUS（配置空间镜像）、PTIMER、PFB、PEXTDEV、PROM、RAMIN 窗口、快照 |
| `nv_display.js` | PCRTC/PRMCIO/PRMVIO（VGA 寄存器的 NV 扩展）、PRAMDAC/PRMDIO、VPLL、硬件光标、翻页与 vblank 中断、DDC/EDID；VGA 部分用 `vga_core.js` |
| `nv_fifo.js` | PFIFO：通道、RAMFC、RAMHT、RAMRO、CACHE1、DMA pusher、puller 方法（对象绑定、REF_CNT、信号量）、USER 区 |
| `nv_graph.js` | PGRAPH：对象实例、子通道、方法分发、通知器、按通道的上下文、错误中断 |
| `nv_2d.js` | 2D 类：surf2d、swizzled surface、image blit、GDI rect/text、IFC、SIFM、M2MF、ROP、pattern、clip、beta |
| `nv40_3d.js` | `NV40_3D` 的方法状态、绘制、清除、查询、坐标约定 |
| `nv40_program.js` | VP/FP 微码解码、结构化、翻译成 D3D9 字节码；翻译缓存 |
| `nv_surfaces.js` | 表面/纹理/顶点区间的缓存、显存一致性、swizzle 与格式转换 |
| `nv_formats.js` | NV 表面与纹理格式 → D3DFORMAT 与转换函数（移植自 Mesa nv30 的格式表） |
| `bios/` | `vgabios-geforce6800.bin`，由 `bios/fetch-and-build-seabios.sh` 加补丁构建；补丁与表格源在 `bios/nv40/` |

## 设备契约

寄存器的确切位与偏移以 envytools 的 rnndb 为准，下面只写区块和行为。G0 用驱动跟踪（见 G0）补齐
“驱动实际访问”的清单，每个被访问的寄存器要么实现、要么在跟踪表中注明为“只存值”。

### PCI 配置空间

- `10DE:0045`，类代码 `030000`，修订号见关键决定 1。命令/状态寄存器、Capabilities 链：电源管理；
  不声明 AGP（关键决定 3）。
- BAR 见关键决定 2；扩展 ROM BAR 指向 VGA BIOS。用现有的 `register_pci`（`on_move` 重定位）与
  `mmap_register_range`。
- BAR0 的 PBUS 区（0x1800 起）镜像配置空间，驱动通过它读写配置。

### BAR0 区块

| 区块 | 偏移 | v1 的行为 |
| --- | --- | --- |
| PMC | 0x000000 | `BOOT_0`（芯片 ID）、`INTR_0`/`INTR_EN_0`（汇总 PFIFO、PGRAPH、PTIMER、PCRTC、PBUS 与软件中断）、`ENABLE`（各引擎使能与复位） |
| PBUS | 0x001000 | 配置空间镜像、PBUS 中断 |
| PFIFO | 0x002000 | 见下 |
| PVIDEO | 0x008000 | v1 只存值（覆盖层在 V1） |
| PTIMER | 0x009000 | 纳秒计数（分子/分母由驱动设置）、闹钟中断；由 `MachineClock` 推导，`pause()` 时冻结 |
| PFB | 0x100000 | 显存大小与配置、tile 区域与 Z 压缩寄存器（只存值） |
| PEXTDEV | 0x101000 | strap：晶振频率、总线类型（PCI）、显存类型 |
| PROM | 0x300000 | VGA BIOS 的读窗口（按配置空间中的 ROM 使能位） |
| PGRAPH | 0x400000 | 见下 |
| PCRTC、PRMCIO | 0x600000、0x601000（头 2：0x602000、0x603000） | 见“显示” |
| PRAMDAC、PRMDIO | 0x680000、0x681000（头 2：0x682000、0x683000） | 见“显示” |
| PRMVIO | 0x0C0000 | VGA 序列器/图形寄存器的镜像 |
| PRAMIN | 0x700000 | RAMIN 窗口，映射到显存末端（规则以 envytools 为准，可对照 Bochs）；BAR2 是同一内容 |
| USER | 0xC00000 | 每通道 4 KiB 的 FIFO 控制区（DMA_PUT/GET、REF）；32 个通道 |

PLL（NVPLL、MPLL、VPLL）接受写入并按系数计算频率；只有 VPLL 影响客体可见的行为（像素时钟 →
扫描时序与 vblank 周期）。

### 中断

- 设备汇总各引擎的状态到 `PMC_INTR_0`，经 INTA 走 i440FX 的 PIRQ 路由。中断只在客体能看到写回的
  结果之后提升（写回的通知器、REF_CNT 先于中断可见）。
- 需要的中断源：PFIFO（DMA 错误、缓存错误、非法方法）、PGRAPH（通知、错误、上下文切换请求）、
  PCRTC vblank（翻页与驱动的帧节拍）、PTIMER 闹钟、软件中断。

### PFIFO

- **通道**：32 个；每个通道的 RAMFC 记录（DMA_PUT/GET、DMA 实例、子通道绑定等）在 RAMIN 中。
  驱动写 USER 区的 DMA_PUT 后，设备从 GET 处取命令直到 PUT。
- **DMA pusher**：递增与不递增的方法头、旧式与新式 JUMP、CALL/RETURN，以及错误处理（RAMRO 与中断）。
  push buffer 位于显存或系统内存，通过通道的 DMA 对象访问（线性或页表，Bochs 的 `0x00002000`/
  `0x00020000` 位可对照）。
- **puller**：子通道绑定（RAMHT 查找对象句柄，得到引擎与实例）、REF_CNT、信号量 acquire/release
  （驱动用它们做跨通道与 CPU 同步）、非法方法。
- **预算**：每次 PUT 写入处理到预算为止，余下的放到定时器里接着处理，不能一次占满 Worker。
  同步点（REF_CNT 回写、信号量释放、带通知的方法）要等它之前的 3D 批次 `done`、需要下载的表面
  写回显存之后才完成（见“显存一致性”）。

### PGRAPH

- **对象**：RAMIN 中的对象实例（类号、格式、DMA 对象句柄、通知器）。v1 的类以 nouveau 的 NV40
  列表为起点：`0x0012`（beta1）、`0x0019`（clip）、`0x0030`（null）、`0x0039`（M2MF）、`0x0043`
  （ROP）、`0x0044`（pattern）、`0x004A`（GDI rect/text）、`0x0062`（surf2d）、`0x0072`（beta4）、
  `0x0089`（SIFM）、`0x008A`（IFC）、`0x009F`（image blit）、`0x3062`、`0x3089`、`0x309E`（NV40 的
  surf2d、SIFM、swizzled surface）、`0x4097`（NV40_3D）。DMA 对象类 `0x0002`、`0x0003`、`0x003D`。
  NVIDIA 驱动实际用到的类以 G0 的跟踪为准。
- **通知器**：方法完成时写通知结构（时间戳、返回值、状态），可选中断。
- **上下文**：驱动会上传自己的上下文切换微码（ctxprog）与初始上下文。设备不执行 ctxprog，而是按
  通道保存 PGRAPH 的状态，切换通道时换入换出。ctxprog 的字节只存不解释；G0 检查驱动是否通过上下文
  映像读写状态，若是，按跟踪实现那些字段。
- **错误**：非法方法、非法类、DMA 越界产生 PGRAPH 中断并报告给驱动，不静默忽略（驱动可能依赖
  这些中断来实现软件方法）。

### 显示

- **VGA 兼容**用 `vga_core.js`。NV 扩展 CRTC 寄存器（解锁寄存器、扩展起始地址与偏移、像素深度、
  VGA/扩展模式选择、光标地址、DDC 的 GPIO）在其上实现。标准 VGA 模式设置要清掉扩展模式（98 的
  DOS 全屏切换依赖这一点）。
- **扩展模式**：起始地址、行距、像素深度（8/15/16/32 bpp）、调色板与 gamma（PRAMDAC 通用控制）、
  VPLL；图像从显存按模式送到显示中枢（`display.set_mode`、`update_buffer`），与现有适配器相同。
- **翻页**：起始地址在 vblank 生效；vblank 中断按 VPLL 推导的刷新率触发。
- **硬件光标**：显存中的 32×32/64×64 光标图像（ARGB 或 A1R5G5B5）与位置寄存器，叠加在画面上。
- **DDC/EDID**：CRTC 的 GPIO 寄存器（Bochs 用 CR3E/CR3F）上实现 I2C，EDID 来自
  `virtio_gpu/edid.js`。报一个 CRT，首选 1280×1024（3DMark06 的默认分辨率），最高 2048×1536。
- **第二个显示头**：寄存器可读写，报未连接。

### VGA BIOS

- SeaVGABIOS 的 NV 驱动：VBE 2.0/3.0 线性帧缓冲模式（8/16/32 bpp，到 1600×1200 以上），模式设置写
  NV 扩展 CRTC 与 PRAMDAC。
- NVIDIA 表格：PCI 数据结构、BIT 表（BIOS 版本、初始化表、PLL 限制、显存、显示）、DCB 3.0（一个 CRT
  在 DAC A，I2C 端口 0）、I2C 端口表、最小的初始化脚本（只有结束指令）、校验和。确切版本与字段以
  envytools/nouveau 的解析代码为准，测试中用移植的解析器检查 ROM。
- G0 确定驱动依赖哪些表、哪些 int 10h 调用（98 的驱动可能通过 BIOS 切换模式），G1 补齐。

## 3D 翻译

设备看不到客体用的是哪个 API。D3D5–7（经 DirectDraw 与 `d3dim700.dll`）、D3D8、D3D9 与 OpenGL ICD
都由 NVIDIA 驱动降成同一种东西：`NV40_3D` 的方法流加 VP/FP 微码。固定功能的变换、光照与纹理阶段
由驱动编译成 NV40 程序（NV40 没有固定功能的流水线），所以设备只需要一个翻译器，D9WG 执行器的
固定功能路径不会用到：每次绘制都带着顶点与像素着色器。

### 状态映射

| NV40_3D 方法组 | 对应的 D9WG | 说明 |
| --- | --- | --- |
| 渲染表面（格式、行距、偏移、DMA；最多 4 个颜色目标）、深度/模板表面 | `SET_RENDER_TARGET`、深度表面 | 由表面缓存按显存区间找到或创建；swizzled 渲染表面（立方图、RTT）单独标记 |
| 视口、裁剪、窗口偏移、裁剪平面 | `SET_VIEWPORT`、`SET_SCISSOR_RECT`、`SET_RENDER_STATE` | 见“坐标约定” |
| 混合、alpha 测试、深度、模板（含双面）、剔除、填充模式、多边形偏移、点精灵、颜色写掩码、sRGB | `SET_RENDER_STATE` | |
| 雾（模式、方程系数、颜色）、平面/平滑着色 | `SET_RENDER_STATE`，或在片段着色器的尾部计算 | NV40 的雾在片段程序之后由固定单元应用；D3D7/8 游戏的表雾与顶点雾都走这里，G3 验收 |
| 纹理单元（偏移、DMA、格式、尺寸、mip、wrap、过滤、各向异性、边框、立方与体纹理、深度比较） | `CREATE_TEXTURE_*`、`UPDATE_TEXTURE`、`SET_TEXTURE`、`SET_SAMPLER_STATE` | 纹理缓存；比较模式用于硬件阴影图 |
| 顶点数组（每个属性的格式、步长、偏移、DMA 选择）、索引数组 | `CREATE_VERTEX_DECLARATION`、`CREATE_BUFFER`/`UPDATE_BUFFER`、`SET_STREAM_SOURCE`、`SET_INDICES` | 按区间缓存；内联顶点与内联索引另行拼成缓冲 |
| 顶点程序上传、常量上传、起始位置、属性/输出使能 | `CREATE_VERTEX_SHADER`、`SET_VERTEX_SHADER_CONSTANT_F` | 见“着色器” |
| 片段程序地址与控制 | `CREATE_PIXEL_SHADER`、`SET_PIXEL_SHADER_CONSTANT_F` | 内联常量见“着色器” |
| BEGIN/END、顶点批、索引批 | 绘制 | 四边形、四边形带与多边形在设备里转成三角形列表（D3D9 没有） |
| 清除（颜色与深度/模板的清除值） | `CLEAR` | |
| 查询（遮挡计数、报告写回内存） | `CREATE_QUERY` 与读回 | 结果写入客体内存后，相关的通知器/信号量才完成 |
| ZCULL、Z 压缩、tile 区域 | 无 | 只存值；对结果透明（关键决定 5） |

### 坐标约定

NVIDIA 驱动自己计算视口变换（`VIEWPORT_SCALE`/`TRANSLATE`、窗口偏移、像素中心），而 D9WG 按 D3D9
的约定接收视口。设备从 NV 的变换反推等价的 D3D9 视口；反推不了的情形（非标准的像素中心或子像素
偏移、超出目标的视口）用协议 1.8 的私有视口命令把 NV 的变换直接交给执行器，由顶点着色器的尾部
应用。G3 用参考图（见“测试”）校准。

### 着色器

- **顶点程序**：NV40 VP 的微码（每条 128 位，经方法上传到片上程序存储），翻译成 vs_3_0 字节码。
  - 寄存器映射：输入 v0–v15 按顶点声明合成语义；常量 c；输出位置、两种颜色与两种背面颜色、雾、
    点大小、8 组纹理坐标、裁剪距离。
  - 背面颜色在 D3D9 里没有，用两组颜色加片段着色器中的 `vFace` 选择。
  - 地址寄存器与条件码用 D3D9 的地址寄存器、谓词寄存器 p0 与临时寄存器模拟。
  - 分支（BRA/CAL/RET 加条件）先结构化成 if/loop/call：NVIDIA 编译器从 D3D 的结构化着色器生成代码，
    控制流应当是可约的。不能结构化的程序记日志并跳过绘制（不画，而不是画错）。
  - 顶点纹理（`TXL`）用 vs_3_0 的 `texldl`。
- **片段程序**：NV40 FP 的微码（每条 128 位，程序在显存中，常量内联在指令之后），翻译成 ps_3_0。
  - 输入：WPOS → `vPos`，COL0/1、FOGC、TEX0–9，FACING → `vFace`。
  - 输出：最多 4 个颜色目标，深度输出。
  - 精度：半精度与定点按 fp32 计算（偏差记入 [gpu-deviations.md](gpu-deviations.md)）。
  - 条件码、KIL、各种纹理指令（TEX/TXP/TXB/TXL/TXD 与深度比较）、DDX/DDY、LIT/DST 等。
  - 打包/解包指令（PK2H/UP2H、PK4B/UP4B 等）D3D9 没有，用私有操作码，WGSL 侧用 `pack2x16float` 等实现。
  - 结构化的控制流指令（IF/ELSE/ENDIF、LOOP、REP、BRK、CAL/RET）直接对应 D3D9。
- **内联常量**：驱动改常量时会改写程序里的常量槽。翻译缓存的键是“去掉常量槽的指令字”，常量作为
  `c` 寄存器在每次绘制前送出，避免每个常量变化都编译一个新着色器。
- **编码来源**：Mesa nv30 驱动的 `nvfx_shader.h`、`nv30_vertprog.h`、`nv40_vertprog.h`、`nvfx_fragprog.c`
  （MIT）与 envytools 的指令集文档。
- **语料**：客体运行中出现的每个程序写入 `<out>/nv40-programs/`，挑选后存入
  `tests/gpu/shaders/nv40/`，作为单元测试的语料（与 TGSI 语料相同的做法）。

### 显存一致性

这是与 SVGA 最大的不同：SVGA 的客体用 DMA 命令显式搬运数据，NV40 的客体直接读写显存，而 3D 结果
在 WebGPU 上。

- **记录**：表面缓存为每个 GPU 侧对象（渲染目标、深度、纹理、顶点/索引区间、着色器）记下显存或
  系统内存区间、格式、布局，以及哪一方是权威（CPU 或 GPU）。
- **上传**：CPU 对 BAR1 的写入由设备内存的脏位图（`mmio_ram_mark_dirty`/`take_dirty`）记录；DMA、
  M2MF、2D 引擎与 PCI DMA 写入由设备自己标记；系统内存中的顶点与纹理在绘制时按需读取，并按区间与
  代数缓存。下一次使用一个脏了的对象时重新上传。
- **GPU 直接复用**：纹理的区间与一个 GPU 权威的渲染表面相同（偏移、尺寸与格式兼容）时，直接绑定
  那个 GPU 纹理，不经过显存（渲染到纹理、阴影图、HDR 与后处理都靠这一点）。格式重解释在 GPU 上
  复制。
- **下载**：GPU 写过的表面在以下时机读回显存：
  1. 扫描输出：可见画面所在区间是 GPU 权威时，每次翻页或 vblank 读回。这就是 SVGA 的“每次 present
     一次读回”（G-31），可选阶段 P1 改为不读回的合成器层。
  2. 驱动的同步点：REF_CNT、信号量释放、带通知的方法完成之前。v1 采用保守策略，读回所有自上次
     同步以来被 GPU 写过、且被标为“可能被 CPU 读”的表面。起初所有表面都标为可能，G6 按测量结果
     收紧（例如只读回之后被 CPU 访问过的区间所属的表面）。
  3. 2D 引擎或 M2MF 读到 GPU 权威的区间：能在 GPU 上做的（blit 到另一个 GPU 表面）用 `STRETCH_RECT`；
     否则先读回。
  4. 快照的 `prepare_save`：全部读回。
- **违约**：客体在没有同步的情况下读 GPU 权威的显存，读到旧字节。这种情况记日志，作为偏差记录。
  真实驱动在锁定表面前总会等待 GPU。

## 2D 与 DirectDraw

为什么 2D 在 CPU 上做，而不交给 WebGPU：

- **数据在显存字节里。** GDI 与 DirectDraw 的表面、主表面、客体 CPU 直接写的位图都在显存中，
  客体随时通过 BAR1 读写它们，扫描输出也从这里取画面。放到 GPU 上，几乎每个操作前都要上传、
  之后都要读回。
- **操作小而多。** GDI 的文字、小块填充、滚动每次只涉及几十到几千个像素。每次经渲染器通道往返
  （异步，可能跨线程）的延迟远大于 CPU 原地运算的微秒级开销，而驱动在 CPU 访问表面之前常会等
  2D 引擎空闲。
- **WebGPU 表达不了这些语义。** WebGPU 没有逻辑运算（ROP3 要在着色器里读目标，而 WebGPU 不能在
  渲染中读自己的目标），没有 565、555、4444 这类 16 位打包格式和 24 位打包格式，8 bpp 调色板模式
  本来就要在 CPU 上查表。
- **已有的适配器也这样做**：VMware SVGA 的 2D 在显存里，virtio-gpu 的 2D 资源在 CPU 侧。

例外：操作数在 GPU 上时（例如把 3D 后台缓冲 blit 到主表面的 present，或两个渲染目标之间的
StretchRect），在 GPU 上执行（`STRETCH_RECT`），见“显存一致性”第 3 条。G6 若测出大块 2D blit
（例如 DirectDraw 游戏每帧的全屏缩放）是热点，再把两个操作数都已在 GPU 上的情形移过去。

- 2D 类在 CPU 侧直接对显存字节运算：实色与图案填充、ROP3、色键 blit、GDI 文本（单色位图扩展）、
  IFC（CPU 推送的图像）、SIFM（缩放、YUV 转换）、M2MF（线性复制，含系统内存与显存之间）、
  swizzled surface。参考 Bochs 的 2D 实现（只读）与 nouveau 的 EXA/DDX 用法。
- 操作数是 GPU 权威的表面时按“显存一致性”的规则处理。
- DirectDraw 的翻页用 CRTC 起始地址；覆盖层（PVIDEO）在 V1。

## 快照

- `state[52]`：`["graphics_adapter", 1, "geforce_6800", 设备状态]`。设备状态包括 PCI 配置、各区块的
  寄存器、PFIFO 的通道与缓存、PGRAPH 的对象绑定与按通道的上下文、显示与 DDC 状态，以及显存
  （256 MiB，大部分是零页；大于 200 MB 的机器本来就走 `save_state_stream`）。
- `has_host_state` 为真；`prepare_save` 先等批次完成，再把 GPU 权威的表面读回显存。表面缓存与翻译
  缓存不进快照：恢复后渲染器 `reset`，对象在下一次使用时由显存重建。
- 恢复要求同一个适配器名与 `vram_size`；VGA BIOS 不同（ROM 的哈希不同）时给出警告。

## 界面

- [machine_options.js](../src/machine_options.js) 的 `GRAPHICS_ADAPTERS` 增加 `"geforce_6800"`，只用于 x86（i440FX，Q35 上不保证）；
  `vram_size` 只允许 128 与 256 MiB。
- VM 管理器的显示适配器下拉框、摘要（[describe.js](../src/app/ui/describe.js)）、配置校验与迁移随之更新；`make app-tests` 增加用例。
- 预设：XP 与 98 的 3D 预设是否默认用它，在 G7 由所有者决定（见“待所有者决定”）；
  在此之前它只是可选项。
- `v86.d.ts`、starter、CPU Worker、构建入口（`make graphics-adapters`、`tools/pages_dist.mjs` 的插件列表）
  照其他适配器处理。

## 阶段

每个阶段都写明交付物、验收条件和测试。客体验收见“测试”。

### G0 探路：驱动跟踪与可行性

1. 一个空壳设备：PCI 身份、BAR、ROM（先用最小的 SeaVGABIOS 加 BIT/DCB 表），每次寄存器、ROM、
   RAMIN 访问都记日志，未实现的寄存器读回 0 或已知默认值。
2. XP + 93.71 与 98 + 81.98 各装一次驱动，记录：驱动是否接受 PCI 模式；读了 ROM 的哪些表、
   哪些 int 10h；初始化序列；用到的对象类；上下文映像是否被驱动读写；崩溃或停住的位置。
3. 产出：`docs/geforce-6800-plan.md` 的复核结论一节，列出驱动访问的寄存器清单（实现或只存值）、
   PCI/AGP 的结论（需要 AGP 时启动 A1）、对 G1–G4 的修正。

验收：两种驱动都走到“设备已初始化，开始建立 FIFO 通道”，或者有明确的阻塞原因与对策。

### G1 VBIOS、显示与驱动加载

- 完整的 VGA BIOS（VBE、NVIDIA 表格）、显示（扩展模式、VPLL、光标、DDC/EDID、vblank）、PMC/PTIMER/PFB。
- PFIFO 与 PGRAPH 先实现到驱动不报错的程度（通道建立、对象绑定、通知器）。

验收：

- XP 与 98 的桌面在 NVIDIA 驱动下以 1024×768×32 显示，设备管理器无问题代码；
- 显示属性能切换分辨率与色深（含 98 的 8 bpp）；
- 98 的 DOS 全屏切换来回正常；
- 快照往返。

### G2 PFIFO 与 2D 加速

- 完整的 DMA pusher 与 puller、信号量、REF_CNT、错误中断；全部 2D 类。

验收：

- XP 的 GDI 加速开到最高无绘制错误（窗口拖动、文本、滚动）；
- DxDiag 的 DirectDraw 测试通过（XP；98 装好 DirectX 9.0c 后）；
- 2D 单元测试的参考结果一致。

### G3 3D 基础

- `NV40_3D` 的状态、表面与纹理缓存、绘制、清除、坐标约定；VP/FP 的直线代码（无分支），覆盖驱动为
  固定功能生成的程序；D9WG 协议 1.8。

验收：

- DxDiag 的 Direct3D 7/8/9 测试画面正确；
- XP 与 98 上 3DMark99 MAX 与 3DMark2000 跑完，画面与参考一致。

### G4 着色器与 SM3.0

- VS/PS 1.x–3.0 全部指令、结构化、条件码、顶点纹理、多渲染目标、FP16 混合与过滤、深度比较、遮挡查询。

验收：

- 3DMark2001 SE（PS 1.1/1.4）、3DMark03（PS 2.0）、3DMark05 跑完；
- 3DMark06 跑完：SM2.0 测试与 HDR/SM3.0 测试都有分数；
- 特性测试（填充率、像素着色器、顶点着色器、Shader Particles、Perlin Noise）结果合理，参考图一致。

### G5 Windows 98 完整验收

- 81.98 下 3DMark99 MAX、2000、2001 SE、03；16/8 bpp 模式下的 DirectDraw 游戏抽查；DOS 全屏；
  调色板纹理缺失按真卡记为客体说明。

### G6 一致性与性能

- 从保存的状态测量（[profiling.md](profiling.md) 的方法，release 构建），按热点优化：上传缓存、
  下载收紧、FIFO 解析、翻译缓存命中率。
- 3DMark06 在 XP 上的时间分布报告，写进 [gpu-devices.md](gpu-devices.md) 的 Performance。

### G7 集成与文档

- 界面与预设、[gpu-devices.md](gpu-devices.md) 新增 “GeForce 6800 GT” 一节（设备、驱动、测试）、
  [gpu-deviations.md](gpu-deviations.md) 的偏差条目、[windows-9x.md](windows-9x.md) 与 [windows-nt.md](windows-nt.md) 的驱动安装说明；
  本计划改为“已完成”并精简。

### 可选阶段

- **A1 i440BX 与 AGP**：只在 G0 证明驱动必须有 AGP 时做。i440BX 主桥与 AGP GART（APBASE、APSIZE、
  GART 表），98 与 XP 自带的 440BX AGP 驱动；设备声明 AGP capability（Bochs 用 `0x1F000007` 的
  AGP 状态）。
- **V1 PVIDEO 覆盖层**：XP/98 的视频播放（YUV 覆盖、缩放、色键）。
- **P1 扫描输出不读回**：3D 扫描输出直接进合成器层（virtio-gpu 已有的做法）。
- **O1 OpenGL 验收**：用所有者提供的 OpenGL 游戏镜像（例如 Quake III）验收 ICD 路径。
- **W1 Vista/7**：NVIDIA 的 WDDM 驱动（GeForce 6/7 有 Vista/7 版）在同一硬件上，需要额外的显存管理语义。

## 测试

| 层 | 位置 | 运行方式 |
| --- | --- | --- |
| PCI、BAR、BAR0 分发、PMC 中断、PTIMER、RAMIN 映射、DDC/EDID、快照 | `tests/devices/geforce_6800.js` | `make devices-test` |
| DMA pusher（各种方法头、JUMP/CALL、错误）、RAMHT、通道切换、信号量 | `tests/devices/geforce_6800_fifo.js` | `make devices-test` |
| 2D 类：对小块显存执行操作，与手算的参考字节比较 | `tests/devices/geforce_6800_2d.js` | `make devices-test` |
| VGA BIOS：用移植的 nouveau 解析器检查 BIT/DCB/I2C/PLL 表；VBE 模式表 | `tests/devices/geforce_6800_bios.js` | `make devices-test` |
| VP/FP 翻译：手写编码与语料，经 D3D9 管线得到 WGSL，用 naga 校验（与 `dxbc_wgsl_test.js` 相同的规则） | `tests/glbridge/nv40_program_test.js` | `make test-glbridge` |
| 3D 层在真 GPU 上：录下的 push buffer 与显存快照，经设备与渲染器，比较读回的像素 | `tests/glbridge/nv40_*_browser_test.html` | `make display-browser-tests` |
| XP 客体 | `tests/devices/geforce_xp.mjs` | 手动 |
| 98 客体 | `tests/devices/geforce_win98.mjs` | 手动 |

CI 运行 `make devices-test` 与 `make test-glbridge`，浏览器与客体测试手动运行（与现有 GPU 测试相同）。

### 客体测试

- **写法**照 [usb_windows_xp.mjs](../tests/devices/usb_windows_xp.mjs)：
  - 镜像只读打开（`ReadOnlyOverlayDisk`），结束时检查修改时间未变；
  - 工具盘是内存中的 FAT16；
  - 截图写到 `<out>`；
  - 3D 用远程渲染器（`tests/x64/gpu_remote_renderer.mjs`，无头 Chrome 的 WebGPU）。
- **驱动安装 fixture**：
  - 首次运行时把驱动安装包解开放进工具盘，由启动器运行静默安装（NVIDIA 安装程序的 `-s`；
    不行时用 INF 安装）并重启；
  - 关机后保存 overlay（Windows 8.1 harness 的 `WIN_OVERLAY_SAVE`/`LOAD` 做法），之后的运行从 overlay 开始；
  - 3DMark 的注册也保存在 overlay 里。
- **环境变量**：

  | 变量 | 含义 |
  | --- | --- |
  | `XP_IMAGE` | XP 镜像，默认为所有者的 XP 镜像 |
  | `W98_IMAGE` | 98 镜像 |
  | `NV_DRIVER` | 驱动安装包 |
  | `NV_HDB` | 3DMark 镜像（第二块盘） |
  | `NV_OVERLAY_SAVE`、`NV_OVERLAY_LOAD` | 保存或加载 overlay |
  | `NV_GPU_RENDERER=chrome` | 渲染器放在无头 Chrome 里 |
  | `NV_OUT` | 输出目录 |
  | `TEST_RELEASE_BUILD` | 用 release 构建 |

  XP 的配置与 XP 性能门禁相同：i440FX、IDE、无 ACPI，内存 1024–2048 MB。
- **3DMark**：
  - 注册后运行默认测试与特性测试；
  - 若 UL 公布的密钥解锁的版本带 Image Quality 工具（渲染指定帧到文件），用它取固定帧，
    否则在固定时间点截屏。
- **参考图**：同一镜像用现有的 D3D9 代理（[glbridge.md](glbridge.md)）渲染同样的帧作为 D3D9 级的参考，
  比较时允许按像素的小误差。两条路径的差异指向 NV40 翻译的错误。
- **驱动跟踪**：`nvlog on|off` 命令把 FIFO 方法、PGRAPH 错误与未实现寄存器的访问作为事件输出（与
  SVGA 的 `svgalog` 相同的做法）；`nvprograms` 导出 VP/FP 语料。

## 测试镜像

| 客体或素材 | 本地是否有 | 用于 |
| --- | --- | --- |
| Windows XP SP3 | 有：`retro-gaming-site/windowsxp/windowsxp_multidisk_C_4G.img`（XP 性能门禁所用）与安装 ISO | G0–G4、G6 |
| Windows 98 SE | 有：`retro-gaming-site/windows98/windows98hdd.img` 与安装 ISO；需装 DirectX 9.0c 运行库（微软官方的最后一版支持 98 的再发行包） | G0–G2、G5 |
| 3DMark03、05、06 | 有：`retro-gaming-site/game/3dmark03.img`、`3dmark05.img`、`3dmark06.img`（已核对不含 D3D9 代理的 DLL） | G4 |
| 3DMark99 MAX、2000、2001 SE（与 Everest） | 有：`retro-gaming-site/game/3dmarklegacy.img` | G3–G5 |
| 3DMark 注册码 | UL 官方 [legacy benchmarks](https://benchmarks.ul.com/legacy-benchmarks) 页面公布 | G4 |
| ForceWare 81.98（Win9x）、81.98（XP）、93.71（XP）、307.83（XP） | 没有：所有者从 NVIDIA 官方存档下载 | G0–G5 |
| OpenGL 游戏 | 没有：所有者提供 | O1 |

各版 3DMark 的系统要求不同：98 上测 99 MAX、2000、2001 SE、03；05 与 06 只在 XP 上测。

## 风险

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 闭源驱动依赖未文档化的寄存器或时序 | 驱动初始化失败或停住 | G0 的跟踪；Bochs 的实现可对照（它让驱动走到了桌面） |
| 驱动拒绝 PCI 模式的 NV40 | 要做 AGP | A1 |
| 驱动依赖 ctxprog 的执行结果或上下文映像 | 通道切换后状态错 | G0 检查；按跟踪实现上下文映像的字段 |
| 自己的 VBIOS 缺少驱动需要的表 | 无输出、模式错或 PLL 错 | 用 nouveau 解析器检查；G0 记录驱动读取的偏移 |
| VP 中不可结构化的控制流 | 个别绘制缺失 | 记日志、跳过；必要时在执行器中加分派循环的私有形式 |
| NV 与 D3D9 的坐标约定差异 | 画面偏半个像素、边缘错误 | 私有视口命令；参考图校准 |
| 显存一致性的保守下载太慢 | 帧率低 | G6 按测量收紧；GPU 直接复用渲染表面 |
| 性能：FIFO 解析与翻译在 JS 中进行 | CPU 侧开销 | 翻译缓存（内联常量去除后的键）、按区间的上传缓存、批量提交；G6 测量 |
| 98 的老游戏缺调色板纹理 | 部分 DX5/6 游戏贴图错 | 真卡行为，记入客体说明；需要时 98 预设继续用其他适配器 |

## 待所有者决定

1. 适配器名 `"geforce_6800"`（Bochs 用 `geforce6800`）是否合适。
2. 默认显存 256 MiB（可选 128 MiB）。
3. XP 的主驱动用 93.71 还是 307.83。
4. G0 若证明需要 AGP，是否做 A1（i440BX 机器类型）。
5. XP 与 98 的预设在 G7 后是否默认用它。
6. D9WG 协议升到 1.8（私有操作码与视口命令）。
7. 是否做 O1、V1、W1。

## 建议的首批提交

1. G0 的空壳设备与跟踪工具、最小 VGA BIOS 与表格构建脚本；在 XP 与 98 上的跟踪报告与本计划的复核。
2. G1：显示、VGA BIOS、驱动加载；`graphics_adapter: "geforce_6800"` 的选项、`v86.d.ts`、插件构建。
3. G2：PFIFO 与 2D；设备单元测试。
4. G3：3D 状态、表面缓存、直线代码的程序翻译、D9WG 1.8；浏览器测试。
5. G4：完整着色器与 SM3.0；3DMark 全部验收。
6. G5、G6、G7。

G1 之后，2D（G2）与程序翻译器（`nv40_program.js` 与它的单元测试，只依赖语料）可以并行。

## 规范与实现参考

- [envytools 文档](https://envytools.readthedocs.io/)与 [rnndb](https://github.com/envytools/envytools/tree/master/rnndb)：寄存器、FIFO、PGRAPH、VBIOS 表格（MIT）
- [nouveau](https://gitlab.freedesktop.org/drm/nouveau)：`nvkm/engine/fifo/nv40.c`、`nvkm/engine/gr/nv40.c` 与 `ctxnv40.c`、`nvkm/subdev/bios/`（BIT、DCB、PLL、init）（MIT）
- [Mesa nv30 驱动](https://gitlab.freedesktop.org/mesa/mesa/-/tree/main/src/gallium/drivers/nouveau/nv30)：`nv30-40_3d.xml.h`、`nvfx_shader.h`、`nv40_vertprog.h`、`nvfx_fragprog.c`、格式表（MIT）
- [Bochs GeForce 模拟](https://github.com/bochs-emu/Bochs/blob/master/bochs/iodev/display/geforce.cc)与[使用说明](https://bochs.sourceforge.io/doc/docbook/user/geforce-notes.html)（LGPL，只读参考）
- [xemu NV2A](https://github.com/xemu-project/xemu/tree/master/hw/xbox/nv2a)：表面缓存与着色器翻译的做法（GPL，只读参考）
- [pci-ids：10de:0045 = NV40 GeForce 6800 GT](https://admin.pci-ids.ucw.cz/read/PC/10de/0045)
- ForceWare 81.98 的 Win98/ME 支持列表（[TechSpot](https://www.techspot.com/drivers/driver/file/information/6808/)）、[NVIDIA 81.98 XP 版](https://www.nvidia.com/en-us/drivers/winxp-2k-8198/)、[Vogons：7 系列在 9x 下与 81.98 INF](https://www.vogons.org/viewtopic.php?p=471265)
- [Vogons：Catalyst 6.2 Win9x 不含 R5xx](https://www.vogons.org/viewtopic.php?p=1360576)
- [UL legacy benchmarks](https://benchmarks.ul.com/legacy-benchmarks)：3DMark03/05/06 的下载与注册码
- v86 内部：[gpu-devices.md](gpu-devices.md)（插件、渲染器通道、D9WG、测试与远程渲染器）、[gpu-deviations.md](gpu-deviations.md)、[glbridge.md](glbridge.md)（D3D9 代理与协议）、[display-design.md](display-design.md)、[profiling.md](profiling.md)
