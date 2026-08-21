# GitHub Pages 測試站（不影響正式環境）

這是第一階段的安全測試版：GitHub Pages 提供乾淨的測試入口，實際打卡、Google Sheet、Gemini、LINE 與排程仍由「測試 Apps Script Web App」處理。

## 先準備測試 Apps Script

1. 在 `develop` 分支使用本資料夾 `apps-script/` 內的檔案（正式 `main` 不要替換）。
2. 在測試 Apps Script 執行 `setupProject`。
3. 執行 `enableTestWebAccess`，確認測試成員已存在。
4. 到 **部署 → 管理部署 → 編輯 → 新版本 → 部署**，取得測試 `/exec` 網址。
5. 不要使用 `/dev`，也不要貼正式環境的 `/exec`。

## 開啟 GitHub Pages 測試站

把本資料夾的 `index.html`、`config.js`、`.nojekyll` 放到 GitHub 專案 `develop` 分支的根目錄，然後：

1. GitHub 專案 → **Settings → Pages**。
2. Source 選 **Deploy from a branch**。
3. Branch 選 `develop`，資料夾選 `/ (root)`，按 Save。
4. 開啟 GitHub Pages 網址，把測試 `/exec` 貼到輸入框並按「儲存網址」。
5. 依序測試「我要打卡」「公開紀錄牆」「卡路里歷史」。

頁面會把 Apps Script 的提示列裁切掉，實際內容仍是測試 Web App；可取消「隱藏 Apps Script 提示列」來排查載入問題。

## 這一版的邊界

目前 `Index.html` 仍使用 Apps Script 的 `google.script.run` 與伺服器模板資料，所以不能直接把它當成純靜態檔案搬到 GitHub Pages。這個測試站先驗證網址、測試部署與操作流程；等測試穩定後，再進行第二階段的 LIFF + Cloudflare Worker API 移植，才會完全不需要 Apps Script 頁面。

正式環境的 `main`、正式 Apps Script Web App、LINE webhook 與排程不會被此站改動。
