# Task 5 systemd remote-fencing design

Date: 2026-08-06

Prior architecture-direction approval date: 2026-08-06

Status: corrected exact revision pending independent security and architecture approval and user re-review; implementation planning and production work remain prohibited

Review isolation: independent-required; this documentation execution provides self-review only and is not an independent approval

## 1. Context, current state, and authority

Task 5 of the English article release must capture a consistent production source snapshot, restore the old public service, transfer the verified snapshot, and create an isolated detached candidate. The original release design and Task 5 plan remain authoritative for content, snapshot, candidate, restoration, taxonomy, opaque-configuration, secret-handling, and release boundaries. This specification changes only the remote execution ownership and fencing architecture.

The prior systemd architecture direction was user-approved on 2026-08-06. Exact commit `6d654616eb696124e052f05d2ef650dbdda6686c` closed the earlier post-terminal cgroup-path, delegated-operation ownership, boot identity, and cancellation defects at the design-contract level, but fresh independent security and architecture reviews required corrections to six remaining interfaces: the durable pre-main boundary, loaded/unloaded terminal evidence, pre-first-exec environment trust, exact PM2/Nginx closure, deadline algebra, and result/retry precedence. This corrected exact revision requires fresh independent security and architecture approval and user re-review before the future empirical architecture gate or implementation-plan writing.

The current Task 5 production state remains unchanged and safely blocked:

- The old public service was restored and independently verified.
- Maintenance is inactive, PM2 is online, the application listens only on `127.0.0.1:3000`, production remains at the expected pre-release commit, and the localized-content audit passed at `4/4/4/4` in the retained review evidence.
- `/root/blog-english-release-20260804` contains the exact invalid partial snapshot recorded in section 22 and has no `SHA256SUMS`.
- No local source transfer, detached candidate, candidate worktree, or release bundle exists.
- The round-5 retry executable remains blocked and must not be executed.

This documentation correction changes no implementation plan, runbook, code, test, production file, production state, ignored historical evidence, or release artifact. It authorizes no production access or action.

## 2. Decision summary

Each governed remote attempt is owned by deterministic transient systemd services on the production host:

1. One transient controller service owns orchestration, the global run lock, durable reconciliation, phase creation, cancellation, and run classification.
2. One transient mutator service owns maintenance enablement, PM2 stop, invalid-partial quarantine, and fresh snapshot creation.
3. One or, only for a closed retry class, two transient restoration services restore and verify the old public service.
4. Every phase is bound to the exact controller unit through reviewed `BindsTo=` and `After=` dependencies, and to the controller's exact `InvocationID` through immutable records and gate checks.
5. Every phase uses `Type=exec`, `ExitType=cgroup`, `RemainAfterExit=no`, `Restart=no`, `Delegate=yes`, `DelegateSubgroup=worker`, pinned `CollectMode=inactive`, one non-optional `ExecStartPre`, and an exact common `ExecStopPost` finalizer.
6. A manifest-pinned static first-exec guard is the first executable for controller `ExecStart`, phase `ExecStartPre`, phase `ExecStart`, and phase `ExecStopPost`. It validates hostile raw environment bytes before clean `execve`; `/usr/bin/env -i` is not the pre-first-exec boundary.
7. A D-Bus reply, returned job path, or transient-creation acknowledgement is request evidence only. PID 1 may proceed to a mutation-capable phase main only after `ExecStartPre` durably creates the exact invocation's immutable `EXECUTION_GATE_COMMITTED` record.
8. The execution gate and a phase-gate-linearized `START_WINDOW_CLOSED` record are mutually exclusive. The controller may make one byte-identical request reissue, but a late pre-start process can neither cross a durable closure nor create a second execution gate.
9. The phase main process and all descendants execute in `${ControlGroup}/worker`; systemd control processes, including pre-start and finalizer processes, execute in `${ControlGroup}/.control`.
10. While alive in `.control`, the finalizer proves the execution-gate-bound `worker` subgroup recursively empty and durably records that observation before the unit root can be pruned. Every gate-committed invocation requires this witness and path-specific terminal reconciliation, even if `BOUND` is absent.
11. Every PM2 or Nginx operation delegated outside the phase cgroup has immutable `BEGIN` and exact matching `QUIESCED` records. An unmatched `BEGIN` prevents a full fence; timeout or later polling never manufactures closure.
12. A root-only per-phase gate linearizes the execution gate or start closure, binding, entry, cancellation, every production mutation, and every delegated dispatch through durable completion.
13. The controller retains the global run lock across the complete normal mutator/restoration interval and never releases it between phases.
14. Boot identity is durable and mandatory. A run never crosses a boot.
15. Loaded and unloaded terminal evidence are reconciled through closed path-specific matrices. A valid finalizer witness remains the process proof; there is no universal post-finalizer `JobRemoved` requirement, and unloaded inference is limited to one successful inactive family under pinned `CollectMode=inactive`.
16. Client and transport results never prove phase completion, external-operation completion, fencing, restoration, or run success.

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
- require one future exact-target architecture-validation gate covering systemd request/gate/unload behavior, the static first-exec environment guard, and exact PM2/Nginx artifacts before implementation-plan writing, followed by a later full integration suite before production review.

## 4. Non-goals and prohibited effects

This design does not:

- authorize production execution, SSH, SCP, public probing, transient-unit creation, PM2 or Nginx mutation, backup, snapshot, transfer, publication, deployment, deletion, cleanup, or push;
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
- the exact reviewed root-owned static first-exec guard, pre-start helper, launchers, scripts, finalizer, system tools, Nginx binary/unit, PM2 daemon/client/RPC implementation, Node.js runtime, and validation tools, but only after the future exact-artifact gate freezes and approves their identities;
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
- polling alone as replacement for a lost external-manager acknowledgement.

### 5.3 Explicitly out of scope

The protocol does not claim safety against:

- a malicious or compromised root user, kernel, PID 1, Nginx, PM2, or reviewed toolchain after validation;
- privileged cgroup migration or replacement of immutable marker/evidence files;
- storage that violates the assumed atomic-create, rename, and fsync semantics.

From reservation to terminal run state, uncoordinated root, `systemctl`, PM2, Nginx, Task-5-path, tool, or cgroup activity is unsupported. Unexpected jobs, identity changes, file drift, cgroup movement, or unexplained lock ownership creates `FAULT_PENDING`. Productive forward progress stops; automation may perform only exact containment, witness/fence construction, and an already-authorized restoration path needed to reach a safe terminal result. A trusted-boundary violation ends in `OPERATOR_REQUIRED`.

## 6. Required platform capabilities and semantic basis

Before any implementation is accepted, the architecture requires:

- Linux with systemd exactly version 255 for the reviewed deployment target;
- systemd v255 running as PID 1;
- a unified cgroup v2 hierarchy mounted at `/sys/fs/cgroup`;
- transient services, `Type=exec`, `ExitType=cgroup`, `InvocationID`, `ControlGroupId`, `Delegate=`, `DelegateSubgroup=`, `BindsTo=`, `After=`, non-optional `ExecStartPre=`, `ExecStopPost=`, `TimeoutStartSec=10s`, `CollectMode=inactive`, and the required D-Bus job/property APIs;
- a root-owned reviewed filesystem location with atomic exclusive create, atomic no-replace rename, and file/directory fsync behavior;
- one manifest-pinned static first-exec guard satisfying section 10 for controller `ExecStart`, phase `ExecStartPre`, phase `ExecStart`, and phase `ExecStopPost`;
- the previously reviewed maintenance no-store prerequisite, exact inactive site, retained maintenance backups, expected production Git boundary, loopback listener, passing audit, empty operation registry, and sufficient disk;
- the exact current invalid-partial identity in section 22;
- an exact installed PM2 existing-daemon-only RPC interface that meets the no-auto-spawn and no-`pm2_env`-exposure rules in section 13;
- an exact Nginx systemd reload path that binds the D-Bus job to a new worker generation and proves every old worker absent before generic `QUIESCED`;
- successful completion and independent approval of the future combined exact-target gate in section 26 before implementation-plan writing.

The load-bearing semantics are:

- `Type=exec` reports process setup and executable failures rather than treating a pre-`execve` fork as successful start; its acknowledgement is still only request/job evidence.
- One exact non-optional `ExecStartPre=` must complete successfully before PID 1 may invoke phase `ExecStart=`. Its durable `EXECUTION_GATE_COMMITTED` record, not the D-Bus reply, is the conservative pre-main boundary.
- `ExitType=cgroup` keeps a phase running while any process remains in its service cgroup.
- `DelegateSubgroup=worker` places the main service process and descendants in the delegated `worker` subgroup while systemd control processes, including `ExecStartPre` and `ExecStopPost`, run in `.control`.
- `KillMode=control-group` with the fixed signal policy contains all phase-owned processes.
- `Restart=no` prevents manager-driven re-entry.
- `RemainAfterExit=no` permits successful units to become inactive and transient units/cgroups to be pruned after finalization.
- `CollectMode=inactive` retains failed units but permits successful inactive units to unload; the design relies only on the narrow successful-unloaded inference in section 17 and not on terminal retention generally.
- cgroup v2 `cgroup.events` reports recursive `populated 0` for an existing cgroup and all descendants.
- systemd v255 may prune an empty service cgroup while transitioning to successful, failed, or inactive state. Later absence is never process proof and never rehabilitates a missing or invalid witness.

These semantics and the exact PM2/Nginx interfaces require the future combined exercise in section 26. This document specifies its closed acceptance rules but does not claim that any empirical gate has run or that exact target artifacts are available.

## 7. Deterministic manifest, run identity, and symbolic notation

Each independently reviewed implementation bundle has one canonical `review.manifest`:

- UTF-8, LF-only, sorted key/value records;
- no comments, timestamps, random values, credentials, host-fetched secret data, or opaque configuration content;
- exact hashes, sizes, modes, owners, device/inode identities, and absolute paths for the static first-exec guard, pre-start gate helper, controller launcher, phase launcher, mutator, restoration, finalizer, reconciliation, upload verifier, PM2 RPC helper, Nginx control helper, every dynamic next-stage binary, and every production tool;
- the guard's exact ELF type and program/dynamic-header evidence, static-link and startup provenance, approved direct syscall/runtime dependency set, and fixed role modes;
- exact feature HEAD `1ee3fbc3ebc43f552d3f592bf41d79751ca6a731`;
- expected production HEAD `860bfe53e54dff4ab78bbfa2f7e5f644a032b9aa`;
- exact systemd properties, dependency arrays, controller `ExecStart`, phase `ExecStartPre`, phase `ExecStart`, and phase `ExecStopPost` command arrays, with the static guard first in every array;
- exact per-role hostile raw-environment schemas, approved clean-environment schemas, marker/result/witness schemas, operation families, and every deadline constant from sections 10, 16, 17, and 21;
- exact request-description bytes and digest shared by request ordinals 1 and 2; request ordinal never changes unit properties or command arrays;
- exact canonical paths and the future validation-artifact identities for the installed PM2 version, Node binary, PM2 daemon/client/RPC modules and socket protocol, `nginx.service`, every `ExecReload` command, Nginx binary/config identities, worker-generation contract, and systemd loaded/unloaded tuples;
- the invalid-partial identity from section 22 and exact reviewed maintenance snippet/site/backup identities inherited from the blocked Task 5 controls.

The deterministic run ID is:

`run_id = "t5-20260804-" + lowercase_hex(SHA-256(review.manifest bytes))`

Its syntax is `^t5-20260804-[0-9a-f]{64}$`. The manifest does not contain the derived run ID. A separate root-only `run.id` contains the derived value.

Notation such as `${RUN_ID}`, `${PHASE}`, `${PHASE_UNIT}`, `${CONTROLLER_UNIT}`, `${INVOCATION_ID}`, and `${ControlGroup}` denotes a value already validated and resolved by the controller or launcher. The literal notation is never passed to a shell or systemd for interpolation.

Any implementation byte, dependency, environment field, property, path, deadline, expected state, PM2 identity, Nginx identity, or manifest change produces a new run ID and requires fresh independent review. A terminal production outcome is never rerun in place under the same ID.

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

Every controller and phase start receives a systemd-generated 32-lowercase-hex `InvocationID`. A phase binding names:

- run ID and manifest hash;
- boot ID;
- exact phase and attempt;
- phase unit and `InvocationID`;
- controller unit and controller `InvocationID`;
- exact dependency/property digest;
- exact static guard, pre-start gate helper, launcher, phase script, and finalizer hashes;
- exact request-set digest and request ordinal evidence;
- exact execution-gate or start-window-closure identity when either exists.

A same-name unit with a different invocation is a conflict. A new same-run controller invocation is a reconciliation actor, not a continuation of the prior invocation and never authorizes a second execution gate or reruns a gate-committed phase.

### 8.4 Request and execution identity

Each phase has request ordinal 1 and at most one ordinal 2. The controller fsyncs the canonical exact request description before each dispatch. Returned D-Bus reply status and job ID/path are persisted only as request/job evidence; they do not prove historical manager acceptance, main execution, completion, or no mutation.

`EXECUTION_GATE_COMMITTED` binds the actual systemd-generated phase `InvocationID` to the run, manifest, boot, deterministic unit, controller unit/invocation, property digest, `ControlGroup`/`ControlGroupId`, bound `worker` identity, static guard and helper hashes, request-set digest, phase-gate identity, and marker-state digest. Only this record permits conservative inference that PID 1 may execute the phase main. `START_WINDOW_CLOSED` binds the same run/phase/request set and proves instead that every late pre-start process must fail before main. The two records are mutually exclusive under the phase gate.

## 9. Root-only paths and permissions

The durable root is:

`/var/lib/blog/task-5-systemd-fencing`

Required layout:

- `global.lock` — controller-owned advisory lock file, root:root `0600`;
- `active-run` — atomically updated convenience pointer, never authoritative;
- `incoming/${RUN_ID}/` — upload staging, root:root `0700`;
- `runs/${RUN_ID}/bundle/` — verified immutable implementation bundle, root:root `0700`;
- `runs/${RUN_ID}/markers/` — immutable transition records, root:root `0700`;
- `runs/${RUN_ID}/gates/` — one lock file per phase, root:root `0700` directory and `0600` files;
- `runs/${RUN_ID}/evidence/` — sanitized property, job, operation, witness, result, and validation evidence, root:root `0700`;
- `runs/${RUN_ID}/controller-invocations/` — one immutable record per controller runtime cycle;
- `runs/${RUN_ID}/phase-invocations/` — exact phase/controller/unit bindings.

Regular manifests, records, and evidence files are root:root `0600`. Executable bundle files are root:root `0500`. No symlink, hardlink, device, FIFO, socket, group/other-writable directory, or unexpected entry is accepted in the governed tree.

All transient units run with `User=root`, `Group=root`, and `UMask=0077`. No durable state is stored under `/tmp`, `/private/tmp`, a home directory, the Git checkout, the journal alone, or the production release tree.

The production release and quarantine paths remain:

- canonical release: `/root/blog-english-release-20260804`
- invalid-partial quarantine: `/root/blog-english-release-20260804.failed-${RUN_ID}`

The quarantine destination must be absent and is created only by the reviewed atomic no-replace whole-root rename.

### 9.1 Upload and bundle provenance

The future governed upload path retains these boundaries:

1. the client computes the canonical manifest hash and deterministic run ID from the independently approved local bundle;
2. a fixed bootstrap using only reviewed absolute tools creates the absent `incoming/${RUN_ID}` directory with root:root `0700`;
3. files transfer as regular files to unique temporary basenames, never as a script from standard input, a here-document, a pipe, `/tmp`, or an unverified execution path;
4. before uploaded code executes, exact remote `stat` and `sha256sum` identities are compared with independently approved local values;
5. the verified upload verifier inventories every entry without following symlinks, rejects extras and unsafe types, and checks exact name, size, mode, owner, and SHA-256 against `review.manifest`;
6. the verifier recomputes the run ID and requires it to equal the requested path and unit-name identity;
7. the verified incoming directory is atomically published without replacement as `runs/${RUN_ID}/bundle`;
8. before every service creation, the controller rechecks the complete bundle, manifest, target script, finalizer, helpers, run ID, and exact unit contract;
9. no production mutation occurs before controller-side and phase-side identity checks pass.

No credential, token, cookie, password, opaque ecosystem content, or secret-bearing value appears in the manifest, upload path, unit name, command line, journal identifier, marker, or evidence.

## 10. Pre-first-exec environment and command provenance

Every transient creation path uses either `systemd-run --expand-environment=no` or exact D-Bus command arrays with no client, manager, or shell interpolation. `--wait`, `--pipe`, and `--collect` remain forbidden. Unit-property read-back strengthens this contract but does not by itself prove the complete manager-compiled environment.

### 10.1 Static first-exec guard

All four systemd entry classes begin with the same manifest-pinned static guard binary in a fixed role mode:

1. controller `ExecStart`;
2. phase `ExecStartPre` execution gate;
3. phase `ExecStart` main launcher;
4. phase `ExecStopPost` finalizer launcher.

The exact guard path is:

`/var/lib/blog/task-5-systemd-fencing/runs/${RUN_ID}/bundle/bin/task5-first-exec-guard`

Its role is limited to validating hostile raw `envp` before any environment-controlled code loading, validating fixed argv and systemd identity, verifying the exact next-stage path and bytes, constructing the exact clean `envp`, and directly `execve`-ing that next stage. It creates no marker, child, fork, background process, network activity, or production effect. The pre-start helper, controller launcher, phase launcher, and finalizer remain separate reviewed next stages.

The manifest and future pre-plan artifact must prove that the guard is an owner `0:0`, mode `0500`, regular non-symlink/non-hardlink file with exact path, size, SHA-256, device/inode, and build provenance; is ELF `ET_EXEC` or static-PIE `ET_DYN`; has no `PT_INTERP`, `DT_NEEDED`, `RPATH`, or `RUNPATH`; has no dynamic-loader dependency or environment-controlled plugin/module lookup; and uses a custom/freestanding or independently proven startup that does not consult locale, NSS, shell startup, loader tunables, configuration paths, or raw environment before validation. Only the reviewed direct syscall/runtime dependency set is allowed. Before clean `execve`, the guard verifies the exact next-stage path, owner, mode, size, SHA-256, device/inode, and manifest role.

The future gate must combine static inspection with negative execution under `LD_PRELOAD`, `LD_AUDIT`, `GLIBC_TUNABLES`, exported shell functions, `BASH_ENV`, `ENV`, `NODE_OPTIONS`, Node/npm variables, and ambient PM2 variables. None may execute or influence guard behavior. Failure of this proof blocks the architecture; it is not deferred to implementation discretion.

### 10.2 Exact command arrays

The reviewed next-stage paths are:

- pre-start gate helper: `/var/lib/blog/task-5-systemd-fencing/runs/${RUN_ID}/bundle/bin/task5-phase-execution-gate`;
- controller launcher: `/var/lib/blog/task-5-systemd-fencing/runs/${RUN_ID}/bundle/bin/task5-controller-launcher`;
- phase launcher: `/var/lib/blog/task-5-systemd-fencing/runs/${RUN_ID}/bundle/bin/task5-phase-launcher`;
- common finalizer: `/var/lib/blog/task-5-systemd-fencing/runs/${RUN_ID}/bundle/bin/task5-phase-finalizer`.

Before unit creation, the manifest resolves exact NUL-free concrete argument vectors. Each vector begins with the static guard, its fixed role, the exact next-stage path/hash, and then the fixed next-stage arguments:

- controller `ExecStart`: guard role `controller`, controller launcher, `--run-id`, `${RUN_ID}`, `--manifest-hash`, `${MANIFEST_HASH}`, `--boot-id`, `${BOOT_ID}`, `--unit`, `${CONTROLLER_UNIT}`, `--script`, `${CONTROLLER_SCRIPT_ABSOLUTE}`;
- phase `ExecStartPre`: guard role `phase-prestart`, pre-start gate helper, `--run-id`, `${RUN_ID}`, `--manifest-hash`, `${MANIFEST_HASH}`, `--boot-id`, `${BOOT_ID}`, `--phase`, `${PHASE}`, `--unit`, `${PHASE_UNIT}`, `--controller-unit`, `${CONTROLLER_UNIT}`, `--controller-invocation`, `${CONTROLLER_INVOCATION_ID}`, `--request-set-digest`, `${REQUEST_SET_DIGEST}`, `--gate-record`, `${EXECUTION_GATE_RECORD_ABSOLUTE}`, `--closed-record`, `${START_WINDOW_CLOSED_RECORD_ABSOLUTE}`;
- phase `ExecStart`: guard role `phase-main`, phase launcher, `--run-id`, `${RUN_ID}`, `--manifest-hash`, `${MANIFEST_HASH}`, `--boot-id`, `${BOOT_ID}`, `--phase`, `${PHASE}`, `--unit`, `${PHASE_UNIT}`, `--controller-unit`, `${CONTROLLER_UNIT}`, `--controller-invocation`, `${CONTROLLER_INVOCATION_ID}`, `--execution-gate-record`, `${EXECUTION_GATE_RECORD_ABSOLUTE}`, `--script`, `${PHASE_SCRIPT_ABSOLUTE}`;
- phase `ExecStopPost`: guard role `phase-finalizer`, common finalizer, `--run-id`, `${RUN_ID}`, `--manifest-hash`, `${MANIFEST_HASH}`, `--boot-id`, `${BOOT_ID}`, `--phase`, `${PHASE}`, `--unit`, `${PHASE_UNIT}`, `--controller-unit`, `${CONTROLLER_UNIT}`, `--controller-invocation`, `${CONTROLLER_INVOCATION_ID}`, `--execution-gate-record`, `${EXECUTION_GATE_RECORD_ABSOLUTE}`, `--bound-record`, `${BOUND_RECORD_ABSOLUTE}`, `--result-record`, `${RESULT_RECORD_ABSOLUTE}`, `--witness-record`, `${WITNESS_RECORD_ABSOLUTE}`.

The arrays contain no shell metacharacter processing, empty argument, relative path, or runtime interpolation. Their concrete byte sequences and digests are read back and compared with the manifest. Controller and phase services are created asynchronously; every creation return is request evidence only and never execution or completion evidence.

After the guard has established the boundary, the controller and phase launchers may invoke `/bin/bash -p --noprofile --norc` with the exact absolute script path and fixed argument array. `/usr/bin/env -i` may remain as defense in depth after the guard, but it is not described as protecting the already-started guard or any prior code. Every next stage and production tool is absolute, root-owned, and hash-pinned.

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

Only the `phase-finalizer` role may additionally receive `SERVICE_RESULT`, `EXIT_CODE`, and `EXIT_STATUS`, and each may be absent only when the exact v255 target path documents that no main-process value exists. When present, `SERVICE_RESULT` must be one exact v255 documented token from `success`, `protocol`, `timeout`, `exit-code`, `signal`, `core-dump`, `watchdog`, `start-limit-hit`, `resources`, `oom-kill`, or `exec-condition`; `EXIT_CODE` must be `exited`, `killed`, or `dumped`. For `EXIT_CODE=exited`, `EXIT_STATUS` is canonical decimal `0` through `255`; for `killed` or `dumped`, it is the exact canonical signal name emitted by the validated v255 target artifact. The future target artifact freezes that finite signal-name set byte-for-byte before planning. The guard passes only these validated values to the clean finalizer.

`PM2_HOME` is rejected at every systemd first-exec boundary. The exact reviewed value is added only inside the already-sanitized PM2 helper path. No other manager, PAM, login, loader, shell, Node, npm, or PM2 variable is permitted.

The contract continues to prohibit `EnvironmentFile` and nonempty `EnvironmentFiles`, `PassEnvironment`, PAM/login environment synthesis, client environment pass-through, nonempty `ExecSearchPath`, command expansion, secret-bearing values, and every unlisted raw variable. Required read-back includes `SetLoginEnvironment=no`, empty `EnvironmentFiles`, empty `PassEnvironment`, empty `ExecSearchPath`, exact `Environment` and `UnsetEnvironment` arrays, all four exact command arrays, and all guard/next-stage hashes. Runtime evidence never prints raw environment or secret-bearing data.

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
| `RuntimeMaxSec` | `1800s` |
| `TimeoutStopSec` | `60s` |
| `User` / `Group` | `root` / `root` |
| `UMask` | `0077` |
| `WorkingDirectory` | `/` |
| `StandardInput` | `null` |
| `StandardOutput` / `StandardError` | `journal` / `journal` |
| `SetLoginEnvironment` | `no` |
| `ExecStart` | exact controller array beginning with the static first-exec guard |

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
| `ExecStartPre` | exactly one non-optional execution-gate array beginning with the static guard |
| `ExecStart` | exact phase-main array beginning with the static guard |
| `ExecStopPost` | exact common-finalizer array beginning with the static guard |

Phase runtimes are:

| Unit | Internal work budget | `RuntimeMaxSec` | Protocol margin |
|---|---:|---:|---:|
| mutator | control `120s` + snapshot `600s` = `720s` | `780s` | `60s` |
| restoration attempt 1 | `180s` | `240s` | `60s` |
| restoration attempt 2 | `180s` | `240s` | `60s` |

The phase main process and every descendant execute in `${ControlGroup}/worker`. Systemd control processes, including `ExecStartPre` and `ExecStopPost`, execute in `${ControlGroup}/.control`. The future exact-build gate must prove that the `worker` device/inode opened and bound by `ExecStartPre` is the subgroup into which the later phase `ExecStart` is placed. Failure blocks the architecture. No phase process may migrate out of `worker`, create an alternate delegated subgroup, or move an unrelated process into the unit.

### 11.3 Exact dependency and property read-back

Before treating an observed phase unit as matching request evidence or allowing gate/reconciliation handling, the controller reads through systemd D-Bus and requires:

- exact unit ID, canonical name, `Transient=yes`, and exact transient fragment identity;
- exact nonempty phase `InvocationID` and current authoritative boot ID;
- exact `BindsTo=` containing only the deterministic controller unit and the complete reviewed `After=` array containing that unit plus only the pinned manager-added dependencies;
- the controller unit loaded with the expected controller `InvocationID` and no terminal/cancellation state that forbids continuation;
- every property in sections 10 and 11, including `CollectMode=inactive`, exact `ExecStartPre`, `ExecStart`, and `ExecStopPost` arrays, `TimeoutStartSec=10s`, exact runtime/stop deadlines, and `NRestarts=0`;
- exact `ControlGroup`, nonzero `ControlGroupId`, and no unexpected job or dependency;
- exact unit-property digest equal to the manifest, execution gate, and phase binding.

The pre-start gate helper performs the first complete identity/property/cgroup/environment check before committing the execution gate. The phase launcher repeats these checks before `BOUND`, before `ENTERED`, and under its gate before every mutation boundary. A controller invocation mismatch stops productive work and creates `FAULT_PENDING`; the phase may then participate only in safe cancellation and reconciliation.

`BindsTo=` plus `After=` must cause PID 1 to stop a live phase when the bound controller unit becomes inactive. A new controller invocation never cancels that stop or treats the old phase as normally continuable. Tests must verify controller death before phase entry, during every phase stage, and during finalization, including same-name controller recreation.

## 12. Durable execution gate, phase binding, and finalizer witness

### 12.1 Non-optional pre-main execution gate

Every phase has exactly one non-optional `ExecStartPre=` command. PID 1 may invoke `ExecStart=` only after it exits successfully. The command begins with the static first-exec guard and then executes the reviewed pre-start gate helper in the exact clean environment.

The helper is non-production-mutating. Its allowed effects are limited to exact identity/property/cgroup/environment verification; taking the phase gate; creating or opening the exact `worker` subgroup through no-symlink traversal; binding its device/inode identity; proving the exact target-build placement contract; exclusively creating and file/parent-fsyncing `EXECUTION_GATE_COMMITTED`; and writing sanitized evidence inside the governed run tree. It must not touch Nginx, PM2, release paths, Git, snapshot data, listeners, production content, quarantine, external network state, or any later-phase marker.

While holding the phase gate, the helper rechecks boot ID, controller and phase identity, exact properties and command arrays, request records, terminal/fault/cancellation state, and absence of `START_WINDOW_CLOSED` and any competing execution gate. It then commits `EXECUTION_GATE_COMMITTED` bound to the actual phase `InvocationID`, exact `ControlGroup`/`ControlGroupId`, the pre-created or validated `worker` device/inode, static guard and helper hashes, request-set digest, gate identity, and marker-state digest. If it cannot establish and fsync that record, it exits nonzero and PID 1 must not execute the phase main.

`EXECUTION_GATE_COMMITTED` and `START_WINDOW_CLOSED` are mutually exclusive. A losing duplicate or late pre-start process exits nonzero before main and cannot create `BOUND`, `ENTERED`, or a delegated-operation record. The future systemd-255 gate must prove that the `worker` inode bound here is the subgroup into which the later `ExecStart` is placed; failure blocks the architecture.

### 12.2 Phase bound and entered records

The immutable phase bound record binds at least:

- run ID and manifest hash;
- authoritative boot ID;
- exact phase/attempt and unit name;
- exact phase `InvocationID` and `EXECUTION_GATE_COMMITTED` hash;
- exact controller unit and controller `InvocationID`;
- exact `ControlGroup` and nonzero `ControlGroupId`;
- the gate-bound `worker` subgroup device and inode identity obtained without symlink traversal;
- exact unit-property digest;
- static guard, pre-start helper, launcher, phase script, and finalizer hashes;
- exact expected phase-result path and schema digest;
- exact terminal-witness path and schema digest;
- gate identity and current marker-state digest.

The launcher requires the exact execution gate, takes the phase gate, repeats the complete unit/boot/controller/cgroup/worker/environment/cancellation check, and creates `BOUND`. It creates `ENTERED` under the same gate only after a second complete recheck immediately before productive work. `ENTERED` is the threshold after which mutator production mutation cannot be excluded and restoration becomes mandatory after full fencing.

A gate-committed invocation that fails before `BOUND` remains conservatively execution-capable and must obtain the process witness and path-specific reconciliation below. It may be classified no mutation only after a valid full fence and only when `ENTERED`, every delegated `BEGIN`, and every production record are absent.

### 12.3 Finalizer witness procedure

The exact common `ExecStopPost` finalizer has a `5s` internal deadline inside its fresh outer `TimeoutStopSec=10s` stop-post slot. The static guard validates its raw environment before invoking finalizer code. For every invocation with `EXECUTION_GATE_COMMITTED`, the finalizer must within that deadline:

1. verify fixed run, manifest, phase, unit, controller, gate/result/witness paths and schemas, compare the current boot ID, and validate the execution gate;
2. query the exact unit and require the gate-bound `InvocationID`, `ControlGroup`, nonzero `ControlGroupId`, `Delegate=yes`, `DelegateSubgroup=worker`, `CollectMode=inactive`, exact unit-property digest, and exact guarded finalizer command;
3. require `SubState=stop-post`, `ControlPID` equal to its own PID, and the normalized unified entry in `/proc/self/cgroup` equal to `${ControlGroup}/.control`;
4. open the exact gate-bound `worker` subgroup through the reviewed no-symlink-traversal operation and require its device/inode identity;
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

The phase cgroup does not contain the pre-existing PM2 daemon or Nginx master. The global advisory lock does not identify, contain, or make those actors descendants. Every delegated operation therefore uses immutable operation records, and the exact target interfaces must pass the future pre-plan gate in section 26.

### 13.1 Common operation record contract

Each operation has one deterministic operation ID bound to run, manifest, boot, phase, unit, `InvocationID`, family, sequence, target identity, exact request digest, gate identity, stage deadlines, and prior marker digest.

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

The future validation artifact must select one exact installed-version RPC interface before implementation-plan writing. It must bind the exact PM2 version, Node binary, daemon/client/RPC module bytes, socket protocol, method, request bytes, `pm_id`, callback boundary, callback timing, and death behavior.

The selected connection path must be a direct open/connect to the already-validated socket. Source, byte identity, process/syscall trace, and negative cases must prove that it cannot call daemon-launch code, `pm2.connect`, fork, spawn, reconnect fallback, or any other auto-start path. Daemon absence, socket mismatch, version mismatch, permission error, malformed frame, timeout, and reconnect must all fail without auto-spawn. If this proof is unavailable, the architecture is blocked and must redesign the manager interface before planning.

The operation binds:

- exact reviewed `PM2_HOME`, added only inside the sanitized helper path;
- exact RPC socket path, device, inode, mode, and owner;
- daemon PID plus `/proc/PID/stat` start time, executable identity, UID, and version;
- the sole preflight application's exact approved identity and `pm_id` from the independently authorized validation artifact;
- the exact request bytes and same-session callback boundary.

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

Before-send death, after-send/before-callback death, callback loss, callback/target mismatch, helper death before durable `QUIESCED`, or deadline expiry leaves unmatched `BEGIN`; it never becomes quiesced by polling.

### 13.3 Exact Nginx D-Bus reload and worker-generation interface

The future validation artifact must bind exact `nginx.service`, every `ExecReload` command, Nginx binary/config identities, master identity, and exact worker-generation behavior before planning. A generation is a set of worker records containing PID, `/proc/PID/stat` start time, executable identity, UID, parent master PID/start identity, and generation observation time.

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

Job done without generation, generation without old-worker absence, concurrent or substituted reload, master drift, config drift, helper death, or any stage timeout leaves unmatched `BEGIN`. Old-worker drain is inside the `25s` stage; timeout never reclassifies a draining worker as quiesced. If the exact target cannot satisfy this contract, the architecture is blocked and must redesign the synchronous manager interface before planning.

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

Every marker is exclusively created once, then file- and parent-directory-fsynced. Markers are never rewritten, truncated, renamed over, or deleted by the run. Every record includes run ID, manifest hash, boot ID, actor unit and invocation, phase unit and invocation when applicable, schema digest, monotonic and UTC timestamps, prior/next state, and hashes of supporting evidence.

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
- Each `START_REQUEST_1` contains the canonical request description and precedes dispatch. `START_REQUEST_2` is optional, occurs at most once, and has byte-identical transient properties and command arrays.
- A D-Bus reply or job path is request evidence only and creates no authorization state.
- `EXECUTION_GATE_COMMITTED` requires request 1, the actual unit invocation, exact property/cgroup/worker identity, and absence of `START_WINDOW_CLOSED` while holding the phase gate.
- `START_WINDOW_CLOSED` requires the two completed `10s` visibility windows, no exact current unit/job, no execution gate, and a gate-held recheck. It prohibits every late pre-start from reaching main.
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

Each phase must exclusively create and file/parent-fsync exactly one immutable result record before every intentional semantic exit in `{0, 64, 70, 75}`. The record is bound to run, manifest, boot, phase, unit, `InvocationID`, controller invocation, script hash, last completed boundary, operation-record hashes, sanitized evidence hashes, result schema, and monotonic timestamps.

The exact exit map, with no `SuccessExitStatus` override, is:

- `0`: success;
- `64`: deterministic application, service, or public validation failure;
- `70`: identity, marker, property, environment, or protocol failure;
- `75`: cooperative cancellation with one exact cancellation reason.

If result creation or either fsync fails, the process must not return one of those four codes. Any normal exit without a result is an implementation/protocol failure and nonretryable, including a normal reserved exit and every normal unreserved exit. Signal, core dump, exact runtime timeout, or forced abnormal death may leave the result absent; absence gains classification meaning only after a valid terminal witness and full fence.

A present result must exactly match `ExecMainCode`, `ExecMainStatus`, the validated `SERVICE_RESULT`/`EXIT_CODE`/`EXIT_STATUS`, cancellation records, and the witness. A mismatch blocks the fence. A missing mandatory result can never be treated as semantic success even when process fencing remains provable.

### 17.2 Common loaded evidence

Every loaded row requires exact unit name and invocation, exact property digest including `CollectMode=inactive`, `NRestarts=0`, no current job after finalization, and zero main/control PIDs. Exact target-build tuples for stop, timeout, dependency, start, and finalizer paths must be frozen by the future pre-plan artifact; acceptance is byte-for-byte equality to that artifact, not a broad status list selected during implementation.

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
5. exact property digest includes `CollectMode=inactive`, `Restart=no`, `NRestarts=0`, `RemainAfterExit=no`, and the reviewed command arrays;
6. two stable D-Bus samples one second apart within the `10s` reconciliation window report both name lookup and invocation lookup absent, with no job for the name and no same-name recreation;
7. no reset-failed, collect/unload request, manager drift, boot change, invocation substitution, or other prohibited privileged action is observed;
8. delegate records and marker invariants are complete.

Under these conditions, the witness proves worker/process termination. `CollectMode=inactive` plus the successful witness tuple and stable absence supplies only the negative inference that no failed finalizer/unit state was retained. `JobRemoved` and `UnitRemoved` are not mandatory if no observer survived. Absence does not prove worker emptiness, finalizer execution, or main outcome by itself.

If the mandatory result record is absent despite exact zero/success main evidence, process fencing and the unloaded terminal class may still be established, but the phase outcome is a nonretryable protocol failure rather than success. A result mismatch blocks the fence.

All other unloaded cases fail closed automatically: reserved nonzero exit, signal/core, runtime timeout, explicit or dependency stop while live, start/resource failure, finalizer failure, `CollectMode` mismatch, missing or malformed witness, lookup disagreement, same-name recreation, boot/invocation drift, or evidence of reset/collection activity. They end in `OPERATOR_REQUIRED`; absence cannot rehabilitate them.

### 17.4 Mandatory negative matrix

The future systemd gate must include controller death with no subscriber, death after witness fsync/before finalizer exit, finalizer nonzero and signal after witness, immediate successful unload, failed-unit retention, reset-failed simulation in isolation, name recreation, lookup disagreement, pre-witness disappearance, and missing/malformed witness. Every forbidden unloaded tuple must fail closed. The document does not claim that this matrix has run.

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

Before request 1, the controller writes phase intent and exclusively creates and fsyncs `START_REQUEST_1` under the global lock after a boot check. The record contains the canonical exact transient request description. Creation uses fail-on-name-conflict behavior. Returned reply status and job ID/path are request evidence only.

The exact algorithm is:

1. Dispatch request 1 and wait the first `10s` visibility window. If the exact unit/job or `EXECUTION_GATE_COMMITTED` is observed, reconcile it; do not reissue.
2. After the first window, hold the global lock and phase gate and recheck boot, deterministic name/job/invocation, request records, cancellation/fault/terminal markers, and absence of the execution gate.
3. Only if no current exact unit/job and no execution gate exists may the controller exclusively create and fsync `START_REQUEST_2` and dispatch one reissue. The transient definition is byte-identical; request ordinal does not change any property or command array.
4. During the second `10s` visibility window, any exact unit/job/gate is reconciled. No third request exists and no alternate unit name or run ID is permitted.
5. After the second window, the controller takes the phase gate and creates `START_WINDOW_CLOSED` if and only if the execution gate remains absent and all identity/boot/fault/cancellation/terminal checks still pass.
6. A racing late pre-start either commits `EXECUTION_GATE_COMMITTED` first or sees `START_WINDOW_CLOSED` and fails before main. Both records cannot exist and request 2 cannot create a second gate.
7. If an execution gate exists but `BOUND` does not, the controller never reissues. The finalizer uses the gate's unit/cgroup/worker identity to witness emptiness, followed by path-specific reconciliation.

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

Controller shutdown has `TimeoutStopSec=60s`, exceeding the exact `45s` no-open-delegate containment/handoff budget by `15s`. If an external operation is open, containment still begins immediately; the controller records the unmatched operation and durable handoff, then exits without a false fence or terminal-success claim.

### 20.5 Host reboot

A boot mismatch is detected before unit query, adoption, stop, reissue, witness acceptance, fence, restoration, or mutation. The run writes `OPERATOR_REQUIRED` with `reason=BOOT_ID_CHANGED`. No automatic recovery or restoration follows. A separately approved recovery decision is required.

## 21. Complete deadline contract and controller algebra

### 21.1 Fixed remote values

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
| cancellation containment/reconcile with no open delegate | `45s` |
| controller `RuntimeMaxSec` | `1800s` |
| controller `TimeoutStopSec` | `60s` |
| fixed transition/evidence allowance | `120s` |

`TimeoutStopSec=10s` is counted twice on a worst terminal path: once for worker termination and once as the fresh outer stop-post slot. The finalizer's `5s` self-deadline lies inside the second `10s`; the remaining `5s` is containment/kill margin if the finalizer does not exit as designed. PM2/Nginx maxima are included inside phase internal/runtime budgets and are not added again to the controller sum.

### 21.2 Controller budget floor

The conservative reservation takes no credit for overlap between visibility and start processing:

```text
initial + reissue visibility:       3 * (10 + 10) =   60
phase start slots:                  3 * 10        =   30
phase runtimes:                     780 + 2*240   = 1260
worker-stop slots:                  3 * 10        =   30
outer finalizer slots:              3 * 10        =   30
terminal reconciliation:            3 * 10        =   30
fixed transition/evidence allowance:                 120
                                                      ----
required controller budget floor:                   1560s
controller margin:                    1800 - 1560 =  240s
```

### 21.3 Cancellation and outer envelopes

For no open external operation, the exact `45s` containment/fence maximum is `10s` worker termination + `10s` outer finalizer slot + `10s` post-witness reconciliation + `15s` gate/marker/fsync/poll/scheduling allowance.

If an external `BEGIN` is open, cancellation does not wait it into quiescence after the observer is killed. Unmatched `BEGIN` remains unmatched, `FENCE_PROVED` is unavailable, and the controller records escalation/handoff. Section 13's operation deadline governs normal operation only; it never extends proof or creates closure.

The controller's `60s` stop budget exceeds the `45s` no-open-delegate containment/handoff budget by `15s`. The bounded local phase remains `1770s` stage sum, `2100s` overall, and `330s` margin. Remote plus local outer envelopes remain `1800 + 2100 = 3900s`, excluding separately bounded pre-controller upload/staging.

Budget expiry never weakens proof. Before mutator intent it may produce `RUN_BLOCKED_PRE_MUTATION`; after intent it creates `FAULT_PENDING` and follows exact containment/fence/restoration ordering or ends in `OPERATOR_REQUIRED` when proof is unavailable.

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

After `RUN_SUCCEEDED`, the original Task 5 local candidate boundaries remain and these fixed liveness limits apply:

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

Required root-only evidence includes:

- canonical manifest, run ID, boot ID, upload inventory, and bundle byte identities;
- static guard path/hash/ELF/static-startup evidence, next-stage hashes, and generic per-role environment-contract pass/fail/count/digest only;
- controller and phase unit names, invocation IDs, dependencies, properties, all four guarded command arrays, and sanitized environment-contract digests;
- request ordinals, canonical request-set digest, returned D-Bus/job request evidence, `EXECUTION_GATE_COMMITTED` or mutually exclusive `START_WINDOW_CLOSED`, and any losing late invocation evidence;
- start/stop/reload job identities and outcomes observed by a live subscriber, without treating an unobserved post-finalizer signal as mandatory;
- phase bound records, cgroup path/ID, worker device/inode identities, terminal witnesses, and the exact loaded/unloaded reconciliation class;
- immutable phase results, mandatory-result status, and outcome classifications;
- phase-gate and global-lock acquisition/release records;
- every PM2/Nginx `BEGIN` and `QUIESCED` record, exact stage timing class, and future validation-artifact identities without raw RPC payloads;
- immutable marker timeline and contradiction checks;
- sanitized preflight, maintenance, PM2, listener, Nginx, audit, snapshot, restoration, and public cache-field evidence;
- exact invalid-partial pre/post-quarantine identity;
- final local transfer/candidate evidence if the run reaches that boundary;
- journal references filtered by exact `_SYSTEMD_INVOCATION_ID`.

No run automatically deletes its bundle, markers, evidence, units, quarantine, failed work, staging, local partials, or retained backups. Cleanup is separately reviewed and authorized.

Governed scripts never use `set -x` and never print command environments, PM2 environments, opaque configuration, cookies, authorization headers, tokens, passwords, private keys, response bodies, or secret-bearing values. Public probes emit only approved status/cache fields. Command outputs are reduced to exact non-secret fields before durable storage.

Terminal run markers mean:

- `RUN_SUCCEEDED`: mutator succeeded, restoration verified, and all final gates passed;
- `RUN_BLOCKED_PRE_MUTATION`: a read-only gate failed before mutator intent;
- `RUN_FAILED_NO_MUTATION`: either a valid phase-gate-linearized `START_WINDOW_CLOSED` with no execution gate/activity, or a gate-committed mutator with a valid full fence and no `ENTERED`, delegated `BEGIN`, production record, or contradictory evidence;
- `RUN_FAILED_RESTORED`: mutator or safety path failed, but a full mutator fence and verified restoration were obtained;
- `OPERATOR_REQUIRED`: process/delegate fencing unavailable, restoration nonretryably unavailable/failed, attempt 2 failed, boot changed, or trusted evidence was violated.

No terminal result authorizes cleanup, a new production run, publication, or a later release task.

## 26. Tests and future pre-plan architecture-validation gate

### 26.1 One combined exact-target gate before planning

Before implementation-plan writing, one combined architecture-validation gate must run with separately authorized access to exact target artifacts or exact approved copies in a nonproduction/exact-target-safe environment. This specification does not authorize acquiring artifacts from production, production access, or production mutation. The gate is future work and has not run.

No implementation plan may be written until the gate freezes and fresh independent security and architecture reviewers approve all of these artifact families:

- exact distribution systemd-255/PID-1/cgroup-v2 behavior;
- exact static first-exec guard bytes/build evidence and per-role raw-environment behavior;
- exact installed PM2 version, Node binary, daemon/client/RPC modules, socket protocol, selected existing-daemon-only method, and relevant byte hashes;
- exact `nginx.service`, every `ExecReload` command, Nginx binary/config identities, and worker-generation/drain behavior.

The systemd request/gate matrix must demonstrate:

- request 1, one byte-identical request 2, lost replies, both delivery orders, same-name conflicts, controller death before pre-start, and no third request;
- `ExecStartPre` in `.control`, creation/binding of the exact `worker` inode, continuity into phase `ExecStart` placement in `worker`, and `ExecStopPost` in `.control`;
- the race between `EXECUTION_GATE_COMMITTED` and `START_WINDOW_CLOSED`, proving mutual exclusivity and that a losing late pre-start never reaches main;
- a gate-committed pre-`BOUND` main failure obtaining a valid worker witness and reconciliation;
- finalizer witness behavior for success, `64`, `70`, `75`, signal, core, runtime timeout, explicit stop, controller-dependency stop, start/resource failure, finalizer failure, and SIGTERM-ignoring descendants;
- pinned/read-back `CollectMode=inactive`, exact loaded tuples, successful immediate unload with no subscriber, and every forbidden unloaded case from section 17.4;
- controller death after witness fsync/before finalizer exit, after finalizer exit/before read-back, same-name recreation, lookup disagreement, failed-unit retention, reset-failed simulation in isolation, and pre-witness disappearance.

The environment/provenance matrix must demonstrate:

- the guard's exact ELF/static/startup contract and next-stage hash verification;
- exact raw manager-generated environment for controller, pre-start, phase main, and finalizer roles;
- generic pass/fail evidence without raw names or values;
- rejection or harmlessness before next-stage execution under `LD_PRELOAD`, `LD_AUDIT`, `GLIBC_TUNABLES`, shell-function exports, `BASH_ENV`, `ENV`, `NODE_OPTIONS`, Node/npm variables, and ambient PM2 variables;
- exact finalizer handling of validated `SERVICE_RESULT`, `EXIT_CODE`, and `EXIT_STATUS`.

The PM2 matrix must name and freeze the exact method, request bytes, `pm_id`, callback envelope/timing, socket/daemon identities, and no-late-effect meaning. Source, byte identity, syscall/process traces, and negative cases must prove direct existing-daemon-only connection, no daemon launch/fork/spawn/fallback on every error, no materialized or decoded `pm2_env`, bounded streaming selection of approved non-secret acknowledgement fields, and the exact `5s + 15s + 15s + 5s = 40s` stage behavior. It must cover before-send death, after-send/before-callback death, callback loss, malformed response, permission/version/socket drift, target mismatch, helper death before durable `QUIESCED`, and deadline expiry.

The Nginx matrix must freeze exact unit/binary/config/job identities and generation record bytes. It must prove exact job-to-generation binding, a nonempty disjoint new generation after the validated config-read interval, every old worker absent before generic `QUIESCED`, concurrency/substitution rejection, and the exact `5s + 15s + 10s + 25s + 5s = 60s` stage behavior. It must cover job done without generation, generation without old-worker absence, master/config drift, helper death, timeout, and maintenance/open directions.

Artifacts must include exact transient definitions, canonical property/command/dependency read-back, request and gate records, cgroup/inode identities, guard inspection/build evidence, sanitized environment outcomes, witness bytes/hashes, loaded/unloaded tuples, PM2 source/trace/protocol evidence, Nginx generation/job evidence, stage timing, and negative-case results. Raw environment, `pm2_env`, opaque ecosystem content, credentials, and secret-bearing values remain prohibited.

If exact artifacts cannot be obtained under separate authority, a target tuple falls outside the closed matrices, the worker-inode continuity cannot be proved, the guard contract fails, PM2 cannot avoid auto-spawn or `pm2_env`, or Nginx cannot prove old-worker absence, the gate fails. Architecture redesign and fresh review precede planning; the rule is never weakened to fit the target.

### 26.2 Later full integration suite

After a separately approved implementation exists, the later suite must additionally cover:

- exact transient names, properties, dependencies, all guarded command arrays, environment, hashes, and no `--wait`/`--pipe`/`--collect`;
- same-name/invocation substitution, duplicate execution-gate attempts, start-window closure, and worker-inode recreation races;
- mandatory result-before-intentional-`0/64/70/75`, result-fsync failure avoiding reserved exits, every result/main cross-product, every closed retry class, and impossibility of a third attempt;
- controller death before, during, and after execution gate, entry, delegate operations, finalizer witness, and unload;
- `BindsTo=` phase stop on exact controller loss and stop/reconcile-only behavior after controller recreation;
- cancellation before gate, `BOUND`, `ENTERED`, and every mutation/delegated-operation boundary;
- a gate held by a hung operation, immediate containment, finalizer witness, later cancel fence, and unresolved-delegate escalation without synthesized closure;
- all PM2/Nginx death, drift, timeout, concurrency, old-worker, no-auto-spawn, and opacity cases frozen by the pre-plan gate;
- reboot after reservation and at every request/gate/bound/entered/result/witness/fence phase;
- boot mismatch suppressing query, reissue, adoption/stop, witness acceptance, restoration, and mutation;
- late invalid-partial drift and quarantine collision safety closure;
- local SCP, checksum, extraction, worktree, hydration, `npm ci`, audit, and bundle hangs with retained evidence;
- output scans proving no secrets, raw environment, opaque ecosystem content, broad deletion, PID-only kill, wildcard action, or unreviewed executable path.

Any failed case blocks implementation review. The implementation and test bytes require fresh independent security and architecture review before any production authorization.

## 27. Migration, review, rollout, and completion boundaries

The blocked round-5 scripts and their prior local suite remain historical evidence only. They are not production inputs and are not wrapped by this architecture.

The allowed sequence is:

1. corrected tracked design revision;
2. fresh independent security and architecture design approval plus user re-review;
3. successful future combined exact-target systemd request/gate/unload, static-guard/environment, PM2, and Nginx architecture-validation gate plus independent review of its artifacts;
4. local implementation-plan writing;
5. local implementation and static tests without production access;
6. full isolated systemd-255/cgroup-v2 integration suite;
7. exact manifest/run identity generation and independent review;
8. separate explicit production authorization;
9. governed root-only upload and transient execution;
10. independent post-run security and Task 5 review before continuing the release.

No implementation planning or production work may begin from this specification alone. No permanent daemon, static/enabled unit, timer, socket, path unit, package, Nginx config change, PM2 config change, or boot recovery mechanism is introduced.

A future Task 5 implementation is ready for production review only when all required tests pass, exact artifact identities are independently approved, current production preflight still matches, and the user separately authorizes production execution. This specification and its commit do not authorize implementation, production access, or release continuation.

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

PM2 behavior must be reviewed against the exact installed-version Node binary and pinned daemon/client/RPC source and bytes, selected socket method/request/callback protocol, process/syscall traces, no-auto-spawn negatives, and opaque-response evidence. Generic high-level APIs, CLI polling, or any surface that materializes `pm2_env` are not authoritative.

Nginx behavior must be reviewed against the exact installed binary/config identities, `nginx.service` and every `ExecReload` definition, Nginx reload/generation/drain semantics, process identities, and exact systemd v255 D-Bus job behavior. A completed reload job or a new generation without complete old-worker absence is not generic `QUIESCED`.
