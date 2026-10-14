---
name: microsoft-todo
description: Use for anything touching the user's Microsoft To Do or Outlook calendar. Daily routine and scheduling — they report waking up or coming online (上线、起床), taking a break or stopping for the day (休息、收工), or working away from home (外出), and want the day planned and scheduled rather than just listed, including guessing how long tasks take and respecting deadlines. Also covers turning pasted project content into tasks with due dates and reminders, asking what is on their plate or what is left, reporting they checked something off, renamed, rescheduled or deleted a task in the app, or saying a project has a new goal so the old tasks should be replaced. Covers credentials, the CLI entry points, the plan JSON schema, the reminder policy, and the scheduling judgement to apply.
---

# Microsoft To Do 接入

用户的 Microsoft To Do 已通过 Microsoft Graph 接入本机。所有状态与凭据都在
`$env:DSH_HOME\ms-todo\`，全部命令都是 `node <script> <command>`，输出 JSON。

> **路径一律走 `$env:DSH_HOME`，不要写死绝对路径** —— 这套东西要在机器之间搬。
> `$env:DSH_HOME` 就是 harness 主目录，优先级是「显式配置 > `$DSH_HOME` > `~/.dsh`」；
> `install.ps1` 会把它设成用户级环境变量，所以每个 shell 里都在。
> 只有主目录里含空格时才需要给路径加引号：`node "$env:DSH_HOME\ms-todo\todo.mjs" lists`。
> 代码里的 `graph.mjs` 也是同样的解析逻辑（`MSTODO_DIR` > `$DSH_HOME/ms-todo` > `~/.dsh/ms-todo`）。
> 换机迁移见同目录 `MIGRATION.md`（在哪、装什么、什么东西绝不能进 git）。

## 新会话冷启动

在**新会话**里第一次看到这个技能，按这个顺序走，别凭印象：

1. 先确认凭据还活着：
   ```
   node $env:DSH_HOME\ms-todo\todo.mjs lists
   ```
   - 正常返回清单 → 凭据有效。refresh token 会自动续期，**通常不需要重新登录**。
   - 返回 `NOT_LOGGED_IN` / `REFRESH_FAILED` → 跳「先决条件：凭据」重新授权。
2. **先记住这条铁律**（用户 2026-10-01 亲自纠正过，见「交互流程」）：

   > **用户提出项目时，只记他说的话。不要脑补步骤，不要编截止日。**

   `apply` 已经在**代码层面**拦住违规的 plan —— 缺 `source`、没有 `stepsFromUser`
   开关的 `steps`、没有 `dueBasis` 的 `due` 都会被拒。别把这道闸门当成待绕过的
   障碍，它就是这条铁律的实现。被拒了就去问用户，**不要为了过闸门而补一个假来源**。

3. 再按用户说的话选入口：

   | 用户说 | 做什么 |
   | --- | --- |
   | 「上线了」「起床了」 | **秘书模式**：`day.mjs context` → 排当天计划 → `day.mjs materialize` |
   | 「休息了」「今天到这儿」 | 秘书模式收尾：今天做完什么、什么顺延、明天怎么调 |
   | 「今天外出」「在外面」 | 秘书模式加 `--away` 重排 |
   | 丢来一段项目内容 | `todo.mjs apply`（见「plan JSON」） |
   | 「我勾掉了 XX」「我改过截止」 | `todo.mjs status` |
   | 「XX 项目有新目标」 | 重新 `apply`，会自动删旧建新 |

4. **不要手改 `state.json`** —— 它是命令写的，手改会破坏追踪（`projects` 里的 id
   映射一旦错位，`apply` 就可能删错东西）。要看状态就跑 `todo.mjs status`。

> **`day.mjs materialize` 已于 2026-10-01 在真实服务上跑通**（写了 4 个日历块 +
> 5 条提醒，`0 errors`）。它会先删掉自己上一轮建的日历块再重建，所以计划改了直接
> 重跑即可。但**仍然先 `--dry-run` 给用户看**再真写。

| 文件 | 作用 |
| --- | --- |
| `graph.mjs` | token 刷新 + Graph 请求封装（不要直接改，改逻辑请改 `todo.mjs`） |
| `login.mjs` | 一次性设备码授权 |
| `todo.mjs` | 全部业务命令 |
| `inventory.mjs` | 只读盘点：每个清单多少条、多少未完成、多少是 DSH 建的 |
| `wipe.mjs` | **破坏性**：清空所有清单和待办。默认拒绝执行，要 `--dry-run` 预览或 `--yes` 才真删 |
| `auth.json` | access/refresh token（含 `client_id`、`tenant`、`scope`） |
| `state.json` | DSH 追踪的项目 → 任务映射，以及 watch 基线 |

## 账号现状

**2026-10-01：用户要求清空了整个账号。** 现在 Microsoft To Do 里只剩两个删不掉的
系统清单：默认清单「任务」(defaultList) 和 "Flagged Emails" (flaggedEmails)，
都是 0 条待办。所以新建的待办会进「任务」清单，`state.json` 是空的。

用户当时是在看到完整清单（9 个清单 / 126 条待办，其中只有 2 条是 DSH 建的）和
"不可恢复" 的提示之后明确选择 "全删，不用备份" 的。以后再遇到类似的破坏性请求，
**先跑 `inventory.mjs` 把真实规模摆出来再确认**，不要直接动手。

## 先决条件：凭据

先运行 `node $env:DSH_HOME\ms-todo\todo.mjs lists`。

- 正常返回 → 凭据有效，直接干活。refresh token 会自动续期，平时不用管。
- 返回 `NOT_LOGGED_IN` 或 `REFRESH_FAILED` → 需要重新授权：
  1. 请求设备码：`curl.exe -s -X POST -H "Content-Type: application/x-www-form-urlencoded" -d "client_id=14d82eec-204b-4c2f-b7e8-296a70dab67e&scope=offline_access%20Tasks.ReadWrite%20User.Read" https://login.microsoftonline.com/common/oauth2/v2.0/devicecode`
  2. 把返回的 JSON 原样写入 `$env:DSH_HOME\ms-todo\devicecode.json`
  3. 把 `user_code` 和 `verification_uri` 告诉用户，让他去浏览器输入
  4. 后台运行 `node $env:DSH_HOME\ms-todo\login.mjs`，它在用户点完同意后写入 `auth.json` 并打印 `LOGIN_OK`

注意 `login.microsoftonline.com` 在本机很慢（单次请求可能 10s 以上），curl 要给 `--max-time 60`。

## 命令

```
node todo.mjs lists                     # 列出所有清单，标出 isDefault
node todo.mjs tasks [清单名]            # 导出某清单的实时任务
node todo.mjs apply <plan.json>         # 用计划替换某项目的待办（核心命令）
node todo.mjs status                    # 对比追踪态与实时态，列出用户改动
node todo.mjs snapshot                  # 记录当前实时状态为 watch 基线
node todo.mjs watch [--interval 20] [--timeout 14400]   # 长轮询，有变化就退出
node todo.mjs raw <METHOD> <path> [body]  # 裸 Graph 调用，排障用
```

## 组织约定

- **默认模式**：全部待办都进默认清单（`wellknownListName === 'defaultList'`），
  任务标题写成 `[项目名] 待办名`。用户明确表示倾向于集中在一个主清单里。
- **里程碑模式**（`"mode": "milestone"`）：大项目才单独开一个同名清单，标题不加前缀。
  只有当用户说这是个大项目 / 要按里程碑管理时才用。

## plan JSON

`apply` 读一个 UTF-8 JSON 文件：

```json
{
  "project": "官网改版",
  "mode": "default",
  "list": "官网改版",
  "purgeCompleted": false,
  "stepsFromUser": false,
  "tasks": [
    {
      "title": "完成首页视觉稿",
      "source": "用户说：3月20日前完成首页视觉稿。",
      "due": "2026-03-20",
      "dueBasis": "stated",
      "reminder": "2026-03-19T09:00:00",
      "importance": "high",
      "steps": ["收集竞品", "出两版方案"]
    }
  ]
}
```

- `title` 必填。
- **`source` 必填** —— 这条待办是从用户哪句话来的，**贴他的原话**。`apply` 会拒绝
  没有 `source` 的 plan。写不出原话，就说明这条是你编的，不要建。
- **`due` 必须带 `dueBasis`** —— `"stated"`（用户明说了这个日期）或 `"derived"`
  （从用户给的数字算出来）。`derived` 还要写 `dueFrom` 说明算式，例如
  `"用户给的 11/15 提前一个月 -> 10/15"`。**没有第三种选择：不填截止也比编一个好。**
- `due` 用 `YYYY-MM-DD`（到期日）或 `YYYY-MM-DDTHH:mm:ss`。
- `reminder` 省略时按下面的策略自动算，**通常不用手写**。
- **`steps` 默认被拒**。只有当**用户自己说了分几步**，才在 plan 顶层加
  `"stepsFromUser": true`。`apply` 会拦下没有这个开关的 `steps`。
- `mode: "milestone"` 时才读 `list`。

校验发生在**任何网络请求之前**：plan 不合格会直接失败、**什么都不会改**，
不会出现"旧任务已被删、新任务没建上"的半截状态。

## 提醒时间策略

`reminderFor(due, explicit)` 的默认规则，已经实现，不要再自己拍脑袋：

1. 有 `reminder` → 直接用。
2. 到期日**前一天 09:00**（此时区 `China Standard Time`），前提是它还在 15 分钟之后。
3. 否则用**到期日当天 09:00**。
4. 都过期了（比如今天就到期）→ **现在 + 15 分钟**。

## 替换语义（"某项目有新目标"）

`apply` 对同一个 `project` 是**整代替换**：

1. 删掉 `state.json` 里该项目上一代中所有**未完成**的任务；
2. 已完成的任务默认保留为历史（`purgeCompleted: true` 才会连完成的一起删）；
3. 按新的 `tasks` 重建。

只会碰 `state.json` 里记录过的任务 —— **绝不会动用户自己建的待办**。

## 感知用户在 To Do app 里的操作

用户勾选完成 / 改标题 / 改截止 / 新增 / 删除后要知道，有两种方式：

- **按需查**：`node todo.mjs status` → 返回每个项目的变化列表和 `hasChanges`。
- **实时等待**：先 `snapshot` 立基线，再用后台作业跑
  `node todo.mjs watch --interval 20 --timeout 14400`。
  它有变化就打印 `{"event":"todo-changed","changes":[...]}` 并正常退出（exit 0）；
  一小时无变化则打印 `{"event":"no-change"}`，同样 exit 0，看 `event` 字段区分。
  用 `run_in_background: true` 启动，作业结束时本会话会收到通知 —— 这就是
  "得知"的机制。
  基线会随每次检测自动前移，所以不会重复报同一个变化。

### 收到通知之后的固定动作（顺序别换）

```
1. snapshot   —— 吸收刚报的变化；顺带把基线推到"现在"
2. status     —— 抓盲窗期漏掉的改动
3. 起下一个 watch
```

**第 2 步不是多余的。** watch 是**检测到第一个变化就退出**的，而我收到通知、回消息、
再起下一个 watch 之间**有一段没人守着的空窗**。用户完全可能在这段空窗里又勾了几条。

2026-10-01 实测过：21:15:02 勾掉「出课纲」，watch 在 21:15:09 抓到并退出；
用户 21:15:15 又勾掉「导轨 · 皮带安装要上翻」—— 那次通知里**没有**这一条，
是补跑 `status` 才捞回来的（`snapshot` 的 `absorbed` 也证明漏了一条）。

**顺序也要对**：先 `snapshot` 再起 watch。如果跳过 snapshot 直接起，
新 watch 载入的基线还是上一次检测时的旧基线，会把已经知道的那条**再报一遍**。

### 为什么 timeout 是 14400 而不是 3600

**轮询本身不花 token** —— watcher 是个独立 Node 进程，模型不在环里，睡 20 秒读一次
Graph，一小时 180 次轮询是零 token。花费只发生在**作业结束、运行时把我叫醒**那一刻：
一次通知 + 读 `job_output` + 我回复，而且每一轮都会把整个会话历史重发一遍，
**会话越长每次通知越贵**。

所以窗口越短越浪费：每过期一次就多烧一整轮。后台作业没有运行时长上限，
默认给 4 小时。间隔保持 20 秒 —— 响应速度值这个价，因为轮询免费。

### 一个清单只读一次

`readSnapshot` 和 `cmdStatus` 都按 `listId` 去重后再读。用户的 4 个项目通常全在
默认清单「任务」里，**同一个 `listId`**；早先按项目循环是每轮轮询打 4 次完全相同的
请求（每小时 720 次，其实 180 次就够），既浪费又是 Graph 限流的来源。
`e2e.mjs` 有条断言守着"每个清单一次 snapshot 只读一次"，别改回按项目读。

### 变化报一次就该被"吸收"

`status` 比对的是 `state.json` 里 `projects[].tasks[]` 那份记录。**`snapshot` 和
`watch`（检测到变化时）都会把当前实时状态写回这份记录**，也就是把这个变化"吸收"掉，
之后 `status` 不再重复报它。

所以流程是：**watch 报 → 你告诉用户 → 该变化已被吸收，`status` 自动回到
`hasChanges:false`**。如果你改坏了这条链路（比如让 `snapshot` 只写
`state.watch.baseline`、不写回 `projects[]`），症状是：用户勾一条待办，
**之后每一次 `status` 都会永远重报那一条**，`hasChanges` 再也回不到 false，
而 `smoke.mjs` 里「刚建完应无变化」会直接挂。2026-10-01 修过一次，别改回去。

`snapshot` 的返回里有 `absorbed`，是这次写回了几条，可以拿它确认是否真的吸收到了。

> **改了 `todo.mjs` 或 `day.mjs` 之后，正在跑的 watch 作业还是旧代码** —— Node 在
> 启动时就把模块读进内存了。想验证改动，必须**先杀掉旧 watch 再重起一个**。
> 2026-10-01 就被这个坑过一次：watch 报了变化，但记录没被吸收，看起来像 bug，
> 实际是那个作业比改动先启动。

> **watch 分不清是谁改的。你自己动过待办，它也会报给你。** 跑 `smoke.mjs`
> （建完又 cleanup）、用 `raw` 修数据、重新 `apply`，都会被正在跑的 watch 当成
> 「用户改了什么」报出来。2026-10-01 一天之内就误报了两次。
> 看到变化先想一下「这是不是我刚干的」，再决定要不要告诉用户。

## 契约

- **stdout 永远只有一份 JSON**，直接 `JSON.parse` 就行；诊断信息走 stderr。
- 失败时 stdout 是 `{"ok":false,"error":"..."}` 且退出码为 1。
- `watch` 返回 `event` 字段区分结果：
  - `todo-changed` —— 有变化，`changes` 是变化列表
  - `no-change` —— 窗口内确实没变化
  - `watch-degraded` —— **全程没连上服务**，`ok:false`、退出码 1。看到这个不要
    当成"用户什么都没做"，是网络问题。

## 秘书模式（每日排程）

### 关于这个用户的三条事实

1. **没有固定的工作日和工作时间**（用户明确说的）。Outlook 里那个 Mon–Fri
   08:00–17:00 **是 Outlook 的默认值，不是他的作息，不要拿来排程**。
2. **日历是空的**（2026-10-01 核实：前后 37 天内 0 个事件）。所以日历是
   **输出** —— 我把安排写进去让他能在手机上看；不是输入 —— 没有会议需要避开。
   如果哪天开始有事件了，再把它当输入用。
3. **时区取机器，不取邮箱**。邮箱设置里是 `Greenwich Standard Time`，但机器是
   `Asia/Shanghai`，用户人在中国。`syncTimeZone()` 会自动跟随机器时区；
   只有在 `state.timeZone` 存在且**没有** `timeZoneDetectedFrom` 标记时才算用户手动钉死。

`day.mjs context` 返回的 `planningNotes` 里会重复这些约束，**排程前一定要读**。

### 一天的边界由用户的两个信号决定

- **上线 / 起床** → 用户说一声 → `day.mjs context` → 你排今天的计划 → `materialize`
- **休息** → 收尾：哪些做完了、哪些顺延、明天怎么调整
- 用户随时可能说 **外出工作** → 用 `--away` 重排。外出日可用时间的形状不同：
  通勤多、碎片时间多、大块连续时间少。

### 命令

```
node day.mjs context [--date YYYY-MM-DD] [--away]   # 汇总当天全部决策依据
node day.mjs materialize <plan.json>                # 落地计划（加 --dry-run 先预览）
```

`context` 给你：现在几点、时区、今天的日历、所有未完成待办（含截止/剩余天数/
耗时估算）、以及 `planningNotes`。

### 当天日程**只**走日历，不再建「今日安排」待办

2026-10-01 用户明确要求：**把当天的日程安排全部改到日历处理，不再创建「今日安排」
的 todo，提醒也挪到日历事件。** `materialize` 已经照做，别再建那条待办。

为什么必须这样（这是真实事故，不是洁癖）：

- **在 To Do 里，「完成待办」和「关掉它的提醒」是同一个动作。** 把「该开始了」这种
  提醒挂在待办上，就等于每次催你开始都在邀请你误勾。2026-10-01 就发生了：一个
  2 小时的块，在提醒响了 **8.9 秒**后被标记完成 —— 用户点的是通知上的「完成」。
- **那个提醒还会覆盖掉待办自己的截止日提醒。** 出课纲原本有 10/5 09:00 的
  「截止前一天」提醒，被 materialize 的开始提醒改成了 10/1 19:30，截止提醒就没了。

**日历才是「该开始了」的正确落点**：`createBlock` 现在发
`isReminderOn: true` + `reminderMinutesBeforeStart: 0`，到点弹通知，而点开日历通知
**不会完成任何东西**。待办的提醒因此回归它本该负责的那件事：**截止日**。

顺带记一笔（核过 v1.0 CSDL）：`event.isReminderOn` 和
`event.reminderMinutesBeforeStart` 都是真实存在的属性。

**别去绕路实现「我的一天」**：Graph 只为 Planner 暴露 My Day
（`plannerTask.isOnMyDay`、`plannerUser.myDayTasks`），**`todoTask` 在 v1.0 和 beta
里都没有这个字段**（对着两份 CSDL 核过）。社区那条路是未公开的 Substrate 接口
（`outlook.office.com/todob2/api/v1/` 的 `CommittedDay`），要换资源受众的令牌，
不受支持、随时可能挂。**日程走日历，就不要碰这条路。**

【坑】`materialize` 目前**没有自动化测试覆盖**（`test.mjs` / `e2e.mjs` 都不碰它）。
改完必须真的跑一次 `--dry-run`，再跑真的，然后回读确认：
`node todo.mjs tasks 任务` 看**没有**「今日安排」、且各待办的 `reminder` 是截止日
而不是块开始时间。

### plan JSON

```json
{
  "date": "2026-10-01",
  "away": false,
  "narrative": "给用户看的一段话：今天为什么这么排。",
  "estimates": { "完成首页视觉稿": 90, "回邮件": 15 },
  "blocks": [
    { "start": "09:30", "end": "11:00", "label": "完成首页视觉稿",
      "kind": "focus", "reason": "明天就截止，且需要连续时间" }
  ],
  "unscheduled": [
    { "title": "等对方回复报价", "why": "被阻塞，今天排了也没用 —— 要去催" }
  ],
  "writeCalendar": true
}
```

- **块不再引用待办**：`taskId` / `listId` 已经**不用**了 —— materialize 不碰待办的
  提醒，所以排程和 To Do 完全解耦。别再把（会过期的）任务 id 塞进块里。
- **每个块都会写成日历事件**，因为它就是提醒的载体。`kind` 只作信息记录。
  想排除某个块就写 `"calendar": false`。**注意**：`quick` 现在**也会**写日历
  （以前会跳过）—— 否则那些块就一个提醒都没有了。
- `estimates` 的 key 用**去掉 `[项目] ` 前缀的标题**，`materialize` 会存进
  `state.json`，所以同一个任务每次估的耗时一致。**下次排程要复用 `context`
  返回的 `estimates`，不要重新拍一个数。**

### 排程原则（"合理而不是机械"）

用户明确要求结果要合理、像个秘书，不要机械。具体是：

- **不满排**。留约 20% 缓冲。秘书不会把日程填死 —— 会超时、会有人找你。
- **碎片时段只放短任务**（回消息、打电话、交材料）；需要连续专注的（写方案、
  抄板、调试）必须给完整大块，切碎了等于没做。
- **硬截止优先**。`daysLeft` 越小越往前提；已经 `overdue` 的要么今天解决要么
  明确告诉用户"这个已经过期了，还要不要"。
- **场景匹配**。「打印材料」「车床」「买光电」这类必须出门/在办公室；
  「看教程」「写简历」在哪都行。`away` 为真时把需要在家/在工位做的事挪走或标出来。
- **被阻塞的不要排**。等别人回复、等货到 —— 排进日程只是自我安慰。单独列进
  `unscheduled` 并说明"需要你去催什么"。
- **别把耗时排得比实际可用时间还多**。算完总量如果超了，就**当面告诉用户今天做不完**，
  让他选砍哪个，而不是硬塞。

## 两个已经踩过的坑（都是真实服务上才暴露的）

- **报错信息里绝不能带 token**。`execFileSync` 抛出的错误会把整条命令行拼进
  message，而命令行里就有 `-H Authorization: Bearer ...`。曾经这样把 access token
  明文写进了会话日志。`viaCurl` 已经改成只保留退出码和 stderr 首行，别退回去。
- **完成待办时 To Do 会自己把提醒开关关掉**，所以"完成"和"提醒被关"是同一个动作。
  差异检测里要抑制 `reminder-toggled`，否则用户勾一下会收到两条变化。
- 用户勾选后如果服务端 `lastModifiedDateTime` 没变，说明**他的客户端根本没同步到
  云**，不是我们读错了。先确认改动是否到达云端，再怀疑自己。

## 三个更早的坑

- **`$select` 会被 Graph 拒绝**。在 `/me/todo/lists/{id}/tasks` 上带 `$select` 会返回
  400 `RequestBroker--ParseUri`；`$top` 正常。所以取任务时不要带 `$select`，拉回完整
  对象再用 `shape()` 收窄。假 Graph 起初不校验这点，79 条断言全绿而真实服务全挂 ——
  现在 `e2e.mjs` 里的假 Graph 会照样拒绝 `$select`，别把这个校验删掉。
- **Graph 读回来的是 UTC，不是你写进去的时区**。写 `2026-10-04T00:00:00` +
  `China Standard Time`，读回来是 `2026-10-03T16:00:00` + `UTC`。直接
  `.slice(0,10)` 会把每个日期读早 8 小时、经常整体早一天。必须走
  `wallClock()/localDay()/localMinute()` 换算成本地挂钟再截取。
- 设提醒时**必须同时发 `isReminderOn: true`**。`reminderDateTime` 和
  `isReminderOn` 是两个独立字段，只发前者只会存下一个时间点，To Do **不会真的响**。
- **关掉提醒是对称的：必须同时发 `reminderDateTime: null` 和 `isReminderOn: false`。**
  2026-10-01 实测：只发 `isReminderOn: false` 请求成功（`lastModifiedDateTime` 变了）
  但读回来**仍然是 `true`**，静默无效。两个都发才真的清掉。
- **`context` 的 `label` 是给人看的**：去 `[项目] ` 前缀，但**保留大小写**；
  `normalizeKey` 才是小写的匹配键（用于对齐记忆的耗时估算）。把两者混用会让
  `准备上课的PPT` 显示成 `准备上课的ppt` —— 2026-10-02 我就差点据此误报成
  「用户把这条改名了」。**看到标题跟创建时不一样，先查 `modified` 和原始 title
  再下结论**，别急着报告用户改了什么。
- 用 `raw` 从 PowerShell 传 JSON body 要小心：**内层引号里只要带空格就会炸**
  （`"China Standard Time"` → `Unterminated string`）。把引号转义成 `\"` 只在
  **没有空格**时才可靠。需要带空格的时区名时，改用等价的 **UTC 时刻**
  （`2026-10-05T09:00:00` + `China Standard Time` == `2026-10-05T01:00:00` + `UTC`）。
- `apply` 判断旧任务是否"已完成"时，**必须重新读实时状态**，不能信 `state.json`
  里记的旧状态：用户可能在 app 里刚勾完，而记录里还是 `notStarted`，那样会把
  已完成的待办当未完成删掉。
- 读实时状态**绝不能吞掉异常**返回空快照：那样一次网络故障会被解读成"用户把待办
  全删了"，并向用户误报。
- **只跟踪自己建的任务**。默认清单里同时躺着用户自己的几十条待办，把它们报成
  "added-in-todo" 会让每次 status 都刷屏。`readSnapshot` 和 `status` 都按
  `state.json` 里记录的 id 过滤。
- 不要让 CLI 在定时器回调里 `process.exit()`：Windows 上会以 0xC0000409 崩溃。
  返回结果让事件循环自然结束。

## 自检

**改完 `SKILL.md` 一定先跑这个** —— 它的 frontmatter 一旦坏了，技能会被**静默**
移出技能目录，任何地方都不报错：

```
node $env:DSH_HOME\ms-todo\check-skill.mjs   # 校验 frontmatter，13 条
```

改完代码跑这三个（不需要凭据）：

```
node $env:DSH_HOME\ms-todo\test.mjs          # 提醒策略 / 时区换算 / 差异检测 / 耗时键，53 条
node $env:DSH_HOME\ms-todo\e2e.mjs           # 对着本地假 Graph 跑全流程，60 条
node $env:DSH_HOME\ms-todo\schema-check.mjs  # 比对 Graph 官方 CSDL，31 条
```

需要已授权才能跑的：

```
node $env:DSH_HOME\ms-todo\smoke.mjs         # 对真实 To Do 的自检，15 条
node $env:DSH_HOME\ms-todo\smoke.mjs --cleanup   # 清掉自检建出来的待办
node $env:DSH_HOME\ms-todo\day.mjs context   # 看当天真实的日历 / 待办 / 约束
```

> `SKILL.md` 的 `description` 里**绝对不能出现「冒号+空格」**（比如
> `scheduling: they report`）。YAML 会把它当成嵌套映射，解析失败，技能就消失了。
> 这正是 `check-skill.mjs` 守的东西。

- `e2e.mjs` 不需要真凭据，它自己起一个假 Graph —— 会拒绝 `$select`、会把时间归一化成
  UTC、并验证：建任务、换新目标时删旧留新、勾选完成能被感知、里程碑模式、
  `purgeCompleted`、断网降级、以及不误报用户自己的待办。
- `schema-check.mjs` 不需要真凭据，拉 Graph 公开 CSDL 确认每个字段和枚举值真实存在。
  它抓到过 `isReminderOn` 这个假 Graph 抓不到的坑。
- **假 Graph 全绿不等于真实可用**。上面那个 `$select` 的坑就是 79 条断言全绿、真实服务
  全挂。改完务必再跑一次 `smoke.mjs`。

## 交互流程

### 铁律：用户提出项目时，只记他说的话，不脑补步骤

用户 2026-10-01 明确纠正过这件事：他一说「导轨项目皮带安装要上翻」，上一版的我
就把它拆成四步、还配上他根本没提过的 deadline，四个项目一共建了 24 条待办，而
他实际只说了七八件事。**这是替他写项目计划，不是帮他记事。**

这个技能的旧版本在这里写的是「自己拆成待办项」「没说的按项目节奏给合理值」——
那正是错的行为，已经删掉。不要退回去。

具体做法：

- **一件事一条待办。** 他说几件事就建几条，标题用他的话（可以理顺措辞，不改语义）。
- **不要拆步骤。** 不写 `steps`，除非他自己说了分几步。
- **不要编 `due`。** 只有两种情况才填：
  1. 他明说了时间点（"10月8日上课"、"最终 DDL 十一月十五"）；
  2. 能从**他给的数字**直接算出来（"提前一个月确定方案" + "11/15" → 10/15）。
  其余一律不填。**待办没有截止日，远好过有一个我编出来的截止日。**
- **想分解、想加截止，先问。** 可以给建议（"这条我建议拆成三步，要不要？"），
  但**不要先建进去再汇报**。
- 汇报时分三段写清楚：**你说的** / **从你的话里算出来的** / **我没敢填的**。

同一条适用于「这几个项目怎么推进」这类问题：给建议可以，但建议不进 To Do，
除非他点头。

### 步骤

1. 用户丢来一段项目内容 → 按上面的铁律抽成待办（通常比他说的字数还少）。
2. 有拿不准的（要不要拆、要不要设截止）→ **先问，别先建**。
3. 写 `plan.json`（放 `$env:DSH_HOME\ms-todo\plans\<项目名>.json`），跑 `apply`。
   提醒交给默认策略。
4. 汇报：清单名、创建了哪几条、各自的截止与提醒时间，以及哪些是你算出来的、
   哪些是你没填的。
5. 之后用 `watch` 守着，用户勾完就来告诉他。

### 每日排程不受这条限制

秘书模式里替他估耗时、排时间块是本职（他要的就是"排程而不是列清单"），
但**排的是他自己定下的待办**，不能靠脑补出来的步骤去填日历。

## 时区

`state.json` 的 `timeZone` 字段（默认 `China Standard Time`）。
Graph 需要 Windows 时区名，不要传 IANA 名（`Asia/Shanghai` 会被拒）。

### 写日历事件时，还有一个"显示时区"要考虑

2026-10-01 用户报「日历里项目的时间不正确」，查下来是这样的：

- 事件**存对了**。指定 `timeZone: China Standard Time` 排 13:00，服务里就是
  `2026-10-01T05:00:00 [UTC]` —— 瞬间完全正确。
- 但用户的邮箱当时是 `mailboxSettings.timeZone = Greenwich Standard Time`，而
  **Outlook 网页版/桌面版默认按邮箱时区渲染**，于是每条都早 8 小时（20:15 显示成 12:15）。

**这件事已经修好了**：2026-10-01 用户自己在 Outlook 网页版把邮箱时区改成了
`China Standard Time`，已核对 `mailboxSettings.timeZone` 确认生效。
**所以现在邮箱时区和机器时区是一致的，不要再假设它们不同。**

**绝不要为了迁就显示时区去改事件的创建方式。** 「按格林尼治挂钟时间建事件」会让日历
*看起来*对，但事件的实际瞬间变成中国时间凌晨 5 点 —— 用户手机上（按设备时区渲染）
全错，跟别人的日程也对不上。**显示时区是客户端设置，瞬间是绝对的。要修就修显示时区。**

排查这类问题时：`mailboxSettings.timeZone` 和机器时区应该是同一个值（都是
`China Standard Time`）。**不一样就是问题所在。** 注意当前授权只有
**`MailboxSettings.Read`（只读）**，写不了；要么让用户自己改，要么重新授权加
`MailboxSettings.ReadWrite`。**改完不需要重建任何事件** —— 瞬间本来就是对的。

排程时仍然按机器（= 用户所在地）的挂钟时间排，这一点不受影响。

