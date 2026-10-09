export interface paths {
  "/api/admin/lane-controls": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["laneControls"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/admin/lane-controls/actions": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["laneControlAction"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/admin/model-connection-tests/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["modelConnectionProbe"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/admin/model-connections": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["modelRegistry"];
    put?: never;
    post: operations["createModelConnection"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/admin/model-connections/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put: operations["updateModelConnection"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/admin/model-connections/{id}/disable": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["disableModelConnection"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/admin/model-connections/{id}/test": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["probeModelConnection"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/admin/model-routes/{capability}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["assignRegisteredModel"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
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
  "/api/admin/usage/reports": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["usageMonthlyList"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/admin/usage/reports/{month}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["usageMonthlyDetail"];
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
    LaneControl: {
      actor: string;
      /** Format: date-time */
      expires_at: string;
      /** @enum {string} */
      holder: "owner" | "deploy" | "system";
      /** @enum {string} */
      lane: "news" | "policy" | "all";
      overdue: boolean;
      reason: string;
      revision: number;
      /** @enum {string} */
      switch: "collection" | "processing" | "publication";
      /** Format: date-time */
      updated_at: string;
    };
    LaneControlActionRequest: {
      /** @enum {string} */
      action: "pause" | "resume";
      /** @default false */
      confirm_all: boolean;
      expected_revisions: {
        collection?: number;
        processing: number;
      };
      /** Format: date-time */
      expires_at?: string;
      /** @enum {string} */
      lane: "news" | "policy" | "all";
      /** @enum {string} */
      mode: "processing" | "automatic";
      reason: string;
    };
    LaneControlActionRequestInput: {
      /** @enum {string} */
      action: "pause" | "resume";
      /** @default false */
      confirm_all: boolean;
      expected_revisions: {
        collection?: number;
        processing: number;
      };
      /** Format: date-time */
      expires_at?: string;
      /** @enum {string} */
      lane: "news" | "policy" | "all";
      /** @enum {string} */
      mode: "processing" | "automatic";
      reason: string;
    };
    LaneControlInput: {
      actor: string;
      /** Format: date-time */
      expires_at: string;
      /** @enum {string} */
      holder: "owner" | "deploy" | "system";
      /** @enum {string} */
      lane: "news" | "policy" | "all";
      overdue: boolean;
      reason: string;
      revision: number;
      /** @enum {string} */
      switch: "collection" | "processing" | "publication";
      /** Format: date-time */
      updated_at: string;
    };
    LaneControlsResponse: {
      controls: components["schemas"]["LaneControl"][];
      owner_revisions: {
        /** @enum {string} */
        lane: "news" | "policy" | "all";
        revision: number;
        /** @enum {string} */
        switch: "collection" | "processing";
      }[];
    };
    LaneControlsResponseInput: {
      controls: components["schemas"]["LaneControlInput"][];
      owner_revisions: {
        /** @enum {string} */
        lane: "news" | "policy" | "all";
        revision: number;
        /** @enum {string} */
        switch: "collection" | "processing";
      }[];
    };
    LoginOptions: {
      feishu: boolean;
      password: boolean;
    };
    LoginOptionsInput: {
      feishu: boolean;
      password: boolean;
    };
    ModelConnectionCreate: {
      /** Format: uri */
      billing_basis: string;
      /** Format: uri */
      endpoint: string;
      input_cny_per_million: string;
      /** @enum {string} */
      interface: "deepseek" | "openai-compatible";
      json_mode: boolean;
      model: string;
      name: string;
      output_cny_per_million: string;
      /** @constant */
      owner_confirmed: true;
      reason: string;
      secret: string;
      /** Format: uri */
      supplier_basis: string;
      vision: boolean;
    };
    ModelConnectionCreateInput: {
      /** Format: uri */
      billing_basis: string;
      /** Format: uri */
      endpoint: string;
      input_cny_per_million: string;
      /** @enum {string} */
      interface: "deepseek" | "openai-compatible";
      json_mode: boolean;
      model: string;
      name: string;
      output_cny_per_million: string;
      /** @constant */
      owner_confirmed: true;
      reason: string;
      secret: string;
      /** Format: uri */
      supplier_basis: string;
      vision: boolean;
    };
    ModelConnectionDisable: {
      expected_revision: number;
      reason: string;
    };
    ModelConnectionDisableInput: {
      expected_revision: number;
      reason: string;
    };
    ModelConnectionProbe: {
      expected_revision: number;
      /** @enum {string} */
      lane: "news" | "policy";
    };
    ModelConnectionProbeInput: {
      expected_revision: number;
      /** @enum {string} */
      lane: "news" | "policy";
    };
    ModelConnectionRecord: {
      /** Format: uri */
      billing_basis: string;
      configuration_hash: string;
      enabled: boolean;
      /** Format: uri */
      endpoint: string;
      fingerprint: string;
      /** Format: uuid */
      id: string;
      input_cny_per_million: string;
      /** @enum {string} */
      interface: "deepseek" | "openai-compatible";
      json_mode: boolean;
      key: string;
      model: string;
      name: string;
      output_cny_per_million: string;
      revision: number;
      /** @enum {string} */
      test_status: "untested" | "passed" | "failed" | "unknown" | "running" | "queued" | "paused";
      tested_at: string | null;
      /** Format: date-time */
      updated_at: string;
      vision: boolean;
    };
    ModelConnectionRecordInput: {
      /** Format: uri */
      billing_basis: string;
      configuration_hash: string;
      enabled: boolean;
      /** Format: uri */
      endpoint: string;
      fingerprint: string;
      /** Format: uuid */
      id: string;
      input_cny_per_million: string;
      /** @enum {string} */
      interface: "deepseek" | "openai-compatible";
      json_mode: boolean;
      key: string;
      model: string;
      name: string;
      output_cny_per_million: string;
      revision: number;
      /** @enum {string} */
      test_status: "untested" | "passed" | "failed" | "unknown" | "running" | "queued" | "paused";
      tested_at: string | null;
      /** Format: date-time */
      updated_at: string;
      vision: boolean;
    };
    ModelConnectionUpdate: {
      /** Format: uri */
      billing_basis: string;
      enabled?: boolean;
      /** Format: uri */
      endpoint: string;
      expected_revision: number;
      input_cny_per_million: string;
      /** @enum {string} */
      interface: "deepseek" | "openai-compatible";
      json_mode: boolean;
      model: string;
      name: string;
      output_cny_per_million: string;
      owner_confirmed?: boolean;
      reason: string;
      secret?: string;
      /** Format: uri */
      supplier_basis?: string;
      vision: boolean;
    };
    ModelConnectionUpdateInput: {
      /** Format: uri */
      billing_basis: string;
      enabled?: boolean;
      /** Format: uri */
      endpoint: string;
      expected_revision: number;
      input_cny_per_million: string;
      /** @enum {string} */
      interface: "deepseek" | "openai-compatible";
      json_mode: boolean;
      model: string;
      name: string;
      output_cny_per_million: string;
      owner_confirmed?: boolean;
      reason: string;
      secret?: string;
      /** Format: uri */
      supplier_basis?: string;
      vision: boolean;
    };
    ModelProbeRecord: {
      /** Format: uuid */
      connection_id: string;
      /** Format: date-time */
      created_at: string;
      detail: string | null;
      finished_at: string | null;
      /** Format: uuid */
      id: string;
      /** @enum {string} */
      lane: "news" | "policy";
      receipt_id: string | null;
      revision: number;
      /** @enum {string} */
      status: "queued" | "running" | "passed" | "failed" | "unknown" | "paused";
    };
    ModelProbeRecordInput: {
      /** Format: uuid */
      connection_id: string;
      /** Format: date-time */
      created_at: string;
      detail: string | null;
      finished_at: string | null;
      /** Format: uuid */
      id: string;
      /** @enum {string} */
      lane: "news" | "policy";
      receipt_id: string | null;
      revision: number;
      /** @enum {string} */
      status: "queued" | "running" | "passed" | "failed" | "unknown" | "paused";
    };
    ModelRegistryResponse: {
      connections: components["schemas"]["ModelConnectionRecord"][];
      /** @enum {string} */
      storage: "ready" | "storage_unavailable";
    };
    ModelRegistryResponseInput: {
      connections: components["schemas"]["ModelConnectionRecordInput"][];
      /** @enum {string} */
      storage: "ready" | "storage_unavailable";
    };
    ModelRouteChange: {
      emergency_confirmed: boolean;
      evaluation_id: string | null;
      expected_revision: number;
      model: string;
      reason: string;
    };
    ModelRouteChangeInput: {
      emergency_confirmed: boolean;
      evaluation_id: string | null;
      expected_revision: number;
      model: string;
      reason: string;
    };
    ModelRouteRecord: {
      capability: string;
      model: string;
      revision: number;
      unevaluated: boolean;
    };
    ModelRouteRecordInput: {
      capability: string;
      model: string;
      revision: number;
      unevaluated: boolean;
    };
    MonthlyUsageEntry: {
      notification_at: string | null;
      /** @enum {string} */
      notification_state: "pending" | "sending" | "sent" | "unknown";
      report: components["schemas"]["MonthlyUsageReport"];
      revision: number;
      updated_after_issue: boolean;
    };
    MonthlyUsageEntryInput: {
      notification_at: string | null;
      /** @enum {string} */
      notification_state: "pending" | "sending" | "sent" | "unknown";
      report: components["schemas"]["MonthlyUsageReportInput"];
      revision: number;
      updated_after_issue: boolean;
    };
    MonthlyUsageList: {
      items: components["schemas"]["MonthlyUsageEntry"][];
    };
    MonthlyUsageListInput: {
      items: components["schemas"]["MonthlyUsageEntryInput"][];
    };
    MonthlyUsageReport: {
      by_capability: {
        key: string;
        label: string;
        totals: {
          amounts: {
            actual: string;
            currency: string;
            estimated: string;
          }[];
          cache_hit_rate: number | null;
          cache_pair_reported_calls: number;
          calls: number;
          failed: number;
          input_tokens: number | null;
          output_tokens: number | null;
          pending: number;
          provider_cache_miss_reported_calls: number;
          provider_cache_miss_tokens: number | null;
          provider_cache_reported_calls: number;
          provider_cache_tokens: number | null;
          received: number;
          token_reported_calls: number;
          unknown: number;
          unpriced_calls: number;
        };
      }[];
      by_lane: {
        key: string;
        label: string;
        totals: {
          amounts: {
            actual: string;
            currency: string;
            estimated: string;
          }[];
          cache_hit_rate: number | null;
          cache_pair_reported_calls: number;
          calls: number;
          failed: number;
          input_tokens: number | null;
          output_tokens: number | null;
          pending: number;
          provider_cache_miss_reported_calls: number;
          provider_cache_miss_tokens: number | null;
          provider_cache_reported_calls: number;
          provider_cache_tokens: number | null;
          received: number;
          token_reported_calls: number;
          unknown: number;
          unpriced_calls: number;
        };
      }[];
      by_service: {
        key: string;
        label: string;
        totals: {
          amounts: {
            actual: string;
            currency: string;
            estimated: string;
          }[];
          cache_hit_rate: number | null;
          cache_pair_reported_calls: number;
          calls: number;
          failed: number;
          input_tokens: number | null;
          output_tokens: number | null;
          pending: number;
          provider_cache_miss_reported_calls: number;
          provider_cache_miss_tokens: number | null;
          provider_cache_reported_calls: number;
          provider_cache_tokens: number | null;
          received: number;
          token_reported_calls: number;
          unknown: number;
          unpriced_calls: number;
        };
      }[];
      by_source: {
        key: string;
        label: string;
        totals: {
          amounts: {
            actual: string;
            currency: string;
            estimated: string;
          }[];
          cache_hit_rate: number | null;
          cache_pair_reported_calls: number;
          calls: number;
          failed: number;
          input_tokens: number | null;
          output_tokens: number | null;
          pending: number;
          provider_cache_miss_reported_calls: number;
          provider_cache_miss_tokens: number | null;
          provider_cache_reported_calls: number;
          provider_cache_tokens: number | null;
          received: number;
          token_reported_calls: number;
          unknown: number;
          unpriced_calls: number;
        };
      }[];
      by_usage_purpose: {
        key: string;
        label: string;
        totals: {
          amounts: {
            actual: string;
            currency: string;
            estimated: string;
          }[];
          cache_hit_rate: number | null;
          cache_pair_reported_calls: number;
          calls: number;
          failed: number;
          input_tokens: number | null;
          output_tokens: number | null;
          pending: number;
          provider_cache_miss_reported_calls: number;
          provider_cache_miss_tokens: number | null;
          provider_cache_reported_calls: number;
          provider_cache_tokens: number | null;
          received: number;
          token_reported_calls: number;
          unknown: number;
          unpriced_calls: number;
        };
      }[];
      /** Format: date-time */
      generated_at: string;
      limitations: string[];
      local_reuse: {
        /** @enum {string} */
        coverage: "none" | "partial" | "complete";
        /** Format: date-time */
        observed_since: string;
        recorded_count: number | null;
      };
      material_costs: {
        actual: string;
        average_actual: string;
        average_estimated: string;
        currency: string;
        estimated: string;
        /** @enum {string} */
        kind: "article" | "policy";
        objects: number;
        recorded_calls: number;
      }[];
      material_unassigned_calls: number;
      month: string;
      /** Format: date-time */
      period_end: string;
      /** Format: date-time */
      period_start: string;
      top_tasks: {
        currency: string;
        items: {
          amount: string;
          calls: number;
          estimated: string;
          reference: string;
        }[];
      }[];
      totals: {
        amounts: {
          actual: string;
          currency: string;
          estimated: string;
        }[];
        cache_hit_rate: number | null;
        cache_pair_reported_calls: number;
        calls: number;
        failed: number;
        input_tokens: number | null;
        output_tokens: number | null;
        pending: number;
        provider_cache_miss_reported_calls: number;
        provider_cache_miss_tokens: number | null;
        provider_cache_reported_calls: number;
        provider_cache_tokens: number | null;
        received: number;
        token_reported_calls: number;
        unknown: number;
        unpriced_calls: number;
      };
    };
    MonthlyUsageReportInput: {
      by_capability: {
        key: string;
        label: string;
        totals: {
          amounts: {
            actual: string;
            currency: string;
            estimated: string;
          }[];
          cache_hit_rate: number | null;
          cache_pair_reported_calls: number;
          calls: number;
          failed: number;
          input_tokens: number | null;
          output_tokens: number | null;
          pending: number;
          provider_cache_miss_reported_calls: number;
          provider_cache_miss_tokens: number | null;
          provider_cache_reported_calls: number;
          provider_cache_tokens: number | null;
          received: number;
          token_reported_calls: number;
          unknown: number;
          unpriced_calls: number;
        };
      }[];
      by_lane: {
        key: string;
        label: string;
        totals: {
          amounts: {
            actual: string;
            currency: string;
            estimated: string;
          }[];
          cache_hit_rate: number | null;
          cache_pair_reported_calls: number;
          calls: number;
          failed: number;
          input_tokens: number | null;
          output_tokens: number | null;
          pending: number;
          provider_cache_miss_reported_calls: number;
          provider_cache_miss_tokens: number | null;
          provider_cache_reported_calls: number;
          provider_cache_tokens: number | null;
          received: number;
          token_reported_calls: number;
          unknown: number;
          unpriced_calls: number;
        };
      }[];
      by_service: {
        key: string;
        label: string;
        totals: {
          amounts: {
            actual: string;
            currency: string;
            estimated: string;
          }[];
          cache_hit_rate: number | null;
          cache_pair_reported_calls: number;
          calls: number;
          failed: number;
          input_tokens: number | null;
          output_tokens: number | null;
          pending: number;
          provider_cache_miss_reported_calls: number;
          provider_cache_miss_tokens: number | null;
          provider_cache_reported_calls: number;
          provider_cache_tokens: number | null;
          received: number;
          token_reported_calls: number;
          unknown: number;
          unpriced_calls: number;
        };
      }[];
      by_source: {
        key: string;
        label: string;
        totals: {
          amounts: {
            actual: string;
            currency: string;
            estimated: string;
          }[];
          cache_hit_rate: number | null;
          cache_pair_reported_calls: number;
          calls: number;
          failed: number;
          input_tokens: number | null;
          output_tokens: number | null;
          pending: number;
          provider_cache_miss_reported_calls: number;
          provider_cache_miss_tokens: number | null;
          provider_cache_reported_calls: number;
          provider_cache_tokens: number | null;
          received: number;
          token_reported_calls: number;
          unknown: number;
          unpriced_calls: number;
        };
      }[];
      by_usage_purpose: {
        key: string;
        label: string;
        totals: {
          amounts: {
            actual: string;
            currency: string;
            estimated: string;
          }[];
          cache_hit_rate: number | null;
          cache_pair_reported_calls: number;
          calls: number;
          failed: number;
          input_tokens: number | null;
          output_tokens: number | null;
          pending: number;
          provider_cache_miss_reported_calls: number;
          provider_cache_miss_tokens: number | null;
          provider_cache_reported_calls: number;
          provider_cache_tokens: number | null;
          received: number;
          token_reported_calls: number;
          unknown: number;
          unpriced_calls: number;
        };
      }[];
      /** Format: date-time */
      generated_at: string;
      limitations: string[];
      local_reuse: {
        /** @enum {string} */
        coverage: "none" | "partial" | "complete";
        /** Format: date-time */
        observed_since: string;
        recorded_count: number | null;
      };
      material_costs: {
        actual: string;
        average_actual: string;
        average_estimated: string;
        currency: string;
        estimated: string;
        /** @enum {string} */
        kind: "article" | "policy";
        objects: number;
        recorded_calls: number;
      }[];
      material_unassigned_calls: number;
      month: string;
      /** Format: date-time */
      period_end: string;
      /** Format: date-time */
      period_start: string;
      top_tasks: {
        currency: string;
        items: {
          amount: string;
          calls: number;
          estimated: string;
          reference: string;
        }[];
      }[];
      totals: {
        amounts: {
          actual: string;
          currency: string;
          estimated: string;
        }[];
        cache_hit_rate: number | null;
        cache_pair_reported_calls: number;
        calls: number;
        failed: number;
        input_tokens: number | null;
        output_tokens: number | null;
        pending: number;
        provider_cache_miss_reported_calls: number;
        provider_cache_miss_tokens: number | null;
        provider_cache_reported_calls: number;
        provider_cache_tokens: number | null;
        received: number;
        token_reported_calls: number;
        unknown: number;
        unpriced_calls: number;
      };
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
  laneControls: {
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
          "application/json": components["schemas"]["LaneControlsResponse"];
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
  laneControlAction: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["LaneControlActionRequestInput"];
      };
    };
    responses: {
      /** @description Default Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["LaneControlsResponse"];
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
      409: {
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
  modelConnectionProbe: {
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
          "application/json": components["schemas"]["ModelProbeRecord"];
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
  modelRegistry: {
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
          "application/json": components["schemas"]["ModelRegistryResponse"];
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
  createModelConnection: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["ModelConnectionCreateInput"];
      };
    };
    responses: {
      /** @description Default Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ModelConnectionRecord"];
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
  updateModelConnection: {
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
        "application/json": components["schemas"]["ModelConnectionUpdateInput"];
      };
    };
    responses: {
      /** @description Default Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ModelConnectionRecord"];
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
  disableModelConnection: {
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
        "application/json": components["schemas"]["ModelConnectionDisableInput"];
      };
    };
    responses: {
      /** @description Default Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ModelConnectionRecord"];
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
  probeModelConnection: {
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
        "application/json": components["schemas"]["ModelConnectionProbeInput"];
      };
    };
    responses: {
      /** @description Default Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ModelProbeRecord"];
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
  assignRegisteredModel: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        capability: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["ModelRouteChangeInput"];
      };
    };
    responses: {
      /** @description Default Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ModelRouteRecord"];
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
  usageMonthlyList: {
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
          "application/json": components["schemas"]["MonthlyUsageList"];
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
  usageMonthlyDetail: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        month: string;
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
          "application/json": components["schemas"]["MonthlyUsageEntry"];
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
