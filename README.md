# 姊妹飲控 LINE Bot

供小群組使用的飲食與運動記錄工具。從 LINE 開啟手機打卡頁，使用照片辨識、食物庫或手動輸入記錄餐點；資料儲存在 Google Sheet，可查看個人歷史、週報、公開牆與群組打卡空間。

目前版本：`2026.09.17-120`。

## 現有功能

- LINE 成員綁定、個人設定與具有效期的存取連結。
- 早餐、午餐、晚餐、宵夜、點心記錄；支援食物庫、Gemini 照片辨識及手動輸入。
- 熱量與蛋白質統計、飲水目標、多筆運動紀錄、BMR 與估算熱量差；蛋白質目標可選一般活動（體重 × 1.2）、規律運動（× 1.5）或重訓／增肌／減脂（× 1.8）。
- 自動儲存與「打卡中／完成」狀態；可填寫今天或補登最近三天。
- 個人歷史以本週／本月／上月／自訂頁籤連接攝取趨勢圖；歷史明細另以清單／月曆頁籤切換，清單預設顯示最近 5 筆，其餘分批載入。週／月熱量總覽保留獨立區塊，日期範圍同步套用摘要、趨勢、總覽與清單。
- 歷史明細可直接前往最近三天補登；較早紀錄可把餐點複製成今天的裝置草稿，檢查後再送出。
- 歷史摘要下方提供「我的努力報告」入口；週報／月報可切換期間，標示累積中或已結束及紀錄天數。先預覽，按分享或下載時才製作圖片。
- 週報呈現每日記錄節奏，月報彙整每週記錄天數、運動累積與連續完成天數。預覽與分享圖片以「本期觀察」取代制式下期建議；比較上一期相同天數（大小月取共同日期），少於 3 個記錄日提示資料不足，區分無紀錄與無完成紀錄。
- 公開紀錄牆、按讚、群組紀錄牆，以及使用邀請碼加入的打卡空間。
- 個人提醒時段：09:00、12:00、19:30，可在個人設定調整開關。
- 本機草稿、斷線恢復、暫時性儲存錯誤自動重試。

內建食物與辨識結果是估算值，請依實際份量、營養標示或可靠資料校正。照片辨識預設限制每人每日 40 次、全體每日 300 次，仍需具備可用的 Gemini API 額度。

## 公開作品介紹頁（GitHub Pages）

`docs/` 是獨立的靜態介紹頁，僅包含展示資料，不連接正式紀錄。先在 `docs/config.js` 填入 LINE 官方帳號公開加入好友網址，並將 QR Code 圖片放進 `docs/assets/`，設定 `qrImage` 相對路徑。未設定網址時，頁面顯示「加入好友入口準備中」。

GitHub repository 的 Settings → Pages → Source 選擇 **GitHub Actions**。推送 `docs/` 與 `.github/workflows/pages.yml` 到 `main` 後，工作流程只發布 `docs/`。成功後預期網址為 `https://bonniEdo.github.io/calorie-line-bot/`，實際網址以 Pages 部署結果為準。勿將帶有 uid／sig 的個人打卡連結放進介紹頁。

本機預覽可在專案根目錄執行 `python3 -m http.server 8080 --directory docs`，再開啟 `http://localhost:8080`。

## 系統架構

```text
LINE webhook → Cloudflare Worker 驗證簽章／過濾群聊 → Apps Script → LINE API
手機打卡頁 → google.script.run → Apps Script → Google Sheet／Script Properties
           ↘ localStorage 裝置草稿
```

網頁儲存不經過 Worker。Google Sheet 保存每日紀錄、食物與成員等資料；Script Properties 保存憑證、部分個人設定及排程進度；CacheService 僅作加速，不能作為資料是否存在的唯一依據。

```text
apps-script/
  Code.gs          後端、資料存取、LINE、照片辨識與排程
  Index.html       打卡頁、自動儲存與本機草稿
  History.html     個人歷史、週報
  Personal.html    個人設定
  Public.html      公開紀錄牆
  GroupWall.html   群組紀錄牆
  appsscript.json  時區與授權範圍
cloudflare-worker/
  src/index.js
  wrangler.toml.example
tests/
  storage.test.cjs 儲存與提醒的本機回歸測試
```

## 首次安裝

### 1. 建立 Google Sheet 與 Apps Script

1. 建立一份 Google Sheet，例如「姊妹飲控打卡資料庫」。不要開放任何人編輯；一般成員透過網頁使用，實際寫入由 Apps Script 執行。
2. 從試算表選擇「擴充功能 → Apps Script」。
3. 將 `apps-script/Code.gs` 貼入 `Code.gs`。
4. 逐一建立 `Index`、`History`、`Personal`、`Public`、`GroupWall` HTML 檔，貼入對應內容。不能只上傳 Index。
5. 設定 `appsscript.json`，確認時區為 `Asia/Taipei`。
6. 執行 `setupProject` 並完成 Google 授權。

初始化會建立或更新七張工作表：系統設定、成員設定、群組設定、群組成員、食物庫、每日紀錄、公開按讚。也會建立 `SPREADSHEET_ID`、`RELAY_SECRET`、`FORM_SIGNING_SECRET` 與 `SIG_VERSION`。

在「專案設定 → 指令碼屬性」加入：

| 屬性 | 用途 |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API 的 Channel access token |
| `GEMINI_API_KEY` | 照片辨識使用；未設定仍可手動記錄 |

憑證不要放在 Sheet、Git 或分享給一般成員。

### 2. 部署 Apps Script

「部署 → 新增部署作業 → 網頁應用程式」：

- 執行身分：我。
- 誰可以存取：任何人。
- 保存以 `/exec` 結尾的正式網址。

網頁的個人資料存取仍會驗證簽署連結。打卡連結有效期為 72 小時；過期請回 LINE 輸入「打卡」。

### 3. 部署 Cloudflare Worker

可在 Cloudflare Dashboard 建立 Worker，貼入 `cloudflare-worker/src/index.js`，或依 `wrangler.toml.example` 設定。

| 變數 | 類型 | 來源 |
|---|---|---|
| `LINE_CHANNEL_SECRET` | Secret | LINE Developers → Basic settings |
| `APPS_SCRIPT_RELAY_SECRET` | Secret | Apps Script 的 `RELAY_SECRET` |
| `APPS_SCRIPT_WEBHOOK_URL` | Text 或 Secret | Apps Script 正式 `/exec` 網址 |

以瀏覽器開啟 Worker 網址，應回傳 `ok: true`。

### 4. 連接 LINE

1. 在 LINE Developers 的 Messaging API 設定 Webhook URL，填 **Worker 網址**。
2. 按 Verify，再開啟 Use webhook；要用群組功能時，開啟 Allow bot to join group chats。
3. 在官方帳號後台關閉會造成重複回覆的預設自動回應。
4. 每位成員加入官方帳號好友，私訊「綁定」或「打卡」，開啟頁面。
5. 邀請官方帳號進群組後，可使用「打卡」「今日排行」「說明」等指令。打卡空間也能透過頁面建立與分享邀請碼。

Worker 會忽略群組一般聊天，減少 Apps Script 的不必要執行。

### 5. 安裝個人提醒

在 Apps Script 執行 `installReminderTrigger`，會建立 09:00、12:00、19:30 三個每日觸發器，並清除程式列出的舊提醒與舊排行榜觸發器。時間觸發器為近似時間，不保證精確到指定分鐘。

提醒遵循成員的好友與個人時段設定；即使當天已完成，也可能提醒補充下一餐。目前不再主動發送舊版午夜結算或早晨群組總結，請在紀錄牆查看日期資料。

## 本次儲存優化

### 後端

- 每日紀錄、成員及群組牆的快取清除改為批次 `removeAll()`；每日清除清單會去重。暫時保留舊快取版本的失效處理，兼容升級中的部署。
- 飲水開關或目標未變更時，不重寫 Script Properties；成員偏好沿用原有的變更檢查。
- 提醒發送先在短時間全域鎖內登記工作，呼叫 LINE 時釋放鎖，不再讓打卡排隊等待整批推播。
- 每個提醒時段保留當日成功名單、LINE retry key 與十分鐘執行租約。失敗不標記整批完成；同日再次執行該時段函式時，只補送未成功者。LINE 已接受同一 retry key 的 409 回應視為成功。
- **本次未新增提醒失敗的自動重跑觸發器**。只有每日觸發器的部署若遇發送失敗，可同日手動重跑對應函式；仍有舊輪詢觸發器時則會由後續執行重試。意外終止的租約需最多十分鐘才可重新取得。
- 寫入確認 `flush()` 完成後才釋放儲存鎖。資料列快取失效且最近 100 列找不到紀錄時，再查較早的日期／成員欄位，避免重複新增。
- 個人設定中的群組分享開關仍維持原本「套用全部歷史」行為；本輪未改變分享權限模型。

### 網頁草稿與同步

- 已加入餐點清單、飲水、運動及表單設定的修改會先保存裝置草稿，再依原有延遲合併送出。尚未加入清單的手輸文字或照片辨識預覽不在草稿範圍。
- 草稿依使用者與紀錄日期分開，不包含登入簽章、照片原始檔或體重欄位；包含餐點、姓名、BMR 與分享偏好等表單資料。啟動時清理該使用者超過四天的草稿。
- 重新開啟同一天時，若有草稿，提供「還原草稿」或「保留雲端紀錄」。還原後請檢查再送出，不會一開頁就覆蓋雲端。
- 暫時性網路、逾時、鎖定等錯誤，最多追加三次重試，間隔為 2、5、10 秒；重試送出目前最新內容。
- 離線時保留草稿，頁面保持開啟並恢復連線時再同步。憑證過期或驗證失敗不自動重試，請取得新連結後還原草稿。
- 畫面區分裝置暫存、同步中、已同步、尚未同步；只有伺服器確認成功且沒有較新的修改時，才刪除草稿。補登切換日期會先等待當前儲存成功。
- 若 LINE 內嵌瀏覽器禁止或清除 localStorage，無法保證重開後恢復；畫面會提示不要關閉未同步頁面。這不是離線可啟動的 PWA，首次開頁仍需網路。
- 跨裝置的資料版本衝突檢查不在本輪範圍，避免同時在多個頁面編輯同一天。

### 效能量測

成功儲存會在 Apps Script 執行紀錄輸出 `daily_save`，不記錄 uid、姓名、餐點或簽章：

| 欄位 | 意義 |
|---|---|
| `prepareMs` | 驗證、讀取設定、計算與等待寫入鎖之前的時間 |
| `lockWaitMs` | 等待全域寫入鎖的時間 |
| `writeMs` | 持鎖內設定／紀錄寫入、快取清除與 flush 的時間 |
| `totalMs` | 此後端儲存函式的總耗時 |
| `isBackfill` | 是否為補登 |

瀏覽器主控台的 `daily_save.roundTripMs` 記錄呼叫到收到成功回覆的時間，另附後端 timing；不含輸入後等待自動儲存的延遲，也不是包含所有失敗重試的總時間。

部署後分別量測一般儲存、補登與提醒時段，區分第一次載入／快取失效，以及快取命中的情況。比較中位數、較慢的 95 百分位和失敗率；本機模擬測試不代表正式 Google 服務的延遲，尚無實測加速倍數。

## 更新既有部署

1. 將新版 `Code.gs`、`Index.html` 與 `History.html` 更新至原 Apps Script 專案；若其他 HTML 尚未安裝，也要一併補齊。
2. 「部署 → 管理部署作業 → 編輯 → 新版本 → 部署」，保留同一 `/exec` 網址。只儲存編輯器內容不會更新正式網頁。
3. 本輪不需重建 Sheet、重設憑證或修改 Worker；已使用三時段提醒者不必重建觸發器。若仍是舊 22:00 版本，執行 `installReminderTrigger` 更新排程。
4. 關閉舊打卡頁，回 LINE 重新輸入「打卡」取得頁面，再測試儲存。
5. 驗證：一般儲存、完成打卡、補登、儲存中繼續修改、斷線後重連、草稿恢復、憑證失效，以及兩人同時儲存。

## 本機測試

安裝 Node.js 18 以上，在專案根目錄執行：

```sh
node --test tests/storage.test.cjs
```

使用隔離的 Apps Script／瀏覽器模擬服務，不讀寫正式 Sheet、不發送 LINE 訊息。涵蓋語法、批次快取失效、設定變更檢查、提醒鎖與部分失敗恢復、舊資料列查找、草稿、重試、憑證失效、儲存中修改及日期切換。實際 LINE 內嵌瀏覽器與 Apps Script 部署仍需上述驗收。

## 食物資料與估算規則

`食物庫` 包含 FoodId、分類、名稱、標準份量、熱量kcal、Emoji、圖片網址、啟用、資料來源、估算等級、排序與蛋白質g。FoodId 建立後不要任意修改；圖片使用可公開讀取的 HTTPS 網址；啟用為 TRUE 才顯示。建議先維護常吃的 40～60 個品項，並標明資料來源。

```text
今日總攝取 = 早餐 + 午餐 + 晚餐 + 宵夜 + 點心
估算總消耗 = BMR × 1.2 + 活動熱量
估算赤字 = 估算總消耗 - 今日總攝取
```

運動手錶請填活動熱量，避免把含休息代謝的總消耗再次相加。熱量差僅供日常追蹤，不代表赤字越大越健康。

## 常見問題

- **Webhook Verify 失敗**：確認填的是 Worker URL、三個 Worker 變數正確、Apps Script `/exec` 可存取；LINE Channel secret 與 access token 不同。
- **程式更新後仍是舊頁面**：確認管理部署已切換新版本，並關閉舊頁重新開啟。
- **顯示已存於此裝置**：表示仍未確認雲端成功；請等待同步或依提示重試，勿視為完成打卡。
- **提醒未送達**：確認成員加好友、個人提醒與時段開關、觸發器及執行紀錄；回傳 `failed` 大於零時，可同日重新執行對應時段函式。
- **照片無法辨識**：確認 `GEMINI_API_KEY`、可用模型／API 額度與本專案每日上限；可改用手動輸入。
