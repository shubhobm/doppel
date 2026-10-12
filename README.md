# Doppel Chatbot Studio

A Next.js app for running an AI-native exam. Students upload course material, configure their own chatbot (system prompt and settings), test it in a preview chat, and submit it. Graders then question the submitted bots through a protected API.

This guide walks you through deploying the platform for your own institution, either **on your own machine or server** or **on Vercel**.

---

## Contents

1. [How the platform works](#1-how-the-platform-works)
2. [Before you start](#2-before-you-start)
3. [Customize for your institution](#3-customize-for-your-institution)
4. [Environment variables](#4-environment-variables)
5. [Option A: Local install (Node.js + PostgreSQL)](#5-option-a-local-install-nodejs--postgresql)
6. [Option B: Local install with Docker](#6-option-b-local-install-with-docker)
7. [Option C: Deploy on Vercel](#7-option-c-deploy-on-vercel)
8. [First login and adding users](#8-first-login-and-adding-users)
9. [Running the exam](#9-running-the-exam)
10. [API reference](#10-api-reference)
11. [Operations: updates, backups, reset](#11-operations-updates-backups-reset)
12. [Troubleshooting](#12-troubleshooting)
13. [Security checklist](#13-security-checklist)

---

## 1. How the platform works

**Roles**

| Role | What they can do |
|---|---|
| `ADMIN` | Everything below, plus: create and delete users, see every user's chatbots, and query any bot (draft or submitted). There is one built-in admin account (see [section 3](#3-customize-for-your-institution)). You can create more admins from the dashboard. |
| `STUDENT` | Create chatbots, upload source files, edit the system prompt and settings, chat with their bot in a preview window, then **submit** it, or revert a submission to keep editing. |
| `GRADER` | Can log in to the web app like a student. Grading itself happens through the [Grader API](#grader-api), which uses a shared API key rather than a user login. |

**Under the hood**

- **Model:** chat answers use OpenAI `gpt-5-nano`. This is fixed in [lib/limits.ts](lib/limits.ts) (`CHAT_MODEL`). Each question also makes one call to `text-embedding-3-small`.
- **Database:** PostgreSQL, accessed through Prisma. The schema is in [prisma/schema.prisma](prisma/schema.prisma).
- **Uploads:** PDF, DOCX, TXT and Markdown files are converted to text, split into chunks, and stored in the database. When a student asks a question, the most relevant chunks are added to the prompt.
- **Upload limits (per bot):** 100 files and 100 MB in total. On Vercel, each single file must also be under **4.5 MB**, Vercel's request size limit.
- **File storage:** files go to local disk (`UPLOAD_BACKEND=local`) or to Vercel Blob (`UPLOAD_BACKEND=vercel-blob`).
- **Login:** username and password only. There are no emails, sign-up, or password-reset emails, so SMTP is not needed. Sessions last 7 days.

---

## 2. Before you start

**Pick a deployment option**

| | Option A: Local (Node) | Option B: Local (Docker) | Option C: Vercel |
|---|---|---|---|
| Best for | Trying it out, development | A single university server | A hosted exam with no servers to manage |
| You install | Node.js 20+, PostgreSQL 14+ | Docker Desktop or Docker Engine | Nothing (uses a browser and a GitHub account) |
| Database | Your own Postgres | Postgres container, set up for you | Neon Postgres through the Vercel Marketplace |
| File storage | Local disk | Docker volume | Vercel Blob |
| HTTPS | No (localhost only) | You add a reverse proxy | Automatic |

**Everyone needs**

- **An OpenAI API key** with access to `gpt-5-nano` and `text-embedding-3-small`. Create one at <https://platform.openai.com/api-keys>. Set a monthly spending limit on the OpenAI project before the exam, since every preview chat and grader question is a billed API call.
- **Your own copy of this repository**, made by forking or cloning it on GitHub. You will need to edit a few files (see [section 3](#3-customize-for-your-institution)) before deploying.

---

## 3. Customize for your institution

Do this **before your first deployment**. The built-in admin account is defined in the code, not in an environment variable.

### 3.1 Built-in admin account (required)

Open [lib/limits.ts](lib/limits.ts) and change these two values:

```ts
export const STATIC_USERNAME = "smajumdar";  // change to your admin username (lowercase, no "@")
export const STATIC_PASSWORD = "admin1234";  // the starting password; you will change it after first login
```

How the built-in admin works:

- The first time someone logs in with `STATIC_USERNAME` and `STATIC_PASSWORD`, the admin account is created in the database and the password is stored as a hash.
- After you change the password from the dashboard (**Change password**), the database password is used and `STATIC_PASSWORD` no longer works.
- **Anyone who reads the repository knows `STATIC_PASSWORD`**, so log in and change it immediately after deploying. If your fork is public, that includes anyone on the internet.
- This account cannot be deleted from the dashboard.

Then update the login page, [app/login/page.tsx](app/login/page.tsx). It pre-fills and displays the admin username in three places: the `useState("smajumdar")` default, the input's `placeholder`, and the notice text. Change all three, or blank them out if you'd rather not show the admin username on the login page.

If you also plan to use the demo seed script, update `STATIC_USERNAME` near the top of [scripts/seed-demo.js](scripts/seed-demo.js) as well.

### 3.2 Optional changes

| What | Where |
|---|---|
| Upload limits (files per bot, total MB) | `MAX_FILES` and `MAX_TOTAL_UPLOAD_BYTES` in [lib/limits.ts](lib/limits.ts). Also update the "100 MB" error message in [app/api/documents/upload/route.ts](app/api/documents/upload/route.ts) and the hint text in [components/StudentWorkspace.tsx](components/StudentWorkspace.tsx). |
| Chat model | `CHAT_MODEL` in [lib/limits.ts](lib/limits.ts). Also update the `model` field in [lib/grader.ts](lib/grader.ts). |
| Site title | `title` in [app/layout.tsx](app/layout.tsx) |
| Default exam ID stored on each bot | `examId @default("midterm_t4_2026")` in [prisma/schema.prisma](prisma/schema.prisma). This is only a label and has no effect on behavior. |
| Base instructions added to every bot | [lib/bot.ts](lib/bot.ts), which starts with "You are a midterm chatbot built by a student." |

`ALLOWED_EMAIL_DOMAIN` in `lib/limits.ts` exists only for backward compatibility with old admin records. You can leave it as is.

Commit and push your changes before deploying.

---

## 4. Environment variables

The app reads its settings from environment variables. For local work, put them in a file named **`.env.local`** in the project root. Git ignores this file, and Docker leaves it out of the image. **Don't put secrets in a file named `.env`**: this repository does not ignore it, so it can be committed by accident and gets copied into Docker images. On Vercel, set these values in the project's settings instead (see [section 7](#7-option-c-deploy-on-vercel)).

Start from the template:

```bash
cp .env.example .env.local
```

| Variable | Required? | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string, for example `postgresql://postgres:postgres@localhost:5432/midterm`. On Vercel with Neon, this is set for you. |
| `AUTH_SECRET` | Yes | A long random string used to sign login sessions. If you leave it unset, the app falls back to an insecure built-in value. Generate one with `openssl rand -hex 32`. If you change it, everyone is logged out. |
| `OPENAI_API_KEY` | Yes | Your OpenAI key. Without it, bots can't answer questions. |
| `GRADER_API_KEY` | Yes, for grading | A shared secret for the [Grader API](#grader-api). If it's empty, the Grader API rejects every request. Generate one with `openssl rand -hex 16`. |
| `ADMIN_API_KEY` | Optional | A shared secret for the [Admin API-key endpoints](#admin-api-key-endpoints). If it's empty, those endpoints are disabled. |
| `APP_URL` | Recommended | The public URL of the site, for example `https://exam.example.edu`. It isn't used in the current login flow. |
| `UPLOADS_ENABLED` | Optional | `true` (default) or `false`. Set it to `false` for a system-prompt-only exam with no file uploads. |
| `UPLOAD_BACKEND` | Optional | `local` (default) or `vercel-blob`. **It must be `vercel-blob` on Vercel** if uploads are enabled. |
| `UPLOAD_DIR` | Optional | The folder for uploaded files when `UPLOAD_BACKEND=local`. The default is `./uploads`. |
| `BLOB_READ_WRITE_TOKEN` | When using Blob | A Vercel Blob token. It's set automatically when you connect a Blob store to the Vercel project. |
| `BLOB_ACCESS` | Optional | `private` (default) or `public`. It must match the access type you chose when creating the Blob store. |

A complete `.env.local` for local development:

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/midterm"
AUTH_SECRET="<output of: openssl rand -hex 32>"
APP_URL="http://localhost:3000"
ADMIN_API_KEY="<output of: openssl rand -hex 16>"
GRADER_API_KEY="<output of: openssl rand -hex 16>"
OPENAI_API_KEY="sk-..."
UPLOADS_ENABLED="true"
UPLOAD_BACKEND="local"
UPLOAD_DIR="./uploads"
```

---

## 5. Option A: Local install (Node.js + PostgreSQL)

These steps were tested on Ubuntu 24.04, including under WSL2 on Windows. On macOS, use Homebrew (`brew install node@22 postgresql@16`) in place of `apt`.

### 5.1 Install Node.js and PostgreSQL

```bash
# Node.js 22 (any version 20 or later works)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# PostgreSQL
sudo apt-get install -y postgresql
sudo service postgresql start          # on systems with systemd: sudo systemctl enable --now postgresql

node -v    # should print v20 or later
```

### 5.2 Create the database

```bash
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"
sudo -u postgres createdb midterm
```

If you choose a different user, password, or database name, update `DATABASE_URL` to match.

### 5.3 Configure, install, and create tables

From the project root:

```bash
cp .env.example .env.local      # then edit .env.local (see section 4)
npm install
npx prisma generate
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/midterm" npx prisma db push
```

`prisma db push` creates all the tables. The Prisma command-line tool reads only `.env`, not `.env.local`, so pass the same `DATABASE_URL` you put in `.env.local` directly on the command line, as shown.

### 5.4 Start the app

```bash
npm run dev          # development mode, at http://localhost:3000
```

For a longer-running local instance, use production mode instead:

```bash
npm run build
npm run start        # http://localhost:3000
```

Open <http://localhost:3000> and continue with [section 8](#8-first-login-and-adding-users).

**After a reboot** (or restarting WSL), start PostgreSQL again with `sudo service postgresql start`, then run `npm run dev`.

**Optional demo bot:** `npm run seed:demo` loads [data/demo-course-notes.md](data/demo-course-notes.md) as a sample bot.

---

## 6. Option B: Local install with Docker

[docker-compose.yml](docker-compose.yml) runs two containers: PostgreSQL 16 (`db`) and the app (`app`). On every start, the app container creates or updates the tables (`prisma db push`), then starts in production mode.

### 6.1 Steps

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) or Docker Engine with the Compose plugin.
2. Create `.env.local` as described in [section 4](#4-environment-variables). Docker requires this file, and **`OPENAI_API_KEY` must be in it**: Docker does not pass variables from `.env` into the container. You can leave `DATABASE_URL` and `UPLOAD_DIR` in the file, because Compose replaces them with values that point at the `db` container and the uploads volume.
3. Build and start:

   ```bash
   docker compose up --build -d
   docker compose logs -f app       # wait for "Ready", then press Ctrl+C
   ```

4. Open <http://localhost:3000> and continue with [section 8](#8-first-login-and-adding-users).

### 6.2 Day-to-day commands

```bash
docker compose stop              # stop (data is kept)
docker compose start             # start again
docker compose up --build -d     # rebuild after pulling new code
docker compose down              # remove the containers (data volumes are kept)
docker compose down -v           # remove the containers AND all data (database + uploads)
```

### 6.3 Serving on a university server

- **HTTPS is required for access from other computers.** In production mode, the login cookie is marked `Secure`, so browsers only send it over HTTPS or to `localhost`. If you open the app over plain `http://<server-ip>:3000`, the login appears to succeed but you stay on the login page. Put a reverse proxy with a TLS certificate in front of port 3000, for example Caddy, nginx with Let's Encrypt, or your university's load balancer, and set `APP_URL` to the HTTPS address.
- The Postgres port (5432) is published to the host in `docker-compose.yml`. On a shared server, either remove that `ports:` entry from the `db` service or firewall the port, and change the default `postgres`/`postgres` password.
- Uploaded files are stored in the `uploads_data` volume and the database in the `postgres_data` volume. Back up both (see [section 11](#11-operations-updates-backups-reset)).

---

## 7. Option C: Deploy on Vercel

You need a GitHub account with your customized fork (see [section 3](#3-customize-for-your-institution)) and a Vercel account. The Hobby (free) plan works for testing. For a real exam, consider the Pro plan, which has higher function limits.

### 7.1 Import the project

1. Push your customized fork to GitHub.
2. In Vercel, click **Add New → Project**, then import your fork.
   (The **Deploy** button below clones the *original* repository, which still has the default admin credentials. Use it only for a quick trial.)

   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/shubhobm/doppel&project-name=doppel)

3. Keep the defaults: Framework Preset **Next.js** and Root Directory `./`. The build command is already set in [vercel.json](vercel.json) as `prisma generate && prisma db push && next build`. It creates or updates the database tables on every deploy, so you don't need to change it.
4. The first deploy may fail because no database is connected yet. That's expected; continue with the next steps.

### 7.2 Add a Postgres database (Neon)

1. In the project, open **Storage → Create Database**, choose **Neon** (Serverless Postgres), and pick a region close to your users.
2. Connect it to the project for all environments (Production, Preview, Development).
3. Neon adds `DATABASE_URL` along with related variables (`POSTGRES_PRISMA_URL`, `DATABASE_URL_UNPOOLED`, and so on). Check that **`DATABASE_URL` is listed** under **Settings → Environment Variables**: the build step needs this exact name. If you connect a database some other way, add `DATABASE_URL` yourself.

### 7.3 Add file storage (Vercel Blob)

Skip this step if you will set `UPLOADS_ENABLED=false`.

1. Open **Storage → Create Database → Blob**, then create a store. Choose **Private** access unless you have a reason to make files public.
2. Connect it to the project. This sets `BLOB_READ_WRITE_TOKEN` automatically.

### 7.4 Set environment variables

Under **Settings → Environment Variables**, add the following for **Production** (and for Preview, if you use preview deployments):

| Name | Value |
|---|---|
| `AUTH_SECRET` | output of `openssl rand -hex 32` |
| `OPENAI_API_KEY` | your OpenAI key |
| `GRADER_API_KEY` | output of `openssl rand -hex 16` |
| `ADMIN_API_KEY` | output of `openssl rand -hex 16` (optional) |
| `APP_URL` | `https://<your-project>.vercel.app` or your custom domain |
| `UPLOADS_ENABLED` | `true`, or `false` for a system-prompt-only exam |
| `UPLOAD_BACKEND` | `vercel-blob` (required on Vercel if uploads are enabled) |
| `BLOB_ACCESS` | `private`, or `public` if you created a public store |

### 7.5 Deploy

Open **Deployments**, then choose **⋯ → Redeploy** on the latest deployment, or push a new commit. Environment variable changes only take effect after a redeploy.

When the deployment finishes, open the production URL and continue with [section 8](#8-first-login-and-adding-users).

### 7.6 Notes for Vercel

- **Each uploaded file must be under 4.5 MB.** This is Vercel's request body limit, and the upload page tells students. Larger PDFs need to be split or compressed.
- The app refuses to start on Vercel if `DATABASE_URL` points at `localhost`. Uploads are refused if `UPLOAD_BACKEND` is still `local`.
- **Optional custom domain:** add it under **Settings → Domains**, then update `APP_URL`.
- **Deployment Protection:** by default, Vercel protects preview deployments only. The production URL stays public, which is what students and the Grader API need.

---

## 8. First login and adding users

### 8.1 Log in as admin and change the password

1. Open the site and log in with the `STATIC_USERNAME` and `STATIC_PASSWORD` you set in [section 3.1](#31-built-in-admin-account-required).
2. Click **Change password** on the dashboard right away and choose a strong password (at least 8 characters).

### 8.2 Add users from the dashboard

Open **Dashboard → Users** to create users one at a time. Each user needs a username (no `@`), a password of at least 8 characters, and a role (`STUDENT`, `GRADER` or `ADMIN`). You can delete users from the same page. Deleting a user also deletes their bots, files and logs.

### 8.3 Bulk-import students from a CSV

There is an API endpoint for bulk import, but no button for it in the dashboard yet. Prepare a CSV file that has a column named **`Email ID`**. Other columns are ignored.

```csv
Name,Email ID
Asha Rao,asha.rao@example.edu
Ben Ito,ben.ito@example.edu
```

For each row:

- The **username** is the part of the email before the `@` (for example, `asha.rao`).
- The **starting password is the same as the username.** Tell students to change it on first login using **Change password**.
- The role is `STUDENT`. Usernames that already exist are skipped.

Run the import with `curl`. You also need `jq` installed, to wrap the CSV in JSON.

```bash
APP=https://your-site.example.edu          # or http://localhost:3000

# 1. Log in as admin and save the session cookie
curl -s -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"username":"<admin-username>","password":"<admin-password>"}' \
  "$APP/api/auth/login"

# 2. Upload the CSV
jq -Rs '{csv: .}' students.csv | curl -s -b cookies.txt \
  -H 'Content-Type: application/json' -d @- "$APP/api/admin/users/bulk"

# 3. Delete the cookie file afterwards
rm cookies.txt
```

The response lists the usernames that were `created`, the ones `skipped` because they already existed, and any `invalid` rows.

> Because the starting password equals the username, anyone who knows a student's username can log in until that student changes their password. Run the import close to the exam, or create users individually with random passwords.

---

## 9. Running the exam

### 9.1 What students do

1. Log in, then change their password.
2. On **Dashboard → Chatbots**, create a chatbot.
3. In the workspace, upload source files (if uploads are enabled), write the system prompt, adjust the settings, and test the bot in the preview chat.
4. Click **Submit**. A submitted bot is locked against edits and uploads. Students can **revert** the submission to keep editing, then submit again.

### 9.2 What admins can do

- On **Dashboard → Chatbots**, see every user's bots, open any bot, and chat with it, including bots that haven't been submitted.
- Use the [Admin API-key endpoints](#admin-api-key-endpoints) to list bots for a given user and to query them from scripts.

### 9.3 Grading

Graders, or an automated grading script, send questions to submitted bots through the [Grader API](#grader-api). To find the bot ID for each student, an admin can call `POST /api/admin/key/user-bots` with the student's username. Every grader question and answer is saved in the `QueryLog` table.

### 9.4 Checklist before exam day

- [ ] Built-in admin password changed.
- [ ] `AUTH_SECRET`, `GRADER_API_KEY` and `ADMIN_API_KEY` are random values, not the placeholders from `.env.example`.
- [ ] Spending limit set on the OpenAI project.
- [ ] Students imported, and a test student can log in, create a bot, upload a file and chat.
- [ ] A test bot submitted and queried successfully through the Grader API.
- [ ] Database backup taken (see [section 11](#11-operations-updates-backups-reset)).

---

## 10. API reference

All endpoints accept and return JSON. This section covers the grader and admin endpoints that scripts are most likely to call. For every endpoint, with its exact request and response shapes, see the OpenAPI spec at [docs/openapi.yaml](docs/openapi.yaml), or open [docs/api.html](docs/api.html) in a browser for a readable version. If you edit the spec, regenerate the HTML with `npx @redocly/cli build-docs docs/openapi.yaml -o docs/api.html --title "Doppel Chatbot Studio API"`. You can view it in [Swagger Editor](https://editor.swagger.io) by pasting the file in, or locally with `npx @redocly/cli preview-docs docs/openapi.yaml`.

### Grader API

`POST /api/grader/query` queries a **submitted** bot.

Header: `x-grader-key: <GRADER_API_KEY>`

Body:

```json
{
  "studentId": "<bot id>",
  "question": "Explain the role of RAG in enterprise QA.",
  "sessionKey": "optional; questions with the same key share chat history (default: \"grader\")"
}
```

Despite its name, `studentId` is the **bot ID**, not the user ID.

Example:

```bash
curl -s -X POST "$APP/api/grader/query" \
  -H "Content-Type: application/json" \
  -H "x-grader-key: $GRADER_API_KEY" \
  -d '{"studentId":"<bot id>","question":"What topics does your material cover?"}'
```

The response includes `answer`, `botId`, `studentId` (the owner's user ID), `configVersion`, `submittedAt` and `timestamp`. A missing or wrong key returns `401`. A bot that hasn't been submitted, or doesn't exist, returns an error.

### Admin API-key endpoints

These endpoints are meant for scripts and service-to-service use. They require `ADMIN_API_KEY` to be set, and the caller doesn't need to log in.

Header: `x-admin-key: <ADMIN_API_KEY>`

**List a user's bots, with their settings and files:** `POST /api/admin/key/user-bots`

```json
{
  "userId": "optional_user_id",
  "username": "optional_username"
}
```

Provide either `userId` or `username`.

**Query any bot, draft or submitted:** `POST /api/admin/key/query`

```json
{
  "botId": "bot_id",
  "question": "What is this bot configured to answer?",
  "sessionKey": "optional_session_key"
}
```

---

## 11. Operations: updates, backups, reset

### Updating to a newer version

```bash
git pull                                    # or merge upstream changes into your fork
npm install
DATABASE_URL="<your database url>" npx prisma db push   # apply any schema changes
npm run build && npm run start              # Option A
docker compose up --build -d                # Option B
```

On Vercel, push to your production branch. The build step applies schema changes automatically.

> `prisma db push` stops with a warning if a schema change would delete data. Read the warning before you accept it.

### Backups

```bash
# Option A
pg_dump "postgresql://postgres:postgres@localhost:5432/midterm" > backup.sql
# Option B
docker compose exec db pg_dump -U postgres midterm > backup.sql
```

Also back up the uploads folder (`UPLOAD_DIR`, or the `uploads_data` Docker volume). The text extracted from uploaded files is stored in the database, so bots keep working from a database backup alone. The original files are only needed if you want to download them again.

On Vercel, Neon has point-in-time restore. You can configure it in the Neon console, which you can open from the Vercel Storage tab.

### Resetting for a new term

The simplest approach is a fresh database: create a new Neon database, or drop and recreate the local one. Then run `prisma db push` and log in as the built-in admin again. The admin account is recreated with `STATIC_PASSWORD`, so change the password again.

---

## 12. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Login seems to succeed, but you are sent back to the login page | The app is running in production mode over plain HTTP from a non-localhost address, so the browser drops the `Secure` cookie. Serve it over HTTPS (see [6.3](#63-serving-on-a-university-server)). |
| "Invalid username or password" for the admin on first login | Check the `STATIC_USERNAME` and `STATIC_PASSWORD` you deployed. If the admin password was already changed once, use the changed password. |
| Bots reply with a fallback message rather than a real answer | `OPENAI_API_KEY` is missing or invalid, the key lacks access to `gpt-5-nano`, or the OpenAI account is out of credit. Check the server logs (on Vercel: **Logs**). |
| `Can't reach database server at localhost:5432` | PostgreSQL isn't running (`sudo service postgresql start`), or `DATABASE_URL` is wrong. |
| `Environment variable not found: DATABASE_URL` when running `prisma db push` | The Prisma command-line tool doesn't read `.env.local`. Pass the URL inline: `DATABASE_URL="..." npx prisma db push`. |
| The Vercel build fails at `prisma db push` | `DATABASE_URL` isn't set for that environment (Production or Preview), or the pooled connection is rejected. Run `DATABASE_URL="<DATABASE_URL_UNPOOLED value>" npx prisma db push` once from your machine, then redeploy. |
| "DATABASE_URL must be set to a reachable hosted database" on Vercel | `DATABASE_URL` points at `localhost`. Connect Neon, or set the correct URL, then redeploy. |
| "Upload backend is misconfigured for Vercel" | Set `UPLOAD_BACKEND=vercel-blob`, then redeploy. |
| "Blob storage token is missing" | Connect a Blob store to the project, or set `BLOB_READ_WRITE_TOKEN`, then redeploy. |
| A file upload fails on Vercel | The file is larger than 4.5 MB, or it's an unsupported type (only PDF, DOCX, TXT and MD are accepted). Scanned PDFs without a text layer produce no text. |
| Docker: the app has no OpenAI key | The key is in `.env` rather than `.env.local`. Docker only reads `.env.local`. |
| Grader API returns `401` | `GRADER_API_KEY` isn't set on the server, or the `x-grader-key` header doesn't match it. |
| Grader API errors for a bot | The bot hasn't been submitted, or the ID is a user ID rather than a bot ID. |

---

## 13. Security checklist

- **Change the built-in admin credentials in code** ([section 3.1](#31-built-in-admin-account-required)), then change the password again after the first login.
- Use **random values** for `AUTH_SECRET`, `GRADER_API_KEY` and `ADMIN_API_KEY`. Never deploy the placeholder values from `.env.example`.
- Keep secrets in `.env.local` or in Vercel's environment variable settings. **Never commit them**, and don't keep them in a file named `.env`.
- Share `GRADER_API_KEY` and `ADMIN_API_KEY` only with the people or systems that need them. Anyone with `ADMIN_API_KEY` can read every bot's settings and query any bot.
- Serve the app over **HTTPS** in any setting other than localhost.
- On self-hosted servers, keep Postgres off the public network and change its default password.
- Set a **spending limit** on your OpenAI project.
