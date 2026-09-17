'use strict';
const config = window.INTRO_CONFIG || {};
let validLineUrl = false;
try {
  const url = new URL(config.lineUrl);
  validLineUrl = url.protocol === 'https:' && ['lin.ee', 'line.me'].includes(url.hostname);
} catch (_) { /* 未設定時顯示準備中，不提供無效連結。 */ }
if (validLineUrl) {
  const link = document.getElementById('line-link');
  link.href = config.lineUrl;
  link.hidden = false;
  document.getElementById('join-pending').hidden = true;
  if (config.qrImage) {
    const qr = document.getElementById('line-qr');
    qr.addEventListener('load', () => { qr.hidden = false; document.getElementById('qr-caption').hidden = false; });
    qr.src = config.qrImage;
  }
}
document.querySelectorAll('[data-preview]').forEach(button => {
  button.addEventListener('click', () => {
    const report = button.dataset.preview === 'report';
    document.getElementById('history-preview').hidden = report;
    document.getElementById('report-preview').hidden = !report;
    document.querySelectorAll('[data-preview]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  });
});
