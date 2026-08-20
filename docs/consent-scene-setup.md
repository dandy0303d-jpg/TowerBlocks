# Consent Modal — Scene Setup Guide

## 概要

韩国常见 3 段式同意页（年龄 gate 由 App Store 评级处理，不再另设复选框）：
1. 이용약관 (필수)
2. 개인정보처리방침 (필수)
3. 마케팅 정보 수신 (선택)

顶部有一个「전체 동의」主 Toggle 联动所有子项。底部「동의하고 시작하기」按钮只有所有必选项都勾才 enable。

## 触发时机

`LoadingController.finish()` → `MenuController.beginBootAfterLoading()` 内：
1. 先 `ensureRegistered`（拿到 bearer）
2. 调 `GET /player/consent/status`
3. `needsConsent=true` → 弹出 ConsentModal，await 直到 `POST /player/consent` 成功
4. 继续教程 / 主菜单

## Cocos 场景搭建

在 `Game.scene` 里找到 MenuController 挂着的那个 Canvas，添加：

```
Canvas
└── ConsentModalRoot                   ← Node, active=false, Widget 全屏
    │                                    Component: ConsentModal (assets/scripts/main/ConsentModal.ts)
    │
    ├── Dim                             ← Sprite (纯黑 alpha=0.7)
    │                                    BlockInputEvents 拦截透传
    │                                    Widget 全屏
    │
    └── Card                            ← Node, 600x820 居中
        ├── TitleLabel                  ← Label
        ├── AgreeAllRow
        │   ├── AgreeAllToggle          ← Toggle
        │   └── AgreeAllLabel           ← Label
        ├── DividerLine (装饰)
        ├── TosRow
        │   ├── TosToggle               ← Toggle
        │   ├── TosLabel                ← Label
        │   └── TosViewBtn              ← Button (含子 Label 「보기」)
        ├── PrivacyRow
        │   ├── PrivacyToggle
        │   ├── PrivacyLabel
        │   └── PrivacyViewBtn
        ├── AgeRow
        │   ├── AgeToggle
        │   └── AgeLabel
        ├── MarketingRow
        │   ├── MarketingToggle
        │   └── MarketingLabel
        ├── HintLabel                   ← Label, 默认 active=false, 红色/警告色
        └── StartButton                 ← Button (含子 Label)
```

## 组件属性绑定

选中 `ConsentModalRoot`，在 Inspector 里绑定 ConsentModal 组件的 @property：

| 属性              | 拖入节点                              |
|-------------------|---------------------------------------|
| root              | ConsentModalRoot 自己                 |
| titleLabel        | Card/TitleLabel                       |
| agreeAllToggle    | Card/AgreeAllRow/AgreeAllToggle       |
| agreeAllLabel     | Card/AgreeAllRow/AgreeAllLabel        |
| tosToggle         | Card/TosRow/TosToggle                 |
| tosLabel          | Card/TosRow/TosLabel                  |
| tosViewBtn        | Card/TosRow/TosViewBtn                |
| privacyToggle     | Card/PrivacyRow/PrivacyToggle         |
| privacyLabel      | Card/PrivacyRow/PrivacyLabel          |
| privacyViewBtn    | Card/PrivacyRow/PrivacyViewBtn        |
| ageToggle         | Card/AgeRow/AgeToggle                 |
| ageLabel          | Card/AgeRow/AgeLabel                  |
| marketingToggle   | Card/MarketingRow/MarketingToggle     |
| marketingLabel    | Card/MarketingRow/MarketingLabel      |
| hintLabel         | Card/HintLabel                        |
| startBtn          | Card/StartButton                      |

## MenuController 关联

MenuController 组件上新增了 `consentModalNode: Node | null`。在 Inspector 把 `ConsentModalRoot` 拖到这个 slot 上。留空的话 gate 会被跳过（首次接入建议留空 → 后端也不返回 needsConsent → 平滑上线）。

## 「查看」按钮行为

点击 → `sys.openURL(BACKEND_BASE_URL + '/legal/' + kind + '/' + lang)` → iOS 用 Safari 打开对应语言的 HTML 全文。语言从 Cocos `sys.language` 映射（10 种）。

## 视觉规范

- 参考韩国主流游戏（쿠키런 킹덤 / 리니지 / 라스트오리진）的同意页
- 主 Toggle 与子 Toggle 用不同尺寸区分（主大一号）
- 「(필수)」用主色/深色，「(선택)」用灰色
- 「보기」按钮小尺寸，图标 + 文字
- Start 按钮 disabled 时 opacity=100, enabled 时 opacity=255（Cocos Button.disabledOpacity）

## i18n 键（已加进 10 语言）

```
consent.title                '서비스 이용에 동의해주세요' / 'Please Agree to Continue' / ...
consent.agreeAll             '전체 동의합니다' / 'I agree to all' / ...
consent.tos.label            '이용약관 동의' / 'Terms of Service' / ...
consent.privacy.label        '개인정보처리방침 동의' / 'Privacy Policy' / ...
consent.age.label            '만 14세 이상입니다' / 'I am 14 or older' / ...
consent.marketing.label      '마케팅 정보 수신 동의' / 'Receive marketing communications' / ...
consent.required             '필수' / 'Required' / ...
consent.optional             '선택' / 'Optional' / ...
consent.view                 '보기' / 'View' / ...
consent.start                '동의하고 시작하기' / 'Agree & Start' / ...
consent.mustAgree            '필수 항목에 모두 동의해야 게임을 시작할 수 있습니다.' / ...
consent.error                '동의 처리 중 오류가 발생했습니다...' / ...
```

组件里 label 会自动加 ` (필수)` 或 ` (선택)` 后缀，所以 label key 不用重复写「필수」。

## 服务端要求

`GET /player/consent/status` 和 `POST /player/consent` 已上线在服务端（`consent.ts`）。当前版本号：

- `CURRENT_TOS_VERSION`     = `2026-08-21`
- `CURRENT_PRIVACY_VERSION` = `2026-08-21`

将来更新 privacy/tos 内容后：
1. 服务端 `.env` 里改这两个值
2. `docker compose up -d server`
3. 所有玩家下次启动 → 同意页再次弹出（因为 `agreed.tos !== current.tos`）

## 测试步骤

1. 部署服务端 `tetritower-consent-v1.tar.gz`（DEPLOY.md）
2. Cocos: refresh assets → 场景搭出 ConsentModalRoot 节点树 → 拖 @property
3. Build iOS → Xcode Run
4. 首次启动：期望 loading 后弹出同意页
5. 都不勾 → 点 Start → 显示 hintLabel 「必须同意...」
6. 勾必选 3 项 → Start enable → 点击 → 弹窗消失 → 进主菜单
7. VPS 查数据库：
   ```
   docker compose exec postgres psql -U tetritower -d tetritower -c \
     "SELECT uuid, tos_version, privacy_version, age_confirmed, marketing_opt_in, agreed_at FROM player_consents ORDER BY agreed_at DESC LIMIT 5;"
   ```
   应该看到刚才那个 uuid 的记录
8. 关掉 App 重开 → 同意页**不再弹出**（版本一致）
9. 服务端 `.env` 把 `CURRENT_TOS_VERSION` 改成 `2026-08-22` → 重启 server → 手机重开 App → 同意页**再次弹出**
