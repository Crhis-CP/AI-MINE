import { requireRuntimeRunning, type RuntimeControlSnapshot } from "../operations/lane-controls.ts";
import * as cheerio from "cheerio";
import { evaluateSourcePolicy } from "@amp/backend/admin/sources";
import { guardedFetch, type GuardedFetchOptions, type GuardedResponse } from "../lib/http-fetch.ts";
import { recordPolicyOriginal } from "./originals.ts";
import type { PolicyOriginalInput } from "./types.ts";
import { decodeOriginal, validateProfile, type ExtractionProfile } from "./extraction.ts";

type Input = Omit<PolicyOriginalInput, "resources" | "catalogueClosed">;
type Get = (url: string, options: GuardedFetchOptions) => Promise<GuardedResponse>;
export async function acquirePolicyOriginal(
  inputValue: Input,
  profileValue: ExtractionProfile,
  get: Get = guardedFetch,
  collectionControl?: RuntimeControlSnapshot,
) {
  const runtime = collectionControl ?? (await requireRuntimeRunning("policy", ["collection"]));
  const input = structuredClone(inputValue),
    profile = { ...profileValue };
  validateProfile(profile);
  const resources: PolicyOriginalInput["resources"] = [];
  const fetch = async (url: string, attachment: boolean) => {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password) throw new Error("Policy original requires an uncredentialed HTTPS URL");
    for (const capability of ["fetch", "store_metadata", "store_fulltext", "process_locally"] as const) {
      const permission = await evaluateSourcePolicy({
        source_id: input.sourceId,
        expected_permission_version: input.permissionVersion,
        lane: "policy",
        capability,
        resource: { url, document_type: input.identity.documentType, attachment },
      });
      if (permission.decision !== "allow") throw new Error(`Policy acquisition permission denied: ${capability}`);
    }
    const resource: PolicyOriginalInput["resources"][number] = {
      url,
      attachment,
      required: true,
      mediaType: null,
      state: "failed",
      body: null,
      reason: "原件取得失败",
    };
    try {
      const response = await get(url, { maxBytes: profile.maxBytes, maxRedirects: 0, timeoutMs: 20_000 });
      if (response.url !== url || response.status !== 200 || !response.body.length) resource.reason = "原件为空、地址跳转或 HTTP 状态异常";
      else if (response.body.byteLength > profile.maxBytes) {
        resource.state = "blocked_capacity";
        resource.reason = "原件容量超限";
      } else {
        resource.body = Uint8Array.from(response.body);
        resource.mediaType = response.headers.get("content-type");
        resource.state = "acquired";
        resource.reason = null;
      }
    } catch (error) {
      if (error instanceof Error && /Response too large/.test(error.message)) {
        resource.state = "blocked_capacity";
        resource.reason = "原件容量超限";
      }
    }
    resources.push(resource);
    return resource;
  };
  const original = await fetch(input.identity.officialUrl, false);
  let catalogueClosed = false;
  if (original.body && /html/i.test(original.mediaType ?? "") && profile.attachmentSelector) {
    try {
      const $ = cheerio.load(decodeOriginal(original.body, original.mediaType));
      const referenceLabels = (text: string) => {
        const labels = new Set<string>();
        for (const match of text.matchAll(new RegExp(profile.attachmentReferencePattern!, "giu"))) {
          if (!match[1]?.trim() || labels.size >= profile.maxResources) throw new Error("Attachment references are not bounded labels");
          labels.add(match[1].trim().toLocaleLowerCase());
        }
        return labels;
      };
      let referencesResolved = true;
      if (profile.attachmentReferencePattern) {
        const body = $(profile.bodySelector!);
        if (body.length !== 1) throw new Error("Attachment reference body missing or ambiguous");
        const referenced = referenceLabels(body.text()),
          linked = referenceLabels(
            $(profile.attachmentSelector)
              .map((_, el) => $(el).text())
              .get()
              .join("\n"),
          );
        referencesResolved = [...referenced].every((label) => linked.has(label));
      }
      const urls = [
        ...new Set(
          $(profile.attachmentSelector)
            .toArray()
            .map((el) => {
              const link = $(el).attr("href") ?? $(el).attr("src");
              if (!link) throw new Error("Attachment URL missing");
              return new URL(link, original.url).toString();
            }),
        ),
      ];
      if (urls.length + 1 > profile.maxResources) {
        original.state = "blocked_capacity";
        original.body = null;
        original.reason = "附件目录容量超限";
      } else {
        // Resolve the complete catalogue before issuing any attachment request.
        for (const url of urls.filter((url) => url !== original.url)) await fetch(url, true);
        catalogueClosed = referencesResolved;
      }
    } catch (error) {
      if (error instanceof Error && /permission denied|requires an uncredentialed/.test(error.message)) throw error;
    }
  }
  // A direct PDF may embed attachments; their catalogue is not established by merely downloading the PDF.
  return recordPolicyOriginal({ ...input, catalogueClosed, resources }, runtime);
}
