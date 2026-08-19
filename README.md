# 姊妹飲控 LINE Bot｜MVP 實作包

五人共用的 LINE 飲控打卡工具：每天 22:00 私訊尚未打卡者；使用者從 LINE 打開手機選餐頁，用食物圖卡選擇份量；紀錄寫入 Google Sheet；群組輸入「今日排行」時立即回覆估算赤字。

## 這一版包含

- LINE 好友／成員綁定
- Google Sheet 自動建立四張工作表
- 手機版食物圖卡選擇頁
- 早餐、午餐、晚餐、點心分類紀錄
- 基礎代謝、飲水量、運動與活動熱量
- 同一人同一天重送時更新原紀錄
- 群組指令：`今日排行`、`打卡`、`綁定`、`說明`
- 每 5 分鐘檢查一次，台北時間 22:00 私訊尚未完成者
- Cloudflare Worker 驗證 LINE `x-line-signature`

> 注意：內建食物是「流程測試用估算值」。正式使用前，請依你們的常用碗、品牌營養標示與食藥署資料校正。所有熱量與赤字皆為估算。

## 架構

1. LINE 把 webhook 傳給 Cloudflare Worker。
2. Worker 使用 Channel secret 驗證 LINE 簽章。
3. 驗證成功後，Worker 把原始事件轉送給 Google Apps Script。
4. Apps Script 讀寫 Google Sheet，並呼叫 LINE Reply／Push API。
5. 使用者從 LINE 開啟 Apps Script 手機頁面完成打卡。

Worker 會在驗證簽章後略過群組的一般聊天，只轉送打卡、綁定、排行等指令，避免原本很熱鬧的群組快速耗掉 Apps Script 執行額度。

## 檔案

```text
sisters-calorie-line-bot/
├── apps-script/
│   ├── Code.gs
│   ├── Index.html
│   └── appsscript.json
└── cloudflare-worker/
    ├── src/index.js
    └── wrangler.toml.example
```

---

## 階段一：建立 Google Sheet 與 Apps Script

### 1. 建立試算表

建立一份新的 Google Sheet，命名為：

```text
姊妹飲控打卡資料庫
```

不要把試算表設成「知道連結的任何人都能編輯」。只分享給五位成員，權限先設為「檢視者」。實際寫入由 Apps Script 執行。

### 2. 開啟 Apps Script

在試算表上方選單：

```text
擴充功能 → Apps Script
```

將預設 `Code.gs` 的內容全部刪除，貼入本專案 `apps-script/Code.gs`。

再按左側檔案旁的 `＋`：

```text
HTML → 檔名輸入 Index
```

把 `apps-script/Index.html` 貼入。

`appsscript.json` 可稍後再設定；重點是專案時區必須選 `Asia/Taipei`。

### 3. 執行初始化

在 Apps Script 上方函式選單選擇：

```text
setupProject
```

按「執行」。第一次會要求 Google 授權。確認是你自己的專案後，允許它讀寫這份 Sheet、呼叫外部 API 及建立排程。

成功後，試算表會出現：

- `系統設定`
- `成員設定`
- `食物庫`
- `每日紀錄`

指令碼屬性中也會建立：

- `SPREADSHEET_ID`
- `RELAY_SECRET`
- `FORM_SIGNING_SECRET`

### 4. 加入 LINE access token

到 LINE Developers Console 的 Messaging API Channel，取得 Channel access token。

回到 Apps Script：

```text
左側齒輪「專案設定」→ 指令碼屬性 → 新增指令碼屬性
```

加入：

```text
名稱：LINE_CHANNEL_ACCESS_TOKEN
值：你的 Channel access token
```

不要把 token 放進 Google Sheet、程式碼、GitHub 或傳給其他成員。

### 5. 部署 Apps Script Web App

點右上角：

```text
部署 → 新增部署作業 → 類型選「網頁應用程式」
```

設定：

- 執行身分：我
- 誰可以存取：任何人

部署後會得到以 `/exec` 結尾的網址，先保存，後續稱為：

```text
APPS_SCRIPT_WEBHOOK_URL
```

每次修改 `Code.gs` 或 `Index.html` 後，要到「管理部署作業」建立新版本／更新部署，否則正式網址仍會執行舊程式。

---

## 階段二：部署 Cloudflare Worker

可以用 Cloudflare Dashboard 直接貼程式，不必先安裝 Node.js。

### 1. 建立 Worker

登入 Cloudflare，建立一個 Worker，名稱可用：

```text
sisters-calorie-line-webhook
```

將預設程式換成 `cloudflare-worker/src/index.js`，然後部署。

### 2. 設定 Variables and Secrets

在 Worker 的 Settings／Variables and Secrets 建立：

| 名稱 | 類型 | 值從哪裡取得 |
|---|---|---|
| `LINE_CHANNEL_SECRET` | Secret | LINE Developers → Basic settings → Channel secret |
| `APPS_SCRIPT_RELAY_SECRET` | Secret | Apps Script → 專案設定 → `RELAY_SECRET` |
| `APPS_SCRIPT_WEBHOOK_URL` | Text 或 Secret | Apps Script 部署後的 `/exec` 網址 |

三個值都不要貼在公開程式碼。

### 3. 測試 Worker

在瀏覽器開啟 Worker 網址，應看到：

```json
{"ok":true,"service":"sisters-calorie-line-webhook"}
```

---

## 階段三：連接 LINE Webhook

到 LINE Developers Console：

```text
Messaging API → Webhook URL
```

填入 Cloudflare Worker 網址，而不是 Apps Script 網址。

接著：

1. 按 `Verify`，應顯示 Success。
2. 開啟 `Use webhook`。
3. 開啟 `Allow bot to join group chats`。
4. 到 LINE Official Account Manager 關閉預設「自動回應訊息」，避免重複回覆。

---

## 階段四：五人綁定與群組測試

### 1. 個人綁定

五個人都要：

1. 把官方帳號加好友。
2. 私訊機器人：`綁定`
3. 點「開啟今日打卡」。
4. 第一次填入自己的 BMR。

成功後，`成員設定` 會自動出現 LINE User ID、顯示名稱和是否已加好友。

### 2. 加入原本五人群組

把官方帳號邀請到原本五人群組。同一群組同時間只能有一個 LINE 官方帳號。

群組輸入：

```text
今日排行
```

機器人應立即回覆；這個回覆使用 Reply API，不計入主動推播額度。

### 3. 測試圖卡打卡

私訊或群組輸入：

```text
打卡
```

點按鈕後應看到手機選餐頁。選擇食物、輸入 BMR、飲水與運動後送出，`每日紀錄` 應新增一列。

同一天再次送出時，原有列會被更新，不會重複新增。

---

## 階段五：啟用 22:00 提醒

在 Apps Script 函式選單執行：

```text
installReminderTrigger
```

程式會每 5 分鐘檢查一次：

- 是否為台北時間 22 點
- 今天是否已經提醒
- 哪些人已經完成打卡

只私訊尚未打卡且已加官方帳號好友的人。一天最多每人一則提醒。

如果修改成員或程式，不需要重新建立排程；只有刪除 Apps Script trigger 後才需要再次執行。

---

## 食物圖片與熱量維護

`食物庫` 欄位：

| 欄位 | 用途 |
|---|---|
| `FoodId` | 不重複的英文識別碼；建立後不要任意修改 |
| `分類` | 主食、蛋白質、蔬菜、飲料等 |
| `名稱` | 畫面顯示名稱 |
| `標準份量` | 半碗、1顆、100g 等 |
| `熱量kcal` | 該標準份量的熱量 |
| `Emoji` | 尚未有圖片時的替代圖示 |
| `圖片網址` | 必須是公開可讀的 HTTPS 圖片網址 |
| `啟用` | TRUE 才顯示 |
| `資料來源` | TFDA、包裝標示、店家或自訂估算 |
| `估算等級` | 較高、中、低 |
| `排序` | 數字越小越前面 |

建議先保留 40～60 個最常吃的品項。外食便當、火鍋等差異大的食物，資料來源應清楚標成「估算」。

不建議直接熱連結 Google 搜尋圖片；可能有版權、失效與份量不一致問題。正式圖片可使用自己拍攝、具可用授權的素材，或統一生成的食物圖示。

---

## 計算規則

```text
今日總攝取 = 早餐 + 午餐 + 晚餐 + 點心 + 其他熱量
估算總消耗 = BMR × 1.2 + 活動熱量
估算赤字 = 估算總消耗 - 今日總攝取
```

運動手錶請填「活動熱量」，不要填包含休息代謝的「總消耗」，避免重複計算。

此公式用於五人日常追蹤，不是醫療或精密代謝測量。排行榜應理解為估算及記錄遊戲，不是赤字越大越健康。懷孕或哺乳者不應使用減脂赤字排名。

## 常見問題

### LINE Verify 失敗

- Webhook URL 必須填 Cloudflare Worker URL。
- Worker 三個變數名稱必須完全相同。
- `LINE_CHANNEL_SECRET` 是 Basic settings 的 secret，不是 access token。
- Apps Script 網頁應用程式必須允許「任何人」存取。

### 機器人收到訊息但沒回覆

- 確認 `Use webhook` 已開啟。
- 確認 Apps Script 有 `LINE_CHANNEL_ACCESS_TOKEN`。
- 確認已更新 Apps Script 部署版本。
- 查看 Cloudflare Worker logs 與 Apps Script 執行紀錄。

### 打卡按鈕顯示尚未部署

`ScriptApp.getService().getUrl()` 只有部署成 Web App 後才會有正式網址。完成部署後再傳一次「打卡」。

### 22:00 沒收到提醒

- 五人必須個別把官方帳號加好友。
- `成員設定` 的「已加好友」必須是 TRUE。
- Apps Script 觸發條件中要有 `sendReminderIfDue`。
- 若當天已完成打卡，系統會刻意不再提醒。
