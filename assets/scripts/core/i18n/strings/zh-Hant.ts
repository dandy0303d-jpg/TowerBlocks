/**
 * 繁體中文語言包（台灣/香港）。鍵集合鏡像 `zh.ts`；缺鍵時 i18n 模組
 * 會回退到簡體中文。
 *
 * 詞彙選擇偏台灣繁體用法（例如「宝石」→「寶石」、「谷歌」→「Google」
 * 保留原文、「视频」→「影片」）。若要適配香港粵語習慣可另建 zh-HK。
 */
export const ZH_HANT: Record<string, string> = {
    // ---------- 主選單 ----------
    'menu.title':        'Tetri Tower',
    'menu.subtitle':     'To the Heavens',
    'menu.endless':      '無盡模式',
    'menu.levels':       '關卡模式',
    'menu.blind':        '閉眼模式',
    'menu.leaderboard':  '排行榜',
    'menu.reset':        '重置',
    'menu.levelSelect':  '關卡選擇',
    'menu.back':         '← 返回',

    // ---------- 啟動載入頁 ----------
    'loading.text':      '載入資源',

    // ---------- HUD ----------
    'hud.back':          '← 主頁',
    'hud.height':        '層高',
    'hud.heightValue':   '層高  {n}',
    'hud.next':          'NEXT',

    // ---------- 道具卡 / Picker ----------
    'picker.title':      '⚡ 選 1 個魔法道具',
    'picker.hint':       '點擊卡片確認 · 顏色 = 稀有度',
    'picker.refresh':    '🔄 免費刷新',
    'picker.adRefresh':  '🎬 看廣告再刷一次',
    'rarity.common':     '普通',
    'rarity.uncommon':   '少見',
    'rarity.rare':       '稀有',
    'rarity.epic':       '史詩',

    // ---------- 道具名字 ----------
    'item.hourglass1':    '沙漏 1 分',
    'item.hourglass2':    '沙漏 2 分',
    'item.hourglass3':    '沙漏 3 分',
    'item.excavator1':    '挖底機 ×1',
    'item.excavator2':    '挖底機 ×2',
    'item.excavator3':    '挖底機 ×3',
    'item.excavatorTop1': '掀頂機 ×1',
    'item.excavatorTop2': '掀頂機 ×2',
    'item.excavatorTop3': '掀頂機 ×3',
    'item.shapeshifter':  '變形',
    'item.rewind':        '回溯',
    'item.meteor1':       '流星雨 ×5',
    'item.meteor2':       '流星雨 ×10',
    'item.meteor3':       '流星雨 ×15',
    'item.rocket1':       '火箭彈 ×8',
    'item.rocket2':       '火箭彈 ×16',
    'item.rocket3':       '火箭彈 ×24',
    'item.gatling1':      '加特林 ×4',
    'item.gatling2':      '加特林 ×8',
    'item.gatling3':      '加特林 ×12',
    'item.mortar5':       '灰泥 ×5',
    'item.mortar10':      '灰泥 ×10',
    'item.mortar15':      '灰泥 ×15',

    // ---------- 道具描述 ----------
    'desc.hourglass1':    '1 分鐘內方塊落下速度減半',
    'desc.hourglass2':    '2 分鐘內方塊落下速度減半',
    'desc.hourglass3':    '3 分鐘內方塊落下速度減半',
    'desc.excavator1':    '消除塔底 1 層有色方塊',
    'desc.excavator2':    '消除塔底 2 層有色方塊',
    'desc.excavator3':    '消除塔底 3 層有色方塊',
    'desc.excavatorTop1': '消除塔頂 1 層有色方塊',
    'desc.excavatorTop2': '消除塔頂 2 層有色方塊',
    'desc.excavatorTop3': '消除塔頂 3 層有色方塊',
    'desc.shapeshifter':  '挑選下個方塊的形狀',
    'desc.rewind':        '棋盤回到 3 步之前',
    'desc.meteor1':       '5 個 1×1 小方塊極速落下',
    'desc.meteor2':       '10 個 1×1 小方塊極速落下',
    'desc.meteor3':       '15 個 1×1 小方塊極速落下',
    'desc.rocket1':       '8 發火箭穿透塔頂方塊',
    'desc.rocket2':       '16 發火箭穿透塔頂方塊',
    'desc.rocket3':       '24 發火箭穿透塔頂方塊',
    'desc.gatling1':      '4 發子彈從螢幕中央掃射',
    'desc.gatling2':      '8 發子彈從螢幕中央掃射',
    'desc.gatling3':      '12 發子彈從螢幕中央掃射',
    'desc.mortar5':       '5 滴色漿往下滴,填滿懸空空格',
    'desc.mortar10':      '10 滴色漿往下滴,填滿懸空空格',
    'desc.mortar15':      '15 滴色漿往下滴,填滿懸空空格',

    // ---------- 變形彈窗 ----------
    'shapeshifter.title':    '🎲 變形',
    'shapeshifter.subtitle': '選一種形狀讓當前方塊變身',
    'shapeshifter.cancel':   '取消',

    // ---------- 本命方塊彈窗 ----------
    'fate.modalTitle':   '本命方塊',
    'fate.reroll':       '逆天改命',
    'fate.start':        '直接開始',
    'fate.cellCount':    '共 {n} 格',
    'fate.endlessSub':   '無盡模式',
    'fate.levelSub':     '關卡 {n}',
    'fate.endlessMid':   '無盡模式 · {layer} 層',
    'fate.subtitle':     '{tag} · 共 {n} 格',
    'fate.hint':         '逆天改命：觀看廣告隨機換一個本命方塊',

    // ---------- 收集模式 ----------
    'collect.header':    '收集目標',

    // ---------- 關卡選擇 ----------
    'level.name':        '關卡 {n}',
    'level.enter':       '進入關卡',

    // ---------- 閉眼模式 ----------
    'blind.fail.prompt': '很遺憾挑戰失敗,點擊任意位置繼續',
    'blind.showTower':   '🙉 顯示塔',
    'blind.hideTower':   '🙈 隱藏塔',

    // ---------- 無盡模式里程碑（每 12 層）----------
    'endless.milestone': '第 {n} 層達成！',

    // ---------- 暫停彈窗 ----------
    'pause.title':       '⏸ 已暫停',
    'pause.hint':        '點擊繼續回到遊戲',
    'pause.continue':    '▶ 繼續',
    'pause.home':        '< 主頁',

    // ---------- DEV 按鈕 ----------
    'debug.forceWin':    '一鍵通關',

    // ---------- 新手引導 ----------
    'tutorial.hint.tap':          '點擊螢幕,方塊會變形',
    'tutorial.hint.swipeRelease': '橫向滑動放手,塔轉一格',
    'tutorial.hint.swipeHold':    '橫向滑動按住不放,塔連續轉',
    'tutorial.hint.swipeDown':    '向下滑動,方塊直接落底',
    'tutorial.skip':              '跳過',

    // ---------- 登入頁 ----------
    'login.title':          '歡迎來到 Tetri Tower',
    'login.subtitle':       '選一種方式開始',
    'login.namePlaceholder':'輸入暱稱（可選）',
    'login.guestButton':    '訪客登入',
    'login.emailButton':    '電子郵件登入',
    'login.googleButton':   'Google 登入',
    'login.appleButton':    'Apple 登入',
    'login.comingSoon':     '（敬請期待）',
    'login.orDivider':      '或',

    // ---------- 儲值 ----------
    'menu.topup':           '儲值',
    'topup.title':          '購買寶石',
    'topup.balance':        '寶石: {n}',
    'topup.gems':           '{n} 寶石',
    'topup.price':          '{price}',
    'topup.buyButton':      '購買',
    'topup.close':          '關閉',
    'topup.successTitle':   '購買成功',
    'topup.successBody':    '獲得 {n} 寶石',
    'topup.failTitle':      '購買失敗',
    'topup.failBody':       '{reason}',
    'topup.processing':     '處理中...',
    'topup.mockNotice':     '（測試模式,不會實際扣款）',

    // ---------- 排行榜 ----------
    'leaderboard.title':       '排行榜',
    'leaderboard.back':        '↩ 返回',
    'leaderboard.tab.level':   '關卡模式',
    'leaderboard.tab.endless': '無盡模式',
    'leaderboard.tab.blind':   '閉眼模式',
    'leaderboard.you':         '你',
    'leaderboard.empty':       '暫無資料',
    'leaderboard.mockName':    '玩家暱稱{n}',

    // ---------- 結果彈窗 ----------
    'result.gameOver':   '遊戲結束',
    'result.levelFail':  '關卡失敗',
    'result.fail.hole':  '漏洞被封死',
    'result.fail.tall':  '塔太高',
    'result.win':        '過關 ✓',
    'result.retry':      '重試',
    'result.endlessRetry': '再來一局',
    'result.nextLevel':  '下一關',
    'result.replay':     '重玩',
    'result.levelSelect':'選關',
    'result.home':       '主頁',

    // ---------- 切換語言 ----------
    'lang.toggle':       '繁體',

    // ---------- 設定面板 ----------
    'settings.button':       '⚙ 設定',
    'settings.title':        '設定',
    'settings.lang':         '語言',
    'settings.gesture':      '手勢模式',
    'settings.gesture.both': '點滑 + 按住滑',
    'settings.gesture.drag': '只按住滑',
    'settings.keys':         '虛擬按鍵',
    'settings.keys.on':      '開',
    'settings.keys.off':     '關',
    'settings.bgm':          '背景音樂',
    'settings.sfx':          '音效',
    'settings.close':        '關閉',
    'audio.off':             '關',
    'audio.percent':         '{n}%',
    'settings.account.guest':  '訪客',
    'settings.account.google': 'Google',
    'settings.account.apple':  'Apple',
    'settings.account.email':  '電子郵件',
    'settings.account.copied':      '已複製到剪貼簿',
    'settings.account.copyFailed':  '複製失敗',
    'settings.nickname.tooLong':     '暱稱最多 {n} 個字元',
    'settings.nickname.title':       '修改暱稱',
    'settings.nickname.placeholder': '輸入新暱稱',

    // ---------- Common modal buttons ----------
    'common.confirm':    '確認',
    'common.cancel':     '取消',

    // ---------- 刪除帳號 (App Store 5.1.1(v) 硬性要求) ----------
    'settings.deleteAccount':         '刪除帳號',
    'settings.deleteAccount.title':   '刪除帳號？',
    'settings.deleteAccount.desc':    '此操作無法還原。所有資料（寶石、進度、綁定）將永久刪除。',
    'settings.deleteAccount.pending': '刪除中...',
    'settings.deleteAccount.failed':  '刪除失敗,請重試',

    'settings.tos':     '服務條款',
    'settings.privacy': '隱私政策',
    // 寶石不足彈窗
    'gems.insufficient': '寶石不足\n需要 {need},目前 {have}',
    'gems.goTopUp':      '去儲值',
    'gems.cancel':       '取消',

    // ---------- Consent modal (login-gate) ----------
    'consent.title':                             '必須同意使用者條款和隱私權政策才能開始遊戲！',
    'consent.agreeAll':                             '我同意全部條款',
    'consent.tos.label':                             '同意服務條款',
    'consent.privacy.label':                             '同意隱私權政策',
    'consent.age.label':                             '我已滿 14 歲',
    'consent.marketing.label':                             '同意接收行銷資訊',
    'consent.required':                             '必選',
    'consent.optional':                             '選填',
    'consent.view':                             '檢視',
    'consent.start':                             '同意並開始',
    'consent.mustAgree':                             '必須同意所有必選項才能開始遊戲。',
    'consent.error':                             '同意記錄失敗，請稍後再試。',
};
