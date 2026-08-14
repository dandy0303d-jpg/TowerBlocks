# App Store Connect IAP 配置指南

一次性完成的配置。做完之后就可以在 TestFlight 沙盒里跑真实购买流程。

前置条件（都要 ✅ 才能走 IAP）：
- ✅ Apple Developer 账号已激活（付费 $99/年，个人或公司）
- ✅ Paid Apps Agreement 已签署并生效（Agreements, Tax, and Banking）
- ✅ W-8BEN 税务表已提交（非美国居民必填）
- ✅ Banking Information 已提交
- ✅ App 记录已在 App Store Connect 创建（Bundle ID `com.konenine.tetritower`）
- ✅ 服务端 apple-verify 已部署（`../tetritower-backend/`，见
  `outputs/tetritower-server-iap-patch/README.md`）

---

## 1. 建 6 个 In-App Purchase 商品

进入 App Store Connect → 我的 App → **TetriTower** → 左侧 **App 内购买项目** → **+ 号**。

对下面 6 个 SKU 各建一次：

| Product ID（**必须完全一致**）| 类型            | 参考价（USD Tier）| 中文名          | 英文名           |
|-------------------------------|-----------------|-------------------|-----------------|------------------|
| `gems_60`                     | 消耗型 Consumable | Tier 1  ($0.99)  | 60 宝石         | 60 Gems          |
| `gems_300`                    | 消耗型 Consumable | Tier 5  ($4.99)  | 300 宝石        | 300 Gems         |
| `gems_700`                    | 消耗型 Consumable | Tier 10 ($9.99)  | 700 宝石        | 700 Gems         |
| `gems_1500`                   | 消耗型 Consumable | Tier 20 ($19.99) | 1500 宝石       | 1500 Gems        |
| `gems_4000`                   | 消耗型 Consumable | Tier 50 ($49.99) | 4000 宝石       | 4000 Gems        |
| `gems_10000`                  | 消耗型 Consumable | Tier 100 ($99.99)| 10000 宝石      | 10000 Gems       |

**Product ID 要与 WALLET_SKUS[].id 完全一致**（大小写敏感）——服务端 apple-verify 会
cross-check `verified.productId === body.sku`，对不上直接拒绝。

### 每个商品的必填字段

- **参考名称**（Reference Name）：只在后台看，随便写，比如 `Gems 60 Pack`
- **产品 ID**：见上表
- **价格**：选对应 Tier
- **本地化**（至少填 English + 简体中文；日 / 韩 / 繁中也建议补上）：
  - 显示名称：见上表"中文名" / "英文名"
  - 描述：`适用于购买消耗型宝石。` / `Consumable gems for in-game purchases.`
  - 大图标（1024×1024 JPG/PNG）：可以先用 App 图标临时代替
- **审核信息**：
  - 屏幕截图：截一张 App 内购买面板的图（能看到"60 宝石"之类的即可）
  - 审核备注：`Player earns gems that unlock game content. All purchases consumable.`

**每个 IAP 都要单独提交审核**——首次会跟 App 主包一起审。之后加 SKU 单独审。

---

## 2. 建沙盒测试账号

**沙盒账号 ≠ 真实 Apple ID**，是专门用来测 IAP 的假账号，不会真扣钱。

App Store Connect → 用户和访问 → **沙盒** → 测试人员 → **+ 号**：

- 名字 / 姓氏：随便，比如 `Test User`
- 电子邮件：**必须是你没用过的 Apple ID 邮箱**——可以用 Gmail 的 `+` 别名，比如
  `yourname+sbx1@gmail.com`（Gmail 会自动路由到 `yourname@gmail.com`）
- 密码：设一个记得住的
- 国家 / 地区：**建议选"美国"**（Tier 价格显示 USD，最直观）
- 出生日期：随便，成年就行

创建完成后，账号立即可用。

**⚠️ 沙盒账号使用注意**：
- 千万**别在 iPhone 的"设置 → App Store"里登录沙盒账号**——那会把你真实的 Apple ID 顶掉
- 正确姿势：**在 App 里点购买按钮时**，弹出"登录 App Store"对话框，那时候才输入沙盒账号
- iOS 15+ 还多了一个专门的入口：**设置 → App Store → 沙盒账户**（往下拉找到），在这里登录只用于沙盒 IAP，不影响真实账号

---

## 3. 在 Xcode 里 Run 到你的 iPad

前置：
- 服务端已部署（`docker compose logs -f server` 有 `Server listening` 输出）
- App Store Connect 里 6 个 IAP 都建好了（状态可以是 "准备提交" 或 "元数据缺失" 都 OK，沙盒不看审核状态）
- 沙盒账号已建好

Xcode 里：
1. 顶部设备选你的 iPad（真机）
2. **⌘R** Run
3. iPad 上进游戏 → 打开充值面板

## 4. 触发一次沙盒购买

游戏里点任一充值按钮（比如 `60 宝石 $0.99`）：

1. iOS 弹出系统购买 sheet
2. 弹出"登录到 App Store" → **输入沙盒账号邮箱 + 密码**
3. 点 **购买 → 使用 Face ID / 输入密码确认**
4. **注意**：沙盒环境会弹一个说明"这是沙盒环境，不会真扣款"，Confirm

购买完成后，客户端会：
- 收到 JWS 收据 → 发给你服务端 `POST /player/wallet/topup`
- 服务端 verifyAppleTransaction → 通过 → 加宝石到玩家钱包
- 客户端调 consume → 让 iOS 知道可以再次购买同一 SKU

**验证成功的标志**：
- 玩家宝石数增加了（面板顶部 "宝石: X" 变化）
- 服务端 log 里能看到 `Apple receipt verified` + `productId=gems_60`
- 没有 "sku mismatch" 或 "invalid-signature" 报错

---

## 5. 常见坑

### "无法连接到 iTunes Store"
- 检查 iPad **已联网**（沙盒也需要真实网络到苹果的沙盒服务器）
- 沙盒有时候慢，多试几次
- 确认 App 的 Bundle ID **与 App Store Connect 里的完全一致**

### "此商品不可用" / "Cannot connect to iTunes Store"
- Product ID 拼写检查（大小写、下划线）
- IAP 状态在 ASC 里必须是"准备提交"以上（不能是"缺少元数据"）
- **等**——刚建的 IAP 需要 15-60 分钟才能被 StoreKit 拉到
- 沙盒账号国家和 IAP 上架地区要匹配

### 客户端 `console.log` 看到 `[StoreKit] fetchProducts failed` 或返回空
- Bundle ID 不匹配
- 沙盒账号还没登录（iOS 15+ 在 设置 → App Store → 沙盒账户 里登录）
- 网络代理干扰（试试关 VPN / 直连 Wi-Fi）

### 服务端返回 `apple receipt: wrong-bundle-id`
- 服务端 `IOS_BUNDLE_ID` 环境变量没配对（应该是 `com.konenine.tetritower`）
- 服务端重启：`docker compose restart server`

### 服务端返回 `apple receipt: invalid-signature`
- Apple 根证书没下载全（应该在 `server/certs/apple/` 有 4 个 `.cer` 文件）
- 或者服务端时间偏差太大（JWS 签名验证对时间敏感）

### 玩家扣了钱但没到账
- **不要慌**——服务端如果验证成功但网络中断，客户端不会 consume，iOS 下次启动会重新 deliver 这个 transaction，走 pendingTx 流程自动补款
- 检查 iOS 端 `console.log('[StoreKit] pending transaction received')`
- 服务端 wallet_topups 表看有没有对应 transactionId 的行

### `Ask to Buy`（家庭共享儿童购买请求）
- 沙盒下也可能触发（如果沙盒账号年龄设成儿童）
- 走 pending 流程，家长审批后 transaction 自动 deliver
- 客户端已有 pendingTx handler 兜底

---

## 6. TestFlight 内测（可选，沙盒之上一层）

沙盒是 debug build 里用的。TestFlight 用**真 Release build**上传后，Beta 用户装的 App 走
的是**TestFlight 特殊环境**——StoreKit 会把它识别为 sandbox（不真扣钱），但走的路径跟生产
更接近。

流程：
1. Xcode → Product → Archive
2. Organizer → Distribute App → App Store Connect → Upload
3. ASC → TestFlight → 内部测试 → 加测试人员（用 Apple ID 邮箱邀请）
4. 测试人员装 TestFlight app → 接受邀请 → 装你的 App
5. 打开 App → 走 IAP → 自动是 sandbox（不用切沙盒账号）

TestFlight 沙盒是**Apple 认证的推荐测试环境**——过了这一关基本能过生产。

---

## 7. 从沙盒到生产

沙盒测通后：
1. 在 ASC 里把每个 IAP **提交审核**（跟 App 主包一起，或单独）
2. 苹果审核 IAP 通常 24-48 小时
3. 审核通过 = 商品状态变成 "准备发布" (Ready to Submit)
4. 主 App 上架后，商品自动跟着 available
5. 生产用户的付款会真扣钱，服务端会收到 `environment: "Production"` 的收据

**不用改客户端或服务端任何代码**——同一份 build 沙盒和生产都跑，环境切换由 iOS 和 apple-verify
自动处理。
