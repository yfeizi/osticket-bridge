// Shared settings + description template helpers (loaded by popup & options).

// Static capabilities per issue tracker. The API-side implementation lives in
// background.js; this table only drives what the UI offers.
const PROVIDERS = {
  gitlab: { label: 'GitLab', uploads: true, confidential: true, mr: 'merge request', mrAbbr: 'MR', mrRef: '!' },
  github: { label: 'GitHub', uploads: false, confidential: false, mr: 'pull request', mrAbbr: 'PR', mrRef: '#' },
};

const DEFAULT_TEMPLATE = `## Support ticket #{{number}}

**Subject:** {{subject}}
**Requester:** {{user}} {{email}}
**Department:** {{department}}
**Created:** {{created}}
**Ticket:** {{url}}

### Details
{{details}}

### Original message
{{message}}

{{attachments}}
`;

const DEFAULTS = {
  provider: 'gitlab',
  // GitLab
  gitlabUrl: 'https://gitlab.com',
  project: '',
  token: '',
  // GitHub (API base; for GitHub Enterprise use https://<host>/api/v3)
  githubApiUrl: 'https://api.github.com',
  githubRepo: '',
  githubToken: '',
  // Issue defaults
  labels: '',
  confidential: false,
  titleTemplate: '#{{number}} - {{subject}}',
  descriptionTemplate: DEFAULT_TEMPLATE,
  quoteMessage: true,
  // Branch + draft merge/pull request
  createMr: false,
  branchTemplate: 'ticket-{{number}}-{{slug}}',
  // Internal note
  postNote: true,
  noteTitle: '{{provider}} issue #{{iid}}',
  noteBody: '<p>Created {{provider}} issue <a href="{{issueUrl}}" target="_blank">#{{iid}} — {{issueTitle}}</a></p>{{mr}}',
};

// "Fix login page" -> "fix-login-page". Only ASCII letters/digits survive, so a
// subject in another script yields an empty slug (the user then types one).
function slugify(text, maxWords = 6) {
  return (text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')      // strip diacritics
    .toLowerCase()
    .replace(/^#?\d{4,}\s*[-:–]\s*/, '')  // drop a leading "#370140 - "
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join('-');
}

// Make a string a valid git branch name (git check-ref-format rules, roughly).
function sanitizeBranch(name) {
  return (name || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[~^:?*[\]\\\x00-\x1f\x7f]/g, '')
    .replace(/\.\.+/g, '.')
    .replace(/@\{/g, '@')
    .replace(/\/{2,}/g, '/')
    .replace(/-{2,}/g, '-')
    .replace(/\/-|-\//g, '/')
    .replace(/(^[-./]+)|([-./]+$)|(\.lock$)/g, '')
    .slice(0, 100);
}

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, (items) => resolve({ ...DEFAULTS, ...items }));
  });
}

function saveSettings(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

const providerMeta = (settings) => PROVIDERS[settings.provider] || PROVIDERS.gitlab;

// Human-readable target ("group/project" or "owner/repo") and whether the
// selected provider has everything it needs to make API calls.
function providerTarget(settings) {
  return settings.provider === 'github' ? settings.githubRepo : settings.project;
}
function providerToken(settings) {
  return settings.provider === 'github' ? settings.githubToken : settings.token;
}
function providerBaseUrl(settings) {
  return settings.provider === 'github'
    ? settings.githubApiUrl.replace(/\/+$/, '')
    : settings.gitlabUrl.replace(/\/+$/, '') + '/api/v4';
}
function isConfigured(settings) {
  return Boolean(providerToken(settings) && providerTarget(settings));
}

function renderTemplate(tpl, ticket, opts = {}) {
  const details = (ticket.details || [])
    .map((d) => `| ${d.label} | ${d.value.replace(/\|/g, '\\|')} |`)
    .join('\n');
  const detailsTable = details ? `| Field | Value |\n|---|---|\n${details}` : '_none_';

  const attachments = (ticket.attachments || []).length
    ? '### Attachments\n' + ticket.attachments.map((a) => `- [${a.name}](${a.url})`).join('\n')
    : '';

  let message = ticket.message || ((ticket.attachments || []).length ? '_(no text — see attachments below)_' : '_(empty)_');
  if (opts.quoteMessage) message = message.split('\n').map((l) => `> ${l}`).join('\n');

  const vars = {
    number: ticket.number || '',
    id: ticket.id || '',
    subject: ticket.subject || '',
    url: ticket.url || '',
    user: ticket.user || '',
    email: ticket.email ? `<${ticket.email}>` : '',
    department: ticket.department || '',
    status: ticket.status || '',
    priority: ticket.priority || '',
    created: ticket.created || '',
    source: ticket.source || '',
    helpTopic: ticket.helpTopic || '',
    assigned: ticket.assigned || '',
    sla: ticket.sla || '',
    dueDate: ticket.dueDate || '',
    slug: slugify(ticket.subject),
    details: detailsTable,
    message,
    attachments,
    ...(opts.extra || {}), // e.g. provider / iid / issueUrl / issueTitle once the issue exists
  };

  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (k in vars ? vars[k] : ''));
}
