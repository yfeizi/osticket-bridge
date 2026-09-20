# osTicket → GitLab Issue

A small browser extension (Chrome, Opera, Edge, Brave — Manifest V3) that turns
the [osTicket](https://osticket.com) ticket you are looking at into a GitLab
issue in one click:

- prefilled **title**, **description** (Markdown with every ticket field, the
  original message and requester details), **assignee** and **labels**
- **uploads the ticket's screenshots and attachments** into the issue, so it is
  self-contained (osTicket file links are signed and expire)
- **posts an internal note** with the issue link back on the ticket
- warns you if an issue already references the ticket number
- works with self-hosted GitLab and gitlab.com; no server component

<!-- screenshot: docs/popup.png -->

## Install

Until it is published in a store, load it unpacked:

1. Download or clone this repository.
2. Chrome/Edge/Brave: open `chrome://extensions` · Opera: open `opera://extensions`.
3. Enable **Developer mode** and click **Load unpacked**.
4. Select the repository folder (the one containing `manifest.json`).
5. Pin the icon from the extensions menu.

## Configure

1. Click the extension icon → **⚙** (or right-click the icon → *Options*).
2. **GitLab URL** — e.g. `https://gitlab.com` or `https://gitlab.example.com`.
3. **Project** — the path (`group/project`) or numeric ID.
4. **Personal access token** — create one at *GitLab → Preferences → Access
   tokens* with the **`api`** scope.
5. Click **Test connection**. The browser asks once for permission to access
   your GitLab host; then the page reports the project, labels, members and
   token user.
6. Optionally adjust default labels and the title / description / note templates.
7. **Save settings**.

## Use

1. Open a ticket in the osTicket **staff panel** (`/scp/tickets.php?id=…`).
2. Click the extension icon. Review the prefilled issue: assignee is matched
   from osTicket's *Assigned To*, labels are the project's existing labels.
3. Keep **Upload files** and **Post internal note** on as needed, then
   **Create issue**.

## Permissions & privacy

| Permission | Why |
|---|---|
| `activeTab`, `scripting` | Read the ticket page **only when you click the icon**, on that tab only. No access to other sites or to osTicket in the background. |
| `storage` | Keep your settings and token in the browser's extension storage (local, unencrypted, per profile — use a token with a sensible expiry). |
| optional host permission | Requested at runtime for the **one GitLab origin you configure**, so the service worker can call its API. |

Ticket data is sent only to the GitLab instance you configure. Attachments are
downloaded through your osTicket session in the page and uploaded to that
GitLab project. Nothing is sent anywhere else, and there is no telemetry.

## Templates

Title, description and the internal note are templates (Settings). Ticket
placeholders:

```
{{number}} {{id}} {{subject}} {{url}} {{user}} {{email}} {{department}}
{{status}} {{priority}} {{created}} {{source}} {{helpTopic}} {{assigned}}
{{sla}} {{dueDate}} {{details}} {{message}} {{attachments}}
```

`{{details}}` renders a Markdown table of every field in the ticket-info panel
(so custom fields are included even if they have no dedicated placeholder). The
note template additionally gets `{{iid}}`, `{{issueUrl}}` and `{{issueTitle}}`.

## How it works

```
osTicket tab ──(activeTab)──► content.js   reads DOM, fetches files, posts note
                                   │ messages
                              popup.js      review form, orchestration
                                   │ messages
                              background.js GitLab API (only place the token is used)
```

- `content.js` scrapes the ticket from the standard `ticket-view.inc.php`
  markup (osTicket 1.14–1.18 tested), including inline images in the first
  message. Field labels are matched in English and Persian; unknown labels still
  land in `{{details}}`.
- Files are fetched **inside the page** (same origin → session cookie) and
  handed to the service worker as base64, which uploads them with
  `POST /projects/:id/uploads` and rewrites the links in the description.
- The internal note is posted by re-submitting the page's own *Post Internal
  Note* form (CSRF token and ticket id included), so it appears exactly as if you
  typed it.
- Labels are always taken from `GET /labels` (project + ancestor groups), so the
  extension never creates new labels by accident.

## Compatibility

- Chrome 116+, Edge, Brave, Opera (any recent Chromium; MV3).
- Firefox is not supported yet (needs `browser.*` polyfill and MV3 differences).
- osTicket: developed against 1.17/1.18's staff panel. If your theme changes the
  DOM, adjust the selectors at the top of `src/content.js`.

## Development

No build step. Edit the files under `src/`, then click **Reload** on the
extensions page. Syntax check with `node --check src/*.js`.

```
manifest.json      MV3 manifest
src/content.js     osTicket page: scrape ticket, fetch files, post note
src/background.js  GitLab API service worker
src/popup.*        review-and-create UI
src/options.*      settings page
src/settings.js    defaults + template rendering (shared)
src/ui.css         design tokens and components (shared)
icons/             toolbar icons
```

## License

[MIT](LICENSE)
