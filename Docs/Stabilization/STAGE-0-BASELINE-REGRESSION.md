# STAGE 0B — Canonical Regression Runner & Baseline Snapshot

```text
DATE = 2026-08-27
CANONICAL_RUNNER = kiem-thu/chay-hoi-quy-stage-0.js
ENTRY_COMMAND = node kiem-thu/chay-hoi-quy-stage-0.js
PACKAGE_JSON_CHANGED = NO
DEPENDENCY_CHANGED = NO
```

## Test discovery result

`package.json` has only `start` and `dev`; no prior `test` or canonical regression command existed. Directories `scripts/`, `test/`, and `tests/` do not exist. Discovery covered `kiem-thu/`, `sao-luu/`, `*.test.*`, `*.spec.*`, `kiem-tra-*`, `verify-*`, `check-*`, child processes, HTTP listeners, browser harnesses, Docker/runtime commands, and manual helpers.

```text
EXISTING_TEST_OR_HARNESS_ENTRYPOINTS = 15
AUTOMATED_SAFE = 10
MANUAL_ONLY = 3
SERVER_OR_HARNESS = 3
NOT_AUTHORIZED = 2
NEW_CANONICAL_RUNNER = 1
```

`npm start`, `npm run dev`, `docker compose up`, and the app Dockerfiles are runtime entrypoints, not automated tests. They were not started because they may touch canonical DB/session state.

## Automated suite inventory

All network entries below mean loopback fixture or injected in-memory adapter only; none permits external network.

| Suite ID | Path / command | Purpose | Dependencies | Runtime | DB | Browser | Network | Real Zalo | Mutates data | Self-terminates | Duration class | Currently runnable |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AI_ACTION_BOUNDARY | `node kiem-thu/kiem-tra-ai-action-boundary.js` | P2 settings action/source boundary | Node stdlib | Node | NO | NO | NO | NO | NO | YES | SHORT | YES |
| AI_DEFAULT | `node kiem-thu/kiem-tra-ai-default.js` | P1 model default/effective config | native `sqlite3`, local HTTP fixture | Node | TEMP_ONLY | NO | LOOPBACK_ONLY | NO | TEMP_ONLY | YES | SHORT | ENVIRONMENT_BLOCKED |
| AI_MODEL_SOURCE | `node kiem-thu/kiem-tra-ai-model-source.js` | P7 canonical model source across consumers | native `sqlite3`, local HTTP fixture | Node | TEMP_ONLY | NO | LOOPBACK_ONLY | NO | TEMP_ONLY | YES | SHORT | ENVIRONMENT_BLOCKED |
| ONBOARDING | `node kiem-thu/kiem-tra-onboarding.js` | Onboarding Steps 0–9 and injected model boundary | native `sqlite3`, local HTTP fixture | Node | TEMP_ONLY | NO | LOOPBACK_ONLY | NO | TEMP_ONLY | YES | MEDIUM | ENVIRONMENT_BLOCKED |
| TEACH_BOT | `node kiem-thu/kiem-tra-day-po.js` | Owner instruction, persistence, confirmation and restart behavior | native `sqlite3`, local HTTP fixture, child Node | Node | TEMP_ONLY | NO | LOOPBACK_ONLY | NO | TEMP_ONLY | YES | MEDIUM | ENVIRONMENT_BLOCKED |
| CHAT_ATTACHMENT | `node kiem-thu/kiem-tra-chat-attachment.js` | MEDIA parsing/adapter and source contracts | Node stdlib + current modules | Node | NO | NO | NO | NO | NO | YES | SHORT | YES |
| P9_OWNER_PROFILE | `node kiem-thu/kiem-tra-p9-owner-profile.js` | Owner isolation and P9 migration behavior | native `sqlite3` | Node | TEMP_ONLY | NO | NO | NO | TEMP_ONLY | YES | MEDIUM | ENVIRONMENT_BLOCKED |
| P9_17_MODEL_SAVE | `node kiem-thu/kiem-tra-p9-17-model-save.js` | Extracted model-save handler behavior/source shape | Node stdlib, VM | Node | NO | NO | FAKE_FETCH_ONLY | NO | NO | YES | SHORT | YES |
| PHONE_DIRECT_MESSAGE | `node kiem-thu/kiem-tra-phone-direct-message.js` | Phone parser, preview/OK/send boundary and routing | Node built-in SQLite shim in temp preload | Child Node | TEMP_ONLY | NO | INJECTED_ONLY | NO | TEMP_ONLY | YES | MEDIUM | YES |
| ZOOM | `node kiem-thu/kiem-tra-zoom.js` | Zoom config/provider adapter/admin/UI behavior | native `sqlite3`, injected network adapter | Node | TEMP_ONLY | NO | INJECTED_ONLY | NO | TEMP_ONLY | YES | LONG | ENVIRONMENT_BLOCKED |

Isolation proof: DB-using suites create an OS temp directory, create `<temp>/data`, then call `process.chdir(temp)` before importing `lib/db.js`. `P9_OWNER_PROFILE` passes explicit temp DB paths. `PHONE_DIRECT_MESSAGE` writes only a temp preload shim and temp DB. Source-only suites never import the DB. No canonical or backup `.db` path is passed to any suite.

## Manual browser harness inventory and port policy

| Harness | Entry command | Port | Requires browser | Server/harness | Self-terminates | Automated runner |
|---|---|---:|---|---|---|---|
| P2 | `node kiem-thu/p2-browser-server.js` + `p2-browser-harness.html` | 3791 | YES | YES | NO | EXCLUDED |
| P7 | `node kiem-thu/p7-browser-server.js` + `p7-browser-harness.html` | 3792 | YES | YES | NO | EXCLUDED |
| P9.15 | `node kiem-thu/p9-15-browser-server.js` + `p9-15-browser-harness.html` | 3792 | YES | YES | NO | EXCLUDED |

Both P7 and P9.15 bind `127.0.0.1:3792`, so concurrent startup has a proven collision. They are `MANUAL_ONLY / HARNESS`, must be started one at a time, and are never included in the finite automated runner. No harness was started during Stage 0.

## DB/backup utilities excluded by hard boundary

| Path | Behavior | Classification | Stage 0 result |
|---|---|---|---|
| `sao-luu/kiem-tra-csdl.js <db>` | Opens supplied SQLite DB and runs `PRAGMA integrity_check`/queries | DB verification helper | NOT_AUTHORIZED |
| `sao-luu/kiem-tra-giai-ma.js <db>` | Opens supplied SQLite DB and tests decryption | DB/secret verification helper | NOT_AUTHORIZED |
| `sao-luu/chup-csdl.js` | Opens canonical DB and performs `VACUUM INTO` | Mutating backup utility, not a test | PROHIBITED / NOT_RUN |

## Runner contract

The runner executes suites sequentially, streams child stdout/stderr unchanged, records exact child exit code/signal/duration, and prints a final summary. It has no shell invocation and no test-semantic rewrite.

| Suite | Timeout |
|---|---:|
| AI_ACTION_BOUNDARY | 15 s |
| AI_DEFAULT | 30 s |
| AI_MODEL_SOURCE | 30 s |
| ONBOARDING | 45 s |
| TEACH_BOT | 60 s |
| CHAT_ATTACHMENT | 20 s |
| P9_OWNER_PROFILE | 45 s |
| P9_17_MODEL_SAVE | 15 s |
| PHONE_DIRECT_MESSAGE | 90 s |
| ZOOM | 120 s |

Native `sqlite3` is preflighted without opening a database. If unavailable, affected suites are explicitly reported `ENVIRONMENT_BLOCKED` and `NOT_RUN`; they are not silently skipped or converted to PASS.

## Baseline snapshot

Environment:

```text
NODE = v24.18.0
PLATFORM = win32
ARCH = arm64
NODE_MODULE_ABI = 137
SQLITE3_NATIVE_BINDING = UNAVAILABLE
BLOCKER = Could not locate the bindings file
```

Canonical run result:

| Suite | Raw result | Exit | Duration | Baseline classification |
|---|---|---:|---:|---|
| AI_ACTION_BOUNDARY | PASS | 0 | 116 ms | BASELINE_PASS |
| AI_DEFAULT | ENVIRONMENT_BLOCKED | NOT_RUN | 0 ms | NOT_RUN_ENVIRONMENT_BLOCKED |
| AI_MODEL_SOURCE | ENVIRONMENT_BLOCKED | NOT_RUN | 0 ms | NOT_RUN_ENVIRONMENT_BLOCKED |
| ONBOARDING | ENVIRONMENT_BLOCKED | NOT_RUN | 0 ms | NOT_RUN_ENVIRONMENT_BLOCKED |
| TEACH_BOT | ENVIRONMENT_BLOCKED | NOT_RUN | 0 ms | NOT_RUN_ENVIRONMENT_BLOCKED |
| CHAT_ATTACHMENT | PASS (36/36) | 0 | 118 ms | BASELINE_PASS |
| P9_OWNER_PROFILE | ENVIRONMENT_BLOCKED | NOT_RUN | 0 ms | NOT_RUN_ENVIRONMENT_BLOCKED |
| P9_17_MODEL_SAVE | PASS (5/5) | 0 | 112 ms | BASELINE_PASS |
| PHONE_DIRECT_MESSAGE | PASS (80/80) | 0 | 36,155 ms | BASELINE_PASS |
| ZOOM | ENVIRONMENT_BLOCKED | NOT_RUN | 0 ms | NOT_RUN_ENVIRONMENT_BLOCKED |

```text
PASS = 4
FAIL_KNOWN = 0
FAIL_UNKNOWN = 0
TIMEOUT = 0
ENVIRONMENT_BLOCKED = 6
MANUAL_ONLY = 3
NOT_AUTHORIZED = 2
UNKNOWN_RED_REGRESSION = NO
```

An initial runner probe let the six native-DB suites start; each exited immediately while loading the same missing `sqlite3` binding, before opening even a temporary DB or reaching assertions. The runner was then minimally corrected to preflight that dependency and emit `ENVIRONMENT_BLOCKED`. No assertion, production source, dependency, or suite exit semantics were changed.

The optional `@napi-rs/canvas` native binding also produced a warning in PHONE_DIRECT_MESSAGE, but the suite's inert DOM shim is intentional and all 80 assertions passed; this warning is not a red result.

## Stage 0B acceptance

```text
ALL_DISCOVERED_TEST_ENTRYPOINTS_INVENTORIED = YES
CANONICAL_RUNNER = CREATED
AUTOMATED_RUNNER_HAS_FINITE_TIMEOUT = YES
PERSISTENT_SERVER_HARNESSES_EXCLUDED = YES
PORT_3792_COLLISION_POLICY = DOCUMENTED
BASELINE_SNAPSHOT = RECORDED
UNKNOWN_RED_REGRESSION = NO
STAGE_0B = PASS
```

The six environment-blocked suites remain unproven on this host. Stage 0 does not authorize rebuilding/installing dependencies, and no such action was taken.

## Open items before STAB-02

```text
CANONICAL_TEST_RUNNER_PASS_DEFINITION = OPEN
```

Evidence: `kiem-thu/chay-hoi-quy-stage-0.js` returns a non-zero overall process status when one or more suites are `ENVIRONMENT_BLOCKED`. The recorded baseline has `ENVIRONMENT_BLOCKED = 6`, so the canonical meaning of `CANONICAL_TEST_RUNNER_PASS` is not yet closed. This documentation correction does not change runner or test logic.

```text
STAGE_0D_CONTAINERIZED_BASELINE = OPEN
```

Proposed purpose: run the six currently blocked suites in an environment with a working native `sqlite3` binding before DB-related stabilization work. Target would be `ENVIRONMENT_BLOCKED: 6 → 0` if the environment supports it.

```text
STAGE_0D_EXECUTION = NOT_AUTHORIZED
CONTAINER_BUILD_OR_START = NOT_PERFORMED
DEPENDENCY_CHANGE = NOT_PERFORMED

STAGE_0A = TECHNICALLY_PASS
STAGE_0B = TECHNICALLY_PASS_WITH_ENVIRONMENT_BLOCKED_BASELINE
STAGE_0C = PASS
STAGE_0_DOCUMENTATION_CLOSURE = PASS

STAGE_0_CLOSED = NO
STAB_02_IMPLEMENTATION = NOT_AUTHORIZED
```

## Containerized baseline — Stage 0D addendum

The host baseline above is preserved as the authoritative Windows ARM64 observation. Stage 0D was subsequently authorized and executed in a clean-room Linux ARM64 container using the same Node v24.18.0 runtime precedent and the existing `package-lock.json`.

```text
HOST_BASELINE =
PASS = 4
FAIL_KNOWN = 0
FAIL_UNKNOWN = 0
TIMEOUT = 0
ENVIRONMENT_BLOCKED = 6

CONTAINERIZED_BASELINE =
PASS = 9
FAIL_KNOWN = 1
FAIL_UNKNOWN = 0
TIMEOUT = 0
ENVIRONMENT_BLOCKED = 0
ALL_AUTOMATED_SAFE_SUITES_EXECUTED = YES
```

The six previously blocked suites all executed, so `ENVIRONMENT_RECOVERY = PASS`. The one known failure is ZOOM assertion `P2E-X06`: its regular schedule fixture is hard-coded to 2026-08-26 and had expired by the 2026-08-27 run. No test or production source was changed.

```text
CANONICAL_TEST_RUNNER_PASS = HOLD_FOR_KNOWN_FAILURE_REVIEW
CANONICAL_TEST_RUNNER_PASS_DEFINITION = CLOSED_BY_STAGE_0D_CONTRACT
STAGE_0D = HOLD
STAGE_0_CLOSURE_CANDIDATE = NO
STAGE_0_CLOSED = NO
STAB_02_STARTED = NO
```

Full isolation, execution, freeze, and safety evidence is recorded in `Docs/Stabilization/STAGE-0D-CONTAINERIZED-BASELINE.md`.

## Zoom time-fixture correction and post-correction baseline

The Stage 0D HOLD snapshot immediately above remains historical. A later, separately authorized test-fixture-only correction removed the wall-clock expiry from `ZOOM / P2E-X06` without modifying production behavior or assertions.

```text
ZOOM_TIME_FIXTURE_CORRECTION = PASS
OLD_FIXTURE = hard-coded 2026-08-26 20:00
NEW_FIXTURE = controlled MOC_P2C + 2 local calendar days at 20:00
ABSOLUTE_LATER_DATE_USED = NO
ASSERTION_SEMANTICS_CHANGED = NO
PRODUCTION_SOURCE_CHANGED = NO
```

Focused result:

```text
P2E_X06 = PASS
ZOOM_SUITE = 404/404 PASS
REAL_ZOOM_CALLS = 0
```

Post-correction canonical result:

```text
POST_CORRECTION_BASELINE =
TOTAL_AUTOMATED_SAFE = 10
PASS = 10
FAIL_KNOWN = 0
FAIL_UNKNOWN = 0
TIMEOUT = 0
ENVIRONMENT_BLOCKED = 0
ALL_AUTOMATED_SAFE_SUITES_EXECUTED = YES

CANONICAL_TEST_RUNNER_PASS = YES
STAGE_0D = PASS
STAGE_0_CLOSURE_CANDIDATE = YES
STAGE_0_CLOSED = NO
STAB_02_STARTED = NO
NEXT = WAIT FOR PO / BU REVIEW
```

Detailed root-cause, freeze, container, and safety evidence is appended under `ZOOM_TIME_FIXTURE_CORRECTION` and `POST_CORRECTION_BASELINE` in `Docs/Stabilization/STAGE-0D-CONTAINERIZED-BASELINE.md`.
