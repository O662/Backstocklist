// Backstock List settings. Everything here is safe to be public:
// the database rules (setup.sql) are what keep your data private.

export const CONFIG = {
  // Supabase → Project Settings → API (or "Connect" button at the top)
  SUPABASE_URL: "https://miudiwvnerhwqjsctbrx.supabase.co",
  // The "publishable" key (starts with sb_publishable_) or the legacy "anon" key.
  // NEVER put the secret / service_role key here.
  SUPABASE_KEY: "sb_publishable_vZUFoQDpe6pOjgKEZUSGHA_1IWJgI7l",

  // Public half of the push notification keys (from secrets.local.txt).
  VAPID_PUBLIC_KEY: "BJWQNNXcJbtQv1PrkMHrJa2EousE9_hsfVLpf5m_4LtDAgfKg4Htk7_PFPMszsplqrDClzAyL_pqdes3zlMwX4M",

  // Shown in this order in Report and Checklist. Edit freely.
  // Locations added in the app (Report → "+ Add location…") are shared with
  // the team and listed after these.
  LOCATIONS: [
    "Aisle 6", "Aisle 6 Endcap",
    "Aisle 7", "Aisle 7 Endcap",
    "Aisle 8", "Aisle 8 Endcap",
    "Aisle 11", "Aisle 11 Endcap",
  ],

  // Quick-pick reasons when an item can't be pulled.
  REASONS: ["Out of stock", "Can't find it", "Damaged"],
};
