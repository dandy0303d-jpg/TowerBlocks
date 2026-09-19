/**
 * 日本語言語パック。キー集合は `zh.ts` を鏡像。欠けているキーは
 * i18n モジュールが自動的に簡体中文にフォールバック。
 *
 * ゲーム用語の選択は日本のカジュアルゲーム慣習に合わせています。
 * 「宝石」→「ジェム」（英語カタカナ、DQ・パズドラ系標準）、
 * 「玩家」→「プレイヤー」、モード名は日本の落ちものパズル
 * 用語（エンドレス、チャレンジ 等）。
 */
export const JA: Record<string, string> = {
    // ---------- メインメニュー ----------
    'menu.title':        'Tetri Tower',
    'menu.subtitle':     'To the Heavens',
    'menu.endless':      'エンドレス',
    'menu.levels':       'ステージ',
    'menu.blind':        'ブラインド',
    'menu.leaderboard':  'ランキング',
    'menu.reset':        'リセット',
    'menu.unlockAll':    '全開放',
    'menu.levelSelect':  'ステージ選択',
    'menu.back':         '← 戻る',

    // ---------- ロード画面 ----------
    'loading.text':      '読み込み中',

    // ---------- HUD ----------
    'hud.back':          '← ホーム',
    'hud.height':        '高さ',
    'hud.heightValue':   '高さ  {n}',
    'hud.next':          '次',

    // ---------- アイテムピッカー ----------
    'picker.title':      '⚡ 魔法アイテムを 1 つ選択',
    'refresh.limitReached':'上限に達しました',
    'picker.hint':       'タップして確定 · 色 = レア度',
    'picker.refresh':    '🔄 無料リロール ({n}/3)',
    'picker.adRefresh':  '🎬 広告視聴でもう一度',
    'rarity.common':     'ノーマル',
    'rarity.uncommon':   'アンコモン',
    'rarity.rare':       'レア',
    'rarity.epic':       'エピック',

    // ---------- アイテム名 ----------
    'item.hourglass1':    '砂時計 1分',
    'item.hourglass2':    '砂時計 2分',
    'item.hourglass3':    '砂時計 3分',
    'item.excavator1':    '底面掘削 ×1',
    'item.excavator2':    '底面掘削 ×2',
    'item.excavator3':    '底面掘削 ×3',
    'item.excavatorTop1': '天面掘削 ×1',
    'item.excavatorTop2': '天面掘削 ×2',
    'item.excavatorTop3': '天面掘削 ×3',
    'item.shapeshifter':  '形状変化',
    'item.rewind':        '巻き戻し',
    'item.meteor1':       'メテオ ×5',
    'item.meteor2':       'メテオ ×10',
    'item.meteor3':       'メテオ ×15',
    'item.rocket1':       'ロケット ×8',
    'item.rocket2':       'ロケット ×16',
    'item.rocket3':       'ロケット ×24',
    'item.gatling1':      'ガトリング ×4',
    'item.gatling2':      'ガトリング ×8',
    'item.gatling3':      'ガトリング ×12',
    'item.mortar5':       'モルタル ×5',
    'item.mortar10':      'モルタル ×10',
    'item.mortar15':      'モルタル ×15',

    // ---------- アイテム説明 ----------
    'desc.hourglass1':    '1 分間ブロック落下速度が半減',
    'desc.hourglass2':    '2 分間ブロック落下速度が半減',
    'desc.hourglass3':    '3 分間ブロック落下速度が半減',
    'desc.excavator1':    'タワー底の色付き 1 段を消去',
    'desc.excavator2':    'タワー底の色付き 2 段を消去',
    'desc.excavator3':    'タワー底の色付き 3 段を消去',
    'desc.excavatorTop1': 'タワー頂の色付き 1 段を消去',
    'desc.excavatorTop2': 'タワー頂の色付き 2 段を消去',
    'desc.excavatorTop3': 'タワー頂の色付き 3 段を消去',
    'desc.shapeshifter':  '次のブロック形状を選ぶ',
    'desc.rewind':        '盤面を 3 手前に戻す',
    'desc.meteor1':       '5 個の 1×1 ブロックが急速落下',
    'desc.meteor2':       '10 個の 1×1 ブロックが急速落下',
    'desc.meteor3':       '15 個の 1×1 ブロックが急速落下',
    'desc.rocket1':       '使用時、8 個のブロックが空から降り、塔頂の最上段ブロックを消去',
    'desc.rocket2':       '使用時、16 個のブロックが空から降り、塔頂の最上段ブロックを消去',
    'desc.rocket3':       '使用時、24 個のブロックが空から降り、塔頂の最上段ブロックを消去',
    'desc.gatling1':      '使用時、4 個のブロックが高速で降下し、下のブロックを 1 つずつ撃破',
    'desc.gatling2':      '使用時、8 個のブロックが高速で降下し、下のブロックを 1 つずつ撃破',
    'desc.gatling3':      '使用時、12 個のブロックが高速で降下し、下のブロックを 1 つずつ撃破',
    'desc.mortar5':       '使用時、5 個のブロックが上から落下し、空隙を埋める',
    'desc.mortar10':      '使用時、10 個のブロックが上から落下し、空隙を埋める',
    'desc.mortar15':      '使用時、15 個のブロックが上から落下し、空隙を埋める',

    // ---------- バックパックアイテム（3種） ----------
    'item.mini_block':    'ミニブロック',
    'item.bomb_block':    '爆弾ブロック',
    'item.rename_card':   '改名カード',
    'desc.mini_block':    '使用後、次のブロックが 1×1 の小さなブロックになる',
    'desc.bomb_block':    '使用後、次のブロックが爆弾になる。着地時に爆弾を中心とした 3×3 の範囲を消去',
    'desc.rename_card':   'カード 1 枚を消費してニックネームを 1 回変更できる。カードなしでは改名できない。',

    // ---------- バックパックUI ----------
    'backpack.use':          '使用',
    'backpack.using':        '使用中...',
    'backpack.useDisabled':  '使用不可',
    'backpack.useIngameOnly':'ゲーム中のみ使用可',

    // ---------- 形状変化ダイアログ ----------
    'shapeshifter.title':    '🎲 形状変化',
    'shapeshifter.subtitle': '現在のブロックの形状を選択',
    'shapeshifter.cancel':   'キャンセル',

    // ---------- 運命ブロックダイアログ ----------
    'fate.modalTitle':   '運命のブロック',
    'fate.reroll':       '運命を変える ({n}/3)',
    'fate.reroll.ad':    '🎬 広告で運命を変える',
    'fate.start':        'スタート',
    'fate.cellCount':    '{n} マス',
    'fate.endlessSub':   'エンドレス',
    'fate.endlessMid':   'エンドレス · {layer} 層',
    'fate.subtitle':     '{tag} · {n} マス',
    'fate.hint':         '運命を変える：広告視聴で新しい運命ブロックに交換',

    // ---------- コレクトモード ----------
    'collect.header':    'コレクト目標',

    // ---------- ステージ選択 ----------
    'level.name':        'ステージ {n}',
    'level.floorName':   'ステージ {n}階',
    'level.clearTime':   'クリア時間：{time}',
    'level.congrats':    'ステージクリア！',
    'level.enter':       'ステージ開始',

    // ---------- ブラインドモード ----------
    'blind.fail.prompt': 'チャレンジ失敗。タップで続行',
    'blind.showTower':   '🙉 タワー表示',
    'blind.hideTower':   '🙈 タワー非表示',

    // ---------- エンドレスマイルストーン（12 段ごと）----------
    'endless.milestone': '{n} 層達成！',

    // ---------- 一時停止 ----------
    'pause.title':       '⏸ 一時停止',
    'pause.hint':        'タップで再開',
    'pause.continue':    '▶ 続ける',
    'pause.home':        '■ ホーム',

    // ---------- DEV ボタン ----------
    'debug.forceWin':    '強制クリア',

    // ---------- チュートリアル ----------
    'tutorial.hint.tap':          'タップでブロック変形',
    'tutorial.hint.swipeRelease': '指をドラッグ、タワーが1マスずつ回転',
    'tutorial.hint.swipeHold':    '素早くスワイプして離す、タワーが慣性で回転',
    'tutorial.hint.swipeDown':    '下スワイプで即落下',
    'tutorial.skip':              'スキップ',

    // ---------- ログイン画面 ----------
    'login.title':          'Tetri Tower へようこそ',
    'login.subtitle':       '開始方法を選択',
    'login.namePlaceholder':'ニックネーム入力（任意）',
    'login.guestButton':    'ゲストで続ける',
    'login.emailButton':    'メールでログイン',
    'login.googleButton':   'Google でログイン',
    'login.appleButton':    'Apple でログイン',
    'login.comingSoon':     '（近日公開）',
    'login.orDivider':      'または',

    // ---------- チャージ ----------
    'menu.topup':           'チャージ',
    'topup.title':          'ジェム購入',
    'topup.balance':        '{n}',
    'topup.gems':           '{n} ジェム',
    'topup.price':          '{price}',
    'topup.buyButton':      '購入',
    'topup.close':          '閉じる',
    'topup.successTitle':   '購入完了',
    'topup.successBody':    '{n} ジェムを取得',
    'topup.failTitle':      '購入失敗',
    'topup.failBody':       '{reason}',
    'topup.processing':     '処理中...',
    'topup.mockNotice':     '（テストモード - 実際の課金はありません）',

    // ---------- ランキング ----------
    'leaderboard.title':       'ランキング',
    'leaderboard.back':        '↩ 戻る',
    'leaderboard.tab.level':   'ステージ',
    'leaderboard.tab.endless': 'エンドレス',
    'leaderboard.tab.blind':   'ブラインド',
    'leaderboard.you':         'あなた',
    'leaderboard.empty':       'データなし',
    'leaderboard.mockName':    'プレイヤー{n}',

    // ---------- 結果ダイアログ ----------
    'result.gameOver':   'ゲームオーバー',
    'result.levelFail':  'ステージ失敗',
    'result.fail.hole':  '戻せない空きマスが発生',
    'result.fail.tall':  'タワーが高すぎます',
    'result.win':        'クリア ✓',
    'result.retry':      'リトライ',
    'result.endlessRetry': 'もう一度',
    'result.replay':     'リプレイ',
    'result.levelSelect':'ステージ',
    'result.home':       'ホーム',
    'result.reviveAd':   '🎬 広告を見て復活',
    'result.reviveAd.failed': '広告の読み込みに失敗しました。しばらくしてからやり直してください',
    'result.reviveTitle':        '復活する？',
    'result.reviveCountdown':    '{n}秒後に消えます',
    'result.reviveGems':         '💎 {n} で復活',
    'result.reviveGems.failed':  '復活に失敗しました。しばらくしてから再試行',
    'result.reviveGems.notEnough':'ジェムが足りません — 先にチャージ',

    // ---------- 言語切替 ----------
    'lang.toggle':       '日本語',

    // ---------- 設定パネル ----------
    'settings.button':       '⚙ 設定',
    'settings.title':        '設定',
    'settings.lang':         '言語',
    'settings.gesture':      'ジェスチャー',
    'settings.gesture.both': 'フリック + ドラッグ',
    'settings.gesture.drag': 'ドラッグのみ',
    'settings.keys':         'バーチャルボタン',
    'settings.keys.on':      'オン',
    'settings.keys.off':     'オフ',
    'settings.bgm':          'BGM',
    'settings.sfx':          '効果音',
    'settings.haptic':       'バイブレーション',
    'settings.controls':       '操作方法',
    'controls.title':          '操作方法を選択',
    'controls.legacy':         'クラシック（スワイプ+長押し）',
    'controls.dragFling':      'ドラッグ+フリック',
    'controls.buttons':        'ボタン操作',
    'controls.close':          '閉じる',
    'controls.classic':      'クラシック',
    'controls.advanced':     'アドバンス',
    'controls.expert':       'エキスパート',
    'settings.nickname':     'ニックネーム',
    'settings.volume':       '音量',
    'settings.accountData':  'アカウント管理',
    'settings.googleAccount': 'Google アカウント',
    'settings.appleAccount': 'Apple アカウント',
    'settings.notBound':     '未連携',
    'settings.close':        '閉じる',
    'audio.off':             'オフ',
    'audio.percent':         '{n}%',
    'settings.account.guest':  'ゲスト',
    'settings.account.google': 'Google',
    'settings.account.apple':  'Apple',
    'settings.account.email':  'メール',
    'settings.account.copied':      'クリップボードにコピー',
    'settings.account.copyFailed':  'コピー失敗',
    'settings.nickname.tooLong':     'ニックネームは最大 {n} 文字',
    'settings.nickname.profanity':   'ニックネームに禁止語が含まれています',
    'settings.nickname.reserved':    'このニックネームは予約されています',
    'settings.nickname.tooShort':    'ニックネームが短すぎます',
    'settings.nickname.tooLongServer':'ニックネームが長すぎます',
    'settings.nickname.rejected':    '無効なニックネームです',
    'settings.nickname.noCard':      'ニックネームの変更には改名カードが 1 枚必要です — バックパックで入手してください',
    'settings.nickname.cooldown':    '次回変更まであと {n} 日',
    'settings.nickname.cooldownReady':'今すぐ変更可能（次回は 7 日待機）',
    'settings.nickname.title':       'ニックネーム変更',
    'settings.nickname.placeholder': '新しいニックネームを入力',

    // ---------- Common modal buttons ----------
    'common.confirm':    '確認',
    'common.cancel':     'キャンセル',

    // ---------- アカウント削除 (App Store 5.1.1(v) 必須) ----------
    'settings.deleteAccount':         'アカウント削除',
    'settings.deleteAccount.title':   'アカウントを削除？',
    'settings.deleteAccount.desc':    'この操作は取り消せません。全データ（ジェム、進捗、連携）が永久に削除されます。',
    'settings.bound':                 '連携済み',
    'settings.unbound':               '未連携',
    // ---- 新規プレイヤー 14 日間ボーナス ----
    'event.newbie14.title':           '新規 14 日ボーナス',
    'event.newbie14.subtitle':        '毎日ログインでジェムをゲット',
    'event.newbie14.claim':           '{gems} ジェムを受け取る',
    'event.newbie14.claiming':        '受取中…',
    'event.newbie14.claimed':         '本日受取済み',
    'event.newbie14.alreadyClaimed':  '本日はすでに受け取り済みです',
    'event.newbie14.grantedToast':    '{gems} 💎 を獲得',
    'event.newbie14.ended':           'イベント終了',
    'event.newbie14.daysLeft':        '残り {days} 日',
    'event.newbie14.loading':         '読み込み中…',
    'event.newbie14.error':           '受取失敗。再度お試しください',
    // ---- ゲーム終了確認 ----
    'exit.title':                     'ゲーム終了',
    'exit.desc':                      'ゲームを終了しますか？',
    'exit.confirm':                   '終了',
    'exit.cancel':                    'キャンセル',
    'settings.google.pending':        'Google ログインを開いています…',
    'settings.google.linked':         'Google アカウントを連携しました',
    'settings.google.alreadyLinked':  'Google アカウントは既に連携済み',
    'settings.google.unsupported':    'この端末では Google ログインは利用できません',
    'settings.google.error':          'Google ログインに失敗しました。もう一度お試しください',
    'settings.google.recover.title':  'この Google アカウントは既に別アカウントに連携されています',
    'settings.google.recover.desc':   'この Google アカウントは別のゲームアカウントに連携済みです。復元すると現在のゲストアカウントは破棄されます。続行しますか？',
    'settings.google.recovered':      'Google 連携アカウントを復元しました',
    'settings.deleteAccount.pending': '削除中...',
    'settings.deleteAccount.failed':  '削除失敗、再試行してください',

    'settings.tos':     '利用規約',
    'settings.privacy': 'プライバシーポリシー',
    // ジェム不足
    'gems.insufficient': 'ジェム不足\n必要 {need}、所持 {have}',
    'gems.goTopUp':      'チャージへ',
    'gems.cancel':       'キャンセル',

    // ---------- Consent modal (login-gate) ----------
    'consent.title':                             'プレイするには利用規約およびプライバシーポリシーへの同意が必要です！',
    'consent.agreeAll':                             'すべてに同意する',
    'consent.tos.label':                             '利用規約に同意',
    'consent.privacy.label':                             'プライバシーポリシーに同意',
    'consent.age.label':                             '14歳以上です',
    'consent.marketing.label':                             'マーケティング情報の受信に同意',
    'consent.required':                             '必須',
    'consent.optional':                             '任意',
    'consent.view':                             '表示',
    'consent.start':                             '同意して開始',
    'consent.mustAgree':                             'ゲームを開始するには必須項目すべてに同意する必要があります。',
    'consent.error':                             '同意の記録に失敗しました。しばらくしてから再試行してください。',

    // ---------- Account recovery popup ----------
    'settings.appleRecovery.confirm':                                       'この Apple ID は別のアカウントに連携されています。もう一度タップで復元',
    'settings.appleRecovery.title':                                       'アカウントを復元しますか？',
    'settings.appleRecovery.desc':                                       'この Apple ID は既に別のゲームアカウントに連携されています。確定するとそのアカウントに切り替わり、現在のゲストデータ（ダイヤモンド、進行状況）は引き継がれません。',
    'settings.appleRecovery.pending':                                       '復元中...',
    'settings.appleRecovery.failed':                                       '復元失敗、再試行してください',
    'settings.appleRecovery.success':                                       'アカウントを復元しました',
    'settings.googleRecovery.title':                                       'アカウントを復元しますか？',
    'settings.googleRecovery.desc':                                       'この Google アカウントは既に別のゲームアカウントに連携されています。確定するとそのアカウントに切り替わり、現在のゲストデータ（ダイヤモンド、進行状況）は引き継がれません。',
    'settings.googleRecovery.pending':                                       '復元中...',
    'settings.googleRecovery.failed':                                       '復元失敗、再試行してください',
    'settings.googleRecovery.success':                                       'アカウントを復元しました',
    // ---- Progressive unlock tips ----
    'lock.endless':      '{n}階に到達でエンドレスモード解放',
    'lock.blind':        'エンドレスで {n} 層達成でブラインドモード解放',
    'lock.leaderboard':  'エンドレスで {n} 層達成でランキング解放',
    'level.next':        '次のステージ',
    'level.floor':       '{n}階',
};
