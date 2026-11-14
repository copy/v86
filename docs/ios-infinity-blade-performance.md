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

预检已通过；实际安装和启动、动态场景帧率尚待验证。此处不声称已达到 60 fps。
