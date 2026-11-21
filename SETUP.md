# Setup Guide

Pick ONE path. Path A is the single-command route the brief asks for. Path B is for developing and
running tests on Windows when Docker Desktop is not available (Postgres and Redis run inside WSL Ubuntu).

Demo logins need no password: the UI has a persona switcher (Anika, Dev, Meera, Kabir, Neha, Farah).

---

## Path A: everything in containers (one command)

Needs Docker with Compose v2.

```bash
docker compose up --build
```

Open http://localhost:5173 (API health: http://localhost:4000/health).
First start applies migrations and seeds the demo data. Start order is enforced by health checks
(Postgres/Redis -> API -> worker + web).

Useful: `docker compose up --build --scale worker=3` (more workers), `docker compose down -v` (wipe all data).

> Port clash: if you also run Postgres/Redis locally (Path B), stop them first or compose cannot bind 5432/6379.
> In WSL: `sudo service postgresql stop && sudo service redis-server stop`

### No Docker Desktop on Windows? Use Docker Engine inside WSL Ubuntu

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2
sudo service docker start
sudo usermod -aG docker $USER      # then close and reopen the Ubuntu window
docker compose up --build          # run from the project folder inside WSL
```
Open http://localhost:5173 in your normal Windows browser.

---

## Path B: run Node on Windows, Postgres + Redis in WSL (development and tests)

### 1. One-time: install and start the databases (in WSL Ubuntu)

```bash
sudo apt update && sudo apt install -y postgresql redis-server
sudo service postgresql start
sudo service redis-server start
sudo -u postgres psql -c "CREATE USER certiflow WITH PASSWORD 'certiflow' CREATEDB;"
sudo -u postgres psql -c "CREATE DATABASE certiflow OWNER certiflow;"
redis-cli ping                     # prints PONG
```
Keep that Ubuntu window open. After a reboot you only need the two `sudo service ... start` lines.

### 2. Backend (Windows Command Prompt, from the project root)

```
cd backend
copy ..\.env.example .env
npm install
npx prisma migrate deploy
npm run prisma:seed
npm run dev
```
API on http://localhost:4000. Check http://localhost:4000/health.

### 3. Worker (second Command Prompt)

```
cd backend
npm run worker:dev
```
This process generates the PDFs, sends WhatsApp messages (with retries), and runs the SLA/reconciler tick.

### 4. Frontend (third Command Prompt)

```
cd frontend
npm install
npm run dev
```
Open http://localhost:5173 (Vite proxies `/api` to port 4000).

### 5. Tests

```
cd backend
npm run test:unit      # no database needed
npm test               # unit + end-to-end (needs Postgres + Redis, migrations applied)
npm run typecheck
```
The E2E suite creates its own batches and users, replaces only the queue module with spies (so a running
worker will not interfere), and can be re-run any number of times against the same database.
`SKIP_E2E=true npm test` skips it.

---

## Sample spreadsheets (`sample-data/`)

| File | Use it to see |
| :--- | :--- |
| `valid-batch-small.csv` | 5 candidates; skips the quality team |
| `invalid-batch-errors.csv` | bad phone, bad score, failed result: exact row errors, nothing saved |
| `valid-batch-large-60.csv` | 60 candidates; quality-team review, then 60 WhatsApp deliveries |

Columns: `fullName,phone,email,nationalIdLast4,score,passed`.

## Suggested 2-minute demo

1. **Anika**: create a batch, upload `invalid-batch-errors.csv` (see exact row errors), then `valid-batch-large-60.csv`, submit.
2. **Dev**, then **Meera**: approve (two district approvals needed). Then **Neha**, then **Farah**.
3. Open the **Candidate WhatsApp Inbox** tab: messages arrive live, some after retries.
4. **Public Verification** tab: verify one certificate number (valid). As **Farah**, cancel it; verify again (invalid).
5. As **Farah**: run the SLA check; the seeded batch idle for 72 h is escalated. Open a batch's audit trail.

## Troubleshooting

| Symptom | Fix |
| :--- | :--- |
| `ECONNREFUSED 127.0.0.1:5432` or `:6379` | Start the services in WSL (step 1) |
| `P1001 Can't reach database` | Check `DATABASE_URL` in `backend/.env`; confirm `sudo service postgresql status` |
| `role "certiflow" does not exist` | Re-run the two `CREATE USER` / `CREATE DATABASE` commands |
| Certificates never appear | The worker is not running (step 3) |
| Ports 5432/6379 already in use under compose | Stop the WSL services (see Path A note) |
