# Foafmixer browser client: UX redesign specification

Status: specification for the `web/` rewrite, 2026-09-02. The survey that
informs it is in [ux-survey.md](ux-survey.md). Open protocol topics that the
survey raised are in [xmpp-mainstream-gaps.md](xmpp-mainstream-gaps.md).

## Goal

Replace the tabbed pilot page with a chat layout that mainstream users of
Slack, Discord, WhatsApp and Signal already know how to use, without copying
any of those products' trade dress, icons or wording. Vanilla web components,
no build step, no framework. Mobile first, desktop too. Light and dark
themes. WCAG 2.2 AA as the floor.

## Non-negotiable behaviour carried over from the current client

The current `web/app.js` is the reference for every protocol detail below.
The rewrite changes presentation and structure, not protocol behaviour.

1. Strophe.js over WebSocket, `wss://<host>:<port>/xmpp`, stream management
   disabled, `rawInput`/`rawOutput` captured into the protocol log.
2. Sign-in with full JID and password. Password is never stored. Session
   restore keeps JID, WebSocket host and port and the last channel in
   `sessionStorage` for 20 minutes of inactivity, then signs out.
3. MIX join goes through the user's own server with XEP-0405 `client-join`
   (`urn:xmpp:mix:pam:2`) wrapping a Core 1 `join` that subscribes to the
   messages, participants and info nodes. Channel create is a Core 1
   `create` sent to the service.
4. Group messages are sent with `type='groupchat'` and a client-generated
   `id`. The client renders the server echo, never an optimistic copy. Until
   the echo arrives the message shows as pending.
5. Sender display comes from the `<mix>` child (`nick`, `jid`), accepting
   both `urn:xmpp:mix:core:1` and `urn:xmpp:mix:core:0`.
6. History is XEP-0313 MAM on the channel JID, newest 50 with RSM
   `<before/>`, results matched by `queryid`.
7. The protocol log keeps its pretty-printed, syntax-highlighted XML and the
   copy-to-clipboard action with the caution about authentication data.
8. Inputs unrelated to credentials keep `data-1p-ignore`; JID and password
   stay available to password managers.
9. Strophe is loaded from `cdn.jsdelivr.net` as today; the page must say so
   if it fails to load.

## What changes

- One timeline per channel. Live messages and MAM history are merged into a
  single list sorted by timestamp and de-duplicated by stanza id. The
  Live/History tabs disappear. "Load earlier messages" sits at the top of
  the list.
- Several channels at once. The sidebar lists joined channels; switching
  channels switches the timeline. Messages for non-active channels still
  arrive and raise an unread count.
- Enter sends, Shift+Enter inserts a newline. A per-device setting flips
  this for people who prefer the old Ctrl/Cmd+Enter behaviour.
- Sign-in, channel join/create and the developer log move into dialogs or a
  drawer instead of tabs.
- Participants and channel information (from the MIX info node: Name and
  Contact) appear in a details panel.

## Layout

Regions, using landmark roles:

| Region | Element | Desktop (≥ 64rem) | Tablet (≥ 48rem) | Mobile |
| --- | --- | --- | --- | --- |
| Sidebar | `<fm-sidebar>` in `<nav aria-label="Channels">` | fixed left column, 16rem | left column, 14rem | full-screen "Channels" view |
| Conversation | `<fm-conversation>` in `<main>` | centre, flexible | centre, flexible | full-screen view with back button |
| Details | `<fm-details>` in `<aside aria-label="Channel details">` | right column, 17rem, toggleable | overlay drawer from the right | overlay drawer from the right |
| Developer log | `<fm-protocol-log>` in a `<dialog>` | modal, large | modal | full-screen modal |

Mobile is a two-view stack: the channel list, then the conversation. The
browser back button and an in-header back control both return to the list
(`history.pushState` on entering a conversation). No bottom tab bar.

## Components

All components are light-DOM custom elements (no shadow root) so one global
stylesheet, form semantics and assistive-technology access stay simple.
Each component owns its subtree and re-renders from the store when it
receives a `change` event. Files live in `web/js/components/`.

| Element | Responsibility |
| --- | --- |
| `<fm-app>` | Layout shell, view switching on mobile, keyboard shortcuts, theme attribute, dialogs. |
| `<fm-sign-in>` | `<dialog>` with JID, password, remember-session checkbox, and an "Advanced" disclosure holding WebSocket host and port. Shown whenever disconnected. Status line with `role="status"`. |
| `<fm-sidebar>` | Account header (avatar initials, bare JID, connection dot, menu with theme, send-key setting, developer log, sign out). "Channels" list with unread badges and active state. "Join or create a channel" button. |
| `<fm-channel-dialog>` | `<dialog>` for join/create: service, channel name, nick. Create then join in one action when the user chooses "Create". |
| `<fm-conversation>` | Header (back control on mobile, channel name, participant count, details toggle), `<fm-message-list>`, `<fm-composer>`. |
| `<fm-message-list>` | Timeline with day separators, consecutive-message grouping (same sender within 5 minutes), unread divider, "Load earlier messages" at top, "Jump to latest" floating control when scrolled up, scroll anchoring on new messages. `role="log"`, `aria-live="polite"` on a visually hidden announcer, not on the whole list. |
| `<fm-message>` | Avatar (initials, deterministic colour from the sender JID, `aria-hidden`), sender name, `<time datetime>` with locale short time, body with URLs linkified (`rel="noopener noreferrer"`), pending and own-message states. |
| `<fm-composer>` | Auto-growing `<textarea>` with visible label (visually hidden), send button, send-key behaviour, draft kept per channel in `sessionStorage`, disabled state with the reason in the placeholder. |
| `<fm-details>` | Channel information from the info node (Name, Contact) and the participants list (PubSub items on the participants node, refreshed on join and on participant events). Leave-channel button. |
| `<fm-protocol-log>` | The existing log renderer and copy action inside a `<dialog>`. |
| `<fm-status>` | Single `role="status"` region for transient messages (connected, join failed, copied). Visible as a toast for 6 seconds, always present in the accessibility tree. |

Protocol code lives in `web/js/xmpp.js` as an `EventTarget` that owns the
Strophe connection and emits: `status`, `connected`, `disconnected`,
`channel-joined`, `channel-left`, `message`, `history`, `participants`,
`info`, `log`. The store in `web/js/store.js` holds app state (connection
status, JID, channels map, active channel, settings) and emits `change`.
Components never call Strophe directly.

## Theming

- CSS custom properties on `:root` define the light palette. `@media
  (prefers-color-scheme: dark)` redefines them, guarded by
  `:root:not([data-theme="light"])`; `:root[data-theme="dark"]` redefines
  them again so the explicit choice wins. `color-scheme` follows.
- Theme setting: system, light, dark; stored in `localStorage`.
- Contrast: body text ≥ 7:1, secondary text ≥ 4.5:1, UI controls ≥ 3:1,
  in both palettes. Record the checked pairs in a comment at the top of
  `styles.css`.
- `prefers-reduced-motion: reduce` disables the drawer and toast transitions.

## Accessibility

- Landmarks: `nav`, `main`, `aside`, `dialog`. A skip link to the composer.
- Every control has an accessible name; icon-only buttons use `aria-label`
  and a `title`.
- Keyboard: Tab order follows visual order. The channel list is a listbox
  with roving `tabindex` and arrow keys. `Escape` closes dialogs and
  drawers. `Ctrl/Cmd+K` opens a quick channel switcher (filter the sidebar
  list). Focus moves into a dialog on open and returns on close.
- Focus is visible: 3px outline with 2px offset, colour from the palette.
- Touch targets ≥ 44 × 44 CSS px on mobile.
- Text scales with browser zoom to 200% without loss of function; no
  fixed-height text containers.
- Announcements: new messages in the active channel announce sender and
  text at `polite`; errors at `assertive` through `<fm-status>`.
- No information conveyed by colour alone (unread has a badge count, pending
  has an icon and text, presence dot has text in the tooltip and name).

## Files

```
web/
  index.html          shell: <fm-app>, Strophe script, module entry
  styles.css          tokens, layout, components
  js/app.js           registers components, boots store and xmpp
  js/store.js         state + change events
  js/xmpp.js          Strophe wrapper (protocol)
  js/xml.js           pretty-print and highlight (moved from app.js)
  js/components/*.js  one file per element listed above
```

No bundler. `index.html` loads `js/app.js` as `type="module"` with a
`?v=` cache-busting query that the other imports do not need because the
module graph is fetched fresh when the entry changes.

## Acceptance

- Sign in, join `factoidal`, send a message, see the echo replace the
  pending row, see the same message in BeagleIM.
- Reload: connection details restored, password empty, channel remembered,
  join re-establishes membership, "Load earlier messages" merges history
  without duplicates.
- Mobile width (360 px): list view, conversation view, back works, composer
  stays above the keyboard, no horizontal scroll.
- Desktop width (1280 px): three columns, details panel toggles.
- Light and dark: switch at runtime, contrast pairs as documented.
- Keyboard only: full flow completes without a pointer.
- `node --check` passes on every JS file; the page loads with no console
  errors; the protocol log still shows IN/OUT stanzas.
