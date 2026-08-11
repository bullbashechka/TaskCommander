export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

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
  filter_snapshot: Json | null;
  selected_task_ids: string[];
  changes: Json;
  preflight_snapshot: Json;
  cancel_requested_at: string | null;
  interruption_reason_code: string | null;
  interruption_reason_message: string | null;
  selected_count: number;
  eligible_count: number;
  excluded_count: number;
  unchanged_count: number;
  successful_count: number;
  failed_count: number;
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
  created_at: string;
  updated_at: string;
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
  action: string;
  actor_id: string | null;
  actor_display_name: string | null;
  subject_type: string | null;
  subject_id: string | null;
  outcome: string;
  correlation_id: string | null;
  metadata: Json;
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
      transition_bulk_operation_status: {
        Args: {
          p_portal_id: string;
          p_operation_id: string;
          p_expected_statuses: string[];
          p_next_status: string;
          p_mark_started?: boolean;
          p_touch_progress?: boolean;
          p_mark_completed?: boolean;
        };
        Returns: BulkOperationRow;
      };
      record_task_processing_result: {
        Args: {
          p_portal_id: string;
          p_operation_id: string;
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
    };
  };
}

export type DatabaseTable<Name extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][Name]['Row'];
