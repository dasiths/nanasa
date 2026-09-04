import {
  type ErrorPayload,
  ErrorPayloadSchema,
  MAX_MESSAGE_REQUEST_BYTES,
  MAX_MESSAGE_TEXT_BYTES,
  OVERSIZED_MESSAGE_GUIDANCE,
} from "@nanasa/contracts";
import { ExtensionPackageError } from "../extensions/extension-package-loader.js";
import { LaunchConsentServiceError } from "../launch-consent-service.js";
import { DomainError } from "../store.js";

interface ErrorWithIssues {
  issues: unknown[];
}

export interface PublicErrorResponse {
  statusCode: number;
  payload: ErrorPayload;
}

export function errorPayload(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ErrorPayload {
  return ErrorPayloadSchema.parse({ message, details, code });
}

export function isValidationError(error: unknown): error is ErrorWithIssues {
  return (
    typeof error === "object" && error !== null && "issues" in error && Array.isArray(error.issues)
  );
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function extensionStatusCode(code: string): number {
  if (code.includes("not_found")) return 404;
  if (code.includes("trust_required") || code.includes("signature_untrusted")) return 403;
  if (
    code.includes("stale") ||
    code.includes("busy") ||
    code.includes("active_runs") ||
    code.includes("referenced")
  ) {
    return 409;
  }
  return 400;
}

export function toPublicErrorResponse(error: unknown): PublicErrorResponse | undefined {
  if (error instanceof DomainError) {
    return {
      statusCode: error.statusCode,
      payload: errorPayload(error.code, error.message, error.details),
    };
  }
  if (error instanceof ExtensionPackageError) {
    return {
      statusCode: extensionStatusCode(error.code),
      payload: errorPayload(error.code, error.message, error.details),
    };
  }
  if (error instanceof LaunchConsentServiceError) {
    return {
      statusCode: error.code === "launch_consent_not_found" ? 404 : 409,
      payload: errorPayload(error.code, error.message),
    };
  }
  if (isValidationError(error)) {
    const oversized = error.issues.some(
      (issue) =>
        typeof issue === "object" &&
        issue !== null &&
        "message" in issue &&
        String(issue.message).includes(`${MAX_MESSAGE_TEXT_BYTES}-byte UTF-8 limit`),
    );
    return oversized
      ? {
          statusCode: 413,
          payload: errorPayload(
            "message_body_too_large",
            `Message text exceeds the ${MAX_MESSAGE_TEXT_BYTES}-byte UTF-8 limit. ${OVERSIZED_MESSAGE_GUIDANCE}`,
          ),
        }
      : {
          statusCode: 400,
          payload: errorPayload("validation_error", "Request validation failed", {
            issues: error.issues,
          }),
        };
  }
  if (hasErrorCode(error, "FST_ERR_CTP_BODY_TOO_LARGE")) {
    return {
      statusCode: 413,
      payload: errorPayload(
        "request_too_large",
        `Request exceeds the ${MAX_MESSAGE_REQUEST_BYTES}-byte message request limit. Message text is limited to ${MAX_MESSAGE_TEXT_BYTES} UTF-8 bytes. ${OVERSIZED_MESSAGE_GUIDANCE}`,
      ),
    };
  }
  return undefined;
}

export function internalErrorPayload(): ErrorPayload {
  return errorPayload("internal_error", "Internal server error");
}

export function errorPayloadFromUnknown(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): ErrorPayload {
  const publicError = toPublicErrorResponse(error);
  if (publicError !== undefined) return publicError.payload;
  const errorCode =
    error instanceof Error && /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(error.message)
      ? error.message
      : fallbackCode;
  return errorPayload(errorCode, fallbackMessage);
}
