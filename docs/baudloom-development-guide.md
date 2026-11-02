# Baudloom 开发与架构

## 工程结构

- `src/renderer`：纯 DOM 界面、发送工具、虚拟日志列表和布局设置。
- `src/desktop`：Electron 主进程、preload、存储路径、文件对话框和生命周期。
- `src/core`：独立 utility process 中的串口、发送调度、缓存、记录和历史读取。
- `src/shared.ts`、`src/snapshot.ts`、`src/baud-rate.ts`、`src/send-tools.ts`、`src/view-settings.ts`：接口、共用字节规则与缓存预算。
- `tests`：核心行为测试及 Electron 桌面测试。
- `assets/brand`：原创图标源稿及生成结果。

渲染器启用 context isolation 和 sandbox，关闭 Node integration；仅通过固定 preload 接口调用主进程。IPC 校验来源，页面不加载远程内容。采集进程与界面分离；刷新不关闭连接，但会取消定时发送。

## 构建与测试

```sh
npm ci
npm run icons
npm run format:check
npm run typecheck
npm test
npm run test:desktop
npm run benchmark
npm run package:win
```

Windows 单文件输出为 `artifacts/Baudloom-<版本>-win-x64.exe`。`artifacts/Baudloom-win32-x64` 为打包中间结果；Linux 验证包可使用 `npm run package:linux`。

打包后测试用 `BAUDLOOM_EXECUTABLE` 指定应用可执行文件。Linux 无桌面环境需要 Xvfb 和 Electron 系统依赖。root 测试环境的 `--no-sandbox` 仅由测试启动器添加，产品入口不添加。

`package-lock.json` 固定依赖。GitHub Actions 在 Windows 上执行格式、类型、核心、桌面和打包后验证；每次运行结果见 Actions，不能用配置存在推断运行通过。

## 启动与刷新

0.1.3 使用 ASAR 合并应用文件，`.node` 原生绑定保留为实际文件；Electron 只保留 `zh-CN` 和 `en-US` 语言资源。便携包启用 `useZip`，使用 NSIS 内置 zlib 直接解包，避免先提取 7z、再解压、再复制的路径；每次启动分配独立 TEMP 目录，退出清理。本方案仍需每次解包，包体积比 0.1.2 大。参考 [Electron ASAR](https://www.electronjs.org/docs/latest/tutorial/asar-archives) 与 [portable 配置](https://www.electron.build/docs/api/app-builder-lib.interface.portableoptions/)。

窗口创建不等待偏好文件和采集进程启动；IPC 请求仍等待采集初始化，避免向未创建的进程发送。初始视图、设备枚举和目录显示分别加载，枚举慢时不阻挡首个视图。

`snapshot` 不带游标时返回完整视图；界面轮询携带会话、格式、最后行号和修订号，返回新增/变化尾部以及首行号、总缓存行数。未终止片段使用原行号替换，缓存淘汰同步删除头部；格式切换或会话变化自动返回全量。游标只影响显示传输，不影响原始事件。界面丢弃过期格式/视图请求，空闲时复用行数组。连接状态轮询间隔为上次请求完成后 100 ms，未连接或后台为 1000 ms，不并发积压。

显示和原始缓存使用带游标的队列，移除头部时释放引用，定期压缩，避免每条记录调用数组头部删除。发送上下文未变化时跳过校验预览重算，日志时间格式器复用。

`npm run benchmark` 使用合成数据报告核心处理时间、50000 行缓存下完整/空闲/新增一行快照的 JSON 字节量。它不打开硬件或保存会话，JSON 字节量用于比较数据规模，不等于 Electron IPC 的精确编码大小。

## 数据与存储语义

默认根目录为原始便携启动器目录下的 `Baudloom-data`。`PORTABLE_EXECUTABLE_DIR` 用于定位原始 EXE，目录包使用其可执行文件目录，开发模式使用项目根目录。测试可通过 `BAUDLOOM_DATA_DIR` 指向临时目录。不可写时明确报错，不静默改存其他路径。

原始事件使用 JSONL：版本、文件会话 ID、序号、UTC、单调时钟、来源、端口、波特率及事件数据。RX/TX 字节为 base64，单条 SHA-256 用于发现意外损坏，不提供身份认证。

| 项目 | 当前边界 |
|---|---|
| 文件写入与扫描 | 单个会话 64 MiB；当前没有分段或完整分页 |
| 实时写入队列 | 4 MiB，超限停止采集并报告 |
| 补写队列 | 32 MiB，与实时队列分别计量 |
| 显示缓存 | 文本/HEX 各自默认 10000 行 / 4 Mi 字符，任一超限淘汰 |
| 原始缓存 | 事件数按行数预算，序列化字节容量按字符预算；最大 50000 个事件 / 16 MiB |
| 历史读取 | 按当前预算保留尾部事件，文件损坏时显示已验证前缀 |
| 同步 | 连接、补写完成、周期和正常退出请求同步；不保证断电零丢失 |

连接中开始保存时，先在发送串行队列中等待当前发送完成；文件创建期间继续缓存 RX。缓存事件同步排入写入队列后切换新事件目标，保留原 at/mono、原始字节和请求关联。文件 start 表示创建时刻，后面的补写事件时间可能更早；文件顺序由 seq 定义。连接身份独立于文件 UUID，补写不改变发送目标或重放命令。补写成功同步后才显示完成数量；创建失败不关闭原有未保存连接，接管后的写盘错误会停止采集。

缓存事件与显示行不一一对应。视图设置的内存提示是容量模型：`6 × 字符容量 + 256 × 行数` 至 `16 × 字符容量 + 1024 × 行数`，换算 MiB，包含原始缓存、两种视图、IPC 副本及界面对象。它不是实测值或硬上限，不含 Electron 基础内存。

## 发送语义

UTF-8/HEX 转换只转换内容；无法无损转换的控制字节或非法编码不静默替换。校验覆盖从 1 开始、包含两端的字节范围，结束留空表示末尾；校验追加到整个内容后，再追加文本换行。

定时任务复制整批命令与目标，逐条写入完成后等待间隔，不并行积压或补发周期。停止、断线、故障、界面刷新及退出使未执行任务失效，已经交给串口的字节无法撤回。

## 发布流程

1. 更新版本、更新记录和当前限制，完成适用测试。
2. 核对提交只包含当前源码、测试、文档与原创资源；排除开发缓存、用户数据、旧原型和构建目录。
3. 打包并核对内嵌版本、许可证、原生依赖、图标和最终源码的一致性，计算 SHA-256。
4. 推送源码，检查 Windows CI；为确切提交创建 `v<版本>` 标签。
5. Release 附上 Windows EXE 和仅包含本次文件的 `SHA256SUMS`，注明验证范围与未完成的实体设备验收。

发布中的原创文件采用 MIT，第三方声明见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
