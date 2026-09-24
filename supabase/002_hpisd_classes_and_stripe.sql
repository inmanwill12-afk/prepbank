-- PrepBank upgrade 2: HPISD course catalog, admin-only classes,
-- official vs student tests, and real Stripe billing.
-- Run in Supabase -> SQL Editor after schema.sql. Safe to re-run.

-- ---------------------------------------------------------------------
-- Classes: department + level, and only admins can create classes
-- ---------------------------------------------------------------------
alter table public.classes add column if not exists level text;       -- On-Level | Honors | AP | Dual Credit | Elective
alter table public.classes add column if not exists sort_order int not null default 0;

create or replace function public.guard_classes()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') and not public.is_admin_user() then
    raise exception 'Only PrepBank admins can add or change classes.';
  end if;
  return coalesce(new, old);
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'guard_classes_trg') then
    create trigger guard_classes_trg before insert or update on public.classes
      for each row execute function public.guard_classes();
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Tests: "official" = published by an admin. Students can't fake it.
-- ---------------------------------------------------------------------
alter table public.tests add column if not exists is_official boolean not null default false;

create or replace function public.guard_tests()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') and not public.is_admin_user() then
    if tg_op = 'INSERT' then
      new.is_official := false;
    else
      new.is_official := old.is_official;
    end if;
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'guard_tests_trg') then
    create trigger guard_tests_trg before insert or update on public.tests
      for each row execute function public.guard_tests();
  end if;
end $$;

-- Keep the legacy sync trigger from overriding is_free (is_free is the source of truth)
create or replace function public.tests_sync()
returns trigger language plpgsql as $$
begin
  new.is_free := coalesce(new.is_free, false);
  new.is_premium := not new.is_free;
  new.question_count := coalesce(new.question_count, jsonb_array_length(coalesce(new.questions, '[]'::jsonb)));
  new.flashcards := coalesce(new.flashcards, '[]'::jsonb);
  return new;
end $$;

-- Test counts per class for the browse page (no question content exposed)
create or replace view public.class_test_counts with (security_invoker = false) as
  select class_id,
         count(*)::int as test_count,
         count(*) filter (where is_official)::int as official_count
  from public.tests group by class_id;
grant select on public.class_test_counts to authenticated;

-- ---------------------------------------------------------------------
-- Subscriptions: only Stripe (via the server) can turn PrepBank+ on
-- ---------------------------------------------------------------------
alter table public.subscriptions add column if not exists stripe_customer_id text;
alter table public.subscriptions add column if not exists stripe_subscription_id text;
alter table public.subscriptions add column if not exists current_period_end timestamptz;

create or replace function public.guard_subscriptions()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Browser users (anon/authenticated) can never grant themselves PrepBank+.
  -- The Stripe webhook uses the service role, which skips this check.
  if coalesce(auth.role(), '') in ('anon', 'authenticated') and not public.is_admin_user() then
    if tg_op = 'INSERT' then
      new.status := 'free';
      new.stripe_customer_id := null;
      new.stripe_subscription_id := null;
    else
      new.status := old.status;
      new.stripe_customer_id := old.stripe_customer_id;
      new.stripe_subscription_id := old.stripe_subscription_id;
      new.current_period_end := old.current_period_end;
    end if;
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'guard_subscriptions_trg') then
    create trigger guard_subscriptions_trg before insert or update on public.subscriptions
      for each row execute function public.guard_subscriptions();
  end if;
end $$;

-- The old demo unlock is retired now that Stripe exists
create or replace function public.demo_unlock()
returns void language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Demo unlock is disabled. Subscribe through Stripe instead.';
end $$;

-- profiles.is_premium is admin-granted only; the RLS helper reads Stripe status too
create or replace function public.is_premium()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_premium or is_admin from public.profiles where id = auth.uid()), false)
      or exists (select 1 from public.subscriptions where user_id = auth.uid() and status = 'active');
$$;

-- New signups get a profile + a free subscription row (owner email becomes admin)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name, is_admin)
  values (
    new.id, new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    lower(new.email) = 'inmanwill12@gmail.com'
  ) on conflict (id) do nothing;
  insert into public.subscriptions (user_id, status) values (new.id, 'free')
  on conflict (user_id) do nothing;
  return new;
end $$;

-- Backfill subscription rows for existing users
insert into public.subscriptions (user_id, status)
select p.id, 'free' from public.profiles p
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------
-- HPISD / Highland Park High School course catalog (2026-27 Academic
-- Planning Guide). TAG sections are merged into their Honors/AP class.
-- Performance-only electives (PE, athletics, band, choir, etc.) are skipped.
-- ---------------------------------------------------------------------
insert into public.classes (name, subject, level, sort_order)
select v.name, v.subject, v.level, v.ord
from (values
  -- English
  ('English I', 'English', 'On-Level', 100),
  ('English I Honors', 'English', 'Honors', 101),
  ('English II', 'English', 'On-Level', 102),
  ('English II Honors', 'English', 'Honors', 103),
  ('English III', 'English', 'On-Level', 104),
  ('AP English Language and Composition', 'English', 'AP', 105),
  ('English IV', 'English', 'On-Level', 106),
  ('AP English Literature and Composition', 'English', 'AP', 107),
  ('English IV Dual Credit', 'English', 'Dual Credit', 108),
  ('Academic Decathlon', 'English', 'Elective', 109),
  -- Math
  ('Algebra I', 'Math', 'On-Level', 200),
  ('Geometry', 'Math', 'On-Level', 201),
  ('Geometry Honors', 'Math', 'Honors', 202),
  ('Algebra II', 'Math', 'On-Level', 203),
  ('Algebra II Honors', 'Math', 'Honors', 204),
  ('Pre-Calculus', 'Math', 'On-Level', 205),
  ('Pre-Calculus Honors', 'Math', 'Honors', 206),
  ('AP Calculus AB', 'Math', 'AP', 207),
  ('AP Calculus BC', 'Math', 'AP', 208),
  ('Multivariable Calculus', 'Math', 'Elective', 209),
  ('Linear Algebra', 'Math', 'Elective', 210),
  ('AP Statistics', 'Math', 'AP', 211),
  ('Mathematical Models with Applications', 'Math', 'On-Level', 212),
  ('Advanced Quantitative Reasoning', 'Math', 'On-Level', 213),
  -- Science
  ('Biology I', 'Science', 'On-Level', 300),
  ('Biology I Honors', 'Science', 'Honors', 301),
  ('Integrated Physics and Chemistry (IPC)', 'Science', 'On-Level', 302),
  ('Chemistry I', 'Science', 'On-Level', 303),
  ('Chemistry I Honors', 'Science', 'Honors', 304),
  ('Physics I', 'Science', 'On-Level', 305),
  ('Physics I Honors', 'Science', 'Honors', 306),
  ('AP Biology', 'Science', 'AP', 307),
  ('AP Chemistry', 'Science', 'AP', 308),
  ('AP Physics 1', 'Science', 'AP', 309),
  ('AP Physics 2', 'Science', 'AP', 310),
  ('AP Physics C', 'Science', 'AP', 311),
  ('AP Environmental Science', 'Science', 'AP', 312),
  ('Anatomy and Physiology', 'Science', 'Elective', 313),
  ('Medical Microbiology / Pathophysiology', 'Science', 'Elective', 314),
  ('Organic Chemistry', 'Science', 'Elective', 315),
  ('Forensic Science', 'Science', 'Elective', 316),
  ('Astronomy', 'Science', 'Elective', 317),
  ('Aquatic Science', 'Science', 'Elective', 318),
  ('Earth and Space Science', 'Science', 'Elective', 319),
  -- Social Studies
  ('World Geography', 'Social Studies', 'On-Level', 400),
  ('World Geography Honors', 'Social Studies', 'Honors', 401),
  ('AP Human Geography', 'Social Studies', 'AP', 402),
  ('World History', 'Social Studies', 'On-Level', 403),
  ('AP World History', 'Social Studies', 'AP', 404),
  ('United States History', 'Social Studies', 'On-Level', 405),
  ('AP United States History', 'Social Studies', 'AP', 406),
  ('United States Government', 'Social Studies', 'On-Level', 407),
  ('AP United States Government', 'Social Studies', 'AP', 408),
  ('AP Comparative Government', 'Social Studies', 'AP', 409),
  ('Economics', 'Social Studies', 'On-Level', 410),
  ('AP Macroeconomics', 'Social Studies', 'AP', 411),
  ('AP European History', 'Social Studies', 'AP', 412),
  ('Psychology', 'Social Studies', 'Elective', 413),
  ('AP Psychology', 'Social Studies', 'AP', 414),
  ('Forensic Psychology', 'Social Studies', 'Elective', 415),
  ('Sociology', 'Social Studies', 'Elective', 416),
  -- Languages
  ('Spanish I', 'Languages', 'On-Level', 500),
  ('Spanish II', 'Languages', 'On-Level', 501),
  ('Spanish III', 'Languages', 'On-Level', 502),
  ('Spanish IV', 'Languages', 'On-Level', 503),
  ('AP Spanish Language and Culture', 'Languages', 'AP', 504),
  ('French I', 'Languages', 'On-Level', 510),
  ('French II', 'Languages', 'On-Level', 511),
  ('French III', 'Languages', 'On-Level', 512),
  ('French IV', 'Languages', 'On-Level', 513),
  ('AP French Language and Culture', 'Languages', 'AP', 514),
  ('Latin I', 'Languages', 'On-Level', 520),
  ('Latin II', 'Languages', 'On-Level', 521),
  ('Latin III', 'Languages', 'On-Level', 522),
  ('Latin IV', 'Languages', 'On-Level', 523),
  ('AP Latin', 'Languages', 'AP', 524),
  ('Chinese I', 'Languages', 'On-Level', 530),
  ('Chinese II', 'Languages', 'On-Level', 531),
  ('Chinese III', 'Languages', 'On-Level', 532),
  ('Chinese IV', 'Languages', 'On-Level', 533),
  ('AP Chinese Language and Culture', 'Languages', 'AP', 534),
  -- Computer Science, Business & Engineering
  ('Computer Science Principles', 'CS & Business', 'On-Level', 600),
  ('AP Computer Science Principles', 'CS & Business', 'AP', 601),
  ('Computer Science I', 'CS & Business', 'On-Level', 602),
  ('AP Computer Science A', 'CS & Business', 'AP', 603),
  ('Cybersecurity', 'CS & Business', 'Elective', 604),
  ('Engineering Design and Presentation', 'CS & Business', 'Elective', 605),
  ('Introduction to Business', 'CS & Business', 'Elective', 610),
  ('Business Management', 'CS & Business', 'Elective', 611),
  ('Accounting I', 'CS & Business', 'Elective', 612),
  ('Accounting II', 'CS & Business', 'Elective', 613),
  ('Marketing I', 'CS & Business', 'Elective', 614),
  ('Marketing II', 'CS & Business', 'Elective', 615),
  ('Personal Financial Literacy', 'CS & Business', 'Elective', 616),
  -- Health
  ('Health Education', 'Health', 'On-Level', 700)
) as v(name, subject, level, ord)
where not exists (select 1 from public.classes c where lower(c.name) = lower(v.name));
