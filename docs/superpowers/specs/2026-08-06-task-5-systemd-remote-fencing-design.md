# Task 5 systemd remote-fencing design

Date: 2026-08-06

User approval date: 2026-08-06

Status: user-approved design; implementation requires independent review and separate authorization

## 1. Context and problem

Task 5 of the English article release must capture a consistent production source snapshot, restore the old public service, transfer the verified snapshot, and create an isolated detached candidate. The original release design and implementation plan remain authoritative for the content, snapshot, candidate, service-restoration, opaque-configuration, and production-safety boundaries.

The current Task 5 production state is safely blocked:

- The old public service was restored and independently verified.
- Maintenance is inactive, PM2 is online, the application listens only on `127.0.0.1:3000`, production remains at the expected pre-release commit, and the localized-content audit passed at `4/4/4/4` in the retained review evidence.
- `/root/blog-english-release-20260804` contains an invalid partial snapshot with no `SHA256SUMS`.
- No local source transfer, detached candidate, candidate worktree, or release bundle exists.
- The round-5 retry executable is blocked and must not be executed.

The final round-5 security and govern breaker reviews found the same load-bearing defect: proving that the operator-side SSH process group is empty does not prove that the privileged production-side command and all of its descendants are terminal. A client timeout, killed SSH process, disconnect, or lost completion acknowledgement can leave the remote mutator running after the local process is gone. Starting restoration in that state could overlap snapshot mutation, PM2 changes, or maintenance changes.

Task 5 therefore requires a server-owned execution identity, cancellation path, terminal acknowledgement, and cgroup proof. Restoration must never depend on the lifetime or exit status of the client-side SSH process.

## 2. Decision summary

The chosen architecture runs each governed production attempt as transient systemd services on the production host:

1. A transient controller service owns orchestration and durable state reconciliation.
2. A transient mutator service owns maintenance enablement, PM2 freeze, invalid-partial quarantine, and fresh snapshot creation.
3. One or, only when required, two transient restoration service attempts restore and verify the old public service.
4. Every phase has a deterministic unit name and a systemd-generated `InvocationID` bound into root-only durable evidence.
5. The mutator and restoration phase units use `Type=exec`, `ExitType=cgroup`, `KillMode=control-group`, `Restart=no`, `RemainAfterExit=yes`, fixed `RuntimeMaxSec`, and fixed `TimeoutStopSec`.
6. The client and controller start transient services asynchronously. They do not use `systemd-run --wait`, `--pipe`, or `--collect`.
7. A phase is fenced only after the exact unit and `InvocationID` have no current job, are in an allowed terminal state, and their exact cgroup has `cgroup.events` with `populated 0`.
8. Restoration is forbidden until the mutator's immutable `FENCE_PROVED` marker exists.
9. The design survives SSH/client death through host-side services and durable state. Automatic recovery after a host reboot is explicitly out of scope.

The systemd manager, rather than an SSH session or shell process group on the operator workstation, becomes the authority for process ownership and lifecycle. The cgroup v2 `populated` field is the final live-process proof because it covers the unit's cgroup and descendants recursively.

## 3. Goals

The design must:

- prevent mutator/restoration overlap after a timeout, disconnect, lost acknowledgement, client death, or controller death;
- assign every reviewed production attempt a deterministic run identity;
- bind every service execution to the exact expected unit name, staged script bytes, and systemd `InvocationID`;
- keep root-only durable state that can be reconciled from a new SSH connection;
- serialize all Task 5 production mutation through one global `flock` boundary;
- make fencing and restoration transitions one-way and append-only;
- preserve the current invalid partial snapshot exactly before creating a fresh snapshot;
- preserve every accepted control from the blocked Task 5 retry, including preflight, no-replace moves, exact-three snapshot publication, opaque ecosystem handling, restoration validation, transfer, candidate provenance, and evidence retention;
- restore the old public service after every started mutator attempt when, and only when, the mutator has been proved terminal;
- produce explicit operator-escalation evidence instead of claiming safety when terminal proof or restoration proof is unavailable;
- provide production-shaped integration evidence on systemd 255 with a unified cgroup v2 hierarchy before production authorization.

## 4. Non-goals

This design does not:

- authorize production execution, SSH/SCP, Nginx, PM2, backup, snapshot, transfer, publication, push, or deletion;
- change the English release product scope, translation rules, taxonomy behavior, publication flow, or Task 5 candidate outputs;
- edit or replace the original release design, implementation plan, runbook, production configuration, ignored SDD evidence, scripts, or tests;
- install a permanent daemon or static Task 5 unit on production;
- make `ecosystem.config.js` non-opaque or permit its contents, secrets, or process environment to be displayed;
- accept PID-only proof, local SSH process-group proof, SSH exit status, or a successful `systemctl stop` return as terminal proof;
- treat an invalid or partial snapshot as transferable input;
- automatically retry a terminally failed production run under the same reviewed identity;
- automatically recover after a production host reboot.

**Host reboot automatic recovery is out of scope.** A reboot can remove transient unit and cgroup evidence while leaving durable Task 5 markers. Reboot recovery requires explicit operator escalation, fresh state verification, and a separately approved recovery or retry decision; reboot alone must never create `FENCE_PROVED` or authorize restoration.

## 5. Required capabilities and prerequisites

### 5.1 Production host

The implementation requires all of the following before any Task 5 mutation:

- Linux with systemd exactly version 255 for the reviewed production implementation;
- a unified cgroup v2 hierarchy mounted at `/sys/fs/cgroup`;
- systemd support for transient services, `Type=exec`, `ExitType=cgroup`, `InvocationID`, and the required service properties;
- root access through the existing governed SSH path;
- root-owned, non-group-writable system tool paths and the previously reviewed exact tools, including `systemd-run`, `systemctl`, `flock`, `sha256sum`, GNU `mv` with no-clobber/no-target semantics, Nginx, PM2, Node.js, tar, and the existing application audit/backup commands;
- the reviewed maintenance no-store prerequisite, exact inactive site, exact retained maintenance backups, expected production Git boundary, loopback listener, passing audit, empty operation registry, and adequate disk;
- the exact invalid partial snapshot identity recorded in section 17.

A version mismatch, cgroup v1 or hybrid-only environment, absent `cgroup.events`, unexpected tool identity, or missing transient property is a pre-mutation blocker.

### 5.2 Architectural properties relied upon

The design relies on these official systemd and cgroup semantics:

- `Type=exec` reports process setup and executable failures rather than considering the service started before `execve` succeeds.
- `ExitType=cgroup` keeps the service running while any process remains in the service cgroup, including descendants after the original main process exits.
- `KillMode=control-group` applies stop handling to all remaining processes in the unit cgroup.
- `Restart=no` prevents manager-driven re-entry after failure or timeout.
- `RemainAfterExit=yes` keeps a successful phase represented as `active/exited` for inspection rather than immediately collapsing successful completion into an unobservable client result.
- A unit `InvocationID` uniquely identifies one runtime cycle and is available both as a unit property and as `$INVOCATION_ID` inside the service.
- On cgroup v2, `cgroup.events` reports `populated 0` only when the cgroup and all descendants contain no live process.

These assumptions are not accepted solely from documentation. Section 20 requires them to be demonstrated on systemd 255/cgroup v2 integration infrastructure.

## 6. Alternatives and trade-offs

### 6.1 Continue local process-group supervision

Rejected. It proves only local descendants and cannot account for the production-side command after SSH transport death. This is the exact round-5 breaker.

### 6.2 Depend on SSH disconnect, SIGHUP, keepalives, or command exit

Rejected. None proves that the exact privileged remote process tree is terminal. A lost acknowledgement also makes completed and still-running commands indistinguishable.

### 6.3 Use `systemd-run --wait`, `--pipe`, or `--collect`

Rejected.

- `--wait` recouples completion to the calling connection and does not make the client acknowledgement authoritative.
- `--pipe` ties service standard I/O to the initiating process and adds another client-lifetime dependency.
- `--collect` can remove the unit state needed for reconciliation and exact terminal proof.

The design starts units asynchronously, routes output to the journal, retains inspectable units, and performs all acknowledgement through separate read-only queries.

### 6.4 Use `nohup`, `setsid`, tmux, cron, or `at`

Rejected. These mechanisms do not provide the required exact unit identity, `InvocationID`, manager-owned cgroup, declarative kill behavior, job state, or queryable terminal proof.

### 6.5 Install permanent Task 5 units or a custom daemon

Rejected for this one-time governed release. Permanent units broaden production configuration and lifecycle scope. Transient units provide the required host-owned lifecycle without leaving a new enabled service. Durable run evidence is stored separately from transient unit definitions.

### 6.6 Chosen trade-off

The chosen architecture is more complex than a single SSH script and can deliberately leave maintenance active or PM2 stopped when terminal proof is unavailable. That fail-closed availability cost is accepted because starting restoration against a possibly live mutator is unsafe. Every such branch ends in explicit operator escalation and does not claim Task 5 safe or complete.

## 7. Deterministic identities

### 7.1 Review manifest and run ID

Each independently reviewed implementation bundle has one canonical `review.manifest`:

- UTF-8, LF-only, sorted key/value records;
- no comments, timestamps, random values, credentials, or host-fetched data;
- exact hashes, sizes, and modes for the controller, mutator, restoration, reconciliation, and upload-verifier scripts;
- exact feature HEAD `1ee3fbc3ebc43f552d3f592bf41d79751ca6a731`;
- expected production HEAD `860bfe53e54dff4ab78bbfa2f7e5f644a032b9aa`;
- fixed systemd properties and deadlines from section 10;
- exact canonical paths and the invalid partial identity from section 17;
- exact reviewed maintenance snippet/site/backup identities inherited from the blocked Task 5 controls.

The deterministic run ID is:

`run_id = "t5-20260804-" + lowercase_hex(SHA-256(review.manifest bytes))`

The required syntax is `^t5-20260804-[0-9a-f]{64}$`. The manifest does not contain the derived run ID, avoiding recursive identity. A separate root-only `run.id` contains the derived value.

The same reviewed manifest always produces the same run ID. Lost acknowledgements and client reconnects must reuse that ID. Any implementation byte, property, deadline, expected-state, or manifest change produces a new ID and requires fresh independent review. A terminal production failure may not be rerun in place under the same ID.

### 7.2 Unit names

For run ID `${RUN_ID}`, the exact transient unit names are:

- controller: `blog-task5-${RUN_ID}-controller.service`
- mutator: `blog-task5-${RUN_ID}-mutator.service`
- restoration attempt 1: `blog-task5-${RUN_ID}-restore-1.service`
- restoration attempt 2: `blog-task5-${RUN_ID}-restore-2.service`

No aliases, templates, wildcard targets, scopes, user units, or alternate names are allowed. The implementation must query the cgroup path from the exact unit property; it must not construct or guess the escaped cgroup path.

### 7.3 Invocation identities

Every controller and phase start gets a systemd-generated 32-lowercase-hex `InvocationID`. As its first actions, each phase script self-verifies its exact unit properties and staged bytes, acquires the global flock, rechecks the one-way state, and then exclusively creates its own bound marker followed by its entered marker using `$INVOCATION_ID`, exact unit name, run ID, and script hash. Only after those steps may it mutate production. The controller independently reads the unit's `InvocationID` and properties and requires an exact match with both phase markers before accepting the binding.

A unit-name match with an unexpected `InvocationID` is not the same execution. It is an identity conflict and forces operator escalation.

## 8. Root-only paths and permissions

The durable root is:

`/var/lib/blog/task-5-systemd-fencing`

Required layout:

- `global.lock` — global flock file, root:root `0600`;
- `active-run` — atomically updated convenience pointer; never authoritative over immutable markers;
- `incoming/${RUN_ID}/` — upload staging, root:root `0700`;
- `runs/${RUN_ID}/bundle/` — verified immutable run bundle, root:root `0700`;
- `runs/${RUN_ID}/markers/` — one-way transition records, root:root `0700`;
- `runs/${RUN_ID}/evidence/` — sanitized property, cgroup, public, and command-result evidence, root:root `0700`;
- `runs/${RUN_ID}/controller-invocations/` — one record per explicit controller runtime cycle;
- `runs/${RUN_ID}/phase-invocations/` — exact phase/unit/InvocationID bindings.

Regular manifests and evidence files are root:root `0600`. Executable scripts are root:root `0500`. No symlink, hardlink, device, FIFO, socket, group/other-writable directory, or unexpected extra entry is accepted anywhere in the run bundle or marker tree.

All service units run with `User=root`, `Group=root`, and `UMask=0077`. No Task 5 durable state is stored under `/tmp`, `/private/tmp`, a home directory, the Git checkout, the journal alone, or the production release tree.

The production release and quarantine paths remain:

- canonical release: `/root/blog-english-release-20260804`
- invalid-partial quarantine for this run: `/root/blog-english-release-20260804.failed-${RUN_ID}`

The quarantine destination must be absent and must be created only by the reviewed atomic no-replace whole-root rename.

## 9. Upload and provenance

1. The client computes the canonical manifest hash and deterministic run ID locally from the independently approved bundle.
2. A fixed bootstrap command using only reviewed absolute system tools creates the absent `incoming/${RUN_ID}` directory with root:root `0700`.
3. Files are transferred as regular files to unique temporary basenames. No script is executed from standard input, a here-document, a pipe, `/tmp`, or an unverified upload path.
4. Before executing uploaded code, the client invokes only absolute remote `stat` and `sha256sum` tools, reads back the upload-verifier and manifest identities, and requires exact equality with the independently approved local values.
5. The now-verified server-side upload verifier inventories every entry without following symlinks, rejects extras and unsafe types, and verifies exact filename, byte size, mode, and SHA-256 against `review.manifest`.
6. The verifier recomputes the run ID and requires it to equal the requested path and unit-name identity.
7. The verified incoming directory is atomically published with no replacement as `runs/${RUN_ID}/bundle`.
8. Before every service start, the controller rechecks the target script, complete manifest, bundle directory identity, run ID, and exact unit definition. After start, the executing script independently rechecks its own regular-file identity, manifest, bundle, run ID, exact unit name, and `$INVOCATION_ID` before every production mutation boundary.
9. No mutation occurs before both controller-side and phase-side checks pass.

The exact script path and safe arguments are present in `ExecStart` and are read back as part of unit identity. No credential, token, cookie, password, ecosystem content, or secret-bearing environment value appears in the manifest, unit name, command line, journal identifier, or evidence.

## 10. Transient unit contract

### 10.1 Shared phase properties

Every mutator and restoration unit has these exact properties:

| Property | Required value |
|---|---|
| `Type` | `exec` |
| `ExitType` | `cgroup` |
| `KillMode` | `control-group` |
| `KillSignal` | `SIGTERM` |
| `SendSIGKILL` | `yes` |
| `FinalKillSignal` | `SIGKILL` |
| `Restart` | `no` |
| `RemainAfterExit` | `yes` |
| `TimeoutStopSec` | `5s` |
| `User` / `Group` | `root` / `root` |
| `UMask` | `0077` |
| `WorkingDirectory` | `/` |
| `StandardInput` | `null` |
| `StandardOutput` / `StandardError` | `journal` / `journal` |

The fixed phase runtimes are:

| Unit | `RuntimeMaxSec` |
|---|---:|
| mutator | `660s` |
| restoration attempt 1 | `180s` |
| restoration attempt 2 | `180s` |

The mutator retains internal fixed stage budgets of `60s` for maintenance enablement and `600s` for snapshot mutation. An internal deadline result never authorizes restoration; systemd terminal/cgroup proof remains mandatory.

### 10.2 Controller properties

The controller uses the same process-identity, kill, restart, retention, root, umask, working-directory, and journal properties, with `RuntimeMaxSec=1200s` and `TimeoutStopSec=5s`. `Restart=no` is mandatory. Controller recovery is explicit reconciliation, not automatic restart.

The controller's fixed reconciliation budgets are:

| Control | Fixed value |
|---|---:|
| unit visibility after an ambiguous start | `10s` |
| terminal-property/cgroup proof after observed completion | `10s` |
| cancellation request through completed terminal proof | `15s` |
| property/cgroup poll interval | `250ms` |
| same-name start reissue after lost acknowledgement | `1` maximum |
| restoration attempts | `2` maximum |

Budget expiry never relaxes proof. It creates pre-mutation blocked state when no mutator intent exists, or `OPERATOR_REQUIRED` after mutator intent.

### 10.3 Start behavior

The client starts the controller with one asynchronous `systemd-run` request. The controller starts phase units with asynchronous `systemd-run` requests. Neither path may use:

- `--wait`;
- `--pipe` or `-P`;
- `--collect` or `-G`;
- a transient scope;
- inherited standard input;
- a shell script delivered through stdin.

A `systemd-run` return value is request evidence only. It is never phase-completion evidence. All start and completion acknowledgement comes from exact unit read-back, immutable phase markers, and terminal/cgroup proof.

### 10.4 Required unit read-back

After every start or reconciliation, the controller captures a sanitized property set including:

- exact unit ID and names;
- `LoadState=loaded`, `Transient=yes`, `UnitFileState=transient`, and exact `FragmentPath=/run/systemd/transient/${UNIT_NAME}` read back without following a symlink;
- exact `ExecStart` path and non-secret arguments;
- `Type`, `ExitType`, `KillMode`, `Restart`, `RemainAfterExit`, runtime, and stop timeout;
- `InvocationID`;
- current job identity;
- `ActiveState`, `SubState`, and `Result`;
- `MainPID`, `ControlPID`, and `ControlGroup`;
- restart count.

Any property drift blocks the run before mutation or blocks the next transition after mutation.

## 11. Global lock

All Task 5 production mutation is serialized by an exclusive `flock` on:

`/var/lib/blog/task-5-systemd-fencing/global.lock`

Rules:

1. Initial run reservation and every transition that authorizes production mutation, fence creation, a next phase, restoration verification, or run success are performed while holding the lock.
2. The mutator holds the lock for its full process-tree lifetime. Its lock descriptor is intentionally inherited across its phase descendants.
3. Each restoration attempt holds the same lock for its full process-tree lifetime.
4. A different run may inspect sanitized state but may not reserve, start, cancel, restore, quarantine, publish, or clear state while a nonterminal run exists.
5. A same-run controller may inspect or request cancellation without first acquiring the lock, because a live phase intentionally holds it. The same-run controller may exclusively create only the monotonic cancellation-request or `OPERATOR_REQUIRED` marker without the lock; neither marker authorizes mutation or a next phase.
6. After terminal/cgroup proof, the controller must acquire the lock before writing a terminal-observed/fence marker or starting the next phase.
7. Lock acquisition alone never proves a phase terminal. A prematurely released descriptor, script failure, or manager action cannot replace the exact unit/cgroup proof.
8. Failure to acquire the lock when no exact live phase explains ownership is an inconsistent-state escalation.

The immutable markers are authoritative. `active-run` is only an atomically updated index and may be repaired from marker state while holding the lock.

## 12. One-way markers and state invariants

Every marker is created exactly once with an atomic exclusive-create operation, then file and parent directory synchronization. Markers are never rewritten, truncated, renamed over, or deleted by the run. Each record contains the run ID, manifest hash, actor type, actor unit and `InvocationID`, the phase unit and phase `InvocationID` for every phase transition, UTC time, prior-state name, next-state name, and hashes of the evidence records supporting the transition. Phase-owned bound/entered markers identify the phase as actor; controller-owned intent, observation, fence, and terminal markers identify the current controller invocation as actor.

Required safety markers are:

1. `000-RUN_STAGED`
2. `010-RUN_RESERVED`
3. `100-MUTATOR_INTENT`
4. `110-MUTATOR_BOUND`
5. `120-MUTATOR_ENTERED`
6. `125-MUTATOR_CANCEL_REQUESTED` when cancellation is requested
7. `130-MUTATOR_TERMINAL_OBSERVED`
8. `150-FENCE_PROVED`
9. `200-RESTORE_1_INTENT`
10. `210-RESTORE_1_BOUND`
11. `220-RESTORE_1_ENTERED`
12. `225-RESTORE_1_CANCEL_REQUESTED` when cancellation is requested
13. `230-RESTORE_1_TERMINAL_OBSERVED`
14. `240-RESTORE_1_FENCE_PROVED`
15. `250-RESTORATION_VERIFIED` when attempt 1 succeeds
16. `300-RESTORE_2_INTENT` only when attempt 1 is fenced but not verified
17. `310-RESTORE_2_BOUND`
18. `320-RESTORE_2_ENTERED`
19. `325-RESTORE_2_CANCEL_REQUESTED` when cancellation is requested
20. `330-RESTORE_2_TERMINAL_OBSERVED`
21. `340-RESTORE_2_FENCE_PROVED`
22. `350-RESTORATION_VERIFIED` when attempt 2 succeeds
23. `900-RUN_SUCCEEDED`
24. `910-RUN_BLOCKED_PRE_MUTATION` when a read-only gate blocks before mutator intent
25. `990-OPERATOR_REQUIRED` for any unresolved post-intent safety failure

Additional append-only diagnostic records may exist under `evidence/`, but they cannot replace the safety markers.

Load-bearing invariants:

- `MUTATOR_ENTERED` cannot exist without `MUTATOR_INTENT` and an exact unit/InvocationID binding.
- Once `FENCE_PROVED`, any mutator entry or production mutation is permanently forbidden for that run.
- No restoration intent may exist without `FENCE_PROVED`.
- Restoration attempt 2 may start only after attempt 1 has exact terminal/cgroup proof, has not produced `RESTORATION_VERIFIED`, and has not created `OPERATOR_REQUIRED`.
- `RUN_SUCCEEDED` requires exactly one `RESTORATION_VERIFIED` marker and all final Task 5 service/public/evidence gates.
- A second contradictory marker, an impossible order, an identity mismatch, or both terminal success and operator escalation is corruption. Automation stops without further mutation.

The mutator checks for `FENCE_PROVED`, any restoration marker, `RUN_SUCCEEDED`, and `OPERATOR_REQUIRED` at entry and immediately before each maintenance, PM2, quarantine, backup, staging, and publication mutation. Presence of any post-mutator marker makes it exit without mutation. This is the one-way fence.

## 13. State machine

| State | Entry evidence | Allowed next action |
|---|---|---|
| staged | verified bundle and `RUN_STAGED` | reserve the run under global lock |
| reserved | no other nonterminal run; `RUN_RESERVED` | complete read-only preflight |
| pre-mutation blocked | `RUN_BLOCKED_PRE_MUTATION`; no `MUTATOR_INTENT` | no production mutation; independent review may close the attempt |
| mutator intended | `MUTATOR_INTENT` | create or reconcile only the deterministic mutator unit |
| mutator running | exact bound unit and `MUTATOR_ENTERED` | wait, or request exact-unit cancellation |
| mutator terminal unproved | terminal-looking result or transport loss without full proof | reconcile/cancel; restoration forbidden |
| mutator fenced | exact proof and `FENCE_PROVED` | start restoration attempt 1 |
| restoration 1 running | exact attempt-1 binding and entry | wait, or request exact-unit cancellation |
| restoration 1 fenced, unverified | exact attempt-1 terminal/cgroup proof | start attempt 2 only for the retryable failure classes listed in section 16 |
| restoration 2 running | exact attempt-2 binding and entry | wait, or request exact-unit cancellation |
| restoration verified | attempt 1 or 2 completed every remote and public gate | perform final evidence gates and mark run success |
| operator required | exact escalation marker | no further automation or in-place retry |
| succeeded | verified restoration plus final gates | local transfer/candidate phase may begin under the original Task 5 boundaries |

Once a mutator unit has been started, restoration is run even if the mutator reports failure before its first intended production write. This keeps the post-start path uniform and produces positive verification of the old public-service state. The sole exception is a failure before `MUTATOR_INTENT`, where no phase unit and no production mutation exists.

## 14. Remote terminal and cgroup proof

### 14.1 Proof algorithm

For a specific phase unit and expected `InvocationID`, the controller performs this proof within the fixed `10s` terminal-proof budget, polling no faster than every `250ms`:

1. Query the exact unit name through a fresh host-side `systemctl show` call.
2. Require the unit to be loaded and transient with the exact staged `ExecStart` and properties.
3. Require the exact nonempty expected `InvocationID`.
4. Require no current start, stop, restart, reload, or other unit job; the decoded job ID must be zero and its object path empty/root.
5. Require one allowed terminal tuple from section 14.2.
6. Require `MainPID=0` and `ControlPID=0`.
7. Read the exact `ControlGroup` property, reject an empty, relative, escaping, or unexpected path, and read `/sys/fs/cgroup${ControlGroup}/cgroup.events` without following a symlink.
8. Parse the flat-keyed file and require exactly one `populated` field with value `0`. Other kernel-defined fields may be retained as evidence but do not weaken the requirement.
9. Query the unit properties again and require the same unit, `InvocationID`, `ControlGroup`, no-job state, and terminal tuple.
10. Under the global lock, recheck one-way marker invariants and write the phase terminal marker plus its fence marker.

A missing cgroup directory or `cgroup.events`, `populated 1`, malformed/duplicate `populated`, changed `InvocationID`, changed cgroup, current job, live PID, or nonterminal state fails proof. Absence is not treated as equivalent to `populated 0`.

### 14.2 Allowed terminal tuples

Only these tuples are accepted:

- successful retained phase: `ActiveState=active`, `SubState=exited`, `Result=success`, main process exited normally with status `0`;
- failed phase: `ActiveState=failed`, `SubState=failed`, with a non-success `Result` consistent with the retained exit/signal/timeout evidence;
- explicitly cancelled phase: `ActiveState=inactive`, `SubState=dead`, only when an immutable cancellation-request record exists and the completed stop job, unit result, and cgroup-empty evidence are retained.

`running`, `start`, `activating`, `deactivating`, `stop-sigterm`, `stop-sigkill`, `auto-restart`, `reload`, `maintenance`, unknown states, or a successful result inconsistent with the phase's own terminal marker are not accepted.

A return from `systemctl stop`, a missing PID, an SSH exit, a journal line, or a script-written terminal marker alone is insufficient.

## 15. Cancellation, reconciliation, and lost acknowledgements

### 15.1 Cancellation

Cancellation is triggered by a phase deadline, explicit operator cancellation, controller shutdown handling, transport ambiguity, or an abnormal phase state.

- Cancellation targets the exact deterministic unit name; no PID, process-name search, wildcard, slice-wide kill, or guessed cgroup is allowed.
- The controller requests `systemctl stop` through a separate bounded control connection.
- The phase's `KillMode=control-group`, `TimeoutStopSec=5s`, and final SIGKILL policy apply to the entire unit cgroup.
- A cancellation request is evidence only. The controller must wait for no job, an allowed terminal tuple, exact `InvocationID`, and `cgroup.events` `populated 0`.
- A lost stop acknowledgement is reconciled by querying the exact unit. The stop command is not blindly repeated if a stop job already exists.
- If cancellation through terminal proof cannot complete within the fixed `15s` cancellation budget, the run creates `OPERATOR_REQUIRED`. Restoration remains forbidden when the mutator is unfenced.

### 15.2 Lost start acknowledgement

Before creating a phase unit, the controller writes the phase intent marker. It then requests the exact deterministic unit with systemd's fail-on-name-conflict behavior.

If the response is lost or ambiguous:

1. query the exact unit name and both phase-owned bound/entered markers;
2. if the unit exists, verify all properties and accept only its exact `InvocationID`;
3. if either phase-owned marker exists, require its unit/`InvocationID` to match the loaded unit and never create a second unit;
4. if no unit and no phase-owned marker exists after the fixed `10s` visibility window, reissue the same exact unit creation once;
5. if the original request was processed, the deterministic name prevents a duplicate and the second request resolves as an existing-unit case;
6. any remaining ambiguity becomes operator escalation.

There is no fallback to a new unit name or new run ID.

### 15.3 Lost completion acknowledgement

A lost SSH response, controller RPC response, or `systemd-run` output does not change state. The reconnecting controller queries the exact unit and markers, binds the same `InvocationID`, and runs the terminal proof. A completed operation may proceed only from that proof; a still-running operation is waited for or cancelled.

### 15.4 Client death

The SSH client may die immediately after controller creation without changing phase ownership. The controller and phase services continue under the production systemd manager with journal output and root-only state. A new client uses the same deterministic run ID and reconciles the exact controller and phase units. Client death never causes automatic restoration by itself.

### 15.5 Controller death

`Restart=no` applies to the controller. If it dies:

- a live mutator or restoration phase continues under systemd and retains the global lock;
- no other run may begin because durable nonterminal markers reserve the run;
- an explicitly invoked same-run controller reconciliation cycle verifies the exact staged controller bytes and records its new controller `InvocationID`;
- the reconciler never starts another mutator if `MUTATOR_INTENT`, `MUTATOR_ENTERED`, or any later marker exists;
- it waits for or cancels the exact live phase, proves it terminal, and resumes only the allowed state transition;
- if the phase unit disappeared after an entry marker but before cgroup proof, the run cannot infer termination and enters operator escalation.

A loaded failed controller with exact properties may be explicitly started again. If the transient controller definition is no longer loaded but the host has not rebooted, the same exact transient definition may be recreated from the verified bundle. This is manual reconciliation, not `Restart=` behavior.

### 15.6 Host reboot

No automatic recovery runs after reboot. Transient units and their cgroups may be gone, so pre-reboot phase termination cannot be proved by the required method. Durable markers and evidence are preserved, but automation must stop at operator escalation. A separately approved procedure must verify maintenance, PM2, Nginx, production Git, snapshot paths, locks, and public service before deciding whether to restore, preserve, or begin a new reviewed run.

## 16. Restoration sequencing

Restoration attempt 1 starts only after `FENCE_PROVED` has been durably written for the exact mutator unit and `InvocationID`.

The restoration service then, under the global lock:

1. self-verifies script, manifest, unit, run, and restoration `InvocationID`;
2. rechecks `FENCE_PROVED` and all one-way markers;
3. refuses to run if any mutator cgroup is live, any mutator job exists, or the fence evidence is inconsistent;
4. starts the old PM2 process if necessary and requires exactly one `blog` process, `online`, with a positive live PID;
5. requires exactly one listener at `127.0.0.1:3000`;
6. verifies direct Express and loopback Nginx smoke;
7. verifies the expected production HEAD, no staged changes, no non-ecosystem tracked changes, and the exact approved opaque ecosystem status without reading its contents;
8. runs the existing localized-content audit and requires schema/integrity/foreign-key/operation checks plus counts `4/4/4/4`;
9. restores the exact inactive maintenance site state, runs `nginx -t`, reloads, and rereads exact site/snippet/backup identities;
10. performs two fresh sanitized public-open probes requiring `200`, `private`, `no-store`, no `Age`, no `Expires`, and no forbidden Cloudflare stored-object state;
11. emits success only after every field passes.

Signals do not bypass the service manager's cgroup ownership. If restoration attempt 1 times out, fails, loses acknowledgement, or is cancelled, the controller first proves that exact restoration unit terminal with `populated 0`.

Attempt 2 is allowed only after `RESTORE_1_FENCE_PROVED` and only when attempt 1 ended through `RuntimeMaxSec`, an external signal, controller-requested cancellation caused by lost transport/acknowledgement, or abnormal process death before the restoration script emitted a deterministic field failure. PM2, listener, Express, Nginx, Git, audit, maintenance, public-cache, identity, marker, property, secret, or opaque-state validation failures are deterministic and are not retryable. Attempt 2 uses a different deterministic unit name and `InvocationID`, but the same run ID, manifest, global lock, and restoration script bytes.

After attempt 2, any failure or unavailable proof creates `OPERATOR_REQUIRED`. No third restoration attempt, mutator rerun, local transfer, candidate creation, or success marker is allowed.

## 17. Exact current invalid snapshot handling

The current production partial is invalid and preserved. The implementation must pin this exact identity before any maintenance mutation and recheck it immediately before quarantine:

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
3. after maintenance is active and PM2 is proved stopped, atomically rename the entire canonical release root to that exact quarantine path using the reviewed no-replace/no-target operation;
4. verify the canonical path is absent, the quarantine identity is byte-for-byte and metadata-for-metadata unchanged, and no nesting or overwrite occurred;
5. never copy, merge, delete, add a manifest to, transfer, or use the quarantined partial as snapshot input;
6. publish a fresh canonical release only from a separately verified staging tree containing exactly `blog.db`, `runtime.tar`, and `SHA256SUMS`.

Any quarantine collision or identity mismatch retains both sides unchanged and proceeds only to mutator fencing and old-service restoration.

## 18. Snapshot, local candidate, and opaque-state boundaries

The systemd architecture changes only remote execution ownership and fencing. The accepted Task 5 data controls remain unchanged:

- database verification occurs in a unique root-only disposable directory so SQLite sidecars cannot pollute the final artifact set;
- tar inventory is fully materialized and validated without an early-closing producer pipeline;
- staging and final snapshot directories contain exactly three regular non-symlink files;
- the manifest is created atomically and verified before and after no-replace publication;
- forensic, failed-work, staging, and final evidence is retained according to the prior no-broad-delete rules;
- transfer and local candidate work begin only after `RESTORATION_VERIFIED` and `RUN_SUCCEEDED`;
- local source hashes, exact-three boundary, tar types/names, detached worktree provenance, selective hydration, empty operations, `npm ci`, `4/4/4/4` audit, and empty mode-`0700` release bundle remain mandatory;
- the snapshot's old taxonomy is not copied over the committed candidate taxonomy;
- the snapshot's `ecosystem.config.js` is archived only by exact pathname and remains opaque; it is not displayed, parsed, printed, or copied into the candidate.

Production `ecosystem.config.js` remains an approved opaque sole unstaged override. Checks may verify only the exact sanitized Git-status boundary already approved by governance. The implementation must not reset, stage, overwrite, hash for output, read into evidence, or expose its contents.

## 19. Evidence, retention, secrets, and escalation

### 19.1 Required evidence

The run retains, at minimum:

- canonical review manifest, run ID, script hashes/sizes/modes, and upload inventory;
- every controller and phase unit name and `InvocationID`;
- unit property read-back before start acknowledgement and at terminal proof;
- start/stop job identities and outcomes;
- exact before/after cgroup property snapshots and `cgroup.events` contents used for every fence;
- immutable marker timeline;
- global-lock acquisition/release records;
- sanitized preflight, maintenance, PM2, listener, Nginx, audit, snapshot inventory, manifest, restoration, and public cache-field evidence;
- exact invalid-partial pre/post-quarantine identity;
- final local transfer/candidate evidence if the run reaches that boundary;
- journal references filtered by exact `_SYSTEMD_INVOCATION_ID`.

No run automatically deletes its bundle, markers, evidence, failed unit state, quarantined partial, failed work, or retained backups. Cleanup is a separate reviewed action after required independent review and retention approval. `--collect` is forbidden.

### 19.2 Secret and opaque configuration rules

- Never use `set -x` in governed scripts.
- Never print command environments, PM2 environments, secret-bearing configuration, cookies, authorization headers, tokens, passwords, private keys, or response bodies.
- Never place a secret in a unit name, run ID, manifest, environment property, command argument, journal identifier, marker, or evidence file.
- Public probes emit only the approved status/cache fields.
- PM2, Git, audit, backup, tar, and Nginx outputs are reduced to fixed non-secret fields; unselected output stays in memory or is discarded.
- State and evidence remain root-only with `UMask=0077`.

### 19.3 Operator escalation conditions

Automation writes `OPERATOR_REQUIRED` and stops when any of these occurs after mutator intent:

- script, manifest, path, property, unit, or `InvocationID` mismatch;
- marker contradiction or unexpected existing run state;
- unexplained global-lock ownership or active-run conflict;
- systemd/cgroup version or capability drift;
- persistent job, unknown terminal state, live PID, missing/malformed cgroup evidence, or `populated 1` after cancellation;
- a phase unit disappears after its entry marker but before terminal proof;
- invalid-partial identity drift or quarantine collision;
- mutator fence proof failure;
- restoration attempt 2 failure or any restoration fence-proof failure;
- inability to prove old-service/public restoration;
- host reboot during a nonterminal run;
- suspected secret or opaque-configuration disclosure;
- any production state outside the approved release/governance boundary.

When the mutator is not fenced, operator escalation deliberately forbids automated restoration. The report must state that maintenance or PM2 state may require manual recovery and must not claim the service safe. When restoration is fenced but unsuccessful, no further automated attempt is permitted.

## 20. systemd 255/cgroup v2 integration tests

Implementation may not proceed to production review until a fresh Linux integration suite runs with systemd 255 as PID 1 and a unified cgroup v2 hierarchy. Mocked `systemctl`, local process groups, containers without a real systemd manager, and retained round-5 tests are insufficient for this gate.

The suite must cover:

### 20.1 Unit identity and properties

- exact transient controller, mutator, restore-1, and restore-2 names;
- exact property table, fixed runtimes/timeouts, `Restart=no`, and no unexpected restart;
- `Type=exec` failure for an absent/non-executable script;
- nonempty 32-hex `InvocationID` available both in the unit and service environment;
- exact `ExecStart`, transient state, journal routing, and null stdin;
- static and behavioral proof that `--wait`, `--pipe`, and `--collect` are absent.

### 20.2 Exit and cgroup behavior

- a mutator parent exits while a descendant remains; `ExitType=cgroup` keeps the unit nonterminal and `populated 1`;
- normal success reaches `active/exited`, no job, zero PIDs, and `populated 0`;
- nonzero exit, signal, and `RuntimeMaxSec` reach the allowed failed tuple with `populated 0`;
- a descendant ignores SIGTERM; stop escalates within `TimeoutStopSec=5s`, kills the full cgroup, and reaches `populated 0`;
- nested descendants are covered recursively by `cgroup.events`;
- missing, malformed, duplicate, unreadable, or nonzero `populated` evidence blocks `FENCE_PROVED`;
- unit or `InvocationID` substitution blocks proof even when another cgroup is empty.

### 20.3 Lost acknowledgement and client death

- controller start acknowledgement lost before and after manager acceptance;
- mutator and restoration start acknowledgement lost before and after phase entry;
- completion acknowledgement lost after successful and failed completion;
- stop acknowledgement lost while a stop job is queued and after it completes;
- SSH client killed immediately after controller start, after mutator intent, after maintenance activation, after PM2 stop, and after snapshot publication;
- reconnect with the same run ID binds the existing exact unit and never creates a duplicate.

### 20.4 Controller death

- controller killed while mutator runs;
- controller killed after mutator terminal but before `FENCE_PROVED`;
- controller killed during each restoration attempt;
- explicit same-run reconciliation records a new controller `InvocationID`, does not rerun the mutator, and resumes only from proved durable state;
- disappeared phase after entry but before proof enters operator escalation.

### 20.5 One-way fencing and global lock

- a second run cannot reserve or mutate while the first phase holds the lock or has nonterminal markers;
- a forked descendant retains phase ownership while alive;
- restoration cannot start before `FENCE_PROVED` under race injection;
- mutator entry and every mutation boundary fail after `FENCE_PROVED` or any restoration marker;
- restoration attempt 2 cannot start before restore-1 cgroup proof and cannot overlap attempt 1;
- duplicate or out-of-order marker creation fails closed;
- no third restoration attempt is possible.

### 20.6 Production-shaped Task 5 behavior

- exact current four-file invalid partial passes identity and is atomically quarantined whole-root with no replacement;
- every partial identity drift and late quarantine collision preserves evidence and blocks fresh publication;
- hangs occur before maintenance mutation, after maintenance reload, after PM2 stop, during DB backup, during tar creation, and during final publication;
- every case requires mutator terminal/cgroup proof before restoration;
- exact-three fresh snapshot, sidecar confinement, tar inventory, manifest, and no-replace publication controls remain green;
- restoration failure injection covers every PM2/listener/Express/Nginx/Git/audit/maintenance/public field;
- local transfer/candidate work is impossible before `RUN_SUCCEEDED` and remains green after verified restoration;
- output scans find no secrets, ecosystem contents, broad deletion, PID-only kill, wildcard unit action, or unreviewed executable path.

### 20.7 Retention and reboot boundary

- successful and failed units remain inspectable without `--collect` for the complete proof/evidence window;
- evidence survives controller and client death;
- cleanup does not run automatically;
- a reboot-boundary test or documented systemd-255 VM exercise confirms that no Task 5 static unit is enabled and no automatic recovery occurs; durable nonterminal state requires operator escalation after reboot.

Any failed integration case blocks implementation review. Tests and implementation identities must receive fresh independent security and govern review before production authorization.

## 21. Migration from the blocked Task 5 retry

1. The round-5 retry script and its `34/34` local suite remain historical blocked evidence. They are not production inputs and are not wrapped by the new controller.
2. Implementation begins from this tracked specification, preserving all previously accepted Task 5 controls while replacing local SSH/process-group containment with the systemd protocol.
3. New controller, mutator, restoration, reconciliation, upload-verifier, and systemd-255 integration-test artifacts receive exact identities.
4. Independent security review verifies the complete bytes, unit properties, cgroup proof, cancellation, secrets, current partial handling, restoration, and test evidence.
5. Independent govern review verifies this specification, the original release design/plan, Task 5 governance, the current production snapshot state, and the exact reviewed identities.
6. Any review finding that changes bytes, properties, paths, deadlines, or expected state regenerates `review.manifest`, the deterministic run ID, and both reviews.
7. A separate explicit production authorization is required for upload, transient-unit creation, maintenance, PM2, quarantine, backup, snapshot, restoration, transfer, or candidate work.
8. After `RUN_SUCCEEDED`, Task 5 resumes at verified transfer and detached candidate creation under the original plan. No later release task is implicitly authorized.

Independent review is required before implementation begins. The documentation owner provides self-review only; it is not an independent security or govern PASS.

## 22. Rollout and rollback boundaries

### 22.1 Rollout

The rollout sequence is limited to:

1. tracked design approval;
2. local implementation and static tests without production access;
3. systemd 255/cgroup v2 integration tests in isolated infrastructure;
4. exact manifest/run identity generation;
5. independent security and govern approval;
6. separate explicit production authorization;
7. root-only bundle upload and verification;
8. transient controller creation and governed execution;
9. independent post-run security and Task 5 review before continuing the release.

No permanent service, timer, socket, path unit, daemon, package, Nginx configuration, PM2 configuration, or boot-time enablement is part of rollout.

### 22.2 Rollback

Before `MUTATOR_INTENT`, rollback means stop without production mutation and retain the blocked evidence.

After `MUTATOR_INTENT`, the controller implementation itself is not rolled back or replaced in place. The only automated recovery path is:

1. reconcile or cancel the exact mutator;
2. prove the exact mutator unit/InvocationID terminal with no job and `populated 0`;
3. create `FENCE_PROVED`;
4. run and verify restoration under the fixed attempt limit;
5. stop at success or explicit operator escalation.

The quarantined invalid partial, failed work, manifests, unit state, journals, markers, and backups are not automatically deleted during rollback. A different script, altered unit property, manual PID kill, direct Nginx/PM2 continuation, new run ID, or unreviewed third restoration attempt is outside the rollback boundary.

## 23. Completion criteria

This design is ready for implementation review only when the tracked file:

- contains no unfinished design marker or unresolved state transition;
- remains documentation-only and does not alter the approved plan/runbook/code/tests/evidence;
- preserves the original release and governance boundaries;
- explicitly binds restoration to exact systemd terminal/cgroup proof;
- explicitly states that host reboot automatic recovery is out of scope;
- records the exact user approval date as 2026-08-06.

A future Task 5 implementation is production-ready only after all systemd-255 integration tests pass, exact artifact identities are independently approved by security and govern reviewers, and the user separately authorizes the production operation. This specification and its commit do not authorize production execution.

## 24. Architecture references

The implementation and independent reviews must use the systemd 255 versions of the official `systemd-run(1)`, `systemd.service(5)`, `systemd.kill(5)`, `systemctl(1)`, `systemd.exec(5)`, and `org.freedesktop.systemd1(5)` documentation, together with the Linux kernel cgroup v2 documentation for `cgroup.events` and recursive `populated` semantics.
