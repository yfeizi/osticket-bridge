// Shared settings + description template helpers (loaded by popup & options).

// Static capabilities per issue tracker. The API-side implementation lives in
// background.js; this table only drives what the UI offers.
// `estimate`/`dueDate` say whether the tracker stores that natively on an
// issue; what it cannot store is written into the description instead.
// Neither tracker has a start date on issues (GitLab has it on epics only),
// so `startDate` is false everywhere for now.
const PROVIDERS = {
  gitlab: {
    label: 'GitLab', uploads: true, confidential: true,
    mr: 'merge request', mrAbbr: 'MR', mrRef: '!',
    estimate: true, dueDate: true, startDate: false, mrLabels: true,
  },
  github: {
    label: 'GitHub', uploads: false, confidential: false,
    mr: 'pull request', mrAbbr: 'PR', mrRef: '#',
    estimate: false, dueDate: false, startDate: false, mrLabels: true,
  },
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
  // English branch-name suggestions. Chrome's on-device Translator is always
  // tried first; this picks the online fallback (off = none).
  translateService: 'off', // off | mymemory | libre
  translateEmail: '',      // MyMemory: raises the free quota from 5k to 50k chars/day
  libreUrl: '',
  libreKey: '',
  sourceLang: 'auto',      // ISO code to force the source language, or "auto"
  // Schedule (start date + estimate). Empty fields set nothing.
  showSchedule: true,
  defaultEstimate: '',
  startToday: false,
  dueFromEstimate: true,
  hoursPerDay: 8,          // GitLab's own convention for turning hours into days
  // Labels on the merge/pull request: same as the issue, or none.
  mrLabels: 'same',        // same | none
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

// --- schedule helpers -------------------------------------------------------

// "2d 4h", "90m", "1w" -> seconds, using GitLab's units (1w = 5d, 1d = 8h by
// default). Returns null when the text is not a valid duration.
function parseDuration(text, hoursPerDay = 8) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  const unit = { mo: 0, w: 0, d: 0, h: 3600, m: 60, s: 1 };
  unit.d = hoursPerDay * 3600;
  unit.w = 5 * unit.d;
  unit.mo = 4 * unit.w;
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(mo|w|d|h|m|s)/g;
  let m;
  while ((m = re.exec(t))) {
    total += parseFloat(m[1]) * unit[m[2]];
    matched = true;
  }
  // A bare number is read as hours ("4" -> 4h), which is what people type.
  if (!matched && /^\d+(\.\d+)?$/.test(t)) return parseFloat(t) * 3600;
  if (!matched || /[^\dmowdhs.\s]/.test(t)) return null;
  return total;
}

function formatDuration(seconds, hoursPerDay = 8) {
  if (!seconds) return '';
  const day = hoursPerDay * 3600;
  const parts = [];
  const take = (size, suffix) => {
    const n = Math.floor(seconds / size);
    if (n) { parts.push(`${n}${suffix}`); seconds -= n * size; }
  };
  take(5 * day, 'w'); take(day, 'd'); take(3600, 'h'); take(60, 'm');
  return parts.join(' ');
}

const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => isoDate(new Date());

// Working days from a start date and an estimate, skipping Sat/Sun. A due
// date is only derived when both a start date and a valid estimate are given.
function dueFromEstimate(startDate, seconds, hoursPerDay = 8) {
  if (!startDate || !seconds) return '';
  const d = new Date(`${startDate}T00:00:00`);
  if (isNaN(d)) return '';
  let days = Math.max(1, Math.ceil(seconds / (hoursPerDay * 3600)));
  while (days > 1) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) days--; // skip weekend
  }
  return isoDate(d);
}

// Markdown block for whatever the tracker cannot store on the issue itself.
function scheduleMarkdown(schedule, meta) {
  if (!schedule) return '';
  const lines = [];
  if (schedule.startDate && !meta.startDate) lines.push(`**Start date:** ${schedule.startDate}`);
  if (schedule.estimate && !meta.estimate) lines.push(`**Estimate:** ${schedule.estimate}`);
  if (schedule.dueDate && !meta.dueDate) lines.push(`**Due date:** ${schedule.dueDate}`);
  return lines.length ? `\n\n---\n${lines.join('  \n')}\n` : '';
}

// Guess the source language from the script. Good enough to pick a MyMemory
// language pair; Chrome's LanguageDetector overrides it when available.
function detectLang(text) {
  const t = text || '';
  if (/[؀-ۿ]/.test(t)) {
    // Persian and Arabic share a script; Persian-only letters (پ چ ژ گ ی ک)
    // vs Arabic-only ones (ي ك ة) tell them apart.
    const fa = (t.match(/[پچژگیک]/g) || []).length;
    const ar = (t.match(/[يكة]/g) || []).length;
    return fa > ar ? 'fa' : 'ar';
  }
  if (/[Ѐ-ӿ]/.test(t)) return 'ru';
  if (/[֐-׿]/.test(t)) return 'he';
  if (/[฀-๿]/.test(t)) return 'th';
  if (/[぀-ヿ]/.test(t)) return 'ja';
  if (/[가-힯]/.test(t)) return 'ko';
  if (/[一-鿿]/.test(t)) return 'zh';
  if (/[a-z]/i.test(t)) return 'en';
  return 'auto';
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
