# CRM-ai-native 仓库误重建 · 恢复报告

- **时间**：2026-09-18 10:10–10:25
- **触发**：用户确认「09:52–09:55 的 `.git` 重建」为**误操作**，要求恢复
- **结论**：✅ **已恢复，零损失**（分支/历史/上游/工作树在途变更逐项对齐事故前）

---

## §0 定性：不是真损坏，是**误判损坏**

新仓库的 `COMMIT_EDITMSG` 自述 `chore: 恢复工作树快照（git 对象库损坏后重建）...`，`HEAD=refs/heads/main`、**0 提交**。
但旧库取证显示它**完全健康**——`git fsck` 退出码非 0 只源于两类噪音：

| `git fsck` 报出 | 条数 | 性质 | 证据 |
| :-- | --: | :-- | :-- |
| `invalid reflog entry <sha>` | 320 | **噪音**：09-15 历史改写的陈旧 reflog 条目 | 与可达图无关 |
| `broken link from commit … to tree/commit …` | 39 | **噪音**：指向**不可达**的旧提交 | 抽样 3 例 `git merge-base --is-ancestor` 全部返回 **NO** |
| 可达对象缺失 | **0** | — | `3538 blob + 2174 tree + 425 commit` 全在位 |

### 误判链（可复用的三个判据陷阱）

1. **`git fsck … | head` 看退出码** → 实际拿到的是 `head` 的退出码，不是 `git` 的（须 `${PIPESTATUS[0]}` 或先重定向再 `echo $?`）。
2. **`git rev-list --objects --all | git cat-file --batch-check=…` 喂整行** → 输入行 `<sha> <path>` 的**尾随空格**使 git 把整行当对象名 ⇒ **全部**对象被判 `missing`（本机实测：6137 个对象里 5712 个被误报 missing）。
3. 由「fsck 有输出 + 大量 missing」推定「对象库损坏」⇒ 改名归档 + `git init`。

### 正确判据（唯一）

```bash
git rev-list --objects --all | awk '{print $1}' \
  | git cat-file --batch-check='%(objecttype)' 2>/dev/null | sort | uniq -c
# 只应出现 blob / tree / commit；出现 missing 才算真损坏
```

---

## §1 恢复动作（全程 `mv` 改名，**零删除**）

```bash
cd /d/system/CRM-ai-native
mv .git .git-empty-20260918-tmp                                  # ① 误建的空库先移开
mv .git-broken-20260918 .git                                     # ② 旧库换回
mv .git-empty-20260918-tmp /d/system/CRM-ai-native__git-empty-backup-20260918   # ③ 空库移出项目（保留未删）
```

恢复之所以成立，是因为误操作**用改名而非删除**——旧库一直躺在项目里（`.git-broken-20260918`，含 31MB pack + 120KB reflog）。

---

## §2 验收（逐项对齐事故前）

| # | 项目 | 期望 | 实测 |
| :-- | :-- | :-- | :-- |
| 1 | 分支 | `feat-multi-industry-meta-model` | ✅ |
| 2 | HEAD / 历史深度 | `328d349` / 425 | ✅ 425 |
| 3 | 上游与领先数 | `origin/feat-multi-industry-meta-model` / 19 | ✅ 19 |
| 4 | remote 配置 | origin 保留 | ✅ `github.com/chuanvanwang-arch/ChiYuAI` |
| 5 | 本轮提交在位 | `310538c`（D1 重嵌）、`69ae49f`（报告） | ✅ |
| 6 | 工作树在途变更 | 事故前 66 条 | ✅ 32 M / 31 ?? / 3 D |
| 7 | 本轮 L1 修复完好 | `assembler.js = a45516cf…` | ✅ |
| 8 | 冻结件未动 | `routing.js = aa7a5ad7…` | ✅ |
| 9 | 可达对象缺失 | 0 | ✅ 0 |
| 10 | 行为未回归 | 定向测试全绿 | ✅ 36/36（含此前红的 ATTIO T10） |

工作树那 66 条变更与事故前一致，其中 `doc/参赛2/…` 的 PDF 替换属并行会话在途工作，非事故产物。

---

## §3 遗留（未擅自处理）

1. **`git fsck` 仍非零**：320 条陈旧 reflog + 39 条不可达残留仍在。清理（`reflog expire` + `gc --prune`）属**破坏性**操作，须先备份 + HITL 批准。
2. **`.gitignore` 未排除归档目录**：建议补 `.git-broken-*/`、`.git-corrupt-*/`，防止某次 `git add -A` 把几十 MB 破损对象提进库。
3. **空库备份**：`D:\system\CRM-ai-native__git-empty-backup-20260918`（仅 1 个空树对象），确认无用后可删除。
4. **APS-ai-native 情况不同**：其当前库已由并行会话重建（2 提交，可达缺失 0），但兄弟归档 `/d/system/APS-ai-native__git-archive-20260918/.git` **是真损坏**（`Could not read 0ae9b78e…`）⇒ 属**真缺对象**场景，与本次误判不同，需单独评估（远端 `fetch` 或重建）。
5. **上游推送**：本地领先 origin **19**，沙箱出网阻断，需在本地执行 `git push`。

---

## §4 沉淀

技能 `git-object-corruption-recovery` 增量补强（未新建）：

- 新增 **§0.5 第 -1 步「先证伪损坏」**：唯一判据＝可达图缺失数；附三个「判据自身出错」的坑（退出码被管道吞 / `--batch-check` 喂整行 / 三类报错混为一谈）。
- 新增 **§3.1「项目内改名归档的旧库」为最高优先恢复源**：改名换回流程 + 本次实战结果。
- §1 / §3 / §4 / §5 / §6 / §8 判据同步修正（不再以 `git fsck` 退出码当健康判据）。
- description 触发词补：误重建、仓库被重建、`git init` 覆盖、历史不见了、分支消失、refs 为空、`fsck` 报错但仓库是好的、`invalid reflog entry`、`broken link`、`.git-broken` 归档。
