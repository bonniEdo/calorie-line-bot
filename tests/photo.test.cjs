const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const backend = fs.readFileSync('apps-script/Code.gs', 'utf8');
const frontend = fs.readFileSync('apps-script/Index.html', 'utf8');
const food = { name:'測試餐點', portion:'一份', estimatedAmount:120, unit:'g', estimatedCalories:180, estimatedProteinG:12.5, caloriesLow:150, caloriesHigh:220, confidence:'中', notes:'油量不確定' };
const response = (items = [food]) => ({ candidates:[{ finishReason:'STOP', content:{ parts:[{ text:JSON.stringify({ items }) }] } }] });
const payload = { uid:'private-user', sig:'private-signature', imageDataUrl:'data:image/jpeg;base64,cHJpdmF0ZS1pbWFnZQ==' };

function server(steps = [{}]) {
  let now = 0, quotaCalls = 0;
  const calls = [], logs = [], sleeps = [];
  const math = Object.create(Math); math.random = () => 0;
  const c = vm.createContext({
    Date:class extends Date { static now() { return now; } }, Math:math,
    console:{ info:line => logs.push(JSON.parse(line)) },
    PropertiesService:{ getScriptProperties:() => ({ getProperty:() => 'private-api-key' }) },
    Utilities:{ sleep:ms => { sleeps.push(ms); now += ms; } },
    UrlFetchApp:{ fetch:(url, options) => {
      const step = steps[calls.length];
      calls.push({ model:url.split('/models/')[1].split(':')[0], body:JSON.parse(options.payload) });
      assert.ok(step, 'unexpected extra AI request');
      now += step.ms === undefined ? 100 : step.ms;
      if (step.network) throw new Error('private-api-key private-user raw network error');
      return {
        getResponseCode:() => step.status || 200,
        getContentText:() => step.raw === undefined ? JSON.stringify(step.body || response()) : step.raw,
        getAllHeaders:() => step.headers || {},
      };
    } },
  });
  vm.runInContext(backend, c);
  c.inspectAccessToken_ = () => { now += 10; return 'ok'; };
  c.consumePhotoQuota_ = () => { quotaCalls++; now += 25; };
  return { c, calls, logs, sleeps, quotaCalls:() => quotaCalls };
}

test('photo success uses the compact schema and preserves nutrition, uncertainty and old client fields', () => {
  const s = server([{ body:response([food, { ...food, name:'飲料', unit:'ml', estimatedAmount:250 }]) }]);
  const result = s.c.analyzeFoodPhoto(payload);
  assert.equal(s.calls.length, 1); assert.equal(s.quotaCalls(), 1);
  const config = s.calls[0].body.generationConfig;
  assert.deepEqual(config.responseSchema.required, ['items']);
  assert.equal(config.responseSchema.properties.items.maxItems, 12);
  assert.equal(config.responseSchema.properties.items.items.properties.estimatedGrams, undefined);
  assert.deepEqual(config.responseSchema.properties.items.items.required, ['n','s','a','u','k','p','l','h','c','x']);
  assert.equal(result.items[0].estimatedGrams, 120);
  assert.equal(result.items[1].estimatedGrams, 0);
  assert.equal(result.items[1].estimatedAmount, 250);
  assert.equal(result.totalProteinG, 25);
  assert.equal(result.totalCaloriesLow, 300); assert.equal(result.totalCaloriesHigh, 440);
  assert.equal(result.items[0].notes, food.notes);
  assert.equal(result.summary, ''); assert.equal(result.warnings.length, 0);
  assert.equal(result.timing.prepareMs, 35); assert.equal(result.timing.quotaMs, 25);
  assert.equal(result.timing.aiMs, 100); assert.equal(result.timing.totalMs, 135);
  assert.equal(result.timing.outcome, 'success');
  assert.equal(s.logs[0].attempts[0].outcome, 'success');
  for (const privateText of [payload.uid, payload.sig, payload.imageDataUrl, 'private-api-key', food.name, food.notes]) {
    assert.ok(!JSON.stringify(s.logs).includes(privateText));
  }
});

test('compact AI output restores all user-visible fields without discarding uncertainty or zero protein', () => {
  const compact = { n:food.name, s:food.portion, a:food.estimatedAmount, u:food.unit, k:food.estimatedCalories, p:0, l:food.caloriesLow, h:food.caloriesHigh, c:food.confidence, x:food.notes };
  const s = server([{ body:response([compact]) }]);
  const result = s.c.analyzeFoodPhoto(payload);
  assert.equal(result.items[0].name, food.name);
  assert.equal(result.items[0].portion, food.portion);
  assert.equal(result.items[0].estimatedAmount, food.estimatedAmount);
  assert.equal(result.items[0].estimatedCalories, food.estimatedCalories);
  assert.equal(result.items[0].estimatedProteinG, 0);
  assert.equal(result.items[0].notes, food.notes);
  assert.equal(result.items[0].confidence, food.confidence);
  assert.equal(result.items[0].caloriesLow, food.caloriesLow);
  assert.equal(result.items[0].caloriesHigh, food.caloriesHigh);
  // Same nutrition and descriptions; the saving is transport keys, not lost information.
  const verboseBytes = Buffer.byteLength(JSON.stringify({items:[{...food,estimatedProteinG:0}]}));
  const compactBytes = Buffer.byteLength(JSON.stringify({items:[compact]}));
  assert.ok(compactBytes < verboseBytes * 0.8);
  const invalid = server([{ body:response([{...compact,a:'120'}]) }, {}]);
  assert.equal(invalid.c.analyzeFoodPhoto(payload).ok,true);
  assert.equal(invalid.calls.length,2);
});

test('transport and malformed food results share three attempts, with no second retry loop', () => {
  const s = server([{ status:503 }, { raw:JSON.stringify({ candidates:[{ content:{ parts:[{ text:'{"items":[' }] } }] }) }, {}]);
  const result = s.c.analyzeFoodPhoto(payload);
  assert.equal(s.calls.length, 3); assert.equal(s.quotaCalls(), 1);
  assert.deepEqual(s.sleeps, [800]);
  assert.deepEqual(s.logs[0].attempts.map(a => a.outcome), ['http_error', 'invalid_response', 'success']);
  assert.equal(result.timing.aiMs, 300); assert.equal(result.timing.retryWaitMs, 800);
  assert.equal(result.timing.totalMs, 1135);
  const failed = server([{ network:true }, { raw:'broken private response' }, { raw:'{}' }]);
  assert.throws(() => failed.c.analyzeFoodPhoto(payload), /格式不完整/);
  assert.equal(failed.calls.length, 3); assert.equal(failed.quotaCalls(), 1);
  assert.equal(failed.logs[0].outcome, 'failed');
  assert.equal(failed.logs[0].attempts[0].outcome, 'network_error');
  assert.ok(!JSON.stringify(failed.logs).includes('private'));
});

test('temporary errors back off, missing models skip immediately, and client errors do not retry', () => {
  const busy = server([{ status:503 }, { status:429 }, {}]);
  busy.c.analyzeFoodPhoto(payload);
  assert.deepEqual(busy.sleeps, [800, 1600]);
  const unavailable = server([{ status:404 }, { status:404 }, {}]);
  unavailable.c.analyzeFoodPhoto(payload);
  assert.deepEqual(unavailable.sleeps, []); assert.equal(unavailable.calls.length, 3);
  for (const status of [400, 401, 403]) {
    const s = server([{ status, body:{ error:{ message:'invalid request' } } }]);
    assert.throws(() => s.c.analyzeFoodPhoto(payload));
    assert.equal(s.calls.length, 1); assert.deepEqual(s.sleeps, []);
    assert.equal(s.logs[0].attempts[0].status, status);
  }
});

test('the retry time budget stops additional calls but still accepts a slow successful response', () => {
  const slowFailure = server([{ ms:26000, status:503 }]);
  assert.throws(() => slowFailure.c.analyzeFoodPhoto(payload));
  assert.equal(slowFailure.calls.length, 1); assert.deepEqual(slowFailure.sleeps, []);
  const slowSuccess = server([{ ms:26000 }]);
  assert.equal(slowSuccess.c.analyzeFoodPhoto(payload).ok, true);
  const retryAfter = server([{ status:429, headers:{ 'Retry-After':'60' } }]);
  assert.throws(() => retryAfter.c.analyzeFoodPhoto(payload), /使用量/);
  assert.equal(retryAfter.calls.length, 1); assert.deepEqual(retryAfter.sleeps, []);
  const shortWait = server([{ status:503, headers:{ 'retry-after':'2' } }, {}]);
  shortWait.c.analyzeFoodPhoto(payload);
  assert.deepEqual(shortWait.sleeps, [2000]);
});

test('empty food results succeed; wrong shapes and truncated results recover without swallowing blocked responses', () => {
  const empty = server([{ body:response([]) }]);
  assert.equal(empty.c.analyzeFoodPhoto(payload).items.length, 0);
  assert.equal(empty.calls.length, 1);
  for (const body of [{}, response([null]), response([{ ...food, estimatedAmount:'120' }]), response([{ ...food, estimatedAmount:0 }]), { candidates:[{ finishReason:'MAX_TOKENS', content:{ parts:[{ text:'{"items":[]}' }] } }] }]) {
    const s = server([{ body }, {}]);
    assert.equal(s.c.analyzeFoodPhoto(payload).items.length, 1);
    assert.equal(s.calls.length, 2);
  }
  for (const body of [{ promptFeedback:{ blockReason:'SAFETY' } }, { candidates:[{ finishReason:'SAFETY' }] }]) {
    const s = server([{ body }]);
    assert.throws(() => s.c.analyzeFoodPhoto(payload), /無法完成辨識/);
    assert.equal(s.calls.length, 1); assert.equal(s.logs[0].attempts[0].outcome, 'blocked');
  }
});

test('photo validation and quota failures never call AI and still record failed phase timing', () => {
  const invalid = server(); invalid.c.inspectAccessToken_ = () => 'expired';
  assert.throws(() => invalid.c.analyzeFoodPhoto(payload));
  assert.equal(invalid.quotaCalls(), 0); assert.equal(invalid.calls.length, 0);
  assert.equal(invalid.logs[0].phase, 'validate');
  const badImage = server();
  assert.throws(() => badImage.c.analyzeFoodPhoto({ ...payload, imageDataUrl:'not-an-image' }));
  assert.equal(badImage.quotaCalls(), 0); assert.equal(badImage.calls.length, 0);
  const quota = server(); quota.c.consumePhotoQuota_ = () => { throw new Error('quota'); };
  assert.throws(() => quota.c.analyzeFoodPhoto(payload), /quota/);
  assert.equal(quota.calls.length, 0); assert.equal(quota.logs[0].phase, 'quota');
});

test('the generic Gemini connection check still returns its original response shape', () => {
  const s = server([{ body:{ candidates:[{ content:{ parts:[{ text:'ok' }] } }] } }]);
  const result = s.c.callGemini_([{ text:'ping' }], { maxOutputTokens:80 });
  assert.equal(result.candidates[0].content.parts[0].text, 'ok');
});

function client() {
  let now = 0, id = 0;
  const timers = new Map(), logs = [];
  const state = { analyzing:false, aiWaitTimer:null, photoAnalysis:{} };
  const status = { textContent:'' };
  const c = vm.createContext({ state, performance:{ now:() => now }, console:{ info:(event, data) => logs.push({ event, ...data }) },
    window:{ setTimeout:(fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimeout:key => timers.delete(key) },
    document:{ getElementById:key => key === 'aiStatus' ? status : null },
  });
  for (const name of ['setAnalyzing', 'logPhotoAnalysis_']) {
    const start = frontend.indexOf('    function ' + name + '(');
    const end = frontend.indexOf('\n    function ', start + 1);
    vm.runInContext(frontend.slice(start, end), c);
  }
  const advance = () => { const [key, timer] = timers.entries().next().value; timers.delete(key); now += timer.ms; timer.fn(); };
  return { c, state, status, timers, logs, advance, setNow:value => { now = value; } };
}

test('waiting feedback changes at 10 and 25 seconds and is cleared on success or failure', () => {
  const s = client();
  s.c.setAnalyzing(true, '正在處理照片…', 'prepare');
  s.advance(); assert.match(s.status.textContent, /較大的照片/);
  s.c.setAnalyzing(true, '正在辨識餐點…', 'request');
  assert.equal([...s.timers.values()][0].ms, 10000);
  s.advance(); assert.match(s.status.textContent, /其他分頁/);
  assert.equal([...s.timers.values()][0].ms, 15000);
  s.advance(); assert.match(s.status.textContent, /等待較久/);
  for (const message of ['分析完成', '辨識未完成']) {
    s.c.setAnalyzing(true, '等待', 'request');
    const queued = [...s.timers.values()][0].fn;
    s.c.setAnalyzing(false, message);
    assert.equal(s.timers.size, 0); assert.equal(s.state.aiWaitTimer, null);
    queued(); assert.equal(s.status.textContent, message);
  }
  s.c.setAnalyzing(true, '舊請求', 'request');
  const stale = [...s.timers.values()][0].fn;
  s.state.photoAnalysis = {};
  s.c.setAnalyzing(true, '新請求', 'request');
  stale(); assert.equal(s.status.textContent, '新請求');
});

test('client timing separates preparation and round trip, excludes private content, and logs once', () => {
  const s = client(); s.setNow(900);
  const analysis = { startedAt:0, prepareMs:100, requestStartedAt:120, inputBytes:5000, imageBytes:1000, fileName:'private.jpg', image:'private-image' };
  s.c.logPhotoAnalysis_(analysis, 'success', { timing:{ aiMs:700 }, items:[food] });
  s.c.logPhotoAnalysis_(analysis, 'success');
  assert.equal(s.logs.length, 1); assert.equal(s.logs[0].prepareMs, 100);
  assert.equal(s.logs[0].roundTripMs, 780); assert.equal(s.logs[0].totalMs, 900);
  assert.ok(!JSON.stringify(s.logs).includes('private')); assert.ok(!JSON.stringify(s.logs).includes(food.name));
  s.c.logPhotoAnalysis_({ startedAt:100, prepareMs:null, requestStartedAt:null }, 'prepare_failed');
  assert.equal(s.logs[1].prepareMs, 800); assert.equal(s.logs[1].roundTripMs, null);
});

test('manual calorie correction stays proportional after amount edits and never reverts to the AI estimate', () => {
  const c = vm.createContext({proteinGrams:value=>Math.round(Number(value||0)*10)/10});
  for (const name of ['normalizeAiPortion','recalcAiItemCalories','setAiItemCalories_']) {
    const start=frontend.indexOf('    function '+name+'(');
    vm.runInContext(frontend.slice(start,frontend.indexOf('\n    function ',start+1)),c);
  }
  const item={amount:100,baseAmount:100,calories:160,baseCalories:160,low:140,high:180,baseLow:140,baseHigh:180,proteinG:12,baseProteinG:12,unit:'g'};
  item.amount=200;c.recalcAiItemCalories(item);assert.equal(item.calories,320);
  c.setAiItemCalories_(item,350);
  assert.equal(item.baseAmount,200);assert.equal(item.baseCalories,350,'saved calibration uses integer amount and calories without density rounding');
  item.amount=300;c.recalcAiItemCalories(item);
  assert.equal(item.calories,525);assert.equal(item.low,525);assert.equal(item.high,525);
  assert.equal(item.proteinG,36,'a calorie correction does not rewrite protein density');
  c.setAiItemCalories_(item,450);
  item.amount=100;c.recalcAiItemCalories(item);assert.equal(item.calories,150);
  c.setAiItemCalories_(item,0);
  item.amount=200;c.recalcAiItemCalories(item);assert.equal(item.calories,0);
  assert.equal(item.low,0);assert.equal(item.high,0);
  const legacy={calories:180,grams:120,proteinG:12,unit:'g'};
  c.setAiItemCalories_(legacy,200);
  legacy.amount=240;c.recalcAiItemCalories(legacy);assert.equal(legacy.calories,400);
});
