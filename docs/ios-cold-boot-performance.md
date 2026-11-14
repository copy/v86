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
