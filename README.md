# Codex Model Picker

为 macOS Codex 的原生模型菜单添加外部模型选择，当前主要适配 **DeepSeek V4 Pro**（`deepseek-v4-pro`）。选择 `DeepSeek · V4 Pro`，空闲聊天可在 DeepSeek 与 GPT 之间往返切换，按聊天传入 provider 配置，不将外部 provider 写成 CLI 的共享默认项。

**这是实验性、固定版本的客户端补丁，不是官方即装即用的菜单扩展。** 另有标准伴随 skill 插件，用于打开模型管理网页和启动独立 CLI；仅安装伴随插件不会修改原生菜单。

## 状态与限制

- 适配目标：macOS Apple Silicon，承载 Codex 的 `/Applications/ChatGPT.app`，版本 `26.1013.40934`、构建 `20770`。应用版本或编译资源变化后必须重新适配。
- 本机验证：19 项路由/历史兼容/编译资源接线检查、真实后端配合本地模拟接口的 DS → GPT → DS → GPT 往返切换、真实 DeepSeek API 请求，以及独立应用副本持续启动 30 秒。
- **原生菜单实际点击与从原生 GUI 发送尚未验收**：作者机器的原生 GUI 自动化服务不可用。代码接线、启动或签名检查不能替代这一项。
- 当前只支持本机 local 聊天和 Responses API。空闲的持久聊天支持跨 provider 切换并保留 ID 和历史。临时聊天、运行中任务、有后台终端、未结束目标或未归档子聊天时拒绝切换；同一 provider 内仍走原生模型设置更新。
- 外部模型 ID 必须唯一，不能与原生模型 ID 冲突。联网搜索、插件、图像等能力不保证与 OpenAI provider 等价。
- 原生补丁可叠加在已安装的文件树增强版上。本机已核对文件树模块、preload 和启动入口内容保持一致；其他机器仍须重新验证。

## 0.2.1：保留推理正文，修复切到 GPT 后的请求错误

DeepSeek 的 `reasoning.content` 中包含明文 `reasoning_text`；GPT 接口拒绝这种输入，报 `array_above_max_length`。切换时把它表示为普通 assistant 历史文本，正文保持原样，不逐条加备注，也不重复发送摘要。原始推理记录和来源保存在本地额外字段中，不进入模型请求；切回原 provider 时恢复原始结构。其他 provider 的加密推理不会直接转发，能用的摘要转成普通文本，无文本时保留空推理占位。

这会在聊天空闲并卸载 runtime 后，转换其本地 rollout 中的推理表示。转换前保留完整 `.model-picker-*.bak` 备份，验证备份与原文件一致；写入后读回校验，失败恢复原文件再恢复原 provider。用户消息、最终答复、工具调用及结果保持原样。备份和原始字段会多占本地空间，不增加请求中的重复正文。已有 0.2.0 切到 GPT 后报错的聊天也会在下一次空闲发送时检查并转换；兼容的普通 GPT 聊天不会归档或写历史。

已用包含推理记录、严格拒绝不兼容输入的本地接口复现旧错误，并验证修复后的 DS → GPT → DS → GPT；测试覆盖桌面端分页历史。另用真实 GPT-6.1 Sol 和 DeepSeek API 验证：GPT 可读取前序推理文字并正常回复，随后可切回 DeepSeek。真实接口测试使用独立临时聊天，不修改原有聊天；原生菜单点击仍需安装后验收。

## 0.2.0：修复 DeepSeek 无法切回 GPT

0.1.0 在已有外部聊天的 `thread/settings/update` 中直接拒绝跨 provider 切换，表现为“无法更新模型设置”。0.2.0 在空闲持久聊天中，先读取原有权限和状态，暂时 archive/unarchive 以卸载旧 runtime，再以目标 provider 恢复同一个聊天 ID。回到 GPT 时显式选择 `openai`，不继续附带 DeepSeek 的 provider 配置或模型目录。

这不是删除或新建聊天。已用真实 bundled app-server 和本地模拟 Responses 接口验证 DS → GPT → DS → GPT：同一 ID、四轮历史、实际 HTTP 目的地、权限、其他聊天及全局配置均符合预期，卸载后记录的 provider 也保持正确。模拟接口测试不代表真实 GPT 账号/API 调用验收。

切换期间过滤临时归档通知，完成后同步 GUI 缓存中的 provider；失败会恢复原 provider 和权限。禁止在有后台终端、未结束目标、未归档子聊天或运行中 turn 的聊天上进行这种 runtime 重载，避免停止其他工作。快速连续选择按聊天串行处理。

构建器只允许覆盖已知 0.1.0、0.2.0 或当前路由器指纹的旧补丁，未知补丁拒绝升级；安装包仍核对当前完整应用哈希。新包名为 `Codex-DSV4-模型菜单-0.2.1.pkg`。本机实际原生 GUI 点击验收仍需安装后进行。

## 签名影响

参考 [TQCAI/codex_file_tree_finder](https://github.com/TQCAI/codex_file_tree_finder) 的 ASAR 完整性摘要、独立副本、由内到外签名和 macOS 安装包方案。

修改客户端资源需要本地重签，无法保留厂商签名身份。文件树增强版采用的本地签名方案已确认会导致部分内置工具因 `missing-code-signing-identity` 拒绝连接，账号、钥匙串、通知、更新及启动路径也可能受影响。

本项目的 `preview.py` **只允许从已经采用文件树本地签名方案的本机应用创建副本**：沿用已有 entitlements，不自动为原厂应用移除权限或添加库验证例外。保留 hardened runtime、ASAR 校验及框架摘要校验，不关闭系统 Gatekeeper/SIP，不修改 Electron fuses。

## 环境与源码测试

需要 macOS、Python 3.11+、Node.js 22+ 和 macOS 签名/打包工具。未验证 Windows、Linux 或 Intel Mac 的原生菜单安装。

```sh
git clone https://github.com/TQCAI/codex-model-picker.git
cd codex-model-picker
npm test
python3 -m py_compile picker.py manager.py install.py preview.py recovery.py build_native_installer.py
```

没有 npm 第三方依赖。干净源码目录运行 `npm test` 会通过 16 项路由和历史兼容测试，并明确跳过需要本机原生候选资源的 3 项编译资源接线测试；生成候选后再运行，会执行全部 19 项。官方客户端编译资源不包含在仓库中。

## 配置模型与打开管理页面

`catalog.example.json` 仅包含公开 endpoint、模型 ID 和 API Key 环境变量名称，不包含密钥。

```sh
mkdir -p ~/.local/share/codex-model-picker
cp catalog.example.json ~/.local/share/codex-model-picker/catalog.json
python3 picker.py manage
```

也可双击 `start.command`。管理页面可添加/移除服务、保存配置、生成菜单补丁候选；仅监听随机 `127.0.0.1` 端口，使用每次启动的随机访问令牌，不配置开机启动。

在本机设置实际 `DEEPSEEK_API_KEY`，并确认启动 Codex 的进程能取得它；在终端设置的变量不会自动传给已经打开的桌面应用。也支持凭据文件引用：以 `auth: {"command": "/bin/cat", "args": ["/absolute/path/to/private-key-file"]}` 替换 `env_key`，文件权限应由用户限制。**不要把密钥值写进 catalog、源码或应用包。**

如需自定义模型元数据，可在 provider 的 `runtimeConfig` 中配置本机 `model_catalog_json` 绝对路径。仓库不携带作者的模型目录或凭据文件；这些应在使用者本机准备。

## 独立 CLI 会话

```sh
python3 picker.py cli \
  --catalog "$HOME/.local/share/codex-model-picker/catalog.json" \
  --provider picker_deepseek --model deepseek-v4-pro \
  --cwd /absolute/path/to/your/project
```

启动器使用 `--no-daemon` 和本次命令配置，不改写共享 `~/.codex/config.toml` 的 model/provider 默认项。

## 原生菜单：本机生成、预览与安装

先核对应用版本、源资源及当前签名方案；不要通过删除版本、锚点或完整性检查来强行适配。构建脚本和测试中仍有固定应用路径与资源名，其他路径/版本需要一起适配。

```sh
python3 picker.py build \
  --catalog "$HOME/.local/share/codex-model-picker/catalog.json"
python3 install.py prepare
npm test
```

上述命令只写 `candidate/`。在符合前述签名前提时生成独立副本：

```sh
python3 preview.py
python3 tests/preview_startup.py
python3 build_native_installer.py
```

`preview/` 必须尚不存在，或用 `--out` 指定新目录；启动检查及打包脚本默认使用 `preview/ChatGPT.app`，改变目录时需一并适配。测试使用临时桌面 profile 和临时 `CODEX_HOME`，不复制账号凭据；其他手工 GUI 验收仍须核实实际账号/后端隔离范围。

生成的 `.pkg` **只供完成本机检查的这台机器使用**，不会自动安装。保留系统安装器窗口，用 ⌘Q 正常退出 Codex/ChatGPT，再在安装器中完成安装和管理员授权。安装器核对当前完整 ASAR 哈希、备份安装前应用、安装后检查签名并尝试重新打开。不会强制结束运行中的应用。

安装后先在测试聊天中选择 `DeepSeek · V4 Pro`，完成一轮后切回 GPT，再验证下一轮请求；也应回归检查原有文件树功能。本机已有的签名功能损失不能因为菜单工作就忽略。

旧的 `install.py install` 简单重签路径已禁用，因为它不能正确更新该版本框架中的完整性摘要。

## 恢复

打包时生成本机 `恢复安装前版本.command`，正常退出应用后运行。它只在当前应用完整哈希匹配本次候选时恢复管理员保护的安装前备份；应用更新或另行修改后拒绝覆盖。备份目录记录在本机 `native-package/build-report.json` 的 `rootBackup` 字段。

`nativeGuiValidated: false` 明确保留在构建记录中；候选 manifest 不是安装成功收据。实际安装状态需核对安装后的应用哈希与运行情况。

## 伴随插件

```sh
codex plugin marketplace add /absolute/path/to/codex-model-picker
codex plugin add model-picker@local-model-picker
```

插件中的 skill 会先定位使用者的源码目录，不假定作者机器路径。它用于打开管理页面及独立 CLI，原生菜单仍需要上述补丁安装。

## 可选的本机/外部 API 验证

```sh
python3 tests/live_smoke.py
# 同一聊天的 provider 往返切换、历史、权限、回滚相关验证；不调用真实模型 API：
node tests/live_provider_switch.cjs
# 使用本机登录凭据在临时目录运行两次简短真实 API 请求（不打印凭据）：
node tests/real_reasoning_switch.cjs --catalog /absolute/local/catalog.json
# 以下命令会发送一次很短的真实模型 API 请求：
python3 tests/external_smoke.py \
  --catalog "$HOME/.local/share/codex-model-picker/catalog.json"
```

## 发布边界

公共仓库仅包含源码、测试、公开示例和说明。**不上传**官方客户端或框架、安装包、候选包、应用备份、真实 catalog、API Key、账号 profile、日志、本机报告、恢复收据或历史安装授权。接收者应自行适配并重新构建，作者机器的测试结果不能代替本机验收。
