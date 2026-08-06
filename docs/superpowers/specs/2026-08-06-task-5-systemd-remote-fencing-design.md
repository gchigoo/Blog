# Task 5 systemd remote-fencing design

Date: 2026-08-06

Prior architecture-direction approval date: 2026-08-06

Status: corrected exact revision pending independent security and architecture approval and user re-review; implementation planning and production work remain prohibited

Review isolation: independent-required; this documentation execution provides self-review only and is not an independent approval

## 1. Context, current state, and authority

Task 5 of the English article release must capture a consistent production source snapshot, restore the old public service, transfer the verified snapshot, and create an isolated detached candidate. The original release design and Task 5 plan remain authoritative for content, snapshot, candidate, restoration, taxonomy, opaque-configuration, secret-handling, and release boundaries. This specification changes only the remote execution ownership and fencing architecture.

The prior systemd architecture direction was user-approved on 2026-08-06. Independent security and architecture review rejected exact commit `7b1feccac5af2e9c8a3d206fab4285dd7db1de44` because its post-terminal cgroup-path proof, delegated-operation ownership, boot identity, cancellation, environment, state, retry, and deadline contracts were incomplete or invalid. This corrected exact revision requires fresh independent security and architecture approval and user re-review before implementation-plan writing.

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
5. Every phase uses `Type=exec`, `ExitType=cgroup`, `RemainAfterExit=no`, `Restart=no`, `Delegate=yes`, `DelegateSubgroup=worker`, and an exact common `ExecStopPost` finalizer.
6. The phase main process and all descendants execute in `${ControlGroup}/worker`; systemd control processes, including the finalizer, execute in `${ControlGroup}/.control`.
7. While alive in `.control`, the finalizer proves the exact bound `worker` subgroup recursively empty and durably records that observation before the unit root can be pruned.
8. Every PM2 or Nginx operation delegated outside the phase cgroup has immutable `BEGIN` and exact matching `QUIESCED` records. An unmatched `BEGIN` prevents a full fence.
9. A root-only per-phase gate linearizes binding, entry, cancellation, every production mutation, and every delegated dispatch through durable completion.
10. The controller retains the global run lock across the complete normal mutator/restoration interval and never releases it between phases.
11. Boot identity is durable and mandatory. A run never crosses a boot.
12. Client and transport results are request evidence only. They never prove phase completion, external-operation completion, fencing, restoration, or run success.

The design distinguishes two safety states:

- `PROCESS_TERMINAL_WITNESSED`: the finalizer has proved that the phase's mutation-capable main process and all descendants are absent from the exact bound `worker` subgroup and has durably recorded the proof.
- `FENCE_PROVED`: `PROCESS_TERMINAL_WITNESSED` plus exact unit/result reconciliation, unchanged boot identity, valid marker invariants, cancellation linearization when applicable, and closure of every externally delegated PM2/Nginx operation.

A missing unit or cgroup pathname after a valid durable witness is a neutral post-witness condition, not proof. A unit or subgroup that disappears before the witness makes automatic fencing unavailable.

## 3. Goals

The design must:

- prevent mutator/restoration overlap after timeout, disconnect, lost acknowledgement, client death, controller death, delayed launch, or cancellation;
- bind every run, controller, phase, process group, result, external operation, and transition to exact identities;
- obtain recursive process-terminal evidence before systemd can prune an empty phase cgroup;
- prevent a late PM2 or Nginx action from taking effect after a claimed fence;
- keep root-only durable state that a same-run controller can reconcile without rerunning a phase;
- serialize cooperating Task 5 control through one controller-owned global `flock` interval plus immutable state and per-phase gates;
- preserve the exact current invalid partial before any fresh snapshot publication;
- restore and verify the old public service after every accepted and fully fenced mutator attempt;
- fail closed when process, delegate, identity, boot, evidence, or restoration proof is unavailable;
- preserve all original Task 5 transfer, detached-candidate, taxonomy, opaque-config, evidence, and release boundaries;
- require a minimal real systemd-255/PID-1/cgroup-v2 architecture exercise before implementation-plan writing and a later full integration suite before production review.

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
- the exact reviewed root-owned launchers, scripts, finalizer, system tools, Nginx binary/unit, PM2 daemon/client/RPC implementation, Node.js runtime, and validation tools;
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
- transient services, `Type=exec`, `ExitType=cgroup`, `InvocationID`, `ControlGroupId`, `Delegate=`, `DelegateSubgroup=`, `BindsTo=`, `After=`, `ExecStopPost=`, and the required D-Bus job/property APIs;
- a root-owned reviewed filesystem location with atomic exclusive create, atomic no-replace rename, and file/directory fsync behavior;
- the previously reviewed maintenance no-store prerequisite, exact inactive site, retained maintenance backups, expected production Git boundary, loopback listener, passing audit, empty operation registry, and sufficient disk;
- the exact current invalid-partial identity in section 22;
- an existing PM2 daemon protocol that can issue identity-bound RPC without auto-spawning a daemon;
- an Nginx systemd reload path that exposes exact D-Bus job completion and an observable applied worker generation.

The load-bearing semantics are:

- `Type=exec` reports process setup and executable failures rather than treating a pre-`execve` fork as successful start.
- `ExitType=cgroup` keeps a phase running while any process remains in its service cgroup.
- `DelegateSubgroup=worker` places the main service process and descendants in the delegated `worker` subgroup while systemd control processes run in `.control`.
- `KillMode=control-group` with the fixed signal policy contains all phase-owned processes.
- `Restart=no` prevents manager-driven re-entry.
- `RemainAfterExit=no` permits successful units to become inactive and transient units/cgroups to be pruned after finalization; the design does not rely on terminal retention.
- cgroup v2 `cgroup.events` reports recursive `populated 0` for an existing cgroup and all descendants.
- systemd v255 may prune an empty service cgroup while transitioning to successful, failed, or inactive state. `RemainAfterExit=yes` and omission of `--collect` do not retain the pathname.

These semantics require the future real-systemd exercise in section 26. They are not asserted as completed implementation evidence by this document.

## 7. Deterministic manifest, run identity, and symbolic notation

Each independently reviewed implementation bundle has one canonical `review.manifest`:

- UTF-8, LF-only, sorted key/value records;
- no comments, timestamps, random values, credentials, host-fetched secret data, or opaque configuration content;
- exact hashes, sizes, modes, owners, and absolute paths for the controller, launcher, mutator, restoration, finalizer, reconciliation, upload verifier, PM2 RPC helper, Nginx control helper, and every production tool;
- exact feature HEAD `1ee3fbc3ebc43f552d3f592bf41d79751ca6a731`;
- expected production HEAD `860bfe53e54dff4ab78bbfa2f7e5f644a032b9aa`;
- exact systemd properties, dependency arrays, command arrays, environment contract, marker/result schemas, operation families, and deadlines from this specification;
- exact canonical paths, exact installed PM2 version and required byte identities, exact `nginx.service` definition identity, and the invalid-partial identity from section 22;
- exact reviewed maintenance snippet/site/backup identities inherited from the blocked Task 5 controls.

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
- phase intent, start-request, bound, entered, result, terminal witness, fence, and outcome/classification record;
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
- exact launcher, phase script, and finalizer hashes.

A same-name unit with a different invocation is a conflict. A new same-run controller invocation is a reconciliation actor, not a continuation of the prior invocation and never authorizes a phase rerun.

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

## 10. Exact environment and command provenance

Every transient creation path uses either `systemd-run --expand-environment=no` or exact D-Bus command arrays with no client, manager, or shell interpolation. `--wait`, `--pipe`, and `--collect` remain forbidden.

The manifest and unit read-back bind exact absolute `ExecStart` and `ExecStopPost` command arrays. The phase command enters through the exact reviewed launcher at:

`/var/lib/blog/task-5-systemd-fencing/runs/${RUN_ID}/bundle/bin/task5-phase-launcher`

The controller launcher and common finalizer are:

- `/var/lib/blog/task-5-systemd-fencing/runs/${RUN_ID}/bundle/bin/task5-controller-launcher`
- `/var/lib/blog/task-5-systemd-fencing/runs/${RUN_ID}/bundle/bin/task5-phase-finalizer`

Before unit creation, the manifest resolves these exact NUL-free argument vectors to concrete values and absolute paths:

- controller `ExecStart`: controller launcher, `--run-id`, `${RUN_ID}`, `--manifest-hash`, `${MANIFEST_HASH}`, `--boot-id`, `${BOOT_ID}`, `--unit`, `${CONTROLLER_UNIT}`, `--script`, `${CONTROLLER_SCRIPT_ABSOLUTE}`;
- phase `ExecStart`: phase launcher, `--run-id`, `${RUN_ID}`, `--manifest-hash`, `${MANIFEST_HASH}`, `--boot-id`, `${BOOT_ID}`, `--phase`, `${PHASE}`, `--unit`, `${PHASE_UNIT}`, `--controller-unit`, `${CONTROLLER_UNIT}`, `--controller-invocation`, `${CONTROLLER_INVOCATION_ID}`, `--script`, `${PHASE_SCRIPT_ABSOLUTE}`;
- phase `ExecStopPost`: common finalizer, `--run-id`, `${RUN_ID}`, `--manifest-hash`, `${MANIFEST_HASH}`, `--boot-id`, `${BOOT_ID}`, `--phase`, `${PHASE}`, `--unit`, `${PHASE_UNIT}`, `--controller-unit`, `${CONTROLLER_UNIT}`, `--controller-invocation`, `${CONTROLLER_INVOCATION_ID}`, `--bound-record`, `${BOUND_RECORD_ABSOLUTE}`, `--result-record`, `${RESULT_RECORD_ABSOLUTE}`, `--witness-record`, `${WITNESS_RECORD_ABSOLUTE}`.

The arrays contain no shell metacharacter processing, empty argument, relative path, or runtime interpolation. Their concrete byte sequences and digests are read back and compared with the manifest. Controller and phase services are created asynchronously; every creation return is request evidence only and never completion evidence.

The launcher validates the systemd invocation identity it must preserve, then immediately executes `/usr/bin/env -i` and passes only this exact clean environment:

- `PATH=/usr/sbin:/usr/bin:/sbin:/bin`
- `LANG=C`
- `LC_ALL=C`
- `TZ=UTC`
- `HOME=/root`
- `USER=root`
- `LOGNAME=root`
- `SHELL=/bin/bash`
- the exact reviewed `PM2_HOME` only in the PM2 helper path that requires it;
- the validated systemd invocation identity required by the script.

The reviewed launcher invokes `/bin/bash -p --noprofile --norc` with the exact absolute script path and fixed argument array. Every production tool is invoked by an absolute, root-owned, hash-pinned path.

The contract prohibits:

- `EnvironmentFile` and nonempty `EnvironmentFiles`;
- `PassEnvironment`;
- PAM environment sources or login-environment synthesis;
- client environment pass-through;
- nonempty `ExecSearchPath`;
- loader variables, shell startup variables, exported shell functions, `BASH_ENV`, `ENV`, `CDPATH`, `GLOBIGNORE`, or shell option injection;
- `NODE_OPTIONS`, `NODE_PATH`, npm configuration variables, and ambient PM2 variables;
- command substitution or variable expansion by `systemd-run`;
- secret-bearing values in unit properties, command lines, markers, evidence, or logs.

Required unit read-back includes `SetLoginEnvironment=no`, empty `EnvironmentFiles`, empty `PassEnvironment`, empty `ExecSearchPath`, exact `Environment` and `UnsetEnvironment` arrays, exact command arrays, and exact launcher/script/finalizer hashes. Runtime evidence never prints environment values or secret-bearing data.

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
| `Delegate` | `yes` |
| `DelegateSubgroup` | `worker` |
| `TimeoutStopSec` | `10s` |
| `User` / `Group` | `root` / `root` |
| `UMask` | `0077` |
| `WorkingDirectory` | `/` |
| `StandardInput` | `null` |
| `StandardOutput` / `StandardError` | `journal` / `journal` |
| `SetLoginEnvironment` | `no` |
| `BindsTo` | exact deterministic controller unit |
| `After` | contains the exact controller unit; complete read-back equals the reviewed dependency array |
| `ExecStopPost` | exact common finalizer command array |

Phase runtimes are:

| Unit | Internal work budget | `RuntimeMaxSec` | Protocol margin |
|---|---:|---:|---:|
| mutator | `60s + 600s` | `720s` | `60s` |
| restoration attempt 1 | `180s` | `240s` | `60s` |
| restoration attempt 2 | `180s` | `240s` | `60s` |

The phase main process and every descendant execute in `${ControlGroup}/worker`. Systemd control processes, including `ExecStopPost`, execute in `${ControlGroup}/.control`. No phase process may migrate out of `worker`, create an alternate delegated subgroup, or move an unrelated process into the unit.

### 11.3 Exact dependency and property read-back

Before accepting a phase start, the controller reads through systemd D-Bus and requires:

- exact unit ID, canonical name, `Transient=yes`, and exact transient fragment identity;
- exact nonempty phase `InvocationID` and current authoritative boot ID;
- exact `BindsTo=` containing only the deterministic controller unit and the complete reviewed `After=` array containing that unit plus only the pinned manager-added dependencies;
- the controller unit loaded with the expected controller `InvocationID` and no terminal/cancellation state that forbids continuation;
- every property in sections 10 and 11, exact `ExecStart` and `ExecStopPost` arrays, exact runtime/stop deadlines, and `NRestarts=0`;
- exact `ControlGroup`, nonzero `ControlGroupId`, and no unexpected job or dependency;
- exact unit-property digest equal to the manifest and phase binding.

The phase launcher repeats these checks before `BOUND`, before `ENTERED`, and under its gate before every mutation boundary. A controller invocation mismatch stops productive work and creates `FAULT_PENDING`; the phase may then participate only in safe cancellation and reconciliation.

`BindsTo=` plus `After=` must cause PID 1 to stop a live phase when the bound controller unit becomes inactive. A new controller invocation never cancels that stop or treats the old phase as normally continuable. Tests must verify controller death before phase entry, during every phase stage, and during finalization, including same-name controller recreation.

## 12. Phase bound record and finalizer terminal witness

### 12.1 Phase bound record

The immutable phase bound record binds at least:

- run ID and manifest hash;
- authoritative boot ID;
- exact phase/attempt and unit name;
- exact phase `InvocationID`;
- exact controller unit and controller `InvocationID`;
- exact `ControlGroup` and nonzero `ControlGroupId`;
- `worker` subgroup device and inode identity obtained without symlink traversal;
- exact unit-property digest;
- launcher, phase script, and finalizer hashes;
- exact expected phase-result path and schema digest;
- exact terminal-witness path and schema digest;
- gate identity and current marker-state digest.

The launcher creates `BOUND` under the phase gate after validating the unit, boot, controller, cgroup topology, worker identity, and cancellation state. It creates `ENTERED` under the same gate only after a second complete recheck. A failure before a valid bound record cannot produce an automatic full fence.

### 12.2 Finalizer witness procedure

The exact common `ExecStopPost` finalizer has a `5s` internal deadline. Within that deadline it must:

1. verify fixed run, phase, unit, controller, result-path, witness-path, and schema arguments and compare the current boot ID;
2. query the exact unit and require the bound `InvocationID`, `ControlGroup`, nonzero `ControlGroupId`, `Delegate=yes`, `DelegateSubgroup=worker`, exact unit-property digest, and exact finalizer command;
3. require `SubState=stop-post`, `ControlPID` equal to its own PID, and the normalized unified entry in `/proc/self/cgroup` equal to `${ControlGroup}/.control`;
4. open the exact validated `worker` subgroup through a reviewed no-symlink-traversal path operation and require the bound device/inode identity;
5. read `worker/cgroup.events`, require exactly one `populated` field with value `0`, and require `worker/cgroup.procs` empty;
6. revalidate the worker subgroup device/inode identity after both reads;
7. capture `Result`, `ExecMainPID`, `ExecMainCode`, `ExecMainStatus`, `ExecMainStartTimestampMonotonic`, `ExecMainExitTimestampMonotonic`, `ActiveState`, `SubState`, `MainPID`, `ControlPID`, `ControlGroup`, `ControlGroupId`, `NRestarts`, and the phase-owned immutable result record when present;
8. capture the exact start/stop job ID, path, type, state, and `JobRemoved` result evidence available for the invocation;
9. enumerate every phase-owned external-operation `BEGIN`, validate any exact matching `QUIESCED`, and record unmatched operations without claiming they are closed;
10. exclusively create the immutable terminal witness, fsync the file, and fsync its parent directory;
11. perform no production mutation, delegated operation, marker authorization, or evidence rewrite after the durable witness, then exit.

A valid witness establishes `PROCESS_TERMINAL_WITNESSED` only. It does not by itself establish `FENCE_PROVED`.

A missing or malformed witness, wrong finalizer PID/cgroup, changed boot, unit/invocation/property mismatch, nonzero `populated`, nonempty `cgroup.procs`, subgroup recreation, device/inode drift, symlink traversal, contradictory phase result, or witness-create collision blocks automatic fencing.

### 12.3 Post-witness controller reconciliation

The controller validates the witness while holding the global run lock and after comparing boot identity and marker invariants.

If the unit remains loaded, it must have:

- the same unit name and `InvocationID`;
- the exact property digest and no current job;
- `MainPID=0` and `ControlPID=0` after finalizer completion;
- `NRestarts=0`;
- an allowed terminal result consistent with the phase result, witness, cancellation, and job evidence.

If the unit is unloaded, exact lookup by name and lookup by the bound invocation must both report absence. The durable witness remains the process-terminal evidence. Later pathname or unit absence is neutral and never upgrades an invalid or missing witness.

Same-name recreation with another invocation, worker subgroup recreation or inode drift, malformed or missing witness, result contradiction, or an unexplained loaded/invocation lookup prevents `FENCE_PROVED`.

## 13. External PM2 and Nginx operation ownership

The phase cgroup does not contain the pre-existing PM2 daemon or Nginx master. The global advisory lock does not identify, contain, or make those actors descendants. Every delegated operation therefore uses immutable operation records.

### 13.1 Common operation record contract

Each operation has one deterministic operation ID bound to run, boot, phase, unit, `InvocationID`, family, sequence, target identity, exact command/request digest, gate identity, and prior marker digest.

While holding the phase gate, the phase:

1. exclusively creates and fsyncs `BEGIN` before dispatch;
2. retains the gate through dispatch, manager acknowledgement, identity-bound completion checks, stable samples, exclusive `QUIESCED` creation, and parent-directory fsync;
3. releases the gate only after durable `QUIESCED` or phase containment interrupts the operation.

An idempotent no-op still receives `BEGIN` and `QUIESCED` with `operation_mode=noop-verified`.

Required operation families are:

Mutator:

- maintenance/Nginx reload `BEGIN` and `QUIESCED`;
- PM2 stop `BEGIN` and `QUIESCED`.

Each restoration attempt:

- PM2 start/restart `BEGIN` and `QUIESCED`;
- maintenance-open/Nginx reload `BEGIN` and `QUIESCED`.

A `BEGIN` without its exact matching valid `QUIESCED` permanently blocks that phase's `FENCE_PROVED` and automatic restoration. Polling a desired state does not reconstruct a lost delegate acknowledgement.

### 13.2 PM2 existing-daemon RPC contract

The implementation must use a reviewed existing-daemon RPC helper. A high-level client path that may auto-spawn a daemon is forbidden.

The manifest pins the exact installed PM2 version and relevant helper, client, RPC, and daemon bytes or identities. The helper binds:

- exact reviewed `PM2_HOME`;
- exact RPC socket path, device, inode, mode, and owner;
- daemon PID plus `/proc/PID/stat` start time, executable identity, UID, and version;
- the sole preflight `blog` entry's exact `pm_id`;
- the exact command and callback received in the same helper session.

Stop targets that exact `pm_id`. Restoration uses daemon-retained configuration for the same entry and never reads, prints, copies, hashes for output, or serializes `ecosystem.config.js` or `pm2_env`.

`QUIESCED` is allowed only after the RPC callback and two filtered stable samples one second apart:

- stopped: exactly one `blog`, the same `pm_id`, status `stopped`, PID zero, and no loopback listener;
- restored: exactly one `blog`, the same `pm_id`, status `online`, a stable positive PID/start time, and exactly one `127.0.0.1:3000` listener.

The daemon and socket identity must remain unchanged. If the helper or phase dies after dispatch but before durable `QUIESCED`, automatic fencing and restoration are forbidden.

If the exact installed PM2 version cannot support this existing-daemon completion protocol without auto-spawn, the architecture is blocked and must be redesigned rather than weakened to polling.

### 13.3 Nginx D-Bus reload contract

The manifest and preflight bind:

- exact `nginx.service` unit identity and property digest;
- master PID and `/proc/PID/stat` start time;
- pre-reload worker generation;
- targeted maintenance/open config identities without exposing secret-bearing content;
- exact `ExecReload` definition and binary identities.

The helper issues exact D-Bus `ReloadUnit("nginx.service", "fail")`, retaining the returned job ID/path and matching `JobRemoved` result. `QUIESCED` requires:

- `JobRemoved` result `done` for that exact job;
- `nginx.service` active/running;
- unchanged master PID/start-time identity;
- `ControlPID=0`;
- `ReloadResult=success`;
- a clean `ExecReload` runtime record created after `BEGIN`;
- a new worker generation observed after dispatch;
- old workers absent or identity-bound as gracefully shutting down;
- exact expected maintenance/open config identity;
- expected loopback and public probe state using only approved sanitized fields;
- two stable filtered samples one second apart.

Concurrent, substituted, or ambiguous reload jobs block `QUIESCED` and the phase fence.

If the existing Nginx unit/master cannot produce an identity-bound job plus an observable applied generation, the architecture is blocked pending a separately approved synchronous Nginx control change.

## 14. Global run lock and per-phase gates

### 14.1 Controller-owned global lock

The controller acquires an exclusive `flock` on:

`/var/lib/blog/task-5-systemd-fencing/global.lock`

It holds the lock from run reservation through the complete normal remote mutator/restoration interval and terminal run-marker creation. It never releases the lock between mutator and restoration phases.

The lock is advisory serialization for cooperating governed actors. It does not identify or contain PM2, Nginx, or an uncoordinated privileged actor. Durable nonterminal markers reserve the run independently of lock ownership.

If the controller dies, the lock is released. PID 1 stops any bound live phase. Another run remains forbidden by durable state. A new same-run controller invocation may acquire the lock only for reconciliation. While any old phase is nonterminal, the new controller is stop/reconcile-only and never reruns a phase.

Unexplained lock ownership creates `FAULT_PENDING`. Lock acquisition alone is never process-terminal, delegate-terminal, or fence evidence.

### 14.2 Linearized phase gates

Each phase has one root-only gate file:

- `runs/${RUN_ID}/gates/mutator.lock`
- `runs/${RUN_ID}/gates/restore-1.lock`
- `runs/${RUN_ID}/gates/restore-2.lock`

For binding, entry, every production mutation, and every PM2/Nginx dispatch, the phase:

1. acquires its gate exclusively;
2. while holding it, rechecks boot ID, run/unit/controller identity, cancellation intent/fence, `FAULT_PENDING`, phase fence, all later-phase markers, and terminal run markers;
3. holds the gate through the mutation or delegated operation and durable completion/quiescence record;
4. releases the gate before the next separately authorized boundary.

No check followed by an unlocked mutation is permitted.

## 15. Cancellation and containment

Each phase has two immutable cancellation records:

- `*_CANCEL_INTENT`: a monotonic, non-authorizing request that immediately forbids productive continuation;
- `*_CANCEL_FENCE`: a linearization record proving no further phase binding, entry, mutation, or delegated dispatch is possible.

Controller cancellation rules are:

1. write and fsync `CANCEL_INTENT` first;
2. a delayed launch checks it before `BOUND`, before `ENTERED`, and under the gate before every boundary;
3. if the controller acquires the gate while the phase is live and no delegated operation is open, it may write and fsync `CANCEL_FENCE` before requesting exact-unit stop;
4. if the gate is held by a hung operation, the controller may request exact-unit containment stop after `CANCEL_INTENT`; after a valid terminal witness it acquires the gate and writes `CANCEL_FENCE`;
5. an unmatched external-operation `BEGIN` still blocks `FENCE_PROVED` even if process cancellation and `CANCEL_FENCE` succeed;
6. a controller seeing either cancellation record adopts the unit only for stop/reconciliation, never normal continuation.

Cancellation targets only the exact deterministic unit and expected invocation. No PID-only kill, process-name search, wildcard, slice-wide action, or guessed cgroup is permitted.

The cancellation/containment-through-witness/fence budget is `45s` after cancellation linearization or exact containment start. It accounts for the `10s` worker stop path, separately bounded `5s` finalizer, terminal query, gate/lock/marker/fsync operations, polling, and scheduling margin. If an external operation still holds the gate, that operation's own stage deadline governs. Controller shutdown writes a durable handoff record and does not claim work it cannot finish.

## 16. Marker schema and one-way invariants

Every marker is exclusively created once, then file- and parent-directory-fsynced. Markers are never rewritten, truncated, renamed over, or deleted by the run. Every record includes run ID, manifest hash, boot ID, actor unit and invocation, phase unit and invocation when applicable, schema digest, monotonic and UTC timestamps, prior/next state, and hashes of supporting evidence.

Required records are:

Run and fault:

1. `000-RUN_STAGED`
2. `010-RUN_RESERVED`
3. `095-FAULT_PENDING` when the first nonterminal fault is detected

Mutator:

4. `100-MUTATOR_INTENT`
5. `105-MUTATOR_START_REQUEST`
6. `110-MUTATOR_BOUND`
7. `120-MUTATOR_ENTERED`
8. `125-MUTATOR_CANCEL_INTENT` when requested
9. `126-MUTATOR_CANCEL_FENCE` when linearized
10. `130-MUTATOR_PROCESS_TERMINAL_WITNESSED`
11. `140-MUTATOR_FENCE_PROVED`
12. `145-MUTATOR_OUTCOME`

Restoration attempt 1:

13. `200-RESTORE_1_INTENT`
14. `205-RESTORE_1_START_REQUEST`
15. `210-RESTORE_1_BOUND`
16. `220-RESTORE_1_ENTERED`
17. `225-RESTORE_1_CANCEL_INTENT` when requested
18. `226-RESTORE_1_CANCEL_FENCE` when linearized
19. `230-RESTORE_1_PROCESS_TERMINAL_WITNESSED`
20. `240-RESTORE_1_FENCE_PROVED`
21. `245-RESTORE_1_OUTCOME`
22. `250-RESTORATION_VERIFIED` when attempt 1 succeeds

Restoration attempt 2:

23. `300-RESTORE_2_INTENT`
24. `305-RESTORE_2_START_REQUEST`
25. `310-RESTORE_2_BOUND`
26. `320-RESTORE_2_ENTERED`
27. `325-RESTORE_2_CANCEL_INTENT` when requested
28. `326-RESTORE_2_CANCEL_FENCE` when linearized
29. `330-RESTORE_2_PROCESS_TERMINAL_WITNESSED`
30. `340-RESTORE_2_FENCE_PROVED`
31. `345-RESTORE_2_OUTCOME`
32. `350-RESTORATION_VERIFIED` when attempt 2 succeeds

Mutually exclusive terminal run markers:

33. `900-RUN_SUCCEEDED`
34. `910-RUN_BLOCKED_PRE_MUTATION`
35. `920-RUN_FAILED_NO_MUTATION`
36. `930-RUN_FAILED_RESTORED`
37. `990-OPERATOR_REQUIRED`

Load-bearing invariants include:

- `RUN_RESERVED` fixes the boot identity for the run.
- `BOUND` requires intent, accepted exact unit identity, and no cancellation/fault/later/terminal prohibition.
- `ENTERED` requires `BOUND` and a second gate-held identity/state check.
- `CANCEL_INTENT`, `CANCEL_FENCE`, and `FAULT_PENDING` are nonterminal and prohibit productive forward progress while allowing exact containment, witness/fence construction, and an already-required restoration path.
- `PROCESS_TERMINAL_WITNESSED` requires a valid finalizer witness for the exact phase invocation.
- `FENCE_PROVED` requires process witness, exact terminal reconciliation, gate/cancellation invariants, and closure of all external operations.
- No restoration intent may exist without `MUTATOR_FENCE_PROVED`.
- Attempt 2 requires `RESTORE_1_FENCE_PROVED`, a valid immutable attempt-1 classification, and no attempt-1 verification.
- `RUN_SUCCEEDED` requires successful mutator outcome, exactly one `RESTORATION_VERIFIED`, and all final remote gates.
- `RUN_FAILED_RESTORED` requires a non-success mutator/fault outcome plus verified restoration.
- Terminal run markers are mutually exclusive. Contradictory order, identity mismatch, duplicate exclusive-create collision, or impossible state is evidence corruption and blocks further automation.

## 17. Immutable phase results and systemd result reconciliation

Each phase may create exactly one immutable result record before normal exit. It is bound to run, manifest, boot, phase, unit, `InvocationID`, controller invocation, script hash, last completed boundary, operation-record hashes, sanitized evidence hashes, result schema, and monotonic timestamps.

The exact exit map, with no `SuccessExitStatus` override, is:

- `0`: success;
- `64`: deterministic application, service, or public validation failure;
- `70`: identity, marker, property, environment, or protocol failure;
- `75`: cooperative cancellation at a safe boundary with an exact cancellation reason.

A signal, runtime timeout, forced stop, crash, or pre-result failure may leave the result absent. Absence gains classification meaning only after a valid terminal witness and full fence.

Required systemd evidence includes:

- `ExecMainPID`;
- `ExecMainCode`;
- `ExecMainStatus`;
- `ExecMainStartTimestampMonotonic`;
- `ExecMainExitTimestampMonotonic`;
- `Result`, `ActiveState`, and `SubState`;
- `MainPID`, `ControlPID`, `ControlGroup`, and `ControlGroupId`;
- `NRestarts`;
- exact start/stop job ID, path, type, state, and `JobRemoved` result.

For a loaded unit after finalizer completion, accepted terminal evidence is a closed set consistent with the result and job records:

- result `0`: normal main exit status `0`, `Result=success`, no job, zero main/control PIDs, and inactive/dead or another documented successful terminal state compatible with `RemainAfterExit=no`;
- result `64`, `70`, or `75`: normal main exit with that exact status, `Result=exit-code`, no job, zero main/control PIDs, and a matching failed terminal state;
- absent result after containment or abnormal death: exact signal/core/timeout/stop evidence, matching job outcome, no job, zero main/control PIDs, and no contradictory normal result.

A successful unit may already be unloaded after a valid witness. A failed unit may remain loaded. The former `active/exited` retention requirement is forbidden.

Malformed, missing-mandatory, or contradictory result/systemd evidence blocks the fence or classification. Same-name recreation, invocation drift, nonzero PIDs, current jobs, `NRestarts` other than zero, or an unexplained terminal tuple blocks automatic progression.

## 18. Restoration retry classification

After restoration attempt 1 reaches full fence, the controller creates immutable `245-RESTORE_1_OUTCOME` while holding the global run lock. It cites hashes of the phase result, finalizer witness, systemd/job evidence, cancellation records, fault record, and every delegated-operation record.

Attempt 2 is authorized only for this closed list:

- absent result plus runtime timeout;
- absent result plus signal, core dump, or abnormal process death;
- absent result plus unexpected nonzero main exit classified as abnormal implementation exit;
- exact safe cancellation caused by lost acknowledgement or controller handoff.

Attempt 2 is forbidden for:

- deterministic failure `64`;
- protocol failure `70`;
- explicit operator cancellation;
- identity, property, boot, environment, or trusted-boundary drift;
- malformed, missing-mandatory, or contradictory records;
- start, resource, or protocol failure before a valid main execution;
- any unresolved external operation.

`300-RESTORE_2_INTENT` cites the exact attempt-1 outcome hash. Any attempt-2 outcome other than verified success ends in `OPERATOR_REQUIRED`. No third attempt is permitted.

## 19. State machine and escalation ordering

| State | Entry evidence | Allowed next action |
|---|---|---|
| staged | verified bundle and `RUN_STAGED` | reserve under the global lock |
| reserved | `RUN_RESERVED`, authoritative boot, no other nonterminal run | read-only preflight |
| blocked pre-mutation | read-only failure before mutator intent | `RUN_BLOCKED_PRE_MUTATION`; no production mutation |
| mutator intended | mutator intent, same boot | create or reconcile only the deterministic mutator |
| mutator live or delayed | accepted exact unit, with or without entry | wait, cancel, or stop/reconcile only |
| mutator process-terminal | valid finalizer witness | reconcile delegate, unit, result, gate, and marker evidence |
| mutator fenced | full exact fence | start restoration attempt 1 |
| restore 1 fenced | full attempt-1 fence | verify success or classify the closed retry decision |
| restore 2 fenced | full attempt-2 fence | verify success or escalate |
| restoration verified | exact attempt 1 or 2 verification | classify run outcome |
| failed restored | mutator/fault failure plus verified restoration | terminal `RUN_FAILED_RESTORED` |
| succeeded | mutator success, verified restoration, final gates | terminal `RUN_SUCCEEDED`; local phase may begin |
| operator required | terminal escalation evidence | no further automation |

Exact transition semantics are:

- A read-only failure before mutator intent produces `RUN_BLOCKED_PRE_MUTATION`.
- A definitive same-boot start rejection after intent, with no accepted unit, bound/entered record, or delegated operation, produces `RUN_FAILED_NO_MUTATION`.
- Every accepted mutator unit requires a terminal witness and, when all full-fence conditions are available, restoration attempt 1.
- A mutator deterministic/protocol/abnormal failure followed by verified restoration produces `RUN_FAILED_RESTORED`, not `OPERATOR_REQUIRED`.
- Mutator success plus verified restoration and final gates produces `RUN_SUCCEEDED`.
- Late invalid-partial drift, quarantine collision, or another safety collision creates `FAULT_PENDING`, then contains and fences the phase and restores the old service; verified restoration produces `RUN_FAILED_RESTORED`.
- `OPERATOR_REQUIRED` is written only when process or delegate fencing is unavailable, restoration is nonretryably unavailable or failed, attempt 2 fails, boot changes, or the trusted evidence boundary is violated.
- A process-terminal mutator with any unresolved external delegate cannot reach `FENCE_PROVED`; automatic restoration is forbidden and the run ends in `OPERATOR_REQUIRED`.

`FAULT_PENDING`, `CANCEL_INTENT`, and `CANCEL_FENCE` do not authorize production progress. They permit only safety closure and restoration already required by a valid full mutator fence.

## 20. Controller lifetime, lost acknowledgements, and reconciliation

### 20.1 Lost start acknowledgement

Before a phase creation request, the controller writes intent and the exact start-request record under the global lock after a boot check. Creation uses fail-on-name-conflict behavior.

On ambiguous response:

1. compare boot identity before any unit query;
2. query exact name and invocation lookup plus bound/entered/cancellation records;
3. accept an existing unit only if every identity, dependency, property, controller invocation, and record matches;
4. if no unit and no accepted/bound/entered/delegate evidence exists after the `10s` visibility window, reissue the same exact creation once on the same boot;
5. never use another unit name or run ID;
6. any remaining ambiguity creates `FAULT_PENDING` and proceeds only through the applicable safe terminal classification.

A boot change suppresses reissue.

### 20.2 Lost completion or stop acknowledgement

A lost client, D-Bus, `systemd-run`, or stop acknowledgement does not change state. Reconciliation queries the exact unit and durable records. A stop request is not blindly repeated while an exact stop job exists.

Completion requires the finalizer witness and full fence. A command return, absent PID, missing unit, or journal line is never sufficient.

### 20.3 Client death

The client may die without changing server ownership. A same-run client reconnect can invoke reconciliation, but it cannot infer completion or start a duplicate phase.

### 20.4 Controller death

If the controller dies:

- its global lock is released;
- PID 1 stops any bound live phase through the exact `BindsTo=`/`After=` relationship;
- durable nonterminal markers continue to reserve the run;
- another run remains forbidden;
- a new same-run controller invocation may acquire the global lock only for reconciliation;
- while any old phase is nonterminal, the new controller is stop/reconcile-only;
- no phase is rerun;
- a same-name phase with a new invocation is rejected;
- if the old phase becomes process-terminal, the new controller may validate the existing witness, close only already-acknowledged delegates, create the full fence when valid, and perform required restoration;
- if an external `BEGIN` is unmatched, the new controller cannot invent `QUIESCED` or restore automatically.

Controller shutdown has `TimeoutStopSec=60s`, exceeding the `45s` containment budget. If a delegated operation's own deadline prevents completion, the controller writes a durable handoff and exits without a false fence or terminal-success claim.

### 20.5 Host reboot

A boot mismatch is detected before unit query, adoption, stop, reissue, witness acceptance, fence, restoration, or mutation. The run writes `OPERATOR_REQUIRED` with `reason=BOOT_ID_CHANGED`. No automatic recovery or restoration follows. A separately approved recovery decision is required.

## 21. Exact deadline algebra

Fixed remote values are:

- mutator internal maintenance budget: `60s`;
- mutator internal snapshot budget: `600s`;
- mutator `RuntimeMaxSec=720s`;
- each restoration internal work budget: `180s`;
- each restoration `RuntimeMaxSec=240s`;
- each phase `TimeoutStopSec=10s`;
- finalizer internal witness deadline: `5s`;
- start visibility: `10s`;
- post-witness terminal reconciliation: `10s`;
- poll interval: `250ms`;
- cancellation/containment through witness/fence: `45s` after cancellation linearization or exact containment start;
- controller `RuntimeMaxSec=1800s`;
- controller `TimeoutStopSec=60s`;
- lost-start reissue: one maximum;
- restoration attempts: two maximum.

The mutator's `60s + 600s` internal work fits under `720s` with a `60s` protocol margin. Each restoration's `180s` work fits under `240s` with the same margin.

Controller lower-bound calculation:

- mutator runtime plus stop/finalizer allowance: `720 + 10`;
- two restoration runtimes plus stop/finalizer allowance: `2 * (240 + 10)`;
- three visibility windows: `3 * 10`;
- three terminal reconciliation windows: `3 * 10`;
- fixed transition/evidence overhead allowance: `120`;
- lower bound: `1410s`;
- controller margin: `1800 - 1410 = 390s`.

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
- exactly one `blog` process with the approved identity, online and loopback-only;
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
- controller and phase unit names, invocation IDs, dependencies, properties, command arrays, and sanitized environment-contract digests;
- start/stop/reload job identities and outcomes;
- phase bound records, cgroup path/ID, worker device/inode identities, terminal witnesses, and post-witness reconciliation;
- immutable phase results and outcome classifications;
- phase-gate and global-lock acquisition/release records;
- every PM2/Nginx `BEGIN` and `QUIESCED` record;
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
- `RUN_FAILED_NO_MUTATION`: same-boot definitive phase start rejection after intent with no accepted/bound/entered/delegate activity;
- `RUN_FAILED_RESTORED`: mutator or safety path failed, but a full mutator fence and verified restoration were obtained;
- `OPERATOR_REQUIRED`: process/delegate fencing unavailable, restoration nonretryably unavailable/failed, attempt 2 failed, boot changed, or trusted evidence was violated.

No terminal result authorizes cleanup, a new production run, publication, or a later release task.

## 26. Tests and pre-plan architecture-validation gate

### 26.1 Future minimal real-systemd gate

Before implementation-plan writing, a minimal exercise must run on the exact distribution build with systemd 255 as PID 1 and unified cgroup v2. This is a future pre-plan architecture-validation gate, not completed evidence.

It must demonstrate:

- the old `RemainAfterExit=yes` post-terminal pathname assumption fails through systemd cgroup pruning;
- the new topology places main/descendant processes in `worker` and the finalizer in `.control`;
- the finalizer durably witnesses recursive worker emptiness for success, nonzero exit, signal, runtime timeout, explicit stop, and SIGTERM-ignoring descendants;
- unit-root pruning or unloading after the witness does not invalidate reconciliation;
- missing/malformed witness or worker identity drift blocks the fence.

Artifacts must include exact unit definitions, property/job read-back, cgroup identities, witness bytes/hashes, result tuples, pruning observations, and negative cases. Independent architecture and security reviewers must approve the artifacts and exact results before implementation planning.

If the topology does not behave as specified on the exact systemd-255 build, work stops and the architecture is redesigned. It must not fall back to an undocumented pre-opened file-descriptor assumption.

### 26.2 Later full integration suite

The later implementation suite must additionally cover:

- exact transient names, properties, dependencies, command arrays, environment, hashes, and no `--wait`/`--pipe`/`--collect`;
- same-name/invocation substitution and worker-inode recreation races;
- success, deterministic exits `64` and `70`, cooperative cancellation `75`, absent result, signal, core, runtime timeout, explicit stop, and forced kill;
- controller death before, during, and after finalizer witness;
- `BindsTo=` phase stop on exact controller loss and stop-only behavior after controller recreation;
- delayed starts and cancellation before `execve`, `BOUND`, `ENTERED`, and every mutation/delegated-operation gate boundary;
- a gate held by a hung operation, containment, finalizer witness, later cancel fence, and unresolved-delegate escalation;
- PM2 death before send, after send before callback, after callback before `QUIESCED`, and after `QUIESCED`;
- PM2 daemon/socket/version/entry drift and rejection of every auto-spawn path;
- Nginx death before reload, during the D-Bus job, after job before new worker generation, during graceful drain, and after `QUIESCED`;
- concurrent, substituted, failed, or ambiguous Nginx reload jobs;
- reboot after reservation and at every intent/start/bound/entered/result/witness/fence phase;
- boot mismatch suppressing query, reissue, adoption/stop, witness acceptance, restoration, and mutation;
- every result/classification tuple, every forbidden attempt-2 class, and impossibility of a third attempt;
- environment poisoning, manager expansion attempts, shell startup/function injection, loader variables, Node/npm variables, and ambient PM2 variables;
- late invalid-partial drift and quarantine collision safety closure;
- local SCP, checksum, extraction, worktree, hydration, `npm ci`, audit, and bundle hangs with retained evidence;
- output scans proving no secrets, opaque ecosystem content, broad deletion, PID-only kill, wildcard action, or unreviewed executable path.

Any failed case blocks implementation review. The implementation and test bytes require fresh independent security and architecture review before any production authorization.

## 27. Migration, review, rollout, and completion boundaries

The blocked round-5 scripts and their prior local suite remain historical evidence only. They are not production inputs and are not wrapped by this architecture.

The allowed sequence is:

1. corrected tracked design revision;
2. fresh independent security and architecture design approval plus user re-review;
3. successful future real-systemd-255 architecture-validation gate and independent review of its artifacts;
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

- `systemd-run(1)` for `--expand-environment=no` and transient creation behavior;
- `systemd.service(5)` for `Type=exec`, `ExitType=cgroup`, `RemainAfterExit=`, `ExecStopPost=`, `DelegateSubgroup=`, and result semantics;
- `systemd.kill(5)` for `KillMode=control-group`, stop signals, and forced-kill behavior;
- `systemd.exec(5)` for environment, command, and execution-context properties;
- `systemd.unit(5)` for `BindsTo=` and `After=` semantics;
- `systemctl(1)` and `org.freedesktop.systemd1(5)` for exact property, invocation, job, and D-Bus reload reconciliation;
- systemd v255 `service.c` and `cgroup.c` source paths governing terminal transitions and cgroup pruning.

Kernel semantics must be reviewed against the Linux cgroup v2 documentation for `cgroup.events`, recursive `populated`, cgroup identity, and removal.

PM2 behavior must be reviewed against the exact installed version's pinned daemon/client/RPC implementation and same-session callback behavior; generic high-level CLI polling is not authoritative.

Nginx behavior must be reviewed against the exact installed binary, `nginx.service`/`ExecReload` definition, Nginx signal/reload worker-generation semantics, and systemd v255 D-Bus job behavior.
