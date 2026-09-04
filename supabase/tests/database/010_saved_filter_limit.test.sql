begin;

select plan(2);

select has_trigger(
  'public',
  'saved_filter',
  'saved_filter_enforce_owner_limit',
  'saved-filter owner limit trigger exists'
);

insert into public.portal (id, display_name)
values ('saved-filter-limit', 'Saved filter limit');

insert into public.user_settings (portal_id, user_id, display_name, access_active)
values ('saved-filter-limit', '3001', 'Filter owner', true);

insert into public.saved_filter (portal_id, owner_id, name, filter_payload)
select 'saved-filter-limit', '3001', 'Filter ' || ordinal, '[]'::jsonb
from generate_series(1, 256) as ordinal;

select throws_ok(
  $$insert into public.saved_filter (portal_id, owner_id, name, filter_payload)
    values ('saved-filter-limit', '3001', 'Filter 257', '[]'::jsonb);$$,
  'P0001',
  'TC_SAVED_FILTER_LIMIT',
  'a user cannot create more than 256 saved filters'
);

select * from finish();
rollback;
