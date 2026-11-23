import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm";
import { CONFIG } from "./config.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const BUCKET = "tags";
const REFRESH_MS = 45_000; // safety net in case the live connection drops

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const state = {
  user: null,
  profile: null,
  profiles: new Map(), // id -> display_name
  items: [],
  updates: [],
  view: "report",
  photoBlob: null,
  photoPreviewUrl: null,
  location: null,
  customLocations: [], // added by the team, from the `locations` table
  locationsLoaded: false,
  signed: new Map(), // photo path -> { url, exp }
  channel: null,
  timer: null,
  started: false,
};

const VIEWS = {
  report: "Report item",
  checklist: "Checklist",
  updates: "Updates",
  settings: "Settings",
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function ago(ts) {
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

let toastTimer;
function toast(msg, ms = 2800) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function showScreen(name) {
  $("#screen-join").hidden = name !== "join";
  $("#app").hidden = name !== "app";
}

function friendlyError(err) {
  const m = err?.message || String(err);
  if (/failed to fetch|network/i.test(m)) return "No connection. Check your signal and try again.";
  return m;
}

// ---------------------------------------------------------------------------
// Joining: anyone with the link enters their name (plus the store code, if
// one is set). Behind the scenes each phone gets an anonymous account, and
// the name is how teammates and notifications find you.
// ---------------------------------------------------------------------------

async function boot() {
  registerServiceWorker();

  if (CONFIG.SUPABASE_URL.includes("YOUR-PROJECT") || CONFIG.SUPABASE_KEY.startsWith("YOUR-")) {
    showScreen("join");
    $("#join-error").textContent = "Not set up yet: add your Supabase URL and key to config.js.";
    return;
  }

  const { data } = await sb.auth.getSession();
  if (data.session) await afterSignIn(data.session.user);
  else showJoin();

  sb.auth.onAuthStateChange((event) => {
    // Don't await Supabase calls inside this callback (it can deadlock).
    if (event === "SIGNED_OUT") setTimeout(onSignedOut, 0);
  });
}

function showJoin() {
  showScreen("join");
  if (!$("#join-name").value) $("#join-name").value = localStorage.getItem("myName") || "";
  $("#join-name").focus();
}

async function afterSignIn(user) {
  state.user = user;
  const { data: profile, error } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (error) {
    showJoin();
    $("#join-error").textContent = friendlyError(error);
    return;
  }
  if (!profile) return showJoin();
  state.profile = profile;
  startApp();
}

$("#join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#join-name").value.trim();
  const code = $("#join-code").value.trim();
  const err = $("#join-error");
  const btn = $("#join-form button[type=submit]");
  if (!name) return;
  err.textContent = "";
  btn.disabled = true;
  try {
    let { data: { session } } = await sb.auth.getSession();
    if (!session) {
      const { data, error } = await sb.auth.signInAnonymously();
      if (error) {
        throw new Error(/anonymous/i.test(error.message)
          ? "Joining is turned off. In Supabase, turn on Authentication → Sign In / Providers → Allow anonymous sign-ins."
          : friendlyError(error));
      }
      session = data.session;
    }
    state.user = session.user;

    const { data: profile, error } = await sb.rpc("join_team", { p_name: name, p_code: code || null });
    if (error) {
      if (/STORE_CODE_REQUIRED/.test(error.message)) {
        $("#join-code-wrap").hidden = false;
        $("#join-code").focus();
        throw new Error("Enter the store code to join.");
      }
      if (/WRONG_STORE_CODE/.test(error.message)) {
        $("#join-code-wrap").hidden = false;
        throw new Error("That store code isn't right.");
      }
      throw error;
    }
    state.profile = profile;
    localStorage.setItem("myName", name);
    startApp();
  } catch (ex) {
    err.textContent = friendlyError(ex);
  } finally {
    btn.disabled = false;
  }
});

async function onSignedOut() {
  if (state.channel) await sb.removeChannel(state.channel);
  clearInterval(state.timer);
  Object.assign(state, { user: null, profile: null, items: [], updates: [], channel: null, started: false });
  state.signed.clear();
  showJoin();
}

$("#btn-signout").addEventListener("click", async () => {
  if (!confirm("Leave on this phone? You'll stop getting updates for items you reported from here, and you'll join again with your name.")) return;
  // Stop sending this phone notifications meant for this account.
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    if (sub) {
      await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
      await sub.unsubscribe();
    }
  } catch { /* ignore */ }
  await sb.auth.signOut();
});

// ---------------------------------------------------------------------------
// App shell & navigation
// ---------------------------------------------------------------------------

let controlsBuilt = false;

function startApp() {
  showScreen("app");
  $("#signed-in-as").textContent = state.profile.display_name;
  $("#rename-input").value = state.profile.display_name;
  $("#notify-found").checked = localStorage.getItem("notifyFound") === "1";

  if (!controlsBuilt) {
    controlsBuilt = true;
    buildLocationControls();
  }
  if (!state.started) {
    state.started = true;
    subscribeLive();
    state.timer = setInterval(() => {
      if (document.visibilityState === "visible") refreshAll();
    }, REFRESH_MS);
  }

  // Always open on Report, except when a notification tap deep-links to Updates.
  go(location.hash === "#updates" ? "updates" : "report");
  refreshAll();
  updatePushUI(true);
}

function go(view) {
  if (!VIEWS[view]) view = "report";
  state.view = view;
  for (const v of Object.keys(VIEWS)) $(`#view-${v}`).hidden = v !== view;
  $("#view-title").textContent = VIEWS[view];
  document.querySelectorAll(".tab").forEach((t) => {
    if (t.dataset.view === view) t.setAttribute("aria-current", "page");
    else t.removeAttribute("aria-current");
  });
  if (view === "updates") markUpdatesSeen();
  if (view === "settings") {
    updatePushUI();
    renderAdmin();
  }
  if (location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
  window.scrollTo(0, 0);
}

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => go(t.dataset.view)));
$("#btn-updates").addEventListener("click", () => go(state.view === "updates" ? "report" : "updates"));
$("#btn-settings").addEventListener("click", () => go(state.view === "settings" ? "report" : "settings"));
window.addEventListener("hashchange", () => state.started && go(location.hash.slice(1)));

// Notification tapped while the app was already open.
navigator.serviceWorker?.addEventListener("message", (e) => {
  if (e.data?.type === "open-updates" && state.started) go("updates");
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.started) refreshAll();
});

// ---------------------------------------------------------------------------
// Live data
// ---------------------------------------------------------------------------

function subscribeLive() {
  let debounce;
  const soon = () => {
    clearTimeout(debounce);
    debounce = setTimeout(loadItems, 250);
  };
  state.channel = sb
    .channel("backstock")
    .on("postgres_changes", { event: "*", schema: "public", table: "items" }, soon)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${state.user.id}` },
      (payload) => {
        const n = payload.new;
        if (!state.updates.some((u) => u.id === n.id)) state.updates.unshift(n);
        renderUpdates();
        toast(n.title, 5000);
      },
    )
    .subscribe((status) => {
      $("#conn-dot").classList.toggle("live", status === "SUBSCRIBED");
      $("#conn-dot").title = status === "SUBSCRIBED" ? "Live updates on" : "Reconnecting…";
    });
}

async function refreshAll() {
  const { data: me, error } = await sb.from("profiles").select("id, display_name, is_admin").eq("id", state.user.id).maybeSingle();
  if (!error && !me) return removedFromTeam();
  if (me) Object.assign(state.profile, me);
  await Promise.all([loadLocations(), loadItems(), loadUpdates()]);
}

async function removedFromTeam() {
  if (state.channel) await sb.removeChannel(state.channel);
  clearInterval(state.timer);
  Object.assign(state, { profile: null, items: [], updates: [], channel: null, started: false });
  showJoin();
  $("#join-error").textContent = "You were removed from the team. Ask a lead if that's a mistake.";
}

async function loadProfiles() {
  const { data } = await sb.from("profiles").select("id, display_name");
  for (const p of data ?? []) state.profiles.set(p.id, p.display_name);
}

let loadingItems = null;
async function loadItems() {
  // Collapse overlapping refreshes into one.
  if (loadingItems) return loadingItems;
  loadingItems = (async () => {
    const { data, error } = await sb.from("items").select("*").order("created_at", { ascending: true });
    if (error) {
      toast(friendlyError(error));
      return;
    }
    state.items = data;
    const unknown = data.some((i) => !state.profiles.has(i.reported_by) || (i.held_by && !state.profiles.has(i.held_by)));
    if (unknown || state.profiles.size === 0) await loadProfiles();
    await signPhotos(data.map((i) => i.photo_path).filter(Boolean));
    renderChecklist();
  })().finally(() => (loadingItems = null));
  return loadingItems;
}

async function signPhotos(paths) {
  const soon = Date.now() + 5 * 60_000;
  const need = paths.filter((p) => !(state.signed.get(p)?.exp > soon));
  if (!need.length) return;
  const { data } = await sb.storage.from(BUCKET).createSignedUrls(need, 3600);
  for (const d of data ?? []) {
    if (d.signedUrl) state.signed.set(d.path, { url: d.signedUrl, exp: Date.now() + 3600_000 });
  }
}

const photoUrl = (path) => (path ? state.signed.get(path)?.url : null);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

// Locations = the ones in config.js, then any the team added (shared through
// the `locations` table), in the order they were added.
const ADD_LOCATION = "__add__";
const sameName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

function allLocations() {
  const list = [...CONFIG.LOCATIONS];
  for (const l of state.customLocations) if (!list.some((x) => sameName(x, l))) list.push(l);
  return list;
}

async function loadLocations() {
  const { data, error } = await sb.from("locations").select("name").order("created_at", { ascending: true });
  // On error (e.g. setup.sql not re-run yet) just use the config.js list.
  if (!error) state.customLocations = data.map((r) => r.name);
  state.locationsLoaded = true;
  renderLocationOptions();
  if (state.items.length) renderChecklist(); // group order may have changed
}

function renderLocationOptions() {
  const locs = allLocations();
  const opts = locs.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("");

  // Keep this phone's last location (it may be a team-added one that hasn't loaded yet).
  let saved = "";
  if (state.location && !locs.includes(state.location)) {
    if (state.locationsLoaded) state.location = null;
    else saved = `<option value="${esc(state.location)}">${esc(state.location)}</option>`;
  }
  const sel = $("#location-select");
  sel.innerHTML =
    `<option value="" disabled>Pick a location</option>` +
    opts +
    saved +
    `<option value="${ADD_LOCATION}">+ Add location…</option>`;
  sel.value = state.location || "";

  const filter = $("#filter-location");
  const current = filter.value || localStorage.getItem("filterLocation") || "";
  filter.innerHTML = `<option value="">All locations</option>` + opts;
  filter.value = locs.includes(current) ? current : "";
}

function buildLocationControls() {
  const saved = localStorage.getItem("reportLocation");
  if (saved) state.location = saved;
  renderLocationOptions();

  $("#location-select").addEventListener("change", (e) => {
    if (e.target.value === ADD_LOCATION) {
      e.target.value = state.location || "";
      showAddLocation(true);
      return;
    }
    state.location = e.target.value || null;
    localStorage.setItem("reportLocation", state.location || "");
    showAddLocation(false);
  });
  $("#location-add-btn").addEventListener("click", addLocation);
  $("#location-add-cancel").addEventListener("click", () => showAddLocation(false));
  $("#location-new").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault(); // don't submit the report
      addLocation();
    }
  });
}

function showAddLocation(show) {
  $("#location-add").hidden = !show;
  $("#location-new").value = "";
  if (show) $("#location-new").focus();
}

function selectLocation(loc) {
  state.location = loc;
  localStorage.setItem("reportLocation", loc);
  renderLocationOptions();
  showAddLocation(false);
}

async function addLocation() {
  const err = $("#report-error");
  err.textContent = "";
  const name = $("#location-new").value.trim().replace(/\s+/g, " ");
  if (!name) return $("#location-new").focus();

  const existing = allLocations().find((l) => sameName(l, name));
  if (existing) return selectLocation(existing);

  const btn = $("#location-add-btn");
  btn.disabled = true;
  try {
    const { error } = await sb.from("locations").insert({ name });
    // 23505 = someone else just added the same name: fine, use theirs.
    if (error && error.code !== "23505") throw error;
    await loadLocations();
    selectLocation(allLocations().find((l) => sameName(l, name)) || name);
    toast(`Added ${name}`);
  } catch (ex) {
    err.textContent = /locations/.test(ex?.message || "")
      ? "Couldn't save the location. The database needs the latest setup.sql."
      : friendlyError(ex);
  } finally {
    btn.disabled = false;
  }
}

$("#photo-btn").addEventListener("click", () => $("#photo-input").click());

$("#photo-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    setPhoto(await compressImage(file));
  } catch {
    if (/^image\/(jpeg|png|webp)$/.test(file.type) && file.size < 3_000_000) setPhoto(file);
    else toast("Couldn't read that photo. Try again.");
  }
});

$("#photo-clear").addEventListener("click", () => setPhoto(null));

function setPhoto(blob) {
  if (state.photoPreviewUrl) URL.revokeObjectURL(state.photoPreviewUrl);
  state.photoBlob = blob;
  state.photoPreviewUrl = blob ? URL.createObjectURL(blob) : null;
  $("#photo-preview").src = state.photoPreviewUrl || "";
  $("#photo-preview").hidden = !blob;
  $("#photo-placeholder").hidden = !!blob;
  $("#photo-clear").hidden = !blob;
  $("#photo-btn").classList.toggle("has-photo", !!blob);
}

// Shrink phone photos (often 3–8 MB) to ~150 KB so uploads are fast and storage lasts.
async function compressImage(file, maxSide = 1280, quality = 0.72) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
    if (!blob) throw new Error("encode failed");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

$("#notify-found").addEventListener("change", (e) =>
  localStorage.setItem("notifyFound", e.target.checked ? "1" : "0"),
);

$("#report-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#report-error");
  err.textContent = "";

  const name = $("#item-name").value.trim();
  const note = $("#item-note").value.trim();
  const loc = state.location;
  if (!loc) return (err.textContent = "Pick a location.");
  if (!state.photoBlob && !name) return (err.textContent = "Add a photo of the tag or type the item name.");

  const btn = $("#report-submit");
  btn.disabled = true;
  btn.textContent = "Sending…";
  let photoPath = null;
  try {
    if (state.photoBlob) {
      const ext = state.photoBlob.type === "image/png" ? "png" : state.photoBlob.type === "image/webp" ? "webp" : "jpg";
      photoPath = `${state.user.id}/${crypto.randomUUID()}.${ext}`;
      const { error } = await sb.storage
        .from(BUCKET)
        .upload(photoPath, state.photoBlob, { contentType: state.photoBlob.type || "image/jpeg" });
      if (error) throw error;
    }
    const { error } = await sb.from("items").insert({
      name: name || null,
      location: loc,
      note: note || null,
      photo_path: photoPath,
      notify_found: $("#notify-found").checked,
    });
    if (error) {
      if (photoPath) sb.storage.from(BUCKET).remove([photoPath]);
      throw error;
    }
    // Keep the location selected: people usually report several items in one aisle.
    $("#item-name").value = "";
    $("#item-note").value = "";
    setPhoto(null);
    toast("Sent to the list");
    loadItems();
  } catch (ex) {
    err.textContent = friendlyError(ex);
  } finally {
    btn.disabled = false;
    btn.textContent = "Send to list";
  }
});

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

$("#filter-location").addEventListener("change", (e) => {
  localStorage.setItem("filterLocation", e.target.value);
  renderChecklist();
});
$("#btn-refresh").addEventListener("click", async () => {
  await refreshAll();
  toast("Up to date");
});

function locationOrder(loc) {
  const locs = allLocations();
  const i = locs.indexOf(loc);
  return i === -1 ? locs.length : i;
}

function renderChecklist() {
  const filter = $("#filter-location").value;
  const items = state.items.filter((i) => !filter || i.location === filter);
  const open = items.filter((i) => i.status === "open");
  const held = items
    .filter((i) => i.status === "hold")
    .sort((a, b) => locationOrder(a.location) - locationOrder(b.location));

  const openCount = state.items.filter((i) => i.status === "open").length;
  $("#checklist-badge").hidden = openCount === 0;
  $("#checklist-badge").textContent = openCount > 99 ? "99+" : openCount;

  // Group open items by location, in the configured order, others after.
  const groups = new Map();
  for (const item of [...open].sort((a, b) => locationOrder(a.location) - locationOrder(b.location))) {
    if (!groups.has(item.location)) groups.set(item.location, []);
    groups.get(item.location).push(item);
  }

  let html = "";
  for (const [loc, list] of groups) {
    html += `<section class="group"><h2 class="group-title">${esc(loc)} <span class="count">${list.length}</span></h2>`;
    html += list.map((i) => itemCard(i, false)).join("");
    html += `</section>`;
  }
  if (held.length) {
    html += `<section class="group hold"><h2 class="group-title">On hold <span class="count">${held.length}</span></h2>`;
    html += held.map((i) => itemCard(i, true)).join("");
    html += `</section>`;
  }
  if (!html) {
    html = `<div class="empty-state">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17Z"/></svg>
      <p><strong>All caught up</strong><br>${filter ? `Nothing needed in ${esc(filter)}.` : "Nothing needs pulling right now."}</p>
    </div>`;
  }
  $("#checklist").innerHTML = html;
}

function itemCard(i, onHold) {
  const url = photoUrl(i.photo_path);
  const reporter = state.profiles.get(i.reported_by) || "Someone";
  const mine = i.reported_by === state.user.id;
  const thumb = url
    ? `<button class="thumb" data-act="photo" aria-label="View photo" style="background-image:url('${esc(url)}')"></button>`
    : `<div class="thumb empty"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2ZM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5Z"/></svg></div>`;
  const name = i.name
    ? `<div class="item-name">${esc(i.name)}</div>`
    : `<div class="item-name placeholder">See tag photo</div>`;
  const holder = i.held_by ? state.profiles.get(i.held_by) || "Someone" : null;

  return `<article class="item${onHold ? " on-hold" : ""}" data-id="${i.id}">
    <div class="item-main">
      ${thumb}
      <div class="item-info">
        ${name}
        <div class="item-meta">${onHold ? `${esc(i.location)} · ` : ""}${mine ? "You" : esc(reporter)} · ${ago(i.created_at)}</div>
        ${i.note ? `<div class="item-note">${esc(i.note)}</div>` : ""}
        ${onHold ? `<div class="hold-note">On hold${holder ? ` by ${esc(holder)}` : ""}${i.hold_note ? `: ${esc(i.hold_note)}` : ""}</div>` : ""}
      </div>
    </div>
    <div class="item-actions">
      <button class="btn success" data-act="found">Found</button>
      <button class="btn danger" data-act="unavailable">Can't get</button>
      ${onHold
        ? `<button class="btn" data-act="resume">Resume</button>`
        : `<button class="btn warn" data-act="hold">Hold</button>`}
    </div>
    ${mine ? `<div class="item-extra"><button class="link-btn" data-act="cancel">Cancel my request</button></div>` : ""}
  </article>`;
}

$("#checklist").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const card = btn.closest(".item");
  const item = state.items.find((i) => i.id === card.dataset.id);
  if (!item) return;

  switch (btn.dataset.act) {
    case "photo": {
      $("#photo-full").src = photoUrl(item.photo_path) || "";
      $("#dlg-photo").showModal();
      break;
    }
    case "found": {
      // Two taps to confirm so a stray tap doesn't delete something.
      if (btn.dataset.armed !== "1") {
        btn.dataset.armed = "1";
        btn.textContent = "Tap to confirm";
        setTimeout(() => {
          if (btn.isConnected) {
            btn.dataset.armed = "";
            btn.textContent = "Found";
          }
        }, 3000);
        return;
      }
      await closeItem(item, "found", null, card);
      break;
    }
    case "unavailable": {
      const reason = await askReason(item);
      if (reason) await closeItem(item, "unavailable", reason, card);
      break;
    }
    case "hold": {
      const note = await askHoldNote();
      if (note === null) return;
      await updateItem(item, { status: "hold", hold_note: note || null, held_by: state.user.id }, "On hold");
      break;
    }
    case "resume":
      await updateItem(item, { status: "open", hold_note: null, held_by: null }, "Back on the list");
      break;
    case "cancel":
      if (confirm("Remove your request from the list?")) await closeItem(item, "cancelled", null, card);
      break;
  }
});

async function closeItem(item, outcome, reason, card) {
  card?.querySelectorAll("button").forEach((b) => (b.disabled = true));
  const { data, error } = await sb.rpc("close_item", {
    p_item_id: item.id,
    p_outcome: outcome,
    p_reason: reason,
  });
  if (error) {
    card?.querySelectorAll("button").forEach((b) => (b.disabled = false));
    toast(friendlyError(error));
    return;
  }
  if (data?.photo_path) {
    sb.storage.from(BUCKET).remove([data.photo_path]);
    state.signed.delete(data.photo_path);
  }
  state.items = state.items.filter((i) => i.id !== item.id);
  renderChecklist();
  if (!data?.closed) toast("Someone already took care of that one");
  else toast({ found: "Marked found", unavailable: "Reported back", cancelled: "Request removed" }[outcome]);
}

async function updateItem(item, changes, msg) {
  const { error } = await sb
    .from("items")
    .update({ ...changes, updated_at: new Date().toISOString() })
    .eq("id", item.id);
  if (error) return toast(friendlyError(error));
  Object.assign(item, changes);
  renderChecklist();
  toast(msg);
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function openDialog(dlg) {
  dlg.returnValue = "";
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener("close", () => resolve(dlg.returnValue), { once: true }));
}

for (const dlg of document.querySelectorAll("dialog")) {
  // Tap outside a sheet to close it.
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close("cancel");
  });
  dlg.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => dlg.close("cancel")));
}
$("#photo-full").addEventListener("click", () => $("#dlg-photo").close());

let selectedReason = null;
$("#reason-chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  selectedReason = chip.dataset.reason;
  $("#reason-custom").value = "";
  $("#reason-chips").querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
});
$("#reason-custom").addEventListener("input", (e) => {
  if (e.target.value.trim()) {
    selectedReason = null;
    $("#reason-chips").querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
  }
});

async function askReason(item) {
  $("#reason-item").textContent = `${item.name || "Item"} · ${item.location}`;
  $("#reason-chips").innerHTML = CONFIG.REASONS.map(
    (r, idx) =>
      `<button type="button" class="chip" data-reason="${esc(r)}" aria-pressed="${idx === 0}">${esc(r)}</button>`,
  ).join("");
  selectedReason = CONFIG.REASONS[0] ?? null;
  $("#reason-custom").value = "";
  const result = await openDialog($("#dlg-reason"));
  if (result !== "ok") return null;
  return $("#reason-custom").value.trim() || selectedReason || "No reason given";
}

async function askHoldNote() {
  $("#hold-note").value = "";
  const result = await openDialog($("#dlg-hold"));
  return result === "ok" ? $("#hold-note").value.trim() : null;
}

// ---------------------------------------------------------------------------
// Updates (results for items I reported)
// ---------------------------------------------------------------------------

async function loadUpdates() {
  const { data, error } = await sb
    .from("notifications")
    .select("*")
    .eq("user_id", state.user.id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return;
  state.updates = data;
  renderUpdates();
}

function renderUpdates() {
  const seen = Number(localStorage.getItem("updatesSeen") || 0);
  const unseen = state.view === "updates" ? 0 : state.updates.filter((u) => new Date(u.created_at).getTime() > seen).length;
  $("#updates-badge").hidden = unseen === 0;
  $("#updates-badge").textContent = unseen > 99 ? "99+" : unseen;
  $("#btn-clear-updates").hidden = state.updates.length === 0;

  $("#updates-list").innerHTML = state.updates.length
    ? state.updates
        .map(
          (u) => `<div class="update ${u.outcome}" data-id="${u.id}">
        <div class="update-body">
          <div class="update-title">${esc(u.title)}</div>
          <div class="update-text">${esc(u.body)}</div>
          <div class="muted small">${ago(u.created_at)}</div>
        </div>
        <button class="icon-btn" data-dismiss aria-label="Dismiss">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41Z"/></svg>
        </button>
      </div>`,
        )
        .join("")
    : `<div class="empty-state"><p>No updates yet.<br>When someone finds or can't get an item you reported, it shows up here.</p></div>`;

  if (state.view === "updates") markUpdatesSeen();
}

function markUpdatesSeen() {
  localStorage.setItem("updatesSeen", String(Date.now()));
  $("#updates-badge").hidden = true;
}

$("#updates-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-dismiss]");
  if (!btn) return;
  const id = btn.closest(".update").dataset.id;
  state.updates = state.updates.filter((u) => u.id !== id);
  renderUpdates();
  await sb.from("notifications").delete().eq("id", id);
});

$("#btn-clear-updates").addEventListener("click", async () => {
  if (!confirm("Clear all updates?")) return;
  state.updates = [];
  renderUpdates();
  await sb.from("notifications").delete().eq("user_id", state.user.id);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

$("#rename-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#rename-input").value.trim();
  if (!name) return;
  const { error } = await sb.from("profiles").update({ display_name: name }).eq("id", state.user.id);
  if (error) return toast(friendlyError(error));
  state.profile.display_name = name;
  state.profiles.set(state.user.id, name);
  $("#signed-in-as").textContent = name;
  renderChecklist();
  toast("Name saved");
});

// ---------------------------------------------------------------------------
// Admin mode (shared admin password → manage the store code)
// ---------------------------------------------------------------------------

async function renderAdmin() {
  const isAdmin = !!state.profile?.is_admin;
  $("#admin-locked").hidden = isAdmin;
  $("#admin-panel").hidden = !isAdmin;
  if (!isAdmin) return;

  const { data, error } = await sb.rpc("get_admin_settings");
  if (error) {
    // Admin was removed (e.g. someone used "Remove admin from everyone but me").
    if (/admins only/i.test(error.message)) {
      state.profile.is_admin = false;
      return renderAdmin();
    }
    return toast(friendlyError(error));
  }
  const code = data.join_code;
  $("#code-status").textContent = code
    ? `On. New people must enter: ${code}`
    : "Off. Anyone with the link can join.";
  $("#code-input").placeholder = code ? "Change store code" : "Set a store code";
  $("#btn-code-off").hidden = !code;
  renderMembers();
}

async function renderMembers() {
  const { data, error } = await sb
    .from("profiles")
    .select("id, display_name, is_admin, created_at")
    .order("display_name");
  if (error) return toast(friendlyError(error));
  for (const p of data) state.profiles.set(p.id, p.display_name);
  $("#member-list").innerHTML = data
    .map((p) => {
      const me = p.id === state.user.id;
      return `<div class="member-row" data-id="${p.id}">
        <div>
          <span class="member-name">${esc(p.display_name)}</span>${me ? `<span class="tag">You</span>` : ""}${p.is_admin ? `<span class="tag">Admin</span>` : ""}
          <div class="muted small">Joined ${ago(p.created_at)}</div>
        </div>
        ${me ? "" : `<button class="btn danger" data-remove>Remove</button>`}
      </div>`;
    })
    .join("");
}

$("#member-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-remove]");
  if (!btn) return;
  const id = btn.closest(".member-row").dataset.id;
  const name = state.profiles.get(id) || "this person";
  const open = state.items.filter((i) => i.reported_by === id).length;
  const msg = `Remove ${name}?` + (open ? ` Their ${open} open request${open === 1 ? "" : "s"} will be deleted too.` : "");
  if (!confirm(msg)) return;
  btn.disabled = true;
  const { data, error } = await sb.rpc("remove_member", { p_user_id: id });
  if (error) {
    btn.disabled = false;
    return toast(friendlyError(error), 4000);
  }
  if (data?.length) sb.storage.from(BUCKET).remove(data);
  toast(`${name} removed`);
  renderAdmin();
  loadItems();
});

async function adminCall(fn, args, okMsg) {
  const { error } = await sb.rpc(fn, args);
  if (error) {
    toast(friendlyError(error), 4000);
    return false;
  }
  if (okMsg) toast(okMsg);
  return true;
}

$("#admin-unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#admin-unlock-form button");
  btn.disabled = true;
  const { error } = await sb.rpc("unlock_admin", { p_password: $("#admin-password").value });
  btn.disabled = false;
  if (error) {
    if (/WRONG_ADMIN_PASSWORD/.test(error.message)) return toast("Wrong admin password");
    if (/ADMIN_PASSWORD_NOT_SET/.test(error.message)) {
      return toast("No admin password set yet. Set one in Supabase first (see README).", 5000);
    }
    return toast(friendlyError(error));
  }
  $("#admin-password").value = "";
  state.profile.is_admin = true;
  toast("Admin unlocked on this phone");
  renderAdmin();
});

$("#code-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("#code-input").value.trim();
  if (await adminCall("set_join_code", { p_code: code }, "Store code is on")) {
    $("#code-input").value = "";
    renderAdmin();
  }
});

$("#btn-code-off").addEventListener("click", async () => {
  if (!confirm("Turn off the store code? Anyone with the link will be able to join.")) return;
  if (await adminCall("set_join_code", { p_code: null }, "Store code is off")) renderAdmin();
});

$("#admin-pass-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = $("#admin-new-pass").value;
  if (!confirm("Change the admin password? Tell your other admins the new one.")) return;
  if (await adminCall("set_admin_password", { p_password: pw }, "Admin password changed")) {
    $("#admin-new-pass").value = "";
  }
});

$("#btn-reset-admins").addEventListener("click", async () => {
  if (!confirm("Remove admin from everyone except you on this phone? They can unlock again with the admin password, so change it too if it leaked.")) return;
  if (await adminCall("reset_other_admins", {}, "Other admins removed")) renderAdmin();
});

$("#btn-lock-admin").addEventListener("click", async () => {
  if (await adminCall("lock_admin", {}, "Admin locked on this phone")) {
    state.profile.is_admin = false;
    renderAdmin();
  }
});

// ---------------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------------

const isIOS =
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const pushConfigured = CONFIG.VAPID_PUBLIC_KEY && !CONFIG.VAPID_PUBLIC_KEY.startsWith("YOUR-");

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW registration failed", e));
  }
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function saveSubscription(sub) {
  const j = sub.toJSON();
  const { error } = await sb.rpc("save_push_subscription", {
    p_endpoint: j.endpoint,
    p_p256dh: j.keys.p256dh,
    p_auth: j.keys.auth,
  });
  if (error) throw error;
}

async function updatePushUI(resync = false) {
  const status = $("#push-status");
  const btn = $("#btn-push");
  const test = $("#btn-push-test");
  $("#ios-install-hint").hidden = !(isIOS && !isStandalone);
  test.hidden = true;

  if (!pushConfigured) {
    status.textContent = "Push notifications aren't set up for this app yet. You'll still see updates while the app is open.";
    btn.hidden = true;
    return;
  }
  if (!pushSupported) {
    status.textContent = isIOS && !isStandalone
      ? "iPhone only allows notifications for apps on your Home Screen."
      : "This browser can't receive notifications. You'll still see updates while the app is open.";
    btn.hidden = true;
    return;
  }
  if (Notification.permission === "denied") {
    status.textContent = "Notifications are blocked for this site. Turn them on in your phone's settings for this browser/app.";
    btn.hidden = true;
    return;
  }

  let sub = null;
  try {
    sub = Notification.permission === "granted" ? await currentSubscription() : null;
  } catch { /* ignore */ }

  if (sub) {
    if (resync) saveSubscription(sub).catch(() => {}); // keep it linked to whoever is signed in
    status.textContent = "Notifications are on for this phone.";
    btn.hidden = false;
    btn.textContent = "Turn off notifications";
    btn.className = "btn";
    btn.dataset.mode = "off";
    test.hidden = false;
  } else {
    status.textContent = "Get a notification when an item you reported is found or can't be pulled.";
    btn.hidden = false;
    btn.textContent = "Turn on notifications";
    btn.className = "btn primary";
    btn.dataset.mode = "on";
  }
}

$("#btn-push").addEventListener("click", async () => {
  const btn = $("#btn-push");
  if (btn.dataset.mode === "off") {
    try {
      const sub = await currentSubscription();
      if (sub) {
        await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
        await sub.unsubscribe();
      }
      toast("Notifications off");
    } catch (e) {
      toast(friendlyError(e));
    }
    return updatePushUI();
  }

  btn.disabled = true;
  try {
    // iOS requires this to be the first thing that happens after the tap.
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      toast("Notifications weren't allowed");
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub =
      (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(CONFIG.VAPID_PUBLIC_KEY),
      }));
    await saveSubscription(sub);
    toast("Notifications on");
  } catch (e) {
    toast(`Couldn't turn on notifications: ${friendlyError(e)}`, 5000);
  } finally {
    btn.disabled = false;
    updatePushUI();
  }
});

$("#btn-push-test").addEventListener("click", async () => {
  const { error } = await sb.rpc("send_test_notification");
  toast(error ? friendlyError(error) : "Test sent. It should arrive in a few seconds.");
});

function base64UrlToBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

boot();
