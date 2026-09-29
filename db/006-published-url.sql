-- A page that was also published carries its live address (the archive's
-- intranet:url tag). Nullable; nothing else about the row changes.
alter table documents add column if not exists published_url text;
