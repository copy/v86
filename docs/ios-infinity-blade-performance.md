# Infinity Blade 安装与帧率验证

## 测试输入（2026-11-14）

机主本地提供 `Infinity_Blade_1.4.3_ios_6.0.ipa`。原包只读，
IPA、游戏资源、固件、NAND 和运行截图均不提交仓库。

| 项目 | 检查结果 |
| --- | --- |
| 原包 SHA-256 | `42c204a602db8d5fb47dae412ed9e740d9cb35f30cd07f4342221855a5d31f31` |
| 原包大小 | 610,558,492 bytes |
| ZIP 成员 / 展开大小 | 645 / 988,023,533 bytes |
| Bundle / 版本 / build | `com.chairentertainment.birthright` / 1.4.3 / 7982.136 |
| 主程序 | `Payload/SwordGame.app/SwordGame`，ARMv7，`cryptid=0` |
| 最低系统 / 设备能力 | iOS 6.0 / `armv7`, `opengles-2` |
| 完整检查 | 所有成员 CRC、路径、符号链接、Mach-O 和整包摘要校验通过 |

安装器原来误拒绝 ZIP 中合法的空 `Payload/` 目录。已允许空的目录项，
继续拒绝有内容的目录项、伪装为目录的普通文件，以及其他 Payload 同级应用。
验证：`node tests/ios/ipa.mjs`，10 项通过。

## 帧率目标与计数口径

目标是可交互的动态游戏场景达到 60 fps。浏览器的刷新率、LCD/VBL 中断频率、
桌面合成频率和模拟 CPU 的 MIPS 都不能替代游戏帧率。
只有安装成功及启动请求成功，也不能判定游戏运行成功。

完整解析原包 `CookedIPhone/Coalesced_INT.bin` 后，
`IPhone-SwordEngine.ini` 的 `Engine.Engine` 配置为：

```ini
bSmoothFrameRate=TRUE
MinSmoothedFrameRate=20
MaxSmoothedFrameRate=35
```

`SystemSettingsIPhone4` 的 `MobileContentScaleFactor=2.0`。
这些是静态配置证据；是否在真机分支被其他运行时设置覆盖，需要实际运行验证。
先测试原包，再决定是否在独立副本中调整限帧设置；不能只修改上限就宣布达到 60 fps。

## 本地测试环境

使用正式控制台的 Install IPA 对话框、准备 Worker、CPU Worker、
原生 MobileInstallation 和持久 OPFS NAND。测试盘来自已正常关机的独立 NAND 副本，
不操作机主原有虚拟机。测试产物在忽略的 `build/ios/infinity-blade/`。

```sh
BROWSER_FOCUS=1 TEST_ARTIFACT_DIR=build/ios/infinity-blade/acceptance \
  BROWSER_DEBUG_PORT=9490 TIMEOUT_MS=7200000 \
  node tests/app/browser_runner.mjs tests/ios/ui-install.html \
  isolated=1 webgpu=1 autoplay=1 probe=build/ios/infinity-blade
```

大文件通过 CDP `DOM.setFileInputFiles` 选择本地原包，仍由真实文件输入框触发检查及安装，
避免测试脚本额外构造一个 582 MiB 的内存副本。

## 验收状态

| 验收项 | 本轮结果 |
| --- | --- |
| 真实 UI 安装 | **通过**。MobileInstallation 完成，原生回查版本 1.4.3 和主程序代码摘要一致 |
| 真实 UI 打开 | **请求被接受**。创建 `SwordGame`（pid 107），GLI 创建 context 37，原生屏幕显示 Unreal 启动画面 |
| 进入动态游戏 / 可交互场景 | **失败**。首次加载触发媒体服务线程中的内核 panic |
| 游戏 FPS / 60 fps 目标 | **无法测量 / 未通过**，不能把启动画面或浏览器刷新计为游戏帧率 |
| 原包完整性 | 测试后 SHA-256 与测试前一致 |

本轮旧核心的时间线，从测试页面加载起计（包含盘复制、启动和人工操作间隔，
不是冷启动成绩或游戏加载成绩）：

| 事件 | 时间 |
| --- | ---: |
| 开始向原生助手传输 | 195 s |
| 613,364,632 bytes 传输完成 | 1081 s |
| 原生 SHA-256 校验完成、staged | 1154 s |
| 再次校验后调用原生安装器 | 1228 s |
| 原生版本 / 代码摘要回查通过 | 1502 s |
| UI 点击 Open application | 1504 s |
| 原生启动请求接受 | 1508 s |

### 首次运行的确定性阻塞

串口报告：

```text
panic(cpu 0 caller 0x8008ce28): kernel abort type 4:
fault_type=0x3, fault_addr=0xd2f048f0
pc: 0x807fc1cc
Task ... pid 42: mediaserverd
```

通过正在运行的客户机页表核对，故障 VA `0xd2f048f0` 映射到物理地址
`0x841008f0`。10B329 原始 DeviceTree 的 `/arm-io/amc` 声明了
`0x84100000+0x3000`、`0x84000000+0x40000`、`0x84300000+0x5000` 三个银行；
故障 PC 位于预链接的 `com.apple.driver.AppleAMC_r2` 176.0.0
（`0x807f5000+0x79000`）。本轮 CPU 的 MMIO 表没有覆盖该地址，N90 设备构造器也没有 AMC。
这是已定位的音频硬件缺口，不能作为 IPA 签名失败或纯 GPU 性能问题处理。

GLES 累计 draw 数停在 127，命令拒绝和着色器编译错误均为 0；这些主要是系统/UI
启动画面的绘制，**127 不是 FPS**。在解决 AMC 访问、验证音频解码路线和重新进入动态
游戏前，不应发布游戏帧率结论，也不应只填充零寄存器或伪造音频任务完成来宣称通过。

后续顺序：验证 AMC 的寄存器、任务队列与完成中断，或通过原生软件解码路线完成兼容性
验证；通过正常游戏场景后，再加入应用实际 present 的帧时间采样、检查限帧设置，
区分 CPU、GPU 和 IOSurface 回读成本并做 A/B。60 fps 仍是未达成的目标。

### 保留的本地产物

`build/ios/infinity-blade/` 保留了预检、指令采样、原生进程状态、完整串口 panic、
`acceptance/launch-*.png`、`acceptance/launch-samples.json` 和 `result.json`。
已安装的独立测试盘另存为 `installed-after-panic.packed`，大小 4,000,751,104 bytes；
关闭虚拟机后分块导出、合并并记录 SHA-256，避免丢失这次大包安装成果。
此盘经历内核 panic 后的强制断电，下一次需要正常文件系统恢复，不能用来冒充干净关机的
冷启动性能样本。原有机主虚拟机和 Downloads 原包均未修改。

## 已定位的 CPU 开销

第一次大包上传时，指令采样发现 A32 的 `0xe8906ff0` 和 `0xe8806ff0`
各执行了超过 3200 万次 helper。这是包含 SP 的 LDM/STM 数据寄存器列表，
属于合法 A32 指令，JIT 原先过度保守地拒绝整个列表。现允许 A32 的 SP 参与批量搬运；
保留 T32 的限制、基址重叠检查，以及未对齐/跨页/非 RAM 的原有回退路径。

新增 `qspcopy` 的 10 个案例覆盖 IA/IB/DA/DB、写回、单独 SP 和条件不成立。
解释器及启用 MMU 的 JIT 均与 QEMU 一致；JIT 循环的总 helper 数为 9。
原有 10 组 A32/T32 回归通过，40 个随机程序、每个 100 个构造运行 32 轮，差异为 0。
主核心与 fallback 均已构建。当前测试 VM 的核心在改动前已载入，因此上述首次运行结果
仍来自旧核心；本轮没有对新核心做游戏帧率 A/B，不声称它已提高游戏 FPS。

## AMC 兼容性续作（2026-11-14）

以下改变已经分别验证并提交；上面的失败记录保留为首次测试基线。

| 步骤 | 提交 | 实际改变 / 验证 |
| --- | --- | --- |
| DMA 停止握手 | `dc23b2b0` | 返回停止确认，保留未传输数据；不伪造成功完成 |
| AMC 控制和 SRAM | `e432c6f8`, `5ed4b804` | 映射三个 DT 窗口，引擎复位状态、屏蔽/应答、旧快照默认状态，正式 Worker 构建通过 |
| DMA 复位游标 | `d1dc5265` | 复位后保留 MAR/描述符，避免原生 abort 路径解引用零游标 |
| 真实 AAC 后端 | `d394ef5c` | 用 WebCodecs 解压自生成双声道测试音；检查非零能量、幅值、声道频率和输出帧数 |
| AMC 输入/输出队列 | `880aa904` | 有界链表遍历、AAC 原生参数、逐帧输出、S24-in-S32 打包、engine-0/CDMA 有序交付；循环链表走错误路径 |
| I2S PCM 传输 | `0b563f54` | 按 PMGR bit clock / 64 和客户机单调时间搬运原生 PCM，更新 DMA 游标，音频中断送 AP；正式控制台启用扬声器 |
| AMC 汇总中断 | `7bb39907` | 内部完成位通过控制器汇总输出，避免把内部 bit 编号误当 VIC 引脚 |

已通过的针对性验证：

```sh
node tests/ios/amc.mjs
node tests/ios/cdma-pause.mjs
node tests/ios/i2s-pcm.mjs
node tests/ios/devices.mjs
node tests/app/vm_config.mjs
node tests/app/browser_runner.mjs tests/ios/amc-decoder.html
node tests/app/browser_runner.mjs tests/ios/amc-codec.html
make app
```

AAC fixture 是自行生成的 44.1 kHz 双声道正弦音（左 1000 Hz、右 1500 Hz），
没有游戏或固件资源。集成测试使用真实浏览器解码，验证一个 1024 帧 AAC 输出经 AMC
本地缓冲、engine-0 列表及 CDMA 写入 DRAM 的 8192 bytes S24-in-S32；完成通知晚于真实
数据交付。I2S 测试在 10 ms 客户机时间内仅消费 441 个立体声帧，5 ms 时不提前报告完成。

开发阶段的原生输入已实际解出 22 个 AAC 帧（45,056 个声道样本），确认单个压缩输入 DMA
会包含多个音频帧，输出环需要逐帧推进。该次含临时诊断的运行不作为正式验收；
新的完整正式构建正在从持久安装盘冷启复测。**目前仍未验收可游玩场景或 60 fps。**

实现是已观测到的 10B329 AAC 程序的 HLE，不是通用 DSP 指令仿真；未知程序不制造静音
成功结果。带有未释放解码器的 AMC 状态暂不保存 RAM 快照，避免丢失解码历史后恢复错误
音频；NAND 持久数据与此不同。原生 PCM 交付、可听播放和游戏场景需要分别验证。

寄存器、链表和输出打包的参考为公开的
[AMC 模型](https://github.com/samhenrigold/qemu-ios/blob/main/hw/arm/ipod_touch_amc.c) 与
[A4 CDMA 模型](https://github.com/samhenrigold/qemu-ios/blob/main/hw/arm/s5l8930_cdma.c)，
并用机主提供的 10B329 驱动实际访问复核；新实现及生成音频测试位于本仓库。

### 正式构建的原生 AAC 验证

重新从已安装 NAND 冷启动后，通过控制台 Install IPA → Open application 启动游戏；
第一次请求时桌面尚未准备完毕，后续在解锁后的 UI 重试成功。游戏显示了原生推送通知
提示，关闭后开始播放启动电影。未使用内存快照或临时设备覆盖。

运行采样中 AMC 累计处理 77 个压缩输入、3,397,632 个声道样本，向原生 DRAM 交付
13,574,144 bytes PCM，I2S 消费 2,501,689 个立体声帧；错误数 0、完成中断均已应答。
这验证了 AAC 多帧队列、CDMA、汇总中断和原生音频消费持续前进。浏览器中的可听音质
尚未独立录音验收。启动电影目前显示 QuickTime 占位画面，继续检查电影结束后的游戏
场景；这不是可游玩或帧率通过的证据。

本地证据保存在 `build/ios/infinity-amc/` 的 `native-audio-success.json` 和
`acceptance/amc-running.png`、`after-push.png`，不提交游戏资源或持久盘。
