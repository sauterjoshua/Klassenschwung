-- =====================================================================
-- Klassenschwung – Migration 0011: Registrierung nur mit Einladungslink
-- =====================================================================
-- Ein Konto kann nur anlegen, wer einen Einladungslink bekommen hat
-- (app.html?einladung=<code>). Jeder Link gilt einmal und 14 Tage.
--
-- Geprueft wird in der Datenbank (Trigger vor dem Anlegen in auth.users),
-- nicht nur in der App: Ein signUp ueber die API ohne gueltigen Code
-- schlaegt fehl. Einladungen per Supabase-Dashboard ("Invite user")
-- gehen weiterhin; "Add user" dagegen nicht mehr.
--
-- Nach dem Ausfuehren:
--   1. Sich selbst als Admin eintragen (eigene E-Mail einsetzen):
--        insert into public.admins (auth_user_id)
--        select id from auth.users where email = 'DEINE@MAIL.DE';
--   2. Supabase-Dashboard -> Authentication -> Sign In / Providers:
--      "Allow new users to sign up" EINschalten.
-- Danach erscheint in der App unter Einstellungen die Karte
-- "Einladungen", mit der sich Links erstellen lassen.
--
-- Idempotent: kann mehrfach ausgefuehrt werden.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tabellen (ohne Policies: Zugriff nur ueber die Funktionen unten)
-- ---------------------------------------------------------------------

create table if not exists public.admins (
  auth_user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

create table if not exists public.invites (
  code       text primary key default replace(gen_random_uuid()::text, '-', ''),
  -- Eigene Notiz der einladenden Person, z. B. fuer wen der Link ist
  note       text not null default '' check (char_length(note) <= 80),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  used_at    timestamptz,
  -- Ohne Fremdschluessel: beim Einloesen existiert der Nutzer noch nicht.
  used_by    uuid
);
alter table public.invites enable row level security;
revoke all on public.invites from anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Funktionen fuer Admins
-- ---------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where auth_user_id = auth.uid());
$$;

create or replace function public.create_invite(p_note text default '')
returns public.invites
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.invites;
begin
  if not public.is_admin() then
    raise exception 'Nur Admins können einladen.' using errcode = '42501';
  end if;
  insert into public.invites (note)
  values (left(btrim(coalesce(p_note, '')), 80))
  returning * into v_invite;
  return v_invite;
end;
$$;

create or replace function public.list_invites()
returns setof public.invites
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Nur Admins können Einladungen sehen.' using errcode = '42501';
  end if;
  return query select * from public.invites order by created_at desc limit 100;
end;
$$;

-- Nur offene Einladungen lassen sich zurueckziehen.
create or replace function public.delete_invite(p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Nur Admins können Einladungen löschen.' using errcode = '42501';
  end if;
  delete from public.invites where code = p_code and used_at is null;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Link pruefen (auch ohne Anmeldung), damit die App vor dem
--    Registrieren sagen kann, ob der Link noch gilt.
--    Ergebnis: 'ok' | 'used' | 'expired' | 'unknown'
-- ---------------------------------------------------------------------

create or replace function public.invite_status(p_code text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select case
              when used_at is not null then 'used'
              when expires_at < now() then 'expired'
              else 'ok'
            end
       from public.invites where code = p_code),
    'unknown');
$$;

revoke execute on function public.is_admin()           from public;
revoke execute on function public.create_invite(text)  from public;
revoke execute on function public.list_invites()       from public;
revoke execute on function public.delete_invite(text)  from public;
revoke execute on function public.invite_status(text)  from public;
grant  execute on function public.is_admin()           to authenticated;
grant  execute on function public.create_invite(text)  to authenticated;
grant  execute on function public.list_invites()       to authenticated;
grant  execute on function public.delete_invite(text)  to authenticated;
grant  execute on function public.invite_status(text)  to anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Beim Anlegen eines Nutzers: Einladung pruefen und einloesen.
--    Die App schickt den Code in den user_metadata ("invite") mit.
-- ---------------------------------------------------------------------

create or replace function public.require_invite()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code   text := nullif(btrim(new.raw_user_meta_data ->> 'invite'), '');
  v_invite public.invites;
begin
  -- Einladung ueber das Supabase-Dashboard ("Invite user")
  if new.invited_at is not null then
    return new;
  end if;

  if v_code is null then
    raise exception 'Registrierung nur mit Einladungslink.' using errcode = '42501';
  end if;

  select * into v_invite from public.invites where code = v_code for update;
  if not found or v_invite.used_at is not null or v_invite.expires_at < now() then
    raise exception 'Einladungslink ungültig, abgelaufen oder schon benutzt.' using errcode = '42501';
  end if;

  update public.invites set used_at = now(), used_by = new.id where code = v_code;
  new.raw_user_meta_data := new.raw_user_meta_data - 'invite';
  return new;
end;
$$;

revoke execute on function public.require_invite() from public;

drop trigger if exists require_invite on auth.users;
create trigger require_invite
  before insert on auth.users
  for each row execute function public.require_invite();
