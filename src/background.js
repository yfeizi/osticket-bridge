// Service worker: the only place that talks to the issue tracker and reads the
// token. Each tracker is a "provider" exposing the same small interface:
//   test, search, labels, members, me, upload, createIssue
// so the popup never needs to know which one is configured.

// ---------- shared HTTP helpers ----------

const trim = (s) => (s || '').trim().replace(/^\/|\/$/g, '');

// Host access is granted at runtime (optional_host_permissions) for the one
// origin the user configured; fail early with a clear hint otherwise.
const ensureHostPermission = async (baseUrl) => {
  let origin;
  try { origin = new URL(baseUrl).origin + '/*'; }
  catch { throw new Error(`Invalid API URL: "${baseUrl}"`); }
  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (!granted) throw new Error(`No permission to access ${origin}. Open Settings and click "Test connection" to grant it.`);
};

// Low-level call. `path` is relative to the provider's API base. `body` may be
// a plain object (sent as JSON) or a FormData (for uploads). Returns { data, res }.
const call = async (p, settings, path, { method = 'GET', body } = {}) => {
  const base = p.base(settings);
  await ensureHostPermission(base);
  const headers = { ...p.headers(settings) };
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + path, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.message ? (typeof data.message === 'string' ? data.message : JSON.stringify(data.message)) : `${res.status} ${res.statusText}`;
    throw new Error(`${p.label} ${res.status}: ${detail}`);
  }
  return { data, res };
};

// Follow pagination (bounded, so a huge project can't hang us). Both GitLab
// and GitHub accept ?per_page=&page=; how they announce the next page differs.
const apiAll = async (p, settings, path, maxPages = 10) => {
  const sep = path.includes('?') ? '&' : '?';
  let page = 1;
  const out = [];
  while (page && page <= maxPages) {
    const { data, res } = await call(p, settings, `${path}${sep}per_page=100&page=${page}`);
    out.push(...data);
    page = p.nextPage(res);
  }
  return out;
};

const base64ToBlob = (base64, type) => {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- providers ----------

const gitlab = {
  label: 'GitLab',
  base: (s) => s.gitlabUrl.replace(/\/+$/, '') + '/api/v4',
  headers: (s) => ({ 'PRIVATE-TOKEN': s.token }),
  nextPage: (res) => Number(res.headers.get('x-next-page')) || 0,
  project: (s) => '/projects/' + encodeURIComponent(trim(s.project)),

  async test(s) {
    const { data: p } = await call(this, s, this.project(s));
    return { name: p.name_with_namespace, webUrl: p.web_url };
  },
  async search(s, query) {
    const q = encodeURIComponent(query);
    const { data } = await call(this, s, `${this.project(s)}/issues?search=${q}&in=title&state=all&per_page=5`);
    return data.map((i) => ({ iid: i.iid, title: i.title, state: i.state, url: i.web_url }));
  },
  async labels(s) {
    const list = await apiAll(this, s, `${this.project(s)}/labels?include_ancestor_groups=true`);
    return list.map((l) => ({ name: l.name, color: l.color }));
  },
  async members(s) {
    const list = await apiAll(this, s, `${this.project(s)}/members/all`);
    return list
      .filter((m) => (m.state || 'active') === 'active' && (m.access_level ?? 20) >= 20) // reporter+
      .map((m) => ({ id: String(m.id), name: m.name, username: m.username }));
  },
  async me(s) {
    const { data: u } = await call(this, s, '/user');
    return { id: String(u.id), name: u.name, username: u.username };
  },
  async upload(s, f) {
    const fd = new FormData();
    fd.append('file', base64ToBlob(f.base64, f.type), f.name);
    const { data: up } = await call(this, s, `${this.project(s)}/uploads`, { method: 'POST', body: fd });
    return up.url; // relative /uploads/<hash>/<file>, valid inside the project
  },
  async createIssue(s, issue) {
    const { data: c } = await call(this, s, `${this.project(s)}/issues`, {
      method: 'POST',
      body: {
        title: issue.title,
        description: issue.description,
        labels: issue.labels,
        assignee_ids: issue.assigneeId ? [Number(issue.assigneeId)] : [],
        confidential: !!issue.confidential,
      },
    });
    return { iid: c.iid, url: c.web_url };
  },
  async defaultBranch(s) {
    const { data: p } = await call(this, s, this.project(s));
    return p.default_branch;
  },
  async createBranch(s, name, ref) {
    const { data: b } = await call(this, s, `${this.project(s)}/repository/branches?branch=${encodeURIComponent(name)}&ref=${encodeURIComponent(ref)}`, { method: 'POST' });
    return { name: b.name, url: b.web_url };
  },
  // GitLab happily opens an MR with no commits ("Draft:" title marks it a draft).
  async createMergeRequest(s, mr) {
    const { data: m } = await call(this, s, `${this.project(s)}/merge_requests`, {
      method: 'POST',
      body: {
        source_branch: mr.branch,
        target_branch: mr.target,
        title: `Draft: ${mr.title}`,
        description: mr.description,
        assignee_id: mr.assigneeId ? Number(mr.assigneeId) : undefined,
        labels: mr.labels || undefined,
        remove_source_branch: true,
      },
    });
    return { iid: m.iid, url: m.web_url, draft: true };
  },
};

const github = {
  label: 'GitHub',
  base: (s) => s.githubApiUrl.replace(/\/+$/, ''),
  headers: (s) => ({
    Authorization: `Bearer ${s.githubToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }),
  nextPage: (res) => {
    const m = (res.headers.get('link') || '').match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="next"/);
    return m ? Number(m[1]) : 0;
  },
  repo: (s) => '/repos/' + trim(s.githubRepo),

  async test(s) {
    const { data: r } = await call(this, s, this.repo(s));
    return { name: r.full_name, webUrl: r.html_url };
  },
  async search(s, query) {
    const q = encodeURIComponent(`repo:${trim(s.githubRepo)} in:title "${query.replace(/^#/, '')}"`);
    const { data } = await call(this, s, `/search/issues?q=${q}&per_page=5`);
    return (data.items || []).map((i) => ({ iid: i.number, title: i.title, state: i.state, url: i.html_url }));
  },
  async labels(s) {
    const list = await apiAll(this, s, `${this.repo(s)}/labels`);
    return list.map((l) => ({ name: l.name, color: `#${l.color}` }));
  },
  async members(s) {
    // /assignees only gives logins; resolve display names for a reasonable number.
    const list = await apiAll(this, s, `${this.repo(s)}/assignees`, 2);
    const named = await Promise.allSettled(
      list.slice(0, 40).map((u) => call(this, s, `/users/${u.login}`).then((r) => r.data.name))
    );
    return list.map((u, i) => ({
      id: u.login,
      name: (named[i] && named[i].status === 'fulfilled' && named[i].value) || u.login,
      username: u.login,
    }));
  },
  async me(s) {
    const { data: u } = await call(this, s, '/user');
    return { id: u.login, name: u.name || u.login, username: u.login };
  },
  async upload() {
    throw new Error('The GitHub API does not support attachment uploads; the original links were kept.');
  },
  async createIssue(s, issue) {
    const { data: c } = await call(this, s, `${this.repo(s)}/issues`, {
      method: 'POST',
      body: {
        title: issue.title,
        body: issue.description,
        labels: issue.labels.split(',').map((l) => l.trim()).filter(Boolean),
        assignees: issue.assigneeId ? [issue.assigneeId] : [],
      },
    });
    return { iid: c.number, url: c.html_url };
  },
  async defaultBranch(s) {
    const { data: r } = await call(this, s, this.repo(s));
    return r.default_branch;
  },
  // GitHub rejects a PR with zero commits between head and base, so the new
  // branch gets one empty commit (same tree as the base) via the Git Data API.
  async createBranch(s, name, ref) {
    const repo = this.repo(s);
    const { data: base } = await call(this, s, `${repo}/git/ref/heads/${encodeURIComponent(ref)}`);
    const baseSha = base.object.sha;
    const { data: baseCommit } = await call(this, s, `${repo}/git/commits/${baseSha}`);
    const { data: commit } = await call(this, s, `${repo}/git/commits`, {
      method: 'POST',
      body: { message: `Start work on ${name}`, tree: baseCommit.tree.sha, parents: [baseSha] },
    });
    await call(this, s, `${repo}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${name}`, sha: commit.sha } });
    const web = (await this.test(s)).webUrl;
    return { name, url: `${web}/tree/${name}` };
  },
  async createMergeRequest(s, mr) {
    const repo = this.repo(s);
    const body = { title: mr.title, head: mr.branch, base: mr.target, body: mr.description, draft: true };
    let pr, draft = true;
    try {
      pr = (await call(this, s, `${repo}/pulls`, { method: 'POST', body })).data;
    } catch (e) {
      // Draft PRs need a plan that supports them; fall back to a regular PR.
      if (!/draft/i.test(e.message)) throw e;
      draft = false;
      pr = (await call(this, s, `${repo}/pulls`, { method: 'POST', body: { ...body, draft: false } })).data;
    }
    // Assignees/labels live on the issue side of a PR; best effort.
    if (mr.assigneeId) {
      await call(this, s, `${repo}/issues/${pr.number}/assignees`, { method: 'POST', body: { assignees: [mr.assigneeId] } }).catch(() => {});
    }
    return { iid: pr.number, url: pr.html_url, draft };
  },
};

const PROVIDERS = { gitlab, github };
const providerOf = (settings) => PROVIDERS[settings.provider] || gitlab;

// ---------- orchestration ----------

// Upload each file and rewrite its osTicket link in the description to the
// tracker-hosted copy (as an image embed when applicable).
async function uploadAttachments(p, settings, description, files) {
  const failures = [];
  for (const f of files) {
    try {
      const url = await p.upload(settings, f);
      const md = `${f.isImage ? '!' : ''}[${f.name}](${url})`;
      const linkRe = new RegExp(`!?\\[[^\\]]*\\]\\(${escapeRegExp(f.url)}\\)`, 'g');
      description = linkRe.test(description)
        ? description.replace(linkRe, md)
        : description.split(f.url).join(url);
    } catch (e) {
      failures.push(`${f.name}: ${e.message}`);
    }
  }
  return { description, failures };
}

// ---------- online translation (branch-name suggestions) ----------

const MYMEMORY = 'https://api.mymemory.translated.net';

async function translateOnline(settings, text, source) {
  if (settings.translateService === 'mymemory') {
    await ensureHostPermission(MYMEMORY);
    if (!source || source === 'auto') throw new Error('MyMemory needs a source language — set it in Settings.');
    const q = new URLSearchParams({ q: text, langpair: `${source}|en` });
    if (settings.translateEmail) q.set('de', settings.translateEmail);
    const res = await fetch(`${MYMEMORY}/get?${q}`);
    const data = await res.json().catch(() => ({}));
    const out = data.responseData && data.responseData.translatedText;
    if (!res.ok || Number(data.responseStatus) >= 400 || !out || /MYMEMORY WARNING/i.test(out)) {
      throw new Error(`MyMemory: ${data.responseDetails || out || res.status}`);
    }
    return { text: out, engine: 'MyMemory' };
  }

  if (settings.translateService === 'libre') {
    const base = (settings.libreUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('LibreTranslate URL is not set.');
    await ensureHostPermission(base);
    const res = await fetch(`${base}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: text, source: source && source !== 'auto' ? source : 'auto', target: 'en', format: 'text',
        ...(settings.libreKey ? { api_key: settings.libreKey } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.translatedText) throw new Error(`LibreTranslate: ${data.error || res.status}`);
    return { text: data.translatedText, engine: 'LibreTranslate' };
  }

  throw new Error('Online translation is off (Settings → English branch names).');
}

const handlers = {
  TRANSLATE: async ({ settings, text, source }) => ({ ok: true, ...(await translateOnline(settings, text, source)) }),

  // Verify token + project from the options page.
  TEST_CONNECTION: async ({ settings }) => {
    const r = await providerOf(settings).test(settings);
    return { ok: true, ...r };
  },

  // Look for an existing issue that already references this ticket number.
  SEARCH_ISSUES: async ({ settings, query }) => {
    const issues = await providerOf(settings).search(settings, query);
    return { ok: true, issues };
  },

  // Each part is fetched independently so one failing endpoint (e.g. 403 on
  // members) does not blank the others; errors are reported per part.
  FORM_DATA: async ({ settings }) => {
    const p = providerOf(settings);
    const [labels, members, me] = await Promise.allSettled([p.labels(settings), p.members(settings), p.me(settings)]);
    const val = (r) => (r.status === 'fulfilled' ? r.value : null);
    const err = (r) => (r.status === 'rejected' ? String((r.reason && r.reason.message) || r.reason) : null);
    return {
      ok: true,
      labels: val(labels), labelsError: err(labels),
      members: val(members), membersError: err(members),
      me: val(me), meError: err(me),
    };
  },

  CREATE_ISSUE: async ({ settings, issue, files = [] }) => {
    const p = providerOf(settings);
    const { description, failures } = await uploadAttachments(p, settings, issue.description, files);
    const created = await p.createIssue(settings, { ...issue, description });
    return { ok: true, ...created, failures };
  },

  // Branch off the default branch and open a draft MR/PR that closes the issue.
  // Runs after CREATE_ISSUE so a failure here never loses the issue.
  CREATE_MR: async ({ settings, branch, issue, ticketUrl, assigneeId, labels }) => {
    const p = providerOf(settings);
    const target = await p.defaultBranch(settings);
    const created = await p.createBranch(settings, branch, target);
    const mr = await p.createMergeRequest(settings, {
      branch: created.name,
      target,
      title: issue.title,
      description: `Closes #${issue.iid}\n\nosTicket: ${ticketUrl}`,
      assigneeId,
      labels,
    });
    return { ok: true, branch: created, target, ...mr };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg && msg.type];
  if (!handler) return false;
  handler(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
  return true; // keep the channel open for the async response
});
