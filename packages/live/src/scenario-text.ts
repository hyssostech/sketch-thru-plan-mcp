/**
 * Finds one object in GetScenarioContent's `object_set([...])` text by its poid, for engines that
 * refuse GetPoidObject (STP-1475). The engine writes one object per line, each starting
 * `[fsTYPE: <type>,poid: <poid>,`; only that top-level poid is matched, so a poid merely mentioned
 * inside another object (a task's tgs, a glyphPoid) is not taken for the object itself.
 */

export interface ScenarioTextEntry {
  fsTYPE: string;
  /** fsdb_version; `v0` marks a tombstone (a deleted object kept in the scenario). */
  version?: string;
  /** complete_language, or a COA's / scenario's name. */
  description?: string;
}

const unquote = (s: string) => s.replace(/\\'/g, "'");

export function findInObjectSet(text: string, poid: string): ScenarioTextEntry | null {
  const escaped = poid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`^\\[fsTYPE: ([A-Za-z_]+),poid: ${escaped}[,\\]]`);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = head.exec(line);
    if (!m) continue;
    const version = /fsdb_version: ([A-Za-z0-9]+)/.exec(line)?.[1];
    const description =
      /complete_language: '((?:[^'\\]|\\.)*)'/.exec(line)?.[1] ?? /[,[]name: '((?:[^'\\]|\\.)*)'/.exec(line)?.[1];
    return {
      fsTYPE: m[1],
      ...(version ? { version } : {}),
      ...(description !== undefined ? { description: unquote(description) } : {}),
    };
  }
  return null;
}
