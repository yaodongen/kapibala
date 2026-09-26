# Changelog · 更新日志

All notable changes to Kapibala, newest first. One entry per released version: date, version, one line per language. Dates follow the commit date of that version in git.

## 1.11.0 — 2026-09-26

- A third calendar view, Calendar (custom), where you drag across the days to pick the span you want — up to 36 days, laid out three to six to a row — and it stays picked: the range is stored as real dates in `ui.json`, so the next time you open the app, or come back from another list, it is still that calendar, with the earliest day of the range on the first row. The sidebar entry shows the span underneath it, and the toolbar can pick a new range, clear it, or change the columns per row. The three calendar views now share one set of preferences: window size and whether the detail pane is collapsed are the same in 7d, 14d and custom. The range picker opens on the current month, and its Back to today button is gone.
- 新增第三个日历视图「日历视图（自定义）」：在日期上划过去选出想看的那几天（最多 36 天，一行放 3~6 列），选中之后就一直作数 —— 范围按绝对日期存进 `ui.json`，下次打开、或者从别的列表切回来，看到的还是这段日历，而且范围里最早那天就在第一行。侧栏那一项下面显示范围，顶栏可以重选范围、清空范围、改每行几列。三个日历视图现在还共用一份配置：窗口大小、详情栏收没收起，7d / 14d / 自定义都是同一个样子。重选范围时从当前月份看起，那一屏的「回到今天」按钮去掉了（进来本来就停在那儿）。

## 1.10.0 — 2026-09-26

- Kapibala runs on Windows now. Closing the window hides it to the system tray instead of quitting — right-click the tray icon and pick Quit to really exit — and the window buttons are drawn by Windows itself, so the app keeps the same borderless look as on the Mac. Local data lives in `%APPDATA%\Kapibala`, and every release from now on ships a Windows installer (`Kapibala-<version>-x64-setup.exe`) next to the macOS dmg. The sync wording is no longer Mac-and-iCloud specific: put the vault folder in OneDrive, Dropbox, Nutstore or iCloud Drive and your tasks follow you across machines; `Ctrl+Enter` closes the note editor on Windows.
- 支持 Windows 了。关掉窗口会收进系统托盘而不是退出（右键托盘图标选「退出」才真的退出），窗口按钮交给系统画在右上角，界面和 Mac 上一样没有标题栏；本机数据放在 `%APPDATA%\Kapibala`，以后每个版本都会同时出一个 Windows 安装包（`Kapibala-<版本>-x64-setup.exe`）和 macOS 的 dmg。同步相关的文案也不再写死 Mac 和 iCloud —— 库放进 OneDrive、Dropbox、坚果云或 iCloud Drive 都行，多台设备共用一个文件夹即可；Windows 上收起备注编辑框是 `Ctrl+Enter`。

## 1.9.1 — 2026-09-26

- Both side panes can be collapsed to give the task list or the calendar the whole window: the `«` button at the right of the sidebar header hides the sidebar (a `☰` button at the front of the main header brings it back), and the `»` button at the right of that header hides the detail pane. Both states are remembered in `ui.json`, and while the detail pane is hidden clicking a task only selects it instead of pulling the pane back.
- 左右两侧栏都能收起了，专心看任务列表或日历时可以把窗口全让出来：侧边栏品牌行右端的 `«` 收起侧边栏（收起后主区标题行最前面出现 `☰`，点它展开），标题行右端的 `»` 收起详情栏。两个状态都记进 `ui.json`，详情栏收着时点任务只换选中，不会把详情栏拽回来。

## 1.9.0 — 2026-09-25

- The app reopens on the list you left it on — Today, Next 7 days, Next 30 days, Calendar 7d, Calendar 14d or All, remembered in `ui.json`, with the window size for that view; Completed and Trash are never remembered, and switching vaults keeps you on the same list. A task can be marked important from the right-click menu, which gives its row a red bar and a faint red tint in both the list and the calendar, and the next occurrence of a recurring task inherits the mark. The right-click menu drops Notes and Complete (notes live in the detail pane, completing is the circle at the start of the row) and the Doing item now reads Mark Doing / Unmark Doing.
- 打开会回到上次停的那个列表（今天 / 最近 7 天 / 最近 30 天 / 日历 7d / 日历 14d / 全部，连同那一屏的窗口大小记进 `ui.json`；已完成和垃圾桶不记，切库也沿用同一屏）；任务可以标记为「重要」，列表和日历里那一行给左侧一道红竖条加极淡红底，周期任务勾完成时派生的下一个实例继承这个标记；右键菜单去掉「备注」和「完成」（备注在详情栏写、完成点行首的圆圈），「Doing」改叫「标记 Doing / 取消 Doing」。

## 1.8.1 — 2026-09-25

- Tasks can be reordered by dragging: in a calendar cell or in a date group in the list, drop the row where you want it and a 2px line shows exactly which task it will land in front of; dragging it onto another day reschedules it and puts it at that spot, the list scrolls by itself when you drag near its edge, and a newly added task goes to the end of its day instead of into the middle of a hand-sorted list.
- 任务可以拖动排序了：日历格子和列表的日期分组里都能拖，落点画一根 2px 的横线，指到哪条任务前面就插到哪；拖到别的天就是改期并顺手排到那个位置，拖到列表上下边缘会自动滚；新加的任务落在当天末尾，不再插进手排过的顺序中间。

## 1.8.0 — 2026-09-25

- Added a "completed" switch to the calendar views (7d and 14d, remembered in `ui.json`): turn it on and each cell also lists the tasks finished that day, placed by the day you completed them and with the most recently finished on top; the dark-mode switch moved to the bottom-left corner next to the version number.
- 日历视图新增「显示已完成」开关（7d / 14d 共用，状态记进 `ui.json`）：打开后每格也会列出那天完成的任务，按完成日归格、最后完成的排最前；夜间模式的开关挪到左下角版本号旁边。

## 1.7.2 — 2026-09-25

- Added an "in progress" mark: right-click a task to set it, and its row lights up in the list with a `Doing` badge until you complete or trash the task; calendar rows now keep the title on one line with an ellipsis (the full title is in the tooltip), cells in a row share the same height, and an in-progress task shows its `Doing` badge in the top-right corner of its cell.
- 新增「进行中」标记：右键任务即可标记，列表里那一行会高亮并带上 `Doing` 徽标，勾完成或删进垃圾桶时自动取消；日历里的标题改成一行加省略号（全文在悬浮提示里），同一行的格子高度对齐，进行中的任务在格子右上角显示 `Doing` 徽标。

## 1.7.1 — 2026-09-25

- Added two tiled calendar views (7d and 14d) that lay the days out as cells with overdue in its own cell, and you can drag a task from one day to another to reschedule it; the bottom-left corner now shows the version number (clicking it opens the log), and window size is remembered separately for each calendar view.
- 新增两个平铺的日历视图（7d / 14d），逾期单独占一格，可以把任务从一天拖到另一天改期；左下角显示版本号（点它就是查看日志），窗口大小按视图分别记住。

## 1.7.0 — 2026-09-15

- Finishing a recurring task now moves the detail pane on to the next occurrence once the finished one has faded out of the list, and the divider between the list and the detail pane can be dragged to widen it — the width is remembered in `ui.json`.
- 完成周期任务后，列表里那条淡出、详情栏自动跟到下一个周期；列表和详情栏之间的分隔线可以拖动加宽，宽度记进 `ui.json`。

## 1.6.1 — 2026-09-13

- Fixed the note preview in the list crawling upwards line by line while scrolling (browser scroll anchoring miscalculated on a full re-render; the list now anchors the topmost visible task itself and `.list` sets `overflow-anchor: none`).
- 修好点列表里的备注预览会一行行往上跑（整块重建时浏览器 scroll anchoring 算歪锚点，改成自己锚住视口最上面那条任务并关掉 `.list` 的 `overflow-anchor`）。

## 1.6.0 — 2026-09-13

- Added a dark mode that follows your Mac until you touch the theme switch, then sticks to your choice in `ui.json`; the toggle sits at the top right of the list, and the theme is decided before the window is created so the first frame never flashes.
- 支持夜间模式，没碰过开关就跟系统、切过就固定并存进 `ui.json`；主题开关放在列表页右上角，建窗口前先定好主题免得第一帧闪。

## 1.5.3 — 2026-09-13

- Notes in the detail pane now support `- [x]` checklists with centred checkboxes, and changing the repeat days in the detail pane no longer leaks into the default repeat of newly created tasks.
- 详情页备注支持 `- [x]` 任务清单（勾选框居中）；修好详情页改重复天数会串成新建任务的默认重复。

## 1.5.2 — 2026-09-13

- Blank lines in detail-pane notes are preserved — press Enter five times and you keep five lines — and an empty list item also counts as a blank line.
- 详情页备注的空行不再被压掉，按几个回车就留几行；空列表项也按空行算。

## 1.5.1 — 2026-09-13

- The Completed view groups by the day you finished a task with the time of day on the left of each row, and titles in the list are no longer struck through.
- 已完成列表按完成日期分组、行首显示完成时间，列表里的标题不再划删除线。

## 1.5.0 — 2026-09-11

- The calendar and repeat dropdown in the detail pane open on the first click, and the detail pane follows along after a task is created.
- 详情栏的日历和周期下拉第一下点不开；新建任务后详情栏跟着切过去。

## 1.4.3 — 2026-09-08

- Clicking into the notes now closes any in-progress title edit first, so the first click types.
- 点备注要先关掉正在编辑的标题，否则第一下打不了字。

## 1.4.2 — 2026-09-06

- Fixed the Dock icon looking a size too big because the artwork filled the whole canvas.
- 修好 Dock 图标铺满画布显得比系统应用大一圈。

## 1.4.1 — 2026-09-04

- The app opens on "Next 7 days", and clicking a second time no longer drops you out of title editing.
- 打开默认停在"最近 7 天"；点第二下不再退出改标题。

## 1.4.0 — 2026-09-02

- Reading another device's changes now shows a cover that lifts by itself once the read finishes.
- 读别的设备的改动时盖一层挡板，读完自动收。

## 1.3.2 — 2026-08-30

- Added a "last day of every month" repeat preset, and shortened the fade-out after completing a task from 1 second to 450 ms.
- 重复预设加一条"每月最后一天"；勾完的淡出从 1 秒缩到 450ms。

## 1.3.1 — 2026-08-30

- Click anywhere in the notes and the caret lands right there, and clicking a link no longer navigates the app away.
- 点备注哪里，光标就停在哪里；修好点链接会把应用导航走。

## 1.3.0 — 2026-08-29

- Custom repeat intervals in days, auto-save, overdue tasks showing their original date, and a fade-out on completion.
- 自定义重复天数、自动保存、逾期显示原日期、勾完淡出。

## 1.2.1 — 2026-08-28

- One click on the circle in the list completes the task.
- 列表里点一下圆圈就能完成任务。

## 1.2.0 — 2026-08-27

- Closing the window only tucks the app away instead of quitting, the trash empties in one click, a Next 30 days view, and the repeat label moved to the end of the row.
- 关窗口只收起来，不退出应用；垃圾桶一键清空、最近 30 天视图、重复标签挪到行末。

## 1.1.0 — 2026-08-26

- The interface speaks English and Chinese.
- 界面支持中英文。

## 1.0.0 — 2026-08-26

- First release: full RRULE repeats, search across titles and notes, and an English version of the docs.
- 第一个正式版：完整的 RRULE、搜索、文档英文版。
