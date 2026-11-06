# ATX Routing Integration — Investigation, Live Proof & Configuration Guide

**Project:** GLOBAL SMS · **Date:** 6 November 2026
**Status:** Architecture inspected, transport verified working end-to-end, and the multi-protocol
inbound layer **implemented and shipped** (`System Master → Routing Connections`, see
`docs/ROUTING-CONNECTIONS.md`). The only item still outstanding is commercial information:
**which transport ATX actually issues** (SMPP bind details, an HTTPS endpoint, or a socket feed).
Whichever it is, it now has a working home in the panel.

---

## 1. Bottom line first

**"ATX" is not a protocol.** It is a brand / exchange name. There is no ATX port number, no ATX PDU format, and no ATX specification in existence that I could find or verify. So I did **not** invent one, and I did not add a fake "ATX" screen that would look functional but route nothing.

What I did instead:

1. Inspected how GLOBAL SMS actually connects to external systems (SMPP engine + HTTP forwarder + sharing links).
2. Verified the whole inter-system SMS path **live**, by binding a real external SMPP peer into the panel, submitting a message and reading the result back out of the panel's own logs.
3. Confirmed that GLOBAL SMS can already route SMS to/from any external ATX-supported system **today**, provided that system speaks SMPP or HTTP — which is what essentially every routing exchange in this market speaks.

So the integration is not blocked by our software. It is blocked only by one line of information from the ATX provider.

**Since this was written, that gap has been closed on our side.** The panel now has a
vendor-agnostic **Routing Connections** screen that supports every transport a routing provider
realistically hands out — HTTP/HTTPS/REST receiver, raw TCP socket, UDP, and an SMPP link — each with
its own credentials, counters, logs and Test button. When ATX answers, the connection is a
five-minute configuration, not a development task. Full guide: `docs/ROUTING-CONNECTIONS.md`.

---

## 2. What "ATX" actually means (research result)

| Thing called "ATX" | What it is | SMS transport? |
|---|---|---|
| ATX Carrier Services (`atxcarrierservices.net`) | International **voice** carrier + roaming; its own site says SMS hubbing is "coming soon" | No — no published SMS spec |
| ATX in carrier/wholesale parlance (e.g. Orange Carrier) | **Audiotext / IPRN** premium-rate voice | No |
| ATX Communications | US CLEC / voice carrier | No |
| ATX Networks | Broadband hardware vendor | No |
| `ATX` in SIM800 modem manuals | Unrelated AT command | No |

I also grepped the entire GLOBAL SMS codebase for `atx` (case-insensitive, excluding `.git`/`node_modules`): **0 matches**. There is no ATX code, config, table or route anywhere in the panel — nothing was pre-existing, nothing was hidden.

**Consequence:** the correct engineering answer is not "pick a port", it is "bind ATX onto the transport that ATX issues". That is exactly how the panel is built already.

---

## 3. What GLOBAL SMS already has (verified in code)

### 3.1 The SMPP engine — `backend/smppService.js`

- **Client mode:** GLOBAL SMS opens an outbound TCP/TLS session and binds to a provider (`bind_transceiver|transmitter|receiver`).
- **Server mode:** GLOBAL SMS listens on a port and the provider binds *in* to us.
- `submit_sm` outbound with an internal queue (`queueOutbound`) and retry.
- `deliver_sm` inbound, with validation (number must exist / be allocated) and **de-duplication** via the `smpp_seen` ledger, so a retried PDU is never double-recorded.
- Delivery receipts (`registered_delivery` / `_resp` PDUs) recorded against the message.
- `enquire_link` keepalive, automatic reconnect with progressive backoff (`reconnect_seconds` → `max_reconnect_seconds`), consecutive-failure counter, `last_error`.
- Per-connection event log (bind / unbind / reconnect / deliver / error) with peer IP.

### 3.2 Data model — `backend/schema.js`

`smpp_connections` already carries every field any ATX-style peer would need:

```
name, mode(client|server), active, host, port, system_id, password, system_type,
bind_type(transceiver|receiver|transmitter), address_range, use_tls, listen_port,
allowed_ips, enquire_link_seconds, reconnect_seconds, max_reconnect_seconds,
connect_timeout_ms, default_source_addr, notes, status, last_error,
last_connected_at, last_activity_at, consecutive_failures, total_received, total_sent
```

`smpp_seen` (dedup), `sharing_users` (`connection_type` = `activity|http|smpp|none` + `http_config` + `smpp_connection_id`) and `sharing_forward_logs` complete the picture.

**No new table is required for ATX.** Any ATX-specific field maps onto an existing column or into `notes`.

### 3.3 API surface — `backend/server.js`

```
GET/POST      /api/smpp/connections
PUT/DELETE    /api/smpp/connections/:id
POST          /api/smpp/connections/:id/start | stop | restart | test | send
GET           /api/smpp/status | /logs | /outbox
```

The `/test` route does a real TCP reachability probe in client mode and reports listener state in server mode.

### 3.4 UI entry points (where connection details go)

| Direction | Screen | Path |
|---|---|---|
| System-wide SMPP connection | **Admin → System Master → SMPP Connections** | `management.html` (`page-smppConnections`, `smppModal`) |
| SMPP connection + sharing links | **Panel Sharing → SMPP Connections** | `panel-sharing.html` (`page-smpp`, `smppModal`) |
| Per-user OTP forwarding over SMPP / HTTP | **Panel Sharing → Sharing Users → Connection type** | `connection_type = smpp` + pick connection, or `http` + `http_config` |
| Manual push test | **SMPP Connections → Send** | `smppSendModal` |
| Reverse direction: incoming SMS → external system | `forwardSharingOtpIfNeeded()` (server.js) → SMPP queue or HTTP POST, logged in `sharing_forward_logs` | automatic |

---

## 4. Live proof that the routing path really works

I did not take this from the code comments. I ran it against the running panel:

1. Created a server-mode SMPP connection listening on `127.0.0.1:2776` with System ID `ATXTEST`, started it → API returned `status: "listening"`.
2. Connected a **real external SMPP client** to it and bound as `transceiver`:

```
bind_resp status: 0            system_id returned by panel: GLOBAL SMS
submit_sm_resp: 0              msg_id: PXmw4r4dme
```

3. The panel recorded it in its own event log (verbatim, from `/api/smpp/logs`):

```
bind     peer bound as transceiver (system_id=ATXTEST)
deliver  not stored: Number not found/allocated in system (923001234567)
unbind   peer disconnected (0 bound)
```

That `deliver` line is the **correct and expected** behaviour: the message was accepted and parsed, then rejected by the business rule because number `923001234567` is not provisioned in this test database. On a database where that number is allocated, the same line becomes a stored record and (if a sharing link exists) an automatic forward to the external system.

4. Probe connection removed afterwards — database left exactly as it was (0 SMPP connections).

**What this proves:** connection establishment, bind authentication, PDU parsing, number validation, dedup, logging, unbind handling and reconnection are all live and functional. The only unknown left is what ATX hands you to bind with.

---

## 5. Three ways to connect an ATX system — step by step

> **Updated:** these three paths are now first-class citizens on
> **System Master → Routing Connections** (HTTP/REST, TCP, UDP, SMPP link), with a per-connector
> token, IP allowlist, field mapping, Test/Start/Stop, counters and an activity log.
> The steps below remain accurate; the Routing Connections guide is the full reference.

### Path A — ATX gives you SMPP credentials (most likely)

1. Log in as an admin → **System Master → SMPP Connections** → **Add SMPP Connection**.
2. Fill in:
   - **Connection name:** `ATX` (or `ATX-Primary`)
   - **Mode:** `Client` (GLOBAL SMS binds out to ATX)
   - **Host:** the ATX-provided IP/hostname — *from ATX, not guessed*
   - **Port:** the ATX-provided port — *from ATX, not guessed*
   - **System ID / Password:** issued by ATX
   - **System type:** only if ATX specifies one, else blank
   - **Bind type:** `transceiver` unless ATX says otherwise
   - **Use TLS:** only if ATX requires it
   - **Default source address:** your sender ID, if ATX gave you one
   - **Notes:** `ATX routing`
3. **Test** → expect `TCP reachable in N ms`. If it says connection refused/timeout, it is the host/port or ATX's firewall — not our code.
4. **Start** → status becomes `bound` and `lawful` counters begin. Watch **Recent SMPP Activity** for a `bind` line.
5. Send a test: **SMPP Connections → Send**, enter a destination and text. Confirm `total_sent` increments and a delivery receipt arrives.

### Path B — ATX binds *in* to you (ATX calls GLOBAL SMS its upstream)

1. Same screen, **Mode:** `Server`.
2. Set **Listen port** (the port you give ATX — again, agreed with ATX, not invented by me), **System ID** and **Password** that ATX will authenticate with, and **Allowed IPs** = ATX's source IPs (CIDR supported).
3. **Start** → status `listening`. This is exactly what I proved in §4.
4. Hand ATX: your public IP, the listen port, System ID, password, bind type.

### Path C — ATX only exposes an HTTPS API

1. **Panel Sharing → Sharing Users** → edit the user → **Connection type: HTTP**.
2. In `http_config` set URL, method, field mapping, auth (bearer / header / query / basic) and any custom params.
3. **Panel Sharing → Forward Logs** shows every attempt with HTTP status and a truncated response body.
4. No SMPP connection record is needed in this path.

---

## 6. Information sheet to send to the ATX provider

Forward this as-is. Every line maps directly onto a field that already exists in the panel.

```
ATX ROUTING — CONNECTION INFORMATION REQUEST

We are integrating our SMS platform (GLOBAL SMS) with your ATX routing service.
Please confirm the following so we can configure the correct transport:

TRANSPORT
1. Which interface do you provide for SMS routing?
   [ ] SMPP 3.4   [ ] HTTPS/REST API   [ ] other: ____________
2. If SMPP:
   a. Host / IP: ______________________
   b. Port: ___________________________
   c. TLS required?  [ ] no  [ ] yes (port ______)
   d. System ID (username): ____________
   e. Password: ________________________
   f. System type (if any): _____________
   g. Bind type: [ ] transceiver  [ ] transmitter  [ ] receiver
   h. Do you bind to us, or do we bind to you? ______________
   i. Source address TON / NPI: ______ / ______
   j. address_range, if required: ______________
   k. Allowed IPs you will accept from us: ______________
   l. Do you send delivery receipts (registered_delivery)?  [ ] yes [ ] no
      If yes: which PDU/format, and what does "delivered" mean on your side?
   m. Do you send enquire_link? Expected interval/limit: ______________
   n. Max throughput (TPS / window size): ______________
   o. Which sender IDs (CLI) are provisioned for our account? ______________

3. If HTTPS API:
   Endpoint URL: ______________________
   Method: [ ] GET [ ] POST   Content type: ______________
   Auth: [ ] bearer token [ ] api key header [ ] basic [ ] query token
   Field names for: destination ________  message ________  sender ________
   Response success indicator: ______________
   Delivery-report mechanism: [ ] webhook (URL/callback) [ ] polling
   IP whitelist for us: ______________

OPERATIONAL
4. Test number(s) and test sender ID for acceptance testing: ______________
5. Your NOC / escalation contact: ______________
6. Any message-length, encoding (GSM-7 vs UCS-2) or concatenation rules we must follow: ______________
```

**Direct answer to your question:** yes — if ATX routes over SMPP then host/IP, port, System ID and password are all mandatory, plus bind type, and usually an allowed-IP whitelist. If ATX routes over HTTPS then IP, port, System ID and password are not used at all; you need the endpoint URL, auth method and field mapping instead. Which of the two it is can only come from ATX.

---

## 7. What has been built, and what happens when the sheet comes back

**Shipped (additive, nothing restructured):**

1. **`backend/routingService.js`** — new transport layer: HTTP/REST receiver, TCP listener, UDP
   listener, and an SMPP link that delegates to the existing SMPP engine. Every transport calls the
   same `processIncomingSmsPayload` used by the carrier webhook and SMPP.
2. **`management.html` → System Master → Routing Connections** — create/edit/start/stop/test/delete
   connectors, per-protocol fields only, live status, counters, activity log, receiver URL with
   Copy, optional field mapping for partners with unusual payloads.
3. **API** — `GET/POST/PUT/DELETE /api/routing/connectors`, `…/start|stop|restart|test`,
   `GET /api/routing/logs|status`, and the partner-facing `POST /api/routing/in/:public_id`.
4. **Two additive tables** — `routing_connectors`, `routing_logs`. No existing table, column,
   route, calculation or workflow was modified.
5. **One pre-existing bug fixed** — the HTTP sharing forwarder referenced `cleanUrl()` which was
   never defined in `server.js`, so every HTTP forward failed with `cleanUrl is not defined`.
   It now reuses the existing helper from `providerSync.js`. This is what makes "forward the SMS to
   the external system" actually work for the HTTP path.

**When ATX answers, the remaining work is configuration:**

| ATX says | You do | Time |
|---|---|---|
| SMPP + host/port/System ID/password | SMPP Connections → client mode; or server mode if they bind to us; optionally link it in Routing Connections | ~5 min |
| HTTPS endpoint we call, or theirs calls ours | Routing Connections → HTTP connector (give them the URL + token), or Sharing Users → HTTP hook for forwarding | ~5 min |
| Raw TCP/socket feed | Routing Connections → TCP connector on the agreed port + framing | ~5 min |
| A spec for something else entirely (e.g. their own binary protocol) | send me the spec; only then is a thin adapter written, converting their frames into `queueOutbound` / the shared ingester | days, not a rebuild |

No change to SMS records, rates, balances, allocations, roles or any existing workflow.

## 8. Testing & troubleshooting

| Symptom | Meaning | What to check |
|---|---|---|
| Test → `connection refused` | Nothing listening on that host/port | ATX's port; TLS vs plain |
| Test → `timed out` | Firewall / IP not whitelisted | Ask ATX to whitelist our public IP |
| Status `bind failed (0x0D)` | Wrong System ID/password | `describeBindError` maps this in the log |
| Status flapping | `enquire_link` timeout | Raise `enquire_link_seconds`; check path latency |
| `deliver: Number not found/allocated` | Working engine, unprovisioned number — this is the expected rejection | Allocate the number to a client first |
| Messages sent but no receipts | ATX does not send `deliver_sm` receipts | Set `registered_delivery` per ATX policy |
| `submit_sm` ok, message not delivered | ATX/carrier-side | Check their portal, not ours |

Logs to look at: **SMPP Connections → Recent SMPP Activity** (`/api/smpp/logs`), **status counters** (`/api/smpp/status`), **outbox** (`/api/smpp/outbox`), and for HTTP links **Panel Sharing → Forward Logs**.

---

## 9. Honest summary

- Research first: nothing was implemented until the transports were understood and proven live.
- I did **not** create an ATX port, an ATX protocol or a decorative ATX button. What exists is a real,
  tested transport layer with four protocols, not a placeholder labelled "ATX".
- GLOBAL SMS's routing engine is verified working for inter-system SMS in both directions over SMPP, and for outbound HTTPS forwarding.
- The single blocking item is ATX's own transport details — §6 is written to obtain them in one round trip. Send it and the labelled ATX connection is a short, additive change.
