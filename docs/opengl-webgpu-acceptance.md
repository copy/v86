# OpenGL → WebGPU：C–G 验收记录

日期：2026-11-01。两个仓库均使用 `refactor`。C → D → E → F → G 已依次完成并分阶段提交；G2 十项程序矩阵和独立复测均已冻结。

## 范围与版本

C 的 CPU 权威状态/查询/校验/快照、D 的渲染语义与性能、E 的 GLSL/ARB 和链接验证、F 的客体传输/WGL/部署分别已有阶段提交。G 补齐整机验收、严格门禁、逐项行为覆盖及文档；整机测试发现的“恢复显示未完成下一帧”已在 G1 修复。

| 阶段 | v86 完成提交 | 站点完成提交 |
| --- | --- | --- |
| C | `11e56e2c` | `d2d09c7` |
| D | `545c84eb` | `4aee505` |
| E | `7b870427` | `9181b66` |
| F6 | `0ff5b150` | `e0b52c0` |
| G1 | `173d7cf3` | `8d4aec7` |

宿主资源版本为 `8523858ab36865e264c6`。G 不改变客体 DLL/SYS：代理 SHA256 为 `4bffb949270e19d263289e46bbc01cb8eae49fe048e13260d06e0625cabdd71f`，驱动为 `57c47879bdc28c95352c259df2b441904a82dac36ebc33671d3f238cee68177d`。XP、Cube 2、Warcraft III 使用 F6 已安装的本地镜像；G 的程序安装与写盘均留在运行期覆盖中。F6 原镜像备份及系统 OpenGL 文件保护记录见[部署清单](../../retro-gaming-site/glbridge/deployments/opengl-webgpu-F6.json)。

## 门禁

- 115 组核心 Node、55 个真实 GPU 页面、9 组共享 GLES 回归通过（完整 `make gles-tests` 目标）。GLES 的随附语料为 7/7；原始记录另有一份 Naga 不支持的 SPIR-V 阶段（`stage_unsupported=1`），未计为代码生成成功；本地未安装完整 dEQP APK，不宣称完整 dEQP 通过。
- 94 组通过的行为测试在运行时实际解码/派发全部 257 个协议记录。[覆盖清单](../src/browser/glbridge/gl-webgpu/COVERAGE.md)逐项链接测试，[原始观测](../tests/glbridge/gl_behavior_coverage.json)保留记录与测试的对应关系。这证明记录有行为覆盖，不代表每个参数分支均已穷尽。
- 一次完整 `node tests/glbridge/mutations.mjs` 返回 0：44 族、802 个有效变异、杀死 792 个（98.75%）；每族达到原门槛。10 个幸存变异逐项保留在[门禁日志](../tests/glbridge/acceptance/mutation-gate.log)，不计为已杀死。
- 失效/重复锚点、非法 JavaScript、未知/空选择、未修改代码自身失败、基础设施超时均使门禁失败。检测器提示只改变执行顺序；提示未杀死时仍执行其他合格测试。[摘要与源哈希](../tests/glbridge/acceptance/mutation-gate.json)固定了本轮输入。

## 整机方法

每个程序分别冷启动 XP 的本地与 CPU worker 模式。达到真实场景条件后停止 CPU、等待 GPU、刷新停止状态的 VGA 扫描输出，保存完整 CPU/RAM/设备/磁盘覆盖/图形的 stream-v9 状态。销毁旧 VM，创建新 VM 冷恢复，不推进客体时间，比较整个合成桌面的 RGBA SHA256，随后继续 64 个帧间隔。

每项还从同一份整机存档依次执行候选/F6/F6/候选四次测量，各丢弃 21 个预热帧、采样 64 个间隔。F6 基准来自站点 `e0b52c0` 的实际发布资源（`6a5eb14d73549ecd56fe`），CPU 与客体二进制相同。测量串行执行；若同时执行变异门禁，只暂停调用方明确指定的该测试进程，并等待已经启动的子测试结束。功能调用统计在测量前关闭。

帧间隔是整机墙钟时间，包含客体 CPU、传输和刷新等待；执行器 CPU 时间测量宿主同步 submit/swap，不包含异步 GPU 执行时长。表中的值是两次测量中位数的平均值，所有原始样本均保留。此处是 **G 相对 F6** 的整机比较，不能当成 C 之前的整机基准。D5 的独立实际游戏轨迹测量另见[原始记录](../tests/glbridge/performance/game_traces_20261031.json)。

最后恢复候选原始时间线、结束第一个程序，验证旧 GL 上下文全部释放，在同一 VM 启动第二个实际程序并要求新增绘制和纹理上传。WineD3D 后运行 Cube 2，其余程序后运行 WineD3D。

十项均通过；下表时间单位为 ms，箭头从 F6 指向最终候选。完整恢复像素、上下文、64 个帧间隔、退出后第二程序及零拒绝/错误均由[冻结矩阵](../tests/glbridge/acceptance/application-matrix.json)和各项 JSON/日志核对。

| 程序 | CPU 模式 | 整机/连续运行/进程切换 | 帧间隔 | 执行器同步入口累计 |
| --- | --- | --- | --- | --- |
| GLView 2.6.0 | 本地 | 通过 | 16.68 → 16.66 | 0.45 → 0.46 |
| GLView 2.6.0 | worker | 通过 | 16.67 → 16.65 | 0.54 → 0.56 |
| Warcraft III | 本地 | 通过 | 133.38 → 133.54 | 23.25 → 23.50 |
| Warcraft III | worker | 通过 | 133.79 → 133.88 | 28.66 → 29.18 |
| Cube 2 | 本地 | 通过 | 46.05 → 46.81 | 18.58 → 18.77 |
| Cube 2 | worker | 通过 | 60.25 → 59.22 | 17.57 → 16.99 |
| Tremulous GPP1 (Quake 3 engine) | 本地 | 通过 | 33.34 → 33.35 | 5.20 → 5.32 |
| Tremulous GPP1 (Quake 3 engine) | worker | 通过 | 34.47 → 34.52 | 6.77 → 6.84 |
| WineD3D 1.7.52 / D3D8 cube | 本地 | 通过 | 49.99 → 49.98 | 0.74 → 0.77 |
| WineD3D 1.7.52 / D3D8 cube | worker | 通过 | 58.17 → 57.97 | 1.00 → 0.95 |

Quake 3 引擎 worker 的[首轮](../tests/glbridge/acceptance/quake3-worker-first.json)为候选 49.60ms、F6 33.95ms；独立冷启动[复测](../tests/glbridge/acceptance/gl-final-quake3-worker.json)为 34.52ms、34.47ms，执行器同步时间也接近。首轮差异未稳定复现，原因尚未确定；两轮全部样本都保留，性能结论限于这些本机测量。

[最终复现 CD 输入](../tests/glbridge/acceptance/application-inputs.json)和[原包/随附源码哈希](../tests/glbridge/acceptance/package-provenance.json)固定了重放所需文件。早期单项运行的 CD 中还曾含无关的 Q3 demo 文件；当前清单提供最终复现输入，不宣称十次运行使用逐字节相同的整张 CD。各程序实际使用的代理、程序文件和镜像来源保持匹配。

## 程序与输入的边界

**GLView 2.6.0。** 使用[作者当前发布的 2.6.0 包](https://www.realtech-vr.com/glview-download/)，EXE/DLL 未改。其外部 GLSL 1.10 `simple.vert`/`simple.frag` 的 `main` 尾部各多一个分号；原始文本同时被 Apple OpenGL 与 glslang 拒绝，应用随后在 `infogl.dll` 崩溃。测试 CD 副本仅各移除这一个分号，原下载保留；[原始/修正哈希及两编译器结果](../tests/glbridge/acceptance/glview-package.json)可核对。未绕过编译检查。

程序矩阵覆盖 GLView 实际窗口渲染、着色器初始化、整机冷恢复、持续帧及退出后运行另一个程序。固定管线、ARB、显示列表与拾取的精确行为另由[双原生参照测试](../tests/glbridge/gl_conformance/README.md)和 GPU/CPU 测试覆盖；不把此程序冒烟结果写成每个内置复选框全部通过。

**Quake 3 引擎。** 原版 Q3ADemo 1.11 实际触发模板阴影与武器深度范围，但其眩光表面提交为空，不能用 `r_flares 1` 证明深度读回。[原版 `RB_SurfaceFlare`](https://github.com/id-Software/Quake-III-Arena/blob/master/code/renderer/tr_surface.c)的实现被 `#if 0` 禁用；[眩光测试](https://github.com/id-Software/Quake-III-Arena/blob/master/code/renderer/tr_flares.c)才会调用深度 ReadPixels。

最终选用未改动的 Tremulous GPP1 引擎/SDL，基础包和 GPP 来自[官方发布目录](https://sourceforge.net/projects/tremulous/files/tremulous/)。安装包随附的 `src/renderer/tr_surface.c` 中 GPP 的 `RB_SurfaceFlare` 实际调用 `RB_AddFlare`。原装 ATCS 没有眩光表面，因此[确定性测试场景生成器](../tools/gl_q3_scene.mjs)将人类基地附近的一个平面表面记录改为有效 BSP flare，放入单独的 `zz-gl-acceptance.pk3`；其余 BSP 字节、碰撞、叶归属及原包不变。GPP 的 `setviewpos x y z yaw` 把相机移到该位置。测试地图变体、引擎和输入文件的哈希保留在输入清单中；这不是未经修改原地图的覆盖宣称。

该项严格要求真实深度 ReadPixels、模板启用，以及 `[0,0.3]` 武器深度范围。计划原文的 `gl_ztrick` 不是 Quake 3 的变量，应改为实际武器 depth hack；原版[渲染后端](https://github.com/id-Software/Quake-III-Arena/blob/master/code/renderer/tr_backend.c)也可核对。反向 `glDepthRange(n>f)` 由专门的双原生/GPU 精确像素用例验证，不伪称这个游戏执行了该调用。

**WineD3D。** 使用 WineD3D for Windows 1.7.52 的 `d3d8.dll`/`wined3d.dll`/`libwine.dll`，运行站点已有的纹理立方体 D3D8 程序，经客体 WineD3D 生成实际 OpenGL 调用。加载目录内放置代理，保留 Windows 系统 OpenGL。它验证这条真实翻译链，不代表所有 WineD3D 游戏都通过。

## 保留差异与复现

[执行器 README](../src/browser/glbridge/gl-webgpu/README.md)是当前偏差清单。低位格式写精度、平滑、显式纹理边框、精确遮挡样本数、BC 原生存储 mip 生成、部分 WGL 能力等限制仍有对应测试，不归入原生一致通过项。早期审查正文保留历史，当前结果应读本记录和计划各阶段的最终退出说明。

```sh
make test-glbridge
make glbridge-gpu-tests
make gles-tests
node tools/gl_behavior_coverage.cjs
node tools/gen_gl_coverage.cjs
node tests/glbridge/mutations.mjs --audit
node tests/glbridge/mutations.mjs
node tools/gl_final_acceptance.mjs
node tools/gl_final_matrix.mjs --resume
node tools/gl_final_report.mjs
```

程序矩阵需要 F6 本地镜像、许可允许的 Warcraft III/Cube 2 文件及 `build/gl-acceptance-assets` 中记录哈希的原包；大型程序、镜像、完整存档和截图不加入仓库。冻结清单保留截图路径/摘要，原文件留在本机 `build/browser-test-output`。所有变化仅提交本地 `refactor`，未推送或发布远端存储。
