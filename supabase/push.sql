-- =====================================================================
-- Backstock List: push notifications (step 2, after the send-push
-- Edge Function is deployed).
--
-- Before running, replace the two placeholders below:
--   YOUR-PROJECT-REF    → from your project URL, e.g. abcdefghijklmnop
--   YOUR-WEBHOOK-SECRET → the WEBHOOK_SECRET value you saved as a secret
-- Then paste into Supabase → SQL Editor → Run.
-- =====================================================================

create extension if not exists pg_net;

create or replace function public.send_push_for_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform net.http_post(
      url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-webhook-secret', 'YOUR-WEBHOOK-SECRET'),
      body    := jsonb_build_object('notification_id', new.id)
    );
  exception when others then
    -- Never block closing an item just because a push failed to queue.
    raise warning 'push queue failed: %', sqlerrm;
  end;
  return new;
end;
$$;

revoke all on function public.send_push_for_notification() from public, anon, authenticated;

drop trigger if exists notifications_send_push on public.notifications;
create trigger notifications_send_push
  after insert on public.notifications
  for each row execute function public.send_push_for_notification();
