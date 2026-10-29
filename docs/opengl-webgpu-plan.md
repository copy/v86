# OpenGL 代理 → WebGPU 修复计划

依据：[`opengl-webgpu-review.md`](opengl-webgpu-review.md)（下文称“审查”，问题编号 S1-x、S2-x 均指它）。
基线：v86 `e92fd4f0`（`ios6`），retro-gaming-site `43c4d1e`。日期 2026-10-29。
状态：计划，尚未开始；本文尚未提交。

## 0. 已定的决定（2026-10-29）

1. **状态归属：CPU 侧权威**（审查 §7 阶段 3 的选项 b）。权威 GL 状态机、错误、对象、GLSL 编译链接信息和 uniform 位置都放在 CPU 一侧（CPU worker 模式下在 worker 里，本地模式下在页面里，都在设备旁边）。页面执行器只负责渲染，从不同步回答。这与 GLES 路径的架构一致。
2. **一个计划做完所有修复。** 不先上 worker 模式的最小修复。S1-1 由阶段 C 的架构改动从结构上解决。
3. **同意下载 Mesa** 作为第二参照。用法见阶段 A2 和 §5。
4. **GLSL 前端：分两步。** 第一步，glslang 负责检查与反射，确定要做；第二步，代码生成是否也换成 glslang，由阶段 E0 的试验决定（你于 2026-10-29 确认）。理由和门槛见 §0.1。

### 0.1 GLSL 前端：两步方案（已确认）

**分两步。第一步确定要做，第二步先做一个不超过 1 周的验证再定。**

**第一步：用 glslang 做 GLSL 1.10/1.20 的检查和反射（确定要做）。**

- 决定 1 要求 CPU 侧同步回答编译状态、链接状态、信息日志、活动 uniform/attribute 和位置。这需要一个真正的 GLSL 前端跑在 CPU 侧。glslang 已经以 `bios/glslang.wasm` 的形式在 GLES 的 CPU 侧插件里同步运行（`src/gles/glslang.js`）。
- 我刚才在本机验证过。做法：用 GLES 工作时已下载的 glslang 16.6.0 源码，在 scratchpad 里原生编译出 `glslangValidator`，不改仓库。结果：
  - **未打补丁的 glslang 按桌面 GL 规则接受典型的 1.20 兼容 profile 着色器：** `ftransform()`、`gl_ModelViewMatrix`、`gl_NormalMatrix`、`gl_LightSource[0]`、`gl_Fog`、`gl_TexCoord[0]`、`gl_FrontColor`、`gl_FogFragCoord`、`texture2D`，以及 1.20 的隐式 int→float。
  - **没有 `#version` 的着色器**需要把默认版本设为 110。glslang 默认是 ES 100，所以会报 `ftransform` 不存在。接口里传 `defaultVersion = 110, ENoProfile` 即可。
- 它替代现有手写前端的“检查”角色。审查 S2-41（拒绝合法 GLSL）、S2-42（单阶段程序、多着色器对象）、S2-44/S2-45 的反射部分都由此解决，而且信息日志和错误位置与真实驱动一致。
- `v86_glslang.cpp` 需要加一个桌面入口：`EShClientNone`、默认版本 110、桌面资源限制。

**第二步：代码生成改为 glslang → SPIR-V → vx_naga，先做验证（阶段 E0）。**

- glslang 不能直接把 1.10/1.20 生成 SPIR-V。我验证到的情况：
  - Vulkan relaxed 规则（GLES 用的那条路）对桌面着色器要求 `#version 140` 以上，并且拒绝 compatibility profile（“compilation for SPIR-V does not support the compatibility profile”）；
  - OpenGL SPIR-V 目标（`-G`）在这一版里连内建函数都解析不了。
- **但只要把旧式内建降级掉，这条路就通。** 我把同一对着色器手工改写到 `#version 140`：状态 uniform 合进一个块，`gl_Vertex` 等改成显式 `in`，`gl_TexCoord`/`gl_FrontColor` 改成显式 `out`，`texture2D` 改成 `texture`。结果：
  - glslang（Vulkan relaxed、自动分配绑定和位置）两个阶段都生成了 SPIR-V；
  - 顶点阶段经 stock naga 得到 77 行 WGSL；
  - 片段阶段在 stock naga 上只卡在组合图像采样器，仓库的 GLES 路径已经在 naga 读取 SPIR-V 之前把它拆开（`src/gles/spirv_patch.js`、vx_naga，偏差 G-35）。
- 验证要回答的是：旧式内建的降级放在哪里做。
  - **(i) 给 glslang 打补丁**，与 `es_spirv.patch` 同类：在 relaxed 规则下放开桌面 <140 的版本门槛，并保留旧式内建，让它们落到默认 uniform 块和自动分配的位置上。
  - **(ii) 在 `v86_glslang.cpp` 里做一个 AST 级的降级**：解析之后，把旧式内建替换成显式声明，再交给 SPIR-V 后端。
  - 文本级替换（`#define`）不采用：它碰到宏、重名和 `gl_` 保留名时都很脆弱。
- **我倾向切换。** 理由：
  - 手写翻译器的 bug 是成类的：WGSL 保留字、uniform 与局部变量共用类型、Tint 拒绝的常量折叠（S2-40）。glslang + naga 从结构上消除这些问题；
  - GLES 3.x 已经在同一条管线上跑出 dEQP 99%+，那些 naga 修复（G-49 等）可以直接共用；
  - 整个项目只维护一套 GLSL 工具链；
  - CPU 侧本来就要跑 glslang（第一步），生成 SPIR-V 只是多一个阶段。
- **切换的门槛**（阶段 E0 的退出条件）：
  - Cube 2 语料和新的 GLSL 1.20 语料全部生成 Tint 接受的 WGSL；
  - 像素测试通过；
  - 单个着色器的编译时间在预算内（与 GLES 实测同量级）。
- **不过门槛时**保留手写翻译器只做代码生成，并在它里面修 S2-40（统一的标识符改名、uniform 与局部类型分离、常量折叠规则）。第一步照样做。
- **ARB 程序不受影响：** glslang 不处理 ARB 汇编，`gl_arb_program.js` 留下并修复（阶段 E2）。

## 1. 目标与完成标准

- **两种模式行为一致：** 站点默认的 CPU worker 模式与本地模式对同一命令流给出同样的答案和像素。
- **审查中所有 S1、S2 关闭。** S3 关闭，或者作为偏差登记进恢复后的偏差清单，并配一个测试。
- **验收：**
  - 参照场景在 Apple OpenGL 和 Mesa llvmpipe 两个参照下全部通过，登记的偏差除外；
  - 状态查询一致性测试（dEQP `state_query` 风格）两种模式下全过；
  - 变异实验扩到 ≥ 40 个变异，杀死率 ≥ 90%；
  - 217 个 opcode 每个至少被一个行为测试解码；
  - 客体内验收程序全部通过（阶段 G）。
- **文档：** 偏差清单恢复并与代码一致；`COVERAGE.md` 的 A 类必须有测试。

## 2. 目标架构

```text
game.exe
  └─ opengl32.dll（薄编码器）
       · WGL、线程与当前上下文、客户端内存拷贝（数组、像素、显示列表编译时取值）、批处理、分带上传
       · 不保存 GL 状态影子，不在本地回答 glGet
       │ VGL2 记录（由 gl_protocol.json 生成）
       ▼
  v86gl.sys（带进程会话：每个打开者一个会话号，句柄关闭时发会话结束）
       ▼
  CPU 侧：v86gl_device.js → gl_shadow（新，JS 插件，权威）
       · 全部 GL 2.1 状态、校验与 GL 错误、对象与名字（按进程会话 × 共享组）
       · 所有 glGet*、GLSL 编译/链接/反射（glslang）、ARB 程序解析与校验
       · 显示列表、glPushAttrib、GL_SELECT/GL_FEEDBACK（软件变换与裁剪）、求值器、光栅位置
       · 答案在 IOCTL 返回前直接写进客体内存
       │ 只转发被接受的命令（解析后的、带确定默认值的）
       ▼
  页面：gl_executor.js（纯渲染器）→ WebGPU
       · 不设 GL 错误、不同步回答
       · 只有 ReadPixels、查询结果、Finish、渲染结果的读回需要等它：
         异步状态字 + writeGuestMemory + 以心跳为准的期限
```

原则：

- **每块状态只有一个所有者。** 应用能观察到的一切归影子；像素和 GPU 对象归页面。两边处理同一个已校验的命令流，所以页面的渲染状态由构造保证与影子一致，而不是靠各自实现同样的规则。
- **页面上的异常就是宿主 bug。** 记录日志，按帧隔离，不粘滞，不变成 GL 错误。
- **两种模式同一份代码。** 影子跑在设备所在的线程。
- **存档改为“影子序列化 + GPU 资源读回”，** 与 GLES 的 E5 相同，GL 不再重放日志。
- **与 GLES 复用：**
  - 插件骨架（`src/gles/plugin.js`）；
  - glslang 的加载与接口；
  - 名字表；
  - 批处理通道；
  - 快照机制；
  - GLES1 的固定管线状态（`gles1_state.js`），作为桌面固定管线状态的基础。
- **与 D3D 共用阶段 B 的宿主层。**

## 3. 阶段

关键路径：A → B → C → D → G。E 与 D 并行，F 在 C 之后与 D、E 并行。合计约 17–22 周。

### 阶段 A：验收底座（约 2–3 周）

- **目标：** 审查里的每个已知问题都先变成一个会失败的测试，后续每一步都用它衡量。
- **A1 参照场景入库。**
  - 把参照原型（共享笔记目录 `gl-review/oracle/`）移进 `tests/glbridge/gl_conformance/`：`scenes.js`、`to_stream.js`、`compare.js`、页面和 runner。
  - 提交 Apple 生成的金像。Linux/Windows 的 CI 只比较金像，不需要 Apple GL。
  - 加一张已知失败表，每项写审查编号，修一个删一个。
  - 把场景扩到覆盖审查里所有像素可见的问题（目前 54 个场景，32 个失败）。
- **A2 Mesa 参照。**
  - 在仓库已有的 Alpine aarch64 虚拟机里装 Mesa（llvmpipe），用 `tools/alpine_repo.mjs` 取包：`mesa-egl`、`mesa-gl`、`mesa-dri-gallium`（下载已同意）。
  - 把参照程序的 C 运行时从 CGL 换成 EGL surfaceless + 桌面 GL 2.1 兼容上下文。场景生成器不变。
  - 用 Mesa 再生成一套金像。Apple 与 Mesa 不一致的地方按规范条款裁决，并在场景里写明依据。
  - Linux CI 用发行版的 Mesa 包，可以在 CI 里重新生成金像。
- **A3 测试基础设施。**
  - 校验型 mock GPU：把绘制路径审查员在 Chrome 上确认的规则表放进 `gl_fake_gpu.js`；
  - CI 安装 naga，缺了就失败；
  - 每个像素页都在 error scope 下运行，任何校验错误都算失败；
  - 修正审查 §6.2 列出的 5 个断言错误的测试；
  - `run.cjs` 要求每个文件打印通过总结。
- **A4 客体 ABI 测试台（L1）。**
  - 把 `opengl32_proxy.c` 在本机对着一个小的 `windows.h`/`DeviceIoControl` 垫片编译（`gl_diagnostic_buffer_test.js` 已经这样编译过诊断写入器）；
  - 它的批处理喂给真实的设备、影子和执行器。阶段 F 重写客体时靠它回归。
- **A5 两种模式、多进程、异常隔离的测试。**
  - 每条需要答案的命令都在本地模式和 worker 模式各跑一次，worker 通道用真实的，不打桩；
  - 两个客体进程先后运行、被杀进程之后再运行；
  - 宿主异常之后传输仍可用。
- **A6 常驻门槛。**
  - 变异脚本进 CI；
  - opcode 覆盖计数进 CI，白名单逐步缩到 0。
- **A7 真实程序轨迹。** 在客体里用诊断 DLL 录 GLView 2.6.0、Warcraft III、Cube 2 的短轨迹和 opcode 直方图，作为 L5 回放资产。
- **风险：** 低。A2 依赖 Alpine 虚拟机能跑 llvmpipe（aarch64 上是常规配置）。
- **退出条件：** 已知问题都以失败用例的形式出现在已知失败表里，CI 运行全部层。

### 阶段 B：共用宿主层（约 1–2 周，与 D3D 一起做）

- **目标：** 错误可见、失败不粘滞、设备丢失可恢复。这些在 GL 和 D3D 两条路径上是同一份代码。
- **内容：**
  - **错误捕获：** 管线、bind group、着色器模块创建都包在 error scope 里，失败的对象不进缓存；设备注册 `uncapturederror`，按条去重上报；测试模式下任何校验错误都让测试失败。
  - **失败策略：** 每条命令一个隔离边界，宿主异常记录后继续执行同一批的其余命令；`setAvailable(false)` 只用于设备真正丢失；没有粘滞的 `failed` 标志。
  - **资源注册表：** 所有延迟创建的 GPU 对象都登记在一个所有者下，设备丢失和重置时统一重建。这是审查 S1-5 的基础设施，GL 的使用在阶段 D。
  - **WebGPU 工具层：** 从 GL 与 D3D9 执行器中抽出共用部分：格式转换、DXT、mip 生成、读回、遮挡查询、按绑定维度的回退纹理（2D/cube/3D/depth）、上传 ring。
- **修复：** S1-2 的检测部分、S1-3 的宿主部分；D3D 的 S1-1、S1-4 也同时受益。
- **风险：** 中，D3D 和 GL 一起回归。
- **验证：** 阶段 A 的异常隔离测试；D3D 的真 GPU 页面。

### 阶段 C：协议与 CPU 侧影子（本计划核心，约 5–7 周）

- **目标：** 实现决定 1。同步答案在两种模式下都正确，而且不必等页面。
- **C1 协议单一来源。**
  - 恢复 `gl_protocol.json`（站点 `8bcd2f7^` 里有最后一版），放进 v86 作为唯一来源；
  - 由它生成客体 C 结构、`gl_opcode_names.h`、`gl_wire.js`、`gl_constants.js` 和测试编码器；
  - 测试审查员的 60 行检查器在生成器落地之前先进 CI。
- **C2 进程会话。**
  - `v86gl.sys` 给每个打开设备的进程一个会话号，随每个批处理发送；句柄关闭时发会话结束。驱动现在只处理 `IRP_MJ_CREATE`/`IRP_MJ_CLOSE`（`v86gl_driver.c:57, 345`），进程被杀时内核也会关闭它的句柄，所以在这里发会话结束即可覆盖崩溃的情况；
  - 影子里的上下文、共享组、对象、程序都以“会话 × 客体编号”为键；
  - 这同时解决 D3D 的 S1-10（从不发 `SESSION_END`）。
- **C3 `gl_shadow`（CPU 侧 JS 插件）。**
  - 完整的 GL 2.1 状态表与按规范的校验和 GL 错误；
  - 所有 `glGet*`、`glIs*`、对象生命周期（程序和着色器延迟删除）、名字分配（不与应用自绑的名字冲突）；
  - 按纹理单元的状态与矩阵栈（每个单元一个纹理栈，深度按规范），按 FBO 的 draw buffer；
  - `glPushAttrib`/`glPopAttrib` 全部属性组，客户端属性栈，像素存储状态；
  - 光源位置、聚光方向、裁剪平面、texgen 平面在设置时变换；整数参数只归一化颜色；
  - 光栅位置：变换、裁剪、有效性、锁存的颜色和纹理坐标；
  - 显示列表：按 GL 2.1 §5.4 区分立即执行与编译；嵌套 `glCallList` 记为调用；客户端数据由客体在编译时取值；
  - `GL_SELECT`/`GL_FEEDBACK`：用影子的矩阵和视口做软件变换与裁剪，按名字栈变化写命中记录，反馈令牌布局按规范；
  - 求值器：在影子里求值并生成绘制，补上 `GL_AUTO_NORMAL`；
  - 能力宣称只来自影子一处：与页面能力一致，存档时冻结。
- **C4 GLSL（§0.1 第一步）。** glslang 按桌面规则检查、链接、反射；uniform 位置按 GL 规则分配（数组元素 `location + i` 可用）；类型和大小检查；`ACTIVE_UNIFORM_MAX_LENGTH` 含 `[0]`。
- **C5 ARB 程序前端。** `gl_arb_program.js` 的解析与校验搬到影子：env 按目标共享且无需绑定程序；参数上限顶点 96、片段 24 以上；查询正确；错误位置准确。
- **C6 转发。** 只把被接受的记录转发给页面，并补上解析后的信息（对象标识、明确的默认值、程序的链接序号）。页面沿用 VGL2 解码器。
- **C7 答案与等待。**
  - 同步答案由影子在 IOCTL 返回前直接写进客体内存。worker 模式下设备在 worker 里有客体内存的视图，所以同样成立；
  - 需要页面的答案（ReadPixels、查询结果、Finish、渲染结果读回）用状态字 + `writeGuestMemory`，期限以心跳为准；`mapAsync` 失败写 FAILED；
  - GL 客体的响应区与命令区的边界写进协议。
- **C8 存档。** 影子序列化 + GPU 资源读回，GL 退出日志重放；恢复时用冻结的能力，避免扩展串在另一台机器上变化。
- **修复：**
  - S1-1、S1-4、S1-7；
  - S2-9、S2-15 的状态部分、S2-30–S2-33、S2-36、S2-41–S2-47；
  - S2-27、S2-28 的状态部分；
  - S3 中的名字冲突、按单元状态、代理纹理、求值器、名字栈错误码、能力宣称。
- **风险：** 高，这是一次大重构。缓解办法：
  - 先有阶段 A 的状态查询测试和参照场景；
  - 从客体 C 影子和 `gles1_state.js` 移植已有的状态逻辑；
  - 新影子在 A5 的两种模式测试下逐个 opcode 替换旧路径，每次替换都跑全套测试。
- **退出条件：**
  - 状态查询一致性测试两种模式全过；
  - Cube 2 在 worker 模式下链接成功并渲染；
  - 上列问题的用例从已知失败表中删除。

### 阶段 D：页面执行器改为纯渲染器，修好渲染语义（约 4–6 周）

- **D1 删除回答路径。** 执行器不再设 GL 错误、不再同步回答，假定输入已被校验；`QUERY_*` handler 移除或只服务于异步路径。
- **D2 解析后的绘制状态 → 自动生成管线键。** 不再手写键：
  - 模板测试关闭时用 always/keep（S2-6）；
  - 程序以影子的程序标识和链接序号为键（S1-4 的页面部分、S2-45）；
  - 签名改为整数位域，不用 `JSON.stringify`。
- **D3 资源管理器与 pass 管理器。** 用阶段 B 的注册表重建设备丢失后的一切（S1-5）；按目标键决定是否开新 pass，`makeCurrent`、删除绑定的 FBO 都由此正确处理（S2-24、S2-29）。
- **D4 渲染语义：**
  - **S1-2 的全部构造：**
    - 按维度的回退视图；
    - MIN/MAX 用 ONE, ONE；
    - 线和点不设 depthBias（并实现 `POLYGON_OFFSET_LINE/POINT`）；
    - `glDepthRange(n>f)` 用顶点着色器变体；
    - 有索引的宽点与 `glPolygonMode(GL_POINT)`；
    - `gl_FragColor` 广播；
    - crossbar 指向禁用单元时直通；
    - 立即模式通用属性 0 别名 `glVertex`；
    - 读回矩形裁剪；
    - 深度纹理按比较模式绑定；
    - 浮点目标的混合按格式能力处理。
  - **固定管线：** S2-1–S2-5、S2-10–S2-13、S2-17、S2-18。
  - **绘制：** S2-7、S2-8、S2-14、S2-16、S2-19。
  - **资源与读回：** S2-20–S2-23、S2-25、S2-26。读回支持所有格式和打包状态；`TexImage(NULL)` 分配零填充存储；打包类型交换 BGRA；`SWAP_BYTES`、`3_3_2`。
  - **原先的偏差，这次一并实现：**
    - 边框色（D-03，着色器模拟）；
    - LOD bias；
    - 宽线（D-04，按点扩展的方式展开成四边形）和线点画（D-16）；
    - 前缓冲呈现（D-08）；
    - `glFinish` 等 `onSubmittedWorkDone`（D-13）；
    - 深度/模板的像素路径（D-15）；
    - 多重采样：`WGL_ARB_multisample` 像素格式、多重采样附件、`SwapBuffers` 时 resolve，与 D3D 审查里“MSAA 直接实现 resolve”的决定一致（D-06）；
    - `ARB_texture_border_clamp`、`EXT_texture_lod_bias` 只在实现之后才宣称。
  - **仍作为偏差保留并登记：** 遮挡查询的精确样本数（D-07，WebGPU 只给“是否有”）、颜色索引模式（D-14）、平滑线和多边形。
- **D5 性能：**
  - bind group 用显式布局和动态偏移，不再每次绘制创建；
  - uniform 用链接序号做脏检查；
  - 清除管线不以颜色为键；
  - `glBitmap` 用字形图集；
  - 纹理只重传脏的级别，`bufferSubData` 不重建整个缓冲；
  - pass 不再被 `glPopAttrib` 和带剪裁的 `glClear` 切断；
  - 逻辑运算只拷贝需要的区域；
  - 立即模式不再每个顶点分配数组。
- **风险：** 中到高。
- **验证：**
  - A1/A2 的参照场景全部通过，登记的偏差除外；
  - 变异门槛；
  - Warcraft III、Cube 2 轨迹的每帧 CPU 时间不高于修复前。

### 阶段 E：着色器（约 3–5 周，与 D 并行）

- **E0 验证（不超过 1 周）：** 按 §0.1 第二步比较路线 (i) 和 (ii)，按门槛决定是否切换。
- **E1 切换（通过门槛时）：**
  - XP 的 GLSL 代码生成改为 glslang → SPIR-V → vx_naga，与 GLES 3.x 共用 SPIR-V 补丁和 naga 修复；
  - `gl_shader_translator.js` 在 XP 路径上退役。GLES 的 `gles_shadow.js` 在不走 glslang 的 ES 1.00 分支上仍用它，等 GLES 也全部改走 glslang 后整体删除，届时与 GLES 会话协调；
  - 不过门槛时，在手写翻译器里修 S2-40 和 S2-41 的代码生成部分。
- **E2 ARB 代码生成：**
  - 相对寻址（含负偏移）、内联标量和向量常量、`[a..b]` 区间、SWZ 逗号语法；
  - 缺失的状态绑定、`result.depth`；
  - 状态结构按程序对的并集布局（S2-51）；
  - 片段程序启用时忽略纹理启用位（S2-52）；
  - 固定顶点 + ARB 片段程序（D-18、S2-50），开着裁剪平面和点扩展的 ARB 顶点 + 固定片段；
  - `OPTION ARB_fog_*`、`VERTEX_PROGRAM_TWO_SIDE`、`VERTEX_PROGRAM_POINT_SIZE`；
  - S3 中的 LIT NaN、RECT 与 SHADOW 目标。
- **E3 运行时校验：** 链接时对生成的 WGSL 调用 `getCompilationInfo`，失败就把链接状态报为 FALSE 并给出日志。
- **风险：** 中。共用文件的改动要跑 GLES 的 dEQP 子集。
- **验证：**
  - Cube 2 语料；
  - 新的 GLSL 1.20 语料；
  - ARB 语料：WineD3D 生成的程序和 cgc 输出；
  - 全部经 Tint 编译并做像素测试。

### 阶段 F：客体 DLL 变薄（约 3–4 周，在 C 之后，与 D、E 并行）

- **F1 删除客体影子和缓存。** 只保留 WGL 和编码需要的状态；每个 `glGet*`、`glGetError` 经 IOCTL 由影子回答；`glCopyTexImage` 不再同步读回再上传。
- **F2 编码：**
  - 立即模式合并成顶点块；
  - 客户端数组只拷贝 `[min, max]`，超出 `end` 的索引照画（S2-34）；
  - `glArrayElement` 正确处理 VBO 偏移、w 和通用属性（S2-35）；
  - `glMultiDraw*` 不再把锁存错误当本地状态（S2-36）；
  - 超过 arena 的上传分带（S1-6），与 D3D 的 S1-12 共用方案；
  - `glLockArraysEXT` 生效；
  - 显示列表只转发 `glNewList`/`glEndList`/`glCallList(s)` 和编译时取值的数据，由影子管理。
- **F3 线程：** 每个线程一个当前上下文（TLS）；arena 游标加锁；窗口过程不发记录，只设置标志（S2-37）。
- **F4 WGL：**
  - 生命周期照 Windows 的行为（S2-38）；
  - 像素格式表包括单缓冲、多重采样、内存 DC 的处理，`SwapBuffers` 按 `hdc`（S2-39）；
  - Unicode 窗口子类化；交换间隔转发给宿主。
- **F5 传输：**
  - 失败可以重试，不再永久设置 `g_v86gl_failed`；
  - 删除强制的 `OutputDebugStringA`（S1-3 的客体部分）；
  - 删除只为猜测极限值而存在的回退（`query_limit_or_default`）和报告成功的空实现。
- **F6 部署：** 重新构建 `opengl32.dll` 和 `v86gl.sys`，替换站点镜像里的旧 DLL。按 2026-09-04 的记录，`game/cube2.img` 里还是迁移前的 gl4es 版本（145 408 字节，`GL_VERSION` 为 `2.1 v86gl (gl4es/WebGL2)`）。验收前先按大小或 `GL_VERSION` 确认镜像里的版本，否则测的是旧路径。
- **风险：** 中。
- **验证：** A4 的客体 ABI 测试台；客体 DLL 的行为在两种模式下相同。

### 阶段 G：客体内验收与收尾（约 2 周，之后持续）

- **程序：**
  - GLView 2.6.0（固定管线、ARB、显示列表、拾取）；
  - Warcraft III 的 OpenGL 模式；
  - Cube 2；
  - 一个 Quake 3 引擎游戏（模板阴影、光晕的深度读回、`gl_ztrick`）；
  - 一个经客体 WineD3D 走 GL 的程序。
- **每个程序：** worker 模式和本地模式各跑一次；中途存档再恢复；两个程序先后运行；与修复前比较帧时间。
- **文档：**
  - 偏差清单恢复到 `gl-webgpu/README.md` 或并入 `docs/gpu-deviations.md`；
  - `COVERAGE.md` 增加测试列；
  - 源码注释里的文档引用改到实际位置；
  - `docs/glbridge.md` 更新。
- **退出条件：** §1 的完成标准全部满足。

## 4. 问题到阶段的映射

| 审查编号 | 阶段 |
| --- | --- |
| S1-1 | C（C3、C7） |
| S1-2 | B（检测）、D4（逐项消除）、E3（WGSL） |
| S1-3 | B（宿主）、F5（客体） |
| S1-4 | C2、C3、D2 |
| S1-5 | B（注册表）、D3 |
| S1-6 | F2（分带）、C3（如实宣称） |
| S1-7 | C7 |
| S2-1–S2-5、S2-10–S2-13、S2-17、S2-18 | D4 |
| S2-6 | D2 |
| S2-7、S2-8、S2-14、S2-16、S2-19 | D4 |
| S2-9 | C3（转换）、D4（使用） |
| S2-15 | C3（光栅位置）、D4（绘制） |
| S2-20–S2-23、S2-25、S2-26 | D4 |
| S2-24、S2-29 | D3 |
| S2-27、S2-28 | C3、D4 |
| S2-30–S2-33 | C3、F2 |
| S2-34–S2-36 | F2 |
| S2-37 | F3 |
| S2-38、S2-39 | F4 |
| S2-40 | E1 |
| S2-41–S2-45 | C4、E1 |
| S2-46、S2-47 | C5、E2 |
| S2-48–S2-52 | E2 |
| S3（固定管线、绘制、资源） | D4，或登记为偏差 |
| S3（客体） | C3、F2、F4 |
| S3（着色器） | E1、E2 |
| 审查 §2.2 的能力宣称 | C3 |
| 审查 §2.2 与 §5 的文档漂移 | C1、G |
| 审查 §6 的测试问题 | A |

## 5. 下载

- **Mesa：** 已同意（2026-10-29）。阶段 A2 在 Alpine aarch64 虚拟机里经 `tools/alpine_repo.mjs` 取 `mesa-egl`、`mesa-gl`、`mesa-dri-gallium`；Linux CI 用发行版包。除非要调试 Mesa 本身，否则不需要源码。
- **glslang：** 已在本地（16.6.0，GLES 工作时下载），不需要新的下载。
- **piglit：** 未请求，也不是必需的。如果之后想把 piglit 用例移植进参照场景，再单独征求同意。

## 6. 风险与依赖

- **阶段 C 的规模。** 桌面 GL 2.1 的状态比 GLES 大得多（固定管线、显示列表、选择模式、ARB）。缓解见阶段 C。
- **glslang 代码生成的验证可能不过门槛。** 不过时有退路（§0.1），第一步不受影响。
- **共用文件。** `gl_shader_translator.js`、`gl_fixed_function.js`、`gl_state_layout.js` 被 GLES 使用。改动要跑 GLES 的 dEQP 子集，并与正在编辑这些文件的会话协调。
- **驱动改动。** 阶段 C2 改 `v86gl.sys`，D3D 的三个 DLL 也经同一个驱动；D3D 的回归测试必须一起跑。
- **镜像部署。** 站点磁盘镜像里的 DLL 和驱动要更新（阶段 F6）。镜像是 URL 后端的只读覆盖，客体内的写入不会落盘。
- **与 D3D 计划的协调。** 阶段 B 的工作与 D3D 审查阶段 0 的宿主部分是同一件事，应该只做一次。
