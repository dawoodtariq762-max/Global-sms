# Routing Connections — Configuration Guide

**GLOBAL SMS** · System Master → Routing Connections · v1.0 (6 Nov 2026)

This is the operator guide for the multi-protocol inbound routing feature. It is written so a
non-developer can onboard a new provider or partner (for example an ATX-style routing exchange)
**without any further development**.

**One rule above all:** the protocol, host and port always come from the partner. Nothing in this
guide is a guess, and GLOBAL SMS never invents a port for a partner.

---

## 1. What a "routing connector" is

A routing connector is **one named, credentialed endpoint** that an external system uses to deliver
SMS into GLOBAL SMS. Each connector is independent: start/stop one without touching the others,
and each keeps its own counters, error state and activity log.

All four protocols feed the **same ingestion path** already used by `/api/incoming-sms` and SMPP.
That means an SMS that arrives over TCP is processed exactly like one that arrives over HTTP:

- matched against the allocated numbers (unallocated numbers are rejected, never invented)
- rate card, payout, payment type and daily limits applied by the existing rules
- OTP code extracted
- saved to `sms_records` with `source = routing_<protocol>`
- forwarded to the sharing client if a Sharing User hook is configured
  (`Panel Sharing → Sharing Users → connection type HTTP / SMPP`)
- de-duplicated when the partner sends a unique message id

**No existing table, API, calculation, role or workflow was changed.** The feature adds two tables
(`routing_connectors`, `routing_logs`) and one screen.

---

## 2. Supported protocols and what each one needs

| Protocol | Direction | What GLOBAL SMS does | What the partner does | Credentials you exchange |
|---|---|---|---|---|
| **HTTP / HTTPS / REST** | inbound | Exposes `POST /api/routing/in/<public id>` on the existing web port | Calls that URL with JSON, form data or query string | URL + token (+ optional IP allowlist) |
| **TCP socket** | inbound | Listens on a port you choose with a framing rule | Opens a TCP connection and pushes frames | Your server IP + port + framing + template |
| **UDP** | inbound | Listens on a port (datagrams) | Sends datagrams | Same as TCP |
| **SMPP** | outbound bind, or inbound bind | Delegates to the existing SMPP engine (no second engine) | Binds to us, or accepts our bind | Host, port, System ID, password, bind type, TON/NPI |
| **HTTPS push (existing)** | inbound | `/api/incoming-sms` with Carrier Integration settings | POST | Their IP in the allowlist |
| **REST pull (existing)** | inbound | Provider Sync polls their API | Hosts the API | API URL + token |

For **sending** SMS *to* a partner, use the pre-existing, unchanged paths:
`System Master → SMPP Connections` (client bind out to them) or
`Panel Sharing → Sharing Users` (connection type SMPP or HTTP).

---

## 3. Step by step — HTTP / HTTPS / REST receiver

Best when the partner can call a URL (most routing exchanges and SMS APIs can).

1. **System Master → Routing Connections → + Add Connector.**
2. Name it, e.g. `ATX inbound`.
3. Protocol: **HTTP / HTTPS / REST**.
4. **Token**: type a long random secret. The partner must send it as
   `Authorization: Bearer <token>`, `x-route-token: <token>`, `x-api-key: <token>` or `?token=<token>`.
   Leave blank only for a trusted private network.
5. **Allowed IPs** (recommended): the partner's sending IPs, comma separated, CIDR allowed
   (`103.21.44.10, 103.21.44.0/24`). Blank = any IP (the token still applies).
6. **Reply to partner**: leave blank to answer `{"ok":true,"id":<sms id>,"otp_detected":true}`.
   Fill it with `OK` if the partner insists on a literal plain-text reply.
7. Status → **Enabled** → **Save Connector**.
8. Copy the **Receiver URL** from the row (or reopen the connector and press **Copy**). Send it to
   the partner as-is, e.g. `https://your-domain.example/api/routing/in/9f2c…`.
9. Press **Test** — it confirms the receiver is live and whether a token is required.

Partner payload — any of these shapes works out of the box, because the field aliases are the same
ones the carrier webhook already accepts:

```json
{"number":"447700900123","from":"ATX","text":"Your code is 445566","id":"atx-0001","date":"2026-11-06 09:30:00"}
```
```json
{"to":"447700900123","sender":"ATX","message":"Your code is 445566"}
```
```
POST /api/routing/in/<id>?token=...&number=447700900123&cli=ATX&message=Your%20code%20is%20445566
```

If the partner uses unusual names (`data.msisdn`, `sms.to`, …), set the **Field Mapping** paths and
nothing else changes. Sending the same `id` twice is recognised and ignored, so a retry never
creates a second record or a second payout.

---

## 4. Step by step — TCP socket

Best when the partner pushes raw text over a socket and cannot do HTTP.

1. **+ Add Connector** → Protocol **TCP Socket**.
2. **Bind Address** `0.0.0.0` (all interfaces) unless the server has several IPs.
3. **Listen Port** — a free port on this server, e.g. `9911`. This is *your* choice, agreed with the
   partner; there is no universal default.
4. **Framing** — how messages are separated on the wire:
   - `JSON` — one JSON object per message (newline-delimited or a complete object)
   - `Line` — one record per line
   - `Length prefixed` — 4-byte big-endian length, then the body
   - `Raw` — one message per connection, closed when the partner hangs up
5. **Field Separator** — used with `Line` when there is no JSON and no template (`|` by default:
   `number|sender|message`).
6. **Message Template** — for any other line format, e.g. `{number}|{cli}|{message}` or
   `{cli};{number};{message}`. Placeholders are captured in order.
7. Status **Enabled** → **Save**. The row shows `0.0.0.0:9911` and status **Listening**.
8. Give the partner: this server's public IP, the port, the framing, and (if used) the template.
9. **Test** reports the port as free (before start) or listening (after start). A connector that
   cannot bind (port in use, privileged port) shows the exact error in the Status column and the log.

The connector acknowledges each accepted frame with `OK` on the same socket, so a partner that waits
for an ack is satisfied. Idle sockets are closed after 10 minutes.

---

## 5. Step by step — UDP

Identical to TCP, except each datagram is one message. Use it only if the partner can only emit
datagrams; UDP gives no delivery acknowledgement at the transport level.

---

## 6. Step by step — SMPP link

Use this when the partnership *is* SMPP (the normal case for SMS routing exchanges).

1. Create the real connection first: **System Master → SMPP Connections → + Add Connection**.
   - Partner binds **to** us → mode **Server**, choose the listen port, set the System ID and
     password you will give them, and their IPs in **Allowed IPs**.
   - We bind **out** to them → mode **Client** with their host, port, System ID and password.
2. Back in **Routing Connections → + Add Connector**, protocol **SMPP**, pick that connection in
   **Linked SMPP Connection**, **Save**.
3. **Test** reports the live bind state; **Start/Stop** here controls the same SMPP connection.
4. The connector then shows `Bound` / `Listening` and counts what it receives.

Nothing is duplicated: SMPP bind, `enquire_link` keepalive, reconnect backoff, concatenated-message
reassembly, delivery receipts and de-duplication all remain the existing engine's job.

---

## 7. Verifying that everything works

| Check | Where |
|---|---|
| Connector is live | Routing Connections → Status column (`Listening` / `Bound` / `Linked`) |
| Message accepted | `Received` counter increments; the message appears in SMS records |
| Message rejected and why | `Rejected` counter + **Recent Routing Activity** (`invalid token`, `IP not allowed`, `Number not found/allocated`) |
| Forwarding to your client system | Panel Sharing → **Forward Logs** (`success` / `failed` with the HTTP status or error) |
| Nothing happened at all | The partner's side: wrong URL, wrong token, blocked IP, closed port |

Recommended first test with any new partner: allocate one number to a test client, have them send
one message, then confirm (a) the record exists, (b) the forward log shows `success`, (c) the
counter moved. That is the complete path end to end.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401 invalid or missing token` | Header/param name or value mismatch | Send the token exactly as configured (`Bearer`, `x-route-token`, `x-api-key`, `?token=`) |
| `403 IP not allowed` | Partner IP not in the allowlist (or allowlist empty on a restricted network) | Add their IP/CIDR; the rejection log shows the IP that arrived |
| `403 connector is stopped` | Status disabled or Stop pressed | Start it |
| `404 Number not found/allocated` | The engine's own rule — the number is not provisioned here | Buy/allocate the number first; this is not a routing failure |
| `EADDRINUSE` on a socket connector | Port already used by another service or connector | Pick another port and update the partner |
| Nothing arrives over TCP | Firewall / NAT / cloud security group | Open the port for the partner's IPs |
| Messages arrive but nothing forwards | No Sharing User hook, or the hook is failing | Panel Sharing → Sharing Users (connection type) → check Forward Logs |

---

## 9. Security notes

- The HTTP receiver is public by design (like the carrier webhook), so **always set a token**, and
  set an IP allowlist when the partner has fixed IPs.
- Tokens are stored per connector and never shown in the UI after saving; re-saving with an empty
  token keeps the stored one.
- Socket connectors bind to `0.0.0.0` by default so the partner can reach the server. Restrict with
  the firewall, and bind to a specific interface if the server has several.
- Every accepted message still passes the existing allocation, payout and limit rules — a routing
  connector cannot create an SMS for a number that does not exist in the panel.

---

## 10. Mapping this to an "ATX" provider

"ATX" is a brand, not a protocol, so ask the provider which transport they issue and use the matching
connector:

| What they give you | Connector to create |
|---|---|
| Host + port + System ID + password (SMPP) | SMPP Connections (client or server) + optional SMPP link connector |
| A URL + token for them to POST to | HTTP connector — give them the receiver URL and token |
| "We push to your socket on port X" | TCP connector on port X with their framing |
| Only a URL you must call to fetch messages | Provider Sync / REST pull (existing feature) |

What to request from them: protocol, host/IP, port, System ID/username, password, bind type,
TON/NPI, sender IDs, allowed-IP list, delivery-receipt support, TLS on/off, and message
encoding rules. The handout is in `docs/ATX-ROUTING-INTEGRATION.md` §6.

---

## 11. API reference (for administrators / integrators)

All admin-only, JWT-protected:

```
GET    /api/routing/connectors            list (status, counters, endpoint)
POST   /api/routing/connectors            create
PUT    /api/routing/connectors/:id        update (live connectors restart automatically)
DELETE /api/routing/connectors/:id        delete (received SMS records are kept)
POST   /api/routing/connectors/:id/start | stop | restart
POST   /api/routing/connectors/:id/test   connectivity / receiver check
GET    /api/routing/logs[?connector_id=&limit=]
GET    /api/routing/status                engine state + all connectors

POST|GET /api/routing/in/:public_id       partner-facing receiver (token + IP rules)
```

Configuration flag: `ROUTING_ENABLED=false` disables all connectors at boot (default `true`).
Data is additive: tables `routing_connectors` and `routing_logs`; no existing table is altered.
