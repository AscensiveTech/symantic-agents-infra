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
// This text is a starting point, not legal advice, and has not been reviewed by
// counsel. Replace it and bump the version (POST /platform/legal, super admin)
// before relying on it in production.
export const DEFAULT_LEGAL_DOCUMENTS = {
  TERMS_AND_CONDITIONS: {
    version: "v1.0",
    title: "RapidProposal - Terms & Conditions",
    effectiveFrom: "2026-09-01",
    content: [
      "Effective date: September 1, 2026",
      "Provided by: AscensiveTech (the \"Company\", \"we\", \"us\"). RapidProposal is a product of AscensiveTech and is hosted on infrastructure operated by AscensiveTech's technology partner, Symantic.ai.",
      "Governing law: United States, State of Maryland",
      "",
      "1. Acceptance",
      "By creating an account or using RapidProposal, you agree to these Terms on behalf of yourself and, if applicable, your Organization. You must actively accept these Terms before using the app, and you will be asked to re-accept whenever we make a material change.",
      "",
      "2. The Service",
      "RapidProposal lets you build, manage, download, and send business proposals from customizable template sections, with support for e-signature via a third-party provider. We may add, change, or remove features at any time, at our sole discretion, without liability to you.",
      "",
      "3. Accounts & Organizations",
      "Accounts are organization-based, with an Org Admin and additional General Access users. A Super Administrator (RapidProposal's operator) sets each Organization's plan, pricing, and limits. Accounts cannot be deleted by users themselves - all deletion or offboarding requests go through your Org Admin or the operator. You are responsible for all activity under your account and for keeping credentials secure.",
      "",
      "4. Your Content",
      "You own the proposals, templates, and files you upload (\"Customer Content\") and are solely responsible for their accuracy, legality, and appropriateness. You grant us a limited license to store and process Customer Content solely to provide the service.",
      "",
      "5. Plans, Quotas & Billing",
      "Plans include monthly quotas for proposals generated and signatures requested, plus a storage limit, all resetting on the 1st of each month. Unused quota does not carry over, and used quota is non-refundable. Billing is a flat monthly fee on a fixed day each month, with no proration. Payments are recorded manually by the operator.",
      "",
      "6. E-Signature via SignWell",
      "Sending a proposal for signature uses SignWell, a third-party e-signature provider. When you send a request, the proposal PDF and your signers' names and emails are transmitted to SignWell. You are solely responsible for verifying signer identity and for the legal validity and effect of any signed document. We are not a party to, and take no responsibility for, the signing transaction itself.",
      "",
      "7. No Guarantee of Security, Backup, or Availability",
      "This is the core of how the service is provided, and you should read it carefully.",
      "Security: We use commercially reasonable tools and practices to help secure your data, but we do not guarantee that your data is or will remain secure. No system can be guaranteed against unauthorized access, breach, or loss.",
      "Backups: We perform backups on a best-effort basis only. We do not guarantee that any backup exists, is current, or is recoverable. You are solely responsible for maintaining your own copies of proposals, templates, and any other data you consider important.",
      "Availability: The service is provided \"as is\" and \"as available\". We are not liable for downtime or unavailability caused by scheduled maintenance, our infrastructure providers (including cloud service providers such as AWS, Azure, etc.), or any other cause, whether or not within our control.",
      "Bottom line: the fact that your data or the app is available today is not a promise that it will remain available tomorrow. You use RapidProposal, and store data in it, entirely at your own risk.",
      "",
      "8. Disclaimer of Warranties",
      "Except as expressly stated in these Terms, RapidProposal is provided without warranties of any kind, express or implied, including any implied warranties of merchantability, fitness for a particular purpose, or non-infringement.",
      "",
      "9. Limitation of Liability",
      "To the maximum extent permitted by law, our total liability to you for any claim of any kind arising from or related to RapidProposal - including but not limited to data loss, security incidents, backup failures, or service unavailability - is limited to the fees you paid for the specific billing month in which the claim arose, and no more. In no event are we liable for indirect, incidental, special, consequential, or punitive damages, even if advised of the possibility of such damages.",
      "Some liability (for example, arising from gross negligence, willful misconduct, or fraud, or certain rights that cannot be waived under applicable law) cannot legally be limited by contract even with language like the above. This section limits our liability to the fullest extent the law allows, but does not claim to override protections that cannot be waived.",
      "",
      "10. Indemnification",
      "You agree to defend, indemnify, and hold us harmless from any claims, damages, or expenses (including reasonable attorney's fees) arising from your Customer Content, your use of the service, or your violation of these Terms, including claims brought by your own clients or signers.",
      "",
      "11. Force Majeure",
      "We are not liable for any failure or delay caused by events beyond our reasonable control, including natural disasters, internet or cloud infrastructure outages (including cloud service providers such as AWS, Azure, etc.), acts of government, or other similar events.",
      "",
      "12. Suspension & Termination",
      "We may suspend or terminate your access for violating these Terms, misuse of the service, or non-payment, without liability to you beyond any applicable refund described in Section 9.",
      "",
      "13. Dispute Resolution - Arbitration & Class Action Waiver",
      "Any dispute arising from these Terms or your use of RapidProposal will be resolved through individual, binding arbitration rather than in court, except where prohibited by law. You waive any right to bring or participate in a class, collective, or representative action against us. Arbitration will be conducted under the rules of a mutually agreed arbitration body, seated in Maryland.",
      "",
      "14. Governing Law",
      "These Terms are governed by the laws of the State of Maryland, USA, without regard to conflict-of-law principles.",
      "",
      "15. Intellectual Property",
      "RapidProposal, including its software and design, is owned by AscensiveTech. It runs on infrastructure operated by AscensiveTech's technology partner, Symantic.ai, which does not thereby acquire any ownership of RapidProposal. Nothing in these Terms transfers any ownership of RapidProposal to you.",
      "",
      "16. General Terms",
      "These Terms are the entire agreement between you and us regarding RapidProposal. If any provision is found unenforceable, the remaining provisions stay in effect. Our failure to enforce a provision is not a waiver of it. You may not assign these Terms without our consent; we may assign them freely.",
      "",
      "17. Changes to These Terms",
      "We may update these Terms at any time. Material changes require your re-acceptance before continued use.",
      "",
      "18. Contact",
      "Questions? Contact us at info@ascensivetech.com.",
    ].join("\n"),
  },
  PRIVACY_POLICY: {
    version: "v1.0",
    title: "RapidProposal - Privacy Policy",
    effectiveFrom: "2026-09-01",
    content: [
      "Effective date: September 1, 2026",
      "Provided by: AscensiveTech (\"Company\", \"we\", \"us\"). RapidProposal is a product of AscensiveTech, hosted on infrastructure operated by our technology partner, Symantic.ai.",
      "",
      "This Privacy Policy is informational. You can read and download it at any time, but unlike our Terms & Conditions, you are not asked to separately accept or reject it.",
      "",
      "1. What We Collect",
      "Account information: name, email, company, and role.",
      "Proposal content: templates, pricing/parts data, uploaded letterhead files, and all other content you create or upload in the app.",
      "Policy-acceptance records: timestamp, IP address, and browser user-agent, recorded whenever you accept our Terms & Conditions.",
      "Basic technical and usage data needed to operate, troubleshoot, and improve the service.",
      "",
      "2. How We Use It",
      "We use this data to provide and operate RapidProposal, process proposals and e-signature requests, manage accounts, quotas, and billing, maintain compliance records, and provide customer support.",
      "",
      "3. Who We Share Data With",
      "SignWell - a subprocessor that receives the proposal PDF and signer names/emails only when you send a document for e-signature.",
      "Cloud service providers (such as AWS, Azure, etc.) - our infrastructure providers, hosting our files, application data, hosting environment, and authentication system.",
      "We may share data with service providers who help us operate RapidProposal, under confidentiality obligations.",
      "",
      "4. Storage & Security",
      "Data is stored with cloud service providers such as AWS, Azure, etc., in the US East region. We use commercially reasonable measures to help protect your data, but as described in our Terms & Conditions, we do not guarantee the security or continued availability of any data stored in RapidProposal.",
      "",
      "5. Data Retention",
      "We retain your data for as long as your account remains active. Once an account is no longer active, we do not guarantee any particular retention outcome - your data may be retained indefinitely or deleted at any time thereafter, at our discretion. Policy-acceptance and audit records may be retained beyond account activity for our own compliance and recordkeeping purposes.",
      "",
      "6. Your Rights & Account Deletion",
      "Because RapidProposal accounts are organization-based, individual users cannot delete their own accounts or data directly. If you would like to access, correct, or request deletion of your information, please contact your Organization's Admin, or reach us directly at info@ascensivetech.com and we will coordinate with your Organization.",
      "",
      "7. Cookies & Local Storage",
      "We use cookies and/or local storage for essential functions such as keeping you logged in and remembering app preferences.",
      "",
      "8. Children's Privacy",
      "RapidProposal is a business tool intended for use by adults and organizations. It is not directed at children, and we do not knowingly collect personal data from children.",
      "",
      "9. Changes to This Policy",
      "We may update this Privacy Policy from time to time. The current version will always be available in the app.",
      "",
      "10. Contact",
      "Questions about this Privacy Policy? Contact us at info@ascensivetech.com.",
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

// Whitespace-normalized document body, so a re-publish that only changes
// indentation / trailing spaces isn't treated as a real change.
export function normalizeLegalContent(content) {
  return String(content ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

// A short content fingerprint. A re-publish whose body hashes to the current
// active version's hash does NOT bump the version, so users are not
// re-prompted for a no-op change (the user's requirement).
export async function legalContentHash(content) {
  const bytes = new TextEncoder().encode(normalizeLegalContent(content));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
