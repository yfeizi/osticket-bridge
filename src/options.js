const $ = (id) => document.getElementById(id);
const FIELDS = ['gitlabUrl', 'project', 'token', 'labels', 'titleTemplate', 'descriptionTemplate', 'noteTitle', 'noteBody'];
const CHECKS = ['confidential', 'quoteMessage', 'postNote'];

function read() {
  const out = {};
  FIELDS.forEach((f) => (out[f] = $(f).value.trim()));
  CHECKS.forEach((f) => (out[f] = $(f).checked));
  return out;
}

function fill(s) {
  FIELDS.forEach((f) => ($(f).value = s[f] || ''));
  CHECKS.forEach((f) => ($(f).checked = !!s[f]));
}

function notice(kind, html) {
  const el = $('result');
  el.className = `notice ${kind}`;
  el.innerHTML = html;
}

loadSettings().then(fill);

// Ask the browser for access to the configured GitLab origin. Must be called
// synchronously from a user gesture (click), so no `await` before it.
function requestGitlabPermission(gitlabUrl) {
  let origin;
  try { origin = new URL(gitlabUrl).origin + '/*'; }
  catch { return Promise.resolve({ ok: false, error: `Invalid GitLab URL: "${gitlabUrl}"` }); }
  return chrome.permissions.request({ origins: [origin] })
    .then((granted) => (granted ? { ok: true } : { ok: false, error: `Access to ${origin} was not granted.` }))
    .catch((e) => ({ ok: false, error: e.message || String(e) }));
}

$('save').addEventListener('click', async () => {
  const settings = read();
  const perm = await requestGitlabPermission(settings.gitlabUrl);
  await saveSettings(settings);
  $('saved').textContent = perm.ok ? 'Saved ✔' : 'Saved — but no GitLab access granted';
  if (!perm.ok) notice('warn', `✖ ${perm.error}`);
  setTimeout(() => ($('saved').textContent = ''), 3000);
});

$('reset').addEventListener('click', () => {
  ['titleTemplate', 'descriptionTemplate', 'noteTitle', 'noteBody'].forEach((f) => ($(f).value = DEFAULTS[f]));
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
  const perm = await requestGitlabPermission(settings.gitlabUrl);
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
