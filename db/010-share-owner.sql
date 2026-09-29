-- Who owns a shared page, so the hub can tell a link from a publication.
--
-- Sharing opened to everybody on 13 Sep, and at that moment the two readers
-- below stopped being able to answer the only question that matters about a
-- shared page: whose is it. Without it, one person's shared link would be fed
-- to another person's website, which is the bug the old single-publisher gate
-- was standing in for.
--
-- So both readers return the owner. The routes decide: the feed carries only
-- the account with a site connected, and the hub's own copy is never indexed
-- by anyone, because the indexed copy is the site's.
drop function if exists hq_published(text);
create or replace function hq_published(p_slug text)
returns table (id uuid, user_id uuid, title text, storage_key text,
               published_at timestamptz, produced_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  return query
  select d.id, d.user_id, d.title, d.storage_key, d.published_at, d.produced_at
    from documents d
   where d.public_slug = p_slug
     and d.published_at is not null;
end $$;
revoke all on function hq_published(text) from public;
grant execute on function hq_published(text) to hq_app;

drop function if exists hq_published_all();
create or replace function hq_published_all()
returns table (public_slug text, user_id uuid, title text, storage_key text,
               published_at timestamptz, produced_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  return query
  select d.public_slug, d.user_id, d.title, d.storage_key, d.published_at, d.produced_at
    from documents d
   where d.published_at is not null and d.public_slug is not null
   order by d.published_at desc
   limit 5000;
end $$;
revoke all on function hq_published_all() from public;
grant execute on function hq_published_all() to hq_app;
