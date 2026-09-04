// Terms & Conditions / Privacy Policy acceptance - version-controlled, with an
// append-only audit trail (see docs/PRODUCT_SPEC.md). Pure logic + the seeded
// v1.0 placeholder content lives here; the DynamoDB reads/writes are in
// index.mjs's store, and the request handling + enforcement gate are in
// index.mjs.

export const LEGAL_DOCUMENT_TYPES = ["TERMS_AND_CONDITIONS", "PRIVACY_POLICY"];

export function isLegalDocumentType(value) {
  return LEGAL_DOCUMENT_TYPES.includes(value);
}

// camelCase keys used in the API response, mapped to the storage document type.
export const LEGAL_RESPONSE_KEYS = {
  TERMS_AND_CONDITIONS: "termsAndConditions",
  PRIVACY_POLICY: "privacyPolicy",
};

// Seeded once, the first time the legal endpoint or the gate runs against an
// empty table (a conditional write, so concurrent cold starts can't double it).
// PLACEHOLDER TEXT - not legal advice. Replace the content and bump the version
// (POST /platform/legal, super admin) before relying on this in production.
export const DEFAULT_LEGAL_DOCUMENTS = {
  TERMS_AND_CONDITIONS: {
    version: "v1.0",
    title: "Rapid Proposal — Terms & Conditions",
    effectiveFrom: "2026-09-04",
    content: [
      "PLACEHOLDER — these Terms & Conditions have not yet been reviewed by legal counsel.",
      "",
      "1. Acceptance. By accessing Rapid Proposal you agree to these Terms & Conditions and to the Privacy Policy.",
      "2. Use of the service. You may use Rapid Proposal only to create, manage, and send business proposals for your own organization.",
      "3. Your content. You retain ownership of the proposals, templates, and files you upload. You are responsible for their accuracy and for having the right to use them.",
      "4. Acceptable use. Do not use the service to store or send unlawful, infringing, or misleading material, and do not attempt to disrupt or gain unauthorized access to the service.",
      "5. Availability. The service is provided \"as is\". We aim for high availability but do not guarantee uninterrupted access.",
      "6. Changes. We may update these Terms & Conditions. When we do, you will be asked to accept the new version before continuing to use Rapid Proposal.",
      "7. Contact. Questions about these terms can be sent to your Rapid Proposal administrator.",
    ].join("\n"),
  },
  PRIVACY_POLICY: {
    version: "v1.0",
    title: "Rapid Proposal — Privacy Policy",
    effectiveFrom: "2026-09-04",
    content: [
      "PLACEHOLDER — this Privacy Policy has not yet been reviewed by legal counsel.",
      "",
      "1. What we collect. Account information (name, email, company), the proposal content you create, and basic technical data such as IP address and browser type.",
      "2. How we use it. To provide and secure the service, to generate and deliver your proposals, and to keep an audit record of policy acceptance.",
      "3. Sharing. Proposal PDFs are shared with the e-signature provider (SignWell) only when you send a proposal for signature. We do not sell personal data.",
      "4. Retention. Account and proposal data is retained for as long as your organization uses Rapid Proposal. Policy-acceptance audit records are retained for legal and compliance purposes.",
      "5. Your choices. Contact your Rapid Proposal administrator to access, correct, or delete your personal data, subject to applicable law.",
      "6. Changes. We may update this Privacy Policy. When we do, you will be asked to accept the new version before continuing to use Rapid Proposal.",
    ].join("\n"),
  },
};

/**
 * Compares a user's most recent accepted versions against the current active
 * versions and returns the status object the frontend uses to decide whether
 * to show the acceptance screen (docs/PRODUCT_SPEC.md §11).
 *
 * `activeTerms` / `activePrivacy`: the active document records ({ version, ... }).
 * `acceptedTerms` / `acceptedPrivacy`: the user's LATEST acceptance
 *   ({ documentVersion, acceptedAt }) or null if they've never accepted.
 */
export function legalAcceptanceStatus({ activeTerms, activePrivacy, acceptedTerms, acceptedPrivacy }) {
  const currentTermsVersion = activeTerms?.version ?? null;
  const currentPrivacyVersion = activePrivacy?.version ?? null;
  const termsVersion = acceptedTerms?.documentVersion ?? null;
  const privacyVersion = acceptedPrivacy?.documentVersion ?? null;

  // With no active document configured yet, nothing is required - the gate
  // stays inert until the table is seeded.
  const termsAccepted = currentTermsVersion === null || termsVersion === currentTermsVersion;
  const privacyAccepted = currentPrivacyVersion === null || privacyVersion === currentPrivacyVersion;

  return {
    termsAccepted,
    privacyAccepted,
    termsVersion,
    currentTermsVersion,
    termsAcceptedAt: acceptedTerms?.acceptedAt ?? null,
    privacyVersion,
    currentPrivacyVersion,
    privacyAcceptedAt: acceptedPrivacy?.acceptedAt ?? null,
    requiresAcceptance: !termsAccepted || !privacyAccepted,
  };
}

const VERSION_PATTERN = /^v\d+(\.\d+){0,2}$/;

export function isValidLegalVersion(value) {
  return typeof value === "string" && VERSION_PATTERN.test(value);
}

/**
 * Normalizes a POST /workspaces/me/legal/accept body. The client sends the
 * versions it is accepting so a stale tab can't silently accept an
 * already-superseded version - the handler rejects if they don't match the
 * current active versions.
 * Returns { terms?: version, privacy?: version } or null if malformed.
 */
export function parseAcceptBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const out = {};
  if (body.termsVersion !== undefined) {
    if (!isValidLegalVersion(body.termsVersion)) return null;
    out.terms = body.termsVersion;
  }
  if (body.privacyVersion !== undefined) {
    if (!isValidLegalVersion(body.privacyVersion)) return null;
    out.privacy = body.privacyVersion;
  }
  if (out.terms === undefined && out.privacy === undefined) return null;
  return out;
}
