const $ = (id) => document.getElementById(id);
const FIELDS = [
  'gitlabUrl', 'project', 'token',
  'githubApiUrl', 'githubRepo', 'githubToken',
  'labels', 'titleTemplate', 'descriptionTemplate', 'branchTemplate', 'noteTitle', 'noteBody',
  'translateService', 'sourceLang', 'translateEmail', 'libreUrl', 'libreKey',
];
const CHECKS = ['confidential', 'quoteMessage', 'postNote', 'createMr'];

const selectedProvider = () => (document.querySelector('input[name=provider]:checked') || {}).value || 'gitlab';

function read() {
  const out = { provider: selectedProvider() };
  FIELDS.forEach((f) => (out[f] = $(f).value.trim()));
  CHECKS.forEach((f) => (out[f] = $(f).checked));
  return out;
}

function fill(s) {
  FIELDS.forEach((f) => ($(f).value = s[f] || ''));
  CHECKS.forEach((f) => ($(f).checked = !!s[f]));
  const radio = document.querySelector(`input[name=provider][value="${s.provider}"]`) || document.querySelector('input[name=provider]');
  radio.checked = true;
  applyProvider();
  applyTranslateService();
}

// Show only the fields that belong to the selected tracker.
function applyProvider() {
  const p = selectedProvider();
  document.body.dataset.provider = p;
  document.querySelectorAll('.only-gitlab').forEach((el) => el.classList.toggle('hidden', p !== 'gitlab'));
  document.querySelectorAll('.only-github').forEach((el) => el.classList.toggle('hidden', p !== 'github'));
}
document.querySelectorAll('input[name=provider]').forEach((r) => r.addEventListener('change', applyProvider));

// Show only the fields of the selected translation service.
function applyTranslateService() {
  const s = $('translateService').value;
  document.querySelectorAll('.only-mymemory').forEach((el) => el.classList.toggle('hidden', s !== 'mymemory'));
  document.querySelectorAll('.only-libre').forEach((el) => el.classList.toggle('hidden', s !== 'libre'));
}
$('translateService').addEventListener('change', applyTranslateService);

function notice(kind, html) {
  const el = $('result');
  el.className = `notice ${kind}`;
  el.innerHTML = html;
}

loadSettings().then(fill);

// Ask the browser for access to the configured API origin. Must be called
// synchronously from a user gesture (click), so no `await` before it.
function requestApiPermission(settings) {
  const origins = [];
  try { origins.push(new URL(providerBaseUrl(settings)).origin + '/*'); }
  catch { return Promise.resolve({ ok: false, error: 'Invalid API URL.' }); }
  // The online translation service, if one is selected, needs its origin too.
  if (settings.translateService === 'mymemory') origins.push('https://api.mymemory.translated.net/*');
  if (settings.translateService === 'libre' && settings.libreUrl) {
    try { origins.push(new URL(settings.libreUrl).origin + '/*'); }
    catch { return Promise.resolve({ ok: false, error: 'Invalid LibreTranslate URL.' }); }
  }
  return chrome.permissions.request({ origins })
    .then((granted) => (granted ? { ok: true } : { ok: false, error: `Access to ${origins.join(', ')} was not granted.` }))
    .catch((e) => ({ ok: false, error: e.message || String(e) }));
}

$('save').addEventListener('click', async () => {
  const settings = read();
  const perm = await requestApiPermission(settings);
  await saveSettings(settings);
  $('saved').textContent = perm.ok ? 'Saved ✔' : `Saved — but no ${providerMeta(settings).label} access granted`;
  if (!perm.ok) notice('warn', `✖ ${perm.error}`);
  setTimeout(() => ($('saved').textContent = ''), 3000);
});

$('reset').addEventListener('click', () => {
  ['titleTemplate', 'descriptionTemplate', 'branchTemplate', 'noteTitle', 'noteBody'].forEach((f) => ($(f).value = DEFAULTS[f]));
});

// Click a placeholder chip to insert it at the cursor of the description template.
document.querySelectorAll('.placeholders code').forEach((c) => {
  c.addEventListener('click', () => {
    const ta = $('descriptionTemplate');
    const [s, e] = [ta.selectionStart, ta.selectionEnd];
    ta.setRangeText(c.textContent, s, e, 'end');
    ta.focus();
  });
});

$('test').addEventListener('click', async () => {
  notice('muted', 'Testing…');
  const settings = read();
  const perm = await requestApiPermission(settings);
  if (!perm.ok) return notice('error', `✖ ${perm.error}`);
  chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', settings }, (r) => {
    if (!r || !r.ok) return notice('error', `✖ ${r ? r.error : 'No response'}`);
    const lines = [`✔ Connected to <a href="${r.webUrl}" target="_blank">${r.name}</a>`];
    chrome.runtime.sendMessage({ type: 'FORM_DATA', settings }, (f) => {
      if (!f || !f.ok) lines.push(`✖ Form data: ${f ? f.error : 'no response'}`);
      else {
        lines.push(f.labels
          ? `✔ Labels: ${f.labels.length} (${f.labels.slice(0, 5).map((l) => l.name).join(', ')}${f.labels.length > 5 ? ', …' : ''})`
          : `✖ Labels: ${f.labelsError}`);
        lines.push(f.members ? `✔ Assignable members: ${f.members.length}` : `✖ Members: ${f.membersError}`);
        lines.push(f.me ? `✔ Token user: ${f.me.name} (@${f.me.username})` : `✖ Current user: ${f.meError}`);
      }
      notice(lines.some((l) => l.startsWith('✖')) ? 'warn' : 'ok', lines.join('<br>'));
    });
  });
});
