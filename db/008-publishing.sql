-- Publishing: one document, one public address.
--
-- `published_at` has existed since the first schema with a comment saying
-- that setting it is the deliberate act of publishing and that nothing sets
-- it automatically. This adds the other half: the address a stranger reads
-- it at, and the only way a stranger can read anything here at all.
--
-- Two rules, both enforced below rather than in the app.
--
-- 1. THE PUBLIC SLUG IS GLOBAL, the document's own slug is not. Two people,
--    or one person on two days, will both write "the-plan"; a public address
--    can only belong to one of them. The unique index is what makes minting
--    a slug an operation that can fail, which is what forces the caller to
--    handle a collision instead of quietly stealing an address.
--
-- 2. READING A PUBLISHED DOCUMENT DOES NOT NEED A TENANT. Every other read
--    in this database happens inside `asUser`, and row-level security means
--    a query with no tenant context returns nothing. That is exactly right
--    for private documents and exactly wrong for a public one, so the public
--    read goes through a SECURITY DEFINER function that can see precisely
--    one thing: rows that a person published. Not the html, not the owner,
--    not anything unpublished. The same pattern as hq_user_for_token.
alter table documents add column if not exists public_slug text;
create unique index if not exists documents_public_slug
  on documents (public_slug) where public_slug is not null;

-- A published document, by its public address. The only row-returning path
-- in this schema that does not require a tenant context.
create or replace function hq_published(p_slug text)
returns table (id uuid, title text, storage_key text,
               published_at timestamptz, produced_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  return query
  select d.id, d.title, d.storage_key, d.published_at, d.produced_at
    from documents d
   where d.public_slug = p_slug
     and d.published_at is not null;
end $$;
revoke all on function hq_published(text) from public;
grant execute on function hq_published(text) to hq_app;

-- Everything published, for the sitemap. Addresses and dates only: the
-- sitemap is already public by definition, and this returns nothing that is
-- not on the pages it lists.
create or replace function hq_published_all()
returns table (public_slug text, published_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  return query
  select d.public_slug, d.published_at
    from documents d
   where d.published_at is not null and d.public_slug is not null
   order by d.published_at desc
   limit 5000;
end $$;
revoke all on function hq_published_all() from public;
grant execute on function hq_published_all() to hq_app;
