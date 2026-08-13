begin;

select plan(12);

\ir ../rollback/20260813000000_access_management_state.down.sql

select hasnt_table('public', 'access_field_set', 'access field sets are removed by rollback');
select hasnt_table('public', 'access_management_draft', 'access drafts are removed by rollback');
select hasnt_table('public', 'access_preflight', 'access preflights are removed by rollback');
select hasnt_table('public', 'access_command', 'access commands are removed by rollback');
select hasnt_table('public', 'access_command_dispatch_outbox', 'access command outbox is removed by rollback');
select hasnt_table('public', 'access_change', 'access changes are removed by rollback');
select hasnt_table('public', 'notification_outbox', 'notification outbox is removed by rollback');
select hasnt_function('public', 'save_access_draft', 'access draft RPC is removed by rollback');
select hasnt_function('public', 'create_access_preflight', 'access preflight RPC is removed by rollback');
select hasnt_function('public', 'accept_access_command', 'access command accept RPC is removed by rollback');
select hasnt_function('public', 'apply_access_command_target', 'access target apply RPC is removed by rollback');
select hasnt_function('public', 'finalize_access_command', 'access command finalization RPC is removed by rollback');

select * from finish();

rollback;
