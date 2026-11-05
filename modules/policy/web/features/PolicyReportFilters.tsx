import { Form } from "react-router";
import { useTr } from "@amp/web/i18n";
import { themes, fieldClass, actionClass } from "./PolicyUI";
export function PolicyReportFilters({
  query,
  jurisdictions,
}: {
  jurisdictions: { code: string; label: string }[];
  query: { kind?: string; jurisdiction?: string; theme?: string; edition?: number };
}) {
  const tr = useTr();
  return (
    <Form method="get" className="mt-5 flex flex-wrap items-end gap-3" aria-label={tr("法规汇总筛选")}>
      {query.kind && <input type="hidden" name="kind" value={query.kind} />}
      {query.edition && <input type="hidden" name="edition" value={query.edition} />}
      <label className="min-w-40 flex-1 text-[13px]">
        {tr("国家与组织")}
        <select aria-label={tr("国家与组织")} name="jurisdiction" defaultValue={query.jurisdiction ?? ""} className={fieldClass}>
          <option value="">{tr("全部国家与组织")}</option>
          {jurisdictions.map((j) => (
            <option key={j.code} value={j.code}>
              {j.label}
            </option>
          ))}
        </select>
      </label>
      <label className="min-w-40 flex-1 text-[13px]">
        {tr("经营主题")}
        <select aria-label={tr("经营主题")} name="theme" defaultValue={query.theme ?? ""} className={fieldClass}>
          <option value="">{tr("全部经营主题")}</option>
          {Object.entries(themes).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className={actionClass}>
        {tr("筛选")}
      </button>
    </Form>
  );
}
