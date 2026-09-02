import { type ErrorPayload, ErrorPayloadSchema } from "@nanasa/contracts";
import { ControlClientError } from "@nanasa/control-client";
import { TriangleAlert, X } from "lucide-react";

export type PortalError = ErrorPayload;

const errorMessages: Readonly<Record<string, string>> = {
  launch_failed: "The agent could not be started.",
  provider_command_unrecognized:
    "The agent could not start because its configured command is not supported by the active provider.",
  recovery_attempts_exhausted: "The agent could not be recovered after multiple attempts.",
  recovery_launch_failed: "The agent could not be restarted.",
  run_start_failed: "The agent could not be started.",
};

export function toPortalError(
  cause: unknown,
  fallbackMessage: string,
  fallbackCode = "portal_operation_failed",
): PortalError {
  if (cause instanceof ControlClientError) return cause.toPayload();
  return ErrorPayloadSchema.parse({
    message: fallbackMessage,
    details: cause instanceof Error ? { cause: cause.message } : {},
    code: fallbackCode,
  });
}

export function portalErrorFromCode(code: string, fallbackMessage: string): PortalError {
  return ErrorPayloadSchema.parse({
    message: errorMessages[code] ?? fallbackMessage,
    code,
  });
}

export function ErrorNotice({
  error,
  className = "error-notice",
  announce = true,
  onDismiss,
}: {
  error: PortalError;
  className?: string;
  announce?: boolean;
  onDismiss?(): void;
}) {
  const hasDetails = Object.keys(error.details).length > 0;
  return (
    <div
      className={`${className} error-notice`}
      {...(announce ? { role: "alert" as const, "aria-atomic": true } : {})}
    >
      <TriangleAlert aria-hidden="true" size={16} />
      <div className="error-notice-body">
        <span>{error.message}</span>
        <details>
          <summary>{error.code}</summary>
          {hasDetails && <pre>{JSON.stringify(error.details, null, 2)}</pre>}
        </details>
      </div>
      {onDismiss !== undefined && (
        <button type="button" aria-label="Dismiss error" onClick={onDismiss}>
          <X aria-hidden="true" size={16} />
        </button>
      )}
    </div>
  );
}
