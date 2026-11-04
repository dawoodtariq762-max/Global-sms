# GLOBAL SMS — Provider Integration Guide

**Audience:** the technical team of a carrier, SMS aggregator or SMS provider that
needs to exchange traffic with an GLOBAL SMS installation.

**Purpose:** this document explains the three integration methods GLOBAL SMS
supports, the parameters each one needs, the network access each one requires, and
how to test and troubleshoot the connection. It is written so that it can be
followed without access to the GLOBAL SMS source code or to the administration
panels.

**Status of this document:** read together with the GLOBAL SMS administrator. The
fields, endpoints and defaults below describe the capabilities implemented in the
current version. Anything that is **not** implemented is labelled
*Not currently supported* or *Not configurable* rather than presented as
available. If your requirement is not described here, raise it with the GLOBAL SMS
administrator before you build against it.

---

## 1. Introduction

GLOBAL SMS receives inbound SMS (including OTP / one-time-password traffic) through
a provider and records each message against the virtual number it was sent to.
There are three ways to deliver that traffic:

| # | Method | Who initiates the connection | Direction of traffic | Typical use |
|---|--------|------------------------------|----------------------|-------------|
| 1 | **HTTP incoming** (callback / push) | The provider | Provider → GLOBAL SMS | The provider's platform pushes each inbound SMS to a URL on the GLOBAL SMS server. |
| 2 | **SMPP** (persistent TCP session) | Either side — agreed in advance | Provider ⇄ GLOBAL SMS | A long-lived SMPP bind. GLOBAL SMS can be the SMPP **client** (it binds out to the provider) or the SMPP **server** (the provider binds in to it). |
| 3 | **API provider sync** (pull) | GLOBAL SMS | GLOBAL SMS → provider API → GLOBAL SMS | GLOBAL SMS polls the provider's HTTP API on a schedule and imports new records. |

Key distinction:

* **HTTP incoming** is a *push* — the provider's system makes the HTTP request.
* **SMPP** is a *session* — a TCP connection is established once and messages flow
  over it in both directions for as long as the session is bound.
* **API provider sync** is a *pull* — **GLOBAL SMS calls the provider's API**; the
  provider does not call GLOBAL SMS. It is **not** a webhook and it is **not** the
  same thing as HTTP incoming.

All three end in the same place: each message is validated, de-duplicated and
written into the same SMS records, where the same number allocation, rate-card,
payout and daily-limit rules apply. The method that is actually available to you,
and the settings that can be changed, depend on what the GLOBAL SMS administrator
has enabled in the installed version.

### 1.1 What the two sides must exchange

| GLOBAL SMS must give the provider | The provider must give GLOBAL SMS |
|---|---|
| The publicly reachable callback URL (HTTP incoming) | The provider's source / callback IP addresses (HTTP incoming) |
| The SMPP server host and listening port (SMPP Server Mode) | The SMPP server host, port, system ID and password (SMPP Client Mode) |
| The GLOBAL SMS public source IP (SMPP Client Mode, if the provider allowlists) | The agreed SMPP version, bind type, encoding and throughput limits |
| The assigned system ID and password (SMPP Server Mode) | API base URL, authentication scheme, response format and field names (API sync) |
| The list of numbers / ranges in scope | A technical contact for troubleshooting |

**Credentials (SMPP system ID and password, API tokens) must never be sent by
email or chat in plain text.** Exchange them through an agreed secure channel and
confirm receipt out of band.

---

## 2. HTTP Incoming SMS Integration

### 2.1 How it works, step by step

1. The GLOBAL SMS administrator enables **HTTP Integration** and adds the
   provider's source IP addresses to the **Allowed Carrier IP List**.
2. The administrator gives the provider the **callback URL**.
3. An SMS arrives at the provider for one of the numbers in scope.
4. The provider issues an HTTP request to the callback URL containing the
   recipient number, the sender (CLI) and the message text.
5. GLOBAL SMS checks that the integration is enabled and that the request's source
   IP is on the allowlist. If either check fails it returns **HTTP 403** and stores
   nothing.
6. GLOBAL SMS looks the recipient number up, applies the allocation, rate-card and
   daily-limit rules, and writes the SMS record.
7. GLOBAL SMS answers **HTTP 200** with a JSON body.
8. If the provider sends the same message again with the same unique message id,
   GLOBAL SMS recognises it as a duplicate and answers **200** with
   `"duplicate": true` without creating a second record.

### 2.2 Endpoint

| Item | Value |
|---|---|
| Path | `/api/incoming-sms` |
| Full URL | `https://<GLOBAL-SMS-HOST>/api/incoming-sms` — the host is supplied by the GLOBAL SMS administrator |
| Methods | **POST** (required for production). **GET** is accepted for connectivity tests and for carriers that can only probe a URL with a query string. |
| Accepted content types | `application/json`, `application/x-www-form-urlencoded`, `multipart/form-data` |
| Authentication | **None implemented.** The endpoint has no token, key or signature check. Access is controlled by the source-IP allowlist and by the integration being enabled. |
| Rate limiting | The endpoint is rate-limited per source IP (default 12,000 requests per minute, configurable by the operator). Contact the administrator if you expect more. |

Query-string parameters and body parameters are merged; if the same field is
present in both, the body value wins.

### 2.3 Request fields

Field names are matched from the lists below, in order. The first field present
and non-empty wins. Matching is on the exact spelling shown.

| Meaning | Accepted field names | Required |
|---|---|---|
| Recipient number (the virtual number the SMS was sent to) | `number`, `to`, `To`, `recipient`, `destination`, `msisdn`, `receiver`, `called` | **Yes** |
| Sender / CLI / originator | `cli`, `from`, `From`, `sender`, `originator`, `source`, `shortcode`, `service` | No (recommended) |
| Message text | `message`, `text`, `Text`, `body`, `Body`, `sms`, `content`, `msg` | No |
| Original timestamp | `date`, `Date`, `datetime`, `date_time`, `timestamp`, `time`, `dt`, `api_dt`, `received_at`, `sent_at`, `created_at` | No — **strongly recommended** |
| Unique message id (used for de-duplication) | `sms_id`, `id`, `message_id`, `msg_id`, `msgid`, `api_message_id`, `unique_id`, `uid` | No — **strongly recommended** |

**Number format.** Send the recipient in the same form it was allocated in. GLOBAL SMS normalises a leading `+`, leading zeros and common separators before matching,
so `+447700900123`, `447700900123` and `00447700900123` are treated as the same
number. Do not add spaces, extensions or country-name prefixes.

**Message format.** UTF-8 text. GLOBAL SMS extracts OTP codes from the text
automatically; send the raw message body, not a pre-parsed code.

**Timestamp format.** Accepted: `YYYY-MM-DD HH:MM:SS` (assumed **UTC** if no zone
is given), ISO-8601 with a zone, or Unix epoch in seconds (10 digits) or
milliseconds (13 digits). Without a timestamp the server's own clock is used,
which can place a delayed or replayed message in the wrong reporting day.

### 2.4 Responses

| HTTP status | Body | Meaning / what the provider should do |
|---|---|---|
| `200` | `{"ok":true,"id":123,"received_at":"2026-01-31 12:00:00","matched_number":"447700900123","sender_type":"shortcode","otp_detected":true}` | Accepted and stored. Do not resend. |
| `200` | `{"ok":true,"duplicate":true,"id":123,"provider_msg_id":"abc-1"}` | Already received — accepted, not stored twice. Stop retrying this message. |
| `400` | `{"error":"number/to field required"}` | The recipient field is missing. Fix the payload; do not retry unchanged. |
| `403` | `{"error":"Carrier integration is disabled"}` | The integration is switched off. Contact the GLOBAL SMS administrator. |
| `403` | `{"error":"IP not allowed","ip":"203.0.113.10"}` | The request came from an IP that is not on the allowlist. Give the administrator the IP shown in the response. |
| `404` | `{"error":"Number not found/allocated in system","number":"447700900123"}` | The recipient number is not provisioned or not allocated in GLOBAL SMS. Check the number list; retrying will not help. |
| `429` | rate-limit response | Slow down and retry with backoff. |

### 2.5 Retry and duplicate behaviour

* GLOBAL SMS never initiates the HTTP request, so it has no retry schedule of its
  own. Retry policy belongs to the provider.
* Retries are safe **only if** a unique `id` / `message_id` field is supplied.
  GLOBAL SMS records that id and answers `200 duplicate` for repeats, so a retry
  after a timeout is never paid for or reported twice.
* If no unique id is supplied, GLOBAL SMS cannot tell a retry from a genuinely
  repeated message, and the message may be recorded twice. **Always send a stable
  unique id.**
* Recommended provider retry policy: retry `5xx` and network timeouts with
  exponential backoff (for example 5 s, 25 s, 2 min, 10 min) for up to 24 hours.
  Do not retry `400` or `404` answers.

### 2.6 How the provider should test

1. Ask the administrator for a test number that is provisioned in GLOBAL SMS.
2. Send one message to that number from an allowlisted source IP.
3. Confirm `HTTP 200` and note the `id` in the response.
4. Send the **same** message again with the **same** unique id. Confirm
   `HTTP 200` with `"duplicate": true` and that no second record appears.
5. Send one message with a number that is not provisioned. Confirm `HTTP 404`.
6. Send one request from an IP that is not allowlisted. Confirm `HTTP 403` with
   `IP not allowed`.
7. Ask the administrator to confirm the records appear in the SMS report.

### 2.7 Information GLOBAL SMS needs from the provider

* Source IP address(es) that will call the callback (IPv4 and IPv6 if used).
* The exact payload format (JSON / form-encoded) and the field names you will send.
* Two or three sample requests, with real field names and masked credentials.
* The response codes your platform treats as success, and your retry schedule.
* A technical contact (name, e-mail, phone, escalation path, working hours).
* The list of numbers / ranges in scope, in the format you will send them.

### 2.8 Ports, firewalls and TLS

For HTTP incoming delivery the **provider must be able to reach** the GLOBAL SMS
callback URL. The path is:

```
Provider platform  →  Internet  →  [cloud firewall]  →  [VPS firewall]  →  [reverse proxy / web server]  →  GLOBAL SMS
```

| Layer | What must allow the traffic |
|---|---|
| Hosting provider cloud firewall | Inbound TCP **443** (HTTPS) to the VPS |
| VPS / OS firewall (ufw, iptables, nftables) | Inbound TCP **443** |
| Reverse proxy (Nginx, Caddy, …) | A TLS certificate and a `proxy_pass` to the GLOBAL SMS application port |
| GLOBAL SMS application | Integration **enabled** and the provider's IP on the **Allowed Carrier IP List** |

* **HTTPS (TCP 443) is required for production.** Plain HTTP on TCP 80 may be used
  only for a short controlled test.
* If the installation uses a non-standard external port, the administrator will
  state it and the URL will contain it, for example
  `https://sms.example.com:8443/api/incoming-sms`. Open only that port.
* **Do not open ports that are not needed.** In particular the application port,
  database ports and any administrative interface must stay closed to the
  provider's network.
* **The GLOBAL SMS source-IP allowlist is not the VPS firewall.** Adding an IP to
  the allowlist in the panel does **not** open a firewall port, and opening a
  firewall port does **not** add the IP to the allowlist. Both are required.
* Behind a reverse proxy, GLOBAL SMS reads the client IP from
  `CF-Connecting-IP`, then `X-Real-IP`, then the first entry of
  `X-Forwarded-For`, then the socket address. Make sure the proxy forwards the
  real client IP, otherwise the allowlist check will reject valid traffic.

---

## 3. HTTP Example Request and Response

All values below are **placeholders**. Replace them with the values supplied by the
GLOBAL SMS administrator.

### 3.1 JSON (recommended)

```http
POST /api/incoming-sms HTTP/1.1
Host: sms.example.com                     <-- GLOBAL-SMS-HOST placeholder
Content-Type: application/json
Accept: application/json

{
  "id":         "PROV-MSG-000123",         <-- your unique message id
  "number":     "447700900123",            <-- recipient (virtual number)
  "cli":        "ACMEBANK",                <-- sender / originator
  "message":    "Your code is 482913. It expires in 10 minutes.",
  "date":       "2026-01-31 12:00:00"      <-- original timestamp, UTC
}
```

Success:

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "ok": true,
  "id": 4821,
  "received_at": "2026-01-31 12:00:00",
  "matched_number": "447700900123",
  "sender_type": "alphanumeric",
  "otp_detected": true
}
```

Duplicate (same `id` sent again):

```http
HTTP/1.1 200 OK

{
  "ok": true,
  "duplicate": true,
  "id": 4821,
  "provider_msg_id": "PROV-MSG-000123"
}
```

Rejected source IP:

```http
HTTP/1.1 403 Forbidden

{ "error": "IP not allowed", "ip": "203.0.113.10" }
```

### 3.2 Form-encoded

The same endpoint accepts `application/x-www-form-urlencoded`. Field names are
identical:

```http
POST /api/incoming-sms HTTP/1.1
Host: sms.example.com
Content-Type: application/x-www-form-urlencoded

id=PROV-MSG-000124&number=447700900123&cli=ACMEBANK&message=Your+code+is+482913&date=2026-01-31+12%3A00%3A00
```

### 3.3 GET (testing only)

```http
GET /api/incoming-sms?number=447700900123&cli=ACMEBANK&message=Test+OTP+123456&id=PROV-MSG-000125&date=2026-01-31+12:00:00 HTTP/1.1
Host: sms.example.com
```

`curl` for a first connectivity check:

```bash
curl -i -X POST "https://sms.example.com/api/incoming-sms" \
     -H "Content-Type: application/json" \
     -d '{"id":"PROV-MSG-TEST-1","number":"447700900123","cli":"TESTSENDER","message":"GLOBAL SMS integration test","date":"2026-01-31 12:00:00"}'
```

> A `GET` to `/api/incoming-sms` **without** any of the message fields returns a
> small JSON description of the endpoint (status, accepted content types). It does
> not create a record and is safe to use as a reachability probe.

---

## 4. SMPP Integration

SMPP (Short Message Peer-to-Peer) is a binary protocol over a **persistent TCP
connection**. One side listens (the *server* / SMSC role), the other connects and
binds (the *client* / ESME role). Which side plays which role is agreed before the
connection is built, and GLOBAL SMS supports both.

### 4.1 SMPP Client Mode — GLOBAL SMS connects to the provider

```
GLOBAL SMS (ESME, client)   --outbound TCP-->   Provider SMPP server (SMSC)
   host, port, system_id, password  ---- bind_transceiver / receiver / transmitter ---->
```

* **GLOBAL SMS initiates the TCP connection** to the provider's SMPP server.
* The provider supplies the **host** (hostname or IP), the **port**, the
  **system ID** and the **password**, through a secure channel.
* **The provider's server port is the destination port of GLOBAL SMS's outbound
  connection.** It is not a port that GLOBAL SMS listens on.
* If the provider's SMPP server filters by source IP, the provider must allow
  the **public IP of the GLOBAL SMS VPS**. The administrator supplies it.
* GLOBAL SMS requires **outbound** network access from the VPS to the provider's
  host and port. No inbound firewall rule is needed on the GLOBAL SMS side.
* The provider must confirm the parameters in §4.4 that both sides support.

### 4.2 SMPP Server Mode — the provider connects to GLOBAL SMS

```
Provider (ESME, client)   --inbound TCP-->   GLOBAL SMS (SMSC, listening)
   system_id, password  ---- bind_transceiver / receiver / transmitter ---->
```

* **GLOBAL SMS listens** on a configured TCP port; the provider connects to it.
* GLOBAL SMS must have a reachable public IP address or hostname.
* The administrator configures the **listening port** and gives the provider the
  **server IP/hostname**, the **listening port**, the **system ID** and the
  **password**, all through a secure channel.
* **The GLOBAL SMS VPS firewall and any cloud firewall must permit inbound TCP on
  that listening port.** Restrict the source to the provider's IP range where
  possible.
* The listening service must be running and bound to the correct interface.
* The provider may need to allow the GLOBAL SMS server IP/port on its own
  egress controls.
* Do not confuse the provider's outbound destination port with the GLOBAL SMS
  server's listening port: in Server Mode they are the **same** port, and it is
  opened **inbound** on the GLOBAL SMS side.
* GLOBAL SMS can also restrict, per connection, which peer IP addresses may bind
  (`allowed_ips`; empty means any). The provider should send its source IPs so
  they can be added.

### 4.3 Which port should be used?

**There is no single mandatory SMPP port.** Use the port that is actually
assigned:

| Situation | Port to use |
|---|---|
| GLOBAL SMS is the SMPP **client** | The exact port assigned by the provider. Common examples are **2775**, **3550** or **5016** — these are conventions only. **Never assume 2775 is correct; confirm it.** |
| GLOBAL SMS is the SMPP **server** | The listening port configured by the administrator and agreed with the provider. It must not clash with the web panel port or any other service. |

Rules of thumb:

* Choose a **non-privileged** port (above 1024) so the service does not run as
  root.
* Do not pick a port merely because it is free — check the service configuration,
  the firewall rules and the provider's requirement first.
* Never expose an administrative interface, a database or an unrelated service to
  the public internet on the same port.
* Where the deployment and the provider both support it, secure the transport
  (SMPP over TLS, or an IPsec / WireGuard tunnel) rather than sending SMPP in
  clear text across the internet.

### 4.4 SMPP bind and connection parameters

Settings supported by the GLOBAL SMS SMPP implementation:

| Setting | Required / optional | Notes |
|---|---|---|
| **Mode**: Client or Server | **Required** | Agreed before configuration. |
| **Host** (Client Mode) | **Required** in Client Mode | Provider's SMPP server hostname or IP. |
| **Port** (Client Mode) | **Required** in Client Mode | Provider's assigned port. Default in the form is **2775** — replace it with the assigned value. |
| **Listening port** (Server Mode) | **Required** in Server Mode | 1–65535; must not equal the web panel port. |
| **System ID** | **Required** | SMPP `system_id`. |
| **Password** | **Required** | SMPP `password`. Stored in the database; never returned to the browser. |
| **Bind type** | Optional (default `transceiver`) | `bind_transceiver`, `bind_receiver` (inbound only) or `bind_transmitter` (outbound only). |
| **System type** | Optional | Passed through as `system_type` if the provider requires it. |
| **Address range** | Optional | Passed through as `address_range` if the provider requires it. |
| **Allowed IPs** | Optional | Space / comma / semicolon separated. Empty = allow any peer. Applies to Server Mode binds (and is available per connection). |
| **TLS** | Optional | Connection setting for SMPP over TLS (`ssmpp://`). Certificate and trust configuration depend on the deployment — agree and verify it with the administrator. |
| **enquire_link interval** | Optional (default 30 s) | Keep-alive. If a response is not received the session is treated as dead and a reconnect is forced. |
| **Connect timeout** | Optional (default 15 000 ms) | Applies to the TCP connect and to the bind response. |
| **Reconnect base interval** | Optional (default 10 s) | Client Mode. |
| **Reconnect maximum interval** | Optional (default 300 s) | Client Mode. Reconnect uses exponential backoff with jitter, capped at this value. |
| **Default source address** | Optional | Used for outbound `submit_sm` when no source is supplied. |
| **Connection active on/off** | Operational | A connection only binds when it is switched on. |
| SMPP interface version | *Not configurable* | Handled by the SMPP library; agree the version with the administrator if your platform requires a specific one. |
| TON / NPI settings | *Not configurable* | Handled by the SMPP library defaults. |
| Data coding / character encoding | *Not configurable* | Handled by the SMPP library defaults. |
| Throughput (throttle) limits | *Not configurable* in the current version | Agree an acceptable rate with the administrator; it is not enforced by the GLOBAL SMS connection settings. |
| Message window / queue size | *Not configurable* | — |

### 4.5 Message handling

* **Inbound messages** are validated and written into the SMS records, then
  acknowledged, so an SMS is not lost if the session drops immediately afterwards.
* **De-duplication is supported and applied automatically.** Each inbound message
  is keyed: if the PDU carries a message id it is used, otherwise a fingerprint of
  source + destination + text + a 10-second time bucket is used. A redelivered
  message is acknowledged but **not** recorded twice.
* **Multipart (concatenated) SMS** are reassembled before they are stored, so a
  long message is recorded as one row.
* **Delivery receipts** are acknowledged and logged, but are **not** stored as
  inbound SMS.
* **Outbound `submit_sm`** is supported (queued first, so nothing is lost while the
  link is down) unless the connection is bound as `receiver` only.
* **Connection and message events** (bind, unbind, reconnect, delivery, error) are
  written to the SMPP activity log, which the administrator can review and filter.

### 4.6 VPS firewall requirements

| Connection mode | Direction from the GLOBAL SMS VPS | Required network configuration |
|---|---|---|
| **SMPP Client Mode** | Outbound TCP to the provider | Allow **outbound** traffic to the provider's assigned host and port. Ask the provider to allow the VPS public source IP if their server filters by source. |
| **SMPP Server Mode** | Inbound TCP from the provider | Open the configured SMPP listening port in the VPS firewall **and** the hosting provider's cloud firewall. Restrict source IPs to the provider's range where feasible. |
| **HTTP Incoming Callback** | Inbound HTTP/HTTPS request | Make the callback endpoint reachable on the correct external port, normally **HTTPS 443**. Apply the application-level IP allowlist as well. |
| **API Provider Sync** | Outbound HTTPS request from GLOBAL SMS | Allow **outbound** HTTPS (443) to the provider's API host. No inbound rule is needed for this method. |

These are **different layers** and each may need its own configuration:

1. **Hosting provider cloud firewall / security group** — outside the VPS.
2. **VPS / operating-system firewall** (ufw, iptables, nftables) — on the VPS.
3. **Reverse proxy or load balancer rules** — in front of the application (HTTP).
4. **Application allowlist** — the IP list configured inside GLOBAL SMS.

**A port is not open because it is configured in the application, and an
application allowlist entry does not open a firewall port.** Verify each layer
independently.

### 4.7 SMPP testing procedure

Work through this checklist with the GLOBAL SMS administrator. Do **not** send real
production traffic or change production provider settings during a test without
authorisation.

1. [ ] Confirm which side is the SMPP client and which side listens as the server.
2. [ ] Exchange the public IP / hostname, the assigned port, and the supported
       protocol settings (version, bind type, encoding, throughput).
3. [ ] Configure the firewall rules on both sides (see §4.6).
4. [ ] Exchange the system ID and password through a secure channel and confirm
       receipt.
5. [ ] Establish the SMPP bind.
6. [ ] Verify the bind is accepted (status becomes *bound*, or *listening* and then
       *bound* in Server Mode).
7. [ ] Send a small number of controlled test messages through the agreed test
       environment.
8. [ ] Verify with the administrator that each message was received and recorded
       in the correct SMS report.
9. [ ] Confirm duplicate deliveries are not counted twice (resend one test message
       and confirm only one record exists).
10. [ ] Interrupt the connection deliberately and verify the automatic reconnect
        (Client Mode) or that the provider rebinds successfully (Server Mode).
11. [ ] Review the SMPP activity log together and resolve any authentication,
        timeout, firewall or protocol errors.
12. [ ] Record the agreed settings and sign off before production traffic.

A TCP reachability probe is available in the GLOBAL SMS panel (**Test Connection**
on the connection) and reports whether the host/port answers at all, which
separates "wrong address or firewall" from "wrong credentials".

---

## 5. API Provider Connection / Sync

### 5.1 What it is

GLOBAL SMS runs a background sync service that **polls the provider's HTTP API**
on a schedule and imports new inbound records. **GLOBAL SMS initiates the
requests; the provider does not call GLOBAL SMS for this method.** It is an
outbound pull, not a webhook.

Flow:

```
GLOBAL SMS sync service  --HTTPS GET/POST-->  Provider API  --JSON-->  GLOBAL SMS database
```

### 5.2 What the provider must provide

| Item | Detail |
|---|---|
| API base URL | The full endpoint, e.g. `https://api.provider.example/messages` |
| HTTP method | `GET` (default) or `POST` |
| Authentication scheme | One of: **bearer** token (`Authorization: Bearer <token>`), **header** (`X-API-Key` or another agreed header name), **query** parameter (`token`, `api_key` or another agreed name), or **none** |
| API credential | The token / key itself, exchanged through a secure channel |
| Date-window parameters | The parameter names that carry the *from* and *to* timestamps, if the API uses a window (for example `dt1` / `dt2`) |
| Date format | `YYYY-MM-DD HH:MM:SS` (default), ISO-8601, or Unix epoch in seconds/milliseconds |
| Record-count parameter | The parameter that limits how many records are returned, if any (for example `records`, `limit`) |
| Response format | JSON (array, or an object with the array under a known key such as `data`), or a delimited / HTML-table response |
| Field mapping | Which JSON field holds the **unique reference id**, the **recipient number**, the **sender/CLI**, the **message text** and the **timestamp** |
| Rate limits | Any quota, and the behaviour when it is exceeded |

### 5.3 Configuration on the GLOBAL SMS side

| Setting | Notes |
|---|---|
| Provider name | Free label, must be unique. |
| Base URL | Required. |
| Method | `GET` or `POST`. |
| Auth type | `bearer` / `header` / `query` / `none`. |
| Token / API key | Stored in the database. The panel always returns it masked (`********`); it is never sent to the browser. |
| Auth header name | Used when auth type is `header` (default `X-API-Key`). |
| Auth query name | Used when auth type is `query` (default `api_key`). |
| From / to parameters | Date-window parameter names. |
| Date format | `sql` / `iso` / `epoch` / `epoch_ms`. |
| Records parameter and limit | How many records to request per cycle. |
| Records path | Where the array sits in the response, e.g. `data` or `data.messages`. |
| Field map | `ref`, `number`, `cli`, `message`, `date` → the provider's field names. |
| **Sync interval** | **Per provider**, in seconds. Minimum 5; commonly 10–15 seconds. |
| **Overlap** | Safety rewind of the cursor (default 30 seconds) so records written just before the previous cursor are not missed. |
| Active on/off | A provider only syncs when it is switched on. |

### 5.4 How the data is handled

* **Incremental:** each provider keeps its own cursor (`last_sync_at`) and asks only
  for records newer than that, minus the overlap window.
* **Validated:** each record must carry a recipient number; records without one are
  skipped.
* **De-duplicated:** the provider's unique reference id is stored in a dedup ledger
  with a unique index. Because of that, the overlap window can never create
  duplicates, and a record is never imported twice.
* **Stored:** the record is written through the same ingestion path as the HTTP
  callback, so allocation, rate cards, OTP extraction, payout and daily limits
  behave identically.
* **Non-blocking:** the sync runs on its own timer and in its own transaction; it
  never touches the panel's request path.
* **Provider-reported payout**, if the API returns one, is not used to override the
  GLOBAL SMS rate card except where the provider explicitly reports zero.

### 5.5 Errors, timeouts, rate limits and retries

* **Request timeout:** the HTTP request is aborted after the configured timeout
  (default 20 seconds).
* **Failure handling:** a failed cycle is logged with the HTTP status and a
  sanitised error body, the provider's `consecutive_failures` counter is
  incremented, and **the cursor is not advanced** — so no records are skipped.
* **Backoff:** after repeated failures the scheduler waits longer between attempts
  (exponential backoff, capped at 5 minutes), so a broken API is not hammered.
* **Provider-side error bodies:** an HTTP 200 response containing
  `status = error` is treated as a failure, not as "zero new messages", so a wrong
  API key cannot fail silently.
* **Rate limiting:** there is no automatic retry-within-a-cycle. The next attempt
  happens on the next scheduled tick. If your API enforces a quota, tell the
  administrator so the sync interval and record limit can be set inside it.
* **Manual controls:** the administrator can run one cycle immediately, run a full
  re-sync that ignores the cursor, or reset the dedup ledger and cursor.
* **Logs:** every cycle is logged with fetched / new / duplicate / failed counts,
  duration and error text.

> The older "API Integrations" polling module has been removed from this version
> and its endpoints answer `410 Gone`. Only the provider-sync service described in
> this section is used for API pull.

### 5.6 How the provider can test

1. Provide a test or sandbox API endpoint, or a live endpoint with a narrow
   date window and a low record limit.
2. Give the administrator a valid test credential and one known-good sample
   response.
3. The administrator saves the configuration and presses **Test Connection**,
   which fetches the last hour **without storing anything** and shows the number of
   records returned plus one sample.
4. The administrator runs one sync cycle and confirms the fetched / new / duplicate
   counts.
5. Send one new test message into your platform and confirm it appears in the GLOBAL SMS report within one sync interval.
6. Re-run the same window and confirm the duplicate count rises while the new
   count stays at zero.

---

## 6. API and integration security

* **Never put credentials in this document, in a ticket, or in a chat message.**
  System IDs, passwords and API keys are exchanged separately through an agreed
  secure channel.
* **Never log secrets.** GLOBAL SMS redacts `Bearer` tokens and `token`, `key`,
  `api_key`, `password`, `secret`, `auth` and `access_token` values from stored
  provider error text, and returns API tokens to the panel only in masked form.
* **Prefer HTTPS.** Use TLS for the callback URL and for any provider API. Plain
  HTTP is acceptable only for a short, controlled test.
* **Source-IP allowlisting** is the access control for HTTP incoming (§2.8) and is
  available per SMPP connection (§4.4). It is an application-level control and does
  not replace the VPS firewall.
* **Least privilege.** The provider API credential only needs read access to the
  message records in scope.
* **Rotate credentials** on a schedule and immediately after any suspected
  exposure or staff change.
* **Panel access** to all integration configuration requires an authenticated
  administrator; the HTTP integration screen additionally requires a second
  security password to view or change.

---

## 7. Troubleshooting

| Symptom | Likely causes | What to check |
|---|---|---|
| **Connection timeout** (HTTP or SMPP) | Firewall dropping packets; wrong host; service not running; routing problem | From the GLOBAL SMS VPS: `curl -v https://host/api/...` or `nc -vz host port`. Check the cloud firewall, the VPS firewall and the service status. |
| **Connection refused** | Nothing is listening on the port; wrong port; service stopped | `nc -vz host port` from the client side; confirm the listening service is up and bound to the right interface. |
| **Firewall blocking traffic** | Rule missing on the cloud firewall or the VPS firewall; rule added in the wrong direction | Confirm the direction (inbound vs outbound) for the mode in §4.6; check both firewall layers; check any reverse proxy. |
| **Incorrect hostname or IP** | Typo; DNS not propagated; the IP changed | Resolve the name from both sides; compare with the value in the connection settings. |
| **Incorrect TCP port** | The common SMPP port 2775 was assumed rather than confirmed | Confirm the exact assigned port with the other side; do not reuse a port that is merely free. |
| **Provider IP allowlisting failure** | The source IP changed; NAT hides the real IP; a proxy is not forwarding the client IP | Compare the IP in the `403 IP not allowed` response with the allowlist; confirm the reverse proxy forwards the real client IP. |
| **Incorrect system ID or password** (SMPP) | Typo; whitespace; credential mismatch; wrong case | Re-send the credential through the secure channel; check the SMPP activity log for `bind rejected: invalid system_id` or `invalid password`. |
| **SMPP bind failure** | Wrong bind type; already bound; account disabled; unsupported `system_type` | Read the specific `bind rejected: …` message in the SMPP activity log; confirm the bind type with the provider. |
| **Unsupported SMPP settings** | Version, encoding, TON/NPI or throughput mismatch | Agree the settings in §4.4 with the administrator; parameters marked *Not configurable* cannot be changed in this version. |
| **HTTP authentication or payload validation failure** | Missing or misspelled recipient field; wrong content type; body not sent as declared | Confirm `Content-Type` matches the body; confirm the recipient field name is one of those in §2.3; check for `400 number/to field required`. |
| **API authentication failure** (sync) | Wrong token; wrong auth type; token sent in the wrong place; expired credential | Check `last_error` in the API Providers panel; test the credential against the API directly with `curl`. |
| **Rate limiting** | Too many requests, or a retry storm after an outage | Check for `429` answers; slow down and add exponential backoff; agree a quota with the administrator. |
| **Missing SMS records** | Number not provisioned or not allocated; timestamp missing so the message landed in the wrong day; cursor advanced past the record | Check for `404 Number not found/allocated`; always send the original timestamp; for pull, run a full re-sync. |
| **Duplicated SMS records** | No unique message id supplied, so retries cannot be recognised | Always send a stable unique `id` / `message_id`; for SMPP, confirm de-duplication is active in the activity log. |
| **Connection disconnects / reconnect failures** | Idle timeout; network instability; the peer unbound; listen port already in use | For Client Mode, check the reconnect interval and the activity log; for Server Mode, check for "port already in use" and confirm only one process holds the port. |

> Not every diagnostic described above exists as a button inside the panel. Where
> a check requires shell access, it is performed by the GLOBAL SMS administrator or
> the provider's own operations team on their side of the connection.

---

## 8. Provider Handover Checklist

Copy this checklist into your own ticket system. **Do not fill in passwords,
system IDs, API keys or tokens here** — exchange them separately through the agreed
secure channel.

**Provider**

* Provider name: `______________________________`
* Technical contact (name / e-mail / phone / escalation): `______________________`
* Working hours and timezone: `______________________________`

**Integration method** (tick all that apply)

* [ ] HTTP Incoming Callback
* [ ] SMPP — Client Mode (GLOBAL SMS connects to the provider)
* [ ] SMPP — Server Mode (the provider connects to GLOBAL SMS)
* [ ] API Provider Sync (GLOBAL SMS pulls from the provider)

**HTTP Incoming**

* Callback URL: `______________________________`
* Method: `POST` ……… other: `____________`
* Content type: `______________________________`
* Source IP addresses: `______________________________`
* Unique message id field: `______________________________`
* Timestamp field and format: `______________________________`

**SMPP**

* Mode: Client / Server ……… GLOBAL SMS is the: `____________________`
* GLOBAL SMS public IP / hostname: `______________________________`
* Provider SMPP host: `______________________________`
* Port: `______________________________` ……… Direction: inbound / outbound
* Bind type: `transceiver` / `receiver` / `transmitter`
* SMPP version: `______________________________`
* Encoding / data coding: `______________________________`
* TON / NPI: `______________________________`
* Throughput limit: `______________________________`
* TLS required: yes / no ……… agreed method: `____________________`
* IP allowlisting required: yes / no ……… IPs: `____________________`

**API Provider Sync**

* Base URL: `______________________________`
* Method: `GET` / `POST` ……… Auth type: `bearer` / `header` / `query` / `none`
* Auth header or query parameter name: `______________________________`
* Date-window parameters and format: `______________________________`
* Record-count parameter: `______________________________`
* Field map — ref / number / cli / message / date: `____________________`
* Sync interval: `______________________________`
* Rate limit / quota: `______________________________`

**Test environment**

* Test endpoint or sandbox available: yes / no ……… details: `____________________`
* Test numbers in scope: `______________________________`
* Test window agreed (dates / times): `______________________________`

**Sign-off**

* Connectivity verified: [ ] Bind or first callback verified: [ ]
* Test messages recorded: [ ] Duplicate handling verified: [ ]
* Reconnect behaviour verified: [ ]
* Go-live date: `______________________________`
* Unresolved issues: `______________________________`

---

*End of document. GLOBAL SMS — Provider Integration Guide. Verify every
host, port, URL and credential with the GLOBAL SMS administrator before use; the
values in this guide are placeholders.*
