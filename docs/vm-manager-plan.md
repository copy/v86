# 虚拟机管理器计划：替换 index.html

状态：U0–U6 已实现（2026-10-21，`ui` 分支），U7 未实施，见[附录](#附录实施记录)。计划写于 2026-10-18，依据
`arm64` 分支 03a7249f。

本计划用一个仿 VMware Workstation 的虚拟机管理器替换现在的 [`index.html`](../index.html)：
页面有虚拟机库、新建向导、硬件设置对话框和运行控制台，用户在页面里创建磁盘，配置 CPU、
内存、机器类型、要加载的 ISO、显卡、网卡、声卡、ACPI 等，把配置保存下来以后再开机。模拟器
本身不改，新页面只是 `V86` 选项的另一种来源。

现有的 `?profile=` 链接和查询参数继续有效，会直接打开控制台。新页面不再提供“示例系统”
列表。旧页面在过渡期保留为 `legacy.html`，新页面全部做完（U7，[功能对照](#功能对照)逐项完成）
之后删除。

## 现状

- **一个页面，两种状态。** `index.html` 的 `boot_options` 是选择系统与设置，开机后隐藏它，
  显示 `runtime_options`（控制按钮）、屏幕和 `runtime_infos`（信息面板）。所有逻辑在
  [`src/browser/main.js`](../src/browser/main.js)（4152 行），其中：
  - `onload`（288 行起）：内含 137 个系统配置（计划初稿误记为 138）（`oses`，319 行起）。首页按钮有 92 个，
    其余只能经 `?profile=` 打开；
  - `start_emulation`（2264 行起）：把表单与查询参数变成 `settings`，再变成 `V86` 选项；
  - `init_ui`（3014 行起）：运行时的按钮与信息面板；
  - `init_filesystem_panel` 与 `debug_start`。
- **构建。** `index.html` 加载 `build/v86_all.js`。它用 Closure ADVANCED 把核心、`lib/`、
  `src/browser/` 和 `main.js` 一起编译（[`Makefile`](../Makefile) 199 行）。
  [`debug.html`](../debug.html) 以未编译的 ES 模块加载同一份 `main.js`，带页内调试器。
- **设置项。**
  - 镜像：
    - 光盘、软盘 A/B、硬盘 1/2（文件、空盘、网址加 `read_only`/`read_write`）；
    - multiboot、bzImage、initrd；
    - BIOS、VGA BIOS。
  - 机器：
    - 内存、核数；
    - 并行（每个 vCPU 一个 Worker）；
    - `cpu_type`、`machine_type`；
    - 显卡、显存。
  - 网络：
    - 网络后端（无、页内、relay、wisp、fetch）、relay 地址；
    - 网卡型号、MTU；
    - 调制解调器（UART1–3）。
  - 其他：静音、图形代理、ACPI、启动顺序。
- **运行时功能。**
  - 电源：运行/暂停、重置、退出，保存/载入状态，保存并关机。
  - 按键：Ctrl+Alt+Del、Alt+Tab。
  - 可移动介质与镜像：取回各盘镜像，更换光盘与软盘。
  - 调试与记录：性能记录与导出，内存转储，抓包。
  - 输入与显示：鼠标开关与锁定，全屏，截图，静音，剧院模式，适应窗口与缩放。
  - 面板：
    - 信息面板（速度、存储、9p 文件系统、网络、VGA 模式）；
    - 文件系统收发面板、串口终端；
    - 磁盘错误对话框（`disk_error: "stop"` 时的重试与关机）。
- **查询参数。** `main.js` 读取这些参数：
  - 系统与固件：`profile`、`bios`、`boot_order`、`cmdline`；
  - 镜像：`cdrom.url/size`、`fda.url/size`、`hda.url/size/empty`、`hdb.url/size/empty`、
    `initrd.url`、`kernel.url`、`cdn`、`chunk_size`；
  - 机器：`m`、`cores`、`parallel`、`cpu_type`、`machine_type`、`acpi`、`hpet`、`smbus`、
    `root_ports`；
  - 显示：`graphics_adapter`、`graphics_proxy`、`vram`、`displays`、`s`；
  - 网络与外设：`relay_url`、`net_device_type`、`mtu`、`modem`、`mute`；
  - 调试：`disable_jit`、`c`。

  另有 `hda.disk_option`/`hdb.disk_option`（03a7249f）。站点和用户的书签依赖这些参数。
- **页面直接访问模拟器内部的地方有 15 处。** 例如取回磁盘镜像用
  `emulator.v86.cpu.disk_device("hda").buffer`（3416 行），光驱状态用 `emulator.v86.cpu.devices.cdrom`，
  CPU 在 Worker 中时改走 `worker_controller.device_info`。页面用到的公开方法中，`get_diagnostics`、
  `get_disk_fda`、`get_disk_fdb` 已实现，但 [`v86.d.ts`](../v86.d.ts) 没有声明。

## 构建方式：Closure 之外的 ES 模块

结论（2026-10-18 负责人同意）：新页面写成 ES 模块，放在 `src/app/`，不进 Closure 构建。它只通过
`build/libv86.mjs` 的公开接口驱动模拟器，即 `new V86(...)`、事件和方法，与库的其他使用者
在同一个边界上。理由如下。

1. **没有改名问题。** `libv86.mjs` 对外的选项名和方法名保持原样：编译后的文件里 `memory_size`、
   `cpu_cores` 原样出现，[`tests/api`](../tests/api) 也是这样传选项的。新页面的配置、IndexedDB 中的
   记录和导出的文件都是普通对象，不需要处处加引号。
2. **修改即生效。** 开发时页面以 `<script type="module">` 直接加载 `src/app/` 的源码，库用已编译
   的 `build/libv86.mjs`（或 `libv86-debug.mjs`）。改界面不需要重新编译库。
3. **类型检查顺便检查公开接口。** 用 `tsc --checkJs --noEmit` 对照仓库里已有的 `v86.d.ts`。
   界面用到而类型声明里没有的方法，类型检查会报出来。
4. **语言与浏览器接口不受旧版 Closure 限制。** Closure 固定在 v20210601（[`Makefile`](../Makefile)
   458 行），只接受 ES2020，内置 externs 没有 File System Access 与 OPFS。新页面可以用类字段、
   私有字段、顶层 `await`，以及 `showOpenFilePicker`、`navigator.storage.getDirectory`，
   不需要写 externs。

约束：

- **G1 只用公开接口。** 编译后的库里 `emulator.v86` 等内部对象已被改名，新页面访问不到。
  旧页面的内部访问在新页面改用公开方法：

  | 旧页面 | 新页面 |
  | --- | --- |
  | 取回磁盘镜像：`disk_device("hda").buffer`、软驱的 `drives[i].buffer` | `export_disk_image`、`disk_image_info`（已有） |
  | 内存转储：`cpu.mem8` | `read_memory`（已有） |
  | 光驱里是否有盘：`devices.cdrom.has_disk()`、`device_info["cdrom_present"]` | 新增一个公开方法或事件（U2） |
  | 剖析器开关与清零统计：`wm.exports["profiler_is_enabled"]`、`clear_stats` | 只在调试页需要，新页面不提供 |

  已实现但未声明的 `get_diagnostics`、`get_disk_fda`、`get_disk_fdb` 在 U2 补进 `v86.d.ts`。
  新页面访问模拟器的代码集中在 `src/app/emulator_bridge.js`，补公开接口时只改这里。
- **G2 两套类型检查。** 库仍由 Closure 检查，`src/app/` 由 tsc 检查：
  - tsconfig 不打开 `checkJs`，`src/app/` 的每个文件以 `// @ts-check` 开头。被导入的共用模块
    （见 G5）用的是 Closure 写法的 JSDoc，它们只参与类型推断，不报错。
  - `import { V86 } from "v86"` 在三处解析到同一份库：
    - 类型检查：tsconfig 的 `paths` 指向 `v86.d.ts`；
    - 运行时：页面的 import map 指向 `build/libv86.mjs`；
    - 打包：esbuild 的 alias 指向同一个文件。
- **G3 新的开发依赖。** `package.json` 加 `devDependencies`：`typescript` 与 `esbuild`，并提交
  `package-lock.json`。安装要从 npm 下载，到 U2 时按下载规则请负责人确认。Makefile 新增
  `make app`（esbuild 打包）与 `make app-check`（tsc），都并入本地门禁。GitHub CI 不改。
- **G4 发布包。** esbuild 把 `src/app/main.js` 打成 `build/v86_app.js`：ES 模块，压缩，带 source map。
  `libv86.mjs` 不打进去，作为外部依赖：它是独立的库文件（npm 包也发布它），浏览器单独缓存。
  Cloudflare Pages 照旧托管静态文件，部署流程在 `make all` 之后加 `make app`。
- **G5 共用模块两边都要能用。** `src/browser/` 下的 `profiles.js`、`vm_options.js`、`query_compat.js`
  有两种用法：旧页面在 Closure 构建里导入，新页面作为 ES 模块直接导入。因此：
  - 它们只能是纯模块，不依赖 Closure 的 define（`DEBUG`），也不依赖内部对象；
  - `vm_options.js` 生成选项对象时沿用 `main.js` 现在的写法：库按引号读取的键（如
    `"cpu_type"`、`"jit_switches"`）照样加引号，两种用法得到的选项相同；
  - U0 的基线测试同时覆盖这两种用法。
- **G6 不用界面框架（建议）。** 四个界面加十几个面板，用一个小的 `h()` 建 DOM 帮手、表单
  绑定和对话框组件（`src/app/ui/dom.js`）就够了，不引入 Preact、Lit 等依赖。ES 模块方案
  并不排斥框架，以后确有需要再议。

旧页面 `legacy.html` 继续用 Closure 编译的 `build/v86_all.js`，不变。

未采用的方案是放进 Closure ADVANCED 构建，与 `main.js` 相同。它不需要新工具链，可以直接
访问内部，但有这些代价：
- 持久化的配置要处处加引号防止改名。`main.js` 里已有引号混用的痕迹，见 2846 行的注释。
- File System Access 与 OPFS 要写 externs。
- 语言停在 ES2020。
- 每次改界面都要重编整个包，才能在发布页上验证。

## 界面

### 虚拟机库（首页）

- **左栏**是虚拟机列表：名称、客户机图标、状态（关机、已挂起、正在另一标签页运行）。
  上方有“新建虚拟机”和“导入”按钮。
- **右栏**是选中虚拟机的摘要：硬件表（与设置对话框同一份数据）、备注，以及这些按钮：
  - 开机、编辑设置；
  - 从挂起恢复、丢弃挂起状态；
  - 克隆、导出、删除。
- **不提供“示例系统”列表**（负责人决定）。现在首页的 92 个系统按钮与过滤不搬到新页面。
  137 个配置只用来解析 `?profile=` 链接，见[兼容](#兼容)。

### 新建虚拟机向导

1. **安装来源。** 可以选：
   - 光盘镜像、软盘镜像或已有硬盘镜像，来源为网址、本地文件、浏览器磁盘或磁盘服务里的镜像；
   - 稍后安装。
2. **客户机系统。** 选一个预设（见[客户机预设](#客户机预设)），它给出全部硬件的默认值、
   安装方式和安装后的步骤，用户不必手动配置；需要时仍可在最后一步“自定义硬件”。
3. **名称与备注。**
4. **磁盘。** 可以新建空盘（选大小）、使用已有镜像或不要硬盘。新建空盘时还要选存放位置，
   见[磁盘的存放位置](#磁盘的存放位置)。
5. **摘要。** 最后一步可以“完成”，也可以“自定义硬件”，后者直接打开设置对话框。

### 客户机预设

新建虚拟机时，用户只需选系统、给出安装来源、名字和磁盘大小，其余全部来自预设。预设是
`src/app/guest_presets.js` 里的完整配置模板（[虚拟机配置格式](#虚拟机配置格式)的一份默认值），再加上：

- **验证状态**：已验证（注明依据的文档或测试），或未验证（沿用最接近的已验证配置，界面上标出）；
- **安装方式**：从光盘或软盘安装、使用现成的磁盘镜像，或直接引导（内核加 initrd，或 Android 的启动材料）；
- **安装后的步骤**：驱动、HAL 切换等，在虚拟机的摘要页显示为一张清单；
- **已知问题**：来自各系统文档的注意事项。

启动顺序随安装介质（v86 的默认行为：有软盘时软盘优先，有硬盘时硬盘优先，否则光盘优先），
预设不另行规定。所有 PC 预设都按 v86 的规则：多核需要 ACPI，Q35 总是打开 ACPI，HPET 只在 Q35 上。

| 预设 | CPU、机型 | 内存 | 核数 | 磁盘 | 显卡（显存） | 网卡 | 声卡 | ACPI | 安装方式 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DOS（MS-DOS 6.22、FreeDOS） | x86、i440FX | 64 MiB | 1 | IDE，128 MiB | Bochs VGA（8 MiB） | ne2k | SB16 | 关 | MS-DOS 从软盘、FreeDOS 从光盘 | 已验证（docs/dos.md，`tests/full/run.js`） |
| Windows 3.x | x86、i440FX | 64 MiB | 1 | IDE，128 MiB | Bochs VGA（8 MiB） | ne2k | SB16 | 关 | 先装 MS-DOS 6.22，再从软盘装 Windows | 已验证（docs/windows-31x.md） |
| Windows 95 / 98 / ME | x86、i440FX | 64 / 256 / 256 MiB | 1 | IDE，2 GiB | Bochs VGA（16 MiB） | ne2k | SB16 | 关（镜像没有 ACPI HAL） | 光盘加 Patcher9x 软盘 | 已验证（站点的 Win98 状态：`tests/r1/windows9x.mjs`；docs/windows-9x.md） |
| Windows NT 4 | x86、i440FX，`cpuid_level: 2` | 512 MiB | 1 | IDE，2 GiB | Bochs VGA（16 MiB） | ne2k | SB16 | 关 | 光盘 | 已验证（docs/windows-nt.md） |
| Windows 2000 | x86、i440FX | 512 MiB | 1 | IDE，2 GiB | Bochs VGA（16 MiB） | ne2k | SB16 | 关 | 光盘 | 已验证（docs/windows-nt.md，`tests/full/run.js`） |
| Windows XP | x86、i440FX | 2048 MiB | 1 | IDE，4 GiB | Bochs VGA（16 MiB） | ne2k | SB16 | 关 | 光盘 | 已验证（所有者的 XP 性能门禁配置：`tests/ir/performance/xp_boot.mjs`） |
| Windows 8.1（x64） | x86_64、i440FX | 2048 MiB | 2 | IDE，32 GiB | VMware SVGA II（16 MiB，DX10 以上级别） | 无（见已知问题） | 无 | 开 | 现成的磁盘镜像 | 已验证（`tests/x64/windows_boot.mjs`，docs/windows-nt.md；在 v86 里从光盘安装没有验证过） |
| Windows Vista / 7 / 10 | 同 Windows 8.1（Vista：x86 也可，512 MiB 以上） | | | | | | | | 光盘 | **未验证**：Vista 只验证过安装光盘能启动，7 与 10 没有测过 |
| Linux（32 位） | x86、i440FX | 512 MiB | 1（最多 8） | IDE，8 GiB | Bochs VGA（8 MiB） | ne2k | SB16 | 开 | 光盘（Live 或安装） | 已验证（Linux 4.16、6.8、6.18：docs/multicore.md、docs/acpi.md、docs/q35.md） |
| Linux（x86_64） | x86_64、i440FX | 1024 MiB | 2 | IDE，8 GiB | virtio-gpu（或 VMware SVGA II） | virtio | SB16 | 开 | 光盘 | 已验证（Alpine 3.24：docs/x86-64.md，docs/gpu-devices.md） |
| Linux（arm64） | arm64、virt；CPU Worker，page tier | 1024 MiB | 4 | virtio-blk，8 GiB | virtio-gpu | virtio | 无 | 不适用（设备树） | 光盘镜像中的内核与 initrd 直接引导，光盘作只读 virtio 盘 | 已验证（Alpine 3.24 aarch64：docs/aarch64.md，`tests/a64/linux_boot.mjs`） |
| Android 16（arm64） | arm64、virt；CPU Worker，page tier（代码预算 160 MiB） | 1536 MiB | 4 | virtio-blk，Android 的 GPT 磁盘 | virtio-gpu（00:02.0，720×1280；Venus 完成后用 Venus） | 三张 virtio 网卡，第三张接 fetch | 无 | 不适用 | Android 的启动材料（`tools/a64_android.mjs`：内核、initrd、cmdline、磁盘） | 已验证到 boot_completed 与 A9 场景（docs/aarch64.md）；图形见 ARM64 计划 P11.4 |

表中的磁盘大小是新建空盘的默认值，不是验证条件（例如 DOS 验证用的是 64 MB、站点的 Win98 C 盘是
512 MB）。内存取验证时的值，只有 Linux 三项按文档示例取了更宽裕的默认值：32 位验证于 128 MiB，
x86_64 于 512 MiB 与 1 GiB，arm64 于 512 MiB 与 1536 MiB。核数同理：Linux 32 位验证过 1、2、3、4、
8 核，x86_64 验证过 1、2、4 核，Windows 8.1 验证过 1、2、4 核。

Android 预设还带上测试中的整套设备：virtio 走 PCI、18 个 virtio console 端口、vsock、
键盘与多点触摸。Android 和 Linux（arm64）的磁盘默认放在浏览器磁盘或磁盘服务里，以便
重启后数据仍在。

安装后的步骤与已知问题（各预设的清单，取自对应文档）：

- **Windows 95/98/ME**：零售光盘有问题（#1556），需要 FIX95CPU 或 Patcher9x；软驱只在 MS-DOS
  兼容模式下可用。
- **Windows 3.x**：WfW 3.11 要装键盘修正（vkda.386）、SB16 驱动、vbesvga 显示驱动；Windows 3.1 的
  网卡不可用，改用调制解调器与 PPP。
- **Windows 2000**：装好后切换到“Standard PC” HAL；SB16 驱动。
- **Windows XP**：保持 x86（x86_64 会让 XP 启用 PAE 内核）；XP 与 2000 的 ACPI HAL 没有验证，所以
  只能单核；3DMark06 一类的 D3D 程序需要 `driver.iso` 中的 `d3d9.dll`。
- **Windows 8.1**：显卡驱动二选一：VMware Tools 13.1.5 的 vm3d（需要先装 KB2919355），或测试签名的
  viogpudo 0.1.240（只有 2D）；把 TDR 超时调到 60 秒；ne2k 没有 Windows 8.1 驱动，virtio 网卡驱动未
  验证；没有声卡（HDA 在现代 PC 设备计划中）；镜像从 IDE 改到 Q35/AHCI 前要先设置 storahci；不能用
  解释器运行（太慢）。
- **Linux（arm64）与 Android**：只在 page tier 下可用；Android 的已知问题见 docs/aarch64.md。

验收（U3）：每个预设生成的配置都通过 `check_machine_options`；已验证的预设各有一条依据（文档或
测试），未验证的在界面上标出；仓库中有镜像的预设（FreeDOS、Linux 32 位、Linux arm64）在无头
Chrome 中从向导建好的虚拟机启动到提示符。

### 设置对话框

设置对话框对应 VMware 的“虚拟机设置”：左边是硬件列表，右边是所选项目的面板，下方有
“添加…”和“移除”按钮。

| 硬件 | 面板内容 |
| --- | --- |
| 内存 | 大小 |
| 处理器 | `cpu_type`、核数、并行，以及 JIT 开关（高级） |
| 机器与固件 | 见下 |
| 硬盘（可多块） | 来源（网址、本地文件、空盘）、`disk_option`、总线（随机器：IDE、AHCI、virtio-blk） |
| CD/DVD | 镜像，开机时连接 |
| 软盘 A/B | 镜像，开机时连接 |
| 网络适配器 | 型号（ne2k、virtio）、后端（无、页内、relay、wisp、fetch）、relay 地址、MTU；virt 机器上的网卡数 |
| 声卡 | SB16 或无 |
| 显示 | 显卡、显存、图形代理、多显示器（virtio-gpu） |
| 串口与并口 | UART1–3 各自不接、接终端或接调制解调器；LPT2 |
| 共享文件夹 | 9p 文件系统 |
| 直接启动 | bzImage、initrd、cmdline、multiboot；arm64 的 kernel、dtb |
| 输入设备 | virt 机器的 virtio keyboard、tablet、multitouch |
| 高级 | CPU Worker、`disable_jit`、x87 选项等 |

内存、处理器、机器与固件、显示是固定项，其余项可以添加或移除。

“机器与固件”面板的内容：

- `machine_type`；
- BIOS、VGA BIOS；
- ACPI、HPET、SMBus；
- PCIe 根端口；
- 启动顺序、fastboot、启动菜单。

内存面板的规则：

- 超过 2048 MB 时要求 x86_64，并按 `set_memory_size`（`main.js` 263 行）拆成堆内存与扩展内存；
- 上限随 `cpu_type` 变化。

**规则只有一份。** 哪些项可用由
[`src/machine_options.js`](../src/machine_options.js) 决定：`CPU_TYPES`、`MACHINE_TYPES`、
`PC_ONLY`、`VIRT_ONLY`、`VIRT_GRAPHICS_ADAPTERS`。U0 把这些表导出（或加一个
`allowed_options(cpu_type, machine_type)`）。新页面把这个纯模块当作数据直接导入，对话框据此
禁用不适用的项，并说明原因，例如“virt 机器没有 VGA”。这些表格之外的组合限制也放在同一处：

- q35 才有 HPET、SMBus 和根端口；
- 多核需要 ACPI（现在由 `main.js` 2862 行隐含打开）；
- ne2k 不在 virt 上。

保存前做完整校验：先把配置转换成选项，再运行 `check_machine_options` 和
[`src/disk_options.js`](../src/disk_options.js) 的检查。错误显示在对应的面板上，不用 `alert`。

### 控制台（运行页）

**工具栏**（菜单式，取代现在一排按钮）：

- 电源：关机、重置、挂起、保存并关机；
- 发送按键：Ctrl+Alt+Del、Alt+Tab，以及自定义组合；
- 可移动设备：光盘和软盘的更换与弹出，各盘镜像的取回；
- 视图：全屏、适应窗口、缩放、剧院模式、截图；
- 输入：鼠标开关、锁定鼠标；
- 声音：静音；
- 工具：性能记录与导出、内存转储、抓包。

**状态栏：** 运行时间、速度（当前与平均）、磁盘与网络活动、VGA 模式与分辨率、鼠标状态，
来自现在的信息面板（`update_info`，3251 行）。

**侧栏抽屉：** 串口终端、共享文件夹收发、详细信息。

**磁盘错误对话框：** 沿用现有的 `disk_error_box`。

**`read_write` 盘与关闭页面：** 有 `read_write` 盘时，关闭页面前提示，并提供“保存并关机”。
这沿用现有的 `onbeforeunload`（4004 行）。

**一个标签页运行一台虚拟机。** 控制台的网址是 `index.html?vm=<id>`，开机在新标签页打开，
库所在的标签页留着。同一台虚拟机不能在两个标签页同时运行，用 `navigator.locks` 的
排他锁保证。`read_write` 盘另有磁盘服务的租约保护。

## 虚拟机配置格式

JSON，带格式名与版本号，按版本迁移（`vm_config.js` 的 `migrate`）。示例：

```json
{
    "format": "v86-vm",
    "version": 1,
    "id": "6c1f…",
    "name": "Windows 98",
    "notes": "",
    "guest": "windows9x",
    "template": "windows98",
    "created": "2026-10-18T09:00:00Z",
    "modified": "2026-10-18T09:00:00Z",
    "machine": { "type": "i440fx", "acpi": false, "hpet": false, "smbus": false, "pcie_root_ports": 0,
                 "boot_order": 0, "fastboot": false, "bios": null, "vga_bios": null },
    "cpu": { "type": "x86", "cores": 1, "parallel": false, "jit": true },
    "memory": { "mb": 128 },
    "disks": [
        { "slot": "hda", "image": { "kind": "url", "url": "https://…/win98.img", "size": 314572800 },
          "disk_option": "read_only" }
    ],
    "cdrom": { "image": null },
    "floppies": [ { "slot": "fda", "image": null } ],
    "kernel": null,
    "display": { "adapter": "bochs_vga", "vram_mb": 8, "proxy": false, "displays": 1 },
    "network": [ { "device": "ne2k", "backend": "relay", "relay_url": "wss://relay.widgetry.org/", "mtu": 1500 } ],
    "sound": { "device": "sb16" },
    "serial": [ { "port": 1, "attach": "terminal" } ],
    "filesystem": null,
    "advanced": { "cpu_worker": true },
    "suspended": null
}
```

镜像来源 `image` 有四种：

| `kind` | 字段 | 说明 |
| --- | --- | --- |
| `url` | `url`、`size`、可选 `fixed_chunk_size` | 网址（含 CDN），按块读取。若 `url` 指向磁盘服务，可以配 `read_write`（磁盘计划决定 5） |
| `file` | `name`、`size`、`last_modified`、`handle` | 本地文件。Chrome/Edge 把 `FileSystemFileHandle` 存进 IndexedDB，开机时在用户点击中重新请求权限。其他浏览器只记名字与大小，开机时请用户重新选取，并核对名字、大小与修改时间 |
| `empty` | `size` | 新建的内存盘，关机即丢失，见[磁盘的存放位置](#磁盘的存放位置) |
| `browser` | `path`、`size` | 浏览器磁盘，转换成 `url: "opfs:<path>"`，见[浏览器磁盘](#浏览器磁盘opfs) |

转换函数 `config_to_options(config)` 在 `src/app/vm_config.js`（实施时由 `vm_options.js` 移来，见附录 U1 偏差 1），
建在新旧两个页面共用的 `vm_options.js` 的规则上。
转换规则从 `start_emulation` 提取，各配置节的对应关系：

| 配置 | `V86` 选项 |
| --- | --- |
| `machine.*` | `machine_type`、`acpi`、`hpet`、`smbus`、`pcie_root_ports`、`boot_order`、`fastboot`、`bios`、`vga_bios` |
| `cpu.*` | `cpu_type`、`cpu_cores`、并行、`disable_jit`、`experimental_smp_jit` |
| `memory.mb` | `memory_size`，超过 2048 MB 时加 `extended_memory_size`（`set_memory_size`） |
| `disks`、`cdrom`、`floppies` | PC 机器上是 `hda`/`hdb`/`cdrom`/`fda`/`fdb`；virt 机器上是 `virtio_disks`（光盘只读）。`disk_option` 原样传入 |
| `kernel` | `bzimage`、`initrd`、`cmdline`、`multiboot`；arm64 是 `kernel`、`dtb` |
| `display.*` | `graphics_adapter`、`vram_size`、`graphics_proxy` |
| `network[]` | `net_device`（`type`、`relay_url`、`mtu`、`count`）、`network_relay_url` |
| `sound.device` | 为 `none` 时 `disable_speaker` |
| `serial[]` | `uart1`–`uart3`、`modem` |
| `filesystem` | `filesystem` |

查询参数也转成同一种配置（`query_compat.js`），所以 `?profile=` 与 `?hda.url=…` 走同一条路径。

## 存储与持久化

- **配置。** 存在 IndexedDB 数据库 `v86-vm-manager`：
  - `vms` 表以 `id` 为键，存配置；
  - `handles` 表存文件句柄。

  “导出”下载一个 `.v86vm.json` 文件，“导入”读回它。本地文件的句柄不能导出，导入后这类
  来源显示为“需要重新选取”。
- **挂起与恢复。** VMware 的挂起对应 v86 的保存状态并关机：
  - 挂起：用 `save_state_stream` 写到 OPFS 的 `states/<id>.bin`；
  - 恢复：用 `restore_state_stream` 读回；
  - 配置的 `suspended` 记下文件大小、时间和配置摘要，配置改过之后，恢复前会提示。

  状态可能有几百 MB。挂起前用 `navigator.storage.estimate()` 检查空间。首次挂起时请求
  `navigator.storage.persist()`，Firefox 会弹出询问，这是用户自己的操作。`read_write` 盘的
  保存与恢复规则以[磁盘计划的快照一节](disk-persistence-plan.md#快照save_state-与-initial_state)为准，
  被拒时如实提示。
- **存储被清除。** 浏览器清除站点数据会删掉库和挂起状态。库页面要说明这一点，并提示定期
  导出。

### 磁盘的存放位置

“新建空盘”是 VMware 流程的核心：建盘、装系统、以后再开机。向导提供三种存放位置：

| 位置 | 保留多久 | 适用 |
| --- | --- | --- |
| 浏览器磁盘 | 跨会话保留，直到用户删除或浏览器清除站点数据 | 静态托管（Cloudflare Pages）上的默认选择，见[浏览器磁盘](#浏览器磁盘opfs) |
| 磁盘服务 | 写回服务目录里的镜像文件 | 本机开发与 `make run`，或自建的服务器，见[磁盘服务的创建与列出](#磁盘服务的创建与列出) |
| 内存 | 关机即丢失；挂起时整盘内容进入状态文件 | 临时试用、小盘。向导里明示“关机后丢失” |

向导检测到配置好的磁盘服务时才显示第二种。

## 浏览器磁盘（OPFS）

浏览器磁盘是浏览器私有存储（OPFS）里的一个镜像文件。它跨会话保留，网站上的镜像不受任何
影响。

### 与磁盘计划的关系

磁盘计划决定 7 说，“在浏览器里保留修改（OPFS 副本）不属于 `read_write`，是单独的功能”。
那里说的是以网站上的镜像为源、修改另存一层。浏览器磁盘不是修改层：

- 新建空盘时，OPFS 文件就是镜像本身；
- 从网址或本地文件导入时，先把整份镜像复制进 OPFS，从此它是一个独立的镜像，与原来的网址
  再无关系。

所以浏览器磁盘是一种新的来源，`disk_option` 的语义照常适用于它：

- `read_write`：写回这个 OPFS 文件；
- `read_only`：修改留在内存，文件不变。

负责人于 2026 年 10 月 18 日确认了这一理解（[已决定](#已决定)第 5 条），磁盘计划的决定 7 下已加注。

`read_write` 永远写回 `url` 指向的那份文件本身，不会改写到别处的副本里。OPFS 只在用户明确
新建或导入浏览器磁盘时出现。各种来源对照如下：

| 来源 | `url` | `read_only` | `read_write` 写到哪里 |
| --- | --- | --- | --- |
| 网站或 CDN 上的镜像 | `https://…/win98.img` | 修改留在内存，关机丢弃 | 不能写，启动时报错 |
| 本地磁盘，经本机磁盘服务 | `http://127.0.0.1:8471/win98.img` | 同上 | 用户电脑上的那个镜像文件 |
| 本地文件，用“选择文件”打开 | 浏览器给的 `File` | 同上 | 不能写，启动时报错，提示改用磁盘服务（浏览器不能原地改写用户的文件，磁盘计划评审结论第 9 条） |
| 浏览器磁盘 | `opfs:v86/disks/<id>.img` | 同上 | 浏览器私有存储里的那份文件 |

把本地文件或网址导入为浏览器磁盘是一次复制，之后的修改只在副本里，原文件不变；导入对话框
写明这一点。设置对话框的硬盘面板显示盘的位置（本机磁盘服务与路径、浏览器存储、网址、本地
文件），让用户知道修改写到哪里。

### 选项

按磁盘计划决定 5，镜像只用 `url` 指定，不新增来源字段。浏览器磁盘的网址形如
`opfs:v86/disks/<id>.img`，即 OPFS 根目录下的路径：

```js
hda: { url: "opfs:v86/disks/6c1f.img", disk_option: "read_write" }
```

启动校验（[`src/disk_options.js`](../src/disk_options.js)）对它的规则：

- 文件不存在时报错，不悄悄新建；
- 在 Node 中或 CPU 不在 Worker 中时报错，见下文；
- 光驱只能 `read_only`，同现有规则；
- 软盘可以用。

### 后端

浏览器磁盘在库里有一个后端 `OpfsDisk`（新文件 `src/opfs_disk.js`，进 Closure 的核心文件列表）。
它照 [`src/disk_writeback.js`](../src/disk_writeback.js) 的 `NodeFileDisk` 写，满足同一份后端契约
（`BACKEND_CONTRACT`），两者把文件描述符换成 OPFS 的同步访问句柄
（`FileSystemSyncAccessHandle`）：

| `NodeFileDisk` | `OpfsDisk` |
| --- | --- |
| `fs.readSync` | `handle.read(buffer, { at })` |
| `fs.writeSync` | `handle.write(buffer, { at })` |
| `fs.fdatasyncSync` | `handle.flush()` |
| `fs.fstatSync().size` | `handle.getSize()` |

由此，磁盘计划为本地文件定下的规则都原样适用：

- 写入回到 OPFS 文件后才完成，flush 之后才持久；
- `read_write` 的 IDE/AHCI 盘报告易失写缓存（决定 2）；
- 定时 flush：空闲 1 秒，最长 5 秒（决定 3）；
- `stop()`、`destroy()` 与拔出时 flush 并关闭；
- 错误按 `disk_error` 处理。空间不足（`QuotaExceededError`）是不可重试的写错误：默认暂停
  虚拟机，并提示用户释放空间。

**身份与 generation。** OPFS 文件没有 inode。每个浏览器磁盘旁边有一个
`v86/disks/<id>.json`，记 UUID、generation、大小：

- 打开时如果大小与记录不符，generation 加一；
- `mark`（保存状态）时 generation 加一并写回 `.json`。

快照规则因此与本地文件相同：挂起状态只记引用，恢复时核对身份与 generation，不符则拒绝，并
如实提示。

**只能在 Worker 中。** 同步访问句柄只在专用 Worker 中可用。CPU 默认就在 Worker 里
（`cpu_worker`），后端在那里打开句柄。`debug.html?cpu_worker=0` 等在页面中运行 CPU 的情形，
启动时报“浏览器磁盘需要 CPU Worker”。这里不另写一个经消息转发的异步后端，它只服务调试页。

**排他。** 同步访问句柄天然是排他的：同一个文件在另一个标签页已经打开时，`createSyncAccessHandle`
抛出 `NoModificationAllowedError`。后端把它报成“这块磁盘正被另一个标签页使用”。这与控制台的
单标签页锁（`navigator.locks`）互为保险。

### 管理

管理操作在 `src/app/vm_store.js` 中进行，用页面上的异步 OPFS 接口：

- **新建。** `createWritable` 后 `truncate(size)`，再写 `.json`。实际占用的空间（是否稀疏）
  在 U6 中用 `navigator.storage.estimate()` 测量后记录。
- **导入。** 从网址（流式 `fetch`）或本地文件（`File.stream()`）复制进 OPFS，显示进度。完成后
  核对大小，并对比源与副本的 SHA-256：导入时边写边算，校验时重读副本。
- **导出。**
  - Chromium：`showSaveFilePicker` 流式写出；
  - 其他浏览器：`getFile()` 得到 `File` 后下载，不需整份读进内存。

  运行中的盘用控制台的“取回镜像”（`export_disk_image`）。
- **删除。** 删除虚拟机时一并删除它独占的浏览器磁盘，删除前确认。正在使用的盘无法删除
  （句柄排他）。
- **空间。** 新建与导入前用 `navigator.storage.estimate()` 检查剩余配额。首次建浏览器磁盘时
  请求 `navigator.storage.persist()`，以免浏览器在空间紧张时自动清除。库页面显示每块盘的大小
  与总占用。

浏览器支持：Chromium、Firefox、Safari 的当前版本都有 OPFS 的同步访问句柄。各自的最低版本在
U6 中核实，写进文档。

## 磁盘服务的创建与列出

[`tools/disk-service.mjs`](../tools/disk-service.mjs) 现在只能打开已有的镜像。新增两个操作，用法与
现有操作相同：POST，以 `X-V86-Disk-Op` 区分，核对 `Origin`，配了 `--token` 时要求令牌，回答
JSON。

| 操作 | 请求 | 语义 |
| --- | --- | --- |
| `create` | 发往新镜像自己的网址 `<服务>/<名字>`，带 `X-V86-Disk-Size` | 新建一个全零的 RAW 镜像，回答名字、大小与网址 |
| `list` | 发往服务的根网址 `<服务>/` | 列出目录中的镜像：名字、大小、修改时间、是否有写者 |

`create` 的规则：

- **默认关闭。** 服务以 `--allow-create` 启动才接受 `create`，`tools/dev-server.py`（`make run`）带上它。
  只为写回已有镜像而启动的服务，不会被网页用来在目录里新建文件。
- **名字。** 只接受目录内的文件名：字母或数字开头，只含字母、数字、`.`、`_`、`-`，以 `.img`
  结尾，不超过 128 个字符。沿用 `image_of` 的规则：不含路径分隔符，不以 `.` 开头。
- **不覆盖。** 以 `wx` 方式创建，已存在时回答 409。
- **大小。** 必须是 512 的正整数倍，不超过 `--max-size`（默认 64 GiB）。用 `ftruncate` 扩展，
  文件系统支持时是稀疏文件。大小超过目录所在卷的剩余空间（`fs.statfsSync`）时拒绝。
- **落盘。** 建好后先 `fsync` 文件与目录，再登记身份（UUID、generation 1），并写入状态文件
  `.v86-disk-service.json`。
- **没有删除操作。** 网页不能删除服务目录里的文件。删除虚拟机时，管理器提示用户镜像文件
  仍留在服务目录中，需要自己删除。

旧版本的服务对 `create`、`list` 回答 400（“unknown operation”），管理器据此提示“此磁盘服务
不支持创建镜像”。协议版本仍为 1。

**管理器一侧。** “首选项”里配置磁盘服务的地址与令牌，存进 IndexedDB。

- 页面从 `localhost` 提供时，默认探测 `http://127.0.0.1:8471/`，即 `make run` 启动的服务，
  探测方法是发一次 `list`。
- 探测成功时，向导的存放位置里出现“磁盘服务”，“使用已有镜像”也可以从 `list` 的结果中选。
- 磁盘服务里的镜像在配置里就是 `kind: "url"`，网址指向服务，`disk_option` 为 `read_write`。

## 代码结构

新文件放在 `src/app/`，不在 Closure 的文件列表里。`Makefile` 新增 `make app`（esbuild 打包成
`build/v86_app.js`）与 `make app-check`（tsc），`tsconfig.json` 只覆盖 `src/app/`。

| 文件 | 内容 |
| --- | --- |
| `main.js` | 入口；按网址路由到库、控制台或 `?profile=` |
| `vm_config.js` | 格式、默认值、`migrate`、校验 |
| `vm_store.js` | IndexedDB、文件句柄、OPFS 中的挂起状态与浏览器磁盘的管理 |
| `guest_presets.js` | 向导的客户机预设，见[客户机预设](#客户机预设) |
| `emulator_bridge.js` | 唯一访问模拟器的模块，只用公开接口（G1） |
| `disk_service_client.js` | 磁盘服务的 `list`、`create` 与探测 |
| `ui/dom.js` | `h()`、表单绑定、对话框、菜单 |
| `ui/library.js`、`ui/wizard.js`、`ui/settings.js`、`ui/console.js` | 四个界面 |
| `ui/panels/*.js` | 设置对话框的各硬件面板 |
| `app.css` | 样式（`v86.css` 留给旧页面） |

新旧页面共用的代码放在 `src/browser/`，U0 从 `main.js` 提取。它们是纯模块，两种用法见 G5：

| 文件 | 内容 |
| --- | --- |
| `profiles.js` | 137 个配置，即现在 `onload` 中的 `oses`；新页面只用来解析 `?profile=` |
| `vm_options.js` | 默认值、表单的默认值、开机设置的规整（`apply_form`）与 `V86` 选项（`settings_to_options`）；`config_to_options` 在 `src/app/vm_config.js` |
| `query_compat.js` | 查询参数转成开机设置（`start_settings`：配置、地址与表单） |

库里的新文件：

| 文件 | 内容 |
| --- | --- |
| `src/opfs_disk.js` | 浏览器磁盘的后端 `OpfsDisk`，进 Closure 的核心文件列表 |
| `tools/disk-service.mjs` | 加 `create`、`list`、`--allow-create`、`--max-size` |

页面文件：

| 页面 | 内容 |
| --- | --- |
| `index.html` | 新页面，加载 `build/v86_app.js`；import map 把 `v86` 指向 `build/libv86.mjs` |
| `legacy.html` | 现在的 `index.html`，加载 `build/v86_all.js`；U7 删除 |
| `app_debug.html` | 开发用：直接加载 `src/app/main.js` 的源码，`v86` 指向 `build/libv86-debug.mjs` |
| `debug.html` | 不变，仍是带调试器的旧页面 |

## 兼容

- **旧网址照旧可用。** `index.html?profile=<id>` 与上面列出的全部查询参数在新页面直接打开
  控制台，配置不进库。控制台工具栏有“加入虚拟机库”。新页面没有系统列表，`?profile=` 是
  打开这 137 个配置的唯一入口。
- **网址同步。** 现在开机后，`push_state` 把实际设置写回网址（`main.js` 4145 行），以便复制
  分享。新控制台对 `?profile=` 与查询参数启动的会话照做；从库启动的会话网址只有 `?vm=<id>`。
- **站点链接。** 部署到 Cloudflare Pages 的站点若链接 `index.html?profile=…`，行为不变。
- **旧页面。** `legacy.html` 在页脚有链接，过渡期内功能不变，并参与回归测试。U7 完成后
  删除 `legacy.html` 与 `build/v86_all.js` 目标；`debug.html` 的调试器另行安排（见 U7）。

## 实施阶段

| 阶段 | 工作内容 | 验收 |
| --- | --- | --- |
| U0 | 从 `main.js` 提取 `profiles.js`、`vm_options.js`、`query_compat.js`；导出 `machine_options.js` 的规则表或加 `allowed_options`；旧页面改用这些模块，行为不变 | 提取前先录基线：给 `start_emulation` 加一个测试钩子，在构造 `V86` 之前记下选项并停止；在无头 Chrome 中对 137 个配置和一组查询参数各录一次。提取后，Node 直接导入这些模块（ES 模块用法）生成选项，与基线逐项相同；旧页面的编译包（Closure 用法）再录一次，也相同。lint、Closure 构建、现有测试通过 |
| U1 | `vm_config.js`（格式 v1、默认值、迁移、校验）与 `vm_store.js` | Node 测试覆盖纯函数：默认值、迁移、每条校验规则、`config_to_options`；无头 Chrome 中做保存、重新加载、导出、导入的往返，配置逐字段相同 |
| U2 | 开发依赖与 `make app`、`make app-check`（G3，下载前请负责人确认）；`build/v86_app.js`、新 `index.html`、`legacy.html`、`app_debug.html`；路由；库的列表、新建（默认配置）、导入、改名、删除；控制台能从配置开机；`v86.d.ts` 补上未声明的方法，新增光驱状态的公开方法（G1） | `make app-check` 无错；无头 Chrome：`?profile=` 打开的会话与旧页面的 `V86` 选项相同（比较两页记录的选项）；从库开机 FreeDOS（`images/freedos722.img`）到提示符 |
| U3 | 向导、[客户机预设](#客户机预设)（含验证状态、安装方式、安装后的清单）、设置对话框及全部硬件面板；规则驱动的禁用与说明；保存前完整校验；磁盘服务的 `create`、`list` 与管理器的探测、首选项 | 每个预设生成的配置都通过 `check_machine_options`，仓库中有镜像的预设从向导启动到提示符；对话框中不能组合出被拒的配置（遍历机器、CPU、显卡、网卡的组合）；校验错误显示在对应面板。磁盘服务：`create` 的每条规则（未开 `--allow-create`、名字、已存在、大小、空间、令牌、来源）各有测试；新建的镜像在 Linux 客户机中格式化、写入、`sync` 后，直接读服务目录里的文件核对 |
| U4 | 控制台：工具栏、菜单、状态栏、抽屉，覆盖[功能对照](#功能对照)中的全部运行时功能；磁盘错误对话框；`read_write` 盘的关闭提示 | 对照表逐项在无头 Chrome 中验证；`read_write` 盘经磁盘服务写回（复用 [`tests/persistence/browser_runner.mjs`](../tests/persistence/browser_runner.mjs) 的服务与核对方法） |
| U5 | 挂起与恢复（OPFS 状态文件）、文件句柄、空间检查与 `persist()`；同一虚拟机的单标签页锁 | 无头 Chrome：挂起，关闭页面，重新打开后恢复，客户机继续运行；第二个标签页开同一台虚拟机被拒；配置改过后恢复前提示 |
| U6 | 浏览器磁盘：`OpfsDisk` 后端与启动校验；新建、导入（网址、本地文件）、导出、删除；身份与 generation；空间检查与 `persist()` | 无头 Chrome 中：Linux 客户机（`images/buildroot-bzimage68.bin`）在新建的浏览器磁盘上格式化、写文件、`sync`，关机，关闭页面，重新打开后开机，文件仍在；不 `sync` 只等定时 flush 也在；导入后 SHA-256 与源相同，导出的文件与盘内容相同；第二个标签页打开同一块盘时给出“正被使用”；挂起后盘被另一会话改过，恢复被拒；注入 `QuotaExceededError` 时虚拟机暂停并提示；`cpu_worker=0` 与 Node 中启动报错 |
| U7 | 收尾：功能对照逐项完成；文档（`Readme.md` 与 `docs/`）；删除 `legacy.html` 与 `build/v86_all.js` 目标；`debug.html` 改为加载新页面并保留调试器（`cpu_worker=0`），或保留为只含调试器的页面 | 对照表全部打勾；`make all`、`make app`、`make app-check` 与本地门禁通过；删除后旧页面的测试改指新页面 |

测试用无头 Chrome（照 `tests/persistence/browser_runner.mjs` 新建 `tests/app/browser_runner.mjs`），
不在 Claude 应用的内置浏览器里跑重会话。GitHub CI 不改，用本地 make 门禁。

## 功能对照

旧页面的每项功能在新页面的位置。U7 时逐项打勾。

| 旧页面 | 新页面 |
| --- | --- |
| 系统按钮与过滤 | 不保留（负责人决定）；`?profile=` 链接照旧 |
| 光盘、软盘、硬盘镜像（文件、空盘、网址、读写选项） | 向导与设置对话框的 CD/DVD、软盘、硬盘面板 |
| multiboot、bzImage、initrd | “直接启动”面板 |
| BIOS、VGA BIOS、启动顺序、ACPI | “机器与固件”面板 |
| 内存、核数、并行、`cpu_type`、`machine_type` | 内存、处理器、“机器与固件”面板 |
| 显卡、显存、图形代理 | “显示”面板 |
| 网络后端、relay 地址、网卡型号、MTU | “网络适配器”面板 |
| 调制解调器 | “串口与并口”面板 |
| 静音 | “声卡”面板（声卡选“无”），控制台的静音按钮 |
| 运行/暂停、重置、退出 | 电源菜单 |
| Ctrl+Alt+Del、Alt+Tab | 发送按键菜单 |
| 取回各盘镜像、更换光盘与软盘 | 可移动设备菜单 |
| 保存状态、载入状态、保存并关机 | 电源菜单（挂起、保存并关机），工具菜单（保存或载入状态文件） |
| 性能记录与导出、内存转储、抓包 | 工具菜单 |
| 鼠标开关与锁定、全屏、截图、剧院模式、适应窗口、缩放 | 视图与输入菜单 |
| 信息面板 | 状态栏与“详细信息”抽屉 |
| 文件系统收发面板 | “共享文件夹”抽屉 |
| 串口终端 | “串口终端”抽屉 |
| 磁盘错误对话框 | 不变 |
| 查询参数与 `?profile=` | 不变（`query_compat.js`） |

## 不在本计划内

- 一个标签页同时运行多台虚拟机。
- 快照树（VMware 的快照管理器），本计划只做一份挂起状态。
- 云端同步虚拟机库。
- USB 设备。

## 已决定

以下几项于 2026 年 10 月 18 日由负责人确定：

1. **构建方式。** 写成 ES 模块，放在 Closure 构建之外，只用 `libv86.mjs` 的公开接口；类型检查
   用 tsc 对照 `v86.d.ts`，发布时用 esbuild 打包。见[构建方式](#构建方式closure-之外的-es-模块)。
2. **持久磁盘写进本计划。** 浏览器磁盘（OPFS，U6）与磁盘服务的创建、列出（U3）。
3. **旧页面在新页面全部做完后删除。** U7 时删除 `legacy.html`。
4. **不保留示例系统列表。** 新页面没有系统按钮；`?profile=` 链接照旧可用。
5. **浏览器磁盘用 `read_only` 与 `read_write`。** 浏览器磁盘是一份完整的镜像，不是修改层，
   `disk_option` 的两个取值照常适用，不另起选项名。磁盘计划的决定 7 只指修改层，已在那里加注。
   见[与磁盘计划的关系](#与磁盘计划的关系)。

## 附录：实施记录

实施在 `ui` 分支（自 master 1a978143）。测试入口：`make app-tests`（含 U0 的 `make app-shared-tests`）。

### U0 共用模块（2026-10-21）

**实现。**

- 基线（95836504，提取之前）：`start_emulation` 在构造 `V86` 之前查 `window.v86_record_options`，有就把
  选项交给它并返回。[`tests/app/legacy_options.mjs`](../tests/app/legacy_options.mjs) 起一个静态服务，在
  页面最前面插入记录脚本，在一个无头 Chrome 里用 iframe 依次打开：137 个 `?profile=`、37 组查询参数
  （[`tests/app/legacy_cases.mjs`](../tests/app/legacy_cases.mjs)：自定义镜像、`m`、`cores`、`cpu_type`、
  `machine_type`、Q35 设备、显存与显卡、多显示器、网卡、relay、调制解调器、`disk_option`、内核、CPU 策略、
  `cdn` 等，以及带配置的组合）和 17 种表单启动（在表单里填值后点开机），`index.html` 与 `debug.html`
  各一遍，共 382 例。记下选项（函数、元素、ArrayBuffer、`undefined` 有标记）、`alert` 的文字、开机后的
  地址（`push_state`）、标题、表单回写的字段。`index.html` 是 ADVANCED 编译的 `v86_all.js`，属性名被
  Closure 改过：构建现在同时写出改名表（`--property_renaming_report build/v86_all.js.properties`），
  记录时按它还原。
- 提取（[`src/browser/`](../src/browser/)）：
  - [`profiles.js`](../src/browser/profiles.js)：`get_profiles(host, on_localhost)` 返回 137 个配置（调试页
    另加的 kvm-unit-tests 仍在 `main.js`，它依赖 `DEBUG`）；用户镜像服务器的 `user_profile_base`、`user_profile`。
  - [`vm_options.js`](../src/browser/vm_options.js)：默认值与上限常量；`clamp_*`、`set_memory_size`；
    `DEFAULT_FORM`（`index.html` 未改动时的表单）；`profile_settings`；`apply_form`（表单叠加到配置与地址的
    设置上，并做旧页面的全部规整：内存拆分、x86_64 自动选择、arm64 与 virt、Q35 设备、ACPI、固件、网卡、
    MTU、调制解调器；返回错误文字、标题和要回写的表单字段，不碰 DOM）；`settings_to_options`（`V86` 选项，
    页面的部分经参数传入：CPU Worker、调试构建、`?version`、图形代理、屏幕元素）。
  - [`query_compat.js`](../src/browser/query_compat.js)：`bool_arg` 等参数读取；`image_host`；
    `apply_query_args`；`start_settings`（配置、地址、表单合成一次开机的设置，即旧 `start_emulation` 的
    前半段）；`format_query_args`。
  - `main.js` 只剩 DOM：`read_form` 读表单，`start_emulation` 调 `start_settings` 与 `settings_to_options`，
    处理标题、说明链接、`alert`、表单回写和 `push_state`。三个模块在 `Makefile` 的 `PAGE_FILES` 里，只进
    `v86_all.js` 与 `v86_all_debug.js`。
- 规则表（[`src/machine_options.js`](../src/machine_options.js)）：导出 `PC_ONLY`、`VIRT_ONLY`、
  `VIRT_GRAPHICS_ADAPTERS`，新增 `GRAPHICS_ADAPTERS`（`graphics_adapter.js` 改用它）、`NET_DEVICE_TYPES`、
  `VIRT_NET_DEVICE_TYPES`、`Q35_ONLY`；`MAX_VRAM_SIZE`、`Q35_ROOT_PORTS_MAX`、`MAX_CORES` 从
  `graphics_adapter.js`、`platform.js` 移来（原处转出）。`allowed_options(cpu_type, machine_type)` 返回可选的
  机型、显卡、网卡、核数上限、ACPI 要求（`required`：Q35；`with_cores`：多核时需要；`none`：virt），以及不适用的
  选项各自的原因。

**决定与偏差。**

1. **共用的是“设置”，不是配置格式。** 计划说查询参数转成配置（`query_compat.js`），新旧页面共用
   `config_to_options`。配置格式要到 U1 才定，而 137 个配置带着配置格式没有的字段（`state`、`filesystem`、
   `bzimage_initrd_from_filesystem`、`mac_address_translation`、`cpuid_level` 等）。所以 U0 共用的是旧页面
   内部本来就有的中间“设置”：`start_settings` 从配置、地址、表单得到设置，`settings_to_options` 从设置得到
   选项。U1 的 `config_to_options` 把配置转成设置，再走同一个 `apply_form(DEFAULT_FORM)` 与
   `settings_to_options`，规整规则仍只有一份。新页面打开 `?profile=` 时调用同一个 `start_settings`（表单用
   `DEFAULT_FORM`），选项因此与旧页面相同。
2. **表单是数据。** 从地址启动时旧页面也读表单（全为默认值），所以新页面需要这份默认值：`DEFAULT_FORM`。
   `index.html` 的表单默认值与它一致由 Node 测试间接核对（同一组记录）。`debug.html` 的表单少几个字段（没有
   镜像网址栏），下拉框也少选项（`cpu_type` 没有 arm64、`machine_type` 没有 virt），设置不存在的选项时下拉框的
   值为空；记录如实保留，Node 测试按两页各自的选项模拟。
3. **Closure 改名的陷阱在基线里出现了一次。** 表单里按盘名（`"hda"`）下标读取的 `urls`、`disk_options`
   必须加引号，否则 `v86_all.js` 里读不到，读写选项在 `index.html` 中失效（与磁盘计划 D3 偏差 3 同类）；
   对比时 `index.html` 的三种表单启动报出差异，加引号后消失。回写表单的字段（`updates`）按元素 id 读取，同样加
   引号。
4. **配置数是 137。** 计划初稿写 138，已改正。

**测试结果。**

| 测试 | 结果 |
| --- | --- |
| `tests/app/legacy_options.mjs check=<基线>` | 提取后两页 382 例与提取前的基线逐项相同（含改名还原后的 `index.html`）；同一基线连录两次也相同 |
| `tests/app/shared_options.mjs`（新） | Node 直接导入三个模块，按 `main.js` 的路由与两页的表单生成 382 例：选项、`alert`、地址、标题、回写字段与页面记录逐项相同 |
| `tests/app/machine_rules.mjs`（新） | `allowed_options` 与 `check_machine_options`、PC 平台自身的检查一致：每种 CPU、机型、显卡、网卡的组合，标为不适用的选项都被拒绝、其余都被接受，Q35 设备、ACPI 与核数上限，virt 与 PC 的核数上限相同。232 项 |
| 回归 | eslint 无输出；Closure（`libv86.js`、`libv86.mjs`、`libv86-debug.mjs`、`cpu-worker.js`、`v86_all.js`、`v86_all_debug.js`）0 错误；`tests/api/arm64-options.js`、`tests/devices/graphics_adapter.js`、`tests/api/disk-options.js`、`tests/api/state.js` 通过；`tests/persistence/browser_runner.mjs part=page`（页面与 CPU Worker：`debug.html` 与 `index.html` 以查询参数启动 MS-DOS、写回磁盘服务、出错重试、保存并关机）通过 |

### U1 配置格式与虚拟机库（2026-10-21）

**实现。**

- [`src/app/vm_config.js`](../src/app/vm_config.js)（`// @ts-check`，U2 起由 tsc 检查）：
  - 格式 `v86-vm` 第 1 版，字段按[配置格式](#虚拟机配置格式)一节，另加旧页面配置需要的几项：`machine.bootmenu`、
    `cdrom.disk_error`、软盘的 `disk_option`、`kernel.from_filesystem`（`bzimage_initrd_from_filesystem`）、
    网卡的 `mac_address_translation`、`initial_state`（从状态启动）、`advanced` 的 `ir_tier0`、`x87_fast_math`、
    `x87_jit_cache`、`cpuid_level`、`mouse_disabled`。镜像来源四种（`url` 另可带 `async`、`fixed_chunk_size`、
    `use_parts`；`file` 的 `handle` 是句柄表里的 id，配置本身仍是 JSON）。
  - `new_config`、`with_defaults`（缺的字段补默认值，默认值即旧页面未改动的表单）、`migrate`（格式名、版本号的
    检查，按版本逐步迁移，现在只有第 1 版；比本版本新的拒绝）。
  - `validate_config`：每个字段的取值与 `allowed_options` 的组合规则，问题按字段路径给出（如 `disks.0.disk_option`），
    供 U3 的对话框显示在对应面板；`check_config` 再跑库自己的 `check_machine_options` 与 `check_disk_options`。
  - `config_to_options`：配置的字段按“配置的设置”和“地址的设置”放进设置，表单按配置填好，再经旧页面的
    `apply_form` 与 `settings_to_options`，规整规则只有一份；有 `initial_state` 时与旧页面一样把机器交给状态。
  - `profile_to_config`：旧页面的配置转成库里的配置（U4 的“加入虚拟机库”）。
- [`src/app/vm_store.js`](../src/app/vm_store.js)：IndexedDB `v86-vm-manager`（`vms` 以 `id` 为键，`handles` 存
  `FileSystemFileHandle`）；`VMStore` 的 `list`、`get`、`put`（先校验，记修改时间）、`delete`（连同它的句柄）、
  `put_handle`、`get_handle`；`export_config`（`.v86vm.json` 的文本，句柄不导出）、`export_file_name`、
  `import_config`（迁移、校验；没有 id 或与库中已有的重复时给新 id）、`files_to_choose`（没有句柄、需要重新
  选取的本地文件）。
- [`tests/app/browser_runner.mjs`](../tests/app/browser_runner.mjs)：新页面测试共用的无头 Chrome 运行器（静态服务、
  不缓存，页面在 `#result` 写 PASS/FAIL）。

**决定与偏差。**

1. **`config_to_options` 在 `src/app/vm_config.js`，不在 `vm_options.js`。** 计划把它列在共用的 `vm_options.js` 里。
   但旧页面不读配置，而 `vm_options.js` 在 Closure 构建里：配置的字段名在 Closure 程序中从未定义，
   `missingProperties` 报错（未知类型也一样），只能处处加引号。放到新页面一侧后，它只导入共用的
   `apply_form`、`settings_to_options` 与常量，规则仍只有一份。
2. **`display.vram_mb` 可以是 `null`**：只用于带 `initial_state` 的配置，表示显存由状态决定。旧页面 12 个带状态的
   配置里 11 个不给 `vram_size`，交给状态；若配置写成默认的 8 MB，就与旧页面的选项不同。
3. **与旧页面比较的口径**：配置转换得到的选项与旧页面 `?profile=<id>` 的选项按“行为”比较：`undefined` 与 `false`
   视为相同（旧页面的两条启动路径自己就不一致，例如地址启动时 `disable_jit: false`、按钮启动时没有这一项），
   但默认为真的 `cpu_worker`、`ir_tier0`、`x87_fast_math`、`x87_jit_cache`、`autostart` 严格比较；ArrayBuffer 比大小。
4. **版本 1 的网卡只有一张**（`network` 是数组，为以后的多网卡留位置）；Android 预设要三张，在 U3 做预设时扩展。

**测试结果。**

| 测试 | 结果 |
| --- | --- |
| `tests/app/vm_config.mjs`（新） | 默认配置有效，选项与旧页面不改表单直接开机相同；137 个配置各转成配置后有效，选项与旧页面 `?profile=<id>` 相同；JSON 往返不变；`migrate` 拒绝非配置、错误与更新的版本，补齐缺的字段；85 条校验规则各报在自己的字段上，一个问题不掩盖其他问题；`config_to_options` 的各字段（Q35 设备、启动顺序、fastboot、bootmenu、Bochs BIOS、x86_64 与扩展内存、读写盘、本地文件、浏览器磁盘、空软盘、内核、virtio-gpu 多显示器、fetch 与 CORS 代理、MAC 地址转换、调制解调器、9p、高级项）；各网络后端、arm64（virtio 盘、输入设备、页级编译、内存拆分）、未选取的文件报错；`check_config` 报出库自己的检查（分片镜像不能读写）。11 项 |
| `tests/app/store_test.html`（无头 Chrome，新） | 存 26 个配置与一个文件句柄（OPFS 中的文件，句柄与选取的文件同类）；无名配置被拒；重新加载页面后列表与逐个读取逐字段相同，句柄可读出文件的 4 个字节；26 个各自导出再导入：字段相同、id 为新、本地文件需要重新选取；非 JSON 与 99 核的导入被拒；导入另一个库保留 id，再次重新加载后相同；删除配置连同其句柄，重新加载后仍删除 |
| 回归 | `make app-shared-tests` 通过；`v86_all.js` 0 错误；eslint 无输出 |

### U2 工具链、新页面、库与控制台（2026-10-21）

**实现。**

- 工具链（G3，负责人同意下载）：`package.json` 的 `devDependencies` 为 `typescript` 6.0.3 与 `esbuild` 0.28.2
  （精确版本），提交 `package-lock.json`。`make app`：esbuild 把 `src/app/main.js` 打成 `build/v86_app.js`（ES 模块、
  压缩、source map，`v86` 为外部依赖，约 63 KB，大半是 137 个配置）；`make app-check`：`tsc -p tsconfig.json`。
  `node_modules/.bin/esbuild`、`tsc` 缺失时 Makefile 先 `npm ci`。`tsconfig.json` 只含 `src/app/`，`paths` 把
  `v86` 指到 `v86.d.ts`。
- 页面：原 `index.html` 改名为 `legacy.html`（内容不变）；新 `index.html` 的 import map 把 `v86` 指到
  `build/libv86.mjs`，加载 `build/v86_app.js` 与 `src/app/app.css`；`app_debug.html`（`<html data-debug>`）直接加载
  `src/app/main.js` 的源码，`v86` 指到 `build/libv86-debug.mjs`，固件与 Wasm 用调试版，与旧调试页相同。页脚链接
  旧页面。`make update_version` 同时更新两个页面（新页面三个文件的 `?版本`）。旧页面的测试（磁盘计划的
  `part=page`、glbridge 的 `cpu_worker_ui`、`performance_recorder_ui`、`tests/app/legacy_options.mjs`）改指 `legacy.html`。
- `src/app/main.js` 路由：`?vm=<id>` 为库里虚拟机的控制台；`?profile=<id>`（及旧页面的其他查询参数）为直接
  打开的控制台，规则与旧页面的 `onload` 相同（已知配置、用户镜像服务器、带镜像的 `custom`）；其余为库。
- [`src/app/ui/library.js`](../src/app/ui/library.js)：左栏虚拟机列表与“新建”“导入…”，右栏摘要（硬件表、备注）
  与“开机”（新标签页打开 `?vm=<id>`）、“改名…”、“导出”、“删除…”。新建为默认配置（向导在 U3）；“编辑设置”
  在 U3 之前禁用。空库时说明库在浏览器存储里、清除站点数据会删掉它。
- [`src/app/ui/console.js`](../src/app/ui/console.js)：屏幕（与旧页面相同的 `screen_container` 结构）、状态行，
  工具栏只有“库”“关机”（确认后 `destroy()`）“重置”（从状态启动时禁用）“Ctrl+Alt+Del”（菜单、状态栏、抽屉在 U4）。
  库里的虚拟机：本地文件经保存的句柄读取，没有读取权限时在页面上给出按钮，点击后请求；没有句柄（导入的、
  或浏览器不保存句柄）时请用户重新选取，核对大小（不同则拒绝）与名字、修改时间（不同则确认）。地址启动的
  会话沿用旧页面的细节：标题、几个配置开机后自动按键、`c`、`s` 参数、virtio-gpu 随窗口改分辨率、图形代理。
- [`src/app/emulator_bridge.js`](../src/app/emulator_bridge.js)：唯一 `import { V86 } from "v86"` 的模块；页面的
  选项部分（调试构建、`?版本`、图形代理、屏幕）、图形代理的加载、测试钩子 `window.v86_record_options`。
  [`src/app/ui/dom.js`](../src/app/ui/dom.js)：`h()`、模态对话框（`<dialog>`）、下载、选文件、大小格式。
  [`src/app/app.css`](../src/app/app.css)：深色，窄屏单栏。
- 公开接口（G1）：新增 `get_cdrom_state()`（`{present, inserted}`，页面与 CPU Worker）；`v86.d.ts` 补上
  `get_cdrom_state`、`get_disk_fda`、`get_disk_fdb`、`get_diagnostics`，以及 tsc 报出的 `emulator-error` 事件
  （旧页面一直在用，类型声明里没有）。

**决定与偏差。**

1. **TypeScript 用 6.0.3**（负责人选定）：最后一个 JS 实现的版本，对共用模块里 Closure 写法的 JSDoc 推断最成熟；
   7.0 是 Go 重写版。`strict` 未打开：先保证公开接口的名字与参数类型，严格空值检查以后再开。
2. **`get_cdrom_state` 的语义**：i440FX 总有一个 IDE 光驱，没有给 `cdrom` 时 `present: true, inserted: false`；
   virt 机器的光盘镜像是 virtio 盘，`present: false`。
3. **测试读屏幕要经模拟器**：显示解耦之后文本模式也画在画布上，`#screen` 里没有文字；测试用公开的
   `wait_until_vga_screen_contains`。
4. **`?profile=custom` 不带镜像时打开库**（旧页面此时显示表单，新页面没有表单）。调试页的 kvm-unit-tests 配置
   （旧 `debug.html` 独有）不进新页面。
5. **`performance_recorder_ui_browser_test` 的一项失败与本计划无关**：“URL cache policy reaches native regions and
   exported cache counters”在 master（1a978143，旧页面原样）上同样失败（两次），其余检查通过。

**测试结果。**

| 测试 | 结果 |
| --- | --- |
| `make app-check` | tsc 无错（初次运行报出 `emulator-error` 未声明、两处类型推断，已改） |
| `tests/app/legacy_options.mjs same=index.html:legacy.html` | 新页面对 137 个 `?profile=` 与 37 组查询参数，共 174 个地址，给 `V86` 的选项与旧页面逐项相同 |
| `tests/app/app_test.html`（无头 Chrome，新） | 在框架里打开新页面：空库；新建两台（名字不重复）；改名（对话框）；导出（文件名与内容）；导入 FreeDOS 的 `.v86vm.json`（软盘为 `images/freedos722.img`）；开机打开 `?vm=<id>` 的控制台，标题为虚拟机名，FreeDOS 启动到 “Welcome to FreeDOS”；`get_cdrom_state` 为空光驱；关机（确认）；删除（确认）；重新加载后库不变。`index.html`、`app_debug.html`、CPU 在页面中（`cpu_worker: false`）三种都通过 |
| `tests/api/cdrom-insert-eject.js`（补充） | `get_cdrom_state`：空光驱、放入光盘、`eject_cdrom` 之后；源码与发布构建都通过 |
| 回归 | `make app-shared-tests`（两页改名后重录）、`tests/app/vm_config.mjs`、`store_test.html` 通过；`tests/persistence/browser_runner.mjs part=page`（`legacy.html`，页面与 CPU Worker）、`cpu_worker_ui_browser_test` 通过；Closure（`libv86.js`、`libv86.mjs`、`libv86-debug.mjs`、`cpu-worker.js`、`v86_all.js`）0 错误；eslint 无输出 |

### U3 向导、客户机预设、设置对话框、磁盘服务的创建与列出（2026-10-21）

**实现。**

- 磁盘服务（b23b5b2d）：[`tools/disk-service.mjs`](../tools/disk-service.mjs) 新增 `list`（发往服务根网址：名字、大小、修改
  时间、是否有写者，并告知能否创建与上限）与 `create`（发往新镜像的网址，`X-V86-Disk-Size`）。`create` 只在
  `--allow-create` 时接受（`make run` 的服务带上它）；名字须为目录内的 `.img` 文件名（字母或数字开头，不超过 128 个字符）；
  大小为 512 的正整数倍，不超过 `--max-size`（默认 64 GiB）与卷的剩余空间；以 `wx` 创建，不覆盖已有文件；`ftruncate`
  （稀疏）、`fsync` 文件与目录后登记身份（新 UUID、generation 1）；令牌与来源核对同其他操作；没有删除操作。
  [`src/app/disk_service_client.js`](../src/app/disk_service_client.js)：`list_images`、`create_image`、`probe`、`new_image_name`。
  虚拟机库的数据库升到第 2 版，新增 `prefs` 表（磁盘服务的地址与令牌）。
- 预设与规则（b84b9200）：[`src/app/guest_presets.js`](../src/app/guest_presets.js) 的 15 个预设按计划的表格（Windows 95、98、ME
  分开，另加“其他”），各带硬件、依据、安装方式、安装后的步骤与已知问题。[`src/app/vm_model.js`](../src/app/vm_model.js)：
  `choices()`（每个控件可取的值，来自 `allowed_options`）与 `change()`（一处改动及其连带的改动，逐条说明：CPU 决定机型，
  Q35 与多核打开 ACPI，超过 2048 MB 改用 x86_64，换到 virt 时去掉它没有的软驱、PC 固件、调制解调器、Sound Blaster、
  CPUID 级别，换网络后端时给出该后端的默认网址）。配置格式（仍为第 1 版，新字段有默认值）增加 virt 机器的设备
  （`virt`：virtio 传输方式、输入设备、console 端口数、vsock、virtio-gpu 的 PCI 槽）、`sound.device: "virtio"`
  与 virt 上最多四张 virtio 网卡（只有一张接后端，`net_device` 的 `count`、`id`），Android 预设由此可以表达。
- 界面：
  - [`src/app/ui/wizard.js`](../src/app/ui/wizard.js)：五步——来源（光盘、软盘、已安装的硬盘镜像、内核与 initrd 加系统光盘、稍后安装）、
    系统（预设列表，未验证的带标记，显示依据、安装方式、硬件、安装后步骤、已知问题；来源与预设的常用安装方式不符时提示）、
    名称与备注、硬盘（新建空盘：大小与存放位置——磁盘服务、内存，浏览器磁盘在 U6 之前禁用；或不要硬盘）、摘要（“完成”或
    “自定义硬件…”打开设置对话框）。磁盘服务上的新镜像在“完成”时才创建。
  - [`src/app/ui/settings.js`](../src/app/ui/settings.js) 与 [`ui/panels/`](../src/app/ui/panels/)：左侧硬件列表（常规、内存、处理器、
    机器与固件、硬盘、CD/DVD、软驱、网络适配器、声卡、显示、串口、共享文件夹、直接启动、virt 设备、高级），“添加…”与“移除”；
    右侧面板只提供允许的取值，固定的项禁用并写明原因（例如 virt 的 ACPI、多核时的 ACPI、非 Q35 的 HPET）；底部显示上一处
    改动的连带改动。保存前运行 `check_config`，问题标在对应项上并显示在其面板中。
  - [`src/app/ui/image_picker.js`](../src/app/ui/image_picker.js)：网址、本机文件（Chromium 经 `showOpenFilePicker` 保存句柄，
    其他浏览器开机时重新选取）、内存中的空盘或空软盘、磁盘服务的镜像（列出，或“新建镜像…”）、浏览器磁盘（U6）。
  - 库：“新建虚拟机…”为向导，“编辑设置…”为设置对话框，“首选项…”配置磁盘服务（地址、令牌、“测试”、“不使用”）；
    侧栏显示当前的磁盘服务；页面来自本机（localhost、127.0.0.1、[::1]）且未设置时探测 `http://127.0.0.1:8471/`。摘要页显示
    预设的安装后清单与已知问题，未验证的预设标出。
- `make run` 的 `tools/dev-server.py` 回答 Range 请求（206、416）：向导里网址来源的镜像按块读取（`async`），原来的
  Python 服务器不支持，与真实的网站服务器不同。测试的静态服务（`tests/app/browser_runner.mjs`）同样支持，并可用
  `service=1` 起一个可创建镜像的磁盘服务。

**决定与偏差。**

1. **规则用“改动并说明”，不只禁用。** 计划说对话框“禁用不适用的项并说明原因”。取值类的控件只列允许的值；
   而一处改动使别处失效时（例如换成 arm64），连带的项随之改成允许的值并在底部说明，而不是留下一个不能保存的配置。
   被去掉的项（软驱、PC 固件等）也逐条列出。
2. **Android 预设的“代码预算 160 MiB”没有对应的选项**：页级编译没有公开的代码预算开关，预设不写它；其余设备
   与 `tests/a64/android_boot.mjs` 的选项一致（测试逐项核对）。
3. **旧版磁盘服务对 `list`、`create` 回答 404**（根网址与不存在的镜像本来就是 404），不是计划写的 400；客户端以
   缺少协议响应头判断“不是能列出和创建镜像的磁盘服务”。
4. **浏览器磁盘的选项在 U6 之前禁用**，向导与选择器里都显示为“以后的版本”。
5. **磁盘服务的镜像网址不能以 `/` 结尾**（新的校验规则）：选了“磁盘服务的镜像”却没选具体镜像时，配置不能保存。

**测试结果。**

| 测试 | 结果 |
| --- | --- |
| `tests/app/disk_service_create.mjs`（新） | 未开 `--allow-create` 时 `list` 正常、`create` 403；10 个不合格的名字 400、128 个字符的名字可以；7 种不合格的大小与超过 `--max-size` 400、超过剩余空间 507 且未留下文件；新镜像全零、身份为新 UUID 与 generation 1、在本卷上不占块（稀疏），再次创建与覆盖已有文件 409；`list` 的内容与写者标记、只在根网址；令牌 401、外来来源 403、预检放行 `X-V86-Disk-Size`；客户端的列出、创建、错误码、对磁盘服务、普通服务器与无人监听的探测、新镜像命名；Linux 4.16 客户机把新建的镜像（`read_write`）格式化为 ext2、写文件、`sync`，服务目录里的文件含该文本与 ext2 超级块。8 项 |
| `tests/app/presets.mjs`（新） | 15 个预设各自（带上默认位置的新盘）通过 `validate_config` 与库的检查，未验证的只有 Vista/7/10 与“其他”；各预设的硬件与计划的表格一致；Android 预设的选项与 Android 测试一致；`change()` 的连带改动与说明；CPU、机型、显卡、网卡、声卡、核数的全部组合（312 种）与 5000 次随机改动之后的配置都被库接受（随机测试找到并修正了一处：改用 fetch 时沿用了 relay 的网址） |
| `tests/app/vm_config.mjs`（补充） | 校验规则增加到 95 条：virtio 声卡与 virt 设备在 PC 上、传输方式、输入设备、console 端口、vsock、没有 pci 的 GPU 槽、五张网卡、两张接后端的网卡、目录网址 |
| `tests/app/wizard_test.html`（无头 Chrome，新） | `freedos`：DOS 预设、软盘网址、不要硬盘，开机到 “Welcome to FreeDOS”；`linux`：32 位 Linux 预设、光盘网址、内存中 64 MB 新盘，开机到 shell 的 “~%”；`arm64`：arm64 Linux 预设、直接启动（Alpine 的内核、initrd 与 ISO，`build/a64-linux/`），串口出现 “localhost login:”；`dialog`：换成 arm64 时机型变为 virt 并在底部说明、显卡只剩 none 与 virtio-gpu、ACPI 禁用并写明原因，换回 x86 加第二核后 ACPI 打开且固定，网址为空时保存被拒、问题标在硬盘项并显示在其面板、改好后消失，添加并移除软驱、添加第二块硬盘，保存后库里的摘要更新，取消不改配置；`service`：首选项里填入并测试磁盘服务，向导的新盘建在服务目录（16 MB，`kept-disk.img`），配置为读写 |
| 回归 | `tests/app/app_test.html`（新建改走向导）在 `index.html` 通过；`store_test.html`（增加首选项与数据库第 1 版到第 2 版的升级）通过；`tests/persistence/disk_service.mjs` 与 `service_machine.mjs` 通过；`make app-check` 无错；eslint 无输出 |

### U4 控制台（2026-10-21）

**实现。**

- [`src/app/ui/console.js`](../src/app/ui/console.js) 的运行部分：
  - 工具栏的菜单（[`dom.js`](../src/app/ui/dom.js) 的 `menu_button`：每次打开时按机器的状态生成，方向键移动，Esc 与点外面关闭）：
    电源（暂停/运行、重置（从状态启动时禁用）、关机…（确认）、有写回盘时“保存并关机”、把状态存为文件、从文件载入状态）；
    按键（Ctrl+Alt+Del、Alt+Tab、Alt+F4、Ctrl+Esc、Win、Win+R、Ctrl+Alt+F1/F2/Backspace、PrintScreen 与“其他按键…”，
    由 [`src/app/keys.js`](../src/app/keys.js) 转成扫描码，按下后 100 ms 松开，与旧页面的 Alt+Tab 相同；Del 用小键盘的码，与旧页面的
    Ctrl+Alt+Del 相同）；设备（光驱放入镜像或一组文件（文件组成 ISO 9660）、弹出，软驱 A/B 放入、弹出，各盘镜像的下载）；
    视图（全屏、适应窗口、50%–300% 缩放、剧院模式、截图存为 PNG）；输入（鼠标开关、锁定鼠标）；静音按钮（没有扬声器时不显示）；
    工具（性能记录的开始与停止、报告导出，内存转储，抓包（Wireshark 的十六进制导入格式，与旧页面相同））。
  - 状态栏：运行状态、运行时间、当前与平均速度、磁盘与网络的读写量、文本或图形模式与分辨率、鼠标。
  - 抽屉：串口终端（xterm.js）、共享文件夹（送入文件、按路径取回；配置了 9p 或客户机挂载后出现）、详细信息（机器、内存、时间、
    速度、指令数、存储、网络、共享文件夹、显示、鼠标、多核的运行方式）。
  - 磁盘错误对话框（`disk_error: "stop"`：重试或继续、关机；`report`：说明客户机已被告知）。
  - 离开页面：有写回盘、或按着 Ctrl（Ctrl+W 到不了客户机）时浏览器先询问；关机后不再询问。点击屏幕时锁定鼠标（客户机用相对鼠标时）
    并把输入焦点交给手机键盘的文本框，与旧页面相同。
- 公开接口（G1）新增四个方法，替代旧页面对内部对象的访问：`set_cdrom_files(files)`（文件做成光盘）、
  `create_performance_recorder(options)`（页面与 CPU Worker 的记录器）、`capture_network_traffic(listener)`（收发两个方向，返回停止函数）、
  `set_speaker_volume(volume)`；`v86.d.ts` 一并声明。

**决定与偏差。**

1. **公开接口代替内部访问**：旧页面的抓包用 `emulator_bus`、静音用 `speaker_adapter.mixer`、性能记录直接构造记录器、文件组成光盘用
   内部的 `iso9660`。新页面只用公开方法，库因此多了上面四个方法；磁盘镜像的下载用 `export_disk_image`（软盘用 `get_disk_fda/fdb`），
   内存转储用 `read_memory_chunks`。
2. **截图存为文件**：旧页面在新窗口打开截图，新页面下载 PNG（弹出窗口常被浏览器拦截）。
3. **音频解锁不需要页面代码**：库的扬声器在页面的第一次点击或按键时自己恢复 AudioContext。
4. **“挂起”在 U5**：电源菜单的挂起与恢复、单标签页锁随 U5 加入。
5. **测试里的输入**：MS-DOS 的键盘缓冲只有 16 个键，`keyboard_send_text` 不带延迟时会丢键；测试按 20 ms 一键输入并等输入结束。
   `wait_until_vga_screen_contains` 的字符串参数只匹配行首（库的既有语义）。

**测试结果。**

| 测试 | 结果 |
| --- | --- |
| `tests/app/console_test.html part=main`（无头 Chrome，新） | MS-DOS 6.22（库里的虚拟机，`images/msdos622.img`）到提示符；状态栏（运行、时间、速度、Text 80×25）；暂停与运行；Alt+Tab 的按下与 100 ms 后的松开、“其他按键” Ctrl+Alt+F1、Ctrl+Alt+Del 使 DOS 重启；文件组成的光盘（DOS 的 `dir D:` 列出 README.TXT）与弹出、软盘（`dir A:` 列出 COMMAND.COM）与弹出、hda 镜像下载（与源镜像同样大小）；200% 缩放、适应窗口、剧院模式与退出、截图（PNG）、全屏；鼠标关与开、锁定；静音与取消；性能记录 2.5 秒后停止并导出报告（有样本与元数据）、内存转储（128 MB）、抓包文件；串口终端（xterm）、共享文件夹送入与取回 hello.txt、详细信息（IDE、Text 80×25、1 core）；状态存为文件后在 DOS 里写一行，再载入状态，那一行消失、机器继续运行；关机（确认）。CPU 在 Worker 中与在页面中（`cpu_worker: false`）各一遍 |
| `tests/app/console_test.html part=disk`（无头 Chrome，运行器的磁盘服务） | hda 为磁盘服务上的 MS-DOS 镜像（`read_write`）：离开页面时浏览器先询问；写入落在服务的文件里；服务断开后再写：磁盘错误对话框（“the write … failed … retry once the disk can be reached again”），机器停止；服务恢复后点“Retry”，写入落盘；“保存并关机”下载状态，磁盘的会话关闭 |
| 回归 | `make app-check` 无错；Closure（`libv86.js`、`libv86.mjs`、`libv86-debug.mjs`、`cpu-worker.js`、`v86_all.js`）0 错误；eslint 无输出 |

### U5 挂起与恢复、单标签页锁（2026-10-21）

**实现。**

- [`src/app/vm_state.js`](../src/app/vm_state.js)：挂起状态存在 OPFS 的 `v86/states/<id>.bin`（V7 流，边生成边写入
  `createWritable`，写完才替换原文件）；`storage_space`（`navigator.storage.estimate()` 与 `persisted()`）、`state_estimate`（内存、
  扩展内存、显存再加 16 MiB）；`machine_digest`（配置去掉 id、名字、备注、预设、时间与挂起信息后的 SHA-256）；`hold_machine`、
  `running_machines`（`navigator.locks` 的排他锁 `v86-vm-<id>`）。
- 控制台：库里的虚拟机开机前取得它的锁，取不到时说明“在另一个标签页运行”并不启动，关机时释放（关闭标签页时浏览器释放）。电源菜单
  的“挂起”：先核对剩余空间（不足时说明需要多少、还有多少），第一次挂起时请求 `navigator.storage.persist()`（只请求一次，记在首选项），
  写入状态，配置记下大小、时间与摘要，然后关机；失败时删掉不完整的状态。开机时若有挂起状态：状态文件不见了（站点数据被清除）则说明
  后重新开机；配置的摘要与挂起时不同则询问“仍然恢复”“丢弃状态并开机”“取消”；否则直接恢复：机器加载但不启动，
  `restore_state_stream` 读入状态后运行，状态文件随即删除。恢复失败时给出“丢弃并开机”。
- 库：列表显示“已挂起”“在另一个标签页运行”（窗口重新获得焦点时刷新）；挂起的虚拟机摘要页显示挂起时间与大小，按钮为“恢复”，并有
  “丢弃挂起状态…”；删除虚拟机时一并删除其状态（运行中的不能删除）；侧栏显示浏览器存储的占用与是否持久。

**决定与偏差。**

1. **恢复之后删除状态文件**：恢复的机器随即运行，状态与磁盘（尤其写回盘）不再对应，状态只用一次（VMware 的挂起也是如此）。
2. **摘要不含名字、备注**：只改名字或备注不询问；其余设置任何改动都询问。
3. **状态的位置是 `v86/states/`**：计划写 `states/<id>.bin`，与 U6 的 `v86/disks/` 放在同一个目录下。
4. **本地文件的句柄**：U2 起控制台已在开机时检查读权限，没有时请用户点击授予（同一个 U5 条目）；测试用的 OPFS 句柄总是有权限，
   选取文件的权限对话框只能人工验证。

**测试结果。**

| 测试 | 结果 |
| --- | --- |
| `tests/app/suspend_test.html`（无头 Chrome，新） | MS-DOS 运行时，同一虚拟机的第二个标签页被拒（“runs in another tab”）、库显示“Running in another tab”；挂起：状态约 10 MB 在 `v86/states/`、配置记下大小与摘要、`persist()` 只请求一次；关闭标签页后库显示“Suspended”与“Resume”“Discard”；重新打开即恢复，屏幕与挂起前相同（BEFORE-SUSPEND），客户机继续运行（AFTER-RESUME），状态文件已删除；剩余空间不足（模拟 64 MB 配额）时说明原因、机器继续运行、不留状态；挂起后改了内存，再开时询问，选“丢弃”后重新启动、状态已删；只改名字与备注时不询问、直接恢复 |
| 回归 | `app_test.html`（关机改走电源菜单）三种通过；`console_test.html part=main` 通过；`make app-check` 无错；eslint 无输出 |

### U6 浏览器磁盘（2026-10-21）

**实现。**

- 库：[`src/opfs_disk.js`](../src/opfs_disk.js)（进 Closure 的核心文件列表）。`OpfsDisk` 照 `NodeFileDisk` 写，满足同一份后端契约，
  文件描述符换成 OPFS 的 `FileSystemSyncAccessHandle`：`read`/`write`/`flush`/`getSize` 同步完成，写入在文件里即完成，flush
  之后持久，定时 flush（空闲 1 秒、最长 5 秒），`stop()`、`destroy()`、拔出时 flush 并关闭。身份与 generation 记在
  `v86/disks/<id>.json`（UUID、generation、大小；管理器的标签、来源等字段原样保留）：打开时大小与记录不符则 generation 加一；
  **每个会话的第一次写入**与快照之后的第一次写入在写数据之前使 generation 加一并写回记录，所以快照之后任何会话改过这块盘，那份
  快照都不再相符。同步句柄排他：别的标签页（或本机另一块盘）已打开时报“正被另一个标签页使用”。`QuotaExceededError` 报成
  `no_space`、不可重试的写错误（按 `disk_error` 暂停并提示）。不在 Worker 里（`cpu_worker: false`）时没有同步句柄，`read_write` 启动报
  “需要 CPU Worker”。`read_only` 的浏览器磁盘以 `getFile()` 得到的 File 读取（修改在内存，与用户选取的文件相同），页面与 Worker
  都可以。`starter.js` 的 `writeback_backend` 对 `opfs:` 网址建 `OpfsDisk`；启动、`set_fda`/`set_fdb`、`set_cdrom`、`attach_sata_drive`
  的只读浏览器磁盘先换成 File。`check_disk_policy` 在 Node 中拒绝 `opfs:` 网址。
- 管理器：[`src/app/browser_disks.js`](../src/app/browser_disks.js)——列出、新建（`createWritable` 后 `truncate`）、从网址（流式 `fetch`）或本地
  文件（`File.stream()`）导入（边写边算 SHA-256，写完重读副本再算一遍，不符则删除并报错；大小不是整扇区也拒绝）、导出（Chromium 用
  `showSaveFilePicker` 流式写出，其他浏览器以 `getFile()` 的 File 下载，不整份读进内存）、删除（正被使用时拒绝）、改标签；新建与导入前
  检查剩余配额，第一次时请求 `persist()`。图像选择器与向导加入“浏览器磁盘”（选已有的、新建空盘、导入），向导的新盘默认放在浏览器
  磁盘（完成时才建）。库的“浏览器磁盘…”对话框：每块盘的大小、哪些虚拟机在用、导出、删除、导入、新建与总占用；删除虚拟机时一并删除
  只有它用的浏览器磁盘。

**测量与核实。**

- **空间**：Chrome 的 `navigator.storage.estimate()` 把新建空盘的整个大小立即计入本站的用量（256 MB 的空盘：用量增加 256 MB，再写 1 MB
  不再增加），即便底层文件可能稀疏。所以浏览器磁盘按标称大小占配额；向导选浏览器磁盘时写明这一点并显示本站剩余空间。本机无头 Chrome
  的配额约 10 GB（随磁盘剩余空间）。
- **浏览器支持**：同步访问句柄只在专用 Worker、OPFS 与安全上下文中可用。按 MDN 与 caniuse 的数据：Chrome/Edge 102、Firefox 111、
  Safari 15.2 起提供；但 Chromium 在 108 之前 `getSize`、`flush`、`truncate`、`close` 是异步的，本实现按同步接口写，所以 Chromium 需要 108 起。
  本机只核实了 Chrome；Firefox 与 Safari 未实测。

**决定与偏差。**

1. **generation 在每个会话的第一次写入时移动**：计划写“打开时大小不符则加一；mark 时加一”。OPFS 文件没有 mtime 可用，只靠 mark 不能
   发现别的会话在快照之后写过（它的写入不经过 mark），所以改为每个会话第一次写入前移动，快照之后第一次写入前也移动；mark 本身只记录。
2. **只读的浏览器磁盘在页面中也可以用**：计划把“CPU 不在 Worker 中”一律列为启动错误；只读时读的是 File，不需要同步句柄，所以只拒绝
   `read_write`。
3. **配额错误的端到端注入未做**：`QuotaExceededError` 的映射在后端单元测试中注入（Worker 里替换句柄的 `write`）；它进入 D0 的错误策略
   后的暂停与提示已由磁盘错误对话框的测试覆盖（磁盘服务断开的情形）。真实耗尽配额在无头 Chrome 中需要写满约 10 GB，未做。
4. **“不 sync 只等定时 flush”按“客户机 sync 之后不关机、等定时 flush 后直接关掉标签页”验证**：客户机不 sync 时数据还在它自己的页缓存里，
   根本没到盘上；块设备层面的写入完成后，后端的定时 flush 使它持久。

**测试结果。**

| 测试 | 结果 |
| --- | --- |
| `tests/app/opfs_disk_test.html`（新，后端在专用 Worker 中） | 读写；管理器写的记录（UUID、generation 7）被读入，会话的第一次写入使 generation 变为 8、第二次不变；最后一次写入 1 秒后定时 flush；快照引用（generation 8、不含数据），之后的写入使其变为 9，旧引用被拒；第二个写者被拒（正被使用）；注入 `QuotaExceededError`：`no_space`、不可重试；关闭后重新打开数据与记录（含管理器的标签）都在；启动时拒绝非整扇区、与描述不符的大小、不存在的盘；没有记录的盘建立记录。页面上（没有同步句柄）`read_write` 报“需要 CPU Worker” |
| `tests/app/browser_disk_test.html`（新） | `linux`：Linux 4.16 把新建的 32 MB 浏览器磁盘格式化为 ext2、写文件、`sync`、关机，关闭标签页后重新打开，文件在；再写一个文件并 `sync`，7 秒后不关机直接关掉标签页，重新打开后文件在（定时 flush）。`import`：导入 `images/msdos622.img`（SHA-256 与源相同，进度到 64 MB），导出的文件 SHA-256 相同；MS-DOS 在其上写文件，关机后文本在浏览器磁盘里、源不变。`share`：两台虚拟机共用一块盘，第一台运行时第二台启动被拒；第一台挂起后第二台写盘，第一台恢复被拒（“cannot go back”）；库的“浏览器磁盘”对话框列出两块盘及其使用者；删除第一台时只删除它独有的盘。`page`：CPU 在页面中时启动被拒（“needs the CPU Worker”） |
| `tests/api/disk-options.js`（补充） | Node 中 `opfs:` 网址（硬盘 `read_write`、光驱、软盘）启动被拒；源码与发布构建都通过 |
| 回归 | `make disk-persistence-tests` 通过；`tests/persistence/browser_runner.mjs part=d2/page`（页面与 CPU Worker）通过；`tests/api/state.js`、`floppy.js`、`cdrom-insert-eject.js`、`disk-image.js`、`reset.js`、`clean-shutdown.js`、`arm64-options.js`、`destroy-during-init.js` 通过；Closure 全部 0 错误；`make app-check` 无错；eslint 无输出 |
