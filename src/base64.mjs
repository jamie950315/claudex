/** The inline base64 lexical contract, without a repeated capture/group whose
 * native RegExp stack can overflow on valid multi-megabyte attachments.
 * A single negated character class scans large attachments several times
 * faster than an anchored repeated class; padding may occur only at the end.
 * Callers that require canonical padding bits retain their byte roundtrip.
 */
export function isInlineBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) return false;
  const padding = value.indexOf('=');
  return padding === -1 || padding >= value.length - 2 && value.endsWith('='.repeat(value.length - padding));
}
