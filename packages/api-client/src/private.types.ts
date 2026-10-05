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
  "/api/admin/sources": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["createSource"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/admin/sources/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["sourceDetail"];
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
    SourceCreateRequest: {
      attachments_in_scope: boolean;
      config: {
        [key: string]: unknown;
      };
      /** @default false */
      first_party: boolean;
      id: string;
      /** @default 30 */
      interval_minutes: number;
      /** @enum {string} */
      kind: "rss" | "web_list" | "json_list" | "mp_account" | "external";
      name: string;
      /**
       * @default editorial
       * @enum {string}
       */
      participation_mode: "editorial" | "hot_signal" | "isolated";
      permission_scope: {
        document_types: string[];
        excluded_content: string[];
        hosts: string[];
        path_prefixes: string[];
      };
      /** @default true */
      site_fulltext: boolean;
      /** @default false */
      syndicate_fulltext: boolean;
      /** @default [] */
      tags: string[];
      /**
       * @default T2
       * @enum {string}
       */
      tier: "T1" | "T1_5" | "T2" | "EXCLUDE_MP";
    };
    SourceCreateRequestInput: {
      attachments_in_scope: boolean;
      config: {
        [key: string]: unknown;
      };
      /** @default false */
      first_party: boolean;
      id: string;
      /** @default 30 */
      interval_minutes: number;
      /** @enum {string} */
      kind: "rss" | "web_list" | "json_list" | "mp_account" | "external";
      name: string;
      /**
       * @default editorial
       * @enum {string}
       */
      participation_mode: "editorial" | "hot_signal" | "isolated";
      permission_scope: {
        document_types: string[];
        excluded_content: string[];
        hosts: string[];
        path_prefixes: string[];
      };
      /** @default true */
      site_fulltext: boolean;
      /** @default false */
      syndicate_fulltext: boolean;
      /** @default [] */
      tags: string[];
      /**
       * @default T2
       * @enum {string}
       */
      tier: "T1" | "T1_5" | "T2" | "EXCLUDE_MP";
    };
    SourceCreateResponse:
      | {
          /** @constant */
          created: true;
          source: components["schemas"]["SourceRecord"];
        }
      | {
          /** @constant */
          created: false;
          duplicate: {
            config: {
              [key: string]: unknown;
            };
            id: string;
            /** @enum {string} */
            kind: "rss" | "web_list" | "json_list" | "mp_account" | "external";
            name: string;
          };
        };
    SourceCreateResponseInput:
      | {
          /** @constant */
          created: true;
          source: components["schemas"]["SourceRecordInput"];
        }
      | {
          /** @constant */
          created: false;
          duplicate: {
            config: {
              [key: string]: unknown;
            };
            id: string;
            /** @enum {string} */
            kind: "rss" | "web_list" | "json_list" | "mp_account" | "external";
            name: string;
          };
        };
    SourceDetailResponse: {
      history: {
        action: string;
        actor: string;
        after: unknown;
        before: unknown;
        /** Format: date-time */
        created_at: string;
        reason: string | null;
      }[];
      items: {
        /** Format: date-time */
        discovered_at: string;
        id: string;
        processing_state: string;
        published_at: string | null;
        selected: boolean | null;
        title: string;
        title_zh: string | null;
        url: string;
        visibility: string | null;
      }[];
      permission: components["schemas"]["SourcePolicy"] | null;
      republish: {
        [key: string]: unknown;
      } | null;
      runs: {
        detail:
          | ({
              backlog?: number;
              dropped?: number;
              pages?: number;
            } & {
              [key: string]: unknown;
            })
          | null;
        error: string | null;
        finished_at: string | null;
        found_count: number | null;
        id: number;
        new_count: number | null;
        /** Format: date-time */
        started_at: string;
        status: string;
      }[];
      source: components["schemas"]["SourceRecord"];
      stats: {
        last7d: number;
        selected: number;
        total: number;
      };
    };
    SourceDetailResponseInput: {
      history: {
        action: string;
        actor: string;
        after: unknown;
        before: unknown;
        /** Format: date-time */
        created_at: string;
        reason: string | null;
      }[];
      items: {
        /** Format: date-time */
        discovered_at: string;
        id: string;
        processing_state: string;
        published_at: string | null;
        selected: boolean | null;
        title: string;
        title_zh: string | null;
        url: string;
        visibility: string | null;
      }[];
      permission: components["schemas"]["SourcePolicyInput"] | null;
      republish: {
        [key: string]: unknown;
      } | null;
      runs: {
        detail:
          | ({
              backlog?: number;
              dropped?: number;
              pages?: number;
            } & {
              [key: string]: unknown;
            })
          | null;
        error: string | null;
        finished_at: string | null;
        found_count: number | null;
        id: number;
        new_count: number | null;
        /** Format: date-time */
        started_at: string;
        status: string;
      }[];
      source: components["schemas"]["SourceRecordInput"];
      stats: {
        last7d: number;
        selected: number;
        total: number;
      };
    };
    SourcePolicy: {
      attachments_in_scope: boolean;
      conditions: ("attribution_required" | "third_party_excluded" | "no_official_endorsement" | "licence_at_access_applies")[];
      evidence: {
        basis_zh: string;
        capabilities: (
          | "fetch"
          | "store_metadata"
          | "process_locally"
          | "store_fulltext"
          | "external_model"
          | "public_excerpt"
          | "public_summary"
          | "public_original_fulltext"
          | "public_translation"
        )[];
        /** Format: date-time */
        checked_at: string;
        /** @enum {string} */
        kind:
          | "owner_declared"
          | "open_license"
          | "statute"
          | "public_domain"
          | "official_policy"
          | "official_notice"
          | "robots_terms"
          | "written_authorization"
          | "source_objection"
          | "owner_instruction"
          | "legal_requirement";
        scope: {
          document_types: string[];
          excluded_content: string[];
          hosts: string[];
          path_prefixes: string[];
        };
        url: string | null;
        valid_until: string | null;
      }[];
      expires_at: string | null;
      licence_label_zh: string;
      permission_version: number;
      permissions: {
        [key: string]: "allow" | "deny" | "unknown";
      };
      /** Format: date-time */
      reviewed_at: string;
      reviewed_by: string;
      scope: {
        document_types: string[];
        excluded_content: string[];
        hosts: string[];
        path_prefixes: string[];
      };
      source_id: string;
    };
    SourcePolicyInput: {
      attachments_in_scope: boolean;
      conditions: ("attribution_required" | "third_party_excluded" | "no_official_endorsement" | "licence_at_access_applies")[];
      evidence: {
        basis_zh: string;
        capabilities: (
          | "fetch"
          | "store_metadata"
          | "process_locally"
          | "store_fulltext"
          | "external_model"
          | "public_excerpt"
          | "public_summary"
          | "public_original_fulltext"
          | "public_translation"
        )[];
        /** Format: date-time */
        checked_at: string;
        /** @enum {string} */
        kind:
          | "owner_declared"
          | "open_license"
          | "statute"
          | "public_domain"
          | "official_policy"
          | "official_notice"
          | "robots_terms"
          | "written_authorization"
          | "source_objection"
          | "owner_instruction"
          | "legal_requirement";
        scope: {
          document_types: string[];
          excluded_content: string[];
          hosts: string[];
          path_prefixes: string[];
        };
        url: string | null;
        valid_until: string | null;
      }[];
      expires_at: string | null;
      licence_label_zh: string;
      permission_version: number;
      permissions: {
        [key: string]: "allow" | "deny" | "unknown";
      };
      /** Format: date-time */
      reviewed_at: string;
      reviewed_by: string;
      scope: {
        document_types: string[];
        excluded_content: string[];
        hosts: string[];
        path_prefixes: string[];
      };
      source_id: string;
    };
    SourceRecord: {
      config: {
        [key: string]: unknown;
      };
      /** Format: date-time */
      created_at: string;
      cursor: {
        [key: string]: unknown;
      } | null;
      enabled: boolean;
      fail_count: number;
      first_party: boolean;
      health: string;
      id: string;
      imported_from: string | null;
      interval_minutes: number;
      /** @enum {string} */
      kind: "rss" | "web_list" | "json_list" | "mp_account" | "external";
      last_error: string | null;
      last_fetch_at: string | null;
      last_ok_at: string | null;
      name: string;
      next_fetch_at: string | null;
      owner_entity_id: string | null;
      /** @enum {string} */
      participation_mode: "editorial" | "hot_signal" | "isolated";
      site_fulltext: boolean;
      syndicate_fulltext: boolean;
      tags: string[];
      /** @enum {string} */
      tier: "T1" | "T1_5" | "T2" | "EXCLUDE_MP";
      /** Format: date-time */
      updated_at: string;
    };
    SourceRecordInput: {
      config: {
        [key: string]: unknown;
      };
      /** Format: date-time */
      created_at: string;
      cursor: {
        [key: string]: unknown;
      } | null;
      enabled: boolean;
      fail_count: number;
      first_party: boolean;
      health: string;
      id: string;
      imported_from: string | null;
      interval_minutes: number;
      /** @enum {string} */
      kind: "rss" | "web_list" | "json_list" | "mp_account" | "external";
      last_error: string | null;
      last_fetch_at: string | null;
      last_ok_at: string | null;
      name: string;
      next_fetch_at: string | null;
      owner_entity_id: string | null;
      /** @enum {string} */
      participation_mode: "editorial" | "hot_signal" | "isolated";
      site_fulltext: boolean;
      syndicate_fulltext: boolean;
      tags: string[];
      /** @enum {string} */
      tier: "T1" | "T1_5" | "T2" | "EXCLUDE_MP";
      /** Format: date-time */
      updated_at: string;
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
  createSource: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["SourceCreateRequestInput"];
      };
    };
    responses: {
      /** @description Default Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["SourceCreateResponse"];
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
    };
  };
  sourceDetail: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
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
          "application/json": components["schemas"]["SourceDetailResponse"];
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
