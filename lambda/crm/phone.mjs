// Phone numbers are the join key between a caller and a CRM record, so they
// are always compared as E.164. CRMs store whatever a person typed; these
// helpers turn both sides into the same shape before comparing.

// Country calling code -> ISO-3166 alpha-2, for the markets we are likely to
// see. NANP (+1) is resolved separately because the US and Canada share it.
const CALLING_CODES = new Map([
  ["7", "RU"], ["20", "EG"], ["27", "ZA"], ["30", "GR"], ["31", "NL"],
  ["32", "BE"], ["33", "FR"], ["34", "ES"], ["36", "HU"], ["39", "IT"],
  ["40", "RO"], ["41", "CH"], ["43", "AT"], ["44", "GB"], ["45", "DK"],
  ["46", "SE"], ["47", "NO"], ["48", "PL"], ["49", "DE"], ["51", "PE"],
  ["52", "MX"], ["54", "AR"], ["55", "BR"], ["56", "CL"], ["57", "CO"],
  ["60", "MY"], ["61", "AU"], ["62", "ID"], ["63", "PH"], ["64", "NZ"],
  ["65", "SG"], ["66", "TH"], ["81", "JP"], ["82", "KR"], ["84", "VN"],
  ["86", "CN"], ["90", "TR"], ["91", "IN"], ["92", "PK"], ["234", "NG"],
  ["254", "KE"], ["351", "PT"], ["353", "IE"], ["354", "IS"], ["358", "FI"],
  ["852", "HK"], ["886", "TW"], ["966", "SA"], ["971", "AE"], ["972", "IL"],
]);

const ISO_TO_CALLING_CODE = new Map([
  ["US", "1"], ["CA", "1"],
  ...[...CALLING_CODES].map(([code, iso]) => [iso, code]),
]);

// Canadian NANP area codes. Everything else on +1 is treated as US, which is
// what libphonenumber-based validators (Monday's included) expect.
const CANADIAN_AREA_CODES = new Set([
  "204", "226", "236", "249", "250", "257", "263", "289", "306", "343", "354",
  "365", "367", "368", "382", "387", "403", "416", "418", "428", "431", "437",
  "438", "450", "460", "468", "474", "506", "514", "519", "548", "579", "581",
  "584", "587", "604", "613", "639", "647", "672", "683", "705", "709", "742",
  "753", "778", "780", "782", "807", "819", "825", "867", "873", "879", "902",
  "905",
]);

/**
 * Normalize a phone number to E.164, or return null. `defaultCountry` is the
 * ISO-2 code used for numbers written without a country code.
 */
export function toE164(raw, defaultCountry = "US") {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const text = String(raw).trim();
  if (!text) return null;
  const hasPlus = text.startsWith("+") || text.startsWith("00");
  let digits = text.replace(/\D/g, "");
  if (text.startsWith("00")) digits = digits.slice(2);
  if (!digits) return null;

  if (!hasPlus) {
    const callingCode = ISO_TO_CALLING_CODE.get(String(defaultCountry).toUpperCase()) ?? "1";
    if (callingCode === "1") {
      if (digits.length === 10) digits = `1${digits}`;
      else if (!(digits.length === 11 && digits.startsWith("1"))) return null;
    } else if (!digits.startsWith(callingCode)) {
      digits = `${callingCode}${digits.replace(/^0+/, "")}`;
    }
  }
  if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) return null;
  if (digits.startsWith("1") && digits.length !== 11) return null;
  return `+${digits}`;
}

export function countryForE164(e164) {
  if (typeof e164 !== "string" || !e164.startsWith("+")) return null;
  const digits = e164.slice(1);
  if (digits.startsWith("1")) {
    return CANADIAN_AREA_CODES.has(digits.slice(1, 4)) ? "CA" : "US";
  }
  for (const length of [3, 2, 1]) {
    const iso = CALLING_CODES.get(digits.slice(0, length));
    if (iso) return iso;
  }
  return null;
}

/** The number without its country code - what a person usually types. */
export function nationalNumber(e164) {
  if (typeof e164 !== "string" || !e164.startsWith("+")) return null;
  const digits = e164.slice(1);
  if (digits.startsWith("1")) return digits.slice(1);
  for (const length of [3, 2, 1]) {
    if (CALLING_CODES.has(digits.slice(0, length))) return digits.slice(length);
  }
  return digits;
}

/** For logs: enough to tell two callers apart, never the whole number. */
export function maskPhone(value) {
  if (typeof value !== "string" || value.length < 4) return "***";
  return `***${value.slice(-4)}`;
}
