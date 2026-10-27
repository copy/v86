# Android 镜像：选镜像就能用与系统目录 实施计划

状态：完成，除 I7 在部署站点上的验收。2026-10-23 初稿，基于 `336f0df7`。2026-10-24：I0.1、I0.2 完成（结果见 §1 之后的“I0 的结果”），
I1–I5、I7 完成（I3 与 I5 的验收：浏览器里拖入官方 zip，或官方 zip 加 GSI，即开机到 `boot_completed`）；I6 完成
（模拟器镜像的导入，7.1.1 的 32 位镜像；API 26–28 的 64 位镜像要宿主 GLES，不做）。2026-10-25：I8 完成（官方 Cuttlefish zip 与官方 GSI
都在 gfxstream 下通过 A9 场景）。只剩 I7 在部署后的站点上的验收（部署由负责人做）；见各节的进度。规模：S 为几天，M 约 1–2 周，
L 约 3–4 周，XL 超过一个月（与 [ARM64 virt 与 Android 16 计划](arm64-virt-android16-plan.md) 相同）。

本计划让 VM 管理器像 Android Studio 的 AVD 管理器那样使用 Android：用户选一个官方镜像包（从目录里挑，
按指引从官方页面下载后拖进来），v64 识别它、建好磁盘、按设备型号配好硬件，然后由 v64 自己从磁盘引导，
不再要求用户填写内核、initrd、命令行与磁盘。

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
   - v64 自己的材料（`a64_android.mjs` 的输出目录与 `manifest.json`）：只供开发与自动化测试，不出现在目录里。
4. **磁盘在 Worker 里组装，按实际数据写。** sparse 的 FILL 与 DONT_CARE 不写；浏览器磁盘用 OPFS 的同步
   访问句柄在专用 Worker 里按位置写（现在只有 CPU Worker 里的 `OpfsDisk` 这样写，
   [src/opfs_disk.js](../src/opfs_disk.js) 150–182），磁盘服务用会话写入。Chrome 把新浏览器磁盘的**名义大小**整个计入
   配额（vm-manager-plan.md 971–973），而 Cuttlefish 的盘名义上 17.5 GB（super 与 userdata 各 8 GiB）：
   组装时把 super 缩到已用加余量（改写 LP 元数据的块设备大小），userdata 的大小由用户选（默认 4 GiB）。
5. **导入的镜像一律不改，显卡靠 gfxstream。** 不改镜像时，gfxstream 之前只有 SwiftShader（软件渲染，在 v64 上
   画不出桌面，见 aarch64.md）；gfxstream 完成后用 GPU（[gfxstream-plan.md](gfxstream-plan.md)）。导入时**不提供**
   “安装 v64 的 Venus 驱动”（所有者 2026-10-23 决定）。所以“选镜像能开机”在 I3 达成，“选镜像能用桌面”要等
   gfxstream 的 G5；界面在 gfxstream 之前如实提示“暂时只能开机，桌面需要 GPU 支持”。
6. **下载受跨域限制，按来源分别处理（I7）。** 2026-10-23 核对：
   - `dl.google.com`（官方 GSI，例如 `aosp_arm64-exp-BP2A.250605.031.A3-13578795-82277143.zip`，
     915,606,688 字节；SDK 的模拟器镜像）不发 `Access-Control-Allow-Origin`，网页不能直接下载。
   - `ci.android.com/.../latest/raw/<文件>` 先回 307 且不带 CORS 头；重定向的目标是 storage.googleapis.com 的
     签名地址，它允许跨域（`*`）与 Range，但约 5.5 分钟后失效，`x-goog-hash` 也不对页面暴露。
   - 站点（Cloudflare Pages，Direct Upload）不放磁盘镜像（vm-manager.md 115–116），单个文件上限 25 MiB。

   ci.android.com 本可以用一个只解析重定向的小函数（Pages Function）做到网页直接下载，所有者 2026-10-23
   决定不加：站点保持纯静态，**所有官方镜像都由用户从官方页面下载、再拖进向导**，v64 不代下、不镜像。
   因此没有网页内的一键下载；目录给出“下载什么、去哪里下、多大、hash 是多少”的指引，拖入之后的校验、
   组装、建虚拟机与开机全部自动。
7. **目录是新的所有者决定。** VM 管理器计划原定“不提供示例系统列表”（vm-manager-plan.md 143、645）；
   所有者 2026-10-23 要求加入目录，本计划以此为准，并在 vm-manager-plan.md 记一笔。

## 现有基础

| 部分 | 位置 | 本计划怎么用 |
| --- | --- | --- |
| Android 材料的生成 | [tools/a64_android.mjs](../tools/a64_android.mjs)（1414 行）：boot 头 210–246、LZ4 249–280、cpio 283–297、bootconfig 300–322、sparse 325–409、AVB 415–511、LP 519–560、erofs 565–799、`super_replace` 811–876、Venus 900–909、GPT 1042–1085、`launcher_bootconfig` 1090–1147、`main` 1149–1348 | 移进共用库；工具改用它 |
| 已有的通用件 | SHA-256 [src/image/sha256.js](../src/image/sha256.js)；CRC-32C [src/image/vhdx.js](../src/image/vhdx.js) 47；inflate [src/virt/inflate.js](../src/virt/inflate.js)（整块，不流式）；Range 读 [src/image/source.js](../src/image/source.js)；tar 成员 [src/image/ova.js](../src/image/ova.js) | 复用；zip 与流式解压另写（node 侧 `tools/a64_cts.mjs` 26–110 已有 zip64 读法可参照） |
| ARM 引导 | [src/virt/loader.js](../src/virt/loader.js) `load_linux` 74–115；[src/virt/dtb.js](../src/virt/dtb.js) chosen 224–229；`src/arm/cpu.js` 369–378、692–696 | 引导器产出的 kernel、initrd、cmdline 走同一条路 |
| 选项到 Worker | [src/browser/cpu_worker.js](../src/browser/cpu_worker.js) 71–93 | 新的 `android` 选项要带过去 |
| 磁盘 | 浏览器磁盘 [src/app/browser_disks.js](../src/app/browser_disks.js)（`create_disk` 截断建盘；`import_disk` 在页面上顺序写并算 SHA-256，没有按位置写）；磁盘服务 [tools/disk-service.mjs](../tools/disk-service.mjs)（列表、建盘、会话写，无上传） | 组装器在 Worker 里按位置写 OPFS；磁盘服务加流式导入 |
| 向导 | [src/app/ui/wizard.js](../src/app/ui/wizard.js)（来源、系统、名称、硬盘、摘要五步）；预设 [guest_presets.js](../src/app/guest_presets.js) 155–178 | 加“Android 镜像”来源与进度对话框 |
| 部署 | `.github/workflows/pages.yml`（wrangler pages deploy）、[tools/pages_dist.mjs](../tools/pages_dist.mjs)（`_headers` 的 COOP/COEP） | 目录 JSON 随站点发布（站点保持纯静态，没有服务端函数） |

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

默认 `vendor_ramdisk: "release"`（所有者 2026-10-23 决定）：用 vendor_boot 自带的 release ramdisk，与官方启动
一致，只需要镜像 zip；adb 第一次连接要在屏幕上确认。`"debug"` 是设置里的高级选项：需要另外下载并拖入
`vendor_ramdisk-debug.img`（ci.android.com 单独的工件，约 19 MB，不在镜像 zip 里），adbd 不需要确认、
可以 root，部分 SELinux 限制放宽；自动化测试用它。

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
page, url, size, sha256, optional }], requires, gpu, license, notes }`。每个文件给官方下载页（`page`，如 GSI
发布页、ci.android.com 的构建页）与直链（`url`，用户在浏览器里打开即可下载），以及大小与 sha256。

流程：用户在目录里选条目 → 页面列出要下载的文件与官方链接 → 用户下载后把文件（一个或几个）拖进来 →
导入器按大小与 sha256 认出是哪个文件、校验，缺哪个就说缺哪个 → 组装、建虚拟机。拖入的文件只读，导入
不复制整份原文件（只按需读取成员）；配额不足时先提示（`navigator.storage.estimate`，并申请 `persist()`）。

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
| 8 | I7 系统目录 | `catalog.json`、下载指引、拖入多文件与校验、目录界面 | I3 | M |
| 9 | I8 GPU 与收尾 | gfxstream 完成后的默认档位；文档与门禁 | I3；gfxstream-plan | S |

I0–I4 之后：选官方 Cuttlefish zip 即可开机（与 AVD 相当的体验）。全部约 3 个月；I6 依赖 ranchu 机器，
I8 的 gfxstream 默认依赖 gfxstream 计划。

## 1. I0 调研、参考与决定

| ID | 任务 | 规模 |
| --- | --- | --- |
| I0.1 | 包的内容：Cuttlefish 镜像 zip（已知：11 个 deflate 成员，无 zip64；boot、vendor_boot 各 64 MiB，init_boot 8 MiB，四个 vbmeta，sparse 的 super 与 userdata）；官方 GSI zip（成员、`system.img` 的文件系统 erofs 或 ext4、`ro.product.cpu.abilist32`、是否带 vbmeta）；SDK 模拟器镜像（API 25 armeabi-v7a 与 API 28 arm64-v8a 的成员已读 zip 目录核对） | S |
| I0.2 | 参考：QEMU（HVF）用 node 工具产出的材料引导三种组合：官方 Cuttlefish 不改（release vendor ramdisk，SwiftShader）、Cuttlefish 加 Venus（现状）、Cuttlefish vendor 加官方 GSI；记录 GSI 需要的 super 与 vbmeta 改动 | M |
| I0.3 | 配额与空间：Chrome、Firefox、Safari 对 OPFS 的名义大小计费与同步访问句柄的支持；super 缩小后的盘大小；最低空间要求 | S |
| I0.4 | 所有者决定：目录的首批条目（下载方式与 vendor ramdisk 的默认已定，见待决问题） | S |

### I0 的结果（2026-10-24）

**I0.1 包的内容。** 官方 GSI zip（三个都是 `system.img`、`vbmeta.img`、`build.prop` 三个成员，deflate，
`system.img` 为原始 ext4，不是 sparse；`vbmeta.img` 的标志为 2，即关闭校验，可直接作顶层 vbmeta；
`build.prop` 在 zip 里，不必读 ext4）：

| GSI | `system.img` | `ro.system.build.version.sdk_full` | 类型 | `abilist32` |
| --- | --- | --- | --- | --- |
| `aosp_arm64-exp-BP2A.250605.031.A3-13578795`（Android 16） | 1,958,629,376 | 36.0 | user | `armeabi-v7a,armeabi` |
| `aosp_arm64-exp-BP4A.251205.006-14401865`（Android 16 QPR2） | 1,889,701,888 | 36.1 | user | `armeabi-v7a,armeabi` |
| `aosp_arm64-exp-CP3A.260905.010-16176746`（Android 17 QPR1） | 2,072,014,848 | 37.1 | user | `armeabi-v7a,armeabi` |

发布页（2026-10-24）列出了每个 zip 的 sha256（`2171cf0e…`、`4a869a69…` 与下载的文件一致）。Cuttlefish 15581820
的 super：LP 头 v10.2（Virtual A/B 标志），3 个元数据槽共 6 份相同的副本，16 个逻辑分区、5 个组，已用到
1.42 GiB（块设备 8 GiB）。

**I0.2 参考引导**（QEMU 9.2 HVF，4 核，1536 MB；`tools/a64_android.mjs` 的 `--release --no-venus` 与 `--gsi`，
`tests/a64/android_boot.mjs` 的 `A64_ANDROID_OUT`、`A64_ANDROID_CONSOLE=0`）：

| system | vendor ramdisk | 结果 |
| --- | --- | --- |
| Cuttlefish 15581820 自带（官方镜像不改，SwiftShader） | release | 19 s 到 `sys.boot_completed` |
| GSI 16（BP2A，36.0） | debug | init 编译 SELinux 策略失败：debug ramdisk 的 `userdebug_plat_sepolicy.cil` 用了该 GSI 的 secilc 不认识的 policycap `functionfs_seclabel` |
| GSI 16（BP2A，36.0） | release | init 编译策略失败：vendor 的策略用了 `nlmsg` 权限，该 GSI 的平台策略没有 |
| GSI 16 QPR2（BP4A，36.1） | debug | 25 s（控制台可用：force_debuggable） |
| GSI 16 QPR2（BP4A，36.1） | release | 23 s（user 版本没有控制台，从内核日志里 init 的那一行判断） |
| GSI 17 QPR1（CP3A，37.1） | release | 22 s |

结论：

- **GSI 不能比 vendor 旧。** 导入 GSI 时比较它的 `ro.system.build.version.sdk_full` 与设备包自带 system 的
  `sdk_full`（Cuttlefish 15581820 为 36.1），GSI 较旧时拒绝并说明原因；较新的（Android 17）可以。I5.3 的验收
  改用 BP4A，目录首批列 BP4A 与 CP3A。
- **debug vendor ramdisk 只配同一版本的 system。** 它的 userdebug 策略取代平台策略；GSI 较新时只用 release
  （I4.2 的设置在 GSI 版本不同时不提供 debug）。
- **`product_a` 不用删。** GSI 的 `skip_mount.cfg` 让 first stage init 跳过 `/product`（内核日志
  “Skip mounting mountpoint: /product”）；I5.1 只替换 `system_a`，并以 GSI 的 `vbmeta.img` 作顶层 vbmeta
  （摘要只算它一个结构，链接的分区不加载）。
- 官方 Cuttlefish 镜像不改即可开机，I3 的“选 zip 就能开机”没有额外障碍。

## 2. I1 共用镜像库

完成（2026-10-24，`1e9506c5`、`2c958904`）：`src/android/` 的 `bytes`、`bootimg`、`lz4`、`cpio`、`bootconfig`、
`sparse`（随机读、按写入解开、流式 `sparse_decoder`）、`avb`、`lp`（读；`lp_parse`/`lp_serialize`、
`lp_resize`、`lp_remove`、`lp_place`，Cuttlefish 的 6 份元数据原样写回逐字节相同）、`erofs`、`gpt`、`zip`
（zip64、`DecompressionStream` 流式解压、CRC-32）、`devices`、`boot`。`tools/a64_android.mjs` 改用它们：4K 与
16K（都带 Venus）的全部产物与 17.5 GB 的 `disk.img` 逐字节不变。单元测试 `tests/android/library.mjs`
（`make ci-tests`），真实镜像的检查 `tests/android/real_images.mjs`（本地）。浏览器里跑同一套测试留到 I3 的
组装器测试一起做。xz 与 gzip 的流式解压（第三方 GSI）留到 I5。

| ID | 任务 | 关键位置 | 门禁 | 规模 |
| --- | --- | --- | --- | --- |
| I1.1 | `src/android/` 模块：`zip.js`（中央目录、zip64、流式解压、CRC）、`sparse.js`、`bootimg.js`（boot、vendor_boot v3/v4、init_boot）、`lz4.js`、`cpio.js`、`bootconfig.js`、`avb.js`（vbmeta、摘要、哈希树）、`lp.js`（读与写：缩小、替换、删除分区）、`erofs.js`（读、加文件）、`gpt.js`（读与写），全部基于 `Uint8Array`/`DataView` 与随机读回调 | 新目录 | 单元测试；node 与浏览器各跑一遍 | L |
| I1.2 | `tools/a64_android.mjs` 改用这些模块（node 的 I/O 留在工具里） | 工具 | 4K、16K、Venus 三种产物与 `manifest.json` 的 `results` hash 逐字节不变 | M |

## 3. I2 引导器

进度（2026-10-24）：I2.2 完成：`src/android/bootloader.js`，V86 的 `android` 选项（`{ device, gpu_mode, selinux,
vendor_ramdisk }`，vendor_ramdisk 为 debug ramdisk 的文件），在 `starter.js` 的 `done()` 里执行（CPU Worker 下在
Worker 里；有状态时也执行，供复位重新加载）。从工具的 `disk.img` 得到的内核、`initrd.img`、`initrd-venus.img` 与
命令行逐字节相同（源码与 `build/libv86.mjs` 都核对过）。I2.1 完成：VM 配置的 `android` 节（`device`、
`gpu_mode`、`vendor_ramdisk`、`debug_ramdisk`、`selinux`；没有 `slot` 字段，槽位属于设备型号），校验、
`config_to_options`、`vm_model` 的连带修改与摘要行；`android16` 预设改用它，安装方式为“硬盘镜像”
（工具的 `disk.img`）。I2.3 完成：`tests/a64/android_boot.mjs` 的 `A64_ANDROID_BOOTLOADER=1`（v64：`android` 选项代替
kernel、initrd 与 cmdline），Venus 盘、页层与 vCPU Worker，1120 s 到 `sys.boot_completed`（2026-10-24，
`v86-jit-par-venus-bl-1536m-4c`；以前给内核与 initrd 时 969–1229 s）。

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
`sys.boot_completed`（SwiftShader 档；桌面的验收在 gfxstream 的 G5 之后，见 I8）。

进度（2026-10-24）：

- I3.1 完成：`src/android/assemble.js`（认包、布局、随 zip 成员解压写盘，super 的写入超出缩小后的大小时检查为零）；
  node 前端 `tools/android_import.mjs`：官方 `aosp_cf_arm64_only_phone-img-15581820.zip` 约 28 s 写成 6.25 GB 的盘
  （实际写入 1.7 GB），与 `tools/a64_android.mjs --release --no-venus --shrink-super --userdata-mb 4096` 的盘逐字节
  相同；这块盘在 QEMU（HVF）上 29 s 到 `boot_completed`，首次开机把空白的 userdata 格式化为 f2fs、metadata 为 ext4。
  浏览器里在 `build/android-import-worker.js` 中用同步访问句柄写 OPFS。
- I3.3 完成：向导的来源“An Android image package (.zip)”，拖入或选择文件，页面上读目录与 super 的元数据、说明是什么包；
  选 Android 16 预设（SwiftShader，不开 Vulkan 与代理），硬盘一步选 userdata（2/4/8/16 GiB，默认 4）、给出盘的大小与写入量，
  完成时在 Worker 里组装并在状态栏显示进度与剩余时间。`tests/app/wizard_test.html part=android`（小型合成包，
  `make app-tests`）；`part=android_boot` 是 I3 的验收（官方 zip，开机到 `boot_completed`，本地运行）。
- I3.2 完成：硬盘一步可选浏览器磁盘或磁盘服务；磁盘服务先建镜像，再由导入器的 Worker 经写入会话写入
  （`src/android/service_writer.js`：整扇区、每次 4 MiB）。`wizard_test part=android_service`（`service=1`）。
- **I3 验收通过**（2026-10-24，`wizard_test part=android_boot isolated=1`，无头 Chrome，跨源隔离，4 个 vCPU Worker）：
  向导里拖入官方 `aosp_cf_arm64_only_phone-img-15581820.zip`（目录的第一项，SHA-256 核对），不填任何启动参数，
  11 s 导入为 5.8 GB 的浏览器磁盘，开机后 26 s 到 second stage、289 s 到 zygote、**1302 s 到 `sys.boot_completed`**
  （SwiftShader），全程 21.9 分钟。

## 5. I4 进度、设置与磁盘大小

| ID | 任务 | 规模 |
| --- | --- | --- |
| I4.1 | 长任务对话框：阶段、字节进度、速度、剩余时间、取消；导入在后台继续时库里显示状态 | M |
| I4.2 | Android 设置节：设备型号、GPU 档位、vendor ramdisk、SELinux（调试用）；“清除用户数据”（重写 userdata 与 metadata）与“恢复出厂”（重新组装） | S |
| I4.3 | super 缩到已用加余量（LP 元数据改写）；userdata 大小可选 2、4、8、16 GiB（默认 4 GiB），放不进可用配额的选项不可选；以后用“清除数据并改大小”调整；名义大小与配额的提示 | M |

进度（2026-10-24）：I4.2 完成：设置对话框的“Android”项（`src/app/ui/panels/android.js`：设备型号、GPU 档位（没有 Vulkan 时只有
SwiftShader）、vendor ramdisk 与 debug ramdisk 的文件、SELinux），“添加硬件”里的“Android boot”；“Wipe user data…”在导入器的
Worker 里用同步访问句柄把浏览器磁盘上 userdata 与 metadata 的第一个 MiB 清零（下次开机格式化；机器运行时磁盘被占用，
会说明）。“恢复出厂”（重新组装）要用户再次拖入包，留到 I7 的多文件拖入之后。I4.3 的 super 缩小与 userdata 选择已在 I3
完成；放不进配额的选项不可选未做。I4.1 现在只是向导状态栏里的进度与剩余时间，没有取消。

## 6. I5 GSI

| ID | 任务 | 规模 |
| --- | --- | --- |
| I5.1 | GSI 导入：需要一个设备包（目录里的 Cuttlefish 包，或用户已有的 Android 虚拟机作为来源）；`system_a` 替换、GSI 的 `vbmeta.img` 作顶层 vbmeta、版本检查（GSI 的 `sdk_full` 不低于设备包 system 的），按 I0.2 的结论（`product_a` 不删） | M |
| I5.2 | ABI 检查：读 `system.img` 里的 `build.prop`（erofs 或 ext4 只读查找；ext4 读取器若需要则新写）；`abilist32` 非空而 CPU profile 没有 AArch32 时提示（32 位应用与 `zygote_secondary` 不可用，见 aarch32-plan） | M |
| I5.3 | 验收：`aosp_arm64-exp-BP4A.251205.006`（与设备包同为 16 QPR2；BP2A 比 vendor 旧，不能开机，见 I0 的结果）在参考与 v64 上开机，Android 17 的 CP3A 也开机（显卡档位同 I3） | S |

进度（2026-10-24）：I5.1 完成：`assemble.js` 的 `gsi_package`（`system.img` 原始 ext4、erofs 或 sparse；`vbmeta.img` 须关闭校验；
`build.prop` 的版本、指纹与 32 位 ABI）与 `cuttlefish_disk` 的 GSI 路径（`system_a` 放进 super 的空闲处、每份元数据都改、再缩小
super，旧 `system_a` 的数据不写；`vbmeta_a/_b` 用 GSI 的）。版本检查用 vendor_boot 的 ramdisk 里 `prop.default` 的
`ro.vendor.build.version.sdk_full`（不必解压 erofs：Cuttlefish 的 erofs 文件是 LZ4 压缩的，layout 3）。向导的 Android 来源
可同时或先后拖入设备包与 GSI，页面上先读出版本与指纹，GSI 较旧时拒绝并说明，GSI 有 32 位 ABI 时提示需要 AArch32
（I5.2；读 zip 里的 `build.prop`，不读 ext4）。`tools/android_import.mjs --gsi` 与 `tools/a64_android.mjs --gsi --shrink-super
--userdata-mb 4096` 逐字节相同，这块盘在 QEMU 上 35 s 到 `boot_completed`。
- **I5.3 验收通过**（2026-10-24，`wizard_test part=android_boot isolated=1 gsi=…BP4A…zip`，无头 Chrome）：目录项
  `android16-gsi-bp4a`，同时拖入官方 Cuttlefish zip 与 BP4A GSI，两个文件 14 s 核对完 SHA-256，20 s 导入为 7.6 GB 的
  浏览器磁盘，开机后 33 s 到 second stage、297 s 到 zygote、**1975 s 到 `sys.boot_completed`**（SwiftShader），全程 33.5 分钟。

## 7. I6 模拟器镜像（AVD 的同一批镜像）

| ID | 任务 | 规模 |
| --- | --- | --- |
| I6.1 | 导入 SDK 模拟器镜像 zip：`kernel-ranchu`、`ramdisk.img`、`system.img`、`vendor.img`、`userdata.img`、`encryptionkey.img` 按 ranchu 的盘顺序放好；`source.properties` 与 `build.prop` 决定 API 级别、ABI 与 cpu_type | M |
| I6.2 | 设备型号 `ranchu`（按 API 级别的命令行与属性），机器来自 aarch32-plan R6 | S |
| I6.3 | 验收：官方 Android 9 的 `arm64-v8a`（API 28）在 arm64 下开机；32 位的 Android 7.1.1 见 aarch32-plan R7 | S |

进度（2026-10-24）：I6.1、I6.2 完成（`150e8f65`）。导入（`src/android/assemble.js` 的 `emulator_disk`）读 zip 的
`source.properties`，按 API 级别与 ABI 选设备型号（`src/android/devices.js` 的 `RANCHU_DEVICES`），把它的分区按顺序
做成一块 GPT 盘：镜像原样写入，模拟器自己生成的盘（cache）写一个空的 ext4（`src/android/ext4.js`，任意大小，只写元数据）。
引导器对这种型号给出内核、ramdisk 与模拟器的命令行，并让盘上的分区成为 ranchu 机器的 virtio 盘
（`src/android/partition_buffer.js`）。向导、导入 Worker、`tools/android_import.mjs` 与预设 “Android 7.1 (32-bit,
emulator image)” 都接上了；`A32_ANDROID_DISK=1 node tests/a32/android_boot.mjs` 从导入的盘开机。已有型号：
`ranchu_25_armeabi_v7a`（Android 7.1.1，cpu_type arm32）。

I6.3 的结论：Android 8.0 起 SurfaceFlinger 必须有 OpenGL ES 2.0（`RenderEngine` 对 1.x 直接中止）。官方 API 27、28 的
`arm64-v8a` 镜像（`arm64-v8a-27_r02`、`-28_r02`，下载核对过 SHA-1）客体里只有宿主 GPU 用的 `libEGL_emulation`
与 1.1 的 libagl，没有 7.1 镜像里那种客体 SwiftShader；它们只能靠模拟器的宿主 GLES（goldfish pipe 上的 GLES 编码流）
显示。aarch32-plan 定下 ranchu 不做宿主 GLES，所以这些镜像在 v64 上起不到 system_server 之后，I6.3 改为以 7.1.1 的
32 位镜像验收（aarch32-plan R7.1），64 位的模拟器镜像不在本计划内。顺带记下 API 28 镜像的格式（将来做宿主 GLES 时用）：
system-as-root（system.img、vendor.img 都是 GPT 盘，ext4 在 1 MiB 处，内核要 `skip_initramfs root=/dev/vda1`），
vendor 由设备树 `/firmware/android/fstab/vendor` 在第一阶段挂载，/data 是 vdc、用 vdd（encryptionkey.img）上的密钥
强制加密，userdata.img 只有 1 MiB（模拟器在宿主上扩大）。

## 8. I7 系统目录

| ID | 任务 | 规模 |
| --- | --- | --- |
| I7.1 | `catalog.json` 的格式与首批条目（Cuttlefish Android 16 的镜像 zip；官方 GSI；I6 之后的 SDK 模拟器镜像；可选的 `vendor_ramdisk-debug.img`）；`tools/android_catalog.mjs` 用 Range 读取核对每个条目的大小与 sha256，并随站点发布 | M |
| I7.2 | 拖入多文件与校验：一次拖入一个或几个文件，按大小与 sha256 对上条目的各个部分（GSI 加 Cuttlefish 设备包等），缺失、多余与不符逐个说明；大文件的 sha256 在 Worker 里流式计算，显示进度 | M |
| I7.3 | 下载指引的界面：每个文件的官方下载页与直链、大小、预计占用的空间，“下载后拖到这里”的区域 | S |
| I7.4 | 目录界面：向导第一步的“从目录安装”，条目显示 Android 版本、大小、显卡档位、许可与来源 | M |

验收（I7）：在部署的站点上，从目录选“Android 16（Cuttlefish）”，按指引下载官方 zip 并拖入，之后不再需要
任何操作：校验、组装、建虚拟机与开机自动完成。

进度（2026-10-24）：I7.1–I7.4 完成：目录是随应用打包的 `src/app/android_catalog.js`（不是单独的 JSON：没有额外请求），
首批三项：Android 16 QPR2（Cuttlefish 15581820，可选的 debug vendor ramdisk）、16 QPR2 GSI（BP4A）与 17 QPR1 GSI（CP3A）
在该设备上；每个文件有官方页面、直链、大小与 SHA-256。`tools/android_catalog.mjs` 用本地副本（大小与 SHA-256）或
服务器的大小（HEAD）核对，六个部分全部相符。向导的 Android 来源列出目录与“另一个包”，所选项的文件与下载处；
拖入的文件先比大小、再在导入器的 Worker 里流式算 SHA-256（有进度，每个文件只算一次），缺哪个、哪个不符逐个说明，
都对上才能继续。debug vendor ramdisk 按大小认出（不是 zip），在设置的 Android 项里使用。部署站点上的验收待部署后做。

2026-10-27（所有者）：目录改为每个能在 v64 上开机的 Android 版本一项，新的在前：Android 17（CP3A GSI，加 Cuttlefish
的 Android 16 手机）、Android 16（Cuttlefish 15581820）、Android 7.1（32 位模拟器镜像 `armeabi-v7a-25_r18`）；16 QPR2
的 GSI（BP4A）一项去掉（它也要 Cuttlefish 的包，与 Android 16 同版本）。向导不再显示 SHA-256 与“官方页面”链接，
只列文件的下载链接与大小（哈希仍在目录里，用来核对拖入的文件）。Android 8.0–15 没有能开机的镜像（GSI 只能在同版本或
更旧的 vendor 上运行；模拟器镜像要宿主 GLES，见 I6.3），1–6 用的是旧的 goldfish 机器，都不列。

## 9. I8 GPU 与收尾

| ID | 任务 | 规模 |
| --- | --- | --- |
| I8.1 | gfxstream 完成后：设备型号的默认 GPU 档位改为 gfxstream；验收：选官方 Cuttlefish zip 与官方 GSI 都进入桌面并通过 A9 场景 | S |
| I8.2 | gfxstream 之前的界面提示：SwiftShader 档只保证开机，说明桌面需要 GPU 支持 | S |
| I8.3 | 文档：[vm-manager.md](vm-manager.md)（Android 一节、目录、下载）、[aarch64.md](aarch64.md)（引导器、导入）、vm-manager-plan.md 记录“目录”的新决定；release_gate 增加导入与引导器的级别 | S |

进度（2026-10-24）：I8.1 的代码完成（`949f8fe0`）：Android 16 预设的显示是 virtio-gpu 的 gfxstream、GPU 档位 gfxstream，
向导不再把导入的包改成 SwiftShader；官方 Cuttlefish zip 在 gfxstream 下通过 A9 场景（gfxstream-plan G5）；官方 GSI（BP4A 加 Cuttlefish 设备包）
2026-10-25 也通过（`boot_completed` 991 s，重启后 477 s；gfxstream-plan G5 的进度）。I8.2 不再需要（默认已有 GPU），向导改为说明没有 WebGPU 时选 SwiftShader。I8.3 完成：[vm-manager.md](vm-manager.md) 的 Android 一节（目录、
下载与拖入、导入、gfxstream、模拟器镜像），[aarch64.md](aarch64.md) 的引导器与导入，vm-manager-plan.md 记下“目录”的
新决定（负责人 2026-10-23 的要求，旧首页的系统按钮仍不恢复），`tools/release_gate.mjs` 的级别 `R-android-images`
（镜像库、QEMU 上的导入布局、Chrome 里的向导）与 `R-arm32-android`。

## 兼容范围：第三方系统（LineageOS 等）

导入器认的是**包的格式**，不认发行方，所以第三方系统能否使用取决于它是哪一类：

| 类别 | 例子 | 能否使用 | 条件 |
| --- | --- | --- | --- |
| Treble GSI（只有 system） | 社区维护的 LineageOS GSI（LineageOS 官方不发布 GSI）、其他基于 TrebleDroid 的 GSI | 能，走 I5 的 GSI 路径 | arm64；Android 版本不低于设备包的 vendor（I0.2：16 QPR2 的 vendor 配 16 r1 的 GSI 编译策略失败，配 16 QPR2 与 17 QPR1 的 GSI 能开机；vendor 是 Android 16 QPR2 时用 LineageOS 23.2 一代或更新的）；含 32 位用户态或 32 位 binder 的变体需要 AArch32（[aarch32-plan.md](aarch32-plan.md)）；签名不同，按 GSI 的做法关闭 vbmeta 校验 |
| Cuttlefish 格式的构建 | 自己从 LineageOS 或 AOSP 源码编的 Cuttlefish arm64 目标 | 能，走 I3 的 Cuttlefish 路径 | 包的布局与官方 Cuttlefish 镜像 zip 相同 |
| Android 模拟器格式的构建 | 第三方按 SDK 模拟器格式打包的镜像 | 原则上能，走 I6 | 需要 ranchu 机器；只要包内有 `kernel-ranchu`、`ramdisk.img`、`system.img` 等 |
| 真机的整机刷机包 | 某款手机的 LineageOS（`payload.bin` 的 OTA zip） | 不能 | 内核、vendor 与驱动是那款手机硬件的，不是虚拟设备的 |

为此需要的补充（列入 I1、I5）：

- 文件格式：GSI 常以 `.img.xz`、`.img.gz` 或 `.zip` 发布，`system.img` 可能是 sparse 或原始格式。I1 的库加
  xz 与 gzip 的流式解压（浏览器没有内置 xz，需要 JS 或 wasm 解码器），导入器按内容而不是扩展名识别。
- 版本检查：导入时读 GSI 的 `ro.build.version.release` 与设备包 vendor 的版本，不一致时提示可能不能开机。
- 设备包：如果要支持 Android 14、15 的 GSI，需要对应版本的 Cuttlefish 设备包（ci.android.com 有各版本的构建），
  作为目录里的独立条目；首批只做 Android 16。

## 待决问题

1. （已定，2026-10-23）dl.google.com 的文件由用户自己下载、拖入向导；不代下，不镜像。
2. （已定，2026-10-23）不加 Pages Function，站点保持纯静态；ci.android.com 的文件同样由用户下载、拖入。
3. （已定，2026-10-23）vendor ramdisk 默认 release；debug 为高级选项（另需拖入 `vendor_ramdisk-debug.img`），
   自动化测试用 debug。
4. （已定，2026-10-23）不提供 Venus 注入；导入的镜像一律不改，桌面等 gfxstream。
5. （已定，2026-10-23）userdata 可选 2、4、8、16 GiB，默认 4 GiB。实测（2026-10-23，QEMU HVF，官方 Cuttlefish 15581820）：
   全新开机后 `/data` 用了约 0.6 GB（boot_completed 时 615,848 KB，两分钟后 589,708 KB）。整块盘的名义大小
   约为 2.2 GB（缩小后的 super 加启动分区与 metadata）加 userdata：2 GiB 时约 4.4 GB、4 GiB 时约 6.5 GB、
   8 GiB 时约 10.6 GB。Android 在剩余空间低于约 10% 或 500 MB 时提示空间不足；2 GiB 只够装几个应用，
   8 GiB 在配额紧的浏览器里放不下（所有者的 Chrome 显示 70.1 GB 中已用 60.1 GB）。

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 配额按名义大小计费，Android 盘大 | super 缩小、userdata 可选；导入前算出名义大小与实际写入量，不足时先提示 |
| 用户要自己下载大文件（约 0.9–1.8 GB），可能下错版本或下不完整 | 目录给出确切的文件名、大小与 sha256；拖入后先比大小再流式算 hash，不符时指出是哪个文件、应该是什么 |
| GSI 与 vendor 的版本搭配（vendor 比 system 新） | I0.2 已验证：GSI 比 vendor 旧时 init 编译 SELinux 策略失败；导入时比较 `sdk_full` 并拒绝；目录只列验证过的组合 |
| 浏览器差异（OPFS 同步句柄要 Chromium 108 以上；Firefox、Safari 的配额与性能） | 先保证 Chrome；其他浏览器在 I0.3 核对后标注支持程度 |
| LP 元数据与 vbmeta 的改写出错导致不能开机 | 共用库对 node 工具与浏览器同一套测试；组装结果与工具产物逐分区比对；参考引导先行 |
| 官方镜像的许可与再分发 | 默认不镜像，只给官方下载地址；镜像需逐项许可审查与所有者批准 |

## 参考

- [Cuttlefish（device/google/cuttlefish）](https://android.googlesource.com/device/google/cuttlefish/)：`assemble_cvd` 的复合磁盘与 bootconfig
- [Android 引导镜像头（boot_image.h）](https://android.googlesource.com/platform/system/tools/mkbootimg/)、[bootconfig](https://source.android.com/docs/core/architecture/bootloader/implementing-bootconfig)
- [AVB（libavb）](https://android.googlesource.com/platform/external/avb/)、[动态分区与 liblp](https://source.android.com/docs/core/ota/dynamic_partitions)
- [GSI 说明](https://developer.android.com/topic/generic-system-image) 与 [GSI 发布页](https://developer.android.com/topic/generic-system-image/releases)
- [Android SDK 系统镜像仓库](https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-1.xml)
- [OPFS 与同步访问句柄](https://developer.mozilla.org/docs/Web/API/File_System_API/Origin_private_file_system)
