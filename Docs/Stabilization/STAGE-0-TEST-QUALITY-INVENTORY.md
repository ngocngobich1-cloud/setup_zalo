# STAGE 0C — Test Quality Inventory

```text
DATE = 2026-08-27
BASELINE_SUITES_CLASSIFIED = 10/10
SOURCE_GREP_OR_SOURCE_SHAPE_PRESENT = YES
IMPLEMENTATION_COUPLED_SUITES_IDENTIFIED = YES
```

Classification is based on current assertions, not filenames. Counts below show the assertion/source-inspection surface and are not quality scores.

| Suite | Assert calls | Production source reads | `.includes()` checks | Regex assertion checks |
|---|---:|---:|---:|---:|
| AI_ACTION_BOUNDARY | 29 | 2 | 25 | 2 |
| AI_DEFAULT | 21 | 1 | 8 | 0 |
| AI_MODEL_SOURCE | 25 | 5 | 11 | 0 |
| ONBOARDING | 133 | 7 | 48 | 13 |
| TEACH_BOT | 219 | 8 | 45 | 65 |
| CHAT_ATTACHMENT | 70 | 1 | 0 | 46 |
| P9_OWNER_PROFILE | 39 | 3 | 9 | 0 |
| P9_17_MODEL_SAVE | 11 | 1 | 0 | 0 |
| PHONE_DIRECT_MESSAGE | 174 | 2 | 22 | 42 |
| ZOOM | 670 | 29 | 247 | 92 |

## Baseline suite classification

| Suite | Primary | Secondary | Quality label | Protected behavior | Likely STAB impact | Expected action |
|---|---|---|---|---|---|---|
| AI_ACTION_BOUNDARY | SOURCE_GREP_TEST | IMPLEMENTATION_COUPLED_TEST | IMPLEMENTATION_COUPLED | Separate credential/model actions, canonical routes, partial AI save boundary | STAB-03 | REPLACE_WITH_BEHAVIOR_TEST_LATER; EXPECTED_UPDATE if handler structure changes |
| AI_DEFAULT | INTEGRATION_TEST | DATABASE_PERSISTENCE_TEST + SOURCE_GREP_TEST | EXPECTED_TO_REQUIRE_UPDATE | Effective default, saved-model precedence, no default persistence, onboarding consumer | STAB-03, STAB-04 | Preserve behavioral cases; review source assertions during package changes |
| AI_MODEL_SOURCE | INTEGRATION_TEST | DATABASE_PERSISTENCE_TEST + SOURCE_GREP_TEST | EXPECTED_TO_REQUIRE_UPDATE | One owner-scoped canonical model source across training/onboarding/UI | STAB-03, STAB-04, STAB-06 | Preserve behavior; update source-shape assertions only with reviewed contract evidence |
| ONBOARDING | INTEGRATION_TEST | PARSER_UNIT_TEST + SOURCE_GREP_TEST | EXPECTED_TO_REQUIRE_UPDATE | Steps 0–9, model boundary, resume/error/owner state and UI CTA | STAB-03, STAB-04, STAB-06, STAB-07B | Preserve state-machine behavior; review coupled UI/source assertions |
| TEACH_BOT | DATABASE_PERSISTENCE_TEST | INTEGRATION_TEST + SOURCE_GREP_TEST | STABLE_CONTRACT_TEST (hybrid) | Owner instruction persistence, confirmation, pending conflict and restart | STAB-01, STAB-04, STAB-06 | NO_CHANGE for behavior; targeted review of source assertions |
| CHAT_ATTACHMENT | PARSER_UNIT_TEST | BEHAVIOR_RUNTIME_TEST + SOURCE_GREP_TEST | IMPLEMENTATION_COUPLED (hybrid) | Media classification/adapter validation plus composer/render source contracts | NONE_KNOWN | Preserve unit cases; replace DOM/source regex with behavior coverage later |
| P9_OWNER_PROFILE | DATABASE_PERSISTENCE_TEST | INTEGRATION_TEST + SOURCE_GREP_TEST | STABLE_CONTRACT_TEST (hybrid) | A/B profile isolation, migration stop, training isolation, owner switch invalidation | STAB-01, STAB-03, STAB-06 | NO_CHANGE for DB behavior; EXPECTED_UPDATE for frontend source shape under STAB-06 |
| P9_17_MODEL_SAVE | BEHAVIOR_RUNTIME_TEST | SOURCE_GREP_TEST + IMPLEMENTATION_COUPLED_TEST | IMPLEMENTATION_COUPLED | Save success/error and stale-owner response guard | STAB-03, STAB-06 | Preserve T1–T3 behavior; replace/extract T4–T5 source-shape assertions later |
| PHONE_DIRECT_MESSAGE | INTEGRATION_TEST | PARSER_UNIT_TEST + SOURCE_GREP_TEST | STABLE_CONTRACT_TEST (hybrid) | Phone normalization, preview/OK/exactly-once send, routing and system-event guard | STAB-04, STAB-07B | NO_CHANGE for behavior; review narrow source assertion only if boundary moves |
| ZOOM | INTEGRATION_TEST | DATABASE_PERSISTENCE_TEST + SOURCE_GREP_TEST | STABLE_CONTRACT_TEST (hybrid) | Provider adapter, safe config, pending flows, parsers and dashboard contracts | NONE_KNOWN | NO_CHANGE; review extensive UI source assertions on any legitimate UI refactor |

Primary-type counts are exclusive: `BEHAVIOR_RUNTIME_TEST=1`, `INTEGRATION_TEST=5`, `DATABASE_PERSISTENCE_TEST=2`, `PARSER_UNIT_TEST=1`, `SOURCE_GREP_TEST=1`, `OTHER=0`. All ten suites contain at least one implementation-coupled/source-shape element as a primary or secondary concern; two are predominantly implementation-coupled.

## Required known-test review

### `kiem-tra-p9-17-model-save.js`

```text
CONCLUSION = PARTIALLY_CONFIRMED
```

Evidence:

- Lines 12–17 read `public/config.js` and extract one callback with a regex tied to `#btn-ai-model-save` and the next `useKnowledge.addEventListener` statement.
- Lines 58–91 execute the extracted callback in a VM with fake fetch/UI objects and assert observable success, backend-error, and owner-switch behavior. These are behavioral assertions, not grep-only.
- Lines 93–105 count the identifier `generation`, require exactly one assignment from `settingsOwnerGeneration`, and require one inequality guard. These assert source shape/local-variable structure.

Answers:

1. Protected behavior: model save reports success/error correctly and ignores a stale response after owner change.
2. T1–T3 measure executed behavior; extraction plus T4–T5 measure source/identifier shape.
3. Yes. A behavior-preserving refactor that moves the handler, changes its boundary statement, or encapsulates generation state can turn the suite red.
4. Likely impact: STAB-03 and STAB-06.
5. Future action: preserve T1–T3; `REPLACE_WITH_BEHAVIOR_TEST_LATER` for T4–T5 or deliberately update after contract review.

### `kiem-tra-ai-action-boundary.js`

```text
CONCLUSION = CONFIRMED
```

Evidence:

- Lines 11–12 read `public/config.js` and `server.js` as text.
- Lines 24–28 locate handlers by exact source substrings and slice between neighboring handler registrations.
- Lines 31–92 use `includes`, regex, exact button fragments, exact route fragments, variable names (`soulInput`, `topicsInput`, `roleInput`), and source order (`saveScope` branch before soul validation). No handler/server request is executed.

Answers:

1. Intended behavior: credential actions stay separate; model-only save preserves assistant config; assistant validation remains required.
2. Current assertions measure source shape, route strings, symbol names, and ordering—not actual browser/server behavior.
3. Yes. A behavior-preserving extraction, renamed variable, router abstraction, or reordered equivalent validation can fail it.
4. Likely impact: STAB-03.
5. Future action: `REPLACE_WITH_BEHAVIOR_TEST_LATER`; until then any update must be explicit and preserve the intended contract.

## Implementation-coupled review matrix

| Suite | Behavior intended | Does current assertion measure source shape? | Refactor false-red risk | Likely package | Future action |
|---|---|---|---|---|---|
| AI_ACTION_BOUNDARY | AI action separation/partial save | YES, predominantly | HIGH | STAB-03 | REPLACE_WITH_BEHAVIOR_TEST_LATER |
| AI_DEFAULT | Default/model precedence | PARTLY | MEDIUM | STAB-03/04 | EXPECTED_UPDATE only for coupled cases |
| AI_MODEL_SOURCE | One canonical model source | PARTLY | MEDIUM | STAB-03/04/06 | EXPECTED_UPDATE only for coupled cases |
| ONBOARDING | State machine/model boundary/UI CTA | PARTLY | HIGH for UI/source cases | STAB-03/04/06/07B | Preserve behavior; targeted update review |
| TEACH_BOT | Owner persistence and confirmation | PARTLY | MEDIUM | STAB-01/04/06 | NO_CHANGE behavior; targeted review |
| CHAT_ATTACHMENT | Media/parser/composer behavior | YES for most UI/server assertions | HIGH | NONE_KNOWN | Replace source regex with DOM/integration later |
| P9_OWNER_PROFILE | Owner isolation/migration/cache invalidation | PARTLY | MEDIUM for frontend case P9-07 | STAB-01/03/06 | NO_CHANGE DB behavior; expected review under STAB-06 |
| P9_17_MODEL_SAVE | Save/stale response guard | PARTLY | HIGH for extraction/T4/T5 | STAB-03/06 | Preserve behavior; replace shape assertions later |
| PHONE_DIRECT_MESSAGE | Parser/exactly-once send/routing | PARTLY, narrowly | LOW–MEDIUM | STAB-04/07B | NO_CHANGE behavior; targeted review |
| ZOOM | Provider/admin/UI behavior | PARTLY, extensively | HIGH for UI source checks | NONE_KNOWN | NO_CHANGE behavior; targeted review on UI refactor |

## Expected future test impact matrix

| Suite | Test type | Quality label | Protected behavior | Likely STAB impact | Expected action |
|---|---|---|---|---|---|
| AI_ACTION_BOUNDARY | SOURCE_GREP / IMPLEMENTATION_COUPLED | IMPLEMENTATION_COUPLED | AI save/action boundaries | STAB-03 | EXPECTED_UPDATE / behavior replacement |
| AI_DEFAULT | INTEGRATION hybrid | EXPECTED_TO_REQUIRE_UPDATE | Default and saved-model semantics | STAB-03, STAB-04 | Review hybrid assertions; no weakening |
| AI_MODEL_SOURCE | INTEGRATION hybrid | EXPECTED_TO_REQUIRE_UPDATE | Canonical owner/model consumers | STAB-03, STAB-04, STAB-06 | Review hybrid assertions; no weakening |
| ONBOARDING | INTEGRATION hybrid | EXPECTED_TO_REQUIRE_UPDATE | Onboarding consumer/state/parser | STAB-03, STAB-04, STAB-06, STAB-07B | Targeted intentional updates only |
| TEACH_BOT | DB/INTEGRATION hybrid | STABLE_CONTRACT_TEST | Owner instruction and pending contract | STAB-01, STAB-04, STAB-06 | NO_CHANGE behavioral contract |
| CHAT_ATTACHMENT | PARSER/BEHAVIOR hybrid | IMPLEMENTATION_COUPLED | Media and composer contract | NONE_KNOWN | NO_CHANGE now; replace coupled checks later |
| P9_OWNER_PROFILE | DB/INTEGRATION hybrid | STABLE_CONTRACT_TEST | Profile isolation/migration/cache | STAB-01, STAB-03, STAB-06 | Preserve DB contract; review P9-07 |
| P9_17_MODEL_SAVE | BEHAVIOR/SOURCE hybrid | IMPLEMENTATION_COUPLED | Save and stale-owner guard | STAB-03, STAB-06 | Preserve behavior; update shape checks deliberately |
| PHONE_DIRECT_MESSAGE | INTEGRATION/PARSER hybrid | STABLE_CONTRACT_TEST | Exact phone send and route isolation | STAB-04, STAB-07B | NO_CHANGE expected |
| ZOOM | INTEGRATION/DB/SOURCE hybrid | STABLE_CONTRACT_TEST | Zoom provider/admin/UI contract | NONE_KNOWN | NO_CHANGE expected |

Package roll-up:

```text
STAB-01 = TEACH_BOT, P9_OWNER_PROFILE
STAB-03 = AI_ACTION_BOUNDARY, AI_DEFAULT, AI_MODEL_SOURCE, ONBOARDING, P9_OWNER_PROFILE, P9_17_MODEL_SAVE
STAB-04 = AI_DEFAULT, AI_MODEL_SOURCE, ONBOARDING, TEACH_BOT, PHONE_DIRECT_MESSAGE
STAB-05 = NONE_KNOWN
STAB-06 = AI_MODEL_SOURCE, ONBOARDING, TEACH_BOT, P9_OWNER_PROFILE, P9_17_MODEL_SAVE
STAB-07A = NONE_KNOWN
STAB-07B = ONBOARDING, PHONE_DIRECT_MESSAGE
```

## Stage 0C acceptance

```text
EVERY_BASELINE_SUITE_CLASSIFIED = YES
SOURCE_GREP_TESTS_IDENTIFIED = YES
IMPLEMENTATION_COUPLED_TESTS_IDENTIFIED = YES
EXPECTED_TEST_IMPACT_MATRIX = COMPLETE
kiem-tra-p9-17-model-save.js = VERIFIED_AND_CLASSIFIED / PARTIALLY_CONFIRMED
kiem-tra-ai-action-boundary.js = VERIFIED_AND_CLASSIFIED / CONFIRMED
STAGE_0C = PASS
```
