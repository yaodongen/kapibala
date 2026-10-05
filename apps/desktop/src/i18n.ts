/**
 * 界面文案。主进程和渲染进程共用这一份 —— 右键菜单在主进程、任务列表在渲染进程，
 * 同一句话不能有两份写法。
 *
 * 没有运行时依赖，也不碰 node：渲染进程那一份是 browser 目标的 bundle。
 * 带参数的文案写成函数，不做 "{0}" 这类占位符替换 —— 类型检查抓不到占位符写错。
 */

// 语言这个类型定义在 core 里（重复规则的描述也要按语言走），这里只是转出来
import type { Lang } from '@kapibala/core/rrule'
// 平台只影响两个写法：快捷键提示和"在访达/资源管理器里显示"。i18n 不碰 node，
// 所以由调用方把 preload 给的平台传进来（见 ipc 的 Platform）
import type { Platform } from '@kapibala/ipc'
export type { Lang }
export const LANGS: Lang[] = ['zh', 'en']
export const isLang = (x: unknown): x is Lang => x === 'zh' || x === 'en'

/** 快捷键提示按平台写：Mac 上是 ⌘↩，Windows 上写 Ctrl+Enter 才认得出来 */
const shortcut = (p: Platform) => (p === 'darwin' ? '⌘↩' : 'Ctrl+Enter')
/** 打开日志所在文件夹用的文件管理器名字 */
const fileManager = (p: Platform) => (p === 'darwin' ? 'Finder' : '文件资源管理器')

/**
 * 按平台变的那几句统一放这里（两边语言各一份，形状由 EN: typeof ZH 卡住）。
 * 单列一处有两个好处：写新句子时一眼看到"这一句两个平台都得有说法"，
 * 以及 i18n.test.ts 能把这一组**自动**在两个平台上各过一遍 —— 加句子不用改测试。
 */
const ZH_PLATFORM = {
  notesHint: (p: Platform) => `自动保存 · ${shortcut(p)} 收起`,
  logReveal: (p: Platform) => `在${fileManager(p)}中显示`,
}
const EN_PLATFORM: typeof ZH_PLATFORM = {
  notesHint: (p) => `Saved automatically · ${shortcut(p)} to close`,
  logReveal: (p) => (p === 'darwin' ? 'Show in Finder' : 'Show in File Explorer'),
}

/**
 * 系统语言 → 界面语言。只有明确是英文才用英文，其余（法语、日语、拿不到语言）
 * 一律回到中文。宁可给出一种用户大概率看得懂的语言，也不猜。
 */
export function langOf(locale: string | undefined | null): Lang {
  return /^en(-|_|$)/i.test((locale ?? '').trim()) ? 'en' : 'zh'
}

const ZH = {
  htmlLang: 'zh-CN',
  brand: '卡皮巴拉',

  // ── 侧边栏 ──
  searchPlaceholder: '搜索',
  vaultSwitch: '切换库',
  vaultTip: (path: string, device: string, devices: number) =>
    `${path}\n${device} · 共 ${devices} 台设备\n\n点击切换库`,
  viewLog: '查看日志',
  /** 语言切换按钮上写的是"切过去的那个语言"，所以中文界面上写 English */
  langOther: 'English',
  langSwitchTip: '切换界面语言',
  /** 主题开关的悬停提示写"点了会变成什么"，和语言按钮一个规矩 */
  themeToDark: '切换到夜间模式',
  themeToLight: '切换到日间模式',
  /**
   * 日历视图的「显示已完成」开关。和主题开关一样，提示语写"点了会变成什么"：
   * 打开后格子里会多出打过钩的任务，它们仍在**原来安排的那天**（不是完成那天）
   */
  showDoneOn: '显示已完成的任务',
  showDoneOff: '不显示已完成的任务',
  /**
   * 日历视图的「推演」开关：把周期任务**未来会排到哪几天**也画在格子里（置灰、只读，
   * 勾不了也拖不动）。和上面那个开关一个规矩，提示语写"点了会变成什么"。
   * 不推演的是"完成后 N 天再来"那种 —— 下一期取决于你什么时候勾，算不出来。
   */
  projectOn: '推演周期任务未来的安排',
  projectOff: '不推演周期任务的未来安排',
  /** 推演出来的行、以及格子上那个"几条真实 + 几条推演"里的标记 */
  projectTag: '推演',
  /**
   * 日历视图（自定义）：**选过范围之后，这一屏的大标题就直接报那段日期**，
   * 不再挂着「日历视图（自定义）」这个固定名字（侧栏那一项仍然是它，好认好点）。
   * 范围带上总天数（"9月25日 – 10月7日 共 13 天"）—— 标题本来就该报这段有多长，
   * 免得人对着格子数。副标题因此只剩"每行几列"，日期不重复报。
   * 范围是用户拖出来的，所以都是函数。
   * 天数一律用 ipc 的 calRangeDays 算（跨夏令时那天两个零点差 23 小时，自己除毫秒会少一天）。
   */
  calendarCustom: '日历视图（自定义）',
  calendarCustomRange: (from: string, to: string, days: number) => `${from} – ${to} 共 ${days} 天`,
  calendarCustomSub: (cols: number) => `${cols} 列`,
  calendarCustomNone: '还没有选日期范围',
  calendarCustomPick: '拖选要看的日期范围',
  calendarCustomPickHint: '用鼠标划过去选起止两天。选完就是这一屏的日历，下次打开还是这几天。',
  calendarCustomPicked: (n: number) => `已选 ${n} 天`,
  calendarCustomMax: (n: number) => `最多 ${n} 天，已经卡住了`,
  calendarCustomCols: (n: number) => `${n} 列`,
  calendarCustomLayout: '每行放几列',
  calendarCustomRedo: '重选范围',
  calendarCustomClear: '清空范围',
  /**
   * 「日历视图」—— 真正的月历：一月一块、一周一行（周一到周日），上下无限滚。
   * 名字就用最朴素的那个（旁边的 7d / 14d / 自定义都带括号说明范围，这一屏不用——
   * 它本来就是"日历该有的样子"）。副标题一句话说清它和自定义那屏的区别：
   * 自定义是一次拖出一段固定日子，这一屏是一直往前/往后滚。
   */
  calendarMonth: '日历视图',
  calendarMonthSub: '一月一块，上下滚动看前后几个月',
  /** 月历顶栏那枚按钮：滚到几年以外之后一键回到今天那一行 */
  calendarToday: '回到今天',
  /**
   * 收起/展开两侧栏的按钮提示。和主题开关一样写"点了会变成什么"：
   * 侧边栏那枚长在侧边栏里（收起后整块都不在了），展开那枚长在主区标题行最前面
   */
  sidebarCollapseTip: '收起侧边栏，只看任务',
  sidebarExpandTip: '展开侧边栏',
  detailCollapseTip: '收起详情栏，只看任务',
  detailExpandTip: '展开详情栏，写备注',

  // ── 视图 ──
  today: '今天',
  todaySub: (label: string, wd: string) => `${label} ${wd}`,
  next7: '最近 7 天',
  next7Sub: '按日期分组，逾期置顶',
  calendar7: '日历视图（7d）',
  calendar7Sub: '逾期 + 未来 7 天，4 列 × 2 行',
  calendar14: '日历视图（14d）',
  calendar14Sub: '逾期 + 未来 14 天，5 列 × 3 行',
  next30: '最近 30 天',
  next30Sub: '一个月内的安排，按日期分组',
  all: '全部任务',
  allSub: '所有未完成的任务',
  done: '已完成',
  doneSub: '按完成日期分组，最近完成的排在前面',
  trash: '垃圾桶',
  trashSub: '右键可以恢复或彻底删除',

  // ── 列表 ──
  addPlaceholder: '添加任务，回车保存',
  addDateTip: '日期（可留空）',
  addTimeTip: '时间（留空为全天）',
  /**
   * 进行中任务行上那个徽标。中英文都用 "Doing" —— 列表行很窄，这个位置
   * 放三个字（"进行中"）比放五个字母还占地方，用一个词更清爽。
   * 它只是徽标，右键菜单里仍然是中文的"进行中 / 取消进行中"
   */
  inProgress: 'Doing',
  unmarkInProgress: '取消 Doing',
  noRepeat: '不重复',
  repeatCustom: '自定义天数…',
  customEvery: '每',
  customDaysUnit: '天',
  customDaysTip: '输入天数后回车，比如 17',
  overdue: '已逾期',
  unscheduled: '未安排',
  dayToday: '今天',
  dayTomorrow: '明天',
  dayYesterday: '昨天',
  /** 日期分组的标题：8月26日 */
  dayLabel: (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`,
  /**
   * 拖选时间轴里格子上那个日期：**数字写法**。
   * 那一屏一行七格、格子只有五六十像素宽，"10月10日"这种写法会折成两行；
   * 数字写法更短，而且和左边那列"月/日"的顺序读起来一致
   */
  dayShort: (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`,
  weekdays: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
  emptyTrash: '垃圾桶是空的',
  purgeAll: '清空垃圾桶',
  purgeAllAsk: (n: number) => `彻底删除垃圾桶里的 ${n} 个任务？`,
  purgeAllDetail: '它们不会再出现在任何列表里。库文件里仍然留有历史记录 —— 存储层从不物理删除。',
  purgeAllOk: '清空',
  cancel: '取消',
  emptyDone: '还没有完成的任务',
  emptyList: '没有任务，去泡个澡',
  emptySearch: '没有匹配的任务',
  searchTitle: '搜索',
  searchSub: (q: string, n: number) => `“${q}” 命中 ${n} 条`,

  // ── 详情栏 ──
  titlePlaceholder: '任务标题',
  clearTime: '清除时间，改成全天',
  isDone: '已完成',
  isTrashed: '在垃圾桶里',
  notesLabel: '备注',
  notesEmpty: '写点备注…（支持 Markdown）',
  notesNoSelection: '选中一个任务，在这里写备注。<br>支持 Markdown。',
  notesEditPlaceholder: '支持 Markdown：**粗体** *斜体* `代码` - 列表 [链接](https://…)',
  /** 左边缘那条可拖动的分隔线 */
  detailResizeTip: '拖动调整宽度，双击恢复默认',

  // ── 提示条 ──
  bannerReadOnly: '这个库的格式比当前版本新，已按只读打开',
  bannerForked: '这个设备目录不属于本机（库被复制或迁移过），已换用新的设备身份',
  bannerIncomplete: '有文件还没从同步盘下载下来，任务可能显示不全，落地后会自动补上',
  bannerBadLines: (n: number) => `跳过了 ${n} 行坏数据`,

  // ── 库列表 ──
  vaultSheetTitle: '切换库',
  vaultOpenOther: '打开其他文件夹…',
  vaultForgetNote: '关闭只是把它从这个列表里去掉，文件夹和里面的任务不会被删除',
  vaultForget: '从列表关闭',
  vaultForgetTip: '从列表关闭，不删除文件夹',
  vaultMissing: '找不到',
  vaultCantOpen: (msg: string) => `打不开：${msg}`,
  close: '关闭',

  // ── 引导页 ──
  welcomeTitle: '请选择一个目录存储数据',
  welcomeSync: '<b>要在多台设备之间同步</b>，选一个同步盘里的目录（iCloud / OneDrive / 坚果云都行）',
  welcomeLocal: '<b>只想留在本机</b>，选「文稿」或任何别的地方',
  welcomeUndo: '<b>随时能反悔</b>，之后可以换库；删掉 App，文件夹还是你的',
  welcomePick: '选择文件夹…',
  welcomeOpening: '正在打开…',
  welcomeHint: '空文件夹会新建一个库；已经有 Kapibala 库的文件夹会直接打开。',
  welcomeLog: '出问题了？查看日志',
  welcomeFailed: (msg: string) => `打不开这个文件夹：${msg}`,

  // ── 日志面板 ──
  syncTitle: '正在同步…',
  syncSub: '在读别的设备刚才的改动，读完就能继续',
  logTitle: '日志',
  logCopy: '复制全部',
  logCopied: '已复制',

  // ── 主进程：对话框和右键菜单 ──
  pickTitle: '选择一个文件夹作为 Kapibala 库',
  pickMessage: '想在多台设备之间同步，就选同步盘里的目录',
  pickButton: '使用这个文件夹',
  pickFailed: '这个文件夹不能用作库',
  ok: '好',
  /**
   * 右键菜单里"进行中"那一项的文案。中英文都带上 Doing —— 和行上那个徽标同一个词，
   * 点下去任务行上会出现什么，菜单里就先写着什么
   */
  menuInProgress: '标记 Doing',
  menuImportant: '标记重要',
  menuUnimportant: '取消重要',
  menuDelete: '删除',
  menuRestore: '恢复',
  menuPurge: '彻底删除',
  dockOpen: '打开主界面',
  /** 托盘菜单里的退出。macOS 没有托盘，这句只出现在 Windows 上 */
  trayQuit: '退出',
  /** 第一次收起窗口时弹的气泡：告诉用户应用没关，只是躲在托盘里了 */
  trayHint: 'Kapibala 还在后台运行，点托盘图标可以回来',
  errNoVault: '还没有打开任何库',
  errVaultGone: '这个库已经不在列表里了',

  // 按平台变的几句单列在文件开头，见 ZH_PLATFORM
  platform: ZH_PLATFORM,
}

/** 英文那份必须和中文一一对应，类型对不上就编译不过 */
const EN: typeof ZH = {
  htmlLang: 'en',
  brand: 'Kapibala',

  searchPlaceholder: 'Search',
  vaultSwitch: 'Switch vault',
  vaultTip: (path, device, devices) =>
    `${path}\n${device} · ${devices} device${devices === 1 ? '' : 's'}\n\nClick to switch vault`,
  viewLog: 'View log',
  langOther: '中文',
  langSwitchTip: 'Switch interface language',
  themeToDark: 'Switch to dark mode',
  themeToLight: 'Switch to light mode',
  showDoneOn: 'Show completed tasks',
  showDoneOff: 'Hide completed tasks',
  projectOn: 'Project future repeats onto the calendar',
  projectOff: 'Stop projecting future repeats',
  projectTag: 'Projected',
  calendarCustom: 'Calendar (custom)',
  /** 英文的日期本来就带月份缩写，"9月25日 – 10月7日 共 13 天"在这儿是 "Sep 25 – Oct 7 · 13 days" */
  calendarCustomRange: (from, to, days) => `${from} – ${to} · ${days} days`,
  calendarCustomSub: (cols) => `${cols} columns`,
  calendarCustomNone: 'No date range yet',
  calendarCustomPick: 'Drag to pick the days you want',
  calendarCustomPickHint: 'Drag across the days to set the first and the last one. From then on this view is that calendar, and it stays after a restart.',
  calendarCustomPicked: (n) => `${n} day${n === 1 ? '' : 's'} selected`,
  calendarCustomMax: (n) => `${n} days max, that is the whole span`,
  calendarCustomCols: (n) => `${n} columns`,
  calendarCustomLayout: 'Columns per row',
  calendarCustomRedo: 'Pick a new range',
  calendarCustomClear: 'Clear the range',
  calendarMonth: 'Calendar',
  calendarMonthSub: 'One block per month — scroll up or down for more',
  calendarToday: 'Back to today',
  sidebarCollapseTip: 'Hide the sidebar and focus on the tasks',
  sidebarExpandTip: 'Show the sidebar',
  detailCollapseTip: 'Hide the detail pane and focus on the tasks',
  detailExpandTip: 'Show the detail pane to write notes',

  today: 'Today',
  todaySub: (label, wd) => `${label}, ${wd}`,
  next7: 'Next 7 days',
  next7Sub: 'Grouped by date, overdue on top',
  calendar7: 'Calendar (7d)',
  calendar7Sub: 'Overdue + the next 7 days, 4 × 2',
  calendar14: 'Calendar (14d)',
  calendar14Sub: 'Overdue + the next 14 days, 5 × 3',
  next30: 'Next 30 days',
  next30Sub: 'The month ahead, grouped by date',
  all: 'All tasks',
  allSub: 'Everything not done yet',
  done: 'Completed',
  doneSub: 'Grouped by the day you finished, most recent first',
  trash: 'Trash',
  trashSub: 'Right-click to restore or delete for good',

  addPlaceholder: 'Add a task, press ⏎',
  addDateTip: 'Date (optional)',
  addTimeTip: 'Time (blank = all-day)',
  inProgress: 'Doing',
  unmarkInProgress: 'Unmark Doing',
  noRepeat: 'No repeat',
  repeatCustom: 'Every N days…',
  customEvery: 'Every',
  customDaysUnit: 'days',
  customDaysTip: 'Type a number of days and press return, e.g. 17',
  overdue: 'Overdue',
  unscheduled: 'Unscheduled',
  dayToday: 'Today',
  dayTomorrow: 'Tomorrow',
  dayYesterday: 'Yesterday',
  dayLabel: (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  dayShort: (d) => `${d.getMonth() + 1}/${d.getDate()}`,
  weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  emptyTrash: 'The trash is empty',
  purgeAll: 'Empty trash',
  purgeAllAsk: (n) => `Delete ${n} task${n === 1 ? '' : 's'} in the trash for good?`,
  purgeAllDetail: 'They will not show up in any list again. A record stays in the vault files — the storage layer never physically deletes anything.',
  purgeAllOk: 'Empty trash',
  cancel: 'Cancel',
  emptyDone: 'Nothing completed yet',
  emptyList: 'No tasks. Go take a bath',
  emptySearch: 'Nothing matches',
  searchTitle: 'Search',
  searchSub: (q, n) => `${n} result${n === 1 ? '' : 's'} for “${q}”`,

  titlePlaceholder: 'Task title',
  clearTime: 'Clear the time, make it all-day',
  isDone: 'Completed',
  isTrashed: 'In the trash',
  notesLabel: 'Notes',
  notesEmpty: 'Write a note… (Markdown supported)',
  notesNoSelection: 'Select a task to write a note here.<br>Markdown supported.',
  notesEditPlaceholder: 'Markdown: **bold** *italic* `code` - list [link](https://…)',
  detailResizeTip: 'Drag to resize, double-click to reset',

  bannerReadOnly: 'This vault was written by a newer version, so it is open read-only',
  bannerForked: 'This device folder belongs to another computer (the vault was copied or migrated), so a new device identity is in use',
  bannerIncomplete: 'Some files have not come down from your sync drive yet, so tasks may be missing. They will appear once they land',
  bannerBadLines: (n) => `Skipped ${n} bad line${n === 1 ? '' : 's'}`,

  vaultSheetTitle: 'Switch vault',
  vaultOpenOther: 'Open another folder…',
  vaultForgetNote: 'Closing only takes it off this list — the folder and the tasks inside are left alone',
  vaultForget: 'Close, keep the folder',
  vaultForgetTip: 'Take it off this list without deleting the folder',
  vaultMissing: 'missing',
  vaultCantOpen: (msg) => `Cannot open: ${msg}`,
  close: 'Close',

  welcomeTitle: 'Pick a folder to keep your data in',
  welcomeSync: '<b>To sync across devices</b>, pick a folder inside a sync drive (iCloud, OneDrive, Dropbox, …)',
  welcomeLocal: '<b>To stay on this computer only</b>, pick Documents or anywhere else',
  welcomeUndo: '<b>Nothing is locked in</b> — you can switch vaults later, and deleting the app leaves the folder yours',
  welcomePick: 'Choose folder…',
  welcomeOpening: 'Opening…',
  welcomeHint: 'An empty folder becomes a new vault; a folder that already holds a Kapibala vault just opens.',
  welcomeLog: 'Something wrong? View the log',
  welcomeFailed: (msg) => `Cannot open this folder: ${msg}`,

  syncTitle: 'Syncing…',
  syncSub: 'Reading what your other device just changed — one moment',
  logTitle: 'Log',
  logCopy: 'Copy all',
  logCopied: 'Copied',

  pickTitle: 'Pick a folder for your Kapibala vault',
  pickMessage: 'To sync across devices, pick a folder inside a sync drive',
  pickButton: 'Use this folder',
  pickFailed: 'This folder cannot be used as a vault',
  ok: 'OK',
  menuInProgress: 'Mark Doing',
  menuImportant: 'Mark as important',
  menuUnimportant: 'Clear important',
  menuDelete: 'Delete',
  menuRestore: 'Restore',
  menuPurge: 'Delete for good',
  dockOpen: 'Open Kapibala',
  trayQuit: 'Quit',
  trayHint: 'Kapibala is still running in the background — click the tray icon to bring it back',
  errNoVault: 'No vault is open yet',
  errVaultGone: 'That vault is no longer on the list',

  platform: EN_PLATFORM,
}

export type Strings = typeof ZH

export const t = (lang: Lang): Strings => (lang === 'en' ? EN : ZH)
