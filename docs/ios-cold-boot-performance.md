# iPhone 4 真正冷启动性能

验收目标：从创建断电状态的机器（包含核心、设备和 NAND 启动区读取）到
SpringBoard 桌面可见且能响应触摸，不超过 120 秒。禁止用内存快照、恢复运行、
修改客户机时钟或伪造启动完成标志替代冷启动。磁盘导入复制单独计时。

## 可复现的测量

使用机主提供的 iPhone3,1 / 10B329 文件，在独立目录生成测试 NAND。
不修改正在运行的虚机或原始固件；产物和截图留在忽略的 `build/ios/` 中。

```sh
node tools/ios/prepare-install-probe.mjs \
  build/ios/ui-offline/system.hfs build/ios/10B329/kernelcache.n90.macho \
  build/ios-install-fixtures build/ios-guest/libv86gles.dylib \
  build/ios/boot-baseline --policy --serve --no-diagnostics
node tools/ios/pack-nand.mjs build/ios/boot-baseline/flash.img build/ios/boot-baseline/flash.packed
node tools/ios/build-boot-profile.mjs
BROWSER_FOCUS=1 TEST_ARTIFACT_DIR=build/ios/boot-baseline/profile \
  TIMEOUT_MS=1300000 node tests/app/browser_runner.mjs tests/ios/cold-boot.html \
  isolated=1 webgpu=1 probe=build/ios/boot-baseline profile=1 seconds=1200
```

`--no-diagnostics` 关闭测试镜像特有的周期 ASL 日志导出，与正式导入一致。
测试通过实际 CPU Worker、同步 OPFS NAND 和 WebGPU 运行原生系统。
每 10 秒保存 `profile.json`、原始串口和 `current.png`。计时 Worker 为测试专用，
正式性能验收去掉 `profile=1`。测试页面的 PASS 仅表示采样完成，**不代表桌面已就绪**；
必须审阅实际截图并测试解锁、桌面和触摸。

页面提供 Home / Slide to unlock。也可向测试目录写 `boot-command.json`：
`{"id":1,"op":"unlock"}`，或 `home`、`capture`（附 `name`）、`finish`。
每个新命令使用不同 id。串口关键行使用 power-on 的同一单调时钟记录。

## 初始基线：2026-11-14

首轮前 181 秒的结果（完整桌面时间仍在测量中）：

| 里程碑 | power-on 后时间 |
| --- | ---: |
| 核心和设备加载，无快照 | 0.47 s |
| BSD 找到根分区 | 23.22 s |
| 文件系统 QUICKCHECK CLEAN | 79.51 s |
| FIPS 用户态自检完成 | 97.7 s 左右 |
| 原生安装服务启动 | 117 s 左右 |
| 多点触摸固件载入 | 159 s 左右 |
| 181 秒时画面 | 黑屏，尚未验收桌面 |

181 秒累计：A4 调度片含内部设备约 117.5 秒，其中 IOP 约 33.4 秒、
设备定时器约 14.8 秒。LCD 扫描总共约 29.1 秒，其中部分已包含在定时器内，
**不能把嵌套计时相加**。NAND read_page 同步提交约 1.7 秒，独立 AES 对约 5 毫秒；
这些数字不代表客户机文件读取的全部时间。IOP、CPU 指令和调度等待才是主要候选。

A4 热点中 `0xe0a45396`、`0xe0a54396` 两种 UMLAL 已分别调用解释器约 7900 万次。
后续首先消除这些热点回退，再测 IOP 的执行和主核等待、重复扫描。
每次使用相同起始 NAND，记录代码提交、里程碑和实际桌面证据。

## Step 2：长乘法直接生成 Wasm

A32 和 T32 的 UMULL/UMLAL/SMULL/SMLAL/UMAAL 使用 i64 乘法与加法。
先读取全部源寄存器，再写入两个目标，保留重叠寄存器语义；设置标志时只更新 N/Z，
保留 C/V。非法 PC/SP 组合继续走原有解释器检查。

验证：新增 `qmul` 的 14 个 A32/T32 场景，与解释器及 QEMU 输出一致；
现有 q1/q3/q4 页面测试通过；种子 1 的 40 个随机程序无差异；N90 设备测试通过。
同起点 NAND 的 `boot-mul` 冷启动对比正在采集，尚不宣称整机加速比。

## Step 3：只在呈现器请求时扫描屏幕

初始采样每秒约 120 次全屏扫描：60 Hz 客户机垂直同步与呈现器取帧各一次。
CLCD 垂直同步只推进寄存器批次、完成标签和中断，像素转换留给正常取帧。
没有降低客户机刷新率，也没有改变客户机计时。这样可以消除约一半无用扫描；
具体整机收益仍以冷启动对比为准。

设备测试确认垂直同步继续完成命令和中断，不请求画面时不扫描，
之后取帧能看到期间的客户机内存写入，背光、休眠和快照恢复仍正常。
采样 Worker 增加主核请求休眠的累计时间和 IOP PC，帮助区分计算与调度等待。

## Step 4：ARM7 固件使用页面编译器

以前 ARM7 的每条指令都解释执行。现在它在相同指令预算和中断边界下，
可以执行已编译的算术与分支。MMU 关闭时仅允许独立 IOP bank 使用此路径，
数据访问仍由解释器处理，保持 Device 内存对齐异常、MMIO 和 NAND 语义。
IOP 重映射会丢弃旧的代码地址和链接缓存。

验证：合成固件实际执行了编译代码，主核 PC 未改变，IOP 快照还原后计数一致；
原始 10B329 IOP 使用编译代码打开干净的 YAFTL、发布分区，并通过设备快照往返。
完整冷启动将继续测量；不把页面编译通过等同于系统桌面验收。

## Step 5：主核等待不再让正在工作的 ARM7 睡眠

第二轮采样在进入用户态之前累计约 43 秒主核休眠请求。ARM7 若耗尽了当前执行预算，
说明它仍可运行；调度器现在继续执行它，而非等待 A4 的下次定时中断。
ARM7 遇到 WFI 或真实异步 NAND 请求时仍然让出执行；异步中断的上升沿会唤醒机器。
没有提高客户机时钟速率。原始 IOP 的干净 YAFTL、分区及快照测试通过，
设备测试覆盖待处理 I/O 让出执行、预算耗尽继续执行和中断只在新边沿唤醒。

另一次实际唤醒并滑动解锁后，在 `boot-mul/profile/woken.png` 确认了原生桌面。
此前黑屏最终包含了 LCD 休眠，不能仅凭串口停在某行判断启动卡死。
已从该机正常关闭宿主设备后保存实际写入的 NAND（2,037,685,760 字节的稀疏文件），
用于后续断电冷启动对比。它包含客户机自己完成的数据初始化，不包含任何内存快照。
测试页面支持 `cold` 命令：销毁旧 Worker 后从同一 OPFS NAND 创建新机器。

## Step 6：IOP RAM 访问缓存

初始化后断电的首轮测试中，IOP 在 211 秒内仍占约 108 秒，因此继续优化它的 RAM 读写。
新增独立的 IOP 编译模式，避免与允许非对齐访问的 A4 模板混用。
物理 RAM 映射可进入访问缓存；每次访问仍检查自然对齐，MMIO、只读区域、
受监视代码页及保留地址继续使用解释器。重映射仍使缓存失效。

验证：预热 RAM 缓存后，非对齐 LDR 仍进入 Data Abort；相同 LDR 读取 ARM7M 寄存器
仍获得设备值；重映射相同虚拟地址后，代码和数据都来自新物理页。
主核寄存器、IOP 快照往返、原始固件 YAFTL/分区/快照和 q1/q3/q4/qmul 页面测试通过。
使用同一份初始化后断电 NAND 的 `boot-iop-ram` 正在测量完整冷启动。

## Step 7：IOP 寄存器留在编译函数的局部变量中

IOP 的页面函数不再为每条算术指令反复读取、写回寄存器内存。
R0–R14 留在 Wasm 局部变量中；离开函数、跨页链接、单步或进入解释器辅助函数前写回，
辅助函数完成后重新读取，保留模式切换、异常和寄存器重叠语义。A4 的路径暂不改变。
IOP 合成固件（含已缓存的非对齐异常、MMIO、重映射和快照）及原始 YAFTL/分区/快照测试通过。

截至 Step 6 的同 NAND 对比：根分区 43.22 → 36.58 秒，FIPS 用户态完成约 172 秒，
安装服务 239 → 188 秒。完整 HFS 检查仍是大项，距离 120 秒目标还有差距。

## Step 8：Thumb IT 条件内存访问

文件系统检查中的条件读写此前使整段 IT 回退到解释器。
允许非 PC 目标的原生读写进入 IT 模板；访问前物化当前 ITSTATE，成功后清除，
缓存未命中或异常则保留该指令准确的 ITSTATE，交给原有异常路径。
不跳过 fsck，也不强改文件系统干净标志。

新增 qitmem：缓存命中、条件为假、第一/第二条访问异常、写异常及写回地址六种场景，
编译器与解释器一致；启用同一 MMU 映射后与 QEMU 一致。
此测试同时发现并修复 Data Abort 的 ISV=0 时 ESR.IL 位应为 1 的既有差异，
对照 QEMU 的 `syn_data_abort_no_iss`，未通过忽略异常字段来放宽测试。
q1/q3/q4/qmul 页面测试及 40 个随机程序无差异，原始 IOP 分区和快照测试通过。
