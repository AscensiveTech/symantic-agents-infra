import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_BASE_URL = "https://www.signwell.com/api/v1";

export class SignWellRequestError extends Error {
  constructor(message, status = 502, details = null) {
    super(message);
    this.name = "SignWellRequestError";
    this.status = status;
    this.details = details;
  }
}

function errorMessage(body, status) {
  if (typeof body?.message === "string" && body.message.trim()) return body.message.trim();
  if (typeof body?.error === "string" && body.error.trim()) return body.error.trim();
  if (body?.errors && typeof body.errors === "object") {
    const serialized = JSON.stringify(body.errors);
    if (serialized.length <= 500) return serialized;
  }
  return `SignWell request failed (${status})`;
}

export function createSignWellClient({
  apiKey,
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  testMode = true,
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("SignWell apiKey is required");
  }
  const root = baseUrl.replace(/\/+$/, "");

  async function request(path, init = {}) {
    const response = await fetchImpl(`${root}${path}`, {
      ...init,
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text.slice(0, 500) };
      }
    }
    if (!response.ok) {
      throw new SignWellRequestError(errorMessage(body, response.status), response.status, body);
    }
    return body;
  }

  return {
    testMode: testMode !== false,
    getDocument(documentId) {
      return request(`/documents/${encodeURIComponent(documentId)}`, {
        method: "GET",
      });
    },
    createDocument(document) {
      return request("/documents", {
        method: "POST",
        body: JSON.stringify({ test_mode: testMode !== false, ...document }),
      });
    },
    updateRecipients(documentId, recipients) {
      return request(`/documents/${encodeURIComponent(documentId)}/recipients`, {
        method: "PATCH",
        body: JSON.stringify({ recipients }),
      });
    },
    sendDocument(documentId, document = {}) {
      return request(`/documents/${encodeURIComponent(documentId)}/send`, {
        method: "POST",
        body: JSON.stringify({ test_mode: testMode !== false, ...document }),
      });
    },
    deleteDocument(documentId) {
      return request(`/documents/${encodeURIComponent(documentId)}`, {
        method: "DELETE",
      });
    },
    // Stop an in-progress signing. SignWell has no dedicated "void" - deleting
    // the document cancels signing for it ("Deleting a document will also
    // cancel document signing"). A 404 means it's already gone - treat as done.
    async cancelDocument(documentId) {
      try {
        await request(`/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" });
      } catch (error) {
        if (error instanceof SignWellRequestError && error.status === 404) return;
        throw error;
      }
    },
    sendReminder(documentId, recipients) {
      const body = Array.isArray(recipients) && recipients.length > 0
        ? { recipients }
        : {};
      return request(`/documents/${encodeURIComponent(documentId)}/remind`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    async getCompletedPdfUrl(documentId) {
      const result = await request(
        `/documents/${encodeURIComponent(documentId)}/completed_pdf?url_only=true&audit_page=true`,
        { method: "GET" },
      );
      if (typeof result?.file_url !== "string" || !result.file_url) {
        throw new SignWellRequestError("SignWell did not return a completed PDF URL");
      }
      return result.file_url;
    },
    // The completed PDF as raw bytes (base64), so the app can show it in the
    // in-browser preview without the viewer's browser having to fetch a
    // cross-origin SignWell/S3 URL (which its CORS policy blocks).
    async getCompletedPdfBase64(documentId) {
      const response = await fetchImpl(
        `${root}/documents/${encodeURIComponent(documentId)}/completed_pdf?audit_page=true`,
        { headers: { "X-Api-Key": apiKey } },
      );
      if (!response.ok) {
        const text = await response.text();
        throw new SignWellRequestError(
          `SignWell completed PDF download failed (${response.status})`,
          response.status,
          text.slice(0, 500),
        );
      }
      return Buffer.from(await response.arrayBuffer()).toString("base64");
    },
  };
}

export function verifySignWellEvent(payload, webhookId) {
  const event = payload?.event;
  if (
    typeof webhookId !== "string" || webhookId.length === 0 ||
    typeof event?.type !== "string" || event.type.length === 0 ||
    (typeof event?.time !== "string" && typeof event?.time !== "number") ||
    typeof event?.hash !== "string" || !/^[0-9a-f]{64}$/i.test(event.hash)
  ) return false;

  const expected = Buffer.from(event.hash.toLowerCase(), "hex");
  const calculated = Buffer.from(
    createHmac("sha256", webhookId)
      .update(`${event.type}@${event.time}`)
      .digest("hex"),
    "hex",
  );
  return expected.length === calculated.length && timingSafeEqual(expected, calculated);
}
