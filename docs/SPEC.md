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

OCR and AI extraction are not the normal path. When a current PDF relationship
unexpectedly changes, the localhost admin may manually relink a `new` PDF
relationship to an `absent` existing supporter. Relinking preserves the
supporter's opaque identity, level and history, and portal state. Ordinary PDF
import then re-inspects the current local state and remains authoritative for
support-state and display-name changes. Merging two already-existing supporter
rows remains a separate concern if it is ever needed.

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

The preferred path is to enter the previous manual method's last notified level
while the FANBOX PDF relationship is still classified as `new`. As a safe
correction path immediately after an initial import, an already-created
supporter may receive one legacy baseline only while its current level is 0,
its latest month is unset, and it has no level history or monthly progression.
This is a one-time baseline assignment, not general level editing.

The previous manual method's last notified level is the migration source for
the current level. After migration, the dedicated portal is the authoritative
supporter-facing level display, and recurring monthly individual level
notifications are no longer required.

Existing supporters each receive their personal portal URL once. New supporters
receive one when registered. Exceptional lost-link handling uses token
rotation/reissue.

After the required encrypted post-update backup succeeds, a successful
existing-supporter migration or registration automatically synchronizes the
newly created supporter to Cloudflare. Known missing portal configuration
blocks the migration before local mutation starts. If automatic synchronization
fails after the local registration is committed, the registration and completed
backup are not rolled back or repeated. The manual per-supporter
`Cloudflareへ同期` action is the explicit recovery path.

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

The localhost admin can create an encrypted current-state backup on demand.
Manual backups and future automatic backups use the same selected directory,
Keychain-backed key, consistent SQLite snapshot, authenticated encryption, and
encrypted filesystem persistence pipeline.

After the required encrypted post-update backup succeeds, a successful lottery
result batch automatically synchronizes the exact affected participants to
Cloudflare. Known missing portal configuration blocks the lottery-result
mutation before it starts. If automatic synchronization fails after the local
update is committed, the local mutation and completed backup are not rolled
back or repeated. The manual per-supporter `Cloudflareへ同期` action is the
explicit recovery path.

After the required encrypted post-processing backup succeeds, successful
month-end processing automatically synchronizes exactly the supporters returned
by the month-end processing result to Cloudflare, in returned order. Known
missing portal configuration blocks month-end processing before the required
pre-processing backup and mutation start. If automatic synchronization fails
after the month-end update is committed, the local mutation and both completed
backups are not rolled back or repeated. The manual per-supporter
`Cloudflareへ同期` action is the explicit recovery path.

The human-selected backup destination is persisted in the local Mac SQLite
admin state so it survives localhost admin restarts. Browser storage and
directory handles are not the source of truth for this setting.

Choosing a directory inside iCloud Drive works through ordinary filesystem
access and requires no dedicated iCloud integration. Only encrypted backup
artifacts may be written into the selected directory, never the live database or
unencrypted database backups.

Create an encrypted backup from a consistent SQLite snapshot and encrypt it
before writing it to the selected backup directory. The decryption secret or
private key must not be stored only beside the encrypted backups.

The backup AES key is stored separately from backup artifacts in the current
user's macOS Keychain. It is generated on first backup-key-provider use and
reused thereafter rather than automatically rotated. It is not stored in
SQLite or in the selected backup directory. Key recovery, export, and rotation
remain later concerns.

Required backup triggers are:

- one post-backup for each successfully committed lottery result batch;
- one real pre-processing backup and one post-processing backup for successful
  month-end processing;
- one post-backup for a FANBOX import only when at least one new local
  supporter is created; and
- one post-backup for each successful existing-supporter migration or
  registration.

Continuing and returning supporter updates do not count as new-supporter
registration triggers. For post-only protected operations, a known missing
backup destination blocks the mutation before it starts. Month-end processing
cannot start unless its real pre-processing backup succeeds. A post-backup
failure does not roll back an already committed business update. The manual
`今すぐバックアップを作成` action is the explicit recovery path after a
post-update backup failure.

The repository implements the backup pipeline with consistent SQLite snapshots,
versioned authenticated backup encryption, macOS Keychain-backed
encryption-key access, persisted human-selected backup destination, encrypted
filesystem artifact writing, manual backup execution, and the required
automatic backup triggers described above.

Restoring or decrypting a backup into a live-database replacement is not yet
implemented. Backup-key recovery, export, and rotation remain future/separate
work.

Every successful valid FANBOX PDF import requires portal integration to be
available after PDF inspection and supporter comparison, before backup
readiness checks or local mutation. After the local import commits, it
automatically synchronizes exactly the immutable
`FanboxSupporterImportResult.affectedSupporterIds` returned by the import
service, in returned order. An import with no affected supporter IDs performs
no synchronization calls.

When at least one new supporter is created, automatic synchronization starts
only after the existing required encrypted post-update backup succeeds.
Imports that only update existing supporters retain the existing no-backup rule
and synchronize after commit. Synchronization failure after commit does not
roll back or repeat the import or any completed backup. The manual per-supporter
`Cloudflareへ同期` action is the explicit recovery path. FANBOX PDF import
automatic synchronization is no longer deferred.
Month-end processing automatic synchronization is defined above and is no longer
deferred.

## Current implementation status and remaining launch work

The repository implements:

- the TypeScript/Node workspace/runtime and Mac-local localhost admin server/UI;
- SQLite schema/migrations and storage/application layers;
- FANBOX PDF extraction, comparison, import, and manual unexpected-identity
  relink;
- lottery and month-end workflows;
- the Cloudflare Worker/D1 application, supporter token authentication/read API,
  and `/level` supporter page;
- local portal-link issue/reissue/sent-state flow;
- automatic Cloudflare synchronization;
- the encrypted backup pipeline and automatic triggers; and
- GitHub Actions CI.

Repository implementation and external production provisioning are separate
concerns. The Mac-local admin and supporter-facing Worker applications are
implemented in repository code. The repository Worker configuration does not
yet contain a real production D1 database binding ID, and repository
documentation does not yet define the production Cloudflare resource, secret,
or deployment procedure. Production Cloudflare provisioning and deployment
therefore remain launch work.

The Mac production CLI currently requires explicit `FANBOX_ADMIN_DB_PATH`. A
permanent/default Mac database location and normal durable launch convention
remain unsettled.

Separate later work includes:

- backup restore/live-database replacement;
- backup-key recovery/export/rotation;
- merging two already-existing supporter rows if that exceptional case is ever
  required; and
- Issue #82 dependency vulnerability remediation.

Issue #82 is open and unresolved, and is currently deferred by explicit Human
decision. It is not currently a product-work blocker.
