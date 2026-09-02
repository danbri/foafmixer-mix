# What mainstream chat users expect, and what XMPP MIX offers

Date: 2026-09-02. Companion to [ux-survey.md](ux-survey.md) and
[ux-redesign.md](ux-redesign.md). Each row names an expectation people
bring from Slack, Discord, WhatsApp, Signal or IRC, the XMPP mechanism that
answers it, what ejabberd 26.07 with the current patch series provides, and
the work split between the browser client and the server. "Topic" rows are
questions to investigate before committing to a design.

Priority: 1 is needed to feel like a normal chat app; 2 is expected within
the first week of use; 3 is a differentiator or a research question.

## Reading, writing, and seeing who is here

| Expectation | From | XMPP mechanism | State today | Client work | Server work | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| One timeline with history and live messages | all | XEP-0313 MAM on the channel plus live delivery | Works; both carry Core 1 metadata after patch 0003 | Merge and de-duplicate by stanza id (in the rewrite) | none | 1 |
| Unread counts and an unread divider | Slack, Discord, WhatsApp | XEP-0333 chat markers per conversation; XEP-0490 message displayed synchronization to share read position across devices | Nothing MIX-specific; ejabberd has no per-channel read state | Local read position per channel in storage first; XEP-0490 later | Topic: does XEP-0490 apply to MIX channels, or only to 1:1 and MUC | 1 |
| Enter sends | Slack, Discord, WhatsApp, Signal | none | n/a | Done in the rewrite, with a per-device switch | none | 1 |
| Message sent, delivered, read ticks | WhatsApp, Signal | XEP-0184 receipts for 1:1; in a channel the server echo is the only "sent" signal; per-participant delivery is not a MIX concept | Echo works and carries `submission-id` | Show one state: pending until echo, then sent. Say plainly that read state is per person, not per message | none | 1 |
| Typing indicators | Slack, Discord, WhatsApp | XEP-0085 chat state notifications inside a channel message without body | Topic: mod_mix may drop bodiless messages, and each state would fan out to every participant and land in MAM | Send and render if the server passes them through | Topic: confirm mod_mix handling; exclude chat states from MAM | 2 |
| Who is online | Discord, IRC, Slack dots | XEP-0403 MIX-PRESENCE node | Not implemented in ejabberd mod_mix | Render presence once available; until then show participants without status | Implement the presence node, or accept "members, not presence" like WhatsApp groups | 2 |
| Avatars and display names | all | XEP-0084 user avatar over PEP, XEP-0153 vCard avatar; MIX `nick` per participant | Nicks work; avatars need the real JID, which MIX-ANON can hide | Initials avatar from a hash of the sender now; fetch PEP avatars when the JID is visible | Topic: avatar in the participants node, or a channel-level avatar map | 2 |
| Channel description and topic | Slack, Discord, IRC | MIX info node Name, Description, Contact; XEP-0369 config node for settings | Patch 0001 serves Name and Contact; ejabberd stores no description | Show Name and Contact; show Description when present | Store a description and expose the config node | 2 |
| Browse public channels, search | Slack, Discord, IRC LIST | disco#items on the service; MIX searchable feature | disco#items lists non-hidden channels | Channel browser in the join dialog | none | 2 |

## Acting on messages

| Expectation | From | XMPP mechanism | State today | Client work | Server work | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| Reactions | Slack, Discord, WhatsApp, Signal | XEP-0444 message reactions, sent as channel messages referencing the stanza id | Untested through mod_mix; reactions have no body | Reactions row, toggle, counts | Topic: bodiless message routing and MAM policy for reactions | 2 |
| Edit a message | Slack, Discord, WhatsApp, Signal | XEP-0308 last message correction | Untested through mod_mix | Edit affordance on own messages, "(edited)" marker | Topic: routing of corrections and MAM representation | 2 |
| Delete a message | all | XEP-0424 message retraction; moderator retraction is XEP-0425, which is MUC-only | Untested; no MIX moderation retraction standard | Retract own messages | Topic: MIX moderation retraction needs a spec | 2 |
| Reply and quote | WhatsApp, Signal, Discord | XEP-0461 message replies | Client-only in principle | Reply affordance, quoted preview | none | 2 |
| Threads | Slack | XEP-0201 thread ids are weak; no XMPP equivalent of Slack threads | Nothing | Topic: represent a thread as replies grouped by a root id, or as a child channel | Topic | 3 |
| Mentions and mention notifications | Slack, Discord | XEP-0372 references; MIX proxy JIDs identify participants | Nothing | Autocomplete from the participants node; highlight own nick like IRC | Topic: push on mention needs XEP-0357 | 2 |
| Slash commands | IRC, Slack, Discord | XEP-0245 for `/me`; the rest is client convention | Nothing | `/join`, `/nick`, `/me`, `/leave`, `/topic` mapped to MIX operations | none | 3 |
| Links show previews | Slack, Discord, WhatsApp | No standard; the browser cannot fetch cross-origin pages | Nothing | Linkify only | Topic: an unfurl service is a privacy decision, so leave it off by default | 3 |

## Files, media, notifications

| Expectation | From | XMPP mechanism | State today | Client work | Server work | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| Send images and files | all | XEP-0363 HTTP file upload, XEP-0385 stateless inline media sharing | mod_http_upload exists in ejabberd, not enabled in the pilot | Upload control, inline image rendering with size limits | Enable mod_http_upload behind TLS with quotas | 2 |
| Notifications when the tab is hidden | all | Notifications API while the page is open; XEP-0357 push with a service worker for closed pages | Nothing | Notifications API with permission prompt on first mention | Topic: web push needs a push app server | 2 |
| Installable app, works offline for reading | WhatsApp, Signal | Service worker, cached MAM pages | Nothing | PWA manifest and cache of the last pages | none | 3 |
| Voice notes, calls | WhatsApp, Discord | XEP-0167 Jingle, XEP-0353 | Out of scope | none | none | 3 |

## Identity, safety, administration

| Expectation | From | XMPP mechanism | State today | Client work | Server work | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| End-to-end encryption | Signal, WhatsApp | XEP-0384 OMEMO; group OMEMO needs each member's real JID and device list, which conflicts with MIX-ANON | Disabled in the pilot on purpose | Topic: OMEMO in a MIX channel with visible JIDs only | Topic | 3 |
| Disappearing messages | Signal, WhatsApp | No MIX standard; MAM retention is a server policy | MAM keeps everything | Show the retention policy | Topic: per-channel retention | 3 |
| Invite someone | Slack, Discord, WhatsApp | XEP-0407 MIX-MISC invitations | Not in ejabberd | Invite dialog once the server supports it | Implement invitations | 2 |
| Roles, kick, ban, moderators | Discord, IRC ops, Slack admins | XEP-0406 MIX-ADMIN | Not in ejabberd | Role badges on messages once roles exist | Implement the admin node | 3 |
| Bots are visibly bots | Slack, Discord | disco#info identity `client/bot` on the bot's JID; nothing in MIX marks a participant as a bot | The pilot records responsibility in a local registry only | Badge when disco identity says bot | Topic: expose participant kind and responsible human in the participants node, as a Foafmixer extension | 2 |
| Same view on phone and laptop | all | MIX-PAM delivers to every online resource; MAM fills the rest | Works after patch 0002; multi-resource count still to be measured | De-duplicate by stanza id; refresh from MAM on focus | Finish the multi-resource matrix in the patch repository | 1 |
| Account creation and device linking | WhatsApp QR, Signal | XEP-0389 extensible in-band registration, XEP-0401 easy onboarding | Registration is by the account helper only, by design | none | Topic: invite links that carry an onboarding token | 3 |

## IRC habits worth keeping

IRC users expect keyboard-first operation, plain text, visible
timestamps, join and part notices, nick highlighting, and slash commands.
The rewrite keeps Ctrl/Cmd+K, Escape, visible timestamps and plain text.
Join and part notices can come from the participants node events; show
them collapsed, one line per burst, so they do not bury messages. Nick
highlight and slash commands are priority 2 and 3 above.

## Order of investigation

1. Bodiless channel messages through mod_mix (chat states, reactions,
   corrections, retractions all depend on it) and their MAM policy.
2. Read position: local first, then XEP-0490 applicability to MIX.
3. Presence node (XEP-0403) in ejabberd, or a decision to do without.
4. HTTP file upload in the pilot.
5. Participant kind and responsible human as a participants-node
   extension, so accountable bots are visible in every client.
