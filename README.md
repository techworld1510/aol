# Seva Desk

**Less admin, more people.**

Seva Desk is a volunteer assistant for Art of Living teams. It brings poster design and sharing, contact capture, follow-ups and volunteer chat together in one web app that works on phones and computers.

It is a static web app: three files and no build step. It runs in one of two modes:

| Mode | Set up | What is shared between volunteers |
|---|---|---|
| **Local** | Nothing. Leave `config.js` empty. | Nothing. Each browser keeps its own data. |
| **Shared (Supabase)** | Create a free Supabase project and paste two values into `config.js`. | Posters, drafts, reviews and admin contact groups. Sign-in uses a one-time code sent by email, which also verifies the address. |

---

## Contents

- [Quick start](#quick-start)
- [What it does](#what-it-does)
- [Repository layout](#repository-layout)
- [Configuration](#configuration)
- [Roles](#roles)
- [Where data lives](#where-data-lives)
- [Security and privacy](#security-and-privacy)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)
- [Documentation](#documentation)
- [License](#license)

---

## Quick start

**Try it on your computer (local mode)**

```bash
git clone https://github.com/<your-account>/seva-desk.git
cd seva-desk
python3 -m http.server 8080
```

Then open http://localhost:8080 and click **Create an account**.

Opening `index.html` directly also works in local mode. A small web server, as above, matches how the app behaves once it is online.

**Put it online**

Follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). GitHub Pages, Netlify and Vercel all work and take about 10 minutes.

**Connect the shared database**

Follow [docs/BACKEND_SETUP.md](docs/BACKEND_SETUP.md). It takes about 30 minutes, including the email setup.

---

## What it does

| Area | Highlights |
|---|---|
| **Dashboard** | A "Needs your attention" bar: overdue tasks, events this week, unread messages, new posters and previews to review. Tiles open filtered lists. Upcoming events show contact counts plus Follow up and Make a poster buttons. Shortcuts open My contacts and Shared posters. |
| **Creative studio** | Opens on **Shared posters**, filterable by country and event. Each share button (Instagram, WhatsApp, Facebook, X, LinkedIn, Telegram, Email) sends the poster **with** its caption. The designer works as: design, then **send a preview** to a review group, collect reviews, then **publish** to all volunteers. Admins can edit any published poster. |
| **Contacts** | Volunteers see only contacts registered for their events. Search, status filters, add and import on demand, and auto-tags (Speaking, Partnership, Media, Volunteer). Also a registered volunteers directory (filter by country and event) and private or admin-shared groups. |
| **Follow-ups** | A ranked list of who to contact first, with ready-to-edit WhatsApp and email messages. |
| **Chat** | Volunteer-to-volunteer messages with full history, date dividers, search and unread counts. |
| **My profile** | View mode with Edit, profile photo, country, events, volunteer flag, verified-email badge, password reset and log out. |

The full tour, tab by tab, is in [docs/FEATURES.md](docs/FEATURES.md).

---

## Repository layout

```
seva-desk/
├── index.html            The whole app: HTML, CSS and JavaScript
├── config.js             Your settings (empty = local mode)
├── backend.js            Connects the app to Supabase, or runs it locally
├── supabase/
│   └── schema.sql        Tables, security rules and functions (run once)
├── docs/
│   ├── FEATURES.md       Every feature, tab by tab
│   ├── DEPLOYMENT.md     Put the app online, step by step
│   ├── BACKEND_SETUP.md  Connect Supabase, step by step
│   └── ARCHITECTURE.md   How the pieces fit, data model, storage keys
├── .nojekyll             Lets GitHub Pages serve the files as they are
└── .gitignore
```

---

## Configuration

Everything lives in `config.js`:

```js
window.SEVA_CONFIG = {
  SUPABASE_URL: "",              // e.g. "https://abcdefghijklmno.supabase.co"
  SUPABASE_PUBLISHABLE_KEY: "",  // starts with "sb_publishable_"
  APP_NAME: "Seva Desk"
};
```

- **Both values empty:** local mode.
- **Both values filled in:** shared mode, with a sign-in screen asking for an emailed code.

**Sample data.** Seva Desk starts with sample contacts, volunteers, events, tasks and demo chat messages, so people can see how it works. Before real use, set `SAMPLE_DATA: false` in `config.js`. This only affects browsers that haven't opened Seva Desk yet. Anyone who tried the demo can clear the site's data in their browser settings to start fresh.

The publishable key is meant to be public, because the database's security rules decide what each person may do. Older projects can use their legacy `anon` key instead. **Never** put a secret key (`sb_secret_...`) or the legacy `service_role` key in this file or anywhere in the repository.

---

## Roles

| Role | Who | Can do |
|---|---|---|
| **Volunteer** | Registered with "I am a volunteer" ticked | Everything in the app; listed in the volunteer directory |
| **Non-volunteer** | Registered without the tick | Uses the app; not listed as a volunteer |
| **Admin** (shared mode) | Anyone whose account is in the `admins` table | Create, edit and delete shared contact groups; edit or delete any poster |

Admin rights are enforced by the database, not just hidden in the screens. See [docs/BACKEND_SETUP.md, step 7](docs/BACKEND_SETUP.md#step-7--make-yourself-an-admin).

---

## Where data lives

| Data | Local mode | Shared mode |
|---|---|---|
| Posters, drafts, reviews | Browser | **Supabase** (shared, live updates) |
| Admin contact groups | Not available | **Supabase** |
| Sign-in and email verification | Typed twice; marked "Not verified" | **Supabase Auth** (emailed one-time code) |
| Seva Desk account, profile and photo | Browser | Browser |
| Contacts, follow-ups, tasks, private groups | Browser | Browser |
| Chat messages | Browser | Browser |
| Event list and dates | Browser | Browser |

In shared mode, people sign in once with an emailed code and then register their Seva Desk profile, with the email fixed to the verified address.

---

## Security and privacy

- **Database rules** (row level security in `supabase/schema.sql`):
  - Only signed-in people can read shared data.
  - Only creators and admins can change or delete a poster.
  - Reviewers can only add or replace **their own** review.
  - Only admins can manage shared groups.
- **Passwords** for the in-browser Seva Desk account are hashed with PBKDF2 (SHA-256, 150,000 rounds, random salt), with a short lockout after 5 wrong attempts.
- **Personal details** (date of birth, address and phone) stay in each person's browser in both modes.
- Before you store more personal data on a server, publish a privacy notice, add a consent line and review the rules that apply to you, such as GDPR or India's DPDP Act.

---

## Known limitations

- **Contacts, chat, tasks and Seva Desk accounts are per browser**, even in shared mode. A volunteer who changes device starts fresh. See the roadmap.
- **Two sign-ins in shared mode.** People sign in to the shared database with an emailed code, then log in to their Seva Desk profile with a password. Merging these is on the roadmap.
- **No direct posting to Instagram or Facebook accounts.** The app hands the poster and caption to the app you choose, because those platforms only allow direct posting through their official, reviewed APIs.
- **Re-using a poster** does not carry over uploaded background images or logos.
- **Colours** follow a third-party listing for an Art of Living site, not an official brand guide.

---

## Roadmap

1. Move contacts, chat, tasks and profiles into Supabase so they follow people across devices, and replace the in-browser password with the emailed code.
2. Manage one official event list in the database, with admins as owners.
3. Store uploaded backgrounds and logos in Supabase Storage so re-used posters keep them.
4. Optional direct posting through the Instagram Graph API, which needs a Business or Creator account and Meta app review.

---

## Documentation

- [docs/FEATURES.md](docs/FEATURES.md): the complete feature guide
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): GitHub, then GitHub Pages, Netlify or Vercel
- [docs/BACKEND_SETUP.md](docs/BACKEND_SETUP.md): Supabase, email codes, admins and testing
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it works under the hood

---

## License

No license has been chosen yet. Add a `LICENSE` file before sharing the repository publicly. Without one, others may not reuse the code.
