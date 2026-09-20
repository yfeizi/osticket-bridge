// Shared settings + description template helpers (loaded by popup & options).

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
  gitlabUrl: 'https://gitlab.com',
  project: '',
  token: '',
  labels: '',
  confidential: false,
  titleTemplate: '#{{number}} - {{subject}}',
  descriptionTemplate: DEFAULT_TEMPLATE,
  quoteMessage: true,
  postNote: true,
  noteTitle: 'GitLab issue #{{iid}}',
  noteBody: '<p>Created GitLab issue <a href="{{issueUrl}}" target="_blank">#{{iid}} — {{issueTitle}}</a></p>',
};

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, (items) => resolve({ ...DEFAULTS, ...items }));
  });
}

function saveSettings(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
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
    details: detailsTable,
    message,
    attachments,
    ...(opts.extra || {}), // e.g. iid / issueUrl / issueTitle once the issue exists
  };

  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (k in vars ? vars[k] : ''));
}
