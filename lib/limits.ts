export const ALLOWED_EMAIL_DOMAIN = "iimb.ac.in";
export const MAX_FILES = 100;
export const MAX_TOTAL_UPLOAD_BYTES = 100 * 1024 * 1024;
export const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);
export function isUploadMimeAllowed(mimeType: string, filename: string) {
  if (ALLOWED_MIME_TYPES.has(mimeType)) {
    return true;
  }

  const lower = filename.toLowerCase();
  return lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".pdf") || lower.endsWith(".docx");
}
export const SESSION_COOKIE = "midterm_session";
export const VERIFY_LINK_EXPIRY_HOURS = 24;
export const CHAT_HISTORY_LIMIT = 8;
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const CHAT_MODEL = "gpt-5-nano";
export const STATIC_USERNAME = "smajumdar";
export const STATIC_PASSWORD = "admin1234";
