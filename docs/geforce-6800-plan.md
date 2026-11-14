# GeForce 6800 GT（NV40）显示适配器实施计划

状态：实施中；XP/Win98 原生驱动、显示、DirectDraw 和 DxDiag 已验证，完整 3DMark 图像与性能门禁未完成。2026-10-26 初稿；2026-11-13 开始实现。所有者决定模拟 AGP 版 GeForce 6800 GT，当前在 i440FX 上以 PCI 模式运行。

### 实施记录（2026-11-13）

- G0.1：增加可加载的 `geforce_6800` 插件、PCI/PM 身份、三个 BAR、PBUS 配置镜像、末端
  1 MiB RAMIN 别名、PMC 中断、PTIMER 基础、快照和有界访问跟踪。未知寄存器只保存值，
  跟踪中标为未实现。`nvlog(true/false)` 和 `nvtrace()` 在插件设备对象上提供给测试工具。
- 已验证：SeaBIOS 启动到文本、PCI BAR 探测与重定位、内存解码、PBUS 写入的 PCI 语义、
  RAMIN/VRAM 别名、W1C 字节写、快照往返。运行 `node tests/devices/geforce_6800.js`。
- G0 尚未验收：XP/98 驱动初始化仍未完成；PCI 模式兼容性尚无结论。
  `BOOT_0=0x040500A1`、子系统 `10DE:0045`、strap 和 PTIMER 时钟比率是待驱动跟踪复核的值。
- 本地 `geforce.iso` 只包含 56.64（NV40 之前）。已获所有者授权下载所需 ROM 和驱动；测试素材
  放在忽略目录 `build/nv40-fixtures`，不随源代码分发。
- G0.2：独立探路 ROM 从 SeaVGABIOS rel-1.16.2 构建（`bios/nv40/build.py`、`tables.S`），
  预留 `0x36` 的 DCB 指针，带 BIT/i/I、终止初始化脚本、单 CRT DCB 与 CRTC DDC 表。
  描述符的 `vga_bios` 提供默认路径，显式 `vga_bios` 可以覆盖；专属 ROM 不再经过 PCI ID 修补。
  CPU Worker 保留页面的 ROM 路径基准，PCI 核心保留 ROM BAR 使能位。
- 已验证 G0.2：ROM/PCIR/BIT 校验和及表指针、默认 ROM 的文本启动、PROM 使能、设备快照；
  `node tests/devices/geforce_6800_bios.js`、`node tests/devices/geforce_6800.js`，
  `node tests/devices/graphics_adapter.js`；插件 Closure 构建 0 errors/warnings。
- 官方驱动已下载并解包：XP 93.71 的 INF 与 Win98 81.98 的 NVAGP.INF 均包含 `DEV_0045`。
  XP 安装包 SHA-256 `1fdf456054bfa91e307b052324aebcc4210c9ec23e5d50aea11e943ec7408092`；
  Win98 安装包 SHA-256 `e05b92b1322f8d01549995ddd00a9dca93d83358ee78e868acedca9dc6c7c910`。
- G0.3：`tests/devices/geforce_xp.mjs` / `geforce_win98.mjs` 使用真实官方 INF、只读原盘、
  内存 FAT16 工具盘、原生 SetupAPI 探针，输出截图、设备问题码和有界跟踪；
  `NV_OVERLAY_SAVE/LOAD` 保存/加载 Node v8 序列化的扇区 overlay，仅用于此 harness。
  `NV_SECONDS` 控制调查时限，`NV_LAUNCH_SECONDS` 控制桌面后启动时机，`NV_ROM` 可覆盖 ROM。
  驱动可传安装包或解包目录；SZDD 文件名按原版 INF 恢复。尚不自动关机/重启，
  overlay 是暂停时的扇区副本，不把它当作干净关机的已安装驱动 fixture。
- XP 93.71 的第一轮硬件跟踪见 `docs/fixtures/nv40/g0-xp-9371.json`：设备识别正确，
  原盘未变，但未完成安装。驱动大量轮询 `0x3304`、`0x3250` 和 PTIMER；
  `0x3304` 应是只读的 3，空壳返回 0；VGA MMIO 镜像仍是存值。对策是补齐这两项再复测。
  这证明驱动走到了硬件访问，**不能**证明 PCI 模式最终可用，也不能据此启动 A1。
- Win98 81.98 的第一次原生探针能运行，但其 26 个 SetupAPI 设备没有匹配到 NV40 的硬件 ID；
  未执行驱动安装，尚需检查 PCI 枚举及 Win9x 的设备发现路径。不是驱动加载成功的证据。
  后续原生注册表检查确认 `HKLM\Enum\PCI` 不存在（错误 2），枚举只有 PNP/ISA 设备。
  需先在该镜像的 overlay 中安装微软 PCI bus，再进行 NVIDIA 驱动验收。
- G1.1（显示前置工作，G1 未验收）：VGA 端口与 NV MMIO 镜像、扩展 CRTC 解锁、
  8/15/16/32 bpp 线性扫描、CRTC 起始地址在 vblank 生效、单级 VPLL 时序、vblank 中断、
  单 CRT 的 GPIO I2C EDID（重复 START、ACK/NACK）与显示状态快照已实现。
  同时修正 G0 跟踪发现的只读 `CACHE1 UNK104=3`。小块真实 VRAM 的逐字节像素结果、
  完整 128-byte EDID、端口/MMIO 别名、页翻转及锁寄存器已通过设备测试。
  硬件光标、gamma、多级 PLL、NV VBE 后端、驱动加载和客体验收仍待实施。
- 管理器前置集成：GeForce 标为 experimental，选择时将不兼容的显存改为 256 MiB，
  只提供 128/256 MiB；配置校验、摘要和默认专属 ROM 一致，显式自定义 ROM 保留。
  `tests/app/vm_config.mjs`（138 条校验规则）和 `tests/app/presets.mjs`（780 种组合、
  5000 次随机更改）通过。源码及构建插件的 NV40 设备测试均通过。
  完整 `make app-tests` 的 iOS 控制器类型阻塞已用一个字符串类型标注修正，`make app-check`
  通过；浏览器的存储、x86 页面与 FreeDOS/Linux 向导通过，arm64 向导等待 shell 超时，
  完整应用套件仍未通过。NV40 插件本身 Closure 构建通过。
- G1.2（PFIFO 前置）：根据 XP 下一处等待点，增加 DMA 实例装载与 CACHE1 的
  `DMA_CTL/VALID`、LIMIT、PTE 缓存；非法实例触发 DMA_PUSHER 中断。DMA 访问实现
  显存/PCI RAM、线性/分页映射、页内调整、包含末字节的 limit、方向/页权限、PCI bus master
  检查；跨页写先验证完整范围，失败不留下半个通知器。
  `tests/devices/geforce_6800_dma.js` 与设备寄存器集成测试通过。完整 FIFO pusher/puller、
  RAMHT、RAMFC、PGRAPH 与 2D 类仍未实现，G2 尚未开始验收。
- G1.3：PTIMER 按硬件保存 56-bit counter（timestamp bits 5–60），高/低位写入生效，
  超过 JS Number 精确范围的时间戳与快照保持精确；计数、闹钟和比例寄存器保留硬件位宽。
  VRAM BAR 随 PCI memory decode 与上游转发开关映射；PM capability 的只读字段受保护。
  设备测试覆盖高时间戳往返、低 5 位清零、显存解码关闭/恢复及 PMCSR 掩码。
- 最新客体验证：`docs/fixtures/nv40/g1-xp-9371.json` 与
  `g1-xp-9371-registers.json` 保存复测结论和 469 项 MMIO 地址/读写方向清单，标明访问时走的是
  实现路径还是存值/默认值。`g0-win98-8198.json` 保存 Win98 原生设备和 PCI 注册表证据。
  使用 `node tools/nv40_trace_report.mjs <trace.json> <report.json>` 可重新生成清单。
  原始 RAMIN、跟踪、驱动包及截图留在 `build/nv40-*`，不分发 NVIDIA 固件或微码。
- **G1 门禁仍未通过**：XP 93.71 已完成设备初始化（下列续修记录），Win98 已枚举 NV40；
  两者的 NVIDIA 桌面显示与加速尚未验收。不能把单元测试通过称作完整驱动可用。
  下一步实现引擎启停/复位、通道/上下文语义和 NV VBE/BIOS 表；
  G2 的 2D、G3/G4 的 D9WG/着色器与 G5/G6/G7 最终验收均未完成。
- PFIFO 调查续修：93.71 miniport 的初始化路径清除 `DMA_CTL.VALID` 后轮询该位变为 1。
  现实现清除后的实例缓存重新装载（包括 PUSH 停止时）；VALID 表示取回实例完成，
  DMA 类/页权限在实际访问时检查，不能把尚未填入对象的零实例误判为装载失败。
  寄存器测试覆盖停推时失效/重取、内容更新、零实例与越界实例；DMA 测试及插件构建通过。
- PROM 续修：BAR0 的 PROM 窗口独立于 expansion-ROM BAR；按 Nouveau 的
  [shadowrom 实现](https://github.com/torvalds/linux/blob/master/drivers/gpu/drm/nouveau/nvkm/subdev/bios/shadowrom.c)
  由 PBUS `0x1850` bit 0 控制读取。此前错误的 ROM BAR 门控使 XP 读到首字节 0，跳过 ROM 表。
  已修正并覆盖 ROM BAR 关闭时读取、PBUS 禁用/恢复的设备测试；插件构建通过。
- Win98 PCI 枚举已修复并有客体证据：在只读原盘的 overlay 中用配置管理器创建实际
  `ROOT\*PNP0A03\0000` 节点，安装原版 MACHINE.INF 的微软 PCI bus。Win9x 的
  SetupAPI phantom 节点无法按 NT 路径注册；CM 的 `DO_NOT_INSTALL` 标志也不受支持。
  `pci.vxd/pcimp.pci` 从所有者安装 ISO 提取，不进仓库。探针兼容尚无 HardwareID 属性的
  新节点，通过设备实例 ID 识别 PCI 身份。客体已枚举 NV40、i440FX、PIIX 与 IDE，见
  `docs/fixtures/nv40/g0-win98-pci-bus.json`。NVIDIA 驱动选择/加载仍待验证。
  harness 的 `NV_WIN98_ISO` 可指定安装 ISO；`NV_STATE_SAVE/LOAD`、可选
  `NV_STATE_SAVE_AT` 保存/恢复调查快照，`NV_CONTROL` 接受 Run 命令或 JSON `keys` 扫描码。
  定期输出 progress-trace，XP 禁用 overlay 内的自动崩溃重启，便于保留故障证据。
- XP 设备初始化已通过：PFIFO 续修后产生的 `0x7f / divide error` 转储定位到 miniport
  RVA `0x151581` 的 tiled-pitch 计算；PFB 的零 column 配置导致除零。增加一致的启动后
  显存几何配置（四个 64-bit 分区、GDDR3、8 column bits、12/13 row bits，128/256 MiB），
  快照 v4 向旧快照补齐此前缺失的字段。93.71 安装返回成功、无需重启；原生设备报告
  `problem=0 cm=0 started=1 service=nv`，见 `g1-xp-9371-initialized.json`。
  当前屏幕仍是 640×480；下一步验证显示驱动接管、1024×768×32 与 FIFO 命令。
- PFIFO 通道前置实现：`nv_fifo.js` 增加 128-byte NV40 RAMFC 保存/恢复、32 通道 USER
  新旧窗口、DMA pusher 的递增/不递增方法与 JUMP/CALL/RETURN、缓存背压、预算让出、
  RAMHT、REF 与 DMA 信号量 acquire/release、错误中断和快照 v5。
  测试覆盖跨通道 REF、控制流、散列失败、缓存满/恢复、非法命令、DMA 越界、
  自跳转预算及 acquire 挂起后的快照恢复。XP 重启跟踪已解码第一批方法：
  子通道 6 绑定 clip 类 `0x19` 后提交 `0x300`；此前只写 PUT、GET 不动的问题已推进。
  PGRAPH/2D 类仍待实现，当前会报告未实现方法而非伪造完成；G1/G2 尚未验收。

- PGRAPH 上下文前置：增加按通道/实例隔离的对象状态、clip/ROP/pattern/beta/surface
  上下文方法、精确 PTIMER 通知器、DMA 全范围检查、非法方法陷阱、中断确认、上下文程序
  存取与快照 v6。NV40 中断使能修正为 `0x40013c`，NOTIFY 使用 `0x104`。
  `geforce_6800_graph.js`、寄存器/扫描输出/快照测试和插件构建通过。XP 已继续提交
  GDI、blit、IFC、SIFM 与 line 等类；其绘制尚未实现，仍按非法方法报告，G2 未验收。

- PFIFO 软件对象续修：XP 用 RAMHT engine 0 的软件 DAC 对象设置显示时序；这类对象的
  后续方法必须继续触发 PFIFO DEVICE_SOFTWARE，由 miniport 执行，不能当作 PGRAPH
  的零类对象解释。已补上按子通道 engine 路由和回归测试。

- CPU 2D 第一部分：实现线性 surface 的 8/16/32-bit GDI 矩形、ROP3、图案取样、
  clip/色键与重叠安全 blit、PCI RAM/VRAM 间的 M2MF 逐行复制和完成通知器。
  全部目标行与通知器先验证再写入；测试覆盖 256 种 ROP3 的所有输入组合、
  重叠和裁剪、像素宽度、M2MF 非连续 pitch 与末行故障不留下部分写入。
  插件构建通过。IFC/单色文字、缩放/YUV、混合与 swizzle 仍待后续步骤，G2 未验收。

- CPU 2D 第二部分：增加 IFC/INDEX 的逐行上传、DWORD 行填充、输出裁剪、色键和
  LUT 取色，GDI 透明/不透明单色展开与 CGA6/LE 位序；上传进度进入现有对象快照。
  测试覆盖 RGB565 非整 DWORD 行、半行保存/恢复、裁剪后的像素位置和两种单色位序；
  2D 测试与插件构建通过。SIFM/SIFC、线/三角形、混合和字体 DMA 尚未完成。

- CPU 2D 第三部分：增加 SIFM 最近点/双线性取样、12:20 步长与 12:4 起点、
  RGB/AY8/Y8 和两种打包 YUV 的颜色转换，矩形 Morton surface、beta/预乘混合。
  测试比较 2×2 到 4×4 的像素中心取样、YUV 黑白端点、非方形 Morton 字节布局和
  预乘 source-over；全部 2D 测试和插件构建通过。XP 的真实命令已生成登录画面；
  尚需桌面/模式切换与完整 G2 客体验收。

- XP 文字流续修：GDI 各 primitive 共用 clip/color/image 状态；驱动可通过 E 的参数
  方法配置 C 的透明单色数据。单色流按输入宽度连续推进，一个 DWORD 可跨多行，
  不能在每行重新对齐到 32 bits。增加这两项语义及跨两行的数据用例；2D 测试和构建通过。
  XP 已进入 800×600 桌面且原生设备仍为 `problem=0 / service=nv`；模式探针只扫描前
  512 项，未找到 1024×768×32，需要扩大枚举并实际切换，尚不能算 G1 验收。

- 显示续修：增加按 PRAMDAC BPC 选择的 6/8-bit DAC 端口/MMIO 读写、直接色 gamma、
  32/64-pixel ARGB 预乘/非预乘光标、1555 透明/XOR 光标、负坐标裁剪与双扫描，
  VPLL 第二级和 VPLL2 选择。gamma 随显示状态保存，旧快照缺失时恢复恒等映射。
  设备测试覆盖 gamma 分量、8-bit DAC 别名、光标 alpha/XOR/负位置和 PLL 周期变化；
  完整设备/快照测试及插件构建通过。

- NV VBE 前置：增加 PRMA 签名/地址/数据寄存器和 CRTC `0x38` 选择的实模式
  `0x3d0–0x3d3` 窗口，支持 8/16/32-bit 地址与部分数据提交、BAR0/VRAM 访问及
  越界保护；快照升级 v7。设备测试覆盖 16-bit 地址拆分、部分写到高字节后提交、
  显存读回和越界不回绕；完整设备测试及插件构建通过。专属 VBE 后端仍待接入。

- INDEX 续修：根据 hwtest 的合法值补齐 `INDEX_FORMAT` 的两种合法值（具体编码经后续原生流校正，见续修），
  LUT 按源颜色格式使用 16/32-bit 条目。增加索引上传、RGB565 LUT 和裁剪测试；
  2D 测试与插件构建通过，XP 复测已能绘制桌面图标。

- NV VBE 后端：SeaVGABIOS 通过自己的 NV 寄存器后端提供 640×480 至 1280×1024 的
  8/15/16/32 bpp、banked/LFB、pitch、display start、DAC 与扩展状态保存/恢复。
  增加 CRTC 1D/1E 的独立读/写 bank；XP 使用的 `PCRTC_CURSOR` 直接地址生效。
  `geforce_6800_vbe.js` 从自编引导扇区调用真实 INT 10h，验证模式查询、1024×768×32、
  banked 显存写、800×600×16 清屏和经文本模式的 VBE 状态往返；ROM 表检查、
  完整设备测试通过。固件源码与生成 ROM 同时更新；PLL 限制表及 Win98 驱动门禁仍待完成。

- 固件 PLL 表：增加 BIT/C v1 指向的 v0x20 PLL 限制记录，覆盖 NV40 core、memory
  与两路 VPLL，提供 13.5 MHz 参考频率及一致的 VCO/N/M/P 范围；VBE 求解器遵守 VCO
  范围。ROM 指针/字段测试和真实 INT 10h 模式、清屏及文本往返测试通过。

- CPU 2D 第四部分：增加 SIFC 的逐行输入、20-bit 小数缩放、12:4 起点和输出裁剪，
  IFC/INDEX 保留源 alpha 到混合阶段。测试覆盖 2×2 RGB565 输入水平放大与 ARGB
  预乘上传混合到 RGB565；2D 测试和插件构建通过。

- PGRAPH 通知确认续修：普通通知和 M2MF buffer 通知的 NSOURCE 位按各自的 INTR
  确认位清除，不能确认一类时丢失另一类；增加同时挂起两类通知的回归用例。
  DMA/状态故障另保留最多 64 条诊断原因，不进入设备快照。图形上下文测试及构建通过。

- 客体安装路径续修：Win98 为新 PCI 节点补齐真实 HardwareID，匹配官方 81.98 INF，
  使用原生文件队列复制文件；缺少驱动链接时在原生 class key 下分配未占用 slot。
  原生安装返回成功，PCI/驱动注册表经正常重启保留。补装 i440FX、PIIX ISA 与 IRQ
  steering 的微软驱动；当前 NVIDIA 节点仍报告 code 12，资源转储显示旧 `*PNP0900`
  还占有 VGA I/O/内存范围，必须继续处理，不能算 Win98 驱动加载成功。
  harness 增加只读安装 CD、`NV_REBOOT` 两阶段安装/复核、`NV_SKIP_INSTALL`、
  `NV_MODE_TEST`（枚举最多 8192 个模式）、屏幕重绘宽限和 PGRAPH/显示/FIFO 诊断。
  XP 93.71 原生模式测试/切换到 1024×768×32 成功且设备保持 started/problem=0，
  证据见 `g1-xp-9371-desktop.json`；Win98 重启后的问题码见 `g0-win98-8198-installed.json`。

- CPU 2D 第五部分：增加 NV40 LIN 的整数线段、32-bit 坐标、折线与逐顶点颜色，
  NV4 TRI 的独立/mesh 三角形、32-bit 坐标和实色方法。使用 Bresenham 与像素中心
  top-left 覆盖规则；测试验证线段终点排除、两个 XOR 三角形的公共边只覆盖一次。
  全部 2D 测试及插件构建通过。字体 DMA/完整客体验收与 3D 仍未完成。

- XP GDI 原生读回验收：新增可选 `NV_GDI_TEST`，在真实主表面填充、DSTINVERT 和
  透明文字绘制，再通过安装的显示驱动 GetPixel 读回并恢复原桌面。93.71 + 新固件
  冷启动、1024×768×32 下 `GDI_TEST failures=0`，设备仍为 started/problem=0，见
  `g2-xp-9371-gdi.json`。DirectDraw/DxDiag、字体 DMA 和 Win98 门禁仍未完成。

- VBE/DOS DAC 续修：返回传统模式时恢复 6-bit DAC 并关闭硬件光标；恢复 VBE 状态时，
  先恢复 DAC 精度再写标准 VGA 调色板。真实 INT 10h 测试覆盖非平凡的 8-bit 调色板、
  mode 3 的 6-bit 读回及 VBE 往返，`geforce_6800_vbe.js` 通过。

- PCI ROM BAR 续修：地址按 ROM 大小对齐，字节/字写保留其余字段；通用 VGA ROM 的
  映射随 BAR 地址、使能、PCI memory decode、上游窗口及快照恢复变化，PROM 仍独立。
  原先只改配置地址会使 Bochs 的 ROM 留在旧地址，现已一并修正。
  源码/release 的 NV40 与通用显示适配器测试、26 项 PCIe 测试及 Closure 构建均通过。

- IFC/INDEX 游标续修：POINT 方法开始一幅新图像，允许驱动复用原有的 SIZE_IN。
  先前仅在写尺寸时重置会把下一幅图的数据误报为 excess data；新增复用尺寸的
  INDEX 像素检查和 IFC 部分行状态检查，全部 2D 测试与插件构建通过。

- 原生诊断续修：Win98 探针输出各节点逻辑配置及 CM_Detect_Resource_Conflict，旧 VGA
  不可停用时走原生设备移除；工具盘预留 64 KiB 探针，`NV_PROBE_REPLACE` / `NV_PROBE_ID`
  支持在首次打开探针前的调查快照中替换代码，已用不同编号的真实探针验证。
  `NV_HOLD` 暂停自动启动探针/END 退出以便调查界面；跟踪包含 PCI 配置。
  可选 `NV_DDRAW_TEST` 使用原生 DirectDraw7 测试显存表面的填充、复制、ROP 和 Lock 读回，
  每个阶段记录标记；目前不能据此宣布 DirectDraw 通过。

- Win98 2D 初始化续修：接纳 GDI 字体 F/G 的字体/clip/color 参数别名。原生冷启动
  已到 81.98 的真实 GDI/INDEX 命令，首先在 0xFF4 被误报非法方法；修复后继续到
  INDEX 上传，确认编码应为 0=I8、1=I4。此前实现反了，32×32 的 I8 在 128 DWORD
  后便错误耗尽。已修正像素宽度、LUT 项数及索引提取；I4/I8（含第 128 项 LUT）
  与 GDI clip 别名测试、插件构建通过，客体复测进行中。

- NV40_3D 控制面前置：增加已知状态方法、544 个位置的顶点指令/常量上传与逐分量
  提交游标，部分指令随对象快照恢复。DMA fence 精确写一个 DWORD，校验 limit、
  权限、页对齐；不把 fence 当成 16-byte 通知器。PGRAPH、FIFO、DMA、设备测试和
  插件构建通过。draw/query/clear 尚未接入执行器，仍明确报未实现，G3 未验收。

- GDI 单色上下文续修：NV40 对象 word 1 的 bits 24…25 预置单色位序，驱动不必再发
  SET_MONOCHROME_FORMAT。XP/98 原生对象都预置 CGA6；此前缺省按 LE 导致未显式设置
  格式的文字错位。读取此上下文字段，并覆盖直接 RAMIN 初始化的像素测试；2D 测试与
  插件构建通过。

- 跟踪续修：PGRAPH 方法额外按通道保留最多 4096 项，记录对象实例、类、子通道、
  方法和值，避免桌面 MMIO 轮询淹没短暂的 DirectDraw 通道。历史使用环形缓冲，
  不进快照，关闭跟踪时不记录；边界/清空测试、设备测试与插件构建通过。

- I4 像素顺序续修：每个字节先取高 nibble，再取低 nibble，符合原生 4-bit DIB 流。
  先前相邻两个像素交换，导致 XP 的 I4 抗锯齿文字破碎；已更正提取与像素用例，
  全部 2D 测试和插件构建通过，客体图像继续复核。

- CACHE1 容量续修：NV40 有 512 个物理 cache entries，GET/PUT 的 wrap bit 位于 bit 11；
  此前误用 256 项和上半区别名，软件 DAC 陷阱恢复时会读错 cache 数据，令模式切换停住。
  扩展物理数组和指针位宽，并为 v1 FIFO 快照按队列顺序搬迁未完成方法。
  测试覆盖上半区、512 项背压、0xFFC wrap 和旧队列跨界迁移；设备/快照/构建通过。
  恢复此前卡住的 XP，27 秒内原生模式切换与 GDI 读回通过；DirectDraw 仍有像素/ROP 失败。

- Win98 原生初始化/模式/GDI 已通过：补齐 7010 的 MSHDC.INF 安装，测试探针可选
  `NV_AUTOSTART` 登记到 overlay 的 RunServices，在 `/auto` 启动时等待 60 秒并跳过重装，
  避免安装向导抢走 Run 的焦点。冷启动 81.98 报 problem=0 / started=1，59 个模式中
  找到 1024×768×32；模式测试与切换成功、GDI 读回 failures=0，原盘未变，见
  `g1-win98-8198-native.json`。完整桌面、8 bpp、DOS 和快照门禁继续验证。
  DirectDraw 探针改用自己的 IID 常量，避免链接整份 dxguid 使诊断 EXE 超出工具盘预留；
  返回值与阶段日志分开输出，并记录像素/位宽/pitch 和 ROP HRESULT。XP 已测到
  32-bit 表面黑像素与 DDERR_NORASTEROPHW，不能称作 G2 通过。

- 程序解码前置：`nv40_program.js` 解码 VP 的双发射/掩码/源寄存器与 swizzle、
  FP 的寄存器/条件/分支字段和指令后的内联常量；归一化代码排除常量内容。
  调试 `nvprograms()` 在 draw 开始时保留语料，防止驱动释放程序 BO 后只读到零。
  手写编码、常量边界、控制数据与常量的区分、BO 释放后语料保持测试和插件构建通过；
  `nv40_program_test.js` 自动纳入 glbridge 测试扫描。D3D9 字节码翻译和实际渲染尚待接入。

- IFC 即时上传续修：每个输入 DWORD 立即提交新像素，不能等完整行到齐。93.71 用
  1024-pixel 宽的 Y32 surface 上传少量 FP 微码；此前微码一直留在行缓冲，实际 VRAM 为零。
  提交字节游标随已有对象状态保存，后续 DWORD 不重放已执行的 ROP；覆盖部分行快照、
  XOR 不重放和宽 Y32 shader 字上传。2D、FIFO、PGRAPH 单元测试及 Closure 构建通过。

- 级联中断续修：Win98 8 bpp 等待时主 PIC ISR2 挂起、从 PIC ISR=0，后续 PFIFO IRQ10
  无法交付。级联请求在 INTA 前撤回或被屏蔽时，应交付从 PIC 的伪 IRQ15，让客体确认
  主 PIC；旧实现直接返回无中断，遗留 ISR2。按
  [8259 级联语义的 QEMU 实现](https://github.com/qemu/qemu/blob/master/hw/intc/i8259.c)
  核对后补齐此路径。真实客体 INTA/IRET 回归覆盖撤回、屏蔽、ISR 位及后续 IRQ10，
  debug/release 均通过，加入 devices-test；Win98 冷启动复测继续进行。

- 程序翻译前置：新增 VP/FP 直线代码到 SM3 字节码翻译，输入/输出语义、ALU、纹理
  采样、内联常量独立绑定；VP 双发射先计算两个结果再提交，避免后一个 slot 读到新值。
  分支/谓词、相对地址、需打包的半/全寄存器别名及超出预算明确拒绝，保留后续 G4 工作。
  PGRAPH 可从真实对象生成 shader pair；31 个模块（含 XP 原生捕获）经现有 D3D9 管线
  转 WGSL 并通过 naga，PGRAPH 集成测试和插件 Closure 构建通过。绘制后端仍待接入。

- G1 原生显示/模式/DOS/快照门禁复核：XP 93.71 与 Win98 81.98 均在无问题码下
  显示 1024×768×32；98 实测 640×480×8、800×600×16、1024×768×32，CDS_TEST、
  实际切换和 GetDeviceCaps 一致。DOS COM 进入 mode 13h，写/读 VGA 像素，等待两个秒钟
  捕获完整 320×200 scanout，再回文本并返回桌面，退出码 0、标记 NV40DOS0。
  debug/release 冷启动通过，两个系统快照恢复后显示与 FIFO 保持正常。证据见
  `g1-native-modes-dos.json`。一次早先的 release 冷启动在 VBIOS shadow 中遇到文字字节
  并停住，之后复测未重现；失败快照保留到 G6 排查稳定性，不据此掩盖未决问题。
  探针还核对 GDI 桌面备份与恢复，均为 failures=0；DirectDraw 仅在驱动宣告支持时测 XOR，
  实际填充读回仍失败，G2 未验收。G3-G7 尚未完成。

- 3D 取数前置：新增 render target 的颜色/深度格式、四目标 DMA/offset/pitch、线性与
  矩形 Morton 布局；主机读回前验证所有目标行，末行 DMA 故障不留下部分更新。
  顶点取数先支持 float 数组、索引/基址和内联数据，未启用属性使用当前 float4；
  未实现的压缩格式明确拒绝。表面填充字节、Morton 顺序、原生 X8R8G8B8 编码、
  行填充保持、原子故障及顶点数据测试通过，加入 devices-test，插件构建通过。

- 首条主机 GPU 绘制路径：NV40_3D BEGIN/内联顶点/END 翻译成带原生 VP/FP 的 D9WG，
  展开 strip/fan/quads/lines，独立 NV40 session；窗口坐标在 VS 尾部重建，viewport 变化
  只更新常量。当前 D9WG 已由公共执行器演进到 1.9，沿用现有线协议，不降回计划中的 1.8。
  GPU 目标读回完成后才提交 VRAM 并放行 FIFO/fence；快照先等待读回，恢复时重建主机缓存。
  不支持的纹理、深度/模板、clip-space 视口和光栅状态明确报错。END 即使绘制报错也关闭
  primitive，避免下一次 BEGIN 陷入错误。浏览器创建 renderer 的适配器列表已加入 NV40。
  真实 Chrome WebGPU 的 8×8 像素全匹配 #336699，部分 primitive 快照、primitive 展开、
  回写/完成/fence 顺序、错误恢复通过；34 个 WGSL 模块（含 XP 有效语料）通过 naga。
  公共 writer 默认 SVGA session 保持一致，SVGA 3D/图形适配器测试与两个插件构建通过。
  XP 93.71 原生 GDI 和 DirectDraw 显存填充/复制/Lock 读回均 failures=0，像素 ff336699，
  原盘未变，见 `g2-xp-9371-ddraw.json`。前一条纹理复制仍报未实现，DxDiag 与 G2/G3
  完整门禁尚未验收。

- Curie 输出路由续修：VP 的 TBUF 槽与颜色/纹理语义分开。按硬件测试中的 1FC4、
  1FC8/1FCC 和 1FF4 读取颜色、标量与纹理坐标路由/使能；标准编译器的寄存器约定不能
  替代这些状态。XP 原生复制程序用槽 5 输出 TEX0，旧翻译却将其声明为 fog。
  改为先保存原始输出，再按路由写 D3D9 语义。测试覆盖槽 5→TEX0、颜色/标量选择、
  路由后的 WGSL；state/PGRAPH/绘制测试与 Closure 构建通过。额外插值器和双面颜色
  尚未接入执行器时明确拒绝，避免使用错误的语义。

- 基础纹理接入：checked DMA 读取线性/Morton 的 2D 单级纹理，支持 L8、1555、4444、
  RGB565、32-bit 存储与 A8L8，按组件交叉开关转换取色；绑定 wrap、边框与最近点/线性
  过滤。16 个 texture size 状态地址均可保存；未接入的 mip/cube/volume/比较/sRGB/signed/
  anisotropy/unnormalized 状态明确拒绝。单元测试比较字节顺序、Morton 和组件常量；
  真实 WebGPU 棋盘格的最近点、双线性像素以及 TBUF5→TEX0 路由均正确。
  XP 93.71 的前一条纹理复制现在也执行到 GPU，两个 draw、三个分块读回完成，PGRAPH
  faults=[]，GDI 与 DirectDraw 微探针均 failures=0，见 `g2-xp-9371-ddraw-textures.json`。
  设备/着色器测试和插件构建通过，完整 DxDiag 与 G3 门禁仍待后续实现。

本计划为 v86 增加第四种显示适配器 `graphics_adapter: "geforce_6800"`。它是一张 Windows 98 和
Windows XP 都能用、支持 DirectX 9.0c 与 Shader Model 3.0 的复古显卡。客体装 NVIDIA 官方驱动：
98 用 ForceWare 81.98（Win9x 版），XP 用 ForceWare 的 XP 版。设备在寄存器和命令层面模拟真实的
NV40，2D 在 CPU 侧完成，3D 翻译成现有的 D9WG 批次，由页面上的 D3D9 执行器在 WebGPU 上运行
（[gpu-devices.md](gpu-devices.md) 的 “Architecture”）。

与已有的三种适配器的关系：Bochs VGA 不变；VMware SVGA II 与 virtio-gpu 面向现代客体，给客体的是
高层的 3D 命令（SVGA3D、VGPU10、virgl、Venus）；NV40 给客体的是真实硬件接口，客体驱动是闭源的
NVIDIA 驱动，设备必须从硬件层面的方法流重建 D3D9 级的状态。

- G3 顶点提交续修（2026-11-14）：实现 VB_ELEMENT_U16/U32、VB_VERTEX_BATCH、
  VB_INDEX_BATCH，索引 DMA0/1、16/32-bit 读取与有符号 VB_ELEMENT_BASE。BEGIN 内的
  索引流和类型随对象快照恢复；混合内联属性与索引、越界 DMA、过长批次明确报错。
  状态/渲染测试、Closure 构建通过，真实 WebGPU 的 DMA 索引三角形像素读回正确。
  此项不替代原生 DxDiag/3DMark 的 G3 验收。


- G3 顶点格式续修（2026-11-14）：数组读取支持 packed BGRA、U8 normalized/scaled、
  S16 normalized/scaled、FP16 与 FP32，保留 DMA 边界检查。启用的短向量补齐
  (0,0,0,1)，仅未启用属性使用 current attribute。测试覆盖通道顺序、SNORM 端点、
  FP16 非正规数/无穷、整数缩放与默认分量，状态/渲染测试和 Closure 构建通过。


- G3 原生顶点编码续修（2026-11-14）：93.71 的 DrawPrimitiveUP 提交
  VTXFMT=0x114BB/0x114CC，bit 16 选择 DirectX 声明编码，不能按普通 TYPE/SIZE
  解码。补齐已核对的 FLOAT1–4、D3DCOLOR、UBYTE4 与 SHORT2 编码；内联路径也
  转换 packed/FP16 输入，并按每个属性的 DWORD 长度推进。新增真实格式与字节
  消耗测试，状态/渲染测试和 Closure 构建通过；原生三角形正在复测。


- G3 清除续修（2026-11-14）：CLEAR_BUFFERS 写入真实显存，支持 1555/565/32-bit
  颜色通道、D16/D24S8 深度、模板写掩码、scissor 和多颜色目标；全部目标先校验
  DMA，越界不会留下部分清除。此时显存是权威副本，后续 GPU 绘制重新上传。
  测试覆盖裁剪、行 padding、分量保留、深度/模板互不破坏和晚发生的 DMA 故障；
  状态、PGRAPH 测试与 Closure 构建通过。浮点颜色清除仍明确报错。


- 原生验收工具与运行库（2026-11-14）：增加 NV_DX9/NV_DX9_INSTALL，在只读原盘
  overlay 中运行未经修改的微软 December 2006 自解压包和 DXSETUP /silent；SHA-1
  9143e8a08ba454ac2c35d179f8f180db271af0dd。安装后冷启动，Win98 81.98 的
  GDI 与 DirectDraw7 显存填充/复制/Lock 读回均为 0 失败，GPU 1 draw、PGRAPH 无故障。
  见 g2-win98-8198-ddraw-dx9.json。此前 CreateEx 8007007f 是旧运行库缺少入口。
- 增加 NV_D3D_TEST 原生 D3D9 HAL 探针：查询真实 caps、创建设备、固定功能顶点/颜色、
  DrawPrimitiveUP 与 GetRenderTargetData，未注入 API 代理。XP 93.71 的硬件顶点
  处理设备成功，读回 ff336699；GDI/DirectDraw/D3D9 均为 0 失败，3 GPU draws、
  PGRAPH 无故障，见 g3-xp-9371-hal-triangle.json。Win98 的 D3D9 设备创建仍返回
  8876017c（OUTOFVIDEOMEMORY），继续调查。两种客体的 DxDiag 和基准门禁仍未通过。


- G3 alpha/blend 续修（2026-11-14）：连接 alpha 比较、8-bit reference、颜色与 alpha
  独立 blend factor/equation、常量颜色，复用 D9WG 的实际光栅管线。真实 WebGPU
  读回验证 source-over 的四个分量，以及 alpha 比较失败保留原目标、成功写入源色；
  状态枚举测试、完整渲染测试和 Closure 构建通过。RGB 的 constant-alpha factor
  尚需额外降低，目前明确报错。


- G3 视口续修（2026-11-14）：正常 VP 保留齐次 XY 到 host 裁剪阶段，再由对应的
  WebGPU viewport 施加 NV 的缩放/平移，支持非零起点的小视口和 Y 方向。此前
  将坐标直接归一化到整个 target 会在裁剪后错误扩展到视口外。真实 GPU 测试逐
  像素核对 8×8 target 内 (2,1) 起的 4×4 视口，外侧显存保持不变；渲染测试和
  Closure 构建通过。超出 target 或非有限的视口继续明确报错。


- G3 深度/模板续修（2026-11-14）：D16/D24S8 目标接入真实 GPU 深度比较与写入、
  单面模板 compare/fail/zfail/pass 和读写掩码。颜色与深度目标全部读回后才一起提交
  显存并恢复 FIFO，fence 与快照不会先于深度结果。共享执行器同时补齐 stencil
  上传：全表面复制模板平面，局部矩形用逐位掩码 pass 保留周边和深度。
  真实 GPU 测试覆盖远/近片元、跨批次重传、模板 fail increment/replace、写掩码
  和深度保持；七种标准深度格式的浏览器测试通过 56,152 项检查，包含完整/局部
  上传、非连续 pitch、模板字节和真实绘制。Closure 构建、设备渲染测试通过。
  双面模板、depth bounds 与 polygon offset 仍明确报未连接。


- 客体调查工具续修（2026-11-14）：NV_CAPTURE_SECONDS/NV_CAPTURE_LIMIT 提供有界
  高频截图，NV_CONTROL 的 {"stop":true} 经过正常 finally 保存现场并退出，供 DxDiag
  短暂测试画面和中途状态使用。DirectDraw 探针补充显存/caps、3D heap 与 render
  surface 分配结果；D3D9 探针区分 HWVP、HAL+SWVP 与 Win98 全屏创建结果。
  原生 C 构建通过。Win98 报告约 118 MiB 空闲显存，但 HWVP/SWVP 仍返回
  OUTOFVIDEOMEMORY；全屏复测受到可复现的 VBIOS shadow 停顿阻塞，尚未下结论。


- G3 面剔除续修（2026-11-14）：连接 CW/CCW 前面约定与 FRONT/BACK/
  FRONT_AND_BACK，全部剔除时不提交三角形，但点和线保持原行为。真实 GPU
  测试验证更换前面方向、正面剔除、全部剔除不产生绘制、反转数组索引改变
  面分类；渲染测试与 Closure 构建通过。


- G2 XP DxDiag 门禁（2026-11-14）：在 93.71 下实际运行微软 DxDiag 的三段
  DirectDraw 测试。高频截图核对主表面黑白矩形、屏幕外表面的窗口内跳动白块、
  640×480 全屏跳动白块；报告 DDXP.TXT 明确写出“All tests were successful.”
  测试后的 PGRAPH 无故障，原盘未改变。报告与选定帧的哈希、GPU 统计见
  g2-xp-9371-dxdiag-ddraw.json。Direct3D 7/8/9 此时尚未运行，Win98 DxDiag
  仍待验证，不能将 G2 整体标为完成。harness 导出诊断文本并记录 ROM shadow
  和段基址，方便继续 Win98 冷启动调查。


- i440FX PAM 续修（2026-11-14）：Win98 VDD 的 C025CDF6 页清除循环把虚拟
  C25C0000 映射到物理 C0000，写入 20/07 文本空格；当时 PAM1=0x11，硬件应
  丢弃写入。原核心忽略 PAM 写使能，破坏 VBIOS 后停在 C2000。现按 PAM0–6
  的 16 KiB 写使能保护 shadow，更新/恢复时清理 JIT/TLB 缓存，不向客体伪造
  page fault；读取保留既有 shadow RAM 路径。覆盖普通/SIMD/锁/字符串写入、
  跨块字节使能、生成代码重新解锁/锁定、分页和快照。debug/release 回归、
  NV VBE、通用显示适配器、26 项 PCIe 与 26 项 SMM 测试通过。
  Win98 冷启动首次复测 129 秒进入 1024×768×32，ROM 保持 55 AA；GDI、
  DirectDraw 与全屏 D3D9 HAL 的 ff336699 像素读回均为 0 失败、PGRAPH 无故障，
  见 g6-win98-pam-write-protection.json。窗口化 D3D9 仍报显存不足，继续调查。


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

- G3 视口续修：XP DxDiag D3D8 的原生状态使用 640×480 目标、scale `(320,-240)` 与
  translate `(320.5,240.5)`。改为在顶点程序保留原始仿射变换，用整目标 host viewport 和
  像素中心裁剪表达小数、负起点及超出 attachment 的 NV 视口；完全不可见时不提交绘制。
  Chrome WebGPU 对整数偏移、原生半像素偏移、两侧越界的逐像素结果，以及深度/模板、
  混合和纹理回归均通过；插件 Closure 构建通过。原生 D3D8/9 验收继续进行。

- G3/G4 纹理续修：补齐线性固定 pitch 与 Morton 紧密 mip 链、逐级 DMA 检查及 D9WG
  逐级上传；接通最近 mip/三线性过滤、8.8 格式正负 LOD bias 与整数 LOD 范围。
  XP DxDiag 原生流确认使用 256×256、9 级 RGB565；不再因 mipmap 抛错。
  Chrome WebGPU 的不同纯色 mip 验证导数选级、正负 bias、最小级和三线性插值，
  纹理边界测试与 Closure 构建通过。小数 LOD clamp 仍显式报未实现。

- G4 压缩纹理第一部分：支持 NV40 DXT1/3/5（BC1/2/3）线性块、紧密 mip 尾部、
  非整块边界裁剪和组件 crossbar。BC1 透明分支、BC2 4-bit alpha、BC3 两种端点
  插值及跨字节 3-bit selector 均有参考字节测试，DMA 越界仍报错。Chrome WebGPU
  实际采样三种格式并读回颜色/alpha 正确；设备纹理测试和插件 Closure 构建通过。

- G2/G3 SIFM 续修：XP DxDiag D3D8 使用 RGB565、16-pixel clamp 与 8-byte pitch
  更新小 mip。SIZE 限制取样坐标，不限制独立的 DMA pitch；允许源行重叠和零 pitch
  重复行，继续在目标改写前检查完整 DMA 范围。新增逐行像素、零 pitch 和源越界
  原子性回归；2D 测试与插件 Closure 构建通过。

- G4 ALU 续修：补齐 DPH、DP2A、SEQ/SNE/SLE/SGT、SSG、SFL/STR 与 vector/scalar DIV
  的 SM3 降低，内部 DEF 常量避开全部客体常量及视口常量。DIV 语义参考 NVIDIA
  [CineFX 3.0 规范](https://developer.download.nvidia.com/opengl/specs/nv40specs.pdf)，
  当前使用 RCP/MUL，保留原生除法可能存在的末位舍入偏差。42 个 WGSL 模块通过 Naga；
  真实 NV 指令编码的比较、常量、DIV、DP2A 结果通过 GPU 逐分量读回，Closure 构建通过。

- G3/G5 benchmark harness：`NV_HDB` 将只读游戏盘连接到 secondary-slave，保留
  primary-slave 的 RAM 工具盘；`NV_GAME_OVERLAY_LOAD/SAVE` 独立保存扇区写入，
  `NV_GAME_ARTIFACTS` 按分号分隔读取有界 FAT32 结果文件，结束检查游戏原盘大小/mtime。
  已用 XP 冷启动读到 legacy 镜像的原版 3DMark99 EXE，进入其 DirectX 版本检查；
  99 在 XP 的兼容启动仍待解决。已有游戏盘的快照须用同一游戏盘恢复。

- G2 Win98 DxDiag DirectDraw 客体验收通过：81.98 + 已安装的 DX9.0c 上，主表面的
  黑白矩形、窗口白方块和 640×480 全屏弹跳白方块均正确；保存的原版报告明确返回
  `DDraw Test Result: All tests were successful.`。8374 次 GPU 提交/读回、0 GPU failure、
  0 PGRAPH fault，原系统盘未修改。证据见 `g2-win98-8198-dxdiag-ddraw.json`；
  字体 DMA 尚未完成，不能将其等同于全部 G2 类已实现。

- G4 MRT 第一部分：接通四个颜色目标及各自 DMA/offset/pitch、MRT enable 和独立
  color-write mask，所有附件验证后才提交，全部读回后才恢复 FIFO。修正颜色输出映射为
  R0/R2/R3/R4（H0/H4/H6/H8），R1 留给深度；0x36c 在 NV40 上为 MRT blend enable，
  不再误作 NV30 的 fog enable。Chrome WebGPU 验证四种颜色、每目标掩码、RT3 越界
  原子性及退回单目标；44 个 WGSL 模块和 Closure 构建通过。混合使能不同的 MRT 组合
  及不含 COLOR0 的 enable mask 仍显式拒绝，尚不是完整 G4 验收。

- G3 XP DxDiag Direct3D 客体验收通过：93.71 的 D3D7/8/9 均显示正确纹理的旋转
  立方体，保存的原版报告三项均为 `All tests were successful.`。修复视口、mip 和
  SIFM 后重新完整运行，1365 次绘制、1369 次读回、0 GPU failure、0 PGRAPH fault，
  原盘未修改。证据见 `g3-xp-9371-dxdiag-d3d.json`；Win98 D3D 与 99/2000 benchmark
  仍在验收，整个 G3 尚未完成。

- G4 FP16/HDR 第一部分：接通 A16B16G16R16F 渲染目标与 RGBA16F 纹理上传，
  组件 crossbar 保留原始 half bits，采样资源与颜色附件独立缓存。Chrome WebGPU
  读回精确验证负值、超过 1 的 HDR 值、跨提交的加法混合，以及浮点纹理双线性平均；
  纹理 DMA/half bits 测试和插件 Closure 构建通过。完整 HDR/SM3 benchmark 仍待验收。

- G3 benchmark 启动续修：3DMark99 的 E2 引擎在 `DllMain` 内调用 DirectDrawEnumerate，
  XP 随后在 WINTRUST 的 RegisterWaitForSingleObject 初始化中与 loader lock 相互等待，
  已由客体自带 NTSD 的所有线程栈确认。新增仅用于 XP 的 `NV_BENCH_LAUNCH=1` 原生
  启动器：在原 EXE 入口前预热并释放 CryptCATAdmin context，再恢复原寄存器继续入口；
  临时入口断点先恢复，磁盘 EXE/DLL 及图形 API 保持原版。Win98 兼容层绕过 99 的旧 DX
  版本检测；已进入原版 99 Max Pro 的 Welcome 界面，尚未跑分。调试事件循环保留到退出。
  `NV_PROBE_BINARY` 可替换尚未首次打开的 64 KiB 预留探针，用于暖快照中的测试工具。
- Win98 分配诊断：`NV_D3D_TEXTURE_TEST=1` 按格式、大小、mip、pool、usage 输出真实
  CheckDeviceFormat/CreateTexture 返回值。128 MiB 下 16 个 DEFAULT 静态纹理均返回
  8876017c，MANAGED/SYSTEMMEM/SCRATCH 的各 16 项均成功；原生 GDI/DirectDraw 和
  全屏 D3D9 三角形读回通过且无 PGRAPH/GPU fault。`NV_VRAM_MB=128/256` 支持独立
  冷启动对照；这只是分配问题定位，不是 Win98 D3D8/9 通过。

- G3 原生 DirectX 枚举续修：3DMark99 的首批绘制使用 DEPTH_FUNC=4（LEQUAL）。
  envytools 的 Curie 硬件测试确认比较的 1..8、blend 的 0x1001..0x100f、方程 1..5
  与 stencil op 的 1..8 均为合法别名，现与 GL 编码统一转换；关闭的比较状态不再验证
  未使用枚举。GPU 回归改用原生别名验证深度/模板、alpha 和独立 alpha 混合，全部通过；
  插件 Closure 构建通过。99 已开始 benchmark，完整结果仍待验收。

- G4 查询基础：实现 Curie `QUERY_RESET/ENABLE/GET`，开启时用共享 D9WG 的真实 GPU
  遮挡查询逐 draw 累加，报告按 16-byte 硬件布局写入绑定 DMA。时间戳保持 64-bit 精度，
  完成字随整段 DMA 原子发布，后续 FIFO/fence 等待查询和目标读回。计数进入对象快照。
  PGRAPH 测试覆盖报告布局、旧数据保护和快照；真实 WebGPU 的 8×8 覆盖计数为 64，
  FIFO 顺序及完整渲染回归通过。XP benchmark 仍需从干净起点复测。

- G3 翻页同步续修：实现 BLIT/Curie 独立的 3-bit READ/WRITE/MODULO、WRITE 递增和
  FLIP_WAIT。等待期间 FIFO 不执行后续方法，显示 ISR 写 PGRAPH `0x40071c` 后推进
  READ 并唤醒。计数与挂起等待进入 PGRAPH v2 快照，旧快照默认无等待。
  测试覆盖 modulo/零 modulo 回绕、类隔离、非法值、等待快照恢复与后续 fence 顺序；
  PGRAPH/FIFO/渲染回归和插件构建通过。原生 XP 复测继续进行。

- ZCULL 报告续修：RSX/NV4097 寄存器定义核对了原生驱动写入的 `0x1ea8/0x1eac`
  为 ZCULL/SCULL 控制，GET_REPORT 的 2–5 号选择器为层次剔除统计。后端不维护
  层次深度缓存，这些统计真实为零，普通逐片元深度/模板测试照常执行；不把它们冒充
  遮挡计数。RESET=2 只清该组，RESET=1 才清 ZPASS。PGRAPH/真实 GPU 回归覆盖
  两组独立与完整报告发布。事实参考：
  [RPCS3 的硬件枚举](https://github.com/RPCS3/rpcs3/blob/master/rpcs3/Emu/RSX/gcm_enums.h)
  （仅核对数值与名称，未复制实现）。

- Win98 DxDiag 原生视觉/报告验收：81.98 下 D3D7、D3D8（640×480）和 D3D9
  （800×600）的纹理立方体均正确旋转，人工确认后保存的原生报告全部成功。
  本轮 6917 draws/readbacks、GPU 失败 0、原盘未变，证据见
  `g3-win98-8198-dxdiag-d3d.json`。本轮仍包含旧的 QUERY/FLIP 未实现陷阱，不能称为
  无 PGRAPH 故障验收；相应实现已补齐，干净复测和 99/2000 完整基准继续进行。
  先前 D3D9 黑屏判断是只检查了 640×480 捕获，遗漏实际 800×600 阶段，现据完整
  捕获与报告更正，保留原始现场，不把瞬时切换画面当作测试失败。

- PGRAPH 翻页上下文续修：SURF_TYPE 按硬件字段读写两组翻页计数，PFIFO GRCTX
  实例成为有效的当前图形上下文。软件保存/恢复按上传 REG 传输描述解出计数在 RAMIN
  中的位置，不硬编码驱动版本偏移，也不执行上传程序的分支或复位指令。暂停上下文时
  驱动对 RAMIN READ 的修改能解除原有 FLIP_WAIT；完成后确认保存/恢复请求位。
  测试覆盖上下文隔离、快照、非固定 RAMIN 偏移、等待唤醒及请求确认，PGRAPH/FIFO/
  渲染回归通过。原生复测进行中；此前合法 DVD 对象的三个 DMA 绑定也已补齐。

- G4 顶点条件码：支持两个 CREG、全部 8 种比较、分量 swizzle、掩码谓词写入与
  饱和后的条件更新；同一 VLIW 的两个结果先计算，再提交和更新条件码。按 XF ISA
  区分 CDST 写使能与 CDST_IS_VEC 的结果选择，后者单独置位不触发条件写入。
  解码回归、73 个 WGSL/Naga 模块和真实 GPU 的 16 组谓词/NaN 像素及 vector/scalar
  结果选择通过；完整 GPU 渲染回归和插件构建通过。相对寻址和控制流仍待后续实现。

- G4 地址寄存器基础：ARL 向下取整、ARR 就近取整、两个向量 AREG 与分量选择、
  常量/属性相对读取已接入。每个相对操作数先取值，保留 VLIW 旧地址读语义；16 个
  属性保留硬件编号，完整 544-vector 客体常量与内部字面量/viewport 常量分库。
  D9WG 内部设备使用已有扩展常量存储，仍由 WebGPU 执行。解码/78 个 Naga 模块和
  真实 GPU 正负舍入、相对属性、客体 c500 与完整渲染回归通过，插件构建通过。
  ARA、相对输出、地址栈和控制流仍待实现，未支持的相对输出明确报错。

- D16/模板状态续修：没有模板位的 Z16 表面忽略模板测试，仍执行真实深度比较与写入。
  先前对该组合报错会误伤 XP 驱动的初始化探测。真实 GPU 以启用 NEVER stencil 的
  Z16 表面验证绘制成功且 16-bit 深度正确，完整 GPU 回归通过。

- G4 顶点控制流：解码从入口追踪可达分支和 END 之后的 CAL 目标；BRA、CAL/RET
  用带指令预算的共享 WGSL 控制流执行，含 8 层返回栈、条件码任意分量判断、向前/
  向后跳转、空栈返回及溢出终止。一个调度迭代只执行一条 NV 指令，避免向前跳转
  多执行；VLIW 分支读取更新前条件码。解码回归、87 个 Naga 模块、真实 GPU 的
  条件跳过、子程序返回与回跳计数像素及完整渲染回归通过。地址栈、FP 控制流等仍待完成。

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
  固定功能生成的程序；共享 D9WG 协议的 NV40 私有扩展。

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
  | `NV_TRACE=0` | 关闭方法/程序跟踪，保留故障、GPU 与翻译缓存计数；默认开启 |
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
| ForceWare 81.98（Win9x）、93.71（XP） | 已下载并在原生客体中验证；安装包留在忽略目录 | G0–G5 |
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

## 初稿配置项的实施复核

1. 已采用适配器名 `"geforce_6800"`。
2. 默认显存 256 MiB，可选 128 MiB。
3. 已验证 XP 93.71 与 Win98 81.98，其他驱动版本未计作验收。
4. 两种驱动都接受当前 PCI 模式，G0 未触发 A1 的 AGP 前置条件。
5. XP 与 98 的现有预设继续使用原适配器；NV40 保持 experimental，完整门禁后再评估默认选择。
6. 已接入共享 D9WG 执行器及 NV40 私有操作码、视口和采样状态。
7. O1、V1、W1 保留为可选阶段，不计入当前 G0–G7 门禁。

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

- G1/G3 PFB 能力续修：实现只读 `PFB_ZCOMP_SIZE=0x2e3ff`，其值为 NV40 的末个片上
  压缩标签索引，容量按 Nouveau `nv20_fb_tags` 的规则为寄存器值加一，与 128/256 MiB
  VRAM 无关。快照升至 v8，旧状态中的未知寄存器存值迁移为硬件容量。DWORD/byte
  只读语义、旧状态迁移及快照往返通过。Win98 冷启动确认读到正确值，但 DEFAULT
  纹理分配仍失败；该寄存器缺失不是本轮分配失败的充分原因，继续定位。

- G3 雾系数续修：3DMark99 的原生 FP 使用 `FOGC.y` 混合纹理与雾色；此前只传递
  标量 FOG varying，使这些表面全为灰色。现在在片元插值后生成 `(coordinate, factor, 0, 0)`，
  支持线性及绝对距离线性模式和饱和边界。GPU 读回覆盖系数、正负坐标及跨顶点的
  插值后 clamp；46 个 WGSL 模块与 Closure 构建通过。指数雾暂仍显式拒绝。

- Win98 分配诊断续修：原生 DirectDraw7 分别创建并锁定 32×32 的 XRGB32、RGB565、
  XRGB1555 纹理。普通 VIDEO、本地 VIDEO 和 SYSTEMMEM 三组全部成功；NONLOCAL
  三组均返回 `88760276`。因此本地纹理 DMA/显存分配可用，不能把 D3D8/9 的
  `8876017c` 直接归因于本地显存容量或据此断言必须 AGP。探针位于
  `NV_D3D_TEXTURE_TEST` 诊断开关下，继续检查不同接口请求的分配条件。

- G4 片元条件码第一部分：按 NVIDIA `NV_fragment_program` 的条件码语义降低八种
  比较、swizzle、逐分量条件写入、条件码更新及只写条件码的指令；原生 KIL 改为
  测试条件码，保留未写分量。条件计算与提交分离，更新使用饱和后的结果。GPU 读回
  覆盖 NaN/UN、条件掩码、条件码部分更新、饱和与丢弃；3DMark99 捕获的 15 对
  原生 VP/FP 全部编译，共 83 个 WGSL 模块通过 Naga，Closure 构建通过。
  半精度运算的精确舍入/下溢、half/full alias 与结构化控制流仍待完成。

- G3/G6 表面缓存续修：3DMark99 在持续装入纹理后出现颜色/深度目标不可读回；
  原因是缓存命中没有更新顺序，活跃附件仍按最早插入资源被释放。纹理和 shader
  缓存现按最近使用更新；真实 GPU 回归连续切换 70 张纹理，保留当前颜色/深度
  附件并检查每次像素，资源数保持 64，0 failure；Closure 构建通过。

- G1/G3 strap 修复解决 Win98 D3D9 分配：`PSTRAPS0_PRIMARY` 原先全零，
  其中 BAR1_SIZE 实际宣告 64 MiB，与 PCI 的 128/256 MiB 窗口不一致。按 envytools
  `io/pstraps.xml` 对齐 aperture、DEVID nibble 和 PCI AD wiring，保持 PCI bus 与
  13.5 MHz crystal；快照 v9 迁移旧零值。Win98 81.98 冷启动后窗口 D3D9 HAL
  CreateDevice 成功，DEFAULT 静态 16/16、动态 16/16、支持格式的 RT 12/12、
  MANAGED/SYSTEMMEM/SCRATCH 各 16/16 均成功，真实像素 `ff336699`，0 GPU/PGRAPH
  fault。另 4 项为驱动未声明支持的 A1R5G5B5 RT（CheckDeviceFormat=8876086a），
  不能计作适配器渲染失败。原盘未修改；原版 DxDiag 验收继续进行。设备源码版与构建版
  测试覆盖 128/256 MiB strap、只读、v7 迁移和快照往返，Closure 构建通过。

- G4 雾模式续修：补齐 EXP、EXP2 及各自绝对距离模式，在片元插值后的原生
  affine 参数上执行指数和饱和；与已有两种线性模式一共六种。GPU 验证指数、
  平方指数、负坐标绝对值及超过 1 的饱和，57 个 WGSL 模块和 Closure 构建通过。

- Win98 原生分配验收：探针按真实 CheckDeviceFormat 能力统计，未声明支持的格式
  单独记录；重新冷启动后 GDI/DirectDraw/D3D9 均为 0 failure，全部已声明支持的
  纹理创建成功，0 GPU/PGRAPH fault。证据见 `g3-win98-8198-texture-allocation.json`。

- G4 cubemap：接通六面纹理与 sampler cube 声明、完整 mip 链和每面上传。
  packed/Morton 面按 128-byte 对齐，uniform-pitch 面紧接全部 mip；LOD clamp
  不改变后续面起点。CPU 字节测试覆盖线性/packed 面、末面越界和 clamp；GPU
  逐面验证六方向、+X 四角坐标及显式 mip，缓存区分 2D/cube 并使用正确资源类型
  释放。纹理测试、真实 WebGPU 回归与 Closure 构建通过。volume 尚待实施。

- G0/G3 诊断续修：PGRAPH 的普通 illegal-method/invalid-notify 陷阱现在与 DMA
  异常一起进入有界 fault 历史；PFIFO 分别记录 DMA fault 与 cache trap 的通道、
  GET/PUT、方法、参数和 trace sequence。软件 DAC 的 cache trap 仍是驱动处理路径，
  不能全部计作 DMA 失败。harness 导出 `fifoFaults`，避免长跑 reset/ack 后丢失起因；
  PGRAPH/FIFO 和渲染顺序测试、Closure 构建通过。

- G4 volume：接通三维纹理与 sampler 3D、三轴 Morton 和固定 row/slice pitch、
  随 mip 缩小的深度，以及 3D 纹理资源上传/释放。支持普通/FP16 存储格式，最大
  512³，源数据和展开上传均受当前 VRAM 大小预算约束；压缩 volume 仍显式拒绝。
  CPU 测试覆盖非等长三轴、mip/slice 偏移、末级 DMA 越界与分配预算；GPU 验证
  两个切片、空间线性混合和显式 mip。纹理/渲染测试及 Closure 构建通过。

- G6 上传复用第一部分：3DMark99 的旧保守路径在 4754 次绘制中上传约 9.75 GB。
  现逐级精确比较 CPU 权威字节与 GPU 最后上传/读回内容，只有变化的 mip 才上传；
  无 hash 碰撞近似，不减少绘制后的下载。失败时清除复用记录，快照仍只保存 VRAM。
  GPU 回归验证重复绘制不再上传、单 mip 修改只上传一级、客体修改颜色目标后
  scissor 外的像素保留；统计增加 uploads/uploadBytes，Closure 构建通过。
  完整 benchmark 时间分布仍待 G6 验收。

- G3/G6 harness 检查点：control 的 checkpoint 标签在当前输出目录保存暂停后的
  状态并继续运行；NV_STATE_SAVE_DRAWS 可在指定绘制数保存一次。已在正确 strap
  冷启动的 XP 3DMark99 Benchmark 界面保存 before-benchmark 状态并继续原程序，
  用于重现长跑陷阱及后续性能对照；原盘和游戏盘均只读。

- G6 连续绘制批量提交：FIFO 内最多合并 32 次绘制或 8 MiB 命令，颜色/深度目标
  每批只下载一次，后续混合直接使用 GPU 上的前次结果。REF、信号量、2D、通知、
  查询和目标切换先完成前批；取样与待下载目标的 DMA 物理范围重叠时也先同步，
  保留尚未消费的 END 流。快照等待涵盖同步后继续提交的批次。真实 WebGPU 回归
  验证两次加法混合合为一次下载、REF 顺序及不同资源句柄的纹理反馈；全部 GPU
  渲染回归、PGRAPH/FIFO 测试和 Closure 构建通过。XP 长跑超时是否消失仍需复测。

- Win98 翻页等待续修：`FLIP_WAIT` 暂停 FIFO 前端，不将已空闲的光栅引擎报为忙。
  原先 `PGRAPH_STATUS` 随翻页等待返回忙，使 81.98 在显示处理路径等待引擎空闲，
  无法进入保存上下文及推进 READ 的后续步骤。复现检查点恢复后已能退出该等待并
  完成 D3D7 流程；完整旋转/报告及后续版本仍继续验收。保留 FIFO 的等待与 fence
  顺序，PGRAPH 回归和 Closure 构建通过。

- G4 片元结构化控制流第一部分：按硬件 DWORD 边界降低 IF/ELSE/ENDIF、REP 与
  条件 BRK，条件测试任意 swizzle 分量，支持零次及 255 次循环、独立嵌套计数。
  块边界和作用域先验证，执行预算限制嵌套循环的 GPU 成本。真实 GPU 验证分支、
  循环次数、break、嵌套及预算终止；98 个 WGSL/Naga 模块、完整 GPU 回归和
  Closure 构建通过。LOOP 的相对输入、CAL/RET 及 half/full alias 仍待实现。
- 像素单位纹理坐标：3DMark99 的后续测试触发 UNNORMALIZED 格式，现对实际取样
  的二维/三维坐标及显式梯度按基础尺寸缩放，保留 projective W、bias/LOD。
  尺寸作为独立 uniform 上传，改变尺寸不生成新 shader；GPU 全图比较像素坐标和
  归一化坐标的双线性 texel center 与插值，CPU 存储字节也一致。XP 此前只产生一次
  该未实现陷阱，后续检查点将使用新实现复测；不能据旧长跑宣称完整基准已验收。
  语义参考：NVIDIA 的 [NV_fragment_program2](https://registry.khronos.org/OpenGL/extensions/NV/NV_fragment_program2.txt)
  与 Mesa nv30 的硬件编码定义。

- G4 片元 LOOP：接通立即数次数、初始索引与步进，使用独立嵌套索引保存/恢复；
  相对输入索引 TEX0..TEX9，不受颜色/雾声明顺序影响。BRK 可退出两种循环，
  共用四层嵌套及执行预算保护，块外相对读取明确报错。99 个 Naga 模块与真实 GPU
  验证三个索引/偏移组合及退出内层后重新读取外层属性，完整渲染回归和 Closure
  构建通过。CAL/RET、half/full alias、顶点纹理等后续 G4 内容继续实现。

- PGRAPH 陷阱续修：TRAPPED_ADDR 按硬件把子通道放在 bits 16–18、通道放在
  bits 20–24，修复此前误用 USER 窗口字段。Curie 非零 NOP 在 DEBUG_D 的数据错误
  使能下产生 DATA_ERROR/BAD_ARGUMENT，并等待先前 GPU 批次；关闭该使能时不陷阱。
  原生 81.98 已执行并确认此类陷阱，但每帧约 10 秒的等待仍存在，尚未解决。
  单元测试与 Closure 构建通过。`NV_WATCH_FLIP` 可有界记录计数、RAMIN、MMIO 和
  CPU 位置，便于继续定位；查询报告布局已与 Mesa nv30 的完成字读取路径复核一致。

- G4 片元条件码银行：解出 SRC0 的独立条件读取/更新选择位，两个 CREG 均初始化
  为 EQ；谓词读取旧值，条件不满足的分量保留目标条件码银行原值。IF、BRK、KIL
  和普通条件写入共用选择器。真实 GPU 覆盖两个银行的全部比较、NaN/swizzle 与
  跨银行条件更新，103 个 Naga 模块、完整 GPU 渲染回归及 Closure 构建通过。

- G4 调用取指前置：片元解码追踪可达控制流和主 END 之后的 CAL 目标，DMA 按需
  读取，常量仍按 PC 排序并从缓存键中去值；非法目标、常量槽目标和越界明确拒绝。
  VP/FP 的空栈 RET 都可作为正常终点。解码测试验证跨 END 调用及恰好停止的 DMA
  取指，完整真实 GPU 回归和 Closure 构建通过；FP CAL/RET 执行降低继续实现。

- G4 片元 CAL/RET：条件调用、条件/空栈返回及子程序 END 已接通。为满足 WGSL
  无递归的要求，按四层调用深度生成有限函数变体，寄存器与 CREG 仍共享；递归
  溢出终止整个程序。调用恢复循环索引及作用域深度，跨调用共用四层 LOOP/REP、
  48 层 IF 与执行预算，RET 可直接退出子程序内循环。真实 GPU 验证跨主 END 的
  调用、返回条件、共享条件码、callee END、递归/循环深度溢出与提前返回；110 个
  Naga 模块、完整 GPU 回归及 Closure 构建通过。未写结果寄存器属未定义值，选择零。

- G2 字体 DMA：按 NVIDIA `cl004a.h` 的记录结构实现 F/G 字形读取，8–512 byte
  幂次步长、尺寸头、连续单色 DWORD、F 的有符号 12-bit 坐标、G 的 16-bit 索引
  与共享 origin/clip/color/font 状态。支持两种位序、透明零位和现有 ROP/混合路径，
  状态随对象快照保存。测试覆盖负 origin、跨别名/快照的 G 字形、CGA6、ROP 及
  截断记录、畸形尺寸、末行 DMA 故障的全字形原子性；完整 2D/PGRAPH 回归及
  Closure 构建通过。3DMark99 总分窗口的字体异常尚未定位，不能将此项称为其修复。

- G1/G3 扫描状态续修：按 CRTC 总行数、retrace 起止和 VPLL 周期实现 PCRTC
  `0x600808` 的扫描行/blank/retrace，以及 `0x600868/0x60086C` 计数器。
  NV 像素模式的 VGA 状态端口/MMIO 共用 retrace 与属性索引复位；粗粒度调度保留
  一次待读取 retrace，逐字节读取只在访问对应状态字节时消费，状态可快照恢复。
  XP 3DMark2000 从此前在 `0x600808` 的无限轮询检查点恢复后已进入直升机场景；
  完整基准尚在运行。源码/release 寄存器与旧快照回归、PGRAPH 测试和 Closure 构建通过。
  同时把翻页等待正确报告为 PGRAPH_STATUS 的 SYNC_STALL bit 14；Win98 仍只绘制
  少量帧，不能把该状态位修正称为完整翻页修复。

- G2 原生字体像素对照：`NV_GDI_FONT_TEST` 比较真实主表面与客体 GDI 软件 DIB，
  五组 Arial/Tahoma/Times 字号、粗体斜体的 `12345 3DMarks` 均为 0 个不同像素，
  GDI_TEST=0，设备保持 started/problem=0，原盘未变。证据为
  `g2-xp-9371-font-reference.json`。失败时导出参考/实际 BMP，
  `NV_TOOLS_ARTIFACTS` 可选择工具盘根目录诊断文件。比较区避开探针控制台的闪烁光标；
  这未复现 3DMark99 的总分字体问题，该问题仍需单独定位。

- G3 XP 3DMark99 MAX 已跑完全部 26 项并保存原生 `.3DP` 项目。单个原生 benchmark
  经检查点连续恢复，末段 35512 次绘制、7733 批、0 GPU failure、0 PGRAPH/DMA fault；
  证据见 `g3-xp-9371-3dmark99-completed.json`。它不是完整冷启动性能结果；总分字体
  异常和参考帧一致性仍未解决，G3 门禁仍未完成。原盘及游戏盘只读检查通过。

- Curie NOP 校正：前项非零 NOP 陷阱误套用了 envytools 的早期 Kelvin/Rankine
  class 验证；该表未描述 NV40 Curie。撤除这条无 NV40 依据的限制，保留有序 GPU
  barrier 和正确陷阱地址。原生 81.98/93.71 的 NOP=1 可继续执行，不再人为产生
  DATA_ERROR；非法 NOTIFY 仍有完整陷阱回归。PGRAPH 与 Closure 构建通过。
  Win98 每帧约 10 秒等待仍可复现，故不能把 NOP 校正称为其根因修复。

- G3 纹理读取信号量：接通原生 93.71 在 3DMark2000 使用的 `0x1D74`，复用
  `DMA_FENCE/FENCE_OFFSET` 的四字节 checked DMA 写入，先同步待完成 GPU 工作。
  当前保守实现等待整批完成，满足纹理读取完成的顺序要求；不伪造 DMA 通知器。
  PGRAPH 测试覆盖数据、相邻字节和越界原子性，真实 GPU 验证 fence 晚于读回，
  完整渲染回归及 Closure 构建通过。编码复核 PSL1GHT 的
  `SEMAPHORE_TEXTUREREAD_RELEASE` 和原生驱动跟踪；完整长跑仍在复测。

- G4 顶点源向量修复：标量发射槽中的 MOV/LIT 保留完整 swizzle，Curie ARL 逐分量
  加载地址，避免原先把所有分量复制为 X。112 个 Naga 模块与完整真实 GPU 回归
  通过，像素用例区分 MOV 的四分量、LIT 的 diffuse/specular/power 及 swizzle，
  并从不同的 A1.y 读取相对常量；Closure 构建通过。

- G2/G3 对象绑定缓存：PFIFO SET_OBJECT 装载 PGRAPH 子通道的已解码对象；后续
  RAMIN 回收/重用不会让已装载类号随每条方法改变。不同子通道可以保留同一实例的
  不同代对象，重新绑定才装载新内容。PGRAPH 快照 v4 保存共享对象引用和旧代绑定；
  旧快照从已存对象及 FIFO 绑定迁移。PGRAPH/FIFO/2D/设备、完整真实 GPU 回归与
  Closure 构建通过。XP 新复测仍遇到 fence 高位选择器，客体门禁尚未通过。

- G4 顶点标量算术：增加 D9WG shader bytecode 的私有 `NV_ALU=0x1000`，
  instruction control 0..6 分别为 RCC/EXP/LOG/LIT/RCP/RSQ/LG2，仅供 NV40 顶点
  前端使用，不修改现有 D3D 指令。EXP/LOG 保留四分量旧式结果；LOG 以原始
  exponent/mantissa 拆分，避免 2 的幂附近的 log 舍入误判。RCC 有符号上下限、
  RCP 的 signed zero、RSQ/LG2 负数 unordered 和 LIT 零底数负指数由 NV 路径处理。
  特殊值使用运行时位转换，兼容 Tint 对常量 Inf/NaN 的限制。118 个 Naga 模块、
  完整真实 GPU 像素/条件码回归、通用 D3D 的 57 项与 199 个 Naga 验证、
  Closure/WebGPU bundle 构建通过。语义参考 NVIDIA NV_vertex_program2；
  Mesa nvfx_vertprog 的 RSQ 显式 ABS 也验证硬件源与 D3D abs-helper 的差别。

- G4 ARA：从指令 ASRC 选择的地址寄存器读取无 swizzle 向量，计算 X+Z、Y+W
  并复制到 Z/W，遵守地址目标掩码、谓词及既有 VLIW 同时读取语义。
  ARA/ARL/ARR 的结果按 NVIDIA 指令规范饱和至 [-512,511] 后提交及更新条件码。
  119 个 Naga 模块、完整真实 GPU 回归和 Closure 构建通过；像素测试覆盖独立
  Y 分量、部分目标写入与正溢出后从 c[511] 读取。

- G4 地址栈：PUSHA/POPA 与 CAL/RET 共用八层带类型栈，保存完整地址向量；
  POPA 要求无条件四分量写入，RET 只接受返回地址。空栈、类型错误和溢出终止
  程序；双发射 PUSHA 先读取旧地址，再提交同槽的地址加载。
  120 个 Naga 模块、完整真实 GPU 回归与 Closure 构建通过，像素用例覆盖四分量
  恢复、子程序两侧的 push/pop、双发射读取、空栈/错误类型与两种满栈溢出。

- G4 相对输出：OUT_INDEXED 按旧地址寄存器分量与共享 OUT_ADDR 选择 TBUF，
  两个 VLIW 槽在地址加载提交前计算目标。保留目标掩码、逐分量谓词和条件码；
  仅生成显示结果路由能观察的写入，越出物理 TBUF 的未定义写入选择忽略。
  122 个 Naga 模块、完整真实 GPU 回归、程序/PGRAPH/FIFO 测试及 Closure 构建
  通过，像素测试覆盖有效/负/溢出目标、掩码、false 条件及双发射地址加载。

- G4 片元 R/H 别名：以共享 u32 寄存器保存物理位，H[2n].xy/zw 对应 R[n].x/y，
  H[2n+1].xy/zw 对应 R[n].z/w。逐分量谓词、半字掩码写和同精度 MOV 保留相邻
  位及 NaN payload；FP16 按 ties-to-even 舍入，支持次正规数、signed zero、Inf/NaN，
  条件码读取舍入后的结果。私有 D9WG LOAD/STORE/HALF/COPY 指令只用于片元前端。
  125 个 Naga 模块、完整真实 GPU 回归、通用 D3D 57 项/199 个 Naga 验证、
  PGRAPH/FIFO/解码测试及 Closure/WebGPU bundle 构建通过。指令 precision 字段的
  低精度算术模式与 pack/unpack 尚待后续步骤，不能据此宣称全部精度语义完成。

- G4 打包指令：实现 PK2H/PK2US/PK4B/PK4UB 与四种对应 UP 指令，pack 直接将
  原始 u32 复制到所有启用结果分量，unpack 从指定源分量读取原始位。PK4B 使用
  NVIDIA 的偏置字节编码；两元素 unpack 在 XY/ZW 重复。保留掩码、谓词、源 swizzle
  与正负/绝对值位操作，H 目标 pack 和 H 源 unpack 明确拒绝。141 个 Naga 模块、
  完整真实 GPU 回归、通用 D3D 57 项/199 个 Naga 验证与 Closure/WebGPU bundle
  构建通过；像素用例覆盖八种格式、越界 clamp、复制、跨 MOV 的 NaN payload 和条件写。

- G4 LITEX2：接通 Curie 光照末段，Y 为 diffuse，Y>0 时 Z=exp2(W)，X/W=1；
  普通目标掩码、谓词、缩放、饱和和条件码继续共用提交路径。编码与输入布局复核
  Mesa nvfx 的 LIT 降低过程。142 个 Naga 模块、完整真实 GPU 回归和 Closure 构建
  通过，像素用例区分 Y/W 与 X/Z，覆盖正数、零及负 diffuse。

- G4 顶点纹理：TXL 解码四个纹理单元，经 vs_3_0 texldl 和独立 D9WG 顶点 sampler
  取样。实现 Curie 的线性 R32F/RGBA32F、1D/2D、最近点 mip、基础 pitch 的完整
  mip 链，以及显式 W LOD、4:8 bias 和分数 min/max clamp；LOD 参数使用 uniform。
  NV R32F 展开为 (R,0,0,1)，修正 D3D R32F 的 (R,1,1,1) 差别。纹理反馈继续走
  物理 DMA 重叠 barrier，未知格式及 wrap 模式明确拒绝。150 个 Naga 模块、完整
  真实 GPU 回归、纹理/解码/PGRAPH/FIFO 测试与 Closure 构建通过。硬件限制复核
  envytools 的 MthdCurieXfTex*，像素覆盖四个单元、两种格式、1D 和 LOD 参数。

- G4 深度纹理第一部分：接通单级 Z16/Z24 的硬件比较，保留原始深度/模板字节。
  私有 sampler 声明把八种 RCOMP 函数送至 WebGPU comparison sampler，D3D 普通
  shadow sampler 的默认 LEQUAL 保持不变；NV 分量 crossbar 在比较后应用。
  166 个 Naga 模块、完整真实 GPU 回归、通用 D3D 57 项/199 个 Naga 验证与
  Closure/WebGPU bundle 构建通过。像素覆盖小于/相等/大于边界、八种函数、Z16/Z24、
  TXP 投影参考、常量分量和四点 PCF。多级深度纹理仍明确拒绝，继续后续实施。

- G3 Win98 原生 DxDiag 复验通过：从已安装 81.98 的 overlay 重新启动，再在同一个
  DxDiag 会话中经检查点继续 D3D7/8/9。三段旋转画面均正确，原生报告全部成功，
  累计 17986 次绘制、0 GPU failure、0 PGRAPH/DMA fault，原盘未变。证据见
  `g3-win98-8198-dxdiag-clean.json`；未启用任何 query/flip 诊断覆盖。旧 permission
  快照在独立禁用 FLIP_WAIT、查询陷阱及翻页陷阱的对照中仍只有少量帧，不能再作为
  干净验收起点；这不能证明所有旧快照迁移问题均已解决。harness control 增加相对
  `pointer:[dx,dy]` 和 `click:true`，已用于原版测试按钮及报告保存。G3 的 XP/98
  3DMark2000 和参考帧门禁仍未完成。

- G4 片元特殊值：RCP/LG2 使用 NV 算术路径，保留负零倒数的符号、精确 Inf 位与
  负数对数的 unordered 条件码；DIV 逐分量除以第二源的 X，显式处理零、Inf/NaN。
  不再经过 D3D 的 finite-zero/abs-log 辅助函数。166 个 Naga 模块、完整真实 GPU
  回归、通用 D3D 57 项/199 个 Naga 验证与 Closure/WebGPU bundle 构建通过；
  像素用例包含通过 R/H alias 检查倒数的原始 Inf 位、0/0、signed zero 与条件码。

- G4 片元 SAT：缩放后先把 NaN 变为零，再饱和至 [0,1]，随后进行 H 写入舍入及
  条件码更新；普通 D3D saturation 不受此私有指令影响。166 个 Naga 模块、完整
  真实 GPU 回归、通用 D3D 57 项/199 个 Naga 验证与 Closure/WebGPU bundle 构建
  通过；条件码像素用例检查了此前未断言的 NaN 分量。

- G6 CPU 翻译缓存：在 NV40 前端复用精确代码及降低选项相同的 VP/FP 字节码，
  FP 内联常量每次仍从当前程序读取；代码变化立即失效。LRU 限制为 128 组及
  8 MiB 的键/字节码预算，GPU reset 清除缓存，缓存不进快照。harness 导出
  shaderTranslation 的命中、miss、淘汰及大小。PGRAPH 回归验证常量更新、代码
  改写与淘汰，完整真实 GPU 回归、FIFO 测试及 Closure 构建通过。含 DMA 解码和
  精确键构造的 48 条片元指令 CPU 微基准，1000 次从 179.9 ms 降至 113.5 ms；
  这不是客体帧率或 3DMark06 的性能门禁，完整 G6 报告继续后续实施。

- G4 FP32 输出：把原生 FP_CONTROL bit 6 接入翻译选项，四个颜色目标分别读取
  R0/R2/R3/R4；关闭时仍读取 H0/H4/H6/H8，深度仍使用 R1.z。此前翻译器支持
  此选项但真实绘制没有传入，会把全精度输出误读为 packed half。控制位与输出
  映射核对 RPCS3 的 gcm_enums.h / GLFragmentProgram.cpp，NV40 合法位范围核对
  envytools 的 MthdRankinePsControl。完整真实 WebGPU 回归验证 FP16/FP32 两种
  四目标输出、独立颜色掩码与单目标复用；插件 Closure 构建通过。

- G4 FP32 片元纹理：RGBA32F/R32F 的线性/Morton 存储通过 checked DMA 读取，
  R32F 在分量交叉选择前扩展为 (R,0,0,1)，原始 NaN payload 与负零按 u32 保留。
  使用共享执行器的 RGBA32F 资源及 nearest/nearest-mip 取样；FP32 线性过滤仍
  显式拒绝。CPU 回归检查原始位、扩展、交叉选择及 DMA 末字节；完整真实 GPU
  回归验证 HDR、负值和标量扩展至 FP16 渲染目标，Closure 构建通过。

- G4 双面模板第一部分：把正反面的比较、stencil-fail、depth-fail、pass 操作映射
  到共享执行器的 CW/CCW 状态组，随 NV 的 FRONT_FACE 交换；关闭双面模式恢复
  两个绕向使用同一状态。两面的 reference/read/write mask 相同时已接通，不同
  时仍明确拒绝。完整真实 WebGPU 回归验证正面递增、背面递减、独立 NEVER 比较、
  前面绕向切换与关闭后恢复；CPU 状态回归及 Closure 构建通过。

- G4 多边形深度偏移：接通填充三角形的 factor/units，按 Mesa nv30 的两倍单位
  编码换算。共享执行器在片元阶段加归一化常量，因此 D16 与 D24 分别按客体
  的 16/24-bit 精度换算，不能按宿主深度存储统一处理。真实 GPU 回归检查两种
  格式的已知常量偏移、窗口空间斜率以及关闭后恢复；完整 GPU 回归、CPU 状态
  测试及 Closure 构建通过。点/线模式的多边形偏移仍随其 raster mode 保留未实现。

- G4 sRGB 纹理第一部分：接通 TEX_WRAP 的 RGB gamma-decrease mask（7），使用
  共享执行器的 sRGB 视图，在取样过滤前解码 RGB，保留 alpha。其他逐分量 mask
  及浮点/深度纹理 gamma 仍显式拒绝。真实 GPU 回归验证已知中灰转换、alpha
  保留和黑白 texel 在线性空间中的双线性平均；完整 GPU/CPU 回归及 Closure
  构建通过。

- G4 纹理分数 LOD：保留 NV40 的独立 f32 最小/最大 LOD，在共享执行器 sampler
  的私有状态 62/63 传递，进入 sampler 缓存键；D3D 客体不写这两个槽，仍使用
  原有 MAXMIPLEVEL/SetLOD 规则。按向上取整的最大层上传三线性过滤需要的相邻
  mip，最小值高于最大值时以最小值为准。真实 GPU 回归检查 1.25 最小值、0.5
  最大值的已知颜色混合；完整 GPU 回归、190 项执行器测试、CPU 纹理测试以及
  Closure/WebGPU bundle 构建通过。深度纹理仍保持单级限制。

- G4 片元 1D 纹理：线性/Morton 存储忽略矩形 height，作为单行资源上传；程序
  降低忽略 Y 寻址及 Y 梯度，TXP 在 W 除法后仍落在唯一一行的中心，rectangle
  模式只按 X 尺寸归一化。真实 GPU 回归验证越界 Y 不触发 T 边框、投影 X 与
  像素单位 X，完整 GPU 回归、166 个 Naga 模块、CPU 纹理测试与 Closure 构建
  通过。

- G4 TEX8/TEX9：接通 XF_OUT_MAP_TXC_B 的两个寄存器选择与 VP_RESULT_EN bit
  12/13，通过共享执行器的语义链接传递到片元 TEX8/TEX9 输入。默认不额外启用
  两路输出，现有程序的输出预算不变。真实 GPU 回归检查两路映射的非零颜色；
  CPU 路由测试、168 个 Naga 模块、完整 GPU 回归和 Closure 构建通过。

- G3 RGB565 通道回归：真实 GPU 用已知片元常量验证 NV 16-bit 目标的 R 高/B 低
  存储；原生 D3D9 探针再用 D3DCOLOR 顶点绘制到 lockable RGB565 目标，检查
  GetRenderTargetData、GetDC 和 BitBlt 至 24-bit DIB。XP 93.71 冷启动读回
  `0x3333` / RGB `0x31659C`，全部通过，无 GPU/PGRAPH/DMA 故障，原盘未变，
  见 `g3-xp-9371-rgb565.json`。这排除所覆盖的顶点/目标/GDI 转换路径；独立的
  3DMark99 固定帧红蓝差异仍未解决，不能据此接受完整 G3。

- G4 常量 alpha 混合：RGB 的 CONSTANT_ALPHA / ONE_MINUS_CONSTANT_ALPHA
  通过把 blend constant 的 alpha 复制到 RGB 接入宿主混合，独立 alpha 因子仍
  使用原始 alpha。同一绘制还需要不同 RGB 常量颜色时，继续明确拒绝；常量
  四分量本就相同则可以共用。CPU 状态回归覆盖兼容/冲突组合，真实 GPU
  检查非灰色常量下两种因子及独立 alpha，完整渲染回归与 Closure 构建通过。

- G2 INDEX 连续图像流续修：真实 93.71 抗锯齿字体上传 12×20 I4 时只发
  30 DWORD，不能像 IFC 那样逐行补齐为 40 DWORD。INDEX 改为跨行推进一个
  DWORD，仅图像末端忽略填充；I4/I8 都支持，旧快照的行内已提交游标可续读。
  回归覆盖跨行立即生效、输出裁剪、末尾填充、快照与跨行 DMA 故障不留下
  部分写入。原生冷启动复验消除大字号斜条纹，5 个非抗锯齿用例 RGB 完全一致，
  5 个抗锯齿用例逐像素的明暗等级顺序完全一致。后者仍有软件 DIB 色调曲线
  差异，原始 RGB 差异继续记录，不计作颜色精度验收。见
  `g2-xp-9371-aa-packed-index.json`；完整设备/2D/DMA/FIFO/PGRAPH、真实 GPU
  渲染回归及 Closure 构建通过，原盘未变。

- G7 文档前置更新：设备文档改为当前已验证的 XP/98 驱动、显示与 3D 范围，
  补充 Win98 PCI 总线/资源冲突与 XP 原生驱动安装路径、专属 ROM 部署说明及
  NV40 偏差清单。初稿配置项按实际实现复核，阶段状态仍为实施中；完整
  3DMark 参考图、Win98 游戏抽查及 3DMark06 性能门禁通过后才可完成 G7。

- G4 FP32 渲染目标第一部分：接通 R32F/RGBA32F 的绘制与原始浮点读回，
  保留负值和 HDR；通过 FP_CONTROL 的 FP32 输出路由避免半精度舍入。允许
  四个 R32F 或两个 RGBA32F 目标，按 WebGPU 默认保证的 32-byte attachment
  预算限制 RGBA32F MRT。FP32 blending 与浮点 clear 仍明确拒绝，未假设其
  硬件清除编码。完整真实 GPU 回归验证单目标、两种 MRT、预算/混合故障不
  提交部分绘制及切回普通目标；CPU 状态测试与 Closure 构建通过。宿主约束
  核对 [WebGPU 规范](https://www.w3.org/TR/webgpu/#limits)；原生 HDR benchmark
  的完整验收继续后续实施。

- G6 调查计量：客体 harness 输出机器时钟、宿主经过时间及 PIT 状态，新增
  `NV_TRACE=0` 关闭记录路径以便与生产默认状态对照。Win98 同一 bump 检查点
  两组配对各运行约 90 秒：10 倍刷新频率分别为 13/13 次绘制；另一组关闭/
  开启跟踪分别为 8/8 次。后组机器时间约 87 秒、宿主约 91 秒，不能解释
  数秒一帧的等待。两组负载不同，不比较跨组帧率；均无 GPU/PGRAPH/DMA
  故障，原盘及游戏盘未变。见 `g6-win98-99-timing-investigation.json`；同步等待
  根因和最终 3DMark06 性能报告仍未完成。

- G3 纹理红蓝通道续修：原生 D3D9 用四种已知颜色纹理，均复现了 R/B
  交换。Mesa 的 sampler-view 编码表明 TEX_SWIZZLE 从低位到高位是
  A/R/G/B，R 的输出选择位在 2–3、常量选择位在 10–11；此前错误地按
  R/G/B/A 读取。修正普通/BC/浮点纹理及深度比较后 crossbar，并把手写
  GPU 回归的寄存器值改为对应的真实编码，像素期望保持不变。XP 93.71
  冷启动的 ARGB8888、RGB565、ARGB1555、ARGB4444 原生取样全部精确通过，
  无 GPU/PGRAPH 故障，原盘未变，见 `g3-xp-9371-texture-routing.json`。
  CPU 纹理、168 个 Naga 模块、完整真实 GPU 回归与 Closure 构建通过。
  旧 99 IQ 文件仍是修复前证据，固定帧的完整复验继续进行。
