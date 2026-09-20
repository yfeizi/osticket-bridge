# Changelog

## 1.4.0
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
