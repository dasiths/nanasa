import {
  PROVIDER_PLATFORM_SCHEMA_SQL,
  PROVIDER_UPDATE_TRANSITION_SCHEMA_SQL,
} from "./provider-platform-schema.js";

export const DATABASE_SCHEMA_VERSION = 15;

export const DATABASE_MIGRATION_14_TO_15_SQL = `
  ALTER TABLE groups ADD COLUMN checkout_id TEXT REFERENCES checkouts(id);
  ALTER TABLE groups ADD COLUMN checkout_revision INTEGER NOT NULL DEFAULT 0
    CHECK (checkout_revision >= 0);

  UPDATE groups
  SET checkout_id = (
    SELECT MIN(m.checkout_id)
    FROM memberships m
    WHERE m.group_id = groups.id
      AND m.state = 'active'
      AND m.checkout_id IS NOT NULL
  )
  WHERE (
    SELECT COUNT(DISTINCT m.checkout_id)
    FROM memberships m
    WHERE m.group_id = groups.id
      AND m.state = 'active'
      AND m.checkout_id IS NOT NULL
  ) = 1
  AND (
    SELECT COUNT(*) = COUNT(m.checkout_id)
    FROM memberships m
    WHERE m.group_id = groups.id
      AND m.state = 'active'
  );
`;

export const DATABASE_MIGRATION_13_TO_14_SQL = `
  CREATE TABLE attention_subscription_overrides (
    operator_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
      'response-required', 'agent-health', 'completion', 'delivery-failure',
      'action-state', 'provider-update-failed', 'provider-update-succeeded', 'unread-message'
    )),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (operator_id, group_id, member_id, event_type)
  ) STRICT;

  CREATE INDEX attention_subscription_overrides_member
    ON attention_subscription_overrides (group_id, member_id, operator_id);
`;

export const DATABASE_MIGRATION_12_TO_13_SQL = `
  CREATE TABLE attention_dismissals (
    operator_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    dismissed_at TEXT NOT NULL,
    PRIMARY KEY (operator_id, item_id)
  ) STRICT;

  CREATE INDEX attention_dismissals_operator_recency
    ON attention_dismissals (operator_id, dismissed_at DESC);
`;

export const DATABASE_MIGRATION_11_TO_12_SQL = PROVIDER_UPDATE_TRANSITION_SCHEMA_SQL;

export const DATABASE_MIGRATION_10_TO_11_SQL = `
  ALTER TABLE trust
    ADD COLUMN subject_kind TEXT NOT NULL DEFAULT 'repository-launch'
    CHECK (subject_kind IN ('repository-launch', 'custom-provider-launch'));

  DROP INDEX trust_repository_subject;
  CREATE UNIQUE INDEX trust_repository_subject
    ON trust (subject_kind, repository_identity, subject_digest, decided_at);

  CREATE TABLE launch_consent_requests (
    id TEXT PRIMARY KEY,
    repository_identity TEXT NOT NULL,
    group_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    integration_id TEXT NOT NULL,
    subject_digest TEXT NOT NULL,
    config_revision TEXT NOT NULL,
    redacted_subject_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'cancelled', 'stale')),
    requested_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT,
    CHECK (
      (state = 'pending' AND decided_at IS NULL AND decided_by IS NULL) OR
      (state != 'pending' AND decided_at IS NOT NULL)
    )
  ) STRICT;

  CREATE UNIQUE INDEX launch_consent_requests_pending_subject
    ON launch_consent_requests (repository_identity, group_id, agent_id, subject_digest)
    WHERE state = 'pending';
  CREATE INDEX launch_consent_requests_repository_state
    ON launch_consent_requests (repository_identity, state, requested_at);
`;

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
    order_index INTEGER NOT NULL CHECK (order_index >= 0),
    membership_revision INTEGER NOT NULL CHECK (membership_revision >= 0),
    checkout_id TEXT REFERENCES checkouts(id),
    checkout_revision INTEGER NOT NULL DEFAULT 0 CHECK (checkout_revision >= 0),
    message_sequence INTEGER NOT NULL DEFAULT 0 CHECK (message_sequence >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE topology_order_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    order_revision INTEGER NOT NULL CHECK (order_revision >= 0)
  ) STRICT;

  INSERT INTO topology_order_state (singleton, order_revision) VALUES (1, 0);

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
    checkout_id TEXT REFERENCES checkouts(id),
    order_index INTEGER NOT NULL CHECK (order_index >= 0),
    state TEXT NOT NULL CHECK (state IN ('active', 'removed')),
    joined_at TEXT NOT NULL,
    removed_at TEXT,
    UNIQUE (group_id, member_id)
  ) STRICT;

  CREATE TABLE repositories (
    id TEXT PRIMARY KEY,
    common_directory TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    object_format TEXT NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
    ref_storage TEXT NOT NULL CHECK (ref_storage IN ('files', 'reftable')),
    primary_checkout_id TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE checkouts (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id),
    checkout_key TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL UNIQUE,
    git_directory TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('primary', 'linked', 'bare')),
    head TEXT,
    branch TEXT,
    dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
    observed_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE worktrees (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id),
    checkout_id TEXT NOT NULL UNIQUE REFERENCES checkouts(id),
    source_checkout_id TEXT NOT NULL REFERENCES checkouts(id),
    path TEXT NOT NULL UNIQUE,
    branch TEXT NOT NULL,
    base TEXT NOT NULL,
    provenance_token TEXT NOT NULL UNIQUE,
    operation_generation INTEGER NOT NULL CHECK (operation_generation > 0),
    state TEXT NOT NULL CHECK (state IN ('creating', 'ready', 'removing', 'removed', 'failed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE git_operations (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id),
    checkout_id TEXT REFERENCES checkouts(id),
    worktree_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('inspect', 'create-worktree', 'remove-worktree', 'refresh')),
    generation INTEGER NOT NULL CHECK (generation > 0),
    target_path TEXT,
    request_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    error_code TEXT
  ) STRICT;

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
    checkout_id TEXT REFERENCES checkouts(id),
    resolved_working_directory TEXT,
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
    UNIQUE (group_id, member_id, generation)
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
    provider_id TEXT NOT NULL,
    adapter_id TEXT NOT NULL,
    reporter_id TEXT NOT NULL,
    source TEXT NOT NULL,
    protocol_version INTEGER NOT NULL CHECK (protocol_version = 2),
    reporter_version TEXT NOT NULL,
    reporter_epoch TEXT NOT NULL,
    readiness_coverage TEXT NOT NULL CHECK (readiness_coverage IN ('full', 'partial', 'session_only')),
    source_sequence INTEGER NOT NULL DEFAULT 0 CHECK (source_sequence >= 0),
    native_session_id TEXT,
    process_fingerprint TEXT,
    opened_at TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    revoked_at TEXT,
    closed_at TEXT,
    UNIQUE (run_id, generation, reporter_epoch)
  ) STRICT;

  CREATE TABLE reporter_rejections (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT,
    generation INTEGER,
    reporter_epoch TEXT,
    source_sequence INTEGER,
    code TEXT NOT NULL,
    rejected_at TEXT NOT NULL
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

  CREATE TABLE completion_acknowledgements (
    operator_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id),
    generation INTEGER NOT NULL,
    completion_revision INTEGER NOT NULL CHECK (completion_revision >= 0),
    acknowledged_at TEXT NOT NULL,
    PRIMARY KEY (operator_id, run_id, generation)
  ) STRICT;

  CREATE TABLE attention_dismissals (
    operator_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    dismissed_at TEXT NOT NULL,
    PRIMARY KEY (operator_id, item_id)
  ) STRICT;

  CREATE INDEX attention_dismissals_operator_recency
    ON attention_dismissals (operator_id, dismissed_at DESC);

  CREATE TABLE attention_subscription_overrides (
    operator_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
      'response-required', 'agent-health', 'completion', 'delivery-failure',
      'action-state', 'provider-update-failed', 'provider-update-succeeded', 'unread-message'
    )),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (operator_id, group_id, member_id, event_type)
  ) STRICT;

  CREATE INDEX attention_subscription_overrides_member
    ON attention_subscription_overrides (group_id, member_id, operator_id);

  CREATE TABLE screen_observations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id),
    generation INTEGER NOT NULL,
    observed_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL
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
    kind TEXT NOT NULL CHECK (kind IN ('prompt', 'wait', 'wait-reply', 'cancel')),
    principal_json TEXT NOT NULL,
    group_id TEXT NOT NULL REFERENCES groups(id),
    member_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    daemon_epoch INTEGER NOT NULL CHECK (daemon_epoch > 0),
    reporter_session_id TEXT NOT NULL REFERENCES reporter_sessions(id),
    reporter_id TEXT NOT NULL,
    reporter_epoch TEXT NOT NULL,
    native_session_id TEXT,
    baseline_status_revision INTEGER NOT NULL CHECK (baseline_status_revision >= 0),
    baseline_completion_revision INTEGER NOT NULL CHECK (baseline_completion_revision >= 0),
    message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    conversation_id TEXT,
    reply_to_action_id TEXT REFERENCES actions(id) ON DELETE SET NULL,
    causation_id TEXT,
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    prompt TEXT,
    allow_working INTEGER NOT NULL CHECK (allow_working IN (0, 1)),
    state TEXT NOT NULL CHECK (state IN ('created', 'deferred', 'submitted', 'accepted', 'started', 'blocked', 'completed', 'settled-unverified', 'failed', 'stalled', 'timed-out', 'cancelled', 'expired', 'superseded', 'rejected')),
    queue_deadline_at TEXT NOT NULL,
    acceptance_deadline_at TEXT,
    completion_deadline_at TEXT,
    accepted_provider_turn_id TEXT,
    accepted_provider_request_id TEXT,
    result_json TEXT,
    error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (group_id, idempotency_key)
  ) STRICT;

  CREATE TABLE action_attempts (
    id TEXT PRIMARY KEY,
    action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL CHECK (attempt > 0),
    effect TEXT NOT NULL CHECK (effect IN ('provider-api', 'terminal-injection', 'logical-reply')),
    state TEXT NOT NULL CHECK (state IN ('submitting', 'submitted', 'failed', 'stalled', 'cancelled', 'superseded', 'rejected')),
    daemon_epoch INTEGER NOT NULL CHECK (daemon_epoch > 0),
    group_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    reporter_session_id TEXT NOT NULL REFERENCES reporter_sessions(id),
    reporter_id TEXT NOT NULL,
    reporter_epoch TEXT NOT NULL,
    native_session_id TEXT,
    baseline_status_revision INTEGER NOT NULL CHECK (baseline_status_revision >= 0),
    baseline_completion_revision INTEGER NOT NULL CHECK (baseline_completion_revision >= 0),
    terminal_binding_json TEXT NOT NULL,
    terminal_binding_fingerprint TEXT NOT NULL,
    provider_turn_id TEXT,
    provider_request_id TEXT,
    lease_owner TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    submitted_at TEXT,
    failure_code TEXT,
    UNIQUE (action_id, attempt)
  ) STRICT;

  CREATE TABLE action_acknowledgements (
    id TEXT PRIMARY KEY,
    action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES action_attempts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('accepted', 'started', 'blocked', 'completed', 'settled-unverified', 'failed', 'cancelled')),
    run_id TEXT NOT NULL REFERENCES runs(id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    reporter_session_id TEXT NOT NULL REFERENCES reporter_sessions(id),
    reporter_id TEXT NOT NULL,
    reporter_epoch TEXT NOT NULL,
    source_sequence INTEGER NOT NULL CHECK (source_sequence > 0),
    native_session_id TEXT,
    provider_turn_id TEXT,
    provider_request_id TEXT,
    completion_revision INTEGER NOT NULL CHECK (completion_revision >= 0),
    acknowledged_at TEXT NOT NULL,
    data_json TEXT NOT NULL,
    UNIQUE (reporter_session_id, source_sequence)
  ) STRICT;

  CREATE TABLE open_waits (
    id TEXT PRIMARY KEY,
    action_id TEXT REFERENCES actions(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL REFERENCES groups(id),
    member_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    reporter_session_id TEXT NOT NULL REFERENCES reporter_sessions(id),
    reporter_id TEXT NOT NULL,
    reporter_epoch TEXT NOT NULL,
    native_session_id TEXT,
    provider_request_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('permission', 'question', 'elicitation', 'plan_approval')),
    summary TEXT NOT NULL,
    reply_channel TEXT NOT NULL CHECK (reply_channel IN ('terminal', 'hook', 'rpc', 'acp', 'api')),
    opened_status_revision INTEGER NOT NULL CHECK (opened_status_revision >= 0),
    state TEXT NOT NULL CHECK (state IN ('open', 'replying', 'answered', 'expired', 'cancelled', 'superseded')),
    expires_at TEXT,
    opened_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    answered_at TEXT,
    UNIQUE (run_id, generation, reporter_epoch, provider_request_id)
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
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('repository-launch', 'custom-provider-launch')),
    subject_digest TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('trusted', 'denied', 'revoked')),
    decided_at TEXT NOT NULL,
    revoked_at TEXT
  ) STRICT;

  CREATE UNIQUE INDEX trust_repository_subject
    ON trust (subject_kind, repository_identity, subject_digest, decided_at);

  CREATE TABLE launch_consent_requests (
    id TEXT PRIMARY KEY,
    repository_identity TEXT NOT NULL,
    group_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    integration_id TEXT NOT NULL,
    subject_digest TEXT NOT NULL,
    config_revision TEXT NOT NULL,
    redacted_subject_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'cancelled', 'stale')),
    requested_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT,
    CHECK (
      (state = 'pending' AND decided_at IS NULL AND decided_by IS NULL) OR
      (state != 'pending' AND decided_at IS NOT NULL)
    )
  ) STRICT;

  CREATE UNIQUE INDEX launch_consent_requests_pending_subject
    ON launch_consent_requests (repository_identity, group_id, agent_id, subject_digest)
    WHERE state = 'pending';
  CREATE INDEX launch_consent_requests_repository_state
    ON launch_consent_requests (repository_identity, state, requested_at);

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
    content_digest TEXT NOT NULL,
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

  CREATE TABLE http_idempotency_keys (
    principal_id TEXT NOT NULL,
    route_id TEXT NOT NULL,
    key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('in-progress', 'completed')),
    status_code INTEGER CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (principal_id, route_id, key)
  ) STRICT;

  CREATE INDEX http_idempotency_expiry ON http_idempotency_keys (expires_at);

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
  CREATE INDEX reporter_sessions_run_epoch ON reporter_sessions (run_id, generation, reporter_epoch);
  CREATE INDEX reporter_rejections_run_sequence ON reporter_rejections (run_id, generation, sequence);
  CREATE INDEX screen_observations_run_sequence ON screen_observations (run_id, generation, sequence);
  CREATE INDEX status_progress_reports_run_time ON status_progress_reports (run_id, generation, reported_at);
  CREATE INDEX terminal_checkpoints_owner_expiry ON terminal_checkpoints (owner_principal_id, expires_at);
  CREATE INDEX messages_conversation_causation ON messages (group_id, conversation_id, hop, created_at);
  CREATE INDEX actions_group_state_deadline ON actions (group_id, state, queue_deadline_at, updated_at);
  CREATE INDEX actions_target ON actions (run_id, generation, reporter_epoch, state);
  CREATE INDEX actions_message ON actions (message_id);
  CREATE INDEX action_attempts_action_state ON action_attempts (action_id, state, attempt);
  CREATE INDEX action_acknowledgements_action_time ON action_acknowledgements (action_id, acknowledged_at);
  CREATE INDEX open_waits_group_state ON open_waits (group_id, state, updated_at);
  CREATE INDEX open_waits_target ON open_waits (run_id, generation, reporter_epoch, provider_request_id);
  ${PROVIDER_PLATFORM_SCHEMA_SQL}
`;
