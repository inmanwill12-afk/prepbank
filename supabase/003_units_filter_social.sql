-- PrepBank upgrade 3: units, language filter, pins, profile pictures,
-- appearance settings, points and leaderboard. Safe to re-run.

-- ---------------------------------------------------------------------
-- Units: every test belongs to one unit of its class
-- ---------------------------------------------------------------------
alter table public.tests add column if not exists unit int;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tests_unit_range') then
    alter table public.tests add constraint tests_unit_range check (unit is null or unit between 0 and 20);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Language filter. Terms live in a table so admins can add more later.
-- 'word' = whole-word match; 'contains' = matches inside other words too.
-- Academic words (e.g. anatomy, history terms) are intentionally not listed.
-- ---------------------------------------------------------------------
create table if not exists public.banned_terms (
  term text primary key,
  match_type text not null default 'word' check (match_type in ('word', 'contains'))
);
alter table public.banned_terms enable row level security;
drop policy if exists "admins manage banned terms" on public.banned_terms;
create policy "admins manage banned terms" on public.banned_terms
  for all using (public.is_admin_user()) with check (public.is_admin_user());

insert into public.banned_terms (term, match_type) values
  ('fuck', 'contains'), ('shit', 'word'), ('shitty', 'word'), ('bullshit', 'word'), ('bitch', 'contains'),
  ('cunt', 'word'), ('cunts', 'word'), ('asshole', 'contains'), ('dick', 'word'), ('dickhead', 'word'), ('cock', 'word'),
  ('pussy', 'word'), ('slut', 'contains'), ('whore', 'contains'), ('motherfucker', 'contains'),
  ('nigger', 'contains'), ('nigga', 'contains'), ('faggot', 'contains'), ('fag', 'word'), ('retard', 'word'),
  ('retarded', 'word'), ('chink', 'word'), ('spic', 'word'), ('kike', 'word'), ('wetback', 'contains'),
  ('tranny', 'word'), ('dyke', 'word'), ('porn', 'contains'), ('porno', 'word'), ('dildo', 'contains'),
  ('jizz', 'contains'), ('cum', 'word'), ('boobs', 'word'), ('tits', 'word'), ('twat', 'word'),
  ('wanker', 'word'), ('kys', 'word'), ('kill yourself', 'contains'), ('go die', 'word'),
  ('heil hitler', 'contains'), ('hitler did nothing wrong', 'contains')
on conflict (term) do update set match_type = excluded.match_type;
delete from public.banned_terms where term = 'nazi';

create or replace function public.is_inappropriate(t text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  norm text;
  joined text := '';
  w text;
  prev_single boolean := false;
  r record;
begin
  if t is null or t = '' then return false; end if;
  -- lower-case, undo common leetspeak, turn punctuation into spaces
  norm := lower(t);
  norm := translate(norm, '013457@$!|', 'oieastasii');
  norm := regexp_replace(norm, '[^a-z ]+', ' ', 'g');
  norm := trim(regexp_replace(norm, '\s+', ' ', 'g'));
  -- join runs of single spaced letters ("f u c k" -> "fuck") without merging real words
  foreach w in array string_to_array(norm, ' ') loop
    if length(w) = 1 and prev_single then joined := joined || w;
    else joined := joined || ' ' || w; end if;
    prev_single := length(w) = 1;
  end loop;
  -- also collapse repeated letters ("fuuuck" -> "fuck")
  norm := ' ' || norm || ' ' || trim(joined) || ' ' || regexp_replace(trim(joined), '([a-z])\1+', '\1', 'g') || ' ';
  for r in select term, match_type from public.banned_terms loop
    if r.match_type = 'contains' then
      if position(r.term in norm) > 0 then return true; end if;
    else
      if position(' ' || r.term || ' ' in norm) > 0 then return true; end if;
    end if;
  end loop;
  return false;
end $$;
grant execute on function public.is_inappropriate(text) to anon, authenticated;

-- Tests with inappropriate language are rejected (not posted). Nobody is banned.
create or replace function public.filter_tests()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin_user() then return new; end if;
  if public.is_inappropriate(coalesce(new.title, '') || ' ' || coalesce(new.questions::text, '') || ' ' || coalesce(new.flashcards::text, '')) then
    raise exception 'PB_FILTER: this test contains language that is not allowed on PrepBank';
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'filter_tests_trg') then
    create trigger filter_tests_trg before insert or update on public.tests
      for each row execute function public.filter_tests();
  end if;
end $$;

-- Display names: rejected on edit; replaced with "Student" if used at sign-up
create or replace function public.filter_profiles()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_inappropriate(new.display_name) then
    if tg_op = 'INSERT' then
      new.display_name := 'Student';
    elsif new.display_name is distinct from old.display_name then
      raise exception 'PB_FILTER: that name is not allowed on PrepBank';
    end if;
  end if;
  new.display_name := left(trim(coalesce(new.display_name, 'Student')), 40);
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'filter_profiles_trg') then
    create trigger filter_profiles_trg before insert or update on public.profiles
      for each row execute function public.filter_profiles();
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Profile: picture and appearance settings
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists theme text not null default 'system';
alter table public.profiles add column if not exists accent text not null default 'scots';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_theme_check') then
    alter table public.profiles add constraint profiles_theme_check check (theme in ('system', 'light', 'dark'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_accent_check') then
    alter table public.profiles add constraint profiles_accent_check check (accent in ('scots', 'crimson', 'emerald', 'violet', 'teal', 'gold'));
  end if;
end $$;
-- Users may edit only these columns on their own row (is_admin etc. stay locked)
grant update (display_name, avatar_url, theme, accent) on public.profiles to authenticated;

-- Avatar storage: public images, each user writes only inside their own folder
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;
drop policy if exists "avatars public read" on storage.objects;
create policy "avatars public read" on storage.objects for select using (bucket_id = 'avatars');
drop policy if exists "avatars own upload" on storage.objects;
create policy "avatars own upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "avatars own update" on storage.objects;
create policy "avatars own update" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "avatars own delete" on storage.objects;
create policy "avatars own delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin_user()));

-- ---------------------------------------------------------------------
-- Pins (classes or tests)
-- ---------------------------------------------------------------------
create table if not exists public.pins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  class_id uuid references public.classes(id) on delete cascade,
  test_id uuid references public.tests(id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((class_id is null) <> (test_id is null))
);
create unique index if not exists pins_user_class on public.pins (user_id, class_id) where class_id is not null;
create unique index if not exists pins_user_test on public.pins (user_id, test_id) where test_id is not null;
alter table public.pins enable row level security;
drop policy if exists "users manage own pins" on public.pins;
create policy "users manage own pins" on public.pins
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Students can delete their own (non-official) tests from My Tests
drop policy if exists "authors delete own tests" on public.tests;
create policy "authors delete own tests" on public.tests
  for delete using (created_by = auth.uid() and not is_official);

-- ---------------------------------------------------------------------
-- Points: when other students practice your tests you earn points.
-- 10 points per student who tries a test + 1 per repeat (max 4 extra each),
-- so one person can't farm points for a friend. Official tests don't count.
-- ---------------------------------------------------------------------
create or replace function public.test_play_stats()
returns table (test_id uuid, author uuid, players bigint, plays bigint, points bigint)
language sql stable security definer set search_path = public as $$
  with per_player as (
    select a.test_id, t.created_by as author, a.user_id, count(*) as n
    from public.attempts a
    join public.tests t on t.id = a.test_id
    where not t.is_official and t.created_by is not null and a.user_id <> t.created_by
    group by a.test_id, t.created_by, a.user_id
  )
  select test_id, author, count(*) as players, sum(n)::bigint as plays,
         sum(10 + least(n, 5) - 1)::bigint as points
  from per_player group by test_id, author;
$$;
revoke execute on function public.test_play_stats() from public, anon, authenticated;

create or replace function public.leaderboard_all()
returns table (rank bigint, user_id uuid, display_name text, avatar_url text, points bigint, tests_published bigint, plays bigint)
language sql stable security definer set search_path = public as $$
  with pts as (
    select author, sum(points)::bigint as points, sum(plays)::bigint as plays
    from public.test_play_stats() group by author
  ),
  pub as (
    select created_by, count(*) as n from public.tests where not is_official group by created_by
  )
  select rank() over (order by coalesce(pts.points, 0) desc, coalesce(pub.n, 0) desc) as rank,
         p.id, p.display_name, p.avatar_url,
         coalesce(pts.points, 0), coalesce(pub.n, 0), coalesce(pts.plays, 0)
  from public.profiles p
  left join pts on pts.author = p.id
  left join pub on pub.created_by = p.id
  where coalesce(pub.n, 0) > 0;
$$;
revoke execute on function public.leaderboard_all() from public, anon, authenticated;

create or replace function public.leaderboard(max_rows int default 25)
returns table (rank bigint, user_id uuid, display_name text, avatar_url text, points bigint, tests_published bigint, plays bigint)
language sql stable security definer set search_path = public as $$
  select * from public.leaderboard_all() order by 1, 5 desc limit greatest(1, least(max_rows, 100));
$$;
grant execute on function public.leaderboard(int) to authenticated;

create or replace function public.my_stats()
returns table (points bigint, plays bigint, tests_published bigint, rank bigint)
language sql stable security definer set search_path = public as $$
  select coalesce(l.points, 0), coalesce(l.plays, 0), coalesce(l.tests_published, 0), l.rank
  from (select 1) x
  left join public.leaderboard_all() l on l.user_id = auth.uid();
$$;
grant execute on function public.my_stats() to authenticated;

create or replace function public.my_test_stats()
returns table (test_id uuid, players bigint, plays bigint, points bigint)
language sql stable security definer set search_path = public as $$
  select test_id, players, plays, points from public.test_play_stats() where author = auth.uid();
$$;
grant execute on function public.my_test_stats() to authenticated;

select 'ok' as status;
