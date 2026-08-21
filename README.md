# 飲控打卡緊迫盯人｜GitHub Pages API 測試包

這一版把「畫面」搬到 GitHub Pages，資料仍由 Apps Script 從原本的 Google Sheet 提供。這是第二階段的唯讀版本：

```text
GitHub Pages（index / public / history）
          │ JSONP 唯讀 API
          ▼
Apps Script /exec ── Google Sheet
```

LIFF 登入、寫入紀錄與 LINE 深度整合保留到下一階段；本包不會把寫入 API 暴露到公開網頁。

## 1. 更新 Apps Script API

1. 先備份目前正式／測試專案。
2. 將 `apps-script/Code.gs` 的內容貼回 Apps Script 的 `Code.gs`。
3. 其餘 `Index.html`、`Public.html`、`History.html`、`appsscript.json` 沿用你目前版本；本包也附上對應檔案供比對。
4. 執行一次 `setupProject`（只需在該專案更新欄位時執行）。
5. `Deploy → Manage deployments` 編輯 Web app，選 **New version**，並確認：
   - Execute as：**Me**
   - Who has access：**Anyone**
   - 使用網址結尾為 **`/exec`**

部署完成後，先用瀏覽器測試：

```text
https://script.google.com/macros/s/你的部署ID/exec?api=1&resource=public&date=2026-08-21
```

若回傳 JSON（或帶 `callback` 時回傳 JSONP），API 就已就緒。

## 2. 設定 GitHub Pages

把下列根目錄檔案放到 GitHub Pages 的 branch/root：

```text
.nojekyll
config.js
api.js
styles.css
index.html
public.html
history.html
```

編輯 `config.js`，填入 Apps Script **完整 `/exec` 網址**：

```js
window.HEALTH_LOG_CONFIG = {
  apiUrl: 'https://script.google.com/macros/s/你的部署ID/exec'
};
```

推送後，GitHub Pages 會提供三個頁面：

```text
/index.html    個人唯讀打卡摘要（需要本人 uid/sig）
/public.html   公開紀錄牆（匿名可讀公開資料）
/history.html  卡路里歷史（需要本人 uid/sig）
```

## 3. 測試環境

測試專案先在 Apps Script 編輯器執行一次 `enableTestWebAccess`，再在頁面勾選「測試環境使用 `?test=1`」。正式專案不要開啟測試模式。

歷史頁與個人摘要頁需要本人簽章網址。可直接把 LINE 私訊中的完整打卡連結貼到「本人簽章網址」欄位，頁面會保存 `uid` 與 `sig`；簽章到期時重新從 LINE 取得新連結即可。

## 4. API 參考

```text
/exec?api=1&resource=public&date=YYYY-MM-DD
/exec?api=1&resource=history&uid=...&sig=...&days=30
/exec?api=1&resource=form&uid=...&sig=...&date=YYYY-MM-DD
```

三個 resource 都支援 `callback=函式名稱`，GitHub Pages 會透過 JSONP 讀取，避開 Apps Script 的跨網域限制。API 只讀取資料，不會新增、修改或刪除 Google Sheet 紀錄。

## 5. 建議的測試順序

1. 先用 `/exec?api=1&resource=public` 確認 API 有 JSON 回應。
2. 在 `config.js` 填 API URL，打開 GitHub Pages 的 `public.html`。
3. 貼一個本人簽章網址測試 `index.html` 與 `history.html`。
4. 確認三頁都正常後，再把這個 branch 合併到正式 Pages branch。
