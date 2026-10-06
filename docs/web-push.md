# Web Push

For maintainers who change phone notifications. Suplex sends one Web Push
notification when a task enters `waiting_human`. Sources:
[sender and validation](../rust/src/web_push/mod.rs),
[store](../rust/src/web_push/store.rs),
[key](../rust/src/web_push/keys.rs),
[routes](../rust/src/http/routes/web_push.rs),
[service worker](../rust/src/http/pwa/sw.js), and
[Profile setting](../src/frontend/features/profiles/web-push-setting.tsx).

## What sends a push

A loop in the host reads the database every 5 seconds. It finds tasks whose
status is `waiting_human`, that are not archived, and whose
`status_changed_at` is not older than 10 minutes. A status change from any
process counts, because the loop reads the database and not an in-process event.

Each waiting episode is a pair of task id and `status_changed_at`. Suplex claims
an episode in `suplex_web_push_sent` before it sends, so one episode sends at most
one push, also with several host processes. A task that leaves `waiting_human`
and enters it again is a new episode. Episodes older than 10 minutes never send,
so a host that was stopped for a long time does not send a burst.

A crash after the claim and before the send loses that push. Suplex accepts
this. It does not retry. Push is best effort, and nothing waits for it.

## Who receives it

The task creator and every admin receive the push on each browser that they
turned on in Profile > **Notifications on this device**. Each recipient must
still have access to the task's company. A creator removed from the company
stops receiving pushes. A task that an agent created notifies admins only.

The notification title is the task title, cut to 120 characters. Opening it
shows the task.

## Subscriptions

The browser sends its `PushSubscription` to `PUT /api/web-push/subscription`.
An endpoint belongs to the user who signed in on that browser most recently.
The app sends the subscription again on each start, so the host copy recovers
after a restore or a new sign-in. A push service that answers 404 or 410
removes the subscription. Other failures are logged and dropped.

The host sends requests only to known push services:
`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.apple.com`,
and `*.notify.windows.com`, over HTTPS on port 443.

## Key

The installation's VAPID key is a P-256 key in `suplex_web_push_keys`. The host
creates it on first use. Browsers subscribe with its public half from
`GET /api/web-push/key`. A restored backup keeps the key, so existing
subscriptions keep working. The `web-push` crate encrypts each message
(RFC 8291) and signs it (RFC 8292). Suplex sends it with its own HTTP client.

## Limits

- iOS and iPadOS deliver Web Push only to a Home Screen app, version 16.4 or later.
- The macOS desktop app and the iOS and Android shells do not receive Web Push.
- There are no per-project or per-task settings.
