# STAB-03 — AI CONFIGURATION CONTRACT CLOSURE REPORT

```text
CONTRACT_ID = PD-STAB-03-AI-CONFIG-MODEL-PROVIDER-01
CORRECTIONS = ROUND_4
DATE = 2026-08-27
RESULT = PASS
```

## A. Scope and authority

STAB-03 was limited to the AI configuration read/write boundary. It did not
change the server bootstrap, route architecture, schema, migration, provider
runtime, Zalo login, or canonical database.

```text
SERVER_BOOTSTRAP_REFACTOR = NOT_AUTHORIZED_AND_NOT_DONE
APP_LISTEN_EXTRACTION = NOT_AUTHORIZED_AND_NOT_DONE
NEW_DEPENDENCY_INJECTION_ARCHITECTURE = NOT_AUTHORIZED_AND_NOT_DONE
NEW_ROUTE_TEST_FRAMEWORK = NOT_AUTHORIZED_AND_NOT_DONE
SCHEMA_CHANGE = NO
MIGRATION = NO
NEW_DEPENDENCY = NO
```

The worktree already contained uncommitted changes in the target files before
STAB-03. This package applied narrow patches only and did not reset, replace, or
reformat unrelated work.

## B. STAB03_TESTABILITY_PRECHECK

The precheck ran before any production edit.

| Check | Result | Evidence |
|---|---|---|
| `SERVER_IMPORT_STARTS_LISTENER` | `YES` | `server.js` performs top-level DB initialization and later calls `server.listen(...)`. Importing it is not a safe handler test. |
| `OWNER_CONTEXT_INJECTABLE_AT_ROUTE_LAYER` | `NO` | The route directly calls the imported `chuHienTai()`; there is no route-level owner fixture input. |
| `EXISTING_CALLABLE_ROUTE_HANDLER_SEAM` | `NO` | The `/api/ai-chat` callback and Express app are local to `server.js` and are not exported. |
| `ISOLATED_HTTP_HARNESS_WITHOUT_PRODUCT_EDIT` | `NO` | There is no existing way to import the route without initialization/listen or replace the owner resolver. |

```text
STAB03_TESTABILITY_PRECHECK = COMPLETE
DEFECT_A_PROOF_MODE = CONTROL_FLOW_PLUS_ISOLATED_BEHAVIOR
```

Mode C was selected instead of adding a production seam solely for test
convenience. No HTTP failure claim was made without a valid synthetic owner.

```text
VALID_SYNTHETIC_OWNER_CONTEXT = YES
HTTP_400_OBSERVED = NOT_REQUIRED_FOR_MODE_C
REAL_ZALO_LOGIN_FOR_STAB03 = NO
```

## C. Phase A — pre-fix proof

### C1. DEFECT_A exact control-flow proof

The pre-edit route trace captured this exact order:

1. `ownerUid` was resolved through `chuHienTai()`.
2. The missing-owner guard ran first.
3. Request fields were read, including `opencodeBaseUrl`.
4. The OpenCode URL guard ran unconditionally.
5. Only afterward did the `saveScope === "ai-connection"` branch run.
6. Assistant-specific Soul/Topics validation and the assistant persistence call
   occurred later still.

Therefore, under a logically valid owner context, an assistant/profile save
without `opencodeBaseUrl` was rejected before assistant-specific behavior could
execute. The proof harness checks the route block and the relative positions of
every node above; it is not a string-presence-only grep.

```text
DEFECT_A_PRE_FIX_PROOF = PROVEN
```

### C2. DEFECT_B source and isolated behavioral proof

The pre-edit trace was:

```text
assistant form submit
-> opencodeBaseUrl / opencodeAgent included in JSON
-> /api/ai-chat assistant branch
-> both fields forwarded to saveAiChatConfig
-> saveAiChatConfig UPDATE ai_runtime_config
```

The persistence mechanism remains visible in `lib/db.js`: when either global
field is defined, `saveAiChatConfig` updates `ai_runtime_config`. In an isolated
temporary DB, with owner `OWNER_A_TEST`, initial values were set to:

```text
opencode_base_url = http://runtime-initial.invalid:4096
opencode_agent = agent-initial
```

Calling the actual persistence function with the same empty global fields that
the pre-fix assistant path forwarded produced:

```text
opencode_base_url = ""
opencode_agent = "general"
```

The original global values were therefore erased/replaced by an unrelated
assistant/profile save.

```text
DEFECT_B = PROVEN
EMPTY_STRING_GLOBAL_ERASURE_MECHANISM = PROVEN
EMPTY_STRING_PROOF_USED_ISOLATED_TEST_DB = YES
LIVE_HTTP_ERASURE_PROOF_ATTEMPTED = NO
SOURCE_EDIT_AUTHORITY = ACTIVE
```

## D. Minimal repair

### `server.js`

- The OpenCode URL guard now lives inside the explicit
  `saveScope === "ai-connection"` branch (`server.js:617-618`).
- The assistant/profile persistence call forwards owner fields including
  `opencodeModel`, but not `opencodeBaseUrl` or `opencodeAgent`
  (`server.js:669-672`).
- Assistant change detection no longer treats the global agent as an assistant
  field (`server.js:684-689`).
- Session cleanup uses the already-loaded canonical configuration `truoc`
  instead of assistant request fields (`server.js:694`).

### `public/config.js`

The assistant form submit begins at `public/config.js:835`. Its JSON payload now
starts with owner-scoped `opencodeModel` and assistant fields at lines 854 onward;
it does not send `opencodeBaseUrl` or `opencodeAgent`.

### Persistence boundary

`lib/db.js` was not changed by STAB-03. The existing explicit global persistence
mechanism remains available for the `ai-connection` action. This preserves the
verified schema boundary:

```text
OWNER-SCOPED = ai_chat_config.opencode_model
INSTALLATION-GLOBAL = ai_runtime_config.opencode_base_url, ai_runtime_config.opencode_agent

OWNER_DATA_LOSS_FROM_OMISSION = NO
GLOBAL_BOUNDARY_RESTORED = YES
NEW_PER_OWNER_GLOBAL_FIELDS = NO
```

## E. Phase C — post-fix proof

Because there is still no safe callable route seam, verification stayed at the
highest authorized level: exact server control-flow verification plus the real
persistence function on a temporary isolated database.

| Assistant request variant | Profile save | Global URL | Global agent | Result |
|---|---|---|---|---|
| fields absent | succeeded | unchanged | unchanged | `PASS` |
| fields equal `""` | succeeded | unchanged | unchanged | `PASS` |
| fields contain foreign values | succeeded | unchanged | unchanged | `PASS` |

The source proof additionally confirms that even if a non-UI caller sends empty
or foreign global fields, the assistant persistence call does not forward them.
An explicit global save was then executed through `saveAiChatConfig` and changed
both isolated global values successfully.

```text
ASSISTANT_SAVE_WRITES_GLOBAL_OPENCODE_BASE_URL = NO
ASSISTANT_SAVE_WRITES_GLOBAL_OPENCODE_AGENT = NO
MISSING_FIELD_VARIANT = PASS
EMPTY_STRING_VARIANT = PASS
FOREIGN_VALUE_VARIANT = PASS
EXPLICIT_GLOBAL_OPENCODE_SAVE = PASS
```

## F. Regression verification

| Suite | Result |
|---|---:|
| `kiem-tra-stab-03-ai-config-contract.js post` | `PASS` |
| `AI_ACTION_BOUNDARY` | `5/5 PASS` |
| `AI_DEFAULT` | `8/8 PASS` |
| `AI_MODEL_SOURCE` | `7/7 PASS` |
| `ONBOARDING` | `36/36 PASS` |
| `P9_OWNER_PROFILE` | `7/7 PASS` |
| `P9_17_MODEL_SAVE` | `5/5 PASS` |

All provider counters reported zero real provider/model calls. Existing local
metadata fixtures were allowed to bind loopback only; the production app was
never started.

### Host runtime note

The default host is Node 24 ARM64, while the checked-in native `sqlite3` binding
is unavailable for that architecture. Docker Desktop was not running, and it
was not started. Test-only preload files use the built-in `node:sqlite` engine to
provide the callback subset used by `lib/db.js`; they also supply import-time DOM
guards required after the optional PDF canvas binding fails. No production file
imports these helpers, no dependency was installed, and test assertions were
not changed to conceal failures.

All `os.tmpdir()`-based affected suites were run with `TEMP` and `TMP` redirected
to a unique directory below the repository. Each generated directory was
validated and deleted after its process exited.

## G. Safety and closure markers

```text
STAB03_TESTABILITY_PRECHECK = COMPLETE
DEFECT_A_PRE_FIX_PROOF = PROVEN
DEFECT_A_PROOF_MODE = CONTROL_FLOW_PLUS_ISOLATED_BEHAVIOR

DEFECT_B = PROVEN_AND_REPAIRED
EMPTY_STRING_GLOBAL_ERASURE_MECHANISM = PROVEN

API_OR_MODULE_TESTS_USED_ISOLATED_TEST_DB = YES
CANONICAL_DB_WRITTEN_BY_STAB03 = NO
LIVE_RUNNING_APP_USED_FOR_TESTS = NO
REAL_ZALO_LOGIN_USED_FOR_STAB03 = NO
REAL_OPENCODE_SIDE_EFFECT_BY_STAB03_TESTS = NO

ASSISTANT_SAVE_WRITES_GLOBAL_OPENCODE_BASE_URL = NO
ASSISTANT_SAVE_WRITES_GLOBAL_OPENCODE_AGENT = NO
MISSING_FIELD_VARIANT = PASS
EMPTY_STRING_VARIANT = PASS
FOREIGN_VALUE_VARIANT = PASS
EXPLICIT_GLOBAL_OPENCODE_SAVE = PASS

COMMIT = NO
PUSH = NO
VPS = NO
```

## H. Files changed by STAB-03

```text
server.js
public/config.js
kiem-thu/kiem-tra-ai-action-boundary.js
kiem-thu/kiem-tra-stab-03-ai-config-contract.js
kiem-thu/sqlite3-node24-test-adapter.js
kiem-thu/sqlite3-node24-test-register.js
kiem-thu/node24-arm64-test-polyfills.js
Docs/Stabilization/STAB-03-AI-CONFIG-CONTRACT-REPORT.md
```

```text
STAB_03 = PASS
NEXT = WAIT_FOR_PRODUCT_OWNER_DIRECTION
```

================================
FINAL. PO / BU STAB-03 CLOSURE DECISION
================================

```text
DECISION_ID =
PD-STAB-03-CLOSURE-01

DECISION_DATE =
2026-08-27

PRIOR_PACKAGE_STATE =
STAB_03_TECHNICAL_EXECUTION = PASS
STAB_03_CLOSED = NO

PO_BU_FINAL_REVIEW =
PASS

STAB_01_CURRENT_STATE =
CLOSED

DEFECT_A =
PROVEN_AND_REPAIRED

DEFECT_B =
PROVEN_AND_REPAIRED

BLOCKER_A_STATUS =
RESOLVED_BY_PO_BU_DECISION

GLOBAL_WRITE_BOUNDARY_FIXED_BEFORE_OR_ATOMIC_WITH_VALIDATION_RELAXATION =
YES

GLOBAL_WRITE_BOUNDARY_REPAIR_MODE =
ATOMIC_SAME_PATCH_ACTION

ASSISTANT_SAVE_WRITES_GLOBAL_OPENCODE_BASE_URL =
NO

ASSISTANT_SAVE_WRITES_GLOBAL_OPENCODE_AGENT =
NO

MISSING_FIELD_VARIANT =
PASS

EMPTY_STRING_VARIANT =
PASS

FOREIGN_VALUE_VARIANT =
PASS

EXPLICIT_GLOBAL_OPENCODE_SAVE =
PASS

OWNER_ISOLATION =
PASS

MODEL_SOURCE_INTEGRITY =
PASS

PROVIDER_MODEL_INTEGRITY =
PASS

DEFAULT_MODEL_CATALOG_MATCH =
EXACT

P9_17_FINAL_STATUS =
PASS

TEST_HARNESS_REPAIR =
PASS

TEACH_BOT =
74/74 PASS

PHONE_DIRECT_MESSAGE =
80/80 PASS

CANONICAL_TEST_RUNNER_RESULT =
10/10 PASS

CANONICAL_TEST_RUNNER_PASS =
YES

STAB_03_TECHNICAL_EXECUTION =
PASS

STAB_03_CLOSED =
YES

CARRY_FORWARD_STAB_01_SOURCE_REPAIR =
OPEN

CARRY_FORWARD_STAB_01_TEST_REPAIR =
OPEN

BUSY_TIMEOUT_IMPLEMENTATION =
OPEN

DATA_REPAIR_REQUIRED_BY_STAB_03 =
NO

SCHEMA_REPAIR_REQUIRED_BY_STAB_03 =
NO

THIS_SECTION =
SUBSEQUENT_PO_BU_CLOSURE_RECORD

HISTORICAL_REPORT_CONTENT =
PRESERVED_UNCHANGED
```
