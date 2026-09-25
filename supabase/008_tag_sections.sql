-- PrepBank upgrade 8: TAG sections. Classes whose TAG section teaches different material
-- (per the HPHS 2026-27 Academic Planning Guide) get a TAG tab, and tests can be marked TAG.
-- Safe to re-run.

alter table public.classes add column if not exists has_tag boolean not null default false;
alter table public.tests add column if not exists is_tag boolean not null default false;

-- TAG versions with different content: the Humanities pairing (English I + World Geography),
-- English II's interdisciplinary/independent studies, and the math courses with extra depth
-- (Geometry, Algebra II proofs, Pre-Calc's multivariable prep). Other TAG sections (AP courses,
-- Biology, Chemistry) cover the same material with a different teaching style, so they stay merged.
update public.classes set has_tag = true
where name in ('English I Honors', 'World Geography Honors', 'English II Honors',
               'Geometry Honors', 'Algebra II Honors', 'Pre-Calculus Honors');

-- The English II Honors official tests were made from the TAG section's Canvas course
update public.tests t set is_tag = true
from public.classes c
where c.id = t.class_id and c.name = 'English II Honors' and t.is_official;

-- Class listing includes the TAG flag so locked tests land in the right tab
drop function if exists public.class_test_list(uuid);
create function public.class_test_list(p_class uuid)
returns table (
  id uuid, class_id uuid, title text, unit int, is_official boolean, is_free boolean,
  created_by uuid, created_at timestamptz, question_count int,
  mc_count int, short_count int, flashcard_count int, author text, quality_score int, is_tag boolean
)
language sql stable security definer set search_path = public as $$
  select t.id, t.class_id, t.title, t.unit, t.is_official, t.is_free,
         t.created_by, t.created_at, t.question_count,
         (select count(*)::int from jsonb_array_elements(coalesce(t.questions, '[]'::jsonb)) q where q->>'type' = 'mc'),
         (select count(*)::int from jsonb_array_elements(coalesce(t.questions, '[]'::jsonb)) q where q->>'type' = 'short'),
         jsonb_array_length(coalesce(t.flashcards, '[]'::jsonb)),
         p.display_name, t.quality_score, t.is_tag
  from public.tests t
  left join public.profiles p on p.id = t.created_by
  where t.class_id = p_class and auth.uid() is not null
  order by t.created_at desc;
$$;
revoke execute on function public.class_test_list(uuid) from public, anon;
grant execute on function public.class_test_list(uuid) to authenticated;

select c.name, c.has_tag, count(t.id) filter (where t.is_tag) as tag_tests
from public.classes c left join public.tests t on t.class_id = c.id
where c.has_tag group by c.name, c.has_tag order by c.name;
