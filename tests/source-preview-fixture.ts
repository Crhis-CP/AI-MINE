// Only loopback/self-authored intake tests: preserve the real worker preview and host pacing.
import {setTimeout as delay} from "node:timers/promises";
import {requestSourcePreview,runSourcePreview,previewSource} from "@amp/backend/admin/sources";
export async function previewSourceFixture(sourceId:string) {
  const preview=await requestSourcePreview(sourceId,{},"synthetic-test",{inline:true});
  for(let attempt=0;attempt<5;attempt++) {
    let retryAt:string|undefined;
    try {
      await runSourcePreview(String(preview.preview_id),async source=>{
        const result=await previewSource(source);
        if("status" in result && result.status==="deferred")retryAt=result.retryAt;
        return result;
      });
      // Default fixture crawl spacing also applies between preview and its first scheduled fetch.
      await delay(2050);
      return;
    } catch(error) {
      if(!retryAt || attempt===4)throw error;
      await delay(Math.max(1,new Date(retryAt).getTime()-Date.now()+20));
    }
  }
}
