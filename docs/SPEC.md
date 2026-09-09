# fanbox-level-manager product specification

This document records the durable product requirements for the FANBOX supporter
lottery-level benefit operated by Sayosomi Lab. Current implementation contracts
are tracked in this repository's GitHub Issues.

## Product purpose and surfaces

The system replaces the creator's manual lottery-level administration with two
surfaces:

1. A Mac-localhost admin web application used by the creator.
2. A Cloudflare-hosted supporter page where each supporter can check their own
   current lottery level and level history at any time.

Admin smartphone support is not required.

## Lottery-level rules

- A supporter's first support month starts at lottery level 0.
- Level N gives the supporter N+1 entries in a lottery.
- Each calendar month has one possible +1 level allowance. A lottery loss
  increases the level by 1 only when that allowance has not already been used.
- A supporter who did not participate in any lottery during a calendar month
  receives a +1 at month end only when they are present in the month-end FANBOX
  supporter list and that month's +1 allowance has not already been used.
- A level can increase at most once per calendar month.
- A win resets the level to 0 and does not itself consume the month's +1
  allowance.
- In the same month, `win -> loss` can end at level 1 when no earlier +1
  occurred in that month.
- In the same month, `loss -> win -> loss` ends at level 0: the first loss
  already consumed that month's single +1 allowance, the win resets the level
  to 0, and the later loss cannot add another +1.
- Multiple losses in one month produce at most one +1.
- Leaving FANBOX does not reset the level. Since 2025-09-30, a returning
  supporter resumes their prior level.
- A supporter who participated in no lottery and is not supporting at month end
  receives no month-end +1.
- Leaving and rejoining within the same month is treated as continuous when the
  supporter is present again in the month-end list.
- Supporter-only secondary sales do not affect lottery level.
- Calendar-month semantics use Japan time (`Asia/Tokyo`).

## FANBOX data acquisition

The admin workflow must not depend on browser scraping or crawling.

The intended workflow is:

1. The human manually opens the FANBOX supporter list and saves it as a PDF.
2. The Mac-localhost application imports that PDF.
3. The PDF's real link annotations provide
   `.../manage/relationships/<id>` relationship identifiers together with
   nearby display names.
4. Imported relationship IDs are compared with local records to classify new,
   continuing, currently absent, and returning supporters.

OCR and AI extraction are not the normal path. A manual identity merge/link
escape hatch remains possible if a FANBOX relationship identity changes
unexpectedly.

## Data privacy boundary

The live SQLite database is the local identity and admin data store on the Mac.
It may contain:

- FANBOX relationship ID;
- FANBOX/pixiv display name;
- the mapping from FANBOX identity to an opaque internal random supporter ID;
- current local support-membership state derived from imported PDFs;
- portal-link issuance/sent state and migration or other admin metadata needed
  for operation; and
- local history and state needed for lottery and month-end operations.

FANBOX/pixiv identity stays local. The Cloudflare supporter service must not
store FANBOX/pixiv identity data, including display name, pixiv ID, FANBOX
relationship ID, email, or FANBOX private memo text. It must not store the
specific plushie or product name associated with a lottery or win.

Cloudflare receives and stores only the minimum opaque, supporter-facing, and
operational data needed, such as:

- opaque internal supporter ID;
- current lottery level;
- generic level-change or lottery history needed by the portal;
- supporter-page authentication token hash; and
- timestamps needed for display and synchronization.

The intended hosted platform is Cloudflare Workers with D1, using the free tier
where practical.

## Supporter-page authentication

Each supporter receives one long, random personal secret URL by individual
FANBOX/pixiv message. Its preferred shape is:

`https://<portal>/level#<long-random-token>`

Client-side code reads the fragment token and submits it to the Worker, so the
token does not appear in ordinary HTTP request paths or logs. The server stores
only a cryptographic hash of the token, never the raw token.

The personal URL:

- contains no FANBOX ID or display name;
- can remain valid while the supporter is inactive and after they return;
- can be revoked and reissued; and
- should be reissued when lost instead of requiring long-term raw-token
  recovery.

## Supporter page

The supporter page shows at least:

- current lottery level;
- the next-lottery entry count, derived as `level + 1`;
- final update time; and
- level history.

The supporter-facing final update time is the latest successful Mac-to-Cloudflare
synchronization or verification of the current state. It is not merely the last
time the numeric level changed, so unchanged data can still show that it was
recently checked. Internal design may keep separate `changed_at` and
`verified_at`-style timestamps if useful.

Supporter-facing history uses generic reasons such as:

- `当選`;
- `抽選結果によるレベルアップ`;
- `抽選不参加によるレベルアップ`; and
- `旧管理方式による履歴`.

A lottery participation with no level change may still need to remain in local
or operational state so monthly participation can be determined, even when it
is not shown as a supporter-facing level-change event.

## Existing-supporter migration

Historical detail does not need to be reconstructed lottery by lottery.

Migration may establish each existing supporter's current level with one
baseline history entry, for example:

`システム移行時 Lv.7 / 旧管理方式による履歴`

The previous manual method's last notified level is the migration source for
the current level. After migration, the dedicated portal is the authoritative
supporter-facing level display, and recurring monthly individual level
notifications are no longer required.

Existing supporters each receive their personal portal URL once. New supporters
receive one when registered. Exceptional lost-link handling uses token
rotation/reissue.

## Admin workflows

The admin workflows support:

- supporter list and identity management;
- FANBOX PDF import and comparison;
- lottery registration, participants, winners, and automatic level effects;
- month-end processing using the latest imported supporter-list state;
- Cloudflare synchronization;
- portal-link issue/reissue and sent-state tracking; and
- migration from the old manual level records.

The month-end UI surfaces the timestamp of the FANBOX list used, so stale input
is visible before the operation is confirmed.

## Local backups

The live SQLite database remains local on the Mac and stays outside any
synchronized backup folder. Encrypted backup artifacts are written to a backup
directory selected by the human.

Choosing a directory inside iCloud Drive works through ordinary filesystem
access and requires no dedicated iCloud integration. Only encrypted backup
artifacts may be written into the selected directory, never the live database or
unencrypted database backups.

Create an encrypted backup from a consistent SQLite snapshot and encrypt it
before writing it to the selected backup directory. The decryption secret or
private key must not be stored only beside the encrypted backups.

Required backup triggers are:

- after lottery result confirmation;
- around month-end processing, with both a pre-processing and a post-processing
  restore point; and
- after adding or registering a new supporter.

The exact encryption tool or library and key-storage implementation are deferred
to a later implementation contract.

## Deferred implementation choices and non-goals

This documentation/bootstrap slice does not choose or implement:

- a JavaScript or TypeScript framework or runtime;
- localhost HTTP serving;
- the final physical SQLite or D1 schema;
- PDF parsing;
- Cloudflare Workers or D1 implementation;
- authentication or token-hashing implementation details;
- backup encryption implementation details;
- GitHub Actions CI workflows; or
- production Cloudflare accounts, resources, or custom domains.

Application source code, dependency manifests, migrations, schemas, CI
workflows, Cloudflare configuration, deployment files, and unrelated tests are
outside this issue.
