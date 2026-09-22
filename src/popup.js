const $ = (id) => document.getElementById(id);
const show = (id, visible = true) => $(id).classList.toggle('hidden', !visible);
const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const openOptions = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
$('openOptions').addEventListener('click', openOptions);
$('openOptions2').addEventListener('click', openOptions);

// ---------- helpers: tab / content script ----------

async function activeTicketTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/\/scp\/tickets\.php\?.*\bid=\d+/.test(tab.url || '')) return null;
  return tab;
}

async function askTab(tab, msg) {
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    // Content script not injected yet (extension was just installed/reloaded).
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content.js'] });
    return chrome.tabs.sendMessage(tab.id, msg);
  }
}

// Pull each attachment through the osTicket tab (same-origin => cookies work).
async function fetchFiles(tab, attachments, onProgress) {
  const files = [];
  const failures = [];
  for (const [i, a] of attachments.entries()) {
    onProgress(`Fetching ${a.name} (${i + 1}/${attachments.length})…`);
    const r = await askTab(tab, { type: 'FETCH_FILE', url: a.url });
    if (r && r.ok) files.push({ ...a, base64: r.base64, type: r.type });
    else failures.push(`${a.name}: ${r ? r.error : 'no response'}`);
  }
  return { files, failures };
}

// ---------- helpers: labels / assignee ----------

const norm = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function renderLabels(labels, defaults) {
  const wanted = new Set(defaults.split(',').map((s) => norm(s)).filter(Boolean));
  const list = $('labelList');
  list.innerHTML = '';
  for (const l of labels) {
    const chip = document.createElement('label');
    chip.className = 'chip';
    chip.dataset.name = norm(l.name);
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = l.name;
    cb.checked = wanted.has(norm(l.name));
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = l.color;
    const paint = () => {
      chip.classList.toggle('on', cb.checked);
      chip.style.background = cb.checked ? l.color : '';
    };
    cb.addEventListener('change', paint);
    chip.append(cb, dot, document.createTextNode(l.name));
    paint();
    list.append(chip);
  }
  $('labelHint').textContent = labels.length ? `${labels.length} available` : 'project has no labels';
  $('labelFilter').addEventListener('input', () => {
    const q = norm($('labelFilter').value);
    list.querySelectorAll('.chip').forEach((el) => el.classList.toggle('hidden', q && !el.dataset.name.includes(q)));
  });
}

// When the label list cannot be fetched, degrade to a plain text field so the
// issue can still be created (names must then match GitLab exactly).
function labelsFallback(error, defaults) {
  $('labelHint').textContent = `${error} — type names exactly, comma separated`;
  $('labelFilter').classList.add('hidden');
  $('labelList').innerHTML = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'labelsText';
  input.value = defaults;
  $('labelList').append(input);
}

function selectedLabels() {
  const text = $('labelsText');
  if (text) return text.value;
  return [...$('labelList').querySelectorAll('input:checked')].map((cb) => cb.value).join(',');
}

// Pick the member whose name best matches the osTicket "Assigned To" agent;
// fall back to the token owner.
function matchMember(members, agentName) {
  const target = norm(agentName);
  if (!target) return null;
  const exact = members.find((m) => norm(m.name) === target || norm(m.username) === target);
  if (exact) return exact;
  const parts = target.split(' ').filter((p) => p.length > 2);
  let best = null, bestScore = 0;
  for (const m of members) {
    const hay = `${norm(m.name)} ${norm(m.username)}`;
    const score = parts.filter((p) => hay.includes(p)).length;
    if (score > bestScore) { best = m; bestScore = score; }
  }
  return bestScore >= Math.max(1, Math.ceil(parts.length / 2)) ? best : null;
}

function renderAssignees(members, me, agentName) {
  const sel = $('assignee');
  sel.innerHTML = '<option value="">Unassigned</option>';
  const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name));
  for (const m of sorted) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = me && m.id === me.id ? `${m.name} (me)` : `${m.name} (@${m.username})`;
    sel.append(opt);
  }
  const pick = matchMember(members, agentName) || (me && members.find((m) => m.id === me.id));
  if (pick) sel.value = String(pick.id);
}

// ---------- UI state ----------

function setProgress(text) {
  $('progress').innerHTML = text ? `<span class="spinner"></span><span>${esc(text)}</span>` : '';
}

function showResult(kind, title, body, steps) {
  const icon = { ok: '🎉', error: '💥', warn: '⚠️' }[kind];
  $('result').innerHTML = `
    <div class="card result-card">
      <div class="big">${icon}</div>
      <h3>${title}</h3>
      <p>${body || ''}</p>
      ${steps ? `<div class="steps">${steps.map((s) => `<div class="${s.kind}">${s.kind === 'ok' ? '✔' : s.kind === 'warn' ? '⚠' : '✖'} ${s.text}</div>`).join('')}</div>` : ''}
    </div>`;
  show('result');
}

function fillTicketCard(ticket) {
  $('tNumber').textContent = ticket.number ? `#${ticket.number}` : `id ${ticket.id}`;
  $('tStatus').textContent = ticket.status || '';
  $('tPriority').textContent = ticket.priority || '';
  $('tSubject').textContent = ticket.subject || '(no subject)';
  $('tUser').textContent = ticket.user ? `${ticket.user}${ticket.email ? ` <${ticket.email}>` : ''}` : '';
  $('tDept').textContent = ticket.department || '';
  $('tCreated').textContent = ticket.created || '';
  $('tFiles').textContent = ticket.attachments.length ? `${ticket.attachments.length} file(s)` : '';
}

function wireDescriptionToggle() {
  const open = (e) => {
    if (e) e.preventDefault();
    show('description'); show('descPreview', false);
    $('toggleDesc').classList.add('hidden');
    $('description').focus();
  };
  $('toggleDesc').addEventListener('click', open);
  $('descPreview').addEventListener('click', open);
}

// Branch name: prefilled from the template (ticket number + English slug of the
// subject), always editable. `{{iid}}` is left for substitution after the issue
// exists. A subject in a non-Latin script gives an empty slug — say so.
function wireBranchField(settings, ticket, meta) {
  const cb = $('createMr');
  cb.checked = !!settings.createMr;
  const prefill = () => {
    if ($('branch').value) return;
    const name = renderTemplate(settings.branchTemplate, ticket, { extra: { iid: '{{iid}}' } });
    $('branch').value = sanitizeBranch(name);
    if (!slugify(ticket.subject)) {
      $('branchHint').textContent = 'subject is not in Latin script — add a short English description';
      $('branchHint').classList.add('warn');
    }
  };
  const sync = () => { show('branchField', cb.checked); if (cb.checked) prefill(); };
  cb.addEventListener('change', sync);
  $('branch').addEventListener('blur', () => { $('branch').value = sanitizeBranch($('branch').value); });
  $('branchHint').textContent = `from the default branch · draft ${meta.mr}`;
  sync();
}

// ---------- main ----------

function applyProvider(settings) {
  const meta = providerMeta(settings);
  document.body.dataset.provider = settings.provider;
  $('logoGitlab').classList.toggle('hidden', settings.provider === 'github');
  $('logoGithub').classList.toggle('hidden', settings.provider !== 'github');
  $('headTitle').textContent = `Create ${meta.label} issue`;
  const target = providerTarget(settings);
  $('projectName').textContent = target ? `→ ${target}` : 'from this osTicket ticket';
  $('openIssueLabel').textContent = `Open issue in ${meta.label}`;
  $('mrLabel').textContent = meta.mr;
  // Capabilities the tracker lacks are shown disabled with a reason.
  if (!meta.uploads) {
    $('upload').checked = false; $('upload').disabled = true;
    $('uploadHint').textContent = `(not supported by the ${meta.label} API — links are kept)`;
  }
  if (!meta.confidential) {
    $('confidential').checked = false; $('confidential').disabled = true;
    $('confidentialHint').textContent = '(GitLab only)';
  }
  return meta;
}

async function init() {
  const settings = await loadSettings();
  const meta = applyProvider(settings);
  if (!isConfigured(settings)) { show('notConfigured'); return; }

  const tab = await activeTicketTab();
  const ticket = tab && (await askTab(tab, { type: 'GET_TICKET' }));
  if (!ticket || !ticket.ok) { show('notTicket'); return; }

  fillTicketCard(ticket);
  $('title').value = renderTemplate(settings.titleTemplate, ticket);
  const description = renderTemplate(settings.descriptionTemplate, ticket, { quoteMessage: settings.quoteMessage });
  $('description').value = description;
  $('descPreview').textContent = description;
  wireDescriptionToggle();
  $('fileCount').textContent = ticket.attachments.length;
  if (meta.uploads) {
    $('upload').disabled = ticket.attachments.length === 0;
    $('upload').checked = ticket.attachments.length > 0;
  }
  if (meta.confidential) $('confidential').checked = !!settings.confidential;
  $('postNote').checked = !!settings.postNote;
  wireBranchField(settings, ticket, meta);
  show('form'); show('footer');

  // Labels + members come from GitLab so only *existing* labels can be sent
  // (GitLab silently creates any unknown name passed to `labels`).
  send({ type: 'FORM_DATA', settings }).then((r) => {
    if (!r || !r.ok) {
      const why = r ? r.error : (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'no response';
      labelsFallback(`could not load: ${why}`, settings.labels);
      $('assignee').innerHTML = '<option value="">Unassigned</option>';
      return;
    }
    if (r.labels) renderLabels(r.labels, settings.labels);
    else labelsFallback(r.labelsError, settings.labels);

    if (r.members) renderAssignees(r.members, r.me, ticket.assigned);
    else {
      $('assignee').innerHTML = '<option value="">Unassigned</option>';
      if (r.me) {
        const opt = document.createElement('option');
        opt.value = r.me.id; opt.textContent = `${r.me.name} (me)`;
        $('assignee').append(opt);
        $('assignee').value = String(r.me.id);
      }
      $('duplicate').className = 'notice error';
      $('duplicate').innerHTML = `Could not load members: ${esc(r.membersError)}${r.meError ? `<br>Current user: ${esc(r.meError)}` : ''}`;
    }
  });

  if (ticket.number) {
    send({ type: 'SEARCH_ISSUES', settings, query: `#${ticket.number}` }).then((r) => {
      if (!r || !r.ok || !r.issues.length) return;
      const list = r.issues
        .map((i) => `<a href="${i.url}" target="_blank">#${i.iid} ${esc(i.title)}</a> <span class="muted">(${i.state})</span>`)
        .join('<br>');
      $('duplicate').innerHTML = `An issue already references ticket #${ticket.number}:<br>${list}`;
      show('duplicate');
    });
  }

  $('create').addEventListener('click', async () => {
    $('create').disabled = true;
    $('create').querySelector('span').textContent = 'Working…';
    const steps = [];

    // 1. attachments
    let files = [];
    if ($('upload').checked && ticket.attachments.length) {
      const got = await fetchFiles(tab, ticket.attachments, setProgress);
      files = got.files;
      got.failures.forEach((f) => steps.push({ kind: 'warn', text: `Could not fetch ${esc(f)}` }));
    }

    // 2. issue
    setProgress(files.length ? `Uploading ${files.length} file(s) and creating issue…` : 'Creating issue…');
    const issueTitle = $('title').value.trim();
    const r = await send({
      type: 'CREATE_ISSUE',
      settings,
      files,
      issue: {
        title: issueTitle,
        description: $('description').value,
        labels: selectedLabels(),
        assigneeId: $('assignee').value || null, // numeric id (GitLab) or login (GitHub)
        confidential: $('confidential').checked,
      },
    });
    if (!r || !r.ok) {
      setProgress('');
      showResult('error', 'Issue was not created', esc(r ? r.error : 'No response from background worker'));
      $('create').disabled = false;
      $('create').querySelector('span').textContent = 'Create issue';
      return;
    }
    steps.push({ kind: 'ok', text: `Issue <a href="${r.url}" target="_blank">#${r.iid}</a> created` });
    (r.failures || []).forEach((f) => steps.push({ kind: 'warn', text: `Upload failed, link kept: ${esc(f)}` }));
    if (files.length && !(r.failures || []).length) steps.push({ kind: 'ok', text: `${files.length} file(s) uploaded` });

    // 3. branch + draft merge/pull request (optional; failure never loses the issue)
    let mrHtml = '';
    if ($('createMr').checked) {
      const branch = sanitizeBranch($('branch').value.replace(/\{\{\s*iid\s*\}\}/g, String(r.iid)));
      setProgress(`Creating branch ${branch} and draft ${meta.mr}…`);
      const m = await send({
        type: 'CREATE_MR',
        settings,
        branch,
        issue: { iid: r.iid, title: issueTitle },
        ticketUrl: ticket.url,
        assigneeId: $('assignee').value || null,
        labels: selectedLabels(),
      });
      if (m && m.ok) {
        steps.push({ kind: 'ok', text: `Branch <a href="${m.branch.url}" target="_blank"><code>${esc(m.branch.name)}</code></a> created from <code>${esc(m.target)}</code>` });
        steps.push({ kind: m.draft ? 'ok' : 'warn', text: `${m.draft ? 'Draft ' : ''}${meta.mr} <a href="${m.url}" target="_blank">${meta.mrRef}${m.iid}</a> created${m.draft ? '' : ' (draft not supported on this plan)'}` });
        mrHtml = `<p>Draft ${meta.mr}: <a href="${m.url}" target="_blank">${meta.mrRef}${m.iid}</a> (branch <code>${esc(m.branch.name)}</code>)</p>`;
      } else {
        steps.push({ kind: 'err', text: `Branch/${meta.mrAbbr} failed: ${esc(m ? m.error : 'no response')}` });
      }
    }

    // 4. internal note on the ticket
    if ($('postNote').checked) {
      setProgress('Posting internal note on the ticket…');
      const extra = { provider: meta.label, iid: r.iid, issueUrl: r.url, issueTitle, mr: mrHtml };
      const note = await askTab(tab, {
        type: 'POST_NOTE',
        title: renderTemplate(settings.noteTitle, ticket, { extra }),
        html: renderTemplate(settings.noteBody, ticket, { extra }),
        marker: r.url,
      });
      if (note && note.ok) steps.push({ kind: note.verified ? 'ok' : 'warn', text: note.verified ? 'Internal note posted on the ticket' : 'Note submitted (could not verify — check the ticket)' });
      else steps.push({ kind: 'err', text: `Internal note failed: ${esc(note ? note.error : 'no response')}` });
    }

    setProgress('');
    show('form', false); show('footer', false);
    showResult('ok', `Issue #${r.iid} created`,
      `<a class="btn primary" href="${r.url}" target="_blank">${$('openIssueLabel').textContent}</a>`, steps);
  });
}

init().catch((e) => showResult('error', 'Something went wrong', esc(String(e))));
