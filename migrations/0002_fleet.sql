create table if not exists devices (
  id text primary key,
  user_id text not null,
  slug text not null,
  name text not null,
  os text not null,
  arch text not null,
  location_tag text not null,
  status text not null default 'online',
  caps text not null default 'shell',
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index if not exists devices_user_slug_idx on devices (user_id, slug);
create index if not exists devices_user_id_idx on devices (user_id);

create table if not exists hub_sessions (
  user_id text primary key,
  selected_device_id text,
  selected_at timestamptz
);

create table if not exists commands (
  id text primary key,
  user_id text not null,
  device_id text not null,
  command text not null,
  exit_code integer,
  stdout text,
  stderr text,
  status text not null,
  created_at timestamptz not null default now()
);
create index if not exists commands_user_created_idx on commands (user_id, created_at desc);

create table if not exists protocol_events (
  id text primary key,
  user_id text not null,
  device_id text,
  direction text not null,
  type text not null,
  envelope text not null,
  created_at timestamptz not null default now()
);
create index if not exists protocol_events_user_created_idx on protocol_events (user_id, created_at desc);

create table if not exists enroll_codes (
  id text primary key,
  user_id text not null,
  code text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists enroll_codes_user_idx on enroll_codes (user_id);
