const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const backend = fs.readFileSync('apps-script/Code.gs', 'utf8');
const frontend = fs.readFileSync('apps-script/Index.html', 'utf8');

test('report comparisons use matching days and distinguish sparse or unfinished records', () => {
  const source = fs.readFileSync('apps-script/History.html', 'utf8');
  const c = vm.createContext({ records: [], data: { today: '2026-03-31' } });
  for (const name of ['parseDateKey', 'dateKey', 'dateLabel', 'previousMonthKey_', 'monthLabel_', 'completedStreak_', 'averageOf_', 'isCalorieGoalReached_', 'addDateDays_', 'buildMonthlyStats_', 'buildWeeklyStats_', 'comparisonObservation_']) {
    if (name === 'dateLabel') { vm.runInContext('function dateLabel(v) { return v.slice(5); }', c); continue; }
    const start = source.indexOf('      function ' + name + '(');
    const end = source.indexOf('\n      function ', start + 1);
    vm.runInContext(source.slice(start, end), c);
  }
  const record = date => ({ date, status: '完成' });
  c.records = ['2026-03-01','2026-03-02','2026-03-03','2026-03-31','2026-02-01','2026-02-02','2026-02-03'].map(record);
  const month = c.buildMonthlyStats_('2026-03');
  assert.equal(month.comparisonDays, 28);
  assert.equal(month.comparisonCompleted, 3);
  assert.equal(c.comparisonObservation_(month).value, '0 天');
  c.data.today = '2026-09-17';
  c.records = ['2026-09-14','2026-09-15','2026-09-16','2026-09-07','2026-09-08','2026-09-09','2026-09-12'].map(record);
  const week = c.buildWeeklyStats_('2026-09-14');
  assert.equal(week.comparisonDays, 4);
  assert.equal(week.previousCompleted, 3);
  assert.equal(c.comparisonObservation_(week).value, '0 天');
  assert.equal(c.comparisonObservation_({ ...week, previousLoggedDays: 0 }).value, '上一期無紀錄');
  assert.equal(c.comparisonObservation_({ ...week, previousCompleted: 0 }).value, '上一期無完成紀錄');
  assert.equal(c.comparisonObservation_({ ...week, loggedDays: 1 }).value, '同期資料較少');
});

function server(overrides = {}) {
  const c = vm.createContext({ console: { info() {}, warn() {}, error() {} }, ...overrides });
  vm.runInContext(backend, c);
  return c;
}

function client() {
  const timers = new Map(), storage = new Map(), events = {}, requests = [];
  let timerId = 0;
  const fields = Object.fromEntries(['name', 'bmr', 'publicAlias', 'publishToday', 'publishFoodDetails', 'joinPublicRanking', 'publishToGroup'].map(id => [id, { value: id === 'bmr' ? 1400 : 'Test', checked: false }]));
  const state = { recordDate: '2026-09-16', mealRevision: 1, savedMealRevision: 0, retryCount: 0, queuedUserSave: null, saveInFlight: false, pendingAutoComplete: false, waterEnabled: true, waterGoalMl: 2000, waterMl: 500 };
  const localStorage = { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k), key: i => [...storage.keys()][i], get length() { return storage.size; } };
  const c = vm.createContext({
    state, settingsWriteBusy:false, settingsDeferredSave:null, console: { info() {} }, navigator: { onLine: true }, performance: { now: () => 100 },
    BOOTSTRAP: { uid: 'u1', sig: 'secret', today: state.recordDate }, MEMBER: {}, WATER_SETTINGS: {}, DAILY_LOGS: {}, todayIsComplete: false,
    window: { localStorage, setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout(id) { timers.delete(id); }, addEventListener: (name, fn) => { events[name] = fn; } },
    document: { getElementById: id => fields[id] || null, addEventListener: (name, fn) => { events[name] = fn; } },
    exerciseSummary: () => ({ name: '', minutes: 0, kcal: 0, records: [] }), serializeMeals: () => ({ breakfast: [{ id: 'egg', quantity: 1 }] }), serializeAiMeals: () => ({}), grandTotal: () => 100,
    updateSubmitButtons() {}, showToast() {}, setSavingState(value) { state.userSubmitPending = value; },
    loadRecordDate(date) { state.recordDate = date; }, navigateToFreshToday_() {},
    google: { script: { get run() { const req = {}; return { withSuccessHandler(fn) { req.ok = fn; return this; }, withFailureHandler(fn) { req.fail = fn; return this; }, saveDailyLog(payload) { req.payload = payload; requests.push(req); } }; } } },
  });
  for (const name of ['buildSavePayload_', 'draftKey_', 'persistLocalDraft_', 'clearLocalDraft_', 'cleanupLocalDrafts_', 'offerLocalDraft_', 'bindSaveRecovery_', 'isTransientSaveError_', 'finishSave', 'submitLog']) {
    const start = frontend.indexOf(`    function ${name}(`);
    assert.ok(start >= 0, name);
    const end = frontend.indexOf('\n    function ', start + 1);
    vm.runInContext(frontend.slice(start, end), c);
  }
  return { c, state, storage, requests, events, timers };
}

const success = { isComplete: false, totalIntake: 100 };
test('all Apps Script and HTML scripts parse', () => {
  new vm.Script(backend);
  for (const name of fs.readdirSync('apps-script').filter(n => n.endsWith('.html'))) {
    const html = fs.readFileSync(`apps-script/${name}`, 'utf8');
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/application\/json/.test(match[1])) continue;
      new vm.Script(match[2].replace(/<\?[\s\S]*?\?>/g, 'null'), { filename: name });
    }
  }
});

test('backfill invalidates current and historical walls with one batch', () => {
  const batches = [];
  const c = server({ Utilities: { formatDate: date => date.toISOString().slice(0, 10) }, CacheService: { getScriptCache: () => ({ removeAll: keys => batches.push(keys) }) } });
  c.today_ = () => '2026-09-16'; c.getActiveGroupIdsForUser_ = () => ['g1']; c.publicLikeTargetKey_ = () => 'opaque';
  c.invalidateLogCache_('2026-09-15', 'u1');
  assert.equal(batches.length, 1);
  assert.ok(batches[0].includes('public-wall-base:v9:2026-09-16'));
  assert.ok(batches[0].includes('public-wall-base:v9:2026-08-18'));
  assert.ok(batches[0].includes('group-wall-base:v4:g1:2026-09-15'));
  assert.ok(batches[0].includes('history:v5:u1:365:2026-09-16'));
  assert.equal(new Set(batches[0]).size, batches[0].length);
});

test('daily save skips unchanged water preferences and flushes before unlocking', () => {
  let held = false, writes = 0, flushes = 0;
  const c = server({
    LockService: { getScriptLock: () => ({ waitLock() { held = true; }, releaseLock() { assert.equal(flushes > 0, true); held = false; } }) },
    CacheService: { getScriptCache: () => ({ removeAll() {} }) },
    SpreadsheetApp: { flush() { assert.ok(held); flushes++; } },
  });
  c.inspectAccessToken_ = () => 'ok'; c.validateRecordDate_ = () => '2026-09-16'; c.today_ = () => '2026-09-16';
  c.getMemberById_ = () => ({ name: 'Test', bmr: 1400 }); c.getFoods_ = () => []; c.getActiveGroupIdsForUser_ = () => [];
  c.getWaterSettings_ = () => ({ enabled: true, goalMl: 2000 }); c.saveWaterSettings_ = () => { writes++; };
  c.upsertDailyRow_ = () => { assert.ok(held); };
  const result = c.saveDailyLog({ uid: 'u1', bmr: 1400, waterEnabled: true, waterGoalMl: 2000 });
  assert.equal(writes, 0); assert.equal(held, false); assert.ok(result.timing.totalMs >= 0);
  c.saveDailyLog({ uid: 'u1', bmr: 1400, waterEnabled: true, waterGoalMl: 2500 });
  assert.equal(writes, 1);
});

test('reminders release the shared lock during LINE calls and resume only failed recipients', () => {
  const props = new Map(), sent = [], retryKeys = []; let held = false, failSecond = true, config = '', seq = 0;
  const c = server({
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props.get(key), setProperty: (key, value) => props.set(key, value) }) },
    Utilities: { getUuid: () => `uuid-${++seq}` }, SpreadsheetApp: { flush() {} },
    LockService: { getScriptLock: () => ({ tryLock() { assert.equal(held, false); held = true; return true; }, waitLock() { assert.equal(held, false); held = true; }, releaseLock() { held = false; } }) },
  });
  c.today_ = () => '2026-09-16'; c.getConfig_ = () => config; c.setConfig_ = (key, value) => { config = value; };
  c.getTodayLogs_ = () => []; c.getReminderMembers_ = () => [{ userId: 'a' }, { userId: 'b' }]; c.getScheduledLaunchUrl_ = () => 'https://example.test';
  c.pushMessage_ = (id, messages, retryKey) => {
    assert.equal(held, false); sent.push(id); retryKeys.push(retryKey);
    assert.equal(c.sendReminderForSlot_('09:00').skipped, 'another_run_active');
    return !(id === 'b' && failSecond);
  };
  assert.equal(c.sendReminderForSlot_('09:00').failed, 1);
  assert.equal(config, '');
  failSecond = false;
  assert.equal(c.sendReminderForSlot_('09:00').ok, true);
  assert.deepEqual(sent, ['a', 'b', 'b']);
  assert.equal(retryKeys[1], retryKeys[2]);
  assert.equal(c.sendReminderForSlot_('09:00').skipped, 'already_sent');
});

test('cached-row miss searches older records before appending', () => {
  const rows = Array.from({ length: 150 }, (_, i) => [null, '2026-09-15', `u${i}`]);
  rows[2] = [null, '2026-09-16', 'target']; let written;
  const sheet = { getLastRow: () => 150, getRange(row, col, count = 1, width = 1) { return {
    getValues: () => rows.slice(row - 1, row - 1 + count).map(r => r.slice(col - 1, col - 1 + width)),
    setNumberFormat() {}, setValues(values) { written = { row, values }; },
  }; } };
  const c = server({ CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) } });
  c.getSheet_ = () => sheet; c.ensureLogStatusHeader_ = () => {}; c.invalidateLogCache_ = () => {};
  c.upsertDailyRow_('2026-09-16', 'target', ['updated']);
  assert.equal(written.row, 3);
});

test('draft omits credentials, survives failure, and is removed only on success', () => {
  const { c, storage, requests } = client();
  c.submitLog(false, true);
  const draft = JSON.parse([...storage.values()][0]);
  assert.equal(draft.payload.sig, undefined); assert.equal(draft.payload.uid, undefined);
  assert.equal(draft.payload.waterMl, 500);
  requests[0].fail(new Error('Network error'));
  assert.equal(storage.size, 1);
  c.submitLog(false, true); requests[1].ok(success);
  assert.equal(storage.size, 0);
});

test('transient failures retry at 2, 5, 10 seconds and then stop', () => {
  const { c, requests, timers, state } = client();
  c.submitLog(false, true);
  for (const delay of [2000, 5000, 10000]) {
    requests.at(-1).fail(new Error('Lock timeout'));
    const [id, timer] = [...timers].at(-1);
    assert.equal(timer.ms, delay); timers.delete(id); timer.fn();
  }
  requests.at(-1).fail(new Error('Lock timeout'));
  assert.equal(requests.length, 4); assert.equal(timers.size, 0);
  assert.match(state.saveError, /尚未同步/);
});

test('settings write queues a daily save without losing its local draft', () => {
  const {c,requests,storage}=client();
  c.settingsWriteBusy=true;
  c.submitLog(true,false);
  assert.equal(requests.length,0);
  assert.equal(storage.size,1);
  assert.equal(c.settingsDeferredSave.markComplete,true);
  const start=frontend.indexOf('    function resumeFormSave_(');
  vm.runInContext(frontend.slice(start,frontend.indexOf('\n    async function ',start+1)),c);
  c.resumeFormSave_();
  assert.equal(c.settingsWriteBusy,false);
  assert.equal(requests.length,1);
  assert.equal(c.settingsDeferredSave,null);
});

test('an old autosave cannot cancel deferred completion, but a new edit can', () => {
  const {c,state,storage}=client();
  c.settingsWriteBusy=true;
  c.submitLog(true,false);
  c.submitLog(false,true);
  assert.equal(c.settingsDeferredSave.markComplete,true);
  assert.equal(state.pendingAutoComplete,true);
  assert.equal(JSON.parse([...storage.values()][0]).payload.isComplete,true);
  state.mealRevision++;
  c.submitLog(false,true);
  assert.equal(c.settingsDeferredSave.markComplete,false);
  assert.equal(state.pendingAutoComplete,false);
});

test('expired credentials do not retry or send automatically on reconnect', () => {
  const { c, requests, timers, events } = client(); c.bindSaveRecovery_();
  c.submitLog(false, true); requests[0].fail(new Error('這個連結已經過期了'));
  events.online(); c.submitLog(false, true);
  assert.equal(requests.length, 1); assert.equal(timers.size, 0);
});

test('offline completion is synchronized after reconnect even with no new meal changes', () => {
  const { c, state, requests, events } = client(); c.bindSaveRecovery_();
  state.savedMealRevision = state.mealRevision; c.navigator.onLine = false;
  c.submitLog(true, false); assert.equal(requests.length, 0);
  assert.ok(state.mealRevision > state.savedMealRevision);
  c.navigator.onLine = true; events.online();
  assert.equal(requests[0].payload.isComplete, true);
});

test('in-flight success retains newer edits and does not falsely mark them completed', () => {
  const { c, state, storage, requests, timers } = client();
  c.submitLog(true, false);
  state.mealRevision++; state.pendingAutoComplete = false; state.waterMl = 700; c.persistLocalDraft_(false);
  requests[0].ok({ ...success, isComplete: true });
  assert.equal(c.todayIsComplete, false); assert.equal(storage.size, 1);
  assert.equal(JSON.parse([...storage.values()][0]).payload.waterMl, 700);
  assert.equal([...timers.values()][0].ms, 650);
});

test('blocked local storage does not prevent a cloud save', () => {
  const { c, requests, state } = client(); c.window.localStorage.setItem = () => { throw new Error('denied'); };
  c.submitLog(false, true); assert.equal(state.draftStored, false); assert.equal(requests.length, 1);
  requests[0].ok(success);
});

test('date switch waits for successful retry and cleans up its draft first', () => {
  const { c, state, requests, timers, storage } = client();
  state.pendingDateSwitch = '2026-09-15'; c.submitLog(false, true);
  requests[0].fail(new Error('Network error')); assert.equal(state.recordDate, '2026-09-16');
  [...timers.values()][0].fn(); requests[1].ok(success);
  assert.equal(state.recordDate, '2026-09-15'); assert.equal(storage.size, 0);
});

test('recovering a draft requires a choice and does not automatically overwrite cloud data', () => {
  const { c, state, requests, events } = client();
  const panels = [];
  c.el = (tag, className, text) => ({ text, children: [], handlers: {}, append(...items) { this.children.push(...items); }, addEventListener(name, fn) { this.handlers[name] = fn; }, remove() {} });
  c.app = { prepend(panel) { panels.push(panel); } };
  c.renderApp = () => {};
  c.hydrateStateFromDailyLog = log => { state.waterMl = log.waterMl; };
  c.updateTotals = () => {}; c.updatePublicSettingsSummary = () => {};
  c.persistLocalDraft_(false); state.waterMl = 900;
  c.offerLocalDraft_(); c.bindSaveRecovery_();
  assert.equal(requests.length, 0); assert.equal(state.waterMl, 900);
  const restore = panels[0].children[1]; restore.handlers.click();
  assert.equal(state.waterMl, 500); assert.equal(state.draftNeedsReview, true);
  events.online(); assert.equal(requests.length, 0);
  c.submitLog(true, false); assert.equal(requests.length, 1);
  assert.equal(requests[0].payload.waterMl, 500);
});

test('queued completion survives an in-flight failure and retries with the completion intent', () => {
  const { c, requests, timers, state } = client();
  c.submitLog(false, true); c.submitLog(true, false);
  requests[0].fail(new Error('Network error'));
  assert.equal(state.pendingAutoComplete, true);
  [...timers.values()][0].fn();
  assert.equal(requests[1].payload.isComplete, true);
});

test('LINE retry key is sent and accepted-duplicate response counts as success only with a retry key', () => {
  const headers = [];
  const c = server({ UrlFetchApp: { fetch(url, options) {
    headers.push(options.headers);
    return { getResponseCode: () => 409, getContentText: () => 'already accepted' };
  } } });
  c.getLineToken_ = () => 'test-token';
  assert.equal(c.pushMessage_('u1', [{ type: 'text', text: 'test' }], 'retry-key'), true);
  assert.equal(headers[0]['X-Line-Retry-Key'], 'retry-key');
  assert.equal(c.pushMessage_('u1', [{ type: 'text', text: 'test' }]), false);
});

test('history copy loads one authorized day and returns meal data only', () => {
  const row = Array(28).fill('');
  row[1] = '2026-09-01';
  row[2] = 'u1';
  row[4] = 80;
  row[17] = JSON.stringify({ breakfast: [{ id: 'egg', name: '蛋', quantity: 1, calories: 80 }] });
  row[20] = '完成';
  const sheet = {
    getLastRow: () => 2,
    getRange: () => ({ getValues: () => [row] }),
  };
  const c = server({ Utilities: { formatDate: date => date.toISOString().slice(0, 10) } });
  c.inspectAccessToken_ = () => 'ok';
  c.today_ = () => '2026-09-17';
  c.getSheet_ = () => sheet;
  c.ensureLogStatusHeader_ = () => {};
  c.getFoods_ = () => [{ id: 'egg' }];
  const result = c.getHistoryCopyDraftForClient({ uid:'u1', sig:'valid', sourceDate:'2026-09-01' });
  assert.equal(result.sourceDate, '2026-09-01');
  assert.equal(result.targetDate, '2026-09-17');
  assert.deepEqual(JSON.parse(JSON.stringify(result.meals.breakfast)), [{ id:'egg', quantity:1 }]);
  assert.equal(result.waterMl, undefined);
  assert.equal(result.exerciseRecords, undefined);
  assert.equal(result.isComplete, undefined);
  assert.throws(() => c.getHistoryCopyDraftForClient({ uid:'u1', sig:'valid', sourceDate:'2026-09-17' }), /今天以前/);
  c.inspectAccessToken_ = () => 'expired';
  assert.throws(() => c.getHistoryCopyDraftForClient({ uid:'u1', sig:'expired', sourceDate:'2026-09-01' }), /過期/);
});

test('history page includes unified filters, calendar, batching, chart selection, and record actions', () => {
  const history = fs.readFileSync('apps-script/History.html', 'utf8');
  for (const marker of [
    'data-history-range', 'history-section-tab', 'historyTrend', 'historyRecordContent',
    'data-history-view', 'renderCalendar_', 'data-load-more',
    'data-chart-date', '前往補登', 'data-copy-date', 'getHistoryCopyDraftForClient',
  ]) assert.match(history, new RegExp(marker));
  assert.match(frontend, /copyMealsOnly/);
});
