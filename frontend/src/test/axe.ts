// Accessibility check for component tests (accessibility skill): runs axe-core on a rendered container and lists the
// violations in readable form, so `expect(await axeViolations(container)).toEqual([])` fails with what to fix.
import axe from 'axe-core';

/** Rules jsdom cannot judge: it computes no layout or colours. */
const JSDOM_BLIND = { 'color-contrast': { enabled: false }, region: { enabled: false } };

export async function axeViolations(container: Element): Promise<string[]> {
  const { violations } = await axe.run(container, { rules: JSDOM_BLIND, resultTypes: ['violations'] });
  return violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${v.help} — ${n.target.join(' ')}`));
}
