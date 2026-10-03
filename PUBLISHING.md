# 发布到思源集市：操作手册

> 本文是**给你（发布者）**看的操作手册，不是插件用户文档。
> 目标：把本插件上架到思源官方集市（Bazaar），让用户能在「设置 → 集市」里搜索并一键安装。

---

## 前置条件（必须先满足）

| 项目 | 必需 | 说明 |
| --- | --- | --- |
| **GitHub 账号** | ✅ | 源码仓库与上架申请都在 GitHub 上 |
| **公开的插件仓库** | ✅ | 集市按 `owner/repo@commit` 从对象存储分发，**私人仓库无法分发** |
| **git 命令行** | ✅ | 本机推送用 |
| 思源账号 / 开发者后台 | ❌ | 不存在这种东西，走 GitHub 社区流程 |
| 域名 / 服务器 | ❌ | 除非自建 `updateUrl` 更新源 |
| 赞助渠道账号 | ⭕ | 仅用于集市卡片的赞助入口 |

> 集市**不托管你的包体文件**。它只记录「仓库地址 + commit hash」，
> 然后从对象存储分发对应提交的代码。所以：**推送新提交后必须让索引指向新 hash**，
> 否则用户拿到的还是旧版本。

---

## 两条路径，选一条

| 路径 | 需要 git | 需要 Token | 适合 |
| --- | --- | --- | --- |
| **[推荐] Token + API 全自动** | ❌ 不需要 | ✅ 需要（用完即删） | 一次发布，摩擦最小 |
| [备选] git 推送 | ✅ 需要 | ❌ 不需要 | 需要频繁迭代、习惯 git 流程 |

---

## 推荐路径：用 Token + GitHub API 全自动发布（不需要 git）

这是**摩擦最小**的方式：你只需要创建一个 Token 并设进环境变量，
建仓库、上传代码、打标签全部由脚本通过 GitHub API 完成，**不需要安装 git，也不需要你在对话里粘贴 Token**。

### 1. 创建 Token

1. 打开 <https://github.com/settings/personal-access-tokens/new>（Fine-grained token）；
2. **Token name**：随便，例如 `siyuan-publish`；
3. **Expiration**：建议 7 天（用完即失效最安全）；
4. **Repository access**：选 `All repositories`；
5. **Permissions → Repository permissions**，只要开这两项：
   - **Administration: Read and write**（用于创建仓库）
   - **Contents: Read and write**（用于上传代码）
6. 点 **Generate token**，复制生成的 `github_pat_...`。

### 2. 设进环境变量并运行

```powershell
$env:GH_TOKEN = "github_pat_你刚复制的"
.\scripts\publish-via-api.ps1 -Author "simonshen97"
```

脚本会依次：

1. 校验 Token 并读出你的用户名；
2. **创建公开仓库** `siyuan-plugin-calendar-caldav`（已存在则复用）；
3. 把 `plugin.json` 的 `url` / `author` 填好，并更新 `LICENSE` 版权行；
4. 通过 Git Data API 上传全部文件（**自动排除** `node_modules/`、`dist/`、`.package/`）；
5. 创建 `main` 分支提交并打 `v<版本>` 标签；
6. 打印提交集市申请所需的**仓库地址 / 包名 / commit / 版本**。

### 3. 用完立刻删除 Token

发布完成后回到 <https://github.com/settings/personal-access-tokens> **删掉这个 Token**。
Token 只存在于你的环境变量里，不会被写进任何文件、也不会被打印出来。

---

## 备选路径：用 git 推送（需要先安装 git）

如果你更习惯 git 流程，或需要频繁迭代，用这条。

### 第一步：安装 git

```powershell
winget install --id Git.Git -e
```

安装后**重开终端**，`git --version` 确认。顺手配置身份：

```powershell
git config --global user.name  "simonshen97"
git config --global user.email "你的邮箱"
```

### 第二步：在 GitHub 建一个**公开空仓库**

1. 打开 <https://github.com/new>；
2. **Repository name**：`siyuan-plugin-calendar-caldav`（建议与 `plugin.json` 的 `name` 一致）；
3. 可见性选 **Public**；
4. **不要**勾选 "Add a README file"、".gitignore"、"license"（本地已有，勾了会冲突）；
5. 点 **Create repository**。

> 这一步必须在网页上做（我无法代你登录 GitHub 完成账号操作）。
> 建好后仓库是空的，下面脚本会推送代码进去。

### 第三步：一条命令完成「填字段 + 提交 + 推送 + 打标签」

在项目根目录执行（把 URL 换成你刚建的仓库）：

```powershell
.\scripts\publish-repo.ps1 -RepoUrl https://github.com/<你的用户名>/siyuan-plugin-calendar-caldav
```

脚本会：

1. 校验 git；
2. 把 `plugin.json` 的 **`url`** 填成你的仓库、**`author`** 填成你的署名；
3. 同步更新 `LICENSE` 的版权行；
4. `git init -b main` → 首次提交 → 推送到 `origin/main`；
5. 打标签 `v<版本>` 并推送；
6. 最后打印**提交集市 PR 所需的全部信息**（仓库地址 / 包名 / commit / 版本）。

**可选**：如果你想让脚本自己调 GitHub API 建仓库（省掉第二步的网页操作），
先创建一个 Personal Access Token（勾选 `repo` 权限）：<https://github.com/settings/tokens>，然后：

```powershell
.\scripts\publish-repo.ps1 -CreateRepo -Token ghp_xxxxxxxx -Author "你的名字"
```

> ⚠️ Token 用完请立即在 GitHub 上删除。不要把它写进任何文件或提交。

---

## 第四步：核对仓库内容

推送后确认仓库根目录是这样的（**清单必须在仓库根目录**）：

```
siyuan-plugin-calendar-caldav/
├── plugin.json          ← 必须在根目录
├── package.json
├── LICENSE
├── README.md
├── README_zh_CN.md
├── icon.png
├── preview.png
├── src/
├── scripts/
└── .gitignore           ← 已排除 node_modules/ dist/ .package/
```

同时确认 `plugin.json` 里：

- `url` = 你的仓库地址（已由脚本填写）；
- `author` = 你的署名；
- `version` / `minAppVersion` / `frontends` / `backends` 均已填写。

本地再跑一次发布前检查（全绿才能提交）：

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
node scripts/check-consistency.mjs
node scripts/build.mjs
node scripts/zip.mjs
```

---

## 第五步：向 `siyuan-note/bazaar` 提交上架申请

1. 打开集市索引仓库：<https://github.com/siyuan-note/bazaar>；
2. 点 **Issues → New issue**，选择上架申请类模板（若模板入口有变化，直接用空白 issue 并写明下述信息）；
3. 标题与内容按下表填写（**可直接复制**，把尖括号部分替换掉）：

```
仓库地址：https://github.com/<你的用户名>/siyuan-plugin-calendar-caldav
包名：siyuan-plugin-calendar-caldav
版本：v<版本号>
当前 commit：<脚本打印的 hash>
包类型：plugins
```

4. 提交后等待社区审核。合并后索引更新，用户即可在集市中搜索到。

> **关于入口**：集市的上架入口在历史上调整过（早期为提交 Issue，后来也支持 Pull Request
> 修改 `stage/plugins.json` 索引）。若 Issue 模板不再提供上架选项，就改为向该仓库发 PR，
> 在 `stage/plugins.json` 中追加你的条目（字段形如
> `{"author": "...", "name": "...", "repo": "...", "version": "..."}`）。
> 两种方式都需要 GitHub 账号。

---

## 后续更新流程

每次发版：

1. 修改代码 → 更新 `plugin.json` 的 `version`；
2. 更新两份 README（如有功能变化）；
3. 跑完「第四步」的检查清单；
4. `git commit` + `git push` + 打新标签；
5. **再次提交一次上架申请**（或在原 issue 下留言新 commit hash），让索引指向新提交。

---

## 上架前自检清单

本项目已把大部分检查自动化，提交前确认：

| 检查项 | 命令 / 由谁保证 |
| --- | --- |
| 类型检查通过 | `tsc --noEmit` |
| 单元测试通过 | `vitest run` |
| 清单字段齐全、取值合法（frontends 只用 `all` 等思源认识的取值） | `check-consistency.mjs` |
| 压缩包为「唯一顶层目录 + 清单在内」 | `zip.mjs` + 一致性检查 |
| **不含测试配置 / 凭据 / 个人数据** | 一致性检查（敏感数据扫描） |
| 中英文语言包键数一致 | 一致性检查 |
| `plugin.json` 的 `url` / `author` 已填真实值 | `publish-repo.ps1` |
| 仓库为公开仓库 | 手动确认 |

---

## 常见问题

**Q：集市里搜不到我的插件？**
检查 `plugin.json` 的 `frontends` 是否含思源不认识的取值（`browser` 不是合法值，
合法值只有 `desktop` / `desktop-window` / `mobile` / `all`），以及 `minAppVersion`
是否高于用户当前的思源版本。

**Q：用户装到的是旧版本？**
集市是 hash 驱动的。推送新提交后必须让索引指向新 hash。

**Q：用户反映装不上 / 报「集市包清单文件缺失」？**
说明压缩包结构不对。本项目的 `zip.mjs` 会强制「唯一顶层目录 + 清单在内」，
用本项目脚本产物即可避免。

**Q：能不在集市上架，直接分发 zip 吗？**
可以。用户手动把解压后的 `siyuan-plugin-calendar-caldav/` 放进
`<工作空间>/data/plugins/` 即可（Docker 版放 `/siyuan/workspace/data/plugins/`）。
但这样就享受不到集市的一键安装与更新。

**Q：测试时配的账号/数据库会跟着包发出去吗？**
不会。`plugin.json` 与打包产物里不含任何运行期配置，
且一致性检查会**扫描并拦截**凭据、真实 CalDAV 地址、真实数据库块 ID 等敏感数据。
你的配置保存在工作空间的 `data/storage/petal/siyuan-plugin-calendar-caldav/settings.json`。
