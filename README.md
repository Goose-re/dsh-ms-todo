# dsh-ms-todo

把 Microsoft To Do 和 Outlook 日历接进 [DeepSeek Harness](https://github.com/deepseek-ai) ——
一套 CLI + 一个技能，让 agent 能读写待办、排当天日程、并感知你在 App 里的勾选。

## 它做什么

- **记事**：把你口述的项目原话变成待办（带截止日和提醒），**不替你脑补步骤**。
  缺 `source` 或编造 `due` 的 plan 会在发网络请求之前被拒。
- **排程**：读日历和待办，估耗时，把一天排成时间块写进 Outlook 日历，到点弹提醒。
- **感知**：长轮询 Graph，你在手机或桌面上勾掉一条，agent 会知道。

## 装到本机

```powershell
# Windows
.\install.ps1
```

```bash
# macOS / Linux
bash install.sh
```

装到 `$DSH_HOME`（没设就是 `~/.dsh`）：

| 仓库里的路径 | 装到 |
| --- | --- |
| `ms-todo/` | `$DSH_HOME/ms-todo/` |
| `skills/microsoft-todo/` | `$DSH_HOME/skills/microsoft-todo/` |

技能不需要注册 —— DSH 的 `skill-filesystem` 会自动扫 `$DSH_HOME/skills/`。

## 授权（必须做一次）

仓库里**不含** `auth.json`，也不该含。第一次要自己走设备码授权：

```powershell
node "$env:DSH_HOME\ms-todo\login.mjs"
```

它会打印一个 `user_code` 和一个网址，浏览器里输入并同意，终端打印 `LOGIN_OK` 即成功。
token 之后会自动续期，平时不用管。

## 依赖

- **Node.js ≥ 18**（用了 `fetch`、`AbortSignal.timeout`、`node:` 前缀导入）
- 不需要 npm install —— 零依赖，只用 Node 标准库

## 自检

```powershell
node "$env:DSH_HOME\ms-todo\check-skill.mjs"      # 校验 SKILL.md frontmatter，13 条
node "$env:DSH_HOME\ms-todo\test.mjs"             # 纯函数单测，53 条
node "$env:DSH_HOME\ms-todo\e2e.mjs"              # 本地假 Graph 跑全流程，60 条
node "$env:DSH_HOME\ms-todo\schema-check.mjs"     # 比对 Graph 官方 CSDL，31 条
```

这四条**不需要凭据**。需要真实授权的：

```powershell
node "$env:DSH_HOME\ms-todo\smoke.mjs"            # 在真实账号里建了又删，15 条
node "$env:DSH_HOME\ms-todo\day.mjs" context      # 看当天真实的日历 / 待办 / 约束
```

> `check-skill.mjs` 一定要在改 `SKILL.md` 之后跑：frontmatter 一旦坏掉（典型是
> `description` 里出现「冒号+空格」），DSH 会把技能**静默**移出目录，哪里都不报错。

## 破坏性命令

`wipe.mjs` 会清空账号里**所有**清单和待办。默认拒绝执行，要 `--dry-run` 预览或
`--yes` 才真删。跑之前先用 `inventory.mjs` 把真实规模摆出来。

## 配置

| 环境变量 | 作用 | 默认 |
| --- | --- | --- |
| `DSH_HOME` | harness 主目录 | `~/.dsh` |
| `MSTODO_DIR` | 覆盖数据目录 | `$DSH_HOME/ms-todo` |
| `MSTODO_GRAPH_BASE` | 覆盖 Graph 端点（测试用） | `https://graph.microsoft.com/v1.0` |
| `MSTODO_ACCESS_TOKEN` | 直接指定 access token | — |

## 时区

`state.json` 的 `timeZone` 用 Windows 时区名（Graph 不接受 `Asia/Shanghai` 这种 IANA 名）。
带 `timeZoneDetectedFrom` 标记时表示自动跟随机器时区，换机会自动重新同步。

**邮箱的显示时区是服务端设置，跟机器时区无关。** 如果日历里事件时间整体偏了几个小时，
先比对 `mailboxSettings.timeZone` 和机器时区 —— 不一样就是问题所在，要改邮箱设置，
**不要**去改事件创建方式（那会把事件的真实瞬间挪走）。
