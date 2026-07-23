/**
 * components/common/mutate.ts — Amplify mutation guard + user-facing feedback.
 *
 * The Amplify Gen2 typed client returns `{ data, errors }` and does NOT throw on
 * GraphQL errors (auth, validation, conflicts, network). Handlers that ignore
 * `errors` silently no-op on failure — and when they optimistically update local
 * state right after the call, the UI diverges from the database (e.g. an account
 * balance that "moved" locally but never persisted).
 *
 * Wrap every create/update/delete in `mutate(...)` so a failure throws instead of
 * silently succeeding, then catch it once per handler with `reportError` to show
 * the user a toast. Pair with `notifySuccess` for positive confirmation where a
 * page wants it.
 */
import { addToast } from "@heroui/react";

/** Thrown by `mutate` when an Amplify result carries GraphQL errors. */
export class MutationError extends Error {
  readonly errors: readonly unknown[];
  constructor(errors: readonly unknown[], message?: string) {
    super(message ?? (errors[0] as { message?: string })?.message ?? "Request failed");
    this.name = "MutationError";
    this.errors = errors;
  }
}

type AmplifyResult<T> = { data: T; errors?: readonly unknown[] | null };

/**
 * Await an Amplify mutation/query, throw `MutationError` if it carried GraphQL
 * errors, otherwise return `data`. Usage:
 *   const acc = await mutate(client.models.financeAccount.update({ ... }));
 */
export async function mutate<T>(op: PromiseLike<AmplifyResult<T>>): Promise<T> {
  const res = await op;
  if (res?.errors && res.errors.length > 0) {
    console.error("[mutate] GraphQL errors:", res.errors);
    throw new MutationError(res.errors);
  }
  return res.data;
}

/**
 * Standard catch-block handler: log the error and show a danger toast. `action`
 * labels what failed (e.g. "Save transaction", "Delete account").
 */
export function reportError(err: unknown, action = "Action"): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[${action}] failed:`, err);
  addToast({ title: `${action} failed`, description: message, color: "danger" });
}

/** Optional positive confirmation toast. */
export function notifySuccess(title: string, description?: string): void {
  addToast({ title, description, color: "success" });
}

/**
 * Danger toast for validation / business-rule messages that aren't thrown
 * errors (e.g. "Name is required", "Pick at least one lot"). Replaces blocking
 * alert() calls for non-confirmation feedback.
 */
export function notifyError(title: string, description?: string): void {
  addToast({ title, description, color: "danger" });
}

/** Amber toast for softer, non-blocking warnings. */
export function notifyWarning(title: string, description?: string): void {
  addToast({ title, description, color: "warning" });
}
