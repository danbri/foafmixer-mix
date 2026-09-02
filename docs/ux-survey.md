# UX survey: small open-source Slack- and Discord-shaped chat clients

Date: 2026-09-02. Purpose: find the structural conventions mainstream users
expect from a chat client, to guide the Foafmixer browser client rewrite
([ux-redesign.md](ux-redesign.md)). Nothing here reproduces code, CSS
values, icons, copy or trade dress from any product; it records layout and
component conventions in words. Claims are marked **seen** (read in source
or README) or **inferred**.

## Method

GitHub repository search for modest projects (under about 2k stars), then
the file tree of each and a few component sources read through the GitHub
API. Seven repositories were opened.

| Repo | Stars | Stack | Scope |
| --- | --- | --- | --- |
| [sanidhyy/slack-clone](https://github.com/sanidhyy/slack-clone) | 54 | Next.js, Convex, shadcn | Workspaces, channels, DMs, threads, reactions, rich-text editor |
| [laribright/slack-clone](https://github.com/laribright/slack-clone) | 234 | Next.js 15, Supabase | Course project; workspaces, channels, DMs, video |
| [burakorkmez/slack-clone](https://github.com/burakorkmez/slack-clone) | 104 | React, Stream Chat SDK | Threads, reactions, pins, polls; UI from a chat SDK |
| [Sirneij/slack-clone-ui](https://github.com/Sirneij/slack-clone-ui) | 61 | Vanilla HTML/CSS/JS | Static layout mockup only |
| [sanidhyy/discord-clone](https://github.com/sanidhyy/discord-clone) | 37 | Next.js 14, Prisma, Socket.io | Servers, text/audio/video channels, roles, DMs |
| [DevlinRocha/banter](https://github.com/DevlinRocha/banter) | 68 | Next.js, Redux, Firebase | Servers, channels, roles, settings |
| [sentrionic/Valkyrie](https://github.com/sentrionic/Valkyrie) | 334 | React + Chakra, Go | Guilds, DMs, friends, voice |

Two repositories share an author and toolkit, one of each shape, which
isolates what changes between the Slack shape and the Discord shape.

## Layout conventions

| Region | Desktop | Mobile | Prevalence |
| --- | --- | --- | --- |
| Workspace or server rail (icon list) | Slim fixed column, far left | Folded into the same drawer as the channel sidebar | 5 of 7; all Discord-shaped |
| Channel and DM sidebar | Fixed column, about 240 to 260 px | Off-canvas drawer opened by a hamburger control (seen) | 7 of 7 |
| Header (channel name, search, member count) | Fixed bar above the list | Persists; hamburger injected at its left edge | 7 of 7 |
| Message list | Centre, flexible | Full width | 7 of 7 |
| Composer | Bottom of the message column | Bottom, full width | 7 of 7 |
| Thread panel | Slide-in panel toggled by state, not a route (seen) | Replaces the message list | 4 of 7; Slack-shaped only |
| Member list | Discord-shaped: fixed right column, always visible (seen). Slack-shaped: a modal | Hidden on mobile in Discord-shaped clones | 3 of 3 Discord-shaped, 0 of 4 Slack-shaped |

## Component decomposition

Names vary; responsibilities converge.

- Rail item: one workspace or server icon, active state, navigates.
- Sidebar and section: groups channels by type or category, collapsible
  header, channel rows.
- Sidebar item: icon by channel type, name, unread indicator (indicator
  present in markup in some, wired in none).
- Header: name and topic, member count or search trigger, mobile toggle
  slot, action icons.
- Message list container: pagination state, scroll-up trigger, sentinel
  element at the bottom, date dividers, rows.
- Message row: author, timestamp, body, edit and delete state, attachments.
- Hover toolbar: react, reply, edit, delete; hidden until hover (seen).
- Composer: text input, attachment trigger, emoji trigger, submit.
- Emoji picker: one component reused from the composer and the hover
  toolbar.
- Reactions row: one pill per emoji with a count, click toggles.
- Thread bar and thread panel: a compact "N replies" affordance and the
  full panel are two components.
- Modals: create channel, create workspace or server, invite, delete
  confirmation, members. Discord-shaped clones route all of them through
  one modal store (seen).
- Providers composed once at the root: socket, modal, query, theme.
- A primitives directory (button, dialog, menu, tooltip, avatar) separate
  from feature components, in every framework-based repo.

## Message row anatomy

| Element | Found | Detail |
| --- | --- | --- |
| Avatar | All | Left, clickable to profile or DM |
| Display name | All | Bold, clickable; role badge inline in Discord-shaped |
| Timestamp | All | Compact next to the name; full timestamp on hover in one repo |
| Consecutive grouping | One (seen, an explicit compact prop) | Not universal in these clones, although both real products do it |
| Hover toolbar | All framework repos | Absolutely positioned top right of the row |
| Reactions row | Most | Below the body |
| Edited marker | Yes | Small "(edited)" when updated differs from created |
| Reply or thread affordance | Slack-shaped only | Reply count and last replier |
| Unread divider | None | Gap |
| Date separators | Yes | Centred text with rules either side (seen) |

## Composer conventions

- Enter sends, Shift+Enter inserts a newline, with an on-screen hint
  (seen in two repos). One Discord-shaped clone uses a single-line input.
- Attachment control on the leading edge; emoji control on the trailing
  edge.
- Mention autocomplete: not implemented in any repo read, although the
  placeholder copy mentions it.
- Draft persistence: none; forms reset on submit.
- Disabled state only while a submit is in flight. No repo showed a
  "join before posting" state.

## Navigation and state

- The URL carries workspace or server, channel, and DM identity; switching
  channels is a route change in every Next.js repo.
- History loads by cursor on scroll-up or a "load previous" control; the
  list is rendered newest at the bottom.
- A sentinel element at the bottom receives new-message scrolls. No
  "jump to latest" control was found.
- Unread badges: not wired in any sidebar item read.
- Live messages arrive over a socket and merge into the same cache the
  paginated query fills; there is no separate live feed component.

## Theming and accessibility

- Dark and light mode through a theme provider in every framework repo;
  system default inferred, not confirmed.
- Focus management and ARIA come from the primitives library; no repo
  added its own beyond one `aria-hidden` on a sentinel and one
  `aria-disabled` on a composer.
- Keyboard shortcuts: only Escape to cancel an inline edit was found. No
  quick switcher.
- Reduced motion: not handled in any repo.

## Discord-shaped differences

- Two navigation tiers (server rail, then channel sidebar) with two
  sidebar components; Slack-shaped clones fold workspace switching into one
  sidebar header.
- Channel types carry an icon (text, audio, video) from an explicit map.
- Member list is a persistent desktop pane.
- Role badges inline on every message.
- Voice and video presence are first-class sidebar elements.
- Message grouping was less consistently implemented than in the
  Slack-shaped clone, the reverse of the real products; treat as a clone
  gap, not a convention.

## Expected by users, absent from all seven

Unread divider and sidebar badge; jump to latest; typing indicators; read
receipts; mention autocomplete; message search (one repo filters channel
and member names only); link previews; push or desktop notifications; slash
commands. These are the table-stakes list to accept or reject deliberately;
their absence here shows each needs work beyond layout. The XMPP mapping
for each is in [xmpp-mainstream-gaps.md](xmpp-mainstream-gaps.md).
