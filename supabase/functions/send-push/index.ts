// Supabase Edge Function: send-push
// Called by the database (push.sql) whenever a notification row is created.
// Looks up the notification and sends it to every phone that person enabled.
//
// Secrets it needs (Edge Functions → Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, WEBHOOK_SECRET
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`Missing secret ${k}`);
  return v;
};

webpush.setVapidDetails(
  env("VAPID_SUBJECT"),
  env("VAPID_PUBLIC_KEY"),
  env("VAPID_PRIVATE_KEY"),
);

// SERVICE_KEY is a fallback in case your project doesn't provide the default one.
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || env("SERVICE_KEY");

const db = createClient(env("SUPABASE_URL"), serviceKey, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (req.headers.get("x-webhook-secret") !== env("WEBHOOK_SECRET")) {
    return new Response("Forbidden", { status: 403 });
  }

  const { notification_id } = await req.json().catch(() => ({}));
  if (!notification_id) return new Response("Missing notification_id", { status: 400 });

  // Only send what's actually in the database, never what the caller says.
  const { data: note, error } = await db
    .from("notifications")
    .select("id, user_id, outcome, title, body")
    .eq("id", notification_id)
    .maybeSingle();
  if (error) return new Response(error.message, { status: 500 });
  if (!note) return new Response("Not found", { status: 404 });

  const { data: subs } = await db
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", note.user_id);

  const payload = JSON.stringify({
    title: (note.outcome === "found" ? "✅ " : "❌ ") + note.title,
    body: note.body,
    tag: note.id,
    url: "./#updates",
  });

  let sent = 0;
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 60 * 60 * 12, urgency: "high" },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // Phone unsubscribed or reinstalled: forget this subscription.
      if (code === 404 || code === 410) {
        await db.from("push_subscriptions").delete().eq("id", s.id);
      } else {
        console.error("push failed", code, (e as Error).message);
      }
    }
  }));

  return Response.json({ sent, total: subs?.length ?? 0 });
});
