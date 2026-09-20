// Injected on demand (activeTab) into the osTicket staff panel ticket page
// (scp/tickets.php?id=...). It only READS the page and hands a structured
// ticket object to the popup, fetches ticket attachments (same-origin, so the
// session cookie applies) and posts the internal note through the page's own
// form. It never sees the GitLab token.

(() => {
  // The popup injects this script whenever it cannot reach it; make sure a
  // second injection does not register a second message listener.
  if (window.__osticketGitlabBridge) return;
  window.__osticketGitlabBridge = true;

  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  // Known label aliases (English + Persian) so we can map the generic
  // label/value pairs onto named fields regardless of the UI language.
  const FIELD_ALIASES = {
    department: ['department', 'dept', 'دپارتمان', 'بخش'],
    user: ['user', 'کاربر'],
    email: ['email', 'ایمیل', 'پست الکترونیک'],
    status: ['status', 'وضعیت'],
    priority: ['priority', 'اولویت'],
    created: ['create date', 'created', 'تاریخ ایجاد'],
    source: ['source', 'منبع'],
    helpTopic: ['help topic', 'موضوع راهنما'],
    assigned: ['assigned to', 'assigned', 'محول شده به', 'واگذار شده'],
    sla: ['sla plan', 'sla'],
    dueDate: ['due date', 'تاریخ سررسید'],
  };

  function findTicketNumber() {
    // Sticky bar: <h2><a title="Reload"><i class="icon-refresh"></i> Ticket #370140</a></h2>
    const candidates = ['.sticky.bar .flush-left h2', '.sticky.bar h2', 'h2.truncate', '#content h2'];
    for (const sel of candidates) {
      const m = text(document.querySelector(sel)).match(/#\s*(\d{4,})/);
      if (m) return m[1];
    }
    const fromTitle = document.title.match(/#\s*(\d{4,})/);
    return fromTitle ? fromTitle[1] : '';
  }

  function findSubject() {
    // <div class="clear tixTitle has_bottom_border"><h3>subject</h3></div>
    const candidates = ['.tixTitle h3', '.tixTitle', '#content h3'];
    for (const sel of candidates) {
      const subject = text(document.querySelector(sel));
      if (subject) return subject;
    }
    // Very old themes put the subject in the sticky bar h2 instead of the number.
    const h2 = text(document.querySelector('.sticky.bar h2'));
    return /#\s*\d{4,}/.test(h2) ? '' : h2;
  }

  // Cleaned value for one <td> of the ticket-info table.
  function cellValue(td) {
    // "User" cell: name + "(148)" related-tickets link + "Manage Collaborators".
    const userName = td.querySelector('[id^="user-"][id$="-name"]');
    if (userName) return text(userName);
    const clone = td.cloneNode(true);
    clone.querySelectorAll('.action-dropdown, .manage-collaborators, script').forEach((n) => n.remove());
    return text(clone);
  }

  // Collect every "Label:" / "value" pair from the ticket info tables.
  function collectDetails() {
    const details = [];
    const seen = new Set();
    document.querySelectorAll('table.ticket_info tr').forEach((tr) => {
      const th = tr.querySelector(':scope > th');
      const td = tr.querySelector(':scope > td');
      if (!th || !td) return;
      const label = text(th).replace(/[:：]\s*$/, '');
      const value = cellValue(td);
      if (!label || !value || seen.has(label)) return;
      seen.add(label);
      details.push({ label, value });
    });
    return details;
  }

  function mapNamedFields(details) {
    const out = {};
    for (const { label, value } of details) {
      const l = label.toLowerCase();
      for (const [key, aliases] of Object.entries(FIELD_ALIASES)) {
        if (out[key]) continue;
        if (aliases.some((a) => l === a || l.startsWith(a + ' '))) out[key] = value;
      }
    }
    if (!out.email) {
      const el = document.querySelector('[id^="user-"][id$="-email"], table.ticket_info a[href^="mailto:"]');
      if (el) out.email = (el.getAttribute('href') || text(el)).replace(/^mailto:/, '');
    }
    return out;
  }

  function firstMessageEntry() {
    return (
      document.querySelector('#thread-items .thread-entry.message') ||
      document.querySelector('.thread-entry.message') ||
      document.querySelector('.thread-entry')
    );
  }

  function firstMessage(entry) {
    const body = entry && entry.querySelector('.thread-body');
    if (!body) return '';
    const clone = body.cloneNode(true);
    clone.querySelectorAll('script, style, .attachments, figure, img').forEach((n) => n.remove());
    // innerText keeps line breaks; textContent would flatten them.
    return clone.innerText.trim();
  }

  // Files of the first message: inline images (<figure><img data-cid>) and
  // regular attachments (.attachments a). Each gets a download URL and a name.
  function attachments(entry) {
    if (!entry) return [];
    const out = [];
    const seen = new Set();
    const push = (name, url, isImage) => {
      if (!url || seen.has(url)) return;
      seen.add(url);
      out.push({ name: name || url.split('/').pop().split('?')[0] || 'file', url, isImage });
    };

    entry.querySelectorAll('.thread-body img[src*="file.php"]').forEach((img) => {
      const figure = img.closest('figure') || img.parentElement;
      const dl = figure && figure.querySelector('a[download], a[href*="file.php"]');
      const name = (dl && dl.getAttribute('download')) || img.getAttribute('alt') || 'image.png';
      push(name, dl ? dl.href : img.src, true);
    });

    entry.querySelectorAll('.attachments a[href], .thread-body a[href*="file.php"]').forEach((a) => {
      const name = a.getAttribute('download') || text(a) || a.getAttribute('title');
      push(name, a.href, /\.(png|jpe?g|gif|webp|bmp)$/i.test(name || ''));
    });
    return out;
  }

  function collectTicket() {
    const details = collectDetails();
    const named = mapNamedFields(details);
    const entry = firstMessageEntry();
    const id = new URL(location.href).searchParams.get('id') || '';
    return {
      ok: true,
      id,
      number: findTicketNumber(),
      subject: findSubject(),
      url: location.href.split('#')[0],
      message: firstMessage(entry),
      attachments: attachments(entry),
      details,
      ...named,
    };
  }

  // Fetch a ticket file as base64 (same-origin => session cookie is sent).
  async function fetchFile(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const base64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
    return { ok: true, base64, type: blob.type || 'application/octet-stream', size: blob.size };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === 'GET_TICKET') {
      try { sendResponse(collectTicket()); }
      catch (e) { sendResponse({ ok: false, error: String(e) }); }
      return false;
    }
    if (msg.type === 'FETCH_FILE') {
      fetchFile(msg.url)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true; // async
    }
    if (msg.type === 'POST_NOTE') {
      postNote(msg)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
      return true; // async
    }
    return false;
  });

  // Post an internal note by re-submitting the page's own "Post Internal Note"
  // form (keeps the CSRF token, ticket id and current status untouched).
  async function postNote({ title, html, marker }) {
    const form = document.querySelector('form#note');
    if (!form) throw new Error('Internal-note form not found on this page');
    const fd = new FormData();
    for (const [k, v] of new FormData(form).entries()) {
      if (v instanceof File) continue; // skip the empty attachment inputs
      fd.append(k, v);
    }
    fd.set('title', title);
    fd.set('note', html);
    const res = await fetch(form.action, { method: 'POST', body: fd, credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const err = doc.querySelector('#msg_error');
    if (err && err.textContent.trim()) throw new Error(err.textContent.trim());
    const verified = marker ? text.includes(marker) : true;
    // Show the new note: reload once the popup has received our answer.
    setTimeout(() => location.reload(), 300);
    return { ok: true, verified };
  }
})();
