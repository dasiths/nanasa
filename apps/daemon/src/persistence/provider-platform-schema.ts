export const PROVIDER_PLATFORM_SCHEMA_V9_SQL = `
  CREATE UNIQUE INDEX runs_target_identity ON runs (id, generation);

  CREATE TABLE provider_packages (
    extension_generation TEXT PRIMARY KEY,
    extension_id TEXT NOT NULL,
    version TEXT NOT NULL,
    package_digest TEXT NOT NULL UNIQUE CHECK (length(package_digest) = 64),
    manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
    publisher_id TEXT NOT NULL,
    namespace_claims_json TEXT NOT NULL CHECK (json_valid(namespace_claims_json)),
    source_json TEXT NOT NULL CHECK (json_valid(source_json)),
    signatures_json TEXT NOT NULL CHECK (json_valid(signatures_json)),
    manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
    state TEXT NOT NULL CHECK (state IN ('quarantined', 'verified', 'resolved', 'revoked', 'rejected')),
    anti_rollback_sequence INTEGER NOT NULL CHECK (anti_rollback_sequence >= 0),
    imported_at TEXT NOT NULL,
    verified_at TEXT,
    revoked_at TEXT
  ) STRICT;

  CREATE TABLE provider_snapshots (
    digest TEXT PRIMARY KEY CHECK (length(digest) = 64),
    extension_generation TEXT NOT NULL REFERENCES provider_packages(extension_generation),
    provider_id TEXT NOT NULL,
    adapter_id TEXT NOT NULL,
    canonical_bytes BLOB NOT NULL CHECK (length(canonical_bytes) > 0),
    manifest_protocol_json TEXT NOT NULL CHECK (json_valid(manifest_protocol_json)),
    adapter_protocol_json TEXT NOT NULL CHECK (json_valid(adapter_protocol_json)),
    interpreter_versions_json TEXT NOT NULL CHECK (json_valid(interpreter_versions_json)),
    capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
    grants_json TEXT NOT NULL CHECK (json_valid(grants_json)),
    assets_json TEXT NOT NULL CHECK (json_valid(assets_json)),
    compatibility_json TEXT NOT NULL CHECK (json_valid(compatibility_json)),
    created_at TEXT NOT NULL,
    UNIQUE (digest, extension_generation),
    UNIQUE (digest, provider_id, adapter_id)
  ) STRICT;

  CREATE TABLE provider_activations (
    id TEXT PRIMARY KEY,
    index_generation INTEGER NOT NULL CHECK (index_generation > 0),
    provider_id TEXT NOT NULL,
    extension_generation TEXT NOT NULL REFERENCES provider_packages(extension_generation),
    snapshot_digest TEXT NOT NULL,
    grants_digest TEXT NOT NULL CHECK (length(grants_digest) = 64),
    trust_digest TEXT NOT NULL CHECK (length(trust_digest) = 64),
    rollback_activation_id TEXT REFERENCES provider_activations(id),
    state TEXT NOT NULL CHECK (state IN ('staged', 'active', 'superseded', 'rolled-back', 'revoked')),
    created_at TEXT NOT NULL,
    activated_at TEXT,
    FOREIGN KEY (snapshot_digest, extension_generation)
      REFERENCES provider_snapshots(digest, extension_generation),
    UNIQUE (index_generation, provider_id),
    UNIQUE (id, provider_id, snapshot_digest)
  ) STRICT;

  CREATE UNIQUE INDEX provider_activations_one_active
    ON provider_activations (provider_id) WHERE state = 'active';

  CREATE TABLE run_provider_bindings (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    integration_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    adapter_id TEXT NOT NULL,
    snapshot_digest TEXT NOT NULL,
    activation_id TEXT NOT NULL,
    process_recognition_digest TEXT NOT NULL CHECK (length(process_recognition_digest) = 64),
    status_policy_digest TEXT NOT NULL CHECK (length(status_policy_digest) = 64),
    provider_state_id TEXT NOT NULL,
    overlay_id TEXT NOT NULL,
    credential_slots_json TEXT NOT NULL CHECK (json_valid(credential_slots_json)),
    launch_digest TEXT NOT NULL CHECK (length(launch_digest) = 64),
    permission_floor_digest TEXT NOT NULL CHECK (length(permission_floor_digest) = 64),
    repository_trust_digest TEXT NOT NULL CHECK (length(repository_trust_digest) = 64),
    provider_binary_json TEXT NOT NULL CHECK (json_valid(provider_binary_json)),
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id, generation) REFERENCES runs(id, generation),
    FOREIGN KEY (snapshot_digest, provider_id, adapter_id)
      REFERENCES provider_snapshots(digest, provider_id, adapter_id),
    FOREIGN KEY (activation_id, provider_id, snapshot_digest)
      REFERENCES provider_activations(id, provider_id, snapshot_digest),
    UNIQUE (run_id, generation),
    UNIQUE (id, run_id, generation, snapshot_digest),
    UNIQUE (id, snapshot_digest)
  ) STRICT;

  CREATE TABLE provider_process_incarnations (
    digest TEXT PRIMARY KEY CHECK (length(digest) = 64),
    binding_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    snapshot_digest TEXT NOT NULL,
    pane_id TEXT NOT NULL,
    foreground_pgid INTEGER NOT NULL CHECK (foreground_pgid > 0),
    leader_pid INTEGER NOT NULL CHECK (leader_pid > 0),
    pid_start_identity TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    ended_at TEXT,
    FOREIGN KEY (binding_id, run_id, generation, snapshot_digest)
      REFERENCES run_provider_bindings(id, run_id, generation, snapshot_digest),
    UNIQUE (digest, binding_id, snapshot_digest)
  ) STRICT;

  CREATE TABLE provider_authority_fences (
    record_type TEXT NOT NULL CHECK (record_type IN (
      'reporter-session', 'native-session', 'wait', 'action', 'action-attempt',
      'action-acknowledgement', 'overlay', 'provider-state', 'trust', 'status'
    )),
    record_id TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    snapshot_digest TEXT NOT NULL,
    process_incarnation_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (record_type, record_id),
    FOREIGN KEY (binding_id, run_id, generation, snapshot_digest)
      REFERENCES run_provider_bindings(id, run_id, generation, snapshot_digest),
    FOREIGN KEY (process_incarnation_digest, binding_id, snapshot_digest)
      REFERENCES provider_process_incarnations(digest, binding_id, snapshot_digest)
  ) STRICT;

  CREATE TABLE provider_operation_audits (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    snapshot_digest TEXT NOT NULL REFERENCES provider_snapshots(digest),
    binding_id TEXT,
    run_id TEXT,
    generation INTEGER CHECK (generation IS NULL OR generation > 0),
    process_incarnation_digest TEXT,
    target_handles_json TEXT NOT NULL CHECK (json_valid(target_handles_json)),
    state TEXT NOT NULL CHECK (state IN ('started', 'succeeded', 'failed', 'cancelled', 'timed-out', 'uncertain')),
    input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
    output_digest TEXT CHECK (output_digest IS NULL OR length(output_digest) = 64),
    safe_error_code TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    CHECK (
      (binding_id IS NULL AND run_id IS NULL AND generation IS NULL AND process_incarnation_digest IS NULL)
      OR
      (binding_id IS NOT NULL AND run_id IS NOT NULL AND generation IS NOT NULL AND process_incarnation_digest IS NOT NULL)
    ),
    FOREIGN KEY (binding_id, run_id, generation, snapshot_digest)
      REFERENCES run_provider_bindings(id, run_id, generation, snapshot_digest),
    FOREIGN KEY (process_incarnation_digest, binding_id, snapshot_digest)
      REFERENCES provider_process_incarnations(digest, binding_id, snapshot_digest),
    UNIQUE (snapshot_digest, operation_id, idempotency_key)
  ) STRICT;

  CREATE TABLE status_source_claims (
    id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    snapshot_digest TEXT NOT NULL,
    process_incarnation_digest TEXT NOT NULL,
    status_policy_digest TEXT NOT NULL CHECK (length(status_policy_digest) = 64),
    source TEXT NOT NULL CHECK (source IN ('process', 'reporter', 'status-api', 'screen', 'osc')),
    source_id TEXT NOT NULL,
    source_session_id TEXT,
    source_manifest_digest TEXT CHECK (source_manifest_digest IS NULL OR length(source_manifest_digest) = 64),
    claim_type TEXT NOT NULL CHECK (claim_type IN (
      'process-liveness', 'semantic-state', 'phase', 'outcome', 'exact-wait',
      'fatal-failure', 'observer-health'
    )),
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
    reason_code TEXT NOT NULL,
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    source_occurred_at TEXT,
    received_at TEXT NOT NULL,
    expires_at TEXT,
    FOREIGN KEY (binding_id, run_id, generation, snapshot_digest)
      REFERENCES run_provider_bindings(id, run_id, generation, snapshot_digest),
    FOREIGN KEY (process_incarnation_digest, binding_id, snapshot_digest)
      REFERENCES provider_process_incarnations(digest, binding_id, snapshot_digest),
    UNIQUE (binding_id, source, source_id, claim_type)
  ) STRICT;

  CREATE TABLE reporter_turn_cycles (
    id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    snapshot_digest TEXT NOT NULL,
    process_incarnation_digest TEXT NOT NULL,
    reporter_session_id TEXT NOT NULL,
    root_session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'waiting', 'settling', 'closed', 'abandoned')),
    open_tool_count INTEGER NOT NULL CHECK (open_tool_count >= 0),
    open_wait_count INTEGER NOT NULL CHECK (open_wait_count >= 0),
    completion_revision INTEGER NOT NULL CHECK (completion_revision >= 0),
    opened_at TEXT NOT NULL,
    settled_at TEXT,
    closed_at TEXT,
    FOREIGN KEY (binding_id, run_id, generation, snapshot_digest)
      REFERENCES run_provider_bindings(id, run_id, generation, snapshot_digest),
    FOREIGN KEY (process_incarnation_digest, binding_id, snapshot_digest)
      REFERENCES provider_process_incarnations(digest, binding_id, snapshot_digest),
    UNIQUE (binding_id, reporter_session_id, root_session_id, turn_id)
  ) STRICT;

  CREATE TRIGGER provider_snapshots_no_update
    BEFORE UPDATE ON provider_snapshots
    BEGIN SELECT RAISE(ABORT, 'provider snapshots are immutable'); END;
  CREATE TRIGGER provider_snapshots_no_delete
    BEFORE DELETE ON provider_snapshots
    BEGIN SELECT RAISE(ABORT, 'provider snapshots are immutable'); END;
  CREATE TRIGGER run_provider_bindings_no_update
    BEFORE UPDATE ON run_provider_bindings
    BEGIN SELECT RAISE(ABORT, 'run provider bindings are immutable'); END;
  CREATE TRIGGER run_provider_bindings_no_delete
    BEFORE DELETE ON run_provider_bindings
    BEGIN SELECT RAISE(ABORT, 'run provider bindings are immutable'); END;

  CREATE INDEX provider_packages_extension_state
    ON provider_packages (extension_id, state, anti_rollback_sequence);
  CREATE INDEX provider_snapshots_provider_created
    ON provider_snapshots (provider_id, created_at);
  CREATE INDEX run_provider_bindings_provider
    ON run_provider_bindings (provider_id, snapshot_digest, created_at);
  CREATE INDEX provider_process_incarnations_run
    ON provider_process_incarnations (run_id, generation, observed_at);
  CREATE INDEX provider_authority_fences_binding
    ON provider_authority_fences (binding_id, record_type);
  CREATE INDEX provider_operation_audits_target
    ON provider_operation_audits (binding_id, state, started_at);
  CREATE INDEX status_source_claims_run
    ON status_source_claims (run_id, generation, source, claim_type);
  CREATE INDEX reporter_turn_cycles_run
    ON reporter_turn_cycles (run_id, generation, state, opened_at);
`;

export const PROVIDER_PLATFORM_SCHEMA_SQL = `
  CREATE UNIQUE INDEX runs_target_identity ON runs (id, generation);

  CREATE TABLE provider_packages (
    extension_generation TEXT PRIMARY KEY,
    extension_id TEXT NOT NULL,
    version TEXT NOT NULL,
    package_digest TEXT NOT NULL UNIQUE CHECK (length(package_digest) = 64),
    manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
    publisher_id TEXT NOT NULL,
    namespace_claims_json TEXT NOT NULL CHECK (json_valid(namespace_claims_json)),
    source_json TEXT NOT NULL CHECK (json_valid(source_json)),
    signatures_json TEXT NOT NULL CHECK (json_valid(signatures_json)),
    manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
    state TEXT NOT NULL CHECK (state IN ('quarantined', 'verified', 'resolved', 'revoked', 'rejected')),
    anti_rollback_sequence INTEGER NOT NULL CHECK (anti_rollback_sequence >= 0),
    imported_at TEXT NOT NULL,
    verified_at TEXT,
    revoked_at TEXT
  ) STRICT;

  CREATE TABLE provider_assets (
    extension_generation TEXT NOT NULL REFERENCES provider_packages(extension_generation),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    path TEXT NOT NULL,
    media_type TEXT NOT NULL,
    kind TEXT NOT NULL,
    content BLOB NOT NULL CHECK (length(content) > 0),
    payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (extension_generation, digest),
    UNIQUE (extension_generation, path)
  ) STRICT;

  CREATE TABLE provider_snapshots (
    digest TEXT PRIMARY KEY CHECK (length(digest) = 64),
    extension_generation TEXT NOT NULL REFERENCES provider_packages(extension_generation),
    provider_id TEXT NOT NULL,
    adapter_id TEXT NOT NULL,
    canonical_bytes BLOB NOT NULL CHECK (length(canonical_bytes) > 0),
    manifest_protocol_json TEXT NOT NULL CHECK (json_valid(manifest_protocol_json)),
    adapter_protocol_json TEXT NOT NULL CHECK (json_valid(adapter_protocol_json)),
    interpreter_versions_json TEXT NOT NULL CHECK (json_valid(interpreter_versions_json)),
    capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
    grants_json TEXT NOT NULL CHECK (json_valid(grants_json)),
    assets_json TEXT NOT NULL CHECK (json_valid(assets_json)),
    compatibility_json TEXT NOT NULL CHECK (json_valid(compatibility_json)),
    created_at TEXT NOT NULL,
    UNIQUE (digest, extension_generation),
    UNIQUE (digest, provider_id, adapter_id)
  ) STRICT;

  CREATE TABLE provider_activations (
    id TEXT PRIMARY KEY,
    index_generation INTEGER NOT NULL CHECK (index_generation > 0),
    provider_id TEXT NOT NULL,
    extension_generation TEXT NOT NULL REFERENCES provider_packages(extension_generation),
    snapshot_digest TEXT NOT NULL,
    grants_digest TEXT NOT NULL CHECK (length(grants_digest) = 64),
    trust_digest TEXT NOT NULL CHECK (length(trust_digest) = 64),
    rollback_activation_id TEXT REFERENCES provider_activations(id),
    state TEXT NOT NULL CHECK (state IN ('staged', 'active', 'superseded', 'rolled-back', 'revoked')),
    created_at TEXT NOT NULL,
    activated_at TEXT,
    FOREIGN KEY (snapshot_digest, extension_generation)
      REFERENCES provider_snapshots(digest, extension_generation),
    UNIQUE (index_generation, provider_id),
    UNIQUE (id, provider_id, snapshot_digest)
  ) STRICT;

  CREATE UNIQUE INDEX provider_activations_one_active
    ON provider_activations (provider_id) WHERE state = 'active';

  CREATE TABLE run_provider_bindings (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    integration_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    adapter_id TEXT NOT NULL,
    snapshot_digest TEXT NOT NULL,
    activation_id TEXT NOT NULL,
    process_recognition_digest TEXT NOT NULL CHECK (length(process_recognition_digest) = 64),
    status_policy_digest TEXT NOT NULL CHECK (length(status_policy_digest) = 64),
    provider_state_id TEXT NOT NULL,
    overlay_id TEXT NOT NULL,
    credential_slots_json TEXT NOT NULL CHECK (json_valid(credential_slots_json)),
    launch_plan_json TEXT NOT NULL CHECK (json_valid(launch_plan_json)),
    launch_digest TEXT NOT NULL CHECK (length(launch_digest) = 64),
    permission_floor_digest TEXT NOT NULL CHECK (length(permission_floor_digest) = 64),
    repository_trust_digest TEXT NOT NULL CHECK (length(repository_trust_digest) = 64),
    provider_binary_json TEXT NOT NULL CHECK (json_valid(provider_binary_json)),
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id, generation) REFERENCES runs(id, generation),
    FOREIGN KEY (snapshot_digest, provider_id, adapter_id)
      REFERENCES provider_snapshots(digest, provider_id, adapter_id),
    FOREIGN KEY (activation_id, provider_id, snapshot_digest)
      REFERENCES provider_activations(id, provider_id, snapshot_digest),
    UNIQUE (run_id, generation),
    UNIQUE (id, run_id, generation, snapshot_digest),
    UNIQUE (id, run_id, generation, snapshot_digest, provider_id),
    UNIQUE (id, snapshot_digest)
  ) STRICT;

  CREATE TABLE provider_overlays (
    id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    provider_id TEXT NOT NULL,
    snapshot_digest TEXT NOT NULL,
    provider_state_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    recipe_digest TEXT NOT NULL CHECK (length(recipe_digest) = 64),
    asset_digest TEXT NOT NULL CHECK (length(asset_digest) = 64),
    content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
    ownership_manifest_digest TEXT NOT NULL CHECK (length(ownership_manifest_digest) = 64),
    ledger_json TEXT NOT NULL CHECK (json_valid(ledger_json)),
    state TEXT NOT NULL CHECK (state IN ('active', 'replaced', 'failed')),
    created_at TEXT NOT NULL,
    FOREIGN KEY (binding_id, run_id, generation, snapshot_digest, provider_id)
      REFERENCES run_provider_bindings(id, run_id, generation, snapshot_digest, provider_id),
    UNIQUE (binding_id),
    UNIQUE (id, binding_id, snapshot_digest)
  ) STRICT;

  CREATE TABLE provider_process_incarnations (
    digest TEXT PRIMARY KEY CHECK (length(digest) = 64),
    binding_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    snapshot_digest TEXT NOT NULL,
    pane_id TEXT NOT NULL,
    foreground_pgid INTEGER NOT NULL CHECK (foreground_pgid > 0),
    leader_pid INTEGER NOT NULL CHECK (leader_pid > 0),
    pid_start_identity TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    ended_at TEXT,
    FOREIGN KEY (binding_id, run_id, generation, snapshot_digest)
      REFERENCES run_provider_bindings(id, run_id, generation, snapshot_digest),
    UNIQUE (digest, binding_id, snapshot_digest)
  ) STRICT;

  CREATE TABLE provider_authority_fences (
    record_type TEXT NOT NULL CHECK (record_type IN (
      'reporter-session', 'native-session', 'wait', 'action', 'action-attempt',
      'action-acknowledgement', 'overlay', 'provider-state', 'trust', 'status'
    )),
    record_id TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    snapshot_digest TEXT NOT NULL,
    process_incarnation_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (record_type, record_id),
    FOREIGN KEY (binding_id, run_id, generation, snapshot_digest)
      REFERENCES run_provider_bindings(id, run_id, generation, snapshot_digest),
    FOREIGN KEY (process_incarnation_digest, binding_id, snapshot_digest)
      REFERENCES provider_process_incarnations(digest, binding_id, snapshot_digest)
  ) STRICT;

  CREATE TABLE provider_operation_audits (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    snapshot_digest TEXT NOT NULL REFERENCES provider_snapshots(digest),
    binding_id TEXT,
    run_id TEXT,
    generation INTEGER CHECK (generation IS NULL OR generation > 0),
    process_incarnation_digest TEXT,
    target_handles_json TEXT NOT NULL CHECK (json_valid(target_handles_json)),
    state TEXT NOT NULL CHECK (state IN ('started', 'succeeded', 'failed', 'cancelled', 'timed-out', 'uncertain')),
    input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
    output_digest TEXT CHECK (output_digest IS NULL OR length(output_digest) = 64),
    safe_error_code TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    CHECK (
      (binding_id IS NULL AND run_id IS NULL AND generation IS NULL AND process_incarnation_digest IS NULL)
      OR
      (binding_id IS NOT NULL AND run_id IS NOT NULL AND generation IS NOT NULL AND process_incarnation_digest IS NOT NULL)
    ),
    FOREIGN KEY (binding_id, run_id, generation, snapshot_digest)
      REFERENCES run_provider_bindings(id, run_id, generation, snapshot_digest),
    FOREIGN KEY (process_incarnation_digest, binding_id, snapshot_digest)
      REFERENCES provider_process_incarnations(digest, binding_id, snapshot_digest),
    UNIQUE (snapshot_digest, operation_id, idempotency_key)
  ) STRICT;

  CREATE TABLE status_source_claims (
    id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    snapshot_digest TEXT NOT NULL,
    process_incarnation_digest TEXT NOT NULL,
    status_policy_digest TEXT NOT NULL CHECK (length(status_policy_digest) = 64),
    source TEXT NOT NULL CHECK (source IN ('process', 'reporter', 'status-api', 'screen', 'osc')),
    source_id TEXT NOT NULL,
    source_session_id TEXT,
    source_manifest_digest TEXT CHECK (source_manifest_digest IS NULL OR length(source_manifest_digest) = 64),
    claim_type TEXT NOT NULL CHECK (claim_type IN (
      'process-liveness', 'semantic-state', 'phase', 'outcome', 'exact-wait',
      'fatal-failure', 'observer-health'
    )),
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
    reason_code TEXT NOT NULL,
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    source_occurred_at TEXT,
    received_at TEXT NOT NULL,
    expires_at TEXT,
    FOREIGN KEY (binding_id, run_id, generation, snapshot_digest)
      REFERENCES run_provider_bindings(id, run_id, generation, snapshot_digest),
    FOREIGN KEY (process_incarnation_digest, binding_id, snapshot_digest)
      REFERENCES provider_process_incarnations(digest, binding_id, snapshot_digest),
    UNIQUE (binding_id, source, source_id, claim_type)
  ) STRICT;

  CREATE TABLE reporter_turn_cycles (
    id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    snapshot_digest TEXT NOT NULL,
    process_incarnation_digest TEXT NOT NULL,
    reporter_session_id TEXT NOT NULL,
    root_session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'waiting', 'settling', 'closed', 'abandoned')),
    open_tool_count INTEGER NOT NULL CHECK (open_tool_count >= 0),
    open_wait_count INTEGER NOT NULL CHECK (open_wait_count >= 0),
    completion_revision INTEGER NOT NULL CHECK (completion_revision >= 0),
    opened_at TEXT NOT NULL,
    settled_at TEXT,
    closed_at TEXT,
    FOREIGN KEY (binding_id, run_id, generation, snapshot_digest)
      REFERENCES run_provider_bindings(id, run_id, generation, snapshot_digest),
    FOREIGN KEY (process_incarnation_digest, binding_id, snapshot_digest)
      REFERENCES provider_process_incarnations(digest, binding_id, snapshot_digest),
    UNIQUE (binding_id, reporter_session_id, root_session_id, turn_id)
  ) STRICT;

  CREATE TABLE reporter_turn_open_tools (
    cycle_id TEXT NOT NULL REFERENCES reporter_turn_cycles(id),
    operation_id TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    PRIMARY KEY (cycle_id, operation_id)
  ) STRICT;

  CREATE TABLE reporter_turn_open_waits (
    cycle_id TEXT NOT NULL REFERENCES reporter_turn_cycles(id),
    request_id TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    PRIMARY KEY (cycle_id, request_id)
  ) STRICT;

  CREATE TABLE provider_reporter_event_receipts (
    event_id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    snapshot_digest TEXT NOT NULL,
    process_incarnation_digest TEXT NOT NULL,
    reporter_session_id TEXT NOT NULL,
    reporter_epoch TEXT NOT NULL,
    source_sequence INTEGER NOT NULL CHECK (source_sequence > 0),
    event_kind TEXT NOT NULL,
    payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
    accepted_at TEXT NOT NULL,
    FOREIGN KEY (binding_id, run_id, generation, snapshot_digest)
      REFERENCES run_provider_bindings(id, run_id, generation, snapshot_digest),
    FOREIGN KEY (process_incarnation_digest, binding_id, snapshot_digest)
      REFERENCES provider_process_incarnations(digest, binding_id, snapshot_digest),
    UNIQUE (binding_id, reporter_session_id, reporter_epoch, source_sequence)
  ) STRICT;

  CREATE TABLE provider_reporter_sessions (
    id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    snapshot_digest TEXT NOT NULL,
    process_incarnation_digest TEXT NOT NULL,
    reporter_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    reporter_epoch TEXT NOT NULL,
    root_session_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('active','revoked','closed')),
    opened_at TEXT NOT NULL,
    FOREIGN KEY (binding_id, run_id, generation, snapshot_digest)
      REFERENCES run_provider_bindings(id, run_id, generation, snapshot_digest),
    FOREIGN KEY (process_incarnation_digest, binding_id, snapshot_digest)
      REFERENCES provider_process_incarnations(digest, binding_id, snapshot_digest),
    UNIQUE (binding_id, reporter_id, reporter_epoch)
  ) STRICT;

  CREATE TRIGGER provider_snapshots_no_update
    BEFORE UPDATE ON provider_snapshots
    BEGIN SELECT RAISE(ABORT, 'provider snapshots are immutable'); END;
  CREATE TRIGGER provider_snapshots_no_delete
    BEFORE DELETE ON provider_snapshots
    WHEN EXISTS (SELECT 1 FROM run_provider_bindings WHERE snapshot_digest = OLD.digest)
      OR EXISTS (SELECT 1 FROM provider_operation_audits WHERE snapshot_digest = OLD.digest)
    BEGIN SELECT RAISE(ABORT, 'referenced provider snapshots cannot be collected'); END;
  CREATE TRIGGER provider_assets_no_update
    BEFORE UPDATE ON provider_assets
    BEGIN SELECT RAISE(ABORT, 'provider assets are immutable'); END;
  CREATE TRIGGER provider_assets_no_delete
    BEFORE DELETE ON provider_assets
    WHEN EXISTS (
      SELECT 1 FROM provider_snapshots
      WHERE extension_generation = OLD.extension_generation
        AND EXISTS (SELECT 1 FROM json_each(assets_json) WHERE json_extract(value, '$.digest') = OLD.digest)
    )
    BEGIN SELECT RAISE(ABORT, 'referenced provider assets cannot be collected'); END;
  CREATE TRIGGER run_provider_bindings_no_update
    BEFORE UPDATE ON run_provider_bindings
    BEGIN SELECT RAISE(ABORT, 'run provider bindings are immutable'); END;
  CREATE TRIGGER run_provider_bindings_no_delete
    BEFORE DELETE ON run_provider_bindings
    BEGIN SELECT RAISE(ABORT, 'run provider bindings are immutable'); END;
  CREATE TRIGGER provider_overlays_no_update
    BEFORE UPDATE ON provider_overlays
    BEGIN SELECT RAISE(ABORT, 'provider overlays are immutable'); END;
  CREATE TRIGGER provider_overlays_no_delete
    BEFORE DELETE ON provider_overlays
    BEGIN SELECT RAISE(ABORT, 'provider overlays are immutable'); END;

  CREATE INDEX provider_packages_extension_state
    ON provider_packages (extension_id, state, anti_rollback_sequence);
  CREATE INDEX provider_assets_digest
    ON provider_assets (digest, extension_generation);
  CREATE INDEX provider_snapshots_provider_created
    ON provider_snapshots (provider_id, created_at);
  CREATE INDEX run_provider_bindings_provider
    ON run_provider_bindings (provider_id, snapshot_digest, created_at);
  CREATE INDEX provider_overlays_binding
    ON provider_overlays (binding_id, snapshot_digest, state);
  CREATE INDEX provider_process_incarnations_run
    ON provider_process_incarnations (run_id, generation, observed_at);
  CREATE UNIQUE INDEX provider_process_incarnations_one_active
    ON provider_process_incarnations (binding_id, pane_id) WHERE ended_at IS NULL;
  CREATE INDEX provider_authority_fences_binding
    ON provider_authority_fences (binding_id, record_type);
  CREATE INDEX provider_operation_audits_target
    ON provider_operation_audits (binding_id, state, started_at);
  CREATE INDEX status_source_claims_run
    ON status_source_claims (run_id, generation, source, claim_type);
  CREATE INDEX reporter_turn_cycles_run
    ON reporter_turn_cycles (run_id, generation, state, opened_at);
  CREATE INDEX reporter_turn_open_tools_cycle ON reporter_turn_open_tools (cycle_id);
  CREATE INDEX reporter_turn_open_waits_cycle ON reporter_turn_open_waits (cycle_id);
  CREATE INDEX provider_reporter_receipts_session
    ON provider_reporter_event_receipts
      (binding_id, reporter_session_id, reporter_epoch, source_sequence);
  CREATE INDEX provider_reporter_sessions_binding
    ON provider_reporter_sessions (binding_id, state, reporter_epoch);
`;
