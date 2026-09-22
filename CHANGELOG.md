# Changelog

All notable changes to this project are documented here. Versions follow
`manifest.json`.

## 1.6.0 — 2026-09-22
- Optional branch + draft merge request / pull request per issue. Off by
  default; toggle it in the popup (or make it the default in Settings). The
  branch name comes from a template (`ticket-{{number}}-{{slug}}`, slug = English
  words of the subject) and is always editable before creating.
- GitLab: branch from the default branch and a `Draft:` MR that closes the issue.
  GitHub: same, plus an empty commit (a PR needs at least one), draft PR with a
  fallback to a regular PR on plans without drafts.
- The internal note gets `{{mr}}` (a line with the MR/PR link, empty if none).

## 1.5.0 — 2026-09-20
- GitHub support (github.com and GitHub Enterprise): choose the tracker in
  Settings. Labels, assignees, duplicate search and the link-back note work the
  same way; attachment uploads and confidential issues are GitLab-only because
  the GitHub API has no equivalent.
- Note templates use `{{provider}}` so the wording follows the tracker.

## 1.4.0 — 2026-09-20
- Removed all hard-coded hosts: osTicket access now uses `activeTab` (only the
  tab you click on), the GitLab origin is requested at runtime from Settings.
- Popup asks for configuration when the project or token is missing.
- Prepared for open-source release (README, LICENSE, changelog).

## 1.3.0
- New UI for popup and settings (ticket summary card, label chips, toggles,
  progress + result card, dark mode).
- Post an internal note with the issue link on the ticket after creation.
- Escape `|` in ticket field values inside the details table.

## 1.2.x
- Assignee picker (matched from osTicket's *Assigned To*, fallback to you).
- Labels are chosen from the project's existing labels; no accidental creation.
- Per-request error reporting and diagnostics in *Test connection*.

## 1.1.0
- Fixed subject / ticket number extraction for the standard staff-panel markup.
- Upload the ticket's attachments and inline images into the GitLab issue.

## 1.0.0
- Initial version: create an issue from the ticket page with a prefilled
  Markdown description.
