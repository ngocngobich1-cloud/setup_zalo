# STAGE 0A — Worktree Freeze & Inventory

```text
DATE = 2026-08-27
REPO = D:\DA test\zalo-web
CANONICAL_DOCUMENT = Docs/Stabilization/ZALO-WEB-STABILIZATION-PLAN-01 — V2.1.md
CANONICAL_DOCUMENT_EXISTS = YES
VERSION = V2.1
PD-STAB-V2-01 = APPROVED (Stage 0 implementation contract)
PLAN_AUTHORITY = GRANTED (Stage 0 implementation contract)
```

## Canonical authority verification

The exact canonical file exists and was read in full. Its header says `VERSION = V2.1` and `PO_FINAL_APPROVAL = GRANTED`.

Recorded document-state deviation: §44 and §48 still contain older markers `STAGE_0_IMPLEMENTATION = NOT_AUTHORIZED`, `PD-STAB-V2-01 = NOT_YET_SIGNED`, and `IMPLEMENTATION_AUTHORITY = NONE`. They were not edited. The later, PO-approved Stage 0 implementation contract explicitly states `PD-STAB-V2-01 = APPROVED`, `PLAN_AUTHORITY = GRANTED`, and authorizes only Stage 0A–0C.

These markers were subsequently reconciled under `PD-STAB-STAGE0-DOC-CORRECTION-03` on 2026-08-27; §44 was preserved unchanged as the historical release snapshot, while current-state markers outside §44 were updated.

## Immutable baseline recorded before Stage 0 mutation

```text
git rev-parse --show-toplevel = D:/DA test/zalo-web
git branch --show-current = main
git rev-parse HEAD = 0e3392631dffc3ed8e9653ba68e38d0764a94295
git rev-parse origin/main = 0e3392631dffc3ed8e9653ba68e38d0764a94295

WORKTREE = DIRTY
STAGED_PATHS = 0
TRACKED_MODIFIED_COUNT = 16
TRACKED_DELETED_COUNT = 0
UNTRACKED_COUNT = 17

PRODUCTION_SOURCE_CHANGED_COUNT = 18
TEST_CHANGED_COUNT = 14
DOC_CHANGED_COUNT = 1
GENERATED_COUNT = 0
TEMPORARY_COUNT = 0
UNKNOWN_COUNT = 0
UNRELATED_COUNT = 0
```

`git diff --stat` at freeze time: 16 tracked files, 2,031 insertions, 829 deletions. Git emitted only LF→CRLF advisory warnings; no normalization was performed.

## Tracked path inventory at freeze time

| Status | Path | Classification | Historical bucket / evidence |
|---|---|---|---|
| M | `kiem-thu/kiem-tra-day-po.js` | TEST_ONLY | TEACH_BOT; suite header and assertions explicitly cover owner instructions and pending confirmation behavior. |
| M | `kiem-thu/kiem-tra-onboarding.js` | TEST_ONLY | ONBOARDING; suite exercises Steps 0–9 and model boundary. |
| M | `lib/admin-command.js` | CURRENT_PRODUCT_DELTA | PARTIAL: TEACH_BOT / PHONE_DIRECT / P9-related owner and pending behavior; exact per-hunk historical package split is not fully proven. |
| M | `lib/ai-chat.js` | CURRENT_PRODUCT_DELTA | PARTIAL: P7/P9 model source and owner-scoped config; supported by current focused suites. |
| M | `lib/db.js` | CURRENT_PRODUCT_DELTA | PARTIAL: P9 owner profile plus TEACH_BOT/MEDIA persistence; exact per-hunk split is not fully proven. |
| M | `lib/onboarding.js` | CURRENT_PRODUCT_DELTA | ONBOARDING with P7/P9 owner/model integration. |
| M | `lib/opencode.js` | CURRENT_PRODUCT_DELTA | P1/P7 AI default and canonical model resolution. |
| M | `lib/training.js` | CURRENT_PRODUCT_DELTA | PARTIAL: P7/P9 owner/model state; exact per-hunk split is not fully proven. |
| M | `lib/zalo-service.js` | CURRENT_PRODUCT_DELTA | MEDIA and PHONE_DIRECT behavior. |
| M | `public/app.js` | CURRENT_PRODUCT_DELTA | MEDIA plus P9 owner-switch UI invalidation. |
| M | `public/config.js` | CURRENT_PRODUCT_DELTA | PARTIAL: P1/P2/P7/P9 AI settings and owner generation; multiple focused suites prove a mixed delta. |
| M | `public/index.html` | CURRENT_PRODUCT_DELTA | ONBOARDING and MEDIA UI. |
| M | `public/onboarding.js` | CURRENT_PRODUCT_DELTA | ONBOARDING/P7 UI state. |
| M | `public/style.css` | CURRENT_PRODUCT_DELTA | ONBOARDING and MEDIA layout. |
| M | `public/training.js` | CURRENT_PRODUCT_DELTA | P7/P9 plus MEDIA training UI. |
| M | `server.js` | CURRENT_PRODUCT_DELTA | PARTIAL: P2/P7/P9 and MEDIA routes; exact per-hunk split is not fully proven. |

## Untracked path inventory at freeze time

| Path | Type | Likely purpose | Classification | Safe to ignore for automated test | Publication risk |
|---|---|---|---|---|---|
| `Docs/Stabilization/ZALO-WEB-STABILIZATION-PLAN-01 — V2.1.md` | Markdown | Canonical stabilization plan | DOCUMENTATION | YES | YES — canonical plan is currently untracked |
| `kiem-thu/kiem-tra-ai-action-boundary.js` | Node suite | P2 source/action boundary | TEST_ONLY | NO | YES |
| `kiem-thu/kiem-tra-ai-default.js` | Node suite | P1 AI default behavior | TEST_ONLY | NO | YES |
| `kiem-thu/kiem-tra-ai-model-source.js` | Node suite | P7 canonical model source | TEST_ONLY | NO | YES |
| `kiem-thu/kiem-tra-chat-attachment.js` | Node suite | MEDIA behavior/source checks | TEST_ONLY | NO | YES |
| `kiem-thu/kiem-tra-p9-17-model-save.js` | Node suite | P9.17 model-save handler regression | TEST_ONLY | NO | YES |
| `kiem-thu/kiem-tra-p9-owner-profile.js` | Node suite | P9 owner isolation/migration on temp DB | TEST_ONLY | NO | YES |
| `kiem-thu/p2-browser-harness.html` | Browser harness | P2 deterministic browser QA | TEST_ONLY | YES for automated runner; NO for manual QA | YES |
| `kiem-thu/p2-browser-server.js` | Persistent local server | Serves P2 harness on port 3791 | TEST_ONLY | YES for automated runner; NO for manual QA | YES |
| `kiem-thu/p7-browser-harness.html` | Browser harness | P7 deterministic browser QA | TEST_ONLY | YES for automated runner; NO for manual QA | YES |
| `kiem-thu/p7-browser-server.js` | Persistent local server | Serves P7 harness on port 3792 | TEST_ONLY | YES for automated runner; NO for manual QA | YES |
| `kiem-thu/p9-15-browser-harness.html` | Browser harness | P9.15 provider/owner browser QA | TEST_ONLY | YES for automated runner; NO for manual QA | YES |
| `kiem-thu/p9-15-browser-server.js` | Persistent local server | Serves P9.15 harness on port 3792 | TEST_ONLY | YES for automated runner; NO for manual QA | YES |
| `lib/migrations/p9-zalo-uid-profile.js` | Production migration source | P9 owner-profile migration implementation | CURRENT_PRODUCT_DELTA | NO | YES |
| `lib/onboarding-architect.js` | Production source | ONBOARDING/P7 model boundary | CURRENT_PRODUCT_DELTA | NO | YES |
| `lib/zalo-media.js` | Production source | MEDIA attachment adapter | CURRENT_PRODUCT_DELTA | NO | YES |
| `public/chat-media.js` | Production source | MEDIA parser/render helpers | CURRENT_PRODUCT_DELTA | NO | YES |

## Historical classification result

```text
P1_P9_PATH_LEVEL_CLASSIFICATION = COMPLETE

P1_P9_HUNK_LEVEL_HISTORICAL_ATTRIBUTION =
EXPLICIT_NOT_PROVEN

P1_P9_DELTAS_CLASSIFIED =
EXPLICIT_NOT_PROVEN
```

Feature-level evidence is sufficient to classify every changed path as product, test, or documentation and to identify P1/P2/P7/P9, ONBOARDING, MEDIA, TEACH_BOT, and PHONE_DIRECT buckets where current bytes prove them. Exact authorship/package attribution for individual hunks inside shared files is not provable from the current Git metadata alone, so it is explicitly not guessed.

## Database hard-boundary evidence

Only filesystem metadata was observed:

| Path | Size bytes | Modified time |
|---|---:|---|
| `data/zalo-p9-pre-migration-20260827-024037.db` | 1,867,776 | 2026-08-27 02:41:07 |
| `data/zalo-p9-pre-migration-20260827-024037.db-shm` | 32,768 | 2026-08-27 02:41:10 |
| `data/zalo-p9-pre-migration-20260827-024037.db-wal` | 0 | 2026-08-27 02:41:10 |
| `data/zalo-uat-backup-20260826-004531.db` | 1,355,776 | 2026-08-26 00:46:15 |
| `data/zalo-uat-step4-7-backup-20260826-013730.db` | 1,355,776 | 2026-08-26 01:37:54 |
| `data/zalo.db` | 2,367,488 | 2026-08-27 17:13:34 |
| `data/zalo.db-shm` | 28,672 | 2026-08-27 16:38:54 |
| `data/zalo.db-wal` | 4,140,632 | 2026-08-27 17:53:23 |

```text
CANONICAL_DATABASE_OPENED_BY_STAGE0 = NO
SQLITE_CLIENT_USED_ON_CANONICAL_DB = NO
DATABASE_MUTATED_BY_STAGE0 = NO
WAL_CONTENT_INSPECTED = NO
```

All DB-using automated suites were proven to `chdir` to an OS temporary directory before loading `lib/db.js`, or to use an explicit temporary DB/shim. Six were then blocked at native dependency preflight and did not start. No test received a path under repository `data/`.

## Secret safety

`.env` is present and ignored by `.gitignore:8`. Its contents were not read, displayed, logged, hashed, or passed to any external service. No secret values are present in this artifact.

## Production source freeze fingerprint

The following SHA-256 values were captured before runner/docs mutation:

| Path | SHA-256 |
|---|---|
| `lib/admin-command.js` | `174B5E9B11319ECC3B76BDF92538E8DE40429FFF07FF887268D18D3C3ACEA6EA` |
| `lib/ai-chat.js` | `85FF059860FF6B66F3F8053E90E160E65F6DA65E7D3E4A1B1B886BE13658B9BE` |
| `lib/db.js` | `4CA5B8F7AD22FC56F8037FA991910C881501B4C13E609254A16BBFF4880EF8B3` |
| `lib/migrations/p9-zalo-uid-profile.js` | `614D8B252BF79252CD9093C9E2EB01E14209D5F2B0D59E353C7C06A7A85B23D1` |
| `lib/onboarding-architect.js` | `3851FD552DB7BE1FDDD2D9510F7FF845047440C9BB185550EC05D5733C68B639` |
| `lib/onboarding.js` | `0604690F4340001BDCB128F9FB0B64547000364B16A32A23E8E06CEB3D26149B` |
| `lib/opencode.js` | `9652863375A8CCA4F28FF136DCC8856E34A1E6D0E66C37DFEFEC8D8302E244BF` |
| `lib/training.js` | `189BE97A4324817D5B9D7B17F79F4D018B20B33E4E21FD7016867DAE9255197C` |
| `lib/zalo-media.js` | `DAA750F03720896DC301F16A5D761664B74456541B73B0277DA8A78B669D3FC1` |
| `lib/zalo-service.js` | `CA498220CFC9F2492DA65304EF079C1116DBA2C525E0E56161382C51F222A1B9` |
| `public/app.js` | `62AFAA676123FF69C50034D325416626D8CC82F7556F108C9F7D2656F11FB88D` |
| `public/chat-media.js` | `BE20ED4F8C9BDA3C340FF12A194E6F4D8ECE0F1350082442D7A965EE56F91E6B` |
| `public/config.js` | `8345927734628660C0BB78DC557EB8C85805E82D71B9B93DF044F90EC1B406AA` |
| `public/index.html` | `40629A04ACD6D1F00F537584F9E1C0F3382A73C7DB6202344FE215363A9C0E6B` |
| `public/onboarding.js` | `5CB2CB16E81EC35E081D87466139E3FC8A43D12379A563E4E63BA1BF29677871` |
| `public/style.css` | `6E1532F3B66AD8B3262B4F91C4F286FF55B56666CC045B4636FB93086E00EF8C` |
| `public/training.js` | `41810A082DB1CB86AAA23F4892CA528CF1C99AE2C44A3FCEE3E3FF9246241753` |
| `server.js` | `43440331A06ADE797413132524E7E6B9851A39DA2149AC42FB0DBEB0BF21FA10` |

```text
POST_STAGE0_FINGERPRINT_MATCH = YES (18/18 SHA-256 values match)
PRODUCTION_SOURCE_CHANGED_BY_STAGE0 = NO
```

The final filesystem metadata observation showed `data/zalo.db-wal` still at 4,140,632 bytes but with modified time advanced from `17:53:23` to `18:01:43`. Stage 0 never opened or received this path; the change is consistent with the already-running local runtime continuing to write. Per contract, that runtime was not stopped or restarted. This is recorded as concurrent external/runtime activity, not hidden or normalized.

## Safety controls

```text
DIRTY_WORKTREE_PRESERVED = YES
NO_RESET = YES
NO_CLEAN = YES
NO_STASH = YES
NO_CHECKOUT_OR_RESTORE = YES
NO_FETCH_OR_PULL = YES
NO_FILE_DELETION = YES
```
