export interface paths {
  "/api/site/jurisdictions": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["siteJurisdictions"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/site/metal-prices": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["siteMetalPrices"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/site/policies": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["sitePolicies"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/site/policies/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["sitePolicy"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/site/policies/{id}/history": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["sitePolicyHistory"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/site/policies/{id}/reading": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["sitePolicyReading"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/site/policies/reports": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["sitePolicyReports"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/site/policies/reports/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["sitePolicyReport"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/site/policies/scope": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["sitePolicyScope"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/site/policy-threads/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["sitePolicyThread"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
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
  "/api/v1/policies": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["publicPolicies"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/policies/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["publicPolicy"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/policies/{id}/history": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["publicPolicyHistory"];
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
      category:
        | (
            | "policy_regulation"
            | "company_project"
            | "commodity_market"
            | "capital_ma"
            | "supply_trade_controls"
            | "esg_community_labor"
            | "safety_incident"
            | "technology_processing"
            | "exploration_resource"
          )
        | null;
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
      category:
        | (
            | "policy_regulation"
            | "company_project"
            | "commodity_market"
            | "capital_ma"
            | "supply_trade_controls"
            | "esg_community_labor"
            | "safety_incident"
            | "technology_processing"
            | "exploration_resource"
          )
        | null;
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
    MetalPrices: {
      /** Format: date-time */
      generatedAt: string;
      intro: string;
      latest: {
        extras: {
          label: string;
          metals: string[];
          stale: boolean;
        }[];
        label: string | null;
        stale: boolean;
        tag: string;
      }[];
      metals: {
        key: string;
        name: string;
        quotes: {
          change: {
            percent: string;
            previous: {
              period: {
                /** Format: date */
                end: string;
                label: string;
                /** Format: date */
                start: string;
              };
              value: string;
            };
          } | null;
          /** @enum {string} */
          currency: "CNY" | "USD";
          decimals: number | null;
          footnote: number | null;
          key: string;
          period: {
            /** Format: date */
            end: string;
            label: string;
            /** Format: date */
            start: string;
          } | null;
          source: string;
          spec: string | null;
          title: string;
          unit: string;
          value: string | null;
        }[];
      }[];
      notes: {
        link: {
          name: string;
          /** Format: uri */
          url: string;
        } | null;
        ref: number | null;
        text: string;
      }[];
      officialLinks: {
        name: string;
        note: string;
        /** Format: uri */
        url: string;
      }[];
      sources: {
        key: string;
        latest: {
          label: string;
          release: {
            date: string | null;
            label: string;
            /** Format: uri */
            url: string;
          };
        } | null;
        name: string;
        /** @enum {string} */
        status: "fresh" | "stale" | "empty";
        tag: string;
      }[];
    };
    MetalPricesInput: {
      /** Format: date-time */
      generatedAt: string;
      intro: string;
      latest: {
        extras: {
          label: string;
          metals: string[];
          stale: boolean;
        }[];
        label: string | null;
        stale: boolean;
        tag: string;
      }[];
      metals: {
        key: string;
        name: string;
        quotes: {
          change: {
            percent: string;
            previous: {
              period: {
                /** Format: date */
                end: string;
                label: string;
                /** Format: date */
                start: string;
              };
              value: string;
            };
          } | null;
          /** @enum {string} */
          currency: "CNY" | "USD";
          decimals: number | null;
          footnote: number | null;
          key: string;
          period: {
            /** Format: date */
            end: string;
            label: string;
            /** Format: date */
            start: string;
          } | null;
          source: string;
          spec: string | null;
          title: string;
          unit: string;
          value: string | null;
        }[];
      }[];
      notes: {
        link: {
          name: string;
          /** Format: uri */
          url: string;
        } | null;
        ref: number | null;
        text: string;
      }[];
      officialLinks: {
        name: string;
        note: string;
        /** Format: uri */
        url: string;
      }[];
      sources: {
        key: string;
        latest: {
          label: string;
          release: {
            date: string | null;
            label: string;
            /** Format: uri */
            url: string;
          };
        } | null;
        name: string;
        /** @enum {string} */
        status: "fresh" | "stale" | "empty";
        tag: string;
      }[];
    };
    Policy: {
      /** @enum {string} */
      ai_label: "ai_generated" | "ai_assisted_human_edited";
      ai_metadata: {
        content_id: string;
        provider: string;
      };
      applicability_summary: string | null;
      attachment_inventory: {
        decisive: boolean;
        /** @enum {string} */
        rights: "public" | "restricted" | "unknown";
        /** @enum {string} */
        status: "complete" | "missing" | "restricted" | "not_required" | "blocked_capacity";
        title: string;
        /** Format: uri */
        url: string;
      }[];
      attributions: {
        name: string;
        /** Format: uri */
        url: string;
      }[];
      authority: {
        id: string;
        name: string;
      };
      change_kind: {
        /** @enum {string} */
        code: "first_publication" | "substantive_change" | "correction" | "repeal" | "enforcement" | "registration_compilation" | "other";
        label: string;
      } | null;
      dates: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      }[];
      evidence: components["schemas"]["PolicyEvidence"][];
      expressions: components["schemas"]["PolicyExpression"][];
      first_public_at: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      };
      /** @enum {string} */
      first_public_basis: "live" | "unknown";
      gaps: string[];
      guide: string | null;
      id: string;
      impacts: components["schemas"]["PolicyImpact"][];
      instrument_number: string | null;
      /** @enum {string} */
      interpretation_state: "basic_facts" | "partial" | "complete" | "withheld";
      is_backfill: boolean;
      jurisdictions: components["schemas"]["PolicyJurisdiction"][];
      legal_brief: {
        /** @enum {string} */
        in_force: "yes" | "partial" | "no" | "unknown";
        /** @enum {string} */
        repeal: "repealed" | "partly_repealed" | "unknown";
        /** @enum {string} */
        stage: "proposed" | "consultation" | "adopted" | "published" | "unknown";
      };
      legal_state: components["schemas"]["PolicyLegalState"];
      limitation: string;
      main_points: {
        clause_ref: string;
        evidence_ids: string[];
        text: string;
      }[];
      nature: {
        /** @enum {string} */
        code: "law" | "regulation" | "amendment" | "draft" | "notice" | "guidance" | "treaty" | "judgment" | "unknown";
        label: string;
      };
      original_title: string;
      /** Format: uri */
      original_url: string;
      published_time: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      };
      reading: components["schemas"]["PolicyReadingSummary"] | null;
      related_items: {
        id: string;
        title: string;
      }[];
      relationships: {
        evidence_ids: string[];
        /** @enum {string} */
        relation: "updates" | "corrects" | "repeals" | "implements" | "related";
        target_citation: string;
        target_policy_id: string | null;
      }[];
      sections: {
        /** @enum {string} */
        basis: "source_fact" | "interpretation" | "uncertain";
        conditions: string[];
        evidence_ids: string[];
        exceptions: string[];
        text: string;
        title: string;
      }[];
      selected_expression_id: string | null;
      selected_policy_version_id: string | null;
      sort_kind: ("published" | "substantive_change") | null;
      sort_time: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      } | null;
      source_checked_at: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      } | null;
      summary: string | null;
      themes: {
        /** @enum {string} */
        code: "investment_company" | "mineral_rights" | "land_construction" | "safety_environment" | "labour_community" | "tax_finance" | "trade_transport";
        label: string;
      }[];
      thread_id: string | null;
      title: string;
      versions: components["schemas"]["PolicyVersionRef"][];
    };
    PolicyCard: {
      /** @enum {string} */
      ai_label: "ai_generated" | "ai_assisted_human_edited";
      applicability_summary: string | null;
      attributions: {
        name: string;
        /** Format: uri */
        url: string;
      }[];
      authority: {
        id: string;
        name: string;
      };
      change_kind: {
        /** @enum {string} */
        code: "first_publication" | "substantive_change" | "correction" | "repeal" | "enforcement" | "registration_compilation" | "other";
        label: string;
      } | null;
      first_public_at: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      };
      /** @enum {string} */
      first_public_basis: "live" | "unknown";
      id: string;
      instrument_number: string | null;
      /** @enum {string} */
      interpretation_state: "basic_facts" | "partial" | "complete" | "withheld";
      is_backfill: boolean;
      jurisdictions: components["schemas"]["PolicyJurisdiction"][];
      legal_brief: {
        /** @enum {string} */
        in_force: "yes" | "partial" | "no" | "unknown";
        /** @enum {string} */
        repeal: "repealed" | "partly_repealed" | "unknown";
        /** @enum {string} */
        stage: "proposed" | "consultation" | "adopted" | "published" | "unknown";
      };
      nature: {
        /** @enum {string} */
        code: "law" | "regulation" | "amendment" | "draft" | "notice" | "guidance" | "treaty" | "judgment" | "unknown";
        label: string;
      };
      original_title: string;
      /** Format: uri */
      original_url: string;
      published_time: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      };
      sort_kind: ("published" | "substantive_change") | null;
      sort_time: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      } | null;
      source_checked_at: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      } | null;
      summary: string | null;
      themes: {
        /** @enum {string} */
        code: "investment_company" | "mineral_rights" | "land_construction" | "safety_environment" | "labour_community" | "tax_finance" | "trade_transport";
        label: string;
      }[];
      thread_id: string | null;
      title: string;
    };
    PolicyCardInput: {
      /** @enum {string} */
      ai_label: "ai_generated" | "ai_assisted_human_edited";
      applicability_summary: string | null;
      attributions: {
        name: string;
        /** Format: uri */
        url: string;
      }[];
      authority: {
        id: string;
        name: string;
      };
      change_kind: {
        /** @enum {string} */
        code: "first_publication" | "substantive_change" | "correction" | "repeal" | "enforcement" | "registration_compilation" | "other";
        label: string;
      } | null;
      first_public_at: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      };
      /** @enum {string} */
      first_public_basis: "live" | "unknown";
      id: string;
      instrument_number: string | null;
      /** @enum {string} */
      interpretation_state: "basic_facts" | "partial" | "complete" | "withheld";
      is_backfill: boolean;
      jurisdictions: components["schemas"]["PolicyJurisdictionInput"][];
      legal_brief: {
        /** @enum {string} */
        in_force: "yes" | "partial" | "no" | "unknown";
        /** @enum {string} */
        repeal: "repealed" | "partly_repealed" | "unknown";
        /** @enum {string} */
        stage: "proposed" | "consultation" | "adopted" | "published" | "unknown";
      };
      nature: {
        /** @enum {string} */
        code: "law" | "regulation" | "amendment" | "draft" | "notice" | "guidance" | "treaty" | "judgment" | "unknown";
        label: string;
      };
      original_title: string;
      /** Format: uri */
      original_url: string;
      published_time: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      };
      sort_kind: ("published" | "substantive_change") | null;
      sort_time: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      } | null;
      source_checked_at: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      } | null;
      summary: string | null;
      themes: {
        /** @enum {string} */
        code: "investment_company" | "mineral_rights" | "land_construction" | "safety_environment" | "labour_community" | "tax_finance" | "trade_transport";
        label: string;
      }[];
      thread_id: string | null;
      title: string;
    };
    PolicyCursorResponse: {
      content_version: string;
      /** Format: date-time */
      generated_at: string;
      items: components["schemas"]["PolicyCard"][];
      next_cursor: string | null;
    };
    PolicyCursorResponseInput: {
      content_version: string;
      /** Format: date-time */
      generated_at: string;
      items: components["schemas"]["PolicyCardInput"][];
      next_cursor: string | null;
    };
    PolicyDateArrangement: {
      condition: string | null;
      evidence_ids: string[];
      /** @enum {string} */
      occurrence: "occurred" | "planned" | "conditional" | "unknown";
      scope: string | null;
      text: string;
      time: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      } | null;
    };
    PolicyDateArrangementInput: {
      condition: string | null;
      evidence_ids: string[];
      /** @enum {string} */
      occurrence: "occurred" | "planned" | "conditional" | "unknown";
      scope: string | null;
      text: string;
      time: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      } | null;
    };
    PolicyEvidence: {
      evidence_id: string;
      excerpt: string | null;
      locator: string;
      /** @enum {string} */
      relation: "supports" | "contradicts" | "context";
      source: {
        insecure_transport: boolean;
        /** Format: uri */
        original_url: string;
        published_time: {
          basis: string;
          beijing_date: string | null;
          condition_text: string | null;
          label: string;
          local_date: string | null;
          local_time: string | null;
          /** @enum {string} */
          meaning:
            | "published"
            | "updated"
            | "registered"
            | "public_inspection"
            | "formally_published"
            | "signed"
            | "effective"
            | "applicable"
            | "deadline"
            | "compiled"
            | "expires"
            | "event"
            | "discovered"
            | "site_public"
            | "uploaded"
            | "checked"
            | "repealed";
          meaning_label: string;
          /**
           * @default date
           * @enum {string}
           */
          precision: "unknown" | "date" | "minute" | "second";
          raw: string;
          timezone: string | null;
          utc: string | null;
        };
        publisher: {
          id: string;
          name: string;
        };
        source_id: string;
        title_original: string;
      };
    };
    PolicyEvidenceInput: {
      evidence_id: string;
      excerpt: string | null;
      locator: string;
      /** @enum {string} */
      relation: "supports" | "contradicts" | "context";
      source: {
        insecure_transport: boolean;
        /** Format: uri */
        original_url: string;
        published_time: {
          basis: string;
          beijing_date: string | null;
          condition_text: string | null;
          label: string;
          local_date: string | null;
          local_time: string | null;
          /** @enum {string} */
          meaning:
            | "published"
            | "updated"
            | "registered"
            | "public_inspection"
            | "formally_published"
            | "signed"
            | "effective"
            | "applicable"
            | "deadline"
            | "compiled"
            | "expires"
            | "event"
            | "discovered"
            | "site_public"
            | "uploaded"
            | "checked"
            | "repealed";
          meaning_label: string;
          /**
           * @default date
           * @enum {string}
           */
          precision: "unknown" | "date" | "minute" | "second";
          raw: string;
          timezone: string | null;
          utc: string | null;
        };
        publisher: {
          id: string;
          name: string;
        };
        source_id: string;
        title_original: string;
      };
    };
    PolicyExpression: {
      checked_at: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      } | null;
      document_revision_id: string;
      id: string;
      instrument_number: string | null;
      issuing_body: string | null;
      /** @enum {string} */
      kind: "original" | "official_translation" | "ai_translation";
      language: string;
      policy_version_id: string;
      /** @enum {string} */
      reading_state: "complete" | "partial" | "restricted" | "unavailable";
    };
    PolicyExpressionInput: {
      checked_at: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      } | null;
      document_revision_id: string;
      id: string;
      instrument_number: string | null;
      issuing_body: string | null;
      /** @enum {string} */
      kind: "original" | "official_translation" | "ai_translation";
      language: string;
      policy_version_id: string;
      /** @enum {string} */
      reading_state: "complete" | "partial" | "restricted" | "unavailable";
    };
    PolicyHistoryEntry: {
      checked_at: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      } | null;
      current: boolean;
      document_revision_id: string;
      expression_id: string;
      first_public_at: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      };
      instrument_number: string | null;
      /** @enum {string} */
      kind: "original" | "official_translation" | "ai_translation";
      language: string;
      original_version: string;
      policy_version_id: string;
      published_time: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      };
    };
    PolicyHistoryEntryInput: {
      checked_at: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      } | null;
      current: boolean;
      document_revision_id: string;
      expression_id: string;
      first_public_at: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      };
      instrument_number: string | null;
      /** @enum {string} */
      kind: "original" | "official_translation" | "ai_translation";
      language: string;
      original_version: string;
      policy_version_id: string;
      published_time: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      };
    };
    PolicyHistoryPage: {
      content_version: string;
      /** Format: date-time */
      generated_at: string;
      items: components["schemas"]["PolicyHistoryEntry"][];
      next_cursor: string | null;
      policy_id: string;
    };
    PolicyHistoryPageInput: {
      content_version: string;
      /** Format: date-time */
      generated_at: string;
      items: components["schemas"]["PolicyHistoryEntryInput"][];
      next_cursor: string | null;
      policy_id: string;
    };
    PolicyImpact: {
      activity: string;
      affected_actor: string;
      condition: string;
      deadline: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      } | null;
      /** @enum {string} */
      effect_mode: "direct" | "indirect";
      evidence_ids: string[];
      exceptions: string | null;
      id: string;
      impact: string;
      legal_actor: string;
      region: string;
      /** @enum {string} */
      theme: "investment_company" | "mineral_rights" | "land_construction" | "safety_environment" | "labour_community" | "tax_finance" | "trade_transport";
    };
    PolicyImpactInput: {
      activity: string;
      affected_actor: string;
      condition: string;
      deadline: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      } | null;
      /** @enum {string} */
      effect_mode: "direct" | "indirect";
      evidence_ids: string[];
      exceptions: string | null;
      id: string;
      impact: string;
      legal_actor: string;
      region: string;
      /** @enum {string} */
      theme: "investment_company" | "mineral_rights" | "land_construction" | "safety_environment" | "labour_community" | "tax_finance" | "trade_transport";
    };
    PolicyInput: {
      /** @enum {string} */
      ai_label: "ai_generated" | "ai_assisted_human_edited";
      ai_metadata: {
        content_id: string;
        provider: string;
      };
      applicability_summary: string | null;
      attachment_inventory: {
        decisive: boolean;
        /** @enum {string} */
        rights: "public" | "restricted" | "unknown";
        /** @enum {string} */
        status: "complete" | "missing" | "restricted" | "not_required" | "blocked_capacity";
        title: string;
        /** Format: uri */
        url: string;
      }[];
      attributions: {
        name: string;
        /** Format: uri */
        url: string;
      }[];
      authority: {
        id: string;
        name: string;
      };
      change_kind: {
        /** @enum {string} */
        code: "first_publication" | "substantive_change" | "correction" | "repeal" | "enforcement" | "registration_compilation" | "other";
        label: string;
      } | null;
      dates: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      }[];
      evidence: components["schemas"]["PolicyEvidenceInput"][];
      expressions: components["schemas"]["PolicyExpressionInput"][];
      first_public_at: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      };
      /** @enum {string} */
      first_public_basis: "live" | "unknown";
      gaps: string[];
      guide: string | null;
      id: string;
      impacts: components["schemas"]["PolicyImpactInput"][];
      instrument_number: string | null;
      /** @enum {string} */
      interpretation_state: "basic_facts" | "partial" | "complete" | "withheld";
      is_backfill: boolean;
      jurisdictions: components["schemas"]["PolicyJurisdictionInput"][];
      legal_brief: {
        /** @enum {string} */
        in_force: "yes" | "partial" | "no" | "unknown";
        /** @enum {string} */
        repeal: "repealed" | "partly_repealed" | "unknown";
        /** @enum {string} */
        stage: "proposed" | "consultation" | "adopted" | "published" | "unknown";
      };
      legal_state: components["schemas"]["PolicyLegalStateInput"];
      limitation: string;
      main_points: {
        clause_ref: string;
        evidence_ids: string[];
        text: string;
      }[];
      nature: {
        /** @enum {string} */
        code: "law" | "regulation" | "amendment" | "draft" | "notice" | "guidance" | "treaty" | "judgment" | "unknown";
        label: string;
      };
      original_title: string;
      /** Format: uri */
      original_url: string;
      published_time: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      };
      reading: components["schemas"]["PolicyReadingSummaryInput"] | null;
      related_items: {
        id: string;
        title: string;
      }[];
      relationships: {
        evidence_ids: string[];
        /** @enum {string} */
        relation: "updates" | "corrects" | "repeals" | "implements" | "related";
        target_citation: string;
        target_policy_id: string | null;
      }[];
      sections: {
        /** @enum {string} */
        basis: "source_fact" | "interpretation" | "uncertain";
        conditions: string[];
        evidence_ids: string[];
        exceptions: string[];
        text: string;
        title: string;
      }[];
      selected_expression_id: string | null;
      selected_policy_version_id: string | null;
      sort_kind: ("published" | "substantive_change") | null;
      sort_time: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      } | null;
      source_checked_at: {
        basis: string;
        beijing_date: string | null;
        condition_text: string | null;
        label: string;
        local_date: string | null;
        local_time: string | null;
        /** @enum {string} */
        meaning:
          | "published"
          | "updated"
          | "registered"
          | "public_inspection"
          | "formally_published"
          | "signed"
          | "effective"
          | "applicable"
          | "deadline"
          | "compiled"
          | "expires"
          | "event"
          | "discovered"
          | "site_public"
          | "uploaded"
          | "checked"
          | "repealed";
        meaning_label: string;
        /**
         * @default date
         * @enum {string}
         */
        precision: "unknown" | "date" | "minute" | "second";
        raw: string;
        timezone: string | null;
        utc: string | null;
      } | null;
      summary: string | null;
      themes: {
        /** @enum {string} */
        code: "investment_company" | "mineral_rights" | "land_construction" | "safety_environment" | "labour_community" | "tax_finance" | "trade_transport";
        label: string;
      }[];
      thread_id: string | null;
      title: string;
      versions: components["schemas"]["PolicyVersionRefInput"][];
    };
    PolicyJurisdiction: {
      code: string;
      /** @enum {string} */
      kind: "country" | "subdivision" | "organization";
      label: string;
      parent?: string;
    };
    PolicyJurisdictionInput: {
      code: string;
      /** @enum {string} */
      kind: "country" | "subdivision" | "organization";
      label: string;
      parent?: string;
    };
    PolicyJurisdictionList: {
      code: string;
      /** @enum {string} */
      kind: "country" | "subdivision" | "organization";
      label: string;
      news_count: number;
      news_scope: boolean;
      parent?: string;
      policy_count: number;
      policy_scope: boolean;
    }[];
    PolicyJurisdictionListInput: {
      code: string;
      /** @enum {string} */
      kind: "country" | "subdivision" | "organization";
      label: string;
      news_count: number;
      news_scope: boolean;
      parent?: string;
      policy_count: number;
      policy_scope: boolean;
    }[];
    PolicyLegalState: {
      applicability: components["schemas"]["PolicyDateArrangement"][];
      deadlines: components["schemas"]["PolicyDateArrangement"][];
      enforcement: {
        arrangements: components["schemas"]["PolicyDateArrangement"][];
        basis: string | null;
        evidence_ids: string[];
        /** @enum {string} */
        value: "whole" | "partial" | "not_in_force" | "unknown";
      };
      legislative_stage: {
        basis: string | null;
        evidence_ids: string[];
        /** @enum {string} */
        value: "proposed" | "consultation" | "adopted" | "published" | "unknown";
      };
      nature: {
        basis: string | null;
        evidence_ids: string[];
        /** @enum {string} */
        value: "law" | "regulation" | "amendment" | "draft" | "notice" | "guidance" | "treaty" | "judgment" | "unknown";
      };
      publication: {
        basis: string | null;
        evidence_ids: string[];
        time: {
          basis: string;
          beijing_date: string | null;
          condition_text: string | null;
          label: string;
          local_date: string | null;
          local_time: string | null;
          /** @enum {string} */
          meaning:
            | "published"
            | "updated"
            | "registered"
            | "public_inspection"
            | "formally_published"
            | "signed"
            | "effective"
            | "applicable"
            | "deadline"
            | "compiled"
            | "expires"
            | "event"
            | "discovered"
            | "site_public"
            | "uploaded"
            | "checked"
            | "repealed";
          meaning_label: string;
          /**
           * @default date
           * @enum {string}
           */
          precision: "unknown" | "date" | "minute" | "second";
          raw: string;
          timezone: string | null;
          utc: string | null;
        } | null;
        /** @enum {string} */
        value: "published" | "not_published" | "unknown";
      };
      repeal: {
        basis: string | null;
        evidence_ids: string[];
        /** @enum {string} */
        value: "repealed" | "partly_repealed" | "unknown";
      };
    };
    PolicyLegalStateInput: {
      applicability: components["schemas"]["PolicyDateArrangementInput"][];
      deadlines: components["schemas"]["PolicyDateArrangementInput"][];
      enforcement: {
        arrangements: components["schemas"]["PolicyDateArrangementInput"][];
        basis: string | null;
        evidence_ids: string[];
        /** @enum {string} */
        value: "whole" | "partial" | "not_in_force" | "unknown";
      };
      legislative_stage: {
        basis: string | null;
        evidence_ids: string[];
        /** @enum {string} */
        value: "proposed" | "consultation" | "adopted" | "published" | "unknown";
      };
      nature: {
        basis: string | null;
        evidence_ids: string[];
        /** @enum {string} */
        value: "law" | "regulation" | "amendment" | "draft" | "notice" | "guidance" | "treaty" | "judgment" | "unknown";
      };
      publication: {
        basis: string | null;
        evidence_ids: string[];
        time: {
          basis: string;
          beijing_date: string | null;
          condition_text: string | null;
          label: string;
          local_date: string | null;
          local_time: string | null;
          /** @enum {string} */
          meaning:
            | "published"
            | "updated"
            | "registered"
            | "public_inspection"
            | "formally_published"
            | "signed"
            | "effective"
            | "applicable"
            | "deadline"
            | "compiled"
            | "expires"
            | "event"
            | "discovered"
            | "site_public"
            | "uploaded"
            | "checked"
            | "repealed";
          meaning_label: string;
          /**
           * @default date
           * @enum {string}
           */
          precision: "unknown" | "date" | "minute" | "second";
          raw: string;
          timezone: string | null;
          utc: string | null;
        } | null;
        /** @enum {string} */
        value: "published" | "not_published" | "unknown";
      };
      repeal: {
        basis: string | null;
        evidence_ids: string[];
        /** @enum {string} */
        value: "repealed" | "partly_repealed" | "unknown";
      };
    };
    PolicyListResponse: {
      content_version: string;
      /** Format: date-time */
      generated_at: string;
      has_more: boolean;
      items: components["schemas"]["PolicyCard"][];
      page: number;
      page_size: number;
      total: number;
    };
    PolicyListResponseInput: {
      content_version: string;
      /** Format: date-time */
      generated_at: string;
      has_more: boolean;
      items: components["schemas"]["PolicyCardInput"][];
      page: number;
      page_size: number;
      total: number;
    };
    PolicyReadingBlock: {
      block_id: string;
      evidence_ids: string[];
      /** @enum {string} */
      kind: "heading" | "paragraph" | "list_item" | "table" | "quote" | "footnote";
      links: {
        /** Format: uri */
        href: string;
        label: string;
      }[];
      table_rows: string[][] | null;
      text: string;
    };
    PolicyReadingBlockInput: {
      block_id: string;
      evidence_ids: string[];
      /** @enum {string} */
      kind: "heading" | "paragraph" | "list_item" | "table" | "quote" | "footnote";
      links: {
        /** Format: uri */
        href: string;
        label: string;
      }[];
      table_rows: string[][] | null;
      text: string;
    };
    PolicyReadingPage: {
      blocks: components["schemas"]["PolicyReadingBlock"][];
      content_version: string;
      document_revision_id: string;
      expression_id: string;
      /** Format: date-time */
      generated_at: string;
      language: string;
      /** @enum {string} */
      mode: "original" | "official_translation" | "ai_translation";
      next_cursor: string | null;
      /** @enum {string} */
      resource_completeness: "complete" | "partial" | "excerpt" | "unavailable";
      subject_id: string;
      total_blocks: number;
    };
    PolicyReadingPageInput: {
      blocks: components["schemas"]["PolicyReadingBlockInput"][];
      content_version: string;
      document_revision_id: string;
      expression_id: string;
      /** Format: date-time */
      generated_at: string;
      language: string;
      /** @enum {string} */
      mode: "original" | "official_translation" | "ai_translation";
      next_cursor: string | null;
      /** @enum {string} */
      resource_completeness: "complete" | "partial" | "excerpt" | "unavailable";
      subject_id: string;
      total_blocks: number;
    };
    PolicyReadingSummary: {
      attribution: string;
      blocks: components["schemas"]["PolicyReadingBlock"][];
      completed_blocks: number;
      /** @enum {string} */
      completeness: "complete" | "partial" | "excerpt" | "unavailable";
      document_revision_id: string;
      expression_id: string;
      language: string;
      limitation: string | null;
      mode: ("original" | "official_translation" | "ai_translation") | null;
      next_cursor: string | null;
      /** @enum {string} */
      redistribution: "allowed" | "restricted";
      /** @enum {string} */
      state: "not_needed" | "pending" | "in_progress" | "complete" | "guide_only" | "failed_terminal";
      total_blocks: number;
    };
    PolicyReadingSummaryInput: {
      attribution: string;
      blocks: components["schemas"]["PolicyReadingBlockInput"][];
      completed_blocks: number;
      /** @enum {string} */
      completeness: "complete" | "partial" | "excerpt" | "unavailable";
      document_revision_id: string;
      expression_id: string;
      language: string;
      limitation: string | null;
      mode: ("original" | "official_translation" | "ai_translation") | null;
      next_cursor: string | null;
      /** @enum {string} */
      redistribution: "allowed" | "restricted";
      /** @enum {string} */
      state: "not_needed" | "pending" | "in_progress" | "complete" | "guide_only" | "failed_terminal";
      total_blocks: number;
    };
    PolicyReport: {
      /** @enum {string} */
      ai_label: "ai_generated" | "ai_assisted_human_edited";
      ai_metadata: {
        content_id: string;
        provider: string;
      };
      attributions: {
        name: string;
        /** Format: uri */
        url: string;
      }[];
      content_version: string;
      correction_of: string | null;
      coverage: {
        available_count: number;
        complete_receipt_count: number;
        failures: {
          category: string;
          end: string | null;
          /** Format: date-time */
          start: string;
        }[];
        incomplete_receipt_count: number;
        jurisdiction: components["schemas"]["PolicyJurisdiction"];
        missing_receipt_count: number;
        registered_source_count: number;
      }[];
      coverage_note: string;
      edition: number;
      /** Format: date-time */
      generated_at: string;
      groups: {
        documents: {
          policy: components["schemas"]["PolicyCard"];
          versions: {
            checked_at: {
              basis: string;
              beijing_date: string | null;
              condition_text: string | null;
              label: string;
              local_date: string | null;
              local_time: string | null;
              /** @enum {string} */
              meaning:
                | "published"
                | "updated"
                | "registered"
                | "public_inspection"
                | "formally_published"
                | "signed"
                | "effective"
                | "applicable"
                | "deadline"
                | "compiled"
                | "expires"
                | "event"
                | "discovered"
                | "site_public"
                | "uploaded"
                | "checked"
                | "repealed";
              meaning_label: string;
              /**
               * @default date
               * @enum {string}
               */
              precision: "unknown" | "date" | "minute" | "second";
              raw: string;
              timezone: string | null;
              utc: string | null;
            } | null;
            current: boolean;
            document_revision_id: string;
            expression_id: string;
            first_public_at: {
              basis: string;
              beijing_date: string | null;
              condition_text: string | null;
              label: string;
              local_date: string | null;
              local_time: string | null;
              /** @enum {string} */
              meaning:
                | "published"
                | "updated"
                | "registered"
                | "public_inspection"
                | "formally_published"
                | "signed"
                | "effective"
                | "applicable"
                | "deadline"
                | "compiled"
                | "expires"
                | "event"
                | "discovered"
                | "site_public"
                | "uploaded"
                | "checked"
                | "repealed";
              meaning_label: string;
              /**
               * @default date
               * @enum {string}
               */
              precision: "unknown" | "date" | "minute" | "second";
              raw: string;
              timezone: string | null;
              utc: string | null;
            };
            instrument_number: string | null;
            /** @enum {string} */
            kind: "original" | "official_translation" | "ai_translation";
            /** @enum {string} */
            label: "period_change" | "source_date_unknown" | "backfill" | "interpretation_update";
            language: string;
            original_version: string;
            policy_version_id: string;
            public_after_period_end: boolean;
            published_time: {
              basis: string;
              beijing_date: string | null;
              condition_text: string | null;
              label: string;
              local_date: string | null;
              local_time: string | null;
              /** @enum {string} */
              meaning:
                | "published"
                | "updated"
                | "registered"
                | "public_inspection"
                | "formally_published"
                | "signed"
                | "effective"
                | "applicable"
                | "deadline"
                | "compiled"
                | "expires"
                | "event"
                | "discovered"
                | "site_public"
                | "uploaded"
                | "checked"
                | "repealed";
              meaning_label: string;
              /**
               * @default date
               * @enum {string}
               */
              precision: "unknown" | "date" | "minute" | "second";
              raw: string;
              timezone: string | null;
              utc: string | null;
            };
            summary: string | null;
          }[];
        }[];
        /** @enum {string} */
        kind: "domestic" | "foreign" | "organizations";
      }[];
      id: string;
      /** Format: date-time */
      issued_at: string;
      item_count: number;
      limitation: string;
      next_cursor: string | null;
      pending_interpretations: components["schemas"]["PolicyCard"][];
      /** Format: date-time */
      period_end: string;
      period_key: string;
      /** Format: date-time */
      period_start: string;
      /** @enum {string} */
      status: "compiled" | "synthesizing" | "ready" | "synthesis_failed";
      summary: string | null;
      /** @constant */
      timezone: "Asia/Shanghai";
      title: string;
      /** @enum {string} */
      type: "policy_weekly" | "policy_monthly";
    };
    PolicyReportCard: {
      /** @enum {string} */
      ai_label: "ai_generated" | "ai_assisted_human_edited";
      correction_of: string | null;
      coverage_note: string;
      edition: number;
      id: string;
      /** Format: date-time */
      issued_at: string;
      item_count: number;
      /** Format: date-time */
      period_end: string;
      period_key: string;
      /** Format: date-time */
      period_start: string;
      /** @enum {string} */
      status: "compiled" | "synthesizing" | "ready" | "synthesis_failed";
      summary: string | null;
      /** @constant */
      timezone: "Asia/Shanghai";
      title: string;
      /** @enum {string} */
      type: "policy_weekly" | "policy_monthly";
    };
    PolicyReportCardInput: {
      /** @enum {string} */
      ai_label: "ai_generated" | "ai_assisted_human_edited";
      correction_of: string | null;
      coverage_note: string;
      edition: number;
      id: string;
      /** Format: date-time */
      issued_at: string;
      item_count: number;
      /** Format: date-time */
      period_end: string;
      period_key: string;
      /** Format: date-time */
      period_start: string;
      /** @enum {string} */
      status: "compiled" | "synthesizing" | "ready" | "synthesis_failed";
      summary: string | null;
      /** @constant */
      timezone: "Asia/Shanghai";
      title: string;
      /** @enum {string} */
      type: "policy_weekly" | "policy_monthly";
    };
    PolicyReportInput: {
      /** @enum {string} */
      ai_label: "ai_generated" | "ai_assisted_human_edited";
      ai_metadata: {
        content_id: string;
        provider: string;
      };
      attributions: {
        name: string;
        /** Format: uri */
        url: string;
      }[];
      content_version: string;
      correction_of: string | null;
      coverage: {
        available_count: number;
        complete_receipt_count: number;
        failures: {
          category: string;
          end: string | null;
          /** Format: date-time */
          start: string;
        }[];
        incomplete_receipt_count: number;
        jurisdiction: components["schemas"]["PolicyJurisdictionInput"];
        missing_receipt_count: number;
        registered_source_count: number;
      }[];
      coverage_note: string;
      edition: number;
      /** Format: date-time */
      generated_at: string;
      groups: {
        documents: {
          policy: components["schemas"]["PolicyCardInput"];
          versions: {
            checked_at: {
              basis: string;
              beijing_date: string | null;
              condition_text: string | null;
              label: string;
              local_date: string | null;
              local_time: string | null;
              /** @enum {string} */
              meaning:
                | "published"
                | "updated"
                | "registered"
                | "public_inspection"
                | "formally_published"
                | "signed"
                | "effective"
                | "applicable"
                | "deadline"
                | "compiled"
                | "expires"
                | "event"
                | "discovered"
                | "site_public"
                | "uploaded"
                | "checked"
                | "repealed";
              meaning_label: string;
              /**
               * @default date
               * @enum {string}
               */
              precision: "unknown" | "date" | "minute" | "second";
              raw: string;
              timezone: string | null;
              utc: string | null;
            } | null;
            current: boolean;
            document_revision_id: string;
            expression_id: string;
            first_public_at: {
              basis: string;
              beijing_date: string | null;
              condition_text: string | null;
              label: string;
              local_date: string | null;
              local_time: string | null;
              /** @enum {string} */
              meaning:
                | "published"
                | "updated"
                | "registered"
                | "public_inspection"
                | "formally_published"
                | "signed"
                | "effective"
                | "applicable"
                | "deadline"
                | "compiled"
                | "expires"
                | "event"
                | "discovered"
                | "site_public"
                | "uploaded"
                | "checked"
                | "repealed";
              meaning_label: string;
              /**
               * @default date
               * @enum {string}
               */
              precision: "unknown" | "date" | "minute" | "second";
              raw: string;
              timezone: string | null;
              utc: string | null;
            };
            instrument_number: string | null;
            /** @enum {string} */
            kind: "original" | "official_translation" | "ai_translation";
            /** @enum {string} */
            label: "period_change" | "source_date_unknown" | "backfill" | "interpretation_update";
            language: string;
            original_version: string;
            policy_version_id: string;
            public_after_period_end: boolean;
            published_time: {
              basis: string;
              beijing_date: string | null;
              condition_text: string | null;
              label: string;
              local_date: string | null;
              local_time: string | null;
              /** @enum {string} */
              meaning:
                | "published"
                | "updated"
                | "registered"
                | "public_inspection"
                | "formally_published"
                | "signed"
                | "effective"
                | "applicable"
                | "deadline"
                | "compiled"
                | "expires"
                | "event"
                | "discovered"
                | "site_public"
                | "uploaded"
                | "checked"
                | "repealed";
              meaning_label: string;
              /**
               * @default date
               * @enum {string}
               */
              precision: "unknown" | "date" | "minute" | "second";
              raw: string;
              timezone: string | null;
              utc: string | null;
            };
            summary: string | null;
          }[];
        }[];
        /** @enum {string} */
        kind: "domestic" | "foreign" | "organizations";
      }[];
      id: string;
      /** Format: date-time */
      issued_at: string;
      item_count: number;
      limitation: string;
      next_cursor: string | null;
      pending_interpretations: components["schemas"]["PolicyCardInput"][];
      /** Format: date-time */
      period_end: string;
      period_key: string;
      /** Format: date-time */
      period_start: string;
      /** @enum {string} */
      status: "compiled" | "synthesizing" | "ready" | "synthesis_failed";
      summary: string | null;
      /** @constant */
      timezone: "Asia/Shanghai";
      title: string;
      /** @enum {string} */
      type: "policy_weekly" | "policy_monthly";
    };
    PolicyReportList: {
      content_version: string;
      /** Format: date-time */
      generated_at: string;
      has_more: boolean;
      items: components["schemas"]["PolicyReportCard"][];
      page: number;
      page_size: number;
      /** @enum {string} */
      status: "available" | "empty";
      total: number;
    };
    PolicyReportListInput: {
      content_version: string;
      /** Format: date-time */
      generated_at: string;
      has_more: boolean;
      items: components["schemas"]["PolicyReportCardInput"][];
      page: number;
      page_size: number;
      /** @enum {string} */
      status: "available" | "empty";
      total: number;
    };
    PolicyScopeList: {
      items: {
        jurisdiction: components["schemas"]["PolicyJurisdiction"];
        readable_count: number;
      }[];
      note: string;
    };
    PolicyScopeListInput: {
      items: {
        jurisdiction: components["schemas"]["PolicyJurisdictionInput"];
        readable_count: number;
      }[];
      note: string;
    };
    PolicyThread: {
      id: string;
      jurisdictions: components["schemas"]["PolicyJurisdiction"][];
      policies: components["schemas"]["PolicyCard"][];
      stages: {
        event_id: string | null;
        policy_id: string | null;
        relation: string;
        stage_label: string;
        time: {
          basis: string;
          beijing_date: string | null;
          condition_text: string | null;
          label: string;
          local_date: string | null;
          local_time: string | null;
          /** @enum {string} */
          meaning:
            | "published"
            | "updated"
            | "registered"
            | "public_inspection"
            | "formally_published"
            | "signed"
            | "effective"
            | "applicable"
            | "deadline"
            | "compiled"
            | "expires"
            | "event"
            | "discovered"
            | "site_public"
            | "uploaded"
            | "checked"
            | "repealed";
          meaning_label: string;
          /**
           * @default date
           * @enum {string}
           */
          precision: "unknown" | "date" | "minute" | "second";
          raw: string;
          timezone: string | null;
          utc: string | null;
        };
      }[];
      summary: string | null;
      title: string;
    };
    PolicyThreadInput: {
      id: string;
      jurisdictions: components["schemas"]["PolicyJurisdictionInput"][];
      policies: components["schemas"]["PolicyCardInput"][];
      stages: {
        event_id: string | null;
        policy_id: string | null;
        relation: string;
        stage_label: string;
        time: {
          basis: string;
          beijing_date: string | null;
          condition_text: string | null;
          label: string;
          local_date: string | null;
          local_time: string | null;
          /** @enum {string} */
          meaning:
            | "published"
            | "updated"
            | "registered"
            | "public_inspection"
            | "formally_published"
            | "signed"
            | "effective"
            | "applicable"
            | "deadline"
            | "compiled"
            | "expires"
            | "event"
            | "discovered"
            | "site_public"
            | "uploaded"
            | "checked"
            | "repealed";
          meaning_label: string;
          /**
           * @default date
           * @enum {string}
           */
          precision: "unknown" | "date" | "minute" | "second";
          raw: string;
          timezone: string | null;
          utc: string | null;
        };
      }[];
      summary: string | null;
      title: string;
    };
    PolicyVersionRef: {
      current: boolean;
      expression_ids: string[];
      id: string;
      legal_brief: {
        /** @enum {string} */
        in_force: "yes" | "partial" | "no" | "unknown";
        /** @enum {string} */
        repeal: "repealed" | "partly_repealed" | "unknown";
        /** @enum {string} */
        stage: "proposed" | "consultation" | "adopted" | "published" | "unknown";
      };
      version_label: string;
    };
    PolicyVersionRefInput: {
      current: boolean;
      expression_ids: string[];
      id: string;
      legal_brief: {
        /** @enum {string} */
        in_force: "yes" | "partial" | "no" | "unknown";
        /** @enum {string} */
        repeal: "repealed" | "partly_repealed" | "unknown";
        /** @enum {string} */
        stage: "proposed" | "consultation" | "adopted" | "published" | "unknown";
      };
      version_label: string;
    };
    PoolResponse: {
      filters: {
        category:
          | (
              | "policy_regulation"
              | "company_project"
              | "commodity_market"
              | "capital_ma"
              | "supply_trade_controls"
              | "esg_community_labor"
              | "safety_incident"
              | "technology_processing"
              | "exploration_resource"
            )
          | null;
        /** @enum {string} */
        channel: "all" | "news" | "firstParty";
        jurisdiction?: string | null;
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
        category:
          | (
              | "policy_regulation"
              | "company_project"
              | "commodity_market"
              | "capital_ma"
              | "supply_trade_controls"
              | "esg_community_labor"
              | "safety_incident"
              | "technology_processing"
              | "exploration_resource"
            )
          | null;
        /** @enum {string} */
        channel: "all" | "news" | "firstParty";
        jurisdiction?: string | null;
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
      category:
        | (
            | "policy_regulation"
            | "company_project"
            | "commodity_market"
            | "capital_ma"
            | "supply_trade_controls"
            | "esg_community_labor"
            | "safety_incident"
            | "technology_processing"
            | "exploration_resource"
          )
        | null;
      /** @enum {string} */
      channel: "all" | "news" | "firstParty";
      jurisdiction?: string | null;
      tag: string | null;
      topic?: string | null;
    };
    SiteFiltersInput: {
      category:
        | (
            | "policy_regulation"
            | "company_project"
            | "commodity_market"
            | "capital_ma"
            | "supply_trade_controls"
            | "esg_community_labor"
            | "safety_incident"
            | "technology_processing"
            | "exploration_resource"
          )
        | null;
      /** @enum {string} */
      channel: "all" | "news" | "firstParty";
      jurisdiction?: string | null;
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
  siteJurisdictions: {
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
          "application/json": components["schemas"]["PolicyJurisdictionList"];
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
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      429: {
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
  siteMetalPrices: {
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
          "application/json": components["schemas"]["MetalPrices"];
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
  sitePolicies: {
    parameters: {
      query?: {
        from?: string;
        jurisdiction?: string;
        nature?: "law" | "regulation" | "amendment" | "draft" | "notice" | "guidance" | "treaty" | "judgment" | "unknown";
        page?: number;
        page_size?: number;
        q?: string;
        stage?: "proposed" | "consultation" | "adopted" | "published" | "unknown";
        theme?: "investment_company" | "mineral_rights" | "land_construction" | "safety_environment" | "labour_community" | "tax_finance" | "trade_transport";
        to?: string;
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
          "application/json": components["schemas"]["PolicyListResponse"];
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
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      429: {
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
  sitePolicy: {
    parameters: {
      query?: {
        document_revision_id?: string;
        expression_id?: string;
        policy_version_id?: string;
      };
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
          "application/json": components["schemas"]["Policy"];
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
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      429: {
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
  sitePolicyHistory: {
    parameters: {
      query?: {
        cursor?: string;
        limit?: number;
      };
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
          "application/json": components["schemas"]["PolicyHistoryPage"];
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
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      429: {
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
  sitePolicyReading: {
    parameters: {
      query: {
        cursor?: string;
        document_revision_id: string;
        expression_id: string;
        limit?: number;
      };
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
          "application/json": components["schemas"]["PolicyReadingPage"];
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
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      429: {
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
  sitePolicyReports: {
    parameters: {
      query: {
        jurisdiction?: string;
        kind: "weekly" | "monthly";
        page?: number;
        page_size?: number;
        theme?: "investment_company" | "mineral_rights" | "land_construction" | "safety_environment" | "labour_community" | "tax_finance" | "trade_transport";
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
          "application/json": components["schemas"]["PolicyReportList"];
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
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      429: {
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
  sitePolicyReport: {
    parameters: {
      query?: {
        cursor?: string;
        edition?: number;
        jurisdiction?: string;
        limit?: number;
        theme?: "investment_company" | "mineral_rights" | "land_construction" | "safety_environment" | "labour_community" | "tax_finance" | "trade_transport";
      };
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
          "application/json": components["schemas"]["PolicyReport"];
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
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      429: {
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
  sitePolicyScope: {
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
          "application/json": components["schemas"]["PolicyScopeList"];
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
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      429: {
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
  sitePolicyThread: {
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
          "application/json": components["schemas"]["PolicyThread"];
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
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      429: {
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
  sitePool: {
    parameters: {
      query?: {
        category?:
          | "policy_regulation"
          | "company_project"
          | "commodity_market"
          | "capital_ma"
          | "supply_trade_controls"
          | "esg_community_labor"
          | "safety_incident"
          | "technology_processing"
          | "exploration_resource";
        channel?: "all" | "news" | "firstParty";
        jurisdiction?: string;
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
        category?:
          | "policy_regulation"
          | "company_project"
          | "commodity_market"
          | "capital_ma"
          | "supply_trade_controls"
          | "esg_community_labor"
          | "safety_incident"
          | "technology_processing"
          | "exploration_resource";
        channel?: "all" | "news" | "firstParty";
        cursor?: string;
        jurisdiction?: string;
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
  publicPolicies: {
    parameters: {
      query?: {
        cursor?: string;
        from?: string;
        jurisdiction?: string;
        limit?: number;
        nature?: "law" | "regulation" | "amendment" | "draft" | "notice" | "guidance" | "treaty" | "judgment" | "unknown";
        q?: string;
        stage?: "proposed" | "consultation" | "adopted" | "published" | "unknown";
        theme?: "investment_company" | "mineral_rights" | "land_construction" | "safety_environment" | "labour_community" | "tax_finance" | "trade_transport";
        to?: string;
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
          "application/json": components["schemas"]["PolicyCursorResponse"];
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
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      429: {
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
  publicPolicy: {
    parameters: {
      query?: {
        document_revision_id?: string;
        expression_id?: string;
        policy_version_id?: string;
      };
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
          "application/json": components["schemas"]["Policy"];
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
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      429: {
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
  publicPolicyHistory: {
    parameters: {
      query?: {
        cursor?: string;
        limit?: number;
      };
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
          "application/json": components["schemas"]["PolicyHistoryPage"];
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
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["Problem"];
        };
      };
      /** @description Problem response */
      429: {
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
