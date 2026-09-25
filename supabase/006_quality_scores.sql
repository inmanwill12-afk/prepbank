-- PrepBank upgrade 6: AI quality scores for tests, quality-based leaderboard points,
-- and quality info in the class listing. Safe to re-run.

-- 1) Quality score (0-100) and a one-line note, written only by the server's AI review
alter table public.tests add column if not exists quality_score int;
alter table public.tests add column if not exists quality_note text;
alter table public.tests add column if not exists reviewed_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tests_quality_range') then
    alter table public.tests add constraint tests_quality_range check (quality_score is null or quality_score between 0 and 100);
  end if;
end $$;

-- Students can't give their own test a score: only the server (service role) or an admin can set it
create or replace function public.guard_test_quality()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') and not public.is_admin_user() then
    if tg_op = 'INSERT' then
      new.quality_score := null; new.quality_note := null; new.reviewed_at := null;
    else
      new.quality_score := old.quality_score; new.quality_note := old.quality_note; new.reviewed_at := old.reviewed_at;
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.guard_test_quality() from public, anon, authenticated;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'guard_test_quality_trg') then
    create trigger guard_test_quality_trg before insert or update on public.tests
      for each row execute function public.guard_test_quality();
  end if;
end $$;

-- 2) Points: plays (10 per new student + up to 4 per repeat) PLUS a quality bonus.
--    A student test with 10+ questions scoring 50 or more earns half its score (up to 50 points).
create or replace function public.test_play_stats()
returns table (test_id uuid, author uuid, players bigint, plays bigint, points bigint)
language sql stable security definer set search_path = public as $$
  with per_player as (
    select a.test_id, a.user_id, count(*) as n
    from public.attempts a
    join public.tests t on t.id = a.test_id
    where not t.is_official and t.created_by is not null and a.user_id <> t.created_by
    group by a.test_id, a.user_id
  ),
  play as (
    select test_id, count(*) as players, sum(n)::bigint as plays, sum(10 + least(n, 5) - 1)::bigint as play_points
    from per_player group by test_id
  )
  select t.id, t.created_by, coalesce(p.players, 0), coalesce(p.plays, 0),
         (coalesce(p.play_points, 0)
          + case when t.quality_score >= 50 and t.question_count >= 10 then round(t.quality_score / 2.0) else 0 end)::bigint
  from public.tests t
  left join play p on p.test_id = t.id
  where not t.is_official and t.created_by is not null;
$$;
revoke execute on function public.test_play_stats() from public, anon, authenticated;

-- 3) Class listing now includes the quality score so locked tests can show their badge too
drop function if exists public.class_test_list(uuid);
create function public.class_test_list(p_class uuid)
returns table (
  id uuid, class_id uuid, title text, unit int, is_official boolean, is_free boolean,
  created_by uuid, created_at timestamptz, question_count int,
  mc_count int, short_count int, flashcard_count int, author text, quality_score int
)
language sql stable security definer set search_path = public as $$
  select t.id, t.class_id, t.title, t.unit, t.is_official, t.is_free,
         t.created_by, t.created_at, t.question_count,
         (select count(*)::int from jsonb_array_elements(coalesce(t.questions, '[]'::jsonb)) q where q->>'type' = 'mc'),
         (select count(*)::int from jsonb_array_elements(coalesce(t.questions, '[]'::jsonb)) q where q->>'type' = 'short'),
         jsonb_array_length(coalesce(t.flashcards, '[]'::jsonb)),
         p.display_name, t.quality_score
  from public.tests t
  left join public.profiles p on p.id = t.created_by
  where t.class_id = p_class and auth.uid() is not null
  order by t.created_at desc;
$$;
revoke execute on function public.class_test_list(uuid) from public, anon;
grant execute on function public.class_test_list(uuid) to authenticated;

select 'ok' as status;
