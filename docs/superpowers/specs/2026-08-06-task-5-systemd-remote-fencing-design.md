# Task 5 systemd remote-fencing design

Date: 2026-08-06

Prior architecture-direction approval date: 2026-08-06

Status: interim bounded nonproduction architecture-spike charter candidate pending fresh independent security and architecture review and user re-review; no spike, validation, implementation planning, or production work is authorized

Review isolation: independent-required; this documentation execution provides self-review only and cannot approve the spike charter, a future final design, validation, implementation planning, or production work

## 1. Context, current state, and authority

Task 5 of the English article release must capture a consistent production source snapshot, restore the old public service, transfer the verified snapshot, and create an isolated detached candidate. The original release design and Task 5 plan remain authoritative for content, snapshot, candidate, restoration, taxonomy, opaque-configuration, secret-handling, and release boundaries. This specification changes only the remote execution ownership and fencing architecture.

The prior systemd architecture direction was user-approved on 2026-08-06. Exact commit `d7c22c39767e96e5024a886c52aac79ea4da3906` retained the corrected execution-gate, finalizer, loaded/unloaded, environment, PM2/Nginx, and retry invariants, but independent architecture review found that its single manifest/run identity was cyclic, target-created inodes were required before allocation, core interfaces remained undefined until the proposed validation stage, its `1800s` timing claim omitted post-runtime containment epochs, and section 20.1 abbreviated the closure recheck. This revision is intentionally only an interim bounded nonproduction architecture-spike charter candidate. If freshly approved and separately authorized, it may guide candidate spike work; it is not the final implementation design, a validation contract, an implementation plan, or production authority.

The current Task 5 production state remains unchanged and safely blocked:

- The old public service was restored and independently verified.
- Maintenance is inactive, PM2 is online, the application listens only on `127.0.0.1:3000`, production remains at the expected pre-release commit, and the localized-content audit passed at `4/4/4/4` in the retained review evidence.
- `/root/blog-english-release-20260804` contains the exact invalid partial snapshot recorded in section 22 and has no `SHA256SUMS`.
- No local source transfer, detached candidate, candidate worktree, or release bundle exists.
- The round-5 retry executable remains blocked and must not be executed.

This documentation correction changes no implementation plan, runbook, code, test, production file, production state, ignored historical evidence, or release artifact. It authorizes no spike execution or artifact acquisition by itself, no validation, no implementation planning, and no production access or action.

## 2. Decision summary

Each governed remote attempt is owned by deterministic transient systemd services on the production host:

1. One transient controller service owns orchestration, the global run lock, durable reconciliation, phase creation, cancellation, and run classification.
2. One transient mutator service owns maintenance enablement, PM2 stop, invalid-partial quarantine, and fresh snapshot creation.
3. One or, only for a closed retry class, two transient restoration services restore and verify the old public service.
4. Every phase is bound to the exact controller unit through reviewed `BindsTo=` and `After=` dependencies, and to the controller's exact `InvocationID` through immutable records and gate checks.
5. Every phase uses `Type=exec`, `ExitType=cgroup`, `RemainAfterExit=no`, `Restart=no`, `Delegate=yes`, `DelegateSubgroup=worker`, pinned `CollectMode=inactive`, one non-optional `ExecStartPre`, and an exact common `ExecStopPost` finalizer.
6. A `B`-content-pinned and `I_U`-installation-bound static first-exec guard is the first executable for controller `ExecStart`, phase `ExecStartPre`, phase `ExecStart`, and phase `ExecStopPost`. It validates hostile raw environment bytes before clean `execve`; `/usr/bin/env -i` is not the pre-first-exec boundary.
7. A D-Bus reply, returned job path, or transient-creation acknowledgement is request evidence only. PID 1 may proceed to a mutation-capable phase main only after `ExecStartPre` durably creates the exact invocation's immutable `EXECUTION_GATE_COMMITTED` record.
8. The execution gate and a phase-gate-linearized `START_WINDOW_CLOSED` record are mutually exclusive. The controller may make one byte-identical request reissue, but a late pre-start process can neither cross a durable closure nor create a second execution gate.
9. The phase main process and all descendants execute in `${ControlGroup}/worker`; systemd control processes, including pre-start and finalizer processes, execute in `${ControlGroup}/.control`.
10. While alive in `.control`, the finalizer proves the execution-gate-bound `worker` subgroup recursively empty and durably records that observation before the unit root can be pruned. Every gate-committed invocation requires this witness and path-specific terminal reconciliation, even if `BOUND` is absent.
11. Every PM2 or Nginx operation delegated outside the phase cgroup has immutable `BEGIN` and exact matching `QUIESCED` records. An unmatched `BEGIN` prevents a full fence; timeout or later polling never manufactures closure.
12. A root-only per-phase gate linearizes the execution gate or start closure, binding, entry, cancellation, every production mutation, and every delegated dispatch through durable completion.
13. The controller retains the global run lock across the complete normal mutator/restoration interval and never releases it between phases.
14. Boot identity is durable and mandatory. A run never crosses a boot.
15. Loaded and unloaded terminal evidence are reconciled through closed path-specific matrices. A valid finalizer witness remains the process proof; there is no universal post-finalizer `JobRemoved` requirement, and unloaded inference is limited to one successful inactive family under pinned `CollectMode=inactive`.
16. Identity construction is a forward-only graph: reviewed base manifest `B` -> base hash `H_B` -> run identity `R` -> run layout `L`, followed only downstream by installation/tool receipts, controller reservation/start/invocation descriptors, phase context/request descriptors, request ordinals, worker receipts, and operation endpoint receipts.
17. Target-created device/inode identities are never inputs to `B`, `H_B`, `R`, or `L`. They are captured only in immutable target-local receipts after the referenced object exists, and no receipt changes the run ID.
18. The present unknown canonical encoder, same-open-file execution mechanism, guard bytes/toolchain, complete transient arrays, exact PM2 private interface/parser, exact Nginx generation/config-read algorithm, target tuples, and tighter deadline choices are candidate outputs of a separately authorized nonproduction architecture spike. They are not selected or approved by this charter.
19. The mandatory lifecycle is charter -> fresh dual review and user re-review -> separately authorized spike -> revised final implementation design -> fresh dual approval and user re-review -> validation of frozen selections -> independent validation-artifact acceptance -> implementation-plan writing.
20. Client and transport results never prove phase completion, external-operation completion, fencing, restoration, or run success.

The design distinguishes two safety states:

- `PROCESS_TERMINAL_WITNESSED`: the finalizer has proved that the phase's mutation-capable main process and all descendants are absent from the exact bound `worker` subgroup and has durably recorded the proof.
- `FENCE_PROVED`: `PROCESS_TERMINAL_WITNESSED` plus exact unit/result reconciliation, unchanged boot identity, valid marker invariants, cancellation linearization when applicable, and closure of every externally delegated PM2/Nginx operation.

A missing unit or cgroup pathname after a valid durable witness is neutral by itself and never process proof; only section 17's conjunctive successful-unloaded tuple permits a narrow negative inference about retained failed state. A unit or subgroup that disappears before the witness makes automatic fencing unavailable.

## 3. Goals

The design must:

- prevent mutator/restoration overlap after timeout, disconnect, lost acknowledgement, client death, controller death, delayed launch, or cancellation;
- bind every run, controller, phase, process group, result, external operation, and transition to exact identities;
- obtain recursive process-terminal evidence before systemd can prune an empty phase cgroup;
- prevent a late PM2 or Nginx action from taking effect after a claimed fence;
- keep root-only durable state that a same-run controller can reconcile without rerunning a gate-committed phase;
- serialize cooperating Task 5 control through one controller-owned global `flock` interval plus immutable state and per-phase gates;
- distinguish request evidence, the one durable pre-main execution gate, `BOUND`, `ENTERED`, process witness, and path-specific terminal reconciliation;
- preserve the exact current invalid partial before any fresh snapshot publication;
- require restoration after every fully fenced mutator invocation that reached `ENTERED`; permit no-mutation closure only for a fully fenced pre-`ENTERED` mutator with no delegated-operation or production record;
- fail closed when process, delegate, identity, boot, evidence, result, or restoration proof is unavailable;
- preserve all original Task 5 transfer, detached-candidate, taxonomy, opaque-config, evidence, and release boundaries;
- make every identity descriptor constructible in one forward pass, with canonical encoding, explicit edges, no own-digest field, no descendant back edge, and no receipt feedback into the run ID;
- limit this revision to a bounded nonproduction architecture-spike charter whose outputs are untrusted candidate artifacts;
- require a revised final implementation design to incorporate exact selected spike outputs, then fresh dual approval and user re-review before a separate validation gate may measure the frozen selections;
- permit implementation-plan writing only after independent acceptance of matching validation artifacts, followed later by implementation review and production authorization.

## 4. Non-goals and prohibited effects

This design does not:

- authorize production execution, SSH, SCP, public probing, transient-unit creation, PM2 or Nginx mutation, backup, snapshot, transfer, publication, deployment, deletion, cleanup, or push;
- authorize the architecture spike itself, production artifact retrieval, exact-target access, credentials, raw environment capture, opaque-data access, or shared-state writes; every future spike and artifact source requires separate explicit authority;
- adopt spike prototypes, candidate guard/parser/helper bytes, or candidate descriptors as production-shaped implementation inputs or approved artifacts;
- write an implementation plan or production runbook, claim that a spike passed validation, or claim that this charter is the final implementation design;
- change the English release product scope, translation rules, taxonomy behavior, publication flow, Task 5 candidate outputs, or later release tasks;
- edit or replace the original release design, implementation plan, runbook, scripts, tests, production configuration, or retained historical evidence;
- install a permanent daemon or static/enabled service, timer, socket, path unit, package, boot-recovery mechanism, Nginx configuration change, or PM2 configuration change;
- make `ecosystem.config.js` or `pm2_env` readable, serializable, transferable as evidence, or non-opaque;
- trust SSH/client lifetime, transport acknowledgement, PID-only evidence, process-name searches, a stop command return, or later unit/cgroup absence;
- automatically continue a run after reboot;
- automatically clean failed units, markers, witnesses, operation records, quarantine, backups, staging, or local partial evidence.

## 5. Threat model and trust boundary

### 5.1 Trusted components

This one-time protocol trusts:

- the production kernel, procfs, unified cgroup v2 hierarchy, and filesystem atomicity/fsync durability primitives;
- systemd v255 PID 1, its D-Bus API, transient-unit behavior, service control-process placement, and job/result reporting;
- only the exact root-owned guard/helpers/launchers/scripts/finalizer, system tools, Node/PM2/Nginx binaries/interfaces/config identities, descriptor encoders, and validation tools that a later final implementation design freezes, fresh independent reviewers and the user approve, and a separate validation gate confirms without modification;
- the approved Git, maintenance, snapshot, candidate, taxonomy, secret, and opaque-configuration boundaries;
- exclusive governed privileged change ownership from `RUN_RESERVED` until a terminal run marker.

### 5.2 Not trusted

The protocol does not trust:

- SSH or client lifetime, status, buffering, or acknowledgement;
- transport success or failure as evidence of remote completion;
- a PID without start-time and executable/owner identity;
- unprivileged application processes;
- the mutable `active-run` pointer;
- unsanitized command output;
- every architecture-spike prototype, candidate byte sequence, candidate interface, candidate descriptor encoding, and candidate target observation until incorporated into a later final design and then independently approved and validated;
- polling alone as replacement for a lost external-manager acknowledgement.

### 5.3 Explicitly out of scope

The protocol does not claim safety against:

- a malicious or compromised root user, kernel, PID 1, Nginx, PM2, or reviewed toolchain after validation;
- privileged cgroup migration or replacement of immutable marker/evidence files;
- storage that violates the assumed atomic-create, rename, and fsync semantics.

From reservation to terminal run state, uncoordinated root, `systemctl`, PM2, Nginx, Task-5-path, tool, or cgroup activity is unsupported. Unexpected jobs, identity changes, file drift, cgroup movement, or unexplained lock ownership creates `FAULT_PENDING`. Productive forward progress stops; automation may perform only exact containment, witness/fence construction, and an already-authorized restoration path needed to reach a safe terminal result. A trusted-boundary violation ends in `OPERATOR_REQUIRED`.

## 6. Eventual platform requirements and semantic basis

This charter preserves the eventual load-bearing requirements but does not claim that their exact bytes, arrays, private interfaces, target tuples, or artifact identities are already selected. A separately authorized architecture spike may propose candidates. A later final implementation design must freeze exact selections, receive fresh independent security and architecture approval plus user re-review, and only then undergo validation without redesign.

The eventual final design requires:

- Linux with systemd exactly version 255 for the reviewed deployment target, running as PID 1 with unified cgroup v2;
- transient services, `Type=exec`, `ExitType=cgroup`, `InvocationID`, `ControlGroupId`, `Delegate=`, `DelegateSubgroup=`, `BindsTo=`, `After=`, non-optional `ExecStartPre=`, `ExecStopPost=`, `TimeoutStartSec=10s`, `CollectMode=inactive`, and the required D-Bus job/property APIs;
- a reviewed root-owned filesystem location with atomic exclusive create, atomic no-replace rename, and file/directory fsync behavior;
- one final-design-pinned static first-exec guard satisfying section 10 for controller `ExecStart`, phase `ExecStartPre`, phase `ExecStart`, and phase `ExecStopPost`;
- the previously reviewed maintenance no-store prerequisite, exact inactive site, retained maintenance backups, expected production Git boundary, loopback listener, passing audit, empty operation registry, and sufficient disk;
- the exact current invalid-partial identity in section 22;
- one final-design-frozen PM2 existing-daemon-only RPC interface meeting section 13's no-auto-spawn and no-`pm2_env` rules;
- one final-design-frozen Nginx reload/generation interface binding the exact D-Bus job to a disjoint new generation and complete old-worker absence;
- the acyclic identity graph and receipt model in sections 7-13.

The load-bearing semantics remain:

- `Type=exec` reports process setup and executable failures rather than treating a pre-`execve` fork as successful start; its acknowledgement is still only request/job evidence.
- One exact non-optional `ExecStartPre=` must complete successfully before PID 1 may invoke phase `ExecStart=`. Its durable `EXECUTION_GATE_COMMITTED` record, not the D-Bus reply, is the conservative pre-main boundary.
- `ExitType=cgroup` keeps a phase running while any process remains in its service cgroup.
- `DelegateSubgroup=worker` places the main service process and descendants in the delegated `worker` subgroup while systemd control processes, including `ExecStartPre` and `ExecStopPost`, run in `.control`.
- `KillMode=control-group` with the fixed signal policy contains all phase-owned processes.
- `Restart=no` prevents manager-driven re-entry.
- `RemainAfterExit=no` permits successful units to become inactive and transient units/cgroups to be pruned after finalization.
- `CollectMode=inactive` retains failed units but permits successful inactive units to unload; the design relies only on section 17's narrow successful-unloaded inference.
- cgroup v2 `cgroup.events` reports recursive `populated 0` for an existing cgroup and descendants.
- later pathname or unit absence is never process proof and never rehabilitates a missing or invalid witness.

The architecture spike in section 26 may produce candidates for the unknown interfaces and bytes only. It cannot approve them. The separate later validation gate may execute and measure only the exact selections already frozen in an approved final design; any mismatch returns to final-design revision and fresh review before planning.

## 7. Canonical acyclic identity graph

### 7.1 Canonical descriptor encoding

Every reviewed descriptor uses one exact candidate encoding so the graph is constructible without implementation discretion:

- UTF-8, LF-only, one record per line, with no comment, CR, NUL, TAB, duplicate key, unknown key, timestamp, random value, secret, opaque configuration content, or host-fetched secret data;
- records sorted by unsigned bytewise ASCII key order;
- each record is `<key>=<decimal-byte-length>:<value>\n`, where the length is the UTF-8 byte length of `value`, and decimal integers have no leading zero except `0`;
- arrays use `<name>.count` plus zero-padded ordinal keys such as `<name>.000000` and `<name>.000001`; array order is semantic and is never sorted after construction;
- hashes are lowercase 64-hex SHA-256 of the exact referenced descriptor bytes;
- paths are absolute UTF-8 strings with no control bytes; command arguments are nonempty NUL-free strings with no shell interpretation;
- symbolic templates use a closed typed slot set encoded as records, not textual shell placeholders; every slot has one declared type and exactly one permitted resolving layer;
- a descriptor never contains its own digest. Its digest exists only in a downstream parent/reference record. Unknown fields and noncanonical encodings fail closed.

This encoding is a spike candidate, not an approved implementation interface. If the spike proves it ambiguous for an exact D-Bus property or command value, the spike returns a candidate replacement encoding and test vectors. A later final design must freeze one exact encoding before validation; validation may not invent or modify it.

### 7.2 Base, run, layout, controller, phase, and receipt nodes

| Node | Canonical artifact | May contain | Must not contain |
|---|---|---|---|
| `B` | `review.base.manifest` | Exact candidate artifact content hashes/sizes; logical install paths; required file type/owner/mode and `nlink=1`; build/toolchain provenance; feature HEAD `1ee3fbc3ebc43f552d3f592bf41d79751ca6a731`; expected production HEAD `860bfe53e54dff4ab78bbfa2f7e5f644a032b9aa`; schema/deadline constants; typed command/property/environment templates; approved target binary/config content identities once known; section 22 invalid-partial rows and maintenance identities | `H_B`, `RUN_ID`, run-resolved absolute paths, concrete controller/phase command arrays, transient request bytes, boot ID, invocation ID, target dev/inode, receipt hash, or any digest derived from `B` |
| `H_B` | base-manifest SHA-256 | `SHA-256(B bytes)` | Any additional input |
| `R` | `run.id` | `run_id = "t5-20260804-" + lowercase_hex(H_B)` and `base_manifest_sha256=H_B` | Any target-local value or downstream digest |
| `L` | `run-layout.descriptor` | `B`, `H_B`, `R`; deterministic unit names; run-scoped absolute paths; run-only-resolved templates; descriptor/receipt locations | `H_L`, boot/invocation values, target dev/inode, concrete controller/phase arrays, receipt hashes |
| `I_U` | uploaded-bundle installation receipt set | `H_B`, `R`, `H_L`; final published path; opened-file dev/inode/type/nlink/owner/mode/size/content hash; pre/post-open stat tuple | Any input to `H_B`, `R`, or `H_L` |
| `I_T` | existing target binary/config receipt set | Approved content identities from `B`; target path and opened-object dev/inode/type/nlink/owner/mode/size/content hash for Node/PM2/Nginx/system tools/config objects after they exist | PM2 live socket identity, worker cgroup identity, or any feedback into `R` |
| `C0` | controller reservation descriptor | `H_B`, `R`, `H_L`, `H_IU`, `H_IT`, authoritative boot ID, controller unit/path names, lock/reservation paths, controller template role | Concrete controller array, `H_C0`, controller invocation ID |
| `C1` | controller start descriptor | `C0`/`H_C0`; exact concrete controller `ExecStart`; exact complete controller property, environment, and dependency arrays; exact canonical controller request definition | `H_C1`, any controller invocation ID not yet allocated, or any digest computed from `C1` inside its own array |
| `C2` | controller invocation record | `H_C1`, actual systemd controller `InvocationID`, exact read-back, boot identity, manager timestamps, controller `ControlGroup`/`ControlGroupId` | Modification of `C1` or feedback to an ancestor |
| `P0[p]` | phase context descriptor for phase/attempt `p` | `H_B`, `R`, `H_L`, `H_IU`, `H_IT`, `H_C1`, `H_C2`, boot ID, phase/attempt, phase/controller names and actual controller invocation, all exact marker/gate/result/witness paths, role/script identities | Concrete phase command/property arrays, `H_P0[p]`, phase invocation ID, PM2 socket inode, worker inode |
| `P1[p]` | phase request descriptor for `p` | `P0[p]`/`H_P0[p]`; exact concrete `ExecStartPre`, `ExecStart`, `ExecStopPost`; exact complete phase property/environment/dependency arrays; one ordinal-independent canonical transient request definition | `H_P1[p]`, request ordinal, phase `InvocationID`, worker inode, or a request-set digest derived from `P1[p]` inside its own arrays |
| `Q[p,n]` | request ordinal record, `n` in `{1,2}` | `H_P1[p]`, exact request bytes/hash, ordinal, dispatch/job evidence | Any changed property/array between ordinals or any authorization claim from the reply |
| `W[p]` | worker runtime receipt | `H_P1[p]`, actual phase invocation, `ControlGroup`/`ControlGroupId`, opened `worker` dev/inode, no-symlink traversal evidence, pre/post identity checks | Any upstream identity input |
| `M[o]` | PM2 operation endpoint/runtime receipt | `H_IT`, phase/request identity, exact live socket dev/inode/mode/owner, daemon PID/start/executable/version/UID, operation ID, and before/after samples | Base/run identity input, `pm2_env`, or opaque response content |

`H_L`, `H_IU`, `H_IT`, `H_C0`, `H_C1`, `H_C2`, `H_P0[p]`, and `H_P1[p]` are SHA-256 of the corresponding exact canonical bytes. A digest is stored only in a later node or immutable citation record, never inside the bytes it hashes.

### 7.3 Explicit dependency edges and topological order

An arrow means “is an input to construction of”:

```text
B -> H_B -> R
(B, H_B, R) -> L -> H_L
(B, R, H_L, uploaded final objects) -> I_U -> H_IU
(B, approved target objects) -> I_T -> H_IT
(H_B, R, H_L, H_IU, H_IT, boot) -> C0 -> H_C0
(C0, H_C0, controller template) -> C1 -> H_C1
(C1, H_C1, systemd-created controller runtime) -> C2 -> H_C2
(H_B, R, H_L, H_IU, H_IT, H_C1, H_C2, phase constants) -> P0[p] -> H_P0[p]
(P0[p], H_P0[p], phase templates) -> P1[p] -> H_P1[p]
(P1[p], H_P1[p], ordinal n) -> Q[p,n]
(P1[p], systemd-created phase runtime) -> W[p]
(I_T, P1[p], live PM2 endpoint/daemon) -> M[o]
```

No receipt, controller/phase descriptor, invocation, request, or runtime record has an edge back to `B`, `H_B`, `R`, or `L`. There is no edge from `H_C1` to `C1`, from `H_P1[p]` to `P1[p]`, or from a runtime receipt to its ancestor descriptor.

### 7.4 Templates, concrete arrays, and permitted hash citations

| Layer | Command representation | Hashes commands may carry |
|---|---|---|
| Base manifest `B` | Typed symbolic templates only; fixes literals, slot names/types, array order, role, and expected executable content identities | No `H_B`, run ID, target receipt, or downstream digest |
| Run layout `L` | Run-only-resolved templates; resolves `RUN_ID`, base hash, deterministic unit names, and run-scoped paths while boot/invocation/receipt/runtime slots remain typed | `H_B` and `RUN_ID`; never `H_L` |
| Controller reservation `C0` | Context only; no concrete systemd command array | `H_B`, `H_L`, `H_IU`, `H_IT`; never `H_C0` |
| Controller start `C1` | Exact concrete controller `ExecStart` and every complete property/environment/dependency array; command identifies `C0` by `H_C0` | Ancestor hashes including `H_C0`; never `H_C1`. Request and controller invocation records cite `H_C1` externally |
| Phase context `P0[p]` | Context only; no concrete phase command array | Ancestor hashes only; never `H_P0[p]` |
| Phase request `P1[p]` | Exact concrete `ExecStartPre`, `ExecStart`, `ExecStopPost` and every complete phase property/environment/dependency array; commands carry `H_P0[p]` and exact context paths | Ancestor hashes including `H_P0[p]`; never `H_P1[p]`. Request/gate/bound/result/witness/reconciliation records cite `H_P1[p]` externally |

Concrete commands use explicit `--base-manifest-hash`, `--run-layout-hash`, and applicable ancestor-context/receipt references. No concrete array contains a hash computed over the descriptor containing that array. A downstream request-set hash may equal `H_P1[p]`; it is cited by `Q[p,n]` and later records, never carried inside `P1[p]` arrays.

### 7.5 Forward-only construction sequence

1. A future revised final design freezes candidate artifact bytes/interfaces, schemas, templates, encoding, receipts, and target choices produced by the spike; fresh dual approval and user re-review precede validation.
2. For a later reviewed implementation bundle, generate canonical `B`; compute `H_B`; derive `R`; generate `L` and `H_L`. This completes the pre-upload identity root.
3. Upload only regular files to unique staging basenames through the fixed bootstrap, compare content/type/path/mode/owner/size against `B`, and publish the absent run bundle without replacement.
4. After final objects exist at final paths, open and revalidate them and create `I_U`; inventory approved pre-existing tools/config objects and create `I_T`. Neither receipt changes `B`, `H_B`, `R`, or `L`.
5. Read and validate authoritative boot identity; construct `C0`, `H_C0`, then exact `C1`, `H_C1`; fsync the controller start request before dispatch.
6. After systemd allocates the controller invocation, verify exact read-back and create `C2`, `H_C2`.
7. For each phase/attempt, construct `P0[p]`, `H_P0[p]`, then exact ordinal-independent `P1[p]`, `H_P1[p]`.
8. Request ordinals 1 and 2 cite the same `P1[p]` bytes and `H_P1[p]`; only ordinal/job evidence differs.
9. `ExecStartPre` creates `W[p]` only after the exact worker object exists. Execution-gate, bound, result, finalizer-witness, and reconciliation records cite `H_P1[p]` and `W[p]` without changing an ancestor.
10. Each PM2 operation creates/revalidates `M[o]` after the socket and daemon exist. Nginx operation records analogously bind live master/config/generation observations downstream of `P1[p]`.

### 7.6 No-self-containment obligations

The spike graph checker and later validation must reject every violation:

- `B` contains no `H_B`, `RUN_ID`, resolved run path/unit, target receipt, concrete command array, request bytes, boot ID, invocation ID, or target dev/inode.
- `L` contains no `H_L`, target receipt, boot/invocation value, or concrete controller/phase array.
- `C0`, `C1`, `C2`, `P0[p]`, and `P1[p]` contain no digest of their own bytes.
- No command/property/environment/dependency array contains a digest computed over a descriptor containing that array.
- `C1` arrays may cite `H_C0`; controller request/invocation records cite `H_C1` externally.
- `P1[p]` arrays may cite `H_P0[p]`; request/gate/bound/result/witness records cite `H_P1[p]` externally.
- Installation/tool/socket/worker receipts are downstream evidence only and never ancestors of `H_B` or `R`.
- Request ordinal is not part of `P1[p]`; ordinals 1 and 2 use byte-identical transient requests.
- A graph-generation check rejects every back edge and proves the topological order in section 7.5.

Any later implementation byte, dependency, environment field, property, path, deadline, target content identity, or selected interface change requires a new `B`, new `H_B`, new run ID, and fresh review. Target-local receipt changes fail the affected run but never recompute its identity. A terminal production outcome is never rerun in place under the same run ID.

## 8. Exact names, boot identity, and immutable identity records

### 8.1 Unit names

For `${RUN_ID}`, the exact transient unit names are:

- controller: `blog-task5-${RUN_ID}-controller.service`
- mutator: `blog-task5-${RUN_ID}-mutator.service`
- restoration attempt 1: `blog-task5-${RUN_ID}-restore-1.service`
- restoration attempt 2: `blog-task5-${RUN_ID}-restore-2.service`

No aliases, templates, wildcard targets, scopes, user units, or alternate names are allowed. The controller reads `ControlGroup`; it never guesses the escaped cgroup path.

### 8.2 Authoritative boot ID

`010-RUN_RESERVED` establishes the authoritative boot ID by reading `/proc/sys/kernel/random/boot_id`, strictly validating UUID syntax, removing hyphens, and storing exactly 32 lowercase hexadecimal characters.

The boot ID is included in every:

- controller invocation record;
- phase intent, each start-request ordinal, execution-gate or start-window-closure, bound, entered, result, terminal witness, fence, and outcome/classification record;
- cancellation, fault, delegated-operation, restoration-verification, and terminal run record;
- reconciliation read and evidence digest.

Every actor reads and compares the boot ID:

1. before querying or creating any unit;
2. after acquiring the global run lock or any phase gate;
3. immediately before every transition marker, delegated-operation record, witness acceptance, fence, classification, restoration, or production mutation.

Any boot-ID change after reservation creates terminal `OPERATOR_REQUIRED` with `reason=BOOT_ID_CHANGED`. It suppresses lost-start reissue, unit adoption or stop, witness acceptance, fence creation, restoration, and every production mutation. A run never spans boots.

### 8.3 Invocation and controller coupling identity

Every controller and phase start receives a systemd-generated 32-lowercase-hex `InvocationID`. Controller and phase records cite exact graph layers rather than an ambiguous single hash.

A phase binding names:

- run ID, `base_manifest_sha256=H_B`, and `run_layout_descriptor_sha256=H_L`;
- uploaded installation receipt-set hash `H_IU` and existing target-tool receipt-set hash `H_IT`;
- authoritative boot ID;
- controller start descriptor hash `H_C1`, controller invocation-record hash `H_C2`, controller unit, and actual controller `InvocationID`;
- exact phase and attempt, phase-context descriptor hash `H_P0[p]`, phase-request descriptor hash `H_P1[p]`, phase unit, and actual phase `InvocationID` when allocated;
- exact canonical transient-definition/property block identity from `P1[p]`;
- exact uploaded artifact, target tool/config, and worker receipt hashes applicable to the phase;
- exact request ordinal evidence and execution-gate or start-window-closure identity when either exists.

A same-name unit with a different invocation is a conflict. A new same-run controller invocation is a downstream reconciliation actor with a new invocation record, not a continuation of the prior invocation, and never changes `B`, `R`, `L`, `C1`, or a phase request descriptor.

### 8.4 Request and execution identity

Each phase has request ordinal 1 and at most one ordinal 2. Before dispatch, the controller fsyncs `Q[p,n]`, which cites the same ordinal-independent `P1[p]` bytes and `H_P1[p]`; only ordinal and job evidence differ. Returned D-Bus reply status and job ID/path remain request evidence only and do not prove historical manager acceptance, main execution, completion, or no mutation.

`EXECUTION_GATE_COMMITTED` binds the actual systemd-generated phase `InvocationID` to `H_B`, `R`, `H_L`, `H_IU`, `H_IT`, `H_C1`, `H_C2`, `H_P0[p]`, `H_P1[p]`, the canonical phase transient-definition block, authoritative boot, deterministic unit, controller unit/invocation, `ControlGroup`/`ControlGroupId`, worker runtime receipt `W[p]`, applicable artifact/tool receipts, phase-gate identity, and marker-state digest. Only this record permits conservative inference that PID 1 may execute the phase main.

`START_WINDOW_CLOSED` cites the same ancestor graph and both request records, plus the fresh deterministic-name, every-known-invocation, and no-current-job lookup evidence required by sections 16 and 20.1. It proves that every late pre-start must fail before main. Gate and closure remain mutually exclusive under the phase gate.

## 9. Root-only paths and permissions

The durable root is:

`/var/lib/blog/task-5-systemd-fencing`

Required layout:

- `global.lock` — controller-owned advisory lock file, root:root `0600`;
- `active-run` — atomically updated convenience pointer, never authoritative;
- `incoming/${RUN_ID}/` — upload staging, root:root `0700`;
- `runs/${RUN_ID}/bundle/` — verified immutable later implementation bundle, root:root `0700`;
- `runs/${RUN_ID}/identity/review.base.manifest` — exact canonical `B` bytes;
- `runs/${RUN_ID}/identity/run.id` — exact canonical `R` bytes;
- `runs/${RUN_ID}/identity/run-layout.descriptor` — exact canonical `L` bytes;
- `runs/${RUN_ID}/receipts/uploaded-bundle.receipt-set` — exact canonical `I_U` bytes;
- `runs/${RUN_ID}/receipts/target-tools.receipt-set` — exact canonical `I_T` bytes;
- `runs/${RUN_ID}/controller/controller-reservation.descriptor` — exact canonical `C0` bytes;
- `runs/${RUN_ID}/controller/controller-start.descriptor` — exact canonical `C1` bytes;
- `runs/${RUN_ID}/controller-invocations/` — one immutable `C2` record per controller runtime cycle;
- `runs/${RUN_ID}/phases/${PHASE}/phase-context.descriptor` — exact canonical `P0[p]` bytes for each phase/attempt;
- `runs/${RUN_ID}/phases/${PHASE}/phase-request.descriptor` — exact canonical `P1[p]` bytes for each phase/attempt;
- `runs/${RUN_ID}/phase-invocations/` — actual phase invocation bindings and `W[p]` worker receipts;
- `runs/${RUN_ID}/operation-receipts/` — operation-scoped PM2 endpoint/runtime receipts and Nginx live-observation records;
- `runs/${RUN_ID}/markers/` — immutable transition records, root:root `0700`;
- `runs/${RUN_ID}/gates/` — one lock file per phase, root:root `0700` directory and `0600` files;
- `runs/${RUN_ID}/evidence/` — sanitized property, job, operation, witness, result, receipt, and later validation evidence, root:root `0700`.

Base/run/layout artifacts, descriptors, receipts, records, and evidence files are root:root `0600` and become immutable after exclusive creation and file/parent fsync. Executable bundle files are root:root `0500`. No symlink, hardlink, device, FIFO, socket, group/other-writable directory, unknown descriptor field, or unexpected entry is accepted in the governed tree.

All transient units run with `User=root`, `Group=root`, and `UMask=0077`. No durable state is stored under `/tmp`, `/private/tmp`, a home directory, the Git checkout, the journal alone, or the production release tree.

The production release and quarantine paths remain:

- canonical release: `/root/blog-english-release-20260804`
- invalid-partial quarantine: `/root/blog-english-release-20260804.failed-${RUN_ID}`

The quarantine destination must be absent and is created only by the reviewed atomic no-replace whole-root rename.

### 9.1 Forward upload, installation, and controller-start provenance

This charter authorizes none of these later actions. After the spike, final-design approval, frozen validation, validation-artifact acceptance, implementation planning, implementation, the required static/integration suites, and implementation review, a later implementation-bundle identity may be generated locally and independently reviewed in step 1 below. Steps 2-10 require subsequent separate production authorization. The governed construction order is:

1. review canonical base bytes `B` locally; compute `H_B`; derive `R`; construct `L` and `H_L`; verify the graph's topological order before upload;
2. a fixed bootstrap using only already-reviewed absolute tools creates absent `incoming/${RUN_ID}` as root:root `0700`;
3. transfer regular files to unique staging basenames, never as standard-input code, a here-document, a pipe, `/tmp`, or an unverified execution path;
4. before uploaded code executes, the fixed bootstrap compares content hash, final logical path, type, `nlink=1`, mode, owner, and size against `B`; no target dev/inode is expected or consumed at this stage;
5. inventory every entry without following symlinks, reject extras and unsafe types, recompute `H_B` and `R`, and require the requested run path/unit-name identity;
6. atomically publish the absent verified bundle without replacement as `runs/${RUN_ID}/bundle`;
7. only after final objects exist at final paths, traverse from an open trusted root without following symlinks, open each final object, hash from that same open object, capture and recheck its dev/inode/type/nlink/owner/mode/size/content tuple, and exclusively create/fsync `I_U`;
8. separately open/revalidate approved pre-existing Node/PM2/Nginx/system tools/config objects against content identities already in `B`, then exclusively create/fsync `I_T`; live PM2 socket and worker cgroup identities are not part of either set;
9. before controller request creation, re-open every required uploaded/target object and require exact receipt equality; then create `C0`, `H_C0`, exact `C1`, and `H_C1`, and fsync the controller request before dispatch;
10. no production mutation occurs before controller-side and phase-side identity, graph, descriptor, receipt, boot, unit, and gate checks pass.

Target inode binding happens only after final publication and never changes `B`, `H_B`, `R`, or `L`. No credential, token, cookie, password, raw environment, opaque ecosystem content, or secret-bearing value appears in any base/run/layout artifact, descriptor, receipt, upload path, unit name, command line, journal identifier, marker, or evidence.

## 10. Pre-first-exec environment and command provenance

Every transient creation path uses either `systemd-run --expand-environment=no` or exact D-Bus command arrays with no client, manager, or shell interpolation. `--wait`, `--pipe`, and `--collect` remain forbidden. Unit-property read-back strengthens this contract but does not by itself prove the complete manager-compiled environment.

### 10.1 Static first-exec guard

All four systemd entry classes eventually begin with the same final-design-pinned static guard binary in a fixed role mode. `B` pins its content/build/path/type/mode/owner requirements, while `I_U` binds the installed target object after publication:

1. controller `ExecStart`;
2. phase `ExecStartPre` execution gate;
3. phase `ExecStart` main launcher;
4. phase `ExecStopPost` finalizer launcher.

The exact guard path is:

`/var/lib/blog/task-5-systemd-fencing/runs/${RUN_ID}/bundle/bin/task5-first-exec-guard`

Its role is limited to validating hostile raw `envp` before any environment-controlled code loading, validating fixed argv and systemd identity, verifying the exact next-stage path and bytes, constructing the exact clean `envp`, and directly `execve`-ing that next stage. It creates no marker, child, fork, background process, network activity, or production effect. The pre-start helper, controller launcher, phase launcher, and finalizer remain separate reviewed next stages.

The later final design must freeze guard content/build/path/type/mode/owner/size requirements and prove ELF `ET_EXEC` or static-PIE `ET_DYN`, no `PT_INTERP`, `DT_NEEDED`, `RPATH`, or `RUNPATH`, no dynamic-loader or environment-controlled plugin/module dependency, and custom/freestanding or independently proven startup that does not consult locale, NSS, shell startup, loader tunables, configuration paths, or raw environment before validation. `B` contains those content/build requirements but no target dev/inode. After final publication, `I_U` binds the opened installed guard and next-stage objects to target dev/inode/type/nlink/owner/mode/size/content tuples.

For every sensitive transition, the guard traverses from an already-open trusted root without following symlinks, opens the final object without following a final symlink, requires the exact type and `st_nlink=1`, hashes from that same open object, repeats `fstat` immediately before use, and ensures the object executed is the verified open object rather than a later pathname substitution. The architecture spike must propose a candidate same-open-file execution/read mechanism and bytes; the final design must freeze them; validation may only test the frozen choice. Any path/object/content/dev-inode/link-count/owner/mode/size/receipt mismatch fails closed. Receipts are immutable and never recompute the run ID.

The spike may produce candidate guard source/startup ABI/toolchain/build flags/bytes and hostile-environment evidence. The later frozen-design validation must combine static inspection with negative execution under `LD_PRELOAD`, `LD_AUDIT`, `GLIBC_TUNABLES`, exported shell functions, `BASH_ENV`, `ENV`, `NODE_OPTIONS`, Node/npm variables, and ambient PM2 variables. None may execute or influence guard behavior. A mismatch returns to final-design revision and fresh review rather than changing the validation target.

### 10.2 Typed templates and downstream concrete arrays

The logical next-stage paths are fixed in typed templates in `B` and resolved to these run-scoped absolute paths in `L`:

- pre-start gate helper: `/var/lib/blog/task-5-systemd-fencing/runs/${RUN_ID}/bundle/bin/task5-phase-execution-gate`;
- controller launcher: `/var/lib/blog/task-5-systemd-fencing/runs/${RUN_ID}/bundle/bin/task5-controller-launcher`;
- phase launcher: `/var/lib/blog/task-5-systemd-fencing/runs/${RUN_ID}/bundle/bin/task5-phase-launcher`;
- common finalizer: `/var/lib/blog/task-5-systemd-fencing/runs/${RUN_ID}/bundle/bin/task5-phase-finalizer`.

`B` contains typed symbolic templates only. `L` resolves only `RUN_ID`, `H_B`, deterministic unit names, and run-scoped paths. Boot, invocation, receipt, controller-context, and phase-context slots remain typed. `C0` and `P0[p]` are context descriptors without concrete systemd arrays.

The architecture spike must produce candidate byte-complete controller and phase arrays. A later final design must freeze exact bytes:

- `C1` contains the exact guarded controller `ExecStart` and complete controller property/environment/dependency arrays. The controller command may carry `--run-id`, `--base-manifest-hash`, `--run-layout-hash`, `--installation-receipts-hash`, `--target-tools-receipts-hash`, `--controller-context-hash`, authoritative boot, exact controller unit/path, and exact script path. It may cite `H_C0` but never `H_C1`.
- Each `P1[p]` contains the exact guarded phase `ExecStartPre`, `ExecStart`, and `ExecStopPost` plus complete phase property/environment/dependency arrays. Every phase command may carry `--run-id`, `--base-manifest-hash`, `--run-layout-hash`, applicable receipt-set hashes, `--controller-start-hash`, `--controller-invocation-hash`, `--phase-context-hash`, authoritative boot, exact phase/controller identities and paths, and role-specific gate/result/witness/script paths. It may cite `H_P0[p]` but never `H_P1[p]`.
- `ExecStartPre` contains no request ordinal and no self-derived request-set digest. `Q[p,1]`, optional `Q[p,2]`, execution gate, bound, result, witness, and reconciliation records cite `H_P1[p]` externally.

The final arrays contain no shell metacharacter processing, empty argument, relative path, textual runtime interpolation, own digest, or descendant digest. Their exact canonical bytes are read back and compared with `C1` or `P1[p]`, not with `B`. Controller and phase creation returns remain request evidence only.

After the guard establishes the boundary, launchers may invoke a final-design-frozen `/bin/bash -p --noprofile --norc` next stage with exact absolute script and fixed arguments. `/usr/bin/env -i` remains defense in depth after the guard, never protection for already-started code. Every opened next stage and production tool must match the applicable immutable installation/tool receipt under section 10.1's same-object rule.

### 10.3 Hostile raw environment contract

The guard treats raw `envp` as hostile bytes, never as configuration. It rejects duplicate names, malformed entries, embedded-NUL anomalies, and every unlisted name. It never logs, persists, prints, hashes for evidence, or includes rejected names or values in error output. Evidence contains only the role, generic pass/fail code, entry count, and approved environment-contract digest.

For all four roles, the exact allowed base names and values are:

- `PATH=/usr/sbin:/usr/bin:/sbin:/bin`;
- `LANG=C`;
- `LC_ALL=C`;
- `TZ=UTC`;
- `HOME=/root`;
- `USER=root`;
- `LOGNAME=root`;
- `SHELL=/bin/bash`;
- `INVOCATION_ID` as exactly 32 lowercase hexadecimal characters, later cross-checked through D-Bus;
- optional `SYSTEMD_EXEC_PID`, only when its canonical decimal value equals `getpid()`;
- optional `JOURNAL_STREAM`, only when its documented decimal device/inode pair matches the journal file-descriptor identity.

Only the `phase-finalizer` role may additionally receive `SERVICE_RESULT`, `EXIT_CODE`, and `EXIT_STATUS`, and each may be absent only when the exact v255 target path documents that no main-process value exists. When present, `SERVICE_RESULT` must be one exact v255 documented token from `success`, `protocol`, `timeout`, `exit-code`, `signal`, `core-dump`, `watchdog`, `start-limit-hit`, `resources`, `oom-kill`, or `exec-condition`; `EXIT_CODE` must be `exited`, `killed`, or `dumped`. For `EXIT_CODE=exited`, `EXIT_STATUS` is canonical decimal `0` through `255`; for `killed` or `dumped`, it is the exact canonical signal name emitted by the exact v255 target artifact. The spike may observe a candidate finite signal-name set; the later final design must freeze that set byte-for-byte, and validation may only compare the frozen set before validation-artifact acceptance and planning. The guard passes only these validated values to the clean finalizer.

`PM2_HOME` is rejected at every systemd first-exec boundary. The exact reviewed value is added only inside the already-sanitized PM2 helper path. No other manager, PAM, login, loader, shell, Node, npm, or PM2 variable is permitted.

The contract continues to prohibit `EnvironmentFile` and nonempty `EnvironmentFiles`, `PassEnvironment`, PAM/login environment synthesis, client environment pass-through, nonempty `ExecSearchPath`, command expansion, secret-bearing values, and every unlisted raw variable. The spike must produce candidate complete `Environment`, `UnsetEnvironment`, property, command, and dependency arrays plus sanitized manager-added read-back treatment. The later final design must freeze their exact canonical bytes in `C1` and each `P1[p]`; validation may only compare exact read-back to those descriptors. Runtime and spike evidence never prints raw environment or secret-bearing data.

## 11. Transient-unit topology and properties

### 11.1 Controller unit

The controller unit uses:

| Property | Required value |
|---|---|
| `Type` | `exec` |
| `ExitType` | `cgroup` |
| `KillMode` | `control-group` |
| `KillSignal` | `SIGTERM` |
| `SendSIGKILL` | `yes` |
| `FinalKillSignal` | `SIGKILL` |
| `Restart` | `no` |
| `RemainAfterExit` | `no` |
| `RuntimeMaxSec` | `1800s` controller active/useful-work budget; not a hard wall-clock envelope |
| `TimeoutStopSec` | `60s` |
| `User` / `Group` | `root` / `root` |
| `UMask` | `0077` |
| `WorkingDirectory` | `/` |
| `StandardInput` | `null` |
| `StandardOutput` / `StandardError` | `journal` / `journal` |
| `SetLoginEnvironment` | `no` |
| `ExecStart` | exact final-design-frozen `C1` controller array beginning with the static first-exec guard |

The controller has no manager-driven restart. A later same-run invocation is explicit reconciliation and receives a new `InvocationID`.

### 11.2 Shared phase properties

Every mutator and restoration unit uses:

| Property | Required value |
|---|---|
| `Type` | `exec` |
| `ExitType` | `cgroup` |
| `KillMode` | `control-group` |
| `KillSignal` | `SIGTERM` |
| `SendSIGKILL` | `yes` |
| `FinalKillSignal` | `SIGKILL` |
| `Restart` | `no` |
| `RemainAfterExit` | `no` |
| `CollectMode` | `inactive` |
| `Delegate` | `yes` |
| `DelegateSubgroup` | `worker` |
| `TimeoutStartSec` | `10s` |
| `TimeoutStopSec` | `10s` |
| `User` / `Group` | `root` / `root` |
| `UMask` | `0077` |
| `WorkingDirectory` | `/` |
| `StandardInput` | `null` |
| `StandardOutput` / `StandardError` | `journal` / `journal` |
| `SetLoginEnvironment` | `no` |
| `BindsTo` | exact deterministic controller unit |
| `After` | contains the exact controller unit; complete read-back equals the reviewed dependency array |
| `ExecStartPre` | exactly one non-optional final-design-frozen `P1[p]` execution-gate array beginning with the static guard |
| `ExecStart` | exact final-design-frozen `P1[p]` phase-main array beginning with the static guard |
| `ExecStopPost` | exact final-design-frozen `P1[p]` common-finalizer array beginning with the static guard |

Phase runtimes are:

| Unit | Internal work budget | `RuntimeMaxSec` | Protocol margin |
|---|---:|---:|---:|
| mutator | control `120s` + snapshot `600s` = `720s` | `780s` | `60s` |
| restoration attempt 1 | `180s` | `240s` | `60s` |
| restoration attempt 2 | `180s` | `240s` | `60s` |

The phase main process and every descendant execute in `${ControlGroup}/worker`. Systemd control processes, including `ExecStartPre` and `ExecStopPost`, execute in `${ControlGroup}/.control`. The spike must produce candidate exact-build observations for worker creation and placement. The later final design freezes the selected receipt/placement mechanism, and validation must prove that `W[p]`'s opened worker object is the subgroup into which the final `P1[p]` `ExecStart` is placed. Failure blocks the architecture. No phase process may migrate out of `worker`, create an alternate delegated subgroup, or move an unrelated process into the unit.

### 11.3 Exact descriptor-bound dependency and property read-back

The spike must produce candidate complete canonical controller and phase transient definitions and sanitized exact read-back diffs. A later final design freezes the controller block in `C1` and each phase block in `P1[p]`. Validation and eventual runtime comparison use those descriptor bytes without modification.

Before treating an observed phase unit as matching request evidence or allowing gate/reconciliation handling, the controller reads through systemd D-Bus and requires:

- exact unit ID, canonical name, `Transient=yes`, and exact transient fragment identity;
- exact nonempty phase `InvocationID` and authoritative boot ID;
- exact `BindsTo=` and complete `After=` arrays equal to the canonical dependency arrays in `P1[p]`, including only frozen manager-added dependencies;
- the controller unit loaded with the expected `C2` controller `InvocationID` and no terminal/cancellation state forbidding continuation;
- every property in sections 10-11 equal to the exact canonical `P1[p]` property/environment/command blocks, including `CollectMode=inactive`, one `ExecStartPre`, exact `ExecStart`, exact `ExecStopPost`, `TimeoutStartSec=10s`, runtime/stop deadlines, and `NRestarts=0`;
- exact `ControlGroup`, nonzero `ControlGroupId`, and no unexpected job or dependency;
- a read-back record citing `H_P1[p]`, `H_C1`, and `H_C2` externally. `P1[p]` never contains `H_P1[p]`.

Controller read-back similarly equals `C1`; its request and `C2` invocation record cite `H_C1` externally. The pre-start gate helper performs the first phase identity/property/cgroup/environment check before committing the execution gate. The phase launcher repeats these checks before `BOUND`, before `ENTERED`, and under its gate before every mutation boundary. Any descriptor, receipt, boot, controller, invocation, property, dependency, command, environment, cgroup, or job mismatch stops productive work, creates `FAULT_PENDING`, and permits only exact containment/reconciliation and any already-required restoration path.

`BindsTo=` plus `After=` must stop a live phase when the bound controller becomes inactive. A new controller invocation never cancels that stop or treats old productive work as continuable. The spike may measure candidate target tuples; the final design freezes accepted tuples; validation and later integration must verify controller death before phase entry, during each phase stage, and during finalization, including same-name controller recreation.

## 12. Durable execution gate, phase binding, and finalizer witness

### 12.1 Non-optional pre-main execution gate

Every phase has exactly one non-optional `ExecStartPre=` command. PID 1 may invoke `ExecStart=` only after it exits successfully. The command begins with the static first-exec guard and then executes the reviewed pre-start gate helper in the exact clean environment.

The helper is non-production-mutating. Its allowed effects are limited to exact graph/descriptor/receipt/identity/property/cgroup/environment verification; taking the phase gate; creating or opening the exact `worker` subgroup through no-symlink traversal; exclusively creating/fsyncing runtime worker receipt `W[p]`; proving the final-design-frozen placement contract; exclusively creating/fsyncing `EXECUTION_GATE_COMMITTED`; and writing sanitized evidence inside the governed run tree. It must not touch Nginx, PM2, release paths, Git, snapshot data, listeners, production content, quarantine, external network state, or any later-phase marker.

`W[p]` is created only after systemd exposes the exact phase `ControlGroup` and the exact `worker` object exists. It binds `H_P1[p]`, actual phase invocation, `ControlGroup`/`ControlGroupId`, opened worker dev/inode, no-symlink traversal, and pre/post-open identity. It is runtime evidence, not installation identity, and never feeds `B`, `H_B`, `R`, or `L`.

While holding the phase gate, the helper rechecks boot, `H_C1`, `H_C2`, `H_P0[p]`, `H_P1[p]`, applicable receipt hashes, actual controller/phase identities, exact `P1[p]` properties/arrays, request records, terminal/fault/cancellation state, and absence of `START_WINDOW_CLOSED` and any competing execution gate. It then commits `EXECUTION_GATE_COMMITTED` bound to the actual phase `InvocationID`, exact `ControlGroup`/`ControlGroupId`, `W[p]`, applicable installation/tool receipts, gate identity, and marker-state digest. If it cannot establish and fsync both `W[p]` and the gate record, it exits nonzero and PID 1 must not execute the phase main.

`EXECUTION_GATE_COMMITTED` and `START_WINDOW_CLOSED` are mutually exclusive. A losing duplicate or late pre-start process exits nonzero before main and cannot create `BOUND`, `ENTERED`, or a delegated-operation record. The spike proposes the candidate worker mechanism; the later final design freezes it; validation must prove `W[p]` continuity into `ExecStart` placement or block the architecture.

### 12.2 Phase bound and entered records

The immutable phase bound record binds at least:

- run ID, `H_B`, `H_L`, `H_IU`, and `H_IT`;
- authoritative boot ID;
- `H_C1`, `H_C2`, exact controller unit, and actual controller `InvocationID`;
- exact phase/attempt, `H_P0[p]`, `H_P1[p]`, unit name, actual phase `InvocationID`, and `EXECUTION_GATE_COMMITTED` hash;
- exact `ControlGroup` and nonzero `ControlGroupId`;
- worker runtime receipt `W[p]` hash and revalidated opened-worker identity;
- exact canonical transient-definition/read-back hash derived from `P1[p]`;
- applicable uploaded installation and target-tool receipt entries for guard, pre-start helper, launcher, phase script, finalizer, and tools;
- exact expected phase-result path and schema digest;
- exact terminal-witness path and schema digest;
- gate identity and current marker-state digest.

The launcher requires the exact execution gate, takes the phase gate, repeats the complete unit/boot/controller/cgroup/worker/environment/cancellation check, and creates `BOUND`. It creates `ENTERED` under the same gate only after a second complete recheck immediately before productive work. `ENTERED` is the threshold after which mutator production mutation cannot be excluded and restoration becomes mandatory after full fencing.

A gate-committed invocation that fails before `BOUND` remains conservatively execution-capable and must obtain the process witness and path-specific reconciliation below. It may be classified no mutation only after a valid full fence and only when `ENTERED`, every delegated `BEGIN`, and every production record are absent.

### 12.3 Finalizer witness procedure

The exact common `ExecStopPost` finalizer has a `5s` internal deadline inside its fresh outer `TimeoutStopSec=10s` stop-post slot. The static guard validates its raw environment before invoking finalizer code. For every invocation with `EXECUTION_GATE_COMMITTED`, the finalizer must within that deadline:

1. verify fixed `H_B`, `R`, `H_L`, `H_IU`, `H_IT`, `H_C1`, `H_C2`, `H_P0[p]`, `H_P1[p]`, run/phase/unit/controller identities, gate/result/witness paths and schemas, compare authoritative boot, and validate the execution gate and `W[p]`;
2. query the exact unit and require the gate-bound `InvocationID`, `ControlGroup`, nonzero `ControlGroupId`, `Delegate=yes`, `DelegateSubgroup=worker`, `CollectMode=inactive`, exact `P1[p]` canonical transient-definition/read-back equality, and exact guarded finalizer array;
3. require `SubState=stop-post`, `ControlPID` equal to its own PID, and the normalized unified entry in `/proc/self/cgroup` equal to `${ControlGroup}/.control`;
4. open the exact `W[p]` worker object through the final-design-frozen no-symlink operation and require the same dev/inode/type identity;
5. read `worker/cgroup.events`, require exactly one `populated` field with value `0`, and require `worker/cgroup.procs` empty;
6. revalidate the worker subgroup device/inode identity after both reads;
7. capture the validated `SERVICE_RESULT`/`EXIT_CODE`/`EXIT_STATUS`, `Result`, `ExecMainPID`, `ExecMainCode`, `ExecMainStatus`, `ExecMainStartTimestampMonotonic`, `ExecMainExitTimestampMonotonic`, `ActiveState`, `SubState`, `MainPID`, `ControlPID`, `ControlGroup`, `ControlGroupId`, `NRestarts`, and the immutable result record's presence/hash;
8. capture the current exact start/stop job ID, path, type, and state if a job exists; capture previously ledgered job events if available, without requiring a future signal after the finalizer exits;
9. enumerate every phase-owned external-operation `BEGIN`, validate any exact matching `QUIESCED`, and record unmatched operations without claiming closure;
10. exclusively create the immutable terminal witness, fsync the file, and fsync its parent directory;
11. perform no production mutation, delegated operation, marker authorization, or evidence rewrite after the durable witness, then exit.

A valid witness establishes `PROCESS_TERMINAL_WITNESSED` only. It remains the process proof after later cgroup or unit disappearance. `FENCE_PROVED` additionally requires delegate closure, marker/gate consistency, unchanged boot, and one accepted path-specific reconciliation class from section 17.

A missing or malformed witness, wrong finalizer PID/cgroup, changed boot, unit/invocation/property mismatch, nonzero `populated`, nonempty `cgroup.procs`, subgroup recreation, device/inode drift, symlink traversal, contradictory result, or witness-create collision blocks automatic fencing. Finalizer nonzero or signal after witness preserves at most the recorded worker-emptiness fact; it blocks automatic `FENCE_PROVED` as a trusted-finalization failure.

If `ExecStopPost` runs for an invocation that never committed the execution gate, it may write only sanitized pre-gate failure evidence. It must not create `PROCESS_TERMINAL_WITNESSED` or imply that main executed. A valid `START_WINDOW_CLOSED` already proves every late pre-start must fail before main.

### 12.4 Post-witness controller reconciliation

The controller validates the witness while holding the global run lock and after comparing boot identity and marker invariants. A surviving controller subscribes before unit creation and durably ledgers observed `JobNew`, `JobRemoved`, and `UnitRemoved` signals; it may use `RefUnit` during normal reconciliation. These are strengthening observations, not universal correctness prerequisites, because no durable subscriber is guaranteed after controller death.

Loaded and unloaded units use the separate closed matrices in section 17. A loaded path requires exact retained terminal properties. An unloaded path can succeed automatically only for the narrow successful inactive family under pinned `CollectMode=inactive`, a valid witness, and stable dual lookup absence. There is no universal post-finalizer `JobRemoved` requirement. Same-name recreation, worker identity drift, malformed or missing witness, result contradiction, failed-finalizer evidence, or a path outside the closed matrices prevents `FENCE_PROVED`.

## 13. External PM2 and Nginx operation ownership

The phase cgroup does not contain the pre-existing PM2 daemon or Nginx master. The global advisory lock does not identify, contain, or make those actors descendants. Every delegated operation therefore uses immutable operation records and downstream live receipts. The spike may propose candidate exact interfaces; a later final design must freeze them; validation may only exercise the frozen selections.

### 13.1 Common operation record contract

Each operation has one deterministic operation ID bound to `H_B`, `R`, `H_L`, `H_IT`, `H_C1`, `H_C2`, `H_P1[p]`, authoritative boot, phase unit/`InvocationID`, family, sequence, exact target content identity, applicable live receipt, exact request digest, gate identity, stage deadlines, and prior marker digest.

While holding the phase gate, the phase:

1. exclusively creates and file/parent-fsyncs `BEGIN` before dispatch;
2. retains the gate through dispatch, manager acknowledgement, identity-bound completion checks, stable samples, exclusive `QUIESCED` creation, and parent-directory fsync;
3. releases the gate only after durable `QUIESCED` or phase containment interrupts the operation.

An idempotent no-op still receives `BEGIN` and `QUIESCED` with `operation_mode=noop-verified` and the same identity checks. Timeout, process death, target convergence observed after lost acknowledgement, or later polling never manufactures `QUIESCED`.

Required operation families are:

Mutator:

- maintenance/Nginx reload `BEGIN` and `QUIESCED`;
- PM2 stop `BEGIN` and `QUIESCED`.

Each restoration attempt:

- PM2 start/restart `BEGIN` and `QUIESCED`;
- maintenance-open/Nginx reload `BEGIN` and `QUIESCED`.

A `BEGIN` without its exact matching valid `QUIESCED` permanently blocks that phase's `FENCE_PROVED` and automatic restoration. Process containment still starts immediately when required; it does not wait for or infer external closure.

### 13.2 Exact PM2 existing-daemon-only interface

The architecture spike may inspect separately authorized exact artifacts and produce a candidate installed-version existing-daemon-only method, framing, request bytes, `pm_id`, callback boundary/timing, bounded streaming selector, and death/no-late-effect proof strategy. Candidate source/parser/helper bytes remain untrusted spike outputs.

A later final design must incorporate the exact selected Node/PM2 content identities into `B`, the exact target-open binary/module objects into `I_T`, and the exact method/framing/request/parser/helper bytes and interface into frozen descriptors. Fresh dual approval and user re-review precede validation. Validation proves the frozen direct open/connect path cannot call daemon-launch code, `pm2.connect`, fork, spawn, reconnect fallback, or any auto-start path; daemon absence, socket mismatch, version mismatch, permission error, malformed frame, timeout, and reconnect all fail without auto-spawn. Mismatch returns to final-design revision rather than interface selection during validation.

Each PM2 operation creates or cites fresh `M[o]` after the socket and daemon exist. It binds:

- `H_IT` and the approved opened Node/PM2 binary/module receipt entries;
- exact reviewed `PM2_HOME`, added only inside the sanitized helper path;
- exact live RPC socket path, dev/inode/type/mode/owner;
- daemon PID plus `/proc/PID/stat` start time, executable identity, UID, and version;
- the sole preflight application's exact approved identity and `pm_id` from the frozen final design;
- exact request bytes, operation ID, same-session callback boundary, and before/after identity samples.

No socket inode appears in `B`, `R`, `L`, `C0`, or a command array. The phase revalidates `M[o]` before `BEGIN`, immediately before send, after callback, and before durable `QUIESCED`. Socket/daemon drift leaves `BEGIN` unmatched.

After the callback, the exact request must be unable to remain queued for later effect. No high-level response object containing `pm2_env` may be materialized, printed, logged, persisted, hashed, or included in evidence. A framed response may be consumed only by the reviewed bounded streaming selector that extracts the approved non-secret acknowledgement envelope and length-skips and zeroizes disallowed fields without decoding their values. No status field inside `pm2_env` is used. If callback semantics plus exact OS/process/listener/probe evidence cannot establish target state without environment-bearing data, the architecture is blocked.

`PM2_QUIESCED` requires callback completion and two stable samples one second apart:

- stop: the prior application PID/start identity is absent, no replacement application identity is tied to the exact daemon/action, and no `127.0.0.1:3000` listener exists;
- restore: exactly one approved application process identity is tied to the exact daemon action, its PID/start time is stable, exactly one loopback listener exists, and direct Express/loopback checks pass.

The daemon PID/start/executable/UID/version and socket device/inode/mode/owner remain unchanged.

| PM2 stage | Maximum |
|---|---:|
| socket/daemon identity, connect, pre-send revalidation | `5s` |
| exact send through callback | `15s` |
| post-callback process/listener convergence | `15s` |
| two stable samples and durable `QUIESCED` fsync | `5s` |
| **Total per PM2 operation** | **`40s`** |

Before-send death, after-send/before-callback death, callback loss, callback/target mismatch, helper death before durable `QUIESCED`, or deadline expiry leaves unmatched `BEGIN`; it never becomes quiesced by polling. If the spike cannot produce a candidate preserving every invariant, it returns `BLOCKED`. If frozen validation fails, the work returns to final-design revision and fresh review before planning.

### 13.3 Exact Nginx D-Bus reload and worker-generation interface

The architecture spike may produce a candidate exact `nginx.service`/`ExecReload`/binary/config identity model, config-read interval observation algorithm, job-to-generation causality rule, old-worker-absence algorithm, and helper interface. A later final design incorporates exact selected binary/config content identities into `B`, target-open objects into `I_T`, and freezes the exact algorithms/helper bytes before fresh dual approval and user re-review. Validation may only exercise those frozen selections. A generation remains a set of worker records containing PID, `/proc/PID/stat` start time, executable identity, UID, parent master PID/start identity, and generation observation time.

The operation sequence is:

1. capture the exact pre-reload master and worker generation plus maintenance/open artifact identities;
2. fsync `BEGIN` and call exact D-Bus `ReloadUnit("nginx.service", "fail")`;
3. retain the phase gate and helper until the exact returned job ID/path has matching `JobRemoved=done`;
4. observe a nonempty new worker generation, disjoint by PID/start identity, parented by the unchanged master, after dispatch and after the validated config-read interval;
5. require every old worker process absent before generic `NGINX_QUIESCED`;
6. require only new-generation accept-capable workers, exact expected maintenance/open config identity, expected sanitized loopback/public probe state, and two stable samples one second apart;
7. exclusively create and file/parent-fsync `QUIESCED` before releasing the phase gate.

A still-live draining old worker is never sufficient for generic quiescence. An optional `NEW_GENERATION_APPLIED` record may describe availability, but it is non-authorizing and never substitutes for `QUIESCED` or `FENCE_PROVED`.

| Nginx stage | Maximum |
|---|---:|
| pre-dispatch identity/config revalidation | `5s` |
| exact D-Bus job completion | `15s` |
| new generation observation/binding | `10s` |
| complete old-worker drain/absence | `25s` |
| stable samples and durable `QUIESCED` fsync | `5s` |
| **Total per Nginx operation** | **`60s`** |

Job done without generation, generation without old-worker absence, concurrent or substituted reload, master drift, config drift, helper death, or any stage timeout leaves unmatched `BEGIN`. Old-worker drain is inside the `25s` stage; timeout never reclassifies a draining worker as quiesced. If the spike cannot produce a candidate preserving this contract, it returns `BLOCKED`. A frozen-validation mismatch returns to final-design revision and fresh review before planning.

## 14. Global run lock and per-phase gates

### 14.1 Controller-owned global lock

The controller acquires an exclusive `flock` on:

`/var/lib/blog/task-5-systemd-fencing/global.lock`

It holds the lock from run reservation through the complete normal remote mutator/restoration interval and terminal run-marker creation. It never releases the lock between mutator and restoration phases.

The lock is advisory serialization for cooperating governed actors. It does not identify or contain PM2, Nginx, or an uncoordinated privileged actor. Durable nonterminal markers reserve the run independently of lock ownership.

If the controller dies, the lock is released. PID 1 stops any live phase through `BindsTo=`/`After=`, including a gate-committed pre-`BOUND` invocation. Another run remains forbidden by durable state. A new same-run controller invocation may acquire the lock only for reconciliation. It never dispatches another request after an execution gate or start closure; when only request evidence exists, the sole ordinal-2 reissue remains governed by section 20.1 and is not a phase rerun.

Unexplained lock ownership creates `FAULT_PENDING`. Lock acquisition alone is never process-terminal, delegate-terminal, or fence evidence.

### 14.2 Linearized phase gates

Each phase has one root-only gate file:

- `runs/${RUN_ID}/gates/mutator.lock`
- `runs/${RUN_ID}/gates/restore-1.lock`
- `runs/${RUN_ID}/gates/restore-2.lock`

For `EXECUTION_GATE_COMMITTED` or `START_WINDOW_CLOSED`, binding, entry, every production mutation, and every PM2/Nginx dispatch, the actor:

1. acquires the exact phase gate exclusively;
2. while holding it, rechecks boot ID, run/unit/controller identity, request records, execution gate/start closure, cancellation intent/fence, `FAULT_PENDING`, phase fence, all later-phase markers, and terminal run markers;
3. creates at most one of the mutually exclusive execution-gate/start-closure records, or holds the gate through the separately authorized mutation/delegated operation and durable completion/quiescence record;
4. releases the gate before the next separately authorized boundary.

No check followed by an unlocked mutation is permitted.

## 15. Cancellation and containment

Each phase has two immutable cancellation records:

- `*_CANCEL_INTENT`: a monotonic, non-authorizing request that immediately forbids productive continuation;
- `*_CANCEL_FENCE`: a linearization record proving no further execution gate, phase binding, entry, mutation, or delegated dispatch is possible.

Controller cancellation rules are:

1. write and fsync `CANCEL_INTENT` first;
2. a delayed pre-start checks it before `EXECUTION_GATE_COMMITTED`; the phase main checks it before `BOUND`, before `ENTERED`, and under the gate before every later boundary;
3. if the controller acquires the gate while the phase is live and no delegated operation is open, it may write and fsync `CANCEL_FENCE` before requesting exact-unit stop;
4. if the gate is held by a hung operation, the controller may request exact-unit containment stop after `CANCEL_INTENT`; after a valid terminal witness it acquires the gate and writes `CANCEL_FENCE`;
5. an unmatched external-operation `BEGIN` still blocks `FENCE_PROVED` even if process cancellation and `CANCEL_FENCE` succeed;
6. a controller seeing either cancellation record adopts the unit only for stop/reconciliation, never normal continuation.

Cancellation targets only the exact deterministic unit and expected invocation. No PID-only kill, process-name search, wildcard, slice-wide action, or guessed cgroup is permitted.

When no external operation is open, cancellation containment/reconciliation has an exact `45s` maximum after cancellation linearization or exact containment start: `10s` worker termination, `10s` outer finalizer slot containing the `5s` internal witness deadline, `10s` post-witness reconciliation, and `15s` for gate/marker/fsync/poll/scheduling work.

If an external `BEGIN` is open, cancellation still writes `CANCEL_INTENT` and requests exact phase containment immediately. The process-terminal witness must still follow the containment budget. Killing the observer does not wait the external action into quiescence: the `BEGIN` remains unmatched, `FENCE_PROVED` remains unavailable, and the controller records escalation/handoff. The section 13 stage deadline governs only normal operation; it never extends proof or creates closure. Controller shutdown writes a durable handoff record and does not claim work it cannot finish.

## 16. Marker schema and one-way invariants

Every marker is exclusively created once, then file- and parent-directory-fsynced. Markers and receipts are never rewritten, truncated, renamed over, or deleted by the run. Every record includes run ID, `H_B`, `H_L`, applicable `H_IU`/`H_IT`, `H_C1`/`H_C2`, phase `H_P0[p]`/`H_P1[p]` when applicable, authoritative boot, actor unit and invocation, schema digest, target-local receipt hashes, monotonic and UTC timestamps, prior/next state, and supporting-evidence hashes. No record changes an ancestor descriptor or recomputes the run ID.

Required records are:

Run and fault:

1. `000-RUN_STAGED`
2. `010-RUN_RESERVED`
3. `095-FAULT_PENDING` when the first nonterminal fault is detected

Mutator:

4. `100-MUTATOR_INTENT`
5. `105-MUTATOR_START_REQUEST_1`
6. `106-MUTATOR_START_REQUEST_2` when the one reissue is dispatched
7. `108-MUTATOR_EXECUTION_GATE_COMMITTED` or `109-MUTATOR_START_WINDOW_CLOSED`, mutually exclusive
8. `110-MUTATOR_BOUND` only after the execution gate
9. `120-MUTATOR_ENTERED`
10. `125-MUTATOR_CANCEL_INTENT` when requested
11. `126-MUTATOR_CANCEL_FENCE` when linearized
12. `130-MUTATOR_PROCESS_TERMINAL_WITNESSED` for every gate-committed invocation
13. `140-MUTATOR_FENCE_PROVED`
14. `145-MUTATOR_OUTCOME`

Restoration attempt 1:

15. `200-RESTORE_1_INTENT`
16. `205-RESTORE_1_START_REQUEST_1`
17. `206-RESTORE_1_START_REQUEST_2` when the one reissue is dispatched
18. `208-RESTORE_1_EXECUTION_GATE_COMMITTED` or `209-RESTORE_1_START_WINDOW_CLOSED`, mutually exclusive
19. `210-RESTORE_1_BOUND` only after the execution gate
20. `220-RESTORE_1_ENTERED`
21. `225-RESTORE_1_CANCEL_INTENT` when requested
22. `226-RESTORE_1_CANCEL_FENCE` when linearized
23. `230-RESTORE_1_PROCESS_TERMINAL_WITNESSED` for every gate-committed invocation
24. `240-RESTORE_1_FENCE_PROVED`
25. `245-RESTORE_1_OUTCOME`
26. `250-RESTORATION_VERIFIED` when attempt 1 succeeds

Restoration attempt 2:

27. `300-RESTORE_2_INTENT`
28. `305-RESTORE_2_START_REQUEST_1`
29. `306-RESTORE_2_START_REQUEST_2` when the one reissue is dispatched
30. `308-RESTORE_2_EXECUTION_GATE_COMMITTED` or `309-RESTORE_2_START_WINDOW_CLOSED`, mutually exclusive
31. `310-RESTORE_2_BOUND` only after the execution gate
32. `320-RESTORE_2_ENTERED`
33. `325-RESTORE_2_CANCEL_INTENT` when requested
34. `326-RESTORE_2_CANCEL_FENCE` when linearized
35. `330-RESTORE_2_PROCESS_TERMINAL_WITNESSED` for every gate-committed invocation
36. `340-RESTORE_2_FENCE_PROVED`
37. `345-RESTORE_2_OUTCOME`
38. `350-RESTORATION_VERIFIED` when attempt 2 succeeds

Mutually exclusive terminal run markers:

39. `900-RUN_SUCCEEDED`
40. `910-RUN_BLOCKED_PRE_MUTATION`
41. `920-RUN_FAILED_NO_MUTATION`
42. `930-RUN_FAILED_RESTORED`
43. `990-OPERATOR_REQUIRED`

Load-bearing invariants include:

- `RUN_RESERVED` fixes the boot identity for the run.
- Each `START_REQUEST_1` is `Q[p,1]`, cites exact `H_P1[p]` and canonical request bytes, and precedes dispatch. `START_REQUEST_2` is optional `Q[p,2]`, occurs at most once, and cites the same byte-identical `P1[p]` transient properties, dependencies, environment, and command arrays.
- A D-Bus reply or job path is request evidence only and creates no authorization state.
- `EXECUTION_GATE_COMMITTED` requires request 1, the actual unit invocation, exact `P1[p]` read-back, applicable receipt hashes including `W[p]`, and absence of `START_WINDOW_CLOSED` while holding the phase gate.
- `START_WINDOW_CLOSED` requires both completed `10s` visibility windows and, while the global lock and exact phase gate remain held, fresh deterministic-name absence, absence for every exact phase invocation learned from either request/job ledger, no current job for the deterministic name, no execution gate, and the complete boot/controller/request/cancellation/fault/later/terminal/schema recheck. Its record contains the exact lookup evidence and hashes. Any current unit/job, invocation disagreement, lookup error, gate, or prohibited marker causes reconciliation or fail-closed escalation, never closure.
- The execution gate and start closure are mutually exclusive. Duplicate or contradictory creation is evidence corruption.
- `BOUND` requires `EXECUTION_GATE_COMMITTED` and no cancellation/fault/later/terminal prohibition. `ENTERED` requires `BOUND` and a second gate-held identity/state check.
- Every gate-committed invocation requires a valid finalizer witness and path-specific reconciliation, whether or not it reached `BOUND` or `ENTERED`.
- Every mutator with `ENTERED` requires restoration after a full fence. A fully fenced mutator with no `ENTERED`, delegated `BEGIN`, or production record may classify no mutation.
- `CANCEL_INTENT`, `CANCEL_FENCE`, and `FAULT_PENDING` are nonterminal and prohibit productive forward progress while allowing exact containment, witness/fence construction, and an already-required restoration path.
- `PROCESS_TERMINAL_WITNESSED` requires a valid finalizer witness for the exact gate-committed phase invocation.
- `FENCE_PROVED` requires process witness, one accepted loaded/unloaded reconciliation class, gate/cancellation invariants, and closure of all external operations.
- No restoration intent may exist without `MUTATOR_FENCE_PROVED`. `MUTATOR_ENTERED` makes restoration mandatory; a fully fenced pre-`ENTERED` mutator starts no restoration only when delegated and production records are also absent.
- Attempt 2 requires `RESTORE_1_FENCE_PROVED`, a valid immutable attempt-1 classification from section 18, and no attempt-1 verification.
- `RUN_SUCCEEDED` requires successful mutator outcome, exactly one `RESTORATION_VERIFIED`, and all final remote gates.
- `RUN_FAILED_RESTORED` requires a non-success entered-mutator/fault outcome plus verified restoration.
- Terminal run markers are mutually exclusive. Contradictory order, identity mismatch, duplicate exclusive-create collision, or impossible state is evidence corruption and blocks further automation.

## 17. Mandatory phase results and path-specific systemd reconciliation

### 17.1 Mandatory semantic result

Each phase must exclusively create and file/parent-fsync exactly one immutable result record before every intentional semantic exit in `{0, 64, 70, 75}`. The record is bound to `H_B`, `R`, `H_L`, `H_IU`, `H_IT`, `H_C1`, `H_C2`, `H_P0[p]`, `H_P1[p]`, `W[p]`, authoritative boot, phase unit/`InvocationID`, actual controller invocation, applicable script/tool receipts, last completed boundary, operation-record hashes, sanitized evidence hashes, result schema, and monotonic timestamps.

The exact exit map, with no `SuccessExitStatus` override, is:

- `0`: success;
- `64`: deterministic application, service, or public validation failure;
- `70`: identity, marker, property, environment, or protocol failure;
- `75`: cooperative cancellation with one exact cancellation reason.

If result creation or either fsync fails, the process must not return one of those four codes. Any normal exit without a result is an implementation/protocol failure and nonretryable, including a normal reserved exit and every normal unreserved exit. Signal, core dump, exact runtime timeout, or forced abnormal death may leave the result absent; absence gains classification meaning only after a valid terminal witness and full fence.

A present result must exactly match `ExecMainCode`, `ExecMainStatus`, the validated `SERVICE_RESULT`/`EXIT_CODE`/`EXIT_STATUS`, cancellation records, and the witness. A mismatch blocks the fence. A missing mandatory result can never be treated as semantic success even when process fencing remains provable.

### 17.2 Common loaded evidence

Every loaded row requires exact unit name/invocation, exact `P1[p]` transient-definition/read-back equality including `CollectMode=inactive`, applicable receipt equality, `NRestarts=0`, no current job after finalization, and zero main/control PIDs. The spike may produce candidate target tuples for stop, timeout, dependency, start, and finalizer paths. A later final design must freeze exact tuples before fresh review; validation acceptance is byte-for-byte equality to that frozen design, not a broad status list selected during validation or implementation.

| Lifecycle path | Required durable pre-exit evidence | Required loaded terminal class | Job rule | Automatic disposition |
|---|---|---|---|---|
| Natural intentional success | Result record `0`; witness says main exited `0`, service result success, worker empty | successful inactive/dead tuple compatible with `RemainAfterExit=no` | No stop job is required; any observed ledger must be consistent | Fence may succeed |
| Intentional `64` or `70` | Matching mandatory result; witness exact normal exit | failed/exit-code tuple with exact status | No post-finalizer signal required | Fence may succeed; classification nonretryable |
| Intentional `75` | Matching result and exact cancellation records/reason | failed/exit-code tuple status `75` | No post-finalizer signal required | Fence may succeed; retry only for the two safe reasons in section 18 |
| Signal/core dump | Result absent; witness/systemd exact abnormal tuple | failed signal/core tuple | An observed stop job must agree; missing `JobRemoved` under a no-observer path is neutral | Retry eligibility follows section 18 |
| Runtime timeout | Result absent; exact runtime-timeout origin and tuple | failed timeout tuple | Same path-specific rule | Retry eligibility follows section 18 |
| Explicit stop or controller-dependency stop while live | Exact cancel/dependency origin and result/witness/main tuple from the validated artifact | exact retained failed tuple for the target build | The current stop job may be captured by the finalizer; later removal signal is optional if no observer survives | Fence may succeed only on exact artifact equality |
| Main executed but failed before `BOUND`/`ENTERED` | Execution gate plus worker witness; no delegate or production records | exact start/main failure tuple | Start/stop signals are opportunistic only | Pre-entry fence; mutator no-mutation classification may be possible |
| Finalizer nonzero/signal after witness | Witness may preserve process emptiness | retained failed finalizer tuple | Any ledger must agree | **No automatic `FENCE_PROVED`; trusted finalization failure** |

A surviving controller subscribes before creation and durably records observed job/unit events, but no loaded row requires a `JobRemoved` signal that occurs only after the sole finalizer exits when no observer survives.

### 17.3 Narrow successful-unloaded inference

Only one automatic unloaded inference family is allowed: a successful inactive unit collected under pinned `CollectMode=inactive` after a valid witness. Every condition is conjunctive:

1. authoritative boot unchanged;
2. valid `EXECUTION_GATE_COMMITTED` and valid finalizer witness for the same invocation;
3. witness has the bound worker identity and recursive emptiness;
4. witness reports `SERVICE_RESULT=success`, `EXIT_CODE=exited`, `EXIT_STATUS=0`, exact zero main status, and no contradictory result record;
5. exact `P1[p]` descriptor/read-back equality includes `CollectMode=inactive`, `Restart=no`, `NRestarts=0`, `RemainAfterExit=no`, the frozen command arrays, and applicable receipt hashes;
6. two stable D-Bus samples one second apart within the `10s` reconciliation window report both name lookup and invocation lookup absent, with no job for the name and no same-name recreation;
7. no reset-failed, collect/unload request, manager drift, boot change, invocation substitution, or other prohibited privileged action is observed;
8. delegate records and marker invariants are complete.

Under these conditions, the witness proves worker/process termination. `CollectMode=inactive` plus the successful witness tuple and stable absence supplies only the negative inference that no failed finalizer/unit state was retained. `JobRemoved` and `UnitRemoved` are not mandatory if no observer survived. Absence does not prove worker emptiness, finalizer execution, or main outcome by itself.

If the mandatory result record is absent despite exact zero/success main evidence, process fencing and the unloaded terminal class may still be established, but the phase outcome is a nonretryable protocol failure rather than success. A result mismatch blocks the fence.

All other unloaded cases fail closed automatically: reserved nonzero exit, signal/core, runtime timeout, explicit or dependency stop while live, start/resource failure, finalizer failure, `CollectMode` mismatch, missing or malformed witness, lookup disagreement, same-name recreation, boot/invocation drift, or evidence of reset/collection activity. They end in `OPERATOR_REQUIRED`; absence cannot rehabilitate them.

### 17.4 Mandatory negative matrix

The spike may collect candidate exact-target tuples for controller death with no subscriber, death after witness fsync/before finalizer exit, finalizer nonzero/signal after witness, immediate successful unload, failed-unit retention, isolated reset-failed simulation, name recreation, lookup disagreement, pre-witness disappearance, and missing/malformed witness. A later final design freezes the accepted tuples; validation must test them unchanged and every forbidden unloaded tuple must fail closed. This charter does not claim that the spike or validation has run.

## 18. Closed restoration retry precedence and classes

After restoration attempt 1 reaches full fence, the controller creates immutable `245-RESTORE_1_OUTCOME` while holding the global run lock. It cites hashes of the result or exact absence evidence, finalizer witness, path-specific systemd/job reconciliation, cancellation records, fault record, and every delegated-operation record.

Before considering attempt 2, classification applies this exact precedence:

1. boot/trusted-boundary failure: boot change, identity/property/environment drift, same-name substitution, finalizer failure, or prohibited privileged activity -> nonretryable `OPERATOR_REQUIRED`;
2. evidence-integrity failure: malformed, missing-mandatory, contradictory, duplicate, or impossible record -> nonretryable;
3. external closure/fence: unmatched `BEGIN` or no full attempt-1 fence -> no retry authority;
4. result/main tuple consistency: a present result must exactly match main/service/finalizer/cancellation/witness evidence; mismatch -> nonretryable;
5. explicit operator cancellation -> nonretryable regardless of signal or status;
6. exact safe cancellation: result `75` is retryable only for one of the two named reasons below, with a valid cancellation fence and no unmatched operation;
7. absent-result abnormality: only the exact signal/core/runtime-timeout rows below are retryable; every normal exit is nonretryable;
8. start/resource/pre-main failure -> nonretryable; attempt 2 is not an execution-interface probe.

| Attempt-1 evidence class | Retry? | Required exact conditions |
|---|---:|---|
| Result `0` and restoration verified | No | Success; create `RESTORATION_VERIFIED` |
| Result `0` but verification/result tuple contradiction | No | Protocol/evidence failure |
| Result `64` | No | Deterministic failure |
| Result `70` | No | Protocol/trust failure |
| Result `75`, `SAFE_CANCEL_PRE_DISPATCH` | **Yes** | Cancellation before any external `BEGIN`; full fence; no operator cancel or drift |
| Result `75`, `SAFE_CANCEL_POST_QUIESCED_PRE_VERIFICATION` | **Yes** | Every opened operation has valid `QUIESCED`; cancellation before final verification; full fence |
| Result `75`, any other reason | No | Includes explicit operator cancellation and ambiguous handoff |
| Result absent + `CLD_KILLED`/exact signal | **Yes** | No operator cancel, drift, finalizer failure, malformed evidence, or unmatched operation |
| Result absent + `CLD_DUMPED`/core | **Yes** | Same exclusions |
| Result absent + exact systemd runtime timeout | **Yes** | Same exclusions |
| Result absent + `CLD_EXITED` with any status, reserved or unreserved | No | Protocol/implementation normal-exit contradiction |
| Start/resource failure before valid main execution | No | Manager/execution-interface failure |
| Any unmatched external operation | No | Full fence unavailable |
| Any finalizer failure after witness | No | Trusted-finalization failure |

`300-RESTORE_2_INTENT` cites the exact attempt-1 outcome hash. Any attempt-2 result other than fully verified success remains `OPERATOR_REQUIRED`. No third attempt is permitted.

## 19. State machine and escalation ordering

| State | Entry evidence | Allowed next action |
|---|---|---|
| staged | verified bundle and `RUN_STAGED` | reserve under the global lock |
| reserved | `RUN_RESERVED`, authoritative boot, no other nonterminal run | read-only preflight |
| blocked pre-mutation | read-only failure before mutator intent | `RUN_BLOCKED_PRE_MUTATION`; no production mutation |
| request pending | request 1 or 2 record; no execution gate or start closure | query/wait; optional one exact reissue only |
| execution gated | exact `EXECUTION_GATE_COMMITTED` | accept conservatively that main may execute; never reissue; wait, contain, witness, and reconcile |
| start closed | exact `START_WINDOW_CLOSED`; no execution gate | reject every late pre-start before main; mutator may classify no mutation; restoration is unavailable/nonretryable |
| pre-entry terminal | execution gate plus witness/full fence; no `ENTERED`, delegate, or production evidence | mutator may become `RUN_FAILED_NO_MUTATION`; restoration failure is nonretryable |
| entered | existing `BOUND` plus `ENTERED` invariants | productive work under the gate or exact cancellation |
| process terminal | valid worker witness | apply path-specific loaded/unloaded reconciliation |
| fenced | witness plus accepted reconciliation plus delegate closure | mutator with `ENTERED` starts restoration 1; pre-entry mutator may close no mutation |
| restore 1 fenced | exact outcome and full attempt-1 fence | verify success or apply section 18's closed retry table |
| restore 2 fenced | full attempt-2 fence | verify success or `OPERATOR_REQUIRED` |
| restoration verified | exact attempt 1 or 2 verification | classify run outcome |
| failed restored | entered-mutator/fault failure plus verified restoration | terminal `RUN_FAILED_RESTORED` |
| succeeded | mutator success, verified restoration, final gates | terminal `RUN_SUCCEEDED`; local phase may begin |
| operator required | terminal escalation evidence | no further automation |

Exact transition semantics are:

- A read-only failure before mutator intent produces `RUN_BLOCKED_PRE_MUTATION`.
- A mutator may produce `RUN_FAILED_NO_MUTATION` only through one of two exact proofs: a valid `START_WINDOW_CLOSED` with no execution gate, `BOUND`, `ENTERED`, delegated `BEGIN`, production record, or contradictory unit evidence; or a gate-committed invocation with a valid full fence and no `ENTERED`, delegated `BEGIN`, or production record.
- Elapsed absence, a D-Bus failure, or lack of `BOUND` is never by itself no-mutation proof.
- Every gate-committed invocation requires terminal witness and path-specific reconciliation.
- Every mutator with `ENTERED` requires restoration attempt 1 after a full fence. A full fence does not erase that obligation.
- A mutator deterministic/protocol/abnormal failure followed by verified restoration produces `RUN_FAILED_RESTORED`, not `OPERATOR_REQUIRED`.
- Mutator success plus verified restoration and final gates produces `RUN_SUCCEEDED`.
- Late invalid-partial drift, quarantine collision, or another safety collision creates `FAULT_PENDING`, then contains and fences the phase and restores the old service when the mutator had entered and a full fence is available; verified restoration produces `RUN_FAILED_RESTORED`.
- `OPERATOR_REQUIRED` is written when process or delegate fencing is unavailable, a forbidden unloaded tuple occurs, restoration is nonretryably unavailable or failed, attempt 2 fails, boot changes, or the trusted evidence boundary is violated.
- A process-terminal mutator with any unresolved external delegate cannot reach `FENCE_PROVED`; automatic restoration is forbidden and the run ends in `OPERATOR_REQUIRED`.

`FAULT_PENDING`, `CANCEL_INTENT`, and `CANCEL_FENCE` do not authorize production progress. They permit only safety closure and restoration already required by a valid full mutator fence.

## 20. Controller lifetime, lost acknowledgements, and reconciliation

### 20.1 Lost reply, one reissue, and durable start closure

Before request 1, the controller writes phase intent and exclusively creates/fsyncs `Q[p,1]` under the global lock after a boot check. It cites the exact ordinal-independent `P1[p]` bytes and `H_P1[p]`. Creation uses fail-on-name-conflict behavior. Returned reply status and job ID/path are request evidence only.

The exact algorithm is:

1. Dispatch request 1 and wait the first `10s` visibility window. If the exact unit/job or `EXECUTION_GATE_COMMITTED` is observed, reconcile it; do not reissue.
2. After the first window, hold the global lock and exact phase gate and recheck authoritative boot, deterministic name lookup, every learned invocation lookup, current jobs, both descriptor identities, request records, cancellation/fault/later/terminal markers, and absence of the execution gate.
3. Only if no current exact unit/job, no lookup disagreement/error, and no execution gate exists may the controller exclusively create/fsync `Q[p,2]` and dispatch one reissue. It cites the same `P1[p]` bytes and `H_P1[p]`; request ordinal changes no property, dependency, environment, or command array.
4. During the second `10s` visibility window, any exact unit/job/gate is reconciled. No third request exists and no alternate unit name or run ID is permitted.
5. After the second `10s` visibility window, the controller holds the global run lock and acquires the exact phase gate. While still holding both, it repeats section 16’s complete closure predicate using fresh D-Bus reads: (a) deterministic name lookup for the exact phase unit must report no current unit; (b) invocation lookup for every exact phase `InvocationID` learned from either request/job ledger must report no current unit for that invocation, with any lookup disagreement or same-name different invocation failing closed; and (c) the current-job lookup must report no job for the deterministic phase unit name. It then rechecks authoritative boot identity, both request records, controller identity, absence of `EXECUTION_GATE_COMMITTED`, absence of a competing or prior `START_WINDOW_CLOSED`, cancellation/fault/later-phase/terminal prohibitions, and marker-schema consistency. Only if every conjunct remains true may it exclusively create and file/parent-fsync `START_WINDOW_CLOSED`. Any unit, invocation, current job, lookup error/disagreement, gate, or prohibited marker causes reconciliation or fail-closed escalation, never closure.
6. The closure record contains exact name/invocation/job lookup evidence and hashes. If no phase invocation ID was learned, the invocation-lookup set is canonically empty, but deterministic-name absence and no-current-job remain mandatory.
7. A racing late pre-start either commits `EXECUTION_GATE_COMMITTED` first or sees `START_WINDOW_CLOSED` and fails before main. Both records cannot exist and request 2 cannot create a second gate.
8. If an execution gate exists but `BOUND` does not, the controller never reissues. The finalizer uses `H_P1[p]`, `W[p]`, and the gate's unit/cgroup identity to witness emptiness, followed by path-specific reconciliation.

A boot change suppresses query, reissue, gate acceptance, start closure, witness acceptance, and all continuation. Elapsed absence without `START_WINDOW_CLOSED` is insufficient for no-mutation classification.

### 20.2 Lost completion or stop acknowledgement

A lost client, D-Bus, `systemd-run`, or stop acknowledgement does not change state. Reconciliation queries the exact unit and durable records. A stop request is not blindly repeated while an exact stop job exists.

Every gate-committed invocation requires the finalizer witness and full path-specific reconciliation. A valid `START_WINDOW_CLOSED` proves instead that main cannot execute and requires no phase witness. A command return, absent PID, missing unit, elapsed window, or journal line is never sufficient.

### 20.3 Client death

The client may die without changing server ownership. A same-run client reconnect can invoke reconciliation, but it cannot infer completion or start a duplicate phase.

### 20.4 Controller death

If the controller dies:

- its global lock is released;
- PID 1 stops any live phase through the exact `BindsTo=`/`After=` relationship, including a gate-committed pre-`BOUND` phase;
- durable nonterminal markers continue to reserve the run and another run remains forbidden;
- a new same-run controller invocation may acquire the global lock only for reconciliation;
- while any old gate-committed phase is nonterminal, the new controller is stop/reconcile-only and never dispatches another request;
- if only request evidence exists with neither execution gate nor start closure, the reconciler may perform the one ordinal-2 reissue only through section 20.1's exact algorithm; this is the same launch protocol, not a phase rerun;
- a same-name phase with a losing new invocation is rejected before main by the execution-gate exclusivity rule;
- if the old phase becomes process-terminal, the new controller validates the existing witness and the applicable loaded/unloaded matrix, closes only already-acknowledged delegates, creates the full fence when valid, and performs restoration required by an entered mutator;
- if an external `BEGIN` is unmatched, the new controller cannot invent `QUIESCED` or restore automatically.

`RuntimeMaxSec=1800s` is only the original controller epoch's active/useful-work budget. On runtime expiry, controller forced deactivation may consume a subsequent `60s` through `T2`. A possibly live dependent phase may then require the separately reserved `45s` containment/finalizer/reconciliation/handoff interval through `T3 = T0 + 1905s`. Until frozen target validation proves universal overlap, the relationship is sequential. An open external operation still receives immediate process containment, but the controller records unmatched `BEGIN` and durable fail-closed handoff without false fence, restoration-completion, or terminal-success claims. Any later same-run reconciliation controller is a distinct recorded epoch.

### 20.5 Host reboot

A boot mismatch is detected before unit query, adoption, stop, reissue, witness acceptance, fence, restoration, or mutation. The run writes `OPERATOR_REQUIRED` with `reason=BOOT_ID_CHANGED`. No automatic recovery or restoration follows. A separately approved recovery decision is required.

## 21. Deadline epochs, success, and failure containment

### 21.1 Exact values and monotonic epochs

All remote deadline evidence uses the exact target monotonic clock and final-design-frozen systemd manager timestamps. Client dispatch time, client wall clock, disconnect, and transport return are non-authorizing.

| Interval | Exact maximum |
|---|---:|
| first request visibility per phase | `10s` |
| one reissue visibility per phase | `10s` |
| phase `TimeoutStartSec` | `10s` |
| pre-start gate internal work | `5s` within `TimeoutStartSec` |
| mutator control work: Nginx `60` + PM2 `40` + other control/quarantine `20` | `120s` |
| mutator snapshot work | `600s` |
| mutator internal total | `720s` |
| mutator `RuntimeMaxSec` | `780s` (`60s` margin) |
| restoration PM2 | `40s` |
| restoration Nginx | `60s` |
| restoration audits/probes/other work | `80s` |
| restoration internal total | `180s` |
| each restoration `RuntimeMaxSec` | `240s` (`60s` margin) |
| worker stop/kill interval | `10s` |
| finalizer internal witness deadline | `5s` |
| finalizer outer systemd stop-post slot | `10s` |
| post-witness terminal reconciliation | `10s` |
| poll interval | `250ms` |
| dependent-phase containment/reconcile/handoff with no open delegate | `45s` |
| controller active/useful-work `RuntimeMaxSec` | `1800s` |
| controller forced-deactivation `TimeoutStopSec` tail | `60s` |
| fixed transition/evidence allowance | `120s` |

Epochs are:

- `T0` — the validated target-systemd monotonic instant from which controller `RuntimeMaxSec=1800s` is charged; the spike proposes a candidate mapping, the later final design freezes it, and frozen-design validation proves it without modification;
- `T1 = T0 + 1800s` — controller active/useful-work expiry;
- `T2 = T1 + 60s = T0 + 1860s` — conservative latest end of controller forced deactivation;
- `T3 = T2 + 45s = T0 + 1905s` — conservative latest dependent-phase process containment, finalizer, reconciliation, and durable handoff deadline when no overlap is credited;
- `TS` — the target monotonic instant at which `RUN_SUCCEEDED` is durably fsynced after every required remote gate.

Pre-controller upload/staging and controller-start work before `T0` are separately bounded and are not silently included. `TimeoutStopSec=10s` is counted separately for worker termination and the fresh outer stop-post slot; the finalizer's `5s` self-deadline lies inside the latter. PM2/Nginx maxima remain inside phase budgets and are not double counted.

### 21.2 Controller active/useful-work floor

The conservative useful-work reservation takes no credit for overlap:

```text
initial + reissue visibility:       3 * (10 + 10) =   60s
phase start slots:                  3 * 10        =   30s
phase RuntimeMaxSec reservations:   780 + 2*240   = 1260s
worker-stop slots:                  3 * 10        =   30s
fresh outer finalizer slots:        3 * 10        =   30s
post-witness reconciliation:        3 * 10        =   30s
fixed transition/evidence allowance:                 120s
                                                      -----
controller useful-work floor:                       1560s
active-runtime margin:               1800 - 1560 =   240s
```

`1800s` is the controller active/useful-work budget with `240s` margin over the `1560s` floor. It is not a hard unit-lifetime or remote wall-clock envelope.

### 21.3 Success and failure envelopes

| Envelope | Exact arithmetic | Meaning |
|---|---:|---|
| useful active runtime | `1560s` floor inside `1800s` | All normal remote mutator/restoration work, phase terminal handling, and `RUN_SUCCEEDED` must fit before `T1`. |
| successful remote completion | `TS <= T0 + 1800s` | Success requires durable `RUN_SUCCEEDED`, no live phase, complete delegate closure, verified restoration, and final gates before active-runtime expiry. A later marker cannot retroactively make the original epoch bounded success. |
| controller forced-stop tail | `60s` | On runtime expiry/failure, controller deactivation may continue from `T1` through `T2`. |
| dependent-phase containment/handoff | `45s = 10 + 10 + 10 + 15` | Conservatively measured after controller deactivation: worker termination, fresh finalizer slot, post-witness reconciliation, and gate/marker/fsync/poll/scheduling/handoff. Open external `BEGIN` permits process containment/handoff but never synthesized full fence. |
| conservative failure containment outer bound | `1800 + 60 + 45 = 1905s` | By `T3`, the original controller epoch must have either succeeded by `T1`, or completed forced deactivation plus dependent containment and durable fail-closed handoff/escalation when evidence is available. It does not promise restoration completion or a terminal run marker after runtime failure. |
| target-proven tighter failure bound | `1800 + max(60,45) = 1860s` | Non-normative unless the spike proposes and frozen validation proves universal overlap on every exact-target path. Until then `1905s` governs. |
| local stage sum | `300 + 60 + 120 + 60 + 120 + 900 + 180 + 30 = 1770s` | Unchanged bounded local work after read-back of `RUN_SUCCEEDED`. |
| local envelope/margin | `2100s`; `2100 - 1770 = 330s` | Starts at `TS`, never on a failure/handoff path. |
| successful remote-plus-local bound | `1800 + 2100 = 3900s` from `T0` | Success-only upper bound excluding separately bounded pre-controller upload/staging; it is not a generic failure-plus-local envelope. |

If no phase is current at `T1`, the conservative forced-deactivation bound is `T2`; the extra `45s` is reserved only for a possibly live or gate-committed dependent phase and handoff. Until frozen-design validation proves a tighter universal ordering on every required exact-target path, the design uses the slower sequential relation.

### 21.4 Observer deadline and later restoration

The observer has two non-authorizing deadlines:

1. At `T1`, absence of `RUN_SUCCEEDED` means the successful remote envelope expired. The observer does not start local work and does not infer process termination.
2. At `T3`, the observer performs exact read-only reconciliation of durable graph records, descriptors, receipts, markers, deterministic name lookup, every-known-invocation lookup, current jobs, controller/phase state, witness, delegate records, and handoff/escalation evidence. Missing or contradictory containment/handoff evidence reports fail-closed `OPERATOR_REQUIRED`/`BLOCKED`; the observer does not kill, retry, restore, or infer safety from absence.

A same-run reconciliation controller needed after handoff is a distinct recorded controller epoch and is not silently added to the original `1905s` claim. Required restoration after controller-runtime failure remains mandatory when a full entered-mutator fence authorizes it, but later completion requires its own explicit bounded authority/evidence in the final design. The original observer never starts local work while that obligation is unresolved.

Budget expiry never weakens proof. Before mutator intent it may produce `RUN_BLOCKED_PRE_MUTATION`; after intent it creates `FAULT_PENDING` and follows exact containment/fence/restoration/handoff ordering or ends in `OPERATOR_REQUIRED` when proof is unavailable.

## 22. Exact current invalid snapshot identity and handling

The current production partial is invalid and must remain preserved. Before any maintenance mutation and immediately before quarantine, the implementation must require this exact identity:

- `/root/blog-english-release-20260804`: regular non-symlink directory, root:root, mode `0755`, with exactly one top-level entry named `snapshot`;
- `snapshot`: regular non-symlink directory, root:root, mode `0700`, containing exactly four regular non-symlink root-owned files and no `SHA256SUMS`.

| Partial artifact | Size | Mode/owner | SHA-256 |
|---|---:|---|---|
| `blog.db` | 4,390,912 | `0644:0:0` | `820f09b79546a220e30d2f05330ffe9c7d84d9ea240ed760676954517f20810c` |
| `blog.db-shm` | 32,768 | `0644:0:0` | `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb` |
| `blog.db-wal` | 0 | `0644:0:0` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `runtime.tar` | 4,997,120 | `0644:0:0` | `e2a5019b8af035eaf9c910a58e527dff81a4306e25fbc90f1eb873bd9a6621df` |

These hashes are forensic identity only, not a valid manifest.

The mutator must:

1. reject any type, mode, owner, size, hash, name, count, or absent-manifest drift;
2. require `/root/blog-english-release-20260804.failed-${RUN_ID}` absent;
3. after maintenance is active and PM2 stop is `QUIESCED`, atomically rename the entire canonical release root to the exact quarantine path using the reviewed no-replace/no-target operation;
4. verify the canonical path absent, quarantine identity unchanged, and no nesting or overwrite;
5. never copy, merge, delete, add a manifest to, transfer, or use the quarantined partial as snapshot input;
6. publish a fresh canonical release only from a separately verified staging tree containing exactly `blog.db`, `runtime.tar`, and `SHA256SUMS`.

Identity drift or quarantine collision preserves both sides, creates `FAULT_PENDING`, and proceeds only to phase safety closure and verified old-service restoration when a full mutator fence is available.

## 23. Remote Task 5 workflow boundaries

The mutator retains all approved controls, and the snapshot window includes no code or content change:

- read-only preflight before intent;
- exact maintenance no-store activation and Nginx quiescence;
- exact PM2 stop quiescence;
- whole-root no-replace quarantine of only the exact invalid partial;
- database verification in a unique root-only disposable directory so SQLite sidecars cannot pollute the final set;
- fully materialized tar inventory without an early-closing producer pipeline;
- staging and final snapshot directories containing exactly three regular non-symlink files;
- atomic manifest creation and verification before and after no-replace publication;
- retention of forensic, failed-work, staging, final, marker, witness, operation, and job evidence without broad deletion.

Restoration attempt 1 begins only after `MUTATOR_FENCE_PROVED`. Each restoration attempt retains:

- identity-bound PM2 start/restart `BEGIN` and `QUIESCED`;
- exactly one approved application process identity tied to the exact PM2 daemon action, stable PID/start time, and exactly one loopback listener, without deriving status from `pm2_env`;
- direct Express and loopback Nginx smoke;
- expected production HEAD, no staged changes, no non-ecosystem tracked changes, and the exact approved opaque ecosystem status without reading its contents;
- localized-content audit requiring schema/integrity/foreign-key/operation checks and counts `4/4/4/4`;
- identity-bound maintenance-open Nginx reload `BEGIN` and `QUIESCED`;
- two sanitized public-open stable samples requiring `200`, `private`, `no-store`, no `Age`, no `Expires`, and no forbidden stored-object state.

No transfer or local candidate work begins before `RUN_SUCCEEDED`.

## 24. Bounded post-restoration local work

Only after durable creation and read-back of `RUN_SUCCEEDED` at `TS`, the original Task 5 local candidate boundaries remain and these fixed liveness limits apply. Neither `T1` expiry nor `T3` containment/handoff observation authorizes local work:

| Stage | Deadline |
|---|---:|
| SCP source transfer | `300s` |
| exact-three inventory/checksum | `60s` |
| tar inventory/extraction | `120s` |
| detached worktree creation/provenance | `60s` |
| selective hydration/empty operations | `120s` |
| `npm ci` | `900s` |
| localized-content audit | `180s` |
| empty mode-`0700` release bundle | `30s` |
| overall local phase | `2100s` |

The stage sum is `1770s`; the overall margin is `330s`.

SCP must be noninteractive with exact reviewed options equivalent to:

- `BatchMode=yes`;
- zero password prompts;
- one connection attempt;
- `ConnectTimeout=15`;
- server-alive interval `15` and count `2`;
- no TTY or forwarding;
- no unbound connection multiplexing.

On local timeout, terminate and prove empty the exact local stage process group, retain and inventory partial local evidence, perform no broad cleanup, stop before Task 6, and do not touch the already verified production service.

The local candidate still requires source hashes, exact-three boundary, safe tar types/names, detached worktree provenance, selective hydration, empty operations, `npm ci`, `4/4/4/4` audit, and an empty mode-`0700` release bundle. The snapshot's old taxonomy is not copied over the committed candidate taxonomy.

The snapshot's `ecosystem.config.js` remains archived only by exact pathname and opaque. Production `ecosystem.config.js` remains the approved sole unstaged override and is never reset, staged, overwritten, displayed, parsed, copied into the candidate, or emitted into evidence.

## 25. Evidence, secrets, retention, and terminal classification

Required root-only evidence is separated by graph layer and runtime receipt class:

- exact `B`/`H_B`, `R`, and `L`/`H_L` bytes, hashes, schema version, topological-order result, upload inventory, and bundle content identities, with no target-local inode fact in those ancestors;
- uploaded-object installation receipts `I_U`/`H_IU`, separately identifying every final published path and same-open-object dev/inode/type/nlink/owner/mode/size/content tuple;
- existing-target tool/config receipts `I_T`/`H_IT`, separately identifying approved Node/PM2/Nginx/system binary, module, and config objects without any PM2 live socket or worker-cgroup identity;
- controller reservation `C0`/`H_C0`, controller start `C1`/`H_C1`, and controller invocation `C2`/`H_C2`, including exact unit name, actual invocation, boot, dependencies, complete properties, guarded controller array, sanitized environment-contract digest, manager timestamps, and exact read-back;
- each phase context `P0[p]`/`H_P0[p]` and phase request `P1[p]`/`H_P1[p]`, including exact unit/controller identity, complete dependencies/properties/environment arrays, guarded pre-start/main/finalizer arrays, and exact read-back;
- request ordinals `Q[p,1]` and optional `Q[p,2]`, both citing one byte-identical `P1[p]` and `H_P1[p]`, plus returned D-Bus/job request evidence without treating a reply as authorization;
- `EXECUTION_GATE_COMMITTED` or mutually exclusive `START_WINDOW_CLOSED`, any losing late invocation evidence, and for closure the fresh deterministic-name lookup, every-known-invocation lookup, no-current-job lookup, lookup hashes, and complete gate-held recheck evidence;
- worker runtime receipt `W[p]`, phase-bound record, exact cgroup path/ID, opened worker dev/inode identity, terminal witness, and exact loaded/unloaded reconciliation class;
- each PM2 operation endpoint/runtime receipt `M[o]`, binding the live socket and daemon session separately from `I_T`, plus every PM2/Nginx `BEGIN` and `QUIESCED` record and exact stage timing class without raw RPC payloads;
- start/stop/reload job identities and outcomes observed by a live subscriber, without treating an unobserved post-finalizer signal as mandatory;
- static guard path/hash/ELF/static-startup evidence, same-open-file next-stage evidence, next-stage hashes, and generic per-role environment-contract pass/fail/count/digest only;
- immutable phase results, mandatory-result status, outcome classifications, phase-gate/global-lock acquisition/release records, marker timeline, and contradiction checks;
- sanitized preflight, maintenance, PM2, listener, Nginx, audit, snapshot, restoration, and public cache-field evidence;
- exact invalid-partial pre/post-quarantine identity;
- final local transfer/candidate evidence only if durable `RUN_SUCCEEDED` has been read back at `TS` and the run reaches that boundary;
- journal references filtered by exact `_SYSTEMD_INVOCATION_ID`.

Spike artifacts remain an untrusted candidate evidence class. Later final-design and frozen-validation artifact identities are recorded separately and never relabel a spike candidate as approved implementation bytes.

No run automatically deletes its bundle, markers, evidence, units, quarantine, failed work, staging, local partials, or retained backups. Cleanup is separately reviewed and authorized.

Governed scripts never use `set -x` and never print command environments, PM2 environments, opaque configuration, cookies, authorization headers, tokens, passwords, private keys, response bodies, or secret-bearing values. Public probes emit only approved status/cache fields. Command outputs are reduced to exact non-secret fields before durable storage.

Terminal run markers mean:

- `RUN_SUCCEEDED`: mutator succeeded, restoration verified, and all final gates passed;
- `RUN_BLOCKED_PRE_MUTATION`: a read-only gate failed before mutator intent;
- `RUN_FAILED_NO_MUTATION`: either a valid phase-gate-linearized `START_WINDOW_CLOSED` with no execution gate/activity, or a gate-committed mutator with a valid full fence and no `ENTERED`, delegated `BEGIN`, production record, or contradictory evidence;
- `RUN_FAILED_RESTORED`: mutator or safety path failed, but a full mutator fence and verified restoration were obtained;
- `OPERATOR_REQUIRED`: process/delegate fencing unavailable, restoration nonretryably unavailable/failed, attempt 2 failed, boot changed, or trusted evidence was violated.

No terminal result authorizes cleanup, a new production run, publication, or a later release task.

## 26. Bounded architecture spike, frozen-design validation, and later tests

### 26.1 Spike authority and environment

This exact revision is only a bounded nonproduction architecture-spike charter candidate. After fresh independent architecture and security approval of this exact charter revision and user re-review, a spike may run only after separate explicit authorization. It may use an approved local, isolated nonproduction, or exact-target-safe environment, public sources, locally built candidates, and exact target artifacts or approved copies obtained under separate authority.

This charter does not authorize artifact acquisition, production access, production service mutation, SSH/SCP, public probing, credentials, raw environment or opaque configuration access, deployment, shared-state writes, or adoption of candidate bytes. A charter approval can authorize only consideration of a separately approved spike; it cannot authorize validation, implementation planning, implementation, or production work.

### 26.2 Questions and required candidate outputs

The spike may design and create untrusted **candidate** prototypes/artifacts only for:

1. a canonical descriptor encoder/decoder, schemas, topological dependency checker, and fixed positive/negative test vectors;
2. the static first-exec guard source/startup ABI/toolchain/build flags, candidate bytes, ELF/static provenance, raw-`envp` parser, and same-open-file next-stage execution/read mechanism;
3. byte-complete candidate controller and phase transient definitions, including every exact property, `Environment`, `UnsetEnvironment`, command, dependency array, and manager-added read-back treatment;
4. the exact installed-version PM2 existing-daemon-only private socket method, framing, request bytes, `pm_id`, callback boundary, bounded streaming selector, death/no-late-effect behavior, and proof strategy for no spawn/reconnect/fallback and no `pm2_env` materialization;
5. the exact Nginx unit/`ExecReload`/binary/config identity model, config-read interval observation algorithm, job-to-generation causality rule, complete old-worker-absence algorithm, concurrency/substitution rejection, and candidate helper interface;
6. uploaded-file, existing-tool, PM2 endpoint, and cgroup-worker receipt mechanisms, including no-symlink/no-hardlink/same-open-object/content revalidation; and
7. exact systemd-255 candidate property tuples, worker-inode continuity experiments, finalizer/unload paths, and evidence for or against universal overlap of controller deactivation and dependent containment sufficient to tighten `1905s`.

The spike report/artifact set must contain:

- candidate canonical schema/encoder/decoder bytes and hashes, fixed test vectors, graph-back-edge negatives, and a proof that accepted graphs have the section 7.5 topological order;
- candidate guard source and binary hashes, reproducible toolchain/startup provenance, ELF inspection, hostile-environment negatives, and same-open-file transition evidence;
- byte-complete candidate controller/phase transient definitions and sanitized exact read-back diffs for every role and path;
- exact PM2 source/module/version bindings, candidate method/framing/request/parser bytes, no-spawn process/syscall/source evidence, no-`pm2_env` evidence, and all specified death/timeout negatives;
- exact Nginx unit/binary/config/`ExecReload` bindings, candidate generation/config-read algorithm and bytes, job/generation/drain evidence, and concurrency/timeout negatives;
- candidate receipt schemas, open-object race negatives, and clear separation of `I_U`, `I_T`, `M[o]`, and `W[p]`;
- target-tuple/deadline observations, including explicit evidence for or against complete overlap of controller deactivation and dependent-phase containment; and
- a sanitized feasibility report that lists every unresolved mismatch as a blocker and contains no raw environment names/values outside the approved generic contract, `pm2_env`, opaque ecosystem content, credentials, cookies, tokens, response bodies, or secret-bearing data.

### 26.3 Spike non-goals and stop conditions

The spike must not write an implementation plan or production runbook; claim production readiness, final architecture approval, or validation success; install or execute candidate bytes in production; mutate real systemd/PM2/Nginx state; use production credentials; or treat a candidate artifact as approved implementation input. It must not relax no-auto-spawn, no-`pm2_env`, same-session completion, complete old-worker absence, gate retention, receipt integrity, deadlines, or fail-closed behavior. It must not fill a mismatch with “implementation decides,” a broad parser/status range, an unbounded wait, or a different target interface.

If exact approved artifacts are unavailable under separate authority, a candidate cannot meet a load-bearing invariant, or secret/opaque boundaries cannot be maintained, the spike returns `BLOCKED`. It does not reinterpret this charter as a final implementation design.

### 26.4 Later validation of a separately frozen final design

After the spike, a new tracked final implementation design must incorporate the exact selected encoding and test vectors, guard/toolchain bytes and interface, complete transient arrays, PM2 method/framing/parser, Nginx generation/config-read algorithm, receipt mechanisms, target tuples, and deadline choices. Fresh independent architecture and security approval of that exact final-design revision plus user re-review must occur before a separately authorized validation gate.

That later gate may execute and measure only the exact bytes and interfaces already frozen in the approved final design. It may not choose, redesign, patch, regenerate, broaden, or substitute any load-bearing interface. Any byte, identity, behavior, tuple, deadline, or evidence mismatch returns to final-design revision and fresh dual review/user re-review. Only after independent review and explicit acceptance of the validation artifacts may implementation-plan writing begin. The gate is future work and has not run.

The frozen artifact families are:

- exact distribution systemd-255/PID-1/cgroup-v2 behavior and exact frozen controller/phase definitions;
- exact frozen static first-exec guard bytes/build evidence, same-open-file mechanism, and per-role raw-environment behavior;
- exact frozen installed PM2/Node/module identities, existing-daemon-only socket method, framing/parser/request/callback interface, and byte hashes; and
- exact frozen `nginx.service`, every `ExecReload` command, Nginx binary/config identity, config-read/generation algorithm, and complete old-worker-drain behavior.

The later frozen-design validation systemd request/gate matrix must demonstrate, without modifying the frozen definitions:

- request 1, one byte-identical request 2, lost replies, both delivery orders, same-name conflicts, controller death before pre-start, and no third request;
- `ExecStartPre` in `.control`, creation/binding of the exact `worker` inode, continuity into phase `ExecStart` placement in `worker`, and `ExecStopPost` in `.control`;
- the race between `EXECUTION_GATE_COMMITTED` and `START_WINDOW_CLOSED`, proving mutual exclusivity and that a losing late pre-start never reaches main;
- immediately before closure while the global run lock and exact phase gate remain held, fresh deterministic-name absence, absence for every exact invocation learned from either request/job ledger, no current job for the deterministic name, complete boot/controller/request/marker rechecks, exact lookup evidence in the closure record, and fail-closed behavior for every unit, job, lookup error, disagreement, or same-name different invocation;
- a gate-committed pre-`BOUND` main failure obtaining a valid worker witness and reconciliation;
- finalizer witness behavior for success, `64`, `70`, `75`, signal, core, runtime timeout, explicit stop, controller-dependency stop, start/resource failure, finalizer failure, and SIGTERM-ignoring descendants;
- pinned/read-back `CollectMode=inactive`, exact loaded tuples, successful immediate unload with no subscriber, and every forbidden unloaded case from section 17.4;
- controller death after witness fsync/before finalizer exit, after finalizer exit/before read-back, same-name recreation, lookup disagreement, failed-unit retention, reset-failed simulation in isolation, and pre-witness disappearance.

The later frozen-design validation environment/provenance matrix must demonstrate:

- the guard's exact ELF/static/startup contract and next-stage hash verification;
- exact raw manager-generated environment for controller, pre-start, phase main, and finalizer roles;
- generic pass/fail evidence without raw names or values;
- rejection or harmlessness before next-stage execution under `LD_PRELOAD`, `LD_AUDIT`, `GLIBC_TUNABLES`, shell-function exports, `BASH_ENV`, `ENV`, `NODE_OPTIONS`, Node/npm variables, and ambient PM2 variables;
- exact finalizer handling of validated `SERVICE_RESULT`, `EXIT_CODE`, and `EXIT_STATUS`.

The later frozen-design validation PM2 matrix must compare the exact approved method, request bytes, `pm_id`, callback envelope/timing, socket/daemon receipt semantics, and no-late-effect meaning without changing them. Source, byte identity, syscall/process traces, and negative cases must prove direct existing-daemon-only connection, no daemon launch/fork/spawn/reconnect/fallback on every error, no materialized or decoded `pm2_env`, bounded streaming selection of approved non-secret acknowledgement fields, and the exact `5s + 15s + 15s + 5s = 40s` stage behavior. It must cover before-send death, after-send/before-callback death, callback loss, malformed response, permission/version/socket drift, target mismatch, helper death before durable `QUIESCED`, and deadline expiry.

The later frozen-design validation Nginx matrix must compare the exact approved unit/binary/config/job identities, config-read algorithm, generation algorithm, and generation record bytes without changing them. It must prove exact job-to-generation binding, a nonempty disjoint new generation after the approved config-read interval, every old worker absent before generic `QUIESCED`, concurrency/substitution rejection, and the exact `5s + 15s + 10s + 25s + 5s = 60s` stage behavior. It must cover job done without generation, generation without old-worker absence, master/config drift, helper death, timeout, and maintenance/open directions.

Validation artifacts must include exact frozen transient definitions, canonical property/command/dependency read-back, request and gate records, cgroup/inode identities, guard inspection/build evidence, sanitized environment outcomes, witness bytes/hashes, loaded/unloaded tuples, PM2 source/trace/protocol evidence, Nginx config-read/generation/job evidence, stage timing, deadline-overlap evidence, and negative-case results. Raw environment, `pm2_env`, opaque ecosystem content, credentials, and secret-bearing values remain prohibited.

If exact artifacts cannot be obtained under separate authority, any observed byte/interface differs from the frozen final design, a target tuple falls outside the closed matrices, worker-inode continuity cannot be proved, the guard contract fails, PM2 cannot avoid auto-spawn/reconnect/fallback or `pm2_env`, Nginx cannot prove complete old-worker absence, or universal deadline overlap is not proved, validation fails. Any design mismatch returns to a new final-design revision, fresh independent architecture/security approval, and user re-review before validation can be retried; the rule is never weakened to fit the target.

Independent reviewers must examine the complete validation artifact set and explicitly accept the frozen-design/observed-result match. Until that acceptance, implementation planning remains prohibited.

### 26.5 Later full integration suite

After a separately approved implementation exists, the later suite must additionally cover:

- exact transient names, properties, dependencies, all guarded command arrays, environment, hashes, and no `--wait`/`--pipe`/`--collect`;
- same-name/invocation substitution, duplicate execution-gate attempts, start-window closure, and worker-inode recreation races;
- mandatory result-before-intentional-`0/64/70/75`, result-fsync failure avoiding reserved exits, every result/main cross-product, every closed retry class, and impossibility of a third attempt;
- controller death before, during, and after execution gate, entry, delegate operations, finalizer witness, and unload;
- `BindsTo=` phase stop on exact controller loss and stop/reconcile-only behavior after controller recreation;
- cancellation before gate, `BOUND`, `ENTERED`, and every mutation/delegated-operation boundary;
- a gate held by a hung operation, immediate containment, finalizer witness, later cancel fence, and unresolved-delegate escalation without synthesized closure;
- all PM2/Nginx death, drift, timeout, concurrency, old-worker, no-auto-spawn, and opacity cases frozen by the approved final design and confirmed unchanged by its accepted validation artifacts;
- reboot after reservation and at every request/gate/bound/entered/result/witness/fence phase;
- boot mismatch suppressing query, reissue, adoption/stop, witness acceptance, restoration, and mutation;
- late invalid-partial drift and quarantine collision safety closure;
- local SCP, checksum, extraction, worktree, hydration, `npm ci`, audit, and bundle hangs with retained evidence;
- output scans proving no secrets, raw environment, opaque ecosystem content, broad deletion, PID-only kill, wildcard action, or unreviewed executable path.

Any failed case blocks implementation review. The implementation and test bytes require fresh independent security and architecture review before any production authorization.

## 27. Migration, review, rollout, and completion boundaries

The blocked round-5 scripts and their prior local suite remain historical evidence only. They are not production inputs and are not wrapped by this architecture.

The mandatory sequence is:

1. this tracked **architecture-spike charter** correction;
2. fresh independent architecture and security review of this exact charter revision plus user re-review, with any approval limited to spike-charter authority;
3. separate explicit authorization for the bounded nonproduction spike and for any exact artifact access;
4. spike execution producing only candidate prototypes/artifacts and a sanitized feasibility report;
5. a new tracked **final implementation design** revision incorporating the exact selected canonical encoding, guard/toolchain bytes and interface, complete transient arrays, exact PM2 method/framing/parser, exact Nginx generation/config-read algorithm, exact receipt mechanisms, target tuples, and deadline choices;
6. fresh independent architecture and security approval of that exact final-design revision plus user re-review;
7. a separate validation gate of the frozen final design, executing/measuring only the already-selected bytes and interfaces without choosing, redesigning, patching, regenerating, or broadening them; any mismatch returns to step 5 and fresh review;
8. independent review of the complete validation artifacts and explicit acceptance of the frozen-design/observed-result match;
9. only then may implementation-plan writing begin; and
10. later local implementation/static tests, the full isolated systemd-255/cgroup-v2 integration suite, exact implementation-bundle base-manifest/run generation and review, separate production authorization, governed root-only upload/execution, and independent post-run security and Task 5 review remain subsequent stages.

Implementation-bundle `B`, `H_B`, `R`, `L`, and `H_L` generation occurs only at step 10 after the final design is frozen, approved, validated, and its validation artifacts accepted. Target-local `I_U`, `I_T`, `M[o]`, and `W[p]` receipts still occur only at their defined downstream points after upload/publication or after the referenced target/runtime object exists; none feeds the run ID.

No implementation planning, validation, implementation, or production work may begin from this charter alone. No permanent daemon, static/enabled unit, timer, socket, path unit, package, Nginx config change, PM2 config change, or boot recovery mechanism is introduced.

A future Task 5 implementation becomes eligible for production review only within step 10 after the required local/static and isolated integration suites pass, exact implementation-bundle identities are independently approved, and current production preflight still matches. Production execution still requires separate explicit user authorization. This specification and its commit authorize none of those later stages, production access, or release continuation.

## 28. Architecture references

Load-bearing review must use the systemd v255 versions of:

- `systemd-run(1)` for `--expand-environment=no`, asynchronous transient creation, and transient property setting;
- `systemd.service(5)` for `Type=exec`, `ExitType=cgroup`, non-optional `ExecStartPre=`, `ExecStopPost=`, `TimeoutStartSec=`, `RemainAfterExit=`, stop-post `$SERVICE_RESULT`/`$EXIT_CODE`/`$EXIT_STATUS`, and result semantics;
- `systemd.kill(5)` for `KillMode=control-group`, stop signals, separate worker/finalizer stop slots, and forced-kill behavior;
- `systemd.exec(5)` for manager-compiled environment sources, command arrays, and execution-context properties;
- `systemd.unit(5)` for `CollectMode=inactive`, garbage collection/unload, `BindsTo=`, and `After=` semantics;
- `systemctl(1)` and `org.freedesktop.systemd1(5)` for exact property/invocation/job lookup, `GetUnitByInvocationID`, `RefUnit`, job/unit signals, and D-Bus reload reconciliation;
- systemd v255 transient-property setter/read-back source for `ExecStartPre`, `ExecStart`, `ExecStopPost`, `TimeoutStartSec`, `CollectMode`, `DelegateSubgroup`, dependencies, invocation, and cgroup identity;
- systemd v255 `service.c`, `execute.c`, `dbus-manager.c`, `dbus-service.c`, `dbus-unit.c`, `cgroup.c`, and `cgroup-setup.c` paths governing placement, terminal transitions, job signals, unloading, and cgroup pruning.

Kernel semantics must be reviewed against the Linux cgroup v2 documentation for `cgroup.events`, recursive `populated`, cgroup identity, and removal. Static first-exec evidence must be reviewed against the target ELF ABI and exact inspection/build artifacts proving ELF type, absence of `PT_INTERP`/`DT_NEEDED`/`RPATH`/`RUNPATH`, direct startup behavior, and fixed next-stage `execve`.

The later final design's selected canonical descriptor encoding, schema files, fixed test vectors, and graph checker become the authoritative identity basis only after exact incorporation, fresh dual approval/user re-review, frozen validation, and independent validation-artifact acceptance. The same rule applies to the selected same-open-file execution/read mechanism and exact guard/helper bytes: spike prototypes and generic pathname-check patterns are not authoritative.

PM2 behavior must be reviewed against the exact installed-version Node binary and pinned daemon/client/RPC source and bytes. The authoritative PM2 basis must include the final-design-selected private socket open/connect method, exact framing/request bytes, callback envelope, bounded streaming parser bytes, endpoint/runtime receipt rules, process/syscall traces, no-auto-spawn/reconnect/fallback negatives, and opaque-response/no-`pm2_env` evidence. Generic high-level APIs, CLI polling, a broad parser, or any surface that materializes `pm2_env` are not authoritative.

Nginx behavior must be reviewed against the exact installed binary/config identities, `nginx.service` and every `ExecReload` definition, Nginx reload/generation/drain semantics, process identities, and exact systemd v255 D-Bus job behavior. The authoritative Nginx basis must include the final-design-selected config-read interval observation algorithm, job-to-generation causality rule, complete old-worker-absence algorithm, generation record schema, and concurrency/substitution negatives. A completed reload job or a new generation without complete old-worker absence is not generic `QUIESCED`.
