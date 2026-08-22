-- Per-user RSA keypair for flt_1. Reset replaces the row.
alter table hub_tokens add column kid text;
alter table hub_tokens add column pub text;
alter table hub_tokens add column priv text;
alter table hub_tokens add column aud text;
create index if not exists hub_tokens_kid_idx on hub_tokens (kid);
