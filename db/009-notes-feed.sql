-- The notes feed: published pages as records, for the site that renders them.
--
-- `hq_published_all` returned a slug and a date, which is all a sitemap needs.
-- The personal site needs the page itself: it does not link to notes, it draws
-- them inside its own chrome, from a record with the page's stylesheet and
-- body. So the reader gains the two fields that make a record buildable.
--
-- Still nothing that is not on the public page: a title, a storage key that is
-- useless without the app's own credentials, and two dates.
-- The signature changes, so the old one is dropped first: Postgres will not
-- replace a function whose OUT parameters differ.
drop function if exists hq_published_all();
create or replace function hq_published_all()
returns table (public_slug text, title text, storage_key text,
               published_at timestamptz, produced_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  return query
  select d.public_slug, d.title, d.storage_key, d.published_at, d.produced_at
    from documents d
   where d.published_at is not null and d.public_slug is not null
   order by d.published_at desc
   limit 5000;
end $$;
revoke all on function hq_published_all() from public;
grant execute on function hq_published_all() to hq_app;
