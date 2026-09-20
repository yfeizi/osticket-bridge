// Shared settings + description template helpers (loaded by popup & options).

// Static capabilities per issue tracker. The API-side implementation lives in
// background.js; this table only drives what the UI offers.
const PROVIDERS = {
  gitlab: { label: 'GitLab', uploads: true, confidential: true },
  github: { label: 'GitHub', uploads: false, confidential: false },
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
  // Internal note
  postNote: true,
  noteTitle: '{{provider}} issue #{{iid}}',
  noteBody: '<p>Created {{provider}} issue <a href="{{issueUrl}}" target="_blank">#{{iid}} — {{issueTitle}}</a></p>',
};

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
    details: detailsTable,
    message,
    attachments,
    ...(opts.extra || {}), // e.g. provider / iid / issueUrl / issueTitle once the issue exists
  };

  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (k in vars ? vars[k] : ''));
}
