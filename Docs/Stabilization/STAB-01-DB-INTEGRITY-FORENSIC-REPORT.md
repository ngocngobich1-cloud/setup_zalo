# STAB-01 DB INTEGRITY & FORENSIC REPORT

`CONTRACT_ID = PD-STAB-01-DB-INTEGRITY-FORENSIC-03`

`RESULT = PASS`

This report contains only sanitized aggregate evidence. It contains no customer
message body, raw row payload, thread identifier, message identifier, credential,
or database artifact.

================================
A. AUTHORITY / BASELINE
================================

`STAGE_0_CLOSED = YES`

`STAB_02_CLOSED = YES`

`STAB_01_AUTHORIZED = YES`

`PRODUCTION_REPAIR_AUTHORIZED = NO`

`DATA_REPAIR_AUTHORIZED = NO`

`SOURCE_AUDIT_CARRY_FORWARD = ACCEPTED`

`REPO = D:\DA test\zalo-web`

`BRANCH = main`

`HEAD = 0e3392631dffc3ed8e9653ba68e38d0764a94295`

`WORKTREE = DIRTY, PRESERVED`

The pre-report worktree contained 17 unstaged tracked files, 26 untracked files,
and no staged file. None of those existing changes was altered by STAB-01. This
report is the only repository artifact added by this execution.

The bounded source-drift check was performed at
`2026-08-27T20:33:35.8673746+07:00`. The formatter file hash was
`6043B1ED6845E62F258101799EBE406C8572407AA74980E1F6C0EBF40890C1EC`,
with no formatter diff from HEAD. The normalized backfill function hash remained
the accepted value in section G.

The current FULL MERGED V3 contract states `STAB_02_CLOSED = YES`. An older
STAB-02 report remains an unedited documentary closure candidate; this STAB-01
execution follows the newer PO/BU contract state and does not rewrite historical
documentation.

================================
B. FORENSIC HASH STATE
================================

`RAW_STATE_PATH = D:\DA test\stab02-evidence\20260827-193244\raw-pre-inspection`

`RAW_DB_SHA256_EXPECTED = C2057C92D2C8C3DA1371D6757D7E4A096F66AE18A12EE8D983B54DF720D3D6C6`

`RAW_DB_SHA256_ACTUAL = C2057C92D2C8C3DA1371D6757D7E4A096F66AE18A12EE8D983B54DF720D3D6C6`

`RAW_DB_HASH_MATCH = YES`

`RAW_WAL_SHA256_EXPECTED = AA4D556D19FB89048B4AC12822497B2030F160078EE327D5FBCD05D15B50C060`

`RAW_WAL_SHA256_ACTUAL = AA4D556D19FB89048B4AC12822497B2030F160078EE327D5FBCD05D15B50C060`

`RAW_WAL_HASH_MATCH = YES`

`RAW_SHM_SHA256_EXPECTED = 1CF9B6A9237B3AB9F046BF178B3F9A1782919591BC23B9964513477BE5EA22CB`

`RAW_SHM_SHA256_ACTUAL = 1CF9B6A9237B3AB9F046BF178B3F9A1782919591BC23B9964513477BE5EA22CB`

`RAW_SHM_HASH_MATCH = YES`

`FORENSIC_PAYLOAD_DB_WAL_INTACT = YES`

`SHM_ONLY_HASH_DEVIATION = NO`

`BU_PO_REVIEW_REQUIRED_FOR_SHM = NO`

`IMMUTABLE_RAW_OPENED_BY_SQLITE = NO`

`WORKING_FORENSIC_COPY = D:\DA test\stab01-evidence\20260827-203352\working-forensic-copy`

The DB, WAL, and SHM hard hash gate passed before any SQLite inspection. The raw
files remained read-only and their hashes were reverified unchanged at
`2026-08-27T20:42:05+07:00`. SQLite opened only the external working copy. A
working-copy SHM bookkeeping change was expected and was not propagated to the
immutable source.

Sanitized analysis evidence:

- Analysis script SHA-256:
  `8B268B9D8FD1DE4EEF40D47AF1E00AA8D62C2EF00FDA7D4EE2B90B694034354B`
- Sanitized summary SHA-256:
  `39ACEBA201FC17FD34F4E4C52F12FA96FE0E1B01206F03EE48102677818F7634`
- Analysis environment: Stage 0D container, no network, read-only root,
  capability drop, no-new-privileges, and only the evidence root mounted.
- SQLite open mode: read-only against the working copy.

================================
C. MESSAGE IDENTITY
================================

`MESSAGE_CANONICAL_IDENTITY = (thread_id, id)`

`PRIMARY_KEY = PRIMARY KEY(thread_id, id)`

`GLOBAL_MESSAGE_ID_UNIQUENESS = DISPROVEN`

`SCHEMA_EVIDENCE = PROVEN`

`PRAGMA table_info(messages)` proves primary-key order `thread_id = 1`, `id = 2`.
The SQLite primary-key auto-index is unique on `(thread_id, id)`, and the runtime
insert path supplies both components. Two IDs occur in more than one thread, so
`id` alone is not globally unique.

================================
D. MESSAGE MUTATION AUDIT
================================

`TOTAL_MUTATION_CALLSITES = 3`

`SAFE_SCOPED = 2`

`PROVEN_UNSCOPED = 1`

`POTENTIALLY_UNSCOPED = 0`

`NOT_PROVEN = 0`

`SUSPECT_CALLSITES = lib/db.js:419`

`OTHER_PRODUCTION_PATH_UPDATING_MESSAGES_CONTENT = NOT_FOUND`

Findings:

- `lib/db.js:419` is proven unscoped: the backfill executes
  `UPDATE messages SET content=? WHERE id=?`, omitting `thread_id`.
- `lib/db.js:541` is a safe-scoped runtime insert because the inserted row carries
  both `thread_id` and `id`, matching the composite primary key.
- `lib/db.js:1774` is a safe-scoped insert into the migration replacement table,
  whose primary key is also composite. The migration was not executed.
- No other production statement that updates `messages.content` was found.

================================
E. STRUCTURAL INTEGRITY
================================

`INTEGRITY_CHECK = ok`

`FOREIGN_KEYS_RUNTIME = OFF (PRAGMA foreign_keys = 0)`

`FOREIGN_KEY_VIOLATIONS = 0`

`ORPHAN_FINDINGS = 0`

`SCHEMA_CONSTRAINT_FINDINGS = messages has the correct composite primary key and a declared messages.thread_id -> threads.local_id foreign key; runtime FK enforcement is disabled`

The only declared foreign key in the inspected schema was checked dynamically;
it produced zero violations and zero child rows without a parent. The two training
tables contain zero rows and have no declared foreign keys, so no populated
logical-orphan condition was present there. Runtime enforcement remains a source
configuration gap even though the preserved state contains no FK violation.

================================
F. DUPLICATE ID DISTRIBUTION
================================

`TOTAL_MESSAGES = 1567`

`DISTINCT_IDS = 1565`

`DUPLICATED_IDS = 2`

`ROWS_WITH_DUPLICATED_ID = 4`

`MAX_ROWS_PER_ID = 2`

`SAME_LOGICAL_MESSAGE_DUPLICATE_IDS = 2`

`SAME_LOGICAL_MESSAGE_ROWS = 4`

`DIFFERENT_LOGICAL_MESSAGE_DUPLICATE_IDS = 0`

`DIFFERENT_LOGICAL_MESSAGE_ROWS = 0`

`NOT_PROVEN_DUPLICATE_IDS = 0`

`NOT_PROVEN_ROWS = 0`

Every duplicated-ID group was classified. Both groups have identical normalized
semantic payload, timestamp, sender, message type, and current content hash across
their two thread-scoped rows. One group is an ordinary message whose deterministic
original-content hash also matches both current rows. The other is a media message
with matching normalized semantic evidence. Neither group contains a currently
selectable or formatter-derivable backfill source row.

================================
G. BACKFILL ALGORITHM
================================

`FUNCTION = backfillSystemMessageText`

`BACKFILL_FUNCTION_HASH = 50A6F848113E5A338933E69CD5696729AF0F5C5CF14A031612F82F6681B09853`

`BACKFILL_ALGORITHM_VERSION_AMBIGUITY = NO`

`SELECT_ELIGIBILITY = content starts with "{" AND raw_json IS NOT NULL; a row mutates only when formatSystemMessage(raw_json) returns a non-null value`

`ORDER_BY_PRESENT = NO`

`UPDATE_SCOPE = WHERE id=?; thread_id is omitted, so every same-id row is targeted`

`INTRA_RUN_ORDER_DEPENDENCE = PROVEN`

`FINAL_WRITER_DEPENDENCE = PROVEN`

`BACKFILL_EXECUTION_FREQUENCY = REPEATED_EXECUTION_PROVEN; retained-container lower bound = 2 completed startups`

`NEXT_RUN_RESELECTS_WRONGLY_OVERWRITTEN_ROW = NO for the observed non-brace formatter outputs`

`NEXT_RUN_SELF_HEAL = NO`

`DAMAGE_PERSISTS_ACROSS_RESTART = YES for a hypothetical completed collision-induced non-brace overwrite, absent another legitimate write`

`IDEMPOTENCE_UNDER_COLLISION = PROVEN only as post-first-run state stability for observed non-brace outputs; correctness is not implied`

The SELECT has no `ORDER BY`, so source processing order is not contractually
defined. Every eligible source writes all same-id rows; a later eligible source can
overwrite an earlier source's output. Thus the last processed eligible source is
the final writer. In the preserved baseline, 64 rows match the initial SELECT but
all are formatter-null types, so current eligible sources are zero. Independently,
46 rows have a derivable formatter output, all already equal that output and no
longer satisfy the brace-prefixed SELECT predicate.

Application startup awaits the backfill before the server begins listening. Two
completed startup banners were retained in the current container history, proving
at least two executions; one occurred before raw capture and one after. No
positive `fixed > 0` log entry was present, so an execution that actually changed
rows is not proven by logs.

================================
H. CONTENT FORENSIC ORACLES
================================

`FORMATTER_HISTORICAL_STABILITY = PROVEN`

`FORMATTER_DETERMINISM = PROVEN`

`FORMAT_SYSTEM_MESSAGE_HISTORY = 447b9c8 only`

`FORMATTER_WORKTREE_MODIFICATION = NONE`

`OWN_ROW_ORACLE_METHOD = formatSystemMessage(row.raw_json)`

`OWN_ROW_ORACLE_APPLICABLE_ROWS = 46`

`OWN_ROW_ORACLE_NON_APPLICABLE_ROWS = 1521 (913 ordinary deterministic-original rows; 608 rows without an applicable formatter or ordinary-original oracle)`

`OWN_ROW_CONTENT_MATCH = 46`

`OWN_ROW_CONTENT_MISMATCH = 0`

`CROSS_ROW_ANALYSIS_GROUPS = 0 DIFFERENT_LOGICAL_MESSAGE groups; both same-logical groups were separately reviewed`

`DIFFERENT_LOGICAL_GROUPS_CROSS_ROW_ANALYZED = ALL (0 of 0; complete empty set)`

`CROSS_ROW_FINGERPRINT_MATCHES = 0`

`CROSS_ROW_FINGERPRINT_SOURCE_ROWS = 0`

`CROSS_ROW_FINGERPRINT_TARGET_ROWS = 0`

`ORDINARY_MESSAGE_VICTIM_CANDIDATE_ROWS = 0`

`ORDINARY_MESSAGE_VICTIM_ROWS = 0`

`SYSTEM_MESSAGE_VICTIM_ROWS = 0`

The carried-forward isolated formatter probe executed 4,004 calls across locale
and null variants. Outputs were stable; inputs were not mutated; and clock,
randomness, and network guards were not triggered. In addition to the 46/46
system-message own-row matches, all 913 rows with a deterministic ordinary-message
original in their own raw payload matched that original. The remaining 608 rows
are not formatter-oracle mismatches; the applicable deterministic oracle is simply
not proven for their message types.

================================
I. BLAST RADIUS / CROSS-ROW ATTRIBUTION
================================

`BENIGN_SAME_LOGICAL_BLAST_RADIUS = 4 rows across 2 duplicated IDs`

`DANGEROUS_DIFFERENT_LOGICAL_BLAST_RADIUS = 0 rows`

`NOT_PROVEN_BLAST_RADIUS = 0 rows`

`TRUE_DAMAGE_CANDIDATE_ROWS = 0`

`CROSS_ROW_FINGERPRINT_MATCHES = 0`

`FINGERPRINT_WITH_PROVEN_BACKFILL_CAUSALITY = 0`

`FINGERPRINT_WITH_PLAUSIBLE_CAUSALITY = 0`

`ORDINARY_MESSAGE_VICTIM_ROWS = 0`

`CAUSAL_ATTRIBUTION_TO_BACKFILL = NOT_PROVEN`

`EVIDENCE = There is no different-logical duplicate group, no formatter-eligible source inside either same-logical group, no cross-row fingerprint, and no true damage candidate in the preserved population.`

The unscoped statement is a proven defect and is reachable at startup, but defect
existence is not treated as proof of a historical corrupting event. With no
different-logical collision population and no fingerprint match, there is no
event to attribute causally.

================================
J. HISTORICAL DAMAGE
================================

`PROVEN_DAMAGED_ROWS = 0`

`PROVEN_NOT_DAMAGED_ROWS = 959 within deterministic content-consistency oracles (46 system-message rows plus 913 ordinary-message rows)`

`INDETERMINATE_ROWS = 0 within the suspect-backfill true-damage candidate population`

`HISTORICAL_DAMAGE_OCCURRED = NOT_PROVEN`

`EVIDENCE = 46/46 own-row formatter results and 913/913 ordinary deterministic originals match current content; all duplicate groups are same-logical; dangerous and not-proven duplicate groups are zero; cross-row fingerprints and true damage candidates are zero.`

The 608 rows without one of the two deterministic content oracles are not counted
as damaged, recovered, or globally proven unchanged. They are also not
indeterminate collision victims because none belongs to a different-logical or
unclassified duplicate-ID group. The conclusion is scoped to the suspect backfill
and available preserved evidence; it does not assert that every possible historic
failure from every cause is impossible.

================================
K. RECOVERABILITY
================================

`SYSTEM_MESSAGE_PROVEN_DAMAGED_ROWS = 0`

`SYSTEM_MESSAGE_OWN_RAW_JSON_RECOVERABLE = 0 of 0 required; the deterministic own-row method is proven for 46 applicable intact rows`

`ORDINARY_MESSAGE_PROVEN_DAMAGED_ROWS = 0`

`ORDINARY_MESSAGE_DETERMINISTIC_RECOVERABLE = 0 of 0 required; 913 intact rows retain a matching deterministic original`

`ORDINARY_MESSAGE_UNRECOVERABLE = 0`

`OTHER_DETERMINISTIC_RECOVERABLE_ROWS = 0`

`INDETERMINATE_RECOVERY_ROWS = 0`

`FULL_RECOVERY_DETERMINISM = YES for the empty proven-damage set; no data repair is required`

`RECOVERY_SOURCES = own raw_json formatter output, deterministic ordinary-message original, immutable raw DB/WAL state, then historical backups if a future authorized repair contract establishes a damaged row`

Three historical database backups were inventoried by filename, timestamp, size,
and SHA-256 without opening them. They were not materially required because there
is no dangerous collision or damage candidate. The live database was not compared;
the immutable STAB-02 raw state remains primary evidence.

Backup inventory (filesystem metadata and hash only; `OPENED_BY_SQLITE = NO`):

- `data/zalo-p9-pre-migration-20260827-024037.db`, 1,867,776 bytes,
  SHA-256 `B8B31B3563331B7A20B5C916A54320970C8872CB07DBB25BC58264B710AC2EDB`.
- `data/zalo-uat-backup-20260826-004531.db`, 1,355,776 bytes,
  SHA-256 `5AA30E5E67D80B46979B616C9A5C3EA4C2DEA611F9A35E424B6C00D29EBD3C75`.
- `data/zalo-uat-step4-7-backup-20260826-013730.db`, 1,355,776 bytes,
  SHA-256 `D1FBA92CD9FD144C15E5B9002A9DF5B220BCE929B726882FC5E047EE92C8AC51`.

================================
L. CANONICAL DAMAGE CLASSIFICATION
================================

`FINAL_DAMAGE_CLASSIFICATION = NO_EVIDENCE_OF_DAMAGE`

`RATIONALE = The immutable raw evidence passed every hash gate; SQLite integrity and foreign-key checks are clean; all duplicated IDs are benign same-logical groups; no group has an eligible backfill source; both deterministic content-oracle populations match; and there are zero cross-row fingerprints, victim rows, or true damage candidates.`

This classification is evidence-bounded. It does not excuse the proven unscoped
update, and it does not convert the absence of preserved damage evidence into a
claim that the defective statement is safe.

================================
M. BUSY TIMEOUT
================================

`BUSY_TIMEOUT_DECISION = SET_CANONICAL_VALUE_LATER`

`TARGET_CONNECTION_SITES = lib/db.js:76; lib/db.js:1700; sao-luu/chup-csdl.js:12; sao-luu/kiem-tra-csdl.js:11; sao-luu/kiem-tra-giai-ma.js:20`

`SOURCE_CHANGE_PERFORMED = NO`

The inspected connection reported the SQLite default/implicit
`busy_timeout = 1000 ms`. No explicit canonical timeout was found at the listed
connection sites. Selection and implementation of the canonical value remain for
an authorized repair contract.

================================
N. TEST COVERAGE
================================

`DUPLICATE_ID_COVERAGE = NO_COVERAGE`

`SAME_LOGICAL_MESSAGE_COVERAGE = NO_COVERAGE`

`DIFFERENT_LOGICAL_COLLISION_COVERAGE = NO_COVERAGE`

`BACKFILL_SCOPE_COVERAGE = NO_COVERAGE`

`ORDER_DEPENDENCE_COVERAGE = NO_COVERAGE`

`CROSS_ROW_FINGERPRINT_COVERAGE = NO_COVERAGE`

`ORDINARY_MESSAGE_VICTIM_COVERAGE = NO_COVERAGE`

`RAW_JSON_ORACLE_COVERAGE = NO_COVERAGE`

`FK_COVERAGE = NO_COVERAGE`

`GAPS = No direct behavioral test covers composite message identity across threads, same- versus different-logical duplicate groups, thread-scoped backfill mutation, unordered final-writer behavior, cross-row/ordinary-victim fingerprints, own-row recovery oracles, or runtime FK enforcement and orphan rejection.`

Existing owner-isolation and training-migration tests do not exercise these
message/backfill behaviors. Future tests must include a duplicated `id` in two
threads with distinct logical messages and assert that only the intended composite
identity can be mutated.

================================
O. REQUIRED FOLLOW-UP
================================

`SOURCE_REPAIR_REQUIRED = YES`

`SCHEMA_REPAIR_REQUIRED = NO`

`DATA_REPAIR_REQUIRED = NO`

`TEST_REPAIR_REQUIRED = YES`

`REPAIR_CONTRACT_REQUIRED = YES`

`REPAIR_SCOPE = Scope backfill SELECT/UPDATE to canonical (thread_id,id); explicitly enable foreign_keys on runtime connections; select and set the canonical busy_timeout; add direct collision, scope, ordering, oracle, FK, and orphan tests. Preserve the existing composite messages primary key. No data rewrite is indicated by STAB-01 evidence.`

`IMPLEMENTATION_AUTHORITY = NONE`

No production source, schema, migration, or data was changed under this forensic
contract.

================================
P. REGRESSION
================================

`REGRESSION_ENVIRONMENT = STAGE_0D_CONTAINERIZED`

`TOTAL_AUTOMATED_SAFE = 10`

`PASS = 10`

`FAIL_KNOWN = 0`

`FAIL_UNKNOWN = 0`

`TIMEOUT = 0`

`ENVIRONMENT_BLOCKED = 0`

`CANONICAL_TEST_RUNNER_PASS = YES`

The post-forensic canonical run started at
`2026-08-27T20:40:24.2993300+07:00`, completed at
`2026-08-27T20:40:33.2942214+07:00`, and exited zero. All ten suites passed:
AI action boundary, AI default, AI model source, onboarding, teach bot, chat
attachment, P9 owner profile, P9-17 model save, phone direct message, and zoom.
The run used the accepted Stage 0D image with no network, no repository mount,
read-only root, tmpfs, capability drop, and no-new-privileges. No real external
action was performed.

================================
Q. SAFETY
================================

`PRODUCTION_SOURCE_CHANGED = NO`

`DATA_REPAIR_PERFORMED = NO`

`SCHEMA_CHANGED = NO`

`MIGRATION_EXECUTED = NO`

`IMMUTABLE_RAW_DB_MODIFIED = NO`

`IMMUTABLE_RAW_WAL_MODIFIED = NO`

`IMMUTABLE_RAW_SHM_MODIFIED = NO`

`SENSITIVE_DB_EVIDENCE_INSIDE_REPO = NO`

`REAL_EXTERNAL_ACTION = NO`

`COMMIT = NO`

`PUSH = NO`

`VPS = NO`

All database artifacts, the working forensic copy, the analysis script, and the
sanitized machine-readable summary remain outside the repository. Only this
sanitized Markdown report is stored inside the repository.

================================
R. ACCEPTANCE
================================

`STAB_01A = PASS`

`STAB_01B = PASS`

`STAB_01 = PASS`

STAB-01A passes because canonical identity, mutation scope, structural integrity,
FK/orphan state, and connection-policy gaps are evidenced. STAB-01B passes because
the immutable source was hash-verified, every duplicate group was classified, all
applicable own-row and cross-row analyses completed, recoverability was assessed,
and exactly one canonical damage classification was selected.

================================
S. NEXT BOUNDARY
================================

`STAB_01_CLOSED = NO`

`STAB_01_CLOSURE_CANDIDATE = YES`

`NEXT = WAIT FOR PO / BU REVIEW`

`SOURCE_REPAIR_REQUIRED = YES`

`SCHEMA_REPAIR_REQUIRED = NO`

`DATA_REPAIR_REQUIRED = NO`

`TEST_REPAIR_REQUIRED = YES`

`IMPLEMENTATION_AUTHORITY = NONE`

STAB-01 stops at the evidence and documentation boundary. A later, explicitly
authorized repair contract is required before changing production source, runtime
connection policy, tests, schema, migration, or data.

================================
T. PO / BU CLOSURE DECISION
================================

DECISION_ID =
PD-STAB-01-CLOSURE-01

DECISION_DATE =
2026-08-27

PRIOR_REPORT_STATE =
STAB_01_CLOSURE_CANDIDATE = YES
STAB_01_CLOSED = NO

PO_BU_REVIEW =
PASS

STAB_01A =
PASS

STAB_01B =
PASS

FINAL_DAMAGE_CLASSIFICATION =
NO_EVIDENCE_OF_DAMAGE

STAB_01_CLOSED =
YES

CARRY_FORWARD_STAB_01_SOURCE_REPAIR =
OPEN

CARRY_FORWARD_STAB_01_TEST_REPAIR =
OPEN

DATA_REPAIR_REQUIRED =
NO

SCHEMA_REPAIR_REQUIRED =
NO

THIS_SECTION =
SUBSEQUENT_CLOSURE_RECORD

HISTORICAL_SECTION_S =
PRESERVED_UNCHANGED
