import { NextResponse } from "next/server";
import { withEmailAccount, withEmailProvider } from "@/utils/middleware";
import {
  MAIL_PROTOCOL_VERSION,
  mailHttpErrorResponse,
  operationAdmitRequestSchema,
  operationAdmitResultSchema,
  operationCancelRequestSchema,
  operationCancelResultSchema,
  operationInspectRequestSchema,
} from "@inboxzero/mail-core/protocol/mail-http";
import {
  accountMismatchResponse,
  bodyAccountMismatchResponse,
  mailRequestId,
  unsupportedVersionResponse,
} from "@/utils/mail-api/authorization";
import {
  cancelHeldEngineSend,
  createEmailProviderOperationExecutor,
} from "@/utils/mail-api/operations";
import {
  HYDRATION_COST_PER_MESSAGE,
  takeBackgroundSyncBudget,
} from "@/utils/mail-api/sync-budget";

export const PUT = withEmailProvider(
  "mail/v1/operations",
  async (request, context) => {
    const params = await context.params;
    const body = await request.json().catch(() => null);
    const requestId = mailRequestId(
      request,
      body && typeof body === "object" ? body : undefined,
    );
    const mismatch = accountMismatchResponse(
      request,
      params.accountId,
      requestId,
    );
    if (mismatch) return mismatch;
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        mailHttpErrorResponse({ requestId, code: "invalid", retryable: false }),
        { status: 400 },
      );
    }
    const version = unsupportedVersionResponse(
      requestId,
      (body as { protocolVersion?: unknown }).protocolVersion,
    );
    if (version) return version;
    const parsed = operationAdmitRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        mailHttpErrorResponse({ requestId, code: "invalid", retryable: false }),
        { status: 400 },
      );
    }
    const bodyMismatch = bodyAccountMismatchResponse(
      request.auth.emailAccountId,
      parsed.data,
      requestId,
    );
    if (bodyMismatch) return bodyMismatch;
    if (parsed.data.operation.key.operationId !== params.commandId) {
      return NextResponse.json(
        mailHttpErrorResponse({ requestId, code: "invalid", retryable: false }),
        { status: 400 },
      );
    }
    const intent = parsed.data.operation.intent;
    request.logger.trace("Executing mail operation", {
      kind: intent.kind,
      targetCount: intent.kind === "metadata" ? intent.targets.length : 1,
      change: intent.kind === "metadata" ? intent.change : undefined,
    });
    const executor = createEmailProviderOperationExecutor({
      provider: request.emailProvider,
      accountId: request.auth.emailAccountId,
    });
    const result = await executor.execute({
      operation: parsed.data.operation,
      attemptId: parsed.data.attemptId,
      signal: request.signal,
    });
    return NextResponse.json(
      operationAdmitResultSchema.parse({
        ...result,
        protocolVersion: parsed.data.protocolVersion,
        requestId,
      }),
    );
  },
);

const inspectOperation = withEmailProvider(
  "mail/v1/operations/inspect",
  async (request, context) => {
    const params = await context.params;
    const body = await request.json().catch(() => null);
    const requestId = mailRequestId(
      request,
      body && typeof body === "object" ? body : undefined,
    );
    const mismatch = accountMismatchResponse(
      request,
      params.accountId,
      requestId,
    );
    if (mismatch) return mismatch;
    const parsed = operationInspectRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        operationAdmitResultSchema.parse({
          status: "uncertain",
          protocolVersion: MAIL_PROTOCOL_VERSION,
          requestId,
          receiptId: params.commandId,
        }),
      );
    }
    const bodyMismatch = bodyAccountMismatchResponse(
      request.auth.emailAccountId,
      parsed.data,
      requestId,
    );
    if (bodyMismatch) return bodyMismatch;
    if (parsed.data.operation.key.operationId !== params.commandId) {
      return NextResponse.json(
        operationAdmitResultSchema.parse({
          status: "uncertain",
          protocolVersion: parsed.data.protocolVersion,
          requestId,
          receiptId: params.commandId,
        }),
      );
    }
    // Inspecting re-reads every target, and the client keeps inspecting while
    // any target is unconfirmed, so a large operation can eat the provider's
    // whole quota. Pace it with the rest of the background work.
    const inspectIntent = parsed.data.operation.intent;
    if (inspectIntent.kind === "metadata") {
      request.logger.trace("Inspecting mail operation", {
        targetCount: inspectIntent.targets.length,
        change: inspectIntent.change,
      });
      const budget = await takeBackgroundSyncBudget(
        request.auth.emailAccountId,
        inspectIntent.targets.length * HYDRATION_COST_PER_MESSAGE,
      );
      if (!budget.ok) {
        return NextResponse.json(
          operationAdmitResultSchema.parse({
            status: "accepted",
            protocolVersion: parsed.data.protocolVersion,
            requestId,
            receiptId: parsed.data.receiptId ?? params.commandId,
            retryAfterMs: Math.ceil(budget.retryAfterMs),
          }),
        );
      }
    }
    const executor = createEmailProviderOperationExecutor({
      provider: request.emailProvider,
      accountId: request.auth.emailAccountId,
    });
    const result = await executor.inspect({
      operation: parsed.data.operation,
      receiptId: parsed.data.receiptId,
      signal: request.signal,
    });
    return NextResponse.json(
      operationAdmitResultSchema.parse({
        ...result,
        protocolVersion: parsed.data.protocolVersion,
        requestId,
      }),
    );
  },
);

export const POST = inspectOperation;
export const GET = inspectOperation;

// Undo for a send the server is holding. It needs no mailbox access, so it
// still works while the account waits to be reconnected.
export const DELETE = withEmailAccount(
  "mail/v1/operations/cancel",
  async (request, context) => {
    const params = await context.params;
    const body = await request.json().catch(() => null);
    const requestId = mailRequestId(
      request,
      body && typeof body === "object" ? body : undefined,
    );
    const mismatch = accountMismatchResponse(
      request,
      params.accountId,
      requestId,
    );
    if (mismatch) return mismatch;
    const parsed = operationCancelRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        mailHttpErrorResponse({ requestId, code: "invalid", retryable: false }),
        { status: 400 },
      );
    }
    const bodyMismatch = bodyAccountMismatchResponse(
      request.auth.emailAccountId,
      parsed.data,
      requestId,
    );
    if (bodyMismatch) return bodyMismatch;
    const status = await cancelHeldEngineSend(
      request.auth.emailAccountId,
      params.commandId,
    );
    return NextResponse.json(
      operationCancelResultSchema.parse({
        protocolVersion: parsed.data.protocolVersion,
        requestId,
        status,
      }),
    );
  },
);
