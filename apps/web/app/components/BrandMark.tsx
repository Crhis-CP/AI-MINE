import type { ModuleBrand } from "@amp/contracts/modules";
import { WEB_MODULES } from "@amp/site/modules/web";

const darkMarks = new Set(WEB_MODULES.flatMap((module) => module.darkMarks ?? []));

export function BrandMark({ brand, size = 28 }: { brand: ModuleBrand; size?: number }) {
  const dark = brand.src !== null && darkMarks.has(brand.src);
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden border ${brand.src ? (dark ? "border-transparent bg-[#111]" : `border-line bg-white ${brand.raster ? "" : "dark:bg-white/95"}`) : "border-line bg-accent-soft text-accent"}`}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.27), fontSize: Math.round(size * 0.4) }}
    >
      {brand.src ? (
        <img
          src={brand.src}
          alt=""
          loading="lazy"
          decoding="async"
          className="object-contain"
          style={{ width: dark ? "66%" : "64%", height: dark ? "66%" : "64%" }}
        />
      ) : (
        brand.monogram
      )}
    </span>
  );
}
