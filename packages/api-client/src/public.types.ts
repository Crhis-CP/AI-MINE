export interface paths {
  "/api/site/pool": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["sitePool"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/site/stats": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["siteStats"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/site/timeline": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["siteTimeline"];
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
    FeedItemSummary: {
      category: ("ai-models" | "ai-products" | "industry" | "paper" | "tip" | "opinion") | null;
      /** @constant */
      channel: "news";
      id: string;
      publishedAt: string | null;
      reason: string | null;
      score: number | null;
      selected: boolean;
      source: {
        name: string;
      };
      summary: string | null;
      tags: string[];
      /** Format: date-time */
      timelineAt: string;
      title: string;
    };
    FeedItemSummaryInput: {
      category: ("ai-models" | "ai-products" | "industry" | "paper" | "tip" | "opinion") | null;
      /** @constant */
      channel: "news";
      id: string;
      publishedAt: string | null;
      reason: string | null;
      score: number | null;
      selected: boolean;
      source: {
        name: string;
      };
      summary: string | null;
      tags: string[];
      /** Format: date-time */
      timelineAt: string;
      title: string;
    };
    GroupInfo: {
      additionalSourceCount: number;
      developmentCount: number;
      factId: string;
      latestDevelopment?: {
        /** Format: date-time */
        at: string;
        factId: string;
        title: string;
      } | null;
      reportCount: number;
      story: components["schemas"]["StoryRef"] | null;
    };
    GroupInfoInput: {
      additionalSourceCount: number;
      developmentCount: number;
      factId: string;
      latestDevelopment?: {
        /** Format: date-time */
        at: string;
        factId: string;
        title: string;
      } | null;
      reportCount: number;
      story: components["schemas"]["StoryRefInput"] | null;
    };
    HotStripEntry: {
      heat: number;
      itemId: string | null;
      rank: number;
      storyPublicId: string | null;
      title: string;
      /** @enum {string} */
      trend: "up" | "down" | "flat" | "new" | "unknown";
    };
    HotStripEntryInput: {
      heat: number;
      itemId: string | null;
      rank: number;
      storyPublicId: string | null;
      title: string;
      /** @enum {string} */
      trend: "up" | "down" | "flat" | "new" | "unknown";
    };
    PoolResponse: {
      filters: {
        category: ("ai-models" | "ai-products" | "industry" | "paper" | "tip" | "opinion") | null;
        /** @enum {string} */
        channel: "all" | "news" | "firstParty";
        q: string | null;
        /** @enum {string} */
        tab: "time" | "relevance";
        tag: string | null;
        topic?: string | null;
      };
      /** Format: date-time */
      freshness: string;
      /** Format: date-time */
      generatedAt: string;
      items: components["schemas"]["FeedItemSummary"][];
      page: number;
      pageCount: number;
      todayCount: number;
      total: number;
    };
    PoolResponseInput: {
      filters: {
        category: ("ai-models" | "ai-products" | "industry" | "paper" | "tip" | "opinion") | null;
        /** @enum {string} */
        channel: "all" | "news" | "firstParty";
        q: string | null;
        /** @enum {string} */
        tab: "time" | "relevance";
        tag: string | null;
        topic?: string | null;
      };
      /** Format: date-time */
      freshness: string;
      /** Format: date-time */
      generatedAt: string;
      items: components["schemas"]["FeedItemSummaryInput"][];
      page: number;
      pageCount: number;
      todayCount: number;
      total: number;
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
    SiteFilters: {
      category: ("ai-models" | "ai-products" | "industry" | "paper" | "tip" | "opinion") | null;
      /** @enum {string} */
      channel: "all" | "news" | "firstParty";
      tag: string | null;
      topic?: string | null;
    };
    SiteFiltersInput: {
      category: ("ai-models" | "ai-products" | "industry" | "paper" | "tip" | "opinion") | null;
      /** @enum {string} */
      channel: "all" | "news" | "firstParty";
      tag: string | null;
      topic?: string | null;
    };
    SiteStats: {
      dailies: number;
      day: {
        collected: number;
        selected: number;
      };
      heatOnlySources: number;
      items: number;
      selected: number;
      sourceKinds: {
        [key: string]: number;
      };
      sources: number;
    };
    SiteStatsInput: {
      dailies: number;
      day: {
        collected: number;
        selected: number;
      };
      heatOnlySources: number;
      items: number;
      selected: number;
      sourceKinds: {
        [key: string]: number;
      };
      sources: number;
    };
    StoryRef: {
      publicId: string;
      title: string;
    };
    StoryRefInput: {
      publicId: string;
      title: string;
    };
    TimelineCard: {
      /** Format: date-time */
      anchorAt: string;
      group: components["schemas"]["GroupInfo"] | null;
      item: components["schemas"]["FeedItemSummary"];
      key: string;
    };
    TimelineCardInput: {
      /** Format: date-time */
      anchorAt: string;
      group: components["schemas"]["GroupInfoInput"] | null;
      item: components["schemas"]["FeedItemSummaryInput"];
      key: string;
    };
    TimelineResponse: {
      cards: components["schemas"]["TimelineCard"][];
      dayCounts: {
        [key: string]: number;
      };
      filters: components["schemas"]["SiteFilters"];
      /** Format: date-time */
      generatedAt: string;
      hot: components["schemas"]["HotStripEntry"][] | null;
      nextCursor: string | null;
      refreshAt: string | null;
    };
    TimelineResponseInput: {
      cards: components["schemas"]["TimelineCardInput"][];
      dayCounts: {
        [key: string]: number;
      };
      filters: components["schemas"]["SiteFiltersInput"];
      /** Format: date-time */
      generatedAt: string;
      hot: components["schemas"]["HotStripEntryInput"][] | null;
      nextCursor: string | null;
      refreshAt: string | null;
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
  sitePool: {
    parameters: {
      query?: {
        category?: "ai-models" | "ai-products" | "industry" | "paper" | "tip" | "opinion";
        channel?: "all" | "news" | "firstParty";
        page?: number;
        q?: string;
        tab?: "time" | "relevance";
        tag?: string;
        topic?: string;
      };
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
          "application/json": components["schemas"]["PoolResponse"];
        };
      };
      /** @description Default Response */
      304: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
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
  siteStats: {
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
          "application/json": components["schemas"]["SiteStats"];
        };
      };
      /** @description Default Response */
      304: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
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
  siteTimeline: {
    parameters: {
      query?: {
        category?: "ai-models" | "ai-products" | "industry" | "paper" | "tip" | "opinion";
        channel?: "all" | "news" | "firstParty";
        cursor?: string;
        limit?: number;
        tag?: string;
        topic?: string;
      };
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
          "application/json": components["schemas"]["TimelineResponse"];
        };
      };
      /** @description Default Response */
      304: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
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
