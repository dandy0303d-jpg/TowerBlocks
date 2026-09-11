/**
 * 中文（简体）语言包。键命名规则：`<场景>.<元素>` —— 比如
 * `menu.title` / `hud.height` / `picker.title`。
 *
 * 添加新语言时复制本文件并翻译；保持键集合一致。i18n 模块在初始化
 * 时合并所有语言包，并以本文件（zh）为基准 fallback：英文 / 其他
 * 语言缺字段时退回中文。
 */
export const ZH: Record<string, string> = {
    // ---------- 主菜单 ----------
    'menu.title':        'Tetri Tower',
    'menu.subtitle':     'To the Heavens',
    'menu.endless':      '无尽模式',
    'menu.levels':       '关卡模式',
    'menu.blind':        '闭眼模式',
    'menu.leaderboard':  '排行榜',
    'menu.reset':        '重置',
    'menu.unlockAll':    '解锁所有',
    'menu.levelSelect':  '关卡选择',
    'menu.back':         '← 返回',

    // ---------- 启动加载页 ----------
    'loading.text':      '加载资源',

    // ---------- HUD ----------
    'hud.back':          '← 主页',
    'hud.height':        '层高',
    'hud.heightValue':   '层高  {n}',
    'hud.next':          '下一个',

    // ---------- 道具卡 / Picker ----------
    'picker.title':      '⚡ 选 1 个魔法道具',
    'refresh.limitReached':'已达上限',
    'picker.hint':       '点击卡片确认 · 颜色 = 稀有度',
    'picker.refresh':    '🔄 免费刷新 ({n}/3)',
    'picker.adRefresh':  '🎬 看广告再刷一次',
    'picker.adRefresh.failed': '广告加载失败，请稍后再试',
    'rarity.common':     '普通',
    'rarity.uncommon':   '少见',
    'rarity.rare':       '稀有',
    'rarity.epic':       '史诗',

    // ---------- 道具名字 ----------
    'item.hourglass1':    '沙漏 1 分',
    'item.hourglass2':    '沙漏 2 分',
    'item.hourglass3':    '沙漏 3 分',
    'item.excavator1':    '挖底机 ×1',
    'item.excavator2':    '挖底机 ×2',
    'item.excavator3':    '挖底机 ×3',
    'item.excavatorTop1': '掀顶机 ×1',
    'item.excavatorTop2': '掀顶机 ×2',
    'item.excavatorTop3': '掀顶机 ×3',
    'item.shapeshifter':  '变形',
    'item.rewind':        '回溯',
    'item.meteor1':       '流星雨 ×5',
    'item.meteor2':       '流星雨 ×10',
    'item.meteor3':       '流星雨 ×15',
    'item.rocket1':       '火箭弹 ×8',
    'item.rocket2':       '火箭弹 ×16',
    'item.rocket3':       '火箭弹 ×24',
    'item.gatling1':      '加特林 ×4',
    'item.gatling2':      '加特林 ×8',
    'item.gatling3':      '加特林 ×12',
    'item.mortar5':       '灰泥 ×5',
    'item.mortar10':      '灰泥 ×10',
    'item.mortar15':      '灰泥 ×15',

    // ---------- 道具描述 ----------
    'desc.hourglass1':    '1 分钟内方块下落速度减半',
    'desc.hourglass2':    '2 分钟内方块下落速度减半',
    'desc.hourglass3':    '3 分钟内方块下落速度减半',
    'desc.excavator1':    '消除塔底 1 层有色方块',
    'desc.excavator2':    '消除塔底 2 层有色方块',
    'desc.excavator3':    '消除塔底 3 层有色方块',
    'desc.excavatorTop1': '消除塔顶 1 层有色方块',
    'desc.excavatorTop2': '消除塔顶 2 层有色方块',
    'desc.excavatorTop3': '消除塔顶 3 层有色方块',
    'desc.shapeshifter':  '挑选下个方块的形状',
    'desc.rewind':        '棋盘回到 3 步之前',
    'desc.meteor1':       '5 个 1×1 小方块极速下落',
    'desc.meteor2':       '10 个 1×1 小方块极速下落',
    'desc.meteor3':       '15 个 1×1 小方块极速下落',
    'desc.rocket1':       '使用后，8 个方块从空中砸落，消除塔顶最上层方块',
    'desc.rocket2':       '使用后，16 个方块从空中砸落，消除塔顶最上层方块',
    'desc.rocket3':       '使用后，24 个方块从空中砸落，消除塔顶最上层方块',
    'desc.gatling1':      '使用后，4 个方块高速落下，逐个击碎下方方块',
    'desc.gatling2':      '使用后，8 个方块高速落下，逐个击碎下方方块',
    'desc.gatling3':      '使用后，12 个方块高速落下，逐个击碎下方方块',
    'desc.mortar5':       '使用后，5 个方块从上方落下，填补空格',
    'desc.mortar10':      '使用后，10 个方块从上方落下，填补空格',
    'desc.mortar15':      '使用后，15 个方块从上方落下，填补空格',

    // ---------- 变形弹窗 ----------
    'shapeshifter.title':    '🎲 变形',
    'shapeshifter.subtitle': '选一种形状让当前方块变身',
    'shapeshifter.cancel':   '取消',

    // ---------- 本命方块弹窗 ----------
    'fate.modalTitle':   '本命方块',
    'fate.reroll':       '逆天改命 ({n}/3)',
    'fate.reroll.ad':    '🎬 看广告改命',
    'fate.start':        '直接开始',
    'fate.cellCount':    '共 {n} 格',
    'fate.endlessSub':   '无尽模式',
    'fate.endlessMid':   '无尽模式 · {layer} 层',
    'fate.subtitle':     '{tag} · 共 {n} 格',
    'fate.hint':         '逆天改命：观看广告随机换一个本命方块',
    'fate.reroll.failed':'广告加载失败，请稍后再试',

    // ---------- 收集模式 ----------
    'collect.header':    '收集目标',

    // ---------- 关卡选择 ----------
    'level.name':        '关卡 {n}',
    'level.floorName':   '关卡 {n} 层',
    'level.clearTime':   '通关时间：{time}',
    'level.enter':       '进入关卡',

    // ---------- 闭眼模式 ----------
    'blind.fail.prompt': '很遗憾挑战失败，点击任意位置继续',
    'blind.showTower':   '🙉 显示塔',
    'blind.hideTower':   '🙈 隐藏塔',

    // ---------- 无尽模式里程碑（每 12 层）----------
    'endless.milestone': '第 {n} 层达成！',

    // ---------- 暂停弹窗 ----------
    'pause.title':       '⏸ 已暂停',
    'pause.hint':        '点击继续回到游戏',
    'pause.continue':    '▶ 继续',
    'pause.home':        '■ 主页',

    // ---------- DEV 按钮 ----------
    'debug.forceWin':    '一键通关',

    // ---------- 新手引导 ----------
    'tutorial.hint.tap':          '点击屏幕，方块会变形',
    'tutorial.hint.swipeRelease': '拖动手指，塔一格一格跟',
    'tutorial.hint.swipeHold':    '快速滑动松手，塔靠惯性连续转',
    'tutorial.hint.swipeDown':    '向下滑动，方块直接落底',
    'tutorial.skip':              '跳过',

    // ---------- 登录页 ----------
    'login.title':          '欢迎来到 Tetri Tower',
    'login.subtitle':       '选一种方式开始',
    'login.namePlaceholder':'输入昵称（可选）',
    'login.guestButton':    '游客登录',
    'login.emailButton':    '邮箱登录',
    'login.googleButton':   'Google 登录',
    'login.appleButton':    'Apple 登录',
    'login.comingSoon':     '（敬请期待）',
    'login.orDivider':      '或',

    // ---------- 充值 ----------
    'menu.topup':           '充值',
    'topup.title':          '充值宝石',
    'topup.balance':        '{n}',
    'topup.gems':           '{n} 宝石',
    'topup.price':          '{price}',
    'topup.buyButton':      '购买',
    'topup.close':          '关闭',
    'topup.successTitle':   '购买成功',
    'topup.successBody':    '获得 {n} 宝石',
    'topup.failTitle':      '购买失败',
    'topup.failBody':       '{reason}',
    'topup.processing':     '正在处理...',
    'topup.mockNotice':     '（当前为测试模式，无真实扣款）',

    // ---------- 排行榜 ----------
    'leaderboard.title':       '排行榜',
    'leaderboard.back':        '↩ 返回',
    'leaderboard.tab.level':   '关卡模式',
    'leaderboard.tab.endless': '无尽模式',
    'leaderboard.tab.blind':   '闭眼模式',
    'leaderboard.you':         '你',
    'leaderboard.empty':       '暂无数据',
    'leaderboard.mockName':    '玩家昵称{n}',

    // ---------- 结果弹窗 ----------
    'result.gameOver':   '游戏结束',
    'result.levelFail':  '关卡失败',
    'result.fail.hole':  '形成了不可逆转的空格',
    'result.fail.tall':  '塔太高',
    'result.win':        '过关 ✓',
    'result.retry':      '重试',
    'result.endlessRetry': '再来一局',
    'result.replay':     '重玩',
    'result.levelSelect':'选关',
    'result.home':       '主页',
    // 看广告复活（无尽/盲塔 game-over 面板专用）
    'result.reviveAd':   '🎬 看广告复活',
    'result.reviveAd.failed': '广告加载失败，请稍后再试',

    // ---------- 切换语言 ----------
    // Toggle 显示**当前**语言（更符合玩家直觉——能一眼看出"我现在在哪个语言"）。
    // 点击会循环到下一个语言。
    'lang.toggle':       '中文',

    // ---------- 设置面板 ----------
    'settings.button':       '⚙ 设置',
    'settings.title':        '设置',
    'settings.lang':         '语言',
    'settings.gesture':      '手势模式',
    'settings.gesture.both': '点滑 + 按住滑',
    'settings.gesture.drag': '只按住滑',
    'settings.keys':         '虚拟按键',
    'settings.keys.on':      '开',
    'settings.keys.off':     '关',
    'settings.bgm':          '背景音乐',
    'settings.sfx':          '音效',
    'settings.haptic':       '手机震动',
    'settings.controls':       '操作方式',
    'controls.title':          '选择操作方式',
    'controls.legacy':         '经典（滑动 + 长按）',
    'controls.dragFling':      '拖动 + 惯性甩塔',
    'controls.buttons':        '按钮模式',
    'controls.close':          '关闭',
    'controls.classic':      '经典',
    'controls.advanced':     '进阶',
    'controls.expert':       '高手',
    'settings.nickname':     '昵称',
    'settings.volume':       '音乐大小',
    'settings.accountData':  '账号管理',
    'settings.googleAccount': '谷歌账号',
    'settings.appleAccount': '苹果账号',
    'settings.notBound':     '未绑定',
    'settings.close':        '关闭',
    'audio.off':             '关',
    'audio.percent':         '{n}%',
    // 账号类型（设置面板内显示当前登录方式）
    'settings.account.guest':  '游客',
    'settings.account.google': '谷歌',
    'settings.account.apple':  '苹果',
    'settings.account.email':  '邮箱',
    'settings.account.copied':      '已复制到剪贴板',
    'settings.account.copyFailed':  '复制失败',
    'settings.nickname.tooLong':     '昵称最多 {n} 个字符',
    'settings.nickname.title':       '修改昵称',
    'settings.nickname.cooldown':    '距下次可修改还有 {n} 天',
    'settings.nickname.cooldownReady':'现在可以修改（下次修改需等 7 天）',
    'settings.nickname.placeholder': '输入新昵称',
    'settings.nickname.profanity':   '昵称含违禁词，请换一个',
    'settings.nickname.reserved':    '此昵称为系统保留，请换一个',
    'settings.nickname.tooShort':    '昵称太短',
    'settings.nickname.tooLongServer':'昵称太长',
    'settings.nickname.rejected':    '昵称不合法，请换一个',

    // ---------- Common modal buttons ----------
    'common.confirm':    '确认',
    'common.cancel':     '取消',

    // ---------- 账号封禁 ----------
    'banned.title':      '账号已封禁',
    'banned.desc':       '此账号已被封禁。原因：{reason}\n\n如有疑问请联系客服。',
    'banned.ok':         '我知道了',

    // ---------- 删除账号 (App Store 5.1.1(v) 硬性要求) ----------
    'settings.deleteAccount':         '删除账号',
    'settings.deleteAccount.title':   '删除账号？',
    'settings.deleteAccount.desc':    '此操作不可撤销。所有数据（钻石、进度、绑定）将永久删除。',
    'settings.deleteAccount.confirm': '再次点击确认删除',
    'settings.bound':                 '已绑定',
    'settings.unbound':               '未绑定',
    // ---- 新手 14 天活动 ----
    'event.newbie14.title':           '新手 14 天福利',
    'event.newbie14.subtitle':        '每日登录即可领取钻石',
    'event.newbie14.claim':           '领取 {gems} 钻石',
    'event.newbie14.claiming':        '领取中…',
    'event.newbie14.claimed':         '今日已领取',
    'event.newbie14.alreadyClaimed':  '今日已领取过啦',
    'event.newbie14.grantedToast':    '获得 {gems} 💎',
    'event.newbie14.ended':           '活动已结束',
    'event.newbie14.daysLeft':        '活动剩余 {days} 天',
    'event.newbie14.loading':         '加载中…',
    'event.newbie14.error':           '领取失败，请重试',
    // ---- 退出游戏确认 ----
    'exit.title':                     '退出游戏',
    'exit.desc':                      '确定要退出游戏吗？',
    'exit.confirm':                   '退出',
    'exit.cancel':                    '取消',
    'settings.google.pending':        '正在打开 Google 登录…',
    'settings.google.linked':         '已绑定 Google 账号',
    'settings.google.alreadyLinked':  '已绑定 Google 账号',
    'settings.google.unsupported':    '此设备暂不支持 Google 登录',
    'settings.google.error':          'Google 登录失败，请重试',
    'settings.google.recover.title':  '该 Google 账号已绑定其他账号',
    'settings.google.recover.desc':   '该 Google 账号已绑定另一个游戏账号。恢复后当前游客账号会被丢弃。是否继续？',
    'settings.google.recovered':      '已恢复 Google 绑定的账号',
    'settings.deleteAccount.pending': '删除中...',
    'settings.deleteAccount.failed':  '删除失败，请重试',

    'settings.tos':     '服务条款',
    'settings.privacy': '隐私政策',
    // NOTE: duplicate 'settings.deleteAccount' keys used to live here.
    // See ko.ts for the bug — divergent KO value silently overrode
    // the earlier block. Removed here too for consistency.
    'settings.appleRecovery.confirm':  '此 Apple 已绑其他账号，再点确认恢复',
    'settings.appleRecovery.title':    '恢复账号？',
    'settings.appleRecovery.desc':     '此 Apple ID 已绑定另一个游戏账号。确认后当前游客账号将切换到该已绑定账号，原游客数据（钻石、进度）不会带过去。',
    'settings.appleRecovery.pending':  '恢复中...',
    'settings.appleRecovery.failed':   '恢复失败，请重试',
    'settings.appleRecovery.success':  '账号恢复成功',
    // 绑定 Toast
    'settings.bind.success':           '账号已绑定',
    'settings.bind.failed':            '绑定失败，请重试',
    'settings.bind.cancelled':         '已取消登录',
    // Google 账号恢复
    'settings.googleRecovery.title':   '恢复账号？',
    'settings.googleRecovery.desc':    '此 Google 账号已绑定另一个游戏账号。确认后当前账号将切换到该已绑定账号，原游客数据（钻石、进度）不会带过去。',
    'settings.googleRecovery.pending': '恢复中...',
    'settings.googleRecovery.failed':  '恢复失败，请重试',
    'settings.googleRecovery.success': '账号恢复成功',
    // 钻石不足弹窗
    'gems.insufficient': '钻石不足\n需要 {need}，当前 {have}',
    'gems.goTopUp':      '去充值',
    'gems.cancel':       '取消',

    // ---------- Consent modal (login-gate) ----------
    'consent.title':                             '必须同意用户协议和隐私政策才能开始游戏！',
    'consent.agreeAll':                             '我同意全部条款',
    'consent.tos.label':                             '同意服务条款',
    'consent.privacy.label':                             '同意隐私政策',
    'consent.age.label':                             '我已满 14 周岁',
    'consent.marketing.label':                             '同意接收营销信息',
    'consent.required':                             '必选',
    'consent.optional':                             '可选',
    'consent.view':                             '查看',
    'consent.start':                             '同意并开始',
    'consent.mustAgree':                             '必须同意所有必选项才能开始游戏。',
    'consent.error':                             '同意记录失败，请稍后重试。',
    // ---- Progressive unlock tips ----
    'lock.endless':      '到达 {n} 层后解锁无尽模式',
    'lock.blind':        '无尽模式达到 {n} 层后解锁闭眼模式',
    'lock.leaderboard':  '无尽模式达到 {n} 层后解锁排行榜',
    'level.next':        '下一关',
    'level.floor':       '第 {n} 层',
};
