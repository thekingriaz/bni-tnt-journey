-- =====================================================================
-- BNI TNT New Member Journey App : database schema
-- Run ONCE in Supabase > SQL Editor on the NEW project (bni-tnt-journey).
-- Safe to re-run: it drops and recreates only this app's objects.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- clean slate (this app only) ----------
drop trigger if exists on_auth_user_created_journey on auth.users;
drop table if exists sdc_reviews, member_health, palms_links, palms_rows, palms_uploads,
  chapter_people, tasks, members, task_templates, profiles, app_config, chapters cascade;

-- ---------- core tables ----------
create table chapters (
  id               serial primary key,
  name             text not null unique,
  username         text not null unique,          -- login name, e.g. kanya
  telegram_chat_id text,                          -- HT group chat id
  active           boolean not null default true
);

create table app_config (
  key   text primary key,
  value text
);

create table profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  role         text not null check (role in ('admin','chapter')),
  chapter_id   int references chapters(id),
  display_name text,
  created_at   timestamptz not null default now()
);

create table task_templates (
  code         text primary key,       -- A01..A28, B01..B04
  track        text not null check (track in ('A','B')),
  seq          int  not null,
  title        text not null,
  owner_role   text not null,
  anchor       text not null check (anchor in ('payment','induction','golive')),
  offset_days  int  not null,
  proof        text not null default 'Tick + name',
  needs_rating boolean not null default false,
  needs_note   boolean not null default false
);

create table members (
  id             bigserial primary key,
  chapter_id     int not null references chapters(id),
  full_name      text not null,
  category       text,
  company        text,
  mobile         text,
  payment_date   date,
  induction_date date,
  mentor_name    text,
  mentor_mobile  text,
  power_team     text,
  notes          text,
  status         text not null default 'active' check (status in ('active','renewed','left')),
  status_reason  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index on members(chapter_id);

create table tasks (
  id            bigserial primary key,
  member_id     bigint not null references members(id) on delete cascade,
  chapter_id    int not null references chapters(id),
  template_code text not null,
  seq           int  not null default 0,
  title         text not null,
  owner_role    text not null,
  due_date      date not null,
  status        text not null default 'open' check (status in ('open','done','na')),
  done_by       text,
  done_on       date,
  rating        int check (rating between 1 and 5),
  note          text,
  is_catchup    boolean not null default false,
  updated_by    uuid,
  updated_at    timestamptz not null default now(),
  unique (member_id, template_code)
);
create index on tasks(chapter_id, status, due_date);

create table chapter_people (
  id         bigserial primary key,
  chapter_id int not null references chapters(id),
  name       text not null,
  role       text,
  unique (chapter_id, name)
);

create table palms_uploads (
  id          bigserial primary key,
  chapter_id  int not null references chapters(id),
  period_from date not null,
  period_to   date not null,
  file_name   text,
  uploaded_by uuid,
  uploaded_at timestamptz not null default now(),
  unique (chapter_id, period_from, period_to)
);

create table palms_rows (
  id         bigserial primary key,
  upload_id  bigint not null references palms_uploads(id) on delete cascade,
  chapter_id int not null references chapters(id),
  palms_name text not null,
  member_id  bigint references members(id) on delete set null,
  p int, a int, l int, m int, s int,
  rgi int, rgo int, rri int, rro int, v int,
  one2one numeric, tyfcb numeric, ceu int
);
create index on palms_rows(member_id);
create index on palms_rows(chapter_id);

create table palms_links (
  chapter_id int not null references chapters(id),
  palms_name text not null,
  member_id  bigint not null references members(id) on delete cascade,
  primary key (chapter_id, palms_name)
);

create table member_health (
  member_id      bigint primary key references members(id) on delete cascade,
  chapter_id     int not null references chapters(id),
  status         text not null,
  reasons        text,
  computed_at    timestamptz not null default now(),
  red_alerted_at timestamptz
);

create table sdc_reviews (
  id             bigserial primary key,
  chapter_id     int not null references chapters(id),
  review_month   date not null,               -- first day of the month reviewed
  reviewed_by    text not null,
  completion_pct numeric,
  notes          text,
  created_at     timestamptz not null default now(),
  unique (chapter_id, review_month)
);

-- ---------- helper functions ----------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where user_id = auth.uid() and role = 'admin');
$$;

create or replace function public.my_chapter() returns int
language sql stable security definer set search_path = public as $$
  select chapter_id from profiles where user_id = auth.uid();
$$;

create or replace function public.can_see(ch int) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or ch = public.my_chapter();
$$;

-- ---------- task engine ----------
-- Builds / refreshes the journey tasks for one member.
-- Track A: induction on/after go-live (or not yet inducted).
-- Track B: induction before go-live = rescue track.
create or replace function public.gen_tasks(p_member bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  m        members%rowtype;
  g        date := coalesce((select value::date from app_config where key = 'go_live_date'), date '2026-10-01');
  t        task_templates%rowtype;
  d        int;          -- days from induction to go-live (Track B)
  due      date;
  catchup  boolean;
  keep     text[] := '{}';
  track    text;
begin
  select * into m from members where id = p_member;
  if not found then return; end if;

  if m.status <> 'active' then
    delete from tasks where member_id = m.id and status = 'open';
    return;
  end if;

  track := case when m.induction_date is not null and m.induction_date < g then 'B' else 'A' end;
  if track = 'B' then d := g - m.induction_date; end if;

  for t in select * from task_templates order by seq loop
    due := null; catchup := false;

    if track = 'A' then
      if t.track <> 'A' then continue; end if;
      if t.anchor = 'payment' then
        if m.payment_date is null then continue; end if;
        due := m.payment_date + t.offset_days;
      elsif t.anchor = 'induction' then
        if m.induction_date is null then continue; end if;
        due := m.induction_date + t.offset_days;
      end if;

    else -- Track B
      if t.track = 'B' then
        due := g + t.offset_days;
      elsif t.anchor = 'induction' and t.code not in ('A04','A05','A06','A08','A09') then
        due := m.induction_date + t.offset_days;
        if due < g then
          catchup := true;
          if    d <= 92 and t.code between 'A07' and 'A20'  then due := g + 30;
          elsif t.code = 'A24' and d <= 92                  then due := g + 30;
          elsif t.code = 'A25' and d > 92                   then due := g + 30;
          elsif t.code = 'A26' and d > 183                  then due := g + 30;
          elsif t.code = 'A27' and d > 243                  then due := g + 21;
          elsif t.code = 'A28' and d > 304                  then due := g + 14;
          else due := null;
          end if;
        end if;
      end if;
    end if;

    if due is null then continue; end if;
    keep := keep || t.code;

    insert into tasks (member_id, chapter_id, template_code, seq, title, owner_role, due_date, is_catchup)
    values (m.id, m.chapter_id, t.code, t.seq, t.title, t.owner_role, due, catchup)
    on conflict (member_id, template_code) do update
      set due_date   = case when tasks.status = 'open' then excluded.due_date else tasks.due_date end,
          chapter_id = excluded.chapter_id,
          is_catchup = excluded.is_catchup,
          title      = excluded.title,
          owner_role = excluded.owner_role,
          seq        = excluded.seq;
  end loop;

  -- remove open template tasks that no longer apply (e.g. induction date corrected)
  delete from tasks
   where member_id = m.id and status = 'open'
     and template_code ~ '^[AB][0-9]{2}$'
     and not (template_code = any(keep));

  -- automatic completions
  if m.induction_date is not null then
    update tasks set status = 'done', done_by = 'System', done_on = m.induction_date
     where member_id = m.id and template_code = 'A03' and status = 'open';
  end if;
  if coalesce(trim(m.mentor_name), '') <> '' then
    update tasks set status = 'done', done_by = 'System', done_on = current_date
     where member_id = m.id and template_code in ('A04') and status = 'open';
  end if;
  if coalesce(trim(m.power_team), '') <> '' and track = 'A' then
    update tasks set status = 'done', done_by = 'System', done_on = current_date
     where member_id = m.id and template_code = 'A09' and status = 'open';
  end if;
end $$;

create or replace function public.members_after_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function public.members_regen() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.gen_tasks(new.id);
  return null;
end $$;

create trigger members_touch before update on members
  for each row execute function public.members_after_change();

create trigger members_regen after insert or update of
  payment_date, induction_date, mentor_name, power_team, status, chapter_id on members
  for each row execute function public.members_regen();

-- regenerate every member (admin use, e.g. after changing go-live date)
create or replace function public.regen_all() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if not public.is_admin() and current_user not in ('postgres','service_role') then
    raise exception 'admin only';
  end if;
  for r in select id from members loop perform public.gen_tasks(r.id); n := n + 1; end loop;
  return n;
end $$;

-- stamp who updated a task
create or replace function public.tasks_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
create trigger tasks_touch before update on tasks
  for each row execute function public.tasks_touch();

-- ---------- auto-create profiles for new logins ----------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare ch int; admins text;
begin
  admins := coalesce((select value from app_config where key = 'admin_emails'), '');
  if lower(new.email) = any(string_to_array(lower(replace(admins,' ','')), ',')) then
    insert into profiles(user_id, role, display_name) values (new.id, 'admin', new.email)
    on conflict (user_id) do update set role = 'admin', chapter_id = null;
  elsif new.email ilike '%@journey.bnitnt.in' then
    select id into ch from chapters where username = lower(split_part(new.email, '@', 1));
    if ch is not null then
      insert into profiles(user_id, role, chapter_id, display_name)
      values (new.id, 'chapter', ch, (select name from chapters where id = ch))
      on conflict (user_id) do update set role = 'chapter', chapter_id = ch;
    end if;
  end if;
  return new;
end $$;

create trigger on_auth_user_created_journey after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- row level security ----------
alter table chapters       enable row level security;
alter table app_config     enable row level security;
alter table profiles       enable row level security;
alter table task_templates enable row level security;
alter table members        enable row level security;
alter table tasks          enable row level security;
alter table chapter_people enable row level security;
alter table palms_uploads  enable row level security;
alter table palms_rows     enable row level security;
alter table palms_links    enable row level security;
alter table member_health  enable row level security;
alter table sdc_reviews    enable row level security;

create policy ch_sel on chapters for select to authenticated using (public.can_see(id));
create policy ch_adm on chapters for all    to authenticated using (public.is_admin()) with check (public.is_admin());

create policy cfg_sel on app_config for select to authenticated using (true);
create policy cfg_adm on app_config for all    to authenticated using (public.is_admin()) with check (public.is_admin());

create policy pr_sel on profiles for select to authenticated using (user_id = auth.uid() or public.is_admin());

create policy tt_sel on task_templates for select to authenticated using (true);
create policy tt_adm on task_templates for all    to authenticated using (public.is_admin()) with check (public.is_admin());

create policy mem_sel on members for select to authenticated using (public.can_see(chapter_id));
create policy mem_ins on members for insert to authenticated with check (public.is_admin());
create policy mem_upd on members for update to authenticated using (public.can_see(chapter_id)) with check (public.can_see(chapter_id));
create policy mem_del on members for delete to authenticated using (public.is_admin());

create policy tk_sel on tasks for select to authenticated using (public.can_see(chapter_id));
create policy tk_upd on tasks for update to authenticated using (public.can_see(chapter_id)) with check (public.can_see(chapter_id));
create policy tk_ins on tasks for insert to authenticated with check (public.is_admin());
create policy tk_del on tasks for delete to authenticated using (public.is_admin());

create policy cp_all on chapter_people for all to authenticated using (public.can_see(chapter_id)) with check (public.can_see(chapter_id));

create policy pu_sel on palms_uploads for select to authenticated using (public.can_see(chapter_id));
create policy pu_adm on palms_uploads for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy prw_sel on palms_rows   for select to authenticated using (public.can_see(chapter_id));
create policy prw_adm on palms_rows   for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy pl_sel on palms_links   for select to authenticated using (public.can_see(chapter_id));
create policy pl_adm on palms_links   for all    to authenticated using (public.is_admin()) with check (public.is_admin());

create policy mh_sel on member_health for select to authenticated using (public.can_see(chapter_id));

create policy sdc_sel on sdc_reviews for select to authenticated using (public.can_see(chapter_id));
create policy sdc_ins on sdc_reviews for insert to authenticated with check (public.can_see(chapter_id));
create policy sdc_upd on sdc_reviews for update to authenticated using (public.can_see(chapter_id)) with check (public.can_see(chapter_id));
create policy sdc_del on sdc_reviews for delete to authenticated using (public.is_admin());

grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
grant execute on function public.regen_all() to authenticated;
revoke all on all tables in schema public from anon;

-- ---------- seed data ----------
insert into app_config(key, value) values
  ('go_live_date', '2026-10-01'),
  ('admin_emails', 'riaz@thekingsgroup.in,support@bnitirunelveli.com,admin@bnitirunelveli.com'),
  ('region_chat_id', ''),
  ('app_url', '');

insert into chapters(name, username, telegram_chat_id) values
  ('BNI Ainthinai',     'ainthinai',    '-292117690'),
  ('BNI Bamboo Kottai', 'bambookottai', '-252370075'),
  ('BNI Cmy Veli',      'cmyveli',      '-223951476'),
  ('BNI Dil Nadu',      'dilnadu',      '-206409073'),
  ('BNI Tamilan',       'tamilan',      '-1001690639953'),
  ('BNI Ejamaan',       'ejamaan',      '-603038880'),
  ('BNI Thamira',       'thamira',      '-4633286793'),
  ('BNI Saral',         'saral',        '-1003384995620'),
  ('BNI Korkai',        'korkai',       '-1001441886839'),
  ('BNI Nanjil',        'nanjil',       '-552765293'),
  ('BNI Kanya',         'kanya',        '-820191894'),
  ('BNI Comorin',       'comorin',      '-998260361'),
  ('BNI Kumari',        'kumari',       '-1002592245799'),
  ('BNI Kings',         'kings',        '-1003969881037');

insert into task_templates(code, track, seq, title, owner_role, anchor, offset_days, proof, needs_rating, needs_note) values
  ('A01','A', 1,'Interview done, Jotform filed','Interviewing leader','payment',3,'Tick + name',false,false),
  ('A02','A', 2,'Welcome call before induction','CMC','payment',2,'Tick + name',false,false),
  ('A03','A', 3,'Inducted at chapter meeting','Head Table','payment',7,'Induction date entered',false,false),
  ('A04','A', 4,'Personal mentor assigned','CMC','induction',0,'Mentor name entered',false,false),
  ('A05','A', 5,'Added to BNI Connect, credentials sent','Regional team','induction',2,'Tick + name',false,false),
  ('A06','A', 6,'Mentor 1-1 on induction day','Mentor','induction',0,'Tick + name',false,false),
  ('A07','A', 7,'BNI Connect credentials received and login working','Mentor','induction',3,'Tick + name',false,false),
  ('A08','A', 8,'BNI Connect profile completed','Mentor','induction',7,'Tick, checked by regional team',false,false),
  ('A09','A', 9,'Power Team assigned','Power Team coordinator','induction',7,'Power Team name entered',false,false),
  ('A10','A',10,'Head Table visits member''s office','Head Table','induction',7,'Tick + name',false,false),
  ('A11','A',11,'Head Table lunch or dinner with member','Head Table','induction',14,'Tick + name',false,false),
  ('A12','A',12,'1-1 with President','Mentor','induction',30,'Tick + name',false,false),
  ('A13','A',13,'1-1 with Vice President','Mentor','induction',30,'Tick + name',false,false),
  ('A14','A',14,'1-1 with Secretary/Treasurer','Mentor','induction',30,'Tick + name',false,false),
  ('A15','A',15,'1-1 with Support Ambassador','Mentor','induction',30,'Tick + name',false,false),
  ('A16','A',16,'1-1 with Support DC','Mentor','induction',30,'Tick + name',false,false),
  ('A17','A',17,'Attended Coffee with ED','Mentor','induction',45,'Tick, confirmed by region',false,false),
  ('A18','A',18,'Attended LTRT','Mentor','induction',90,'Tick, confirmed by region',false,false),
  ('A19','A',19,'First referral passed','Mentor','induction',42,'PALMS',false,false),
  ('A20','A',20,'First referral received','Mentor','induction',42,'PALMS',false,false),
  ('A21','A',21,'Mentor check-in 1','Mentor','induction',21,'Tick + note',true,true),
  ('A22','A',22,'Mentor check-in 2','Mentor','induction',45,'Tick + note',true,true),
  ('A23','A',23,'Mentor check-in 3','Mentor','induction',70,'Tick + note',true,true),
  ('A24','A',24,'Mentor 90-day close-out (member rates experience 1 to 5)','Mentor','induction',90,'Rating entered',true,false),
  ('A25','A',25,'Support Ambassador 1-1','Support Ambassador','induction',100,'Tick + name',false,false),
  ('A26','A',26,'Support DC 1-1','Support DC','induction',190,'Tick + name',false,false),
  ('A27','A',27,'120 Renewals checklist','Membership Committee','induction',240,'Checklist completed',false,false),
  ('A28','A',28,'Renewal conversation with the President','President','induction',300,'Tick + name',false,false),
  ('B01','B',101,'Mentor assigned or confirmed','CMC','golive',7,'Mentor name entered',false,false),
  ('B02','B',102,'Health check call: "Is BNI working for you? What''s missing?"','Mentor','golive',14,'Rating + note',true,true),
  ('B03','B',103,'Power Team confirmed','Power Team coordinator','golive',14,'Tick + name',false,false),
  ('B04','B',104,'BNI Connect profile complete','Mentor','golive',14,'Tick + name',false,false);
