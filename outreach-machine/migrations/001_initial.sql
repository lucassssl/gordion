BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE system_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  globally_paused boolean NOT NULL DEFAULT true,
  pause_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT 'system'
);

INSERT INTO system_control (singleton, globally_paused, pause_reason)
VALUES (true, true, 'Safe default: live outreach has not been activated');

CREATE TABLE mailbox_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('simulated', 'microsoft_graph')),
  auth_mode text NOT NULL CHECK (auth_mode IN ('simulated', 'app_only', 'delegated')),
  tenant_id uuid,
  mailbox_object_id uuid,
  sender_address citext NOT NULL,
  sender_display_name text,
  status text NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('disconnected', 'testing', 'ready', 'error', 'disabled')),
  last_auth_check_at timestamptz,
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    provider = 'simulated'
    OR (tenant_id IS NOT NULL AND mailbox_object_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX mailbox_connections_sender_unique
  ON mailbox_connections (sender_address)
  WHERE status <> 'disabled';

CREATE TRIGGER mailbox_connections_updated_at
BEFORE UPDATE ON mailbox_connections
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  normalized_name text NOT NULL,
  domain citext,
  website text,
  country_code char(2),
  fit_tier char(1) CHECK (fit_tier IN ('A', 'B', 'C')),
  execution_evidence text,
  execution_evidence_url text,
  researched_at timestamptz,
  review_status text NOT NULL DEFAULT 'needs_review'
    CHECK (review_status IN ('needs_review', 'eligible', 'rejected', 'suppressed')),
  review_note text,
  reviewed_at timestamptz,
  reviewed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX companies_domain_unique
  ON companies (domain)
  WHERE domain IS NOT NULL;
CREATE INDEX companies_review_status_idx ON companies (review_status, fit_tier);

CREATE TRIGGER companies_updated_at
BEFORE UPDATE ON companies
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  email citext NOT NULL UNIQUE,
  first_name text,
  last_name text,
  role_title text,
  target_role text,
  source_url text NOT NULL,
  source_checked_at timestamptz NOT NULL,
  outreach_basis text,
  review_status text NOT NULL DEFAULT 'needs_review'
    CHECK (review_status IN ('needs_review', 'eligible', 'rejected', 'suppressed')),
  review_note text,
  reviewed_at timestamptz,
  reviewed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email::text = lower(email::text))
);

CREATE INDEX contacts_company_idx ON contacts (company_id);
CREATE INDEX contacts_review_status_idx ON contacts (review_status);

CREATE TRIGGER contacts_updated_at
BEFORE UPDATE ON contacts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE suppression_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('email', 'domain', 'company')),
  normalized_value citext NOT NULL,
  reason text NOT NULL CHECK (reason IN (
    'unsubscribe', 'bounce', 'complaint', 'legal', 'already_contacted',
    'customer', 'manual', 'invalid', 'other'
  )),
  note text,
  active boolean NOT NULL DEFAULT true,
  source_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  revoked_at timestamptz,
  revoked_by text,
  CHECK ((active AND revoked_at IS NULL) OR (NOT active AND revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX suppression_entries_active_unique
  ON suppression_entries (scope, normalized_value)
  WHERE active;

CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  mailbox_connection_id uuid NOT NULL REFERENCES mailbox_connections(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'paused', 'active', 'completed', 'archived')),
  timezone text NOT NULL DEFAULT 'Europe/Berlin',
  business_weekdays smallint[] NOT NULL DEFAULT ARRAY[1,2,3,4,5],
  send_window_start time NOT NULL DEFAULT '09:00',
  send_window_end time NOT NULL DEFAULT '16:30',
  daily_initial_limit smallint NOT NULL DEFAULT 10 CHECK (daily_initial_limit BETWEEN 0 AND 100),
  daily_total_limit smallint NOT NULL DEFAULT 15 CHECK (daily_total_limit BETWEEN 1 AND 200),
  followup_workday_offsets smallint[] NOT NULL DEFAULT ARRAY[3,8],
  max_followups smallint NOT NULL DEFAULT 2 CHECK (max_followups BETWEEN 0 AND 4),
  approval_mode text NOT NULL DEFAULT 'each_message'
    CHECK (approval_mode IN ('each_message', 'reviewed_batch')),
  legal_review_reference text,
  live_send_enabled boolean NOT NULL DEFAULT false,
  activated_at timestamptz,
  activated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (daily_initial_limit <= daily_total_limit),
  CHECK (send_window_start < send_window_end),
  CHECK (cardinality(business_weekdays) > 0)
);

CREATE INDEX campaigns_status_idx ON campaigns (status);

CREATE TRIGGER campaigns_updated_at
BEFORE UPDATE ON campaigns
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step_index smallint NOT NULL CHECK (step_index BETWEEN 0 AND 4),
  version integer NOT NULL CHECK (version > 0),
  subject_template text NOT NULL,
  body_text_template text NOT NULL,
  required_variables text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  approved_at timestamptz,
  approved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, step_index, version)
);

CREATE UNIQUE INDEX message_templates_current_approved_unique
  ON message_templates (campaign_id, step_index)
  WHERE status = 'approved';

CREATE TABLE enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'active', 'paused', 'replied', 'bounced', 'unsubscribed',
      'booked', 'completed', 'cancelled'
    )),
  stop_reason text,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, contact_id)
);

CREATE UNIQUE INDEX enrollments_one_company_per_campaign_active
  ON enrollments (campaign_id, company_id)
  WHERE status IN ('pending', 'active', 'paused');
CREATE INDEX enrollments_contact_status_idx ON enrollments (contact_id, status);

CREATE TRIGGER enrollments_updated_at
BEFORE UPDATE ON enrollments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id uuid NOT NULL REFERENCES enrollments(id) ON DELETE RESTRICT,
  template_id uuid REFERENCES message_templates(id) ON DELETE RESTRICT,
  sequence_index smallint NOT NULL CHECK (sequence_index BETWEEN 0 AND 4),
  message_kind text NOT NULL CHECK (message_kind IN ('initial', 'followup')),
  idempotency_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN (
      'planned', 'rendered', 'awaiting_approval', 'approved', 'leased',
      'draft_created', 'send_accepted', 'sent_confirmed',
      'reconciliation_required', 'failed', 'cancelled'
    )),
  recipient_address citext NOT NULL,
  final_subject text,
  final_body_text text,
  content_sha256 char(64),
  due_at timestamptz NOT NULL,
  approved_at timestamptz,
  approved_by text,
  approval_content_sha256 char(64),
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  graph_message_id text,
  internet_message_id text,
  graph_conversation_id text,
  graph_request_id text,
  send_accepted_at timestamptz,
  sent_confirmed_at timestamptz,
  last_error_code text,
  last_error_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, sequence_index),
  CHECK (
    status IN ('planned', 'cancelled')
    OR (final_subject IS NOT NULL AND final_body_text IS NOT NULL AND content_sha256 IS NOT NULL)
  ),
  CHECK (
    status NOT IN ('approved', 'leased', 'draft_created', 'send_accepted', 'sent_confirmed')
    OR (approved_at IS NOT NULL AND approved_by IS NOT NULL AND approval_content_sha256 = content_sha256)
  )
);

CREATE INDEX messages_due_idx ON messages (due_at, id)
  WHERE status IN ('approved', 'draft_created');
CREATE INDEX messages_graph_id_idx ON messages (graph_message_id)
  WHERE graph_message_id IS NOT NULL;

CREATE TRIGGER messages_updated_at
BEFORE UPDATE ON messages
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE send_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  message_id uuid NOT NULL UNIQUE REFERENCES messages(id) ON DELETE RESTRICT,
  business_date date NOT NULL,
  message_kind text NOT NULL CHECK (message_kind IN ('initial', 'followup')),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'consumed', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  released_at timestamptz
);

CREATE INDEX send_reservations_limit_idx
  ON send_reservations (campaign_id, business_date, state, message_kind);

CREATE TABLE delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN (
    'create_draft', 'send_draft', 'confirm_sent', 'reconcile', 'create_followup_draft'
  )),
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'uncertain', 'throttled')),
  provider_request_id text,
  provider_status integer,
  error_code text,
  error_detail text,
  retry_after_seconds integer,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX delivery_attempts_message_idx ON delivery_attempts (message_id, occurred_at DESC);

CREATE TABLE graph_sync_cursors (
  mailbox_connection_id uuid NOT NULL REFERENCES mailbox_connections(id) ON DELETE CASCADE,
  folder_name text NOT NULL CHECK (folder_name IN ('inbox', 'sentitems', 'drafts')),
  delta_link text,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mailbox_connection_id, folder_name)
);

CREATE TABLE graph_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_connection_id uuid NOT NULL REFERENCES mailbox_connections(id) ON DELETE CASCADE,
  graph_subscription_id text UNIQUE,
  resource text NOT NULL,
  change_type text NOT NULL,
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'renewal_due', 'expired', 'error', 'disabled')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER graph_subscriptions_updated_at
BEFORE UPDATE ON graph_subscriptions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE inbound_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_connection_id uuid NOT NULL REFERENCES mailbox_connections(id) ON DELETE RESTRICT,
  graph_message_id text NOT NULL,
  internet_message_id text,
  graph_conversation_id text,
  sender_address citext,
  subject text,
  received_at timestamptz,
  classification text NOT NULL DEFAULT 'unclassified'
    CHECK (classification IN (
      'unclassified', 'reply', 'positive_reply', 'negative_reply', 'out_of_office',
      'bounce', 'unsubscribe', 'unrelated', 'needs_review'
    )),
  matched_enrollment_id uuid REFERENCES enrollments(id) ON DELETE SET NULL,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox_connection_id, graph_message_id)
);

CREATE INDEX inbound_messages_unprocessed_idx
  ON inbound_messages (created_at)
  WHERE processed_at IS NULL;

CREATE TABLE graph_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id text NOT NULL,
  change_type text NOT NULL,
  resource text NOT NULL,
  resource_id text,
  tenant_id text,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (subscription_id, change_type, resource)
);

CREATE INDEX graph_notifications_unprocessed_idx
  ON graph_notifications (received_at)
  WHERE processed_at IS NULL;

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id uuid,
  event_type text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'system', 'microsoft_graph')),
  actor_id text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_entity_idx
  ON audit_events (entity_type, entity_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only';
END;
$$;

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (filename) VALUES ('001_initial.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
