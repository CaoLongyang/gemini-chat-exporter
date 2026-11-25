# Gemini Chat Exporter

**用一段 JS 脚本，导出 Google Gemini 的全部聊天记录（JSON / Markdown，带时间）。**

**中文** · [English](#english)

在浏览器 Console 里粘贴运行即可，不用装扩展、不用装软件。脚本直接调用 Gemini 网页自己使用的内部接口，所以：

- ✅ **导出全部对话**：自动翻页拿到完整的对话列表，不依赖侧边栏是否展开
- ✅ **每条消息带时间**：每个对话还有开始时间和最后更新时间
- ✅ **可以放后台跑**：不点击、不滚动页面，标签页切走、窗口最小化都能继续
- ✅ **断点续传 + 增量更新**：每读完一个对话就存进浏览器本地，中断后再运行只补剩下的；以后再跑只导新对话和有更新的对话
- ✅ **只读**：不会修改、删除你的任何对话

> English: a copy-paste browser-console script that exports **all** your Google Gemini conversations to JSON or Markdown, with timestamps, using Gemini's own internal web API. Runs in a background tab, resumable, read-only.

## 使用方法

1. 用 Chrome 或 Edge 打开并登录 <https://gemini.google.com/app>
   （登录了多个 Google 账号时，先切换到要导出的那个账号）
2. 按 `F12` 打开开发者工具，切到 **Console（控制台）**
3. 复制 [`gemini-export.js`](gemini-export.js) 的**全部内容**，粘贴进去，回车
   （第一次粘贴时浏览器可能要求你先输入 `allow pasting` / `允许粘贴`）
4. 在弹窗里选择导出模式：

| 模式 | 输出 |
|---|---|
| `1` | JSON 打包成 ZIP，每个对话一个 `.json` |
| `2` | Markdown 打包成 ZIP，每个对话一个 `.md` |
| `3` | 所有对话合并成一个 `.json` |
| `4` | 所有对话合并成一个 `.md` |
| `5` | **校验**：只导出当前打开的对话，并和页面上的消息数对比 |

5. 之后就可以切到别的标签页或者最小化，导完会自动下载。
   如果浏览器没有自动下载，点右下角面板里绿色的 **⬇️ 下载** 按钮。

**建议第一次先打开一个很长的对话，用模式 5 校验一下**，确认内容和时间都对，再跑全量。

> **界面语言**：跟随浏览器语言自动切换——中文浏览器显示中文，其他语言显示英文。想强制指定，运行前在 Console 执行 `window.__GX_LANG__ = 'zh'`（或 `'en'`）。

### 长时间后台运行（Edge 用户请看）

Edge 会让后台标签页"睡眠"，冻结里面的一切。二选一：

- 打开 `edge://settings/system`，把 `gemini.google.com` 加入"从不让这些站点进入睡眠状态"
- 或者点面板上的 **🔊 防止 Edge 休眠**（播放一段几乎听不到的声音，浏览器不会冻结正在播放声音的标签页）

### 增量更新

再次运行时，脚本会问是否"增量更新"：

- **确定**：只导出新对话、有更新的对话和上次失败的对话，最后把所有对话（包括以前导过的）一起打包
- **取消**：清空本地进度，全部重新导出

进度保存在浏览器的 IndexedDB（`gemini-export-api`）里。不再需要时，可以在 Console 运行：

```js
indexedDB.deleteDatabase('gemini-export-api')
```

## 导出格式

### JSON

```json
{
  "conversationId": "c_xxxxxxxxxxxxxxxx",
  "title": "示例对话",
  "url": "https://gemini.google.com/app/xxxxxxxxxxxxxxxx",
  "createdAt": "2026-11-18T11:08:20.000Z",
  "updatedAt": "2026-11-25T09:46:40.500Z",
  "exportedAt": "2026-11-25T13:35:47.337Z",
  "turnCount": 2,
  "messageCount": 4,
  "messages": [
    { "role": "user", "time": "2026-11-18T11:08:20.000Z", "content": "……" },
    { "role": "assistant", "time": "2026-11-18T11:08:20.000Z", "content": "……（Markdown 原文）" }
  ]
}
```

### Markdown

```markdown
# 示例对话

> 开始时间：2026/11/18 19:08:20
> 最后更新：2026/11/25 17:46:40
> 消息数：4

## 👤 用户 · 2026/11/18 19:08:20
……
## 🤖 Gemini · 2026/11/18 19:08:20
……
```

ZIP 里还会附一份 `_导出报告.json`，列出失败、未导出、可能不完整的对话（如果有）。

## 已知限制

- **依赖未公开的内部接口**（`batchexecute` 的 `MaZiqc` 和 `hNvQHb`）。Google 改版后可能失效，届时可以用 [`tools/probe.js`](tools/probe.js) 探测新的接口格式。
- **时间按"轮"记录**：接口只给每一轮（一问一答）一个时间，所以同一轮的提问和回答显示同一个时间。
- **只导出文字**：上传的图片、文件，以及 Gemini 生成的图片不会导出。
- **多个回答草稿**：只导出你最终选中的那一条。
- **超长对话的分页**还没有在真实的超长对话上完整验证过，建议先用模式 5 校验。

## 仓库结构

```
gemini-export.js          主脚本（接口版，推荐）
tools/probe.js            接口探测脚本：Gemini 改版后用来找出新的接口格式
legacy/gemini-export-dom.js  旧版：通过点击、滚动页面导出（不带时间、不能后台运行，仅作参考）
DEVELOPMENT.md            开发过程中遇到的困难和解决办法
```

## 安全与隐私

- 脚本完全在你自己的浏览器里运行，数据不会发送到任何第三方服务器。
- 只使用你当前登录的会话去读取**你自己的**对话。
- 在 Console 里粘贴代码前，请先读一遍代码。不要运行来源不明的 Console 脚本。

## 免责声明

本项目与 Google 无关，是非官方工具，仅用于导出你自己的数据。使用内部接口可能不符合服务条款的某些要求，请自行判断并承担风险。

## License

[MIT](LICENSE)

---

<a id="english"></a>

## English

**Export every Google Gemini conversation with one paste-in script — JSON or Markdown, with timestamps.**

Paste it into the browser Console on <https://gemini.google.com/app>. No extension, nothing to install. The script calls the same internal endpoints the Gemini web app itself uses, so:

- ✅ **Every conversation** — it paginates through the full list instead of relying on the sidebar being expanded
- ✅ **Timestamps everywhere** — every message, plus a start time and a last-updated time per conversation
- ✅ **Runs in the background** — no clicking, no scrolling; switching tabs or minimizing the window is fine
- ✅ **Resumable and incremental** — each conversation is saved in your browser as it is read; a later run only fetches new or updated conversations
- ✅ **Read-only** — it never modifies or deletes anything

> 中文说明见[上半部分](#gemini-chat-exporter)。

### Usage

1. Open <https://gemini.google.com/app> in Chrome or Edge and sign in
   (with several Google accounts, switch to the one you want to export first)
2. Press `F12` and open the **Console** tab
3. Copy all of [`gemini-export.js`](gemini-export.js), paste it in, press Enter
   (the first paste may require you to type `allow pasting` first)
4. Pick a mode in the dialog:

| Mode | Output |
|---|---|
| `1` | JSON as a ZIP — one `.json` per conversation |
| `2` | Markdown as a ZIP — one `.md` per conversation |
| `3` | all conversations in a single `.json` |
| `4` | all conversations in a single `.md` |
| `5` | **verify** — export only the open conversation and compare its message count with the page |

5. Switch tabs or minimize; the download starts when it finishes. If nothing downloads, click the green **⬇️** button in the panel at the bottom right.

**Run mode 5 on a very long conversation first** to confirm the content and timestamps look right before a full export.

### UI language

The interface follows your browser language: Chinese browsers get Chinese, everything else gets English. To force it, set `window.__GX_LANG__ = 'en'` (or `'zh'`) in the Console before running.

### Long background runs (Edge)

Edge puts background tabs to "sleep" and freezes everything inside them. Do one of these:

- Open `edge://settings/system` and add `gemini.google.com` to "Never put these sites to sleep", or
- Click **🔊 Keep tab awake** in the panel — it plays near-inaudible audio, and browsers do not freeze a tab that is playing sound

### Incremental updates

On a second run the script asks whether to update incrementally:

- **OK** — export only new conversations, updated conversations and ones that failed last time, then package everything (including what was exported earlier)
- **Cancel** — clear the saved progress and export everything from scratch

Progress is kept in the browser's IndexedDB (`gemini-export-api`). To remove it when you no longer need it:

```js
indexedDB.deleteDatabase('gemini-export-api')
```

### Output format

#### JSON

```json
{
  "conversationId": "c_xxxxxxxxxxxxxxxx",
  "title": "Example conversation",
  "url": "https://gemini.google.com/app/xxxxxxxxxxxxxxxx",
  "createdAt": "2026-11-18T11:08:20.000Z",
  "updatedAt": "2026-11-25T09:46:40.500Z",
  "exportedAt": "2026-11-25T13:35:47.337Z",
  "turnCount": 2,
  "messageCount": 4,
  "messages": [
    { "role": "user", "time": "2026-11-18T11:08:20.000Z", "content": "…" },
    { "role": "assistant", "time": "2026-11-18T11:08:20.000Z", "content": "…(Markdown source)" }
  ]
}
```

#### Markdown

```markdown
# Example conversation

> Started: 2026-11-18, 19:08:20
> Last updated: 2026-11-25, 17:46:40
> Messages: 4
> Source: https://gemini.google.com/app/xxxxxxxxxxxxxxxx

---

## 👤 User · 2026-11-18, 19:08:20
……

## 🤖 Gemini · 2026-11-18, 19:08:20
……
```

ZIP exports also contain `_export-report.json`, listing any conversations that failed, were not exported, or may be incomplete.

### Known limitations

- **Depends on undocumented internal endpoints** (`MaZiqc` and `hNvQHb` in `batchexecute`). A Google redesign can break it — use [`tools/probe.js`](tools/probe.js) to discover the new request format.
- **Timestamps are per turn**: the API only returns one timestamp per question/answer pair, so both messages in a turn share the same time.
- **Text only**: uploaded images and files, and images generated by Gemini, are not exported.
- **Multiple response drafts**: only the one you finally selected is exported.
- **Pagination for very long conversations** has not been fully validated against real oversized conversations; run mode 5 first.

### Repository layout

```
gemini-export.js              main script (API edition, recommended)
tools/probe.js                endpoint probe — find the new request format after a Gemini redesign
legacy/gemini-export-dom.js   older edition: clicks and scrolls the page (no timestamps, no background run, reference only)
DEVELOPMENT.md                build notes: the problems hit and how they were solved (Chinese)
```

### Security and privacy

- Everything runs in your own browser. No data is sent to any third-party server.
- It only uses your current signed-in session to read **your own** conversations.
- Read the code before pasting anything into a Console. Never run Console scripts from unknown sources.

### Disclaimer

Not affiliated with Google. This is an unofficial tool, intended for exporting your own data. Using internal endpoints may conflict with parts of the Terms of Service — use at your own discretion.

### License

[MIT](LICENSE)
