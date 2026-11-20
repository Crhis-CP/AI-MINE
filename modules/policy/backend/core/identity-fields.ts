/**
 * Reads the identity fields a source's policyProfile names on one official single-document page. Pure: no
 * network, no database. Shared by acquisition (capture.ts) and the per-source dry-run discovery command, so a
 * dry run on the server exercises exactly the selectors and patterns the archive stage will use.
 */
import * as cheerio from "cheerio";
import { sha256, stableJson } from "@amp/backend/lib/ids";
import type { PolicyAutomationProfile } from "./automation-profile.ts";

/** `raw` is the value the pipeline uses; `text` keeps the element's full text when a pattern selected part of it. */
export type IdentityField = { selector: string; raw: string; text?: string; pattern?: string };
export type PolicyIdentityFields = {
  title: IdentityField;
  marker: IdentityField & { pattern: string };
  number: IdentityField | null;
  version: IdentityField | null;
  /** Hash of the identity fields, the body selector's text and its links: equal pages need no new revision. */
  fingerprint: string | null;
};
export class PolicyIdentityMismatch extends Error {}

const collapse = (value: string) => value.replace(/\s+/gu, " ").trim();

export function loadPolicyDocument(decoded: string, mediaType: string | null) {
  const xml = /xml/i.test(mediaType ?? "") && !/html/i.test(mediaType ?? "");
  if (xml && /<!DOCTYPE|<!ENTITY|\0/i.test(decoded)) throw new PolicyIdentityMismatch("Unsafe XML envelope");
  return xml ? cheerio.load(decoded, { xml: true }) : cheerio.load(decoded);
}

/**
 * Throws PolicyIdentityMismatch when a field is missing, ambiguous, empty or does not match its pattern; callers
 * treat that as "not this source's kind of document" rather than a transport failure.
 */
export function readPolicyIdentityFields($: cheerio.CheerioAPI, profile: PolicyAutomationProfile): PolicyIdentityFields {
  const patterns = profile.fieldPatterns ?? {};
  const field = (selector: string, pattern?: string): IdentityField => {
    const nodes = $(selector);
    if (nodes.length !== 1) throw new PolicyIdentityMismatch(`Policy identity field is missing or ambiguous: ${selector}`);
    const text = (nodes.attr("content") ?? nodes.text()).trim();
    if (!text) throw new PolicyIdentityMismatch(`Policy identity field is empty: ${selector}`);
    if (!pattern) return { selector, raw: text };
    const value = collapse(new RegExp(pattern, "u").exec(text)?.[1] ?? "");
    if (!value) throw new PolicyIdentityMismatch(`Policy identity field does not match its pattern: ${selector}`);
    return { selector, raw: value, text, pattern };
  };
  const title = field(profile.titleSelector, patterns.title);
  const marker = field(profile.identityMarker.selector);
  if (!new RegExp(profile.identityMarker.pattern, "u").test(marker.raw)) throw new PolicyIdentityMismatch("Policy identity marker does not match");
  // A present but blank number cell (some notices carry no 文号) falls back to source + official URL identity.
  const numberNodes = profile.numberSelector ? $(profile.numberSelector) : null;
  const number =
    profile.numberSelector && !(numberNodes?.length === 1 && !(numberNodes.attr("content") ?? numberNodes.text()).trim())
      ? field(profile.numberSelector, patterns.number)
      : null;
  const version = profile.versionSelector ? field(profile.versionSelector, patterns.version) : null;
  let fingerprint: string | null = null;
  const bodySelector = profile.extraction.bodySelector;
  if (bodySelector) {
    const body = $(bodySelector);
    if (body.length === 1) {
      const links = body
        .find("a[href], [src]")
        .toArray()
        .map((node) => $(node).attr("href") ?? $(node).attr("src") ?? "");
      const attachments = profile.extraction.attachmentSelector
        ? $(profile.extraction.attachmentSelector)
            .toArray()
            .map((node) => $(node).attr("href") ?? $(node).attr("src") ?? "")
        : [];
      fingerprint = sha256(
        stableJson({
          recipe: "policy-fingerprint-1",
          title: title.raw,
          marker: marker.raw,
          number: number?.raw ?? null,
          version: version?.raw ?? null,
          body: collapse(body.text()),
          links,
          attachments,
        }),
      );
    }
  }
  return { title, marker: { ...marker, pattern: profile.identityMarker.pattern }, number, version, fingerprint };
}
