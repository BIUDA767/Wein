#!/usr/bin/env bash
# End-to-end smoke test of the WEIN platform surfaces against a running API.
# Exercises real routes; every assertion is a genuine server response.
set -u
B="${API:-http://localhost:12001}"
TMP=$(mktemp -d)
OWNER="$TMP/owner.txt"; MEMBER="$TMP/member.txt"
pass=0; fail=0

# Optional clean slate. Only runs when SMOKE_RESET=1, so the script is safe to point at
# an environment you care about by default. It clears platform state, never schema.
if [ "${SMOKE_RESET:-0}" = "1" ]; then
  printf '\033[1mResetting platform tables\033[0m\n'
  sudo docker exec "${PG_CONTAINER:-phirst-pg}" psql -U "${PG_USER:-phirst}" -d "${PG_DB:-phirst}" -q -c "
    TRUNCATE messages, threads, reactions, comments, posts, moderation_notices,
             moderation_actions, appeals, content_reports, invites, broker_catalog,
             platform_flags, telegram_updates, telegram_links, telegram_link_codes,
             audit_log, sessions, users RESTART IDENTITY CASCADE;" >/dev/null 2>&1 \
    && printf '  cleared\n' || printf '  (reset skipped: container unavailable)\n'
fi
say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
# check <description> <expected-substring> <actual>
check() { case "$3" in *"$2"*) ok "$1";; *) bad "$1 (got: ${3:0:160})";; esac; }

say "1. Owner setup"
R=$(curl -s -c "$OWNER" -X POST "$B/api/auth/setup" -H 'Content-Type: application/json' \
  -d '{"username":"baelay","password":"baelay_secure_pw_2026"}')
check "owner account created" '"ok":true' "$R"

say "2. Second owner setup must be refused"
R=$(curl -s -X POST "$B/api/auth/setup" -H 'Content-Type: application/json' -d '{"username":"imposter","password":"imposterpassword1"}')
check "setup refused once an owner exists" 'already exists' "$R"

say "3. Unauthenticated access is refused"
R=$(curl -s "$B/api/admin/overview")
check "admin requires a session" 'Authentication required' "$R"

say "4. Owner can create an invite"
R=$(curl -s -b "$OWNER" -X POST "$B/api/admin/invites" -H 'Content-Type: application/json' -d '{"note":"smoke test","expiresInDays":1}')
check "invite created" '"state":"available"' "$R"
CODE=$(printf '%s' "$R" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p')

say "5. Member registers with the invite"
R=$(curl -s -c "$MEMBER" -X POST "$B/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"member1\",\"password\":\"member_password_2026\",\"inviteCode\":\"$CODE\",\"displayName\":\"Member One\"}")
check "member registered" '"role":"member"' "$R"

say "6. Invite cannot be reused"
R=$(curl -s -X POST "$B/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"member2\",\"password\":\"member_password_2026\",\"inviteCode\":\"$CODE\"}")
check "reused invite refused" 'invalid, already used' "$R"

say "7. Role enforcement: member cannot reach owner routes"
R=$(curl -s -b "$MEMBER" "$B/api/admin/overview")
check "member blocked from admin" 'Owner permission required' "$R"
R=$(curl -s -b "$MEMBER" -X PUT "$B/api/admin/live-trading" -H 'Content-Type: application/json' -d '{"enabled":true,"confirmation":"ENABLE GLOBAL LIVE TRADING"}')
check "member blocked from live switch" 'Owner permission required' "$R"

say "8. Owner can read the admin overview"
R=$(curl -s -b "$OWNER" "$B/api/admin/overview")
check "overview readable" '"members":2' "$R"
check "live trading defaults off" '"liveTradingEnabled":false' "$R"

say "9. Global live switch requires the exact phrase"
R=$(curl -s -b "$OWNER" -X PUT "$B/api/admin/live-trading" -H 'Content-Type: application/json' -d '{"enabled":true,"confirmation":"yes"}')
check "wrong phrase refused" 'exact phrase' "$R"
R=$(curl -s -b "$OWNER" -X PUT "$B/api/admin/live-trading" -H 'Content-Type: application/json' -d '{"enabled":true,"confirmation":"ENABLE GLOBAL LIVE TRADING"}')
check "correct phrase accepted" '"liveTradingEnabled":true' "$R"
curl -s -b "$OWNER" -X PUT "$B/api/admin/live-trading" -H 'Content-Type: application/json' -d '{"enabled":false}' >/dev/null

say "10. PHIRST2 moderation blocks a scam post"
R=$(curl -s -b "$MEMBER" -X POST "$B/api/community/posts" -H 'Content-Type: application/json' \
  -d '{"text":"send 1 btc to my wallet and I will double your money"}')
check "scam blocked" 'blocked by PHIRST2 moderation' "$R"

say "11. Moderation is recorded and reversible"
R=$(curl -s -b "$OWNER" "$B/api/admin/moderation")
check "action logged with evidence" '"automated":true' "$R"
AID=$(printf '%s' "$R" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
R=$(curl -s -b "$OWNER" -X POST "$B/api/admin/moderation/$AID/revert")
check "action reverted" '"ok":true' "$R"

say "12. Member's own moderation notice is visible"
R=$(curl -s -b "$MEMBER" "$B/api/community/moderation")
check "notice delivered to member" 'PHIRST2 removed your post' "$R"

say "13. Ordinary post succeeds"
R=$(curl -s -b "$MEMBER" -X POST "$B/api/community/posts" -H 'Content-Type: application/json' \
  -d '{"text":"Watching R_100 on the 15m. Patience is the edge."}')
check "post accepted" '"ok":true' "$R"
PID=$(printf '%s' "$R" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)

say "14. Likes and comments work"
R=$(curl -s -b "$OWNER" -X POST "$B/api/community/posts/$PID/like")
check "like toggled on" '"liked":true' "$R"
R=$(curl -s -b "$OWNER" -X POST "$B/api/community/posts/$PID/comments" -H 'Content-Type: application/json' -d '{"text":"Agreed."}')
check "comment created" '"ok":true' "$R"

say "15. Private messaging is member-scoped"
R=$(curl -s -b "$MEMBER" -X POST "$B/api/community/threads" -H 'Content-Type: application/json' -d '{"username":"baelay"}')
check "thread created" '"threadId"' "$R"
TID=$(printf '%s' "$R" | sed -n 's/.*"threadId":"\([^"]*\)".*/\1/p')
R=$(curl -s -b "$MEMBER" -X POST "$B/api/community/threads/$TID/messages" -H 'Content-Type: application/json' -d '{"text":"Morning."}')
check "message sent" '"ok":true' "$R"

say "16. Suspension removes access"
MID=$(curl -s -b "$OWNER" "$B/api/admin/members" | sed -n 's/.*"username":"member1".*//p')
R=$(curl -s -b "$OWNER" "$B/api/community/members")
MID=$(printf '%s' "$R" | python3 -c 'import sys,json;print([m["id"] for m in json.load(sys.stdin)["members"] if m["username"]=="member1"][0])')
R=$(curl -s -b "$OWNER" -X PUT "$B/api/admin/members/$MID/suspension" -H 'Content-Type: application/json' -d '{"suspended":true,"reason":"smoke test suspension"}')
check "member suspended" '"ok":true' "$R"
R=$(curl -s -b "$MEMBER" "$B/api/auth/me")
check "suspended member is unauthorised" 'not active' "$R"
R=$(curl -s -b "$OWNER" -X PUT "$B/api/admin/members/$MID/suspension" -H 'Content-Type: application/json' -d '{"suspended":false}')
check "member restored" '"ok":true' "$R"

say "17. Engine status and paper mode"
R=$(curl -s -b "$OWNER" "$B/api/engine/status")
check "engine reports paper mode" '"mode":"paper"' "$R"
check "engine reports a trading mode" '"tradingMode":"manual"' "$R"

say "18. Trading authority is a real, persisted axis"
R=$(curl -s -b "$OWNER" -X POST "$B/api/engine/trading-mode" -H 'Content-Type: application/json' -d '{"mode":"nonsense"}')
check "unknown trading mode is refused" 'mode must be' "$R"
R=$(curl -s -b "$OWNER" -X POST "$B/api/engine/trading-mode" -H 'Content-Type: application/json' -d '{"mode":"approval"}')
check "authority can be set to approval" '"ok":true' "$R"
R=$(curl -s -b "$OWNER" "$B/api/engine/status")
check "status reflects the new authority" '"tradingMode":"approval"' "$R"
R=$(curl -s -b "$OWNER" -X POST "$B/api/engine/trading-mode" -H 'Content-Type: application/json' -d '{"mode":"manual"}')
check "authority can be returned to manual" '"ok":true' "$R"

say "19. Proposals are owner-only and decision-safe"
R=$(curl -s "$B/api/proposals")
check "proposals require a session" 'Authentication required' "$R"
R=$(curl -s -b "$MEMBER" "$B/api/proposals")
check "proposals are owner-only" 'Owner permission required' "$R"
# A proposal that does not exist can be decided neither way.
R=$(curl -s -b "$OWNER" -X POST "$B/api/proposals/does-not-exist/approve")
check "unknown proposal cannot be approved" '"ok":false' "$R"
R=$(curl -s -b "$OWNER" -X POST "$B/api/proposals/does-not-exist/reject")
check "unknown proposal cannot be rejected" '"ok":false' "$R"

say "20. The trading surface is owner-only"
# A member must not be able to control the engine, read the owner's account, or reach
# broker, risk, strategy, AI-memory or Telegram controls.
for ep in "engine/status" "orders" "positions" "equity" "risk" "strategies" \
          "reports/performance" "notifications" "brokers" "brokers/providers" \
          "audit" "verdicts" "phirst/memory" "phirst/voice" "telegram/status"; do
  R=$(curl -s -b "$MEMBER" "$B/api/$ep")
  check "member cannot read /api/$ep" 'Owner permission required' "$R"
done
for ep in "engine/start" "engine/pause" "engine/emergency-stop" "engine/trading-mode" \
          "engine/auto-trade" "engine/mode" "engine/symbol" "engine/reconcile"; do
  R=$(curl -s -b "$MEMBER" -X POST "$B/api/$ep" -H 'Content-Type: application/json' -d '{}')
  check "member cannot POST /api/$ep" 'Owner permission required' "$R"
done
R=$(curl -s -b "$MEMBER" -X PUT "$B/api/risk" -H 'Content-Type: application/json' -d '{}')
check "member cannot write risk" 'Owner permission required' "$R"

printf '\n\033[1m%s\033[0m\n' "RESULT: $pass passed, $fail failed"
rm -rf "$TMP"
exit $((fail > 0))
