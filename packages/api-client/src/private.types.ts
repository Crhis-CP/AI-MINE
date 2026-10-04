export interface paths {
  "/api/admin/receipts/{id}/release": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["releaseReceipt"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/admin/runs": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["receiptReview"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/auth/options": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["loginOptions"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    DeliveryIssue: {
      id: number;
      status: string;
      subject_id: string;
      subject_kind: string;
      target_key: string;
      /** Format: date-time */
      updated_at: string;
    } & {
      [key: string]: unknown;
    };
    DeliveryIssueInput: {
      id: number;
      status: string;
      subject_id: string;
      subject_kind: string;
      target_key: string;
      /** Format: date-time */
      updated_at: string;
    } & {
      [key: string]: unknown;
    };
    LoginOptions: {
      feishu: boolean;
      password: boolean;
    };
    LoginOptionsInput: {
      feishu: boolean;
      password: boolean;
    };
    Problem: {
      code: string;
      detail: string;
      requestId: string;
      retryAfter?: number;
      status: number;
      title: string;
      type: string;
    };
    ProblemInput: {
      code: string;
      detail: string;
      requestId: string;
      retryAfter?: number;
      status: number;
      title: string;
      type: string;
    };
    ReceiptIssue: {
      attempts: number;
      error: string | null;
      id: number;
      model: string | null;
      purpose: string;
      service: string;
      /** @enum {string} */
      status: "pending" | "received" | "completed" | "failed" | "unknown";
      subject: string | null;
      /** Format: date-time */
      updated_at: string;
      version: components["schemas"]["ReceiptObservedVersion"];
    } & {
      [key: string]: unknown;
    };
    ReceiptIssueInput: {
      attempts: number;
      error: string | null;
      id: number;
      model: string | null;
      purpose: string;
      service: string;
      /** @enum {string} */
      status: "pending" | "received" | "completed" | "failed" | "unknown";
      subject: string | null;
      /** Format: date-time */
      updated_at: string;
      version: components["schemas"]["ReceiptObservedVersionInput"];
    } & {
      [key: string]: unknown;
    };
    ReceiptObservedVersion: string;
    ReceiptObservedVersionInput: string;
    ReceiptReconciliationResponse: {
      deliveries: components["schemas"]["DeliveryIssue"][];
      receipts: {
        counts: {
          [key: string]: number;
        };
        issues: components["schemas"]["ReceiptIssue"][];
      };
    } & {
      [key: string]: unknown;
    };
    ReceiptReconciliationResponseInput: {
      deliveries: components["schemas"]["DeliveryIssueInput"][];
      receipts: {
        counts: {
          [key: string]: number;
        };
        issues: components["schemas"]["ReceiptIssueInput"][];
      };
    } & {
      [key: string]: unknown;
    };
    ReceiptReleaseRequest: {
      billed: boolean;
      note: string;
      version: components["schemas"]["ReceiptObservedVersion"];
    };
    ReceiptReleaseRequestInput: {
      billed: boolean;
      note: string;
      version: components["schemas"]["ReceiptObservedVersionInput"];
    };
    ReceiptReleaseResponse: {
      id: number;
      purpose: string;
      requeued: boolean;
      /** @constant */
      status: "failed";
      subject: string | null;
    };
    ReceiptReleaseResponseInput: {
      id: number;
      purpose: string;
      requeued: boolean;
      /** @constant */
      status: "failed";
      subject: string | null;
    };
  };
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  releaseReceipt: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["ReceiptReleaseRequestInput"];
      };
    };
    responses: {
      /** @description Default Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ReceiptReleaseResponse"];
        };
      };
      /** @description Problem response */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
    };
  };
  receiptReview: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Default Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ReceiptReconciliationResponse"];
        };
      };
      /** @description Problem response */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
    };
  };
  loginOptions: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Default Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["LoginOptions"];
        };
      };
      /** @description Problem response */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
    };
  };
}
