#!/usr/bin/env python3
"""Clara read-receipt listener. Runs beside clara-poller.mjs on the Actions
runner: watches our own Telegram account (a StringSession, NOT the bot) for
UpdateReadHistoryInbox on the allowed chat — i.e. the moment HE reads her
messages — and writes { read_at, max_id } into KV via the worker's /mem
bridge, where lib/memory.mjs loadSeen() picks it up for the ladder.

Env: TG_API_ID, TG_API_HASH, TELEGRAM_SESSION (StringSession string),
     MEM_URL, MEM_SECRET, ALLOWED_CHAT_IDS

Feasibility-proven 2026-10-19: read-sync updates DO reach a second session,
including for the bot dialog (probe: ~/clara-readprobe/).
"""
import json
import os
import time
import urllib.request

from telethon import TelegramClient, events
from telethon.sessions import StringSession

API_ID = int(os.environ["TG_API_ID"])
API_HASH = os.environ["TG_API_HASH"]
SESSION = os.environ["TELEGRAM_SESSION"]
MEM_URL = os.environ["MEM_URL"].rstrip("/")
MEM_SECRET = os.environ["MEM_SECRET"]
ALLOWED = [s.strip() for s in os.environ.get("ALLOWED_CHAT_IDS", "").split(",") if s.strip()]
HER_ID = int(ALLOWED[0]) if ALLOWED else None


def log(*a):
    print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), *a, flush=True)


def put_seen(chat_id, read_at, max_id):
    body = json.dumps({"read_at": read_at, "max_id": max_id}).encode()
    req = urllib.request.Request(
        f"{MEM_URL}/mem?key=hist:seen:{chat_id}",
        data=body,
        method="PUT",
        headers={
            "X-Clara-Mem": MEM_SECRET,
            "Content-Type": "text/plain",
            "User-Agent": "curl/8.22.0",
        },
    )
    try:
        urllib.request.urlopen(req, timeout=15).read()
        log(f"seen written chat={chat_id} max_id={max_id}")
    except Exception as e:
        log("seen PUT failed:", e)


client = TelegramClient(StringSession(SESSION), API_ID, API_HASH)


@client.on(events.Raw)
async def handler(update):
    if type(update).__name__ != "UpdateReadHistoryInbox":
        return
    uid = getattr(getattr(update, "peer", None), "user_id", None)
    if uid is None or uid != HER_ID:
        return
    put_seen(uid, int(time.time() * 1000), update.max_id)


async def main():
    if not SESSION:
        raise SystemExit("TELEGRAM_SESSION missing — refusing to start (empty session would prompt for login)")
    await client.start()
    me = await client.get_me()
    log(f"listener up as {me.first_name} (id {me.id}); watching read-receipts for peer {HER_ID}")
    await client.run_until_disconnected()
    log("disconnected")


client.loop.run_until_complete(main())
