// Post-call analysis fields Retell extracts after each call
// (agent.post_call_analysis_data). Retell always adds its own call_summary,
// user_sentiment, and call_successful on top of these.
//
// Only fields something actually reads belong here: is_spam is read by
// lambda/postcall (inferOutcome) to label spam calls. Appointment, lead, and
// message outcomes are NOT extracted by the LLM - lambda/postcall derives
// them from the tool calls that really succeeded, which is more reliable than
// a model's recollection of the call.

export const SPAM_ANALYSIS_FIELD = Object.freeze({
  type: "boolean",
  name: "is_spam",
  description:
    "True if the caller was a robocall, automated system / IVR, or a telemarketer rather "
    + "than a genuine prospective or existing customer.",
});

export function buildPostCallAnalysis(_cfg) {
  return [{ ...SPAM_ANALYSIS_FIELD }];
}
