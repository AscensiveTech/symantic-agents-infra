#!/usr/bin/env bash
set -euo pipefail

# Controlled production-path verification for the Monday CRM integration.
#
# This test intentionally changes external state: it creates a temporary
# monday board, maps the receptionist workspace to it, sends signed synthetic
# Retell call_analyzed webhooks through the deployed post-call Lambda, and
# then removes the board, call/link rows, mapping, and OAuth connection.
# Nothing runs unless the operator opts in explicitly.

if [[ "${MONDAY_LIVE_E2E:-}" != "1" ]]; then
  echo "Refusing to run. Set MONDAY_LIVE_E2E=1 after reviewing this script." >&2
  exit 2
fi

AWS_REGION_NAME="${AWS_REGION_NAME:-us-east-1}"
WORKSPACE_ID="${WORKSPACE_ID:-workspace-symantic-ai}"
ADMIN_SUB="${ADMIN_SUB:-344894c8-a081-70e0-4819-0f0a7fe9d533}"
ADMIN_NAME="${ADMIN_NAME:-Monday live E2E operator}"
CRM_FUNCTION="${CRM_FUNCTION:-symantic-dev-crm:live}"
POSTCALL_FUNCTION="${POSTCALL_FUNCTION:-symantic-dev-postcall}"
CONNECTIONS_TABLE="${CONNECTIONS_TABLE:-symantic-dev-crm-connections}"
CALLS_TABLE="${CALLS_TABLE:-symantic-dev-calls}"
LINKS_TABLE="${LINKS_TABLE:-symantic-dev-crm-links}"
QUEUE_URL="${QUEUE_URL:-https://sqs.us-east-1.amazonaws.com/883155611064/symantic-dev-crm-sync}"
RETELL_SECRET_ID="${RETELL_SECRET_ID:-symantic/dev/retell}"
MONDAY_API_VERSION="${MONDAY_API_VERSION:-2026-07}"
TEST_PHONE="${TEST_PHONE:-+12025550177}"
TEST_EMAIL="${TEST_EMAIL:-receptionist-e2e@example.test}"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BOARD_NAME="TEST_RECEPTIONIST_E2E_${RUN_ID}"
CALLER_NAME="TEST_RECEPTIONIST_CUSTOMER_${RUN_ID}"
RETELL_CALL_1="test_monday_e2e_${RUN_ID}_1"
RETELL_CALL_2="test_monday_e2e_${RUN_ID}_2"
TMP_DIR="$(mktemp -d /tmp/monday-live-e2e.XXXXXX)"
BOARD_ID=""
ACCESS_TOKEN=""
CALL_ID_1=""
CALL_ID_2=""
CLEANED="false"

pass() { printf 'PASS\t%s\t%s\n' "$1" "$2"; }
fail() { printf 'FAIL\t%s\t%s\n' "$1" "$2" >&2; exit 1; }
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

safe_remove_tmp() {
  case "$TMP_DIR" in
    /tmp/monday-live-e2e.*) rm -rf -- "$TMP_DIR" ;;
    *) echo "Refusing to remove unexpected temp path: $TMP_DIR" >&2 ;;
  esac
}

monday_request() {
  local query="$1"
  local variables="$2"
  local request_file="$TMP_DIR/monday-request.json"
  local response_file="$TMP_DIR/monday-response.json"
  jq -n --arg query "$query" --argjson variables "$variables" \
    '{query:$query,variables:$variables}' >"$request_file"
  curl --silent --show-error --fail-with-body \
    --request POST 'https://api.monday.com/v2' \
    --header 'content-type: application/json' \
    --header "api-version: $MONDAY_API_VERSION" \
    --header "authorization: Bearer $ACCESS_TOKEN" \
    --data-binary "@$request_file" >"$response_file"
  if jq -e '.errors and (.errors | length > 0)' "$response_file" >/dev/null; then
    jq '{errors:[.errors[]|{code:(.extensions.code // .extensions.error_code // "unknown"),message:(.message|tostring|.[0:160])}]}' "$response_file" >&2
    return 1
  fi
  cat "$response_file"
}

identity_event() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  jq -n \
    --arg method "$method" \
    --arg path "$path" \
    --arg sub "$ADMIN_SUB" \
    --arg name "$ADMIN_NAME" \
    --arg body "$body" \
    '{
      version:"2.0",
      rawPath:$path,
      requestContext:{
        http:{method:$method,path:$path},
        authorizer:{jwt:{claims:{sub:$sub,username:$sub,name:$name,"cognito:groups":"[super-admin]"}}}
      }
    } + (if $body == "" then {} else {body:$body,isBase64Encoded:false} end)'
}

invoke_crm_api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local payload_file="$TMP_DIR/crm-event.json"
  local response_file="$TMP_DIR/crm-response.json"
  identity_event "$method" "$path" "$body" >"$payload_file"
  aws lambda invoke \
    --region "$AWS_REGION_NAME" \
    --function-name "$CRM_FUNCTION" \
    --cli-binary-format raw-in-base64-out \
    --payload "fileb://$payload_file" \
    "$response_file" >/dev/null
  cat "$response_file"
}

call_id_for() {
  local retell_call_id="$1"
  local digest
  digest="$(printf '%s\0%s' "$WORKSPACE_ID" "$retell_call_id" | shasum -a 256 | awk '{print $1}')"
  printf 'call-%s' "${digest:0:24}"
}

retell_signature() {
  local body_file="$1"
  local timestamp="$2"
  local api_key="$3"
  RETELL_E2E_KEY="$api_key" RETELL_E2E_BODY_FILE="$body_file" RETELL_E2E_TS="$timestamp" \
    node -e 'const fs=require("fs"),c=require("crypto");const b=fs.readFileSync(process.env.RETELL_E2E_BODY_FILE,"utf8");process.stdout.write(c.createHmac("sha256",process.env.RETELL_E2E_KEY).update(b+process.env.RETELL_E2E_TS).digest("hex"));'
}

invoke_postcall() {
  local body_file="$1"
  local signature="$2"
  local event_file="$TMP_DIR/postcall-event.json"
  local response_file="$TMP_DIR/postcall-response.json"
  jq -n --rawfile body "$body_file" --arg signature "$signature" '{
    version:"2.0",
    rawPath:"/retell/webhooks/call-ended",
    requestContext:{http:{method:"POST",path:"/retell/webhooks/call-ended"}},
    headers:{"x-retell-signature":$signature},
    body:$body,
    isBase64Encoded:false
  }' >"$event_file"
  aws lambda invoke \
    --region "$AWS_REGION_NAME" \
    --function-name "$POSTCALL_FUNCTION" \
    --cli-binary-format raw-in-base64-out \
    --payload "fileb://$event_file" \
    "$response_file" >/dev/null
  cat "$response_file"
}

wait_for_sync() {
  local call_id="$1"
  local deadline=$((SECONDS + 75))
  local status=""
  while (( SECONDS < deadline )); do
    aws dynamodb get-item \
      --region "$AWS_REGION_NAME" \
      --table-name "$CALLS_TABLE" \
      --key "{\"workspaceId\":{\"S\":\"$WORKSPACE_ID\"},\"callId\":{\"S\":\"$call_id\"}}" \
      --consistent-read \
      --output json >"$TMP_DIR/call-row.json"
    status="$(jq -r '.Item.crmStatus.S // ""' "$TMP_DIR/call-row.json")"
    case "$status" in
      synced) return 0 ;;
      failed) return 1 ;;
    esac
    sleep 2
  done
  return 1
}

cleanup() {
  local exit_code=$?
  trap - EXIT
  set +e
  if [[ -n "$BOARD_ID" && -n "$ACCESS_TOKEN" ]]; then
    monday_request \
      'mutation ($board: ID!) { delete_board(board_id: $board) { id } }' \
      "$(jq -n --arg board "$BOARD_ID" '{board:$board}')" >/dev/null 2>&1
  fi
  for call_id in "$CALL_ID_1" "$CALL_ID_2"; do
    if [[ -n "$call_id" ]]; then
      aws dynamodb delete-item --region "$AWS_REGION_NAME" --table-name "$CALLS_TABLE" \
        --key "{\"workspaceId\":{\"S\":\"$WORKSPACE_ID\"},\"callId\":{\"S\":\"$call_id\"}}" >/dev/null 2>&1
    fi
  done
  aws dynamodb delete-item --region "$AWS_REGION_NAME" --table-name "$LINKS_TABLE" \
    --key "{\"workspaceId\":{\"S\":\"$WORKSPACE_ID\"},\"linkKey\":{\"S\":\"monday#$TEST_PHONE\"}}" >/dev/null 2>&1
  invoke_crm_api DELETE /crm/connection >/dev/null 2>&1
  aws dynamodb update-item --region "$AWS_REGION_NAME" --table-name "$CONNECTIONS_TABLE" \
    --key "{\"workspaceId\":{\"S\":\"$WORKSPACE_ID\"},\"provider\":{\"S\":\"monday\"}}" \
    --update-expression 'SET mappingStatus = :unconfigured REMOVE mapping, mappingProblems, lastSyncAt, lastSyncStatus, lastErrorCode, lastErrorAt, pausedUntil, pauseReason' \
    --expression-attribute-values '{":unconfigured":{"S":"unconfigured"}}' >/dev/null 2>&1
  CLEANED="true"
  safe_remove_tmp
  if [[ $exit_code -eq 0 ]]; then
    pass cleanup "temporary monday board, OAuth grant, calls, link, and mapping removed"
  else
    echo "Cleanup attempted after failure; inspect the named test board if cleanup reported an error." >&2
  fi
  exit "$exit_code"
}
trap cleanup EXIT

aws dynamodb get-item \
  --region "$AWS_REGION_NAME" \
  --table-name "$CONNECTIONS_TABLE" \
  --key "{\"workspaceId\":{\"S\":\"$WORKSPACE_ID\"},\"provider\":{\"S\":\"monday\"}}" \
  --consistent-read >"$TMP_DIR/connection.json"

printf 'RUN\t%s\n' "$RUN_ID"
printf 'ACCOUNT\t%s (%s)\n' \
  "$(jq -r '.Item.accountName.S // "unknown"' "$TMP_DIR/connection.json")" \
  "$(jq -r '.Item.connectionState.S // "missing"' "$TMP_DIR/connection.json")"

[[ "$(jq -r '.Item.connectionState.S // ""' "$TMP_DIR/connection.json")" == "connected" ]] \
  || fail authentication "workspace has no connected monday account"

printf '%s' "$(jq -r '.Item.encryptedAccessToken.S' "$TMP_DIR/connection.json")" \
  | openssl base64 -d -A >"$TMP_DIR/access-token.cipher"
PLAINTEXT_B64="$(aws kms decrypt \
  --region "$AWS_REGION_NAME" \
  --ciphertext-blob "fileb://$TMP_DIR/access-token.cipher" \
  --encryption-context "workspaceId=$WORKSPACE_ID,provider=monday,purpose=access" \
  --query Plaintext --output text)"
ACCESS_TOKEN="$(printf '%s' "$PLAINTEXT_B64" | openssl base64 -d -A)"
unset PLAINTEXT_B64
[[ -n "$ACCESS_TOKEN" ]] || fail authentication "decrypted access token was empty"
pass authentication "OAuth token stored with KMS encryption and usable only in its workspace context"

START_MS="$(now_ms)"
CREATE_BOARD_RESPONSE="$(monday_request \
  'mutation ($name: String!) { create_board(board_name: $name, board_kind: public) { id name } }' \
  "$(jq -n --arg name "$BOARD_NAME" '{name:$name}')")"
BOARD_ID="$(jq -r '.data.create_board.id // ""' <<<"$CREATE_BOARD_RESPONSE")"
[[ -n "$BOARD_ID" ]] || fail board_setup "monday did not return a board id"

declare -a COLUMN_SPECS=(
  'test_phone|Phone|phone'
  'test_email|Email|email'
  'test_status|Lead Status|status'
  'test_owner|Owner|people'
  'test_last_call|Last Call|date'
  'test_outcome|Call Outcome|long_text'
  'test_follow_up|Follow-up Date|date'
  'test_appt|Next Appointment|date'
  'test_source|Lead Source|text'
)
for spec in "${COLUMN_SPECS[@]}"; do
  IFS='|' read -r column_id column_title column_type <<<"$spec"
  monday_request \
    "mutation (\$board: ID!, \$title: String!, \$id: String!) { create_column(board_id: \$board, title: \$title, column_type: $column_type, id: \$id) { id } }" \
    "$(jq -n --arg board "$BOARD_ID" --arg title "$column_title" --arg id "$column_id" '{board:$board,title:$title,id:$id}')" >/dev/null
done
pass board_setup "temporary board and nine mapped columns created in $(( $(now_ms) - START_MS )) ms"

START_MS="$(now_ms)"
BOARDS_RESPONSE="$(invoke_crm_api GET /crm/monday/boards)"
[[ "$(jq -r '.statusCode' <<<"$BOARDS_RESPONSE")" == "200" ]] \
  || fail board_discovery "deployed CRM API did not return 200"
BOARDS_BODY="$(jq -r '.body' <<<"$BOARDS_RESPONSE")"
BOARD="$(jq --arg name "$BOARD_NAME" '.boards[] | select(.name == $name)' <<<"$BOARDS_BODY")"
[[ -n "$BOARD" ]] || fail board_discovery "temporary board was absent from the deployed API response"
[[ "$(jq -r '.hasPhoneColumn' <<<"$BOARD")" == "true" ]] \
  || fail board_discovery "phone column was not identified"
pass board_discovery "real board and columns parsed through deployed CRM API in $(( $(now_ms) - START_MS )) ms"

STATUS_NEW="$(jq -r '[.columns[]|select(.id=="test_status")|.labels[]][0] // empty' <<<"$BOARD")"
STATUS_FOLLOW="$(jq -r '[.columns[]|select(.id=="test_status")|.labels[]][1] // empty' <<<"$BOARD")"
OWNER_ID="$(jq -r '.users[0].id // empty' <<<"$BOARDS_BODY")"
[[ -n "$STATUS_NEW" && -n "$STATUS_FOLLOW" ]] \
  || fail mapping "test status column did not expose at least two labels"

MAPPING="$(jq -n \
  --arg board "$BOARD_ID" \
  --arg newLabel "$STATUS_NEW" \
  --arg followLabel "$STATUS_FOLLOW" \
  --arg owner "$OWNER_ID" \
  '{
    boardId:$board,
    columns:{
      phone:{id:"test_phone"},email:{id:"test_email"},status:{id:"test_status"},
      owner:{id:"test_owner"},lastCall:{id:"test_last_call"},outcome:{id:"test_outcome"},
      followUpDate:{id:"test_follow_up"},nextAppointment:{id:"test_appt"},source:{id:"test_source"}
    },
    labels:{newLead:$newLabel,followUp:$followLabel},
    defaultOwnerId:(if $owner=="" then null else $owner end)
  }')"
MAPPING_RESPONSE="$(invoke_crm_api PUT /crm/mapping "$(jq -n --argjson mapping "$MAPPING" '{mapping:$mapping}' | jq -c .)")"
[[ "$(jq -r '.statusCode' <<<"$MAPPING_RESPONSE")" == "200" ]] \
  || fail mapping "deployed mapping endpoint rejected a valid live mapping"
pass mapping "live board schema validated and mapping persisted"

# An arbitrary board id must fail without replacing the valid mapping.
INVALID_MAPPING="$(jq -n '{mapping:{boardId:"99999999999999999999",columns:{phone:{id:"test_phone"}},labels:{newLead:null,followUp:null},defaultOwnerId:null}}' | jq -c .)"
INVALID_RESPONSE="$(invoke_crm_api PUT /crm/mapping "$INVALID_MAPPING")"
INVALID_STATUS="$(jq -r '.statusCode' <<<"$INVALID_RESPONSE")"
[[ "$INVALID_STATUS" == "502" || "$INVALID_STATUS" == "422" ]] \
  || fail invalid_mapping "unexpected status $INVALID_STATUS"
STORED_BOARD="$(aws dynamodb get-item --region "$AWS_REGION_NAME" --table-name "$CONNECTIONS_TABLE" --key "{\"workspaceId\":{\"S\":\"$WORKSPACE_ID\"},\"provider\":{\"S\":\"monday\"}}" --consistent-read --projection-expression 'mapping' --output json | jq -r '.Item.mapping.M.boardId.S // empty')"
[[ "$STORED_BOARD" == "$BOARD_ID" ]] || fail invalid_mapping "invalid request replaced the valid mapping"
pass invalid_mapping "provider rejection was controlled and the valid mapping was preserved"

RETELL_API_KEY="$(aws secretsmanager get-secret-value --region "$AWS_REGION_NAME" --secret-id "$RETELL_SECRET_ID" --query SecretString --output text | jq -r '.apiKey // .api_key // empty')"
[[ -n "$RETELL_API_KEY" ]] || fail postcall "Retell signing key is unavailable"

CALL_ID_1="$(call_id_for "$RETELL_CALL_1")"
CALL_BODY_1="$TMP_DIR/call-1.json"
NOW_EPOCH_MS="$(now_ms)"
jq -n \
  --arg callId "$RETELL_CALL_1" \
  --arg workspace "$WORKSPACE_ID" \
  --arg phone "$TEST_PHONE" \
  --arg caller "$CALLER_NAME" \
  --arg email "$TEST_EMAIL" \
  --argjson at "$NOW_EPOCH_MS" \
  '{event:"call_analyzed",call:{
    call_id:$callId,call_type:"phone_call",direction:"inbound",from_number:$phone,
    start_timestamp:$at,end_timestamp:$at,duration_ms:0,
    metadata:{workspaceId:$workspace,callerName:$caller,intent:"Pricing enquiry"},
    transcript_object:[{role:"user",content:("My name is " + $caller + ". Please call me about pricing.")}],
    transcript_with_tool_calls:[
      {role:"tool_call_invocation",tool_call_id:"lead-1",name:"lead_capture",arguments:({name:$caller,email:$email,interest:"Pricing",notes:"Live E2E test"}|tojson)},
      {role:"tool_call_result",tool_call_id:"lead-1",content:"{\"ok\":true}",successful:true}
    ],
    call_analysis:{call_summary:"Controlled monday E2E lead creation test",call_successful:true,user_sentiment:"Neutral"}
  }}' >"$CALL_BODY_1"
SIGN_TS="$(now_ms)"
SIGNATURE="v=$SIGN_TS,d=$(retell_signature "$CALL_BODY_1" "$SIGN_TS" "$RETELL_API_KEY")"
START_MS="$(now_ms)"
POSTCALL_RESPONSE="$(invoke_postcall "$CALL_BODY_1" "$SIGNATURE")"
[[ "$(jq -r '.statusCode' <<<"$POSTCALL_RESPONSE")" == "204" ]] \
  || fail postcall "signed call_analyzed webhook was rejected"
wait_for_sync "$CALL_ID_1" || fail create_lead "CRM worker did not sync the first call"
FIRST_ITEM_ID="$(jq -r '.Item.crmItemId.S // empty' "$TMP_DIR/call-row.json")"
[[ -n "$FIRST_ITEM_ID" && "$(jq -r '.Item.crmCreated.BOOL // false' "$TMP_DIR/call-row.json")" == "true" ]] \
  || fail create_lead "worker did not record a newly created monday item"
pass create_lead "signed post-call webhook -> SQS -> worker -> real monday item in $(( $(now_ms) - START_MS )) ms"

ITEM_RESPONSE="$(monday_request \
  'query ($ids: [ID!]) { items(ids: $ids) { id name column_values { id text value } updates(limit: 10) { id text_body } } }' \
  "$(jq -n --arg item "$FIRST_ITEM_ID" '{ids:[$item]}')")"
ITEM="$(jq '.data.items[0]' <<<"$ITEM_RESPONSE")"
[[ "$(jq -r '.name' <<<"$ITEM")" == "$CALLER_NAME" ]] || fail data_integrity "monday item name changed unexpectedly"
[[ "$(jq -r '[.column_values[]|select(.id=="test_email")|.text][0] // empty' <<<"$ITEM")" == "$TEST_EMAIL" ]] \
  || fail data_integrity "email was not preserved"
[[ -n "$(jq -r '[.column_values[]|select(.id=="test_phone")|.text][0] // empty' <<<"$ITEM")" ]] \
  || fail data_integrity "phone was not stored"
[[ "$(jq -r '.updates|length' <<<"$ITEM")" == "1" ]] || fail data_integrity "expected exactly one call note after create"
pass data_integrity "name, phone, email, mapped fields, item id, and first note verified directly in monday"

LOOKUP_RESPONSE_FILE="$TMP_DIR/lookup-response.json"
aws lambda invoke --region "$AWS_REGION_NAME" --function-name "$CRM_FUNCTION" \
  --cli-binary-format raw-in-base64-out \
  --payload "$(jq -cn --arg workspace "$WORKSPACE_ID" --arg phone "$TEST_PHONE" '{action:"lookup",workspaceId:$workspace,callerNumber:$phone}')" \
  "$LOOKUP_RESPONSE_FILE" >/dev/null
[[ "$(jq -r '.status' "$LOOKUP_RESPONSE_FILE")" == "found" ]] \
  || fail lookup "deployed call-time lookup did not find the live record"
grep -F "$CALLER_NAME" "$LOOKUP_RESPONSE_FILE" >/dev/null \
  || fail lookup "lookup context omitted the verified customer name"
pass lookup "deployed call-time lookup returned grounded monday context"

CALL_ID_2="$(call_id_for "$RETELL_CALL_2")"
CALL_BODY_2="$TMP_DIR/call-2.json"
NOW_EPOCH_MS="$(( $(now_ms) + 1000 ))"
jq -n \
  --arg callId "$RETELL_CALL_2" \
  --arg workspace "$WORKSPACE_ID" \
  --arg phone "$TEST_PHONE" \
  --arg caller "$CALLER_NAME" \
  --argjson at "$NOW_EPOCH_MS" \
  '{event:"call_analyzed",call:{
    call_id:$callId,call_type:"phone_call",direction:"inbound",from_number:$phone,
    start_timestamp:$at,end_timestamp:$at,duration_ms:0,
    metadata:{workspaceId:$workspace,callerName:$caller,intent:"Callback requested"},
    transcript_object:[{role:"user",content:"Please ask someone to call me tomorrow about pricing."}],
    transcript_with_tool_calls:[
      {role:"tool_call_invocation",tool_call_id:"message-1",name:"message_take",arguments:"{\"message\":\"Call tomorrow about pricing\"}"},
      {role:"tool_call_result",tool_call_id:"message-1",content:"{\"ok\":true}",successful:true}
    ],
    call_analysis:{call_summary:"Controlled monday E2E follow-up test",call_successful:true,user_sentiment:"Neutral"}
  }}' >"$CALL_BODY_2"
SIGN_TS="$(now_ms)"
SIGNATURE="v=$SIGN_TS,d=$(retell_signature "$CALL_BODY_2" "$SIGN_TS" "$RETELL_API_KEY")"
START_MS="$(now_ms)"
POSTCALL_RESPONSE="$(invoke_postcall "$CALL_BODY_2" "$SIGNATURE")"
[[ "$(jq -r '.statusCode' <<<"$POSTCALL_RESPONSE")" == "204" ]] || fail follow_up "second signed webhook was rejected"
wait_for_sync "$CALL_ID_2" || fail follow_up "CRM worker did not sync the follow-up call"
SECOND_ITEM_ID="$(jq -r '.Item.crmItemId.S // empty' "$TMP_DIR/call-row.json")"
[[ "$SECOND_ITEM_ID" == "$FIRST_ITEM_ID" ]] || fail duplicate_handling "same phone created a second item"
[[ "$(jq -r '.Item.crmCreated.BOOL // false' "$TMP_DIR/call-row.json")" == "false" ]] \
  || fail duplicate_handling "second call was marked as a create"

ITEM_RESPONSE="$(monday_request \
  'query ($ids: [ID!]) { items(ids: $ids) { id column_values { id text value } updates(limit: 10) { id text_body } } }' \
  "$(jq -n --arg item "$FIRST_ITEM_ID" '{ids:[$item]}')")"
ITEM="$(jq '.data.items[0]' <<<"$ITEM_RESPONSE")"
[[ "$(jq -r '.updates|length' <<<"$ITEM")" == "2" ]] || fail follow_up "expected two notes after two distinct calls"
[[ -n "$(jq -r '[.column_values[]|select(.id=="test_follow_up")|.text][0] // empty' <<<"$ITEM")" ]] \
  || fail follow_up "follow-up date was not written"
[[ "$(jq -r '[.column_values[]|select(.id=="test_status")|.text][0] // empty' <<<"$ITEM")" == "$STATUS_FOLLOW" ]] \
  || fail follow_up "follow-up status was not written"
pass follow_up "existing item reused; callback note, status, outcome, and follow-up date updated in $(( $(now_ms) - START_MS )) ms"
pass duplicate_handling "two calls from the same phone resolved to one monday item"

# Retell retry: same analyzed event must not enqueue or add a third note.
POSTCALL_RESPONSE="$(invoke_postcall "$CALL_BODY_2" "$SIGNATURE")"
[[ "$(jq -r '.statusCode' <<<"$POSTCALL_RESPONSE")" == "204" ]] || fail idempotency "duplicate webhook was rejected"
sleep 4
ITEM_RESPONSE="$(monday_request \
  'query ($ids: [ID!]) { items(ids: $ids) { id updates(limit: 10) { id } } }' \
  "$(jq -n --arg item "$FIRST_ITEM_ID" '{ids:[$item]}')")"
[[ "$(jq -r '.data.items[0].updates|length' <<<"$ITEM_RESPONSE")" == "2" ]] \
  || fail idempotency "duplicate webhook created another note"
pass idempotency "replayed post-call webhook created no duplicate item or note"

# A bad signature must fail before any payload processing.
BAD_EVENT="$TMP_DIR/postcall-bad-event.json"
jq -n --rawfile body "$CALL_BODY_2" '{
  version:"2.0",rawPath:"/retell/webhooks/call-ended",
  requestContext:{http:{method:"POST",path:"/retell/webhooks/call-ended"}},
  headers:{"x-retell-signature":"v=1,d=00"},body:$body,isBase64Encoded:false
}' >"$BAD_EVENT"
aws lambda invoke --region "$AWS_REGION_NAME" --function-name "$POSTCALL_FUNCTION" \
  --cli-binary-format raw-in-base64-out --payload "fileb://$BAD_EVENT" "$TMP_DIR/postcall-bad-response.json" >/dev/null
[[ "$(jq -r '.statusCode' "$TMP_DIR/postcall-bad-response.json")" == "401" ]] \
  || fail webhook_security "invalid signature was not rejected"
pass webhook_security "forged Retell webhook rejected with 401"

# Another tenant's valid member identity must not inherit this connection.
jq -n '{
  version:"2.0",rawPath:"/crm/monday/boards",
  requestContext:{http:{method:"GET",path:"/crm/monday/boards"},authorizer:{jwt:{claims:{
    sub:"2428e4f8-c041-70d3-a1b1-6cc9f1ab378f",username:"2428e4f8-c041-70d3-a1b1-6cc9f1ab378f",name:"Tenant B","cognito:groups":"[company-admin]"
  }}}}
}' >"$TMP_DIR/cross-tenant-event.json"
aws lambda invoke --region "$AWS_REGION_NAME" --function-name "$CRM_FUNCTION" \
  --cli-binary-format raw-in-base64-out --payload "fileb://$TMP_DIR/cross-tenant-event.json" \
  "$TMP_DIR/cross-tenant-response.json" >/dev/null
[[ "$(jq -r '.statusCode' "$TMP_DIR/cross-tenant-response.json")" == "409" ]] \
  || fail tenant_isolation "Tenant B did not receive the expected not_connected response"
[[ "$(jq -r '.body|fromjson|.error' "$TMP_DIR/cross-tenant-response.json")" == "not_connected" ]] \
  || fail tenant_isolation "Tenant B received information about Tenant A's connection"
pass tenant_isolation "deliberate cross-tenant board access returned only not_connected"

# Force the scheduled keeper path to refresh without exposing either token.
# The keeper uses a separate $LATEST Lambda environment from the live alias,
# avoiding the live container's valid in-memory access-token cache.
VERSION_BEFORE="$(aws dynamodb get-item --region "$AWS_REGION_NAME" --table-name "$CONNECTIONS_TABLE" --key "{\"workspaceId\":{\"S\":\"$WORKSPACE_ID\"},\"provider\":{\"S\":\"monday\"}}" --consistent-read --projection-expression 'tokenVersion' --output json | jq -r '.Item.tokenVersion.N')"
aws dynamodb update-item --region "$AWS_REGION_NAME" --table-name "$CONNECTIONS_TABLE" \
  --key "{\"workspaceId\":{\"S\":\"$WORKSPACE_ID\"},\"provider\":{\"S\":\"monday\"}}" \
  --update-expression 'SET accessTokenExpiresAt = :expired' \
  --expression-attribute-values '{":expired":{"N":"1"}}' >/dev/null
KEEPER_FUNCTION="${CRM_FUNCTION%%:*}"
aws lambda invoke --region "$AWS_REGION_NAME" --function-name "$KEEPER_FUNCTION" \
  --cli-binary-format raw-in-base64-out --payload '{"action":"refresh-tokens"}' \
  "$TMP_DIR/keeper-response.json" >/dev/null
[[ "$(jq -r '.refreshed // 0' "$TMP_DIR/keeper-response.json")" -ge 1 ]] \
  || fail token_refresh "token keeper did not refresh the forced-expired connection"
VERSION_AFTER="$(aws dynamodb get-item --region "$AWS_REGION_NAME" --table-name "$CONNECTIONS_TABLE" --key "{\"workspaceId\":{\"S\":\"$WORKSPACE_ID\"},\"provider\":{\"S\":\"monday\"}}" --consistent-read --projection-expression 'tokenVersion' --output json | jq -r '.Item.tokenVersion.N')"
(( VERSION_AFTER > VERSION_BEFORE )) || fail token_refresh "token version did not advance"
pass token_refresh "expired access token refreshed and rotated without exposing tokens"

# Explicit cleanup happens through the EXIT trap, including provider revocation.
pass live_lifecycle "all live assertions completed; cleanup follows"
