# Job notifications while the app is closed (Web Push)

## Intent

The owner: "If I enable notifications, I should be getting notifications, closed or not." The local notifications of the installable
app (2026-11-18-pwa-design.md) work only while a Filedeck tab is open. This adds Web Push: the hub notices that a job ended and sends a
push, so the notification arrives with every Filedeck window closed.

## Decisions

- **No configuration.** The hub makes its VAPID key pair the first time it needs it and keeps it in its push store (next to the vault,
  `push.sqlite`, mode 0600). Two hub pods of a rollout share the file, and the first key written wins (`INSERT OR IGNORE`), so both use
  the same key. `FILEDECK_PUSH=off` turns the feature off; `FILEDECK_PUSH_SUBJECT` sets the VAPID contact (default the project's URL).
- **Subscriptions belong to an account and a session.** `POST /api/push/subscribe` stores the browser's endpoint and keys with the
  account (`sys:alice`, `virt:bob`) and the session key it was made in. Sign-in off: one shared owner, no session.
- **Subscriptions end with their session.** A session that ends (sign-out, idle or absolute limit, ended by an administrator) and an
  account change (epoch rise, deletion, every session ended) deletes its subscriptions: through `Sessions.onEnd`, and the watcher also
  drops any subscription whose session `peek` no longer holds before it sends anything. A push service answer of 404 or 410 deletes it.
- **Only real push services.** The endpoint must be `https:` on a known push service host (Google, Mozilla, Apple, Microsoft), so a
  signed-in person cannot make the hub post to an address of their choice. `FILEDECK_PUSH_HOSTS` adds hosts.
- **What is watched.** Every 15 s, for each account with a subscription, the hub lists that account's jobs as that account: its hub
  operations (copy, move, sync, trash), its compares, and each machine's jobs (compress, extract and the others), through the same calls
  and checks as the account's own requests. A job started from the app (origin `ui`) that is `done` or `failed` (never `canceled`),
  finished after the subscription was made and in the last 24 h, is sent once: the shared store records `owner|source|id` before the
  send (`INSERT OR IGNORE`), so two hub pods never both send it. Several ends in one pass fold into one push.
- **Payload.** Only the job title and the outcome (`Copy x finished`, `Compress y failed` with the first line of the error), encrypted
  per RFC 8291 (aes128gcm), signed per RFC 8292 (VAPID, ES256). `TTL` one day. Built on `node:crypto`, no new dependency.
- **Browser side.** The Settings switch subscribes (`pushManager.subscribe`, the hub's public key) after permission is granted, and
  unsubscribes when turned off. At start-up with the switch on, the page sends its subscription again, so it follows a new sign-in. The
  service worker shows each push unless a Filedeck window is visible (the in-app tray already shows the end). The page's own local
  notifications stay as the fallback where push is not available, and are skipped when push is active.
- **Uploads** run in the browser, so a closed app has none to report; they keep the local notification only.

## Tests

- RFC 8291 Appendix A vector, and a decrypt round trip; VAPID JWT verifies with the public key.
- Store: keys made once and shared; subscribe replaces by endpoint; end by session, by account; sent-once claim; pruning.
- Watcher: picks done/failed `ui` jobs ended after the subscription; not canceled, not old, not other origins; one push for several;
  410 deletes; a session that no longer holds deletes and sends nothing; agent lists are asked as the account.
- Routes: subscribe needs a signed-in session (sign-in on), refuses non-push hosts, delete only removes the caller's own endpoint.
- Browser acceptance: the switch subscribes and the hub stores it; turning off removes it.
