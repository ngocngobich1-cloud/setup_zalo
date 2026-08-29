# STAB-02 FINAL REPORT

```text
CONTRACT_ID = PD-STAB-02-BACKUP-WAL-RESTORE-02
EXECUTION_DATE = 2026-08-27
RESULT = PASS
STAB_02 = CANDIDATE_FOR_BU_PO_REVIEW
STAB_02_CLOSED = NO
```

--------------------------------
A. AUTHORITY
--------------------------------

```text
STAGE_0_CLOSED = YES
STAB_02_AUTHORIZED = YES
STAB_01_AUTHORIZED = NO
PO_ACKNOWLEDGED_SERVICE_DOWNTIME = YES
CONTROLLED_STOP_TARGET = zalo-web-chat
```

The PO acknowledgement authorized stopping only `zalo-web-chat`. No authority was inferred for STAB-01, production repair, schema/data repair, migration execution, commit, push, or VPS work.

--------------------------------
B. WORKTREE DELTA
--------------------------------

The required audit was captured before DB work and before this report was created.

```text
STAGE0_TRACKED_MODIFIED = 16
CURRENT_TRACKED_MODIFIED = 17

STAGE0_UNTRACKED = 17
CURRENT_UNTRACKED = 25

STAGED = 0
POST_STAGE0_NEW_PATHS_CLASSIFIED = YES
DIRTY_WORKTREE_DELTA_SINCE_STAGE0 = AUDITED
```

The contract's latest-review expectation was 17 tracked modified and 21 untracked files. The actual tracked count matched. The actual untracked count was 25 because four additional Stage 0 evidence documents were present. No count was forced to match the expectation.

Post-Stage-0 delta:

| Path | Delta | Classification | Package |
|---|---|---|---|
| `kiem-thu/kiem-tra-zoom.js` | tracked modification | TEST_FIXTURE_CORRECTION | STAGE_0D |
| `kiem-thu/chay-hoi-quy-stage-0.js` | untracked | TEST_INFRASTRUCTURE | STAGE_0B |
| `kiem-thu/Dockerfile.stage0d` | untracked | TEST_INFRASTRUCTURE | STAGE_0D |
| `kiem-thu/Dockerfile.stage0d.dockerignore` | untracked | TEST_INFRASTRUCTURE | STAGE_0D |
| `kiem-thu/chay-stage0d-six.js` | untracked | TEST_INFRASTRUCTURE | STAGE_0D |
| `Docs/Stabilization/STAGE-0-BASELINE-REGRESSION.md` | untracked | EVIDENCE_DOCUMENTATION | STAGE_0 |
| `Docs/Stabilization/STAGE-0-TEST-QUALITY-INVENTORY.md` | untracked | EVIDENCE_DOCUMENTATION | STAGE_0 |
| `Docs/Stabilization/STAGE-0-WORKTREE-INVENTORY.md` | untracked | FREEZE_EVIDENCE_DOCUMENTATION | STAGE_0 |
| `Docs/Stabilization/STAGE-0D-CONTAINERIZED-BASELINE.md` | untracked | EVIDENCE_DOCUMENTATION | STAGE_0D |

This report is the single allowed STAB-02 repo addition and is not included in the pre-DB audit count above.

```text
FINAL_UNTRACKED_AFTER_ALLOWED_REPORT = 26
```

--------------------------------
C. PRE-STOP SQLITE FILESYSTEM STATE
--------------------------------

```text
PRE_STOP_FILESYSTEM_SNAPSHOT = COMPLETE
CAPTURED_AT = 2026-08-27T19:32:15.6704061+07:00

DB = data/zalo.db
EXISTS = YES
SIZE = 2424832 bytes
MTIME_UTC = 2026-08-27T11:38:53.0302042Z

WAL = data/zalo.db-wal
EXISTS = YES
SIZE = 4140632 bytes
MTIME_UTC = 2026-08-27T12:32:10.2541699Z

SHM = data/zalo.db-shm
EXISTS = YES
SIZE = 32768 bytes
MTIME_UTC = 2026-08-27T11:01:43.2015708Z
```

Existing `.db` backups in `data/` were listed by filesystem metadata only and were not opened:

| File | Size |
|---|---:|
| `zalo-p9-pre-migration-20260827-024037.db` | 1,867,776 bytes |
| `zalo-uat-backup-20260826-004531.db` | 1,355,776 bytes |
| `zalo-uat-step4-7-backup-20260826-013730.db` | 1,355,776 bytes |

--------------------------------
D. DB HOLDER / DOWNTIME
--------------------------------

Docker metadata proved that `zalo-web-chat` runs `node server.js` and has the exact read/write bind mount below:

```text
SOURCE = D:\DA test\zalo-web\data
DESTINATION = /app/data
MODE = rw
DB_HOLDER = zalo-web-chat
DB_HOLDER_PROVEN = YES
```

`zalo-web-caddy` and `zalo-web-opencode` were separate containers and were not stopped.

```text
STOP_COMMAND = docker stop --time 15 zalo-web-chat
STOP_STARTED_AT = 2026-08-27T19:32:44.9672284+07:00
STOP_COMPLETED_AT = 2026-08-27T19:33:01.5679490+07:00

STOP_WINDOW_START = 2026-08-27T19:32:44.9672284+07:00
STOP_WINDOW_END = 2026-08-27T19:41:12.2217622+07:00
TOTAL_DOWNTIME = 00:08:27.2545338
TOTAL_DOWNTIME_SECONDS = 507.255

CONTROLLED_STOP = PASS
GRACEFUL_SHUTDOWN_CLASSIFICATION = NOT_GRACEFUL
```

Runtime event evidence recorded SIGTERM (15), followed by SIGKILL (9) after the 15-second timeout. The container exited with code 137 and `OOMKilled=false`. Source inspection found no SIGTERM/SIGINT handler that closes the HTTP server or SQLite connection. No shutdown-code change was made.

--------------------------------
E. POST-STOP FILESYSTEM STATE
--------------------------------

```text
POST_STOP_FILESYSTEM_SNAPSHOT = COMPLETE
CAPTURED_AT = 2026-08-27T19:33:18.7990072+07:00

DB = data/zalo.db
EXISTS = YES
SIZE = 2424832 bytes
MTIME_UTC = 2026-08-27T11:38:53.0302042Z

WAL = data/zalo.db-wal
EXISTS = YES
SIZE = 4140632 bytes
MTIME_UTC = 2026-08-27T12:32:55.0527695Z

SHM = data/zalo.db-shm
EXISTS = YES
SIZE = 32768 bytes
MTIME_UTC = 2026-08-27T12:32:55.0549665Z

DB_CHANGED_DURING_STOP = NO
WAL_CHANGED_DURING_STOP = YES
SHM_CHANGED_DURING_STOP = YES
```

The change classification is based on filesystem metadata. No SQLite interpretation occurred before raw preservation.

--------------------------------
F. RAW FORENSIC STATE
--------------------------------

```text
RAW_STATE_PATH = D:\DA test\stab02-evidence\20260827-193244\raw-pre-inspection\
RAW_STATE_PRESERVED = YES
RAW_STATE_INCLUDES_DB = YES
RAW_STATE_INCLUDES_WAL_IF_PRESENT = YES
RAW_STATE_INCLUDES_SHM_IF_PRESENT = YES

RAW_STATE_ROLE = FORENSIC_BASELINE_FOR_STAB_01B
RAW_STATE_IMMUTABLE = YES

RAW_DB_SHA256 = C2057C92D2C8C3DA1371D6757D7E4A096F66AE18A12EE8D983B54DF720D3D6C6
RAW_WAL_SHA256 = AA4D556D19FB89048B4AC12822497B2030F160078EE327D5FBCD05D15B50C060
RAW_SHM_SHA256 = 1CF9B6A9237B3AB9F046BF178B3F9A1782919591BC23B9964513477BE5EA22CB
```

All three files were copied byte-for-byte after the stop and before any SQLite access, hashed, and marked Windows read-only. Final re-hashing at `2026-08-27T19:41:59.9748142+07:00` produced the same values. The raw set was never opened, mounted, checkpointed, restored into, or modified by SQLite.

--------------------------------
G. SQLITE / WAL OBSERVATION
--------------------------------

The SQLite access gate was satisfied before the canonical DB was opened:

```text
DB_HOLDER_STOPPED = YES
POST_STOP_FILESYSTEM_SNAPSHOT = COMPLETE
RAW_STATE_PRESERVED = YES
RAW_STATE_HASHED = YES
```

The canonical DB was opened read-only in an isolated, network-disabled container.

```text
JOURNAL_MODE = wal
CURRENT_BUSY_TIMEOUT = 1000 ms
FOREIGN_KEYS = 0
INTEGRITY_CHECK = ok

SCHEMA_OBJECT_COUNT = 26
TABLE_COUNT = 20
INDEX_COUNT = 6

SOURCE_ROWCOUNT_threads = 58
SOURCE_ROWCOUNT_messages = 1567
SOURCE_ROWCOUNT_account_config = 2
SOURCE_ROWCOUNT_ai_chat_config = 1
SOURCE_ROWCOUNT_training_session = 0
SOURCE_ROWCOUNT_training_messages = 0
```

Pre/post inspection comparison:

```text
DB_SHA256_BEFORE = C2057C92D2C8C3DA1371D6757D7E4A096F66AE18A12EE8D983B54DF720D3D6C6
DB_SHA256_AFTER  = C2057C92D2C8C3DA1371D6757D7E4A096F66AE18A12EE8D983B54DF720D3D6C6

WAL_SHA256_BEFORE = AA4D556D19FB89048B4AC12822497B2030F160078EE327D5FBCD05D15B50C060
WAL_SHA256_AFTER  = AA4D556D19FB89048B4AC12822497B2030F160078EE327D5FBCD05D15B50C060

SHM_SHA256_BEFORE = 1CF9B6A9237B3AB9F046BF178B3F9A1782919591BC23B9964513477BE5EA22CB
SHM_SHA256_AFTER  = 956D41DD43894A1F406BFFC01271A26B36477A0E66FF3E486D06ABF015546590

WAL_CHANGED_DURING_SQLITE_INSPECTION = NO
SHM_CHANGED_DURING_SQLITE_INSPECTION = YES
```

SQLite updated shared-memory bookkeeping while opening read-only. The main DB and WAL bytes remained unchanged. One earlier container command had a JavaScript parse error, so it failed before executing and did not open SQLite.

```text
CHECKPOINT_REQUIRED = NO
CHECKPOINT_EXECUTED = NO
CHECKPOINT_OBSERVATION = No intentional checkpoint; the selected Backup API does not require pre-checkpointing.

WAL_PRE_STOP_STATE = RECORDED
WAL_POST_STOP_STATE = RECORDED
WAL_POST_INSPECTION_STATE = RECORDED
```

--------------------------------
H. CANONICAL BACKUP
--------------------------------

Options evaluated:

| Option | Evaluation |
|---|---|
| A — SQLite Backup API | Selected. Consistent snapshot, reads active WAL state, emits one restorable DB file, and needs no destructive checkpoint. |
| B — stopped app + proven checkpoint + DB copy | Not selected. The stop was not graceful and WAL remained non-empty; a deliberate checkpoint was unnecessary for Option A. |
| C — stopped app + DB/WAL-aware preserved set | Used only for the immutable forensic role. It was not claimed as the canonical restorable backup. |

```text
SELECTED_METHOD = SQLite sqlite3_backup API with source opened READONLY while zalo-web-chat remained stopped
RATIONALE = WAL-aware consistent logical snapshot without relying on a main-file copy or destructive checkpoint
FILES_INCLUDED = Logical canonical state from the main database and active WAL; output is canonical-backup\zalo.db
CHECKPOINT_SEMANTICS = No checkpoint requested or required; sqlite3_backup read the consistent source snapshot including WAL-visible pages

BACKUP_PATH = D:\DA test\stab02-evidence\20260827-193244\canonical-backup\zalo.db
BACKUP_SIZE = 2502656 bytes
BACKUP_SHA256 = 7EAAEE01941B7367F65995EDED44B6AA04D4359784DB993AFF453451F8A15F81
BACKUP_READ_ONLY = YES
BACKUP_INSIDE_REPO = NO

CONSISTENT = YES
RESTORABLE = YES
REPEATABLE = YES
WAL_AWARE = YES
CANONICAL_BACKUP_METHOD = PROVEN
```

The successful backup processed 611 pages, finished with `remaining=0`, `completed=true`, and `failed=false`. A first lifecycle trial created a zero-byte file because only the initialization callback ran; it was rejected, safely removed from the exact evidence directory, and never treated as a backup. The successful attempt used explicit `step(-1)` and `finish()`.

--------------------------------
I. RESTORE
--------------------------------

The verified backup was copied to an isolated restore path. The live canonical DB was never the destination.

```text
RESTORE_PATH = D:\DA test\stab02-evidence\20260827-193244\restore-verify\zalo.db
RESTORE_OUTSIDE_REPO = YES
RESTORE_SHA256_BEFORE_OPEN = 7EAAEE01941B7367F65995EDED44B6AA04D4359784DB993AFF453451F8A15F81
RESTORE_SHA256_AFTER_OPEN = 7EAAEE01941B7367F65995EDED44B6AA04D4359784DB993AFF453451F8A15F81
RESTORE_READ_ONLY = YES

RESTORED_DB_OPENS = YES
INTEGRITY_CHECK = ok
INTEGRITY_CHECK_STATUS = OK
SCHEMA_READABLE = YES
SOURCE_RESTORE_SCHEMA_MATCH = YES
SOURCE_RESTORE_ROWCOUNT_MATCH = YES
RESTORE_VERIFIED = PASS
```

Source and restore both had 26 non-internal schema objects and the same selected counts:

| Table | Source | Restore |
|---|---:|---:|
| `threads` | 58 | 58 |
| `messages` | 1567 | 1567 |
| `account_config` | 2 | 2 |
| `ai_chat_config` | 1 | 1 |
| `training_session` | 0 | 0 |
| `training_messages` | 0 | 0 |

Verification-created zero-byte WAL and transient SHM sidecars were removed after the DB connection closed. Their main DB hashes were unchanged, and both final evidence DB files were marked read-only.

--------------------------------
J. WAL POLICY
--------------------------------

```text
WAL_HANDLING_DECISION = CLOSED

WHILE_APP_RUNNING_MAIN_DB_ONLY_COPY = FORBIDDEN

WHEN_WAL_EXISTS = Use SQLite Backup API/equivalent consistent WAL-aware API for a canonical backup. For forensic capture, first stop the proven DB holder and preserve the exact DB+WAL+SHM set.

BEFORE_MIGRATION = Stop the app and prove the DB holder is stopped.

CANONICAL_BACKUP_METHOD_REQUIRED = SQLite sqlite3_backup API with the app stopped, source opened read-only, backup completed and closed cleanly, then isolated integrity/schema/row-count restore verification.

AFTER_CONTROLLED_STOP = Do not assume WAL is clean or checkpointed. Preserve and hash the raw DB+WAL+SHM set first. Inspect after the SQLite gate. Checkpoint only when a separately selected method requires it and its effect is documented; never TRUNCATE/RESTART merely to make files look clean.

CANONICAL_BACKUP_WAL_SEMANTICS = EXPLICIT
CANONICAL_BACKUP_WAL_MECHANISM = sqlite3_backup read the transactionally consistent state visible across the main database and its non-empty WAL; no manual checkpoint was used.
WAL_HANDLING = CLOSED
```

--------------------------------
K. BUSY TIMEOUT
--------------------------------

```text
CURRENT_BUSY_TIMEOUT = 1000 ms
CURRENT_CONFIGURATION = IMPLICIT_RUNTIME_DEFAULT
EXPLICIT_BUSY_TIMEOUT_IN_PRODUCTION_INIT = NO
CONNECTION_CREATION_SITES = AUDITED

BUSY_TIMEOUT_DECISION = SET_CANONICAL_VALUE_LATER
SOURCE_CHANGE_REQUIRED = YES
FOLLOWUP_REQUIRED = YES
BUSY_TIMEOUT_SOURCE_CHANGE = NOT_PERFORMED
BUSY_TIMEOUT_DECISION_STATUS = CLOSED
```

Connection creation sites audited:

- Canonical runtime: `lib/db.js:76`.
- Deliberate migration helper: `lib/db.js:1700`.
- Read-only operational scripts: `sao-luu/chup-csdl.js:12`, `sao-luu/kiem-tra-csdl.js:11`, `sao-luu/kiem-tra-giai-ma.js:20`.
- Test-only connections: `kiem-thu/kiem-tra-day-po.js:90,459,1149`, `kiem-thu/kiem-tra-zoom.js:66,2732`, and `kiem-thu/kiem-tra-p9-owner-profile.js:25`.

The 1000 ms value is observable but not explicit in application source. A future production-source contract must select and explicitly configure the canonical value consistently at the relevant runtime/migration sites. STAB-02 does not choose or implement that source change.

--------------------------------
L. MIGRATION RULE
--------------------------------

```text
MIGRATION_APP_STOPPED_RULE = CLOSED
DEFAULT = APP_STOPPED
MIGRATION_RUNTIME_RULE = CLOSED
NO_MIGRATION_EXECUTED = YES
```

Any future migration must stop the proven DB holder, preserve a raw forensic state where required, create and verify a canonical WAL-aware backup, and only then execute under its own authority. Online migration remains forbidden unless a future dedicated contract explicitly proves it safe.

--------------------------------
M. RESTART
--------------------------------

Restart occurred only after the raw forensic state, canonical backup, and isolated restore had all passed.

```text
RESTART_COMMAND = docker start zalo-web-chat
RESTART_STARTED_AT = 2026-08-27T19:40:02.6193660+07:00
SERVICE_AVAILABLE_AT = 2026-08-27T19:41:12.2217622+07:00

zalo-web-chat = RUNNING
RESTART_COUNT = 0
EXPECTED_LOCAL_PORT = 127.0.0.1:3790
LOCAL_HTTP_RESPONSE = 308

zalo-web-caddy = RUNNING
zalo-web-opencode = RUNNING

LIVE_DB_AFTER_RESTART = POTENTIALLY_MUTATED_BY_STARTUP_BACKFILL
STAB_01B_FORENSIC_SOURCE = RAW PRE-INSPECTION STATE
```

After restart, the live WAL/SHM mtimes advanced to approximately `2026-08-27T12:40:17Z`, consistent with runtime activity. No attempt was made to open or bypass the active runtime file locks. `initDb()` still calls `backfillSystemMessageText()`, which contains the suspect `UPDATE messages SET content = ? WHERE id = ?`; that behavior belongs to STAB-01B and was not repaired here.

--------------------------------
N. CANONICAL REGRESSION
--------------------------------

The unchanged canonical runner executed after restart in image `zalo-web-stage0d:2026-08-27` (`sha256:00bb229da8190183ebaa43a660e6da6ba7ad6270593d35599a11bb2342504741`). Controls were `--network none`, read-only root filesystem, ephemeral `/tmp`, no host bind mount, all capabilities dropped, and `no-new-privileges`.

```text
REGRESSION_STARTED_AT = 2026-08-27T19:41:25.9492647+07:00
REGRESSION_COMPLETED_AT = 2026-08-27T19:41:35.1333411+07:00
REGRESSION_EXIT_CODE = 0

REGRESSION_ENVIRONMENT = STAGE_0D_CONTAINERIZED
TOTAL_AUTOMATED_SAFE = 10
PASS = 10
FAIL_KNOWN = 0
FAIL_UNKNOWN = 0
TIMEOUT = 0
ENVIRONMENT_BLOCKED = 0
CANONICAL_TEST_RUNNER_PASS = YES
```

| Suite | Result |
|---|---|
| AI_ACTION_BOUNDARY | PASS |
| AI_DEFAULT | PASS |
| AI_MODEL_SOURCE | PASS |
| ONBOARDING | PASS |
| TEACH_BOT | PASS |
| CHAT_ATTACHMENT | PASS |
| P9_OWNER_PROFILE | PASS |
| P9_17_MODEL_SAVE | PASS |
| PHONE_DIRECT_MESSAGE | PASS |
| ZOOM | PASS |

The regression reported zero real provider/Zalo/Zoom calls where applicable.

--------------------------------
O. SAFETY
--------------------------------

```text
PRODUCTION_SOURCE_CHANGED = NO
PRODUCTION_SOURCE_CHANGED_BY_STAB02 = NO
SCHEMA_CHANGED = NO
SCHEMA_CHANGED_BY_STAB02 = NO
DATA_REPAIR_PERFORMED = NO
MIGRATION_PERFORMED = NO

CANONICAL_DB_OVERWRITTEN = NO
RESTORE_OVERWROTE_CANONICAL_DB = NO

SENSITIVE_DB_EVIDENCE_INSIDE_REPO = NO
RAW_FORENSIC_STATE_MODIFIED_AFTER_CAPTURE = NO

GITIGNORE_CHANGED = NO
DEPENDENCIES_CHANGED = NO
PRODUCTION_DOCKER_CHANGED = NO
TEST_SEMANTICS_CHANGED = NO

COMMIT = NO
PUSH = NO
VPS = NO
```

All DB, WAL, SHM, backup, and restore bytes remain local-only under `D:\DA test\stab02-evidence\20260827-193244\`, outside the repo. They are sensitive and must not be committed or pushed.

--------------------------------
P. ACCEPTANCE
--------------------------------

```text
BACKUP = PASS
RESTORE = PASS
WAL = PASS
BUSY_TIMEOUT = PASS
MIGRATION_RULE = PASS
WORKTREE_DELTA = PASS
REGRESSION = PASS

STAB_02 = PASS
STAB_02_CLOSURE_CANDIDATE = YES
STAB_02_CLOSED = NO
```

--------------------------------
Q. NEXT BOUNDARY
--------------------------------

```text
NEXT = WAIT FOR PO / BU REVIEW FOR STAB-01
STAB_01_STARTED = NO
```

The immutable raw pre-inspection state is the hand-forward forensic baseline for STAB-01B. No STAB-01 work is authorized or started by this report.
