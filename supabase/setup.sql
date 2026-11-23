-- =====================================================================
-- Backstock List: database setup
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run again if something goes wrong the first time.
-- =====================================================================

-- ---------- Tables ----------------------------------------------------

-- One row per team member (their display name).
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  created_at   timestamptz not null default now()
);

-- Open backstock requests. Rows are deleted as soon as they are closed.
create table if not exists public.items (
  id           uuid primary key default gen_random_uuid(),
  name         text check (char_length(name) <= 120),
  location     text not null check (char_length(location) between 1 and 60),
  note         text check (char_length(note) <= 300),
  photo_path   text,
  status       text not null default 'open' check (status in ('open', 'hold')),
  hold_note    text check (char_length(hold_note) <= 200),
  held_by      uuid references public.profiles (id) on delete set null,
  notify_found boolean not null default false,
  reported_by  uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Messages for the person who reported an item ("found it" / "can't get it").
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  outcome    text not null check (outcome in ('found', 'unavailable')),
  title      text not null,
  body       text not null,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

-- Team-wide settings (a single row). Admins change these from the app.
--   join_code: store code required to join (null = anyone with the link can join)
--   admin_password_hash: the shared admin password, stored hashed
-- Set the first admin password (see README):
--   update public.team_settings
--     set admin_password_hash = extensions.crypt('your-password', extensions.gen_salt('bf'))
--     where id = 1;
create extension if not exists pgcrypto with schema extensions;
create table if not exists public.team_settings (
  id        int primary key default 1 check (id = 1),
  join_code text
);
alter table public.team_settings add column if not exists admin_password_hash text;
insert into public.team_settings (id) values (1) on conflict (id) do nothing;

-- Admins are people who unlocked admin mode with the admin password.
alter table public.profiles add column if not exists is_admin boolean not null default false;

-- Each phone that turned on push notifications.
create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

-- Locations the team added from the Report screen (shown after the ones in config.js).
create table if not exists public.locations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 60),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists locations_name_idx on public.locations (lower(name));

-- ---------- Row Level Security -----------------------------------------
-- People sign in anonymously (just their name). You're a team member once
-- you've joined with join_team() below, which creates your profile.
-- Only members can see or change anything.

-- True if the signed-in person has joined (has a profile).
create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid());
$$;

alter table public.profiles           enable row level security;
alter table public.items              enable row level security;
alter table public.notifications      enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.team_settings      enable row level security; -- no policies: never readable from the app
alter table public.locations          enable row level security;

drop policy if exists "team reads locations" on public.locations;
create policy "team reads locations" on public.locations
  for select to authenticated using (public.is_member());
drop policy if exists "team adds locations" on public.locations;
create policy "team adds locations" on public.locations
  for insert to authenticated with check (public.is_member() and created_by = auth.uid());

drop policy if exists "team reads profiles" on public.profiles;
create policy "team reads profiles" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_member());
drop policy if exists "create own profile" on public.profiles; -- profiles are created by join_team() only
drop policy if exists "edit own profile" on public.profiles;
create policy "edit own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "team reads items" on public.items;
create policy "team reads items" on public.items
  for select to authenticated using (public.is_member());
drop policy if exists "team reports items" on public.items;
create policy "team reports items" on public.items
  for insert to authenticated with check (public.is_member() and reported_by = auth.uid());
drop policy if exists "team updates items" on public.items;
create policy "team updates items" on public.items
  for update to authenticated using (public.is_member()) with check (public.is_member());
-- No delete policy: items are closed through close_item() below.

drop policy if exists "read own notifications" on public.notifications;
create policy "read own notifications" on public.notifications
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "dismiss own notifications" on public.notifications;
create policy "dismiss own notifications" on public.notifications
  for delete to authenticated using (user_id = auth.uid());

drop policy if exists "read own subscriptions" on public.push_subscriptions;
create policy "read own subscriptions" on public.push_subscriptions
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "remove own subscriptions" on public.push_subscriptions;
create policy "remove own subscriptions" on public.push_subscriptions
  for delete to authenticated using (user_id = auth.uid());

-- Table access for signed-in users only (nothing for anonymous visitors).
revoke all on public.profiles, public.items, public.notifications, public.push_subscriptions, public.team_settings from anon;
revoke all on public.team_settings from authenticated;
revoke insert on public.profiles from authenticated;
revoke update on public.profiles from authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated; -- people can't make themselves admin
grant select, insert, update on public.items to authenticated;
grant select, delete on public.notifications to authenticated;
grant select, delete on public.push_subscriptions to authenticated;
revoke all on public.locations from anon;
grant select, insert (name) on public.locations to authenticated;

-- ---------- Functions --------------------------------------------------

-- Join the team (or change your name). Checks the store code if one is set.
create or replace function public.join_team(p_name text, p_code text default null)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  required text;
  nm       text := trim(p_name);
  prof     public.profiles;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if nm is null or char_length(nm) not between 1 and 40 then
    raise exception 'Name must be 1 to 40 characters';
  end if;

  select nullif(trim(join_code), '') into required from public.team_settings where id = 1;
  if required is not null and not public.is_member() then
    if nullif(trim(p_code), '') is null then
      raise exception 'STORE_CODE_REQUIRED';
    end if;
    if lower(trim(p_code)) <> lower(required) then
      perform pg_sleep(1); -- slow down guessing
      raise exception 'WRONG_STORE_CODE';
    end if;
  end if;

  insert into public.profiles (id, display_name) values (auth.uid(), nm)
  on conflict (id) do update set display_name = excluded.display_name
  returning * into prof;
  return prof;
end;
$$;

-- ---------- Admin mode ----------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- Enter the admin password to make this phone's profile an admin.
create or replace function public.unlock_admin(p_password text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  h text;
begin
  if not public.is_member() then
    raise exception 'Join the team first';
  end if;
  select admin_password_hash into h from public.team_settings where id = 1;
  if h is null then
    raise exception 'ADMIN_PASSWORD_NOT_SET';
  end if;
  if p_password is null or extensions.crypt(p_password, h) <> h then
    perform pg_sleep(1); -- slow down guessing
    raise exception 'WRONG_ADMIN_PASSWORD';
  end if;
  update public.profiles set is_admin = true where id = auth.uid();
end;
$$;

-- Give up admin on this phone.
create or replace function public.lock_admin()
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles set is_admin = false where id = auth.uid();
$$;

-- What admins see in Settings.
create or replace function public.get_admin_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;
  return jsonb_build_object(
    'join_code', (select join_code from public.team_settings where id = 1),
    'admins', (select coalesce(jsonb_agg(display_name order by display_name), '[]'::jsonb)
               from public.profiles where is_admin)
  );
end;
$$;

-- Turn the store code on/change it (pass a code) or off (pass null or '').
create or replace function public.set_join_code(p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  code text := nullif(trim(p_code), '');
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;
  if code is not null and char_length(code) not between 3 and 40 then
    raise exception 'Store code must be 3 to 40 characters';
  end if;
  update public.team_settings set join_code = code where id = 1;
end;
$$;

create or replace function public.set_admin_password(p_password text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;
  if p_password is null or char_length(p_password) < 8 then
    raise exception 'Admin password must be at least 8 characters';
  end if;
  update public.team_settings
    set admin_password_hash = extensions.crypt(p_password, extensions.gen_salt('bf'))
    where id = 1;
end;
$$;

-- If the admin password leaked: remove admin from everyone except you.
create or replace function public.reset_other_admins()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;
  update public.profiles set is_admin = false where is_admin and id <> auth.uid();
end;
$$;

-- Remove someone from the team. Their open requests are removed too.
-- Returns their photo paths so the app can delete the files.
create or replace function public.remove_member(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  paths jsonb;
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'You can''t remove yourself. Use "Leave on this phone" instead.';
  end if;
  select coalesce(jsonb_agg(photo_path) filter (where photo_path is not null), '[]'::jsonb)
    into paths from public.items where reported_by = p_user_id;
  delete from public.notifications where user_id = p_user_id;
  delete from public.push_subscriptions where user_id = p_user_id;
  delete from public.profiles where id = p_user_id; -- also deletes their open items
  return paths;
end;
$$;

-- ---------- Items ----------

-- Close an item: notify the reporter if needed, then delete it.
-- p_outcome: 'found' | 'unavailable' | 'cancelled' (reporter withdraws it)
create or replace function public.close_item(p_item_id uuid, p_outcome text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  it        public.items;
  closer    text;
  item_name text;
begin
  if not public.is_member() then
    raise exception 'Join the team first';
  end if;
  if p_outcome not in ('found', 'unavailable', 'cancelled') then
    raise exception 'Unknown outcome %', p_outcome;
  end if;

  select * into it from public.items where id = p_item_id for update;
  if not found then
    return jsonb_build_object('closed', false);  -- someone else already closed it
  end if;

  if p_outcome = 'cancelled' and it.reported_by <> auth.uid() then
    raise exception 'Only the person who reported an item can cancel it';
  end if;

  select display_name into closer from public.profiles where id = auth.uid();
  closer    := coalesce(closer, 'A teammate');
  item_name := coalesce(nullif(trim(it.name), ''), 'Item in ' || it.location);

  -- Don't notify people about items they closed themselves.
  if it.reported_by <> auth.uid() then
    if p_outcome = 'unavailable' then
      insert into public.notifications (user_id, outcome, title, body)
      values (it.reported_by, 'unavailable',
              'Can''t get: ' || item_name,
              closer || ': ' || coalesce(nullif(trim(p_reason), ''), 'No reason given') || ' (' || it.location || ')');
    elsif p_outcome = 'found' and it.notify_found then
      insert into public.notifications (user_id, outcome, title, body)
      values (it.reported_by, 'found',
              'Found: ' || item_name,
              closer || ' found it (' || it.location || ')');
    end if;
  end if;

  delete from public.items where id = p_item_id;
  return jsonb_build_object('closed', true, 'photo_path', it.photo_path);
end;
$$;

-- Save this phone's push subscription for the signed-in user.
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_member() then
    raise exception 'Join the team first';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
end;
$$;

-- "Send me a test notification" button in Settings.
create or replace function public.send_test_notification()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_member() then
    raise exception 'Join the team first';
  end if;
  insert into public.notifications (user_id, outcome, title, body)
  values (auth.uid(), 'found', 'Test notification', 'Notifications are working on this phone.');
end;
$$;

revoke all on function public.close_item(uuid, text, text) from public, anon;
revoke all on function public.save_push_subscription(text, text, text) from public, anon;
revoke all on function public.send_test_notification() from public, anon;
revoke all on function public.is_admin() from public, anon;
revoke all on function public.unlock_admin(text) from public, anon;
revoke all on function public.lock_admin() from public, anon;
revoke all on function public.get_admin_settings() from public, anon;
revoke all on function public.set_join_code(text) from public, anon;
revoke all on function public.set_admin_password(text) from public, anon;
revoke all on function public.reset_other_admins() from public, anon;
revoke all on function public.remove_member(uuid) from public, anon;
grant execute on function public.remove_member(uuid) to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.unlock_admin(text) to authenticated;
grant execute on function public.lock_admin() to authenticated;
grant execute on function public.get_admin_settings() to authenticated;
grant execute on function public.set_join_code(text) to authenticated;
grant execute on function public.set_admin_password(text) to authenticated;
grant execute on function public.reset_other_admins() to authenticated;
revoke all on function public.join_team(text, text) from public, anon;
revoke all on function public.is_member() from public, anon;
grant execute on function public.join_team(text, text) to authenticated;
grant execute on function public.is_member() to authenticated;
grant execute on function public.close_item(uuid, text, text) to authenticated;
grant execute on function public.save_push_subscription(text, text, text) to authenticated;
grant execute on function public.send_test_notification() to authenticated;

-- ---------- Photo storage ----------------------------------------------
-- Private bucket: photos are only viewable by team members.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tags', 'tags', false, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "team views tag photos" on storage.objects;
create policy "team views tag photos" on storage.objects
  for select to authenticated using (bucket_id = 'tags' and public.is_member());
drop policy if exists "team uploads tag photos" on storage.objects;
create policy "team uploads tag photos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'tags' and public.is_member() and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "team deletes tag photos" on storage.objects;
create policy "team deletes tag photos" on storage.objects
  for delete to authenticated using (bucket_id = 'tags' and public.is_member());

-- ---------- Live updates -----------------------------------------------

do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and tablename = 'items') then
    alter publication supabase_realtime add table public.items;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and tablename = 'notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;
