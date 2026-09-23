# BNI TNT New Member Journey

A web app that tracks the first-year journey for every new BNI TNT member. It runs on its own Supabase project and its own Vercel project, completely separate from the lead CRM.

## What's in this folder

| Path | What it is |
| --- | --- |
| `index.html` | The whole app: login, This Week, Members, Dashboard, Region, Admin |
| `lib/health.js` | Member Health Score rules (shared by the app and the daily job) |
| `lib/palms.js` | Reads the BNI Connect Chapter Summary PALMS export |
| `lib/server.js` | Helpers for the server functions |
| `api/config.js` | Gives the app the public Supabase URL and anon key |
| `api/admin-users.js` | Creates and resets chapter logins (admins only) |
| `api/cron.js` | Daily at 9:00 AM IST: health check + red alerts; on Mondays: weekly lists; on the 1st: region summary |
| `vercel.json` | Schedules the daily job |
| `supabase/schema.sql` | Database, security rules, task engine, 14 chapters, 32 task templates |
| `vendor/` | supabase-js and SheetJS, bundled so the app needs no outside CDN |

## Setup (Part 2)

1. **Supabase: database.** Go to SQL Editor, then New query. Paste all of `supabase/schema.sql` and click Run. You should see "Success. No rows returned".
2. **Supabase: keys.** Go to Project Settings, then API Keys, and open the **Legacy API keys** tab. Copy three things: the Project URL, the `anon` key and the `service_role` key.
3. **GitHub.** Open the empty `bni-tnt-journey` repo, click "uploading an existing file", and drag in **everything inside this folder** (not the folder itself). Commit.
4. **Vercel.** Click Add New, then Project, and import `bni-tnt-journey`. Framework Preset: **Other**. Before clicking Deploy, open Environment Variables and add:

   | Name | Value |
   | --- | --- |
   | `SUPABASE_URL` | Project URL from step 2 |
   | `SUPABASE_ANON_KEY` | anon key |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role key (secret, never share it) |
   | `TELEGRAM_BOT_TOKEN` | token from BotFather |
   | `CRON_SECRET` | any long random text, e.g. `bnitnt-journey-2026-x7Qp9LmZ` |

   Then Deploy.
5. **First login.** Open the Vercel link. Log in with `riaz@thekingsgroup.in` and the password you set in Supabase.
6. **Admin tab.**
   - Section 5: paste the app link into "App link" and Save.
   - Section 4: create a password for each of the 14 chapters.
7. **Telegram.** Add the bot to each of the 14 HT groups. Create a small "Journey Region" group with Riaz, Shiva, Ahamed and the bot, for the monthly summary and tests.
8. **Shiva and Ahamed.** In Supabase, go to Authentication, then Users, then Add user. Create `support@bnitirunelveli.com` and `admin@bnitirunelveli.com` with Auto confirm ticked. They become admins automatically.

## Chapter logins

The username is the short chapter name: `ainthinai`, `bambookottai`, `cmyveli`, `dilnadu`, `tamilan`, `ejamaan`, `thamira`, `saral`, `korkai`, `nanjil`, `kanya`, `comorin`, `kumari`, `kings`. The regional team sets and resets passwords from Admin, section 4. Reset every password at each leadership handover.

## Monthly routine (regional team, about 30 to 40 minutes)

1. In BNI Connect, open Chapter, then Summary PALMS Report. Pick one chapter and **last calendar month only**, then Export.
2. Upload it in Admin, section 3. Link any names the app couldn't match (it remembers them next time).
3. Repeat for all 14 chapters.

## Rules built in (from the approved spec)

- **Track A** (inducted on or after 1 Oct 2026, or not yet inducted): 28 tasks. Due dates are counted from the payment date or the induction date.
- **Track B** (inducted before 1 Oct 2026): 4 rescue tasks, plus catch-up tasks that depend on the member's month:
  - Months 1 to 3: the unfinished early-journey tasks
  - Month 3 and later: Support Ambassador 1-1
  - Month 6 and later: Support DC 1-1
  - Month 8 and later: 120 Renewals checklist
  - Month 10 and later: renewal conversation with the President
- **Health Score:** 4 PALMS signals and 2 app signals.
  - Red when 2 or more signals are red, or when the member's rating is 1 or 2.
  - When a member turns red, an alert goes to the HT group and a recovery 1-1 task is created, due in 7 days.
- **Automatic ticks:**
  - Induction date entered: "Inducted" is ticked.
  - Mentor name entered: "Mentor assigned" is ticked.
  - Power Team entered: "Power Team assigned" is ticked (Track A).
  - PALMS shows a referral given or received: "First referral passed" or "First referral received" is ticked.
- **Mentor flags on the Dashboard:** 2 or more overdue mentor tasks shows "CMC to call". 4 or more shows "Reassign mentee".
- **Region Dashboard:** a chapter below 70% completion for two months running is flagged "SDC meets ED".
