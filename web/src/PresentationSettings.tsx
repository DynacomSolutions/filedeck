import { cssColourToHex, DEFAULT_PRESENTATION, minimumParagraphSpace, setPresentation, usePresentation, type ReadingFont } from "./presentation";
import "./presentation.css";

const FONTS: { value: ReadingFont; label: string }[] = [
  { value: "system", label: "System sans serif" },
  { value: "serif", label: "Serif" },
  { value: "mono", label: "Monospaced" },
];

export function PresentationSettings() {
  const s = usePresentation();
  const themeText = typeof document === "undefined" ? "#ffffff" : cssColourToHex(getComputedStyle(document.documentElement).getPropertyValue("--fg"), "#ffffff");
  const themePage = typeof document === "undefined" ? "#151518" : cssColourToHex(getComputedStyle(document.documentElement).getPropertyValue("--bg"), "#151518");
  return (
    <section className="set-sec presentation-sec" aria-labelledby="set-presentation">
      <h2 id="set-presentation">Reading presentation</h2>
      <p className="muted">Adjust the text and page colours, font, size, spacing and line width. Changes are saved in this browser and apply across Filedeck.</p>
      <div className="presentation-grid">
        <div className="presentation-field"><label htmlFor="presentation-foreground">Text colour</label><input id="presentation-foreground" aria-label="Text colour" type="color" value={s.foreground || themeText} onChange={(e) => setPresentation({ foreground: e.target.value })} />
          <button type="button" onClick={() => setPresentation({ foreground: "" })}>Use theme text colour</button>
        </div>
        <div className="presentation-field"><label htmlFor="presentation-background">Page colour</label><input id="presentation-background" aria-label="Page colour" type="color" value={s.background || themePage} onChange={(e) => setPresentation({ background: e.target.value })} />
          <button type="button" onClick={() => setPresentation({ background: "" })}>Use theme page colour</button>
        </div>
        <label className="presentation-field" htmlFor="presentation-font">Font<select id="presentation-font" aria-label="Reading font" value={s.font} onChange={(e) => setPresentation({ font: e.target.value as ReadingFont })}>{FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select></label>
        <div className="presentation-field"><label htmlFor="presentation-size">Text size</label><output htmlFor="presentation-size">{s.fontSize}px</output><input id="presentation-size" aria-label="Text size" type="range" min="14" max="32" step="1" value={s.fontSize} onChange={(e) => setPresentation({ fontSize: Number(e.target.value) })} /></div>
        <div className="presentation-field"><label htmlFor="presentation-line-height">Line spacing</label><output htmlFor="presentation-line-height">{s.lineHeight.toFixed(1)}×</output><input id="presentation-line-height" aria-label="Line spacing" type="range" min="1.5" max="2" step="0.1" value={s.lineHeight} onChange={(e) => setPresentation({ lineHeight: Number(e.target.value) })} /></div>
        <div className="presentation-field"><label htmlFor="presentation-paragraph-space">Paragraph spacing</label><output htmlFor="presentation-paragraph-space">{s.paragraphSpace.toFixed(1)}em</output><input id="presentation-paragraph-space" aria-label="Paragraph spacing" type="range" min={minimumParagraphSpace(s.lineHeight)} max="3" step="0.1" value={s.paragraphSpace} onChange={(e) => setPresentation({ paragraphSpace: Number(e.target.value) })} /></div>
        <div className="presentation-field"><label htmlFor="presentation-line-measure">Line width</label><output htmlFor="presentation-line-measure">{s.lineMeasure} characters</output><input id="presentation-line-measure" aria-label="Line width" type="range" min="45" max="100" step="5" value={s.lineMeasure} onChange={(e) => setPresentation({ lineMeasure: Number(e.target.value) })} /></div>
      </div>
      <button type="button" className="presentation-reset" onClick={() => setPresentation(DEFAULT_PRESENTATION)}>Reset reading presentation</button>
    </section>
  );
}
