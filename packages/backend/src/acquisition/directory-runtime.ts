import { requireRuntimeRunning, RuntimeControlPaused, RuntimeControlStale } from "../operations/lane-controls.ts";
import type { SourceRow } from "../sources/types.ts";
import { directoryContract } from "../sources/directory-profile.ts";
import { readDirectoryPage, DirectoryStructureError, type DirectoryPage } from "../sources/directory-page.ts";
import { beginDirectoryScan, appendDirectoryPage, applyDirectoryScan, failDirectoryScan } from "./directory-store.ts";
import { CrawlDeferred } from "./crawl.ts";
export class DirectoryRoundFailed extends Error {}
/** Bounded turns persist each page; transport waits leave the scan and its immutable pages intact. */
export async function collectPolicyDirectory(source: SourceRow, permissionVersion: number) {
  const guardedSource = { ...source, collectionControl: source.collectionControl ?? (await requireRuntimeRunning("policy", ["collection"])) };
  const contract = directoryContract(source);
  if (!contract) throw new DirectoryRoundFailed("目录结构配置缺失：尚不能确认完整覆盖");
  let scan = await beginDirectoryScan(source.id, contract.hash, permissionVersion, contract.profile);
  let page: DirectoryPage | undefined;
  try {
    for (let n = 0; n < contract.profile.maxPagesPerTurn; n++) {
      if (scan.total_pages !== null && scan.next_page === contract.profile.request.firstPage + scan.total_pages) break;
      page = await readDirectoryPage(source, contract.profile, scan.next_page, `directory:${scan.id}:data:${scan.next_page}`);
      scan = await appendDirectoryPage(scan, page, guardedSource);
      page = undefined;
    }
    if (scan.total_pages === null || scan.next_page < contract.profile.request.firstPage + scan.total_pages)
      throw new CrawlDeferred(new Date(Date.now() + 1000), `directory:${scan.id}:${scan.next_page}`, "directory_continuation");
    page = await readDirectoryPage(source, contract.profile, contract.profile.request.firstPage, `directory:${scan.id}:probe`);
    return await applyDirectoryScan(scan, page, guardedSource);
  } catch (error) {
    if (error instanceof CrawlDeferred || error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale) throw error;
    const reason = String(error instanceof Error ? error.message : error).slice(0, 1000);
    const evidence =
      error instanceof DirectoryStructureError
        ? error.evidence
        : page
          ? { url: page.url, fetchedAt: page.fetchedAt, bodyHash: page.bodyHash, body: page.body, httpStatus: 200 }
          : undefined;
    await failDirectoryScan(
      scan,
      reason,
      scan.total_pages !== null && scan.next_page === contract.profile.request.firstPage + scan.total_pages
        ? contract.profile.request.firstPage
        : scan.next_page,
      String(source.config.url),
      source,
      evidence,
    );
    throw new DirectoryRoundFailed(reason);
  }
}
