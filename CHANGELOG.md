# Changelog · 更新日志

All notable changes to Kapibala, newest first. One entry per released version: date, version, one line per language. Dates follow the commit date of that version in git.

## 1.11.8 — 2026-10-01

- The custom calendar now names the span you picked instead of keeping its own name: the heading reads `25 Sep – 7 Oct · 13 days`, counting the days for you, and the line under it drops to just the columns since the dates are already up there. Go back to picking a new range and the heading returns to Calendar (custom) — the old range is still the one in effect until you pick another.
- 「日历视图（自定义）」选好范围之后，大标题直接报这段日子本身（`9月25日 – 10月7日 共 13 天`），不再挂着「日历视图（自定义）」这个固定名字 —— 一共几天替你数好了，省得对着格子数；日期上了标题，下面那行小字就只剩「5 列」。点「重选范围」时标题退回固定名字：那时旧范围仍然作数，新的还没选出来。

## 1.11.7 — 2026-10-01

- Clicking an important task no longer turns its row grey — a selected row keeps the same slightly deeper red it shows on hover. Marking a task important now also puts it first on its day, exactly as if you had dragged it there: move it afterwards and it stays where you put it. In the places you cannot reorder by hand — Overdue, Unscheduled, and the calendar's Overdue cell — important tasks float to the top, and the next instance of an important repeating task starts at the top of its day too.
- 重要任务点中之后不再变灰：选中那一行是更深一档的红，和悬浮时一样。标记为重要现在还会把它排到那一天最前面（等于替你拖了一次），之后你想拖到哪儿就是哪儿 —— 手排的位置说了算。手排管不着的那几处（已逾期、未安排、日历的已逾期格）重要的一律置顶，重要的周期任务派生出的下一期也从那天第一条开始。

## 1.11.6 — 2026-09-30

- The "show completed" toggle now belongs to all three calendar views, the custom date range included. Completed tasks stay on **the day they were planned for** instead of moving to the day you ticked them off, so finishing something early no longer shifts it to another cell or makes it vanish from a range that doesn't cover today; within a cell they still sink below the open ones, most recently finished first. When the completion day differs from the day the row sits on, the row now carries that date as well — `✓ 28 Sep 15:00` — so an entry finished early or ticked off later is not mistaken for one finished on its planned day.
- 日历视图的「显示已完成」开关现在三个视图都有，自定义的日期范围那一屏也算在内。已完成的任务一律留在**原来安排的那天**，不再挪到勾掉它的那天 —— 提前做完既不会换格子，也不会从你选的、不含今天的范围里消失；一格之内它们照旧沉在未完成的下面，最近完成的排最前。完成日和这一行所在的那天不是同一天时，行上还会把完成日期带上（如 `✓ 9月28日 15:00`），提前做完或事后补勾都不会被当成当天了结的。

## 1.11.5 — 2026-09-30

- Instance IDs now chain off **the previous instance** instead of off a date, and the next occurrence is counted from **that occurrence's own date** rather than from the moment you tick it off. Dragging an occurrence back onto an earlier day and completing it used to derive a date whose ID was already taken: the app quietly wrote nothing and the series ended right there. Dragging the next one onto today used to spend a future day and push the schedule out a little further each time. Ticking one off on its planned day no longer shoves the schedule out by a whole period, two devices completing the same occurrence no longer derive two different dates, and opening a vault repairs series the old scheme already broke. A day you deleted or emptied from the trash is never resurrected.
- 周期实例的 ID 改成链在**上一期**上（不再是"系列 + 那一天的日期"），下一期也只从**这一期自己的日期**往后算，不再从"你点完成的那一刻"算。以前把派生出来的某一期拖回早先的日子再完成，算出来的日期会撞上已经用过的 ID —— 勾了完成什么都不写，系列从此断掉；把"下一期"拖到今天再勾，又会把未来那一天提前用掉，日期一次比一次往后漂。现在在计划上那一天点完成不会再被推后一个周期，两台机器完成同一次也不会各算出一个日期，打开库还会自愈已经被老写法断掉的系列；你删掉或清空过的那一期一律不复活。

## 1.11.4 — 2026-09-27

- Automatic date detection is now held to a window of this year through ten years out (2026–2036). Anything outside it is left unscheduled, because out-of-range dates are almost always an order number, an amount, or a mistyped year: `991231`, `000630` and `20990630` no longer become dates, and neither does `11 years from now`. A number string split by `-`, `/` or `.` can no longer have a date picked out of its middle, and there is a new reference page listing every supported wording in both languages: [`docs/dates.zh.md`](./docs/dates.zh.md).
- 自动认日期收进了「今年到今年 + 10 年」这个窗口（2026 年就是 2026–2036），超出的不再认 —— 那些几乎都是编号、金额或写错的年份：`991231`、`000630`、`20990630` 不再变成日期，`11年后` 也不认；被 `-` `/` `.` 切开的数字串也不会再从中间抠出一个日期。另加了一份中英文日期时间写法清单：[`docs/dates.zh.md`](./docs/dates.zh.md)。

## 1.11.3 — 2026-09-27

- Compact and dot-separated dates are picked up as well: `20260630`, `260630`, `0630` (this year, or next if that day has already passed) and `2026.06.30` all schedule the task, and a compact time can ride along — `20260630T1930` or `260630 1930`. A four-digit year accepts `-`, `/` and `.` as separators. Note that a bare four-digit number is read as month-day, so `1130` means 30 November rather than 11:30.
- 紧凑写法和点分隔的日期也认了：`20260630`、`260630`、`0630`（今年这天已经过了就算明年）、`2026.06.30` 都能定到日子，后面还能跟上紧凑时刻 —— `20260630T1930`、`260630 1930`；四位数年份后面的分隔符 `-`、`/`、`.` 都行。注意 4 位纯数字按「月日」读，`1130` 是 11 月 30 日而不是 11:30。

## 1.11.2 — 2026-09-27

- Dates and times typed into a task title are picked up and filled in for you — “明天下午3点” and “next Monday at 3pm” alike — so the task lands where you meant without touching either picker. The title itself stays exactly as typed, any box you set by hand is never overwritten, and a new time field beside the date field makes a task timed to the minute; leave it blank and the task stays all-day.
- 标题里写的日期和时间会被认出来、自动填进旁边的日期/时间框 ——「明天下午3点」「下周五」「tomorrow at 9:30am」都认，不用再手动点两个选择器；标题原文一个字不动，你手动改过的框也不会被覆盖。日期框旁边多了一个时间框，填了就是定了点，留空仍是全天。

## 1.11.1 — 2026-09-27

- In the calendar views, the row you are renaming no longer drags: while its title is an input, pressing and moving inside it just selects text, so a half-typed title and the task both stay where they are. Leave the edit (Enter, Esc or a click elsewhere) and the row drags again; dragging rows in the list is unchanged.
- 日历视图里正在就地改标题的那一行不给拖了：标题变成输入框时，按住划一下只是选字，打了一半的标题和这条任务都留在原地；退出编辑（回车 / esc / 点别处）之后又能拖。列表里的拖动照旧。

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
