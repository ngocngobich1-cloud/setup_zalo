# STAGE 0D CONTAINERIZED BASELINE REPORT

```text
CONTRACT_ID = PD-STAB-STAGE0D-CONTAINERIZED-BASELINE-01
DATE = 2026-08-27
RESULT = HOLD
```

Stage 0D recovered the blocked native environment and executed every automated-safe suite. One reproducible, time-dependent test-fixture failure remains in ZOOM, so the canonical runner cannot be declared PASS without PO/BU review.

## A. Verified authority

```text
CANONICAL_PLAN = Docs/Stabilization/ZALO-WEB-STABILIZATION-PLAN-01 — V2.1.md
STAGE_0D_AUTHORIZED = YES
STAB_02_AUTHORIZED = NO
PRODUCTION_REPAIR_AUTHORIZED = NO
```

The three required Stage 0 artifacts and `kiem-thu/chay-hoi-quy-stage-0.js` were present and reviewed before execution.

## B. Previous blocked suites

```text
TOTAL = 6
BLOCK_REASON_BEFORE = Windows ARM64 Node v24.18.0 ABI 137 could not load the sqlite3 native binding
```

| # | Suite | Entrypoint | Previous reason | Safe isolated DB |
|---:|---|---|---|---|
| 1 | AI_DEFAULT | `kiem-thu/kiem-tra-ai-default.js` | Native `sqlite3` binding only | YES — `/tmp/ai-default-p1-*` |
| 2 | AI_MODEL_SOURCE | `kiem-thu/kiem-tra-ai-model-source.js` | Native `sqlite3` binding only | YES — `/tmp/ai-model-source-p7-*` |
| 3 | ONBOARDING | `kiem-thu/kiem-tra-onboarding.js` | Native `sqlite3` binding only | YES — `/tmp/onboarding-model-boundary-*` |
| 4 | TEACH_BOT | `kiem-thu/kiem-tra-day-po.js` | Native `sqlite3` binding only | YES — `/tmp/day-po-*` and child temp DBs |
| 5 | P9_OWNER_PROFILE | `kiem-thu/kiem-tra-p9-owner-profile.js` | Native `sqlite3` binding only | YES — `/tmp/p9-owner-profile-*`, including explicit legacy temp DB paths |
| 6 | ZOOM | `kiem-thu/kiem-tra-zoom.js` | Native `sqlite3` binding only | YES — `/tmp/zoom-*` |

Each suite creates an OS temp directory and changes into it before importing `lib/db.js`; P9 also supplies explicit temporary migration DB paths. No suite references the repository canonical DB. Local HTTP fixtures bind only to `127.0.0.1`; Zoom uses an injected fake network adapter.

## C. Container environment

```text
HOST_NODE = v24.18.0
HOST_PLATFORM = win32
HOST_ARCH = arm64
HOST_ABI = 137

CONTAINER_NODE = v24.18.0
CONTAINER_PLATFORM = linux
CONTAINER_ARCH = arm64
CONTAINER_ABI = 137
SQLITE3_VERSION = 5.1.7
SQLITE3_BINDING_WORKING = YES
```

Runtime selection is evidence-based: the existing production Dockerfile already uses exact image `node:24.18.0`, the project requires Node `>=18`, and the locked dependency is `sqlite3@5.1.7`. The test-only image retained the production precedent and installed build tools before `npm ci`; its build-time and run-time preflights both loaded `sqlite3` successfully.

```text
CONTAINER_STRATEGY = test-only Dockerfile plus Dockerfile-specific allowlist
IMAGE = zalo-web-stage0d:2026-08-27
IMAGE_ID = sha256:2691995cdb8e7778ad2940475d99f460cd859c22f1d49088af6cd4786cbbc614
IMAGE_PLATFORM = linux/arm64
IMAGE_USER = node
BUILD_CONTEXT_TRANSFER_AFTER_FINAL_FILTER = 2.73 kB
```

The final image preflight reported:

```text
canonicalDataPresent = false
envPresent = false
manualHarnessPresent = false
sqlite3BindingWorking = true
```

Runtime controls for both test runs were `--network none`, `--read-only`, an ephemeral `/tmp` tmpfs, `--cap-drop ALL`, `no-new-privileges`, no bind mount, and no volume.

## D. Database isolation

```text
CANONICAL_DB_OPENED = NO
CANONICAL_DB_MOUNTED = NO
CANONICAL_DB_COPIED = NO
CANONICAL_BACKUP_DB_OPENED = NO
NO_BIND_MOUNT_TO_HOST_DATA = YES
NO_REFERENCE_TO_CANONICAL_ZALO_DB = YES
TEST_DB_ISOLATION_PROVEN = YES
```

The Stage 0D Dockerfile copies only package manifests, `lib/`, `public/`, the automated test/runner allowlist, and `server.js`. It never copies `data/`, `sao-luu/`, `.env`, deployment state, credentials, or manual harnesses. The production `docker-compose.yml` was not used because it bind-mounts `./data:/app/data`.

Canonical DB filesystem observation (metadata only; no SQLite open/query):

| File | Before size | Before mtime UTC | After size | After mtime UTC |
|---|---:|---|---:|---|
| `data/zalo.db` | 2,424,832 | 2026-08-27T11:38:53.0302042Z | 2,424,832 | 2026-08-27T11:38:53.0302042Z |
| `data/zalo.db-wal` | 4,140,632 | 2026-08-27T11:48:41.8022462Z | 4,140,632 | 2026-08-27T11:59:01.6621814Z |
| `data/zalo.db-shm` | 32,768 | 2026-08-27T11:48:41.8047550Z | 32,768 | 2026-08-27T11:59:01.6638682Z |

The WAL/SHM timestamps changed while the existing host runtime remained outside Stage 0D. This is not attributed to Stage 0D: the container had no host mount/volume, the image contained no canonical data, and all test DBs were created beneath container `/tmp`.

## E. Previously blocked six results

Command inside the isolated image:

```text
node kiem-thu/chay-stage0d-six.js
```

| Suite | Raw result | Exit | Duration | Classified result |
|---|---|---:|---:|---|
| AI_DEFAULT | PASS | 0 | 1,029 ms | PASS |
| AI_MODEL_SOURCE | PASS | 0 | 765 ms | PASS |
| ONBOARDING | PASS | 0 | 243 ms | PASS |
| TEACH_BOT | PASS | 0 | 2,719 ms | PASS |
| P9_OWNER_PROFILE | PASS | 0 | 705 ms | PASS |
| ZOOM | FAIL (403/404 assertions) | 1 | 1,271 ms | FAIL_KNOWN |

```text
PASS = 5
FAIL_KNOWN = 1
FAIL_UNKNOWN = 0
TIMEOUT = 0
ENVIRONMENT_BLOCKED = 0
PREVIOUSLY_BLOCKED_SUITES_EXECUTED = 6/6
ENVIRONMENT_RECOVERY = PASS
```

### Known failure classification

`ZOOM / P2E-X06` expects the regular `dat_lich` flow to create a pending action and return text containing `OK`. The fixture hard-codes `luc: "2026-08-26 20:00"` in `kiem-thu/kiem-tra-zoom.js`, while Stage 0D ran on 2026-08-27. The production schedule validator intentionally compares this path with real `Date.now()` and returns `đã trôi qua rồi`; the test's injected Zoom clock does not control that regular schedule path.

This is classified `FAIL_KNOWN` from current, reproducible source proof:

- `kiem-thu/kiem-tra-zoom.js:1175` freezes the Zoom command clock at 2026-08-24.
- `kiem-thu/kiem-tra-zoom.js:1187` injects that clock only through `capHinhDongHoZoom`.
- `kiem-thu/kiem-tra-zoom.js:2202`–`2209` uses a hard-coded 2026-08-26 regular schedule and expects `/OK/`.
- `lib/admin-command.js:1308` and `lib/admin-command.js:1323`–`1324` use the real current time and reject a past regular schedule.

No source or test was changed to conceal or repair the failure.

## F. Full containerized baseline

Command inside the same isolated image:

```text
node kiem-thu/chay-hoi-quy-stage-0.js
```

| Suite | Raw result | Exit | Duration | Classified result |
|---|---|---:|---:|---|
| AI_ACTION_BOUNDARY | PASS | 0 | 37 ms | PASS |
| AI_DEFAULT | PASS | 0 | 999 ms | PASS |
| AI_MODEL_SOURCE | PASS | 0 | 750 ms | PASS |
| ONBOARDING | PASS | 0 | 250 ms | PASS |
| TEACH_BOT | PASS | 0 | 2,308 ms | PASS |
| CHAT_ATTACHMENT | PASS | 0 | 45 ms | PASS |
| P9_OWNER_PROFILE | PASS | 0 | 645 ms | PASS |
| P9_17_MODEL_SAVE | PASS | 0 | 33 ms | PASS |
| PHONE_DIRECT_MESSAGE | PASS | 0 | 901 ms | PASS |
| ZOOM | FAIL (403/404 assertions) | 1 | 1,166 ms | FAIL_KNOWN |

```text
TOTAL_AUTOMATED_SAFE = 10
PASS = 9
FAIL_KNOWN = 1
FAIL_UNKNOWN = 0
TIMEOUT = 0
ENVIRONMENT_BLOCKED = 0
ALL_AUTOMATED_SAFE_SUITES_EXECUTED = YES
MANUAL_ONLY_HARNESSES_EXECUTED = 0
```

## G. Canonical pass evaluation

```text
CANONICAL_TEST_RUNNER_PASS = HOLD_FOR_KNOWN_FAILURE_REVIEW
CANONICAL_TEST_RUNNER_PASS_DEFINITION = CLOSED_BY_STAGE_0D_CONTRACT

ALL_AUTOMATED_SAFE_SUITES_EXECUTED = YES
FAIL_UNKNOWN = 0
TIMEOUT = 0
ENVIRONMENT_BLOCKED = 0
FAIL_KNOWN = 1
```

The environment portion of the pass definition is satisfied, but the contract forbids automatically waiving a known failure. PO/BU must decide how the dated test fixture is handled under a later authorized package.

## H. Freeze comparison and files changed

The manifest algorithm sorts relative paths, hashes each file with SHA-256, joins `path<TAB>hash` records with LF, then hashes that UTF-8 manifest. The existing-test set is the 17 pre-Stage-0D `.js`/`.html` files in `kiem-thu/`; it excludes the new Stage 0D wrapper.

| Frozen set/file | Before SHA-256 | After SHA-256 | Changed by Stage 0D |
|---|---|---|---|
| Production manifest: 51 files under `lib/`, `public/`, plus `server.js` | `320B4C29F32411A5BA2EBAA28A02BE291B5237BAD9B83EFE82C166015F46690D` | same | NO |
| Existing test manifest: 17 files | `8FF3374AE0834B01B2B71FBB9E647A68F23D68E578E9C10216054222913EA36A` | same | NO |
| Canonical runner | `4332CC4F99C46C5B598FF746A86DBEC93272111AA409084FE2F16BF43B68CA34` | same | NO |
| `package.json` | `48162D32FDEECEF2945E2976248F2C1A4FB7993D1275EF31030009CD40D5D112` | same | NO |
| `package-lock.json` | `2037629C998758F9C0017B6D792309D849B6D85405DD5913A3436476E00050AD` | same | NO |
| Production `Dockerfile` | `BB04EC59B3BF2A9338D8AE231FED6C73F8B646FD17E32BE5E083601D4E420247` | same | NO |
| `docker-compose.yml` | `CAEA6551A9C8DA971F893E19B295C6120DACF1CA7EC234B01FF682D61972C740` | same | NO |
| Production `.dockerignore` | `9EDCFD7979111B3B59F11C39E96E449E61ABDFD9466D7DCA2A4063F0BDE5891A` | same | NO |

Stage 0D-created or updated files:

```text
kiem-thu/Dockerfile.stage0d
kiem-thu/Dockerfile.stage0d.dockerignore
kiem-thu/chay-stage0d-six.js
Docs/Stabilization/STAGE-0D-CONTAINERIZED-BASELINE.md
Docs/Stabilization/STAGE-0-BASELINE-REGRESSION.md
```

Infrastructure hashes:

```text
Dockerfile.stage0d = 80150F4B81A165A0FB3B86B7E95CEA0BC4FD2AA022585415143CAFC8BF30CCF4
Dockerfile.stage0d.dockerignore = B637692AAF5BFABB0B215D3B2FD2435647B2511EB5E259D4BA0D3BA8974BC938
chay-stage0d-six.js = D85F3DC332B5D1E499AE27ED376F53FB3AE50D8EBF9811640248715DFCA254E9
```

```text
PRODUCTION_SOURCE_CHANGED_BY_STAGE0D = NO
TEST_SEMANTICS_CHANGED = NO
CANONICAL_RUNNER_CHANGED = NO
REPO_DEPENDENCIES_CHANGED = NO
PRODUCTION_CONTAINER_CONFIG_CHANGED = NO
```

## I. Safety

```text
REAL_ZALO_ACTION = NO
REAL_EMAIL_ACTION = NO
REAL_ZOOM_ACTION = NO
REAL_AI_PROVIDER_ACTION = NO

CANONICAL_DB_OPENED = NO
CANONICAL_DB_MOUNTED = NO
CANONICAL_BACKUP_DB_OPENED = NO

COMMIT = NO
PUSH = NO
VPS = NO
```

External network was available only during image build for the base image, Debian packages, and `npm ci` from the existing lockfile. Test containers had `--network none`; loopback fixtures continued to work inside the container.

## J. Artifacts

```text
Docs/Stabilization/STAGE-0D-CONTAINERIZED-BASELINE.md = CREATED
Docs/Stabilization/STAGE-0-BASELINE-REGRESSION.md = UPDATED_WITH_CONTAINERIZED_ADDENDUM
HOST_BASELINE = PRESERVED
```

## K. Stage 0D acceptance

```text
ENVIRONMENT_RECOVERY = PASS
SAFETY = PASS
CANONICAL_BASELINE = HOLD
STAGE_0D = HOLD
```

The technical environment target succeeded, but the canonical baseline remains on hold because one known failure requires explicit review and was not waived.

## L. Next boundary

```text
STAGE_0_CLOSURE_CANDIDATE = NO
STAGE_0_CLOSED = NO
STAB_02_STARTED = NO
NEXT = WAIT FOR PO / BU REVIEW
STOP
```

## M. ZOOM_TIME_FIXTURE_CORRECTION

The initial `RESULT = HOLD` and its 9 PASS / 1 FAIL_KNOWN evidence above are preserved as the historical first Stage 0D execution. Contract `PD-STAB-STAGE0D-ZOOM-FIXTURE-CORRECTION-01` subsequently authorized a test-fixture-only correction for `ZOOM / P2E-X06`.

```text
CORRECTION_DATE = 2026-08-27
TARGET_FILE = kiem-thu/kiem-tra-zoom.js
TARGET_TEST = P2E-X06
TIME_DEPENDENT_FIXTURE_PROVEN = YES
```

Before correction, the test hard-coded `luc: "2026-08-26 20:00"`. The fixture was future-dated relative to the suite's controlled `MOC_P2C` clock but the regular `dat_lich` validator reads real `Date.now()`, so the fixture expired when execution advanced to 2026-08-27. The protected behavior remains unchanged: a valid pending `dat_lich` action must exist, return an `OK` confirmation prompt, and block a competing P2E Zoom-management action.

The corrected test derives the schedule as two local calendar days after existing controlled clock `MOC_P2C`, at 20:00. During only the `P2E-X06` callback it temporarily makes `Date.now()` return `MOC_P2C`, then restores the original function in `finally`. This keeps both schedule validation and pending expiry deterministic without changing production clock seams.

```text
OLD_FIXTURE = absolute 2026-08-26 20:00
NEW_FIXTURE_STRATEGY = controlled MOC_P2C + 2 local calendar days at 20:00
ABSOLUTE_LATER_DATE_USED = NO
ASSERTION_SEMANTICS_CHANGED = NO
PRODUCTION_SOURCE_CHANGED = NO
PRODUCTION_BEHAVIOR_CHANGED = NO
CANONICAL_RUNNER_CHANGED = NO
REPO_DEPENDENCIES_CHANGED = NO
```

Correction freeze evidence:

| Frozen item | Before correction SHA-256 | After correction SHA-256 | Expected |
|---|---|---|---|
| Production manifest | `320B4C29F32411A5BA2EBAA28A02BE291B5237BAD9B83EFE82C166015F46690D` | same | UNCHANGED |
| `lib/admin-command.js` | `174B5E9B11319ECC3B76BDF92538E8DE40429FFF07FF887268D18D3C3ACEA6EA` | same | UNCHANGED |
| Canonical runner | `4332CC4F99C46C5B598FF746A86DBEC93272111AA409084FE2F16BF43B68CA34` | same | UNCHANGED |
| `package.json` | `48162D32FDEECEF2945E2976248F2C1A4FB7993D1275EF31030009CD40D5D112` | same | UNCHANGED |
| `package-lock.json` | `2037629C998758F9C0017B6D792309D849B6D85405DD5913A3436476E00050AD` | same | UNCHANGED |
| `kiem-thu/kiem-tra-zoom.js` | `0806DC00E04CCA691E4E64956936B88DA04CD96EFCBCB71ECAE5B8A6BBA54716` | `B2310DC699B4ADF03E5098D65DBEAA12632E09F98AFE6D4053A17DCF3F347FC7` | TEST FIXTURE ONLY |

The rebuilt isolated image is `zalo-web-stage0d:2026-08-27`, image ID `sha256:00bb229da8190183ebaa43a660e6da6ba7ad6270593d35599a11bb2342504741`, Linux ARM64, running as user `node`.

### Focused verification

```text
COMMAND = node kiem-thu/kiem-tra-zoom.js
P2E_X06 = PASS
ZOOM_SUITE = PASS
ZOOM_ASSERTIONS = 404/404 PASS
EXIT_CODE = 0
TIMEOUT = 0
ENVIRONMENT_BLOCKED = 0
REAL_ZOOM_CALLS = 0
```

The focused container retained `--network none`, `--read-only`, ephemeral `/tmp`, no bind mount, no volume, dropped capabilities, and `no-new-privileges`.

## N. POST_CORRECTION_BASELINE

Only after focused ZOOM passed, the unchanged canonical runner was executed in the same isolated image.

| Suite | Result | Exit | Duration |
|---|---|---:|---:|
| AI_ACTION_BOUNDARY | PASS | 0 | 32 ms |
| AI_DEFAULT | PASS | 0 | 1,060 ms |
| AI_MODEL_SOURCE | PASS | 0 | 818 ms |
| ONBOARDING | PASS | 0 | 231 ms |
| TEACH_BOT | PASS | 0 | 2,918 ms |
| CHAT_ATTACHMENT | PASS | 0 | 45 ms |
| P9_OWNER_PROFILE | PASS | 0 | 661 ms |
| P9_17_MODEL_SAVE | PASS | 0 | 39 ms |
| PHONE_DIRECT_MESSAGE | PASS | 0 | 898 ms |
| ZOOM | PASS | 0 | 1,342 ms |

```text
TOTAL_AUTOMATED_SAFE = 10
PASS = 10
FAIL_KNOWN = 0
FAIL_UNKNOWN = 0
TIMEOUT = 0
ENVIRONMENT_BLOCKED = 0
ALL_AUTOMATED_SAFE_SUITES_EXECUTED = YES
CANONICAL_TEST_RUNNER_PASS = YES
```

Canonical DB filesystem metadata after correction verification was observed without opening SQLite: `zalo.db` remained 2,424,832 bytes with unchanged mtime; WAL/SHM sizes remained unchanged while their mtimes advanced under the independent host runtime. Neither test container had a host mount or a copy of canonical data.

```text
CANONICAL_DB_OPENED = NO
CANONICAL_DB_MOUNTED = NO
REAL_EXTERNAL_ACTION = NO
COMMIT = NO
PUSH = NO
VPS = NO

STAGE_0D = PASS
STAGE_0_CLOSURE_CANDIDATE = YES
STAGE_0_CLOSED = NO
STAB_02_STARTED = NO
NEXT = WAIT FOR PO / BU REVIEW
STOP
```
