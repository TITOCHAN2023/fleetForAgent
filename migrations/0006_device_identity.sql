alter table devices add column if not exists alias text;
alter table devices add column if not exists alias_key text;
alter table devices add column if not exists agent_ver text;

create unique index if not exists devices_user_alias_key_idx
  on devices (user_id, alias_key)
  where alias_key is not null;
