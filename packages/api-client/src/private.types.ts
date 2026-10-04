export interface paths {
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
  };
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
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
