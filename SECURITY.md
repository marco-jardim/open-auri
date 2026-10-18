# Security policy

open-auri is an open protocol and web app for the 0xCB firmware of the CB5100 chip family. It
writes equalizer curves to a USB DSP cable from the browser (WebHID), so security here covers two
things: the usual web risks (accounts, data, the shared library) and **hardware safety**, meaning
anything that could make the app send bytes to a cable that the safety gate would refuse.

## Supported versions

| Version | Supported |
|---|---|
| `main` and the site at https://open-auri.com | Yes |
| The latest `v1.x` release | Yes |
| Older releases, forks and self-hosted copies | No: please reproduce on `main` first |

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

Report it privately through GitHub:
[**Report a vulnerability**](https://github.com/marco-jardim/open-auri/security/advisories/new)
(Security tab, "Report a vulnerability"). Only the maintainers can see it.

Please include:

- what is affected (page, endpoint, package or file, and the commit or version);
- the steps to reproduce, or a minimal proof of concept;
- the impact you expect (for example account takeover, data exposure, or a write that bypasses
  the gate);
- whether the issue is already public anywhere.

Write in English or Portuguese. Never include real personal data, passwords, session cookies or
tokens, even your own: redact them or use a throwaway test account.

## What to expect

- **Acknowledgement** within 5 business days.
- **First assessment** (accepted, needs more information, or out of scope) within 10 business days.
- **Fix:** critical issues and anything that affects hardware safety are prioritised; we aim to
  release a fix within 30 days of confirming the report and will tell you if it needs longer.
- **Disclosure:** we publish a GitHub Security Advisory once a fix is released and credit you
  there, unless you prefer to stay anonymous. Please keep the details private until then.

This is a volunteer project: there is no bug bounty.

## Scope

In scope:

- **Hardware safety (highest priority).** Any way to send a write to a cable without the safety
  gate, the pre-write checklist and an explicit user gesture; to bypass or weaken the gate's
  limits; to make the core encode bytes the gate did not accept; or to write from more than one tab
  at a time.
- **The web app** (`web/`): authentication, two-factor authentication, sessions, account and admin
  pages, the public API (`/api/v1/**`), the shared library (publishing, versions, forks, shares,
  trades, reports, moderation), CSP and other security headers, the service worker and offline
  storage.
- **The background jobs** (`workers/jobs/`) and the deploy and CI configuration in this
  repository.
- **The core library** (`src/`): codec, gate, envelope parsing and transport.
- Leaks of personal data in logs, exports, public dumps, images or the repository itself.

Out of scope:

- Problems in third-party services (Cloudflare, GitHub, Resend, Simple Analytics, AutoEq) that are
  not caused by how this project uses them: report those to the vendor.
- Missing hardening with no demonstrated impact (for example a header suggestion without an
  attack), clickjacking on pages without sensitive actions, or best-practice findings from
  automated scanners without a proof of concept.
- Volumetric denial of service, spam or social engineering.
- Attacks that need physical access to an unlocked device, a malicious browser extension or a
  compromised operating system.
- The physical behaviour of a cable when someone writes to it with other software.

## Safe harbor

We will not take legal action against good-faith research that follows this policy: test only
against your own accounts and test data, do not access, modify or delete other people's data, do
not degrade the service for others, and stop and report as soon as you find a problem. **Never
test against hardware you do not own**, and never write experimental curves to a cable in daily
use.

## Hardening already in place

So you know what to look for, the main protections are documented in the repository:
[`docs/seguranca.md`](docs/seguranca.md) (security notes, in Portuguese) and
[`docs/lgpd.md`](docs/lgpd.md) (data processing record). Code scanning (CodeQL) runs on every
push and pull request to `main`.
