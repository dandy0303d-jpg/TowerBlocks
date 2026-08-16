/**
 * English language pack. Mirrors the key set in `zh.ts`. Missing keys
 * fall back to the Chinese string at runtime via the i18n module's
 * `t()` helper.
 */
export const EN: Record<string, string> = {
    // ---------- Main menu ----------
    'menu.title':        'Tetri Tower',
    'menu.subtitle':     'To the Heavens',
    'menu.endless':      'Endless',
    'menu.levels':       'Levels',
    'menu.blind':        'Blind',
    'menu.leaderboard':  'Leaderboard',
    'menu.reset':        'Reset',
    'menu.levelSelect':  'Select Level',
    'menu.back':         '← Back',

    // ---------- Boot loading screen ----------
    'loading.text':      'Loading',

    // ---------- HUD ----------
    'hud.back':          '← Home',
    'hud.height':        'Height',
    'hud.heightValue':   'Height  {n}',
    'hud.next':          'NEXT',

    // ---------- Picker ----------
    'picker.title':      '⚡ Pick a Magic Item',
    'picker.hint':       'Tap to confirm · Colour = Rarity',
    'picker.refresh':    '🔄 Free Reroll',
    'picker.adRefresh':  '🎬 Watch Ad to Reroll',
    'rarity.common':     'Common',
    'rarity.uncommon':   'Uncommon',
    'rarity.rare':       'Rare',
    'rarity.epic':       'Epic',

    // ---------- Item names ----------
    'item.hourglass1':    'Hourglass 1 min',
    'item.hourglass2':    'Hourglass 2 min',
    'item.hourglass3':    'Hourglass 3 min',
    'item.excavator1':    'Excavator ×1',
    'item.excavator2':    'Excavator ×2',
    'item.excavator3':    'Excavator ×3',
    'item.excavatorTop1': 'Top-Sweeper ×1',
    'item.excavatorTop2': 'Top-Sweeper ×2',
    'item.excavatorTop3': 'Top-Sweeper ×3',
    'item.shapeshifter':  'Shapeshift',
    'item.rewind':        'Rewind',
    'item.meteor1':       'Meteor Shower ×5',
    'item.meteor2':       'Meteor Shower ×10',
    'item.meteor3':       'Meteor Shower ×15',
    'item.rocket1':       'Rockets ×8',
    'item.rocket2':       'Rockets ×16',
    'item.rocket3':       'Rockets ×24',
    'item.gatling1':      'Gatling ×4',
    'item.gatling2':      'Gatling ×8',
    'item.gatling3':      'Gatling ×12',
    'item.mortar5':       'Mortar ×5',
    'item.mortar10':      'Mortar ×10',
    'item.mortar15':      'Mortar ×15',

    // ---------- Item descriptions ----------
    'desc.hourglass1':    'Slow drops for 1 minute',
    'desc.hourglass2':    'Slow drops for 2 minutes',
    'desc.hourglass3':    'Slow drops for 3 minutes',
    'desc.excavator1':    'Clear 1 colored row from bottom',
    'desc.excavator2':    'Clear 2 colored rows from bottom',
    'desc.excavator3':    'Clear 3 colored rows from bottom',
    'desc.excavatorTop1': 'Clear 1 colored row from top',
    'desc.excavatorTop2': 'Clear 2 colored rows from top',
    'desc.excavatorTop3': 'Clear 3 colored rows from top',
    'desc.shapeshifter':  'Pick the next piece shape',
    'desc.rewind':        'Roll board back 3 steps',
    'desc.meteor1':       '5 tiny cubes rain down fast',
    'desc.meteor2':       '10 tiny cubes rain down fast',
    'desc.meteor3':       '15 tiny cubes rain down fast',
    'desc.rocket1':       '8 rockets pierce the top blocks',
    'desc.rocket2':       '16 rockets pierce the top blocks',
    'desc.rocket3':       '24 rockets pierce the top blocks',
    'desc.gatling1':      '4 bullets sweep from center',
    'desc.gatling2':      '8 bullets sweep from center',
    'desc.gatling3':      '12 bullets sweep from center',
    'desc.mortar5':       '5 drops fill floating gaps',
    'desc.mortar10':      '10 drops fill floating gaps',
    'desc.mortar15':      '15 drops fill floating gaps',

    // ---------- Shapeshifter modal ----------
    'shapeshifter.title':    '🎲 Shapeshift',
    'shapeshifter.subtitle': 'Pick a shape for the current piece',
    'shapeshifter.cancel':   'Cancel',

    // ---------- Fate piece modal ----------
    'fate.modalTitle':   'Fate Piece',
    'fate.reroll':       'Reroll Fate',
    'fate.start':        'Start',
    'fate.cellCount':    '{n} cells',
    'fate.endlessSub':   'Endless',
    'fate.levelSub':     'Level {n}',
    'fate.endlessMid':   'Endless · Layer {layer}',
    'fate.subtitle':     '{tag} · {n} cells',
    'fate.hint':         'Reroll: watch an ad to swap for a random fate piece',

    // ---------- Collect mode ----------
    'collect.header':    'Collect Goals',

    // ---------- Level select ----------
    'level.name':        'Level {n}',
    'level.enter':       'Enter Level',

    // ---------- Blind mode ----------
    'blind.fail.prompt': 'Challenge failed. Tap anywhere to continue.',
    'blind.showTower':   '🙉 Show Tower',
    'blind.hideTower':   '🙈 Hide Tower',

    // ---------- Endless milestone (every 12 rows) ----------
    'endless.milestone': 'Level {n} reached!',

    // ---------- Pause overlay ----------
    'pause.title':       '⏸ Paused',
    'pause.hint':        'Tap Continue to resume',
    'pause.continue':    '▶ Continue',
    'pause.home':        '< Home',

    // ---------- DEV buttons ----------
    'debug.forceWin':    'Force Win',

    // ---------- Tutorial ----------
    'tutorial.hint.tap':          'Tap to morph the piece',
    'tutorial.hint.swipeRelease': 'Swipe horizontally and release to rotate one column',
    'tutorial.hint.swipeHold':    'Swipe and hold to keep rotating',
    'tutorial.hint.swipeDown':    'Swipe down to hard-drop',
    'tutorial.skip':              'Skip',

    // ---------- Login screen ----------
    'login.title':          'Welcome to Tetri Tower',
    'login.subtitle':       'Choose a way to start',
    'login.namePlaceholder':'Enter a nickname (optional)',
    'login.guestButton':    'Continue as Guest',
    'login.emailButton':    'Email Login',
    'login.googleButton':   'Google Login',
    'login.appleButton':    'Apple Login',
    'login.comingSoon':     '(Coming soon)',
    'login.orDivider':      'or',

    // ---------- Top-up ----------
    'menu.topup':           'Top Up',
    'topup.title':          'Buy Gems',
    'topup.balance':        'Gems: {n}',
    'topup.gems':           '{n} Gems',
    'topup.price':          '{price}',
    'topup.buyButton':      'Buy',
    'topup.close':          'Close',
    'topup.successTitle':   'Purchase Successful',
    'topup.successBody':    'Received {n} gems',
    'topup.failTitle':      'Purchase Failed',
    'topup.failBody':       '{reason}',
    'topup.processing':     'Processing...',
    'topup.mockNotice':     '(Test mode — no real charge)',

    // ---------- Leaderboard ----------
    'leaderboard.title':       'Leaderboard',
    'leaderboard.back':        '↩ Back',
    'leaderboard.tab.level':   'Levels',
    'leaderboard.tab.endless': 'Endless',
    'leaderboard.tab.blind':   'Blind',
    'leaderboard.you':         'You',
    'leaderboard.empty':       'No data yet',
    'leaderboard.mockName':    'Player {n}',

    // ---------- Result modals ----------
    'result.gameOver':   'Game Over',
    'result.levelFail':  'Level Failed',
    'result.fail.hole':  'Trapped hole sealed',
    'result.fail.tall':  'Tower too tall',
    'result.win':        'Cleared ✓',
    'result.retry':      'Retry',
    'result.endlessRetry': 'Play Again',
    'result.nextLevel':  'Next Level',
    'result.replay':     'Replay',
    'result.levelSelect':'Levels',
    'result.home':       'Home',

    // ---------- Language toggle ----------
    // Shows the CURRENT language ("you are here") — click to cycle.
    'lang.toggle':       'English',

    // ---------- Settings panel ----------
    'settings.button':       '⚙ Settings',
    'settings.title':        'Settings',
    'settings.lang':         'Language',
    'settings.gesture':      'Gesture',
    'settings.gesture.both': 'Flick + Drag',
    'settings.gesture.drag': 'Drag only',
    'settings.keys':         'On-screen Keys',
    'settings.keys.on':      'On',
    'settings.keys.off':     'Off',
    'settings.bgm':          'Music',
    'settings.sfx':          'Sound FX',
    'settings.close':        'Close',
    'audio.off':             'Off',
    'audio.percent':         '{n}%',
    'settings.account.guest':  'Guest',
    'settings.account.google': 'Google',
    'settings.account.apple':  'Apple',
    'settings.account.email':  'Email',
    'settings.account.copied':      'Copied to clipboard',
    'settings.account.copyFailed':  'Copy failed',
    'settings.nickname.tooLong':     'Nickname must be at most {n} characters',
    'settings.nickname.title':       'Edit Nickname',
    'settings.nickname.placeholder': 'Enter a new nickname',

    // ---------- Common modal buttons ----------
    'common.confirm':    'Confirm',
    'common.cancel':     'Cancel',

    // ---------- Account deletion (App Store 5.1.1(v) required) ----------
    'settings.deleteAccount':         'Delete Account',
    'settings.deleteAccount.title':   'Delete account?',
    'settings.deleteAccount.desc':    'This cannot be undone. All data (gems, progress, linked accounts) will be permanently erased.',
    'settings.deleteAccount.pending': 'Deleting...',
    'settings.deleteAccount.failed':  'Delete failed, please retry',
    'settings.tos':     'Terms of Service',
    'settings.privacy': 'Privacy Policy',
    'settings.deleteAccount':          'Delete Account',
    'settings.deleteAccount.confirm':  'Tap again to confirm delete',
    'settings.deleteAccount.pending':  'Deleting...',
    'settings.deleteAccount.failed':   'Delete failed, try again',
    'settings.appleRecovery.confirm':  'This Apple ID is linked elsewhere. Tap again to restore',
    'settings.appleRecovery.title':    'Restore account?',
    'settings.appleRecovery.desc':     'This Apple ID is already linked to another game account. Confirming will switch to that account. Your current guest data (gems, progress) will NOT be carried over.',
    'settings.appleRecovery.pending':  'Restoring...',
    'settings.appleRecovery.failed':   'Restore failed, try again',
    'settings.appleRecovery.success':  'Account restored',
    // Bind toasts
    'settings.bind.success':           'Apple account linked',
    'settings.bind.failed':            'Link failed, try again',
    'settings.bind.cancelled':         'Sign-in cancelled',
    // Not-enough-gems popup
    'gems.insufficient': 'Not enough gems\nNeed {need}, have {have}',
    'gems.goTopUp':      'Top Up',
    'gems.cancel':       'Cancel',
};
