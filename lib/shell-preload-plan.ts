/** Never replace an existing app or resurrect an app already offered by this shell. */
export function planShellPreload<T extends { id: string }>(incoming: T[], existing: T[], seen: string[]) {
  const existingIds = new Set(existing.map(app => app.id));
  const seenIds = new Set(seen);
  const additions = incoming.filter(app => !existingIds.has(app.id) && !seenIds.has(app.id));
  return { apps: [...existing, ...additions], seen: [...new Set([...seen, ...incoming.map(app => app.id)])] };
}
