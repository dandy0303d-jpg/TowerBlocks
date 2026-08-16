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
    'menu.levelSelect':  '스테이지 선택',
    'menu.back':         '← 뒤로',

    // ---------- Boot loading screen ----------
    'loading.text':      '로딩 중',

    // ---------- HUD ----------
    'hud.back':          '← 홈',
    'hud.height':        '높이',
    'hud.heightValue':   '높이  {n}',
    'hud.next':          'NEXT',

    // ---------- Picker ----------
    'picker.title':      '⚡ 마법 아이템을 1개 선택',
    'picker.hint':       '카드를 탭하여 확인 · 색상 = 등급',
    'picker.refresh':    '🔄 무료 리롤',
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
    'desc.rocket1':       '로켓 8발이 탑 꼭대기를 관통',
    'desc.rocket2':       '로켓 16발이 탑 꼭대기를 관통',
    'desc.rocket3':       '로켓 24발이 탑 꼭대기를 관통',
    'desc.gatling1':      '탄환 4발이 화면 중앙에서 발사',
    'desc.gatling2':      '탄환 8발이 화면 중앙에서 발사',
    'desc.gatling3':      '탄환 12발이 화면 중앙에서 발사',
    'desc.mortar5':       '색 반죽 5방울이 빈 공간을 채움',
    'desc.mortar10':      '색 반죽 10방울이 빈 공간을 채움',
    'desc.mortar15':      '색 반죽 15방울이 빈 공간을 채움',

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
    'fate.reroll':       '운명을 바꿔라',
    'fate.start':        '시작',
    'fate.cellCount':    '{n}칸',
    'fate.endlessSub':   '무한 모드',
    'fate.levelSub':     '스테이지 {n}',
    'fate.endlessMid':   '무한 모드 · {layer}층',
    'fate.subtitle':     '{tag} · {n}칸',
    'fate.hint':         '운명을 바꿔라: 광고를 보고 새 운명 블록으로 교체',

    // ---------- Level select ----------
    'level.name':        '스테이지 {n}',
    'level.enter':       '스테이지 진입',

    // ---------- Tutorial ----------
    'tutorial.hint.tap':          '화면을 탭하여 블록 모양 변경',
    'tutorial.hint.swipeRelease': '가로로 스와이프하고 놓으면 한 칸 회전',
    'tutorial.hint.swipeHold':    '가로로 스와이프한 채 유지하면 연속 회전',
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
    'topup.balance':        '보석: {n}',
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
    'leaderboard.you':         '나',
    'leaderboard.empty':       '데이터 없음',
    'leaderboard.mockName':    '플레이어 {n}',

    // ---------- Pause overlay ----------
    'pause.title':       '⏸ 일시정지',
    'pause.hint':        '탭하여 게임으로 돌아가기',
    'pause.continue':    '▶ 계속',
    'pause.home':        '< 홈',

    // ---------- DEV buttons ----------
    'debug.forceWin':    '강제 클리어',

    // ---------- Result modals ----------
    'result.gameOver':   '게임 오버',
    'result.levelFail':  '스테이지 실패',
    'result.fail.hole':  '구멍이 막혔습니다',
    'result.fail.tall':  '탑이 너무 높습니다',
    'result.win':        '클리어 ✓',
    'result.retry':      '다시 시도',
    'result.endlessRetry': '다시 하기',
    'result.nextLevel':  '다음 스테이지',
    'result.replay':     '다시 플레이',
    'result.levelSelect':'스테이지',
    'result.home':       '홈',

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
    'settings.nickname.title':       '닉네임 변경',
    'settings.nickname.placeholder': '새 닉네임 입력',

    // ---------- Common modal buttons ----------
    'common.confirm':    '확인',
    'common.cancel':     '취소',

    // ---------- 계정 삭제 (App Store 5.1.1(v) 필수) ----------
    'settings.deleteAccount':         '계정 삭제',
    'settings.deleteAccount.title':   '계정을 삭제하시겠습니까?',
    'settings.deleteAccount.desc':    '이 작업은 취소할 수 없습니다. 모든 데이터(보석, 진행 상황, 연결 계정)가 영구 삭제됩니다.',
    'settings.deleteAccount.pending': '삭제 중...',
    'settings.deleteAccount.failed':  '삭제 실패, 다시 시도',
    'settings.tos':     '이용약관',
    'settings.privacy': '개인정보 처리방침',
    // 다이아 부족 팝업
    'gems.insufficient': '다이아가 부족합니다\n필요 {need}, 보유 {have}',
    'gems.goTopUp':      '충전하러 가기',
    'gems.cancel':       '취소',
};
