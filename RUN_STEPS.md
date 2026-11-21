# How to run CertiFlow on Windows (no Docker Desktop)

This guide matches your setup: Windows Command Prompt + Node 20, with Postgres and Redis running
inside WSL Ubuntu (the same way you ran CivicPulse). CertiFlow uses its **own** database
(`certiflow`), so it will not clash with CivicPulse. Both can share the same Redis.

You need 4 windows: 1 Ubuntu + 3 Windows Command Prompts. Keep them all open while you work.

---

## PART 1: One-time setup

### Step 1. Unzip the project
Extract `certiflow-complete.zip` to, for example, `D:\SiriDocs\AI_Projects\`.
You should get `D:\SiriDocs\AI_Projects\certiflow\` with the folders `backend`, `frontend`, `sample-data`.

### Step 2. Ubuntu window: install and create the database
Open Command Prompt and type `wsl`. Then, one at a time:

```
sudo apt update
sudo apt install -y postgresql redis-server
sudo service postgresql start
sudo service redis-server start
sudo -u postgres psql -c "CREATE USER certiflow WITH PASSWORD 'certiflow' CREATEDB;"
sudo -u postgres psql -c "CREATE DATABASE certiflow OWNER certiflow;"
redis-cli ping
```
(If Postgres and Redis are already installed from CivicPulse, skip the first two lines.)

Expected: `CREATE ROLE`, `CREATE DATABASE`, then `PONG`. Leave this window open.

### Step 3. Backend setup (Windows Command Prompt)
```
cd D:\SiriDocs\AI_Projects\certiflow\backend
copy ..\.env.example .env
npm install
npx prisma generate
npx prisma migrate deploy
npm run prisma:seed
```
Expected: `migrate deploy` lists 2 migrations applied; seed prints `Seed completed successfully.`
(Use `migrate deploy`, NOT `db push`: this project uses real migrations, and the second one fixes the certificate-number sequence.)

You do not need to edit `.env`. No API keys are needed: the WhatsApp provider is a built-in stand-in.

### Step 4. Frontend setup (a second Command Prompt)
```
cd D:\SiriDocs\AI_Projects\certiflow\frontend
npm install
```

---

## PART 2: Starting the app (every time)

Start in this order.

**Window 1: Ubuntu**
```
wsl
sudo service postgresql start
sudo service redis-server start
redis-cli ping
```
You should see `PONG`.

**Window 2: API**
```
cd D:\SiriDocs\AI_Projects\certiflow\backend
npm run dev
```
Check http://localhost:4000/health shows `{"status":"ok",...}`.

**Window 3: Worker** (this makes the PDFs and sends the WhatsApp messages; without it no certificates appear)
```
cd D:\SiriDocs\AI_Projects\certiflow\backend
npm run worker:dev
```
You should see `Starting CertiFlow BullMQ workers...`.

**Window 4: Frontend**
```
cd D:\SiriDocs\AI_Projects\certiflow\frontend
npm run dev
```
Open **http://localhost:5173**. No passwords: use the dropdown at the top right to switch person.

Stop anything with `Ctrl + C`.

---

## PART 3: Demo script (about 3 minutes, good for the video)

1. **Anika (training centre)**: create a batch, e.g. code `BATCH-2026-100`, course `Solar PV Technician`.
   - Upload `sample-data\invalid-batch-errors.csv`: you see the exact bad rows, nothing is saved.
   - Upload `sample-data\valid-batch-large-60.csv`, then click **Submit**.
2. **Dev**, then **Meera**: click **Approve** (two different district officers are needed).
3. **Neha** (quality team): approve (only for batches of 50+ candidates).
4. **Farah** (state office): approve. The worker window now shows certificates being made.
5. Open the **Candidate WhatsApp Inbox** tab: 60 messages arrive live. Some take retries because the stand-in provider fails on purpose.
6. **Public Verification** tab: paste a certificate number from the inbox. It says valid.
   As **Farah**, cancel that certificate, then verify again: it now says cancelled.
7. **Send-back flow**: create a small batch with `valid-batch-small.csv`, submit, then as **Kabir** click **Send Back** with a reason. As **Anika** you see the reason in the table; click **Fix & Resubmit**. The round becomes R2 and earlier approvals are voided.
8. As **Farah**: run the SLA check. The seeded batch that has waited 72 hours is escalated.

---

## PART 4: Run the tests

In the backend folder (Postgres + Redis must be running, `.env` created):
```
cd D:\SiriDocs\AI_Projects\certiflow\backend
npm run test:unit
npm test
npm run typecheck
```
`test:unit` needs no database. `npm test` also runs the end-to-end tests against your real Postgres and Redis.

---

## Troubleshooting

| Problem | Fix |
| :--- | :--- |
| `ECONNREFUSED 127.0.0.1:5432` or `:6379` | Window 1 (Ubuntu) services are not started |
| `P1001 Can't reach database server` | Postgres not started, or wrong `DATABASE_URL` in `backend\.env` |
| `P1000 Authentication failed` | The `CREATE USER certiflow ...` command was not run |
| `P1010 / permission denied` | The database owner is wrong: re-run the `CREATE DATABASE ... OWNER certiflow` command |
| Certificates never appear after Farah approves | Window 3 (worker) is not running |
| Dropdown is empty in the browser | API (Window 2) is not running yet; wait and refresh |
| `EADDRINUSE :4000` | Another copy of the API is still running; close that window |
| Data disappears after reboot | You did not restart Postgres/Redis in Window 1 |
| Want a clean slate | In Ubuntu: `sudo -u postgres psql -c "DROP DATABASE certiflow;"` and `CREATE DATABASE ... OWNER certiflow;`, then redo `migrate deploy` and `prisma:seed` |

## Optional: Docker (only if you get it working later)
`docker compose up --build` starts everything in containers. Not needed for the demo. See `SETUP.md`.
