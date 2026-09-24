/**
 * Korean (한국어) language pack. Mirrors the key set in `zh.ts`. Missing
 * keys fall back to Chinese at runtime via the i18n module's `t()`.
 */
export const KO: Record<string, string> = {
    // ---------- Main menu ----------
    'menu.title':        'Tetri Tower',
    'menu.subtitle':     'To the Heavens',
    'menu.endless':      '무한 모드',
    'menu.levels':       '스테이지',
    'menu.blind':        '블라인드 모드',
    'menu.leaderboard':  '순위표',
    'menu.reset':        '초기화',
    'menu.unlockAll':    '전부 해금',
    'menu.levelSelect':  '스테이지 선택',
    'menu.back':         '← 뒤로',

    // ---------- Boot loading screen ----------
    'loading.text':      '로딩 중',

    // ---------- HUD ----------
    'hud.back':          '← 홈',
    'hud.height':        '높이',
    'hud.heightValue':   '높이  {n}',
    'hud.next':          '다음',

    // ---------- Picker ----------
    'picker.title':      '⚡ 마법 아이템을 1개 선택',
    'refresh.limitReached':'상한 도달',
    'picker.hint':       '카드를 탭하여 확인 · 색상 = 등급',
    'picker.refresh':    '🔄 무료 리롤 ({n}/3)',
    'picker.adRefresh':  '🎬 광고 보고 한 번 더',
    'rarity.common':     '일반',
    'rarity.uncommon':   '고급',
    'rarity.rare':       '희귀',
    'rarity.epic':       '영웅',

    // ---------- Item names ----------
    'item.hourglass1':    '모래시계 1분',
    'item.hourglass2':    '모래시계 2분',
    'item.hourglass3':    '모래시계 3분',
    'item.excavator1':    '바닥 굴착기 ×1',
    'item.excavator2':    '바닥 굴착기 ×2',
    'item.excavator3':    '바닥 굴착기 ×3',
    'item.excavatorTop1': '천장 굴착기 ×1',
    'item.excavatorTop2': '천장 굴착기 ×2',
    'item.excavatorTop3': '천장 굴착기 ×3',
    'item.shapeshifter':  '변형',
    'item.rewind':        '되감기',
    'item.meteor1':       '유성우 ×5',
    'item.meteor2':       '유성우 ×10',
    'item.meteor3':       '유성우 ×15',
    'item.rocket1':       '로켓탄 ×8',
    'item.rocket2':       '로켓탄 ×16',
    'item.rocket3':       '로켓탄 ×24',
    'item.gatling1':      '개틀링 ×4',
    'item.gatling2':      '개틀링 ×8',
    'item.gatling3':      '개틀링 ×12',
    'item.mortar5':       '몰탈 ×5',
    'item.mortar10':      '몰탈 ×10',
    'item.mortar15':      '몰탈 ×15',

    // ---------- Item descriptions ----------
    'desc.hourglass1':    '1분간 블록 낙하 속도 절반',
    'desc.hourglass2':    '2분간 블록 낙하 속도 절반',
    'desc.hourglass3':    '3분간 블록 낙하 속도 절반',
    'desc.excavator1':    '탑 바닥의 유색 1층 제거',
    'desc.excavator2':    '탑 바닥의 유색 2층 제거',
    'desc.excavator3':    '탑 바닥의 유색 3층 제거',
    'desc.excavatorTop1': '탑 꼭대기의 유색 1층 제거',
    'desc.excavatorTop2': '탑 꼭대기의 유색 2층 제거',
    'desc.excavatorTop3': '탑 꼭대기의 유색 3층 제거',
    'desc.shapeshifter':  '다음 블록 모양 선택',
    'desc.rewind':        '보드를 3수 전으로 되돌리기',
    'desc.meteor1':       '1×1 블록 5개가 초고속 낙하',
    'desc.meteor2':       '1×1 블록 10개가 초고속 낙하',
    'desc.meteor3':       '1×1 블록 15개가 초고속 낙하',
    'desc.rocket1':       '사용 시 8개 블록이 하늘에서 떨어져 탑 꼭대기 블록을 제거',
    'desc.rocket2':       '사용 시 16개 블록이 하늘에서 떨어져 탑 꼭대기 블록을 제거',
    'desc.rocket3':       '사용 시 24개 블록이 하늘에서 떨어져 탑 꼭대기 블록을 제거',
    'desc.gatling1':      '사용 시 4개 블록이 빠르게 떨어져 아래 블록을 하나씩 격파',
    'desc.gatling2':      '사용 시 8개 블록이 빠르게 떨어져 아래 블록을 하나씩 격파',
    'desc.gatling3':      '사용 시 12개 블록이 빠르게 떨어져 아래 블록을 하나씩 격파',
    'desc.mortar5':       '사용 시 5개 블록이 위에서 떨어져 빈 공간을 채움',
    'desc.mortar10':      '사용 시 10개 블록이 위에서 떨어져 빈 공간을 채움',
    'desc.mortar15':      '사용 시 15개 블록이 위에서 떨어져 빈 공간을 채움',

    // ---------- 배낭 아이템 (3종) ----------
    'item.mini_block':    '미니 블록',
    'item.bomb_block':    '폭탄 블록',
    'item.rename_card':   '개명 카드',
    'desc.mini_block':    '사용 후, 다음 블록이 1×1 소형 블록으로 변합니다',
    'desc.bomb_block':    '사용 후, 다음 블록이 폭탄으로 변합니다. 착지 시 폭탄을 중심으로 3×3 범위의 블록이 제거됩니다',
    'desc.rename_card':   '카드 1장을 소비하여 닉네임을 1회 변경할 수 있습니다. 카드가 없으면 개명 불가.',

    // ---------- 배낭 UI ----------
    'backpack.use':          '사용',
    'backpack.using':        '사용 중...',
    'backpack.useDisabled':  '사용 불가',
    'backpack.useIngameOnly':'게임 중에만 사용 가능',

    // ---------- Shapeshifter modal ----------
    'shapeshifter.title':    '🎲 변형',
    'shapeshifter.subtitle': '현재 블록을 바꿀 모양을 선택',
    'shapeshifter.cancel':   '취소',

    // ---------- Collect mode ----------
    'collect.header':        '수집 목표',

    // ---------- Blind mode ----------
    'blind.fail.prompt':     '아쉽지만 실패했습니다. 화면을 탭하여 계속',
    'blind.showTower':       '🙉 탑 표시',
    'blind.hideTower':       '🙈 탑 숨기기',

    // ---------- Endless milestone (매 12층) ----------
    'endless.milestone':     '{n}층 달성!',

    // ---------- Fate piece modal ----------
    'fate.modalTitle':   '운명의 블록',
    'fate.reroll':       '운명을 바꿔라 ({n}/3)',
    'fate.reroll.ad':    '🎬 광고 보고 운명 바꾸기',
    'fate.start':        '시작',
    'fate.cellCount':    '{n}칸',
    'fate.endlessSub':   '무한 모드',
    'fate.endlessMid':   '무한 모드 · {layer}층',
    'fate.subtitle':     '{tag} · {n}칸',
    'fate.hint':         '운명을 바꿔라: 광고를 보고 새 운명 블록으로 교체',
    'fate.embedPick.hint': '오프닝 아이템을 선택하세요',

    // ---------- Level select ----------
    'level.name':        '스테이지 {n}',
    // 排行榜关卡模式专用（塔层数格式）—— 与 level.name 分开，避免影响其它 UI
    'level.floorName':   '스테이지 {n}층',
    'level.clearTime':   '클리어 시간: {time}',
    'level.congrats':    '스테이지 클리어!',
    'level.enter':       '스테이지 진입',

    // ---------- Tutorial ----------
    'tutorial.hint.tap':          '화면을 탭하여 블록 모양 변경',
    'tutorial.hint.swipeRelease': '손가락을 드래그해 타워를 한 칸씩 회전',
    'tutorial.hint.swipeHold':    '빠르게 스와이프 후 놓으면 관성으로 회전',
    'tutorial.hint.swipeDown':    '아래로 스와이프하면 즉시 낙하',
    'tutorial.skip':              '건너뛰기',

    // ---------- Login screen ----------
    'login.title':          'Tetri Tower에 오신 것을 환영합니다',
    'login.subtitle':       '시작할 방법을 선택하세요',
    'login.namePlaceholder':'닉네임 입력 (선택)',
    'login.guestButton':    '게스트로 계속',
    'login.emailButton':    '이메일 로그인',
    'login.googleButton':   'Google 로그인',
    'login.appleButton':    'Apple 로그인',
    'login.comingSoon':     '(준비 중)',
    'login.orDivider':      '또는',

    // ---------- Top-up ----------
    'menu.topup':           '충전',
    'topup.title':          '보석 충전',
    'topup.balance':        '{n}',
    'topup.gems':           '{n} 보석',
    'topup.price':          '{price}',
    'topup.buyButton':      '구매',
    'topup.close':          '닫기',
    'topup.successTitle':   '구매 완료',
    'topup.successBody':    '{n} 보석 획득',
    'topup.failTitle':      '구매 실패',
    'topup.failBody':       '{reason}',
    'topup.processing':     '처리 중...',
    'topup.mockNotice':     '(테스트 모드 — 실제 결제 없음)',

    // ---------- Leaderboard ----------
    'leaderboard.title':       '순위표',
    'leaderboard.back':        '↩ 뒤로',
    'leaderboard.tab.level':   '스테이지',
    'leaderboard.tab.endless': '무한 모드',
    'leaderboard.tab.blind':   '블라인드 모드',
    'leaderboard.scope.lang':  '언어별',
    'leaderboard.scope.global':'글로벌',
    'leaderboard.you':         '나',
    'leaderboard.empty':       '데이터 없음',
    'leaderboard.mockName':    '플레이어 {n}',

    // ---------- Pause overlay ----------
    'pause.title':       '⏸ 일시정지',
    'pause.hint':        '탭하여 게임으로 돌아가기',
    'pause.continue':    '▶ 계속',
    'pause.home':        '■ 홈',

    // ---------- DEV buttons ----------
    'debug.forceWin':    '강제 클리어',

    // ---------- Result modals ----------
    'result.gameOver':   '게임 오버',
    'result.levelFail':  '스테이지 실패',
    'result.fail.hole':  '되돌릴 수 없는 빈칸이 생겼습니다',
    'result.fail.tall':  '탑이 너무 높습니다',
    'result.win':        '클리어 ✓',
    'result.retry':      '다시 시도',
    'result.endlessRetry': '다시 하기',
    'result.replay':     '다시 플레이',
    'result.levelSelect':'스테이지',
    'result.home':       '홈',
    'result.reviveAd':   '🎬 광고 보고 부활',
    'result.reviveAd.failed': '광고를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요',
    'result.reviveTitle':        '부활?',
    'result.reviveCountdown':    '{n}초 후 사라져요',
    'result.reviveGems':         '💎 {n} 부활',
    'result.reviveGems.failed':  '부활 실패, 잠시 후 다시 시도',
    'result.reviveGems.notEnough':'젬이 부족해요 — 충전해 주세요',

    // ---------- Language toggle ----------
    // Shows the CURRENT language ("you are here") — click to cycle.
    'lang.toggle':       '한국어',

    // ---------- Settings panel ----------
    'settings.button':       '⚙ 설정',
    'settings.title':        '설정',
    'settings.lang':         '언어',
    'settings.gesture':      '제스처',
    'settings.gesture.both': '플릭 + 드래그',
    'settings.gesture.drag': '드래그만',
    'settings.keys':         '가상 버튼',
    'settings.keys.on':      '켜기',
    'settings.keys.off':     '끄기',
    'settings.bgm':          '배경음악',
    'settings.sfx':          '효과음',
    'settings.haptic':       '진동',
    'settings.hideDev':      'DEV 버튼 숨기기',
    'badges.earned':        '획득 배지 {n}개',
    'badges.claim':         '받기 +1💎',
    'badges.claimed':       '받음',
    'settings.controls':       '조작 방식',
    'controls.title':          '조작 방식 선택',
    'controls.legacy':         '클래식 (스와이프 + 길게 누르기)',
    'controls.dragFling':      '드래그 + 플릭',
    'controls.buttons':        '버튼 모드',
    'controls.close':          '닫기',
    'controls.classic':      '클래식',
    'controls.advanced':     '고급',
    'controls.expert':       '전문가',
    'settings.nickname':     '닉네임',
    'settings.volume':       '볼륨',
    'settings.accountData':  '계정 관리',
    'settings.googleAccount': 'Google 계정',
    'settings.appleAccount': 'Apple 계정',
    'settings.notBound':     '미연동',
    'settings.close':        '닫기',
    'audio.off':             '끄기',
    'audio.percent':         '{n}%',
    'settings.account.guest':  '게스트',
    'settings.account.google': '구글',
    'settings.account.apple':  '애플',
    'settings.account.email':  '이메일',
    'settings.account.copied':      '클립보드에 복사됨',
    'settings.account.copyFailed':  '복사 실패',
    'settings.nickname.tooLong':     '닉네임은 최대 {n}자입니다',
    'settings.nickname.profanity':   '닉네임에 금지어가 포함되어 있습니다',
    'settings.nickname.reserved':    '예약된 닉네임입니다',
    'settings.nickname.tooShort':    '닉네임이 너무 짧습니다',
    'settings.nickname.tooLongServer':'닉네임이 너무 깁니다',
    'settings.nickname.rejected':    '유효하지 않은 닉네임입니다',
    'settings.nickname.noCard':      '닉네임 변경에는 개명 카드 1장이 필요합니다 — 배낭에서 획득하세요',
    'settings.nickname.cooldown':    '다음 변경까지 {n}일 남음',
    'settings.nickname.renameCards': '이름 변경권: {n}장',
    'settings.nickname.cooldownReady':'지금 변경 가능 (다음엔 7일 대기)',
    'settings.nickname.title':       '닉네임 변경',
    'settings.nickname.placeholder': '새 닉네임 입력',

    // ---------- Common modal buttons ----------
    'common.confirm':    '확인',
    'common.cancel':     '취소',

    // ---------- 회원 탈퇴 (App Store 5.1.1(v) 필수) ----------
    'settings.deleteAccount':         '회원 탈퇴',
    'settings.deleteAccount.title':   '회원 탈퇴하시겠습니까?',
    'settings.deleteAccount.desc':    '이 작업은 취소할 수 없습니다. 모든 데이터(보석, 진행 상황, 연결 계정)가 영구 삭제되며 게임이 종료됩니다.',
    'settings.deleteAccount.confirm': '탈퇴하려면 다시 탭하세요',
    'settings.bound':                 '연결됨',
    'settings.unbound':               '연결 안 됨',
    // ---- 신규 유저 14일 이벤트 ----
    'event.newbie14.title':           '신규 유저 14일 혜택',
    'event.newbie14.subtitle':        '매일 접속하고 보석을 받으세요',
    'event.newbie14.claim':           '{gems} 보석 받기',
    'event.newbie14.claiming':        '받는 중…',
    'event.newbie14.claimed':         '오늘 수령 완료',
    'event.newbie14.alreadyClaimed':  '오늘은 이미 받으셨습니다',
    'event.newbie14.grantedToast':    '{gems} 💎 획득',
    'event.newbie14.ended':           '이벤트 종료',
    'event.newbie14.daysLeft':        '이벤트 {days}일 남음',
    'event.newbie14.loading':         '불러오는 중…',
    'event.newbie14.error':           '수령 실패, 다시 시도해 주세요',
    // ---- 게임 종료 확인 ----
    'exit.title':                     '게임 종료',
    'exit.desc':                      '게임을 종료하시겠습니까?',
    'exit.confirm':                   '종료',
    'exit.cancel':                    '취소',
    'settings.google.pending':        'Google 로그인을 여는 중…',
    'settings.google.linked':         'Google 계정이 연결되었습니다',
    'settings.google.alreadyLinked':  '이미 Google 계정에 연결됨',
    'settings.google.unsupported':    '이 기기에서는 Google 로그인을 지원하지 않습니다',
    'settings.google.error':          'Google 로그인 실패, 다시 시도해 주세요',
    'settings.google.recover.title':  '이 Google 계정은 다른 계정에 연결되어 있습니다',
    'settings.google.recover.desc':   '이 Google 계정은 이미 다른 게임 계정에 연결되어 있습니다. 복구하면 현재 게스트 계정이 폐기됩니다. 계속하시겠습니까?',
    'settings.google.recovered':      'Google 연결 계정을 복구했습니다',
    'settings.deleteAccount.pending': '탈퇴 처리 중...',
    'settings.deleteAccount.failed':  '탈퇴 실패, 다시 시도',
    'settings.tos':     '이용약관',
    'settings.privacy': '개인정보 처리방침',
    // NOTE: duplicate 'settings.deleteAccount' keys used to live here —
    // ko.ts had a legacy block that redefined the button label as
    // '계정 삭제', which SILENTLY OVERWROTE the '회원 탈퇴' block above
    // (JS object-literal semantics: last key wins). The confirm string
    // is now defined once above; do not re-add duplicates here.
    // 다이아 부족 팝업
    'gems.insufficient': '다이아가 부족합니다\n필요 {need}, 보유 {have}',
    'gems.goTopUp':      '충전하러 가기',
    'gems.cancel':       '취소',

    // ---------- Consent modal (login-gate) ----------
    'consent.title':                             '게임을 시작하려면 이용약관 및 개인정보처리방침에 동의해야 합니다!',
    'consent.agreeAll':                             '전체 동의합니다',
    'consent.tos.label':                             '이용약관 동의',
    'consent.privacy.label':                             '개인정보처리방침 동의',
    'consent.age.label':                             '만 14세 이상입니다',
    'consent.marketing.label':                             '마케팅 정보 수신 동의',
    'consent.required':                             '필수',
    'consent.optional':                             '선택',
    'consent.view':                             '보기',
    'consent.start':                             '동의하고 시작하기',
    'consent.mustAgree':                             '필수 항목에 모두 동의해야 게임을 시작할 수 있습니다.',
    'consent.error':                             '동의 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',

    // ---------- Account recovery popup ----------
    'settings.appleRecovery.confirm':                                       '이 Apple 계정은 다른 계정과 연결됨. 다시 탭하여 복구',
    'settings.appleRecovery.title':                                       '계정을 복구할까요?',
    'settings.appleRecovery.desc':                                       '이 Apple ID는 이미 다른 게임 계정에 연결되어 있습니다. 확인 시 해당 계정으로 전환되며, 현재 게스트 계정의 데이터(다이아몬드, 진행도)는 유지되지 않습니다.',
    'settings.appleRecovery.pending':                                       '복구 중...',
    'settings.appleRecovery.failed':                                       '복구 실패, 다시 시도',
    'settings.appleRecovery.success':                                       '계정 복구 완료',
    'settings.googleRecovery.title':                                       '계정을 복구할까요?',
    'settings.googleRecovery.desc':                                       '이 Google 계정은 이미 다른 게임 계정에 연결되어 있습니다. 확인 시 해당 계정으로 전환되며, 현재 게스트 계정의 데이터(다이아몬드, 진행도)는 유지되지 않습니다.',
    'settings.googleRecovery.pending':                                       '복구 중...',
    'settings.googleRecovery.failed':                                       '복구 실패, 다시 시도',
    'settings.googleRecovery.success':                                       '계정 복구 완료',
    // ---- Progressive unlock tips ----
    'lock.endless':      '{n}층에 도달하면 무한 모드 해금',
    'lock.blind':        '무한 모드에서 {n}층 달성 시 블라인드 모드 해금',
    'lock.leaderboard':  '무한 모드에서 {n}층 달성 시 랭킹 해금',
    'level.next':        '다음 스테이지',
    'level.floor':       '{n}층',
};
