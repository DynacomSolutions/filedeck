/** Plain-language explanations for technical terms exposed by Filedeck's UI. */
export const TECHNICAL_TERMS = [
  {
    term: "Node",
    description: "A connected file server. A panel shows folders and files from one node at a time.",
  },
  {
    term: "Panel",
    description: "One file-list area. Two panels make it easier to compare or copy between locations.",
  },
  {
    term: "Compare",
    description: "Checks two folders and shows which items are only on one side, changed, or the same.",
  },
  {
    term: "Quick compare",
    description: "A comparison that checks size and modified time first, then uses a file hash when needed.",
  },
  {
    term: "Hash (SHA-256)",
    description: "A fingerprint calculated from file contents. Matching fingerprints provide strong evidence that two files are identical.",
  },
  {
    term: "Job",
    description: "Background work such as copying, moving, deleting, uploading, or comparing files. It can continue while you use the app.",
  },
  {
    term: "Vault",
    description: "The hub's protected store for saved passwords used to open password-protected files. Entries can expire automatically.",
  },
  {
    term: "TTL",
    description: "Time to live: how long a saved password remains available before it expires.",
  },
  {
    term: "Glob",
    description: "A simple filename pattern. For example, *.pdf matches filenames ending in .pdf.",
  },
  {
    term: "Regular expression",
    description: "A pattern language for more precise text searches. It is often shortened to regex.",
  },
] as const;

/**
 * A native disclosure keeps the glossary out of the normal shortcut list until requested,
 * while still exposing every term to keyboard and assistive-technology users.
 */
export function TechnicalGlossary() {
  return (
    <details className="technical-glossary">
      <summary>Technical terms explained</summary>
      <dl>
        {TECHNICAL_TERMS.map(({ term, description }) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{description}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
