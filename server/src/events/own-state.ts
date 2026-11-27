/** The names of the agent's own state: the event journal and the stores it keeps in the index folder (or, without one, in the temporary folder). A write there must not become an event. */
export const ownState = (node: string) => (name: string) =>
  name === `changes-${node}` || name.startsWith(`index-${node}.db`) || name.startsWith(`sizes-${node}.db`) || name.startsWith(`jobs-${node}.db`) || /^filedeck-(?:changes|index|sizes|jobs)-/.test(name);
