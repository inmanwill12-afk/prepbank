-- PrepBank upgrade 5: clean up Supabase Security Advisor errors and warnings.
-- Nothing here changes what students can see or do in the app.

-- 1) Trigger functions run automatically; nobody needs to call them directly.
revoke execute on function public.filter_profiles() from public, anon, authenticated;
revoke execute on function public.filter_tests() from public, anon, authenticated;
revoke execute on function public.guard_classes() from public, anon, authenticated;
revoke execute on function public.guard_subscriptions() from public, anon, authenticated;
revoke execute on function public.guard_tests() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.tests_sync() from public, anon, authenticated;
alter function public.tests_sync() set search_path = public;

-- 2) Old "demo unlock" button from the first version of the site: turned off for everyone.
revoke execute on function public.demo_unlock() from public, anon, authenticated;

-- 3) Everything else is only for signed-in students.
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.is_admin_user() from public, anon;
revoke execute on function public.is_premium() from public, anon;
revoke execute on function public.leaderboard(int) from public, anon;
revoke execute on function public.my_stats() from public, anon;
revoke execute on function public.my_test_stats() from public, anon;
revoke execute on function public.set_display_name(text) from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_admin_user() to authenticated;
grant execute on function public.is_premium() to authenticated;
grant execute on function public.leaderboard(int) to authenticated;
grant execute on function public.my_stats() to authenticated;
grant execute on function public.my_test_stats() to authenticated;
grant execute on function public.set_display_name(text) to authenticated;
-- is_inappropriate stays callable before sign-in: the sign-up form uses it to check names.

-- 4) Class test counts: the view now runs as the student, and reads the counts
--    through a function that only returns numbers (never test content).
create or replace function public.class_test_counts_all()
returns table (class_id uuid, test_count int, official_count int)
language sql stable security definer set search_path = public as $$
  select t.class_id, count(*)::int, (count(*) filter (where t.is_official))::int
  from public.tests t group by t.class_id;
$$;
revoke execute on function public.class_test_counts_all() from public, anon;
grant execute on function public.class_test_counts_all() to authenticated;
create or replace view public.class_test_counts with (security_invoker = true) as
  select class_id, test_count, official_count from public.class_test_counts_all();
revoke all on public.class_test_counts from anon;
grant select on public.class_test_counts to authenticated;

-- 5) Old test_list view (unused since the redesign): make it respect normal permissions.
alter view public.test_list set (security_invoker = true);
revoke all on public.test_list from anon;

-- 6) Profile pictures: images still load for everyone by their link, but nobody
--    can list every file in the bucket. Students can see only their own folder.
drop policy if exists "avatars public read" on storage.objects;
drop policy if exists "avatars own read" on storage.objects;
create policy "avatars own read" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

select 'ok' as status;
