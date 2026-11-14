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
