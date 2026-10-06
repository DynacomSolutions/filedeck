import { setPresentation, usePresentation, type ReadingFont } from "./presentation";
import "./presentation.css";

const FONTS: { value: ReadingFont; label: string }[] = [
  { value: "system", label: "System sans serif" },
  { value: "serif", label: "Serif" },
  { value: "mono", label: "Monospaced" },
];

export function PresentationSettings() {
  const s = usePresentation();
  const themeText = typeof document === "undefined" ? "#ffffff" : getComputedStyle(document.documentElement).getPropertyValue("--fg").trim() || "#ffffff";
  const themePage = typeof document === "undefined" ? "#151518" : getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#151518";
  return (
    <section className="set-sec presentation-sec" aria-labelledby="set-presentation">
      <h2 id="set-presentation">Reading presentation</h2>
      <p className="muted">Adjust the text and page colours, font, size, spacing and line width. Changes are saved in this browser and apply across Filedeck.</p>
      <div className="presentation-grid">
        <label>Text colour<input aria-label="Text colour" type="color" value={s.foreground || themeText} onChange={(e) => setPresentation({ foreground: e.target.value })} />
          <button type="button" onClick={() => setPresentation({ foreground: "" })}>Use theme text colour</button>
        </label>
        <label>Page colour<input aria-label="Page colour" type="color" value={s.background || themePage} onChange={(e) => setPresentation({ background: e.target.value })} />
          <button type="button" onClick={() => setPresentation({ background: "" })}>Use theme page colour</button>
        </label>
        <label>Font<select aria-label="Reading font" value={s.font} onChange={(e) => setPresentation({ font: e.target.value as ReadingFont })}>{FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select></label>
        <label>Text size <output htmlFor="presentation-size">{s.fontSize}px</output><input id="presentation-size" aria-label="Text size" type="range" min="14" max="32" step="1" value={s.fontSize} onChange={(e) => setPresentation({ fontSize: Number(e.target.value) })} /></label>
        <label>Line spacing <output htmlFor="presentation-line-height">{s.lineHeight.toFixed(1)}×</output><input id="presentation-line-height" aria-label="Line spacing" type="range" min="1.5" max="2" step="0.1" value={s.lineHeight} onChange={(e) => setPresentation({ lineHeight: Number(e.target.value) })} /></label>
        <label>Paragraph spacing <output htmlFor="presentation-paragraph-space">{s.paragraphSpace.toFixed(2)}× text size</output><input id="presentation-paragraph-space" aria-label="Paragraph spacing" type="range" min="1" max="2" step="0.25" value={s.paragraphSpace} onChange={(e) => setPresentation({ paragraphSpace: Number(e.target.value) })} /></label>
        <label>Line width <output htmlFor="presentation-line-measure">{s.lineMeasure} characters</output><input id="presentation-line-measure" aria-label="Line width" type="range" min="45" max="100" step="5" value={s.lineMeasure} onChange={(e) => setPresentation({ lineMeasure: Number(e.target.value) })} /></label>
      </div>
      <button type="button" className="presentation-reset" onClick={() => setPresentation({ foreground: "", background: "", font: "system", fontSize: 16, lineHeight: 1.6, paragraphSpace: 1, lineMeasure: 80 })}>Reset reading presentation</button>
    </section>
  );
}
