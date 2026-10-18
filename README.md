# dsh-slipway（滑道）

**把本地 DSH 插件工程一条命令发到 GitHub、再开一条市场收录 PR，最后把线上文件逐个拉回来比 sha256。**

> 名字的来由：船造好了得从滑道下水。前面三个作品每发一次，我都要手写同一串脚本 ——
> 建仓库 → 逐文件 PUT（还要比字节数）→ 打 topic → fork 建分支 → 写登记 yml → 开 PR →
> 线上逐文件回拉核对。三遍下来每次都掉同一个坑。这活该由代码干。

---

## 它做什么

**适用范围（一句话）：只走 GitHub。** 仓库建在 GitHub、文件传到 GitHub、市场收录 PR 也开在 GitHub 上。
**GitLab / Gitee / npm 都没有适配** —— 想发到别的平台，得先有那条平台的 API 与 token（见「已知限制」）。

一次调用走完四个阶段，每个阶段都留下可核对的证据：

| 阶段 | 做什么 | 证据 |
| --- | --- | --- |
| **① 自检** | 读 `package.json`、按 `files` 白名单收集文件、查 `main`/`exports`/`dsh.bundle.patch` 是否落地、扫密钥 | 文件数、总字节、错误/提醒清单 |
| **② 仓库** | 有就复用、没有就建（`auto_init:false`） | 仓库 URL、默认分支 |
| **③ 上传** | 逐文件 PUT（带 sha 的更新式写入），然后设 topics | 每个文件的字节数与 blob 短 sha |
| **④ 市场 PR** | fork（若无）→ 从上游 head 建分支 → 写 `data/plugins/<owner>__<repo>.yml` → 开 PR | PR 号与状态（已有 PR 就报它的号，不重复开） |
| **⑤ 回验** | 把线上每个文件拉回来，与本地比 **sha256 与长度** | 「N 个文件线上字节与本地完全一致」 |

## 安全边界（代码里的边界，不是口头承诺）

- **默认 dry-run**：不显式传 `dryRun: false`（CLI 是 `--go`）就只演算、只报告，**一根手指都不动远端**。
- **目标必须显式给**：`projectDir`（绝对路径）/ `repo` / `category` / `descriptionEn` / `descriptionZh` 缺一不可。
  解析不出来就**报错**，绝不从当前目录、包名或相似度去猜。
- **owner 与 token 必须对得上**：token 属于别人 —— 直接停，不做任何请求。
- **token 永不进输出**：只出现 `ghp_****(40)` 这样的掩码；请求证据里只记方法与路径，**不记 body**。
- **密钥扫描在自检里**：命中 `sk-…` / `ghp_…` / 私钥块等即**阻断发布**，且只报文件:行号与掩码，**不回显明文**。
- **幂等**：仓库、分支、PR 都先查再说；重复跑不会造出第二条。
- **活代码树警告**：工程若被 profile 的 junction 挂载（即"活代码"），报告里会出现 `live-tree` 提醒 ——
  **发布可以，测试绝对不许在那里跑**（把副本复制到沙箱再跑）。

## 安装

市场收录后：在 DSH 里搜 `dsh-slipway` 安装即可。手动安装：

```powershell
# 1) 建目录链接（junction 不需要管理员）
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-slipway" -Target "D:\dsh\projects\dsh-slipway"
# 2) profile 的 package.json：dependencies 加 "dsh-slipway": "link:D:/dsh/projects/dsh-slipway"
#    **同时**加进 dsh.profile.bundles（漏了就不加载）
# 3) 重启 DSH
```

## 用法

### 作为工具（Agent 用）

```
slipway_publish   projectDir=… repo=… category=tools descriptionEn=… descriptionZh=… [dryRun]
slipway_verify    projectDir=… repo=… owner=…
```

典型流程：先 `dryRun` 跑一次 → 把报告给人看 → 得到许可 → `dryRun: false`。

### 作为命令（不开会话也能发）

```powershell
# 只自检（只读）
dsh-slipway plan    --project D:\dsh\projects\dsh-slipway --repo dsh-slipway --category tools --desc-en "…" --desc-zh "…"

# dry-run（默认）
dsh-slipway publish --project … --repo … --category tools --desc-en "…" --desc-zh "…"

# 真跑
dsh-slipway publish --project … --repo … --category tools --desc-en "…" --desc-zh "…" --go

# 只回验
dsh-slipway verify  --project … --repo … --owner 7gzgn
```

退出码：`0` 成功 / `0` dry-run 通过；`1` 有阻断；`2` 用法错误。

### PAT 从哪来

依次找：`--token-file` → 环境变量 `DSH_SLIPWAY_TOKEN_FILE` → `~/.dsh/.gh-token` → `D:\dsh\.gh-token`。
需要的 scope：`repo`（建仓库、推文件、开 PR）。

### 市场分类白名单

`agi ui usage theme model identity session memory tools wsl browser vision voice docs skill workflow git notify dev security remote market fun`

## 兼容性

- 运行时：**DSH 0.2.0-rc.2**（本人实测使用的版本）。
- `peerDependencies` 用显式范围（`>=0.2.0-rc.2 <0.3.0-0`），下限是实测过的版本，上限不赌没验证过的 breaking change。
- **运行时主动降级**：拿不到 `@deepseek-ai/dsh-tools` 的 `defineTool` → 退化成恒等函数（CLI 与测试场景照常工作）；
  `ctx.systemPrompt` 不存在 → 跳过公告段。宿主 API 有出入时，本插件少一项能力，而不是把 DSH 拖崩。

## 已知边界

- **单文件 ≤ 25MB**：contents API 走不了更大的文件（那需要 Git Data API，v0.1 不做）；>1MB 会给提醒。
- **不做 npm 发布**：DSH 市场大半靠 `github:owner/repo` 安装，npm 不在链路上。
- **不替你跑项目的测试**：测试要不要跑、在哪跑由调用方决定（活代码树里跑测试 = 在真宿主上生效，这是血换来的规矩）。
- **不自动写简介**：市场条目上的中英文简介必须由人给 —— 自动生成的是"看起来像"的话。

## 自测

```powershell
node test/smoke.mjs   # 56 项，全用假 GitHub，不碰网络、不碰宿主
```

测试开头有一道**活代码树自检**：发现自己在 `profiles/*/node_modules` 挂着的工程里跑，就直接 `exit 2`。

## License

MIT
