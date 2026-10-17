<!--
Template: the {{...}} placeholders are replaced at build time (prerender) from environment variables.
Variables used: PUBLIC_LGPD_CONTROLLER, PUBLIC_LGPD_CONTACT_EMAIL, PUBLIC_LGPD_CNPJ,
PUBLIC_LGPD_ADDRESS, PUBLIC_LGPD_DPO_NAME, PUBLIC_POLICY_EFFECTIVE_DATE, PUBLIC_ORIGIN.
Required in the production build: PUBLIC_LGPD_CONTROLLER, PUBLIC_LGPD_CONTACT_EMAIL and
PUBLIC_POLICY_EFFECTIVE_DATE. Empty CNPJ, address or DPO name produce a build warning and the
sentence containing them is left out.
The version below follows POLICY_VERSION (web/src/lib/content/legal/version.ts); a test checks it.
Do not put real values in this file: the repository is public.
-->

# open-auri Privacy Policy

**Version:** 2026-10-17 · **Effective date:** {{PUBLIC_POLICY_EFFECTIVE_DATE}} · **Address:** {{PUBLIC_ORIGIN}}/privacidade

This is an English translation provided for convenience. The authoritative version is the Brazilian Portuguese text (`politica-de-privacidade.md`). **If the two versions differ, the pt-BR version prevails.**

> **30-second summary**
>
> - You can use open-auri without an account. In that case your curves, your history and your settings stay in your browser. The audio file you load **never** leaves your device.
> - An account is optional and is used for the social features. We store your email, a hash of your password (never the password itself), your public nickname and whatever you choose to publish.
> - Publicly, you appear only by your nickname. The public library and the public activity profile are optional and off by default.
> - Brazilian law (the Marco Civil da Internet) requires us to keep access records: IP address, date and time and, if you are signed in, your account. We keep them for 6 months, encrypted, and hand them over to third parties only under a court order. We use the IP for nothing else: no profiling, no analytics, no marketing.
> - Outside those records, your IP is not stored: rate limiting uses a hash of the IP with a daily salt, deleted within 48 hours.
> - We use no analytics or advertising cookies. We do not sell data. We send no marketing email.
> - You can export your data, delete your activity and close your account directly in the app, or write to **{{PUBLIC_LGPD_CONTACT_EMAIL}}**.

---

## 1. Who we are and how to reach us

The controller of the personal data processed by open-auri ({{PUBLIC_ORIGIN}}) is:

- **{{PUBLIC_LGPD_CONTROLLER}}**
- CNPJ (Brazilian company registration number): {{PUBLIC_LGPD_CNPJ}}
- Address: {{PUBLIC_LGPD_ADDRESS}}
- Privacy and data protection officer (encarregado) channel: **{{PUBLIC_LGPD_CONTACT_EMAIL}}**
- Data protection officer: {{PUBLIC_LGPD_DPO_NAME}}

We are a small-size processing agent under ANPD Resolution CD/ANPD No. 2/2022. Even where appointing a data protection officer is not mandatory, we keep the communication channel above (art. 11 of the Resolution) to receive requests, questions and complaints about your data.

## 2. Using it without an account: everything stays in your browser

Without an account, open-auri runs entirely in your browser. The data below is stored on your own device (localStorage, sessionStorage and IndexedDB) and **is not sent to us**:

| What | Why |
|---|---|
| Language (`oa.lang` and the `oa_lang` cookie) | Show the app in your chosen language |
| Current curve (`oa.current`) | Pick up where you left off |
| Write journal (`oa.journal`, up to 500 entries) | Record what was written to the cable, including interrupted writes |
| Write counters (`oa.flash.*`) | Limit the number of writes per day and per session, to protect the cable's memory |
| Meter reference (`oa.meter.ref`) | Remember your reference setting |
| Policy version already seen (`oa.policy.seen`) | Show the policy change notice only when the policy changes |
| Local library (IndexedDB `library`) | Keep curves and favorites without an account |
| Offline outbox (IndexedDB `outbox`) | Hold social actions made offline until the connection returns (account only) |
| Audio file you load (IndexedDB `audio`) | Play the preview with the curve applied |

**The audio file (MP3 or other) is never uploaded to our servers.** All sound processing and metering happens on your device.

Measurement files you import (CSV or TXT) are also read in the browser.

To erase all of this, use **Docs > "Dados neste navegador"** ("Data in this browser"). You can also clear the site data in your browser settings.

**Legal basis:** since this data never reaches us, the controller does not process it. It remains under your control. Even without an account, the requests your browser makes to our server generate access records (section 11).

## 3. Optional account

An account is needed only to publish, favorite, sync your library and use the social features. Every social action requires a verified email.

Account creation may be temporarily unavailable while the domain used for transactional emails has not been verified. The site works normally without an account.

| Data | Why |
|---|---|
| Email | Sign in, verify the account, recover the password and receive security notices. Your email is never shown publicly |
| Password hash | Check your password without storing it. We never store the password itself |
| Public nickname ("apelido", unique) | Identify you publicly. It is the only name shown: it appears in rankings, the feed, curve credits, shares and at `{{PUBLIC_ORIGIN}}/u/[nickname]`. It has 3 to 24 characters, can be changed every 30 days, and the old nickname stays reserved for 90 days, redirecting to the new one |
| Bio (optional, up to 280 characters) | Present your profile, if you want |
| Session records | Keep you signed in and let you see and end sessions. We store the browser and operating system (reduced from the user-agent) and the creation, last-activity and expiry times. The session does not store your IP: the authentication system runs with IP tracking turned off |
| Email verification and password-reset tokens | Confirm the email is yours and let you change the password safely |
| Account preferences | Language, activity visibility (private or public, private by default) and public library (on or off, off by default) |
| Policy acknowledgements (version and date) | Record that you saw the current version of this policy and of the terms, so the change notice is not repeated |

When you sign in, the app merges the browser's local library into your account library without duplicating curves. From then on those curves are also stored on the server.

**Legal basis:** performance of the service agreement you accept when creating the account (LGPD, art. 7, V). Public visibility preferences rely on your consent (art. 7, I), which you can withdraw at any time in the settings.

## 4. What you publish

When you publish, we store and display:

- curves (the equalization numbers, name, description and recipe);
- versions (append-only: older versions remain in the history) and forks;
- curve packs;
- the licence chosen for each curve: **CC0-1.0** or **CC-BY-4.0**;
- shares (links with an identifier and, if you specify it, the channel).

Each published curve shows your nickname as credit. You choose whether a curve is private, unlisted or public.

**The licence of a published version is irrevocable.** You can withdraw the curve from the site, but anyone who already obtained a copy under the CC licence may keep using it under its terms.

**Legal basis:** performance of contract (art. 7, V).

## 5. Activity: tried, installed, favorited

With an account, we record three kinds of activity on community curves:

- **tried ("experimentou"):** you listened to a preview of the curve for at least 10 seconds;
- **installed ("instalou"):** you successfully wrote the curve to the cable (simulated writes do not count);
- **favorited ("favoritou"):** you marked the curve as a favorite.

We store the curve, the kind of activity, the first and last time and how many times it happened. Actions made offline are sent when the connection returns and are accepted only if they are at most 7 days old.

**What is public:**

- the **counts** (number of distinct people with verified accounts) are public;
- your nickname appears in an author's audience list only if you choose a **public activity profile**. The default is **private**. With a private profile you are only included in the count "N people with a private profile".

You can see and delete your own activity at any time in your account.

**Legal basis:** performance of contract for recording and counts (art. 7, V); consent for being listed by name in the public profile (art. 7, I).

## 6. Public profile, public library, rankings and shares

**Public profile.** Every account holder has the page `{{PUBLIC_ORIGIN}}/u/[nickname]`. With the public library off, it shows only the nickname and aggregate counts.

**Public library.** It is optional and **off** by default. When on, your page shows the public curves you created and your public packs, and also your favorites if your activity profile is public. You can turn it on and off at any time. In any case, each curve you published as public stays reachable at its own address, credited to your nickname. (Legal basis: consent, art. 7, I.)

**Rankings.** We show the most favorited and most installed curves over 7 days, 30 days and all time. Rankings use only counts of distinct verified accounts and only public curves. They do not show who favorited or installed. (Legal basis: legitimate interest in highlighting relevant curves for the community, art. 7, IX.)

**Shares.** When you share a link, we count opens, previews, installs and favorites coming from it. Opens by people without an account are only counted per day, with no identity at all. Actions by people with an account are associated with the share to produce these numbers. (Legal basis: performance of contract, art. 7, V.)

## 7. Reports and moderation

People with a verified account can report content. We store the target, the reason, an optional note, who reported, the date and the outcome.

A curve is hidden automatically when 3 different verified accounts, each at least 3 days old, report it. This hiding is reviewed by moderators, who can restore the content. If you are affected, you can request a review of this automated decision (art. 20) at {{PUBLIC_LGPD_CONTACT_EMAIL}}.

Moderation actions (hide, restore, withdraw, ban, mark as curated) are kept in an audit log with the actor, action, target, detail and date.

**Legal basis:** legitimate interest in keeping the service safe and enforcing our terms (art. 7, IX) and, for the audit log, also the regular exercise of rights in legal proceedings (art. 7, VI).

## 8. Anonymous blind test (S6)

In the blind test you may, if you want, submit your preferences to build the "Community prefers" result.

- Submission only happens with your **explicit consent**, requested at that moment with its own text. Because hearing preferences may relate to health, we treat this data as sensitive.
- **The batch has no account and no IP.** It contains only the A/B pairs compared, the choices, whether loudness was matched, the day of submission and the consent text version.
- Like every request to the server, the submission generates an access record (section 11) with IP, date, time and the request type. That record does not contain the batch content or the receipt, and the batch is stored with a random delay to make cross-referencing harder.
- A **random receipt** is kept only on your device. The server keeps only a hash of it. With the receipt you can withdraw consent and delete your batch.
- Since we do not know who you are, **without the receipt we cannot find your batch**.
- **Maximum period of 24 months:** even without withdrawal, the batch and its pairs are deleted automatically once they are 24 months past the submission day.
- Aggregated results (Bradley–Terry) are anonymous and published.

Submission is protected by Turnstile and by rate limiting using a hash of the IP. That hash is not stored in the batch.

**Legal basis:** specific and highlighted consent (art. 11, I).

## 9. Blind trade (S7)

In a blind trade, two people with accounts exchange curves without knowing whose they are. We store your participation, the curve and version offered, the pairing, the score you gave and the dates. Curves and scores are revealed to both after both have rated. An unpaired trade expires after 72 hours. We show average scores per curve.

**Legal basis:** performance of contract (art. 7, V).

## 10. Security: bot and abuse protection

- **Cloudflare Turnstile.** We use Turnstile to tell people from bots at sign-up, sign-in, password recovery, email change, reports and blind-test submission. Turnstile is operated by Cloudflare, which processes technical browser data under the [Turnstile Privacy Addendum](https://www.cloudflare.com/turnstile-privacy-policy/). The widget runs in your browser and talks directly to Cloudflare. When our server checks the result, we do not send your IP.
- **Rate limiting.** To prevent abuse, we count requests per route using an HMAC of your IP with a secret key and a salt that changes every day. The old salt is deleted on rotation and the hashes are deleted within 48 hours. This hash is used only for rate limiting.
- **No other IP storage.** Outside the access records (section 11), we do not store your IP anywhere: not in the account, not in the session, not in operational logs. The authentication system runs with IP tracking turned off.
- **Platform logs.** Cloudflare, as a processor, keeps technical platform logs with its own retention, set by Cloudflare. Our operational application logs contain no personal data (only request identifier, route, response time, status and error code).

**Legal basis:** legitimate interest in protecting the service and accounts against fraud and abuse (art. 7, IX).

## 11. Access records (Marco Civil da Internet)

Brazilian Law No. 12,965/2014 (Marco Civil da Internet) requires application providers to keep records of access to internet applications (art. 5, VIII, and art. 15). For that reason, for every dynamic request handled by the application, we keep:

- IP address and, when available, the source port (needed to tell apart connections that share the same IP);
- date and time, with time zone;
- account identifier, if you are signed in;
- request type (route group, for example "account", "curves" or "blind test", without the address parameters) and the response status.

Static files served directly by the CDN (pre-rendered pages, scripts, fonts, images) do not go through the application and are not included in these records.

How we keep and use them:

- **period:** 6 months; after that, the records are deleted automatically. Retention is extended only if an authority requests it under art. 15, §2 of the Marco Civil;
- **security:** encrypted at rest (AES-GCM) in hourly batches, with the key kept outside the database, in a controlled and secure environment, with restricted access. They are kept out of backups and of the public dump, so that deletion after 6 months is real;
- **disclosure to third parties:** only under a court order (art. 10 and art. 15, §3 of the Marco Civil);
- **audit:** every access to these records is noted in the audit log;
- **single purpose:** complying with the law. We do not use the IP or these records for profiling, usage analytics or marketing.

**Legal basis:** compliance with a legal obligation (LGPD, art. 7, II).

## 12. Emails

We send only transactional emails, through Resend (processor), which receives your email address and the message content:

- email verification;
- password reset;
- email change (confirmation to the new address and notice to the old address);
- password changed notice;
- account deletion confirmation and account closed notice.

**No marketing and no tracking pixels.** We keep no copy of the emails sent. If an email bounces or is marked as spam, we keep a hash of the address so we do not keep sending to it.

**Legal basis:** performance of contract (art. 7, V); for the suppression list, legitimate interest (art. 7, IX).

## 13. Cookies and local storage

We use **only essential cookies**:

| Cookie | Why | Duration |
|---|---|---|
| Session cookie (`Secure`, `HttpOnly`, `SameSite=Lax`) | Keep you signed in | Until you sign out, revoke or the session expires |
| `oa_lang` | Remember the language | Until you delete it |

We use no analytics, advertising or third-party tracking cookies. That is why we show no consent banner: this policy is how we inform you. Cloudflare may use strictly necessary security mechanisms under its own policy.

Browser local storage is described in section 2. The app also keeps a copy of itself (service worker) to work offline. That copy contains no personal data.

## 14. Who processes data for us and international transfer

| Processor | What it does |
|---|---|
| **Cloudflare, Inc.** | Hosting and processing (Workers, D1 database, R2 storage, KV and queues), encrypted access records, rate limiting, Turnstile, platform logs and, if enabled, an optional access-control layer for administration (Cloudflare Access) |
| **Resend** | Sending transactional emails and bounce and complaint notices |

These providers process data in the United States and other countries where they operate. This **international transfer** (LGPD, art. 33) relies on the standard contractual clauses approved by Resolution CD/ANPD No. 19/2024 and on the providers' data processing agreements (DPAs).

We do not sell or rent data. We only share data with these processors, for the purposes in this policy, or with authorities when the law or a court order requires it.

## 15. How long we keep data

| Data | Period |
|---|---|
| Data in the browser (section 2) | Until you delete it. The journal keeps the latest 500 entries |
| Account: email, password hash, nickname, bio, preferences and policy acknowledgements | Until the account is closed |
| Old nickname, after a change | Reserved for 90 days, redirecting to the new one; then released |
| Sessions | Until they expire, you sign out or revoke them |
| Verification and password-reset tokens | Until used or expired |
| Curves, versions, forks, packs and shares | Until you delete or withdraw them, or until the account is closed (see section 17) |
| Activity and favorites | Until you delete them or close the account |
| Blind trades (S7) | Unpaired: expire after 72 hours. Completed: until the account is closed. Per-curve averages identify no one |
| Anonymous blind test (S6) | Until you withdraw consent with the receipt, for at most 24 months: after that, the batch and its pairs are deleted automatically. Aggregated results are anonymous, stay published and come to reflect the batches of the last 24 months |
| Reports | While your account exists. On closure, the link to you is deleted |
| Requests sent to {{PUBLIC_LGPD_CONTACT_EMAIL}} and our replies | 5 years after the reply, to prove we handled the request |
| Audit log of moderation and of accesses to the access records | 5 years. This matches the 5-year limitation period for damages claims under the Brazilian Consumer Protection Code (art. 27) and allows us to defend moderation decisions in any proceedings |
| Access records (IP, port, date and time with time zone, account, request type) | 6 months, then deleted automatically (Marco Civil da Internet, art. 15), unless an authority requests longer retention (art. 15, §2) |
| IP hash for rate limiting | Up to 48 hours. The daily salt is deleted on rotation |
| Email hash in the suppression list | Up to 12 months after the last bounce or complaint |
| Cloudflare platform logs | According to the retention set by Cloudflare |
| Backups | Up to 12 weeks. Deleted data may remain in backups for up to 12 weeks, unused, until overwritten |
| Weekly public dump | Published only at `{{PUBLIC_ORIGIN}}/dados/dump/latest.json.gz` and as dated editions at `{{PUBLIC_ORIGIN}}/dados/dump/YYYY-MM-DD.json.gz`. The storage holding the files is not public. Each new dump reflects deletions and anonymizations. Contains only public data: public curves, versions, licences, the credited nickname and aggregate numbers. It contains no email, individual activity, hashes, IP addresses or other account data |

## 16. Your rights and how to exercise them

Under the LGPD (art. 18), you may request:

- confirmation that we process your data, and access to it;
- correction of incomplete, inaccurate or outdated data;
- anonymization, blocking or deletion of unnecessary or excessive data, or data processed unlawfully;
- portability;
- deletion of data processed based on your consent;
- information about whom we share your data with;
- information about the possibility of not consenting and its consequences;
- withdrawal of consent;
- objection to processing based on legitimate interest, where the law is not being complied with;
- review of decisions made solely by automated means (art. 20).

**In the app, without writing to us:**

- **correct:** edit nickname (one change every 30 days), bio and preferences in your profile, and change email and password at `{{PUBLIC_ORIGIN}}/conta`;
- **access and take your data:** use "Exportar meus dados" ("Export my data") to download a JSON file with account, profile, curves, versions, favorites, activity and shares;
- **delete activity:** see and delete your activity in your account;
- **withdraw consent:** make your activity private, turn off the public library or use the blind-test receipt;
- **close the account:** see section 17;
- **data in the browser:** erase it in Docs > "Dados neste navegador".

**By email:** write to **{{PUBLIC_LGPD_CONTACT_EMAIL}}**. We may ask you to confirm the account is yours before acting. We reply in simplified form as soon as possible and, when you ask for a full statement, **within 15 days** (art. 19, II).

Access records (section 11) are kept under a legal obligation. For that reason they cannot be deleted before the 6 months are over (LGPD, art. 16, I). Your requests to access your own records are handled through this channel, with identity verification. To third parties, they are disclosed only under a court order.

If you are not satisfied, you may petition the **Brazilian National Data Protection Authority (ANPD)**.

## 17. Closing your account

You close the account at `{{PUBLIC_ORIGIN}}/conta`, with your password and an email confirmation. Before that, you choose what to do with the public curves you published under a CC licence:

- **keep them anonymized:** the curves remain on the site credited to "autor removido" ("author removed"), with no link to you; or
- **delete everything:** the curves are withdrawn from the site.

In either case, **private content is always deleted**, together with your email, password hash, profile, nickname, sessions, tokens, favorites, activity and policy acknowledgements.

Access records linked to the account remain stored until they reach 6 months, as the Marco Civil da Internet requires, and are then deleted automatically. In backups, deleted data disappears within 12 weeks.

Remember that the CC licence of published versions is irrevocable: copies and forks other people already made, and public dumps already distributed, remain valid and cannot be recalled.

## 18. Minors

Accounts are for people aged **18 or over**. Anonymous use, which stays entirely in the browser, is open to everyone.

## 19. How we protect data

- always-encrypted connection (HTTPS with HSTS) and security headers (CSP with nonce, framing protection and others);
- password stored only as a salted hash, with a 10-character minimum and strength check;
- `Secure`, `HttpOnly` and `SameSite=Lax` session cookies, origin checks and CSRF protection;
- other sessions ended when the password is reset;
- identical responses whether or not an email is registered, to make account discovery harder;
- Turnstile and rate limiting, with a short-lived IP hash;
- access records encrypted at rest (AES-GCM), with restricted and audited access;
- administration restricted to accounts with the admin role and mandatory two-factor authentication, with a recent re-authentication required for destructive actions and an audit log (Cloudflare Access may be enabled as an optional extra layer);
- operational application logs without personal data;
- minimal collection: audio and the write journal stay on your device;
- weekly backups with limited retention.

No system is completely secure, but we review these measures over time.

## 20. Security incidents

If a security incident occurs that may cause you relevant risk or harm, we will notify the ANPD and the people affected, as required by art. 48 of the LGPD and within the deadline set by ANPD regulations. We will notify account holders by email and through a notice in the app.

## 21. Public measurement data

The app embeds public headphone measurements and targets from the AutoEq project, with source attribution and the MIT licence. This data ships inside the app itself: browsing it makes no request to AutoEq or any third party. It describes equipment, not people, and contains no personal data.

## 22. Changes to this policy

This policy has a version and an effective date. When there is a relevant change, we will publish the new version with the new date and show a notice in the app. With an account, we record the version and the date on which you confirmed the notice. Without an account, that mark stays only in your browser (`oa.policy.seen`). If the change requires new consent, we will ask again.

## 23. Governing law

This policy is governed by Brazilian law, in particular Law No. 13,709/2018 (LGPD) and Law No. 12,965/2014 (Marco Civil da Internet).

---

Este documento não é aconselhamento jurídico e deve ser revisado por um advogado antes da publicação. (Q-LEGAL)
