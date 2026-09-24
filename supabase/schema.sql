-- PrepBank database schema for Supabase (Postgres)
-- Run this in your Supabase project: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Safe to re-run any time you update this file (e.g. after pulling a new
-- version from Claude) -- it only creates what's missing and replaces
-- policies/functions rather than erroring if they already exist.

create extension if not exists pgcrypto;

-- One row per signed-up user (mirrors auth.users, but readable/joinable by the app)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  email text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.profiles add column if not exists is_admin boolean not null default false;

-- A class/subject, e.g. "AP World History - Mr. Smith"
create table if not exists public.classes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subject text not null,
  teacher text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

-- A generated practice test for a class. Questions live in jsonb columns
-- rather than separate tables, since a whole test is always read/written together.
create table if not exists public.tests (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  title text not null,
  created_by uuid references public.profiles(id),
  is_free boolean not null default false,
  question_count int not null default 0,
  questions jsonb not null default '[]'::jsonb,   -- multiple-choice + short-answer questions
  flashcards jsonb not null default '[]'::jsonb,  -- term/definition pairs
  source_note text,                                -- short label for what the test was made from
  created_at timestamptz not null default now()
);

-- Placeholder subscription state. status starts 'free'; the app's demo
-- "Unlock" button flips it to 'active'. Swap in real Stripe webhooks later
-- to set this instead (see README.md).
create table if not exists public.subscriptions (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  status text not null default 'free' check (status in ('free', 'active')),
  plan text,
  unlocked_at timestamptz
);

-- A student's completed practice run, kept private to them.
create table if not exists public.attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  test_id uuid not null references public.tests(id) on delete cascade,
  mode text not null check (mode in ('study', 'test')),
  score numeric,
  total int,
  answers jsonb,
  completed_at timestamptz not null default now()
);

-- Row Level Security -----------------------------------------------------

alter table public.profiles enable row level security;
alter table public.classes enable row level security;
alter table public.tests enable row level security;
alter table public.subscriptions enable row level security;
alter table public.attempts enable row level security;

-- Helper: is the signed-in user an admin? security definer so it can read
-- profiles regardless of the caller's own row visibility, and to avoid any
-- recursive-RLS surprises when used inside other tables' policies.
create or replace function public.is_admin_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- profiles: everyone signed in can see display names (to show "added by X"),
-- but you can only create/edit your own row.
drop policy if exists "profiles readable by signed-in users" on public.profiles;
create policy "profiles readable by signed-in users" on public.profiles
  for select using (auth.uid() is not null);
drop policy if exists "users insert their own profile" on public.profiles;
create policy "users insert their own profile" on public.profiles
  for insert with check (auth.uid() = id);
drop policy if exists "users update their own profile" on public.profiles;
create policy "users update their own profile" on public.profiles
  for update using (auth.uid() = id);
-- Column-level lock: users may only change their own display_name, never
-- is_admin (otherwise anyone could make themselves an admin from the browser).
-- Profile rows are created by the signup trigger below, not by the browser.
revoke insert, update on public.profiles from anon, authenticated;
grant update (display_name) on public.profiles to authenticated;

-- classes: any signed-in student can browse and add a class; admins can
-- edit or delete any class (used by the in-app Admin page).
drop policy if exists "classes readable by signed-in users" on public.classes;
create policy "classes readable by signed-in users" on public.classes
  for select using (auth.uid() is not null);
drop policy if exists "signed-in users create classes" on public.classes;
create policy "signed-in users create classes" on public.classes
  for insert with check (auth.uid() is not null and created_by = auth.uid());
drop policy if exists "admins manage classes" on public.classes;
create policy "admins manage classes" on public.classes
  for all using (public.is_admin_user()) with check (public.is_admin_user());

-- tests: readable if it's marked free, you made it, or you have an active
-- subscription. This is the real (server-side) paywall enforcement, even
-- though the subscription itself is just a demo toggle for now. Admins can
-- read/edit/delete any test regardless (used by the Admin page).
drop policy if exists "free or unlocked tests are readable" on public.tests;
create policy "free or unlocked tests are readable" on public.tests
  for select using (
    is_free = true
    or created_by = auth.uid()
    or exists (
      select 1 from public.subscriptions s
      where s.user_id = auth.uid() and s.status = 'active'
    )
  );
drop policy if exists "signed-in users add tests" on public.tests;
create policy "signed-in users add tests" on public.tests
  for insert with check (auth.uid() is not null and created_by = auth.uid());
drop policy if exists "admins manage tests" on public.tests;
create policy "admins manage tests" on public.tests
  for all using (public.is_admin_user()) with check (public.is_admin_user());

-- subscriptions: only visible/editable by their own owner.
drop policy if exists "users see their own subscription" on public.subscriptions;
create policy "users see their own subscription" on public.subscriptions
  for select using (auth.uid() = user_id);
drop policy if exists "users create their own subscription row" on public.subscriptions;
create policy "users create their own subscription row" on public.subscriptions
  for insert with check (auth.uid() = user_id);
drop policy if exists "users update their own subscription" on public.subscriptions;
create policy "users update their own subscription" on public.subscriptions
  for update using (auth.uid() = user_id);

-- attempts: private practice history, per student.
drop policy if exists "users see their own attempts" on public.attempts;
create policy "users see their own attempts" on public.attempts
  for select using (auth.uid() = user_id);
drop policy if exists "users record their own attempts" on public.attempts;
create policy "users record their own attempts" on public.attempts
  for insert with check (auth.uid() = user_id);

-- Auto-provision a profile + free subscription row whenever someone signs up.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, display_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    new.email
  );
  insert into public.subscriptions (user_id, status) values (new.id, 'free');
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Make yourself an admin (see the Admin page in the app). Run this once,
-- after you've signed up on the live site, replacing the email below --
-- it's safe to re-run this whole file afterwards, this line just re-applies.
-- update public.profiles set is_admin = true where email = 'you@example.com';
