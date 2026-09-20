// Service worker: the only place that talks to GitLab and reads the token.

const baseUrl = (settings) => settings.gitlabUrl.replace(/\/+$/, '') + '/api/v4';
const projectPath = (settings) =>
  '/projects/' + encodeURIComponent(settings.project.trim().replace(/^\/|\/$/g, ''));

// Host access is granted at runtime (optional_host_permissions) for the one
// GitLab origin the user configured; fail early with a clear hint otherwise.
const ensureHostPermission = async (settings) => {
  let origin;
  try { origin = new URL(settings.gitlabUrl).origin + '/*'; }
  catch { throw new Error(`Invalid GitLab URL: "${settings.gitlabUrl}"`); }
  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (!granted) throw new Error(`No permission to access ${origin}. Open Settings and click "Test connection" to grant it.`);
};

// Low-level call. `path` is relative to /api/v4. `body` may be a plain object
// (sent as JSON) or a FormData (for uploads). Returns { data, res }.
const call = async (settings, path, { method = 'GET', body } = {}) => {
  await ensureHostPermission(settings);
  const headers = { 'PRIVATE-TOKEN': settings.token };
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(baseUrl(settings) + path, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message ? JSON.stringify(data.message) : `${res.status} ${res.statusText}`;
    throw new Error(`GitLab ${res.status}: ${msg}`);
  }
  return { data, res };
};

// Project-scoped call returning only the body.
const api = async (settings, path, init) => (await call(settings, projectPath(settings) + path, init)).data;

// Follow GitLab's x-next-page pagination (bounded, so a huge project can't hang us).
const apiAll = async (settings, path, maxPages = 10) => {
  const sep = path.includes('?') ? '&' : '?';
  let page = 1;
  const out = [];
  while (page && page <= maxPages) {
    const { data, res } = await call(settings, `${projectPath(settings)}${path}${sep}per_page=100&page=${page}`);
    out.push(...data);
    page = Number(res.headers.get('x-next-page')) || 0;
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

// Upload each file to the project and rewrite its osTicket link in the
// description to the GitLab-hosted copy (as an image embed when applicable).
async function uploadAttachments(settings, description, files) {
  const failures = [];
  for (const f of files) {
    try {
      const fd = new FormData();
      fd.append('file', base64ToBlob(f.base64, f.type), f.name);
      const up = await api(settings, '/uploads', { method: 'POST', body: fd });
      const md = `${f.isImage ? '!' : ''}[${f.name}](${up.url})`;
      const linkRe = new RegExp(`!?\\[[^\\]]*\\]\\(${escapeRegExp(f.url)}\\)`, 'g');
      description = linkRe.test(description)
        ? description.replace(linkRe, md)
        : description.split(f.url).join(up.url);
    } catch (e) {
      failures.push(`${f.name}: ${e.message}`);
    }
  }
  return { description, failures };
}

const handlers = {
  // Verify token + project from the options page.
  TEST_CONNECTION: async ({ settings }) => {
    const p = await api(settings, '');
    return { ok: true, name: p.name_with_namespace, webUrl: p.web_url };
  },

  // Look for an existing issue that already references this ticket number.
  SEARCH_ISSUES: async ({ settings, query }) => {
    const q = encodeURIComponent(query);
    const issues = await api(settings, `/issues?search=${q}&in=title&state=all&per_page=5`);
    return { ok: true, issues: issues.map((i) => ({ iid: i.iid, title: i.title, state: i.state, url: i.web_url })) };
  },

  // Everything the popup needs to build its form: existing labels (project +
  // ancestor groups), members who can be assigned, and the token's own user.
  // Each part is fetched independently so one failing endpoint (e.g. 403 on
  // members) does not blank the others; errors are reported per part.
  FORM_DATA: async ({ settings }) => {
    const [labels, members, me] = await Promise.allSettled([
      apiAll(settings, '/labels?include_ancestor_groups=true'),
      apiAll(settings, '/members/all'),
      call(settings, '/user').then((r) => r.data),
    ]);
    const val = (p) => (p.status === 'fulfilled' ? p.value : null);
    const err = (p) => (p.status === 'rejected' ? String(p.reason && p.reason.message || p.reason) : null);
    return {
      ok: true,
      labels: val(labels) ? val(labels).map((l) => ({ name: l.name, color: l.color })) : null,
      labelsError: err(labels),
      members: val(members)
        ? val(members)
            .filter((m) => (m.state || 'active') === 'active' && (m.access_level ?? 20) >= 20) // reporter+
            .map((m) => ({ id: m.id, name: m.name, username: m.username }))
        : null,
      membersError: err(members),
      me: val(me) ? { id: val(me).id, name: val(me).name, username: val(me).username } : null,
      meError: err(me),
    };
  },

  CREATE_ISSUE: async ({ settings, issue, files = [] }) => {
    const { description, failures } = await uploadAttachments(settings, issue.description, files);
    const created = await api(settings, '/issues', {
      method: 'POST',
      body: {
        title: issue.title,
        description,
        labels: issue.labels,
        assignee_ids: issue.assigneeId ? [issue.assigneeId] : [],
        confidential: !!issue.confidential,
      },
    });
    return { ok: true, iid: created.iid, url: created.web_url, failures };
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
