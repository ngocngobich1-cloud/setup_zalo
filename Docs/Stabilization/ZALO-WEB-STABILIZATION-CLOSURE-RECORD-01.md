# ZALO WEB STABILIZATION — PRODUCTION CLOSURE RECORD 01

## 1. STATUS

STATUS = CLOSED_ACCEPTED

PRODUCTION_TECHNICAL_CUTOVER = PASS

PRODUCT_OWNER_UAT = 8/8 PASS

CONFIRMED_DATA_LOSS = NO

PDF_AUTOMATION_INCLUDED = NO

This record closes the approved Zalo Web stabilization stream represented by the accepted release below.

PDF Automation remains a separate feature stream and is not part of this stabilization acceptance.

## 2. ACCEPTED CODE AUTHORITY

PRE_STAB_MAIN_SHA =
0e3392631dffc3ed8e9653ba68e38d0764a94295

ACCEPTED_STAB_RELEASE_SHA =
f7d8f9ce838b98bb07412f999f561b4c9e63afe1

ACCEPTED_RELEASE_BRANCH =
release/stab-20260829-candidate

PRODUCTION_SHA_AT_ACCEPTANCE =
f7d8f9ce838b98bb07412f999f561b4c9e63afe1

## 3. RELEASE COMMITS

1.
8224570adf1e37b4b8fe8cfb6c16f23343c82990
stabilization: publish STAB-only release candidate

2.
259e351fa31851d126a6c94ebeec7f63f3135538
stabilization: add explicit P9 legacy owner migration

3.
f7d8f9ce838b98bb07412f999f561b4c9e63afe1
test(stabilization): verify full P9 legacy preservation

## 4. FINAL VERIFICATION

P9_FULL =
16/16 PASS

P9_OWNER_PROFILE =
7/7 PASS

CANONICAL_STAGE0 =
12/12 PASS

FAIL =
0

TIMEOUT =
0

ENVIRONMENT_BLOCKED =
0

PRODUCTION_SHAPED_SEMANTIC_DRYRUN =
PASS

P9_REAL_PRODUCTION_MIGRATION =
PASS

P9_SECOND_RUN_IDEMPOTENCY =
PASS

ACCOUNT_CONFIG_PRESERVED =
YES

TRAINING_PRESERVED =
YES

AI_PROFILE_PRESERVED =
YES

AI_RUNTIME_PRESERVED =
YES

LEGACY_ARCHIVE_PRESERVED =
YES

CONFIRMED_DATA_LOSS =
NO

## 5. PRODUCT OWNER PRODUCTION UAT

UAT01 Login/UI = PASS
UAT02 Correct account = PASS
UAT03 Conversation/history = PASS
UAT04 Soul = PASS
UAT05 Model = PASS
UAT06 Training = PASS
UAT07 Real message = PASS
UAT08 Reload/stability = PASS

PO_UAT_RESULT =
8/8 PASS

## 6. P9 LEGACY OWNER AUTHORITY

LEGACY_AI_OWNER =
646827640154364847

LEGACY_TRAINING_OWNER =
646827640154364847

This UID was used only as explicit controlled authority for the production legacy-owner migration.

Generic runtime must not infer or hardcode a production owner.

## 7. PDF EXCLUSION

PDF_AUTOMATION_INCLUDED =
NO

PDF_RUNTIME_HITS =
0

PDF_TEST_HITS =
0

PDF_BYTES =
0

PDF Automation is explicitly outside this STAB release and must be handled as a separate feature/release stream.

## 8. ROLLBACK RETENTION

RETENTION_REQUIRED =
YES

CLEANUP_AUTHORIZED =
NO

Retain:

/opt/zalo-web-backups/stab-final-20260829T060157Z

/opt/zalo-web-backups/data.real-p9-migrated-20260829T060757Z

/opt/zalo-web-backups/stab-cutover-pre-f7d8f9ce-20260829T074052Z

zalo-web-next-zalo-web:rollback-pre-f7d8f9ce-20260829T074009Z

These assets must not be deleted as part of this closure/publication task.

## 9. PRODUCTION ACCEPTANCE

At Product Owner acceptance:

PRODUCTION_STATUS =
HEALTHY

PRODUCTION_SHA =
f7d8f9ce838b98bb07412f999f561b4c9e63afe1

TECHNICAL_CUTOVER =
PASS

PO_UAT =
PASS

STABILIZATION_PRODUCTION_ACCEPTANCE =
PASS

## 10. FINAL SCOPE STATEMENT

The Zalo Web stabilization stream is accepted and closed for production.

This closure does not authorize:

- PDF Automation deployment;
- cleanup of retained rollback assets;
- unrelated refactor;
- additional production mutation.

Any later PDF/file-attachment release must be audited, tested, committed, published and deployed through its own controlled feature stream.

END OF RECORD
