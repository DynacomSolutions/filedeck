/** Branding written into index.html by the hub (see server/src/brand.ts); these defaults apply in `vite dev`. */
export interface Brand {
  name: string;
  title: string;
  icon: string;
  themeKey: string;
}
const DEFAULT: Brand = { name: "Filedeck", title: "Filedeck", icon: "/favicon.svg", themeKey: "filedeck-theme" };
export const brand: Brand = { ...DEFAULT, ...((window as unknown as { __FILEDECK__?: Partial<Brand> }).__FILEDECK__ ?? {}) };
