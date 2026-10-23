# Android 镜像：选镜像就能用、目录与一键下载 实施计划

状态：设计与实施计划，尚未实现。2026-10-23 初稿，基于 `336f0df7`。规模：S 为几天，M 约 1–2 周，
L 约 3–4 周，XL 超过一个月（与 [ARM64 virt 与 Android 16 计划](arm64-virt-android16-plan.md) 相同）。

本计划让 VM 管理器像 Android Studio 的 AVD 管理器那样使用 Android：用户选一个官方镜像包（或在目录里
点一下），v64 识别它、建好磁盘、按设备型号配好硬件，然后由 v64 自己从磁盘引导，不再要求用户填写内核、
initrd、命令行与磁盘。

现在 Android 16 能在 v64 上运行（[aarch64.md](aarch64.md)），但启动材料由 `tools/a64_android.mjs` 在 node 里
做好，用户在设置里手填内核与 initrd 的 URL、命令行与磁盘；Android 预设声明的安装方式 `"android"`
在向导里没有对应的来源（[src/app/ui/wizard.js](../src/app/ui/wizard.js) 24–30、204–209）。

## 别人怎么做（2026-10-23 调研）

| 产品 | 做法 |
| --- | --- |
| VMware、VirtualBox | 没有 Android 的安装流程；社区用 Android-x86 的 ISO（只有 x86），在客体里跑安装器 |
| Parallels、UTM | 通用操作系统用“目录加一键下载”（Parallels 的安装助手、UTM 的预制虚拟机库）；Android ARM64 不在官方目录 |
| Android Studio 的 AVD 管理器 | 选设备型号 → 选系统镜像（SDK 仓库按 API 级别、ABI、是否带 Play 分类，zip 内含 `kernel-ranchu`、`ramdisk.img`、`system.img`、`vendor.img`、`userdata.img`、`build.prop` 等）→ 填内存与存储；启动细节全由模拟器处理 |
| Cuttlefish | `cvd fetch` 取镜像 zip，`launch_cvd` 组装复合磁盘、生成 bootconfig、选 GPU 模式；换 GSI 只替换 system |
| Genymotion | 从自家目录选预制的 Android 虚拟机 |

共同点：用户选的是**镜像包加设备型号**，内核、ramdisk、分区、bootconfig、GPU 模式由工具按包的内容与
型号决定。v64 照这个做：预设就是“设备型号”，导入器认得几种官方镜像包，v64 自己扮演 bootloader。

## 结论

1. **v64 扮演 bootloader（I2）。** Android 虚拟机的配置不再有内核与 initrd，而是一个 `android` 节（设备型号、
   槽位、GPU 模式、vendor ramdisk 的取法）。开机时 v64 从磁盘的 GPT 读 boot、init_boot、vendor_boot 与
   vbmeta，拼 initrd（vendor ramdisk、通用 ramdisk、bootconfig 尾）、生成 bootconfig（Cuttlefish 启动器与
   U-Boot 写的键，vbmeta 摘要按 libavb 的规则从盘上算）与命令行，和 `tools/a64_android.mjs` 今天做的
   一样。启动代码在创建 CPU 之前已经异步读盘（[src/browser/starter.js](../src/browser/starter.js) `done()` 1165–1187 读 hda
   的第一个扇区），引导器就放在那里；CPU Worker 下由 Worker 里的实例执行。
2. **一套共用的镜像库（I1）。** `a64_android.mjs` 里的解析与改写全是字节操作（boot 与 vendor_boot 头 v3/v4、
   LZ4 legacy、cpio、bootconfig、Android sparse、AVB、LP 元数据、erofs、GPT），移到 `src/android/` 的 ES 模块，
   node 工具与浏览器共用；工具改用它们后产物逐字节不变。
3. **认得四种包（I3–I6）。**
   - Cuttlefish 镜像 zip（ci.android.com 的 `aosp_cf_arm64_only_phone-img-<build>.zip`）：完整的设备。
   - 官方 GSI zip（`system.img`）：替换 Cuttlefish 设备的 system；设备部分来自一个 Cuttlefish 包。
   - Android 模拟器的系统镜像 zip（SDK 仓库，与 AVD 用的同一批）：需要模拟器的 ranchu 板，
     来自 [aarch32-plan.md](aarch32-plan.md) R6；64 位镜像在 arm64 下，API 25 及以前的 32 位镜像在 `arm32` 下。
   - v64 自己的材料（`a64_android.mjs` 的输出目录与 `manifest.json`）。
4. **磁盘在 Worker 里组装，按实际数据写。** sparse 的 FILL 与 DONT_CARE 不写；浏览器磁盘用 OPFS 的同步
   访问句柄在专用 Worker 里按位置写（现在只有 CPU Worker 里的 `OpfsDisk` 这样写，
   [src/opfs_disk.js](../src/opfs_disk.js) 150–182），磁盘服务用会话写入。Chrome 把新浏览器磁盘的**名义大小**整个计入
   配额（vm-manager-plan.md 971–973），而 Cuttlefish 的盘名义上 17.5 GB（super 与 userdata 各 8 GiB）：
   组装时把 super 缩到已用加余量（改写 LP 元数据的块设备大小），userdata 的大小由用户选（默认 4 GiB）。
5. **显卡分三档。** 不改镜像只有 SwiftShader（v64 上画不出桌面，见 aarch64.md）；gfxstream 完成后不改镜像也能
   用 GPU（[gfxstream-plan.md](gfxstream-plan.md)）；在那之前，导入时可选“安装 v64 的 Venus 驱动”（改 odm、哈希树与
   vbmeta，`a64_android.mjs` 的现有做法）。界面如实说明每档的代价。
6. **下载受跨域限制，按来源分别处理（I7）。** 2026-10-23 核对：
   - `dl.google.com`（官方 GSI，例如 `aosp_arm64-exp-BP2A.250605.031.A3-13578795-82277143.zip`，
     915,606,688 字节；SDK 的模拟器镜像）不发 `Access-Control-Allow-Origin`，网页不能直接下载。
   - `ci.android.com/.../latest/raw/<文件>` 先回 307 且不带 CORS 头；重定向的目标是 storage.googleapis.com 的
     签名地址，它允许跨域（`*`）与 Range，但约 5.5 分钟后失效，`x-goog-hash` 也不对页面暴露。
   - 站点（Cloudflare Pages，Direct Upload）不放磁盘镜像（vm-manager.md 115–116），单个文件上限 25 MiB。

   所以“一键下载”对 ci.android.com 需要一个只解析重定向的小函数（Pages Function），浏览器拿到签名地址后直接
   从 Google 下载；对 dl.google.com，可选的办法是用户自己下载后拖进来、本机磁盘服务在服务端代下、或镜像到
   站点自己的存储（R2，需要许可审查）。具体组合待所有者决定（见“待决问题”）。
7. **目录是新的所有者决定。** VM 管理器计划原定“不提供示例系统列表”（vm-manager-plan.md 143、645）；
   所有者 2026-10-23 要求加入目录与一键下载，本计划以此为准，并在 vm-manager-plan.md 记一笔。

## 现有基础

| 部分 | 位置 | 本计划怎么用 |
| --- | --- | --- |
| Android 材料的生成 | [tools/a64_android.mjs](../tools/a64_android.mjs)（1414 行）：boot 头 210–246、LZ4 249–280、cpio 283–297、bootconfig 300–322、sparse 325–409、AVB 415–511、LP 519–560、erofs 565–799、`super_replace` 811–876、Venus 900–909、GPT 1042–1085、`launcher_bootconfig` 1090–1147、`main` 1149–1348 | 移进共用库；工具改用它 |
| 已有的通用件 | SHA-256 [src/image/sha256.js](../src/image/sha256.js)；CRC-32C [src/image/vhdx.js](../src/image/vhdx.js) 47；inflate [src/virt/inflate.js](../src/virt/inflate.js)（整块，不流式）；Range 读 [src/image/source.js](../src/image/source.js)；tar 成员 [src/image/ova.js](../src/image/ova.js) | 复用；zip 与流式解压另写（node 侧 `tools/a64_cts.mjs` 26–110 已有 zip64 读法可参照） |
| ARM 引导 | [src/virt/loader.js](../src/virt/loader.js) `load_linux` 74–115；[src/virt/dtb.js](../src/virt/dtb.js) chosen 224–229；`src/arm/cpu.js` 369–378、692–696 | 引导器产出的 kernel、initrd、cmdline 走同一条路 |
| 选项到 Worker | [src/browser/cpu_worker.js](../src/browser/cpu_worker.js) 71–93 | 新的 `android` 选项要带过去 |
| 磁盘 | 浏览器磁盘 [src/app/browser_disks.js](../src/app/browser_disks.js)（`create_disk` 截断建盘；`import_disk` 在页面上顺序写并算 SHA-256，没有按位置写）；磁盘服务 [tools/disk-service.mjs](../tools/disk-service.mjs)（列表、建盘、会话写，无上传） | 组装器在 Worker 里按位置写 OPFS；磁盘服务加流式导入 |
| 向导 | [src/app/ui/wizard.js](../src/app/ui/wizard.js)（来源、系统、名称、硬盘、摘要五步）；预设 [guest_presets.js](../src/app/guest_presets.js) 155–178 | 加“Android 镜像”来源与进度对话框 |
| 部署 | `.github/workflows/pages.yml`（wrangler pages deploy）、[tools/pages_dist.mjs](../tools/pages_dist.mjs)（`_headers` 的 COOP/COEP） | 目录 JSON 随站点发布；解析函数作为 Pages Function |

## 设计

### 设备型号与 `android` 配置

设备型号是一个随代码发布的描述：

```
{
  "id": "cf_arm64_only_phone",              // Cuttlefish arm64-only phone
  "cpu": "arm64", "machine": "virt", "profile": "v2",
  "boot_devices": "4010000000.pcie",
  "partitions": [...],                       // GPT 的顺序与默认大小（super、userdata 可调）
  "bootconfig": {...},                       // 启动器与 U-Boot 的固定键（今天 launcher_bootconfig 的常量部分）
  "gpu_modes": { "swiftshader": {...}, "venus": {...}, "gfxstream": {...} },  // 各模式的 bootconfig 键
  "cmdline_tail": "console=hvc0 earlycon=pl011,mmio32,0x9000000"
}
```

VM 配置的 `android` 节：`{ device, slot: "a", gpu_mode, vendor_ramdisk: "release" | "debug", selinux }`。
配置有 `android` 时 `kernel` 必须为空；预设 `android16` 填好它。模拟器镜像（I6）用另一种设备型号
（ranchu，按 API 级别给命令行与盘的顺序）。

### 引导器（v64 内）

开机时，按 `android.device` 读第一块 virtio 盘：

1. GPT（新写的读取器）→ 按名字找 `boot_<slot>`、`init_boot_<slot>`、`vendor_boot_<slot>`、`vbmeta_<slot>` 与
   链接的 vbmeta 分区。
2. boot 头 v3/v4 → 内核（gzip 的 EFI zboot 由 loader 处理）；init_boot → 通用 ramdisk；vendor_boot v4 →
   vendor ramdisk 表与 vendor bootconfig、cmdline。
3. vbmeta 摘要与大小：按 libavb 的加载顺序算（`vbmeta_digest` 的移植）。
4. bootconfig = vendor 的 bootconfig ∪ 设备型号的固定键 ∪ GPU 模式的键 ∪ 计算出的键（槽位、vbmeta、
   内存大小、fstab 后缀），按 `append_bootconfig` 的格式附在 initrd 尾；命令行 = vendor 的 + boot 的 + 设备的尾部。
5. 交给 `load_linux`。快照里不存引导材料：恢复时内存里已有内核。

`vendor_ramdisk: "debug"` 需要额外的 `vendor_ramdisk-debug.img`（ci.android.com 单独的工件，不在镜像 zip 里；
adbd 不需要密钥）；默认用 vendor_boot 自带的 release ramdisk，与官方启动一致。

### 导入与组装

导入器先**识别**包：zip 里有 `super.img` 与 `vendor_boot.img` 是 Cuttlefish 镜像；只有 `system.img`（及可选
`vbmeta.img`）是 GSI；有 `kernel-ranchu` 与 `source.properties` 是模拟器镜像；目录里有 `manifest.json` 与
`disk.img` 是 v64 材料。再按包选设备型号与预设，列出要做的事和需要的空间，用户确认后在 Worker 里：

- **流式解压**：zip 的中央目录用 Range 读（文件或 URL 都是随机访问），成员用 `DecompressionStream("deflate-raw")`
  流式解压，支持 zip64；CRC-32 校验。
- **写盘**：按设备型号的布局写 GPT 与各分区；sparse 成员边解边写，跳过 FILL 零与 DONT_CARE。
- **super**：Cuttlefish 包照搬逻辑分区，按已用大小缩小 super（改写 LP 的几何与元数据副本、校验和）；GSI 用新的
  `system_a` 范围替换，删除 `product_a`（刷 GSI 的通常做法，由 I5 的参考确认），按需要改 vbmeta 的标志。
- **校验**：每个成员的 hash 与包的清单（若有）、目录条目的 sha256 对照；写完复读抽查。
- **目标**：浏览器磁盘（OPFS，`v86/disks/<id>.img`）、磁盘服务的文件，或 node 的普通文件（工具）。

### 目录与下载

`catalog.json` 随站点发布（版本号、条目），条目：`{ id, title, android, api, abi, kind, device, parts: [{ name,
url, size, sha256, via }], requires, gpu, license, notes }`。`via` 说明怎么取：

| `via` | 用于 | 怎么取 |
| --- | --- | --- |
| `ci-resolve` | ci.android.com 的工件 | Pages Function 向 `.../latest/raw/<文件>` 发请求，只返回 307 的 Location；浏览器直接对签名地址发 Range 请求；签名过期就再解析 |
| `manual` | dl.google.com 的 GSI 与 SDK 镜像 | 页面给出官方下载页的链接与文件名、大小、sha256，用户下载后拖进来，导入器校验 |
| `service` | 同上，本机有磁盘服务时 | 磁盘服务在 node 里代下（只允许目录里的主机与 hash），浏览器读本机文件 |
| `mirror` | 所有者批准镜像的条目 | 站点自己的存储（例如 R2，配 CORS 与 Range） |

下载器在 Worker 里：Range 分段、断点续传、暂存到 OPFS 的 `v86/downloads/`、流式 SHA-256；配额不足时先提示
（`navigator.storage.estimate`，并申请 `persist()`）。下载完成直接进入导入；暂存文件在导入成功后删除。

## 阶段

| 顺序 | 阶段 | 首个交付 | 前置 | 规模 |
| --- | --- | --- | --- | --- |
| 1 | I0 调研、参考与决定 | 各种包的内容与参考引导；所有者的托管与许可决定 | 无 | M |
| 2 | I1 共用镜像库 | `src/android/`；`a64_android.mjs` 改用它，产物逐字节不变 | I0 | L |
| 3 | I2 引导器 | `android` 配置；从磁盘引导现有的 Android 16 盘，不填内核与 initrd | I1 | M |
| 4 | I3 导入 Cuttlefish 镜像 | 向导的“Android 镜像”来源；选官方 zip 就建好可开机的虚拟机 | I2 | L |
| 5 | I4 进度、设置与磁盘大小 | 长任务对话框；Android 设置节（GPU 模式、清除数据、重置）；super 缩小与 userdata 选择 | I3 | M |
| 6 | I5 GSI | 选官方 GSI zip（加一个 Cuttlefish 设备包）即可开机 | I3 | M |
| 7 | I6 模拟器镜像 | 选 SDK 的模拟器镜像 zip 即可开机（arm64；32 位见 aarch32-plan） | I3；aarch32-plan R6 | M |
| 8 | I7 目录与一键下载 | `catalog.json`、下载器、解析函数、目录界面 | I3；所有者的托管决定 | L |
| 9 | I8 GPU 选项与收尾 | Venus 注入作为导入选项；gfxstream 完成后的默认；文档与门禁 | I3；gfxstream-plan | S |

I0–I4 之后：选官方 Cuttlefish zip 即可开机（与 AVD 相当的体验）。全部约 3–4 个月；I6 依赖 ranchu 机器，
I8 的 gfxstream 默认依赖 gfxstream 计划。

## 1. I0 调研、参考与决定

| ID | 任务 | 规模 |
| --- | --- | --- |
| I0.1 | 包的内容：Cuttlefish 镜像 zip（已知：11 个 deflate 成员，无 zip64；boot、vendor_boot 各 64 MiB，init_boot 8 MiB，四个 vbmeta，sparse 的 super 与 userdata）；官方 GSI zip（成员、`system.img` 的文件系统 erofs 或 ext4、`ro.product.cpu.abilist32`、是否带 vbmeta）；SDK 模拟器镜像（API 25 armeabi-v7a 与 API 28 arm64-v8a 的成员已读 zip 目录核对） | S |
| I0.2 | 参考：QEMU（HVF）用 node 工具产出的材料引导三种组合：官方 Cuttlefish 不改（release vendor ramdisk，SwiftShader）、Cuttlefish 加 Venus（现状）、Cuttlefish vendor 加官方 GSI；记录 GSI 需要的 super 与 vbmeta 改动 | M |
| I0.3 | 配额与空间：Chrome、Firefox、Safari 对 OPFS 的名义大小计费与同步访问句柄的支持；super 缩小后的盘大小；最低空间要求 | S |
| I0.4 | 所有者决定：下载的托管方式（见待决问题）、许可审查、目录的首批条目、vendor ramdisk 的默认（release 或 debug） | S |

## 2. I1 共用镜像库

| ID | 任务 | 关键位置 | 门禁 | 规模 |
| --- | --- | --- | --- | --- |
| I1.1 | `src/android/` 模块：`zip.js`（中央目录、zip64、流式解压、CRC）、`sparse.js`、`bootimg.js`（boot、vendor_boot v3/v4、init_boot）、`lz4.js`、`cpio.js`、`bootconfig.js`、`avb.js`（vbmeta、摘要、哈希树）、`lp.js`（读与写：缩小、替换、删除分区）、`erofs.js`（读、加文件）、`gpt.js`（读与写），全部基于 `Uint8Array`/`DataView` 与随机读回调 | 新目录 | 单元测试；node 与浏览器各跑一遍 | L |
| I1.2 | `tools/a64_android.mjs` 改用这些模块（node 的 I/O 留在工具里） | 工具 | 4K、16K、Venus 三种产物与 `manifest.json` 的 `results` hash 逐字节不变 | M |

## 3. I2 引导器

| ID | 任务 | 关键位置 | 门禁 | 规模 |
| --- | --- | --- | --- | --- |
| I2.1 | 设备型号描述 `cf_arm64_only_phone`（从 `launcher_bootconfig` 的常量与 GPU 键整理）；VM 配置的 `android` 节、校验与迁移 | `src/android/devices.js`、`src/app/vm_config.js` | app 单元测试 | S |
| I2.2 | 引导器：在 `done()` 里（CPU Worker 下在 Worker 的实例里）读盘、拼 initrd 与 bootconfig、生成命令行；`android` 选项经 `cpu_worker.js` 传递 | `src/browser/starter.js` 1165–1187、`src/browser/cpu_worker.js` 71–93 | 生成的 initrd、命令行与工具产出的逐字节相同（同一块盘） | M |
| I2.3 | 预设 `android16` 改用 `android` 节；`tests/a64/android_boot.mjs` 加“由引导器启动”的模式 | `guest_presets.js`、测试 | Android 16 到 `sys.boot_completed`（Venus 盘） | S |

## 4. I3 导入 Cuttlefish 镜像

| ID | 任务 | 关键位置 | 门禁 | 规模 |
| --- | --- | --- | --- | --- |
| I3.1 | 组装器（Worker）：识别、计划、流式写盘、校验；目标为 OPFS 浏览器磁盘与 node 文件 | 新 `src/android/assemble.js`、Worker 入口 | 同一 zip 组装出的盘与工具的盘分区内容 hash 相同 | L |
| I3.2 | 磁盘服务的流式导入（会话写入或新的导入端点，带进度） | `tools/disk-service.mjs`、`src/app/disk_service_client.js` | 服务端测试 | M |
| I3.3 | 向导的来源“Android 镜像”：选文件（或输入 URL），识别结果、空间需求、显卡档位说明；完成即建好虚拟机 | `src/app/ui/wizard.js` | wizard 测试（headless Chrome，小型合成包） | M |

验收（I3）：用户在向导选官方 `aosp_cf_arm64_only_phone-img-15581820.zip`，不填任何启动参数，虚拟机开机到
`sys.boot_completed`（SwiftShader 档，或 I8 之前手动勾 Venus 注入）。

## 5. I4 进度、设置与磁盘大小

| ID | 任务 | 规模 |
| --- | --- | --- |
| I4.1 | 长任务对话框：阶段、字节进度、速度、剩余时间、取消；导入在后台继续时库里显示状态 | M |
| I4.2 | Android 设置节：设备型号、GPU 档位、vendor ramdisk、SELinux（调试用）；“清除用户数据”（重写 userdata 与 metadata）与“恢复出厂”（重新组装） | S |
| I4.3 | super 缩到已用加余量（LP 元数据改写）；userdata 大小可选（默认 4 GiB）；名义大小与配额的提示 | M |

## 6. I5 GSI

| ID | 任务 | 规模 |
| --- | --- | --- |
| I5.1 | GSI 导入：需要一个设备包（目录里的 Cuttlefish 包，或用户已有的 Android 虚拟机作为来源）；`system_a` 替换、`product_a` 删除、vbmeta 标志，按 I0.2 的结论 | M |
| I5.2 | ABI 检查：读 `system.img` 里的 `build.prop`（erofs 或 ext4 只读查找；ext4 读取器若需要则新写）；`abilist32` 非空而 CPU profile 没有 AArch32 时提示（32 位应用与 `zygote_secondary` 不可用，见 aarch32-plan） | M |
| I5.3 | 验收：`aosp_arm64-exp-BP2A.250605.031.A3` 在参考与 v64 上开机到桌面（显卡档位同 I3） | S |

## 7. I6 模拟器镜像（AVD 的同一批镜像）

| ID | 任务 | 规模 |
| --- | --- | --- |
| I6.1 | 导入 SDK 模拟器镜像 zip：`kernel-ranchu`、`ramdisk.img`、`system.img`、`vendor.img`、`userdata.img`、`encryptionkey.img` 按 ranchu 的盘顺序放好；`source.properties` 与 `build.prop` 决定 API 级别、ABI 与 cpu_type | M |
| I6.2 | 设备型号 `ranchu`（按 API 级别的命令行与属性），机器来自 aarch32-plan R6 | S |
| I6.3 | 验收：官方 Android 9 的 `arm64-v8a`（API 28）在 arm64 下开机；32 位的 Android 7.1.1 见 aarch32-plan R7 | S |

## 8. I7 目录与一键下载

| ID | 任务 | 规模 |
| --- | --- | --- |
| I7.1 | `catalog.json` 的格式与首批条目（Cuttlefish Android 16 的镜像 zip；官方 GSI；I6 之后的 SDK 模拟器镜像）；`tools/android_catalog.mjs` 校验每个条目的大小与 sha256，并随站点发布 | M |
| I7.2 | 下载器（Worker）：Range 分段、续传、暂存、SHA-256、配额检查、取消；下载完成交给导入器 | L |
| I7.3 | `ci-resolve` 的 Pages Function：只对目录里的构建号与文件名解析重定向，返回签名地址与过期时间；`tools/pages_dist.mjs` 打包 `functions/` | S |
| I7.4 | `manual` 与 `service` 两种来源的界面：官方页面链接、文件名、大小与 hash 的说明，拖入后自动校验；磁盘服务代下（只允许目录里的主机与 hash） | M |
| I7.5 | 目录界面：向导第一步的“从目录安装”，条目显示 Android 版本、大小、显卡档位、许可与来源；所有者批准后加 `mirror` 来源 | M |

验收（I7）：在部署的站点上，从目录选“Android 16（Cuttlefish）”，一次点击完成下载、组装与建虚拟机，开机。

## 9. I8 GPU 选项与收尾

| ID | 任务 | 规模 |
| --- | --- | --- |
| I8.1 | 导入选项“安装 v64 的 Venus 驱动”：移植 `odm_with_driver`、哈希树、vbmeta 描述符与 LP 的 odm 移动；驱动文件随站点发布或在目录里 | S |
| I8.2 | gfxstream 完成后：设备型号的默认 GPU 档位改为 gfxstream，导入不再需要 Venus | S |
| I8.3 | 文档：[vm-manager.md](vm-manager.md)（Android 一节、目录、下载）、[aarch64.md](aarch64.md)（引导器、导入）、vm-manager-plan.md 记录“目录”的新决定；release_gate 增加导入与引导器的级别 | S |

## 待决问题

1. **dl.google.com 的文件怎么给一键下载**：只用 `manual`（拖入），本机加 `service` 代下，还是镜像到站点存储
   （R2，需要逐个确认许可；带 Google Play 或 GMS 的镜像不镜像）。
2. **Cloudflare 上的解析函数**：Pages Function 只解析 ci.android.com 的重定向、不转发文件内容，是否接受。
3. **vendor ramdisk 的默认**：release（与官方启动一致，adb 需要密钥）还是 debug（今天的做法，adbd 无密钥，
   需要额外下载 `vendor_ramdisk-debug.img`）。
4. **在 gfxstream 之前**，Venus 注入作为可选的“修改镜像”是否保留，还是目录里只提供不改镜像的条目。
5. **默认盘大小**：userdata 默认 4 GiB 是否合适；super 缩小后的余量。

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 配额按名义大小计费，Android 盘大 | super 缩小、userdata 可选；导入前算出名义大小与实际写入量，不足时先提示 |
| 下载大（约 0.9–1.8 GB）而不稳定 | Worker 下载器分段续传；暂存在 OPFS；签名地址过期时重新解析 |
| GSI 与 vendor 的版本搭配（vendor 比 system 新） | I0.2 的参考先验证；目录只列验证过的组合 |
| 浏览器差异（OPFS 同步句柄要 Chromium 108 以上；Firefox、Safari 的配额与性能） | 先保证 Chrome；其他浏览器在 I0.3 核对后标注支持程度 |
| LP 元数据与 vbmeta 的改写出错导致不能开机 | 共用库对 node 工具与浏览器同一套测试；组装结果与工具产物逐分区比对；参考引导先行 |
| 官方镜像的许可与再分发 | 默认不镜像，只给官方下载地址；镜像需逐项许可审查与所有者批准 |

## 参考

- [Cuttlefish（device/google/cuttlefish）](https://android.googlesource.com/device/google/cuttlefish/)：`assemble_cvd` 的复合磁盘与 bootconfig
- [Android 引导镜像头（boot_image.h）](https://android.googlesource.com/platform/system/tools/mkbootimg/)、[bootconfig](https://source.android.com/docs/core/architecture/bootloader/implementing-bootconfig)
- [AVB（libavb）](https://android.googlesource.com/platform/external/avb/)、[动态分区与 liblp](https://source.android.com/docs/core/ota/dynamic_partitions)
- [GSI 说明](https://developer.android.com/topic/generic-system-image) 与 [GSI 发布页](https://developer.android.com/topic/generic-system-image/releases)
- [Android SDK 系统镜像仓库](https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-1.xml)
- [OPFS 与同步访问句柄](https://developer.mozilla.org/docs/Web/API/File_System_API/Origin_private_file_system)、[Cloudflare Pages Functions](https://developers.cloudflare.com/pages/functions/)
