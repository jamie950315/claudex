/** The inline base64 lexical contract, without a repeated capture/group whose
 * native RegExp stack can overflow on valid multi-megabyte attachments.
 * Callers that require canonical padding bits retain their byte roundtrip.
 */
export function isInlineBase64(value) {
  return typeof value === 'string' && value.length > 0 && value.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}
