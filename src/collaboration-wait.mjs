export const DEFAULT_WAIT_MS = 30_000;
export const MAX_WAIT_MS = 300_000;

export function validWaitTimeout(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_WAIT_MS;
}
