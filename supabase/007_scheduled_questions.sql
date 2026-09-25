-- PrepBank upgrade 7: scheduled questions. Questions for readings that haven't been
-- assigned yet wait here and are added to their test automatically on their release date.
-- Safe to re-run.

create table if not exists public.scheduled_questions (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.tests(id) on delete cascade,
  release_at timestamptz not null,
  label text,
  questions jsonb not null default '[]'::jsonb,
  flashcards jsonb not null default '[]'::jsonb,
  released_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists scheduled_questions_due on public.scheduled_questions (release_at) where released_at is null;
-- Nobody can read upcoming questions from the app (no policies = no access)
alter table public.scheduled_questions enable row level security;
revoke all on public.scheduled_questions from public, anon, authenticated;

-- Adds every batch whose release time has passed. Multiple-choice questions stay
-- ahead of short-answer ones so the test keeps its usual order.
create or replace function public.release_scheduled_questions()
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select * from public.scheduled_questions
           where released_at is null and release_at <= now()
           order by release_at for update skip locked
  loop
    update public.tests t set
      questions = (
        select coalesce(jsonb_agg(e order by (e->>'type' = 'short'), src, ord), '[]'::jsonb)
        from (
          select e, 0 as src, ord from jsonb_array_elements(coalesce(t.questions, '[]'::jsonb)) with ordinality as a(e, ord)
          union all
          select e, 1 as src, ord from jsonb_array_elements(r.questions) with ordinality as b(e, ord)
        ) x),
      flashcards = coalesce(t.flashcards, '[]'::jsonb) || r.flashcards,
      question_count = jsonb_array_length(coalesce(t.questions, '[]'::jsonb)) + jsonb_array_length(r.questions)
    where t.id = r.test_id;
    update public.scheduled_questions set released_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.release_scheduled_questions() from public, anon, authenticated;

-- Check every 15 minutes
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
select cron.unschedule(jobid) from cron.job where jobname = 'prepbank-release-questions';
select cron.schedule('prepbank-release-questions', '*/15 * * * *', 'select public.release_scheduled_questions()');

select 'ok' as status;
