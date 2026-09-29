-- Link is not publish. Ruled 27 Sep 2026.
--
-- "Anyone with the link" was feeding the connected site: the link address
-- was the site's, the site's feed listed every link-shared page, and the
-- page carried a canonical to the site. That is publishing, which exists
-- for search engines. Sharing by link is person-to-person: the hub's own
-- address, a sign-in, no index. Publishing is its own fact, with its own
-- timestamp, chosen separately and only by an account with a site.
--
-- A team is a company, named and marked from its own website, not a domain
-- to type: orgs gains a name and a mark, looked up once when the org is
-- first seen and editable later.
begin;

alter table documents add column if not exists site_published_at timestamptz;
create index if not exists documents_site_published on documents (user_id, site_published_at desc)
  where site_published_at is not null;
-- Every page that was on the site stays on it: link-shared pages of the
-- connected account were the feed until now.
update documents set site_published_at = published_at
 where visibility = 'link' and published_at is not null and site_published_at is null;

alter table orgs add column if not exists logo_url text;
alter table orgs add column if not exists profiled_at timestamptz;

-- Put a page on the connected site, or take it off. Publishing implies the
-- link (a page on a website is public); taking it off leaves the link as it
-- was. Only the owner; the app decides whether this account has a site.
create or replace function hq_set_site_publication(p_user uuid, p_document uuid, p_on boolean, p_slug text)
returns table (visibility text, public_slug text, published_at timestamptz, site_published_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from documents d where d.id = p_document and d.user_id = p_user) then
    raise exception 'not your document' using errcode = '42501';
  end if;
  if p_on then
    perform hq_set_visibility(p_user, p_document, 'link', p_slug);
    update documents d set site_published_at = coalesce(d.site_published_at, now()) where d.id = p_document;
  else
    update documents d set site_published_at = null where d.id = p_document;
  end if;
  return query select d.visibility, d.public_slug, d.published_at, d.site_published_at
    from documents d where d.id = p_document;
end $$;
revoke all on function hq_set_site_publication(uuid, uuid, boolean, text) from public;
grant execute on function hq_set_site_publication(uuid, uuid, boolean, text) to hq_app;

-- Making a page private or team takes it off the site too: a page cannot
-- be on a website and not readable by link.
create or replace function hq_set_visibility(p_user uuid, p_document uuid, p_visibility text, p_slug text)
returns table (visibility text, public_slug text, published_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_visibility not in ('private', 'team', 'link') then
    raise exception 'not a visibility' using errcode = '22023';
  end if;
  if not exists (select 1 from documents d where d.id = p_document and d.user_id = p_user) then
    raise exception 'not your document' using errcode = '42501';
  end if;
  if p_visibility <> 'team' then
    update shares s set ended_at = now()
     where s.document_id = p_document and s.shared_by = p_user and s.ended_at is null;
  end if;
  update documents d
     set visibility   = p_visibility,
         public_slug  = case when p_visibility = 'link' then coalesce(d.public_slug, p_slug) else d.public_slug end,
         published_at = case when p_visibility = 'link' then coalesce(d.published_at, now()) else null end,
         site_published_at = case when p_visibility = 'link' then d.site_published_at else null end
   where d.id = p_document;
  return query select d.visibility, d.public_slug, d.published_at from documents d where d.id = p_document;
end $$;

-- The site's feed: only pages published to it.
drop function if exists hq_published_all();
create or replace function hq_published_all()
returns table (public_slug text, user_id uuid, title text, storage_key text,
               published_at timestamptz, produced_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  return query
  select d.public_slug, d.user_id, d.title, d.storage_key, d.site_published_at, d.produced_at
    from documents d
   where d.site_published_at is not null and d.public_slug is not null and d.visibility = 'link'
   order by d.site_published_at desc
   limit 5000;
end $$;
revoke all on function hq_published_all() from public;
grant execute on function hq_published_all() to hq_app;

-- Whether a page is on the site, for the canonical tag on the hub copy.
drop function if exists hq_published(text);
create or replace function hq_published(p_slug text)
returns table (id uuid, user_id uuid, title text, storage_key text,
               published_at timestamptz, produced_at timestamptz, site_published_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  return query
  select d.id, d.user_id, d.title, d.storage_key, d.published_at, d.produced_at, d.site_published_at
    from documents d
   where d.public_slug = p_slug and d.published_at is not null and d.visibility = 'link';
end $$;
revoke all on function hq_published(text) from public;
grant execute on function hq_published(text) to hq_app;

-- A team's profile: find-or-create the org for a domain, so a person's own
-- team exists the moment they sign in with a work address, and record what
-- its website says it is called.
-- Output columns are named so none shadows a column used in the body: an OUT
-- variable called "domain" made `on conflict (domain)` ambiguous (the same
-- defect hq_share_to_domain had on 27 Sep).
create or replace function hq_org_profile(p_domain text)
returns table (org_id uuid, org_domain text, org_name text, org_logo_url text, org_profiled_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v text := lower(trim(p_domain));
begin
  insert into orgs (domain, name) values (v, v) on conflict (domain) do nothing;
  return query select o.id, o.domain, o.name, o.logo_url, o.profiled_at from orgs o where o.domain = v;
end $$;
revoke all on function hq_org_profile(text) from public;
grant execute on function hq_org_profile(text) to hq_app;

create or replace function hq_set_org_profile(p_domain text, p_name text, p_logo_url text)
returns void
language sql security definer set search_path = public, pg_temp
as $$
  update orgs set name = coalesce(nullif(trim(p_name), ''), name), logo_url = p_logo_url, profiled_at = now()
   where domain = lower(trim(p_domain));
$$;
revoke all on function hq_set_org_profile(text, text, text) from public;
grant execute on function hq_set_org_profile(text, text, text) to hq_app;

commit;
