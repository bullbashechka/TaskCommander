begin;

do $$
begin
  if exists (
    select 1
    from public.saved_filter
    group by portal_id, owner_id
    having count(*) > 256
  ) then
    raise exception 'TC_SAVED_FILTER_LIMIT_LEGACY_ROWS';
  end if;
end;
$$;

create function public.enforce_saved_filter_owner_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.portal_id || ':' || new.owner_id, 0)
  );

  if (
    select count(*) >= 256
    from public.saved_filter
    where portal_id = new.portal_id
      and owner_id = new.owner_id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'TC_SAVED_FILTER_LIMIT';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_saved_filter_owner_limit() from public, anon, authenticated;

create trigger saved_filter_enforce_owner_limit
before insert on public.saved_filter
for each row execute function public.enforce_saved_filter_owner_limit();

commit;
