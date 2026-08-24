// 應用程式版本：2026.08.24-100（蛋白質主數字列）
// 若部署後頁面顯示其他版本，代表 Apps Script Web App 尚未切換到最新部署版本。
const APP_BUILD = '2026.08.24-100';
// 每位使用者只會看到一次的打卡頁公告版本；未來有真正的新一波功能時再換這個值。
const NEW_FEATURE_NOTICE_ID = '2026_08_check_in_space_reminders_and_protein_testing';

// 食物庫尚未手動填寫蛋白質時，內建食物仍可提供每份的保守估算值。
// 使用者自建食物可直接在「食物庫」的「蛋白質g」欄位填寫，優先權高於這份預設資料。
const DEFAULT_FOOD_PROTEIN_G = Object.freeze({
  common_yangtao_breakfast: 18, common_egg_sandwich: 16, common_overnight_oats: 12, common_boiled_egg: 6,
  staple_rice_half: 1.4, staple_rice_bowl: 2.8, staple_brown_half: 3, staple_toast: 3, staple_sweet_potato: 2, staple_oat: 5,
  protein_egg: 6, protein_chicken: 31, protein_tofu: 8, protein_salmon: 22, protein_pork: 26, protein_beef: 25,
  veg_boiled: 3, veg_stir: 3, veg_salad: 2,
  fruit_banana: 1, fruit_apple: 0.5, fruit_guava: 2,
  drink_soy: 12, drink_milk: 8, drink_latte: 8, drink_tea: 0,
  snack_nuts: 5, snack_chocolate: 2, snack_yogurt: 7,
  breakfast_egg_pancake: 12, breakfast_radish: 4,
  meal_bento_half: 28, meal_bento_full: 30, meal_hotpot: 32, meal_noodle: 18,
});

const APP = Object.freeze({
  timezone: 'Asia/Taipei',
  // 連結憑證的用途範圍。form 可讀寫紀錄；wall 是舊版純公開頁；hub 是本人紀錄牆。
  tokenScopes: { form: 'form', wall: 'wall', hub: 'hub' },
  // 連結的有效時間。過期後成員回 LINE 輸入「打卡」即可取得新連結。
  tokenTtlSeconds: { form: 72 * 60 * 60, wall: 24 * 60 * 60, hub: 72 * 60 * 60 },
  // 照片辨識共用同一組 Gemini 免費額度，需要上限避免單一連結外流後被無限呼叫。
  photoQuota: { perUserPerDay: 40, totalPerDay: 300 },
  sheets: {
    config: '系統設定',
    members: '成員設定',
    groups: '群組設定',
    groupMembers: '群組成員',
    foods: '食物庫',
    logs: '每日紀錄',
    publicLikes: '公開按讚',
  },
  headers: {
    config: ['Key', 'Value', '說明'],
    members: [
      'UserId', '姓名', '基礎代謝BMR', '體重kg', '身高cm', '年齡',
      '生理性別', '已加好友', '建立時間', '更新時間', '群組中',
      '公開暱稱', '參與公開排行', '預設公開紀錄', '預設公開食物細項', '個人提醒',
      '個人提醒早上', '個人提醒中午', '個人提醒晚間', '舊23點提醒（已停用）', '預設顯示在群組紀錄牆',
    ],
    // 前五欄維持舊版位置，後面欄位讓既有 LINE 群組與新版「打卡空間」共用同一張表。
    groups: ['GroupId', '群組名稱', '啟用排行', '建立時間', '更新時間', '類型', '建立者UserId', '邀請碼', '邀請碼到期'],
    groupMembers: ['GroupId', 'UserId', '群組中', '加入時間', '更新時間'],
    foods: [
      'FoodId', '分類', '名稱', '標準份量', '熱量kcal', 'Emoji',
      '圖片網址', '啟用', '資料來源', '估算等級', '排序', '蛋白質g',
    ],
    logs: [
      '建立時間', '日期', 'UserId', '姓名', '早餐kcal', '午餐kcal',
      '晚餐kcal', '點心kcal', '宵夜kcal', '總攝取kcal', '飲水ml',
      '運動項目', '運動分鐘', '活動熱量kcal', '基礎代謝BMR',
      '估算總消耗kcal', '估算赤字kcal', '食物明細JSON', '備註', '更新時間',
      '打卡狀態', '公開紀錄', '公開時間', '公開食物細項', '運動明細JSON', '飲水目標ml', '群組紀錄牆公開', '蛋白質g',
    ],
    publicLikes: ['日期', '按讚者UserId', '被按讚者UserId', '建立時間', '更新時間'],
  },
});
let runtimeSpreadsheet_ = null;

/**
 * 取得正式 Web App 網址。
 *
 * Apps Script 在編輯器手動執行函式時，ScriptApp.getService().getUrl()
 * 可能回傳只能讓專案編輯者開啟的 /dev；LINE 手機使用者沒有編輯權限，
 * 因此所有對外連結一律正規化成同一個部署的 /exec 網址。
 */
function getWebAppExecUrl_() {
  const props = PropertiesService.getScriptProperties();
  const configured = String(
    // 優先沿用既有正式網址設定；WEB_APP_EXEC_URL 保留給舊版相容。
    props.getProperty('WEB_APP_URL') || props.getProperty('WEB_APP_EXEC_URL') || ''
  ).trim();
  const serviceUrl = configured || String(ScriptApp.getService().getUrl() || '').trim();
  const baseUrl = serviceUrl.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const execUrl = baseUrl.replace(/\/dev$/i, '/exec');
  if (!/\/exec$/i.test(execUrl)) {
    throw new Error('找不到正式 Web App /exec 網址，請確認已部署網頁應用程式。');
  }
  return execUrl;
}

/**
 * 第一次使用時在 Apps Script 編輯器手動執行。
 * 建立工作表、欄位、示範食物與必要密鑰。
 */
function setupProject() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('請從 Google Sheet 的「擴充功能 → Apps Script」開啟此專案。');

  const props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());
  if (!props.getProperty('RELAY_SECRET')) {
    props.setProperty('RELAY_SECRET', Utilities.getUuid() + Utilities.getUuid());
  }
  if (!props.getProperty('FORM_SIGNING_SECRET')) {
    props.setProperty('FORM_SIGNING_SECRET', Utilities.getUuid() + Utilities.getUuid());
  }
  // 連結憑證的版本號。執行 revokeAllTokens() 會 +1，讓所有已發出的連結一次失效。
  if (!props.getProperty('SIG_VERSION')) props.setProperty('SIG_VERSION', '1');

  ensureSheet_(APP.sheets.config, APP.headers.config);
  ensureSheet_(APP.sheets.members, APP.headers.members);
  ensureSheet_(APP.sheets.groups, APP.headers.groups);
  ensureSheet_(APP.sheets.groupMembers, APP.headers.groupMembers);
  ensureSheet_(APP.sheets.foods, APP.headers.foods);
  ensureSheet_(APP.sheets.logs, APP.headers.logs);
  ensureSheet_(APP.sheets.publicLikes, APP.headers.publicLikes);
  migrateStoredWeightPrivacy_();
  seedFoods_();

  setConfig_('GROUP_ID', getConfig_('GROUP_ID') || '', '舊版單群組 ID（保留相容，不再使用）');
  setConfig_('LAST_REMINDER_DATE', getConfig_('LAST_REMINDER_DATE') || '', '舊版提醒紀錄（保留相容）');
  setConfig_('LAST_REMINDER_SLOT', getConfig_('LAST_REMINDER_SLOT') || '', '避免同一時段重複提醒');
  setConfig_('LAST_RANKING_DATE', getConfig_('LAST_RANKING_DATE') || '', '避免同一天重複發送排行榜');
  setConfig_('LAST_PERSONAL_RANKING_SENT_JSON', getConfig_('LAST_PERSONAL_RANKING_SENT_JSON') || '', '09:00 個人結算發送進度');
  setConfig_('LAST_FINALIZED_DATE', getConfig_('LAST_FINALIZED_DATE') || '', '避免同一天重複產生午夜結算');
  setConfig_('PENDING_RANKING_DATE', getConfig_('PENDING_RANKING_DATE') || '', '午夜已結算、等待早上發送的日期');
  setConfig_('PENDING_RANKING_TEXT', getConfig_('PENDING_RANKING_TEXT') || '', '午夜保存的排行榜內容');
  setConfig_('PENDING_GROUP_RANKINGS_JSON', getConfig_('PENDING_GROUP_RANKINGS_JSON') || '', '各群組午夜結算內容');
  setConfig_('LAST_RANKING_SENT_GROUPS_JSON', getConfig_('LAST_RANKING_SENT_GROUPS_JSON') || '', '各群組早上排行發送進度');
  setConfig_('DISCLAIMER', '熱量與赤字皆為估算，赤字並非越大越好。', '排行榜提示文字');

  formatSheets_();
  return {
    ok: true,
    spreadsheetId: ss.getId(),
    next: '到「專案設定 → 指令碼屬性」加入 LINE_CHANNEL_ACCESS_TOKEN 與 GEMINI_API_KEY（照片辨識需要），然後部署網頁應用程式。',
  };
}

/** Apps Script Web App：顯示手機版圖卡選餐頁。 */
function doGet(e) {
  const startedAt = Date.now();
  // 排程推播使用 launch 啟動碼：Trigger 只負責發隨機碼，真正的 form token
  // 由目前 /exec 的部署版本在使用者點擊時自己簽發、自己驗證，避免 HEAD 與部署版錯位。
  const launchAccess = resolveScheduledLaunchAccess_(e);
  const requestedView = String((e && e.parameter && e.parameter.view) || '');
  const view = launchAccess.present && launchAccess.valid ? launchAccess.view : requestedView;
  if (view === 'public') {
    const publicUid = String((e && e.parameter && e.parameter.uid) || '');
    const publicSig = String((e && e.parameter && e.parameter.sig) || '');
    const publicDate = validatePublicWallDate_((e && e.parameter && e.parameter.date) || today_());
    const publicTemplate = HtmlService.createTemplateFromFile('Public');
    // 身分只在 getPublicWallData_ 驗證一次，避免公開頁每次重複計算簽章。
    try {
      publicTemplate.publicJson = JSON.stringify(getPublicWallData_(publicUid, publicSig, publicDate));
    } catch (error) {
      // 公開牆切換日期時不要讓 Apps Script 直接吐白頁；把可讀的錯誤交給前端卡片顯示。
      console.error(`公開牆載入失敗（${publicDate}）：${error && error.stack ? error.stack : error}`);
      publicTemplate.publicJson = JSON.stringify({
        error: `公開牆載入失敗：${cleanText_(error && error.message ? error.message : error, 180)}`,
        date: publicDate,
        today: today_(),
        minDate: dateKeyDaysAgo_(today_(), 29),
        maxDate: today_(),
      });
    }
    return publicTemplate.evaluate()
      .setTitle('猛猛紀錄牆')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
  }
  if (view === 'group') {
    const groupUid = String((e && e.parameter && e.parameter.uid) || '');
    const groupSig = String((e && e.parameter && e.parameter.sig) || '');
    const groupId = String((e && e.parameter && e.parameter.group) || '');
    const groupDate = validatePublicWallDate_((e && e.parameter && e.parameter.date) || today_());
    const groupTemplate = HtmlService.createTemplateFromFile('GroupWall');
    try {
      groupTemplate.groupJson = JSON.stringify(getGroupWallData_(groupUid, groupSig, groupId, groupDate));
    } catch (error) {
      console.error(`群組紀錄牆載入失敗（${groupId} / ${groupDate}）：${error && error.stack ? error.stack : error}`);
      groupTemplate.groupJson = JSON.stringify({
        error: `群組紀錄牆載入失敗：${cleanText_(error && error.message ? error.message : error, 180)}`,
        date: groupDate,
        today: today_(),
        minDate: dateKeyDaysAgo_(today_(), 29),
        maxDate: today_(),
      });
    }
    return groupTemplate.evaluate()
      .setTitle('群組猛猛紀錄牆')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
  }
  if (view === 'history') {
    const testAccess = getTestWebAccess_(e);
    const historyLaunchValid = launchAccess.present && launchAccess.valid && launchAccess.view === 'history';
    const historyUid = testAccess
      ? testAccess.uid
      : (historyLaunchValid ? launchAccess.uid : String((e && e.parameter && e.parameter.uid) || ''));
    const historySig = testAccess
      ? testAccess.sig
      : (historyLaunchValid
        ? issueAccessToken_(historyUid, APP.tokenScopes.form, APP.tokenTtlSeconds.form)
        : String((e && e.parameter && e.parameter.sig) || ''));
    const tokenState = launchAccess.present && !launchAccess.valid
      ? launchAccess.state
      : inspectAccessToken_(historyUid, historySig, APP.tokenScopes.form);
    const historyTemplate = HtmlService.createTemplateFromFile('History');
    const historyData = tokenState === 'ok'
      ? getHistoryData_(historyUid, 365)
      : { valid: false, invalidReason: tokenState };
    if (tokenState === 'ok') {
      // 歷史頁是本人表單權限，導覽可安全提供回到打卡與公開紀錄的入口。
      historyData.nav = {
        formUrl: getSignedFormUrl_(historyUid),
        publicWallUrl: getPublicWallUrl_(historyUid),
      };
    }
    historyTemplate.historyJson = JSON.stringify(historyData);
    return historyTemplate.evaluate()
      .setTitle('卡路里歷史紀錄')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
  }
  // 測試專案可用 ?test=1 直接開啟指定測試帳號；正式環境可使用即時簽章網址，
  // 或由排程推播的 launch 啟動碼進入。
  const testAccess = getTestWebAccess_(e);
  const formLaunchValid = launchAccess.present && launchAccess.valid && launchAccess.view === 'form';
  const uid = testAccess
    ? testAccess.uid
    : (formLaunchValid ? launchAccess.uid : String((e && e.parameter && e.parameter.uid) || ''));
  const sig = testAccess
    ? testAccess.sig
    : (formLaunchValid
      ? issueAccessToken_(uid, APP.tokenScopes.form, APP.tokenTtlSeconds.form)
      : String((e && e.parameter && e.parameter.sig) || ''));
  const tokenState = launchAccess.present && !launchAccess.valid
    ? launchAccess.state
    : inspectAccessToken_(uid, sig, APP.tokenScopes.form);
  const valid = tokenState === 'ok';
  const member = valid ? getMemberById_(uid) : null;
  const waterSettings = valid ? getWaterSettings_(uid) : { enabled: false, goalMl: 2000 };
  const foods = valid ? getFoods_() : [];
  const frequentFoods = valid ? getFrequentFoods_(uid, foods, 4) : [];
  const recordDates = valid ? allowedRecordDates_().map((date, index) => ({
    date,
    label: ['今天', '昨天', '前天', '三天前'][index],
  })) : [];
  // 一次讀取四天資料，切換日期時由前端直接還原，不再每次呼叫 Apps Script。
  const dailyLogs = valid
    ? getRecentDailyFormData_(uid, foods, recordDates.map(item => item.date))
    : {};
  const template = HtmlService.createTemplateFromFile('Index');

  const bootstrap = {
    valid,
    // 讓畫面能分辨「連結過期」與「連結錯誤」，給出不同的說明。
    invalidReason: valid ? '' : tokenState,
    uid,
    sig,
    today: today_(),
    recordDates,
    member: member || {},
    waterSettings,
    foods,
    frequentFoods,
    todayLog: valid ? (dailyLogs[today_()] || null) : null,
    dailyLogs,
    // 跨日時由前端導向一個全新的頂層頁面，避免只 reload Apps Script
    // 內層 iframe 而出現白畫面；每次載入都重新簽發有效網址。
    formUrl: valid ? getSignedFormUrl_(uid) : '',
    publicWallUrl: getPublicWallUrl_(valid ? uid : ''),
    historyUrl: getHistoryUrl_(valid ? uid : ''),
    // 打卡頁只需要群組名稱來顯示分享設定；群組入口統一由「紀錄牆」處理。
    groupWalls: valid ? getWallTabsForUser_(uid) : [],
    // 打卡空間可在本頁建立與管理；加入則保留在 LINE 私訊，讓新朋友不需要先拿到個人連結。
    checkInSpaces: valid ? getCheckInSpacesForUser_(uid) : [],
    newFeatureNotice: valid ? getNewFeatureNotice_(uid) : { show: false },
  };
  // 新版頁面從隱藏的 HTML 文字節點讀取。
  template.bootstrapJson = JSON.stringify(bootstrap);
  const output = template.evaluate()
    .setTitle('飲控打卡緊迫盯人')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
  console.log(`打卡頁產生完成：${Date.now() - startedAt} ms`);
  return output;
}

/**
 * 公開牆日期切換的前端入口。
 * Apps Script 用底線結尾的函式不會暴露給 google.script.run，
 * 所以用這個薄包裝器在同一頁內讀取指定日期，避免整頁重載白畫面。
 */
function getPublicWallDataForClient(viewerId, viewerSignature, selectedDate) {
  return getPublicWallData_(viewerId, viewerSignature, selectedDate);
}

/** 群組牆日期切換的前端入口；每次都重新確認觀看者仍是群組成員。 */
function getGroupWallDataForClient(viewerId, viewerSignature, groupId, selectedDate) {
  return getGroupWallData_(viewerId, viewerSignature, groupId, selectedDate);
}

/** 打卡頁的空間管理入口；所有操作都需要本人有效的打卡連結。 */
function getCheckInSpacesForClient(payload) {
  return getCheckInSpacesForUser_(requireFormAccessUserId_(payload));
}

function createCheckInSpaceForClient(payload) {
  const userId = requireFormAccessUserId_(payload);
  const result = createCheckInSpace_(userId, payload && payload.name);
  return { ok: true, created: result, spaces: getCheckInSpacesForUser_(userId) };
}

function regenerateCheckInSpaceInviteForClient(payload) {
  const userId = requireFormAccessUserId_(payload);
  const result = regenerateCheckInSpaceInvite_(userId, payload && payload.groupId);
  return { ok: true, updated: result, spaces: getCheckInSpacesForUser_(userId) };
}

function leaveCheckInSpaceForClient(payload) {
  const userId = requireFormAccessUserId_(payload);
  leaveCheckInSpace_(userId, payload && payload.groupId);
  return { ok: true, spaces: getCheckInSpacesForUser_(userId) };
}

/** 使用者在打卡頁按下「知道了」後，這一版公告不再顯示。 */
function dismissNewFeatureNotice(payload) {
  const userId = requireFormAccessUserId_(payload);
  PropertiesService.getScriptProperties().setProperty(
    newFeatureNoticePropertyKey_(userId),
    String(Date.now())
  );
  return { ok: true };
}

function requireFormAccessUserId_(payload) {
  payload = payload || {};
  const userId = String(payload.uid || '');
  const sig = String(payload.sig || '');
  const tokenState = inspectAccessToken_(userId, sig, APP.tokenScopes.form);
  if (tokenState !== 'ok') throw new Error(accessTokenErrorMessage_(tokenState));
  return userId;
}

function getNewFeatureNotice_(userId) {
  userId = String(userId || '');
  if (!userId) return { show: false };
  const dismissedAt = PropertiesService.getScriptProperties().getProperty(newFeatureNoticePropertyKey_(userId));
  return { show: !dismissedAt, id: NEW_FEATURE_NOTICE_ID };
}

function newFeatureNoticePropertyKey_(userId) {
  return `NEW_FEATURE_NOTICE_${NEW_FEATURE_NOTICE_ID}_${String(userId || '')}`;
}

/**
 * 測試環境專用：啟用後可直接開啟 /exec?test=1，不影響正式環境。
 * 會挑選測試表中第一位已加好友成員作為測試帳號。
 */
function enableTestWebAccess() {
  const member = getMembers_().find(item => item.isFriend) || getMembers_()[0];
  if (!member || !member.userId) throw new Error('測試表中找不到成員，請先讓測試帳號完成綁定。');
  const props = PropertiesService.getScriptProperties();
  props.setProperty('TEST_MODE', 'true');
  props.setProperty('TEST_USER_ID', String(member.userId));
  const baseUrl = getWebAppExecUrl_();
  return {
    ok: true,
    user: member.name || member.userId,
    url: baseUrl ? `${baseUrl}?test=1` : '請先部署 Web app，再重新執行此函式。',
  };
}

/** 測試完成後可執行，關閉直接進入測試頁。 */
function disableTestWebAccess() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('TEST_MODE');
  props.deleteProperty('TEST_USER_ID');
  return { ok: true, message: '測試網頁直入模式已關閉。' };
}

/** 測試環境專用：產生最近 7 天假資料，方便預覽歷史頁。 */
function seedTestHistoryData() {
  const props = PropertiesService.getScriptProperties();
  if (String(props.getProperty('TEST_MODE') || '').toLowerCase() !== 'true') {
    throw new Error('這個函式只允許在 TEST_MODE=true 的測試專案執行。');
  }
  const memberId = String(props.getProperty('TEST_USER_ID') || '');
  const member = getMemberById_(memberId) || getMembers_().find(item => item.isFriend) || getMembers_()[0];
  if (!member || !member.userId) throw new Error('測試表中找不到成員。');

  const samples = [
    [520, 680, 610, 0, 0, '快走', 30, 180],
    [430, 720, 560, 180, 0, '重訓', 45, 260],
    [480, 590, 760, 0, 220, '未填寫', 0, 0],
    [350, 640, 540, 160, 0, '羽球', 60, 420],
    [620, 580, 690, 0, 0, '快走', 25, 150],
    [410, 760, 510, 0, 180, '重訓', 40, 230],
    [500, 630, 550, 0, 0, '未填寫', 0, 0],
  ];
  const now = new Date();
  samples.forEach((sample, index) => {
    const breakfast = sample[0];
    const lunch = sample[1];
    const dinner = sample[2];
    const snack = sample[3];
    const lateNight = sample[4];
    const exerciseName = sample[5] === '未填寫' ? '' : sample[5];
    const exerciseMinutes = sample[6];
    const exerciseKcal = sample[7];
    const intake = breakfast + lunch + dinner + snack + lateNight;
    const bmr = numberInRange_(member.bmr || 1334, 500, 5000);
    const tdee = Math.round(bmr * 1.2 + exerciseKcal);
    const date = dateDaysAgo_(index + 1);
    const details = JSON.stringify({
      breakfast: [{ name: '測試早餐', calories: breakfast, source: 'manual' }],
      lunch: [{ name: '測試午餐', calories: lunch, source: 'manual' }],
      dinner: [{ name: '測試晚餐', calories: dinner, source: 'manual' }],
      snack: snack ? [{ name: '測試點心', calories: snack, source: 'manual' }] : [],
      lateNight: lateNight ? [{ name: '測試宵夜', calories: lateNight, source: 'manual' }] : [],
    });
    upsertDailyRow_(date, member.userId, [
      now, date, member.userId, member.name,
      breakfast, lunch, dinner, snack, lateNight, intake,
      1500, exerciseName, exerciseMinutes, exerciseKcal, bmr,
      tdee, tdee - intake, details, '測試歷史資料', now,
      index === 2 ? '打卡中' : '完成', false, '', false, JSON.stringify([
        exerciseName ? { name: exerciseName, minutes: exerciseMinutes, kcal: exerciseKcal } : null,
      ].filter(Boolean)), 2000,
    ]);
  });
  return { ok: true, user: member.name, days: samples.length, message: '已建立最近 7 天測試歷史資料。' };
}

/**
 * 不需 LINE 的打卡空間整合測試。
 * 先執行 enableTestWebAccess()，再執行本函式；它會建立（或重用）一個測試空間，
 * 加入一位假測試夥伴並寫入一筆今天的「分享至空間」紀錄。
 */
function testCheckInSpaceFlow() {
  const props = PropertiesService.getScriptProperties();
  if (String(props.getProperty('TEST_MODE') || '').toLowerCase() !== 'true') {
    throw new Error('請先執行 enableTestWebAccess()，避免測試資料寫到非測試專案。');
  }
  const ownerUserId = String(props.getProperty('TEST_USER_ID') || '');
  const owner = getMemberById_(ownerUserId) || getMembers_()[0];
  if (!owner || !owner.userId) throw new Error('測試表中找不到測試帳號。');

  const guestUserId = `test_space_guest_${String(owner.userId).slice(-12)}`;
  upsertMember_({
    userId: guestUserId,
    name: '🧪 空間測試夥伴',
    isFriend: false,
    bmr: 1360,
    defaultPublishToGroup: true,
  });

  const testName = '🧪 打卡空間測試';
  let space = getGroups_().find(group => (
    isCheckInSpace_(group)
    && group.ownerUserId === String(owner.userId)
    && group.name === testName
  ));
  if (space) {
    regenerateCheckInSpaceInvite_(owner.userId, space.groupId);
  } else {
    createCheckInSpace_(owner.userId, testName);
  }
  space = getGroups_().find(group => (
    isCheckInSpace_(group)
    && group.ownerUserId === String(owner.userId)
    && group.name === testName
  ));
  const joined = joinCheckInSpaceByInvite_(guestUserId, space.inviteCode);
  const now = new Date();
  const intake = 1380;
  const bmr = 1360;
  const exercise = 260;
  upsertDailyRow_(today_(), guestUserId, [
    now, today_(), guestUserId, '🧪 空間測試夥伴',
    360, 520, 400, 100, 0, intake,
    0, '打籃球', 40, exercise, bmr,
    Math.round(bmr * 1.2 + exercise), Math.round(bmr * 1.2 + exercise - intake),
    JSON.stringify({
      breakfast: [{ name: '測試早餐', portion: '1 份', calories: 360, source: 'manual' }],
      lunch: [{ name: '測試午餐', portion: '1 份', calories: 520, source: 'manual' }],
      dinner: [{ name: '測試晚餐', portion: '1 份', calories: 400, source: 'manual' }],
      snack: [{ name: '測試點心', portion: '1 份', calories: 100, source: 'manual' }],
      lateNight: [],
    }),
    '測試打卡空間用資料', now,
    '完成', false, '', false, JSON.stringify([{ type: 'basketball', name: '打籃球', minutes: 40, kcal: exercise, kcalMode: 'auto' }]), '', true,
  ]);

  const ownerSpace = formatCheckInSpace_(getGroupById_(space.groupId), owner.userId);
  const wallUrl = getPublicWallUrl_(owner.userId);
  console.log('=== 打卡空間測試 ===');
  console.log(`空間：${ownerSpace.name}`);
  console.log(`邀請碼：${ownerSpace.inviteCode}`);
  console.log(`測試夥伴已加入：${joined.alreadyJoined ? '原本已在空間，已重新確認' : '是'}`);
  console.log(`紀錄牆：${wallUrl}`);
  return {
    ok: true,
    owner: owner.name || owner.userId,
    guest: '🧪 空間測試夥伴',
    space: ownerSpace,
    wallUrl,
    testPageUrl: `${getWebAppExecUrl_()}?test=1`,
    message: '已建立測試空間與測試夥伴紀錄；開啟 testPageUrl 後，在個人設定可看到空間，在紀錄牆可看到空間分頁與測試紀錄。',
  };
}

function getTestWebAccess_(e) {
  const requested = String((e && e.parameter && e.parameter.test) || '') === '1';
  const props = PropertiesService.getScriptProperties();
  const enabled = String(props.getProperty('TEST_MODE') || '').toLowerCase() === 'true';
  if (!requested || !enabled) return null;
  const userId = String(props.getProperty('TEST_USER_ID') || '');
  if (!userId) throw new Error('測試模式缺少 TEST_USER_ID，請先執行 enableTestWebAccess。');
  const token = issueAccessToken_(userId, APP.tokenScopes.form, APP.tokenTtlSeconds.form);
  return { uid: userId, sig: token };
}

/** Cloudflare Worker 驗證 LINE 簽章後，把原始 JSON 轉送到這裡。 */
function doPost(e) {
  try {
    const suppliedKey = String((e && e.parameter && e.parameter.key) || '');
    const expectedKey = PropertiesService.getScriptProperties().getProperty('RELAY_SECRET') || '';
    if (!suppliedKey || !safeEqual_(suppliedKey, expectedKey)) {
      return jsonOutput_({ ok: false, error: 'unauthorized' });
    }

    const raw = e && e.postData ? e.postData.contents : '';
    const body = JSON.parse(raw || '{}');
    const events = Array.isArray(body.events) ? body.events : [];
    events.forEach(handleLineEvent_);
    return jsonOutput_({ ok: true, processed: events.length });
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    return jsonOutput_({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}

function handleLineEvent_(event) {
  if (!event || !event.type) return;

  const source = event.source || {};
  const userId = source.userId || '';
  if (source.type === 'group' && source.groupId) {
    ensureGroupExists_(source.groupId);
  }

  if (event.type === 'follow' && userId) {
    const name = fetchLineDisplayName_(source) || '新成員';
    upsertMember_({ userId, name, isFriend: true });
    replyMessage_(event.replyToken, welcomeMessages_(userId, name));
    return;
  }

  if (event.type === 'unfollow' && userId) {
    upsertMember_({ userId, isFriend: false, joinPublicRanking: false });
    revokeTodayPublicRecord_(userId);
    return;
  }

  if (event.type === 'memberJoined') {
    const joinedMembers = event.joined && Array.isArray(event.joined.members)
      ? event.joined.members
      : [];
    joinedMembers.forEach(member => {
      if (member && member.userId) {
        markUserInGroup_(source.groupId || '', member.userId, true);
      }
    });
    return;
  }

  if (event.type === 'memberLeft') {
    const leftMembers = event.left && Array.isArray(event.left.members)
      ? event.left.members
      : [];
    leftMembers.forEach(member => {
      if (member && member.userId) {
        markUserInGroup_(source.groupId || '', member.userId, false);
      }
    });
    return;
  }

  if (event.type === 'leave' && source.type === 'group' && source.groupId) {
    const group = getGroupById_(source.groupId);
    upsertGroup_({
      groupId: source.groupId,
      name: group ? group.name : '未命名群組',
      enabled: false,
    });
    return;
  }

  if (event.type === 'join') {
    replyMessage_(event.replyToken, [{
      type: 'text',
      text: '嗨！我是飲控打卡緊迫盯人 🎉\n每位成員請先加我好友，系統會自動建立身分。\n請先在這個群組輸入「啟用排行」，之後輸入「今日排行」只會看到本群成員。',
    }]);
    return;
  }

  if (event.type !== 'message' || !event.message || event.message.type !== 'text') return;

  const text = String(event.message.text || '').trim();
  const compact = text.replace(/\s+/g, '');

  // 收到群組內的指令時順便校正身分，補強曾漏接 memberJoined 的情況。
  if (userId && source.type === 'group') {
    ensureUserGroupMembershipActive_(source.groupId || '', userId);
  }

  if (userId && source.type === 'user') {
    const current = getMemberById_(userId);
    if (!current) {
      upsertMember_({
        userId,
        name: fetchLineDisplayName_(source) || '新成員',
        isFriend: true,
      });
    }
  }

  // 打卡空間完全不依賴 LINE 群組：空間擁有者建立後，把邀請碼傳給好友；
  // 好友先加入官方帳號，再私訊「加入空間 邀請碼」即可進入。
  const createSpaceMatch = text.match(/^(?:建立|新增)(?:打卡)?空間\s+(.+)$/);
  if (createSpaceMatch) {
    if (source.type !== 'user' || !userId) {
      replyMessage_(event.replyToken, [{ type: 'text', text: '請先私訊我，再輸入「建立打卡空間 空間名稱」。' }]);
      return;
    }
    try {
      const result = createCheckInSpace_(userId, createSpaceMatch[1]);
      replyMessage_(event.replyToken, checkInSpaceCreatedMessages_(result));
    } catch (error) {
      replyMessage_(event.replyToken, [{ type: 'text', text: `建立打卡空間失敗：${cleanText_(error && error.message ? error.message : error, 100)}` }]);
    }
    return;
  }

  if (/^(?:建立|新增)(?:打卡)?空間$/.test(compact)) {
    replyMessage_(event.replyToken, [{ type: 'text', text: '請在後面加上名稱，例如：\n「建立打卡空間 晚餐不爆卡小隊」\n\n建立後我會給你一組 7 天有效的邀請碼。' }]);
    return;
  }

  // 邀請碼本身（MM + 6 碼）就是最短加入指令：好友加官方帳號後直接貼上即可。
  // 完整的「加入空間 邀請碼」仍保留，方便文字閱讀與舊教學相容。
  const directInviteCodeMatch = compact.match(/^(MM[A-HJ-NP-Z2-9]{6})$/i);
  const joinSpaceMatch = text.match(/^加入(?:打卡)?空間\s*([A-Za-z0-9\-]+)?$/i);
  if (joinSpaceMatch || directInviteCodeMatch) {
    if (source.type !== 'user' || !userId) {
      replyMessage_(event.replyToken, [{ type: 'text', text: '請先私訊我，再直接傳送邀請碼。' }]);
      return;
    }
    const inviteCode = (joinSpaceMatch && joinSpaceMatch[1]) || (directInviteCodeMatch && directInviteCodeMatch[1]) || '';
    if (!inviteCode) {
      replyMessage_(event.replyToken, [{ type: 'text', text: '請直接傳送邀請碼，例如：\nMMABC234' }]);
      return;
    }
    try {
      const result = joinCheckInSpaceByInvite_(userId, inviteCode);
      replyMessage_(event.replyToken, checkInSpaceJoinedMessages_(userId, result));
    } catch (error) {
      replyMessage_(event.replyToken, [{ type: 'text', text: `無法加入打卡空間：${cleanText_(error && error.message ? error.message : error, 120)}` }]);
    }
    return;
  }

  if (/^(打卡空間|我的打卡空間|空間管理)$/.test(compact)) {
    if (source.type !== 'user' || !userId) {
      replyMessage_(event.replyToken, [{ type: 'text', text: '打卡空間要由個人私訊管理。請私訊我輸入「打卡空間」。' }]);
      return;
    }
    replyMessage_(event.replyToken, checkInSpaceManagementMessages_(userId));
    return;
  }

  const renewSpaceMatch = text.match(/^(?:重設|更新)(?:打卡)?空間邀請碼\s*([A-Za-z0-9\-]+)?$/i);
  if (renewSpaceMatch) {
    if (source.type !== 'user' || !userId) {
      replyMessage_(event.replyToken, [{ type: 'text', text: '請私訊我重設邀請碼。' }]);
      return;
    }
    if (!renewSpaceMatch[1]) {
      replyMessage_(event.replyToken, [{ type: 'text', text: '請在後面填目前邀請碼，例如：\n「重設空間邀請碼 MMABC234」' }]);
      return;
    }
    try {
      const result = regenerateCheckInSpaceInvite_(userId, renewSpaceMatch[1]);
      replyMessage_(event.replyToken, [{ type: 'text', text: `已更新「${result.name}」的邀請碼 ✅\n新邀請碼：${result.inviteCode}\n有效到：${result.inviteExpiresAt}\n\n舊邀請碼已立即失效。` }]);
    } catch (error) {
      replyMessage_(event.replyToken, [{ type: 'text', text: `無法重設邀請碼：${cleanText_(error && error.message ? error.message : error, 120)}` }]);
    }
    return;
  }

  if (/^(綁定|加入|開始)$/.test(compact)) {
    if (!userId) {
      replyMessage_(event.replyToken, [{ type: 'text', text: '無法取得你的 LINE User ID，請改成私訊我「綁定」。' }]);
      return;
    }
    const name = fetchLineDisplayName_(source) || (getMemberById_(userId) || {}).name || '成員';
    upsertMember_({ userId, name, isFriend: source.type === 'user' ? true : undefined });
    replyMessage_(event.replyToken, bindSuccessMessages_(userId, name));
    return;
  }

  if (/^(關閉個人提醒|停用個人提醒|不要提醒|關閉咕咕咕)$/.test(compact)) {
    if (source.type !== 'user' || !userId) {
      replyMessage_(event.replyToken, [{ type: 'text', text: '請私訊我輸入「關閉咕咕咕」，就不會再收到個人提醒。' }]);
      return;
    }
    const current = getMemberById_(userId) || {};
    upsertMember_({
      userId,
      name: current.name || fetchLineDisplayName_(source) || '成員',
      isFriend: true,
      personalReminder: false,
      reminderMorning: false,
      reminderNoon: false,
      reminderEvening: false,
      reminderLate: false,
    });
    replyMessage_(event.replyToken, [{ type: 'text', text: '已關閉全部個人提醒 💤\n早上、中午、19:30 晚間提醒與 09:00 個人結算都會停止。想恢復時輸入「開啟唧唧唧」即可。' }]);
    return;
  }

  if (/^(開啟個人提醒|啟用個人提醒|恢復個人提醒|開啟唧唧唧)$/.test(compact)) {
    if (source.type !== 'user' || !userId) {
      replyMessage_(event.replyToken, [{ type: 'text', text: '請私訊我輸入「開啟唧唧唧」，就能收到個人提醒。' }]);
      return;
    }
    const current = getMemberById_(userId) || {};
    upsertMember_({
      userId,
      name: current.name || fetchLineDisplayName_(source) || '成員',
      isFriend: true,
      personalReminder: true,
      reminderMorning: true,
      reminderNoon: true,
      reminderEvening: true,
      // 舊 23:00 欄位保留在試算表作相容用途，但不再啟用。
      reminderLate: false,
    });
    replyMessage_(event.replyToken, [{ type: 'text', text: '已開啟全部個人提醒 🔔\n09:00、12:00、19:30 會依設定提醒。' }]);
    return;
  }

  if (/^個人提醒(狀態)?$/.test(compact)) {
    if (source.type !== 'user' || !userId) {
      replyMessage_(event.replyToken, [{ type: 'text', text: '請私訊我輸入「個人提醒狀態」。' }]);
      return;
    }
    const current = getMemberById_(userId);
    const enabled = !current || current.personalReminder !== false;
    const settings = getPersonalReminderSettings_(current);
    replyMessage_(event.replyToken, [{
      type: 'text',
      text: enabled
        ? `目前個人提醒：已開啟 🔔\n早上 09:00 ${settings.morning ? '✅' : '—'}　中午 12:00 ${settings.noon ? '✅' : '—'}　晚間 19:30 ${settings.evening ? '✅' : '—'}\n想全部停止請輸入「關閉咕咕咕」。`
        : '目前個人提醒：已關閉 💤\n想全部恢復請輸入「開啟唧唧唧」。',
    }]);
    return;
  }

  if (/^(啟用排行|啟用排行榜|設定排行)$/.test(compact)) {
    if (source.type !== 'group' || !source.groupId) {
      replyMessage_(event.replyToken, [{ type: 'text', text: '請到要使用排行榜的群組內輸入「啟用排行」。' }]);
      return;
    }
    const result = enableGroupRanking_(source.groupId);
    replyMessage_(event.replyToken, [{
      type: 'text',
      text: `✅ 已啟用「${result.groupName}」排行榜\n目前群組中 ${result.active} 人，已退出 ${result.inactive} 人。\n之後本群輸入「今日排行」只會顯示本群成員。`,
    }]);
    return;
  }

  if (/^(打卡|今日打卡|填寫|記錄)$/.test(compact)) {
    if (!userId) return;
    let member = getMemberById_(userId);
    if (!member) {
      const name = fetchLineDisplayName_(source) || '成員';
      upsertMember_({ userId, name, isFriend: source.type === 'user' ? true : undefined });
      member = getMemberById_(userId);
    }

    // 群組不再公開可編輯的個人網址，避免其他成員誤改發送者紀錄。
    // 個人網址改用 pushMessage_ 私訊給指令發送者；群組只收到結果提示。
    if (source.type === 'group' && source.groupId) {
      if (!member || !member.isFriend) {
        replyMessage_(event.replyToken, [{
          type: 'text',
          text: '請先私訊我輸入「綁定」並加入好友，我才能把你的個人打卡連結私訊給你。\n群組內不會顯示可編輯的連結。',
        }]);
        return;
      }

      const pushed = pushMessage_(userId, formButtonMessages_(userId));
      replyMessage_(event.replyToken, [{
        type: 'text',
        text: pushed
          ? '✅ 已私訊你的個人打卡連結，請到與機器人的聊天室開啟。\n群組內不會共用可編輯連結。'
          : '⚠️ 私訊打卡連結失敗，請先私訊我輸入「綁定」後再試一次。',
      }]);
      return;
    }

    replyMessage_(event.replyToken, formButtonMessages_(userId));
    return;
  }

  if (/^(今日排行|排行|排行榜|今天排行)$/.test(compact)) {
    const rankingStartedAt = Date.now();
    const rankingMessages = rankingMessagesForSource_(source, userId);
    const buildMs = Date.now() - rankingStartedAt;
    const replied = replyMessage_(event.replyToken, rankingMessages);
    console.log(`今日排行效能：建立 ${buildMs} ms，總計 ${Date.now() - rankingStartedAt} ms，回覆=${replied}`);
    return;
  }

  if (/^(公開紀錄|公開紀錄牆|公開排行|紀錄牆|猛猛紀錄牆|飲控紀錄牆)$/.test(compact)) {
    replyMessage_(event.replyToken, publicWallButtonMessages_(userId));
    return;
  }

  if (/^(說明|help|幫助)$/i.test(compact)) {
    replyMessage_(event.replyToken, [{
      type: 'text',
      text: '可用指令：\n・打卡：拍照或從相簿上傳，記錄今天飲食\n・建立打卡空間 名稱：建立不用 LINE 群組的私人打卡空間\n・直接傳邀請碼：加入朋友建立的打卡空間\n・打卡空間：查看自己的空間與邀請碼\n・猛猛紀錄牆／公開紀錄：查看公開紀錄、連續打卡排行與你的空間牆\n・個人提醒：查看 09:00／12:00／19:30 提醒狀態\n・開啟唧唧唧／關閉咕咕咕：全部開啟或關閉個人提醒\n・綁定：身分異常時重新綁定\n\n打卡空間不會發早上群組總結；大家可在猛猛紀錄牆自行選日期查看。',
    }]);
  }
}

function welcomeMessages_(userId, name) {
  return [
    {
      type: 'text',
      text: `${name}，歡迎加入飲控打卡緊迫盯人 🐥\n好友身分已自動建立完成 ✅\n個人提醒預設開啟 🔔（09:00／12:00／19:30）\n\n使用方式：\n1️⃣ 選早餐、午餐、晚餐、宵夜或點心\n2️⃣ 直接拍照或從相簿上傳\n3️⃣ 確認 AI 估算總熱量，細項可展開修改\n4️⃣ 內容會自動儲存為「打卡中」\n5️⃣ 今天確定不再補充時，按「送出打卡完成」\n\n同一天可以隨時再開啟補充；新增、刪除或修改內容後會自動切回打卡中。\n\n想和朋友一起看紀錄，不用建立 LINE 群組：輸入「建立打卡空間 名稱」取得邀請碼；好友加入官方帳號後，直接把邀請碼傳給我即可。\n\n可在打卡頁個人設定調整三個提醒；全部關閉輸入「關閉咕咕咕」，全部恢復輸入「開啟唧唧唧」。`,
    },
    {
      type: 'template',
      altText: `${name}，開始今天的飲控打卡`,
      template: {
        type: 'buttons',
        text: '不知道 BMR 沒關係：輸入生理性別、年齡、身高與體重即可估算。四項資料只在手機計算、不會上傳，系統只儲存 BMR。',
        actions: [
          { type: 'uri', label: '開始今天打卡', uri: getSignedFormUrl_(userId) },
          { type: 'uri', label: '查看歷史紀錄', uri: getHistoryUrl_(userId) },
          { type: 'uri', label: '查看猛猛紀錄牆', uri: getPublicWallUrl_(userId) },
        ],
      },
    },
  ];
}

function bindSuccessMessages_(userId, name) {
  return [{
    type: 'template',
    altText: `${name} 綁定完成`,
    template: {
      type: 'buttons',
      text: `${name} 重新綁定完成 ✅\n可用拍照或相簿記錄；同一天再次開啟會載入已儲存內容。`,
      actions: [
        { type: 'uri', label: '開啟今日打卡', uri: getSignedFormUrl_(userId) },
        { type: 'uri', label: '查看歷史紀錄', uri: getHistoryUrl_(userId) },
        { type: 'uri', label: '查看猛猛紀錄牆', uri: getPublicWallUrl_(userId) },
      ],
    },
  }];
}

function formButtonMessages_(userId) {
  return [{
    type: 'template',
    altText: '開啟今日飲控打卡',
    template: {
      type: 'buttons',
      text: `今天是 ${today_()}。可拍照或從相簿上傳；同一天可多次開啟、補充並更新紀錄。\n\n✨ 想和朋友一起記錄？請展開打卡頁的「個人設定」→「打卡空間」建立。`,
      actions: [
        { type: 'uri', label: '填寫今日紀錄', uri: getSignedFormUrl_(userId) },
        { type: 'uri', label: '查看歷史紀錄', uri: getHistoryUrl_(userId) },
        { type: 'uri', label: '查看猛猛紀錄牆', uri: getPublicWallUrl_(userId) },
      ],
    },
  }];
}

function publicWallButtonMessages_(userId) {
  return [{
    type: 'template',
    altText: '查看猛猛紀錄牆',
    template: {
      type: 'buttons',
      text: '公開紀錄、連續打卡排行與你加入打卡空間的分享紀錄都集中在這裡。在公開頁還可以幫別人按每日鼓勵讚 👍',
      actions: [{ type: 'uri', label: '開啟猛猛紀錄牆', uri: getPublicWallUrl_(userId) }],
    },
  }];
}

/**
 * HTML 頁面呼叫：儲存或覆蓋當天紀錄。
 * 同一天、同一成員只保留一列，重送即更新。
 */
function saveDailyLog(payload) {
  payload = payload || {};
  const userId = String(payload.uid || '');
  const sig = String(payload.sig || '');
  const tokenState = inspectAccessToken_(userId, sig, APP.tokenScopes.form);
  if (tokenState !== 'ok') throw new Error(accessTokenErrorMessage_(tokenState));
  const recordDate = validateRecordDate_(payload.recordDate);

  let member = getMemberById_(userId);
  if (!member) throw new Error('尚未綁定成員，請先私訊機器人「綁定」。');

  const displayName = cleanText_(payload.name || member.name, 40) || member.name;
  const bmr = numberInRange_(payload.bmr, 0, 5000);
  const finalBmr = bmr || numberInRange_(member.bmr, 0, 5000);
  const requestedPublicAlias = payload.publicAlias === undefined
    ? String(member.publicAlias || '')
    : cleanText_(payload.publicAlias, 40);
  const requestedPublicRanking = payload.joinPublicRanking === undefined
    ? Boolean(member.joinPublicRanking)
    : Boolean(payload.joinPublicRanking);
  // 公開設定屬於成員偏好，而不是每天歸零的紀錄欄位。
  const requestedDefaultPublishToday = payload.publishToday === undefined
    ? Boolean(member.defaultPublishToday)
    : Boolean(payload.publishToday);
  const requestedDefaultPublishFoodDetails = requestedDefaultPublishToday && (
    payload.publishFoodDetails === undefined
      ? Boolean(member.defaultPublishFoodDetails)
      : Boolean(payload.publishFoodDetails)
  );
  // 群組分享是唯一的長期開關；切換後會套用到所有既有與往後的每日紀錄。
  const requestedDefaultPublishToGroup = payload.publishToGroup === undefined
    ? Boolean(member.defaultPublishToGroup)
    : Boolean(payload.publishToGroup);
  const storedWaterSettings = getWaterSettings_(userId);
  const waterEnabled = payload.waterEnabled === undefined
    ? Boolean(storedWaterSettings.enabled)
    : Boolean(payload.waterEnabled);
  const waterGoalMl = Math.round(numberInRange_(
    payload.waterGoalMl === undefined ? storedWaterSettings.goalMl : payload.waterGoalMl,
    500,
    10000,
  )) || 2000;
  const memberChanged = displayName !== member.name
    || (finalBmr && finalBmr !== Number(member.bmr || 0))
    || requestedPublicAlias !== String(member.publicAlias || '')
    || requestedPublicRanking !== Boolean(member.joinPublicRanking)
    || requestedDefaultPublishToday !== Boolean(member.defaultPublishToday)
    || requestedDefaultPublishFoodDetails !== Boolean(member.defaultPublishFoodDetails)
    || requestedDefaultPublishToGroup !== Boolean(member.defaultPublishToGroup);
  const groupPreferenceChanged = requestedDefaultPublishToGroup !== Boolean(member.defaultPublishToGroup);
  const pendingMemberUpdate = memberChanged
    ? {
      userId,
      name: displayName,
      bmr: finalBmr,
      publicAlias: requestedPublicAlias,
      joinPublicRanking: requestedPublicRanking,
      defaultPublishToday: requestedDefaultPublishToday,
      defaultPublishFoodDetails: requestedDefaultPublishFoodDetails,
      defaultPublishToGroup: requestedDefaultPublishToGroup,
    }
    : null;

  const foodMap = {};
  getFoods_().forEach(food => { foodMap[food.id] = food; });
  const mealKeys = ['breakfast', 'lunch', 'dinner', 'lateNight', 'snack'];
  const mealTotals = {};
  const selectedDetails = {};

  mealKeys.forEach(mealKey => {
    const items = payload.meals && Array.isArray(payload.meals[mealKey]) ? payload.meals[mealKey] : [];
    const aiItems = payload.aiMeals && Array.isArray(payload.aiMeals[mealKey]) ? payload.aiMeals[mealKey] : [];
    let total = 0;
    selectedDetails[mealKey] = [];
    items.forEach(item => {
      const food = foodMap[String(item.id || '')];
      if (!food) return;
      const quantity = numberInRange_(item.quantity, 0, 20);
      if (!quantity) return;
      const calories = Math.round(food.kcal * quantity);
      total += calories;
      selectedDetails[mealKey].push({
        id: food.id,
        name: food.name,
        portion: food.portion,
        quantity,
        calories,
        proteinG: proteinGrams_(Number(food.proteinG || 0) * quantity),
      });
    });

    // 照片辨識與手動輸入共用同一份餐點明細，後端再次限制範圍。
    aiItems.slice(0, 30).forEach(item => {
      const name = cleanText_(item.name, 60);
      const portion = cleanText_(item.portion, 80);
      const calories = Math.round(numberInRange_(item.calories, 0, 5000));
      if (!name || !calories) return;
      const source = item.source === 'manual' ? 'manual' : 'gemini';
      total += calories;
      selectedDetails[mealKey].push({
        id: cleanText_(item.id, 80) || `ai_${selectedDetails[mealKey].length + 1}`,
        source,
        name,
        portion,
        grams: Math.round(numberInRange_(item.grams, 0, 3000)),
        amount: Math.round(numberInRange_(item.amount, 0, 5000)),
        baseAmount: Math.round(numberInRange_(item.baseAmount, 0, 5000)),
        unit: String(item.unit || '').toLowerCase() === 'ml' ? 'ml' : 'g',
        baseCalories: Math.round(numberInRange_(item.baseCalories, 0, 5000)),
        baseLow: Math.round(numberInRange_(item.baseLow, 0, 5000)),
        baseHigh: Math.round(numberInRange_(item.baseHigh, 0, 5000)),
        baseProteinG: proteinGrams_(item.baseProteinG),
        proteinG: proteinGrams_(item.proteinG),
        quantity: 1,
        calories,
        confidence: source === 'manual'
          ? ''
          : (['高', '中', '低'].includes(item.confidence) ? item.confidence : '低'),
        notes: cleanText_(item.notes, 200),
      });
    });
    mealTotals[mealKey] = Math.round(total);
  });

  // 舊版曾把無餐別熱量放在 extraKcal；新版將它歸入宵夜，避免升級時遺失。
  const legacyExtraKcal = Math.round(numberInRange_(payload.extraKcal, 0, 5000));
  if (legacyExtraKcal) {
    mealTotals.lateNight += legacyExtraKcal;
    selectedDetails.lateNight.push({
      id: 'legacy_extra_kcal',
      source: 'manual',
      name: '舊版直接輸入',
      portion: '升級後歸入宵夜',
      quantity: 1,
      calories: legacyExtraKcal,
    });
  }
  const totalIntake = mealKeys.reduce((sum, key) => sum + mealTotals[key], 0);
  const totalProteinG = proteinGrams_(mealKeys.reduce((sum, mealKey) => (
    sum + selectedDetails[mealKey].reduce((mealSum, item) => mealSum + proteinGrams_(item && item.proteinG), 0)
  ), 0));
  const waterMl = waterEnabled
    ? Math.round(numberInRange_(payload.waterMl, 0, 10000))
    : 0;
  const exerciseRecords = (Array.isArray(payload.exerciseRecords) ? payload.exerciseRecords : [])
    .slice(0, 20)
    .map(record => ({
      type: cleanText_(record && record.type, 30),
      name: cleanText_(record && record.name, 60),
      minutes: Math.round(numberInRange_(record && record.minutes, 0, 1440)),
      kcal: Math.round(numberInRange_(record && (record.kcal !== undefined ? record.kcal : record.calories), 0, 10000)),
      kcalMode: record && record.kcalMode === 'manual' ? 'manual' : 'auto',
    }))
    .filter(record => record.name || record.minutes > 0 || record.kcal > 0);
  // 相容舊版頁面：若沒有 exerciseRecords，仍讀取原本的三個運動欄位。
  if (!exerciseRecords.length) {
    const legacyExercise = {
      name: cleanText_(payload.exerciseName, 60),
      minutes: Math.round(numberInRange_(payload.exerciseMinutes, 0, 1440)),
      kcal: Math.round(numberInRange_(payload.exerciseKcal, 0, 10000)),
    };
    if (legacyExercise.name || legacyExercise.minutes || legacyExercise.kcal) exerciseRecords.push(legacyExercise);
  }
  const exerciseName = exerciseRecords.map(record => record.name).filter(Boolean).join('、');
  const exerciseMinutes = exerciseRecords.reduce((sum, record) => sum + record.minutes, 0);
  const exerciseKcal = exerciseRecords.reduce((sum, record) => sum + record.kcal, 0);
  const estimatedBurn = finalBmr ? Math.round(finalBmr * 1.2 + exerciseKcal) : '';
  const estimatedDeficit = finalBmr ? Math.round(estimatedBurn - totalIntake) : '';
  const now = new Date();
  // 由使用者這次按下的按鈕決定狀態；已完成也可以主動改回打卡中繼續補充。
  const isComplete = Boolean(payload.isComplete);
  const isPublic = requestedDefaultPublishToday;
  // 食物細項是比熱量摘要更高一層的公開權限；只有今日紀錄本身公開時才允許開啟。
  const publishFoodDetails = requestedDefaultPublishFoodDetails;
  // 群組牆不依賴「啟用排行」；只要目前仍是群組成員即可選擇分享。
  const hasGroup = getActiveGroupIdsForUser_(userId).length > 0;
  const publishToGroup = hasGroup && requestedDefaultPublishToGroup;

  const row = [
    now,
    recordDate,
    userId,
    displayName,
    mealTotals.breakfast,
    mealTotals.lunch,
    mealTotals.dinner,
    mealTotals.snack,
    mealTotals.lateNight,
    totalIntake,
    waterMl,
    exerciseName,
    exerciseMinutes,
    exerciseKcal,
    finalBmr || '',
    estimatedBurn,
    estimatedDeficit,
    JSON.stringify(selectedDetails),
    cleanText_(payload.note, 500),
    now,
    isComplete ? '完成' : '打卡中',
    isPublic,
    isPublic ? now : '',
    publishFoodDetails,
    JSON.stringify(exerciseRecords),
    waterEnabled ? waterGoalMl : '',
    publishToGroup,
    totalProteinG,
  ];

  // 只在真正寫入工作表時持有全域鎖，避免自動儲存長時間卡住公開頁按讚。
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    if (pendingMemberUpdate) upsertMember_(pendingMemberUpdate);
    // 開關改變時，所有既有日期立即統一成同一個群組分享狀態。
    if (groupPreferenceChanged) setGroupWallVisibilityForUser_(userId, requestedDefaultPublishToGroup);
    saveWaterSettings_(userId, waterEnabled, waterGoalMl);
    upsertDailyRow_(recordDate, userId, row);
    // 今日紀錄會影響「常吃的食物」統計，儲存後立即清除快捷區快取，
    // 避免使用者關閉頁面重開時還看到儲存前的四個預設項目。
    CacheService.getScriptCache().remove(`frequent-foods:v5:${userId}:${today_()}`);
    CacheService.getScriptCache().remove(`frequent-foods:v6:${userId}:${today_()}`);
  } finally {
    lock.releaseLock();
  }
  return {
    ok: true,
    date: recordDate,
    isBackfill: recordDate !== today_(),
    totalIntake,
    estimatedBurn,
    estimatedDeficit,
    hasBmr: Boolean(finalBmr),
    waterEnabled,
    waterGoalMl,
    waterMl,
    isComplete,
    isPublic,
    publishFoodDetails,
    publishToGroup,
    defaultPublishToGroup: requestedDefaultPublishToGroup,
    totalProteinG,
  };
}

/** 打卡頁切換日期時懶載本人當日資料；日期範圍一律由後端驗證。 */
function getDailyFormForDate(payload) {
  payload = payload || {};
  const userId = String(payload.uid || '');
  const sig = String(payload.sig || '');
  const tokenState = inspectAccessToken_(userId, sig, APP.tokenScopes.form);
  if (tokenState !== 'ok') throw new Error(accessTokenErrorMessage_(tokenState));
  const recordDate = validateRecordDate_(payload.recordDate);
  const foods = getFoods_();
  return {
    ok: true,
    date: recordDate,
    isBackfill: recordDate !== today_(),
    log: getDailyFormData_(userId, foods, recordDate),
  };
}

/** 每日分時提醒：09:00、12:00、19:30（最後通知）。 */
function sendReminderIfDue() {
  const now = new Date();
  const hour = Number(Utilities.formatDate(now, APP.timezone, 'HH'));
  const minute = Number(Utilities.formatDate(now, APP.timezone, 'mm'));
  if (hour === 9) return sendReminderForSlot_('09:00');
  if (hour === 12) return sendReminderForSlot_('12:00');
  if (hour === 19 && minute >= 25 && minute <= 40) return sendReminderForSlot_('19:30');
  return { ok: true, skipped: 'not_due' };
}

function sendReminderAt0900() { return sendReminderForSlot_('09:00'); }
function sendReminderAt1200() { return sendReminderForSlot_('12:00'); }
function sendReminderAt1930() { return sendReminderForSlot_('19:30'); }

/** 舊觸發器的相容入口：重新安裝前也不會再在 18:00 或 23:00 發通知。 */
function sendReminderAt1800() { return { ok: true, skipped: 'retired_replaced_by_19_30' }; }
function sendReminderAt2300() { return { ok: true, skipped: 'retired_replaced_by_19_30' }; }

/** 09:00 僅發個人早晨提醒；打卡空間改由成員自行在紀錄牆查看歷史。 */
function sendMorningJobsAt0900() {
  const result = { ok: true };
  // 清掉已過期的排程啟動碼，避免 Script Properties 長期累積。
  try { cleanupExpiredScheduledLaunches_(); } catch (error) { console.warn(error); }
  try {
    result.reminder = sendReminderAt0900();
  } catch (error) {
    result.reminderError = error && error.message ? error.message : String(error);
  }
  result.ok = !result.reminderError;
  return result;
}

function sendReminderForSlot_(slot) {
  const date = today_();
  const reminderKey = `${date}|${slot}`;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { ok: true, skipped: 'another_run_active' };
  try {
  if (getConfig_('LAST_REMINDER_SLOT') === reminderKey) return { ok: true, skipped: 'already_sent' };

  const todayLogs = getTodayLogs_();
  const completedIds = new Set(
    todayLogs.filter(item => item.isComplete).map(item => item.userId)
  );
  const inProgressIds = new Set(
    todayLogs.filter(item => !item.isComplete).map(item => item.userId)
  );
  // 即使今天已按「打卡完成」，後續時段仍可提醒補充下一餐。
  const members = getReminderMembers_(slot);
  let sent = 0;

  members.forEach(member => {
    const inProgress = inProgressIds.has(member.userId);
    const completed = !inProgress && completedIds.has(member.userId);
    const greeting = reminderGreeting_(slot, member.name);
    const text = completed
      ? `${greeting}\n下一餐預備備。`
      : (inProgress
        ? `${greeting}\n記得「送出」打卡喔！`
        : `${greeting}\n點一下開始猛猛ㄉ飲控。`);
    const messages = [{
      type: 'template',
      altText: text,
      template: {
        type: 'buttons',
        text,
        actions: [{
          type: 'uri',
          label: completed ? '補充下一餐' : (inProgress ? '繼續猛猛打卡' : '開始猛猛打卡'),
          uri: getScheduledLaunchUrl_(member.userId, 'form'),
        }],
      },
    }];
    if (pushMessage_(member.userId, messages)) sent += 1;
  });

  setConfig_('LAST_REMINDER_SLOT', reminderKey, '避免同一時段重複提醒');
  return { ok: true, date, slot, sent, completedMembers: completedIds.size };
  } finally {
    lock.releaseLock();
  }
}

/** 三個時段的個人化提醒文案。 */
function reminderGreeting_(slot, name) {
  const safeName = cleanText_(name || '小夥伴', 40);
  if (slot === '09:00') return `${safeName}，古咕咕📣起床飲控啦！`;
  if (slot === '12:00') return `午安 ${safeName} 小傢伙，午餐解釋一下🍖🍜🥟🍣🍲🥝🍺`;
  if (slot === '19:30') return `Bonsoir ${safeName}，今天的最後提醒：還有要補充的嗎？`;
  return `${safeName}，緊迫盯人打卡！`;
}

function runScheduledJobs() {
  return {
    reminder: sendReminderIfDue(),
    ranking: sendRankingIfDue(),
  };
}

/** 舊的每小時觸發器相容入口：群組總結已退役，不再主動推播。 */
function sendRankingIfDue() {
  return { ok: true, skipped: 'group_summaries_retired_use_check_in_space_wall' };
}

function finalizePreviousDayAtMidnight() {
  // 舊午夜結算觸發器即使尚未被重新安裝清掉，也不再寫入或準備群組推播資料。
  return { ok: true, skipped: 'group_summaries_retired_use_check_in_space_wall' };

  const now = new Date();
  const hour = Number(Utilities.formatDate(now, APP.timezone, 'HH'));
  const date = hour === 23 ? today_() : dateDaysAgo_(1, now);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { ok: true, skipped: 'another_run_active' };
  try {
    if (getConfig_('LAST_FINALIZED_DATE') === date) return { ok: true, skipped: 'already_finalized' };
    const groups = getEnabledGroups_();
    const rankings = groups.map(group => ({
      groupId: group.groupId,
      groupName: group.name,
      text: buildRankingForDate_(date, true, group.groupId),
    }));
    setConfig_('PENDING_RANKING_DATE', date, '午夜已結算、等待早上發送的日期');
    setConfig_('PENDING_RANKING_TEXT', '', '舊版單群組排行榜內容（已停用）');
    setConfig_(
      'PENDING_GROUP_RANKINGS_JSON',
      JSON.stringify({ date, rankings }),
      '各群組午夜結算內容'
    );
    setConfig_(
      'LAST_RANKING_SENT_GROUPS_JSON',
      JSON.stringify({ date, groupIds: [] }),
      '各群組早上排行發送進度'
    );
    setConfig_('LAST_FINALIZED_DATE', date, '避免同一天重複產生午夜結算');
    return { ok: true, date, finalized: true, groups: rankings.length };
  } finally {
    lock.releaseLock();
  }
}

function sendPreviousDayRankingAt0900() {
  // 打卡空間的紀錄可自行選日期查看，不再於 09:00 逐一推送群組總結，
  // 也避免每個空間都消耗 LINE 訊息額度。
  return { ok: true, skipped: 'group_summaries_retired_use_check_in_space_wall' };

  // 舊版保留在下方，讓既有歷史程式碼容易比對；此 return 後不會執行。
  const expectedDate = dateDaysAgo_(1, new Date());
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { ok: true, skipped: 'another_run_active' };
  try {
    const rankingAlreadySent = getConfig_('LAST_RANKING_DATE') === expectedDate;
    const personalProgress = parseJsonObject_(getConfig_('LAST_PERSONAL_RANKING_SENT_JSON'));
    const personalAlreadySent = personalProgress.date === expectedDate && personalProgress.complete === true;
    if (rankingAlreadySent && personalAlreadySent) return { ok: true, skipped: 'already_sent' };
    const groups = getEnabledGroups_();

    const pending = parseJsonObject_(getConfig_('PENDING_GROUP_RANKINGS_JSON'));
    const pendingMap = new Map(
      pending.date === expectedDate && Array.isArray(pending.rankings)
        ? pending.rankings.map(item => [String(item.groupId || ''), String(item.text || '')])
        : []
    );
    const progress = parseJsonObject_(getConfig_('LAST_RANKING_SENT_GROUPS_JSON'));
    const sentGroupIds = new Set(
      progress.date === expectedDate && Array.isArray(progress.groupIds)
        ? progress.groupIds.map(String)
        : []
    );
    const failed = [];
    let sent = 0;

    groups.forEach(group => {
      if (sentGroupIds.has(group.groupId)) return;
      const text = pendingMap.get(group.groupId)
        || buildRankingForDate_(expectedDate, true, group.groupId);
      const flexMessage = buildRankingFlexMessage_(expectedDate, true, group.groupId);
      const pushed = pushMessage_(group.groupId, [flexMessage])
        || pushMessage_(group.groupId, [{ type: 'text', text }]);
      if (pushed) {
        sentGroupIds.add(group.groupId);
        sent += 1;
        setConfig_(
          'LAST_RANKING_SENT_GROUPS_JSON',
          JSON.stringify({ date: expectedDate, groupIds: Array.from(sentGroupIds) }),
          '各群組早上排行發送進度'
        );
      } else {
        failed.push(group.groupId);
      }
    });

    // 沒有任何已啟用群組的好友，改由官方帳號私訊自己的前一天摘要。
    // 即使某個群組推送失敗，也必須先完成個人通知，避免沒有群組的好友完全收不到訊息。
    const personal = sendStandalonePersonalRankingAt0900_(expectedDate);

    if (failed.length || personal.failed) {
      const errors = [];
      if (failed.length) errors.push(`群組排行榜：${failed.join(', ')}`);
      if (personal.failed) errors.push(`個人結算失敗 ${personal.failed} 人`);
      console.warn(`09:00 通知部分失敗，但流程已繼續：${errors.join('；')}`);
      return {
        ok: false,
        error: errors.join('；'),
        date: expectedDate,
        sent,
        groups: groups.length,
        failedGroups: failed,
        personalSent: personal.sent,
        personalFailed: personal.failed,
        usedMidnightSnapshot: pending.date === expectedDate,
      };
    }

    setConfig_('LAST_RANKING_DATE', expectedDate, '避免同一天重複發送排行榜');
    setConfig_('PENDING_RANKING_DATE', '', '午夜已結算、等待早上發送的日期');
    setConfig_('PENDING_RANKING_TEXT', '', '午夜保存的排行榜內容');
    setConfig_('PENDING_GROUP_RANKINGS_JSON', '', '各群組午夜結算內容');
    return {
      ok: true,
      date: expectedDate,
      sent,
      groups: groups.length,
      personalSent: personal.sent,
      personalFailed: personal.failed,
      usedMidnightSnapshot: pending.date === expectedDate,
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 09:00 個人結算：只發給「提醒開啟」且目前不在任何已啟用群組的人，
 * 避免同一個人同時收到群組排行榜與個人摘要兩份通知。
 */
function sendStandalonePersonalRankingAt0900_(date) {
  const enabledGroupIds = new Set(getEnabledGroups_().map(group => group.groupId));
  const activeGroupUserIds = new Set(
    getGroupMemberships_()
      .filter(item => item.inGroup && enabledGroupIds.has(item.groupId))
      .map(item => item.userId)
  );
  const members = getMembers_().filter(member => (
    member.userId
    && member.isFriend
    && getPersonalReminderSettings_(member).morning
    && !activeGroupUserIds.has(member.userId)
  ));
  const progress = parseJsonObject_(getConfig_('LAST_PERSONAL_RANKING_SENT_JSON'));
  const sentUserIds = new Set(
    progress.date === date && Array.isArray(progress.userIds)
      ? progress.userIds.map(String)
      : []
  );
  if (!members.length) {
    setConfig_(
      'LAST_PERSONAL_RANKING_SENT_JSON',
      JSON.stringify({ date, userIds: Array.from(sentUserIds), complete: true }),
      '09:00 個人結算發送進度'
    );
    return { sent: 0, failed: 0, skipped: 0, complete: true };
  }

  const logs = new Map(getLogsForDate_(date).map(log => [log.userId, log]));
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  members.forEach(member => {
    if (sentUserIds.has(String(member.userId))) {
      skipped += 1;
      return;
    }
    const log = logs.get(member.userId) || null;
    if (pushMessage_(member.userId, personalRankingMessages_(date, member, log))) {
      sent += 1;
      sentUserIds.add(String(member.userId));
    } else {
      failed += 1;
    }
  });
  const complete = failed === 0 && members.every(member => sentUserIds.has(String(member.userId)));
  setConfig_(
    'LAST_PERSONAL_RANKING_SENT_JSON',
    JSON.stringify({ date, userIds: Array.from(sentUserIds), complete }),
    '09:00 個人結算發送進度'
  );
  return { sent, failed, skipped, complete };
}

function personalRankingMessages_(date, member, log) {
  const name = cleanText_(member.name || '你', 40);
  let text;
  if (!log) {
    text = `☀️ ${date} 個人結算\n昨天沒有找到飲控紀錄。\n今天記得持續記錄歐。`;
  } else {
    const intake = Math.round(log.intake || 0);
    const allowance = Math.round(log.allowance || 0);
    const status = log.isComplete ? '✅ 昨天已完成打卡' : '📝 昨天仍是打卡中';
    const balance = log.deficit === null || log.deficit === undefined
      ? ''
      : (Number(log.deficit) >= 0
        ? `\n估算剩餘 ${Math.round(log.deficit)} kcal`
        : `\n估算超出 ${Math.round(Math.abs(log.deficit))} kcal`);
    text = `☀️ ${name}，${date} 個人結算\n已攝取：${intake} / ${allowance || '待設定'} kcal\n${status}${balance}`;
  }
  return [{
    type: 'template',
    altText: `${date} 個人飲控結算`,
    template: {
      type: 'buttons',
      text,
      actions: [
        { type: 'uri', label: '開始今天打卡', uri: getScheduledLaunchUrl_(member.userId, 'form') },
        { type: 'uri', label: '查看歷史紀錄', uri: getScheduledLaunchUrl_(member.userId, 'history') },
      ],
    },
  }];
}

/** 舊函式名稱保留，避免手動測試或既有觸發器呼叫時失效。 */
function sendPreviousDayRankingAt0800() {
  return sendPreviousDayRankingAt0900();
}

/** 舊函式名稱保留；執行時會清理已淘汰的 18:00／23:00 晚間提醒觸發器。 */
function removeReminderAt2330Trigger() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (['sendReminderAt1800', 'sendReminderAt2300', 'sendReminderAt2330'].includes(trigger.getHandlerFunction())) {
      ScriptApp.deleteTrigger(trigger);
      removed += 1;
    }
  });
  return { ok: true, removed, message: removed ? '已移除舊的 18:00／23:00 提醒排程。' : '找不到舊的晚間提醒排程，無需處理。' };
}

function installReminderTrigger() {
  const handlers = [
    'sendReminderIfDue', 'sendRankingIfDue', 'runScheduledJobs',
    'sendReminderAt0900', 'sendMorningJobsAt0900', 'sendReminderAt1200', 'sendReminderAt1930',
    // 已淘汰的晚間提醒列在清理名單，重新安裝時會一併移除，但不再建立新的。
    'sendReminderAt1800',
    'sendReminderAt2300', 'sendReminderAt2330', 'sendFinalRankingAtMidnight',
    'finalizePreviousDayAtMidnight', 'sendPreviousDayRankingAt0800',
    'sendPreviousDayRankingAt0900',
  ];
  ScriptApp.getProjectTriggers()
    .filter(trigger => handlers.includes(trigger.getHandlerFunction()))
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger('sendMorningJobsAt0900')
    .timeBased().atHour(9).nearMinute(0).everyDays(1).inTimezone(APP.timezone).create();
  ScriptApp.newTrigger('sendReminderAt1200')
    .timeBased().atHour(12).nearMinute(0).everyDays(1).inTimezone(APP.timezone).create();
  ScriptApp.newTrigger('sendReminderAt1930')
    .timeBased().atHour(19).nearMinute(30).everyDays(1).inTimezone(APP.timezone).create();
  return { ok: true, message: '已建立個人提醒排程：09:00、12:00、19:30。打卡空間不再發早上群組總結，請在紀錄牆選日期查看。' };
}

function buildTodayRanking_(groupId) {
  return buildRankingForDate_(today_(), false, groupId);
}

function getRankingData_(date, groupId) {
  groupId = String(groupId || '');
  if (!groupId) return null;
  const group = getGroupById_(groupId);
  const activeMemberIds = new Set(getActiveGroupMemberIds_(groupId));
  const memberMap = new Map(getMembers_().map(member => [member.userId, member]));
  const members = Array.from(activeMemberIds).map(userId => (
    memberMap.get(userId) || { userId, name: '尚未加好友的成員' }
  ));
  const logs = getLogsForDate_(date).filter(log => activeMemberIds.has(log.userId));
  const completedLogs = logs.filter(log => log.isComplete);
  const inProgressLogs = logs.filter(log => !log.isComplete);
  const completedIds = new Set(completedLogs.map(log => log.userId));
  const loggedIds = new Set(logs.map(log => log.userId));
  const ranked = completedLogs
    .filter(log => typeof log.deficit === 'number' && !Number.isNaN(log.deficit))
    .sort((a, b) => b.deficit - a.deficit);
  const withoutAllowance = completedLogs
    .filter(log => typeof log.deficit !== 'number' || Number.isNaN(log.deficit));
  const missing = members.filter(member => !loggedIds.has(member.userId)).map(member => member.name);

  return {
    date,
    groupId,
    groupName: group ? group.name : '本群組',
    members,
    completedLogs,
    inProgressLogs,
    ranked,
    withoutAllowance,
    missing,
    completedCount: completedIds.size,
  };
}

function buildRankingForDate_(date, isFinal, groupId) {
  const data = getRankingData_(date, groupId);
  if (!data) return '請在要查看的群組內輸入「今日排行」。';

  const lines = [
    isFinal
      ? `🏁 ${date} ${data.groupName}｜最終攝取進度`
      : `🏆 ${date} ${data.groupName}｜今日攝取進度`,
    '',
  ];
  if (!data.completedLogs.length) {
    lines.push('目前還沒有人完成打卡。', '在群組或私訊輸入「打卡」即可開始。');
  } else {
    data.ranked.forEach((item, index) => {
      const medals = ['🥇', '🥈', '🥉'];
      const icon = medals[index] || `${index + 1}.`;
      lines.push(`${icon} ${item.name}：${Math.round(item.intake)} / ${Math.round(item.allowance)} kcal`);
    });

    data.withoutAllowance
      .forEach(log => lines.push(`✅ ${log.name}：${Math.round(log.intake)} kcal / 可攝取總量待設定`));
  }

  if (data.inProgressLogs.length) {
    lines.push('', `📝 打卡中：${data.inProgressLogs.map(log => log.name).join('、')}`);
  }
  if (data.missing.length) lines.push('', `⏳ 尚未開始：${data.missing.join('、')}`);
  if (data.members.length) lines.push(`📌 完成 ${data.completedCount}/${data.members.length} 人`);
  lines.push('', '顯示方式：已攝取 / 今日可攝取總量。');
  lines.push('今日可攝取總量＝BMR × 1.2＋運動消耗，皆為估算。');
  return lines.join('\n');
}

function buildRankingFlexMessage_(date, isFinal, groupId) {
  const data = getRankingData_(date, groupId);
  if (!data) return { type: 'text', text: '請在要查看的群組內輸入「今日排行」。' };
  const rows = [];
  const rankedRows = data.ranked.map((item, index) => ({
    rank: ['🥇', '🥈', '🥉'][index] || String(index + 1),
    name: item.name,
    value: `${Math.round(item.intake)} / ${Math.round(item.allowance)} kcal`,
  }));
  const pendingRows = data.withoutAllowance.map(item => ({
    rank: '✅',
    name: item.name,
    value: `${Math.round(item.intake)} / 待設定`,
  }));
  const displayRows = rankedRows.concat(pendingRows).slice(0, 20);

  if (displayRows.length) {
    rows.push({
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: [
        {
          type: 'box', layout: 'vertical', flex: 0, width: '36px',
          contents: [{ type: 'text', text: '名次', size: 'xs', color: '#8B8172' }],
        },
        { type: 'text', text: '成員', size: 'xs', color: '#8B8172', flex: 4 },
        { type: 'text', text: '已攝取 / 今日額度', size: 'xs', color: '#8B8172', flex: 6, align: 'end' },
      ],
    });
    rows.push({ type: 'separator', color: '#E8DFCF', margin: 'sm' });
    displayRows.forEach((row, index) => {
      rows.push({
        type: 'box',
        layout: 'horizontal',
        alignItems: 'center',
        spacing: 'sm',
        margin: index ? 'sm' : 'md',
        contents: [
          {
            type: 'box', layout: 'vertical', flex: 0, width: '36px',
            contents: [{ type: 'text', text: row.rank, size: 'sm', weight: 'bold', color: '#5A5144' }],
          },
          { type: 'text', text: cleanText_(row.name, 40), size: 'sm', weight: 'bold', color: '#302B25', flex: 4, maxLines: 1, adjustMode: 'shrink-to-fit' },
          { type: 'text', text: row.value, size: 'sm', color: '#302B25', flex: 6, align: 'end', maxLines: 1, adjustMode: 'shrink-to-fit' },
        ],
      });
    });
  } else {
    rows.push({ type: 'text', text: '目前還沒有人完成打卡。', size: 'md', weight: 'bold', color: '#5A5144', wrap: true });
    rows.push({ type: 'text', text: '在群組或私訊輸入「打卡」即可開始。', size: 'sm', color: '#8B8172', wrap: true, margin: 'sm' });
  }

  const status = [];
  if (data.inProgressLogs.length) {
    status.push({
      type: 'text',
      text: `📝 打卡中：${data.inProgressLogs.map(log => log.name).join('、')}`,
      size: 'sm',
      color: '#4F765E',
      wrap: true,
    });
  }
  if (data.missing.length) {
    status.push({
      type: 'text',
      text: `⏳ 尚未開始：${data.missing.join('、')}`,
      size: 'sm',
      color: '#8B8172',
      wrap: true,
      margin: status.length ? 'sm' : 'none',
    });
  }

  return {
    type: 'flex',
    altText: `${date} ${data.groupName} ${isFinal ? '最終' : '今日'}攝取進度`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '18px',
        backgroundColor: '#F8D86A',
        contents: [
          { type: 'text', text: isFinal ? '🏁 最終攝取進度' : '🏆 今日攝取進度', size: 'lg', weight: 'bold', color: '#302B25' },
          { type: 'text', text: `${date}｜${data.groupName}`, size: 'sm', color: '#665B45', margin: 'sm', wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: rows.concat([
          { type: 'separator', color: '#E8DFCF', margin: 'lg' },
          {
            type: 'box',
            layout: 'horizontal',
            margin: 'md',
            contents: [
              { type: 'text', text: '完成進度', size: 'sm', color: '#8B8172', flex: 1 },
              { type: 'text', text: `${data.completedCount} / ${data.members.length} 人`, size: 'sm', weight: 'bold', color: '#302B25', align: 'end', flex: 1 },
            ],
          },
        ]).concat(status).concat([
          { type: 'separator', color: '#E8DFCF', margin: 'lg' },
          { type: 'text', text: '數字為「已攝取 / 今日可攝取總量」', size: 'xs', color: '#8B8172', wrap: true, margin: 'md' },
          { type: 'text', text: '今日總量＝BMR × 1.2＋運動消耗（估算）', size: 'xs', color: '#A09789', wrap: true, margin: 'xs' },
        ]).concat(isFinal ? [
          { type: 'text', text: '☀️ 新的一天開始了，今天也記得輸入「打卡」喔！', size: 'xs', color: '#4F765E', wrap: true, margin: 'md' },
        ] : []),
      },
    },
  };
}

function rankingMessagesForSource_(source, userId) {
  source = source || {};
  if (source.type === 'group' && source.groupId) {
    const group = getGroupById_(source.groupId);
    if (!group || !group.enabled) {
      return [{ type: 'text', text: '這個群組尚未啟用排行榜，請先輸入「啟用排行」。' }];
    }
    return [buildRankingFlexMessage_(today_(), false, source.groupId)];
  }

  const groupIds = getActiveGroupIdsForUser_(userId);
  const groups = getEnabledGroups_().filter(group => groupIds.includes(group.groupId));
  if (!groups.length) {
    return [{ type: 'text', text: '你目前沒有加入已啟用排行的群組，請到群組內輸入「啟用排行」。' }];
  }
  return groups.slice(0, 5).map(group => buildRankingFlexMessage_(today_(), false, group.groupId));
}

function getTodayLogs_() {
  return getLogsForDate_(today_());
}

function getLogsForDate_(date) {
  const cacheKey = `logs-for-date:v4:${String(date || '')}`;
  const cached = readJsonCache_(cacheKey);
  if (Array.isArray(cached)) return cached;

  const sheet = getSheet_(APP.sheets.logs);
  ensureLogStatusHeader_(sheet);
  if (sheet.getLastRow() < 2) return [];
  const range = sheet.getRange(2, 1, sheet.getLastRow() - 1, APP.headers.logs.length);
  const values = range.getValues();
  const logs = values
    .filter(row => getLogRowDateKey_(row, null) === date)
    .map(row => ({
      userId: String(row[2] || ''),
      name: String(row[3] || ''),
      intake: Number(row[9] || 0),
      allowance: row[15] === ''
        ? Number(row[9] || 0) + Number(row[16] || 0)
        : Number(row[15]),
      deficit: row[16] === '' ? null : Number(row[16]),
      isComplete: isLogComplete_(row[20]),
    }))
    .filter(log => log.userId);
  const latestByUser = new Map();
  logs.forEach(log => latestByUser.set(log.userId, log));
  const result = Array.from(latestByUser.values());
  writeJsonCache_(cacheKey, result, 45);
  return result;
}

/**
 * 公開功能與群組排行完全分離：
 * - 今日紀錄牆只讀取「每日紀錄」中本人主動公開的列。
 * - 連續打卡排行只讀取「成員設定」中願意參與者的完成日期。
 */
function getPublicWallData_(viewerId, viewerSignature, selectedDate) {
  viewerId = String(viewerId || '');
  viewerSignature = String(viewerSignature || '');
  // 新版紀錄牆用 hub token；舊的 wall 連結仍可看公開區，但不會得到群組卡夾。
  const hubState = inspectAccessToken_(viewerId, viewerSignature, APP.tokenScopes.hub);
  const wallState = inspectAccessToken_(viewerId, viewerSignature, APP.tokenScopes.wall);
  const viewerValid = hubState === 'ok' || wallState === 'ok';
  const viewerCanViewGroups = hubState === 'ok';
  const today = today_();
  const date = validatePublicWallDate_(selectedDate || today);
  const base = getPublicWallBaseData_(date);
  const viewerMember = viewerValid ? getMemberById_(viewerId) : null;
  const viewerLikeKey = viewerValid ? publicLikeTargetKey_(viewerId) : '';
  const records = (base.records || []).map(item => ({
    alias: item.alias,
    intake: item.intake,
    allowance: item.allowance,
    deficit: item.deficit,
    bmr: item.bmr,
    exerciseKcal: item.exerciseKcal,
    bmrPlusExercise: item.bmrPlusExercise,
    tdeeEstimate: item.tdeeEstimate,
    proteinG: item.proteinG,
    meals: item.meals,
    mealTotals: Array.isArray(item.mealTotals) ? item.mealTotals : [],
    mealDetails: Array.isArray(item.mealDetails) ? item.mealDetails : [],
    isComplete: item.isComplete,
    updatedAt: item.updatedAt,
    likeKey: item.likeKey,
    likeCount: 0,
    likedByViewer: false,
    // 不把 LINE UserId 傳到瀏覽器；用不可逆的 likeKey 判斷自己的卡片。
    isSelf: viewerValid && item.likeKey === viewerLikeKey,
  }));
  const streaks = (base.streaks || []).map(item => ({
    alias: item.alias,
    streak: item.streak,
    completedOnDate: item.completedOnDate,
    likeKey: item.likeKey,
    likeCount: 0,
    likedByViewer: false,
    isSelf: viewerValid && item.likeKey === viewerLikeKey,
  }));

  const likeData = getPublicLikesForDate_(date, viewerValid ? viewerId : '');
  records.forEach(item => {
    item.likeCount = Number(likeData.counts[item.likeKey] || 0);
    item.likedByViewer = likeData.likedKeys.has(item.likeKey);
  });
  streaks.forEach(item => {
    item.likeCount = Number(likeData.counts[item.likeKey] || 0);
    item.likedByViewer = likeData.likedKeys.has(item.likeKey);
  });

  return {
    date,
    today,
    minDate: dateKeyDaysAgo_(today, 29),
    maxDate: today,
    generatedAt: Utilities.formatDate(new Date(), APP.timezone, 'yyyy-MM-dd HH:mm'),
    records,
    streaks,
    // 公開頁從本人 LINE 連結開啟時，提供同一位使用者的兩個入口。
    // 沒有有效觀看者憑證時不輸出私人連結，避免公開頁被直接猜網址時洩漏資料。
    nav: viewerValid && viewerMember ? {
      formUrl: getSignedFormUrl_(viewerId),
      historyUrl: getHistoryUrl_(viewerId),
    } : {},
    // 群組標籤只提供給已驗證的本人；不在前端輸出成員名單或群組 URL。
    groupTabs: viewerCanViewGroups && viewerMember ? getWallTabsForUser_(viewerId) : [],
    viewer: {
      canLike: viewerValid && Boolean(viewerMember),
      uid: viewerValid ? viewerId : '',
      sig: viewerValid ? viewerSignature : '',
      usedLikes: viewerValid ? likeData.viewerUsedLikes : 0,
      // 公開牆不限制每天可按幾個不同對象；同一位對象同一天仍只保留一個讚。
      remainingLikes: null,
      unlimitedLikes: true,
    },
    summary: {
      publicCount: records.length,
      completedCount: records.filter(record => record.isComplete).length,
      rankingCount: streaks.length,
    },
  };
}

/**
 * 公開頁的共同資料不含觀看者身分與按讚狀態，可讓所有人共用短期快取。
 * 只有第一位開啟者需要掃描紀錄表，其後開啟通常直接讀取快取。
 */
function getPublicWallBaseData_(selectedDate, members) {
  const date = validatePublicWallDate_(selectedDate || today_());
  const cacheKey = `public-wall-base:v8:${date}`;
  const cached = readJsonCache_(cacheKey);
  if (cached && Array.isArray(cached.records) && Array.isArray(cached.streaks)) {
    return cached;
  }

  members = Array.isArray(members) ? members : getMembers_();
  const memberById = new Map(members.map(member => [member.userId, member]));
  const participants = members.filter(member => member.isFriend && member.joinPublicRanking);
  const participantIds = new Set(participants.map(member => member.userId));
  const completedDatesByUser = new Map();
  participants.forEach(member => completedDatesByUser.set(member.userId, new Set()));

  const sheet = getSheet_(APP.sheets.logs);
  ensureLogStatusHeader_(sheet);
  const latestPublicByUser = new Map();
  if (sheet.getLastRow() >= 2) {
    const range = sheet.getRange(2, 1, sheet.getLastRow() - 1, APP.headers.logs.length);
    const values = range.getValues();
    values.forEach(row => {
      const userId = String(row[2] || '');
      if (!userId) return;
      const rowDate = getLogRowDateKey_(row, null);
      const complete = isLogComplete_(row[20]);
      if (complete && participantIds.has(userId) && /^\d{4}-\d{2}-\d{2}$/.test(rowDate)) {
        completedDatesByUser.get(userId).add(rowDate);
      }
      const member = memberById.get(userId);
      const isPublic = row[21] === true || String(row[21]).toUpperCase() === 'TRUE';
      if (rowDate === date && isPublic && member && member.isFriend) {
        latestPublicByUser.set(userId, row);
      }
    });
  }

  const records = Array.from(latestPublicByUser.entries()).map(([userId, row]) => {
    const member = memberById.get(userId) || {};
    const intake = Math.round(numberInRange_(row[9], 0, 100000));
    const allowance = row[15] === '' ? null : Math.round(numberInRange_(row[15], 0, 100000));
    const bmr = Math.round(numberInRange_(row[14], 0, 10000));
    const exerciseKcal = Math.round(numberInRange_(row[13], 0, 10000));
    const meals = [];
    const mealTotals = [];
    [[4, '早餐'], [5, '午餐'], [6, '晚餐'], [8, '宵夜'], [7, '點心']]
      .forEach(([column, label]) => {
        const kcal = Math.round(numberInRange_(row[column], 0, 100000));
        if (kcal > 0) {
          meals.push(label);
          mealTotals.push({ label, kcal });
        }
      });
    const publishFoodDetails = row[23] === true || String(row[23]).toUpperCase() === 'TRUE';
    return {
      userId,
      alias: publicAliasForMember_(member),
      intake,
      allowance,
      deficit: allowance === null ? null : allowance - intake,
      bmr,
      exerciseKcal,
      bmrPlusExercise: bmr > 0 ? bmr + exerciseKcal : 0,
      tdeeEstimate: bmr > 0 ? Math.round(bmr * 1.2 + exerciseKcal) : 0,
      // 蛋白質屬於食物營養資料；公開牆只有原本已選擇公開食物細項的人才顯示。
      proteinG: publishFoodDetails ? proteinGrams_(row[27]) : 0,
      meals,
      mealTotals,
      mealDetails: publishFoodDetails ? buildPublicMealDetails_(row[17]) : [],
      isComplete: isLogComplete_(row[20]),
      updatedAt: formatPublicTime_(row[19]),
      likeKey: publicLikeTargetKey_(userId),
    };
  }).sort((a, b) => {
    if (a.isComplete !== b.isComplete) return a.isComplete ? -1 : 1;
    return a.alias.localeCompare(b.alias, 'zh-Hant');
  });

  const streaks = participants.map(member => {
    const dates = completedDatesByUser.get(member.userId) || new Set();
    return {
      userId: member.userId,
      alias: publicAliasForMember_(member),
      streak: calculateCurrentStreak_(dates, date),
      completedOnDate: dates.has(date),
      likeKey: publicLikeTargetKey_(member.userId),
    };
  }).sort((a, b) => b.streak - a.streak || a.alias.localeCompare(b.alias, 'zh-Hant'));

  const publicRecordIds = new Set(records.map(record => record.userId));
  const visibleTargets = new Map();
  records.concat(streaks).forEach(item => {
    if (visibleTargets.has(item.likeKey)) return;
    const member = memberById.get(item.userId) || {};
    visibleTargets.set(item.likeKey, {
      userId: item.userId,
      isFriend: Boolean(member.isFriend),
      joinPublicRanking: Boolean(member.joinPublicRanking),
      publicRecordVisible: publicRecordIds.has(item.userId),
    });
  });
  cachePublicLikeTargets_(visibleTargets);

  const result = { records, streaks };
  writeJsonCache_(cacheKey, result, 180);
  return result;
}

/**
 * 群組紀錄牆：只有仍在指定群組內的成員，才能用自己的 form 簽章進入。
 * 這裡不沿用公開牆的按讚、排行或公開權限，避免把群組分享誤當成全體公開。
 */
function getGroupWallData_(viewerId, viewerSignature, groupId, selectedDate) {
  viewerId = String(viewerId || '');
  groupId = String(groupId || '');
  // 整合式紀錄牆使用 hub token；舊的群組專屬連結則是 form token，兩者都相容。
  const tokenState = inspectGroupWallAccessToken_(viewerId, String(viewerSignature || ''));
  if (tokenState !== 'ok') {
    return {
      error: tokenState === 'expired'
        ? '這個紀錄牆連結已過期，請回 LINE 重新開啟。'
        : '紀錄牆連結驗證失敗，請回 LINE 重新開啟。',
      invalidReason: tokenState,
      date: validatePublicWallDate_(selectedDate || today_()),
      today: today_(),
      minDate: dateKeyDaysAgo_(today_(), 29),
      maxDate: today_(),
    };
  }
  const group = getGroupById_(groupId);
  if (!group) throw new Error('找不到這個群組。');
  if (!getActiveGroupIdsForUser_(viewerId).includes(groupId)) {
    throw new Error('你目前不是這個群組的成員，無法查看群組紀錄牆。');
  }

  const date = validatePublicWallDate_(selectedDate || today_());
  const base = getGroupWallBaseData_(groupId, date);
  return {
    date,
    today: today_(),
    minDate: dateKeyDaysAgo_(today_(), 29),
    maxDate: today_(),
    generatedAt: formatPublicTime_(new Date()),
    group: { groupId: group.groupId, name: group.name, memberCount: base.memberCount },
    records: base.records.map(record => Object.assign({}, record, { isSelf: record.userId === viewerId })),
    summary: {
      memberCount: base.memberCount,
      sharedCount: base.records.length,
      completedCount: base.records.filter(record => record.isComplete).length,
    },
    nav: {
      formUrl: getSignedFormUrl_(viewerId),
      historyUrl: getHistoryUrl_(viewerId),
    },
    viewer: { uid: viewerId, sig: String(viewerSignature || '') },
  };
}

/** 群組共同資料短暫快取；快取中沒有觀看者身分、簽章、照片、體重、BMR 或備註。 */
function getGroupWallBaseData_(groupId, selectedDate) {
  groupId = String(groupId || '');
  const date = validatePublicWallDate_(selectedDate || today_());
  const cacheKey = `group-wall-base:v3:${groupId}:${date}`;
  const cached = readJsonCache_(cacheKey);
  if (cached && Array.isArray(cached.records)) return cached;

  const activeIds = new Set(getActiveGroupMemberIds_(groupId));
  const memberById = new Map(getMembers_().map(member => [member.userId, member]));
  const latestByUser = new Map();
  const sheet = getSheet_(APP.sheets.logs);
  ensureLogStatusHeader_(sheet);
  if (sheet.getLastRow() >= 2 && activeIds.size) {
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, APP.headers.logs.length).getValues();
    rows.forEach(row => {
      const userId = String(row[2] || '');
      const shared = row[26] === true || String(row[26]).toUpperCase() === 'TRUE';
      const member = memberById.get(userId);
      if (shared && activeIds.has(userId) && member && member.isFriend && getLogRowDateKey_(row, null) === date) {
        latestByUser.set(userId, row);
      }
    });
  }

  const records = Array.from(latestByUser.entries()).map(([userId, row]) => {
    const member = memberById.get(userId) || {};
    const intake = Math.round(numberInRange_(row[9], 0, 100000));
    const allowance = row[15] === '' ? null : Math.round(numberInRange_(row[15], 0, 100000));
    const meals = [];
    const mealTotals = [];
    [[4, '早餐'], [5, '午餐'], [6, '晚餐'], [8, '宵夜'], [7, '點心']].forEach(([column, label]) => {
      const kcal = Math.round(numberInRange_(row[column], 0, 100000));
      if (kcal > 0) {
        meals.push(label);
        mealTotals.push({ label, kcal });
      }
    });
    return {
      userId,
      alias: cleanText_(member.name, 40) || '群組夥伴',
      intake,
      allowance,
      deficit: allowance === null ? null : allowance - intake,
      proteinG: proteinGrams_(row[27]),
      meals,
      mealTotals,
      // 群組分享一律包含食物名稱、份量與熱量；仍不回傳照片、體重、BMR 或備註。
      mealDetails: buildPublicMealDetails_(row[17]),
      isComplete: isLogComplete_(row[20]),
      updatedAt: formatPublicTime_(row[19]),
    };
  }).sort((a, b) => {
    if (a.isComplete !== b.isComplete) return a.isComplete ? -1 : 1;
    return a.alias.localeCompare(b.alias, 'zh-Hant');
  });

  const result = { memberCount: activeIds.size, records };
  writeJsonCache_(cacheKey, result, 120);
  return result;
}

/** 以觀看者自己的 form 簽章產生群組牆網址，不能用群組共用網址取代。 */
function getGroupWallUrl_(userId, groupId) {
  userId = String(userId || '');
  groupId = String(groupId || '');
  if (!userId || !groupId) return '';
  const sig = issueAccessToken_(userId, APP.tokenScopes.form, APP.tokenTtlSeconds.form);
  return `${getWebAppExecUrl_()}?view=group&group=${encodeURIComponent(groupId)}&uid=${encodeURIComponent(userId)}&sig=${encodeURIComponent(sig)}`;
}

function getGroupWallLinksForUser_(userId) {
  const activeIds = new Set(getActiveGroupIdsForUser_(userId));
  return getGroups_()
    .filter(group => group.enabled && activeIds.has(group.groupId))
    .map(group => ({
      groupId: group.groupId,
      name: cleanText_(group.name, 80) || '我的群組',
      url: getGroupWallUrl_(userId, group.groupId),
    }));
}

/** 整合式紀錄牆的群組卡夾資料：只有名稱與 ID，不暴露成員清單。 */
function getWallTabsForUser_(userId) {
  const activeIds = new Set(getActiveGroupIdsForUser_(userId));
  return getGroups_()
    .filter(group => group.enabled && activeIds.has(group.groupId))
    .map(group => ({
      groupId: group.groupId,
      name: cleanText_(group.name, 80) || '我的群組',
    }));
}

/**
 * 將每日紀錄中的食物明細整理成公開頁需要的最小資料。
 * 不回傳照片、內部 ID、AI 信心、備註或其他可能洩漏隱私的欄位。
 */
function buildPublicMealDetails_(detailsJson) {
  const details = parseJsonObject_(detailsJson);
  const mealOrder = [
    ['breakfast', '早餐'],
    ['lunch', '午餐'],
    ['dinner', '晚餐'],
    ['lateNight', '宵夜'],
    ['snack', '點心'],
  ];

  return mealOrder.map(([mealKey, label]) => {
    const sourceItems = Array.isArray(details[mealKey]) ? details[mealKey] : [];
    const items = sourceItems.slice(0, 20).map(item => {
      const name = cleanText_(item && item.name, 60);
      const portion = cleanText_(item && item.portion, 80);
      const quantity = numberInRange_(item && item.quantity, 0, 20) || 1;
      const calories = Math.round(numberInRange_(item && item.calories, 0, 5000));
      return { name, portion, quantity, calories };
    }).filter(item => item.name && item.calories > 0);

    return { mealKey, label, items };
  }).filter(meal => meal.items.length > 0);
}

function cachePublicLikeTargets_(visibleTargets) {
  if (!(visibleTargets instanceof Map) || !visibleTargets.size) return;
  const values = {};
  visibleTargets.forEach((target, likeKey) => {
    values[`public-like-target:v2:${String(likeKey || '')}`] = JSON.stringify(target);
  });
  try {
    CacheService.getScriptCache().putAll(values, 600);
  } catch (error) {
    console.warn(`公開按讚對象快取失敗：${error && error.message ? error.message : error}`);
  }
}

function resolvePublicLikeTarget_(targetKey) {
  targetKey = String(targetKey || '');
  const cached = readJsonCache_(`public-like-target:v2:${targetKey}`);
  if (cached && cached.userId) return cached;

  const target = getMembers_().find(member => safeEqual_(publicLikeTargetKey_(member.userId), targetKey));
  if (!target) return null;
  return {
    userId: target.userId,
    isFriend: Boolean(target.isFriend),
    joinPublicRanking: Boolean(target.joinPublicRanking),
    publicRecordVisible: target.joinPublicRanking ? false : getTodayPublicFlag_(target.userId),
  };
}

/**
 * 公開牆的日期鼓勵讚。
 * 每位使用者可對當天公開頁上多位夥伴按讚；同一位夥伴同一天只保留一個讚，
 * 再點一次即可收回，也不能按自己。
 */
function likePublicParticipant(payload) {
  const startedAt = Date.now();
  payload = payload || {};
  const viewerId = String(payload.uid || '');
  const viewerSignature = String(payload.sig || '');
  const targetKey = String(payload.targetKey || '');
  const tokenState = inspectPublicWallAccessToken_(viewerId, viewerSignature);
  if (tokenState !== 'ok') {
    throw new Error(tokenState === 'expired'
      ? '這個公開頁連結已經過期了。請回 LINE 輸入「公開紀錄」重新開啟。'
      : '按讚身分驗證失敗，請回 LINE 輸入「公開紀錄」後重新開啟。');
  }

  const viewer = getMemberById_(viewerId);
  if (!viewer) throw new Error('找不到你的成員身分，請先私訊機器人「綁定」。');
  const target = resolvePublicLikeTarget_(targetKey);
  if (!target) throw new Error('找不到這位公開成員。');
  if (target.userId === viewerId) throw new Error('自己的努力自己知道，這一讚留給別人吧 😆');
  const selectedDate = validatePublicWallDate_(payload.date || today_());
  const visibleBase = getPublicWallBaseData_(selectedDate);
  const targetVisible = (visibleBase.records || []).concat(visibleBase.streaks || [])
    .some(item => safeEqual_(item.likeKey, targetKey));

  const lock = LockService.getScriptLock();
  lock.waitLock(3000);
  const lockAcquiredAt = Date.now();
  try {
    const sheet = getPublicLikesSheet_();
    const now = new Date();
    const entries = readPublicLikeEntriesForDate_(selectedDate);
    const existingEntry = entries.find(entry => (
      entry.likerId === viewerId && entry.targetId === target.userId
    ));
    const usedLikes = entries.filter(entry => entry.likerId === viewerId).length;

    // 已按讚時再點一次即收回；對方隨後隱藏時也允許完成這筆收回。
    if (existingEntry) {
      if (Number(existingEntry.rowNumber || 0) >= 2) {
        sheet.getRange(existingEntry.rowNumber, 1, 1, APP.headers.publicLikes.length).clearContent();
      }
      const nextEntries = entries.filter(entry => entry !== existingEntry);
      writePublicLikeEntriesForDate_(selectedDate, nextEntries);
      const nextUsedLikes = Math.max(0, usedLikes - 1);
      return {
        ok: true,
        liked: false,
        likeCount: nextEntries.filter(entry => entry.targetId === target.userId).length,
        usedLikes: nextUsedLikes,
        remainingLikes: null,
        targetKey,
        message: '已收回鼓勵讚，名額也退回囉 ↩️',
      };
    }

    if (!targetVisible) {
      throw new Error('這位成員目前沒有顯示在任何公開頁籤。');
    }
    const newRowNumber = sheet.getLastRow() + 1;
    sheet.getRange(newRowNumber, 1, 1, APP.headers.publicLikes.length)
      .setValues([[selectedDate, viewerId, target.userId, now, now]]);
    entries.push({ likerId: viewerId, targetId: target.userId, rowNumber: newRowNumber });
    writePublicLikeEntriesForDate_(selectedDate, entries);
    const likeCount = entries.filter(entry => entry.targetId === target.userId).length;
    return {
      ok: true,
      liked: true,
      likeCount,
      usedLikes: usedLikes + 1,
      remainingLikes: null,
      targetKey,
      message: '鼓勵讚已送出 👍',
    };
  } finally {
    lock.releaseLock();
    console.log(`公開按讚效能：等待鎖 ${lockAcquiredAt - startedAt} ms，總計 ${Date.now() - startedAt} ms`);
  }
}

function getPublicLikesForDate_(date, viewerId) {
  const result = { counts: {}, likedKeys: new Set(), viewerUsedLikes: 0 };
  const entries = readPublicLikeEntriesForDate_(date);
  entries.forEach(entry => {
    const likerId = entry.likerId;
    const targetId = entry.targetId;
    if (!targetId) return;
    const key = publicLikeTargetKey_(targetId);
    result.counts[key] = Number(result.counts[key] || 0) + 1;
    if (viewerId && likerId === viewerId) {
      result.likedKeys.add(key);
      result.viewerUsedLikes += 1;
    }
  });
  return result;
}

/**
 * 按讚資料依建立順序往下追加，所以從工作表尾端分批讀取今日資料即可。
 * 避免每按一讚都掃描整張歷史工作表。
 */
function readPublicLikeEntriesForDate_(date) {
  const cacheKey = `public-likes-date:v5:${String(date || '')}`;
  const cached = readJsonCache_(cacheKey);
  if (Array.isArray(cached)) return cached;

  const sheet = getPublicLikesSheet_();
  const entries = [];
  let cursor = sheet.getLastRow();
  const batchSize = 200;
  while (cursor >= 2) {
    const startRow = Math.max(2, cursor - batchSize + 1);
    const rowCount = cursor - startRow + 1;
    const rows = sheet.getRange(startRow, 1, rowCount, APP.headers.publicLikes.length).getValues();
    rows.forEach((row, index) => {
      if (normalizeDateKey_(row[0]) !== date) return;
      const likerId = String(row[1] || '');
      const targetId = String(row[2] || '');
      if (likerId && targetId) entries.push({ likerId, targetId, rowNumber: startRow + index });
    });

    // 若這批最早一列已不是當天，更前面也不會有當天追加的讚。
    if (startRow === 2 || normalizeDateKey_(rows[0] && rows[0][0]) !== date) break;
    cursor = startRow - 1;
  }
  writePublicLikeEntriesForDate_(date, entries);
  return entries;
}

function writePublicLikeEntriesForDate_(date, entries) {
  writeJsonCache_(`public-likes-date:v5:${String(date || '')}`, entries || [], 600);
}

function getPublicLikesSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(APP.sheets.publicLikes);
  if (!sheet) {
    sheet = ss.insertSheet(APP.sheets.publicLikes);
    sheet.getRange(1, 1, 1, APP.headers.publicLikes.length).setValues([APP.headers.publicLikes]);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, APP.headers.publicLikes.length).setValues([APP.headers.publicLikes]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function publicLikeTargetKey_(userId) {
  return opaqueId_(`public-like:${String(userId || '')}`);
}

function publicAliasForMember_(member) {
  return cleanText_((member && member.publicAlias) || '', 40) || '飲控夥伴';
}

function calculateCurrentStreak_(completedDates, today) {
  if (!(completedDates instanceof Set) || !completedDates.size) return 0;
  let cursor = completedDates.has(today) ? today : shiftDateKey_(today, -1);
  let streak = 0;
  while (completedDates.has(cursor) && streak < 3660) {
    streak += 1;
    cursor = shiftDateKey_(cursor, -1);
  }
  return streak;
}

function shiftDateKey_(dateKey, days) {
  const matched = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) return '';
  const date = new Date(Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])));
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return Utilities.formatDate(date, 'UTC', 'yyyy-MM-dd');
}

function formatPublicTime_(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return '';
  return Utilities.formatDate(value, APP.timezone, 'HH:mm');
}

function getTodayPublicFlag_(userId) {
  userId = String(userId || '');
  if (!userId) return false;
  const sheet = getSheet_(APP.sheets.logs);
  ensureLogStatusHeader_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const rowCount = Math.min(lastRow - 1, 100);
  const startRow = lastRow - rowCount + 1;
  const rows = sheet.getRange(startRow, 1, rowCount, APP.headers.logs.length).getValues();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (String(rows[index][2] || '') !== userId) continue;
    if (getLogRowDateKey_(rows[index], null) !== today_()) continue;
    return rows[index][21] === true || String(rows[index][21]).toUpperCase() === 'TRUE';
  }
  return false;
}

function revokeTodayPublicRecord_(userId) {
  userId = String(userId || '');
  if (!userId) return;
  const sheet = getSheet_(APP.sheets.logs);
  ensureLogStatusHeader_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const rowCount = Math.min(lastRow - 1, 100);
  const startRow = lastRow - rowCount + 1;
  const rows = sheet.getRange(startRow, 1, rowCount, APP.headers.logs.length).getValues();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (String(rows[index][2] || '') !== userId) continue;
    if (getLogRowDateKey_(rows[index], null) !== today_()) continue;
    sheet.getRange(startRow + index, 22, 1, 2).setValues([[false, '']]);
    invalidateLogCache_(today_(), userId);
    return;
  }
}

function getTodayFormData_(userId, foods) {
  return getDailyFormData_(userId, foods, today_());
}

function getRecentDailyFormData_(userId, foods, recordDates) {
  const dates = (Array.isArray(recordDates) ? recordDates : allowedRecordDates_())
    .map(validateRecordDate_);
  const result = {};
  dates.forEach(date => { result[date] = null; });
  if (!dates.length) return result;

  const sheet = getSheet_(APP.sheets.logs);
  ensureLogStatusHeader_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return result;

  const wantedDates = new Set(dates);
  const foundDates = new Set();
  // 四天補登範圍一次最多讀 500 列，比分別讀四次更快。
  const rowCount = Math.min(lastRow - 1, 500);
  const startRow = lastRow - rowCount + 1;
  const rows = sheet.getRange(startRow, 1, rowCount, APP.headers.logs.length).getValues();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (String(row[2] || '') !== String(userId)) continue;
    const date = getLogRowDateKey_(row, null);
    if (!wantedDates.has(date) || foundDates.has(date)) continue;
    result[date] = dailyFormDataFromRow_(row, foods, date);
    foundDates.add(date);
    if (foundDates.size === wantedDates.size) break;
  }
  return result;
}

function getDailyFormData_(userId, foods, recordDate) {
  recordDate = validateRecordDate_(recordDate);
  const sheet = getSheet_(APP.sheets.logs);
  ensureLogStatusHeader_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  // 每人每天只有一列；只讀最近 100 列，避免紀錄累積後每次開頁都掃完整張表。
  const rowCount = Math.min(lastRow - 1, 100);
  const startRow = lastRow - rowCount + 1;
  const range = sheet.getRange(startRow, 1, rowCount, APP.headers.logs.length);
  const values = range.getValues();
  let savedRow = null;

  for (let index = values.length - 1; index >= 0; index -= 1) {
    const row = values[index];
    if (String(row[2] || '') !== String(userId)) continue;
    if (getLogRowDateKey_(row, null) !== recordDate) continue;
    savedRow = row;
    break;
  }
  if (!savedRow) return null;

  return dailyFormDataFromRow_(savedRow, foods, recordDate);
}

function dailyFormDataFromRow_(savedRow, foods, recordDate) {
  let selectedDetails = {};
  try {
    selectedDetails = JSON.parse(String(savedRow[17] || '{}')) || {};
  } catch (error) {
    console.warn(`${recordDate} 食物明細無法解析，將使用各餐總熱量還原：${error.message || error}`);
    selectedDetails = {};
  }

  const mealKeys = ['breakfast', 'lunch', 'dinner', 'lateNight', 'snack'];
  const mealColumns = { breakfast: 4, lunch: 5, dinner: 6, lateNight: 8, snack: 7 };
  const foodIds = new Set((foods || []).map(food => String(food.id)));
  const meals = { breakfast: [], lunch: [], dinner: [], lateNight: [], snack: [] };
  const aiMeals = { breakfast: [], lunch: [], dinner: [], lateNight: [], snack: [] };

  mealKeys.forEach(mealKey => {
    const details = Array.isArray(selectedDetails[mealKey]) ? selectedDetails[mealKey] : [];
    details.forEach((item, index) => {
      const id = String(item.id || '');
      const calories = Math.round(numberInRange_(item.calories, 0, 5000));
      if (item.source !== 'gemini' && id && foodIds.has(id)) {
        meals[mealKey].push({
          id,
          quantity: numberInRange_(item.quantity, 0, 20) || 1,
        });
        return;
      }
      if (!calories) return;
      const source = item.source === 'manual' ? 'manual' : 'gemini';
      aiMeals[mealKey].push({
        id: id || `restored_${mealKey}_${index + 1}`,
        source,
        name: cleanText_(item.name, 60) || '先前照片紀錄',
        portion: cleanText_(item.portion, 80) || '由今日紀錄還原',
        grams: Math.round(numberInRange_(item.grams, 0, 3000)),
        amount: Math.round(numberInRange_(item.amount, 0, 5000)),
        baseAmount: Math.round(numberInRange_(item.baseAmount, 0, 5000)),
        unit: String(item.unit || '').toLowerCase() === 'ml' ? 'ml' : 'g',
        baseCalories: Math.round(numberInRange_(item.baseCalories, 0, 5000)),
        baseLow: Math.round(numberInRange_(item.baseLow, 0, 5000)),
        baseHigh: Math.round(numberInRange_(item.baseHigh, 0, 5000)),
        baseProteinG: proteinGrams_(item.baseProteinG),
        proteinG: proteinGrams_(item.proteinG),
        calories,
        low: calories,
        high: calories,
        confidence: source === 'manual'
          ? ''
          : (['高', '中', '低'].includes(item.confidence) ? item.confidence : '低'),
        notes: cleanText_(item.notes, 200),
      });
    });

    if (!meals[mealKey].length && !aiMeals[mealKey].length) {
      const savedTotal = Math.round(numberInRange_(savedRow[mealColumns[mealKey]], 0, 10000));
      if (savedTotal) {
        aiMeals[mealKey].push({
          id: `restored_total_${mealKey}`,
          name: `${mealLabelForKey_(mealKey)}先前紀錄`,
          portion: '細項無法還原，可自行調整熱量',
          grams: 0,
          calories: savedTotal,
          low: savedTotal,
          high: savedTotal,
          confidence: '低',
          notes: '',
        });
      }
    }
  });

  return {
    exists: true,
    meals,
    aiMeals,
    extraKcal: 0,
    waterMl: Math.round(numberInRange_(savedRow[10], 0, 10000)),
    waterGoalMl: Math.round(numberInRange_(savedRow[25], 500, 10000)),
    waterEnabled: savedRow[25] !== '' && savedRow[25] !== null,
    exerciseName: cleanText_(savedRow[11], 80),
    exerciseMinutes: Math.round(numberInRange_(savedRow[12], 0, 1440)),
    exerciseKcal: Math.round(numberInRange_(savedRow[13], 0, 5000)),
    exerciseRecords: parseExerciseRecords_(savedRow[24], savedRow[11], savedRow[12], savedRow[13]),
    note: cleanText_(savedRow[18], 500),
    isComplete: isLogComplete_(savedRow[20]),
    isPublic: savedRow[21] === true || String(savedRow[21]).toUpperCase() === 'TRUE',
    publishFoodDetails: savedRow[23] === true || String(savedRow[23]).toUpperCase() === 'TRUE',
    isGroupPublic: savedRow[26] === true || String(savedRow[26]).toUpperCase() === 'TRUE',
    totalProteinG: proteinGrams_(savedRow[27]),
  };
}

function parseExerciseRecords_(json, legacyName, legacyMinutes, legacyKcal) {
  let records = [];
  try {
    const parsed = JSON.parse(String(json || '[]'));
    if (Array.isArray(parsed)) records = parsed;
  } catch (error) {
    records = [];
  }
  records = records.map(record => ({
    type: cleanText_(record && record.type, 30),
    name: cleanText_(record && record.name, 60),
    minutes: Math.round(numberInRange_(record && record.minutes, 0, 1440)),
    kcal: Math.round(numberInRange_(record && (record.kcal !== undefined ? record.kcal : record.calories), 0, 10000)),
    kcalMode: record && record.kcalMode === 'manual' ? 'manual' : 'auto',
  })).filter(record => record.name || record.minutes || record.kcal);
  if (!records.length) {
    const legacy = {
      type: '',
      name: cleanText_(legacyName, 60),
      minutes: Math.round(numberInRange_(legacyMinutes, 0, 1440)),
      kcal: Math.round(numberInRange_(legacyKcal, 0, 10000)),
      kcalMode: 'manual',
    };
    if (legacy.name || legacy.minutes || legacy.kcal) records.push(legacy);
  }
  return records;
}

/** 只讀取本人最近一段時間的每日紀錄，供歷史頁使用。 */
function getHistoryData_(userId, dayCount) {
  userId = String(userId || '');
  const days = Math.min(365, Math.max(7, Number(dayCount) || 30));
  const cacheKey = `history:v3:${userId}:${days}:${today_()}`;
  const cached = readJsonCache_(cacheKey);
  if (cached) return cached;

  const today = today_();
  const firstDate = dateDaysAgo_(days - 1);
  const sheet = getSheet_(APP.sheets.logs);
  ensureLogStatusHeader_(sheet);
  const waterSettings = getWaterSettings_(userId);
  const latestByDate = new Map();
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    // 週／月總覽最多讀一年。多人共用表格時，1000 列通常不足以涵蓋完整月份，
    // 因此保留最近 20000 列，再依 UserId 與日期縮小成個人資料。
    const rowCount = Math.min(lastRow - 1, 20000);
    const startRow = lastRow - rowCount + 1;
    const rows = sheet.getRange(startRow, 1, rowCount, APP.headers.logs.length).getValues();
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (String(row[2] || '') !== userId) continue;
      const date = getLogRowDateKey_(row, null);
      if (!date || date < firstDate || date > today || latestByDate.has(date)) continue;
      latestByDate.set(date, row);
    }
  }

  const records = Array.from(latestByDate.keys()).sort().reverse().map(date => {
    const row = latestByDate.get(date);
    const waterMl = Math.round(numberInRange_(row[10], 0, 20000));
    const storedWaterGoalMl = Math.round(numberInRange_(row[25], 500, 10000));
    // v44 以前沒有逐日目標欄位；若舊紀錄確實有喝水數字，暫用目前目標補足顯示。
    const waterGoalMl = storedWaterGoalMl || (waterMl > 0 && waterSettings.enabled ? waterSettings.goalMl : 0);
    return {
      date,
      intake: Math.round(numberInRange_(row[9], 0, 20000)),
      tdee: Math.round(numberInRange_(row[15], 0, 20000)),
      deficit: Math.round(numberInRange_(row[16], -20000, 20000)),
      exerciseKcal: Math.round(numberInRange_(row[13], 0, 10000)),
      exerciseMinutes: Math.round(numberInRange_(row[12], 0, 1440)),
      exerciseName: cleanText_(row[11], 80),
      proteinG: proteinGrams_(row[27]),
      waterMl,
      waterGoalMl,
      waterTracked: waterGoalMl > 0 && (storedWaterGoalMl > 0 || waterMl > 0),
      status: isLogComplete_(row[20]) ? '完成' : '打卡中',
      meals: historyMealTotals_(row[17], [row[4], row[5], row[6], row[8], row[7]]),
    };
  });

  const completedDays = records.filter(record => record.status === '完成').length;
  // 平均只計入「已完成」的日子；補登前幾天或尚在打卡中的暫存，不會拉低平均。
  const completedRecords = records.filter(record => record.status === '完成');
  const average = key => completedRecords.length
    ? Math.round(completedRecords.reduce((sum, record) => sum + Number(record[key] || 0), 0) / completedRecords.length)
    : 0;
  const result = {
    valid: true,
    today,
    days,
    records,
    summary: {
      loggedDays: records.length,
      completedDays,
      averageIntake: average('intake'),
      averageTdee: average('tdee'),
      averageDeficit: average('deficit'),
      averageBasis: '完成日',
    },
  };
  writeJsonCache_(cacheKey, result, 60);
  return result;
}

function historyMealTotals_(detailsJson, fallbackTotals) {
  const definitions = [
    ['breakfast', '早餐'], ['lunch', '午餐'], ['dinner', '晚餐'],
    ['lateNight', '宵夜'], ['snack', '點心'],
  ];
  let details = {};
  try { details = JSON.parse(String(detailsJson || '{}')) || {}; } catch (error) { details = {}; }
  return definitions.map((definition, index) => {
    const items = Array.isArray(details[definition[0]]) ? details[definition[0]] : [];
    const detailKcal = items.reduce((sum, item) => sum + numberInRange_(item && item.calories, 0, 10000), 0);
    const kcal = Math.round(detailKcal || numberInRange_(fallbackTotals[index], 0, 10000));
    const names = items.map(item => cleanText_(item && item.name, 60)).filter(Boolean).slice(0, 5);
    return { key: definition[0], label: definition[1], kcal, names };
  }).filter(meal => meal.kcal > 0 || meal.names.length > 0);
}

/**
 * 新版在「每日紀錄」最後增加狀態與運動明細欄。
 * 舊紀錄的狀態為空白，為了相容舊資料會視為已完成。
 */
function ensureLogStatusHeader_(sheet) {
  const cache = CacheService.getScriptCache();
  if (cache.get('log-headers:v8') === 'ok') return;
  const current = sheet.getRange(1, 1, 1, APP.headers.logs.length).getValues()[0];
  let changed = false;
  APP.headers.logs.forEach((header, index) => {
    if (String(current[index] || '') === header) return;
    sheet.getRange(1, index + 1).setValue(header);
    changed = true;
  });
  if (changed) {
    sheet.getRange(1, 1, 1, APP.headers.logs.length)
      .setBackground('#F5D77A')
      .setFontWeight('bold')
      .setHorizontalAlignment('center');
  }
  cache.put('log-headers:v8', 'ok', 21600);
}

function isLogComplete_(value) {
  const status = String(value == null ? '' : value).trim().toLowerCase();
  if (!status) return true;
  return ['完成', 'complete', 'completed', 'true', '1'].includes(status);
}

function mealLabelForKey_(mealKey) {
  return ({ breakfast: '早餐', lunch: '午餐', dinner: '晚餐', lateNight: '宵夜', snack: '點心' })[mealKey] || '餐點';
}

function upsertDailyRow_(date, userId, row) {
  const sheet = getSheet_(APP.sheets.logs);
  ensureLogStatusHeader_(sheet);
  const cache = CacheService.getScriptCache();
  const cacheKey = `daily-row:${date}:${userId}`;
  const lastRow = sheet.getLastRow();
  const cachedRow = Number(cache.get(cacheKey) || 0);
  if (cachedRow >= 2 && cachedRow <= lastRow) {
    const cachedKeys = sheet.getRange(cachedRow, 2, 1, 2).getValues()[0];
    if (normalizeDateKey_(cachedKeys[0]) === date && String(cachedKeys[1]) === userId) {
      sheet.getRange(cachedRow, 2).setNumberFormat('@');
      sheet.getRange(cachedRow, 1, 1, row.length).setValues([row]);
      invalidateLogCache_(date, userId);
      return;
    }
    cache.remove(cacheKey);
  }
  if (lastRow >= 2) {
    const rowCount = Math.min(lastRow - 1, 100);
    const startRow = lastRow - rowCount + 1;
    const keys = sheet.getRange(startRow, 2, rowCount, 2).getValues();
    let index = -1;
    for (let i = keys.length - 1; i >= 0; i -= 1) {
      if (normalizeDateKey_(keys[i][0]) === date && String(keys[i][1]) === userId) {
        index = i;
        break;
      }
    }
    if (index >= 0) {
      const rowNumber = startRow + index;
      sheet.getRange(rowNumber, 2).setNumberFormat('@');
      sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
      cache.put(cacheKey, String(rowNumber), 21600);
      invalidateLogCache_(date, userId);
      return;
    }
  }
  const nextRow = lastRow + 1;
  sheet.getRange(nextRow, 2).setNumberFormat('@');
  sheet.getRange(nextRow, 1, 1, row.length).setValues([row]);
  cache.put(cacheKey, String(nextRow), 21600);
  invalidateLogCache_(date, userId);
}

function getMembers_() {
  const cached = readJsonCache_('members:v6');
  if (Array.isArray(cached)) return cached;
  const sheet = getSheet_(APP.sheets.members);
  ensureMemberGroupHeader_(sheet);
  if (sheet.getLastRow() < 2) return [];
  const members = sheet.getRange(2, 1, sheet.getLastRow() - 1, APP.headers.members.length).getValues()
    .filter(row => row[0])
    .map(row => ({
      userId: String(row[0]),
      name: String(row[1] || '成員'),
      bmr: row[2] === '' ? '' : Number(row[2]),
      // 體重只在使用者裝置端暫存，用來估算運動熱量，不再從試算表讀出。
      weightKg: '',
      heightCm: row[4] === '' ? '' : Number(row[4]),
      age: row[5] === '' ? '' : Number(row[5]),
      sex: String(row[6] || ''),
      isFriend: row[7] === true || String(row[7]).toUpperCase() === 'TRUE',
      inGroup: row[10] === true || String(row[10]).toUpperCase() === 'TRUE',
      publicAlias: String(row[11] || ''),
      joinPublicRanking: row[12] === true || String(row[12]).toUpperCase() === 'TRUE',
      defaultPublishToday: row[13] === true || String(row[13]).toUpperCase() === 'TRUE',
      defaultPublishFoodDetails: row[14] === true || String(row[14]).toUpperCase() === 'TRUE',
      // 新欄位留白時視為預設開啟；只有明確寫入 FALSE 才會關閉。
      personalReminder: row[15] === '' || row[15] === null
        ? true
        : (row[15] === true || String(row[15]).toUpperCase() === 'TRUE'),
      // 舊好友新增欄位留白時一律視為開啟，避免升版後突然收不到通知。
      reminderMorning: row[16] === '' || row[16] === null
        ? true
        : (row[16] === true || String(row[16]).toUpperCase() === 'TRUE'),
      reminderNoon: row[17] === '' || row[17] === null
        ? true
        : (row[17] === true || String(row[17]).toUpperCase() === 'TRUE'),
      reminderEvening: row[18] === '' || row[18] === null
        ? true
        : (row[18] === true || String(row[18]).toUpperCase() === 'TRUE'),
      // 舊資料沒有群組分享偏好時，預設不分享，避免升版後意外公開舊紀錄。
      defaultPublishToGroup: row[20] === true || String(row[20]).toUpperCase() === 'TRUE',
    }));
  writeJsonCache_('members:v6', members, 180);
  return members;
}

function getPersonalReminderSettings_(member) {
  member = member || {};
  const master = member.personalReminder !== false;
  return {
    morning: master && member.reminderMorning !== false,
    noon: master && member.reminderNoon !== false,
    evening: master && member.reminderEvening !== false,
  };
}

/** 打卡頁儲存個人提醒偏好；只允許本人有效連結修改。 */
function savePersonalReminderSettings(payload) {
  payload = payload || {};
  const userId = String(payload.uid || '');
  const sig = String(payload.sig || '');
  const tokenState = inspectAccessToken_(userId, sig, APP.tokenScopes.form);
  if (tokenState !== 'ok') throw new Error(accessTokenErrorMessage_(tokenState));
  const current = getMemberById_(userId) || {};
  const settings = payload.settings || {};
  const morning = Boolean(settings.morning);
  const noon = Boolean(settings.noon);
  const evening = Boolean(settings.evening);
  upsertMember_({
    userId,
    name: current.name || '成員',
    isFriend: true,
    personalReminder: morning || noon || evening,
    reminderMorning: morning,
    reminderNoon: noon,
    reminderEvening: evening,
    // 主動關閉資料表內已淘汰的 23:00 欄位。
    reminderLate: false,
  });
  return {
    ok: true,
    settings: { morning, noon, evening },
  };
}

function ensureMemberGroupHeader_(sheet) {
  const cache = CacheService.getScriptCache();
  // v6 會補上群組牆長期分享偏好欄位。
  if (cache.get('member-headers:v6') === 'ok') return;
  const current = sheet.getRange(1, 1, 1, APP.headers.members.length).getValues()[0];
  APP.headers.members.forEach((header, index) => {
    if (String(current[index] || '') !== header) sheet.getRange(1, index + 1).setValue(header);
  });
  sheet.getRange(1, 1, 1, APP.headers.members.length)
    .setBackground('#F5D77A')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  initializePublicDefaultsFromLogs_(sheet);
  initializeGroupWallDefaultsFromLogs_(sheet);
  cache.put('member-headers:v6', 'ok', 21600);
}

/**
 * 隱私遷移：舊版曾把 BMR 計算用的體重寫入「成員設定」D 欄。
 * 新版體重只留在使用者裝置端，因此第一次執行 setupProject 時清除舊欄位。
 */
function migrateStoredWeightPrivacy_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('WEIGHT_PRIVACY_MIGRATED') === '1') return;
  const sheet = getSheet_(APP.sheets.members);
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 4, sheet.getLastRow() - 1, 1).clearContent();
  }
  CacheService.getScriptCache().remove('members:v4');
  CacheService.getScriptCache().remove('members:v5');
  CacheService.getScriptCache().remove('members:v6');
  props.setProperty('WEIGHT_PRIVACY_MIGRATED', '1');
}

/**
 * 只在新增永久公開偏好欄位時初始化一次。
 * 曾公開過的人沿用最近一次「公開紀錄」的餐點細項設定；之後以成員欄位為準，
 * 使用者主動關閉後不會再被歷史紀錄打開。
 */
function initializePublicDefaultsFromLogs_(memberSheet) {
  const memberCount = memberSheet.getLastRow() - 1;
  if (memberCount <= 0) return;

  const preferenceRange = memberSheet.getRange(2, 14, memberCount, 2);
  const preferences = preferenceRange.getValues();
  if (!preferences.some(row => row[0] === '' || row[1] === '')) return;

  const latestPublishedByUser = new Map();
  const logSheet = getSheet_(APP.sheets.logs);
  ensureLogStatusHeader_(logSheet);
  if (logSheet.getLastRow() >= 2) {
    const logRows = logSheet
      .getRange(2, 1, logSheet.getLastRow() - 1, APP.headers.logs.length)
      .getValues();
    for (let index = logRows.length - 1; index >= 0; index -= 1) {
      const row = logRows[index];
      const userId = String(row[2] || '');
      if (!userId || latestPublishedByUser.has(userId)) continue;
      const isPublic = row[21] === true || String(row[21]).toUpperCase() === 'TRUE';
      if (!isPublic) continue;
      latestPublishedByUser.set(userId, {
        publishToday: true,
        publishFoodDetails: row[23] === true || String(row[23]).toUpperCase() === 'TRUE',
      });
    }
  }

  const userIds = memberSheet.getRange(2, 1, memberCount, 1).getValues();
  let changed = false;
  preferences.forEach((row, index) => {
    const previous = latestPublishedByUser.get(String(userIds[index][0] || '')) || {
      publishToday: false,
      publishFoodDetails: false,
    };
    if (row[0] === '') {
      row[0] = previous.publishToday;
      changed = true;
    }
    if (row[1] === '') {
      const publicEnabled = row[0] === true || String(row[0]).toUpperCase() === 'TRUE';
      row[1] = publicEnabled && previous.publishFoodDetails;
      changed = true;
    }
  });
  if (changed) preferenceRange.setValues(preferences);
}

/** 升版時，保留使用者最近一次群組分享選擇；沒有任何紀錄則預設不分享。 */
function initializeGroupWallDefaultsFromLogs_(memberSheet) {
  const memberCount = memberSheet.getLastRow() - 1;
  if (memberCount <= 0) return;
  const preferenceRange = memberSheet.getRange(2, 21, memberCount, 1);
  const preferences = preferenceRange.getValues();
  if (!preferences.some(row => row[0] === '' || row[0] === null)) return;

  const latestByUser = new Map();
  const logSheet = getSheet_(APP.sheets.logs);
  ensureLogStatusHeader_(logSheet);
  if (logSheet.getLastRow() >= 2) {
    const logRows = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, APP.headers.logs.length).getValues();
    for (let index = logRows.length - 1; index >= 0; index -= 1) {
      const row = logRows[index];
      const userId = String(row[2] || '');
      if (!userId || latestByUser.has(userId)) continue;
      latestByUser.set(userId, row[26] === true || String(row[26]).toUpperCase() === 'TRUE');
    }
  }
  const userIds = memberSheet.getRange(2, 1, memberCount, 1).getValues();
  let changed = false;
  preferences.forEach((row, index) => {
    if (row[0] !== '' && row[0] !== null) return;
    row[0] = Boolean(latestByUser.get(String(userIds[index][0] || '')));
    changed = true;
  });
  if (changed) preferenceRange.setValues(preferences);
}

function ensureGroupSheets_() {
  const cache = CacheService.getScriptCache();
  if (cache.get('group-sheets:v2') === 'ok') return;
  ensureSheet_(APP.sheets.groups, APP.headers.groups);
  ensureSheet_(APP.sheets.groupMembers, APP.headers.groupMembers);
  cache.put('group-sheets:v2', 'ok', 21600);
}

function getGroups_() {
  ensureGroupSheets_();
  const cached = readJsonCache_('groups:v3');
  if (Array.isArray(cached)) return cached;
  const sheet = getSheet_(APP.sheets.groups);
  if (sheet.getLastRow() < 2) return [];
  const groups = sheet.getRange(2, 1, sheet.getLastRow() - 1, APP.headers.groups.length).getValues()
    .filter(row => row[0])
    .map(row => ({
      groupId: String(row[0]),
      name: String(row[1] || '未命名群組'),
      enabled: row[2] === true || String(row[2]).toUpperCase() === 'TRUE',
      // 舊資料沒有類型，一律視為 LINE 群組，確保原有群組功能不受影響。
      type: String(row[5] || 'line_group') === 'space' ? 'space' : 'line_group',
      ownerUserId: String(row[6] || ''),
      inviteCode: String(row[7] || ''),
      inviteExpiresAt: row[8] || '',
    }));
  writeJsonCache_('groups:v3', groups, 300);
  return groups;
}

function getEnabledGroups_() {
  return getGroups_().filter(group => group.enabled);
}

function getGroupById_(groupId) {
  groupId = String(groupId || '');
  return getGroups_().find(group => group.groupId === groupId) || null;
}

function isCheckInSpace_(group) {
  return Boolean(group && group.type === 'space');
}

function getEnabledLineGroups_() {
  return getEnabledGroups_().filter(group => !isCheckInSpace_(group));
}

function ensureGroupExists_(groupId) {
  groupId = String(groupId || '');
  if (!groupId) return null;
  const existing = getGroupById_(groupId);
  if (existing) return existing;
  upsertGroup_({ groupId, name: '未命名群組', enabled: false, type: 'line_group' });
  return getGroupById_(groupId);
}

function upsertGroup_(data) {
  ensureGroupSheets_();
  const sheet = getSheet_(APP.sheets.groups);
  const now = new Date();
  const rowCount = Math.max(sheet.getLastRow() - 1, 0);
  const rows = rowCount
    ? sheet.getRange(2, 1, rowCount, APP.headers.groups.length).getValues()
    : [];
  const index = rows.findIndex(row => String(row[0]) === String(data.groupId || ''));
  const row = index >= 0
    ? rows[index]
    : [String(data.groupId || ''), '', false, now, now, 'line_group', '', '', ''];
  while (row.length < APP.headers.groups.length) row.push('');
  row[0] = String(data.groupId || row[0]);
  if (data.name) row[1] = cleanText_(data.name, 80);
  if (data.enabled !== undefined) row[2] = Boolean(data.enabled);
  row[3] = row[3] || now;
  row[4] = now;
  if (data.type !== undefined) row[5] = data.type === 'space' ? 'space' : 'line_group';
  else if (!row[5]) row[5] = 'line_group';
  if (data.ownerUserId !== undefined) row[6] = String(data.ownerUserId || '');
  if (data.inviteCode !== undefined) row[7] = String(data.inviteCode || '');
  if (data.inviteExpiresAt !== undefined) row[8] = data.inviteExpiresAt || '';
  if (index >= 0) sheet.getRange(index + 2, 1, 1, row.length).setValues([row]);
  else sheet.appendRow(row);
  CacheService.getScriptCache().remove('groups:v2');
  CacheService.getScriptCache().remove('groups:v3');
  invalidateGroupWallCachesForGroup_(row[0]);
  return row;
}

/**
 * 打卡空間：由官方帳號內建立的私人成員空間，不需要建立 LINE 群組或邀請機器人。
 * 仍沿用群組牆資料格式，所以既有的分享開關、日期切換與食物細項可直接共用。
 */
function createCheckInSpace_(ownerUserId, name) {
  ownerUserId = String(ownerUserId || '');
  const safeName = cleanText_(name, 40).replace(/\s+/g, ' ').trim();
  if (!ownerUserId) throw new Error('找不到建立者身分，請從 LINE 私訊或自己的打卡頁操作。');
  if (!safeName) throw new Error('請輸入打卡空間名稱。');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) throw new Error('目前正在建立其他空間，請稍後再試。');
  try {
    const groupId = `space_${Utilities.getUuid().replace(/-/g, '')}`;
    const invite = buildNewCheckInSpaceInvite_();
    upsertGroup_({
      groupId,
      name: safeName,
      enabled: true,
      type: 'space',
      ownerUserId,
      inviteCode: invite.code,
      inviteExpiresAt: invite.expiresAt,
    });
    upsertGroupMember_(groupId, ownerUserId, true);
    return formatCheckInSpace_(getGroupById_(groupId), ownerUserId);
  } finally {
    lock.releaseLock();
  }
}

function joinCheckInSpaceByInvite_(userId, inviteCode) {
  userId = String(userId || '');
  if (!userId) throw new Error('找不到你的 LINE 身分。');
  const normalizedCode = normalizeCheckInSpaceInviteCode_(inviteCode);
  if (!normalizedCode) throw new Error('請輸入有效的邀請碼。');

  const space = getGroups_().find(group => (
    isCheckInSpace_(group)
    && group.enabled
    && normalizeCheckInSpaceInviteCode_(group.inviteCode) === normalizedCode
  ));
  if (!space) throw new Error('找不到這組邀請碼，請確認是否輸入正確或請空間擁有者重發。');
  if (!isCheckInSpaceInviteActive_(space)) throw new Error('這組邀請碼已過期，請向空間擁有者索取新的邀請碼。');

  const alreadyJoined = getGroupMemberships_(space.groupId)
    .some(item => item.userId === userId && item.inGroup);
  upsertGroupMember_(space.groupId, userId, true);
  return { ...formatCheckInSpace_(getGroupById_(space.groupId), userId), alreadyJoined };
}

function regenerateCheckInSpaceInvite_(ownerUserId, groupIdOrInviteCode) {
  ownerUserId = String(ownerUserId || '');
  const requested = String(groupIdOrInviteCode || '');
  const normalizedCode = normalizeCheckInSpaceInviteCode_(requested);
  const space = getGroups_().find(group => (
    isCheckInSpace_(group)
    && group.ownerUserId === ownerUserId
    && (group.groupId === requested || normalizeCheckInSpaceInviteCode_(group.inviteCode) === normalizedCode)
  ));
  if (!space) throw new Error('找不到你建立的打卡空間，或你沒有管理權限。');
  const invite = buildNewCheckInSpaceInvite_(space.groupId);
  upsertGroup_({
    groupId: space.groupId,
    name: space.name,
    enabled: true,
    type: 'space',
    ownerUserId,
    inviteCode: invite.code,
    inviteExpiresAt: invite.expiresAt,
  });
  return formatCheckInSpace_(getGroupById_(space.groupId), ownerUserId);
}

function leaveCheckInSpace_(userId, groupId) {
  userId = String(userId || '');
  groupId = String(groupId || '');
  const space = getGroupById_(groupId);
  if (!isCheckInSpace_(space)) throw new Error('找不到打卡空間。');
  if (space.ownerUserId === userId) throw new Error('空間建立者不能離開自己的空間；若不再使用，可停止分享紀錄即可。');
  const joined = getGroupMemberships_(groupId).some(item => item.userId === userId && item.inGroup);
  if (!joined) throw new Error('你目前不在這個打卡空間。');
  upsertGroupMember_(groupId, userId, false);
}

function getCheckInSpacesForUser_(userId) {
  userId = String(userId || '');
  if (!userId) return [];
  const activeIds = new Set(getActiveGroupIdsForUser_(userId));
  const memberCounts = new Map();
  getGroupMemberships_().forEach(item => {
    if (item.inGroup) memberCounts.set(item.groupId, (memberCounts.get(item.groupId) || 0) + 1);
  });
  return getGroups_()
    .filter(group => isCheckInSpace_(group) && group.enabled && activeIds.has(group.groupId))
    .map(group => formatCheckInSpace_(group, userId, memberCounts.get(group.groupId) || 0))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
}

function formatCheckInSpace_(space, viewerId, knownMemberCount) {
  if (!space) return null;
  const isOwner = String(space.ownerUserId || '') === String(viewerId || '');
  const memberCount = knownMemberCount === undefined
    ? getActiveGroupMemberIds_(space.groupId).length
    : knownMemberCount;
  return {
    groupId: space.groupId,
    name: cleanText_(space.name, 40) || '未命名打卡空間',
    isOwner,
    memberCount,
    // 邀請碼只傳給空間建立者，不會出現在群組牆或其他成員的頁面資料中。
    inviteCode: isOwner ? String(space.inviteCode || '') : '',
    inviteExpiresAt: isOwner ? formatCheckInSpaceInviteExpiry_(space.inviteExpiresAt) : '',
  };
}

function buildNewCheckInSpaceInvite_(excludeGroupId) {
  const existing = new Set(
    getGroups_()
      .filter(group => group.groupId !== excludeGroupId)
      .map(group => normalizeCheckInSpaceInviteCode_(group.inviteCode))
      .filter(Boolean)
  );
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    let suffix = '';
    for (let index = 0; index < 6; index += 1) {
      suffix += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    code = `MM${suffix}`;
  } while (existing.has(code));
  return { code, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) };
}

function normalizeCheckInSpaceInviteCode_(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isCheckInSpaceInviteActive_(space) {
  if (!isCheckInSpace_(space) || !space.enabled || !space.inviteCode) return false;
  const expiresAt = new Date(space.inviteExpiresAt || 0).getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function formatCheckInSpaceInviteExpiry_(value) {
  const date = new Date(value || 0);
  if (!Number.isFinite(date.getTime())) return '—';
  return Utilities.formatDate(date, APP.timezone, 'yyyy-MM-dd HH:mm');
}

function checkInSpaceCreatedMessages_(space) {
  return [{
    type: 'text',
    text: `✅ 已建立打卡空間「${space.name}」\n\n邀請好友的方式：\n1. 請對方先加入本官方帳號\n2. 請對方直接私訊這組邀請碼：\n${space.inviteCode}\n\n邀請碼有效到：${space.inviteExpiresAt}\n建立者可在打卡頁的「個人設定 → 打卡空間」隨時重設邀請碼。`,
  }];
}

function checkInSpaceJoinedMessages_(userId, space) {
  const message = space.alreadyJoined
    ? `你已經在打卡空間「${space.name}」中了 ✅`
    : `✅ 已加入打卡空間「${space.name}」！`;
  return [{
    type: 'template',
    altText: message,
    template: {
      type: 'buttons',
      text: `${message}\n\n到「猛猛紀錄牆」即可看到這個空間的分頁。想讓自己的紀錄出現在空間牆，請到打卡頁開啟「顯示在我的打卡空間／群組猛猛紀錄牆」。`,
      actions: [
        { type: 'uri', label: '開啟猛猛紀錄牆', uri: getPublicWallUrl_(userId) },
        { type: 'uri', label: '前往打卡設定', uri: getSignedFormUrl_(userId) },
      ],
    },
  }];
}

function checkInSpaceManagementMessages_(userId) {
  const spaces = getCheckInSpacesForUser_(userId);
  const ownerSpaces = spaces.filter(space => space.isOwner);
  const joinedSpaces = spaces.filter(space => !space.isOwner);
  const lines = ['👥 打卡空間'];
  if (ownerSpaces.length) {
    lines.push('', '你建立的空間：');
    ownerSpaces.forEach(space => lines.push(`・${space.name}（${space.memberCount} 人）\n  邀請碼：${space.inviteCode}，到 ${space.inviteExpiresAt}`));
  }
  if (joinedSpaces.length) {
    lines.push('', '你加入的空間：');
    joinedSpaces.forEach(space => lines.push(`・${space.name}（${space.memberCount} 人）`));
  }
  if (!spaces.length) lines.push('', '你還沒有打卡空間。\n輸入「建立打卡空間 名稱」就能開始，例如：\n建立打卡空間 晚餐不爆卡小隊');
  lines.push('', '管理請開啟你的打卡頁 → 個人設定 → 打卡空間。');
  return [{ type: 'text', text: lines.join('\n') }];
}

function fetchLineGroupName_(groupId) {
  const token = getLineToken_();
  if (!token || !groupId) return '';
  try {
    const response = UrlFetchApp.fetch(
      `https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/summary`,
      {
        method: 'get',
        headers: { Authorization: `Bearer ${token}` },
        muteHttpExceptions: true,
      }
    );
    if (response.getResponseCode() !== 200) return '';
    return cleanText_(JSON.parse(response.getContentText()).groupName || '', 80);
  } catch (error) {
    console.warn(`取得群組名稱失敗：${error}`);
    return '';
  }
}

function getGroupMemberships_(groupId) {
  ensureGroupSheets_();
  let memberships = readJsonCache_('group-memberships:v3');
  if (!Array.isArray(memberships)) {
    const sheet = getSheet_(APP.sheets.groupMembers);
    if (sheet.getLastRow() < 2) return [];
    memberships = sheet.getRange(2, 1, sheet.getLastRow() - 1, APP.headers.groupMembers.length).getValues()
      .filter(row => row[0] && row[1])
      .map(row => ({
        groupId: String(row[0]),
        userId: String(row[1]),
        inGroup: row[2] === true || String(row[2]).toUpperCase() === 'TRUE',
      }));
    writeJsonCache_('group-memberships:v3', memberships, 180);
  }
  const target = groupId == null ? '' : String(groupId);
  return target ? memberships.filter(item => item.groupId === target) : memberships;
}

function getActiveGroupMemberIds_(groupId) {
  return getGroupMemberships_(groupId)
    .filter(item => item.inGroup)
    .map(item => item.userId);
}

function getActiveGroupIdsForUser_(userId) {
  userId = String(userId || '');
  return Array.from(new Set(
    getGroupMemberships_()
      .filter(item => item.userId === userId && item.inGroup)
      .map(item => item.groupId)
  ));
}

function upsertGroupMember_(groupId, userId, inGroup) {
  groupId = String(groupId || '');
  userId = String(userId || '');
  if (!groupId || !userId) return false;
  ensureGroupSheets_();
  const sheet = getSheet_(APP.sheets.groupMembers);
  const now = new Date();
  const rowCount = Math.max(sheet.getLastRow() - 1, 0);
  const rows = rowCount
    ? sheet.getRange(2, 1, rowCount, APP.headers.groupMembers.length).getValues()
    : [];
  const index = rows.findIndex(row => String(row[0]) === groupId && String(row[1]) === userId);
  const row = index >= 0 ? rows[index] : [groupId, userId, false, '', now];
  const wasInGroup = row[2] === true || String(row[2]).toUpperCase() === 'TRUE';
  row[2] = Boolean(inGroup);
  if (inGroup && (!wasInGroup || !row[3])) row[3] = now;
  row[4] = now;
  if (index >= 0) sheet.getRange(index + 2, 1, 1, row.length).setValues([row]);
  else sheet.appendRow(row);
  CacheService.getScriptCache().remove('group-memberships:v3');
  invalidateGroupWallCachesForGroup_(groupId);
  return true;
}

function applyGroupMembershipStatuses_(groupId, statuses) {
  groupId = String(groupId || '');
  statuses = Array.isArray(statuses) ? statuses : [];
  if (!groupId || !statuses.length) return;
  ensureGroupSheets_();
  const sheet = getSheet_(APP.sheets.groupMembers);
  const columnCount = APP.headers.groupMembers.length;
  const rowCount = Math.max(sheet.getLastRow() - 1, 0);
  const rows = rowCount ? sheet.getRange(2, 1, rowCount, columnCount).getValues() : [];
  const rowByKey = new Map();
  rows.forEach((row, index) => rowByKey.set(`${String(row[0])}|${String(row[1])}`, index));
  const now = new Date();

  statuses.forEach(status => {
    const userId = String(status.userId || '');
    if (!userId) return;
    const key = `${groupId}|${userId}`;
    const index = rowByKey.get(key);
    const row = index === undefined ? [groupId, userId, false, '', now] : rows[index];
    const wasInGroup = row[2] === true || String(row[2]).toUpperCase() === 'TRUE';
    row[2] = Boolean(status.inGroup);
    if (status.inGroup && (!wasInGroup || !row[3])) row[3] = now;
    row[4] = now;
    if (index === undefined) {
      rowByKey.set(key, rows.length);
      rows.push(row);
    }
  });
  sheet.getRange(2, 1, rows.length, columnCount).setValues(rows);
  CacheService.getScriptCache().remove('group-memberships:v3');
  invalidateGroupWallCachesForGroup_(groupId);
}

function markUserInGroup_(groupId, userId, inGroup) {
  groupId = String(groupId || '');
  userId = String(userId || '');
  if (!groupId || !userId) return false;
  ensureGroupExists_(groupId);
  const current = getMemberById_(userId);
  if (!current) {
    const name = inGroup
      ? fetchLineDisplayName_({ type: 'group', groupId, userId }) || '成員'
      : '成員';
    upsertMember_({ userId, name });
  }
  return upsertGroupMember_(groupId, userId, inGroup);
}

function ensureUserGroupMembershipActive_(groupId, userId) {
  groupId = String(groupId || '');
  userId = String(userId || '');
  if (!groupId || !userId) return false;
  const alreadyActive = getGroupMemberships_(groupId)
    .some(item => item.userId === userId && item.inGroup);
  if (alreadyActive) return true;
  return markUserInGroup_(groupId, userId, true);
}

function enableGroupRanking_(groupId) {
  groupId = String(groupId || '');
  if (!groupId) throw new Error('缺少 GroupId。');
  const existing = ensureGroupExists_(groupId);
  const groupName = fetchLineGroupName_(groupId) || (existing && existing.name) || '未命名群組';
  upsertGroup_({ groupId, name: groupName, enabled: true });
  const sync = syncGroupMembershipForGroup_(groupId);
  return { ok: true, groupId, groupName, ...sync };
}

function syncGroupMembershipForGroup_(groupId) {
  const group = getGroupById_(groupId);
  if (isCheckInSpace_(group)) {
    return { active: getActiveGroupMemberIds_(groupId).length, inactive: 0, unchanged: 0, skipped: 'check_in_space' };
  }
  const token = getLineToken_();
  if (!token) throw new Error('缺少 LINE_CHANNEL_ACCESS_TOKEN。');
  const members = getMembers_().filter(member => member.userId);
  if (!members.length) return { active: 0, inactive: 0, unchanged: 0 };
  const requests = members.map(member => ({
    url: `https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(member.userId)}`,
    method: 'get',
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true,
  }));
  const responses = UrlFetchApp.fetchAll(requests);
  let active = 0;
  let inactive = 0;
  let unchanged = 0;
  const statuses = [];
  responses.forEach((response, index) => {
    const status = response.getResponseCode();
    if (status === 200) {
      statuses.push({ userId: members[index].userId, inGroup: true });
      active += 1;
    } else if (status === 404) {
      statuses.push({ userId: members[index].userId, inGroup: false });
      inactive += 1;
    } else {
      unchanged += 1;
      console.warn(`同步群組身分失敗：${members[index].userId} HTTP ${status} ${response.getContentText()}`);
    }
  });
  applyGroupMembershipStatuses_(groupId, statuses);
  return { active, inactive, unchanged };
}

function syncGroupMembership() {
  // 打卡空間的成員由邀請碼管理，不能也不需要呼叫 LINE 的群組成員 API。
  const groups = getEnabledLineGroups_();
  return {
    ok: true,
    groups: groups.map(group => ({
      groupId: group.groupId,
      groupName: group.name,
      ...syncGroupMembershipForGroup_(group.groupId),
    })),
  };
}

function getReminderMembers_(slot) {
  return getMembers_().filter(member => (
    member.userId
    && member.isFriend
    && member.personalReminder !== false
    && reminderSlotEnabled_(member, slot)
  ));
}

function reminderSlotEnabled_(member, slot) {
  const settings = getPersonalReminderSettings_(member);
  if (slot === '09:00') return settings.morning;
  if (slot === '12:00') return settings.noon;
  if (slot === '19:30') return settings.evening;
  return settings.morning || settings.noon || settings.evening;
}

function getMemberById_(userId) {
  const cache = CacheService.getScriptCache();
  const cacheKey = `member:${String(userId)}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (error) {
      cache.remove(cacheKey);
    }
  }
  const member = getMembers_().find(item => item.userId === userId) || null;
  if (member) cache.put(cacheKey, JSON.stringify(member), 120);
  return member;
}

/** 個人喝水偏好不放進群組排行；只用指令碼屬性保存是否啟用與每日目標。 */
function getWaterSettings_(userId) {
  userId = String(userId || '');
  const fallback = { enabled: false, goalMl: 2000 };
  if (!userId) return fallback;
  const raw = PropertiesService.getScriptProperties().getProperty(`WATER_SETTINGS_${userId}`);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) || {};
    return {
      enabled: Boolean(parsed.enabled),
      goalMl: Math.round(numberInRange_(parsed.goalMl, 500, 10000)) || 2000,
    };
  } catch (error) {
    return fallback;
  }
}

function saveWaterSettings_(userId, enabled, goalMl) {
  userId = String(userId || '');
  if (!userId) return;
  const settings = {
    enabled: Boolean(enabled),
    goalMl: Math.round(numberInRange_(goalMl, 500, 10000)) || 2000,
  };
  PropertiesService.getScriptProperties().setProperty(
    `WATER_SETTINGS_${userId}`,
    JSON.stringify(settings),
  );
}

function upsertMember_(data) {
  const sheet = getSheet_(APP.sheets.members);
  ensureMemberGroupHeader_(sheet);
  const now = new Date();
  let rowNumber = -1;
  let existing = null;

  if (sheet.getLastRow() >= 2) {
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, APP.headers.members.length).getValues();
    const index = values.findIndex(row => String(row[0]) === String(data.userId));
    if (index >= 0) {
      rowNumber = index + 2;
      existing = values[index];
    }
  }

  const row = existing || [data.userId, '', '', '', '', '', '', false, now, now, false, '', false, false, false, true, true, true, true, true, false];
  row[0] = data.userId || row[0];
  if (data.name !== undefined && data.name !== '') row[1] = cleanText_(data.name, 40);
  if (data.bmr !== undefined && data.bmr !== '') row[2] = Number(data.bmr);
  // 不儲存體重。舊版傳入的 weightKg 也刻意忽略。
  if (data.heightCm !== undefined && data.heightCm !== '') row[4] = Number(data.heightCm);
  if (data.age !== undefined && data.age !== '') row[5] = Number(data.age);
  if (data.sex !== undefined && data.sex !== '') row[6] = cleanText_(data.sex, 20);
  if (data.isFriend !== undefined) row[7] = Boolean(data.isFriend);
  row[8] = row[8] || now;
  row[9] = now;
  if (data.inGroup !== undefined) row[10] = Boolean(data.inGroup);
  else if (row[10] === undefined || row[10] === '') row[10] = false;
  if (data.publicAlias !== undefined) row[11] = cleanText_(data.publicAlias, 40);
  else if (row[11] === undefined) row[11] = '';
  if (data.joinPublicRanking !== undefined) row[12] = Boolean(data.joinPublicRanking);
  else if (row[12] === undefined || row[12] === '') row[12] = false;
  if (data.defaultPublishToday !== undefined) row[13] = Boolean(data.defaultPublishToday);
  else if (row[13] === undefined || row[13] === '') row[13] = false;
  if (data.defaultPublishFoodDetails !== undefined) {
    row[14] = Boolean(row[13]) && Boolean(data.defaultPublishFoodDetails);
  } else if (row[14] === undefined || row[14] === '') {
    row[14] = false;
  }
  if (data.personalReminder !== undefined) row[15] = Boolean(data.personalReminder);
  else if (row[15] === undefined || row[15] === '') row[15] = true;
  if (data.reminderMorning !== undefined) row[16] = Boolean(data.reminderMorning);
  else if (row[16] === undefined || row[16] === '') row[16] = true;
  if (data.reminderNoon !== undefined) row[17] = Boolean(data.reminderNoon);
  else if (row[17] === undefined || row[17] === '') row[17] = true;
  if (data.reminderEvening !== undefined) row[18] = Boolean(data.reminderEvening);
  else if (row[18] === undefined || row[18] === '') row[18] = true;
  if (data.reminderLate !== undefined) row[19] = Boolean(data.reminderLate);
  else if (row[19] === undefined || row[19] === '') row[19] = false;
  if (data.defaultPublishToGroup !== undefined) row[20] = Boolean(data.defaultPublishToGroup);
  else if (row[20] === undefined || row[20] === '') row[20] = false;

  if (rowNumber > 0) sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  else sheet.appendRow(row);
  const cache = CacheService.getScriptCache();
  cache.remove(`member:${String(data.userId)}`);
  cache.remove('members:v3');
  cache.remove('members:v4');
  cache.remove('members:v5');
  cache.remove('members:v6');
  cache.remove(`public-wall-base:v2:${today_()}`);
  cache.remove(`public-wall-base:v3:${today_()}`);
  cache.remove(`public-wall-base:v4:${today_()}`);
  cache.remove(`public-wall-base:v5:${today_()}`);
  cache.remove(`public-wall-base:v6:${today_()}`);
  cache.remove(`public-wall-base:v7:${today_()}`);
  cache.remove(`public-wall-base:v8:${today_()}`);
  try {
    cache.remove(`public-like-target:v2:${publicLikeTargetKey_(data.userId)}`);
  } catch (error) {
    console.warn(`清除公開成員快取失敗：${error && error.message ? error.message : error}`);
  }
}

/** 首次讀取食物庫時補上蛋白質欄位，不需要使用者手動執行 setupProject。 */
function ensureFoodProteinHeader_(sheet) {
  const cache = CacheService.getScriptCache();
  if (cache.get('food-headers:v1') === 'ok') return;
  const column = APP.headers.foods.length;
  const current = String(sheet.getRange(1, column).getValue() || '');
  if (current !== APP.headers.foods[column - 1]) {
    sheet.getRange(1, column).setValue(APP.headers.foods[column - 1]);
    sheet.getRange(1, 1, 1, column)
      .setBackground('#F5D77A')
      .setFontWeight('bold')
      .setHorizontalAlignment('center');
  }
  cache.put('food-headers:v1', 'ok', 21600);
}

function defaultFoodProteinG_(foodId) {
  return proteinGrams_(DEFAULT_FOOD_PROTEIN_G[String(foodId || '')]);
}

function getFoods_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('active-foods:v2');
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (error) {
      cache.remove('active-foods:v2');
    }
  }
  const sheet = getSheet_(APP.sheets.foods);
  ensureFoodProteinHeader_(sheet);
  if (sheet.getLastRow() < 2) return [];
  const foods = sheet.getRange(2, 1, sheet.getLastRow() - 1, APP.headers.foods.length).getValues()
    .filter(row => row[0] && (row[7] === true || String(row[7]).toUpperCase() === 'TRUE'))
    .map(row => ({
      id: String(row[0]),
      category: String(row[1]),
      name: String(row[2]),
      portion: String(row[3]),
      kcal: Number(row[4]),
      emoji: String(row[5] || '🍽️'),
      imageUrl: String(row[6] || ''),
      source: String(row[8] || ''),
      estimateLevel: String(row[9] || ''),
      sort: Number(row[10] || 999),
      proteinG: proteinGrams_(row[11] === '' || row[11] === null
        ? defaultFoodProteinG_(row[0])
        : row[11]),
    }))
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'zh-Hant'));
  cache.put('active-foods:v2', JSON.stringify(foods), 300);
  return foods;
}

/**
 * 依本人「新功能啟用後」的每日紀錄統計常吃食物。
 *
 * 先固定顯示四個指定入口，避免舊版歷史紀錄直接把快捷區洗成八張卡片。
 * 之後只要使用過一次的食物，就會被加入個人化快捷區，並取代較後面的預設入口。
 */
function getFrequentFoods_(userId, foods, limit) {
  userId = String(userId || '');
  foods = Array.isArray(foods) ? foods : [];
  limit = Math.min(4, Math.max(1, Number(limit) || 4));
  const defaultFoodIds = new Set([
    'common_yangtao_breakfast',
    'common_egg_sandwich',
    'common_overnight_oats',
    'common_boiled_egg',
  ]);
  const fallback = foods
    .filter(food => defaultFoodIds.has(String(food.id)))
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'zh-Hant'));
  const foodById = new Map(foods.map(food => [String(food.id), food]));
  if (!userId || !foods.length) return fallback.slice(0, limit);

  const cache = CacheService.getScriptCache();
  const cacheKey = `frequent-foods:v6:${userId}:${today_()}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      const cachedFoods = JSON.parse(cached);
      if (Array.isArray(cachedFoods)) return cachedFoods.slice(0, limit);
    } catch (error) {
      cache.remove(cacheKey);
    }
  }

  // 只統計這個功能啟用後的新紀錄，避免舊版留下的白飯、雞胸肉等資料立即混進來。
  const props = PropertiesService.getScriptProperties();
  let startDate = String(props.getProperty('FREQUENT_FOODS_START_DATE') || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    startDate = today_();
    props.setProperty('FREQUENT_FOODS_START_DATE', startDate);
  }

  const counts = new Map();
  const manualCounts = new Map();
  const sheet = getSheet_(APP.sheets.logs);
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    // 只取近期資料，避免紀錄累積後每次開頁都掃完整張表。
    const rowCount = Math.min(lastRow - 1, 180);
    const startRow = lastRow - rowCount + 1;
    const rows = sheet.getRange(startRow, 1, rowCount, APP.headers.logs.length).getValues();
    rows.forEach(row => {
      if (String(row[2] || '') !== userId) return;
      const dateKey = getLogRowDateKey_(row, null);
      if (!dateKey || dateKey < startDate) return;
      let details = {};
      try {
        details = JSON.parse(String(row[17] || '{}')) || {};
      } catch (error) {
        return;
      }
      Object.values(details).forEach(items => {
        if (!Array.isArray(items)) return;
        items.forEach(item => {
          const foodId = String(item && item.id || '');
          if (foodById.has(foodId)) {
            counts.set(foodId, (counts.get(foodId) || 0) + 1);
            return;
          }
          // 直接輸入的食物沒有食物庫 FoodId，改用正規化名稱累計。
          if (String(item && item.source || '').toLowerCase() !== 'manual') return;
          const name = cleanText_(item && item.name, 60).replace(/\s+/g, ' ').trim();
          if (!name) return;
          const key = name.toLocaleLowerCase();
          const current = manualCounts.get(key) || {
            name,
            count: 0,
            calories: 0,
            proteinG: 0,
            portion: cleanText_(item && item.portion, 80) || '自行輸入',
          };
          current.count += 1;
          current.calories = Math.round(numberInRange_(item && item.calories, 0, 5000)) || current.calories;
          current.proteinG = proteinGrams_(item && item.proteinG) || current.proteinG;
          manualCounts.set(key, current);
        });
      });
    });
  }

  const rankedLibrary = Array.from(counts.entries())
    .filter(([foodId, count]) => count >= 1 && !defaultFoodIds.has(foodId))
    .sort((a, b) => b[1] - a[1] || (foodById.get(a[0]).sort - foodById.get(b[0]).sort))
    .map(([foodId]) => foodById.get(foodId));
  const rankedManual = Array.from(manualCounts.values())
    .filter(item => item.count >= 1 && item.calories > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hant'))
    .map(item => ({
      id: manualFrequentId_(item.name),
      name: item.name,
      portion: item.portion || '自行輸入',
      kcal: item.calories,
      proteinG: item.proteinG,
      emoji: '✍️',
      sort: 0,
      isManualFrequent: true,
    }));

  const result = [];
  const seen = new Set();
  rankedManual.concat(rankedLibrary, fallback).forEach(food => {
    if (!food || seen.has(String(food.id)) || result.length >= limit) return;
    seen.add(String(food.id));
    result.push(food);
  });
  cache.put(cacheKey, JSON.stringify(result), 300);
  return result;
}

function manualFrequentId_(name) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    String(name || ''),
    Utilities.Charset.UTF_8
  );
  return `manual_frequent_${Utilities.base64EncodeWebSafe(bytes).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)}`;
}

/**
 * 排程推播專用的啟動網址。
 *
 * 為什麼不直接在 Trigger 裡塞 getSignedFormUrl_()：
 * 時間觸發器可能跑編輯器最新 HEAD，而 /exec 仍是固定部署版本；若簽章邏輯曾調整，
 * 就可能出現「早上剛收到的 uid+sig，點開卻 invalid」。
 *
 * launch 本身只是一段高熵隨機碼；真正的 uid 存在 Script Properties。
 * 使用者點 /exec?launch=... 後，才由該 /exec 部署版本當場簽發 form token。
 */
function getScheduledLaunchUrl_(userId, view) {
  userId = String(userId || '');
  view = String(view || 'form') === 'history' ? 'history' : 'form';
  if (!userId) throw new Error('無法建立排程連結：缺少 UserId。');

  const baseUrl = getWebAppExecUrl_();

  const launch = (
    Utilities.getUuid().replace(/-/g, '')
    + Utilities.getUuid().replace(/-/g, '')
  );
  const expiresAt = Math.floor(Date.now() / 1000) + APP.tokenTtlSeconds.form;
  const key = scheduledLaunchPropertyKey_(launch);
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify({
    uid: userId,
    view,
    exp: expiresAt,
  }));

  const query = view === 'history'
    ? `?view=history&launch=${encodeURIComponent(launch)}`
    : `?launch=${encodeURIComponent(launch)}`;
  return `${baseUrl}${query}`;
}

function scheduledLaunchPropertyKey_(launch) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(launch || ''),
    Utilities.Charset.UTF_8
  );
  return `SCHEDULED_LAUNCH_${Utilities.base64EncodeWebSafe(digest).replace(/=+$/g, '')}`;
}

/**
 * 解析排程 launch。回傳 present/valid/state，讓 doGet 能區分「沒帶 launch」與「launch 已失效」。
 * launch 在有效期內可重複開啟，符合 LINE 使用者可能返回、重點按鈕的使用情境。
 */
function resolveScheduledLaunchAccess_(e) {
  const launch = String((e && e.parameter && e.parameter.launch) || '');
  if (!launch) return { present: false, valid: false, state: 'invalid', uid: '', view: 'form' };
  // UUID x2 去掉連字號後應為 64 個十六進位字元；先限制格式，避免任意字串造成 Properties 查詢。
  if (!/^[a-f0-9]{64}$/i.test(launch)) {
    return { present: true, valid: false, state: 'invalid', uid: '', view: 'form' };
  }

  const raw = PropertiesService.getScriptProperties().getProperty(scheduledLaunchPropertyKey_(launch));
  if (!raw) return { present: true, valid: false, state: 'invalid', uid: '', view: 'form' };

  let data;
  try { data = JSON.parse(raw); } catch (error) { data = null; }
  const uid = data && String(data.uid || '');
  const view = data && String(data.view || '') === 'history' ? 'history' : 'form';
  const expiresAt = data ? Number(data.exp || 0) : 0;
  if (!uid || !Number.isFinite(expiresAt)) {
    return { present: true, valid: false, state: 'invalid', uid: '', view };
  }
  if (Math.floor(Date.now() / 1000) > expiresAt) {
    return { present: true, valid: false, state: 'expired', uid: '', view };
  }

  // view 也要吻合，避免把 history launch 改掉 query 後拿去開表單，反之亦然。
  const requestedView = String((e && e.parameter && e.parameter.view) || '');
  if ((view === 'history' && requestedView !== 'history') || (view === 'form' && requestedView === 'history')) {
    return { present: true, valid: false, state: 'invalid', uid: '', view };
  }
  return { present: true, valid: true, state: 'ok', uid, view };
}

function cleanupExpiredScheduledLaunches_() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const now = Math.floor(Date.now() / 1000);
  const expiredKeys = [];
  Object.keys(all).forEach(key => {
    if (!/^SCHEDULED_LAUNCH_/.test(key)) return;
    try {
      const data = JSON.parse(all[key] || '{}');
      if (!Number(data.exp) || Number(data.exp) < now) expiredKeys.push(key);
    } catch (error) {
      expiredKeys.push(key);
    }
  });
  expiredKeys.forEach(key => props.deleteProperty(key));
  return { ok: true, removed: expiredKeys.length };
}

/**
 * 部署新版後可在 Apps Script 編輯器手動執行，立即取得兩條排程式測試網址，
 * 不必等隔天 09:00。開啟 formUrl 應能直接進打卡頁，網址應包含 launch= 而不是 uid+sig。
 */
function testScheduledLaunchLinks() {
  const member = getMembers_().find(item => item && item.userId && item.isFriend)
    || getMembers_().find(item => item && item.userId);
  if (!member) throw new Error('找不到可測試的成員。');

  const result = {
    ok: true,
    user: member.name || member.userId,
    formUrl: getScheduledLaunchUrl_(member.userId, 'form'),
    historyUrl: getScheduledLaunchUrl_(member.userId, 'history'),
  };

  console.log('=== 排程連結測試 ===');
  console.log(`使用者：${result.user}`);
  console.log(`打卡連結：${result.formUrl}`);
  console.log(`歷史連結：${result.historyUrl}`);
  console.log('網址應包含 launch=，不應直接出現 uid=...&sig=...');

  return result;
}

function getSignedFormUrl_(userId) {
  const baseUrl = getWebAppExecUrl_();
  // token 每次發放都不同，本身就會讓網址唯一，不需要額外的 v= 參數。
  const token = issueAccessToken_(userId, APP.tokenScopes.form, APP.tokenTtlSeconds.form);
  return `${baseUrl}?uid=${encodeURIComponent(userId)}&sig=${encodeURIComponent(token)}`;
}

function getHistoryUrl_(userId) {
  const baseUrl = getWebAppExecUrl_();
  userId = String(userId || '');
  if (!userId) return `${baseUrl}?view=history`;
  const token = issueAccessToken_(userId, APP.tokenScopes.form, APP.tokenTtlSeconds.form);
  return `${baseUrl}?view=history&uid=${encodeURIComponent(userId)}&sig=${encodeURIComponent(token)}`;
}

/**
 * 「紀錄牆」是本人入口，因此發 hub 範圍的 token：可看公開與本人群組卡夾，
 * 但不能讀寫任何人的打卡紀錄。舊 wall token 仍只保留公開頁相容性。
 */
function getPublicWallUrl_(userId) {
  const baseUrl = getWebAppExecUrl_();
  userId = String(userId || '');
  if (!userId) return `${baseUrl}?view=public`;
  const token = issueAccessToken_(userId, APP.tokenScopes.hub, APP.tokenTtlSeconds.hub);
  return `${baseUrl}?view=public&uid=${encodeURIComponent(userId)}&sig=${encodeURIComponent(token)}`;
}

/**
 * 連結憑證（token）。
 *
 * 舊版是 sign(userId)：同一個人永遠拿到同一個字串，等於一把永不過期、也無法作廢的
 * 鑰匙。而這個網頁沒有登入畫面，那串簽章就是身分本身——所以任何轉傳、截圖或瀏覽器
 * 歷史紀錄的外流，都是永久有效的帳號外流。
 *
 * 新版把三件事一起綁進簽章：
 * - scope：這把鑰匙能做什麼（form 可讀寫紀錄；wall 只能看公開頁與按讚）
 * - exp：到期的 Unix 秒數，過期即失效
 * - SIG_VERSION：執行 revokeAllTokens() 後，所有已發出的連結一次作廢
 *
 * 格式：`${exp}.${base64url(hmac)}`
 */
let runtimeSigningConfig_ = null;

function getSigningConfig_() {
  if (runtimeSigningConfig_) return runtimeSigningConfig_;
  const props = PropertiesService.getScriptProperties().getProperties();
  const secret = props.FORM_SIGNING_SECRET || '';
  if (!secret) throw new Error('缺少 FORM_SIGNING_SECRET，請先執行 setupProject。');
  runtimeSigningConfig_ = { secret, version: String(props.SIG_VERSION || '1') };
  return runtimeSigningConfig_;
}

function computeTokenSignature_(userId, scope, expiresAt, config) {
  const payload = `v${config.version}|${scope}|${String(userId)}|${expiresAt}`;
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(payload, config.secret)
  ).replace(/=+$/g, '');
}

function issueAccessToken_(userId, scope, ttlSeconds) {
  const config = getSigningConfig_();
  const expiresAt = Math.floor(Date.now() / 1000) + Math.max(60, Number(ttlSeconds) || 0);
  return `${expiresAt}.${computeTokenSignature_(userId, scope, expiresAt, config)}`;
}

/**
 * 回傳 'ok' | 'expired' | 'invalid'。
 * 分成三種狀態是為了讓使用者看到「連結過期了，回 LINE 重按」而不是籠統的驗證失敗。
 */
function inspectAccessToken_(userId, token, scope) {
  userId = String(userId || '');
  token = String(token || '');
  if (!userId || !token) return 'invalid';

  const separator = token.indexOf('.');
  // 舊版沒有到期時間的簽章不含分隔點，一律視為無效。
  if (separator <= 0) return 'invalid';

  const expiresAt = Number(token.slice(0, separator));
  const signature = token.slice(separator + 1).replace(/=+$/g, '');
  if (!Number.isFinite(expiresAt) || !signature) return 'invalid';

  const config = getSigningConfig_();
  const expected = computeTokenSignature_(userId, scope, expiresAt, config);
  if (!safeEqual_(expected, signature)) return 'invalid';

  // 先驗簽章、後看時間：到期時間是被簽章保護的內容，不能拿未驗證的值做判斷。
  return Math.floor(Date.now() / 1000) > expiresAt ? 'expired' : 'ok';
}

/**
 * 群組牆只讀取已分享的資料，因此可接受整合式紀錄牆的 hub token；
 * 保留 form token 相容既有的群組專屬連結。無論哪一種都還會驗證目前群組成員資格。
 */
function inspectGroupWallAccessToken_(userId, token) {
  const hubState = inspectAccessToken_(userId, token, APP.tokenScopes.hub);
  if (hubState === 'ok') return 'ok';
  const formState = inspectAccessToken_(userId, token, APP.tokenScopes.form);
  if (formState === 'ok') return 'ok';
  return hubState === 'expired' || formState === 'expired' ? 'expired' : 'invalid';
}

/** 公開牆按讚相容舊 wall 連結與新版 hub 紀錄牆連結。 */
function inspectPublicWallAccessToken_(userId, token) {
  const hubState = inspectAccessToken_(userId, token, APP.tokenScopes.hub);
  if (hubState === 'ok') return 'ok';
  const wallState = inspectAccessToken_(userId, token, APP.tokenScopes.wall);
  if (wallState === 'ok') return 'ok';
  return hubState === 'expired' || wallState === 'expired' ? 'expired' : 'invalid';
}

function validateFormSignature_(userId, token, scope) {
  return inspectAccessToken_(userId, token, scope || APP.tokenScopes.form) === 'ok';
}

function accessTokenErrorMessage_(state) {
  if (state === 'expired') {
    return '這個連結已經過期了（打卡連結有效 72 小時）。請回 LINE 輸入「打卡」取得新連結。';
  }
  return '連結驗證失敗，請回 LINE 重新輸入「打卡」。';
}

/**
 * 在 Apps Script 編輯器手動執行，即可讓所有已發出的連結立刻失效。
 * 使用時機：連結被轉傳出去、成員退出、或任何你不確定的時候。
 * 執行後成員只要回 LINE 輸入「打卡」就會拿到新連結，資料不受影響。
 */
function revokeAllTokens() {
  const props = PropertiesService.getScriptProperties();
  const next = String(Number(props.getProperty('SIG_VERSION') || '1') + 1);
  props.setProperty('SIG_VERSION', next);
  runtimeSigningConfig_ = null;
  return {
    ok: true,
    signatureVersion: next,
    message: '所有舊連結已失效，請成員回 LINE 重新輸入「打卡」。',
  };
}

/**
 * 產生一個穩定、不可反推的識別字串。
 *
 * 只給 publicLikeTargetKey_ 用：讓公開頁可以指向某個人而不必暴露真實的 LINE UserId。
 * 這不是身分憑證，不含到期時間也不受 revokeAllTokens 影響（它必須永遠穩定，
 * 否則舊的按讚資料會對不上）。絕對不要拿它當作授權依據。
 */
function opaqueId_(value) {
  const config = getSigningConfig_();
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(String(value), config.secret)
  ).replace(/=+$/g, '');
}

function fetchLineDisplayName_(source) {
  const token = getLineToken_();
  if (!token || !source || !source.userId) return '';
  let url = `https://api.line.me/v2/bot/profile/${encodeURIComponent(source.userId)}`;
  if (source.type === 'group' && source.groupId) {
    url = `https://api.line.me/v2/bot/group/${encodeURIComponent(source.groupId)}/member/${encodeURIComponent(source.userId)}`;
  }
  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: `Bearer ${token}` },
      muteHttpExceptions: true,
    });
    if (response.getResponseCode() !== 200) return '';
    return JSON.parse(response.getContentText()).displayName || '';
  } catch (error) {
    console.error(error);
    return '';
  }
}

function replyMessage_(replyToken, messages) {
  if (!replyToken || !messages || !messages.length) return false;
  return callLineApi_('https://api.line.me/v2/bot/message/reply', {
    replyToken,
    messages: messages.slice(0, 5),
  });
}

function pushMessage_(to, messages) {
  if (!to || !messages || !messages.length) return false;
  return callLineApi_('https://api.line.me/v2/bot/message/push', {
    to,
    messages: messages.slice(0, 5),
  });
}

function callLineApi_(url, body) {
  const token = getLineToken_();
  if (!token) throw new Error('缺少 LINE_CHANNEL_ACCESS_TOKEN。');
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  const ok = response.getResponseCode() >= 200 && response.getResponseCode() < 300;
  if (!ok) console.error(`LINE API ${response.getResponseCode()}: ${response.getContentText()}`);
  return ok;
}

function getLineToken_() {
  return PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN') || '';
}

function testGeminiConnection() {
  const result = callGemini_([{ text: '請只回覆：Gemini 連線成功' }], {
    maxOutputTokens: 80,
    thinkingConfig: { thinkingLevel: 'minimal' },
  });
  const reply = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
  console.log(`Gemini 回覆：${reply}`);
  return { ok: true, reply };
}

/**
 * 每日照片辨識配額。
 *
 * 所有成員共用同一組 Gemini 免費額度，所以需要兩層上限：單人上限擋住某個外流連結
 * 被拿去無限呼叫，全站上限保護整組額度不被單日耗盡（額度用完，全部人的辨識都會壞）。
 *
 * 計數放 ScriptProperties 而不是 CacheService：後者最長只有 6 小時，跨不過一整天。
 * 這個值大約每 150 位成員會用掉 9KB 的屬性上限，目前規模綽綽有餘。
 */
function consumePhotoQuota_(userId) {
  const limits = APP.photoQuota;
  const props = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  // 只鎖住計數本身；Gemini 呼叫留在鎖外，避免所有人排隊等同一支 API。
  if (!lock.tryLock(5000)) throw new Error('系統忙碌中，請兩秒後再按一次分析。');
  try {
    const date = today_();
    const state = parseJsonObject_(props.getProperty('PHOTO_QUOTA'));
    const counts = state.date === date && state.counts && typeof state.counts === 'object'
      ? state.counts
      : {};
    const used = Number(counts[userId] || 0);
    const total = Number(counts.__total || 0);

    if (used >= limits.perUserPerDay) {
      throw new Error(`今天的照片辨識已達每人上限 ${limits.perUserPerDay} 次，明天會重新計算。你仍然可以手輸熱量。`);
    }
    if (total >= limits.totalPerDay) {
      throw new Error('今天大家的照片辨識額度已經用完了，明天會重新計算。你仍然可以手輸熱量。');
    }

    counts[userId] = used + 1;
    counts.__total = total + 1;
    props.setProperty('PHOTO_QUOTA', JSON.stringify({ date, counts }));
    return { used: used + 1, total: total + 1 };
  } finally {
    lock.releaseLock();
  }
}

/** 需要時在編輯器手動執行，把今天的照片辨識次數歸零。 */
function resetPhotoQuota() {
  PropertiesService.getScriptProperties().deleteProperty('PHOTO_QUOTA');
  return { ok: true, message: '今日照片辨識次數已歸零。' };
}

/** 分析一張餐點照片；照片不會寫入 Sheet 或 Drive。 */
function analyzeFoodPhoto(payload) {
  payload = payload || {};
  const uid = String(payload.uid || '');
  const sig = String(payload.sig || '');
  const tokenState = inspectAccessToken_(uid, sig, APP.tokenScopes.form);
  if (tokenState !== 'ok') throw new Error(accessTokenErrorMessage_(tokenState));

  const match = String(payload.imageDataUrl || '').match(
    /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/
  );
  if (!match) throw new Error('照片格式不支援，請重新拍照或選擇 JPG、PNG 圖片。');
  if (match[2].length > 2800000) throw new Error('照片太大，請重新拍照。');

  // 格式檢查通過後才計數，避免壞掉的請求白白消耗別人的額度。
  const quota = consumePhotoQuota_(uid);
  console.log(`照片辨識配額：本人今日第 ${quota.used} 次，全站今日第 ${quota.total} 次。`);

  const prompt = [
    '你是協助台灣使用者記錄飲食的營養估算助手。',
    '請使用繁體中文，分析照片中看得到的所有食物。',
    '估算份量、重量與熱量，並考慮油、醬料、糖與裹粉造成的誤差。',
    '每個食物請另外給可調整的數值 estimatedAmount 與 unit；液體用 ml，固體用 g。estimatedAmount 是照片中估算的原始份量，必須大於 0。',
    '每個食物也請估算 estimatedProteinG（蛋白質克數，可為 0）；肉、蛋、魚、奶、豆製品請特別留意。',
    '看不出來就說明不確定；不是食物照片時 items 回傳空陣列。',
    'summary、portion、notes 請保持簡短，每個 notes 最多 20 個中文字。',
  ].join('\n');

  const responseSchema = {
    type: 'OBJECT',
    properties: {
      summary: { type: 'STRING' },
      items: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            name: { type: 'STRING' },
            portion: { type: 'STRING' },
            estimatedGrams: { type: 'INTEGER' },
            estimatedAmount: { type: 'INTEGER' },
            unit: { type: 'STRING', enum: ['g', 'ml'] },
            estimatedCalories: { type: 'INTEGER' },
            estimatedProteinG: { type: 'NUMBER' },
            caloriesLow: { type: 'INTEGER' },
            caloriesHigh: { type: 'INTEGER' },
            confidence: { type: 'STRING', enum: ['高', '中', '低'] },
            notes: { type: 'STRING' },
          },
          required: ['name', 'portion', 'estimatedGrams', 'estimatedAmount', 'unit', 'estimatedCalories', 'estimatedProteinG', 'caloriesLow', 'caloriesHigh', 'confidence', 'notes'],
        },
      },
      warnings: { type: 'ARRAY', items: { type: 'STRING' } },
    },
    required: ['summary', 'items', 'warnings'],
  };

  const requestParts = [
    { text: prompt },
    { inlineData: { mimeType: match[1], data: match[2] } },
  ];
  const generationConfig = {
    maxOutputTokens: 3000,
    responseMimeType: 'application/json',
    responseSchema,
    thinkingConfig: { thinkingLevel: 'minimal' },
  };

  let parsed = null;
  let lastParseError = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const apiResult = callGemini_(requestParts, generationConfig);
    const candidate = apiResult.candidates && apiResult.candidates[0];
    const finishReason = candidate ? String(candidate.finishReason || '') : '';
    const jsonText = candidate && candidate.content && Array.isArray(candidate.content.parts)
      ? candidate.content.parts.map(part => part.text || '').join('')
      : '';

    if (!jsonText) {
      lastParseError = `沒有文字結果，finishReason=${finishReason || 'unknown'}`;
      console.warn(`Gemini 第 ${attempt} 次分析沒有 JSON：${lastParseError}`);
      continue;
    }

    try {
      parsed = JSON.parse(cleanGeminiJsonText_(jsonText));
      break;
    } catch (error) {
      lastParseError = String(error && error.message ? error.message : error);
      console.warn(
        `Gemini 第 ${attempt} 次 JSON 不完整，finishReason=${finishReason || 'unknown'}：${lastParseError}`
      );
    }
  }

  if (!parsed) {
    console.error(`Gemini JSON 自動重試後仍失敗：${lastParseError}`);
    throw new Error('Gemini 回傳的分析格式不完整，自動重試後仍失敗。請稍後再按一次分析。');
  }
  const items = (Array.isArray(parsed.items) ? parsed.items : []).slice(0, 12).map(item => ({
    name: cleanText_(item.name, 60),
    portion: cleanText_(item.portion, 80),
    estimatedGrams: Math.round(numberInRange_(item.estimatedGrams, 0, 3000)),
    estimatedAmount: Math.round(numberInRange_(item.estimatedAmount || item.estimatedGrams, 0, 5000)),
    unit: String(item.unit || '').toLowerCase() === 'ml' ? 'ml' : 'g',
    estimatedCalories: Math.round(numberInRange_(item.estimatedCalories, 0, 5000)),
    estimatedProteinG: proteinGrams_(item.estimatedProteinG),
    caloriesLow: Math.round(numberInRange_(item.caloriesLow, 0, 5000)),
    caloriesHigh: Math.round(numberInRange_(item.caloriesHigh, 0, 5000)),
    confidence: ['高', '中', '低'].includes(item.confidence) ? item.confidence : '低',
    notes: cleanText_(item.notes, 200),
  })).filter(item => item.name && item.estimatedCalories > 0);

  return {
    ok: true,
    summary: cleanText_(parsed.summary, 300),
    items,
    totalCalories: items.reduce((sum, item) => sum + item.estimatedCalories, 0),
    totalCaloriesLow: items.reduce((sum, item) => sum + item.caloriesLow, 0),
    totalCaloriesHigh: items.reduce((sum, item) => sum + item.caloriesHigh, 0),
    totalProteinG: proteinGrams_(items.reduce((sum, item) => sum + item.estimatedProteinG, 0)),
    warnings: (Array.isArray(parsed.warnings) ? parsed.warnings : []).slice(0, 5).map(item => cleanText_(item, 200)),
  };
}

function cleanGeminiJsonText_(text) {
  let cleaned = String(text || '').trim();
  if (cleaned.indexOf('```') === 0) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace > 0 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  return cleaned;
}

function callGemini_(parts, generationConfig) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('尚未設定 GEMINI_API_KEY。');
  const attempts = [
    { model: 'gemini-3.5-flash-lite', delayMs: 0 },
    { model: 'gemini-3.5-flash-lite', delayMs: 800 },
    { model: 'gemini-3.1-flash-lite', delayMs: 1200 },
    { model: 'gemini-3.5-flash', delayMs: 2200 },
  ];
  const retryableStatuses = [408, 429, 500, 502, 503, 504];
  const unavailableModels = new Set();
  let lastStatus = 0;
  let lastText = '';

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    if (unavailableModels.has(attempt.model)) continue;
    if (attempt.delayMs) {
      Utilities.sleep(attempt.delayMs + Math.floor(Math.random() * 400));
    }

    let response;
    try {
      response = UrlFetchApp.fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${attempt.model}:generateContent`,
        {
          method: 'post',
          contentType: 'application/json',
          headers: { 'x-goog-api-key': apiKey },
          payload: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: generationConfig || {},
          }),
          muteHttpExceptions: true,
        }
      );
    } catch (error) {
      lastStatus = 0;
      lastText = String(error && error.message ? error.message : error);
      console.warn(`Gemini ${attempt.model} 連線失敗：${lastText}`);
      continue;
    }
    lastStatus = response.getResponseCode();
    lastText = response.getContentText();

    if (lastStatus >= 200 && lastStatus < 300) return JSON.parse(lastText);
    if (lastStatus === 404) {
      unavailableModels.add(attempt.model);
      console.warn(`Gemini ${attempt.model} 已停用或目前不可用，自動改用下一個模型。`);
      continue;
    }
    if (!retryableStatuses.includes(lastStatus)) {
      throw new Error(geminiApiErrorMessage_(lastStatus, lastText));
    }
    console.warn(`Gemini ${attempt.model} 第 ${index + 1} 次失敗：HTTP ${lastStatus}`);
  }

  console.error(`Gemini 自動重試後仍失敗：HTTP ${lastStatus} ${lastText}`);
  throw new Error('Gemini 目前流量過高，自動重試與備用模型仍無法回應。請稍後 1～2 分鐘再試一次。');
}

function geminiApiErrorMessage_(status, text) {
  let message = '';
  try {
    const parsed = JSON.parse(text || '{}');
    message = parsed && parsed.error ? String(parsed.error.message || '') : '';
  } catch (error) {
    message = '';
  }
  if (status === 400) return `Gemini 無法分析這張照片：${message || '請換一張較清楚的餐點照片。'}`;
  if (status === 403) return 'Gemini API Key 無權使用此模型，請檢查 Google AI Studio 專案設定。';
  return `Gemini API ${status}：${message || '服務暫時無法使用。'}`;
}

function ensureSheet_(name, headers) {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  else sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  return sheet;
}

function getSpreadsheet_() {
  if (runtimeSpreadsheet_) return runtimeSpreadsheet_;
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) {
    runtimeSpreadsheet_ = SpreadsheetApp.openById(id);
    return runtimeSpreadsheet_;
  }
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('缺少 SPREADSHEET_ID，請先執行 setupProject。');
  runtimeSpreadsheet_ = active;
  return runtimeSpreadsheet_;
}

function getSheet_(name) {
  const sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error(`找不到工作表「${name}」，請先執行 setupProject。`);
  return sheet;
}

function getConfig_(key) {
  const sheet = getSheet_(APP.sheets.config);
  if (sheet.getLastRow() < 2) return '';
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  const row = values.find(item => String(item[0]) === key);
  return row ? String(row[1] || '') : '';
}

function setConfig_(key, value, description) {
  const sheet = getSheet_(APP.sheets.config);
  if (sheet.getLastRow() >= 2) {
    const keys = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().flat();
    const index = keys.findIndex(item => String(item) === key);
    if (index >= 0) {
      sheet.getRange(index + 2, 1, 1, 3).setValues([[key, value, description || '']]);
      return;
    }
  }
  sheet.appendRow([key, value, description || '']);
}

function seedFoods_() {
  const sheet = getSheet_(APP.sheets.foods);
  const rows = [
    ['common_yangtao_breakfast', '常見食物', '楊桃可口早餐', '1份', 410, '🍽️', '', true, '示範估算，請依實際內容校正', '中', 1],
    ['common_egg_sandwich', '常見食物', '煎蛋三明治', '1份', 350, '🥪', '', true, '示範估算，麵包與醬料會有差異', '中', 2],
    ['common_overnight_oats', '常見食物', '隔夜燕麥粥', '1碗', 300, '🥣', '', true, '示範估算，奶類與配料會有差異', '中', 3],
    ['common_boiled_egg', '常見食物', '水煮蛋', '1顆', 70, '🥚', '', true, '示範值，蛋的大小會有差異', '中', 4],
    ['staple_rice_half', '主食', '白飯', '半碗', 140, '🍚', '', true, '示範值，請依常用碗校正', '中', 10],
    ['staple_rice_bowl', '主食', '白飯', '1碗', 280, '🍚', '', true, '示範值，請依常用碗校正', '中', 11],
    ['staple_brown_half', '主食', '糙米飯', '半碗', 140, '🍚', '', true, '示範值', '中', 12],
    ['staple_toast', '主食', '白吐司', '1片', 80, '🍞', '', true, '示範值，品牌會有差異', '中', 13],
    ['staple_sweet_potato', '主食', '地瓜', '小條', 130, '🍠', '', true, '示範值，大小會有差異', '中', 14],
    ['staple_oat', '主食', '燕麥片', '乾重40g', 150, '🥣', '', true, '示範值', '較高', 15],
    ['protein_egg', '蛋白質', '雞蛋', '1顆', 70, '🥚', '', true, '示範值，大小會有差異', '較高', 30],
    ['protein_chicken', '蛋白質', '雞胸肉', '熟重100g', 165, '🍗', '', true, '示範值，烹調油另計', '較高', 31],
    ['protein_tofu', '蛋白質', '板豆腐', '100g', 90, '◻️', '', true, '示範值，品項會有差異', '中', 32],
    ['protein_salmon', '蛋白質', '鮭魚', '熟重100g', 210, '🐟', '', true, '示範值', '中', 33],
    ['protein_pork', '蛋白質', '瘦豬肉', '熟重100g', 200, '🥩', '', true, '示範值，部位會有差異', '中', 34],
    ['protein_beef', '蛋白質', '牛肉', '熟重100g', 250, '🥩', '', true, '示範值，部位會有差異', '低', 35],
    ['veg_boiled', '蔬菜', '燙青菜', '1碗', 60, '🥬', '', true, '示範值，醬料另計', '中', 50],
    ['veg_stir', '蔬菜', '炒青菜', '1碗', 100, '🥬', '', true, '示範值，油量差異大', '低', 51],
    ['veg_salad', '蔬菜', '生菜沙拉', '1碗不含醬', 50, '🥗', '', true, '示範值，醬料另計', '中', 52],
    ['fruit_banana', '水果', '香蕉', '中型1根', 105, '🍌', '', true, '示範值', '中', 70],
    ['fruit_apple', '水果', '蘋果', '中型1顆', 95, '🍎', '', true, '示範值', '中', 71],
    ['fruit_guava', '水果', '芭樂', '半顆', 70, '🍐', '', true, '示範值，大小會有差異', '中', 72],
    ['drink_soy', '飲料', '無糖豆漿', '400ml', 140, '🥛', '', true, '示範值，請優先看包裝', '中', 90],
    ['drink_milk', '飲料', '鮮奶', '240ml', 150, '🥛', '', true, '示範值，脂肪比例不同', '中', 91],
    ['drink_latte', '飲料', '拿鐵', '中杯無糖', 160, '☕', '', true, '示範值，奶量不同', '低', 92],
    ['drink_tea', '飲料', '無糖茶', '1杯', 0, '🍵', '', true, '無加糖與奶', '較高', 93],
    ['snack_nuts', '點心', '堅果', '小包25g', 150, '🥜', '', true, '示範值，請優先看包裝', '中', 110],
    ['snack_chocolate', '點心', '巧克力', '25g', 135, '🍫', '', true, '示範值，請優先看包裝', '中', 111],
    ['snack_yogurt', '點心', '無糖優格', '150g', 100, '🥣', '', true, '示範值，請優先看包裝', '中', 112],
    ['breakfast_egg_pancake', '早餐店', '原味蛋餅', '1份', 300, '🍳', '', true, '店家與油量差異大', '低', 130],
    ['breakfast_radish', '早餐店', '蘿蔔糕', '2片', 250, '⬜', '', true, '店家與油量差異大', '低', 131],
    ['meal_bento_half', '常見外食', '便當（飯減半）', '1盒', 620, '🍱', '', true, '示範估算，菜色差異大', '低', 150],
    ['meal_bento_full', '常見外食', '一般便當', '1盒', 780, '🍱', '', true, '示範估算，菜色差異大', '低', 151],
    ['meal_hotpot', '常見外食', '個人小火鍋', '1鍋不含飲料', 700, '🍲', '', true, '示範估算，湯料差異大', '低', 152],
    ['meal_noodle', '常見外食', '湯麵', '1碗', 500, '🍜', '', true, '示範估算，配料差異大', '低', 153],
  ];
  const rowsWithProtein = rows.map(row => row.concat(defaultFoodProteinG_(row[0])));
  const existingRows = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, APP.headers.foods.length).getValues()
    : [];
  const existingIds = new Set(existingRows.map(row => String(row[0])));
  // 之前版本曾把這個入口命名成「楊桃可怕早餐」，只更新這個固定 FoodId，避免留下重複卡片。
  const oldNameRow = existingRows.findIndex(row => String(row[0]) === 'common_yangtao_breakfast');
  if (oldNameRow >= 0 && String(existingRows[oldNameRow][2]) !== '楊桃可口早餐') {
    sheet.getRange(oldNameRow + 2, 3).setValue('楊桃可口早餐');
    CacheService.getScriptCache().remove('active-foods:v1');
    CacheService.getScriptCache().remove('active-foods:v2');
  }
  const proteinColumn = APP.headers.foods.length;
  if (existingRows.length) {
    const proteinRange = sheet.getRange(2, proteinColumn, existingRows.length, 1);
    const proteinValues = proteinRange.getValues();
    let proteinChanged = false;
    proteinValues.forEach((value, index) => {
      if (value[0] !== '' && value[0] !== null) return;
      const estimated = defaultFoodProteinG_(existingRows[index][0]);
      if (!estimated) return;
      value[0] = estimated;
      proteinChanged = true;
    });
    if (proteinChanged) proteinRange.setValues(proteinValues);
  }
  const missingRows = rowsWithProtein.filter(row => !existingIds.has(String(row[0])));
  if (missingRows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, missingRows.length, APP.headers.foods.length)
      .setValues(missingRows);
    CacheService.getScriptCache().remove('active-foods:v1');
    CacheService.getScriptCache().remove('active-foods:v2');
  }
}

function formatSheets_() {
  const ss = getSpreadsheet_();
  Object.values(APP.sheets).forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (!sheet) return;
    const lastColumn = sheet.getLastColumn();
    if (lastColumn) {
      sheet.getRange(1, 1, 1, lastColumn)
        .setBackground('#F5D77A')
        .setFontWeight('bold')
        .setHorizontalAlignment('center');
      sheet.autoResizeColumns(1, lastColumn);
    }
  });
}

function today_() {
  // 飲控日於台北時間 00:00 正式換日，需與前端跨日偵測及午夜結算一致。
  // 舊版曾扣除 3 小時，會讓 00:00～02:59 仍停在昨天，並觸發前端重載循環。
  return Utilities.formatDate(new Date(), APP.timezone, 'yyyy-MM-dd');
}

function dateKeyDaysAgo_(baseDateKey, days) {
  const matched = String(baseDateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) throw new Error('日期格式錯誤。');
  const date = new Date(Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])));
  date.setUTCDate(date.getUTCDate() - Math.abs(Number(days) || 0));
  return Utilities.formatDate(date, 'UTC', 'yyyy-MM-dd');
}

function allowedRecordDates_() {
  const today = today_();
  return [0, 1, 2, 3].map(days => dateKeyDaysAgo_(today, days));
}

function validateRecordDate_(value) {
  const recordDate = normalizeDateKey_(value || today_());
  if (!allowedRecordDates_().includes(recordDate)) {
    throw new Error('只能填寫今天，或補登最近三天的紀錄。');
  }
  return recordDate;
}

/** 公開牆可查今天與往前 29 天，共 30 個日期；無效日期一律回到今天。 */
function validatePublicWallDate_(value) {
  const today = today_();
  const candidate = normalizeDateKey_(value || today);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return today;
  const oldest = dateKeyDaysAgo_(today, 29);
  return candidate >= oldest && candidate <= today ? candidate : today;
}

function dateDaysAgo_(days, baseDate) {
  const date = baseDate instanceof Date ? baseDate : new Date();
  return Utilities.formatDate(
    new Date(date.getTime() - Math.abs(Number(days) || 0) * 24 * 60 * 60 * 1000),
    APP.timezone,
    'yyyy-MM-dd'
  );
}

function normalizeDateKey_(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return Utilities.formatDate(value, APP.timezone, 'yyyy-MM-dd');
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 20000 && value < 100000) {
    const utcDate = new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86400000));
    return Utilities.formatDate(utcDate, 'UTC', 'yyyy-MM-dd');
  }
  const text = String(value || '').trim();
  let matched = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日|\b)/);
  if (matched) {
    return `${matched[1]}-${String(matched[2]).padStart(2, '0')}-${String(matched[3]).padStart(2, '0')}`;
  }
  matched = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (matched) {
    return `${matched[3]}-${String(matched[1]).padStart(2, '0')}-${String(matched[2]).padStart(2, '0')}`;
  }
  return text;
}

function getLogRowDateKey_(row, displayRow) {
  const explicitCandidates = [row[1], displayRow && displayRow[1]];
  for (let i = 0; i < explicitCandidates.length; i += 1) {
    const key = normalizeDateKey_(explicitCandidates[i]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
  }

  const timestampCandidates = [row[19], row[0], displayRow && displayRow[19], displayRow && displayRow[0]];
  for (let i = 0; i < timestampCandidates.length; i += 1) {
    const key = normalizeDateKey_(timestampCandidates[i]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
  }
  return '';
}

function readJsonCache_(key) {
  try {
    const text = CacheService.getScriptCache().get(String(key || ''));
    return text ? JSON.parse(text) : null;
  } catch (error) {
    console.warn(`讀取快取失敗 ${key}：${error && error.message ? error.message : error}`);
    return null;
  }
}

function writeJsonCache_(key, value, seconds) {
  try {
    CacheService.getScriptCache().put(
      String(key || ''),
      JSON.stringify(value),
      Math.max(1, Math.min(21600, Number(seconds) || 60))
    );
    return true;
  } catch (error) {
    console.warn(`寫入快取失敗 ${key}：${error && error.message ? error.message : error}`);
    return false;
  }
}

function invalidateLogCache_(date, userId) {
  date = String(date || '');
  const cache = CacheService.getScriptCache();
  cache.remove(`logs-for-date:v4:${date}`);
  cache.remove(`public-wall-base:v2:${date}`);
  cache.remove(`public-wall-base:v3:${date}`);
  cache.remove(`public-wall-base:v4:${date}`);
  cache.remove(`public-wall-base:v5:${date}`);
  cache.remove(`public-wall-base:v6:${date}`);
  cache.remove(`public-wall-base:v7:${date}`);
  cache.remove(`public-wall-base:v8:${date}`);
  invalidateGroupWallCachesForUser_(date, userId);
  // 補登過去日期可能改變「公開連續打卡」，因此也要清掉今日公開頁快取。
  if (date && date !== today_()) {
    cache.remove(`public-wall-base:v2:${today_()}`);
    cache.remove(`public-wall-base:v3:${today_()}`);
    cache.remove(`public-wall-base:v4:${today_()}`);
    cache.remove(`public-wall-base:v5:${today_()}`);
    cache.remove(`public-wall-base:v6:${today_()}`);
    cache.remove(`public-wall-base:v7:${today_()}`);
    cache.remove(`public-wall-base:v8:${today_()}`);
  }
  if (userId) {
    cache.remove(`history:v1:${userId}:30:${today_()}`);
    cache.remove(`history:v2:${userId}:30:${today_()}`);
    cache.remove(`history:v2:${userId}:365:${today_()}`);
    cache.remove(`history:v3:${userId}:30:${today_()}`);
    cache.remove(`history:v3:${userId}:365:${today_()}`);
    try {
      cache.remove(`public-like-target:v2:${publicLikeTargetKey_(userId)}`);
    } catch (error) {
      console.warn(`清除公開按讚對象快取失敗：${error && error.message ? error.message : error}`);
    }
  }
}

function invalidateGroupWallCachesForUser_(date, userId) {
  if (!date || !userId) return;
  const cache = CacheService.getScriptCache();
  getActiveGroupIdsForUser_(userId).forEach(groupId => {
    cache.remove(`group-wall-base:v2:${groupId}:${date}`);
    cache.remove(`group-wall-base:v3:${groupId}:${date}`);
  });
}

/** 將一位成員所有既有每日紀錄統一成相同的群組牆分享狀態。 */
function setGroupWallVisibilityForUser_(userId, visible) {
  userId = String(userId || '');
  if (!userId) return 0;
  const sheet = getSheet_(APP.sheets.logs);
  ensureLogStatusHeader_(sheet);
  const rowCount = sheet.getLastRow() - 1;
  if (rowCount <= 0) return 0;

  const userIds = sheet.getRange(2, 3, rowCount, 1).getValues();
  const flagRange = sheet.getRange(2, 27, rowCount, 1);
  const flags = flagRange.getValues();
  const desired = Boolean(visible);
  let changed = 0;
  flags.forEach((row, index) => {
    if (String(userIds[index][0] || '') !== userId) return;
    const current = row[0] === true || String(row[0]).toUpperCase() === 'TRUE';
    if (current === desired) return;
    row[0] = desired;
    changed += 1;
  });
  if (changed) flagRange.setValues(flags);
  invalidateAllGroupWallCachesForUser_(userId);
  return changed;
}

function invalidateAllGroupWallCachesForUser_(userId) {
  userId = String(userId || '');
  if (!userId) return;
  const cache = CacheService.getScriptCache();
  getActiveGroupIdsForUser_(userId).forEach(groupId => {
    for (let daysAgo = 0; daysAgo < 30; daysAgo += 1) {
      cache.remove(`group-wall-base:v2:${groupId}:${dateKeyDaysAgo_(today_(), daysAgo)}`);
      cache.remove(`group-wall-base:v3:${groupId}:${dateKeyDaysAgo_(today_(), daysAgo)}`);
    }
  });
}

function invalidateGroupWallCachesForGroup_(groupId) {
  groupId = String(groupId || '');
  if (!groupId) return;
  const cache = CacheService.getScriptCache();
  for (let daysAgo = 0; daysAgo < 30; daysAgo += 1) {
    cache.remove(`group-wall-base:v2:${groupId}:${dateKeyDaysAgo_(today_(), daysAgo)}`);
    cache.remove(`group-wall-base:v3:${groupId}:${dateKeyDaysAgo_(today_(), daysAgo)}`);
  }
}

function jsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function parseJsonObject_(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function cleanText_(value, maxLength) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, maxLength || 500);
}

function numberInRange_(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(max, Math.max(min, number));
}

/** 蛋白質以 g 為單位，保留一位小數；避免 AI 或手動輸入寫進不合理的大值。 */
function proteinGrams_(value) {
  const grams = numberInRange_(value, 0, 500);
  return Math.round(grams * 10) / 10;
}

function safeEqual_(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
