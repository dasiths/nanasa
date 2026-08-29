export const DATABASE_SCHEMA_VERSION = 5;

export const DATABASE_BASELINE_SQL = `
  CREATE TABLE schema_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL,
    initialized_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE daemon_epochs (
    epoch INTEGER PRIMARY KEY,
    instance_id TEXT NOT NULL UNIQUE,
    process_id INTEGER NOT NULL,
    process_started_at TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    released_at TEXT
  ) STRICT;

  CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    membership_revision INTEGER NOT NULL CHECK (membership_revision >= 0),
    message_sequence INTEGER NOT NULL DEFAULT 0 CHECK (message_sequence >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE roles (
    id TEXT PRIMARY KEY,
    definition_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE agent_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    kind TEXT NOT NULL,
    command TEXT NOT NULL,
    args_json TEXT NOT NULL,
    working_directory TEXT,
    environment_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE memberships (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id),
    member_id TEXT NOT NULL,
    agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
    alias TEXT NOT NULL,
    role_id TEXT REFERENCES roles(id),
    state TEXT NOT NULL CHECK (state IN ('active', 'removed')),
    joined_at TEXT NOT NULL,
    removed_at TEXT,
    UNIQUE (group_id, member_id)
  ) STRICT;

  CREATE TABLE repositories (
    id TEXT PRIMARY KEY,
    common_directory TEXT NOT NULL UNIQUE,
    object_format TEXT NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE checkouts (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id),
    path TEXT NOT NULL UNIQUE,
    git_directory TEXT NOT NULL,
    head TEXT NOT NULL,
    branch TEXT,
    dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
    observed_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE worktrees (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id),
    checkout_id TEXT NOT NULL UNIQUE REFERENCES checkouts(id),
    path TEXT NOT NULL UNIQUE,
    provenance_token TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('creating', 'ready', 'removing', 'removed', 'failed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
    checkout_id TEXT REFERENCES checkouts(id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'stopping', 'stopped', 'failed')),
    desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'stopped')),
    recovery_phase TEXT NOT NULL,
    recovery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (recovery_attempts >= 0),
    recovery_not_before TEXT,
    recovery_reason TEXT,
    launch_kind TEXT NOT NULL DEFAULT 'fresh' CHECK (launch_kind IN ('fresh', 'adopted', 'resuming', 'restarted')),
    requested_model TEXT,
    requested_model_source TEXT NOT NULL DEFAULT 'provider-default' CHECK (requested_model_source IN ('membership', 'integration', 'provider-default')),
    effective_model TEXT,
    native_session_id TEXT,
    recovery_outcome TEXT CHECK (recovery_outcome IN ('retained', 'resumed', 'restarted', 'failed')),
    terminal_json TEXT,
    started_at TEXT NOT NULL,
    stopped_at TEXT,
    UNIQUE (group_id, member_id, generation),
    FOREIGN KEY (group_id, member_id) REFERENCES memberships(group_id, member_id)
  ) STRICT;

  CREATE TABLE runtime_observations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id),
    generation INTEGER NOT NULL,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    source_occurred_at TEXT,
    observed_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    UNIQUE (run_id, generation, event_id)
  ) STRICT;

  CREATE TABLE reporter_sessions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    generation INTEGER NOT NULL,
    provider TEXT NOT NULL,
    reporter TEXT NOT NULL,
    reporter_version TEXT NOT NULL,
    epoch INTEGER NOT NULL CHECK (epoch > 0),
    source_sequence INTEGER NOT NULL DEFAULT 0 CHECK (source_sequence >= 0),
    native_session_id TEXT,
    process_identity TEXT,
    started_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    UNIQUE (run_id, generation, provider, reporter, epoch)
  ) STRICT;

  CREATE TABLE status_revisions (
    run_id TEXT PRIMARY KEY REFERENCES runs(id),
    generation INTEGER NOT NULL,
    reporter_session_id TEXT REFERENCES reporter_sessions(id),
    status_revision INTEGER NOT NULL DEFAULT 0 CHECK (status_revision >= 0),
    completion_revision INTEGER NOT NULL DEFAULT 0 CHECK (completion_revision >= 0),
    status_json TEXT NOT NULL,
    reducer_state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE status_progress_reports (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    generation INTEGER NOT NULL,
    stage TEXT NOT NULL,
    summary TEXT NOT NULL,
    next_step TEXT,
    blocker TEXT,
    outcome TEXT,
    reported_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id),
    group_seq INTEGER NOT NULL CHECK (group_seq > 0),
    conversation_id TEXT NOT NULL,
    intent TEXT NOT NULL,
    sender_json TEXT NOT NULL,
    audience_json TEXT NOT NULL,
    body_json TEXT NOT NULL,
    delivery_json TEXT NOT NULL,
    reply_to TEXT REFERENCES messages(id),
    root_id TEXT REFERENCES messages(id),
    causation_id TEXT REFERENCES messages(id),
    hop INTEGER NOT NULL CHECK (hop >= 0),
    created_at TEXT NOT NULL,
    UNIQUE (group_id, group_seq)
  ) STRICT;

  CREATE TABLE deliveries (
    message_id TEXT NOT NULL REFERENCES messages(id),
    recipient_member_id TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'received', 'delivering', 'terminal_injected', 'processed', 'retrying', 'dead-letter', 'revoked', 'rejected', 'failed')),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    lease_owner TEXT,
    lease_expires_at TEXT,
    next_attempt_at TEXT,
    run_id TEXT REFERENCES runs(id),
    run_generation INTEGER,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (message_id, recipient_member_id)
  ) STRICT;

  CREATE TABLE actions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    member_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id),
    generation INTEGER NOT NULL,
    reporter_session_id TEXT REFERENCES reporter_sessions(id),
    baseline_status_revision INTEGER NOT NULL CHECK (baseline_status_revision >= 0),
    deadline TEXT NOT NULL,
    state TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE action_attempts (
    id TEXT PRIMARY KEY,
    action_id TEXT NOT NULL REFERENCES actions(id),
    attempt INTEGER NOT NULL CHECK (attempt > 0),
    effect TEXT NOT NULL,
    state TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    failure_code TEXT,
    UNIQUE (action_id, attempt)
  ) STRICT;

  CREATE TABLE action_acknowledgements (
    id TEXT PRIMARY KEY,
    action_id TEXT NOT NULL REFERENCES actions(id),
    attempt_id TEXT NOT NULL REFERENCES action_attempts(id),
    state TEXT NOT NULL,
    provider_turn_id TEXT,
    completion_revision INTEGER NOT NULL CHECK (completion_revision >= 0),
    acknowledged_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE open_waits (
    id TEXT PRIMARY KEY,
    action_id TEXT REFERENCES actions(id),
    run_id TEXT NOT NULL REFERENCES runs(id),
    generation INTEGER NOT NULL,
    reporter_session_id TEXT NOT NULL REFERENCES reporter_sessions(id),
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    deadline TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    closed_at TEXT
  ) STRICT;

  CREATE TABLE provider_state (
    id TEXT PRIMARY KEY,
    integration_id TEXT NOT NULL,
    member_id TEXT,
    scope TEXT NOT NULL CHECK (scope IN ('membership', 'integration', 'custom')),
    storage_reference TEXT NOT NULL,
    credential_reference_json TEXT NOT NULL,
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'retained', 'deleting', 'deleted')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE overlays (
    id TEXT PRIMARY KEY,
    provider_state_id TEXT NOT NULL REFERENCES provider_state(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    digest TEXT NOT NULL,
    ownership_manifest_reference TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (provider_state_id, revision)
  ) STRICT;

  CREATE TABLE native_sessions (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL,
    integration_id TEXT NOT NULL,
    provider_kind TEXT NOT NULL,
    source TEXT NOT NULL,
    ref_kind TEXT NOT NULL CHECK (ref_kind IN ('id', 'path')),
    ref_value TEXT NOT NULL,
    dedupe_hash TEXT NOT NULL UNIQUE,
    observed_model TEXT,
    reporter_instance_id TEXT,
    source_sequence INTEGER NOT NULL DEFAULT 0 CHECK (source_sequence >= 0),
    run_id TEXT NOT NULL REFERENCES runs(id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    status TEXT NOT NULL CHECK (status IN ('ready', 'reserved', 'resumed', 'invalid')),
    reported_at TEXT NOT NULL,
    last_resumed_at TEXT,
    resume_run_id TEXT,
    reserved_at TEXT
  ) STRICT;

  CREATE TABLE models (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    desired_model TEXT,
    effective_model TEXT NOT NULL,
    source TEXT NOT NULL,
    observed_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE trust (
    id TEXT PRIMARY KEY,
    repository_id TEXT REFERENCES repositories(id),
    repository_identity TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    subject_digest TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('trusted', 'denied', 'revoked')),
    decided_at TEXT NOT NULL,
    revoked_at TEXT
  ) STRICT;

  CREATE UNIQUE INDEX trust_repository_subject ON trust (repository_identity, subject_digest, decided_at);

  CREATE TABLE terminal_checkpoints (
    id TEXT PRIMARY KEY,
    owner_principal_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    terminal_binding_json TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    line_count INTEGER NOT NULL CHECK (line_count >= 0),
    byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
    truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
    sensitivity_policy TEXT NOT NULL CHECK (sensitivity_policy IN ('repository-private', 'encrypted')),
    storage_reference TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    deleted_at TEXT,
    deletion_audit_id TEXT,
    CHECK ((deleted_at IS NULL AND deletion_audit_id IS NULL) OR (deleted_at IS NOT NULL AND deletion_audit_id IS NOT NULL))
  ) STRICT;

  CREATE TABLE extensions (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    digest TEXT NOT NULL UNIQUE,
    manifest_json TEXT NOT NULL,
    trust_id TEXT REFERENCES trust(id),
    state TEXT NOT NULL,
    installed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE domain_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  ) STRICT;

  CREATE TABLE idempotency_keys (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    request_digest TEXT,
    response_json TEXT NOT NULL,
    event_sequence INTEGER NOT NULL REFERENCES domain_events(sequence),
    created_at TEXT NOT NULL,
    invalidated_at TEXT,
    PRIMARY KEY (scope, key)
  ) STRICT;

  CREATE TABLE audits (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    principal_id TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE retention_metadata (
    domain TEXT PRIMARY KEY,
    oldest_sequence INTEGER,
    retained_count INTEGER NOT NULL CHECK (retained_count >= 0),
    policy_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX deliveries_dispatch ON deliveries (status, next_attempt_at, lease_expires_at, updated_at);
  CREATE INDEX deliveries_recipient_status ON deliveries (recipient_member_id, status);
  CREATE INDEX events_aggregate ON domain_events (aggregate_type, aggregate_id, sequence);
  CREATE INDEX runtime_observations_run_sequence ON runtime_observations (run_id, generation, sequence);
  CREATE INDEX status_progress_reports_run_time ON status_progress_reports (run_id, generation, reported_at);
  CREATE INDEX terminal_checkpoints_owner_expiry ON terminal_checkpoints (owner_principal_id, expires_at);
`;
