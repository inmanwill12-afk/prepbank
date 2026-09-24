-- PrepBank upgrade 4: list PrepBank+ tests (title, unit and counts only) to
-- everyone in a class, so locked tests show with a lock instead of vanishing.
-- Question and flashcard content stays protected by row level security.
create or replace function public.class_test_list(p_class uuid)
returns table (
  id uuid, class_id uuid, title text, unit int, is_official boolean, is_free boolean,
  created_by uuid, created_at timestamptz, question_count int,
  mc_count int, short_count int, flashcard_count int, author text
)
language sql stable security definer set search_path = public as $$
  select t.id, t.class_id, t.title, t.unit, t.is_official, t.is_free,
         t.created_by, t.created_at, t.question_count,
         (select count(*)::int from jsonb_array_elements(coalesce(t.questions, '[]'::jsonb)) q where q->>'type' = 'mc'),
         (select count(*)::int from jsonb_array_elements(coalesce(t.questions, '[]'::jsonb)) q where q->>'type' = 'short'),
         jsonb_array_length(coalesce(t.flashcards, '[]'::jsonb)),
         p.display_name
  from public.tests t
  left join public.profiles p on p.id = t.created_by
  where t.class_id = p_class and auth.uid() is not null
  order by t.created_at desc;
$$;
revoke execute on function public.class_test_list(uuid) from public, anon;
grant execute on function public.class_test_list(uuid) to authenticated;

select 'ok' as status;
