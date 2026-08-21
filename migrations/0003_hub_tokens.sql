-- One current hub token per account. Reset replaces the row. Store the hash only.
create table if not exists hub_tokens (
  user_id text primary key,
  token_hash text not null unique,
  token_prefix text not null,
  created_at timestamptz not null default now()
);
create index if not exists hub_tokens_hash_idx on hub_tokens (token_hash);
