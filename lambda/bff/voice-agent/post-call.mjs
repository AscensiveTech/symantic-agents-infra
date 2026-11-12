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

// Multi-location agents only: which location the call was about, read by
// lambda/postcall into the call record's `location` (Call History shows it).
export const LOCATION_ANALYSIS_FIELD_NAME = "location";
export const LOCATION_NOT_STATED = "Not stated";

export function buildPostCallAnalysis(cfg) {
  const fields = [{ ...SPAM_ANALYSIS_FIELD }];
  const names = (cfg?.business?.locations ?? []).map((location) => location.name).filter(Boolean);
  if (names.length > 1) {
    fields.push({
      type: "enum",
      name: LOCATION_ANALYSIS_FIELD_NAME,
      description: "Which of the business's locations the caller asked about or the call concerned. "
        + `"${LOCATION_NOT_STATED}" when no location came up.`,
      choices: [...new Set(names), LOCATION_NOT_STATED],
    });
  }
  return fields;
}
