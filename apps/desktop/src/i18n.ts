/**
 * 界面文案。主进程和渲染进程共用这一份 —— 右键菜单在主进程、任务列表在渲染进程，
 * 同一句话不能有两份写法。
 *
 * 没有运行时依赖，也不碰 node：渲染进程那一份是 browser 目标的 bundle。
 * 带参数的文案写成函数，不做 "{0}" 这类占位符替换 —— 类型检查抓不到占位符写错。
 */

// 语言这个类型定义在 core 里（重复规则的描述也要按语言走），这里只是转出来
import type { Lang } from '@kapibala/core/rrule'
export type { Lang }
export const LANGS: Lang[] = ['zh', 'en']
export const isLang = (x: unknown): x is Lang => x === 'zh' || x === 'en'

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

  // ── 视图 ──
  today: '今天',
  todaySub: (label: string, wd: string) => `${label} ${wd}`,
  next7: '最近 7 天',
  next7Sub: '按日期分组，逾期置顶',
  next30: '最近 30 天',
  next30Sub: '一个月内的安排，按日期分组',
  all: '全部任务',
  allSub: '所有未完成的任务',
  done: '已完成',
  doneSub: '最近完成的排在前面',
  trash: '垃圾桶',
  trashSub: '右键可以恢复或彻底删除',

  // ── 列表 ──
  addPlaceholder: '添加任务，回车保存',
  noRepeat: '不重复',
  repeatCustom: '自定义天数…',
  customEvery: '每',
  customDaysUnit: '天',
  customDaysTip: '输入天数后回车，比如 17',
  overdue: '已逾期',
  unscheduled: '未安排',
  dayToday: '今天',
  dayTomorrow: '明天',
  /** 日期分组的标题：8月26日 */
  dayLabel: (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`,
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
  notesHint: '自动保存 · ⌘↩ 收起',

  // ── 提示条 ──
  bannerReadOnly: '这个库的格式比当前版本新，已按只读打开',
  bannerForked: '这个设备目录不属于本机（库被复制或迁移过），已换用新的设备身份',
  bannerIncomplete: '有文件还没从 iCloud 下载下来，任务可能显示不全，落地后会自动补上',
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
  welcomeSync: '<b>要在多台 Mac 之间同步</b>，选一个 iCloud 云盘里的目录',
  welcomeLocal: '<b>只想留在本机</b>，选「文稿」或任何别的地方',
  welcomeUndo: '<b>随时能反悔</b>，之后可以换库；删掉 App，文件夹还是你的',
  welcomePick: '选择文件夹…',
  welcomeOpening: '正在打开…',
  welcomeHint: '空文件夹会新建一个库；已经有 Kapibala 库的文件夹会直接打开。',
  welcomeLog: '出问题了？查看日志',
  welcomeFailed: (msg: string) => `打不开这个文件夹：${msg}`,

  // ── 日志面板 ──
  logTitle: '日志',
  logCopy: '复制全部',
  logCopied: '已复制',
  logReveal: '在 Finder 中显示',

  // ── 主进程：对话框和右键菜单 ──
  pickTitle: '选择一个文件夹作为 Kapibala 库',
  pickMessage: '想在多台 Mac 之间同步，就选 iCloud Drive 里的目录',
  pickButton: '使用这个文件夹',
  pickFailed: '这个文件夹不能用作库',
  ok: '好',
  menuNotes: '备注',
  menuComplete: '完成',
  menuUncomplete: '标记为未完成',
  menuDelete: '删除',
  menuRestore: '恢复',
  menuPurge: '彻底删除',
  dockOpen: '打开主界面',
  errNoVault: '还没有打开任何库',
  errVaultGone: '这个库已经不在列表里了',
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

  today: 'Today',
  todaySub: (label, wd) => `${label}, ${wd}`,
  next7: 'Next 7 days',
  next7Sub: 'Grouped by date, overdue on top',
  next30: 'Next 30 days',
  next30Sub: 'The month ahead, grouped by date',
  all: 'All tasks',
  allSub: 'Everything not done yet',
  done: 'Completed',
  doneSub: 'Most recently completed first',
  trash: 'Trash',
  trashSub: 'Right-click to restore or delete for good',

  addPlaceholder: 'Add a task, press ⏎',
  noRepeat: 'No repeat',
  repeatCustom: 'Every N days…',
  customEvery: 'Every',
  customDaysUnit: 'days',
  customDaysTip: 'Type a number of days and press return, e.g. 17',
  overdue: 'Overdue',
  unscheduled: 'Unscheduled',
  dayToday: 'Today',
  dayTomorrow: 'Tomorrow',
  dayLabel: (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
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
  notesHint: 'Saved automatically · ⌘↩ to close',

  bannerReadOnly: 'This vault was written by a newer version, so it is open read-only',
  bannerForked: 'This device folder belongs to another Mac (the vault was copied or migrated), so a new device identity is in use',
  bannerIncomplete: 'Some files have not come down from iCloud yet, so tasks may be missing. They will appear once they land',
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
  welcomeSync: '<b>To sync across Macs</b>, pick a folder inside iCloud Drive',
  welcomeLocal: '<b>To stay on this Mac only</b>, pick Documents or anywhere else',
  welcomeUndo: '<b>Nothing is locked in</b> — you can switch vaults later, and deleting the app leaves the folder yours',
  welcomePick: 'Choose folder…',
  welcomeOpening: 'Opening…',
  welcomeHint: 'An empty folder becomes a new vault; a folder that already holds a Kapibala vault just opens.',
  welcomeLog: 'Something wrong? View the log',
  welcomeFailed: (msg) => `Cannot open this folder: ${msg}`,

  logTitle: 'Log',
  logCopy: 'Copy all',
  logCopied: 'Copied',
  logReveal: 'Show in Finder',

  pickTitle: 'Pick a folder for your Kapibala vault',
  pickMessage: 'To sync across Macs, pick a folder inside iCloud Drive',
  pickButton: 'Use this folder',
  pickFailed: 'This folder cannot be used as a vault',
  ok: 'OK',
  menuNotes: 'Notes',
  menuComplete: 'Complete',
  menuUncomplete: 'Mark as not done',
  menuDelete: 'Delete',
  menuRestore: 'Restore',
  menuPurge: 'Delete for good',
  dockOpen: 'Open Kapibala',
  errNoVault: 'No vault is open yet',
  errVaultGone: 'That vault is no longer on the list',
}

export type Strings = typeof ZH

export const t = (lang: Lang): Strings => (lang === 'en' ? EN : ZH)
