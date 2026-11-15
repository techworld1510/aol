-- =====================================================================
-- Seva Desk: Supabase database schema
-- Run this once in Supabase: Dashboard > SQL Editor > New query > Run.
-- It is safe to run again: every statement replaces or skips what exists.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

-- Shared documents. Each row is one item in a collection:
--   collection = 'posters'              shared posters, drafts and reviews
--   collection = 'data/shared/groups'   contact groups created by admins
create table if not exists public.documents (
  collection  text        not null,
  id          text        not null,
  data        jsonb       not null default '{}'::jsonb,
  created_by  uuid        default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (collection, id),
  constraint documents_size check (pg_column_size(data) <= 300000)
);

create index if not exists documents_collection_idx on public.documents (collection);

-- People who can manage shared groups and edit any published poster.
create table if not exists public.admins (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  added_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. Helper functions
-- ---------------------------------------------------------------------

-- Is the signed-in person an admin?
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- Merge two JSON objects, recursing into nested objects.
create or replace function public.jsonb_deep_merge(a jsonb, b jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  result jsonb;
  k text;
begin
  if a is null or jsonb_typeof(a) <> 'object' or b is null or jsonb_typeof(b) <> 'object' then
    return b;
  end if;
  result := a;
  for k in select jsonb_object_keys(b) loop
    if result ? k
       and jsonb_typeof(result -> k) = 'object'
       and jsonb_typeof(b -> k) = 'object' then
      result := jsonb_set(result, array[k], public.jsonb_deep_merge(result -> k, b -> k));
    else
      result := jsonb_set(result, array[k], b -> k);
    end if;
  end loop;
  return result;
end;
$$;

-- Keep updated_at current.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists documents_touch on public.documents;
create trigger documents_touch
  before update on public.documents
  for each row execute function public.touch_updated_at();

-- Partly update a document. Runs with the caller's permissions, so the
-- row level security rules below still apply.
create or replace function public.merge_document(p_collection text, p_id text, p_patch jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.documents
     set data = public.jsonb_deep_merge(data, p_patch)
   where collection = p_collection and id = p_id;
  if not found then
    raise exception 'not_found_or_not_allowed' using errcode = '42501';
  end if;
end;
$$;

-- Add or update the signed-in person's review on a poster.
-- Reviewers may only touch their own review, never the rest of the poster.
create or replace function public.add_review(p_id text, p_review jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  reviewer_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  review_key text;
begin
  if auth.uid() is null or reviewer_email = '' then
    raise exception 'not_signed_in' using errcode = '42501';
  end if;
  if jsonb_typeof(p_review) <> 'object' or pg_column_size(p_review) > 5000 then
    raise exception 'invalid_review' using errcode = '22023';
  end if;
  review_key := regexp_replace(reviewer_email, '[^a-z0-9]', '_', 'g');
  update public.documents
     set data = jsonb_set(
                  data,
                  '{reviews}',
                  coalesce(data -> 'reviews', '{}'::jsonb) || jsonb_build_object(review_key, p_review)
                )
   where collection = 'posters' and id = p_id;
  if not found then
    raise exception 'not_found' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Row level security
-- ---------------------------------------------------------------------
alter table public.documents enable row level security;
alter table public.admins    enable row level security;

-- Anyone signed in can read shared documents.
drop policy if exists documents_read on public.documents;
create policy documents_read on public.documents
  for select to authenticated
  using (true);

-- Anyone signed in can create posters; only admins can create shared groups.
drop policy if exists documents_insert on public.documents;
create policy documents_insert on public.documents
  for insert to authenticated
  with check (
    case when collection like 'data/shared/%' then public.is_admin()
         else true end
  );

-- Creators can change their own items; admins can change anything.
drop policy if exists documents_update on public.documents;
create policy documents_update on public.documents
  for update to authenticated
  using (
    case when collection like 'data/shared/%' then public.is_admin()
         else created_by = auth.uid() or public.is_admin() end
  )
  with check (
    case when collection like 'data/shared/%' then public.is_admin()
         else created_by = auth.uid() or public.is_admin() end
  );

-- Creators can delete their own items; admins can delete anything.
drop policy if exists documents_delete on public.documents;
create policy documents_delete on public.documents
  for delete to authenticated
  using (
    case when collection like 'data/shared/%' then public.is_admin()
         else created_by = auth.uid() or public.is_admin() end
  );

-- People can see only their own admin row (the app calls is_admin()).
drop policy if exists admins_read_own on public.admins;
create policy admins_read_own on public.admins
  for select to authenticated
  using (user_id = auth.uid());
-- No insert/update/delete policies: admins are managed in the dashboard
-- or the SQL editor only (see docs/BACKEND_SETUP.md, step 7).

grant execute on function public.is_admin()                        to authenticated;
grant execute on function public.merge_document(text, text, jsonb) to authenticated;
grant execute on function public.add_review(text, jsonb)           to authenticated;
revoke execute on function public.add_review(text, jsonb)           from anon;
revoke execute on function public.merge_document(text, text, jsonb) from anon;

-- ---------------------------------------------------------------------
-- 4. Live updates (so new posters and reviews appear without reloading)
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'documents'
  ) then
    alter publication supabase_realtime add table public.documents;
  end if;
end;
$$;
