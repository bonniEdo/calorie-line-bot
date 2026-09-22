/**
 * LINE webhook security relay.
 *
 * Environment variables / secrets:
 * - LINE_CHANNEL_SECRET: LINE Developers > Basic settings > Channel secret
 * - APPS_SCRIPT_WEBHOOK_URL: deployed Apps Script /exec URL
 * - APPS_SCRIPT_RELAY_SECRET: same value as Apps Script RELAY_SECRET
 */
export default {
  async fetch(request, env) {
    if (request.method === 'GET') {
      return json({ ok: true, service: 'sisters-calorie-line-webhook' });
    }
    if (request.method !== 'POST') {
      return json({ ok: false, error: 'method_not_allowed' }, 405);
    }

    if (!env.LINE_CHANNEL_SECRET || !env.APPS_SCRIPT_WEBHOOK_URL || !env.APPS_SCRIPT_RELAY_SECRET) {
      return json({ ok: false, error: 'missing_environment_variables' }, 500);
    }

    const rawBody = await request.text();
    const receivedSignature = request.headers.get('x-line-signature') || '';
    const valid = await verifyLineSignature(rawBody, receivedSignature, env.LINE_CHANNEL_SECRET);
    if (!valid) return json({ ok: false, error: 'invalid_signature' }, 401);

    let webhookBody;
    try { webhookBody = JSON.parse(rawBody); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }
    if (!webhookBody || typeof webhookBody !== 'object' || Array.isArray(webhookBody)) {
      return json({ ok: false, error: 'invalid_webhook' }, 400);
    }

    const originalEvents = Array.isArray(webhookBody.events) ? webhookBody.events : [];
    const filteredEvents = originalEvents.filter(shouldForwardEvent);

    // The five-person group may be noisy. Ignore ordinary group chatter after
    // signature verification so it doesn't consume Apps Script execution quota.
    if (originalEvents.length > 0 && filteredEvents.length === 0) return json({ ok: true, ignored: true });
    webhookBody.events = filteredEvents;

    const target = new URL(env.APPS_SCRIPT_WEBHOOK_URL);
    target.searchParams.set('key', env.APPS_SCRIPT_RELAY_SECRET);

    let upstream, text;
    try {
      upstream = await fetch(target.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(webhookBody),
      });
      text = await upstream.text();
    } catch {
      console.error('Apps Script request failed');
      return json({ ok: false, error: 'upstream_failed' }, 502);
    }

    // Apps Script Web Apps normally answer 200 even when their JSON says ok:false.
    let result;
    try { result = JSON.parse(text); } catch { result = { ok: false, error: 'invalid_apps_script_response' }; }
    if (!upstream.ok || !result || result.ok !== true) {
      console.error('Apps Script error', upstream.status);
      return json({ ok: false, error: 'upstream_failed' }, 502);
    }

    return json({ ok: true });
  },
};

function shouldForwardEvent(event) {
  if (!event || !event.type) return false;
  if (event.type !== 'message') return true;
  if (!event.source || event.source.type !== 'group') return true;
  if (!event.message || event.message.type !== 'text') return false;

  const text = String(event.message.text || '').replace(/\s+/g, '');
  return ['綁定', '加入', '開始', '打卡', '今日打卡', '填寫', '記錄',
    '啟用排行', '啟用排行榜', '設定排行',
    '今日排行', '排行', '排行榜', '今天排行', '說明', 'help', '幫助'].includes(text);
}

async function verifyLineSignature(body, receivedSignature, channelSecret) {
  if (!receivedSignature) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expectedSignature = bytesToBase64(new Uint8Array(signed));
  return timingSafeEqual(expectedSignature, receivedSignature);
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
