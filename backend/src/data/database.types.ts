export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type TableDefinition<Row extends Record<string, unknown>> = {
  Row: Row;
  Insert: Partial<Row>;
  Update: Partial<Row>;
  Relationships: [];
};

type UserSettingsRow = {
  portal_id: string;
  user_id: string;
  display_name: string;
  access_active: boolean;
  permissions: string[];
  allowed_field_ids: string[];
  granted_at: string | null;
  granted_by_user_id: string | null;
  access_revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

type PortalRow = {
  id: string;
  display_name: string;
  created_at: string;
  updated_at: string;
};

type SavedFilterRow = {
  id: string;
  portal_id: string;
  owner_id: string;
  name: string;
  normalized_name: string;
  revision: number;
  filter_payload: Json;
  created_at: string;
  updated_at: string;
};

type OperationDraftRow = {
  id: string;
  portal_id: string;
  owner_id: string;
  revision: number;
  status: string;
  filter_snapshot: Json | null;
  sort_snapshot: Json | null;
  selected_task_ids: string[];
  changes: Json;
  preflight_snapshot: Json | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

type BulkOperationRow = {
  id: string;
  portal_id: string;
  operation_type: string;
  status: string;
  initiator_id: string;
  initiator_display_name: string;
  source_operation_id: string | null;
  idempotency_key: string;
  request_fingerprint: string;
  state_version: number;
  launch_attempt: number;
  filter_snapshot: Json | null;
  selected_task_ids: string[];
  changes: Json;
  preflight_snapshot: Json;
  cancel_requested_at: string | null;
  interruption_requested_at: string | null;
  interruption_reason_code: string | null;
  interruption_reason_message: string | null;
  selected_count: number;
  eligible_count: number;
  excluded_count: number;
  unchanged_count: number;
  successful_count: number;
  failed_count: number;
  unconfirmed_count: number;
  conflicted_count: number;
  partially_applied_count: number;
  not_processed_count: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  last_progress_at: string | null;
  completed_at: string | null;
};

type TaskProcessingResultRow = {
  id: string;
  operation_id: string;
  task_id: string;
  task_title: string | null;
  task_url: string | null;
  outcome: string;
  requested_field_ids: string[];
  applied_field_ids: string[];
  failed_field_ids: string[];
  reason_code: string | null;
  reason_message: string | null;
  correlation_id: string | null;
  can_retry: boolean;
  result_fingerprint: string;
  created_at: string;
  updated_at: string;
};

type TaskResultRefinementRow = {
  id: string;
  source_task_processing_result_id: string;
  outcome: string;
  applied_field_ids: string[];
  failed_field_ids: string[];
  reason_code: string | null;
  reason_message: string | null;
  can_retry: boolean;
  result_fingerprint: string;
  before_version: string | null;
  after_version: string | null;
  created_at: string;
};

type ProtectedTaskResultRow = {
  task_processing_result_id: string;
  ciphertext: string;
  nonce: string;
  key_version: string;
  payload_version: number;
  before_version: string;
  after_version: string;
  created_at: string;
};

type ReportRow = {
  id: string;
  operation_id: string;
  storage_status: string;
  active_until: string;
  archived_at: string | null;
  delete_after: string;
  created_at: string;
  updated_at: string;
};

type AuditEventRow = {
  id: string;
  portal_id: string;
  occurred_at: string;
  recorded_at: string;
  schema_version: number;
  action: string;
  actor_type: string;
  actor_id: string | null;
  actor_display_name: string;
  actor_source: string | null;
  subject_type: string;
  subject_id: string;
  subject_display_name: string;
  related_objects: Json;
  outcome: string;
  correlation_id: string;
  event_key: string;
  details: Json;
};

export interface Database {
  public: {
    Tables: {
      portal: TableDefinition<PortalRow>;
      user_settings: TableDefinition<UserSettingsRow>;
      saved_filter: TableDefinition<SavedFilterRow>;
      operation_draft: TableDefinition<OperationDraftRow>;
      bulk_operation: TableDefinition<BulkOperationRow>;
      task_processing_result: TableDefinition<TaskProcessingResultRow>;
      task_result_refinement: TableDefinition<TaskResultRefinementRow>;
      protected_task_result: TableDefinition<ProtectedTaskResultRow>;
      report: TableDefinition<ReportRow>;
      audit_event: TableDefinition<AuditEventRow>;
    };
    Views: Record<never, never>;
    Functions: {
      save_operation_draft: {
        Args: {
          p_portal_id: string;
          p_owner_id: string;
          p_expected_revision: number;
          p_status: string;
          p_filter_snapshot: Json | null;
          p_sort_snapshot: Json | null;
          p_selected_task_ids: string[];
          p_changes: Json;
          p_preflight_snapshot: Json | null;
          p_replace_expired?: boolean;
        };
        Returns: OperationDraftRow;
      };
      create_bulk_operation_idempotent: {
        Args: {
          p_portal_id: string;
          p_operation_type: string;
          p_initiator_id: string;
          p_initiator_display_name: string;
          p_source_operation_id: string | null;
          p_idempotency_key: string;
          p_filter_snapshot: Json | null;
          p_selected_task_ids: string[];
          p_changes: Json;
          p_preflight_snapshot: Json;
          p_selected_count: number;
          p_eligible_count: number;
          p_excluded_count: number;
          p_unchanged_count: number;
          p_correlation_id: string;
          p_initial_results?: Json;
        };
        Returns: Json;
      };
      start_bulk_operation_with_attempt: {
        Args: {
          p_portal_id: string;
          p_operation_id: string;
          p_expected_launch_attempt: number;
          p_correlation_id: string;
        };
        Returns: Json;
      };
      request_bulk_operation_cancellation: {
        Args: {
          p_portal_id: string;
          p_operation_id: string;
          p_correlation_id: string;
        };
        Returns: Json;
      };
      request_bulk_operation_interruption_with_attempt: {
        Args: {
          p_portal_id: string;
          p_operation_id: string;
          p_expected_launch_attempt: number;
          p_reason_code: string;
          p_reason_message: string;
          p_correlation_id: string;
        };
        Returns: Json;
      };
      finalize_bulk_operation_with_attempt: {
        Args: {
          p_portal_id: string;
          p_operation_id: string;
          p_expected_launch_attempt: number;
          p_correlation_id: string;
        };
        Returns: Json;
      };
      fail_bulk_operation_launch_with_attempt: {
        Args: {
          p_portal_id: string;
          p_operation_id: string;
          p_expected_launch_attempt: number;
          p_correlation_id: string;
        };
        Returns: Json;
      };
      retry_bulk_operation_launch: {
        Args: { p_portal_id: string; p_operation_id: string; p_correlation_id: string };
        Returns: Json;
      };
      record_task_processing_result_with_attempt: {
        Args: {
          p_portal_id: string;
          p_operation_id: string;
          p_expected_launch_attempt: number;
          p_task_id: string;
          p_task_title: string | null;
          p_task_url: string | null;
          p_outcome: string;
          p_requested_field_ids: string[];
          p_applied_field_ids: string[];
          p_failed_field_ids: string[];
          p_reason_code: string | null;
          p_reason_message: string | null;
          p_correlation_id: string | null;
          p_can_retry: boolean;
          p_protected_ciphertext?: string | null;
          p_protected_nonce?: string | null;
          p_protected_key_version?: string | null;
          p_protected_payload_version?: number | null;
          p_before_version?: string | null;
          p_after_version?: string | null;
        };
        Returns: Json;
      };
      record_task_result_refinement: {
        Args: {
          p_portal_id: string;
          p_operation_id: string;
          p_task_id: string;
          p_outcome: string;
          p_applied_field_ids: string[];
          p_failed_field_ids: string[];
          p_reason_code: string | null;
          p_reason_message: string | null;
          p_correlation_id: string;
          p_can_retry: boolean;
        };
        Returns: Json;
      };
      record_task_result_refinement_with_versions: {
        Args: {
          p_portal_id: string;
          p_operation_id: string;
          p_task_id: string;
          p_outcome: string;
          p_applied_field_ids: string[];
          p_failed_field_ids: string[];
          p_reason_code: string | null;
          p_reason_message: string | null;
          p_correlation_id: string;
          p_can_retry: boolean;
          p_before_version: string | null;
          p_after_version: string | null;
        };
        Returns: Json;
      };
      purge_integration_test_fixture: {
        Args: { p_portal_id: string };
        Returns: undefined;
      };
      append_audit_event: {
        Args: {
          p_portal_id: string;
          p_occurred_at: string;
          p_action: string;
          p_actor_type: string;
          p_actor_id: string | null;
          p_actor_display_name: string;
          p_actor_source: string | null;
          p_subject_type: string;
          p_subject_id: string;
          p_subject_display_name: string;
          p_related_objects: Json;
          p_outcome: string;
          p_correlation_id: string;
          p_deduplication_scope: string;
          p_event_slot: string;
          p_details: Json;
        };
        Returns: Json;
      };
      purge_expired_audit_events: {
        Args: {
          p_correlation_id: string;
          p_run_id: string;
        };
        Returns: Json;
      };
    };
  };
}

export type DatabaseTable<Name extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][Name]['Row'];
