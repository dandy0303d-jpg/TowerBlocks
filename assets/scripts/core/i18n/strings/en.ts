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
    'menu.unlockAll':    'Unlock All',
    'menu.levelSelect':  'Select Level',
    'menu.back':         '← Back',

    // ---------- Boot loading screen ----------
    'loading.text':      'Loading',

    // ---------- HUD ----------
    'hud.back':          '← Home',
    'hud.height':        'Height',
    'hud.heightValue':   'Height  {n}',
    'hud.next':          'Next',

    // ---------- Picker ----------
    'picker.title':      '⚡ Pick a Magic Item',
    'refresh.limitReached':'Limit reached',
    'picker.hint':       'Tap to confirm · Colour = Rarity',
    'picker.refresh':    '🔄 Free Reroll ({n}/3)',
    'picker.adRefresh':  '🎬 Watch Ad to Reroll',
    'picker.adRefresh.failed': 'Ad unavailable, try again later',
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
    'desc.rocket1':       'On use: 8 blocks fall from the sky and destroy the topmost blocks of the tower',
    'desc.rocket2':       'On use: 16 blocks fall from the sky and destroy the topmost blocks of the tower',
    'desc.rocket3':       'On use: 24 blocks fall from the sky and destroy the topmost blocks of the tower',
    'desc.gatling1':      'On use: 4 blocks rapid-fire down, breaking the blocks below one by one',
    'desc.gatling2':      'On use: 8 blocks rapid-fire down, breaking the blocks below one by one',
    'desc.gatling3':      'On use: 12 blocks rapid-fire down, breaking the blocks below one by one',
    'desc.mortar5':       'On use: 5 blocks fall from above and fill empty gaps',
    'desc.mortar10':      'On use: 10 blocks fall from above and fill empty gaps',
    'desc.mortar15':      'On use: 15 blocks fall from above and fill empty gaps',

    // ---------- Shapeshifter modal ----------
    'shapeshifter.title':    '🎲 Shapeshift',
    'shapeshifter.subtitle': 'Pick a shape for the current piece',
    'shapeshifter.cancel':   'Cancel',

    // ---------- Fate piece modal ----------
    'fate.modalTitle':   'Fate Piece',
    'fate.reroll':       'Reroll Fate ({n}/3)',
    'fate.reroll.ad':    '🎬 Watch Ad to Reroll',
    'fate.start':        'Start',
    'fate.cellCount':    '{n} cells',
    'fate.endlessSub':   'Endless',
    'fate.endlessMid':   'Endless · Layer {layer}',
    'fate.subtitle':     '{tag} · {n} cells',
    'fate.hint':         'Reroll: watch an ad to swap for a random fate piece',
    'fate.reroll.failed':'Ad unavailable, try again later',

    // ---------- Collect mode ----------
    'collect.header':    'Collect Goals',

    // ---------- Level select ----------
    'level.name':        'Level {n}',
    'level.floorName':   'Floor {n}',
    'level.clearTime':   'Clear time: {time}',
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
    'pause.home':        '■ Home',

    // ---------- DEV buttons ----------
    'debug.forceWin':    'Force Win',

    // ---------- Tutorial ----------
    'tutorial.hint.tap':          'Tap to morph the piece',
    'tutorial.hint.swipeRelease': 'Drag to rotate the tower one step',
    'tutorial.hint.swipeHold':    'Flick and release — the tower spins with inertia',
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
    'topup.balance':        '{n}',
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
    'result.fail.hole':  'Irreversible gap formed',
    'result.fail.tall':  'Tower too tall',
    'result.win':        'Cleared ✓',
    'result.retry':      'Retry',
    'result.endlessRetry': 'Play Again',
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
    'settings.haptic':       'Vibration',
    'settings.controls':       'Controls',
    'controls.title':          'Choose control scheme',
    'controls.legacy':         'Classic (swipe + hold)',
    'controls.dragFling':      'Drag + Flick',
    'controls.buttons':        'On-screen buttons',
    'controls.close':          'Close',
    'controls.classic':      'Classic',
    'controls.advanced':     'Advanced',
    'controls.expert':       'Expert',
    'settings.nickname':     'Nickname',
    'settings.volume':       'Volume',
    'settings.accountData':  'Account Management',
    'settings.googleAccount': 'Google Account',
    'settings.appleAccount': 'Apple Account',
    'settings.notBound':     'Not linked',
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
    'settings.nickname.cooldown':    '{n} day(s) until you can change again',
    'settings.nickname.cooldownReady':'You can change now (7-day cooldown after)',
    'settings.nickname.placeholder': 'Enter a new nickname',
    'settings.nickname.profanity':   'Nickname contains prohibited words',
    'settings.nickname.reserved':    'That nickname is reserved',
    'settings.nickname.tooShort':    'Nickname too short',
    'settings.nickname.tooLongServer':'Nickname too long',
    'settings.nickname.rejected':    'Invalid nickname, try another',

    // ---------- Common modal buttons ----------
    'common.confirm':    'Confirm',
    'common.cancel':     'Cancel',

    // ---------- Account banned ----------
    'banned.title':      'Account Banned',
    'banned.desc':       'This account has been banned. Reason: {reason}\n\nContact support if you believe this is a mistake.',
    'banned.ok':         'OK',

    // ---------- Account deletion (App Store 5.1.1(v) required) ----------
    'settings.deleteAccount':         'Delete Account',
    'settings.deleteAccount.title':   'Delete account?',
    'settings.deleteAccount.desc':    'This cannot be undone. All data (gems, progress, linked accounts) will be permanently erased.',
    'settings.deleteAccount.confirm': 'Tap again to confirm delete',
    'settings.bound':                 'Linked',
    'settings.unbound':               'Not linked',
    // ---- Newbie 14-day gift event ----
    'event.newbie14.title':           'Newcomer 14-Day Gift',
    'event.newbie14.subtitle':        'Log in every day to claim gems',
    'event.newbie14.claim':           'Claim {gems} gems',
    'event.newbie14.claiming':        'Claiming…',
    'event.newbie14.claimed':         "Claimed today",
    'event.newbie14.alreadyClaimed':  "You've already claimed today",
    'event.newbie14.grantedToast':    'Received {gems} 💎',
    'event.newbie14.ended':           'Event has ended',
    'event.newbie14.daysLeft':        '{days} days left',
    'event.newbie14.loading':         'Loading…',
    'event.newbie14.error':           'Claim failed. Please try again.',
    // ---- Exit game confirm ----
    'exit.title':                     'Exit Game',
    'exit.desc':                      'Are you sure you want to exit?',
    'exit.confirm':                   'Exit',
    'exit.cancel':                    'Cancel',
    'settings.google.pending':        'Opening Google sign-in…',
    'settings.google.linked':         'Google account linked',
    'settings.google.alreadyLinked':  'Google account already linked',
    'settings.google.unsupported':    'Google sign-in not supported on this device',
    'settings.google.error':          'Google sign-in failed, please try again',
    'settings.google.recover.title':  'Google account bound to another player',
    'settings.google.recover.desc':   'This Google account is already linked to a different game account. Recovering will replace your current guest account. Continue?',
    'settings.google.recovered':      'Recovered linked Google account',
    'settings.deleteAccount.pending': 'Deleting...',
    'settings.deleteAccount.failed':  'Delete failed, please retry',
    'settings.tos':     'Terms of Service',
    'settings.privacy': 'Privacy Policy',
    // NOTE: duplicate 'settings.deleteAccount' keys used to live here.
    // ko.ts had a divergent value that silently overrode the block
    // above; removed here too for consistency. The 'confirm' key now
    // lives with the rest of the deleteAccount strings above.
    'settings.appleRecovery.confirm':  'This Apple ID is linked elsewhere. Tap again to restore',
    'settings.appleRecovery.title':    'Restore account?',
    'settings.appleRecovery.desc':     'This Apple ID is already linked to another game account. Confirming will switch to that account. Your current guest data (gems, progress) will NOT be carried over.',
    'settings.appleRecovery.pending':  'Restoring...',
    'settings.appleRecovery.failed':   'Restore failed, try again',
    'settings.appleRecovery.success':  'Account restored',
    // Bind toasts
    'settings.bind.success':           'Account linked',
    'settings.bind.failed':            'Link failed, try again',
    'settings.bind.cancelled':         'Sign-in cancelled',
    // Google account recovery
    'settings.googleRecovery.title':   'Restore account?',
    'settings.googleRecovery.desc':    'This Google account is already linked to another game account. Confirming will switch to that account. Your current guest data (gems, progress) will NOT be carried over.',
    'settings.googleRecovery.pending': 'Restoring...',
    'settings.googleRecovery.failed':  'Restore failed, try again',
    'settings.googleRecovery.success': 'Account restored',
    // Not-enough-gems popup
    'gems.insufficient': 'Not enough gems\nNeed {need}, have {have}',
    'gems.goTopUp':      'Top Up',
    'gems.cancel':       'Cancel',

    // ---------- Consent modal (login-gate) ----------
    'consent.title':                             'You must agree to the Terms of Service and Privacy Policy to play!',
    'consent.agreeAll':                             'I agree to all',
    'consent.tos.label':                             'Terms of Service',
    'consent.privacy.label':                             'Privacy Policy',
    'consent.age.label':                             'I am 14 or older',
    'consent.marketing.label':                             'Receive marketing communications',
    'consent.required':                             'Required',
    'consent.optional':                             'Optional',
    'consent.view':                             'View',
    'consent.start':                             'Agree & Start',
    'consent.mustAgree':                             'You must agree to all required items to start the game.',
    'consent.error':                             'Failed to record your agreement. Please try again.',
    // ---- Progressive unlock tips ----
    'lock.endless':      'Reach floor {n} to unlock Endless mode',
    'lock.blind':        'Reach {n} layers in Endless to unlock Blind mode',
    'lock.leaderboard':  'Reach {n} layers in Endless to unlock Leaderboard',
    'level.next':        'Next Level',
    'level.floor':       'Floor {n}',
};
