/*
 * Seva Desk configuration
 * -----------------------
 * Leave both values empty to run Seva Desk in LOCAL MODE: everything is
 * saved in each person's browser and no sign-in code is needed.
 *
 * To connect the shared database, paste your Supabase Project URL and its
 * PUBLISHABLE key (it starts with "sb_publishable_"). Find both in the
 * Supabase dashboard: click "Connect" at the top of your project, or open
 * Project Settings > API Keys. Older projects may only have a legacy
 * "anon" key; that works here too.
 *
 * The publishable key is designed to be public: the database's security
 * rules (supabase/schema.sql) decide what each signed-in person can do.
 * NEVER put a secret key ("sb_secret_...") or the legacy "service_role"
 * key in this file or anywhere in the repository.
 *
 * Full guide: docs/BACKEND_SETUP.md
 */
window.SEVA_CONFIG = {
  SUPABASE_URL: "",              // e.g. "https://abcdefghijklmno.supabase.co"
  SUPABASE_PUBLISHABLE_KEY: "",  // e.g. "sb_publishable_AbC123..."
  APP_NAME: "Seva Desk",

  // The app starts with sample contacts, volunteers, events, tasks and demo
  // chat messages so people can see how it works. Set this to false before
  // real use to start empty. (It only affects browsers that haven't opened
  // Seva Desk yet; others can clear their site data to start fresh.)
  SAMPLE_DATA: true
};
