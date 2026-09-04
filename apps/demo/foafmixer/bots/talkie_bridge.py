#!/usr/bin/env python3
"""Talkie-LM bridge bot for the Foafmixer MIX pilot.

Connects to the loopback MIX server as the account named in
FOAFMIXER_PURPLEGUEST_JIDANDPWD ("<jid> <password>"), joins a channel, and
answers every other participant's channel message using a local llama.cpp
server (llama-server, OpenAI-compatible /v1/chat/completions) running the
Talkie-1930-13b-it model.

This is deliberately dependency-free (stdlib only), mirroring
ejabberd-xmpp-mix-patches/tools/mix-probe.py's raw-socket approach, so it
needs nothing beyond python3 and a running llama-server.

Environment:
  FOAFMIXER_PURPLEGUEST_JIDANDPWD  required, "user@domain password"
  TALKIE_CHANNEL                   default "factoidal"
  TALKIE_NICK                      default "Talkie"
  TALKIE_HOST / TALKIE_PORT        default 127.0.0.1 / 5222 (C2S)
  TALKIE_LLAMA_URL                 default http://127.0.0.1:8188
  TALKIE_REQUIRE_ADDRESS            if set (e.g. "1"), only reply when the
                                     message text mentions this bot's own
                                     nick (case-insensitive, as a whole word)
  TALKIE_SYSTEM_PROMPT              override the default Talkie-1930 persona
                                     entirely, for pointing this bridge at a
                                     different backend model/persona
  TALKIE_OWNER_NICKS                comma-separated nicks allowed to change
                                     this bot's persona live in-channel with
                                     "<botnick>,sysprompt=<new prompt>" or
                                     "<botnick>,sysprompt:<new prompt>",
                                     used only as a fallback when the sender's
                                     real jid isn't visible (default
                                     "danbri,danbri_lap,dantest")
  TALKIE_OWNER_JIDS                 comma-separated bare jids allowed to
                                     change this bot's persona the same way
                                     (default
                                     "danbri@<domain>,danbri_lap@<domain>,dantest@<domain>")
"""

from __future__ import annotations

import base64
import json
import os
import re
import socket
import sys
import time
import urllib.request
from xml.sax.saxutils import escape, unescape

HOST = os.environ.get("TALKIE_HOST", "127.0.0.1")
PORT = int(os.environ.get("TALKIE_PORT", "5222"))
CHANNEL_NAME = os.environ.get("TALKIE_CHANNEL", "factoidal")
NICK = os.environ.get("TALKIE_NICK", "Talkie")
LLAMA_URL = os.environ.get("TALKIE_LLAMA_URL", "http://127.0.0.1:8188")
REQUIRE_ADDRESS = os.environ.get("TALKIE_REQUIRE_ADDRESS", "") not in ("", "0", "false")
OWNER_NICKS = {
    n.strip().lower()
    for n in os.environ.get("TALKIE_OWNER_NICKS", "danbri,danbri_lap,dantest").split(",")
    if n.strip()
}

DEFAULT_SYSTEM_PROMPT = (
    "You are Talkie, a participant in a live XMPP MIX group chat channel. "
    "You are the Talkie-1930 language model, trained only on pre-1931 "
    "English text, so your voice is that of a 1930s correspondent -- "
    "period vocabulary and manners, no anachronisms. Directly answer or "
    "react to what the other person actually just said, using the "
    "conversation so far for context -- do not fall back to a generic "
    "pleasantry like 'thank you, I am well' unless the message truly is "
    "small talk. Keep replies to two or three sentences. Do not prefix "
    "your reply with your own name."
)
SYSTEM_PROMPT = os.environ.get("TALKIE_SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT)


def parse_credentials() -> tuple[str, str, str]:
    raw = os.environ.get("FOAFMIXER_PURPLEGUEST_JIDANDPWD", "")
    parts = raw.split()
    if len(parts) != 2 or "@" not in parts[0]:
        print(
            "set FOAFMIXER_PURPLEGUEST_JIDANDPWD to '<user>@<domain> <password>'",
            file=sys.stderr,
        )
        raise SystemExit(2)
    jid, password = parts
    user, domain = jid.split("@", 1)
    return user, domain, password


class XmppStream:
    def __init__(self) -> None:
        self.sock = socket.create_connection((HOST, PORT), timeout=10)
        self.buffer = b""

    def send(self, xml: str) -> None:
        self.sock.sendall(xml.encode("utf-8"))

    def receive_until(self, *needles: bytes, timeout: float = 10) -> bytes:
        deadline = time.monotonic() + timeout
        while not all(needle in self.buffer for needle in needles):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(
                    "timed out waiting for "
                    + ", ".join(n.decode("utf-8", "replace") for n in needles)
                )
            self.sock.settimeout(remaining)
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("XMPP socket closed")
            self.buffer += chunk
        data, self.buffer = self.buffer, b""
        return data

    def iq(self, iq_id: str, xml: str, timeout: float = 10) -> bytes:
        self.send(xml)
        return self.receive_until(iq_id.encode(), timeout=timeout)

    def open(self) -> None:
        self.send(
            f"<stream:stream to='{DOMAIN}' version='1.0' xmlns='jabber:client' "
            "xmlns:stream='http://etherx.jabber.org/streams'>"
        )
        self.receive_until(b"</stream:features>")

    def close(self) -> None:
        try:
            self.send("</stream:stream>")
        finally:
            self.sock.close()


MESSAGE_RE = re.compile(rb"<message\b[^>]*>.*?</message>", re.S)
FROM_RE = re.compile(rb"from=['\"]([^'\"]+)['\"]")
BODY_RE = re.compile(rb"<body[^>]*>(.*?)</body>", re.S)
TYPE_RE = re.compile(rb"type=['\"]([^'\"]+)['\"]")
ID_RE = re.compile(rb"<message\b[^>]*\bid=['\"]([^'\"]+)['\"]")
# MIX carries the human-chosen nick and, unless MIX-ANON hides it, the real
# bare jid inside <mix>...</mix> -- the `from` resource is an opaque
# per-participant session id, NOT the nick, so it's useless for display or
# for authorizing the sysprompt command.
MIX_BLOCK_RE = re.compile(rb"<mix\b[^>]*>.*?</mix>", re.S)
MIX_NICK_RE = re.compile(rb"<nick>(.*?)</nick>", re.S)
MIX_JID_RE = re.compile(rb"<jid>(.*?)</jid>", re.S)


HISTORY_TURNS = 8  # user+assistant messages kept, i.e. ~4 exchanges


def ask_talkie(history: list[dict], prompt: str, system_prompt: str) -> str:
    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(history[-HISTORY_TURNS:])
    messages.append({"role": "user", "content": prompt})
    payload = json.dumps(
        {
            "messages": messages,
            "max_tokens": 100,
            "temperature": 0.8,
        }
    ).encode()
    req = urllib.request.Request(
        f"{LLAMA_URL}/v1/chat/completions",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.load(resp)
    return data["choices"][0]["message"]["content"].strip()


def main() -> int:
    global DOMAIN
    user, DOMAIN, password = parse_credentials()
    bare_jid = f"{user}@{DOMAIN}"
    service = f"mix.{DOMAIN}"
    channel = f"{CHANNEL_NAME}@{service}"
    owner_jids = {
        j.strip().lower()
        for j in os.environ.get(
            "TALKIE_OWNER_JIDS", f"danbri@{DOMAIN},danbri_lap@{DOMAIN},dantest@{DOMAIN}"
        ).split(",")
        if j.strip()
    }

    # Two or more "reply to everything" bots in one channel is a guaranteed
    # infinite ping-pong (proven the hard way: one incident escalated to 47+
    # replies from a single bot before being killed). A bot must never
    # spontaneously reply to another known bot -- only to a human, or to a
    # bot that explicitly addresses it by name -- regardless of this bot's
    # own TALKIE_REQUIRE_ADDRESS setting.
    known_bot_jids: set[str] = set()
    registry_path = os.environ.get(
        "TALKIE_BOT_REGISTRY",
        os.path.expanduser(
            "~/working/sandbox/mix/foafmixer-mix/apps/demo/foafmixer/"
            ".foafmixer-account-responsibility.tsv"
        ),
    )
    try:
        with open(registry_path, encoding="utf-8") as f:
            next(f, None)  # header
            for line in f:
                fields = line.rstrip("\n").split("\t")
                if len(fields) >= 2 and fields[1] == "bot":
                    known_bot_jids.add(fields[0].strip().lower())
    except OSError as exc:
        print(
            f"[talkie-bridge] could not read bot registry {registry_path}: {exc} "
            "-- cannot suppress replies to other bots, proceed with caution",
            file=sys.stderr,
        )
    known_bot_jids.discard(bare_jid.lower())

    stream = XmppStream()
    print(f"[talkie-bridge] connecting as {bare_jid} to {HOST}:{PORT}")
    stream.open()
    plain = base64.b64encode(b"\x00" + user.encode() + b"\x00" + password.encode()).decode()
    stream.send(f"<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='PLAIN'>{plain}</auth>")
    if b"<success" not in stream.receive_until(b"success"):
        raise RuntimeError("SASL PLAIN did not succeed -- check the password")
    stream.open()
    bound = stream.iq(
        "bind",
        "<iq type='set' id='bind'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'>"
        "<resource>talkie-bridge</resource></bind></iq>",
    )
    if b"type='result'" not in bound and b'type="result"' not in bound:
        raise RuntimeError(f"resource bind failed: {bound!r}")
    stream.send("<presence/>")

    print(f"[talkie-bridge] joining {channel} as nick '{NICK}'")
    join = stream.iq(
        "join",
        f"<iq to='{bare_jid}' type='set' id='join'>"
        f"<client-join channel='{channel}' xmlns='urn:xmpp:mix:pam:2'>"
        f"<join xmlns='urn:xmpp:mix:core:1'><nick>{escape(NICK)}</nick>"
        "<subscribe node='urn:xmpp:mix:nodes:messages'/>"
        "<subscribe node='urn:xmpp:mix:nodes:participants'/>"
        "</join></client-join></iq>",
        timeout=15,
    )
    if b"type='result'" not in join and b'type="result"' not in join:
        raise RuntimeError(f"client-join failed: {join!r}")
    print(f"[talkie-bridge] joined. Listening for messages on {channel} ...")
    if REQUIRE_ADDRESS:
        print(f"[talkie-bridge] reply-only-when-addressed mode: will only answer messages mentioning '{NICK}'")

    address_re = re.compile(r"\b" + re.escape(NICK) + r"\b", re.IGNORECASE)
    strip_prefix_re = re.compile(r"^\s*@?" + re.escape(NICK) + r"\s*[:,]?\s*", re.IGNORECASE)
    sysprompt_cmd_re = re.compile(
        r"^\s*" + re.escape(NICK) + r"\s*[,:]?\s*sysprompt\s*[:=]\s*(.+)$",
        re.IGNORECASE | re.DOTALL,
    )
    system_prompt = SYSTEM_PROMPT

    # MIX gives each participant an opaque, per-session resource id in the
    # `from` of a channel echo -- it is NOT the nick, and the server does
    # not preserve our own outgoing stanza id on the relayed copy either
    # (it assigns its own). So neither can be used for self-detection.
    # Instead: send a one-off marker message right after joining and learn
    # our own resource id from its echo, before handling anything else. A
    # rolling rate limit is a second, independent guard against any other
    # reply-loop bug (already proven necessary during testing).
    sent_ids: set[str] = set()
    reply_times: list[float] = []
    RATE_LIMIT_COUNT = 5
    RATE_LIMIT_WINDOW = 30.0
    history: list[dict] = []

    import uuid

    bootstrap_marker_re = re.compile(r"^__talkie_bootstrap_[0-9a-f]+__$")
    bootstrap_marker = f"__talkie_bootstrap_{uuid.uuid4().hex}__"
    stream.send(
        f"<message to='{channel}' type='groupchat' id='bootstrap'>"
        f"<body>{bootstrap_marker}</body></message>"
    )
    own_resource: str | None = None

    buf = b""
    while True:
        stream.sock.settimeout(300)
        try:
            chunk = stream.sock.recv(65536)
        except socket.timeout:
            stream.send(" ")  # whitespace keepalive
            continue
        if not chunk:
            raise ConnectionError("XMPP socket closed by server")
        buf += chunk

        for match in MESSAGE_RE.finditer(buf):
            stanza = match.group(0)
            type_match = TYPE_RE.search(stanza)
            if not type_match or type_match.group(1) != b"groupchat":
                continue
            id_match = ID_RE.search(stanza)
            if id_match:
                stanza_id = id_match.group(1).decode("utf-8", "replace")
                if stanza_id in sent_ids:
                    sent_ids.discard(stanza_id)
                    continue  # our own echo, not a message to react to
            from_match = FROM_RE.search(stanza)
            body_match = BODY_RE.search(stanza)
            if not from_match or not body_match:
                continue
            sender = from_match.group(1).decode("utf-8", "replace")
            # MIX channel membership is account-level and persistent: if this
            # account is ever a member of more than one channel, a groupchat
            # message from a DIFFERENT channel can still arrive here. Only
            # handle messages from the channel this process actually joined.
            if sender != channel and not sender.startswith(f"{channel}/"):
                continue
            if sender != channel and "/" in sender:
                sender_resource = sender.split("/", 1)[1]
            else:
                sender_resource = sender
            body = unescape(body_match.group(1).decode("utf-8", "replace"))

            if own_resource is None and body == bootstrap_marker:
                own_resource = sender_resource
                print(f"[talkie-bridge] learned own MIX resource id: {own_resource}")
                continue
            if own_resource is not None and sender_resource == own_resource:
                continue  # our own echo
            if bootstrap_marker_re.match(body):
                continue  # another bridge bot's own bootstrap probe, not a real message

            if not body.strip():
                continue

            mix_block_match = MIX_BLOCK_RE.search(stanza)
            sender_jid = None
            sender_nick = sender_resource
            if mix_block_match:
                nick_m = MIX_NICK_RE.search(mix_block_match.group(0))
                jid_m = MIX_JID_RE.search(mix_block_match.group(0))
                if nick_m:
                    sender_nick = unescape(nick_m.group(1).decode("utf-8", "replace"))
                if jid_m:
                    sender_jid = unescape(jid_m.group(1).decode("utf-8", "replace")).lower()
            is_owner = (
                sender_jid in owner_jids if sender_jid else sender_nick.lower() in OWNER_NICKS
            )

            print(f"[talkie-bridge] <{sender_nick}> {body}")

            cmd_match = sysprompt_cmd_re.match(body)
            if cmd_match:
                if is_owner:
                    system_prompt = cmd_match.group(1).strip()
                    print(f"[talkie-bridge] persona updated by {sender_jid or sender_nick}: {system_prompt}")
                    ack = "Persona updated."
                else:
                    print(f"[talkie-bridge] rejected sysprompt command from non-owner {sender_jid or sender_nick}")
                    ack = "Sorry, only my owner can change my persona."
                msg_id = f"talkie-{NICK}-{int(time.time()*1000)}"
                sent_ids.add(msg_id)
                stream.send(
                    f"<message to='{channel}' type='groupchat' id='{msg_id}'>"
                    f"<body>{escape(ack)}</body></message>"
                )
                continue

            user_turn = {"role": "user", "content": f"{sender_nick}: {body}"}
            sender_is_bot = sender_jid in known_bot_jids if sender_jid else False
            must_be_addressed = REQUIRE_ADDRESS or sender_is_bot
            if must_be_addressed and not address_re.search(body):
                history.append(user_turn)
                del history[:-HISTORY_TURNS]
                continue

            now = time.monotonic()
            reply_times[:] = [t for t in reply_times if now - t < RATE_LIMIT_WINDOW]
            if len(reply_times) >= RATE_LIMIT_COUNT:
                print(
                    f"[talkie-bridge] rate limit hit ({RATE_LIMIT_COUNT}/{RATE_LIMIT_WINDOW:.0f}s) "
                    "-- skipping reply, possible loop",
                    file=sys.stderr,
                )
                continue

            prompt = strip_prefix_re.sub("", body).strip() or body
            try:
                reply = ask_talkie(history, prompt, system_prompt)
            except Exception as exc:  # noqa: BLE001
                print(f"[talkie-bridge] llama-server error: {exc}", file=sys.stderr)
                continue
            print(f"[talkie-bridge] -> {reply}")
            history.append(user_turn)
            history.append({"role": "assistant", "content": reply})
            del history[:-HISTORY_TURNS]
            msg_id = f"talkie-{NICK}-{int(time.time()*1000)}"
            sent_ids.add(msg_id)
            reply_times.append(now)
            stream.send(
                f"<message to='{channel}' type='groupchat' id='{msg_id}'>"
                f"<body>{escape(reply)}</body></message>"
            )

        # Trim the buffer up to the end of the last fully-matched message,
        # so it doesn't grow unbounded and so a message isn't reprocessed.
        last_end = 0
        for match in MESSAGE_RE.finditer(buf):
            last_end = match.end()
        if last_end:
            buf = buf[last_end:]


if __name__ == "__main__":
    DOMAIN = "localhost"
    raise SystemExit(main())
