# ZALO-WEB-STABILIZATION-PLAN-01

```text
DOCUMENT\_ID = ZALO-WEB-STABILIZATION-PLAN-01
VERSION = V2.1 — REVIEW INCORPORATED + PO TRADE-OFF DECISION
DATE = 2026-08-27

PROJECT = Zalo Web

RECOMMENDED\_PATH =
Docs/Stabilization/ZALO-WEB-STABILIZATION-PLAN-01.md

STATUS = APPROVED
PO\_FINAL\_APPROVAL = GRANTED

SUPERSEDES =
V2 — REVIEW INCORPORATED
V1 — ORIGINAL STABILIZATION PLAN

PRODUCT OWNER = chị Ngọc
GPT / Bu = Principal Architect
Bae = Independent Reviewer
Codex = Execution Agent
```

\---

# 1\. MỤC ĐÍCH

Kế hoạch này chuyển dự án Zalo Web khỏi mô hình:

```text
bug xuất hiện
→ patch riêng
→ test hẹp
→ bug khác xuất hiện
→ patch tiếp
```

sang mô hình:

```text
FEATURE FREEZE
→ inventory
→ contract-wide audit
→ repair theo package
→ regression
→ Golden Journey
→ PO UAT
→ publication gate
```

Mục tiêu không phải rewrite hệ thống.

Mục tiêu là đóng các nguồn regression đã được chứng minh hoặc có bằng chứng đủ mạnh, theo từng package có boundary rõ ràng, acceptance riêng và stop condition riêng.

\---

# 2\. CURRENT BASELINE

Repo:

```text
D:\\DA test\\zalo-web
```

Branch:

```text
main
```

Published HEAD:

```text
0e3392631dffc3ed8e9653ba68e38d0764a94295
```

Quan trọng:

```text
PUBLISHED\_HEAD != CURRENT\_LOCAL\_RUNTIME\_SOURCE
```

Current worktree:

```text
DIRTY
```

Có nhiều local patch P1–P9 + onboarding/media chưa commit.

Tuyệt đối không được:

```text
git reset
git checkout .
git clean
git stash
discard local work
```

Không được lấy published HEAD làm canonical current source nếu dirty worktree khác HEAD.

\---

# 3\. GOVERNANCE

Canonical workflow:

```text
READ-ONLY
→ ROOT CAUSE / INVENTORY
→ ARCHITECTURE / CONTRACT
→ PO APPROVAL
→ IMPLEMENT
→ TEST
→ PO UAT
→ STOP
```

Agent không được:

```text
tự mở scope
tự refactor
tự migration ngoài contract
tự thêm dependency
tự đổi UI
tự sửa bug ngoài scope
tự commit
tự push
tự VPS
```

VPS luôn là PO thao tác thủ công.

Khi tới VPS:

```text
STOP
ĐẾN BƯỚC VPS
```

\---

# 4\. PRODUCT DECISION — ACCOUNT / PROFILE MODEL

Canonical Product Decision:

```text
ZALO\_UID = APP\_PROFILE\_ID
```

Desired behavior:

```text
Login Zalo A
→ dữ liệu A

Logout A
→ chỉ đóng session
→ dữ liệu A vẫn giữ trong DB

Login Zalo B lần đầu
→ fresh profile B
→ không lấy AI config / training của A

Logout B
→ giữ B

Login lại A
→ restore đúng A
```

Không cần archive job.

Database là kho lưu lịch sử.

\---

# 5\. CURRENT P9 PROFILE OWNERSHIP MODEL

## PER UID

```text
Conversations
Messages
Admin
Onboarding
Bot enabled
Groups
Senders

AI Model
Soul
Tone
Topics
Knowledge settings

Training session
Training transcript
```

## INSTALLATION GLOBAL

```text
OpenCode credentials / API keys
Provider catalog
OpenCode runtime
Website connector
```

Canonical model source:

```text
ai\_chat\_config\[current\_owner\_uid].opencode\_model
```

Fallback:

```text
opencode/nemotron-3-ultra-free
```

Precedence:

```text
current owner saved model
→ system default
```

Không được tái tạo các model source song song như:

```text
setup\_data.modelId
setup\_data.providerId
training riêng model source
admin-command riêng model source
```

\---

# 6\. KNOWN CURRENT UAT DEFECT

Known bug:

```text
"Ghi nhớ cấu hình trợ lý"
→ "Địa chỉ OpenCode server là bắt buộc"
```

Quyết định:

```text
KHÔNG mở P9.18 độc lập
KHÔNG vá riêng bug này
```

Canonical package:

```text
STAB-03 — AI CONFIGURATION CONTRACT CLOSURE
```

\---

# 7\. WHY STABILIZATION IS REQUIRED

Whole-repo audit đã cho thấy regression cascade đến từ nhiều pattern hệ thống.

## 7.1 Distributed feature ownership

Một feature thường phải sửa tay nhiều nơi:

```text
UI
API
DB
runtime consumer
validation
cache
tests
```

Một thay đổi hợp lệ ở một layer dễ để lại stale reference ở layer khác.

\---

## 7.2 Silent fallback / swallowed errors

Có nhiều:

```text
catch rỗng
fallback trung tính
best-effort path
```

khiến lỗi production không được phản ánh trung thực.

\---

## 7.3 Multiple source-of-truth patterns

Cùng một khái niệm từng tồn tại ở nhiều source:

```text
model
config
session
owner context
runtime state
```

\---

## 7.4 Global state / cache cleanup không tập trung

Account switch có thể để lại:

```text
thread state
settings state
training state
typing state
cache
timers
listeners
```

\---

## 7.5 Test infrastructure chưa canonical

Không có một runner duy nhất làm publication safety gate.

Một số suite hiện tại kiểm tra implementation detail thay vì behavior.

Điều này làm chính test suite có thể tạo false regression sau các repair hợp lệ.

\---

# 8\. KNOWN LIVE FINDINGS

Các finding dưới đây chưa mặc nhiên được sửa.

## FINDING 1 — Admin notification owner context

Có callsite:

```text
getAdminZalo()
```

thiếu:

```text
ownerUid
```

Known impact:

```text
scheduler / email-check admin notification
có thể fail
```

Package:

```text
STAB-04A
```

\---

## FINDING 2 — account\_config schema copy

Một rebuild/schema copy có nguy cơ bỏ:

```text
owner\_instruction
```

Nguy cơ:

```text
data loss
```

Package:

```text
STAB-01A
```

\---

## FINDING 3 — Message update identity

Có UPDATE dùng:

```text
WHERE id = ?
```

trong khi message identity có thread context.

Nguy cơ:

```text
cross-thread write
```

Package:

```text
STAB-01B
```

\---

## FINDING 4 — Unicode command matching

Regex dạng:

```text
\\bnhớ\\b.\*\\bnhé\\b
```

có thể sai với Unicode tiếng Việt.

Package:

```text
STAB-07B
```

\---

## FINDING 5 — AI consumer model semantics

Một số consumer từng không dùng cùng semantics.

P9 đã sửa một phần.

Phải audit current dirty bytes.

Package:

```text
STAB-04B
```

\---

## FINDING 6 — Provider test fail-closed

`testProviderKey` thiếu contract:

```text
tools: KHONG\_TOOL
```

theo fail-closed policy.

Package:

```text
STAB-03
```

\---

## FINDING 7 — Thread preview ordering

Historical sync có thể ghi đè preview mới bằng message cũ.

Package:

```text
STAB-07A
```

\---

## FINDING 8 — SQLite foreign key enforcement

Schema có foreign key nhưng:

```text
PRAGMA foreign\_keys
```

chưa canonical/per-connection.

Package:

```text
STAB-01
```

\---

## FINDING 9 — WAL backup safety

WAL từng lớn hơn main DB.

Copy:

```text
zalo.db
```

khi DB đang chạy có thể không tạo backup đầy đủ.

Package:

```text
STAB-02
```

\---

## FINDING 10 — Browser harness port collision

Có collision:

```text
3792
```

nếu browser harness chạy song song.

Phải được inventory/test-runner contract xử lý.

Package:

```text
STAGE 0
```

\---

# 9\. STABILIZATION PRINCIPLES

## 9.1 Không patch bug lẻ

Từ V2.1:

```text
NO:
P9.18
P9.19
P9.20
bug nào lòi → sửa bug đó
```

Repair phải thuộc package contract.

\---

## 9.2 Không rewrite

Không dùng stabilization để:

```text
đổi framework
đổi kiến trúc toàn app
đổi folder structure
generic hóa mọi command
cleanup toàn repo
```

\---

## 9.3 Package must close a contract

Mỗi package phải có:

```text
ENTRY CONDITIONS
SCOPE
LOCKED AREAS
READ-ONLY AUDIT
IMPLEMENTATION BOUNDARY
TESTS
ACCEPTANCE
STOP CONDITION
```

\---

## 9.4 Unknown regression blocks progression

Nếu canonical regression runner đỏ vì regression chưa giải thích:

```text
STOP
CLASSIFY
DO NOT CONTINUE
```

Ngoại lệ duy nhất là test đã được STAGE 0 phân loại trước là implementation-coupled và current package contract đã dự báo cần update.

\---

# 10\. GOLDEN JOURNEYS

Canonical Golden Journey set:

```text
GJ-01
Mở app / login app

GJ-02
QR login Zalo

GJ-03
Load conversations

GJ-04
Open/read history

GJ-05
Send Zalo message

GJ-06
A → logout
B → login
A → login lại
→ đúng từng profile

GJ-07
Provider / Model / API key UI

GJ-08
Save/reload Model/Soul/Tone/Topics

GJ-09
Bot Commander / Onboarding / Training

GJ-10
Teach Bot

GJ-11
Tìm \& nhắn theo SĐT

GJ-12
Zoom

GJ-13
Customer message
→ aggregation
→ AI
→ outbound reply
→ truthful log

GJ-14
Restart container
→ config restored
→ bot state correct

GJ-15
Group bot
→ đúng mention/tag rule
```

Browser-only journey:

```text
MANUAL\_PO\_UAT\_REQUIRED
```

Không được fake PASS bằng source inspection.

\---

# 11\. EXECUTION ORDER

Canonical order:

```text
STAGE 0
→ STAB-02
→ STAB-01
→ STAB-03
→ STAB-04
→ STAB-05
→ STAB-06
→ STAB-07A
→ STAB-07B
→ STAB-09
→ STAB-10
```

Không tự đổi thứ tự.

\---

# 12\. STAGE 0 — FREEZE / INVENTORY / TEST BASELINE

Mục tiêu:

```text
Biết chính xác current source là gì
+
biết test nào đang bảo vệ behavior thật
+
biết baseline nào đang đỏ/xanh trước repair
```

STAGE 0 không sửa production behavior.

\---

# 13\. STAGE 0A — WORKTREE FREEZE \& INVENTORY

Bắt buộc:

```text
1. Record:
   branch
   HEAD
   git status
   tracked modifications
   untracked files

2. Inventory:
   P1–P9 local delta
   onboarding
   media
   unrelated files

3. Classify every path:
   CURRENT\_PRODUCT\_DELTA
   TEST\_ONLY
   GENERATED
   TEMPORARY
   UNKNOWN
   UNRELATED
```

Không:

```text
reset
clean
checkout
stash
delete unknown file
```

Output:

```text
WORKTREE\_INVENTORY = COMPLETE
TRACKED\_PATHS\_CLASSIFIED = YES
UNTRACKED\_FILES\_CLASSIFIED = YES
```

\---

# 14\. STAGE 0B — CANONICAL REGRESSION RUNNER

Tạo một canonical runner tối thiểu gom các suite hiện có.

Runner không được:

```text
thay test semantics
làm yếu assertion
ẩn failure
auto-fix source
```

Runner phải:

```text
- chạy deterministic trong khả năng hiện có
- report từng suite
- report exit status
- phân biệt automated vs manual-only
- tránh browser port collision
```

Baseline snapshot:

```text
BASELINE\_PASS
BASELINE\_FAIL\_KNOWN
BASELINE\_FAIL\_UNKNOWN
NOT\_RUN\_ENVIRONMENT\_BLOCKED
MANUAL\_ONLY
```

Entry rule:

```text
Không production repair package nào bắt đầu
nếu canonical runner đang đỏ
vì UNKNOWN regression.
```

\---

# 15\. STAGE 0C — TEST QUALITY POLICY

Đây là phần bắt buộc của STAGE 0.

Mục tiêu:

```text
phân biệt test bảo vệ behavior
với test đang khóa implementation detail
```

Mỗi suite trong canonical baseline phải được phân loại.

Classification tối thiểu:

```text
BEHAVIOR\_RUNTIME\_TEST
INTEGRATION\_TEST
DATABASE\_PERSISTENCE\_TEST
PARSER\_UNIT\_TEST
SOURCE\_GREP\_TEST
IMPLEMENTATION\_COUPLED\_TEST
BROWSER\_MANUAL\_TEST
```

Mỗi suite đồng thời phải nhận một quality label:

```text
STABLE\_CONTRACT\_TEST
IMPLEMENTATION\_COUPLED
EXPECTED\_TO\_REQUIRE\_UPDATE
MANUAL\_ONLY
```

Ví dụ đã biết:

```text
kiem-tra-p9-17-model-save.js
→ SOURCE\_GREP\_TEST
→ IMPLEMENTATION\_COUPLED

kiem-tra-ai-action-boundary.js
→ IMPLEMENTATION\_COUPLED
```

Một suite implementation-coupled không được tự động được coi là behavioral contract.

Rule:

```text
Nếu package sau sửa code hợp lệ
và một test implementation-coupled đỏ đúng vì
implementation detail cũ đã thay đổi:

→ không tự động classify là product regression
→ vẫn phải review
→ vẫn phải update test có chủ đích
→ không được bỏ test hoặc làm yếu test để tạo PASS
```

Mỗi STAB contract sau Stage 0 phải ghi trước:

```text
EXPECTED\_TEST\_IMPACT =
suite nào expected không đổi
suite nào có thể cần update
lý do
```

Unknown test failure vẫn là blocker.

\---

# 16\. STAGE 0 EXIT GATE

Stage 0 chỉ PASS nếu:

```text
WORKTREE\_FROZEN = YES
TRACKED\_INVENTORY = COMPLETE
UNTRACKED\_INVENTORY = COMPLETE

CANONICAL\_RUNNER = CREATED
BASELINE\_SNAPSHOT = RECORDED

TEST\_QUALITY\_INVENTORY = COMPLETE
IMPLEMENTATION\_COUPLED\_TESTS = IDENTIFIED

UNKNOWN\_RED\_REGRESSION = NO
```

Sau PASS:

```text
STOP
REPORT TO PO
```

Không tự bắt đầu STAB-02 nếu contract chỉ cấp Stage 0.

\---

# 17\. STAB-02 — BACKUP / WAL / RESTORE

STAB-02 đứng trước mọi schema repair.

Mục tiêu:

```text
chứng minh backup thật sự restore được
```

Scope:

```text
WAL audit
canonical backup procedure
restore verification
busy\_timeout
migration app-stopped rule
```

Phải kiểm tra:

```text
main DB
WAL
SHM
checkpoint state
DB open connections
```

Không được coi:

```text
copy zalo.db
```

là backup canonical nếu WAL state chưa được chứng minh.

Exit:

```text
CANONICAL\_BACKUP\_METHOD = PROVEN
RESTORE\_VERIFIED = PASS
WAL\_HANDLING = CLOSED
BUSY\_TIMEOUT\_DECISION = CLOSED
MIGRATION\_RUNTIME\_RULE = CLOSED
```

\---

# 18\. STAB-01 — DATABASE DATA SAFETY

Entry:

```text
STAB-02 = PASS
```

Scope:

```text
account\_config preservation
message composite identity
foreign key audit
delete behavior
orphan audit
historical damage assessment
```

\---

# 19\. STAB-01A — ACCOUNT\_CONFIG PRESERVATION

Audit:

```text
all CREATE TABLE
all rebuild/copy
all migration path
all column preservation
```

Bắt buộc bảo toàn:

```text
owner\_instruction
```

Acceptance:

```text
schema path không làm mất field
existing current values không bị thay đổi bởi repair
new/rebuild path giữ đủ column
```

Quan trọng:

```text
"existing values không đổi"
KHÔNG đồng nghĩa với
"existing values vốn đã sạch".
```

Historical corruption thuộc assessment riêng nếu có.

\---

# 20\. STAB-01B — MESSAGE COMPOSITE IDENTITY

Root issue:

```text
UPDATE ... WHERE id = ?
```

có thể sai khi canonical identity yêu cầu thread context.

## 20.1 Read-only canonical identity proof

Phải xác minh:

```text
PK
unique constraint
thread relation
all update/delete callsites
```

Không sửa trước khi canonical identity được prove.

## 20.2 Historical data impact assessment

Bắt buộc chạy trước repair.

Mục tiêu:

```text
đánh giá dữ liệu có thể đã bị ghi đè từ trước
```

Phải read-only kiểm tra:

```text
1. Những record nào có thể từng bị UPDATE sai khóa tác động.

2. Có evidence cross-thread overwrite hay không.

3. Có nguồn nào dùng để đối chiếu hay không:
   - current DB relations
   - timestamps
   - raw/remote metadata
   - logs
   - backup snapshots

4. Không tự repair historical content.
```

Kết luận phải classify thành:

```text
HISTORICAL\_DAMAGE =
NO\_EVIDENCE\_OF\_DAMAGE
RECOVERABLE
PARTIALLY\_RECOVERABLE
NOT\_RECOVERABLE
INDETERMINATE
```

Báo PO:

```text
AFFECTED\_SCOPE =
...

RECOVERY\_CONFIDENCE =
...

RECOVERY\_ACTION =
NOT\_AUTHORIZED
```

Không cam kết khôi phục trong STAB-01B.

Nếu cần historical recovery:

```text
NEW PO DECISION REQUIRED
```

## 20.3 Repair

Chỉ sau identity proof + damage assessment mới sửa write predicate.

Acceptance:

```text
cross-thread write = impossible under canonical identity
focused regression = PASS
existing unrelated rows = unchanged
```

\---

# 21\. STAB-01C — FOREIGN KEY / ORPHAN SAFETY

Audit:

```text
PRAGMA foreign\_keys
all DB connections
orphan rows
delete behavior
```

Phải chốt:

```text
FK\_PER\_CONNECTION\_POLICY
DELETE\_BEHAVIOR
ORPHAN\_HANDLING
```

Không tự xóa orphan nếu contract không cho phép.

\---

# 22\. STAB-03 — AI CONFIGURATION CONTRACT CLOSURE

Current known UAT bug thuộc package này:

```text
"Địa chỉ OpenCode server là bắt buộc"
```

Không patch trước.

Boundary:

```text
PERSISTENCE
READ
WRITE
VALIDATION
PARTIAL SAVE
GLOBAL VS OWNER OWNERSHIP
PROVIDER TEST CONTRACT
```

\---

# 23\. STAB-03 SOURCE OF TRUTH

## GLOBAL

```text
API credentials
provider catalog
opencode\_base\_url
opencode\_agent
runtime provider metadata
```

## PER UID

```text
model
soul
tone
topics
knowledge
```

Không được owner save vô tình overwrite global runtime config.

Không được global save overwrite owner AI profile.

\---

# 24\. STAB-03 ACCEPTANCE

Bắt buộc:

```text
Save only model
→ không xóa Soul/Tone/Topics/Knowledge

Save assistant config
→ không xóa model/runtime config

A save
→ A restore

B fresh
→ không lấy A

B save
→ không đổi A

A login lại
→ A restore

provider catalog
→ owner independent

runtime base URL/agent
→ owner save không ghi đè sai

missing owner
→ no fallback write
```

Provider test:

```text
testProviderKey
→ phải follow fail-closed contract
→ tools = KHONG\_TOOL
```

Test impact phải tham chiếu inventory từ STAGE 0C.

\---

# 25\. PRODUCT OWNER TRADE-OFF DECISION — ADMIN NOTIFICATION

Known production defect:

```text
getAdminZalo() callsite thiếu ownerUid
```

Impact:

```text
scheduler / email-check
có thể không báo admin đúng
```

Theo execution order, repair nằm ở:

```text
STAB-04A
```

tức sau:

```text
STAGE 0
→ STAB-02
→ STAB-01
→ STAB-03
```

Product Owner đã chọn:

```text
OPTION A
```

Canonical decision:

```text
PO ACKNOWLEDGED TRADE-OFF = YES

Product Owner explicitly accepts that the known
admin-notification defect involving missing ownerUid
may remain unresolved until STAB-04A is executed.

No independent patch is authorized before STAB-04.

EARLY\_STAB-04A\_EXCEPTION = NOT\_AUTHORIZED
```

Rationale:

```text
Giữ kỷ luật package stabilization.
Không quay lại mô hình vá bug production riêng lẻ.
```

Known temporary impact:

```text
Admin notification có thể tiếp tục hỏng
cho đến khi STAB-04A đóng.
```

\---

# 26\. STAB-04 — OWNER CONTEXT + AI CONSUMER

Boundary:

```text
STAB-03 =
config storage/read/write

STAB-04 =
runtime consumer/context
```

Subpackages:

```text
STAB-04A
Admin notification owner context

STAB-04B
AI model consumer matrix

STAB-04C
Pending action ownership
```

\---

# 27\. STAB-04A — ADMIN NOTIFICATION OWNER CONTEXT

Scope:

```text
audit all getAdminZalo() callsites
prove owner context
repair missing ownerUid
focused scheduler/email notification regression
```

Không:

```text
scheduler redesign
email redesign
admin architecture refactor
DB changes
```

\---

# 28\. STAB-04B — AI CONSUMER MATRIX

Audit mọi AI consumer:

```text
Bot Commander
Onboarding
Training
auto reply
admin command
provider test
other runtime consumers
```

Phải prove:

```text
owner
model
provider/runtime config
fallback
knowledge state
```

Không consumer nào được tự tạo model semantics riêng.

\---

# 29\. STAB-04C — PENDING ACTION OWNERSHIP

Pending store:

```text
cho
```

phải owner-bound.

Acceptance:

```text
A tạo pending
→ B không được OK pending A

A tạo pending
→ B không được HỦY pending A

A pending
→ A có thể xử lý đúng contract
```

Không fallback sang pending của owner khác.

\---

# 30\. STAB-05 — RUNTIME ERROR / LOGGING / SESSION

Scope:

```text
silent catch classification
truthful activity log
session-store double callback
unsafe JSON.parse
activity-log retention classification
```

Không:

```text
xóa catch hàng loạt
rewrite logging architecture
```

Mỗi catch phải classify:

```text
EXPECTED\_BEST\_EFFORT
MUST\_LOG
MUST\_PROPAGATE
MUST\_FAIL\_CLOSED
```

Golden Journey liên quan:

```text
GJ-13 auto reply
```

phải có truthful log.

\---

# 31\. STAB-06 — ACCOUNT SWITCH CACHE HYGIENE

Audit toàn bộ state có khả năng sống qua owner switch.

Bao gồm:

```text
group-member cache
typing markers
sticker/media cache
rate limits
aggregation timers
listener state
frontend selectedThread
messagesByThread
settings loaded state
training loaded state
bot/group/sender UI
```

Mỗi state classify:

```text
GLOBAL
OWNER\_SCOPED
SESSION\_SCOPED
```

Rule:

```text
owner-scoped state
→ invalidate on owner boundary

session-scoped state
→ clear on logout/session termination

global state
→ không clear chỉ vì UID đổi
```

Acceptance:

```text
A → B
không còn UI/runtime state của A

B → A
restore A từ canonical persistence
không restore từ stale cache
```

\---

# 32\. STAB-07A — THREAD PREVIEW ORDERING

Canonical rule:

```text
NEWER\_TIMESTAMP\_WINS
```

Historical sync không được ghi đè:

```text
live preview mới hơn
```

Acceptance:

```text
old historical message
→ không replace latest preview

new live message
→ becomes preview
```

Không refactor toàn sync engine.

\---

# 33\. STAB-07B — UNICODE COMMAND MATCHING

Scope:

```text
parser / matching only
```

Audit:

```text
\\b assumptions
Unicode Vietnamese boundaries
normalization
case handling
```

Không:

```text
generic command framework
full parser rewrite
```

Acceptance phải có Vietnamese examples thật.

\---

# 34\. STAB-09 — GOLDEN JOURNEY REGRESSION

Chạy toàn bộ:

```text
GJ-01 → GJ-15
```

Coverage bắt buộc:

```text
A→B→A
auto-reply
restart recovery
group mention
Teach Bot
Phone Direct
Zoom
Onboarding
P1/P2/P7/P9
```

Browser-only:

```text
MANUAL\_PO\_UAT\_REQUIRED
```

Không dùng compile/typecheck thay cho UI acceptance.

\---

# 35\. STAB-10 — FINAL REGRESSION / PO UAT

Không production repair mới.

Chỉ:

```text
canonical tests
DB checks
runtime checks
Golden Journeys
PO UAT
dirty worktree audit
publication readiness
```

Nếu phát hiện bug mới:

```text
STOP
CLASSIFY
NEW CONTRACT IF REQUIRED
```

Không sửa ad hoc trong STAB-10.

\---

# 36\. DEFERRED — OUT OF STABILIZATION SCOPE

Không làm trừ blocker trực tiếp:

```text
178 selector cleanup
68 URL constant cleanup
generic admin command registry
all dynamic imports
full schema version framework
frontend framework rewrite
folder restructure
naming/style cleanup
dependency modernization
socket still receiving event after app logout
```

Không biến stabilization thành rewrite.

\---

# 37\. PACKAGE ENTRY POLICY

Một package chỉ bắt đầu nếu:

```text
previous required package = PASS

canonical runner status =
PASS
hoặc
only known/approved implementation-coupled red explicitly predicted
```

Không được bắt đầu nếu:

```text
UNKNOWN\_REGRESSION = YES
UNCLASSIFIED\_TEST\_FAILURE = YES
CURRENT\_WORKTREE\_STATE = UNKNOWN
```

\---

# 38\. TEST UPDATE POLICY

Test chỉ được cập nhật khi:

```text
1. Stage 0 đã classify test là implementation-coupled
   hoặc current package chứng minh test đang assert implementation detail cũ.

2. Product behavior contract không thay đổi trái phép.

3. Test mới/updated vẫn bảo vệ intended contract.

4. Báo cáo nói rõ:
   old assertion
   reason invalid
   new assertion
   behavior preserved
```

Cấm:

```text
delete test để PASS
weaken assertion để PASS
skip unknown failure
rename failure thành expected mà không có evidence
```

\---

# 39\. BACKUP / MIGRATION POLICY

Không migration/schema repair nếu:

```text
CANONICAL\_BACKUP\_METHOD != PROVEN
RESTORE\_VERIFIED != PASS
```

Migration execution rule:

```text
APP STOPPED
unless contract explicitly proves safe online migration
```

Default:

```text
no live schema mutation
```

\---

# 40\. DIRTY WORKTREE POLICY

Dirty worktree được coi là current product state.

Không được:

```text
normalize về HEAD
discard patch
reconstruct từ GitHub
```

Trước publication phải biết từng delta thuộc:

```text
KEEP
DROP
GENERATED
TEMPORARY
UNRELATED
```

Nhưng `DROP` không đồng nghĩa agent được tự xóa.

PO authority vẫn bắt buộc.

\---

# 41\. SECRET SAFETY

Trước publication:

```text
SECRET\_SCAN = REQUIRED
```

Phải kiểm tra tối thiểu:

```text
API keys
tokens
credentials
DB dumps
.env
runtime secrets
backup files
```

Không push backup DB.

\---

# 42\. PUBLICATION GATE

Không publication nếu thiếu bất kỳ điều kiện bắt buộc nào:

```text
STAGE\_0\_CLOSED = YES

STAB\_02\_CLOSED = YES
STAB\_01\_CLOSED = YES
STAB\_03\_CLOSED = YES
STAB\_04\_CLOSED = YES
STAB\_05\_CLOSED = YES
STAB\_06\_CLOSED = YES
STAB\_07A\_CLOSED = YES
STAB\_07B\_CLOSED = YES
STAB\_09\_CLOSED = YES

CANONICAL\_TEST\_RUNNER\_PASS = YES
TEST\_QUALITY\_INVENTORY\_COMPLETE = YES

GOLDEN\_JOURNEYS\_PASS = YES
PO\_UAT\_PASS = YES

DIRTY\_WORKTREE\_AUDITED = YES
P1-P9\_DELTAS\_CLASSIFIED = YES

TRACKED\_PATHS\_CLASSIFIED = YES
UNTRACKED\_FILES\_CLASSIFIED = YES

UNRELATED\_PATHS = 0
or explicitly PO accepted

WAL\_CHECKPOINT\_STATE\_VERIFIED = YES
DB\_BACKUP\_CANONICAL = YES
DB\_RESTORE\_VERIFIED = YES

SECRET\_SCAN\_BEFORE\_PUSH = PASS

SOURCE\_FREEZE = YES
STAGED\_DIFF\_REVIEW = PASS
```

Canonical meaning:

```text
CLOSED =
package contract đã hoàn tất,
acceptance criteria PASS,
required regression PASS,
và package đã dừng đúng stop condition.
```

Không được coi package là CLOSED chỉ vì:

```text
code đã sửa
focused test đã chạy
hoặc agent báo "done"
```

`STAB-10` không xuất hiện dưới dạng:

```text
STAB\_10\_CLOSED
```

trong pre-publication package list vì chính STAB-10 là phase thực hiện:

```text
final regression
PO UAT
dirty worktree audit
publication readiness evaluation
```

Publication chỉ được phép khi toàn bộ gate của §42 được STAB-10 xác minh PASS.

Sau đó mới xin:

```text
COMMIT AUTHORITY
```

Commit xong mới xin riêng:

```text
PUSH AUTHORITY
```

VPS:

```text
SEPARATE PHASE
PO MANUAL RUNBOOK
```

\---

# 43\. EXECUTION AUTHORITY MODEL

Approval kế hoạch không tự động đồng nghĩa cấp quyền toàn bộ repair.

Canonical pattern:

```text
PO APPROVES V2.1

→ Bu viết STAGE 0 IMPLEMENTATION CONTRACT

→ PO duyệt contract

→ Agent thi công STAGE 0

→ report + STOP

→ package tiếp theo có contract riêng
```

Không cấp toàn bộ STAB-02 → STAB-10 trong một prompt execution duy nhất.

\---

# 44\. CURRENT AUTHORITY

Tại thời điểm phát hành V2.1:

```text
STABILIZATION\_V2\_1 = NOT\_YET\_PO\_APPROVED

STAGE\_0\_IMPLEMENTATION = NOT\_AUTHORIZED

SOURCE\_CHANGE = NO
DATABASE\_CHANGE = NO
MIGRATION = NO

COMMIT = NO
PUSH = NO
VPS = NO
```

\---

## CURRENT AUTHORITY AS OF 2026-08-27

```text
STABILIZATION\_V2\_1 = APPROVED

PLAN\_STATE = APPROVED

PD-STAB-V2-01 = APPROVED

PO\_FINAL\_APPROVAL = GRANTED

STAGE\_0A\_0C =
AUTHORIZED\_AND\_EXECUTED

STAGE\_0\_DOCUMENTATION\_CORRECTION =
AUTHORIZED

STAGE\_0D\_IMPLEMENTATION =
NOT\_AUTHORIZED

STAB\_02\_IMPLEMENTATION =
NOT\_AUTHORIZED

SOURCE\_REPAIR =
NOT\_AUTHORIZED

DATABASE\_CHANGE =
NOT\_AUTHORIZED

MIGRATION =
NOT\_AUTHORIZED

COMMIT =
NOT\_AUTHORIZED

PUSH =
NOT\_AUTHORIZED

VPS =
NOT\_AUTHORIZED
```

\---

# 45\. NEXT PRODUCT DECISION

```text
PD-STAB-V2-01
```

Options:

```text
APPROVE
APPROVE WITH CHANGES
HOLD
```

Nếu:

```text
APPROVE
```

thì next action duy nhất:

```text
Bu viết STAGE 0 IMPLEMENTATION CONTRACT
```

STAGE 0 contract phải gồm:

```text
STAGE 0A
Freeze + inventory

STAGE 0B
Canonical regression runner + baseline snapshot

STAGE 0C
Test Quality Inventory
```

Không được tự bắt đầu:

```text
STAB-02
```

\---

# 46\. NON-NEGOTIABLE

Không quay lại:

```text
P9.18
P9.19
P9.20
isolated patch cascade
```

Từ đây:

```text
contract-wide audit
→ bounded package repair
→ focused regression
→ canonical regression
→ Golden Journey
→ PO UAT
```

PO không được trở thành lớp test đầu tiên cho regression cơ bản.

\---

# 47\. V2.1 CHANGELOG

## CHANGE-01 — Test Quality Policy moved into STAGE 0

Đã thêm:

```text
STAGE 0C — TEST QUALITY POLICY
```

Mỗi suite baseline phải được classify trước repair.

Mục đích:

```text
tránh source-grep / implementation-coupled tests
tạo false regression ở các package sau
```

\---

## CHANGE-02 — STAB-01B historical data impact assessment

Đã thêm:

```text
read-only historical damage assessment
```

Kết luận bắt buộc:

```text
NO\_EVIDENCE\_OF\_DAMAGE
RECOVERABLE
PARTIALLY\_RECOVERABLE
NOT\_RECOVERABLE
INDETERMINATE
```

Không tự khôi phục.

\---

## CHANGE-03 — PO trade-off decision for admin notification

PO chọn:

```text
OPTION A
```

Canonical:

```text
Admin notification defect
có thể tiếp tục tồn tại đến STAB-04A.

Không cho phép early STAB-04A exception.
Không cho phép patch riêng trước STAB-04.
```

\---

## CHANGE-04 — Publication Gate converted from obsolete priority model to package closure

Đã loại bỏ:

```text
ALL\_P0\_CLOSED
ALL\_P1\_CLOSED
```

vì V2.1 không còn sử dụng Priority Model P0/P1/P2/P3 làm execution authority.

Thay bằng explicit package closure:

```text
STAGE 0
STAB-02
STAB-01
STAB-03
STAB-04
STAB-05
STAB-06
STAB-07A
STAB-07B
STAB-09
= CLOSED
```

Mục đích:

```text
Publication Gate không còn phụ thuộc vào khái niệm
không được định nghĩa trong tài liệu.

Mọi stabilization package production trước STAB-10
đều phải có trạng thái CLOSED rõ ràng trước publication.
```

\---

# 48\. FINAL STATUS

```text
DOCUMENT =
ZALO-WEB-STABILIZATION-PLAN-01

VERSION =
V2.1

RECOMMENDED\_PATH =
Docs/Stabilization/ZALO-WEB-STABILIZATION-PLAN-01.md

CHANGE-01 =
Test Quality Policy → STAGE 0C

CHANGE-02 =
STAB-01B historical data impact assessment

CHANGE-03 =
PO accepts admin notification remains unresolved until STAB-04A

CHANGE-04 =
Publication Gate uses explicit package closure

PLAN\_STATE =
APPROVED

PD-STAB-V2-01 =
APPROVED

IMPLEMENTATION\_AUTHORITY =
STAGE\_0A\_0C\_COMPLETED;
STAGE\_0\_DOCUMENTATION\_CORRECTION\_AUTHORIZED;
STAGE\_0D\_NOT\_AUTHORIZED;
STAB\_02\_NOT\_AUTHORIZED
```

# END OF DOCUMENT
